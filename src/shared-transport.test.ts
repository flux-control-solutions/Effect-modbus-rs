import { test, expect } from 'bun:test';

import { Effect, Either, Exit, Fiber, Scope } from 'effect';
import type { AsyncSerialModbusClient } from 'modbus-rs';

import { makeTransportScoped } from './shared-transport';

interface FakeOptions {
  readonly label: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

  const transport = {
    close: async () => {
      calls.close += 1;
    },
    createClient: (_opts: { unitId: number }) => ({}) as AsyncSerialModbusClient,
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

  const make = makeTransportScoped<FakeOptions, AsyncSerialModbusClient, typeof transport>(
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
        Array.from({ length: 3 }, () => Effect.either(api.reconnect())),
        { concurrency: 'unbounded' },
      );

      expect(results.every(Either.isLeft)).toBe(true);
      expect(fake.calls.reconnect).toBe(1);
      // Every waiter observes the very same failure, not a re-run of the work.
      const [first, second, third] = results.map((r) =>
        Either.getLeft(r).pipe((o) => (o._tag === 'Some' ? o.value : null)),
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

      const leader = yield* Effect.fork(api.reconnect());
      yield* Effect.sleep('5 millis');
      const follower = yield* Effect.fork(api.reconnect());
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
    const api = yield* Scope.extend(fake.make(), scope);
    yield* api.withClient(1);

    const waiter = yield* Effect.fork(api.reconnect());
    yield* Effect.sleep('5 millis');

    // Scope teardown closes the transport while the reconnect is in flight.
    yield* Scope.close(scope, Exit.void);
    expect(fake.calls.close).toBe(1);

    const exit = yield* Fiber.await(waiter);
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit) ? Exit.causeOption(exit) : null;
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
    const api = yield* Scope.extend(fake.make(), scope);

    const caller = yield* Effect.fork(api.withClient(1));
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
    const api = yield* Scope.extend(fake.make(), scope);
    yield* api.withClient(1);
    yield* Scope.close(scope, Exit.void);

    const result = yield* Effect.either(api.reconnect());
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left._tag).toBe('ModbusNotConnectedError');
  }).pipe(Effect.runPromise);
});
