import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { securityPlugin } from './vite.security';

// Public manifest-signing keys pinned into the build ("id:base64url,..."); see src/sw/trustedKeys.ts.
export const releaseKeys = {
  __RELEASE_PUBLIC_KEYS__: JSON.stringify(process.env.RELEASE_PUBLIC_KEYS ?? ''),
};

export default defineConfig({
  plugins: [react(), securityPlugin()],
  define: releaseKeys,
  build: { sourcemap: false, target: 'es2022' },
});
