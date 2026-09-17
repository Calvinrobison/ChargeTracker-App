/**
 * Episode inference and censoring (implementation prompt §16).
 *
 * Run: node --experimental-strip-types --test tests/nodeps/episodes.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { PortSnapshot, PortState } from '../../src/domain/types.ts';
import {
  activityCapability,
  detectPortEpisodes,
  observedOccupiedIncreases,
} from '../../src/domain/episodes.ts';
import { MIN, T0 } from './helpers.ts';

let seq = 0;
function port(
  state: PortState,
  offsetMinutes: number,
  sourcePortId = 'p1',
  scopeKey = 'scope-1',
): PortSnapshot {
  seq += 1;
  return {
    observationId: `p-${seq}`,
    scopeKey,
    sourcePortId,
    observedAtUtcMs: T0 + offsetMinutes * MIN,
    state,
    level: 'dc_fast',
  };
}

describe('detected occupancy starts', () => {
  test('an available-to-occupied transition brackets a start between the two readings', () => {
    const result = detectPortEpisodes([
      port('available', 0),
      port('occupied', 15),
      port('available', 45),
    ]);

    assert.equal(result.episodes.length, 1);
    const ep = result.episodes[0];
    assert.equal(ep?.startLowerMs, T0);
    assert.equal(ep?.startUpperMs, T0 + 15 * MIN);
    assert.equal(ep?.endLowerMs, T0 + 15 * MIN);
    assert.equal(ep?.endUpperMs, T0 + 45 * MIN);
    assert.equal(ep?.leftCensored, false);
    assert.equal(ep?.rightCensored, false);
    assert.equal(result.detectedStartCount, 1);
  });

  test('a first sample already occupied is left-censored, not a detected arrival', () => {
    const result = detectPortEpisodes([port('occupied', 0), port('available', 15)]);

    assert.equal(result.episodes.length, 1);
    assert.equal(result.episodes[0]?.leftCensored, true);
    assert.equal(result.episodes[0]?.startLowerMs, null, 'the arrival time is unbounded below');
    assert.equal(result.detectedStartCount, 0, 'it must not be counted as a start');
    assert.equal(result.leftCensoredCount, 1);
  });

  test('a final occupied sample is right-censored, not a completed session', () => {
    const result = detectPortEpisodes([port('available', 0), port('occupied', 15)]);

    assert.equal(result.episodes.length, 1);
    assert.equal(result.episodes[0]?.rightCensored, true);
    assert.equal(result.episodes[0]?.endUpperMs, null, 'the end is unbounded above');
    assert.equal(result.rightCensoredCount, 1);
  });

  test('an unknown state breaks continuity instead of being guessed', () => {
    const result = detectPortEpisodes([
      port('available', 0),
      port('occupied', 15),
      port('unknown', 30),
      port('occupied', 45),
      port('available', 60),
    ]);

    assert.equal(result.episodes.length, 2, 'two interrupted episodes, not one long one');
    assert.equal(result.episodes[0]?.interrupted, true);
    assert.equal(result.episodes[1]?.leftCensored, true, 'the second start was not observed');
    assert.equal(result.detectedStartCount, 1);
  });

  test('episodes are not joined across a recorded collection gap', () => {
    const result = detectPortEpisodes(
      [port('available', 0), port('occupied', 15), port('occupied', 200), port('available', 215)],
      { continuityBreaks: [{ startMs: T0 + 20 * MIN, endMs: T0 + 195 * MIN }] },
    );

    assert.equal(result.episodes.length, 2);
    assert.equal(result.episodes[0]?.interrupted, true);
    assert.equal(result.episodes[0]?.rightCensored, true);
    assert.equal(result.episodes[1]?.leftCensored, true);
    assert.equal(result.detectedStartCount, 1, 'the post-gap occupancy is not a new arrival');
  });

  test('a long unexplained observation gap also breaks continuity', () => {
    const result = detectPortEpisodes(
      [port('available', 0), port('occupied', 15), port('occupied', 600)],
      { maxObservationGapMs: 45 * MIN },
    );
    assert.equal(result.episodes.length, 2);
    assert.equal(result.interruptedCount >= 1, true);
  });

  test('a very short flip is flagged uncertain, not debounced out of history', () => {
    const result = detectPortEpisodes(
      [port('available', 0), port('occupied', 2), port('available', 4)],
      { shortFlipMs: 15 * MIN },
    );
    assert.equal(result.episodes.length, 1, 'the real source states are retained');
    assert.equal(result.episodes[0]?.uncertainShortFlip, true);
  });

  test('two ports are tracked independently and never merged', () => {
    const result = detectPortEpisodes([
      port('available', 0, 'p1'),
      port('available', 0, 'p2'),
      port('occupied', 15, 'p1'),
      port('occupied', 15, 'p2'),
      port('available', 30, 'p1'),
      port('available', 30, 'p2'),
    ]);
    assert.equal(result.episodes.length, 2);
    assert.deepEqual(
      [...new Set(result.episodes.map((e) => e.sourcePortId))].sort(),
      ['p1', 'p2'],
    );
  });

  test('every episode carries its supporting observation ids and inference version', () => {
    const result = detectPortEpisodes([
      port('available', 0),
      port('occupied', 15),
      port('occupied', 30),
      port('available', 45),
    ]);
    const ep = result.episodes[0];
    assert.ok((ep?.supportingObservationIds.length ?? 0) >= 2);
    assert.equal(ep?.inferenceVersion, result.inferenceVersion);
  });
});

describe('aggregate-only sources', () => {
  test('an identical repeated status produces no inferred activity', () => {
    const observations = [0, 15, 30, 45].map((m) => ({
      observationId: `a-${m}`,
      observedAtUtcMs: T0 + m * MIN,
      occupied: 1,
    }));
    const result = observedOccupiedIncreases(observations);
    assert.equal(result.observedIncreaseCount, 0, 'four observations, zero inferred arrivals');
    assert.equal(result.comparablePairCount, 3);
  });

  test('increases are counted as count changes with an explicit caveat', () => {
    const result = observedOccupiedIncreases([
      { observationId: 'a', observedAtUtcMs: T0, occupied: 1 },
      { observationId: 'b', observedAtUtcMs: T0 + 15 * MIN, occupied: 3 },
      { observationId: 'c', observedAtUtcMs: T0 + 30 * MIN, occupied: 2 },
    ]);
    assert.equal(result.observedIncreaseCount, 1);
    assert.equal(result.observedIncreaseMagnitude, 2);
    assert.match(result.caveat, /Not arrivals/);
  });

  test('pairs spanning a continuity break are not compared', () => {
    const result = observedOccupiedIncreases(
      [
        { observationId: 'a', observedAtUtcMs: T0, occupied: 0 },
        { observationId: 'b', observedAtUtcMs: T0 + 300 * MIN, occupied: 5 },
      ],
      [{ startMs: T0 + 10 * MIN, endMs: T0 + 290 * MIN }],
    );
    assert.equal(result.comparablePairCount, 0);
    assert.equal(result.observedIncreaseCount, 0);
  });

  test('null occupied counts are skipped rather than treated as zero', () => {
    const result = observedOccupiedIncreases([
      { observationId: 'a', observedAtUtcMs: T0, occupied: null },
      { observationId: 'b', observedAtUtcMs: T0 + 15 * MIN, occupied: 2 },
    ]);
    assert.equal(result.comparablePairCount, 0);
  });
});

describe('capability gating', () => {
  test('session records require authorized transaction data', () => {
    assert.equal(
      activityCapability({
        hasAuthorizedTransactionData: false,
        hasDurablePortIdentity: true,
        hasAggregateCounts: true,
      }),
      'detected_port_episodes',
    );
    assert.equal(
      activityCapability({
        hasAuthorizedTransactionData: false,
        hasDurablePortIdentity: false,
        hasAggregateCounts: true,
      }),
      'aggregate_count_changes',
    );
    assert.equal(
      activityCapability({
        hasAuthorizedTransactionData: true,
        hasDurablePortIdentity: false,
        hasAggregateCounts: false,
      }),
      'recorded_sessions',
    );
    assert.equal(
      activityCapability({
        hasAuthorizedTransactionData: false,
        hasDurablePortIdentity: false,
        hasAggregateCounts: false,
      }),
      'none',
    );
  });
});
