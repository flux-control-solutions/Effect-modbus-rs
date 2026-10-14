/**
 * @fileoverview Batching for coils: planned FC05/FC15 writes, a coil cache, and planned FC01 reads.
 *
 * @module
 */

import { Effect, type Scope } from 'effect';
import type { CoilState } from 'modbus-rs';

import type { BatchingDebounceOptions } from './batching-client';
import type { CoilCache } from './coil-cache';
import {
  assertCoilValue,
  MODBUS_MAX_WRITE_COILS,
  planCoilReads,
  planCoilWrites,
  type CoilWrite,
  type CoilWritePlanStep,
  type MultipleCoilWriteStep,
  type PlanCoilReadsOptions,
  type PlanCoilWritesOptions,
} from './coil-plan';
import { ModbusInvalidArgumentError, ModbusTransportError, type ModbusError } from './errors';
import type { EffectModbusClient } from './modbus-client';
import { createReadDebouncer } from './read-debouncer';
import { assertAddress, type ReadSpan } from './register-plan';
import { mergeSpanAttributes, type ModbusSpanAttributes } from './span-attributes';
import {
  createWriteDebouncer,
  writeDebouncerTiming,
  type DebouncedWrite,
  type WriteOptions,
} from './write-debouncer';

/** Options for coil batching on one unit. */
export interface BatchingCoilOptions {
  /**
   * The coil cache, which drops a coil write whose state the device already holds.
   *
   * Pass `false` to write every state. Pass a cache to share one with something
   * else. By default, the transport supplies one coil cache for every unit.
   */
  readonly cache?: boolean | CoilCache;
  /** Limits handed to the coil planners. */
  readonly plan?: {
    readonly writes?: PlanCoilWritesOptions;
    readonly reads?: PlanCoilReadsOptions;
  };
}

/**
 * Batched coil operations for one unit.
 *
 * The coil batch is separate from the holding-register batch. Each uses the
 * write and read windows of the client.
 */
export interface BatchingCoilClient {
  /**
   * Holds a coil write for the write window, then issues it with other pending
   * coil writes.
   * @param write - Coil address and state.
   * @param attributes - Optional span attributes for this caller.
   * @param options - Optional per-call options, such as `bypassCache`.
   * @returns Completion after the carrying batch succeeds, or its Modbus error.
   */
  write(
    write: CoilWrite,
    attributes?: ModbusSpanAttributes,
    options?: WriteOptions,
  ): Effect.Effect<void, ModbusError>;
  /** Adds a coil write and flushes pending coil writes immediately. */
  writeNow(
    write: CoilWrite,
    attributes?: ModbusSpanAttributes,
    options?: WriteOptions,
  ): Effect.Effect<void, ModbusError>;
  /** Submits a group of coil writes to the write window as one caller. */
  writeAll(
    writes: ReadonlyArray<CoilWrite>,
    attributes?: ModbusSpanAttributes,
    options?: WriteOptions,
  ): Effect.Effect<void, ModbusError>;
  /** Adds a group of coil writes and flushes pending coil writes immediately. */
  writeAllNow(
    writes: ReadonlyArray<CoilWrite>,
    attributes?: ModbusSpanAttributes,
    options?: WriteOptions,
  ): Effect.Effect<void, ModbusError>;
  /** Collects a coil address for the read window, then returns its state (FC01). */
  read(address: number): Effect.Effect<boolean, ModbusError>;
  /** Adds a coil address and flushes collected coil reads immediately. */
  readNow(address: number): Effect.Effect<boolean, ModbusError>;
  /** Collects a group as one reader and returns states in the requested order. */
  readAll(addresses: ReadonlyArray<number>): Effect.Effect<ReadonlyArray<boolean>, ModbusError>;
  /** Adds a group and flushes collected coil reads immediately. */
  readAllNow(addresses: ReadonlyArray<number>): Effect.Effect<ReadonlyArray<boolean>, ModbusError>;
  /** Issues pending coil writes, then collected coil reads. Never fails. */
  readonly flush: Effect.Effect<void>;
  /** The coil cache this client filters against, or `undefined` when disabled. */
  readonly cache: CoilCache | undefined;
}

/** The wire state of a coil value. `CoilState` is a numeric enum: Off is 0 and On is 1. */
const toCoilState = (value: boolean): CoilState => (value ? 1 : 0);

/** The debouncers carry coil states as the numbers 0 and 1. */
const toDebounced = (write: CoilWrite) => ({ address: write.address, value: write.value ? 1 : 0 });

const toCoilWrite = (entry: DebouncedWrite): CoilWrite => ({
  address: entry.address,
  value: entry.value === 1,
});

const invalidArgument = (cause: unknown) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  return new ModbusInvalidArgumentError({ cause: error, message: error.message });
};

/**
 * Builds the coil batching client for one unit.
 *
 * @param options - Unit, raw client, coil cache, windows, and coil planner limits.
 * @returns The coil client, bound to the current scope.
 */
export const createCoilClient = (options: {
  readonly unitId: number;
  readonly client: EffectModbusClient;
  readonly cache: CoilCache | undefined;
  readonly debounce?: BatchingDebounceOptions;
  readonly plan?: BatchingCoilOptions['plan'];
}): Effect.Effect<BatchingCoilClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { unitId, client, cache } = options;

    /** Gap coils of a step that the cache does not know. */
    const unknownGaps = (step: MultipleCoilWriteStep) =>
      step.values.flatMap((value, offset) =>
        value === undefined && cache?.valueOf(unitId, step.address + offset) === undefined
          ? [offset]
          : [],
      );

    /** Transactions a plan costs, with one FC01 read for each step with unknown gaps. */
    const costOf = (steps: ReadonlyArray<CoilWritePlanStep>) => steps.length + gapReadsOf(steps);

    const gapReadsOf = (steps: ReadonlyArray<CoilWritePlanStep>) =>
      steps.filter((step) => step.kind === 'multiple' && unknownGaps(step).length > 0).length;

    /**
     * Fills the gaps of an FC15 span with the states the coils hold.
     *
     * The cache answers first. One FC01 read covers the gaps it does not know.
     * The cache answers are taken before the read, because an invalidation
     * during the read must not leave a gap without a state.
     */
    const fillGaps = (step: MultipleCoilWriteStep) =>
      Effect.gen(function* () {
        const known = step.values.map(
          (value, offset) => value ?? cache?.valueOf(unitId, step.address + offset),
        );
        const unknown = known.flatMap((value, offset) => (value === undefined ? [offset] : []));
        if (unknown.length === 0) return known.map((value) => value === true);

        const first = unknown[0]!;
        const quantity = unknown[unknown.length - 1]! - first + 1;
        const read = yield* client.readCoils({ address: step.address + first, quantity });
        if (read.length !== quantity) {
          const message =
            `Expected ${quantity} coil(s) at address ${step.address + first}, ` +
            `received ${read.length}`;
          return yield* new ModbusTransportError({ cause: new Error(message), message });
        }
        return known.map((value, offset) => value ?? read[offset - first] === 1);
      });

    /** Issues one step and records each coil it wrote. */
    const issueStep = (step: CoilWritePlanStep) =>
      // Read before the step, so an invalidation during the step wins.
      Effect.suspend(() => {
        const generation = cache?.generationOf(unitId);
        if (step.kind === 'single') {
          return Effect.tap(
            client.writeSingleCoil({ address: step.address, value: toCoilState(step.value) }),
            () => Effect.sync(() => cache?.observe(unitId, step.address, step.value, generation)),
          );
        }
        return Effect.flatMap(fillGaps(step), (values) =>
          Effect.tap(
            client.writeMultipleCoils({ address: step.address, values: values.map(toCoilState) }),
            () =>
              Effect.sync(() =>
                values.forEach((value, offset) =>
                  cache?.observe(unitId, step.address + offset, value, generation),
                ),
              ),
          ),
        );
      });

    /**
     * Issues one batch of coil writes.
     *
     * This follows the register path. Flagged writes skip the cache filter. The
     * filtered plan and the whole plan are compared, and the plan with fewer
     * transactions wins. A gap read counts as a transaction.
     */
    const issueWrites = (batch: ReadonlyArray<DebouncedWrite>) =>
      Effect.gen(function* () {
        const proposed = batch.map(toCoilWrite);
        const selected = yield* Effect.try({
          try: () => {
            const forced = batch.filter((entry) => entry.bypassCache).map(toCoilWrite);
            const checked = cache?.filter(
              unitId,
              batch.filter((entry) => !entry.bypassCache).map(toCoilWrite),
            );
            const pending = checked === undefined ? proposed : [...forced, ...checked.pending];
            const bypassed =
              cache === undefined
                ? 0
                : new Set(forced.map((write) => write.address)).size -
                  cache.filter(unitId, forced).pending.length;
            if (pending.length === 0) return undefined;
            const steps = planCoilWrites(pending, options.plan?.writes);
            if (pending.length === proposed.length) return { steps, written: proposed, bypassed };
            const whole = planCoilWrites(proposed, options.plan?.writes);
            return costOf(whole) < costOf(steps)
              ? { steps: whole, written: proposed, bypassed }
              : { steps, written: pending, bypassed };
          },
          catch: invalidArgument,
        });
        if (selected === undefined) return;
        const { steps, written, bypassed } = selected;
        const carried = new Set(written.map((write) => write.address));

        yield* Effect.forEach(steps, issueStep, { discard: true }).pipe(
          Effect.tapError(() => Effect.sync(() => cache?.invalidate(unitId))),
          Effect.withSpan('modbus.write', {
            kind: 'client',
            attributes: {
              ...mergeSpanAttributes(
                batch
                  .filter((entry) => carried.has(entry.address))
                  .map((entry) => entry.attributes),
              ),
              'modbus.unit_ids': String(unitId),
              'modbus.table': 'coils',
              'modbus.coil_count': written.length,
              'modbus.transaction_count': steps.length,
              'modbus.gap_read_count': gapReadsOf(steps),
              'modbus.suppressed_count': proposed.length - written.length,
              'modbus.bypassed_count': bypassed,
            },
          }),
        );
      });

    const writes = yield* createWriteDebouncer({
      ...writeDebouncerTiming(
        options.debounce?.writes,
        options.plan?.writes?.maxCoilsPerWrite ?? MODBUS_MAX_WRITE_COILS,
      ),
      flush: issueWrites,
    });

    const reads = yield* createReadDebouncer({
      window: options.debounce?.reads?.window ?? 0,
      planSpans: (addresses) => planCoilReads(addresses, options.plan?.reads),
      fetch: (spans: ReadonlyArray<ReadSpan>) =>
        Effect.forEach(spans, (span) =>
          Effect.map(
            client.readCoils({ address: span.address, quantity: span.quantity }),
            (states) => Uint16Array.from(states),
          ),
        ).pipe(
          Effect.withSpan('modbus.read', {
            kind: 'client',
            attributes: {
              'modbus.unit_ids': String(unitId),
              'modbus.table': 'coils',
              'modbus.coil_count': spans.reduce((total, span) => total + span.quantity, 0),
              'modbus.transaction_count': spans.length,
            },
          }),
        ),
    });

    /** Rejects a coil write before it joins a batch, so it cannot fail the batch. */
    const validated = (
      group: ReadonlyArray<CoilWrite>,
      issue: (
        encoded: ReadonlyArray<{ address: number; value: number }>,
      ) => Effect.Effect<void, ModbusError>,
    ) =>
      Effect.flatMap(
        Effect.try({
          try: () =>
            group.map((write) => {
              assertAddress(write.address);
              assertCoilValue(write.value);
              return toDebounced(write);
            }),
          catch: invalidArgument,
        }),
        issue,
      );

    const writeAll: BatchingCoilClient['writeAll'] = (group, attributes, writeOptions) =>
      validated(group, (encoded) => writes.writeAll(encoded, attributes, writeOptions));
    const writeAllNow: BatchingCoilClient['writeAllNow'] = (group, attributes, writeOptions) =>
      validated(group, (encoded) => writes.writeAllNow(encoded, attributes, writeOptions));

    const toStates = (values: ReadonlyArray<number>) => values.map((value) => value === 1);

    return {
      write: (write, attributes, writeOptions) => writeAll([write], attributes, writeOptions),
      writeNow: (write, attributes, writeOptions) => writeAllNow([write], attributes, writeOptions),
      writeAll,
      writeAllNow,
      read: (address) => Effect.map(reads.read(address), (value) => value === 1),
      readNow: (address) => Effect.map(reads.readNow(address), (value) => value === 1),
      readAll: (addresses) => Effect.map(reads.readAll(addresses), toStates),
      readAllNow: (addresses) => Effect.map(reads.readAllNow(addresses), toStates),
      flush: Effect.andThen(writes.flush, reads.flush),
      cache,
    };
  });
