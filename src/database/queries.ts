/**
 * The query service: turns stored observations into the view models the UI
 * consumes, using the shared domain module for every calculation.
 *
 * Nothing here recomputes a metric. It loads the inputs, calls
 * `buildScopeIntervals` / `computeScopeMetrics` / `rankScopes`, and formats.
 * That is why the Overview table, the map colours, the detail drawer and the
 * CSV export cannot disagree.
 */

import type { SqlValue, SqliteDriver } from './driver.ts';
import {
  coverageRepository,
  observationsRepository,
  type CoverageRepository,
  type ObservationsRepository,
} from './repositories.ts';
import {
  type Interval,
  type ScopeIntervalSet,
  type ScopeMetrics,
  type StatusSnapshot,
  DAY_MS,
  STUDY_TIME_ZONE,
  activityCapability,
  aggregateScopeMetrics,
  buildScopeIntervals,
  classifySourceFreshness,
  computeHeatmap,
  computeScopeMetrics,
  detectPortEpisodes,
  elapsedDays,
  evaluateEligibility,
  METRIC_ALGORITHM_VERSION,
  NO_SESSION_RECORDS_EXPLANATION,
  observedOccupiedIncreases,
  matchesRange,
  normalizeRange,
  rankScopes,
  resolveCapacity,
  resolveWindow,
  splitByLocalHour,
  toLocalParts,
  type CohortMode,
  type RankSort,
  type WindowRequest,
} from '../domain/index.ts';
import type {
  CollectionStatusView,
  FilterState,
  HeatmapCellView,
  StationDetailView,
  StationView,
  SummaryView,
  TrendPointView,
  TrendView,
  VisitsPanelView,
} from '../shared/ipc.ts';

/**
 * Column readers.
 *
 * They take `SqlValue | undefined` because `noUncheckedIndexedAccess` types
 * every `row.column` as possibly undefined -- correctly: a column the query did
 * not select is genuinely absent, not null. Handling both here is the point of
 * these helpers, and it keeps the distinction that matters everywhere else
 * intact: a column that IS selected and IS null returns null, never 0 or ''.
 */
function num(value: SqlValue | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}
function str(value: SqlValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** Formats a relative time the way the UI shows it, e.g. "6 min ago". */
export function formatRelative(instantMs: number | null, nowMs: number): string | null {
  if (instantMs === null) return null;
  const deltaMs = Math.max(0, nowMs - instantMs);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const LEVEL_LABELS: Record<string, StationView['type']> = {
  level_1: 'Level 1',
  level_2: 'Level 2',
  dc_fast: 'DC Fast',
  mixed: 'Mixed',
  unknown: null,
};

interface ScopeRow {
  readonly scopeKey: string;
  readonly siteId: string;
  readonly bindingId: string | null;
  readonly sourceId: string | null;
  readonly enabled: boolean;
  readonly name: string;
  readonly address: string | null;
  readonly network: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly catalogPortCount: number | null;
  readonly catalogLevel: string;
  readonly saved: boolean;
  readonly canonicalUrl: string | null;
  readonly physicalScope: string | null;
  readonly identityReliability: string | null;
}

export interface QueryServiceOptions {
  readonly timeZone?: string;
  readonly nowMs: () => number;
}

export class QueryService {
  private readonly driver: SqliteDriver;
  private readonly observations: ObservationsRepository;
  private readonly coverage: CoverageRepository;
  private readonly timeZone: string;
  private readonly nowMs: () => number;

  constructor(driver: SqliteDriver, options: QueryServiceOptions) {
    this.driver = driver;
    this.observations = observationsRepository(driver);
    this.coverage = coverageRepository(driver);
    this.timeZone = options.timeZone ?? STUDY_TIME_ZONE;
    this.nowMs = options.nowMs;
  }

  /**
   * Loads every catalog site, joined to its primary binding where one exists.
   *
   * Catalog-only sites are included deliberately: the map and the counts must
   * show all known public sites in scope, not only the monitored subset.
   */
  private loadScopeRows(): ScopeRow[] {
    return this.driver
      .prepare(
        `SELECT
           s.id           AS site_id,
           s.name         AS name,
           s.street_address AS address,
           s.city         AS city,
           s.network      AS network,
           s.latitude     AS latitude,
           s.longitude    AS longitude,
           s.catalog_port_count AS catalog_port_count,
           s.catalog_level AS catalog_level,
           s.saved        AS saved,
           b.id           AS binding_id,
           b.source_id    AS source_id,
           b.scope_key    AS scope_key,
           b.enabled      AS enabled,
           b.canonical_url AS canonical_url,
           b.physical_scope AS physical_scope,
           b.identity_reliability AS identity_reliability
         FROM sites s
         LEFT JOIN source_bindings b
           ON b.site_id = s.id AND b.is_primary = 1 AND b.effective_to_ms IS NULL
        WHERE s.archived = 0
        ORDER BY s.name`,
      )
      .all()
      .map((row) => ({
        scopeKey: str(row.scope_key) ?? `catalog:${String(row.site_id)}`,
        siteId: String(row.site_id),
        bindingId: str(row.binding_id),
        sourceId: str(row.source_id),
        enabled: Number(row.enabled ?? 0) === 1,
        name: String(row.name),
        address: [str(row.address), str(row.city)].filter(Boolean).join(', ') || null,
        network: str(row.network),
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        catalogPortCount: num(row.catalog_port_count),
        catalogLevel: String(row.catalog_level),
        saved: Number(row.saved ?? 0) === 1,
        canonicalUrl: str(row.canonical_url),
        physicalScope: str(row.physical_scope),
        identityReliability: str(row.identity_reliability),
      }));
  }

  studyStartMs(): number | null {
    return this.observations.studyStartMs();
  }

  /** Resolves the shared study window once, for every ranked location. */
  resolveSharedWindow(request: WindowRequest) {
    return resolveWindow(request, this.nowMs(), this.studyStartMs());
  }

  private buildIntervalSets(
    rows: readonly ScopeRow[],
    window: Interval,
  ): Map<string, ScopeIntervalSet> {
    const scopeKeys = rows.filter((r) => r.bindingId !== null).map((r) => r.scopeKey);
    if (scopeKeys.length === 0) return new Map();

    // Load one observation before the window so an interval can be clipped
    // into it rather than lost.
    const lookbackMs = window.startMs - 2 * 60 * 60_000;
    const snapshots = this.observations.snapshotsFor(scopeKeys, lookbackMs, window.endMs);
    const monitoring = this.coverage.monitoringFor(scopeKeys);
    const gaps = this.coverage.gapsFor(scopeKeys);
    const capacity = this.coverage.capacityFor(scopeKeys);

    const byScope = new Map<string, StatusSnapshot[]>();
    for (const snapshot of snapshots) {
      const list = byScope.get(snapshot.scopeKey);
      if (list) list.push(snapshot);
      else byScope.set(snapshot.scopeKey, [snapshot]);
    }

    const sets = new Map<string, ScopeIntervalSet>();
    for (const scopeKey of scopeKeys) {
      sets.set(
        scopeKey,
        buildScopeIntervals({
          scopeKey,
          window,
          snapshots: byScope.get(scopeKey) ?? [],
          monitoringWindows: monitoring,
          gaps,
          capacity,
        }),
      );
    }
    return sets;
  }

  private toStationView(
    row: ScopeRow,
    set: ScopeIntervalSet | undefined,
    metrics: ScopeMetrics | undefined,
    window: Interval,
  ): StationView {
    const nowMs = this.nowMs();
    const latest = row.bindingId ? this.observations.latestFor(row.scopeKey) : null;
    const eligibility = metrics ? evaluateEligibility(metrics) : null;

    let monitoring: StationView['monitoring'] = 'catalog';
    if (row.bindingId !== null && row.enabled) {
      const freshness = latest ? classifySourceFreshness(latest) : null;
      if (freshness === 'stale') monitoring = 'stale';
      else if (eligibility?.eligible) monitoring = 'monitored';
      else monitoring = 'provisional';
    }

    const provisionalReasons = (eligibility?.failures ?? []).map((failure) => {
      switch (failure) {
        case 'insufficient_elapsed_days':
          return 'Fewer than seven days of history in this period';
        case 'insufficient_status_coverage':
          return 'Known-state coverage is below 90% for this period';
        case 'unknown_capacity':
          return 'Installed capacity for this scope is unknown';
        case 'occupancy_unsupported':
          return 'The source does not report both available and occupied counts';
        default:
          return 'The observed scope is ambiguous';
      }
    });

    const scopeNote =
      metrics && row.catalogPortCount !== null && metrics.expectedInstalledPortMinutes !== null
        ? `${describeMonitoredPorts(metrics, window)} monitored of ${row.catalogPortCount} catalog ports`
        : row.bindingId === null
          ? 'Catalog only · not monitored'
          : null;

    // How many ports the SOURCE reported, averaged over the time the scope was
    // actually monitored. Null when nothing was monitored: an unmonitored
    // location has not reported a capacity, which is not the same as zero.
    const sourcePorts =
      metrics && metrics.expectedInstalledPortMinutes !== null && metrics.monitoredMinutes > 0
        ? Math.round(metrics.expectedInstalledPortMinutes / metrics.monitoredMinutes)
        : null;

    // One rule, one place. The filter, the list and the drawer all read the
    // same resolved figure, so a location cannot be filtered by one number and
    // labelled with another.
    const capacity = resolveCapacity({ sourcePorts, catalogPorts: row.catalogPortCount });

    return {
      id: row.siteId,
      name: row.name,
      address: row.address,
      network: row.network,
      type: LEVEL_LABELS[metrics?.level ?? row.catalogLevel] ?? null,
      lat: row.latitude,
      lng: row.longitude,
      ports: sourcePorts,
      catalogPorts: row.catalogPortCount,
      stalls: capacity.stalls,
      stallsBasis: capacity.basis,
      capacityDisagrees: capacity.disagrees,
      available: latest?.counts.available ?? null,
      occupied: latest?.counts.occupied ?? null,
      offline: latest?.counts.outOfService ?? null,
      unknown: latest?.counts.unknown ?? null,
      occupancy: metrics?.observedOccupancyPct ?? null,
      hours: metrics?.estimatedOccupiedPortHours ?? null,
      coverage: metrics?.statusCoveragePct ?? null,
      history:
        metrics && metrics.firstObservationMs !== null
          ? Math.floor((nowMs - metrics.firstObservationMs) / DAY_MS)
          : 0,
      observed: formatRelative(set?.latestObservationMs ?? null, nowMs),
      observedAtMs: set?.latestObservationMs ?? null,
      sourceUpdatedAtMs: latest?.sourceUpdatedAtUtcMs ?? null,
      sourceFreshness: latest ? classifySourceFreshness(latest) : null,
      monitoring,
      linked: row.bindingId !== null,
      monitoringEnabled: row.bindingId !== null && row.enabled,
      eligibleForRanking: eligibility?.eligible ?? false,
      provisionalReasons,
      saved: row.saved,
      peak: null,
      starts: null,
      dwell: null,
      distinguishesCharging: metrics?.distinguishesCharging ?? false,
      scopeNote,
    };
  }

  private applyFilters(stations: readonly StationView[], filters: FilterState): StationView[] {
    const query = filters.query.trim().toLowerCase();
    return stations.filter((station) => {
      if (filters.savedOnly && !station.saved) return false;
      if (
        filters.monitoringStates.length > 0 &&
        !filters.monitoringStates.includes(station.monitoring)
      ) {
        return false;
      }
      if (filters.networks.length > 0) {
        if (!station.network || !filters.networks.includes(station.network)) return false;
      }
      if (filters.chargingTypes.length > 0) {
        const typeKey =
          station.type === 'Level 2'
            ? 'level_2'
            : station.type === 'DC Fast'
              ? 'dc_fast'
              : station.type === 'Level 1'
                ? 'level_1'
                : 'unknown';
        if (!filters.chargingTypes.includes(typeKey)) return false;
      }
      // Capacity: how many stalls the location HAS.
      const stallRange = normalizeRange(filters.stalls);
      if (!matchesRange(station.stalls, stallRange)) return false;

      // Availability: how many are FREE right now. A location that was never
      // observed, or whose source reported no available count, has `null`
      // here and is excluded rather than counted as zero free.
      const freeRange = normalizeRange(filters.freeStalls);
      if (!matchesRange(station.available, freeRange)) return false;

      if (query.length > 0) {
        const haystack = [station.name, station.network, station.type, station.address]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }

  /** Builds the Overview payload. */
  getOverview(input: {
    readonly window: WindowRequest;
    readonly filters: FilterState;
    readonly sort: RankSort;
  }) {
    const resolved = this.resolveSharedWindow(input.window);
    const window = resolved.effective;
    const rows = this.loadScopeRows();
    const sets = this.buildIntervalSets(rows, window);

    const metricsByScope = new Map<string, ScopeMetrics>();
    for (const [scopeKey, set] of sets) metricsByScope.set(scopeKey, computeScopeMetrics(set));

    const allStations = rows.map((row) =>
      this.toStationView(row, sets.get(row.scopeKey), metricsByScope.get(row.scopeKey), window),
    );
    const filtered = this.applyFilters(allStations, input.filters);
    const filteredIds = new Set(filtered.map((s) => s.id));

    const entries = rows
      .filter((row) => row.bindingId !== null && filteredIds.has(row.siteId))
      .map((row) => {
        const metrics = metricsByScope.get(row.scopeKey);
        if (!metrics) return null;
        return {
          scopeKey: row.scopeKey,
          metrics,
          eligibility: evaluateEligibility(metrics),
          level: metrics.level,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    // The IPC contract types `cohort` more loosely than rankScopes accepts;
    // dropping the assertion fails typecheck even though eslint reads it as
    // redundant under its own program.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const ranking = rankScopes(entries, input.filters.cohort as CohortMode, input.sort, window);
    const scopeToStation = new Map<string, StationView>();
    for (const row of rows) {
      const station = filtered.find((s) => s.id === row.siteId);
      if (station) scopeToStation.set(row.scopeKey, station);
    }
    const mapEntries = (list: readonly { scopeKey: string }[]): StationView[] =>
      list
        .map((e) => scopeToStation.get(e.scopeKey))
        .filter((s): s is StationView => s !== undefined);

    const eligibleMetrics = ranking.primary.map((e) => e.metrics);
    const aggregate = aggregateScopeMetrics(eligibleMetrics);
    const monitoredSets = [...sets.entries()]
      .filter(([scopeKey]) => scopeToStation.has(scopeKey))
      .map(([, set]) => set);

    const summary: SummaryView = {
      monitoredLocations: rows.filter((r) => r.bindingId !== null && r.enabled).length,
      catalogLocations: rows.length,
      observedOccupancyPct: aggregate.observedOccupancyPct,
      comparableLocations: aggregate.scopesWithOccupancy,
      occupiedPortHours: aggregate.estimatedOccupiedPortHours,
      statusCoveragePct: aggregate.statusCoveragePct,
      historyDays: this.historyDays(),
      effectiveStartMs: window.startMs,
      effectiveEndMs: window.endMs,
      requestedDays: Math.round(resolved.requestedDays),
      effectiveDays: Math.round(resolved.effectiveDays),
      clippedByStudyStart: resolved.clippedByStudyStart,
      cohortDescription: ranking.disclosure.cohortDescription,
    };

    return {
      summary,
      ranked: mapEntries(ranking.primary),
      provisional: mapEntries(ranking.provisional),
      excludedAmbiguous: mapEntries(ranking.excludedAmbiguous),
      heatmap: toHeatmapView(monitoredSets, this.timeZone),
      trend: this.buildTrend(monitoredSets, window),
      totalCount: filtered.length,
    };
  }

  /** Builds the Map payload. Same filters, same window, same metrics. */
  getMapMarkers(input: {
    readonly window: WindowRequest;
    readonly filters: FilterState;
    readonly sort: RankSort;
    readonly metric: 'occupancy' | 'current' | 'coverage' | 'visits';
  }) {
    const overview = this.getOverview(input);
    const visitsAvailable =
      Number(this.driver.prepare('SELECT COUNT(*) AS c FROM visit_observations').get()?.c ?? 0) > 0;

    // Always include catalog-only and provisional locations; the map shows them
    // grey unless the user explicitly filters them out.
    const stations = [...overview.ranked, ...overview.provisional, ...overview.excludedAmbiguous];
    const seen = new Set(stations.map((s) => s.id));
    const resolved = this.resolveSharedWindow(input.window);
    const rows = this.loadScopeRows();
    for (const row of rows) {
      if (seen.has(row.siteId)) continue;
      stations.push(this.toStationView(row, undefined, undefined, resolved.effective));
    }

    return {
      stations: this.applyFilters(stations, input.filters),
      summary: overview.summary,
      legendMetric: input.metric,
      // The visits metric stays disabled until legitimate visit data exists.
      visitsMetricAvailable: visitsAvailable,
    };
  }

  private historyDays(): number {
    const start = this.studyStartMs();
    if (start === null) return 0;
    return Math.max(0, Math.floor((this.nowMs() - start) / DAY_MS));
  }

  /**
   * Builds the daily occupancy trend.
   *
   * A day with no observation is a null point, which the chart draws as a PATH
   * BREAK. It is never plotted as zero.
   */
  private buildTrend(sets: readonly ScopeIntervalSet[], window: Interval): TrendView {
    const occupiedByDate = new Map<string, number>();
    const operationalByDate = new Map<string, number>();

    for (const set of sets) {
      for (const interval of set.intervals) {
        if (!interval.counts.supportsOccupancy) continue;
        const occupied = interval.counts.occupied ?? 0;
        const operational = interval.counts.operationalCount ?? 0;
        for (const piece of splitByLocalHour(interval.span, this.timeZone)) {
          const minutes = (piece.span.endMs - piece.span.startMs) / 60_000;
          occupiedByDate.set(
            piece.isoDate,
            (occupiedByDate.get(piece.isoDate) ?? 0) + occupied * minutes,
          );
          operationalByDate.set(
            piece.isoDate,
            (operationalByDate.get(piece.isoDate) ?? 0) + operational * minutes,
          );
        }
      }
    }

    const points: TrendPointView[] = [];
    const dayCount = Math.min(400, Math.ceil(elapsedDays(window)) + 1);
    for (let i = 0; i < dayCount; i += 1) {
      const instant = window.startMs + i * DAY_MS;
      if (instant >= window.endMs + DAY_MS) break;
      const isoDate = toLocalParts(Math.min(instant, window.endMs - 1), this.timeZone).isoDate;
      const operational = operationalByDate.get(isoDate);
      const occupied = occupiedByDate.get(isoDate);
      const hasData = operational !== undefined && operational > 0;
      points.push({
        isoDate,
        occupancyPct: hasData ? (100 * (occupied ?? 0)) / operational : null,
        hasData,
      });
    }

    const gapSpans = sets.flatMap((set) =>
      set.gapSpans.map((span) => ({
        startMs: span.startMs,
        endMs: span.endMs,
        reason: 'collection gap',
      })),
    );

    return {
      points,
      gaps: gapSpans,
      note: 'Gaps mean no observation was recorded, not zero occupancy.',
    };
  }

  /** Builds the station detail drawer. */
  getStationDetail(siteId: string, windowRequest: WindowRequest): StationDetailView | null {
    const resolved = this.resolveSharedWindow(windowRequest);
    const window = resolved.effective;
    const rows = this.loadScopeRows().filter((row) => row.siteId === siteId);
    const row = rows[0];
    if (!row) return null;

    const sets = this.buildIntervalSets(rows, window);
    const set = sets.get(row.scopeKey);
    const metrics = set ? computeScopeMetrics(set) : undefined;
    const station = this.toStationView(row, set, metrics, window);
    const latest = row.bindingId ? this.observations.latestFor(row.scopeKey) : null;

    const heatmap = set ? toHeatmapView([set], this.timeZone) : [];
    const heat = set ? computeHeatmap([set], this.timeZone) : null;
    const peak = heat?.peak
      ? `${heat.peak.weekdayGroup === 'weekdays' ? 'Weekdays' : 'Weekends'} ${formatHour(heat.peak.startHour)}–${formatHour(heat.peak.endHour)}`
      : null;

    const portSnapshots =
      row.identityReliability === 'durable'
        ? this.observations.portSnapshotsFor([row.scopeKey], window.startMs, window.endMs)
        : [];
    const episodes =
      portSnapshots.length > 0
        ? detectPortEpisodes(portSnapshots, { continuityBreaks: set?.gapSpans ?? [] })
        : null;

    const capability = activityCapability({
      hasAuthorizedTransactionData: false,
      hasDurablePortIdentity: portSnapshots.length > 0,
      hasAggregateCounts: (metrics?.observationCount ?? 0) > 0,
    });

    const aggregateChanges =
      capability === 'aggregate_count_changes' && set
        ? observedOccupiedIncreases(
            set.intervals.map((interval) => ({
              observationId: interval.snapshot.observationId,
              observedAtUtcMs: interval.snapshot.observedAtUtcMs,
              occupied: interval.counts.occupied,
            })),
            set.gapSpans,
          )
        : null;

    const days = Math.max(1, elapsedDays(window));
    const detectedStartsPerDay =
      episodes && episodes.detectedStartCount > 0 ? episodes.detectedStartCount / days : null;

    const badge: StationDetailView['dataQuality']['badge'] =
      station.sourceFreshness === 'stale'
        ? 'stale_source'
        : station.eligibleForRanking
          ? 'reliable'
          : 'provisional';

    return {
      station: { ...station, peak, starts: detectedStartsPerDay },
      currentStatusNote: latest?.distinguishesCharging
        ? 'The source distinguishes active charging from occupancy.'
        : 'The source reports ports as in use. It does not state whether electricity was flowing.',
      dataQuality: {
        badge,
        coveragePct: metrics?.statusCoveragePct ?? null,
        historyDays: station.history,
        latestObservation: station.observed,
        scope: station.scopeNote ?? row.physicalScope ?? 'Scope not recorded',
      },
      trend: set
        ? this.buildTrend([set], window)
        : { points: [], gaps: [], note: 'No observations yet.' },
      heatmap,
      activity: {
        capability,
        explanation:
          capability === 'recorded_sessions'
            ? 'Counts come from an authorized transaction dataset.'
            : capability === 'detected_port_episodes'
              ? 'Estimated from observed state transitions on individually identified ports.'
              : capability === 'aggregate_count_changes'
                ? NO_SESSION_RECORDS_EXPLANATION
                : 'No activity counts are supported for this location yet.',
        detectedStartsPerDay,
        // Dwell requires bounded episodes; an aggregate-only source cannot
        // support it, and no figure is invented in its place.
        estimatedDwell: null,
        observedIncreaseCount: aggregateChanges?.observedIncreaseCount ?? null,
      },
      visits: this.getVisitsPanel(siteId, window),
      locationContext: {
        nearbyBusinesses: null,
        parking: null,
        roadTraffic: null,
        property: null,
      },
      source: {
        sourceId: row.sourceId,
        displayName: row.sourceId
          ? str(
              this.driver.prepare('SELECT display_name FROM sources WHERE id = ?').get(row.sourceId)
                ?.display_name ?? null,
            )
          : null,
        observationMethod: latest ? 'Rendered status' : null,
        lastSuccessfulReadMs: set?.latestObservationMs ?? null,
        dataScope: row.physicalScope ?? 'Not recorded',
        sourceUrl: row.canonicalUrl,
        parserVersion: row.bindingId
          ? str(
              this.driver
                .prepare(
                  'SELECT parser_version FROM observations WHERE scope_key = ? ORDER BY observed_at_ms DESC LIMIT 1',
                )
                .get(row.scopeKey)?.parser_version ?? null,
            )
          : null,
        adapterVersion: row.sourceId
          ? str(
              this.driver
                .prepare('SELECT adapter_version FROM sources WHERE id = ?')
                .get(row.sourceId)?.adapter_version ?? null,
            )
          : null,
        metricAlgorithmVersion: METRIC_ALGORITHM_VERSION,
      },
    };
  }

  /**
   * Builds the Visits panel.
   *
   * Defaults to "No visit counts added". Nothing is estimated, prorated or
   * filled in from a proxy.
   */
  private getVisitsPanel(siteId: string, window: Interval): VisitsPanelView {
    const rows = this.driver
      .prepare(
        `SELECT vo.period_start_ms, vo.period_end_ms, vo.visit_count, vd.count_definition, vd.method
           FROM visit_observations vo
           JOIN visit_datasets vd ON vd.id = vo.dataset_id
          WHERE vo.site_id = ? AND vd.authoritative = 1
          ORDER BY vo.period_start_ms`,
      )
      .all(siteId);

    if (rows.length === 0) {
      return {
        hasData: false,
        periodStartMs: null,
        periodEndMs: null,
        visitCount: null,
        countDefinition: null,
        portsBasis: null,
        ports: null,
        visitsPerInstalledPort: null,
        portsPer1000Visits: null,
        recordedSessionsPer1000Visits: null,
        detectedStartsPer1000Visits: null,
        limitations: [],
      };
    }

    // Whole matching periods only; the domain module decides, not this query.
    const inWindow = rows.filter(
      (row) =>
        Number(row.period_start_ms) >= window.startMs && Number(row.period_end_ms) <= window.endMs,
    );
    if (inWindow.length === 0) {
      return {
        hasData: false,
        periodStartMs: null,
        periodEndMs: null,
        visitCount: null,
        countDefinition: null,
        portsBasis: null,
        ports: null,
        visitsPerInstalledPort: null,
        portsPer1000Visits: null,
        recordedSessionsPer1000Visits: null,
        detectedStartsPer1000Visits: null,
        limitations: [
          'Visit counts exist for this location but not for whole periods inside the selected window, so no comparison is shown.',
        ],
      };
    }

    const visitCount = inWindow.reduce((sum, row) => sum + Number(row.visit_count), 0);
    return {
      hasData: true,
      periodStartMs: Number(inWindow[0]?.period_start_ms ?? window.startMs),
      periodEndMs: Number(inWindow[inWindow.length - 1]?.period_end_ms ?? window.endMs),
      visitCount,
      countDefinition: str(inWindow[0]?.count_definition ?? null),
      portsBasis: null,
      ports: null,
      visitsPerInstalledPort: null,
      portsPer1000Visits: null,
      recordedSessionsPer1000Visits: null,
      detectedStartsPer1000Visits: null,
      limitations: [],
    };
  }

  /** Builds the top-bar collection status line. */
  getCollectionStatus(input: {
    readonly running: boolean;
    readonly userPaused: boolean;
    readonly online: boolean;
    readonly queueLag: number;
    readonly effectiveIntervalMs: number | null;
    readonly targetIntervalMs: number;
    readonly nextCheckMs: number | null;
    readonly anySourceUnhealthy: boolean;
  }): CollectionStatusView {
    const monitoredCount = Number(
      this.driver
        .prepare('SELECT COUNT(*) AS c FROM source_bindings WHERE enabled = 1 AND is_primary = 1')
        .get()?.c ?? 0,
    );
    const lastObservationMs = num(
      this.driver.prepare('SELECT MAX(observed_at_ms) AS m FROM observations').get()?.m ?? null,
    );

    // NOTE: `partial_coverage` is declared in CollectionStatusView and handled
    // by the renderer, but nothing below ever produces it -- deriving it needs
    // a coverage figure this method is not given. TypeScript found the dead
    // branch that revealed it. Tracked in docs/IMPLEMENTATION_STATUS.md; the
    // branch is removed rather than left as unreachable code pretending the
    // state is reachable.
    let kind: CollectionStatusView['kind'];
    if (input.userPaused) kind = 'paused';
    else if (!input.running) kind = monitoredCount === 0 ? 'not_started' : 'paused';
    else if (!input.online) kind = 'offline';
    else if (input.anySourceUnhealthy) kind = 'source_issue';
    else if (input.queueLag > 0) kind = 'catching_up';
    else kind = 'collecting';

    const label =
      kind === 'collecting'
        ? `Collecting · ${monitoredCount} location${monitoredCount === 1 ? '' : 's'}`
        : kind === 'paused'
          ? 'Paused'
          : kind === 'offline'
            ? 'Offline'
            : kind === 'source_issue'
              ? 'Source issue'
              : kind === 'catching_up'
                ? `Catching up · ${input.queueLag} waiting`
                : 'Not started';

    return {
      kind,
      label,
      monitoredCount,
      lastObservationMs,
      nextCheckMs: input.nextCheckMs,
      effectiveIntervalMs: input.effectiveIntervalMs,
      targetIntervalMs: input.targetIntervalMs,
      queueLag: input.queueLag,
    };
  }
}

function describeMonitoredPorts(metrics: ScopeMetrics, window: Interval): number {
  if (metrics.expectedInstalledPortMinutes === null || metrics.monitoredMinutes <= 0) {
    return 0;
  }
  void window;
  return Math.round(metrics.expectedInstalledPortMinutes / metrics.monitoredMinutes);
}

function toHeatmapView(
  sets: readonly ScopeIntervalSet[],
  timeZone: string,
): readonly HeatmapCellView[] {
  const heat = computeHeatmap(sets, timeZone);
  return heat.bins.map((bin) => ({
    weekday: bin.weekday,
    hour: bin.hour,
    occupancyPct: bin.occupancyPct,
    hasData: bin.hasData,
  }));
}

function formatHour(hour: number): string {
  const normalized = ((hour % 24) + 24) % 24;
  if (normalized === 0) return '12 AM';
  if (normalized === 12) return '12 PM';
  return normalized < 12 ? `${normalized} AM` : `${normalized - 12} PM`;
}
