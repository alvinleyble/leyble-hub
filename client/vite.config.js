import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Ports are overridable so a second checkout can run its own dev pair without fighting
// the primary one for 5173/3000. Defaults are unchanged; set VITE_DEV_PORT and
// VITE_API_TARGET (matching the backend's own PORT) when you need a second stack.
const port = Number(process.env.VITE_DEV_PORT) || 5173;
const target = process.env.VITE_API_TARGET || 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    strictPort: true,
    host: true,
    proxy: {
      '/api': {
        target,
        changeOrigin: true,
      },
    },
  },
});
