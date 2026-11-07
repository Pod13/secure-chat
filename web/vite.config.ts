import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { securityPlugin } from './vite.security';

// Public manifest-signing keys pinned into the build ("id:base64url,..."); see src/sw/trustedKeys.ts.
export const releaseKeys = {
  __RELEASE_PUBLIC_KEYS__: JSON.stringify(process.env.RELEASE_PUBLIC_KEYS ?? ''),
};

// In development and in end-to-end runs the app and the relay are separate processes. The proxy
// makes them look like one site, as they are in production: the app only ever calls its own origin.
const relay = {
  '/v1': {
    target: process.env.RELAY_URL ?? 'https://localhost:8080',
    secure: false, // the local relay uses a throwaway certificate
    ws: true,
  },
};

export default defineConfig({
  plugins: [react(), securityPlugin()],
  define: releaseKeys,
  server: { proxy: relay },
  preview: { proxy: relay },
  build: { sourcemap: false, target: 'es2022' },
});
