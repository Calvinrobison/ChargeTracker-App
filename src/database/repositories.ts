/**
 * Repository layer: the only code that writes SQL against the ChargeWatch
 * database. The renderer cannot reach it; the collector cannot reach it. Both
 * go through validated messages to the database worker, which owns this.
 *
 * Every function here uses prepared statements and explicit column lists.
 */

import type { SqlValue, SqliteDriver } from './driver.ts';
import { transact } from './driver.ts';
import type {
  CapacityRecord,
  ChargingLevel,
  CollectionGap,
  MonitoringWindow,
  StatusSnapshot,
} from '../domain/types.ts';
import type { PortSnapshot } from '../domain/types.ts';

function asNumberOrNull(value: SqlValue | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function asStringOrNull(value: SqlValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function bool(value: SqlValue | undefined): boolean {
  return Number(value ?? 0) === 1;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SettingsRepository {
  get(key: string): unknown;
  getAll(): Record<string, unknown>;
  set(key: string, value: unknown, nowMs: number): void;
  setMany(entries: Readonly<Record<string, unknown>>, nowMs: number): void;
}

export function settingsRepository(driver: SqliteDriver): SettingsRepository {
  const selectOne = driver.prepare('SELECT value_json FROM app_settings WHERE key = ?');
  const selectAll = driver.prepare('SELECT key, value_json FROM app_settings');
  const upsert = driver.prepare(
    `INSERT INTO app_settings (key, value_json, schema_version, updated_at_ms)
     VALUES (?, ?, 1, ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms`,
  );

  // Takes `SqlValue | undefined` because a column the query did not select is
  // genuinely absent, which the body already distinguishes from a stored null.
  const parse = (raw: SqlValue | undefined): unknown => {
    if (raw === null || raw === undefined) return undefined;
    try {
      return JSON.parse(String(raw)) as unknown;
    } catch {
      return undefined;
    }
  };

  return {
    get(key) {
      return parse(selectOne.get(key)?.value_json ?? null);
    },
    getAll() {
      const out: Record<string, unknown> = {};
      for (const row of selectAll.all()) out[String(row.key)] = parse(row.value_json);
      return out;
    },
    set(key, value, nowMs) {
      upsert.run(key, JSON.stringify(value ?? null), nowMs);
    },
    setMany(entries, nowMs) {
      transact(driver, () => {
        for (const [key, value] of Object.entries(entries)) {
          upsert.run(key, JSON.stringify(value ?? null), nowMs);
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Catalog and sites
// ---------------------------------------------------------------------------

export interface CatalogImportRecord {
  readonly sourceName: string;
  readonly sourceUrl: string | null;
  readonly retrievedAtMs: number;
  readonly importedAtMs: number;
  readonly license: string;
  readonly attribution: string;
  readonly fileSha256: string;
  readonly fieldMapping: Readonly<Record<string, string>>;
  readonly centerLatitude: number;
  readonly centerLongitude: number;
  readonly radiusMiles: number;
  readonly rowCount: number;
  readonly outcome: 'succeeded' | 'partial' | 'failed';
  readonly notes: string | null;
}

export interface SiteRecord {
  readonly id: string;
  readonly registryStationId: string | null;
  readonly name: string;
  readonly streetAddress: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly normalizedAddress: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly distanceMiles: number | null;
  readonly network: string | null;
  readonly accessCondition: 'public' | 'restricted' | 'private' | 'unknown';
  readonly hoursText: string | null;
  readonly timezone: string;
  readonly catalogPortCount: number | null;
  readonly catalogLevel: ChargingLevel;
}

/** Fields a catalog refresh may propose changing. */
const CATALOG_MANAGED_FIELDS = [
  'name',
  'street_address',
  'city',
  'state',
  'postal_code',
  'normalized_address',
  'latitude',
  'longitude',
  'network',
  'access_condition',
  'hours_text',
  'catalog_port_count',
  'catalog_level',
] as const;

export interface SitesRepository {
  recordCatalogImport(record: CatalogImportRecord): number;
  /**
   * Inserts or updates catalog rows.
   *
   * A refresh never erases observations and never overwrites a field the user
   * corrected: the incoming value is recorded in site_conflicts for review.
   */
  upsertFromCatalog(
    catalogImportId: number,
    rows: readonly SiteRecord[],
    nowMs: number,
  ): { inserted: number; updated: number; conflicts: number };
  get(siteId: string): SiteRecord | null;
  listIds(): string[];
  setSaved(siteId: string, saved: boolean, nowMs: number): void;
  count(): { total: number; archived: number };
}

export function sitesRepository(driver: SqliteDriver): SitesRepository {
  const insertImport = driver.prepare(
    `INSERT INTO catalog_imports
       (source_name, source_url, retrieved_at_ms, imported_at_ms, license, attribution,
        file_sha256, field_mapping_json, bounds_center_lat, bounds_center_lon,
        bounds_radius_miles, row_count, outcome, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (source_name, file_sha256) DO UPDATE SET
       imported_at_ms = excluded.imported_at_ms,
       row_count = excluded.row_count,
       outcome = excluded.outcome
     RETURNING id`,
  );

  const selectSite = driver.prepare(
    `SELECT id, registry_station_id, name, street_address, city, state, postal_code,
            normalized_address, latitude, longitude, distance_miles, network,
            access_condition, hours_text, timezone, catalog_port_count, catalog_level
       FROM sites WHERE id = ?`,
  );

  const selectExisting = driver.prepare(
    `SELECT id, user_corrected, user_corrections_json, name, street_address, city, state,
            postal_code, normalized_address, latitude, longitude, network, access_condition,
            hours_text, catalog_port_count, catalog_level
       FROM sites WHERE id = ?`,
  );

  const insertSite = driver.prepare(
    `INSERT INTO sites
       (id, catalog_import_id, registry_station_id, name, street_address, city, state,
        postal_code, normalized_address, latitude, longitude, distance_miles, network,
        access_condition, hours_text, timezone, catalog_port_count, catalog_level,
        archived, user_corrected, saved, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,?,?)`,
  );

  const updateSite = driver.prepare(
    `UPDATE sites SET
       catalog_import_id = ?, registry_station_id = ?, name = ?, street_address = ?, city = ?,
       state = ?, postal_code = ?, normalized_address = ?, latitude = ?, longitude = ?,
       distance_miles = ?, network = ?, access_condition = ?, hours_text = ?,
       catalog_port_count = ?, catalog_level = ?, updated_at_ms = ?
     WHERE id = ?`,
  );

  const insertConflict = driver.prepare(
    `INSERT INTO site_conflicts (site_id, catalog_import_id, field, existing_value, incoming_value, resolution, detected_at_ms)
     VALUES (?,?,?,?,?,'pending',?)`,
  );

  const setSavedStmt = driver.prepare('UPDATE sites SET saved = ?, updated_at_ms = ? WHERE id = ?');

  const mapSite = (row: Record<string, SqlValue>): SiteRecord => ({
    id: String(row.id),
    registryStationId: asStringOrNull(row.registry_station_id),
    name: String(row.name),
    streetAddress: asStringOrNull(row.street_address),
    city: asStringOrNull(row.city),
    state: asStringOrNull(row.state),
    postalCode: asStringOrNull(row.postal_code),
    normalizedAddress: asStringOrNull(row.normalized_address),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    distanceMiles: asNumberOrNull(row.distance_miles),
    network: asStringOrNull(row.network),
    accessCondition: String(row.access_condition) as SiteRecord['accessCondition'],
    hoursText: asStringOrNull(row.hours_text),
    timezone: String(row.timezone),
    catalogPortCount: asNumberOrNull(row.catalog_port_count),
    catalogLevel: String(row.catalog_level) as ChargingLevel,
  });

  return {
    recordCatalogImport(record) {
      const row = insertImport.get(
        record.sourceName,
        record.sourceUrl,
        record.retrievedAtMs,
        record.importedAtMs,
        record.license,
        record.attribution,
        record.fileSha256,
        JSON.stringify(record.fieldMapping),
        record.centerLatitude,
        record.centerLongitude,
        record.radiusMiles,
        record.rowCount,
        record.outcome,
        record.notes,
      );
      return Number(row?.id ?? 0);
    },

    upsertFromCatalog(catalogImportId, rows, nowMs) {
      let inserted = 0;
      let updated = 0;
      let conflicts = 0;

      transact(driver, () => {
        for (const row of rows) {
          const existing = selectExisting.get(row.id);
          if (!existing) {
            insertSite.run(
              row.id,
              catalogImportId,
              row.registryStationId,
              row.name,
              row.streetAddress,
              row.city,
              row.state,
              row.postalCode,
              row.normalizedAddress,
              row.latitude,
              row.longitude,
              row.distanceMiles,
              row.network,
              row.accessCondition,
              row.hoursText,
              row.timezone,
              row.catalogPortCount,
              row.catalogLevel,
              nowMs,
              nowMs,
            );
            inserted += 1;
            continue;
          }

          const corrected: string[] = bool(existing.user_corrected)
            ? ((JSON.parse(String(existing.user_corrections_json ?? '[]')) as string[]) ?? [])
            : [];

          const incoming: Record<string, SqlValue> = {
            name: row.name,
            street_address: row.streetAddress,
            city: row.city,
            state: row.state,
            postal_code: row.postalCode,
            normalized_address: row.normalizedAddress,
            latitude: row.latitude,
            longitude: row.longitude,
            network: row.network,
            access_condition: row.accessCondition,
            hours_text: row.hoursText,
            catalog_port_count: row.catalogPortCount,
            catalog_level: row.catalogLevel,
          };

          // Record a conflict for every user-corrected field the catalog wants
          // to change, and keep the user's value.
          const merged: Record<string, SqlValue> = { ...incoming };
          for (const field of CATALOG_MANAGED_FIELDS) {
            if (!corrected.includes(field)) continue;
            const existingValue = existing[field] ?? null;
            const incomingValue = incoming[field] ?? null;
            if (String(existingValue) !== String(incomingValue)) {
              insertConflict.run(
                row.id,
                catalogImportId,
                field,
                existingValue === null ? null : String(existingValue),
                incomingValue === null ? null : String(incomingValue),
                nowMs,
              );
              conflicts += 1;
            }
            merged[field] = existingValue;
          }

          // `?? null` on every merged field: an absent key binds as SQL NULL,
          // never as '' or 0. The columns that cannot be null are enforced by
          // the schema, so a genuinely missing required field fails loudly at
          // the constraint instead of being written as a plausible blank.
          const mergedField = (name: string): SqlValue => merged[name] ?? null;
          updateSite.run(
            catalogImportId,
            row.registryStationId,
            mergedField('name'),
            mergedField('street_address'),
            mergedField('city'),
            mergedField('state'),
            mergedField('postal_code'),
            mergedField('normalized_address'),
            mergedField('latitude'),
            mergedField('longitude'),
            row.distanceMiles,
            mergedField('network'),
            mergedField('access_condition'),
            mergedField('hours_text'),
            mergedField('catalog_port_count'),
            mergedField('catalog_level'),
            nowMs,
            row.id,
          );
          updated += 1;
        }
      });

      return { inserted, updated, conflicts };
    },

    get(siteId) {
      const row = selectSite.get(siteId);
      return row ? mapSite(row) : null;
    },

    listIds() {
      return driver
        .prepare('SELECT id FROM sites WHERE archived = 0 ORDER BY id')
        .all()
        .map((r) => String(r.id));
    },

    setSaved(siteId, saved, nowMs) {
      setSavedStmt.run(saved ? 1 : 0, nowMs, siteId);
    },

    count() {
      const row = driver
        .prepare('SELECT COUNT(*) AS total, SUM(archived) AS archived FROM sites')
        .get();
      return { total: Number(row?.total ?? 0), archived: Number(row?.archived ?? 0) };
    },
  };
}

// ---------------------------------------------------------------------------
// Capacity, monitoring windows and gaps
// ---------------------------------------------------------------------------

export interface CoverageRepository {
  setCapacity(record: CapacityRecord & { siteId: string; source: 'catalog' | 'source_observation' | 'user' }, nowMs: number): void;
  capacityFor(scopeKeys: readonly string[]): CapacityRecord[];
  openMonitoring(scopeKey: string, bindingId: string, startedMs: number, intervalMs: number): void;
  closeMonitoring(scopeKey: string, endedMs: number): void;
  monitoringFor(scopeKeys: readonly string[]): MonitoringWindow[];
  recordGap(gap: CollectionGap, detail?: string): void;
  gapsFor(scopeKeys: readonly string[]): CollectionGap[];
}

export function coverageRepository(driver: SqliteDriver): CoverageRepository {
  const upsertCapacity = driver.prepare(
    `INSERT INTO capacity_history
       (scope_key, site_id, effective_from_ms, effective_to_ms, capacity_ports, level, basis, reported_power_kw, source, recorded_at_ms)
     VALUES (?,?,?,?,?,?,?,NULL,?,?)
     ON CONFLICT (scope_key, effective_from_ms) DO UPDATE SET
       effective_to_ms = excluded.effective_to_ms,
       capacity_ports = excluded.capacity_ports,
       level = excluded.level,
       basis = excluded.basis,
       recorded_at_ms = excluded.recorded_at_ms`,
  );

  const insertMonitoring = driver.prepare(
    `INSERT INTO monitoring_intervals (scope_key, binding_id, started_ms, ended_ms, interval_ms)
     VALUES (?,?,?,NULL,?)
     ON CONFLICT (scope_key, started_ms) DO NOTHING`,
  );

  const closeMonitoringStmt = driver.prepare(
    `UPDATE monitoring_intervals SET ended_ms = ?
       WHERE scope_key = ? AND ended_ms IS NULL AND started_ms < ?`,
  );

  const insertGap = driver.prepare(
    `INSERT INTO collection_gaps (scope_key, started_ms, ended_ms, reason, detail) VALUES (?,?,?,?,?)`,
  );

  const placeholders = (n: number): string => new Array(n).fill('?').join(',');

  return {
    setCapacity(record, nowMs) {
      upsertCapacity.run(
        record.scopeKey,
        record.siteId,
        record.startMs,
        record.endMs,
        record.capacityPorts,
        record.level,
        record.basis,
        record.source,
        nowMs,
      );
    },

    capacityFor(scopeKeys) {
      if (scopeKeys.length === 0) return [];
      return driver
        .prepare(
          `SELECT scope_key, effective_from_ms, effective_to_ms, capacity_ports, level, basis
             FROM capacity_history WHERE scope_key IN (${placeholders(scopeKeys.length)})
             ORDER BY scope_key, effective_from_ms`,
        )
        .all(...scopeKeys)
        .map((row) => ({
          scopeKey: String(row.scope_key),
          startMs: Number(row.effective_from_ms),
          endMs: asNumberOrNull(row.effective_to_ms),
          capacityPorts: Number(row.capacity_ports),
          level: String(row.level) as ChargingLevel,
          basis: String(row.basis) as CapacityRecord['basis'],
        }));
    },

    openMonitoring(scopeKey, bindingId, startedMs, intervalMs) {
      insertMonitoring.run(scopeKey, bindingId, startedMs, intervalMs);
    },

    closeMonitoring(scopeKey, endedMs) {
      closeMonitoringStmt.run(endedMs, scopeKey, endedMs);
    },

    monitoringFor(scopeKeys) {
      if (scopeKeys.length === 0) return [];
      return driver
        .prepare(
          `SELECT scope_key, started_ms, ended_ms FROM monitoring_intervals
             WHERE scope_key IN (${placeholders(scopeKeys.length)}) ORDER BY scope_key, started_ms`,
        )
        .all(...scopeKeys)
        .map((row) => ({
          scopeKey: String(row.scope_key),
          startMs: Number(row.started_ms),
          endMs: asNumberOrNull(row.ended_ms),
        }));
    },

    recordGap(gap, detail) {
      insertGap.run(gap.scopeKey, gap.startMs, gap.endMs, gap.reason, detail ?? null);
    },

    gapsFor(scopeKeys) {
      const rows =
        scopeKeys.length === 0
          ? driver.prepare('SELECT scope_key, started_ms, ended_ms, reason FROM collection_gaps WHERE scope_key IS NULL').all()
          : driver
              .prepare(
                `SELECT scope_key, started_ms, ended_ms, reason FROM collection_gaps
                   WHERE scope_key IS NULL OR scope_key IN (${placeholders(scopeKeys.length)})
                   ORDER BY started_ms`,
              )
              .all(...scopeKeys);
      return rows.map((row) => ({
        scopeKey: asStringOrNull(row.scope_key),
        startMs: Number(row.started_ms),
        endMs: Number(row.ended_ms),
        reason: String(row.reason) as CollectionGap['reason'],
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

export interface IngestObservation {
  readonly id: string;
  readonly bindingId: string;
  readonly siteId: string;
  readonly scopeKey: string;
  readonly observedAtUtcMs: number;
  readonly sourceUpdatedAtUtcMs: number | null;
  readonly method: StatusSnapshot['method'];
  readonly granularity: StatusSnapshot['granularity'];
  readonly counts: StatusSnapshot['counts'];
  readonly capacityBasis: StatusSnapshot['capacityBasis'];
  readonly completeness: StatusSnapshot['completeness'];
  readonly level: ChargingLevel;
  readonly distinguishesCharging: boolean;
  readonly freshnessPolicy: StatusSnapshot['freshnessPolicy'];
  readonly sourceUrl: string;
  readonly parserVersion: string;
  readonly evidenceFingerprint: string;
  readonly sanitizedSourceText: string | null;
  readonly quality: StatusSnapshot['quality'];
  readonly sourceFreshness: 'fresh' | 'stale' | 'unknown_source_clock';
  readonly validation: unknown;
  readonly ports: readonly {
    readonly portId: string;
    readonly sourcePortId: string;
    readonly state: PortSnapshot['state'];
    readonly level: ChargingLevel;
  }[];
}

export interface IngestResult {
  readonly written: number;
  readonly deduplicated: number;
  readonly portRowsWritten: number;
}

export interface ObservationsRepository {
  /**
   * Writes a validated batch.
   *
   * Idempotent on (run_id, binding_id, scope_key), so retrying one attempt
   * cannot double-write. A repeated identical status at a NEW run is a new
   * observation and is kept: repeated evidence is evidence.
   */
  ingest(runId: string, observations: readonly IngestObservation[]): IngestResult;
  snapshotsFor(scopeKeys: readonly string[], fromMs: number, toMs: number): StatusSnapshot[];
  portSnapshotsFor(scopeKeys: readonly string[], fromMs: number, toMs: number): PortSnapshot[];
  latestFor(scopeKey: string): StatusSnapshot | null;
  /** Earliest observation instant in the database, i.e. the study start. */
  studyStartMs(): number | null;
  countAll(): number;
  deleteBefore(cutoffMs: number): number;
}

export function observationsRepository(driver: SqliteDriver): ObservationsRepository {
  const insertObservation = driver.prepare(
    `INSERT INTO observations
       (id, run_id, binding_id, site_id, scope_key, observed_at_ms, source_updated_at_ms,
        method, granularity, available_count, occupied_count, reserved_count,
        out_of_service_count, unknown_count, reported_total, capacity_basis, completeness,
        level, distinguishes_charging, scheduled_interval_ms, max_carry_forward_cap_ms,
        source_freshness_limit_ms, source_url, parser_version, evidence_fingerprint,
        sanitized_source_text, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (run_id, binding_id, scope_key) DO NOTHING`,
  );

  const insertQuality = driver.prepare(
    `INSERT INTO observation_quality
       (observation_id, quality, source_freshness, validation_json, ambiguous, corrected)
     VALUES (?,?,?,?,?,0)
     ON CONFLICT (observation_id) DO NOTHING`,
  );

  const insertPortObservation = driver.prepare(
    `INSERT INTO port_observations
       (observation_id, port_id, scope_key, source_port_id, observed_at_ms, state, level)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT (observation_id, port_id) DO NOTHING`,
  );

  const SNAPSHOT_COLUMNS = `
      o.id, o.binding_id, o.scope_key, o.observed_at_ms, o.source_updated_at_ms, o.method,
      o.granularity, o.available_count, o.occupied_count, o.reserved_count,
      o.out_of_service_count, o.unknown_count, o.reported_total, o.capacity_basis,
      o.completeness, o.level, o.distinguishes_charging, o.scheduled_interval_ms,
      o.max_carry_forward_cap_ms, o.source_freshness_limit_ms, q.quality`;

  const mapSnapshot = (row: Record<string, SqlValue>): StatusSnapshot => ({
    observationId: String(row.id),
    bindingId: String(row.binding_id),
    scopeKey: String(row.scope_key),
    observedAtUtcMs: Number(row.observed_at_ms),
    sourceUpdatedAtUtcMs: asNumberOrNull(row.source_updated_at_ms),
    method: String(row.method) as StatusSnapshot['method'],
    granularity: String(row.granularity) as StatusSnapshot['granularity'],
    counts: {
      available: asNumberOrNull(row.available_count),
      occupied: asNumberOrNull(row.occupied_count),
      reserved: asNumberOrNull(row.reserved_count),
      outOfService: asNumberOrNull(row.out_of_service_count),
      unknown: asNumberOrNull(row.unknown_count),
      total: asNumberOrNull(row.reported_total),
    },
    capacityBasis: String(row.capacity_basis) as StatusSnapshot['capacityBasis'],
    completeness: String(row.completeness) as StatusSnapshot['completeness'],
    quality: (asStringOrNull(row.quality) ?? 'reliable') as StatusSnapshot['quality'],
    freshnessPolicy: {
      scheduledIntervalMs: Number(row.scheduled_interval_ms),
      maxCarryForwardCapMs: Number(row.max_carry_forward_cap_ms),
      sourceFreshnessLimitMs: asNumberOrNull(row.source_freshness_limit_ms),
    },
    level: String(row.level) as ChargingLevel,
    distinguishesCharging: bool(row.distinguishes_charging),
  });

  const placeholders = (n: number): string => new Array(n).fill('?').join(',');

  return {
    ingest(runId, observations) {
      let written = 0;
      let deduplicated = 0;
      let portRowsWritten = 0;

      transact(driver, () => {
        for (const obs of observations) {
          const result = insertObservation.run(
            obs.id,
            runId,
            obs.bindingId,
            obs.siteId,
            obs.scopeKey,
            obs.observedAtUtcMs,
            obs.sourceUpdatedAtUtcMs,
            obs.method,
            obs.granularity,
            obs.counts.available,
            obs.counts.occupied,
            obs.counts.reserved,
            obs.counts.outOfService,
            obs.counts.unknown,
            obs.counts.total,
            obs.capacityBasis,
            obs.completeness,
            obs.level,
            obs.distinguishesCharging ? 1 : 0,
            obs.freshnessPolicy.scheduledIntervalMs,
            obs.freshnessPolicy.maxCarryForwardCapMs,
            obs.freshnessPolicy.sourceFreshnessLimitMs,
            obs.sourceUrl,
            obs.parserVersion,
            obs.evidenceFingerprint,
            obs.sanitizedSourceText,
            obs.observedAtUtcMs,
          );

          if (Number(result.changes) === 0) {
            deduplicated += 1;
            continue;
          }
          written += 1;

          insertQuality.run(
            obs.id,
            obs.quality,
            obs.sourceFreshness,
            obs.validation === undefined ? null : JSON.stringify(obs.validation),
            obs.quality === 'ambiguous_scope' ? 1 : 0,
          );

          for (const port of obs.ports) {
            const portResult = insertPortObservation.run(
              obs.id,
              port.portId,
              obs.scopeKey,
              port.sourcePortId,
              obs.observedAtUtcMs,
              port.state,
              port.level,
            );
            if (Number(portResult.changes) > 0) portRowsWritten += 1;
          }
        }
      });

      return { written, deduplicated, portRowsWritten };
    },

    snapshotsFor(scopeKeys, fromMs, toMs) {
      if (scopeKeys.length === 0) return [];
      return driver
        .prepare(
          `SELECT ${SNAPSHOT_COLUMNS}
             FROM observations o
             LEFT JOIN observation_quality q ON q.observation_id = o.id
            WHERE o.scope_key IN (${placeholders(scopeKeys.length)})
              AND o.observed_at_ms >= ? AND o.observed_at_ms < ?
            ORDER BY o.scope_key, o.observed_at_ms`,
        )
        .all(...scopeKeys, fromMs, toMs)
        .map(mapSnapshot);
    },

    portSnapshotsFor(scopeKeys, fromMs, toMs) {
      if (scopeKeys.length === 0) return [];
      return driver
        .prepare(
          `SELECT observation_id, scope_key, source_port_id, observed_at_ms, state, level
             FROM port_observations
            WHERE scope_key IN (${placeholders(scopeKeys.length)})
              AND observed_at_ms >= ? AND observed_at_ms < ?
            ORDER BY scope_key, source_port_id, observed_at_ms`,
        )
        .all(...scopeKeys, fromMs, toMs)
        .map((row) => ({
          observationId: String(row.observation_id),
          scopeKey: String(row.scope_key),
          sourcePortId: String(row.source_port_id),
          observedAtUtcMs: Number(row.observed_at_ms),
          state: String(row.state) as PortSnapshot['state'],
          level: String(row.level) as ChargingLevel,
        }));
    },

    latestFor(scopeKey) {
      const row = driver
        .prepare(
          `SELECT ${SNAPSHOT_COLUMNS}
             FROM observations o
             LEFT JOIN observation_quality q ON q.observation_id = o.id
            WHERE o.scope_key = ?
            ORDER BY o.observed_at_ms DESC LIMIT 1`,
        )
        .get(scopeKey);
      return row ? mapSnapshot(row) : null;
    },

    studyStartMs() {
      const row = driver.prepare('SELECT MIN(observed_at_ms) AS m FROM observations').get();
      return asNumberOrNull(row?.m ?? null);
    },

    countAll() {
      return Number(driver.prepare('SELECT COUNT(*) AS c FROM observations').get()?.c ?? 0);
    },

    /**
     * Explicit user-initiated deletion only. Nothing in the product calls this
     * automatically to free space.
     */
    deleteBefore(cutoffMs) {
      const result = driver.prepare('DELETE FROM observations WHERE observed_at_ms < ?').run(cutoffMs);
      return Number(result.changes);
    },
  };
}

// ---------------------------------------------------------------------------
// Derived aggregate cache
// ---------------------------------------------------------------------------

export interface MetricsCacheRepository {
  /** Marks cached aggregates stale after late data or a mapping correction. */
  invalidate(scopeKey: string, fromMs: number, toMs: number, timeZone: string): number;
  invalidateAll(): number;
  staleCount(): number;
}

export function metricsCacheRepository(driver: SqliteDriver): MetricsCacheRepository {
  return {
    invalidate(scopeKey, fromMs, toMs, timeZone) {
      // Local dates are derived by the caller's timezone rules; the cache stores
      // the timezone it was computed under so a mismatch invalidates too.
      const fromDate = new Date(fromMs).toISOString().slice(0, 10);
      const toDate = new Date(toMs).toISOString().slice(0, 10);
      const result = driver
        .prepare(
          `UPDATE hourly_metrics SET stale = 1
             WHERE scope_key = ?
               AND (local_date BETWEEN ? AND ? OR timezone <> ?)`,
        )
        .run(scopeKey, fromDate, toDate, timeZone);
      return Number(result.changes);
    },
    invalidateAll() {
      return Number(driver.prepare('UPDATE hourly_metrics SET stale = 1').run().changes);
    },
    staleCount() {
      return Number(driver.prepare('SELECT COUNT(*) AS c FROM hourly_metrics WHERE stale = 1').get()?.c ?? 0);
    },
  };
}

// ---------------------------------------------------------------------------
// Sessions and recovery
// ---------------------------------------------------------------------------

export interface SessionRepository {
  start(id: string, appVersion: string, schemaVersion: number, nowMs: number): void;
  heartbeat(id: string, nowMs: number, collectionRunning: boolean, userPaused: boolean): void;
  stop(id: string, nowMs: number): void;
  /**
   * Marks sessions that never recorded an end as crashed and returns the gap
   * each one left, so missing coverage is recorded instead of interpolated.
   */
  recoverUncleanSessions(currentId: string, nowMs: number): Array<{
    sessionId: string;
    startedMs: number;
    lastHeartbeatMs: number;
    collectionRunning: boolean;
    userPaused: boolean;
  }>;
}

export function sessionRepository(driver: SqliteDriver): SessionRepository {
  return {
    start(id, appVersion, schemaVersion, nowMs) {
      driver
        .prepare(
          `INSERT INTO app_sessions
             (id, app_version, schema_version, started_ms, last_heartbeat_ms, ended_ms, state, collection_running, user_paused)
           VALUES (?,?,?,?,?,NULL,'running',0,0)`,
        )
        .run(id, appVersion, schemaVersion, nowMs, nowMs);
    },
    heartbeat(id, nowMs, collectionRunning, userPaused) {
      driver
        .prepare(
          `UPDATE app_sessions SET last_heartbeat_ms = ?, collection_running = ?, user_paused = ? WHERE id = ?`,
        )
        .run(nowMs, collectionRunning ? 1 : 0, userPaused ? 1 : 0, id);
    },
    stop(id, nowMs) {
      driver
        .prepare(`UPDATE app_sessions SET ended_ms = ?, state = 'stopped' WHERE id = ?`)
        .run(nowMs, id);
    },
    recoverUncleanSessions(currentId, nowMs) {
      const rows = driver
        .prepare(
          `SELECT id, started_ms, last_heartbeat_ms, collection_running, user_paused
             FROM app_sessions WHERE state = 'running' AND id <> ?`,
        )
        .all(currentId);
      if (rows.length > 0) {
        driver
          .prepare(`UPDATE app_sessions SET state = 'crashed', ended_ms = ? WHERE state = 'running' AND id <> ?`)
          .run(nowMs, currentId);
      }
      return rows.map((row) => ({
        sessionId: String(row.id),
        startedMs: Number(row.started_ms),
        lastHeartbeatMs: Number(row.last_heartbeat_ms),
        collectionRunning: bool(row.collection_running),
        userPaused: bool(row.user_paused),
      }));
    },
  };
}
