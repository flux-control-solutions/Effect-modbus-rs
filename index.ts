/**
 * # effect-modbus-rs
 *
 * Type-safe Modbus communication via Effect-TS, wrapping the `modbus-rs`
 * npm bindings (Rust `napi-rs` under the hood).
 *
 * ## Transport services
 *
 * - {@link RtuTransportService} — Serial RTU transport (RS-232/485).
 * - {@link TcpTransportService} — TCP/IP transport (Modbus/TCP).
 * - {@link AsciiTransportService} — Serial ASCII transport.
 *
 * ## Errors
 *
 * All Modbus operations fail with a {@link ModbusError} discriminated union.
 * Use `Effect.catchTags` to handle specific variants:
 *
 * ```ts
 * Effect.catchTags(effect, {
 *   ModbusTimeoutError: ...,
 *   ModbusTransportError: ...,
 * })
 * ```
 *
 * @module effect-modbus-rs
 */

export * from "./src/errors.js";
export { AsciiTransportService } from "./src/AsciiTransportService.js";
export { TcpTransportService } from "./src/TcpTransportService.js";
export { RtuTransportService } from "./src/RtuTransportService.js";