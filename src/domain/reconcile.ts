/**
 * Count reconciliation and validation.
 *
 * The central rule: a residual is never assigned to a state the source did not
 * report. Knowing `available` and a scope `total` does NOT let us compute
 * `occupied = total - available`, because the remainder can be reserved,
 * out of service or genuinely unknown. Residuals go to `unknown`, and only
 * when every other dimension is explicitly reported can a residual be zero-
 * checked against the total.
 */

import type { StateCounts } from './types.ts';

export type ReconcileErrorCode =
  | 'negative_count'
  | 'non_integer_count'
  | 'explicit_exceeds_total'
  | 'total_out_of_range'
  | 'no_counts_reported';

export interface ReconcileFailure {
  readonly ok: false;
  readonly code: ReconcileErrorCode;
  readonly detail: string;
}

export interface ReconciledCounts {
  readonly available: number | null;
  readonly occupied: number | null;
  readonly reserved: number | null;
  readonly outOfService: number | null;
  /** Explicitly reported unknowns plus any unattributable residual. */
  readonly unknown: number | null;
  /** Reconciled scope total, when the source supports one. */
  readonly total: number | null;
  /**
   * Sum of ports whose state is explicitly known (available, occupied,
   * reserved, out_of_service). Explicit offline and reserved ports ARE known
   * states; unknown ports are not.
   */
  readonly knownStateCount: number | null;
  /** available + occupied — the observed operational denominator. */
  readonly operationalCount: number | null;
  /** True when both available and occupied are explicitly reported. */
  readonly supportsOccupancy: boolean;
  /** True when a residual had to be attributed to `unknown`. */
  readonly hasResidualUnknown: boolean;
}

export interface ReconcileSuccess {
  readonly ok: true;
  readonly value: ReconciledCounts;
}

export type ReconcileResult = ReconcileSuccess | ReconcileFailure;

const MAX_PORTS = 10_000;

function checkDimension(name: string, value: number | null): ReconcileFailure | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, code: 'non_integer_count', detail: `${name} is not a finite number` };
  }
  if (!Number.isInteger(value)) {
    return { ok: false, code: 'non_integer_count', detail: `${name}=${value} is not an integer` };
  }
  if (value < 0) {
    return { ok: false, code: 'negative_count', detail: `${name}=${value} is negative` };
  }
  if (value > MAX_PORTS) {
    return {
      ok: false,
      code: 'total_out_of_range',
      detail: `${name}=${value} exceeds the ${MAX_PORTS}-port sanity bound`,
    };
  }
  return null;
}

/**
 * Validates and reconciles a source's reported counts.
 *
 * @param counts Raw reported counts, with null for anything not reported.
 * @param installedCapacity Known installed capacity for the scope, when the
 *   catalog provides one. Used only as an upper sanity bound, never to invent
 *   a total the source did not report.
 */
export function reconcileCounts(
  counts: StateCounts,
  installedCapacity: number | null = null,
): ReconcileResult {
  const dims: Array<[string, number | null]> = [
    ['available', counts.available],
    ['occupied', counts.occupied],
    ['reserved', counts.reserved],
    ['outOfService', counts.outOfService],
    ['unknown', counts.unknown],
    ['total', counts.total],
  ];
  for (const [name, value] of dims) {
    const failure = checkDimension(name, value);
    if (failure) return failure;
  }

  const reported = dims.filter(([name]) => name !== 'total').some(([, v]) => v !== null);
  if (!reported && counts.total === null) {
    return { ok: false, code: 'no_counts_reported', detail: 'no state dimension was reported' };
  }

  const explicitStates = [counts.available, counts.occupied, counts.reserved, counts.outOfService];
  const explicitKnownSum = explicitStates.reduce<number>((sum, v) => sum + (v ?? 0), 0);
  const explicitUnknown = counts.unknown ?? 0;
  const explicitAllSum = explicitKnownSum + explicitUnknown;

  let total = counts.total;
  if (total !== null && total < explicitAllSum) {
    return {
      ok: false,
      code: 'explicit_exceeds_total',
      detail: `reported states sum to ${explicitAllSum} which exceeds total=${total}`,
    };
  }
  if (
    total === null &&
    installedCapacity !== null &&
    explicitAllSum > installedCapacity &&
    // Only a hard contradiction is rejected; a source legitimately reporting
    // more ports than a stale catalog row is a capacity-drift warning, handled
    // by the caller, not an invalid observation.
    explicitAllSum > installedCapacity * 4
  ) {
    return {
      ok: false,
      code: 'explicit_exceeds_total',
      detail: `reported states sum to ${explicitAllSum}, implausible against catalog capacity ${installedCapacity}`,
    };
  }

  // A residual exists only when the source gave us a total to reconcile against.
  let unknown = counts.unknown;
  let hasResidualUnknown = false;
  if (total !== null) {
    const residual = total - explicitAllSum;
    if (residual > 0) {
      unknown = explicitUnknown + residual;
      hasResidualUnknown = true;
    } else if (unknown === null && residual === 0 && explicitKnownSum > 0) {
      // Everything in the scope is accounted for by explicit states.
      unknown = 0;
    }
  }

  // Only ports whose state the source actually named count as "known state".
  const anyExplicitKnown = explicitStates.some((v) => v !== null);
  const knownStateCount = anyExplicitKnown ? explicitKnownSum : null;

  const supportsOccupancy = counts.available !== null && counts.occupied !== null;
  const operationalCount = supportsOccupancy ? counts.available + counts.occupied : null;

  if (total === null && anyExplicitKnown) {
    // Derive a scope total only from what was actually reported.
    total = explicitAllSum;
  }

  return {
    ok: true,
    value: {
      available: counts.available,
      occupied: counts.occupied,
      reserved: counts.reserved,
      outOfService: counts.outOfService,
      unknown,
      total,
      knownStateCount,
      operationalCount,
      supportsOccupancy,
      hasResidualUnknown,
    },
  };
}
