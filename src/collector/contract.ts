/**
 * The collector contract.
 *
 * Division of responsibility, which the rest of the collector depends on:
 *
 *  - The shared collector SERVICE owns scheduling, retries, source health,
 *    provenance envelopes, cancellation and rate limits.
 *  - An ADAPTER owns page navigation, rendering readiness, extraction and
 *    provider-specific meanings. It never schedules, never retries on its own
 *    budget, and never writes to SQLite.
 *
 * Adapters return validated observations to the service, which forwards
 * batches to the database worker.
 */

import type {
  AttemptOutcome,
  CapacityBasis,
  ChargingLevel,
  Completeness,
  FreshnessPolicy,
  ObservationGranularity,
  ObservationMethod,
  PortState,
  QualityClass,
  SourceFreshness,
  StateCounts,
} from '../domain/types.ts';

/** Whether automated collection from a source is permitted, and on what basis. */
export type EligibilityState = 'enabled' | 'disabled' | 'needs_review';

/** Whether we have actually proven the adapter works against the live source. */
export type VerificationState = 'verified' | 'unverified' | 'blocked';

/**
 * The compact source capability record (§7).
 *
 * `eligibilityState` is the gate. Visible public content is NOT recorded as
 * affirmative automation permission: a source stays `needs_review` until a
 * documented review concludes otherwise, and the scheduler refuses to collect
 * from anything that is not `enabled`.
 */
export interface SourceCapabilities {
  readonly sourceId: string;
  readonly displayName: string;
  readonly websiteUrls: readonly string[];
  readonly adapterVersion: string;
  readonly capabilityVersion: number;
  readonly supportedRegion: string;
  readonly observationGranularity: ObservationGranularity;
  /** Meaning of each state as the provider uses it, for the docs and the UI. */
  readonly stateMeanings: Readonly<Partial<Record<PortState, string>>>;
  readonly identityReliability: 'durable' | 'unstable' | 'none';
  readonly accessRequirements: string;
  readonly collectionMethod: ObservationMethod;
  readonly minIntervalMs: number;
  readonly minNavigationIntervalMs: number;
  /** Provider-documented freshness limit, when one exists. */
  readonly sourceFreshnessLimitMs: number | null;
  /** True only when the provider separates actively charging from occupied. */
  readonly distinguishesCharging: boolean;
  /** True only with an authorized transaction dataset. */
  readonly providesRecordedSessions: boolean;
  readonly termsUrls: readonly string[];
  readonly termsReviewedAtMs: number | null;
  /** What the review actually covered. A keyword search is not a review. */
  readonly termsReviewScope: string | null;
  readonly eligibilityBasis: string | null;
  readonly eligibilityState: EligibilityState;
  readonly verificationState: VerificationState;
  readonly notes: string | null;
}

export interface BindingDescriptor {
  readonly bindingId: string;
  readonly siteId: string;
  readonly scopeKey: string;
  readonly sourceStationId: string | null;
  readonly canonicalUrl: string;
  readonly physicalScope: string;
  readonly granularity: ObservationGranularity;
  readonly identityReliability: 'durable' | 'unstable' | 'none';
  /** Installed capacity from the catalog, used only as a sanity bound. */
  readonly catalogPortCount: number | null;
  readonly expectedLevel: ChargingLevel;
}

export type BindingValidationCode =
  | 'ok'
  | 'url_not_allowlisted'
  | 'url_not_http'
  | 'station_id_missing'
  | 'station_id_mismatch'
  | 'unsupported_region'
  | 'source_not_eligible';

export interface BindingValidation {
  readonly ok: boolean;
  readonly code: BindingValidationCode;
  readonly detail?: string;
  /** Canonical URL the adapter will actually navigate to. */
  readonly resolvedUrl?: string;
}

/** One observation an adapter extracted, before the service adds provenance. */
export interface AdapterObservation {
  readonly bindingId: string;
  readonly scopeKey: string;
  readonly sourceStationId: string | null;
  /** When the adapter read the rendered content. */
  readonly observedAtUtcMs: number;
  /** Provider's own "as of" time, when the page exposes one. */
  readonly sourceUpdatedAtUtcMs: number | null;
  readonly granularity: ObservationGranularity;
  readonly counts: StateCounts;
  readonly capacityBasis: CapacityBasis;
  readonly completeness: Completeness;
  readonly level: ChargingLevel;
  /** Only when the source genuinely provides durable port identity. */
  readonly ports: readonly {
    readonly sourcePortId: string;
    readonly state: PortState;
    readonly level: ChargingLevel;
  }[];
  readonly sanitizedSourceText: string | null;
  readonly sourceUrl: string;
  readonly quality: QualityClass;
  readonly sourceFreshness: SourceFreshness;
  /** Human-readable notes about ambiguity, for the details panel. */
  readonly warnings: readonly string[];
}

export interface BindingOutcome {
  readonly bindingId: string;
  readonly scopeKey: string;
  readonly outcome: AttemptOutcome;
  readonly startedMs: number;
  readonly finishedMs: number;
  readonly navigationCount: number;
  readonly errorDetail: string | null;
  readonly observation: AdapterObservation | null;
}

export interface CollectionBatch {
  readonly sourceId: string;
  readonly adapterVersion: string;
  readonly attemptId: string;
  readonly startedMs: number;
  readonly finishedMs: number;
  readonly outcomes: readonly BindingOutcome[];
  readonly warnings: readonly string[];
  /** Set when the provider asked us to wait, e.g. a Retry-After header. */
  readonly retryAfterMs: number | null;
}

export interface CollectContext {
  readonly attemptId: string;
  readonly nowMs: () => number;
  readonly freshnessPolicy: FreshnessPolicy;
  /** Per-navigation deadline the adapter must respect. */
  readonly navigationTimeoutMs: number;
  /** Called by the adapter before each top-level navigation to spend budget. */
  readonly acquireNavigationSlot: () => Promise<void>;
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

/** The adapter interface. Four methods, no scheduling, no database access. */
export interface SourceAdapter {
  describeCapabilities(): SourceCapabilities;
  validateBinding(binding: BindingDescriptor): Promise<BindingValidation>;
  collect(
    context: CollectContext,
    bindings: readonly BindingDescriptor[],
    abortSignal: AbortSignal,
  ): Promise<CollectionBatch>;
  close(): Promise<void>;
}

/** Outcomes that must pause the source rather than trigger more retries. */
export const PAUSE_SOURCE_OUTCOMES: readonly AttemptOutcome[] = [
  'login_required',
  'source_blocked',
];

/** Outcomes that are transient and eligible for backoff with jitter. */
export const TRANSIENT_OUTCOMES: readonly AttemptOutcome[] = [
  'timeout',
  'offline',
  'rate_limited',
  'invalid_data',
];

/** Outcomes that indicate the adapter needs a code change. */
export const ADAPTER_FAULT_OUTCOMES: readonly AttemptOutcome[] = ['layout_changed'];

export function isSuccessfulOutcome(outcome: AttemptOutcome): boolean {
  return outcome === 'succeeded' || outcome === 'partial';
}
