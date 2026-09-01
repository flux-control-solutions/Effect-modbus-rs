import { expect, test } from 'bun:test';

import { Deferred, Effect, Exit, Fiber, Scope } from 'effect';

import { ModbusTimeoutError, type ModbusError } from './errors';
import { makeWriteDebouncer, type DebouncedWrite, type WriteDebouncer } from './write-debouncer';

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
  options: Omit<Parameters<typeof makeWriteDebouncer>[0], 'flush'> & {
    flush: (batch: ReadonlyArray<DebouncedWrite>) => Effect.Effect<void, ModbusError>;
  },
  use: (debouncer: WriteDebouncer) => Effect.Effect<A, E>,
) => Effect.runPromise(Effect.scoped(Effect.flatMap(makeWriteDebouncer(options), use)));

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

test('a failed flush fails the callers whose values it carried', async () => {
  const recorder = makeRecorder(() => true);

  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.flatMap(makeWriteDebouncer({ window: '20 millis', flush: recorder.flush }), (d) =>
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

test('closing the scope interrupts a caller still waiting', async () => {
  const recorder = makeRecorder();

  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const debouncer = yield* Effect.provideService(
        makeWriteDebouncer({ window: '10 seconds', flush: recorder.flush }),
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
