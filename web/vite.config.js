import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build to web/dist; the Node app serves it (e.g. mounted at /app). base '/app/'
// so assets resolve when served under that path.
export default defineConfig({
  plugins: [react()],
  base: '/app/',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // `npm run dev` proxies API calls to the live Node app for local development.
    proxy: { '/api': 'http://127.0.0.1:8090' },
  },
});
