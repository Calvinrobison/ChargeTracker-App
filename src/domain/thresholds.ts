/**
 * Every display and eligibility threshold in one place.
 *
 * These are explicit initial PRODUCT decisions, not statistical guarantees.
 * The legend, the map, the rankings and the documentation all read them from
 * here so a change cannot drift between surfaces.
 */

export const OCCUPANCY_BANDS = {
  /** Below this percentage the band is "low". */
  lowBelowPct: 30,
  /** At or above `lowBelowPct` and below this is "moderate". */
  moderateBelowPct: 60,
} as const;

export type OccupancyBand = 'low' | 'moderate' | 'high' | 'unsupported';

/**
 * Maps an occupancy percentage to a display band.
 *
 * Null (unsupported, insufficient history, unknown metric) is its own band and
 * renders grey with a text label — never as a low-occupancy green.
 */
export function occupancyBand(occupancyPct: number | null): OccupancyBand {
  if (occupancyPct === null || !Number.isFinite(occupancyPct)) return 'unsupported';
  if (occupancyPct < OCCUPANCY_BANDS.lowBelowPct) return 'low';
  if (occupancyPct < OCCUPANCY_BANDS.moderateBelowPct) return 'moderate';
  return 'high';
}

/** Legend copy, kept beside the thresholds it describes. */
export const BAND_LABELS: Record<OccupancyBand, string> = {
  low: `Low · under ${OCCUPANCY_BANDS.lowBelowPct}%`,
  moderate: `Moderate · ${OCCUPANCY_BANDS.lowBelowPct}–${OCCUPANCY_BANDS.moderateBelowPct}%`,
  high: `High · ${OCCUPANCY_BANDS.moderateBelowPct}% and above`,
  unsupported: 'Insufficient history',
};

/**
 * The legend must always say what the colour means and must always carry this
 * disclaimer: historical occupancy is not current availability.
 */
export const HISTORICAL_NOT_CURRENT_NOTE = 'Historical occupancy is not current availability.';

/** Primary-ranking eligibility gates. */
export const RANKING_ELIGIBILITY = {
  /** Minimum elapsed days inside the shared study window. */
  minElapsedDays: 7,
  /** Minimum known-state coverage, as a percentage. */
  minStatusCoveragePct: 90,
} as const;

/** Collection scheduling defaults. */
export const COLLECTION_DEFAULTS = {
  targetIntervalMs: 15 * 60_000,
  /** Minimum time between top-level source navigations. */
  minNavigationIntervalMs: 30_000,
  /** Maximum transient-failure backoff. */
  maxBackoffMs: 6 * 60 * 60_000,
  /** Consecutive failures before the circuit breaker opens. */
  circuitBreakerFailureThreshold: 5,
  /** Scheduling jitter as a fraction of the interval. */
  jitterFraction: 0.1,
  /** Default number of automatically matched supported sites to enable. */
  defaultEnabledSiteTarget: 20,
} as const;

/** Study-area defaults. Product defaults, not a claim about the user's address. */
export const STUDY_AREA_DEFAULTS = {
  centerLatitude: 33.4152,
  centerLongitude: -111.8315,
  radiusMiles: 50,
  label: 'Mesa, AZ',
} as const;

/** Diagnostic-evidence retention. */
export const DIAGNOSTIC_LIMITS = {
  failureScreenshotRetentionDays: 7,
  diagnosticCapBytes: 100 * 1024 * 1024,
} as const;

/** Backup retention. */
export const BACKUP_RETENTION = {
  dailyCopies: 7,
  preMigrationCopies: 3,
} as const;
