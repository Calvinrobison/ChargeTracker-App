/**
 * A minimal synchronous SQLite driver interface.
 *
 * Production and the specs both use node:sqlite. Tests can run the
 * identical SQL, migrations and repositories against Node's built-in
 * `node:sqlite`, which means the schema and queries are exercised against a
 * real SQLite engine rather than a mock.
 *
 * Only the operations the product actually needs are in this interface; there
 * is deliberately no way to hand arbitrary SQL to a caller outside this
 * module's owners.
 */

export interface SqliteStatement {
  run(...params: readonly SqlValue[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  get(...params: readonly SqlValue[]): Record<string, SqlValue> | undefined;
  all(...params: readonly SqlValue[]): Array<Record<string, SqlValue>>;
}

export type SqlValue = string | number | bigint | Uint8Array | null;

export interface SqliteDriver {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  /** Reads a pragma that returns a single scalar value. */
  pragmaValue(name: string): SqlValue;
  /** Sets a pragma. */
  setPragma(statement: string): void;
  /**
   * SQLite's online backup, when the driver supports it. Copying only the main
   * database file while WAL writes are active is NOT a valid backup, so a
   * driver without this must report false from `supportsOnlineBackup`.
   */
  readonly supportsOnlineBackup: boolean;
  backupTo?(destinationPath: string): Promise<void>;
}

/** Pragmas applied to every connection, in this order. */
export const CONNECTION_PRAGMAS: readonly string[] = [
  'journal_mode = WAL',
  'foreign_keys = ON',
  'busy_timeout = 5000',
  'synchronous = NORMAL',
  'temp_store = MEMORY',
  'trusted_schema = OFF',
];

export interface PragmaReport {
  readonly journalMode: string;
  readonly foreignKeys: boolean;
  readonly busyTimeoutMs: number;
}

/**
 * Applies the standard pragmas and reports what SQLite actually accepted.
 *
 * WAL is unavailable on some filesystems; the caller records the real journal
 * mode rather than assuming WAL succeeded.
 */
export function applyConnectionPragmas(driver: SqliteDriver): PragmaReport {
  for (const pragma of CONNECTION_PRAGMAS) {
    try {
      driver.setPragma(pragma);
    } catch {
      // A rejected pragma is reported through the returned state, not thrown:
      // an unusual filesystem must not prevent the app from opening at all.
    }
  }
  const journalMode = String(driver.pragmaValue('journal_mode') ?? 'unknown');
  const foreignKeys = Number(driver.pragmaValue('foreign_keys') ?? 0) === 1;
  const busyTimeoutMs = Number(driver.pragmaValue('busy_timeout') ?? 0);
  return { journalMode, foreignKeys, busyTimeoutMs };
}

/** Nesting depth per connection, so composed writes are one atomic unit. */
const transactionDepth = new WeakMap<SqliteDriver, number>();

/**
 * Runs `fn` inside a write transaction, rolling back on any throw.
 *
 * The outermost call uses BEGIN IMMEDIATE, which acquires the write lock up
 * front so two writers fail fast instead of deadlocking halfway through a
 * batch. Nested calls use SAVEPOINTs, so a higher-level operation can compose
 * several repository writes (an ingest plus an aggregate invalidation, say)
 * into a single atomic unit without the repositories knowing about each other.
 * An inner failure rolls back only to its savepoint, letting the caller decide
 * whether to abandon the whole batch.
 */
export function transact<T>(driver: SqliteDriver, fn: () => T): T {
  const depth = transactionDepth.get(driver) ?? 0;
  const savepoint = depth > 0 ? `cw_sp_${depth}` : null;

  if (savepoint) driver.exec(`SAVEPOINT ${savepoint}`);
  else driver.exec('BEGIN IMMEDIATE');
  transactionDepth.set(driver, depth + 1);

  try {
    const result = fn();
    if (savepoint) driver.exec(`RELEASE ${savepoint}`);
    else driver.exec('COMMIT');
    transactionDepth.set(driver, depth);
    return result;
  } catch (error) {
    try {
      if (savepoint) driver.exec(`ROLLBACK TO ${savepoint}`);
      else driver.exec('ROLLBACK');
    } catch {
      // A rollback failure must not mask the original error.
    }
    transactionDepth.set(driver, depth);
    throw error;
  }
}

/** True while this connection is inside a write transaction. */
export function inTransaction(driver: SqliteDriver): boolean {
  return (transactionDepth.get(driver) ?? 0) > 0;
}

/** Result of an integrity check. */
export interface IntegrityResult {
  readonly ok: boolean;
  readonly details: readonly string[];
  readonly foreignKeyViolations: number;
}

export function checkIntegrity(driver: SqliteDriver): IntegrityResult {
  const rows = driver.prepare('PRAGMA integrity_check').all();
  const details = rows.map((row) => String(Object.values(row)[0] ?? ''));
  const fkRows = driver.prepare('PRAGMA foreign_key_check').all();
  return {
    ok: details.length === 1 && details[0] === 'ok' && fkRows.length === 0,
    details,
    foreignKeyViolations: fkRows.length,
  };
}
