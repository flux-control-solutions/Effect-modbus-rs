---
'@flux-control/effect-modbus-rs': patch
---

Coalesce concurrent transport connects and reconnects with `Deferred` instead of memoized promises.

Fixes three behaviours around concurrent `reconnect()` / first `withClient()` calls:

- A reconnect that completed after the transport was torn down reported success and left the reopened handle unclosed; it now fails with `ModbusNotConnectedError` and closes the orphaned handle.
- A connection that completed after every waiting fiber was interrupted was never closed on scope teardown.
- Waiters on a failed reconnect each converted the rejection separately; they now share one error.

Also removes a narrow race where a caller could observe a spurious `ModbusInternalError` from a reconnect that had actually succeeded.
