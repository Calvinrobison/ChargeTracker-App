#!/usr/bin/env node
/**
 * Generates src/database/migrations/index.ts from the .sql files beside it.
 *
 * The .sql files are the canonical, reviewable schema. Embedding them in a
 * TypeScript module at build time avoids resolving file paths inside app.asar
 * at runtime, which is a common packaging failure.
 *
 * Usage:
 *   node scripts/generate-migrations.mjs           # write the module
 *   node scripts/generate-migrations.mjs --check   # fail if it is stale
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'src', 'database', 'migrations');
const outputPath = join(migrationsDir, 'index.ts');

const FILE_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;

const files = readdirSync(migrationsDir)
  .filter((name) => FILE_PATTERN.test(name))
  .sort();

if (files.length === 0) {
  console.error('No migration .sql files found in', migrationsDir);
  process.exit(1);
}

const entries = files.map((name) => {
  const match = FILE_PATTERN.exec(name);
  const version = Number(match[1]);
  const slug = match[2];
  const sql = readFileSync(join(migrationsDir, name), 'utf8').replace(/\r\n/g, '\n');
  return { name, version, slug, sql };
});

entries.forEach((entry, index) => {
  if (entry.version !== index + 1) {
    console.error(
      `Migration versions must be contiguous from 001. Found ${entry.name} where ${String(index + 1).padStart(3, '0')} was expected.`,
    );
    process.exit(1);
  }
});

function embed(sql) {
  // Escape only what a template literal can misread.
  return sql.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

const body = entries
  .map(
    (entry) => `  {
    version: ${entry.version},
    name: ${JSON.stringify(entry.slug)},
    sql: \`${embed(entry.sql)}\`,
  },`,
  )
  .join('\n');

const output = `/**
 * GENERATED FILE — do not edit.
 *
 * Produced by scripts/generate-migrations.mjs from the .sql files in this
 * directory, which are the canonical schema. Run \`npm run build\` or
 * \`node scripts/generate-migrations.mjs\` after changing one.
 */

import type { Migration } from '../migrator.ts';

export const MIGRATIONS: readonly Migration[] = [
${body}
];

export const NEWEST_MIGRATION_VERSION = ${entries[entries.length - 1].version};
`;

if (process.argv.includes('--check')) {
  let existing = '';
  try {
    existing = readFileSync(outputPath, 'utf8');
  } catch {
    console.error('src/database/migrations/index.ts is missing. Run: node scripts/generate-migrations.mjs');
    process.exit(1);
  }
  if (existing.replace(/\r\n/g, '\n') !== output) {
    console.error(
      'src/database/migrations/index.ts is stale. Run: node scripts/generate-migrations.mjs',
    );
    process.exit(1);
  }
  console.log(`Migrations module is up to date (${entries.length} migrations).`);
  process.exit(0);
}

writeFileSync(outputPath, output, 'utf8');
console.log(
  `Wrote ${outputPath} with ${entries.length} migration(s): ${entries.map((e) => e.name).join(', ')}`,
);
