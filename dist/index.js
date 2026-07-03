import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/errors.ts
import { Data } from "effect";
import { getModbusErrorCode, ModbusErrorCode } from "modbus-rs";

class ModbusExceptionError extends Data.TaggedError("ModbusExceptionError") {
}

class ModbusTimeoutError extends Data.TaggedError("ModbusTimeoutError") {
}

class ModbusTransportError extends Data.TaggedError("ModbusTransportError") {
}

class ModbusInvalidArgumentError extends Data.TaggedError("ModbusInvalidArgumentError") {
}

class ModbusConnectionClosedError extends Data.TaggedError("ModbusConnectionClosedError") {
}

class ModbusInternalError extends Data.TaggedError("ModbusInternalError") {
}

class ModbusNotConnectedError extends Data.TaggedError("ModbusNotConnectedError") {
}
function parseExceptionCode(message) {
  const m = message.match(/\[MODBUS_EXCEPTION:(\d+)\]/);
  return m ? Number(m[1]) : undefined;
}
var toModbusError = (cause) => {
  const code = getModbusErrorCode(cause);
  const message = cause.message;
  switch (code) {
    case ModbusErrorCode.EXCEPTION:
      return new ModbusExceptionError({
        cause,
        exception: parseExceptionCode(message) ?? 0,
        message
      });
    case ModbusErrorCode.TIMEOUT:
      return new ModbusTimeoutError({ cause, message });
    case ModbusErrorCode.TRANSPORT:
      return new ModbusTransportError({ cause, message });
    case ModbusErrorCode.INVALID_ARGUMENT:
      return new ModbusInvalidArgumentError({ cause, message });
    case ModbusErrorCode.CONNECTION_CLOSED:
      return new ModbusConnectionClosedError({ cause, message });
    default:
      return new ModbusInternalError({ cause, message });
  }
};
// src/AsciiTransportService.ts
import { Effect as Effect4, Layer } from "effect";

// src/shared-transport.ts
import { Effect as Effect2, Exit, Scope } from "effect";

// src/modbus-client.ts
import { Effect } from "effect";
var makeEffectModbusClient = (client) => ({
  readHoldingRegisters: (opts) => Effect.tryPromise({
    try: () => client.readHoldingRegisters(opts),
    catch: (error) => toModbusError(error)
  }),
  readInputRegisters: (opts) => Effect.tryPromise({
    try: () => client.readInputRegisters(opts),
    catch: (error) => toModbusError(error)
  }),
  writeSingleRegister: (opts) => Effect.tryPromise({
    try: () => client.writeSingleRegister(opts),
    catch: (error) => toModbusError(error)
  }),
  writeMultipleRegisters: (opts) => Effect.tryPromise({
    try: () => client.writeMultipleRegisters(opts),
    catch: (error) => toModbusError(error)
  }),
  readWriteMultipleRegisters: (opts) => Effect.tryPromise({
    try: () => client.readWriteMultipleRegisters(opts),
    catch: (error) => toModbusError(error)
  }),
  readCoils: (opts) => Effect.tryPromise({
    try: () => client.readCoils(opts),
    catch: (error) => toModbusError(error)
  }),
  writeSingleCoil: (opts) => Effect.tryPromise({
    try: () => client.writeSingleCoil(opts),
    catch: (error) => toModbusError(error)
  }),
  writeMultipleCoils: (opts) => Effect.tryPromise({
    try: () => client.writeMultipleCoils(opts),
    catch: (error) => toModbusError(error)
  }),
  readDiscreteInputs: (opts) => Effect.tryPromise({
    try: () => client.readDiscreteInputs(opts),
    catch: (error) => toModbusError(error)
  }),
  readFifoQueue: (opts) => Effect.tryPromise({
    try: () => client.readFifoQueue(opts),
    catch: (error) => toModbusError(error)
  }),
  readFileRecord: (opts) => Effect.tryPromise({
    try: () => client.readFileRecord(opts),
    catch: (error) => toModbusError(error)
  }),
  writeFileRecord: (opts) => Effect.tryPromise({
    try: () => client.writeFileRecord(opts),
    catch: (error) => toModbusError(error)
  }),
  readExceptionStatus: () => Effect.tryPromise({
    try: () => client.readExceptionStatus(),
    catch: (error) => toModbusError(error)
  }),
  diagnostics: (opts) => Effect.tryPromise({
    try: () => client.diagnostics(opts),
    catch: (error) => toModbusError(error)
  }),
  readDeviceIdentification: (opts) => Effect.tryPromise({
    try: () => client.readDeviceIdentification(opts),
    catch: (error) => toModbusError(error)
  })
});

// src/shared-transport.ts
function makeTransportScoped(transportKey, openMethod, serviceName) {
  return Effect2.fnUntraced(function* (options) {
    const mod = yield* Effect2.promise(() => import("modbus-rs"));
    const TC = mod[transportKey];
    let transport = null;
    let connectPromise = null;
    let reconnectPromise = null;
    const clientSet = new Map;
    let closed = false;
    const ensureOpen = Effect2.fnUntraced(function* () {
      if (transport) {
        if (closed) {
          return yield* new ModbusNotConnectedError({
            cause: new Error("Transport has been closed"),
            message: "Transport has been closed"
          });
        }
        return transport;
      }
      if (closed) {
        return yield* new ModbusNotConnectedError({
          cause: new Error("Transport has been closed"),
          message: "Transport has been closed"
        });
      }
      if (!connectPromise) {
        connectPromise = openMethod(TC, options);
      }
      const t = yield* Effect2.tryPromise({
        try: () => connectPromise,
        catch: (error) => toModbusError(error)
      }).pipe(Effect2.catchAll((err) => {
        connectPromise = null;
        return Effect2.fail(err);
      }));
      if (closed) {
        connectPromise = null;
        yield* Effect2.fork(Effect2.promise(() => t.close()).pipe(Effect2.catchAll(() => Effect2.void)));
        return yield* new ModbusNotConnectedError({
          cause: new Error("Transport has been closed"),
          message: "Transport has been closed"
        });
      }
      transport = t;
      return t;
    });
    yield* Effect2.addFinalizer(() => {
      if (closed)
        return Effect2.void;
      closed = true;
      const t = transport;
      if (!t)
        return Effect2.void;
      return Effect2.andThen(Effect2.logDebug(`Closing ${serviceName}`), Effect2.promise(() => t.close()));
    });
    const notConnectedMsg = "Transport is not connected. Call withClient() first.";
    return {
      withClient: Effect2.fnUntraced(function* (unitId) {
        const t = yield* ensureOpen();
        let client = clientSet.get(unitId);
        if (!client) {
          client = yield* Effect2.try({
            try: () => t.createClient({ unitId }),
            catch: (error) => toModbusError(error)
          });
          clientSet.set(unitId, client);
        }
        return makeEffectModbusClient(client);
      }),
      setRequestTimeout: Effect2.fnUntraced(function* (timeoutMs) {
        const t = transport;
        if (!t || closed) {
          return yield* new ModbusNotConnectedError({
            cause: new Error(notConnectedMsg),
            message: notConnectedMsg
          });
        }
        t.setRequestTimeout(timeoutMs);
      }),
      clearRequestTimeout: Effect2.fnUntraced(function* () {
        const t = transport;
        if (!t || closed) {
          return yield* new ModbusNotConnectedError({
            cause: new Error(notConnectedMsg),
            message: notConnectedMsg
          });
        }
        t.clearRequestTimeout();
      }),
      reconnect: Effect2.fnUntraced(function* () {
        if (closed) {
          return yield* new ModbusNotConnectedError({
            cause: new Error("Transport has been closed"),
            message: "Transport has been closed"
          });
        }
        if (transport) {
          if (!reconnectPromise) {
            reconnectPromise = transport.reconnect().then(() => {
              reconnectPromise = null;
            }).catch((err) => {
              reconnectPromise = null;
              throw err;
            });
          }
          yield* Effect2.tryPromise({
            try: () => reconnectPromise,
            catch: (error) => toModbusError(error)
          });
        } else {
          yield* ensureOpen();
        }
      }),
      close: Effect2.fnUntraced(function* () {
        if (closed)
          return;
        closed = true;
        const t = transport;
        if (t) {
          yield* Effect2.tryPromise({
            try: () => t.close(),
            catch: (error) => toModbusError(error)
          });
        }
        const scope = yield* Effect2.scope;
        yield* Scope.close(scope, Exit.void);
      }),
      hasPendingRequests: () => {
        if (closed)
          return false;
        const t = transport;
        if (!t)
          return false;
        return t.pendingRequests;
      }
    };
  });
}

// src/mocks.ts
import { Effect as Effect3, Schema } from "effect";
var CoilDefinition = Schema.Struct({
  address: Schema.Number,
  default: Schema.Boolean
});
var DiscreteInputDefinition = Schema.Struct({
  address: Schema.Number,
  default: Schema.Boolean
});
var RegisterDefinition = Schema.Struct({
  address: Schema.Number,
  default: Schema.Number
});
var SlaveDeviceDefinition = Schema.Struct({
  unitId: Schema.Number,
  coils: Schema.optionalWith(Schema.Array(CoilDefinition), {
    default: () => []
  }),
  discreteInputs: Schema.optionalWith(Schema.Array(DiscreteInputDefinition), {
    default: () => []
  }),
  holdingRegisters: Schema.optionalWith(Schema.Array(RegisterDefinition), {
    default: () => []
  }),
  inputRegisters: Schema.optionalWith(Schema.Array(RegisterDefinition), {
    default: () => []
  })
});
var SlaveDeviceDefinitions = Schema.Array(SlaveDeviceDefinition);
var buildCoils = (defs) => {
  const map = new Map;
  let max = -1;
  for (const d of defs) {
    map.set(d.address, d.default);
    if (d.address > max)
      max = d.address;
  }
  return { map, maxAddress: max };
};
var buildRegisters = (defs) => {
  const map = new Map;
  let max = -1;
  for (const d of defs) {
    map.set(d.address, d.default);
    if (d.address > max)
      max = d.address;
  }
  return { map, maxAddress: max };
};
var failOutOfRange = (label, address, quantity) => new ModbusInvalidArgumentError({
  cause: new Error(quantity !== undefined ? `${label} address ${address} with quantity ${quantity} out of range` : `${label} address ${address} out of range`),
  message: quantity !== undefined ? `${label} read out of range: address=${address}, quantity=${quantity}` : `${label} write out of range: address=${address}`
});
var makeMockModbusClient = (state, unitId) => ({
  readCoils: Effect3.fnUntraced(function* (opts) {
    yield* Effect3.logDebug(`[Mock] unitId=${unitId} readCoils`, opts);
    if (opts.address + opts.quantity > state.maxCoilAddress + 1) {
      return yield* failOutOfRange("Coil", opts.address, opts.quantity);
    }
    const result = [];
    for (let i = opts.address;i < opts.address + opts.quantity; i++) {
      result.push(state.coils.get(i) ?? false);
    }
    return result;
  }),
  readDiscreteInputs: Effect3.fnUntraced(function* (opts) {
    yield* Effect3.logDebug(`[Mock] unitId=${unitId} readDiscreteInputs`, opts);
    if (opts.address + opts.quantity > state.maxDiscreteAddress + 1) {
      return yield* failOutOfRange("DiscreteInput", opts.address, opts.quantity);
    }
    const result = [];
    for (let i = opts.address;i < opts.address + opts.quantity; i++) {
      result.push(state.discreteInputs.get(i) ?? false);
    }
    return result;
  }),
  readHoldingRegisters: Effect3.fnUntraced(function* (opts) {
    yield* Effect3.logDebug(`[Mock] unitId=${unitId} readHoldingRegisters`, opts);
    if (opts.address + opts.quantity > state.maxHoldingAddress + 1) {
      return yield* failOutOfRange("HoldingRegister", opts.address, opts.quantity);
    }
    const result = [];
    for (let i = opts.address;i < opts.address + opts.quantity; i++) {
      result.push(state.holdingRegisters.get(i) ?? 0);
    }
    return result;
  }),
  readInputRegisters: Effect3.fnUntraced(function* (opts) {
    yield* Effect3.logDebug(`[Mock] unitId=${unitId} readInputRegisters`, opts);
    if (opts.address + opts.quantity > state.maxInputAddress + 1) {
      return yield* failOutOfRange("InputRegister", opts.address, opts.quantity);
    }
    const result = [];
    for (let i = opts.address;i < opts.address + opts.quantity; i++) {
      result.push(state.inputRegisters.get(i) ?? 0);
    }
    return result;
  }),
  writeSingleCoil: Effect3.fnUntraced(function* (opts) {
    yield* Effect3.logDebug(`[Mock] unitId=${unitId} writeSingleCoil`, opts);
    if (opts.address > state.maxCoilAddress) {
      return yield* failOutOfRange("Coil", opts.address);
    }
    state.coils.set(opts.address, opts.value);
  }),
  writeMultipleCoils: Effect3.fnUntraced(function* (opts) {
    yield* Effect3.logDebug(`[Mock] unitId=${unitId} writeMultipleCoils`, opts);
    if (opts.address + opts.values.length > state.maxCoilAddress + 1) {
      return yield* failOutOfRange("Coil", opts.address, opts.values.length);
    }
    for (let i = 0;i < opts.values.length; i++) {
      state.coils.set(opts.address + i, opts.values[i]);
    }
  }),
  writeSingleRegister: Effect3.fnUntraced(function* (opts) {
    yield* Effect3.logDebug(`[Mock] unitId=${unitId} writeSingleRegister`, opts);
    if (opts.address > state.maxHoldingAddress) {
      return yield* failOutOfRange("HoldingRegister", opts.address);
    }
    state.holdingRegisters.set(opts.address, opts.value);
  }),
  writeMultipleRegisters: Effect3.fnUntraced(function* (opts) {
    yield* Effect3.logDebug(`[Mock] unitId=${unitId} writeMultipleRegisters`, opts);
    if (opts.address + opts.values.length > state.maxHoldingAddress + 1) {
      return yield* failOutOfRange("HoldingRegister", opts.address, opts.values.length);
    }
    for (let i = 0;i < opts.values.length; i++) {
      state.holdingRegisters.set(opts.address + i, opts.values[i]);
    }
  }),
  readWriteMultipleRegisters: Effect3.fnUntraced(function* (opts) {
    yield* Effect3.logDebug(`[Mock] unitId=${unitId} readWriteMultipleRegisters`, opts);
    if (opts.writeAddress + opts.writeValues.length > state.maxHoldingAddress + 1) {
      return yield* failOutOfRange("HoldingRegister", opts.writeAddress, opts.writeValues.length);
    }
    if (opts.readAddress + opts.readQuantity > state.maxHoldingAddress + 1) {
      return yield* failOutOfRange("HoldingRegister", opts.readAddress, opts.readQuantity);
    }
    for (let i = 0;i < opts.writeValues.length; i++) {
      state.holdingRegisters.set(opts.writeAddress + i, opts.writeValues[i]);
    }
    const result = [];
    for (let i = opts.readAddress;i < opts.readAddress + opts.readQuantity; i++) {
      result.push(state.holdingRegisters.get(i) ?? 0);
    }
    return result;
  }),
  readFifoQueue: Effect3.fnUntraced(function* (_opts) {
    return yield* new ModbusInvalidArgumentError({
      cause: new Error("FIFO queue not yet supported in mock"),
      message: "FIFO queue not yet supported in mock"
    });
  }),
  readFileRecord: Effect3.fnUntraced(function* (_opts) {
    return yield* new ModbusInvalidArgumentError({
      cause: new Error("File records not yet supported in mock"),
      message: "File records not yet supported in mock"
    });
  }),
  writeFileRecord: Effect3.fnUntraced(function* (_opts) {
    return yield* new ModbusInvalidArgumentError({
      cause: new Error("File records not yet supported in mock"),
      message: "File records not yet supported in mock"
    });
  }),
  readExceptionStatus: Effect3.fnUntraced(function* () {
    yield* Effect3.logDebug(`[Mock] unitId=${unitId} readExceptionStatus`);
    return 0;
  }),
  diagnostics: Effect3.fnUntraced(function* (opts) {
    yield* Effect3.logDebug(`[Mock] unitId=${unitId} diagnostics`, opts);
    return { subFunction: opts.subFunction, data: [] };
  }),
  readDeviceIdentification: Effect3.fnUntraced(function* (opts) {
    yield* Effect3.logDebug(`[Mock] unitId=${unitId} readDeviceIdentification`, opts);
    return {
      conformityLevel: 1,
      moreFollows: false,
      nextObjectId: 0,
      objects: []
    };
  })
});
var makeMockTransport = (devices) => {
  const deviceDefs = Schema.decodeUnknownSync(SlaveDeviceDefinitions)(devices);
  const deviceStates = new Map;
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
      maxInputAddress: input.maxAddress
    });
  }
  return (_options) => Effect3.gen(function* () {
    yield* Effect3.logDebug("Mock transport opened with devices:", deviceDefs);
    return {
      withClient: Effect3.fnUntraced(function* (unitId) {
        const state = deviceStates.get(unitId);
        if (!state) {
          return yield* new ModbusInvalidArgumentError({
            cause: new Error(`Device with unitId ${unitId} not found in mock configuration`),
            message: `Device with unitId ${unitId} not found in mock configuration`
          });
        }
        return makeMockModbusClient(state, unitId);
      }),
      setRequestTimeout: (_timeoutMs) => Effect3.void,
      clearRequestTimeout: () => Effect3.void,
      reconnect: () => Effect3.asVoid(Effect3.logDebug("Mock: reconnecting")),
      close: () => Effect3.logDebug("Mock: closing transport"),
      hasPendingRequests: () => false
    };
  });
};

// src/AsciiTransportService.ts
class AsciiTransportService extends Effect4.Service()("AsciiTransportService", {
  scoped: makeTransportScoped("AsyncAsciiTransport", (TC, options) => TC.open(options), "AsciiTransportService")
}) {
  static makeMockTransport = (devices) => {
    const factory = makeMockTransport(devices);
    return (options) => Layer.scoped(AsciiTransportService, factory(options));
  };
}
// src/SerialTransportService.ts
import { Context, Layer as Layer3 } from "effect";

// src/RtuTransportService.ts
import { Effect as Effect5, Layer as Layer2 } from "effect";
class RtuTransportService extends Effect5.Service()("RtuTransportService", {
  scoped: makeTransportScoped("AsyncRtuTransport", (TC, options) => TC.open(options), "RtuTransportService")
}) {
  static makeMockTransport = (devices) => {
    const factory = makeMockTransport(devices);
    return (options) => Layer2.scoped(RtuTransportService, factory(options));
  };
}

// src/SerialTransportService.ts
class SerialTransportService extends Context.Tag("SerialTransportService")() {
  static fromAscii(options) {
    return Layer3.project(AsciiTransportService, SerialTransportService, (ascii) => ascii)(AsciiTransportService.Default(options));
  }
  static fromRtu(options) {
    return Layer3.project(RtuTransportService, SerialTransportService, (rtu) => rtu)(RtuTransportService.Default(options));
  }
  static makeMockTransport = (devices) => {
    const factory = makeMockTransport(devices);
    return (options) => Layer3.scoped(SerialTransportService, factory(options));
  };
}
// src/TcpTransportService.ts
import { Effect as Effect7, Layer as Layer4 } from "effect";
class TcpTransportService extends Effect7.Service()("TcpTransportService", {
  scoped: makeTransportScoped("AsyncTcpTransport", (TC, options) => TC.connect(options), "TcpTransportService")
}) {
  static makeMockTransport = (devices) => {
    const factory = makeMockTransport(devices);
    return (options) => Layer4.scoped(TcpTransportService, factory(options));
  };
}
// src/SerialModbusServerService.ts
import { Effect as Effect8, Layer as Layer5 } from "effect";
var serialRtuServerLayer = (options, handlers) => Layer5.scopedDiscard(Effect8.gen(function* () {
  const { AsyncSerialModbusServer } = yield* Effect8.promise(() => import("modbus-rs"));
  const server = yield* Effect8.tryPromise({
    try: () => AsyncSerialModbusServer.bindRtu(options, handlers),
    catch: (error) => toModbusError(error)
  });
  yield* Effect8.logDebug(`Serial RTU server bound to ${options.portPath}`);
  yield* Effect8.addFinalizer(() => Effect8.logDebug("Serial RTU server shutting down").pipe(Effect8.andThen(Effect8.tryPromise({
    try: () => server.shutdown(),
    catch: (error) => toModbusError(error)
  })), Effect8.catchAll(() => Effect8.void)));
}));
var serialAsciiServerLayer = (options, handlers) => Layer5.scopedDiscard(Effect8.gen(function* () {
  const { AsyncSerialModbusServer } = yield* Effect8.promise(() => import("modbus-rs"));
  const server = yield* Effect8.tryPromise({
    try: () => AsyncSerialModbusServer.bindAscii(options, handlers),
    catch: (error) => toModbusError(error)
  });
  yield* Effect8.logDebug(`Serial ASCII server bound to ${options.portPath}`);
  yield* Effect8.addFinalizer(() => Effect8.logDebug("Serial ASCII server shutting down").pipe(Effect8.andThen(Effect8.tryPromise({
    try: () => server.shutdown(),
    catch: (error) => toModbusError(error)
  })), Effect8.catchAll(() => Effect8.void)));
}));
// src/TcpModbusServerService.ts
import { Effect as Effect9, Layer as Layer6 } from "effect";
var tcpServerLayer = (options, handlers) => Layer6.scopedDiscard(Effect9.gen(function* () {
  const { AsyncTcpModbusServer } = yield* Effect9.promise(() => import("modbus-rs"));
  const server = yield* Effect9.tryPromise({
    try: () => AsyncTcpModbusServer.bind(options, handlers),
    catch: (error) => toModbusError(error)
  });
  yield* Effect9.logDebug(`TCP server bound to ${options.host}:${options.port}`);
  yield* Effect9.addFinalizer(() => Effect9.logDebug("TCP server shutting down").pipe(Effect9.andThen(Effect9.tryPromise({
    try: () => server.shutdown(),
    catch: (error) => toModbusError(error)
  })), Effect9.catchAll(() => Effect9.void)));
}));
// src/TcpGatewayService.ts
import { Effect as Effect10, Layer as Layer7 } from "effect";
var tcpGatewayLayer = (options, gatewayConfig) => Layer7.scopedDiscard(Effect10.gen(function* () {
  const { AsyncTcpGateway } = yield* Effect10.promise(() => import("modbus-rs"));
  const gateway = yield* Effect10.tryPromise({
    try: () => AsyncTcpGateway.bind(options, gatewayConfig),
    catch: (error) => toModbusError(error)
  });
  yield* Effect10.logDebug(`TCP gateway bound to ${options.host}:${options.port}`);
  yield* Effect10.addFinalizer(() => Effect10.logDebug("TCP gateway shutting down").pipe(Effect10.andThen(Effect10.tryPromise({
    try: () => gateway.shutdown(),
    catch: (error) => toModbusError(error)
  })), Effect10.catchAll(() => Effect10.void)));
}));
export {
  toModbusError,
  tcpServerLayer,
  tcpGatewayLayer,
  serialRtuServerLayer,
  serialAsciiServerLayer,
  TcpTransportService,
  SerialTransportService,
  RtuTransportService,
  ModbusTransportError,
  ModbusTimeoutError,
  ModbusNotConnectedError,
  ModbusInvalidArgumentError,
  ModbusInternalError,
  ModbusExceptionError,
  ModbusConnectionClosedError,
  AsciiTransportService
};
