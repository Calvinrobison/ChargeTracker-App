/**
 * The Map workspace: the product's primary surface.
 *
 * Layout: rail, map, drawer. When no station is selected the drawer unmounts
 * entirely and the map expands — never a blank right column.
 */

import { useRef, useState, type ReactNode } from 'react';

import type {
  BootstrapView,
  SourceHealthView,
  StationDetailView,
  StationView,
} from '../../../shared/ipc.ts';
import { useUi, type MapMetric } from '../state.tsx';
import { BAND_LABELS, HISTORICAL_NOT_CURRENT_NOTE } from '../../../domain/thresholds.ts';
import { DATE_PRESET_LABELS } from '../state.tsx';
import { StationMap, type StationMapHandle } from './StationMap.tsx';
import { StationRail } from './StationRail.tsx';
import { StationDrawer } from './StationDrawer.tsx';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CrosshairIcon,
  FitFrameIcon,
  MinusIcon,
  PlusIcon,
  StudyRadiusIcon,
} from './Icons.tsx';

export interface MapWorkspaceProps {
  readonly bootstrap: BootstrapView;
  readonly stations: readonly StationView[];
  readonly monitoredCount: number;
  readonly totalCount: number;
  readonly visitsMetricAvailable: boolean;
  readonly sources: readonly SourceHealthView[];
  readonly detail: StationDetailView | null;
  readonly onToggleSaved: (siteId: string, saved: boolean) => void;
  readonly onOpenSource: (siteId: string) => void;
  readonly onExportStation: (siteId: string) => void;
  readonly onAddVisitCounts: (siteId: string) => void;
  readonly onImportVisitCsv: () => void;
  readonly onOpenSourceDetails: () => void;
  readonly onRetrySource: () => void;
  readonly retrying: boolean;
}

const METRIC_LABELS: Record<MapMetric, string> = {
  occupancy: 'Occupancy',
  current: 'Current',
  coverage: 'Coverage',
  visits: 'Visits',
};

/** Legend content per metric. The title always names the metric and period. */
function legendFor(
  metric: MapMetric,
  periodLabel: string,
): { title: string; items: { color: string; label: string; hollow?: boolean }[] } {
  switch (metric) {
    case 'current':
      return {
        title: 'Current status',
        items: [
          { color: 'var(--status-available)', label: 'Available now' },
          { color: 'var(--status-warning)', label: 'Fully occupied' },
          { color: 'var(--status-critical)', label: 'One or more offline' },
          { color: 'var(--dot-catalog)', label: 'Unknown · catalog only', hollow: true },
        ],
      };
    case 'coverage':
      return {
        title: `Observation coverage · ${periodLabel.toLowerCase()}`,
        items: [
          { color: 'rgba(93,187,151,.9)', label: 'High coverage' },
          { color: 'rgba(93,187,151,.45)', label: 'Partial coverage' },
          { color: 'rgba(93,187,151,.18)', label: 'Little coverage' },
          { color: 'var(--dot-catalog)', label: 'Not monitored', hollow: true },
        ],
      };
    case 'visits':
      return {
        title: 'Measured property visits',
        items: [{ color: 'var(--dot-catalog)', label: 'No visit counts added yet', hollow: true }],
      };
    default:
      return {
        title: `Historical occupancy · ${periodLabel.toLowerCase()}`,
        items: [
          { color: 'var(--status-available)', label: BAND_LABELS.low },
          { color: 'var(--status-warning)', label: BAND_LABELS.moderate },
          { color: 'var(--status-critical)', label: BAND_LABELS.high },
          { color: 'var(--dot-catalog)', label: BAND_LABELS.unsupported, hollow: true },
        ],
      };
  }
}

export function MapWorkspace(props: MapWorkspaceProps): ReactNode {
  const { state, dispatch } = useUi();
  const mapHandle = useRef<StationMapHandle | null>(null);
  const [basemapUnavailable, setBasemapUnavailable] = useState(false);

  const periodLabel = DATE_PRESET_LABELS[state.datePreset];
  const legend = legendFor(state.metric, periodLabel);
  const selected = state.selectedId;
  // Captured once per render so callbacks close over a stable, narrowed value
  // rather than re-reading props at call time.
  const detail = props.detail;

  return (
    <div className="app-body">
      <StationRail
        stations={props.stations}
        monitoredCount={props.monitoredCount}
        totalCount={props.totalCount}
        sources={props.sources}
        onOpenSourceDetails={props.onOpenSourceDetails}
        onRetrySource={props.onRetrySource}
        retrying={props.retrying}
      />

      <main className="map-main">
        <StationMap
          stations={props.stations}
          metric={state.metric}
          selectedId={selected}
          showStudyCircle={state.studyCircle}
          radiusMiles={props.bootstrap.studyArea.radiusMiles}
          onSelect={(id) => dispatch({ type: 'selectStation', id })}
          onBasemapUnavailable={setBasemapUnavailable}
          handleRef={mapHandle}
        />

        {/* Metric selector, top-left. One metric at a time. */}
        <div
          className="map-chrome map-metric-selector"
          role="group"
          aria-label="Map metric"
        >
          {(['occupancy', 'current', 'coverage', 'visits'] as const).map((metric) => {
            const disabled = metric === 'visits' && !props.visitsMetricAvailable;
            return (
              <button
                key={metric}
                type="button"
                className="metric-option"
                aria-pressed={state.metric === metric}
                disabled={disabled}
                title={disabled ? 'No visit counts added yet' : undefined}
                style={disabled ? { cursor: 'not-allowed' } : undefined}
                onClick={() => dispatch({ type: 'setMetric', metric })}
              >
                {METRIC_LABELS[metric]}
              </button>
            );
          })}
        </div>

        {/* Toolbar, top-right. */}
        <div className="map-chrome map-toolbar" role="group" aria-label="Map controls">
          <button
            type="button"
            className="map-tool"
            aria-label="Zoom in"
            title="Zoom in"
            onClick={() => mapHandle.current?.zoomIn()}
          >
            <PlusIcon size={14} />
          </button>
          <button
            type="button"
            className="map-tool"
            aria-label="Zoom out"
            title="Zoom out"
            onClick={() => mapHandle.current?.zoomOut()}
          >
            <MinusIcon size={14} />
          </button>
          <span className="map-tool-divider" aria-hidden="true" />
          <button
            type="button"
            className="map-tool"
            aria-label="Reset view"
            title="Reset view"
            onClick={() => mapHandle.current?.resetView()}
          >
            <CrosshairIcon size={14} />
          </button>
          <button
            type="button"
            className="map-tool"
            aria-label="Fit filtered stations"
            title="Fit filtered stations"
            onClick={() => mapHandle.current?.fitStations()}
          >
            <FitFrameIcon size={14} />
          </button>
          <button
            type="button"
            className="map-tool"
            aria-pressed={state.studyCircle}
            aria-label="Toggle the study radius"
            title="Toggle the 50-mile study radius"
            onClick={() => dispatch({ type: 'toggleStudyCircle' })}
          >
            <StudyRadiusIcon size={14} />
          </button>
        </div>

        {/* Legend, bottom-left, collapsible. */}
        <div className="map-chrome map-legend">
          <button
            type="button"
            className="map-legend-header"
            aria-expanded={state.legendOpen}
            onClick={() => dispatch({ type: 'toggleLegend' })}
          >
            <span className="map-legend-title">{legend.title}</span>
            {state.legendOpen ? <ChevronDownIcon size={12} /> : <ChevronUpIcon size={12} />}
          </button>
          {state.legendOpen ? (
            <>
              <div className="map-legend-items">
                {legend.items.map((item) => (
                  <span className="map-legend-item" key={item.label}>
                    <span
                      className="map-legend-swatch"
                      style={{
                        background: item.hollow ? 'rgba(43,59,53,.55)' : item.color,
                        border: item.hollow ? '1.5px dashed var(--text-tertiary)' : undefined,
                      }}
                      aria-hidden="true"
                    />
                    {item.label}
                  </span>
                ))}
              </div>
              {/* The disclaimer is part of the legend, always. */}
              <div className="map-legend-footer">{HISTORICAL_NOT_CURRENT_NOTE}</div>
            </>
          ) : null}
        </div>

        {basemapUnavailable ? (
          <div className="map-unavailable">
            <div className="map-unavailable-card">
              <div className="map-unavailable-title">Map background unavailable</div>
              <div className="map-unavailable-body">
                Station data, markers and history are still available.
              </div>
            </div>
          </div>
        ) : null}
      </main>

      {/* No selection means no drawer at all, so the map gets the width. */}
      {selected !== null && detail !== null ? (
        <StationDrawer
          detail={detail}
          timeZone={props.bootstrap.studyArea.timeZone}
          onClose={() => dispatch({ type: 'selectStation', id: null })}
          // `detail` is captured, not read through props inside the callback.
          // A callback runs after the render that created it, by which point
          // props.detail may have become null -- so reading it there would
          // throw on a real click, not just fail a type check.
          onToggleSaved={() => props.onToggleSaved(selected, !detail.station.saved)}
          onOpenSource={() => props.onOpenSource(selected)}
          onExportStation={() => props.onExportStation(selected)}
          onAddVisitCounts={() => props.onAddVisitCounts(selected)}
          onImportVisitCsv={props.onImportVisitCsv}
        />
      ) : null}
    </div>
  );
}
