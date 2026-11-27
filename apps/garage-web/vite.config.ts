import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // Three.js changes far less often than the app, so it gets its own long-lived chunk.
        manualChunks: { three: ['three'] },
      },
    },
    // Three.js is a single ~700 kB module that cannot be split further.
    chunkSizeWarningLimit: 900,
  },
  server: {
    // Bind IPv4 loopback explicitly. Left to the default, Node on Windows listens on ::1 only,
    // and anything that resolves localhost to 127.0.0.1 (or proxies to it) sees nothing.
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    // Lets a tailnet proxy (tailscale serve) reach the dev server by its .ts.net name.
    allowedHosts: ['.ts.net'],
    watch: {
      ignored: ['**/public/cars/**'],
    },
  },
});
