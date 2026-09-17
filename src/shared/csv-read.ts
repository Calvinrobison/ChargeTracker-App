/**
 * CSV parsing for user imports.
 *
 * Deliberately strict and boring. An import is untrusted input, and the
 * failure mode that matters is a row that parses into the WRONG numbers rather
 * than one that fails loudly. So:
 *  - RFC 4180 quoting, including embedded commas, quotes and newlines;
 *  - a BOM is stripped rather than becoming part of the first header name;
 *  - CRLF and LF both work;
 *  - a row whose field count does not match the header is rejected, not padded;
 *  - the apostrophe our own exporter adds to neutralise formula injection is
 *    stripped back off on read, so a round trip is lossless;
 *  - nothing is coerced. Numbers and dates are parsed by the caller with its
 *    own validation, because only the caller knows what "0" versus "" means.
 */

export interface CsvRow {
  /** 1-based line number in the source file, for error messages. */
  readonly lineNumber: number;
  readonly cells: readonly string[];
}

export interface CsvParseResult {
  readonly headers: readonly string[];
  readonly rows: readonly CsvRow[];
  readonly errors: readonly { readonly lineNumber: number; readonly message: string }[];
}

const BOM = '﻿';

/** Tokenises CSV text into physical rows, honouring quoted newlines. */
function tokenize(text: string): { cells: string[]; lineNumber: number }[] {
  const rows: { cells: string[]; lineNumber: number }[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let lineNumber = 1;
  let rowStartLine = 1;
  let sawAnyContent = false;

  const endField = (): void => {
    cells.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    rows.push({ cells, lineNumber: rowStartLine });
    cells = [];
    rowStartLine = lineNumber;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') lineNumber += 1;
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      inQuotes = true;
      sawAnyContent = true;
      continue;
    }
    if (char === ',') {
      endField();
      sawAnyContent = true;
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      lineNumber += 1;
      if (sawAnyContent || cells.length > 0 || field.length > 0) {
        endRow();
      } else {
        rowStartLine = lineNumber;
      }
      sawAnyContent = false;
      continue;
    }
    field += char;
    sawAnyContent = true;
  }

  if (field.length > 0 || cells.length > 0) endRow();
  return rows;
}

/**
 * Strips the leading apostrophe our exporter adds to neutralise spreadsheet
 * formula injection, so exporting and re-importing is lossless.
 */
export function unescapeExportedCell(value: string): string {
  if (value.startsWith("'") && value.length > 1) {
    const next = value[1] as string;
    if (['=', '+', '-', '@', '\t', '\r'].includes(next)) return value.slice(1);
  }
  return value;
}

export interface ParseCsvOptions {
  /** Expected header names, compared case-insensitively after trimming. */
  readonly expectedHeaders?: readonly string[];
  readonly maxRows?: number;
}

export function parseCsv(text: string, options: ParseCsvOptions = {}): CsvParseResult {
  const cleaned = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const physical = tokenize(cleaned);
  const errors: { lineNumber: number; message: string }[] = [];

  if (physical.length === 0) {
    return { headers: [], rows: [], errors: [{ lineNumber: 1, message: 'the file is empty' }] };
  }

  // Skip leading `#` comment lines, which our own exports write.
  let headerIndex = 0;
  while (
    headerIndex < physical.length &&
    (physical[headerIndex]?.cells[0] ?? '').trimStart().startsWith('#')
  ) {
    headerIndex += 1;
  }
  const headerRow = physical[headerIndex];
  if (!headerRow) {
    return {
      headers: [],
      rows: [],
      errors: [{ lineNumber: 1, message: 'the file has no header row' }],
    };
  }

  const headers = headerRow.cells.map((cell) => unescapeExportedCell(cell).trim());

  if (options.expectedHeaders) {
    const normalize = (value: string): string => value.trim().toLowerCase();
    const actual = headers.map(normalize);
    const missing = options.expectedHeaders.filter((expected) => !actual.includes(normalize(expected)));
    if (missing.length > 0) {
      errors.push({
        lineNumber: headerRow.lineNumber,
        message: `missing required column(s): ${missing.join(', ')}`,
      });
    }
  }

  const maxRows = options.maxRows ?? 200_000;
  const rows: CsvRow[] = [];

  for (let i = headerIndex + 1; i < physical.length; i += 1) {
    const row = physical[i];
    if (!row) continue;
    // A wholly blank line is skipped rather than reported.
    if (row.cells.length === 1 && (row.cells[0] ?? '').trim().length === 0) continue;
    if ((row.cells[0] ?? '').trimStart().startsWith('#')) continue;

    if (rows.length >= maxRows) {
      errors.push({
        lineNumber: row.lineNumber,
        message: `the file has more than ${maxRows} rows; import it in smaller parts`,
      });
      break;
    }
    if (row.cells.length !== headers.length) {
      // Never pad or truncate: a shifted row would import the wrong numbers.
      errors.push({
        lineNumber: row.lineNumber,
        message: `expected ${headers.length} columns but found ${row.cells.length}`,
      });
      continue;
    }
    rows.push({
      lineNumber: row.lineNumber,
      cells: row.cells.map((cell) => unescapeExportedCell(cell).trim()),
    });
  }

  return { headers, rows, errors };
}

/** Builds a header-name lookup so column order in the file does not matter. */
export function columnIndex(headers: readonly string[]): (name: string) => number {
  const map = new Map<string, number>();
  headers.forEach((header, index) => map.set(header.trim().toLowerCase(), index));
  return (name: string) => map.get(name.trim().toLowerCase()) ?? -1;
}

/**
 * Parses an explicit ISO timestamp.
 *
 * An offset or a `Z` is REQUIRED: a bare "2026-09-01 00:00" is ambiguous, and
 * guessing a zone would silently shift someone's monthly totals.
 */
export function parseIsoInstant(value: string): { ok: true; ms: number } | { ok: false; reason: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'the timestamp is empty' };
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    return {
      ok: false,
      reason:
        'expected an ISO timestamp with an explicit offset, for example 2026-09-01T00:00:00-07:00 or 2026-09-01T07:00:00Z',
    };
  }
  const parsed = Date.parse(trimmed.replace(' ', 'T'));
  if (!Number.isFinite(parsed)) return { ok: false, reason: 'the timestamp could not be parsed' };
  if (parsed < 0 || parsed > 4_102_444_800_000) {
    return { ok: false, reason: 'the timestamp is outside the supported range' };
  }
  return { ok: true, ms: parsed };
}

/** Parses a non-negative integer. An empty cell is NOT zero. */
export function parseNonNegativeInteger(
  value: string,
): { ok: true; value: number } | { ok: false; reason: string } {
  const trimmed = value.trim().replace(/,/g, '');
  if (trimmed.length === 0) return { ok: false, reason: 'the value is empty' };
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, reason: `"${value}" is not a whole, non-negative number` };
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return { ok: false, reason: 'the value is too large' };
  return { ok: true, value: parsed };
}
