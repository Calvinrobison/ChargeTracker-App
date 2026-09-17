/**
 * CSV import parsing (§17 imports, §21 round trip).
 *
 * Run: node --experimental-strip-types --test tests/nodeps/csv-read.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  columnIndex,
  parseCsv,
  parseIsoInstant,
  parseNonNegativeInteger,
  unescapeExportedCell,
} from '../../src/shared/csv-read.ts';
import { csvString, number, text, trusted } from '../../src/shared/csv.ts';
import { VISIT_TEMPLATE_HEADERS } from '../../src/domain/visits.ts';

describe('tokenising', () => {
  test('a simple file parses into headers and rows', () => {
    const result = parseCsv('a,b,c\r\n1,2,3\r\n4,5,6\r\n');
    assert.deepEqual(result.headers, ['a', 'b', 'c']);
    assert.equal(result.rows.length, 2);
    assert.deepEqual(result.rows[0]?.cells, ['1', '2', '3']);
    assert.equal(result.errors.length, 0);
  });

  test('LF-only line endings work', () => {
    const result = parseCsv('a,b\n1,2\n');
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.rows[0]?.cells, ['1', '2']);
  });

  test('a BOM does not become part of the first header name', () => {
    const result = parseCsv('﻿site_id,visit_count\r\ns1,10\r\n');
    assert.equal(result.headers[0], 'site_id');
  });

  test('quoted commas, quotes and newlines are preserved', () => {
    const result = parseCsv('a,b\r\n"Mesa, AZ","say ""hi"""\r\n"line1\nline2",x\r\n');
    assert.deepEqual(result.rows[0]?.cells, ['Mesa, AZ', 'say "hi"']);
    assert.deepEqual(result.rows[1]?.cells, ['line1\nline2', 'x']);
  });

  test('blank lines and comment lines are skipped', () => {
    const result = parseCsv('# a comment\r\na,b\r\n\r\n1,2\r\n# another\r\n3,4\r\n');
    assert.deepEqual(result.headers, ['a', 'b']);
    assert.equal(result.rows.length, 2);
  });

  test('an empty file is reported rather than silently accepted', () => {
    const result = parseCsv('');
    assert.equal(result.rows.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]?.message ?? '', /empty/);
  });
});

describe('malformed rows', () => {
  test('a row with the wrong column count is rejected, never padded', () => {
    const result = parseCsv('a,b,c\r\n1,2,3\r\n4,5\r\n6,7,8,9\r\n');
    assert.equal(result.rows.length, 1, 'only the well-formed row is accepted');
    assert.equal(result.errors.length, 2);
    assert.match(result.errors[0]?.message ?? '', /expected 3 columns but found 2/);
    assert.equal(result.errors[0]?.lineNumber, 3, 'the line number points at the bad row');
  });

  test('missing required columns are reported by name', () => {
    const result = parseCsv('site_id,visit_count\r\ns1,10\r\n', {
      expectedHeaders: ['site_id', 'period_start', 'period_end', 'visit_count'],
    });
    assert.match(result.errors[0]?.message ?? '', /period_start/);
    assert.match(result.errors[0]?.message ?? '', /period_end/);
  });

  test('a row cap stops a runaway file', () => {
    const body = Array.from({ length: 50 }, (_, i) => `${i},x`).join('\r\n');
    const result = parseCsv(`a,b\r\n${body}\r\n`, { maxRows: 10 });
    assert.equal(result.rows.length, 10);
    assert.match(result.errors[0]?.message ?? '', /more than 10 rows/);
  });
});

describe('column lookup', () => {
  test('column order in the file does not matter', () => {
    const result = parseCsv('visit_count,site_id\r\n42,s1\r\n');
    const index = columnIndex(result.headers);
    const row = result.rows[0];
    assert.equal(row?.cells[index('site_id')], 's1');
    assert.equal(row?.cells[index('visit_count')], '42');
    assert.equal(index('not_a_column'), -1);
  });

  test('lookup is case and whitespace insensitive', () => {
    const index = columnIndex([' Site_ID ', 'VISIT_COUNT']);
    assert.equal(index('site_id'), 0);
    assert.equal(index('visit_count'), 1);
  });
});

describe('round trip with our own exporter', () => {
  test('a formula-neutralised cell comes back unchanged', () => {
    assert.equal(unescapeExportedCell("'=SUM(A1)"), '=SUM(A1)');
    assert.equal(unescapeExportedCell("'-5"), '-5');
    assert.equal(unescapeExportedCell("it's fine"), "it's fine", 'an ordinary apostrophe is kept');
    assert.equal(unescapeExportedCell("'"), "'");
  });

  test('export then import preserves the values exactly', () => {
    const exported = csvString({
      headers: ['station', 'occupancy_pct', 'observed_at'],
      rows: [
        [text('=HYPERLINK("x")'), number(-12.5), trusted('2026-09-17T07:42:00Z')],
        [text('Mesa, AZ "Riverview"'), number(null), trusted(null)],
      ],
      lineEnding: '\r\n',
    });
    const parsed = parseCsv(exported);
    assert.deepEqual(parsed.headers, ['station', 'occupancy_pct', 'observed_at']);
    assert.deepEqual(parsed.rows[0]?.cells, ['=HYPERLINK("x")', '-12.5', '2026-09-17T07:42:00Z']);
    assert.deepEqual(parsed.rows[1]?.cells, ['Mesa, AZ "Riverview"', '', '']);
    assert.equal(parsed.errors.length, 0);
  });

  test('the visit template round trips through the parser', () => {
    const csv = `${VISIT_TEMPLATE_HEADERS.join(',')}\r\ns1,2026-09-01T00:00:00-07:00,2026-10-01T00:00:00-07:00,America/Phoenix,12345,property_entries,measured,Door counter,https://example.com,whole_property,notes\r\n`;
    const parsed = parseCsv(csv, { expectedHeaders: VISIT_TEMPLATE_HEADERS });
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.rows.length, 1);
  });
});

describe('timestamp parsing', () => {
  test('an explicit offset or Z is accepted', () => {
    const utc = parseIsoInstant('2026-09-01T07:00:00Z');
    assert.equal(utc.ok, true);
    const phoenix = parseIsoInstant('2026-09-01T00:00:00-07:00');
    assert.equal(phoenix.ok, true);
    if (utc.ok && phoenix.ok) {
      assert.equal(utc.ms, phoenix.ms, 'midnight in Phoenix is 07:00 UTC');
    }
  });

  test('an ambiguous timestamp with no zone is refused rather than guessed', () => {
    for (const ambiguous of [
      '2026-09-01T00:00:00',
      '2026-09-01 00:00',
      '09/01/2026',
      'September 1 2026',
      '',
    ]) {
      const result = parseIsoInstant(ambiguous);
      assert.equal(result.ok, false, `${ambiguous} must be refused`);
      if (!result.ok) assert.match(result.reason, /explicit offset|empty/);
    }
  });

  test('a timestamp outside the supported range is refused', () => {
    assert.equal(parseIsoInstant('1799-01-01T00:00:00Z').ok, false);
    assert.equal(parseIsoInstant('2999-01-01T00:00:00Z').ok, false);
  });
});

describe('integer parsing', () => {
  test('a whole non-negative number parses, with thousands separators allowed', () => {
    assert.deepEqual(parseNonNegativeInteger('0'), { ok: true, value: 0 });
    assert.deepEqual(parseNonNegativeInteger('12345'), { ok: true, value: 12345 });
    assert.deepEqual(parseNonNegativeInteger('12,345'), { ok: true, value: 12345 });
  });

  test('an empty cell is not zero', () => {
    const result = parseNonNegativeInteger('');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /empty/);
  });

  test('negatives, fractions and text are refused', () => {
    for (const bad of ['-1', '1.5', '1e3', 'twelve', '12 ports', 'NaN', 'Infinity']) {
      assert.equal(parseNonNegativeInteger(bad).ok, false, `${bad} must be refused`);
    }
  });
});
