/**
 * TCP server + client integration example.
 *
 * Forks a TCP Modbus server into a background fiber, then creates a
 * `TcpTransportService` client that connects to the same port and
 * performs read/write operations against the server's in-memory state.
 *
 * Demonstrates:
 * - `Effect.fork` + `Layer.launch` to run a server in the background
 * - Client operations (read/write coils and holding registers)
 * - Graceful server shutdown via `Fiber.interrupt`
 *
 * @example bun run examples/tcp-server-client.ts
 */

import {
  Console,
  Effect,
  Fiber,
  Layer,
  LogLevel,
  Logger,
  Schedule,
} from "effect";
import { BunRuntime } from "@effect/platform-bun";
import type {
  ReadCoilsRequest,
  ReadHoldingRegistersRequest,
  WriteMultipleCoilsRequest,
  WriteMultipleRegistersRequest,
  WriteSingleCoilRequest,
  WriteSingleRegisterRequest,
} from "modbus-rs";
import { CoilState, type ServerHandlers } from "modbus-rs";
import { TcpTransportService } from "../src/TcpTransportService";
import { tcpServerLayer } from "../src/TcpModbusServerService";

const PORT = 8503;

const coils = new Map<number, boolean>();
const holdingRegisters = new Map<number, number>();

const handlers: ServerHandlers = {
  onReadCoils: (req: ReadCoilsRequest): CoilState[] => {
    const result: CoilState[] = [];
    for (let i = 0; i < req.quantity; i++) {
      result.push(coils.get(req.address + i) ?? false ? CoilState.On : CoilState.Off);
    }
    return result;
  },

  onWriteSingleCoil: (req: WriteSingleCoilRequest): void => {
    coils.set(req.address, req.value === CoilState.On);
  },

  onWriteMultipleCoils: (req: WriteMultipleCoilsRequest): void => {
    for (let i = 0; i < req.values.length; i++) {
      coils.set(req.address + i, req.values[i]! === CoilState.On);
    }
  },

  onReadHoldingRegisters: (req: ReadHoldingRegistersRequest): Uint16Array => {
    const result: number[] = [];
    for (let i = 0; i < req.quantity; i++) {
      result.push(holdingRegisters.get(req.address + i) ?? 0);
    }
    return new Uint16Array(result);
  },

  onWriteSingleRegister: (req: WriteSingleRegisterRequest): void => {
    holdingRegisters.set(req.address, req.value);
  },

  onWriteMultipleRegisters: (req: WriteMultipleRegistersRequest): void => {
    for (let i = 0; i < req.values.length; i++) {
      holdingRegisters.set(req.address + i, req.values[i]!);
    }
  },
};

const program = Effect.gen(function* () {
  const serverFiber = yield* Effect.acquireRelease(
    Effect.fork(
      Layer.launch(
        tcpServerLayer({ host: "0.0.0.0", port: PORT, unitId: 1 }, handlers),
      ),
    ),
    (fiber) => Fiber.interrupt(fiber).pipe(Effect.catchAll(() => Effect.void)),
  );

  yield* Console.log(
    "--- Client connecting (with retries until server is ready) ---",
  );

  const transport = yield* TcpTransportService;
  const client = yield* transport
    .withClient(1)
    .pipe(
      Effect.retry(Schedule.addDelay(Schedule.recurs(10), () => "50 millis")),
    );

  yield* Console.log("--- Client connected, reading initial state ---");

  const initialCoils = yield* client.readCoils({ address: 0, quantity: 4 });
  yield* Console.log("Coils (initial):", initialCoils);

  const initialRegs = yield* client.readHoldingRegisters({
    address: 0,
    quantity: 3,
  });
  yield* Console.log("Holding registers (initial):", initialRegs);

  yield* Console.log("--- Writing coils and registers ---");

  yield* client.writeMultipleCoils({
    address: 0,
    values: [CoilState.On, CoilState.Off, CoilState.On, CoilState.Off],
  });
  yield* client.writeSingleCoil({ address: 4, value: CoilState.On });
  yield* client.writeMultipleRegisters({
    address: 0,
    values: new Uint16Array([100, 200, 300]),
  });

  const coilsAfter = yield* client.readCoils({ address: 0, quantity: 5 });
  yield* Console.log("Coils (after write):", coilsAfter);

  const regsAfter = yield* client.readHoldingRegisters({
    address: 0,
    quantity: 3,
  });
  yield* Console.log("Holding registers (after write):", regsAfter);

  yield* Console.log("--- Done ---");
});

BunRuntime.runMain(
  program.pipe(
    Effect.provide(
      TcpTransportService.Default({
        host: "127.0.0.1",
        port: PORT,
      }),
    ),
    Effect.catchTags({
      ModbusTimeoutError: (err) => Console.log(`Timeout: ${err.message}`),
      ModbusTransportError: (err) =>
        Console.log(`Transport error: ${err.message}`),
      ModbusConnectionClosedError: (err) =>
        Console.log(`Connection lost: ${err.message}`),
    }),
    Effect.catchAll((err) => Console.log(`Unhandled error: ${err.message}`)),
    Logger.withMinimumLogLevel(LogLevel.Debug),
    Effect.scoped,
  ),
);
