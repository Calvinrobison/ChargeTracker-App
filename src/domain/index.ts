/**
 * The ChargeWatch domain module.
 *
 * Every metric, threshold, interval rule and inference in the product is
 * defined here once and imported by the renderer, the database worker, the
 * collector, the exporters and the tests. Nothing recomputes a variant.
 *
 * This module intentionally has no runtime dependencies.
 */

export * from './time.ts';
export * from './types.ts';
export * from './reconcile.ts';
export * from './intervals.ts';
export * from './metrics.ts';
export * from './thresholds.ts';
export * from './ranking.ts';
export * from './episodes.ts';
export * from './visits.ts';
export * from './geo.ts';
export * from './matching.ts';
export * from './stalls.ts';
