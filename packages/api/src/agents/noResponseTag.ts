/* === VIVENTIUM START ===
 * Feature: No-response marker normalization.
 * Purpose: Keep exact passive/background suppression semantics in one typed owner.
 * === VIVENTIUM END === */

export const NO_RESPONSE_TAG = '{NTA}';

const NO_RESPONSE_TAG_RE = /^\s*\{\s*NTA\s*\}\s*$/i;
const TRAILING_NTA_RE = /\s*\{\s*NTA\s*\}\s*$/i;
const NO_RESPONSE_PHRASES = new Set([
  'nothing new to add.',
  'nothing new to add',
  'nothing to add.',
  'nothing to add',
]);
const NO_RESPONSE_VARIANT_MAX_LEN = 200;
const NO_RESPONSE_VARIANT_RE =
  /^\s*nothing\s+(?:new\s+)?to\s+add(?:\s*(?:\(\s*)?(?:right\s+now|for\s+now|at\s+this\s+time|at\s+the\s+moment|currently|so\s+far|yet|today)(?:\s*\))?)?(?:\s*,?\s*(?:sorry|thanks|thank\s+you))?\s*[.!?]*\s*$/i;

export function isNoResponseTag(text: unknown): boolean {
  return typeof text === 'string' && NO_RESPONSE_TAG_RE.test(text);
}

export function isNoResponseOnly(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (NO_RESPONSE_TAG_RE.test(trimmed)) return true;
  if (NO_RESPONSE_PHRASES.has(trimmed.toLowerCase())) return true;
  return trimmed.length <= NO_RESPONSE_VARIANT_MAX_LEN && NO_RESPONSE_VARIANT_RE.test(trimmed);
}

export function normalizeNoResponseText(text: unknown): string {
  if (isNoResponseOnly(text)) return NO_RESPONSE_TAG;
  return typeof text === 'string' ? text : '';
}

export function stripTrailingNTA<T>(text: T): T | string {
  if (typeof text !== 'string' || isNoResponseOnly(text)) return text;
  return text.replace(TRAILING_NTA_RE, '').trimEnd();
}

/* === VIVENTIUM END === */
