/**
 * ChargePoint extraction against SYNTHETIC fixtures (§32 collector tests).
 *
 * These prove the parser's behaviour for the modelled page shapes. They do not
 * prove the live source is collectable; see docs/SOURCE_VERIFICATION.md.
 *
 * Run: node --experimental-strip-types --test tests/nodeps/chargepoint-parse.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyLevel,
  classifyStatus,
  parsePageReading,
  parseSummary,
  parseUpdatedText,
  sanitizeEvidence,
} from '../../src/collector/adapters/chargepoint/parse.ts';
import * as fixtures from '../fixtures/chargepoint/readings.ts';
import { reconcileCounts } from '../../src/domain/reconcile.ts';

const OPTIONS = { expectedStationId: '11502081', catalogPortCount: 2 };

describe('status vocabulary', () => {
  test('recognised phrases map to their states', () => {
    assert.equal(classifyStatus('Available').state, 'available');
    assert.equal(classifyStatus('In use').state, 'occupied');
    assert.equal(classifyStatus('Charging').state, 'occupied');
    assert.equal(classifyStatus('Reserved').state, 'reserved');
    assert.equal(classifyStatus('Out of service').state, 'out_of_service');
    assert.equal(classifyStatus('Offline').state, 'out_of_service');
    assert.equal(classifyStatus('Coming soon').state, 'out_of_service');
  });

  test('only "charging" means the source distinguished active charging', () => {
    assert.equal(classifyStatus('Charging').explicitCharging, true);
    assert.equal(classifyStatus('In use').explicitCharging, false);
    assert.equal(classifyStatus('Occupied').explicitCharging, false);
  });

  test('an unrecognised or empty phrase is unknown, never available', () => {
    for (const phrase of ['Estado desconocido', 'שימוש', '???', '', null]) {
      assert.equal(classifyStatus(phrase).state, 'unknown', `${String(phrase)} must be unknown`);
    }
  });
});

describe('level classification', () => {
  test('connector type decides the class where it is stated', () => {
    assert.equal(classifyLevel('J1772', null), 'level_2');
    assert.equal(classifyLevel('CCS', null), 'dc_fast');
    assert.equal(classifyLevel('CHAdeMO', null), 'dc_fast');
    assert.equal(classifyLevel('NEMA 5-20', null), 'level_1');
  });

  test('power is a fallback and anything ambiguous stays unknown', () => {
    assert.equal(classifyLevel(null, '150 kW'), 'dc_fast');
    assert.equal(classifyLevel(null, '7.2 kW'), 'level_2');
    assert.equal(classifyLevel(null, null), 'unknown');
    assert.equal(classifyLevel('mystery plug', '2 kW'), 'unknown');
  });
});

describe('provider update time', () => {
  test('relative phrases resolve against the read instant', () => {
    const at = fixtures.READ_AT;
    assert.equal(parseUpdatedText('Updated 9 minutes ago', at), at - 9 * 60_000);
    assert.equal(parseUpdatedText('2 hours ago', at), at - 2 * 3_600_000);
    assert.equal(parseUpdatedText('just now', at), at);
  });

  test('an unparseable or absent phrase yields null, meaning freshness unknown', () => {
    assert.equal(parseUpdatedText(null, fixtures.READ_AT), null);
    assert.equal(parseUpdatedText('recently', fixtures.READ_AT), null);
    assert.equal(parseUpdatedText('sometime last Tuesday', fixtures.READ_AT), null);
  });
});

describe('aggregate summaries', () => {
  test('"1 of 2 available" yields an available count and a reported total', () => {
    assert.deepEqual(parseSummary('1 of 2 ports available'), { available: 1, total: 2 });
    assert.deepEqual(parseSummary('2/6 available'), { available: 2, total: 6 });
  });

  test('a summary total never implies how the remainder is distributed', () => {
    const summary = parseSummary('2 of 6 ports available');
    const reconciled = reconcileCounts({
      available: summary?.available ?? null,
      occupied: null,
      reserved: null,
      outOfService: null,
      unknown: null,
      total: summary?.total ?? null,
    });
    assert.equal(reconciled.ok, true);
    if (!reconciled.ok) return;
    assert.equal(reconciled.value.occupied, null);
    assert.equal(reconciled.value.unknown, 4);
    assert.equal(reconciled.value.supportsOccupancy, false);
  });
});

describe('port rows', () => {
  test('the two-port J1772 shape yields honest site-level counts', () => {
    const result = parsePageReading(fixtures.twoPortJ1772, OPTIONS);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.counts, {
      available: 1,
      occupied: 1,
      reserved: 0,
      outOfService: 0,
      unknown: 0,
      total: 2,
    });
    assert.equal(result.level, 'level_2');
    assert.equal(result.capacityBasis, 'ports_simultaneous');
    assert.equal(result.completeness, 'complete');
    assert.equal(result.sourceUpdatedAtUtcMs, fixtures.READ_AT - 9 * 60_000);
  });

  test('without durable identifiers no port rows are recorded', () => {
    const result = parsePageReading(fixtures.twoPortJ1772, OPTIONS);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.identityReliable, false);
    assert.deepEqual(result.ports, [], 'display order is not an identity');
    assert.ok(
      result.warnings.some((w) => /durable port identifiers/.test(w)),
      'and the limitation is recorded',
    );
  });

  test('with durable identifiers per-port states are recorded', () => {
    const result = parsePageReading(fixtures.twoPortWithDurableIds, OPTIONS);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.identityReliable, true);
    assert.deepEqual(
      result.ports.map((p) => [p.sourcePortId, p.state]),
      [
        ['CP-11502081-1', 'available'],
        ['CP-11502081-2', 'occupied'],
      ],
    );
    assert.equal(result.distinguishesCharging, true, 'every occupied row said "Charging"');
  });

  test('a mix of "In use" and "Charging" does not claim charging is distinguished', () => {
    const mixed = fixtures.reading({
      portRows: [
        { label: 'Port 1', statusText: 'Charging', connectorText: 'CCS', powerText: null, lastUsedText: null, durablePortId: 'a' },
        { label: 'Port 2', statusText: 'In use', connectorText: 'CCS', powerText: null, lastUsedText: null, durablePortId: 'b' },
      ],
    });
    const result = parsePageReading(mixed, OPTIONS);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.distinguishesCharging, false);
  });

  test('an outage is reported as out of service, not as unavailability', () => {
    const result = parsePageReading(fixtures.dcFastWithOutage, {
      expectedStationId: '20001',
      catalogPortCount: 3,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.counts.outOfService, 1);
    assert.equal(result.counts.available, 1);
    assert.equal(result.counts.occupied, 1);
    assert.equal(result.level, 'dc_fast');
  });

  test('an unknown status makes the observation partial rather than complete', () => {
    const result = parsePageReading(fixtures.unrecognisedStatus, OPTIONS);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.counts.unknown, 1);
    assert.equal(result.counts.available, 1);
    assert.equal(result.completeness, 'partial');
    assert.ok(result.warnings.some((w) => /locale/.test(w)), 'the locale mismatch is recorded');
  });

  test('connector rows are flagged so two plugs are not read as two spaces', () => {
    const result = parsePageReading(fixtures.connectorsNotPorts, OPTIONS);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.capacityBasis, 'connectors');
    assert.ok(result.warnings.some((w) => /two plugs on one unit/.test(w)));
  });

  test('"last used" text is never counted', () => {
    const result = parsePageReading(fixtures.withLastUsed, OPTIONS);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.counts.total, 2);
    assert.equal(result.counts.occupied, 1);
    assert.ok(result.warnings.some((w) => /not a session or usage count/.test(w)));
  });

  test('capacity drift against the catalog is recorded, not assumed', () => {
    const result = parsePageReading(fixtures.dcFastWithOutage, {
      expectedStationId: '20001',
      catalogPortCount: 2,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.warnings.some((w) => /capacity drift/.test(w)));
  });
});

describe('aggregate-only sources', () => {
  test('an availability-only summary yields a partial observation with nulls', () => {
    const result = parsePageReading(fixtures.aggregateOnly, {
      expectedStationId: '11502081',
      catalogPortCount: 6,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.counts.available, 2);
    assert.equal(result.counts.occupied, null, 'occupancy is not derived by subtraction');
    assert.equal(result.counts.total, 6);
    assert.equal(result.completeness, 'partial');
    assert.equal(result.capacityBasis, 'reported_total');
    assert.ok(result.warnings.some((w) => /not derived by subtraction/.test(w)));
  });
});

describe('failure outcomes', () => {
  test('each page condition maps to its own durable outcome', () => {
    const cases = [
      ['stillLoading', fixtures.stillLoading, 'timeout'],
      ['noResults', fixtures.noResults, 'invalid_data'],
      ['sourceError', fixtures.sourceError, 'offline'],
      ['emptyStatus', fixtures.emptyStatus, 'partial'],
      ['loginRequired', fixtures.loginRequired, 'login_required'],
      ['challenge', fixtures.challenge, 'source_blocked'],
    ] as const;
    for (const [name, page, expected] of cases) {
      const result = parsePageReading(page, OPTIONS);
      assert.equal(result.ok, false, `${name} must not produce an observation`);
      if (result.ok) continue;
      assert.equal(result.outcome, expected, `${name} should map to ${expected}`);
    }
  });

  test('loading, no-results, source errors and empty panels are distinguished', () => {
    const outcomes = new Set(
      (['stillLoading', 'noResults', 'sourceError', 'emptyStatus'] as const).map((name) => {
        const result = parsePageReading(fixtures[name], OPTIONS);
        return result.ok ? 'ok' : result.outcome;
      }),
    );
    assert.equal(outcomes.size, 4, 'these four conditions must not collapse into one');
  });

  test('a failed read produces no observation at all, not a zero one', () => {
    const result = parsePageReading(fixtures.sourceError, OPTIONS);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(!('counts' in result), 'there is no counts object to mistake for zero usage');
  });

  test('a station identity mismatch is rejected rather than written to the binding', () => {
    const result = parsePageReading(fixtures.identityMismatch, OPTIONS);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.outcome, 'invalid_data');
    assert.match(result.detail, /identity mismatch/);
  });

  test('a page with no station identity is rejected when one was expected', () => {
    const result = parsePageReading(
      fixtures.reading({ stationIdOnPage: null, portRows: [] , summaryText: '1 of 2 available' }),
      OPTIONS,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.detail, /no station identity/);
  });

  test('a layout change is reported as such, not as an empty station', () => {
    const result = parsePageReading(fixtures.layoutChanged, OPTIONS);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.outcome, 'layout_changed');
  });
});

describe('evidence sanitisation', () => {
  test('addresses and phone numbers are removed from retained evidence', () => {
    const sanitized = sanitizeEvidence([
      'Contact driver@example.com for help',
      'Call +1 (480) 555-0134 for support',
      '  collapsed   whitespace  ',
    ]);
    assert.ok(!sanitized.includes('driver@example.com'));
    assert.ok(!sanitized.includes('555-0134'));
    assert.ok(sanitized.includes('[email removed]'));
    assert.ok(sanitized.includes('[number removed]'));
    assert.ok(sanitized.includes('collapsed whitespace'));
  });

  test('retained evidence is bounded in size', () => {
    const sanitized = sanitizeEvidence([('x'.repeat(5000))]);
    assert.ok(sanitized.length <= 1000);
  });

  test('an observation carries sanitized evidence, not the raw page', () => {
    const result = parsePageReading(fixtures.twoPortJ1772, OPTIONS);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.sanitizedSourceText.length > 0);
    assert.ok(result.sanitizedSourceText.length <= 1000);
  });
});
