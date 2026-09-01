/**
 * @fileoverview A record of what each device already holds, used to drop writes
 * that would change nothing.
 *
 * A caller that recomputes an output on every cycle proposes the same value most
 * of the time. In steady state roughly four out of five proposals are a repeat of
 * what the register already holds, and on a half-duplex bus each one costs a
 * turnaround that carries no information.
 *
 * @module
 */

import { encodeRegisterValue, type RegisterWrite } from './register-plan';

/** The result of {@link RegisterCache.filter}. */
export interface RegisterCacheFilter {
  /** Writes that change a register, in the order they were proposed. */
  readonly pending: ReadonlyArray<RegisterWrite>;
  /** Writes the cache removed because the device already holds the value. */
  readonly suppressed: ReadonlyArray<RegisterWrite>;
}

/**
 * A belief about the contents of the registers on a bus.
 *
 * The key is the unit and the address together, so one cache serves every device
 * on a transport. That is deliberate: the cache is a belief about a physical
 * device, and there is one physical device. Two caches on one unit disagree, and
 * the one that is wrong suppresses a write that the device needed.
 *
 * The cache is not a read cache. It records only what this process wrote, so it
 * never answers a read and never claims to know a register nobody has written.
 */
export interface RegisterCache {
  /**
   * Splits proposed writes into the ones that change something and the ones that
   * do not.
   *
   * When an address appears more than once, the last write wins, which is the
   * same rule `planWrites` applies. The earlier proposals are reported as
   * suppressed, so the counts still add up to the number of proposals.
   *
   * @param unitId - Unit the writes are addressed to.
   * @param writes - Proposed writes.
   * @returns The writes to issue, and the ones the cache removed.
   * @throws RangeError - An address or a value is out of range.
   */
  filter(unitId: number, writes: ReadonlyArray<RegisterWrite>): RegisterCacheFilter;

  /**
   * Records that a register now holds a value.
   *
   * Call this only after the device acknowledged the write. A value recorded
   * before the acknowledgement suppresses the retry that would have fixed it.
   */
  observe(unitId: number, address: number, value: number): void;

  /**
   * Forgets what a unit holds, or what every unit holds when `unitId` is omitted.
   *
   * A failed transaction and a reconnect both mean the state of the device is
   * unknown: it may have power-cycled and reset its outputs. A stale belief then
   * suppresses exactly the write that would restore it.
   */
  invalidate(unitId?: number): void;

  /** Registers the cache currently holds a value for. Intended for tests. */
  readonly size: number;
}

/**
 * Creates an empty {@link RegisterCache}.
 *
 * The cache is synchronous and holds no scope. Its lifetime is the transport's:
 * one cache per bus, shared by every client derived from it.
 *
 * @example
 * const cache = makeRegisterCache();
 * const { pending, suppressed } = cache.filter(3, [{ address: 2000, value: 512 }]);
 * // pending: the write; suppressed: empty, since nothing is known yet
 */
export const makeRegisterCache = (): RegisterCache => {
  const held = new Map<string, number>();
  const keyOf = (unitId: number, address: number) => `${unitId}:${address}`;

  return {
    filter: (unitId, writes) => {
      const latest = new Map<number, RegisterWrite>();
      const suppressed: RegisterWrite[] = [];
      for (const write of writes) {
        const superseded = latest.get(write.address);
        if (superseded !== undefined) suppressed.push(superseded);
        latest.set(write.address, write);
      }

      const pending: RegisterWrite[] = [];
      for (const write of latest.values()) {
        if (held.get(keyOf(unitId, write.address)) === encodeRegisterValue(write.value)) {
          suppressed.push(write);
        } else {
          pending.push(write);
        }
      }
      return { pending, suppressed };
    },

    observe: (unitId, address, value) => {
      held.set(keyOf(unitId, address), encodeRegisterValue(value));
    },

    invalidate: (unitId) => {
      if (unitId === undefined) {
        held.clear();
        return;
      }
      const prefix = `${unitId}:`;
      for (const key of held.keys()) {
        if (key.startsWith(prefix)) held.delete(key);
      }
    },

    get size() {
      return held.size;
    },
  };
};
