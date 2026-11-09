/* === VIVENTIUM START ===
 * Feature: Trusted rapid-input mission partitioning.
 * Purpose: Map Main-visible, non-authoritative 1-based source ordinals back to Core's exact
 * source-event ledger. Every durable sibling receives only its selected text/files; raw source
 * identifiers and attachment paths never enter the model-controlled schema.
 * === VIVENTIUM END === */

import { createHash } from 'crypto';

type UnknownRecord = Record<string, unknown>;

export type SourceSelectionError = 'source_selection_required' | 'invalid_source_selection' | 'current_task_source_unavailable';

export type SourceSelectionResult =
  { requestBody: UnknownRecord; sourceOrdinals: number[] } | { error: SourceSelectionError };

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordFrom(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/** A bounded UI preview is not the task. Resolve its exact bytes from existing authorized context. */
function completeSelectedSources(body: UnknownRecord, sources: unknown[], ordinals: number[]) {
  const inherited = recordFrom(body.viventiumInheritedConversation);
  const context = Array.isArray(inherited.sources) ? inherited.sources : [];
  return sources.map((value, index) => {
    const source = recordFrom(value);
    if (source.truncated !== true) return source;
    const originalHash = source.original_sha256;
    if (typeof originalHash !== 'string') return null;
    const candidates = context.flatMap((entry) => {
      const item = recordFrom(entry);
      return item.current_input === true && Array.isArray(item.source_ordinals) &&
        item.source_ordinals.includes(ordinals[index]) && typeof item.text === 'string'
        ? [item.text] : [];
    });
    if (source.source_event_id === body.viventiumSourceEventId && typeof body.text === 'string') {
      candidates.push(body.text);
    }
    const text = candidates.find((candidate) => createHash('sha256').update(candidate, 'utf8').digest('hex') === originalHash);
    if (text === undefined) return null;
    const { truncated: _previewOnly, original_sha256: _previewDigest, ...original } = source;
    return { ...original, text };
  });
}

export function canonicalSourceOrdinals(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map(Number)
        .filter((item) => Number.isSafeInteger(item) && item >= 1),
    ),
  ).sort((left, right) => left - right);
}

export function trustedUploadedFilesFromRequestBody(
  requestBody: UnknownRecord = {},
): UnknownRecord[] {
  let candidates: unknown[] = [];
  if (Array.isArray(requestBody.files)) {
    candidates = requestBody.files;
  } else if (Array.isArray(requestBody.attachments)) {
    candidates = requestBody.attachments;
  }

  return candidates.flatMap((candidate, index) => {
    if (!isRecord(candidate)) {
      return [];
    }

    const fileId = boundedString(candidate.file_id || candidate.temp_file_id, 256);
    const filename = boundedString(candidate.filename, 512);
    if (!fileId && !filename) {
      return [];
    }

    const mediaGroupIndex = Number(candidate.media_group_index);
    const bytes = Number(candidate.bytes);
    const safe: UnknownRecord = {
      ...(fileId ? { file_id: fileId } : {}),
      ...(filename ? { filename } : {}),
      source: boundedString(candidate.source, 64),
      context: boundedString(candidate.context, 64),
      type: boundedString(candidate.type, 160),
      ...(Number.isFinite(bytes) ? { bytes: Math.max(0, bytes) } : {}),
      ...(Number.isInteger(mediaGroupIndex) && mediaGroupIndex >= 0
        ? { media_group_index: mediaGroupIndex }
        : { media_group_index: index }),
      ...(typeof candidate.text === 'string' ? { text: candidate.text } : {}),
    };

    return [
      Object.fromEntries(
        Object.entries(safe).filter(([key, item]) => key === 'text' || item !== ''),
      ),
    ];
  });
}

/** Select a task clause without rewriting or granting authority over unrelated source text. */
export function selectTrustedSourceInstruction(
  originals: readonly string[],
  instruction?: unknown,
): string | undefined {
  if (instruction === undefined) return undefined;
  if (
    typeof instruction !== 'string' ||
    !instruction.trim() ||
    instruction.trim() !== instruction ||
    !originals.some((text) => text.includes(instruction))
  ) {
    throw Object.assign(new Error('invalid_source_instruction_selection'), {
      code: 'invalid_source_instruction_selection',
    });
  }
  return instruction;
}

export function selectTrustedLaunchRequestBody(
  requestBody: UnknownRecord = {},
  sourceOrdinalsValue?: unknown,
): SourceSelectionResult {
  const sourceSegments = Array.isArray(requestBody.viventiumTriggeringSourceSegments)
    ? requestBody.viventiumTriggeringSourceSegments
    : [];
  const sourceOrdinals = canonicalSourceOrdinals(sourceOrdinalsValue);

  if (sourceSegments.length === 1) {
    const full = completeSelectedSources(requestBody, sourceSegments, [1]);
    if (full.some((source) => source === null)) return { error: 'current_task_source_unavailable' };
    return { requestBody: { ...requestBody, viventiumTriggeringSourceSegments: full }, sourceOrdinals: [1] };
  }
  if (sourceSegments.length === 0 && sourceOrdinals.length === 0) {
    return { requestBody, sourceOrdinals: [] };
  }
  if (sourceSegments.length > 1 && sourceOrdinals.length === 0) {
    return { error: 'source_selection_required' };
  }
  if (sourceOrdinals.some((ordinal) => ordinal > sourceSegments.length)) {
    return { error: 'invalid_source_selection' };
  }

  const selected = sourceSegments.filter((_segment, index) => sourceOrdinals.includes(index + 1));
  if (selected.length !== sourceOrdinals.length) {
    return { error: 'invalid_source_selection' };
  }
  const fullSelected = completeSelectedSources(requestBody, selected, sourceOrdinals);
  if (fullSelected.some((source) => source === null)) return { error: 'current_task_source_unavailable' };

  const selectedIdentities = new Set(
    selected.map((segment) => {
      const source = recordFrom(segment);
      return `${boundedString(source.source_event_id, 160)}\0${Math.max(
        0,
        Number(source.source_index) || 0,
      )}`;
    }),
  );
  const currentSourceIdentity = `${boundedString(requestBody.viventiumSourceEventId, 160)}\0${0}`;
  const requestFiles = Array.isArray(requestBody.files) ? requestBody.files : [];
  const matchedFiles = requestFiles.filter((candidate) => {
    const file = recordFrom(candidate);
    const sourceEventId = boundedString(file.source_event_id, 160);
    const sourceIndex = Math.max(0, Number(file.source_index) || 0);
    if (sourceEventId) {
      return selectedIdentities.has(`${sourceEventId}\0${sourceIndex}`);
    }

    // Legacy current-request files may be inferred only for the current source. With multiple
    // unresolved sources, an unbound historical file is ambiguous and must never be smeared.
    return selectedIdentities.size === 1 && selectedIdentities.has(currentSourceIdentity);
  });

  // Project only opaque identifiers and safe metadata beyond the Core trust boundary. Local
  // paths, transport ids, and model-supplied routing never accompany the mission request.
  const files = trustedUploadedFilesFromRequestBody({ files: matchedFiles }).map(
    (safe, index): UnknownRecord => {
      const source = recordFrom(matchedFiles[index]);
      const sourceEventId = boundedString(source.source_event_id, 160);
      return {
        ...safe,
        ...(sourceEventId ? { source_event_id: sourceEventId } : {}),
        source_index: Math.max(0, Number(source.source_index) || 0),
      };
    },
  );

  const selectedRequestBody: UnknownRecord = {
    ...requestBody,
    viventiumSourceEventId: boundedString(recordFrom(selected[0]).source_event_id, 160),
    viventiumTriggeringSourceSegments: fullSelected.map((segment, ordinal) => ({
      ...recordFrom(segment),
      ordinal,
    })),
    files,
    attachments: files,
    file_ids: files.map((file) => file.file_id).filter(Boolean),
  };

  return { requestBody: selectedRequestBody, sourceOrdinals };
}
