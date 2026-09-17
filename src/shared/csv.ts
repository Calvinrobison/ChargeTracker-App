/**
 * CSV writing for exports.
 *
 * Two properties this module guarantees:
 *
 *  1) RFC 4180 quoting. A field containing a comma, a double quote, a carriage
 *     return or a newline is wrapped in double quotes with internal quotes
 *     doubled.
 *
 *  2) Spreadsheet formula injection is neutralised in UNTRUSTED TEXT cells
 *     only. Station names, notes and error messages come from a source we do
 *     not control; a cell beginning `=`, `+`, `-`, `@`, a tab or a carriage
 *     return can execute in Excel, Sheets and LibreOffice. Such a text cell is
 *     prefixed with a single apostrophe (U+0027), which those applications
 *     treat as "the rest is literal text".
 *
 *     Numeric MEASUREMENTS are never transformed, so a negative value stays a
 *     usable number. This is why cells are typed rather than stringly: the
 *     writer must know which cells are measurements.
 *
 * The transformation is documented for users in docs/USER_GUIDE.md and
 * reproduced in the export's own README column notes.
 */

export const FORMULA_INJECTION_PREFIX = "'";

/** Characters that make a spreadsheet treat a cell as a formula or command. */
const DANGEROUS_LEADING = new Set(['=', '+', '-', '@', '\t', '\r']);

export type CsvCell =
  | { readonly kind: 'text'; readonly value: string | null }
  | { readonly kind: 'number'; readonly value: number | null }
  /** A pre-formatted value the app produced itself, e.g. an ISO timestamp. */
  | { readonly kind: 'trusted'; readonly value: string | null };

export function text(value: string | null | undefined): CsvCell {
  return { kind: 'text', value: value === undefined ? null : value };
}

export function number(value: number | null | undefined): CsvCell {
  return { kind: 'number', value: value === undefined ? null : value };
}

export function trusted(value: string | null | undefined): CsvCell {
  return { kind: 'trusted', value: value === undefined ? null : value };
}

/**
 * Renders a number for export.
 *
 * A missing value is an EMPTY field, never a convincing zero.
 */
export function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '';
  if (Number.isInteger(value)) return String(value);
  // Six decimals is enough for port-minutes and percentages without noise.
  return String(Math.round(value * 1e6) / 1e6);
}

function neutralizeFormula(raw: string): string {
  if (raw.length === 0) return raw;
  const first = raw[0] as string;
  if (DANGEROUS_LEADING.has(first)) return `${FORMULA_INJECTION_PREFIX}${raw}`;
  return raw;
}

function quote(field: string): string {
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

export function renderCell(cell: CsvCell): string {
  switch (cell.kind) {
    case 'number':
      return formatNumber(cell.value);
    case 'trusted':
      return quote(cell.value ?? '');
    case 'text':
      return quote(neutralizeFormula(cell.value ?? ''));
    default: {
      const exhaustive: never = cell;
      throw new TypeError(`unknown cell kind ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function renderRow(cells: readonly CsvCell[]): string {
  return cells.map(renderCell).join(',');
}

export interface CsvDocumentOptions {
  readonly headers: readonly string[];
  readonly rows: Iterable<readonly CsvCell[]>;
  /** Written as a leading `# ` comment block, e.g. filters and metric version. */
  readonly provenanceComments?: readonly string[];
  readonly lineEnding?: '\r\n' | '\n';
}

/**
 * Renders a complete CSV document as an iterable of lines, so a large export
 * can be streamed to disk rather than assembled in memory.
 */
export function* csvLines(options: CsvDocumentOptions): Generator<string> {
  const eol = options.lineEnding ?? '\r\n';
  for (const comment of options.provenanceComments ?? []) {
    // Comments are app-authored, but still quoted defensively if they contain
    // a newline, which would otherwise break the file.
    yield `# ${comment.replace(/[\r\n]+/g, ' ')}${eol}`;
  }
  yield `${options.headers.map((h) => quote(h)).join(',')}${eol}`;
  for (const row of options.rows) {
    if (row.length !== options.headers.length) {
      throw new RangeError(
        `CSV row has ${row.length} cells but ${options.headers.length} headers were declared`,
      );
    }
    yield `${renderRow(row)}${eol}`;
  }
}

export function csvString(options: CsvDocumentOptions): string {
  let out = '';
  for (const line of csvLines(options)) out += line;
  return out;
}

/** Filename with area and date range, e.g. `chargewatch-mesa-2026-08-18_2026-09-17-occupancy.csv`. */
export function exportFileName(parts: {
  readonly area: string;
  readonly fromIsoDate: string;
  readonly toIsoDate: string;
  readonly kind: string;
}): string {
  const slug = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  return `chargewatch-${slug(parts.area)}-${parts.fromIsoDate}_${parts.toIsoDate}-${slug(parts.kind)}.csv`;
}
