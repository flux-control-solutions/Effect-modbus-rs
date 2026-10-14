/**
 * @fileoverview Pure functions that plan coil reads and writes as Modbus transactions.
 * They do not perform I/O or return Effects.
 *
 * @module
 */

import {
  assertAddress,
  assertMaxGap,
  assertPositiveInteger,
  assertTransactionLimit,
  buildReadPlan,
  type ReadPlan,
} from './register-plan';

/**
 * Coils one FC15 (write multiple coils) transaction can carry.
 *
 * The request PDU holds at most 246 bytes of packed bits. The specification sets
 * the limit at 1968 (0x7B0) coils. A device can allow fewer.
 */
export const MODBUS_MAX_WRITE_COILS = 1968;

/**
 * Coils one FC01 (read coils) transaction can return.
 *
 * The specification sets the limit at 2000 (0x7D0) coils. A device can allow fewer.
 */
export const MODBUS_MAX_READ_COILS = 2000;

/** One requested coil write, before planning. */
export interface CoilWrite {
  /** Coil address. */
  readonly address: number;
  /** `true` for ON, `false` for OFF. */
  readonly value: boolean;
}

/** A planned FC05 (write single coil) transaction. */
export interface SingleCoilWriteStep {
  readonly kind: 'single';
  /** Coil address. */
  readonly address: number;
  /** `true` for ON, `false` for OFF. */
  readonly value: boolean;
}

/** A planned FC15 (write multiple coils) transaction. */
export interface MultipleCoilWriteStep {
  readonly kind: 'multiple';
  /** Address of the first coil in the span. */
  readonly address: number;
  /**
   * Values for the span, in address order.
   *
   * `undefined` marks a gap: a coil that no write asked for. FC15 writes every
   * coil in its span, so the caller must fill each gap with the state the coil
   * already holds before it issues the step.
   */
  readonly values: ReadonlyArray<boolean | undefined>;
}

/** One transaction in a coil write plan. */
export type CoilWritePlanStep = SingleCoilWriteStep | MultipleCoilWriteStep;

/** Options for {@link planCoilWrites}. */
export interface PlanCoilWritesOptions {
  /**
   * Coils one FC15 transaction may carry, gaps included. A longer span is split.
   *
   * @defaultValue {@link MODBUS_MAX_WRITE_COILS} (1968)
   */
  readonly maxCoilsPerWrite?: number;
  /**
   * Fewest requested coils that become one FC15 step. A span with fewer
   * requested coils becomes one FC05 step per coil.
   *
   * @defaultValue 2
   */
  readonly minRunLength?: number;
  /**
   * Unrequested coils the planner may include to join two runs into one FC15.
   *
   * At the default of `0`, a span holds only contiguous requested coils.
   *
   * CAUTION: FC15 writes every coil in its span. The caller must fill each gap
   * with the state the coil holds. If device logic or another client changes a
   * gap coil after that state is known, the FC15 step writes the old state back.
   * Raise this only for coils that only this client writes.
   *
   * @defaultValue 0
   */
  readonly maxGap?: number;
}

/** Options for {@link planCoilReads}. */
export interface PlanCoilReadsOptions {
  /**
   * Coils one FC01 transaction may return.
   *
   * @defaultValue {@link MODBUS_MAX_READ_COILS} (2000)
   */
  readonly maxCoilsPerRead?: number;
  /**
   * Unrequested coils the planner may read to join two spans into one.
   *
   * CAUTION: A gap can cover an address the device does not implement. Such a
   * span fails with `ILLEGAL_DATA_ADDRESS` and takes every address in it down.
   *
   * @defaultValue 0
   */
  readonly maxGap?: number;
}

/**
 * Rejects a coil value that is not a boolean.
 *
 * The type says boolean, but a JavaScript caller can still pass a number. A
 * number in an FC15 span would be encoded as a wrong coil state.
 */
export const assertCoilValue = (value: boolean): void => {
  if (value !== true && value !== false) {
    throw new RangeError(`coil value must be a boolean, got ${String(value)}`);
  }
};

/**
 * Packs coil writes into the fewest transactions that cover them.
 *
 * The planner sorts by address and groups coils into spans. A span grows while
 * the next coil is within `maxGap` unrequested coils and the span stays within
 * `maxCoilsPerWrite`. A span with at least `minRunLength` requested coils
 * becomes one FC15 step. Other coils become one FC05 step each.
 *
 * When the same address appears more than once, the last write wins.
 *
 * @param writes - Requested writes, in any order.
 * @param options - Device limits, the FC05/FC15 preference, and the gap tolerance.
 * @returns Transactions to issue, in ascending address order.
 * @throws RangeError - An address, a value, or an option is out of range.
 *
 * @example
 * planCoilWrites(
 *   [
 *     { address: 10, value: true },
 *     { address: 12, value: false },
 *     { address: 11, value: true },
 *     { address: 40, value: true },
 *   ],
 * );
 * // [
 * //   { kind: 'multiple', address: 10, values: [true, true, false] },
 * //   { kind: 'single', address: 40, value: true },
 * // ]
 */
export const planCoilWrites = (
  writes: ReadonlyArray<CoilWrite>,
  options: PlanCoilWritesOptions = {},
): ReadonlyArray<CoilWritePlanStep> => {
  const maxCoilsPerWrite = options.maxCoilsPerWrite ?? MODBUS_MAX_WRITE_COILS;
  const minRunLength = options.minRunLength ?? 2;
  const maxGap = options.maxGap ?? 0;
  assertTransactionLimit('maxCoilsPerWrite', maxCoilsPerWrite, MODBUS_MAX_WRITE_COILS);
  assertPositiveInteger('minRunLength', minRunLength);
  assertMaxGap(maxGap);

  const latest = new Map<number, boolean>();
  for (const write of writes) {
    assertAddress(write.address);
    assertCoilValue(write.value);
    latest.set(write.address, write.value);
  }
  if (latest.size === 0) return [];

  const addresses = Array.from(latest.keys()).sort((left, right) => left - right);
  const steps: CoilWritePlanStep[] = [];

  /** Emits the coils held in `addresses[start, end)` as one step or as many. */
  const emitSpan = (start: number, end: number): void => {
    if (end - start >= minRunLength) {
      const first = addresses[start]!;
      const values = Array.from({ length: addresses[end - 1]! - first + 1 }, (_, offset) =>
        latest.get(first + offset),
      );
      steps.push({ kind: 'multiple', address: first, values });
      return;
    }
    for (let index = start; index < end; index += 1) {
      const address = addresses[index]!;
      steps.push({ kind: 'single', address, value: latest.get(address)! });
    }
  };

  let spanStart = 0;
  for (let index = 1; index <= addresses.length; index += 1) {
    const endsHere =
      index === addresses.length ||
      addresses[index]! - addresses[index - 1]! - 1 > maxGap ||
      addresses[index]! - addresses[spanStart]! + 1 > maxCoilsPerWrite;
    if (endsHere) {
      emitSpan(spanStart, index);
      spanStart = index;
    }
  }

  return steps;
};

/**
 * Merges coil addresses into the fewest FC01 transactions that cover them.
 *
 * This is {@link planReads} with the coil transaction limit.
 *
 * @param addresses - Requested addresses, in any order, duplicates allowed.
 * @param options - Device limits and the gap tolerance.
 * @returns The spans to read and the index back into their responses.
 * @throws RangeError - An address or an option is out of range.
 */
export const planCoilReads = (
  addresses: ReadonlyArray<number>,
  options: PlanCoilReadsOptions = {},
): ReadPlan => {
  const maxCoilsPerRead = options.maxCoilsPerRead ?? MODBUS_MAX_READ_COILS;
  assertTransactionLimit('maxCoilsPerRead', maxCoilsPerRead, MODBUS_MAX_READ_COILS);
  return buildReadPlan(addresses, maxCoilsPerRead, options.maxGap ?? 0);
};
