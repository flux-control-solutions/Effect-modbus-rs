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
 * ## Transaction batching
 *
 * A caller that derives each register independently produces one transaction per
 * register, which is the dominant cost on a half-duplex bus. Three pieces bring
 * that count down, and each one is usable without the others.
 *
 * {@link planWrites} and {@link planReads} pack neighbouring addresses into the
 * fewest transactions that cover them. They hold no state and run no I/O:
 *
 * ```ts
 * planWrites([{ address: 2000, value: 10 }, { address: 2001, value: 20 }]);
 * // [{ kind: "multiple", address: 2000, values: Uint16Array [10, 20] }]
 * ```
 *
 * A planner only packs what a caller holds at one moment, and a caller with one
 * fiber per register never holds two values at once. {@link createWriteDebouncer}
 * and {@link createReadDebouncer} are the collection point that gives a planner
 * something to pack, holding an operation for a window so the ones that arrive
 * near it travel with it. Each caller still awaits its own operation.
 *
 * {@link createRegisterCache} drops a write whose value the device already holds.
 * It records only what this process wrote, so it never answers a read.
 *
 * `transport.withBatchingClient(unitId, options)` puts the three together. It is
 * the sibling of `withClient`, not a replacement for it: `withClient` issues the
 * transaction a caller names, and a batching client decides the transactions for
 * a caller that names registers instead.
 *
 * ```ts
 * const client = yield* transport.withClient(3);            // exact read
 * yield* client.readHoldingRegisters({ address: 2000, quantity: 2 });
 *
 * const batched = yield* transport.withBatchingClient(3, {  // decides the transactions
 *   debounce: { writes: { window: "250 millis", maxHold: "1 second" } },
 * });
 * yield* batched.write({ address: 2000, value: 512 });
 * yield* batched.readAll([0x0000, 0x0001, 0x0020]);
 * ```
 *
 * A {@link BatchingModbusClient} deliberately does not extend
 * {@link ModbusOperations}: a raw write on the same object would go around the
 * cache and around the batch. Once a batching client exists for a unit, raw
 * FC06, FC16, and FC23 operations on that unit fail. The raw client remains
 * available for exact reads, coils, and other non-register-write operations.
 *
 * Nothing is debounced unless `debounce` asks for it, matching the rest of this
 * package. `writeAll` and `readAll` still plan, so a caller that holds a group of
 * registers gets packed transactions with no window at all.
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
 * TcpTransportService.make({
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
export {
  createRetryPolicy,
  retryableExceptionCodes,
  RetryPolicies,
  retryModbus,
} from './src/retry';
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
export {
  encodeRegisterValue,
  MODBUS_MAX_READ_REGISTERS,
  MODBUS_MAX_WRITE_REGISTERS,
  planReads,
  planWrites,
} from './src/register-plan';
export type {
  MultipleWriteStep,
  PlanReadsOptions,
  PlanWritesOptions,
  ReadLocation,
  ReadPlan,
  ReadSpan,
  RegisterWrite,
  SingleWriteStep,
  WritePlanStep,
} from './src/register-plan';
export { createRegisterCache } from './src/register-cache';
export type { RegisterCache, RegisterCacheFilter } from './src/register-cache';
export { createWriteDebouncer } from './src/write-debouncer';
export type { DebouncedWrite, WriteDebouncer, WriteDebouncerOptions } from './src/write-debouncer';
export { createReadDebouncer } from './src/read-debouncer';
export type { ReadDebouncer, ReadDebouncerOptions } from './src/read-debouncer';
export { makeBatchingClient, createBatchingRegistry } from './src/batching-client';
export type {
  BatchingClientOptions,
  BatchingDebounceOptions,
  BatchingModbusClient,
  BatchingRegistry,
  BatchingRegistryDeps,
  BatchingRegisterReader,
} from './src/batching-client';
export { mergeSpanAttributes } from './src/span-attributes';
export type { ModbusSpanAttributes } from './src/span-attributes';
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
