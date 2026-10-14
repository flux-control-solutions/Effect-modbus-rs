/**
 * @fileoverview Coalesces register writes by address and flushes them after a debounce window.
 * New arrivals restart the window; `maxHold` limits the total delay.
 *
 * @module
 */

import { Clock, Deferred, Duration, Effect, Exit, Fiber, type Scope, Semaphore } from 'effect';

import { ModbusInvalidArgumentError, ModbusNotConnectedError, type ModbusError } from './errors';
import {
  encodeRegisterValue,
  MODBUS_MAX_WRITE_REGISTERS,
  type RegisterWrite,
} from './register-plan';
import type { ModbusSpanAttributes } from './span-attributes';

/** One write in a flushed batch, with the attributes of the caller that issued it. */
export interface DebouncedWrite {
  /** Register address. */
  readonly address: number;
  /** Value to write, as the caller gave it. */
  readonly value: number;
  /** Attributes of the caller that issued the newest value for this address. */
  readonly attributes: ModbusSpanAttributes | undefined;
  /**
   * Whether the flush must send this write when a cache holds the same value.
   * `true` when the flush must send this write when a cache holds the same value.
   * A newer write to the same address in the same batch keeps this flag. Otherwise
   * the cache can suppress the newer value, and the caller that asked for the
   * bypass sees success for a write that did not reach the device.
   */
  readonly bypassCache?: boolean;
}

/** Per-call options for the write methods. */
export interface WriteOptions {
  /**
   * Sends the write when the cache already holds its value.
   *
   * Use this when the device can change a register on its own, or when an action
   * must restore a known state. Other writes in the same batch are still
   * filtered. The cache records the value after the device acknowledges it.
   *
   * @defaultValue false
   */
  readonly bypassCache?: boolean;
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
   * Flushes a run of contiguous addresses early when it reaches
   * `maxRegistersPerWrite`.
   *
   * A full run cannot gain more registers in its transaction, so more waiting
   * only adds delay. Only complete runs leave the batch. Other held writes stay
   * for the window, so repeated writes to them can still replace each other.
   *
   * @defaultValue false
   */
  readonly flushFullRuns?: boolean;
  /**
   * Registers one write transaction can carry. A run with this many contiguous
   * addresses is full. Use the same value as the planner. The planner rejects
   * a value out of range when the batch is flushed.
   *
   * @defaultValue {@link MODBUS_MAX_WRITE_REGISTERS} (123)
   */
  readonly maxRegistersPerWrite?: number;
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
  write(
    write: RegisterWrite,
    attributes?: ModbusSpanAttributes,
    options?: WriteOptions,
  ): Effect.Effect<void, ModbusError>;

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
    options?: WriteOptions,
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
    options?: WriteOptions,
  ): Effect.Effect<void, ModbusError>;

  /** Adds several writes to the batch and flushes immediately. */
  writeAllNow(
    writes: ReadonlyArray<RegisterWrite>,
    attributes?: ModbusSpanAttributes,
    options?: WriteOptions,
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

/**
 * One caller that waits on its writes.
 *
 * A partial flush can send some of a group and hold the rest. The caller
 * completes after every entry that holds it is flushed, or at the first failure.
 */
interface Waiter {
  readonly deferred: Deferred.Deferred<void, ModbusError>;
  /** Held entries that list this waiter. A duplicate address counts each time. */
  remaining: number;
}

/** One address held in the batch, with every caller waiting on it. */
interface HeldWrite {
  readonly write: RegisterWrite;
  readonly attributes: ModbusSpanAttributes | undefined;
  readonly bypassCache: boolean;
  /** When the first write to this address in the batch arrived. */
  readonly arrivedAtMs: number;
  readonly waiters: ReadonlyArray<Waiter>;
}

/**
 * Replaces a held write with a newer write to the same address.
 *
 * The newer write inherits the waiters: only the newest value reaches the wire,
 * and every caller that waits on the address learns whether it got there. The
 * bypass flag also stays. Otherwise the cache can suppress the newer value after
 * an earlier caller asked for a forced write.
 */
const supersede = (
  superseded: HeldWrite | undefined,
  next: Omit<HeldWrite, 'waiters'>,
  waiter: Waiter,
): HeldWrite => {
  waiter.remaining += 1;
  return superseded === undefined
    ? { ...next, waiters: [waiter] }
    : {
        ...next,
        bypassCache: next.bypassCache || superseded.bypassCache,
        // The hold limit applies from the first arrival, not the newest one.
        arrivedAtMs: superseded.arrivedAtMs,
        waiters: [...superseded.waiters, waiter],
      };
};

/**
 * Tells whether the held run that contains `address` has `limit` addresses.
 *
 * The scan stops at `limit`, so one arrival costs at most `limit` lookups.
 */
const completesRun = (held: ReadonlyMap<number, unknown>, address: number, limit: number) => {
  let length = 1;
  for (let below = address - 1; length < limit && held.has(below); below -= 1) length += 1;
  for (let above = address + 1; length < limit && held.has(above); above += 1) length += 1;
  return length >= limit;
};

/**
 * Selects the addresses of each held run that fill complete transactions.
 *
 * The planner splits a run from its lowest address. These are the addresses of
 * the full chunks, so the remainder stays held and can still grow.
 */
const fullRunAddresses = (addresses: Iterable<number>, limit: number): ReadonlyArray<number> => {
  const sorted = Array.from(addresses).sort((left, right) => left - right);
  const selected: number[] = [];
  let start = 0;
  for (let index = 1; index <= sorted.length; index += 1) {
    if (index < sorted.length && sorted[index] === sorted[index - 1]! + 1) continue;
    const full = Math.floor((index - start) / limit) * limit;
    selected.push(...sorted.slice(start, start + full));
    start = index;
  }
  return selected;
};

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
    const flushFullRuns = options.flushFullRuns ?? false;
    const maxRegistersPerWrite = options.maxRegistersPerWrite ?? MODBUS_MAX_WRITE_REGISTERS;

    const scope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    const flushLock = yield* Semaphore.make(1);
    const held = new Map<number, HeldWrite>();
    let timer: TimerState | undefined;
    let nextTimerId = 0;
    let openedAtMs: number | undefined;
    let lastArrivalMs: number | undefined;
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
     * Starts a new window timer and stops the previous one. Call it under `lock`.
     *
     * Do not await the interruption while `lock` is held. An expired timer can
     * wait for the same lock before it can return.
     */
    const scheduleTimer = (delayMs: number) =>
      Effect.gen(function* () {
        const previous = timer;
        const state: TimerState = { id: nextTimerId++ };
        timer = state;
        const forked = yield* Effect.forkIn(
          Effect.sleep(Duration.millis(delayMs)).pipe(Effect.andThen(flushPending(state))),
          scope,
        );
        state.fiber = forked;
        if (timer?.id !== state.id) forked.interruptUnsafe();
        previous?.fiber?.interruptUnsafe();
      });

    /**
     * Sets the timer for the writes that stay after a partial flush. Call it
     * under `lock`.
     *
     * The hold limit applies from the oldest write that stays, not from the
     * arrival that opened the batch.
     */
    const rescheduleRemaining = Effect.gen(function* () {
      if (held.size === 0) {
        const active = timer;
        timer = undefined;
        openedAtMs = undefined;
        active?.fiber?.interruptUnsafe();
        return;
      }
      let oldest = Number.POSITIVE_INFINITY;
      for (const entry of held.values()) oldest = Math.min(oldest, entry.arrivedAtMs);
      openedAtMs = oldest;
      const now = yield* Clock.currentTimeMillis;
      const deadline = Math.min((lastArrivalMs ?? now) + windowMs, oldest + maxHoldMs);
      yield* scheduleTimer(Math.max(0, deadline - now));
    });

    /** Takes the full runs out of the batch, and keeps the rest. Call it under `lock`. */
    const takeFullRuns = Effect.gen(function* () {
      const addresses = fullRunAddresses(held.keys(), maxRegistersPerWrite);
      if (addresses.length === 0) return undefined;
      const batch = addresses.map((address) => held.get(address)!);
      for (const address of addresses) held.delete(address);
      yield* rescheduleRemaining;
      return { activeTimer: undefined, batch };
    });

    /** Takes the whole batch and its timer. Call it under `lock`. */
    const takeAll = Effect.sync(() => {
      const activeTimer = timer;
      timer = undefined;
      const batch = Array.from(held.values());
      held.clear();
      openedAtMs = undefined;
      lastArrivalMs = undefined;
      return { activeTimer, batch };
    });

    /** Completes each waiter after its last entry is flushed, or at the first failure. */
    const settle = (batch: ReadonlyArray<HeldWrite>, exit: Exit.Exit<void, ModbusError>) =>
      Effect.forEach(
        batch.flatMap((entry) => entry.waiters),
        (waiter) => {
          waiter.remaining -= 1;
          return Exit.isSuccess(exit) && waiter.remaining > 0
            ? Effect.void
            : Deferred.done(waiter.deferred, exit);
        },
        { discard: true },
      );

    /**
     * Takes the batch under the lock, then issues it without the lock.
     *
     * A flush holds the bus for the length of a transaction. Blocking arrivals
     * for that long would defeat the coalescing the debouncer exists to do.
     *
     * With `fullRunsOnly`, the flush takes only the full runs and leaves the
     * other writes for their window.
     */
    const flushPending = (expectedTimer?: TimerState, fullRunsOnly = false): Effect.Effect<void> =>
      flushLock.withPermits(1)(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const taken = yield* lock.withPermits(1)(
              Effect.suspend(() => {
                if (expectedTimer !== undefined && timer?.id !== expectedTimer.id) {
                  return Effect.succeed(undefined);
                }
                return fullRunsOnly ? takeFullRuns : takeAll;
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
                    ...(entry.bypassCache && { bypassCache: true as const }),
                  })),
                ),
              ),
            );

            yield* settle(taken.batch, exit);
          }),
        ),
      );

    /**
     * Adds writes to the batch, returning the one `Deferred` for this caller.
     *
     * The whole group is added under one hold of the lock. A full flush takes
     * all of it or none of it. A partial flush can take part of it, so the
     * waiter counts its entries and completes after the last one.
     */
    const enqueue = (
      writes: ReadonlyArray<RegisterWrite>,
      attributes: ModbusSpanAttributes | undefined,
      bypassCache: boolean,
      restartTimer: boolean,
    ) =>
      Effect.gen(function* () {
        const waiter: Waiter = {
          deferred: yield* Deferred.make<void, ModbusError>(),
          remaining: 0,
        };

        const full = yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (closed) return yield* scopeClosedError();
            const now = yield* Clock.currentTimeMillis;
            for (const write of writes) {
              held.set(
                write.address,
                supersede(
                  held.get(write.address),
                  { write, attributes, bypassCache, arrivedAtMs: now },
                  waiter,
                ),
              );
            }

            openedAtMs ??= now;
            if (!restartTimer) return false;

            lastArrivalMs = now;
            yield* scheduleTimer(Math.max(0, Math.min(windowMs, openedAtMs + maxHoldMs - now)));
            return (
              flushFullRuns &&
              writes.some((write) => completesRun(held, write.address, maxRegistersPerWrite))
            );
          }),
        );

        // Fork after the lock is released. The flush takes the lock itself.
        if (full) yield* Effect.forkIn(flushPending(undefined, true), scope);
        return waiter.deferred;
      });

    /** Issues a group at once, for a window of zero. */
    const issueDirectly = (
      writes: ReadonlyArray<RegisterWrite>,
      attributes: ModbusSpanAttributes | undefined,
      bypassCache: boolean,
    ) =>
      flushLock.withPermits(1)(
        options.flush(
          writes.map((write) => ({
            address: write.address,
            value: write.value,
            attributes,
            ...(bypassCache && { bypassCache: true as const }),
          })),
        ),
      );

    const writeAll = (
      writes: ReadonlyArray<RegisterWrite>,
      attributes?: ModbusSpanAttributes,
      writeOptions?: WriteOptions,
    ): Effect.Effect<void, ModbusError> => {
      if (writes.length === 0) return Effect.void;
      const bypassCache = writeOptions?.bypassCache ?? false;
      return Effect.andThen(
        ensureOpen,
        Effect.andThen(
          validateWrites(writes),
          windowMs <= 0
            ? issueDirectly(writes, attributes, bypassCache)
            : Effect.flatMap(enqueue(writes, attributes, bypassCache, true), Deferred.await),
        ),
      );
    };

    const writeAllNow = (
      writes: ReadonlyArray<RegisterWrite>,
      attributes?: ModbusSpanAttributes,
      writeOptions?: WriteOptions,
    ): Effect.Effect<void, ModbusError> => {
      if (writes.length === 0) return Effect.void;
      const bypassCache = writeOptions?.bypassCache ?? false;
      return Effect.andThen(
        ensureOpen,
        Effect.andThen(
          validateWrites(writes),
          windowMs <= 0
            ? issueDirectly(writes, attributes, bypassCache)
            : Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const waiter = yield* enqueue(writes, attributes, bypassCache, false);
                  yield* Effect.forkIn(flushPending(), scope);
                  return yield* restore(Deferred.await(waiter));
                }),
              ),
        ),
      );
    };

    const write = (
      write: RegisterWrite,
      attributes?: ModbusSpanAttributes,
      writeOptions?: WriteOptions,
    ) => writeAll([write], attributes, writeOptions);

    const writeNow = (
      write: RegisterWrite,
      attributes?: ModbusSpanAttributes,
      writeOptions?: WriteOptions,
    ) => writeAllNow([write], attributes, writeOptions);

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
              lastArrivalMs = undefined;
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
                        (waiter) => Deferred.interrupt(waiter.deferred),
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
