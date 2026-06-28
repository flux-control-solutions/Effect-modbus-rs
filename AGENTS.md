# effect-modbus-rs

Type-safe Modbus communication via Effect-TS, wrapping the `modbus-rs` npm bindings (Rust napi-rs under the hood).

## Stack

- **Runtime**: Bun only — never use Node, npm, pnpm, yarn, or vite.
- **Language**: TypeScript 6 (ESNext, `verbatimModuleSyntax`, bundler resolution, `module: "Preserve"`).
- **Core libs**: `effect` (^3.21.4), `modbus-rs` (^0.15.2).
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
  modbus-client.ts           — EffectModbusClient interface + Effect.tryPromise wrapper
  mocks.ts                   — Schema-validated mock transport for testing
  shared-transport.ts        — Generic scoped transport lifecycle management
  RtuTransportService.ts     — Scoped Effect.Service wrapping AsyncRtuTransport
  TcpTransportService.ts     — Scoped Effect.Service wrapping AsyncTcpTransport
  AsciiTransportService.ts   — Scoped Effect.Service wrapping AsyncAsciiTransport
examples/
  rtu-basic.ts               — RTU usage: provide, scoped, runPromise
  tcp-basic.ts               — TCP usage pattern
  ascii-basic.ts             — ASCII usage pattern
  rtu-mock.ts                — RTU with in-memory mock
  tcp-mock.ts                — TCP with in-memory mock (multi-device)
  ascii-mock.ts              — ASCII with in-memory mock (error-case)
  tcp-polling-stream.ts      — TCP polling, reconnect, and stream
  tcp-finalizer-reset.ts     — TCP scope finalizer reset demo
```

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
| modbus-rs | `references/modbus-rs` | `mbus-ffi/nodejs/` (`index.d.ts` for types, `index.js` for impl) |

The skill at `.opencode/skills/reference-dependencies/SKILL.md` is the dedicated instruction for reference lookup.
