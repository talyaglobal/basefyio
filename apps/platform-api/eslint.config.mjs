// @ts-check
// Flat ESLint config for @basefyio/platform-api.
//
// Scope (v0.1 release gate): a real, green lint that catches genuine defects
// (undeclared vars, unreachable code, accidental shadowing) without forcing a
// large stylistic churn on the freshly-migrated NestJS tree. We intentionally
// run the non-type-checked recommended set — it needs no TS program, so it is
// fast and CI-stable. A few high-noise rules are relaxed to warnings or off
// where they would fail wholesale on existing, intentional patterns
// (e.g. `any` in DI/test stubs). Tighten these as the codebase matures.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    // Never lint build output, deps, or Prisma-generated client.
    ignores: ['dist/**', 'node_modules/**', 'prisma/generated/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['{src,test}/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
    rules: {
      // Real signal, but unused args/vars are common in Nest interfaces and
      // overrides — surface as warnings (and honour the `_` convention) rather
      // than fail the gate.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // The migrated code uses `any` deliberately at DI/boundary/test seams.
      '@typescript-eslint/no-explicit-any': 'off',
      // NestJS lifecycle and decorator patterns trip these without being bugs.
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      // Empty blocks are used deliberately for best-effort cleanup/catch
      // (e.g. swallowing teardown errors). Keep visible as a warning.
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // `require()` is used intentionally for lazy/optional deps (e.g. the
      // optional `openai` dependency) — not an error in this codebase.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
