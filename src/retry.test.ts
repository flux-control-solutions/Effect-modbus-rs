import { test, expect } from 'bun:test';

import { Chunk, Duration, Effect, Schedule } from 'effect';

import {
  ModbusConnectionClosedError,
  ModbusExceptionError,
  ModbusInvalidArgumentError,
  ModbusTimeoutError,
  ModbusTransportError,
  type ModbusError,
} from './errors';
import {
  makeRetryPolicy,
  retryModbus,
  retryModbusWithReconnect,
  RetryPolicies,
  type ModbusRetryPolicy,
} from './retry';

const timeout = () => new ModbusTimeoutError({ cause: new Error('timeout'), message: 'timeout' });
const transportError = () => new ModbusTransportError({ cause: new Error('crc'), message: 'crc' });
const connectionClosed = () =>
  new ModbusConnectionClosedError({ cause: new Error('closed'), message: 'closed' });
const invalidArgument = () =>
  new ModbusInvalidArgumentError({ cause: new Error('bad address'), message: 'bad address' });
const exception = (code: number) =>
  new ModbusExceptionError({ cause: new Error('exc'), exception: code, message: 'exc' });

/** Delays the policy would impose for a given sequence of failures, in ms. */
const delaysFor = (policy: ModbusRetryPolicy, errors: ReadonlyArray<ModbusError>) =>
  Schedule.run(Schedule.delays(policy.schedule), 0, errors).pipe(
    Effect.map(Chunk.toReadonlyArray),
    Effect.map((ds) => ds.map(Duration.toMillis)),
    Effect.runPromise,
  );

/** Runs an effect that fails `failures` times before succeeding, counting attempts. */
const runWithFailures = (policy: ModbusRetryPolicy, failures: number, error: () => ModbusError) => {
  let attempts = 0;
  const effect = Effect.suspend(() => {
    attempts += 1;
    return attempts <= failures ? Effect.fail(error()) : Effect.succeed('ok' as const);
  });
  return effect.pipe(retryModbus(policy), Effect.either, Effect.runPromise, (promise) =>
    promise.then((result) => ({ attempts, result })),
  );
};

const fast = { baseDelay: '1 millis', maxDelay: '4 millis', jitter: false } as const;

test('backoff grows exponentially and is capped by maxDelay', async () => {
  const policy = makeRetryPolicy({
    maxRetries: 5,
    baseDelay: '100 millis',
    factor: 2,
    maxDelay: '500 millis',
    jitter: false,
  });
  const delays = await delaysFor(policy, [timeout(), timeout(), timeout(), timeout(), timeout()]);
  expect(delays).toEqual([100, 200, 400, 500, 500]);
});

test('jitter keeps delays within the configured multiplier range', async () => {
  const policy = makeRetryPolicy({
    maxRetries: 3,
    baseDelay: '100 millis',
    factor: 1,
    jitter: { min: 0.5, max: 1.5 },
  });
  const delays = await delaysFor(policy, [timeout(), timeout(), timeout()]);
  expect(delays).toHaveLength(3);
  for (const delay of delays) {
    expect(delay).toBeGreaterThanOrEqual(50);
    expect(delay).toBeLessThanOrEqual(150);
  }
  // Jittered delays should not all collapse onto the base value.
  expect(new Set(delays).size).toBeGreaterThan(1);
});

test('per-error overrides give each error category its own curve', async () => {
  const policy = makeRetryPolicy({
    maxRetries: 4,
    baseDelay: '10 millis',
    factor: 1,
    jitter: false,
    errors: { ModbusConnectionClosedError: { baseDelay: '250 millis' } },
  });
  // The retry budget is shared, but the delay follows whichever error occurred.
  const delays = await delaysFor(policy, [
    timeout(),
    connectionClosed(),
    timeout(),
    connectionClosed(),
  ]);
  expect(delays).toEqual([10, 250, 10, 250]);
});

test('retryable errors are retried up to maxRetries', async () => {
  const policy = makeRetryPolicy({ maxRetries: 3, ...fast });
  const { attempts, result } = await runWithFailures(policy, 10, timeout);
  expect(attempts).toBe(4);
  expect(result._tag).toBe('Left');
});

test('an effect that recovers mid-sequence succeeds', async () => {
  const policy = makeRetryPolicy({ maxRetries: 3, ...fast });
  const { attempts, result } = await runWithFailures(policy, 2, transportError);
  expect(attempts).toBe(3);
  expect(result).toMatchObject({ _tag: 'Right', right: 'ok' });
});

test('non-retryable errors fail on the first attempt', async () => {
  const policy = makeRetryPolicy({ maxRetries: 5, ...fast });
  const { attempts } = await runWithFailures(policy, 10, invalidArgument);
  expect(attempts).toBe(1);
});

test('exception responses are retried only for transient codes', async () => {
  const policy = makeRetryPolicy({ maxRetries: 3, ...fast });

  // 6 = SERVER_DEVICE_BUSY — the device is asking us to come back later.
  const busy = await runWithFailures(policy, 10, () => exception(6));
  expect(busy.attempts).toBe(4);

  // 2 = ILLEGAL_DATA_ADDRESS — the answer will not change.
  const illegal = await runWithFailures(policy, 10, () => exception(2));
  expect(illegal.attempts).toBe(1);
});

test('retryableExceptions is configurable', async () => {
  const policy = makeRetryPolicy({ maxRetries: 2, retryableExceptions: [2], ...fast });
  const illegal = await runWithFailures(policy, 10, () => exception(2));
  expect(illegal.attempts).toBe(3);
  const busy = await runWithFailures(policy, 10, () => exception(6));
  expect(busy.attempts).toBe(1);
});

test('an error category can be disabled outright', async () => {
  const policy = makeRetryPolicy({
    maxRetries: 3,
    errors: { ModbusTimeoutError: false },
    ...fast,
  });
  expect((await runWithFailures(policy, 10, timeout)).attempts).toBe(1);
  expect((await runWithFailures(policy, 10, transportError)).attempts).toBe(4);
});

test('RetryPolicies.none performs a single attempt', async () => {
  const { attempts } = await runWithFailures(RetryPolicies.none(), 10, timeout);
  expect(attempts).toBe(1);
});

test('preset overrides merge without discarding preset error tuning', async () => {
  const policy = RetryPolicies.tcp({ maxRetries: 2, jitter: false, factor: 1 });
  const delays = await delaysFor(policy, [connectionClosed(), timeout()]);
  // The preset's connection-closed base delay survives the override.
  expect(delays).toEqual([250, 100]);
});

test('maxElapsed bounds the retry sequence', async () => {
  const policy = makeRetryPolicy({
    maxRetries: 100,
    baseDelay: '50 millis',
    factor: 1,
    jitter: false,
    maxElapsed: '120 millis',
  });
  const delays = await delaysFor(policy, Array.from({ length: 10 }, timeout));
  expect(delays.length).toBeLessThan(10);
});

test('retryModbusWithReconnect reconnects only for the configured errors', async () => {
  const policy = makeRetryPolicy({
    maxRetries: 2,
    reconnectOn: ['ModbusConnectionClosedError'],
    ...fast,
  });

  const run = (error: () => ModbusError) => {
    let reconnects = 0;
    const transport = {
      reconnect: () =>
        Effect.sync(() => {
          reconnects += 1;
        }),
    };
    return Effect.fail(error()).pipe(
      retryModbusWithReconnect(transport, policy),
      Effect.either,
      Effect.runPromise,
      (promise) => promise.then(() => reconnects),
    );
  };

  // 3 attempts, each followed by a reconnect.
  expect(await run(connectionClosed)).toBe(3);
  expect(await run(timeout)).toBe(0);
});

test('retryModbusWithReconnect ignores a failing reconnect', async () => {
  const policy = makeRetryPolicy({ maxRetries: 2, ...fast });
  const transport = { reconnect: () => Effect.fail(transportError()) };
  const result = await Effect.fail(connectionClosed()).pipe(
    retryModbusWithReconnect(transport, policy),
    Effect.either,
    Effect.runPromise,
  );
  expect(result).toMatchObject({ _tag: 'Left', left: { _tag: 'ModbusConnectionClosedError' } });
});
