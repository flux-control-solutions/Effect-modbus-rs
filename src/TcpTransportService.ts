/** Provides scoped TCP Modbus transport layers and an in-memory mock layer. */
import { Context, Layer } from 'effect';
import type { AsyncTcpModbusClient, AsyncTcpTransport, TcpTransportOptions } from 'modbus-rs';

import { createMockTransport, type MockFaultOptions, type SlaveDeviceDefinitions } from './mocks';
import { createTransportScoped } from './shared-transport';
import type {
  TransportResilienceOptions,
  TransportServiceApi,
  WithoutUpstreamRetry,
} from './shared-transport';

/**
 * {@link TcpTransportOptions} minus the upstream retry knobs.
 *
 * @see WithoutUpstreamRetry — Why they are withheld.
 */
export type TcpTransportOpenOptions = WithoutUpstreamRetry<TcpTransportOptions>;

/**
 * Scoped Effect service wrapping the `modbus-rs` {@link AsyncTcpTransport}
 * for TCP/IP Modbus communication.
 *
 * The transport connection is opened lazily on the first call to
 * `withClient(unitId)` and automatically closed when the consuming
 * scope finalizes.
 *
 * Clients are created per `unitId` via
 * {@link AsyncTcpTransport.createClient} and cached, so repeated
 * requests for the same unit ID reuse the same client.
 *
 * @see AsyncTcpTransport — Upstream `modbus-rs` TCP transport.
 * @see TcpTransportOpenOptions — Configuration for the TCP connection.
 * @see createTransportScoped — Generic lifecycle logic from shared-transport.
 */
export class TcpTransportService extends Context.Service<
  TcpTransportService,
  TransportServiceApi
>()('TcpTransportService') {
  /**
   * Scoped constructor effect for the service. v4 does not auto-generate a
   * layer from this, so {@link TcpTransportService.make} builds one explicitly.
   */
  static readonly makeScoped = createTransportScoped<
    TcpTransportOpenOptions,
    AsyncTcpModbusClient,
    AsyncTcpTransport
  >(
    'AsyncTcpTransport',
    (transportConstructor, options: TcpTransportOpenOptions) => {
      // SAFETY: The constructor is read from the AsyncTcpTransport export named above.
      return (transportConstructor as typeof AsyncTcpTransport).connect(options);
    },
    'TcpTransportService',
    {
      nativeTimeout: {
        requestTimeoutMs: (options) => options.requestTimeoutMs,
        // TCP sends each request at once, so concurrent requests keep their full time limit.
        serializeRequests: false,
      },
    },
  );

  /**
   * Creates a {@link Layer} providing a live {@link TcpTransportService}.
   *
   * @param options - TCP connection options and optional retry, reconnect, and connect-timeout settings.
   * @returns A layer whose scope opens the connection on first use and closes it on finalization.
   */
  static readonly make = (
    options: TcpTransportOpenOptions & TransportResilienceOptions,
  ): Layer.Layer<TcpTransportService> =>
    Layer.effect(TcpTransportService, TcpTransportService.makeScoped(options));

  /**
   * Creates a {@link Layer} providing an in-memory mock
   * {@link TcpTransportService} for testing or development.
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
    return (options: TcpTransportOpenOptions & TransportResilienceOptions & MockFaultOptions) =>
      Layer.effect(TcpTransportService, factory(options));
  };
}
