/**
 * Example demonstrating the abstract {@link SerialTransportService}.
 *
 * The program depends only on `SerialTransportService` — the same
 * code works with either ASCII or RTU framing, or with a mock.
 *
 * Uncomment one of the `layer` alternatives below to switch the
 * backing implementation.
 *
 * @example bun run examples/serial-abstract.ts
 */

import { Console, Effect } from 'effect';

import { SerialTransportService } from '../src/SerialTransportService';

const device = {
  unitId: 1,
  coils: [
    { address: 0, default: true },
    { address: 1, default: false },
  ],
  discreteInputs: [],
  holdingRegisters: [
    { address: 0, default: 100 },
    { address: 1, default: 200 },
  ],
  inputRegisters: [],
};

const program = Effect.gen(function* () {
  const transport = yield* SerialTransportService;

  const client = yield* transport.withClient(1);

  const coils = yield* client.readCoils({ address: 0, quantity: 2 });
  yield* Console.log('Coils:', coils);

  const registers = yield* client.readHoldingRegisters({
    address: 0,
    quantity: 2,
  });
  yield* Console.log('Holding registers:', registers);
});

// Pick one backing implementation — same program works with all three:
const layer = SerialTransportService.makeMockTransport([device])({
  portPath: '/dev/ttyUSB0',
  baudRate: 9600,
});
// const layer = SerialTransportService.fromRtu({ path: "/dev/ttyUSB0", baudRate: 9600 });
// const layer = SerialTransportService.fromAscii({ path: "/dev/ttyUSB0", baudRate: 9600 });

program.pipe(
  Effect.catchAll((err) => Console.log(`Error: ${err.message}`)),
  Effect.provide(layer),
  Effect.scoped,
  Effect.runPromise,
);
