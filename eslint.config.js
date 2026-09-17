// @ts-check
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';

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
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
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
        { name: 'localStorage', message: 'Persist state through the database worker, not browser storage.' },
        { name: 'sessionStorage', message: 'Persist state through the database worker, not browser storage.' },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
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
];
