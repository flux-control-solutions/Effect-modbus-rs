import type { AsyncRtuTransport, AsyncSerialModbusClient, RtuTransportOptions } from "modbus-rs";
import { Effect, Layer } from "effect";
import { makeTransportScoped } from "./shared-transport";
import { makeMockTransport } from "./mocks";
import type { SlaveDeviceDefinitions } from "./mocks";

export class RtuTransportService extends Effect.Service<RtuTransportService>()(
  "RtuTransportService",
  {
    scoped: makeTransportScoped<RtuTransportOptions, AsyncSerialModbusClient, AsyncRtuTransport>(
      "AsyncRtuTransport",
      (TC: unknown, options: RtuTransportOptions) =>
        (TC as typeof AsyncRtuTransport).open(options),
      "RtuTransportService",
    ),
  },
) {
  static makeMockTransport = (devices: SlaveDeviceDefinitions) => {
    const factory = makeMockTransport(devices);
    return (options: RtuTransportOptions) =>
      Layer.scoped(
        RtuTransportService,
        factory(options) as unknown as Effect.Effect<RtuTransportService>,
      );
  };
}
