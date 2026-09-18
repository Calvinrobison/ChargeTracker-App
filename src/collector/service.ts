/**
 * The collector service: scheduling, retries, provenance and health.
 *
 * Owns everything an adapter must not: the persistent queue, the source token
 * bucket, backoff, the circuit breaker, cancellation, and the provenance
 * envelope wrapped around each observation before it is handed to the database
 * worker. It never writes SQLite itself.
 *
 * A browser crash is contained here. It becomes failed attempts and a source
 * health change; the UI is a separate process and stays up.
 */

import { randomUUID } from 'node:crypto';

import {
  type AdapterObservation,
  type BindingDescriptor,
  type CollectionBatch,
  type SourceAdapter,
  type SourceCapabilities,
  isSuccessfulOutcome,
} from './contract.ts';
import { NavigationBudget, Scheduler, type QueueEntry, type SourceLimits } from './scheduler.ts';
import type { BrowserRuntime } from './browser.ts';
import {
  COLLECTION_DEFAULTS,
  type AttemptOutcome,
  type FreshnessPolicy,
  type QualityClass,
} from '../domain/index.ts';

/** An observation with the provenance envelope the database requires. */
export interface EnvelopedObservation {
  readonly id: string;
  readonly bindingId: string;
  readonly siteId: string;
  readonly scopeKey: string;
  readonly observedAtUtcMs: number;
  readonly sourceUpdatedAtUtcMs: number | null;
  readonly method: SourceCapabilities['collectionMethod'];
  readonly granularity: AdapterObservation['granularity'];
  readonly counts: AdapterObservation['counts'];
  readonly capacityBasis: AdapterObservation['capacityBasis'];
  readonly completeness: AdapterObservation['completeness'];
  readonly level: AdapterObservation['level'];
  readonly distinguishesCharging: boolean;
  readonly freshnessPolicy: FreshnessPolicy;
  readonly sourceUrl: string;
  readonly parserVersion: string;
  readonly evidenceFingerprint: string;
  readonly sanitizedSourceText: string | null;
  readonly quality: QualityClass;
  readonly sourceFreshness: AdapterObservation['sourceFreshness'];
  readonly validation: unknown;
  readonly ports: readonly {
    readonly portId: string;
    readonly sourcePortId: string;
    readonly state: 'available' | 'occupied' | 'reserved' | 'out_of_service' | 'unknown';
    readonly level: AdapterObservation['level'];
  }[];
}

export interface RunReport {
  readonly runId: string;
  readonly sourceId: string;
  readonly adapterVersion: string;
  readonly startedMs: number;
  readonly finishedMs: number;
  readonly outcome: AttemptOutcome | 'succeeded' | 'partial';
  readonly effectiveIntervalMs: number | null;
  readonly cycleDurationMs: number;
  readonly warnings: readonly string[];
  readonly attempts: readonly {
    readonly bindingId: string;
    readonly scopeKey: string;
    readonly startedMs: number;
    readonly finishedMs: number;
    readonly outcome: AttemptOutcome;
    readonly errorDetail: string | null;
    readonly navigationCount: number;
  }[];
  readonly observations: readonly EnvelopedObservation[];
}

export interface CollectorHost {
  /** Hands a completed run to the database worker. */
  submitRun(report: RunReport): Promise<void>;
  /** Records a collection interruption. */
  recordGap(input: {
    readonly scopeKey: string | null;
    readonly startMs: number;
    readonly endMs: number;
    readonly reason:
      | 'user_paused'
      | 'computer_asleep'
      | 'offline'
      | 'source_paused'
      | 'browser_failure'
      | 'update_install';
    readonly detail?: string;
  }): Promise<void>;
  /** Persists the queue so due times survive a restart. */
  persistQueue(entries: readonly QueueEntry[]): Promise<void>;
  /** Persists source health and backoff. */
  persistSourceHealth(input: {
    readonly sourceId: string;
    readonly state: string;
    readonly detail: string | null;
    readonly consecutiveFailures: number;
    readonly backoffUntilMs: number | null;
    readonly lastAttemptMs: number | null;
    readonly lastSuccessMs: number | null;
    readonly userActionRequired: string | null;
  }): Promise<void>;
  /** Reports status to the UI. */
  onStatusChange(): void;
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export interface CollectorServiceOptions {
  readonly host: CollectorHost;
  readonly runtime: BrowserRuntime;
  readonly nowMs?: () => number;
  readonly monotonicMs?: () => number;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const sleepDefault = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export class CollectorService {
  private readonly options: CollectorServiceOptions;
  private readonly scheduler: Scheduler;
  private readonly adapters = new Map<string, SourceAdapter>();
  private readonly budgets = new Map<string, NavigationBudget>();
  private readonly bindings = new Map<
    string,
    BindingDescriptor & { sourceId: string; siteId: string }
  >();
  private readonly nowMs: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private running = false;
  private userPaused = false;
  private online = true;
  private cycleTimer: NodeJS.Timeout | null = null;
  private activeController: AbortController | null = null;
  private lastPlan: { queueLag: number; achievableIntervalMs: number | null } = {
    queueLag: 0,
    achievableIntervalMs: null,
  };
  private pausedAtMs: number | null = null;
  private manualQueue = new Set<string>();

  constructor(options: CollectorServiceOptions) {
    this.options = options;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.sleep = options.sleep ?? sleepDefault;
    this.scheduler = new Scheduler({
      nowMs: this.nowMs,
      monotonicMs: options.monotonicMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n)),
      random: options.random ?? Math.random,
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isUserPaused(): boolean {
    return this.userPaused;
  }

  /**
   * Registers an adapter.
   *
   * A source whose eligibility is not `enabled` is registered but marked
   * ineligible, so the scheduler refuses to collect from it. This is the gate
   * that keeps an unverified source from ever being read.
   */
  registerAdapter(adapter: SourceAdapter): SourceCapabilities {
    const capabilities = adapter.describeCapabilities();
    this.adapters.set(capabilities.sourceId, adapter);

    const limits: SourceLimits = {
      sourceId: capabilities.sourceId,
      minNavigationIntervalMs: Math.max(
        capabilities.minNavigationIntervalMs,
        COLLECTION_DEFAULTS.minNavigationIntervalMs,
      ),
      minIntervalMs: Math.max(capabilities.minIntervalMs, COLLECTION_DEFAULTS.targetIntervalMs),
      maxConcurrentNavigations: 1,
      eligible: capabilities.eligibilityState === 'enabled',
    };
    this.scheduler.registerSource(limits, limits.eligible ? 'healthy' : 'unverified');
    this.budgets.set(
      capabilities.sourceId,
      new NavigationBudget(
        limits.minNavigationIntervalMs,
        this.options.monotonicMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n)),
        this.sleep,
      ),
    );

    if (!limits.eligible) {
      this.options.host.log(
        'warn',
        `source ${capabilities.sourceId} is registered but not enabled (${capabilities.eligibilityState}/${capabilities.verificationState}); no collection will occur from it`,
      );
    }
    return capabilities;
  }

  /** Loads the persisted queue and its bindings. */
  load(input: {
    readonly queue: readonly QueueEntry[];
    readonly bindings: readonly (BindingDescriptor & { sourceId: string; siteId: string })[];
  }): void {
    this.scheduler.load(input.queue);
    for (const binding of input.bindings) this.bindings.set(binding.bindingId, binding);
  }

  /**
   * Starts collection.
   *
   * Overdue work is spread first, so waking from sleep or launching after a
   * long shutdown does not produce a burst of requests.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.userPaused = false;

    if (this.pausedAtMs !== null) {
      await this.options.host.recordGap({
        scopeKey: null,
        startMs: this.pausedAtMs,
        endMs: this.nowMs(),
        reason: 'user_paused',
      });
      this.pausedAtMs = null;
    }

    const spread = this.scheduler.spreadOverdue(this.nowMs());
    if (spread.restaged > 0) {
      this.options.host.log(
        'info',
        `spread ${spread.restaged} overdue bindings across the next ${Math.round((spread.horizonMs - this.nowMs()) / 60_000)} minutes`,
      );
    }
    await this.options.host.persistQueue(this.scheduler.snapshot());
    this.options.host.onStatusChange();
    this.scheduleNextCycle(0);
  }

  /** Pauses collection. The pause is visible and recorded as missing coverage. */
  async pause(reason: 'user_paused' | 'update_install' | 'offline' = 'user_paused'): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.userPaused = reason === 'user_paused';
    this.pausedAtMs = this.nowMs();

    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = null;
    }
    this.activeController?.abort();
    this.options.host.onStatusChange();
    this.options.host.log('info', `collection paused (${reason})`);
  }

  setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    if (!online) {
      this.activeController?.abort();
      void this.options.host.recordGap({
        scopeKey: null,
        startMs: this.nowMs(),
        endMs: this.nowMs() + 1,
        reason: 'offline',
        detail: 'the network went offline',
      });
    }
    this.options.host.onStatusChange();
  }

  /**
   * Records a sleep/wake transition.
   *
   * On wake we reconnect normally and DO NOT manufacture samples for the gap.
   */
  async onSuspend(): Promise<void> {
    this.pausedAtMs = this.nowMs();
    this.activeController?.abort();
  }

  async onResume(): Promise<void> {
    if (this.pausedAtMs !== null) {
      await this.options.host.recordGap({
        scopeKey: null,
        startMs: this.pausedAtMs,
        endMs: this.nowMs(),
        reason: 'computer_asleep',
      });
      this.pausedAtMs = null;
    }
    if (this.running) {
      this.scheduler.spreadOverdue(this.nowMs());
      await this.options.host.persistQueue(this.scheduler.snapshot());
      this.scheduleNextCycle(0);
    }
  }

  /**
   * Queues a manual refresh. It is planned through the same source budget as
   * scheduled work, so it cannot exceed the provider's allowed rate.
   */
  requestManualRefresh(bindingIds: readonly string[]): {
    queued: number;
    earliestStartMs: number | null;
    budgetNote: string | null;
  } {
    for (const id of bindingIds) if (this.bindings.has(id)) this.manualQueue.add(id);
    const plan = this.scheduler.plan({
      nowMs: this.nowMs(),
      manualBindingIds: [...this.manualQueue],
    });
    const earliest = plan.dispatch.length > 0 ? (plan.dispatch[0]?.earliestStartMs ?? null) : null;
    const waitMs = earliest === null ? 0 : Math.max(0, earliest - this.nowMs());
    if (this.running) this.scheduleNextCycle(0);

    return {
      queued: this.manualQueue.size,
      earliestStartMs: earliest,
      // Manual refresh shares the scheduled budget, so tell the user plainly
      // when it cannot start immediately rather than appearing to do nothing.
      budgetNote:
        waitMs > 5_000
          ? `This source allows one page load at a time, so the refresh starts in about ${Math.round(waitMs / 1000)} seconds.`
          : null,
    };
  }

  private scheduleNextCycle(delayMs: number): void {
    if (this.cycleTimer) clearTimeout(this.cycleTimer);
    this.cycleTimer = setTimeout(
      () => {
        void this.runCycle();
      },
      Math.max(0, delayMs),
    );
    this.cycleTimer.unref?.();
  }

  /**
   * Runs one collection cycle.
   *
   * Polls whether or not any window is open: the scheduler has no knowledge of
   * the UI.
   */
  private async runCycle(): Promise<void> {
    if (!this.running) return;
    if (!this.online) {
      this.scheduleNextCycle(60_000);
      return;
    }

    const cycleStartedMs = this.nowMs();
    const plan = this.scheduler.plan({
      nowMs: cycleStartedMs,
      manualBindingIds: [...this.manualQueue],
    });
    this.lastPlan = { queueLag: plan.queueLag, achievableIntervalMs: plan.achievableIntervalMs };

    if (plan.dispatch.length === 0) {
      this.options.host.onStatusChange();
      this.scheduleNextCycle(this.scheduler.nextWakeDelayMs(this.nowMs()));
      return;
    }

    // Group the dispatch by source so each adapter gets one call per cycle.
    const bySource = new Map<string, BindingDescriptor[]>();
    for (const item of plan.dispatch) {
      const binding = this.bindings.get(item.bindingId);
      if (!binding) continue;
      const list = bySource.get(item.sourceId);
      if (list) list.push(binding);
      else bySource.set(item.sourceId, [binding]);
    }

    for (const [sourceId, bindings] of bySource) {
      if (!this.running) break;
      const adapter = this.adapters.get(sourceId);
      if (!adapter) continue;
      await this.collectFromSource(sourceId, adapter, bindings, cycleStartedMs);
    }

    for (const binding of plan.dispatch) this.manualQueue.delete(binding.bindingId);
    await this.options.host.persistQueue(this.scheduler.snapshot());
    this.options.host.onStatusChange();
    this.scheduleNextCycle(this.scheduler.nextWakeDelayMs(this.nowMs()));
  }

  private async collectFromSource(
    sourceId: string,
    adapter: SourceAdapter,
    bindings: readonly BindingDescriptor[],
    cycleStartedMs: number,
  ): Promise<void> {
    const capabilities = adapter.describeCapabilities();
    const runId = randomUUID();
    const controller = new AbortController();
    this.activeController = controller;
    const budget = this.budgets.get(sourceId);

    const freshnessPolicy: FreshnessPolicy = {
      scheduledIntervalMs: Math.max(
        capabilities.minIntervalMs,
        COLLECTION_DEFAULTS.targetIntervalMs,
      ),
      maxCarryForwardCapMs: 30 * 60_000,
      sourceFreshnessLimitMs: capabilities.sourceFreshnessLimitMs,
    };

    let batch: CollectionBatch;
    try {
      batch = await adapter.collect(
        {
          attemptId: runId,
          nowMs: this.nowMs,
          freshnessPolicy,
          navigationTimeoutMs: 45_000,
          acquireNavigationSlot: async () => {
            this.scheduler.recordNavigation(sourceId, this.nowMs());
            try {
              await budget?.acquire(controller.signal);
            } finally {
              this.scheduler.releaseNavigation(sourceId);
            }
          },
          log: this.options.host.log,
        },
        bindings,
        controller.signal,
      );
    } catch (error) {
      // A browser or adapter crash becomes failed attempts, not a silent gap
      // and not a zero-usage observation.
      const detail = error instanceof Error ? error.message : String(error);
      this.options.host.log('error', `source ${sourceId} crashed during collection: ${detail}`);
      const finishedMs = this.nowMs();
      const attempts = bindings.map((binding) => ({
        bindingId: binding.bindingId,
        scopeKey: binding.scopeKey,
        startedMs: cycleStartedMs,
        finishedMs,
        // Keeps the literal from widening to `string` in the inferred object
        // type, which the readonly AttemptOutcome field will not accept.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        outcome: 'timeout' as AttemptOutcome,
        errorDetail: detail,
        navigationCount: 0,
      }));
      for (const attempt of attempts) {
        this.scheduler.recordOutcome({ bindingId: attempt.bindingId, outcome: 'timeout' });
      }
      await this.options.host.submitRun({
        runId,
        sourceId,
        adapterVersion: capabilities.adapterVersion,
        startedMs: cycleStartedMs,
        finishedMs,
        outcome: 'timeout',
        effectiveIntervalMs: this.lastPlan.achievableIntervalMs,
        cycleDurationMs: finishedMs - cycleStartedMs,
        warnings: [`the collector crashed: ${detail}`],
        attempts,
        observations: [],
      });
      await this.options.host.recordGap({
        scopeKey: null,
        startMs: cycleStartedMs,
        endMs: finishedMs,
        reason: 'browser_failure',
        detail,
      });
      this.activeController = null;
      return;
    }
    this.activeController = null;

    const observations: EnvelopedObservation[] = [];
    for (const outcome of batch.outcomes) {
      this.scheduler.recordOutcome({
        bindingId: outcome.bindingId,
        outcome: outcome.outcome,
        nowMs: outcome.finishedMs,
        retryAfterMs: batch.retryAfterMs,
      });

      if (!outcome.observation || !isSuccessfulOutcome(outcome.outcome)) continue;
      const binding = this.bindings.get(outcome.bindingId);
      if (!binding) continue;
      observations.push(this.envelope(outcome.observation, binding, capabilities, freshnessPolicy));
    }

    const runtime = this.scheduler.sourceRuntime(sourceId);
    if (runtime) {
      await this.options.host.persistSourceHealth({
        sourceId,
        state: runtime.state,
        detail: runtime.detail,
        consecutiveFailures: runtime.consecutiveFailures,
        backoffUntilMs: runtime.holdUntilMs,
        lastAttemptMs: this.nowMs(),
        lastSuccessMs:
          observations.length > 0 ? Math.max(...observations.map((o) => o.observedAtUtcMs)) : null,
        userActionRequired: runtime.userActionRequired,
      });
    }

    const succeeded = batch.outcomes.filter((o) => isSuccessfulOutcome(o.outcome)).length;
    await this.options.host.submitRun({
      runId,
      sourceId,
      adapterVersion: capabilities.adapterVersion,
      startedMs: batch.startedMs,
      finishedMs: batch.finishedMs,
      outcome:
        succeeded === batch.outcomes.length
          ? 'succeeded'
          : succeeded > 0
            ? 'partial'
            : (batch.outcomes[0]?.outcome ?? 'invalid_data'),
      effectiveIntervalMs: this.lastPlan.achievableIntervalMs,
      cycleDurationMs: batch.finishedMs - batch.startedMs,
      warnings: batch.warnings,
      attempts: batch.outcomes.map((outcome) => ({
        bindingId: outcome.bindingId,
        scopeKey: outcome.scopeKey,
        startedMs: outcome.startedMs,
        finishedMs: outcome.finishedMs,
        outcome: outcome.outcome,
        errorDetail: outcome.errorDetail,
        navigationCount: outcome.navigationCount,
      })),
      observations,
    });
  }

  /**
   * Wraps an adapter observation in its provenance envelope.
   *
   * Port rows are carried through only when the source declared durable
   * identity; otherwise they are dropped here as well as in the adapter, so
   * there is no path by which display order becomes a port identity.
   */
  private envelope(
    observation: AdapterObservation,
    binding: BindingDescriptor & { sourceId: string; siteId: string },
    capabilities: SourceCapabilities,
    freshnessPolicy: FreshnessPolicy,
  ): EnvelopedObservation {
    const identityDurable =
      capabilities.identityReliability === 'durable' && binding.identityReliability === 'durable';

    return {
      id: randomUUID(),
      bindingId: binding.bindingId,
      siteId: binding.siteId,
      scopeKey: binding.scopeKey,
      observedAtUtcMs: observation.observedAtUtcMs,
      sourceUpdatedAtUtcMs: observation.sourceUpdatedAtUtcMs,
      method: capabilities.collectionMethod,
      granularity: observation.granularity,
      counts: observation.counts,
      capacityBasis: observation.capacityBasis,
      completeness: observation.completeness,
      level: observation.level,
      distinguishesCharging: capabilities.distinguishesCharging,
      freshnessPolicy,
      sourceUrl: observation.sourceUrl,
      parserVersion: `${capabilities.sourceId}@${capabilities.adapterVersion}`,
      evidenceFingerprint: fingerprint(observation),
      sanitizedSourceText: observation.sanitizedSourceText,
      quality: observation.quality,
      sourceFreshness: observation.sourceFreshness,
      validation: {
        warnings: observation.warnings,
        capabilityVersion: capabilities.capabilityVersion,
      },
      ports: identityDurable
        ? observation.ports.map((port) => ({
            portId: `${binding.scopeKey}:${port.sourcePortId}`,
            sourcePortId: port.sourcePortId,
            state: port.state,
            level: port.level,
          }))
        : [],
    };
  }

  status(): {
    readonly running: boolean;
    readonly userPaused: boolean;
    readonly online: boolean;
    readonly queueLag: number;
    readonly effectiveIntervalMs: number | null;
    readonly nextCheckMs: number | null;
    readonly anySourceUnhealthy: boolean;
  } {
    let unhealthy = false;
    let nextCheckMs: number | null = null;
    for (const entry of this.scheduler.snapshot()) {
      if (entry.paused || entry.nextDueMs >= Number.MAX_SAFE_INTEGER) continue;
      nextCheckMs = nextCheckMs === null ? entry.nextDueMs : Math.min(nextCheckMs, entry.nextDueMs);
    }
    for (const sourceId of this.adapters.keys()) {
      const runtime = this.scheduler.sourceRuntime(sourceId);
      if (!runtime) continue;
      if (runtime.state !== 'healthy') unhealthy = true;
    }
    return {
      running: this.running,
      userPaused: this.userPaused,
      online: this.online,
      queueLag: this.lastPlan.queueLag,
      effectiveIntervalMs: this.lastPlan.achievableIntervalMs,
      nextCheckMs,
      anySourceUnhealthy: unhealthy,
    };
  }

  sourceHealth(): Array<{
    sourceId: string;
    capabilities: SourceCapabilities;
    state: string;
    detail: string | null;
    userAction: string | null;
    backoffUntilMs: number | null;
  }> {
    const out: Array<{
      sourceId: string;
      capabilities: SourceCapabilities;
      state: string;
      detail: string | null;
      userAction: string | null;
      backoffUntilMs: number | null;
    }> = [];
    for (const [sourceId, adapter] of this.adapters) {
      const runtime = this.scheduler.sourceRuntime(sourceId);
      out.push({
        sourceId,
        capabilities: adapter.describeCapabilities(),
        state: runtime?.state ?? 'unverified',
        detail: runtime?.detail ?? null,
        userAction: runtime?.userActionRequired ?? null,
        backoffUntilMs: runtime?.holdUntilMs ?? null,
      });
    }
    return out;
  }

  /**
   * Graceful stop: stop scheduling, cancel bounded browser work, close the
   * browser. The caller flushes accepted batches and closes the database.
   * Update installation uses this same path.
   */
  async stop(options: { deadlineMs?: number } = {}): Promise<{ clean: boolean }> {
    const deadlineMs = options.deadlineMs ?? 20_000;
    await this.pause('update_install');

    const closed = await Promise.race([
      (async () => {
        for (const adapter of this.adapters.values()) {
          try {
            await adapter.close();
          } catch {
            /* continue closing the rest */
          }
        }
        await this.options.runtime.close();
        return true;
      })(),
      this.sleep(deadlineMs).then(() => false),
    ]);

    if (!closed) {
      this.options.host.log(
        'warn',
        'the collector did not shut down within its deadline; an interruption has been recorded',
      );
      await this.options.host.recordGap({
        scopeKey: null,
        startMs: this.nowMs(),
        endMs: this.nowMs() + 1,
        reason: 'browser_failure',
        detail: 'shutdown deadline exceeded',
      });
    }
    return { clean: closed };
  }
}

/**
 * A stable fingerprint of the observed content.
 *
 * Used for provenance and de-duplication diagnostics only. It is deliberately
 * NOT used to discard a repeated identical status: the same status at a new
 * scheduled time is new evidence and is kept.
 */
function fingerprint(observation: AdapterObservation): string {
  const parts = [
    observation.scopeKey,
    String(observation.counts.available),
    String(observation.counts.occupied),
    String(observation.counts.reserved),
    String(observation.counts.outOfService),
    String(observation.counts.unknown),
    String(observation.counts.total),
    observation.completeness,
  ].join('|');
  // A short non-cryptographic digest is enough for a provenance label.
  let hash = 2166136261;
  for (let i = 0; i < parts.length; i += 1) {
    hash ^= parts.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16)}`;
}
