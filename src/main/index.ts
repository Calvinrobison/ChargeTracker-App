/**
 * ChargeWatch main process.
 *
 * Responsibilities, and nothing beyond them: window and tray lifecycle,
 * validated IPC routing, OS integration, safe dialogs, update coordination and
 * worker supervision. Expensive work lives in the workers.
 *
 * Startup order matters for data safety:
 *   1. single-instance lock, so two collectors can never exist,
 *   2. resolve paths and open the log,
 *   3. open the database (recovery, pre-migration backup, migrate),
 *   4. only if that succeeds, start the collector and create the window,
 *   5. once startup has settled, begin update checks.
 */

import { BrowserWindow, app, dialog, ipcMain, nativeTheme, powerMonitor, shell } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Logger } from './logger.ts';
import { IpcRouter, OperationError } from './router.ts';
import { TrayController } from './tray.ts';
import { WindowManager, resolveRendererEntry } from './window.ts';
import { SupervisedWorker } from './workers.ts';
import { resolveDataPaths, isPermittedWriteDestination, type ResolvedPaths } from './paths.ts';
import { redactDiagnosticText } from './security.ts';
import { UpdateService } from './updates.ts';
import { createUpdaterBackend, resolveAutoUpdater } from './updates-backend.ts';
import { parseTrustedKeys } from '../shared/release-manifest.ts';
import {
  IPC_CHANNEL_EVENT,
  IPC_CHANNEL_REQUEST,
  IPC_CONTRACT_VERSION,
  type BootstrapView,
  type CollectionStatusView,
  type EventName,
  type EventPayloads,
  type ResponseOf,
  type SourceHealthView,
  type StationDetailView,
} from '../shared/ipc.ts';
import {
  COLLECTION_DEFAULTS,
  STUDY_AREA_DEFAULTS,
  STUDY_TIME_ZONE,
  VISIT_TEMPLATE_HEADERS,
} from '../domain/index.ts';
import { TARGET_SCHEMA_VERSION } from '../database/migrator.ts';
import type { RunReport } from '../collector/service.ts';
import type { QueueEntry } from '../collector/scheduler.ts';
import type { DatabaseReadyState } from '../database/worker.ts';

// ---------------------------------------------------------------------------
// Configuration that a rebrand must not scatter
// ---------------------------------------------------------------------------

const BRANDING = {
  productName: 'ChargeWatch',
  appId: 'com.formicaria.chargewatch',
  releaseOwner: 'Calvinrobison',
  releaseRepo: 'ChargeTracker-App',
} as const;

const TILE_ORIGINS = ['https://tile.openstreetmap.org'] as const;
const UPDATE_ORIGINS = [
  'https://api.github.com',
  'https://github.com',
  'https://objects.githubusercontent.com',
] as const;
const EXTERNAL_LINK_ORIGINS = [
  'https://driver.chargepoint.com',
  'https://www.chargepoint.com',
  'https://na.chargepoint.com',
  'https://www.openstreetmap.org',
  'https://afdc.energy.gov',
  `https://github.com`,
] as const;

const isDevelopment = !app.isPackaged;

// ---------------------------------------------------------------------------
// Self-check mode
// ---------------------------------------------------------------------------

/**
 * `--self-check` runs the real startup sequence with no window, no tray, no
 * collection loop and no updater, writes a machine-readable report and exits.
 *
 * It exists because the things most likely to be broken in a packaged build —
 * a native SQLite module that will not load for the Electron ABI, a bundled
 * Chromium that is not where `process.resourcesPath` says it should be,
 * migrations that were not embedded — cannot be established by any check that
 * runs before packaging. They need the installed application to actually open
 * its database and actually start its browser.
 *
 * The report separates two kinds of result, because conflating them would make
 * the check either useless or dishonest:
 *
 *   - INTEGRITY checks (writable data folder, database, bundled browser) must
 *     pass. A failure means the package is broken and the exit code is 1.
 *   - READINESS checks (an eligible source, a loaded station catalog) are
 *     reported but do not fail the run. They are expected to be unmet in a
 *     fresh install until a source has been cleared for collection and a
 *     catalog has been imported. Failing on them would mean a correct package
 *     could never pass, so they are reported as unmet rather than as broken.
 *
 * `--self-check` is deliberately not a way to fake a check: every line in the
 * report comes from the same `runHealthChecks()` the onboarding screen shows.
 */
const SELF_CHECK_INTEGRITY_IDS = ['data_dir', 'database', 'browser'] as const;
const SELF_CHECK_READINESS_IDS = ['sources', 'catalog'] as const;

/**
 * The ceiling on a whole `--self-check` run. Generous next to the 817 ms a
 * healthy run takes, and far below the sum of the individual RPC timeouts it
 * replaces as the effective limit.
 */
const SELF_CHECK_DEADLINE_MS = 90_000;

const selfCheckRequested = process.argv.some(
  (argument) => argument === '--self-check' || argument.startsWith('--self-check='),
);

function selfCheckOutputPath(fallbackDir: string): string {
  const inline = process.argv.find((argument) => argument.startsWith('--self-check='));
  if (inline) {
    const value = inline.slice('--self-check='.length).trim();
    if (value.length > 0) return value;
  }
  const flagIndex = process.argv.indexOf('--self-check-out');
  if (flagIndex !== -1) {
    const value = process.argv[flagIndex + 1];
    if (value && !value.startsWith('--')) return value;
  }
  return join(fallbackDir, 'self-check.json');
}

/**
 * The local (non-roaming) application data directory.
 *
 * On Windows this MUST NOT be derived from `app.getPath('userData')`. Electron
 * builds that from `app.getPath('appData')`, which is `%APPDATA%` — the
 * ROAMING profile. Stripping its last segment therefore yielded
 * `...\AppData\Roaming`, and the history file was created in a directory that
 * OneDrive and every other sync client replicates. A live SQLite database in
 * WAL mode there can be corrupted by the sync client, which is why
 * `resolveDataPaths` lists `appdata\roaming` as a roaming hint — the
 * application was raising `cloud_roaming_directory` against its own data
 * directory on every start, and README.md documented a location it did not use.
 *
 * `%LOCALAPPDATA%` is the correct home and the one the documentation promises.
 * The fallback keeps the old derivation for the case where the variable is
 * missing, because a wrong directory still beats refusing to start.
 */
function localAppDataDirectory(): string {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA?.trim();
    if (local && local.length > 0) return local;
  }
  return app.getPath('userData').replace(/[\\/][^\\/]+$/, '');
}

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------

// A second launch must activate the existing window, never start a second
// collector or a second update coordinator.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

let logger: Logger;
let paths: ResolvedPaths;
let windows: WindowManager;
let tray: TrayController;
let router: IpcRouter;
let databaseWorker: SupervisedWorker;
let collectorWorker: SupervisedWorker;
let updates: UpdateService | null = null;

let settingsCache: Record<string, unknown> = {};
let collectionStatus: CollectionStatusView | null = null;
let sourceHealth: SourceHealthView[] = [];
let databaseState: DatabaseReadyState | null = null;
let maintenanceActive = false;
let sessionEnding = false;
let quitting = false;
const healthChecks: BootstrapView['healthChecks'][number][] = [];

function setting<T>(key: string, fallback: T): T {
  const value = settingsCache[key];
  return value === undefined || value === null ? fallback : (value as T);
}

function emit<N extends EventName>(event: N, payload: EventPayloads[N]): void {
  // `windows` is absent in self-check mode, which runs the startup sequence
  // without a user interface. An event with nowhere to go is dropped rather
  // than crashing the check that produced it.
  windows?.send(IPC_CHANNEL_EVENT, { contractVersion: IPC_CONTRACT_VERSION, event, payload });
}

// ---------------------------------------------------------------------------
// Worker plumbing
// ---------------------------------------------------------------------------

async function db<T>(op: string, payload: unknown = {}, timeoutMs?: number): Promise<T> {
  try {
    return await databaseWorker.request<T>(op, payload, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not open|unavailable|exited/i.test(message)) {
      throw new OperationError('worker_unavailable', message);
    }
    if (/locked|busy/i.test(message)) throw new OperationError('database_locked', message);
    if (/timed out/i.test(message)) throw new OperationError('timeout', message);
    throw new OperationError('internal_error', message);
  }
}

async function collector<T>(op: string, payload: unknown = {}, timeoutMs?: number): Promise<T> {
  try {
    return await collectorWorker.request<T>(op, payload, timeoutMs);
  } catch (error) {
    throw new OperationError(
      'worker_unavailable',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Loads the enabled bindings and the persisted queue into the collector. */
async function loadCollectorState(): Promise<void> {
  const state = await db<{
    queue: QueueEntry[];
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
      expectedLevel: 'level_1' | 'level_2' | 'dc_fast' | 'mixed' | 'unknown';
    }>;
  }>('loadCollectorState');
  await collector('load', state);
}

async function refreshCollectionStatus(): Promise<CollectionStatusView> {
  const status = await collector<{
    running: boolean;
    userPaused: boolean;
    online: boolean;
    queueLag: number;
    effectiveIntervalMs: number | null;
    nextCheckMs: number | null;
    anySourceUnhealthy: boolean;
  }>('status');

  const view = await db<CollectionStatusView>('collectionStatus', {
    ...status,
    targetIntervalMs: COLLECTION_DEFAULTS.targetIntervalMs,
  });

  collectionStatus = view;
  tray.setStatus(view);
  emit('collection.status', view);
  return view;
}

async function refreshSourceHealth(): Promise<SourceHealthView[]> {
  const raw = await collector<
    Array<{
      sourceId: string;
      capabilities: {
        displayName: string;
        eligibilityState: 'enabled' | 'disabled' | 'needs_review';
        verificationState: 'verified' | 'unverified' | 'blocked';
        notes: string | null;
      };
      state: SourceHealthView['state'];
      detail: string | null;
      userAction: string | null;
      backoffUntilMs: number | null;
    }>
  >('sourceHealth');

  sourceHealth = raw.map((entry) => ({
    sourceId: entry.sourceId,
    displayName: entry.capabilities.displayName,
    state: entry.state,
    eligibilityState: entry.capabilities.eligibilityState,
    verificationState: entry.capabilities.verificationState,
    message:
      entry.detail ??
      (entry.capabilities.eligibilityState !== 'enabled'
        ? `${entry.capabilities.displayName} collection is not enabled yet. ${entry.capabilities.notes ?? ''}`.trim()
        : null),
    userAction: entry.userAction,
    lastSuccessMs: null,
    retryAtMs: entry.backoffUntilMs,
  }));

  emit('source.health', { sources: sourceHealth });
  return sourceHealth;
}

/** Handles unsolicited messages from the collector worker. */
function onCollectorNotification(notification: { notify: string; payload: unknown }): void {
  switch (notification.notify) {
    case 'log': {
      const entry = notification.payload as {
        level: 'debug' | 'info' | 'warn' | 'error';
        message: string;
      };
      logger.log(entry.level, `[collector] ${entry.message}`);
      break;
    }
    case 'run': {
      // Hand the completed run straight to the database worker. The collector
      // never writes SQLite itself.
      const report = notification.payload as RunReport;
      void db('ingestRun', report, 120_000)
        .then(() => refreshCollectionStatus())
        .catch((error: unknown) => {
          logger.log(
            'error',
            `failed to persist collection run: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      break;
    }
    case 'gap':
      void db('recordGap', notification.payload).catch(() => undefined);
      break;
    case 'queue':
      void db('persistQueue', { entries: notification.payload }).catch(() => undefined);
      break;
    case 'sourceHealth':
      void db('persistSourceHealth', notification.payload)
        .then(() => refreshSourceHealth())
        .catch(() => undefined);
      break;
    case 'status':
      void refreshCollectionStatus().catch(() => undefined);
      break;
    case 'discoveryProgress': {
      const progress = notification.payload as { pagesRead: number; stationsSoFar: number };
      emit('toast', {
        level: 'info',
        message: `Finding ChargePoint stations… ${progress.stationsSoFar} so far (page ${progress.pagesRead})`,
      });
      break;
    }
    default:
      break;
  }
}

function onDatabaseNotification(notification: { notify: string; payload: unknown }): void {
  if (notification.notify === 'dataChanged') {
    emit('data.changed', notification.payload as EventPayloads['data.changed']);
  }
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

/**
 * Runs the startup checks the onboarding screen reports.
 *
 * Each check has a precise recovery action. None of them asks the user to find
 * a browser or supply an executable path.
 */
async function runHealthChecks(): Promise<void> {
  healthChecks.length = 0;

  const push = (
    id: string,
    label: string,
    status: 'pass' | 'fail' | 'warn' | 'not_applicable',
    detail: string | null,
    recoveryAction: string | null,
  ): void => {
    healthChecks.push({ id, label, status, detail, recoveryAction });
  };

  // Writable data directory.
  try {
    const probe = join(paths.root, '.write-probe');
    await mkdir(paths.root, { recursive: true });
    await writeFile(probe, 'ok', 'utf8');
    push('data_dir', 'Data folder is writable', 'pass', paths.root, null);
  } catch (error) {
    push(
      'data_dir',
      'Data folder is writable',
      'fail',
      error instanceof Error ? error.message : String(error),
      'ChargeWatch cannot write to its data folder. Check that your user account has access to it, then restart ChargeWatch.',
    );
  }

  // Database.
  if (databaseState?.status === 'ready') {
    push(
      'database',
      'History file is ready',
      'pass',
      `schema ${databaseState.schemaVersion}, journal mode ${databaseState.journalMode}`,
      null,
    );
  } else if (databaseState?.status === 'schema_too_new') {
    push(
      'database',
      'History file is ready',
      'fail',
      databaseState.detail,
      'Install the newer version of ChargeWatch that created this history file.',
    );
  } else {
    push(
      'database',
      'History file is ready',
      'fail',
      databaseState?.status === 'migration_failed' ? databaseState.detail : 'not opened',
      'Open Settings → Data and backups and restore a backup, or contact support with a diagnostics export.',
    );
  }

  // Bundled browser.
  try {
    const browser = await collector<{ ok: boolean; detail: string | null }>(
      'healthCheck',
      {},
      60_000,
    );
    push(
      'browser',
      'Bundled browser starts',
      browser.ok ? 'pass' : 'fail',
      browser.detail,
      browser.ok
        ? null
        : 'Reinstall ChargeWatch. The bundled browser is part of the installer and is not something you need to download separately.',
    );
  } catch (error) {
    push(
      'browser',
      'Bundled browser starts',
      'fail',
      error instanceof Error ? error.message : String(error),
      'Reinstall ChargeWatch.',
    );
  }

  // Source eligibility — reported honestly, including "not enabled".
  const health = await refreshSourceHealth().catch(() => [] as SourceHealthView[]);
  const enabled = health.filter((source) => source.eligibilityState === 'enabled');
  if (enabled.length > 0) {
    push(
      'sources',
      'A charger status source is enabled',
      'pass',
      enabled.map((s) => s.displayName).join(', '),
      null,
    );
  } else {
    push(
      'sources',
      'A charger status source is enabled',
      'fail',
      health.length === 0
        ? 'no sources are registered'
        : health
            .map((s) => `${s.displayName}: ${s.eligibilityState} / ${s.verificationState}`)
            .join('; '),
      'No source has been cleared for automated collection yet, so no observations can be recorded. See docs/SOURCE_VERIFICATION.md.',
    );
  }

  // Catalog.
  const counts = await db<{ catalogSites: number; monitoredScopes: number; observations: number }>(
    'counts',
  ).catch(() => ({ catalogSites: 0, monitoredScopes: 0, observations: 0 }));
  push(
    'catalog',
    'Station catalog is loaded',
    counts.catalogSites > 0 ? 'pass' : 'fail',
    `${counts.catalogSites} catalog locations, ${counts.monitoredScopes} monitored`,
    counts.catalogSites > 0
      ? null
      : 'No station catalog has been imported yet. A maintainer needs to run the catalog refresh; see docs/SOURCES.md.',
  );

  // Network.
  push(
    'network',
    'Network is reachable',
    'not_applicable',
    'Checked when collection runs, so ChargeWatch does not make a request just to test it.',
    null,
  );
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

function registerHandlers(): void {
  router.register('app.getBootstrap', async () => {
    settingsCache = await db<Record<string, unknown>>('getSettings');
    const counts = await db<{
      catalogSites: number;
      monitoredScopes: number;
      observations: number;
    }>('counts');
    const status = collectionStatus ?? (await refreshCollectionStatus());

    const bootstrap: BootstrapView = {
      contractVersion: IPC_CONTRACT_VERSION,
      appVersion: app.getVersion(),
      schemaVersion: TARGET_SCHEMA_VERSION,
      onboardingComplete: setting('ui.onboardingComplete', false),
      studyArea: {
        centerLatitude: setting('study.centerLatitude', STUDY_AREA_DEFAULTS.centerLatitude),
        centerLongitude: setting('study.centerLongitude', STUDY_AREA_DEFAULTS.centerLongitude),
        radiusMiles: setting('study.radiusMiles', STUDY_AREA_DEFAULTS.radiusMiles),
        label: setting('study.label', STUDY_AREA_DEFAULTS.label),
        timeZone: setting('study.timeZone', STUDY_TIME_ZONE),
      },
      counts,
      collection: status,
      sources: sourceHealth,
      healthChecks,
      dataDirectory: paths.root,
      diskUsageBytes: await db<number | null>('diskUsageBytes').catch(() => null),
      startWithWindows: app.getLoginItemSettings().openAtLogin,
      theme: setting('ui.theme', 'dark'),
      demoMode: setting('demo.enabled', false),
      studyStartMs: await db<number | null>('studyStartMs').catch(() => null),
    };
    return bootstrap;
  });

  router.register('settings.update', async (payload) => {
    const applied = await db<string[]>('updateSettings', { entries: payload.entries });
    settingsCache = await db<Record<string, unknown>>('getSettings');

    if ('startup.startWithWindows' in payload.entries) {
      const open = payload.entries['startup.startWithWindows'] === true;
      app.setLoginItemSettings({ openAtLogin: open, args: ['--hidden'] });
    }
    if ('ui.theme' in payload.entries) {
      nativeTheme.themeSource = payload.entries['ui.theme'] === 'light' ? 'light' : 'dark';
    }
    emit('data.changed', { reason: 'settings' });
    return { applied };
  });

  router.register('overview.get', async (payload) => db('overview', payload, 30_000));

  router.register('map.getMarkers', async (payload) => db('mapMarkers', payload, 30_000));

  router.register('station.getDetail', async (payload) => {
    const detail = await db<StationDetailView | null>('stationDetail', payload, 30_000);
    if (!detail) throw new OperationError('invalid_payload', `unknown site ${payload.siteId}`);
    return detail;
  });

  router.register('station.getDetailById', async (payload) => {
    const detail = await db<StationDetailView | null>(
      'stationDetail',
      { siteId: payload.siteId, window: { preset: '30d' } },
      30_000,
    );
    if (!detail) throw new OperationError('invalid_payload', `unknown site ${payload.siteId}`);
    return detail;
  });

  router.register('station.setSaved', async (payload) => db('setSaved', payload));

  router.register('sites.setMonitored', async (payload) => {
    const result = await db<{ enabledCount: number; refusedCount: number; refusals: string[] }>(
      'setMonitored',
      payload,
      30_000,
    );
    await loadCollectorState();
    await refreshCollectionStatus();
    return result;
  });

  router.register('sites.addManualLink', async (payload) => {
    const result = await db<{ ok: boolean; code: string; detail: string | null }>(
      'addManualLink',
      payload,
      30_000,
    );
    if (result.ok) {
      await loadCollectorState();
      emit('data.changed', { reason: 'bindings' });
    }
    return result;
  });

  router.register('sites.setMonitoredAll', async (payload) => {
    const siteIds = await db<string[]>('linkedSiteIds');
    if (siteIds.length === 0) {
      return { enabledCount: 0, refusedCount: 0, refusals: [] };
    }
    const result = await db<{ enabledCount: number; refusedCount: number; refusals: string[] }>(
      'setMonitored',
      { siteIds, enabled: payload.enabled },
      60_000,
    );
    await loadCollectorState();
    await refreshCollectionStatus();
    emit('data.changed', { reason: 'bindings' });
    return result;
  });

  router.register('sources.discover', async (payload) => {
    if (payload.sourceId !== 'chargepoint') {
      throw new OperationError('invalid_payload', `no discovery for source ${payload.sourceId}`);
    }
    const area = {
      centerLatitude: setting('study.centerLatitude', STUDY_AREA_DEFAULTS.centerLatitude),
      centerLongitude: setting('study.centerLongitude', STUDY_AREA_DEFAULTS.centerLongitude),
      radiusMiles: setting('study.radiusMiles', STUDY_AREA_DEFAULTS.radiusMiles),
    };
    logger.log(
      'info',
      `discovering ChargePoint stations within ${area.radiusMiles} miles of ${area.centerLatitude}, ${area.centerLongitude}`,
    );
    const report = await collector<{
      stations: readonly unknown[];
      pagesRead: number;
      truncated: boolean;
      warnings: readonly string[];
    }>('discover', { area }, 840_000);

    const bound = await db<{
      linked: number;
      alreadyLinked: number;
      proposed: number;
      unmatched: number;
      siteConflicts: number;
      proposals: ResponseOf<'sources.discover'>['proposals'];
      unmatchedStations: ResponseOf<'sources.discover'>['unmatchedStations'];
    }>('bindDiscoveredStations', { stations: report.stations }, 120_000);

    logger.log(
      'info',
      `discovery found ${report.stations.length} stations: ${bound.linked} linked, ${bound.alreadyLinked} already linked, ${bound.proposed} proposed, ${bound.unmatched} not in the catalog`,
    );
    if (bound.linked > 0) {
      await loadCollectorState();
      emit('data.changed', { reason: 'bindings' });
    }
    return {
      found: report.stations.length,
      ...bound,
      pagesRead: report.pagesRead,
      truncated: report.truncated,
      warnings: report.warnings,
    };
  });

  router.register('collection.setRunning', async (payload) => {
    await db('updateSettings', {
      entries: { 'collection.running': payload.running, 'collection.userPaused': !payload.running },
    });
    settingsCache = await db<Record<string, unknown>>('getSettings');
    await collector(payload.running ? 'start' : 'pause', { reason: 'user_paused' }, 60_000);
    return refreshCollectionStatus();
  });

  router.register('collection.refreshNow', async (payload) => {
    const bindingIds = await db<string[]>('bindingIdsForSites', { siteIds: payload.siteIds });
    return collector('refreshNow', { bindingIds });
  });

  router.register('source.openWindow', async (payload) => {
    const detail = await db<{ url: string | null }>('sourceUrlForSite', { siteId: payload.siteId });
    if (!detail.url)
      throw new OperationError('invalid_payload', 'that location has no source link');
    await collector('openSourceWindow', { url: detail.url }, 60_000);
    return { opened: true };
  });

  router.register('export.currentView', async (payload) => {
    const destination = await chooseSavePath('current view', payload.destinationPath);
    if (!destination) return { written: false, path: '', rowCount: 0 };
    maintenanceActive = true;
    try {
      const result = await db<{ path: string; rowCount: number }>(
        'exportCurrentView',
        { ...payload, destinationPath: destination },
        180_000,
      );
      return { written: true, ...result };
    } finally {
      maintenanceActive = false;
    }
  });

  router.register('export.rawObservations', async (payload) => {
    const destination = await chooseSavePath('raw observations', payload.destinationPath);
    if (!destination) return { written: false, path: '', rowCount: 0 };
    maintenanceActive = true;
    try {
      const result = await db<{ path: string; rowCount: number }>(
        'exportRawObservations',
        { ...payload, destinationPath: destination },
        600_000,
      );
      return { written: true, ...result };
    } finally {
      maintenanceActive = false;
    }
  });

  router.register('visits.getTemplate', async () => {
    const headers = VISIT_TEMPLATE_HEADERS;
    const example = [
      'site-id-from-the-station-details-panel',
      '2026-09-01T00:00:00-07:00',
      '2026-10-01T00:00:00-07:00',
      'America/Phoenix',
      '12345',
      'property_entries',
      'measured',
      'Property manager door counter',
      'https://example.com/or-a-note-about-where-this-came-from',
      'whole_property',
      'Counts exclude staff entrances',
    ];
    return {
      headers,
      csv: `${headers.join(',')}\r\n${example.map((cell) => (cell.includes(',') ? `"${cell}"` : cell)).join(',')}\r\n`,
    };
  });

  router.register('visits.previewImport', async (payload) =>
    db('previewVisitImport', payload, 120_000),
  );
  router.register('visits.commitImport', async (payload) => {
    const result = await db<{ imported: number; importId: string }>(
      'commitVisitImport',
      payload,
      180_000,
    );
    emit('data.changed', { reason: 'visits' });
    return result;
  });
  router.register('visits.addManual', async (payload) => {
    const result = await db<{ ok: boolean; issues: string[] }>('addManualVisit', payload);
    if (result.ok) emit('data.changed', { reason: 'visits' });
    return result;
  });

  router.register('backup.createNow', async () => {
    maintenanceActive = true;
    try {
      const result = await db<{ manifest: { fileName: string } }>(
        'createBackup',
        { kind: 'manual' },
        300_000,
      );
      return { ok: true, fileName: result.manifest.fileName, detail: null };
    } catch (error) {
      return {
        ok: false,
        fileName: null,
        detail: error instanceof Error ? error.message : String(error),
      };
    } finally {
      maintenanceActive = false;
    }
  });

  router.register('backup.list', async () => ({
    backups: await db<ResponseOf<'backup.list'>['backups']>('listBackups'),
  }));

  router.register('restore.preview', async (payload) => {
    const preview = await db<{
      ok: boolean;
      rejection?: string;
      detail?: string;
      schemaVersion?: number;
      observationCount?: number;
      siteCount?: number;
      firstObservationMs?: number | null;
      latestObservationMs?: number | null;
    }>('previewRestore', payload, 120_000);
    return {
      ok: preview.ok,
      rejection: preview.rejection ?? null,
      detail: preview.detail ?? null,
      schemaVersion: preview.schemaVersion ?? null,
      observationCount: preview.observationCount ?? null,
      siteCount: preview.siteCount ?? null,
      firstObservationMs: preview.firstObservationMs ?? null,
      latestObservationMs: preview.latestObservationMs ?? null,
    };
  });

  router.register('restore.perform', async (payload) => {
    maintenanceActive = true;
    try {
      // Collection stops before the database is touched.
      await collector('pause', { reason: 'update_install' }, 60_000);
      const result = await db<{
        ok: boolean;
        detail: string | null;
        preservedPreviousPath: string | null;
      }>('performRestore', { filePath: payload.filePath }, 600_000);
      if (result.ok) {
        await loadCollectorState();
        emit('data.changed', { reason: 'restore' });
      }
      return result;
    } finally {
      maintenanceActive = false;
    }
  });

  router.register('data.deleteRange', async (payload) => {
    maintenanceActive = true;
    try {
      return await db<{ deleted: number }>(
        'deleteObservationsBefore',
        { beforeMs: payload.beforeMs },
        300_000,
      );
    } finally {
      maintenanceActive = false;
    }
  });

  router.register('diagnostics.export', async (payload) => {
    const destination = await chooseSavePath('diagnostics', payload.destinationPath, 'txt');
    if (!destination) return { written: false, path: '', byteSize: 0, contents: [] };

    // Diagnostics are user-exported, previewable and redacted. Profiles,
    // credentials and the database are never included.
    const sections = [
      `ChargeWatch diagnostics — ${new Date().toISOString()}`,
      `version ${app.getVersion()} · schema ${TARGET_SCHEMA_VERSION} · electron ${process.versions.electron ?? 'unknown'}`,
      `data directory: ${paths.root}`,
      `database: ${JSON.stringify(databaseState)}`,
      `collection: ${JSON.stringify(collectionStatus)}`,
      `sources: ${JSON.stringify(sourceHealth)}`,
      `health checks: ${JSON.stringify(healthChecks)}`,
      `settings: ${JSON.stringify(settingsCache)}`,
      '--- recent log ---',
      ...logger.tail(300),
    ];
    const body = redactDiagnosticText(sections.join('\n'), homedir());
    await writeFile(destination, body, 'utf8');
    return {
      written: true,
      path: destination,
      byteSize: Buffer.byteLength(body, 'utf8'),
      contents: [
        'version and environment',
        'database state',
        'collection and source state',
        'health checks',
        'settings',
        'recent log (redacted)',
      ],
    };
  });

  router.register('update.getState', async () => {
    if (!updates) {
      return {
        installedVersion: app.getVersion(),
        state: 'idle' as const,
        availableVersion: null,
        downloadedPercent: null,
        detail: 'Updates are disabled in development builds.',
        autoCheckEnabled: false,
        autoDownloadEnabled: false,
        autoInstallEnabled: false,
        consecutiveFailures: 0,
        manualDownloadUrl: null,
      };
    }
    return updates.snapshot();
  });

  router.register('update.check', async () => {
    if (!updates) return { started: false, detail: 'Updates are disabled in development builds.' };
    return updates.check({ manual: true });
  });

  router.register('update.restartAndInstall', async () => {
    if (!updates) return { accepted: false, detail: 'Updates are disabled in development builds.' };
    return updates.restartAndInstall();
  });

  router.register('onboarding.complete', async (payload) => {
    await db('updateSettings', {
      entries: {
        'ui.onboardingComplete': true,
        'startup.startWithWindows': payload.startWithWindows,
        'collection.running': payload.startCollecting,
        'collection.userPaused': !payload.startCollecting,
      },
    });
    settingsCache = await db<Record<string, unknown>>('getSettings');
    app.setLoginItemSettings({ openAtLogin: payload.startWithWindows, args: ['--hidden'] });
    if (payload.startCollecting) await collector('start', {}, 60_000);
    return refreshCollectionStatus();
  });

  router.register('shell.openDataFolder', async () => {
    await shell.openPath(paths.root);
    return { opened: true };
  });

  const missing = router.missingHandlers();
  if (missing.length > 0) {
    // A contract operation with no handler is a build error, not a runtime
    // surprise for the user.
    logger.log('error', `IPC operations declared with no handler: ${missing.join(', ')}`);
  }
}

/**
 * Opens a Save As dialog, and refuses destinations that would overwrite the
 * live database, a browser profile or the install directory.
 */
async function chooseSavePath(
  kind: string,
  suggested: string,
  extension = 'csv',
): Promise<string | null> {
  const parent = windows.browserWindow;
  const result = await (parent
    ? dialog.showSaveDialog(parent, {
        title: `Save ${kind}`,
        defaultPath: suggested,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      })
    : dialog.showSaveDialog({
        title: `Save ${kind}`,
        defaultPath: suggested,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      }));

  if (result.canceled || !result.filePath) return null;

  const permitted = isPermittedWriteDestination(result.filePath, paths, app.getAppPath());
  if (!permitted.permitted) {
    await dialog.showMessageBox({
      type: 'warning',
      title: 'That location cannot be used',
      message: permitted.reason ?? 'ChargeWatch will not write there.',
      detail: 'Choose somewhere else, such as your Documents folder.',
    });
    throw new OperationError('path_not_permitted', permitted.reason ?? undefined);
  }
  return result.filePath;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function startDatabase(): Promise<void> {
  databaseWorker = new SupervisedWorker({
    name: 'chargewatch-database',
    entryPath: join(app.getAppPath(), 'out', 'workers', 'database.js'),
    args: [
      JSON.stringify({
        databaseFile: paths.databaseFile,
        databaseDir: paths.databaseDir,
        backupsDir: paths.backupsDir,
        stagingDir: paths.stagingDir,
        appVersion: app.getVersion(),
        timeZone: setting('study.timeZone', STUDY_TIME_ZONE),
      }),
    ],
    log: logger.bind(),
    onNotification: onDatabaseNotification,
    onRestarted: async () => {
      databaseState = await databaseWorker.request<DatabaseReadyState>('open', {}, 120_000);
    },
    defaultTimeoutMs: 60_000,
  });

  await databaseWorker.start();
  databaseState = await databaseWorker.request<DatabaseReadyState>('open', {}, 180_000);

  if (databaseState.status !== 'ready') {
    // A migration failure or a too-new schema stops collection and shows a
    // clear recovery path. It does not destroy anything.
    logger.log('error', `the database could not be opened: ${JSON.stringify(databaseState)}`);
    const detail =
      databaseState.status === 'schema_too_new'
        ? databaseState.detail
        : databaseState.status === 'migration_failed'
          ? databaseState.detail
          : 'unknown';
    await dialog
      .showMessageBox({
        type: 'error',
        title: 'ChargeWatch could not open its history file',
        message:
          databaseState.status === 'schema_too_new'
            ? 'This history file was written by a newer version of ChargeWatch.'
            : 'ChargeWatch could not upgrade its history file.',
        detail:
          `${detail}\n\nYour existing data has NOT been changed. ` +
          `A backup was preserved where one could be made. ` +
          `Collection is stopped until this is resolved. See docs/UPDATES_AND_RECOVERY.md.`,
        buttons: ['Open data folder', 'Close'],
        defaultId: 0,
      })
      .then(async (choice) => {
        if (choice.response === 0) await shell.openPath(paths.root);
      });
    return;
  }

  settingsCache = await db<Record<string, unknown>>('getSettings');
  await importBundledCatalog();
}

/**
 * Loads the station catalog the application ships into the database.
 *
 * Idempotent on the file's hash: the first start imports the 1083 locations,
 * every later start is a no-op, and an installer carrying a refreshed file
 * imports the new one through the conflict-recording refresh path. Until
 * 2026-09-21 this step did not exist — the catalog was packaged and never
 * read, so an installed copy started with an empty map.
 */
async function importBundledCatalog(): Promise<void> {
  const catalogDir = app.isPackaged
    ? join(process.resourcesPath, 'catalog')
    : join(app.getAppPath(), 'resources', 'catalog');
  try {
    const result = await db<{
      imported: boolean;
      reason: string;
      sites: number;
      inserted: number;
      updated: number;
      conflicts: number;
      detail: string | null;
    }>(
      'importCatalogFile',
      {
        filePath: join(catalogDir, 'mesa-stations.json'),
        provenancePath: join(catalogDir, 'provenance.json'),
      },
      180_000,
    );
    logger.log(
      result.reason === 'missing' || result.reason === 'invalid' ? 'warn' : 'info',
      `bundled catalog: ${result.reason} (${result.sites} locations${result.detail ? `; ${result.detail}` : ''})`,
    );
  } catch (error) {
    // A catalog that cannot be imported leaves the map empty and the health
    // check saying so; it must not stop the application from starting.
    logger.log(
      'warn',
      `the bundled catalog could not be imported: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function startCollector(): Promise<void> {
  collectorWorker = new SupervisedWorker({
    name: 'chargewatch-collector',
    entryPath: join(app.getAppPath(), 'out', 'workers', 'collector.js'),
    args: [
      JSON.stringify({
        profileDir: paths.browserProfilesDir,
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        developmentBrowserDir: join(app.getAppPath(), '.playwright-cache', 'chromium'),
        headless: true,
        locale: 'en-US',
        timezoneId: setting('study.timeZone', STUDY_TIME_ZONE),
        appVersion: app.getVersion(),
      }),
    ],
    log: logger.bind(),
    onNotification: onCollectorNotification,
    onRestarted: async () => {
      await loadCollectorState();
      if (setting('collection.running', false)) await collector('start', {}, 60_000);
    },
    defaultTimeoutMs: 120_000,
  });

  await collectorWorker.start();

  // The capability records the adapters declare are persisted before anything
  // else, so the UI can explain a source's eligibility and so source health
  // has a row to attach to.
  const described = await collector<{
    browserFound: boolean;
    browserPath: string;
    searchedPaths: readonly string[];
    sources: unknown[];
  }>('describe', {}, 30_000);
  await db('upsertSources', { sources: described.sources });
  if (!described.browserFound) {
    logger.log(
      'error',
      `the bundled browser is missing. Searched: ${described.searchedPaths.join(' ; ')}`,
    );
  }

  await loadCollectorState();
}

function startUpdates(): void {
  if (isDevelopment) {
    logger.log('info', 'updates are disabled in development builds');
    return;
  }

  // Loaded lazily so a development run never imports electron-updater.
  void import('electron-updater')
    .then(async (module) => {
      const keys = await import('../../resources/update-keys/keys.json', {
        with: { type: 'json' },
      }).catch(() => ({ default: { keys: [] } }));

      const parsed = parseTrustedKeys(keys.default);

      // Refused outright rather than filtered down to the usable entries. A
      // key file with a duplicate id or a malformed entry is a file nobody
      // should be trusting the rest of, and quietly verifying updates against
      // whatever survived is how a bad key becomes permanent.
      if (parsed.problems.length > 0) {
        for (const problem of parsed.problems) {
          logger.log('error', `update key file: ${problem}`);
        }
        logger.log(
          'error',
          'the embedded update keys are not usable, so this build will not check for or ' +
            'install updates. Collection is unaffected.',
        );
        return;
      }

      const trustedKeys = parsed.keys;

      if (trustedKeys.length === 0) {
        logger.log(
          'warn',
          'no update verification keys are embedded, so no update can be verified or installed. Run the maintainer key bootstrap before releasing.',
        );
        return;
      }

      // electron-updater is CommonJS, and the packaged build resolves its
      // exports under `.default` rather than on the namespace. Reading
      // `module.autoUpdater` directly produced `undefined` and the first
      // property assignment threw, so updates have never worked in a package.
      const autoUpdater = resolveAutoUpdater(module);
      if (!autoUpdater) {
        logger.log(
          'error',
          'electron-updater loaded but exposed no usable autoUpdater, so this build cannot ' +
            'check for or install updates. Collection is unaffected.',
        );
        return;
      }

      const backend = createUpdaterBackend({
        owner: BRANDING.releaseOwner,
        repo: BRANDING.releaseRepo,
        channel: 'stable',
        logger,
        autoUpdater,
        fetchReleaseAsset: async (name) => {
          const url = `https://github.com/${BRANDING.releaseOwner}/${BRANDING.releaseRepo}/releases/latest/download/${encodeURIComponent(name)}`;
          const response = await fetch(url, { redirect: 'follow' });
          if (!response.ok)
            throw new Error(`${name} could not be fetched (HTTP ${response.status})`);
          return new Uint8Array(await response.arrayBuffer());
        },
      });

      updates = new UpdateService(
        backend,
        {
          gates: {
            trayHiddenForMs: () => windows.hiddenForMs(),
            maintenanceActive: () => maintenanceActive,
            sessionEnding: () => sessionEnding,
            foregroundActive: () => windows.isForegroundActive(),
          },
          prepareForInstall: async () => {
            try {
              const result = await collector<{ clean: boolean }>('shutdown', {}, 40_000);
              await db('recordGap', {
                scopeKey: null,
                startMs: Date.now(),
                endMs: Date.now() + 1,
                reason: 'update_install',
                detail: 'update installation',
              }).catch(() => undefined);
              return {
                ok: true,
                detail: result.clean ? null : 'the collector did not stop cleanly',
              };
            } catch (error) {
              return {
                ok: false,
                detail: error instanceof Error ? error.message : String(error),
              };
            }
          },
          createPreUpdateBackup: async () => {
            try {
              await db('createBackup', { kind: 'pre_update' }, 300_000);
              return { ok: true, detail: null };
            } catch (error) {
              return { ok: false, detail: error instanceof Error ? error.message : String(error) };
            }
          },
          persistRelaunchState: async () => {
            await db('updateSettings', {
              entries: {
                'relaunch.collectionWasRunning': setting('collection.running', false),
                'relaunch.windowWasVisible': windows.isForegroundActive(),
                'relaunch.userPaused': setting('collection.userPaused', false),
              },
            }).catch(() => undefined);
          },
          recordEvent: async (event, detail, extra) => {
            await db('recordUpdateEvent', { event, detail, extra }).catch(() => undefined);
          },
          readHighestAcceptedSequence: async () =>
            db<number>('readHighestAcceptedSequence').catch(() => 0),
          writeHighestAcceptedSequence: async (sequence) => {
            await db('writeHighestAcceptedSequence', { sequence }).catch(() => undefined);
          },
          settings: {
            autoCheck: () => setting('updates.autoCheck', true),
            autoDownload: () => setting('updates.autoDownload', true),
            autoInstall: () => setting('updates.autoInstall', true),
          },
          onStateChange: () => {
            const snapshot = updates?.snapshot();
            if (!snapshot) return;
            emit('update.state', snapshot);
            tray.setUpdateLabel(
              snapshot.state === 'ready' || snapshot.state === 'deferred'
                ? `Restart to update to ${snapshot.availableVersion ?? 'the new version'}`
                : 'Check for updates',
            );
          },
          log: logger.bind(),
        },
        {
          applicationId: BRANDING.appId,
          installedVersion: app.getVersion(),
          platform: process.platform as 'win32' | 'darwin' | 'linux',
          arch: process.arch as 'x64' | 'arm64' | 'ia32',
          trustedKeys,
          writableDbSchema: TARGET_SCHEMA_VERSION,
          acceptedChannels: ['stable'],
          manifestFileName: 'release-manifest.json',
          signatureFileName: 'release-manifest.json.sig',
        },
      );

      updates.startPeriodicChecks();
    })
    .catch((error: unknown) => {
      logger.log(
        'warn',
        `the updater could not be initialised: ${error instanceof Error ? error.message : String(error)}. ChargeWatch keeps collecting.`,
      );
    });
}

/**
 * Runs the startup sequence far enough to prove the package works, writes the
 * report, and exits. Never creates a window, a tray icon, an updater or a
 * collection schedule.
 */
async function runSelfCheck(): Promise<void> {
  const startedMs = Date.now();
  const resolution = resolveDataPaths({
    localAppDataDir: localAppDataDirectory(),
    installDir: app.getAppPath(),
    platform: process.platform,
  });
  paths = resolution.paths;

  logger = new Logger({
    logsDir: paths.logsDir,
    minLevel: 'debug',
    homeDirectory: homedir(),
    mirrorToConsole: true,
  });
  logger.log('info', `${BRANDING.productName} ${app.getVersion()} self-check`);

  const outputPath = selfCheckOutputPath(paths.root);
  const fatal: string[] = [];

  /**
   * A hard ceiling on the whole check.
   *
   * Every RPC below already has its own timeout, but they are sequential and
   * the collector's default is 120 s. An unresponsive worker therefore did not
   * fail the check — it made it sit through one timeout after another, roughly
   * ten minutes in total, with no output and no report. A diagnostic tool that
   * hangs is worse than one that fails, because the operator learns nothing and
   * cannot tell a slow check from a dead one.
   *
   * On expiry the process exits non-zero rather than writing a report: a report
   * assembled from half-finished checks would claim more than was established.
   */
  const deadline = setTimeout(() => {
    logger.log(
      'error',
      `self-check exceeded ${SELF_CHECK_DEADLINE_MS} ms and was abandoned; a worker did not respond`,
    );
    logger.close();
    app.exit(1);
  }, SELF_CHECK_DEADLINE_MS);
  deadline.unref();

  try {
    await startDatabase();
  } catch (error) {
    fatal.push(
      `the database worker did not start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (databaseState?.status === 'ready') {
    try {
      await startCollector();
    } catch (error) {
      fatal.push(
        `the collector worker did not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  try {
    await runHealthChecks();
  } catch (error) {
    fatal.push(
      `the health checks could not complete: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const byId = (id: string) => healthChecks.find((check) => check.id === id) ?? null;
  /** A check that did not run is reported as not_run, never as a pass. */
  const notRun = (id: string) => ({
    label: id,
    status: 'not_run' as const,
    detail: 'the check did not run',
    recoveryAction: null,
  });
  // `id` goes last: the spread carries its own, and a trailing key is the one
  // that wins. Putting it first made it dead.
  const integrity = SELF_CHECK_INTEGRITY_IDS.map((id) => ({ ...(byId(id) ?? notRun(id)), id }));
  const readiness = SELF_CHECK_READINESS_IDS.map((id) => ({ ...(byId(id) ?? notRun(id)), id }));

  const brokenIntegrity = integrity.filter((check) => check.status !== 'pass');
  const verdict = fatal.length === 0 && brokenIntegrity.length === 0 ? 'pass' : 'fail';

  const report = {
    formatVersion: 1,
    verdict,
    ranAtIso: new Date(startedMs).toISOString(),
    durationMs: Date.now() - startedMs,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? null,
    chromeVersion: process.versions.chrome ?? null,
    nodeVersion: process.versions.node,
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    schemaVersion: TARGET_SCHEMA_VERSION,
    dataDirectory: paths.root,
    resourcesPath: process.resourcesPath,
    pathWarnings: resolution.warnings,
    database: databaseState,
    // These must pass for the package to be considered sound.
    integrity,
    // Reported, but expected to be unmet until a source is cleared and a
    // catalog is imported. They do not fail the run.
    readiness,
    fatal,
    note:
      'integrity failures mean the installed package is broken. readiness entries describe what ' +
      'the installation cannot yet do, which is not the same thing. Nothing here is inferred: every ' +
      'line comes from the same startup checks the application shows on its onboarding screen.',
  };

  try {
    await mkdir(paths.root, { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    logger.log('info', `self-check ${verdict}; report written to ${outputPath}`);
  } catch (error) {
    logger.log(
      'error',
      `the self-check report could not be written to ${outputPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    await collectorWorker?.stop(20_000);
  } catch {
    // Already reported through the checks above.
  }
  try {
    await databaseWorker?.stop(20_000);
  } catch {
    // Same.
  }
  clearTimeout(deadline);
  logger.close();

  // The exit code is the gate. A caller that only reads stdout still gets a
  // truthful answer.
  app.exit(verdict === 'pass' ? 0 : 1);
}

/**
 * Runs one startup stage, logging when it begins, how long it took, and what
 * it threw.
 *
 * Bootstrap used to log a single line — "ChargeWatch <version> starting" — and
 * then nothing until shutdown. When a stage hung, the log could not say which
 * one, so the only evidence a stuck launch produced was the absence of
 * evidence. The stages that follow allow 180, 120 and 60 seconds respectively;
 * a log that stops after one of these names it immediately.
 */
async function stage<T>(name: string, run: () => Promise<T>): Promise<T> {
  logger.log('info', `startup: ${name}`);
  const started = Date.now();
  try {
    const result = await run();
    logger.log('info', `startup: ${name} - done in ${Date.now() - started} ms`);
    return result;
  } catch (error) {
    logger.log(
      'error',
      `startup: ${name} - FAILED after ${Date.now() - started} ms: ` +
        (error instanceof Error ? error.message : String(error)),
    );
    throw error;
  }
}

async function bootstrap(): Promise<void> {
  const resolution = resolveDataPaths({
    localAppDataDir: localAppDataDirectory(),
    installDir: app.getAppPath(),
    platform: process.platform,
  });
  paths = resolution.paths;

  logger = new Logger({
    logsDir: paths.logsDir,
    minLevel: isDevelopment ? 'debug' : 'info',
    homeDirectory: homedir(),
    mirrorToConsole: isDevelopment,
  });
  logger.log('info', `${BRANDING.productName} ${app.getVersion()} starting`);
  for (const warning of resolution.warnings) {
    logger.log('warn', `data path warning (${warning.code}): ${warning.detail}`);
  }

  const { rendererUrl, rendererFile } = resolveRendererEntry({
    isDevelopment,
    devServerUrl: process.env.ELECTRON_RENDERER_URL,
    appPath: app.getAppPath(),
  });

  windows = new WindowManager({
    isDevelopment,
    preloadPath: join(app.getAppPath(), 'out', 'preload', 'index.js'),
    rendererUrl,
    rendererFile,
    iconPath: app.isPackaged ? join(process.resourcesPath, 'icons', 'icon.ico') : null,
    tileOrigins: TILE_ORIGINS,
    updateOrigins: UPDATE_ORIGINS,
    externalOrigins: EXTERNAL_LINK_ORIGINS,
    logger,
    onFirstHide: () => {
      // One unobtrusive explanation, the first time only.
      void dialog.showMessageBox({
        type: 'info',
        title: 'ChargeWatch is still collecting',
        message: 'ChargeWatch is still running in the system tray.',
        detail:
          'Closing the window keeps collection going. To stop it, right-click the ChargeWatch tray icon and choose Quit.',
        buttons: ['Got it'],
      });
    },
    onHidden: () => {
      void updates?.onWindowHidden();
    },
    onShown: () => undefined,
  });

  windows.configureSession();

  router = new IpcRouter({
    appOrigins: windows.appOrigins(),
    knownWindowIds: () => windows.knownWindowIds(),
    log: logger.bind(),
  });

  tray = new TrayController({
    iconPath: app.isPackaged ? join(process.resourcesPath, 'icons', 'icon.ico') : null,
    logger,
    onOpen: () => windows.activate(),
    onTogglePause: () => {
      const running =
        collectionStatus?.kind !== 'paused' && collectionStatus?.kind !== 'not_started';
      // The tray is part of the main process, not a renderer, so it calls the
      // services directly rather than round-tripping through the IPC router —
      // which would (correctly) reject it as an untrusted sender.
      void (async () => {
        await db('updateSettings', {
          entries: { 'collection.running': !running, 'collection.userPaused': running },
        }).catch(() => undefined);
        settingsCache = await db<Record<string, unknown>>('getSettings').catch(() => settingsCache);
        await collector(running ? 'pause' : 'start', { reason: 'user_paused' }, 60_000).catch(
          () => undefined,
        );
        await refreshCollectionStatus().catch(() => undefined);
      })();
    },
    onCheckForUpdates: () => {
      void updates?.check({ manual: true });
    },
    onQuit: () => {
      void gracefulQuit();
    },
  });

  // A single IPC channel, routed through the validated registry.
  ipcMain.handle(IPC_CHANNEL_REQUEST, async (event, raw: unknown) =>
    router.handle(raw, {
      url: event.senderFrame?.url ?? '',
      windowId: BrowserWindow.fromWebContents(event.sender)?.id ?? null,
      isMainFrame: event.senderFrame?.parent === null,
    }),
  );
  ipcMain.handle(`${IPC_CHANNEL_REQUEST}:cancel`, (_event, requestId: unknown) =>
    typeof requestId === 'string' ? router.cancel(requestId) : false,
  );

  registerHandlers();

  // The tray is created BEFORE the subsystems, not after them.
  //
  // Everything below this line can legitimately take minutes on a first run:
  // opening the history file allows 180 seconds, starting the collector 120,
  // and resuming collection another 60. Until this moved, none of the tray,
  // the window or any log line appeared until all of it had finished, so a
  // slow or stuck stage presented as an application that started and then did
  // nothing at all. A tray icon is the cheapest possible way to say "this is
  // running", and it needs neither the database nor the browser.
  tray.create();

  await stage('opening the history file', startDatabase);

  if (databaseState?.status === 'ready') {
    await stage('starting the collector', startCollector);
    await stage('running health checks', runHealthChecks);

    // Resume collection only if it was running before, and only if a source is
    // actually eligible. Otherwise the status line says so instead.
    if (setting('collection.running', false) && !setting('collection.userPaused', false)) {
      await stage('resuming collection', async () => {
        await collector('start', {}, 60_000).catch((error: unknown) => {
          logger.log(
            'warn',
            `collection could not resume: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      });
    }
    await refreshCollectionStatus().catch(() => undefined);
  }

  // `--hidden` is passed by the login item so a start-with-Windows launch does
  // not pop a window in the user's face.
  if (!process.argv.includes('--hidden')) {
    windows.create();
  }

  startUpdates();
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Graceful stop: stop scheduling, finish bounded browser work, flush accepted
 * batches, close the database, then quit. Update installation uses this same
 * path via `prepareForInstall`.
 */
async function gracefulQuit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  logger.log('info', 'shutting down');

  windows.prepareForQuit();
  updates?.dispose();

  try {
    await collectorWorker?.stop(25_000);
  } catch (error) {
    logger.log('warn', `the collector did not stop cleanly: ${String(error)}`);
  }
  try {
    await databaseWorker?.stop(20_000);
  } catch (error) {
    logger.log('warn', `the database worker did not stop cleanly: ${String(error)}`);
  }

  tray.destroy();
  logger.close();
  app.quit();
}

// ---------------------------------------------------------------------------
// App events
// ---------------------------------------------------------------------------

app.on('second-instance', () => {
  windows?.activate();
});

app.whenReady().then(
  () => {
    if (selfCheckRequested) {
      void runSelfCheck().catch((error: unknown) => {
        // A crash in the check is a failure of the check, not a pass.

        console.error(
          `self-check crashed: ${error instanceof Error ? error.message : String(error)}`,
        );
        app.exit(1);
      });
      return;
    }
    void bootstrap().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger?.log('error', `startup failed: ${message}`);
      void dialog.showMessageBox({
        type: 'error',
        title: 'ChargeWatch could not start',
        message: 'ChargeWatch ran into a problem while starting.',
        detail: `${message}\n\nYour data has not been changed.`,
      });
    });
  },
  () => undefined,
);

// Closing the last window does not quit: the tray keeps collecting.
app.on('window-all-closed', () => {
  // Deliberately empty on every platform. Quit is a tray action.
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  void gracefulQuit();
});

// Respect a Windows shutdown or sign-out: never start an installer then.
// Electron's types declare 'shutdown' for Linux and macOS only, but a Windows
// session end must not be ignored: it is the one moment an update installer
// must never start. Subscribed through a widened handle rather than dropped,
// with the reason recorded here so it does not look like a stray cast.
(
  powerMonitor as unknown as {
    on(event: 'shutdown', listener: (event?: { preventDefault: () => void }) => void): void;
  }
).on('shutdown', (event?: { preventDefault: () => void }) => {
  sessionEnding = true;
  logger?.log('info', 'the OS is ending the session');
  event?.preventDefault?.();
  void gracefulQuit();
});

powerMonitor.on('suspend', () => {
  logger?.log('info', 'the computer is going to sleep');
  void collector('suspend', {}, 15_000).catch(() => undefined);
});

powerMonitor.on('resume', () => {
  logger?.log('info', 'the computer woke up');
  void collector('resume', {}, 30_000)
    .then(() => refreshCollectionStatus())
    .catch(() => undefined);
});

// A blank uncaught error must not leave the user with a silent, dead app.
process.on('uncaughtException', (error) => {
  logger?.log('error', `uncaught exception in main: ${error.message}`);
});
process.on('unhandledRejection', (reason) => {
  logger?.log('error', `unhandled rejection in main: ${String(reason)}`);
});
