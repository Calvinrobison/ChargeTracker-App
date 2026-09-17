/**
 * Dependency-free domain vocabulary.
 *
 * These are the shapes the metric engine reasons about. Runtime validation of
 * anything crossing a process or file boundary lives in `src/shared/contracts`
 * (Zod); the domain deliberately stays dependency-free so its logic can be
 * executed and tested without installing packages.
 */

/** Port state vocabulary. `unknown` is a first-class value, never zero. */
export type PortState = 'available' | 'occupied' | 'reserved' | 'out_of_service' | 'unknown';

export const PORT_STATES: readonly PortState[] = [
  'available',
  'occupied',
  'reserved',
  'out_of_service',
  'unknown',
];

/** How an observation was obtained. */
export type ObservationMethod = 'rendered_dom' | 'local_ocr' | 'manual' | 'authorized_api';

/** What physical extent a snapshot describes. */
export type ObservationGranularity = 'port' | 'station_aggregate' | 'charger_subgroup';

/** What the provider's capacity number actually counts. */
export type CapacityBasis =
  | 'ports_simultaneous' // distinct simultaneous vehicle-serving positions
  | 'connectors' // plug count, which may over-count simultaneous capacity
  | 'reported_total' // provider's own unexplained total
  | 'unknown';

/** Charging class. `unknown` is never silently converted to a real class. */
export type ChargingLevel = 'level_2' | 'dc_fast' | 'level_1' | 'mixed' | 'unknown';

/** Whether a snapshot fully describes its declared scope. */
export type Completeness = 'complete' | 'partial';

/**
 * Bounded quality classification attached to every observation.
 * `ambiguous_scope` observations are excluded from occupancy metrics.
 */
export type QualityClass =
  | 'reliable'
  | 'provisional'
  | 'stale_source'
  | 'ambiguous_scope'
  | 'invalid';

/** Source-timestamp freshness. The absence of a source clock is distinct from staleness. */
export type SourceFreshness = 'fresh' | 'stale' | 'unknown_source_clock';

/** Durable outcome of a collection attempt. Failure never becomes a zero observation. */
export type AttemptOutcome =
  | 'succeeded'
  | 'partial'
  | 'timeout'
  | 'offline'
  | 'login_required'
  | 'source_blocked'
  | 'rate_limited'
  | 'layout_changed'
  | 'invalid_data'
  | 'cancelled';

/** Outcomes that must never contribute occupancy or coverage. */
export const NON_OBSERVING_OUTCOMES: readonly AttemptOutcome[] = [
  'timeout',
  'offline',
  'login_required',
  'source_blocked',
  'rate_limited',
  'layout_changed',
  'invalid_data',
  'cancelled',
];

/** Why a monitoring window is not collecting. */
export type MonitoringGapReason =
  | 'not_enabled'
  | 'user_paused'
  | 'app_not_running'
  | 'computer_asleep'
  | 'offline'
  | 'source_paused'
  | 'browser_failure'
  | 'update_install'
  | 'migration'
  | 'unclean_exit';

/**
 * Counts reported by a source for one scope at one instant.
 * `null` means the source did not report that dimension. Zero means the source
 * reported zero. The two are never interchangeable.
 */
export interface StateCounts {
  readonly available: number | null;
  readonly occupied: number | null;
  readonly reserved: number | null;
  readonly outOfService: number | null;
  readonly unknown: number | null;
  /** Provider-reported total for the scope, when present. */
  readonly total: number | null;
}

export const EMPTY_COUNTS: StateCounts = {
  available: null,
  occupied: null,
  reserved: null,
  outOfService: null,
  unknown: null,
  total: null,
};

/**
 * The freshness policy in force when an observation was recorded.
 * Persisted per observation so later settings changes cannot rewrite history.
 */
export interface FreshnessPolicy {
  /** The scheduled collection interval in force, in ms. */
  readonly scheduledIntervalMs: number;
  /** Hard product cap on carry-forward, in ms (default 30 minutes). */
  readonly maxCarryForwardCapMs: number;
  /** Provider-declared freshness limit, if the source documents one. */
  readonly sourceFreshnessLimitMs: number | null;
}

export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = {
  scheduledIntervalMs: 15 * 60_000,
  maxCarryForwardCapMs: 30 * 60_000,
  sourceFreshnessLimitMs: null,
};

/**
 * Effective carry-forward budget for an observation: the minimum of two
 * scheduled intervals, the product cap, and any provider freshness limit.
 */
export function carryForwardBudgetMs(policy: FreshnessPolicy): number {
  const candidates = [policy.scheduledIntervalMs * 2, policy.maxCarryForwardCapMs];
  if (policy.sourceFreshnessLimitMs !== null) candidates.push(policy.sourceFreshnessLimitMs);
  return Math.max(0, Math.min(...candidates));
}

/** An immutable status snapshot for one observation scope. */
export interface StatusSnapshot {
  readonly observationId: string;
  readonly bindingId: string;
  /** Stable key for the physical scope this snapshot describes. */
  readonly scopeKey: string;
  readonly observedAtUtcMs: number;
  /** Provider's own "as of" time, when the page exposes one. */
  readonly sourceUpdatedAtUtcMs: number | null;
  readonly method: ObservationMethod;
  readonly granularity: ObservationGranularity;
  readonly counts: StateCounts;
  readonly capacityBasis: CapacityBasis;
  readonly completeness: Completeness;
  readonly quality: QualityClass;
  readonly freshnessPolicy: FreshnessPolicy;
  /** Charging class of the observed scope, when the source distinguishes it. */
  readonly level: ChargingLevel;
  /**
   * True only when the source explicitly separates "actively charging" from
   * "occupied". When false, occupancy must be described as "reported in use".
   */
  readonly distinguishesCharging: boolean;
}

/** An effective-dated installed-capacity record for a scope. */
export interface CapacityRecord {
  readonly scopeKey: string;
  readonly startMs: number;
  /** null = still in force. */
  readonly endMs: number | null;
  readonly capacityPorts: number;
  readonly level: ChargingLevel;
  readonly basis: CapacityBasis;
}

/** A period during which a scope was intentionally monitored. */
export interface MonitoringWindow {
  readonly scopeKey: string;
  readonly startMs: number;
  /** null = still monitored. */
  readonly endMs: number | null;
}

/** A recorded break in collection. Missing time is never zero usage. */
export interface CollectionGap {
  readonly scopeKey: string | null; // null = applies to every scope
  readonly startMs: number;
  readonly endMs: number;
  readonly reason: MonitoringGapReason;
}

/** Stable per-port state, only when the source provides durable port identity. */
export interface PortSnapshot {
  readonly observationId: string;
  readonly scopeKey: string;
  readonly sourcePortId: string;
  readonly observedAtUtcMs: number;
  readonly state: PortState;
  readonly level: ChargingLevel;
}
