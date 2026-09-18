/**
 * Display formatting.
 *
 * The single rule that matters: `null` is not zero. Every formatter here turns
 * a missing value into the muted placeholder the handoff specifies — "—",
 * "Not available", "Insufficient history", "No current status", "Source
 * freshness unknown" or "Catalog only" — and never into a number.
 */

import type { StationView } from '../../shared/ipc.ts';
import { OCCUPANCY_BANDS, type OccupancyBand } from '../../domain/thresholds.ts';

export const EM_DASH = '—';

export function pct(value: number | null, decimals = 0): string {
  if (value === null || !Number.isFinite(value)) return EM_DASH;
  return `${value.toFixed(decimals)}%`;
}

export function count(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return EM_DASH;
  return new Intl.NumberFormat('en-US').format(value);
}

export function hours(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return EM_DASH;
  if (value >= 100)
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
}

export function relativeOrDash(value: string | null): string {
  return value ?? EM_DASH;
}

/** Colour for an occupancy band. Null is its own band, never a low-value green. */
export function bandColor(band: OccupancyBand): string {
  switch (band) {
    case 'low':
      return 'var(--status-available)';
    case 'moderate':
      return 'var(--status-warning)';
    case 'high':
      return 'var(--status-critical)';
    default:
      return 'var(--text-secondary)';
  }
}

export function occupancyBandOf(value: number | null): OccupancyBand {
  if (value === null || !Number.isFinite(value)) return 'unsupported';
  if (value < OCCUPANCY_BANDS.lowBelowPct) return 'low';
  if (value < OCCUPANCY_BANDS.moderateBelowPct) return 'moderate';
  return 'high';
}

/**
 * Status-dot colour for a station row.
 *
 * Order matters and is taken from the handoff: catalog, then provisional, then
 * any offline port, then zero available, then available.
 */
export function statusDotColor(station: StationView): string {
  if (station.monitoring === 'catalog') return 'var(--dot-catalog)';
  if (station.monitoring === 'provisional' || station.monitoring === 'stale') {
    return 'var(--dot-provisional)';
  }
  if ((station.offline ?? 0) > 0) return 'var(--status-critical)';
  if (station.available === 0) return 'var(--status-warning)';
  return 'var(--status-available)';
}

/** The text that accompanies the dot, so colour is never the only signal. */
export function statusDotLabel(station: StationView): string {
  if (station.monitoring === 'catalog') return 'Catalog only, not monitored';
  if (station.monitoring === 'stale') return 'Stale source';
  if (station.monitoring === 'provisional') return 'Provisional history';
  if ((station.offline ?? 0) > 0) return 'One or more ports offline';
  if (station.available === 0) return 'No ports available';
  return 'Ports available';
}

/** The "5 / 10 occupied" line, or an honest placeholder. */
export function currentStatusText(station: StationView): string {
  if (station.monitoring === 'catalog') return 'Not monitored';
  if (station.occupied === null || station.ports === null) return 'No current status';
  const label = station.distinguishesCharging ? 'charging' : 'occupied';
  return `${station.occupied} / ${station.ports} ${label}`;
}

/** The state badge, when the row needs one. */
export function stateBadge(station: StationView): string | null {
  switch (station.monitoring) {
    case 'catalog':
      return 'Catalog only';
    case 'stale':
      return 'Stale source';
    case 'provisional':
      return 'Provisional';
    default:
      return null;
  }
}

export function coverageAndAge(station: StationView): string {
  const parts: string[] = [];
  if (station.coverage !== null) parts.push(`${Math.round(station.coverage)}% cov`);
  if (station.observed !== null) parts.push(station.observed);
  return parts.join(' · ');
}

export function initialsOf(name: string): string {
  const words = name
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return (words[0] as string).slice(0, 2).toUpperCase();
  return `${(words[0] as string)[0] ?? ''}${(words[1] as string)[0] ?? ''}`.toUpperCase();
}

/** Freshness copy. "Unknown source clock" is a different fact from "stale". */
export function freshnessText(station: StationView): string {
  switch (station.sourceFreshness) {
    case 'stale':
      return 'Source data was already stale when read';
    case 'unknown_source_clock':
      return 'Source freshness unknown';
    case 'fresh':
      return station.sourceUpdatedAtMs === null
        ? 'Source freshness unknown'
        : `Source updated ${relativeTime(station.sourceUpdatedAtMs)}`;
    default:
      return 'No current status';
  }
}

export function relativeTime(instantMs: number | null, nowMs = Date.now()): string {
  if (instantMs === null) return EM_DASH;
  const delta = Math.max(0, nowMs - instantMs);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hoursAgo = Math.floor(minutes / 60);
  if (hoursAgo < 24) return `${hoursAgo}h ago`;
  return `${Math.floor(hoursAgo / 24)}d ago`;
}

export function clockTime(instantMs: number | null, timeZone: string): string {
  if (instantMs === null) return EM_DASH;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(instantMs));
}

export function shortDate(instantMs: number | null, timeZone: string): string {
  if (instantMs === null) return EM_DASH;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
  }).format(new Date(instantMs));
}

export function isoDateToShort(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  if (!year || !month || !day) return isoDate;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function hourLabel(hour: number): string {
  const normalized = ((hour % 24) + 24) % 24;
  if (normalized === 0) return '12a';
  if (normalized === 12) return '12p';
  return normalized < 12 ? `${normalized}a` : `${normalized - 12}p`;
}

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Ramp step for a heatmap cell. `null` gets the dedicated no-data step. */
export function heatColor(occupancyPct: number | null, hasData: boolean): string {
  if (!hasData || occupancyPct === null) return 'var(--heat-0)';
  if (occupancyPct < 15) return 'var(--heat-1)';
  if (occupancyPct < 30) return 'var(--heat-2)';
  if (occupancyPct < 60) return 'var(--heat-3)';
  if (occupancyPct < 80) return 'var(--heat-4)';
  return 'var(--heat-5)';
}

export function durationText(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return EM_DASH;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hoursPart = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hoursPart}h` : `${hoursPart}h ${rest}m`;
}

export function bytesText(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return EM_DASH;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit] ?? 'B'}`;
}
