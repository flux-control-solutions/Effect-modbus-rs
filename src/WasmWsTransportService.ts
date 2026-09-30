import { Context, Layer } from 'effect';
import type { WasmWsModbusClient, WasmWsTransport, WasmWsTransportOptions } from 'modbus-rs/web';

import { createMockTransport, type MockFaultOptions, type SlaveDeviceDefinitions } from './mocks';
import { createTransportScoped } from './shared-transport';
import type { TransportResilienceOptions, TransportServiceApi } from './shared-transport';

/**
 * Scoped Effect service wrapping `modbus-rs`'s browser {@link WasmWsTransport}
 * for Modbus TCP over a WebSocket gateway (browsers can't open raw TCP sockets).
 *
 * The transport connection is opened lazily on the first call to
 * `withClient(unitId)` and automatically closed when the consuming
 * scope finalizes.
 *
 * Clients are created per `unitId` via {@link WasmWsTransport.createClient} and
 * cached, so repeated requests for the same unit ID reuse the same client.
 *
 * @see WasmWsTransport — Upstream `modbus-rs` browser WebSocket transport.
 * @see WasmWsTransportOptions — Configuration for the WebSocket gateway connection.
 * @see createTransportScoped — Generic lifecycle logic from shared-transport.
 */
export class WasmWsTransportService extends Context.Service<
  WasmWsTransportService,
  TransportServiceApi
>()('WasmWsTransportService') {
  /**
   * Builds the scoped transport service effect. The transport opens on first use
   * and its connection closes when the consuming scope ends.
   *
   * @returns An effect that provides the service for the lifetime of its scope.
   */
  static readonly makeScoped = createTransportScoped<
    WasmWsTransportOptions,
    WasmWsModbusClient,
    WasmWsTransport
  >(
    'WasmWsTransport',
    (transportConstructor, options: WasmWsTransportOptions) => {
      // SAFETY: The constructor is read from the WasmWsTransport export named above.
      return (transportConstructor as typeof WasmWsTransport).connect(options);
    },
    'WasmWsTransportService',
    { moduleSpecifier: 'modbus-rs/web' },
  );

  /**
   * Creates a {@link Layer} providing a live {@link WasmWsTransportService}.
   *
   * @param options - Connection and resilience options for the transport.
   * @returns A layer that provides the scoped service.
   */
  static readonly make = (
    options: WasmWsTransportOptions & TransportResilienceOptions,
  ): Layer.Layer<WasmWsTransportService> =>
    Layer.effect(WasmWsTransportService, WasmWsTransportService.makeScoped(options));
  /**
   * Creates a {@link Layer} providing an in-memory mock
   * {@link WasmWsTransportService} for testing or development.
   *
   * Accepts an array of {@link SlaveDeviceDefinitions} describing the
   * simulated Modbus slaves and their register/coil maps.
   *
   * @param devices - Slave device definitions for the mock.
   * @returns A function that takes {@link WasmWsTransportOptions} and
   *          returns a scoped {@link Layer} providing the mock service. The mock
   *          uses device definitions and fault hooks instead of network I/O.
   *
   * @see makeMockTransport — The underlying mock factory.
   */
  static makeMockTransport = (devices: SlaveDeviceDefinitions) => {
    const factory = createMockTransport(devices);
    return (options: WasmWsTransportOptions & TransportResilienceOptions & MockFaultOptions) =>
      Layer.effect(WasmWsTransportService, factory(options));
  };
}
