#!/usr/bin/env node
/**
 * Builds the bundled Mesa-area station catalog from an AFDC station export.
 *
 * Deliberately takes a LOCAL FILE by default rather than a hardcoded download
 * URL. Hardcoding an API hostname is exactly the failure the handoff warns
 * about: endpoints move, and the AFDC API needs a developer key that must not
 * be shipped. So the maintainer downloads the file once from
 * https://afdc.energy.gov/data_download and points this script at it. A
 * `--url` option exists for a CI job that has its own configured, currently
 * valid source.
 *
 * What it produces:
 *   resources/catalog/mesa-stations.json   the filtered snapshot
 *   resources/catalog/provenance.json      retrieval date, origin, licence,
 *                                          attribution, file hash, field
 *                                          mapping and bounds
 *
 * The seed is repeatable and incremental: re-running it produces the same
 * output for the same input, and importing it never erases observations or
 * overwrites a user correction (see DatabaseWorker.upsertFromCatalog).
 *
 * Usage:
 *   node scripts/catalog-refresh.mjs --file alt_fuel_stations.csv
 *   node scripts/catalog-refresh.mjs --url https://... --source-name "AFDC export"
 *   node scripts/catalog-refresh.mjs --file x.csv --radius 50 --dry-run
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
/**
 * Where the catalog is written.
 *
 * `--out` exists so this script can be run against a scratch directory --
 * by its specs, and by a maintainer who wants to inspect the result before it
 * goes anywhere near the repository. Without it, every trial run overwrites the
 * shipped catalog, and a test run would put synthetic stations exactly where
 * real ones belong. That is not hypothetical: it happened while writing the
 * specs for this script.
 */
const outDir = resolveOutDir();

function resolveOutDir() {
  const index = process.argv.indexOf('--out');
  const supplied = index === -1 ? null : process.argv[index + 1];
  return supplied ? resolve(process.cwd(), supplied) : join(root, 'resources', 'catalog');
}

const CENTER = { latitude: 33.4152, longitude: -111.8315 };
const EARTH_RADIUS_MILES = 3958.7613;

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}
const flag = (name) => process.argv.includes(`--${name}`);

const file = arg('file');
const url = arg('url');
const radiusMiles = Number(arg('radius', '50'));
const dryRun = flag('dry-run');

if (!file && !url) {
  console.error(
    'Point this at an AFDC station export.\n\n' +
      '  1. Open https://afdc.energy.gov/data_download\n' +
      '  2. Download the alternative fuel station data as CSV (all fuel types is fine;\n' +
      '     this script filters to public electric stations itself)\n' +
      '  3. Run:  npm run catalog:refresh -- --file path\\to\\alt_fuel_stations.csv\n\n' +
      'No URL is hardcoded on purpose: the endpoint changes, and the AFDC API needs a\n' +
      'developer key that must never be shipped in the application.',
  );
  process.exit(1);
}
if (!Number.isFinite(radiusMiles) || radiusMiles <= 0) {
  console.error(`--radius must be a positive number of miles; received ${String(radiusMiles)}`);
  process.exit(1);
}

/** Great-circle distance in statute miles; mirrors src/domain/geo.ts. */
function distanceMiles(a, b) {
  const toRad = Math.PI / 180;
  const lat1 = a.latitude * toRad;
  const lat2 = b.latitude * toRad;
  const dLat = lat2 - lat1;
  const dLon = (b.longitude - a.longitude) * toRad;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Minimal RFC 4180 CSV parser, matching src/shared/csv-read.ts's behaviour. */
function parseCsv(text) {
  const clean = text.startsWith('﻿') ? text.slice(1) : text;
  const rows = [];
  let cells = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i];
    if (inQuotes) {
      if (char === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field.length === 0) {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      cells.push(field);
      field = '';
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      cells.push(field);
      if (cells.some((cell) => cell.length > 0)) rows.push(cells);
      cells = [];
      field = '';
      continue;
    }
    field += char;
  }
  if (field.length > 0 || cells.length > 0) {
    cells.push(field);
    if (cells.some((cell) => cell.length > 0)) rows.push(cells);
  }
  return rows;
}

/**
 * AFDC column names mapped to our fields.
 *
 * Recorded in provenance.json so a future reader can tell exactly how the
 * source's columns became our records.
 */
const FIELD_MAPPING = {
  'Station Name': 'name',
  'Street Address': 'streetAddress',
  City: 'city',
  State: 'state',
  ZIP: 'postalCode',
  Latitude: 'latitude',
  Longitude: 'longitude',
  'EV Network': 'network',
  'Access Code': 'accessCondition',
  'Access Days Time': 'hoursText',
  'EV Level1 EVSE Num': 'level1Ports',
  'EV Level2 EVSE Num': 'level2Ports',
  'EV DC Fast Count': 'dcFastPorts',
  'EV Connector Types': 'connectorTypes',
  ID: 'registryStationId',
  'Fuel Type Code': 'fuelTypeCode',
  'Status Code': 'statusCode',
};

function column(headers, name) {
  const index = headers.findIndex((header) => header.trim().toLowerCase() === name.toLowerCase());
  return index;
}

async function loadSource() {
  if (file) {
    const path = resolve(process.cwd(), file);
    const text = readFileSync(path, 'utf8');
    return { text, origin: path, retrievedAtMs: Date.now(), via: 'local file' };
  }
  console.log(`Fetching ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    console.error(`The source returned HTTP ${response.status}. Nothing was written.`);
    process.exit(1);
  }
  return {
    text: await response.text(),
    origin: url,
    retrievedAtMs: Date.now(),
    via: 'download',
  };
}

const source = await loadSource();
const sha256 = createHash('sha256').update(source.text, 'utf8').digest('hex');
const rows = parseCsv(source.text);

if (rows.length < 2) {
  console.error('The file has no data rows. Nothing was written.');
  process.exit(1);
}

const headers = rows[0];
const indices = {};
for (const [sourceName, ourName] of Object.entries(FIELD_MAPPING)) {
  indices[ourName] = column(headers, sourceName);
}

const required = ['name', 'latitude', 'longitude'];
const missing = required.filter((name) => indices[name] === -1);
if (missing.length > 0) {
  console.error(
    `This file is missing required column(s): ${missing.join(', ')}.\n` +
      `Found headers: ${headers.slice(0, 20).join(', ')}${headers.length > 20 ? ' …' : ''}\n\n` +
      'Field definitions: https://afdc.energy.gov/data_download/alt_fuel_stations_format',
  );
  process.exit(1);
}

const cell = (row, name) => {
  const index = indices[name];
  return index === -1 || index === undefined ? '' : (row[index] ?? '').trim();
};
const intOrNull = (value) => {
  if (value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

const ACCESS_MAP = { public: 'public', private: 'private' };

let considered = 0;
let skippedNonElectric = 0;
let skippedNonPublic = 0;
let skippedBadCoordinates = 0;
let skippedOutOfRadius = 0;
const sites = [];

for (const row of rows.slice(1)) {
  considered += 1;

  const fuel = cell(row, 'fuelTypeCode').toUpperCase();
  if (indices.fuelTypeCode !== -1 && fuel !== '' && fuel !== 'ELEC') {
    skippedNonElectric += 1;
    continue;
  }

  const access = cell(row, 'accessCondition').toLowerCase();
  if (access !== '' && access !== 'public') {
    skippedNonPublic += 1;
    continue;
  }

  const latitudeText = cell(row, 'latitude');
  const longitudeText = cell(row, 'longitude');
  // An empty cell must not become 0: Number('') is 0, and 0,0 is a real place
  // in the Gulf of Guinea. A missing coordinate is missing, not the equator.
  if (latitudeText === '' || longitudeText === '') {
    skippedBadCoordinates += 1;
    continue;
  }
  const latitude = Number(latitudeText);
  const longitude = Number(longitudeText);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    skippedBadCoordinates += 1;
    continue;
  }

  const distance = distanceMiles(CENTER, { latitude, longitude });
  if (distance > radiusMiles) {
    skippedOutOfRadius += 1;
    continue;
  }

  const level1 = intOrNull(cell(row, 'level1Ports'));
  const level2 = intOrNull(cell(row, 'level2Ports'));
  const dcFast = intOrNull(cell(row, 'dcFastPorts'));
  const portTotal =
    level1 === null && level2 === null && dcFast === null
      ? null
      : (level1 ?? 0) + (level2 ?? 0) + (dcFast ?? 0);

  // The charging class is only stated when the data actually supports one.
  // A station with both Level 2 and DC fast ports is `mixed`, never guessed.
  let catalogLevel = 'unknown';
  const classes = [
    level1 !== null && level1 > 0 ? 'level_1' : null,
    level2 !== null && level2 > 0 ? 'level_2' : null,
    dcFast !== null && dcFast > 0 ? 'dc_fast' : null,
  ].filter(Boolean);
  if (classes.length === 1) catalogLevel = classes[0];
  else if (classes.length > 1) catalogLevel = 'mixed';

  const registryStationId = cell(row, 'registryStationId') || null;
  const streetAddress = cell(row, 'streetAddress') || null;
  const city = cell(row, 'city') || null;

  const normalizedAddress = [streetAddress, city, cell(row, 'state')]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  sites.push({
    // A stable id derived from the registry id where one exists, so a refresh
    // matches existing rows instead of creating duplicates.
    id: registryStationId
      ? `afdc-${registryStationId}`
      : `afdc-geo-${latitude.toFixed(5)}-${longitude.toFixed(5)}`,
    registryStationId,
    name: cell(row, 'name') || 'Unnamed station',
    streetAddress,
    city,
    state: cell(row, 'state') || null,
    postalCode: cell(row, 'postalCode') || null,
    normalizedAddress: normalizedAddress === '' ? null : normalizedAddress,
    latitude,
    longitude,
    distanceMiles: Number(distance.toFixed(4)),
    network: cell(row, 'network') || null,
    accessCondition: ACCESS_MAP[access] ?? 'unknown',
    hoursText: cell(row, 'hoursText') || null,
    timezone: 'America/Phoenix',
    catalogPortCount: portTotal,
    catalogLevel,
    connectorTypes: cell(row, 'connectorTypes') || null,
  });
}

// Deterministic order, so re-running produces an identical file.
sites.sort((a, b) => a.id.localeCompare(b.id));

const duplicates = sites.length - new Set(sites.map((site) => site.id)).size;

const provenance = {
  formatVersion: 1,
  sourceName: arg('source-name', 'AFDC alternative fuel stations'),
  sourceUrl: 'https://afdc.energy.gov/data_download',
  fieldDefinitionsUrl: 'https://afdc.energy.gov/data_download/alt_fuel_stations_format',
  origin: source.origin,
  retrievedAtMs: source.retrievedAtMs,
  retrievedAtIso: new Date(source.retrievedAtMs).toISOString(),
  retrievedVia: source.via,
  fileSha256: sha256,
  license: 'U.S. Department of Energy AFDC data, reusable with attribution',
  attribution: 'U.S. Department of Energy, Alternative Fuels Data Center',
  fieldMapping: FIELD_MAPPING,
  bounds: {
    centerLatitude: CENTER.latitude,
    centerLongitude: CENTER.longitude,
    radiusMiles,
    measurement: 'great-circle straight-line distance, inclusive of the boundary',
  },
  counts: {
    rowsConsidered: considered,
    accepted: sites.length,
    skippedNonElectric,
    skippedNonPublic,
    skippedBadCoordinates,
    skippedOutOfRadius,
    duplicateIds: duplicates,
  },
  note:
    'A station appearing in this catalog says nothing about its present occupancy, and nothing ' +
    'about whether ChargeWatch can observe it. Those are separate facts recorded separately.',
};

console.log('\nCatalog refresh\n');
console.log(`  rows considered        ${considered}`);
console.log(`  accepted in radius     ${sites.length}`);
console.log(`  skipped, non-electric  ${skippedNonElectric}`);
console.log(`  skipped, non-public    ${skippedNonPublic}`);
console.log(`  skipped, bad coords    ${skippedBadCoordinates}`);
console.log(`  skipped, out of radius ${skippedOutOfRadius}`);
console.log(`  duplicate ids          ${duplicates}`);
console.log(`  file sha256            ${sha256}`);

if (sites.length === 0) {
  console.error(
    '\nNo stations fell inside the radius. Nothing was written — an empty catalog would be worse ' +
      'than none, because it looks like a finished import.',
  );
  process.exit(1);
}
if (duplicates > 0) {
  console.error(
    `\n${duplicates} duplicate station id(s) found. Nothing was written: importing duplicates would ` +
      'create two records for one physical site.',
  );
  process.exit(1);
}

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, 'mesa-stations.json'),
  `${JSON.stringify({ formatVersion: 1, sites }, null, 2)}\n`,
  'utf8',
);
writeFileSync(join(outDir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');

console.log(`\nWrote ${sites.length} stations to ${join(outDir, 'mesa-stations.json')}`);
console.log(`Wrote ${join(outDir, 'provenance.json')}`);
console.log('\nReview both, then commit them. The app records this provenance with every import.');
