# @flux-control/effect-modbus-rs

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
