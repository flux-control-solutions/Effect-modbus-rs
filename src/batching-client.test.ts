import { expect, test } from 'bun:test';

import { Effect, Exit, Fiber, Layer, SubscriptionRef, Tracer } from 'effect';

import { ConnectionState } from './connection';
import { ModbusConnectionClosedError } from './errors';
import type { SlaveDeviceDefinitions } from './mocks';
import { makeRegisterCache } from './register-cache';
import { RetryPolicies } from './retry';
import { RtuTransportService } from './RtuTransportService';

const devices: SlaveDeviceDefinitions = [
  {
    unitId: 3,
    coils: [],
    discreteInputs: [],
    holdingRegisters: Array.from({ length: 64 }, (_, index) => ({ address: index, default: 0 })),
    inputRegisters: Array.from({ length: 8 }, (_, index) => ({
      address: index,
      default: index + 900,
    })),
  },
  {
    unitId: 4,
    coils: [],
    discreteInputs: [],
    holdingRegisters: [{ address: 0, default: 0 }],
    inputRegisters: [],
  },
];

/**
 * A fresh mock per test. `makeMockTransport` builds its device state once, so a
 * layer shared between tests would carry register values from one into the next.
 */
const transportLayer = () =>
  RtuTransportService.makeMockTransport(devices)({ portPath: '/dev/null', baudRate: 19200 });

const run = <A, E>(effect: Effect.Effect<A, E, RtuTransportService>) =>
  Effect.runPromise(Effect.provide(effect, transportLayer()));

/**
 * A `Tracer` that records spans in memory rather than exporting them.
 *
 * Whether a value reached the bus is visible in the registers. How many
 * transactions carried it is not, and that is the property under test.
 */
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

/** Attributes of every span with the given name, in order. */
const attributesOf = (spans: ReadonlyArray<Tracer.NativeSpan>, name: string) =>
  spans.filter((span) => span.name === name).map((span) => new Map(span.attributes));

test('a batching client packs a group of writes into one transaction', async () => {
  const capture = makeSpanCapture();

  await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3);
      yield* batched.writeAll(
        [0, 1, 2, 3].map((address) => ({ address, value: address + 10 })),
        { 'app.group': 'outputs' },
      );

      const raw = yield* transport.withClient(3);
      return yield* raw.readHoldingRegisters({ address: 0, quantity: 4 });
    }).pipe(Effect.provide(capture.layer)),
  ).then((values) => expect(Array.from(values)).toEqual([10, 11, 12, 13]));

  const writes = attributesOf(capture.spans, 'modbus.write');
  expect(writes).toHaveLength(1);
  expect(writes[0]!.get('modbus.register_count')).toBe(4);
  expect(writes[0]!.get('modbus.transaction_count')).toBe(1);
  expect(writes[0]!.get('modbus.suppressed_count')).toBe(0);
  expect(writes[0]!.get('modbus.unit_ids')).toBe('3');
  expect(writes[0]!.get('app.group')).toBe('outputs');
});

test('the cache suppresses a write the device already agrees with', async () => {
  const capture = makeSpanCapture();

  await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3);
      yield* batched.write({ address: 0, value: 42 });
      yield* batched.write({ address: 0, value: 42 });
      yield* batched.write({ address: 0, value: 43 });
    }).pipe(Effect.provide(capture.layer)),
  );

  const writes = attributesOf(capture.spans, 'modbus.write');
  // The repeat opens no span at all: the span records what reached the bus.
  expect(writes).toHaveLength(2);
  expect(writes.map((span) => span.get('modbus.register_count'))).toEqual([1, 1]);
});

test('cache false writes every value', async () => {
  const capture = makeSpanCapture();

  await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3, { cache: false });
      yield* batched.write({ address: 0, value: 42 });
      yield* batched.write({ address: 0, value: 42 });
      expect(batched.cache).toBeUndefined();
    }).pipe(Effect.provide(capture.layer)),
  );

  expect(attributesOf(capture.spans, 'modbus.write')).toHaveLength(2);
});

test('one unit gets one batching client, and a conflicting second call fails', async () => {
  const exit = await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        const transport = yield* RtuTransportService;
        const first = yield* transport.withBatchingClient(3, { cache: true });
        const same = yield* transport.withBatchingClient(3, { cache: true });
        expect(same).toBe(first);
        // Two batches on one unit coalesce neither, so this is a mistake.
        yield* transport.withBatchingClient(3, { debounce: { writes: { window: '1 second' } } });
      }),
      transportLayer(),
    ),
  );

  expect(Exit.isFailure(exit)).toBe(true);
});

test('an injected cache is used instead of the transport cache', async () => {
  const cache = makeRegisterCache();
  cache.observe(3, 0, 42);

  const capture = makeSpanCapture();
  await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3, { cache });
      expect(batched.cache).toBe(cache);
      yield* batched.write({ address: 0, value: 42 });
    }).pipe(Effect.provide(capture.layer)),
  );

  // The injected cache already held the value, so nothing reached the bus.
  expect(attributesOf(capture.spans, 'modbus.write')).toHaveLength(0);
});

test('readAll plans a group of parameters into spans', async () => {
  const capture = makeSpanCapture();
  const addresses = [
    ...Array.from({ length: 30 }, (_, index) => index),
    0x20,
    0x21,
    ...Array.from({ length: 17 }, (_, index) => 0x29 + index),
  ];

  const values = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3);
      return yield* batched.readAll(addresses);
    }).pipe(Effect.provide(capture.layer)),
  );

  expect(values).toHaveLength(addresses.length);
  const reads = attributesOf(capture.spans, 'modbus.read');
  // 49 accessors, one call, three transactions.
  expect(reads).toHaveLength(1);
  expect(reads[0]!.get('modbus.transaction_count')).toBe(3);
});

test('the input registers are a separate space with their own reads', async () => {
  const values = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3);
      return yield* batched.inputs.readAll([0, 1, 2]);
    }),
  );

  expect(values).toEqual([900, 901, 902]);
});

test('a read window collects accessors that arrive separately', async () => {
  const capture = makeSpanCapture();

  await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3, {
        debounce: { reads: { window: '20 millis' } },
      });
      return yield* Effect.forEach([0, 1, 2, 3], batched.read, { concurrency: 'unbounded' });
    }).pipe(Effect.provide(capture.layer)),
  );

  const reads = attributesOf(capture.spans, 'modbus.read');
  expect(reads).toHaveLength(1);
  expect(reads[0]!.get('modbus.transaction_count')).toBe(1);
});

test('a write window collects writers that never meet', async () => {
  const capture = makeSpanCapture();

  await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3, {
        debounce: { writes: { window: '30 millis' } },
      });
      yield* Effect.all(
        [0, 1, 2, 3].map((address) => batched.write({ address, value: address + 20 })),
        { concurrency: 'unbounded' },
      );
      const raw = yield* transport.withClient(3);
      return yield* raw.readHoldingRegisters({ address: 0, quantity: 4 });
    }).pipe(Effect.provide(capture.layer)),
  ).then((values) => expect(Array.from(values)).toEqual([20, 21, 22, 23]));

  const writes = attributesOf(capture.spans, 'modbus.write');
  expect(writes).toHaveLength(1);
  expect(writes[0]!.get('modbus.transaction_count')).toBe(1);
});

test('writeNow flushes a held write rather than passing it', async () => {
  const values = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3, {
        debounce: { writes: { window: '500 millis' } },
      });
      const held = yield* Effect.forkChild(batched.write({ address: 0, value: 500 }));
      yield* Effect.sleep('10 millis');
      yield* batched.writeNow({ address: 0, value: 800 });
      yield* Fiber.join(held);

      const raw = yield* transport.withClient(3);
      return yield* raw.readHoldingRegisters({ address: 0, quantity: 1 });
    }),
  );

  // A path around the batch would leave the device holding the older 500.
  expect(Array.from(values)).toEqual([800]);
});

test('touchedUnits names the units a client was built for', async () => {
  const units = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      yield* transport.withBatchingClient(3);
      yield* transport.withClient(4);
      return Array.from(transport.touchedUnits).sort();
    }),
  );

  expect(units).toEqual([3, 4]);
});

test('onShutdownPerUnit runs against every touched unit while the bus is open', async () => {
  const seen: number[] = [];

  const values = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const three = yield* transport.withBatchingClient(3);
          yield* transport.withBatchingClient(4);
          yield* transport.onShutdownPerUnit((unitId) =>
            Effect.gen(function* () {
              seen.push(unitId);
              const batched = yield* transport.withBatchingClient(unitId);
              yield* batched.writeNow({ address: 0, value: 0 });
            }),
          );
          yield* three.write({ address: 0, value: 999 });
        }),
      );

      const raw = yield* transport.withClient(3);
      return yield* raw.readHoldingRegisters({ address: 0, quantity: 1 });
    }),
  );

  expect(seen.sort()).toEqual([3, 4]);
  // The safe state was written, so the action ran before the transport closed.
  expect(Array.from(values)).toEqual([0]);
});

test('losing the link forgets what the devices held', async () => {
  let dropNext = false;
  const linkDropped = () =>
    new ModbusConnectionClosedError({
      cause: new Error('mock link dropped'),
      message: 'mock link dropped',
    });

  const layer = RtuTransportService.makeMockTransport(devices)({
    portPath: '/dev/null',
    baudRate: 19200,
    reconnect: { policy: RetryPolicies.none(), resetAfter: '1 second' },
    fault: () => {
      if (!dropNext) return undefined;
      dropNext = false;
      return linkDropped();
    },
  });

  await Effect.gen(function* () {
    const transport = yield* RtuTransportService;
    const batched = yield* transport.withBatchingClient(3, { retry: RetryPolicies.none() });
    const cache = batched.cache!;

    yield* batched.write({ address: 0, value: 77 });
    expect(cache.filter(3, [{ address: 0, value: 77 }]).pending).toHaveLength(0);

    // A failed *read* drops the link. Reads do not invalidate on their own, so
    // only the watcher on the link state can clear the cache here.
    dropNext = true;
    yield* Effect.result(batched.read(0));
    yield* Effect.sleep('20 millis');
    expect(
      ConnectionState.$is('Connected')(yield* SubscriptionRef.get(transport.connectionState)),
    ).toBe(true);

    // The device may have power-cycled, so the same value has to go out again.
    expect(cache.filter(3, [{ address: 0, value: 77 }]).pending).toHaveLength(1);
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
});
