import type { WasmWsModbusClient, WasmWsTransport, WasmWsTransportOptions } from "modbus-rs/web";
import { Effect, Layer } from "effect";
import { makeTransportScoped } from "./shared-transport";
import { makeWasmEffectModbusClient } from "./modbus-client";
import { SlaveDeviceDefinitions, makeMockTransport } from "./mocks";

/**
 * Scoped Effect service wrapping `modbus-rs`'s browser {@link WasmWsTransport}
 * for Modbus TCP over a WebSocket gateway (browsers can't open raw TCP sockets).
 *
 * The transport connection is opened lazily on the first call to
 * `withClient(unitId)` and automatically closed when the consuming
 * {@link Effect.Scope | Scope} finalizes.
 *
 * Clients are created per `unitId` via {@link WasmWsTransport.createClient} and
 * cached, so repeated requests for the same unit ID reuse the same client.
 *
 * @see WasmWsTransport — Upstream `modbus-rs` browser WebSocket transport.
 * @see WasmWsTransportOptions — Configuration for the WebSocket gateway connection.
 * @see makeTransportScoped — Generic lifecycle logic from shared-transport.
 */
export class WasmWsTransportService extends Effect.Service<WasmWsTransportService>()(
  "WasmWsTransportService",
  {
    scoped: makeTransportScoped<WasmWsTransportOptions, WasmWsModbusClient, WasmWsTransport>(
      "WasmWsTransport",
      (TC: unknown, options: WasmWsTransportOptions) => (TC as typeof WasmWsTransport).connect(options),
      "WasmWsTransportService",
      { moduleSpecifier: "modbus-rs/web", toEffectClient: makeWasmEffectModbusClient },
    ),
  },
) {
  /**
   * Creates a {@link Layer} providing an in-memory mock
   * {@link WasmWsTransportService} for testing or development.
   *
   * Accepts an array of {@link SlaveDeviceDefinition} describing the
   * simulated Modbus slaves and their register/coil maps.
   *
   * @param devices - Slave device definitions for the mock.
   * @returns A function that takes {@link WasmWsTransportOptions} and
   *          returns a scoped {@link Layer} providing the mock service.
   *
   * @see makeMockTransport — The underlying mock factory.
   */
  static makeMockTransport = (devices: SlaveDeviceDefinitions) => {
    const factory = makeMockTransport(devices);
    return (options: WasmWsTransportOptions) =>
      Layer.scoped(
        WasmWsTransportService,
        factory(options) as unknown as Effect.Effect<WasmWsTransportService>,
      );
  };
}
