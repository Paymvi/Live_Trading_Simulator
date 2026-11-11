import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies API/WS calls to the local service (npm run dev:server).
export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:5180', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:5180', ws: true },
    },
  },
});
