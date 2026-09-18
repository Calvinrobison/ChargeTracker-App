/**
 * View models the UI actually renders (§18, §19).
 *
 * These prove that the Overview table, the map markers and the detail drawer
 * all come from the same metric engine and the same shared window, and that
 * nullability survives to the UI instead of becoming a zero.
 *
 * Run: node --experimental-strip-types --test tests/nodeps/queries.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { openNodeSqlite } from '../../src/database/drivers/node-sqlite.ts';
import { applyConnectionPragmas } from '../../src/database/driver.ts';
import { migrate } from '../../src/database/migrator.ts';
import { MIGRATIONS } from '../../src/database/migrations/index.ts';
import { QueryService, formatRelative } from '../../src/database/queries.ts';
import {
  coverageRepository,
  observationsRepository,
  sitesRepository,
  type IngestObservation,
  type SiteRecord,
} from '../../src/database/repositories.ts';
import { DEFAULT_FRESHNESS_POLICY } from '../../src/domain/types.ts';
import type { FilterState } from '../../src/shared/ipc.ts';
import { DAY, MIN, T0 } from './helpers.ts';

const APP_VERSION = '0.1.0-test';
/** "Now" for every test: 10 days after T0. */
const NOW = T0 + 10 * DAY;

const FILTERS: FilterState = {
  query: '',
  chargingTypes: [],
  networks: [],
  monitoringStates: [],
  savedOnly: false,
  cohort: 'dc_fast',
};

interface SeedSite {
  readonly id: string;
  readonly name: string;
  readonly network: string;
  readonly level: 'level_2' | 'dc_fast';
  readonly ports: number;
  readonly occupied: number;
  readonly monitored: boolean;
  /** Days of observations from T0. */
  readonly days: number;
}

function seed(sites: readonly SeedSite[]) {
  const driver = openNodeSqlite(':memory:');
  applyConnectionPragmas(driver);
  const outcome = migrate(driver, MIGRATIONS, { appVersion: APP_VERSION, nowMs: T0 });
  assert.equal(outcome.status, 'migrated');

  const sitesRepo = sitesRepository(driver);
  const obs = observationsRepository(driver);
  const coverage = coverageRepository(driver);

  const importId = sitesRepo.recordCatalogImport({
    sourceName: 'AFDC alternative fuel stations',
    sourceUrl: 'https://afdc.energy.gov/data_download',
    retrievedAtMs: T0 - DAY,
    importedAtMs: T0,
    license: 'Public domain with attribution',
    attribution: 'U.S. DOE Alternative Fuels Data Center',
    fileSha256: 'b'.repeat(64),
    fieldMapping: {},
    centerLatitude: 33.4152,
    centerLongitude: -111.8315,
    radiusMiles: 50,
    rowCount: sites.length,
    outcome: 'succeeded',
    notes: null,
  });

  driver
    .prepare(
      `INSERT INTO sources
         (id, display_name, adapter_version, capability_version, supported_region,
          observation_granularity, identity_reliability, access_requirements, collection_method,
          min_interval_ms, min_navigation_interval_ms, distinguishes_charging,
          state_meanings_json, terms_urls_json, eligibility_state, verification_state, updated_at_ms)
       VALUES ('testsource','Test Source','0.1.0',1,'Mesa','station_aggregate','none','none',
               'rendered_dom',900000,30000,0,'{}','[]','enabled','verified',?)`,
    )
    .run(T0);

  const records: SiteRecord[] = sites.map((site, index) => ({
    id: site.id,
    registryStationId: `reg-${index}`,
    name: site.name,
    streetAddress: `${100 + index} E Main St`,
    city: 'Mesa',
    state: 'AZ',
    postalCode: '85201',
    normalizedAddress: `${100 + index} e main st mesa az`,
    latitude: 33.41 + index * 0.01,
    longitude: -111.83 - index * 0.01,
    distanceMiles: index,
    network: site.network,
    accessCondition: 'public',
    hoursText: null,
    timezone: 'America/Phoenix',
    catalogPortCount: site.ports,
    catalogLevel: site.level,
  }));
  sitesRepo.upsertFromCatalog(importId, records, T0);

  for (const site of sites) {
    if (!site.monitored) continue;
    const scopeKey = `scope-${site.id}`;
    driver
      .prepare(
        `INSERT INTO source_bindings
           (id, source_id, site_id, source_station_id, canonical_url, scope_key, physical_scope,
            granularity, identity_reliability, is_primary, enabled, capability_version,
            match_basis, match_confidence, match_disposition, effective_from_ms, created_at_ms, updated_at_ms)
         VALUES (?, 'testsource', ?, ?, ?, ?, 'whole station','station_aggregate','none',1,1,1,
                 'durable_provider_id',1.0,'confirmed',?,?,?)`,
      )
      .run(
        `binding-${site.id}`,
        site.id,
        `src-${site.id}`,
        `https://example.test/stations/${site.id}`,
        scopeKey,
        T0 - DAY,
        T0,
        T0,
      );

    coverage.setCapacity(
      {
        scopeKey,
        siteId: site.id,
        startMs: T0 - DAY,
        endMs: null,
        capacityPorts: site.ports,
        level: site.level,
        basis: 'ports_simultaneous',
        source: 'catalog',
      },
      T0,
    );
    coverage.openMonitoring(scopeKey, `binding-${site.id}`, T0 - DAY, 15 * MIN);

    const steps = Math.floor((site.days * DAY) / (15 * MIN));
    for (let i = 0; i < steps; i += 1) {
      const at = T0 + i * 15 * MIN;
      const runId = `run-${site.id}-${i}`;
      driver
        .prepare(
          `INSERT INTO collection_runs (id, source_id, adapter_version, started_ms, outcome, bindings_attempted, bindings_succeeded)
           VALUES (?, 'testsource','0.1.0',?,'succeeded',1,1)`,
        )
        .run(runId, at);
      const observation: IngestObservation = {
        id: `obs-${site.id}-${i}`,
        bindingId: `binding-${site.id}`,
        siteId: site.id,
        scopeKey,
        observedAtUtcMs: at,
        sourceUpdatedAtUtcMs: null,
        method: 'rendered_dom',
        granularity: 'station_aggregate',
        counts: {
          available: site.ports - site.occupied,
          occupied: site.occupied,
          reserved: null,
          outOfService: null,
          unknown: null,
          total: site.ports,
        },
        capacityBasis: 'ports_simultaneous',
        completeness: 'complete',
        level: site.level,
        distinguishesCharging: false,
        freshnessPolicy: DEFAULT_FRESHNESS_POLICY,
        sourceUrl: `https://example.test/stations/${site.id}`,
        parserVersion: 'test-parser@0.1.0',
        evidenceFingerprint: `sha256:${site.id}-${i}`,
        sanitizedSourceText: `${site.ports - site.occupied} available`,
        quality: 'reliable',
        sourceFreshness: 'unknown_source_clock',
        validation: null,
        ports: [],
      };
      obs.ingest(runId, [observation]);
    }
  }

  return { driver, service: new QueryService(driver, { nowMs: () => NOW }) };
}

const BUSY_DC: SeedSite = {
  id: 'busy-dc',
  name: 'Mesa Riverview DC',
  network: 'TestNet',
  level: 'dc_fast',
  ports: 4,
  occupied: 3,
  monitored: true,
  days: 10,
};
const QUIET_DC: SeedSite = {
  id: 'quiet-dc',
  name: 'Superstition Springs DC',
  network: 'TestNet',
  level: 'dc_fast',
  ports: 20,
  occupied: 8,
  monitored: true,
  days: 10,
};
const NEW_DC: SeedSite = {
  id: 'new-dc',
  name: 'Brand New Bank',
  network: 'TestNet',
  level: 'dc_fast',
  ports: 2,
  occupied: 2,
  monitored: true,
  days: 2,
};
const LEVEL2: SeedSite = {
  id: 'l2',
  name: 'Banner Baywood L2',
  network: 'OtherNet',
  level: 'level_2',
  ports: 2,
  occupied: 1,
  monitored: true,
  days: 10,
};
const CATALOG_ONLY: SeedSite = {
  id: 'catalog-only',
  name: 'Unmonitored Grocery',
  network: 'OtherNet',
  level: 'level_2',
  ports: 6,
  occupied: 0,
  monitored: false,
  days: 0,
};

describe('overview', () => {
  test('monitored and catalog locations are distinguished', () => {
    const { driver, service } = seed([BUSY_DC, QUIET_DC, LEVEL2, CATALOG_ONLY]);
    const overview = service.getOverview({
      window: { preset: '30d' },
      filters: FILTERS,
      sort: 'occupancy',
    });
    assert.equal(overview.summary.catalogLocations, 4);
    assert.equal(overview.summary.monitoredLocations, 3);
    driver.close();
  });

  test('the ranking is by observed occupancy and reports the comparable cohort', () => {
    const { driver, service } = seed([BUSY_DC, QUIET_DC]);
    const overview = service.getOverview({
      window: { preset: '30d' },
      filters: FILTERS,
      sort: 'occupancy',
    });
    assert.deepEqual(
      overview.ranked.map((s) => s.id),
      ['busy-dc', 'quiet-dc'],
    );
    assert.equal(Math.round(overview.ranked[0]?.occupancy ?? 0), 75);
    assert.equal(Math.round(overview.ranked[1]?.occupancy ?? 0), 40);
    assert.equal(overview.summary.comparableLocations, 2);
    driver.close();
  });

  test('sorting by occupied hours can put a different location first', () => {
    const { driver, service } = seed([BUSY_DC, QUIET_DC]);
    const byHours = service.getOverview({
      window: { preset: '30d' },
      filters: FILTERS,
      sort: 'occupied_hours',
    });
    assert.equal(
      byHours.ranked[0]?.id,
      'quiet-dc',
      '8 occupied ports at 40% accumulate more hours than 3 at 75%',
    );
    assert.ok((byHours.ranked[0]?.hours ?? 0) > (byHours.ranked[1]?.hours ?? 0));
    driver.close();
  });

  test('a new location stays visible as provisional, out of the primary ranking', () => {
    const { driver, service } = seed([BUSY_DC, NEW_DC]);
    const overview = service.getOverview({
      window: { preset: '30d' },
      filters: FILTERS,
      sort: 'occupancy',
    });
    assert.ok(!overview.ranked.some((s) => s.id === 'new-dc'));
    const provisional = overview.provisional.find((s) => s.id === 'new-dc');
    assert.ok(provisional, 'it is still shown');
    assert.equal(provisional?.monitoring, 'provisional');
    // The window is SHARED, so its elapsed days are the window's ten, not the
    // station's two. What disqualifies it is coverage: it was only observed for
    // two of those ten days.
    assert.ok(
      provisional?.provisionalReasons.some((r) => /coverage is below 90%/.test(r)),
      `expected a coverage reason, got ${JSON.stringify(provisional?.provisionalReasons)}`,
    );
    assert.ok((provisional?.coverage ?? 100) < 90);
    driver.close();
  });

  test('the group occupancy is port-minute weighted, not an average of percentages', () => {
    const { driver, service } = seed([BUSY_DC, QUIET_DC]);
    const overview = service.getOverview({
      window: { preset: '30d' },
      filters: FILTERS,
      sort: 'occupancy',
    });
    // Averaging 75% and 40% would give 58%; weighting by port-minutes gives
    // 11/24, which is 46%.
    const expected = (100 * (3 + 8)) / (4 + 20);
    assert.equal(Math.round(overview.summary.observedOccupancyPct ?? 0), Math.round(expected));
    assert.notEqual(Math.round(overview.summary.observedOccupancyPct ?? 0), 58);
    driver.close();
  });

  test('Level 2 is compared with Level 2 only', () => {
    const { driver, service } = seed([BUSY_DC, LEVEL2]);
    const dc = service.getOverview({
      window: { preset: '30d' },
      filters: FILTERS,
      sort: 'occupancy',
    });
    const l2 = service.getOverview({
      window: { preset: '30d' },
      filters: { ...FILTERS, cohort: 'level_2' },
      sort: 'occupancy',
    });
    assert.deepEqual(
      dc.ranked.map((s) => s.id),
      ['busy-dc'],
    );
    assert.deepEqual(
      l2.ranked.map((s) => s.id),
      ['l2'],
    );
    assert.match(l2.summary.cohortDescription, /Level 2/);
    driver.close();
  });

  test('a 30-day request on ten days of history discloses the real window', () => {
    const { driver, service } = seed([BUSY_DC]);
    const overview = service.getOverview({
      window: { preset: '30d' },
      filters: FILTERS,
      sort: 'occupancy',
    });
    assert.equal(overview.summary.requestedDays, 30);
    assert.ok(overview.summary.effectiveDays <= 11);
    assert.equal(overview.summary.clippedByStudyStart, true);
    driver.close();
  });

  test('the heatmap has 168 bins and unobserved bins are null', () => {
    const { driver, service } = seed([BUSY_DC]);
    const overview = service.getOverview({
      window: { preset: '30d' },
      filters: FILTERS,
      sort: 'occupancy',
    });
    assert.equal(overview.heatmap.length, 168);
    for (const cell of overview.heatmap) {
      if (!cell.hasData) assert.equal(cell.occupancyPct, null);
    }
    driver.close();
  });

  test('the trend draws missing days as null, never as zero', () => {
    const { driver, service } = seed([BUSY_DC]);
    const overview = service.getOverview({
      window: { preset: '60d' },
      filters: FILTERS,
      sort: 'occupancy',
    });
    const empties = overview.trend.points.filter((p) => !p.hasData);
    for (const point of empties) assert.equal(point.occupancyPct, null);
    assert.match(overview.trend.note, /not zero occupancy/);
    driver.close();
  });
});

describe('filters', () => {
  test('search matches name, network and address, case-insensitively', () => {
    const { driver, service } = seed([BUSY_DC, QUIET_DC, LEVEL2]);
    for (const query of ['riverview', 'RIVERVIEW', 'testnet']) {
      const result = service.getOverview({
        window: { preset: '30d' },
        filters: { ...FILTERS, query },
        sort: 'occupancy',
      });
      assert.ok(result.totalCount > 0, `${query} should match something`);
    }
    const none = service.getOverview({
      window: { preset: '30d' },
      filters: { ...FILTERS, query: 'definitely-not-present' },
      sort: 'occupancy',
    });
    assert.equal(none.totalCount, 0);
    assert.equal(none.ranked.length, 0);
    driver.close();
  });

  test('a network filter restricts the set', () => {
    const { driver, service } = seed([BUSY_DC, LEVEL2]);
    const result = service.getOverview({
      window: { preset: '30d' },
      filters: { ...FILTERS, networks: ['OtherNet'], cohort: 'level_2' },
      sort: 'occupancy',
    });
    assert.deepEqual(
      result.ranked.map((s) => s.id),
      ['l2'],
    );
    driver.close();
  });

  test('the map applies the same filters and window as the overview', () => {
    const { driver, service } = seed([BUSY_DC, QUIET_DC, CATALOG_ONLY]);
    const request = {
      window: { preset: '30d' } as const,
      filters: FILTERS,
      sort: 'occupancy' as const,
    };
    const overview = service.getOverview(request);
    const map = service.getMapMarkers({ ...request, metric: 'occupancy' });
    assert.deepEqual(map.summary, overview.summary, 'identical summary from the same engine');
    driver.close();
  });
});

describe('map markers', () => {
  test('catalog-only locations are always included and are grey/unknown', () => {
    const { driver, service } = seed([BUSY_DC, CATALOG_ONLY]);
    const map = service.getMapMarkers({
      window: { preset: '30d' },
      filters: FILTERS,
      sort: 'occupancy',
      metric: 'occupancy',
    });
    const catalog = map.stations.find((s) => s.id === 'catalog-only');
    assert.ok(catalog, 'the unmonitored site is plotted');
    assert.equal(catalog?.monitoring, 'catalog');
    assert.equal(catalog?.occupancy, null, 'it has no occupancy, not a zero');
    assert.equal(catalog?.available, null);
    assert.match(catalog?.scopeNote ?? '', /Catalog only/);
    driver.close();
  });

  test('the visits metric stays unavailable until real visit data exists', () => {
    const { driver, service } = seed([BUSY_DC]);
    const map = service.getMapMarkers({
      window: { preset: '30d' },
      filters: FILTERS,
      sort: 'occupancy',
      metric: 'occupancy',
    });
    assert.equal(map.visitsMetricAvailable, false);
    driver.close();
  });

  test('every marker carries coordinates and a stable id', () => {
    const { driver, service } = seed([BUSY_DC, QUIET_DC, CATALOG_ONLY]);
    const map = service.getMapMarkers({
      window: { preset: '30d' },
      filters: FILTERS,
      sort: 'occupancy',
      metric: 'occupancy',
    });
    const ids = new Set<string>();
    for (const station of map.stations) {
      assert.ok(Number.isFinite(station.lat) && Number.isFinite(station.lng));
      assert.ok(!ids.has(station.id), 'no duplicate markers');
      ids.add(station.id);
    }
    driver.close();
  });
});

describe('station detail', () => {
  test('the drawer reports scope, coverage, history and provenance', () => {
    const { driver, service } = seed([BUSY_DC]);
    const detail = service.getStationDetail('busy-dc', { preset: '30d' });
    assert.ok(detail);
    if (!detail) return;
    assert.equal(detail.station.id, 'busy-dc');
    assert.equal(detail.dataQuality.badge, 'reliable');
    assert.ok((detail.dataQuality.coveragePct ?? 0) > 90);
    assert.ok(detail.dataQuality.historyDays >= 9);
    assert.equal(detail.source.metricAlgorithmVersion, 1);
    assert.equal(detail.source.parserVersion, 'test-parser@0.1.0');
    assert.equal(detail.heatmap.length, 168);
    driver.close();
  });

  test('a source without a clock is described as freshness unknown, not fresh', () => {
    const { driver, service } = seed([BUSY_DC]);
    const detail = service.getStationDetail('busy-dc', { preset: '30d' });
    assert.equal(detail?.station.sourceUpdatedAtMs, null);
    assert.equal(detail?.station.sourceFreshness, 'unknown_source_clock');
    driver.close();
  });

  test('an aggregate-only source hides session cards and explains why', () => {
    const { driver, service } = seed([BUSY_DC]);
    const detail = service.getStationDetail('busy-dc', { preset: '30d' });
    assert.equal(detail?.activity.capability, 'aggregate_count_changes');
    assert.match(detail?.activity.explanation ?? '', /occupancy, not session records/);
    assert.equal(detail?.activity.estimatedDwell, null, 'no dwell figure is invented');
    driver.close();
  });

  test('occupancy is described as reported in use, not as charging', () => {
    const { driver, service } = seed([BUSY_DC]);
    const detail = service.getStationDetail('busy-dc', { preset: '30d' });
    assert.match(detail?.currentStatusNote ?? '', /does not state whether electricity was flowing/);
    assert.equal(detail?.station.distinguishesCharging, false);
    driver.close();
  });

  test('the visits panel is empty by default with nothing invented', () => {
    const { driver, service } = seed([BUSY_DC]);
    const detail = service.getStationDetail('busy-dc', { preset: '30d' });
    assert.equal(detail?.visits.hasData, false);
    assert.equal(detail?.visits.visitCount, null);
    assert.equal(detail?.visits.portsPer1000Visits, null);
    driver.close();
  });

  test('location context is structure only, with no fabricated figures', () => {
    const { driver, service } = seed([BUSY_DC]);
    const detail = service.getStationDetail('busy-dc', { preset: '30d' });
    assert.deepEqual(detail?.locationContext, {
      nearbyBusinesses: null,
      parking: null,
      roadTraffic: null,
      property: null,
    });
    driver.close();
  });

  test('a catalog-only location has a drawer but no invented metrics', () => {
    const { driver, service } = seed([CATALOG_ONLY]);
    const detail = service.getStationDetail('catalog-only', { preset: '30d' });
    assert.ok(detail);
    assert.equal(detail?.station.occupancy, null);
    assert.equal(detail?.station.coverage, null);
    assert.equal(detail?.station.observed, null);
    assert.equal(detail?.activity.capability, 'none');
    driver.close();
  });

  test('an unknown site id returns nothing rather than an empty shell', () => {
    const { driver, service } = seed([BUSY_DC]);
    assert.equal(service.getStationDetail('does-not-exist', { preset: '30d' }), null);
    driver.close();
  });
});

describe('collection status line', () => {
  test('the collecting label names the monitored count', () => {
    const { driver, service } = seed([BUSY_DC, QUIET_DC]);
    const status = service.getCollectionStatus({
      running: true,
      userPaused: false,
      online: true,
      queueLag: 0,
      effectiveIntervalMs: 15 * MIN,
      targetIntervalMs: 15 * MIN,
      nextCheckMs: NOW + 15 * MIN,
      anySourceUnhealthy: false,
    });
    assert.equal(status.kind, 'collecting');
    assert.equal(status.label, 'Collecting · 2 locations');
    assert.ok(status.lastObservationMs !== null);
    driver.close();
  });

  test('each state has its own plain-text label', () => {
    const { driver, service } = seed([BUSY_DC]);
    const base = {
      running: true,
      userPaused: false,
      online: true,
      queueLag: 0,
      effectiveIntervalMs: 15 * MIN,
      targetIntervalMs: 15 * MIN,
      nextCheckMs: null,
      anySourceUnhealthy: false,
    };
    assert.equal(service.getCollectionStatus({ ...base, userPaused: true }).label, 'Paused');
    assert.equal(service.getCollectionStatus({ ...base, online: false }).label, 'Offline');
    assert.equal(
      service.getCollectionStatus({ ...base, anySourceUnhealthy: true }).label,
      'Source issue',
    );
    assert.match(service.getCollectionStatus({ ...base, queueLag: 4 }).label, /Catching up/);
    driver.close();
  });

  test('the achievable cadence is reported alongside the target', () => {
    const { driver, service } = seed([BUSY_DC]);
    const status = service.getCollectionStatus({
      running: true,
      userPaused: false,
      online: true,
      queueLag: 12,
      effectiveIntervalMs: 50 * MIN,
      targetIntervalMs: 15 * MIN,
      nextCheckMs: null,
      anySourceUnhealthy: false,
    });
    assert.equal(status.effectiveIntervalMs, 50 * MIN);
    assert.equal(status.targetIntervalMs, 15 * MIN);
    assert.notEqual(status.effectiveIntervalMs, status.targetIntervalMs);
    driver.close();
  });
});

describe('relative time formatting', () => {
  test('minutes, hours and days are formatted as the UI shows them', () => {
    const now = T0 + 10 * DAY;
    assert.equal(formatRelative(now - 30_000, now), 'just now');
    assert.equal(formatRelative(now - 6 * MIN, now), '6 min ago');
    assert.equal(formatRelative(now - 3 * 60 * MIN, now), '3h ago');
    assert.equal(formatRelative(now - 2 * DAY, now), '2d ago');
    assert.equal(formatRelative(null, now), null);
  });

  test('a future timestamp does not produce a negative age', () => {
    const now = T0;
    assert.equal(formatRelative(now + 10 * MIN, now), 'just now');
  });
});
