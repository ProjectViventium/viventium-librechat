/* === VIVENTIUM START ===
 * File: api/server/services/viventium/liveEmailIntent.js
 *
 * Purpose:
 * - Centralize detection of live inbox / reply / follow-up requests.
 * - Keep main-agent and background-cortex routing aligned on one deterministic rule.
 *
 * Why:
 * - Generic prompts like "Any replies from Joey yet?" are live email-status checks, not
 *   memory-only questions.
 * - Prompt-only routing proved brittle under cooldowns and provider-auth drift.
 *
 * Added: 2026-03-11
 * === VIVENTIUM END === */

'use strict';

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

const LIVE_EMAIL_STATUS_PATTERNS = [
  /\bany\b[\s\S]{0,24}\brepl(?:y|ies)\b/i,
  /\bdid\b[\s\S]{0,40}\b(?:reply|respond|get back|write back)\b/i,
  /\bhave\b[\s\S]{0,32}\b(?:reply|replied|responded|get back|written back)\b/i,
  /\bshould\b[\s\S]{0,24}\bfollow[\s-]?up\b/i,
  /\b(?:check|scan|search|look(?:ing)?|read)\b[\s\S]{0,24}\b(?:my\s+)?(?:inbox|emails?|mail)\b/i,
  /\b(?:reply|replies|response|responses)\b[\s\S]{0,16}\bfrom\b/i,
];

const EMAIL_CAPABILITY_PATTERN =
  /\b(?:can you|could you|do you|are you able to|are you capable of)\b[\s\S]{0,24}\b(?:access|check|read|use|see)\b[\s\S]{0,24}\b(?:email|mail|inbox)\b/i;

const FOLLOW_UP_CHECK_PATTERN = /\bdid\b[\s\S]{0,16}\byou\b[\s\S]{0,16}\bcheck\b/i;
const EMAIL_SCOPE_PATTERN = /\b(?:email|emails|mail|inbox|account)\b/i;
const GOOGLE_EMAIL_PROVIDER_PATTERN = /\b(?:gmail|google(?:\s+workspace)?|google mail)\b/i;
const MS365_EMAIL_PROVIDER_PATTERN =
  /\b(?:outlook|microsoft(?:\s*365)?|ms365|office\s*365)\b/i;

function isEmailCapabilityQuestion(text) {
  return EMAIL_CAPABILITY_PATTERN.test(normalizeText(text));
}

function isLiveEmailStatusRequest(text) {
  const normalized = normalizeText(text);
  if (!normalized || isEmailCapabilityQuestion(normalized)) {
    return false;
  }

  return LIVE_EMAIL_STATUS_PATTERNS.some((pattern) => pattern.test(normalized));
}

function resolveClarifiedLiveEmailProviderIntent(text) {
  const normalized = normalizeText(text);
  if (!normalized || isEmailCapabilityQuestion(normalized)) {
    return 'none';
  }

  if (!FOLLOW_UP_CHECK_PATTERN.test(normalized) || !EMAIL_SCOPE_PATTERN.test(normalized)) {
    return 'none';
  }

  const wantsGoogle = GOOGLE_EMAIL_PROVIDER_PATTERN.test(normalized);
  const wantsMs365 = MS365_EMAIL_PROVIDER_PATTERN.test(normalized);

  if (wantsGoogle && wantsMs365) {
    return 'both';
  }
  if (wantsGoogle) {
    return 'google_workspace';
  }
  if (wantsMs365) {
    return 'ms365';
  }

  return 'generic';
}

function resolveLiveEmailProviderIntent(text) {
  const normalized = normalizeText(text);
  if (!isLiveEmailStatusRequest(normalized)) {
    return 'none';
  }

  const wantsGoogle = GOOGLE_EMAIL_PROVIDER_PATTERN.test(normalized);
  const wantsMs365 = MS365_EMAIL_PROVIDER_PATTERN.test(normalized);

  if (wantsGoogle && wantsMs365) {
    return 'both';
  }
  if (wantsGoogle) {
    return 'google_workspace';
  }
  if (wantsMs365) {
    return 'ms365';
  }

  return 'generic';
}

module.exports = {
  isEmailCapabilityQuestion,
  isLiveEmailStatusRequest,
  normalizeText,
  resolveClarifiedLiveEmailProviderIntent,
  resolveLiveEmailProviderIntent,
};
