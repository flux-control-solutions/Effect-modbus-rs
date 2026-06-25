import {
  type AsyncRtuTransport,
  type RtuTransportOptions,
  type AsyncSerialModbusClient,
  type ReadRegistersOptions,
  type WriteSingleRegisterOptions,
  type WriteMultipleRegistersOptions,
  type ReadWriteMultipleRegistersOptions,
  type ReadBitsOptions,
  type WriteSingleCoilOptions,
  type WriteMultipleCoilsOptions,
  type ReadFifoQueueOptions,
  type ReadFileRecordOptions,
  type WriteFileRecordOptions,
  type DiagnosticsOptions,
  type ReadDeviceIdentificationOptions,
  type FifoQueueResponse,
  type DiagnosticsResponse,
  type DeviceIdentificationResponse,
} from "modbus-rs";
import { Effect } from "effect";
import { type ModbusError, toModbusError } from "./errors.js";

interface EffectRtuClient {
  readHoldingRegisters(opts: ReadRegistersOptions): Effect.Effect<number[], ModbusError>;
  readInputRegisters(opts: ReadRegistersOptions): Effect.Effect<number[], ModbusError>;
  writeSingleRegister(opts: WriteSingleRegisterOptions): Effect.Effect<void, ModbusError>;
  writeMultipleRegisters(opts: WriteMultipleRegistersOptions): Effect.Effect<void, ModbusError>;
  readWriteMultipleRegisters(opts: ReadWriteMultipleRegistersOptions): Effect.Effect<number[], ModbusError>;
  readCoils(opts: ReadBitsOptions): Effect.Effect<boolean[], ModbusError>;
  writeSingleCoil(opts: WriteSingleCoilOptions): Effect.Effect<void, ModbusError>;
  writeMultipleCoils(opts: WriteMultipleCoilsOptions): Effect.Effect<void, ModbusError>;
  readDiscreteInputs(opts: ReadBitsOptions): Effect.Effect<boolean[], ModbusError>;
  readFifoQueue(opts: ReadFifoQueueOptions): Effect.Effect<FifoQueueResponse, ModbusError>;
  readFileRecord(opts: ReadFileRecordOptions): Effect.Effect<number[][], ModbusError>;
  writeFileRecord(opts: WriteFileRecordOptions): Effect.Effect<void, ModbusError>;
  readExceptionStatus(): Effect.Effect<number, ModbusError>;
  diagnostics(opts: DiagnosticsOptions): Effect.Effect<DiagnosticsResponse, ModbusError>;
  readDeviceIdentification(opts: ReadDeviceIdentificationOptions): Effect.Effect<DeviceIdentificationResponse, ModbusError>;
}

const makeEffectRtuClient = (client: AsyncSerialModbusClient): EffectRtuClient => ({
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

export class RtuTransportService extends Effect.Service<RtuTransportService>()(
  "RtuTransportService",
  {
    scoped: Effect.fnUntraced(function* (options: RtuTransportOptions) {
      const { AsyncRtuTransport } = yield* Effect.promise(
        () => import("modbus-rs"),
      );

      const transport: AsyncRtuTransport = yield* Effect.tryPromise({
        try: () => AsyncRtuTransport.open(options),
        catch: (error) => toModbusError(error as Error),
      });
      const clientSet = new Map<number, AsyncSerialModbusClient>();

      yield* Effect.addFinalizer(() => Effect.promise(() => transport.close()));

      return {
        withClient: Effect.fnUntraced(function* (unitId: number) {
          let client = clientSet.get(unitId);
          if (!client) {
            client = yield* Effect.try({
              try: () => transport.createClient({ unitId }),
              catch: (error) => toModbusError(error as Error),
            });
            clientSet.set(unitId, client);
          }
          return makeEffectRtuClient(client);
        }),
        setRequestTimeout: transport.setRequestTimeout.bind(transport),
        clearRequestTimeout: transport.clearRequestTimeout.bind(transport),
        reconnect: Effect.tryPromise({
          try: () => transport.reconnect(),
          catch: (error) => toModbusError(error as Error),
        }),
        hasPendingRequests: () => transport.pendingRequests,
      };
    }),
  },
) {}
