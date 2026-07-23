import type {
  WasmRtuTransport,
  WasmSerialModbusClient,
  WasmSerialPortHandle,
  WasmSerialTransportOptions,
} from "modbus-rs/web";
import { Effect, Layer } from "effect";
import { makeTransportScoped } from "./shared-transport";
import { makeWasmEffectModbusClient } from "./modbus-client";
import { SlaveDeviceDefinitions, makeMockTransport } from "./mocks";

/**
 * Options for {@link WasmRtuTransportService}. `WasmRtuTransport.open()` takes the
 * serial port handle and the connection options as two separate arguments; this
 * combines them into one object so it fits {@link makeTransportScoped}'s single-options
 * shape, with `port` destructured back out inside the service's `openMethod`.
 *
 * @see requestSerialPort — Obtains the `port` handle (must be called from a user gesture).
 */
export type WasmRtuTransportOpenOptions = WasmSerialTransportOptions & {
  port: WasmSerialPortHandle;
};

/**
 * Scoped Effect service wrapping `modbus-rs`'s browser {@link WasmRtuTransport}
 * for Modbus RTU over the Web Serial API.
 *
 * The transport connection is opened lazily on the first call to
 * `withClient(unitId)` and automatically closed when the consuming
 * {@link Effect.Scope | Scope} finalizes.
 *
 * Clients are created per `unitId` via {@link WasmRtuTransport.createClient} and
 * cached, so repeated requests for the same unit ID reuse the same client.
 *
 * @see WasmRtuTransport — Upstream `modbus-rs` browser Web Serial RTU transport.
 * @see requestSerialPort — Obtains the serial port handle this service's `port` option needs.
 * @see makeTransportScoped — Generic lifecycle logic from shared-transport.
 */
export class WasmRtuTransportService extends Effect.Service<WasmRtuTransportService>()(
  "WasmRtuTransportService",
  {
    scoped: makeTransportScoped<WasmRtuTransportOpenOptions, WasmSerialModbusClient, WasmRtuTransport>(
      "WasmRtuTransport",
      (TC: unknown, { port, ...rest }: WasmRtuTransportOpenOptions) =>
        (TC as typeof WasmRtuTransport).open(port, rest),
      "WasmRtuTransportService",
      { moduleSpecifier: "modbus-rs/web", toEffectClient: makeWasmEffectModbusClient },
    ),
  },
) {
  /**
   * Creates a {@link Layer} providing an in-memory mock
   * {@link WasmRtuTransportService} for testing or development.
   *
   * Accepts an array of {@link SlaveDeviceDefinition} describing the
   * simulated Modbus slaves and their register/coil maps.
   *
   * @param devices - Slave device definitions for the mock.
   * @returns A function that takes {@link WasmRtuTransportOpenOptions} and
   *          returns a scoped {@link Layer} providing the mock service.
   *
   * @see makeMockTransport — The underlying mock factory.
   */
  static makeMockTransport = (devices: SlaveDeviceDefinitions) => {
    const factory = makeMockTransport(devices);
    return (options: WasmRtuTransportOpenOptions) =>
      Layer.scoped(
        WasmRtuTransportService,
        factory(options) as unknown as Effect.Effect<WasmRtuTransportService>,
      );
  };
}
