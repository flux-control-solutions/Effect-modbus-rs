import { test, expect } from 'bun:test';

import { Effect, Result, Exit, Fiber, Scope } from 'effect';
import type { AsyncSerialModbusClient } from 'modbus-rs';

import { createTransportScoped } from '../src/shared-transport';

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
}) => {
  const calls = { open: 0, reconnect: 0, close: 0 };
  const client = makeClient();

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

  const open = async () => {
    calls.open += 1;
    await sleep(config?.openDelayMs ?? 0);
    return transport;
  };

  const make = createTransportScoped<FakeOptions, AsyncSerialModbusClient, typeof transport>(
    'AsyncRtuTransport',
    () => open(),
    'FakeTransport',
  );

  return { calls, make: () => make({ label: 'test' }) };
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
