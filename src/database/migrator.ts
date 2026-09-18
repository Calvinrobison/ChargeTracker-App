/**
 * Ordered, checksummed, transactional migrations.
 *
 * Rules:
 *  - Migrations apply in version order inside a transaction each.
 *  - Every applied migration's checksum is stored; a changed historical
 *    migration is a hard error, not a silent re-apply.
 *  - A database whose schema is NEWER than this build understands is REFUSED
 *    and left untouched. Downgrading an executable is not a data rollback.
 *  - Collection must not run during migration; the caller enforces that and
 *    records a pre-migration backup first.
 */

import { createHash } from 'node:crypto';
import { type SqliteDriver, checkIntegrity, transact } from './driver.ts';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** The schema version this build writes and can read. */
export const TARGET_SCHEMA_VERSION = 1;

export const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version      INTEGER NOT NULL PRIMARY KEY,
  name         TEXT    NOT NULL,
  checksum     TEXT    NOT NULL,
  app_version  TEXT    NOT NULL,
  applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms BETWEEN 0 AND 4102444800000)
) STRICT;
`;

export function checksumOf(sql: string): string {
  // Newlines are normalised so a line-ending change is not a schema change.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appVersion: string;
  readonly appliedAtMs: number;
}

export type MigrationOutcome =
  | {
      readonly status: 'up_to_date';
      readonly schemaVersion: number;
      readonly applied: readonly number[];
    }
  | {
      readonly status: 'migrated';
      readonly schemaVersion: number;
      readonly applied: readonly number[];
    }
  | {
      readonly status: 'refused_newer_schema';
      readonly schemaVersion: number;
      readonly targetVersion: number;
      readonly detail: string;
    }
  | {
      readonly status: 'failed';
      readonly schemaVersion: number;
      readonly failedVersion: number;
      readonly detail: string;
    }
  | {
      readonly status: 'checksum_mismatch';
      readonly schemaVersion: number;
      readonly failedVersion: number;
      readonly detail: string;
    };

export function readAppliedMigrations(driver: SqliteDriver): AppliedMigration[] {
  driver.exec(MIGRATIONS_TABLE_SQL);
  return driver
    .prepare(
      'SELECT version, name, checksum, app_version, applied_at_ms FROM schema_migrations ORDER BY version',
    )
    .all()
    .map((row) => ({
      version: Number(row.version),
      name: String(row.name),
      checksum: String(row.checksum),
      appVersion: String(row.app_version),
      appliedAtMs: Number(row.applied_at_ms),
    }));
}

export function currentSchemaVersion(driver: SqliteDriver): number {
  const applied = readAppliedMigrations(driver);
  return applied.length === 0 ? 0 : Math.max(...applied.map((m) => m.version));
}

export interface MigrateOptions {
  readonly appVersion: string;
  readonly nowMs: number;
  /** Target version, for tests that upgrade partway. Defaults to the newest. */
  readonly toVersion?: number;
}

/**
 * Applies pending migrations.
 *
 * Each migration runs in its own transaction, so a failure leaves the database
 * at the last successfully applied version with its data intact.
 */
export function migrate(
  driver: SqliteDriver,
  migrations: readonly Migration[],
  options: MigrateOptions,
): MigrationOutcome {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (let i = 0; i < ordered.length; i += 1) {
    const expected = i + 1;
    if (ordered[i]?.version !== expected) {
      return {
        status: 'failed',
        schemaVersion: currentSchemaVersion(driver),
        failedVersion: ordered[i]?.version ?? expected,
        detail: `migrations must be contiguous from 1; found ${String(ordered[i]?.version)} at position ${expected}`,
      };
    }
  }

  const applied = readAppliedMigrations(driver);
  const appliedByVersion = new Map(applied.map((m) => [m.version, m]));
  const currentVersion = applied.length === 0 ? 0 : Math.max(...applied.map((m) => m.version));
  const highestKnown = ordered.length === 0 ? 0 : (ordered[ordered.length - 1]?.version ?? 0);

  // A newer schema is refused rather than modified.
  if (currentVersion > highestKnown) {
    return {
      status: 'refused_newer_schema',
      schemaVersion: currentVersion,
      targetVersion: highestKnown,
      detail:
        `This database was written by a newer version of ChargeWatch (schema ${currentVersion}; ` +
        `this build understands ${highestKnown}). It has not been modified. Install the newer version to open it.`,
    };
  }

  // A historical migration whose text changed invalidates provenance.
  for (const migration of ordered) {
    const record = appliedByVersion.get(migration.version);
    if (!record) continue;
    const checksum = checksumOf(migration.sql);
    if (record.checksum !== checksum) {
      return {
        status: 'checksum_mismatch',
        schemaVersion: currentVersion,
        failedVersion: migration.version,
        detail:
          `Migration ${migration.version} (${migration.name}) no longer matches the checksum recorded ` +
          `when it was applied. The database has not been modified.`,
      };
    }
  }

  const target = options.toVersion ?? highestKnown;
  const pending = ordered.filter((m) => m.version > currentVersion && m.version <= target);
  if (pending.length === 0) {
    return { status: 'up_to_date', schemaVersion: currentVersion, applied: [] };
  }

  const appliedNow: number[] = [];
  for (const migration of pending) {
    try {
      transact(driver, () => {
        driver.exec(migration.sql);
        driver
          .prepare(
            'INSERT INTO schema_migrations (version, name, checksum, app_version, applied_at_ms) VALUES (?, ?, ?, ?, ?)',
          )
          .run(
            migration.version,
            migration.name,
            checksumOf(migration.sql),
            options.appVersion,
            options.nowMs,
          );
      });
      appliedNow.push(migration.version);
    } catch (error) {
      return {
        status: 'failed',
        schemaVersion: currentSchemaVersion(driver),
        failedVersion: migration.version,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const integrity = checkIntegrity(driver);
  if (!integrity.ok) {
    return {
      status: 'failed',
      schemaVersion: currentSchemaVersion(driver),
      failedVersion: appliedNow[appliedNow.length - 1] ?? target,
      detail: `post-migration integrity check failed: ${integrity.details.join('; ')} (${integrity.foreignKeyViolations} foreign key violations)`,
    };
  }

  return { status: 'migrated', schemaVersion: currentSchemaVersion(driver), applied: appliedNow };
}

/** True when this build can read the given schema version. */
export function canRead(schemaVersion: number): boolean {
  return schemaVersion <= TARGET_SCHEMA_VERSION;
}

/** True when this build can write the given schema version. */
export function canWrite(schemaVersion: number): boolean {
  return schemaVersion === TARGET_SCHEMA_VERSION;
}
