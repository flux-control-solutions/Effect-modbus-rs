import { test, expect } from 'bun:test';

import { Effect, Result, Exit, Fiber, Option, Scope, SubscriptionRef } from 'effect';
import type { AsyncSerialModbusClient } from 'modbus-rs';

import { RetryPolicies } from '../src/retry';
import { createTransportScoped, type TransportResilienceOptions } from '../src/shared-transport';

interface FakeOptions {
  readonly label: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const unusedClientMethod = async (): Promise<never> => {
  throw new Error('unexpected fake client method');
};

const makeClient = (
  writeSingleRegister: AsyncSerialModbusClient['writeSingleRegister'] = unusedClientMethod,
): AsyncSerialModbusClient => ({
  pendingRequests: false,
  isConnected: () => true,
  readHoldingRegisters: unusedClientMethod,
  readInputRegisters: unusedClientMethod,
  writeSingleRegister,
  writeMultipleRegisters: unusedClientMethod,
  readWriteMultipleRegisters: unusedClientMethod,
  readCoils: unusedClientMethod,
  writeSingleCoil: unusedClientMethod,
  writeMultipleCoils: unusedClientMethod,
  readDiscreteInputs: unusedClientMethod,
  readFifoQueue: unusedClientMethod,
  readFileRecord: unusedClientMethod,
  writeFileRecord: unusedClientMethod,
  readExceptionStatus: unusedClientMethod,
  diagnostics: unusedClientMethod,
  readDeviceIdentification: unusedClientMethod,
});

/**
 * A transport handle that records call counts and can be made slow or failing,
 * so concurrent callers genuinely overlap.
 */
const makeFake = (config?: {
  openDelayMs?: number;
  reconnectDelayMs?: number;
  reconnectFails?: () => boolean;
  client?: AsyncSerialModbusClient;
  resilience?: TransportResilienceOptions;
}) => {
  const calls = { open: 0, reconnect: 0, close: 0 };
  const openOptions: unknown[] = [];
  const client = config?.client ?? makeClient();

  const transport = {
    close: async () => {
      calls.close += 1;
    },
    createClient: (_opts: { unitId: number }) => client,
    setRequestTimeout: (_ms: number) => {},
    clearRequestTimeout: () => {},
    reconnect: async () => {
      calls.reconnect += 1;
      await sleep(config?.reconnectDelayMs ?? 0);
      if (config?.reconnectFails?.()) throw new Error('reconnect failed');
    },
    pendingRequests: false,
  };

  const open = async (options: FakeOptions) => {
    openOptions.push(options);
    calls.open += 1;
    await sleep(config?.openDelayMs ?? 0);
    return transport;
  };

  const make = createTransportScoped<FakeOptions, AsyncSerialModbusClient, typeof transport>(
    'AsyncRtuTransport',
    (_constructor, options) => open(options),
    'FakeTransport',
  );

  return { calls, openOptions, make: () => make({ label: 'test', ...config?.resilience }) };
};

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.runPromise);

test('concurrent reconnects collapse into one transport reconnect', async () => {
  const fake = makeFake({ reconnectDelayMs: 25 });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();
      yield* api.withClient(1);

      yield* Effect.all(
        Array.from({ length: 5 }, () => api.reconnect()),
        { concurrency: 'unbounded' },
      );

      expect(fake.calls.reconnect).toBe(1);
    }),
  );
});

test('concurrent first calls collapse into one transport open', async () => {
  const fake = makeFake({ openDelayMs: 25 });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();

      yield* Effect.all([api.withClient(1), api.withClient(2), api.withClient(3)], {
        concurrency: 'unbounded',
      });

      expect(fake.calls.open).toBe(1);
    }),
  );
});

test('a failed reconnect is shared by every waiter, and the next call retries', async () => {
  let failing = true;
  const fake = makeFake({ reconnectDelayMs: 10, reconnectFails: () => failing });

  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();
      yield* api.withClient(1);

      const results = yield* Effect.all(
        Array.from({ length: 3 }, () => Effect.result(api.reconnect())),
        { concurrency: 'unbounded' },
      );

      expect(results.every(Result.isFailure)).toBe(true);
      expect(fake.calls.reconnect).toBe(1);
      // Every waiter observes the very same failure, not a re-run of the work.
      const [first, second, third] = results.map((r) =>
        Result.getFailure(r).pipe((o) => (o._tag === 'Some' ? o.value : null)),
      );
      expect(first).toBe(second);
      expect(second).toBe(third);

      // The cell is cleared as the run settles, so the next call starts fresh.
      failing = false;
      yield* api.reconnect();
      expect(fake.calls.reconnect).toBe(2);
    }),
  );
});

test('interrupting one caller does not cancel or strand the others', async () => {
  const fake = makeFake({ reconnectDelayMs: 40 });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();
      yield* api.withClient(1);

      const leader = yield* Effect.forkChild(api.reconnect());
      yield* Effect.sleep('5 millis');
      const follower = yield* Effect.forkChild(api.reconnect());
      yield* Effect.sleep('5 millis');

      // The fiber that started the reconnect goes away mid-flight.
      yield* Fiber.interrupt(leader);

      const exit = yield* Fiber.await(follower);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(fake.calls.reconnect).toBe(1);
    }),
  );
});

test('a reconnect landing after teardown fails the waiter and closes the handle', async () => {
  const fake = makeFake({ reconnectDelayMs: 30 });

  await Effect.gen(function* () {
    const scope = yield* Scope.make();
    const api = yield* Scope.provide(fake.make(), scope);
    yield* api.withClient(1);

    const waiter = yield* Effect.forkChild(api.reconnect());
    yield* Effect.sleep('5 millis');

    // Scope teardown closes the transport while the reconnect is in flight.
    yield* Scope.close(scope, Exit.void);
    expect(fake.calls.close).toBe(1);

    const exit = yield* Fiber.await(waiter);
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit) ? Exit.getCause(exit) : null;
    expect(JSON.stringify(error)).toContain('ModbusNotConnectedError');

    // The reopened handle is not left dangling.
    yield* Effect.sleep('50 millis');
    expect(fake.calls.close).toBe(2);
  }).pipe(Effect.runPromise);
});

test('a connection completing after its caller is gone is still closed on teardown', async () => {
  const fake = makeFake({ openDelayMs: 30 });

  await Effect.gen(function* () {
    const scope = yield* Scope.make();
    const api = yield* Scope.provide(fake.make(), scope);

    const caller = yield* Effect.forkChild(api.withClient(1));
    yield* Effect.sleep('5 millis');
    // Nobody is waiting for the connection any more, but it is still coming.
    yield* Fiber.interrupt(caller);
    yield* Effect.sleep('50 millis');

    yield* Scope.close(scope, Exit.void);
    expect(fake.calls.open).toBe(1);
    expect(fake.calls.close).toBe(1);
  }).pipe(Effect.runPromise);
});

test('reconnect opens the transport when it was never connected', async () => {
  const fake = makeFake();
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();
      yield* api.reconnect();
      expect(fake.calls.open).toBe(1);
      expect(fake.calls.reconnect).toBe(0);
    }),
  );
});

test('reconnect after close fails with ModbusNotConnectedError', async () => {
  const fake = makeFake();
  await Effect.gen(function* () {
    const scope = yield* Scope.make();
    const api = yield* Scope.provide(fake.make(), scope);
    yield* api.withClient(1);
    yield* Scope.close(scope, Exit.void);

    const result = yield* Effect.result(api.reconnect());
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure._tag).toBe('ModbusNotConnectedError');
  }).pipe(Effect.runPromise);
});

test('explicit close runs batching shutdown actions before closing the handle', async () => {
  const events: string[] = [];
  let closed = false;
  let held = 999;
  const client = makeClient(async (options) => {
    if (closed) throw new Error('[MODBUS_CONNECTION_CLOSED] transport closed');
    events.push('write');
    held = options.value;
  });
  const transport = {
    close: async () => {
      events.push('close');
      closed = true;
    },
    createClient: (_opts: { unitId: number }) => client,
    setRequestTimeout: (_ms: number) => {},
    clearRequestTimeout: () => {},
    reconnect: async () => {},
    pendingRequests: false,
  };
  const make = createTransportScoped<FakeOptions, AsyncSerialModbusClient, typeof transport>(
    'AsyncRtuTransport',
    () => Promise.resolve(transport),
    'CloseAwareTransport',
  );

  await Effect.gen(function* () {
    const scope = yield* Scope.make();
    const api = yield* Scope.provide(make({ label: 'test' }), scope);
    const batched = yield* api.withBatchingClient(1, { cache: false });
    yield* Scope.provide(batched.onShutdown(batched.writeNow({ address: 0, value: 0 })), scope);

    const exit = yield* Effect.exit(Scope.provide(api.close(), scope));

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(held).toBe(0);
    expect(events).toEqual(['write', 'close']);
  }).pipe(Effect.runPromise);
});

const failureTag = <A>(exit: Exit.Exit<A, { readonly _tag: string }>) =>
  Option.getOrNull(Option.map(Exit.findErrorOption(exit), (error) => error._tag));

test('the connect timeout is not passed to the native open', async () => {
  const fake = makeFake({ resilience: { connectTimeout: '1 second' } });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();
      yield* api.withClient(1);
      expect(fake.openOptions).toEqual([{ label: 'test' }]);
    }),
  );
});

test('a lazy open that exceeds the connect timeout fails every waiter', async () => {
  const fake = makeFake({ openDelayMs: 80, resilience: { connectTimeout: '10 millis' } });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();

      const started = Date.now();
      const exits = yield* Effect.all(
        [api.withClient(1), api.withClient(2)].map((effect) => Effect.exit(effect)),
        { concurrency: 'unbounded' },
      );

      expect(Date.now() - started).toBeLessThan(60);
      expect(exits.map(failureTag)).toEqual(['ModbusTimeoutError', 'ModbusTimeoutError']);
      expect(fake.calls.open).toBe(1);
      expect(api.connectionState.pipe(SubscriptionRef.getUnsafe)._tag).toBe('Disconnected');
    }),
  );
});

test('the next operation after a connect timeout starts a new open', async () => {
  let openDelayMs = 80;
  const calls = { open: 0, close: 0 };
  const transport = {
    close: async () => {
      calls.close += 1;
    },
    createClient: (_opts: { unitId: number }) => makeClient(),
    setRequestTimeout: (_ms: number) => {},
    clearRequestTimeout: () => {},
    reconnect: async () => {},
    pendingRequests: false,
  };
  const make = createTransportScoped<FakeOptions, AsyncSerialModbusClient, typeof transport>(
    'AsyncRtuTransport',
    async () => {
      calls.open += 1;
      await sleep(openDelayMs);
      return transport;
    },
    'SlowOpenTransport',
  );

  await run(
    Effect.gen(function* () {
      const api = yield* make({ label: 'test', connectTimeout: '10 millis' });

      const first = yield* Effect.exit(api.withClient(1));
      expect(failureTag(first)).toBe('ModbusTimeoutError');

      // The in-flight open is cleared, so this call does not join the pending open.
      openDelayMs = 0;
      yield* api.withClient(1);
      expect(calls.open).toBe(2);
      expect(api.connectionState.pipe(SubscriptionRef.getUnsafe)._tag).toBe('Connected');
    }),
  );
});

test('a handle from a timed-out open is closed when the native open completes', async () => {
  const fake = makeFake({ openDelayMs: 30, resilience: { connectTimeout: '5 millis' } });

  await Effect.gen(function* () {
    const scope = yield* Scope.make();
    const api = yield* Scope.provide(fake.make(), scope);

    const exit = yield* Effect.exit(api.withClient(1));
    expect(failureTag(exit)).toBe('ModbusTimeoutError');
    expect(fake.calls.close).toBe(0);

    yield* Effect.sleep('50 millis');
    expect(fake.calls.close).toBe(1);

    // The late handle was never the live transport, so teardown does not close it again.
    yield* Scope.close(scope, Exit.void);
    expect(fake.calls.close).toBe(1);
  }).pipe(Effect.runPromise);
});

test('a reconnect that exceeds the connect timeout fails, and a later reconnect joins it', async () => {
  const fake = makeFake({ reconnectDelayMs: 60, resilience: { connectTimeout: '40 millis' } });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();
      yield* api.withClient(1);

      const first = yield* Effect.exit(api.reconnect());
      expect(failureTag(first)).toBe('ModbusTimeoutError');

      // The native reconnect still runs. The next attempt waits for it and
      // succeeds within its own limit, because only about 20 ms remain.
      yield* api.reconnect();
      expect(fake.calls.reconnect).toBe(1);

      // After the native reconnect settles, a reconnect starts a new one.
      yield* Effect.exit(api.reconnect());
      expect(fake.calls.reconnect).toBe(2);
    }),
  );
});

test('a supervised reconnect that exceeds the connect timeout publishes Down', async () => {
  const client = makeClient(async () => {
    throw new Error('[MODBUS_CONNECTION_CLOSED] link dropped');
  });
  const fake = makeFake({
    client,
    reconnectDelayMs: 200,
    resilience: {
      connectTimeout: '10 millis',
      reconnect: { policy: RetryPolicies.none(), resetAfter: '1 minute' },
    },
  });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();
      const modbus = yield* api.withClient(1);
      yield* Effect.exit(modbus.writeSingleRegister({ address: 0, value: 1 }));

      yield* Effect.sleep('40 millis');
      const state = SubscriptionRef.getUnsafe(api.connectionState);
      expect(state._tag).toBe('Down');
      if (state._tag === 'Down') expect(state.cause._tag).toBe('ModbusTimeoutError');
    }),
  );
});
