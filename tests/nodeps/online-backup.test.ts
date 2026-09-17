/**
 * Online backup, against a real live database.
 *
 * These specs could not exist before. The application used better-sqlite3 while
 * the specs used `node:sqlite`, and only the former had an online backup API —
 * so the backup path was covered by a manual smoke run that established one
 * thing: that a driver *without* the capability was refused. Whether a backup
 * that actually ran produced a restorable file had never been checked by
 * anything.
 *
 * Both now use `node:sqlite`, so the driver under test is the driver that
 * ships.
 *
 * The rule being defended: copying the main database file while write-ahead
 * logging is active produces an archive that opens, looks complete, and is
 * missing every committed transaction still sitting in the WAL. A backup nobody
 * can restore is worse than an honest refusal to make one, so the refusal path
 * is tested as carefully as the success path.
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createBackup, sha256OfFile, validateRestoreCandidate } from '../../src/database/backup.ts';
import { applyConnectionPragmas, type SqliteDriver } from '../../src/database/driver.ts';
import { ONLINE_BACKUP_AVAILABLE, openNodeSqlite } from '../../src/database/drivers/node-sqlite.ts';
import { MIGRATIONS } from '../../src/database/migrations/index.ts';
import { migrate } from '../../src/database/migrator.ts';
import { T0 } from './helpers.ts';

const APP_VERSION = '0.1.0-spec';

/** A migrated database on disk in WAL mode, with `siteCount` sites. */
async function liveDatabase(dir: string, siteCount: number) {
  const path = join(dir, 'chargewatch.sqlite');
  const driver = openNodeSqlite(path);
  applyConnectionPragmas(driver);
  const outcome = migrate(driver, MIGRATIONS, { appVersion: APP_VERSION, nowMs: T0 });
  assert.equal(outcome.status, 'migrated', JSON.stringify(outcome));

  insertSites(driver, 0, siteCount);
  return { path, driver };
}

/** Inserts `count` sites with ids starting at `from`. */
function insertSites(driver: SqliteDriver, from: number, count: number): void {
  const insert = driver.prepare(
    `INSERT INTO sites (id, name, latitude, longitude, street_address, network, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let index = from; index < from + count; index += 1) {
    insert.run(
      `site-${index}`,
      `Station ${index}`,
      33.4152 + (index % 100) / 1000,
      -111.8315 - (index % 100) / 1000,
      `${index} Test Way, Mesa, AZ`,
      'SpecNet',
      T0,
      T0,
    );
  }
}

describe('the shipping driver can take an online backup', () => {
  it('exposes the capability, detected rather than assumed', () => {
    // If this ever fails, the Node or Electron in use dropped the API. That is
    // a real product change — backups stop working — not a spec to relax.
    assert.equal(
      ONLINE_BACKUP_AVAILABLE,
      true,
      'node:sqlite has no backup() here, so ChargeWatch cannot make backups on this runtime',
    );
    const driver = openNodeSqlite(':memory:');
    assert.equal(driver.supportsOnlineBackup, true);
    assert.equal(typeof driver.backupTo, 'function');
    driver.close();
  });
});

describe('a backup of a live WAL database', () => {
  it('produces a verified file that restores with every row intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cw-backup-'));
    try {
      const { driver } = await liveDatabase(dir, 250);
      assert.equal(driver.pragmaValue('journal_mode'), 'wal', 'the test needs WAL to be meaningful');

      const backupDir = join(dir, 'backups');
      const result = await createBackup({
        driver,
        backupDir,
        kind: 'manual',
        appVersion: APP_VERSION,
        nowMs: T0,
        openForVerify: openNodeSqlite,
      });

      assert.equal(result.verified, true, 'a backup is not published until it has been verified');
      assert.equal(result.manifest.siteCount, 250);
      assert.equal(result.manifest.schemaVersion, 1);
      assert.equal(result.manifest.appVersion, APP_VERSION);

      // The recorded digest and size must describe the file on disk, or a
      // later integrity check would compare against fiction.
      const onDisk = await stat(result.filePath);
      assert.equal(onDisk.size, result.manifest.byteSize);
      assert.equal(await sha256OfFile(result.filePath), result.manifest.sha256);

      // Nothing partial left behind.
      await assert.rejects(stat(`${result.filePath}.partial`), 'the staging file must be gone');

      // And it is genuinely restorable, by the same code a restore uses.
      const preview = await validateRestoreCandidate({
        candidatePath: result.filePath,
        openForVerify: openNodeSqlite,
        expectedSha256: result.manifest.sha256,
      });
      assert.equal(preview.ok, true, `restore preview rejected the backup: ${preview.detail ?? ''}`);
      assert.equal(preview.siteCount, 250);

      driver.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('captures rows committed but not yet checkpointed out of the WAL', async () => {
    // This is the whole point. A file copy taken at this moment would miss
    // these rows while still opening cleanly, which is the failure mode that
    // makes a bad backup so dangerous: it looks like a good one.
    const dir = await mkdtemp(join(tmpdir(), 'cw-backup-wal-'));
    try {
      const { path, driver } = await liveDatabase(dir, 10);

      const beforeMainFile = (await stat(path)).size;
      insertSites(driver, 100, 800);

      // Those 800 rows are committed. Whether they have reached the main file
      // yet is up to SQLite; the backup must include them either way.
      const walPath = `${path}-wal`;
      const walSize = await stat(walPath)
        .then((s) => s.size)
        .catch(() => 0);

      const result = await createBackup({
        driver,
        backupDir: join(dir, 'backups'),
        kind: 'daily',
        appVersion: APP_VERSION,
        nowMs: T0,
        openForVerify: openNodeSqlite,
      });

      assert.equal(result.manifest.siteCount, 810, 'the backup must contain every committed row');

      const restored = openNodeSqlite(result.filePath, { readOnly: true });
      const count = Number(restored.prepare('SELECT COUNT(*) AS c FROM sites').get()?.c ?? 0);
      assert.equal(count, 810);
      assert.equal(restored.pragmaValue('integrity_check'), 'ok');
      restored.close();

      // Report what the test actually exercised, so a future reader can tell
      // whether the WAL was still holding data at backup time.
      assert.ok(
        walSize > 0 || beforeMainFile > 0,
        'diagnostic only: WAL size at backup time was ' + String(walSize),
      );

      driver.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records the backup in the database, marked verified', async () => {
    // The manifest lives in the `backups` table rather than a sidecar file, so
    // the record cannot drift away from the history it describes.
    const dir = await mkdtemp(join(tmpdir(), 'cw-backup-manifest-'));
    try {
      const { driver } = await liveDatabase(dir, 3);
      const result = await createBackup({
        driver,
        backupDir: join(dir, 'backups'),
        kind: 'pre_update',
        appVersion: APP_VERSION,
        nowMs: T0,
        openForVerify: openNodeSqlite,
      });

      const row = driver
        .prepare('SELECT kind, file_sha256, byte_size, verified, manifest_json FROM backups WHERE id = ?')
        .get(result.manifest.id);
      assert.ok(row, 'the backup must be recorded');
      assert.equal(row.kind, 'pre_update');
      assert.equal(row.file_sha256, result.manifest.sha256);
      assert.equal(row.byte_size, result.manifest.byteSize);
      assert.equal(row.verified, 1, 'only a verified backup is recorded as one');

      const stored = JSON.parse(String(row.manifest_json)) as Record<string, unknown>;
      assert.equal(stored.formatVersion, 1);
      assert.equal(stored.siteCount, 3);

      driver.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('a driver that cannot do an online backup', () => {
  /** Wraps a real driver but denies the capability, the way an older runtime would. */
  function withoutBackupSupport(driver: SqliteDriver): SqliteDriver {
    return { ...driver, supportsOnlineBackup: false, backupTo: undefined };
  }

  it('is refused rather than falling back to copying the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cw-backup-refuse-'));
    try {
      const { driver } = await liveDatabase(dir, 5);
      await assert.rejects(
        createBackup({
          driver: withoutBackupSupport(driver),
          backupDir: join(dir, 'backups'),
          kind: 'manual',
          appVersion: APP_VERSION,
          nowMs: T0,
          openForVerify: openNodeSqlite,
        }),
        /cannot perform an online backup/i,
      );
      driver.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is refused even when it claims support but has no implementation', async () => {
    // A driver whose flag and behaviour disagree must not be trusted on the
    // flag alone, or the refusal could be bypassed by a single wrong boolean.
    const dir = await mkdtemp(join(tmpdir(), 'cw-backup-lying-'));
    try {
      const { driver } = await liveDatabase(dir, 5);
      await assert.rejects(
        createBackup({
          driver: { ...driver, supportsOnlineBackup: true, backupTo: undefined },
          backupDir: join(dir, 'backups'),
          kind: 'manual',
          appVersion: APP_VERSION,
          nowMs: T0,
          openForVerify: openNodeSqlite,
        }),
        /cannot perform an online backup/i,
      );
      driver.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
