import { expect, test } from 'bun:test';

import { Effect, Exit, Fiber } from 'effect';

import { ModbusTimeoutError, type ModbusError } from './errors';
import { makeReadDebouncer, type ReadDebouncer } from './read-debouncer';
import type { ReadSpan } from './register-plan';

/**
 * A device whose register `n` holds `n * 10`, recording every span it is asked
 * for.
 */
const makeDevice = (config?: { fail?: () => boolean; short?: boolean }) => {
  const requests: Array<ReadonlyArray<ReadSpan>> = [];

  const fetch = (
    spans: ReadonlyArray<ReadSpan>,
  ): Effect.Effect<ReadonlyArray<Uint16Array>, ModbusError> =>
    Effect.suspend(() => {
      requests.push(spans);
      if (config?.fail?.()) {
        const message = 'bus is down';
        return Effect.fail(new ModbusTimeoutError({ cause: new Error(message), message }));
      }
      return Effect.succeed(
        spans.map((span) =>
          Uint16Array.from(
            { length: config?.short === true ? span.quantity - 1 : span.quantity },
            (_, index) => (span.address + index) * 10,
          ),
        ),
      );
    });

  return { requests, fetch };
};

/** Runs `use` against a read debouncer in a scope that closes when it returns. */
const withDebouncer = <A, E>(
  options: Parameters<typeof makeReadDebouncer>[0],
  use: (debouncer: ReadDebouncer) => Effect.Effect<A, E>,
) => Effect.runPromise(Effect.scoped(Effect.flatMap(makeReadDebouncer(options), use)));

test('readers that arrive separately are answered by the planned spans', async () => {
  const device = makeDevice();
  const addresses = [0x0000, 0x0001, 0x0002, 0x0020, 0x0021];

  const values = await withDebouncer({ window: '20 millis', fetch: device.fetch }, (debouncer) =>
    Effect.forEach(addresses, debouncer.read, { concurrency: 'unbounded' }),
  );

  expect(values).toEqual(addresses.map((address) => address * 10));
  // Five accessors, one batch, two transactions.
  expect(device.requests).toEqual([
    [
      { address: 0x0000, quantity: 3 },
      { address: 0x0020, quantity: 2 },
    ],
  ]);
});

test('a repeated address is read once and answered for every reader', async () => {
  const device = makeDevice();

  const values = await withDebouncer({ window: '20 millis', fetch: device.fetch }, (debouncer) =>
    Effect.forEach([5, 5, 5], debouncer.read, { concurrency: 'unbounded' }),
  );

  expect(values).toEqual([50, 50, 50]);
  expect(device.requests).toEqual([[{ address: 5, quantity: 1 }]]);
});

test('the window does not restart, so a stream of readers cannot push it out', async () => {
  const device = makeDevice();

  await withDebouncer({ window: '30 millis', fetch: device.fetch }, (debouncer) =>
    Effect.gen(function* () {
      // Arrivals every 10ms would postpone a restarting window forever.
      const fibers: Array<Fiber.Fiber<number, ModbusError>> = [];
      for (let index = 0; index < 8; index += 1) {
        fibers.push(yield* Effect.forkChild(debouncer.read(index)));
        yield* Effect.sleep('10 millis');
      }
      yield* Fiber.joinAll(fibers);
    }),
  );

  expect(device.requests.length).toBeGreaterThan(1);
});

test('a zero window reads straight through, one transaction each', async () => {
  const device = makeDevice();

  const values = await withDebouncer({ window: 0, fetch: device.fetch }, (debouncer) =>
    Effect.forEach([1, 2], debouncer.read, { concurrency: 'unbounded' }),
  );

  expect(values).toEqual([10, 20]);
  expect(device.requests).toHaveLength(2);
});

test('a failed read fails every reader in the batch', async () => {
  const device = makeDevice({ fail: () => true });

  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.flatMap(makeReadDebouncer({ window: '20 millis', fetch: device.fetch }), (d) =>
        Effect.all([d.read(1), d.read(2)], { concurrency: 'unbounded' }),
      ),
    ),
  );

  expect(Exit.isFailure(exit)).toBe(true);
});

test('a response that is short of the span it promised fails as a transport error', async () => {
  const device = makeDevice({ short: true });

  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.flatMap(makeReadDebouncer({ window: 0, fetch: device.fetch }), (d) => d.read(1)),
    ),
  );

  expect(Exit.isFailure(exit)).toBe(true);
});

test('readNow answers the readers already collected, in the same transaction', async () => {
  const device = makeDevice();

  const values = await withDebouncer({ window: '5 seconds', fetch: device.fetch }, (debouncer) =>
    Effect.gen(function* () {
      const waiting = yield* Effect.forkChild(debouncer.read(1));
      yield* Effect.sleep('10 millis');
      const immediate = yield* debouncer.readNow(2);
      return [yield* Fiber.join(waiting), immediate];
    }),
  );

  expect(values).toEqual([10, 20]);
  // No reader waited longer because of the immediate call.
  expect(device.requests).toEqual([[{ address: 1, quantity: 2 }]]);
});

test('a gap tolerance merges two spans into one transaction', async () => {
  const device = makeDevice();

  await withDebouncer(
    { window: '20 millis', plan: { maxGap: 4 }, fetch: device.fetch },
    (debouncer) => Effect.forEach([10, 14], debouncer.read, { concurrency: 'unbounded' }),
  );

  expect(device.requests).toEqual([[{ address: 10, quantity: 5 }]]);
});
