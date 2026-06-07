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
      },
    },
  };
}

module.exports = {
  attachVoiceMessageMetadata,
};
