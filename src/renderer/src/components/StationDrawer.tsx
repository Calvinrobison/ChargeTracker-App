/**
 * The 404px station detail drawer.
 *
 * Every section here exists to make an honest claim rather than a confident
 * one: current status carries its own freshness and never a "LIVE" indicator,
 * data quality states its coverage and scope, activity metrics are hidden when
 * the source cannot support them, visits default to empty, and location
 * context is structure only.
 */

import { useState, type ReactNode } from 'react';

import type { StationDetailView } from '../../../shared/ipc.ts';
import { useUi } from '../state.tsx';
import {
  EM_DASH,
  bandColor,
  count,
  freshnessText,
  hours as formatHours,
  occupancyBandOf,
  pct,
  relativeTime,
} from '../format.ts';
import { Heatmap, HeatmapKey } from './Heatmap.tsx';
import { TrendChart } from './TrendChart.tsx';
import { BookmarkIcon, ChevronDownIcon, ChevronUpIcon, CloseIcon, ExternalIcon } from './Icons.tsx';

export interface StationDrawerProps {
  readonly detail: StationDetailView;
  readonly timeZone: string;
  readonly onClose: () => void;
  readonly onToggleSaved: () => void;
  readonly onOpenSource: () => void;
  readonly onExportStation: () => void;
  readonly onAddVisitCounts: () => void;
  readonly onImportVisitCsv: () => void;
}

const QUALITY_LABELS: Record<StationDetailView['dataQuality']['badge'], string> = {
  reliable: 'Reliable',
  provisional: 'Provisional',
  stale_source: 'Stale source',
};

export function StationDrawer({
  detail,
  timeZone,
  onClose,
  onToggleSaved,
  onOpenSource,
  onExportStation,
  onAddVisitCounts,
  onImportVisitCsv,
}: StationDrawerProps): ReactNode {
  const { state, dispatch } = useUi();
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const station = detail.station;
  const band = occupancyBandOf(station.occupancy);

  return (
    <aside className="drawer" aria-label={`${station.name} details`}>
      <header className="drawer-header">
        <div className="drawer-identity">
          <h2 className="drawer-title">{station.name}</h2>
          <div className="drawer-address">{station.address ?? 'Address not recorded'}</div>
          <div className="drawer-status-row">
            <span
              className="dot"
              style={{
                background:
                  station.monitoring === 'catalog' ? 'var(--dot-catalog)' : bandColor(band),
              }}
              aria-hidden="true"
            />
            <span>
              {[
                station.network ?? 'Network unknown',
                station.type ?? 'Charging type unknown',
                station.ports === null
                  ? 'port count unknown'
                  : `${station.ports} port${station.ports === 1 ? '' : 's'}`,
              ].join(' · ')}
            </span>
          </div>
        </div>
        <div className="drawer-header-actions">
          <button
            type="button"
            className="icon-button icon-button-sm"
            aria-pressed={station.saved}
            aria-label={station.saved ? 'Remove from saved' : 'Save this location'}
            title={station.saved ? 'Remove from saved' : 'Save this location'}
            onClick={onToggleSaved}
            style={{ color: station.saved ? 'var(--accent-selected)' : 'var(--text-secondary)' }}
          >
            <BookmarkIcon size={14} filled={station.saved} />
          </button>
          <button
            type="button"
            className="icon-button icon-button-sm"
            aria-label="Close details"
            title="Close details"
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </button>
        </div>
      </header>

      <div className="drawer-body">
        {/* 1 — Current status. No "LIVE" indicator, ever. */}
        <section>
          <div className="section-eyebrow-row">
            <span className="section-eyebrow">Current status</span>
            <span className="section-note">
              {station.ports === null
                ? 'Monitored ports unknown'
                : `${station.ports} monitored charger${station.ports === 1 ? '' : 's'}`}
            </span>
          </div>
          <div className="status-cards">
            <StatusCard
              label="Available"
              dotColor="var(--status-available)"
              value={station.available}
            />
            <StatusCard
              label={station.distinguishesCharging ? 'Charging' : 'In use'}
              dotColor="var(--status-warning)"
              value={station.occupied}
            />
            <StatusCard label="Offline" dotColor="var(--status-critical)" value={station.offline} />
          </div>
          <div className="status-freshness">
            <span>
              {station.observedAtMs === null
                ? 'No observation recorded'
                : `Observed ${relativeTime(station.observedAtMs)}`}
            </span>
            <span>{freshnessText(station)}</span>
          </div>
          <div className="chart-footnote">{detail.currentStatusNote}</div>
        </section>

        {/* 2 — Data quality. */}
        <section>
          <div className="section-eyebrow-row">
            <span className="section-eyebrow">Data quality</span>
            <span className={`quality-pill quality-pill--${detail.dataQuality.badge}`}>
              {QUALITY_LABELS[detail.dataQuality.badge]}
            </span>
          </div>
          <div className="quality-grid">
            <div className="quality-cell">
              <div className="quality-cell-label">Coverage</div>
              <div className="quality-cell-value">{pct(detail.dataQuality.coveragePct)}</div>
            </div>
            <div className="quality-cell">
              <div className="quality-cell-label">History</div>
              <div className="quality-cell-value">
                {detail.dataQuality.historyDays} day
                {detail.dataQuality.historyDays === 1 ? '' : 's'}
              </div>
            </div>
            <div className="quality-cell">
              <div className="quality-cell-label">Latest observation</div>
              <div className="quality-cell-value">
                {detail.dataQuality.latestObservation ?? EM_DASH}
              </div>
            </div>
            <div className="quality-cell">
              <div className="quality-cell-label">Scope</div>
              <div className="quality-cell-value" style={{ fontSize: 12.5 }}>
                {detail.dataQuality.scope}
              </div>
            </div>
          </div>
          {station.provisionalReasons.length > 0 ? (
            <div className="chart-footnote">
              Not in the main ranking: {station.provisionalReasons.join('; ')}.
            </div>
          ) : null}
        </section>

        {/* 3 — Historical occupancy. */}
        <section>
          <div className="section-eyebrow-row">
            <span className="section-eyebrow">Historical occupancy</span>
            <div className="segmented" role="group" aria-label="Chart metric">
              {(['occupancy', 'hours', 'coverage'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className="segmented-option"
                  aria-pressed={state.detailChartMode === mode}
                  onClick={() => dispatch({ type: 'setDetailChartMode', mode })}
                >
                  {mode === 'occupancy' ? 'Occupancy' : mode === 'hours' ? 'Hours' : 'Coverage'}
                </button>
              ))}
            </div>
          </div>
          <TrendChart trend={detail.trend} width={340} height={82} gridlines={2} />
        </section>

        {/* 4 — Typical activity. */}
        <section>
          <div className="section-eyebrow-row">
            <span className="section-eyebrow">Typical activity</span>
          </div>
          <Heatmap cells={detail.heatmap} columns={12} compact />
          <div className="heatmap-footer">
            {station.peak ? (
              <>
                Peak observed period <strong>{station.peak}</strong>
              </>
            ) : (
              'Not enough observed history to identify a peak period.'
            )}
          </div>
          <HeatmapKey />
        </section>

        {/* 5 — Adaptive activity metrics. Hidden when unsupported. */}
        <section>
          <div className="section-eyebrow-row">
            <span className="section-eyebrow">Observed activity</span>
          </div>
          {detail.activity.capability === 'none' ? (
            <div className="dashed-card">
              <div style={{ fontSize: 12.5 }}>Not available</div>
              <div className="small-metric-note">{detail.activity.explanation}</div>
            </div>
          ) : (
            <div className="metric-pair">
              <div className="status-card">
                <div className="status-card-label">
                  {detail.activity.capability === 'recorded_sessions'
                    ? 'Recorded charging sessions'
                    : detail.activity.capability === 'detected_port_episodes'
                      ? 'Detected occupancy starts'
                      : 'Observed increases in occupied ports'}
                </div>
                <div className="small-metric-value" style={{ marginTop: 4 }}>
                  {detail.activity.capability === 'aggregate_count_changes'
                    ? count(detail.activity.observedIncreaseCount)
                    : detail.activity.detectedStartsPerDay === null
                      ? EM_DASH
                      : `~${detail.activity.detectedStartsPerDay.toFixed(0)} / day`}
                </div>
                <div className="small-metric-note">{detail.activity.explanation}</div>
              </div>
              <div className="status-card">
                <div className="status-card-label">Estimated dwell</div>
                <div className="small-metric-value" style={{ marginTop: 4 }}>
                  {detail.activity.estimatedDwell ?? 'Not available'}
                </div>
                <div className="small-metric-note">
                  {detail.activity.estimatedDwell === null
                    ? 'This source does not support dwell estimates.'
                    : 'Based on bounded observed occupancy episodes.'}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* 6 — Visits. Empty by default; nothing is ever guessed. */}
        <section>
          <div className="section-eyebrow-row">
            <span className="section-eyebrow">Visits</span>
          </div>
          {detail.visits.hasData ? (
            <>
              <div className="quality-grid">
                <div className="quality-cell">
                  <div className="quality-cell-label">Measured visits</div>
                  <div className="quality-cell-value">{count(detail.visits.visitCount)}</div>
                </div>
                <div className="quality-cell">
                  <div className="quality-cell-label">Ports</div>
                  <div className="quality-cell-value">{count(detail.visits.ports)}</div>
                </div>
                <div className="quality-cell">
                  <div className="quality-cell-label">Ports per 1,000 visits</div>
                  <div className="quality-cell-value">
                    {detail.visits.portsPer1000Visits === null
                      ? EM_DASH
                      : detail.visits.portsPer1000Visits.toFixed(2)}
                  </div>
                </div>
                <div className="quality-cell">
                  <div className="quality-cell-label">Detected starts per 1,000 visits</div>
                  <div className="quality-cell-value">
                    {detail.visits.detectedStartsPer1000Visits === null
                      ? EM_DASH
                      : detail.visits.detectedStartsPer1000Visits.toFixed(2)}
                  </div>
                </div>
              </div>
              {detail.visits.limitations.length > 0 ? (
                <div className="chart-footnote">{detail.visits.limitations.join(' ')}</div>
              ) : null}
            </>
          ) : (
            <div className="dashed-card">
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>No visit counts added</div>
              <div className="small-metric-note">
                Compare charging activity with actual property visit data when available.
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <button type="button" className="button-accent" onClick={onAddVisitCounts}>
                  Add counts
                </button>
                <button type="button" className="button-secondary" onClick={onImportVisitCsv}>
                  Import CSV
                </button>
              </div>
              {detail.visits.limitations.length > 0 ? (
                <div className="chart-footnote">{detail.visits.limitations.join(' ')}</div>
              ) : null}
            </div>
          )}
        </section>

        {/* 7 — Location context. Structure only; never fabricated figures. */}
        <section>
          <div className="section-eyebrow-row">
            <span className="section-eyebrow">Location context</span>
          </div>
          <div className="context-grid">
            {(
              [
                ['Nearby businesses', detail.locationContext.nearbyBusinesses],
                ['Parking', detail.locationContext.parking],
                ['Road traffic', detail.locationContext.roadTraffic],
                ['Property', detail.locationContext.property],
              ] as const
            ).map(([label, value]) => (
              <div className="quality-cell" key={label}>
                <div className="quality-cell-label">{label}</div>
                <div
                  className="quality-cell-value"
                  style={{ color: 'var(--text-tertiary)', fontSize: 12.5 }}
                >
                  {value ?? 'Not available'}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 8 — Data source, collapsed by default. */}
        <section className="disclosure">
          <button
            type="button"
            className="disclosure-header"
            aria-expanded={state.sourceOpen}
            onClick={() => dispatch({ type: 'toggleSourceDisclosure' })}
          >
            <span className="section-eyebrow">Data source</span>
            {state.sourceOpen ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />}
          </button>

          {state.sourceOpen ? (
            <>
              <div className="provenance-rows">
                <ProvenanceRow label="Source" value={detail.source.displayName ?? 'None'} />
                <ProvenanceRow
                  label="Observation method"
                  value={detail.source.observationMethod ?? 'Not monitored'}
                />
                <ProvenanceRow
                  label="Last successful read"
                  value={
                    detail.source.lastSuccessfulReadMs === null
                      ? EM_DASH
                      : relativeTime(detail.source.lastSuccessfulReadMs)
                  }
                />
                <ProvenanceRow label="Data scope" value={detail.source.dataScope} />
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={onOpenSource}
                  disabled={detail.source.sourceUrl === null}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <ExternalIcon size={12} /> Open source
                  </span>
                </button>
                <button type="button" className="button-text" onClick={onExportStation}>
                  Export station data
                </button>
              </div>

              <button
                type="button"
                className="link-button"
                style={{ marginTop: 10 }}
                aria-expanded={technicalOpen}
                onClick={() => setTechnicalOpen((open) => !open)}
              >
                Technical details
              </button>
              {technicalOpen ? (
                <div className="provenance-rows">
                  <ProvenanceRow label="Parser" value={detail.source.parserVersion ?? EM_DASH} />
                  <ProvenanceRow label="Adapter" value={detail.source.adapterVersion ?? EM_DASH} />
                  <ProvenanceRow
                    label="Metric algorithm"
                    value={`v${detail.source.metricAlgorithmVersion}`}
                  />
                  <ProvenanceRow label="Site id" value={station.id} />
                  <ProvenanceRow label="Timezone" value={timeZone} />
                </div>
              ) : null}
            </>
          ) : null}
        </section>

        {/* Occupied hours, shown alongside the normalized rate so neither is
            mistaken for the other. */}
        <section>
          <div className="metric-pair">
            <div className="status-card">
              <div className="status-card-label">Observed occupancy</div>
              <div className="small-metric-value" style={{ marginTop: 4, color: bandColor(band) }}>
                {pct(station.occupancy)}
              </div>
              <div className="small-metric-note">Normalised for how many ports this site has.</div>
            </div>
            <div className="status-card">
              <div className="status-card-label">Estimated occupied port-hours</div>
              <div className="small-metric-value" style={{ marginTop: 4 }}>
                {formatHours(station.hours)}
              </div>
              <div className="small-metric-note">Total observed activity over the period.</div>
            </div>
          </div>
        </section>
      </div>
    </aside>
  );
}

function StatusCard({
  label,
  dotColor,
  value,
}: {
  readonly label: string;
  readonly dotColor: string;
  readonly value: number | null;
}): ReactNode {
  return (
    <div className="status-card">
      <div className="status-card-label">
        <span className="dot" style={{ background: dotColor }} aria-hidden="true" />
        {label}
      </div>
      {/* A dimension the source did not report shows an em dash, not a zero. */}
      <div className="status-card-value">{value === null ? EM_DASH : value}</div>
    </div>
  );
}

function ProvenanceRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <div className="provenance-row">
      <span className="provenance-label">{label}</span>
      <span className="provenance-value">{value}</span>
    </div>
  );
}
