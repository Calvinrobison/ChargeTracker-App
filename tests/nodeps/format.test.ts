/**
 * The display layer's honesty rules.
 *
 * `src/renderer/src/format.ts` is the last place a missing measurement can be
 * turned into a number. Every other guarantee in this project — half-open
 * intervals, unassigned residuals, bounded carry-forward, port-minute
 * weighting — is undone if a formatter renders `null` as `0%` on the way to the
 * screen. So this is tested like domain logic, not like presentation.
 *
 * These specs run with no dependencies because the module imports only a type
 * and the threshold constants. A React test would need a renderer and would
 * prove less.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  EM_DASH,
  bandColor,
  bytesText,
  coverageAndAge,
  currentStatusText,
  durationText,
  freshnessText,
  heatColor,
  hourLabel,
  hours,
  initialsOf,
  isoDateToShort,
  occupancyBandOf,
  pct,
  relativeOrDash,
  relativeTime,
  stateBadge,
  statusDotColor,
  statusDotLabel,
} from '../../src/renderer/src/format.ts';
import type { StationView } from '../../src/shared/ipc.ts';

/** A monitored station with everything known. Specs override one field at a time. */
function station(overrides: Partial<StationView> = {}): StationView {
  return {
    id: 'site-1',
    name: 'Superstition Springs Center',
    address: '6555 E Southern Ave, Mesa, AZ',
    network: 'ChargePoint',
    type: 'DC Fast',
    lat: 33.3937,
    lng: -111.6931,
    ports: 8,
    catalogPorts: 8,
    available: 3,
    occupied: 5,
    offline: 0,
    unknown: 0,
    occupancy: 62.5,
    hours: 41.2,
    coverage: 97.4,
    history: 21,
    observed: '6 min ago',
    observedAtMs: 1_757_000_000_000,
    sourceUpdatedAtMs: 1_757_000_000_000,
    sourceFreshness: 'fresh',
    monitoring: 'monitored',
    eligibleForRanking: true,
    provisionalReasons: [],
    saved: false,
    peak: 'Weekdays 5–7p',
    starts: 6.4,
    dwell: '48 min',
    distinguishesCharging: false,
    scopeNote: null,
    ...overrides,
  } as StationView;
}

// ---------------------------------------------------------------------------

describe('a missing measurement is never rendered as a number', () => {
  it('renders a null percentage as the em dash, not 0%', () => {
    assert.equal(pct(null), EM_DASH);
    assert.notEqual(pct(null), '0%');
  });

  it('renders a genuine zero as 0%, which is a different fact', () => {
    // This is the pair that matters. If both rendered the same, a reader could
    // not tell "nothing was observed" from "nothing was occupied".
    assert.equal(pct(0), '0%');
    assert.notEqual(pct(0), pct(null));
  });

  it('renders null counts and hours as the em dash', () => {
    assert.equal(hours(null), EM_DASH);
    assert.equal(relativeOrDash(null), EM_DASH);
    assert.equal(durationText(null), EM_DASH);
    assert.equal(bytesText(null), EM_DASH);
    assert.equal(relativeTime(null), EM_DASH);
  });

  it('refuses NaN and Infinity as well as null', () => {
    // A ratio computed from a zero denominator arrives here as NaN or
    // Infinity. Either would print as "NaN%" or "Infinity%" without this.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(pct(value), EM_DASH, `pct(${String(value)})`);
      assert.equal(hours(value), EM_DASH, `hours(${String(value)})`);
      assert.equal(durationText(value), EM_DASH, `durationText(${String(value)})`);
    }
  });
});

describe('current status text', () => {
  it('says "No current status" when the source did not report counts', () => {
    assert.equal(currentStatusText(station({ occupied: null })), 'No current status');
    assert.equal(currentStatusText(station({ ports: null })), 'No current status');
  });

  it('never reports zero occupied when occupancy is unknown', () => {
    const text = currentStatusText(station({ occupied: null, ports: 8 }));
    assert.equal(text.includes('0'), false, `"${text}" implies a measurement that does not exist`);
  });

  it('distinguishes a catalog-only location from a monitored one with no reading', () => {
    // Two different facts: "we do not watch this" and "we watch it but the
    // source said nothing".
    assert.equal(currentStatusText(station({ monitoring: 'catalog' })), 'Not monitored');
    assert.equal(currentStatusText(station({ occupied: null })), 'No current status');
  });

  it('says "charging" only when the source separates charging from occupancy', () => {
    assert.equal(currentStatusText(station({ distinguishesCharging: false })), '5 / 8 occupied');
    assert.equal(currentStatusText(station({ distinguishesCharging: true })), '5 / 8 charging');
  });

  it('reports a genuine zero available', () => {
    assert.equal(currentStatusText(station({ available: 0, occupied: 8 })), '8 / 8 occupied');
  });
});

describe('the status dot always has words beside it', () => {
  it('labels every monitoring state, so colour is never the only signal', () => {
    const cases: Array<[Partial<StationView>, string]> = [
      [{ monitoring: 'catalog' }, 'Catalog only, not monitored'],
      [{ monitoring: 'stale' }, 'Stale source'],
      [{ monitoring: 'provisional' }, 'Provisional history'],
      [{ offline: 2 }, 'One or more ports offline'],
      [{ available: 0 }, 'No ports available'],
      [{}, 'Ports available'],
    ];
    for (const [overrides, expected] of cases) {
      assert.equal(statusDotLabel(station(overrides)), expected, JSON.stringify(overrides));
    }
  });

  it('treats an unknown offline count as not-offline rather than as offline', () => {
    // `offline: null` means the source gave no breakdown. Claiming a fault
    // would be an invention; the row falls through to the available state.
    assert.equal(statusDotLabel(station({ offline: null })), 'Ports available');
  });

  it('gives catalog and provisional rows their own colours', () => {
    assert.equal(statusDotColor(station({ monitoring: 'catalog' })), 'var(--dot-catalog)');
    assert.equal(statusDotColor(station({ monitoring: 'provisional' })), 'var(--dot-provisional)');
    assert.equal(statusDotColor(station({ monitoring: 'stale' })), 'var(--dot-provisional)');
    assert.notEqual(
      statusDotColor(station({ monitoring: 'catalog' })),
      statusDotColor(station()),
      'a catalog-only row must not look like a monitored one',
    );
  });
});

describe('state badges', () => {
  it('badges only the states that need explaining', () => {
    assert.equal(stateBadge(station({ monitoring: 'catalog' })), 'Catalog only');
    assert.equal(stateBadge(station({ monitoring: 'stale' })), 'Stale source');
    assert.equal(stateBadge(station({ monitoring: 'provisional' })), 'Provisional');
    assert.equal(stateBadge(station({ monitoring: 'monitored' })), null);
  });
});

describe('occupancy bands', () => {
  it('gives an unknown occupancy its own band rather than the lowest one', () => {
    // Without this, a station with no data would be painted the same green as
    // a genuinely quiet one.
    assert.equal(occupancyBandOf(null), 'unsupported');
    assert.equal(occupancyBandOf(Number.NaN), 'unsupported');
    assert.notEqual(occupancyBandOf(null), occupancyBandOf(0));
  });

  it('bands on the documented thresholds, with the boundaries in the lower band', () => {
    assert.equal(occupancyBandOf(0), 'low');
    assert.equal(occupancyBandOf(29.9), 'low');
    assert.equal(occupancyBandOf(30), 'moderate');
    assert.equal(occupancyBandOf(59.9), 'moderate');
    assert.equal(occupancyBandOf(60), 'high');
    assert.equal(occupancyBandOf(100), 'high');
  });

  it('colours the unsupported band as muted text, not as a value colour', () => {
    assert.equal(bandColor('unsupported'), 'var(--text-secondary)');
    for (const band of ['low', 'moderate', 'high'] as const) {
      assert.notEqual(bandColor(band), bandColor('unsupported'));
    }
  });
});

describe('heatmap cells', () => {
  it('gives a cell with no observation its own ramp step', () => {
    assert.equal(heatColor(null, false), 'var(--heat-0)');
    assert.equal(heatColor(null, true), 'var(--heat-0)');
    // hasData false wins even if a percentage is somehow present, because the
    // flag is the authority on whether anything was observed.
    assert.equal(heatColor(12, false), 'var(--heat-0)');
  });

  it('never paints an observed zero as the no-data step', () => {
    // An hour that was watched and found empty is a real finding. It must not
    // be indistinguishable from an hour nobody watched.
    assert.equal(heatColor(0, true), 'var(--heat-1)');
    assert.notEqual(heatColor(0, true), heatColor(null, false));
  });

  it('steps monotonically upward across the ramp', () => {
    const steps = [0, 15, 30, 60, 80, 100].map((value) => heatColor(value, true));
    assert.deepEqual(steps, [
      'var(--heat-1)',
      'var(--heat-2)',
      'var(--heat-3)',
      'var(--heat-4)',
      'var(--heat-5)',
      'var(--heat-5)',
    ]);
  });
});

describe('source freshness', () => {
  it('keeps "stale" and "freshness unknown" as different statements', () => {
    // A source whose clock we cannot read is not the same as a source we know
    // to be behind. Collapsing them would overstate what is known.
    assert.equal(
      freshnessText(station({ sourceFreshness: 'stale' })),
      'Source data was already stale when read',
    );
    assert.equal(
      freshnessText(station({ sourceFreshness: 'unknown_source_clock' })),
      'Source freshness unknown',
    );
    assert.notEqual(
      freshnessText(station({ sourceFreshness: 'stale' })),
      freshnessText(station({ sourceFreshness: 'unknown_source_clock' })),
    );
  });

  it('reports freshness as unknown when the source claims fresh but gives no timestamp', () => {
    assert.equal(
      freshnessText(station({ sourceFreshness: 'fresh', sourceUpdatedAtMs: null })),
      'Source freshness unknown',
    );
  });

  it('says "No current status" when there is no freshness at all', () => {
    assert.equal(freshnessText(station({ sourceFreshness: null })), 'No current status');
  });
});

describe('coverage and age line', () => {
  it('omits a missing part instead of substituting a value', () => {
    assert.equal(coverageAndAge(station({ coverage: 97.4, observed: '6 min ago' })), '97% cov · 6 min ago');
    assert.equal(coverageAndAge(station({ coverage: null, observed: '6 min ago' })), '6 min ago');
    assert.equal(coverageAndAge(station({ coverage: 97.4, observed: null })), '97% cov');
    assert.equal(coverageAndAge(station({ coverage: null, observed: null })), '');
  });

  it('shows a genuine zero coverage rather than dropping it', () => {
    assert.equal(coverageAndAge(station({ coverage: 0, observed: null })), '0% cov');
  });
});

describe('relative time', () => {
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);

  it('never reports a future observation as elapsed time', () => {
    // A source clock ahead of ours must not produce "-3 min ago".
    assert.equal(relativeTime(now + 600_000, now), 'just now');
  });

  it('steps through minutes, hours and days', () => {
    assert.equal(relativeTime(now - 30_000, now), 'just now');
    assert.equal(relativeTime(now - 60_000, now), '1 min ago');
    assert.equal(relativeTime(now - 59 * 60_000, now), '59 min ago');
    assert.equal(relativeTime(now - 60 * 60_000, now), '1h ago');
    assert.equal(relativeTime(now - 23 * 3_600_000, now), '23h ago');
    assert.equal(relativeTime(now - 24 * 3_600_000, now), '1d ago');
    assert.equal(relativeTime(now - 10 * 24 * 3_600_000, now), '10d ago');
  });
});

describe('small formatters', () => {
  it('labels hours in the study-area convention', () => {
    assert.equal(hourLabel(0), '12a');
    assert.equal(hourLabel(11), '11a');
    assert.equal(hourLabel(12), '12p');
    assert.equal(hourLabel(23), '11p');
    // Wrapping rather than throwing: an out-of-range hour is a bug elsewhere,
    // and a crash in a label would take the whole view down.
    assert.equal(hourLabel(24), '12a');
    assert.equal(hourLabel(-1), '11p');
  });

  it('formats an ISO date without shifting it into another day', () => {
    // Parsed as UTC deliberately. Local parsing would render 2026-09-01 as
    // "Aug 31" for anyone west of Greenwich, Mesa included.
    assert.equal(isoDateToShort('2026-09-01'), 'Sep 1');
    assert.equal(isoDateToShort('2026-01-31'), 'Jan 31');
    assert.equal(isoDateToShort('not-a-date'), 'not-a-date');
  });

  it('formats durations and byte sizes', () => {
    assert.equal(durationText(59_000), '1 min');
    assert.equal(durationText(48 * 60_000), '48 min');
    assert.equal(durationText(60 * 60_000), '1h');
    assert.equal(durationText(95 * 60_000), '1h 35m');
    assert.equal(bytesText(0), '0 B');
    assert.equal(bytesText(1536), '1.5 KB');
    assert.equal(bytesText(5 * 1024 * 1024), '5.0 MB');
  });

  it('derives initials without crashing on odd names', () => {
    assert.equal(initialsOf('Superstition Springs Center'), 'SS');
    assert.equal(initialsOf('Fiesta'), 'FI');
    assert.equal(initialsOf('   '), '??');
    assert.equal(initialsOf('!!!'), '??');
  });

  it('formats large hour totals without decimals and small ones with one', () => {
    assert.equal(hours(41.24), '41.2');
    assert.equal(hours(1234.5), '1,235');
    assert.equal(hours(0), '0');
  });
});
