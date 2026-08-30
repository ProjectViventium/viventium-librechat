/* === VIVENTIUM START === Bounded trusted interaction-source projection for delegation. === */
import { createHash } from 'crypto';

const SOURCE_SEGMENT_MAX_BYTES = 32 * 1024;
const SOURCE_SEGMENTS_MAX_BYTES = 64 * 1024;
const SOURCE_SEGMENTS_MAX_COUNT = 32;
const SOURCE_FILES_MAX_PER_SEGMENT = 32;

type UnknownRecord = Record<string, unknown>;

function recordFrom(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function boundedIdentifier(value: unknown, maxLength = 160): string {
  return String(value || '')
    .trim()
    .slice(0, maxLength);
}

function clipUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1] || '')) low -= 1;
  return { text: value.slice(0, low), truncated: true };
}

export interface InteractionSourceFile {
  file_id: string;
  filename?: string;
  type?: string;
  bytes?: number;
  media_group_index?: number;
}

export interface InteractionSourceSegment {
  ordinal: number;
  source_event_id: string;
  source_index: number;
  text: string;
  source_files?: readonly InteractionSourceFile[];
  truncated?: true;
  original_sha256?: string;
}

function normalizeInteractionSourceFiles(candidates: unknown): readonly InteractionSourceFile[] {
  const result: InteractionSourceFile[] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(candidates) ? candidates : []) {
    if (result.length >= SOURCE_FILES_MAX_PER_SEGMENT) break;
    const candidate = recordFrom(value);
    const fileId = boundedIdentifier(candidate.file_id || candidate.temp_file_id, 256);
    if (!fileId || seen.has(fileId)) continue;
    seen.add(fileId);
    const mediaGroupIndex = Number(
      candidate.media_group_index ?? candidate.viventium_media_group_index,
    );
    result.push(
      Object.freeze({
        file_id: fileId,
        ...(boundedIdentifier(candidate.filename, 512)
          ? { filename: boundedIdentifier(candidate.filename, 512) }
          : {}),
        ...(boundedIdentifier(candidate.type, 160)
          ? { type: boundedIdentifier(candidate.type, 160) }
          : {}),
        ...(Number.isFinite(Number(candidate.bytes ?? candidate.size))
          ? { bytes: Math.max(0, Number(candidate.bytes ?? candidate.size)) }
          : {}),
        ...(Number.isInteger(mediaGroupIndex) && mediaGroupIndex >= 0
          ? { media_group_index: mediaGroupIndex }
          : {}),
      }),
    );
  }
  return Object.freeze(result);
}

export function normalizeInteractionSourceSegments(
  candidates: unknown = [],
  priorOverflowCount: unknown = 0,
): Readonly<{ segments: readonly InteractionSourceSegment[]; overflowCount: number }> {
  const result: InteractionSourceSegment[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let overflowCount = Math.max(0, Math.floor(Number(priorOverflowCount) || 0));
  for (const value of Array.isArray(candidates) ? candidates : []) {
    const candidate = recordFrom(value);
    const sourceEventId = boundedIdentifier(candidate.source_event_id);
    const sourceIndex = Math.max(0, Math.floor(Number(candidate.source_index) || 0));
    const identity = `${sourceEventId}\0${sourceIndex}`;
    const sourceFiles = normalizeInteractionSourceFiles(candidate.source_files);
    if (!sourceEventId || seen.has(identity) || typeof candidate.text !== 'string') continue;
    const clipped = clipUtf8(candidate.text, SOURCE_SEGMENT_MAX_BYTES);
    if (!clipped.text.length && sourceFiles.length === 0) continue;
    const suppliedDigest = boundedIdentifier(candidate.original_sha256, 64).toLowerCase();
    const truncated = candidate.truncated === true || clipped.truncated;
    result.push(
      Object.freeze({
        ordinal: 0,
        source_event_id: sourceEventId,
        source_index: sourceIndex,
        text: clipped.text,
        ...(sourceFiles.length ? { source_files: sourceFiles } : {}),
        ...(truncated
          ? {
              truncated: true as const,
              original_sha256: /^[a-f0-9]{64}$/.test(suppliedDigest)
                ? suppliedDigest
                : createHash('sha256').update(candidate.text, 'utf8').digest('hex'),
            }
          : {}),
      }),
    );
    seen.add(identity);
    totalBytes += Buffer.byteLength(clipped.text, 'utf8');
    while (result.length > SOURCE_SEGMENTS_MAX_COUNT || totalBytes > SOURCE_SEGMENTS_MAX_BYTES) {
      const evicted = result.shift();
      if (!evicted) break;
      totalBytes -= Buffer.byteLength(evicted.text, 'utf8');
      overflowCount += 1;
    }
  }
  return Object.freeze({
    segments: Object.freeze(
      result.map((segment, ordinal) => Object.freeze({ ...segment, ordinal })),
    ),
    overflowCount,
  });
}

/* === VIVENTIUM END === */
