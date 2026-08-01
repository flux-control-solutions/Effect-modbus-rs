/**
 * Retry policy example — backoff, jitter, and error-aware retries.
 *
 * Retries are always opt-in: nothing in this library retries on your behalf.
 * You pick a template from {@link RetryPolicies} (or build one with
 * {@link makeRetryPolicy}) and pipe the operations you want protected through
 * {@link retryModbus} / {@link retryModbusWithReconnect}.
 *
 * Runs against the in-memory mock transport, with a small "flaky bus" wrapper
 * that injects failures so the backoff is visible without hardware.
 *
 * @example bun run examples/retry-policies.ts
 */

import { Console, Effect } from 'effect';

import type { ModbusError } from '../src/errors';
import {
  ModbusExceptionError,
  ModbusInvalidArgumentError,
  ModbusTimeoutError,
} from '../src/errors';
import {
  makeRetryPolicy,
  retryModbus,
  retryModbusWithReconnect,
  RetryPolicies,
} from '../src/retry';
import { TcpTransportService } from '../src/TcpTransportService';

const devices = [
  {
    unitId: 1,
    coils: [],
    discreteInputs: [],
    holdingRegisters: [
      { address: 0, default: 42 },
      { address: 1, default: 99 },
    ],
    inputRegisters: [],
  },
];

/**
 * Fails the first `times` invocations with `error`, then delegates to `effect`.
 * Stands in for a noisy bus so the example is runnable without a device.
 */
const flaky = <A, R>(
  times: number,
  error: () => ModbusError,
  effect: Effect.Effect<A, ModbusError, R>,
) => {
  let calls = 0;
  return Effect.suspend(() => {
    calls += 1;
    return calls <= times ? Effect.fail(error()) : effect;
  });
};

const started = Date.now();
const elapsed = () => `+${String(Date.now() - started).padStart(4, ' ')}ms`;
// Suspended so the timestamp is taken when the log runs, not when it is built.
const log = (message: string) => Effect.suspend(() => Console.log(`[${elapsed()}] ${message}`));

const program = Effect.gen(function* () {
  const transport = yield* TcpTransportService;
  const client = yield* transport.withClient(1);

  const read = client.readHoldingRegisters({ address: 0, quantity: 2 });

  // 1. A template, used as-is. Two timeouts are absorbed; the caller only sees
  //    the successful read.
  yield* log('reading with RetryPolicies.tcp() through two injected timeouts');
  const registers = yield* flaky(
    2,
    () => new ModbusTimeoutError({ cause: new Error('timeout'), message: 'no response' }),
    read,
  ).pipe(retryModbus(RetryPolicies.tcp()));
  yield* log(`read succeeded: ${Array.from(registers).join(', ')}`);

  // 2. A template with overrides — the timeout curve is retuned for this call
  //    site, everything else stays as the template set it.
  yield* log('reading with a slower, longer serial policy');
  const slowSerial = RetryPolicies.serial({
    maxRetries: 6,
    errors: { ModbusTimeoutError: { baseDelay: '80 millis', maxDelay: '2 seconds' } },
  });
  yield* flaky(
    3,
    () => new ModbusTimeoutError({ cause: new Error('timeout'), message: 'no response' }),
    read,
  ).pipe(retryModbus(slowSerial), Effect.andThen(log('read succeeded')));

  // 3. Error-aware: a device that is busy (exception 6) is worth asking again;
  //    an illegal data address (exception 2) is not, so it fails immediately
  //    even under a policy with a generous retry budget.
  const policy = makeRetryPolicy({ maxRetries: 4, baseDelay: '50 millis' });

  yield* log('exception 6 (SERVER_DEVICE_BUSY) — retried');
  yield* flaky(
    2,
    () =>
      new ModbusExceptionError({
        cause: new Error('busy'),
        exception: 6,
        message: 'server device busy',
      }),
    read,
  ).pipe(retryModbus(policy), Effect.andThen(log('read succeeded')));

  yield* log('exception 2 (ILLEGAL_DATA_ADDRESS) — not retried');
  yield* flaky(
    99,
    () =>
      new ModbusExceptionError({
        cause: new Error('illegal address'),
        exception: 2,
        message: 'illegal data address',
      }),
    read,
  ).pipe(
    retryModbus(policy),
    Effect.catchTag('ModbusExceptionError', (err) =>
      log(`failed immediately, as expected: exception ${err.exception}`),
    ),
  );

  // 4. Argument errors are never retried, whatever the policy says.
  yield* log('invalid argument — not retried');
  yield* flaky(
    99,
    () =>
      new ModbusInvalidArgumentError({ cause: new Error('bad'), message: 'quantity too large' }),
    read,
  ).pipe(
    retryModbus(policy),
    Effect.catchTag('ModbusInvalidArgumentError', (err) =>
      log(`failed immediately, as expected: ${err.message}`),
    ),
  );

  // 5. Connection-level failures: reconnect the transport before retrying.
  //    Replaces the manual catchTags + reconnect + fail dance in pollers.
  yield* log('reading with reconnect-aware retries');
  yield* read.pipe(
    retryModbusWithReconnect(transport, RetryPolicies.tcp()),
    Effect.andThen(log('read succeeded')),
  );
});

const mockLayer = TcpTransportService.makeMockTransport(devices)({
  host: '127.0.0.1',
  port: 502,
});

program.pipe(
  Effect.catchAll((err) => Console.log(`Unhandled error: ${err.message}`)),
  Effect.provide(mockLayer),
  Effect.scoped,
  Effect.runPromise,
);
