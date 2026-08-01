# @flux-control/effect-modbus-rs

## 0.2.0

### Minor Changes

- f2e388a: bump deps, notably modbus-rs, which introduced some breaking type changes
- b0b2652: Add browser (WASM) support: `WasmWsTransportService`, `WasmRtuTransportService`, `WasmAsciiTransportService`, and their abstract `WasmSerialTransportService` tag, plus experimental `wasmWsServerLayer` / `wasmSerialRtuServerLayer` / `wasmSerialAsciiServerLayer` server layers and the `requestSerialPort()` Web Serial helper. Includes a runnable Vite example app under `examples/wasm/`. Blocked on upstream `modbus-rs-wasm@0.15.4` being published without its `.wasm`/JS glue, so real browser testing is still pending.

### Patch Changes

- 9a5daaf: Update the browser integration for `modbus-rs@0.16.1`, which restores runtime export compatibility for the `modbus-rs/web` WASM module. API documentation generation now uses a TypeScript 6 toolchain compatible with TypeDoc.
