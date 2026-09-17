/**
 * better-sqlite3 driver adapter — the production driver.
 *
 * This module is only ever imported inside the database worker, which is the
 * sole owner of SQLite writes. The native binding must be rebuilt for the exact
 * Electron ABI; scripts/verify-package.mjs checks that the packaged build can
 * actually load it, because a passing Node unit test does not prove that.
 */

import Database from 'better-sqlite3';
import type { SqlValue, SqliteDriver, SqliteStatement } from '../driver.ts';

export interface BetterSqliteOptions {
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
}

export function openBetterSqlite(path: string, options: BetterSqliteOptions = {}): SqliteDriver {
  const db = new Database(path, {
    readonly: options.readonly ?? false,
    fileMustExist: options.fileMustExist ?? false,
  });

  const driver: SqliteDriver = {
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string): SqliteStatement {
      const stmt = db.prepare(sql);
      return {
        run(...params) {
          const result = stmt.run(...(params as SqlValue[]));
          return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
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
      const result = db.pragma(name, { simple: true });
      return (result ?? null) as SqlValue;
    },
    setPragma(statement: string): void {
      db.pragma(statement);
    },
    supportsOnlineBackup: true,
    /**
     * SQLite's online backup API, via better-sqlite3's `backup`.
     * This is the only valid way to copy a live WAL database.
     */
    async backupTo(destinationPath: string): Promise<void> {
      await db.backup(destinationPath);
    },
  };

  return driver;
}
