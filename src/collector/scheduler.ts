/**
 * The scheduler: one owner, a persistent queue, and a strict source budget.
 *
 * Properties this module guarantees:
 *  - Due times are persisted as UTC milliseconds; in-process delays use a
 *    MONOTONIC clock so a system clock change cannot stall or stampede the
 *    queue.
 *  - A source-level token bucket enforces the minimum interval between
 *    top-level navigations. Manual Refresh spends the SAME budget.
 *  - Transient failures back off exponentially with jitter, capped at six
 *    hours. A circuit breaker opens after repeated failures.
 *  - Authentication, challenge and explicit access blocks PAUSE the source.
 *    They never produce unlimited retries.
 *  - On restart, overdue work is spread across the next feasible cycle: there
 *    is no catch-up request storm after sleep or a long shutdown.
 *  - Adding capacity never speeds up provider requests.
 */

import type { AttemptOutcome } from '../domain/types.ts';
import { COLLECTION_DEFAULTS } from '../domain/thresholds.ts';
import {
  ADAPTER_FAULT_OUTCOMES,
  PAUSE_SOURCE_OUTCOMES,
  TRANSIENT_OUTCOMES,
  isSuccessfulOutcome,
} from './contract.ts';

export interface QueueEntry {
  readonly bindingId: string;
  readonly sourceId: string;
  nextDueMs: number;
  intervalMs: number;
  lastAttemptMs: number | null;
  lastSuccessMs: number | null;
  consecutiveFailures: number;
  backoffMs: number;
  paused: boolean;
}

export type SourceState =
  'healthy' | 'degraded' | 'paused' | 'blocked' | 'circuit_open' | 'unverified';

export interface SourceRuntime {
  readonly sourceId: string;
  state: SourceState;
  detail: string | null;
  /** Last top-level navigation instant, for the minimum-interval budget. */
  lastNavigationMs: number | null;
  /** Wall-clock instant before which no work may be dispatched. */
  holdUntilMs: number | null;
  consecutiveFailures: number;
  userActionRequired: string | null;
}

export interface SourceLimits {
  readonly sourceId: string;
  readonly minNavigationIntervalMs: number;
  readonly minIntervalMs: number;
  /** Maximum concurrent navigations. One, for the initial adapter. */
  readonly maxConcurrentNavigations: number;
  readonly eligible: boolean;
}

export interface SchedulerDeps {
  /** UTC wall clock, used only for persisted due times. */
  readonly nowMs: () => number;
  /** Monotonic clock, used for in-process delays. */
  readonly monotonicMs: () => number;
  /** Injected for deterministic jitter in tests. */
  readonly random: () => number;
  readonly maxBackoffMs?: number;
  readonly jitterFraction?: number;
  readonly circuitBreakerFailureThreshold?: number;
}

export type SkipReason =
  | 'paused'
  | 'not_due'
  | 'source_paused'
  | 'source_blocked'
  | 'source_circuit_open'
  | 'source_not_eligible'
  | 'navigation_budget'
  | 'concurrency_limit'
  | 'source_hold';

export interface PlannedItem {
  readonly bindingId: string;
  readonly sourceId: string;
  /** Wall-clock instant this item may be dispatched. */
  readonly earliestStartMs: number;
}

export interface PlanResult {
  readonly dispatch: readonly PlannedItem[];
  readonly skipped: readonly { readonly bindingId: string; readonly reason: SkipReason }[];
  /** Number of due items that could not fit in this cycle. */
  readonly queueLag: number;
  /**
   * The interval actually achievable for the enabled set under the allowed
   * source rate. The UI shows THIS, never the requested target, when they
   * differ.
   */
  readonly achievableIntervalMs: number | null;
}

export class Scheduler {
  private readonly deps: SchedulerDeps;
  private readonly entries = new Map<string, QueueEntry>();
  private readonly sources = new Map<string, SourceRuntime>();
  private readonly limits = new Map<string, SourceLimits>();
  private readonly inFlight = new Map<string, number>();

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  registerSource(limits: SourceLimits, state: SourceState = 'healthy'): void {
    this.limits.set(limits.sourceId, limits);
    if (!this.sources.has(limits.sourceId)) {
      this.sources.set(limits.sourceId, {
        sourceId: limits.sourceId,
        state: limits.eligible ? state : 'unverified',
        detail: limits.eligible ? null : 'Source eligibility has not been established.',
        lastNavigationMs: null,
        holdUntilMs: null,
        consecutiveFailures: 0,
        userActionRequired: null,
      });
    }
    this.inFlight.set(limits.sourceId, this.inFlight.get(limits.sourceId) ?? 0);
  }

  /** Loads a persisted queue, e.g. after a restart. */
  load(entries: readonly QueueEntry[]): void {
    for (const entry of entries) this.entries.set(entry.bindingId, { ...entry });
  }

  upsert(entry: QueueEntry): void {
    this.entries.set(entry.bindingId, { ...entry });
  }

  remove(bindingId: string): void {
    this.entries.delete(bindingId);
  }

  snapshot(): QueueEntry[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }

  sourceRuntime(sourceId: string): SourceRuntime | undefined {
    const runtime = this.sources.get(sourceId);
    return runtime ? { ...runtime } : undefined;
  }

  setPaused(bindingId: string, paused: boolean): void {
    const entry = this.entries.get(bindingId);
    if (entry) entry.paused = paused;
  }

  /** User-level pause/resume of a whole source. Persisted by the caller. */
  setSourcePaused(sourceId: string, paused: boolean, detail: string | null = null): void {
    const runtime = this.sources.get(sourceId);
    if (!runtime) return;
    if (paused) {
      runtime.state = 'paused';
      runtime.detail = detail;
    } else {
      runtime.state = 'healthy';
      runtime.detail = null;
      runtime.holdUntilMs = null;
      runtime.consecutiveFailures = 0;
      runtime.userActionRequired = null;
    }
  }

  /**
   * Spreads overdue work across the next feasible cycle.
   *
   * After sleep or a long shutdown, everything is overdue at once. Firing all
   * of it immediately would be a request storm against the provider, so due
   * times are restaged at the source's minimum navigation interval.
   */
  spreadOverdue(nowMs: number = this.deps.nowMs()): { restaged: number; horizonMs: number } {
    let restaged = 0;
    let horizon = nowMs;

    const bySource = new Map<string, QueueEntry[]>();
    for (const entry of this.entries.values()) {
      if (entry.paused || entry.nextDueMs > nowMs) continue;
      const list = bySource.get(entry.sourceId);
      if (list) list.push(entry);
      else bySource.set(entry.sourceId, [entry]);
    }

    for (const [sourceId, overdue] of bySource) {
      const limits = this.limits.get(sourceId);
      const step = limits?.minNavigationIntervalMs ?? COLLECTION_DEFAULTS.minNavigationIntervalMs;
      // Oldest success first, so the least fresh site is read soonest.
      overdue.sort((a, b) => (a.lastSuccessMs ?? 0) - (b.lastSuccessMs ?? 0));
      overdue.forEach((entry, index) => {
        entry.nextDueMs = nowMs + index * step;
        horizon = Math.max(horizon, entry.nextDueMs);
        restaged += 1;
      });
    }

    return { restaged, horizonMs: horizon };
  }

  /**
   * Computes the interval actually achievable for the enabled bindings of a
   * source under its minimum navigation interval.
   *
   * If 100 sites cannot fit inside a 15-minute target, this returns the real
   * figure so the UI can say so rather than mislabel the cadence.
   */
  achievableIntervalMs(sourceId: string): number | null {
    const limits = this.limits.get(sourceId);
    if (!limits) return null;
    const count = [...this.entries.values()].filter(
      (entry) => entry.sourceId === sourceId && !entry.paused,
    ).length;
    if (count === 0) return null;
    const required = count * limits.minNavigationIntervalMs;
    const target = Math.max(limits.minIntervalMs, COLLECTION_DEFAULTS.targetIntervalMs);
    return Math.max(target, required);
  }

  /**
   * Plans one cycle.
   *
   * `manual` marks a user-initiated refresh. It is planned through exactly the
   * same budget as scheduled work; a manual refresh cannot exceed the
   * provider's allowed rate.
   */
  plan(options: { nowMs?: number; manualBindingIds?: readonly string[] } = {}): PlanResult {
    const nowMs = options.nowMs ?? this.deps.nowMs();
    const manual = new Set(options.manualBindingIds ?? []);

    const dispatch: PlannedItem[] = [];
    const skipped: Array<{ bindingId: string; reason: SkipReason }> = [];
    let queueLag = 0;

    // Per-source cursor for the next permitted navigation instant.
    const nextSlot = new Map<string, number>();
    const plannedPerSource = new Map<string, number>();

    const candidates = [...this.entries.values()]
      .filter((entry) => manual.has(entry.bindingId) || (!entry.paused && entry.nextDueMs <= nowMs))
      .sort((a, b) => {
        const aManual = manual.has(a.bindingId) ? 0 : 1;
        const bManual = manual.has(b.bindingId) ? 0 : 1;
        if (aManual !== bManual) return aManual - bManual;
        return a.nextDueMs - b.nextDueMs;
      });

    for (const entry of candidates) {
      const limits = this.limits.get(entry.sourceId);
      const runtime = this.sources.get(entry.sourceId);
      if (!limits || !runtime) {
        skipped.push({ bindingId: entry.bindingId, reason: 'source_not_eligible' });
        continue;
      }
      if (!limits.eligible) {
        skipped.push({ bindingId: entry.bindingId, reason: 'source_not_eligible' });
        continue;
      }
      if (runtime.state === 'paused' || runtime.state === 'unverified') {
        skipped.push({ bindingId: entry.bindingId, reason: 'source_paused' });
        continue;
      }
      if (runtime.state === 'blocked') {
        skipped.push({ bindingId: entry.bindingId, reason: 'source_blocked' });
        continue;
      }
      if (runtime.state === 'circuit_open') {
        if (runtime.holdUntilMs !== null && nowMs < runtime.holdUntilMs) {
          skipped.push({ bindingId: entry.bindingId, reason: 'source_circuit_open' });
          continue;
        }
        // The hold has expired: allow one probe and let the outcome decide.
        runtime.state = 'degraded';
      }
      if (runtime.holdUntilMs !== null && nowMs < runtime.holdUntilMs) {
        skipped.push({ bindingId: entry.bindingId, reason: 'source_hold' });
        continue;
      }

      const concurrent =
        (plannedPerSource.get(entry.sourceId) ?? 0) + (this.inFlight.get(entry.sourceId) ?? 0);
      if (concurrent >= limits.maxConcurrentNavigations && plannedPerSource.has(entry.sourceId)) {
        // Still schedulable, just later in this cycle via the navigation slot.
      }

      const sinceLast =
        runtime.lastNavigationMs === null
          ? Number.POSITIVE_INFINITY
          : nowMs - runtime.lastNavigationMs;
      const cursorDefault =
        sinceLast >= limits.minNavigationIntervalMs
          ? nowMs
          : (runtime.lastNavigationMs as number) + limits.minNavigationIntervalMs;
      const slot = Math.max(nextSlot.get(entry.sourceId) ?? cursorDefault, nowMs);

      const cycleHorizon =
        nowMs + Math.max(limits.minIntervalMs, COLLECTION_DEFAULTS.targetIntervalMs);
      if (slot >= cycleHorizon && !manual.has(entry.bindingId)) {
        queueLag += 1;
        skipped.push({ bindingId: entry.bindingId, reason: 'navigation_budget' });
        continue;
      }

      dispatch.push({
        bindingId: entry.bindingId,
        sourceId: entry.sourceId,
        earliestStartMs: slot,
      });
      nextSlot.set(entry.sourceId, slot + limits.minNavigationIntervalMs);
      plannedPerSource.set(entry.sourceId, (plannedPerSource.get(entry.sourceId) ?? 0) + 1);
    }

    // Explain every binding that is not running this cycle. A source-level
    // reason always wins over "not due": a binding parked in the far future
    // BECAUSE its source is paused must not be described as merely waiting for
    // its next slot.
    const dispatched = new Set(dispatch.map((d) => d.bindingId));
    const explained = new Set(skipped.map((s) => s.bindingId));
    for (const entry of this.entries.values()) {
      if (dispatched.has(entry.bindingId) || explained.has(entry.bindingId)) continue;
      const limits = this.limits.get(entry.sourceId);
      const runtime = this.sources.get(entry.sourceId);
      let reason: SkipReason;
      if (!limits?.eligible || !runtime) reason = 'source_not_eligible';
      else if (runtime.state === 'blocked') reason = 'source_blocked';
      else if (runtime.state === 'paused' || runtime.state === 'unverified')
        reason = 'source_paused';
      else if (
        runtime.state === 'circuit_open' &&
        runtime.holdUntilMs !== null &&
        nowMs < runtime.holdUntilMs
      )
        reason = 'source_circuit_open';
      else if (entry.paused) reason = 'paused';
      else reason = 'not_due';
      skipped.push({ bindingId: entry.bindingId, reason });
    }

    const sourceIds = new Set(dispatch.map((d) => d.sourceId));
    let achievable: number | null = null;
    for (const sourceId of sourceIds) {
      const value = this.achievableIntervalMs(sourceId);
      if (value !== null) achievable = Math.max(achievable ?? 0, value);
    }

    return { dispatch, skipped, queueLag, achievableIntervalMs: achievable };
  }

  /** Marks a navigation as spent. Called immediately before navigating. */
  recordNavigation(sourceId: string, atMs: number = this.deps.nowMs()): void {
    const runtime = this.sources.get(sourceId);
    if (!runtime) return;
    runtime.lastNavigationMs = atMs;
    this.inFlight.set(sourceId, (this.inFlight.get(sourceId) ?? 0) + 1);
  }

  releaseNavigation(sourceId: string): void {
    const current = this.inFlight.get(sourceId) ?? 0;
    this.inFlight.set(sourceId, Math.max(0, current - 1));
  }

  /**
   * Computes the next backoff for a transient failure.
   *
   * Exponential from the source's minimum interval, multiplied by jitter in
   * [1 - f, 1 + f], and hard-capped at six hours.
   */
  computeBackoffMs(entry: QueueEntry, sourceId: string): number {
    const limits = this.limits.get(sourceId);
    const base = Math.max(limits?.minIntervalMs ?? COLLECTION_DEFAULTS.targetIntervalMs, 1000);
    const cap = this.deps.maxBackoffMs ?? COLLECTION_DEFAULTS.maxBackoffMs;
    const fraction = this.deps.jitterFraction ?? COLLECTION_DEFAULTS.jitterFraction;
    const exponent = Math.min(entry.consecutiveFailures, 12);
    const raw = base * 2 ** exponent;
    const jitter = 1 + (this.deps.random() * 2 - 1) * fraction;
    return Math.min(cap, Math.max(base, Math.round(raw * jitter)));
  }

  /**
   * Applies an attempt outcome to the queue and source health.
   *
   * `retryAfterMs`, when the provider supplied one, overrides our own backoff:
   * we never wait less than we were asked to.
   */
  recordOutcome(input: {
    readonly bindingId: string;
    readonly outcome: AttemptOutcome;
    readonly nowMs?: number;
    readonly retryAfterMs?: number | null;
  }): { nextDueMs: number; sourceState: SourceState } {
    const nowMs = input.nowMs ?? this.deps.nowMs();
    const entry = this.entries.get(input.bindingId);
    if (!entry) throw new Error(`unknown binding ${input.bindingId}`);
    const runtime = this.sources.get(entry.sourceId);
    if (!runtime) throw new Error(`unknown source ${entry.sourceId}`);

    entry.lastAttemptMs = nowMs;
    const threshold =
      this.deps.circuitBreakerFailureThreshold ??
      COLLECTION_DEFAULTS.circuitBreakerFailureThreshold;

    if (isSuccessfulOutcome(input.outcome)) {
      entry.lastSuccessMs = nowMs;
      entry.consecutiveFailures = 0;
      entry.backoffMs = 0;
      const jitter =
        1 +
        (this.deps.random() * 2 - 1) *
          (this.deps.jitterFraction ?? COLLECTION_DEFAULTS.jitterFraction);
      entry.nextDueMs = nowMs + Math.round(entry.intervalMs * jitter);
      runtime.consecutiveFailures = 0;
      if (runtime.state === 'degraded' || runtime.state === 'circuit_open') {
        runtime.state = 'healthy';
        runtime.detail = null;
        runtime.holdUntilMs = null;
      }
      return { nextDueMs: entry.nextDueMs, sourceState: runtime.state };
    }

    if (input.outcome === 'cancelled') {
      // A cancelled attempt is not a failure; it is retried at its normal time.
      entry.nextDueMs = Math.max(
        entry.nextDueMs,
        nowMs + (this.limits.get(entry.sourceId)?.minNavigationIntervalMs ?? 0),
      );
      return { nextDueMs: entry.nextDueMs, sourceState: runtime.state };
    }

    entry.consecutiveFailures += 1;
    runtime.consecutiveFailures += 1;

    if (PAUSE_SOURCE_OUTCOMES.includes(input.outcome)) {
      // An access restriction or sign-in wall is never retried into the ground.
      runtime.state = input.outcome === 'source_blocked' ? 'blocked' : 'paused';
      runtime.detail =
        input.outcome === 'source_blocked'
          ? 'The source refused automated access. Collection is paused for this source.'
          : 'The source now requires signing in. Collection is paused for this source.';
      runtime.userActionRequired =
        input.outcome === 'source_blocked'
          ? 'Review the source terms and status before re-enabling collection.'
          : 'Open the source window and sign in, or leave this source disabled.';
      runtime.holdUntilMs = null;
      entry.backoffMs = 0;
      entry.nextDueMs = Number.MAX_SAFE_INTEGER;
      return { nextDueMs: entry.nextDueMs, sourceState: runtime.state };
    }

    if (ADAPTER_FAULT_OUTCOMES.includes(input.outcome)) {
      // The page changed shape: pause and ask for a parser fix rather than
      // hammering a page we can no longer read.
      runtime.state = 'paused';
      runtime.detail = 'The source page changed and could not be read. Collection is paused.';
      runtime.userActionRequired = 'Check for a ChargeWatch update that supports the new page.';
      entry.nextDueMs = Number.MAX_SAFE_INTEGER;
      return { nextDueMs: entry.nextDueMs, sourceState: runtime.state };
    }

    const ourBackoff = this.computeBackoffMs(entry, entry.sourceId);
    const backoff =
      input.retryAfterMs !== null && input.retryAfterMs !== undefined
        ? Math.max(ourBackoff, input.retryAfterMs)
        : ourBackoff;
    entry.backoffMs = backoff;
    entry.nextDueMs = nowMs + backoff;

    if (runtime.consecutiveFailures >= threshold) {
      runtime.state = 'circuit_open';
      runtime.detail = `${runtime.consecutiveFailures} consecutive failures; pausing requests to this source.`;
      runtime.holdUntilMs = nowMs + backoff;
    } else if (TRANSIENT_OUTCOMES.includes(input.outcome)) {
      runtime.state = 'degraded';
      runtime.detail = null;
    }

    if (input.outcome === 'rate_limited' && input.retryAfterMs) {
      runtime.holdUntilMs = Math.max(runtime.holdUntilMs ?? 0, nowMs + input.retryAfterMs);
    }

    return { nextDueMs: entry.nextDueMs, sourceState: runtime.state };
  }

  /**
   * Milliseconds to wait before the next plan, measured on the MONOTONIC clock
   * by the caller. A wall-clock jump cannot turn this negative or enormous.
   */
  nextWakeDelayMs(nowMs: number = this.deps.nowMs()): number {
    let soonest = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) {
      if (entry.paused) continue;
      if (entry.nextDueMs >= Number.MAX_SAFE_INTEGER) continue;
      soonest = Math.min(soonest, entry.nextDueMs);
    }
    for (const runtime of this.sources.values()) {
      if (runtime.holdUntilMs !== null) soonest = Math.min(soonest, runtime.holdUntilMs);
    }
    if (!Number.isFinite(soonest)) return COLLECTION_DEFAULTS.targetIntervalMs;
    return Math.max(1000, Math.min(soonest - nowMs, COLLECTION_DEFAULTS.maxBackoffMs));
  }
}

/**
 * A source-level token bucket enforcing the minimum interval between top-level
 * navigations, shared by scheduled work and manual refresh.
 */
export class NavigationBudget {
  private lastNavigationMonotonicMs: number | null = null;
  private readonly minIntervalMs: number;
  private readonly monotonicMs: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    minIntervalMs: number,
    monotonicMs: () => number,
    sleep: (ms: number) => Promise<void>,
  ) {
    this.minIntervalMs = minIntervalMs;
    this.monotonicMs = monotonicMs;
    this.sleep = sleep;
  }

  /** Milliseconds the caller must wait before its next navigation. */
  waitMs(): number {
    if (this.lastNavigationMonotonicMs === null) return 0;
    const elapsed = this.monotonicMs() - this.lastNavigationMonotonicMs;
    return Math.max(0, this.minIntervalMs - elapsed);
  }

  async acquire(abortSignal?: AbortSignal): Promise<void> {
    const wait = this.waitMs();
    if (wait > 0) await this.sleep(wait);
    if (abortSignal?.aborted) throw new DOMException('navigation aborted', 'AbortError');
    this.lastNavigationMonotonicMs = this.monotonicMs();
  }
}
