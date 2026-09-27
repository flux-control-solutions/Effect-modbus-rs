---
'@flux-control/effect-modbus-rs': minor
---

Add the `connectTimeout` transport option. It limits the time of each open and each reconnect.

The `modbus-rs` bindings do not limit the connect time. A TCP connect to a host that does not answer waits until the operating system stops it. Before this change, every operation joined that pending connect, and a caller-side `Effect.timeout` did not release it.

When the limit expires, the open or reconnect fails with `ModbusTimeoutError`. The next operation starts a new connect. If a timed-out open completes later, the transport closes that handle. A later reconnect waits for a native reconnect that still runs on the same handle.

The option applies to every transport. It is unbounded by default, so existing behavior does not change.
