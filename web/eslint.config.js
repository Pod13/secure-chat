import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Complexity limits from Constitution XIII; a CI failure, not a warning.
const limits = {
  complexity: ['error', 10],
  'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
  'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
};

export default tseslint.config(
  {
    ignores: [
      'src/wasm/',
      'dist/',
      'coverage/',
      'node_modules/',
      'playwright-report/',
      'test-results/',
      '.stryker-tmp/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  { rules: { ...limits, 'no-eval': 'error', 'no-new-func': 'error', 'no-implied-eval': 'error' } },
);
