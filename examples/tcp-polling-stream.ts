/**
 * TCP polling stream example.
 *
 * Polls a localhost Modbus/TCP device every 5 seconds, yielding
 * holding-register values as a `Stream`. The stream is consumed
 * eagerly (despite errors) and each poll result is logged.
 *
 * @example bun run examples/tcp-polling-stream.ts
 */

import { BunRuntime } from '@effect/platform-bun';
import { Console, Effect, Either, LogLevel, Logger, Schedule, Stream } from 'effect';

import { TcpTransportService } from '../src/TcpTransportService';

const program = Effect.gen(function* () {
  const transport = yield* TcpTransportService;
  const client = yield* transport.withClient(1);

  const poll = Effect.either(
    client.readHoldingRegisters({ address: 0, quantity: 10 }).pipe(
      Effect.catchTags({
        ModbusConnectionClosedError: (err) =>
          Console.log(`Connection lost, reconnecting... (${err.message})`).pipe(
            Effect.andThen(transport.reconnect),
            Effect.andThen(Effect.fail(err)),
          ),
        ModbusTransportError: (err) =>
          Console.log(`Transport error, reconnecting... (${err.message})`).pipe(
            Effect.andThen(transport.reconnect),
            Effect.andThen(Effect.fail(err)),
          ),
      }),
    ),
  );

  const stream = Stream.repeatEffectWithSchedule(poll, Schedule.spaced('5 seconds'));

  yield* Stream.runForEach(stream, (result) =>
    Either.match(result, {
      onLeft: (error) => Console.log(`[${new Date().toISOString()}] Poll failed: ${error.message}`),
      onRight: (registers) =>
        Console.log(`[${new Date().toISOString()}] Holding registers [0..9]:`, registers),
    }),
  );
});

BunRuntime.runMain(
  program.pipe(
    Effect.provide(
      TcpTransportService.Default({
        host: 'localhost',
        port: 502,
      }),
    ),
    Effect.catchTags({
      ModbusTimeoutError: (err) => Console.log(`Timeout: ${err.message}`),
      ModbusTransportError: (err) => Console.log(`Transport error: ${err.message}`),
      ModbusConnectionClosedError: (err) => Console.log(`Connection lost: ${err.message}`),
      ModbusExceptionError: (err) =>
        Console.log(`Modbus exception ${err.exception}: ${err.message}`),
      ModbusInvalidArgumentError: (err) => Console.log(`Invalid argument: ${err.message}`),
      ModbusInternalError: (err) => Console.log(`Internal error: ${err.message}`),
    }),
    Logger.withMinimumLogLevel(LogLevel.Debug),
    Effect.scoped,
  ),
);
