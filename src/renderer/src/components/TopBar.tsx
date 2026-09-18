/**
 * The 58px top bar: brand, the two workspace tabs, date range, collection
 * state and the settings button.
 *
 * Settings is a drawer, never a third tab.
 */

import { useState, type ReactNode } from 'react';

import type { BootstrapView, CollectionStatusView } from '../../../shared/ipc.ts';
import { DATE_PRESET_LABELS, useUi } from '../state.tsx';
import { clockTime, durationText, relativeTime } from '../format.ts';
import { CalendarIcon, ChargerIcon, ChevronDownIcon, GearIcon } from './Icons.tsx';
import type { DatePreset } from '../../../domain/ranking.ts';

const PRESETS: readonly DatePreset[] = ['7d', '30d', '60d', 'all'];

function statusDotClass(kind: CollectionStatusView['kind']): string {
  switch (kind) {
    case 'collecting':
      return 'status-dot status-dot--collecting';
    case 'source_issue':
    case 'catching_up':
    case 'partial_coverage':
      return 'status-dot status-dot--warning';
    case 'offline':
      return 'status-dot status-dot--critical';
    default:
      return 'status-dot status-dot--paused';
  }
}

export interface TopBarProps {
  readonly bootstrap: BootstrapView;
  readonly status: CollectionStatusView | null;
  readonly lastRefreshedMs: number | null;
}

export function TopBar({ bootstrap, status, lastRefreshedMs }: TopBarProps): ReactNode {
  const { state, dispatch } = useUi();
  const [dateOpen, setDateOpen] = useState(false);
  const timeZone = bootstrap.studyArea.timeZone;

  /**
   * The second line is the honest cadence line: the last successful
   * observation and the next scheduled check. When the achievable cadence
   * differs from the target, it says so rather than repeating the target.
   */
  const detail = ((): string => {
    if (!status) return 'Starting up';
    const parts: string[] = [];
    parts.push(
      status.lastObservationMs === null
        ? 'No observations yet'
        : `Last observation ${clockTime(status.lastObservationMs, timeZone)}`,
    );
    if (status.nextCheckMs !== null && status.kind === 'collecting') {
      parts.push(`next check ~${clockTime(status.nextCheckMs, timeZone)}`);
    }
    if (
      status.effectiveIntervalMs !== null &&
      status.effectiveIntervalMs > status.targetIntervalMs
    ) {
      parts.push(
        `every ${durationText(status.effectiveIntervalMs)} (not ${durationText(status.targetIntervalMs)}: the source limits how fast we can read)`,
      );
    }
    return parts.join(' · ');
  })();

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-tile">
          <ChargerIcon size={14} />
        </span>
        <span className="brand-lines">
          <span className="brand-name">ChargeWatch</span>
          <span className="brand-place">{bootstrap.studyArea.label}</span>
        </span>
      </div>

      <div className="workspace-tabs" role="tablist" aria-label="Workspace">
        <button
          type="button"
          role="tab"
          className="workspace-tab"
          aria-selected={state.tab === 'overview'}
          onClick={() => dispatch({ type: 'setTab', tab: 'overview' })}
        >
          Overview
        </button>
        <button
          type="button"
          role="tab"
          className="workspace-tab"
          aria-selected={state.tab === 'map'}
          onClick={() => dispatch({ type: 'setTab', tab: 'map' })}
        >
          Map
        </button>
      </div>

      <div className="spacer" />

      <div style={{ position: 'relative' }}>
        <button
          type="button"
          className="control-button"
          aria-haspopup="listbox"
          aria-expanded={dateOpen}
          onClick={() => setDateOpen((open) => !open)}
        >
          <CalendarIcon size={14} />
          {DATE_PRESET_LABELS[state.datePreset]}
          <ChevronDownIcon size={10} />
        </button>
        {dateOpen ? (
          <div
            role="listbox"
            aria-label="Date range"
            className="map-chrome"
            style={{ position: 'absolute', top: 40, right: 0, padding: 4, minWidth: 200 }}
          >
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                role="option"
                aria-selected={state.datePreset === preset}
                className="metric-option"
                style={{ display: 'block', width: '100%', textAlign: 'left' }}
                onClick={() => {
                  dispatch({ type: 'setDatePreset', preset });
                  setDateOpen(false);
                }}
              >
                {DATE_PRESET_LABELS[preset]}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="collection-status">
        <span className="collection-status-line">
          <span className={statusDotClass(status?.kind ?? 'not_started')} aria-hidden="true" />
          {/* Colour is never the only signal: the label always carries the state. */}
          <span>{status?.label ?? 'Starting…'}</span>
        </span>
        <span className="collection-status-detail">{detail}</span>
      </div>

      <span className="updated-note">
        {lastRefreshedMs === null ? '' : `Updated ${relativeTime(lastRefreshedMs)}`}
      </span>

      <button
        type="button"
        className="icon-button topbar-settings"
        aria-label="Settings"
        title="Settings"
        onClick={() => dispatch({ type: 'setSettingsOpen', open: true })}
      >
        <GearIcon size={16} />
      </button>
    </header>
  );
}
