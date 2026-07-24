import { Effect, Layer } from 'effect';
import type { AsyncTcpModbusClient, AsyncTcpTransport, TcpTransportOptions } from 'modbus-rs';

import { SlaveDeviceDefinitions, makeMockTransport } from './mocks';
import { makeTransportScoped } from './shared-transport';

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
 * @see TcpTransportOptions — Configuration for the TCP connection.
 * @see makeTransportScoped — Generic lifecycle logic from shared-transport.
 */
export class TcpTransportService extends Effect.Service<TcpTransportService>()(
  'TcpTransportService',
  {
    scoped: makeTransportScoped<TcpTransportOptions, AsyncTcpModbusClient, AsyncTcpTransport>(
      'AsyncTcpTransport',
      (TC: unknown, options: TcpTransportOptions) =>
        (TC as typeof AsyncTcpTransport).connect(options),
      'TcpTransportService',
    ),
  },
) {
  /**
   * Creates a {@link Layer} providing an in-memory mock
   * {@link TcpTransportService} for testing or development.
   *
   * Accepts an array of {@link SlaveDeviceDefinition} describing the
   * simulated Modbus slaves and their register/coil maps.
   *
   * @param devices - Slave device definitions for the mock.
   * @returns A function that takes {@link TcpTransportOptions} and
   *          returns a scoped {@link Layer} providing the mock service.
   *
   * @see makeMockTransport — The underlying mock factory.
   */
  static makeMockTransport = (devices: SlaveDeviceDefinitions) => {
    const factory = makeMockTransport(devices);
    return (options: TcpTransportOptions) =>
      Layer.scoped(
        TcpTransportService,
        factory(options) as unknown as Effect.Effect<TcpTransportService>,
      );
  };
}
