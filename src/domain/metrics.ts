/**
 * The single definition of every ChargeWatch metric.
 *
 * The dashboard, map, station details, exports and tests all read from this
 * module. Nothing recalculates a slightly different version in a component.
 * Units and worked examples live in docs/METRICS.md.
 */

import {
  type ChargingLevel,
  type StatusSnapshot,
} from './types.ts';
import type { ScopeIntervalSet, ValidInterval } from './intervals.ts';
import { type Interval, elapsedDays, splitByLocalHour, STUDY_TIME_ZONE } from './time.ts';

/** Version stamped onto cached aggregates so a definition change forces recompute. */
export const METRIC_ALGORITHM_VERSION = 1;

export interface ScopeMetrics {
  readonly scopeKey: string;
  readonly window: Interval;
  readonly algorithmVersion: number;

  /** 1) Σ occupied_count × valid interval minutes. */
  readonly occupiedPortMinutes: number;
  /** 2) Σ (available + occupied) × valid interval minutes. */
  readonly observedOperationalPortMinutes: number;
  /** 3) 100 × (1)/(2). Null when the denominator is zero or unsupported. */
  readonly observedOccupancyPct: number | null;
  /** 4) (1)/60 — total observed activity, not a normalized rate. */
  readonly estimatedOccupiedPortHours: number;

  /** Σ explicitly-known-state ports × minutes (includes reserved and offline). */
  readonly knownStatePortMinutes: number;
  /** Σ installed capacity × monitored minutes, or null when capacity is unknown. */
  readonly expectedInstalledPortMinutes: number | null;
  /** 5) known-state port-minutes / expected installed port-minutes. */
  readonly statusCoveragePct: number | null;
  /** 6) observed operational port-minutes / expected installed port-minutes. */
  readonly operationalObservationCoveragePct: number | null;

  readonly outOfServicePortMinutes: number;
  readonly reservedPortMinutes: number;
  readonly unknownStatePortMinutes: number;
  /** Installed port-minutes with no observation of any kind. */
  readonly unobservedPortMinutes: number | null;

  /** 7a) offline port-minutes / known-state port-minutes. */
  readonly offlineShareOfKnownPct: number | null;
  /** 7b) offline port-minutes / expected installed port-minutes. */
  readonly offlineShareOfInstalledPct: number | null;
  /** 7c) (explicit unknown + unobserved) port-minutes / expected installed. */
  readonly unknownShareOfInstalledPct: number | null;

  readonly supportsOccupancy: boolean;
  readonly capacityKnown: boolean;
  /** True only when every contributing snapshot separated charging from occupied. */
  readonly distinguishesCharging: boolean;
  readonly anyPartialObservations: boolean;
  readonly level: ChargingLevel;

  readonly monitoredMinutes: number;
  readonly gapMinutes: number;
  readonly observedMinutes: number;
  readonly elapsedDaysInWindow: number;
  readonly observationCount: number;
  readonly excludedObservationCount: number;
  readonly firstObservationMs: number | null;
  readonly latestObservationMs: number | null;
}

function pct(numerator: number, denominator: number | null): number | null {
  if (denominator === null || denominator <= 0) return null;
  return (100 * numerator) / denominator;
}

function weight(interval: ValidInterval, count: number | null): number {
  if (count === null) return 0;
  return count * interval.minutes;
}

/**
 * Computes every scope-level metric from a prepared interval set.
 *
 * Only intervals whose snapshot explicitly reported BOTH available and
 * occupied contribute to the occupancy numerator and denominator, so an
 * "available only" source can never have occupancy inferred as total minus
 * available.
 */
export function computeScopeMetrics(set: ScopeIntervalSet): ScopeMetrics {
  let occupiedPortMinutes = 0;
  let observedOperationalPortMinutes = 0;
  let knownStatePortMinutes = 0;
  let outOfServicePortMinutes = 0;
  let reservedPortMinutes = 0;
  let unknownStatePortMinutes = 0;
  let supportsOccupancy = false;
  let distinguishesCharging = set.intervals.length > 0;
  let anyPartial = false;
  let level: ChargingLevel = 'unknown';

  for (const iv of set.intervals) {
    const c = iv.counts;
    if (c.supportsOccupancy) {
      supportsOccupancy = true;
      occupiedPortMinutes += weight(iv, c.occupied);
      observedOperationalPortMinutes += weight(iv, c.operationalCount);
    }
    knownStatePortMinutes += weight(iv, c.knownStateCount);
    outOfServicePortMinutes += weight(iv, c.outOfService);
    reservedPortMinutes += weight(iv, c.reserved);
    unknownStatePortMinutes += weight(iv, c.unknown);
    if (!iv.snapshot.distinguishesCharging) distinguishesCharging = false;
    if (iv.partial) anyPartial = true;
    if (level === 'unknown') level = iv.level;
    else if (iv.level !== 'unknown' && iv.level !== level) level = 'mixed';
  }

  const expected = set.expectedInstalledPortMinutes;
  let unobservedPortMinutes: number | null = null;
  if (expected !== null) {
    unobservedPortMinutes = Math.max(0, expected - knownStatePortMinutes - unknownStatePortMinutes);
  }

  const unknownPlusUnobserved =
    unobservedPortMinutes === null ? null : unknownStatePortMinutes + unobservedPortMinutes;

  return {
    scopeKey: set.scopeKey,
    window: set.window,
    algorithmVersion: METRIC_ALGORITHM_VERSION,
    occupiedPortMinutes,
    observedOperationalPortMinutes,
    observedOccupancyPct: supportsOccupancy
      ? pct(occupiedPortMinutes, observedOperationalPortMinutes)
      : null,
    estimatedOccupiedPortHours: occupiedPortMinutes / 60,
    knownStatePortMinutes,
    expectedInstalledPortMinutes: expected,
    statusCoveragePct: pct(knownStatePortMinutes, expected),
    operationalObservationCoveragePct: pct(observedOperationalPortMinutes, expected),
    outOfServicePortMinutes,
    reservedPortMinutes,
    unknownStatePortMinutes,
    unobservedPortMinutes,
    offlineShareOfKnownPct: pct(outOfServicePortMinutes, knownStatePortMinutes || null),
    offlineShareOfInstalledPct: pct(outOfServicePortMinutes, expected),
    unknownShareOfInstalledPct:
      unknownPlusUnobserved === null ? null : pct(unknownPlusUnobserved, expected),
    supportsOccupancy,
    capacityKnown: set.capacityKnown,
    distinguishesCharging,
    anyPartialObservations: anyPartial,
    level,
    monitoredMinutes: set.monitoredMinutes,
    gapMinutes: set.gapMinutes,
    observedMinutes: set.observedMinutes,
    elapsedDaysInWindow: elapsedDays(set.window),
    observationCount: set.intervals.length,
    excludedObservationCount: set.excluded.length,
    firstObservationMs: set.firstObservationMs,
    latestObservationMs: set.latestObservationMs,
  };
}

// ---------------------------------------------------------------------------
// Aggregation across scopes
// ---------------------------------------------------------------------------

export interface AggregateMetrics {
  readonly occupiedPortMinutes: number;
  readonly observedOperationalPortMinutes: number;
  /** Port-minute weighted, never the mean of per-scope percentages. */
  readonly observedOccupancyPct: number | null;
  readonly estimatedOccupiedPortHours: number;
  readonly knownStatePortMinutes: number;
  readonly expectedInstalledPortMinutes: number | null;
  readonly statusCoveragePct: number | null;
  readonly operationalObservationCoveragePct: number | null;
  readonly scopeCount: number;
  readonly scopesWithOccupancy: number;
  readonly capacityKnownForAll: boolean;
}

/**
 * Weights group metrics by port-minutes.
 *
 * Averaging site percentages would let a two-port site outvote a twenty-port
 * one; §15 requires port-minute weighting.
 */
export function aggregateScopeMetrics(scopes: readonly ScopeMetrics[]): AggregateMetrics {
  let occupied = 0;
  let operational = 0;
  let known = 0;
  let expected = 0;
  let expectedKnown = true;
  let withOccupancy = 0;

  for (const s of scopes) {
    if (s.supportsOccupancy) {
      occupied += s.occupiedPortMinutes;
      operational += s.observedOperationalPortMinutes;
      withOccupancy += 1;
    }
    known += s.knownStatePortMinutes;
    if (s.expectedInstalledPortMinutes === null) expectedKnown = false;
    else expected += s.expectedInstalledPortMinutes;
  }

  const expectedValue = expectedKnown ? expected : null;
  return {
    occupiedPortMinutes: occupied,
    observedOperationalPortMinutes: operational,
    observedOccupancyPct: withOccupancy > 0 ? pct(occupied, operational) : null,
    estimatedOccupiedPortHours: occupied / 60,
    knownStatePortMinutes: known,
    expectedInstalledPortMinutes: expectedValue,
    statusCoveragePct: pct(known, expectedValue),
    operationalObservationCoveragePct: pct(operational, expectedValue),
    scopeCount: scopes.length,
    scopesWithOccupancy: withOccupancy,
    capacityKnownForAll: expectedKnown,
  };
}

// ---------------------------------------------------------------------------
// Weekday / hour shape
// ---------------------------------------------------------------------------

export interface HeatmapBin {
  /** 0 = Sunday … 6 = Saturday, in the study timezone. */
  readonly weekday: number;
  /** 0-23 local hour. */
  readonly hour: number;
  readonly occupiedPortMinutes: number;
  readonly operationalPortMinutes: number;
  /** Null when no observation covered this bin — rendered as missing, not zero. */
  readonly occupancyPct: number | null;
  readonly hasData: boolean;
}

export interface Heatmap {
  readonly timeZone: string;
  readonly bins: readonly HeatmapBin[];
  readonly binsWithData: number;
  /** Highest-occupancy contiguous local-hour band, when enough data exists. */
  readonly peak: { readonly weekdayGroup: 'weekdays' | 'weekend' | 'all'; readonly startHour: number; readonly endHour: number; readonly occupancyPct: number } | null;
}

const EMPTY_BIN_COUNT = 7 * 24;

/**
 * Buckets valid intervals into weekday × local-hour bins.
 *
 * A single interval spanning several hours is attributed to every hour it
 * actually covers, weighted by the minutes in each.
 */
export function computeHeatmap(
  sets: readonly ScopeIntervalSet[],
  timeZone: string = STUDY_TIME_ZONE,
): Heatmap {
  const occupied = new Float64Array(EMPTY_BIN_COUNT);
  const operational = new Float64Array(EMPTY_BIN_COUNT);
  const touched = new Uint8Array(EMPTY_BIN_COUNT);

  for (const set of sets) {
    for (const iv of set.intervals) {
      if (!iv.counts.supportsOccupancy) continue;
      const occupiedCount = iv.counts.occupied ?? 0;
      const operationalCount = iv.counts.operationalCount ?? 0;
      for (const piece of splitByLocalHour(iv.span, timeZone)) {
        const minutes = (piece.span.endMs - piece.span.startMs) / 60_000;
        const index = piece.weekday * 24 + piece.hour;
        occupied[index] = (occupied[index] as number) + occupiedCount * minutes;
        operational[index] = (operational[index] as number) + operationalCount * minutes;
        touched[index] = 1;
      }
    }
  }

  const bins: HeatmapBin[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const index = weekday * 24 + hour;
      const occ = occupied[index] as number;
      const op = operational[index] as number;
      const hasData = touched[index] === 1;
      bins.push({
        weekday,
        hour,
        occupiedPortMinutes: occ,
        operationalPortMinutes: op,
        occupancyPct: hasData && op > 0 ? (100 * occ) / op : null,
        hasData,
      });
    }
  }

  return {
    timeZone,
    bins,
    binsWithData: bins.filter((b) => b.hasData).length,
    peak: findPeakBand(bins),
  };
}

/**
 * Finds the busiest 3-hour local band separately for weekdays and weekends and
 * reports whichever is higher. Returns null unless the band has data in every
 * hour, so a single observed hour cannot become a "peak period" claim.
 */
function findPeakBand(bins: readonly HeatmapBin[]): Heatmap['peak'] {
  const groups: Array<{ name: 'weekdays' | 'weekend'; days: number[] }> = [
    { name: 'weekdays', days: [1, 2, 3, 4, 5] },
    { name: 'weekend', days: [0, 6] },
  ];
  let best: Heatmap['peak'] = null;
  const bandLength = 3;

  for (const group of groups) {
    for (let startHour = 0; startHour <= 24 - bandLength; startHour += 1) {
      let occ = 0;
      let op = 0;
      let complete = true;
      for (let h = startHour; h < startHour + bandLength; h += 1) {
        for (const day of group.days) {
          const bin = bins[day * 24 + h];
          if (!bin || !bin.hasData) {
            complete = false;
            break;
          }
          occ += bin.occupiedPortMinutes;
          op += bin.operationalPortMinutes;
        }
        if (!complete) break;
      }
      if (!complete || op <= 0) continue;
      const occupancyPct = (100 * occ) / op;
      if (!best || occupancyPct > best.occupancyPct) {
        best = {
          weekdayGroup: group.name,
          startHour,
          endHour: startHour + bandLength,
          occupancyPct,
        };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Current-status presentation
// ---------------------------------------------------------------------------

export interface CurrentStatusView {
  readonly available: number | null;
  readonly occupied: number | null;
  readonly outOfService: number | null;
  readonly unknown: number | null;
  readonly observedAtUtcMs: number;
  readonly sourceUpdatedAtUtcMs: number | null;
  readonly sourceFreshness: 'fresh' | 'stale' | 'unknown_source_clock';
  /**
   * Copy the UI must use: "in use" unless the source explicitly separates
   * actively charging from merely occupied.
   */
  readonly occupiedLabel: 'charging' | 'reported in use';
}

/**
 * Builds the "current status" panel from the newest snapshot.
 *
 * This is deliberately separate from historical occupancy: they are different
 * quantities and must never share a colour or a caption.
 */
export function currentStatus(
  snapshots: readonly StatusSnapshot[],
  classify: (s: StatusSnapshot) => 'fresh' | 'stale' | 'unknown_source_clock',
): CurrentStatusView | null {
  let newest: StatusSnapshot | null = null;
  for (const s of snapshots) {
    if (s.quality === 'invalid') continue;
    if (!newest || s.observedAtUtcMs > newest.observedAtUtcMs) newest = s;
  }
  if (!newest) return null;
  return {
    available: newest.counts.available,
    occupied: newest.counts.occupied,
    outOfService: newest.counts.outOfService,
    unknown: newest.counts.unknown,
    observedAtUtcMs: newest.observedAtUtcMs,
    sourceUpdatedAtUtcMs: newest.sourceUpdatedAtUtcMs,
    sourceFreshness: classify(newest),
    occupiedLabel: newest.distinguishesCharging ? 'charging' : 'reported in use',
  };
}
