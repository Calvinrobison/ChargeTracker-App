/**
 * Backup, restore and retention.
 *
 * The rule that shapes this module: copying only the main database file while
 * WAL writes are active is NOT a valid backup. Every backup goes through
 * SQLite's online backup API (node:sqlite's `backup`), and a driver that
 * cannot do that reports `supportsOnlineBackup: false` and is refused here.
 *
 * Restore never writes into an actively used SQLite file. It stops collection,
 * preserves the current database as a backup, stages the candidate, verifies
 * it, and only then swaps it in.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { SqliteDriver } from './driver.ts';
import { applyConnectionPragmas, checkIntegrity } from './driver.ts';
import { BACKUP_RETENTION } from '../domain/thresholds.ts';
import { TARGET_SCHEMA_VERSION, canRead, currentSchemaVersion } from './migrator.ts';

export type BackupKind = 'daily' | 'pre_migration' | 'pre_restore' | 'manual' | 'pre_update';

export interface BackupManifest {
  readonly formatVersion: 1;
  readonly id: string;
  readonly kind: BackupKind;
  readonly appVersion: string;
  readonly schemaVersion: number;
  readonly createdAtMs: number;
  readonly fileName: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly observationCount: number;
  readonly siteCount: number;
}

export interface BackupResult {
  readonly manifest: BackupManifest;
  readonly filePath: string;
  readonly verified: boolean;
}

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

function backupFileName(kind: BackupKind, createdAtMs: number): string {
  const stamp = new Date(createdAtMs).toISOString().replace(/[:.]/g, '-');
  return `chargewatch-${kind}-${stamp}.sqlite`;
}

export interface CreateBackupOptions {
  readonly driver: SqliteDriver;
  readonly backupDir: string;
  readonly kind: BackupKind;
  readonly appVersion: string;
  readonly nowMs: number;
  /** Opens a read-only connection to the backup file for verification. */
  readonly openForVerify: (path: string) => SqliteDriver;
}

/**
 * Creates a consistent backup through SQLite's online backup API and verifies
 * the copy before reporting success.
 */
export async function createBackup(options: CreateBackupOptions): Promise<BackupResult> {
  const { driver, backupDir, kind, appVersion, nowMs } = options;

  if (!driver.supportsOnlineBackup || typeof driver.backupTo !== 'function') {
    throw new Error(
      'This SQLite driver cannot perform an online backup. Copying a live WAL database file is not a valid backup, so no backup was created.',
    );
  }

  await mkdir(backupDir, { recursive: true });
  const fileName = backupFileName(kind, nowMs);
  const filePath = join(backupDir, fileName);
  const stagingPath = `${filePath}.partial`;

  const schemaVersion = currentSchemaVersion(driver);
  const observationCount = Number(
    driver.prepare('SELECT COUNT(*) AS c FROM observations').get()?.c ?? 0,
  );
  const siteCount = Number(driver.prepare('SELECT COUNT(*) AS c FROM sites').get()?.c ?? 0);

  await driver.backupTo(stagingPath);

  // Verify the copy opens, passes integrity and carries the expected history
  // BEFORE it is published under its final name.
  let verified = false;
  const verifyDriver = options.openForVerify(stagingPath);
  try {
    applyConnectionPragmas(verifyDriver);
    const integrity = checkIntegrity(verifyDriver);
    const copiedObservations = Number(
      verifyDriver.prepare('SELECT COUNT(*) AS c FROM observations').get()?.c ?? 0,
    );
    verified =
      integrity.ok &&
      copiedObservations === observationCount &&
      currentSchemaVersion(verifyDriver) === schemaVersion;
  } finally {
    verifyDriver.close();
  }

  if (!verified) {
    await rm(stagingPath, { force: true });
    throw new Error(
      `Backup verification failed for ${fileName}; the partial copy was discarded and the live database was not touched.`,
    );
  }

  await rename(stagingPath, filePath);
  const info = await stat(filePath);
  const sha256 = await sha256OfFile(filePath);

  const manifest: BackupManifest = {
    formatVersion: 1,
    id: `${kind}-${nowMs}`,
    kind,
    appVersion,
    schemaVersion,
    createdAtMs: nowMs,
    fileName,
    byteSize: info.size,
    sha256,
    observationCount,
    siteCount,
  };

  driver
    .prepare(
      `INSERT INTO backups (id, kind, file_path, file_sha256, byte_size, app_version, schema_version, created_at_ms, verified, manifest_json)
       VALUES (?,?,?,?,?,?,?,?,1,?)`,
    )
    .run(
      manifest.id,
      kind,
      filePath,
      sha256,
      info.size,
      appVersion,
      schemaVersion,
      nowMs,
      JSON.stringify(manifest),
    );

  return { manifest, filePath, verified };
}

/**
 * Applies retention: seven daily copies plus the most recent three
 * pre-migration copies. Other kinds are kept until the user removes them.
 */
export async function pruneBackups(
  driver: SqliteDriver,
  backupDir: string,
): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const limits: Partial<Record<BackupKind, number>> = {
    daily: BACKUP_RETENTION.dailyCopies,
    pre_migration: BACKUP_RETENTION.preMigrationCopies,
  };

  for (const [kind, keep] of Object.entries(limits) as Array<[BackupKind, number]>) {
    const rows = driver
      .prepare('SELECT id, file_path FROM backups WHERE kind = ? ORDER BY created_at_ms DESC')
      .all(kind);
    for (const row of rows.slice(keep)) {
      const path = String(row.file_path);
      await rm(path, { force: true });
      driver.prepare('DELETE FROM backups WHERE id = ?').run(String(row.id));
      removed.push(basename(path));
    }
  }

  // Remove orphaned .partial files from interrupted backups.
  try {
    for (const name of await readdir(backupDir)) {
      if (name.endsWith('.partial')) {
        await rm(join(backupDir, name), { force: true });
        removed.push(name);
      }
    }
  } catch {
    // A missing backup directory is not an error here.
  }

  return { removed };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export type RestoreRejection =
  | 'file_missing'
  | 'not_a_database'
  | 'checksum_mismatch'
  | 'integrity_failed'
  | 'unsupported_future_schema'
  | 'too_large'
  | 'unsafe_path';

export interface RestorePreview {
  readonly ok: boolean;
  readonly rejection?: RestoreRejection;
  readonly detail?: string;
  readonly schemaVersion?: number;
  readonly appVersion?: string | null;
  readonly observationCount?: number;
  readonly siteCount?: number;
  readonly firstObservationMs?: number | null;
  readonly latestObservationMs?: number | null;
  readonly byteSize?: number;
}

export interface ValidateRestoreOptions {
  readonly candidatePath: string;
  readonly openForVerify: (path: string) => SqliteDriver;
  readonly maxBytes?: number;
  /** When the caller has a manifest, the expected content hash. */
  readonly expectedSha256?: string | null;
}

const DEFAULT_MAX_RESTORE_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * Validates a restore candidate and produces the summary the user confirms.
 *
 * The live database is not touched by this function at all.
 */
export async function validateRestoreCandidate(
  options: ValidateRestoreOptions,
): Promise<RestorePreview> {
  const { candidatePath } = options;

  let info;
  try {
    info = await stat(candidatePath);
  } catch {
    return { ok: false, rejection: 'file_missing', detail: `${candidatePath} could not be read` };
  }
  if (!info.isFile()) {
    return { ok: false, rejection: 'not_a_database', detail: 'the path is not a regular file' };
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESTORE_BYTES;
  if (info.size > maxBytes) {
    return {
      ok: false,
      rejection: 'too_large',
      detail: `${info.size} bytes exceeds the ${maxBytes}-byte restore limit`,
    };
  }

  if (options.expectedSha256) {
    const actual = await sha256OfFile(candidatePath);
    if (actual !== options.expectedSha256) {
      return {
        ok: false,
        rejection: 'checksum_mismatch',
        detail: 'the file does not match the checksum in its manifest',
      };
    }
  }

  let driver: SqliteDriver | null = null;
  try {
    driver = options.openForVerify(candidatePath);
    applyConnectionPragmas(driver);
    const integrity = checkIntegrity(driver);
    if (!integrity.ok) {
      return {
        ok: false,
        rejection: 'integrity_failed',
        detail: integrity.details.join('; '),
      };
    }
    const schemaVersion = currentSchemaVersion(driver);
    if (!canRead(schemaVersion)) {
      return {
        ok: false,
        rejection: 'unsupported_future_schema',
        schemaVersion,
        detail:
          `This backup was written with schema ${schemaVersion}; this build understands ` +
          `${TARGET_SCHEMA_VERSION}. The existing database has not been touched.`,
      };
    }
    const counts = driver
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM observations) AS observations,
           (SELECT COUNT(*) FROM sites) AS sites,
           (SELECT MIN(observed_at_ms) FROM observations) AS first_ms,
           (SELECT MAX(observed_at_ms) FROM observations) AS last_ms`,
      )
      .get();
    const appVersion = driver
      .prepare('SELECT app_version FROM schema_migrations ORDER BY version DESC LIMIT 1')
      .get();

    return {
      ok: true,
      schemaVersion,
      appVersion: appVersion?.app_version === undefined ? null : String(appVersion.app_version),
      observationCount: Number(counts?.observations ?? 0),
      siteCount: Number(counts?.sites ?? 0),
      firstObservationMs: counts?.first_ms === null ? null : Number(counts?.first_ms ?? 0),
      latestObservationMs: counts?.last_ms === null ? null : Number(counts?.last_ms ?? 0),
      byteSize: info.size,
    };
  } catch (error) {
    return {
      ok: false,
      rejection: 'not_a_database',
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    driver?.close();
  }
}

export interface PerformRestoreOptions {
  readonly candidatePath: string;
  readonly livePath: string;
  readonly stagingDir: string;
  readonly nowMs: number;
  /** Called to stop collection and close the live connection before the swap. */
  readonly closeLiveDatabase: () => Promise<void>;
  readonly openForVerify: (path: string) => SqliteDriver;
}

export interface RestoreOutcome {
  readonly ok: boolean;
  readonly preservedPreviousPath?: string;
  readonly detail?: string;
}

/**
 * Performs the swap after the user has confirmed a validated preview.
 *
 * Ordering matters: stop and close, preserve the current database, stage a
 * verified copy, then move it into place. The previous database is kept so a
 * bad restore is recoverable.
 */
export async function performRestore(options: PerformRestoreOptions): Promise<RestoreOutcome> {
  const { candidatePath, livePath, stagingDir, nowMs } = options;

  const preview = await validateRestoreCandidate({
    candidatePath,
    openForVerify: options.openForVerify,
  });
  if (!preview.ok) {
    return {
      ok: false,
      detail: `restore candidate rejected: ${preview.rejection} ${preview.detail ?? ''}`,
    };
  }

  await mkdir(stagingDir, { recursive: true });
  const stagedPath = join(stagingDir, `restore-${nowMs}.sqlite`);
  await copyFile(candidatePath, stagedPath);

  // Verify the staged copy, not just the source.
  const stagedPreview = await validateRestoreCandidate({
    candidatePath: stagedPath,
    openForVerify: options.openForVerify,
  });
  if (!stagedPreview.ok) {
    await rm(stagedPath, { force: true });
    return { ok: false, detail: 'the staged copy failed verification; nothing was replaced' };
  }

  await options.closeLiveDatabase();

  const preservedPath = `${livePath}.replaced-${nowMs}`;
  try {
    await rename(livePath, preservedPath);
  } catch {
    // No existing database is a valid first-run restore.
  }
  // WAL sidecars belong to the replaced database and must not survive the swap.
  await rm(`${livePath}-wal`, { force: true });
  await rm(`${livePath}-shm`, { force: true });

  try {
    await rename(stagedPath, livePath);
  } catch (error) {
    // Put the original back rather than leaving the user with nothing.
    try {
      await rename(preservedPath, livePath);
    } catch {
      /* fall through to the error below */
    }
    return {
      ok: false,
      detail: `restore failed while swapping files: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { ok: true, preservedPreviousPath: preservedPath };
}

/** Rejects archive entries that would escape the extraction directory. */
export function isSafeArchiveEntryPath(entryPath: string): boolean {
  if (entryPath.length === 0) return false;
  if (entryPath.startsWith('/') || entryPath.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(entryPath)) return false;
  const normalized = entryPath.replace(/\\/g, '/');
  return !normalized.split('/').some((segment) => segment === '..');
}
