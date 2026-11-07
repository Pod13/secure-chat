import { defineConfig } from 'vite';

import { releaseKeys } from './vite.config';

// The service worker is built on its own as one classic script (`sw.js`), so it runs in every
// browser that supports service workers and imports nothing at run time.
export default defineConfig({
  define: releaseKeys,
  build: {
    sourcemap: false,
    target: 'es2022',
    emptyOutDir: false,
    lib: { entry: 'src/sw/sw.ts', formats: ['iife'], name: 'sw', fileName: () => 'sw.js' },
  },
});
