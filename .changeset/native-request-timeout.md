---
'@flux-control/effect-modbus-rs': patch
---

Upgrade the native binding to `modbus-rs` 0.16.3 and preserve transport lifecycle behavior.

The binding now applies serial response limits and keeps healthy units usable after an isolated timeout.
The services remove the automatic timeout setter and the reconnect-after-timeout flag.

- Preserve separate response and admission options. When the response option is absent, use the request option as its fallback.
- Verify that raw native aborts drain late replies before the next unit request. This fixes the follow-up checksum error in 0.16.2.
- Keep the serial drain lock for Effect interruption. Protect failure reporting inside the same attempt.
- Track runtime limit changes. When an unbounded serial call is interrupted, close its handle and reopen lazily on later use.
- Resolve clients from the current handle after a replacement. Preserve touched units and invalidate batching caches through connection state changes.
- Set `MAX_SERIAL_PORT_PATH` to 128. Longer stable links use scoped aliases that follow device re-enumeration.

TCP requests remain concurrent. The WASM service code does not change.
