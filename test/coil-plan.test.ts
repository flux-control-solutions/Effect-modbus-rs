import { expect, test } from 'bun:test';

import {
  MODBUS_MAX_WRITE_COILS,
  planCoilReads,
  planCoilWrites,
  type CoilWrite,
} from '../src/coil-plan';

/** Tests coil write packing, gap merging, limits, and coil read spans. */

// The value is not a boolean on purpose. `JSON.parse` returns an untyped value,
// as data from a caller outside the type system does. The test checks the guard.
const notBoolean: boolean = JSON.parse('1');

const on = (address: number): CoilWrite => ({ address, value: true });
const off = (address: number): CoilWrite => ({ address, value: false });

test('contiguous coils become one FC15 step and a lone coil becomes FC05', () => {
  expect(planCoilWrites([on(12), off(10), on(11), on(40)])).toEqual([
    { kind: 'multiple', address: 10, values: [false, true, true] },
    { kind: 'single', address: 40, value: true },
  ]);
});

test('the last write to a coil wins', () => {
  expect(planCoilWrites([on(5), off(5)])).toEqual([{ kind: 'single', address: 5, value: false }]);
});

test('a gap within maxGap joins two runs and is marked for filling', () => {
  expect(planCoilWrites([on(0), on(1), off(4), off(5)], { maxGap: 2 })).toEqual([
    { kind: 'multiple', address: 0, values: [true, true, undefined, undefined, false, false] },
  ]);
});

test('a gap wider than maxGap keeps the runs apart', () => {
  expect(planCoilWrites([on(0), on(1), off(5), off(6)], { maxGap: 2 })).toHaveLength(2);
});

test('a span splits at maxCoilsPerWrite, gaps included', () => {
  const steps = planCoilWrites([on(0), on(1), on(3), on(4)], { maxGap: 1, maxCoilsPerWrite: 3 });
  expect(steps).toEqual([
    { kind: 'multiple', address: 0, values: [true, true] },
    { kind: 'multiple', address: 3, values: [true, true] },
  ]);
});

test('a span with fewer requested coils than minRunLength becomes FC05 steps', () => {
  expect(planCoilWrites([on(0), on(2)], { maxGap: 1, minRunLength: 3 })).toEqual([
    { kind: 'single', address: 0, value: true },
    { kind: 'single', address: 2, value: true },
  ]);
});

test('a full-width run fills one FC15 step', () => {
  const writes = Array.from({ length: MODBUS_MAX_WRITE_COILS + 1 }, (_, address) => on(address));
  const steps = planCoilWrites(writes);
  expect(steps).toHaveLength(2);
  expect(steps[0]!.kind === 'multiple' && steps[0]!.values.length).toBe(MODBUS_MAX_WRITE_COILS);
});

test('the coil planner rejects values and limits it cannot encode', () => {
  expect(() => planCoilWrites([{ address: 0, value: notBoolean }])).toThrow(RangeError);
  expect(() => planCoilWrites([on(-1)])).toThrow(RangeError);
  expect(() => planCoilWrites([on(0)], { maxCoilsPerWrite: MODBUS_MAX_WRITE_COILS + 1 })).toThrow(
    RangeError,
  );
  expect(() => planCoilWrites([on(0)], { maxGap: -1 })).toThrow(RangeError);
});

test('coil reads use the coil transaction limit', () => {
  const addresses = Array.from({ length: 300 }, (_, address) => address);
  // 300 coils fit one FC01 read. They would need three register reads.
  expect(planCoilReads(addresses).spans).toEqual([{ address: 0, quantity: 300 }]);
  expect(planCoilReads(addresses, { maxCoilsPerRead: 100 }).spans).toHaveLength(3);
  expect(() => planCoilReads([0], { maxCoilsPerRead: 2001 })).toThrow(RangeError);
});
