import { test, expect } from 'bun:test';

import { Effect, Result, Exit, Fiber, Option, Scope, SubscriptionRef } from 'effect';
import type { AsyncSerialModbusClient } from 'modbus-rs';

import { RetryPolicies } from '../src/retry';
import { createTransportScoped, type TransportResilienceOptions } from '../src/shared-transport';

interface FakeOptions {
  readonly label: string;
  readonly responseTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const unusedClientMethod = async (): Promise<never> => {
  throw new Error('unexpected fake client method');
};

const makeClient = (
  writeSingleRegister: AsyncSerialModbusClient['writeSingleRegister'] = unusedClientMethod,
  readHoldingRegisters: AsyncSerialModbusClient['readHoldingRegisters'] = unusedClientMethod,
): AsyncSerialModbusClient => ({
  pendingRequests: false,
  isConnected: () => true,
  readHoldingRegisters,
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
  client?: AsyncSerialModbusClient;
  clientFor?: (unitId: number) => AsyncSerialModbusClient;
  onReconnect?: () => void;
  openOptions?: { readonly responseTimeoutMs?: number };
  resilience?: TransportResilienceOptions;
}) => {
  const requestTimeouts: Array<number> = [];
  const calls = { open: 0, reconnect: 0, close: 0, requestTimeouts };
  const openOptions: unknown[] = [];
  const client = config?.client ?? makeClient();

  const transport = {
    close: async () => {
      calls.close += 1;
    },
    createClient: (opts: { unitId: number }) => config?.clientFor?.(opts.unitId) ?? client,
    setRequestTimeout: (ms: number) => {
      calls.requestTimeouts.push(ms);
    },
    clearRequestTimeout: () => {},
    reconnect: async () => {
      calls.reconnect += 1;
      await sleep(config?.reconnectDelayMs ?? 0);
      if (config?.reconnectFails?.()) throw new Error('reconnect failed');
      config?.onReconnect?.();
    },
    pendingRequests: false,
  };

  const open = async (options: FakeOptions) => {
    openOptions.push(options);
    calls.open += 1;
    await sleep(config?.openDelayMs ?? 0);
    return transport;
  };

  const make = createTransportScoped<FakeOptions, AsyncSerialModbusClient, typeof transport>(
    'AsyncRtuTransport',
    (_constructor, options) => open(options),
    'FakeTransport',
    { nativeTimeout: { requestTimeoutMs: (options) => options.responseTimeoutMs } },
  );

  return {
    calls,
    openOptions,
    make: () => make({ label: 'test', ...config?.openOptions, ...config?.resilience }),
  };
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

const failureTag = <A>(exit: Exit.Exit<A, { readonly _tag: string }>) =>
  Option.getOrNull(Option.map(Exit.findErrorOption(exit), (error) => error._tag));

test('the connect timeout is not passed to the native open', async () => {
  const fake = makeFake({ resilience: { connectTimeout: '1 second' } });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();
      yield* api.withClient(1);
      expect(fake.openOptions).toEqual([{ label: 'test' }]);
    }),
  );
});

test('a lazy open that exceeds the connect timeout fails every waiter', async () => {
  const fake = makeFake({ openDelayMs: 80, resilience: { connectTimeout: '10 millis' } });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();

      const exits = yield* Effect.all(
        [api.withClient(1), api.withClient(2)].map((effect) => Effect.exit(effect)),
        { concurrency: 'unbounded' },
      );

      expect(exits.map(failureTag)).toEqual(['ModbusTimeoutError', 'ModbusTimeoutError']);
      expect(fake.calls.open).toBe(1);
      expect(SubscriptionRef.getUnsafe(api.connectionState)._tag).toBe('Disconnected');
    }),
  );
});

test('operations after a connect timeout join the pending native open', async () => {
  const fake = makeFake({ openDelayMs: 60, resilience: { connectTimeout: '10 millis' } });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();

      expect(failureTag(yield* Effect.exit(api.withClient(1)))).toBe('ModbusTimeoutError');
      expect(failureTag(yield* Effect.exit(api.withClient(1)))).toBe('ModbusTimeoutError');
      // Each caller waited again, but no second native open started.
      expect(fake.calls.open).toBe(1);

      // The native open completes with no caller waiting, and the transport uses it.
      yield* Effect.sleep('80 millis');
      expect(SubscriptionRef.getUnsafe(api.connectionState)._tag).toBe('Connected');
      yield* api.withClient(1);
      expect(fake.calls.open).toBe(1);
      expect(fake.calls.close).toBe(0);
    }),
  );
});

test('the next operation after a failed native open starts a new open', async () => {
  let openDelayMs = 30;
  let openFails = true;
  const calls = { open: 0 };
  const transport = {
    close: async () => {},
    createClient: (_opts: { unitId: number }) => makeClient(),
    setRequestTimeout: (_ms: number) => {},
    clearRequestTimeout: () => {},
    reconnect: async () => {},
    pendingRequests: false,
  };
  const make = createTransportScoped<FakeOptions, AsyncSerialModbusClient, typeof transport>(
    'AsyncRtuTransport',
    async () => {
      calls.open += 1;
      await sleep(openDelayMs);
      if (openFails) throw new Error('connect refused');
      return transport;
    },
    'FailingOpenTransport',
  );

  await run(
    Effect.gen(function* () {
      const api = yield* make({ label: 'test', connectTimeout: '10 millis' });

      expect(failureTag(yield* Effect.exit(api.withClient(1)))).toBe('ModbusTimeoutError');

      // After the native open fails, the shared open is cleared.
      yield* Effect.sleep('50 millis');
      openDelayMs = 0;
      openFails = false;
      yield* api.withClient(1);
      expect(calls.open).toBe(2);
      expect(SubscriptionRef.getUnsafe(api.connectionState)._tag).toBe('Connected');
    }),
  );
});

test('a timed-out open that completes after teardown is closed', async () => {
  const fake = makeFake({ openDelayMs: 30, resilience: { connectTimeout: '5 millis' } });

  await Effect.gen(function* () {
    const scope = yield* Scope.make();
    const api = yield* Scope.provide(fake.make(), scope);

    expect(failureTag(yield* Effect.exit(api.withClient(1)))).toBe('ModbusTimeoutError');
    yield* Scope.close(scope, Exit.void);
    expect(fake.calls.close).toBe(0);

    // Nothing owns the late handle after teardown, so the open closes it.
    yield* Effect.sleep('50 millis');
    expect(fake.calls.close).toBe(1);
  }).pipe(Effect.runPromise);
});

test('a reconnect that exceeds the connect timeout fails, and a later reconnect joins it', async () => {
  const fake = makeFake({ reconnectDelayMs: 60, resilience: { connectTimeout: '40 millis' } });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();
      yield* api.withClient(1);

      const first = yield* Effect.exit(api.reconnect());
      expect(failureTag(first)).toBe('ModbusTimeoutError');

      // The native reconnect still runs. The next attempt waits for it and
      // succeeds within its own limit, because only about 20 ms remain.
      yield* api.reconnect();
      expect(fake.calls.reconnect).toBe(1);

      // After the native reconnect settles, a reconnect starts a new one.
      yield* Effect.exit(api.reconnect());
      expect(fake.calls.reconnect).toBe(2);
    }),
  );
});

test('a supervised reconnect that exceeds the connect timeout publishes Down, then Connected when it completes', async () => {
  const client = makeClient(async () => {
    throw new Error('[MODBUS_CONNECTION_CLOSED] link dropped');
  });
  const fake = makeFake({
    client,
    reconnectDelayMs: 100,
    resilience: {
      connectTimeout: '10 millis',
      reconnect: { policy: RetryPolicies.none(), resetAfter: '1 minute' },
    },
  });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();
      const modbus = yield* api.withClient(1);
      yield* Effect.exit(modbus.writeSingleRegister({ address: 0, value: 1 }));

      yield* Effect.sleep('40 millis');
      const down = SubscriptionRef.getUnsafe(api.connectionState);
      expect(down._tag).toBe('Down');
      if (down._tag === 'Down') expect(down.cause._tag).toBe('ModbusTimeoutError');

      // The native reconnect completes before the next probe. The circuit
      // closes now instead of after `resetAfter`.
      yield* Effect.sleep('100 millis');
      expect(SubscriptionRef.getUnsafe(api.connectionState)._tag).toBe('Connected');
      expect(fake.calls.reconnect).toBe(1);
    }),
  );
});

/**
 * A bus fake that acts like `modbus-rs` 0.16.1: a request timeout closes the
 * native handle for every unit, and only a reconnect opens it again.
 */
const makeSilentUnitBus = (silentUnit: number, delays?: ReadonlyMap<number, number>) => {
  const reads: Array<number> = [];
  const state = { open: true, reads };
  const clientFor = (unitId: number): AsyncSerialModbusClient =>
    makeClient(unusedClientMethod, async () => {
      await sleep(delays?.get(unitId) ?? 0);
      if (!state.open) throw new Error('[MODBUS_CONNECTION_CLOSED] Connection closed');
      reads.push(unitId);
      if (unitId === silentUnit) {
        state.open = false;
        throw new Error('[MODBUS_TIMEOUT] Request timed out');
      }
      return new Uint16Array([unitId]);
    });
  return {
    state,
    clientFor,
    onReconnect: () => {
      state.open = true;
    },
  };
};

const supervisedReconnect: TransportResilienceOptions = {
  reconnect: {
    triggerOn: ['ModbusConnectionClosedError'],
    policy: RetryPolicies.none(),
    resetAfter: '1 minute',
  },
};

const oneRegister = { address: 0, quantity: 1 };

test('a request time limit in the open options is applied with setRequestTimeout', async () => {
  const fake = makeFake({ openOptions: { responseTimeoutMs: 250 } });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();
      yield* api.withClient(1);
      expect(fake.calls.requestTimeouts).toEqual([250]);
    }),
  );
});

test('no request time limit is applied when the open options have none', async () => {
  const fake = makeFake();
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();
      yield* api.withClient(1);
      expect(fake.calls.requestTimeouts).toEqual([]);
    }),
  );
});

test('a timeout of one unit does not fail the next request to another unit', async () => {
  const bus = makeSilentUnitBus(2);
  const fake = makeFake({ clientFor: bus.clientFor, onReconnect: bus.onReconnect });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();
      const healthy = yield* api.withClient(1);
      const silent = yield* api.withClient(2);

      expect(failureTag(yield* Effect.exit(silent.readHoldingRegisters(oneRegister)))).toBe(
        'ModbusTimeoutError',
      );
      expect([...(yield* healthy.readHoldingRegisters(oneRegister))]).toEqual([1]);
      expect(fake.calls.reconnect).toBe(1);

      // The handle is open again, so the next read needs no reconnect.
      expect([...(yield* healthy.readHoldingRegisters(oneRegister))]).toEqual([1]);
      expect(fake.calls.reconnect).toBe(1);
      expect(bus.state.reads).toEqual([2, 1, 1]);
    }),
  );
});

test('a supervised transport restores the handle after each timeout and keeps the circuit closed', async () => {
  const bus = makeSilentUnitBus(2);
  const fake = makeFake({
    clientFor: bus.clientFor,
    onReconnect: bus.onReconnect,
    resilience: supervisedReconnect,
  });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();
      const healthy = yield* api.withClient(1);
      const silent = yield* api.withClient(2);

      for (let cycle = 0; cycle < 3; cycle += 1) {
        expect(failureTag(yield* Effect.exit(silent.readHoldingRegisters(oneRegister)))).toBe(
          'ModbusTimeoutError',
        );
        expect([...(yield* healthy.readHoldingRegisters(oneRegister))]).toEqual([1]);
      }
      expect(SubscriptionRef.getUnsafe(api.connectionState)._tag).toBe('Connected');
      expect(fake.calls.reconnect).toBe(3);
    }),
  );
});

test('a request that meets the handle closed by a timeout does not open the circuit', async () => {
  // The healthy read passes the guard first and reaches the handle after the timeout.
  const bus = makeSilentUnitBus(2, new Map([[1, 30]]));
  const fake = makeFake({
    clientFor: bus.clientFor,
    onReconnect: bus.onReconnect,
    resilience: supervisedReconnect,
  });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();
      const healthy = yield* api.withClient(1);
      const silent = yield* api.withClient(2);

      const [queued, timedOut] = yield* Effect.all(
        [
          Effect.exit(healthy.readHoldingRegisters(oneRegister)),
          Effect.exit(silent.readHoldingRegisters(oneRegister)),
        ],
        { concurrency: 'unbounded' },
      );
      expect(failureTag(timedOut)).toBe('ModbusTimeoutError');
      expect(failureTag(queued)).toBe('ModbusConnectionClosedError');
      expect(SubscriptionRef.getUnsafe(api.connectionState)._tag).toBe('Connected');

      expect([...(yield* healthy.readHoldingRegisters(oneRegister))]).toEqual([1]);
      expect(fake.calls.reconnect).toBe(1);
    }),
  );
});

/** A client that records how many native reads are in flight at the same time. */
const makeOverlapProbe = (readMs: number) => {
  const state = { inFlight: 0, maxInFlight: 0, completed: 0 };
  const client = makeClient(unusedClientMethod, async () => {
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await sleep(readMs);
    state.inFlight -= 1;
    state.completed += 1;
    return new Uint16Array([0]);
  });
  return { state, client };
};

test('with a request time limit, native requests reach the native queue one at a time', async () => {
  const probe = makeOverlapProbe(10);
  const fake = makeFake({ client: probe.client, openOptions: { responseTimeoutMs: 250 } });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();
      const clients = yield* Effect.all([1, 2, 3].map((unitId) => api.withClient(unitId)));
      yield* Effect.all(
        clients.map((client) => client.readHoldingRegisters(oneRegister)),
        { concurrency: 'unbounded' },
      );
      expect(probe.state.maxInFlight).toBe(1);
      expect(probe.state.completed).toBe(3);
    }),
  );
});

test('without a request time limit, native requests are not held back', async () => {
  const probe = makeOverlapProbe(10);
  const fake = makeFake({ client: probe.client });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();
      const clients = yield* Effect.all([1, 2, 3].map((unitId) => api.withClient(unitId)));
      yield* Effect.all(
        clients.map((client) => client.readHoldingRegisters(oneRegister)),
        { concurrency: 'unbounded' },
      );
      expect(probe.state.maxInFlight).toBe(3);
    }),
  );
});

test('an interrupted caller keeps the next request out of the native queue until its request ends', async () => {
  const probe = makeOverlapProbe(40);
  const fake = makeFake({ client: probe.client, openOptions: { responseTimeoutMs: 250 } });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();
      const client = yield* api.withClient(1);
      const first = yield* Effect.forkChild(client.readHoldingRegisters(oneRegister));
      yield* Effect.sleep('10 millis');
      // Interruption waits for the native request, because it cannot be cancelled.
      yield* Fiber.interrupt(first);
      expect(probe.state.completed).toBe(1);
      yield* client.readHoldingRegisters(oneRegister);
      expect(probe.state.maxInFlight).toBe(1);
    }),
  );
});

test('a reconnect waits until the native request in flight ends', async () => {
  const events: Array<string> = [];
  const client = makeClient(unusedClientMethod, async () => {
    events.push('read start');
    await sleep(30);
    events.push('read end');
    return new Uint16Array([0]);
  });
  const fake = makeFake({
    client,
    openOptions: { responseTimeoutMs: 250 },
    onReconnect: () => events.push('reconnect'),
  });
  await run(
    Effect.gen(function* () {
      const api = yield* fake.make();
      const modbus = yield* api.withClient(1);
      const read = yield* Effect.forkChild(modbus.readHoldingRegisters(oneRegister));
      yield* Effect.sleep('5 millis');
      yield* api.reconnect();
      yield* Fiber.join(read);
      expect(events).toEqual(['read start', 'read end', 'reconnect']);
    }),
  );
});
