/**
 * The collector service end to end, with a fake adapter and a fake host.
 *
 * The scheduler has its own specs. What was never covered is the service's
 * timer around it — and the first live run on 2026-09-21 found the gap: with
 * collection started on an empty queue, switching 674 locations on loaded
 * their due-now entries into the scheduler but never re-armed the cycle
 * timer, which had been parked a full target interval away by the idle
 * cycle before. Nothing was read until that timer fired. These specs drive
 * the service with a controllable clock and assert what a user sees: a
 * location switched on while collecting is read now, and its observation
 * reaches the host.
 *
 * Run: node --experimental-strip-types --test tests/nodeps/collector-service.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { BrowserRuntime } from '../../src/collector/browser.ts';
import type {
  BindingDescriptor,
  CollectContext,
  CollectionBatch,
  SourceAdapter,
  SourceCapabilities,
} from '../../src/collector/contract.ts';
import { CollectorService, type RunReport } from '../../src/collector/service.ts';
import { CAPABILITIES } from '../../src/collector/adapters/chargepoint/index.ts';
import { T0 } from './helpers.ts';

/** Runs every pending timer whose delay has elapsed, in order. */
function fakeTimers() {
  let now = T0;
  const pending: Array<{ at: number; fn: () => void }> = [];
  const realSetTimeout = globalThis.setTimeout;
  const install = () => {
    // The receiver is typed `unknown`, so no assertion is needed on the value.
    (globalThis as { setTimeout: unknown }).setTimeout = (fn: () => void, ms: number) => {
      const timer = { at: now + Math.max(0, ms), fn };
      pending.push(timer);
      return { unref() {}, ref() {}, [Symbol.toPrimitive]: () => 0 };
    };
  };
  const restore = () => {
    globalThis.setTimeout = realSetTimeout;
  };
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      pending.sort((a, b) => a.at - b.at);
      const next = pending[0];
      if (!next || next.at > target) break;
      pending.shift();
      now = next.at;
      next.fn();
      // Let promise chains behind the timer settle.
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    }
    now = target;
  };
  return {
    install,
    restore,
    advance,
    nowMs: () => now,
    pendingDelays: () => pending.map((p) => p.at - now),
  };
}

function binding(id: string): BindingDescriptor & { sourceId: string; siteId: string } {
  return {
    bindingId: id,
    siteId: `site-${id}`,
    sourceId: 'chargepoint',
    scopeKey: `chargepoint:${id}`,
    sourceStationId: id,
    canonicalUrl: `https://driver.chargepoint.com/stations/${id}`,
    physicalScope: 'whole station',
    granularity: 'port',
    identityReliability: 'durable',
    catalogPortCount: 2,
    expectedLevel: 'level_2',
  };
}

function fakeAdapter(capabilities: SourceCapabilities, nowMs: () => number) {
  const collected: string[] = [];
  const adapter: SourceAdapter = {
    describeCapabilities: () => capabilities,
    async validateBinding() {
      return { ok: true, code: 'ok' };
    },
    async collect(_context: CollectContext, bindings, _signal): Promise<CollectionBatch> {
      const started = nowMs();
      const outcomes = bindings.map((b) => {
        collected.push(b.bindingId);
        return {
          bindingId: b.bindingId,
          scopeKey: b.scopeKey,
          outcome: 'succeeded' as const,
          startedMs: started,
          finishedMs: nowMs(),
          navigationCount: 1,
          errorDetail: null,
          observation: {
            bindingId: b.bindingId,
            scopeKey: b.scopeKey,
            sourceStationId: b.sourceStationId,
            observedAtUtcMs: nowMs(),
            sourceUpdatedAtUtcMs: null,
            granularity: 'port' as const,
            counts: {
              available: 1,
              occupied: 1,
              reserved: 0,
              outOfService: 0,
              unknown: 0,
              total: 2,
            },
            capacityBasis: 'ports_simultaneous' as const,
            completeness: 'complete' as const,
            level: 'level_2' as const,
            ports: [
              { sourcePortId: '1', state: 'available' as const, level: 'level_2' as const },
              { sourcePortId: '2', state: 'occupied' as const, level: 'level_2' as const },
            ],
            sanitizedSourceText: 'fake',
            sourceUrl: b.canonicalUrl,
            quality: 'reliable' as const,
            sourceFreshness: 'unknown_source_clock' as const,
            warnings: [],
          },
        };
      });
      return {
        sourceId: capabilities.sourceId,
        adapterVersion: capabilities.adapterVersion,
        attemptId: 'attempt',
        startedMs: started,
        finishedMs: nowMs(),
        outcomes,
        warnings: [],
        retryAfterMs: null,
      };
    },
    async close() {},
  };
  return { adapter, collected };
}

function makeService(clock: ReturnType<typeof fakeTimers>) {
  const runs: RunReport[] = [];
  const log: string[] = [];
  const service = new CollectorService({
    runtime: { close: async () => undefined } as unknown as BrowserRuntime,
    nowMs: clock.nowMs,
    monotonicMs: clock.nowMs,
    random: () => 0.5,
    sleep: async () => undefined,
    host: {
      async submitRun(report) {
        runs.push(report);
      },
      async recordGap() {},
      async persistQueue() {},
      async persistSourceHealth() {},
      onStatusChange() {},
      log: (level, message) => log.push(`${level}: ${message}`),
    },
  });
  const { adapter, collected } = fakeAdapter(CAPABILITIES, clock.nowMs);
  service.registerAdapter(adapter);
  return { service, runs, log, collected };
}

describe('a location switched on while collecting is read now', () => {
  test('load() re-arms the cycle instead of waiting out the idle timer', async () => {
    const clock = fakeTimers();
    clock.install();
    try {
      const { service, runs, collected } = makeService(clock);

      // "Start collecting" with nothing monitored: the idle cycle parks the
      // timer a full target interval away.
      service.load({ queue: [], bindings: [] });
      await service.start();
      await clock.advance(10);
      assert.equal(runs.length, 0);
      assert.ok(
        clock.pendingDelays().some((d) => d >= 14 * 60_000),
        'the idle cycle parks the next wake a target interval away',
      );

      // "Monitor this location": one due-now entry arrives.
      const b = binding('11502161');
      service.load({
        queue: [
          {
            bindingId: b.bindingId,
            sourceId: 'chargepoint',
            nextDueMs: clock.nowMs(),
            intervalMs: 15 * 60_000,
            lastAttemptMs: null,
            lastSuccessMs: null,
            consecutiveFailures: 0,
            backoffMs: 0,
            paused: false,
          },
        ],
        bindings: [b],
      });

      // Within seconds — not fifteen minutes — the read happens and the
      // observation reaches the host.
      await clock.advance(5_000);
      assert.deepEqual(collected, ['11502161'], 'the binding was read');
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.outcome, 'succeeded');
      assert.equal(runs[0]?.observations.length, 1);
      assert.equal(runs[0]?.observations[0]?.counts.occupied, 1);
      assert.equal(runs[0]?.observations[0]?.ports.length, 2, 'durable ports carried through');
    } finally {
      clock.restore();
    }
  });

  test('load() while paused does not start reading', async () => {
    const clock = fakeTimers();
    clock.install();
    try {
      const { service, runs } = makeService(clock);
      const b = binding('1');
      service.load({
        queue: [
          {
            bindingId: b.bindingId,
            sourceId: 'chargepoint',
            nextDueMs: clock.nowMs(),
            intervalMs: 15 * 60_000,
            lastAttemptMs: null,
            lastSuccessMs: null,
            consecutiveFailures: 0,
            backoffMs: 0,
            paused: false,
          },
        ],
        bindings: [b],
      });
      await clock.advance(60_000);
      assert.equal(runs.length, 0, 'nothing is read until the user starts collection');
    } finally {
      clock.restore();
    }
  });

  test('many locations switched on at once are spread, not read in a burst', async () => {
    const clock = fakeTimers();
    clock.install();
    try {
      const { service, collected } = makeService(clock);
      await service.start();
      const bindings = Array.from({ length: 6 }, (_, i) => binding(String(100 + i)));
      service.load({
        queue: bindings.map((b) => ({
          bindingId: b.bindingId,
          sourceId: 'chargepoint',
          nextDueMs: clock.nowMs(),
          intervalMs: 15 * 60_000,
          lastAttemptMs: null,
          lastSuccessMs: null,
          consecutiveFailures: 0,
          backoffMs: 0,
          paused: false,
        })),
        bindings,
      });
      await clock.advance(1_000);
      assert.ok(collected.length >= 1, 'the first is read immediately');
      assert.ok(collected.length < 6, 'the rest wait for their spread slots');
      await clock.advance(6 * 30_000);
      assert.equal(new Set(collected).size, 6, 'all six are read within six slots');
    } finally {
      clock.restore();
    }
  });
});
