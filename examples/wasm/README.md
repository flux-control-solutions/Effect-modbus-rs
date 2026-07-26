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

## Known limitation: `ModbusErrorCode` is missing from the WASM build

**The main app on `/` currently fails to load in a browser.** This is an upstream
`modbus-rs` bug, not a bug in this example.

`modbus-rs@0.15.6`'s WASM build declares `ModbusErrorCode` in its `.d.ts` but
never exports it from the generated JS. The parent package's `src/errors.ts`
does `import { getModbusErrorCode, ModbusErrorCode } from 'modbus-rs'`, so under
the `browser` export condition that import fails at module-link time and takes
the whole module graph down with it:

```
SyntaxError: The requested module '/node_modules/.vite/deps/modbus-rs.js'
does not provide an export named 'ModbusErrorCode'
```

### Confirming it

Two paths in this project surface the bug deliberately:

| Path                       | Command                                                              | What you get                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime, in a real browser | `npm run dev`, then open [`/export-check.html`](./export-check.html) | Four probes (`modbus-rs`, `modbus-rs/web`, the bare named import, and `effect-modbus-rs`) with the actual runtime export list of each, rendered as pass/fail |
| Build time                 | `npx vite build`                                                     | Rollup fails with `"ModbusErrorCode" is not exported by ".../modbus-rs/dist/index.browser.js", imported by "../../src/errors.ts"`                            |

The diagnostic page keeps working even though the main app does not, because it
loads everything through `import()` inside a try/catch — see the header comment
in `src/export-check.ts` for why that quarantine is necessary.

Note that `npm run build` runs `tsc` first, and **`tsc` passes** — the WASM
`.d.ts` declares the export that the JS lacks. That mismatch is the whole bug,
and it is why no type-level check in this repo catches it.

### Root cause (upstream)

In `mbus-ffi/src/wasm/error_codes.rs`, `ModbusErrorCode` is declared with
`#[wasm_bindgen(inline_js = ...)]` inside an `extern "C"` block. That is an
_import_ declaration: wasm-bindgen emits the JS into
`snippets/mbus-ffi-*/inline0.js` for Rust to consume, but never re-exports it
from the package entry. A separate `typescript_custom_section` in the same file
unconditionally writes `export declare const ModbusErrorCode` into the `.d.ts`.
Hence: types say exported, runtime says no. (The napi build is unaffected — its
`scripts/postbuild.js` appends a real `module.exports.ModbusErrorCode`.)

### Working around it locally

If you only need the app to run, inline the constant in the parent package's
`src/errors.ts` — the values are plain strings and carry no runtime behavior:

```ts
import { getModbusErrorCode } from 'modbus-rs'; // this one does exist in both builds

const ModbusErrorCode = {
  EXCEPTION: 'MODBUS_EXCEPTION',
  TIMEOUT: 'MODBUS_TIMEOUT',
  TRANSPORT: 'MODBUS_TRANSPORT',
  INVALID_ARGUMENT: 'MODBUS_INVALID_ARGUMENT',
  CONNECTION_CLOSED: 'MODBUS_CONNECTION_CLOSED',
  INTERNAL: 'MODBUS_INTERNAL',
} as const;
```

That is intentionally **not** applied on this branch, so the failure stays
reproducible while the upstream fix is in flight.

### Separately: the same drift, in the other direction

`bun run typecheck` at the repo root reports two further errors —
`WasmRtuTransport` and `WasmAsciiTransport` are missing `setRequestTimeout`,
`clearRequestTimeout`, and `reconnect`. Those methods **do exist at runtime**
(`modbus-rs-wasm/dist/bundler/modbus-rs_bg.js` defines all three on both
classes); only the `.d.ts` omits them. Same root cause as above — upstream marks
its WASM API `#[wasm_bindgen(skip_typescript)]` and hand-writes the declarations
in a `typescript_custom_section`, so the types can drift from the generated JS
in either direction. Also left failing loudly on purpose.

## Server-side (not demonstrated here)

This package also wraps `modbus-rs`'s experimental browser server bindings
(`wasmWsServerLayer`, `wasmSerialRtuServerLayer`, `wasmSerialAsciiServerLayer`)
— see the root `README.md`'s "Browser server (experimental)" section. Not
included in this app since running a simulated Modbus _server_ isn't the
typical browser-app use case, but the same `import { wasmWsServerLayer } from
"effect-modbus-rs"` pattern applies.
