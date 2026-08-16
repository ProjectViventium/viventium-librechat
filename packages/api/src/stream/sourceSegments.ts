import { createHash } from 'crypto';
import type { InteractionSourceSegment } from './interfaces/IJobStore';

/** VIVENTIUM: bounded exact user-source context carried only inside the logical-turn ledger. */
export const SOURCE_SEGMENT_MAX_BYTES = 32 * 1024;
export const SOURCE_SEGMENTS_MAX_BYTES = 64 * 1024;
export const SOURCE_SEGMENTS_MAX_COUNT = 32;
export const SOURCE_FILES_MAX_PER_SEGMENT = 32;

export interface NormalizedSourceSegments {
  segments: InteractionSourceSegment[];
  overflowCount: number;
}

function normalizeSourceFiles(
  candidates: InteractionSourceSegment['source_files'],
): NonNullable<InteractionSourceSegment['source_files']> {
  const result: NonNullable<InteractionSourceSegment['source_files']> = [];
  const seen = new Set<string>();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (result.length >= SOURCE_FILES_MAX_PER_SEGMENT) break;
    const fileId = String(candidate?.file_id || '').trim().slice(0, 256);
    if (!fileId || seen.has(fileId)) continue;
    seen.add(fileId);
    const filename = String(candidate?.filename || '').trim().slice(0, 512);
    const type = String(candidate?.type || '').trim().slice(0, 160);
    const mediaGroupIndex = Number(candidate?.media_group_index);
    result.push({
      file_id: fileId,
      ...(filename ? { filename } : {}),
      ...(type ? { type } : {}),
      ...(Number.isFinite(Number(candidate?.bytes))
        ? { bytes: Math.max(0, Number(candidate?.bytes)) }
        : {}),
      ...(Number.isInteger(mediaGroupIndex) && mediaGroupIndex >= 0
        ? { media_group_index: mediaGroupIndex }
        : {}),
    });
  }
  return result;
}

function clipUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return { text: value, truncated: false };
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1])) low -= 1;
  return { text: value.slice(0, low), truncated: true };
}

export function normalizeSourceSegmentsWithOverflow(
  candidates: InteractionSourceSegment[] | undefined,
  priorOverflowCount = 0,
): NormalizedSourceSegments {
  const result: InteractionSourceSegment[] = [];
  const seenSegments = new Set<string>();
  let totalBytes = 0;
  let overflowCount = Math.max(0, Math.floor(Number(priorOverflowCount) || 0));
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const sourceEventId = String(candidate?.source_event_id || '').trim().slice(0, 160);
    const sourceIndex = Math.max(0, Math.floor(Number(candidate?.source_index) || 0));
    const sourceIdentity = `${sourceEventId}\u0000${sourceIndex}`;
    const sourceFiles = normalizeSourceFiles(candidate?.source_files);
    if (!sourceEventId || seenSegments.has(sourceIdentity) || typeof candidate?.text !== 'string') {
      continue;
    }
    const clipped = clipUtf8(candidate.text, SOURCE_SEGMENT_MAX_BYTES);
    if (!clipped.text.length && sourceFiles.length === 0) continue;
    const suppliedDigest = String(candidate.original_sha256 || '').trim().toLowerCase();
    const truncated = candidate.truncated === true || clipped.truncated;
    result.push({
      ordinal: 0,
      source_event_id: sourceEventId,
      source_index: sourceIndex,
      text: clipped.text,
      ...(sourceFiles.length ? { source_files: sourceFiles } : {}),
      ...(truncated
        ? {
            truncated: true,
            original_sha256: /^[a-f0-9]{64}$/.test(suppliedDigest)
              ? suppliedDigest
              : createHash('sha256').update(candidate.text, 'utf8').digest('hex'),
          }
        : {}),
    });
    seenSegments.add(sourceIdentity);
    totalBytes += Buffer.byteLength(clipped.text, 'utf8');
    while (
      result.length > SOURCE_SEGMENTS_MAX_COUNT ||
      totalBytes > SOURCE_SEGMENTS_MAX_BYTES
    ) {
      const evicted = result.shift();
      if (!evicted) break;
      totalBytes -= Buffer.byteLength(evicted.text, 'utf8');
      overflowCount += 1;
    }
  }
  return {
    segments: result.map((segment, ordinal) => ({ ...segment, ordinal })),
    overflowCount,
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
