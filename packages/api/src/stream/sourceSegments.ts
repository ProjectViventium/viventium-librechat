import { normalizeInteractionSourceSegments } from '../glasshive/interactionSourceSegments';
import type { InteractionSourceSegment } from '../glasshive/interactionSourceSegments';

/** Exact source retention in the logical-turn ledger; presentation previews have separate owners. */
export interface NormalizedSourceSegments {
  segments: InteractionSourceSegment[];
  overflowCount: number;
}

export function normalizeSourceSegmentsWithOverflow(
  candidates: InteractionSourceSegment[] | undefined,
  priorOverflowCount = 0,
): NormalizedSourceSegments {
  const normalized = normalizeInteractionSourceSegments(candidates, priorOverflowCount);
  return {
    segments: normalized.segments.map((segment) => ({ ...segment })),
    overflowCount: normalized.overflowCount,
  };
}

export function normalizeSourceSegments(
  candidates: InteractionSourceSegment[] | undefined,
): InteractionSourceSegment[] {
  return normalizeSourceSegmentsWithOverflow(candidates).segments;
}

/** Identity dedupe only: two distinct events with identical text remain distinct and ordered. */
export function mergeSourceSegments(
  existing: InteractionSourceSegment[] | undefined,
  incoming: InteractionSourceSegment[] | undefined,
): InteractionSourceSegment[] {
  return normalizeSourceSegments([...(existing || []), ...(incoming || [])]);
}

export function mergeSourceSegmentsWithOverflow(
  existing: InteractionSourceSegment[] | undefined,
  incoming: InteractionSourceSegment[] | undefined,
  existingOverflowCount = 0,
  incomingOverflowCount = 0,
): NormalizedSourceSegments {
  return normalizeSourceSegmentsWithOverflow(
    [...(existing || []), ...(incoming || [])],
    Math.max(0, Math.floor(Number(existingOverflowCount) || 0)) +
      Math.max(0, Math.floor(Number(incomingOverflowCount) || 0)),
  );
}
