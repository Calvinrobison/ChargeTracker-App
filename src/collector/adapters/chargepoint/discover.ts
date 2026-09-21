/**
 * ChargePoint station discovery: which of the provider's stations are in the
 * study area, so they can be linked to catalog sites.
 *
 * The catalog comes from the AFDC export, which carries no ChargePoint
 * station ids, so without this step every link would have to be pasted in by
 * hand. Discovery reads the provider's own station list for the study area —
 * the same list the driver map page loads to draw its markers and side panel,
 * requested from inside that page in the bundled browser, with the page's
 * own origin and headers. It is a linking step, not collection: nothing it
 * returns is recorded as an observation. Observations only ever come from a
 * station page read by the adapter in `index.ts`.
 *
 * Bounded by design: at most `maxPages` list pages (50 stations each), paced
 * `pacingMs` apart, behind one top-level navigation that spends the ordinary
 * source budget. It is run when the user asks, not on a schedule.
 */

import type { BrowserRuntime } from '../../browser.ts';
import { distanceMiles } from '../../../domain/geo.ts';
import { stationUrl } from './index.ts';

/** The map page the list belongs to. Navigated to before any list request. */
export function mapPageUrl(centerLatitude: number, centerLongitude: number): string {
  return `https://driver.chargepoint.com/mapCenter/${centerLatitude.toFixed(4)}/${centerLongitude.toFixed(4)}/11`;
}

export interface DiscoveryArea {
  readonly centerLatitude: number;
  readonly centerLongitude: number;
  readonly radiusMiles: number;
}

export interface DiscoveredStation {
  readonly sourceStationId: string;
  readonly name: string;
  readonly streetAddress: string | null;
  readonly city: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly portCount: number | null;
  /** The provider's display level, "AC" or "DC Fast", as written. */
  readonly displayLevel: string | null;
  readonly network: string | null;
  readonly canonicalUrl: string;
  readonly distanceMiles: number;
}

export interface DiscoveryReport {
  readonly stations: readonly DiscoveredStation[];
  readonly pagesRead: number;
  /** True when the page cap was hit before the list ended. */
  readonly truncated: boolean;
  readonly startedMs: number;
  readonly finishedMs: number;
  readonly warnings: readonly string[];
}

export interface DiscoveryOptions {
  readonly runtime: BrowserRuntime;
  readonly acquireNavigationSlot: () => Promise<void>;
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  readonly abortSignal: AbortSignal;
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxPages?: number;
  readonly pacingMs?: number;
  readonly onProgress?: (progress: { pagesRead: number; stationsSoFar: number }) => void;
}

const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 40;
const DEFAULT_PACING_MS = 3_000;

/** Miles per degree of latitude, and per degree of longitude at a latitude. */
const MILES_PER_DEGREE_LAT = 69.0;
function milesPerDegreeLon(latitude: number): number {
  return MILES_PER_DEGREE_LAT * Math.cos((latitude * Math.PI) / 180);
}

/** The bounding box that contains the study circle. */
export function boundingBox(area: DiscoveryArea): {
  ne_lat: number;
  ne_lon: number;
  sw_lat: number;
  sw_lon: number;
} {
  const dLat = area.radiusMiles / MILES_PER_DEGREE_LAT;
  const dLon = area.radiusMiles / milesPerDegreeLon(area.centerLatitude);
  return {
    ne_lat: area.centerLatitude + dLat,
    ne_lon: area.centerLongitude + dLon,
    sw_lat: area.centerLatitude - dLat,
    sw_lon: area.centerLongitude - dLon,
  };
}

/**
 * The list request, exactly as the map page issues it, with our box and page.
 * Every filter is off so the list is the provider's whole set for the box.
 */
export function stationListRequest(
  area: DiscoveryArea,
  pageOffset: string,
): Record<string, unknown> {
  return {
    station_list: {
      screen_width: 1280,
      screen_height: 900,
      ...boundingBox(area),
      page_size: PAGE_SIZE,
      page_offset: pageOffset,
      sort_by: 'distance',
      reference_lat: area.centerLatitude,
      reference_lon: area.centerLongitude,
      include_map_bound: true,
      filter: {
        price_free: false,
        status_available: false,
        dc_fast_charging: false,
        disabled_parking: false,
        van_accessible: false,
        network_chargepoint: false,
        network_mercedes: false,
        connector_l1: false,
        connector_l2: false,
        connector_l2_nema_1450: false,
        connector_l2_tesla: false,
        connector_chademo: false,
        connector_combo: false,
        connector_tesla: false,
      },
      bound_output: true,
    },
  };
}

/** The endpoint the map page reads its list from. Requested from inside the page. */
export const STATION_LIST_ENDPOINT = 'https://mc.chargepoint.com/map-prod/v2';

/**
 * Builds the in-page script for one list page. Runs in the map page with no
 * Node bridge; returns plain data or a `{ error }` object.
 */
export function listPageScript(request: Record<string, unknown>): string {
  // The page passes the request as raw JSON in the query string and lets the
  // browser percent-encode it; doing the same keeps the request identical.
  const url = `${STATION_LIST_ENDPOINT}?${JSON.stringify(request)}`;
  return `(async () => {
    try {
      const response = await fetch(${JSON.stringify(url)}, { credentials: 'omit' });
      if (!response.ok) return { error: 'HTTP ' + response.status, status: response.status };
      const body = await response.json();
      const list = body && body.station_list;
      if (!list || !Array.isArray(list.stations)) return { error: 'no station_list in the response' };
      return {
        pageOffset: typeof list.page_offset === 'string' ? list.page_offset : null,
        stations: list.stations.map((s) => ({
          deviceId: s.device_id,
          name1: s.name1,
          name2: s.name2,
          address1: s.address1,
          city: s.city,
          lat: s.lat,
          lon: s.lon,
          totalPortCount: s.total_port_count,
          displayLevel: s.display_level,
          network: s.network_display_name,
        })),
      };
    } catch (error) {
      return { error: error && error.message ? error.message : String(error) };
    }
  })()`;
}

interface RawListPage {
  error?: string;
  status?: number;
  pageOffset?: string | null;
  stations?: Array<{
    deviceId: unknown;
    name1: unknown;
    name2: unknown;
    address1: unknown;
    city: unknown;
    lat: unknown;
    lon: unknown;
    totalPortCount: unknown;
    displayLevel: unknown;
    network: unknown;
  }>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Turns one raw list entry into a discovered station, or null when it lacks
 * the identity or position a binding needs. Nothing is guessed: an entry
 * with no coordinates cannot be matched and is dropped with a warning.
 */
export function toDiscoveredStation(
  raw: NonNullable<RawListPage['stations']>[number],
  area: DiscoveryArea,
): { station: DiscoveredStation | null; warning: string | null } {
  const id = raw.deviceId;
  const sourceStationId =
    typeof id === 'number' && Number.isSafeInteger(id) && id > 0
      ? String(id)
      : typeof id === 'string' && /^\d{1,12}$/.test(id)
        ? id
        : null;
  if (!sourceStationId) return { station: null, warning: 'a list entry had no station id' };

  const latitude = finite(raw.lat);
  const longitude = finite(raw.lon);
  if (latitude === null || longitude === null) {
    return { station: null, warning: `station ${sourceStationId} had no coordinates` };
  }
  const name = [text(raw.name1), text(raw.name2)].filter(Boolean).join(' ');
  if (name.length === 0) {
    return { station: null, warning: `station ${sourceStationId} had no name` };
  }
  const distance = distanceMiles(
    { latitude: area.centerLatitude, longitude: area.centerLongitude },
    { latitude, longitude },
  );
  const ports = finite(raw.totalPortCount);
  return {
    station: {
      sourceStationId,
      name,
      streetAddress: text(raw.address1),
      city: text(raw.city),
      latitude,
      longitude,
      portCount: ports !== null && ports >= 0 ? Math.round(ports) : null,
      displayLevel: text(raw.displayLevel),
      network: text(raw.network),
      canonicalUrl: stationUrl(sourceStationId),
      distanceMiles: distance,
    },
    warning: null,
  };
}

/**
 * Reads the provider's station list for the study area.
 *
 * One top-level navigation to the map page (spending the source budget), then
 * paced list requests from inside it until the provider says `last_page`, the
 * page cap is reached, or the caller aborts. Entries outside the study radius
 * are dropped — the box is larger than the circle — and duplicates across
 * pages are collapsed by station id.
 */
export async function discoverStations(
  area: DiscoveryArea,
  options: DiscoveryOptions,
): Promise<DiscoveryReport> {
  const nowMs = options.nowMs ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }));
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const pacingMs = options.pacingMs ?? DEFAULT_PACING_MS;
  const startedMs = nowMs();
  const warnings: string[] = [];
  const stations = new Map<string, DiscoveredStation>();
  let pagesRead = 0;
  let truncated = false;

  await options.acquireNavigationSlot();
  const page = await options.runtime.acquirePage();
  const navigation = await options.runtime.navigate(
    page,
    mapPageUrl(area.centerLatitude, area.centerLongitude),
    options.abortSignal,
  );
  if (!navigation.ok) {
    throw new Error(
      `the ChargePoint map page could not be opened: ${navigation.detail ?? 'unknown'}`,
    );
  }

  let pageOffset = '';
  let dropped = 0;
  let outside = 0;
  for (;;) {
    if (options.abortSignal.aborted) {
      warnings.push('discovery was cancelled before the list ended');
      truncated = true;
      break;
    }
    if (pagesRead >= maxPages) {
      warnings.push(`stopped after ${maxPages} list pages; the provider list was longer`);
      truncated = true;
      break;
    }
    if (pagesRead > 0) await sleep(pacingMs);

    // `evaluate` infers `unknown` for a string script, so the assertion is
    // what gives `raw` a shape; eslint reads it as redundant because the
    // assertion is itself what it infers the call's type from, and removing
    // it fails typecheck — the same trade-off as in index.ts.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const raw = (await page.evaluate(
      listPageScript(stationListRequest(area, pageOffset)),
    )) as RawListPage;
    pagesRead += 1;

    if (raw.error) {
      throw new Error(`the station list request failed on page ${pagesRead}: ${raw.error}`);
    }
    for (const entry of raw.stations ?? []) {
      const { station, warning } = toDiscoveredStation(entry, area);
      if (!station) {
        dropped += 1;
        if (warning && warnings.length < 20) warnings.push(warning);
        continue;
      }
      if (station.distanceMiles > area.radiusMiles) {
        outside += 1;
        continue;
      }
      if (!stations.has(station.sourceStationId)) stations.set(station.sourceStationId, station);
    }
    options.onProgress?.({ pagesRead, stationsSoFar: stations.size });
    options.log('debug', `discovery page ${pagesRead}: ${stations.size} stations so far`);

    const next = raw.pageOffset ?? null;
    if (!next || next === 'last_page' || (raw.stations ?? []).length === 0) break;
    pageOffset = next;
  }

  if (dropped > 0) warnings.push(`${dropped} list entries were unusable and dropped`);
  if (outside > 0) {
    options.log(
      'info',
      `${outside} stations in the provider box were outside the ${area.radiusMiles} mile radius`,
    );
  }

  return {
    stations: [...stations.values()].sort((a, b) => a.distanceMiles - b.distanceMiles),
    pagesRead,
    truncated,
    startedMs,
    finishedMs: nowMs(),
    warnings,
  };
}
