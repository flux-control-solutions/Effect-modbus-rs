/**
 * @fileoverview Coalesces register writes that arrive separately into one batch.
 *
 * `planWrites` packs the writes a caller holds at one moment. A caller that
 * derives each register independently — one fiber per output, each settling at
 * its own pace — never holds two values at the same moment, so a planner alone
 * never sees a run longer than one. Batching those would need a collection point
 * upstream that the caller does not have.
 *
 * This module is that collection point, and it collects on time rather than on
 * structure. A write is held for `window`, each new arrival restarts the window,
 * and `maxHold` caps the total hold so a register that updates without a pause
 * still reaches the wire.
 *
 * Callers still await their own write. Each caller gets its own `Deferred`,
 * completed with the exit of the flush that carried its value, so a write that
 * fails still fails for the caller that issued it. That keeps "the effect
 * succeeded" meaning "the value reached the device", which is the invariant a
 * caller uses to decide whether it may report an actuation.
 *
 * @module
 */

import { Clock, Deferred, Duration, Effect, type Fiber, type Scope, Semaphore } from 'effect';

import type { ModbusError } from './errors';
import type { RegisterWrite } from './register-plan';
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

/** Options for {@link makeWriteDebouncer}. */
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
   * Succeeds when the value reached the device, and fails with the error of the
   * flush that carried it.
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
   * addresses would otherwise reach the device after the newer value. The whole
   * group succeeds or fails together.
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

/**
 * Creates a write debouncer bound to the current scope.
 *
 * The flush runs in that scope, not in the caller's. A caller interrupted while
 * waiting — an output recomputed before its write landed — must not take the
 * pending batch down with it, and a caller must not have to carry a `Scope` to
 * issue a write.
 *
 * When the scope closes, callers still waiting are interrupted and the batch is
 * discarded. Their writes never reached the device, and reporting success for
 * them would break the invariant the `Deferred` exists to hold.
 *
 * @param options - The window, the ceiling, and the callback that issues a batch.
 * @returns The debouncer.
 *
 * @example
 * const debouncer = yield* makeWriteDebouncer({
 *   window: '250 millis',
 *   maxHold: '1 second',
 *   flush: (batch) => issue(batch),
 * });
 * // Two callers that never meet, one transaction:
 * yield* Effect.all([
 *   debouncer.write({ address: 2000, value: 10 }),
 *   debouncer.write({ address: 2001, value: 20 }),
 * ], { concurrency: 'unbounded' });
 */
export const makeWriteDebouncer = (
  options: WriteDebouncerOptions,
): Effect.Effect<WriteDebouncer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const windowMs = Duration.toMillis(Duration.fromInputUnsafe(options.window));
    const maxHoldMs =
      options.maxHold === undefined
        ? windowMs * 4
        : Duration.toMillis(Duration.fromInputUnsafe(options.maxHold));

    const scope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    const held = new Map<number, HeldWrite>();
    let timer: Fiber.Fiber<void, never> | undefined;
    let openedAtMs: number | undefined;

    /**
     * Takes the batch under the lock, then issues it without the lock.
     *
     * A flush holds the bus for the length of a transaction. Blocking arrivals
     * for that long would defeat the coalescing the debouncer exists to do.
     */
    const flushPending: Effect.Effect<void> = Effect.gen(function* () {
      const batch = yield* lock.withPermits(1)(
        Effect.sync(() => {
          const taken = Array.from(held.values());
          held.clear();
          openedAtMs = undefined;
          return taken;
        }),
      );

      if (batch.length === 0) return;

      const exit = yield* Effect.exit(
        options.flush(
          batch.map((entry) => ({
            address: entry.write.address,
            value: entry.write.value,
            attributes: entry.attributes,
          })),
        ),
      );

      yield* Effect.forEach(
        batch.flatMap((entry) => entry.waiters),
        (waiter) => Deferred.done(waiter, exit),
        { discard: true },
      );
    });

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
            timer = yield* Effect.forkIn(
              Effect.sleep(Duration.millis(delayMs)).pipe(
                // Only the wait is cancellable. Once the flush has taken the
                // batch it owns those waiters, and interrupting it midway would
                // strand every caller in it.
                Effect.andThen(Effect.uninterruptible(flushPending)),
              ),
              scope,
            );
            // `interruptUnsafe`, not an awaited interrupt: the fiber being
            // replaced may already be inside the flush waiting on this very
            // lock, and awaiting it here would deadlock. A stale timer that does
            // fire finds an empty batch and returns.
            previous?.interruptUnsafe();
          }),
        );

        return waiter;
      });

    /** Issues a group at once, for a window of zero. */
    const issueDirectly = (
      writes: ReadonlyArray<RegisterWrite>,
      attributes: ModbusSpanAttributes | undefined,
    ) =>
      options.flush(
        writes.map((write) => ({ address: write.address, value: write.value, attributes })),
      );

    const writeAll = (
      writes: ReadonlyArray<RegisterWrite>,
      attributes?: ModbusSpanAttributes,
    ): Effect.Effect<void, ModbusError> => {
      if (writes.length === 0) return Effect.void;
      return windowMs <= 0
        ? issueDirectly(writes, attributes)
        : Effect.flatMap(enqueue(writes, attributes, true), Deferred.await);
    };

    const writeAllNow = (
      writes: ReadonlyArray<RegisterWrite>,
      attributes?: ModbusSpanAttributes,
    ): Effect.Effect<void, ModbusError> => {
      if (writes.length === 0) return Effect.void;
      return windowMs <= 0
        ? issueDirectly(writes, attributes)
        : Effect.gen(function* () {
            const waiter = yield* enqueue(writes, attributes, false);
            yield* Effect.uninterruptible(flushPending);
            return yield* Deferred.await(waiter);
          });
    };

    const write = (write: RegisterWrite, attributes?: ModbusSpanAttributes) =>
      writeAll([write], attributes);

    const writeNow = (write: RegisterWrite, attributes?: ModbusSpanAttributes) =>
      writeAllNow([write], attributes);

    yield* Effect.addFinalizer(() =>
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
    );

    return {
      write,
      writeNow,
      writeAll,
      writeAllNow,
      flush: flushPending,
      get pending() {
        return held.size;
      },
    };
  });
