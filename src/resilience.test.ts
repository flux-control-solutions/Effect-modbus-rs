import { test, expect } from 'bun:test';

import { Effect, Either, Exit, Scope, SubscriptionRef } from 'effect';
import type { AsyncSerialModbusClient } from 'modbus-rs';

import { ConnectionState } from './connection';
import { ModbusTimeoutError } from './errors';
import { makeRetryPolicy, RetryPolicies } from './retry';
import { makeTransportScoped } from './shared-transport';
import { TcpTransportService } from './TcpTransportService';

const fast = makeRetryPolicy({ maxRetries: 3, baseDelay: '1 millis', maxDelay: '4 millis' });
const timeout = () =>
  new ModbusTimeoutError({ cause: new Error('timeout'), message: 'no response' });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Policy layering, exercised through the mock transport.
// ---------------------------------------------------------------------------

const devices = [
  {
    unitId: 1,
    coils: [],
    discreteInputs: [],
    holdingRegisters: [{ address: 0, default: 42 }],
    inputRegisters: [],
  },
];

/** Mock transport whose next `n` operation attempts fail. */
const mockWith = (options: { retry?: ReturnType<typeof makeRetryPolicy>; failures: number }) => {
  const calls = { attempts: 0 };
  let remaining = options.failures;
  const failNext = (n: number) => {
    remaining = n;
  };
  const layer = TcpTransportService.makeMockTransport(devices)({
    host: '127.0.0.1',
    port: 502,
    retry: options.retry,
    fault: () => {
      calls.attempts += 1;
      if (remaining <= 0) return undefined;
      remaining -= 1;
      return timeout();
    },
  });
  return { calls, layer, failNext };
};

test('a transport policy applies to every operation without call-site wiring', async () => {
  const { calls, layer } = mockWith({ retry: fast, failures: 2 });
  const result = await Effect.gen(function* () {
    const transport = yield* TcpTransportService;
    const client = yield* transport.withClient(1);
    return yield* client.readHoldingRegisters({ address: 0, quantity: 1 });
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

  expect(Array.from(result)).toEqual([42]);
  expect(calls.attempts).toBe(3);
});

test('without a policy the operation is single-shot', async () => {
  const { calls, layer } = mockWith({ failures: 1 });
  const result = await Effect.gen(function* () {
    const transport = yield* TcpTransportService;
    const client = yield* transport.withClient(1);
    return yield* Effect.either(client.readHoldingRegisters({ address: 0, quantity: 1 }));
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

  expect(Either.isLeft(result)).toBe(true);
  expect(calls.attempts).toBe(1);
});

test('a per-client policy replaces the transport policy rather than stacking', async () => {
  // Transport allows 3 retries, the client allows 1. Stacking would give 8
  // attempts; replacement gives 2.
  const { calls, layer } = mockWith({ retry: fast, failures: 99 });
  await Effect.gen(function* () {
    const transport = yield* TcpTransportService;
    const client = yield* transport.withClient(1, {
      retry: makeRetryPolicy({ maxRetries: 1, baseDelay: '1 millis' }),
    });
    return yield* Effect.either(client.readHoldingRegisters({ address: 0, quantity: 1 }));
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

  expect(calls.attempts).toBe(2);
});

test('a per-client policy can opt a device out of the transport policy', async () => {
  const { calls, layer } = mockWith({ retry: fast, failures: 99 });
  await Effect.gen(function* () {
    const transport = yield* TcpTransportService;
    const client = yield* transport.withClient(1, { retry: RetryPolicies.none() });
    return yield* Effect.either(client.readHoldingRegisters({ address: 0, quantity: 1 }));
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

  expect(calls.attempts).toBe(1);
});

test('withRetry replaces the policy for a single operation', async () => {
  const { calls, layer } = mockWith({ retry: RetryPolicies.none(), failures: 2 });
  const result = await Effect.gen(function* () {
    const transport = yield* TcpTransportService;
    const client = yield* transport.withClient(1);
    return yield* client.withRetry(fast).readHoldingRegisters({ address: 0, quantity: 1 });
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

  expect(Array.from(result)).toEqual([42]);
  expect(calls.attempts).toBe(3);
});

test('different device types on one transport carry different policies', async () => {
  const { calls, layer, failNext } = mockWith({ retry: RetryPolicies.none(), failures: 2 });
  await Effect.gen(function* () {
    const transport = yield* TcpTransportService;
    const patient = yield* transport.withClient(1, { retry: fast });
    const strict = yield* transport.withClient(1, { retry: RetryPolicies.none() });

    // The patient client rides out both injected failures.
    yield* patient.readHoldingRegisters({ address: 0, quantity: 1 });
    expect(calls.attempts).toBe(3);

    // The strict client, sharing the same connection, gives up on the first.
    failNext(2);
    const result = yield* Effect.either(strict.readHoldingRegisters({ address: 0, quantity: 1 }));
    expect(Either.isLeft(result)).toBe(true);
    expect(calls.attempts).toBe(4);
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
});

// ---------------------------------------------------------------------------
// Supervised reconnect and the circuit breaker, on a controllable fake.
// ---------------------------------------------------------------------------

interface FakeOptions {
  readonly label: string;
}

/** `getModbusErrorCode` classifies by this marker, so the fake fails for real. */
const connectionClosed = () => new Error('[MODBUS_CONNECTION_CLOSED] link dropped');

const makeFake = (config?: { reconnectFailures?: number; reconnectDelayMs?: number }) => {
  const calls = { reconnect: 0 };
  let clientFails = false;
  let reconnectFailures = config?.reconnectFailures ?? 0;

  const client = {
    readHoldingRegisters: async () => {
      if (clientFails) throw connectionClosed();
      return new Uint16Array([7]);
    },
  };

  const transport = {
    close: async () => {},
    createClient: (_opts: { unitId: number }) => client as unknown as AsyncSerialModbusClient,
    setRequestTimeout: (_ms: number) => {},
    clearRequestTimeout: () => {},
    reconnect: async () => {
      calls.reconnect += 1;
      await sleep(config?.reconnectDelayMs ?? 1);
      if (reconnectFailures > 0) {
        reconnectFailures -= 1;
        throw connectionClosed();
      }
      clientFails = false;
    },
    pendingRequests: false,
  };

  const make = makeTransportScoped<FakeOptions, AsyncSerialModbusClient, typeof transport>(
    'AsyncRtuTransport',
    () => Promise.resolve(transport),
    'FakeTransport',
  );

  return {
    calls,
    breakLink: () => {
      clientFails = true;
    },
    make: (resilience: Parameters<typeof make>[0]) => make(resilience),
  };
};

const reconnectFast = {
  policy: makeRetryPolicy({ maxRetries: 2, baseDelay: '1 millis', maxDelay: '4 millis' }),
  resetAfter: '40 millis',
} as const;

test('a connection failure hands control to the transport supervisor', async () => {
  const fake = makeFake();
  await Effect.gen(function* () {
    const api = yield* fake.make({ label: 'x', reconnect: reconnectFast });
    const client = yield* api.withClient(1);
    yield* client.readHoldingRegisters({ address: 0, quantity: 1 });
    expect((yield* api.connectionState)._tag).toBe('Connected');

    fake.breakLink();
    yield* Effect.either(client.readHoldingRegisters({ address: 0, quantity: 1 }));

    // The supervisor takes over; the call site never asked for a reconnect.
    yield* Effect.sleep('40 millis');
    expect(fake.calls.reconnect).toBe(1);
    expect((yield* api.connectionState)._tag).toBe('Connected');
  }).pipe(Effect.scoped, Effect.runPromise);
});

test('the breaker refuses operations while the link is being re-established', async () => {
  const fake = makeFake({ reconnectDelayMs: 60 });
  await Effect.gen(function* () {
    const api = yield* fake.make({ label: 'x', reconnect: reconnectFast });
    const client = yield* api.withClient(1);
    yield* client.readHoldingRegisters({ address: 0, quantity: 1 });

    fake.breakLink();
    yield* Effect.either(client.readHoldingRegisters({ address: 0, quantity: 1 }));
    yield* Effect.sleep('5 millis');

    expect((yield* api.connectionState)._tag).toBe('Reconnecting');
    const refused = yield* Effect.either(client.readHoldingRegisters({ address: 0, quantity: 1 }));
    expect(Either.isLeft(refused)).toBe(true);
    if (Either.isLeft(refused)) expect(refused.left._tag).toBe('ModbusCircuitOpenError');
  }).pipe(Effect.scoped, Effect.runPromise);
});

test('exhausted reconnect attempts open the circuit, then it probes and recovers', async () => {
  // 3 attempts all fail (policy allows 2 retries), so the first round gives up.
  const fake = makeFake({ reconnectFailures: 3 });
  await Effect.gen(function* () {
    const api = yield* fake.make({ label: 'x', reconnect: reconnectFast });
    const client = yield* api.withClient(1);
    yield* client.readHoldingRegisters({ address: 0, quantity: 1 });

    fake.breakLink();
    yield* Effect.either(client.readHoldingRegisters({ address: 0, quantity: 1 }));
    yield* Effect.sleep('25 millis');

    const down = yield* api.connectionState;
    expect(down._tag).toBe('Down');
    expect(fake.calls.reconnect).toBe(3);

    const refused = yield* Effect.either(client.readHoldingRegisters({ address: 0, quantity: 1 }));
    if (Either.isLeft(refused)) expect(refused.left._tag).toBe('ModbusCircuitOpenError');

    // resetAfter elapses and the supervisor probes again — this time it works.
    yield* Effect.sleep('80 millis');
    expect((yield* api.connectionState)._tag).toBe('Connected');
    const recovered = yield* client.readHoldingRegisters({ address: 0, quantity: 1 });
    expect(Array.from(recovered)).toEqual([7]);
  }).pipe(Effect.scoped, Effect.runPromise);
});

test('many fibers failing together produce one reconnect, not one each', async () => {
  const fake = makeFake({ reconnectDelayMs: 30 });
  await Effect.gen(function* () {
    const api = yield* fake.make({ label: 'x', reconnect: reconnectFast });
    const client = yield* api.withClient(1);
    yield* client.readHoldingRegisters({ address: 0, quantity: 1 });

    fake.breakLink();
    yield* Effect.all(
      Array.from({ length: 20 }, () =>
        Effect.either(client.readHoldingRegisters({ address: 0, quantity: 1 })),
      ),
      { concurrency: 'unbounded' },
    );

    yield* Effect.sleep('60 millis');
    expect(fake.calls.reconnect).toBe(1);
  }).pipe(Effect.scoped, Effect.runPromise);
});

test('without a reconnect policy there is no supervisor and no breaker', async () => {
  const fake = makeFake();
  await Effect.gen(function* () {
    const api = yield* fake.make({ label: 'x' });
    const client = yield* api.withClient(1);
    yield* client.readHoldingRegisters({ address: 0, quantity: 1 });

    fake.breakLink();
    const failed = yield* Effect.either(client.readHoldingRegisters({ address: 0, quantity: 1 }));

    // The original error surfaces, not a circuit-open refusal.
    expect(Either.isLeft(failed)).toBe(true);
    if (Either.isLeft(failed)) expect(failed.left._tag).toBe('ModbusConnectionClosedError');

    yield* Effect.sleep('20 millis');
    expect(fake.calls.reconnect).toBe(0);
    expect((yield* api.connectionState)._tag).toBe('Connected');
  }).pipe(Effect.scoped, Effect.runPromise);
});

test('teardown stops the supervisor', async () => {
  const fake = makeFake({ reconnectFailures: 99 });
  await Effect.gen(function* () {
    const scope = yield* Scope.make();
    const api = yield* Scope.extend(fake.make({ label: 'x', reconnect: reconnectFast }), scope);
    const client = yield* api.withClient(1);
    yield* client.readHoldingRegisters({ address: 0, quantity: 1 });

    fake.breakLink();
    yield* Effect.either(client.readHoldingRegisters({ address: 0, quantity: 1 }));
    yield* Effect.sleep('20 millis');

    yield* Scope.close(scope, Exit.void);
    const afterClose = fake.calls.reconnect;

    // The supervisor would otherwise keep probing forever.
    yield* Effect.sleep('120 millis');
    expect(fake.calls.reconnect).toBe(afterClose);
    expect((yield* SubscriptionRef.get(api.connectionState))._tag).toBe('Disconnected');
  }).pipe(Effect.runPromise);
});

test('connection state changes are observable', async () => {
  const fake = makeFake();
  await Effect.gen(function* () {
    const api = yield* fake.make({ label: 'x', reconnect: reconnectFast });
    expect((yield* api.connectionState)._tag).toBe('Disconnected');

    const client = yield* api.withClient(1);
    expect(ConnectionState.$is('Connected')(yield* api.connectionState)).toBe(true);

    fake.breakLink();
    yield* Effect.either(client.readHoldingRegisters({ address: 0, quantity: 1 }));
    const reconnecting = yield* api.connectionState;
    expect(ConnectionState.$is('Reconnecting')(reconnecting)).toBe(true);
  }).pipe(Effect.scoped, Effect.runPromise);
});
