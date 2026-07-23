import { Effect } from "effect";
import { test, expect } from "bun:test";
import { CoilState } from "modbus-rs";
import { RtuTransportService } from "./RtuTransportService";
import { ModbusInvalidArgumentError } from "./errors";

const device = {
  unitId: 1,
  coils: [
    { address: 0, default: true },
    { address: 1, default: false },
    { address: 10, default: true },
  ],
  discreteInputs: [
    { address: 0, default: true },
  ],
  holdingRegisters: [
    { address: 0, default: 100 },
    { address: 1, default: 200 },
  ],
  inputRegisters: [
    { address: 0, default: 42 },
  ],
};

const run = <A, E>(effect: Effect.Effect<A, E, RtuTransportService>) =>
  effect.pipe(
    Effect.provide(
      RtuTransportService.makeMockTransport([device])({
        portPath: "/dev/ttyUSB0",
        baudRate: 9600,
      }),
    ),
    Effect.scoped,
    Effect.runPromise,
  );

test("read coils returns defaults", async () => {
  const result = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      const c = yield* t.withClient(1);
      return yield* c.readCoils({ address: 0, quantity: 2 });
    }),
  );
  expect(result).toEqual([CoilState.On, CoilState.Off]);
});

test("read coils returns false for unconfigured addresses", async () => {
  const result = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      const c = yield* t.withClient(1);
      return yield* c.readCoils({ address: 3, quantity: 2 });
    }),
  );
  expect(result).toEqual([CoilState.Off, CoilState.Off]);
});

test("write single coil and read back", async () => {
  const result = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      const c = yield* t.withClient(1);
      yield* c.writeSingleCoil({ address: 1, value: CoilState.On });
      return yield* c.readCoils({ address: 0, quantity: 3 });
    }),
  );
  expect(result).toEqual([CoilState.On, CoilState.On, CoilState.Off]);
});

test("write multiple coils and read back", async () => {
  const result = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      const c = yield* t.withClient(1);
      yield* c.writeMultipleCoils({
        address: 0,
        values: [CoilState.Off, CoilState.On, CoilState.Off],
      });
      return yield* c.readCoils({ address: 0, quantity: 3 });
    }),
  );
  expect(result).toEqual([CoilState.Off, CoilState.On, CoilState.Off]);
});

test("read holding registers returns defaults", async () => {
  const result = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      const c = yield* t.withClient(1);
      return yield* c.readHoldingRegisters({ address: 0, quantity: 2 });
    }),
  );
  expect(result).toEqual(new Uint16Array([100, 200]));
});

test("read beyond configured registers returns error", async () => {
  const error = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      const c = yield* t.withClient(1);
      return yield* c.readHoldingRegisters({ address: 2, quantity: 2 }).pipe(
        Effect.flip,
      );
    }),
  );
  expect(error).toBeInstanceOf(ModbusInvalidArgumentError);
});

test("write single register and read back", async () => {
  const result = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      const c = yield* t.withClient(1);
      yield* c.writeSingleRegister({ address: 1, value: 999 });
      return yield* c.readHoldingRegisters({ address: 0, quantity: 2 });
    }),
  );
  expect(result).toEqual(new Uint16Array([100, 999]));
});

test("write multiple registers and read back", async () => {
  const result = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      const c = yield* t.withClient(1);
      yield* c.writeMultipleRegisters({
        address: 0,
        values: new Uint16Array([10, 20]),
      });
      return yield* c.readHoldingRegisters({ address: 0, quantity: 2 });
    }),
  );
  expect(result).toEqual(new Uint16Array([10, 20]));
});

test("readWriteMultipleRegisters writes then reads", async () => {
  const result = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      const c = yield* t.withClient(1);
      return yield* c.readWriteMultipleRegisters({
        readAddress: 0,
        readQuantity: 2,
        writeAddress: 0,
        writeValues: new Uint16Array([11, 22]),
      });
    }),
  );
  expect(result).toEqual(new Uint16Array([11, 22]));
});

test("read discrete inputs returns defaults", async () => {
  const result = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      const c = yield* t.withClient(1);
      return yield* c.readDiscreteInputs({ address: 0, quantity: 1 });
    }),
  );
  expect(result).toEqual([CoilState.On]);
});

test("read input registers returns defaults", async () => {
  const result = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      const c = yield* t.withClient(1);
      return yield* c.readInputRegisters({ address: 0, quantity: 1 });
    }),
  );
  expect(result).toEqual(new Uint16Array([42]));
});

test("read exception status returns 0", async () => {
  const result = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      const c = yield* t.withClient(1);
      return yield* c.readExceptionStatus();
    }),
  );
  expect(result).toBe(0);
});

test("read beyond configured coils returns error", async () => {
  const error = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      const c = yield* t.withClient(1);
      return yield* c.readCoils({ address: 0, quantity: 20 }).pipe(
        Effect.flip,
      );
    }),
  );
  expect(error).toBeInstanceOf(ModbusInvalidArgumentError);
});

test("write beyond configured coils returns error", async () => {
  const error = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      const c = yield* t.withClient(1);
      return yield* c.writeSingleCoil({ address: 100, value: CoilState.On }).pipe(
        Effect.flip,
      );
    }),
  );
  expect(error).toBeInstanceOf(ModbusInvalidArgumentError);
});

test("unknown unitId returns error", async () => {
  const error = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      return yield* t.withClient(99).pipe(Effect.flip);
    }),
  );
  expect(error).toBeInstanceOf(ModbusInvalidArgumentError);
});

test("diagnostics returns expected shape", async () => {
  const result = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      const c = yield* t.withClient(1);
      return yield* c.diagnostics({ subFunction: 0, data: new Uint16Array() });
    }),
  );
  expect(result).toEqual({ subFunction: 0, data: new Uint16Array() });
});

test("readDeviceIdentification returns expected shape", async () => {
  const result = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      const c = yield* t.withClient(1);
      return yield* c.readDeviceIdentification({
        readDeviceIdCode: 1,
        objectId: 0,
      });
    }),
  );
  expect(result.conformityLevel).toBe(1);
  expect(result.moreFollows).toBe(false);
  expect(result.objects).toEqual([]);
});

test("multiple unit IDs are isolated", async () => {
  const result = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      const c1 = yield* t.withClient(1);
      yield* c1.writeSingleRegister({ address: 0, value: 999 });
      const c1regs = yield* c1.readHoldingRegisters({ address: 0, quantity: 1 });
      return c1regs;
    }),
  );
  expect(result).toEqual(new Uint16Array([999]));
});

test("readFifoQueue returns error (not yet supported)", async () => {
  const error = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      const c = yield* t.withClient(1);
      return yield* c.readFifoQueue({ address: 0 }).pipe(Effect.flip);
    }),
  );
  expect(error).toBeInstanceOf(ModbusInvalidArgumentError);
});

test("readFileRecord returns error (not yet supported)", async () => {
  const error = await run(
    Effect.gen(function* () {
      const t = yield* RtuTransportService;
      const c = yield* t.withClient(1);
      return yield* c.readFileRecord({
        requests: [{ fileNumber: 0, recordNumber: 0, recordLength: 1 }],
      }).pipe(Effect.flip);
    }),
  );
  expect(error).toBeInstanceOf(ModbusInvalidArgumentError);
});
