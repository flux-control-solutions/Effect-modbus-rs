/**
 * Basic example demonstrating Modbus TCP transport with a real device.
 *
 * Connects to a remote Modbus/TCP device, reads holding registers and coils
 * from unit ID 1, and demonstrates error handling via `Effect.catchTags`.
 *
 * @example bun run examples/tcp-basic.ts
 */

import { Console, Effect } from "effect";
import { TcpTransportService } from "../src/TcpTransportService";

const program = Effect.gen(function* () {
  const transport = yield* TcpTransportService;

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
    TcpTransportService.Default({
      host: "192.168.1.100",
      port: 502,
    }),
  ),
  Effect.scoped,
  Effect.runPromise,
);
