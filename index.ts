/**
 * # effect-modbus-rs
 *
 * Type-safe Modbus communication via Effect-TS, wrapping the `modbus-rs`
 * npm bindings (Rust `napi-rs` under the hood).
 *
 * ## Transport services
 *
 * - {@link SerialTransportService} — Abstract serial transport (ASCII or RTU).
 * - {@link RtuTransportService} — Serial RTU transport (RS-232/485).
 * - {@link AsciiTransportService} — Serial ASCII transport.
 * - {@link TcpTransportService} — TCP/IP transport (Modbus/TCP).
 *
 * ## Browser (WASM) transport services
 *
 * - {@link WasmSerialTransportService} — Abstract Web Serial transport (ASCII or RTU).
 * - {@link WasmRtuTransportService} — Web Serial RTU transport.
 * - {@link WasmAsciiTransportService} — Web Serial ASCII transport.
 * - {@link WasmWsTransportService} — TCP-over-WebSocket transport (Modbus/TCP via a WS gateway).
 * - {@link requestSerialPort} — Requests a Web Serial port handle (user-gesture gated).
 *
 * ## Server layers
 *
 * Run a server layer with {@link Layer.launch} and execute with a runtime:
 *
 * ```ts
 * Layer.launch(tcpServerLayer({ host: "0.0.0.0", port: 502, unitId: 1 }, handlers)).pipe(Effect.runPromise)
 * ```
 *
 * - {@link serialRtuServerLayer} — Serial RTU server.
 * - {@link serialAsciiServerLayer} — Serial ASCII server.
 * - {@link tcpServerLayer} — TCP server.
 * - {@link tcpGatewayLayer} — TCP gateway.
 * - {@link wasmWsServerLayer} — Browser WS-gateway server (experimental upstream surface).
 * - {@link wasmSerialRtuServerLayer} / {@link wasmSerialAsciiServerLayer} — Browser Web Serial servers (experimental).
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

export * from "./src/errors";
export type { EffectModbusClient } from "./src/modbus-client";
export { AsciiTransportService } from "./src/AsciiTransportService";
export { SerialTransportService } from "./src/SerialTransportService";
export { TcpTransportService } from "./src/TcpTransportService";
export { RtuTransportService } from "./src/RtuTransportService";
export { serialRtuServerLayer, serialAsciiServerLayer } from "./src/SerialModbusServerService";
export { tcpServerLayer } from "./src/TcpModbusServerService";
export { tcpGatewayLayer } from "./src/TcpGatewayService";
export { WasmWsTransportService } from "./src/WasmWsTransportService";
export { WasmRtuTransportService } from "./src/WasmRtuTransportService";
export type { WasmRtuTransportOpenOptions } from "./src/WasmRtuTransportService";
export { WasmAsciiTransportService } from "./src/WasmAsciiTransportService";
export type { WasmAsciiTransportOpenOptions } from "./src/WasmAsciiTransportService";
export { WasmSerialTransportService } from "./src/WasmSerialTransportService";
export { requestSerialPort } from "./src/WasmSerialPort";
export { wasmWsServerLayer } from "./src/WasmTcpServerService";
export {
  wasmSerialRtuServerLayer,
  wasmSerialAsciiServerLayer,
} from "./src/WasmSerialModbusServerService";
export type {
  CoilDefinition,
  DiscreteInputDefinition,
  RegisterDefinition,
  SlaveDeviceDefinition,
  SlaveDeviceDefinitions,
} from "./src/mocks";
