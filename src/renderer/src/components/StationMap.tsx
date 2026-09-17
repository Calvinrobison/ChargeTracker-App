/**
 * The map: a React wrapper around Leaflet, ported from the design handoff's
 * `chargewatch-map.js` web component.
 *
 * Two deliberate changes from the prototype:
 *
 * 1. Leaflet is imported as a module and bundled, rather than read off
 *    `window.L`. The packaged build has no CDN dependency.
 *
 * 2. **Tooltips are built as DOM nodes, not HTML strings.** The prototype
 *    interpolated station names and networks straight into `innerHTML`. Those
 *    values come from a provider page and are untrusted input, so that is an
 *    injection hole. Marker styling is still inline HTML because it contains
 *    no external data at all.
 *
 * Everything else — the dark tile filter, the marker size and metric rules,
 * the study circle, the z-order, the blocked-tile detector and the
 * basemap-unavailable state — is carried over as specified.
 */

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import type { StationView } from '../../../shared/ipc.ts';
import type { MapMetric } from '../state.tsx';
import { STUDY_AREA_DEFAULTS } from '../../../domain/thresholds.ts';
import { milesToMeters } from '../../../domain/geo.ts';
import { EM_DASH, occupancyBandOf, pct } from '../format.ts';

const BAND_COLORS = {
  low: '#55B88C',
  moderate: '#E7B66A',
  high: '#D66C6C',
  unsupported: '#91A39B',
} as const;

const CENTER: [number, number] = [
  STUDY_AREA_DEFAULTS.centerLatitude,
  STUDY_AREA_DEFAULTS.centerLongitude,
];
const DEFAULT_ZOOM = 10;

/** A flat dark tile, used for a failed or blocked tile. */
const BLANK_TILE = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#0D1412"/></svg>',
)}`;

export interface StationMapHandle {
  zoomIn(): void;
  zoomOut(): void;
  resetView(): void;
  fitStations(): void;
  focus(id: string): void;
}

export interface StationMapProps {
  readonly stations: readonly StationView[];
  readonly metric: MapMetric;
  readonly selectedId: string | null;
  readonly showStudyCircle: boolean;
  readonly radiusMiles: number;
  readonly onSelect: (id: string) => void;
  readonly onBasemapUnavailable: (unavailable: boolean) => void;
  readonly handleRef: { current: StationMapHandle | null };
}

/** Marker geometry, following the handoff exactly. */
function markerSize(station: StationView, selected: boolean): number {
  if (selected) return 20;
  if (station.monitoring === 'catalog') return 9;
  return (station.ports ?? 0) >= 8 ? 15 : 12;
}

function buildIcon(station: StationView, metric: MapMetric, selected: boolean): L.DivIcon {
  const catalog = station.monitoring === 'catalog';
  const stale = station.monitoring === 'stale';
  const size = markerSize(station, selected);
  let inner: string;

  if (metric === 'current' && !catalog) {
    // A conic ring split by available/occupied/offline, so a multi-charger
    // site never collapses into one binary colour.
    const available = station.available ?? 0;
    const occupied = station.occupied ?? 0;
    const offline = station.offline ?? 0;
    const total = available + occupied + offline || 1;
    const availablePct = (available / total) * 100;
    const occupiedPct = (occupied / total) * 100;
    const ring = `conic-gradient(${BAND_COLORS.low} 0 ${availablePct}%, ${BAND_COLORS.moderate} ${availablePct}% ${availablePct + occupiedPct}%, ${BAND_COLORS.high} ${availablePct + occupiedPct}% 100%)`;
    inner = `<span class="cw-mk" style="width:${size + 6}px;height:${size + 6}px;background:${ring};padding:3px;box-shadow:${selected ? '0 0 0 3px rgba(134,224,186,.22)' : 'none'}"><span style="display:block;width:100%;height:100%;border-radius:50%;background:#101a17;border:1px solid #2B3B35"></span></span>`;
  } else if (metric === 'coverage' && !catalog) {
    const coverage = (station.coverage ?? 0) / 100;
    inner = `<span class="cw-mk" style="width:${size}px;height:${size}px;background:rgba(93,187,151,${(0.18 + 0.72 * coverage).toFixed(3)});border:1.5px solid ${selected ? '#86E0BA' : '#5DBB97'};box-shadow:${selected ? '0 0 0 5px rgba(134,224,186,.16)' : 'none'}"></span>`;
  } else {
    const band = catalog ? 'unsupported' : occupancyBandOf(station.occupancy);
    const color = selected ? '#86E0BA' : BAND_COLORS[band];
    // Catalog-only and insufficient-history markers are hollow with a dashed
    // border, so "no data" is visually distinct from "low occupancy".
    const hollow = catalog || band === 'unsupported';
    inner = `<span class="cw-mk" style="width:${size}px;height:${size}px;background:${hollow ? 'rgba(43,59,53,.55)' : color};border:${hollow ? '1.5px dashed #6f8279' : '1.5px solid rgba(13,20,18,.65)'};opacity:${stale ? 0.62 : 1};box-shadow:${selected ? '0 0 0 5px rgba(134,224,186,.18), 0 0 0 1.5px #86E0BA' : '0 1px 3px rgba(0,0,0,.5)'}"></span>`;
  }

  const box = selected ? 34 : 26;
  return L.divIcon({
    className: 'cw-mkwrap',
    html: `<span style="display:grid;place-items:center;width:${box}px;height:${box}px">${inner}</span>`,
    iconSize: [box, box],
    iconAnchor: [box / 2, box / 2],
  });
}

/**
 * Builds the hover tooltip as DOM nodes.
 *
 * Station names, networks and types come from a provider page. They are set
 * with `textContent` so a name containing markup is shown as text rather than
 * being parsed.
 */
function buildTooltip(station: StationView): HTMLElement {
  const root = document.createElement('div');

  const name = document.createElement('div');
  name.style.cssText = 'font-size:13px;font-weight:600';
  name.textContent = station.name;
  root.append(name);

  const meta = document.createElement('div');
  meta.style.cssText = 'font-size:11px;color:#91A39B;margin-top:3px';
  meta.textContent =
    [station.network, station.type].filter(Boolean).join(' · ') || 'Network unknown';
  root.append(meta);

  if (station.monitoring === 'catalog') {
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:8px;font-size:11px;color:#91A39B';
    note.textContent = 'Catalog only · not monitored';
    root.append(note);
    return root;
  }

  const monitored = document.createElement('div');
  monitored.style.cssText = 'font-size:11px;color:#91A39B;margin-top:3px';
  monitored.textContent =
    station.ports === null
      ? 'Monitored port count unknown'
      : `${station.ports} charger${station.ports === 1 ? '' : 's'} monitored`;
  root.append(monitored);

  const row = (label: string, value: string): void => {
    const line = document.createElement('div');
    line.style.cssText =
      'display:flex;justify-content:space-between;gap:18px;font-size:11.5px;margin-top:5px';
    const left = document.createElement('span');
    left.style.color = '#91A39B';
    left.textContent = label;
    const right = document.createElement('span');
    right.style.color = '#E8EFEB';
    right.textContent = value;
    line.append(left, right);
    root.append(line);
  };

  row(
    'Current',
    station.available === null && station.occupied === null
      ? 'No current status'
      : `${station.available ?? EM_DASH} available · ${station.occupied ?? EM_DASH} in use`,
  );
  row('Occupancy', station.occupancy === null ? 'Insufficient history' : pct(station.occupancy));
  row('Coverage', station.coverage === null ? EM_DASH : pct(station.coverage));

  const footer = document.createElement('div');
  footer.style.cssText =
    'font-size:10.5px;color:#6f8279;margin-top:8px;padding-top:7px;border-top:1px solid #2B3B35';
  footer.textContent = `${station.observed === null ? 'Never observed' : `Updated ${station.observed}`} · click for details`;
  root.append(footer);

  return root;
}

export function StationMap({
  stations,
  metric,
  selectedId,
  showStudyCircle,
  radiusMiles,
  onSelect,
  onBasemapUnavailable,
  handleRef,
}: StationMapProps): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const circleRef = useRef<L.Circle | null>(null);
  const placeLayerRef = useRef<L.LayerGroup | null>(null);
  const tileErrorsRef = useRef(0);
  const recentBlockedRef = useRef<boolean[]>([]);
  const offlineRef = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const stationsKey = useMemo(
    () =>
      stations
        .map(
          (station) =>
            `${station.id}:${station.lat}:${station.lng}:${station.occupancy ?? 'n'}:${station.coverage ?? 'n'}:${station.available ?? 'n'}:${station.occupied ?? 'n'}:${station.offline ?? 'n'}:${station.monitoring}:${station.ports ?? 'n'}`,
        )
        .join('|'),
    [stations],
  );

  // Create the map once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    const map = L.map(container, {
      center: CENTER,
      zoom: DEFAULT_ZOOM,
      zoomControl: false,
      attributionControl: true,
      zoomSnap: 0.5,
      wheelPxPerZoomLevel: 140,
      minZoom: 7,
      maxZoom: 17,
    });
    mapRef.current = map;

    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      // Attribution is required by the tile usage policy and must stay.
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
      crossOrigin: 'anonymous',
      errorTileUrl: BLANK_TILE,
    }).addTo(map);

    const markBasemapUnavailable = (): void => {
      if (offlineRef.current) return;
      offlineRef.current = true;
      container.classList.add('cw-nobasemap');
      onBasemapUnavailable(true);

      // Non-interactive city labels at real coordinates, so the map stays
      // geographically legible with no basemap.
      if (!placeLayerRef.current) {
        const places: Array<[string, number, number, boolean]> = [
          ['Phoenix', 33.4484, -112.074, true],
          ['Scottsdale', 33.4942, -111.9261, true],
          ['Mesa', 33.4152, -111.8315, true],
          ['Tempe', 33.4255, -111.94, false],
          ['Chandler', 33.3062, -111.8413, false],
          ['Gilbert', 33.3528, -111.789, false],
          ['Queen Creek', 33.2487, -111.6343, false],
          ['Apache Junction', 33.4151, -111.5496, false],
          ['Fountain Hills', 33.6117, -111.7174, false],
        ];
        const layer = L.layerGroup().addTo(map);
        for (const [label, lat, lng, major] of places) {
          const element = document.createElement('span');
          element.style.cssText = `font:${major ? '500 12px' : '400 10.5px'} var(--font-sans);color:${major ? '#E8EFEB' : '#91A39B'};opacity:${major ? 0.6 : 0.5};white-space:nowrap`;
          element.textContent = label;
          L.marker([lat, lng], {
            interactive: false,
            zIndexOffset: -500,
            icon: L.divIcon({
              className: 'cw-place',
              html: element.outerHTML,
              iconSize: [130, 16],
              iconAnchor: [65, 8],
            }),
          }).addTo(layer);
        }
        placeLayerRef.current = layer;
      }
    };

    tiles.on('tileerror', () => {
      tileErrorsRef.current += 1;
      if (tileErrorsRef.current >= 4) markBasemapUnavailable();
    });

    /**
     * The tile host serves its usage-policy block notice as a normal 200 PNG.
     * Genuine raster tiles are warm-tinted and contain essentially no pure
     * white; the notice is mostly white. A packaged Electron build with its own
     * User-Agent should not hit this, but the unavailable state is a real
     * offline condition either way, so the detector stays.
     */
    tiles.on('tileload', (event: L.LeafletEvent & { tile?: HTMLImageElement }) => {
      tileErrorsRef.current = 0;
      const image = event.tile;
      if (!image || !image.naturalWidth || image.dataset.cwChecked) return;
      image.dataset.cwChecked = '1';
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const context = canvas.getContext('2d');
        if (!context) return;
        context.drawImage(image, 0, 0, 32, 32);
        const pixels = context.getImageData(0, 0, 32, 32).data;
        let white = 0;
        let total = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if ((pixels[i] ?? 0) >= 250 && (pixels[i + 1] ?? 0) >= 250 && (pixels[i + 2] ?? 0) >= 250) {
            white += 1;
          }
          total += 1;
        }
        const blocked = total > 0 && white / total > 0.5;
        recentBlockedRef.current.push(blocked);
        if (recentBlockedRef.current.length > 12) recentBlockedRef.current.shift();
        if (blocked) {
          image.src = BLANK_TILE;
          const hits = recentBlockedRef.current.filter(Boolean).length;
          if (recentBlockedRef.current.length >= 6 && hits / recentBlockedRef.current.length > 0.6) {
            markBasemapUnavailable();
          }
        }
      } catch {
        // A tainted canvas means we cannot sample; leave the basemap alone.
      }
    });

    layerRef.current = L.layerGroup().addTo(map);

    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(container);
    const settle = window.setTimeout(() => map.invalidateSize(), 120);

    handleRef.current = {
      zoomIn: () => map.zoomIn(1),
      zoomOut: () => map.zoomOut(1),
      resetView: () => map.flyTo(CENTER, DEFAULT_ZOOM, { duration: 0.6 }),
      fitStations: () => {
        if (stations.length === 0) return;
        const bounds = L.latLngBounds(
          stations.map((station) => [station.lat, station.lng] as [number, number]),
        );
        map.flyToBounds(bounds, { padding: [90, 90], duration: 0.6, maxZoom: 13 });
      },
      focus: (id: string) => {
        const station = stations.find((candidate) => candidate.id === id);
        if (!station) return;
        map.flyTo([station.lat, station.lng], Math.max(map.getZoom(), 11.5), { duration: 0.6 });
      },
    };

    return () => {
      window.clearTimeout(settle);
      observer.disconnect();
      handleRef.current = null;
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      circleRef.current = null;
      placeLayerRef.current = null;
    };
    // The map is created once; markers and the circle are updated separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The study circle: a study region, never drawn as a driving radius.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!circleRef.current) {
      circleRef.current = L.circle(CENTER, {
        radius: milesToMeters(radiusMiles),
        color: '#3f5a50',
        weight: 1,
        dashArray: '3 6',
        fillColor: '#5DBB97',
        fillOpacity: 0.025,
        interactive: false,
      });
    } else {
      circleRef.current.setRadius(milesToMeters(radiusMiles));
    }
    if (showStudyCircle) circleRef.current.addTo(map);
    else circleRef.current.remove();
  }, [showStudyCircle, radiusMiles]);

  // Markers: rebuilt when the station set, metric or selection changes.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    for (const station of stations) {
      const selected = station.id === selectedId;
      const marker = L.marker([station.lat, station.lng], {
        icon: buildIcon(station, metric, selected),
        riseOnHover: true,
        // Selected above everything; catalog-only beneath monitored sites.
        zIndexOffset: selected ? 1000 : station.monitoring === 'catalog' ? -200 : 0,
        keyboard: true,
        alt: station.name,
      });
      marker.bindTooltip(buildTooltip(station), {
        className: 'cw-tt',
        direction: 'top',
        offset: [0, -14],
        opacity: 1,
      });
      marker.on('click', () => onSelectRef.current(station.id));
      marker.addTo(layer);
    }
    // stationsKey captures the fields that affect rendering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationsKey, metric, selectedId]);

  // Selecting from the list or the Overview table flies the map to the station,
  // so map and list selection never diverge.
  useEffect(() => {
    if (selectedId === null) return;
    handleRef.current?.focus(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  return <div ref={containerRef} className="map-surface cw-map" />;
}
