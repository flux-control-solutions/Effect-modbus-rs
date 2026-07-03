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
export { AsciiTransportService } from "./src/AsciiTransportService";
export { SerialTransportService } from "./src/SerialTransportService";
export { TcpTransportService } from "./src/TcpTransportService";
export { RtuTransportService } from "./src/RtuTransportService";
export { serialRtuServerLayer, serialAsciiServerLayer } from "./src/SerialModbusServerService";
export { tcpServerLayer } from "./src/TcpModbusServerService";
export { tcpGatewayLayer } from "./src/TcpGatewayService";
export type { CoilDefinition, DiscreteInputDefinition, RegisterDefinition, SlaveDeviceDefinition, SlaveDeviceDefinitions, } from "./src/mocks";
