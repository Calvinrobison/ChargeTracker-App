/**
 * Filtering by how many stalls a location has, and how many are free.
 *
 * Two questions, kept apart on purpose. Capacity is a property of the site and
 * is known for every catalogued location. Availability is a property of a
 * moment and only a monitored location that was actually read can answer it.
 *
 * The rule these specs exist to hold: an unknown count is never treated as
 * zero. A location whose capacity nobody knows must not appear in "1–2
 * stalls", and a location nobody has observed must not appear in "0 free" —
 * because both would put a claim in front of the user that nobody measured.
 *
 * The capacity band counts at the end are asserted against the catalog that
 * actually ships, so the feature is exercised on the data it will run on
 * rather than on a fixture invented to suit it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  describeRange,
  isOpenRange,
  matchesRange,
  normalizeRange,
  resolveCapacity,
} from '../../src/domain/stalls.ts';

const OPEN = { min: null, max: null };

describe('choosing which stall count to trust', () => {
  it('prefers the source figure, which was measured rather than imported', () => {
    const resolved = resolveCapacity({ sourcePorts: 8, catalogPorts: 2 });
    assert.equal(resolved.stalls, 8);
    assert.equal(resolved.basis, 'source');
  });

  it('reports a disagreement instead of resolving it quietly', () => {
    // The whole point: the application picks one, and says that it picked.
    assert.equal(resolveCapacity({ sourcePorts: 8, catalogPorts: 2 }).disagrees, true);
    assert.equal(resolveCapacity({ sourcePorts: 2, catalogPorts: 2 }).disagrees, false);
  });

  it('is not a disagreement when only one of the two is known', () => {
    assert.equal(resolveCapacity({ sourcePorts: 6, catalogPorts: null }).disagrees, false);
    assert.equal(resolveCapacity({ sourcePorts: null, catalogPorts: 6 }).disagrees, false);
  });

  it('falls back to the catalog, and says that is what it used', () => {
    const resolved = resolveCapacity({ sourcePorts: null, catalogPorts: 4 });
    assert.equal(resolved.stalls, 4);
    assert.equal(resolved.basis, 'catalog');
  });

  it('returns null, not zero, when neither is known', () => {
    const resolved = resolveCapacity({ sourcePorts: null, catalogPorts: null });
    assert.equal(resolved.stalls, null);
    assert.equal(resolved.basis, null);
  });
});

describe('an unknown count never satisfies a filter', () => {
  it('excludes an unknown capacity from any bounded range', () => {
    assert.equal(matchesRange(null, { min: 1, max: 2 }), false);
    assert.equal(matchesRange(null, { min: 8, max: null }), false);
    assert.equal(matchesRange(null, { min: null, max: 20 }), false);
  });

  it('excludes an unknown count from a range asking for zero', () => {
    // "0 free" is a measurement. An unobserved location has not produced it,
    // and must not be presented as though it had.
    assert.equal(matchesRange(null, { min: 0, max: 0 }), false);
  });

  it('keeps an unknown count when nothing is being filtered', () => {
    assert.equal(matchesRange(null, OPEN), true, 'an unset filter must not hide locations');
  });
});

describe('range arithmetic', () => {
  it('includes both ends', () => {
    assert.equal(matchesRange(8, { min: 8, max: 20 }), true);
    assert.equal(matchesRange(20, { min: 8, max: 20 }), true);
    assert.equal(matchesRange(7, { min: 8, max: 20 }), false);
    assert.equal(matchesRange(21, { min: 8, max: 20 }), false);
  });

  it('treats an open end as unbounded rather than as zero', () => {
    assert.equal(matchesRange(400, { min: 8, max: null }), true);
    assert.equal(matchesRange(1, { min: null, max: 20 }), true);
    assert.equal(matchesRange(1, { min: 8, max: null }), false);
  });

  it('distinguishes a minimum of 0 from no minimum at all', () => {
    // min: 0 constrains nothing on the low side but IS a set filter, so an
    // unknown count is excluded. min: null is no filter, so it is kept.
    assert.equal(matchesRange(null, { min: 0, max: null }), false);
    assert.equal(matchesRange(null, { min: null, max: null }), true);
  });

  it('reads a backwards range as the range the person meant', () => {
    assert.deepEqual(normalizeRange({ min: 20, max: 8 }), { min: 8, max: 20 });
    assert.deepEqual(normalizeRange({ min: 8, max: 20 }), { min: 8, max: 20 });
    assert.deepEqual(normalizeRange({ min: 8, max: null }), { min: 8, max: null });
  });

  it('knows when a range constrains nothing', () => {
    assert.equal(isOpenRange(OPEN), true);
    assert.equal(isOpenRange({ min: 0, max: null }), false);
  });
});

describe('the range as a person reads it', () => {
  it('describes each shape in words', () => {
    assert.equal(describeRange({ min: 8, max: 20 }), '8–20 stalls');
    assert.equal(describeRange({ min: 8, max: null }), '8+ stalls');
    assert.equal(describeRange({ min: null, max: 2 }), 'up to 2 stalls');
    assert.equal(describeRange({ min: 4, max: 4 }), 'exactly 4 stalls');
    assert.equal(describeRange(OPEN), null, 'an unset filter has nothing to announce');
  });

  it('takes the noun it is given, so "free" does not read as capacity', () => {
    assert.equal(describeRange({ min: 2, max: null }, 'free'), '2+ free');
  });
});

describe('against the catalog that actually ships', () => {
  const catalogPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'resources',
    'catalog',
    'mesa-stations.json',
  );
  const sites = (
    JSON.parse(readFileSync(catalogPath, 'utf8')) as {
      sites: { catalogPortCount: number | null }[];
    }
  ).sites;

  const countIn = (min: number | null, max: number | null): number =>
    sites.filter((site) =>
      matchesRange(
        resolveCapacity({ sourcePorts: null, catalogPorts: site.catalogPortCount }).stalls,
        { min, max },
      ),
    ).length;

  it('finds the large locations the small ones drown out', () => {
    // The request this feature came from: 8-20 stalls rather than 2.
    const large = countIn(8, 20);
    assert.ok(large > 0, 'a filter that matches nothing on real data is not a feature');
    assert.ok(large < sites.length / 2, 'the point is that large sites are the minority');
  });

  it('every location falls in exactly one of a set of adjacent bands', () => {
    const bands: [number | null, number | null][] = [
      [null, 1],
      [2, 2],
      [3, 4],
      [5, 7],
      [8, 20],
      [21, null],
    ];
    const total = bands.reduce((sum, [min, max]) => sum + countIn(min, max), 0);
    assert.equal(
      total,
      sites.length,
      'adjacent bands that do not sum to the whole catalog have a gap or an overlap',
    );
  });

  it('an open filter returns the whole catalog', () => {
    assert.equal(countIn(null, null), sites.length);
  });

  it('asking for more stalls than anything has returns nothing, not everything', () => {
    assert.equal(countIn(501, null), 0, 'an impossible filter must be empty, never unfiltered');
  });
});
