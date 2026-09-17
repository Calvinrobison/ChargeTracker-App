/**
 * Scheduler, rate limits, backoff and circuit breaker (§12).
 *
 * Run: node --experimental-strip-types --test tests/nodeps/scheduler.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  NavigationBudget,
  Scheduler,
  type QueueEntry,
  type SourceLimits,
} from '../../src/collector/scheduler.ts';
import { COLLECTION_DEFAULTS } from '../../src/domain/thresholds.ts';
import { HOUR, MIN, T0 } from './helpers.ts';

const SOURCE: SourceLimits = {
  sourceId: 'chargepoint',
  minNavigationIntervalMs: 30_000,
  minIntervalMs: 15 * MIN,
  maxConcurrentNavigations: 1,
  eligible: true,
};

function entry(bindingId: string, overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    bindingId,
    sourceId: 'chargepoint',
    nextDueMs: T0,
    intervalMs: 15 * MIN,
    lastAttemptMs: null,
    lastSuccessMs: null,
    consecutiveFailures: 0,
    backoffMs: 0,
    paused: false,
    ...overrides,
  };
}

function makeScheduler(options: { random?: number; limits?: SourceLimits } = {}) {
  let clock = T0;
  const scheduler = new Scheduler({
    nowMs: () => clock,
    monotonicMs: () => clock - T0,
    random: () => options.random ?? 0.5, // 0.5 => zero jitter
  });
  scheduler.registerSource(options.limits ?? SOURCE);
  return {
    scheduler,
    setNow: (ms: number) => {
      clock = ms;
    },
    now: () => clock,
  };
}

describe('navigation budget', () => {
  test('the minimum interval between top-level navigations is enforced', () => {
    const { scheduler } = makeScheduler();
    scheduler.load([entry('b1'), entry('b2'), entry('b3')]);

    const plan = scheduler.plan({ nowMs: T0 });
    assert.equal(plan.dispatch.length, 3);
    const starts = plan.dispatch.map((d) => d.earliestStartMs);
    assert.deepEqual(starts, [T0, T0 + 30_000, T0 + 60_000]);
  });

  test('a recent navigation delays the first slot of the next cycle', () => {
    const { scheduler } = makeScheduler();
    scheduler.load([entry('b1')]);
    scheduler.recordNavigation('chargepoint', T0);

    const plan = scheduler.plan({ nowMs: T0 + 10_000 });
    assert.equal(plan.dispatch[0]?.earliestStartMs, T0 + 30_000, 'waits out the remaining budget');
  });

  test('manual refresh spends the same budget as scheduled work', () => {
    const { scheduler } = makeScheduler();
    // Not due for another 14 minutes.
    scheduler.load([entry('b1', { nextDueMs: T0 + 14 * MIN })]);
    scheduler.recordNavigation('chargepoint', T0);

    const plan = scheduler.plan({ nowMs: T0 + 1000, manualBindingIds: ['b1'] });
    assert.equal(plan.dispatch.length, 1, 'the manual refresh is planned');
    assert.equal(
      plan.dispatch[0]?.earliestStartMs,
      T0 + 30_000,
      'but not before the navigation interval has elapsed',
    );
  });

  test('adding capacity does not speed up provider requests', () => {
    const { scheduler } = makeScheduler();
    scheduler.load(Array.from({ length: 10 }, (_, i) => entry(`b${i}`)));
    const plan = scheduler.plan({ nowMs: T0 });
    const starts = plan.dispatch.map((d) => d.earliestStartMs - T0);
    for (let i = 1; i < starts.length; i += 1) {
      assert.ok(
        (starts[i] as number) - (starts[i - 1] as number) >= 30_000,
        'every consecutive pair is at least one navigation interval apart',
      );
    }
  });

  test('the token bucket waits rather than bursting', async () => {
    let monotonic = 0;
    const slept: number[] = [];
    const budget = new NavigationBudget(
      30_000,
      () => monotonic,
      async (ms) => {
        slept.push(ms);
        monotonic += ms;
      },
    );

    await budget.acquire();
    assert.deepEqual(slept, [], 'the first navigation is immediate');
    monotonic += 5_000;
    await budget.acquire();
    assert.deepEqual(slept, [25_000], 'the second waits out the remainder');
  });

  test('an aborted wait does not consume a navigation slot', async () => {
    let monotonic = 0;
    const controller = new AbortController();
    const budget = new NavigationBudget(
      30_000,
      () => monotonic,
      async (ms) => {
        monotonic += ms;
        controller.abort();
      },
    );
    await budget.acquire();
    monotonic += 1_000;
    await assert.rejects(() => budget.acquire(controller.signal), /abort/i);
  });
});

describe('queue lag and achievable cadence', () => {
  test('a set too large for the target interval reports the achievable cadence', () => {
    const { scheduler } = makeScheduler();
    // 100 sites at 30 seconds apart needs 50 minutes, not 15.
    scheduler.load(Array.from({ length: 100 }, (_, i) => entry(`b${i}`)));

    const achievable = scheduler.achievableIntervalMs('chargepoint');
    assert.equal(achievable, 100 * 30_000, 'the real figure, not the requested 15 minutes');
    assert.ok((achievable ?? 0) > COLLECTION_DEFAULTS.targetIntervalMs);

    const plan = scheduler.plan({ nowMs: T0 });
    assert.ok(plan.queueLag > 0, 'the overflow is reported as lag');
    assert.ok(plan.dispatch.length < 100, 'the cycle is not stuffed');
    assert.ok(
      plan.dispatch.length >= 30,
      'and it is not quietly dropping most of the work either',
    );
    assert.equal(plan.achievableIntervalMs, achievable);
  });

  test('100 simultaneous pages are never opened', () => {
    const { scheduler } = makeScheduler();
    scheduler.load(Array.from({ length: 100 }, (_, i) => entry(`b${i}`)));
    const plan = scheduler.plan({ nowMs: T0 });
    const sameInstant = plan.dispatch.filter((d) => d.earliestStartMs === T0);
    assert.equal(sameInstant.length, 1, 'one navigation may start at any instant');
  });
});

describe('restart and sleep behaviour', () => {
  test('overdue work is spread instead of firing a catch-up storm', () => {
    const { scheduler } = makeScheduler();
    // Everything became overdue during a three-hour sleep.
    scheduler.load(
      Array.from({ length: 20 }, (_, i) => entry(`b${i}`, { nextDueMs: T0 - 3 * HOUR })),
    );

    const result = scheduler.spreadOverdue(T0);
    assert.equal(result.restaged, 20);

    const dueTimes = scheduler.snapshot().map((e) => e.nextDueMs - T0).sort((a, b) => a - b);
    assert.deepEqual(dueTimes.slice(0, 3), [0, 30_000, 60_000]);
    assert.equal(result.horizonMs - T0, 19 * 30_000);

    const immediately = scheduler.plan({ nowMs: T0 }).dispatch;
    assert.equal(immediately.length, 1, 'only one item is due right now');
  });

  test('the least fresh site is restaged soonest', () => {
    const { scheduler } = makeScheduler();
    scheduler.load([
      entry('recent', { nextDueMs: T0 - HOUR, lastSuccessMs: T0 - 20 * MIN }),
      entry('stale', { nextDueMs: T0 - HOUR, lastSuccessMs: T0 - 5 * HOUR }),
    ]);
    scheduler.spreadOverdue(T0);
    const snapshot = new Map(scheduler.snapshot().map((e) => [e.bindingId, e.nextDueMs]));
    assert.ok((snapshot.get('stale') as number) < (snapshot.get('recent') as number));
  });

  test('the wake delay is bounded and never negative', () => {
    const { scheduler } = makeScheduler();
    scheduler.load([entry('b1', { nextDueMs: T0 - 10 * HOUR })]);
    const delay = scheduler.nextWakeDelayMs(T0);
    assert.ok(delay >= 1000 && delay <= COLLECTION_DEFAULTS.maxBackoffMs);
  });
});

describe('failure handling', () => {
  test('a transient failure backs off exponentially and is capped at six hours', () => {
    const { scheduler } = makeScheduler();
    scheduler.load([entry('b1')]);

    const delays: number[] = [];
    for (let i = 0; i < 14; i += 1) {
      const result = scheduler.recordOutcome({
        bindingId: 'b1',
        outcome: 'timeout',
        nowMs: T0 + i * HOUR,
      });
      delays.push(result.nextDueMs - (T0 + i * HOUR));
    }

    assert.ok((delays[0] as number) >= 15 * MIN);
    assert.ok((delays[1] as number) > (delays[0] as number), 'it grows');
    for (const delay of delays) {
      assert.ok(delay <= COLLECTION_DEFAULTS.maxBackoffMs, `${delay} exceeds the six-hour cap`);
    }
    assert.equal(delays[delays.length - 1], COLLECTION_DEFAULTS.maxBackoffMs);
  });

  test('jitter varies the backoff without exceeding the cap', () => {
    const low = makeScheduler({ random: 0 });
    const high = makeScheduler({ random: 1 });
    low.scheduler.load([entry('b1', { consecutiveFailures: 2 })]);
    high.scheduler.load([entry('b1', { consecutiveFailures: 2 })]);

    const a = low.scheduler.recordOutcome({ bindingId: 'b1', outcome: 'timeout', nowMs: T0 });
    const b = high.scheduler.recordOutcome({ bindingId: 'b1', outcome: 'timeout', nowMs: T0 });
    assert.notEqual(a.nextDueMs, b.nextDueMs);
    assert.ok(a.nextDueMs - T0 <= COLLECTION_DEFAULTS.maxBackoffMs);
    assert.ok(b.nextDueMs - T0 <= COLLECTION_DEFAULTS.maxBackoffMs);
  });

  test('Retry-After is respected and never shortened', () => {
    const { scheduler } = makeScheduler();
    scheduler.load([entry('b1')]);
    const result = scheduler.recordOutcome({
      bindingId: 'b1',
      outcome: 'rate_limited',
      nowMs: T0,
      retryAfterMs: 2 * HOUR,
    });
    assert.ok(result.nextDueMs - T0 >= 2 * HOUR);
    assert.ok((scheduler.sourceRuntime('chargepoint')?.holdUntilMs ?? 0) >= T0 + 2 * HOUR);
  });

  test('a sign-in wall pauses the source instead of retrying forever', () => {
    const { scheduler } = makeScheduler();
    scheduler.load([entry('b1')]);
    const result = scheduler.recordOutcome({
      bindingId: 'b1',
      outcome: 'login_required',
      nowMs: T0,
    });
    assert.equal(result.sourceState, 'paused');
    const runtime = scheduler.sourceRuntime('chargepoint');
    assert.match(runtime?.detail ?? '', /requires signing in/);
    assert.ok(runtime?.userActionRequired);

    const plan = scheduler.plan({ nowMs: T0 + HOUR });
    assert.equal(plan.dispatch.length, 0);
    assert.equal(plan.skipped.find((s) => s.bindingId === 'b1')?.reason, 'source_paused');
  });

  test('an explicit access block pauses the source with a plain-language action', () => {
    const { scheduler } = makeScheduler();
    scheduler.load([entry('b1')]);
    const result = scheduler.recordOutcome({
      bindingId: 'b1',
      outcome: 'source_blocked',
      nowMs: T0,
    });
    assert.equal(result.sourceState, 'blocked');
    assert.match(scheduler.sourceRuntime('chargepoint')?.detail ?? '', /refused automated access/);
    assert.equal(scheduler.plan({ nowMs: T0 + 12 * HOUR }).dispatch.length, 0);
  });

  test('a layout change pauses collection and asks for a parser fix', () => {
    const { scheduler } = makeScheduler();
    scheduler.load([entry('b1')]);
    const result = scheduler.recordOutcome({
      bindingId: 'b1',
      outcome: 'layout_changed',
      nowMs: T0,
    });
    assert.equal(result.sourceState, 'paused');
    assert.match(scheduler.sourceRuntime('chargepoint')?.detail ?? '', /page changed/);
  });

  test('the circuit breaker opens after repeated failures and closes after a success', () => {
    const { scheduler } = makeScheduler();
    scheduler.load([entry('b1')]);

    for (let i = 0; i < COLLECTION_DEFAULTS.circuitBreakerFailureThreshold; i += 1) {
      scheduler.recordOutcome({ bindingId: 'b1', outcome: 'timeout', nowMs: T0 + i * MIN });
    }
    assert.equal(scheduler.sourceRuntime('chargepoint')?.state, 'circuit_open');
    assert.equal(scheduler.plan({ nowMs: T0 + 6 * MIN }).dispatch.length, 0);

    // After the hold expires one probe is allowed.
    const holdUntil = scheduler.sourceRuntime('chargepoint')?.holdUntilMs ?? T0;
    scheduler.upsert(entry('b1', { nextDueMs: holdUntil }));
    const probe = scheduler.plan({ nowMs: holdUntil + 1000 });
    assert.equal(probe.dispatch.length, 1, 'one probe after the hold');

    scheduler.recordOutcome({ bindingId: 'b1', outcome: 'succeeded', nowMs: holdUntil + 2000 });
    assert.equal(scheduler.sourceRuntime('chargepoint')?.state, 'healthy');
  });

  test('a cancelled attempt is not counted as a failure', () => {
    const { scheduler } = makeScheduler();
    scheduler.load([entry('b1')]);
    scheduler.recordOutcome({ bindingId: 'b1', outcome: 'cancelled', nowMs: T0 });
    assert.equal(scheduler.snapshot()[0]?.consecutiveFailures, 0);
    assert.equal(scheduler.sourceRuntime('chargepoint')?.state, 'healthy');
  });

  test('a success reschedules at the configured interval with jitter', () => {
    const { scheduler } = makeScheduler();
    scheduler.load([entry('b1', { consecutiveFailures: 3, backoffMs: 9999 })]);
    const result = scheduler.recordOutcome({ bindingId: 'b1', outcome: 'succeeded', nowMs: T0 });
    assert.equal(result.nextDueMs, T0 + 15 * MIN, 'zero jitter with random()=0.5');
    const snapshot = scheduler.snapshot()[0];
    assert.equal(snapshot?.consecutiveFailures, 0);
    assert.equal(snapshot?.backoffMs, 0);
  });
});

describe('eligibility gating', () => {
  test('an ineligible source is never collected from', () => {
    const { scheduler } = makeScheduler({
      limits: { ...SOURCE, eligible: false },
    });
    scheduler.load([entry('b1')]);
    const plan = scheduler.plan({ nowMs: T0 });
    assert.equal(plan.dispatch.length, 0);
    assert.equal(
      plan.skipped.find((s) => s.bindingId === 'b1')?.reason,
      'source_not_eligible',
    );
  });

  test('a paused binding is skipped but a resume restores it', () => {
    const { scheduler } = makeScheduler();
    scheduler.load([entry('b1', { paused: true })]);
    assert.equal(scheduler.plan({ nowMs: T0 }).dispatch.length, 0);
    scheduler.setPaused('b1', false);
    assert.equal(scheduler.plan({ nowMs: T0 }).dispatch.length, 1);
  });

  test('a user pause of a whole source persists until resumed', () => {
    const { scheduler } = makeScheduler();
    scheduler.load([entry('b1')]);
    scheduler.setSourcePaused('chargepoint', true, 'Paused by you');
    assert.equal(scheduler.plan({ nowMs: T0 + HOUR }).dispatch.length, 0);
    scheduler.setSourcePaused('chargepoint', false);
    assert.equal(scheduler.plan({ nowMs: T0 + HOUR }).dispatch.length, 1);
  });
});
