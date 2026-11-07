import { defineConfig } from 'vitest/config';

// Security-critical directories need 100% branch coverage (Constitution XIII).
// Each glob is added to `include` as its module is created, so the gate is real.
const securityCritical = ['src/crypto/**', 'src/store/**', 'src/sw/**', 'src/net/**'];

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['tests/e2e/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Browser glue with no decisions in it; covered by the end-to-end tests (Scenario 6).
      exclude: ['src/sw/sw.ts', 'src/sw/register.ts', 'src/main.tsx', 'src/crypto/wasm.ts', 'src/wasm/**'],
      thresholds: Object.fromEntries(
        securityCritical.map((glob) => [
          glob,
          { branches: 100, functions: 100, lines: 100, statements: 100 },
        ]),
      ),
    },
  },
});
