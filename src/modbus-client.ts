import { Effect } from 'effect';
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
  CoilState,
} from 'modbus-rs';
import type { WasmWsModbusClient, WasmSerialModbusClient } from 'modbus-rs/web';

import type { ModbusError } from './errors';
import { toModbusError } from './errors';

/** The two native (napi) clients — same method surface, sharing one factory. */
export type NativeModbusClient = AsyncSerialModbusClient | AsyncTcpModbusClient;
/** The two browser (WASM) clients — same method surface, sharing one factory. */
export type WasmModbusClient = WasmSerialModbusClient | WasmWsModbusClient;
/** Any client this package knows how to wrap into an {@link EffectModbusClient}. */
export type AnyModbusClient = NativeModbusClient | WasmModbusClient;

/** Wraps a Promise-returning call in `Effect.tryPromise`, routing errors through {@link toModbusError}. */
const wrap = <T>(try_: () => Promise<T>): Effect.Effect<T, ModbusError> =>
  Effect.tryPromise({
    try: try_,
    catch: (error) => toModbusError(error as Error),
  });

/**
 * Effect-ified Modbus client wrapping a `modbus-rs` transport client.
 *
 * Each method delegates to the equivalent method on the underlying native
 * or WASM client, converting the Promise-based API into an
 * {@link Effect.Effect} with typed {@link ModbusError} failures.
 *
 * Thrown errors are classified using {@link toModbusError}, mapping
 * `modbus-rs` error codes (timeout, transport, exception, etc.) into
 * the corresponding `Data.TaggedError` variant for use with
 * `Effect.catchTags`.
 *
 * @see AsyncSerialModbusClient — Upstream `modbus-rs` serial client API.
 * @see AsyncTcpModbusClient — Upstream `modbus-rs` TCP client API.
 */
export interface EffectModbusClient {
  /**
   * Reads holding registers from the Modbus device (FC03).
   *
   * @param opts - Register address, quantity, and optional `AbortSignal`.
   * @returns An Effect resolving to an array of 16-bit register values.
   *
   * @see ReadRegistersOptions — Options shape from `modbus-rs`.
   * @see AsyncSerialModbusClient.readHoldingRegisters — Upstream implementation.
   */
  readHoldingRegisters(opts: ReadRegistersOptions): Effect.Effect<Uint16Array, ModbusError>;

  /**
   * Reads input registers from the Modbus device (FC04).
   *
   * @param opts - Register address, quantity, and optional `AbortSignal`.
   * @returns An Effect resolving to an array of 16-bit input register values.
   *
   * @see ReadRegistersOptions — Options shape from `modbus-rs`.
   * @see AsyncSerialModbusClient.readInputRegisters — Upstream implementation.
   */
  readInputRegisters(opts: ReadRegistersOptions): Effect.Effect<Uint16Array, ModbusError>;

  /**
   * Writes a single holding register (FC06).
   *
   * @param opts - Register address, value, and optional `AbortSignal`.
   * @returns An Effect that completes when the write is acknowledged.
   *
   * @see WriteSingleRegisterOptions — Options shape from `modbus-rs`.
   */
  writeSingleRegister(opts: WriteSingleRegisterOptions): Effect.Effect<void, ModbusError>;

  /**
   * Writes multiple consecutive holding registers (FC16).
   *
   * @param opts - Starting address, array of values, and optional `AbortSignal`.
   * @returns An Effect that completes when the write is acknowledged.
   *
   * @see WriteMultipleRegistersOptions — Options shape from `modbus-rs`.
   */
  writeMultipleRegisters(opts: WriteMultipleRegistersOptions): Effect.Effect<void, ModbusError>;

  /**
   * Atomic read-write of multiple registers (FC23).
   *
   * Performs a write operation and a read operation atomically within
   * a single Modbus transaction.
   *
   * @param opts - Separate read and write addresses/quantities/values.
   * @returns An Effect resolving to the read register values.
   *
   * @see ReadWriteMultipleRegistersOptions — Options shape from `modbus-rs`.
   */
  readWriteMultipleRegisters(
    opts: ReadWriteMultipleRegistersOptions,
  ): Effect.Effect<Uint16Array, ModbusError>;

  /**
   * Reads coils (digital outputs) from the Modbus device (FC01).
   *
   * @param opts - Starting address, quantity, and optional `AbortSignal`.
   * @returns An Effect resolving to an array of boolean coil states.
   *
   * @see ReadBitsOptions — Options shape from `modbus-rs`.
   */
  readCoils(opts: ReadBitsOptions): Effect.Effect<CoilState[], ModbusError>;

  /**
   * Writes a single coil (digital output) (FC05).
   *
   * @param opts - Coil address, boolean value, and optional `AbortSignal`.
   * @returns An Effect that completes when the write is acknowledged.
   *
   * @see WriteSingleCoilOptions — Options shape from `modbus-rs`.
   */
  writeSingleCoil(opts: WriteSingleCoilOptions): Effect.Effect<void, ModbusError>;

  /**
   * Writes multiple consecutive coils (FC15).
   *
   * @param opts - Starting address, array of boolean values, and optional `AbortSignal`.
   * @returns An Effect that completes when the write is acknowledged.
   *
   * @see WriteMultipleCoilsOptions — Options shape from `modbus-rs`.
   */
  writeMultipleCoils(opts: WriteMultipleCoilsOptions): Effect.Effect<void, ModbusError>;

  /**
   * Reads discrete inputs (digital inputs) from the Modbus device (FC02).
   *
   * @param opts - Starting address, quantity, and optional `AbortSignal`.
   * @returns An Effect resolving to an array of boolean input states.
   *
   * @see ReadBitsOptions — Options shape from `modbus-rs`.
   */
  readDiscreteInputs(opts: ReadBitsOptions): Effect.Effect<CoilState[], ModbusError>;

  /**
   * Reads the FIFO queue from the Modbus device (FC24).
   *
   * @param opts - FIFO pointer address and optional `AbortSignal`.
   * @returns An Effect resolving to a `FifoQueueResponse` containing the queue values.
   *
   * @see ReadFifoQueueOptions — Options shape from `modbus-rs`.
   * @see FifoQueueResponse — Response type from `modbus-rs`.
   */
  readFifoQueue(opts: ReadFifoQueueOptions): Effect.Effect<FifoQueueResponse, ModbusError>;

  /**
   * Reads file records from the Modbus device (FC20).
   *
   * @param opts - Array of file/sub-record read requests and optional `AbortSignal`.
   * @returns An Effect resolving to an array of record data arrays.
   *
   * @see ReadFileRecordOptions — Options shape from `modbus-rs`.
   */
  readFileRecord(opts: ReadFileRecordOptions): Effect.Effect<Uint16Array[], ModbusError>;

  /**
   * Writes file records to the Modbus device (FC21).
   *
   * @param opts - Array of file/sub-record write requests and optional `AbortSignal`.
   * @returns An Effect that completes when the write is acknowledged.
   *
   * @see WriteFileRecordOptions — Options shape from `modbus-rs`.
   */
  writeFileRecord(opts: WriteFileRecordOptions): Effect.Effect<void, ModbusError>;

  /**
   * Reads the Modbus exception status (FC07).
   *
   * Returns the contents of eight exception-status coils as a single byte.
   *
   * @returns An Effect resolving to the exception status byte value.
   */
  readExceptionStatus(): Effect.Effect<number, ModbusError>;

  /**
   * Sends a diagnostics request to the Modbus device (FC08).
   *
   * @param opts - Diagnostic sub-function code and data words.
   * @returns An Effect resolving to a `DiagnosticsResponse` containing the echo sub-function and data.
   *
   * @see DiagnosticsOptions — Options shape from `modbus-rs`.
   * @see DiagnosticsResponse — Response type from `modbus-rs`.
   */
  diagnostics(opts: DiagnosticsOptions): Effect.Effect<DiagnosticsResponse, ModbusError>;

  /**
   * Reads device identification from the Modbus device (FC43 / MEI type 14).
   *
   * @param opts - Read device ID code, starting object ID, and optional `AbortSignal`.
   * @returns An Effect resolving to a `DeviceIdentificationResponse` with conformity level and objects.
   *
   * @see ReadDeviceIdentificationOptions — Options shape from `modbus-rs`.
   * @see DeviceIdentificationResponse — Response type from `modbus-rs`.
   */
  readDeviceIdentification(
    opts: ReadDeviceIdentificationOptions,
  ): Effect.Effect<DeviceIdentificationResponse, ModbusError>;
}

/**
 * Wraps a raw `modbus-rs` client — native (napi) or browser (WASM) — into an
 * {@link EffectModbusClient}.
 *
 * Each method converts a Promise-based call from the upstream client
 * into an `Effect` via {@link Effect.tryPromise}, routing errors through
 * {@link toModbusError} for typed error discrimination.
 *
 * The native and WASM clients share the same method surface (same options
 * shapes, same resolved value shapes — `CoilState[]`, full `FifoQueueResponse`,
 * full `DeviceIdentificationResponse`), so one factory covers both; no
 * transport-specific reshaping is needed.
 *
 * @param client - The upstream `modbus-rs` or `modbus-rs/web` client instance.
 * @returns An `EffectModbusClient` that can be used within Effect
 *          workflows.
 *
 * @see AsyncSerialModbusClient — Upstream native serial client API.
 * @see AsyncTcpModbusClient — Upstream native TCP client API.
 */
export const makeEffectModbusClient = (client: AnyModbusClient): EffectModbusClient => ({
  readHoldingRegisters: (opts) => wrap(() => client.readHoldingRegisters(opts)),
  readInputRegisters: (opts) => wrap(() => client.readInputRegisters(opts)),
  writeSingleRegister: (opts) => wrap(() => client.writeSingleRegister(opts)),
  writeMultipleRegisters: (opts) => wrap(() => client.writeMultipleRegisters(opts)),
  readWriteMultipleRegisters: (opts) => wrap(() => client.readWriteMultipleRegisters(opts)),
  readCoils: (opts) => wrap(() => client.readCoils(opts)),
  writeSingleCoil: (opts) => wrap(() => client.writeSingleCoil(opts)),
  writeMultipleCoils: (opts) => wrap(() => client.writeMultipleCoils(opts)),
  readDiscreteInputs: (opts) => wrap(() => client.readDiscreteInputs(opts)),
  readFifoQueue: (opts) => wrap(() => client.readFifoQueue(opts)),
  readFileRecord: (opts) => wrap(() => client.readFileRecord(opts)),
  writeFileRecord: (opts) => wrap(() => client.writeFileRecord(opts)),
  readExceptionStatus: () => wrap(() => client.readExceptionStatus()),
  diagnostics: (opts) => wrap(() => client.diagnostics(opts)),
  readDeviceIdentification: (opts) => wrap(() => client.readDeviceIdentification(opts)),
});
