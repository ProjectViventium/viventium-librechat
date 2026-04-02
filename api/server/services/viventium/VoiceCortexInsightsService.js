/* === VIVENTIUM START ===
 * Feature: LibreChat Voice Calls - Cortex insight retrieval for Voice Gateway
 *
 * Problem:
 * - Background cortices execute asynchronously (Phase B) and persist results to the DB
 *   after the main assistant response is already complete.
 * - The LiveKit voice playground does not read LibreChat's UI follow-up messages, so
 *   the user never hears the background insight (e.g., "Secret code: 27").
 *
 * Solution:
 * - Provide a small, testable service that extracts completed cortex insight parts
 *   from the canonical assistant message stored in MongoDB.
 * - The voice gateway can poll this endpoint and speak the insights reliably.
 *
 * Added: 2026-01-09
 * === VIVENTIUM END === */

const { ContentTypes } = require('librechat-data-provider');
const { getMessage, getMessages } = require('~/models');

/**
 * Extract completed cortex insights from a LibreChat message `content` array.
 *
 * @param {unknown} content
 * @returns {Array<{ cortex_id?: string, cortex_name?: string, insight: string }>}
 */
function extractCompletedCortexInsights(content) {
  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .filter((part) => part && typeof part === 'object')
    .filter((part) => part.type === ContentTypes.CORTEX_INSIGHT)
    .filter((part) => part.status === 'complete')
    .map((part) => ({
      cortex_id: typeof part.cortex_id === 'string' ? part.cortex_id : undefined,
      cortex_name: typeof part.cortex_name === 'string' ? part.cortex_name : undefined,
      insight: typeof part.insight === 'string' ? part.insight.trim() : '',
    }))
    .filter((p) => p.insight.length > 0);
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

  const followUp = followUps[followUps.length - 1];
  const text = typeof followUp?.text === 'string' ? followUp.text.trim() : '';
  if (!text) {
    return null;
  }

  return {
    messageId: followUp.messageId,
    text,
  };
}

/**
 * Get completed cortex insights for a message, validating that it belongs to the user
 * (and optionally that it belongs to the expected conversation).
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.messageId
 * @param {string} [params.conversationId]
 * @returns {Promise<null | { messageId: string, conversationId?: string, insights: Array }>}
 */
async function getCompletedCortexInsightsForMessage({ userId, messageId, conversationId }) {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('getCompletedCortexInsightsForMessage requires userId');
  }
  if (typeof messageId !== 'string' || messageId.length === 0) {
    throw new Error('getCompletedCortexInsightsForMessage requires messageId');
  }

  const msg = await getMessage({ user: userId, messageId });
  if (!msg) {
    return null;
  }

  // Optional extra guard: ensure the message belongs to the call session conversation.
  if (conversationId && msg.conversationId && msg.conversationId !== conversationId) {
    return null;
  }

  const insights = extractCompletedCortexInsights(msg.content);
  const followUp = await getFollowUpMessageForParent({
    userId,
    conversationId: msg.conversationId,
    parentMessageId: msg.messageId,
  });

  return {
    messageId: msg.messageId,
    conversationId: msg.conversationId,
    insights,
    followUp,
  };
}

module.exports = {
  extractCompletedCortexInsights,
  getCompletedCortexInsightsForMessage,
};

/* === VIVENTIUM NOTE === */
