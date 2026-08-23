import { Context, Effect, Layer } from 'effect';
import type { AsyncTcpModbusClient, AsyncTcpTransport, TcpTransportOptions } from 'modbus-rs';

import { SlaveDeviceDefinitions, makeMockTransport } from './mocks';
import type { MockFaultOptions } from './mocks';
import { makeTransportScoped } from './shared-transport';
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
 * {@link Effect.Scope | Scope} finalizes.
 *
 * Clients are created per `unitId` via
 * {@link AsyncTcpTransport.createClient} and cached, so repeated
 * requests for the same unit ID reuse the same client.
 *
 * @see AsyncTcpTransport — Upstream `modbus-rs` TCP transport.
 * @see TcpTransportOpenOptions — Configuration for the TCP connection.
 * @see makeTransportScoped — Generic lifecycle logic from shared-transport.
 */
export class TcpTransportService extends Context.Service<
  TcpTransportService,
  TransportServiceApi
>()('TcpTransportService') {
  /**
   * Scoped constructor effect for the service. v4 does not auto-generate a
   * layer from this, so {@link TcpTransportService.make} builds one explicitly.
   */
  static readonly makeScoped = makeTransportScoped<
    TcpTransportOpenOptions,
    AsyncTcpModbusClient,
    AsyncTcpTransport
  >(
    'AsyncTcpTransport',
    (TC: unknown, options: TcpTransportOpenOptions) =>
      (TC as typeof AsyncTcpTransport).connect(options),
    'TcpTransportService',
  );

  /**
   * Creates a {@link Layer} providing a live {@link TcpTransportService}.
   *
   * @param options - Connection and resilience options for the TCP transport.
   */
  static readonly make = (
    options: TcpTransportOpenOptions & TransportResilienceOptions,
  ): Layer.Layer<TcpTransportService> =>
    Layer.effect(TcpTransportService, TcpTransportService.makeScoped(options));

  /**
   * Creates a {@link Layer} providing an in-memory mock
   * {@link TcpTransportService} for testing or development.
   *
   * Accepts an array of {@link SlaveDeviceDefinition} describing the
   * simulated Modbus slaves and their register/coil maps.
   *
   * @param devices - Slave device definitions for the mock.
   * @returns A function that takes {@link TcpTransportOpenOptions} and
   *          returns a scoped {@link Layer} providing the mock service.
   *
   * @see makeMockTransport — The underlying mock factory.
   */
  static makeMockTransport = (devices: SlaveDeviceDefinitions) => {
    const factory = makeMockTransport(devices);
    return (options: TcpTransportOpenOptions & TransportResilienceOptions & MockFaultOptions) =>
      Layer.effect(
        TcpTransportService,
        factory(options) as unknown as Effect.Effect<TransportServiceApi>,
      );
  };
}
