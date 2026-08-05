/**
 * Resilience example — transport-owned retries, backoff, and jitter.
 *
 * Resilience is opt-in and configured on the transport: attach a policy there
 * and every client derived from it carries it, with per-client and
 * per-operation overrides for devices that need different logic.
 *
 * Runs against the in-memory mock transport, whose `fault` hook injects
 * failures underneath the client so the backoff is visible without hardware.
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
import { makeRetryPolicy, retryModbus, RetryPolicies } from '../src/retry';
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
  {
    unitId: 2,
    coils: [],
    discreteInputs: [],
    holdingRegisters: [{ address: 0, default: 7 }],
    inputRegisters: [],
  },
];

/**
 * Fault injection driven through the mock transport, so failures happen where a
 * real device's would: inside the client, underneath the retry policy.
 */
let pending: { remaining: number; error: () => ModbusError } | null = null;

const fault = () => {
  if (!pending || pending.remaining <= 0) return undefined;
  pending.remaining -= 1;
  return pending.error();
};

/** Arms the next `times` attempts to fail with `error`. */
const failNext = (times: number, error: () => ModbusError) =>
  Effect.sync(() => {
    pending = { remaining: times, error };
  });

const timeout = () =>
  new ModbusTimeoutError({ cause: new Error('timeout'), message: 'no response' });

const started = Date.now();
const elapsed = () => `+${String(Date.now() - started).padStart(4, ' ')}ms`;
// Suspended so the timestamp is taken when the log runs, not when it is built.
const log = (message: string) => Effect.suspend(() => Console.log(`[${elapsed()}] ${message}`));

const program = Effect.gen(function* () {
  const transport = yield* TcpTransportService;

  // 1. The transport's policy applies to every client it hands out — the call
  //    site never mentions retries at all.
  const client = yield* transport.withClient(1);
  const read = client.readHoldingRegisters({ address: 0, quantity: 2 });

  yield* log('reading through two injected timeouts (transport policy applies)');
  yield* failNext(2, timeout);
  const registers = yield* read;
  yield* log(`read succeeded: ${Array.from(registers).join(', ')}`);

  // 2. Per-client override: one bus, two device types, different logic.
  const slowDevice = yield* transport.withClient(2, {
    retry: RetryPolicies.serial({ maxRetries: 6, baseDelay: '80 millis' }),
  });
  yield* log('reading unit 2 with its own, more patient policy');
  yield* failNext(3, timeout);
  yield* slowDevice
    .readHoldingRegisters({ address: 0, quantity: 1 })
    .pipe(Effect.andThen(log('read succeeded')));

  // 3. Per-operation override. Replaces the policy rather than stacking with
  //    it, so a write can opt out of retries entirely.
  yield* log('writing with retries disabled for this call only');
  yield* failNext(1, timeout);
  const cautious = client.withRetry(RetryPolicies.none());
  yield* cautious
    .writeSingleRegister({ address: 0, value: 123 })
    .pipe(
      Effect.catchTag('ModbusTimeoutError', (err) =>
        log(`failed on the first attempt, as asked: ${err.message}`),
      ),
    );

  // 4. Error-aware: a busy device (exception 6) is worth asking again; an
  //    illegal data address (exception 2) is not, whatever the budget says.
  yield* log('exception 6 (SERVER_DEVICE_BUSY) — retried');
  yield* failNext(
    2,
    () =>
      new ModbusExceptionError({
        cause: new Error('busy'),
        exception: 6,
        message: 'server device busy',
      }),
  );
  yield* read.pipe(Effect.andThen(log('read succeeded')));

  yield* log('exception 2 (ILLEGAL_DATA_ADDRESS) — not retried');
  yield* failNext(
    99,
    () =>
      new ModbusExceptionError({
        cause: new Error('illegal address'),
        exception: 2,
        message: 'illegal data address',
      }),
  );
  yield* read.pipe(
    Effect.catchTag('ModbusExceptionError', (err) =>
      log(`failed immediately, as expected: exception ${err.exception}`),
    ),
  );

  yield* log('invalid argument — never retried');
  yield* failNext(
    99,
    () =>
      new ModbusInvalidArgumentError({ cause: new Error('bad'), message: 'quantity too large' }),
  );
  yield* read.pipe(
    Effect.catchTag('ModbusInvalidArgumentError', (err) =>
      log(`failed immediately, as expected: ${err.message}`),
    ),
  );

  // 5. Retrying a compound operation as a unit: take a client with no retries
  //    of its own, then drive the whole sequence under one policy.
  yield* log('retrying a read-modify-write as a single transaction');
  yield* failNext(2, timeout);
  const raw = yield* transport.withClient(1, { retry: RetryPolicies.none() });
  yield* Effect.gen(function* () {
    const current = yield* raw.readHoldingRegisters({ address: 0, quantity: 1 });
    yield* raw.writeSingleRegister({ address: 0, value: (current[0] ?? 0) + 1 });
  }).pipe(
    retryModbus(makeRetryPolicy({ maxRetries: 3, baseDelay: '50 millis' })),
    Effect.andThen(log('transaction committed')),
  );

  // 6. The transport publishes its link state for status displays.
  const state = yield* transport.connectionState;
  yield* log(`connection state: ${state._tag}`);
});

const mockLayer = TcpTransportService.makeMockTransport(devices)({
  host: '127.0.0.1',
  port: 502,
  // Attached once, here — every client from this transport inherits it.
  retry: RetryPolicies.tcp(),
  fault,
});

program.pipe(
  Effect.catchAll((err) => Console.log(`Unhandled error: ${err.message}`)),
  Effect.provide(mockLayer),
  Effect.scoped,
  Effect.runPromise,
);
