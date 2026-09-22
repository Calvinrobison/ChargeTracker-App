/**
 * Two stall filters: how many a location HAS, and how many are FREE now.
 *
 * They are deliberately separate controls with separate labels, because they
 * answer different questions and one of them is answerable for far fewer
 * locations than the other:
 *
 *   - CAPACITY is known for every catalogued location, so this filter works
 *     across the whole map today.
 *   - FREE NOW is known only for a location that is monitored AND whose most
 *     recent read reported an available count. Everything else is excluded
 *     rather than counted as zero free, so the result set never implies that
 *     an unobserved location had no free stalls.
 *
 * The second filter therefore returns very little until monitoring is
 * widespread, and the control says so instead of looking broken.
 */

import type { ReactNode } from 'react';

import type { StallRange } from '../../../shared/ipc.ts';
import { describeRange, normalizeRange } from '../../../domain/stalls.ts';

interface RangeInputsProps {
  readonly idPrefix: string;
  readonly range: StallRange;
  readonly onChange: (range: StallRange) => void;
  readonly disabled?: boolean;
}

/**
 * An empty box is `null`, not 0.
 *
 * Clearing the minimum means "no lower bound"; typing 0 would mean "locations
 * with no stalls". Mapping an empty string to 0 would silently turn the first
 * into the second.
 */
function toBound(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(parsed, 500);
}

function RangeInputs({ idPrefix, range, onChange, disabled }: RangeInputsProps): ReactNode {
  return (
    <div className="stall-range-inputs">
      <label className="stall-range-field" htmlFor={`${idPrefix}-min`}>
        <span className="stall-range-field-label">Min</span>
        <input
          id={`${idPrefix}-min`}
          type="number"
          inputMode="numeric"
          min={0}
          max={500}
          placeholder="any"
          disabled={disabled}
          value={range.min === null ? '' : String(range.min)}
          onChange={(event) => onChange({ ...range, min: toBound(event.target.value) })}
        />
      </label>
      <span className="stall-range-dash" aria-hidden="true">
        –
      </span>
      <label className="stall-range-field" htmlFor={`${idPrefix}-max`}>
        <span className="stall-range-field-label">Max</span>
        <input
          id={`${idPrefix}-max`}
          type="number"
          inputMode="numeric"
          min={0}
          max={500}
          placeholder="any"
          disabled={disabled}
          value={range.max === null ? '' : String(range.max)}
          onChange={(event) => onChange({ ...range, max: toBound(event.target.value) })}
        />
      </label>
    </div>
  );
}

export interface StallRangeFilterProps {
  readonly stalls: StallRange;
  readonly freeStalls: StallRange;
  readonly onStallsChange: (range: StallRange) => void;
  readonly onFreeStallsChange: (range: StallRange) => void;
  /** How many locations are monitored, which is what the second filter needs. */
  readonly monitoredCount: number;
}

export function StallRangeFilter({
  stalls,
  freeStalls,
  onStallsChange,
  onFreeStallsChange,
  monitoredCount,
}: StallRangeFilterProps): ReactNode {
  const capacitySummary = describeRange(normalizeRange(stalls));
  const freeSummary = describeRange(normalizeRange(freeStalls), 'free');
  const swapped =
    stalls.min !== null && stalls.max !== null && stalls.min > stalls.max
      ? 'Read as a range, lowest first.'
      : null;

  return (
    <div className="stall-filters">
      <section className="stall-filter">
        <div className="stall-filter-head">
          <span className="stall-filter-title">Stalls at the location</span>
          {capacitySummary ? (
            <button
              type="button"
              className="stall-filter-clear"
              onClick={() => onStallsChange({ min: null, max: null })}
            >
              Clear
            </button>
          ) : null}
        </div>
        <RangeInputs idPrefix="stalls" range={stalls} onChange={onStallsChange} />
        <p className="stall-filter-note">
          {capacitySummary === null
            ? 'How many stalls the site has, whatever its current state.'
            : `Showing ${capacitySummary}.`}
          {swapped === null ? '' : ` ${swapped}`}
        </p>
        <p className="stall-filter-note stall-filter-note--muted">
          Uses the count the source reported where a location is monitored, and the catalog count
          otherwise. Locations where the two disagree are marked.
        </p>
      </section>

      <section className="stall-filter">
        <div className="stall-filter-head">
          <span className="stall-filter-title">Stalls free right now</span>
          {freeSummary ? (
            <button
              type="button"
              className="stall-filter-clear"
              onClick={() => onFreeStallsChange({ min: null, max: null })}
            >
              Clear
            </button>
          ) : null}
        </div>
        <RangeInputs idPrefix="free-stalls" range={freeStalls} onChange={onFreeStallsChange} />
        <p className="stall-filter-note">
          {freeSummary === null
            ? 'How many stalls were free at the most recent reading.'
            : `Showing ${freeSummary}.`}
        </p>
        <p className="stall-filter-note stall-filter-note--muted">
          {monitoredCount === 0
            ? 'No location is monitored yet, so nothing can answer this and it will return nothing. Turn on monitoring for a location first.'
            : `Only the ${monitoredCount.toLocaleString('en-US')} monitored location${
                monitoredCount === 1 ? '' : 's'
              } can answer this. A location nobody has read is left out rather than counted as none free.`}
        </p>
      </section>
    </div>
  );
}
