import { defineConfig } from 'vite';

// Custom domain — dropwell.benrichardson.dev — so base is '/'.
// If you ever serve from username.github.io/dropwell/, change this to '/dropwell/'.
export default defineConfig({
  base: '/',
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          webtorrent: ['webtorrent'],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  // webtorrent ships a pre-built ESM browser bundle at
  // webtorrent/dist/webtorrent.min.js, which we import directly. Excluding
  // the package from dep optimisation stops Vite from trying to scan the
  // Node-targeted entry, which pulls in `events`, `path`, etc.
  optimizeDeps: {
    exclude: ['webtorrent'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
