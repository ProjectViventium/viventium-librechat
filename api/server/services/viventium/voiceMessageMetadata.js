/* === VIVENTIUM START ===
 * Feature: Voice message correlation metadata.
 * Purpose: Persist enough structured voice-session metadata on normal chat messages so
 * logs, DB rows, browser QA, and cleanup can correlate the same turn without relying
 * on fragile text or timing heuristics.
 * Added: 2026-05-30
 * === VIVENTIUM END === */

function isObjectRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function getHeader(req, name) {
  if (typeof req?.get !== 'function') {
    return '';
  }
  return req.get(name) || req.get(name.toLowerCase()) || '';
}

function attachVoiceMessageMetadata(req, message) {
  const callSessionId = String(req?.viventiumCallSession?.callSessionId || '').trim();
  if (!callSessionId || !isObjectRecord(message)) {
    return message;
  }

  const existingMetadata = isObjectRecord(message.metadata) ? message.metadata : {};
  const existingViventium = isObjectRecord(existingMetadata.viventium)
    ? existingMetadata.viventium
    : {};
  const voiceRequestId = String(
    req?.viventiumVoiceRequestId || getHeader(req, 'X-VIVENTIUM-REQUEST-ID') || '',
  ).trim();
  const surface = String(
    req?.body?.viventiumSurface || existingViventium.surface || 'voice',
  ).trim();
  const inputMode = String(
    req?.body?.viventiumInputMode || existingViventium.inputMode || 'voice_call',
  ).trim();
  const rawMode = req?.body?.mode || req?.viventiumCallSession?.mode;
  const mode = ['call', 'wing', 'listen_only'].includes(rawMode)
    ? rawMode
    : req?.body?.listenOnlyModeEnabled === true
      ? 'listen_only'
      : req?.body?.wingModeEnabled === true
        ? 'wing'
        : 'call';
  const speakerSegments = Array.isArray(req?.body?.speakerSegments) ? req.body.speakerSegments : [];
  const speakerLabel = String(req?.body?.speakerLabel || '')
    .trim()
    .slice(0, 120);
  const actorTrust = String(req?.body?.viventiumActorTrust || 'unknown').trim();
  const voiceTaskId = String(req?.body?.viventiumVoiceTaskId || '')
    .trim()
    .slice(0, 160);

  return {
    ...message,
    metadata: {
      ...existingMetadata,
      viventium: {
        ...existingViventium,
        callSessionId,
        ...(voiceRequestId ? { voiceRequestId } : {}),
        surface: surface || 'voice',
        inputMode: inputMode || 'voice_call',
        mode,
        speakerSegments,
        ...(speakerLabel ? { speakerLabel } : {}),
        actorTrust,
        memoryDeferredPostCall: req?.body?.viventiumDeferVoiceMemory === true,
        ...(voiceTaskId ? { voiceTaskId } : {}),
      },
    },
  };
}

module.exports = {
  attachVoiceMessageMetadata,
};
