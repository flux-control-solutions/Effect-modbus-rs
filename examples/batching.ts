/**
 * Example demonstrating transaction batching over the mock RTU transport.
 *
 * Shows the three pieces that bring the transaction count down, and what each
 * one is for:
 *
 * 1. The planners, through `writeAll` and `readAll` — a caller that already
 *    holds a group of registers needs no window.
 * 2. The debounce windows — a caller with one fiber per register never holds
 *    two values at once, so the windows are the collection point that gives the
 *    planners something to pack.
 * 3. The cache — a write whose value the device already holds costs a
 *    turnaround and carries no information.
 *
 * A `Tracer` that records spans in memory reports what actually reached the bus.
 *
 * @example bun run examples/batching.ts
 */

import { Console, Effect, Layer, Tracer } from 'effect';

import { RtuTransportService } from '../src/RtuTransportService';

/** A device with 64 holding registers, all starting at zero. */
const device = {
  unitId: 3,
  coils: [],
  discreteInputs: [],
  holdingRegisters: Array.from({ length: 64 }, (_, index) => ({ address: index, default: 0 })),
  inputRegisters: [],
};

/** Records spans in memory, so the example can report the transaction count. */
const spans: Array<Tracer.NativeSpan> = [];
const tracerLayer = Layer.succeed(
  Tracer.Tracer,
  Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  }),
);

/** Sums one attribute over every span with the given name. */
const total = (name: string, attribute: string) =>
  spans
    .filter((span) => span.name === name)
    .reduce((sum, span) => sum + Number(new Map(span.attributes).get(attribute) ?? 0), 0);

const program = Effect.gen(function* () {
  const transport = yield* RtuTransportService;

  // ---------------------------------------------------------------------
  // 1. A caller that holds a group. No window needed: the planner packs it.
  // ---------------------------------------------------------------------
  const batched = yield* transport.withBatchingClient(3);

  yield* batched.writeAll(
    [0, 1, 2, 3].map((address) => ({ address, value: (address + 1) * 100 })),
    { 'app.group': 'analog outputs' },
  );
  yield* Console.log(
    `writeAll of 4 registers: ${total('modbus.write', 'modbus.transaction_count')} transaction`,
  );

  // Three spans of registers, two gaps between them.
  const parameters = [
    ...Array.from({ length: 30 }, (_, index) => index),
    0x20,
    0x21,
    ...Array.from({ length: 17 }, (_, index) => 0x29 + index),
  ];
  spans.length = 0;
  yield* batched.readAll(parameters);
  yield* Console.log(
    `readAll of ${parameters.length} parameters: ${total('modbus.read', 'modbus.transaction_count')} transactions`,
  );

  // ---------------------------------------------------------------------
  // 2. Callers that never meet. A window is what lets a planner see them.
  // ---------------------------------------------------------------------
  const debounced = yield* transport.withBatchingClient(4, {
    debounce: { writes: { window: '50 millis', maxHold: '200 millis' } },
  });

  spans.length = 0;
  yield* Effect.all(
    [
      debounced.write({ address: 0, value: 10 }, { 'app.point': 'Supply' }),
      debounced.write({ address: 1, value: 20 }, { 'app.point': 'Exhaust' }),
      debounced.write({ address: 2, value: 30 }, { 'app.point': 'Return' }),
    ],
    { concurrency: 'unbounded' },
  );
  const merged = new Map(spans.find((span) => span.name === 'modbus.write')?.attributes ?? []);
  yield* Console.log(
    `three independent writers: ${total('modbus.write', 'modbus.transaction_count')} transaction, ` +
      `carrying "${String(merged.get('app.point'))}"`,
  );

  // ---------------------------------------------------------------------
  // 3. The cache. A repeat of a value the device already holds goes nowhere.
  // ---------------------------------------------------------------------
  spans.length = 0;
  yield* batched.write({ address: 0, value: 100 }); // already 100 from writeAll
  yield* batched.write({ address: 0, value: 999 });
  yield* Console.log(
    `two writes, one of them a repeat: ${spans.filter((span) => span.name === 'modbus.write').length} span`,
  );

  // The span opens after the cache filter, and only when a write survives it,
  // so a suppressed write is not reported as an actuation that never happened.
});

const mockLayer = RtuTransportService.makeMockTransport([device, { ...device, unitId: 4 }])({
  portPath: '/dev/ttyUSB0',
  baudRate: 19200,
});

program.pipe(
  Effect.catch((err) => Console.log(`Unhandled error: ${err.message}`)),
  Effect.provide(mockLayer),
  Effect.provide(tracerLayer),
  Effect.scoped,
  Effect.runPromise,
);
