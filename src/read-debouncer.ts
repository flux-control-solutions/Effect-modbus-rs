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

import { Deferred, Duration, Effect, Exit, type Fiber, type Scope, Semaphore } from 'effect';

import { ModbusTransportError, type ModbusError } from './errors';
import { planReads, type PlanReadsOptions, type ReadSpan } from './register-plan';

/** Options for {@link makeReadDebouncer}. */
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
const shortResponse = (address: number): ModbusError => {
  const message = `Response did not carry a value for register ${address}`;
  return new ModbusTransportError({ cause: new Error(message), message });
};

/** Completes one reader with its register, or with a short-response error. */
const settleWith =
  (value: number | undefined, address: number) =>
  (waiter: Deferred.Deferred<number, ModbusError>) =>
    value === undefined
      ? Deferred.fail(waiter, shortResponse(address))
      : Deferred.succeed(waiter, value);

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
 * const debouncer = yield* makeReadDebouncer({
 *   window: '5 millis',
 *   fetch: (spans) => Effect.forEach(spans, (span) => client.readHoldingRegisters(span)),
 * });
 * // 49 accessors, three transactions:
 * yield* Effect.forEach(addresses, debouncer.read, { concurrency: 'unbounded' });
 */
export const makeReadDebouncer = (
  options: ReadDebouncerOptions,
): Effect.Effect<ReadDebouncer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const windowMs = Duration.toMillis(Duration.fromInputUnsafe(options.window));

    const scope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    const collected = new Map<number, Array<Deferred.Deferred<number, ModbusError>>>();
    let timer: Fiber.Fiber<void, never> | undefined;

    /** Reads the spans and hands each reader the register it asked for. */
    const issue = (addresses: ReadonlyArray<number>) =>
      Effect.gen(function* () {
        const plan = planReads(addresses, options.plan);
        const responses = yield* options.fetch(plan.spans);
        return (address: number): number | undefined => {
          const location = plan.locate(address);
          return location === undefined ? undefined : responses[location.span]?.[location.offset];
        };
      });

    /** Reads one address on its own, for a zero window and for `readNow`. */
    const issueOne = (address: number) =>
      Effect.flatMap(issue([address]), (valueOf) => {
        const value = valueOf(address);
        return value === undefined ? Effect.fail(shortResponse(address)) : Effect.succeed(value);
      });

    /**
     * Takes the batch under the lock, then reads without it, so arrivals during
     * a transaction start the next batch rather than blocking.
     */
    const flushPending: Effect.Effect<void> = Effect.gen(function* () {
      const batch = yield* lock.withPermits(1)(
        Effect.sync(() => {
          const taken = Array.from(collected.entries());
          collected.clear();
          return taken;
        }),
      );

      if (batch.length === 0) return;

      const exit = yield* Effect.exit(issue(batch.map(([address]) => address)));

      // A failed read fails every reader in the batch. There is no partial
      // answer to give: each span went to the bus as one request, so a reader
      // cannot be told that its own register survived.
      yield* Effect.forEach(
        batch,
        ([address, waiters]) => {
          const settle = Exit.isSuccess(exit)
            ? settleWith(exit.value(address), address)
            : (waiter: Deferred.Deferred<number, ModbusError>) =>
                Deferred.failCause(waiter, exit.cause);
          return Effect.forEach(waiters, settle, { discard: true });
        },
        { discard: true },
      );
    });

    /** Collects an address, returning the `Deferred` for this reader. */
    const enqueue = (address: number, startTimer: boolean) =>
      Effect.gen(function* () {
        const waiter = yield* Deferred.make<number, ModbusError>();

        yield* lock.withPermits(1)(
          Effect.sync(() => {
            const waiters = collected.get(address);
            if (waiters === undefined) collected.set(address, [waiter]);
            else waiters.push(waiter);
          }).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                // The window opens on the arrival that starts a batch and is not
                // restarted, so a steady stream of readers cannot push it out.
                if (!startTimer || timer !== undefined) return Effect.void;
                return Effect.map(
                  Effect.forkIn(
                    Effect.sleep(Duration.millis(windowMs)).pipe(
                      Effect.andThen(
                        Effect.uninterruptible(
                          Effect.ensuring(
                            flushPending,
                            Effect.sync(() => {
                              timer = undefined;
                            }),
                          ),
                        ),
                      ),
                    ),
                    scope,
                  ),
                  (forked) => {
                    timer = forked;
                  },
                );
              }),
            ),
          ),
        );

        return waiter;
      });

    const read = (address: number) =>
      windowMs <= 0 ? issueOne(address) : Effect.flatMap(enqueue(address, true), Deferred.await);

    const readNow = (address: number) =>
      windowMs <= 0
        ? issueOne(address)
        : Effect.gen(function* () {
            const waiter = yield* enqueue(address, false);
            yield* Effect.uninterruptible(flushPending);
            return yield* Deferred.await(waiter);
          });

    yield* Effect.addFinalizer(() =>
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
                  Effect.andThen(Effect.forEach(abandoned, Deferred.interrupt, { discard: true })),
                ),
          ),
        ),
    );

    return {
      read,
      readNow,
      flush: flushPending,
      get pending() {
        return collected.size;
      },
    };
  });
