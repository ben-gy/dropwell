// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
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
