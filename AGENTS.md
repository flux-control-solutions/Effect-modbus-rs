# effect-modbus-rs

Type-safe Modbus communication via Effect-TS, wrapping the `modbus-rs` npm bindings (Rust napi-rs under the hood).

## Stack

- **Runtime**: Bun only — never use Node, npm, pnpm, yarn, or vite.
- **Language**: TypeScript 6 (ESNext, `verbatimModuleSyntax`, bundler resolution, `module: "Preserve"`).
- **Core libs**: `effect` (^3.22.0), `modbus-rs` (^0.15.4).
- **LSP**: `@effect/language-service` plugin in `tsconfig.json` `compilerOptions.plugins`.
- **License**: GPL-3.0.

## Commands

| Action | Command |
|--------|---------|
| Install | `bun install` |
| Type-check | `bun run typecheck` |
| Test | `bun run test` (create under `**/*.test.ts`) |
| Run example | `bun run examples/<name>.ts` |

No build step — `noEmit` is on; Bun runs `.ts` directly.

## Source layout

```
index.ts                     — Re-exports all public API from src/
src/
  errors.ts                  — Data.TaggedError types + toModbusError converter
  modbus-client.ts           — EffectModbusClient interface + Effect.tryPromise wrapper (native + WASM factories)
  mocks.ts                   — Schema-validated mock transport for testing
  shared-transport.ts        — Generic scoped transport lifecycle management
  RtuTransportService.ts     — Scoped Effect.Service wrapping AsyncRtuTransport
  TcpTransportService.ts     — Scoped Effect.Service wrapping AsyncTcpTransport
  AsciiTransportService.ts   — Scoped Effect.Service wrapping AsyncAsciiTransport
  modbus-rs-web.d.ts         — TEMPORARY ambient types for `modbus-rs/web` (upstream WASM publish is broken; see below)
  WasmSerialPort.ts          — requestSerialPort() Effect helper (user-gesture gated, Web Serial API)
  WasmWsTransportService.ts  — Scoped Effect.Service wrapping WasmWsTransport (browser, TCP over WebSocket gateway)
  WasmRtuTransportService.ts — Scoped Effect.Service wrapping WasmRtuTransport (browser, Web Serial RTU)
  WasmAsciiTransportService.ts — Scoped Effect.Service wrapping WasmAsciiTransport (browser, Web Serial ASCII)
  WasmSerialTransportService.ts — Abstract browser serial transport tag (fromRtu/fromAscii), mirrors SerialTransportService.ts
  WasmTcpServerService.ts    — wasmWsServerLayer (experimental browser WS-gateway server)
  WasmSerialModbusServerService.ts — wasmSerialRtuServerLayer / wasmSerialAsciiServerLayer (experimental browser Web Serial servers)
examples/
  rtu-basic.ts               — RTU usage: provide, scoped, runPromise
  tcp-basic.ts               — TCP usage pattern
  ascii-basic.ts             — ASCII usage pattern
  rtu-mock.ts                — RTU with in-memory mock
  tcp-mock.ts                — TCP with in-memory mock (multi-device)
  ascii-mock.ts              — ASCII with in-memory mock (error-case)
  tcp-polling-stream.ts      — TCP polling, reconnect, and stream
  tcp-finalizer-reset.ts     — TCP scope finalizer reset demo
  tcp-server.ts              — TCP server example
  serial-server.ts           — Serial RTU server example
  wasm/                      — Standalone runnable Vite app exercising the browser transports (own README, own npm project — see below)
```

`examples/wasm/` is its own npm project (package.json, tsconfig.json, vite.config.ts) — a real Vite app, not Bun-run `.ts`, since it needs an actual browser bundler to exercise the WASM transports. It links back to this package via `"effect-modbus-rs": "file:../.."`. The root `tsconfig.json` excludes it (`examples/wasm`) since it has its own DOM-aware tsconfig; the root `bun run test`/`typecheck` scripts don't touch it. Run it with `cd examples/wasm && npm install && npm run dev` — see its README for the current known-limitation caveat.

## Architecture

- **`Effect.Service` scoped** — each transport service opens its connection in a `scoped` constructor. The transport is automatically closed when the consuming `Scope` finalizes (`Effect.addFinalizer`).
- **Dynamic import** — `modbus-rs` is imported inside the constructor via `yield* Effect.promise(() => import("modbus-rs"))`. This keeps the native module load deferred.
- **Client caching** — clients are created per `unitId` via `transport.createClient({ unitId })` and cached in a `Map<number, Async*ModbusClient>`. Repeated `withClient()` calls for the same unit ID reuse the cached client.
- **`EffectModbusClient`** — wraps the raw `modbus-rs` client methods via `Effect.tryPromise`, routing errors through `toModbusError`. All methods return `Effect.Effect<T, ModbusError>`.
- **Error mapping** — raw `Error` → typed `ModbusError` union via `toModbusError` in `src/errors.ts`. Handle with `Effect.catchTags` (see examples).
- **`makeMockTransport`** — each service has a static `makeMockTransport(devices)` that returns a `Layer` using an in-memory mock. Takes `SlaveDeviceDefinitions` (array of `SlaveDeviceDefinition` with Schema-validated coils, discrete inputs, holding/input registers per unitId).

## Conventions

- Follow `effect` idioms: `Effect`, `Layer`, `Schema`, `Scope`, `Data.TaggedError` throughout.
- Use `Bun.test` / `import { test, expect } from "bun:test"` for tests.
- Always `import type` for type-only imports (`verbatimModuleSyntax`).
- Don't use `dotenv` — Bun loads `.env` automatically.

## Tooling

- **Fallow MCP** is configured via `opencode.json` (`bunx fallow-mcp`). The `.fallowrc.json` entry covers `index.ts`, `src/`, and `examples/`. Run `fallow audit` for pre-commit quality checks on changed code.

## Referencing upstream libraries

Shallow clones of key dependencies live in `references/` for offline browsing (gitignored; re-clone if stale):

| Reference | Local path | Useful subdirectory |
|-----------|-----------|-------------------|
| effect | `references/effect` | `packages/effect/src/` for core types |
| modbus-rs | `references/modbus-rs` | `mbus-ffi/javascript/` — unified native+WASM npm package (`index.d.ts`/`index.browser.d.ts`/`index.web.d.ts` for types, `index.js`/`index.browser.js`/`index.web.js` for impl). For the WASM API specifically, `mbus-ffi/src/wasm/**` (Rust source) is current-truth — `documentation/wasm_bindings.md` and `documentation/client/wasm.md` describe an older, now-changed API (`WasmModbusClient`/`WasmTcpTransport`/snake_case methods) and should not be trusted without cross-checking the Rust source. |

The skill at `.opencode/skills/reference-dependencies/SKILL.md` is the dedicated instruction for reference lookup.

## WASM/browser support

- `modbus-rs`'s WASM build is published separately as `modbus-rs-wasm` and re-exported under `modbus-rs`'s `./web` subpath (`import ... from "modbus-rs/web"`). Type-only imports for `Wasm*` symbols must use that subpath, not the bare `"modbus-rs"` specifier — this project's `tsconfig.json` has no `customConditions`, so bare imports always resolve to the native (`default`) condition regardless of what environment the code will actually run in.
- **`modbus-rs-wasm@0.15.4` is currently broken on npm** (the published tarball is missing all `.wasm`/`.js` build output — confirmed by downloading it directly). `src/modbus-rs-web.d.ts` is a hand-written, TEMPORARY ambient type shim covering the surface this package uses, derived directly from the Rust source since there's no generated `.d.ts` to import from anywhere (not on npm, not checked into the upstream repo). Delete it once upstream republishes a working build.
- Two response shapes in that shim (`readFifoQueue`, `readDeviceIdentification`) are best-effort — the upstream JSDoc-declared return type and the actual Rust serialization code (`mbus-ffi/src/wasm/client/response.rs`) disagree with each other. `src/modbus-client.ts`'s `makeWasmEffectModbusClient` normalizes the gaps; re-verify against a real build once one exists.
- The same dynamic `import("modbus-rs")` pattern used everywhere in this codebase resolves to the WASM build automatically for downstream consumers bundling for a browser target (via `modbus-rs`'s own conditional exports) — no changes to this package's own build/exports were needed for that part.
