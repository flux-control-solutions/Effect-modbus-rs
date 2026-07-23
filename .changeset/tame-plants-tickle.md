---
"effect-modbus-rs": minor
---

Add browser (WASM) support: `WasmWsTransportService`, `WasmRtuTransportService`, `WasmAsciiTransportService`, and their abstract `WasmSerialTransportService` tag, plus experimental `wasmWsServerLayer` / `wasmSerialRtuServerLayer` / `wasmSerialAsciiServerLayer` server layers and the `requestSerialPort()` Web Serial helper. Includes a runnable Vite example app under `examples/wasm/`. Blocked on upstream `modbus-rs-wasm@0.15.4` being published without its `.wasm`/JS glue, so real browser testing is still pending.
