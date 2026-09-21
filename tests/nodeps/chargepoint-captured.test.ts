/**
 * ChargePoint extraction against CAPTURED readings from the live station page.
 *
 * These are the readings the adapter's own extraction script produced on
 * 2026-09-21 (tests/fixtures/chargepoint/captured.ts). The assertions are what
 * a person looking at each page would have written down, so a parser that
 * disagrees with them is wrong about the real page, not about a model of it.
 *
 * Run: node --experimental-strip-types --test tests/nodeps/chargepoint-captured.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';

import {
  classifyRow,
  classifyStatusCode,
  parsePageReading,
} from '../../src/collector/adapters/chargepoint/parse.ts';
import {
  CAPABILITIES,
  EXTRACT_SCRIPT,
  READY_SCRIPT,
  stationIdFromUrl,
  stationUrl,
} from '../../src/collector/adapters/chargepoint/index.ts';
import * as captured from '../fixtures/chargepoint/captured.ts';

describe('provider status codes', () => {
  test('every code the provider pill file defines maps to a state', () => {
    // From na.chargepoint.com/UI/images/pills/states/en-US/states.json,
    // version 1715755545, plus the two extra members of the page's enum.
    const expected: Record<string, string> = {
      available: 'available',
      in_use: 'occupied',
      in_use_by_driver: 'occupied',
      unavailable: 'out_of_service',
      maintenance_required: 'out_of_service',
      out_of_service: 'out_of_service',
      fault: 'out_of_service',
      out_of_order: 'out_of_service',
      closed: 'out_of_service',
      unreachable: 'unknown',
      unknown: 'unknown',
      out_of_network: 'unknown',
    };
    for (const [code, state] of Object.entries(expected)) {
      assert.equal(classifyStatusCode(code), state, `${code} must map to ${state}`);
    }
  });

  test('a code the table does not know is null, never a guess', () => {
    assert.equal(classifyStatusCode('spontaneous_combustion'), null);
    assert.equal(classifyStatusCode(''), null);
    assert.equal(classifyStatusCode(null), null);
    assert.equal(classifyStatusCode(undefined), null);
  });

  test('the visible text is authoritative and a disagreement is recorded', () => {
    const agree = classifyRow({
      label: null,
      statusText: 'In Use',
      statusCode: 'in_use',
      connectorText: null,
      powerText: null,
      lastUsedText: null,
      durablePortId: '1',
    });
    assert.equal(agree.state, 'occupied');
    assert.equal(agree.disagreement, null);

    const disagree = classifyRow({
      label: null,
      statusText: 'Available',
      statusCode: 'fault',
      connectorText: null,
      powerText: null,
      lastUsedText: null,
      durablePortId: '1',
    });
    assert.equal(disagree.state, 'available', 'the words a person sees win');
    assert.match(disagree.disagreement ?? '', /visible text was used/);
  });

  test('the code settles a row whose words are not recognised', () => {
    const row = classifyRow({
      label: null,
      statusText: 'Hors service',
      statusCode: 'unavailable',
      connectorText: null,
      powerText: null,
      lastUsedText: null,
      durablePortId: '1',
    });
    assert.equal(row.state, 'out_of_service');
    assert.equal(row.matched, 'code:unavailable');
  });

  test('"Closed" and "Unknown" — both real pill words — classify without the code', () => {
    const closed = classifyRow({
      label: null,
      statusText: 'Closed',
      connectorText: null,
      powerText: null,
      lastUsedText: null,
      durablePortId: '1',
    });
    assert.equal(closed.state, 'out_of_service');
    const unknown = classifyRow({
      label: null,
      statusText: 'Unknown',
      connectorText: null,
      powerText: null,
      lastUsedText: null,
      durablePortId: '1',
    });
    assert.equal(unknown.state, 'unknown');
  });
});

describe('BANNER HEALTH / BAYWOOD 1 — one Available, one In Use', () => {
  const result = parsePageReading(captured.baywood1OneInUse, {
    expectedStationId: '11502161',
    catalogPortCount: 2,
  });

  test('parses to exactly the counts the page showed', () => {
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual(result.counts, {
      available: 1,
      occupied: 1,
      reserved: 0,
      outOfService: 0,
      unknown: 0,
      total: 2,
    });
    assert.equal(result.completeness, 'complete');
    assert.equal(result.capacityBasis, 'ports_simultaneous');
  });

  test('outlet numbers are durable port identities, so per-port history is on', () => {
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.identityReliable, true);
    assert.deepEqual(
      result.ports.map((p) => [p.sourcePortId, p.state, p.level]),
      [
        ['1', 'available', 'level_2'],
        ['2', 'occupied', 'level_2'],
      ],
    );
  });

  test('J1772 at 6.6 kW is Level 2', () => {
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.level, 'level_2');
  });

  test('"In Use" is occupancy, not a claim that electricity flowed', () => {
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.distinguishesCharging, false);
  });

  test('the page has no status clock, so source freshness stays unknown', () => {
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.sourceUpdatedAtUtcMs, null);
  });

  test('"Last Used 2 days ago" is kept as evidence and never counted', () => {
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.match(result.sanitizedSourceText, /Last Used 2 days ago/);
    assert.equal(result.counts.total, 2);
  });

  test('no warnings: the catalog and the page agree on two ports', () => {
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.warnings, []);
  });
});

describe('CHAPMAN FORD / POWER LINK S — both DC outlets out of service', () => {
  const result = parsePageReading(captured.chapmanFordBothOutOfService, {
    expectedStationId: '17560121',
    catalogPortCount: 2,
  });

  test('two out of service, nothing available, nothing unknown', () => {
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual(result.counts, {
      available: 0,
      occupied: 0,
      reserved: 0,
      outOfService: 2,
      unknown: 0,
      total: 2,
    });
    assert.equal(result.completeness, 'complete');
  });

  test('CCS1 at 120 kW is DC fast', () => {
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.level, 'dc_fast');
    assert.deepEqual(
      result.ports.map((p) => p.level),
      ['dc_fast', 'dc_fast'],
    );
  });
});

describe('CHARGEPOINT / SCD RTECH DC 1 — a "(DC Fast)" plug line and a fault', () => {
  const result = parsePageReading(captured.scdRtechFault, {
    expectedStationId: '1804411',
    catalogPortCount: null,
  });

  test('a fault is out of service, and the plug line still classifies as DC', () => {
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.counts.outOfService, 1);
    assert.equal(result.counts.total, 1);
    assert.equal(result.level, 'dc_fast');
  });
});

describe('an unknown station id', () => {
  test('is a source error, not an observation and not a layout change', () => {
    const result = parsePageReading(captured.unknownStationError, {
      expectedStationId: '999999999',
      catalogPortCount: null,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.outcome, 'offline');
    assert.match(result.detail, /source_error/);
  });
});

describe('identity', () => {
  test('a reading from the wrong station is refused even when it parses cleanly', () => {
    const result = parsePageReading(captured.baywood1OneInUse, {
      expectedStationId: '11502162',
      catalogPortCount: 2,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.outcome, 'invalid_data');
    assert.match(result.detail, /identity mismatch/);
  });

  test('the canonical station URL round-trips through the id parser', () => {
    assert.equal(stationUrl('11502161'), 'https://driver.chargepoint.com/stations/11502161');
    assert.equal(stationIdFromUrl(stationUrl('11502161')), '11502161');
  });
});

describe('the capability record', () => {
  test('is enabled and verified, with the review recorded in the record itself', () => {
    assert.equal(CAPABILITIES.eligibilityState, 'enabled');
    assert.equal(CAPABILITIES.verificationState, 'verified');
    assert.ok(CAPABILITIES.termsReviewedAtMs !== null, 'a review date is required');
    assert.ok(
      (CAPABILITIES.termsReviewScope ?? '').length > 100,
      'the scope must say what was read',
    );
    assert.ok((CAPABILITIES.eligibilityBasis ?? '').length > 100, 'the basis must say why');
    assert.ok(CAPABILITIES.termsUrls.some((u) => u.includes('robots.txt')));
  });

  test('declares durable per-outlet identity, which the page provides', () => {
    assert.equal(CAPABILITIES.identityReliability, 'durable');
    assert.equal(CAPABILITIES.observationGranularity, 'port');
  });

  test('never claims to separate charging from occupancy', () => {
    assert.equal(CAPABILITIES.distinguishesCharging, false);
    assert.equal(CAPABILITIES.providesRecordedSessions, false);
  });
});

describe('the in-page scripts', () => {
  test('are syntactically valid JavaScript expressions', () => {
    // Both run inside the page via Playwright. A syntax error there would be
    // a runtime failure on every read, so it is caught here instead.
    // Compiled, never run: a vm.Script parses the source without executing it.
    assert.doesNotThrow(() => new Script(`(${EXTRACT_SCRIPT})`));
    assert.doesNotThrow(() => new Script(`(${READY_SCRIPT})`));
  });

  test('hold on to the page’s own test hooks, not its hashed class names', () => {
    assert.match(EXTRACT_SCRIPT, /#slideout_station_details/);
    assert.match(EXTRACT_SCRIPT, /port_status_pill/);
    assert.match(EXTRACT_SCRIPT, /\^port_\\d\+\$/);
    // styled-components hashes like "sc-eKtvVk" must never be relied on.
    assert.doesNotMatch(EXTRACT_SCRIPT, /sc-[A-Za-z]{6}/);
  });
});
