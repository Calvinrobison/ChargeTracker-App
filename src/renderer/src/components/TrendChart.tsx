/**
 * The occupancy trend line.
 *
 * The one thing this component must get right: a day with no observation is a
 * PATH BREAK. The polyline starts a new `M` segment rather than dipping to
 * zero, and the gap is shaded so the absence is visible rather than implied.
 *
 * Drawn as inline SVG rather than with a chart library so the break behaviour
 * is explicit in code that can be read, and so the renderer carries no chart
 * dependency for a single line.
 */

import { useMemo, type ReactNode } from 'react';

import type { TrendView } from '../../../shared/ipc.ts';
import { isoDateToShort } from '../format.ts';

export interface TrendChartProps {
  readonly trend: TrendView;
  readonly width: number;
  readonly height: number;
  readonly gridlines?: number;
}

interface Segment {
  readonly points: { readonly x: number; readonly y: number }[];
}

export function TrendChart({ trend, width, height, gridlines = 2 }: TrendChartProps): ReactNode {
  const { segments, gapRects, hasAnyData } = useMemo(() => {
    const points = trend.points;
    const count = Math.max(1, points.length - 1);
    const xOf = (index: number): number => (index / count) * width;
    const yOf = (value: number): number =>
      height - (Math.min(100, Math.max(0, value)) / 100) * height;

    const built: Segment[] = [];
    let current: { x: number; y: number }[] = [];
    const rects: { x: number; width: number }[] = [];
    let gapStart: number | null = null;

    points.forEach((point, index) => {
      if (point.hasData && point.occupancyPct !== null) {
        current.push({ x: xOf(index), y: yOf(point.occupancyPct) });
        if (gapStart !== null) {
          rects.push({ x: gapStart, width: Math.max(1, xOf(index) - gapStart) });
          gapStart = null;
        }
        return;
      }
      // Missing day: close the current segment and start shading.
      if (current.length > 0) {
        built.push({ points: current });
        current = [];
      }
      if (gapStart === null) gapStart = xOf(index);
    });

    if (current.length > 0) built.push({ points: current });
    if (gapStart !== null) rects.push({ x: gapStart, width: Math.max(1, width - gapStart) });

    return {
      segments: built,
      gapRects: rects,
      hasAnyData: built.some((segment) => segment.points.length > 0),
    };
  }, [trend.points, width, height]);

  const first = trend.points[0];
  const middle = trend.points[Math.floor(trend.points.length / 2)];
  const last = trend.points[trend.points.length - 1];
  const gapDays = trend.points.filter((point) => !point.hasData).length;

  return (
    <div className="chart-card">
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={
          hasAnyData
            ? `Occupancy trend. ${gapDays} day${gapDays === 1 ? '' : 's'} with no observations are drawn as gaps.`
            : 'No observations have been recorded for this period yet.'
        }
      >
        {Array.from({ length: gridlines }, (_unused, index) => {
          const y = ((index + 1) / (gridlines + 1)) * height;
          return (
            <line
              key={index}
              x1={0}
              x2={width}
              y1={y}
              y2={y}
              stroke="var(--border)"
              strokeWidth={1}
              strokeDasharray="2 5"
            />
          );
        })}

        {/* Shade the periods with no observation. */}
        {gapRects.map((rect, index) => (
          <rect
            key={index}
            x={rect.x}
            y={0}
            width={rect.width}
            height={height}
            fill="rgba(145,163,155,.07)"
          />
        ))}

        {segments.map((segment, index) => (
          <polyline
            key={index}
            points={segment.points.map((point) => `${point.x},${point.y}`).join(' ')}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>

      <div className="chart-axis">
        <span>{first ? isoDateToShort(first.isoDate) : ''}</span>
        <span>
          {gapDays > 0
            ? `Collection gap · ${gapDays} day${gapDays === 1 ? '' : 's'}`
            : middle
              ? isoDateToShort(middle.isoDate)
              : ''}
        </span>
        <span>{last ? isoDateToShort(last.isoDate) : ''}</span>
      </div>

      <div className="chart-footnote">{trend.note}</div>
    </div>
  );
}

/**
 * The day-one state.
 *
 * No fabricated chart is ever drawn while history is building: this shows what
 * has actually been collected and what happens next.
 */
export function HistoryBuilding({
  observations,
  historyDays,
  nextCheckLabel,
}: {
  readonly observations: number;
  readonly historyDays: number;
  readonly nextCheckLabel: string | null;
}): ReactNode {
  return (
    <div className="dashed-card">
      <div style={{ fontSize: 13, fontWeight: 500 }}>History is building</div>
      <div
        style={{ marginTop: 6, fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}
      >
        Charts appear once there is enough collected history to be worth showing. ChargeWatch will
        not draw a graph of data it does not have.
      </div>
      <div className="fact-rows" style={{ marginBottom: 0 }}>
        <div className="fact-row">
          <span className="fact-label">Observations collected</span>
          <span>{new Intl.NumberFormat('en-US').format(observations)}</span>
        </div>
        <div className="fact-row">
          <span className="fact-label">Time elapsed</span>
          <span>
            {historyDays} day{historyDays === 1 ? '' : 's'}
          </span>
        </div>
        <div className="fact-row">
          <span className="fact-label">Next scheduled check</span>
          <span>{nextCheckLabel ?? 'Not scheduled'}</span>
        </div>
      </div>
    </div>
  );
}
