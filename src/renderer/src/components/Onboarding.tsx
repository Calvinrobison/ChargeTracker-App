/**
 * Onboarding: one short screen.
 *
 * It states the Mesa defaults, the REAL supported and catalog counts, one
 * plain sentence about when observations accumulate, the start-with-Windows
 * toggle, and a Start collecting button. The health checks appear with their
 * precise recovery actions, so a failure is actionable rather than mysterious.
 */

import { useState, type ReactNode } from 'react';

import type { BootstrapView } from '../../../shared/ipc.ts';
import { ChargerIcon } from './Icons.tsx';

export interface OnboardingProps {
  readonly bootstrap: BootstrapView;
  readonly busy: boolean;
  readonly onComplete: (input: { startWithWindows: boolean; startCollecting: boolean }) => void;
  readonly onOpenDataFolder: () => void;
}

const STATUS_LABELS: Record<BootstrapView['healthChecks'][number]['status'], string> = {
  pass: 'Ready',
  fail: 'Needs attention',
  warn: 'Warning',
  not_applicable: 'Not checked',
};

export function Onboarding({
  bootstrap,
  busy,
  onComplete,
  onOpenDataFolder,
}: OnboardingProps): ReactNode {
  const [startWithWindows, setStartWithWindows] = useState(bootstrap.startWithWindows);

  const enabledSources = bootstrap.sources.filter(
    (source) => source.eligibilityState === 'enabled',
  );
  const canCollect = enabledSources.length > 0 && bootstrap.counts.catalogSites > 0;
  const blockingChecks = bootstrap.healthChecks.filter((check) => check.status === 'fail');

  return (
    <div className="centered-screen">
      <div className="onboarding-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="brand-tile" style={{ width: 32, height: 32 }}>
            <ChargerIcon size={17} />
          </span>
          <h1 className="onboarding-title">Monitor chargers around {bootstrap.studyArea.label}</h1>
        </div>

        <p className="onboarding-lede">
          ChargeWatch watches public charger status over time and keeps the history on this PC. It
          records what it actually observed, and shows the gaps rather than filling them in.
        </p>

        {/* Real counts, not aspirational ones. */}
        <div className="fact-rows">
          <div className="fact-row">
            <span className="fact-label">Study area</span>
            <span>
              {bootstrap.studyArea.radiusMiles} mile radius of {bootstrap.studyArea.label} (
              {bootstrap.studyArea.centerLatitude.toFixed(4)},{' '}
              {bootstrap.studyArea.centerLongitude.toFixed(4)})
            </span>
          </div>
          <div className="fact-row">
            <span className="fact-label">Catalog locations found</span>
            <span>{new Intl.NumberFormat('en-US').format(bootstrap.counts.catalogSites)}</span>
          </div>
          <div className="fact-row">
            <span className="fact-label">Locations that can be monitored</span>
            <span>
              {new Intl.NumberFormat('en-US').format(bootstrap.counts.monitoredScopes)}
              {enabledSources.length === 0 ? ' · no source is enabled yet' : ''}
            </span>
          </div>
          <div className="fact-row">
            <span className="fact-label">Times shown in</span>
            <span>{bootstrap.studyArea.timeZone}</span>
          </div>
        </div>

        <p className="onboarding-lede" style={{ fontSize: 12.5 }}>
          Observations accumulate while this computer is awake and ChargeWatch is running. Some
          networks do not publish usable status, and those locations appear in the catalog without
          history.
        </p>

        {/* Health checks, with recovery actions. */}
        <div className="health-list">
          {bootstrap.healthChecks.map((check) => (
            <div className="health-item" key={check.id}>
              <span className={`health-status health-status--${check.status}`}>
                {STATUS_LABELS[check.status]}
              </span>
              <span>
                <span>{check.label}</span>
                {check.detail ? <div className="health-detail">{check.detail}</div> : null}
                {check.recoveryAction ? (
                  <div className="health-recovery">{check.recoveryAction}</div>
                ) : null}
              </span>
            </div>
          ))}
        </div>

        <div className="toggle-row">
          <button
            type="button"
            className="toggle"
            role="switch"
            aria-checked={startWithWindows}
            aria-label="Start ChargeWatch with Windows"
            onClick={() => setStartWithWindows((value) => !value)}
          >
            <span className="toggle-knob" />
          </button>
          <span>
            <div>Start with Windows</div>
            <div className="settings-hint">
              Starts ChargeWatch in the tray when you sign in, so collection continues without you
              opening it.
            </div>
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="button-accent"
            style={{ height: 34, padding: '0 16px' }}
            disabled={busy || !canCollect}
            title={
              canCollect
                ? undefined
                : 'Collection cannot start until a station catalog is loaded and a source is enabled.'
            }
            onClick={() => onComplete({ startWithWindows, startCollecting: true })}
          >
            {busy ? 'Starting…' : 'Start collecting'}
          </button>
          <button
            type="button"
            className="button-secondary"
            style={{ height: 34 }}
            disabled={busy}
            onClick={() => onComplete({ startWithWindows, startCollecting: false })}
          >
            Look around first
          </button>
          <span className="spacer" />
          <button type="button" className="button-text" onClick={onOpenDataFolder}>
            Open data folder
          </button>
        </div>

        {!canCollect ? (
          <div className="chart-footnote" style={{ marginTop: 12 }}>
            {blockingChecks.length > 0
              ? `Collection is not possible yet: ${blockingChecks.map((check) => check.label.toLowerCase()).join('; ')}. You can still look around — nothing will be fabricated in the meantime.`
              : 'Collection is not possible yet. You can still look around; nothing will be fabricated in the meantime.'}
          </div>
        ) : null}

        <div className="chart-footnote" style={{ marginTop: 12 }}>
          History is stored at {bootstrap.dataDirectory}. Updating or reinstalling ChargeWatch does
          not delete it.
        </div>
      </div>
    </div>
  );
}
