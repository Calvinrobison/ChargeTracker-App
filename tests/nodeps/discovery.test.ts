/**
 * Station discovery: reading the provider's list for the study area and
 * linking what it finds to catalog sites.
 *
 * Two halves. The list reader runs against a fake browser runtime whose pages
 * are canned copies of the real list shape (device_id, name1/name2, lat/lon,
 * page_offset cursor, "last_page" terminator). The binder runs against a real
 * node:sqlite database with a seeded catalog, through the same DatabaseWorker
 * the application uses.
 *
 * Run: node --experimental-strip-types --test tests/nodeps/discovery.test.ts
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';

import {
  boundingBox,
  discoverStations,
  listPageScript,
  stationListRequest,
  toDiscoveredStation,
  type DiscoveryArea,
} from '../../src/collector/adapters/chargepoint/discover.ts';
import { CAPABILITIES } from '../../src/collector/adapters/chargepoint/index.ts';
import type { BrowserRuntime } from '../../src/collector/browser.ts';
import { DatabaseWorker } from '../../src/database/worker.ts';
import { openNodeSqlite } from '../../src/database/drivers/node-sqlite.ts';
import { sitesRepository, type SiteRecord } from '../../src/database/repositories.ts';
import { DAY, T0 } from './helpers.ts';

const MESA: DiscoveryArea = {
  centerLatitude: 33.4152,
  centerLongitude: -111.8315,
  radiusMiles: 50,
};

// ---------------------------------------------------------------------------
// The list reader
// ---------------------------------------------------------------------------

interface CannedPage {
  readonly pageOffset: string | null;
  readonly stations: readonly Record<string, unknown>[];
}

/** A fake runtime whose page returns canned list pages in order. */
function fakeRuntime(pages: readonly CannedPage[], navigateOk = true) {
  const evaluated: string[] = [];
  let cursor = 0;
  const page = {
    evaluate: async (script: string) => {
      evaluated.push(script);
      const canned = pages[Math.min(cursor, pages.length - 1)];
      cursor += 1;
      if (!canned) return { error: 'no canned page' };
      return { pageOffset: canned.pageOffset, stations: canned.stations };
    },
  };
  const runtime = {
    acquirePage: async () => page,
    navigate: async (_page: unknown, url: string) => ({
      ok: navigateOk,
      status: navigateOk ? 200 : 503,
      retryAfterMs: null,
      finalUrl: url,
      detail: navigateOk ? null : 'HTTP 503',
    }),
  } as unknown as BrowserRuntime;
  return { runtime, evaluated };
}

function entry(
  id: number,
  name: string,
  lat: number,
  lon: number,
  extra: Record<string, unknown> = {},
) {
  const [name1, ...rest] = name.split(' ');
  return {
    deviceId: id,
    name1,
    name2: rest.join(' '),
    address1: '1 Test St',
    city: 'Mesa',
    lat,
    lon,
    totalPortCount: 2,
    displayLevel: 'AC',
    network: 'ChargePoint Network',
    ...extra,
  };
}

async function run(
  pages: readonly CannedPage[],
  overrides: Partial<Parameters<typeof discoverStations>[1]> = {},
) {
  const { runtime, evaluated } = fakeRuntime(pages);
  const slots: number[] = [];
  const report = await discoverStations(MESA, {
    runtime,
    acquireNavigationSlot: async () => {
      slots.push(1);
    },
    log: () => undefined,
    abortSignal: new AbortController().signal,
    sleep: async () => undefined,
    nowMs: () => T0,
    ...overrides,
  });
  return { report, evaluated, slots };
}

describe('the study-area bounding box', () => {
  test('contains the whole circle and is centred on the study point', () => {
    const box = boundingBox(MESA);
    assert.ok(box.ne_lat > MESA.centerLatitude && box.sw_lat < MESA.centerLatitude);
    assert.ok(box.ne_lon > MESA.centerLongitude && box.sw_lon < MESA.centerLongitude);
    // 50 miles is about 0.72° of latitude and, at 33.4° N, about 0.87° of longitude.
    assert.ok(Math.abs(box.ne_lat - MESA.centerLatitude - 0.7246) < 0.001);
    assert.ok(Math.abs(box.ne_lon - MESA.centerLongitude - 0.8683) < 0.001);
  });

  test('the list request turns every filter off and asks for the whole box', () => {
    const request = stationListRequest(MESA, '') as { station_list: Record<string, unknown> };
    const list = request.station_list;
    assert.equal(list['page_size'], 50);
    assert.equal(list['page_offset'], '');
    for (const [key, value] of Object.entries(list['filter'] as Record<string, unknown>)) {
      assert.equal(value, false, `filter ${key} must be off`);
    }
  });

  test('the in-page script is valid JavaScript and only ever reads the list endpoint', () => {
    const script = listPageScript(stationListRequest(MESA, ''));
    // Compiled, never run: a vm.Script parses the source without executing it.
    assert.doesNotThrow(() => new Script(`(${script})`));
    assert.match(script, /https:\/\/mc\.chargepoint\.com\/map-prod\/v2/);
    assert.match(script, /credentials: 'omit'/);
  });
});

describe('one list entry', () => {
  test('becomes a station with the provider id, name, position and page URL', () => {
    const { station, warning } = toDiscoveredStation(
      entry(11502161, 'BANNER HEALTH BAYWOOD 1', 33.410957, -111.68973),
      MESA,
    );
    assert.equal(warning, null);
    assert.ok(station);
    assert.equal(station.sourceStationId, '11502161');
    assert.equal(station.name, 'BANNER HEALTH BAYWOOD 1');
    assert.equal(station.canonicalUrl, 'https://driver.chargepoint.com/stations/11502161');
    assert.equal(station.portCount, 2);
    assert.ok(station.distanceMiles > 8 && station.distanceMiles < 9);
  });

  test('is dropped, with a warning, when it has no id, no position or no name', () => {
    assert.equal(toDiscoveredStation(entry(0, 'X Y', 33.4, -111.8), MESA).station, null);
    assert.match(
      toDiscoveredStation({ ...entry(5, 'X Y', 33.4, -111.8), lat: null }, MESA).warning ?? '',
      /no coordinates/,
    );
    assert.match(
      toDiscoveredStation({ ...entry(5, 'X Y', 33.4, -111.8), name1: '', name2: '' }, MESA)
        .warning ?? '',
      /no name/,
    );
  });
});

describe('reading the list', () => {
  test('spends one navigation slot, pages until last_page, and collapses duplicates', async () => {
    const { report, evaluated, slots } = await run([
      {
        pageOffset: 'cursor-1',
        stations: [entry(1, 'A ONE', 33.42, -111.83), entry(2, 'B TWO', 33.43, -111.84)],
      },
      {
        pageOffset: 'last_page',
        stations: [entry(2, 'B TWO', 33.43, -111.84), entry(3, 'C THREE', 33.44, -111.85)],
      },
    ]);
    assert.equal(slots.length, 1, 'the map page load is the only navigation');
    assert.equal(evaluated.length, 2);
    assert.equal(report.pagesRead, 2);
    assert.equal(report.truncated, false);
    assert.deepEqual(
      report.stations.map((s) => s.sourceStationId),
      ['1', '2', '3'],
    );
  });

  test('drops stations outside the study radius even though the box is wider', async () => {
    const { report } = await run([
      {
        pageOffset: null,
        stations: [
          entry(1, 'NEAR ONE', 33.42, -111.83),
          // Roughly 49 miles east: inside the box's corner reach, outside the circle? No —
          // put it 60 miles away so it is clearly out.
          entry(2, 'FAR TWO', 33.42, -111.8315 + 60 / 57.6),
        ],
      },
    ]);
    assert.deepEqual(
      report.stations.map((s) => s.sourceStationId),
      ['1'],
    );
  });

  test('stops at the page cap and says so', async () => {
    const endless: CannedPage[] = Array.from({ length: 10 }, (_, i) => ({
      pageOffset: `cursor-${i}`,
      stations: [entry(100 + i, `S ${i}`, 33.42, -111.83)],
    }));
    const { report } = await run(endless, { maxPages: 3 });
    assert.equal(report.pagesRead, 3);
    assert.equal(report.truncated, true);
    assert.ok(report.warnings.some((w) => /stopped after 3/.test(w)));
  });

  test('a list request error is an error, not an empty result', async () => {
    const { runtime } = fakeRuntime([]);
    (runtime as unknown as { acquirePage: () => Promise<unknown> }).acquirePage = async () => ({
      evaluate: async () => ({ error: 'HTTP 429', status: 429 }),
    });
    await assert.rejects(
      discoverStations(MESA, {
        runtime,
        acquireNavigationSlot: async () => undefined,
        log: () => undefined,
        abortSignal: new AbortController().signal,
        sleep: async () => undefined,
      }),
      /HTTP 429/,
    );
  });

  test('a map page that will not open is an error', async () => {
    const { runtime } = fakeRuntime([], false);
    await assert.rejects(
      discoverStations(MESA, {
        runtime,
        acquireNavigationSlot: async () => undefined,
        log: () => undefined,
        abortSignal: new AbortController().signal,
        sleep: async () => undefined,
      }),
      /could not be opened/,
    );
  });
});

// ---------------------------------------------------------------------------
// Binding to the catalog
// ---------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'chargewatch-discovery-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

async function openWorker(name: string) {
  const dir = join(scratch, name);
  const worker = new DatabaseWorker({
    databaseFile: join(dir, 'db', 'chargewatch.sqlite'),
    databaseDir: join(dir, 'db'),
    backupsDir: join(dir, 'backups'),
    stagingDir: join(dir, 'staging'),
    appVersion: '0.3.0-test',
    timeZone: 'America/Phoenix',
    openDriver: openNodeSqlite,
    nowMs: () => T0,
  });
  const state = await worker.open();
  assert.equal(state.status, 'ready', JSON.stringify(state));
  worker.upsertSources([CAPABILITIES]);
  return worker;
}

function site(id: string, name: string, lat: number, lon: number, ports = 2): SiteRecord {
  return {
    id,
    registryStationId: id.replace('afdc-', ''),
    name,
    streetAddress: '6644 E Baywood Ave',
    city: 'Mesa',
    state: 'AZ',
    postalCode: '85206',
    normalizedAddress: '6644 e baywood ave mesa az',
    latitude: lat,
    longitude: lon,
    distanceMiles: 8.5,
    network: 'ChargePoint Network',
    accessCondition: 'public',
    hoursText: '24 hours daily',
    timezone: 'America/Phoenix',
    catalogPortCount: ports,
    catalogLevel: 'level_2',
  };
}

function seedCatalog(worker: DatabaseWorker, records: readonly SiteRecord[]) {
  // The worker keeps its driver private, as it should; the catalog goes in
  // through the same repository the catalog import uses.
  const driver = (worker as unknown as { driver: Parameters<typeof sitesRepository>[0] }).driver;
  const sites = sitesRepository(driver);
  const importId = sites.recordCatalogImport({
    sourceName: 'AFDC alternative fuel stations',
    sourceUrl: 'https://afdc.energy.gov/data_download',
    retrievedAtMs: T0 - DAY,
    importedAtMs: T0,
    license: 'Public domain with attribution',
    attribution: 'U.S. DOE Alternative Fuels Data Center',
    fileSha256: 'a'.repeat(64),
    fieldMapping: { station_name: 'name' },
    centerLatitude: MESA.centerLatitude,
    centerLongitude: MESA.centerLongitude,
    radiusMiles: MESA.radiusMiles,
    rowCount: records.length,
    outcome: 'succeeded',
    notes: null,
  });
  sites.upsertFromCatalog(importId, [...records], T0);
}

const discoveredBaywood1 = {
  sourceStationId: '11502161',
  name: 'BANNER HEALTH BAYWOOD 1',
  streetAddress: '6644 E Baywood Ave',
  city: 'Mesa',
  latitude: 33.410957,
  longitude: -111.68973,
  portCount: 2,
  displayLevel: 'AC',
  network: 'ChargePoint Network',
  canonicalUrl: 'https://driver.chargepoint.com/stations/11502161',
  distanceMiles: 8.3,
};

describe('binding discovered stations', () => {
  test('an exact name at the same spot links; its sibling bank is only proposed; a stranger is unmatched', async () => {
    const worker = await openWorker('bind');
    seedCatalog(worker, [
      site('afdc-200948', 'BANNER HEALTH BAYWOOD 1', 33.410957, -111.68973),
      site('afdc-200947', 'BANNER HEALTH BAYWOOD 2', 33.410954, -111.68979),
    ]);

    const result = worker.bindDiscoveredStations({
      stations: [
        discoveredBaywood1,
        {
          ...discoveredBaywood1,
          sourceStationId: '11502171',
          name: 'BANNER HEALTH BAYWOOD 3',
          canonicalUrl: 'https://driver.chargepoint.com/stations/11502171',
        },
        {
          ...discoveredBaywood1,
          sourceStationId: '99',
          name: 'SOMEWHERE ELSE',
          streetAddress: '1 Nowhere Rd',
          city: 'Phoenix',
          latitude: 33.6,
          longitude: -112.1,
          canonicalUrl: 'https://driver.chargepoint.com/stations/99',
        },
      ],
    });

    assert.equal(result.linked, 1);
    assert.equal(result.proposed, 1, 'BAYWOOD 3 has no exact name, so it is proposed');
    assert.equal(result.unmatched, 1);
    assert.equal(result.proposals[0]?.sourceStationId, '11502171');
    assert.equal(result.unmatchedStations[0]?.sourceStationId, '99');

    const state = worker.loadCollectorState();
    // Linked, but not yet monitored: the binding exists and is disabled, so
    // the collector state (enabled bindings only) is still empty.
    assert.equal(state.bindings.length, 0);

    const monitored = worker.setMonitored({ siteIds: ['afdc-200948'], enabled: true });
    assert.equal(monitored.enabledCount, 1, JSON.stringify(monitored));
    const after = worker.loadCollectorState();
    assert.equal(after.bindings.length, 1);
    const binding = after.bindings[0];
    assert.equal(binding?.sourceStationId, '11502161');
    assert.equal(binding?.canonicalUrl, 'https://driver.chargepoint.com/stations/11502161');
    assert.equal(binding?.granularity, CAPABILITIES.observationGranularity);
    assert.equal(binding?.identityReliability, CAPABILITIES.identityReliability);
    assert.equal(after.queue.length, 1, 'a newly monitored site is due now');
    await worker.close();
  });

  test('running discovery again links nothing twice', async () => {
    const worker = await openWorker('rerun');
    seedCatalog(worker, [site('afdc-200948', 'BANNER HEALTH BAYWOOD 1', 33.410957, -111.68973)]);
    const first = worker.bindDiscoveredStations({ stations: [discoveredBaywood1] });
    const second = worker.bindDiscoveredStations({ stations: [discoveredBaywood1] });
    assert.equal(first.linked, 1);
    assert.equal(second.linked, 0);
    assert.equal(second.alreadyLinked, 1);
    await worker.close();
  });

  test('a site the user already linked by hand is never re-pointed', async () => {
    const worker = await openWorker('manual');
    seedCatalog(worker, [site('afdc-200948', 'BANNER HEALTH BAYWOOD 1', 33.410957, -111.68973)]);
    const manual = worker.addManualLink({
      siteId: 'afdc-200948',
      url: 'https://driver.chargepoint.com/stations/424242',
    });
    assert.equal(manual.ok, true, manual.detail ?? '');
    const result = worker.bindDiscoveredStations({ stations: [discoveredBaywood1] });
    assert.equal(result.linked, 0);
    assert.equal(result.siteConflicts, 1);
    assert.equal(
      worker.sourceUrlForSite({ siteId: 'afdc-200948' }).url,
      'https://driver.chargepoint.com/stations/424242',
    );
    await worker.close();
  });

  test('"monitor everything linked" reaches exactly the linked sites', async () => {
    const worker = await openWorker('all');
    seedCatalog(worker, [
      site('afdc-200948', 'BANNER HEALTH BAYWOOD 1', 33.410957, -111.68973),
      site('afdc-200947', 'BANNER HEALTH BAYWOOD 2', 33.410954, -111.68979),
      site('afdc-1', 'NOT A CHARGEPOINT SITE', 33.5, -111.9),
    ]);
    worker.bindDiscoveredStations({
      stations: [
        discoveredBaywood1,
        {
          ...discoveredBaywood1,
          sourceStationId: '11502162',
          name: 'BANNER HEALTH BAYWOOD 2',
          latitude: 33.410954,
          longitude: -111.68979,
          canonicalUrl: 'https://driver.chargepoint.com/stations/11502162',
        },
      ],
    });
    const linked = worker.linkedSiteIds();
    assert.deepEqual(linked, ['afdc-200947', 'afdc-200948']);
    const monitored = worker.setMonitored({ siteIds: linked, enabled: true });
    assert.equal(monitored.enabledCount, 2);
    assert.equal(worker.loadCollectorState().bindings.length, 2);
    await worker.close();
  });
});

// ---------------------------------------------------------------------------
// The bundled catalog import
// ---------------------------------------------------------------------------

describe('importing the bundled catalog', () => {
  const catalogDir = join(process.cwd(), 'resources', 'catalog');

  test('loads the shipped file once, and is a no-op on the next start', async () => {
    const worker = await openWorker('catalog');
    const first = worker.importCatalogFile({
      filePath: join(catalogDir, 'mesa-stations.json'),
      provenancePath: join(catalogDir, 'provenance.json'),
    });
    assert.equal(first.reason, 'imported', first.detail ?? '');
    assert.equal(first.sites, 1083, 'every shipped location is imported');
    assert.equal(first.inserted, 1083);
    assert.equal(first.conflicts, 0);
    assert.equal(worker.counts().catalogSites, 1083);

    const second = worker.importCatalogFile({
      filePath: join(catalogDir, 'mesa-stations.json'),
      provenancePath: join(catalogDir, 'provenance.json'),
    });
    assert.equal(second.reason, 'already_imported');
    assert.equal(second.imported, false);
    assert.equal(worker.counts().catalogSites, 1083, 'nothing is duplicated');
    await worker.close();
  });

  test('a missing or malformed file is reported, never half-imported', async () => {
    const worker = await openWorker('catalog-bad');
    const missing = worker.importCatalogFile({
      filePath: join(scratch, 'does-not-exist.json'),
      provenancePath: null,
    });
    assert.equal(missing.reason, 'missing');

    const badPath = join(scratch, 'bad-catalog.json');
    writeFileSync(badPath, JSON.stringify({ formatVersion: 2, sites: 'nope' }));
    const invalid = worker.importCatalogFile({ filePath: badPath, provenancePath: null });
    assert.equal(invalid.reason, 'invalid');
    assert.equal(worker.counts().catalogSites, 0);
    await worker.close();
  });

  test('a station captured live on 2026-09-21 links to its row in the shipped catalog', async () => {
    // BAYWOOD 1 with the coordinates the provider lists; the second entry is a
    // rough position and is only here to show a non-match does no harm.
    const worker = await openWorker('catalog-link');
    worker.importCatalogFile({
      filePath: join(catalogDir, 'mesa-stations.json'),
      provenancePath: join(catalogDir, 'provenance.json'),
    });
    const result = worker.bindDiscoveredStations({
      stations: [
        discoveredBaywood1,
        {
          ...discoveredBaywood1,
          sourceStationId: '17560121',
          name: 'CHAPMAN FORD POWER LINK S',
          streetAddress: '3950 North 89th Street',
          city: 'Scottsdale',
          latitude: 33.4907,
          longitude: -111.8873,
          canonicalUrl: 'https://driver.chargepoint.com/stations/17560121',
        },
      ],
    });
    assert.ok(result.linked >= 1, JSON.stringify(result));
    assert.equal(
      worker.sourceUrlForSite({ siteId: 'afdc-200948' }).url,
      discoveredBaywood1.canonicalUrl,
    );
    await worker.close();
  });
});
