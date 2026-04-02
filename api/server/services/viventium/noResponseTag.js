/* === VIVENTIUM START ===
 * Feature: No Response Tag ({NTA})
 *
 * Purpose:
 * - Provide a single, shared definition for the "no response" marker used in passive/background modes.
 * - Keep parsing strict (exact-match) to avoid suppressing legitimate content that merely references the tag.
 *
 * Added: 2026-02-07
 * === VIVENTIUM END === */

const NO_RESPONSE_TAG = '{NTA}';

// Accept whitespace variants like "{ NTA }" and case variants like "{nta}".
const NO_RESPONSE_TAG_RE = /^\s*\{\s*NTA\s*\}\s*$/i;

// Match a trailing {NTA} at the end of a response (after content).
// The model sometimes generates content then appends {NTA}, violating the
// "output ONLY that token" rule. Strip the tag so it doesn't leak to the user.
const TRAILING_NTA_RE = /\s*\{\s*NTA\s*\}\s*$/i;

// Legacy/noisy phrases we saw in exports; normalize them to {NTA} when they are the *entire* output.
const NO_RESPONSE_PHRASES = new Set([
  'nothing new to add.',
  'nothing new to add',
  'nothing to add.',
  'nothing to add',
]);

const NO_RESPONSE_VARIANT_MAX_LEN = 200;
// Accept short, "no-response-only" variants like "Nothing new to add for now."
// Must be the entire message (not a prefix), to avoid suppressing real content.
const NO_RESPONSE_VARIANT_RE =
  /^\s*nothing\s+(?:new\s+)?to\s+add(?:\s*(?:\(\s*)?(?:right\s+now|for\s+now|at\s+this\s+time|at\s+the\s+moment|currently|so\s+far|yet|today)(?:\s*\))?)?(?:\s*,?\s*(?:sorry|thanks|thank\s+you))?\s*[.!?]*\s*$/i;

function isNoResponseTag(text) {
  if (typeof text !== 'string') {
    return false;
  }
  return NO_RESPONSE_TAG_RE.test(text);
}

function isNoResponseOnly(text) {
  if (typeof text !== 'string') {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (NO_RESPONSE_TAG_RE.test(trimmed)) {
    return true;
  }
  const lowered = trimmed.toLowerCase();
  if (NO_RESPONSE_PHRASES.has(lowered)) {
    return true;
  }
  // Accept short variants (common in exports) and normalize them to {NTA}.
  if (trimmed.length <= NO_RESPONSE_VARIANT_MAX_LEN && NO_RESPONSE_VARIANT_RE.test(trimmed)) {
    return true;
  }
  return false;
}

function normalizeNoResponseText(text) {
  if (isNoResponseOnly(text)) {
    return NO_RESPONSE_TAG;
  }
  return typeof text === 'string' ? text : '';
}

/**
 * Strip a trailing {NTA} tag from a response that also contains content.
 * When the model writes content and then appends {NTA} (violating the
 * "output ONLY that token" instruction), this prevents the raw tag from
 * leaking into the visible message delivered to the user.
 *
 * Returns the cleaned text (content preserved, trailing {NTA} removed).
 * If the entire text IS {NTA} (no content), returns it unchanged so
 * isNoResponseOnly() can still match for suppression.
 */
function stripTrailingNTA(text) {
  if (typeof text !== 'string') {
    return text;
  }
  // If the entire text is {NTA}, leave it for suppression logic.
  if (isNoResponseOnly(text)) {
    return text;
  }
  // Strip trailing {NTA} from content+tag responses.
  return text.replace(TRAILING_NTA_RE, '').trimEnd();
}

module.exports = {
  NO_RESPONSE_TAG,
  isNoResponseTag,
  isNoResponseOnly,
  normalizeNoResponseText,
  stripTrailingNTA,
};
