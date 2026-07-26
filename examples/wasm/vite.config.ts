import { defineConfig } from 'vite';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';

// modbus-rs's WASM build is wasm-bindgen "bundler" target output — these two
// plugins are what upstream's own examples use to consume it (see
// references/modbus-rs/mbus-ffi/javascript/examples/react-wasm-example).
//
// Note: no `optimizeDeps.exclude` for modbus-rs/modbus-rs-wasm. An earlier
// version of this file excluded them because the published WASM tarball was
// missing its build output entirely; that was fixed upstream in 0.15.6, and
// vite-plugin-wasm handles the `.wasm` import during esbuild pre-bundling
// without help. Leaving them pre-bundled is deliberate — it is what makes a
// missing named export fail fast, rather than only at module-link time deep in
// the browser. See export-check.html and README.md's "Known limitation".
export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  build: {
    target: 'esnext',
    rollupOptions: {
      // Both entry pages. Paths are resolved against Vite's `root` (this dir).
      input: {
        main: 'index.html',
        // Diagnostic page for the upstream export bug — see src/export-check.ts.
        exportCheck: 'export-check.html',
      },
    },
  },
  server: {
    port: 5173,
  },
});
