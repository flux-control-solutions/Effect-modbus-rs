/**
 * Example demonstrating the mock TCP transport layer with multiple devices.
 *
 * Creates an in-memory TCP transport with
 * {@link TcpTransportService.makeMockRtuTransport},
 * simulates two Modbus slave devices (unit IDs 1 and 2) with different register maps,
 * and exercises read/write operations on both devices.
 *
 * @example bun run examples/tcp-mock.ts
 */

import { Console, Effect } from "effect";
import { TcpTransportService } from "../src/TcpTransportService";

const devices = [
  {
    unitId: 1,
    coils: [
      { address: 0, default: false },
      { address: 1, default: false },
      { address: 2, default: false },
    ],
    discreteInputs: [
      { address: 0, default: true },
      { address: 1, default: false },
    ],
    holdingRegisters: [],
    inputRegisters: [],
  },
  {
    unitId: 2,
    coils: [],
    discreteInputs: [],
    holdingRegisters: [
      { address: 0, default: 42 },
      { address: 1, default: 99 },
    ],
    inputRegisters: [
      { address: 0, default: 1000 },
    ],
  },
];

const program = Effect.gen(function* () {
  const transport = yield* TcpTransportService;

  const device1 = yield* transport.withClient(1);
  const coils = yield* device1.readCoils({ address: 0, quantity: 3 });
  console.log("Unit 1 coils:", coils);

  const discreteInputs = yield* device1.readDiscreteInputs({
    address: 0,
    quantity: 2,
  });
  console.log("Unit 1 discrete inputs:", discreteInputs);

  yield* device1.writeMultipleCoils({
    address: 0,
    values: [true, true, true],
  });
  const coilsAfter = yield* device1.readCoils({ address: 0, quantity: 3 });
  console.log("Unit 1 coils (after):", coilsAfter);

  const device2 = yield* transport.withClient(2);
  const holdingRegisters = yield* device2.readHoldingRegisters({
    address: 0,
    quantity: 2,
  });
  console.log("Unit 2 holding registers:", holdingRegisters);

  const inputRegisters = yield* device2.readInputRegisters({
    address: 0,
    quantity: 1,
  });
  console.log("Unit 2 input registers:", inputRegisters);

  yield* device2.writeMultipleRegisters({
    address: 0,
    values: [100, 200],
  });
  const holdingAfter = yield* device2.readHoldingRegisters({
    address: 0,
    quantity: 2,
  });
  console.log("Unit 2 holding registers (after):", holdingAfter);
});

const mockLayer = TcpTransportService.makeMockRtuTransport(devices)({
  host: "127.0.0.1",
  port: 502,
});

program.pipe(
  Effect.catchTags({
    ModbusInvalidArgumentError: (err) =>
      Console.log(`Invalid argument: ${err.message}`),
  }),
  Effect.catchAll((err) => Console.log(`Unhandled error: ${err.message}`)),
  Effect.provide(mockLayer),
  Effect.scoped,
  Effect.runPromise,
);
