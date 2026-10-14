/**
 * @fileoverview Tracks acknowledged coil states to suppress unchanged coil writes.
 *
 * @module
 */

import { assertCoilValue, type CoilWrite } from './coil-plan';
import { createEncodedCache } from './register-cache';
import { assertAddress } from './register-plan';

/** The result of {@link CoilCache.filter}. */
export interface CoilCacheFilter {
  /** Writes that change a coil, in the order they were proposed. */
  readonly pending: ReadonlyArray<CoilWrite>;
  /** Writes the cache removed because the device already holds the state. */
  readonly suppressed: ReadonlyArray<CoilWrite>;
}

/**
 * A belief about the coil states on a bus.
 *
 * This is the coil form of `RegisterCache`. It stores one boolean for each unit
 * and coil address. Coils and holding registers are separate address spaces, so
 * they use separate caches.
 *
 * The cache records only what this process wrote. It does not read the device.
 */
export interface CoilCache {
  /**
   * Splits proposed writes into the ones that change a coil and the ones that
   * do not. When an address appears more than once, the last write wins.
   *
   * @throws RangeError - An address is out of range, or a value is not a boolean.
   */
  filter(unitId: number, writes: ReadonlyArray<CoilWrite>): CoilCacheFilter;

  /**
   * How many times what this cache believes about a unit has been discarded.
   * Read it before a write, and give it to {@link observe}.
   */
  generationOf(unitId: number): number;

  /**
   * Records that a coil now holds a state.
   *
   * Call this only after the device acknowledged the write. When `generation`
   * is given and the unit was invalidated after it, the call records nothing.
   */
  observe(unitId: number, address: number, value: boolean, generation?: number): void;

  /**
   * The state this process last wrote to a coil, or `undefined` when unknown.
   *
   * A batching client uses this to fill the gaps of an FC15 span without a read.
   */
  valueOf(unitId: number, address: number): boolean | undefined;

  /** Forgets what a unit holds, or what every unit holds when `unitId` is omitted. */
  invalidate(unitId?: number): void;

  /** Coils the cache currently holds a state for. Intended for tests. */
  readonly size: number;
}

/**
 * Creates an empty {@link CoilCache}.
 *
 * @example
 * const cache = createCoilCache();
 * cache.observe(3, 10, true);
 * cache.filter(3, [{ address: 10, value: true }]).suppressed; // the write
 */
export const createCoilCache = (): CoilCache => {
  const cache = createEncodedCache<CoilWrite>((write) => {
    assertAddress(write.address);
    assertCoilValue(write.value);
    return write.value ? 1 : 0;
  });
  return {
    filter: cache.filter,
    generationOf: cache.generationOf,
    observe: (unitId, address, value, generation) =>
      cache.observe(unitId, { address, value }, generation),
    valueOf: (unitId, address) => {
      const encoded = cache.valueOf(unitId, address);
      return encoded === undefined ? undefined : encoded === 1;
    },
    invalidate: cache.invalidate,
    get size() {
      return cache.size;
    },
  };
};
