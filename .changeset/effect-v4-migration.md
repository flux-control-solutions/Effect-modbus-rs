---
'@flux-control/effect-modbus-rs': minor
---

Migrate to Effect v4 (`4.0.0-rc.109`).

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
Effect.provide(TcpTransportService.Default({ host: '127.0.0.1', port: 502 }));
// after
Effect.provide(TcpTransportService.make({ host: '127.0.0.1', port: 502 }));
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
