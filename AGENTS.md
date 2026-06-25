# effect-modbus-rs

Type-safe Modbus communication via Effect-TS, wrapping the `modbus-rs` npm bindings (Rust napi-rs under the hood).

## Stack

- **Runtime**: Bun only — never use Node, npm, pnpm, yarn, or vite.
- **Language**: TypeScript 6 (ESNext target, `verbatimModuleSyntax`, bundler module resolution, `module: "Preserve"` for Bun).
- **Core libs**: `effect` (^3.21.4), `modbus-rs` (^0.15.0).
- **LSP**: `@effect/language-service` plugin configured in `tsconfig.json` `compilerOptions.plugins`.
- **License**: GPL-3.0.

## Commands

| Action | Command |
|--------|---------|
| Install | `bun install` |
| Run | `bun run index.ts` |
| Type-check | `bunx tsc --noEmit` |
| Test | `bun test` (create under `**/*.test.ts`) |

No build step — `noEmit` is on; Bun runs `.ts` directly.

## Source layout

```
src/
  errors.ts                  — Data.TaggedError types + toModbusError converter
  RtuTransportService.ts     — Scoped Effect.Service wrapping AsyncRtuTransport
examples/
  rtu-basic.ts               — Usage pattern: provide, scoped, runPromise
index.ts                     — Stub entry point
```

## Architecture

- `RtuTransportService` uses `Effect.Service` (scoped) with `Effect.fnUntraced`. The `modbus-rs` module is imported **dynamically** inside the service constructor: `yield* Effect.promise(() => import("modbus-rs"))`.
- RTU transport is opened via `AsyncRtuTransport.open(options)`, then clients are created per `unitId` via `transport.createClient({ unitId })` and cached in a `Map`.
- The service exposes `withClient(unitId)`, `setRequestTimeout`, `clearRequestTimeout`, `reconnect`, and `hasPendingRequests`.
- Client methods (`readHoldingRegisters`, `readCoils`, etc.) return `Effect.Effect<T, ModbusError>` via `Effect.tryPromise`.
- Error mapping: raw `Error` → typed `ModbusError` union via `toModbusError` in `src/errors.ts`. Handle with `Effect.catchTags` (see example).
- Upcoming: TCP transport and higher-level register/coil abstractions.

## Conventions

- Follow `effect` idioms: `Effect`, `Layer`, `Schema`, `Scope`, `Data.TaggedError` throughout.
- Use `Bun.test` / `import { test, expect } from "bun:test"` for tests.
- Always `import type` for type-only imports (`verbatimModuleSyntax`).
- Don't use `dotenv` — Bun loads `.env` automatically.

## Referencing upstream libraries

Shallow clones of key dependencies live in `references/` for offline browsing. These are gitignored — re-clone if stale.

| Reference | Local path | Useful subdirectory |
|-----------|-----------|-------------------|
| effect | `references/effect` | `packages/effect/src/` for core types |
| modbus-rs | `references/modbus-rs` | `mbus-ffi/nodejs/` (`index.d.ts` for types, `index.js` for impl) |

When researching how to use a type/fn from either library, read the corresponding clone. For modbus-rs specifically, the npm-facing source is under `references/modbus-rs/mbus-ffi/nodejs`.

The skill at `.opencode/skills/reference-dependencies/SKILL.md` is the dedicated instruction for reference lookup — it should be loaded automatically by OpenCode for tasks involving `effect`, `@effect/*`, or `modbus-rs` types.
