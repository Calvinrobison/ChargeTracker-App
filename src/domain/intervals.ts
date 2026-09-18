/**
 * Turns discrete status snapshots into the time-weighted intervals every
 * metric is built from.
 *
 * The carry-forward contract (docs/METRICS.md §Time handling):
 * a valid snapshot at t holds only until the EARLIEST of
 *   - the next observation for that scope,
 *   - the end of the monitored period containing t (so sleep, pause, offline,
 *     browser failure and update gaps are never bridged),
 *   - a capacity or scope change,
 *   - the end of the query window,
 *   - its own freshness budget.
 *
 * Missing time is missing. It is never zero usage.
 */

import {
  type CapacityRecord,
  type ChargingLevel,
  type CollectionGap,
  type FreshnessPolicy,
  type MonitoringWindow,
  type QualityClass,
  type SourceFreshness,
  type StatusSnapshot,
  carryForwardBudgetMs,
} from './types.ts';
import { type ReconciledCounts, reconcileCounts } from './reconcile.ts';
import {
  type Interval,
  MINUTE_MS,
  durationMinutes,
  intersect,
  intersectAll,
  normalize,
  subtract,
} from './time.ts';

const FAR_FUTURE = 4_102_444_800_000;

export type ExclusionReason =
  | 'quality_invalid'
  | 'quality_ambiguous_scope'
  | 'source_stale'
  | 'outside_monitoring'
  | 'reconcile_failed'
  | 'budget_expired_before_window'
  | 'zero_length';

export interface ValidInterval {
  readonly span: Interval;
  readonly minutes: number;
  readonly snapshot: StatusSnapshot;
  readonly counts: ReconciledCounts;
  readonly sourceFreshness: SourceFreshness;
  /** Installed capacity in force during this interval, when known. */
  readonly capacityPorts: number | null;
  readonly level: ChargingLevel;
  /** True when the snapshot did not fully describe its declared scope. */
  readonly partial: boolean;
}

export interface ExcludedInterval {
  readonly observationId: string;
  readonly observedAtUtcMs: number;
  readonly reason: ExclusionReason;
  readonly detail?: string;
}

export interface ScopeIntervalSet {
  readonly scopeKey: string;
  readonly window: Interval;
  /** Monitored, non-gapped time inside the window. */
  readonly monitoredSpans: readonly Interval[];
  readonly monitoredMinutes: number;
  /** Σ capacity × minutes over monitored time, or null when capacity is unknown. */
  readonly expectedInstalledPortMinutes: number | null;
  readonly capacityKnown: boolean;
  readonly intervals: readonly ValidInterval[];
  readonly excluded: readonly ExcludedInterval[];
  /** Recorded collection gaps intersecting the window. */
  readonly gapSpans: readonly Interval[];
  readonly gapMinutes: number;
  /** Observation time span actually covered by valid intervals. */
  readonly observedMinutes: number;
  readonly firstObservationMs: number | null;
  readonly latestObservationMs: number | null;
}

export interface IntervalOptions {
  /**
   * Whether readings whose source timestamp was already outside the provider's
   * freshness limit contribute to time-weighted metrics. Default false: such a
   * reading describes a past state of unknown vintage.
   */
  readonly includeStaleSourceReadings?: boolean;
  /** Quality classes excluded from metrics. */
  readonly excludedQualities?: readonly QualityClass[];
}

const DEFAULT_EXCLUDED_QUALITIES: readonly QualityClass[] = ['invalid', 'ambiguous_scope'];

export interface ScopeSeriesInput {
  readonly scopeKey: string;
  readonly window: Interval;
  readonly snapshots: readonly StatusSnapshot[];
  readonly monitoringWindows: readonly MonitoringWindow[];
  readonly gaps: readonly CollectionGap[];
  readonly capacity: readonly CapacityRecord[];
  readonly options?: IntervalOptions;
}

/**
 * Classifies a snapshot's source freshness.
 *
 * An absent source timestamp means sensor freshness is UNKNOWN, even when the
 * page was read a second ago. That is a different fact from "stale" and both
 * are preserved.
 */
export function classifySourceFreshness(snapshot: StatusSnapshot): SourceFreshness {
  const { sourceUpdatedAtUtcMs, observedAtUtcMs, freshnessPolicy } = snapshot;
  if (sourceUpdatedAtUtcMs === null) return 'unknown_source_clock';
  const limit = freshnessPolicy.sourceFreshnessLimitMs;
  if (limit === null) {
    // No documented provider limit: we know the source clock but have no rule
    // to judge it against, so we do not claim staleness.
    return 'fresh';
  }
  const lagMs = observedAtUtcMs - sourceUpdatedAtUtcMs;
  return lagMs > limit ? 'stale' : 'fresh';
}

function toSpans(windows: readonly MonitoringWindow[], scopeKey: string): Interval[] {
  const spans: Interval[] = [];
  for (const w of windows) {
    if (w.scopeKey !== scopeKey) continue;
    const endMs = w.endMs ?? FAR_FUTURE;
    if (endMs > w.startMs) spans.push({ startMs: w.startMs, endMs });
  }
  return normalize(spans);
}

function gapSpansFor(gaps: readonly CollectionGap[], scopeKey: string): Interval[] {
  const spans: Interval[] = [];
  for (const g of gaps) {
    if (g.scopeKey !== null && g.scopeKey !== scopeKey) continue;
    if (g.endMs > g.startMs) spans.push({ startMs: g.startMs, endMs: g.endMs });
  }
  return normalize(spans);
}

/** Capacity boundaries (start and end instants) as a sorted unique list. */
function capacityBoundaries(records: readonly CapacityRecord[], scopeKey: string): number[] {
  const set = new Set<number>();
  for (const r of records) {
    if (r.scopeKey !== scopeKey) continue;
    set.add(r.startMs);
    if (r.endMs !== null) set.add(r.endMs);
  }
  return [...set].sort((a, b) => a - b);
}

function capacityAt(
  records: readonly CapacityRecord[],
  scopeKey: string,
  atMs: number,
): CapacityRecord | null {
  let best: CapacityRecord | null = null;
  for (const r of records) {
    if (r.scopeKey !== scopeKey) continue;
    const endMs = r.endMs ?? FAR_FUTURE;
    if (atMs >= r.startMs && atMs < endMs) {
      if (!best || r.startMs > best.startMs) best = r;
    }
  }
  return best;
}

/**
 * Computes Σ installed capacity × minutes over monitored time.
 * Returns null when any monitored moment has no known capacity: coverage
 * against an unknown denominator is not reported as a number.
 */
function expectedPortMinutes(
  monitored: readonly Interval[],
  records: readonly CapacityRecord[],
  scopeKey: string,
): { value: number | null; capacityKnown: boolean } {
  const boundaries = capacityBoundaries(records, scopeKey);
  let total = 0;
  let known = true;
  for (const span of monitored) {
    const cuts = boundaries.filter((b) => b > span.startMs && b < span.endMs);
    const edges = [span.startMs, ...cuts, span.endMs];
    for (let i = 0; i < edges.length - 1; i += 1) {
      const startMs = edges[i] as number;
      const endMs = edges[i + 1] as number;
      if (endMs <= startMs) continue;
      const record = capacityAt(records, scopeKey, startMs);
      if (!record) {
        known = false;
        continue;
      }
      total += record.capacityPorts * ((endMs - startMs) / MINUTE_MS);
    }
  }
  return { value: known ? total : null, capacityKnown: known };
}

/**
 * Builds the valid interval set for one observation scope over one window.
 */
export function buildScopeIntervals(input: ScopeSeriesInput): ScopeIntervalSet {
  const { scopeKey, window, snapshots, monitoringWindows, gaps, capacity } = input;
  const options = input.options ?? {};
  const includeStale = options.includeStaleSourceReadings ?? false;
  const excludedQualities = options.excludedQualities ?? DEFAULT_EXCLUDED_QUALITIES;

  const monitoredAll = toSpans(monitoringWindows, scopeKey);
  // Remove recorded gaps from the monitoring union.
  const gapsAll = gapSpansFor(gaps, scopeKey);
  const monitoredMinusGaps = normalize(
    monitoredAll.flatMap((span) => subtract(span, gapsAll)),
  );

  const monitoredSpans = intersectAll(window, monitoredMinusGaps);
  const gapSpansInWindow = intersectAll(window, gapsAll);

  const ordered = [...snapshots]
    .filter((s) => s.scopeKey === scopeKey)
    .sort((a, b) => a.observedAtUtcMs - b.observedAtUtcMs || a.observationId.localeCompare(b.observationId));

  const boundaries = capacityBoundaries(capacity, scopeKey);

  const intervals: ValidInterval[] = [];
  const excluded: ExcludedInterval[] = [];
  let firstObservationMs: number | null = null;
  let latestObservationMs: number | null = null;

  for (let i = 0; i < ordered.length; i += 1) {
    const snapshot = ordered[i] as StatusSnapshot;
    const observedAt = snapshot.observedAtUtcMs;

    if (observedAt >= window.endMs) continue; // future relative to the window

    const nextSnapshot = ordered[i + 1];
    const freshness = classifySourceFreshness(snapshot);

    if (excludedQualities.includes(snapshot.quality)) {
      excluded.push({
        observationId: snapshot.observationId,
        observedAtUtcMs: observedAt,
        reason: snapshot.quality === 'invalid' ? 'quality_invalid' : 'quality_ambiguous_scope',
      });
      continue;
    }
    if (!includeStale && (freshness === 'stale' || snapshot.quality === 'stale_source')) {
      excluded.push({
        observationId: snapshot.observationId,
        observedAtUtcMs: observedAt,
        reason: 'source_stale',
      });
      continue;
    }

    const reconciled = reconcileCounts(snapshot.counts);
    if (!reconciled.ok) {
      excluded.push({
        observationId: snapshot.observationId,
        observedAtUtcMs: observedAt,
        reason: 'reconcile_failed',
        detail: reconciled.detail,
      });
      continue;
    }

    // Find the monitored span containing the observation instant.
    const containing = monitoredMinusGaps.find(
      (span) => observedAt >= span.startMs && observedAt < span.endMs,
    );
    if (!containing) {
      excluded.push({
        observationId: snapshot.observationId,
        observedAtUtcMs: observedAt,
        reason: 'outside_monitoring',
      });
      continue;
    }

    const budgetMs = carryForwardBudgetMs(snapshot.freshnessPolicy);
    const nextCapacityBoundary = boundaries.find((b) => b > observedAt);

    let endMs = observedAt + budgetMs;
    endMs = Math.min(endMs, containing.endMs, window.endMs);
    if (nextSnapshot) endMs = Math.min(endMs, nextSnapshot.observedAtUtcMs);
    if (nextCapacityBoundary !== undefined) endMs = Math.min(endMs, nextCapacityBoundary);

    const clipped = intersect({ startMs: observedAt, endMs: Math.max(endMs, observedAt) }, window);
    if (!clipped) {
      excluded.push({
        observationId: snapshot.observationId,
        observedAtUtcMs: observedAt,
        reason: observedAt < window.startMs ? 'budget_expired_before_window' : 'zero_length',
      });
      continue;
    }

    const capacityRecord = capacityAt(capacity, scopeKey, clipped.startMs);
    intervals.push({
      span: clipped,
      minutes: durationMinutes(clipped),
      snapshot,
      counts: reconciled.value,
      sourceFreshness: freshness,
      capacityPorts: capacityRecord ? capacityRecord.capacityPorts : null,
      level: capacityRecord ? capacityRecord.level : snapshot.level,
      partial: snapshot.completeness === 'partial',
    });
  }

  // Observation facts are recorded independently of metric exclusions: the
  // latest reading is a fact about the source even when it cannot be
  // time-weighted. A pre-window reading counts as the latest one we hold when
  // nothing inside the window exists.
  for (const snapshot of ordered) {
    const at = snapshot.observedAtUtcMs;
    if (at >= window.endMs) continue;
    if (at >= window.startMs) {
      if (firstObservationMs === null || at < firstObservationMs) firstObservationMs = at;
    }
    if (latestObservationMs === null || at > latestObservationMs) latestObservationMs = at;
  }

  const expected = expectedPortMinutes(monitoredSpans, capacity, scopeKey);

  return {
    scopeKey,
    window,
    monitoredSpans,
    monitoredMinutes: monitoredSpans.reduce((sum, s) => sum + durationMinutes(s), 0),
    expectedInstalledPortMinutes: expected.value,
    capacityKnown: expected.capacityKnown,
    intervals,
    excluded,
    gapSpans: gapSpansInWindow,
    gapMinutes: gapSpansInWindow.reduce((sum, s) => sum + durationMinutes(s), 0),
    observedMinutes: intervals.reduce((sum, iv) => sum + iv.minutes, 0),
    firstObservationMs,
    latestObservationMs,
  };
}

export { carryForwardBudgetMs };
export type { FreshnessPolicy };
