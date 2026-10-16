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
const {
  projectDeliveryDispositionRanges,
  projectAudioDeliveryControls,
} = require('@librechat/api');
const { stripVoiceControlTagsForDisplay } = require('./surfacePrompts');
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

async function getFollowUpMessageForParent({
  userId,
  conversationId,
  parentMessageId,
  followupMessageId,
}) {
  if (!conversationId || !parentMessageId) {
    return null;
  }

  const followUps = await getMessages({
    user: userId,
    conversationId,
    'metadata.viventium.parentMessageId': parentMessageId,
    'metadata.viventium.type': 'cortex_followup',
    ...(followupMessageId ? { messageId: followupMessageId } : {}),
  });

  if (!Array.isArray(followUps) || followUps.length === 0) {
    return null;
  }

  const cortexFollowUps = followUps.filter(
    (message) =>
      !['durable_terminal_callback', 'durable_work_callback'].includes(
        message?.metadata?.viventium?.followUpSource,
      ) &&
      (!followupMessageId || message.messageId === followupMessageId),
  );
  const followUp = cortexFollowUps[cortexFollowUps.length - 1];
  const text = typeof followUp?.text === 'string' ? followUp.text.trim() : '';
  if (!text) {
    return null;
  }

  const defaultSkipped =
    followUp.metadata?.viventium?.deliveryDisposition?.version === 1 &&
    followUp.metadata.viventium.deliveryDisposition.audio === 'skip';
  const hasRanges =
    Array.isArray(followUp.content) &&
    followUp.content.some(
      (part) =>
        part?.type === 'text' &&
        Object.prototype.hasOwnProperty.call(part, 'deliveryDispositionRanges'),
    );
  const content = hasRanges
    ? followUp.content
        .filter((part) => part?.type === 'text')
        .map((part) => {
          if (!Object.prototype.hasOwnProperty.call(part, 'deliveryDispositionRanges'))
            return { ...part, deliveryDispositionRanges: [] };
          return {
            ...part,
            deliveryDispositionRanges: projectDeliveryDispositionRanges(
              part.deliveryDispositionRanges,
              typeof part.text === 'string' ? part.text : '',
            ),
          };
        })
    : undefined;
  const deliveryControls = projectAudioDeliveryControls(
    followUp.metadata?.viventium?.deliveryControls,
    text,
    content,
    stripVoiceControlTagsForDisplay,
  );
  const audible =
    hasRanges &&
    content.some((part) =>
      Object.prototype.hasOwnProperty.call(part, 'deliveryDispositionRanges')
        ? part.deliveryDispositionRanges.some((range) => range.disposition.audio === 'eligible')
        : !defaultSkipped && typeof part.text === 'string' && part.text.length > 0,
    );
  return {
    messageId: followUp.messageId,
    text,
    ...(hasRanges ? { content } : {}),
    ...(deliveryControls ? { deliveryControls } : {}),
    audioSuppressed: hasRanges ? !audible : defaultSkipped,
    presentationRequired:
      Array.isArray(followUp.metadata?.viventium?.cortexInsightDeliveryIds) &&
      followUp.metadata.viventium.cortexInsightDeliveryIds.length > 0,
  };
}

function getFollowUpDecisionForMessage(message) {
  const decision = message?.metadata?.viventium?.cortexFollowUpDecision;
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    return null;
  }
  return decision;
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
async function getCompletedCortexInsightsForMessage({
  userId,
  messageId,
  conversationId,
  followupMessageId,
}) {
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
    followupMessageId,
  });

  return {
    messageId: msg.messageId,
    conversationId: msg.conversationId,
    insights: followUp?.audioSuppressed ? [] : insights,
    followUp:
      followUp && !followUp.audioSuppressed
        ? {
            messageId: followUp.messageId,
            text: followUp.text,
            ...(followUp.content ? { content: followUp.content } : {}),
            ...(followUp.deliveryControls ? { deliveryControls: followUp.deliveryControls } : {}),
          }
        : null,
    presentationRequired: !followUp?.audioSuppressed && followUp?.presentationRequired === true,
    followUpDecision: followUp?.audioSuppressed
      ? { result: 'suppressed', suppressionReason: 'audio_delivery_disposition' }
      : getFollowUpDecisionForMessage(msg),
    presentationContext: {
      callSessionId: msg.metadata?.viventium?.callSessionId,
      taskId: msg.metadata?.viventium?.voiceTaskId,
      turnId: msg.metadata?.viventium?.interactionContext?.logical_turn_id,
    },
  };
}

module.exports = {
  extractCompletedCortexInsights,
  getFollowUpDecisionForMessage,
  getCompletedCortexInsightsForMessage,
};

/* === VIVENTIUM NOTE === */
