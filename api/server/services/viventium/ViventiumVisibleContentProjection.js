'use strict';

/* === VIVENTIUM START ===
 * Feature: One truthful visible-text projection for structured assistant content.
 * Purpose: Keep participant and invocation boundaries in legacy text, recall, exports, and
 * provider-history consumers without changing the exact text of an ordinary single-part answer.
 * === VIVENTIUM END === */

const TEXT_CONTENT_TYPE = 'text';
const VISIBLE_CONTENT_SEPARATOR = '\n\n';

function textFromVisibleContentPart(part) {
  if (!part || part.type !== TEXT_CONTENT_TYPE) {
    return '';
  }
  if (typeof part.text === 'string') {
    return part.text;
  }
  if (typeof part.text?.value === 'string') {
    return part.text.value;
  }
  if (typeof part.text?.text === 'string') {
    return part.text.text;
  }
  return '';
}

function visibleTextSegmentsFromContentParts(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .map(textFromVisibleContentPart)
    .filter((text) => typeof text === 'string' && text.trim().length > 0);
}

function projectVisibleTextFromContentParts(content, { trim = false } = {}) {
  const projected = visibleTextSegmentsFromContentParts(content).join(VISIBLE_CONTENT_SEPARATOR);
  return trim ? projected.trim() : projected;
}

module.exports = {
  VISIBLE_CONTENT_SEPARATOR,
  projectVisibleTextFromContentParts,
  textFromVisibleContentPart,
  visibleTextSegmentsFromContentParts,
};
