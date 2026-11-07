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
      thresholds: Object.fromEntries(
        securityCritical.map((glob) => [
          glob,
          { branches: 100, functions: 100, lines: 100, statements: 100 },
        ]),
      ),
    },
  },
});
