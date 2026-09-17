/**
 * `node:sqlite` driver adapter.
 *
 * Used by the test suites so migrations, repositories and queries run against
 * a real SQLite engine without needing a native module build. Not used in the
 * packaged application, which uses better-sqlite3 in the database worker.
 */

import { DatabaseSync } from 'node:sqlite';
import type { SqlValue, SqliteDriver, SqliteStatement } from '../driver.ts';

export function openNodeSqlite(path = ':memory:'): SqliteDriver {
  const db = new DatabaseSync(path);

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
    supportsOnlineBackup: false,
  };

  return driver;
}
