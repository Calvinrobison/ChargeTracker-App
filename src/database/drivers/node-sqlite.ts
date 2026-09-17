/**
 * `node:sqlite` driver adapter — the production driver.
 *
 * SQLite ships inside Node, and Electron ships Node, so the application needs
 * no native module of its own. That removes a whole class of failure: no ABI
 * rebuild against each Electron version, no `asarUnpack` configuration, no
 * compiler toolchain on the build machine, and no "works in tests, cannot load
 * when packaged" gap between what the specs exercise and what ships.
 *
 * That gap used to be real. The specs ran on this driver while the application
 * ran on better-sqlite3, so every database spec proved something about code
 * that was not the code being shipped. Now they are the same driver.
 *
 * ONLINE BACKUP
 *
 * `backupTo` uses `node:sqlite`'s `backup()`, which is SQLite's online backup
 * API — the only valid way to copy a database with write-ahead logging active.
 * Copying the main database file while WAL writes are in flight produces an
 * archive that looks fine and is subtly corrupt.
 *
 * Whether that function exists is DETECTED at load time rather than assumed,
 * because it arrived in a specific Node version and Electron chooses its own
 * Node. If it is absent, `supportsOnlineBackup` is false and
 * `src/database/backup.ts` refuses to make a backup at all. That refusal is the
 * correct behaviour, not a limitation to route around: a backup nobody can
 * restore is worse than an honest refusal to make one.
 */

import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import type { SqlValue, SqliteDriver, SqliteStatement } from '../driver.ts';

/**
 * Whether this Node build exposes SQLite's online backup API.
 *
 * Checked once, by inspection, rather than trusted from a version number.
 */
export const ONLINE_BACKUP_AVAILABLE: boolean = typeof sqliteBackup === 'function';

export interface NodeSqliteOptions {
  readonly readOnly?: boolean;
  /**
   * Rate-limits the backup in pages per step, so a large backup does not hold
   * the database against the collector for the whole copy.
   */
  readonly backupPagesPerStep?: number;
}

export function openNodeSqlite(path = ':memory:', options: NodeSqliteOptions = {}): SqliteDriver {
  const db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });

  const driver: SqliteDriver = {
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string): SqliteStatement {
      const stmt = db.prepare(sql);
      return {
        run(...params) {
          const result = stmt.run(...(params as SqlValue[]));
          return {
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid,
          };
        },
        get(...params) {
          return stmt.get(...(params as SqlValue[])) as Record<string, SqlValue> | undefined;
        },
        all(...params) {
          return stmt.all(...(params as SqlValue[])) as Array<Record<string, SqlValue>>;
        },
      };
    },
    close(): void {
      db.close();
    },
    pragmaValue(name: string): SqlValue {
      const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, SqlValue> | undefined;
      if (!row) return null;
      return Object.values(row)[0] ?? null;
    },
    setPragma(statement: string): void {
      db.exec(`PRAGMA ${statement}`);
    },

    supportsOnlineBackup: ONLINE_BACKUP_AVAILABLE,

    ...(ONLINE_BACKUP_AVAILABLE
      ? {
          async backupTo(destinationPath: string): Promise<void> {
            await sqliteBackup(db, destinationPath, {
              rate: options.backupPagesPerStep ?? 100,
            });
          },
        }
      : {}),
  };

  return driver;
}
