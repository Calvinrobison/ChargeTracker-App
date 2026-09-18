// @ts-check
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/**
 * ChargeWatch lint rules.
 *
 * The rules that carry weight here are the ones that protect the product's
 * honesty and security guarantees, not stylistic preferences:
 *  - no `any`, so an unvalidated payload cannot quietly become typed data;
 *  - no floating promises, so a failed write is never silently dropped;
 *  - restricted syntax that bans TypeScript forms Node's type-stripping
 *    cannot run, keeping `npm run test:nodeps` working with no install.
 */
export default [
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'release/**',
      'coverage/**',
      'src/database/migrations/index.ts', // generated
    ],
  },
  js.configs.recommended,
  {
    // `js.configs.recommended` turns on `no-undef`, and flat config ships no
    // globals by default. Without this block every `process`, `console`, `URL`
    // and `setTimeout` in the repo is an undefined variable — 416 errors that
    // say nothing about the code.
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.web.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tsPlugin, 'react-hooks': reactHooks },
    rules: {
      ...tsPlugin.configs['recommended-type-checked'].rules,
      // TypeScript resolves identifiers itself and fails the build on a real
      // undefined one. Leaving the lint rule on as well only produces false
      // positives on type-only and ambient names, which is why typescript-eslint
      // recommends turning it off for typechecked files.
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // A `default` branch counts as handling the rest of the union. This
      // codebase uses one deliberately and repeatedly — an unrecognised
      // occupancy band is grey, an unknown port state is counted as unknown, an
      // unmatched collection state reads "paused" — and without this option the
      // rule reports all eight of those as unhandled. A switch with no default
      // is still required to list every case, which is the case worth catching.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      // Off because several interfaces here declare `Promise<void>` returns that
      // a given implementation satisfies without awaiting anything — the
      // in-process host shims in src/workers, and `pause`/`onSuspend`/`close`,
      // whose callers await them and whose siblings do await. Dropping `async`
      // to satisfy the rule would change those signatures and break the
      // contract. The risk the rule guards against — a promise nobody waits on
      // — is covered by no-floating-promises and no-misused-promises, both on.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSParameterProperty',
          message:
            'Parameter properties cannot be run by Node type-stripping; declare the field explicitly so npm run test:nodeps keeps working.',
        },
        {
          selector: 'TSEnumDeclaration:not([const=true])',
          message: 'Use a union of string literals instead of an enum (erasableSyntaxOnly).',
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'localStorage',
          message: 'Persist state through the database worker, not browser storage.',
        },
        {
          name: 'sessionStorage',
          message: 'Persist state through the database worker, not browser storage.',
        },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'tests/ui/**/*.ts'],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ['tests/**/*.ts', 'scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    // Node's test runner returns a promise from `describe`, `it` and `test`,
    // and not awaiting it is how the API is meant to be used — the runner owns
    // the lifecycle. Flagging those 514 registrations as dropped promises
    // buries the case the rule exists for: an un-awaited assertion inside a
    // spec body, which is still an error here.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['describe', 'it', 'test'] },
          ],
        },
      ],
    },
  },
];
