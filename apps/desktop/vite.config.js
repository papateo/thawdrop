import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Tauri needs a fixed dev server port so it knows where to load the webview
// from; strictPort avoids silently drifting to another port if 1420 is busy.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'ICENET_'],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        share: resolve(import.meta.dirname, 'share.html'),
      },
    },
  },
});
