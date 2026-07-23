import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// modbus-rs's WASM build is wasm-bindgen "bundler" target output — these two
// plugins are what upstream's own examples use to consume it (see
// references/modbus-rs/mbus-ffi/javascript/examples/react-wasm-example).
export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  build: {
    target: "esnext",
  },
  server: {
    port: 5173,
  },
  optimizeDeps: {
    // Vite's dependency pre-bundler scans dynamic imports eagerly at dev-server
    // startup. modbus-rs's WASM build (re-exported from modbus-rs-wasm) is
    // currently broken on npm (see ../../README.md's "Known limitation"
    // section) — excluding it here lets the page still load; the actual error
    // only surfaces when Connect is clicked, which is the real failure point
    // once upstream's publish is fixed.
    exclude: ["modbus-rs", "modbus-rs-wasm"],
  },
});
