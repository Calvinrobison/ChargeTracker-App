/**
 * Test helpers for the dependency-free domain suite.
 *
 * These tests run under `node --experimental-strip-types --test` so the
 * correctness-critical domain logic can be executed without a package install.
 * The same specs are re-run by Vitest via tests/unit/domain.test.ts.
 */

import type {
  CapacityRecord,
  ChargingLevel,
  CollectionGap,
  FreshnessPolicy,
  MonitoringWindow,
  QualityClass,
  StateCounts,
  StatusSnapshot,
} from '../../src/domain/types.ts';
import { DEFAULT_FRESHNESS_POLICY } from '../../src/domain/types.ts';

/** A fixed, readable base instant: 2026-09-01T00:00:00Z. */
export const T0 = Date.UTC(2026, 8, 1, 0, 0, 0, 0);
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

let counter = 0;

export interface SnapshotOverrides {
  readonly scopeKey?: string;
  readonly observedAtUtcMs?: number;
  readonly sourceUpdatedAtUtcMs?: number | null;
  readonly available?: number | null;
  readonly occupied?: number | null;
  readonly reserved?: number | null;
  readonly outOfService?: number | null;
  readonly unknown?: number | null;
  readonly total?: number | null;
  readonly quality?: QualityClass;
  readonly completeness?: 'complete' | 'partial';
  readonly level?: ChargingLevel;
  readonly distinguishesCharging?: boolean;
  readonly freshnessPolicy?: FreshnessPolicy;
}

export function snapshot(overrides: SnapshotOverrides = {}): StatusSnapshot {
  counter += 1;
  const counts: StateCounts = {
    available: overrides.available ?? null,
    occupied: overrides.occupied ?? null,
    reserved: overrides.reserved ?? null,
    outOfService: overrides.outOfService ?? null,
    unknown: overrides.unknown ?? null,
    total: overrides.total ?? null,
  };
  return {
    observationId: `obs-${String(counter).padStart(5, '0')}`,
    bindingId: 'binding-1',
    scopeKey: overrides.scopeKey ?? 'scope-1',
    observedAtUtcMs: overrides.observedAtUtcMs ?? T0,
    sourceUpdatedAtUtcMs:
      overrides.sourceUpdatedAtUtcMs === undefined ? null : overrides.sourceUpdatedAtUtcMs,
    method: 'rendered_dom',
    granularity: 'station_aggregate',
    counts,
    capacityBasis: 'ports_simultaneous',
    completeness: overrides.completeness ?? 'complete',
    quality: overrides.quality ?? 'reliable',
    freshnessPolicy: overrides.freshnessPolicy ?? DEFAULT_FRESHNESS_POLICY,
    level: overrides.level ?? 'dc_fast',
    distinguishesCharging: overrides.distinguishesCharging ?? false,
  };
}

export function monitoring(
  startMs: number,
  endMs: number | null = null,
  scopeKey = 'scope-1',
): MonitoringWindow {
  return { scopeKey, startMs, endMs };
}

export function capacity(
  capacityPorts: number,
  startMs = 0,
  endMs: number | null = null,
  scopeKey = 'scope-1',
  level: ChargingLevel = 'dc_fast',
): CapacityRecord {
  return { scopeKey, startMs, endMs, capacityPorts, level, basis: 'ports_simultaneous' };
}

export function gap(
  startMs: number,
  endMs: number,
  reason: CollectionGap['reason'] = 'computer_asleep',
  scopeKey: string | null = 'scope-1',
): CollectionGap {
  return { scopeKey, startMs, endMs, reason };
}

/** Rounds to a fixed number of decimals for readable assertions. */
export function round(value: number | null, decimals = 6): number | null {
  if (value === null) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
