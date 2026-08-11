// Flat config (ESLint 10). Three environments live in this repo and they do
// not share globals: the browser app in src/, the Node serverless handlers in
// api/ plus the bake scripts, and the tests, which read fixtures off disk and
// therefore need both.
//
// The rule that earns its place here is no-unused-vars. Tests check behavior;
// they cannot see a stale import left behind by a refactor, or a variable that
// no longer feeds anything. That is exactly the residue a large file split
// produces, and it is invisible until someone reads the file.

import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/**', '.vercel/**', 'public/data/**'] },

  js.configs.recommended,

  {
    // Browser app code.
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // console.warn/error are the app's real degradation channel — a missing
      // stations.json or a style fallback reports through them.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },

  {
    // Vercel handlers, bake scripts, and build config: Node, not browser.
    files: ['api/**/*.js', 'scripts/**/*.mjs', 'vite.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, fetch: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },

  {
    // Tests: pure-logic modules under a browser lens, but they load fixtures
    // with node:fs, so both global sets apply.
    files: ['**/*.test.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },
];
