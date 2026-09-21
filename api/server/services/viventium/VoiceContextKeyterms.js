/* === VIVENTIUM START ===
 * Feature: AssemblyAI contextual keyterms
 * Purpose: Project only owner-visible current-conversation artifact display names into the
 * bounded structured hint field supported by the selected realtime STT provider.
 * === VIVENTIUM END === */

const MAX_VOICE_CONTEXT_KEYTERMS = 32;
const MAX_VOICE_CONTEXT_KEYTERM_LENGTH = 96;

function normalizeVoiceContextKeyterm(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.includes('/') || normalized.includes('\\')) return '';
  if ([...normalized].some((character) => character.codePointAt(0) < 0x20)) return '';
  return normalized.slice(0, MAX_VOICE_CONTEXT_KEYTERM_LENGTH).trim();
}

function normalizeVoiceContextKeyterms(candidates) {
  const keyterms = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const keyterm = normalizeVoiceContextKeyterm(candidate);
    const identity = keyterm.toLocaleLowerCase();
    if (!keyterm || seen.has(identity)) continue;
    seen.add(identity);
    keyterms.push(keyterm);
    if (keyterms.length >= MAX_VOICE_CONTEXT_KEYTERMS) break;
  }
  return keyterms;
}

function voiceContextKeytermsFromFiles(files) {
  const candidates = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) continue;
    candidates.push(
      file.filename,
      file.metadata?.meetingTranscriptDisplayTitle,
      file.metadata?.meetingTranscriptOriginalFilename,
    );
  }
  return normalizeVoiceContextKeyterms(candidates);
}

function voiceContextKeytermsFromNativeFiles(nativeFiles) {
  return normalizeVoiceContextKeyterms(
    (Array.isArray(nativeFiles) ? nativeFiles : []).flatMap((file) =>
      file && typeof file === 'object' && !Array.isArray(file) ? [file.filename] : [],
    ),
  );
}

module.exports = {
  MAX_VOICE_CONTEXT_KEYTERMS,
  MAX_VOICE_CONTEXT_KEYTERM_LENGTH,
  normalizeVoiceContextKeyterms,
  voiceContextKeytermsFromFiles,
  voiceContextKeytermsFromNativeFiles,
};
