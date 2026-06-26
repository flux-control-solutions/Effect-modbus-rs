import type {
  ReadRegistersOptions,
  WriteSingleRegisterOptions,
  WriteMultipleRegistersOptions,
  ReadWriteMultipleRegistersOptions,
  ReadBitsOptions,
  WriteSingleCoilOptions,
  WriteMultipleCoilsOptions,
  ReadFifoQueueOptions,
  ReadFileRecordOptions,
  WriteFileRecordOptions,
  DiagnosticsOptions,
  ReadDeviceIdentificationOptions,
  FifoQueueResponse,
  DiagnosticsResponse,
  DeviceIdentificationResponse,
  AsyncSerialModbusClient,
  AsyncTcpModbusClient,
} from "modbus-rs";
import { Effect } from "effect";
import { type ModbusError, toModbusError } from "./errors.js";

export interface EffectModbusClient {
  readHoldingRegisters(
    opts: ReadRegistersOptions,
  ): Effect.Effect<number[], ModbusError>;
  readInputRegisters(
    opts: ReadRegistersOptions,
  ): Effect.Effect<number[], ModbusError>;
  writeSingleRegister(
    opts: WriteSingleRegisterOptions,
  ): Effect.Effect<void, ModbusError>;
  writeMultipleRegisters(
    opts: WriteMultipleRegistersOptions,
  ): Effect.Effect<void, ModbusError>;
  readWriteMultipleRegisters(
    opts: ReadWriteMultipleRegistersOptions,
  ): Effect.Effect<number[], ModbusError>;
  readCoils(opts: ReadBitsOptions): Effect.Effect<boolean[], ModbusError>;
  writeSingleCoil(
    opts: WriteSingleCoilOptions,
  ): Effect.Effect<void, ModbusError>;
  writeMultipleCoils(
    opts: WriteMultipleCoilsOptions,
  ): Effect.Effect<void, ModbusError>;
  readDiscreteInputs(
    opts: ReadBitsOptions,
  ): Effect.Effect<boolean[], ModbusError>;
  readFifoQueue(
    opts: ReadFifoQueueOptions,
  ): Effect.Effect<FifoQueueResponse, ModbusError>;
  readFileRecord(
    opts: ReadFileRecordOptions,
  ): Effect.Effect<number[][], ModbusError>;
  writeFileRecord(
    opts: WriteFileRecordOptions,
  ): Effect.Effect<void, ModbusError>;
  readExceptionStatus(): Effect.Effect<number, ModbusError>;
  diagnostics(
    opts: DiagnosticsOptions,
  ): Effect.Effect<DiagnosticsResponse, ModbusError>;
  readDeviceIdentification(
    opts: ReadDeviceIdentificationOptions,
  ): Effect.Effect<DeviceIdentificationResponse, ModbusError>;
}

export const makeEffectModbusClient = (
  client:
    | AsyncSerialModbusClient
    | AsyncSerialModbusClient
    | AsyncTcpModbusClient,
): EffectModbusClient => ({
  readHoldingRegisters: (opts) =>
    Effect.tryPromise({
      try: () => client.readHoldingRegisters(opts),
      catch: (error) => toModbusError(error as Error),
    }),
  readInputRegisters: (opts) =>
    Effect.tryPromise({
      try: () => client.readInputRegisters(opts),
      catch: (error) => toModbusError(error as Error),
    }),
  writeSingleRegister: (opts) =>
    Effect.tryPromise({
      try: () => client.writeSingleRegister(opts),
      catch: (error) => toModbusError(error as Error),
    }),
  writeMultipleRegisters: (opts) =>
    Effect.tryPromise({
      try: () => client.writeMultipleRegisters(opts),
      catch: (error) => toModbusError(error as Error),
    }),
  readWriteMultipleRegisters: (opts) =>
    Effect.tryPromise({
      try: () => client.readWriteMultipleRegisters(opts),
      catch: (error) => toModbusError(error as Error),
    }),
  readCoils: (opts) =>
    Effect.tryPromise({
      try: () => client.readCoils(opts),
      catch: (error) => toModbusError(error as Error),
    }),
  writeSingleCoil: (opts) =>
    Effect.tryPromise({
      try: () => client.writeSingleCoil(opts),
      catch: (error) => toModbusError(error as Error),
    }),
  writeMultipleCoils: (opts) =>
    Effect.tryPromise({
      try: () => client.writeMultipleCoils(opts),
      catch: (error) => toModbusError(error as Error),
    }),
  readDiscreteInputs: (opts) =>
    Effect.tryPromise({
      try: () => client.readDiscreteInputs(opts),
      catch: (error) => toModbusError(error as Error),
    }),
  readFifoQueue: (opts) =>
    Effect.tryPromise({
      try: () => client.readFifoQueue(opts),
      catch: (error) => toModbusError(error as Error),
    }),
  readFileRecord: (opts) =>
    Effect.tryPromise({
      try: () => client.readFileRecord(opts),
      catch: (error) => toModbusError(error as Error),
    }),
  writeFileRecord: (opts) =>
    Effect.tryPromise({
      try: () => client.writeFileRecord(opts),
      catch: (error) => toModbusError(error as Error),
    }),
  readExceptionStatus: () =>
    Effect.tryPromise({
      try: () => client.readExceptionStatus(),
      catch: (error) => toModbusError(error as Error),
    }),
  diagnostics: (opts) =>
    Effect.tryPromise({
      try: () => client.diagnostics(opts),
      catch: (error) => toModbusError(error as Error),
    }),
  readDeviceIdentification: (opts) =>
    Effect.tryPromise({
      try: () => client.readDeviceIdentification(opts),
      catch: (error) => toModbusError(error as Error),
    }),
});
