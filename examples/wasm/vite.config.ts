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
//
// `modbus-rs/web` (and `modbus-rs-wasm/web`) are a different story: that's the
// wasm-bindgen "web" target, which initializes WASM at runtime via
// `new URL('modbus-rs_bg.wasm', import.meta.url)` + `fetch()` rather than an
// ESM `.wasm` import — vite-plugin-wasm has no hook for that pattern. If
// esbuild pre-bundles it, `import.meta.url` resolves to the synthetic
// `node_modules/.vite/deps/` path, the wasm binary was never copied there, the
// fetch 404s, and Vite's dev-server SPA fallback serves index.html instead —
// surfacing in the browser as `WebAssembly.instantiate(): expected magic word
// ..., found 3c 21 64 6f` (the bytes of `<!do...`). Excluding it keeps
// `import.meta.url` pointing at its real location in node_modules, right next
// to the actual .wasm file Vite serves statically.
export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  optimizeDeps: {
    exclude: ['modbus-rs/web', 'modbus-rs-wasm/web'],
  },
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
    fs: {
      allow: ['../..'],
    },
  },
});
