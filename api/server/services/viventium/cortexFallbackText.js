/* === VIVENTIUM START ===
 * Feature: Shared cortex fallback text helpers.
 *
 * Purpose:
 * - Keep deterministic fallback selection consistent between Phase B follow-up persistence
 *   and DB-backed state recovery (Telegram/gateway/scheduler polling).
 * - Avoid importing the full follow-up service where only text cleanup/ranking is needed.
 *
 * Added: 2026-03-11
 * === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const { isNoResponseOnly } = require('~/server/services/viventium/noResponseTag');
const {
  sanitizeFollowUpDisplayText,
} = require('~/server/services/viventium/followUpTextSanitizer');

const OPERATIONAL_FALLBACK_PARAGRAPH_PATTERNS = [
  /could not perform the requested live checks/i,
  /\bno (?:ms365|google|gmail|outlook|calendar|workspace) tools? are available in this chat\b/i,
  /\bwon['’]t invent inbox\/calendar results\b/i,
  /\bi (?:do not|don['’]t|cannot|can['’]t) have\b.*\b(?:live )?(?:google|gmail|outlook|calendar|inbox|mail|workspace|tool|tools|access)\b/i,
  /\bi (?:cannot|can['’]t|could not|couldn['’]t) verify\b.*\b(?:google|gmail|outlook|calendar|inbox|mail|workspace)\b/i,
  /\bi (?:cannot|can['’]t|could not|couldn['’]t) confirm\b.*\b(?:google|gmail|outlook|calendar|inbox|mail|workspace)\b/i,
  /\bi (?:cannot|can['’]t|could not|couldn['’]t)\s+(?:live-)?check\b.*\b(?:google|gmail|outlook|calendar|inbox|mail|workspace)\b/i,
  /\b(?:google|gmail|outlook|calendar|inbox|mail|workspace)\b.*\b(?:is|isn['’]t|are|aren['’]t)\b.*\bavailable\b/i,
  /\b(?:google|gmail|outlook|calendar|inbox|mail|workspace)\b.*\bunavailable here\b/i,
  /\b(?:google|gmail|outlook|calendar|inbox|mail|workspace)\b.*\b(?:appears|seems)\s+unauthenticated\b/i,
  /\bdon['’]t have working\b.*\btools?\b.*\bavailable in this run\b/i,
  /\bdon['’]t have\b.*\btools?\b.*\bto verify\b/i,
  /\bfrom this side\b/i,
  /\brepeated ["']?wake["']? prompts?\b/i,
  /\btesting the wake loop\b/i,
  /\bwake loop\b/i,
  /\btool auth walls?\b/i,
  /\bhitting tool auth walls?\b/i,
  /\b(?:auth|oauth|token)\b.*\b(?:stale|expired|invalid|missing)\b/i,
  /\bconnected account\b.*\b(?:reconnect|expired|invalid)\b/i,
  /\bwithout reconnect\b/i,
  /\bre[- ]?auth(?:enticate|orize)\b/i,
  /\bscheduler noise\b/i,
  /\binternal checks?\b/i,
  /\bmcp health\b/i,
  /\bmcp availability\b/i,
];

const EVIDENCE_STYLE_FALLBACK_TEXT_PATTERNS = [
  /\bi (?:read|reviewed|checked|found|verified|identified|looked up|searched|researched)\b/i,
  /\bthe (?:doc|document|file|web|website|page|source|sources)\b/i,
  /\baccording to\b/i,
  /\bshort version\b/i,
];

const ACCESS_LIMITATION_ONLY_FALLBACK_TEXT_PATTERNS = [
  /\b(?:can(?:not|['’]t)|could(?: not|n['’]t)|do not|don['’]t)\b.*\b(?:check|verify|confirm|access|live-check)\b/i,
  /\blive check unavailable\b/i,
  /\bunavailable in this run\b/i,
  /\b(?:appears|seems)\s+unauthenticated\b/i,
  /\bi can only confirm\b/i,
];

const CONCRETE_RESULT_DETAIL_PATTERNS = [
  /\bunread\b/i,
  /\battachment\b/i,
  /\bthreads?\b/i,
  /\binvite\b/i,
  /\bmeeting\b/i,
  /\bstandup\b/i,
  /\bconnect\b/i,
  /\bcalendar\b.*\b(?:tomorrow|today|starts?|at)\b/i,
  /\b(?:received|sent|found|scheduled)\b/i,
];

function isOperationalFallbackParagraph(text) {
  if (typeof text !== 'string') {
    return false;
  }

  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  return OPERATIONAL_FALLBACK_PARAGRAPH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function stripQuestionSentences(text) {
  if (typeof text !== 'string') {
    return '';
  }

  const trimmed = text.trim();
  if (!trimmed || !trimmed.includes('?')) {
    return trimmed;
  }

  const segments = trimmed
    .split(/(?<=[.!?])\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const kept = [];
  for (const segment of segments) {
    if (!segment.includes('?')) {
      kept.push(segment);
      continue;
    }
    const qIdx = segment.lastIndexOf('?');
    const prefix = segment.slice(0, qIdx);
    const lastSep = Math.max(
      prefix.lastIndexOf(','),
      prefix.lastIndexOf(';'),
      prefix.lastIndexOf('—'),
      prefix.lastIndexOf('–'),
    );
    if (lastSep > 0) {
      let salvaged = prefix.slice(0, lastSep).trim();
      salvaged = salvaged.replace(/[,;—–\s]+$/, '');
      if (salvaged) {
        kept.push(/[.!]$/.test(salvaged) ? salvaged : `${salvaged}.`);
      }
    }
  }

  return kept.join(' ').trim();
}

function cleanFallbackInsightText(text) {
  if (typeof text !== 'string') {
    return '';
  }

  const sanitized = sanitizeFollowUpDisplayText(text);
  if (!sanitized || isNoResponseOnly(sanitized)) {
    return '';
  }

  const visibleParagraphs = sanitized
    .split(/\n\s*\n+/)
    .map((paragraph) => stripQuestionSentences(paragraph).trim())
    .filter(Boolean)
    .filter((paragraph) => !isOperationalFallbackParagraph(paragraph));

  if (visibleParagraphs.length === 0) {
    return '';
  }

  const visibleText = visibleParagraphs.join('\n\n').trim();
  if (!visibleText || isNoResponseOnly(visibleText)) {
    return '';
  }

  return visibleText;
}

function isAccessLimitationOnlyInsight(text) {
  if (typeof text !== 'string') {
    return false;
  }

  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  const hasAccessLimitation = ACCESS_LIMITATION_ONLY_FALLBACK_TEXT_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
  if (!hasAccessLimitation) {
    return false;
  }

  return !CONCRETE_RESULT_DETAIL_PATTERNS.some((pattern) => pattern.test(normalized));
}

function getVisibleFallbackInsightTexts({ insightTexts = [], scheduleId = '' }) {
  const cleaned = [];
  const seen = new Set();

  for (const rawText of insightTexts) {
    const visibleText = cleanFallbackInsightText(rawText);
    if (!visibleText) {
      continue;
    }

    const dedupeKey = visibleText.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    cleaned.push(visibleText);
  }

  if (cleaned.length > 1 && typeof scheduleId === 'string' && scheduleId.trim()) {
    logger.warn(
      `[BackgroundCortexFollowUpService] Scheduler fallback produced ${cleaned.length} visible insights; suppressing unsynthesized dump`,
    );
    return [];
  }

  return cleaned;
}

function scoreFallbackInsightCandidate({ insight, index = 0 }) {
  const visibleText = cleanFallbackInsightText(
    typeof insight?.insight === 'string' ? insight.insight : '',
  );

  if (!visibleText) {
    return null;
  }

  if (isAccessLimitationOnlyInsight(visibleText)) {
    return null;
  }

  const completedToolCalls = Number.parseInt(
    String(
      insight?.completed_tool_calls ??
        insight?.completedToolCalls ??
        insight?.tool_calls_completed ??
        0,
    ),
    10,
  );
  const configuredTools = Number.parseInt(
    String(
      insight?.configured_tools ??
        insight?.configuredTools ??
        insight?.tools_configured ??
        0,
    ),
    10,
  );

  let score = Math.min(visibleText.length, 900) - index;

  if (Number.isFinite(completedToolCalls) && completedToolCalls > 0) {
    score += 900 + Math.min(180, completedToolCalls * 45);
  }

  if (Number.isFinite(configuredTools) && configuredTools > 0 && (!Number.isFinite(completedToolCalls) || completedToolCalls === 0)) {
    score -= 120;
  }

  if (EVIDENCE_STYLE_FALLBACK_TEXT_PATTERNS.some((pattern) => pattern.test(visibleText))) {
    score += 150;
  }

  if (CONCRETE_RESULT_DETAIL_PATTERNS.some((pattern) => pattern.test(visibleText))) {
    score += 260;
  }

  if (/\d/.test(visibleText)) {
    score += 40;
  }

  if (/:\s/.test(visibleText)) {
    score += 20;
  }

  return {
    index,
    rawName:
      (typeof insight?.cortexName === 'string' && insight.cortexName.trim()) ||
      (typeof insight?.cortex_name === 'string' && insight.cortex_name.trim()) ||
      (typeof insight?.cortex_id === 'string' && insight.cortex_id.trim()) ||
      '',
    score,
    visibleText,
  };
}

function getPreferredFallbackInsightText({
  insights = [],
  scheduleId = '',
  allowMultiInsightBestEffort = false,
}) {
  const candidates = [];
  const seen = new Set();

  for (let index = 0; index < insights.length; index += 1) {
    const candidate = scoreFallbackInsightCandidate({ insight: insights[index], index });
    if (!candidate) {
      continue;
    }

    const dedupeKey = candidate.visibleText.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    candidates.push(candidate);
  }

  if (candidates.length === 0) {
    return '';
  }

  if (candidates.length === 1) {
    return candidates[0].visibleText;
  }

  if (!allowMultiInsightBestEffort) {
    if (typeof scheduleId === 'string' && scheduleId.trim()) {
      logger.warn(
        `[BackgroundCortexFollowUpService] Scheduler fallback produced ${candidates.length} visible insights; suppressing unsynthesized dump`,
      );
      return '';
    }
    logger.warn(
      `[BackgroundCortexFollowUpService] Suppressing unsynthesized fallback aggregation for ${candidates.length} insights`,
    );
    return '';
  }

  const bestCandidate = [...candidates].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (b.visibleText.length !== a.visibleText.length) {
      return b.visibleText.length - a.visibleText.length;
    }
    return a.index - b.index;
  })[0];

  logger.warn(
    `[BackgroundCortexFollowUpService] Using best-effort deferred fallback insight from ${bestCandidate.rawName || 'unknown'} among ${candidates.length} visible insights`,
  );
  return bestCandidate.visibleText;
}

module.exports = {
  cleanFallbackInsightText,
  getPreferredFallbackInsightText,
  getVisibleFallbackInsightTexts,
  isOperationalFallbackParagraph,
  stripQuestionSentences,
};
