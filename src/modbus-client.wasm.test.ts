import { Effect } from "effect";
import { test, expect } from "bun:test";
import { CoilState } from "modbus-rs";
import type { WasmWsModbusClient } from "modbus-rs/web";
import { makeWasmEffectModbusClient } from "./modbus-client";

/**
 * Unit-tests `makeWasmEffectModbusClient`'s normalization of the WASM client's raw
 * responses (see the doc comment on that function) against a hand-rolled fake — no real
 * `modbus-rs`/`modbus-rs-wasm` involved, so this doesn't depend on the currently-broken
 * upstream WASM publish.
 */
const fakeClient = {
  readCoils: async () => [true, false],
  readDiscreteInputs: async () => [false, true],
  writeSingleCoil: async () => undefined,
  writeMultipleCoils: async () => undefined,
  readFifoQueue: async () => new Uint16Array([1, 2, 3]),
  readDeviceIdentification: async () => ({
    conformityLevel: 0x82,
    moreFollows: false,
    objects: [{ id: 0, value: "Acme" }],
  }),
} as unknown as WasmWsModbusClient;

const client = makeWasmEffectModbusClient(fakeClient);

test("readCoils maps boolean[] to CoilState[]", async () => {
  const result = await Effect.runPromise(client.readCoils({ address: 0, quantity: 2 }));
  expect(result).toEqual([CoilState.On, CoilState.Off]);
});

test("readDiscreteInputs maps boolean[] to CoilState[]", async () => {
  const result = await Effect.runPromise(client.readDiscreteInputs({ address: 0, quantity: 2 }));
  expect(result).toEqual([CoilState.Off, CoilState.On]);
});

test("writeSingleCoil passes CoilState straight through (no reverse mapping)", async () => {
  await expect(
    Effect.runPromise(client.writeSingleCoil({ address: 0, value: CoilState.On })),
  ).resolves.toBeUndefined();
});

test("readFifoQueue reshapes raw Uint16Array into FifoQueueResponse", async () => {
  const result = await Effect.runPromise(client.readFifoQueue({ address: 0 }));
  expect(result).toEqual({ count: 3, values: new Uint16Array([1, 2, 3]) });
});

test("readDeviceIdentification defaults the missing nextObjectId field", async () => {
  const result = await Effect.runPromise(
    client.readDeviceIdentification({ readDeviceIdCode: 1, objectId: 0 }),
  );
  expect(result).toEqual({
    conformityLevel: 0x82,
    moreFollows: false,
    nextObjectId: 0,
    objects: [{ id: 0, value: "Acme" }],
  });
});
