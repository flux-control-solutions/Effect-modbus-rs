/**
 * Serial RTU Modbus server example.
 *
 * Starts an in-memory Modbus RTU server on a specified serial port.
 * Demonstrates the same handler pattern as the TCP server but uses
 * serial transport settings.
 *
 * **Note**: This example requires a real serial port or a pair of
 * virtual serial ports (e.g., `socat` on Linux/macOS).
 *
 * @example bun run examples/serial-server.ts
 */

import { Console, Effect, Layer, LogLevel, Logger } from "effect";
import { BunRuntime } from "@effect/platform-bun";
import type { ReadCoilsRequest, ReadHoldingRegistersRequest, WriteMultipleCoilsRequest, WriteMultipleRegistersRequest, WriteSingleCoilRequest, WriteSingleRegisterRequest } from "modbus-rs";
import { CoilState, type ServerHandlers } from "modbus-rs";
import { serialRtuServerLayer } from "../src/SerialModbusServerService";

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

const ServerLive = serialRtuServerLayer(
  { portPath: "/dev/ttyUSB0", baudRate: 9600, unitId: 1 },
  handlers,
);

BunRuntime.runMain(
  Layer.launch(ServerLive).pipe(
    Effect.catchAll((err) => Console.log(`Server error: ${err.message}`)),
    Effect.provide(Logger.pretty),
    Logger.withMinimumLogLevel(LogLevel.Debug),
  ),
);
