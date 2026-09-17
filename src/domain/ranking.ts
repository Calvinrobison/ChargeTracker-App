/**
 * Ranking windows, cohorts and eligibility.
 *
 * Two rules matter most here:
 *  1) Every ranked location is measured over the SAME shared study window, not
 *     over whichever convenient start each location happens to have.
 *  2) Ineligible locations stay visible and labelled "Provisional"; they are
 *     never silently mixed into the primary ranking, and the displayed "all"
 *     ranking is never quietly restricted to a hidden subset.
 */

import type { ChargingLevel } from './types.ts';
import type { ScopeMetrics } from './metrics.ts';
import { type Interval, DAY_MS, elapsedDays } from './time.ts';
import { RANKING_ELIGIBILITY } from './thresholds.ts';

export type DatePreset = '7d' | '30d' | '60d' | 'all' | 'custom';

export interface WindowRequest {
  readonly preset: DatePreset;
  /** Required when preset is 'custom'. */
  readonly customStartMs?: number;
  readonly customEndMs?: number;
}

export interface ResolvedWindow {
  readonly requested: Interval;
  /** The requested interval intersected with the global study start. */
  readonly effective: Interval;
  readonly preset: DatePreset;
  /** True when collection started after the requested start. */
  readonly clippedByStudyStart: boolean;
  readonly requestedDays: number;
  readonly effectiveDays: number;
}

/**
 * Resolves a date selection into the shared study window.
 *
 * `studyStartMs` is when collection actually began. A "last 30 days" request on
 * an 11-day-old database yields an 11-day effective window, and the UI is
 * obliged to disclose that ("30 days requested · 11 days collected").
 */
export function resolveWindow(
  request: WindowRequest,
  nowMs: number,
  studyStartMs: number | null,
): ResolvedWindow {
  let requestedStart: number;
  let requestedEnd = nowMs;

  switch (request.preset) {
    case '7d':
      requestedStart = nowMs - 7 * DAY_MS;
      break;
    case '30d':
      requestedStart = nowMs - 30 * DAY_MS;
      break;
    case '60d':
      requestedStart = nowMs - 60 * DAY_MS;
      break;
    case 'all':
      requestedStart = studyStartMs ?? nowMs;
      break;
    case 'custom': {
      if (request.customStartMs === undefined || request.customEndMs === undefined) {
        throw new TypeError('custom window requires customStartMs and customEndMs');
      }
      requestedStart = Math.min(request.customStartMs, request.customEndMs);
      requestedEnd = Math.max(request.customStartMs, request.customEndMs);
      break;
    }
    default: {
      const exhaustive: never = request.preset;
      throw new TypeError(`unknown preset ${String(exhaustive)}`);
    }
  }

  const requested: Interval = {
    startMs: requestedStart,
    endMs: Math.max(requestedEnd, requestedStart),
  };
  const effectiveStart =
    studyStartMs === null ? requested.startMs : Math.max(requested.startMs, studyStartMs);
  const effective: Interval = {
    startMs: effectiveStart,
    endMs: Math.max(requested.endMs, effectiveStart),
  };

  return {
    requested,
    effective,
    preset: request.preset,
    clippedByStudyStart: studyStartMs !== null && studyStartMs > requested.startMs,
    requestedDays: elapsedDays(requested),
    effectiveDays: elapsedDays(effective),
  };
}

export type EligibilityFailure =
  | 'insufficient_elapsed_days'
  | 'insufficient_status_coverage'
  | 'unknown_capacity'
  | 'occupancy_unsupported'
  | 'ambiguous_scope';

export interface Eligibility {
  readonly eligible: boolean;
  readonly failures: readonly EligibilityFailure[];
  /** UI badge: eligible rows carry none, others carry "Provisional". */
  readonly badge: 'none' | 'provisional';
}

/**
 * Applies the primary-ranking gates from docs/METRICS.md.
 *
 * These are explicit product thresholds. They are not a statistical
 * significance test and must never be described as one.
 */
export function evaluateEligibility(metrics: ScopeMetrics): Eligibility {
  const failures: EligibilityFailure[] = [];

  if (metrics.elapsedDaysInWindow < RANKING_ELIGIBILITY.minElapsedDays) {
    failures.push('insufficient_elapsed_days');
  }
  if (!metrics.capacityKnown || metrics.expectedInstalledPortMinutes === null) {
    failures.push('unknown_capacity');
  }
  if (!metrics.supportsOccupancy || metrics.observedOccupancyPct === null) {
    failures.push('occupancy_unsupported');
  }
  if (
    metrics.statusCoveragePct === null ||
    metrics.statusCoveragePct < RANKING_ELIGIBILITY.minStatusCoveragePct
  ) {
    failures.push('insufficient_status_coverage');
  }

  return {
    eligible: failures.length === 0,
    failures,
    badge: failures.length === 0 ? 'none' : 'provisional',
  };
}

export type CohortMode = 'level_2' | 'dc_fast' | 'combined';

export interface RankedEntry {
  readonly scopeKey: string;
  readonly metrics: ScopeMetrics;
  readonly eligibility: Eligibility;
  readonly level: ChargingLevel;
}

export interface RankingResult {
  readonly cohort: CohortMode;
  readonly window: Interval;
  readonly sort: RankSort;
  /** Eligible entries, ranked. */
  readonly primary: readonly RankedEntry[];
  /** Visible but not ranked: provisional, low coverage, unsupported. */
  readonly provisional: readonly RankedEntry[];
  /** Locations excluded from this cohort because their class is ambiguous. */
  readonly excludedAmbiguous: readonly RankedEntry[];
  /** Disclosure text obligations. */
  readonly disclosure: {
    readonly effectiveStartMs: number;
    readonly effectiveEndMs: number;
    readonly monitoredScopeCount: number;
    readonly eligibleScopeCount: number;
    readonly cohortDescription: string;
  };
}

export type RankSort = 'occupancy' | 'occupied_hours';

function cohortMatches(mode: CohortMode, level: ChargingLevel): boolean {
  if (mode === 'combined') return level === 'level_2' || level === 'dc_fast' || level === 'mixed';
  if (mode === 'level_2') return level === 'level_2';
  return level === 'dc_fast';
}

const COHORT_DESCRIPTIONS: Record<CohortMode, string> = {
  level_2: 'Level 2 locations compared with Level 2 locations.',
  dc_fast: 'DC fast locations compared with DC fast locations.',
  combined:
    'Level 2 and DC fast combined. The group figure is weighted by port-minutes, so a large site counts more than a small one; it is not an average of site percentages.',
};

/**
 * Builds a ranking for one cohort over one shared window.
 *
 * An aggregate with no Level 2 / DC breakdown cannot enter a type-specific
 * ranking by guessing the mix, so `mixed` and `unknown` levels are reported in
 * `excludedAmbiguous` with their status explained rather than assigned.
 */
export function rankScopes(
  entries: readonly RankedEntry[],
  cohort: CohortMode,
  sort: RankSort,
  window: Interval,
): RankingResult {
  const inCohort: RankedEntry[] = [];
  const excludedAmbiguous: RankedEntry[] = [];

  for (const entry of entries) {
    if (cohortMatches(cohort, entry.level)) inCohort.push(entry);
    else if (entry.level === 'unknown' || (entry.level === 'mixed' && cohort !== 'combined')) {
      excludedAmbiguous.push(entry);
    }
  }

  const compare = (a: RankedEntry, b: RankedEntry): number => {
    if (sort === 'occupancy') {
      const av = a.metrics.observedOccupancyPct;
      const bv = b.metrics.observedOccupancyPct;
      if (av === null && bv === null) return a.scopeKey.localeCompare(b.scopeKey);
      if (av === null) return 1;
      if (bv === null) return -1;
      if (bv !== av) return bv - av;
      return b.metrics.estimatedOccupiedPortHours - a.metrics.estimatedOccupiedPortHours;
    }
    const diff = b.metrics.estimatedOccupiedPortHours - a.metrics.estimatedOccupiedPortHours;
    if (diff !== 0) return diff;
    return a.scopeKey.localeCompare(b.scopeKey);
  };

  const primary = inCohort.filter((e) => e.eligibility.eligible).sort(compare);
  const provisional = inCohort.filter((e) => !e.eligibility.eligible).sort(compare);

  return {
    cohort,
    window,
    sort,
    primary,
    provisional,
    excludedAmbiguous,
    disclosure: {
      effectiveStartMs: window.startMs,
      effectiveEndMs: window.endMs,
      monitoredScopeCount: entries.length,
      eligibleScopeCount: primary.length,
      cohortDescription: COHORT_DESCRIPTIONS[cohort],
    },
  };
}
