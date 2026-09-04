import { test, expect } from 'bun:test';

import { Effect } from 'effect';
import type { WasmSerialPortHandle } from 'modbus-rs/web';

import { AsciiTransportService } from './AsciiTransportService';
import { ModbusTimeoutError } from './errors';
import { createRetryPolicy } from './retry';
import { RtuTransportService } from './RtuTransportService';
import { SerialTransportService } from './SerialTransportService';
import { TcpTransportService } from './TcpTransportService';
import { WasmAsciiTransportService } from './WasmAsciiTransportService';
import { WasmRtuTransportService } from './WasmRtuTransportService';
import { WasmSerialTransportService } from './WasmSerialTransportService';
import { WasmWsTransportService } from './WasmWsTransportService';

// ---------------------------------------------------------------------------
// Each transport tag declares the options of its own `makeMockTransport`. The
// eight declarations are independent, and all eight bodies call the same
// factory. Thus one tag can declare fewer options than the factory accepts,
// and only the type declaration shows the difference. The runtime tests cannot
// find this fault, because the options operate correctly (issue #14).
//
// These assertions are that test. `bun run typecheck` (`tsc --noEmit`) enforces
// them. Each assertion is a generic constraint, because a type alias that
// evaluates to `never` is legal and does not stop the build.
// ---------------------------------------------------------------------------

/** The options parameter of the function that a `makeMockTransport` static gives. */
type MockOptionsOf<TStatic> = TStatic extends (
  devices: never,
) => (options: infer TOptions) => object
  ? TOptions
  : never;

/** Fails to compile unless every member of `K` is a key of `T`. */
type AssertKeysOf<T, K extends keyof T> = K;

/** The resilience options and the fault hooks that the mock factory honors. */
type MockResilienceKeys = 'retry' | 'reconnect' | 'fault' | 'reconnectFault';

// The six concrete native and browser tags.
type _Rtu = AssertKeysOf<
  MockOptionsOf<typeof RtuTransportService.makeMockTransport>,
  MockResilienceKeys
>;
type _Ascii = AssertKeysOf<
  MockOptionsOf<typeof AsciiTransportService.makeMockTransport>,
  MockResilienceKeys
>;
type _Tcp = AssertKeysOf<
  MockOptionsOf<typeof TcpTransportService.makeMockTransport>,
  MockResilienceKeys
>;
type _WasmRtu = AssertKeysOf<
  MockOptionsOf<typeof WasmRtuTransportService.makeMockTransport>,
  MockResilienceKeys
>;
type _WasmAscii = AssertKeysOf<
  MockOptionsOf<typeof WasmAsciiTransportService.makeMockTransport>,
  MockResilienceKeys
>;
type _WasmWs = AssertKeysOf<
  MockOptionsOf<typeof WasmWsTransportService.makeMockTransport>,
  MockResilienceKeys
>;

// The two abstract serial tags. These two were the fault in issue #14: a test
// that keeps the framing abstract had no way to name a hook or a policy.
type _Serial = AssertKeysOf<
  MockOptionsOf<typeof SerialTransportService.makeMockTransport>,
  MockResilienceKeys
>;
type _WasmSerial = AssertKeysOf<
  MockOptionsOf<typeof WasmSerialTransportService.makeMockTransport>,
  MockResilienceKeys
>;

test('every makeMockTransport accepts the resilience options and the fault hooks', () => {
  // Nothing to run — the assertions above typechecked.
  expect(true).toBe(true);
});

// ---------------------------------------------------------------------------
// The two abstract tags, through the surface that issue #14 unblocked: a
// `fault` hook that drives a `retry` policy. `resilience.test.ts` holds the
// full policy coverage through `TcpTransportService`. These two tests show
// only that the abstract tags reach the same behavior.
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

const fast = createRetryPolicy({ maxRetries: 3, baseDelay: '1 millis', maxDelay: '4 millis' });

const fakePortFixture = { isValid: () => true } satisfies Pick<WasmSerialPortHandle, 'isValid'>;
// SAFETY: The mock transport never reads the port; it only carries this typed fixture through options.
const fakePort = fakePortFixture as WasmSerialPortHandle;

/** Gives a `fault` hook that fails the first `failures` attempts, and its counter. */
const failFirst = (failures: number) => {
  const calls = { attempts: 0 };
  let remaining = failures;
  const fault = () => {
    calls.attempts += 1;
    if (remaining <= 0) return undefined;
    remaining -= 1;
    return new ModbusTimeoutError({ cause: new Error('timeout'), message: 'no response' });
  };
  return { calls, fault };
};

test('SerialTransportService mock: a fault hook drives the retry policy', async () => {
  const { calls, fault } = failFirst(2);
  const result = await Effect.gen(function* () {
    const transport = yield* SerialTransportService;
    const client = yield* transport.withClient(1);
    return yield* client.readHoldingRegisters({ address: 0, quantity: 1 });
  }).pipe(
    Effect.provide(
      SerialTransportService.makeMockTransport(devices)({
        portPath: 'mock',
        baudRate: 9600,
        retry: fast,
        fault,
      }),
    ),
    Effect.scoped,
    Effect.runPromise,
  );

  expect(Array.from(result)).toEqual([42]);
  expect(calls.attempts).toBe(3);
});

test('WasmSerialTransportService mock: a fault hook drives the retry policy', async () => {
  const { calls, fault } = failFirst(2);
  const result = await Effect.gen(function* () {
    const transport = yield* WasmSerialTransportService;
    const client = yield* transport.withClient(1);
    return yield* client.readHoldingRegisters({ address: 0, quantity: 1 });
  }).pipe(
    Effect.provide(
      WasmSerialTransportService.makeMockTransport(devices)({
        port: fakePort,
        baudRate: 9600,
        retry: fast,
        fault,
      }),
    ),
    Effect.scoped,
    Effect.runPromise,
  );

  expect(Array.from(result)).toEqual([42]);
  expect(calls.attempts).toBe(3);
});
