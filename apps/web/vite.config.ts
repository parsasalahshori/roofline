import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API runs on 4400 and the web app on 4401 (the end-to-end stack uses 4410). The browser only
// ever talks to the Vite origin; the proxy hands /api, /hooks and /health on to the API.
const API = 'http://127.0.0.1:4400';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4401,
    strictPort: true,
    proxy: { '/api': API, '/hooks': API, '/health': API },
  },
  build: { outDir: 'dist' },
});
