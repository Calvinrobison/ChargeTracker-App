/**
 * The left station rail, expanded (302px) and collapsed (62px).
 *
 * Collapse policy comes from `collapseMode`: `auto` collapses the instant a
 * station is selected and the chevron's manual choice wins until the next
 * selection; `manual` stays expanded until collapsed; `wide` never collapses.
 */

import { useMemo, type ReactNode } from 'react';

import type { SourceHealthView, StallRange, StationView } from '../../../shared/ipc.ts';
import { isRailExpanded, useUi } from '../state.tsx';
import {
  bandColor,
  coverageAndAge,
  currentStatusText,
  initialsOf,
  occupancyBandOf,
  pct,
  stateBadge,
  statusDotColor,
  statusDotLabel,
} from '../format.ts';
import { CollapseIcon, ExpandIcon, SearchIcon, WarningIcon } from './Icons.tsx';
import { WarningBanner, needsWarning } from './WarningBanner.tsx';
import { StallRangeFilter } from './StallRangeFilter.tsx';
import { describeRange, isOpenRange, normalizeRange } from '../../../domain/stalls.ts';

/**
 * Why the list is empty, in the words of whatever actually emptied it.
 *
 * A generic "try widening your filters" is a small dishonesty when the
 * application knows the answer. The availability filter is singled out because
 * it is the one that can return nothing for a reason that is not about the
 * range at all — nothing is monitored, so nothing can answer it, and no amount
 * of widening will change that.
 */
function emptyStateReason(
  filters: { readonly stalls: StallRange; readonly freeStalls: StallRange },
  monitoredCount: number,
): string {
  const free = normalizeRange(filters.freeStalls);
  if (!isOpenRange(free)) {
    if (monitoredCount === 0) {
      return 'Nothing is monitored yet, so no location can report how many stalls are free. Turn on monitoring for a location, or clear that filter.';
    }
    return `Only monitored locations that have been read can answer "${String(
      describeRange(free, 'free'),
    )}". A location nobody has read is left out rather than counted as none free.`;
  }

  const stalls = normalizeRange(filters.stalls);
  if (!isOpenRange(stalls)) {
    return `No location in range matches ${String(describeRange(stalls))}. Locations whose stall count is unknown are excluded rather than assumed.`;
  }

  return 'Try including Level 2 chargers or catalog-only locations.';
}

export interface StationRailProps {
  readonly stations: readonly StationView[];
  readonly monitoredCount: number;
  readonly totalCount: number;
  readonly sources: readonly SourceHealthView[];
  readonly onOpenSourceDetails: () => void;
  readonly onRetrySource: () => void;
  readonly retrying: boolean;
}

function StationRow({
  station,
  selected,
  onSelect,
}: {
  readonly station: StationView;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  const band = occupancyBandOf(station.occupancy);
  const badge = stateBadge(station);
  const trailing = coverageAndAge(station);

  return (
    <button
      type="button"
      className={
        station.capacityDisagrees ? 'station-row station-row--capacity-conflict' : 'station-row'
      }
      aria-selected={selected}
      role="option"
      onClick={onSelect}
    >
      <span className="station-row-top">
        <span className="station-row-identity">
          <span className="station-row-name-line">
            <span
              className="dot"
              style={{ background: statusDotColor(station) }}
              aria-hidden="true"
            />
            <span className="station-row-name">{station.name}</span>
          </span>
          <span className="station-row-meta">
            {[station.network, station.type].filter(Boolean).join(' · ') || 'Network unknown'}
          </span>
        </span>
        <span className="station-row-current">{currentStatusText(station)}</span>
      </span>

      <span className="station-row-bottom">
        <span className="occupancy-bar" aria-hidden="true">
          <span
            className="occupancy-bar-fill"
            style={{
              width: station.occupancy === null ? '0%' : `${Math.min(100, station.occupancy)}%`,
              background: bandColor(band),
            }}
          />
        </span>
        <span className="occupancy-value" style={{ color: bandColor(band) }}>
          {/* Null renders as an em dash, never as 0%. */}
          {pct(station.occupancy)}
        </span>
        {badge ? <span className="state-badge">{badge}</span> : null}
        {/*
          The source and the catalog disagree about how many stalls this
          location has. The filter uses the source figure, so the row could
          otherwise appear in a result set that contradicts the catalog number
          shown elsewhere with nothing to explain it. Marked rather than
          reconciled: colour alone is never the signal, so the count is stated
          too.
        */}
        {station.capacityDisagrees ? (
          <span
            className="state-badge state-badge--capacity-conflict"
            title={`The source reports ${String(station.stalls)} stalls; the catalog lists ${String(
              station.catalogPorts,
            )}. Filtering uses the source figure.`}
          >
            {`Stalls disputed · ${String(station.stalls)} vs ${String(station.catalogPorts)}`}
          </span>
        ) : null}
        <span className="spacer" />
        <span className="station-row-trailing">{trailing}</span>
      </span>

      {/* The dot's meaning in words, for screen readers and for anyone who
          cannot distinguish the colours. */}
      <span className="visually-hidden">{statusDotLabel(station)}</span>
    </button>
  );
}

function RailAvatar({
  station,
  selected,
  onSelect,
}: {
  readonly station: StationView;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  const band = occupancyBandOf(station.occupancy);
  const ring = station.occupancy === null ? 'var(--ring-null)' : bandColor(band);

  return (
    <button
      type="button"
      className="rail-avatar"
      aria-selected={selected}
      role="option"
      onClick={onSelect}
      style={{ background: selected ? 'var(--accent-selected)' : ring }}
      title={`${station.name} · ${station.occupancy === null ? 'no occupancy figure' : `${Math.round(station.occupancy)}% occupancy`}`}
    >
      <span className="rail-avatar-inner">{initialsOf(station.name)}</span>
    </button>
  );
}

export function StationRail({
  stations,
  monitoredCount,
  totalCount,
  sources,
  onOpenSourceDetails,
  onRetrySource,
  retrying,
}: StationRailProps): ReactNode {
  const { state, dispatch } = useUi();
  const expanded = isRailExpanded(state);

  const warningSource = useMemo(() => sources.find(needsWarning) ?? null, [sources]);
  const showBanner = warningSource !== null && !state.warnDismissed;

  if (!expanded) {
    return (
      <aside className="rail rail--collapsed" aria-label="Stations">
        <button
          type="button"
          className="icon-button"
          aria-label="Expand the station list"
          title="Expand the station list"
          onClick={() => dispatch({ type: 'setRailOverride', open: true })}
        >
          <ExpandIcon size={16} />
        </button>
        <span className="rail-divider" aria-hidden="true" />
        {warningSource ? (
          <span
            className="rail-warning-tile"
            title={`${warningSource.displayName} collection paused`}
            role="img"
            aria-label={`${warningSource.displayName} collection paused`}
          >
            <WarningIcon size={15} />
          </span>
        ) : null}
        <div className="rail-avatars" role="listbox" aria-label="Stations">
          {stations.map((station) => (
            <RailAvatar
              key={station.id}
              station={station}
              selected={station.id === state.selectedId}
              onSelect={() => dispatch({ type: 'selectStation', id: station.id })}
            />
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="rail" aria-label="Stations">
      <div className="rail-header">
        <div className="search-row">
          <label className="search-field">
            <SearchIcon size={14} />
            <input
              type="search"
              value={state.filters.query}
              placeholder="Search station, address or network"
              aria-label="Search stations"
              onChange={(event) => dispatch({ type: 'setQuery', query: event.target.value })}
            />
          </label>
          <button
            type="button"
            className="icon-button"
            aria-label="Collapse the station list"
            title="Collapse the station list"
            onClick={() => dispatch({ type: 'setRailOverride', open: false })}
          >
            <CollapseIcon size={16} />
          </button>
        </div>

        <div className="filter-chips">
          <FilterChip
            label="Status"
            active={state.filters.monitoringStates.length > 0}
            onClick={() =>
              dispatch({
                type: 'setMonitoringStates',
                states: state.filters.monitoringStates.length > 0 ? [] : ['monitored'],
              })
            }
          />
          <FilterChip
            label="Monitoring"
            active={state.filters.monitoringStates.includes('provisional')}
            onClick={() =>
              dispatch({
                type: 'setMonitoringStates',
                states: state.filters.monitoringStates.includes('provisional')
                  ? []
                  : ['monitored', 'provisional', 'stale'],
              })
            }
          />
          <FilterChip
            label={
              state.filters.cohort === 'level_2'
                ? 'Level 2'
                : state.filters.cohort === 'dc_fast'
                  ? 'DC Fast'
                  : 'All charging'
            }
            active={state.filters.cohort !== 'dc_fast'}
            onClick={() =>
              dispatch({
                type: 'setCohort',
                cohort:
                  state.filters.cohort === 'dc_fast'
                    ? 'level_2'
                    : state.filters.cohort === 'level_2'
                      ? 'combined'
                      : 'dc_fast',
              })
            }
          />
          <button
            type="button"
            className="chip"
            aria-pressed={state.filters.savedOnly}
            onClick={() => dispatch({ type: 'toggleSavedOnly' })}
          >
            Saved
          </button>
          <button
            type="button"
            className="chip chip--fill"
            onClick={() => dispatch({ type: 'setSettingsOpen', open: true })}
          >
            More filters
          </button>
        </div>

        <StallRangeFilter
          stalls={state.filters.stalls}
          freeStalls={state.filters.freeStalls}
          onStallsChange={(range) => dispatch({ type: 'setStallRange', range })}
          onFreeStallsChange={(range) => dispatch({ type: 'setFreeStallRange', range })}
          monitoredCount={monitoredCount}
        />
      </div>

      {showBanner && warningSource ? (
        <WarningBanner
          source={warningSource}
          variant="rail"
          onRetry={onRetrySource}
          onViewDetails={onOpenSourceDetails}
          onDismiss={() => dispatch({ type: 'dismissWarning' })}
          retrying={retrying}
        />
      ) : null}

      <div className="rail-list-header">
        <span className="rail-count">
          {stations.length} of {totalCount} locations · {monitoredCount} monitored
        </span>
        <button
          type="button"
          className="chip sort-chip"
          onClick={() =>
            dispatch({
              type: 'setSort',
              sort: state.sort === 'occupancy' ? 'occupied_hours' : 'occupancy',
            })
          }
        >
          {state.sort === 'occupancy' ? 'Occupancy' : 'Occupied hours'}
        </button>
      </div>

      {stations.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-title">No stations match these filters</span>
          <span className="empty-state-body">
            {emptyStateReason(state.filters, monitoredCount)}
          </span>
          <button
            type="button"
            className="chip"
            style={{ height: 28 }}
            onClick={() => dispatch({ type: 'clearFilters' })}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="station-list" role="listbox" aria-label="Stations">
          {stations.map((station) => (
            <StationRow
              key={station.id}
              station={station}
              selected={station.id === state.selectedId}
              onSelect={() => dispatch({ type: 'selectStation', id: station.id })}
            />
          ))}
        </div>
      )}
    </aside>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <button type="button" className="chip" aria-pressed={active} onClick={onClick}>
      {label}
    </button>
  );
}
