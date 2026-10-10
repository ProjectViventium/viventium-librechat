/* === VIVENTIUM START ===
 * Feature: Historical voice control-marker read repair.
 * Purpose: Hide exact malformed no-response-only rows without rewriting model-authored words.
 * Stream snapshots are normalized at their typed event boundary; lexical repetition alone cannot
 * prove that historical text is a transport artifact.
 * Added: 2026-05-30
 * === VIVENTIUM END === */

const MALFORMED_NO_RESPONSE_RE = /^\s*(?:\{NTA\}|\{N\{NTATA\}\}|\{NTA|\{N\{NTA\})\s*$/i;
function normalizeHistoricalVoiceText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return text;
  }
  if (MALFORMED_NO_RESPONSE_RE.test(text)) {
    return '';
  }
  return text;
}

function normalizeContentPart(part) {
  if (!part || typeof part !== 'object' || part.type !== 'text') {
    return part;
  }
  if (typeof part.text === 'string') {
    const normalized = normalizeHistoricalVoiceText(part.text);
    return normalized === part.text ? part : { ...part, text: normalized };
  }
  if (part.text && typeof part.text === 'object' && typeof part.text.value === 'string') {
    const normalized = normalizeHistoricalVoiceText(part.text.value);
    return normalized === part.text.value
      ? part
      : { ...part, text: { ...part.text, value: normalized } };
  }
  return part;
}

function normalizeHistoricalVoiceMessageForRead(message) {
  if (!message || message.isCreatedByUser === true) {
    return message;
  }

  let changed = false;
  const nextMessage = { ...message };
  if (typeof nextMessage.text === 'string') {
    const normalizedText = normalizeHistoricalVoiceText(nextMessage.text);
    if (normalizedText !== nextMessage.text) {
      nextMessage.text = normalizedText;
      changed = true;
    }
  }

  if (Array.isArray(nextMessage.content)) {
    const normalizedContent = nextMessage.content.map((part) => {
      const normalized = normalizeContentPart(part);
      if (normalized !== part) {
        changed = true;
      }
      return normalized;
    });
    if (changed) {
      nextMessage.content = normalizedContent;
    }
  }

  return changed ? nextMessage : message;
}

module.exports = {
  normalizeHistoricalVoiceText,
  normalizeHistoricalVoiceMessageForRead,
};
