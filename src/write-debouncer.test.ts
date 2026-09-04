import { expect, test } from 'bun:test';

import { Deferred, Effect, Exit, Fiber, Scope } from 'effect';

import { ModbusTimeoutError, type ModbusError } from './errors';
import { createWriteDebouncer, type DebouncedWrite, type WriteDebouncer } from './write-debouncer';

/** Records every batch handed to the flush, and what each one wrote. */
const makeRecorder = (fail?: () => boolean) => {
  const batches: Array<ReadonlyArray<DebouncedWrite>> = [];
  const held = new Map<number, number>();

  const flush = (batch: ReadonlyArray<DebouncedWrite>): Effect.Effect<void, ModbusError> =>
    Effect.suspend(() => {
      batches.push(batch);
      if (fail?.()) {
        const message = 'bus is down';
        return Effect.fail(new ModbusTimeoutError({ cause: new Error(message), message }));
      }
      for (const write of batch) held.set(write.address, write.value);
      return Effect.void;
    });

  return { batches, held, flush };
};

/** Runs `use` against a debouncer in a scope that closes when it returns. */
const withDebouncer = <A, E>(
  options: Omit<Parameters<typeof createWriteDebouncer>[0], 'flush'> & {
    flush: (batch: ReadonlyArray<DebouncedWrite>) => Effect.Effect<void, ModbusError>;
  },
  use: (debouncer: WriteDebouncer) => Effect.Effect<A, E>,
) => Effect.runPromise(Effect.scoped(Effect.flatMap(createWriteDebouncer(options), use)));

test('two callers that never meet reach the bus in one batch', async () => {
  const recorder = makeRecorder();

  await withDebouncer({ window: '40 millis', flush: recorder.flush }, (debouncer) =>
    Effect.all(
      [
        debouncer.write({ address: 2000, value: 100 }, { 'app.point': 'Supply' }),
        debouncer.write({ address: 2001, value: 200 }, { 'app.point': 'Exhaust' }),
      ],
      { concurrency: 'unbounded' },
    ),
  );

  expect(recorder.batches).toHaveLength(1);
  expect(recorder.batches[0]).toHaveLength(2);
  expect(recorder.batches[0]!.map((write) => write.attributes)).toEqual([
    { 'app.point': 'Supply' },
    { 'app.point': 'Exhaust' },
  ]);
});

test('a later write to one address replaces the value and keeps both waiters', async () => {
  const recorder = makeRecorder();

  await withDebouncer({ window: '40 millis', flush: recorder.flush }, (debouncer) =>
    Effect.all(
      [
        debouncer.write({ address: 2000, value: 100 }),
        debouncer.write({ address: 2000, value: 700 }),
      ],
      { concurrency: 'unbounded' },
    ),
  );

  // Both callers returned, and only the newest value went to the bus.
  expect(recorder.batches).toEqual([[{ address: 2000, value: 700, attributes: undefined }]]);
  expect(recorder.held.get(2000)).toBe(700);
});

test('the ceiling flushes a stream that keeps restarting the window', async () => {
  const recorder = makeRecorder();

  await withDebouncer(
    { window: '50 millis', maxHold: '60 millis', flush: recorder.flush },
    (debouncer) =>
      Effect.gen(function* () {
        // Arrivals every 15ms keep resetting a 50ms window. Without the ceiling
        // nothing reaches the bus until the stream stops at ~150ms.
        const fibers: Array<Fiber.Fiber<void, ModbusError>> = [];
        for (let index = 0; index < 10; index += 1) {
          fibers.push(yield* Effect.forkChild(debouncer.write({ address: 2000, value: index })));
          yield* Effect.sleep('15 millis');
        }
        yield* Fiber.joinAll(fibers);
      }),
  );

  expect(recorder.batches.length).toBeGreaterThan(1);
});

test('a zero window writes straight through, one batch each', async () => {
  const recorder = makeRecorder();

  await withDebouncer({ window: 0, flush: recorder.flush }, (debouncer) =>
    Effect.all(
      [
        debouncer.write({ address: 2000, value: 100 }),
        debouncer.write({ address: 2001, value: 200 }),
      ],
      { concurrency: 'unbounded' },
    ),
  );

  // No timer and no batch: the escape hatch for a harness that settles by
  // yielding rather than by advancing a clock.
  expect(recorder.batches).toHaveLength(2);
});

test('zero-window writes cannot apply an older value after a newer one', async () => {
  const applied: number[] = [];

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        let flushCount = 0;
        const flush = (batch: ReadonlyArray<DebouncedWrite>) =>
          Effect.gen(function* () {
            flushCount += 1;
            if (flushCount === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            for (const write of batch) applied.push(write.value);
          });

        const debouncer = yield* createWriteDebouncer({ window: 0, flush });
        const older = yield* Effect.forkChild(debouncer.write({ address: 2000, value: 100 }));
        yield* Deferred.await(firstStarted);

        const newer = yield* Effect.forkChild(debouncer.writeNow({ address: 2000, value: 200 }));
        yield* Effect.sleep('10 millis');
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Effect.all([Fiber.join(older), Fiber.join(newer)], { concurrency: 'unbounded' });
      }),
    ),
  );

  expect(applied).toEqual([100, 200]);
});

test('a failed flush fails the callers whose values it carried', async () => {
  const recorder = makeRecorder(() => true);

  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.flatMap(createWriteDebouncer({ window: '20 millis', flush: recorder.flush }), (d) =>
        Effect.all(
          [d.write({ address: 2000, value: 100 }), d.write({ address: 2001, value: 200 })],
          { concurrency: 'unbounded' },
        ),
      ),
    ),
  );

  // "The effect succeeded" has to keep meaning "the value reached the device".
  expect(Exit.isFailure(exit)).toBe(true);
});

test('writeNow supersedes a held write rather than passing it', async () => {
  const recorder = makeRecorder();

  await withDebouncer({ window: '200 millis', flush: recorder.flush }, (debouncer) =>
    Effect.gen(function* () {
      const held = yield* Effect.forkChild(debouncer.write({ address: 2000, value: 500 }));
      // Let the first write settle into the batch before the immediate one.
      yield* Effect.sleep('10 millis');
      yield* debouncer.writeNow({ address: 2000, value: 800 });
      yield* Fiber.join(held);
    }),
  );

  // A path around the batch would write 800 first and then 500 when the window
  // closed, leaving the device holding the older value.
  expect(recorder.batches).toEqual([[{ address: 2000, value: 800, attributes: undefined }]]);
  expect(recorder.held.get(2000)).toBe(800);
});

test('writeNow carries along whatever else is already held', async () => {
  const recorder = makeRecorder();

  await withDebouncer({ window: '200 millis', flush: recorder.flush }, (debouncer) =>
    Effect.gen(function* () {
      const held = yield* Effect.forkChild(debouncer.write({ address: 2000, value: 500 }));
      yield* Effect.sleep('10 millis');
      yield* debouncer.writeNow({ address: 2001, value: 800 });
      yield* Fiber.join(held);
    }),
  );

  expect(recorder.batches).toHaveLength(1);
  expect(recorder.batches[0]).toHaveLength(2);
});

test('overlapping flushes cannot apply an older value after a newer one', async () => {
  const applied: number[] = [];

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        let flushCount = 0;
        const flush = (batch: ReadonlyArray<DebouncedWrite>) =>
          Effect.gen(function* () {
            flushCount += 1;
            if (flushCount === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            for (const write of batch) applied.push(write.value);
          });

        const debouncer = yield* createWriteDebouncer({ window: '10 millis', flush });
        const older = yield* Effect.forkChild(debouncer.write({ address: 2000, value: 100 }));
        yield* Deferred.await(firstStarted);

        const newer = yield* Effect.forkChild(debouncer.writeNow({ address: 2000, value: 200 }));
        yield* Effect.sleep('10 millis');
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Effect.all([Fiber.join(older), Fiber.join(newer)], { concurrency: 'unbounded' });

        return flushCount;
      }),
    ),
  );

  expect(result).toBe(2);
  expect(applied).toEqual([100, 200]);
});

test('a new write does not interrupt a flush already in progress', async () => {
  const applied: number[] = [];

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        let flushCount = 0;
        const flush = (batch: ReadonlyArray<DebouncedWrite>) =>
          Effect.gen(function* () {
            flushCount += 1;
            if (flushCount === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            for (const write of batch) applied.push(write.value);
          });

        const debouncer = yield* createWriteDebouncer({ window: '10 millis', flush });
        const older = yield* Effect.forkChild(debouncer.write({ address: 2000, value: 100 }));
        yield* Deferred.await(firstStarted);

        const newer = yield* Effect.forkChild(debouncer.write({ address: 2000, value: 200 }));
        yield* Effect.sleep('20 millis');
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Effect.all([Fiber.join(older), Fiber.join(newer)], { concurrency: 'unbounded' });
      }),
    ),
  );

  expect(applied).toEqual([100, 200]);
});

test('an expired stale timer cannot flush a replacement batch early', async () => {
  const applied: number[] = [];

  const earlyFlushCount = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        let flushCount = 0;
        const flush = (batch: ReadonlyArray<DebouncedWrite>) =>
          Effect.gen(function* () {
            flushCount += 1;
            if (flushCount === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            for (const write of batch) applied.push(write.value);
          });

        const debouncer = yield* createWriteDebouncer({
          window: '30 millis',
          maxHold: '500 millis',
          flush,
        });
        const first = yield* Effect.forkChild(debouncer.write({ address: 2000, value: 100 }));
        yield* Deferred.await(firstStarted);

        const stale = yield* Effect.forkChild(debouncer.write({ address: 2000, value: 200 }));
        yield* Effect.sleep('45 millis');
        const replacement = yield* Effect.forkChild(debouncer.write({ address: 2000, value: 300 }));
        yield* Effect.sleep('1 millis');
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Effect.sleep('5 millis');
        const beforeReplacementWindow = flushCount;

        yield* Effect.all([Fiber.join(first), Fiber.join(stale), Fiber.join(replacement)], {
          concurrency: 'unbounded',
        });
        return beforeReplacementWindow;
      }),
    ),
  );

  expect(earlyFlushCount).toBe(1);
  expect(applied).toEqual([100, 300]);
});

test('interrupting a public flush does not cancel its write or strand its waiter', async () => {
  const applied = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const values: number[] = [];
        const debouncer = yield* createWriteDebouncer({
          window: '10 seconds',
          flush: (batch) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              values.push(...batch.map((write) => write.value));
            }),
        });

        const writer = yield* Effect.forkChild(debouncer.write({ address: 2000, value: 100 }));
        while (debouncer.pending === 0) yield* Effect.yieldNow;
        const flusher = yield* Effect.forkChild(debouncer.flush);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(flusher);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(writer);
        return values;
      }),
    ),
  );

  expect(applied).toEqual([100]);
});

test('writeNow fails promptly after its scope closes', async () => {
  const recorder = makeRecorder();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const debouncer = yield* Effect.provideService(
        createWriteDebouncer({ window: '10 seconds', flush: recorder.flush }),
        Scope.Scope,
        scope,
      );
      yield* Scope.close(scope, Exit.void);

      return yield* Effect.race(
        Effect.map(Effect.result(debouncer.writeNow({ address: 2000, value: 100 })), (result) =>
          result._tag === 'Failure' ? result.failure._tag : result._tag,
        ),
        Effect.as(Effect.sleep('100 millis'), 'Timeout' as const),
      );
    }),
  );

  expect(result).toBe('ModbusNotConnectedError');
  expect(recorder.batches).toHaveLength(0);
});

test('closing the scope interrupts a caller still waiting', async () => {
  const recorder = makeRecorder();

  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const debouncer = yield* Effect.provideService(
        createWriteDebouncer({ window: '10 seconds', flush: recorder.flush }),
        Scope.Scope,
        scope,
      );

      const started = yield* Deferred.make<void>();
      const caller = yield* Effect.forkChild(
        Effect.andThen(
          Deferred.succeed(started, undefined),
          debouncer.write({ address: 2000, value: 100 }),
        ),
      );
      yield* Deferred.await(started);
      yield* Effect.sleep('20 millis');

      yield* Scope.close(scope, Exit.void);
      return yield* Fiber.await(caller);
    }),
  );

  // The write never reached the device, so the caller must not be told it did.
  expect(Exit.isSuccess(exit)).toBe(true);
  const callerExit = Exit.isSuccess(exit) ? exit.value : undefined;
  expect(callerExit !== undefined && Exit.hasInterrupts(callerExit)).toBe(true);
  expect(recorder.batches).toHaveLength(0);
});

test('closing the scope interrupts an active flush', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const started = yield* Deferred.make<void>();
      const debouncer = yield* Effect.provideService(
        createWriteDebouncer({
          window: '10 millis',
          flush: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }),
        }),
        Scope.Scope,
        scope,
      );

      const caller = yield* Effect.forkChild(debouncer.write({ address: 2000, value: 100 }));
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

test('writeAll issues a group as one caller, even with no window', async () => {
  const recorder = makeRecorder();

  await withDebouncer({ window: 0, flush: recorder.flush }, (debouncer) =>
    debouncer.writeAll([
      { address: 2000, value: 10 },
      { address: 2001, value: 20 },
    ]),
  );

  // A caller that already holds every value needs a planner, not a window.
  expect(recorder.batches).toHaveLength(1);
  expect(recorder.batches[0]).toHaveLength(2);
});

test('writeAll does not let a held write land after a newer value', async () => {
  const recorder = makeRecorder();

  await withDebouncer({ window: '200 millis', flush: recorder.flush }, (debouncer) =>
    Effect.gen(function* () {
      const held = yield* Effect.forkChild(debouncer.write({ address: 2000, value: 500 }));
      yield* Effect.sleep('10 millis');
      yield* debouncer.writeAllNow([{ address: 2000, value: 800 }]);
      yield* Fiber.join(held);
    }),
  );

  expect(recorder.held.get(2000)).toBe(800);
});

test('writeAll of nothing does nothing', async () => {
  const recorder = makeRecorder();

  await withDebouncer({ window: '20 millis', flush: recorder.flush }, (debouncer) =>
    debouncer.writeAll([]),
  );

  expect(recorder.batches).toHaveLength(0);
});
