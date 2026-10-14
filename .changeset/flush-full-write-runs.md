---
'@flux-control/effect-modbus-rs': minor
---

Add the `debounce.writes.flushFullRuns` option to the batching client.

When a run of contiguous held addresses fills one write transaction, the write debouncer flushes that run at once. Other held writes stay for their window. The limit is `plan.writes.maxRegistersPerWrite`. The option is off by default. `client.debounce.writes.flushFullRuns` reports the resolved value.

The write debouncer also accepts the `flushFullRuns` and `maxRegistersPerWrite` options.
