import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  server: { host: true, port: 5173, allowedHosts: true },
  preview: { host: true, port: 4173, allowedHosts: true },
  build: { target: 'es2020', chunkSizeWarningLimit: 900 },
});
