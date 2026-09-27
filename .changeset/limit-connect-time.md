---
'@flux-control/effect-modbus-rs': minor
---

Add the `connectTimeout` transport option. It limits how long each operation waits for an open or a reconnect.

The `modbus-rs` bindings do not limit the connect time. A TCP connect to a host that does not answer waits until the operating system stops it. Before this change, every operation waited for that pending connect, and a caller-side `Effect.timeout` did not release it.

When the limit expires, the operation fails with `ModbusTimeoutError`. The native connect continues, and later operations wait for it again, each for at most the limit. A transport never has more than one pending native connect. When the native connect succeeds later, the transport uses it. When it fails, the next operation starts a new connect.

The option applies to every transport. It is unbounded by default, so existing behavior does not change.
