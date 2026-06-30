// @ts-check
// Flat ESLint config for @basefyio/admin-ui.
//
// We deliberately do NOT use `next lint`: with no config present it drops into
// an interactive setup prompt that hangs CI. This flat config reuses the same
// toolchain already pinned by the workspace (eslint 9 + typescript-eslint), so
// `eslint .` runs non-interactively and stays consistent with platform-api.
//
// Scope (v0.1): a real, green lint that catches genuine defects without forcing
// stylistic churn on the Next.js/React tree. The browser + node globals cover
// both client and server components; a few high-noise rules are relaxed where
// they would fail wholesale on intentional patterns.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    // Never lint build output, deps, or Next's generated type shim.
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // Real signal, but unused args/vars are common in React props and
      // overrides — surface as warnings (honouring the `_` convention).
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // `any` is used deliberately at API/boundary seams in the dashboard.
      '@typescript-eslint/no-explicit-any': 'off',
      // Empty blocks are used for best-effort cleanup/catch — keep as a warning.
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  {
    // CommonJS config files (next.config.js, etc.) legitimately use require()
    // and the Node module globals.
    files: ['**/*.{js,cjs}'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
