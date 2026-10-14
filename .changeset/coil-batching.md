---
'@flux-control/effect-modbus-rs': minor
---

Add opt-in coil batching to the batching client.

Set `coils` in `withBatchingClient` to get `client.coils`. It plans coil writes as FC05 and FC15 steps, suppresses unchanged states with a coil cache, and plans coil reads as FC01 spans. With `plan.writes.maxGap` above zero, an FC15 span can include gap coils. The client fills them from the coil cache, or with FC01 reads within `plan.reads.maxCoilsPerRead`.

After a unit declares coil batching, raw FC05 and FC15 writes for that unit fail with `ModbusInvalidArgumentError`. Units without coil batching keep raw coil writes.

New exports: `planCoilWrites`, `planCoilReads`, `MODBUS_MAX_WRITE_COILS`, `MODBUS_MAX_READ_COILS`, `createCoilCache`, `createCoilClient`, and their types. `createReadDebouncer` accepts a `planSpans` option.

When the connection leaves `Connected`, the transport now also invalidates a register cache or a coil cache that the caller supplies. It invalidates only the units that the cache serves on that transport.
