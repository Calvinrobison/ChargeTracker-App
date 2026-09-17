/**
 * The IPC contract.
 *
 * Shape of the system (§9):
 *   renderer  --(narrow preload bridge)-->  main  --(typed messages)-->  workers
 *
 * Rules this module enforces:
 *  - There is NO general-purpose invoke surface. Every operation is named
 *    here, with a request schema, a response type and a timeout.
 *  - The renderer cannot execute SQL, spawn processes, read arbitrary files or
 *    navigate to provider pages with application privileges. It receives typed,
 *    paginated view models and nothing else.
 *  - Contracts are versioned. A renderer and a worker built from different
 *    versions refuse to talk rather than guessing.
 *  - Every request carries an id so responses, timeouts and cancellation can
 *    be correlated.
 */

import { type Infer, type Schema, v } from './validate.ts';

/** Bumped whenever a request or response shape changes incompatibly. */
export const IPC_CONTRACT_VERSION = 1;

/** The single channel name used by the preload bridge. */
export const IPC_CHANNEL_REQUEST = 'chargewatch:request';
export const IPC_CHANNEL_EVENT = 'chargewatch:event';

// ---------------------------------------------------------------------------
// Shared enums and small shapes
// ---------------------------------------------------------------------------

export const datePresetSchema = v.enumOf(['7d', '30d', '60d', 'all', 'custom'] as const);
export const cohortSchema = v.enumOf(['level_2', 'dc_fast', 'combined'] as const);
export const rankSortSchema = v.enumOf(['occupancy', 'occupied_hours'] as const);
export const mapMetricSchema = v.enumOf(['occupancy', 'current', 'coverage', 'visits'] as const);
export const monitoringStateSchema = v.enumOf([
  'monitored',
  'provisional',
  'stale',
  'catalog',
] as const);

export const windowRequestSchema = v
  .object({
    preset: datePresetSchema,
    customStartMs: v.instant().optional(),
    customEndMs: v.instant().optional(),
  })
  .refine(
    (value) =>
      value.preset !== 'custom' ||
      (value.customStartMs !== undefined && value.customEndMs !== undefined),
    'a custom window requires customStartMs and customEndMs',
  );

/**
 * Filters are GLOBAL: the same object drives Overview and Map, so changing a
 * filter on one workspace is reflected on the other.
 */
export const filterStateSchema = v.object({
  query: v.string({ max: 200 }).withDefault(''),
  chargingTypes: v.array(v.enumOf(['level_2', 'dc_fast', 'level_1', 'unknown'] as const), { max: 8 }).withDefault([]),
  networks: v.array(v.string({ max: 80 }), { max: 40 }).withDefault([]),
  monitoringStates: v.array(monitoringStateSchema, { max: 8 }).withDefault([]),
  savedOnly: v.boolean().withDefault(false),
  cohort: cohortSchema.withDefault('dc_fast'),
});

export type FilterState = Infer<typeof filterStateSchema>;
export type WindowRequest = Infer<typeof windowRequestSchema>;

export const paginationSchema = v.object({
  offset: v.integer({ min: 0, max: 1_000_000 }).withDefault(0),
  limit: v.integer({ min: 1, max: 500 }).withDefault(100),
});

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/**
 * One station as the UI consumes it.
 *
 * Nullability is load-bearing. `null` renders as "—", "Not available",
 * "Insufficient history", "No current status", "Source freshness unknown" or
 * "Catalog only" in muted styling. It is NEVER rendered as zero and never
 * replaced with an estimate.
 */
export interface StationView {
  readonly id: string;
  readonly name: string;
  readonly address: string | null;
  readonly network: string | null;
  /** Display label, or null when the source gives no type breakdown. */
  readonly type: 'Level 2' | 'DC Fast' | 'Level 1' | 'Mixed' | null;
  readonly lat: number;
  readonly lng: number;
  /** Installed ports for the monitored scope, null when unknown. */
  readonly ports: number | null;
  /** Catalog port count, for "6 monitored of 12 catalog ports". */
  readonly catalogPorts: number | null;
  /** Current status counts. Null means the source did not report it. */
  readonly available: number | null;
  readonly occupied: number | null;
  readonly offline: number | null;
  readonly unknown: number | null;
  /** Historical occupancy percentage over the selected window, or null. */
  readonly occupancy: number | null;
  /** Estimated occupied port-hours over the window, or null. */
  readonly hours: number | null;
  /** Known-state coverage percentage, or null. */
  readonly coverage: number | null;
  /** Days of history collected for this station. */
  readonly history: number;
  /** Pre-formatted relative time, e.g. "6 min ago". Null when never observed. */
  readonly observed: string | null;
  readonly observedAtMs: number | null;
  readonly sourceUpdatedAtMs: number | null;
  readonly sourceFreshness: 'fresh' | 'stale' | 'unknown_source_clock' | null;
  readonly monitoring: Infer<typeof monitoringStateSchema>;
  readonly eligibleForRanking: boolean;
  readonly provisionalReasons: readonly string[];
  readonly saved: boolean;
  /** Peak observed period, or null when the data does not support a claim. */
  readonly peak: string | null;
  /** Detected occupancy starts per day, an estimate. Null when unsupported. */
  readonly starts: number | null;
  /** Estimated dwell, pre-formatted. Null when the source cannot support it. */
  readonly dwell: string | null;
  /** True only when the source separates active charging from occupancy. */
  readonly distinguishesCharging: boolean;
  readonly scopeNote: string | null;
}

export interface SummaryView {
  readonly monitoredLocations: number;
  readonly catalogLocations: number;
  readonly observedOccupancyPct: number | null;
  readonly comparableLocations: number;
  readonly occupiedPortHours: number | null;
  readonly statusCoveragePct: number | null;
  readonly historyDays: number;
  /** Actual window used, after intersecting with the study start. */
  readonly effectiveStartMs: number | null;
  readonly effectiveEndMs: number | null;
  readonly requestedDays: number;
  readonly effectiveDays: number;
  readonly clippedByStudyStart: boolean;
  readonly cohortDescription: string;
}

export interface HeatmapCellView {
  readonly weekday: number;
  readonly hour: number;
  /** Null renders as the no-data step, never as a low value. */
  readonly occupancyPct: number | null;
  readonly hasData: boolean;
}

export interface TrendPointView {
  readonly isoDate: string;
  /** Null breaks the chart path; it is never drawn as zero. */
  readonly occupancyPct: number | null;
  readonly hasData: boolean;
}

export interface TrendView {
  readonly points: readonly TrendPointView[];
  readonly gaps: readonly { readonly startMs: number; readonly endMs: number; readonly reason: string }[];
  readonly note: string;
}

export type CollectionStatusKind =
  | 'collecting'
  | 'paused'
  | 'source_issue'
  | 'offline'
  | 'catching_up'
  | 'partial_coverage'
  | 'not_started';

export interface CollectionStatusView {
  readonly kind: CollectionStatusKind;
  /** Plain text for the top bar, e.g. "Collecting · 13 locations". */
  readonly label: string;
  readonly monitoredCount: number;
  readonly lastObservationMs: number | null;
  readonly nextCheckMs: number | null;
  /** Actual achievable cadence, which may differ from the target. */
  readonly effectiveIntervalMs: number | null;
  readonly targetIntervalMs: number;
  readonly queueLag: number;
}

export interface SourceHealthView {
  readonly sourceId: string;
  readonly displayName: string;
  readonly state: 'healthy' | 'degraded' | 'paused' | 'blocked' | 'circuit_open' | 'unverified';
  readonly eligibilityState: 'enabled' | 'disabled' | 'needs_review';
  readonly verificationState: 'verified' | 'unverified' | 'blocked';
  /** Plain-language explanation for the warning banner. */
  readonly message: string | null;
  readonly userAction: string | null;
  readonly lastSuccessMs: number | null;
  readonly retryAtMs: number | null;
}

export interface VisitsPanelView {
  readonly hasData: boolean;
  readonly periodStartMs: number | null;
  readonly periodEndMs: number | null;
  readonly visitCount: number | null;
  readonly countDefinition: string | null;
  readonly portsBasis: 'constant' | 'time_weighted_effective' | 'unavailable' | null;
  readonly ports: number | null;
  readonly visitsPerInstalledPort: number | null;
  readonly portsPer1000Visits: number | null;
  readonly recordedSessionsPer1000Visits: number | null;
  readonly detectedStartsPer1000Visits: number | null;
  readonly limitations: readonly string[];
}

export interface StationDetailView {
  readonly station: StationView;
  readonly currentStatusNote: string;
  readonly dataQuality: {
    readonly badge: 'reliable' | 'provisional' | 'stale_source';
    readonly coveragePct: number | null;
    readonly historyDays: number;
    readonly latestObservation: string | null;
    readonly scope: string;
  };
  readonly trend: TrendView;
  readonly heatmap: readonly HeatmapCellView[];
  readonly activity: {
    readonly capability: 'recorded_sessions' | 'detected_port_episodes' | 'aggregate_count_changes' | 'none';
    readonly explanation: string;
    readonly detectedStartsPerDay: number | null;
    readonly estimatedDwell: string | null;
    readonly observedIncreaseCount: number | null;
  };
  readonly visits: VisitsPanelView;
  readonly locationContext: {
    readonly nearbyBusinesses: null;
    readonly parking: null;
    readonly roadTraffic: null;
    readonly property: null;
  };
  readonly source: {
    readonly sourceId: string | null;
    readonly displayName: string | null;
    readonly observationMethod: string | null;
    readonly lastSuccessfulReadMs: number | null;
    readonly dataScope: string;
    readonly sourceUrl: string | null;
    readonly parserVersion: string | null;
    readonly adapterVersion: string | null;
    readonly metricAlgorithmVersion: number;
  };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface OperationSpec<Request, Response> {
  readonly name: string;
  readonly request: Schema<Request>;
  readonly timeoutMs: number;
  /** True when the operation mutates state, for audit logging. */
  readonly mutating: boolean;
  /** True when the operation supports cancellation. */
  readonly cancellable: boolean;
  /** Phantom marker so the response type is inferable from the spec. */
  readonly __response?: Response;
}

function op<Request, Response>(spec: {
  name: string;
  request: Schema<Request>;
  timeoutMs: number;
  mutating?: boolean;
  cancellable?: boolean;
}): OperationSpec<Request, Response> {
  return {
    name: spec.name,
    request: spec.request,
    timeoutMs: spec.timeoutMs,
    mutating: spec.mutating ?? false,
    cancellable: spec.cancellable ?? false,
  };
}

const empty = v.object({});
const siteIdOnly = v.object({ siteId: v.string({ min: 1, max: 128 }) });
const viewRequest = v.object({
  window: windowRequestSchema,
  filters: filterStateSchema,
  sort: rankSortSchema.withDefault('occupancy'),
  pagination: paginationSchema.optional(),
});

export interface BootstrapView {
  readonly contractVersion: number;
  readonly appVersion: string;
  readonly schemaVersion: number;
  readonly onboardingComplete: boolean;
  readonly studyArea: {
    readonly centerLatitude: number;
    readonly centerLongitude: number;
    readonly radiusMiles: number;
    readonly label: string;
    readonly timeZone: string;
  };
  readonly counts: { readonly catalogSites: number; readonly monitoredScopes: number; readonly observations: number };
  readonly collection: CollectionStatusView;
  readonly sources: readonly SourceHealthView[];
  readonly healthChecks: readonly {
    readonly id: string;
    readonly label: string;
    readonly status: 'pass' | 'fail' | 'warn' | 'not_applicable';
    readonly detail: string | null;
    readonly recoveryAction: string | null;
  }[];
  readonly dataDirectory: string;
  readonly diskUsageBytes: number | null;
  readonly startWithWindows: boolean;
  readonly theme: 'dark' | 'light';
  readonly demoMode: boolean;
  readonly studyStartMs: number | null;
}

export const OPERATIONS = {
  'app.getBootstrap': op<Record<string, never>, BootstrapView>({
    name: 'app.getBootstrap',
    request: empty,
    timeoutMs: 15_000,
  }),

  'settings.update': op<
    { readonly entries: Record<string, unknown> },
    { readonly applied: readonly string[] }
  >({
    name: 'settings.update',
    request: v.object({ entries: v.record(v.unknown()) }),
    timeoutMs: 5_000,
    mutating: true,
  }),

  'overview.get': op<
    Infer<typeof viewRequest>,
    {
      readonly summary: SummaryView;
      readonly ranked: readonly StationView[];
      readonly provisional: readonly StationView[];
      readonly excludedAmbiguous: readonly StationView[];
      readonly heatmap: readonly HeatmapCellView[];
      readonly trend: TrendView;
      readonly totalCount: number;
    }
  >({ name: 'overview.get', request: viewRequest, timeoutMs: 30_000, cancellable: true }),

  'map.getMarkers': op<
    Infer<typeof viewRequest> & { readonly metric: Infer<typeof mapMetricSchema> },
    {
      readonly stations: readonly StationView[];
      readonly summary: SummaryView;
      readonly legendMetric: Infer<typeof mapMetricSchema>;
      readonly visitsMetricAvailable: boolean;
    }
  >({
    name: 'map.getMarkers',
    request: v.object({
      window: windowRequestSchema,
      filters: filterStateSchema,
      sort: rankSortSchema.withDefault('occupancy'),
      pagination: paginationSchema.optional(),
      metric: mapMetricSchema,
    }),
    timeoutMs: 30_000,
    cancellable: true,
  }),

  'station.getDetail': op<
    { readonly siteId: string; readonly window: WindowRequest },
    StationDetailView
  >({
    name: 'station.getDetail',
    request: v.object({ siteId: v.string({ min: 1, max: 128 }), window: windowRequestSchema }),
    timeoutMs: 30_000,
    cancellable: true,
  }),

  'station.setSaved': op<{ readonly siteId: string; readonly saved: boolean }, { readonly saved: boolean }>({
    name: 'station.setSaved',
    request: v.object({ siteId: v.string({ min: 1, max: 128 }), saved: v.boolean() }),
    timeoutMs: 5_000,
    mutating: true,
  }),

  'sites.setMonitored': op<
    { readonly siteIds: readonly string[]; readonly enabled: boolean },
    { readonly enabledCount: number; readonly refusedCount: number; readonly refusals: readonly string[] }
  >({
    name: 'sites.setMonitored',
    request: v.object({
      siteIds: v.array(v.string({ min: 1, max: 128 }), { min: 1, max: 500 }),
      enabled: v.boolean(),
    }),
    timeoutMs: 20_000,
    mutating: true,
  }),

  'sites.addManualLink': op<
    { readonly siteId: string; readonly url: string },
    { readonly ok: boolean; readonly code: string; readonly detail: string | null }
  >({
    name: 'sites.addManualLink',
    request: v.object({
      siteId: v.string({ min: 1, max: 128 }),
      // Validated again against the source allowlist before any navigation.
      url: v.string({ min: 8, max: 2048, pattern: /^https?:\/\// }),
    }),
    timeoutMs: 30_000,
    mutating: true,
  }),

  'collection.setRunning': op<
    { readonly running: boolean },
    CollectionStatusView
  >({
    name: 'collection.setRunning',
    request: v.object({ running: v.boolean() }),
    timeoutMs: 60_000,
    mutating: true,
  }),

  'collection.refreshNow': op<
    { readonly siteIds: readonly string[] },
    { readonly queued: number; readonly earliestStartMs: number | null; readonly budgetNote: string | null }
  >({
    name: 'collection.refreshNow',
    request: v.object({ siteIds: v.array(v.string({ min: 1, max: 128 }), { max: 100 }).withDefault([]) }),
    timeoutMs: 15_000,
    mutating: true,
  }),

  'source.openWindow': op<{ readonly sourceId: string; readonly siteId: string }, { readonly opened: boolean }>({
    name: 'source.openWindow',
    request: v.object({
      sourceId: v.string({ min: 1, max: 64 }),
      siteId: v.string({ min: 1, max: 128 }),
    }),
    timeoutMs: 30_000,
    mutating: false,
  }),

  'export.currentView': op<
    Infer<typeof viewRequest> & { readonly destinationPath: string },
    { readonly written: boolean; readonly path: string; readonly rowCount: number }
  >({
    name: 'export.currentView',
    request: v.object({
      window: windowRequestSchema,
      filters: filterStateSchema,
      sort: rankSortSchema.withDefault('occupancy'),
      pagination: paginationSchema.optional(),
      destinationPath: v.string({ min: 1, max: 4096 }),
    }),
    timeoutMs: 120_000,
    mutating: false,
  }),

  'export.rawObservations': op<
    { readonly window: WindowRequest; readonly filters: FilterState; readonly destinationPath: string },
    { readonly written: boolean; readonly path: string; readonly rowCount: number }
  >({
    name: 'export.rawObservations',
    request: v.object({
      window: windowRequestSchema,
      filters: filterStateSchema,
      destinationPath: v.string({ min: 1, max: 4096 }),
    }),
    timeoutMs: 600_000,
    cancellable: true,
  }),

  'visits.getTemplate': op<Record<string, never>, { readonly headers: readonly string[]; readonly csv: string }>({
    name: 'visits.getTemplate',
    request: empty,
    timeoutMs: 5_000,
  }),

  'visits.previewImport': op<
    { readonly filePath: string },
    {
      readonly acceptedCount: number;
      readonly rejectedCount: number;
      readonly issues: readonly { readonly rowIndex: number; readonly code: string; readonly detail: string }[];
      readonly preview: readonly Record<string, string>[];
      readonly datasetId: string;
      readonly overlapsExisting: readonly string[];
    }
  >({
    name: 'visits.previewImport',
    request: v.object({ filePath: v.string({ min: 1, max: 4096 }) }),
    timeoutMs: 60_000,
  }),

  'visits.commitImport': op<
    { readonly datasetId: string; readonly authoritative: boolean },
    { readonly imported: number; readonly importId: string }
  >({
    name: 'visits.commitImport',
    request: v.object({
      datasetId: v.string({ min: 1, max: 128 }),
      authoritative: v.boolean().withDefault(false),
    }),
    timeoutMs: 120_000,
    mutating: true,
  }),

  'visits.addManual': op<
    {
      readonly siteId: string;
      readonly periodStartMs: number;
      readonly periodEndMs: number;
      readonly visitCount: number;
      readonly countDefinition: string;
      readonly method: string;
      readonly sourceName: string;
      readonly geographicScope: string;
      readonly notes: string | null;
    },
    { readonly ok: boolean; readonly issues: readonly string[] }
  >({
    name: 'visits.addManual',
    request: v
      .object({
        siteId: v.string({ min: 1, max: 128 }),
        periodStartMs: v.instant(),
        periodEndMs: v.instant(),
        visitCount: v.integer({ min: 0, max: 1_000_000_000 }),
        countDefinition: v.enumOf([
          'property_entries',
          'unique_visitors',
          'transactions',
          'vehicle_entries',
          'other',
        ] as const),
        method: v.enumOf(['measured', 'estimated_by_source', 'partial'] as const),
        sourceName: v.string({ min: 1, max: 200 }),
        geographicScope: v.enumOf([
          'whole_property',
          'single_tenant',
          'parking_area',
          'other',
        ] as const),
        notes: v.string({ max: 1000 }).nullable(),
      })
      .refine((value) => value.periodEndMs > value.periodStartMs, 'the period must have positive length'),
    timeoutMs: 15_000,
    mutating: true,
  }),

  'backup.createNow': op<
    Record<string, never>,
    { readonly ok: boolean; readonly fileName: string | null; readonly detail: string | null }
  >({ name: 'backup.createNow', request: empty, timeoutMs: 300_000, mutating: true }),

  'backup.list': op<
    Record<string, never>,
    {
      readonly backups: readonly {
        readonly id: string;
        readonly kind: string;
        readonly createdAtMs: number;
        readonly byteSize: number;
        readonly verified: boolean;
        readonly observationCount: number;
      }[];
    }
  >({ name: 'backup.list', request: empty, timeoutMs: 10_000 }),

  'restore.preview': op<
    { readonly filePath: string },
    {
      readonly ok: boolean;
      readonly rejection: string | null;
      readonly detail: string | null;
      readonly schemaVersion: number | null;
      readonly observationCount: number | null;
      readonly siteCount: number | null;
      readonly firstObservationMs: number | null;
      readonly latestObservationMs: number | null;
    }
  >({
    name: 'restore.preview',
    request: v.object({ filePath: v.string({ min: 1, max: 4096 }) }),
    timeoutMs: 120_000,
  }),

  'restore.perform': op<
    { readonly filePath: string; readonly confirmed: boolean },
    { readonly ok: boolean; readonly detail: string | null; readonly preservedPreviousPath: string | null }
  >({
    name: 'restore.perform',
    request: v
      .object({ filePath: v.string({ min: 1, max: 4096 }), confirmed: v.boolean() })
      .refine((value) => value.confirmed, 'a restore requires explicit confirmation'),
    timeoutMs: 600_000,
    mutating: true,
  }),

  'data.deleteRange': op<
    { readonly beforeMs: number; readonly confirmed: boolean },
    { readonly deleted: number }
  >({
    name: 'data.deleteRange',
    request: v
      .object({ beforeMs: v.instant(), confirmed: v.boolean() })
      .refine((value) => value.confirmed, 'deleting history requires explicit confirmation'),
    timeoutMs: 300_000,
    mutating: true,
  }),

  'diagnostics.export': op<
    { readonly destinationPath: string },
    { readonly written: boolean; readonly path: string; readonly byteSize: number; readonly contents: readonly string[] }
  >({
    name: 'diagnostics.export',
    request: v.object({ destinationPath: v.string({ min: 1, max: 4096 }) }),
    timeoutMs: 120_000,
  }),

  'update.getState': op<
    Record<string, never>,
    {
      readonly installedVersion: string;
      readonly state:
        | 'idle'
        | 'checking'
        | 'downloading'
        | 'ready'
        | 'deferred'
        | 'installing'
        | 'failed'
        | 'up_to_date';
      readonly availableVersion: string | null;
      readonly downloadedPercent: number | null;
      readonly detail: string | null;
      readonly autoCheckEnabled: boolean;
      readonly autoDownloadEnabled: boolean;
      readonly autoInstallEnabled: boolean;
      readonly consecutiveFailures: number;
      readonly manualDownloadUrl: string | null;
    }
  >({ name: 'update.getState', request: empty, timeoutMs: 10_000 }),

  'update.check': op<Record<string, never>, { readonly started: boolean; readonly detail: string | null }>({
    name: 'update.check',
    request: empty,
    timeoutMs: 60_000,
    mutating: true,
  }),

  'update.restartAndInstall': op<
    { readonly confirmed: boolean },
    { readonly accepted: boolean; readonly detail: string | null }
  >({
    name: 'update.restartAndInstall',
    request: v
      .object({ confirmed: v.boolean() })
      .refine((value) => value.confirmed, 'installing an update from the foreground requires confirmation'),
    timeoutMs: 30_000,
    mutating: true,
  }),

  'onboarding.complete': op<
    { readonly startWithWindows: boolean; readonly startCollecting: boolean },
    CollectionStatusView
  >({
    name: 'onboarding.complete',
    request: v.object({ startWithWindows: v.boolean(), startCollecting: v.boolean() }),
    timeoutMs: 60_000,
    mutating: true,
  }),

  'shell.openDataFolder': op<Record<string, never>, { readonly opened: boolean }>({
    name: 'shell.openDataFolder',
    request: empty,
    timeoutMs: 10_000,
  }),

  'station.getDetailById': op<{ readonly siteId: string }, StationDetailView>({
    name: 'station.getDetailById',
    request: siteIdOnly,
    timeoutMs: 30_000,
  }),
} as const;

export type OperationName = keyof typeof OPERATIONS;

export type RequestOf<N extends OperationName> =
  (typeof OPERATIONS)[N] extends OperationSpec<infer R, unknown> ? R : never;
export type ResponseOf<N extends OperationName> =
  (typeof OPERATIONS)[N] extends OperationSpec<unknown, infer R> ? R : never;

export const OPERATION_NAMES = Object.keys(OPERATIONS) as readonly OperationName[];

export function isOperationName(value: unknown): value is OperationName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(OPERATIONS, value);
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export const requestEnvelopeSchema = v.object({
  contractVersion: v.integer({ min: 1, max: 10_000 }),
  requestId: v.string({ min: 8, max: 64, pattern: /^[A-Za-z0-9_-]+$/ }),
  operation: v.string({ min: 1, max: 64 }),
  payload: v.unknown(),
});

export type RequestEnvelope = Infer<typeof requestEnvelopeSchema>;

/** Structured error codes used internally; the UI shows friendly text. */
export type ErrorCode =
  | 'contract_version_mismatch'
  | 'unknown_operation'
  | 'invalid_payload'
  | 'timeout'
  | 'cancelled'
  | 'worker_unavailable'
  | 'database_locked'
  | 'database_migration_pending'
  | 'database_schema_too_new'
  | 'source_not_eligible'
  | 'not_permitted'
  | 'disk_full'
  | 'path_not_permitted'
  | 'internal_error';

export interface ResponseEnvelope<T> {
  readonly contractVersion: number;
  readonly requestId: string;
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: {
    readonly code: ErrorCode;
    /** Understandable text for the interface. Stack traces stay in diagnostics. */
    readonly message: string;
    readonly detail?: string;
  };
}

/** Maps an internal error code to the text the interface shows. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  contract_version_mismatch:
    'This window and the background service are from different versions of ChargeWatch. Restarting the app should fix it.',
  unknown_operation: 'ChargeWatch asked for something this version does not support.',
  invalid_payload: 'ChargeWatch sent an invalid request. Nothing was changed.',
  timeout: 'That took longer than expected and was stopped. Nothing was changed.',
  cancelled: 'That was cancelled.',
  worker_unavailable: 'The background service is not running. ChargeWatch is restarting it.',
  database_locked: 'The history file is busy. Try again in a moment.',
  database_migration_pending: 'ChargeWatch is upgrading its history file. Collection is paused until it finishes.',
  database_schema_too_new:
    'This history file was written by a newer version of ChargeWatch. Install the newer version to open it.',
  source_not_eligible: 'Collection from that source is not enabled.',
  not_permitted: 'That action is not permitted.',
  disk_full: 'There is not enough free disk space. Collection is paused and your history is intact.',
  path_not_permitted: 'ChargeWatch cannot read or write that location.',
  internal_error: 'Something went wrong. The details are in the diagnostics export.',
};

// ---------------------------------------------------------------------------
// Events (main -> renderer)
// ---------------------------------------------------------------------------

export type EventName =
  | 'collection.status'
  | 'source.health'
  | 'update.state'
  | 'data.changed'
  | 'toast';

export interface EventPayloads {
  'collection.status': CollectionStatusView;
  'source.health': { readonly sources: readonly SourceHealthView[] };
  'update.state': ResponseOf<'update.getState'>;
  /** Tells the renderer its cached view models are stale. */
  'data.changed': { readonly reason: 'observations' | 'catalog' | 'visits' | 'settings' | 'restore' };
  toast: { readonly level: 'info' | 'warn' | 'error'; readonly message: string };
}

export interface EventEnvelope<N extends EventName = EventName> {
  readonly contractVersion: number;
  readonly event: N;
  readonly payload: EventPayloads[N];
}

export const EVENT_NAMES: readonly EventName[] = [
  'collection.status',
  'source.health',
  'update.state',
  'data.changed',
  'toast',
];

export function isEventName(value: unknown): value is EventName {
  return typeof value === 'string' && (EVENT_NAMES as readonly string[]).includes(value);
}
