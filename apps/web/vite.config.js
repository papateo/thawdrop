import { defineConfig } from 'vite';

// Mirrors apps/desktop/vite.config.js so both apps read the same ICENET_*
// env var names (e.g. ICENET_TURN_URL) instead of web needing a VITE_ prefix.
export default defineConfig({
  envPrefix: ['VITE_', 'ICENET_'],
});
