---
'@flux-control/effect-modbus-rs': minor
---

Move to `effect` 4.0.0-rc.118. The `effect` peer dependency is now `^4.0.0-rc.118`.

`close()` now takes the scope to close as an argument. It closes that scope, then closes the transport. In `effect` 4.0.0-rc.118, `Scope.close` accepts only a `Scope.Closeable`, and the scope from `Effect.scope` is not closeable. Before this change, `close()` closed the scope that the caller provided in its context.

To migrate, replace `Scope.provide(transport.close(), scope)` with `transport.close(scope)`.
