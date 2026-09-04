/**
 * @fileoverview Collects register reads that arrive separately into one span.
 *
 * `planReads` merges the addresses a caller holds at one moment. A caller with an
 * accessor per parameter never holds two addresses at the same moment, so a
 * planner alone would force every such caller to be rewritten around a batch API.
 *
 * This module collects the addresses on time instead, so a caller keeps its
 * per-parameter accessors and still gets one transaction per span.
 *
 * The read debouncer is deliberately simpler than the write debouncer. There is
 * no supersede rule, because a second request for an address is not a newer
 * value, it is a second reader. There is no cache, because this package records
 * only what it wrote. There is no ceiling on the hold, because the window does
 * not restart: it opens on the first arrival of a batch and expires on time,
 * which a stream of arrivals can never push out.
 *
 * @module
 */

import { Deferred, Duration, Effect, Exit, Fiber, type Scope, Semaphore } from 'effect';

import {
  ModbusInvalidArgumentError,
  ModbusNotConnectedError,
  ModbusTransportError,
  type ModbusError,
} from './errors';
import { planReads, type PlanReadsOptions, type ReadSpan } from './register-plan';

/** Options for {@link createReadDebouncer}. */
export interface ReadDebouncerOptions {
  /**
   * How long addresses are collected before the spans are read.
   *
   * The window opens on the first arrival and does not restart, so it bounds the
   * latency a reader pays. One transaction is the unit to compare it against:
   * a window far shorter than a transaction collects nothing, and a window much
   * longer than one delays every reader for a batch it did not need.
   *
   * A window of zero disables the debouncer: every read is issued on its own,
   * with no timer and no batch.
   */
  readonly window: Duration.Input;
  /** Limits handed to `planReads`. */
  readonly plan?: PlanReadsOptions;
  /**
   * Reads the planned spans, in order.
   *
   * Must return one response per span, each holding that span's `quantity`
   * registers. The callback owns the function code: a caller that reads input
   * registers rather than holding registers builds a second debouncer.
   */
  fetch(spans: ReadonlyArray<ReadSpan>): Effect.Effect<ReadonlyArray<Uint16Array>, ModbusError>;
}

/** A collection point for reads that arrive separately. */
export interface ReadDebouncer {
  /** Collects an address for the window, then returns its value. */
  read(address: number): Effect.Effect<number, ModbusError>;

  /**
   * Adds an address to the batch and reads immediately, rather than waiting.
   *
   * Every reader already collected is answered by the same transaction, so no
   * reader waits longer because of this call.
   */
  readNow(address: number): Effect.Effect<number, ModbusError>;

  /**
   * Collects several addresses for the window, as one reader, and returns their
   * values in the order asked for.
   *
   * A reader that already holds every address does not need a collection point,
   * only a planner. With a window of zero the group is planned and read at once,
   * so a caller of this method gets one transaction per span with no debouncer
   * at all.
   */
  readAll(addresses: ReadonlyArray<number>): Effect.Effect<ReadonlyArray<number>, ModbusError>;

  /** Adds several addresses to the batch and reads immediately. */
  readAllNow(addresses: ReadonlyArray<number>): Effect.Effect<ReadonlyArray<number>, ModbusError>;

  /**
   * Reads whatever is collected, now.
   *
   * Never fails: the outcome goes to the readers waiting on the batch, not to
   * whoever asked for the flush.
   */
  readonly flush: Effect.Effect<void>;

  /** Addresses currently collected. Intended for tests. */
  readonly pending: number;
}

/**
 * Builds the error for a response that does not hold the registers it was asked
 * for.
 *
 * A short response is a wire-level fault, not a programming error: the request
 * named a quantity and the answer did not carry it.
 */
const malformedResponse = (message: string): ModbusError =>
  new ModbusTransportError({ cause: new Error(message), message });

const shortResponse = (address: number): ModbusError =>
  malformedResponse(`Response did not carry a value for register ${address}`);

/** Completes one reader with its register, or with a short-response error. */
const settleWith =
  (value: number | undefined, address: number) =>
  (waiter: Deferred.Deferred<number, ModbusError>) =>
    value === undefined
      ? Deferred.fail(waiter, shortResponse(address))
      : Deferred.succeed(waiter, value);

/** Identity of one scheduled window, used to reject a stale timer callback. */
interface TimerState {
  readonly id: number;
  fiber?: Fiber.Fiber<void, never>;
}

/**
 * Creates a read debouncer bound to the current scope.
 *
 * As with the write debouncer, the read runs in that scope. A reader interrupted
 * while waiting must not take the batch down with it.
 *
 * When the scope closes, readers still waiting are interrupted.
 *
 * @param options - The window, the planner limits, and the callback that reads.
 * @returns The debouncer.
 *
 * @example
 * const debouncer = yield* createReadDebouncer({
 *   window: '5 millis',
 *   fetch: (spans) => Effect.forEach(spans, (span) => client.readHoldingRegisters(span)),
 * });
 * // 49 accessors, three transactions:
 * yield* Effect.forEach(addresses, debouncer.read, { concurrency: 'unbounded' });
 */
export const createReadDebouncer = (
  options: ReadDebouncerOptions,
): Effect.Effect<ReadDebouncer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const windowMs = Duration.toMillis(Duration.fromInputUnsafe(options.window));

    const scope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    const collected = new Map<number, Array<Deferred.Deferred<number, ModbusError>>>();
    let timer: TimerState | undefined;
    let nextTimerId = 0;
    let closed = false;

    const scopeClosedError = () => {
      const message = 'The read debouncer scope has been closed';
      return new ModbusNotConnectedError({ cause: new Error(message), message });
    };

    const ensureOpen = Effect.suspend(() =>
      closed ? Effect.fail(scopeClosedError()) : Effect.void,
    );

    const validateAddresses = (addresses: ReadonlyArray<number>) =>
      Effect.try({
        try: () => {
          for (const address of addresses) {
            if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
              throw new RangeError(`address must be an integer from 0 to 65535, got ${address}`);
            }
          }
        },
        catch: (cause) => {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          return new ModbusInvalidArgumentError({ cause: error, message: error.message });
        },
      });

    /** Reads the spans and hands each reader the register it asked for. */
    const issue = (addresses: ReadonlyArray<number>) =>
      Effect.gen(function* () {
        const plan = yield* Effect.try({
          try: () => planReads(addresses, options.plan),
          catch: (cause) => {
            const error = cause instanceof Error ? cause : new Error(String(cause));
            return new ModbusInvalidArgumentError({ cause: error, message: error.message });
          },
        });
        const responses = yield* options.fetch(plan.spans);
        if (responses.length !== plan.spans.length) {
          return yield* malformedResponse(
            `Expected ${plan.spans.length} read response(s), received ${responses.length}`,
          );
        }
        for (let index = 0; index < plan.spans.length; index += 1) {
          const span = plan.spans[index]!;
          const response = responses[index]!;
          if (response.length !== span.quantity) {
            return yield* malformedResponse(
              `Expected ${span.quantity} register(s) for span at address ${span.address}, ` +
                `received ${response.length}`,
            );
          }
        }
        return (address: number): number | undefined => {
          const location = plan.locate(address);
          return location === undefined ? undefined : responses[location.span]?.[location.offset];
        };
      });

    /** Reads a group on its own, for a window of zero. */
    const issueDirectly = (addresses: ReadonlyArray<number>) =>
      Effect.flatMap(issue(addresses), (valueOf) =>
        Effect.forEach(addresses, (address) => {
          const value = valueOf(address);
          return value === undefined ? Effect.fail(shortResponse(address)) : Effect.succeed(value);
        }),
      );

    /**
     * Takes the batch under the lock, then reads without it, so arrivals during
     * a transaction start the next batch rather than blocking.
     */
    const flushPending = (expectedTimer?: TimerState): Effect.Effect<void> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const taken = yield* lock.withPermits(1)(
            Effect.sync(() => {
              if (expectedTimer !== undefined && timer?.id !== expectedTimer.id) return undefined;

              const activeTimer = timer;
              timer = undefined;
              const batch = Array.from(collected.entries());
              collected.clear();
              return { activeTimer, batch };
            }),
          );

          if (taken === undefined) return;
          if (expectedTimer === undefined) taken.activeTimer?.fiber?.interruptUnsafe();
          if (taken.batch.length === 0) return;

          const exit = yield* Effect.exit(restore(issue(taken.batch.map(([address]) => address))));

          // A failed read fails every reader in the batch. There is no partial
          // answer to give: each span went to the bus as one request, so a reader
          // cannot be told that its own register survived.
          yield* Effect.forEach(
            taken.batch,
            ([address, waiters]) => {
              const settle = Exit.isSuccess(exit)
                ? settleWith(exit.value(address), address)
                : (waiter: Deferred.Deferred<number, ModbusError>) =>
                    Deferred.failCause(waiter, exit.cause);
              return Effect.forEach(waiters, settle, { discard: true });
            },
            { discard: true },
          );
        }),
      );

    /** Collects addresses, returning one `Deferred` for each, in order. */
    const enqueue = (addresses: ReadonlyArray<number>, startTimer: boolean) =>
      Effect.gen(function* () {
        const waiters = yield* Effect.forEach(addresses, () =>
          Deferred.make<number, ModbusError>(),
        );

        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (closed) return yield* scopeClosedError();
            addresses.forEach((address, index) => {
              const existing = collected.get(address);
              if (existing === undefined) collected.set(address, [waiters[index]!]);
              else existing.push(waiters[index]!);
            });
          }).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                // The window opens on the arrival that starts a batch and is not
                // restarted, so a steady stream of readers cannot push it out.
                if (!startTimer || timer !== undefined) return Effect.void;
                const state: TimerState = { id: nextTimerId++ };
                timer = state;
                return Effect.map(
                  Effect.forkIn(
                    Effect.sleep(Duration.millis(windowMs)).pipe(
                      Effect.andThen(flushPending(state)),
                    ),
                    scope,
                  ),
                  (forked) => {
                    state.fiber = forked;
                    if (timer?.id !== state.id) forked.interruptUnsafe();
                  },
                );
              }),
            ),
          ),
        );

        return waiters;
      });

    const readAll = (
      addresses: ReadonlyArray<number>,
    ): Effect.Effect<ReadonlyArray<number>, ModbusError> => {
      if (addresses.length === 0) return Effect.succeed([]);
      return Effect.andThen(
        ensureOpen,
        Effect.andThen(
          validateAddresses(addresses),
          windowMs <= 0
            ? issueDirectly(addresses)
            : Effect.flatMap(enqueue(addresses, true), (waiters) =>
                Effect.forEach(waiters, Deferred.await),
              ),
        ),
      );
    };

    const readAllNow = (
      addresses: ReadonlyArray<number>,
    ): Effect.Effect<ReadonlyArray<number>, ModbusError> => {
      if (addresses.length === 0) return Effect.succeed([]);
      return Effect.andThen(
        ensureOpen,
        Effect.andThen(
          validateAddresses(addresses),
          windowMs <= 0
            ? issueDirectly(addresses)
            : Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const waiters = yield* enqueue(addresses, false);
                  yield* Effect.forkIn(flushPending(), scope);
                  return yield* restore(Effect.forEach(waiters, Deferred.await));
                }),
              ),
        ),
      );
    };

    const read = (address: number) => Effect.map(readAll([address]), (values) => values[0]!);

    const readNow = (address: number) => Effect.map(readAllNow([address]), (values) => values[0]!);

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
              const abandoned = Array.from(collected.values()).flat();
              collected.clear();
              return abandoned;
            }),
          )
          .pipe(
            Effect.flatMap((abandoned) =>
              abandoned.length === 0
                ? Effect.void
                : Effect.logWarning(
                    `Discarding ${abandoned.length} pending register read(s) at shutdown`,
                  ).pipe(
                    Effect.andThen(
                      Effect.forEach(abandoned, Deferred.interrupt, { discard: true }),
                    ),
                  ),
            ),
          ),
      ),
    );

    return {
      read,
      readNow,
      readAll,
      readAllNow,
      flush,
      get pending() {
        return collected.size;
      },
    };
  });
