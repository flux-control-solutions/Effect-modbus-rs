import { expect, test } from 'bun:test';

import { createRegisterCache } from './register-cache';

test('the cache suppresses nothing until it has seen a write land', () => {
  const cache = createRegisterCache();

  const { pending, suppressed } = cache.filter(1, [{ address: 2000, value: 10 }]);

  expect(pending).toEqual([{ address: 2000, value: 10 }]);
  expect(suppressed).toEqual([]);
});

test('the cache suppresses a write that changes nothing', () => {
  const cache = createRegisterCache();
  cache.observe(1, 2000, 10);

  const { pending, suppressed } = cache.filter(1, [
    { address: 2000, value: 10 },
    { address: 2001, value: 20 },
  ]);

  expect(pending).toEqual([{ address: 2001, value: 20 }]);
  expect(suppressed).toEqual([{ address: 2000, value: 10 }]);
});

test('the cache compares in the encoding that reaches the wire', () => {
  const cache = createRegisterCache();
  cache.observe(1, 2000, -1);

  // `-1` and `65535` are the same register contents. A comparison that says
  // otherwise rewrites the register on every cycle.
  expect(cache.filter(1, [{ address: 2000, value: 0xffff }]).pending).toEqual([]);
  expect(cache.filter(1, [{ address: 2000, value: -1 }]).pending).toEqual([]);
});

test('the cache keeps the last write to a repeated address and counts the rest', () => {
  const cache = createRegisterCache();

  const { pending, suppressed } = cache.filter(1, [
    { address: 2000, value: 10 },
    { address: 2000, value: 20 },
  ]);

  expect(pending).toEqual([{ address: 2000, value: 20 }]);
  expect(suppressed).toEqual([{ address: 2000, value: 10 }]);
  expect(pending.length + suppressed.length).toBe(2);
});

test('filter rejects every invalid address and value', () => {
  const cache = createRegisterCache();

  for (const address of [-1, 1.5, 0x10000]) {
    expect(() => cache.filter(1, [{ address, value: 0 }])).toThrow(RangeError);
  }
  for (const value of [-0x8001, 1.5, 0x10000]) {
    expect(() => cache.filter(1, [{ address: 0, value }])).toThrow(RangeError);
  }
});

test('filter rejects an invalid write even when a later write supersedes it', () => {
  const cache = createRegisterCache();

  expect(() =>
    cache.filter(1, [
      { address: 2000, value: 0x10000 },
      { address: 2000, value: 10 },
    ]),
  ).toThrow(RangeError);
});

test('observe validates before mutating the cache', () => {
  const cache = createRegisterCache();

  expect(() => cache.observe(1, -1, 10)).toThrow(RangeError);
  expect(() => cache.observe(1, 0, 0x10000)).toThrow(RangeError);
  expect(cache.size).toBe(0);
});

test('the cache keeps units apart', () => {
  const cache = createRegisterCache();
  cache.observe(1, 2000, 10);

  expect(cache.filter(1, [{ address: 2000, value: 10 }]).pending).toEqual([]);
  expect(cache.filter(2, [{ address: 2000, value: 10 }]).pending).toEqual([
    { address: 2000, value: 10 },
  ]);
});

test('invalidate forgets one unit, or every unit', () => {
  const cache = createRegisterCache();
  cache.observe(1, 2000, 10);
  cache.observe(2, 2000, 10);

  cache.invalidate(1);
  expect(cache.filter(1, [{ address: 2000, value: 10 }]).pending).toHaveLength(1);
  expect(cache.filter(2, [{ address: 2000, value: 10 }]).pending).toHaveLength(0);

  cache.invalidate();
  expect(cache.size).toBe(0);
  expect(cache.filter(2, [{ address: 2000, value: 10 }]).pending).toHaveLength(1);
});

test('invalidate matches a unit by its whole id, not by a prefix of it', () => {
  const cache = createRegisterCache();
  cache.observe(1, 2000, 10);
  cache.observe(11, 2000, 10);

  cache.invalidate(1);

  // Unit 11 shares the leading "1" but is a different device.
  expect(cache.filter(11, [{ address: 2000, value: 10 }]).pending).toEqual([]);
});

test('an observation from before an invalidation does not restore the belief', () => {
  const cache = createRegisterCache();

  // What a caller does around a write: read the generation, issue, then record.
  const generation = cache.generationOf(1);
  cache.invalidate(1);
  cache.observe(1, 2000, 10, generation);

  expect(cache.size).toBe(0);
  expect(cache.filter(1, [{ address: 2000, value: 10 }]).pending).toHaveLength(1);

  // An observation that spans no invalidation still records.
  cache.observe(1, 2000, 10, cache.generationOf(1));
  expect(cache.filter(1, [{ address: 2000, value: 10 }]).pending).toHaveLength(0);
});

test('invalidating one unit does not discard an observation in flight for another', () => {
  const cache = createRegisterCache();

  const generation = cache.generationOf(2);
  // A different device on the same bus fails its write.
  cache.invalidate(1);
  cache.observe(2, 2000, 10, generation);

  expect(cache.filter(2, [{ address: 2000, value: 10 }]).pending).toHaveLength(0);
});

test('losing the bus discards an observation in flight for every unit', () => {
  const cache = createRegisterCache();

  const generation = cache.generationOf(2);
  cache.invalidate();
  cache.observe(2, 2000, 10, generation);

  expect(cache.filter(2, [{ address: 2000, value: 10 }]).pending).toHaveLength(1);
});
