/* === VIVENTIUM START ===
 * File: api/server/controllers/agents/request.js
 *
 * Purpose:
 * - Track and preserve all Viventium modifications to this upstream LibreChat file in one place.
 *
 * Why a file-level wrapper:
 * - This controller has multiple scattered changes for Viventium (voice concurrency bypass, Telegram streamId
 *   handling, and deep timing instrumentation). Wrapping the whole file prevents missing any change during
 *   manual porting to a newer upstream LibreChat version.
 *
 * Porting (manual onto new upstream):
 * - Re-apply this file as a patch against upstream (see docs/requirements_and_learnings/05_Open_Source_Modifications.md).
 * - Search inside this file for `VIVENTIUM NOTE` for section-level intent notes.
 *
 * Added: 2026-01-11
 * Updated: 2026-01-31, 2026-02-07
 */
const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { Constants, ContentTypes, ViolationTypes } = require('librechat-data-provider');
const {
  sendEvent,
  getViolationInfo,
  GenerationJobManager,
  decrementPendingRequest,
  sanitizeFileForTransmit,
  sanitizeMessageForTransmit,
  checkAndIncrementPendingRequest,
} = require('@librechat/api');
const { disposeClient, clientRegistry, requestDataMap } = require('~/server/cleanup');
const { handleAbortError } = require('~/server/middleware');
const { logViolation } = require('~/cache');
const { saveMessage } = require('~/models');
const { Conversation, Message } = require('~/db/models');
/* === VIVENTIUM NOTE ===
 * Feature: Deep Telegram timing instrumentation (toggleable)
 */
const {
  isDeepTimingEnabled,
  startDeepTiming,
  logDeepTiming,
} = require('~/server/services/viventium/telegramTimingDeep');
const {
  formatVoiceLatencyTiming,
  voiceLatencyNow,
} = require('~/server/services/viventium/voiceLatencyTiming');
const { getCortexFollowupGraceMs } = require('~/server/services/viventium/cortexFollowupGrace');
const { attachVoiceMessageMetadata } = require('~/server/services/viventium/voiceMessageMetadata');
/* === VIVENTIUM NOTE END === */

/* === VIVENTIUM NOTE ===
 * Feature: Morning Briefing Bootstrap (Default Starter Schedule)
 * Purpose: Provision default morning briefing for new users on first interaction (fire-and-forget).
 * Added: 2026-02-15
 */
const { ensureMorningBriefing } = require('~/server/services/viventium/morningBriefingBootstrap');
/* === VIVENTIUM NOTE END === */

/* === VIVENTIUM NOTE ===
 * Feature: Strip voice control tags from persisted messages.
 * Purpose: When voiceMode is active, the LLM generates text with Cartesia SSML emotion tags
 * and bracket nonverbal markers. These are needed for TTS synthesis but should not appear
 * in the persisted message text (which is later displayed in the web UI, Telegram sync, etc.).
 * Added: 2026-02-22
 */
const { stripVoiceControlTagsForDisplay } = require('~/server/services/viventium/surfacePrompts');
const {
  sanitizeVoiceAssistantMessageForPersistence,
} = require('~/server/services/viventium/voiceArtifactText');
const {
  isVoiceTaskSuppressedDurably,
  setVoiceTaskOwnerCapabilities,
} = require('~/server/services/viventium/VoiceTaskService');
const {
  attachInteractionContextMetadata,
  bindCanonicalInteractionConversation,
  bindInteractionSourceSegments,
  bindLogicalTurnContext,
  createWebInteractionContext,
  getTrustedInteractionContext,
  getTrustedAdapterCapabilities,
  getTrustedDeliveryPolicy,
  isInternalOrigin,
  isTrustedInternalMessage,
  setTrustedInteractionContext,
} = require('~/server/services/viventium/interactionContext');
/* === VIVENTIUM NOTE END === */

/* === VIVENTIUM NOTE ===
 * Feature: Timed message persistence for Telegram deep timing.
 */
/* === VIVENTIUM START ===
 * Feature: Durable QA request correlation receipt.
 * Purpose: Capture explicit structured QA provenance before asynchronous Agent execution can
 * mutate request state, then attach the same receipt to every persisted turn message.
 * === VIVENTIUM END === */
function normalizeQaRunReceipt(body) {
  if (body?.viventiumQaRun !== true) return null;
  const qaRunId = String(body?.viventiumQaRunId || '')
    .trim()
    .slice(0, 128);
  return Object.freeze({
    qaRun: true,
    memoryEligible: false,
    ...(qaRunId ? { qaRunId } : {}),
  });
}

function captureQaRunReceipt(req) {
  if (!req || req._viventiumQaRunReceipt) return req?._viventiumQaRunReceipt || null;
  const receipt = normalizeQaRunReceipt(req.body);
  if (!receipt) return null;
  Object.defineProperty(req, '_viventiumQaRunReceipt', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: receipt,
  });
  return receipt;
}

function attachQaRunReceipt(req, message) {
  const receipt = req?._viventiumQaRunReceipt || captureQaRunReceipt(req);
  if (!receipt) return message;
  const existingMetadata =
    message?.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  const existingViventium =
    existingMetadata.viventium && typeof existingMetadata.viventium === 'object'
      ? existingMetadata.viventium
      : {};
  return {
    ...message,
    metadata: {
      ...existingMetadata,
      viventium: {
        ...existingViventium,
        ...receipt,
      },
    },
  };
}

function captureRequestInteractionContext(req, { conversationId, streamId } = {}) {
  const existing = getTrustedInteractionContext(req);
  const body = req?.body && typeof req.body === 'object' ? req.body : {};
  // Preserve only owner-scoped file references in the logical-turn ledger. Telegram images live
  // on the private mission-attachment slot; ordinary uploads live on body.files. The normalizer
  // strips paths/content and de-duplicates them before Redis/InMemory persistence.
  const sourceFiles = [
    ...(Array.isArray(req?._viventiumMissionAttachments) ? req._viventiumMissionAttachments : []),
    ...(Array.isArray(body.files) ? body.files : []),
  ];
  if (existing) {
    bindCanonicalInteractionConversation(req, conversationId);
    return bindInteractionSourceSegments(req, body.text, sourceFiles);
  }
  const sourceEventId =
    body.messageId || body.userMessageId || body.source_event_id || body.sourceEventId || streamId;
  delete body.interactionContext;
  delete body.viventiumInteractionContext;
  setTrustedInteractionContext(
    req,
    createWebInteractionContext({
      conversation_id: conversationId,
      source_event_id: sourceEventId,
    }),
  );
  return bindInteractionSourceSegments(req, body.text, sourceFiles);
}

/* === VIVENTIUM START ===
 * Feature: Stable new-conversation authority across lost start responses.
 * Purpose: A client can retry `conversationId: new` after the first 202 response is lost. Scope
 *          the server-minted canonical conversation to the trusted user/source event so both
 *          attempts reach the same logical-turn receipt instead of starting two generations.
 * === VIVENTIUM END === */
const NEW_CONVERSATION_UUID_NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');

function requestSourceEventId(req) {
  const body = req?.body && typeof req.body === 'object' ? req.body : {};
  const trustedContext = getTrustedInteractionContext(req);
  return String(
    trustedContext?.source_event_id ||
      body.messageId ||
      body.userMessageId ||
      body.source_event_id ||
      body.sourceEventId ||
      body.responseMessageId ||
      '',
  ).trim();
}

function stableScopedUuid(parts) {
  const name = JSON.stringify(parts);
  const digest = crypto
    .createHash('sha1')
    .update(NEW_CONVERSATION_UUID_NAMESPACE)
    .update(name, 'utf8')
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

function stableNewConversationId(req, userId) {
  const trustedContext = getTrustedInteractionContext(req);
  const sourceEventId = requestSourceEventId(req);
  if (!sourceEventId) {
    return crypto.randomUUID();
  }
  return stableScopedUuid([
    'viventium:new-conversation:v1',
    String(userId || ''),
    String(trustedContext?.actor_kind || 'external_user'),
    String(trustedContext?.origin || 'interactive'),
    String(trustedContext?.surface || 'web'),
    sourceEventId,
  ]);
}

function stableExistingConversationStreamId(req, userId, conversationId) {
  const trustedContext = getTrustedInteractionContext(req);
  const sourceEventId = requestSourceEventId(req);
  if (!sourceEventId) {
    return conversationId;
  }
  return stableScopedUuid([
    'viventium:generation-stream:v1',
    String(userId || ''),
    String(conversationId || ''),
    String(trustedContext?.actor_kind || 'external_user'),
    String(trustedContext?.origin || 'interactive'),
    String(trustedContext?.surface || 'web'),
    sourceEventId,
  ]);
}

function resolveCanonicalConversationId(req, userId, requestedConversationId) {
  return !requestedConversationId || requestedConversationId === 'new'
    ? stableNewConversationId(req, userId)
    : requestedConversationId;
}

/* === VIVENTIUM START ===
 * Feature: Canonical duplicate-generation receipts.
 * Purpose: A lost start response can make a retry mint a local conversation UUID, but the
 *          duplicate stream and its interaction context still belong to the original job.
 * === VIVENTIUM END === */
function duplicateGenerationReceipt(req, job, fallbackConversationId) {
  const jobInteractionContext = job?.metadata?.interactionContext;
  const canonicalConversationId =
    jobInteractionContext?.conversation_id ||
    job?.metadata?.conversationId ||
    fallbackConversationId;
  bindCanonicalInteractionConversation(req, canonicalConversationId);
  const claimedInteractionContext = bindLogicalTurnContext(req, jobInteractionContext);
  const receiptContext = claimedInteractionContext?.logical_turn_id
    ? claimedInteractionContext
    : jobInteractionContext;
  return {
    streamId: job.duplicateOfStreamId,
    conversationId: canonicalConversationId,
    status: 'duplicate',
    duplicate: true,
    ...(receiptContext?.logical_turn_id
      ? {
          logical_turn_id: receiptContext.logical_turn_id,
          revision: receiptContext.revision,
        }
      : {}),
  };
}

async function resolveRequestStreamId(req, userId, conversationId) {
  const requested = typeof req?.body?.streamId === 'string' ? req.body.streamId.trim() : '';
  // A raw web request can choose arbitrary body fields. Only an owning adapter that already
  // installed its InteractionContext may supply a stream key; ordinary web streams remain
  // server-derived so one account cannot target or overwrite another account's job key.
  if (requested && requested !== 'new' && getTrustedInteractionContext(req)) {
    return { streamId: requested, requested };
  }
  /* === VIVENTIUM START ===
   * Feature: Main remains available during the Phase-B delivery window.
   * Purpose: A completed generation may intentionally retain its runtime under the conversation
   * ID while Phase B finishes. Existing-conversation turns therefore use a stable source-event
   * stream identity so the next turn cannot collide with that retained generation. `/c/new`
   * keeps the canonical conversation as its first stream for atomic route settlement.
   * === VIVENTIUM END === */
  const requestedConversationId = String(req?.body?.conversationId || '').trim();
  const isInitialNewConversation =
    requestedConversationId === '' || requestedConversationId === 'new';
  return {
    streamId: isInitialNewConversation
      ? conversationId
      : stableExistingConversationStreamId(req, userId, conversationId),
    requested,
  };
}

function voiceTaskIdForRequest(req) {
  const taskId = req?.body?.viventiumVoiceTaskId;
  return typeof taskId === 'string' && taskId.trim() ? taskId.trim() : '';
}

async function isVoiceTaskOutputSuppressedDurably(req) {
  const taskId = voiceTaskIdForRequest(req);
  if (!taskId) return false;
  return isVoiceTaskSuppressedDurably(taskId, {
    callSessionId: req?.body?.viventiumCallSessionId,
    userId: req?.user?.id,
    streamId: req?.body?.streamId,
  });
}

async function pullConversationMessageReference(req, conversationId, messageObjectId) {
  if (!conversationId || !messageObjectId) return;
  /* === VIVENTIUM START ===
   * Feature: Cross-surface logical-turn coherence.
   * Purpose: Retraction is an owning Mongo metadata update, not a search-document
   *          mutation. Use the native collection so an unavailable derived
   *          Meilisearch hook cannot block revision 2 from being accepted.
   * === VIVENTIUM END === */
  await Conversation.collection.updateOne(
    { user: req?.user?.id, conversationId },
    { $pull: { messages: messageObjectId } },
  );
}

async function removeSuppressedAssistantMessage(req, message) {
  const taskId = voiceTaskIdForRequest(req);
  if (!taskId || message?.isCreatedByUser === true || !message?.messageId) return false;
  const removed = await Message.findOneAndDelete({
    user: req?.user?.id,
    messageId: message.messageId,
  });
  if (removed?._id && message?.conversationId) {
    await pullConversationMessageReference(req, message.conversationId, removed._id);
  }
  logger.warn('[VIVENTIUM][voice-task] Removed assistant output saved during cancellation race', {
    taskId,
    messageId: message.messageId,
  });
  return true;
}

async function isSupersededRequest(req) {
  const streamId = req?._resumableStreamId;
  if (!streamId || !getTrustedInteractionContext(req)?.logical_turn_id) return false;
  const job = await GenerationJobManager.getJob(streamId);
  return job?.status === 'superseded';
}

async function removeSupersededAssistantMessage(req, message, interactionContextOverride) {
  if (message?.isCreatedByUser === true || !message?.messageId) return false;
  const interactionContext = interactionContextOverride || getTrustedInteractionContext(req);
  const removed = await Message.findOneAndDelete({
    user: req?.user?.id,
    messageId: message.messageId,
    isCreatedByUser: { $ne: true },
    unfinished: true,
    'metadata.viventium.interactionContext.logical_turn_id': interactionContext?.logical_turn_id,
    'metadata.viventium.interactionContext.revision': interactionContext?.revision,
  });
  if (removed?._id && message?.conversationId) {
    await pullConversationMessageReference(req, message.conversationId, removed._id);
  }
  return Boolean(removed);
}

async function removeSupersededPresentations(req, presentations) {
  for (const presentation of presentations || []) {
    if (!presentation?.responseMessageId) continue;
    await removeSupersededAssistantMessage(
      req,
      {
        messageId: presentation.responseMessageId,
        conversationId: presentation.conversationId,
        isCreatedByUser: false,
      },
      presentation.interactionContext,
    );
  }
}

const timedSaveMessage = async (req, message, options, step) => {
  const taskId = voiceTaskIdForRequest(req);
  if (
    message?.isCreatedByUser !== true &&
    taskId &&
    (await isVoiceTaskOutputSuppressedDurably(req))
  ) {
    logger.warn('[VIVENTIUM][voice-task] Suppressed late assistant persistence', {
      taskId,
      messageId: message?.messageId,
      step,
    });
    return { suppressed: true, taskId };
  }
  if (message?.isCreatedByUser !== true && (await isSupersededRequest(req))) {
    await removeSupersededAssistantMessage(req, message);
    return { suppressed: true, reason: 'superseded' };
  }
  const messageToSave = attachInteractionContextMetadata(
    req,
    attachQaRunReceipt(req, attachVoiceMessageMetadata(req, message)),
  );
  const t = isDeepTimingEnabled(req) ? startDeepTiming(req) : null;
  const result = await saveMessage(req, messageToSave, options);
  if (message?.isCreatedByUser !== true && (await isSupersededRequest(req))) {
    await removeSupersededAssistantMessage(req, messageToSave);
    return { suppressed: true, reason: 'superseded' };
  }
  if (isInternalOrigin(req) && messageToSave?.conversationId) {
    if (messageToSave.isCreatedByUser !== true && !isTrustedInternalMessage(messageToSave)) {
      await Conversation.updateOne(
        { user: req?.user?.id, conversationId: messageToSave.conversationId },
        { $set: { isArchived: false } },
      );
    } else {
      /* === VIVENTIUM NOTE ===
       * Feature: Keep a scheduler-only durable conversation out of the interactive chat list.
       * Reason: `isArchived: false` is both the schema default and the state after the first
       * deliverable result, so the flag alone cannot distinguish a new silent conversation from
       * one the scheduler has already made useful. Existing persisted assistant output is the
       * source of truth: archive only while no completed user-visible assistant result exists.
       */
      const hasDeliverableAssistant = await Message.exists({
        user: req?.user?.id,
        conversationId: messageToSave.conversationId,
        isCreatedByUser: { $ne: true },
        unfinished: { $ne: true },
        'metadata.viventium.visibility': { $ne: 'internal' },
      });
      if (!hasDeliverableAssistant) {
        await Conversation.updateOne(
          { user: req?.user?.id, conversationId: messageToSave.conversationId },
          { $set: { isArchived: true } },
        );
      }
    }
  }
  if (
    message?.isCreatedByUser !== true &&
    taskId &&
    (await isVoiceTaskOutputSuppressedDurably(req))
  ) {
    await removeSuppressedAssistantMessage(req, messageToSave);
    return { suppressed: true, taskId };
  }
  if (t != null) {
    logDeepTiming(req, step, t, `messageId=${message?.messageId || 'na'}`);
  }
  return result;
};
/* === VIVENTIUM NOTE END === */

const PARTIAL_RESPONSE_CHECKPOINT_MS = 3000;
const PARTIAL_RESPONSE_PLACEHOLDER_DELAY_MS = 5000;

function extractTextFromContentParts(contentParts = []) {
  if (!Array.isArray(contentParts) || contentParts.length === 0) {
    return '';
  }

  return contentParts
    .filter((part) => part?.type === 'text')
    .map((part) => {
      if (typeof part?.text === 'string') {
        return part.text;
      }
      if (typeof part?.text?.value === 'string') {
        return part.text.value;
      }
      return '';
    })
    .join('')
    .trim();
}

function sanitizePersistedAssistantText(req, text) {
  if (typeof text !== 'string') {
    return '';
  }
  if (req.body?.voiceMode === true) {
    return stripVoiceControlTagsForDisplay(text);
  }
  return text;
}

function sanitizePersistedAssistantContent(req, content) {
  if (!Array.isArray(content) || req.body?.voiceMode !== true) {
    return content;
  }

  let changed = false;
  const sanitized = [];

  for (const part of content) {
    if (!part || typeof part !== 'object') {
      sanitized.push(part);
      continue;
    }

    /* === VIVENTIUM START ===
     * Feature: Voice reasoning visibility guard.
     * Purpose: Provider thinking/reasoning blocks are never audible voice response content, so
     * do not persist them into the conversation transcript for voice calls.
     * Added: 2026-05-14
     */
    if (part.type === ContentTypes.THINK || part.type === 'reasoning') {
      changed = true;
      continue;
    }
    /* === VIVENTIUM END === */

    if (part.type !== 'text') {
      sanitized.push(part);
      continue;
    }

    const rawText =
      typeof part.text === 'string'
        ? part.text
        : typeof part.text?.value === 'string'
          ? part.text.value
          : '';
    const cleanedText = stripVoiceControlTagsForDisplay(rawText);
    if (cleanedText === rawText) {
      sanitized.push(part);
      continue;
    }

    changed = true;
    if (typeof part.text === 'string') {
      sanitized.push({
        ...part,
        text: cleanedText,
      });
      continue;
    }

    if (part.text && typeof part.text === 'object') {
      sanitized.push({
        ...part,
        text: {
          ...part.text,
          value: cleanedText,
        },
      });
      continue;
    }

    sanitized.push({
      ...part,
      text: cleanedText,
    });
  }

  return changed ? sanitized : content;
}

/* === VIVENTIUM START ===
 * Feature: Voice/content persistence parity.
 * Purpose: Some streaming providers return final assistant messages with content parts populated
 * but legacy `text` empty. LibreChat can render the content parts, but search/export/older paths
 * still expect `text` to mirror visible assistant speech.
 * Added: 2026-05-15
 */
function normalizePersistedAssistantResponse(req, response) {
  const persistedResponse = sanitizeVoiceAssistantMessageForPersistence(req, response);
  if (req?.body?.voiceMode === true) {
    return persistedResponse;
  }

  const currentText = typeof persistedResponse.text === 'string' ? persistedResponse.text : '';
  const contentText = extractTextFromContentParts(persistedResponse.content);
  if (!currentText && contentText) {
    return {
      ...persistedResponse,
      text: contentText,
    };
  }
  return persistedResponse;
}
/* === VIVENTIUM END === */

async function persistAssistantSnapshot({
  req,
  streamId,
  userId,
  client,
  conversationId,
  aggregatedContent,
  userMessage,
  responseMessageId,
  sender,
  fallbackText = '',
  unfinished = true,
  error = false,
  context,
}) {
  let resolvedUserMessage =
    userMessage?.messageId != null
      ? {
          messageId: userMessage.messageId,
          parentMessageId: userMessage.parentMessageId,
          conversationId: userMessage.conversationId,
          text: userMessage.text,
        }
      : null;
  let resolvedResponseMessageId =
    typeof responseMessageId === 'string' && responseMessageId.trim().length > 0
      ? responseMessageId
      : null;
  let resolvedConversationId =
    conversationId || userMessage?.conversationId || client?.conversationId || null;
  let resolvedSender = client?.sender ?? sender ?? null;
  let resumeState = null;

  if (
    !resolvedUserMessage ||
    !resolvedResponseMessageId ||
    !resolvedConversationId ||
    !resolvedSender
  ) {
    resumeState = await GenerationJobManager.getResumeState(streamId);
    resolvedUserMessage =
      resolvedUserMessage ??
      (resumeState?.userMessage?.messageId
        ? {
            messageId: resumeState.userMessage.messageId,
            parentMessageId: resumeState.userMessage.parentMessageId,
            conversationId: resumeState.userMessage.conversationId,
            text: resumeState.userMessage.text,
          }
        : null);
    resolvedResponseMessageId = resolvedResponseMessageId ?? resumeState?.responseMessageId ?? null;
    resolvedConversationId =
      resolvedConversationId ??
      resumeState?.conversationId ??
      resolvedUserMessage?.conversationId ??
      null;
    resolvedSender = resolvedSender ?? resumeState?.sender ?? null;
  }

  if (!resolvedUserMessage?.messageId) {
    logger.debug(
      '[ResumableAgentController] No user message available for assistant snapshot save',
    );
    return { persisted: false, fingerprint: null };
  }

  const rawContent = Array.isArray(aggregatedContent)
    ? aggregatedContent.filter(Boolean)
    : (resumeState?.aggregatedContent ?? []);
  const effectiveContent = sanitizePersistedAssistantContent(req, rawContent);
  const extractedText = extractTextFromContentParts(effectiveContent);
  const text = sanitizePersistedAssistantText(req, extractedText || fallbackText || '');

  if (effectiveContent.length === 0 && text.length === 0) {
    return { persisted: false, fingerprint: null };
  }

  const messageId = resolvedResponseMessageId || `${resolvedUserMessage.messageId}_`;
  const responseConversationId = resolvedConversationId || conversationId;
  const resolvedSnapshotSender = resolvedSender || 'AI';
  const endpoint = client?.options?.endpoint;
  const model = client?.model;
  const fingerprint = JSON.stringify({
    messageId,
    text,
    contentLength: effectiveContent.length,
    unfinished,
    error,
  });

  await timedSaveMessage(
    req,
    {
      messageId,
      conversationId: responseConversationId,
      parentMessageId: resolvedUserMessage.messageId,
      sender: resolvedSnapshotSender,
      content: effectiveContent,
      text,
      unfinished,
      error,
      isCreatedByUser: false,
      endpoint,
      model,
      user: userId,
      ...(req.body?.agent_id ? { agent_id: req.body.agent_id } : {}),
    },
    { context },
    error ? 'db_save_error_response' : 'db_save_partial_response',
  );

  return { persisted: true, fingerprint };
}

/* === VIVENTIUM NOTE ===
 * Feature: Voice sessions bypass concurrent limiter (avoids voice stalls)
 * Purpose: When handling a LiveKit voice call session, skip the concurrent request limiter to prevent mid-call stalls.
 * Added: 2026-01-11
 */
function isVoiceConcurrencyBypassed(req) {
  if (!req?.viventiumCallSession) {
    return false;
  }
  const raw = (process.env.VIVENTIUM_VOICE_BYPASS_CONCURRENCY || 'true').toLowerCase();
  return !['false', '0', 'no', 'off'].includes(raw);
}
/* === VIVENTIUM NOTE END === */

/* === VIVENTIUM NOTE ===
 * Feature: Voice latency stage logging (request controller split).
 * Purpose: Split ready->chat_completion_start into initialize/ready-gate/sendMessage stages.
 * Added: 2026-03-03
 */
const isVoiceLatencyEnabled = (req) => req?.viventiumVoiceLogLatency === true;

const getVoiceLatencyRequestId = (req) => {
  const requestId = req?.viventiumVoiceRequestId;
  if (typeof requestId === 'string' && requestId.length > 0) {
    return requestId;
  }
  return 'unknown';
};

const logVoiceLatencyStage = (req, stage, stageStartAt = null, details = '') => {
  if (!isVoiceLatencyEnabled(req)) {
    return;
  }

  const requestId = getVoiceLatencyRequestId(req);
  const timingPart = formatVoiceLatencyTiming(req, stageStartAt);
  const detailPart = details ? ` ${details}` : '';
  logger.info(
    `[VoiceLatency][LC] stage=${stage} request_id=${requestId} ${timingPart}${detailPart}`,
  );
};
/* === VIVENTIUM NOTE END === */

function createCloseHandler(abortController) {
  return function (manual) {
    if (!manual) {
      logger.debug('[AgentController] Request closed');
    }
    if (!abortController) {
      return;
    } else if (abortController.signal.aborted) {
      return;
    } else if (abortController.requestCompleted) {
      return;
    }

    abortController.abort();
    logger.debug('[AgentController] Request aborted on close');
  };
}

/**
 * Resumable Agent Controller - Generation runs independently of HTTP connection.
 * Returns streamId immediately, client subscribes separately via SSE.
 */
const ResumableAgentController = async (req, res, next, initializeClient, addTitle) => {
  const {
    text,
    isRegenerate,
    endpointOption,
    conversationId: reqConversationId,
    isContinued = false,
    editedContent = null,
    parentMessageId = null,
    overrideParentMessageId = null,
    responseMessageId: editedResponseMessageId = null,
  } = req.body;

  const userId = req.user.id;

  /* === VIVENTIUM NOTE ===
   * Feature: Voice concurrency bypass (default on)
   * Purpose: Allow voice sessions to bypass the concurrent request limiter to avoid voice stalls mid-call.
   * Added: 2026-01-11
   */
  const bypassConcurrency = isVoiceConcurrencyBypassed(req);
  let didIncrement = false;
  if (!bypassConcurrency) {
    const { allowed, pendingRequests, limit } = await checkAndIncrementPendingRequest(userId);
    if (!allowed) {
      const violationInfo = getViolationInfo(pendingRequests, limit);
      await logViolation(req, res, ViolationTypes.CONCURRENT, violationInfo, violationInfo.score);
      return res.status(429).json(violationInfo);
    }
    didIncrement = true;
  } else {
    logger.debug('[concurrency] Bypassing concurrent request limit for voice session');
  }
  /* === VIVENTIUM NOTE END === */

  const maybeDecrement = async () => {
    if (!didIncrement) {
      return;
    }
    await decrementPendingRequest(userId);
  };

  // Generate conversationId upfront if not provided.
  // Treat "new" as a placeholder that needs a real UUID (frontend may send "new" for new convos)
  const conversationId = resolveCanonicalConversationId(req, userId, reqConversationId);
  /* === VIVENTIUM NOTE ===
   * Feature: Allow caller-supplied streamId to avoid stream collisions (Telegram).
   * Purpose: Telegram bridge can pass a stable streamId so resumable jobs don't collide across surfaces.
   * Added: 2026-01-31
   */
  const { streamId, requested: reqStreamId } = await resolveRequestStreamId(
    req,
    userId,
    conversationId,
  );
  req._resumableStreamId = streamId;
  const interactionContext = captureRequestInteractionContext(req, { conversationId, streamId });
  /* === VIVENTIUM NOTE END === */
  const voiceLatencyEnabled = isVoiceLatencyEnabled(req);

  let client = null;

  try {
    logger.debug(`[ResumableAgentController] Creating job`, {
      streamId,
      conversationId,
      reqConversationId,
      userId,
    });

    const voiceJobCreateStart = voiceLatencyEnabled ? voiceLatencyNow() : 0;
    const job = await GenerationJobManager.createJob(streamId, userId, conversationId, {
      interactionContext,
      adapterCapabilities: getTrustedAdapterCapabilities(req),
      deliveryPolicy: getTrustedDeliveryPolicy(req),
    });
    if (job.duplicateOfStreamId) {
      await maybeDecrement();
      return res.status(202).json(duplicateGenerationReceipt(req, job, conversationId));
    }
    const claimedInteractionContext = bindLogicalTurnContext(req, job.metadata?.interactionContext);
    await removeSupersededPresentations(req, job.supersededPresentations);
    /* === VIVENTIUM START ===
     * Feature: voice-task owner metadata and composed cancellation signal
     * Purpose: Carry task identity and the real generation abort signal into every owning layer.
     * === VIVENTIUM END === */
    req._viventiumVoiceAbortSignal = job.abortController.signal;
    const viventiumVoiceTaskId = voiceTaskIdForRequest(req);
    if (viventiumVoiceTaskId) {
      await GenerationJobManager.updateMetadata(streamId, {
        viventiumVoiceTaskId,
        ...(req?.body?.viventiumCallSessionId
          ? { viventiumCallSessionId: req.body.viventiumCallSessionId }
          : {}),
      });
    }
    if (voiceLatencyEnabled) {
      logVoiceLatencyStage(
        req,
        'job_created',
        voiceJobCreateStart,
        `stream_id=${streamId} stream_id_source=${reqStreamId ? 'request' : 'conversation'} conversation_id=${conversationId}`,
      );
    }
    const jobCreatedAt = job.createdAt; // Capture creation time to detect job replacement
    req._resumableStreamId = streamId;

    // Send JSON response IMMEDIATELY so client can connect to SSE stream
    // This is critical: tool loading (MCP OAuth) may emit events that the client needs to receive
    const voiceReadyJsonStart = voiceLatencyEnabled ? voiceLatencyNow() : 0;
    res.json({
      streamId,
      conversationId,
      status: 'started',
      logical_turn_id: claimedInteractionContext?.logical_turn_id,
      revision: claimedInteractionContext?.revision,
    });
    if (voiceLatencyEnabled) {
      logVoiceLatencyStage(
        req,
        'resumable_ready_sent',
        voiceReadyJsonStart,
        `stream_id=${streamId} stream_id_source=${
          reqStreamId ? 'request' : 'conversation'
        } conversation_id=${conversationId}`,
      );
    }

    /* === VIVENTIUM NOTE ===
     * Feature: Morning Briefing Bootstrap (fire-and-forget).
     * Runs after res.json() so it never blocks the user's response.
     */
    let morningBriefingSurface = 'web';
    if (req._viventiumTelegram) {
      morningBriefingSurface = 'telegram';
    } else if (req.viventiumCallSession) {
      morningBriefingSurface = 'voice';
    }

    ensureMorningBriefing({
      userId,
      clientTimezone: req.body?.clientTimezone,
      surface: morningBriefingSurface,
    }).catch(() => {});
    /* === VIVENTIUM NOTE END === */

    // Note: We no longer use res.on('close') to abort since we send JSON immediately.
    // The response closes normally after res.json(), which is not an abort condition.
    // Abort handling is done through GenerationJobManager via the SSE stream connection.

    let lastAssistantSnapshotFingerprint = null;
    let partialCheckpointTimer = null;
    let generationStartedAt = null;
    let placeholderSnapshotSaved = false;
    /* === VIVENTIUM START ===
     * Feature: Monotonic assistant checkpoint finalization.
     * Purpose: A BaseClient/partial checkpoint can already own the response message id. Track every
     * unfinished write and drain it before the controller's terminal upsert so a late checkpoint
     * cannot leave a visibly completed response persisted as `unfinished: true`.
     */
    let assistantTerminalPersistenceStarted = false;
    const inFlightAssistantSnapshots = new Set();
    const trackAssistantSnapshot = (createSnapshot) => {
      const snapshotPromise = Promise.resolve().then(createSnapshot);
      inFlightAssistantSnapshots.add(snapshotPromise);
      snapshotPromise.finally(() => inFlightAssistantSnapshots.delete(snapshotPromise));
      return snapshotPromise;
    };
    const beginAssistantTerminalPersistence = async () => {
      assistantTerminalPersistenceStarted = true;
      stopPartialCheckpointing();
      if (inFlightAssistantSnapshots.size > 0) {
        await Promise.allSettled([...inFlightAssistantSnapshots]);
      }
    };
    /* === VIVENTIUM END === */
    const stopPartialCheckpointing = () => {
      if (partialCheckpointTimer) {
        clearInterval(partialCheckpointTimer);
        partialCheckpointTimer = null;
      }
    };

    /**
     * Listen for all subscribers leaving to save partial response.
     * This ensures the response is saved to DB even if all clients disconnect
     * while generation continues.
     *
     * Note: The messageId used here falls back to `${userMessage.messageId}_` if the
     * actual response messageId isn't available yet. The final response save will
     * overwrite this with the complete response using the same messageId pattern.
     */
    let sender = client?.sender;
    let userMessage;
    let userMessageSavePromise = null;
    let responseMessageId = editedResponseMessageId;

    const ensureUserSourceSegmentPersisted = async () => {
      if (client?.skipSaveUserMessage || !userMessage) {
        return;
      }
      if (!userMessageSavePromise) {
        userMessageSavePromise = timedSaveMessage(
          req,
          userMessage,
          {
            context:
              'api/server/controllers/agents/request.js - user source segment before generation',
          },
          'db_save_user',
        );
      }
      await userMessageSavePromise;
    };

    job.emitter.on('allSubscribersLeft', async (aggregatedContent) => {
      if (
        assistantTerminalPersistenceStarted ||
        !aggregatedContent ||
        aggregatedContent.length === 0
      ) {
        return;
      }

      try {
        const snapshot = await trackAssistantSnapshot(() =>
          persistAssistantSnapshot({
            req,
            streamId,
            userId,
            client,
            conversationId,
            aggregatedContent,
            userMessage,
            responseMessageId,
            sender,
            unfinished: true,
            error: false,
            context: 'api/server/controllers/agents/request.js - partial response on disconnect',
          }),
        );
        if (!snapshot.persisted) {
          return;
        }
        lastAssistantSnapshotFingerprint = snapshot.fingerprint;

        logger.debug(
          `[ResumableAgentController] Saved partial response for ${streamId}, content parts: ${aggregatedContent.length}`,
        );
      } catch (error) {
        logger.error('[ResumableAgentController] Error saving partial response:', error);
      }
    });

    /** @type {{ client: TAgentClient; userMCPAuthMap?: Record<string, Record<string, string>> }} */
    const initStart = startDeepTiming(req);
    const voiceInitStart = voiceLatencyEnabled ? voiceLatencyNow() : 0;
    if (voiceLatencyEnabled) {
      logVoiceLatencyStage(req, 'initialize_client_start', null, `stream_id=${streamId}`);
    }
    const result = await initializeClient({
      req,
      res,
      endpointOption,
      // Use the job's abort controller signal - allows abort via GenerationJobManager.abortJob()
      signal: job.abortController.signal,
    });
    if (isDeepTimingEnabled(req)) {
      logDeepTiming(req, 'initialize_client', initStart);
    }
    if (voiceLatencyEnabled) {
      logVoiceLatencyStage(req, 'initialize_client_done', voiceInitStart, `stream_id=${streamId}`);
    }

    if (job.abortController.signal.aborted) {
      GenerationJobManager.completeJob(streamId, 'Request aborted during initialization');
      await maybeDecrement();
      return;
    }

    client = result.client;
    sender = client?.sender;
    if (viventiumVoiceTaskId && req._viventiumHarnessExecutionEnabled === true) {
      setVoiceTaskOwnerCapabilities(viventiumVoiceTaskId, {
        kind: 'remote_generation',
        ownerId: streamId,
        cancellationConfirmable: false,
        acceptsInput: false,
      });
    }

    if (client?.sender) {
      await GenerationJobManager.updateMetadata(streamId, { sender: client.sender });
    }

    // Store reference to client's contentParts - graph will be set when run is created
    if (client?.contentParts) {
      GenerationJobManager.setContentParts(streamId, client.contentParts);
    }

    const getReqData = (data = {}) => {
      if (data.userMessage) {
        userMessage = data.userMessage;
      }
      if (typeof data.responseMessageId === 'string' && data.responseMessageId.length > 0) {
        responseMessageId = data.responseMessageId;
      }
      if (typeof data.sender === 'string' && data.sender.length > 0) {
        sender = data.sender;
      }
      // conversationId is pre-generated, no need to update from callback
    };

    // Start background generation - readyPromise resolves immediately now
    // (sync mechanism handles late subscribers)
    const startGeneration = async () => {
      if (voiceLatencyEnabled) {
        logVoiceLatencyStage(req, 'start_generation_enter', null, `stream_id=${streamId}`);
      }
      let readyGateTimedOut = false;
      const voiceReadyGateStart = voiceLatencyEnabled ? voiceLatencyNow() : 0;
      try {
        // Short timeout as safety net - promise should already be resolved
        await Promise.race([
          job.readyPromise,
          new Promise((resolve) =>
            setTimeout(() => {
              readyGateTimedOut = true;
              resolve();
            }, 100),
          ),
        ]);
      } catch (waitError) {
        logger.warn(
          `[ResumableAgentController] Error waiting for subscriber: ${waitError.message}`,
        );
        if (voiceLatencyEnabled) {
          logVoiceLatencyStage(
            req,
            'ready_promise_wait_error',
            voiceReadyGateStart,
            `stream_id=${streamId} reason=${waitError?.message || 'unknown'}`,
          );
        }
      }
      if (voiceLatencyEnabled) {
        logVoiceLatencyStage(
          req,
          'ready_promise_wait_done',
          voiceReadyGateStart,
          `stream_id=${streamId} timed_out=${readyGateTimedOut}`,
        );
      }

      try {
        const onStart = (userMsg, respMsgId, _isNewConvo) => {
          userMessage = userMsg;
          responseMessageId = respMsgId;
          generationStartedAt = Date.now();

          // Register the whole start sequence synchronously. Some clients invoke `onStart`
          // without awaiting it, so terminal persistence must still see and drain this work.
          return trackAssistantSnapshot(async () => {
            await ensureUserSourceSegmentPersisted();

            if (!assistantTerminalPersistenceStarted) {
              try {
                const snapshot = await persistAssistantSnapshot({
                  req,
                  streamId,
                  userId,
                  client,
                  conversationId,
                  aggregatedContent: [],
                  userMessage,
                  responseMessageId,
                  sender,
                  fallbackText: 'Generation in progress.',
                  unfinished: true,
                  error: false,
                  context:
                    'api/server/controllers/agents/request.js - initial assistant placeholder',
                });
                if (snapshot.persisted) {
                  placeholderSnapshotSaved = true;
                  lastAssistantSnapshotFingerprint = snapshot.fingerprint;
                }
              } catch (snapshotError) {
                logger.warn(
                  `[ResumableAgentController] Failed initial assistant placeholder for ${streamId}: ${snapshotError?.message || 'unknown'}`,
                );
              }
            }

            // Store userMessage and responseMessageId upfront for resume capability
            await GenerationJobManager.updateMetadata(streamId, {
              responseMessageId: respMsgId,
              userMessage: {
                messageId: userMsg.messageId,
                parentMessageId: userMsg.parentMessageId,
                conversationId: userMsg.conversationId,
                text: userMsg.text,
              },
            });

            await GenerationJobManager.emitChunk(streamId, {
              created: true,
              message: userMessage,
              streamId,
            });
          });
        };

        const startPartialCheckpointing = () => {
          if (partialCheckpointTimer) {
            return;
          }

          partialCheckpointTimer = setInterval(async () => {
            if (assistantTerminalPersistenceStarted || job.abortController.signal.aborted) {
              return;
            }

            try {
              const contentParts = Array.isArray(client?.contentParts)
                ? client.contentParts.filter(Boolean)
                : [];
              const extractedText = extractTextFromContentParts(contentParts);
              const hasMeaningfulContent = contentParts.length > 0 || extractedText.length > 0;

              let fallbackText = '';
              if (
                !hasMeaningfulContent &&
                !placeholderSnapshotSaved &&
                generationStartedAt != null &&
                Date.now() - generationStartedAt >= PARTIAL_RESPONSE_PLACEHOLDER_DELAY_MS
              ) {
                fallbackText = 'Generation in progress.';
              }

              if (!hasMeaningfulContent && !fallbackText) {
                return;
              }

              const snapshot = await trackAssistantSnapshot(() =>
                persistAssistantSnapshot({
                  req,
                  streamId,
                  userId,
                  client,
                  conversationId,
                  aggregatedContent: contentParts,
                  userMessage,
                  responseMessageId,
                  sender,
                  fallbackText,
                  unfinished: true,
                  error: false,
                  context: 'api/server/controllers/agents/request.js - periodic assistant snapshot',
                }),
              );

              if (
                !snapshot.persisted ||
                snapshot.fingerprint === lastAssistantSnapshotFingerprint
              ) {
                return;
              }

              if (fallbackText) {
                placeholderSnapshotSaved = true;
              }
              lastAssistantSnapshotFingerprint = snapshot.fingerprint;
            } catch (snapshotError) {
              logger.warn(
                `[ResumableAgentController] Failed periodic assistant snapshot for ${streamId}: ${snapshotError?.message || 'unknown'}`,
              );
            }
          }, PARTIAL_RESPONSE_CHECKPOINT_MS);
        };

        const messageOptions = {
          user: userId,
          onStart,
          getReqData,
          isContinued,
          isRegenerate,
          editedContent,
          conversationId,
          parentMessageId,
          abortController: job.abortController,
          overrideParentMessageId,
          isEdited: !!editedContent,
          userMCPAuthMap: result.userMCPAuthMap,
          responseMessageId: editedResponseMessageId,
          progressOptions: {
            res: {
              write: () => true,
              end: () => {},
              headersSent: false,
              writableEnded: false,
            },
          },
        };

        const voiceSendMessageStart = voiceLatencyEnabled ? voiceLatencyNow() : 0;
        if (voiceLatencyEnabled) {
          logVoiceLatencyStage(req, 'send_message_start', null, `stream_id=${streamId}`);
        }
        startPartialCheckpointing();
        const response = await client.sendMessage(text, messageOptions);
        await beginAssistantTerminalPersistence();
        if (voiceLatencyEnabled) {
          logVoiceLatencyStage(
            req,
            'send_message_done',
            voiceSendMessageStart,
            `stream_id=${streamId} message_id=${response?.messageId || 'unknown'}`,
          );
        }

        const messageId = response.messageId;
        const endpoint = endpointOption.endpoint;
        response.endpoint = endpoint;

        const databasePromise = response.databasePromise;
        delete response.databasePromise;

        const { conversation: convoData = {} } = await databasePromise;
        const conversation = { ...convoData };
        conversation.title =
          conversation && !conversation.title ? null : conversation?.title || 'New Chat';

        if (req.body.files && client.options?.attachments) {
          userMessage.files = [];
          const messageFiles = new Set(req.body.files.map((file) => file.file_id));
          for (const attachment of client.options.attachments) {
            if (messageFiles.has(attachment.file_id)) {
              userMessage.files.push(sanitizeFileForTransmit(attachment));
            }
          }
          delete userMessage.image_urls;
        }

        // Check abort state BEFORE calling completeJob (which triggers abort signal for cleanup)
        const wasAbortedBeforeComplete = job.abortController.signal.aborted;
        const isNewConvo = !reqConversationId || reqConversationId === 'new';
        const shouldGenerateTitle =
          addTitle &&
          parentMessageId === Constants.NO_PARENT &&
          isNewConvo &&
          !wasAbortedBeforeComplete;

        // Save user message BEFORE sending final event to avoid race condition
        // where client refetch happens before database is updated
        await ensureUserSourceSegmentPersisted();

        // CRITICAL: Save response message BEFORE emitting final event.
        // This prevents race conditions where the client sends a follow-up message
        // before the response is saved to the database, causing orphaned parentMessageIds.
        const requiresExternalDeliveryAcknowledgement =
          getTrustedDeliveryPolicy(req)?.commit_authority === 'external_adapter';
        /* === VIVENTIUM START ===
         * Feature: Authoritative terminal assistant persistence.
         * Purpose: `savedMessageIds` means a row exists, not that its unfinished/commit state is
         * terminal. Always upsert the final server-owned revision after draining partial writes.
         */
        {
          /* === VIVENTIUM NOTE ===
           * Feature: Strip voice control tags from persisted response text.
           * Purpose: Voice mode responses contain Cartesia SSML tags and bracket nonverbal markers
           * that TTS needs, but should not appear in the persisted message text.
           * The SSE stream (consumed by voice gateway for TTS) is unaffected.
           */
          const persistedResponse = normalizePersistedAssistantResponse(req, {
            ...response,
            user: userId,
            unfinished: wasAbortedBeforeComplete || requiresExternalDeliveryAcknowledgement,
          });
          /* === VIVENTIUM NOTE END === */
          await timedSaveMessage(
            req,
            persistedResponse,
            { context: 'api/server/controllers/agents/request.js - resumable response end' },
            'db_save_response',
          );
        }
        /* === VIVENTIUM END === */

        // Check if our job was replaced by a new request before emitting
        // This prevents stale requests from emitting events to newer jobs
        const currentJob = await GenerationJobManager.getJob(streamId);
        const jobWasReplaced =
          !currentJob ||
          currentJob.createdAt !== jobCreatedAt ||
          currentJob.status === 'superseded';

        if (jobWasReplaced) {
          stopPartialCheckpointing();
          logger.debug(`[ResumableAgentController] Skipping FINAL emit - job was replaced`, {
            streamId,
            originalCreatedAt: jobCreatedAt,
            currentCreatedAt: currentJob?.createdAt,
          });
          // Still decrement pending request since we incremented at start
          if (currentJob?.status === 'superseded') {
            await removeSupersededAssistantMessage(req, {
              messageId,
              conversationId,
              isCreatedByUser: false,
            });
          }
          await maybeDecrement();
          return;
        }

        if (!wasAbortedBeforeComplete && !(await isVoiceTaskOutputSuppressedDurably(req))) {
          /* === VIVENTIUM NOTE ===
           * Feature: Log empty responses for Telegram debugging.
           * Added: 2026-02-01
           */
          const hasResponseText = !!(
            response?.text ||
            (Array.isArray(response?.content) &&
              response.content.some((p) => p?.type === 'text' && (p?.text || p?.text?.value)))
          );
          if (!hasResponseText && req._viventiumTelegram) {
            logger.warn(
              `[ResumableAgentController] Empty response for Telegram: streamId=${streamId} ` +
                `contentLength=${response?.content?.length ?? 0} ` +
                `text=${!!response?.text} ` +
                `error=${!!response?.error}`,
            );
          }
          /* === VIVENTIUM NOTE END === */

          const responseMessageForTransmit = normalizePersistedAssistantResponse(req, response);
          const finalEvent = {
            final: true,
            conversation,
            title: conversation.title,
            requestMessage: sanitizeMessageForTransmit(userMessage),
            responseMessage: responseMessageForTransmit,
          };

          logger.debug(`[ResumableAgentController] Emitting FINAL event`, {
            streamId,
            wasAbortedBeforeComplete,
            userMessageId: userMessage?.messageId,
            responseMessageId: response?.messageId,
            conversationId: conversation?.conversationId,
          });

          /* Main is complete even while Phase B continues. Mark the job non-active immediately so
           * reload/resume cannot present a destructive Stop action against a persisted final answer.
           * The existing Phase B poller remains the durable out-of-band delivery path. */
          await GenerationJobManager.markMainResponseComplete(streamId, finalEvent);
          await GenerationJobManager.emitDone(streamId, finalEvent);
          if (getTrustedDeliveryPolicy(req)?.commit_authority === 'server') {
            await GenerationJobManager.acknowledgeStreamDelivery(streamId, {
              state: 'committed',
              presentation_ref: response?.messageId,
            });
          }
          await maybeDecrement();

          /* === VIVENTIUM START ===
           * Feature: Phase B follow-up SSE delivery window.
           *
           * Why:
           * - `completeJob()` aborts runtime + tears down stream state.
           * - Phase B follow-up emits after FINAL in an async promise chain.
           * - Completing immediately can drop `on_cortex_followup` chunks.
           *
           * Approach:
           * - FINAL is still emitted immediately (no user-visible latency regression).
           * - Keep stream runtime alive briefly for Phase B follow-up emission, bounded by timeout.
           */
          const phaseBPromise = client?._phaseBPromise;
          if (phaseBPromise && typeof phaseBPromise.then === 'function') {
            const timeoutMs = getCortexFollowupGraceMs();
            const interactionContext = getTrustedInteractionContext(req);
            const isCallbackOrigin =
              interactionContext?.actor_kind === 'worker' &&
              interactionContext?.origin === 'callback';
            const phaseBWaitStartedAt = Date.now();
            if (voiceLatencyEnabled) {
              logVoiceLatencyStage(
                req,
                'phase_b_wait_start',
                null,
                `stream_id=${streamId} timeout_ms=${timeoutMs}`,
              );
            }
            try {
              let phaseBWaitOutcome = 'resolved';
              const observedPhaseBPromise = phaseBPromise.then(
                () => {
                  phaseBWaitOutcome = 'resolved';
                },
                (error) => {
                  phaseBWaitOutcome = 'rejected';
                  throw error;
                },
              );
              if (isCallbackOrigin) {
                await observedPhaseBPromise;
              } else {
                await Promise.race([
                  observedPhaseBPromise,
                  new Promise((resolve) =>
                    setTimeout(() => {
                      phaseBWaitOutcome = 'timeout';
                      resolve();
                    }, timeoutMs),
                  ),
                ]);
              }
              if (voiceLatencyEnabled) {
                logVoiceLatencyStage(
                  req,
                  'phase_b_wait_done',
                  phaseBWaitStartedAt,
                  `stream_id=${streamId} outcome=${phaseBWaitOutcome}`,
                );
              }
            } catch (phaseBError) {
              if (voiceLatencyEnabled) {
                logVoiceLatencyStage(
                  req,
                  'phase_b_wait_error',
                  phaseBWaitStartedAt,
                  `stream_id=${streamId}`,
                );
              }
              logger.warn(
                '[ResumableAgentController] Phase B wait failed before completeJob:',
                phaseBError?.message ?? String(phaseBError),
              );
            }
          } else if (voiceLatencyEnabled) {
            logVoiceLatencyStage(req, 'phase_b_wait_skipped', null, `stream_id=${streamId}`);
          }
          /* === VIVENTIUM END === */

          const currentJobAfterPhaseB = await GenerationJobManager.getJob(streamId);
          const jobWasReplacedAfterPhaseB =
            !currentJobAfterPhaseB || currentJobAfterPhaseB.createdAt !== jobCreatedAt;

          stopPartialCheckpointing();
          if (jobWasReplacedAfterPhaseB) {
            logger.warn(
              '[ResumableAgentController] Skipping completeJob - job was replaced after Phase B wait',
              {
                streamId,
                originalCreatedAt: jobCreatedAt,
                currentCreatedAt: currentJobAfterPhaseB?.createdAt,
              },
            );
            if (voiceLatencyEnabled) {
              logVoiceLatencyStage(
                req,
                'phase_b_complete_skipped_replaced_job',
                null,
                `stream_id=${streamId}`,
              );
            }
          } else {
            if (voiceLatencyEnabled) {
              logVoiceLatencyStage(req, 'phase_b_complete_job', null, `stream_id=${streamId}`);
            }
            GenerationJobManager.completeJob(streamId);
          }
        } else if (!(await isVoiceTaskOutputSuppressedDurably(req))) {
          const finalEvent = {
            final: true,
            conversation,
            title: conversation.title,
            requestMessage: sanitizeMessageForTransmit(userMessage),
            responseMessage: { ...response, unfinished: true },
          };

          logger.debug(`[ResumableAgentController] Emitting ABORTED FINAL event`, {
            streamId,
            wasAbortedBeforeComplete,
            userMessageId: userMessage?.messageId,
            responseMessageId: response?.messageId,
            conversationId: conversation?.conversationId,
          });

          await GenerationJobManager.emitDone(streamId, finalEvent);
          stopPartialCheckpointing();
          GenerationJobManager.completeJob(streamId, 'Request aborted');
          await maybeDecrement();
        } else {
          stopPartialCheckpointing();
          logger.info('[VIVENTIUM][voice-task] Late completion suppressed after cancellation', {
            taskId: voiceTaskIdForRequest(req),
            streamId,
          });
          GenerationJobManager.completeJob(streamId, 'Voice task cancelled');
          await maybeDecrement();
        }

        if (shouldGenerateTitle && !(await isVoiceTaskOutputSuppressedDurably(req))) {
          addTitle(req, {
            text,
            response: { ...response },
            client,
          })
            .catch((err) => {
              logger.error('[ResumableAgentController] Error in title generation', err);
            })
            .finally(() => {
              if (client) {
                disposeClient(client);
              }
            });
        } else {
          if (client) {
            disposeClient(client);
          }
        }
      } catch (error) {
        stopPartialCheckpointing();
        // Check if this was an abort (not a real error)
        const wasAborted = job.abortController.signal.aborted || error.message?.includes('abort');

        if (wasAborted) {
          logger.debug(`[ResumableAgentController] Generation aborted for ${streamId}`);
          if (job.abortController.signal.reason === 'superseded') {
            await ensureUserSourceSegmentPersisted();
            await removeSupersededAssistantMessage(req, {
              messageId: responseMessageId,
              conversationId,
              isCreatedByUser: false,
            });
          }
          // abortJob already handled emitDone and completeJob
        } else {
          if (voiceLatencyEnabled) {
            logVoiceLatencyStage(
              req,
              'send_message_error',
              null,
              `stream_id=${streamId} reason=${error?.message || 'unknown'}`,
            );
          }
          logger.error(`[ResumableAgentController] Generation error for ${streamId}:`, error);
          try {
            const contentParts = Array.isArray(client?.contentParts)
              ? client.contentParts.filter(Boolean)
              : [];
            const hasMeaningfulContent =
              contentParts.length > 0 || extractTextFromContentParts(contentParts).length > 0;
            const snapshot = await persistAssistantSnapshot({
              req,
              streamId,
              userId,
              client,
              conversationId,
              aggregatedContent: contentParts,
              userMessage,
              responseMessageId,
              sender,
              fallbackText: hasMeaningfulContent ? '' : 'Generation interrupted before completion.',
              unfinished: hasMeaningfulContent,
              error: !hasMeaningfulContent,
              context: 'api/server/controllers/agents/request.js - generation error snapshot',
            });
            if (snapshot.persisted) {
              lastAssistantSnapshotFingerprint = snapshot.fingerprint;
            }
          } catch (snapshotError) {
            logger.error(
              `[ResumableAgentController] Failed to persist generation error snapshot for ${streamId}:`,
              snapshotError,
            );
          }
          await GenerationJobManager.emitError(streamId, error.message || 'Generation failed');
          GenerationJobManager.completeJob(streamId, error.message);
        }

        await maybeDecrement();

        if (client) {
          disposeClient(client);
        }

        // Don't continue to title generation after error/abort
        return;
      }
    };

    // Start generation and handle any unhandled errors
    startGeneration().catch(async (err) => {
      stopPartialCheckpointing();
      logger.error(
        `[ResumableAgentController] Unhandled error in background generation: ${err.message}`,
      );
      try {
        const contentParts = Array.isArray(client?.contentParts)
          ? client.contentParts.filter(Boolean)
          : [];
        await persistAssistantSnapshot({
          req,
          streamId,
          userId,
          client,
          conversationId,
          aggregatedContent: contentParts,
          userMessage,
          responseMessageId,
          sender,
          fallbackText: contentParts.length > 0 ? '' : 'Generation interrupted before completion.',
          unfinished: contentParts.length > 0,
          error: contentParts.length === 0,
          context: 'api/server/controllers/agents/request.js - unhandled generation error snapshot',
        });
      } catch (snapshotError) {
        logger.error(
          `[ResumableAgentController] Failed to persist unhandled generation error snapshot for ${streamId}:`,
          snapshotError,
        );
      }
      GenerationJobManager.completeJob(streamId, err.message);
      await maybeDecrement();
    });
  } catch (error) {
    if (error?.code === 'stream_id_conflict') {
      logger.warn('[ResumableAgentController] Rejected a colliding generation stream identity', {
        userId,
        conversationId,
      });
      await maybeDecrement();
      if (!res.headersSent) {
        res.status(409).json({
          code: 'stream_id_conflict',
          error: 'Generation stream identity is already in use.',
        });
      }
      return;
    }
    /* === VIVENTIUM START ===
     * Feature: Safe pre-admission stream backpressure.
     * Purpose: Capacity and in-flight idempotency fences are retryable admission outcomes; they
     * must not be logged as private initialization faults or finalize a stream that was never made.
     * === VIVENTIUM END === */
    const retryableAdmissionErrors = {
      stream_capacity_exhausted: {
        status: 503,
        message: 'Generation capacity is temporarily exhausted.',
      },
      stream_creation_pending: {
        status: 409,
        message: 'The original generation stream is still being created.',
      },
      stream_store_unavailable: {
        status: 503,
        message: 'Generation storage is temporarily unavailable.',
      },
    };
    const admissionError = retryableAdmissionErrors[error?.code];
    if (admissionError) {
      logger.warn('[ResumableAgentController] Generation admission deferred', {
        code: error.code,
        userId,
        conversationId,
      });
      await maybeDecrement();
      if (!res.headersSent) {
        res.set?.('Retry-After', '1');
        res.status(admissionError.status).json({
          code: error.code,
          error: admissionError.message,
          retryable: true,
        });
      }
      if (client) {
        disposeClient(client);
      }
      return;
    }
    logger.error('[ResumableAgentController] Initialization error:', error);
    if (error?.stack) {
      logger.error('[ResumableAgentController] Initialization stack:', error.stack);
    }
    if (error?.cause) {
      logger.error('[ResumableAgentController] Initialization cause:', error.cause);
      if (error.cause?.stack) {
        logger.error('[ResumableAgentController] Initialization cause stack:', error.cause.stack);
      }
    }
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Failed to start generation' });
    } else {
      // JSON already sent, emit error to stream so client can receive it
      await GenerationJobManager.emitError(streamId, error.message || 'Failed to start generation');
    }
    GenerationJobManager.completeJob(streamId, error.message);
    await maybeDecrement();
    if (client) {
      disposeClient(client);
    }
  }
};

/**
 * Agent Controller - Routes to ResumableAgentController for all requests.
 * The legacy non-resumable path is kept below but no longer used by default.
 */
const AgentController = async (req, res, next, initializeClient, addTitle) => {
  captureQaRunReceipt(req);
  return ResumableAgentController(req, res, next, initializeClient, addTitle);
};

/**
 * Legacy Non-resumable Agent Controller - Uses GenerationJobManager for abort handling.
 * Response is streamed directly to client via res, but abort state is managed centrally.
 * @deprecated Use ResumableAgentController instead
 */
const _LegacyAgentController = async (req, res, next, initializeClient, addTitle) => {
  const {
    text,
    isRegenerate,
    endpointOption,
    conversationId: reqConversationId,
    isContinued = false,
    editedContent = null,
    parentMessageId = null,
    overrideParentMessageId = null,
    responseMessageId: editedResponseMessageId = null,
  } = req.body;

  // Generate conversationId upfront if not provided.
  // Treat "new" as a placeholder that needs a real UUID (frontend may send "new" for new convos)
  const conversationId = resolveCanonicalConversationId(req, req.user.id, reqConversationId);
  /* === VIVENTIUM NOTE ===
   * Feature: Allow caller-supplied streamId to avoid stream collisions (Telegram).
   * === VIVENTIUM NOTE END === */
  const { streamId } = await resolveRequestStreamId(req, req.user.id, conversationId);
  req._resumableStreamId = streamId;
  const interactionContext = captureRequestInteractionContext(req, { conversationId, streamId });

  let userMessage;
  let userMessageId;
  let responseMessageId;
  let client = null;
  let cleanupHandlers = [];

  // Match the same logic used for conversationId generation above
  const isNewConvo = !reqConversationId || reqConversationId === 'new';
  const userId = req.user.id;

  // Create handler to avoid capturing the entire parent scope
  let getReqData = (data = {}) => {
    for (let key in data) {
      if (key === 'userMessage') {
        userMessage = data[key];
        userMessageId = data[key].messageId;
      } else if (key === 'responseMessageId') {
        responseMessageId = data[key];
      } else if (key === 'promptTokens') {
        // Update job metadata with prompt tokens for abort handling
        GenerationJobManager.updateMetadata(streamId, { promptTokens: data[key] });
      } else if (key === 'sender') {
        GenerationJobManager.updateMetadata(streamId, { sender: data[key] });
      }
      // conversationId is pre-generated, no need to update from callback
    }
  };

  // Create a function to handle final cleanup
  const performCleanup = async () => {
    logger.debug('[AgentController] Performing cleanup');
    if (Array.isArray(cleanupHandlers)) {
      for (const handler of cleanupHandlers) {
        try {
          if (typeof handler === 'function') {
            handler();
          }
        } catch (e) {
          logger.error('[AgentController] Error in cleanup handler', e);
        }
      }
    }

    // Complete the job in GenerationJobManager
    if (streamId) {
      logger.debug('[AgentController] Completing job in GenerationJobManager');
      await GenerationJobManager.completeJob(streamId);
    }

    // Dispose client properly
    if (client) {
      disposeClient(client);
    }

    // Clear all references
    client = null;
    getReqData = null;
    userMessage = null;
    cleanupHandlers = null;

    // Clear request data map
    if (requestDataMap.has(req)) {
      requestDataMap.delete(req);
    }
    logger.debug('[AgentController] Cleanup completed');
  };

  try {
    let prelimAbortController = new AbortController();
    const prelimCloseHandler = createCloseHandler(prelimAbortController);
    res.on('close', prelimCloseHandler);
    const removePrelimHandler = (manual) => {
      try {
        prelimCloseHandler(manual);
        res.removeListener('close', prelimCloseHandler);
      } catch (e) {
        logger.error('[AgentController] Error removing close listener', e);
      }
    };
    cleanupHandlers.push(removePrelimHandler);

    /** @type {{ client: TAgentClient; userMCPAuthMap?: Record<string, Record<string, string>> }} */
    const result = await initializeClient({
      req,
      res,
      endpointOption,
      signal: prelimAbortController.signal,
    });

    if (prelimAbortController.signal?.aborted) {
      prelimAbortController = null;
      throw new Error('Request was aborted before initialization could complete');
    } else {
      prelimAbortController = null;
      removePrelimHandler(true);
      cleanupHandlers.pop();
    }
    client = result.client;

    // Register client with finalization registry if available
    if (clientRegistry) {
      clientRegistry.register(client, { userId }, client);
    }

    // Store request data in WeakMap keyed by req object
    requestDataMap.set(req, { client });

    // Create job in GenerationJobManager for abort handling
    // streamId === conversationId (pre-generated above)
    const job = await GenerationJobManager.createJob(streamId, userId, conversationId, {
      interactionContext,
      adapterCapabilities: getTrustedAdapterCapabilities(req),
      deliveryPolicy: getTrustedDeliveryPolicy(req),
    });
    await removeSupersededPresentations(req, job.supersededPresentations);
    if (job.duplicateOfStreamId) {
      disposeClient(client);
      client = null;
      return res.status(202).json(duplicateGenerationReceipt(req, job, conversationId));
    }
    bindLogicalTurnContext(req, job.metadata?.interactionContext);
    req._viventiumVoiceAbortSignal = job.abortController.signal;

    // Store endpoint metadata for abort handling
    GenerationJobManager.updateMetadata(streamId, {
      endpoint: endpointOption.endpoint,
      iconURL: endpointOption.iconURL,
      model: endpointOption.modelOptions?.model || endpointOption.model_parameters?.model,
      sender: client?.sender,
      ...(voiceTaskIdForRequest(req)
        ? {
            viventiumVoiceTaskId: voiceTaskIdForRequest(req),
            ...(req?.body?.viventiumCallSessionId
              ? { viventiumCallSessionId: req.body.viventiumCallSessionId }
              : {}),
          }
        : {}),
    });

    // Store content parts reference for abort
    if (client?.contentParts) {
      GenerationJobManager.setContentParts(streamId, client.contentParts);
    }

    const closeHandler = createCloseHandler(job.abortController);
    res.on('close', closeHandler);
    cleanupHandlers.push(() => {
      try {
        res.removeListener('close', closeHandler);
      } catch (e) {
        logger.error('[AgentController] Error removing close listener', e);
      }
    });

    /**
     * onStart callback - stores user message and response ID for abort handling
     */
    const onStart = (userMsg, respMsgId, _isNewConvo) => {
      sendEvent(res, { message: userMsg, created: true });
      userMessage = userMsg;
      userMessageId = userMsg.messageId;
      responseMessageId = respMsgId;

      // Store metadata for abort handling (conversationId is pre-generated)
      GenerationJobManager.updateMetadata(streamId, {
        responseMessageId: respMsgId,
        userMessage: {
          messageId: userMsg.messageId,
          parentMessageId: userMsg.parentMessageId,
          conversationId,
          text: userMsg.text,
        },
      });
    };

    const messageOptions = {
      user: userId,
      onStart,
      getReqData,
      isContinued,
      isRegenerate,
      editedContent,
      conversationId,
      parentMessageId,
      abortController: job.abortController,
      overrideParentMessageId,
      isEdited: !!editedContent,
      userMCPAuthMap: result.userMCPAuthMap,
      responseMessageId: editedResponseMessageId,
      progressOptions: {
        res,
      },
    };

    let response = await client.sendMessage(text, messageOptions);

    // Extract what we need and immediately break reference
    const messageId = response.messageId;
    const endpoint = endpointOption.endpoint;
    response.endpoint = endpoint;

    // Store database promise locally
    const databasePromise = response.databasePromise;
    delete response.databasePromise;

    // Resolve database-related data
    const { conversation: convoData = {} } = await databasePromise;
    const conversation = { ...convoData };
    conversation.title =
      conversation && !conversation.title ? null : conversation?.title || 'New Chat';

    // Process files if needed (sanitize to remove large text fields before transmission)
    if (req.body.files && client.options?.attachments) {
      userMessage.files = [];
      const messageFiles = new Set(req.body.files.map((file) => file.file_id));
      for (const attachment of client.options.attachments) {
        if (messageFiles.has(attachment.file_id)) {
          userMessage.files.push(sanitizeFileForTransmit(attachment));
        }
      }
      delete userMessage.image_urls;
    }

    // Only send if not aborted
    if (!job.abortController.signal.aborted && !(await isVoiceTaskOutputSuppressedDurably(req))) {
      // Create a new response object with minimal copies
      const finalResponse = normalizePersistedAssistantResponse(req, response);

      // Save canonical state before publishing the final. External adapters keep this revision
      // provisional until their authenticated presentation acknowledgement arrives.
      const requiresExternalDeliveryAcknowledgement =
        getTrustedDeliveryPolicy(req)?.commit_authority === 'external_adapter';
      /* === VIVENTIUM START ===
       * Feature: Authoritative terminal assistant persistence parity.
       * Purpose: A previously saved id may still represent a provisional/checkpoint row. The
       * controller always upserts its final commit-authority state before publishing FINAL.
       */
      {
        /* === VIVENTIUM NOTE ===
         * Feature: Strip voice control tags from persisted response text (non-resumable path).
         */
        const persistedFinalResponse = normalizePersistedAssistantResponse(req, {
          ...finalResponse,
          user: userId,
          unfinished: requiresExternalDeliveryAcknowledgement,
        });
        /* === VIVENTIUM NOTE END === */
        await timedSaveMessage(
          req,
          persistedFinalResponse,
          { context: 'api/server/controllers/agents/request.js - response end' },
          'db_save_response',
        );
      }
      /* === VIVENTIUM END === */

      sendEvent(res, {
        final: true,
        conversation,
        title: conversation.title,
        requestMessage: sanitizeMessageForTransmit(userMessage),
        responseMessage: finalResponse,
      });
      res.end();
      if (!requiresExternalDeliveryAcknowledgement) {
        await GenerationJobManager.acknowledgeStreamDelivery(streamId, {
          state: 'committed',
          presentation_ref: response?.messageId,
        });
      }
    }
    // Edge case: sendMessage completed but abort happened during sendCompletion
    // We need to ensure a final event is sent
    else if (
      !res.headersSent &&
      !res.finished &&
      !(await isVoiceTaskOutputSuppressedDurably(req))
    ) {
      logger.debug(
        '[AgentController] Handling edge case: `sendMessage` completed but aborted during `sendCompletion`',
      );

      const finalResponse = { ...response };
      finalResponse.error = true;

      sendEvent(res, {
        final: true,
        conversation,
        title: conversation.title,
        requestMessage: sanitizeMessageForTransmit(userMessage),
        responseMessage: finalResponse,
        error: { message: 'Request was aborted during completion' },
      });
      res.end();
    }

    // Save user message if needed
    if (!client.skipSaveUserMessage) {
      await timedSaveMessage(
        req,
        userMessage,
        { context: "api/server/controllers/agents/request.js - don't skip saving user message" },
        'db_save_user',
      );
    }

    // Add title if needed - extract minimal data
    if (
      addTitle &&
      parentMessageId === Constants.NO_PARENT &&
      isNewConvo &&
      !(await isVoiceTaskOutputSuppressedDurably(req))
    ) {
      addTitle(req, {
        text,
        response: { ...response },
        client,
      })
        .then(() => {
          logger.debug('[AgentController] Title generation started');
        })
        .catch((err) => {
          logger.error('[AgentController] Error in title generation', err);
        })
        .finally(() => {
          logger.debug('[AgentController] Title generation completed');
          performCleanup();
        });
    } else {
      performCleanup();
    }
  } catch (error) {
    // Handle error without capturing much scope
    handleAbortError(res, req, error, {
      conversationId,
      sender: client?.sender,
      messageId: responseMessageId,
      parentMessageId: overrideParentMessageId ?? userMessageId ?? parentMessageId,
      userMessageId,
    })
      .catch((err) => {
        logger.error('[api/server/controllers/agents/request] Error in `handleAbortError`', err);
      })
      .finally(() => {
        performCleanup();
      });
  }
};

module.exports = AgentController;
module.exports.ResumableAgentController = ResumableAgentController;
module.exports.__testables = {
  extractTextFromContentParts,
  sanitizePersistedAssistantContent,
  sanitizePersistedAssistantText,
  normalizePersistedAssistantResponse,
  persistAssistantSnapshot,
  timedSaveMessage,
  isVoiceTaskOutputSuppressed: isVoiceTaskOutputSuppressedDurably,
  removeSuppressedAssistantMessage,
  normalizeQaRunReceipt,
  captureQaRunReceipt,
  attachQaRunReceipt,
  captureRequestInteractionContext,
  duplicateGenerationReceipt,
  resolveCanonicalConversationId,
  resolveRequestStreamId,
};

/* === VIVENTIUM END === */
