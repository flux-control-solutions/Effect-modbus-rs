# @flux-control/effect-modbus-rs — Browser (WASM) example

A Vite application for manual testing of browser Modbus transports.
It uses `WasmWsTransportService`, `WasmRtuTransportService`,
`WasmAsciiTransportService`, and `requestSerialPort`.
This directory is a separate npm project.

## Setup

Build the package from its root before installing the example:

```sh
bun run build
cd examples/wasm
npm install
npm run dev
```

Open the development server URL in a browser.
Select WebSocket gateway or Web Serial mode.
Enter connection details.
Click **Connect**.

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

## Browser servers

The package also exposes experimental `wasmWsServerLayer`,
`wasmSerialRtuServerLayer`, and `wasmSerialAsciiServerLayer` factories.
This application does not demonstrate those servers.
See [Servers and gateway](../../README.md#servers-and-gateway) for lifecycle and port-handle requirements.
