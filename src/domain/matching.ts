/**
 * Catalog-to-source matching.
 *
 * Order of evidence: durable provider identifier, then address, then
 * coordinates, name and network with a confidence threshold. A fuzzy match is
 * a PROPOSAL requiring review, never proof. Distinct charging banks in one
 * parking lot can be different scopes, so proximity alone never merges them.
 */

import { type Coordinate, distanceMiles, isValidCoordinate } from './geo.ts';

export type MatchBasis =
  | 'durable_provider_id'
  | 'address_and_network'
  | 'coordinates_and_name'
  | 'coordinates_only'
  | 'none';

export type MatchDisposition = 'confirmed' | 'proposed' | 'rejected';

export interface MatchCandidate {
  readonly siteId: string;
  readonly name: string;
  readonly network: string | null;
  readonly normalizedAddress: string | null;
  readonly coordinate: Coordinate | null;
  readonly sourceStationId: string | null;
}

export interface MatchSubject {
  readonly sourceStationId: string | null;
  readonly name: string | null;
  readonly network: string | null;
  readonly normalizedAddress: string | null;
  readonly coordinate: Coordinate | null;
}

export interface MatchProposal {
  readonly siteId: string;
  readonly basis: MatchBasis;
  /** 0-1. Only `durable_provider_id` reaches 1. */
  readonly confidence: number;
  readonly disposition: MatchDisposition;
  readonly distanceMiles: number | null;
  readonly reasons: readonly string[];
}

/** Confidence at or above this is auto-confirmed; below it needs review. */
export const AUTO_CONFIRM_CONFIDENCE = 0.95;
/**
 * Below this a candidate is not even proposed for review.
 *
 * Kept below the coordinates-only score on purpose: a nearby unnamed charger
 * is worth showing a reviewer, and showing it is safe because only
 * `AUTO_CONFIRM_CONFIDENCE` can bind it without a human.
 */
export const MIN_PROPOSAL_CONFIDENCE = 0.5;
/** Maximum separation for a coordinate-assisted proposal, in miles (~150 m). */
export const MAX_COORDINATE_MATCH_MILES = 0.09;

export function normalizeAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\b(street|str)\b/g, 'st')
    .replace(/\b(avenue|ave)\b/g, 'ave')
    .replace(/\b(boulevard|blvd)\b/g, 'blvd')
    .replace(/\b(road|rd)\b/g, 'rd')
    .replace(/\b(drive|dr)\b/g, 'dr')
    .replace(/\b(suite|ste|unit|apt)\b.*$/g, '')
    .replace(/\b(east|e)\b/g, 'e')
    .replace(/\b(west|w)\b/g, 'w')
    .replace(/\b(north|n)\b/g, 'n')
    .replace(/\b(south|s)\b/g, 's')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function normalizeName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Token-overlap similarity in [0, 1]. */
export function nameSimilarity(a: string | null, b: string | null): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = new Set(na.split(' ').filter((t) => t.length > 1));
  const tb = new Set(nb.split(' ').filter((t) => t.length > 1));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  return (2 * shared) / (ta.size + tb.size);
}

/**
 * Proposes matches for one subject against catalog candidates.
 *
 * Returns every candidate above the proposal floor, best first, each with the
 * basis and confidence recorded so a reviewer can see WHY it was proposed.
 * Nothing here writes a binding; the caller records the proposal and its
 * disposition.
 */
export function proposeMatches(
  subject: MatchSubject,
  candidates: readonly MatchCandidate[],
): MatchProposal[] {
  const proposals: MatchProposal[] = [];

  for (const candidate of candidates) {
    const reasons: string[] = [];
    let basis: MatchBasis = 'none';
    let confidence = 0;

    const separation =
      subject.coordinate &&
      candidate.coordinate &&
      isValidCoordinate(subject.coordinate) &&
      isValidCoordinate(candidate.coordinate)
        ? distanceMiles(subject.coordinate, candidate.coordinate)
        : null;

    if (
      subject.sourceStationId &&
      candidate.sourceStationId &&
      subject.sourceStationId === candidate.sourceStationId
    ) {
      basis = 'durable_provider_id';
      confidence = 1;
      reasons.push(`durable provider id ${subject.sourceStationId}`);
    } else {
      const addressMatch =
        subject.normalizedAddress !== null &&
        candidate.normalizedAddress !== null &&
        subject.normalizedAddress === candidate.normalizedAddress;
      const networkMatch =
        subject.network !== null &&
        candidate.network !== null &&
        subject.network.toLowerCase() === candidate.network.toLowerCase();
      const similarity = nameSimilarity(subject.name, candidate.name);
      const closeEnough = separation !== null && separation <= MAX_COORDINATE_MATCH_MILES;

      if (addressMatch && networkMatch) {
        basis = 'address_and_network';
        confidence = 0.9;
        reasons.push('normalized address and network agree');
        if (closeEnough) {
          confidence = 0.93;
          reasons.push(`coordinates agree within ${separation?.toFixed(3)} mi`);
        }
      } else if (closeEnough && similarity >= 0.6) {
        basis = 'coordinates_and_name';
        confidence = 0.7 + 0.2 * similarity;
        reasons.push(
          `coordinates within ${separation?.toFixed(3)} mi and name similarity ${similarity.toFixed(2)}`,
        );
        if (networkMatch) {
          confidence = Math.min(0.92, confidence + 0.05);
          reasons.push('network agrees');
        }
      } else if (closeEnough) {
        // Proximity alone is explicitly not enough to merge: distinct banks in
        // one lot are different scopes.
        basis = 'coordinates_only';
        confidence = 0.55;
        reasons.push(
          `coordinates within ${separation?.toFixed(3)} mi but nothing else agrees; distinct charging banks in one lot are different scopes`,
        );
      }
    }

    if (confidence < MIN_PROPOSAL_CONFIDENCE) continue;

    proposals.push({
      siteId: candidate.siteId,
      basis,
      confidence,
      disposition: confidence >= AUTO_CONFIRM_CONFIDENCE ? 'confirmed' : 'proposed',
      distanceMiles: separation,
      reasons,
    });
  }

  proposals.sort((a, b) => b.confidence - a.confidence || a.siteId.localeCompare(b.siteId));
  return proposals;
}

/**
 * Picks at most one automatic binding.
 *
 * Two candidates at auto-confirm confidence is an ambiguity, not a coin flip:
 * both are downgraded to proposals for review.
 */
export function chooseAutomaticMatch(proposals: readonly MatchProposal[]): MatchProposal | null {
  const confirmed = proposals.filter((p) => p.disposition === 'confirmed');
  if (confirmed.length === 1) return confirmed[0] ?? null;
  return null;
}
