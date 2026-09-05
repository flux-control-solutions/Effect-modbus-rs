---
'@flux-control/effect-modbus-rs': minor
---

Add an optional batching client for register operations. The existing client remains available as a low-level, full-control option.

## Low-level full-control client

`transport.withClient(unitId)` continues to return an `EffectModbusClient`. This client exposes all standard Modbus operations and issues the exact transaction that the caller specifies.

Use this client for these operations:

- Issue exact register transactions with caller-selected addresses and quantities.
- Read and write coils.
- Read discrete inputs.
- Access diagnostics and file records.
- Control transaction schedules and groups directly.

The batching client does not replace this API. Both clients use the same transport connection.

For a unit that uses batching, the low-level client still supports reads, coils, diagnostics, file records, and other non-register-write operations. The transport rejects raw FC06, FC16, and FC23 writes for that unit. Without this block, the writes can bypass a pending batch or its cache.

## Batching client

`transport.withBatchingClient(unitId, options)` declares a `BatchingModbusClient` for one unit. Other callers get that client with `transport.batchingClient(unitId)`.

The batching client provides these features:

- `write`, `writeNow`, `writeAll`, and `writeAllNow` pack adjacent writes into FC06 or FC16 transactions.
- `read`, `readNow`, `readAll`, and `readAllNow` pack holding-register reads into FC03 spans.
- The `inputs` reader provides the same read operations for input registers with FC04.
- Optional write and read windows collect operations that arrive at different times.
- The write cache removes writes when the device already contains the value.
- Device-specific planner limits control the maximum transaction size and permitted gaps between reads.
- Each caller receives the result of its own operation. This rule also applies when operations share one transaction.

Debounce windows are disabled by default. Group methods still plan one caller group without a debounce window.

The write window restarts after each new write. `maxHold` limits the total delay for a continuous stream of writes.

The read window starts with the first request and does not restart. Thus, later readers cannot continuously delay the batch.

The cache records acknowledged writes by unit and address. It does not answer reads.

A failed write invalidates the cache for that unit. A lost connection invalidates all cache entries.

Each unit has one batching client, one cache view, and one set of options. A second declaration for the same unit fails with `ModbusInvalidArgumentError`.

## Operation and lifecycle details

`BatchingModbusClient` does not extend `ModbusOperations`. This separation prevents register writes from bypassing the batch order and cache.

`writeNow` and `writeAllNow` join the pending batch and flush it immediately. A newer write for the same address replaces the older value.

`client.onShutdown(action)` registers a device-specific action for scope shutdown. The action runs while the transport is open and before the client closes.

The client emits `modbus.write` and `modbus.read` spans. These spans include unit IDs, register counts, suppressed-write counts, and transaction counts.

## Standalone batching components

The batching components are also public APIs:

- `planWrites` and `planReads` provide pure transaction plans without state or I/O.
- `createWriteDebouncer` and `createReadDebouncer` collect operations for caller-supplied flush functions.
- `createRegisterCache` tracks acknowledged register values.
- `makeBatchingClient` creates a batching client over an `EffectModbusClient`.
- `createBatchingRegistry` adds per-unit declarations and connection-state cache invalidation to a custom transport.
