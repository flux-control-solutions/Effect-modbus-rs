/**
 * Isolated reproduction of the failing import shape, kept in its own module on
 * purpose.
 *
 * `src/errors.ts` in the parent package does exactly this:
 *
 *     import { getModbusErrorCode, ModbusErrorCode } from 'modbus-rs';
 *
 * Under the `browser` export condition that resolves to
 * `modbus-rs/dist/index.browser.js` → `export * from 'modbus-rs-wasm'`, whose
 * runtime export list does not include `ModbusErrorCode` — even though
 * `modbus-rs-wasm`'s `.d.ts` declares it. TypeScript is therefore happy and the
 * failure is runtime-only.
 *
 * Because a named import is resolved at module-link time, this file cannot be
 * imported statically by the diagnostic page without taking the whole page down
 * with it. `export-check.ts` pulls it in via `import()` inside a try/catch so the
 * resulting error can be caught and displayed instead.
 */
export { ModbusErrorCode } from 'modbus-rs';
