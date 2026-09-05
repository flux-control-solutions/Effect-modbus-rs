# effect-modbus-rs

Type-safe Modbus communication via Effect-TS, wrapping the `modbus-rs` npm bindings (Rust napi-rs under the hood).

## Stack

- **Runtime**: Bun only — never use Node, npm, pnpm, yarn, or vite.
- **Language**: TypeScript 6 (ESNext, `verbatimModuleSyntax`, bundler resolution, `module: "Preserve"`).
- **Core libs**: `effect` (^4.0.0-rc.109), `modbus-rs` (^0.15.6). Effect v4 is still a release candidate.
- **LSP**: `@effect/language-service` plugin in `tsconfig.json` `compilerOptions.plugins`.
- **License**: GPL-3.0.

## Commands

| Action      | Command                               |
| ----------- | ------------------------------------- |
| Install     | `bun install`                         |
| Type-check  | `bun run typecheck`                   |
| Test        | `bun run test` (create under `test/`) |
| Run example | `bun run examples/<name>.ts`          |

No build step — `noEmit` is on; Bun runs `.ts` directly.

## Source layout

```
index.ts                     — Re-exports all public API from src/
src/
  errors.ts                  — Data.TaggedError types + toModbusError converter
  modbus-client.ts           — EffectModbusClient interface + Effect.tryPromise wrapper (native + WASM factories)
  mocks.ts                   — Schema-validated mock transport for testing
  connection.ts              — Connection state machine, reconnect supervisor, circuit breaker
  retry.ts                   — Opt-in retry policies (backoff, jitter, per-error rules)
  shared-transport.ts        — Generic scoped transport lifecycle management, WithoutUpstreamRetry
  register-plan.ts           — planWrites / planReads: pure transaction packing (L0)
  register-cache.ts          — createRegisterCache: what each device already holds (L1)
  write-debouncer.ts         — createWriteDebouncer: coalesces writes that arrive separately (L1)
  read-debouncer.ts          — createReadDebouncer: collects reads that arrive separately (L1)
  span-attributes.ts         — ModbusSpanAttributes and the merge rule for a batch
  batching-client.ts         — BatchingModbusClient + the per-transport registry (L2)
  RtuTransportService.ts     — Scoped Context.Service wrapping AsyncRtuTransport
  TcpTransportService.ts     — Scoped Context.Service wrapping AsyncTcpTransport
  AsciiTransportService.ts   — Scoped Context.Service wrapping AsyncAsciiTransport
  WasmSerialPort.ts          — requestSerialPort() Effect helper (user-gesture gated, Web Serial API)
  WasmWsTransportService.ts  — Scoped Context.Service wrapping WasmWsTransport (browser, TCP over WebSocket gateway)
  WasmRtuTransportService.ts — Scoped Context.Service wrapping WasmRtuTransport (browser, Web Serial RTU)
  WasmAsciiTransportService.ts — Scoped Context.Service wrapping WasmAsciiTransport (browser, Web Serial ASCII)
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
  retry-policies.ts          — Retry policies: backoff, jitter, per-error rules
  batching.ts                — Transaction batching: planners, windows, cache, spans
  tcp-polling-stream.ts      — TCP polling, reconnect, and stream
  tcp-finalizer-reset.ts     — TCP scope finalizer reset demo
  tcp-server.ts              — TCP server example
  serial-server.ts           — Serial RTU server example
  wasm/                      — Standalone runnable Vite app exercising the browser transports (own README, own npm project — see below)
test/                         — Bun tests for the public source modules
```

`examples/wasm/` is its own npm project (package.json, tsconfig.json, vite.config.ts) — a real Vite app, not Bun-run `.ts`, since it needs an actual browser bundler to exercise the WASM transports. It links back to this package via `"effect-modbus-rs": "file:../.."`. The root `tsconfig.json` excludes it (`examples/wasm`) since it has its own DOM-aware tsconfig; the root `bun run test`/`typecheck` scripts don't touch it. Run it with `cd examples/wasm && npm install && npm run dev` — see its README for the current known-limitation caveat.

## Architecture

- **`Context.Service` scoped** — each transport service opens its connection in a scoped `makeScoped` constructor effect, wrapped by an explicit `make(options)` layer factory (v4 no longer auto-generates one — this replaces v3's `Default`). The transport is automatically closed when the consuming `Scope` finalizes (`Effect.addFinalizer`).
- **Dynamic import** — `modbus-rs` is imported inside the constructor via `yield* Effect.promise(() => import("modbus-rs"))`. This keeps the native module load deferred.
- **Client caching** — clients are created per `unitId` via `transport.createClient({ unitId })` and cached in a `Map<number, Async*ModbusClient>`. Repeated `withClient()` calls for the same unit ID reuse the cached client.
- **`EffectModbusClient`** — wraps the raw `modbus-rs` client methods via `Effect.tryPromise`, routing errors through `toModbusError`. All methods return `Effect.Effect<T, ModbusError>`.
- **Error mapping** — raw `Error` → typed `ModbusError` union via `toModbusError` in `src/errors.ts`. Handle with `Effect.catchTags` (see examples).
- **Resilience is transport-owned** — `src/retry.ts` builds error-aware `Schedule`s (exponential + jitter, per-error curves, shared attempt budget); `src/connection.ts` owns the connection state machine, the supervised reconnect, and the circuit breaker. A transport takes `retry` and `reconnect` options and applies them to every client it hands out (`withResilience` in `src/modbus-client.ts`). Overrides at `withClient(unitId, { retry })` and `client.withRetry(policy)` **replace** the policy — never compose — so attempt counts cannot multiply (`clientOptions?.retry ?? transportRetry`; `withRetry` rebuilds from the raw `operations`). `retryModbus(policy)` is the exception and **wraps**: piped around an already-policied client the two nest and multiply (measured 3 × 4 = 12), so it belongs only over a `RetryPolicies.none()` client, driving a compound operation as a unit. Reconnection is never a call-site activity: one supervisor fiber per transport, not one per failing caller (see issue #3 and PR #10's review).
- **Nothing retries or reconnects implicitly** — both options default to off. Predictable default timing is a deliberate design decision. Jitter, however, is on by default _within_ a policy.
- **This layer owns retry exclusively** — `modbus-rs`'s transport-level `retryAttempts`/`retryDelayMs`/`retryBackoffStrategy` are stripped from every transport constructor via `WithoutUpstreamRetry<T>` (`src/shared-transport.ts`), surfacing as the exported `RtuTransportOpenOptions`/`AsciiTransportOpenOptions`/`TcpTransportOpenOptions`. They retry beneath the Effect boundary (invisible to the policy, the circuit breaker, and the logs), reconnect inline (racing the supervisor fiber), and multiply attempt counts; `retryBackoffStrategy` is inert upstream regardless. `Omit` fails open, so `src/upstream-options.test.ts` holds compile-time assertions that the keys still exist upstream and are gone from what we expose — if an upstream rename ever voids the `Omit`, `bun run typecheck` fails. Do not re-expose these; the escape hatch is a raw `modbus-rs` client.
- **Transaction batching is three layers, each usable alone** — `register-plan.ts` is pure (no Effect, no state); `register-cache.ts` / `write-debouncer.ts` / `read-debouncer.ts` are the stateful middle; `batching-client.ts` composes them into `transport.withBatchingClient(unitId, options)`. `withClient` issues the transaction the caller names until batching is selected for that unit. **`BatchingModbusClient` must never extend `ModbusOperations`**: a raw register write goes around the debouncer and the cache, and a held value can then land after a newer one written past it. Once a batching client exists, raw FC06, FC16, and FC23 operations for that unit are guarded; raw reads, coils, and other non-register-write operations remain available. Coils are out of batching: the planners pack registers.
- **Debouncing is opt-in, like retry and reconnect** — both windows default to zero, and a zero window is a real bypass rather than a zero sleep, so a harness that settles by yielding rather than by advancing a clock still reaches a flush. `writeAll` / `readAll` plan without a window, since a caller holding a group needs a planner and not a collection point.
- **The write cache belongs to the transport, and watches `connectionState`** — it is a belief about a physical device and there is one physical device, so two caches on one unit disagree. It invalidates a unit after a failed write and everything when the link leaves `Connected`. Cache and watcher are both created on first `withBatchingClient` call, so a transport nobody batches on carries neither. It compares in the encoding that reaches the wire (`encodeRegisterValue`): `-1` and `65535` are the same register contents, and a comparison that says otherwise rewrites forever.
- **A batching client is cached per unit ID and its options are fixed by the first call** — two batching clients on one unit hold two batches and coalesce neither. A second call with a different configuration fails with `ModbusInvalidArgumentError` rather than quietly handing back something else.
- **`modbus.write` opens after the cache filter, and only when a write survives it** — the span records what reached the bus, not what a caller proposed. Caller attributes are opaque and applied first; the `modbus.*` keys are applied last and win a collision. A repeated key across a batch is joined with a comma (`mergeSpanAttributes`), because a batch carries several callers' vocabulary and none of them should silently lose.
- **`makeMockTransport`** — each service has a static `makeMockTransport(devices)` that returns a `Layer` using an in-memory mock. Takes `SlaveDeviceDefinitions` (array of `SlaveDeviceDefinition` with Schema-validated coils, discrete inputs, holding/input registers per unitId).

## Conventions

- Follow `effect` v4 idioms: `Effect`, `Layer`, `Context.Service`, `Schema`, `Scope`, `Data.TaggedError` throughout.
- `Either` is `Result` in v4 (`Effect.result`, `Result.isFailure`); `Effect.catchAll` is `Effect.catch`; `Effect.fork` is `Effect.forkChild`.
- Use `Bun.test` / `import { test, expect } from "bun:test"` for tests.
- Always `import type` for type-only imports (`verbatimModuleSyntax`).
- Don't use `dotenv` — Bun loads `.env` automatically.

## Tooling

- **Fallow MCP** is configured via `opencode.json` (`bunx fallow-mcp`). The `.fallowrc.json` entry covers `index.ts`, `src/`, and `examples/`. Run `fallow audit` for pre-commit quality checks on changed code.
- **`CHANGELOG.md` is in `ignorePatterns` in `.oxfmtrc.json`.** Do not remove it. `changeset version` writes this file and formats it with its own bundled prettier, which uses double quotes in fenced code blocks. `oxfmt` uses `singleQuote`. Thus the two formatters disagree about each changeset that contains a string literal. The husky pre-commit hook runs `bun run format`, so that disagreement stopped the "Version Packages" commit and the release with it (run 31605534234). The release job also sets `HUSKY: '0'`, because the workflow steps are already the gate there.

## Referencing upstream libraries

Shallow clones of key dependencies live in `references/` for offline browsing (gitignored; re-clone if stale):

| Reference | Local path             | Useful subdirectory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| effect    | `references/effect`    | `packages/effect/src/` for core types                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| modbus-rs | `references/modbus-rs` | `mbus-ffi/javascript/` — unified native+WASM npm package (`index.d.ts`/`index.browser.d.ts`/`index.web.d.ts` for types, `index.js`/`index.browser.js`/`index.web.js` for impl). For the WASM API specifically, `mbus-ffi/src/wasm/**` (Rust source) is current-truth — `documentation/wasm_bindings.md` and `documentation/client/wasm.md` describe an older, now-changed API (`WasmModbusClient`/`WasmTcpTransport`/snake_case methods) and should not be trusted without cross-checking the Rust source. |

The skill at `.opencode/skills/reference-dependencies/SKILL.md` is the dedicated instruction for reference lookup.

## WASM/browser support

- `modbus-rs`'s WASM build is published separately as `modbus-rs-wasm` and re-exported under `modbus-rs`'s `./web` subpath (`import ... from "modbus-rs/web"`). Type-only imports for `Wasm*` symbols must use that subpath, not the bare `"modbus-rs"` specifier — this project's `tsconfig.json` has no `customConditions`, so bare imports always resolve to the native (`default`) condition regardless of what environment the code will actually run in.
- **`modbus-rs@0.15.6` ships a WASM build whose `.d.ts` does not match its JS.** The ambient shim that used to paper over this (`src/modbus-rs-web.d.ts`) was deleted in `d4a0cc6`; the WASM services now type against the real published `.d.ts` and fail loudly where upstream is wrong. Two known mismatches, both caused by upstream marking its WASM API `#[wasm_bindgen(skip_typescript)]` and hand-writing declarations in a `typescript_custom_section` that drifts from the generated JS:
  - `ModbusErrorCode` is **declared but not exported** (`mbus-ffi/src/wasm/error_codes.rs` declares it inside an `extern "C"` + `inline_js` block, which is an _import_, so wasm-bindgen emits it to `snippets/` and never re-exports it). This breaks `src/errors.ts` in any browser bundle. Diagnose with `examples/wasm`'s `/export-check.html`.
  - `WasmRtuTransport`/`WasmAsciiTransport` are **missing `setRequestTimeout`/`clearRequestTimeout`/`reconnect` from the `.d.ts`** although `modbus-rs_bg.js` defines all three. This is the source of the two standing `bun run typecheck` errors.
- Two response shapes in that shim (`readFifoQueue`, `readDeviceIdentification`) are best-effort — the upstream JSDoc-declared return type and the actual Rust serialization code (`mbus-ffi/src/wasm/client/response.rs`) disagree with each other. `src/modbus-client.ts`'s `makeWasmEffectModbusClient` normalizes the gaps; re-verify against a real build once one exists.
- The same dynamic `import("modbus-rs")` pattern used everywhere in this codebase resolves to the WASM build automatically for downstream consumers bundling for a browser target (via `modbus-rs`'s own conditional exports) — no changes to this package's own build/exports were needed for that part.
