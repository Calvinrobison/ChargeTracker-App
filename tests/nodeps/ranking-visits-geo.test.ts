/**
 * Ranking windows, eligibility, visit comparisons, radius geography and
 * catalog matching.
 *
 * Run: node --experimental-strip-types --test tests/nodeps/ranking-visits-geo.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildScopeIntervals } from '../../src/domain/intervals.ts';
import { computeScopeMetrics, type ScopeMetrics } from '../../src/domain/metrics.ts';
import {
  evaluateEligibility,
  rankScopes,
  resolveWindow,
  type RankedEntry,
} from '../../src/domain/ranking.ts';
import {
  alignVisitsToWindow,
  buildVisitComparison,
  capacityForWindow,
  validateVisitRows,
  type VisitObservation,
} from '../../src/domain/visits.ts';
import { distanceMiles, filterToRadius, withinRadius } from '../../src/domain/geo.ts';
import {
  chooseAutomaticMatch,
  normalizeAddress,
  proposeMatches,
} from '../../src/domain/matching.ts';
import { occupancyBand } from '../../src/domain/thresholds.ts';
import { STUDY_AREA_DEFAULTS } from '../../src/domain/thresholds.ts';
import { DAY, HOUR, MIN, T0, capacity, monitoring, round, snapshot } from './helpers.ts';

const MESA = {
  latitude: STUDY_AREA_DEFAULTS.centerLatitude,
  longitude: STUDY_AREA_DEFAULTS.centerLongitude,
};

/** Builds metrics for a scope observed every 15 minutes for `days` days. */
function syntheticMetrics(opts: {
  days: number;
  ports: number;
  occupied: number;
  windowDays: number;
  level?: 'level_2' | 'dc_fast' | 'unknown';
  coverageFraction?: number;
  scopeKey?: string;
}): ScopeMetrics {
  const scopeKey = opts.scopeKey ?? 'scope-1';
  const windowStart = T0;
  const windowEnd = T0 + opts.windowDays * DAY;
  const observedEnd = T0 + opts.days * DAY;
  const step = 15 * MIN;
  const coverage = opts.coverageFraction ?? 1;
  const snapshots = [];
  for (let t = windowStart; t < observedEnd; t += step) {
    // Drop a deterministic fraction of readings to model imperfect coverage.
    if (coverage < 1 && ((t - windowStart) / step) % Math.round(1 / (1 - coverage)) === 0) continue;
    snapshots.push(
      snapshot({
        scopeKey,
        observedAtUtcMs: t,
        available: opts.ports - opts.occupied,
        occupied: opts.occupied,
        level: opts.level ?? 'dc_fast',
      }),
    );
  }
  return computeScopeMetrics(
    buildScopeIntervals({
      scopeKey,
      window: { startMs: windowStart, endMs: windowEnd },
      snapshots,
      monitoringWindows: [monitoring(windowStart, null, scopeKey)],
      gaps: [],
      capacity: [capacity(opts.ports, 0, null, scopeKey, opts.level ?? 'dc_fast')],
    }),
  );
}

describe('window resolution', () => {
  const now = T0 + 40 * DAY;

  test('a 30-day request on an 11-day database yields an 11-day effective window', () => {
    const studyStart = now - 11 * DAY;
    const resolved = resolveWindow({ preset: '30d' }, now, studyStart);
    assert.equal(resolved.requestedDays, 30);
    assert.equal(round(resolved.effectiveDays), 11);
    assert.equal(resolved.clippedByStudyStart, true, 'the UI must disclose this');
    assert.equal(resolved.effective.startMs, studyStart);
  });

  test('every ranked location shares the same window, not its own convenient start', () => {
    const studyStart = now - 100 * DAY;
    const a = resolveWindow({ preset: '30d' }, now, studyStart);
    const b = resolveWindow({ preset: '30d' }, now, studyStart);
    assert.deepEqual(a.effective, b.effective);
  });

  test('all-history uses the study start', () => {
    const studyStart = now - 55 * DAY;
    const resolved = resolveWindow({ preset: 'all' }, now, studyStart);
    assert.equal(resolved.effective.startMs, studyStart);
    assert.equal(resolved.effective.endMs, now);
  });

  test('a custom range is ordered and clipped, and requires both bounds', () => {
    const resolved = resolveWindow(
      { preset: 'custom', customStartMs: now, customEndMs: now - 5 * DAY },
      now,
      null,
    );
    assert.equal(resolved.requested.startMs, now - 5 * DAY);
    assert.equal(resolved.requested.endMs, now);
    assert.throws(() => resolveWindow({ preset: 'custom' }, now, null));
  });

  test('presets 7, 30 and 60 days exist and differ', () => {
    const days = (['7d', '30d', '60d'] as const).map(
      (preset) => resolveWindow({ preset }, now, null).requestedDays,
    );
    assert.deepEqual(days, [7, 30, 60]);
  });
});

describe('primary ranking eligibility', () => {
  test('a location with fewer than seven elapsed days is provisional, not ranked', () => {
    const m = syntheticMetrics({ days: 3, windowDays: 3, ports: 2, occupied: 1 });
    const eligibility = evaluateEligibility(m);
    assert.equal(eligibility.eligible, false);
    assert.ok(eligibility.failures.includes('insufficient_elapsed_days'));
    assert.equal(eligibility.badge, 'provisional');
  });

  test('a location below 90% known-state coverage is provisional', () => {
    // Observed for only 4 of 10 days, so coverage over the window is ~40%.
    const m = syntheticMetrics({ days: 4, windowDays: 10, ports: 2, occupied: 1 });
    const eligibility = evaluateEligibility(m);
    assert.ok((m.statusCoveragePct ?? 100) < 90);
    assert.equal(eligibility.eligible, false);
    assert.ok(eligibility.failures.includes('insufficient_status_coverage'));
  });

  test('unknown capacity blocks eligibility rather than being assumed', () => {
    const m = computeScopeMetrics(
      buildScopeIntervals({
        scopeKey: 'scope-1',
        window: { startMs: T0, endMs: T0 + 10 * DAY },
        snapshots: [snapshot({ observedAtUtcMs: T0, available: 1, occupied: 1 })],
        monitoringWindows: [monitoring(T0)],
        gaps: [],
        capacity: [],
      }),
    );
    assert.ok(evaluateEligibility(m).failures.includes('unknown_capacity'));
  });

  test('a source without an occupied count can never be ranked by occupancy', () => {
    const m = computeScopeMetrics(
      buildScopeIntervals({
        scopeKey: 'scope-1',
        window: { startMs: T0, endMs: T0 + 10 * DAY },
        snapshots: [snapshot({ observedAtUtcMs: T0, available: 2, total: 10 })],
        monitoringWindows: [monitoring(T0)],
        gaps: [],
        capacity: [capacity(10)],
      }),
    );
    assert.equal(m.observedOccupancyPct, null);
    assert.ok(evaluateEligibility(m).failures.includes('occupancy_unsupported'));
  });

  test('a fully covered ten-day location is eligible', () => {
    const m = syntheticMetrics({ days: 10, windowDays: 10, ports: 4, occupied: 2 });
    assert.equal(round(m.statusCoveragePct), 100);
    assert.equal(evaluateEligibility(m).eligible, true);
  });
});

describe('ranking construction', () => {
  function entry(
    metrics: ScopeMetrics,
    level: RankedEntry['level'],
    scopeKey: string,
  ): RankedEntry {
    return { scopeKey, metrics, eligibility: evaluateEligibility(metrics), level };
  }

  const busyDc = entry(
    syntheticMetrics({ days: 10, windowDays: 10, ports: 2, occupied: 2, scopeKey: 'dc-busy' }),
    'dc_fast',
    'dc-busy',
  );
  const bigDc = entry(
    syntheticMetrics({ days: 10, windowDays: 10, ports: 20, occupied: 8, scopeKey: 'dc-big' }),
    'dc_fast',
    'dc-big',
  );
  const level2 = entry(
    syntheticMetrics({
      days: 10,
      windowDays: 10,
      ports: 4,
      occupied: 3,
      level: 'level_2',
      scopeKey: 'l2',
    }),
    'level_2',
    'l2',
  );
  const provisional = entry(
    syntheticMetrics({ days: 2, windowDays: 10, ports: 2, occupied: 2, scopeKey: 'new' }),
    'dc_fast',
    'new',
  );
  const ambiguous = entry(
    syntheticMetrics({
      days: 10,
      windowDays: 10,
      ports: 6,
      occupied: 3,
      level: 'unknown',
      scopeKey: 'amb',
    }),
    'unknown',
    'amb',
  );

  const window = { startMs: T0, endMs: T0 + 10 * DAY };
  const all = [busyDc, bigDc, level2, provisional, ambiguous];

  test('Level 2 is compared with Level 2 by default', () => {
    const dc = rankScopes(all, 'dc_fast', 'occupancy', window);
    const l2 = rankScopes(all, 'level_2', 'occupancy', window);
    assert.deepEqual(
      dc.primary.map((e) => e.scopeKey),
      ['dc-busy', 'dc-big'],
    );
    assert.deepEqual(
      l2.primary.map((e) => e.scopeKey),
      ['l2'],
    );
  });

  test('provisional locations stay visible but out of the primary ranking', () => {
    const dc = rankScopes(all, 'dc_fast', 'occupancy', window);
    assert.ok(!dc.primary.some((e) => e.scopeKey === 'new'));
    assert.ok(dc.provisional.some((e) => e.scopeKey === 'new'));
  });

  test('an aggregate with no type breakdown is excluded and explained, not guessed', () => {
    const dc = rankScopes(all, 'dc_fast', 'occupancy', window);
    assert.ok(dc.excludedAmbiguous.some((e) => e.scopeKey === 'amb'));
    assert.ok(!dc.primary.some((e) => e.scopeKey === 'amb'));
  });

  test('sorting by occupied hours can produce a different leader than occupancy', () => {
    const byOccupancy = rankScopes(all, 'dc_fast', 'occupancy', window);
    const byHours = rankScopes(all, 'dc_fast', 'occupied_hours', window);
    assert.equal(byOccupancy.primary[0]?.scopeKey, 'dc-busy');
    assert.equal(byHours.primary[0]?.scopeKey, 'dc-big');
  });

  test('the combined cohort must describe its capacity-weighted meaning', () => {
    const combined = rankScopes(all, 'combined', 'occupancy', window);
    assert.match(combined.disclosure.cohortDescription, /weighted by port-minutes/);
  });

  test('the disclosure reports the actual window and the monitored subset', () => {
    const dc = rankScopes(all, 'dc_fast', 'occupancy', window);
    assert.equal(dc.disclosure.effectiveStartMs, window.startMs);
    assert.equal(dc.disclosure.effectiveEndMs, window.endMs);
    assert.equal(dc.disclosure.monitoredScopeCount, all.length);
    assert.equal(dc.disclosure.eligibleScopeCount, dc.primary.length);
  });
});

describe('map colour bands', () => {
  test('thresholds are 30 and 60 percent, with null as its own band', () => {
    assert.equal(occupancyBand(0), 'low');
    assert.equal(occupancyBand(29.99), 'low');
    assert.equal(occupancyBand(30), 'moderate');
    assert.equal(occupancyBand(59.99), 'moderate');
    assert.equal(occupancyBand(60), 'high');
    assert.equal(occupancyBand(100), 'high');
    assert.equal(occupancyBand(null), 'unsupported');
    assert.equal(occupancyBand(Number.NaN), 'unsupported');
  });
});

describe('visit imports', () => {
  const sites = new Set(['site-1', 'site-2']);
  function row(overrides: Partial<VisitObservation> = {}): VisitObservation {
    return {
      datasetId: 'ds-1',
      siteId: 'site-1',
      period: { startMs: T0, endMs: T0 + DAY },
      visitCount: 100,
      countDefinition: 'property_entries',
      method: 'measured',
      geographicScope: 'whole_property',
      sourceName: 'Site owner',
      sourceReference: null,
      notes: null,
      ...overrides,
    };
  }

  test('negative, fractional and inverted rows are rejected with reasons', () => {
    const result = validateVisitRows(
      [
        row({ visitCount: -1 }),
        row({ visitCount: 1.5 }),
        row({ period: { startMs: T0 + DAY, endMs: T0 } }),
        row({ siteId: 'nope' }),
      ],
      sites,
    );
    assert.equal(result.accepted.length, 0);
    const codes = result.issues.map((i) => i.code);
    assert.ok(codes.includes('negative_count'));
    assert.ok(codes.includes('non_integer_count'));
    assert.ok(codes.includes('inverted_period'));
    assert.ok(codes.includes('unknown_site'));
  });

  test('duplicate and overlapping rows in one dataset are rejected, never summed', () => {
    const result = validateVisitRows(
      [row(), row(), row({ period: { startMs: T0 + HOUR, endMs: T0 + 2 * DAY } })],
      sites,
    );
    assert.equal(result.accepted.length, 1);
    const codes = result.issues.map((i) => i.code);
    assert.ok(codes.includes('duplicate_row'));
    assert.ok(codes.includes('overlapping_same_dataset'));
  });

  test('a zero visit count is valid data and is accepted', () => {
    const result = validateVisitRows([row({ visitCount: 0 })], sites);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.issues.length, 0);
  });

  test('a monthly total is never prorated into a shorter window', () => {
    const monthly = row({ period: { startMs: T0, endMs: T0 + 30 * DAY }, visitCount: 30_000 });
    const alignment = alignVisitsToWindow([monthly], { startMs: T0, endMs: T0 + 7 * DAY });
    assert.equal(alignment.ok, false);
    if (alignment.ok) return;
    assert.equal(alignment.reason, 'would_require_proration');
  });

  test('whole matching periods align, partial coverage is suppressed', () => {
    const daily = [0, 1, 2].map((d) =>
      row({ period: { startMs: T0 + d * DAY, endMs: T0 + (d + 1) * DAY }, visitCount: 10 }),
    );
    const ok = alignVisitsToWindow(daily, { startMs: T0, endMs: T0 + 3 * DAY });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.visitCount, 30);

    const gappy = alignVisitsToWindow(
      [daily[0] as VisitObservation, daily[2] as VisitObservation],
      {
        startMs: T0,
        endMs: T0 + 3 * DAY,
      },
    );
    assert.equal(gappy.ok, false);
    if (!gappy.ok) assert.equal(gappy.reason, 'partial_period_coverage');
  });

  test('mixed count definitions or scopes are not silently combined', () => {
    const a = row({ period: { startMs: T0, endMs: T0 + DAY } });
    const b = row({
      period: { startMs: T0 + DAY, endMs: T0 + 2 * DAY },
      countDefinition: 'unique_visitors',
    });
    const result = alignVisitsToWindow([a, b], { startMs: T0, endMs: T0 + 2 * DAY });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'definition_mismatch');
  });

  test('zero visits makes per-visit ratios undefined, not infinity or zero', () => {
    const alignment = alignVisitsToWindow([row({ visitCount: 0 })], {
      startMs: T0,
      endMs: T0 + DAY,
    });
    assert.equal(alignment.ok, true);
    if (!alignment.ok) return;
    const comparison = buildVisitComparison({
      alignment,
      capacity: capacityForWindow([{ period: { startMs: T0, endMs: T0 + DAY }, ports: 4 }], {
        startMs: T0,
        endMs: T0 + DAY,
      }),
      statusCoveragePct: 100,
      recordedSessionCount: null,
      recordedSessionsCoverSamePeriodAndScope: false,
      detectedOccupancyStartCount: 12,
    });
    assert.equal(comparison.portsPer1000Visits, null);
    assert.equal(comparison.detectedOccupancyStartsPer1000Visits, null);
    assert.ok(comparison.limitations.some((l) => /undefined/.test(l)));
  });

  test('ratios use the stated definitions and expose the ports basis', () => {
    const alignment = alignVisitsToWindow([row({ visitCount: 2000 })], {
      startMs: T0,
      endMs: T0 + DAY,
    });
    assert.equal(alignment.ok, true);
    if (!alignment.ok) return;
    const comparison = buildVisitComparison({
      alignment,
      capacity: capacityForWindow([{ period: { startMs: T0, endMs: T0 + DAY }, ports: 4 }], {
        startMs: T0,
        endMs: T0 + DAY,
      }),
      statusCoveragePct: 100,
      recordedSessionCount: 50,
      recordedSessionsCoverSamePeriodAndScope: true,
      detectedOccupancyStartCount: 30,
    });
    assert.equal(comparison.portsBasis, 'constant');
    assert.equal(comparison.visitsPerInstalledPort, 500);
    assert.equal(comparison.portsPer1000Visits, 2);
    assert.equal(comparison.recordedSessionsPer1000Visits, 25);
    assert.equal(comparison.detectedOccupancyStartsPer1000Visits, 15);
  });

  test('a mid-window capacity change switches to a labelled time-weighted basis', () => {
    const basis = capacityForWindow(
      [
        { period: { startMs: T0, endMs: T0 + 12 * HOUR }, ports: 2 },
        { period: { startMs: T0 + 12 * HOUR, endMs: T0 + DAY }, ports: 6 },
      ],
      { startMs: T0, endMs: T0 + DAY },
    );
    assert.equal(basis.capacityChangedDuringWindow, true);
    assert.equal(basis.constantPorts, null);
    assert.equal(basis.effectivePorts, 4);
    assert.equal(basis.componentPeriods.length, 2);
  });

  test('recorded session ratios are withheld when the periods do not match', () => {
    const alignment = alignVisitsToWindow([row({ visitCount: 1000 })], {
      startMs: T0,
      endMs: T0 + DAY,
    });
    assert.equal(alignment.ok, true);
    if (!alignment.ok) return;
    const comparison = buildVisitComparison({
      alignment,
      capacity: capacityForWindow([{ period: { startMs: T0, endMs: T0 + DAY }, ports: 2 }], {
        startMs: T0,
        endMs: T0 + DAY,
      }),
      statusCoveragePct: 100,
      recordedSessionCount: 10,
      recordedSessionsCoverSamePeriodAndScope: false,
      detectedOccupancyStartCount: null,
    });
    assert.equal(comparison.recordedSessionsPer1000Visits, null);
    assert.ok(comparison.limitations.some((l) => /same period and scope/.test(l)));
  });

  test('detected starts per 1,000 visits is withheld while coverage is incomplete', () => {
    const alignment = alignVisitsToWindow([row({ visitCount: 1000 })], {
      startMs: T0,
      endMs: T0 + DAY,
    });
    assert.equal(alignment.ok, true);
    if (!alignment.ok) return;
    const comparison = buildVisitComparison({
      alignment,
      capacity: capacityForWindow([{ period: { startMs: T0, endMs: T0 + DAY }, ports: 2 }], {
        startMs: T0,
        endMs: T0 + DAY,
      }),
      statusCoveragePct: 55,
      recordedSessionCount: null,
      recordedSessionsCoverSamePeriodAndScope: false,
      detectedOccupancyStartCount: 40,
    });
    assert.equal(comparison.detectedOccupancyStartsPer1000Visits, null);
    assert.ok(comparison.limitations.some((l) => /coverage is incomplete/.test(l)));
  });
});

describe('study-area geography', () => {
  test('distance is straight-line miles and symmetric', () => {
    const scottsdale = { latitude: 33.4942, longitude: -111.9261 };
    const d1 = distanceMiles(MESA, scottsdale);
    const d2 = distanceMiles(scottsdale, MESA);
    assert.equal(round(d1, 6), round(d2, 6));
    assert.ok(d1 > 5 && d1 < 8, `expected roughly 6 miles, got ${d1.toFixed(2)}`);
  });

  test('a known Mesa address falls inside the 50-mile study radius', () => {
    // 6644 E Baywood Ave, Mesa (approximate coordinates).
    const baywood = { latitude: 33.3891, longitude: -111.6996 };
    assert.equal(withinRadius(MESA, baywood, 50), true);
    assert.ok(distanceMiles(MESA, baywood) < 10);
  });

  test('the radius boundary is inclusive and far places are excluded', () => {
    // A point due north at very close to exactly 50 miles.
    const oneDegreeLatMiles = distanceMiles(MESA, { ...MESA, latitude: MESA.latitude + 1 });
    const exactly50 = { ...MESA, latitude: MESA.latitude + 50 / oneDegreeLatMiles };
    assert.equal(withinRadius(MESA, exactly50, 50), true);

    const tucson = { latitude: 32.2226, longitude: -110.9747 };
    assert.equal(withinRadius(MESA, tucson, 50), false);
    const flagstaff = { latitude: 35.1983, longitude: -111.6513 };
    assert.equal(withinRadius(MESA, flagstaff, 50), false);
  });

  test('invalid coordinates are rejected rather than coerced', () => {
    assert.throws(() => distanceMiles(MESA, { latitude: 91, longitude: 0 }));
    assert.throws(() => distanceMiles(MESA, { latitude: 0, longitude: 181 }));
    assert.equal(withinRadius(MESA, MESA, 0), false, 'a zero radius contains nothing');
  });

  test('filtering returns distances and drops rows without usable coordinates', () => {
    const rows = [
      { id: 'in', coordinate: { latitude: 33.42, longitude: -111.83 } },
      { id: 'far', coordinate: { latitude: 32.22, longitude: -110.97 } },
      { id: 'bad', coordinate: { latitude: Number.NaN, longitude: 0 } },
    ];
    const filtered = filterToRadius(rows, MESA, 50);
    assert.deepEqual(
      filtered.map((r) => r.id),
      ['in'],
    );
    assert.ok((filtered[0]?.distanceMiles ?? 99) < 1);
  });
});

describe('catalog matching', () => {
  const candidates = [
    {
      siteId: 'site-a',
      name: 'Banner Health Baywood 2',
      network: 'ChargePoint',
      normalizedAddress: normalizeAddress('6644 E. Baywood Ave, Mesa, AZ'),
      coordinate: { latitude: 33.3891, longitude: -111.6996 },
      sourceStationId: '11502081',
    },
    {
      siteId: 'site-b',
      name: 'Banner Health Baywood 1',
      network: 'ChargePoint',
      normalizedAddress: normalizeAddress('6644 East Baywood Avenue, Mesa, AZ'),
      coordinate: { latitude: 33.3892, longitude: -111.6997 },
      sourceStationId: '11502080',
    },
  ];

  test('a durable provider id wins outright', () => {
    const proposals = proposeMatches(
      {
        sourceStationId: '11502081',
        name: 'BANNER HEALTH / BAYWOOD 2',
        network: 'ChargePoint',
        normalizedAddress: null,
        coordinate: null,
      },
      candidates,
    );
    assert.equal(proposals[0]?.siteId, 'site-a');
    assert.equal(proposals[0]?.basis, 'durable_provider_id');
    assert.equal(proposals[0]?.confidence, 1);
    assert.equal(chooseAutomaticMatch(proposals)?.siteId, 'site-a');
  });

  test('address normalization makes two spellings of one address agree', () => {
    assert.equal(
      normalizeAddress('6644 E. Baywood Ave, Mesa, AZ'),
      normalizeAddress('6644 East Baywood Avenue, Mesa, AZ'),
    );
  });

  test('proximity alone is a low-confidence proposal, never an automatic merge', () => {
    const proposals = proposeMatches(
      {
        sourceStationId: null,
        name: 'Unnamed charger',
        network: null,
        normalizedAddress: null,
        coordinate: { latitude: 33.3891, longitude: -111.6996 },
      },
      candidates,
    );
    assert.ok(proposals.length >= 1);
    for (const p of proposals) {
      assert.equal(p.basis, 'coordinates_only');
      assert.equal(p.disposition, 'proposed');
      assert.ok(p.confidence < 0.95);
      assert.ok(p.reasons.some((r) => /distinct charging banks/.test(r)));
    }
    assert.equal(chooseAutomaticMatch(proposals), null);
  });

  test('two equally confident candidates are an ambiguity, not a coin flip', () => {
    const ambiguous = proposeMatches(
      {
        sourceStationId: null,
        name: 'Banner Health Baywood 2',
        network: 'ChargePoint',
        normalizedAddress: normalizeAddress('6644 E. Baywood Ave, Mesa, AZ'),
        coordinate: { latitude: 33.3891, longitude: -111.6996 },
      },
      [
        { ...(candidates[0] as (typeof candidates)[0]), sourceStationId: null },
        {
          ...(candidates[1] as (typeof candidates)[1]),
          sourceStationId: null,
          normalizedAddress: normalizeAddress('6644 E. Baywood Ave, Mesa, AZ'),
          name: 'Banner Health Baywood 2',
        },
      ],
    );
    const confirmed = ambiguous.filter((p) => p.disposition === 'confirmed');
    assert.ok(confirmed.length !== 1 || chooseAutomaticMatch(ambiguous) !== null);
    if (confirmed.length > 1) assert.equal(chooseAutomaticMatch(ambiguous), null);
  });
});
