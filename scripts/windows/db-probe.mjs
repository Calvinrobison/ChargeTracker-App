#!/usr/bin/env node
/**
 * Reads a ChargeWatch history file READ-ONLY and prints a JSON fingerprint.
 *
 * Used by `test-update.ps1` to establish that an upgrade preserved an existing
 * history file rather than replacing it, and useful on its own when
 * investigating a support report without opening the application.
 *
 * It opens the database read-only and runs nothing but SELECTs, so it cannot
 * modify, migrate, or lock a database it is pointed at. It uses `node:sqlite`,
 * which ships with Node, so it needs nothing installed.
 *
 * Usage:
 *   node scripts/windows/db-probe.mjs --file "C:\path\to\chargewatch.sqlite"
 *   node scripts/windows/db-probe.mjs --file ... --expect-schema 1
 *
 * Exit codes:
 *   0  the database was read
 *   1  it could not be read, or an --expect assertion failed
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const filePath = arg('file');
if (!filePath) {
  console.error('A database file is required: --file <path>');
  process.exit(1);
}

const resolved = resolve(filePath);
if (!existsSync(resolved)) {
  console.error(JSON.stringify({ ok: false, reason: 'missing', file: resolved }, null, 2));
  process.exit(1);
}

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.error(
    JSON.stringify(
      {
        ok: false,
        reason: 'node_sqlite_unavailable',
        detail: 'This Node build has no node:sqlite. Use Node 22.5 or newer.',
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

let db;
try {
  // Read-only. This probe must never be capable of migrating or writing.
  db = new DatabaseSync(resolved, { readOnly: true });
} catch (error) {
  console.error(
    JSON.stringify(
      { ok: false, reason: 'open_failed', file: resolved, detail: String(error?.message ?? error) },
      null,
      2,
    ),
  );
  process.exit(1);
}

const one = (sql) => {
  try {
    return db.prepare(sql).get();
  } catch {
    return null;
  }
};
const count = (table) => {
  const row = one(`SELECT COUNT(*) AS n FROM ${table}`);
  return row ? Number(row.n) : null;
};

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .map((row) => row.name);

const migrations = tables.includes('schema_migrations')
  ? db
      .prepare('SELECT version, name, checksum, app_version, applied_at_ms FROM schema_migrations ORDER BY version')
      .all()
  : [];

const observationRange = tables.includes('observations')
  ? one('SELECT MIN(observed_at_ms) AS first, MAX(observed_at_ms) AS last FROM observations')
  : null;

const stats = statSync(resolved);

const fingerprint = {
  ok: true,
  file: resolved,
  byteSize: stats.size,
  // Preserved by an in-place upgrade; changed if the file was recreated. This
  // is the signal the update test uses to tell "migrated" from "replaced".
  createdAtIso: stats.birthtime.toISOString(),
  modifiedAtIso: stats.mtime.toISOString(),
  journalMode: one('PRAGMA journal_mode')?.journal_mode ?? null,
  schemaVersion: migrations.length > 0 ? Math.max(...migrations.map((m) => Number(m.version))) : null,
  appliedMigrations: migrations.map((m) => ({
    version: Number(m.version),
    name: m.name,
    appVersion: m.app_version,
    appliedAtIso: new Date(Number(m.applied_at_ms)).toISOString(),
  })),
  tableCount: tables.length,
  tables,
  counts: {
    settings: count('app_settings'),
    sites: count('sites'),
    sources: count('sources'),
    bindings: count('source_bindings'),
    observations: count('observations'),
    portObservations: count('port_observations'),
    monitoringIntervals: count('monitoring_intervals'),
    collectionGaps: count('collection_gaps'),
    collectionRuns: count('collection_runs'),
    visitObservations: count('visit_observations'),
    backups: count('backups'),
    updateEvents: count('update_events'),
  },
  observationFirstIso:
    observationRange?.first == null ? null : new Date(Number(observationRange.first)).toISOString(),
  observationLastIso:
    observationRange?.last == null ? null : new Date(Number(observationRange.last)).toISOString(),
  integrityCheck: one('PRAGMA integrity_check')?.integrity_check ?? null,
  foreignKeyViolations: (() => {
    try {
      return db.prepare('PRAGMA foreign_key_check').all().length;
    } catch {
      return null;
    }
  })(),
};

db.close();

console.log(JSON.stringify(fingerprint, null, 2));

// ------------------------------------------------------------------ assertions

const failures = [];

const expectSchema = arg('expect-schema');
if (expectSchema !== null && Number(expectSchema) !== fingerprint.schemaVersion) {
  failures.push(`expected schema ${expectSchema}, found ${fingerprint.schemaVersion}`);
}

const expectMinObservations = arg('expect-min-observations');
if (expectMinObservations !== null) {
  const actual = fingerprint.counts.observations ?? 0;
  if (actual < Number(expectMinObservations)) {
    failures.push(`expected at least ${expectMinObservations} observations, found ${actual}`);
  }
}

if (fingerprint.integrityCheck !== 'ok') {
  failures.push(`integrity_check returned "${fingerprint.integrityCheck}" rather than "ok"`);
}
if (fingerprint.foreignKeyViolations !== 0 && fingerprint.foreignKeyViolations !== null) {
  failures.push(`${fingerprint.foreignKeyViolations} foreign key violation(s)`);
}

if (failures.length > 0) {
  console.error('\nAssertions failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
