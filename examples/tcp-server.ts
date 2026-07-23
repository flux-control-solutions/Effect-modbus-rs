/**
 * TCP Modbus server example.
 *
 * Starts an in-memory Modbus TCP server that stores coils and holding registers
 * in a `Map`. Demonstrates `onReadCoils`, `onWriteSingleCoil`, `onWriteMultipleCoils`,
 * `onReadHoldingRegisters`, `onWriteSingleRegister`, and `onWriteMultipleRegisters`
 * handlers.
 *
 * @example bun run examples/tcp-server.ts
 */

import { Console, Effect, Layer, LogLevel, Logger } from "effect";
import { BunRuntime } from "@effect/platform-bun";
import type { ReadCoilsRequest, ReadHoldingRegistersRequest, WriteMultipleCoilsRequest, WriteMultipleRegistersRequest, WriteSingleCoilRequest, WriteSingleRegisterRequest } from "modbus-rs";
import { CoilState, type ServerHandlers } from "modbus-rs";
import { tcpServerLayer } from "../src/TcpModbusServerService";

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

const ServerLive = tcpServerLayer(
  { host: "0.0.0.0", port: 8502, unitId: 1 },
  handlers,
);

BunRuntime.runMain(
  Layer.launch(ServerLive).pipe(
    Effect.catchAll((err) => Console.log(`Server error: ${err.message}`)),
    Effect.provide(Logger.pretty),
    Logger.withMinimumLogLevel(LogLevel.Debug),
  ),
);
