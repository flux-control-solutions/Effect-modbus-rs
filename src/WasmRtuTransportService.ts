import { Context, Layer } from 'effect';
import type {
  WasmRtuTransport,
  WasmSerialModbusClient,
  WasmSerialPortHandle,
  WasmSerialTransportOptions,
} from 'modbus-rs/web';

import { createMockTransport, type MockFaultOptions, type SlaveDeviceDefinitions } from './mocks';
import { createTransportScoped } from './shared-transport';
import type { TransportResilienceOptions, TransportServiceApi } from './shared-transport';

/**
 * Options for {@link WasmRtuTransportService}. `WasmRtuTransport.open()` takes the
 * serial port handle and the connection options as two separate arguments; this
 * combines them into one object so it fits {@link createTransportScoped}'s single-options
 * shape, with `port` destructured back out inside the service's `openMethod`.
 *
 * Obtain the `port` handle with {@link requestSerialPort}. Call it from a browser
 * user-gesture handler because the browser may require transient user activation.
 */
export type WasmRtuTransportOpenOptions = WasmSerialTransportOptions & {
  port: WasmSerialPortHandle;
};

/**
 * Scoped Effect service wrapping `modbus-rs`'s browser {@link WasmRtuTransport}
 * for Modbus RTU over the Web Serial API. The caller obtains the port handle;
 * this service does not request browser permission.
 *
 * The transport connection is opened lazily on the first call to
 * `withClient(unitId)` and automatically closed when the consuming
 * scope finalizes.
 *
 * Clients are created per `unitId` via {@link WasmRtuTransport.createClient} and
 * cached, so repeated requests for the same unit ID reuse the same client.
 *
 * @see WasmRtuTransport — Upstream `modbus-rs` browser Web Serial RTU transport.
 * @see requestSerialPort — Obtains the serial port handle this service's `port` option needs.
 * @see createTransportScoped — Generic lifecycle logic from shared-transport.
 */
export class WasmRtuTransportService extends Context.Service<
  WasmRtuTransportService,
  TransportServiceApi
>()('WasmRtuTransportService') {
  /**
   * Builds the scoped transport service effect. The transport opens on first use
   * and its connection closes when the consuming scope ends.
   *
   * @returns An effect that provides the service for the lifetime of its scope.
   */
  static readonly makeScoped = createTransportScoped<
    WasmRtuTransportOpenOptions,
    WasmSerialModbusClient,
    WasmRtuTransport
  >(
    'WasmRtuTransport',
    (transportConstructor, { port, ...rest }: WasmRtuTransportOpenOptions) => {
      // SAFETY: The constructor is read from the WasmRtuTransport export named above.
      return (transportConstructor as typeof WasmRtuTransport).open(port, rest);
    },
    'WasmRtuTransportService',
    { moduleSpecifier: 'modbus-rs/web' },
  );

  /**
   * Creates a {@link Layer} providing a live {@link WasmRtuTransportService}.
   *
   * @param options - Connection and resilience options for the transport.
   * @returns A layer that provides the scoped service.
   */
  static readonly make = (
    options: WasmRtuTransportOpenOptions & TransportResilienceOptions,
  ): Layer.Layer<WasmRtuTransportService> =>
    Layer.effect(WasmRtuTransportService, WasmRtuTransportService.makeScoped(options));
  /**
   * Creates a {@link Layer} providing an in-memory mock
   * {@link WasmRtuTransportService} for testing or development.
   *
   * Accepts an array of {@link SlaveDeviceDefinitions} describing the
   * simulated Modbus slaves and their register/coil maps.
   *
   * @param devices - Slave device definitions for the mock.
   * @returns A function that takes {@link WasmRtuTransportOpenOptions} and
   *          returns a scoped {@link Layer} providing the mock service. The mock
   *          uses device definitions and fault hooks instead of browser I/O.
   *
   * @see makeMockTransport — The underlying mock factory.
   */
  static makeMockTransport = (devices: SlaveDeviceDefinitions) => {
    const factory = createMockTransport(devices);
    return (options: WasmRtuTransportOpenOptions & TransportResilienceOptions & MockFaultOptions) =>
      Layer.effect(WasmRtuTransportService, factory(options));
  };
}
