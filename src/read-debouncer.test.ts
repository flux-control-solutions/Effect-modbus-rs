import { expect, test } from 'bun:test';

import { Deferred, Effect, Exit, Fiber, Scope } from 'effect';

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

test('an invalid reader does not fail valid readers in the same window', async () => {
  const device = makeDevice();
  const results = await withDebouncer({ window: '20 millis', fetch: device.fetch }, (debouncer) =>
    Effect.all([Effect.result(debouncer.read(0x10000)), Effect.result(debouncer.read(5))], {
      concurrency: 'unbounded',
    }),
  );

  expect(results[0]).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'ModbusInvalidArgumentError' },
  });
  expect(results[1]._tag).toBe('Success');
  if (results[1]._tag === 'Success') expect(results[1].success).toBe(50);
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

test('a read arriving during an active fetch starts the next window', async () => {
  const requests: Array<ReadonlyArray<ReadSpan>> = [];

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        let fetchCount = 0;
        const fetch = (spans: ReadonlyArray<ReadSpan>) =>
          Effect.gen(function* () {
            requests.push(spans);
            fetchCount += 1;
            if (fetchCount === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            return spans.map((span) =>
              Uint16Array.from(
                { length: span.quantity },
                (_, index) => (span.address + index) * 10,
              ),
            );
          });

        const debouncer = yield* makeReadDebouncer({ window: '10 millis', fetch });
        const first = yield* Effect.forkChild(debouncer.read(1));
        yield* Deferred.await(firstStarted);

        const second = yield* Effect.forkChild(debouncer.read(2));
        yield* Effect.sleep('1 millis');
        expect(debouncer.pending).toBe(1);
        yield* Deferred.succeed(releaseFirst, undefined);
        const firstValue = yield* Fiber.join(first);
        const secondResult = yield* Effect.race(
          Effect.map(Fiber.join(second), (value) => ({ _tag: 'Value' as const, value })),
          Effect.as(Effect.sleep('100 millis'), { _tag: 'Timeout' as const }),
        );

        return { firstValue, secondResult, pending: debouncer.pending };
      }),
    ),
  );

  expect(result).toEqual({
    firstValue: 10,
    secondResult: { _tag: 'Value', value: 20 },
    pending: 0,
  });
  expect(requests).toEqual([[{ address: 1, quantity: 1 }], [{ address: 2, quantity: 1 }]]);
});

test('interrupting a public flush does not cancel its read or strand its reader', async () => {
  const value = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const debouncer = yield* makeReadDebouncer({
          window: '10 seconds',
          fetch: (spans) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return spans.map((span) => Uint16Array.from({ length: span.quantity }, () => 70));
            }),
        });

        const reader = yield* Effect.forkChild(debouncer.read(7));
        while (debouncer.pending === 0) yield* Effect.yieldNow;
        const flusher = yield* Effect.forkChild(debouncer.flush);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(flusher);
        yield* Deferred.succeed(release, undefined);
        return yield* Fiber.join(reader);
      }),
    ),
  );

  expect(value).toBe(70);
});

test('readNow fails promptly after its scope closes', async () => {
  const device = makeDevice();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const debouncer = yield* Effect.provideService(
        makeReadDebouncer({ window: '10 seconds', fetch: device.fetch }),
        Scope.Scope,
        scope,
      );
      yield* Scope.close(scope, Exit.void);

      return yield* Effect.race(
        Effect.map(Effect.result(debouncer.readNow(7)), (result) =>
          result._tag === 'Failure' ? result.failure._tag : result._tag,
        ),
        Effect.as(Effect.sleep('100 millis'), 'Timeout' as const),
      );
    }),
  );

  expect(result).toBe('ModbusNotConnectedError');
  expect(device.requests).toHaveLength(0);
});

test('closing the scope interrupts an active fetch', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const started = yield* Deferred.make<void>();
      const debouncer = yield* Effect.provideService(
        makeReadDebouncer({
          window: '10 millis',
          fetch: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }),
        }),
        Scope.Scope,
        scope,
      );

      const caller = yield* Effect.forkChild(debouncer.read(1));
      yield* Deferred.await(started);

      const closed = yield* Effect.race(
        Effect.as(Scope.close(scope, Exit.void), 'Closed' as const),
        Effect.as(Effect.sleep('100 millis'), 'Timeout' as const),
      );
      const callerExit = closed === 'Closed' ? yield* Fiber.await(caller) : undefined;
      return { closed, callerExit };
    }),
  );

  expect(result.closed).toBe('Closed');
  expect(result.callerExit !== undefined && Exit.hasInterrupts(result.callerExit)).toBe(true);
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

test('a short response fails every reader sharing its span', async () => {
  const device = makeDevice({ short: true });

  const results = await withDebouncer({ window: '20 millis', fetch: device.fetch }, (debouncer) =>
    Effect.all([Effect.result(debouncer.read(1)), Effect.result(debouncer.read(2))], {
      concurrency: 'unbounded',
    }),
  );

  expect(results).toMatchObject([
    { _tag: 'Failure', failure: { _tag: 'ModbusTransportError' } },
    { _tag: 'Failure', failure: { _tag: 'ModbusTransportError' } },
  ]);
});

test('a missing span response fails the read as a transport error', async () => {
  const result = await withDebouncer({ window: 0, fetch: () => Effect.succeed([]) }, (debouncer) =>
    Effect.result(debouncer.read(1)),
  );

  expect(result).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'ModbusTransportError' },
  });
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

test('readAll plans a group into spans, even with no window', async () => {
  const device = makeDevice();
  const addresses = [0x0000, 0x0001, 0x0002, 0x0020, 0x0021];

  const values = await withDebouncer({ window: 0, fetch: device.fetch }, (debouncer) =>
    debouncer.readAll(addresses),
  );

  expect(values).toEqual(addresses.map((address) => address * 10));
  // A reader that already holds every address needs a planner, not a window.
  expect(device.requests).toEqual([
    [
      { address: 0x0000, quantity: 3 },
      { address: 0x0020, quantity: 2 },
    ],
  ]);
});

test('readAll returns values in the order asked for, not in address order', async () => {
  const device = makeDevice();

  const values = await withDebouncer({ window: 0, fetch: device.fetch }, (debouncer) =>
    debouncer.readAll([3, 1, 2, 1]),
  );

  expect(values).toEqual([30, 10, 20, 10]);
});

test('readAll of nothing reads nothing', async () => {
  const device = makeDevice();

  const values = await withDebouncer({ window: '20 millis', fetch: device.fetch }, (debouncer) =>
    debouncer.readAll([]),
  );

  expect(values).toEqual([]);
  expect(device.requests).toHaveLength(0);
});

test('readAll joins the batch when a window is open', async () => {
  const device = makeDevice();

  await withDebouncer({ window: '30 millis', fetch: device.fetch }, (debouncer) =>
    Effect.all([debouncer.read(0), debouncer.readAll([1, 2])], { concurrency: 'unbounded' }),
  );

  expect(device.requests).toEqual([[{ address: 0, quantity: 3 }]]);
});
