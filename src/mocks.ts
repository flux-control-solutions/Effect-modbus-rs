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
import { ModbusInvalidArgumentError } from "./errors.js";
import type { EffectModbusClient } from "./modbus-client.js";

export const CoilDefinition = Schema.Struct({
  address: Schema.Number,
  default: Schema.Boolean,
});

export const DiscreteInputDefinition = Schema.Struct({
  address: Schema.Number,
  default: Schema.Boolean,
});

export const RegisterDefinition = Schema.Struct({
  address: Schema.Number,
  default: Schema.Number,
});

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

export const SlaveDeviceDefinitions = Schema.Array(SlaveDeviceDefinition);

// TODO: Add support for file records (FC20/FC21) and FIFO queues (FC24)

export type CoilDefinition = Schema.Schema.Type<typeof CoilDefinition>;
export type DiscreteInputDefinition = Schema.Schema.Type<
  typeof DiscreteInputDefinition
>;
export type RegisterDefinition = Schema.Schema.Type<typeof RegisterDefinition>;
export type SlaveDeviceDefinition = Schema.Schema.Type<
  typeof SlaveDeviceDefinition
>;

export type SlaveDeviceDefinitions = Schema.Schema.Type<
  typeof SlaveDeviceDefinitions
>;

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

const buildCoils = (defs: readonly CoilDefinition[]) => {
  const map = new Map<number, boolean>();
  let max = -1;
  for (const d of defs) {
    map.set(d.address, d.default);
    if (d.address > max) max = d.address;
  }
  return { map, maxAddress: max };
};

const buildRegisters = (defs: readonly RegisterDefinition[]) => {
  const map = new Map<number, number>();
  let max = -1;
  for (const d of defs) {
    map.set(d.address, d.default);
    if (d.address > max) max = d.address;
  }
  return { map, maxAddress: max };
};

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

        setRequestTimeout: (_timeoutMs: number) => {},
        clearRequestTimeout: () => {},
        reconnect: Effect.logDebug("Mock: reconnecting"),
        close: Effect.logDebug("Mock: closing transport"),
        hasPendingRequests: () => false,
      };
    });
};
