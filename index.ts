/**
 * # @flux-control/effect-modbus-rs
 *
 * Provides typed Effect services for native and browser Modbus transports and servers.
 * Transport services use `Context.Service` and scoped layers. They open on first
 * client access and close when the provided scope ends.
 *
 * Build the package with `bun run build` before using package imports. The build
 * creates `dist/`, which the package export map uses.
 *
 * Native transports: {@link SerialTransportService}, {@link RtuTransportService},
 * {@link AsciiTransportService}, and {@link TcpTransportService}. Browser
 * transports: {@link WasmSerialTransportService}, {@link WasmRtuTransportService},
 * {@link WasmAsciiTransportService}, and {@link WasmWsTransportService}.
 * Call {@link requestSerialPort} from a user-gesture handler to request a Web Serial port.
 *
 * Server layers include {@link serialRtuServerLayer}, {@link serialAsciiServerLayer},
 * {@link tcpServerLayer}, and {@link tcpGatewayLayer}. Browser server layers are
 * experimental upstream surfaces.
 *
 * ## Raw operations and result types
 *
 * `transport.withClient(unitId)` returns a typed client. Register reads return
 * `Uint16Array`; coil and discrete-input reads return `CoilState[]`. Operations
 * fail with a variant of {@link ModbusError}. Use `Effect.catchTags` to handle
 * specific variants. The union has eight variants, including
 * {@link ModbusCircuitOpenError}. The batching declaration error is separate.
 *
 * ## Register batching
 *
 * {@link planWrites} and {@link planReads} plan the supplied registers without
 * state or I/O. For example:
 *
 * ```ts
 * planWrites([{ address: 2000, value: 10 }, { address: 2001, value: 20 }]);
 * // One multiple-register write step for addresses 2000 and 2001.
 * ```
 *
 * {@link createWriteDebouncer} and {@link createReadDebouncer} collect separate
 * calls only when configured with positive windows. Without a window, calls are
 * not debounced. `writeAll` and `readAll` also collect when their windows are
 * positive. Their `Now` variants flush the pending group immediately.
 * Grouping does not make separate application operations atomic. A pending
 * write can be superseded, and the cache can suppress a write based on its
 * recorded value. Therefore, each call is not guaranteed to produce a separate
 * device write. The cache records acknowledged writes from this process; it
 * does not answer reads.
 *
 * `withBatchingClient` combines planning, optional collection, and optional
 * caching. It is separate from `withClient`, which exposes raw Modbus operations.
 * Once a batching client exists for a unit, raw FC06, FC16, and FC23 operations
 * for that unit fail. Raw reads, coil operations, and other operations remain
 * available. A batching client does not extend {@link ModbusOperations}.
 *
 * ```ts
 * const raw = yield* transport.withClient(3);
 * const registers = yield* raw.readHoldingRegisters({ address: 2000, quantity: 2 });
 * // registers is Uint16Array.
 *
 * const batch = yield* transport.withBatchingClient(3, {
 *   debounce: { writes: { window: '250 millis', maxHold: '1 second' } },
 * });
 * yield* batch.write({ address: 2000, value: 512 });
 * yield* batch.readAll([0, 1, 32]);
 * ```
 *
 * ## Retry and reconnection
 *
 * Retry and reconnection are opt-in. A transport retry policy applies to its
 * clients. Client and operation overrides replace that policy. For example:
 *
 * ```ts
 * TcpTransportService.make({ host, port, retry: RetryPolicies.tcp(), reconnect: {} });
 * const meter = yield* transport.withClient(1, { retry: RetryPolicies.serial() });
 * yield* meter.withRetry(RetryPolicies.none()).writeSingleCoil({ address: 0, value });
 * ```
 *
 * A configured reconnect supervisor owns reconnection for the transport and
 * guards operations while the connection is down. Watch {@link ConnectionState}
 * through `transport.connectionState`. {@link retryModbus} wraps an Effect; use
 * it with a `RetryPolicies.none()` client for a compound operation. It does not
 * replace a client's policy. Upstream transport retry options are excluded;
 * see {@link UpstreamRetryOptionKey}.
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
  BatchingDebounceWindows,
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
export { MAX_SERIAL_PORT_PATH, resolveSerialPortPath } from './src/serial-port-path';
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
