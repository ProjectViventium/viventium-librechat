/* === VIVENTIUM START ===
 * Feature: Trusted rapid-input mission partitioning.
 * Purpose: Map Main-visible, non-authoritative 1-based source ordinals back to Core's exact
 * source-event ledger. Every durable sibling receives only its selected text/files; raw source
 * identifiers and attachment paths never enter the model-controlled schema.
 * === VIVENTIUM END === */

function boundedString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function canonicalSourceOrdinals(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .slice(0, 32)
        .map(Number)
        .filter((item) => Number.isInteger(item) && item >= 1 && item <= 32),
    ),
  ).sort((left, right) => left - right);
}

function trustedUploadedFilesFromRequestBody(requestBody = {}) {
  const candidates = Array.isArray(requestBody.files)
    ? requestBody.files
    : Array.isArray(requestBody.attachments)
      ? requestBody.attachments
      : [];
  return candidates.slice(0, 64).flatMap((file, index) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return [];
    const fileId = boundedString(file.file_id || file.temp_file_id, 256);
    const filename = boundedString(file.filename, 512);
    if (!fileId && !filename) return [];
    const mediaGroupIndex = Number(file.media_group_index);
    const safe = {
      ...(fileId ? { file_id: fileId } : {}),
      ...(filename ? { filename } : {}),
      source: boundedString(file.source, 64),
      context: boundedString(file.context, 64),
      type: boundedString(file.type, 160),
      ...(Number.isFinite(Number(file.bytes)) ? { bytes: Math.max(0, Number(file.bytes)) } : {}),
      ...(Number.isInteger(mediaGroupIndex) && mediaGroupIndex >= 0
        ? { media_group_index: mediaGroupIndex }
        : { media_group_index: index }),
      ...(typeof file.text === 'string' ? { text: file.text.slice(0, 256 * 1024) } : {}),
    };
    return [Object.fromEntries(Object.entries(safe).filter(([, value]) => value !== ''))];
  });
}

function selectTrustedLaunchRequestBody(requestBody = {}, sourceOrdinalsValue) {
  const sourceSegments = Array.isArray(requestBody.viventiumTriggeringSourceSegments)
    ? requestBody.viventiumTriggeringSourceSegments
    : [];
  const sourceOrdinals = canonicalSourceOrdinals(sourceOrdinalsValue);
  if (sourceSegments.length <= 1 && sourceOrdinals.length === 0) {
    return { requestBody, sourceOrdinals: sourceSegments.length ? [1] : [] };
  }
  if (sourceSegments.length > 1 && sourceOrdinals.length === 0) {
    return { error: 'source_selection_required' };
  }
  if (sourceOrdinals.some((ordinal) => ordinal > sourceSegments.length)) {
    return { error: 'invalid_source_selection' };
  }
  const selected = sourceSegments.filter((_segment, index) => sourceOrdinals.includes(index + 1));
  if (selected.length !== sourceOrdinals.length) return { error: 'invalid_source_selection' };
  const selectedIdentities = new Set(
    selected.map(
      (segment) =>
        `${boundedString(segment?.source_event_id, 160)}\0${Math.max(
          0,
          Number(segment?.source_index) || 0,
        )}`,
    ),
  );
  const currentSourceIdentity = `${boundedString(
    requestBody.viventiumSourceEventId,
    160,
  )}\u0000${0}`;
  const matchedFiles = (Array.isArray(requestBody.files) ? requestBody.files : []).filter((file) => {
    const sourceEventId = boundedString(file?.source_event_id, 160);
    const sourceIndex = Math.max(0, Number(file?.source_index) || 0);
    if (sourceEventId) return selectedIdentities.has(`${sourceEventId}\0${sourceIndex}`);
    // Legacy current-request files may be inferred only for the current source. With multiple
    // unresolved sources, an unbound historical file is ambiguous and must never be smeared.
    return selectedIdentities.size === 1 && selectedIdentities.has(currentSourceIdentity);
  });
  // Project only opaque identifiers and safe metadata beyond the Core trust boundary. Local
  // paths, transport ids, and model-supplied routing never accompany the mission request.
  const files = trustedUploadedFilesFromRequestBody({ files: matchedFiles }).map((safe, index) => {
    const source = matchedFiles[index] || {};
    const sourceEventId = boundedString(source.source_event_id, 160);
    return {
      ...safe,
      ...(sourceEventId ? { source_event_id: sourceEventId } : {}),
      source_index: Math.max(0, Number(source.source_index) || 0),
    };
  });
  const selectedRequestBody = {
    ...requestBody,
    viventiumSourceEventId: boundedString(selected[0]?.source_event_id, 160),
    viventiumTriggeringSourceSegments: selected.map((segment, ordinal) => ({
      ...segment,
      ordinal,
    })),
    files,
    attachments: files,
    file_ids: files.map((file) => file?.file_id).filter(Boolean),
  };
  return { requestBody: selectedRequestBody, sourceOrdinals };
}

module.exports = {
  canonicalSourceOrdinals,
  selectTrustedLaunchRequestBody,
  trustedUploadedFilesFromRequestBody,
};
