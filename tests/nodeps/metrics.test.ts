/**
 * Acceptance tests for the metric contract in docs/METRICS.md, including every
 * worked example from section 15 of the implementation prompt.
 *
 * Run: node --experimental-strip-types --test tests/nodeps/metrics.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildScopeIntervals, classifySourceFreshness } from '../../src/domain/intervals.ts';
import {
  aggregateScopeMetrics,
  computeHeatmap,
  computeScopeMetrics,
} from '../../src/domain/metrics.ts';
import { reconcileCounts } from '../../src/domain/reconcile.ts';
import { DEFAULT_FRESHNESS_POLICY, carryForwardBudgetMs } from '../../src/domain/types.ts';
import { DAY, HOUR, MIN, T0, capacity, gap, monitoring, round, snapshot } from './helpers.ts';

function metricsFor(input: Parameters<typeof buildScopeIntervals>[0]) {
  return computeScopeMetrics(buildScopeIntervals(input));
}

describe('section 15 calculation acceptance examples', () => {
  test('A) two ports, one occupied and one available for a valid 15-minute interval', () => {
    const m = metricsFor({
      scopeKey: 'scope-1',
      window: { startMs: T0, endMs: T0 + 15 * MIN },
      snapshots: [snapshot({ observedAtUtcMs: T0, available: 1, occupied: 1 })],
      monitoringWindows: [monitoring(T0 - DAY)],
      gaps: [],
      capacity: [capacity(2)],
    });

    assert.equal(m.occupiedPortMinutes, 15, '15 occupied port-minutes');
    assert.equal(m.observedOperationalPortMinutes, 30, '30 operational port-minutes');
    assert.equal(m.observedOccupancyPct, 50, '50% observed occupancy');
    assert.equal(m.estimatedOccupiedPortHours, 0.25, '0.25 estimated occupied port-hours');
    assert.equal(m.statusCoveragePct, 100);
    assert.equal(m.operationalObservationCoveragePct, 100);
  });

  test('B) eight of ten ports out of service: occupancy 50%, known coverage 100%, operational coverage 20%', () => {
    const m = metricsFor({
      scopeKey: 'scope-1',
      window: { startMs: T0, endMs: T0 + 15 * MIN },
      snapshots: [
        snapshot({ observedAtUtcMs: T0, available: 1, occupied: 1, outOfService: 8 }),
      ],
      monitoringWindows: [monitoring(T0 - DAY)],
      gaps: [],
      capacity: [capacity(10)],
    });

    assert.equal(m.observedOccupancyPct, 50, 'occupancy among observed operational ports');
    assert.equal(m.statusCoveragePct, 100, 'every installed port had a known state');
    assert.equal(m.operationalObservationCoveragePct, 20, 'only 2 of 10 ports were operational');
    assert.equal(m.outOfServicePortMinutes, 120);
    assert.equal(round(m.offlineShareOfInstalledPct), 80);
    assert.equal(round(m.offlineShareOfKnownPct), 80);
    // The outage must be visible; 50% must never be read as five of ten ports busy.
    assert.equal(m.occupiedPortMinutes, 15);
    assert.notEqual(m.occupiedPortMinutes, 75);
  });

  test('C) a failed read is not zero occupied, and a missing hour stays missing', () => {
    // One good observation, then nothing for the rest of a three-hour window.
    const set = buildScopeIntervals({
      scopeKey: 'scope-1',
      window: { startMs: T0, endMs: T0 + 3 * HOUR },
      snapshots: [snapshot({ observedAtUtcMs: T0, available: 0, occupied: 2 })],
      monitoringWindows: [monitoring(T0 - DAY)],
      gaps: [],
      capacity: [capacity(2)],
    });
    const m = computeScopeMetrics(set);

    // Carry-forward is capped at 30 minutes, not stretched across the window.
    assert.equal(set.intervals.length, 1);
    assert.equal(set.intervals[0]?.minutes, 30);
    assert.equal(m.observedOccupancyPct, 100, 'observed time was fully occupied');
    assert.equal(m.occupiedPortMinutes, 60);
    // The unobserved remainder is unobserved, not zero-occupancy time.
    assert.equal(m.expectedInstalledPortMinutes, 2 * 180);
    assert.equal(m.unobservedPortMinutes, 360 - 60);
    assert.equal(round(m.operationalObservationCoveragePct), round((100 * 60) / 360));
    assert.ok((m.unknownShareOfInstalledPct ?? 0) > 0, 'unknown share is reported, not hidden');
  });

  test('C2) a recorded collection gap is never bridged', () => {
    const set = buildScopeIntervals({
      scopeKey: 'scope-1',
      window: { startMs: T0, endMs: T0 + 2 * HOUR },
      snapshots: [
        snapshot({ observedAtUtcMs: T0, available: 1, occupied: 1 }),
        // Next reading only arrives after a 90-minute sleep gap.
        snapshot({ observedAtUtcMs: T0 + 100 * MIN, available: 1, occupied: 1 }),
      ],
      monitoringWindows: [monitoring(T0 - DAY)],
      gaps: [gap(T0 + 10 * MIN, T0 + 100 * MIN, 'computer_asleep')],
      capacity: [capacity(2)],
    });

    assert.equal(set.intervals.length, 2);
    // The first interval is truncated at the start of the gap, not carried across it.
    assert.equal(set.intervals[0]?.span.endMs, T0 + 10 * MIN);
    assert.equal(set.intervals[0]?.minutes, 10);
    assert.equal(set.gapMinutes, 90);
    assert.equal(set.monitoredMinutes, 120 - 90);
  });

  test('D) normalized occupancy and total occupied hours can have different leaders', () => {
    const base = {
      monitoringWindows: [monitoring(T0 - DAY)],
      gaps: [],
      window: { startMs: T0, endMs: T0 + 75 * MIN },
    };
    // Site A: 2 ports, occupied in four of five 15-minute intervals -> 80%.
    const a = metricsFor({
      ...base,
      scopeKey: 'scope-1',
      snapshots: [0, 1, 2, 3, 4].map((i) =>
        snapshot({
          observedAtUtcMs: T0 + i * 15 * MIN,
          available: i === 4 ? 2 : 0,
          occupied: i === 4 ? 0 : 2,
        }),
      ),
      capacity: [capacity(2)],
    });
    // Site B: 20 ports, 8 occupied throughout -> 40%.
    const b = metricsFor({
      ...base,
      scopeKey: 'scope-1',
      snapshots: [0, 1, 2, 3, 4].map((i) =>
        snapshot({ observedAtUtcMs: T0 + i * 15 * MIN, available: 12, occupied: 8 }),
      ),
      capacity: [capacity(20)],
    });

    assert.equal(a.observedOccupancyPct, 80);
    assert.equal(b.observedOccupancyPct, 40);
    assert.equal(a.estimatedOccupiedPortHours, 2);
    assert.equal(b.estimatedOccupiedPortHours, 10);
    assert.ok(
      (a.observedOccupancyPct ?? 0) > (b.observedOccupancyPct ?? 0) &&
        a.estimatedOccupiedPortHours < b.estimatedOccupiedPortHours,
      'the two rankings must be able to disagree, so both are displayed',
    );
  });

  test('E) an identical status observed four times is four observations, not four charges', () => {
    const set = buildScopeIntervals({
      scopeKey: 'scope-1',
      window: { startMs: T0, endMs: T0 + 60 * MIN },
      snapshots: [0, 1, 2, 3].map((i) =>
        snapshot({ observedAtUtcMs: T0 + i * 15 * MIN, available: 1, occupied: 1 }),
      ),
      monitoringWindows: [monitoring(T0 - DAY)],
      gaps: [],
      capacity: [capacity(2)],
    });
    const m = computeScopeMetrics(set);

    assert.equal(m.observationCount, 4, 'four distinct observations are retained');
    assert.equal(m.occupiedPortMinutes, 60);
    assert.equal(m.observedOccupancyPct, 50);
  });
});

describe('time handling', () => {
  test('intervals are half-open, so back-to-back observations never double count', () => {
    const set = buildScopeIntervals({
      scopeKey: 'scope-1',
      window: { startMs: T0, endMs: T0 + 30 * MIN },
      snapshots: [
        snapshot({ observedAtUtcMs: T0, available: 2, occupied: 0 }),
        snapshot({ observedAtUtcMs: T0 + 15 * MIN, available: 0, occupied: 2 }),
      ],
      monitoringWindows: [monitoring(T0 - DAY)],
      gaps: [],
      capacity: [capacity(2)],
    });
    assert.equal(set.intervals[0]?.span.endMs, set.intervals[1]?.span.startMs);
    assert.equal(set.observedMinutes, 30, 'no overlap and no lost minute');
    const m = computeScopeMetrics(set);
    assert.equal(m.observedOccupancyPct, 50);
  });

  test('carry-forward is the minimum of two intervals, the 30-minute cap and the source limit', () => {
    assert.equal(carryForwardBudgetMs(DEFAULT_FRESHNESS_POLICY), 30 * MIN);
    assert.equal(
      carryForwardBudgetMs({ ...DEFAULT_FRESHNESS_POLICY, scheduledIntervalMs: 5 * MIN }),
      10 * MIN,
      'two five-minute intervals beat the cap',
    );
    assert.equal(
      carryForwardBudgetMs({
        ...DEFAULT_FRESHNESS_POLICY,
        sourceFreshnessLimitMs: 4 * MIN,
      }),
      4 * MIN,
      'a stricter provider freshness rule wins',
    );
  });

  test('the policy persisted with an observation governs it, not the current setting', () => {
    const strict = { ...DEFAULT_FRESHNESS_POLICY, scheduledIntervalMs: 2 * MIN };
    const set = buildScopeIntervals({
      scopeKey: 'scope-1',
      window: { startMs: T0, endMs: T0 + HOUR },
      snapshots: [
        snapshot({ observedAtUtcMs: T0, available: 1, occupied: 1, freshnessPolicy: strict }),
      ],
      monitoringWindows: [monitoring(T0 - DAY)],
      gaps: [],
      capacity: [capacity(2)],
    });
    assert.equal(set.intervals[0]?.minutes, 4, 'historical assumptions are not rewritten');
  });

  test('the last observation before the window is included but clipped to it', () => {
    const windowStart = T0 + HOUR;
    const set = buildScopeIntervals({
      scopeKey: 'scope-1',
      window: { startMs: windowStart, endMs: windowStart + HOUR },
      snapshots: [
        // 10 minutes before the window; 30-minute budget reaches 20 minutes in.
        snapshot({ observedAtUtcMs: windowStart - 10 * MIN, available: 0, occupied: 2 }),
      ],
      monitoringWindows: [monitoring(T0 - DAY)],
      gaps: [],
      capacity: [capacity(2)],
    });
    assert.equal(set.intervals.length, 1);
    assert.equal(set.intervals[0]?.span.startMs, windowStart, 'clipped to the window start');
    assert.equal(set.intervals[0]?.minutes, 20, 'and to the freshness bound');
  });

  test('an observation whose budget expired before the window contributes nothing', () => {
    const windowStart = T0 + 2 * HOUR;
    const set = buildScopeIntervals({
      scopeKey: 'scope-1',
      window: { startMs: windowStart, endMs: windowStart + HOUR },
      snapshots: [snapshot({ observedAtUtcMs: windowStart - 2 * HOUR, available: 0, occupied: 2 })],
      monitoringWindows: [monitoring(T0 - DAY)],
      gaps: [],
      capacity: [capacity(2)],
    });
    assert.equal(set.intervals.length, 0);
    assert.equal(set.excluded[0]?.reason, 'budget_expired_before_window');
    assert.equal(computeScopeMetrics(set).observedOccupancyPct, null, 'no denominator, no claim');
  });

  test('a capacity change truncates carry-forward', () => {
    const changeAt = T0 + 10 * MIN;
    const set = buildScopeIntervals({
      scopeKey: 'scope-1',
      window: { startMs: T0, endMs: T0 + HOUR },
      snapshots: [snapshot({ observedAtUtcMs: T0, available: 1, occupied: 1 })],
      monitoringWindows: [monitoring(T0 - DAY)],
      gaps: [],
      capacity: [capacity(2, 0, changeAt), capacity(4, changeAt)],
    });
    assert.equal(set.intervals[0]?.span.endMs, changeAt);
  });

  test("today's capacity is not applied retroactively", () => {
    const changeAt = T0 + 30 * MIN;
    const set = buildScopeIntervals({
      scopeKey: 'scope-1',
      window: { startMs: T0, endMs: T0 + 60 * MIN },
      snapshots: [],
      monitoringWindows: [monitoring(T0 - DAY)],
      gaps: [],
      capacity: [capacity(2, 0, changeAt), capacity(10, changeAt)],
    });
    // 30 minutes at 2 ports plus 30 minutes at 10 ports.
    assert.equal(set.expectedInstalledPortMinutes, 2 * 30 + 10 * 30);
  });

  test('unknown capacity yields a null coverage instead of a confident number', () => {
    const m = metricsFor({
      scopeKey: 'scope-1',
      window: { startMs: T0, endMs: T0 + 15 * MIN },
      snapshots: [snapshot({ observedAtUtcMs: T0, available: 1, occupied: 1 })],
      monitoringWindows: [monitoring(T0 - DAY)],
      gaps: [],
      capacity: [],
    });
    assert.equal(m.expectedInstalledPortMinutes, null);
    assert.equal(m.statusCoveragePct, null);
    assert.equal(m.operationalObservationCoveragePct, null);
    assert.equal(m.capacityKnown, false);
    assert.equal(m.observedOccupancyPct, 50, 'scope-level occupancy is still supportable');
  });

  test('machine timezone cannot change the result', () => {
    const build = () =>
      computeHeatmap([
        buildScopeIntervals({
          scopeKey: 'scope-1',
          window: { startMs: T0, endMs: T0 + DAY },
          snapshots: [0, 1, 2, 3].map((i) =>
            snapshot({ observedAtUtcMs: T0 + i * 6 * HOUR, available: 1, occupied: 1 }),
          ),
          monitoringWindows: [monitoring(T0 - DAY)],
          gaps: [],
          capacity: [capacity(2)],
        }),
      ]);

    const original = process.env.TZ;
    process.env.TZ = 'UTC';
    const inUtc = build();
    process.env.TZ = 'Pacific/Kiritimati';
    const inKiritimati = build();
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;

    assert.deepEqual(
      inUtc.bins.map((b) => [b.weekday, b.hour, round(b.occupiedPortMinutes)]),
      inKiritimati.bins.map((b) => [b.weekday, b.hour, round(b.occupiedPortMinutes)]),
    );
  });
});

describe('freshness', () => {
  test('an absent source timestamp means unknown sensor freshness, not fresh data', () => {
    const s = snapshot({ sourceUpdatedAtUtcMs: null });
    assert.equal(classifySourceFreshness(s), 'unknown_source_clock');
  });

  test('a source timestamp beyond the provider limit makes a fresh read stale', () => {
    const policy = { ...DEFAULT_FRESHNESS_POLICY, sourceFreshnessLimitMs: 10 * MIN };
    const stale = snapshot({
      observedAtUtcMs: T0,
      sourceUpdatedAtUtcMs: T0 - 20 * MIN,
      freshnessPolicy: policy,
    });
    const fresh = snapshot({
      observedAtUtcMs: T0,
      sourceUpdatedAtUtcMs: T0 - 2 * MIN,
      freshnessPolicy: policy,
    });
    assert.equal(classifySourceFreshness(stale), 'stale');
    assert.equal(classifySourceFreshness(fresh), 'fresh');
  });

  test('stale readings are excluded from time-weighted metrics by default', () => {
    const policy = { ...DEFAULT_FRESHNESS_POLICY, sourceFreshnessLimitMs: 5 * MIN };
    const input = {
      scopeKey: 'scope-1',
      window: { startMs: T0, endMs: T0 + 15 * MIN },
      snapshots: [
        snapshot({
          observedAtUtcMs: T0,
          sourceUpdatedAtUtcMs: T0 - HOUR,
          available: 0,
          occupied: 2,
          freshnessPolicy: policy,
        }),
      ],
      monitoringWindows: [monitoring(T0 - DAY)],
      gaps: [],
      capacity: [capacity(2)],
    } as const;

    const excludedSet = buildScopeIntervals(input);
    assert.equal(excludedSet.intervals.length, 0);
    assert.equal(excludedSet.excluded[0]?.reason, 'source_stale');
    assert.equal(
      excludedSet.latestObservationMs,
      T0,
      'the reading is still a fact about the source',
    );

    const includedSet = buildScopeIntervals({
      ...input,
      options: { includeStaleSourceReadings: true },
    });
    assert.equal(includedSet.intervals.length, 1);
  });
});

describe('count reconciliation', () => {
  test('occupied is never inferred as total minus available', () => {
    const result = reconcileCounts({
      available: 2,
      occupied: null,
      reserved: null,
      outOfService: null,
      unknown: null,
      total: 10,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.occupied, null, 'the remainder is not occupancy');
    assert.equal(result.value.unknown, 8, 'the remainder is unknown');
    assert.equal(result.value.supportsOccupancy, false);
    assert.equal(result.value.hasResidualUnknown, true);
  });

  test('explicit mutually exclusive counts are reconciled against the total', () => {
    const result = reconcileCounts({
      available: 1,
      occupied: 2,
      reserved: 1,
      outOfService: 1,
      unknown: null,
      total: 5,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.knownStateCount, 5);
    assert.equal(result.value.unknown, 0);
    assert.equal(result.value.operationalCount, 3);
  });

  test('impossible combinations are rejected rather than clamped', () => {
    const tooMany = reconcileCounts({
      available: 6,
      occupied: 6,
      reserved: null,
      outOfService: null,
      unknown: null,
      total: 10,
    });
    assert.equal(tooMany.ok, false);
    if (tooMany.ok) return;
    assert.equal(tooMany.code, 'explicit_exceeds_total');

    for (const bad of [-1, 1.5]) {
      const r = reconcileCounts({
        available: bad,
        occupied: 0,
        reserved: null,
        outOfService: null,
        unknown: null,
        total: null,
      });
      assert.equal(r.ok, false, `available=${bad} must be rejected`);
    }
  });

  test('zero and null are never interchangeable', () => {
    const zero = reconcileCounts({
      available: 0,
      occupied: 0,
      reserved: null,
      outOfService: null,
      unknown: null,
      total: null,
    });
    assert.equal(zero.ok, true);
    if (!zero.ok) return;
    assert.equal(zero.value.supportsOccupancy, true, 'an explicit zero is data');

    const nothing = reconcileCounts({
      available: null,
      occupied: null,
      reserved: null,
      outOfService: null,
      unknown: null,
      total: null,
    });
    assert.equal(nothing.ok, false);
  });
});

describe('aggregation', () => {
  test('group metrics are weighted by port-minutes, not by the mean of percentages', () => {
    const small = metricsFor({
      scopeKey: 'scope-1',
      window: { startMs: T0, endMs: T0 + 60 * MIN },
      snapshots: [0, 1, 2, 3].map((i) =>
        snapshot({ observedAtUtcMs: T0 + i * 15 * MIN, available: 0, occupied: 2 }),
      ),
      monitoringWindows: [monitoring(T0 - DAY)],
      gaps: [],
      capacity: [capacity(2)],
    });
    const large = metricsFor({
      scopeKey: 'scope-1',
      window: { startMs: T0, endMs: T0 + 60 * MIN },
      snapshots: [0, 1, 2, 3].map((i) =>
        snapshot({ observedAtUtcMs: T0 + i * 15 * MIN, available: 20, occupied: 0 }),
      ),
      monitoringWindows: [monitoring(T0 - DAY)],
      gaps: [],
      capacity: [capacity(20)],
    });

    const agg = aggregateScopeMetrics([small, large]);
    // Mean of percentages would be 50; port-minute weighting gives 120/1320.
    assert.equal(round(agg.observedOccupancyPct), round((100 * 120) / 1320));
    assert.notEqual(round(agg.observedOccupancyPct), 50);
  });
});

describe('heatmap', () => {
  test('bins with no observation are null, not zero', () => {
    const heat = computeHeatmap([
      buildScopeIntervals({
        scopeKey: 'scope-1',
        window: { startMs: T0, endMs: T0 + HOUR },
        snapshots: [snapshot({ observedAtUtcMs: T0, available: 1, occupied: 1 })],
        monitoringWindows: [monitoring(T0 - DAY)],
        gaps: [],
        capacity: [capacity(2)],
      }),
    ]);
    assert.equal(heat.bins.length, 168);
    const withData = heat.bins.filter((b) => b.hasData);
    assert.ok(withData.length >= 1 && withData.length <= 2);
    for (const bin of heat.bins) {
      if (!bin.hasData) assert.equal(bin.occupancyPct, null);
    }
  });

  test('a long interval is attributed to every local hour it covers', () => {
    // 2026-09-01T00:00Z is 2026-08-31 17:00 in Phoenix (UTC-7, no DST).
    const heat = computeHeatmap([
      buildScopeIntervals({
        scopeKey: 'scope-1',
        window: { startMs: T0, endMs: T0 + 30 * MIN },
        snapshots: [snapshot({ observedAtUtcMs: T0, available: 0, occupied: 1 })],
        monitoringWindows: [monitoring(T0 - DAY)],
        gaps: [],
        capacity: [capacity(1)],
      }),
    ]);
    const hour17 = heat.bins.find((b) => b.hour === 17 && b.hasData);
    assert.ok(hour17, 'the Phoenix local hour is 17, not the UTC hour 0');
    assert.equal(round(hour17?.occupiedPortMinutes ?? null), 30);
  });

  test('a single observed hour does not become a peak-period claim', () => {
    const heat = computeHeatmap([
      buildScopeIntervals({
        scopeKey: 'scope-1',
        window: { startMs: T0, endMs: T0 + 30 * MIN },
        snapshots: [snapshot({ observedAtUtcMs: T0, available: 0, occupied: 1 })],
        monitoringWindows: [monitoring(T0 - DAY)],
        gaps: [],
        capacity: [capacity(1)],
      }),
    ]);
    assert.equal(heat.peak, null);
  });
});
