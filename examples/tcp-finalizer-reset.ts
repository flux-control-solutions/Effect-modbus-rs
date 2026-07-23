/**
 * Demonstrates using scope finalizers to reset Modbus device state.
 *
 * Writes values to a mock device, registers a finalizer that resets
 * them to 0, then verifies the reset after the scope exits.
 *
 * The finalizer via `Effect.addFinalizer` runs automatically when the
 * enclosing `Effect.scoped` block completes (success, failure, or
 * interruption), ensuring cleanup even on error paths.
 *
 * @example bun run examples/tcp-finalizer-reset.ts
 */

import { Console, Effect } from "effect";
import { CoilState } from "modbus-rs";
import { TcpTransportService } from "../src/TcpTransportService";

const device = {
  unitId: 1,
  coils: [{ address: 0, default: false }],
  discreteInputs: [],
  holdingRegisters: [
    { address: 0, default: 0 },
    { address: 1, default: 0 },
    { address: 2, default: 0 },
  ],
  inputRegisters: [],
};

const program = Effect.gen(function* () {
  const transport = yield* TcpTransportService;

  // Inner scope — writes values, registers finalizer.
  // When this scope exits, the finalizer runs and resets everything to 0.
  yield* Effect.scoped(
    Effect.gen(function* () {
      const client = yield* transport.withClient(1);

      yield* client.writeMultipleRegisters({
        address: 0,
        values: new Uint16Array([100, 200, 300]),
      });
      yield* client.writeSingleCoil({ address: 0, value: CoilState.On });

      const regsBefore = yield* client.readHoldingRegisters({
        address: 0,
        quantity: 3,
      });
      yield* Console.log("Before scope exit:", {
        registers: regsBefore,
      });

      // Finalizer runs when the inner scope closes (success, failure, or
      // interruption). It resets registers and coils back to 0.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Console.log(">>> Finalizer: resetting values to 0...");
          yield* client
            .writeMultipleRegisters({
              address: 0,
              values: new Uint16Array([0, 0, 0]),
            })
            .pipe(Effect.catchAll((err) => Console.log(err.message)));
          yield* client
            .writeSingleCoil({ address: 0, value: CoilState.Off })
            .pipe(Effect.catchAll((err) => Console.log(err.message)));
        }),
      );
    }),
  );

  // Inner scope closed — finalizer has already run.
  const verifyClient = yield* transport.withClient(1);
  const regsAfter = yield* verifyClient.readHoldingRegisters({
    address: 0,
    quantity: 3,
  });
  const coilsAfter = yield* verifyClient.readCoils({
    address: 0,
    quantity: 1,
  });
  yield* Console.log("After finalizer:", {
    registers: regsAfter,
    coils: coilsAfter,
  });
});

const mockLayer = TcpTransportService.makeMockTransport([device])({
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
