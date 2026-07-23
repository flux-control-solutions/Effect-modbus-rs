import { Effect } from "effect";
import { test, expect } from "bun:test";
import { CoilState } from "modbus-rs";
import type { WasmSerialPortHandle } from "modbus-rs/web";
import { WasmWsTransportService } from "./WasmWsTransportService";
import { WasmRtuTransportService } from "./WasmRtuTransportService";
import { WasmSerialTransportService } from "./WasmSerialTransportService";
import { ModbusInvalidArgumentError } from "./errors";

/**
 * `makeMockTransport` is fully transport-agnostic (see mocks.test.ts for the exhaustive
 * native-side coverage) — these tests just confirm the new WASM `Effect.Service`/`Context.Tag`
 * wiring (and `makeTransportScoped`'s new `config` threading) works end to end, without
 * needing a real (currently broken upstream) `modbus-rs-wasm` build.
 */

const device = {
  unitId: 1,
  coils: [
    { address: 0, default: true },
    { address: 1, default: false },
  ],
  discreteInputs: [],
  holdingRegisters: [{ address: 0, default: 100 }],
  inputRegisters: [],
};

// A `WasmSerialPortHandle` is never actually touched by the mock transport — it ignores
// its options entirely — so a fake stand-in is fine here.
const fakePort = { isValid: () => true } as unknown as WasmSerialPortHandle;

test("WasmWsTransportService mock: read/write coils and registers", async () => {
  const result = await Effect.gen(function* () {
    const t = yield* WasmWsTransportService;
    const c = yield* t.withClient(1);
    yield* c.writeSingleCoil({ address: 1, value: CoilState.On });
    const coils = yield* c.readCoils({ address: 0, quantity: 2 });
    const regs = yield* c.readHoldingRegisters({ address: 0, quantity: 1 });
    return { coils, regs };
  }).pipe(
    Effect.provide(WasmWsTransportService.makeMockTransport([device])({ wsUrl: "ws://mock" })),
    Effect.scoped,
    Effect.runPromise,
  );

  expect(result.coils).toEqual([CoilState.On, CoilState.On]);
  expect(result.regs).toEqual(new Uint16Array([100]));
});

test("WasmRtuTransportService mock: unknown unitId returns error", async () => {
  const error = await Effect.gen(function* () {
    const t = yield* WasmRtuTransportService;
    return yield* t.withClient(99).pipe(Effect.flip);
  }).pipe(
    Effect.provide(
      WasmRtuTransportService.makeMockTransport([device])({ port: fakePort, baudRate: 19200 }),
    ),
    Effect.scoped,
    Effect.runPromise,
  );

  expect(error).toBeInstanceOf(ModbusInvalidArgumentError);
});

test("WasmSerialTransportService.fromRtu mock: read holding registers", async () => {
  const result = await Effect.gen(function* () {
    const t = yield* WasmSerialTransportService;
    const c = yield* t.withClient(1);
    return yield* c.readHoldingRegisters({ address: 0, quantity: 1 });
  }).pipe(
    Effect.provide(
      WasmSerialTransportService.makeMockTransport([device])({ port: fakePort, baudRate: 9600 }),
    ),
    Effect.scoped,
    Effect.runPromise,
  );

  expect(result).toEqual(new Uint16Array([100]));
});
