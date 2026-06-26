# Effect-modbus-rs

**Type-safe Modbus communication via Effect-TS**, wrapping the [`modbus-rs`](https://github.com/brendanzagaeski/modbus-rs) npm bindings (Rust napi-rs under the hood).

Provides scoped [`Effect.Service`](https://effect.website) constructors for RTU (serial), TCP, and ASCII Modbus transports. Clients expose a typed `Effect`-based API for all standard Modbus function codes.

## Install

```sh
bun install effect-modbus-rs
```

Requires **Bun** (no Node, npm, pnpm, or yarn).

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

## Transports

Each transport is a scoped `Effect.Service`. You provide it with `Effect.provide`, and the connection is opened on service access and closed when the scope ends.

| Service | Options | Connection |
|---------|---------|------------|
| `RtuTransportService` | `{ portPath, baudRate, ... }` | `AsyncRtuTransport.open()` |
| `TcpTransportService` | `{ host, port, ... }` | `AsyncTcpTransport.connect()` |
| `AsciiTransportService` | `{ portPath, baudRate, ... }` | `AsyncAsciiTransport.open()` |

All transport options types are re-exported from `modbus-rs`.

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
| `readFileRecord({ records })` | `number[][]` |
| `writeFileRecord({ records })` | `void` |
| `readDeviceIdentification({ identificationCode, objectId })` | `DeviceIdentificationResponse` |

## Error handling

Errors from the underlying Rust layer are mapped to typed `Effect` errors via `Data.TaggedError`:

| Error class | Meaning |
|-------------|---------|
| `ModbusExceptionError` | Modbus protocol exception (contains `exception` code) |
| `ModbusTimeoutError` | Request timed out |
| `ModbusTransportError` | Transport-level failure |
| `ModbusInvalidArgumentError` | Invalid parameters |
| `ModbusConnectionClosedError` | Connection lost |
| `ModbusInternalError` | Unclassified error |

Handle with `Effect.catchTags`. The `ModbusError` union type covers all six variants.

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
  modbus-client.ts           — EffectModbusClient interface + factory
  RtuTransportService.ts     — Scoped Effect.Service wrapping AsyncRtuTransport
  TcpTransportService.ts     — Scoped Effect.Service wrapping AsyncTcpTransport
  AsciiTransportService.ts   — Scoped Effect.Service wrapping AsyncAsciiTransport
examples/
  rtu-basic.ts               — RTU usage pattern
  tcp-basic.ts               — TCP usage pattern
  ascii-basic.ts             — ASCII usage pattern
index.ts                     — Re-exports public API
```

## License

GPL-3.0
