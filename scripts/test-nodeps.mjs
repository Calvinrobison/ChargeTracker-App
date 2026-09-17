#!/usr/bin/env node
/**
 * Runs the dependency-free domain, database and collector specs.
 *
 * These specs exist because the correctness-critical parts of ChargeWatch —
 * the metric contract, the SQL schema, the scheduler budget and the source
 * parser — should be verifiable without installing anything. They run on
 * Node's built-in test runner, TypeScript type-stripping and `node:sqlite`.
 *
 * `npm run test` (Vitest) runs the same specs plus the ones that need
 * dependencies. This script is what you can run on a machine with no network.
 *
 * Usage: node scripts/test-nodeps.mjs [--filter <substring>]
 */

import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const testDir = join(repoRoot, 'tests', 'nodeps');

const filterIndex = process.argv.indexOf('--filter');
const filter = filterIndex === -1 ? null : process.argv[filterIndex + 1];

let files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => relative(repoRoot, join(testDir, name)));

if (filter) files = files.filter((file) => file.includes(filter));

if (files.length === 0) {
  console.error(filter ? `No spec files matched "${filter}".` : 'No spec files found.');
  process.exit(1);
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(
    `These specs need Node 22.6 or newer for --experimental-strip-types and node:sqlite. Found ${process.versions.node}.`,
  );
  process.exit(1);
}

console.log(`Running ${files.length} spec file(s) on Node ${process.versions.node}\n`);

const result = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', '--test', ...files],
  { cwd: repoRoot, stdio: 'inherit' },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
