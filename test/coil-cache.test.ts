import { expect, test } from 'bun:test';

import { createCoilCache } from '../src/coil-cache';

/** Tests coil state filtering, generations, and invalidation. */

// The value is not a boolean on purpose. `JSON.parse` returns an untyped value,
// as data from a caller outside the type system does. The test checks the guard.
const notBoolean: boolean = JSON.parse('1');

test('the coil cache suppresses a state the coil already holds', () => {
  const cache = createCoilCache();
  cache.observe(3, 10, true);
  const { pending, suppressed } = cache.filter(3, [
    { address: 10, value: true },
    { address: 11, value: false },
  ]);
  expect(pending).toEqual([{ address: 11, value: false }]);
  expect(suppressed).toEqual([{ address: 10, value: true }]);
  expect(cache.valueOf(3, 10)).toBe(true);
  expect(cache.valueOf(3, 11)).toBeUndefined();
});

test('the coil cache keeps units apart and forgets an invalidated unit', () => {
  const cache = createCoilCache();
  cache.observe(3, 10, false);
  cache.observe(4, 10, true);
  cache.invalidate(3);
  expect(cache.valueOf(3, 10)).toBeUndefined();
  expect(cache.valueOf(4, 10)).toBe(true);
  cache.invalidate();
  expect(cache.size).toBe(0);
});

test('an observation from before an invalidation records nothing', () => {
  const cache = createCoilCache();
  const generation = cache.generationOf(3);
  cache.invalidate(3);
  cache.observe(3, 10, true, generation);
  expect(cache.valueOf(3, 10)).toBeUndefined();
});

test('the coil cache rejects a value that is not a boolean', () => {
  const cache = createCoilCache();
  expect(() => cache.filter(3, [{ address: 0, value: notBoolean }])).toThrow(RangeError);
});
