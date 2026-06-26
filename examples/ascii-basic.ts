/**
 * Basic example demonstrating Modbus ASCII transport with a real serial device.
 *
 * Opens an ASCII connection, reads holding registers and coils from unit ID 1,
 * and demonstrates error handling via `Effect.catchTags`.
 *
 * @example bun run examples/ascii-basic.ts
 */

import { Console, Effect } from "effect";
import { AsciiTransportService } from "../src/AsciiTransportService";

const program = Effect.gen(function* () {
  const transport = yield* AsciiTransportService;

  const client = yield* transport.withClient(1);

  const holdingRegisters = yield* client.readHoldingRegisters({
    address: 0,
    quantity: 10,
  });

  console.log("Holding registers:", holdingRegisters);

  const coils = yield* client.readCoils({ address: 0, quantity: 8 });

  console.log("Coils:", coils);
});

program.pipe(
  Effect.catchTags({
    ModbusTimeoutError: (err) => Console.log(`Timeout: ${err.message}`),
    ModbusConnectionClosedError: (err) =>
      Console.log(`Connection lost: ${err.message}`),
    ModbusExceptionError: (err) =>
      Console.log(`Modbus exception ${err.exception}: ${err.message}`),
    ModbusInvalidArgumentError: (err) =>
      Console.log(`Invalid argument: ${err.message}`),
  }),
  Effect.catchAll((err) => Console.log(`Unhandled error: ${err.message}`)),
  Effect.provide(
    AsciiTransportService.Default({
      portPath: "/dev/ttyUSB0",
      baudRate: 9600,
    }),
  ),
  Effect.scoped,
  Effect.runPromise,
);
