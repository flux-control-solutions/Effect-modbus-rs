import { Effect, Schema } from "effect";
import type {
  AsciiTransportOptions,
  DiagnosticsOptions,
  ReadBitsOptions,
  ReadDeviceIdentificationOptions,
  ReadFifoQueueOptions,
  ReadFileRecordOptions,
  ReadRegistersOptions,
  ReadWriteMultipleRegistersOptions,
  RtuTransportOptions,
  TcpTransportOptions,
  WriteFileRecordOptions,
  WriteMultipleCoilsOptions,
  WriteMultipleRegistersOptions,
  WriteSingleCoilOptions,
  WriteSingleRegisterOptions,
} from "modbus-rs";
import { ModbusInvalidArgumentError } from "./errors";
import type { EffectModbusClient } from "./modbus-client";

/**
 * Schema for a single coil (digital output) definition.
 *
 * Each entry declares a coil's address and its default boolean state
 * used when the mock transport initialises.
 */
export const CoilDefinition = Schema.Struct({
  address: Schema.Number,
  default: Schema.Boolean,
});

/**
 * Schema for a single discrete input (digital input) definition.
 *
 * Each entry declares a discrete input's address and its default
 * boolean state used when the mock transport initialises.
 */
export const DiscreteInputDefinition = Schema.Struct({
  address: Schema.Number,
  default: Schema.Boolean,
});

/**
 * Schema for a single register (holding or input) definition.
 *
 * Each entry declares a register's address and its default 16-bit
 * value used when the mock transport initialises.
 */
export const RegisterDefinition = Schema.Struct({
  address: Schema.Number,
  default: Schema.Number,
});

/**
 * Schema for a complete slave device definition.
 *
 * Describes a Modbus slave identified by `unitId`, with optional
 * arrays of coils, discrete inputs, holding registers, and input
 * registers. All arrays default to `[]` when omitted.
 */
export const SlaveDeviceDefinition = Schema.Struct({
  unitId: Schema.Number,
  coils: Schema.optionalWith(Schema.Array(CoilDefinition), {
    default: () => [],
  }),
  discreteInputs: Schema.optionalWith(Schema.Array(DiscreteInputDefinition), {
    default: () => [],
  }),
  holdingRegisters: Schema.optionalWith(Schema.Array(RegisterDefinition), {
    default: () => [],
  }),
  inputRegisters: Schema.optionalWith(Schema.Array(RegisterDefinition), {
    default: () => [],
  }),
});

/**
 * Schema for an array of {@link SlaveDeviceDefinition} — the complete
 * set of slave devices the mock transport should simulate.
 */
export const SlaveDeviceDefinitions = Schema.Array(SlaveDeviceDefinition);

// TODO: Add support for file records (FC20/FC21) and FIFO queues (FC24)

/** Inferred TypeScript type for a {@link CoilDefinition} schema. */
export type CoilDefinition = Schema.Schema.Type<typeof CoilDefinition>;
/** Inferred TypeScript type for a {@link DiscreteInputDefinition} schema. */
export type DiscreteInputDefinition = Schema.Schema.Type<
  typeof DiscreteInputDefinition
>;
/** Inferred TypeScript type for a {@link RegisterDefinition} schema. */
export type RegisterDefinition = Schema.Schema.Type<typeof RegisterDefinition>;
/** Inferred TypeScript type for a {@link SlaveDeviceDefinition} schema. */
export type SlaveDeviceDefinition = Schema.Schema.Type<
  typeof SlaveDeviceDefinition
>;
/** Inferred TypeScript type for a {@link SlaveDeviceDefinitions} schema. */
export type SlaveDeviceDefinitions = Schema.Schema.Type<
  typeof SlaveDeviceDefinitions
>;

/** Internal mutable state held by the mock transport for a single slave device. */
interface MockDeviceState {
  coils: Map<number, boolean>;
  discreteInputs: Map<number, boolean>;
  holdingRegisters: Map<number, number>;
  inputRegisters: Map<number, number>;
  maxCoilAddress: number;
  maxDiscreteAddress: number;
  maxHoldingAddress: number;
  maxInputAddress: number;
}

/** Builds a coil state map from an array of {@link CoilDefinition} entries. */
const buildCoils = (defs: readonly CoilDefinition[]) => {
  const map = new Map<number, boolean>();
  let max = -1;
  for (const d of defs) {
    map.set(d.address, d.default);
    if (d.address > max) max = d.address;
  }
  return { map, maxAddress: max };
};

/** Builds a register state map from an array of {@link RegisterDefinition} entries. */
const buildRegisters = (defs: readonly RegisterDefinition[]) => {
  const map = new Map<number, number>();
  let max = -1;
  for (const d of defs) {
    map.set(d.address, d.default);
    if (d.address > max) max = d.address;
  }
  return { map, maxAddress: max };
};

/**
 * Constructs a {@link ModbusInvalidArgumentError} for an out-of-range
 * address or address+quantity combination.
 *
 * @param label - Human-readable label for the address space (e.g. "Coil", "HoldingRegister").
 * @param address - The starting address that is out of range.
 * @param quantity - Optional quantity that, together with `address`, exceeds the range.
 * @returns A `ModbusInvalidArgumentError` effect.
 */
const failOutOfRange = (label: string, address: number, quantity?: number) =>
  new ModbusInvalidArgumentError({
    cause: new Error(
      quantity !== undefined
        ? `${label} address ${address} with quantity ${quantity} out of range`
        : `${label} address ${address} out of range`,
    ),
    message:
      quantity !== undefined
        ? `${label} read out of range: address=${address}, quantity=${quantity}`
        : `${label} write out of range: address=${address}`,
  });

/**
 * Creates an {@link EffectModbusClient} backed by an in-memory
 * {@link MockDeviceState} map.
 *
 * All Modbus function codes are simulated against the provided state,
 * returning configured default values for reads and mutating state
 * for writes. Out-of-range addresses produce a
 * {@link ModbusInvalidArgumentError}.
 *
 * @param state - The mutable device state to read from and write to.
 * @param unitId - The Modbus unit ID this client represents (used for logging).
 * @returns An `EffectModbusClient` backed by in-memory state.
 */
const makeMockModbusClient = (
  state: MockDeviceState,
  unitId: number,
): EffectModbusClient => ({
  readCoils: Effect.fnUntraced(function* (opts: ReadBitsOptions) {
    yield* Effect.logDebug(`[Mock] unitId=${unitId} readCoils`, opts);
    if (opts.address + opts.quantity > state.maxCoilAddress + 1) {
      return yield* failOutOfRange("Coil", opts.address, opts.quantity);
    }
    const result: boolean[] = [];
    for (let i = opts.address; i < opts.address + opts.quantity; i++) {
      result.push(state.coils.get(i) ?? false);
    }
    return result;
  }),

  readDiscreteInputs: Effect.fnUntraced(function* (opts: ReadBitsOptions) {
    yield* Effect.logDebug(`[Mock] unitId=${unitId} readDiscreteInputs`, opts);
    if (opts.address + opts.quantity > state.maxDiscreteAddress + 1) {
      return yield* failOutOfRange(
        "DiscreteInput",
        opts.address,
        opts.quantity,
      );
    }
    const result: boolean[] = [];
    for (let i = opts.address; i < opts.address + opts.quantity; i++) {
      result.push(state.discreteInputs.get(i) ?? false);
    }
    return result;
  }),

  readHoldingRegisters: Effect.fnUntraced(function* (
    opts: ReadRegistersOptions,
  ) {
    yield* Effect.logDebug(
      `[Mock] unitId=${unitId} readHoldingRegisters`,
      opts,
    );
    if (opts.address + opts.quantity > state.maxHoldingAddress + 1) {
      return yield* failOutOfRange(
        "HoldingRegister",
        opts.address,
        opts.quantity,
      );
    }
    const result: number[] = [];
    for (let i = opts.address; i < opts.address + opts.quantity; i++) {
      result.push(state.holdingRegisters.get(i) ?? 0);
    }
    return result;
  }),

  readInputRegisters: Effect.fnUntraced(function* (opts: ReadRegistersOptions) {
    yield* Effect.logDebug(`[Mock] unitId=${unitId} readInputRegisters`, opts);
    if (opts.address + opts.quantity > state.maxInputAddress + 1) {
      return yield* failOutOfRange(
        "InputRegister",
        opts.address,
        opts.quantity,
      );
    }
    const result: number[] = [];
    for (let i = opts.address; i < opts.address + opts.quantity; i++) {
      result.push(state.inputRegisters.get(i) ?? 0);
    }
    return result;
  }),

  writeSingleCoil: Effect.fnUntraced(function* (opts: WriteSingleCoilOptions) {
    yield* Effect.logDebug(`[Mock] unitId=${unitId} writeSingleCoil`, opts);
    if (opts.address > state.maxCoilAddress) {
      return yield* failOutOfRange("Coil", opts.address);
    }
    state.coils.set(opts.address, opts.value);
  }),

  writeMultipleCoils: Effect.fnUntraced(function* (
    opts: WriteMultipleCoilsOptions,
  ) {
    yield* Effect.logDebug(`[Mock] unitId=${unitId} writeMultipleCoils`, opts);
    if (opts.address + opts.values.length > state.maxCoilAddress + 1) {
      return yield* failOutOfRange("Coil", opts.address, opts.values.length);
    }
    for (let i = 0; i < opts.values.length; i++) {
      state.coils.set(opts.address + i, opts.values[i]!);
    }
  }),

  writeSingleRegister: Effect.fnUntraced(function* (
    opts: WriteSingleRegisterOptions,
  ) {
    yield* Effect.logDebug(`[Mock] unitId=${unitId} writeSingleRegister`, opts);
    if (opts.address > state.maxHoldingAddress) {
      return yield* failOutOfRange("HoldingRegister", opts.address);
    }
    state.holdingRegisters.set(opts.address, opts.value);
  }),

  writeMultipleRegisters: Effect.fnUntraced(function* (
    opts: WriteMultipleRegistersOptions,
  ) {
    yield* Effect.logDebug(
      `[Mock] unitId=${unitId} writeMultipleRegisters`,
      opts,
    );
    if (opts.address + opts.values.length > state.maxHoldingAddress + 1) {
      return yield* failOutOfRange(
        "HoldingRegister",
        opts.address,
        opts.values.length,
      );
    }
    for (let i = 0; i < opts.values.length; i++) {
      state.holdingRegisters.set(opts.address + i, opts.values[i]!);
    }
  }),

  readWriteMultipleRegisters: Effect.fnUntraced(function* (
    opts: ReadWriteMultipleRegistersOptions,
  ) {
    yield* Effect.logDebug(
      `[Mock] unitId=${unitId} readWriteMultipleRegisters`,
      opts,
    );
    if (
      opts.writeAddress + opts.writeValues.length >
      state.maxHoldingAddress + 1
    ) {
      return yield* failOutOfRange(
        "HoldingRegister",
        opts.writeAddress,
        opts.writeValues.length,
      );
    }
    if (opts.readAddress + opts.readQuantity > state.maxHoldingAddress + 1) {
      return yield* failOutOfRange(
        "HoldingRegister",
        opts.readAddress,
        opts.readQuantity,
      );
    }
    for (let i = 0; i < opts.writeValues.length; i++) {
      state.holdingRegisters.set(opts.writeAddress + i, opts.writeValues[i]!);
    }
    const result: number[] = [];
    for (let i = opts.readAddress; i < opts.readAddress + opts.readQuantity; i++) {
      result.push(state.holdingRegisters.get(i) ?? 0);
    }
    return result;
  }),

  readFifoQueue: Effect.fnUntraced(function* (_opts: ReadFifoQueueOptions) {
    return yield* new ModbusInvalidArgumentError({
      cause: new Error("FIFO queue not yet supported in mock"),
      message: "FIFO queue not yet supported in mock",
    });
  }),

  readFileRecord: Effect.fnUntraced(function* (_opts: ReadFileRecordOptions) {
    return yield* new ModbusInvalidArgumentError({
      cause: new Error("File records not yet supported in mock"),
      message: "File records not yet supported in mock",
    });
  }),

  writeFileRecord: Effect.fnUntraced(function* (_opts: WriteFileRecordOptions) {
    return yield* new ModbusInvalidArgumentError({
      cause: new Error("File records not yet supported in mock"),
      message: "File records not yet supported in mock",
    });
  }),

  readExceptionStatus: Effect.fnUntraced(function* () {
    yield* Effect.logDebug(`[Mock] unitId=${unitId} readExceptionStatus`);
    return 0;
  }),

  diagnostics: Effect.fnUntraced(function* (opts: DiagnosticsOptions) {
    yield* Effect.logDebug(`[Mock] unitId=${unitId} diagnostics`, opts);
    return { subFunction: opts.subFunction, data: [] };
  }),

  readDeviceIdentification: Effect.fnUntraced(function* (
    opts: ReadDeviceIdentificationOptions,
  ) {
    yield* Effect.logDebug(
      `[Mock] unitId=${unitId} readDeviceIdentification`,
      opts,
    );
    return {
      conformityLevel: 1,
      moreFollows: false,
      nextObjectId: 0,
      objects: [],
    };
  }),
});

/**
 * Creates a mock transport factory suitable for use as a `scoped`
 * {@link Layer} dependency in tests or development.
 *
 * Accepts an array of {@link SlaveDeviceDefinition} that describe the
 * simulated Modbus slaves, their register maps, and coil states.
 * The returned factory matches the signature expected by the transport
 * service constructors (`RtuTransportOptions | AsciiTransportOptions |
 * TcpTransportOptions`) so it can be injected into any service layer.
 *
 * Unsupported function codes (FIFO queue, file records) return
 * {@link ModbusInvalidArgumentError}.
 *
 * @param devices - Array of slave device definitions to simulate.
 * @returns A transport factory function that returns a scoped Effect
 *          providing the mock transport.
 */
export const makeMockTransport = (devices: SlaveDeviceDefinitions) => {
  const deviceDefs = Schema.decodeUnknownSync(SlaveDeviceDefinitions)(devices);

  const deviceStates = new Map<number, MockDeviceState>();

  for (const def of deviceDefs) {
    const coils = buildCoils(def.coils);
    const discrete = buildCoils(def.discreteInputs);
    const holding = buildRegisters(def.holdingRegisters);
    const input = buildRegisters(def.inputRegisters);
    deviceStates.set(def.unitId, {
      coils: coils.map,
      discreteInputs: discrete.map,
      holdingRegisters: holding.map,
      inputRegisters: input.map,
      maxCoilAddress: coils.maxAddress,
      maxDiscreteAddress: discrete.maxAddress,
      maxHoldingAddress: holding.maxAddress,
      maxInputAddress: input.maxAddress,
    });
  }

  return (
    _options: RtuTransportOptions | AsciiTransportOptions | TcpTransportOptions,
  ) =>
    Effect.gen(function* () {
      yield* Effect.logDebug("Mock transport opened with devices:", deviceDefs);

      return {
        withClient: Effect.fnUntraced(function* (unitId: number) {
          const state = deviceStates.get(unitId);
          if (!state) {
            return yield* new ModbusInvalidArgumentError({
              cause: new Error(
                `Device with unitId ${unitId} not found in mock configuration`,
              ),
              message: `Device with unitId ${unitId} not found in mock configuration`,
            });
          }
          return makeMockModbusClient(state, unitId);
        }),

        setRequestTimeout: (_timeoutMs: number) => Effect.void,
        clearRequestTimeout: () => Effect.void,
        reconnect: Effect.logDebug("Mock: reconnecting"),
        close: Effect.logDebug("Mock: closing transport"),
        hasPendingRequests: () => false,
      };
    });
};
