/**
 * @fileoverview A client that decides the transactions, rather than issuing the
 * ones a caller names.
 *
 * `withClient` returns an {@link EffectModbusClient}: it issues exactly the
 * transaction asked for, and it is the right client when a caller knows what the
 * bus should carry. This module is its sibling for the other case — a caller with
 * one accessor per register, which knows what it wants to read and write but not
 * what that ought to cost.
 *
 * @module
 */

import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';

import { ConnectionState } from './connection';
import { ModbusInvalidArgumentError, ModbusNotConnectedError, type ModbusError } from './errors';
import type { EffectModbusClient, ModbusOperations } from './modbus-client';
import { makeReadDebouncer, type ReadDebouncer } from './read-debouncer';
import { makeRegisterCache, type RegisterCache } from './register-cache';
import {
  planWrites,
  type PlanReadsOptions,
  type PlanWritesOptions,
  type ReadSpan,
  type RegisterWrite,
} from './register-plan';
import type { ModbusRetryPolicy } from './retry';
import { mergeSpanAttributes, type ModbusSpanAttributes } from './span-attributes';
import { makeWriteDebouncer, type DebouncedWrite } from './write-debouncer';

/** How long operations are collected before they reach the bus. */
export interface BatchingDebounceOptions {
  /**
   * The window for writes, and the ceiling on the total hold.
   *
   * Omitted, writes are not debounced: each one reaches the bus on its own. The
   * package holds nothing back by default, so a caller that has not asked for a
   * window pays no latency for one.
   */
  readonly writes?: {
    readonly window: Duration.Input;
    readonly maxHold?: Duration.Input;
  };
  /**
   * The window for reads.
   *
   * Omitted, reads are not debounced. `readAll` still plans the addresses it is
   * given, so a caller that reads a group in one call needs no window.
   *
   * A useful window is on the order of one transaction. Measure a transaction on
   * the bus in question before choosing one.
   */
  readonly reads?: {
    readonly window: Duration.Input;
  };
}

/** Options for {@link makeBatchingClient}. */
export interface BatchingClientOptions {
  /**
   * The write cache, which drops a write whose value the device already holds.
   *
   * Pass `false` to write every value, whether or not it changes anything. Pass
   * a cache to share one with something else. The transport supplies its own by
   * default, which is the right one: the cache is a belief about a physical
   * device, and two caches on one unit disagree.
   */
  readonly cache?: boolean | RegisterCache;
  /** The windows. Omitted, nothing is debounced. */
  readonly debounce?: BatchingDebounceOptions;
  /** Limits handed to the planners. */
  readonly plan?: {
    readonly writes?: PlanWritesOptions;
    readonly reads?: PlanReadsOptions;
  };
}

/** Reads over one register space. */
export interface BatchingRegisterReader {
  /** Collects an address for the read window, then returns its value. */
  read(address: number): Effect.Effect<number, ModbusError>;
  /** Adds an address to the batch and reads immediately, answering every reader in it. */
  readNow(address: number): Effect.Effect<number, ModbusError>;
  /** Reads a group as one reader, planned into spans, in the order asked for. */
  readAll(addresses: ReadonlyArray<number>): Effect.Effect<ReadonlyArray<number>, ModbusError>;
  /** Adds a group to the batch and reads immediately. */
  readAllNow(addresses: ReadonlyArray<number>): Effect.Effect<ReadonlyArray<number>, ModbusError>;
}

/**
 * A client that decides its own transactions.
 *
 * CAUTION: This is not an {@link EffectModbusClient} and does not extend
 * {@link ModbusOperations}. There is no `writeSingleRegister` and no
 * `readHoldingRegisters` here. A raw write on this object would go around the
 * cache and around the batch, so a value held for an address could reach the
 * device after a newer value written past it. A caller that needs the raw
 * surface as well gets it from `withClient`, which shares the same connection.
 * Once a batching client exists for a unit, that raw client remains available
 * for reads, coils, and the other non-register-write operations, but FC06,
 * FC16, and FC23 fail with `ModbusInvalidArgumentError`. Mixing the two register
 * write paths would bypass the pending batch and its cache.
 *
 * Coils are not covered. The planners pack registers, so `readCoils`,
 * `writeSingleCoil`, and their relatives stay on the raw client.
 */
export interface BatchingModbusClient extends BatchingRegisterReader {
  /** The unit this client addresses. */
  readonly unitId: number;

  /** Holds a write for the write window, then issues it with whatever else arrived. */
  write(write: RegisterWrite, attributes?: ModbusSpanAttributes): Effect.Effect<void, ModbusError>;
  /** Adds a write to the batch and issues it immediately, newest value winning. */
  writeNow(
    write: RegisterWrite,
    attributes?: ModbusSpanAttributes,
  ): Effect.Effect<void, ModbusError>;
  /** Holds a group of writes as one caller. The group succeeds or fails together. */
  writeAll(
    writes: ReadonlyArray<RegisterWrite>,
    attributes?: ModbusSpanAttributes,
  ): Effect.Effect<void, ModbusError>;
  /** Adds a group of writes to the batch and issues it immediately. */
  writeAllNow(
    writes: ReadonlyArray<RegisterWrite>,
    attributes?: ModbusSpanAttributes,
  ): Effect.Effect<void, ModbusError>;

  /** Reads over the input registers (FC04). The unqualified reads are holding registers (FC03). */
  readonly inputs: BatchingRegisterReader;

  /**
   * Issues everything pending, now. Never fails: the outcome goes to the callers
   * waiting on each batch.
   */
  readonly flush: Effect.Effect<void>;

  /** The cache this client filters against, or `undefined` when `cache` is `false`. */
  readonly cache: RegisterCache | undefined;

  /**
   * Runs an action when the calling scope closes, while the bus is still open
   * and before this client is torn down.
   *
   * A device's safe state is the device's own answer — zero volts for one, a
   * stopped motor for another — so it is stated here, on the client that
   * addresses it, rather than dispatched from one action over a set of units.
   *
   * A failure is logged and then raised as a defect. The other finalizers in the
   * scope still run, so a device that cannot be reached does not cost the rest of
   * the bus its turn. Wrap the action in `Effect.ignoreLogged` to accept the
   * failure instead.
   *
   * @example
   * const damper = yield* transport.withBatchingClient(3);
   * yield* damper.onShutdown(damper.writeAllNow([{ address: 2000, value: 0 }]));
   */
  onShutdown(action: Effect.Effect<void, ModbusError>): Effect.Effect<void, never, Scope.Scope>;
}

/**
 * Builds a batching client over a raw client for one unit.
 *
 * The transport calls this from `withBatchingClient`, which is where a consumer
 * normally meets it. Call it directly to drive a client this package did not
 * hand out — a raw `modbus-rs` client behind the escape hatch, or a stub.
 *
 * @param options - The unit, the raw client, and the policies.
 * @returns The batching client, bound to the current scope.
 */
export const makeBatchingClient = (options: {
  readonly unitId: number;
  readonly client: EffectModbusClient;
  readonly cache: RegisterCache | undefined;
  readonly debounce?: BatchingDebounceOptions;
  readonly plan?: BatchingClientOptions['plan'];
}): Effect.Effect<BatchingModbusClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { unitId, client, cache } = options;
    const scope = yield* Effect.scope;

    const invalidArgument = (cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      return new ModbusInvalidArgumentError({ cause: error, message: error.message });
    };

    /** Attributes every span carries, whatever the caller supplied. */
    const own = (registerCount: number, transactionCount: number, suppressedCount: number) => ({
      // Plural, although one client addresses one unit. A driver that batches
      // across a bus reports the same key, and a caller reading these spans
      // should not have to know which one produced them.
      'modbus.unit_ids': String(unitId),
      'modbus.register_count': registerCount,
      'modbus.transaction_count': transactionCount,
      'modbus.suppressed_count': suppressedCount,
    });

    /**
     * Issues one batch of writes.
     *
     * The span opens after the cache filter, and only when a write survives it,
     * so it records what reached the bus rather than what a caller proposed.
     *
     * The filter can cost more than it saves: a suppressed address in the middle
     * of a run splits that run into one FC06 per register. So the batch is
     * planned both ways and the plan with fewer transactions wins, with a tie
     * going to the filtered one because its frames are shorter. A caller that
     * needs a register left alone rather than rewritten with the value it already
     * holds wants `withClient`, which issues exactly the transaction it is given.
     */
    const issueWrites = (batch: ReadonlyArray<DebouncedWrite>) =>
      Effect.gen(function* () {
        const proposed = batch.map((entry) => ({ address: entry.address, value: entry.value }));
        const filtered = yield* Effect.try({
          try: () => cache?.filter(unitId, proposed),
          catch: invalidArgument,
        });
        const pending = filtered?.pending ?? proposed;
        if (pending.length === 0) return;

        const plan = yield* Effect.try({
          try: () => {
            const steps = planWrites(pending, options.plan?.writes);
            if (pending.length === proposed.length) return { steps, written: proposed };
            // Dropping a write out of the middle of a run splits that run, so a
            // cache meant to save turnarounds can spend them instead. Planning
            // the proposal as a whole costs the registers the cache would have
            // held back, and never more than `cache: false` would have sent.
            const whole = planWrites(proposed, options.plan?.writes);
            return whole.length < steps.length
              ? { steps: whole, written: proposed }
              : { steps, written: pending };
          },
          catch: invalidArgument,
        });
        const { steps, written } = plan;

        // What reached the bus, which is what the span reports: the addresses in
        // the chosen plan, and the callers whose values are in it.
        const carried = new Set(written.map((write) => write.address));
        const suppressed = proposed.length - written.length;

        yield* Effect.forEach(
          steps,
          (step) =>
            // Read before the step is issued, so an invalidation that lands while
            // it is on the wire wins over the observation that follows it. The
            // client call spans its whole retry budget, so that is not a gap of
            // one turnaround.
            Effect.suspend(() => {
              const generation = cache?.generationOf(unitId);
              return step.kind === 'single'
                ? Effect.tap(
                    client.writeSingleRegister({ address: step.address, value: step.value }),
                    () =>
                      Effect.sync(() =>
                        cache?.observe(unitId, step.address, step.value, generation),
                      ),
                  )
                : Effect.tap(
                    client.writeMultipleRegisters({ address: step.address, values: step.values }),
                    () =>
                      Effect.sync(() =>
                        step.values.forEach((value, index) =>
                          cache?.observe(unitId, step.address + index, value, generation),
                        ),
                      ),
                  );
            }),
          { discard: true },
        ).pipe(
          // A failed transaction means the state of the device is unknown: it
          // may have power-cycled and reset its registers. A stale belief then
          // suppresses exactly the write that would restore it.
          Effect.tapError(() => Effect.sync(() => cache?.invalidate(unitId))),
          Effect.withSpan('modbus.write', {
            kind: 'client',
            attributes: {
              // Caller vocabulary first: the library's own record of what
              // happened wins a key collision. Only the callers whose values are
              // in the plan contribute, so a suppressed caller cannot put its
              // vocabulary on a transaction that did not carry its value.
              ...mergeSpanAttributes(
                batch
                  .filter((entry) => carried.has(entry.address))
                  .map((entry) => entry.attributes),
              ),
              ...own(written.length, steps.length, suppressed),
            },
          }),
        );
      });

    /** Reads the planned spans over one register space. */
    const issueReads =
      (name: string, read: EffectModbusClient['readHoldingRegisters']) =>
      (spans: ReadonlyArray<ReadSpan>) =>
        Effect.forEach(spans, (span) =>
          read({ address: span.address, quantity: span.quantity }),
        ).pipe(
          Effect.withSpan(name, {
            kind: 'client',
            attributes: own(
              spans.reduce((total, span) => total + span.quantity, 0),
              spans.length,
              0,
            ),
          }),
        );

    const writes = yield* makeWriteDebouncer({
      window: options.debounce?.writes?.window ?? 0,
      maxHold: options.debounce?.writes?.maxHold,
      flush: issueWrites,
    });

    const holding = yield* makeReadDebouncer({
      window: options.debounce?.reads?.window ?? 0,
      plan: options.plan?.reads,
      fetch: issueReads('modbus.read', client.readHoldingRegisters),
    });

    const inputs = yield* makeReadDebouncer({
      window: options.debounce?.reads?.window ?? 0,
      plan: options.plan?.reads,
      fetch: issueReads('modbus.read', client.readInputRegisters),
    });

    const readerOf = (debouncer: ReadDebouncer): BatchingRegisterReader => ({
      read: debouncer.read,
      readNow: debouncer.readNow,
      readAll: debouncer.readAll,
      readAllNow: debouncer.readAllNow,
    });

    const flush = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkIn(
          Effect.andThen(writes.flush, Effect.andThen(holding.flush, inputs.flush)),
          scope,
        );
        yield* restore(Fiber.await(fiber));
      }),
    );

    // The finalizer goes in the *caller's* scope, not the scope this client was
    // built in. The client outlives the caller — it belongs to the transport —
    // so attaching here is what puts the action ahead of the teardown.
    const onShutdown = (action: Effect.Effect<void, ModbusError>) =>
      Effect.addFinalizer(() =>
        action.pipe(
          Effect.tapError((error) =>
            Effect.logError(`Shutdown action for unit ${unitId} failed: ${error.message}`),
          ),
          Effect.orDie,
        ),
      );

    return {
      unitId,
      cache,
      write: writes.write,
      writeNow: writes.writeNow,
      writeAll: writes.writeAll,
      writeAllNow: writes.writeAllNow,
      ...readerOf(holding),
      inputs: readerOf(inputs),
      flush,
      onShutdown,
    };
  });

/** What a transport gives the registry so it can build batching clients. */
export interface BatchingRegistryDeps {
  /** The transport's own raw client factory. */
  withClient(
    unitId: number,
    options?: { readonly retry?: ModbusRetryPolicy },
  ): Effect.Effect<EffectModbusClient, ModbusError>;
  /** The link state the shared cache watches. */
  readonly connectionState: SubscriptionRef.SubscriptionRef<ConnectionState>;
  /** The transport's own scope, which the clients and the watcher live in. */
  readonly scope: Scope.Scope;
}

/** The batching half of a transport's API. */
export interface BatchingRegistry {
  /** Declares the batching client for a unit. Fails if the unit already has one. */
  withBatchingClient(
    unitId: number,
    options?: BatchingClientOptions & { readonly retry?: ModbusRetryPolicy },
  ): Effect.Effect<BatchingModbusClient, ModbusError>;
  /** The batching client for a unit. Fails if nothing has declared one. */
  batchingClient(unitId: number): Effect.Effect<BatchingModbusClient, ModbusError>;
  /** Disables raw holding-register writes once a batching client exists for the unit. */
  guardRawWrites(unitId: number, operations: ModbusOperations): ModbusOperations;
}

/**
 * Builds the per-unit batching clients of one transport, and the cache they
 * share.
 *
 * Declaring a client and reaching for one are separate operations, because every
 * option a client takes is a fact about the unit rather than about a caller: two
 * batching clients on one unit hold two batches and coalesce neither, two caches
 * on one unit hold two beliefs about one device, and one batch has one window. A
 * per-caller configuration could only ever be correct when every caller passed
 * the same value, so it is declared once instead of compared at every call.
 *
 * `withBatchingClient` declares. `batchingClient` looks up, and waits for a
 * declaration already under way rather than depending on which fiber ran first.
 *
 * @param deps - The transport's raw client factory, link state, and scope.
 * @returns The batching methods, ready to spread onto a transport API.
 */
export const makeBatchingRegistry = (deps: BatchingRegistryDeps): BatchingRegistry => {
  const clientScope = Scope.forkUnsafe(deps.scope);
  const clients = new Map<number, BatchingModbusClient>();
  const creating = new Map<number, Deferred.Deferred<BatchingModbusClient, ModbusError>>();
  const writeLocks = new Map<number, Semaphore.Semaphore>();
  let shared: RegisterCache | undefined;
  let closed = false;
  let watchingScope = false;

  const scopeClosedError = () => {
    const message = 'The batching registry scope has been closed';
    return new ModbusNotConnectedError({ cause: new Error(message), message });
  };

  const watchScope = Effect.suspend(() => {
    if (watchingScope) return Effect.void;
    watchingScope = true;
    return Scope.addFinalizer(
      clientScope,
      Effect.gen(function* () {
        closed = true;
        const pending = Array.from(creating.values());
        creating.clear();
        yield* Effect.forEach(pending, (deferred) => Deferred.fail(deferred, scopeClosedError()), {
          discard: true,
        });
      }),
    );
  });

  /**
   * The cache every batching client on this transport shares, created on first
   * use so a transport nobody batches on carries neither the cache nor the fiber
   * that watches the link.
   *
   * The watcher is why the cache belongs to the transport. A write cache is a
   * belief about what a device holds, and a device that power-cycles comes back
   * holding something else. A failed transaction is one sign of that, and the
   * flush already acts on it. Losing the link is the stronger sign, and only
   * code next to `connectionState` can see it.
   */
  const sharedCache = Effect.fnUntraced(function* () {
    if (shared) return shared;
    const cache = makeRegisterCache();
    shared = cache;
    yield* Effect.forkIn(
      Stream.runForEach(SubscriptionRef.changes(deps.connectionState), (state) =>
        Effect.sync(() => {
          if (!ConnectionState.$is('Connected')(state)) cache.invalidate();
        }),
      ),
      clientScope,
    );
    return cache;
  });

  const writeLockFor = (unitId: number) => {
    const existing = writeLocks.get(unitId);
    if (existing) return existing;
    const created = Semaphore.makeUnsafe(1);
    writeLocks.set(unitId, created);
    return created;
  };

  const guardRawWrites = (unitId: number, operations: ModbusOperations): ModbusOperations => {
    const write = <A>(operation: () => Effect.Effect<A, ModbusError>) =>
      writeLockFor(unitId).withPermits(1)(
        Effect.suspend(() => {
          if (!clients.has(unitId) && !creating.has(unitId)) return operation();
          const message =
            `Raw register writes are disabled for unit ${unitId} because a batching client exists. ` +
            `Use the batching client for every holding-register write on that unit.`;
          return Effect.fail(
            new ModbusInvalidArgumentError({ cause: new Error(message), message }),
          );
        }),
      );

    return {
      ...operations,
      writeSingleRegister: (options) => write(() => operations.writeSingleRegister(options)),
      writeMultipleRegisters: (options) => write(() => operations.writeMultipleRegisters(options)),
      readWriteMultipleRegisters: (options) =>
        write(() => operations.readWriteMultipleRegisters(options)),
    };
  };

  const alreadyDeclaredError = (unitId: number) => {
    const message =
      `Unit ${unitId} already has a batching client. One unit has one batch, so a unit ` +
      `is declared once. Use batchingClient(${unitId}) to reach the existing one.`;
    return new ModbusInvalidArgumentError({ cause: new Error(message), message });
  };

  const notDeclaredError = (unitId: number) => {
    const message =
      `No batching client is declared for unit ${unitId}. Declare one with ` +
      `withBatchingClient(${unitId}) before reaching for it.`;
    return new ModbusInvalidArgumentError({ cause: new Error(message), message });
  };

  return {
    withBatchingClient: (
      unitId: number,
      options?: BatchingClientOptions & { readonly retry?: ModbusRetryPolicy },
    ): Effect.Effect<BatchingModbusClient, ModbusError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* watchScope;
          if (closed) return yield* scopeClosedError();

          const injected = typeof options?.cache === 'object' ? options.cache : undefined;
          const fresh = yield* Deferred.make<BatchingModbusClient, ModbusError>();
          const election = yield* Effect.sync(() => {
            if (closed) return { _tag: 'Closed' as const } as const;
            // Declaring is not acquiring, so there is nothing to compare. A unit
            // that already has a client — or has one on the way — is declared,
            // and a second declaration is a mistake whatever it asks for.
            if (clients.has(unitId) || creating.has(unitId)) {
              return { _tag: 'Declared' as const } as const;
            }
            creating.set(unitId, fresh);
            return { _tag: 'Leader' as const } as const;
          });

          if (election._tag === 'Closed') return yield* scopeClosedError();
          if (election._tag === 'Declared') return yield* alreadyDeclaredError(unitId);

          const build = writeLockFor(unitId).withPermits(1)(
            Effect.gen(function* () {
              const raw = yield* deps.withClient(unitId, { retry: options?.retry });
              let cache: RegisterCache | undefined;
              if (options?.cache !== false) cache = injected ?? (yield* sharedCache());

              // Bound to the transport's scope, not the caller's: the client is
              // shared by every caller on this unit, so no one may end it.
              const client = yield* Scope.provide(
                makeBatchingClient({
                  unitId,
                  client: raw,
                  cache,
                  debounce: options?.debounce,
                  plan: options?.plan,
                }),
                clientScope,
              );
              return { cache, client };
            }),
          );

          yield* Effect.forkIn(
            Effect.uninterruptible(
              Effect.flatMap(Effect.exit(Effect.interruptible(build)), (exit) =>
                Effect.andThen(
                  Effect.sync(() => {
                    creating.delete(unitId);
                    if (Exit.isSuccess(exit)) clients.set(unitId, exit.value.client);
                  }),
                  Deferred.done(
                    fresh,
                    Exit.hasInterrupts(exit)
                      ? Exit.fail(scopeClosedError())
                      : Exit.map(exit, ({ client }) => client),
                  ),
                ),
              ),
            ),
            clientScope,
          );
          return yield* restore(Deferred.await(fresh));
        }),
      ),

    batchingClient: (unitId: number): Effect.Effect<BatchingModbusClient, ModbusError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (closed) return yield* scopeClosedError();
          const existing = clients.get(unitId);
          if (existing) return existing;
          // A declaration already under way is still a declaration. Waiting for
          // it keeps a lookup from depending on which fiber started first.
          const pending = creating.get(unitId);
          if (pending) return yield* restore(Deferred.await(pending));
          return yield* notDeclaredError(unitId);
        }),
      ),

    guardRawWrites,
  };
};
