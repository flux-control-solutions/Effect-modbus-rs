# Effect-modbus-rs

**Type-safe Modbus communication via Effect-TS**, wrapping the [`modbus-rs`](https://github.com/Raghava-Ch/modbus-rs) npm bindings (Rust napi-rs under the hood).

Provides scoped [`Effect.Service`](https://effect.website) constructors for RTU (serial), TCP, and ASCII Modbus transports. Clients expose a typed `Effect`-based API for all standard Modbus function codes.

## Install

```sh
bun add effect-modbus-rs
```

TypeScript only while prototyping (JS consumers will be supported before 1.0).

## Quick start

### RTU (serial)

```ts
import { Console, Effect } from "effect";
import { RtuTransportService } from "effect-modbus-rs";

const program = Effect.gen(function* () {
  const transport = yield* RtuTransportService;
  const client = yield* transport.withClient(1);

  const registers = yield* client.readHoldingRegisters({
    address: 0,
    quantity: 10,
  });
  console.log("Holding registers:", registers);
});

program.pipe(
  Effect.catchTags({
    ModbusTimeoutError: (err) => Console.log(`Timeout: ${err.message}`),
    ModbusTransportError: (err) =>
      Console.log(`Transport error: ${err.message}`),
    ModbusConnectionClosedError: (err) =>
      Console.log(`Connection lost: ${err.message}`),
    ModbusExceptionError: (err) =>
      Console.log(`Modbus exception ${err.exception}: ${err.message}`),
    ModbusInvalidArgumentError: (err) =>
      Console.log(`Invalid argument: ${err.message}`),
  }),
  Effect.catchAll((err) => Console.log(`Unhandled error: ${err.message}`)),
  Effect.provide(
    RtuTransportService.Default({ portPath: "/dev/ttyUSB0", baudRate: 9600 }),
  ),
  Effect.scoped,
  Effect.runPromise,
);
```

### TCP

```ts
import { Effect } from "effect";
import { TcpTransportService } from "effect-modbus-rs";

const program = Effect.gen(function* () {
  const transport = yield* TcpTransportService;
  const client = yield* transport.withClient(1);
  const coils = yield* client.readCoils({ address: 0, quantity: 8 });
  console.log("Coils:", coils);
});

program.pipe(
  Effect.provide(
    TcpTransportService.Default({ host: "192.168.1.100", port: 502 }),
  ),
  Effect.scoped,
  Effect.runPromise,
);
```

### ASCII

```ts
import { Effect } from "effect";
import { AsciiTransportService } from "effect-modbus-rs";

const program = Effect.gen(function* () {
  const transport = yield* AsciiTransportService;
  const client = yield* transport.withClient(1);
  const registers = yield* client.readInputRegisters({
    address: 0,
    quantity: 5,
  });
  console.log("Input registers:", registers);
});

program.pipe(
  Effect.provide(
    AsciiTransportService.Default({ portPath: "/dev/ttyUSB0", baudRate: 9600 }),
  ),
  Effect.scoped,
  Effect.runPromise,
);
```

### Browser / WASM

`modbus-rs` also ships WASM bindings for the browser, wrapped by this package the same way as the native transports. Since browsers can't open raw TCP or serial connections directly, there are two browser-specific transports:

- **`WasmWsTransportService`** — Modbus TCP over a WebSocket-to-TCP gateway (e.g. the `modbus-gateway` application).
- **`WasmRtuTransportService`** / **`WasmAsciiTransportService`** — Modbus RTU/ASCII over the [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API), via `WasmSerialTransportService.fromRtu` / `.fromAscii`.

```ts
import { Console, Effect } from "effect";
import { WasmWsTransportService } from "effect-modbus-rs";

const program = Effect.gen(function* () {
  const transport = yield* WasmWsTransportService;
  const client = yield* transport.withClient(1);
  const registers = yield* client.readHoldingRegisters({ address: 0, quantity: 10 });
  console.log("Holding registers:", registers);
});

program.pipe(
  Effect.provide(WasmWsTransportService.Default({ wsUrl: "ws://localhost:8080" })),
  Effect.scoped,
  Effect.runPromise,
);
```

Web Serial requires a user-granted port handle. **`requestSerialPort()` must be called synchronously from within a user-gesture event handler** (e.g. a button click) — this is a Web Serial API / browser security requirement, not a library restriction:

```ts
import { Effect, Layer } from "effect";
import { requestSerialPort, WasmRtuTransportService } from "effect-modbus-rs";

connectButton.addEventListener("click", () => {
  Effect.runPromise(
    Effect.gen(function* () {
      const port = yield* requestSerialPort();
      yield* program.pipe(
        Effect.provide(WasmRtuTransportService.Default({ port, baudRate: 19200 })),
        Effect.scoped,
      );
    }),
  );
});
```

See `examples/wasm/` for a real, runnable Vite app exercising both transports in an actual browser (`cd examples/wasm && npm install && npm run dev`) — see its own README for setup details and the current [known limitation](#known-limitation-wasm-build) below.

#### Browser server (experimental)

`wasmWsServerLayer` and `wasmSerialRtuServerLayer` / `wasmSerialAsciiServerLayer` wrap `modbus-rs`'s experimental browser server bindings — same `ServerHandlers` callback shape as the native servers below. Two things differ from native:

- Unlike native servers, the WASM server doesn't start serving on bind — these layers fork the required `serve()` loop into the layer's scope automatically, so usage looks the same as the native `tcpServerLayer`.
- For the serial variants, `options.serialPort` comes from your own app's `navigator.serial.requestPort()` call (not from this package's `requestSerialPort()`, which returns a different wrapper type used only by the client transports).

Not demonstrated in `examples/wasm/` (see that app's README) — the same `import { wasmWsServerLayer } from "effect-modbus-rs"` pattern applies.

## Transports

Each transport is a scoped `Effect.Service`. You provide it with `Effect.provide`, and the connection is opened on service access and closed when the scope ends.

| Service | Options | Connection |
|---------|---------|------------|
| `RtuTransportService` | `{ portPath, baudRate, ... }` | `AsyncRtuTransport.open()` |
| `TcpTransportService` | `{ host, port, ... }` | `AsyncTcpTransport.connect()` |
| `AsciiTransportService` | `{ portPath, baudRate, ... }` | `AsyncAsciiTransport.open()` |
| `WasmWsTransportService` (browser) | `{ wsUrl, requestTimeoutMs? }` | `WasmWsTransport.connect()` |
| `WasmRtuTransportService` (browser) | `{ port, baudRate, ... }` | `WasmRtuTransport.open()` |
| `WasmAsciiTransportService` (browser) | `{ port, baudRate, ... }` | `WasmAsciiTransport.open()` |

All transport options types are re-exported from `modbus-rs` (native transports) or `modbus-rs/web` (browser transports).

### Abstract serial transport

`SerialTransportService` is a transport-agnostic tag that can be backed by either RTU or ASCII framing — useful when writing code that doesn't need to commit to a specific serial protocol. Provide it with `fromRtu` or `fromAscii`:

```ts
import { Console, Effect } from "effect";
import { SerialTransportService } from "effect-modbus-rs";

const program = Effect.gen(function* () {
  const transport = yield* SerialTransportService;
  const client = yield* transport.withClient(1);
  const coils = yield* client.readCoils({ address: 0, quantity: 2 });
  console.log("Coils:", coils);
});

// RTU framing
program.pipe(
  Effect.provide(SerialTransportService.fromRtu({ portPath: "/dev/ttyUSB0", baudRate: 9600 })),
  Effect.scoped,
  Effect.runPromise,
);

// Or ASCII framing
// program.pipe(
//   Effect.provide(SerialTransportService.fromAscii({ portPath: "/dev/ttyUSB0", baudRate: 9600 })),
//   Effect.scoped,
//   Effect.runPromise,
// );
```

It also supports `makeMockTransport` for testing:

## Client API

`transport.withClient(unitId)` returns an `EffectModbusClient` — a typed wrapper around the raw modbus-rs client. All methods return `Effect.Effect<T, ModbusError>`.

### Registers

| Method | Returns |
|--------|---------|
| `readHoldingRegisters({ address, quantity })` | `number[]` |
| `readInputRegisters({ address, quantity })` | `number[]` |
| `writeSingleRegister({ address, value })` | `void` |
| `writeMultipleRegisters({ address, values })` | `void` |
| `readWriteMultipleRegisters({ readAddress, readQuantity, writeAddress, writeValues })` | `number[]` |

### Coils / discrete inputs

| Method | Returns |
|--------|---------|
| `readCoils({ address, quantity })` | `boolean[]` |
| `writeSingleCoil({ address, value })` | `void` |
| `writeMultipleCoils({ address, values })` | `void` |
| `readDiscreteInputs({ address, quantity })` | `boolean[]` |

### Diagnostics & file access

| Method | Returns |
|--------|---------|
| `readExceptionStatus()` | `number` |
| `diagnostics({ subFunction, data })` | `DiagnosticsResponse` |
| `readFifoQueue({ address })` | `FifoQueueResponse` |
| `readFileRecord({ requests })` | `number[][]` |
| `writeFileRecord({ requests })` | `void` |
| `readDeviceIdentification({ readDeviceIdCode, objectId })` | `DeviceIdentificationResponse` |

## Error handling

Errors from the underlying Rust layer are mapped to typed `Effect` errors via `Data.TaggedError`:

| Error class | Meaning |
|-------------|---------|
| `ModbusExceptionError` | Modbus protocol exception (contains `exception` code) |
| `ModbusTimeoutError` | Request timed out |
| `ModbusTransportError` | Transport-level failure |
| `ModbusInvalidArgumentError` | Invalid parameters |
| `ModbusConnectionClosedError` | Connection lost |
| `ModbusNotConnectedError` | Operation attempted before connection |
| `ModbusInternalError` | Unclassified error |

Handle with `Effect.catchTags`. The `ModbusError` union type covers all seven variants.

## Testing with mocks

Each transport service provides a `makeMockTransport(devices)` static method that returns an in-memory mock `Layer` — no serial port or network required.

```ts
import { Console, Effect } from "effect";
import { RtuTransportService } from "effect-modbus-rs";

const device = {
  unitId: 1,
  coils: [
    { address: 0, default: true },
    { address: 1, default: false },
  ],
  discreteInputs: [],
  holdingRegisters: [
    { address: 0, default: 100 },
    { address: 1, default: 200 },
  ],
  inputRegisters: [],
};

const program = Effect.gen(function* () {
  const transport = yield* RtuTransportService;
  const client = yield* transport.withClient(1);
  const coils = yield* client.readCoils({ address: 0, quantity: 2 });
  console.log("Coils:", coils);
});

const mockLayer = RtuTransportService.makeMockTransport([device])({
  portPath: "/dev/ttyUSB0",
  baudRate: 9600,
});

program.pipe(
  Effect.provide(mockLayer),
  Effect.scoped,
  Effect.runPromise,
);
```

The mock factory is identical for all three transports; swap `RtuTransportService` for `TcpTransportService` or `AsciiTransportService` and adjust the options shape accordingly — each exposes a static `makeMockTransport` method.

See `examples/rtu-mock.ts`, `examples/tcp-mock.ts`, and `examples/ascii-mock.ts` for full walkthroughs covering read, write, multi-device access, and error-case testing.

### Slave device schema

| Property | Type | Default |
|----------|------|---------|
| `unitId` | `number` | required |
| `coils` | `{ address, default }[]` | `[]` |
| `discreteInputs` | `{ address, default }[]` | `[]` |
| `holdingRegisters` | `{ address, default }[]` | `[]` |
| `inputRegisters` | `{ address, default }[]` | `[]` |

Coil/default values default to `false` if omitted at the address level; register values default to `0`. Reads beyond the highest configured address produce a `ModbusInvalidArgumentError`.

## Known limitation: WASM build

`modbus-rs`'s WASM build is published separately as `modbus-rs-wasm` and re-exported under `modbus-rs`'s `./web` subpath. **As of this writing, `modbus-rs-wasm@0.15.4` is broken on npm** — the published package is missing its `.wasm` binary and JS glue. This blocks real browser/end-to-end testing of the WASM transports and servers above until upstream republishes a working build (recent commits on their `main` branch look like fixes for exactly this). The WASM services in this package are implemented and type-checked against the documented/source-verified API surface regardless — they should work as-is once upstream's publish is fixed.

## Development

| Action | Command |
|--------|---------|
| Install | `bun install` |
| Type-check | `bun run typecheck` |
| Test | `bun test` |
| Run example | `bun run examples/<name>.ts` |

No build step — `noEmit` is on; Bun runs `.ts` directly.

## Source layout

```
src/
  errors.ts                  — Data.TaggedError types + toModbusError converter
  modbus-client.ts           — EffectModbusClient interface + factory (native + WASM)
  mocks.ts                   — Schema-validated mock transport + slave device definitions
  shared-transport.ts        — Generic scoped transport lifecycle management
  RtuTransportService.ts     — Scoped Effect.Service wrapping AsyncRtuTransport
  TcpTransportService.ts     — Scoped Effect.Service wrapping AsyncTcpTransport
  AsciiTransportService.ts   — Scoped Effect.Service wrapping AsyncAsciiTransport
  SerialTransportService.ts  — Abstract serial transport (RTU/ASCII) tag
  TcpModbusServerService.ts  — tcpServerLayer
  SerialModbusServerService.ts — serialRtuServerLayer / serialAsciiServerLayer
  TcpGatewayService.ts       — tcpGatewayLayer
  modbus-rs-web.d.ts         — Temporary ambient types for modbus-rs/web (see "Known limitation" above)
  WasmSerialPort.ts          — requestSerialPort() Effect helper (browser, user-gesture gated)
  WasmWsTransportService.ts  — Scoped Effect.Service wrapping WasmWsTransport (browser, WS gateway)
  WasmRtuTransportService.ts — Scoped Effect.Service wrapping WasmRtuTransport (browser, Web Serial RTU)
  WasmAsciiTransportService.ts — Scoped Effect.Service wrapping WasmAsciiTransport (browser, Web Serial ASCII)
  WasmSerialTransportService.ts — Abstract browser serial transport (RTU/ASCII) tag
  WasmTcpServerService.ts    — wasmWsServerLayer (experimental)
  WasmSerialModbusServerService.ts — wasmSerialRtuServerLayer / wasmSerialAsciiServerLayer (experimental)
examples/
  rtu-basic.ts               — RTU usage pattern
  tcp-basic.ts               — TCP usage pattern
  ascii-basic.ts             — ASCII usage pattern
  serial-abstract.ts         — Abstract serial transport (RTU or ASCII)
  rtu-mock.ts                — RTU with in-memory mock
  tcp-mock.ts                — TCP with in-memory mock (multi-device)
  ascii-mock.ts              — ASCII with in-memory mock (error-case)
  tcp-polling-stream.ts      — TCP polling, reconnect, and stream
  tcp-finalizer-reset.ts     — TCP scope finalizer reset demo
  tcp-server.ts              — TCP server example
  serial-server.ts           — Serial RTU server example
  wasm/                      — Standalone runnable Vite app for the browser transports (own README, own npm project)
index.ts                     — Re-exports public API
```

## License

GPL-3.0
