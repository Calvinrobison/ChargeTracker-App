/**
 * The catalog seed, end to end.
 *
 * `scripts/catalog-refresh.mjs` is the only way a station catalog gets into
 * ChargeWatch, and until now it had never been run against anything. It sat on
 * the critical path to the application doing something at all, with no evidence
 * behind it beyond a reading of the AFDC field documentation.
 *
 * These specs run the real script as a subprocess against CSV fixtures, so what
 * is exercised is the shipped script rather than a reimplementation of it.
 *
 * ⚠ EVERY ROW IN THESE FIXTURES IS SYNTHETIC. The station names are obviously
 * fictional and the coordinates are chosen to sit at known distances from the
 * study centre. Nothing here is a claim that any of these chargers exist. The
 * column NAMES are the real AFDC ones — that is the thing under test.
 *
 * What is deliberately NOT established: that a genuine AFDC export parses. Only
 * a real file can show that, and the build environment cannot reach
 * `afdc.energy.gov`. These specs prove the mapping, the filters and the refusals
 * behave as documented against the documented format.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'catalog-refresh.mjs');

/** The AFDC columns the script maps, in a plausible order. */
const HEADERS = [
  'Fuel Type Code',
  'Station Name',
  'Street Address',
  'City',
  'State',
  'ZIP',
  'Status Code',
  'Access Code',
  'Access Days Time',
  'EV Level1 EVSE Num',
  'EV Level2 EVSE Num',
  'EV DC Fast Count',
  'EV Network',
  'EV Connector Types',
  'Latitude',
  'Longitude',
  'ID',
];

interface Row {
  readonly [column: string]: string;
}

function csv(rows: readonly Row[], headers: readonly string[] = HEADERS): string {
  const quote = (value: string) =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => quote(row[header] ?? '')).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** A public electric station in Mesa, roughly 1 mile from the study centre. */
function station(overrides: Row = {}): Row {
  return {
    'Fuel Type Code': 'ELEC',
    'Station Name': 'Fixture Station',
    'Street Address': '1 Test Way',
    City: 'Mesa',
    State: 'AZ',
    ZIP: '85201',
    'Status Code': 'E',
    'Access Code': 'public',
    'Access Days Time': '24 hours daily',
    'EV Level1 EVSE Num': '',
    'EV Level2 EVSE Num': '4',
    'EV DC Fast Count': '',
    'EV Network': 'FixtureNet',
    'EV Connector Types': 'J1772',
    Latitude: '33.4250',
    Longitude: '-111.8315',
    ID: '100001',
    ...overrides,
  };
}

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly dir: string;
}

async function runRefresh(
  rows: readonly Row[],
  extra: string[] = [],
  headers = HEADERS,
): Promise<RunResult> {
  const dir = await mkdtemp(join(tmpdir(), 'cw-catalog-'));
  const csvPath = join(dir, 'alt_fuel_stations.csv');
  await writeFile(csvPath, csv(rows, headers), 'utf8');
  const result = spawnSync(process.execPath, [SCRIPT, '--file', csvPath, '--out', dir, ...extra], {
    encoding: 'utf8',
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    dir,
  };
}

async function readCatalog(dir: string): Promise<{ sites: Array<Record<string, unknown>> }> {
  return JSON.parse(await readFile(join(dir, 'mesa-stations.json'), 'utf8')) as {
    sites: Array<Record<string, unknown>>;
  };
}

// ---------------------------------------------------------------------------

describe('the catalog seed refuses a file it cannot understand', () => {
  it('names the missing columns and the headers it did find', async () => {
    const { status, stderr, dir } = await runRefresh([{ Foo: 'bar' }], [], ['Foo', 'Bar']);
    try {
      assert.notEqual(status, 0, 'a file without the required columns must not succeed');
      assert.match(stderr, /missing required column/i);
      assert.match(stderr, /name/);
      // Reporting what it DID find is what turns this from a dead end into a
      // fixable problem.
      assert.match(stderr, /Foo/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a file with no data rows rather than writing an empty catalog', async () => {
    const { status, stderr, dir } = await runRefresh([]);
    try {
      assert.notEqual(status, 0);
      assert.match(stderr, /no data rows/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the catalog seed maps AFDC columns as documented', () => {
  it('carries every field through to the output record', async () => {
    const { status, dir } = await runRefresh([station()]);
    try {
      assert.equal(status, 0);
      const { sites } = await readCatalog(dir);
      assert.equal(sites.length, 1);
      const site = sites[0] as Record<string, unknown>;

      assert.equal(
        site.id,
        'afdc-100001',
        'the registry id anchors a stable identity across refreshes',
      );
      assert.equal(site.registryStationId, '100001');
      assert.equal(site.name, 'Fixture Station');
      assert.equal(site.streetAddress, '1 Test Way');
      assert.equal(site.city, 'Mesa');
      assert.equal(site.state, 'AZ');
      assert.equal(site.postalCode, '85201');
      assert.equal(site.network, 'FixtureNet');
      assert.equal(site.accessCondition, 'public');
      assert.equal(site.hoursText, '24 hours daily');
      assert.equal(site.timezone, 'America/Phoenix');
      assert.equal(site.catalogPortCount, 4);
      assert.equal(site.catalogLevel, 'level_2');
      assert.equal(site.connectorTypes, 'J1772');
      assert.ok(typeof site.distanceMiles === 'number' && site.distanceMiles < 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('classifies the charging level only when the counts support one', async () => {
    const { status, dir } = await runRefresh([
      station({ ID: '1', 'EV Level2 EVSE Num': '4', 'EV DC Fast Count': '' }),
      station({ ID: '2', 'EV Level2 EVSE Num': '', 'EV DC Fast Count': '2' }),
      station({ ID: '3', 'EV Level2 EVSE Num': '4', 'EV DC Fast Count': '2' }),
      station({ ID: '4', 'EV Level2 EVSE Num': '', 'EV DC Fast Count': '' }),
      station({ ID: '5', 'EV Level1 EVSE Num': '1', 'EV Level2 EVSE Num': '' }),
    ]);
    try {
      assert.equal(status, 0);
      const { sites } = await readCatalog(dir);
      const byId = new Map(sites.map((s) => [s.registryStationId, s]));
      assert.equal(byId.get('1')?.catalogLevel, 'level_2');
      assert.equal(byId.get('2')?.catalogLevel, 'dc_fast');
      assert.equal(
        byId.get('3')?.catalogLevel,
        'mixed',
        'both kinds present is mixed, never a guess',
      );
      assert.equal(byId.get('5')?.catalogLevel, 'level_1');

      // No port counts at all means the level is unknown and the count is null
      // -- not zero, which would claim the station has no ports.
      assert.equal(byId.get('4')?.catalogLevel, 'unknown');
      assert.equal(byId.get('4')?.catalogPortCount, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never turns a blank coordinate into the equator', async () => {
    // Number('') is 0, and 0,0 is a real place in the Gulf of Guinea. A station
    // with no coordinate must be dropped, not placed in the Atlantic.
    const { status, stdout, dir } = await runRefresh([
      station({ ID: '1', Latitude: '', Longitude: '-111.8' }),
      station({ ID: '2', Latitude: '33.42', Longitude: '' }),
      station({ ID: '3', Latitude: 'not-a-number', Longitude: '-111.8' }),
      station({ ID: '4', Latitude: '95.0', Longitude: '-111.8' }),
      station({ ID: '5' }),
    ]);
    try {
      assert.equal(status, 0);
      const { sites } = await readCatalog(dir);
      assert.equal(
        sites.length,
        1,
        `only the valid row should survive; got ${JSON.stringify(sites.map((s) => s.registryStationId))}`,
      );
      assert.equal(sites[0]?.registryStationId, '5');
      assert.match(
        stdout,
        /skipped, bad coords\s+4/,
        'the run must report what it dropped, and how many',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the catalog seed applies the study area and access filters', () => {
  it('drops stations outside the radius', async () => {
    const { status, dir } = await runRefresh([
      station({ ID: 'near', Latitude: '33.4250', Longitude: '-111.8315' }),
      // Flagstaff, ~120 miles north.
      station({ ID: 'far', Latitude: '35.1983', Longitude: '-111.6513' }),
    ]);
    try {
      assert.equal(status, 0);
      const { sites } = await readCatalog(dir);
      assert.deepEqual(
        sites.map((s) => s.registryStationId),
        ['near'],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('honours an explicit radius', async () => {
    const { status, dir } = await runRefresh(
      [
        station({ ID: 'close', Latitude: '33.4250', Longitude: '-111.8315' }),
        // ~35 miles away: inside 50, outside 10.
        station({ ID: 'medium', Latitude: '33.9000', Longitude: '-111.8315' }),
      ],
      ['--radius', '10'],
    );
    try {
      assert.equal(status, 0);
      const { sites } = await readCatalog(dir);
      assert.deepEqual(
        sites.map((s) => s.registryStationId),
        ['close'],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps only public electric stations', async () => {
    const { status, dir } = await runRefresh([
      station({ ID: 'keep' }),
      station({ ID: 'petrol', 'Fuel Type Code': 'CNG' }),
      station({ ID: 'private', 'Access Code': 'private' }),
    ]);
    try {
      assert.equal(status, 0);
      const { sites } = await readCatalog(dir);
      assert.deepEqual(
        sites.map((s) => s.registryStationId),
        ['keep'],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the catalog seed is reproducible and carries its provenance', () => {
  it('produces identical output for identical input', async () => {
    const rows = [station({ ID: '3' }), station({ ID: '1' }), station({ ID: '2' })];
    const first = await runRefresh(rows);
    const second = await runRefresh(rows);
    try {
      assert.equal(first.status, 0);
      assert.equal(second.status, 0);
      const a = await readFile(join(first.dir, 'mesa-stations.json'), 'utf8');
      const b = await readFile(join(second.dir, 'mesa-stations.json'), 'utf8');
      assert.equal(a, b, 're-running must not produce a different file for the same input');

      // Sorted, so a diff between two refreshes shows real changes only.
      const { sites } = await readCatalog(first.dir);
      const ids = sites.map((s) => String(s.id));
      assert.deepEqual([...ids].sort(), ids);
    } finally {
      await rm(first.dir, { recursive: true, force: true });
      await rm(second.dir, { recursive: true, force: true });
    }
  });

  it('records where the data came from, its hash and the field mapping', async () => {
    const { status, dir } = await runRefresh([station()]);
    try {
      assert.equal(status, 0);
      const provenance = JSON.parse(await readFile(join(dir, 'provenance.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      assert.equal(provenance.formatVersion, 1);
      assert.ok(String(provenance.sourceUrl).includes('afdc.energy.gov'));
      assert.match(String(provenance.fileSha256), /^[0-9a-f]{64}$/);
      assert.ok(provenance.fieldMapping, 'the column mapping must be recorded, not just applied');
      assert.ok(
        provenance.retrievedAtIso ?? provenance.retrievedAtMs,
        'retrieval time must be recorded',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes nothing on a dry run', async () => {
    const { status, dir } = await runRefresh([station()], ['--dry-run']);
    try {
      assert.equal(status, 0);
      await assert.rejects(
        readFile(join(dir, 'mesa-stations.json'), 'utf8'),
        'a dry run must not write a catalog',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
