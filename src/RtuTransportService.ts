/** Provides scoped RTU Modbus transport layers and an in-memory mock layer. */
import { Context, Layer } from 'effect';
import type { AsyncRtuTransport, AsyncSerialModbusClient, RtuTransportOptions } from 'modbus-rs';

import { createMockTransport, type MockFaultOptions, type SlaveDeviceDefinitions } from './mocks';
import { resolveSerialPortPath } from './serial-port-path';
import { createTransportScoped } from './shared-transport';
import type {
  TransportResilienceOptions,
  WithoutUpstreamRetry,
  TransportServiceApi,
} from './shared-transport';

/**
 * {@link RtuTransportOptions} minus the upstream retry knobs.
 *
 * @see WithoutUpstreamRetry — Why they are withheld.
 */
export type RtuTransportOpenOptions = WithoutUpstreamRetry<RtuTransportOptions>;

/**
 * Scoped Effect service wrapping the `modbus-rs` {@link AsyncRtuTransport}
 * for RTU (serial) Modbus communication.
 *
 * The transport connection is opened lazily on the first call to
 * `withClient(unitId)` and automatically closed when the consuming
 * scope finalizes.
 *
 * Clients are created per `unitId` via
 * {@link AsyncRtuTransport.createClient} and cached, so repeated
 * requests for the same unit ID reuse the same client.
 *
 * @see AsyncRtuTransport — Upstream `modbus-rs` RTU transport.
 * @see RtuTransportOpenOptions — Configuration for the RTU serial port.
 * @see createTransportScoped — Generic lifecycle logic from shared-transport.
 */
export class RtuTransportService extends Context.Service<
  RtuTransportService,
  TransportServiceApi
>()('RtuTransportService') {
  /**
   * Scoped constructor effect for the service. v4 does not auto-generate a
   * layer from this, so {@link RtuTransportService.make} builds one explicitly.
   */
  static readonly makeScoped = createTransportScoped<
    RtuTransportOpenOptions,
    AsyncSerialModbusClient,
    AsyncRtuTransport
  >(
    'AsyncRtuTransport',
    async (transportConstructor, options: RtuTransportOpenOptions) => {
      const portPath = await resolveSerialPortPath(options.portPath);
      // SAFETY: The constructor is read from the AsyncRtuTransport export named above.
      return (transportConstructor as typeof AsyncRtuTransport).open({ ...options, portPath });
    },
    'RtuTransportService',
    {
      nativeTimeout: {
        requestTimeoutMs: (options) => options.responseTimeoutMs ?? options.requestTimeoutMs,
        serializeRequests: true,
      },
    },
  );

  /**
   * Creates a {@link Layer} providing a live {@link RtuTransportService}.
   *
   * @param options - Serial RTU options and optional retry, reconnect, and connect-timeout settings.
   * @returns A layer whose scope opens the connection on first use and closes it on finalization.
   */
  static readonly make = (
    options: RtuTransportOpenOptions & TransportResilienceOptions,
  ): Layer.Layer<RtuTransportService> =>
    Layer.effect(RtuTransportService, RtuTransportService.makeScoped(options));
  /**
   * Creates a {@link Layer} providing an in-memory mock
   * {@link RtuTransportService} for testing or development.
   *
   * Accepts an array of {@link SlaveDeviceDefinition} values describing the
   * simulated Modbus slaves and their register/coil maps.
   *
   * @param devices - Slave device definitions for the mock.
   * @returns A factory that accepts transport, resilience, and mock-fault options and returns a layer for the mock service.
   *
   * @see makeMockTransport — The underlying mock factory.
   */
  static makeMockTransport = (devices: SlaveDeviceDefinitions) => {
    const factory = createMockTransport(devices);
    return (options: RtuTransportOpenOptions & TransportResilienceOptions & MockFaultOptions) =>
      Layer.effect(RtuTransportService, factory(options));
  };
}
