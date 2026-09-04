/**
 * @fileoverview Caller-supplied span attributes, and the rule for merging them.
 *
 * @module
 */

/**
 * Attributes a caller attaches to the transactions it causes.
 *
 * The keys are opaque to this package. A caller names a register in its own
 * vocabulary — an alias, a point name, a tag — and this package cannot know that
 * vocabulary, so it carries the record rather than inventing a shape for it.
 *
 * The library's own `modbus.*` keys are applied last and win a key collision, so
 * a caller cannot overwrite the record of what actually reached the bus.
 */
export type ModbusSpanAttributes = Record<string, string | number | boolean>;

/**
 * Joins the attributes of every caller in one batch.
 *
 * A batch carries several callers' worth of vocabulary, and the keys are opaque,
 * so a repeated key keeps every value rather than letting one silently win. The
 * values are joined with a comma, the same shape the library uses for its own
 * `modbus.unit_ids`.
 *
 * A batch of one is unaffected: a one-element join is the value itself.
 *
 * @param sources - One attribute record per caller. `undefined` entries are skipped.
 * @returns One record, with each key's values joined in first-seen order.
 *
 * @example
 * mergeSpanAttributes([{ 'app.point': 'Supply' }, { 'app.point': 'Exhaust' }]);
 * // { 'app.point': 'Supply,Exhaust' }
 */
export const mergeSpanAttributes = (
  sources: Iterable<ModbusSpanAttributes | undefined>,
): ModbusSpanAttributes => {
  const collected = new Map<
    string,
    { readonly first: string | number | boolean; readonly values: Set<string> }
  >();
  for (const source of sources) {
    if (source === undefined) continue;
    for (const [key, value] of Object.entries(source)) {
      const entry = collected.get(key);
      if (entry === undefined)
        collected.set(key, { first: value, values: new Set([String(value)]) });
      else entry.values.add(String(value));
    }
  }
  return Object.fromEntries(
    Array.from(collected, ([key, entry]) => [
      key,
      entry.values.size === 1 ? entry.first : Array.from(entry.values).join(','),
    ]),
  );
};
