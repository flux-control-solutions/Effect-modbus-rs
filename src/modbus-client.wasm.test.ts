import { test, expect } from 'bun:test';

import { Effect } from 'effect';
import { CoilState } from 'modbus-rs';
import init, { type WasmWsModbusClient } from 'modbus-rs/web';

import { makeEffectModbusClient } from './modbus-client';

/**
 * `WasmWsModbusClient`/`WasmSerialModbusClient` have private constructors (only
 * `WasmWsTransport.connect`/`createClient` can produce one, which needs a live WebSocket
 * gateway), so a hand-rolled fake standing in for the instance is unavoidable in a unit
 * test. What's no longer necessary is guessing at its resolved shapes: the upstream
 * `modbus-rs-wasm` publish now declares (and, per the `init()` call below, actually loads)
 * a WASM client whose method surface is identical to the native client's — `CoilState[]`,
 * full `FifoQueueResponse`, full `DeviceIdentificationResponse` — so `makeEffectModbusClient`
 * handles both transports as a pure pass-through, and this fake mirrors real shapes rather
 * than working around assumed-broken ones. If upstream regresses (or this stops matching
 * it), the `init()` assertion or the shapes below will be the first thing to fail.
 */
await init();

const fakeClient = {
  readCoils: async () => [CoilState.On, CoilState.Off],
  readDiscreteInputs: async () => [CoilState.Off, CoilState.On],
  writeSingleCoil: async () => undefined,
  writeMultipleCoils: async () => undefined,
  readFifoQueue: async () => ({ count: 3, values: new Uint16Array([1, 2, 3]) }),
  readDeviceIdentification: async () => ({
    conformityLevel: 0x82,
    moreFollows: false,
    nextObjectId: 0,
    objects: [{ id: 0, value: 'Acme' }],
  }),
} as unknown as WasmWsModbusClient;

const client = makeEffectModbusClient(fakeClient);

test('readCoils passes CoilState[] straight through', async () => {
  const result = await Effect.runPromise(client.readCoils({ address: 0, quantity: 2 }));
  expect(result).toEqual([CoilState.On, CoilState.Off]);
});

test('readDiscreteInputs passes CoilState[] straight through', async () => {
  const result = await Effect.runPromise(client.readDiscreteInputs({ address: 0, quantity: 2 }));
  expect(result).toEqual([CoilState.Off, CoilState.On]);
});

test('writeSingleCoil passes CoilState straight through', async () => {
  await expect(
    Effect.runPromise(client.writeSingleCoil({ address: 0, value: CoilState.On })),
  ).resolves.toBeUndefined();
});

test('readFifoQueue passes FifoQueueResponse straight through', async () => {
  const result = await Effect.runPromise(client.readFifoQueue({ address: 0 }));
  expect(result).toEqual({ count: 3, values: new Uint16Array([1, 2, 3]) });
});

test('readDeviceIdentification passes DeviceIdentificationResponse straight through', async () => {
  const result = await Effect.runPromise(
    client.readDeviceIdentification({ readDeviceIdCode: 1, objectId: 0 }),
  );
  expect(result).toEqual({
    conformityLevel: 0x82,
    moreFollows: false,
    nextObjectId: 0,
    objects: [{ id: 0, value: 'Acme' }],
  });
});
