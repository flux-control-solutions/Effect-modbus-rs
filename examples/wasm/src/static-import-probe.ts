/**
 * Isolates a named import so the diagnostic page can catch module-link errors.
 *
 * `src/errors.ts` in the parent package does exactly this:
 *
 *     import { getModbusErrorCode, ModbusErrorCode } from 'modbus-rs';
 *
 * The browser export condition may resolve to a different runtime module from
 * the one used by type checking. The probe checks whether the named export links.
 *
 * Because a named import is resolved at module-link time, this file cannot be
 * imported statically by the diagnostic page without taking the whole page down
 * with it. `export-check.ts` loads it with `import()` inside a try/catch so any
 * link error can be displayed.
 */
export { ModbusErrorCode } from 'modbus-rs';
