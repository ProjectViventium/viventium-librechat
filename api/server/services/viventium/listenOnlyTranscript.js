'use strict';

/* === VIVENTIUM START ===
 * Feature: Listen-Only Mode transcript boundary
 * Purpose: Provide a single structural predicate for transcript entries that are visible evidence
 * but must not be treated as live user/assistant chat context.
 * === VIVENTIUM END === */
function isListenOnlyTranscriptMessage(message) {
  const metadata = message?.metadata?.viventium;
  return (
    metadata &&
    typeof metadata === 'object' &&
    metadata.type === 'listen_only_transcript' &&
    metadata.mode === 'listen_only'
  );
}

function isAmbientVoiceTranscriptMessage(message) {
  const metadata = message?.metadata?.viventium;
  return (
    metadata &&
    typeof metadata === 'object' &&
    metadata.type === 'voice_ambient_transcript' &&
    ['authenticated_participant', 'shared_mic_unverified', 'unknown'].includes(metadata.actorTrust)
  );
}

function isPassiveVoiceTranscriptMessage(message) {
  return isListenOnlyTranscriptMessage(message) || isAmbientVoiceTranscriptMessage(message);
}

module.exports = {
  isAmbientVoiceTranscriptMessage,
  isListenOnlyTranscriptMessage,
  isPassiveVoiceTranscriptMessage,
};
