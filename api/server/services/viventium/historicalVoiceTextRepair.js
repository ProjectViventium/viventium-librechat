/* === VIVENTIUM START ===
 * Feature: Historical voice cumulative-snapshot read repair.
 * Purpose: Older voice turns could persist cumulative provider snapshots as if they were deltas,
 * leaving malformed no-response markers or repeated adjacent words in text chat. The streaming
 * write path now normalizes deltas; this read-side guard keeps already-persisted rows from
 * rendering those internal artifacts.
 * Added: 2026-05-30
 * === VIVENTIUM END === */

const MALFORMED_NO_RESPONSE_RE = /^\s*(?:\{NTA\}|\{N\{NTATA\}\}|\{NTA|\{N\{NTA\})\s*$/i;
const JOINED_DUPLICATE_WORD_RE = /\b([A-Za-z][A-Za-z']{1,})\1\b/g;
const ADJACENT_DUPLICATE_WORD_RE = /\b([A-Za-z][A-Za-z']*)\b([\s.,!?;:]+)\1\b/gi;

function collectProtectedRanges(text) {
  const value = String(text || '');
  const ranges = [];

  const addRegexRanges = (regex) => {
    let match;
    while ((match = regex.exec(value))) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  };

  addRegexRanges(/```[\s\S]*?```/g);
  addRegexRanges(/`[^`\n]+`/g);
  addRegexRanges(/"(?:\\.|[^"\\])*"/g);
  addRegexRanges(/“[^”]*”/g);
  addRegexRanges(/‘[^’]*’/g);
  addRegexRanges(/(^|\n)[ \t]*>[^\n]*/g);

  return ranges
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0])
    .reduce((merged, range) => {
      const last = merged[merged.length - 1];
      if (!last || range[0] > last[1]) {
        merged.push(range);
        return merged;
      }
      last[1] = Math.max(last[1], range[1]);
      return merged;
    }, []);
}

function mapUnprotectedText(text, mapper) {
  const value = String(text || '');
  const ranges = collectProtectedRanges(value);
  let cursor = 0;
  let out = '';

  for (const [start, end] of ranges) {
    if (start > cursor) {
      out += mapper(value.slice(cursor, start));
    }
    out += value.slice(start, end);
    cursor = end;
  }

  if (cursor < value.length) {
    out += mapper(value.slice(cursor));
  }
  return out;
}

function countDuplicateArtifacts(text) {
  let count = 0;
  mapUnprotectedText(text, (segment) => {
    const joinedMatches = segment.match(JOINED_DUPLICATE_WORD_RE) || [];
    const adjacentMatches = segment.match(ADJACENT_DUPLICATE_WORD_RE) || [];
    count += joinedMatches.length + adjacentMatches.length;
    return segment;
  });
  return count;
}

function normalizeHistoricalVoiceText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return text;
  }
  if (MALFORMED_NO_RESPONSE_RE.test(text)) {
    return '';
  }
  if (countDuplicateArtifacts(text) < 3) {
    return text;
  }

  return mapUnprotectedText(text, (segment) =>
    segment
      .replace(JOINED_DUPLICATE_WORD_RE, '$1')
      .replace(ADJACENT_DUPLICATE_WORD_RE, '$1')
      .replace(/([.!?])\1+/g, '$1')
      .replace(/[ \t]{2,}/g, ' '),
  ).trim();
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
  collectProtectedRanges,
  countDuplicateArtifacts,
  normalizeHistoricalVoiceText,
  normalizeHistoricalVoiceMessageForRead,
};
