/**
 * @fileoverview Coalesces register writes by address and flushes them after a debounce window.
 * New arrivals restart the window; `maxHold` limits the total delay.
 *
 * @module
 */

import { Clock, Deferred, Duration, Effect, Fiber, type Scope, Semaphore } from 'effect';

import { ModbusInvalidArgumentError, ModbusNotConnectedError, type ModbusError } from './errors';
import { encodeRegisterValue, type RegisterWrite } from './register-plan';
import type { ModbusSpanAttributes } from './span-attributes';

/** One write in a flushed batch, with the attributes of the caller that issued it. */
export interface DebouncedWrite {
  /** Register address. */
  readonly address: number;
  /** Value to write, as the caller gave it. */
  readonly value: number;
  /** Attributes of the caller that issued the newest value for this address. */
  readonly attributes: ModbusSpanAttributes | undefined;
}

/** Options for {@link createWriteDebouncer}. */
export interface WriteDebouncerOptions {
  /**
   * How long a write is held before it reaches the wire. Each new arrival
   * restarts this window.
   *
   * A window of zero disables the debouncer: every write is flushed on its own,
   * with no timer and no batch. That is the escape hatch for a harness that
   * settles by yielding rather than by advancing a clock, which would otherwise
   * never reach a flush that runs on a forked fiber.
   */
  readonly window: Duration.Input;
  /**
   * Longest total hold, measured from the arrival that opened the batch.
   *
   * Without a ceiling, a register that updates faster than the window never
   * reaches the wire at all, because every arrival restarts the wait.
   *
   * @defaultValue four times `window`
   */
  readonly maxHold?: Duration.Input;
  /**
   * Issues one batch.
   *
   * The batch holds at most one entry per address, newest value. The callback
   * owns everything below it: the cache filter, the planning, and the span.
   */
  flush(batch: ReadonlyArray<DebouncedWrite>): Effect.Effect<void, ModbusError>;
}

/** A collection point for writes that arrive separately. */
export interface WriteDebouncer {
  /**
   * Holds a write for the window, then issues it with whatever else arrived.
   *
   * Completes with the flush result for its address. A later write can supersede
   * its value, and a downstream cache can suppress the physical write.
   */
  write(write: RegisterWrite, attributes?: ModbusSpanAttributes): Effect.Effect<void, ModbusError>;

  /**
   * Adds a write to the batch and flushes immediately, rather than waiting.
   *
   * This is an enqueue and then a flush, not a path around the batch. A write
   * already pending for the same address is superseded, so the newest value is
   * the one that reaches the device. A path that went around the batch would let
   * an older held value be written after a newer immediate one.
   */
  writeNow(
    write: RegisterWrite,
    attributes?: ModbusSpanAttributes,
  ): Effect.Effect<void, ModbusError>;

  /**
   * Holds several writes for the window, as one caller.
   *
   * A caller that already holds every value does not need a collection point,
   * but it still must not go around the batch: a write held for one of these
   * addresses would otherwise reach the device after the newer value. The result
   * covers the flush, but separate bus transactions are not atomic.
   *
   * With a window of zero the group is issued at once, so a caller of this
   * method gets packed transactions with no debouncer at all.
   */
  writeAll(
    writes: ReadonlyArray<RegisterWrite>,
    attributes?: ModbusSpanAttributes,
  ): Effect.Effect<void, ModbusError>;

  /** Adds several writes to the batch and flushes immediately. */
  writeAllNow(
    writes: ReadonlyArray<RegisterWrite>,
    attributes?: ModbusSpanAttributes,
  ): Effect.Effect<void, ModbusError>;

  /**
   * Issues whatever is pending, now.
   *
   * Never fails: the outcome goes to the callers waiting on the batch, not to
   * whoever asked for the flush.
   */
  readonly flush: Effect.Effect<void>;

  /** Addresses currently held. Intended for tests. */
  readonly pending: number;
}

/** One address held in the batch, with every caller waiting on it. */
interface HeldWrite {
  readonly write: RegisterWrite;
  readonly attributes: ModbusSpanAttributes | undefined;
  readonly waiters: ReadonlyArray<Deferred.Deferred<void, ModbusError>>;
}

/** Identity of one scheduled window, used to reject a stale timer callback. */
interface TimerState {
  readonly id: number;
  fiber?: Fiber.Fiber<void, never>;
}

/**
 * Resolves the window and the hold limit that a write debouncer applies.
 *
 * The batching client reports these values, so both use this one rule.
 *
 * @param window - The write window.
 * @param maxHold - The hold limit. When omitted, it is four times the window.
 * @returns The window and the hold limit in milliseconds.
 */
export const resolveWriteHold = (window: Duration.Input, maxHold: Duration.Input | undefined) => {
  const windowMs = Duration.toMillis(Duration.fromInputUnsafe(window));
  const maxHoldMs =
    maxHold === undefined ? windowMs * 4 : Duration.toMillis(Duration.fromInputUnsafe(maxHold));
  return { windowMs, maxHoldMs };
};

/**
 * Creates a write debouncer bound to the current scope.
 *
 * Waiting callers do not control the flush fiber. Closing the scope discards
 * pending writes and interrupts their waiters.
 *
 * @param options - The collection window, hold limit, and flush callback.
 * @returns The debouncer, which requires the current scope.
 */
export const createWriteDebouncer = (
  options: WriteDebouncerOptions,
): Effect.Effect<WriteDebouncer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { windowMs, maxHoldMs } = resolveWriteHold(options.window, options.maxHold);

    const scope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    const flushLock = yield* Semaphore.make(1);
    const held = new Map<number, HeldWrite>();
    let timer: TimerState | undefined;
    let nextTimerId = 0;
    let openedAtMs: number | undefined;
    let closed = false;

    const scopeClosedError = () => {
      const message = 'The write debouncer scope has been closed';
      return new ModbusNotConnectedError({ cause: new Error(message), message });
    };

    const ensureOpen = Effect.suspend(() =>
      closed ? Effect.fail(scopeClosedError()) : Effect.void,
    );

    const validateWrites = (writes: ReadonlyArray<RegisterWrite>) =>
      Effect.try({
        try: () => {
          for (const write of writes) {
            if (!Number.isInteger(write.address) || write.address < 0 || write.address > 0xffff) {
              throw new RangeError(
                `address must be an integer from 0 to 65535, got ${write.address}`,
              );
            }
            encodeRegisterValue(write.value);
          }
        },
        catch: (cause) => {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          return new ModbusInvalidArgumentError({ cause: error, message: error.message });
        },
      });

    /**
     * Takes the batch under the lock, then issues it without the lock.
     *
     * A flush holds the bus for the length of a transaction. Blocking arrivals
     * for that long would defeat the coalescing the debouncer exists to do.
     */
    const flushPending = (expectedTimer?: TimerState): Effect.Effect<void> =>
      flushLock.withPermits(1)(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const taken = yield* lock.withPermits(1)(
              Effect.sync(() => {
                if (expectedTimer !== undefined && timer?.id !== expectedTimer.id) return undefined;

                const activeTimer = timer;
                timer = undefined;
                const batch = Array.from(held.values());
                held.clear();
                openedAtMs = undefined;
                return { activeTimer, batch };
              }),
            );

            if (taken === undefined) return;
            if (expectedTimer === undefined) taken.activeTimer?.fiber?.interruptUnsafe();
            if (taken.batch.length === 0) return;

            const exit = yield* Effect.exit(
              restore(
                options.flush(
                  taken.batch.map((entry) => ({
                    address: entry.write.address,
                    value: entry.write.value,
                    attributes: entry.attributes,
                  })),
                ),
              ),
            );

            yield* Effect.forEach(
              taken.batch.flatMap((entry) => entry.waiters),
              (waiter) => Deferred.done(waiter, exit),
              { discard: true },
            );
          }),
        ),
      );

    /**
     * Adds writes to the batch, returning the one `Deferred` for this caller.
     *
     * The whole group is added under one hold of the lock, so a flush takes all
     * of it or none of it. One `Deferred` therefore answers for the group.
     */
    const enqueue = (
      writes: ReadonlyArray<RegisterWrite>,
      attributes: ModbusSpanAttributes | undefined,
      restartTimer: boolean,
    ) =>
      Effect.gen(function* () {
        const waiter = yield* Deferred.make<void, ModbusError>();

        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (closed) return yield* scopeClosedError();
            for (const write of writes) {
              const superseded = held.get(write.address);

              // A later write to the same address replaces the value but
              // inherits its waiters: only the newest value reaches the wire,
              // and everyone waiting on that address learns whether it got
              // there.
              held.set(write.address, {
                write,
                attributes,
                waiters: [...(superseded?.waiters ?? []), waiter],
              });
            }

            const now = yield* Clock.currentTimeMillis;
            openedAtMs ??= now;
            if (!restartTimer) return;

            const delayMs = Math.max(0, Math.min(windowMs, openedAtMs + maxHoldMs - now));

            const previous = timer;
            const state: TimerState = { id: nextTimerId++ };
            timer = state;
            const forked = yield* Effect.forkIn(
              Effect.sleep(Duration.millis(delayMs)).pipe(Effect.andThen(flushPending(state))),
              scope,
            );
            state.fiber = forked;
            if (timer?.id !== state.id) forked.interruptUnsafe();
            // Do not await interruption while holding `lock`: an expired timer
            // may be waiting to inspect the same state before it can return.
            previous?.fiber?.interruptUnsafe();
          }),
        );

        return waiter;
      });

    /** Issues a group at once, for a window of zero. */
    const issueDirectly = (
      writes: ReadonlyArray<RegisterWrite>,
      attributes: ModbusSpanAttributes | undefined,
    ) =>
      flushLock.withPermits(1)(
        options.flush(
          writes.map((write) => ({ address: write.address, value: write.value, attributes })),
        ),
      );

    const writeAll = (
      writes: ReadonlyArray<RegisterWrite>,
      attributes?: ModbusSpanAttributes,
    ): Effect.Effect<void, ModbusError> => {
      if (writes.length === 0) return Effect.void;
      return Effect.andThen(
        ensureOpen,
        Effect.andThen(
          validateWrites(writes),
          windowMs <= 0
            ? issueDirectly(writes, attributes)
            : Effect.flatMap(enqueue(writes, attributes, true), Deferred.await),
        ),
      );
    };

    const writeAllNow = (
      writes: ReadonlyArray<RegisterWrite>,
      attributes?: ModbusSpanAttributes,
    ): Effect.Effect<void, ModbusError> => {
      if (writes.length === 0) return Effect.void;
      return Effect.andThen(
        ensureOpen,
        Effect.andThen(
          validateWrites(writes),
          windowMs <= 0
            ? issueDirectly(writes, attributes)
            : Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const waiter = yield* enqueue(writes, attributes, false);
                  yield* Effect.forkIn(flushPending(), scope);
                  return yield* restore(Deferred.await(waiter));
                }),
              ),
        ),
      );
    };

    const write = (write: RegisterWrite, attributes?: ModbusSpanAttributes) =>
      writeAll([write], attributes);

    const writeNow = (write: RegisterWrite, attributes?: ModbusSpanAttributes) =>
      writeAllNow([write], attributes);

    const flush = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkIn(flushPending(), scope);
        yield* restore(Fiber.await(fiber));
      }),
    );

    yield* Effect.addFinalizer(() =>
      Effect.andThen(
        Effect.sync(() => {
          closed = true;
        }),
        lock
          .withPermits(1)(
            Effect.sync(() => {
              const abandoned = Array.from(held.values());
              held.clear();
              openedAtMs = undefined;
              return abandoned;
            }),
          )
          .pipe(
            Effect.flatMap((abandoned) =>
              abandoned.length === 0
                ? Effect.void
                : Effect.logWarning(
                    `Discarding ${abandoned.length} pending register write(s) at shutdown`,
                  ).pipe(
                    Effect.andThen(
                      Effect.forEach(
                        abandoned.flatMap((entry) => entry.waiters),
                        Deferred.interrupt,
                        { discard: true },
                      ),
                    ),
                  ),
            ),
          ),
      ),
    );

    return {
      write,
      writeNow,
      writeAll,
      writeAllNow,
      flush,
      get pending() {
        return held.size;
      },
    };
  });
