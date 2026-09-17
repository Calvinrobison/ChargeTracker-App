/**
 * The weekday × hour heatmap.
 *
 * The rule that shapes this component: a bin with no observation uses the
 * dedicated no-data step and says "no observation recorded" in its tooltip. It
 * is never drawn as a low value, because "quiet" and "we did not look" are
 * different facts.
 */

import type { ReactNode } from 'react';

import type { HeatmapCellView } from '../../../shared/ipc.ts';
import { WEEKDAY_LABELS, heatColor, hourLabel } from '../format.ts';

export interface HeatmapProps {
  readonly cells: readonly HeatmapCellView[];
  /** 24 columns for Overview, 12 (two-hour buckets) for the drawer. */
  readonly columns: 24 | 12;
  readonly compact?: boolean;
  readonly axisHours?: readonly number[];
}

interface Bucket {
  readonly hour: number;
  readonly occupancyPct: number | null;
  readonly hasData: boolean;
}

/**
 * Buckets 24 hours into 12 two-hour columns for the narrow drawer.
 *
 * A bucket has data only if at least one of its hours does, and its value is
 * the mean of the hours that actually have data — never a mean that treats a
 * missing hour as zero.
 */
function bucketRow(rowCells: readonly HeatmapCellView[], columns: 24 | 12): Bucket[] {
  if (columns === 24) {
    return rowCells.map((cell) => ({
      hour: cell.hour,
      occupancyPct: cell.occupancyPct,
      hasData: cell.hasData,
    }));
  }
  const buckets: Bucket[] = [];
  for (let i = 0; i < 24; i += 2) {
    const pair = [rowCells[i], rowCells[i + 1]].filter(
      (cell): cell is HeatmapCellView => cell !== undefined && cell.hasData,
    );
    if (pair.length === 0) {
      buckets.push({ hour: i, occupancyPct: null, hasData: false });
      continue;
    }
    const total = pair.reduce((sum, cell) => sum + (cell.occupancyPct ?? 0), 0);
    buckets.push({ hour: i, occupancyPct: total / pair.length, hasData: true });
  }
  return buckets;
}

export function Heatmap({ cells, columns, compact = false, axisHours }: HeatmapProps): ReactNode {
  const byWeekday = WEEKDAY_LABELS.map((_, weekday) =>
    Array.from({ length: 24 }, (_unused, hour) =>
      cells.find((cell) => cell.weekday === weekday && cell.hour === hour),
    ).filter((cell): cell is HeatmapCellView => cell !== undefined),
  );

  const axis = axisHours ?? (columns === 24 ? [0, 4, 8, 12, 16, 20, 23] : [0, 6, 12, 18, 23]);

  return (
    <div>
      <div className="heatmap" role="img" aria-label="Occupancy by weekday and hour">
        {byWeekday.map((rowCells, weekday) => (
          <div className="heatmap-row" key={weekday}>
            <span className={compact ? 'heatmap-day heatmap-day--compact' : 'heatmap-day'}>
              {WEEKDAY_LABELS[weekday]}
            </span>
            {bucketRow(rowCells, columns).map((bucket) => (
              <span
                key={bucket.hour}
                className={compact ? 'heatmap-cell heatmap-cell--compact' : 'heatmap-cell'}
                style={{ background: heatColor(bucket.occupancyPct, bucket.hasData) }}
                // Every cell carries its own title, per the handoff.
                title={
                  bucket.hasData
                    ? `${WEEKDAY_LABELS[weekday]} ${hourLabel(bucket.hour)} · ${Math.round(bucket.occupancyPct ?? 0)}% occupancy`
                    : `${WEEKDAY_LABELS[weekday]} ${hourLabel(bucket.hour)} · no observation recorded`
                }
              />
            ))}
          </div>
        ))}
      </div>

      <div className="heatmap-axis">
        {axis.map((hour) => (
          <span key={hour}>{hourLabel(hour)}</span>
        ))}
      </div>
    </div>
  );
}

/** The ramp key, including the explicit no-data swatch. */
export function HeatmapKey(): ReactNode {
  return (
    <div className="heatmap-key">
      <span>Low</span>
      <span className="heatmap-key-swatches" aria-hidden="true">
        {['--heat-1', '--heat-2', '--heat-3', '--heat-4', '--heat-5'].map((token) => (
          <span key={token} className="heatmap-key-swatch" style={{ background: `var(${token})` }} />
        ))}
      </span>
      <span>High</span>
      <span style={{ marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span className="heatmap-key-swatch" style={{ background: 'var(--heat-0)' }} aria-hidden="true" />
        No data
      </span>
    </div>
  );
}
