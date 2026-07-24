/**
 * Basic example demonstrating Modbus RTU transport with a real serial device.
 *
 * Opens an RTU connection, reads holding registers and coils from unit ID 1,
 * and demonstrates error handling via `Effect.catchTags`.
 *
 * @example bun run examples/rtu-basic.ts
 */

import { Console, Effect, Layer, LogLevel, Logger } from 'effect';

import { RtuTransportService } from '../src/RtuTransportService';

const program = Effect.gen(function* () {
  const transport = yield* RtuTransportService;

  const client = yield* transport.withClient(1);

  const holdingRegisters = yield* client.readHoldingRegisters({
    address: 0,
    quantity: 10,
  });

  yield* Console.log('Holding registers:', holdingRegisters);

  const coils = yield* client.readCoils({ address: 0, quantity: 8 });

  yield* Console.log('Coils:', coils);
});

program.pipe(
  Effect.provide(
    RtuTransportService.Default({
      portPath: '/dev/ttyUSB0',
      baudRate: 9600,
    }).pipe(Layer.provide(Logger.pretty)),
  ),
  Effect.catchTags({
    ModbusTimeoutError: (err) => Console.log(`Timeout: ${err.message}`),
    ModbusTransportError: (err) => Console.log(`Transport error: ${err.message}`),
    ModbusConnectionClosedError: (err) => Console.log(`Connection lost: ${err.message}`),
    ModbusExceptionError: (err) => Console.log(`Modbus exception ${err.exception}: ${err.message}`),
    ModbusInvalidArgumentError: (err) => Console.log(`Invalid argument: ${err.message}`),
    ModbusInternalError: (err) => Console.log(`Internal error: ${err.message}`),
  }),
  Logger.withMinimumLogLevel(LogLevel.Debug),

  Effect.scoped,
  Effect.runPromise,
);
