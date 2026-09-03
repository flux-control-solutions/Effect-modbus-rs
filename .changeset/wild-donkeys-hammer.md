---
'@flux-control/effect-modbus-rs': minor
---

Add transaction batching: register planners, a write cache, debouncers, and `transport.withBatchingClient`.

A caller that derives each register independently — one fiber per output, one accessor per parameter — issues one transaction per register. On a half-duplex multi-drop bus that is the dominant cost, and the registers such a caller wants are usually neighbours. Three new layers bring the count down, and each one is usable without the layer above it.

**`planWrites` and `planReads`** (`src/register-plan.ts`) are pure. `planWrites` sorts writes by address, groups contiguous addresses into runs, splits each run at the FC16 limit, and emits FC06 for a run shorter than `minRunLength`. `planReads` merges addresses into spans within `maxGap` unrequested registers of each other and returns a `locate` index back into the responses. Both accept the device's own limits, because many devices stop short of what the specification allows.

**`makeWriteDebouncer`, `makeReadDebouncer`, and `makeRegisterCache`** are the collection point a planner needs. A caller that never holds two values at once gives a planner nothing to pack, so these collect on time instead. A write is held for a window, each arrival restarts it, and `maxHold` caps the total hold. A later write to one address replaces the value and inherits its waiters, so only the newest value reaches the wire and everyone waiting on that address learns whether it got there. Each caller awaits its own `Deferred`, which keeps "the effect succeeded" meaning "the value reached the device". The read debouncer has no supersede rule and no ceiling: its window opens on the first arrival and does not restart. The cache drops a write whose value the device already holds, keyed by unit and address so one cache serves a whole bus — except where dropping one would split a contiguous run into one FC06 per register, since each batch is planned both filtered and whole and the plan with fewer transactions wins.

**`transport.withBatchingClient(unitId, options)`** puts the three together. It is the sibling of `withClient`, not a replacement for it: `withClient` issues the transaction a caller names, and a batching client decides the transactions for a caller that names registers instead. A unit is declared once and reached for with `transport.batchingClient(unitId)`, because every option here is a fact about the unit rather than about a caller. `transport.touchedUnits` reports transport-wide activity, while `client.onShutdown(action)` runs a device-specific safety action when the calling scope closes — stated on the client that addresses the device, because a safe state is the device's own answer.

Nothing is debounced unless `debounce` asks for it, matching the rest of this package: default timing stays predictable. `writeAll` and `readAll` still plan, so a caller that holds a group of registers gets packed transactions with no window at all.

Three points to know before adopting it, none of which the version number separates:

1. **`BatchingModbusClient` does not extend `ModbusOperations`.** There is no `writeSingleRegister` and no `readHoldingRegisters` on it. For one unit, choose one holding-register write path for the transport's lifetime. Once a batching client exists, raw FC06, FC16, and FC23 operations for that unit fail with `ModbusInvalidArgumentError`; the raw client remains available for exact reads, coils, and other non-register-write operations. Coils are not covered by batching because the planners pack registers.
2. **The cache invalidates when the link is lost, not only after a failed transaction.** A device that power-cycles comes back holding something else, and losing the link is the stronger sign of that. An invalidation that lands while a write is in flight wins over the observation that follows it, so the write that was already on the wire cannot restore a belief the link loss discarded. The cache and the fiber that watches `connectionState` are both created on first use, so a transport nobody batches on carries neither.
3. **`writeNow` flushes the pending batch and joins it.** It is an enqueue with supersede followed by an immediate flush, not a path around the batch. The newest value wins.

Nothing existing changes. `withClient`, the retry policies, the reconnect supervisor, and the circuit breaker behave exactly as before, and a caller that does not call `withBatchingClient` sees no new fibers and no new state.

The read window has not been measured against a live RS-485 bus. Treat any published guidance on its size as an estimate from one transaction at 19200 baud until it has.
