/**
 * The disputed-capacity colour is defined twice, and must not drift.
 *
 * The rail marks a conflict with the `--conflict` custom property. The map
 * cannot: its markers are built as HTML strings handed to Leaflet's divIcon,
 * so the colour is a literal in StationMap.tsx. Two definitions of one colour
 * is a duplication that a future edit to one of them would quietly break —
 * leaving the map and the list marking the same condition in two colours,
 * which reads as two different conditions.
 *
 * This spec is the reason the duplication is safe to keep.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');

describe('the disputed-capacity colour', () => {
  const tokens = read('src', 'renderer', 'src', 'tokens.css');
  const map = read('src', 'renderer', 'src', 'components', 'StationMap.tsx');

  it('is defined as a token', () => {
    const match = /--conflict:\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(tokens);
    assert.ok(match, '--conflict is missing from tokens.css');
  });

  it('matches the literal the map markers are built with', () => {
    const token = /--conflict:\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(tokens)?.[1];
    const literal = /const CONFLICT_COLOR = '(#[0-9a-fA-F]{3,8})';/.exec(map)?.[1];

    assert.ok(token, '--conflict is missing from tokens.css');
    assert.ok(literal, 'CONFLICT_COLOR is missing from StationMap.tsx');
    assert.equal(
      literal.toLowerCase(),
      token.toLowerCase(),
      'the map ring and the rail marking must be the same colour',
    );
  });

  it('is distinct from every occupancy band colour, so it reads as a different thing', () => {
    const token = /--conflict:\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(tokens)?.[1]?.toLowerCase();
    const bands = [
      ...map.matchAll(/^\s{2}(?:low|moderate|high|unsupported):\s*'(#[0-9a-fA-F]{6})'/gm),
    ]
      .map((m) => m[1])
      .filter((hex): hex is string => hex !== undefined)
      .map((hex) => hex.toLowerCase());

    assert.ok(bands.length >= 4, 'expected the four band colours to be readable from StationMap');
    for (const band of bands) {
      assert.notEqual(token, band, 'a conflict must not be drawn in an occupancy band colour');
    }
  });
});
