/**
 * Settings: a drawer, never a third workspace tab.
 *
 * Groups follow the handoff: Area; Locations and sources; Collection; Data and
 * backups; Updates; About. Technical detail sits behind Advanced. Anything
 * destructive states exactly what will be removed before it happens.
 */

import { useState, type ReactNode } from 'react';

import type { BootstrapView, SourceHealthView } from '../../../shared/ipc.ts';
import type { ResponseOf } from '../../../shared/ipc.ts';
import { useUi } from '../state.tsx';
import { bytesText, durationText, relativeTime } from '../format.ts';
import { CloseIcon, DownloadIcon, FolderIcon, RefreshIcon } from './Icons.tsx';

export interface SettingsDrawerProps {
  readonly bootstrap: BootstrapView;
  readonly sources: readonly SourceHealthView[];
  readonly updateState: ResponseOf<'update.getState'> | null;
  readonly backups: ResponseOf<'backup.list'>['backups'];
  readonly busy: string | null;
  readonly onSetSetting: (key: string, value: unknown) => void;
  readonly onExportCurrentView: () => void;
  readonly onExportRawObservations: () => void;
  readonly onBackupNow: () => void;
  readonly onRestore: () => void;
  readonly onExportDiagnostics: () => void;
  readonly onCheckForUpdates: () => void;
  readonly onRestartAndInstall: () => void;
  readonly onOpenDataFolder: () => void;
  readonly onDownloadVisitTemplate: () => void;
  readonly onImportVisitCsv: () => void;
  readonly onDeleteHistoryBefore: (beforeMs: number) => void;
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: (next: boolean) => void;
}): ReactNode {
  return (
    <button
      type="button"
      className="toggle"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

export function SettingsDrawer(props: SettingsDrawerProps): ReactNode {
  const { dispatch } = useUi();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const bootstrap = props.bootstrap;

  const close = (): void => dispatch({ type: 'setSettingsOpen', open: false });

  return (
    <>
      <div className="settings-scrim" onClick={close} role="presentation" />
      <aside className="settings-drawer" aria-label="Settings">
        <header className="drawer-header">
          <div className="drawer-identity">
            <h2 className="drawer-title" style={{ fontSize: 16 }}>
              Settings
            </h2>
          </div>
          <button
            type="button"
            className="icon-button icon-button-sm"
            aria-label="Close settings"
            onClick={close}
          >
            <CloseIcon size={14} />
          </button>
        </header>

        <div style={{ overflowY: 'auto' }}>
          {/* Area */}
          <section className="settings-group">
            <div className="settings-group-title">Area</div>
            <div className="settings-row">
              <span>Study centre</span>
              <span>
                {bootstrap.studyArea.centerLatitude.toFixed(4)},{' '}
                {bootstrap.studyArea.centerLongitude.toFixed(4)}
              </span>
            </div>
            <div className="settings-row">
              <span>Radius</span>
              <span>{bootstrap.studyArea.radiusMiles} miles (straight line)</span>
            </div>
            <div className="settings-row">
              <span>Display timezone</span>
              <span>{bootstrap.studyArea.timeZone}</span>
            </div>
            <div className="settings-hint">
              Changing the radius updates which locations are in scope and proposes what to monitor.
              It never deletes history for locations outside the new radius.
            </div>
          </section>

          {/* Locations and sources */}
          <section className="settings-group">
            <div className="settings-group-title">Locations and sources</div>
            <div className="settings-row">
              <span>Catalog locations</span>
              <span>{new Intl.NumberFormat('en-US').format(bootstrap.counts.catalogSites)}</span>
            </div>
            <div className="settings-row">
              <span>Monitored locations</span>
              <span>{new Intl.NumberFormat('en-US').format(bootstrap.counts.monitoredScopes)}</span>
            </div>

            {props.sources.map((source) => (
              <div className="settings-row-stack" key={source.sourceId}>
                <div className="settings-row" style={{ padding: 0 }}>
                  <span>{source.displayName}</span>
                  <span
                    style={{
                      color:
                        source.eligibilityState === 'enabled' && source.state === 'healthy'
                          ? 'var(--status-available)'
                          : 'var(--status-warning)',
                    }}
                  >
                    {source.eligibilityState === 'enabled'
                      ? source.state.replace(/_/g, ' ')
                      : source.eligibilityState.replace(/_/g, ' ')}
                  </span>
                </div>
                {source.message ? <div className="settings-hint">{source.message}</div> : null}
                {source.userAction ? (
                  <div className="settings-hint" style={{ color: 'var(--status-warning)' }}>
                    {source.userAction}
                  </div>
                ) : null}
                <div className="settings-hint">
                  Verification: {source.verificationState.replace(/_/g, ' ')}
                  {source.retryAtMs === null
                    ? ''
                    : ` · next attempt ${relativeTime(source.retryAtMs)}`}
                </div>
              </div>
            ))}
          </section>

          {/* Collection */}
          <section className="settings-group">
            <div className="settings-group-title">Collection</div>
            <div className="settings-row">
              <span>Collecting</span>
              <Toggle
                checked={bootstrap.collection.kind !== 'paused' && bootstrap.collection.kind !== 'not_started'}
                label="Collecting"
                onChange={(next) => props.onSetSetting('collection.running', next)}
              />
            </div>
            <div className="settings-row">
              <span>Target interval</span>
              <span>{durationText(bootstrap.collection.targetIntervalMs)}</span>
            </div>
            {bootstrap.collection.effectiveIntervalMs !== null &&
            bootstrap.collection.effectiveIntervalMs > bootstrap.collection.targetIntervalMs ? (
              <>
                <div className="settings-row">
                  <span>Achievable interval</span>
                  <span style={{ color: 'var(--status-warning)' }}>
                    {durationText(bootstrap.collection.effectiveIntervalMs)}
                  </span>
                </div>
                <div className="settings-hint">
                  The source limits how quickly pages can be read, so this is the cadence actually
                  being achieved for the enabled set. The target is not being met and is not
                  reported as if it were.
                </div>
              </>
            ) : null}
            <div className="settings-row">
              <span>Start with Windows</span>
              <Toggle
                checked={bootstrap.startWithWindows}
                label="Start with Windows"
                onChange={(next) => props.onSetSetting('startup.startWithWindows', next)}
              />
            </div>
          </section>

          {/* Data and backups */}
          <section className="settings-group">
            <div className="settings-group-title">Data and backups</div>
            <div className="settings-row">
              <span>Observations stored</span>
              <span>{new Intl.NumberFormat('en-US').format(bootstrap.counts.observations)}</span>
            </div>
            <div className="settings-row">
              <span>Disk used</span>
              <span>{bytesText(bootstrap.diskUsageBytes)}</span>
            </div>
            <div className="settings-row-stack">
              <div className="settings-actions">
                <button
                  type="button"
                  className="button-secondary"
                  disabled={props.busy !== null}
                  onClick={props.onExportCurrentView}
                >
                  Export current view
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={props.busy !== null}
                  onClick={props.onExportRawObservations}
                >
                  Export raw observations
                </button>
              </div>
              <div className="settings-hint">
                Exports match the filters and period you are looking at, and record the metric
                version. A missing value is exported as an empty cell, never as a zero.
              </div>
            </div>

            <div className="settings-row-stack">
              <div className="settings-actions">
                <button
                  type="button"
                  className="button-secondary"
                  disabled={props.busy !== null}
                  onClick={props.onBackupNow}
                >
                  Back up now
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={props.busy !== null}
                  onClick={props.onRestore}
                >
                  Restore from backup
                </button>
                <button type="button" className="button-secondary" onClick={props.onOpenDataFolder}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <FolderIcon size={12} /> Open data folder
                  </span>
                </button>
              </div>
              <div className="settings-hint">
                {props.backups.length === 0
                  ? 'No backups yet. A verified daily backup is made when collection has changed data.'
                  : `${props.backups.length} backup${props.backups.length === 1 ? '' : 's'} · newest ${relativeTime(props.backups[0]?.createdAtMs ?? null)} (${bytesText(props.backups[0]?.byteSize ?? null)})`}
              </div>
              <div className="settings-hint">
                Backups on this disk protect you from mistakes and bad upgrades, not from disk
                failure. Use Export backup for a copy somewhere else.
              </div>
            </div>

            <div className="settings-row-stack">
              <div className="settings-actions">
                <button
                  type="button"
                  className="button-secondary"
                  onClick={props.onDownloadVisitTemplate}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <DownloadIcon size={12} /> Visit count template
                  </span>
                </button>
                <button type="button" className="button-secondary" onClick={props.onImportVisitCsv}>
                  Import visit counts
                </button>
              </div>
              <div className="settings-hint">
                Visit counts are only ever numbers you or a site owner supply. ChargeWatch has no
                source of property visitor counts.
              </div>
            </div>
          </section>

          {/* Updates */}
          <section className="settings-group">
            <div className="settings-group-title">Updates</div>
            <div className="settings-row">
              <span>Installed version</span>
              <span>{props.updateState?.installedVersion ?? bootstrap.appVersion}</span>
            </div>
            <div className="settings-row">
              <span>Status</span>
              <span>{(props.updateState?.state ?? 'idle').replace(/_/g, ' ')}</span>
            </div>
            {props.updateState?.detail ? (
              <div className="settings-hint">{props.updateState.detail}</div>
            ) : null}
            {props.updateState?.downloadedPercent !== null &&
            props.updateState?.downloadedPercent !== undefined ? (
              <div className="settings-row">
                <span>Downloaded</span>
                <span>{Math.round(props.updateState.downloadedPercent)}%</span>
              </div>
            ) : null}
            <div className="settings-row">
              <span>Check automatically</span>
              <Toggle
                checked={props.updateState?.autoCheckEnabled ?? true}
                label="Check for updates automatically"
                onChange={(next) => props.onSetSetting('updates.autoCheck', next)}
              />
            </div>
            <div className="settings-row">
              <span>Download automatically</span>
              <Toggle
                checked={props.updateState?.autoDownloadEnabled ?? true}
                label="Download updates automatically"
                onChange={(next) => props.onSetSetting('updates.autoDownload', next)}
              />
            </div>
            <div className="settings-row">
              <span>Install automatically when idle</span>
              <Toggle
                checked={props.updateState?.autoInstallEnabled ?? true}
                label="Install updates automatically when idle"
                onChange={(next) => props.onSetSetting('updates.autoInstall', next)}
              />
            </div>
            <div className="settings-actions" style={{ marginTop: 8 }}>
              <button type="button" className="button-secondary" onClick={props.onCheckForUpdates}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <RefreshIcon size={12} /> Check for updates
                </span>
              </button>
              {props.updateState?.state === 'ready' || props.updateState?.state === 'deferred' ? (
                <button type="button" className="button-accent" onClick={props.onRestartAndInstall}>
                  Restart to update
                </button>
              ) : null}
            </div>
            {props.updateState?.manualDownloadUrl ? (
              <div className="settings-hint" style={{ color: 'var(--status-warning)' }}>
                Updates have failed {props.updateState.consecutiveFailures} times. You can download
                the installer manually from the releases page.
              </div>
            ) : null}
            <div className="settings-hint">
              Every update must pass ChargeWatch&apos;s own signature check before it can be
              installed. That is separate from Windows code signing and does not remove SmartScreen
              prompts.
            </div>
          </section>

          {/* About and Advanced */}
          <section className="settings-group">
            <div className="settings-group-title">About</div>
            <div className="settings-row">
              <span>Data folder</span>
              <span style={{ textAlign: 'right', wordBreak: 'break-all', fontSize: 11 }}>
                {bootstrap.dataDirectory}
              </span>
            </div>
            <div className="settings-row">
              <span>History schema</span>
              <span>v{bootstrap.schemaVersion}</span>
            </div>
            <div className="settings-actions" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="button-secondary"
                onClick={props.onExportDiagnostics}
              >
                Export diagnostics
              </button>
            </div>
            <div className="settings-hint">
              Diagnostics are written to a file you choose. Access tokens, cookies and your home
              folder path are removed, and your history, browser profile and backups are never
              included.
            </div>

            <button
              type="button"
              className="link-button"
              style={{ marginTop: 12 }}
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              Advanced
            </button>

            {advancedOpen ? (
              <div className="settings-row-stack">
                <div className="settings-hint">
                  IPC contract v{bootstrap.contractVersion} · app {bootstrap.appVersion}
                </div>
                {!confirmDelete ? (
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete history older than 1 year
                  </button>
                ) : (
                  <>
                    <div className="settings-hint" style={{ color: 'var(--status-critical)' }}>
                      This permanently deletes every observation recorded more than 365 days ago,
                      along with the aggregates derived from them. Locations, settings and newer
                      observations are kept. Back up first if you might want this data again.
                    </div>
                    <div className="settings-actions">
                      <button
                        type="button"
                        className="button-warning"
                        onClick={() => {
                          props.onDeleteHistoryBefore(Date.now() - 365 * 86_400_000);
                          setConfirmDelete(false);
                        }}
                      >
                        Delete it
                      </button>
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => setConfirmDelete(false)}
                      >
                        Keep it
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </section>
        </div>
      </aside>
    </>
  );
}
