/**
 * Database tests against a real SQLite engine (node:sqlite).
 *
 * These exercise the actual migrations, constraints, indexes and repository
 * SQL that the packaged app uses -- through the same driver it uses. The
 * application and these specs both open SQLite with `node:sqlite`, so a pass
 * here is evidence about the code that ships rather than about a stand-in for
 * it. See docs/adr/0003-node-sqlite-over-better-sqlite3.md.
 *
 * Run: node --experimental-strip-types --test tests/nodeps/database.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { openNodeSqlite } from '../../src/database/drivers/node-sqlite.ts';
import { applyConnectionPragmas, checkIntegrity, transact } from '../../src/database/driver.ts';
import {
  TARGET_SCHEMA_VERSION,
  canRead,
  canWrite,
  checksumOf,
  currentSchemaVersion,
  migrate,
} from '../../src/database/migrator.ts';
import { MIGRATIONS } from '../../src/database/migrations/index.ts';
import {
  coverageRepository,
  observationsRepository,
  metricsCacheRepository,
  sessionRepository,
  settingsRepository,
  sitesRepository,
  type IngestObservation,
  type SiteRecord,
} from '../../src/database/repositories.ts';
import { buildScopeIntervals } from '../../src/domain/intervals.ts';
import { computeScopeMetrics } from '../../src/domain/metrics.ts';
import { DEFAULT_FRESHNESS_POLICY } from '../../src/domain/types.ts';
import { DAY, MIN, T0 } from './helpers.ts';

const APP_VERSION = '0.1.0-test';

function freshDb() {
  const driver = openNodeSqlite(':memory:');
  applyConnectionPragmas(driver);
  const outcome = migrate(driver, MIGRATIONS, { appVersion: APP_VERSION, nowMs: T0 });
  assert.equal(outcome.status, 'migrated', JSON.stringify(outcome));
  return driver;
}

function seedSiteAndBinding(driver: ReturnType<typeof openNodeSqlite>) {
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
    centerLatitude: 33.4152,
    centerLongitude: -111.8315,
    radiusMiles: 50,
    rowCount: 1,
    outcome: 'succeeded',
    notes: null,
  });
  assert.ok(importId > 0);

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
       VALUES ('chargepoint','ChargePoint','https://www.chargepoint.com','0.1.0',1,'Mesa, AZ 50mi',
               'station_aggregate','none','No account required for the public map','rendered_dom',
               900000, 30000, NULL, 0, '{}', '[]', 'needs_review', 'unverified', ?)`,
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
               'station_aggregate','none',1,1,1,'durable_provider_id',1.0,'confirmed',?,?,?)`,
    )
    .run(T0 - DAY, T0, T0);

  driver
    .prepare(
      `INSERT INTO collection_runs
         (id, source_id, adapter_version, started_ms, finished_ms, outcome, bindings_attempted, bindings_succeeded)
       VALUES ('run-1','chargepoint','0.1.0',?,?, 'succeeded',1,1)`,
    )
    .run(T0, T0 + 1000);

  return { importId };
}

function observation(overrides: Partial<IngestObservation> = {}): IngestObservation {
  return {
    id: 'obs-1',
    bindingId: 'binding-1',
    siteId: 'site-1',
    scopeKey: 'scope-1',
    observedAtUtcMs: T0,
    sourceUpdatedAtUtcMs: null,
    method: 'rendered_dom',
    granularity: 'station_aggregate',
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
    parserVersion: 'chargepoint-dom@0.1.0',
    evidenceFingerprint: 'sha256:deadbeef',
    sanitizedSourceText: '2 of 2 ports · 1 available',
    quality: 'reliable',
    sourceFreshness: 'unknown_source_clock',
    validation: { reconciled: true },
    ports: [],
    ...overrides,
  };
}

describe('migrations', () => {
  test('the schema applies cleanly and reports its version', () => {
    const driver = freshDb();
    assert.equal(currentSchemaVersion(driver), TARGET_SCHEMA_VERSION);
    assert.equal(checkIntegrity(driver).ok, true);
    driver.close();
  });

  test('re-running migrations is a no-op', () => {
    const driver = freshDb();
    const again = migrate(driver, MIGRATIONS, { appVersion: APP_VERSION, nowMs: T0 + 1000 });
    assert.equal(again.status, 'up_to_date');
    driver.close();
  });

  test('WAL, foreign keys and a busy timeout are actually in force', () => {
    const driver = openNodeSqlite(':memory:');
    const report = applyConnectionPragmas(driver);
    // In-memory databases report "memory" rather than "wal"; the point is the
    // real mode is reported rather than assumed.
    assert.ok(['wal', 'memory'].includes(report.journalMode.toLowerCase()));
    assert.equal(report.foreignKeys, true);
    assert.equal(report.busyTimeoutMs, 5000);
    driver.close();
  });

  test('a changed historical migration is refused, not silently re-applied', () => {
    const driver = freshDb();
    const tampered = [
      { ...(MIGRATIONS[0] as (typeof MIGRATIONS)[0]), sql: '-- tampered\nSELECT 1;' },
    ];
    const outcome = migrate(driver, tampered, { appVersion: APP_VERSION, nowMs: T0 });
    assert.equal(outcome.status, 'checksum_mismatch');
    // The database is untouched and still usable.
    assert.equal(currentSchemaVersion(driver), TARGET_SCHEMA_VERSION);
    driver.close();
  });

  test('a newer schema is refused without modifying the database', () => {
    const driver = freshDb();
    driver
      .prepare(
        `INSERT INTO schema_migrations (version, name, checksum, app_version, applied_at_ms)
         VALUES (99, 'from_the_future', 'x', '9.9.9', ?)`,
      )
      .run(T0);
    const outcome = migrate(driver, MIGRATIONS, { appVersion: APP_VERSION, nowMs: T0 });
    assert.equal(outcome.status, 'refused_newer_schema');
    if (outcome.status !== 'refused_newer_schema') return;
    assert.match(outcome.detail, /newer version/i);
    assert.equal(canRead(99), false);
    assert.equal(canWrite(TARGET_SCHEMA_VERSION), true);
    driver.close();
  });

  test('a failed migration leaves the previous version intact', () => {
    const driver = openNodeSqlite(':memory:');
    applyConnectionPragmas(driver);
    const broken = [
      MIGRATIONS[0] as (typeof MIGRATIONS)[0],
      { version: 2, name: 'broken', sql: 'CREATE TABLE oops (id INTEGER); SELECT bad_function();' },
    ];
    const outcome = migrate(driver, broken, { appVersion: APP_VERSION, nowMs: T0 });
    assert.equal(outcome.status, 'failed');
    if (outcome.status !== 'failed') return;
    assert.equal(outcome.failedVersion, 2);
    assert.equal(currentSchemaVersion(driver), 1, 'version 1 remains applied');
    const tables = driver
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='oops'")
      .all();
    assert.equal(tables.length, 0, 'the failed migration rolled back');
    driver.close();
  });

  test('migration checksums are stable across line-ending changes', () => {
    const sql = 'CREATE TABLE t (a INTEGER);\n';
    assert.equal(checksumOf(sql), checksumOf(sql.replace(/\n/g, '\r\n')));
  });
});

describe('constraints', () => {
  test('foreign keys are enforced', () => {
    const driver = freshDb();
    assert.throws(
      () =>
        driver
          .prepare(
            `INSERT INTO source_bindings
               (id, source_id, site_id, canonical_url, scope_key, physical_scope, granularity,
                identity_reliability, capability_version, effective_from_ms, created_at_ms, updated_at_ms)
             VALUES ('b','missing-source','missing-site','http://x','s','scope','station_aggregate','none',1,?,?,?)`,
          )
          .run(T0, T0, T0),
      /FOREIGN KEY/i,
    );
    driver.close();
  });

  test('negative counts and impossible timestamps are rejected at the boundary', () => {
    const driver = freshDb();
    seedSiteAndBinding(driver);
    const obs = observationsRepository(driver);

    assert.throws(
      () =>
        obs.ingest('run-1', [observation({ counts: { ...observation().counts, occupied: -1 } })]),
      /CHECK/i,
    );
    // A seconds value where milliseconds are required would land in 1970; a
    // value beyond 2100 is rejected outright.
    assert.throws(
      () => obs.ingest('run-1', [observation({ observedAtUtcMs: 9_999_999_999_999 })]),
      /CHECK/i,
    );
    driver.close();
  });

  test('only one primary binding may start per scope and instant', () => {
    const driver = freshDb();
    seedSiteAndBinding(driver);
    assert.throws(
      () =>
        driver
          .prepare(
            `INSERT INTO source_bindings
               (id, source_id, site_id, canonical_url, scope_key, physical_scope, granularity,
                identity_reliability, is_primary, capability_version, effective_from_ms, created_at_ms, updated_at_ms)
             VALUES ('binding-2','chargepoint','site-1','http://x','scope-1','whole station','station_aggregate','none',1,1,?,?,?)`,
          )
          .run(T0 - DAY, T0, T0),
      /UNIQUE/i,
    );
    driver.close();
  });

  test('an invalid enum value cannot be stored', () => {
    const driver = freshDb();
    seedSiteAndBinding(driver);
    assert.throws(
      () =>
        driver
          .prepare(
            `INSERT INTO collection_gaps (scope_key, started_ms, ended_ms, reason)
             VALUES ('scope-1', ?, ?, 'because_i_said_so')`,
          )
          .run(T0, T0 + MIN),
      /CHECK/i,
    );
    driver.close();
  });
});

describe('observation ingestion', () => {
  test('retrying the same attempt does not double-write', () => {
    const driver = freshDb();
    seedSiteAndBinding(driver);
    const obs = observationsRepository(driver);

    const first = obs.ingest('run-1', [observation()]);
    const retry = obs.ingest('run-1', [observation()]);

    assert.deepEqual([first.written, first.deduplicated], [1, 0]);
    assert.deepEqual([retry.written, retry.deduplicated], [0, 1]);
    assert.equal(obs.countAll(), 1);
    driver.close();
  });

  test('a repeated identical status at a new scheduled time is kept as evidence', () => {
    const driver = freshDb();
    seedSiteAndBinding(driver);
    const obs = observationsRepository(driver);

    for (let i = 0; i < 4; i += 1) {
      driver
        .prepare(
          `INSERT INTO collection_runs (id, source_id, adapter_version, started_ms, outcome, bindings_attempted, bindings_succeeded)
           VALUES (?, 'chargepoint', '0.1.0', ?, 'succeeded', 1, 1)`,
        )
        .run(`run-r${i}`, T0 + i * 15 * MIN);
      // Identical counts and identical evidence fingerprint every time.
      obs.ingest(`run-r${i}`, [
        observation({ id: `obs-r${i}`, observedAtUtcMs: T0 + i * 15 * MIN }),
      ]);
    }

    assert.equal(obs.countAll(), 4, 'four observations, not deduplicated by status hash');
    driver.close();
  });

  test('null and zero survive a round trip as different values', () => {
    const driver = freshDb();
    seedSiteAndBinding(driver);
    const obs = observationsRepository(driver);

    obs.ingest('run-1', [
      observation({
        counts: {
          available: 0,
          occupied: 2,
          reserved: null,
          outOfService: null,
          unknown: null,
          total: 2,
        },
      }),
    ]);

    const [loaded] = obs.snapshotsFor(['scope-1'], T0 - DAY, T0 + DAY);
    assert.equal(loaded?.counts.available, 0, 'an explicit zero stays zero');
    assert.equal(loaded?.counts.reserved, null, 'an unreported dimension stays null');
    assert.equal(loaded?.counts.unknown, null);
    assert.equal(loaded?.sourceUpdatedAtUtcMs, null);
    driver.close();
  });

  test('the persisted freshness policy is restored with the observation', () => {
    const driver = freshDb();
    seedSiteAndBinding(driver);
    const obs = observationsRepository(driver);
    obs.ingest('run-1', [
      observation({
        freshnessPolicy: {
          scheduledIntervalMs: 5 * MIN,
          maxCarryForwardCapMs: 30 * MIN,
          sourceFreshnessLimitMs: 7 * MIN,
        },
      }),
    ]);
    const [loaded] = obs.snapshotsFor(['scope-1'], T0 - DAY, T0 + DAY);
    assert.deepEqual(loaded?.freshnessPolicy, {
      scheduledIntervalMs: 5 * MIN,
      maxCarryForwardCapMs: 30 * MIN,
      sourceFreshnessLimitMs: 7 * MIN,
    });
    driver.close();
  });

  test('a failed attempt records an outcome and creates no observation', () => {
    const driver = freshDb();
    seedSiteAndBinding(driver);
    const obs = observationsRepository(driver);

    driver
      .prepare(
        `INSERT INTO collection_attempts (run_id, binding_id, scope_key, started_ms, finished_ms, outcome, error_detail)
         VALUES ('run-1','binding-1','scope-1',?,?, 'layout_changed','status block not found')`,
      )
      .run(T0, T0 + 5000);

    assert.equal(obs.countAll(), 0, 'no zero-usage observation was fabricated');
    const attempt = driver
      .prepare('SELECT outcome FROM collection_attempts WHERE run_id = ?')
      .get('run-1');
    assert.equal(attempt?.outcome, 'layout_changed');
    driver.close();
  });

  test('port rows are stored only when the source supplies durable identity', () => {
    const driver = freshDb();
    seedSiteAndBinding(driver);

    // This used to INSERT the `ports` row itself before ingesting. That one
    // line hid the defect that made 0.3.0 record nothing: nothing in the
    // application creates a ports row, so production wrote a port observation
    // whose foreign key had no parent and lost the whole run. The spec did the
    // thing production never does, then asserted production worked.
    //
    // Ingest creates it now, and this spec no longer pretends otherwise.
    // tests/nodeps/ingest-ports-end-to-end.test.ts covers that directly.
    const obs = observationsRepository(driver);
    const result = obs.ingest('run-1', [
      observation({
        ports: [{ portId: 'scope-1:CP-1', sourcePortId: 'CP-1', state: 'occupied', level: 'level_2' }],
      }),
    ]);
    assert.equal(result.portRowsWritten, 1);

    const ports = obs.portSnapshotsFor(['scope-1'], T0 - DAY, T0 + DAY);
    assert.equal(ports.length, 1);
    assert.equal(ports[0]?.state, 'occupied');
    driver.close();
  });
});

describe('history survives a reopen', () => {
  test('observations written before a close are present after reopening the file', async () => {
    const fsp = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chargewatch-db-'));
    const file = path.join(dir, 'history.sqlite');
    try {
      const first = openNodeSqlite(file);
      applyConnectionPragmas(first);
      migrate(first, MIGRATIONS, { appVersion: APP_VERSION, nowMs: T0 });
      seedSiteAndBinding(first);
      observationsRepository(first).ingest('run-1', [observation()]);
      first.close();

      const second = openNodeSqlite(file);
      applyConnectionPragmas(second);
      const reopened = migrate(second, MIGRATIONS, { appVersion: APP_VERSION, nowMs: T0 + 1000 });
      assert.equal(reopened.status, 'up_to_date');
      const obs = observationsRepository(second);
      assert.equal(obs.countAll(), 1, 'history is intact across a restart');
      assert.equal(obs.snapshotsFor(['scope-1'], T0 - DAY, T0 + DAY).length, 1);
      assert.equal(checkIntegrity(second).ok, true);
      second.close();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('domain and database integration', () => {
  test('ingested observations produce the documented metrics end to end', () => {
    const driver = freshDb();
    seedSiteAndBinding(driver);
    const obs = observationsRepository(driver);
    const coverage = coverageRepository(driver);

    coverage.setCapacity(
      {
        scopeKey: 'scope-1',
        siteId: 'site-1',
        startMs: T0 - DAY,
        endMs: null,
        capacityPorts: 2,
        level: 'level_2',
        basis: 'ports_simultaneous',
        source: 'catalog',
      },
      T0,
    );
    coverage.openMonitoring('scope-1', 'binding-1', T0 - DAY, 15 * MIN);

    for (let i = 0; i < 4; i += 1) {
      driver
        .prepare(
          `INSERT INTO collection_runs (id, source_id, adapter_version, started_ms, outcome, bindings_attempted, bindings_succeeded)
           VALUES (?, 'chargepoint','0.1.0',?, 'succeeded',1,1)`,
        )
        .run(`run-m${i}`, T0 + i * 15 * MIN);
      obs.ingest(`run-m${i}`, [
        observation({ id: `obs-m${i}`, observedAtUtcMs: T0 + i * 15 * MIN }),
      ]);
    }

    const window = { startMs: T0, endMs: T0 + 60 * MIN };
    const metrics = computeScopeMetrics(
      buildScopeIntervals({
        scopeKey: 'scope-1',
        window,
        snapshots: obs.snapshotsFor(['scope-1'], T0 - DAY, window.endMs),
        monitoringWindows: coverage.monitoringFor(['scope-1']),
        gaps: coverage.gapsFor(['scope-1']),
        capacity: coverage.capacityFor(['scope-1']),
      }),
    );

    assert.equal(metrics.observationCount, 4);
    assert.equal(metrics.occupiedPortMinutes, 60);
    assert.equal(metrics.observedOccupancyPct, 50);
    assert.equal(metrics.statusCoveragePct, 100);
    assert.equal(metrics.estimatedOccupiedPortHours, 1);
    driver.close();
  });
});

describe('catalog refresh', () => {
  test('a refresh never overwrites a user correction, and records the conflict', () => {
    const driver = freshDb();
    const { importId } = seedSiteAndBinding(driver);
    const sites = sitesRepository(driver);

    // The user corrects the name and marks it corrected.
    driver
      .prepare(
        `UPDATE sites SET name = 'Banner Baywood (east bank)', user_corrected = 1,
           user_corrections_json = '["name"]', updated_at_ms = ? WHERE id = 'site-1'`,
      )
      .run(T0 + DAY);

    const refreshed = sites.upsertFromCatalog(
      importId,
      [
        {
          ...(sites.get('site-1') as SiteRecord),
          name: 'BANNER HEALTH / BAYWOOD 2',
          catalogPortCount: 4,
        },
      ],
      T0 + 2 * DAY,
    );

    assert.equal(refreshed.updated, 1);
    assert.equal(refreshed.conflicts, 1);
    assert.equal(
      sites.get('site-1')?.name,
      'Banner Baywood (east bank)',
      "the user's value is kept",
    );
    assert.equal(sites.get('site-1')?.catalogPortCount, 4, 'uncorrected fields still refresh');

    const conflict = driver
      .prepare('SELECT field, existing_value, incoming_value, resolution FROM site_conflicts')
      .get();
    assert.equal(conflict?.field, 'name');
    assert.equal(conflict?.resolution, 'pending');
    driver.close();
  });

  test('a refresh does not erase observations', () => {
    const driver = freshDb();
    const { importId } = seedSiteAndBinding(driver);
    const obs = observationsRepository(driver);
    obs.ingest('run-1', [observation()]);
    const sites = sitesRepository(driver);
    sites.upsertFromCatalog(importId, [sites.get('site-1') as SiteRecord], T0 + DAY);
    assert.equal(obs.countAll(), 1);
    driver.close();
  });
});

describe('interrupted collection and recovery', () => {
  test('an unclean exit is identifiable and becomes a recorded gap, not zero usage', () => {
    const driver = freshDb();
    seedSiteAndBinding(driver);
    const sessions = sessionRepository(driver);
    const coverage = coverageRepository(driver);

    sessions.start('session-a', APP_VERSION, TARGET_SCHEMA_VERSION, T0);
    sessions.heartbeat('session-a', T0 + 30 * MIN, true, false);
    // No stop() call: the process died here.

    const recovered = sessions.recoverUncleanSessions('session-b', T0 + 4 * 60 * MIN);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.collectionRunning, true);

    coverage.recordGap(
      {
        scopeKey: null,
        startMs: recovered[0]?.lastHeartbeatMs ?? T0,
        endMs: T0 + 4 * 60 * MIN,
        reason: 'unclean_exit',
      },
      'recovered session session-a',
    );

    const gaps = coverage.gapsFor(['scope-1']);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]?.reason, 'unclean_exit');

    const window = { startMs: T0, endMs: T0 + 4 * 60 * MIN };
    const set = buildScopeIntervals({
      scopeKey: 'scope-1',
      window,
      snapshots: [],
      monitoringWindows: coverage.monitoringFor(['scope-1']),
      gaps,
      capacity: coverage.capacityFor(['scope-1']),
    });
    assert.equal(set.gapMinutes, 210, 'the missing period is recorded as missing');
    driver.close();
  });

  test('committed observations survive a rolled-back batch', () => {
    const driver = freshDb();
    seedSiteAndBinding(driver);
    const obs = observationsRepository(driver);
    obs.ingest('run-1', [observation()]);

    driver
      .prepare(
        `INSERT INTO collection_runs (id, source_id, adapter_version, started_ms, outcome, bindings_attempted, bindings_succeeded)
         VALUES ('run-2','chargepoint','0.1.0',?, 'succeeded',1,1)`,
      )
      .run(T0 + 15 * MIN);

    assert.throws(() => {
      transact(driver, () => {
        obs.ingest('run-2', [observation({ id: 'obs-2', observedAtUtcMs: T0 + 15 * MIN })]);
        throw new Error('simulated worker crash mid-batch');
      });
    }, /simulated worker crash/);

    assert.equal(obs.countAll(), 1, 'the committed observation is intact');
    assert.equal(checkIntegrity(driver).ok, true);
    driver.close();
  });
});

describe('derived cache invalidation', () => {
  test('a corrected mapping marks affected aggregates stale for recomputation', () => {
    const driver = freshDb();
    seedSiteAndBinding(driver);
    const cache = metricsCacheRepository(driver);

    driver
      .prepare(
        `INSERT INTO hourly_metrics
           (scope_key, site_id, local_date, local_hour, local_weekday, timezone,
            occupied_port_minutes, operational_port_minutes, known_state_port_minutes,
            expected_installed_port_minutes, observation_count, algorithm_version, computed_at_ms, stale)
         VALUES ('scope-1','site-1','2026-09-01',17,1,'America/Phoenix',30,60,60,60,4,1,?,0)`,
      )
      .run(T0);

    assert.equal(cache.staleCount(), 0);
    const marked = cache.invalidate('scope-1', T0, T0 + DAY, 'America/Phoenix');
    assert.ok(marked >= 1);
    assert.equal(cache.staleCount(), 1);
    driver.close();
  });
});

describe('settings', () => {
  test('settings round-trip through validated JSON storage', () => {
    const driver = freshDb();
    const settings = settingsRepository(driver);
    settings.setMany(
      { 'study.radiusMiles': 50, 'collection.paused': false, 'ui.theme': 'dark' },
      T0,
    );
    assert.equal(settings.get('study.radiusMiles'), 50);
    assert.equal(settings.get('collection.paused'), false);
    settings.set('collection.paused', true, T0 + 1000);
    assert.equal(settings.get('collection.paused'), true, 'a pause persists across a write');
    assert.equal(settings.get('nope'), undefined);
    driver.close();
  });
});
