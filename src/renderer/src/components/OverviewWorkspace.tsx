/**
 * The Overview workspace.
 *
 * Cards adapt to what the sources actually support: no large empty card is
 * reserved for exact session counts that no source provides. Provisional and
 * stale rows stay visible and labelled below the ranking rather than being
 * mixed into it.
 */

import { type ReactNode } from 'react';

import type {
  BootstrapView,
  HeatmapCellView,
  SourceHealthView,
  StationView,
  SummaryView,
  TrendView,
} from '../../../shared/ipc.ts';
import { DATE_PRESET_LABELS, useUi } from '../state.tsx';
import {
  bandColor,
  count,
  hours as formatHours,
  occupancyBandOf,
  pct,
  relativeOrDash,
  stateBadge,
  statusDotColor,
  statusDotLabel,
} from '../format.ts';
import { Heatmap, HeatmapKey } from './Heatmap.tsx';
import { HistoryBuilding, TrendChart } from './TrendChart.tsx';
import { WarningBanner, needsWarning } from './WarningBanner.tsx';
import { SearchIcon } from './Icons.tsx';

export interface OverviewWorkspaceProps {
  readonly bootstrap: BootstrapView;
  readonly summary: SummaryView;
  readonly ranked: readonly StationView[];
  readonly provisional: readonly StationView[];
  readonly excludedAmbiguous: readonly StationView[];
  readonly heatmap: readonly HeatmapCellView[];
  readonly trend: TrendView;
  readonly sources: readonly SourceHealthView[];
  readonly onOpenSourceDetails: () => void;
  readonly onRetrySource: () => void;
  readonly retrying: boolean;
}

const RANKING_COLUMNS = [
  'Station',
  'Type',
  'Ports',
  'Occupancy',
  'Occupied hours',
  'Coverage',
  'Latest',
] as const;

export function OverviewWorkspace(props: OverviewWorkspaceProps): ReactNode {
  const { state, dispatch } = useUi();
  const summary = props.summary;
  const warningSource = props.sources.find(needsWarning) ?? null;

  const networks = [
    ...new Set(
      [...props.ranked, ...props.provisional, ...props.excludedAmbiguous]
        .map((station) => station.network)
        .filter((network): network is string => network !== null),
    ),
  ].sort();

  // Enough shape to be worth drawing: at least a few observed days.
  const hasUsefulHistory = props.trend.points.some((point) => point.hasData);

  return (
    <div className="overview">
      <div className="overview-inner">
        {/* Filter bar — the same global state the Map uses. */}
        <div className="overview-filters">
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

          <select
            className="control-button"
            aria-label="Charging type"
            value={state.filters.cohort}
            onChange={(event) =>
              dispatch({
                type: 'setCohort',
                cohort: event.target.value as typeof state.filters.cohort,
              })
            }
          >
            <option value="dc_fast">DC Fast</option>
            <option value="level_2">Level 2</option>
            <option value="combined">Combined (capacity weighted)</option>
          </select>

          <select
            className="control-button"
            aria-label="Network"
            value={state.filters.networks[0] ?? ''}
            onChange={(event) =>
              dispatch({
                type: 'setNetworks',
                networks: event.target.value === '' ? [] : [event.target.value],
              })
            }
          >
            <option value="">All networks</option>
            {networks.map((network) => (
              <option key={network} value={network}>
                {network}
              </option>
            ))}
          </select>

          <select
            className="control-button"
            aria-label="Monitoring state"
            value={state.filters.monitoringStates[0] ?? ''}
            onChange={(event) =>
              dispatch({
                type: 'setMonitoringStates',
                states:
                  event.target.value === ''
                    ? []
                    : [event.target.value as 'monitored' | 'provisional' | 'stale' | 'catalog'],
              })
            }
          >
            <option value="">All locations</option>
            <option value="monitored">Monitored</option>
            <option value="provisional">Provisional</option>
            <option value="stale">Stale source</option>
            <option value="catalog">Catalog only</option>
          </select>

          <span className="spacer" />
          <span className="filters-shared-note">Filters are shared with the Map workspace</span>
        </div>

        {/* Summary cards. */}
        <div className="summary-cards">
          <SummaryCard
            label="Monitored locations"
            metric={count(summary.monitoredLocations)}
            secondary={`of ${count(summary.catalogLocations)} catalog locations`}
          />
          <SummaryCard
            label="Observed occupancy"
            metric={pct(summary.observedOccupancyPct)}
            secondary={`${count(summary.comparableLocations)} comparable monitored location${summary.comparableLocations === 1 ? '' : 's'}`}
          />
          <SummaryCard
            label="Occupied port-hours"
            metric={formatHours(summary.occupiedPortHours)}
            secondary={`Estimated · ${DATE_PRESET_LABELS[state.datePreset].toLowerCase()}`}
          />
          <SummaryCard
            label="Coverage"
            metric={pct(summary.statusCoveragePct)}
            secondary={
              summary.clippedByStudyStart
                ? `${summary.requestedDays} days requested · ${summary.effectiveDays} collected`
                : `${summary.historyDays} day${summary.historyDays === 1 ? '' : 's'} collected`
            }
          />
        </div>

        {warningSource && !state.warnDismissed ? (
          <WarningBanner
            source={warningSource}
            variant="strip"
            onRetry={props.onRetrySource}
            onViewDetails={props.onOpenSourceDetails}
            onDismiss={() => dispatch({ type: 'dismissWarning' })}
            retrying={props.retrying}
          />
        ) : null}

        {/* Busiest monitored locations. */}
        <section className="panel">
          <div className="panel-title-row">
            <span className="panel-title">Busiest monitored locations</span>
            <span className="panel-subtitle">
              Sorted by{' '}
              {state.sort === 'occupancy' ? 'historical occupancy' : 'total occupied hours'} ·{' '}
              {DATE_PRESET_LABELS[state.datePreset].toLowerCase()}
            </span>
          </div>

          <div className="ranking-grid ranking-head">
            {RANKING_COLUMNS.map((column, index) => (
              <span
                key={column}
                className={`ranking-head-cell${index >= 2 ? ' numeric' : ''}`}
                role="columnheader"
              >
                {index >= 3 ? (
                  <button
                    type="button"
                    className="link-button"
                    style={{ textDecoration: 'none', font: 'inherit', color: 'inherit' }}
                    onClick={() =>
                      dispatch({
                        type: 'setSort',
                        sort: column === 'Occupied hours' ? 'occupied_hours' : 'occupancy',
                      })
                    }
                  >
                    {column}
                  </button>
                ) : (
                  column
                )}
              </span>
            ))}
          </div>

          {props.ranked.length === 0 ? (
            <div className="empty-state" style={{ margin: 16 }}>
              <span className="empty-state-title">No locations qualify for the ranking yet</span>
              <span className="empty-state-body">
                A location needs at least seven days of history and 90% known-state coverage in the
                selected period. Locations below that threshold are listed as provisional.
              </span>
            </div>
          ) : (
            props.ranked.map((station) => (
              <RankingRow
                key={station.id}
                station={station}
                onSelect={() => dispatch({ type: 'selectStationAndShowMap', id: station.id })}
              />
            ))
          )}

          {props.provisional.length > 0 ? (
            <>
              <div className="panel-title-row" style={{ paddingTop: 16 }}>
                <span className="panel-title" style={{ fontSize: 12.5 }}>
                  Provisional locations
                </span>
                <span className="panel-subtitle">
                  Shown but not ranked: not enough history or coverage in this period
                </span>
              </div>
              {props.provisional.map((station) => (
                <RankingRow
                  key={station.id}
                  station={station}
                  onSelect={() => dispatch({ type: 'selectStationAndShowMap', id: station.id })}
                />
              ))}
            </>
          ) : null}

          {props.excludedAmbiguous.length > 0 ? (
            <>
              <div className="panel-title-row" style={{ paddingTop: 16 }}>
                <span className="panel-title" style={{ fontSize: 12.5 }}>
                  Excluded from this comparison
                </span>
                <span className="panel-subtitle">
                  The source reports one total with no Level 2 / DC breakdown, so these cannot enter
                  a type-specific ranking
                </span>
              </div>
              {props.excludedAmbiguous.map((station) => (
                <RankingRow
                  key={station.id}
                  station={station}
                  onSelect={() => dispatch({ type: 'selectStationAndShowMap', id: station.id })}
                />
              ))}
            </>
          ) : null}

          <div className="chart-footnote" style={{ padding: '12px 16px 14px' }}>
            {summary.cohortDescription}
          </div>
        </section>

        {/* Bottom row. */}
        <div className="overview-bottom">
          <section className="panel panel-padded">
            <div className="section-eyebrow-row">
              <span className="panel-title">Charging activity by weekday and hour</span>
            </div>
            {hasUsefulHistory ? (
              <>
                <Heatmap cells={props.heatmap} columns={24} />
                <HeatmapKey />
                <div className="heatmap-footer">
                  Built from time-weighted observations in {props.bootstrap.studyArea.timeZone}.
                  Missing bins are shown as missing.
                </div>
              </>
            ) : (
              <HistoryBuilding
                observations={props.bootstrap.counts.observations}
                historyDays={summary.historyDays}
                nextCheckLabel={
                  props.bootstrap.collection.nextCheckMs === null
                    ? null
                    : new Date(props.bootstrap.collection.nextCheckMs).toLocaleTimeString()
                }
              />
            )}
          </section>

          <section className="panel panel-padded">
            <div className="section-eyebrow-row">
              <span className="panel-title">Occupancy trend</span>
            </div>
            {hasUsefulHistory ? (
              <TrendChart trend={props.trend} width={320} height={140} gridlines={3} />
            ) : (
              <div className="dashed-card">
                <div style={{ fontSize: 12.5 }}>Not enough history yet</div>
                <div className="small-metric-note">
                  A trend line appears once observations exist. ChargeWatch does not draw a
                  fabricated graph while history is building.
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  metric,
  secondary,
}: {
  readonly label: string;
  readonly metric: string;
  readonly secondary: string;
}): ReactNode {
  return (
    <div className="summary-card">
      <div className="summary-card-label">{label}</div>
      <div className="summary-card-metric">{metric}</div>
      <div className="summary-card-secondary">{secondary}</div>
    </div>
  );
}

function RankingRow({
  station,
  onSelect,
}: {
  readonly station: StationView;
  readonly onSelect: () => void;
}): ReactNode {
  const band = occupancyBandOf(station.occupancy);
  const badge = stateBadge(station);

  return (
    <button type="button" className="ranking-row ranking-grid" onClick={onSelect}>
      <span className="cell ellipsize" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          className="dot"
          style={{ background: statusDotColor(station) }}
          aria-hidden="true"
        />
        <span className="ellipsize">{station.name}</span>
        {badge ? <span className="state-badge">{badge}</span> : null}
        <span className="visually-hidden">{statusDotLabel(station)}</span>
      </span>
      <span className="cell ellipsize">{station.type ?? 'Unknown'}</span>
      <span className="cell numeric nowrap">{count(station.ports)}</span>
      <span
        className="cell numeric nowrap"
        style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}
      >
        <span className="occupancy-bar occupancy-bar--wide" aria-hidden="true">
          <span
            className="occupancy-bar-fill"
            style={{
              width: station.occupancy === null ? '0%' : `${Math.min(100, station.occupancy)}%`,
              background: bandColor(band),
            }}
          />
        </span>
        <span style={{ color: bandColor(band) }}>{pct(station.occupancy)}</span>
      </span>
      <span className="cell numeric nowrap">{formatHours(station.hours)}</span>
      <span className="cell numeric nowrap">{pct(station.coverage)}</span>
      <span className="cell numeric nowrap">{relativeOrDash(station.observed)}</span>
    </button>
  );
}
