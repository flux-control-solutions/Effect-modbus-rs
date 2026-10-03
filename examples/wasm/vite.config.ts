import { defineConfig } from 'vite';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';

/** Configures Vite for the WASM demo and its package-export diagnostic page. */
export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  optimizeDeps: {
    // Preserve import.meta.url so the web binding can locate its adjacent WASM binary.
    exclude: ['modbus-rs/web', 'modbus-rs-wasm/web'],
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      // Both entry pages. Vite resolves these paths against its configured root.
      input: {
        main: 'index.html',
        // Package export diagnostic page; see src/export-check.ts.
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
