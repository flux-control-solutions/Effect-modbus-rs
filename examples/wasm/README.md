# effect-modbus-rs — Browser (WASM) example

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

## Known limitation: WASM build

`modbus-rs`'s WASM build (`modbus-rs-wasm`, re-exported under `modbus-rs`'s
`./web` subpath) is **currently broken on npm** — the published
`modbus-rs-wasm@0.15.4` tarball is missing its `.wasm` binary and JS glue
entirely (see the root `README.md`'s "Known limitation" section). Practically,
that means today:

- `npm run dev` starts and the page loads fine (a "Pre-transform error"
  mentioning `modbus-rs-wasm` may appear in the terminal — harmless until you
  click Connect).
- Clicking **Connect** will fail with a clear "Failed to resolve..." error,
  not a successful connection.
- `npm run build` (which runs `tsc` first) will currently fail for the same
  reason once the ambient type shim at `../../src/modbus-rs-web.d.ts` is
  removed (see that file) — until then it type-checks fine via the temporary
  `../../src/modbus-rs-web.d.ts` reference in this project's `tsconfig.json`.

To manually test against a **working** WASM build today, pin the last known-good
version directly and reinstall:

```sh
npm install modbus-rs-wasm@0.15.3
```

(Note: `modbus-rs-wasm@0.15.3` predates the current `WasmWsTransport`/camelCase
API — the exact shape may not line up perfectly with this package's expectations.
Treat this as a rough manual smoke test, not a guarantee.) Once upstream
republishes a working `0.15.4`+ build, this pin is unnecessary.

## Server-side (not demonstrated here)

This package also wraps `modbus-rs`'s experimental browser server bindings
(`wasmWsServerLayer`, `wasmSerialRtuServerLayer`, `wasmSerialAsciiServerLayer`)
— see the root `README.md`'s "Browser server (experimental)" section. Not
included in this app since running a simulated Modbus *server* isn't the
typical browser-app use case, but the same `import { wasmWsServerLayer } from
"effect-modbus-rs"` pattern applies.
