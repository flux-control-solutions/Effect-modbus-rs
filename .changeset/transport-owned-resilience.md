---
'@flux-control/effect-modbus-rs': minor
---

Move retry policies and reconnection to the transport layer.

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
