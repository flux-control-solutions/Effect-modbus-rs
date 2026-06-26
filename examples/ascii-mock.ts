/**
 * Example demonstrating the mock ASCII transport layer.
 *
 * Creates an in-memory ASCII transport with
 * {@link AsciiTransportService.makeMockTransport},
 * simulates read/write operations (including `readWriteMultipleRegisters`),
 * and verifies out-of-range error handling.
 *
 * @example bun run examples/ascii-mock.ts
 */

import { Console, Effect } from "effect";
import { AsciiTransportService } from "../src/AsciiTransportService";

const device = {
  unitId: 1,
  coils: [{ address: 0, default: true }],
  discreteInputs: [{ address: 0, default: false }],
  holdingRegisters: [
    { address: 0, default: 10 },
    { address: 1, default: 20 },
    { address: 2, default: 30 },
  ],
  inputRegisters: [{ address: 0, default: 500 }],
};

const program = Effect.gen(function* () {
  const transport = yield* AsciiTransportService;

  const client = yield* transport.withClient(1);

  const readResult = yield* client.readWriteMultipleRegisters({
    readAddress: 0,
    readQuantity: 3,
    writeAddress: 0,
    writeValues: [11, 22, 33],
  });
  console.log("ReadWriteMultipleRegisters result:", readResult);

  const registers = yield* client.readHoldingRegisters({
    address: 0,
    quantity: 3,
  });
  console.log("Holding registers (after r/w):", registers);

  const discreteInputs = yield* client.readDiscreteInputs({
    address: 0,
    quantity: 1,
  });
  console.log("Discrete inputs:", discreteInputs);

  const inputRegisters = yield* client.readInputRegisters({
    address: 0,
    quantity: 1,
  });
  console.log("Input registers:", inputRegisters);

  yield* client
    .readHoldingRegisters({ address: 10, quantity: 1 })
    .pipe(
      Effect.catchTag("ModbusInvalidArgumentError", (err) =>
        Effect.sync(() => {
          console.log("Expected out-of-range error:", err.message);
          return [] as number[];
        }),
      ),
    );
});

const mockLayer = AsciiTransportService.makeMockTransport([device])({
  portPath: "/dev/ttyUSB0",
  baudRate: 9600,
});

program.pipe(
  Effect.catchTags({
    ModbusInvalidArgumentError: (err) =>
      Console.log(`Caught invalid argument: ${err.message}`),
  }),
  Effect.catchAll((err) => Console.log(`Unhandled error: ${err.message}`)),
  Effect.provide(mockLayer),
  Effect.scoped,
  Effect.runPromise,
);
