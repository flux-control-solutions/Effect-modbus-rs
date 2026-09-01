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

import { Duration, Effect, Scope, Stream, SubscriptionRef } from 'effect';

import { ConnectionState } from './connection';
import { ModbusInvalidArgumentError, type ModbusError } from './errors';
import type { EffectModbusClient } from './modbus-client';
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
     */
    const issueWrites = (batch: ReadonlyArray<DebouncedWrite>) =>
      Effect.suspend(() => {
        const proposed = batch.map((entry) => ({ address: entry.address, value: entry.value }));
        const filtered = cache?.filter(unitId, proposed);
        const pending = filtered?.pending ?? proposed;
        const suppressed = filtered?.suppressed.length ?? 0;
        if (pending.length === 0) return Effect.void;

        const steps = planWrites(pending, options.plan?.writes);

        return Effect.forEach(
          steps,
          (step) =>
            step.kind === 'single'
              ? Effect.tap(
                  client.writeSingleRegister({ address: step.address, value: step.value }),
                  () => Effect.sync(() => cache?.observe(unitId, step.address, step.value)),
                )
              : Effect.tap(
                  client.writeMultipleRegisters({ address: step.address, values: step.values }),
                  () =>
                    Effect.sync(() =>
                      step.values.forEach((value, index) =>
                        cache?.observe(unitId, step.address + index, value),
                      ),
                    ),
                ),
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
              // happened wins a key collision.
              ...mergeSpanAttributes(batch.map((entry) => entry.attributes)),
              ...own(pending.length, steps.length, suppressed),
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

    return {
      unitId,
      cache,
      write: writes.write,
      writeNow: writes.writeNow,
      writeAll: writes.writeAll,
      writeAllNow: writes.writeAllNow,
      ...readerOf(holding),
      inputs: readerOf(inputs),
      flush: Effect.andThen(writes.flush, Effect.andThen(holding.flush, inputs.flush)),
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
  /** Units a client has been built for. */
  touchedUnits(): Iterable<number>;
  /** The transport's own scope, which the clients and the watcher live in. */
  readonly scope: Scope.Scope;
}

/** The batching half of a transport's API. */
export interface BatchingRegistry {
  withBatchingClient(
    unitId: number,
    options?: BatchingClientOptions & { readonly retry?: ModbusRetryPolicy },
  ): Effect.Effect<BatchingModbusClient, ModbusError>;
  onShutdownPerUnit(
    action: (unitId: number) => Effect.Effect<void, ModbusError>,
  ): Effect.Effect<void, never, Scope.Scope>;
}

/**
 * Builds the per-unit batching clients of one transport, and the cache they
 * share.
 *
 * A client is cached per unit, because that is what makes it work: two batching
 * clients on one unit hold two batches and coalesce neither, and two caches on
 * one unit hold two beliefs about one device.
 *
 * @param deps - The transport's raw client factory, link state, and scope.
 * @returns The batching methods, ready to spread onto a transport API.
 */
export const makeBatchingRegistry = (deps: BatchingRegistryDeps): BatchingRegistry => {
  const clients = new Map<
    number,
    {
      readonly key: string;
      readonly cache: RegisterCache | undefined;
      readonly client: BatchingModbusClient;
    }
  >();
  let shared: RegisterCache | undefined;

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
      deps.scope,
    );
    return cache;
  });

  /**
   * A stable description of a configuration, used to catch a second call for one
   * unit that asks for something else.
   */
  const keyOf = (options?: BatchingClientOptions & { readonly retry?: ModbusRetryPolicy }) =>
    JSON.stringify({
      cache: typeof options?.cache === 'object' ? 'injected' : (options?.cache ?? true),
      debounce: options?.debounce ?? null,
      plan: options?.plan ?? null,
      retry: options?.retry ? 'client' : 'transport',
    });

  return {
    withBatchingClient: (
      unitId: number,
      options?: BatchingClientOptions & { readonly retry?: ModbusRetryPolicy },
    ): Effect.Effect<BatchingModbusClient, ModbusError> =>
      Effect.gen(function* () {
        const key = keyOf(options);
        const injected = typeof options?.cache === 'object' ? options.cache : undefined;
        const existing = clients.get(unitId);
        if (existing) {
          if (existing.key !== key || (injected !== undefined && existing.cache !== injected)) {
            const message =
              `A batching client for unit ${unitId} already exists with a different configuration. ` +
              `One unit has one batch, so the first call fixes the options.`;
            return yield* new ModbusInvalidArgumentError({ cause: new Error(message), message });
          }
          return existing.client;
        }

        const raw = yield* deps.withClient(unitId, { retry: options?.retry });
        let cache: RegisterCache | undefined;
        if (options?.cache !== false) cache = injected ?? (yield* sharedCache());

        // Bound to the transport's scope, not the caller's: the client is shared
        // by every caller on this unit, so no one of them may end it.
        const client = yield* Scope.provide(
          makeBatchingClient({
            unitId,
            client: raw,
            cache,
            debounce: options?.debounce,
            plan: options?.plan,
          }),
          deps.scope,
        );
        clients.set(unitId, { key, cache, client });
        return client;
      }),

    onShutdownPerUnit: (action) =>
      Effect.addFinalizer(() =>
        Effect.forEach(
          Array.from(deps.touchedUnits()),
          (unitId) =>
            action(unitId).pipe(
              Effect.catch((error) =>
                Effect.logWarning(`Shutdown action for unit ${unitId} failed: ${error.message}`),
              ),
            ),
          { discard: true },
        ),
      ),
  };
};
