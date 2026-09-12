# @flux-control/effect-modbus-rs

## 0.5.0

### Minor Changes

- c2c1a78: Add an optional batching client for register operations. The existing client remains available as a low-level, full-control option.

  ## Low-level full-control client

  `transport.withClient(unitId)` continues to return an `EffectModbusClient`. This client exposes all standard Modbus operations and issues the exact transaction that the caller specifies.

  Use this client for these operations:

  - Issue exact register transactions with caller-selected addresses and quantities.
  - Read and write coils.
  - Read discrete inputs.
  - Access diagnostics and file records.
  - Control transaction schedules and groups directly.

  The batching client does not replace this API. Both clients use the same transport connection.

  For a unit that uses batching, the low-level client still supports reads, coils, diagnostics, file records, and other non-register-write operations. The transport rejects raw FC06, FC16, and FC23 writes for that unit. Without this block, the writes can bypass a pending batch or its cache.

  ## Batching client

  `transport.withBatchingClient(unitId, options)` declares a `BatchingModbusClient` for one unit. Other callers get that client with `transport.batchingClient(unitId)`.

  The batching client provides these features:

  - `write`, `writeNow`, `writeAll`, and `writeAllNow` pack adjacent writes into FC06 or FC16 transactions.
  - `read`, `readNow`, `readAll`, and `readAllNow` pack holding-register reads into FC03 spans.
  - The `inputs` reader provides the same read operations for input registers with FC04.
  - Optional write and read windows collect operations that arrive at different times.
  - The write cache removes writes when the device already contains the value.
  - Device-specific planner limits control the maximum transaction size and permitted gaps between reads.
  - Each caller receives the result of its own operation. This rule also applies when operations share one transaction.

  Debounce windows are disabled by default. Group methods still plan one caller group without a debounce window.

  The write window restarts after each new write. `maxHold` limits the total delay for a continuous stream of writes.

  The read window starts with the first request and does not restart. Thus, later readers cannot continuously delay the batch.

  The cache records acknowledged writes by unit and address. It does not answer reads.

  A failed write invalidates the cache for that unit. A lost connection invalidates all cache entries.

  Each unit has one batching client, one cache view, and one set of options. A second declaration for the same unit fails with `ModbusInvalidArgumentError`.

  ## Operation and lifecycle details

  `BatchingModbusClient` does not extend `ModbusOperations`. This separation prevents register writes from bypassing the batch order and cache.

  `writeNow` and `writeAllNow` join the pending batch and flush it immediately. A newer write for the same address replaces the older value.

  `client.onShutdown(action)` registers a device-specific action for scope shutdown. The action runs while the transport is open and before the client closes.

  The client emits `modbus.write` and `modbus.read` spans. These spans include unit IDs, register counts, suppressed-write counts, and transaction counts.

  ## Standalone batching components

  The batching components are also public APIs:

  - `planWrites` and `planReads` provide pure transaction plans without state or I/O.
  - `createWriteDebouncer` and `createReadDebouncer` collect operations for caller-supplied flush functions.
  - `createRegisterCache` tracks acknowledged register values.
  - `makeBatchingClient` creates a batching client over an `EffectModbusClient`.
  - `createBatchingRegistry` adds per-unit declarations and connection-state cache invalidation to a custom transport.

## 0.4.1

### Patch Changes

- 2ec3fc7: Regenerate `bun.lock` as a standalone package, and add `bun run lock` to keep
  it that way. The lockfile is resolved in an isolated directory, so it records
  registry versions even when this repo is checked out inside a bun workspace,
  where an ordinary install writes only the workspace root's lockfile. A
  pre-commit check now refuses a dependency change that leaves the lockfile
  behind.

  No published code changes: the lockfile is not part of the package.

## 0.4.0

### Minor Changes

- 4850399: Migrate to Effect v4 (`4.0.0-rc.109`).

  **This is a breaking change.** Effect v3 and v4 do not interoperate, so consumers
  must move to v4 in the same step. Effect v4 is still a release candidate.

  **Peer dependency:** `effect` is now `^4.0.0-rc.109` (was `^3.22.0`).
  `@effect/platform-bun` moves to the matching `^4.0.0-rc.109`.

  **Transports are `Context.Service` instead of `Effect.Service`.** v4 does not
  auto-generate a layer from the service constructor, so each transport now builds
  its layer explicitly. `SerialTransportService` and `WasmSerialTransportService`
  move from `Context.Tag` to `Context.Service`.

  **`Default` is renamed to `make`.** The v3 auto-generated `Default` layer
  accessor is gone; the equivalent is now a hand-written static:

  ```ts
  // before
  Effect.provide(TcpTransportService.Default({ host: "127.0.0.1", port: 502 }));
  // after
  Effect.provide(TcpTransportService.make({ host: "127.0.0.1", port: 502 }));
  ```

  The underlying scoped constructor effect is exposed as `makeScoped(options)` if
  you need to wire a layer yourself. The `fromAscii` / `fromRtu` and mock helpers
  are unchanged.

  **Retry policy schedules were rebuilt on the v4 `Schedule` API.**
  `Schedule.intersect` + `Schedule.identity` are gone; v4 exposes the failing
  error and the attempt counter on the schedule metadata instead. Backoff timing
  is unchanged — note that `metadata.attempt` is 1-based where v3's `retryIndex`
  was 0-based.

  `ModbusRetryPolicy.schedule` is now `Schedule.Schedule<number, ModbusError>`
  (was `Schedule.Schedule<[number, ModbusError], ModbusError>`); the output no
  longer needs to carry the error, since metadata does.

  `jitter: true` now uses `Schedule.jittered` (the same fixed 0.8–1.2 range v3
  defaulted to). Custom `{ min, max }` bounds are applied by scaling the delay
  directly, as `Schedule.jitteredWith` no longer exists.

  **Other renames visible to consumers:**

  - `Effect.either` → `Effect.result`; `Either` → `Result`
    (`Result.isFailure` / `.failure`, `Result.isSuccess` / `.success`).
  - `Effect.catchAll` → `Effect.catch`, `Effect.fork` → `Effect.forkChild`,
    `Effect.forkDaemon` → `Effect.forkDetach`, `Effect.zipRight` →
    `Effect.andThen`.
  - `Duration.DurationInput` → `Duration.Input`.
  - `SubscriptionRef` is no longer an `Effect` subtype, so reading a transport's
    `connectionState` needs `SubscriptionRef.get(...)` rather than a bare
    `yield*`.

## 0.3.1

### Patch Changes

- db422da: Widen the options of the two abstract serial tags to agree with the concrete tags.

  `SerialTransportService.makeMockTransport` did not accept `MockFaultOptions`.
  `WasmSerialTransportService.makeMockTransport` accepted neither `MockFaultOptions`
  nor `TransportResilienceOptions`. The mock factory honors all of these options at
  runtime, but a caller that used one of these two tags could not give them by name.

  `WasmSerialTransportService.fromAscii` and `WasmSerialTransportService.fromRtu` had
  the same problem: they omitted `TransportResilienceOptions`, although the concrete
  browser services accept `retry` and `reconnect`. The native `SerialTransportService`
  providers already accepted them.

  A consumer that does not select RTU framing or ASCII framing uses these abstract
  tags. Before this release, that consumer could not drive a retry or a circuit
  transition in a test without a cast. Now the abstract tags accept the same options
  as the concrete tags:

  ```ts
  SerialTransportService.makeMockTransport(devices)({
    portPath: "mock",
    baudRate: 9600,
    retry: RetryPolicies.serial(),
    fault: () =>
      new ModbusTimeoutError({
        message: "timeout",
        cause: new Error("timeout"),
      }),
  });
  ```

  This change adds to the types only. There is no runtime change, and no existing
  call becomes a type error. `src/mock-options.test.ts` holds a compile-time
  assertion that each of the eight `makeMockTransport` statics accepts `retry`,
  `reconnect`, `fault`, and `reconnectFault`. This test stops the same divergence
  in the future.

## 0.3.0

### Minor Changes

- b2047e6: Add opt-in retry policies with exponential backoff, jitter, and per-error rules.

  `makeRetryPolicy` and the `RetryPolicies` templates (`none`, `serial`, `tcp`, `persistent`) build error-aware Effect `Schedule`s: transient failures (timeouts, framing errors, `SERVER_DEVICE_BUSY` and gateway exception codes) back off exponentially with jitter, while deterministic ones (illegal data address, invalid argument) fail immediately. Apply one with `retryModbus(policy)`, or `retryModbusWithReconnect(transport, policy)` to reconnect the transport before retrying connection-level failures.

  Default behaviour is unchanged — operations remain single-shot unless a policy is explicitly applied.

- 4402c51: Move retry policies and reconnection to the transport layer.

  Resilience is now configured where a transport is created and applies to every client derived from it, instead of being wired in at each call site:

  ```ts
  TcpTransportService.Default({
    host,
    port,
    retry: RetryPolicies.tcp(), // applied to every operation
    reconnect: {}, // supervised reconnect + circuit breaker
  });
  ```

  - **Per-client and per-operation overrides** — `withClient(unitId, { retry })` and `client.withRetry(policy)` _replace_ the policy rather than composing with it, so overrides cannot multiply attempt counts. One bus can host device types with different logic.
  - **Supervised reconnection** — a single fiber owned by the transport re-establishes the link, however many callers were in flight. Reconnection is no longer a call-site activity.
  - **Circuit breaker** — while the link is down, operations are refused with the new `ModbusCircuitOpenError` instead of queueing onto a dead bus. Retryable by default, so a policy with budget rides out the outage at no cost on the wire.
  - **Observable connection state** — `transport.connectionState` publishes `Disconnected` / `Connected` / `Reconnecting` / `Down`.
  - **Mock fault injection** — `fault` on a mock transport fails individual attempts, so policies and breaker behaviour can be tested without hardware.

  `retryModbusWithReconnect` is removed; it never shipped in a release. `retryModbus` remains for retrying a compound operation as a unit. Defaults are unchanged: with neither option set, a transport behaves exactly as before.

- b340838: Remove `modbus-rs`'s transport-level retry options from every transport constructor.

  `retryAttempts`, `retryDelayMs`, and `retryBackoffStrategy` are no longer accepted by `RtuTransportService`, `AsciiTransportService`, `TcpTransportService`, `SerialTransportService`, or any `makeMockTransport`. Passing one is now a type error rather than a documented hazard.

  They were withheld because enabling them was never correct under transport-owned resilience:

  - **They retry below the Effect boundary.** A failure they papered over never reached the retry policy, the circuit breaker, or the logs — the caller saw one slow success instead of several failures and a recovery, and any caller-side `Effect.timeout` was measuring inflated time.
  - **They reconnect.** Upstream re-established the link inline and replayed in-flight requests after it, racing the single supervisor fiber that owns reconnection for the transport.
  - **They multiply.** Neither layer knew about the other, so attempt counts compounded and the two backoff curves interleaved.
  - **`retryDelayMs` is flat and unjittered** — the lockstep-collision pattern `RetryPolicies.serial()` exists to break up.
  - **`retryBackoffStrategy` is inert upstream**, documented as reserved for future implementation, so `'exponential'` silently produced a flat delay.

  Use `retry` and `reconnect` on the transport instead. Callers who genuinely need frame-level resends can construct a raw `modbus-rs` client directly.

  The narrowed option types are exported as `RtuTransportOpenOptions`, `AsciiTransportOpenOptions`, and `TcpTransportOpenOptions`, alongside the generic `WithoutUpstreamRetry<T>` and the `UpstreamRetryOptionKey` union.

  `SerialTransportService.fromRtu`, `.fromAscii`, and `.makeMockTransport` now also accept `retry` and `reconnect`, which they previously did not — without this, the abstract serial tag would have had no resilience knob at all.

  Anyone currently setting these options was running two independent retry layers; the fix is to drop them and express the intent in a `RetryPolicies` template.

### Patch Changes

- 2b1b913: Coalesce concurrent transport connects and reconnects with `Deferred` instead of memoized promises.

  Fixes three behaviours around concurrent `reconnect()` / first `withClient()` calls:

  - A reconnect that completed after the transport was torn down reported success and left the reopened handle unclosed; it now fails with `ModbusNotConnectedError` and closes the orphaned handle.
  - A connection that completed after every waiting fiber was interrupted was never closed on scope teardown.
  - Waiters on a failed reconnect each converted the rejection separately; they now share one error.

  Also removes a narrow race where a caller could observe a spurious `ModbusInternalError` from a reconnect that had actually succeeded.

## 0.2.0

### Minor Changes

- f2e388a: bump deps, notably modbus-rs, which introduced some breaking type changes
- b0b2652: Add browser (WASM) support: `WasmWsTransportService`, `WasmRtuTransportService`, `WasmAsciiTransportService`, and their abstract `WasmSerialTransportService` tag, plus experimental `wasmWsServerLayer` / `wasmSerialRtuServerLayer` / `wasmSerialAsciiServerLayer` server layers and the `requestSerialPort()` Web Serial helper. Includes a runnable Vite example app under `examples/wasm/`. Blocked on upstream `modbus-rs-wasm@0.15.4` being published without its `.wasm`/JS glue, so real browser testing is still pending.

### Patch Changes

- 9a5daaf: Update the browser integration for `modbus-rs@0.16.1`, which restores runtime export compatibility for the `modbus-rs/web` WASM module. API documentation generation now uses a TypeScript 6 toolchain compatible with TypeDoc.
