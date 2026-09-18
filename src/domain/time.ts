/**
 * Time primitives for ChargeWatch.
 *
 * Rules enforced here (see docs/METRICS.md):
 *  - All persisted instants are UTC integer milliseconds.
 *  - All spans are half-open intervals [startMs, endMs).
 *  - Local dates, weekdays and hours are always derived in the study timezone
 *    (America/Phoenix by default) through Intl, never through the machine
 *    timezone, so results do not change with the operator's clock settings.
 *
 * This module has no runtime dependencies on purpose: it is the most
 * correctness-sensitive code in the product and must be executable and
 * testable without a package install.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Display/aggregation timezone for the Mesa study area. */
export const STUDY_TIME_ZONE = 'America/Phoenix';

/** A half-open interval [startMs, endMs) in UTC milliseconds. */
export interface Interval {
  readonly startMs: number;
  readonly endMs: number;
}

export function isSafeInstant(ms: unknown): ms is number {
  return (
    typeof ms === 'number' && Number.isInteger(ms) && ms >= 0 && ms <= 4_102_444_800_000 // 2100-01-01T00:00:00Z — guards seconds/millis mix-ups
  );
}

export function assertSafeInstant(ms: unknown, label = 'instant'): number {
  if (!isSafeInstant(ms)) {
    throw new RangeError(
      `${label} must be an integer UTC millisecond value in [0, 4102444800000], received ${String(ms)}`,
    );
  }
  return ms;
}

/**
 * Builds a half-open interval, returning null for empty or inverted spans.
 * A zero-length interval is not an interval: it contributes no elapsed time.
 */
export function interval(startMs: number, endMs: number): Interval | null {
  assertSafeInstant(startMs, 'interval.startMs');
  assertSafeInstant(endMs, 'interval.endMs');
  if (endMs <= startMs) return null;
  return { startMs, endMs };
}

export function durationMs(span: Interval): number {
  return span.endMs - span.startMs;
}

export function durationMinutes(span: Interval): number {
  return durationMs(span) / MINUTE_MS;
}

/** Intersection of two half-open intervals, or null when they do not overlap. */
export function intersect(a: Interval, b: Interval): Interval | null {
  const startMs = Math.max(a.startMs, b.startMs);
  const endMs = Math.min(a.endMs, b.endMs);
  if (endMs <= startMs) return null;
  return { startMs, endMs };
}

/** Intersects one interval with a set, returning every overlapping piece. */
export function intersectAll(span: Interval, others: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const other of others) {
    const piece = intersect(span, other);
    if (piece) out.push(piece);
  }
  return out;
}

export function contains(span: Interval, instantMs: number): boolean {
  return instantMs >= span.startMs && instantMs < span.endMs;
}

/**
 * Sorts and merges touching or overlapping intervals into a canonical
 * non-overlapping ascending set.
 */
export function normalize(spans: readonly Interval[]): Interval[] {
  const sorted = [...spans]
    .filter((s) => s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const out: Interval[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span.startMs <= last.endMs) {
      if (span.endMs > last.endMs) {
        out[out.length - 1] = { startMs: last.startMs, endMs: span.endMs };
      }
      continue;
    }
    out.push({ startMs: span.startMs, endMs: span.endMs });
  }
  return out;
}

/** Total elapsed milliseconds across a set, counting overlaps only once. */
export function totalMs(spans: readonly Interval[]): number {
  return normalize(spans).reduce((sum, s) => sum + durationMs(s), 0);
}

/** `base` minus every span in `cuts`, as a normalized set. */
export function subtract(base: Interval, cuts: readonly Interval[]): Interval[] {
  let remaining: Interval[] = [base];
  for (const cut of normalize(cuts)) {
    const next: Interval[] = [];
    for (const span of remaining) {
      if (cut.endMs <= span.startMs || cut.startMs >= span.endMs) {
        next.push(span);
        continue;
      }
      if (cut.startMs > span.startMs) next.push({ startMs: span.startMs, endMs: cut.startMs });
      if (cut.endMs < span.endMs) next.push({ startMs: cut.endMs, endMs: span.endMs });
    }
    remaining = next;
  }
  return normalize(remaining);
}

// ---------------------------------------------------------------------------
// Study-timezone calendar helpers
// ---------------------------------------------------------------------------

export interface LocalParts {
  /** Four-digit local year. */
  readonly year: number;
  /** 1-12 */
  readonly month: number;
  /** 1-31 */
  readonly day: number;
  /** 0-23 */
  readonly hour: number;
  /** 0-59 */
  readonly minute: number;
  /** 0 = Sunday … 6 = Saturday, in the study timezone. */
  readonly weekday: number;
  /** ISO local date, e.g. "2026-09-17". */
  readonly isoDate: string;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  formatterCache.set(timeZone, created);
  return created;
}

/**
 * Decomposes a UTC instant into study-timezone calendar fields.
 * Machine timezone cannot influence the result.
 */
export function toLocalParts(utcMs: number, timeZone: string = STUDY_TIME_ZONE): LocalParts {
  assertSafeInstant(utcMs, 'toLocalParts.utcMs');
  const parts = partsFormatter(timeZone).formatToParts(new Date(utcMs));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let weekday = 0;
  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value) % 24;
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'weekday':
        weekday = WEEKDAY_INDEX[part.value] ?? 0;
        break;
      default:
        break;
    }
  }
  const isoDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(
    day,
  ).padStart(2, '0')}`;
  return { year, month, day, hour, minute, weekday, isoDate };
}

/** UTC offset in milliseconds applied by `timeZone` at `utcMs`. */
export function zoneOffsetMs(utcMs: number, timeZone: string = STUDY_TIME_ZONE): number {
  const p = toLocalParts(utcMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
  // Recover seconds/millis from the original instant, which the formatter drops.
  const secondsAndMillis = ((utcMs % MINUTE_MS) + MINUTE_MS) % MINUTE_MS;
  return asUtc + secondsAndMillis - utcMs;
}

/** Start of the local day containing `utcMs`, expressed as a UTC instant. */
export function startOfLocalDay(utcMs: number, timeZone: string = STUDY_TIME_ZONE): number {
  const p = toLocalParts(utcMs, timeZone);
  const guess = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0, 0);
  // Correct for the offset actually in force at the candidate midnight.
  const offset = zoneOffsetMs(guess - zoneOffsetMs(utcMs, timeZone), timeZone);
  return guess - offset;
}

/**
 * Splits a span into the local-hour buckets it covers, each piece carrying its
 * study-timezone weekday and hour. Used for the weekday/hour heatmap so a
 * single long interval is attributed to every hour it actually spans.
 */
export function splitByLocalHour(
  span: Interval,
  timeZone: string = STUDY_TIME_ZONE,
): Array<{ span: Interval; weekday: number; hour: number; isoDate: string }> {
  const out: Array<{ span: Interval; weekday: number; hour: number; isoDate: string }> = [];
  let cursor = span.startMs;
  let guard = 0;
  while (cursor < span.endMs) {
    if (++guard > 200_000) {
      throw new RangeError('splitByLocalHour: span too long to bucket safely');
    }
    const parts = toLocalParts(cursor, timeZone);
    const offset = zoneOffsetMs(cursor, timeZone);
    const localMs = cursor + offset;
    const nextLocalHourBoundary = Math.floor(localMs / HOUR_MS) * HOUR_MS + HOUR_MS;
    let next = nextLocalHourBoundary - offset;
    if (next <= cursor) next = cursor + HOUR_MS; // offset change safety net
    const end = Math.min(next, span.endMs);
    out.push({
      span: { startMs: cursor, endMs: end },
      weekday: parts.weekday,
      hour: parts.hour,
      isoDate: parts.isoDate,
    });
    cursor = end;
  }
  return out;
}

/** Number of distinct local calendar days touched by a span. */
export function localDaysCovered(span: Interval, timeZone: string = STUDY_TIME_ZONE): number {
  const days = new Set<string>();
  let cursor = startOfLocalDay(span.startMs, timeZone);
  let guard = 0;
  while (cursor < span.endMs) {
    if (++guard > 100_000) break;
    days.add(toLocalParts(Math.max(cursor, span.startMs), timeZone).isoDate);
    cursor = startOfLocalDay(cursor + DAY_MS + HOUR_MS * 6, timeZone);
  }
  return days.size;
}

/** Elapsed days in a span, as a fraction — used for eligibility thresholds. */
export function elapsedDays(span: Interval): number {
  return durationMs(span) / DAY_MS;
}
