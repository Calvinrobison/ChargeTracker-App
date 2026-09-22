/**
 * Stall counts: how many a location has, and how many are free.
 *
 * These are two different questions and the application keeps them apart.
 * Capacity is a property of the site. Availability is a property of a moment,
 * and only a monitored location that was actually read can answer it.
 *
 * The rules here exist so that filtering never invents an answer:
 *
 *   - a location whose capacity is unknown is EXCLUDED by a capacity filter,
 *     not treated as 0 and not quietly included;
 *   - a location that has never been observed is EXCLUDED by an availability
 *     filter, because "we did not look" is not "none are free";
 *   - where the source and the catalog disagree about capacity, the source
 *     figure is used and the disagreement is reported, rather than one being
 *     silently preferred over the other.
 */

/** An inclusive range with either end open. `null` means unbounded, never 0. */
export interface StallRange {
  readonly min: number | null;
  readonly max: number | null;
}

export interface CapacityInputs {
  /** Ports the source reported for the monitored scope, null when unknown. */
  readonly sourcePorts: number | null;
  /** Ports the catalog lists, null when unknown. */
  readonly catalogPorts: number | null;
}

export interface CapacityResolution {
  /** The figure to filter, sort and display by. Null when nothing is known. */
  readonly stalls: number | null;
  readonly basis: 'source' | 'catalog' | null;
  /** True only when both are known AND they differ. */
  readonly disagrees: boolean;
}

/**
 * Chooses which stall count to use, and says whether the two sources conflict.
 *
 * The source figure wins because it was measured on the page rather than
 * imported from a registry that may be years stale. That is a defensible
 * default, not a certainty — which is exactly why `disagrees` is returned
 * alongside it instead of the loser being dropped.
 */
export function resolveCapacity(inputs: CapacityInputs): CapacityResolution {
  const { sourcePorts, catalogPorts } = inputs;

  if (sourcePorts !== null && catalogPorts !== null) {
    return {
      stalls: sourcePorts,
      basis: 'source',
      disagrees: sourcePorts !== catalogPorts,
    };
  }
  if (sourcePorts !== null) return { stalls: sourcePorts, basis: 'source', disagrees: false };
  if (catalogPorts !== null) return { stalls: catalogPorts, basis: 'catalog', disagrees: false };
  return { stalls: null, basis: null, disagrees: false };
}

/** True when a range constrains nothing, so the filter should not be applied. */
export function isOpenRange(range: StallRange): boolean {
  return range.min === null && range.max === null;
}

/**
 * Whether a count falls inside a range.
 *
 * A null count NEVER matches a range that constrains anything. An unknown
 * capacity is not zero stalls, and an unobserved location does not have zero
 * free stalls; including either would put a location in a result set that
 * asserts something about it nobody measured.
 */
export function matchesRange(count: number | null, range: StallRange): boolean {
  if (isOpenRange(range)) return true;
  if (count === null) return false;
  if (range.min !== null && count < range.min) return false;
  if (range.max !== null && count > range.max) return false;
  return true;
}

/**
 * A range with the ends put the right way round.
 *
 * Someone typing 20 into the first box and 8 into the second means 8 to 20,
 * and an empty result set would read as "there are none" rather than "you
 * typed it backwards". Swapping is the reading that matches the intent; the
 * alternative is refusing input that has an obvious meaning.
 */
export function normalizeRange(range: StallRange): StallRange {
  const { min, max } = range;
  if (min !== null && max !== null && min > max) return { min: max, max: min };
  return range;
}

/** Plain-language summary of a range, for labels and empty states. */
export function describeRange(range: StallRange, noun = 'stalls'): string | null {
  const { min, max } = normalizeRange(range);
  if (min === null && max === null) return null;
  if (min !== null && max !== null) {
    return min === max ? `exactly ${min} ${noun}` : `${min}–${max} ${noun}`;
  }
  if (min !== null) return `${min}+ ${noun}`;
  return `up to ${String(max)} ${noun}`;
}
