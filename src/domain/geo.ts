/**
 * Straight-line geography for the study area.
 *
 * The 50-mile radius is a STUDY REGION measured as a straight line from the
 * configured centre. It is not a driving distance and must never be drawn or
 * described as one.
 */

export const EARTH_RADIUS_MILES = 3958.7613;
export const EARTH_RADIUS_KM = 6371.0088;

export interface Coordinate {
  readonly latitude: number;
  readonly longitude: number;
}

export function isValidCoordinate(value: unknown): value is Coordinate {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<Coordinate>;
  return (
    typeof c.latitude === 'number' &&
    Number.isFinite(c.latitude) &&
    c.latitude >= -90 &&
    c.latitude <= 90 &&
    typeof c.longitude === 'number' &&
    Number.isFinite(c.longitude) &&
    c.longitude >= -180 &&
    c.longitude <= 180
  );
}

export function assertValidCoordinate(value: unknown, label = 'coordinate'): Coordinate {
  if (!isValidCoordinate(value)) {
    throw new RangeError(`${label} is not a valid latitude/longitude pair: ${JSON.stringify(value)}`);
  }
  return value;
}

const DEG_TO_RAD = Math.PI / 180;

/** Great-circle distance in statute miles. */
export function distanceMiles(a: Coordinate, b: Coordinate): number {
  assertValidCoordinate(a, 'from');
  assertValidCoordinate(b, 'to');
  const lat1 = a.latitude * DEG_TO_RAD;
  const lat2 = b.latitude * DEG_TO_RAD;
  const dLat = lat2 - lat1;
  const dLon = (b.longitude - a.longitude) * DEG_TO_RAD;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function milesToMeters(miles: number): number {
  return miles * 1609.344;
}

/**
 * Inclusive radius test.
 *
 * A station exactly on the boundary is inside the study area; the comparison
 * is documented so a catalog refresh cannot silently change membership.
 */
export function withinRadius(
  center: Coordinate,
  point: Coordinate,
  radiusMiles: number,
): boolean {
  if (!Number.isFinite(radiusMiles) || radiusMiles <= 0) return false;
  return distanceMiles(center, point) <= radiusMiles;
}

/** Filters a catalog to the study area, returning the distance for each row. */
export function filterToRadius<T extends { readonly coordinate: Coordinate }>(
  rows: readonly T[],
  center: Coordinate,
  radiusMiles: number,
): Array<T & { readonly distanceMiles: number }> {
  const out: Array<T & { distanceMiles: number }> = [];
  for (const row of rows) {
    if (!isValidCoordinate(row.coordinate)) continue;
    const d = distanceMiles(center, row.coordinate);
    if (d <= radiusMiles) out.push({ ...row, distanceMiles: d });
  }
  out.sort((a, b) => a.distanceMiles - b.distanceMiles);
  return out;
}
