---
'@flux-control/effect-modbus-rs': minor
---

Add opt-in retry policies with exponential backoff, jitter, and per-error rules.

`makeRetryPolicy` and the `RetryPolicies` templates (`none`, `serial`, `tcp`, `persistent`) build error-aware Effect `Schedule`s: transient failures (timeouts, framing errors, `SERVER_DEVICE_BUSY` and gateway exception codes) back off exponentially with jitter, while deterministic ones (illegal data address, invalid argument) fail immediately. Apply one with `retryModbus(policy)`, or `retryModbusWithReconnect(transport, policy)` to reconnect the transport before retrying connection-level failures.

Default behaviour is unchanged — operations remain single-shot unless a policy is explicitly applied.
