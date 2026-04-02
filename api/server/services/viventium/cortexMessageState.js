/* === VIVENTIUM START ===
 * Feature: Canonical cortex message state helper.
 *
 * Purpose:
 * - Keep scheduler, Telegram, and gateway cortex polling aligned on one MongoDB-backed
 *   source of truth for the assistant message, its cortex parts, and any follow-up node.
 * - Surface canonical parent-message text when Phase B replaces the original assistant
 *   node in place instead of creating a separate follow-up message.
 *
 * Added: 2026-03-09
 * === VIVENTIUM END === */

const { ContentTypes } = require('librechat-data-provider');
const { logger } = require('@librechat/data-schemas');
const { getMessage, getMessages } = require('~/models');
const { sanitizeFollowUpDisplayText } = require('~/server/services/viventium/followUpTextSanitizer');
const {
  getPreferredFallbackInsightText,
} = require('~/server/services/viventium/cortexFallbackText');

const CORTEX_TYPES = new Set([
  ContentTypes.CORTEX_ACTIVATION,
  ContentTypes.CORTEX_BREWING,
  ContentTypes.CORTEX_INSIGHT,
]);

const TERMINAL_CORTEX_STATUSES = new Set([
  'complete',
  'completed',
  'done',
  'error',
  'failed',
  'cancelled',
  'canceled',
]);

const PLACEHOLDER_CANONICAL_TEXT_PATTERNS = [
  /^checking(?:\s+now)?[.!]*$/i,
  /^let me check(?:\s+that)?[.!]*$/i,
  /^one moment[.!]*$/i,
  /^looking into it[.!]*$/i,
  /^hang on[.!]*$/i,
  /^working on it[.!]*$/i,
  /^i['’]?m checking[.!]*$/i,
];

function extractCortexParts(content) {
  if (!Array.isArray(content)) {
    return [];
  }

  return content.filter((part) => part && typeof part === 'object' && CORTEX_TYPES.has(part.type));
}

function extractCanonicalMessageText(message) {
  if (!message || typeof message !== 'object') {
    return '';
  }

  const directText = typeof message.text === 'string' ? message.text.trim() : '';
  if (directText) {
    return sanitizeFollowUpDisplayText(directText);
  }

  if (!Array.isArray(message.content)) {
    return '';
  }

  const contentText = message.content
    .filter((part) => part && typeof part === 'object' && part.type === 'text')
    .map((part) => (typeof part.text === 'string' ? part.text.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim();

  return sanitizeFollowUpDisplayText(contentText);
}

function hasActiveCortexParts(cortexParts) {
  if (!Array.isArray(cortexParts) || cortexParts.length === 0) {
    return false;
  }

  return cortexParts.some((part) => {
    const status = typeof part?.status === 'string' ? part.status.trim().toLowerCase() : '';
    if (!status) {
      return part?.type !== ContentTypes.CORTEX_INSIGHT;
    }
    return !TERMINAL_CORTEX_STATUSES.has(status);
  });
}

function isPlaceholderCanonicalText(text) {
  if (typeof text !== 'string') {
    return false;
  }

  const normalized = text.trim();
  if (!normalized) {
    return true;
  }

  return PLACEHOLDER_CANONICAL_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function resolveDeferredFallbackCanonicalText({
  message,
  followUp,
  canonicalText,
  cortexParts,
}) {
  if (followUp || hasActiveCortexParts(cortexParts)) {
    return canonicalText || null;
  }

  const needsFallback =
    message?.unfinished === true || !canonicalText || isPlaceholderCanonicalText(canonicalText);
  if (!needsFallback) {
    return canonicalText || null;
  }

  const insightCandidates = Array.isArray(cortexParts)
    ? cortexParts
        .filter(
          (part) =>
            part &&
            part.type === ContentTypes.CORTEX_INSIGHT &&
            typeof part.insight === 'string' &&
            part.insight.trim(),
        )
        .map((part) => ({
          cortexName: part.cortex_name || part.cortexName || part.cortex_id || '',
          insight: part.insight,
        }))
    : [];

  const fallbackText = getPreferredFallbackInsightText({
    insights: insightCandidates,
    allowMultiInsightBestEffort: true,
  });

  if (!fallbackText) {
    return canonicalText || null;
  }

  logger.warn(
    `[cortexMessageState] Resolved deferred fallback canonical text for message ${message?.messageId || ''}`,
  );
  return fallbackText;
}

async function getFollowUpMessageForParent({ userId, conversationId, parentMessageId }) {
  if (!conversationId || !parentMessageId) {
    return null;
  }

  const followUps = await getMessages({
    user: userId,
    conversationId,
    'metadata.viventium.parentMessageId': parentMessageId,
    'metadata.viventium.type': 'cortex_followup',
  });

  if (!Array.isArray(followUps) || followUps.length === 0) {
    return null;
  }

  const lastFollowUp = followUps[followUps.length - 1];
  const text =
    typeof lastFollowUp?.text === 'string'
      ? sanitizeFollowUpDisplayText(lastFollowUp.text.trim())
      : '';
  if (!text) {
    return null;
  }

  return {
    messageId: lastFollowUp.messageId,
    text,
  };
}

async function getCortexMessageState({ userId, messageId, conversationId }) {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('getCortexMessageState requires userId');
  }
  if (typeof messageId !== 'string' || messageId.length === 0) {
    throw new Error('getCortexMessageState requires messageId');
  }

  const message = await getMessage({ user: userId, messageId });
  if (!message) {
    return null;
  }

  if (conversationId && message.conversationId && message.conversationId !== conversationId) {
    return null;
  }

  const cortexParts = extractCortexParts(message.content);
  let followUp = await getFollowUpMessageForParent({
    userId,
    conversationId: message.conversationId,
    parentMessageId: message.messageId,
  });

  let canonicalText = extractCanonicalMessageText(message);
  if (followUp?.messageId === message.messageId) {
    followUp = null;
  }

  canonicalText = resolveDeferredFallbackCanonicalText({
    message,
    followUp,
    canonicalText,
    cortexParts,
  });

  return {
    messageId: message.messageId,
    conversationId: message.conversationId,
    cortexParts,
    followUp,
    canonicalText,
  };
}

module.exports = {
  extractCanonicalMessageText,
  extractCortexParts,
  getCortexMessageState,
  getFollowUpMessageForParent,
  hasActiveCortexParts,
  isPlaceholderCanonicalText,
  resolveDeferredFallbackCanonicalText,
};
