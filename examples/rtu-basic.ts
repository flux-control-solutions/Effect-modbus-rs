import { Console, Effect } from "effect";
import { RtuTransportService } from "../src/RtuTransportService";

const program = Effect.gen(function* () {
  const transport = yield* RtuTransportService;

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
    RtuTransportService.Default({
      portPath: "/dev/ttyUSB0",
      baudRate: 9600,
    }),
  ),
  Effect.scoped,
  Effect.runPromise,
);
