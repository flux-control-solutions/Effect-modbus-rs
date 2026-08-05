---
'@flux-control/effect-modbus-rs': minor
---

Remove `modbus-rs`'s transport-level retry options from every transport constructor.

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
