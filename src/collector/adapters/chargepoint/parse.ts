/**
 * ChargePoint extraction — pure, browser-free.
 *
 * The adapter's browser code produces a `PageReading` (a structured snapshot
 * of the rendered status region) and this module turns it into an observation.
 * Keeping extraction pure means the tricky parts — ambiguous status words,
 * missing counts, layout changes, identity mismatch — are testable against
 * fixtures without launching Chromium.
 *
 * Honesty rules encoded here:
 *  - Port identity is used ONLY when the page carries a durable identifier.
 *    Two repeated rows in display order do not establish stable port identity,
 *    so without identifiers we record honest SITE-LEVEL counts and no ports.
 *  - "Last used" text is not a transaction count and never becomes one.
 *  - A status word we do not recognise becomes `unknown`, never `available`.
 *  - A missing dimension stays null. Nothing is derived by subtraction.
 *  - The station identity on the page is checked against the binding, so a
 *    redirect or a stale single-page-app render cannot write one site's counts
 *    onto another.
 */

import type { ChargingLevel, PortState, StateCounts } from '../../../domain/types.ts';
import type { AttemptOutcome } from '../../../domain/types.ts';

/**
 * Bumped 0.1.0 → 0.2.0 on 2026-09-21: the first version to read the real
 * station page. 0.1.0 was written blind and matched nothing on it.
 */
export const PARSER_VERSION = 'chargepoint-dom@0.2.0';

/**
 * The locale the adapter explicitly requests from the source, so status-word
 * matching is not an unstated English-only assumption.
 */
export const REQUESTED_LOCALE = 'en-US';

export type PageState =
  | 'status_present'
  | 'loading'
  | 'no_results'
  | 'source_error'
  | 'empty_status'
  | 'login_required'
  | 'challenge';

export interface PortRowReading {
  /** Visible label, e.g. "Port 1". Display order only; not an identity. */
  readonly label: string | null;
  readonly statusText: string | null;
  /**
   * The provider's own status code, when the page exposes one beside the
   * visible words (the station page carries it as
   * `data-qa-id="port_status_pill_<code>"`). Null when absent. The visible
   * text is still what a person sees, so a disagreement between the two is
   * recorded as a warning and the text wins.
   */
  readonly statusCode?: string | null;
  readonly connectorText: string | null;
  readonly powerText: string | null;
  /** "Last used 3 hours ago" and similar. Never a count of anything. */
  readonly lastUsedText: string | null;
  /**
   * A durable identifier the page itself exposes for this port. Null when the
   * page provides none, which disables port-level history for this scope.
   */
  readonly durablePortId: string | null;
}

export interface PageReading {
  readonly url: string;
  readonly pageState: PageState;
  /** Station identifier recovered from the canonical URL or page metadata. */
  readonly stationIdOnPage: string | null;
  readonly stationNameOnPage: string | null;
  readonly summaryText: string | null;
  /** Provider's own "as of"/"updated" text, when the page shows one. */
  readonly updatedText: string | null;
  readonly portRows: readonly PortRowReading[];
  /** Other status text in the region, for sanitized evidence. */
  readonly statusBlocks: readonly string[];
  readonly readAtUtcMs: number;
  readonly documentLocale: string | null;
}

export interface ParsedObservation {
  readonly ok: true;
  readonly counts: StateCounts;
  readonly ports: readonly {
    readonly sourcePortId: string;
    readonly state: PortState;
    readonly level: ChargingLevel;
  }[];
  readonly level: ChargingLevel;
  readonly completeness: 'complete' | 'partial';
  readonly capacityBasis: 'ports_simultaneous' | 'connectors' | 'reported_total' | 'unknown';
  readonly sourceUpdatedAtUtcMs: number | null;
  readonly distinguishesCharging: boolean;
  readonly sanitizedSourceText: string;
  readonly warnings: readonly string[];
  readonly identityReliable: boolean;
}

export interface ParseFailure {
  readonly ok: false;
  readonly outcome: AttemptOutcome;
  readonly detail: string;
}

export type ParseResult = ParsedObservation | ParseFailure;

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

/**
 * Status phrases mapped to states, most specific first.
 *
 * `charging` is tracked separately from `in use` because only the former means
 * the provider distinguished active charging from mere occupancy.
 */
const STATUS_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly state: PortState;
  readonly explicitCharging: boolean;
}> = [
  { pattern: /\bout of service\b/i, state: 'out_of_service', explicitCharging: false },
  { pattern: /\bunavailable\b/i, state: 'out_of_service', explicitCharging: false },
  { pattern: /\boffline\b/i, state: 'out_of_service', explicitCharging: false },
  { pattern: /\bcoming soon\b/i, state: 'out_of_service', explicitCharging: false },
  {
    pattern: /\bunder (?:repair|maintenance)\b/i,
    state: 'out_of_service',
    explicitCharging: false,
  },
  // "Closed" is the station-hours pill: the port exists but is not open to
  // the public right now, which is out of service for occupancy purposes.
  { pattern: /\bclosed\b/i, state: 'out_of_service', explicitCharging: false },
  { pattern: /\breserved\b/i, state: 'reserved', explicitCharging: false },
  { pattern: /\bcharging\b/i, state: 'occupied', explicitCharging: true },
  { pattern: /\bin use\b/i, state: 'occupied', explicitCharging: false },
  { pattern: /\boccupied\b/i, state: 'occupied', explicitCharging: false },
  { pattern: /\bplugged in\b/i, state: 'occupied', explicitCharging: false },
  { pattern: /\bavailable\b/i, state: 'available', explicitCharging: false },
  { pattern: /\bopen\b/i, state: 'available', explicitCharging: false },
];

/**
 * The provider's status codes, as its own pill definitions map them.
 *
 * Captured 2026-09-21 from `na.chargepoint.com/UI/images/pills/states/en-US/
 * states.json?version=1715755545`, which is the file the station page reads
 * to render each port pill, plus the two extra members of the page's own
 * status enum (`out_of_order`, `out_of_network`). The right-hand column is
 * the display text that file assigns, so the visible words and the code are
 * two views of the same fact.
 *
 * A code not in this table classifies as null here and the visible text
 * decides. `in_use_by_driver` ("Charging") is the signed-in driver's own
 * session; ChargeWatch never signs in, so it should never appear, and if it
 * does it is still just an occupied port.
 */
const STATUS_CODES: Readonly<Record<string, PortState>> = {
  available: 'available', // "Available"
  in_use: 'occupied', // "In Use"
  in_use_by_driver: 'occupied', // "Charging"
  unavailable: 'out_of_service', // "Out of Service"
  maintenance_required: 'out_of_service', // "Out of Service"
  out_of_service: 'out_of_service', // "Out of Service"
  fault: 'out_of_service', // "Out of Service"
  out_of_order: 'out_of_service', // page enum member; no pill definition
  closed: 'out_of_service', // "Closed" — station hours, not open to the public
  unreachable: 'unknown', // "Unknown" — the station is not reporting
  unknown: 'unknown', // "Unknown"
  out_of_network: 'unknown', // page enum member; the network has no status for it
};

/**
 * Classifies a provider status code, or returns null for one this table does
 * not know. Never guesses: an unfamiliar code is the caller's cue to fall
 * back to the visible text.
 */
export function classifyStatusCode(code: string | null | undefined): PortState | null {
  if (!code) return null;
  const normalized = code.trim().toLowerCase();
  return STATUS_CODES[normalized] ?? null;
}

export interface ClassifiedStatus {
  readonly state: PortState;
  readonly explicitCharging: boolean;
  readonly matched: string | null;
}

/**
 * Classifies one status phrase.
 *
 * An unrecognised phrase is `unknown`. It is never optimistically read as
 * available, because an unknown port must not inflate the operational
 * denominator.
 */
export function classifyStatus(text: string | null): ClassifiedStatus {
  if (!text || text.trim().length === 0) {
    return { state: 'unknown', explicitCharging: false, matched: null };
  }
  for (const candidate of STATUS_PATTERNS) {
    if (candidate.pattern.test(text)) {
      return {
        state: candidate.state,
        explicitCharging: candidate.explicitCharging,
        matched: candidate.pattern.source,
      };
    }
  }
  return { state: 'unknown', explicitCharging: false, matched: null };
}

/**
 * Classifies one port row from its visible words and, when present, the
 * provider's code beside them.
 *
 * The text is what a person sees and is authoritative. The code is a second
 * witness: it settles a row whose text this parser does not recognise, and
 * when the two disagree that is recorded so a stale table on either side is
 * noticed rather than silently absorbed.
 */
export function classifyRow(row: PortRowReading): ClassifiedStatus & {
  readonly disagreement: string | null;
} {
  const fromText = classifyStatus(row.statusText);
  const fromCode = classifyStatusCode(row.statusCode ?? null);

  if (fromCode === null) return { ...fromText, disagreement: null };

  if (fromText.matched === null) {
    // Unrecognised or missing words; the provider's code is the only witness.
    return {
      state: fromCode,
      explicitCharging: false,
      matched: `code:${(row.statusCode ?? '').trim().toLowerCase()}`,
      disagreement: null,
    };
  }

  if (fromText.state !== fromCode) {
    return {
      ...fromText,
      disagreement: `status text "${row.statusText ?? ''}" reads as ${fromText.state} but the provider code "${row.statusCode ?? ''}" maps to ${fromCode}; the visible text was used`,
    };
  }
  return { ...fromText, disagreement: null };
}

/** Maps connector and power text to a charging class, or `unknown`. */
export function classifyLevel(
  connectorText: string | null,
  powerText: string | null,
): ChargingLevel {
  const connector = (connectorText ?? '').toLowerCase();
  const power = (powerText ?? '').toLowerCase();

  if (/ccs|chademo|combo|dc fast|supercharger|nacs dc/.test(connector)) return 'dc_fast';
  if (/j1772|type\s*1|type\s*2|mennekes/.test(connector)) return 'level_2';
  if (/\bnema\b|\b120\s*v\b/.test(connector)) return 'level_1';

  const kwMatch = /(\d+(?:\.\d+)?)\s*kw/.exec(power);
  if (kwMatch) {
    const kw = Number(kwMatch[1]);
    if (Number.isFinite(kw)) {
      // These boundaries are a display convenience, and anything ambiguous
      // stays unknown rather than being assigned a confident class.
      if (kw >= 25) return 'dc_fast';
      if (kw >= 3.3) return 'level_2';
    }
  }
  return 'unknown';
}

/**
 * Parses a provider "updated"/"as of" phrase into an absolute instant.
 *
 * Only relative phrases the page actually uses are handled. Anything else
 * returns null, which the metric engine treats as "source freshness unknown" —
 * a different fact from "stale".
 */
export function parseUpdatedText(text: string | null, readAtUtcMs: number): number | null {
  if (!text) return null;
  const normalized = text.toLowerCase().trim();

  if (/\b(just now|moments ago|seconds ago|a few seconds ago)\b/.test(normalized)) {
    return readAtUtcMs;
  }
  const relative = /(\d+)\s*(second|sec|minute|min|hour|hr|day)s?\s*ago/.exec(normalized);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2] as string;
    if (!Number.isFinite(amount)) return null;
    const unitMs = unit.startsWith('sec')
      ? 1000
      : unit.startsWith('min')
        ? 60_000
        : unit.startsWith('hour') || unit.startsWith('hr')
          ? 3_600_000
          : 86_400_000;
    return readAtUtcMs - amount * unitMs;
  }
  const iso = /\b(\d{4}-\d{2}-\d{2}t[\d:.]+(?:z|[+-]\d{2}:?\d{2}))\b/.exec(normalized);
  if (iso) {
    const parsed = Date.parse(iso[1] as string);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Parses an aggregate summary such as "1 of 2 available".
 *
 * The total is recorded as a reported total, NOT as evidence of how the
 * remainder is distributed.
 */
export function parseSummary(
  text: string | null,
): { available: number | null; total: number | null } | null {
  if (!text) return null;
  const ofPattern = /(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:ports?\s*)?available/i.exec(text);
  if (ofPattern) {
    return { available: Number(ofPattern[1]), total: Number(ofPattern[2]) };
  }
  const availableOnly = /(\d+)\s*available/i.exec(text);
  const totalOnly = /(\d+)\s*(?:total\s*)?ports?\b/i.exec(text);
  if (availableOnly || totalOnly) {
    return {
      available: availableOnly ? Number(availableOnly[1]) : null,
      total: totalOnly ? Number(totalOnly[1]) : null,
    };
  }
  return null;
}

/** Strips anything that looks like a personal or account detail from evidence. */
export function sanitizeEvidence(blocks: readonly string[]): string {
  return blocks
    .map((block) =>
      block
        .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email removed]')
        .replace(/\+?\d[\d\s().-]{8,}\d/g, '[number removed]')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((block) => block.length > 0)
    .join(' | ')
    .slice(0, 1000);
}

const PAGE_STATE_OUTCOMES: Readonly<Partial<Record<PageState, AttemptOutcome>>> = {
  loading: 'timeout',
  no_results: 'invalid_data',
  source_error: 'offline',
  empty_status: 'partial',
  login_required: 'login_required',
  challenge: 'source_blocked',
};

export interface ParseOptions {
  /** The station id the binding expects. Identity is checked on every read. */
  readonly expectedStationId: string | null;
  /** Installed capacity from the catalog, used only as a sanity bound. */
  readonly catalogPortCount: number | null;
}

/**
 * Turns a page reading into an observation, or into a durable failure outcome.
 */
export function parsePageReading(reading: PageReading, options: ParseOptions): ParseResult {
  if (reading.pageState !== 'status_present') {
    const outcome = PAGE_STATE_OUTCOMES[reading.pageState] ?? 'invalid_data';
    if (reading.pageState === 'empty_status') {
      return {
        ok: false,
        outcome: 'partial',
        detail: 'the status region rendered but contained no port status',
      };
    }
    return {
      ok: false,
      outcome,
      detail: `page state was ${reading.pageState}`,
    };
  }

  // Identity check on every result: a redirect or stale SPA render must not
  // write one station's counts onto another binding.
  if (options.expectedStationId !== null) {
    if (reading.stationIdOnPage === null) {
      return {
        ok: false,
        outcome: 'invalid_data',
        detail: `expected station ${options.expectedStationId} but the page exposed no station identity`,
      };
    }
    if (reading.stationIdOnPage !== options.expectedStationId) {
      return {
        ok: false,
        outcome: 'invalid_data',
        detail: `station identity mismatch: expected ${options.expectedStationId}, page showed ${reading.stationIdOnPage}`,
      };
    }
  }

  const warnings: string[] = [];
  if (reading.documentLocale && !reading.documentLocale.toLowerCase().startsWith('en')) {
    warnings.push(
      `page locale was ${reading.documentLocale}; status words are matched against ${REQUESTED_LOCALE} phrasing`,
    );
  }

  const rows = reading.portRows;
  const hasDurableIdentity = rows.length > 0 && rows.every((r) => r.durablePortId !== null);
  const uniqueIds = new Set(
    rows.map((r) => r.durablePortId).filter((id): id is string => id !== null),
  );
  const identityReliable = hasDurableIdentity && uniqueIds.size === rows.length;

  if (rows.length > 0 && !identityReliable) {
    warnings.push(
      'the page does not expose durable port identifiers, so only site-level counts are recorded and per-port history stays disabled',
    );
  }

  let available: number | null = null;
  let occupied: number | null = null;
  let reserved: number | null = null;
  let outOfService: number | null = null;
  let unknown: number | null = null;
  let total: number | null = null;
  let anyExplicitCharging = false;
  let allOccupiedExplicitlyCharging = true;
  let sawOccupied = false;
  let level: ChargingLevel = 'unknown';
  let capacityBasis: ParsedObservation['capacityBasis'] = 'unknown';
  let completeness: 'complete' | 'partial' = 'complete';

  if (rows.length > 0) {
    available = 0;
    occupied = 0;
    reserved = 0;
    outOfService = 0;
    unknown = 0;

    for (const row of rows) {
      const status = classifyRow(row);
      if (status.disagreement) warnings.push(status.disagreement);
      switch (status.state) {
        case 'available':
          available += 1;
          break;
        case 'occupied':
          occupied += 1;
          sawOccupied = true;
          if (status.explicitCharging) anyExplicitCharging = true;
          else allOccupiedExplicitlyCharging = false;
          break;
        case 'reserved':
          reserved += 1;
          break;
        case 'out_of_service':
          outOfService += 1;
          break;
        default:
          unknown += 1;
          break;
      }

      const rowLevel = classifyLevel(row.connectorText, row.powerText);
      if (level === 'unknown') level = rowLevel;
      else if (rowLevel !== 'unknown' && rowLevel !== level) level = 'mixed';
    }

    total = rows.length;
    // A row list counts simultaneous serving positions only if the provider
    // presents ports rather than alternative plugs on one unit.
    capacityBasis = rows.some((r) => /connector|plug/i.test(r.label ?? ''))
      ? 'connectors'
      : 'ports_simultaneous';
    if (capacityBasis === 'connectors') {
      warnings.push(
        'the page lists connectors rather than ports; two plugs on one unit may not be two simultaneous charging spaces',
      );
    }
    if ((unknown ?? 0) > 0) completeness = 'partial';
  }

  // The aggregate summary is reconciled with the rows, never added to them.
  const summary = parseSummary(reading.summaryText);
  if (summary) {
    if (rows.length === 0) {
      available = summary.available;
      total = summary.total;
      capacityBasis = summary.total !== null ? 'reported_total' : 'unknown';
      completeness = 'partial';
      warnings.push(
        'only an aggregate availability summary was present; occupied, reserved and offline counts are unknown and are not derived by subtraction',
      );
    } else {
      if (summary.total !== null && summary.total !== total) {
        warnings.push(
          `the summary reports ${summary.total} ports but ${total} rows rendered; the row count is used and the discrepancy is recorded`,
        );
        completeness = 'partial';
      }
      if (summary.available !== null && summary.available !== available) {
        warnings.push(
          `the summary reports ${summary.available} available but the rows show ${available}; the rows are used`,
        );
        completeness = 'partial';
      }
    }
  }

  if (rows.length === 0 && !summary) {
    return {
      ok: false,
      outcome: 'layout_changed',
      detail: 'no port rows and no availability summary could be located in the status region',
    };
  }

  if (options.catalogPortCount !== null && total !== null && total !== options.catalogPortCount) {
    warnings.push(
      `the source shows ${total} ports where the catalog records ${options.catalogPortCount}; capacity drift is recorded rather than assumed`,
    );
  }

  const sourceUpdatedAtUtcMs = parseUpdatedText(reading.updatedText, reading.readAtUtcMs);
  if (reading.updatedText && sourceUpdatedAtUtcMs === null) {
    warnings.push(
      `the page showed an update time we could not parse (${reading.updatedText.slice(0, 60)}); source freshness is recorded as unknown`,
    );
  }

  // "Last used" text is informational only. It is never counted.
  if (rows.some((r) => r.lastUsedText)) {
    warnings.push(
      '"last used" text is displayed by the source but is not a session or usage count',
    );
  }

  const evidence = sanitizeEvidence([
    reading.stationNameOnPage ?? '',
    reading.summaryText ?? '',
    ...rows.map((r) =>
      [r.label, r.statusText, r.connectorText, r.powerText].filter(Boolean).join(' '),
    ),
    ...reading.statusBlocks,
  ]);

  return {
    ok: true,
    counts: { available, occupied, reserved, outOfService, unknown, total },
    ports: identityReliable
      ? rows.map((row) => ({
          sourcePortId: row.durablePortId as string,
          state: classifyRow(row).state,
          level: classifyLevel(row.connectorText, row.powerText),
        }))
      : [],
    level,
    completeness,
    capacityBasis,
    sourceUpdatedAtUtcMs,
    // Only claim the source separates charging from occupancy when every
    // occupied row actually said so.
    distinguishesCharging: sawOccupied && anyExplicitCharging && allOccupiedExplicitlyCharging,
    sanitizedSourceText: evidence,
    warnings,
    identityReliable,
  };
}
