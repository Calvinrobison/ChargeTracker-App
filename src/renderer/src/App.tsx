/**
 * The application shell.
 *
 * Owns data loading and the one place errors become user-visible text. Every
 * call goes through the preload bridge; a failure shows the friendly message
 * the contract supplies rather than a stack trace.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import type {
  BootstrapView,
  CollectionStatusView,
  ResponseOf,
  SourceHealthView,
  StationDetailView,
} from '../../shared/ipc.ts';
import { invoke, subscribe, toApiError } from './api.ts';
import { UiProvider, useUi, windowRequestOf } from './state.tsx';
import { MapWorkspace } from './components/MapWorkspace.tsx';
import { Onboarding } from './components/Onboarding.tsx';
import { OverviewWorkspace } from './components/OverviewWorkspace.tsx';
import { SettingsDrawer } from './components/SettingsDrawer.tsx';
import { TopBar } from './components/TopBar.tsx';

type OverviewData = ResponseOf<'overview.get'>;
type MapData = ResponseOf<'map.getMarkers'>;
type UpdateData = ResponseOf<'update.getState'>;

interface Toast {
  readonly id: number;
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
}

function AppInner(): ReactNode {
  const { state, dispatch } = useUi();

  const [bootstrap, setBootstrap] = useState<BootstrapView | null>(null);
  const [status, setStatus] = useState<CollectionStatusView | null>(null);
  const [sources, setSources] = useState<readonly SourceHealthView[]>([]);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [detail, setDetail] = useState<StationDetailView | null>(null);
  const [updateState, setUpdateState] = useState<UpdateData | null>(null);
  const [backups, setBackups] = useState<ResponseOf<'backup.list'>['backups']>([]);
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [lastRefreshedMs, setLastRefreshedMs] = useState<number | null>(null);
  const toastId = useRef(0);

  const notify = useCallback((level: Toast['level'], message: string) => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((current) => [...current, { id, level, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 9000);
  }, []);

  const report = useCallback(
    (error: unknown, context: string) => {
      const api = toApiError(error);
      notify('error', `${context}: ${api.message}`);
    },
    [notify],
  );

  // Bootstrap once.
  const loadBootstrap = useCallback(async () => {
    try {
      const next = await invoke('app.getBootstrap', {});
      setBootstrap(next);
      setStatus(next.collection);
      setSources(next.sources);
    } catch (error) {
      const api = toApiError(error);
      setFatal(api.message);
    }
  }, []);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  // Live events.
  useEffect(() => {
    const unsubscribers = [
      subscribe('collection.status', (payload) => setStatus(payload)),
      subscribe('source.health', (payload) => setSources(payload.sources)),
      subscribe('update.state', (payload) => setUpdateState(payload)),
      subscribe('data.changed', () => setLastRefreshedMs(null)),
      subscribe('toast', (payload) => notify(payload.level, payload.message)),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [notify]);

  const windowRequest = windowRequestOf(state);
  const filtersKey = JSON.stringify({
    window: windowRequest,
    filters: state.filters,
    sort: state.sort,
    metric: state.metric,
    tab: state.tab,
    refreshed: lastRefreshedMs,
  });

  // Load the active workspace's data whenever the shared inputs change.
  useEffect(() => {
    if (!bootstrap?.onboardingComplete) return;
    let cancelled = false;

    void (async () => {
      try {
        if (state.tab === 'overview') {
          const next = await invoke('overview.get', {
            window: windowRequest,
            filters: state.filters,
            sort: state.sort,
          });
          if (!cancelled) setOverview(next);
        } else {
          const next = await invoke('map.getMarkers', {
            window: windowRequest,
            filters: state.filters,
            sort: state.sort,
            metric: state.metric,
          });
          if (!cancelled) setMapData(next);
        }
        if (!cancelled) setLastRefreshedMs(Date.now());
      } catch (error) {
        if (!cancelled) report(error, 'Could not load the latest figures');
      }
    })();

    return () => {
      cancelled = true;
    };
    // filtersKey is the serialised set of inputs that affect the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey, bootstrap?.onboardingComplete]);

  // Load the selected station's detail.
  useEffect(() => {
    if (state.selectedId === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const next = await invoke('station.getDetail', {
          siteId: state.selectedId as string,
          window: windowRequest,
        });
        if (!cancelled) setDetail(next);
      } catch (error) {
        if (!cancelled) report(error, 'Could not load that location');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selectedId, filtersKey]);

  // Settings data is only needed while the drawer is open.
  //
  // The bootstrap payload is reloaded here too, and that is not a refinement.
  // `loadBootstrap` otherwise runs once on mount, and the drawer renders
  // `bootstrap.counts.observations` as "Observations stored" — so a session
  // that started with an empty database kept reporting **0 while it was
  // actively recording observations**. Confirmed on 2026-09-21: the station
  // drawer read "Latest observation 1 min ago" with real port counts, the
  // exported CSV contained the row, and Settings still said 0.
  //
  // A number that reads 0 when the true value is not 0 is the failure this
  // application exists to avoid, and it was on the one figure anyone checks to
  // decide whether collection is working.
  useEffect(() => {
    if (!state.settingsOpen) return;
    void (async () => {
      try {
        const [update, backupList] = await Promise.all([
          invoke('update.getState', {}),
          invoke('backup.list', {}),
        ]);
        setUpdateState(update);
        setBackups(backupList.backups);
      } catch (error) {
        report(error, 'Could not load settings');
      }
    })();
    void loadBootstrap();
  }, [state.settingsOpen, report, loadBootstrap]);

  // ---------------------------------------------------------------- actions

  const setSetting = useCallback(
    async (key: string, value: unknown) => {
      try {
        if (key === 'collection.running') {
          const next = await invoke('collection.setRunning', { running: value === true });
          setStatus(next);
        } else {
          await invoke('settings.update', { entries: { [key]: value } });
        }
        await loadBootstrap();
      } catch (error) {
        report(error, 'Could not save that setting');
      }
    },
    [loadBootstrap, report],
  );

  const toggleSaved = useCallback(
    async (siteId: string, saved: boolean) => {
      try {
        await invoke('station.setSaved', { siteId, saved });
        setDetail((current) =>
          current && current.station.id === siteId
            ? { ...current, station: { ...current.station, saved } }
            : current,
        );
        setLastRefreshedMs(null);
      } catch (error) {
        report(error, 'Could not save that location');
      }
    },
    [report],
  );

  const openSource = useCallback(
    async (siteId: string) => {
      const sourceId = detail?.source.sourceId;
      if (!sourceId) {
        notify('warn', 'That location has no source link to open.');
        return;
      }
      try {
        await invoke('source.openWindow', { sourceId, siteId });
        notify('info', 'Opening the source page in ChargeWatch’s own browser window.');
      } catch (error) {
        report(error, 'Could not open the source page');
      }
    },
    [detail?.source.sourceId, notify, report],
  );

  const retrySource = useCallback(async () => {
    setRetrying(true);
    try {
      const result = await invoke('collection.refreshNow', { siteIds: [] });
      notify(
        'info',
        result.budgetNote ??
          `Queued ${result.queued} location${result.queued === 1 ? '' : 's'} for a fresh reading.`,
      );
    } catch (error) {
      report(error, 'Could not retry the source');
    } finally {
      setRetrying(false);
    }
  }, [notify, report]);

  const runWithBusy = useCallback(
    async (label: string, action: () => Promise<string | null>) => {
      setBusy(label);
      try {
        const message = await action();
        if (message) notify('info', message);
      } catch (error) {
        report(error, label);
      } finally {
        setBusy(null);
      }
    },
    [notify, report],
  );

  /** Reloads the selected station's detail after a change that affects it. */
  const reloadDetail = useCallback(async () => {
    if (state.selectedId === null) return;
    const next = await invoke('station.getDetail', {
      siteId: state.selectedId,
      window: windowRequest,
    });
    setDetail(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selectedId, filtersKey]);

  const setMonitored = useCallback(
    (siteId: string, enabled: boolean) =>
      runWithBusy(enabled ? 'Monitor this location' : 'Stop monitoring', async () => {
        const result = await invoke('sites.setMonitored', { siteIds: [siteId], enabled });
        if (result.refusedCount > 0) {
          throw new Error(result.refusals[0] ?? 'this location cannot be monitored');
        }
        await reloadDetail();
        await loadBootstrap();
        setLastRefreshedMs(null);
        return enabled
          ? 'Monitoring on. The first reading is due now and will show here once it lands.'
          : 'Monitoring off. History is kept, and the gap is recorded.';
      }),
    [loadBootstrap, reloadDetail, runWithBusy],
  );

  const addLink = useCallback(
    (siteId: string, url: string) =>
      runWithBusy('Link station page', async () => {
        const result = await invoke('sites.addManualLink', { siteId, url });
        if (!result.ok) throw new Error(result.detail ?? result.code);
        await reloadDetail();
        return result.detail;
      }),
    [reloadDetail, runWithBusy],
  );

  const discoverStations = useCallback(
    (sourceId: string) =>
      runWithBusy('Find ChargePoint stations', async () => {
        const result = await invoke('sources.discover', { sourceId });
        await loadBootstrap();
        await reloadDetail().catch(() => undefined);
        setLastRefreshedMs(null);
        const parts = [
          `Found ${result.found} station${result.found === 1 ? '' : 's'}.`,
          `${result.linked} newly linked`,
          result.alreadyLinked > 0 ? `${result.alreadyLinked} already linked` : null,
          result.proposed > 0
            ? `${result.proposed} need a manual link (a near-namesake was found but not trusted)`
            : null,
          result.unmatched > 0 ? `${result.unmatched} are not in the catalog` : null,
          result.truncated ? 'the list was cut short' : null,
        ].filter(Boolean);
        return `${parts.join(' · ')}. New links start with monitoring off.`;
      }),
    [loadBootstrap, reloadDetail, runWithBusy],
  );

  const setMonitoredAll = useCallback(
    (enabled: boolean) =>
      runWithBusy(enabled ? 'Monitor all linked locations' : 'Stop monitoring all', async () => {
        const result = await invoke('sites.setMonitoredAll', { enabled });
        await loadBootstrap();
        await reloadDetail().catch(() => undefined);
        setLastRefreshedMs(null);
        const refused =
          result.refusedCount > 0 ? ` ${result.refusedCount} could not be changed.` : '';
        return enabled
          ? `Monitoring on for ${result.enabledCount} location${result.enabledCount === 1 ? '' : 's'}.${refused} Readings are spread out to respect the source's rate; the achievable interval is shown under Collection.`
          : `Monitoring off for ${result.enabledCount} location${result.enabledCount === 1 ? '' : 's'}.${refused}`;
      }),
    [loadBootstrap, reloadDetail, runWithBusy],
  );

  const exportCurrentView = useCallback(
    () =>
      runWithBusy('Export current view', async () => {
        const result = await invoke('export.currentView', {
          window: windowRequest,
          filters: state.filters,
          sort: state.sort,
          destinationPath: 'chargewatch-current-view.csv',
        });
        return result.written
          ? `Exported ${result.rowCount} row${result.rowCount === 1 ? '' : 's'}.`
          : null;
      }),
    [runWithBusy, state.filters, state.sort, windowRequest],
  );

  const exportRawObservations = useCallback(
    () =>
      runWithBusy('Export raw observations', async () => {
        const result = await invoke('export.rawObservations', {
          window: windowRequest,
          filters: state.filters,
          destinationPath: 'chargewatch-raw-observations.csv',
        });
        return result.written
          ? `Exported ${result.rowCount} observation${result.rowCount === 1 ? '' : 's'}.`
          : null;
      }),
    [runWithBusy, state.filters, windowRequest],
  );

  if (fatal !== null) {
    return (
      <div className="centered-screen">
        <div className="onboarding-card">
          <h1 className="onboarding-title">ChargeWatch could not start</h1>
          <p className="onboarding-lede">{fatal}</p>
          <p className="onboarding-lede" style={{ fontSize: 12.5 }}>
            Your history has not been changed. If this keeps happening, export diagnostics from the
            tray menu and check docs/TROUBLESHOOTING.md.
          </p>
          <button
            type="button"
            className="button-accent"
            style={{ height: 34 }}
            onClick={() => {
              setFatal(null);
              void loadBootstrap();
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!bootstrap) {
    return (
      <div className="centered-screen">
        <div className="onboarding-card skeleton" style={{ height: 220 }} aria-busy="true">
          <span className="visually-hidden">Loading ChargeWatch…</span>
        </div>
      </div>
    );
  }

  if (!bootstrap.onboardingComplete) {
    return (
      <>
        <Onboarding
          bootstrap={bootstrap}
          busy={busy !== null}
          onComplete={(input) =>
            void runWithBusy('Start collecting', async () => {
              const next = await invoke('onboarding.complete', input);
              setStatus(next);
              await loadBootstrap();
              return input.startCollecting ? 'Collection started.' : null;
            })
          }
          onOpenDataFolder={() => void invoke('shell.openDataFolder', {})}
        />
        <ToastStack toasts={toasts} />
      </>
    );
  }

  const stations = mapData?.stations ?? [];
  const summary = mapData?.summary ?? overview?.summary ?? null;

  return (
    <div className="app-shell">
      <TopBar bootstrap={bootstrap} status={status} lastRefreshedMs={lastRefreshedMs} />

      {state.tab === 'map' ? (
        <MapWorkspace
          bootstrap={bootstrap}
          stations={stations}
          monitoredCount={summary?.monitoredLocations ?? 0}
          totalCount={summary?.catalogLocations ?? stations.length}
          visitsMetricAvailable={mapData?.visitsMetricAvailable ?? false}
          sources={sources}
          detail={detail}
          onToggleSaved={(siteId, saved) => void toggleSaved(siteId, saved)}
          onOpenSource={(siteId) => void openSource(siteId)}
          onExportStation={() => void exportCurrentView()}
          onAddVisitCounts={() =>
            notify(
              'info',
              'Adding visit counts by hand is not wired up in this build yet. Use the CSV template from Settings.',
            )
          }
          onImportVisitCsv={() =>
            notify(
              'info',
              'Import visit counts from Settings → Data and backups, using the template.',
            )
          }
          onSetMonitored={(siteId, enabled) => void setMonitored(siteId, enabled)}
          onAddLink={(siteId, url) => void addLink(siteId, url)}
          busy={busy !== null}
          onOpenSourceDetails={() => dispatch({ type: 'setSettingsOpen', open: true })}
          onRetrySource={() => void retrySource()}
          retrying={retrying}
        />
      ) : overview ? (
        <OverviewWorkspace
          bootstrap={bootstrap}
          summary={overview.summary}
          ranked={overview.ranked}
          provisional={overview.provisional}
          excludedAmbiguous={overview.excludedAmbiguous}
          heatmap={overview.heatmap}
          trend={overview.trend}
          sources={sources}
          onOpenSourceDetails={() => dispatch({ type: 'setSettingsOpen', open: true })}
          onRetrySource={() => void retrySource()}
          retrying={retrying}
        />
      ) : (
        <div className="overview">
          <div className="overview-inner">
            <div className="skeleton" style={{ height: 120 }} aria-busy="true" />
          </div>
        </div>
      )}

      {state.settingsOpen ? (
        <SettingsDrawer
          bootstrap={bootstrap}
          sources={sources}
          updateState={updateState}
          backups={backups}
          busy={busy}
          onSetSetting={(key, value) => void setSetting(key, value)}
          onDiscoverStations={(sourceId) => void discoverStations(sourceId)}
          onSetMonitoredAll={(enabled) => void setMonitoredAll(enabled)}
          onExportCurrentView={() => void exportCurrentView()}
          onExportRawObservations={() => void exportRawObservations()}
          onBackupNow={() =>
            void runWithBusy('Back up now', async () => {
              const result = await invoke('backup.createNow', {});
              if (!result.ok) throw new Error(result.detail ?? 'the backup could not be created');
              setBackups((await invoke('backup.list', {})).backups);
              return `Backup created: ${result.fileName ?? 'done'}.`;
            })
          }
          onRestore={() =>
            notify(
              'info',
              'Restoring asks for the backup file, shows you what it contains, and only replaces your history after you confirm.',
            )
          }
          onExportDiagnostics={() =>
            void runWithBusy('Export diagnostics', async () => {
              const result = await invoke('diagnostics.export', {
                destinationPath: 'chargewatch-diagnostics.txt',
              });
              return result.written ? 'Diagnostics exported.' : null;
            })
          }
          onCheckForUpdates={() =>
            void runWithBusy('Check for updates', async () => {
              const result = await invoke('update.check', {});
              setUpdateState(await invoke('update.getState', {}));
              return result.detail;
            })
          }
          onRestartAndInstall={() =>
            void runWithBusy('Restart to update', async () => {
              const result = await invoke('update.restartAndInstall', { confirmed: true });
              return result.accepted ? 'Installing the update…' : result.detail;
            })
          }
          onOpenDataFolder={() => void invoke('shell.openDataFolder', {})}
          onDownloadVisitTemplate={() =>
            void runWithBusy('Visit count template', async () => {
              const template = await invoke('visits.getTemplate', {});
              // Copying to the clipboard keeps this inside the renderer's
              // sandbox: no file is written without a Save As dialog.
              await navigator.clipboard.writeText(template.csv);
              return 'The visit count template was copied to your clipboard. Paste it into a spreadsheet.';
            })
          }
          onImportVisitCsv={() =>
            notify(
              'info',
              'Choosing a visit CSV is not wired up in this build yet; the validation and preview behind it is implemented and tested.',
            )
          }
          onDeleteHistoryBefore={(beforeMs) =>
            void runWithBusy('Delete history', async () => {
              const result = await invoke('data.deleteRange', { beforeMs, confirmed: true });
              setLastRefreshedMs(null);
              return `Deleted ${result.deleted} observation${result.deleted === 1 ? '' : 's'}.`;
            })
          }
        />
      ) : null}

      <ToastStack toasts={toasts} />
    </div>
  );
}

function ToastStack({ toasts }: { readonly toasts: readonly Toast[] }): ReactNode {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div className={`toast toast--${toast.level}`} key={toast.id}>
          {toast.message}
        </div>
      ))}
    </div>
  );
}

export function App(): ReactNode {
  return (
    <UiProvider>
      <AppInner />
    </UiProvider>
  );
}
