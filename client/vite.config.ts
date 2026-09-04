import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const proxyTarget = process.env.PANEL_PROXY_TARGET || process.env.VITE_PROXY_TARGET || 'http://localhost:3000';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('../public', import.meta.url)),
    emptyOutDir: true,
    manifest: false
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: proxyTarget, changeOrigin: true },
      '/socket.io': { target: proxyTarget, changeOrigin: true, ws: true }
    }
  }
});
