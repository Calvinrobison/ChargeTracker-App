/**
 * A real ingest, carrying ports, through the real schema — with nothing
 * pre-seeded that production does not create for itself.
 *
 * v0.3.0 shipped able to collect and unable to record. Every run completed,
 * every run failed to persist, and the log repeated
 * "failed to persist collection run" every ~30 seconds while
 * "Observations stored" sat at 0.
 *
 * Four things combined, and only in 0.3.0:
 *
 *   1. port_observations.port_id is `NOT NULL REFERENCES ports (id)`
 *   2. every connection runs `PRAGMA foreign_keys = ON`
 *   3. the collector synthesises `portId` as `${scopeKey}:${sourcePortId}`
 *   4. nothing in the codebase has ever INSERTed a row into `ports`
 *
 * So ingest wrote a port_observations row pointing at a ports row that did not
 * exist, the foreign key rejected it, and because the insert sits inside the
 * run transaction in DatabaseWorker.ingestRun, the whole run rolled back — run,
 * attempts, observations, all of it. Earlier versions recorded nothing at all,
 * so the defect had nothing to fire on until ChargePoint gained
 * granularity:'port' and identityReliability:'durable'.
 *
 * It survived 507 specs, 48 UI specs and a 16/16 installed self-check. The
 * spec that was supposed to cover this — "port rows are stored only when the
 * source supplies durable identity" — opens by INSERTing the ports row itself:
 *
 *     INSERT INTO ports (id, scope_key, site_id, source_port_id, ...)
 *     VALUES ('port-1','scope-1','site-1','CP-1','level_2',?,?,0)
 *
 * That one line is the whole blind spot. The test did the thing production
 * never does, then asserted production worked.
 *
 * So the rule here: **seed only what a real installation would already have** —
 * a catalog site, a source, a binding — and let ingest create everything a
 * collection run creates. Anything a spec has to insert by hand to make the
 * code under test succeed is a thing production must also do, and is worth
 * checking that it does.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { openNodeSqlite } from '../../src/database/drivers/node-sqlite.ts';
import { applyConnectionPragmas } from '../../src/database/driver.ts';
import { migrate } from '../../src/database/migrator.ts';
import { MIGRATIONS } from '../../src/database/migrations/index.ts';
import {
  observationsRepository,
  sitesRepository,
  type IngestObservation,
  type SiteRecord,
} from '../../src/database/repositories.ts';
import { DEFAULT_FRESHNESS_POLICY } from '../../src/domain/types.ts';
import { DAY, T0 } from './helpers.ts';

const APP_VERSION = '0.3.1-test';

function freshDb() {
  const driver = openNodeSqlite(':memory:');
  applyConnectionPragmas(driver);
  const outcome = migrate(driver, MIGRATIONS, { appVersion: APP_VERSION, nowMs: T0 });
  assert.equal(outcome.status, 'migrated', JSON.stringify(outcome));
  return driver;
}

/**
 * Exactly what an installation has before its first collection run: a catalog
 * site, a registered source and an enabled binding. No ports row — creating
 * one is the behaviour under test.
 */
function seedInstallation(driver: ReturnType<typeof openNodeSqlite>) {
  const sites = sitesRepository(driver);
  const importId = sites.recordCatalogImport({
    sourceName: 'AFDC alternative fuel stations',
    sourceUrl: 'https://afdc.energy.gov/data_download',
    retrievedAtMs: T0 - DAY,
    importedAtMs: T0,
    license: 'Public domain with attribution',
    attribution: 'U.S. DOE Alternative Fuels Data Center',
    fileSha256: 'b'.repeat(64),
    fieldMapping: { station_name: 'name' },
    centerLatitude: 33.4152,
    centerLongitude: -111.8315,
    radiusMiles: 50,
    rowCount: 1,
    outcome: 'succeeded',
    notes: null,
  });

  const site: SiteRecord = {
    id: 'site-1',
    registryStationId: '1001',
    name: 'Banner Health Baywood 2',
    streetAddress: '6644 E Baywood Ave',
    city: 'Mesa',
    state: 'AZ',
    postalCode: '85206',
    normalizedAddress: '6644 e baywood ave mesa az',
    latitude: 33.3891,
    longitude: -111.6996,
    distanceMiles: 7.6,
    network: 'ChargePoint',
    accessCondition: 'public',
    hoursText: '24 hours daily',
    timezone: 'America/Phoenix',
    catalogPortCount: 2,
    catalogLevel: 'level_2',
  };
  sites.upsertFromCatalog(importId, [site], T0);

  driver
    .prepare(
      `INSERT INTO sources
         (id, display_name, website_url, adapter_version, capability_version, supported_region,
          observation_granularity, identity_reliability, access_requirements, collection_method,
          min_interval_ms, min_navigation_interval_ms, source_freshness_limit_ms,
          distinguishes_charging, state_meanings_json, terms_urls_json, eligibility_state,
          verification_state, updated_at_ms)
       VALUES ('chargepoint','ChargePoint','https://www.chargepoint.com','0.3.0',1,'Mesa, AZ 50mi',
               'port','durable','No account required for the public map','rendered_dom',
               900000, 30000, NULL, 0, '{}', '[]', 'enabled', 'verified', ?)`,
    )
    .run(T0);

  driver
    .prepare(
      `INSERT INTO source_bindings
         (id, source_id, site_id, source_station_id, canonical_url, scope_key, physical_scope,
          granularity, identity_reliability, is_primary, enabled, capability_version,
          match_basis, match_confidence, match_disposition, effective_from_ms,
          created_at_ms, updated_at_ms)
       VALUES ('binding-1','chargepoint','site-1','11502081',
               'https://driver.chargepoint.com/stations/11502081','scope-1','whole station',
               'port','durable',1,1,1,'durable_provider_id',1.0,'confirmed',?,?,?)`,
    )
    .run(T0 - DAY, T0, T0);

  driver
    .prepare(
      `INSERT INTO collection_runs
         (id, source_id, adapter_version, started_ms, finished_ms, outcome, bindings_attempted, bindings_succeeded)
       VALUES ('run-1','chargepoint','0.3.0',?,?, 'succeeded',1,1)`,
    )
    .run(T0, T0 + 1000);
}

/**
 * The shape the collector actually produces: `portId` synthesised as
 * `${scopeKey}:${sourcePortId}` (src/collector/service.ts).
 */
function observationWithPorts(overrides: Partial<IngestObservation> = {}): IngestObservation {
  return {
    id: 'obs-1',
    bindingId: 'binding-1',
    siteId: 'site-1',
    scopeKey: 'scope-1',
    observedAtUtcMs: T0,
    sourceUpdatedAtUtcMs: null,
    method: 'rendered_dom',
    granularity: 'port',
    counts: {
      available: 1,
      occupied: 1,
      reserved: null,
      outOfService: null,
      unknown: null,
      total: 2,
    },
    capacityBasis: 'ports_simultaneous',
    completeness: 'complete',
    level: 'level_2',
    distinguishesCharging: false,
    freshnessPolicy: DEFAULT_FRESHNESS_POLICY,
    sourceUrl: 'https://driver.chargepoint.com/stations/11502081',
    parserVersion: 'chargepoint-dom@0.3.0',
    evidenceFingerprint: 'sha256:deadbeef',
    sanitizedSourceText: '2 of 2 ports · 1 available',
    quality: 'reliable',
    sourceFreshness: 'unknown_source_clock',
    validation: { reconciled: true },
    ports: [
      { portId: 'scope-1:1', sourcePortId: '1', state: 'available', level: 'level_2' },
      { portId: 'scope-1:2', sourcePortId: '2', state: 'occupied', level: 'level_2' },
    ],
    ...overrides,
  };
}

describe('an observation carrying ports is actually persisted', () => {
  test('ingest writes the observation AND its port rows, with no ports row pre-seeded', () => {
    const driver = freshDb();
    seedInstallation(driver);
    const obs = observationsRepository(driver);

    const result = obs.ingest('run-1', [observationWithPorts()]);

    assert.equal(result.written, 1, 'the observation itself must land');
    assert.equal(result.portRowsWritten, 2, 'both port rows must land');
    assert.equal(obs.countAll(), 1);

    const ports = obs.portSnapshotsFor(['scope-1'], T0 - DAY, T0 + DAY);
    assert.equal(ports.length, 2);
    assert.deepEqual(
      ports.map((port) => port.state).sort(),
      ['available', 'occupied'],
      'per-port state must survive the round trip',
    );
  });

  test('creates the ports rows the observation references', () => {
    const driver = freshDb();
    seedInstallation(driver);
    observationsRepository(driver).ingest('run-1', [observationWithPorts()]);

    const rows = driver
      .prepare('SELECT id, scope_key, site_id, source_port_id, level FROM ports ORDER BY id')
      .all();

    assert.equal(rows.length, 2, 'nothing else in the application ever creates these');
    assert.equal(rows[0]?.id, 'scope-1:1');
    assert.equal(rows[0]?.scope_key, 'scope-1');
    assert.equal(rows[0]?.site_id, 'site-1');
    assert.equal(rows[0]?.source_port_id, '1');
    assert.equal(rows[0]?.level, 'level_2');
  });

  test('the whole run survives, because a rejected port row rolled everything back', () => {
    // The observed failure was not a missing port row: the foreign key
    // rejection aborted the enclosing transaction, so the run, its attempts
    // and the observation were all lost together.
    const driver = freshDb();
    seedInstallation(driver);
    const obs = observationsRepository(driver);

    obs.ingest('run-1', [observationWithPorts()]);

    const observations = driver.prepare('SELECT COUNT(*) AS n FROM observations').get();
    const portObservations = driver.prepare('SELECT COUNT(*) AS n FROM port_observations').get();
    assert.equal(Number(observations?.n), 1);
    assert.equal(Number(portObservations?.n), 2);
  });
});

describe('repeat observations keep per-port history continuous', () => {
  test('a second run reuses the same ports rows rather than creating more', () => {
    const driver = freshDb();
    seedInstallation(driver);
    const obs = observationsRepository(driver);

    obs.ingest('run-1', [observationWithPorts()]);

    driver
      .prepare(
        `INSERT INTO collection_runs
           (id, source_id, adapter_version, started_ms, finished_ms, outcome, bindings_attempted, bindings_succeeded)
         VALUES ('run-2','chargepoint','0.3.0',?,?, 'succeeded',1,1)`,
      )
      .run(T0 + 60_000, T0 + 61_000);

    const second = obs.ingest('run-2', [
      observationWithPorts({
        id: 'obs-2',
        observedAtUtcMs: T0 + 60_000,
        ports: [
          { portId: 'scope-1:1', sourcePortId: '1', state: 'occupied', level: 'level_2' },
          { portId: 'scope-1:2', sourcePortId: '2', state: 'occupied', level: 'level_2' },
        ],
      }),
    ]);

    assert.equal(second.portRowsWritten, 2);

    const portCount = driver.prepare('SELECT COUNT(*) AS n FROM ports').get();
    assert.equal(
      Number(portCount?.n),
      2,
      'a new ports row per run would fragment per-port history',
    );

    const snapshots = obs.portSnapshotsFor(['scope-1'], T0 - DAY, T0 + DAY);
    assert.equal(snapshots.length, 4, 'two ports observed twice');
  });

  test('last_seen_ms advances while first_seen_ms stays put', () => {
    const driver = freshDb();
    seedInstallation(driver);
    const obs = observationsRepository(driver);

    obs.ingest('run-1', [observationWithPorts()]);
    driver
      .prepare(
        `INSERT INTO collection_runs
           (id, source_id, adapter_version, started_ms, finished_ms, outcome, bindings_attempted, bindings_succeeded)
         VALUES ('run-2','chargepoint','0.3.0',?,?, 'succeeded',1,1)`,
      )
      .run(T0 + 60_000, T0 + 61_000);
    obs.ingest('run-2', [observationWithPorts({ id: 'obs-2', observedAtUtcMs: T0 + 60_000 })]);

    const row = driver
      .prepare('SELECT first_seen_ms, last_seen_ms FROM ports WHERE id = ?')
      .get('scope-1:1');

    assert.equal(Number(row?.first_seen_ms), T0, 'when this port was first observed');
    assert.equal(Number(row?.last_seen_ms), T0 + 60_000, 'when it was last observed');
  });

  test('an out-of-order observation does not drag last_seen_ms backwards', () => {
    const driver = freshDb();
    seedInstallation(driver);
    const obs = observationsRepository(driver);

    obs.ingest('run-1', [observationWithPorts({ observedAtUtcMs: T0 + 60_000 })]);
    driver
      .prepare(
        `INSERT INTO collection_runs
           (id, source_id, adapter_version, started_ms, finished_ms, outcome, bindings_attempted, bindings_succeeded)
         VALUES ('run-2','chargepoint','0.3.0',?,?, 'succeeded',1,1)`,
      )
      .run(T0, T0 + 1000);
    obs.ingest('run-2', [observationWithPorts({ id: 'obs-2', observedAtUtcMs: T0 })]);

    const row = driver
      .prepare('SELECT first_seen_ms, last_seen_ms FROM ports WHERE id = ?')
      .get('scope-1:1');

    assert.equal(Number(row?.first_seen_ms), T0, 'the earlier reading moves first_seen back');
    assert.equal(Number(row?.last_seen_ms), T0 + 60_000, 'but last_seen is the latest seen');
  });
});
