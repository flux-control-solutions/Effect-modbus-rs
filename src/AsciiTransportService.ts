import { Effect, Layer } from 'effect';
import type {
  AsyncAsciiTransport,
  AsyncSerialModbusClient,
  AsciiTransportOptions,
} from 'modbus-rs';

import { makeMockTransport, SlaveDeviceDefinitions } from './mocks';
import { makeTransportScoped } from './shared-transport';

/**
 * Scoped Effect service wrapping the `modbus-rs` {@link AsyncAsciiTransport}
 * for ASCII (serial) Modbus communication.
 *
 * The transport connection is opened lazily on the first call to
 * `withClient(unitId)` and automatically closed when the consuming
 * {@link Effect.Scope | Scope} finalizes.
 *
 * Clients are created per `unitId` via
 * {@link AsyncAsciiTransport.createClient} and cached, so repeated
 * requests for the same unit ID reuse the same client.
 *
 * @see AsyncAsciiTransport — Upstream `modbus-rs` ASCII transport.
 * @see AsciiTransportOptions — Configuration for the ASCII serial port.
 * @see makeTransportScoped — Generic lifecycle logic from shared-transport.
 */
export class AsciiTransportService extends Effect.Service<AsciiTransportService>()(
  'AsciiTransportService',
  {
    scoped: makeTransportScoped<
      AsciiTransportOptions,
      AsyncSerialModbusClient,
      AsyncAsciiTransport
    >(
      'AsyncAsciiTransport',
      (TC: unknown, options: AsciiTransportOptions) =>
        (TC as typeof AsyncAsciiTransport).open(options),
      'AsciiTransportService',
    ),
  },
) {
  /**
   * Creates a {@link Layer} providing an in-memory mock
   * {@link AsciiTransportService} for testing or development.
   *
   * Accepts an array of {@link SlaveDeviceDefinition} describing the
   * simulated Modbus slaves and their register/coil maps.
   *
   * @param devices - Slave device definitions for the mock.
   * @returns A function that takes {@link AsciiTransportOptions} and
   *          returns a scoped {@link Layer} providing the mock service.
   *
   * @see makeMockTransport — The underlying mock factory.
   */
  static makeMockTransport = (devices: SlaveDeviceDefinitions) => {
    const factory = makeMockTransport(devices);
    return (options: AsciiTransportOptions) =>
      Layer.scoped(
        AsciiTransportService,
        factory(options) as unknown as Effect.Effect<AsciiTransportService>,
      );
  };
}
