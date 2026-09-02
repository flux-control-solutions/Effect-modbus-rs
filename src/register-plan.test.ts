import { expect, test } from 'bun:test';

import {
  MODBUS_MAX_READ_REGISTERS,
  MODBUS_MAX_WRITE_REGISTERS,
  planReads,
  planWrites,
  type PlanReadsOptions,
  type PlanWritesOptions,
  type RegisterWrite,
  type WritePlanStep,
} from './register-plan';

/**
 * Seeded generator, so a failing property prints a case that reproduces.
 *
 * `mulberry32` is 4 lines and has no dependency; a property library would be a
 * heavier addition than the properties here justify.
 */
const makeRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Draws an integer in `[low, high]`. */
const drawInt = (random: () => number, low: number, high: number) =>
  low + Math.floor(random() * (high - low + 1));

/** Draws addresses that cluster, so runs and gaps both occur. */
const drawAddresses = (random: () => number, count: number): number[] => {
  const addresses: number[] = [];
  let address = drawInt(random, 0, 200);
  for (let index = 0; index < count; index += 1) {
    addresses.push(address);
    address += random() < 0.7 ? 1 : drawInt(random, 2, 12);
  }
  return addresses;
};

/** Every address a step covers, in order. */
const addressesOf = (step: WritePlanStep): number[] =>
  step.kind === 'single'
    ? [step.address]
    : Array.from({ length: step.values.length }, (_, index) => step.address + index);

/** Every address/value pair a plan writes, flattened. */
const pairsOf = (steps: ReadonlyArray<WritePlanStep>): Array<[number, number]> =>
  steps.flatMap((step) =>
    step.kind === 'single'
      ? [[step.address, step.value] as [number, number]]
      : Array.from(
          step.values,
          (value, index) => [step.address + index, value] as [number, number],
        ),
  );

// ---------------------------------------------------------------- planWrites

test('planWrites packs a contiguous run into one FC16 and leaves a lone address on FC06', () => {
  const steps = planWrites([
    { address: 2003, value: 40 },
    { address: 2000, value: 10 },
    { address: 2010, value: 99 },
    { address: 2001, value: 20 },
    { address: 2002, value: 30 },
  ]);

  expect(steps).toEqual([
    { kind: 'multiple', address: 2000, values: new Uint16Array([10, 20, 30, 40]) },
    { kind: 'single', address: 2010, value: 99 },
  ]);
});

test('planWrites returns no steps for no writes', () => {
  expect(planWrites([])).toEqual([]);
});

test('planWrites keeps the last write to a repeated address', () => {
  const steps = planWrites([
    { address: 100, value: 1 },
    { address: 100, value: 2 },
    { address: 100, value: 3 },
  ]);

  expect(steps).toEqual([{ kind: 'single', address: 100, value: 3 }]);
});

test('planWrites splits a run that is one register past the limit', () => {
  const writes = Array.from({ length: MODBUS_MAX_WRITE_REGISTERS + 1 }, (_, index) => ({
    address: index,
    value: index,
  }));

  const steps = planWrites(writes);

  expect(steps).toHaveLength(2);
  expect(steps[0]).toMatchObject({ kind: 'multiple', address: 0 });
  expect((steps[0] as { values: Uint16Array }).values).toHaveLength(MODBUS_MAX_WRITE_REGISTERS);
  // The remainder is a run of one, so `minRunLength` sends it as FC06.
  expect(steps[1]).toEqual({
    kind: 'single',
    address: MODBUS_MAX_WRITE_REGISTERS,
    value: MODBUS_MAX_WRITE_REGISTERS,
  });
});

test('planWrites honours a device limit lower than the specification', () => {
  const writes = Array.from({ length: 10 }, (_, index) => ({ address: index, value: index }));

  const steps = planWrites(writes, { maxRegistersPerWrite: 4 });

  expect(steps.map((step) => addressesOf(step))).toEqual([
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [8, 9],
  ]);
});

test('planWrites sends every run as FC06 when minRunLength is above the longest run', () => {
  const steps = planWrites(
    [
      { address: 0, value: 1 },
      { address: 1, value: 2 },
      { address: 2, value: 3 },
    ],
    { minRunLength: 4 },
  );

  expect(steps).toEqual([
    { kind: 'single', address: 0, value: 1 },
    { kind: 'single', address: 1, value: 2 },
    { kind: 'single', address: 2, value: 3 },
  ]);
});

test('planWrites sends a lone address as FC16 when minRunLength is 1', () => {
  const steps = planWrites([{ address: 7, value: 3 }], { minRunLength: 1 });

  expect(steps).toEqual([{ kind: 'multiple', address: 7, values: new Uint16Array([3]) }]);
});

test('planWrites encodes a signed value to its unsigned form on both paths', () => {
  const single = planWrites([{ address: 0, value: -1 }]);
  const multiple = planWrites([
    { address: 0, value: -1 },
    { address: 1, value: -32768 },
  ]);

  expect(single).toEqual([{ kind: 'single', address: 0, value: 0xffff }]);
  expect(multiple).toEqual([
    { kind: 'multiple', address: 0, values: new Uint16Array([0xffff, 0x8000]) },
  ]);
});

test('planWrites rejects an address or value that cannot describe a register', () => {
  expect(() => planWrites([{ address: -1, value: 0 }])).toThrow(RangeError);
  expect(() => planWrites([{ address: 1.5, value: 0 }])).toThrow(RangeError);
  expect(() => planWrites([{ address: 0x10000, value: 0 }])).toThrow(RangeError);
  expect(() => planWrites([{ address: 0, value: 0x10000 }])).toThrow(RangeError);
  expect(() => planWrites([{ address: 0, value: -32769 }])).toThrow(RangeError);
  expect(() => planWrites([{ address: 0, value: 1.5 }])).toThrow(RangeError);
});

test('planWrites rejects an option that cannot describe a transaction', () => {
  expect(() => planWrites([], { maxRegistersPerWrite: 0 })).toThrow(RangeError);
  expect(() => planWrites([], { maxRegistersPerWrite: MODBUS_MAX_WRITE_REGISTERS + 1 })).toThrow(
    RangeError,
  );
  expect(() => planWrites([], { minRunLength: 0 })).toThrow(RangeError);
});

test('planWrites accepts the protocol address and transaction boundaries', () => {
  expect(planWrites([{ address: 0xffff, value: 1 }])).toEqual([
    { kind: 'single', address: 0xffff, value: 1 },
  ]);
  expect(planWrites([], { maxRegistersPerWrite: MODBUS_MAX_WRITE_REGISTERS })).toEqual([]);
});

test('planWrites holds its invariants over generated cases', () => {
  for (let seed = 0; seed < 300; seed += 1) {
    const random = makeRandom(seed);
    const options: PlanWritesOptions = {
      maxRegistersPerWrite: drawInt(random, 1, 8),
      minRunLength: drawInt(random, 1, 4),
    };
    const writes: RegisterWrite[] = drawAddresses(random, drawInt(random, 0, 30)).map(
      (address) => ({ address, value: drawInt(random, 0, 0xffff) }),
    );

    const steps = planWrites(writes, options);
    const pairs = pairsOf(steps);
    const label = `seed ${seed}`;

    // Every requested address is written exactly once, with the last value.
    const expected = new Map(writes.map((write) => [write.address, write.value]));
    expect(pairs.length, label).toBe(expected.size);
    expect(new Map(pairs), label).toEqual(expected);

    for (const step of steps) {
      const addresses = addressesOf(step);
      // A step never exceeds the device limit.
      expect(addresses.length, label).toBeLessThanOrEqual(options.maxRegistersPerWrite!);
      // A step's addresses are contiguous.
      expect(addresses[addresses.length - 1]! - addresses[0]!, label).toBe(addresses.length - 1);
      // FC16 is used only for a run that earns it.
      if (step.kind === 'multiple') {
        expect(addresses.length, label).toBeGreaterThanOrEqual(options.minRunLength!);
      }
    }

    // Steps ascend and never overlap.
    const flat = steps.flatMap(addressesOf);
    for (let index = 1; index < flat.length; index += 1) {
      expect(flat[index]! > flat[index - 1]!, label).toBe(true);
    }
  }
});

// ----------------------------------------------------------------- planReads

test('planReads merges contiguous addresses and splits at a gap', () => {
  const plan = planReads([0x0000, 0x0001, 0x0002, 0x0020, 0x0021]);

  expect(plan.spans).toEqual([
    { address: 0x0000, quantity: 3 },
    { address: 0x0020, quantity: 2 },
  ]);
  expect(plan.locate(0x0000)).toEqual({ span: 0, offset: 0 });
  expect(plan.locate(0x0002)).toEqual({ span: 0, offset: 2 });
  expect(plan.locate(0x0021)).toEqual({ span: 1, offset: 1 });
  expect(plan.locate(0x0010)).toBeUndefined();
});

test('planReads takes three spans for a parameter group with two gaps', () => {
  // 30 registers, a gap of 2, 2 registers, a gap of 7, then 17 registers.
  const addresses = [
    ...Array.from({ length: 30 }, (_, index) => 0x0000 + index),
    0x0020,
    0x0021,
    ...Array.from({ length: 17 }, (_, index) => 0x0029 + index),
  ];

  expect(planReads(addresses).spans).toEqual([
    { address: 0x0000, quantity: 30 },
    { address: 0x0020, quantity: 2 },
    { address: 0x0029, quantity: 17 },
  ]);
  // One span covers the lot once the planner may read across both gaps.
  expect(planReads(addresses, { maxGap: 7 }).spans).toEqual([{ address: 0x0000, quantity: 58 }]);
});

test('planReads returns no spans for no addresses', () => {
  const plan = planReads([]);

  expect(plan.spans).toEqual([]);
  expect(plan.locate(0)).toBeUndefined();
});

test('planReads deduplicates and sorts its input', () => {
  const plan = planReads([5, 3, 4, 3, 5]);

  expect(plan.spans).toEqual([{ address: 3, quantity: 3 }]);
  expect(plan.locate(5)).toEqual({ span: 0, offset: 2 });
});

test('planReads locates an address a gap merge pulled in', () => {
  const plan = planReads([10, 13], { maxGap: 2 });

  expect(plan.spans).toEqual([{ address: 10, quantity: 4 }]);
  expect(plan.locate(11)).toEqual({ span: 0, offset: 1 });
  expect(plan.locate(14)).toBeUndefined();
});

test('planReads splits a span at the read limit even with no gap', () => {
  const addresses = Array.from({ length: MODBUS_MAX_READ_REGISTERS + 1 }, (_, index) => index);

  expect(planReads(addresses).spans).toEqual([
    { address: 0, quantity: MODBUS_MAX_READ_REGISTERS },
    { address: MODBUS_MAX_READ_REGISTERS, quantity: 1 },
  ]);
});

test('planReads rejects an address or an option that is out of range', () => {
  expect(() => planReads([-1])).toThrow(RangeError);
  expect(() => planReads([1.5])).toThrow(RangeError);
  expect(() => planReads([0x10000])).toThrow(RangeError);
  expect(() => planReads([], { maxRegistersPerRead: 0 })).toThrow(RangeError);
  expect(() => planReads([], { maxRegistersPerRead: MODBUS_MAX_READ_REGISTERS + 1 })).toThrow(
    RangeError,
  );
  expect(() => planReads([], { maxGap: -1 })).toThrow(RangeError);
});

test('planReads accepts the protocol address and transaction boundaries', () => {
  expect(planReads([0xffff]).spans).toEqual([{ address: 0xffff, quantity: 1 }]);
  expect(planReads([], { maxRegistersPerRead: MODBUS_MAX_READ_REGISTERS }).spans).toEqual([]);
});

test('planReads holds its invariants over generated cases', () => {
  for (let seed = 0; seed < 300; seed += 1) {
    const random = makeRandom(seed + 10000);
    const options: PlanReadsOptions = {
      maxRegistersPerRead: drawInt(random, 1, 16),
      maxGap: drawInt(random, 0, 5),
    };
    const addresses = drawAddresses(random, drawInt(random, 0, 30));

    const plan = planReads(addresses, options);
    const label = `seed ${seed}`;

    for (const span of plan.spans) {
      // A span never exceeds the device limit.
      expect(span.quantity, label).toBeLessThanOrEqual(options.maxRegistersPerRead!);
      expect(span.quantity, label).toBeGreaterThanOrEqual(1);
    }

    // Every requested address is covered, and `locate` points at it.
    for (const address of addresses) {
      const location = plan.locate(address);
      expect(location, label).toBeDefined();
      const span = plan.spans[location!.span]!;
      expect(span.address + location!.offset, label).toBe(address);
    }

    // Spans ascend and never overlap.
    for (let index = 1; index < plan.spans.length; index += 1) {
      const previous = plan.spans[index - 1]!;
      const current = plan.spans[index]!;
      expect(current.address > previous.address + previous.quantity - 1, label).toBe(true);
    }

    // A split happened only because the gap or the limit forced it.
    for (let index = 1; index < plan.spans.length; index += 1) {
      const previous = plan.spans[index - 1]!;
      const current = plan.spans[index]!;
      const gap = current.address - (previous.address + previous.quantity);
      const merged = current.address + current.quantity - previous.address;
      expect(gap > options.maxGap! || merged > options.maxRegistersPerRead!, label).toBe(true);
    }
  }
});
