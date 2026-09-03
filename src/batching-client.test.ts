import { expect, test } from 'bun:test';

import { Deferred, Effect, Exit, Fiber, Layer, Scope, SubscriptionRef, Tracer } from 'effect';

import { makeBatchingClient, makeBatchingRegistry } from './batching-client';
import { ConnectionState } from './connection';
import { ModbusConnectionClosedError, ModbusTimeoutError } from './errors';
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

test('a batching client guards raw register writes for its unit', async () => {
  const { failureTags, read, otherUnit } = await run(
    Effect.gen(function* () {
      // Acquire both raw variants first to prove the guard is checked when an
      // operation runs, not only when the client is created.
      const transport = yield* RtuTransportService;
      const raw = yield* transport.withClient(3);
      const retried = raw.withRetry(RetryPolicies.none());
      yield* transport.withBatchingClient(3);

      const failures = yield* Effect.all([
        Effect.result(raw.writeSingleRegister({ address: 0, value: 10 })),
        Effect.result(
          raw.writeMultipleRegisters({ address: 0, values: Uint16Array.from([10, 11]) }),
        ),
        Effect.result(
          retried.readWriteMultipleRegisters({
            readAddress: 0,
            readQuantity: 1,
            writeAddress: 0,
            writeValues: Uint16Array.from([10]),
          }),
        ),
      ]);
      const read = yield* raw.readHoldingRegisters({ address: 0, quantity: 1 });

      const other = yield* transport.withClient(4);
      yield* other.writeSingleRegister({ address: 0, value: 12 });
      const otherUnit = yield* other.readHoldingRegisters({ address: 0, quantity: 1 });
      const failureTags = failures.map((result) =>
        result._tag === 'Failure' ? result.failure._tag : result._tag,
      );
      return { failureTags, read, otherUnit };
    }),
  );

  expect(failureTags).toEqual([
    'ModbusInvalidArgumentError',
    'ModbusInvalidArgumentError',
    'ModbusInvalidArgumentError',
  ]);
  expect(Array.from(read)).toEqual([0]);
  expect(Array.from(otherUnit)).toEqual([12]);
});

test('a raw write retry rechecks the batching guard', async () => {
  let attempts = 0;
  const layer = RtuTransportService.makeMockTransport(devices)({
    portPath: '/dev/null',
    baudRate: 19200,
    fault: () => {
      attempts += 1;
      if (attempts !== 1) return undefined;
      const message = 'retry this write';
      return new ModbusTimeoutError({ cause: new Error(message), message });
    },
  });

  const result = await Effect.gen(function* () {
    const transport = yield* RtuTransportService;
    const raw = yield* transport.withClient(3, {
      retry: RetryPolicies.serial({
        maxRetries: 1,
        baseDelay: '50 millis',
        jitter: false,
      }),
    });
    const writer = yield* Effect.forkChild(raw.writeSingleRegister({ address: 0, value: 99 }));
    while (attempts === 0) yield* Effect.sleep('1 millis');

    yield* transport.withBatchingClient(3);
    const write = yield* Effect.result(Fiber.join(writer));
    const value = yield* raw.readHoldingRegisters({ address: 0, quantity: 1 });
    return { value, write };
  }).pipe(Effect.provide(layer), Effect.runPromise);

  expect(result.write._tag).toBe('Failure');
  if (result.write._tag === 'Failure') {
    expect(result.write.failure._tag).toBe('ModbusInvalidArgumentError');
  }
  expect(Array.from(result.value)).toEqual([0]);
});

test('batching waits for an accepted raw register write to finish', async () => {
  const result = await run(
    Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* RtuTransportService;
        const raw = yield* transport.withClient(3);
        const scope = yield* Effect.scope;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const delayed = {
          ...raw,
          writeSingleRegister: (options: { readonly address: number; readonly value: number }) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return yield* raw.writeSingleRegister(options);
            }),
        };
        const registry = makeBatchingRegistry({
          withClient: () => Effect.succeed(raw),
          connectionState: transport.connectionState,
          scope,
        });
        const guarded = registry.guardRawWrites(3, delayed);

        const rawWriter = yield* Effect.forkChild(
          guarded.writeSingleRegister({ address: 0, value: 10 }),
        );
        yield* Deferred.await(started);
        const builder = yield* Effect.forkChild(registry.withBatchingClient(3));
        const beforeRelease = yield* Effect.race(
          Effect.as(Fiber.join(builder), 'Built' as const),
          Effect.as(Effect.sleep('10 millis'), 'Waiting' as const),
        );

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(rawWriter);
        const batched = yield* Fiber.join(builder);
        yield* batched.write({ address: 0, value: 20 });
        const value = yield* raw.readHoldingRegisters({ address: 0, quantity: 1 });
        return { beforeRelease, value };
      }),
    ),
  );

  expect(result.beforeRelease).toBe('Waiting');
  expect(Array.from(result.value)).toEqual([20]);
});

test('concurrent calls share one in-flight batching client construction', async () => {
  const result = await run(
    Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* RtuTransportService;
        const raw = yield* transport.withClient(3);
        const scope = yield* Effect.scope;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let builds = 0;
        const registry = makeBatchingRegistry({
          withClient: () =>
            Effect.gen(function* () {
              builds += 1;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return raw;
            }),
          connectionState: transport.connectionState,
          scope,
        });

        const first = yield* Effect.forkChild(registry.withBatchingClient(3));
        yield* Deferred.await(started);
        const second = yield* Effect.forkChild(registry.withBatchingClient(3));
        yield* Effect.sleep('1 millis');
        yield* Deferred.succeed(release, undefined);
        const [left, right] = yield* Effect.all([Fiber.join(first), Fiber.join(second)], {
          concurrency: 'unbounded',
        });
        return { builds, same: left === right };
      }),
    ),
  );

  expect(result).toEqual({ builds: 1, same: true });
});

test('client construction fails promptly after the registry scope closes', async () => {
  const result = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const raw = yield* transport.withClient(3);
      const scope = yield* Scope.make();
      let builds = 0;
      const registry = makeBatchingRegistry({
        withClient: () =>
          Effect.sync(() => {
            builds += 1;
            return raw;
          }),
        connectionState: transport.connectionState,
        scope,
      });
      yield* Scope.close(scope, Exit.void);

      const outcome = yield* Effect.race(
        Effect.map(Effect.result(registry.withBatchingClient(3)), (result) =>
          result._tag === 'Failure' ? result.failure._tag : result._tag,
        ),
        Effect.as(Effect.sleep('100 millis'), 'Timeout' as const),
      );
      return { builds, outcome };
    }),
  );

  expect(result).toEqual({ builds: 0, outcome: 'ModbusNotConnectedError' });
});

test('closing the registry scope settles every in-flight construction caller', async () => {
  const result = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const raw = yield* transport.withClient(3);
      const scope = yield* Scope.make();
      const started = yield* Deferred.make<void>();
      const registry = makeBatchingRegistry({
        withClient: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Effect.never;
            return raw;
          }),
        connectionState: transport.connectionState,
        scope,
      });

      const leader = yield* Effect.forkChild(registry.withBatchingClient(3));
      yield* Deferred.await(started);
      const follower = yield* Effect.forkChild(registry.withBatchingClient(3));
      yield* Effect.sleep('1 millis');
      const close = yield* Effect.race(
        Effect.as(Scope.close(scope, Exit.void), 'Closed' as const),
        Effect.as(Effect.sleep('100 millis'), 'CloseTimeout' as const),
      );
      if (close === 'CloseTimeout') return close;

      if (leader.pollUnsafe() === undefined || follower.pollUnsafe() === undefined)
        return 'CallerStillRunning' as const;

      return yield* Effect.race(
        Effect.all([Fiber.await(leader), Fiber.await(follower)], {
          concurrency: 'unbounded',
        }),
        Effect.as(Effect.sleep('100 millis'), 'CallerTimeout' as const),
      );
    }),
  );

  expect(result).toBeArray();
  if (!Array.isArray(result)) throw new Error(`Unexpected timeout: ${result}`);
  expect(result.every(Exit.isFailure)).toBe(true);
});

test('retry policy identity is part of a batching client configuration', async () => {
  const result = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const retry = RetryPolicies.none();
      const first = yield* transport.withBatchingClient(3, { retry });
      const same = yield* transport.withBatchingClient(3, { retry });
      const conflict = yield* Effect.result(
        transport.withBatchingClient(3, { retry: RetryPolicies.serial() }),
      );
      return { conflict, same: first === same };
    }),
  );

  expect(result.same).toBe(true);
  expect(result.conflict._tag).toBe('Failure');
  if (result.conflict._tag === 'Failure') {
    expect(result.conflict.failure._tag).toBe('ModbusInvalidArgumentError');
  }
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

test('invalid register addresses fail batching operations as typed errors', async () => {
  const result = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3, { cache: false });
      return yield* Effect.all({
        read: Effect.result(batched.read(0x10000)),
        write: Effect.result(batched.write({ address: 0x10000, value: 1 })),
      });
    }),
  );

  expect(result.read).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'ModbusInvalidArgumentError' },
  });
  expect(result.write).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'ModbusInvalidArgumentError' },
  });
});

test('invalid planner limits fail batching operations as typed errors', async () => {
  const result = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3, {
        cache: false,
        plan: {
          reads: { maxRegistersPerRead: 126 },
          writes: { maxRegistersPerWrite: 124 },
        },
      });
      return yield* Effect.all({
        read: Effect.result(batched.read(0)),
        write: Effect.result(batched.write({ address: 0, value: 1 })),
      });
    }),
  );

  expect(result.read).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'ModbusInvalidArgumentError' },
  });
  expect(result.write).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'ModbusInvalidArgumentError' },
  });
});

test('a later valid write cannot hide an invalid debounced write', async () => {
  const result = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const batched = yield* transport.withBatchingClient(3, {
        debounce: { writes: { window: '10 millis' } },
      });
      const writes = yield* Effect.all(
        [
          Effect.result(batched.write({ address: 0, value: 0x10000 })),
          Effect.result(batched.write({ address: 0, value: 10 })),
        ],
        { concurrency: 'unbounded' },
      );
      const raw = yield* transport.withClient(3);
      const value = yield* raw.readHoldingRegisters({ address: 0, quantity: 1 });
      return { value, writes };
    }),
  );

  expect(result.writes[0]).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'ModbusInvalidArgumentError' },
  });
  expect(result.writes[1]._tag).toBe('Success');
  expect(Array.from(result.value)).toEqual([10]);
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

test('interrupting a composite flush does not skip later register spaces', async () => {
  const result = await run(
    Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* RtuTransportService;
        const raw = yield* transport.withClient(3);
        const writeStarted = yield* Deferred.make<void>();
        const releaseWrite = yield* Deferred.make<void>();
        const client = {
          ...raw,
          writeSingleRegister: (options: { readonly address: number; readonly value: number }) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(writeStarted, undefined);
              yield* Deferred.await(releaseWrite);
              return yield* raw.writeSingleRegister(options);
            }),
        };
        const batched = yield* makeBatchingClient({
          unitId: 3,
          client,
          cache: undefined,
          debounce: {
            writes: { window: '10 seconds' },
            reads: { window: '10 seconds' },
          },
        });

        const writer = yield* Effect.forkChild(batched.write({ address: 0, value: 55 }));
        const reader = yield* Effect.forkChild(batched.read(0));
        yield* Effect.sleep('1 millis');
        const flusher = yield* Effect.forkChild(batched.flush);
        yield* Deferred.await(writeStarted);
        yield* Fiber.interrupt(flusher);
        yield* Deferred.succeed(releaseWrite, undefined);
        const settled = yield* Effect.race(
          Effect.all({ read: Fiber.join(reader), write: Fiber.join(writer) }),
          Effect.as(Effect.sleep('100 millis'), 'Timeout' as const),
        );
        return settled;
      }),
    ),
  );

  expect(result).toEqual({ read: 55, write: undefined });
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

test('onShutdownForUnits runs against caller-owned units while the bus is open', async () => {
  const seen: number[] = [];
  const ownedUnits = new Set<number>();

  const values = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* transport.onShutdownForUnits(
            () => ownedUnits,
            (unitId) =>
              Effect.gen(function* () {
                seen.push(unitId);
                const batched = yield* transport.withBatchingClient(unitId);
                yield* batched.writeNow({ address: 0, value: 0 });
              }),
          );
          const three = yield* transport.withBatchingClient(3);
          ownedUnits.add(3);
          // This unit shares the transport but belongs to a different policy.
          yield* transport.withBatchingClient(4);
          yield* three.write({ address: 0, value: 999 });
        }),
      );

      const raw = yield* transport.withClient(3);
      return yield* raw.readHoldingRegisters({ address: 0, quantity: 1 });
    }),
  );

  expect(seen).toEqual([3]);
  // The safe state was written, so the action ran before the transport closed.
  expect(Array.from(values)).toEqual([0]);
});

test('a shutdown action registered before batching runs before client teardown', async () => {
  const value = await run(
    Effect.gen(function* () {
      const transport = yield* RtuTransportService;
      const raw = yield* transport.withClient(3);
      const scope = yield* Scope.make();
      const registry = makeBatchingRegistry({
        withClient: () => Effect.succeed(raw),
        connectionState: transport.connectionState,
        scope,
      });

      yield* Scope.provide(
        registry.onShutdownForUnits(
          () => [3],
          () =>
            Effect.flatMap(registry.withBatchingClient(3), (batched) =>
              batched.writeNow({ address: 0, value: 88 }),
            ),
        ),
        scope,
      );
      yield* Scope.close(scope, Exit.void);

      return yield* raw.readHoldingRegisters({ address: 0, quantity: 1 });
    }),
  );

  expect(Array.from(value)).toEqual([88]);
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
