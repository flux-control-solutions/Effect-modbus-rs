/**
 * # @flux-control/effect-modbus-rs
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
 * ## Resilience
 *
 * Nothing retries or reconnects implicitly — a transport behaves exactly as it
 * always has until a policy is attached, so timing stays predictable by
 * default. Resilience is configured on the **transport**, which owns it for
 * every client derived from it:
 *
 * ```ts
 * TcpTransportService.Default({
 *   host, port,
 *   retry: RetryPolicies.tcp(),      // applied to every operation
 *   reconnect: {},                   // supervised reconnect + circuit breaker
 * })
 * ```
 *
 * Policies are error-aware: transient failures (timeouts, framing errors, a
 * busy device) back off exponentially with jitter (on by default), while
 * deterministic ones (illegal address, invalid argument) fail immediately.
 *
 * Override per client — one bus, several device types — or per operation.
 * Both replace the policy rather than composing with it:
 *
 * ```ts
 * const meter = yield* transport.withClient(1, { retry: RetryPolicies.serial() });
 * yield* meter.withRetry(RetryPolicies.none()).writeSingleCoil({ address: 0, value });
 * ```
 *
 * With `reconnect` enabled, the transport runs one supervised reconnect for the
 * whole application and refuses operations with {@link ModbusCircuitOpenError}
 * while the link is down, instead of letting every caller queue requests onto a
 * dead bus. Watch {@link ConnectionState} via `transport.connectionState`.
 *
 * {@link retryModbus} remains for retrying a compound operation — a
 * read-modify-write driven as a unit — over a `RetryPolicies.none()` client.
 * Note that it **wraps** rather than replaces: unlike the two overrides above,
 * it is piped around an effect the client has already wrapped in its own retry,
 * so over a policied client the two nest and attempt counts multiply.
 *
 * Resilience lives at this layer and only at this layer. `modbus-rs`'s own
 * transport-level `retryAttempts` / `retryDelayMs` / `retryBackoffStrategy` are
 * **not accepted** by any transport constructor here: they retry beneath the
 * Effect boundary where neither the policy, the circuit breaker, nor the logs
 * can see them, and they reconnect inline, racing the supervisor fiber that
 * owns reconnection. See {@link UpstreamRetryOptionKey}.
 *
 * @module @flux-control/effect-modbus-rs
 */

export * from './src/errors';
export type { EffectModbusClient } from './src/modbus-client';
export { makeRetryPolicy, retryableExceptionCodes, RetryPolicies, retryModbus } from './src/retry';
export type {
  ModbusErrorTag,
  ModbusRetryPolicy,
  ModbusRetryPolicyOptions,
  RetryDelayOptions,
  RetryErrorOptions,
} from './src/retry';
export { ConnectionState } from './src/connection';
export type { ReconnectOptions } from './src/connection';
export type {
  TransportResilienceOptions,
  UpstreamRetryOptionKey,
  WithoutUpstreamRetry,
} from './src/shared-transport';
export type { ModbusOperations } from './src/modbus-client';
export { AsciiTransportService } from './src/AsciiTransportService';
export type { AsciiTransportOpenOptions } from './src/AsciiTransportService';
export { SerialTransportService } from './src/SerialTransportService';
export { TcpTransportService } from './src/TcpTransportService';
export type { TcpTransportOpenOptions } from './src/TcpTransportService';
export { RtuTransportService } from './src/RtuTransportService';
export type { RtuTransportOpenOptions } from './src/RtuTransportService';
export { serialRtuServerLayer, serialAsciiServerLayer } from './src/SerialModbusServerService';
export { tcpServerLayer } from './src/TcpModbusServerService';
export { tcpGatewayLayer } from './src/TcpGatewayService';
export { WasmWsTransportService } from './src/WasmWsTransportService';
export { WasmRtuTransportService } from './src/WasmRtuTransportService';
export type { WasmRtuTransportOpenOptions } from './src/WasmRtuTransportService';
export { WasmAsciiTransportService } from './src/WasmAsciiTransportService';
export type { WasmAsciiTransportOpenOptions } from './src/WasmAsciiTransportService';
export { WasmSerialTransportService } from './src/WasmSerialTransportService';
export { requestSerialPort } from './src/WasmSerialPort';
export { wasmWsServerLayer } from './src/WasmTcpServerService';
export {
  wasmSerialRtuServerLayer,
  wasmSerialAsciiServerLayer,
} from './src/WasmSerialModbusServerService';
export type {
  CoilDefinition,
  DiscreteInputDefinition,
  RegisterDefinition,
  SlaveDeviceDefinition,
  SlaveDeviceDefinitions,
} from './src/mocks';
