/**
 * Vitest configuration.
 *
 * Two projects, because they have genuinely different requirements:
 *
 *   `specs`        the dependency-free specs under tests/nodeps. These are the
 *                  same files `npm run test:nodeps` runs on Node's built-in
 *                  runner with no install at all. They are included here so a
 *                  single `npm run test` covers everything, and so a change
 *                  that breaks them under one runner but not the other is
 *                  caught rather than hidden.
 *
 *   `integration`  specs that need the dependency tree — electron-updater and
 *                  the Playwright browser API. The directory is empty until those specs are written;
 *                  see docs/IMPLEMENTATION_STATUS.md.
 *
 * The UI tests are NOT here. They run under Playwright against the built
 * renderer; see playwright.config.ts.
 *
 * `passWithNoTests` is deliberately left off. A project that matches nothing
 * must fail, because a green run over zero tests is the most misleading
 * result a test suite can produce.
 */

import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@domain': resolve('src/domain'),
      '@renderer': resolve('src/renderer/src'),
      // The specs under tests/nodeps register with `node:test`, because they
      // must also run on Node's built-in runner with nothing installed. Vitest
      // cannot see those registrations — it collects the file, finds no suite
      // of its own, and fails. This alias points `node:test` at a shim that
      // re-exports the same four names from Vitest, so one set of spec files
      // satisfies both runners. See tests/support/node-test-shim.ts.
      'node:test': resolve('tests/support/node-test-shim.ts'),
    },
  },
  test: {
    // Node, not jsdom: nothing under test touches the DOM. The renderer's
    // formatters are pure functions and are tested as such.
    environment: 'node',
    globals: false,
    include: ['tests/nodeps/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    exclude: ['tests/ui/**'],
    // The database specs open real SQLite files; running them in parallel in
    // one process would have them contend for the same temporary paths.
    fileParallelism: true,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'test-results/vitest-junit.xml' },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'test-results/coverage',
      // The correctness-critical modules. A coverage number over the whole
      // tree would be dominated by UI components that Playwright covers, and
      // would say nothing about the parts that must not be wrong.
      include: [
        'src/domain/**/*.ts',
        'src/database/**/*.ts',
        'src/shared/**/*.ts',
        'src/collector/scheduler.ts',
        'src/collector/adapters/**/parse.ts',
        'src/renderer/src/format.ts',
      ],
      exclude: ['**/*.d.ts', 'src/database/migrations/index.ts'],
      thresholds: {
        // Set to what the specs actually achieve today, not to an aspiration.
        // Raise them when coverage rises; never lower them to make a run pass.
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
