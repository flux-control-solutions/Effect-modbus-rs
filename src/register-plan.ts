/**
 * @fileoverview Pure planners that turn a set of register addresses into the
 * smallest set of Modbus transactions that covers them.
 *
 * A caller that derives each register independently — one fiber per output, one
 * accessor per parameter — naturally produces one transaction per register. On a
 * half-duplex multi-drop bus that is the dominant cost: every transaction is a
 * turnaround, and the registers a caller wants are usually neighbours.
 *
 * These functions hold no state, run no I/O, and return no `Effect`. They are the
 * bottom layer of the batching stack and are usable on their own — a caller that
 * already owns its scheduling can plan the transactions here and issue them with
 * a plain {@link EffectModbusClient}.
 *
 * @module
 */

/**
 * Registers one FC16 (write multiple registers) transaction can carry.
 *
 * The limit follows from the PDU: 253 bytes, less the function code, the starting
 * address, the quantity, and the byte count, leaves 246 bytes of payload.
 *
 * Many devices stop at a lower number than the specification allows. Pass
 * {@link PlanWritesOptions.maxRegistersPerWrite} when the device says so.
 */
export const MODBUS_MAX_WRITE_REGISTERS = 123;

/**
 * Registers one FC03/FC04 (read holding/input registers) transaction can return.
 *
 * As with {@link MODBUS_MAX_WRITE_REGISTERS}, a device may allow fewer. Pass
 * {@link PlanReadsOptions.maxRegistersPerRead} when it does.
 */
export const MODBUS_MAX_READ_REGISTERS = 125;

/** Widest value a 16-bit register holds, read as unsigned. */
const MAX_REGISTER_VALUE = 0xffff;

/** Highest address encodable in a Modbus request PDU. */
const MAX_REGISTER_ADDRESS = 0xffff;

/** Narrowest value a 16-bit register holds, read as two's-complement signed. */
const MIN_REGISTER_VALUE = -0x8000;

/** One requested register write, before planning. */
export interface RegisterWrite {
  /** Register address. */
  readonly address: number;
  /**
   * Value to write.
   *
   * Accepted as unsigned (`0` to `65535`) or as two's-complement signed
   * (`-32768` to `-1`). A signed value is encoded to its unsigned form, which is
   * what the wire carries either way.
   */
  readonly value: number;
}

/** A planned FC06 (write single register) transaction. */
export interface SingleWriteStep {
  readonly kind: 'single';
  /** Register address. */
  readonly address: number;
  /** Value to write, encoded unsigned. */
  readonly value: number;
}

/** A planned FC16 (write multiple registers) transaction. */
export interface MultipleWriteStep {
  readonly kind: 'multiple';
  /** Address of the first register in the run. */
  readonly address: number;
  /** Values for the run, in address order. */
  readonly values: Uint16Array;
}

/**
 * One transaction in a write plan.
 *
 * Each step maps onto exactly one client call — `single` onto
 * `writeSingleRegister`, `multiple` onto `writeMultipleRegisters` — so a caller
 * can drive a plan without re-deriving the function code.
 */
export type WritePlanStep = SingleWriteStep | MultipleWriteStep;

/** Options for {@link planWrites}. */
export interface PlanWritesOptions {
  /**
   * Registers one FC16 transaction may carry. A longer run is split into
   * consecutive steps of at most this many registers.
   *
   * @defaultValue {@link MODBUS_MAX_WRITE_REGISTERS} (123)
   */
  readonly maxRegistersPerWrite?: number;
  /**
   * Shortest run that becomes one FC16 step. A run shorter than this becomes one
   * FC06 step per register.
   *
   * Some devices answer a repeated FC06 faster than a short FC16, so the trade is
   * device-specific. Raise this to prefer FC06; set it to `1` to send every run
   * as FC16.
   *
   * @defaultValue 2
   */
  readonly minRunLength?: number;
}

/** Options for {@link planReads}. */
export interface PlanReadsOptions {
  /**
   * Registers one read transaction may return. A span never grows past this.
   *
   * @defaultValue {@link MODBUS_MAX_READ_REGISTERS} (125)
   */
  readonly maxRegistersPerRead?: number;
  /**
   * Unrequested registers the planner may read to join two spans into one.
   *
   * At the default of `0`, a span holds only contiguous requested addresses.
   * Raising it trades reading registers nobody asked for against a lower
   * transaction count.
   *
   * CAUTION: A gap can cover an address the device does not implement. Such a
   * span fails with `ILLEGAL_DATA_ADDRESS` and takes every address in it down,
   * including the ones that would have answered. Raise this only against a
   * register map that says the gap is readable.
   *
   * @defaultValue 0
   */
  readonly maxGap?: number;
}

/** One planned read transaction. */
export interface ReadSpan {
  /** Address of the first register in the span. */
  readonly address: number;
  /** Registers to read, starting at {@link address}. */
  readonly quantity: number;
}

/** Where one address sits in the responses to a {@link ReadPlan}. */
export interface ReadLocation {
  /** Index into {@link ReadPlan.spans}, and into the responses to them. */
  readonly span: number;
  /** Index of the register within that span's response. */
  readonly offset: number;
}

/** The result of {@link planReads}. */
export interface ReadPlan {
  /** Transactions to issue, in ascending address order. */
  readonly spans: ReadonlyArray<ReadSpan>;
  /**
   * Maps an address back to its position in the responses.
   *
   * Answers for every address a span covers, which includes the addresses a
   * `maxGap` merge pulled in. Returns `undefined` for an address no span covers.
   */
  locate(address: number): ReadLocation | undefined;
}

/** Rejects an option that cannot describe a transaction. */
const assertPositiveInteger = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be an integer of 1 or more, got ${value}`);
  }
};

/** Rejects a device limit outside the range the protocol can encode. */
const assertTransactionLimit = (name: string, value: number, maximum: number): void => {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}, got ${value}`);
  }
};

/** Rejects an address that cannot name a register. */
const assertAddress = (address: number): void => {
  if (!Number.isInteger(address) || address < 0 || address > MAX_REGISTER_ADDRESS) {
    throw new RangeError(
      `address must be an integer from 0 to ${MAX_REGISTER_ADDRESS}, got ${address}`,
    );
  }
};

/**
 * Encodes a value to its unsigned 16-bit form, rejecting one that does not fit.
 *
 * Both step kinds carry the encoded value, so a plan writes the same bits whether
 * the planner grouped an address into an FC06 or an FC16. Leaving the FC06 path
 * unencoded would let `Uint16Array` truncate one path and not the other.
 *
 * Anything that compares a proposed value against a value already on the device
 * must encode first, for the same reason: `-1` and `65535` are the same register
 * contents, and a comparison that says otherwise rewrites the register forever.
 *
 * @param value - Unsigned (`0` to `65535`) or two's-complement signed (`-32768` to `-1`).
 * @returns The value as an unsigned 16-bit number.
 * @throws RangeError - The value is not an integer, or does not fit 16 bits.
 */
export const encodeRegisterValue = (value: number): number => {
  if (!Number.isInteger(value) || value < MIN_REGISTER_VALUE || value > MAX_REGISTER_VALUE) {
    throw new RangeError(
      `value must be an integer from ${MIN_REGISTER_VALUE} to ${MAX_REGISTER_VALUE}, got ${value}`,
    );
  }
  return value & MAX_REGISTER_VALUE;
};

/**
 * Packs register writes into the fewest transactions that cover them.
 *
 * The planner sorts by address, groups contiguous addresses into runs, splits
 * each run at `maxRegistersPerWrite`, and emits FC16 for a run of at least
 * `minRunLength` registers or FC06 for anything shorter.
 *
 * When the same address appears more than once, the last write wins. This
 * matches a caller that supersedes a pending value rather than queueing behind
 * it, and it is the only rule under which the plan is order-independent for
 * distinct addresses.
 *
 * @param writes - Requested writes, in any order.
 * @param options - Device limits and the FC06/FC16 preference.
 * @returns Transactions to issue, in ascending address order.
 * @throws RangeError - An address, a value, or an option is out of range.
 *
 * @example
 * // 2000..2003 contiguous, 2010 alone
 * planWrites([
 *   { address: 2003, value: 40 },
 *   { address: 2000, value: 10 },
 *   { address: 2010, value: 99 },
 *   { address: 2001, value: 20 },
 *   { address: 2002, value: 30 },
 * ]);
 * // [
 * //   { kind: 'multiple', address: 2000, values: Uint16Array [10, 20, 30, 40] },
 * //   { kind: 'single', address: 2010, value: 99 },
 * // ]
 */
export const planWrites = (
  writes: ReadonlyArray<RegisterWrite>,
  options: PlanWritesOptions = {},
): ReadonlyArray<WritePlanStep> => {
  const maxRegistersPerWrite = options.maxRegistersPerWrite ?? MODBUS_MAX_WRITE_REGISTERS;
  const minRunLength = options.minRunLength ?? 2;
  assertTransactionLimit('maxRegistersPerWrite', maxRegistersPerWrite, MODBUS_MAX_WRITE_REGISTERS);
  assertPositiveInteger('minRunLength', minRunLength);

  const latest = new Map<number, number>();
  for (const write of writes) {
    assertAddress(write.address);
    latest.set(write.address, encodeRegisterValue(write.value));
  }
  if (latest.size === 0) return [];

  const addresses = Array.from(latest.keys()).sort((left, right) => left - right);
  const steps: WritePlanStep[] = [];

  /** Emits the run held in `addresses[start, end)` as one step or as many. */
  const emitRun = (start: number, end: number): void => {
    const length = end - start;
    if (length >= minRunLength) {
      const values = new Uint16Array(length);
      for (let index = 0; index < length; index += 1) {
        values[index] = latest.get(addresses[start + index]!)!;
      }
      steps.push({ kind: 'multiple', address: addresses[start]!, values });
      return;
    }
    for (let index = start; index < end; index += 1) {
      const address = addresses[index]!;
      steps.push({ kind: 'single', address, value: latest.get(address)! });
    }
  };

  let runStart = 0;
  for (let index = 1; index <= addresses.length; index += 1) {
    const endsHere =
      index === addresses.length ||
      addresses[index]! !== addresses[index - 1]! + 1 ||
      index - runStart >= maxRegistersPerWrite;
    if (endsHere) {
      emitRun(runStart, index);
      runStart = index;
    }
  }

  return steps;
};

/**
 * Merges register addresses into the fewest read transactions that cover them.
 *
 * The planner sorts and deduplicates the addresses, then extends a span while the
 * next address is within `maxGap` unrequested registers of the last one and the
 * span stays within `maxRegistersPerRead`.
 *
 * {@link ReadPlan.locate} maps each address back to its position, so a caller
 * issues the spans, keeps the responses in order, and reads each value out
 * without tracking the grouping itself.
 *
 * @param addresses - Requested addresses, in any order, duplicates allowed.
 * @param options - Device limits and the gap tolerance.
 * @returns The spans to read and the index back into their responses.
 * @throws RangeError - An address or an option is out of range.
 *
 * @example
 * const plan = planReads([0x0000, 0x0001, 0x0002, 0x0020, 0x0021]);
 * plan.spans;            // [{ address: 0, quantity: 3 }, { address: 32, quantity: 2 }]
 * plan.locate(0x0021);   // { span: 1, offset: 1 }
 * plan.locate(0x0010);   // undefined
 */
export const planReads = (
  addresses: ReadonlyArray<number>,
  options: PlanReadsOptions = {},
): ReadPlan => {
  const maxRegistersPerRead = options.maxRegistersPerRead ?? MODBUS_MAX_READ_REGISTERS;
  const maxGap = options.maxGap ?? 0;
  assertTransactionLimit('maxRegistersPerRead', maxRegistersPerRead, MODBUS_MAX_READ_REGISTERS);
  if (!Number.isInteger(maxGap) || maxGap < 0) {
    throw new RangeError(`maxGap must be a non-negative integer, got ${maxGap}`);
  }

  for (const address of addresses) assertAddress(address);
  const sorted = Array.from(new Set(addresses)).sort((left, right) => left - right);

  const spans: ReadSpan[] = [];
  if (sorted.length > 0) {
    let start = sorted[0]!;
    let end = sorted[0]!;
    for (let index = 1; index < sorted.length; index += 1) {
      const address = sorted[index]!;
      const fitsGap = address - end - 1 <= maxGap;
      const fitsSpan = address - start + 1 <= maxRegistersPerRead;
      if (fitsGap && fitsSpan) {
        end = address;
        continue;
      }
      spans.push({ address: start, quantity: end - start + 1 });
      start = address;
      end = address;
    }
    spans.push({ address: start, quantity: end - start + 1 });
  }

  /** Spans are sorted and never overlap, so a bisection finds the covering one. */
  const locate = (address: number): ReadLocation | undefined => {
    if (!Number.isInteger(address) || address < 0 || address > MAX_REGISTER_ADDRESS) {
      return undefined;
    }
    let low = 0;
    let high = spans.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const span = spans[middle]!;
      if (address < span.address) high = middle - 1;
      else if (address >= span.address + span.quantity) low = middle + 1;
      else return { span: middle, offset: address - span.address };
    }
    return undefined;
  };

  return { spans, locate };
};
