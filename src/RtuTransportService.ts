import { Effect, Layer } from 'effect';
import type { AsyncRtuTransport, AsyncSerialModbusClient, RtuTransportOptions } from 'modbus-rs';

import { makeMockTransport } from './mocks';
import type { MockFaultOptions } from './mocks';
import type { SlaveDeviceDefinitions } from './mocks';
import { makeTransportScoped } from './shared-transport';
import type { TransportResilienceOptions } from './shared-transport';

/**
 * Scoped Effect service wrapping the `modbus-rs` {@link AsyncRtuTransport}
 * for RTU (serial) Modbus communication.
 *
 * The transport connection is opened lazily on the first call to
 * `withClient(unitId)` and automatically closed when the consuming
 * {@link Effect.Scope | Scope} finalizes.
 *
 * Clients are created per `unitId` via
 * {@link AsyncRtuTransport.createClient} and cached, so repeated
 * requests for the same unit ID reuse the same client.
 *
 * @see AsyncRtuTransport — Upstream `modbus-rs` RTU transport.
 * @see RtuTransportOptions — Configuration for the RTU serial port.
 * @see makeTransportScoped — Generic lifecycle logic from shared-transport.
 */
export class RtuTransportService extends Effect.Service<RtuTransportService>()(
  'RtuTransportService',
  {
    scoped: makeTransportScoped<RtuTransportOptions, AsyncSerialModbusClient, AsyncRtuTransport>(
      'AsyncRtuTransport',
      (TC: unknown, options: RtuTransportOptions) => (TC as typeof AsyncRtuTransport).open(options),
      'RtuTransportService',
    ),
  },
) {
  /**
   * Creates a {@link Layer} providing an in-memory mock
   * {@link RtuTransportService} for testing or development.
   *
   * Accepts an array of {@link SlaveDeviceDefinition} describing the
   * simulated Modbus slaves and their register/coil maps.
   *
   * @param devices - Slave device definitions for the mock.
   * @returns A function that takes {@link RtuTransportOptions} and
   *          returns a scoped {@link Layer} providing the mock service.
   *
   * @see makeMockTransport — The underlying mock factory.
   */
  static makeMockTransport = (devices: SlaveDeviceDefinitions) => {
    const factory = makeMockTransport(devices);
    return (options: RtuTransportOptions & TransportResilienceOptions & MockFaultOptions) =>
      Layer.scoped(
        RtuTransportService,
        factory(options) as unknown as Effect.Effect<RtuTransportService>,
      );
  };
}
