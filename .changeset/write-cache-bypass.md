---
'@flux-control/effect-modbus-rs': minor
---

Add a per-call `bypassCache` option to the batching client write methods.

A flagged write reaches the device when the write cache already holds its value. Other writes in the same batch are still filtered. If a newer write to the same address arrives before the flush, the address keeps the flag. The cache records the value after the device acknowledges the write. Write spans report the number of bypassed writes in `modbus.bypassed_count`.
