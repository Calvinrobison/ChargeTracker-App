/**
 * Fixture view models for the UI tests.
 *
 * EVERY VALUE HERE IS SYNTHETIC. None of it came from a charger, a provider
 * page, or an observation. It exists to drive the renderer through states that
 * are hard to reach on purpose — a partially covered window, a paused source,
 * a location with no current reading, an hour nobody watched — and it must
 * never be loaded by the application, shipped in a package, or imported into a
 * database. `scripts/verify-package.mjs` fails a package that contains
 * anything from this directory.
 *
 * The station names are fictional and chosen to be obviously so.
 *
 * These fixtures are typed against the real contract, so a change to a view
 * model breaks them at compile time rather than producing a UI test that
 * passes against a shape the application no longer sends.
 */

import type {
  BootstrapView,
  CollectionStatusView,
  HeatmapCellView,
  ResponseOf,
  SourceHealthView,
  StationView,
  SummaryView,
  TrendView,
} from '../../src/shared/ipc.ts';

/** Fixed so a screenshot diff is not a clock diff. */
export const NOW_MS = Date.UTC(2026, 8, 17, 19, 0, 0);
const DAY_MS = 86_400_000;

function baseStation(overrides: Partial<StationView>): StationView {
  return {
    id: 'fixture-site',
    name: 'Fixture Station',
    address: '1 Test Way, Mesa, AZ',
    network: 'FixtureNet',
    type: 'DC Fast',
    lat: 33.4152,
    lng: -111.8315,
    ports: 4,
    catalogPorts: 4,
    available: 2,
    occupied: 2,
    offline: 0,
    unknown: 0,
    occupancy: 50,
    hours: 20,
    coverage: 95,
    history: 30,
    observed: '5 min ago',
    observedAtMs: NOW_MS - 5 * 60_000,
    sourceUpdatedAtMs: NOW_MS - 6 * 60_000,
    sourceFreshness: 'fresh',
    monitoring: 'monitored',
    eligibleForRanking: true,
    provisionalReasons: [],
    saved: false,
    peak: 'Weekdays 5–7p',
    starts: 5,
    dwell: '45 min',
    distinguishesCharging: false,
    scopeNote: null,
    ...overrides,
  };
}

/**
 * Four stations, each chosen for the display rule it exercises:
 *
 *  1. a fully monitored, rankable location — the ordinary case;
 *  2. a monitored location with NO current reading — must show "No current
 *     status", never "0 / 4";
 *  3. a provisional location — enough history to show, not enough to rank;
 *  4. a catalog-only location — known to exist, never observed.
 */
export const STATIONS: readonly StationView[] = [
  baseStation({
    id: 'fixture-busy',
    name: 'Fixture Mall North',
    occupancy: 78.4,
    hours: 56.3,
    coverage: 98.1,
    available: 1,
    occupied: 7,
    ports: 8,
    catalogPorts: 8,
  }),
  baseStation({
    id: 'fixture-no-reading',
    name: 'Fixture Transit Center',
    // The source answered, but reported no usable counts.
    available: null,
    occupied: null,
    offline: null,
    unknown: 4,
    occupancy: 41.2,
    coverage: 71.5,
    observed: '2h ago',
    observedAtMs: NOW_MS - 2 * 3_600_000,
    sourceFreshness: 'unknown_source_clock',
    sourceUpdatedAtMs: null,
    monitoring: 'stale',
  }),
  baseStation({
    id: 'fixture-provisional',
    name: 'Fixture Library Lot',
    history: 3,
    coverage: 62,
    occupancy: 22.5,
    hours: 4.1,
    eligibleForRanking: false,
    monitoring: 'provisional',
    provisionalReasons: [
      'Only 3 days of history; 7 are needed before this location is ranked.',
      'Known-state coverage is 62%; 90% is needed.',
    ],
    peak: null,
    starts: null,
    dwell: null,
  }),
  baseStation({
    id: 'fixture-catalog-only',
    name: 'Fixture Hotel Garage',
    monitoring: 'catalog',
    ports: null,
    catalogPorts: 2,
    available: null,
    occupied: null,
    offline: null,
    unknown: null,
    occupancy: null,
    hours: null,
    coverage: null,
    history: 0,
    observed: null,
    observedAtMs: null,
    sourceUpdatedAtMs: null,
    sourceFreshness: null,
    eligibleForRanking: false,
    peak: null,
    starts: null,
    dwell: null,
    scopeNote: 'In the station catalog but not monitored, so no history exists for it.',
  }),
];

/** A window clipped by the study start: requested 30 days, collected 11. */
export const SUMMARY: SummaryView = {
  monitoredLocations: 3,
  catalogLocations: 4,
  observedOccupancyPct: 54.7,
  comparableLocations: 2,
  occupiedPortHours: 80.5,
  statusCoveragePct: 88.9,
  historyDays: 11,
  effectiveStartMs: NOW_MS - 11 * DAY_MS,
  effectiveEndMs: NOW_MS,
  requestedDays: 30,
  effectiveDays: 11,
  clippedByStudyStart: true,
  cohortDescription:
    'DC fast locations with at least 7 days of history and 90% known-state coverage.',
};

/**
 * A heatmap with a deliberate hole: Sunday has no observations at all, and
 * Monday 02:00–04:00 was not watched. Those cells must render as the no-data
 * step, not as low occupancy.
 */
export const HEATMAP: readonly HeatmapCellView[] = (() => {
  const cells: HeatmapCellView[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const watched = weekday !== 0 && !(weekday === 1 && hour >= 2 && hour < 4);
      cells.push({
        weekday,
        hour,
        // An observed zero appears at Tuesday 03:00, so the tests can prove a
        // measured zero is not drawn like an unwatched hour.
        occupancyPct: watched ? (weekday === 2 && hour === 3 ? 0 : (hour * 4) % 100) : null,
        hasData: watched,
      });
    }
  }
  return cells;
})();

/** A trend with a two-day gap in the middle, reported rather than bridged. */
export const TREND: TrendView = {
  points: Array.from({ length: 11 }, (_unused, index) => {
    const date = new Date(NOW_MS - (10 - index) * DAY_MS);
    const missing = index === 4 || index === 5;
    return {
      isoDate: date.toISOString().slice(0, 10),
      occupancyPct: missing ? null : 30 + index * 3,
      hasData: !missing,
    };
  }),
  gaps: [
    {
      startMs: NOW_MS - 6 * DAY_MS,
      endMs: NOW_MS - 4 * DAY_MS,
      reason: 'source_paused',
    },
  ],
  note: 'Two days have no observations. The line is broken there rather than drawn through the gap.',
};

/** A source that is not cleared for collection — the state shipped today. */
export const SOURCES: readonly SourceHealthView[] = [
  {
    sourceId: 'fixture-source',
    displayName: 'FixtureNet',
    state: 'unverified',
    eligibilityState: 'needs_review',
    verificationState: 'blocked',
    message:
      'FixtureNet has not been cleared for automated collection, so no new observations are being recorded. Existing history is unaffected.',
    userAction: 'A maintainer needs to complete the source review before collection can start.',
    lastSuccessMs: null,
    retryAtMs: null,
  },
];

export const COLLECTION_STATUS: CollectionStatusView = {
  kind: 'partial_coverage',
  label: 'Partial coverage · 3 locations',
  monitoredCount: 3,
  lastObservationMs: NOW_MS - 5 * 60_000,
  nextCheckMs: NOW_MS + 4 * 60_000,
  effectiveIntervalMs: 900_000,
  targetIntervalMs: 300_000,
  queueLag: 2,
};

export const BOOTSTRAP: BootstrapView = {
  contractVersion: 1,
  appVersion: '0.0.0-fixture',
  schemaVersion: 1,
  onboardingComplete: true,
  studyArea: {
    centerLatitude: 33.4152,
    centerLongitude: -111.8315,
    radiusMiles: 50,
    label: 'Mesa, Arizona',
    timeZone: 'America/Phoenix',
  },
  counts: { catalogSites: 4, monitoredScopes: 3, observations: 1287 },
  collection: COLLECTION_STATUS,
  sources: SOURCES,
  healthChecks: [
    {
      id: 'data_dir',
      label: 'Data folder is writable',
      status: 'pass',
      detail: null,
      recoveryAction: null,
    },
    {
      id: 'database',
      label: 'History file is ready',
      status: 'pass',
      detail: 'schema 1, journal mode wal',
      recoveryAction: null,
    },
    {
      id: 'browser',
      label: 'Bundled browser starts',
      status: 'pass',
      detail: null,
      recoveryAction: null,
    },
    {
      id: 'sources',
      label: 'A charger status source is enabled',
      status: 'fail',
      detail: 'FixtureNet: needs_review / blocked',
      recoveryAction: 'No source has been cleared for automated collection yet.',
    },
    {
      id: 'catalog',
      label: 'Station catalog is loaded',
      status: 'pass',
      detail: '4 catalog locations, 3 monitored',
      recoveryAction: null,
    },
    {
      id: 'network',
      label: 'Network is reachable',
      status: 'not_applicable',
      detail: 'Checked when collection runs.',
      recoveryAction: null,
    },
  ],
  dataDirectory: 'C:\\Users\\Fixture\\AppData\\Local\\ChargeWatch',
  diskUsageBytes: 4_718_592,
  startWithWindows: false,
  theme: 'dark',
  demoMode: false,
  studyStartMs: NOW_MS - 11 * DAY_MS,
};

export const OVERVIEW: ResponseOf<'overview.get'> = {
  summary: SUMMARY,
  ranked: [STATIONS[0] as StationView, STATIONS[1] as StationView],
  provisional: [STATIONS[2] as StationView],
  excludedAmbiguous: [],
  heatmap: HEATMAP,
  trend: TREND,
  totalCount: 4,
};

export const MAP_MARKERS: ResponseOf<'map.getMarkers'> = {
  stations: STATIONS,
  summary: SUMMARY,
  legendMetric: 'occupancy',
  visitsMetricAvailable: false,
};

/**
 * A station detail for the drawer.
 *
 * `activity.capability` is `detected_port_episodes`, which is the honest
 * ceiling for a status-polling source: episodes are INFERRED from changes in
 * observed counts, and the explanation says so. No public source exposes
 * charging sessions, so `recorded_sessions` is a state the application can
 * represent but never legitimately reach from this collector.
 */
function detailFor(station: StationView): ResponseOf<'station.getDetail'> {
  const monitored = station.monitoring !== 'catalog';
  return {
    station,
    currentStatusNote: monitored
      ? station.occupied === null
        ? 'The source answered but reported no usable port counts for this location.'
        : 'Counts are as last read from the source.'
      : 'This location is in the station catalog but is not monitored, so no history exists for it.',
    dataQuality: {
      badge:
        station.monitoring === 'stale'
          ? 'stale_source'
          : monitored && station.eligibleForRanking
            ? 'reliable'
            : 'provisional',
      coveragePct: station.coverage,
      historyDays: station.history,
      latestObservation: station.observed,
      scope: monitored ? 'All monitored ports at this location' : 'Not monitored',
    },
    trend: TREND,
    heatmap: HEATMAP,
    activity: {
      capability: monitored ? 'detected_port_episodes' : 'none',
      explanation: monitored
        ? 'These are occupancy episodes inferred from changes in observed port counts. They are not charging sessions: no public source reports sessions, energy delivered, or who was charging.'
        : 'No activity can be reported for a location that is not monitored.',
      detectedStartsPerDay: station.starts,
      estimatedDwell: station.dwell,
      observedIncreaseCount: monitored ? 137 : null,
    },
    visits: {
      hasData: false,
      periodStartMs: null,
      periodEndMs: null,
      visitCount: null,
      countDefinition: null,
      portsBasis: null,
      ports: station.ports,
      visitsPerInstalledPort: null,
      portsPer1000Visits: null,
      recordedSessionsPer1000Visits: null,
      detectedStartsPer1000Visits: null,
      limitations: ['No visit dataset has been imported for this location.'],
    },
    locationContext: { nearbyBusinesses: null, parking: null, roadTraffic: null, property: null },
    source: {
      sourceId: 'fixture-source',
      displayName: 'FixtureNet',
      observationMethod: 'Public status page read with a bundled browser',
      lastSuccessfulReadMs: station.observedAtMs,
      dataScope: monitored ? 'Station aggregate counts' : 'Catalog record only',
      sourceUrl: null,
      parserVersion: 'fixture-parser@0.0.0',
      adapterVersion: 'fixture-adapter@0.0.0',
      metricAlgorithmVersion: 1,
    },
  };
}

export const STATION_DETAILS: Readonly<Record<string, ResponseOf<'station.getDetail'>>> =
  Object.fromEntries(STATIONS.map((station) => [station.id, detailFor(station)]));

/**
 * Responses keyed by operation name, for the stub bridge.
 *
 * An operation that is not listed is REJECTED by the stub rather than answered
 * with an empty object, so a UI test cannot pass because the renderer quietly
 * accepted a response nobody wrote.
 */
export const RESPONSES: Readonly<Record<string, unknown>> = {
  'app.getBootstrap': BOOTSTRAP,
  'overview.get': OVERVIEW,
  'map.getMarkers': MAP_MARKERS,
  'update.getState': {
    installedVersion: '0.0.0-fixture',
    state: 'idle',
    availableVersion: null,
    downloadedPercent: null,
    detail: null,
    autoCheckEnabled: true,
    autoDownloadEnabled: true,
    autoInstallEnabled: true,
    consecutiveFailures: 0,
    manualDownloadUrl: null,
  },
  'backup.list': { backups: [] },
  'settings.update': { applied: [] },
  'station.setSaved': { saved: true },
};
