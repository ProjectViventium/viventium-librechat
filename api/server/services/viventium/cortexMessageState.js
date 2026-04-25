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
const { getAgent } = require('~/models/Agent');
const { sanitizeFollowUpDisplayText } = require('~/server/services/viventium/followUpTextSanitizer');
const {
  getDeferredFallbackErrorText,
  getPreferredFallbackInsightText,
} = require('~/server/services/viventium/cortexFallbackText');
const {
  resolveConfiguredHoldTexts,
} = require('~/server/services/viventium/brewingHold');
const {
  isRuntimeHoldTextPart,
} = require('~/server/services/viventium/runtimeHoldText');

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

  const content = Array.isArray(message.content) ? message.content : [];
  const hasRuntimeHold = content.some((part) => isRuntimeHoldTextPart(part));

  const directText =
    !hasRuntimeHold && typeof message.text === 'string' ? message.text.trim() : '';
  if (directText) {
    return sanitizeFollowUpDisplayText(directText);
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const contentText = content
    .filter(
      (part) =>
        part &&
        typeof part === 'object' &&
        part.type === 'text' &&
        !isRuntimeHoldTextPart(part),
    )
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

function normalizeHoldText(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function hasRuntimeHoldText(content) {
  return Array.isArray(content) && content.some((part) => isRuntimeHoldTextPart(part));
}

function isConfiguredHoldCanonicalText(text, holdTexts = []) {
  const normalized = normalizeHoldText(text);
  if (!normalized) {
    return false;
  }

  return holdTexts.some((holdText) => normalizeHoldText(holdText) === normalized);
}

function resolveDeferredFallbackCanonicalText({
  message,
  followUp,
  canonicalText,
  cortexParts,
  configuredHoldTexts = [],
  scheduleId = '',
}) {
  return resolveDeferredFallbackCanonicalTextState({
    message,
    followUp,
    canonicalText,
    cortexParts,
    configuredHoldTexts,
    scheduleId,
  }).canonicalText;
}

function resolveDeferredFallbackCanonicalTextState({
  message,
  followUp,
  canonicalText,
  cortexParts,
  configuredHoldTexts = [],
  scheduleId = '',
}) {
  if (followUp || hasActiveCortexParts(cortexParts)) {
    return {
      canonicalText: canonicalText || null,
      canonicalTextSource: canonicalText ? 'message' : '',
      canonicalTextFallbackReason: '',
    };
  }

  const runtimeHoldText = hasRuntimeHoldText(message?.content);
  const configuredHoldText = isConfiguredHoldCanonicalText(canonicalText, configuredHoldTexts);
  const needsFallback =
    runtimeHoldText ||
    configuredHoldText ||
    message?.unfinished === true ||
    !canonicalText ||
    isPlaceholderCanonicalText(canonicalText);
  if (!needsFallback) {
    return {
      canonicalText: canonicalText || null,
      canonicalTextSource: canonicalText ? 'message' : '',
      canonicalTextFallbackReason: '',
    };
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
    return {
      canonicalText: getDeferredFallbackErrorText({ scheduleId }),
      canonicalTextSource: 'deferred_fallback',
      canonicalTextFallbackReason: 'empty_deferred_response',
    };
  }

  logger.warn(
    `[cortexMessageState] Resolved deferred fallback canonical text for message ${message?.messageId || ''}`,
  );
  return {
    canonicalText: fallbackText,
    canonicalTextSource: 'deferred_fallback',
    canonicalTextFallbackReason: 'insight_fallback',
  };
}

async function resolveConfiguredHoldTextsForMessage(message) {
  const agentId =
    (typeof message?.agent_id === 'string' && message.agent_id.trim()) ||
    (typeof message?.model === 'string' && message.model.startsWith('agent_') && message.model.trim()) ||
    '';
  if (!agentId) {
    return [];
  }

  try {
    const agent = await getAgent({ id: agentId });
    return resolveConfiguredHoldTexts({ agentInstructions: agent?.instructions });
  } catch (err) {
    logger.warn(
      `[cortexMessageState] Failed to load agent hold texts for message ${message?.messageId || ''}: ${err?.message || err}`,
    );
    return [];
  }
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

async function getCortexMessageState({ userId, messageId, conversationId, scheduleId = '' }) {
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

  const configuredHoldTexts = await resolveConfiguredHoldTextsForMessage(message);
  const canonicalState = resolveDeferredFallbackCanonicalTextState({
    message,
    followUp,
    canonicalText,
    cortexParts,
    configuredHoldTexts,
    scheduleId,
  });
  canonicalText = canonicalState.canonicalText;

  return {
    messageId: message.messageId,
    conversationId: message.conversationId,
    cortexParts,
    followUp,
    canonicalText,
    canonicalTextSource: canonicalState.canonicalTextSource,
    canonicalTextFallbackReason: canonicalState.canonicalTextFallbackReason,
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
  resolveDeferredFallbackCanonicalTextState,
};
