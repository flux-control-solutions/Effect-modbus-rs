# @flux-control/effect-modbus-rs — Browser (WASM) example

A small, real Vite app exercising this package's browser transport services
(`WasmWsTransportService`, `WasmRtuTransportService`, `WasmAsciiTransportService`,
`requestSerialPort`) in an actual browser — for a consumer to try, or for manual
testing during development. It intentionally does **not** use Bun/vite-via-Bun —
this subdirectory is its own standalone npm project (see the root `AGENTS.md`
for why the rest of the repo is Bun-only; a real browser bundler is the whole
point here).

## Setup

```sh
cd examples/wasm
npm install
npm run dev
```

Then open the printed `http://localhost:5173` URL in a browser. Pick a mode
(WebSocket gateway or Web Serial), fill in connection details, and click
**Connect**.

- **TCP over WebSocket gateway** needs a running WS-to-TCP proxy such as
  [`modbus-gateway`](https://github.com/Raghava-Ch/modbus-gateway) bridging to
  a real or simulated Modbus/TCP device.
- **Web Serial (RTU/ASCII)** needs a Chromium-based browser over HTTPS or
  `localhost`, and a physical serial device (or a virtual port pair via
  `socat` on Linux/macOS) — clicking Connect will prompt you to pick a port.

## WASM module

`modbus-rs@0.16.1` publishes browser bindings through its `modbus-rs/web`
module. `@flux-control/effect-modbus-rs` loads this module internally for its WASM transport
services; applications should import those services from `@flux-control/effect-modbus-rs`, not
from the upstream module directly.

`/export-check.html` remains available to inspect the browser-facing exports at
runtime when upgrading `modbus-rs`.

## Server-side (not demonstrated here)

This package also wraps `modbus-rs`'s experimental browser server bindings
(`wasmWsServerLayer`, `wasmSerialRtuServerLayer`, `wasmSerialAsciiServerLayer`)
— see the root `README.md`'s "Browser server (experimental)" section. Not
included in this app since running a simulated Modbus _server_ isn't the
typical browser-app use case, but the same `import { wasmWsServerLayer } from
"@flux-control/effect-modbus-rs"` pattern applies.
