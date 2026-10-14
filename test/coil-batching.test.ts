import { expect, test } from 'bun:test';

import { Effect, Fiber, Layer, Tracer } from 'effect';

import type { SlaveDeviceDefinitions } from '../src/mocks';
import { RtuTransportService } from '../src/RtuTransportService';

/** Tests coil batching: planned writes, the coil cache, gap filling, reads, and guards. */

// The value is not a boolean on purpose. `JSON.parse` returns an untyped value,
// as data from a caller outside the type system does. The test checks the guard.
const notBoolean: boolean = JSON.parse('1');

const devices: SlaveDeviceDefinitions = [
  {
    unitId: 3,
    // Coil 2 starts ON, so a gap fill that writes OFF over it is visible.
    coils: Array.from({ length: 400 }, (_, address) => ({ address, default: address === 2 })),
    discreteInputs: [],
    holdingRegisters: [{ address: 0, default: 0 }],
    inputRegisters: [],
  },
];

const run = <A, E>(effect: Effect.Effect<A, E, RtuTransportService>) =>
  Effect.runPromise(
    Effect.provide(
      effect,
      RtuTransportService.makeMockTransport(devices)({ portPath: '/dev/null', baudRate: 19200 }),
    ),
  );

/** A `Tracer` that records spans in memory. */
const makeSpanCapture = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, layer: Layer.succeed(Tracer.Tracer, tracer) };
};

const attributesOf = (spans: ReadonlyArray<Tracer.NativeSpan>, name: string) =>
  spans.filter((span) => span.name === name).map((span) => new Map(span.attributes));

/** Reads coils on the raw client, as booleans. */
const rawCoils = (address: number, quantity: number) =>
  Effect.gen(function* () {
    const transport = yield* RtuTransportService;
    const raw = yield* transport.withClient(3);
    const states = yield* raw.readCoils({ address, quantity });
    return states.map((state) => state === 1);
  });

test('a coil group reaches the device in one FC15 transaction', async () => {
  const capture = makeSpanCapture();

  const states = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3, { coils: true });
      yield* batched.coils!.writeAll(
        [10, 11, 12, 13].map((address) => ({ address, value: address % 2 === 0 })),
        { 'app.group': 'relays' },
      );
      return yield* rawCoils(10, 4);
    }).pipe(Effect.provide(capture.layer)),
  );

  expect(states).toEqual([true, false, true, false]);
  const writes = attributesOf(capture.spans, 'modbus.write');
  expect(writes).toHaveLength(1);
  expect(writes[0]!.get('modbus.table')).toBe('coils');
  expect(writes[0]!.get('modbus.coil_count')).toBe(4);
  expect(writes[0]!.get('modbus.transaction_count')).toBe(1);
  expect(writes[0]!.get('app.group')).toBe('relays');
});

test('a unit without coil batching has no coil client and keeps raw coil writes', async () => {
  const result = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3);
      const raw = yield* transport.withClient(3);
      yield* raw.writeSingleCoil({ address: 5, value: 1 });
      return { coils: batched.coils, states: yield* rawCoils(5, 1) };
    }),
  );

  expect(result.coils).toBeUndefined();
  expect(result.states).toEqual([true]);
});

test('coil batching guards raw coil writes for its unit', async () => {
  const failures = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const raw = yield* transport.withClient(3);
      yield* transport.withBatchingClient(3, { coils: true });
      const results = yield* Effect.all([
        Effect.result(raw.writeSingleCoil({ address: 0, value: 1 })),
        Effect.result(raw.writeMultipleCoils({ address: 0, values: [1, 0] })),
        Effect.result(raw.readCoils({ address: 0, quantity: 1 })),
      ]);
      return results.map((result) => result._tag);
    }),
  );

  expect(failures).toEqual(['Failure', 'Failure', 'Success']);
});

test('the coil cache suppresses an unchanged coil and a bypass sends it', async () => {
  const capture = makeSpanCapture();

  await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3, { coils: true });
      const coils = batched.coils!;
      yield* coils.writeNow({ address: 7, value: true });
      capture.spans.length = 0;
      yield* coils.writeNow({ address: 7, value: true });
      yield* coils.writeNow({ address: 7, value: true }, undefined, { bypassCache: true });
    }).pipe(Effect.provide(capture.layer)),
  );

  const writes = attributesOf(capture.spans, 'modbus.write');
  expect(writes).toHaveLength(1);
  expect(writes[0]!.get('modbus.bypassed_count')).toBe(1);
});

test('flagged coil writes to the same address count as one coil', async () => {
  const capture = makeSpanCapture();

  await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3, { coils: true });
      yield* batched.coils!.writeAllNow(
        [
          { address: 7, value: true },
          { address: 7, value: false },
        ],
        undefined,
        { bypassCache: true },
      );
    }).pipe(Effect.provide(capture.layer)),
  );

  // Only the last state reaches the device. The earlier write is replaced.
  const writes = attributesOf(capture.spans, 'modbus.write');
  expect(writes[0]!.get('modbus.coil_count')).toBe(1);
  expect(writes[0]!.get('modbus.suppressed_count')).toBe(1);
  expect(writes[0]!.get('modbus.bypassed_count')).toBe(0);
});

test('the cache fills gap coils without a read', async () => {
  const capture = makeSpanCapture();

  const states = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3, {
        coils: { plan: { writes: { maxGap: 2 } } },
      });
      const coils = batched.coils!;
      // The first group makes every coil in 20..25 known to the cache.
      yield* coils.writeAllNow(
        [20, 21, 22, 23, 24, 25].map((address) => ({ address, value: true })),
      );
      capture.spans.length = 0;
      yield* coils.writeAllNow([
        { address: 20, value: false },
        { address: 21, value: false },
        { address: 24, value: false },
        { address: 25, value: false },
      ]);
      return yield* rawCoils(20, 6);
    }).pipe(Effect.provide(capture.layer)),
  );

  expect(states).toEqual([false, false, true, true, false, false]);
  const writes = attributesOf(capture.spans, 'modbus.write');
  expect(writes).toHaveLength(1);
  expect(writes[0]!.get('modbus.transaction_count')).toBe(1);
  expect(writes[0]!.get('modbus.gap_read_count')).toBe(0);
  expect(capture.spans.filter((span) => span.name === 'modbus.read')).toHaveLength(0);
});

test('a gap the cache does not know is read back before the FC15 write', async () => {
  const capture = makeSpanCapture();

  const states = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3, {
        coils: { cache: false, plan: { writes: { maxGap: 1 } } },
      });
      // Coil 2 is ON on the device. The write must not turn it OFF.
      yield* batched.coils!.writeAllNow([
        { address: 0, value: true },
        { address: 1, value: true },
        { address: 3, value: true },
      ]);
      return yield* rawCoils(0, 4);
    }).pipe(Effect.provide(capture.layer)),
  );

  expect(states).toEqual([true, true, true, true]);
  const writes = attributesOf(capture.spans, 'modbus.write');
  expect(writes[0]!.get('modbus.transaction_count')).toBe(1);
  expect(writes[0]!.get('modbus.gap_read_count')).toBe(1);
});

test('the filtered coil plan keeps a run whole when the cache knows the gaps', async () => {
  const capture = makeSpanCapture();

  await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3, { coils: true });
      const coils = batched.coils!;
      const addresses = Array.from({ length: 11 }, (_, index) => 100 + index);
      yield* coils.writeAllNow(addresses.map((address) => ({ address, value: false })));
      capture.spans.length = 0;
      // The odd addresses change. Five FC05 steps would cost more than one FC15.
      yield* coils.writeAllNow(addresses.map((address) => ({ address, value: address % 2 === 1 })));
    }).pipe(Effect.provide(capture.layer)),
  );

  const writes = attributesOf(capture.spans, 'modbus.write');
  expect(writes).toHaveLength(1);
  expect(writes[0]!.get('modbus.transaction_count')).toBe(1);
  expect(writes[0]!.get('modbus.coil_count')).toBe(11);
});

test('collected coil reads share one FC01 transaction', async () => {
  const capture = makeSpanCapture();

  const states = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3, {
        coils: true,
        debounce: { reads: { window: '20 millis' } },
      });
      return yield* Effect.all(
        [0, 1, 2, 3, 299].map((address) => batched.coils!.read(address)),
        { concurrency: 'unbounded' },
      );
    }).pipe(Effect.provide(capture.layer)),
  );

  expect(states).toEqual([false, false, true, false, false]);
  const reads = attributesOf(capture.spans, 'modbus.read');
  expect(reads).toHaveLength(1);
  // 0..3 and 299 are not contiguous, so the read takes two spans in one batch.
  expect(reads[0]!.get('modbus.transaction_count')).toBe(2);
  expect(reads[0]!.get('modbus.table')).toBe('coils');
});

test('a failed coil write discards what the coil cache knows about the unit', async () => {
  const known = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3, { coils: true });
      const coils = batched.coils!;
      yield* coils.writeNow({ address: 1, value: true });
      // Address 500 is out of range on the mock device.
      yield* Effect.result(coils.writeNow({ address: 500, value: true }));
      return coils.cache!.valueOf(3, 1);
    }),
  );

  expect(known).toBeUndefined();
});

test('a coil write with a value that is not a boolean fails as an invalid argument', async () => {
  const result = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3, { coils: true });
      return yield* Effect.result(batched.coils!.writeNow({ address: 0, value: notBoolean }));
    }),
  );

  expect(result).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'ModbusInvalidArgumentError' },
  });
});

test('flush issues held coil writes', async () => {
  const states = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3, {
        coils: true,
        debounce: { writes: { window: '5 seconds' } },
      });
      const held = yield* Effect.forkChild(batched.coils!.write({ address: 30, value: true }));
      yield* Effect.sleep('10 millis');
      yield* batched.flush;
      yield* Fiber.join(held);
      return yield* rawCoils(30, 1);
    }),
  );

  expect(states).toEqual([true]);
});
