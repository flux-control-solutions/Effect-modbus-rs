/**
 * Example demonstrating the mock RTU transport layer.
 *
 * Creates an in-memory RTU transport with
 * {@link RtuTransportService.makeMockRtuTransport},
 * simulates read/write operations on coils and holding registers,
 * and verifies the state is updated correctly after writes.
 *
 * @example bun run examples/rtu-mock.ts
 */

import { Console, Effect } from "effect";
import { RtuTransportService } from "../src/RtuTransportService";

const device = {
  unitId: 1,
  coils: [
    { address: 0, default: true },
    { address: 1, default: false },
    { address: 2, default: true },
  ],
  discreteInputs: [],
  holdingRegisters: [
    { address: 0, default: 100 },
    { address: 1, default: 200 },
    { address: 2, default: 300 },
  ],
  inputRegisters: [],
};

const program = Effect.gen(function* () {
  const transport = yield* RtuTransportService;

  const client = yield* transport.withClient(1);

  const coils = yield* client.readCoils({ address: 0, quantity: 3 });
  console.log("Coils (before):", coils);

  yield* client.writeSingleCoil({ address: 1, value: true });

  const coilsAfter = yield* client.readCoils({ address: 0, quantity: 3 });
  console.log("Coils (after):", coilsAfter);

  const registers = yield* client.readHoldingRegisters({
    address: 0,
    quantity: 3,
  });
  console.log("Holding registers:", registers);

  yield* client.writeSingleRegister({ address: 2, value: 999 });

  const registersAfter = yield* client.readHoldingRegisters({
    address: 0,
    quantity: 3,
  });
  console.log("Holding registers (after):", registersAfter);
});

const mockLayer = RtuTransportService.makeMockRtuTransport([device])({
  portPath: "/dev/ttyUSB0",
  baudRate: 9600,
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
