/**
 * The database worker: the SOLE owner of SQLite writes.
 *
 * Runs as an Electron utility process. Nothing else in the application opens
 * the database for writing — not the renderer, not the collector, not the main
 * process. The collector sends validated observation batches here; the
 * renderer sends read requests through main.
 *
 * Responsibilities: schema and migrations, ingestion, queries, calculation
 * jobs, exports, consistent backups, restore coordination and recovery.
 */

import { mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { applyConnectionPragmas, checkIntegrity, transact, type SqliteDriver } from './driver.ts';
import { MIGRATIONS } from './migrations/index.ts';
import { TARGET_SCHEMA_VERSION, currentSchemaVersion, migrate } from './migrator.ts';
import { QueryService } from './queries.ts';
import {
  coverageRepository,
  metricsCacheRepository,
  observationsRepository,
  sessionRepository,
  settingsRepository,
  sitesRepository,
  type IngestObservation,
} from './repositories.ts';
import { createBackup, performRestore, pruneBackups, validateRestoreCandidate } from './backup.ts';
import { csvLines, exportFileName, number, text, trusted } from '../shared/csv.ts';
import {
  columnIndex,
  parseCsv,
  parseIsoInstant,
  parseNonNegativeInteger,
} from '../shared/csv-read.ts';
import {
  COLLECTION_DEFAULTS,
  METRIC_ALGORITHM_VERSION,
  STUDY_AREA_DEFAULTS,
  STUDY_TIME_ZONE,
  VISIT_TEMPLATE_HEADERS,
  validateVisitRows,
  type ChargingLevel,
  type VisitObservation,
} from '../domain/index.ts';
import { isAllowedSourceUrl, stationIdFromUrl } from '../collector/adapters/chargepoint/index.ts';
import type { FilterState, WindowRequest } from '../shared/ipc.ts';
import type { RankSort } from '../domain/ranking.ts';

function asNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export interface DatabaseWorkerConfig {
  readonly databaseFile: string;
  readonly databaseDir: string;
  readonly backupsDir: string;
  readonly stagingDir: string;
  readonly appVersion: string;
  readonly timeZone: string;
  /** Injected so a test can substitute a driver; both use node:sqlite. */
  readonly openDriver: (path: string) => SqliteDriver;
  readonly nowMs?: () => number;
  /**
   * Optional, because the specs construct this worker directly and have no
   * channel to log to. Where it is absent, a swallowed failure stays swallowed
   * -- which is why the one place that swallows on purpose says so loudly in a
   * comment.
   */
  readonly log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export type DatabaseReadyState =
  | { readonly status: 'ready'; readonly schemaVersion: number; readonly journalMode: string }
  | {
      readonly status: 'migration_failed';
      readonly detail: string;
      readonly backupPath: string | null;
    }
  | { readonly status: 'schema_too_new'; readonly detail: string; readonly schemaVersion: number };

/**
 * Opens the database, recovers from an unclean exit, and migrates.
 *
 * Ordering is deliberate and matters for data safety:
 *   1. open and apply pragmas,
 *   2. identify an unclean exit and record the resulting gap,
 *   3. create and VERIFY a pre-migration backup,
 *   4. migrate,
 *   5. integrity check.
 *
 * Collection must not run during any of this; the caller does not start the
 * collector until this resolves `ready`.
 */
export class DatabaseWorker {
  private readonly config: DatabaseWorkerConfig;
  private driver: SqliteDriver | null = null;
  private queries: QueryService | null = null;
  private readonly sessionId = randomUUID();
  private readonly nowMs: () => number;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private restoreOrMigrationActive = false;

  constructor(config: DatabaseWorkerConfig) {
    this.config = config;
    this.nowMs = config.nowMs ?? (() => Date.now());
  }

  get isBusyWithMaintenance(): boolean {
    return this.restoreOrMigrationActive;
  }

  private requireDriver(): SqliteDriver {
    if (!this.driver) throw new Error('the database is not open');
    return this.driver;
  }

  private requireQueries(): QueryService {
    if (!this.queries) throw new Error('the database is not open');
    return this.queries;
  }

  async open(): Promise<DatabaseReadyState> {
    await mkdir(this.config.databaseDir, { recursive: true });
    await mkdir(this.config.backupsDir, { recursive: true });
    await mkdir(this.config.stagingDir, { recursive: true });

    const driver = this.config.openDriver(this.config.databaseFile);
    this.driver = driver;
    const pragmas = applyConnectionPragmas(driver);

    const existingVersion = currentSchemaVersion(driver);
    if (existingVersion > TARGET_SCHEMA_VERSION) {
      return {
        status: 'schema_too_new',
        schemaVersion: existingVersion,
        detail:
          `This history file was written by a newer version of ChargeWatch (schema ${existingVersion}). ` +
          'It has not been modified. Install the newer version to open it.',
      };
    }

    // An unclean exit leaves a session row marked running. Record the gap so
    // the missing period shows as missing rather than being interpolated.
    if (existingVersion === TARGET_SCHEMA_VERSION) {
      this.recordRecoveryGaps();
    }

    let backupPath: string | null = null;
    if (existingVersion > 0 && existingVersion < TARGET_SCHEMA_VERSION) {
      this.restoreOrMigrationActive = true;
      try {
        const result = await createBackup({
          driver,
          backupDir: this.config.backupsDir,
          kind: 'pre_migration',
          appVersion: this.config.appVersion,
          nowMs: this.nowMs(),
          openForVerify: this.config.openDriver,
        });
        backupPath = result.filePath;
      } catch (error) {
        this.restoreOrMigrationActive = false;
        return {
          status: 'migration_failed',
          backupPath: null,
          detail:
            'A verified backup could not be created before upgrading the history file, so the upgrade was not attempted: ' +
            (error instanceof Error ? error.message : String(error)),
        };
      }
    }

    const outcome = migrate(driver, MIGRATIONS, {
      appVersion: this.config.appVersion,
      nowMs: this.nowMs(),
    });
    this.restoreOrMigrationActive = false;

    if (outcome.status === 'refused_newer_schema') {
      return {
        status: 'schema_too_new',
        schemaVersion: outcome.schemaVersion,
        detail: outcome.detail,
      };
    }
    if (outcome.status === 'failed' || outcome.status === 'checksum_mismatch') {
      // Both the original backup and the working copy are preserved; the caller
      // opens a recovery screen and leaves collection stopped.
      this.recordUpdateEvent({ event: 'migration_failed', detail: outcome.detail });
      return { status: 'migration_failed', detail: outcome.detail, backupPath };
    }

    const integrity = checkIntegrity(driver);
    if (!integrity.ok) {
      return {
        status: 'migration_failed',
        backupPath,
        detail: `the history file failed its integrity check: ${integrity.details.join('; ')}`,
      };
    }

    this.queries = new QueryService(driver, {
      timeZone: this.config.timeZone,
      nowMs: this.nowMs,
    });
    this.seedDefaultSettings();
    sessionRepository(driver).start(
      this.sessionId,
      this.config.appVersion,
      TARGET_SCHEMA_VERSION,
      this.nowMs(),
    );
    this.startHeartbeat();
    await pruneBackups(driver, this.config.backupsDir);

    return {
      status: 'ready',
      schemaVersion: currentSchemaVersion(driver),
      journalMode: pragmas.journalMode,
    };
  }

  private seedDefaultSettings(): void {
    const settings = settingsRepository(this.requireDriver());
    const existing = settings.getAll();
    const defaults: Record<string, unknown> = {
      'study.centerLatitude': STUDY_AREA_DEFAULTS.centerLatitude,
      'study.centerLongitude': STUDY_AREA_DEFAULTS.centerLongitude,
      'study.radiusMiles': STUDY_AREA_DEFAULTS.radiusMiles,
      'study.label': STUDY_AREA_DEFAULTS.label,
      'study.timeZone': STUDY_TIME_ZONE,
      'ui.theme': 'dark',
      'ui.onboardingComplete': false,
      'collection.userPaused': false,
      'collection.running': false,
      'startup.startWithWindows': false,
      'updates.autoCheck': true,
      'updates.autoDownload': true,
      'updates.autoInstall': true,
      'retention.keepForever': true,
      'demo.enabled': false,
    };
    const missing: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(defaults)) {
      if (existing[key] === undefined) missing[key] = value;
    }
    if (Object.keys(missing).length > 0) settings.setMany(missing, this.nowMs());
  }

  /**
   * Identifies sessions that never recorded an end and records the interval
   * between their last heartbeat and now as missing coverage.
   */
  private recordRecoveryGaps(): void {
    const driver = this.requireDriver();
    const sessions = sessionRepository(driver);
    const coverage = coverageRepository(driver);
    const nowMs = this.nowMs();
    const recovered = sessions.recoverUncleanSessions(this.sessionId, nowMs);
    for (const session of recovered) {
      if (!session.collectionRunning) continue;
      coverage.recordGap(
        {
          scopeKey: null,
          startMs: session.lastHeartbeatMs,
          endMs: nowMs,
          reason: 'unclean_exit',
        },
        `recovered session ${session.sessionId}`,
      );
    }
  }

  private startHeartbeat(): void {
    const driver = this.requireDriver();
    const sessions = sessionRepository(driver);
    const settings = settingsRepository(driver);
    this.heartbeatTimer = setInterval(() => {
      try {
        sessions.heartbeat(
          this.sessionId,
          this.nowMs(),
          settings.get('collection.running') === true,
          settings.get('collection.userPaused') === true,
        );
      } catch {
        // A failed heartbeat must not take the worker down; the next tick
        // retries, and a genuinely broken database surfaces elsewhere.
      }
    }, 30_000);
    this.heartbeatTimer.unref?.();
  }

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------

  /**
   * Records a collection run and its per-binding outcomes and observations.
   *
   * Composed inside one transaction: either the run, its attempts and its
   * observations are all recorded, or none are. The derived aggregate cache is
   * invalidated in the same unit so a reader can never see new raw data
   * alongside stale aggregates.
   */
  ingestRun(input: {
    readonly runId: string;
    readonly sourceId: string;
    readonly adapterVersion: string;
    readonly startedMs: number;
    readonly finishedMs: number;
    readonly outcome: string;
    readonly effectiveIntervalMs: number | null;
    readonly cycleDurationMs: number | null;
    readonly warnings: readonly string[];
    readonly attempts: readonly {
      readonly bindingId: string;
      readonly scopeKey: string;
      readonly startedMs: number;
      readonly finishedMs: number;
      readonly outcome: string;
      readonly errorDetail: string | null;
      readonly navigationCount: number;
    }[];
    readonly observations: readonly IngestObservation[];
  }): { written: number; deduplicated: number } {
    const driver = this.requireDriver();
    if (this.restoreOrMigrationActive) {
      throw new Error('collection cannot write while a migration or restore is in progress');
    }

    const observations = observationsRepository(driver);
    const cache = metricsCacheRepository(driver);

    return transact(driver, () => {
      driver
        .prepare(
          `INSERT INTO collection_runs
             (id, source_id, adapter_version, started_ms, finished_ms, outcome, error_class,
              bindings_attempted, bindings_succeeded, effective_interval_ms, cycle_duration_ms, warnings_json)
           VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?)
           ON CONFLICT (id) DO UPDATE SET
             finished_ms = excluded.finished_ms,
             outcome = excluded.outcome,
             bindings_succeeded = excluded.bindings_succeeded`,
        )
        .run(
          input.runId,
          input.sourceId,
          input.adapterVersion,
          input.startedMs,
          input.finishedMs,
          input.outcome,
          input.attempts.length,
          input.attempts.filter((a) => a.outcome === 'succeeded' || a.outcome === 'partial').length,
          input.effectiveIntervalMs,
          input.cycleDurationMs,
          input.warnings.length > 0 ? JSON.stringify(input.warnings) : null,
        );

      const insertAttempt = driver.prepare(
        `INSERT INTO collection_attempts
           (run_id, binding_id, scope_key, started_ms, finished_ms, outcome, error_detail, navigation_count)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT (run_id, binding_id, scope_key) DO UPDATE SET
           finished_ms = excluded.finished_ms,
           outcome = excluded.outcome,
           error_detail = excluded.error_detail`,
      );
      for (const attempt of input.attempts) {
        insertAttempt.run(
          input.runId,
          attempt.bindingId,
          attempt.scopeKey,
          attempt.startedMs,
          attempt.finishedMs,
          attempt.outcome,
          attempt.errorDetail,
          attempt.navigationCount,
        );
      }

      const result = observations.ingest(input.runId, input.observations);

      // Late data invalidates the cached aggregates for the affected period.
      for (const observation of input.observations) {
        cache.invalidate(
          observation.scopeKey,
          observation.observedAtUtcMs - 86_400_000,
          observation.observedAtUtcMs + 86_400_000,
          this.config.timeZone,
        );
      }

      return { written: result.written, deduplicated: result.deduplicated };
    });
  }

  /** Records an interruption, so missing time is a fact rather than a hole. */
  recordGap(input: {
    readonly scopeKey: string | null;
    readonly startMs: number;
    readonly endMs: number;
    readonly reason:
      | 'not_enabled'
      | 'user_paused'
      | 'app_not_running'
      | 'computer_asleep'
      | 'offline'
      | 'source_paused'
      | 'browser_failure'
      | 'update_install'
      | 'migration'
      | 'unclean_exit';
    readonly detail?: string;
  }): void {
    if (input.endMs <= input.startMs) return;
    coverageRepository(this.requireDriver()).recordGap(input, input.detail);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  getOverview(window: WindowRequest, filters: FilterState, sort: RankSort) {
    return this.requireQueries().getOverview({ window, filters, sort });
  }

  getMapMarkers(
    window: WindowRequest,
    filters: FilterState,
    sort: RankSort,
    metric: 'occupancy' | 'current' | 'coverage' | 'visits',
  ) {
    return this.requireQueries().getMapMarkers({ window, filters, sort, metric });
  }

  getStationDetail(siteId: string, window: WindowRequest) {
    return this.requireQueries().getStationDetail(siteId, window);
  }

  getSettings(): Record<string, unknown> {
    return settingsRepository(this.requireDriver()).getAll();
  }

  updateSettings(entries: Record<string, unknown>): string[] {
    settingsRepository(this.requireDriver()).setMany(entries, this.nowMs());
    return Object.keys(entries);
  }

  setSaved(siteId: string, saved: boolean): void {
    sitesRepository(this.requireDriver()).setSaved(siteId, saved, this.nowMs());
  }

  counts(): { catalogSites: number; monitoredScopes: number; observations: number } {
    const driver = this.requireDriver();
    const sites = sitesRepository(driver).count();
    const monitored = Number(
      driver
        .prepare('SELECT COUNT(*) AS c FROM source_bindings WHERE enabled = 1 AND is_primary = 1')
        .get()?.c ?? 0,
    );
    return {
      catalogSites: sites.total - sites.archived,
      monitoredScopes: monitored,
      observations: observationsRepository(driver).countAll(),
    };
  }

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------

  /**
   * Streams the current view to CSV.
   *
   * The export matches the same filters, window and metric definitions the UI
   * is showing, and records the metric algorithm version so a file can be
   * interpreted later.
   */
  async exportCurrentView(input: {
    readonly window: WindowRequest;
    readonly filters: FilterState;
    readonly sort: RankSort;
    readonly destinationPath: string;
  }): Promise<{ path: string; rowCount: number }> {
    const overview = this.getOverview(input.window, input.filters, input.sort);
    const rows = [...overview.ranked, ...overview.provisional, ...overview.excludedAmbiguous];

    const startIso = overview.summary.effectiveStartMs
      ? new Date(overview.summary.effectiveStartMs).toISOString()
      : '';
    const endIso = overview.summary.effectiveEndMs
      ? new Date(overview.summary.effectiveEndMs).toISOString()
      : '';

    const headers = [
      'site_id',
      'station',
      'address',
      'network',
      'charging_type',
      'monitoring_state',
      'eligible_for_ranking',
      'installed_ports',
      'catalog_ports',
      'observed_occupancy_pct',
      'estimated_occupied_port_hours',
      'status_coverage_pct',
      'history_days',
      'latest_observation_utc',
      'latest_observation_phoenix',
      'source_freshness',
      'scope_note',
      'provisional_reasons',
    ];

    const lines = csvLines({
      headers,
      provenanceComments: [
        `ChargeWatch export · current view · metric algorithm version ${METRIC_ALGORITHM_VERSION}`,
        `Window ${startIso} to ${endIso} (requested ${overview.summary.requestedDays} days, effective ${overview.summary.effectiveDays} days)`,
        `Cohort: ${overview.summary.cohortDescription}`,
        `Filters: query="${input.filters.query}" networks=[${input.filters.networks.join('|')}] types=[${input.filters.chargingTypes.join('|')}] savedOnly=${String(input.filters.savedOnly)}`,
        'Empty numeric cells mean no observation, not zero. Text cells beginning with = + - @ are prefixed with an apostrophe so spreadsheets treat them as text.',
      ],
      rows: rows.map((station) => [
        text(station.id),
        text(station.name),
        text(station.address),
        text(station.network),
        text(station.type),
        text(station.monitoring),
        text(station.eligibleForRanking ? 'yes' : 'no'),
        number(station.ports),
        number(station.catalogPorts),
        number(station.occupancy),
        number(station.hours),
        number(station.coverage),
        number(station.history),
        trusted(station.observedAtMs ? new Date(station.observedAtMs).toISOString() : null),
        trusted(
          station.observedAtMs
            ? new Intl.DateTimeFormat('en-CA', {
                timeZone: this.config.timeZone,
                dateStyle: 'short',
                timeStyle: 'medium',
              }).format(new Date(station.observedAtMs))
            : null,
        ),
        text(station.sourceFreshness),
        text(station.scopeNote),
        text(station.provisionalReasons.join(' | ')),
      ]),
    });

    await this.writeLines(input.destinationPath, lines);
    return { path: input.destinationPath, rowCount: rows.length };
  }

  /**
   * Streams raw observations to CSV, paginated so a long history does not
   * build a giant string in memory.
   */
  async exportRawObservations(input: {
    readonly window: WindowRequest;
    readonly destinationPath: string;
  }): Promise<{ path: string; rowCount: number }> {
    const driver = this.requireDriver();
    const resolved = this.requireQueries().resolveSharedWindow(input.window);

    const headers = [
      'observation_id',
      'site_id',
      'scope_key',
      'source_id',
      'observed_at_utc',
      'observed_at_phoenix',
      'source_updated_at_utc',
      'source_freshness',
      'method',
      'granularity',
      'available_ports',
      'occupied_ports',
      'reserved_ports',
      'out_of_service_ports',
      'unknown_ports',
      'reported_total_ports',
      'capacity_basis',
      'completeness',
      'quality',
      'charging_level',
      'distinguishes_charging',
      'scheduled_interval_ms',
      'carry_forward_cap_ms',
      'source_freshness_limit_ms',
      'parser_version',
      'source_url',
      'evidence_fingerprint',
    ];

    const pageSize = 2000;
    let offset = 0;
    let rowCount = 0;
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.config.timeZone,
      dateStyle: 'short',
      timeStyle: 'medium',
    });

    function* rowGenerator(): Generator<ReturnType<typeof text>[]> {
      for (;;) {
        const page = driver
          .prepare(
            `SELECT o.*, q.quality, q.source_freshness, b.source_id AS source_id
               FROM observations o
               LEFT JOIN observation_quality q ON q.observation_id = o.id
               LEFT JOIN source_bindings b ON b.id = o.binding_id
              WHERE o.observed_at_ms >= ? AND o.observed_at_ms < ?
              ORDER BY o.observed_at_ms, o.id
              LIMIT ? OFFSET ?`,
          )
          .all(resolved.effective.startMs, resolved.effective.endMs, pageSize, offset);
        if (page.length === 0) return;
        for (const row of page) {
          rowCount += 1;
          const observedAt = Number(row.observed_at_ms);
          yield [
            text(String(row.id)),
            text(String(row.site_id)),
            text(String(row.scope_key)),
            text(row.source_id === null ? null : String(row.source_id)),
            trusted(new Date(observedAt).toISOString()),
            trusted(formatter.format(new Date(observedAt))),
            trusted(
              row.source_updated_at_ms === null
                ? null
                : new Date(Number(row.source_updated_at_ms)).toISOString(),
            ),
            text(row.source_freshness === null ? null : String(row.source_freshness)),
            text(String(row.method)),
            text(String(row.granularity)),
            number(row.available_count === null ? null : Number(row.available_count)),
            number(row.occupied_count === null ? null : Number(row.occupied_count)),
            number(row.reserved_count === null ? null : Number(row.reserved_count)),
            number(row.out_of_service_count === null ? null : Number(row.out_of_service_count)),
            number(row.unknown_count === null ? null : Number(row.unknown_count)),
            number(row.reported_total === null ? null : Number(row.reported_total)),
            text(String(row.capacity_basis)),
            text(String(row.completeness)),
            text(row.quality === null ? null : String(row.quality)),
            text(String(row.level)),
            text(Number(row.distinguishes_charging) === 1 ? 'yes' : 'no'),
            number(Number(row.scheduled_interval_ms)),
            number(Number(row.max_carry_forward_cap_ms)),
            number(
              row.source_freshness_limit_ms === null ? null : Number(row.source_freshness_limit_ms),
            ),
            text(String(row.parser_version)),
            text(String(row.source_url)),
            text(String(row.evidence_fingerprint)),
          ];
        }
        offset += page.length;
      }
    }

    await this.writeLines(
      input.destinationPath,
      csvLines({
        headers,
        provenanceComments: [
          `ChargeWatch export · raw observations · metric algorithm version ${METRIC_ALGORITHM_VERSION}`,
          `Window ${new Date(resolved.effective.startMs).toISOString()} to ${new Date(resolved.effective.endMs).toISOString()}`,
          'Every row is one observation of one scope at one instant. An empty count means the source did not report that dimension; it does not mean zero.',
          'Times are given in UTC and in America/Phoenix local time in separate columns.',
        ],
        rows: rowGenerator(),
      }),
    );

    return { path: input.destinationPath, rowCount };
  }

  private async writeLines(destination: string, lines: Iterable<string>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(destination, { encoding: 'utf8' });
      stream.on('error', reject);
      stream.on('finish', () => resolve());
      // Excel needs a BOM to read UTF-8 correctly.
      stream.write('﻿');
      for (const line of lines) {
        if (!stream.write(line)) {
          // Backpressure: for the sizes involved this is acceptable, and the
          // stream buffers rather than dropping.
        }
      }
      stream.end();
    });
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  async createBackupNow(kind: 'daily' | 'manual' | 'pre_update' = 'manual') {
    const result = await createBackup({
      driver: this.requireDriver(),
      backupDir: this.config.backupsDir,
      kind,
      appVersion: this.config.appVersion,
      nowMs: this.nowMs(),
      openForVerify: this.config.openDriver,
    });
    await pruneBackups(this.requireDriver(), this.config.backupsDir);
    return result;
  }

  listBackups() {
    return this.requireDriver()
      .prepare(
        'SELECT id, kind, created_at_ms, byte_size, verified, manifest_json FROM backups ORDER BY created_at_ms DESC',
      )
      .all()
      .map((row) => {
        let observationCount = 0;
        try {
          observationCount = Number(
            (JSON.parse(String(row.manifest_json)) as { observationCount?: number })
              .observationCount ?? 0,
          );
        } catch {
          observationCount = 0;
        }
        return {
          id: String(row.id),
          kind: String(row.kind),
          createdAtMs: Number(row.created_at_ms),
          byteSize: Number(row.byte_size),
          verified: Number(row.verified) === 1,
          observationCount,
        };
      });
  }

  async previewRestore(filePath: string) {
    return validateRestoreCandidate({
      candidatePath: filePath,
      openForVerify: this.config.openDriver,
    });
  }

  /**
   * Performs a restore after the user has confirmed a validated preview.
   *
   * Collection must already be stopped by the caller. The current database is
   * preserved, never overwritten in place.
   */
  async performRestore(
    filePath: string,
  ): Promise<{ ok: boolean; detail: string | null; preservedPreviousPath: string | null }> {
    this.restoreOrMigrationActive = true;
    try {
      await this.createBackupNow('manual');
      const result = await performRestore({
        candidatePath: filePath,
        livePath: this.config.databaseFile,
        stagingDir: this.config.stagingDir,
        nowMs: this.nowMs(),
        openForVerify: this.config.openDriver,
        closeLiveDatabase: async () => {
          await this.close({ markStopped: false });
        },
      });
      if (!result.ok) {
        // Reopen whatever is there so the app is not left with no database.
        await this.open();
        return {
          ok: false,
          detail: result.detail ?? 'restore failed',
          preservedPreviousPath: null,
        };
      }
      const reopened = await this.open();
      if (reopened.status !== 'ready') {
        return {
          ok: false,
          detail: `the restored file could not be opened: ${JSON.stringify(reopened)}`,
          preservedPreviousPath: result.preservedPreviousPath ?? null,
        };
      }
      return {
        ok: true,
        detail: null,
        preservedPreviousPath: result.preservedPreviousPath ?? null,
      };
    } finally {
      this.restoreOrMigrationActive = false;
    }
  }

  deleteObservationsBefore(cutoffMs: number): number {
    const driver = this.requireDriver();
    return transact(driver, () => {
      const deleted = observationsRepository(driver).deleteBefore(cutoffMs);
      metricsCacheRepository(driver).invalidateAll();
      return deleted;
    });
  }

  // -------------------------------------------------------------------------
  // Collector state
  // -------------------------------------------------------------------------

  collectionStatus(input: Parameters<QueryService['getCollectionStatus']>[0]) {
    return this.requireQueries().getCollectionStatus(input);
  }

  studyStartMs(): number | null {
    return this.requireQueries().studyStartMs();
  }

  /** Approximate on-disk size of the database, WAL and backups. */
  async diskUsageBytes(): Promise<number | null> {
    const { stat } = await import('node:fs/promises');
    let total = 0;
    for (const path of [
      this.config.databaseFile,
      `${this.config.databaseFile}-wal`,
      `${this.config.databaseFile}-shm`,
    ]) {
      try {
        total += (await stat(path)).size;
      } catch {
        /* a missing sidecar is normal */
      }
    }
    for (const backup of this.listBackups()) total += backup.byteSize;
    return total;
  }

  /**
   * Loads the persisted scheduler queue and the enabled bindings.
   *
   * A binding for a source that is not eligible is still returned: the
   * scheduler decides, and it needs to know the binding exists so the UI can
   * explain why nothing is being collected.
   */
  loadCollectorState(): {
    queue: Array<{
      bindingId: string;
      sourceId: string;
      nextDueMs: number;
      intervalMs: number;
      lastAttemptMs: number | null;
      lastSuccessMs: number | null;
      consecutiveFailures: number;
      backoffMs: number;
      paused: boolean;
    }>;
    bindings: Array<{
      bindingId: string;
      siteId: string;
      sourceId: string;
      scopeKey: string;
      sourceStationId: string | null;
      canonicalUrl: string;
      physicalScope: string;
      granularity: 'port' | 'station_aggregate' | 'charger_subgroup';
      identityReliability: 'durable' | 'unstable' | 'none';
      catalogPortCount: number | null;
      expectedLevel: ChargingLevel;
    }>;
  } {
    const driver = this.requireDriver();

    const bindings = driver
      .prepare(
        `SELECT b.id, b.site_id, b.source_id, b.scope_key, b.source_station_id, b.canonical_url,
                b.physical_scope, b.granularity, b.identity_reliability,
                s.catalog_port_count, s.catalog_level
           FROM source_bindings b
           JOIN sites s ON s.id = b.site_id
          WHERE b.enabled = 1 AND b.is_primary = 1 AND b.effective_to_ms IS NULL
            AND s.archived = 0
          ORDER BY b.id`,
      )
      .all()
      .map((row) => ({
        bindingId: String(row.id),
        siteId: String(row.site_id),
        sourceId: String(row.source_id),
        scopeKey: String(row.scope_key),
        sourceStationId: row.source_station_id === null ? null : String(row.source_station_id),
        canonicalUrl: String(row.canonical_url),
        physicalScope: String(row.physical_scope),
        granularity: String(row.granularity) as 'port' | 'station_aggregate' | 'charger_subgroup',
        identityReliability: String(row.identity_reliability) as 'durable' | 'unstable' | 'none',
        catalogPortCount: asNumberOrNull(row.catalog_port_count),
        expectedLevel: String(row.catalog_level) as ChargingLevel,
      }));

    const queue = driver
      .prepare(
        `SELECT binding_id, source_id, next_due_ms, interval_ms, last_attempt_ms, last_success_ms,
                consecutive_failures, backoff_ms, paused
           FROM schedule_queue ORDER BY binding_id`,
      )
      .all()
      .map((row) => ({
        bindingId: String(row.binding_id),
        sourceId: String(row.source_id),
        nextDueMs: Number(row.next_due_ms),
        intervalMs: Number(row.interval_ms),
        lastAttemptMs: asNumberOrNull(row.last_attempt_ms),
        lastSuccessMs: asNumberOrNull(row.last_success_ms),
        consecutiveFailures: Number(row.consecutive_failures),
        backoffMs: Number(row.backoff_ms),
        paused: Number(row.paused) === 1,
      }));

    // Any enabled binding with no queue row gets one, due now. A newly enabled
    // site must not wait for an arbitrary interval before its first reading.
    const known = new Set(queue.map((entry) => entry.bindingId));
    const nowMs = this.nowMs();
    const insertQueue = driver.prepare(
      `INSERT INTO schedule_queue
         (binding_id, source_id, next_due_ms, interval_ms, consecutive_failures, backoff_ms, paused)
       VALUES (?,?,?,?,0,0,0)
       ON CONFLICT (binding_id) DO NOTHING`,
    );
    for (const binding of bindings) {
      if (known.has(binding.bindingId)) continue;
      insertQueue.run(
        binding.bindingId,
        binding.sourceId,
        nowMs,
        COLLECTION_DEFAULTS.targetIntervalMs,
      );
      queue.push({
        bindingId: binding.bindingId,
        sourceId: binding.sourceId,
        nextDueMs: nowMs,
        intervalMs: COLLECTION_DEFAULTS.targetIntervalMs,
        lastAttemptMs: null,
        lastSuccessMs: null,
        consecutiveFailures: 0,
        backoffMs: 0,
        paused: false,
      });
    }

    return { queue, bindings };
  }

  /** Persists the scheduler queue so due times survive a restart. */
  persistQueue(
    entries: readonly {
      bindingId: string;
      sourceId: string;
      nextDueMs: number;
      intervalMs: number;
      lastAttemptMs: number | null;
      lastSuccessMs: number | null;
      consecutiveFailures: number;
      backoffMs: number;
      paused: boolean;
    }[],
  ): { persisted: number } {
    const driver = this.requireDriver();
    const upsert = driver.prepare(
      `INSERT INTO schedule_queue
         (binding_id, source_id, next_due_ms, interval_ms, last_attempt_ms, last_success_ms,
          consecutive_failures, backoff_ms, paused)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT (binding_id) DO UPDATE SET
         next_due_ms = excluded.next_due_ms,
         interval_ms = excluded.interval_ms,
         last_attempt_ms = excluded.last_attempt_ms,
         last_success_ms = excluded.last_success_ms,
         consecutive_failures = excluded.consecutive_failures,
         backoff_ms = excluded.backoff_ms,
         paused = excluded.paused`,
    );
    return transact(driver, () => {
      for (const entry of entries) {
        // A binding parked in the far future by a source pause is clamped so
        // the stored value stays inside the column's range check.
        const nextDue = Math.min(entry.nextDueMs, 4_102_444_800_000);
        upsert.run(
          entry.bindingId,
          entry.sourceId,
          nextDue,
          entry.intervalMs,
          entry.lastAttemptMs,
          entry.lastSuccessMs,
          entry.consecutiveFailures,
          entry.backoffMs,
          entry.paused ? 1 : 0,
        );
      }
      return { persisted: entries.length };
    });
  }

  /**
   * Records the source capability records the collector registered.
   *
   * The capability record is the durable statement of what a source supports
   * and whether it is eligible, so it belongs in the database rather than only
   * in the collector's memory. `eligibility_state` is what the UI reads to
   * explain why a source is not collecting.
   */
  upsertSources(
    capabilities: readonly {
      sourceId: string;
      displayName: string;
      websiteUrls: readonly string[];
      adapterVersion: string;
      capabilityVersion: number;
      supportedRegion: string;
      observationGranularity: 'port' | 'station_aggregate' | 'charger_subgroup';
      identityReliability: 'durable' | 'unstable' | 'none';
      accessRequirements: string;
      collectionMethod: 'rendered_dom' | 'local_ocr' | 'manual' | 'authorized_api';
      minIntervalMs: number;
      minNavigationIntervalMs: number;
      sourceFreshnessLimitMs: number | null;
      distinguishesCharging: boolean;
      stateMeanings: Readonly<Record<string, string | undefined>>;
      termsUrls: readonly string[];
      termsReviewedAtMs: number | null;
      termsReviewScope: string | null;
      eligibilityBasis: string | null;
      eligibilityState: 'enabled' | 'disabled' | 'needs_review';
      verificationState: 'verified' | 'unverified' | 'blocked';
      notes: string | null;
    }[],
  ): { upserted: number } {
    const driver = this.requireDriver();
    const upsert = driver.prepare(
      `INSERT INTO sources
         (id, display_name, website_url, adapter_version, capability_version, supported_region,
          observation_granularity, identity_reliability, access_requirements, collection_method,
          min_interval_ms, min_navigation_interval_ms, source_freshness_limit_ms,
          distinguishes_charging, state_meanings_json, terms_urls_json, terms_reviewed_at_ms,
          terms_review_scope, eligibility_basis, eligibility_state, verification_state, notes,
          updated_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (id) DO UPDATE SET
         display_name = excluded.display_name,
         adapter_version = excluded.adapter_version,
         capability_version = excluded.capability_version,
         observation_granularity = excluded.observation_granularity,
         identity_reliability = excluded.identity_reliability,
         access_requirements = excluded.access_requirements,
         collection_method = excluded.collection_method,
         min_interval_ms = excluded.min_interval_ms,
         min_navigation_interval_ms = excluded.min_navigation_interval_ms,
         source_freshness_limit_ms = excluded.source_freshness_limit_ms,
         distinguishes_charging = excluded.distinguishes_charging,
         state_meanings_json = excluded.state_meanings_json,
         terms_urls_json = excluded.terms_urls_json,
         terms_reviewed_at_ms = excluded.terms_reviewed_at_ms,
         terms_review_scope = excluded.terms_review_scope,
         eligibility_basis = excluded.eligibility_basis,
         eligibility_state = excluded.eligibility_state,
         verification_state = excluded.verification_state,
         notes = excluded.notes,
         updated_at_ms = excluded.updated_at_ms`,
    );

    const nowMs = this.nowMs();
    return transact(driver, () => {
      for (const capability of capabilities) {
        upsert.run(
          capability.sourceId,
          capability.displayName,
          capability.websiteUrls[0] ?? null,
          capability.adapterVersion,
          capability.capabilityVersion,
          capability.supportedRegion,
          capability.observationGranularity,
          capability.identityReliability,
          capability.accessRequirements,
          capability.collectionMethod,
          capability.minIntervalMs,
          capability.minNavigationIntervalMs,
          capability.sourceFreshnessLimitMs,
          capability.distinguishesCharging ? 1 : 0,
          JSON.stringify(capability.stateMeanings),
          JSON.stringify(capability.termsUrls),
          capability.termsReviewedAtMs,
          capability.termsReviewScope,
          capability.eligibilityBasis,
          capability.eligibilityState,
          capability.verificationState,
          capability.notes,
          nowMs,
        );
      }
      return { upserted: capabilities.length };
    });
  }

  persistSourceHealth(input: {
    readonly sourceId: string;
    readonly state: string;
    readonly detail: string | null;
    readonly consecutiveFailures: number;
    readonly backoffUntilMs: number | null;
    readonly lastAttemptMs: number | null;
    readonly lastSuccessMs: number | null;
    readonly userActionRequired: string | null;
  }): void {
    // Health for a source we have no capability record for is dropped rather
    // than thrown: a health ping must never take the worker down.
    const known = this.requireDriver()
      .prepare('SELECT 1 AS present FROM sources WHERE id = ?')
      .get(input.sourceId);
    if (!known) return;

    this.requireDriver()
      .prepare(
        `INSERT INTO source_health
           (source_id, state, detail, consecutive_failures, backoff_until_ms, current_backoff_ms,
            last_attempt_ms, last_success_ms, user_action_required, updated_at_ms)
         VALUES (?,?,?,?,?,0,?,?,?,?)
         ON CONFLICT (source_id) DO UPDATE SET
           state = excluded.state,
           detail = excluded.detail,
           consecutive_failures = excluded.consecutive_failures,
           backoff_until_ms = excluded.backoff_until_ms,
           last_attempt_ms = COALESCE(excluded.last_attempt_ms, source_health.last_attempt_ms),
           last_success_ms = COALESCE(excluded.last_success_ms, source_health.last_success_ms),
           user_action_required = excluded.user_action_required,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        input.sourceId,
        input.state,
        input.detail,
        input.consecutiveFailures,
        input.backoffUntilMs === null ? null : Math.min(input.backoffUntilMs, 4_102_444_800_000),
        input.lastAttemptMs,
        input.lastSuccessMs,
        input.userActionRequired,
        this.nowMs(),
      );
  }

  /**
   * Enables or disables monitoring for sites.
   *
   * A site with no usable source binding is REFUSED with a reason rather than
   * silently appearing to be monitored.
   */
  setMonitored(input: { readonly siteIds: readonly string[]; readonly enabled: boolean }): {
    enabledCount: number;
    refusedCount: number;
    refusals: string[];
  } {
    const driver = this.requireDriver();
    const coverage = coverageRepository(driver);
    const refusals: string[] = [];
    let changed = 0;
    const nowMs = this.nowMs();

    transact(driver, () => {
      for (const siteId of input.siteIds) {
        const binding = driver
          .prepare(
            `SELECT b.id, b.scope_key, b.source_id, s.eligibility_state, s.display_name,
                    st.catalog_port_count, st.catalog_level
               FROM source_bindings b
               JOIN sources s ON s.id = b.source_id
               JOIN sites st ON st.id = b.site_id
              WHERE b.site_id = ? AND b.is_primary = 1 AND b.effective_to_ms IS NULL
              LIMIT 1`,
          )
          .get(siteId);

        if (!binding) {
          refusals.push(`${siteId}: no source provides status for this location`);
          continue;
        }
        if (input.enabled && String(binding.eligibility_state) !== 'enabled') {
          refusals.push(
            `${siteId}: ${String(binding.display_name)} collection is not enabled yet, so this location cannot be monitored`,
          );
          continue;
        }

        driver
          .prepare('UPDATE source_bindings SET enabled = ?, updated_at_ms = ? WHERE id = ?')
          .run(input.enabled ? 1 : 0, nowMs, String(binding.id));

        const scopeKey = String(binding.scope_key);
        if (input.enabled) {
          coverage.openMonitoring(
            scopeKey,
            String(binding.id),
            nowMs,
            COLLECTION_DEFAULTS.targetIntervalMs,
          );
          // Seed capacity from the catalog so coverage has a denominator.
          const ports = asNumberOrNull(binding.catalog_port_count);
          if (ports !== null) {
            coverage.setCapacity(
              {
                scopeKey,
                siteId,
                startMs: nowMs,
                endMs: null,
                capacityPorts: ports,
                level: String(binding.catalog_level) as ChargingLevel,
                basis: 'ports_simultaneous',
                source: 'catalog',
              },
              nowMs,
            );
          }
        } else {
          coverage.closeMonitoring(scopeKey, nowMs);
          driver.prepare('DELETE FROM schedule_queue WHERE binding_id = ?').run(String(binding.id));
        }
        changed += 1;
      }
    });

    return { enabledCount: changed, refusedCount: refusals.length, refusals };
  }

  /**
   * Adds a manual source link for a site.
   *
   * The URL is checked against the adapter's origin allowlist here as well as
   * in the collector, so "Add location link" can never become an arbitrary
   * URL fetcher, a file reader or an intranet probe.
   */
  addManualLink(input: { readonly siteId: string; readonly url: string }): {
    ok: boolean;
    code: string;
    detail: string | null;
  } {
    const driver = this.requireDriver();
    const site = driver
      .prepare('SELECT id, catalog_level FROM sites WHERE id = ?')
      .get(input.siteId);
    if (!site)
      return { ok: false, code: 'unknown_site', detail: 'that location is not in the catalog' };

    if (!isAllowedSourceUrl(input.url)) {
      return {
        ok: false,
        code: 'url_not_allowlisted',
        detail: 'Only ChargePoint station links are supported at the moment.',
      };
    }
    const stationId = stationIdFromUrl(input.url);
    if (!stationId) {
      return {
        ok: false,
        code: 'station_id_missing',
        detail: 'That link does not point at a single station page.',
      };
    }

    const nowMs = this.nowMs();
    const scopeKey = `chargepoint:${stationId}`;
    try {
      driver
        .prepare(
          `INSERT INTO source_bindings
             (id, source_id, site_id, source_station_id, canonical_url, scope_key, physical_scope,
              granularity, identity_reliability, is_primary, enabled, capability_version,
              match_basis, match_confidence, match_disposition, effective_from_ms,
              created_at_ms, updated_at_ms)
           VALUES (?, 'chargepoint', ?, ?, ?, ?, 'whole station', 'station_aggregate', 'none',
                   1, 0, 1, 'manual', NULL, 'confirmed', ?, ?, ?)`,
        )
        .run(
          `manual-${stationId}-${nowMs}`,
          input.siteId,
          stationId,
          input.url,
          scopeKey,
          nowMs,
          nowMs,
          nowMs,
        );
    } catch (error) {
      return {
        ok: false,
        code: 'binding_conflict',
        detail:
          error instanceof Error && /UNIQUE/i.test(error.message)
            ? 'That station is already linked to a location.'
            : error instanceof Error
              ? error.message
              : String(error),
      };
    }

    return {
      ok: true,
      code: 'ok',
      detail:
        'The link was saved. Collection from this source is still disabled until its eligibility is established.',
    };
  }

  bindingIdsForSites(input: { readonly siteIds: readonly string[] }): string[] {
    if (input.siteIds.length === 0) {
      return this.requireDriver()
        .prepare('SELECT id FROM source_bindings WHERE enabled = 1 AND is_primary = 1')
        .all()
        .map((row) => String(row.id));
    }
    const placeholders = new Array(input.siteIds.length).fill('?').join(',');
    return this.requireDriver()
      .prepare(
        `SELECT id FROM source_bindings
          WHERE enabled = 1 AND is_primary = 1 AND site_id IN (${placeholders})`,
      )
      .all(...input.siteIds)
      .map((row) => String(row.id));
  }

  sourceUrlForSite(input: { readonly siteId: string }): { url: string | null } {
    const row = this.requireDriver()
      .prepare(
        `SELECT canonical_url FROM source_bindings
          WHERE site_id = ? AND is_primary = 1 AND effective_to_ms IS NULL LIMIT 1`,
      )
      .get(input.siteId);
    return { url: row?.canonical_url === undefined ? null : String(row.canonical_url) };
  }

  // -------------------------------------------------------------------------
  // Visit imports
  // -------------------------------------------------------------------------

  /**
   * Parses and validates a visit CSV without writing anything.
   *
   * The user sees the accepted count, every rejection with its line number,
   * and a preview before committing.
   */
  async previewVisitImport(input: { readonly filePath: string }): Promise<{
    acceptedCount: number;
    rejectedCount: number;
    issues: Array<{ rowIndex: number; code: string; detail: string }>;
    preview: Array<Record<string, string>>;
    datasetId: string;
    overlapsExisting: string[];
  }> {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(input.filePath, 'utf8');
    const parsed = parseCsv(text, { expectedHeaders: VISIT_TEMPLATE_HEADERS, maxRows: 100_000 });

    const issues: Array<{ rowIndex: number; code: string; detail: string }> = parsed.errors.map(
      (error) => ({ rowIndex: error.lineNumber, code: 'malformed_row', detail: error.message }),
    );
    const at = columnIndex(parsed.headers);
    const knownSiteIds = new Set(sitesRepository(this.requireDriver()).listIds());

    const candidates: VisitObservation[] = [];
    const preview: Array<Record<string, string>> = [];

    for (const row of parsed.rows) {
      const cell = (name: string): string => {
        const index = at(name);
        return index === -1 ? '' : (row.cells[index] ?? '');
      };

      const start = parseIsoInstant(cell('period_start'));
      const end = parseIsoInstant(cell('period_end'));
      const count = parseNonNegativeInteger(cell('visit_count'));

      if (!start.ok || !end.ok || !count.ok) {
        issues.push({
          rowIndex: row.lineNumber,
          code: 'invalid_field',
          detail: [
            start.ok ? null : `period_start: ${start.reason}`,
            end.ok ? null : `period_end: ${end.reason}`,
            count.ok ? null : `visit_count: ${count.reason}`,
          ]
            .filter(Boolean)
            .join('; '),
        });
        continue;
      }

      candidates.push({
        datasetId: 'pending',
        siteId: cell('site_id'),
        period: { startMs: start.ms, endMs: end.ms },
        visitCount: count.value,
        countDefinition: (cell('count_definition') ||
          'other') as VisitObservation['countDefinition'],
        method: (cell('method') || 'measured') as VisitObservation['method'],
        geographicScope: (cell('geographic_scope') ||
          'other') as VisitObservation['geographicScope'],
        sourceName: cell('source_name') || 'unnamed source',
        sourceReference: cell('source_url_or_reference') || null,
        notes: cell('notes') || null,
      });

      if (preview.length < 10) {
        const record: Record<string, string> = {};
        for (const header of parsed.headers) record[header] = cell(header);
        preview.push(record);
      }
    }

    const validation = validateVisitRows(candidates, knownSiteIds);
    for (const issue of validation.issues) {
      issues.push({ rowIndex: issue.rowIndex, code: issue.code, detail: issue.detail });
    }

    // Overlapping datasets are reported, never merged: choosing between them is
    // the user's decision.
    const overlaps = new Set<string>();
    for (const accepted of validation.accepted) {
      const rows = this.requireDriver()
        .prepare(
          `SELECT DISTINCT vd.name FROM visit_observations vo
             JOIN visit_datasets vd ON vd.id = vo.dataset_id
            WHERE vo.site_id = ? AND vo.period_start_ms < ? AND vo.period_end_ms > ?`,
        )
        .all(accepted.siteId, accepted.period.endMs, accepted.period.startMs);
      for (const row of rows) overlaps.add(String(row.name));
    }

    const datasetId = `visits-${this.nowMs()}`;
    this.pendingVisitImports.set(datasetId, {
      rows: validation.accepted,
      sourceName: validation.accepted[0]?.sourceName ?? 'imported dataset',
      filePath: input.filePath,
    });

    return {
      acceptedCount: validation.accepted.length,
      rejectedCount: issues.length,
      issues: issues.slice(0, 200),
      preview,
      datasetId,
      overlapsExisting: [...overlaps],
    };
  }

  private readonly pendingVisitImports = new Map<
    string,
    { rows: readonly VisitObservation[]; sourceName: string; filePath: string }
  >();

  commitVisitImport(input: { readonly datasetId: string; readonly authoritative: boolean }): {
    imported: number;
    importId: string;
  } {
    const pending = this.pendingVisitImports.get(input.datasetId);
    if (!pending) throw new Error('that import preview has expired; preview the file again');

    const driver = this.requireDriver();
    const nowMs = this.nowMs();
    const first = pending.rows[0];
    const importId = `import-${nowMs}`;

    const imported = transact(driver, () => {
      driver
        .prepare(
          `INSERT INTO visit_datasets
             (id, name, source_name, source_reference, revision, file_sha256, imported_at_ms,
              method, count_definition, geographic_scope, authoritative, notes)
           VALUES (?,?,?,?,NULL,NULL,?,?,?,?,?,NULL)`,
        )
        .run(
          input.datasetId,
          pending.sourceName,
          pending.sourceName,
          first?.sourceReference ?? null,
          nowMs,
          first?.method ?? 'measured',
          first?.countDefinition ?? 'other',
          first?.geographicScope ?? 'other',
          input.authoritative ? 1 : 0,
        );

      // Only one dataset is authoritative per site at a time, so two sources'
      // estimates can never be added together.
      if (input.authoritative) {
        driver
          .prepare('UPDATE visit_datasets SET authoritative = 0 WHERE id <> ?')
          .run(input.datasetId);
      }

      const insert = driver.prepare(
        `INSERT INTO visit_observations
           (dataset_id, site_id, period_start_ms, period_end_ms, timezone, visit_count, notes)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (dataset_id, site_id, period_start_ms, period_end_ms) DO NOTHING`,
      );
      let count = 0;
      for (const row of pending.rows) {
        const result = insert.run(
          input.datasetId,
          row.siteId,
          row.period.startMs,
          row.period.endMs,
          this.config.timeZone,
          row.visitCount,
          row.notes,
        );
        if (Number(result.changes) > 0) count += 1;
      }

      driver
        .prepare(
          `INSERT INTO imports
             (id, kind, file_name, file_sha256, row_count, accepted_count, rejected_count,
              duplicate_handling, validation_json, rollback_id, outcome, imported_at_ms)
           VALUES (?, 'visits', ?, NULL, ?, ?, 0, 'rejected', NULL, ?, 'succeeded', ?)`,
        )
        .run(importId, pending.filePath, pending.rows.length, count, input.datasetId, nowMs);

      return count;
    });

    this.pendingVisitImports.delete(input.datasetId);
    return { imported, importId };
  }

  addManualVisit(input: {
    readonly siteId: string;
    readonly periodStartMs: number;
    readonly periodEndMs: number;
    readonly visitCount: number;
    readonly countDefinition: string;
    readonly method: string;
    readonly sourceName: string;
    readonly geographicScope: string;
    readonly notes: string | null;
  }): { ok: boolean; issues: string[] } {
    const driver = this.requireDriver();
    const knownSiteIds = new Set(sitesRepository(driver).listIds());

    const candidate: VisitObservation = {
      datasetId: 'manual',
      siteId: input.siteId,
      period: { startMs: input.periodStartMs, endMs: input.periodEndMs },
      visitCount: input.visitCount,
      countDefinition: input.countDefinition as VisitObservation['countDefinition'],
      method: input.method as VisitObservation['method'],
      geographicScope: input.geographicScope as VisitObservation['geographicScope'],
      sourceName: input.sourceName,
      sourceReference: null,
      notes: input.notes,
    };

    const validation = validateVisitRows([candidate], knownSiteIds);
    if (validation.accepted.length === 0) {
      return { ok: false, issues: validation.issues.map((issue) => issue.detail) };
    }

    const nowMs = this.nowMs();
    transact(driver, () => {
      driver
        .prepare(
          `INSERT INTO visit_datasets
             (id, name, source_name, source_reference, revision, file_sha256, imported_at_ms,
              method, count_definition, geographic_scope, authoritative, notes)
           VALUES ('manual', 'Counts you entered', ?, NULL, NULL, NULL, ?, ?, ?, ?, 1, NULL)
           ON CONFLICT (id) DO UPDATE SET imported_at_ms = excluded.imported_at_ms`,
        )
        .run(input.sourceName, nowMs, input.method, input.countDefinition, input.geographicScope);

      driver
        .prepare(
          `INSERT INTO visit_observations
             (dataset_id, site_id, period_start_ms, period_end_ms, timezone, visit_count, notes)
           VALUES ('manual', ?,?,?,?,?,?)
           ON CONFLICT (dataset_id, site_id, period_start_ms, period_end_ms)
             DO UPDATE SET visit_count = excluded.visit_count, notes = excluded.notes`,
        )
        .run(
          input.siteId,
          input.periodStartMs,
          input.periodEndMs,
          this.config.timeZone,
          input.visitCount,
          input.notes,
        );
    });

    return { ok: true, issues: [] };
  }

  // -------------------------------------------------------------------------
  // Update bookkeeping (never stores credentials or keys)
  // -------------------------------------------------------------------------

  recordUpdateEvent(input: {
    readonly event: string;
    readonly detail: string | null;
    readonly extra?: Record<string, unknown>;
  }): void {
    const detail =
      input.extra && Object.keys(input.extra).length > 0
        ? `${input.detail ?? ''} ${JSON.stringify(input.extra)}`.trim()
        : input.detail;
    try {
      this.requireDriver()
        .prepare('INSERT INTO update_events (event, detail, occurred_at_ms) VALUES (?,?,?)')
        .run(input.event, detail, this.nowMs());
    } catch (error) {
      // Bookkeeping must never break an update, so this is swallowed -- but it
      // is no longer swallowed SILENTLY. A duplicate method definition once
      // made every internal call pass a string where an object was expected,
      // so `event` was undefined, the CHECK constraint rejected every row, and
      // this empty catch hid it completely. The update audit trail was empty
      // and nothing said so.
      this.config.log?.(
        'warn',
        `an update event could not be recorded (${input.event}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  readHighestAcceptedSequence(): number {
    const row = this.requireDriver()
      .prepare('SELECT highest_accepted_sequence FROM update_state WHERE id = 1')
      .get();
    return Number(row?.highest_accepted_sequence ?? 0);
  }

  writeHighestAcceptedSequence(input: { readonly sequence: number }): void {
    const nowMs = this.nowMs();
    this.requireDriver()
      .prepare(
        `INSERT INTO update_state
           (id, installed_version, last_healthy_version, highest_accepted_sequence, updated_at_ms)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           highest_accepted_sequence = MAX(update_state.highest_accepted_sequence, excluded.highest_accepted_sequence),
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(this.config.appVersion, this.config.appVersion, input.sequence, nowMs);
  }

  /**
   * Graceful shutdown: stop the heartbeat, mark the session stopped, close.
   * Update installation uses this same path.
   */
  async close(options: { markStopped?: boolean } = {}): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const driver = this.driver;
    if (!driver) return;
    if (options.markStopped !== false) {
      try {
        sessionRepository(driver).stop(this.sessionId, this.nowMs());
      } catch {
        /* a failed stop marker becomes a recorded gap on next launch */
      }
    }
    this.queries = null;
    this.driver = null;
    try {
      driver.close();
    } catch {
      /* ignore */
    }
  }

  /** Filename helper shared with the renderer's Save As default. */
  suggestExportFileName(kind: string, window: { startMs: number; endMs: number }): string {
    return exportFileName({
      area: STUDY_AREA_DEFAULTS.label,
      fromIsoDate: new Date(window.startMs).toISOString().slice(0, 10),
      toIsoDate: new Date(window.endMs).toISOString().slice(0, 10),
      kind,
    });
  }
}
