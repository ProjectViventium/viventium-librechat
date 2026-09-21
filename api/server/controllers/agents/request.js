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
  isAcceptedMainProjectionComplete,
  DURABLE_WORK_ACCEPTED_TEXT,
  DURABLE_WORK_ACTION_ACCEPTED_TEXT,
  decrementPendingRequest,
  sanitizeFileForTransmit,
  sanitizeMessageForTransmit,
  checkAndIncrementPendingRequest,
} = require('@librechat/api');
const { disposeClient, clientRegistry, requestDataMap } = require('~/server/cleanup');
const { handleAbortError } = require('~/server/middleware');
const { logViolation } = require('~/cache');
const { getFiles, saveMessage } = require('~/models');
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
const {
  initializeTextTurnTiming,
  markTextTurnBoundary,
} = require('~/server/services/viventium/textTurnTiming');
const { getCortexFollowupGraceMs } = require('~/server/services/viventium/cortexFollowupGrace');
const { memoryReceiptFromAttachments } = require('~/server/services/viventium/memoryReceipt');
const { attachVoiceMessageMetadata } = require('~/server/services/viventium/voiceMessageMetadata');
/* === VIVENTIUM NOTE END === */

function recordPassiveTextTurnBoundary(req, stage, options) {
  try {
    return markTextTurnBoundary(req, stage, options);
  } catch {
    return null;
  }
}

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
  settleVoiceTaskGeneration,
} = require('~/server/services/viventium/VoiceTaskService');
const {
  recordVoiceOrchestrationTraceBestEffort,
} = require('~/server/services/viventium/VoiceOrchestrationTraceService');
const {
  attachMainContextSnapshotMetadata,
} = require('~/server/services/viventium/ViventiumMainContextService');
const {
  commitAcceptedMainTurnFromPresentation,
} = require('~/server/services/viventium/ViventiumMainContinuityService');
const {
  acquireInteractiveMainAdmissionFence,
  ensureAcceptedMainCompaction,
  yieldAcceptedMainCompaction,
} = require('~/server/services/viventium/ViventiumMainCompactionService');
const {
  attachEffectiveDeliveryDisposition,
} = require('~/server/services/viventium/deliveryDisposition');
const {
  isVoiceActorSideEffectRestricted,
} = require('~/server/services/viventium/VoiceActorAuthorityService');
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

const acceptedMainCompactionScheduledRequests = new WeakSet();

function scheduleAcceptedMainCompaction(req, client, commitResult) {
  if (!['committed', 'already_committed'].includes(String(commitResult?.status || ''))) {
    return false;
  }
  if (!req || acceptedMainCompactionScheduledRequests.has(req)) return false;
  if (isVoiceActorSideEffectRestricted(req)) return false;
  const identity = req._viventiumAcceptedMainCompactionIdentityV1;
  const agent = client?.options?.agent;
  if (!identity?.ownerId || !identity?.agentId || !identity?.stableAuthoritySha256 || !agent) {
    return false;
  }
  acceptedMainCompactionScheduledRequests.add(req);
  try {
    void Promise.resolve(
      ensureAcceptedMainCompaction({
        trigger: 'accepted_turn',
        ownerId: identity.ownerId,
        agentId: identity.agentId,
        stableAuthoritySha256: identity.stableAuthoritySha256,
        req,
        agent,
      }),
    ).catch((error) => {
      logger.warn('[VIVENTIUM][main-continuity] Background semantic compaction unavailable', {
        errorClass: String(error?.name || 'PersistenceError').slice(0, 80),
      });
    });
  } catch (error) {
    logger.warn('[VIVENTIUM][main-continuity] Semantic compaction could not be scheduled', {
      errorClass: String(error?.name || 'PersistenceError').slice(0, 80),
    });
  }
  return true;
}

async function commitAcceptedMainTurnAndScheduleCompaction({ presentation, req, client }) {
  try {
    const result = await commitAcceptedMainTurnFromPresentation(presentation);
    scheduleAcceptedMainCompaction(req, client, result);
    return result;
  } catch (error) {
    logger.error('[VIVENTIUM][main-continuity] Accepted turn commit failed', {
      errorClass: String(error?.name || 'PersistenceError').slice(0, 80),
    });
    return null;
  }
}

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

const acceptedInteractionInputs = new WeakMap();

function acceptedInteractionSourceId(req) {
  const context = getTrustedInteractionContext(req);
  return (
    req.body?.overrideUserMessageId?.split(Constants.COMMON_DIVIDER)[0] ||
    req.body?.overrideParentMessageId ||
    stableScopedUuid([
      'viventium:accepted-user-input:v1',
      String(req.user.id),
      context.source_event_id,
    ])
  );
}

async function retainAcceptedInteractionInput(req, { conversationId, text, parentMessageId } = {}) {
  let context = getTrustedInteractionContext(req);
  if (
    !context ||
    context.logical_turn_id ||
    context.actor_kind !== 'external_user' ||
    context.origin !== 'interactive' ||
    req.body?.isRegenerate ||
    req.body?.isContinued ||
    req.body?.editedContent
  )
    return context;
  const existing = acceptedInteractionInputs.get(req);
  if (existing) return existing.context;
  if (context.ready_input_continuation) return context;
  if (!conversationId || conversationId === 'new') return context;
  context = bindCanonicalInteractionConversation(req, conversationId);
  const originalText = typeof text === 'string' ? text : req.body?.text;
  if (typeof originalText !== 'string') return context;
  const messageId = acceptedInteractionSourceId(req);
  const source = { messageId, parentMessageId: parentMessageId || Constants.NO_PARENT };
  context = bindInteractionSourceSegments(req, originalText, [], source);
  await GenerationJobManager.retainLogicalTurnInput(req.user.id, context);
  acceptedInteractionInputs.set(req, { context, source, originalText, persisted: false });
  return context;
}

async function captureAcceptedInteractionInput(
  req,
  { conversationId, streamId, text, parentMessageId } = {},
) {
  conversationId = resolveCanonicalConversationId(req, req.user.id, conversationId);
  await retainAcceptedInteractionInput(req, { conversationId, text, parentMessageId });
  const accepted = acceptedInteractionInputs.get(req);
  if (!accepted || accepted.persisted) return getTrustedInteractionContext(req);
  let context = bindCanonicalInteractionConversation(req, conversationId);
  accepted.source.parentMessageId = parentMessageId || Constants.NO_PARENT;
  context = bindInteractionSourceSegments(req, accepted.originalText, [], accepted.source);
  await GenerationJobManager.retainLogicalTurnInput(req.user.id, context);
  if (
    !(await Message.exists({
      user: req.user.id,
      conversationId,
      messageId: accepted.source.messageId,
      isCreatedByUser: true,
    }))
  ) {
    await timedSaveMessage(
      req,
      {
        messageId: accepted.source.messageId,
        parentMessageId: accepted.source.parentMessageId,
        conversationId,
        text: accepted.originalText,
        sender: 'User',
        isCreatedByUser: true,
      },
      { context: 'accepted user source before initialization' },
      'db_save_user',
    );
  }
  accepted.context = context;
  accepted.persisted = true;
  return context;
}

async function captureRequestInteractionContext(req, { conversationId, streamId } = {}) {
  const existing = getTrustedInteractionContext(req);
  const body = req?.body && typeof req.body === 'object' ? req.body : {};
  // Preserve only owner-scoped file references in the logical-turn ledger. Telegram images live
  // on the private mission-attachment slot; ordinary uploads live on body.files. The normalizer
  // strips paths/content and de-duplicates them before Redis/InMemory persistence.
  const adapterSourceFiles = [
    ...(Array.isArray(req?._viventiumMissionAttachments) ? req._viventiumMissionAttachments : []),
    ...(Array.isArray(body.files) ? body.files : []),
  ];
  if (
    existing?.logical_turn_id ||
    existing?.ready_input_continuation ||
    req._viventiumTelegramInput
  ) {
    bindCanonicalInteractionConversation(req, conversationId);
    return bindInteractionSourceSegments(req, body.text, adapterSourceFiles);
  }
  const sourceEventId =
    body.messageId || body.userMessageId || body.source_event_id || body.sourceEventId || streamId;
  delete body.interactionContext;
  delete body.viventiumInteractionContext;
  if (!existing) {
    setTrustedInteractionContext(
      req,
      createWebInteractionContext({
        conversation_id: conversationId,
        source_event_id: sourceEventId,
      }),
    );
  }
  await captureAcceptedInteractionInput(req, {
    conversationId,
    streamId,
    text: body.text,
    parentMessageId: body.parentMessageId,
  });
  const fileIds = Array.from(
    new Set(
      (Array.isArray(body.files) ? body.files : [])
        .map((file) => file?.file_id)
        .filter((fileId) => typeof fileId === 'string' && fileId.length > 0),
    ),
  ).slice(0, 32);
  const ownedFiles = fileIds.length
    ? await getFiles({ user: req.user.id, file_id: { $in: fileIds } }, undefined, {
        file_id: 1,
        filename: 1,
        type: 1,
        bytes: 1,
        media_group_index: 1,
      })
    : [];
  const filesById = new Map(ownedFiles.map((file) => [file.file_id, file]));
  const acceptedSource = acceptedInteractionInputs.get(req)?.source;
  if (acceptedSource) acceptedSource.persisted = true;
  const context = bindInteractionSourceSegments(
    req,
    body.text,
    fileIds.map((fileId) => filesById.get(fileId)).filter(Boolean),
    acceptedSource,
  );
  await GenerationJobManager.retainLogicalTurnInput(req.user.id, context);
  return context;
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
  const sourceEventId = trustedContext?.source_conversation_generation
    ? [
        'conversation-generation',
        trustedContext.source_order_scope,
        trustedContext.source_conversation_generation,
      ].join(':')
    : requestSourceEventId(req);
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
  if (
    requested &&
    requested !== 'new' &&
    (getTrustedInteractionContext(req) || req?.viventiumCallSession?.callSessionId)
  ) {
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

async function resolveDeliveryDispositionRequirement(req, endpointOption) {
  if (
    req?._viventiumTelegram !== true ||
    req?.body?.telegramAudioRequested !== true ||
    !endpointOption?.agent
  ) {
    return false;
  }
  const agent = await endpointOption.agent;
  const provider = String(agent?.endpoint || agent?.provider || '').trim();
  const capability = req?.config?.endpoints?.agents?.providerCapabilities?.[provider];
  return (
    capability?.messaging_delivery_disposition === true &&
    capability?.messaging_delivery_disposition_version === 1
  );
}

function voiceTaskIdForRequest(req) {
  const taskId = req?.body?.viventiumVoiceTaskId;
  return typeof taskId === 'string' && taskId.trim() ? taskId.trim() : '';
}

async function settleVoiceGenerationForRequest(req, outcome) {
  const taskId = voiceTaskIdForRequest(req);
  const callSessionId = req?.viventiumCallSession?.callSessionId;
  if (!taskId || !callSessionId) return;
  await settleVoiceTaskGeneration(
    taskId,
    { userId: req.user?.id, callSessionId, streamId: req._resumableStreamId },
    outcome,
  );
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

/* === VIVENTIUM START ===
 * Feature: Exact durable-effect presentation authority after response-only supersession.
 * Purpose: A newer interactive turn suppresses stale prose, but it must not erase the exact
 *          acknowledgement for work the older turn already committed. Only the server-authored
 *          GenerationJob receipt can grant this exception; model text and request fields cannot.
 */
function getExactDurableEffectReceipt(job, req, messageId, { requireSuperseded = true } = {}) {
  const trustedContext = getTrustedInteractionContext(req);
  const normalizedMessageId = String(messageId || '').trim();
  const jobContract = job?.metadata ?? job ?? {};
  const receipt = job?.durableEffectReceipt ?? jobContract.durableEffectReceipt;
  const checks = [
    ['message_missing', Boolean(normalizedMessageId)],
    ['status_mismatch', !requireSuperseded || job?.status === 'superseded'],
    [
      'supersede_scope_mismatch',
      jobContract.adapterCapabilities?.supersede_scope === 'response_only',
    ],
    [
      'delivery_policy_mismatch',
      jobContract.deliveryPolicy?.commit_authority === 'external_adapter',
    ],
    [
      'effect_kind_mismatch',
      ['durable_work_accepted', 'durable_work_action_accepted'].includes(receipt?.effect_kind),
    ],
    ['effect_ref_missing', Boolean(String(receipt?.effect_ref || '').trim())],
    [
      'commit_time_invalid',
      Number.isFinite(Number(receipt?.committed_at)) && Number(receipt?.committed_at) > 0,
    ],
    ['job_response_mismatch', jobContract.responseMessageId === normalizedMessageId],
    ['receipt_response_mismatch', receipt?.response_message_id === normalizedMessageId],
    [
      'job_source_mismatch',
      jobContract.interactionContext?.source_event_id === trustedContext?.source_event_id,
    ],
    ['receipt_source_mismatch', receipt?.source_event_id === trustedContext?.source_event_id],
  ];
  const rejected = checks.find(([, accepted]) => !accepted);
  if (rejected && job?.status === 'superseded' && receipt?.effect_kind) {
    logger.warn('[ResumableAgentController] Durable effect receipt presentation rejected', {
      reason: rejected[0],
    });
  }
  return rejected ? null : receipt;
}

function hasExactDurableEffectReceipt(job, req, messageId) {
  return Boolean(getExactDurableEffectReceipt(job, req, messageId));
}

async function isSupersededRequest(req, message) {
  const streamId = req?._resumableStreamId;
  if (!streamId || !getTrustedInteractionContext(req)?.logical_turn_id) return false;
  const job = await GenerationJobManager.getJob(streamId);
  return (
    job?.status === 'superseded' && !hasExactDurableEffectReceipt(job, req, message?.messageId)
  );
}
/* === VIVENTIUM END === */

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
  if (removed && interactionContext?.surface === 'web' && interactionContext?.logical_turn_id) {
    try {
      const store = GenerationJobManager.getJobStore();
      const owner = await store.resolveDeliveryOwner(
        interactionContext.logical_turn_id,
        interactionContext.revision,
      );
      const job = owner ? await store.getJob(owner) : null;
      if (
        job?.nativeResponse &&
        job.interactionContext?.logical_turn_id === interactionContext.logical_turn_id &&
        job.interactionContext?.revision === interactionContext.revision &&
        job.status === 'superseded' &&
        job.userId === req?.user?.id &&
        job.conversationId === message.conversationId &&
        job.responseMessageId === message.messageId
      ) {
        await GenerationJobManager.acknowledgeStreamDelivery(
          owner,
          { state: 'partial_removed', presentation_ref: message.messageId },
          job.nativeResponse,
        );
      }
    } catch (error) {
      logger.warn('[removeSupersededAssistantMessage] Removal receipt unavailable', error);
    }
  }
  return Boolean(removed);
}

async function linkAcceptedInteractionSources(req, context) {
  if (context?.ready_input_continuation) return;
  const seen = new Set();
  let previous;
  for (const segment of context?.source_segments || []) {
    const messageId = segment.source_message_id;
    if (!messageId || seen.has(messageId)) continue;
    seen.add(messageId);
    if (previous && previous !== messageId && segment.source_parent_message_id !== previous) {
      const filter = {
        user: req.user.id,
        conversationId: context.conversation_id,
        messageId,
        isCreatedByUser: true,
        parentMessageId: segment.source_parent_message_id,
        'metadata.viventium.interactionContext.source_event_id': segment.source_event_id,
      };
      await require('~/server/services/viventium/nativeResponseService').mutateNativeResponseSources(
        filter,
        () => Message.updateOne(filter, { $set: { parentMessageId: previous } }),
      );
    }
    if (segment.source_event_id === context.source_event_id && previous)
      req.body.parentMessageId = previous;
    previous = messageId;
  }
}

async function removeSupersededPresentations(req, presentations) {
  const current = getTrustedInteractionContext(req);
  for (const presentation of presentations || []) {
    if (!presentation?.responseMessageId) continue;
    if (
      presentation.userMessageId &&
      presentation.responseMessageId === req.body.parentMessageId &&
      presentation.conversationId === req.body.conversationId &&
      current?.logical_turn_id &&
      presentation.interactionContext?.logical_turn_id === current.logical_turn_id &&
      presentation.interactionContext.revision < current.revision
    ) {
      req.body.parentMessageId = presentation.userMessageId;
    }
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
  if (message?.isCreatedByUser !== true && (await isSupersededRequest(req, message))) {
    await removeSupersededAssistantMessage(req, message);
    return { suppressed: true, reason: 'superseded' };
  }
  const messageToSave = attachInteractionContextMetadata(
    req,
    attachMainContextSnapshotMetadata(
      req,
      attachQaRunReceipt(req, attachVoiceMessageMetadata(req, message)),
    ),
  );
  const t = isDeepTimingEnabled(req) ? startDeepTiming(req) : null;
  const result = await saveMessage(req, messageToSave, { ...options, operationKind: 'system' });
  if (message?.isCreatedByUser !== true && (await isSupersededRequest(req, messageToSave))) {
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

const {
  projectVisibleTextFromContentParts,
} = require('~/server/services/viventium/ViventiumVisibleContentProjection');

function extractTextFromContentParts(contentParts = []) {
  return projectVisibleTextFromContentParts(contentParts, { trim: true });
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

function normalizeAssistantResponseForTransmit(req, response) {
  if (req?._viventiumNativeResponseCompleted === true) return response;
  const isTelegramText =
    req?._viventiumTelegram === true &&
    String(req?.body?.viventiumSurface || '').toLowerCase() === 'telegram' &&
    req?.body?.voiceMode !== true;
  if (!isTelegramText) {
    return normalizePersistedAssistantResponse(req, response);
  }
  response = attachEffectiveDeliveryDisposition(req, response);
  const currentText = typeof response?.text === 'string' ? response.text : '';
  const contentText = extractTextFromContentParts(response?.content);
  if (!currentText && contentText) {
    return { ...response, text: contentText };
  }
  return response;
}

/* === VIVENTIUM START ===
 * Feature: Canonical durable-work receipt prose.
 * Purpose: Once Main has committed background work, retain its structured tool audit but replace
 *          any later inline answer with the same short server-authored handoff already presented
 *          at the durable commit boundary.
 */
function normalizeDurableWorkReceiptResponse(response, receipt) {
  const retainedContent = Array.isArray(response?.content)
    ? response.content.filter((part) => part?.type !== 'text')
    : [];
  const receiptText =
    receipt?.effect_kind === 'durable_work_action_accepted'
      ? DURABLE_WORK_ACTION_ACCEPTED_TEXT
      : DURABLE_WORK_ACCEPTED_TEXT;
  return {
    ...response,
    text: receiptText,
    content: [{ type: 'text', text: { value: receiptText } }, ...retainedContent],
  };
}

function hasCommittedExternalDelivery(job) {
  return ['committed', 'committed_effect'].includes(
    (job?.metadata ?? job)?.deliveryAcknowledgement?.state,
  );
}

function withCommittedDeliveryAudit(response, job) {
  if (!hasCommittedExternalDelivery(job)) return response;
  const acknowledgement = (job?.metadata ?? job)?.deliveryAcknowledgement;
  return {
    ...response,
    metadata: {
      ...response?.metadata,
      viventium: {
        ...response?.metadata?.viventium,
        deliveryAcknowledgement: acknowledgement,
      },
    },
  };
}
/* === VIVENTIUM END === */
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
  mainContextBinding,
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
    { context, ...(mainContextBinding ? { mainContextBinding } : {}) },
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

/* === VIVENTIUM START ===
 * Feature: Exact optimistic-to-authoritative resume identity.
 * Purpose: Persist the UI placeholder IDs admitted with this request. Interaction provenance is
 *          not a client presentation identity and must never be used to delete client history.
 */
function boundedPresentationId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 256 ? normalized : null;
}

function captureClientPresentation(req, { isRegenerate, overrideParentMessageId }) {
  const userMessageId = boundedPresentationId(req?.body?.messageId);
  const responseMessageId = boundedPresentationId(req?.body?.viventiumClientResponseMessageId);
  const targetUserMessageId = boundedPresentationId(
    isRegenerate ? overrideParentMessageId || req?.body?.messageId : req?.body?.messageId,
  );
  if (!userMessageId || !responseMessageId || !targetUserMessageId) {
    return undefined;
  }
  return {
    mode: isRegenerate ? 'regenerate' : 'append',
    userMessageId,
    responseMessageId,
    targetUserMessageId,
  };
}
/* === VIVENTIUM END === */

/**
 * Resumable Agent Controller - Generation runs independently of HTTP connection.
 * Returns streamId immediately, client subscribes separately via SSE.
 */
const ResumableAgentController = async (req, res, next, initializeClient, addTitle) => {
  let {
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
  recordPassiveTextTurnBoundary(req, 'concurrency_admitted');
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
  let interactionContext;
  try {
    interactionContext = await captureRequestInteractionContext(req, { conversationId, streamId });
  } catch (error) {
    await maybeDecrement();
    if (error?.code === 'source_input_capacity')
      return res
        .status(503)
        .json({ code: error.code, retryable: true, error: error.message, conversationId });
    throw error;
  }
  let releaseInteractiveAdmissionFence = null;
  const completeInteractiveMainAdmission = () => {
    const release = releaseInteractiveAdmissionFence;
    releaseInteractiveAdmissionFence = null;
    release?.();
  };
  if (
    interactionContext?.actor_kind === 'external_user' &&
    interactionContext?.origin === 'interactive'
  ) {
    releaseInteractiveAdmissionFence = acquireInteractiveMainAdmissionFence(userId);
    try {
      await yieldAcceptedMainCompaction(userId);
    } catch (error) {
      completeInteractiveMainAdmission();
      await maybeDecrement();
      throw error;
    }
  }
  /* === VIVENTIUM NOTE END === */
  const voiceLatencyEnabled = isVoiceLatencyEnabled(req);
  req._viventiumDeliveryDispositionRequired = await resolveDeliveryDispositionRequirement(
    req,
    endpointOption,
  );

  let client = null;

  try {
    logger.debug(`[ResumableAgentController] Creating job`, {
      streamId,
      conversationId,
      reqConversationId,
      userId,
    });

    const voiceJobCreateStart = voiceLatencyEnabled ? voiceLatencyNow() : 0;
    const clientPresentation = captureClientPresentation(req, {
      isRegenerate,
      overrideParentMessageId,
    });
    const job = await GenerationJobManager.createJob(streamId, userId, conversationId, {
      interactionContext,
      adapterCapabilities: getTrustedAdapterCapabilities(req),
      deliveryPolicy: getTrustedDeliveryPolicy(req),
      ...(clientPresentation ? { clientPresentation } : {}),
    });
    if (job.duplicateOfStreamId) {
      completeInteractiveMainAdmission();
      await maybeDecrement();
      const duplicateReceipt = duplicateGenerationReceipt(req, job, conversationId);
      await req._viventiumBeforeGenerationReceipt?.(duplicateReceipt);
      return res.status(202).json({
        ...duplicateReceipt,
        ...(req._viventiumDeliveryDispositionRequired === true
          ? { deliveryDispositionRequired: true }
          : {}),
      });
    }
    const claimedInteractionContext = bindLogicalTurnContext(req, job.metadata?.interactionContext);
    await removeSupersededPresentations(req, job.supersededPresentations);
    await linkAcceptedInteractionSources(req, claimedInteractionContext);
    parentMessageId = req.body.parentMessageId ?? parentMessageId;
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
        ...(req?.body?.viventiumVoiceEffectAuthority
          ? { viventiumVoiceEffectAuthority: req.body.viventiumVoiceEffectAuthority }
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
    recordPassiveTextTurnBoundary(req, 'client_initialization_start');
    const result = await initializeClient({
      req,
      res,
      endpointOption,
      // Use the job's abort controller signal - allows abort via GenerationJobManager.abortJob()
      signal: job.abortController.signal,
    });
    recordPassiveTextTurnBoundary(req, 'client_initialization_end');
    if (isDeepTimingEnabled(req)) {
      logDeepTiming(req, 'initialize_client', initStart);
    }
    if (voiceLatencyEnabled) {
      logVoiceLatencyStage(req, 'initialize_client_done', voiceInitStart, `stream_id=${streamId}`);
    }

    if (job.abortController.signal.aborted) {
      completeInteractiveMainAdmission();
      await settleVoiceGenerationForRequest(req, {
        error: { code: 'generation_aborted', message: 'Request aborted during initialization' },
      });
      GenerationJobManager.completeJob(streamId, 'Request aborted during initialization');
      await maybeDecrement();
      return;
    }

    client = result.client;
    client.skipSaveResponseMessage = true;
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
                  ...(req._viventiumAcceptedMainCompactionIdentityV1
                    ? {
                        mainContextBinding: {
                          responseMessageId: respMsgId,
                          identity: req._viventiumAcceptedMainCompactionIdentityV1,
                        },
                      }
                    : {}),
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

            const nativeCapability =
              req.config?.endpoints?.agents?.providerCapabilities?.[
                client.options?.agent?.endpoint || client.options?.agent?.provider
              ];
            if (
              nativeCapability?.conversation_session === true &&
              nativeCapability?.workspace_binding === true
            ) {
              req._viventiumNativeResponseSource = {
                conversationId,
                responseMessageId: respMsgId,
                proof: await require('~/models').captureNativeResponseSource(
                  userId,
                  conversationId,
                  userMsg.messageId,
                  client.nativeResponseParentSource ?? null,
                ),
              };
            }

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
        recordPassiveTextTurnBoundary(req, 'main_pipeline_start');
        startPartialCheckpointing();
        const response = await client.sendMessage(text, messageOptions);
        completeInteractiveMainAdmission();
        recordPassiveTextTurnBoundary(req, 'main_pipeline_complete');
        if (
          req.body?.voiceMode === true &&
          req.body?.viventiumCallSessionId &&
          claimedInteractionContext?.surface === 'voice' &&
          claimedInteractionContext?.logical_turn_id
        ) {
          await recordVoiceOrchestrationTraceBestEffort({
            ownerId: userId,
            callSessionId: req.body.viventiumCallSessionId,
            turnId: claimedInteractionContext.logical_turn_id,
            eventRef: streamId,
            stage: 'controller.completed',
            facts: {
              streamRef: streamId,
              ...(viventiumVoiceTaskId ? { taskRef: viventiumVoiceTaskId } : {}),
              effectCount: 1,
            },
          });
        }
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

        const preCommitJob = await GenerationJobManager.getJob(streamId);
        const durableWorkReceipt = getExactDurableEffectReceipt(
          preCommitJob,
          req,
          response?.messageId,
        );
        let responseForCommit = durableWorkReceipt
          ? normalizeDurableWorkReceiptResponse(response, durableWorkReceipt)
          : response;

        // CRITICAL: Save response message BEFORE emitting final event.
        // This prevents race conditions where the client sends a follow-up message
        // before the response is saved to the database, causing orphaned parentMessageIds.
        const requiresExternalDeliveryAcknowledgement =
          getTrustedDeliveryPolicy(req)?.commit_authority === 'external_adapter';
        const deliveryWasCommittedBeforePersistence = hasCommittedExternalDelivery(preCommitJob);
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
          const persistedResponse = withCommittedDeliveryAudit(
            normalizePersistedAssistantResponse(req, {
              ...responseForCommit,
              user: userId,
              isCreatedByUser: false,
              unfinished:
                wasAbortedBeforeComplete ||
                (requiresExternalDeliveryAcknowledgement && !deliveryWasCommittedBeforePersistence),
            }),
            preCommitJob,
          );
          /* === VIVENTIUM NOTE END === */
          const assistantPersistence = await timedSaveMessage(
            req,
            persistedResponse,
            { context: 'api/server/controllers/agents/request.js - resumable response end' },
            'db_save_response',
          );
          if (assistantPersistence && !assistantPersistence.suppressed) {
            const memoryWriterAdmission = await client.startDeferredMemoryWriter?.();
            if (memoryWriterAdmission) {
              responseForCommit.memoryWriteStatus = 'pending';
            }
          }
        }
        recordPassiveTextTurnBoundary(req, 'assistant_durable');
        /* === VIVENTIUM END === */

        if (req._viventiumNativeResponseIdentity) {
          let nativeTerminal = false;
          const nativeResponseService = require('~/server/services/viventium/nativeResponseService');
          const saved = await nativeResponseService.recoverSavedNativeResponse(
            req._viventiumNativeResponseIdentity,
            () => {
              nativeTerminal = true;
            },
          );
          if (saved && nativeTerminal) {
            const finished = await nativeResponseService.recoverNativeResponse(
              req._viventiumNativeResponseIdentity,
            );
            if (!finished) throw new Error('native_response_terminal_pending');
            await settleVoiceGenerationForRequest(req, { resultMessageId: saved.messageId });
            stopPartialCheckpointing();
            await maybeDecrement();
            if (client) disposeClient(client);
            return;
          }
          if (saved) {
            Object.assign(response, saved);
            responseForCommit = durableWorkReceipt
              ? normalizeDurableWorkReceiptResponse(response, durableWorkReceipt)
              : response;
            req._viventiumNativeResponseCompleted = true;
          } else {
            const nativeRow = await require('~/models').getNativeResponse(userId, messageId);
            if (nativeRow?.nativeResponse?.status !== 'unsupported') {
              const completionError = Array.isArray(response.content)
                ? response.content.find(
                    (part) =>
                      part?.type === ContentTypes.ERROR &&
                      typeof part.error === 'string' &&
                      part.error,
                  )
                : null;
              if (completionError) {
                throw Object.assign(new Error(completionError.error), {
                  code: completionError.error_class,
                });
              }
              throw new Error('native_response_final_pending');
            }
            await timedSaveMessage(
              req,
              normalizePersistedAssistantResponse(req, {
                ...responseForCommit,
                user: userId,
                unfinished: wasAbortedBeforeComplete || requiresExternalDeliveryAcknowledgement,
              }),
              { context: 'native graph continuation owned by the host' },
              'db_save_response',
            );
          }
        }

        // Check if our job was replaced by a new request before emitting
        // This prevents stale requests from emitting events to newer jobs
        const currentJob = await GenerationJobManager.getJob(streamId);
        if (
          requiresExternalDeliveryAcknowledgement &&
          !wasAbortedBeforeComplete &&
          !deliveryWasCommittedBeforePersistence &&
          hasCommittedExternalDelivery(currentJob)
        ) {
          await timedSaveMessage(
            req,
            withCommittedDeliveryAudit(
              normalizePersistedAssistantResponse(req, {
                ...responseForCommit,
                user: userId,
                isCreatedByUser: false,
                unfinished: false,
              }),
              currentJob,
            ),
            { context: 'api/server/controllers/agents/request.js - delivery ack reconciliation' },
            'db_reconcile_delivery_ack',
          );
        }
        const exactDurableEffectReceipt = getExactDurableEffectReceipt(
          currentJob,
          req,
          response?.messageId,
        );
        const transmittableDurableEffectReceipt = getExactDurableEffectReceipt(
          currentJob,
          req,
          response?.messageId,
          { requireSuperseded: false },
        );
        const jobWasReplaced =
          !currentJob ||
          currentJob.createdAt !== jobCreatedAt ||
          (currentJob.status === 'superseded' && !exactDurableEffectReceipt);

        if (jobWasReplaced) {
          stopPartialCheckpointing();
          logger.debug(`[ResumableAgentController] Skipping FINAL emit - job was replaced`, {
            streamId,
            originalCreatedAt: jobCreatedAt,
            currentCreatedAt: currentJob?.createdAt,
          });
          // Still decrement pending request since we incremented at start
          if (currentJob?.status === 'superseded' && !exactDurableEffectReceipt) {
            await removeSupersededAssistantMessage(req, {
              messageId,
              conversationId,
              isCreatedByUser: false,
            });
            if (
              currentJob.createdAt === jobCreatedAt &&
              (currentJob.metadata ?? currentJob).adapterCapabilities?.supersede_scope ===
                'response_only'
            ) {
              await GenerationJobManager.completeJob(streamId);
            }
          }
          await settleVoiceGenerationForRequest(req, {});
          await maybeDecrement();
          return;
        }

        if (!wasAbortedBeforeComplete && !(await isVoiceTaskOutputSuppressedDurably(req))) {
          if (!client.startDeferredMemoryWriter) {
            await client.admitMemoryWriter?.();
          }
          /* === VIVENTIUM NOTE ===
           * Feature: Log empty responses for Telegram debugging.
           * Added: 2026-02-01
           */
          const hasResponseText = !!(
            responseForCommit?.text ||
            (Array.isArray(responseForCommit?.content) &&
              responseForCommit.content.some(
                (p) => p?.type === 'text' && (p?.text || p?.text?.value),
              ))
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

          const responseMessageForTransmit = normalizeAssistantResponseForTransmit(
            req,
            responseForCommit,
          );
          const admissionReceipt = req._viventiumMemoryAdmissionReceipt;
          if (admissionReceipt) {
            responseMessageForTransmit.attachments = [
              ...(responseMessageForTransmit.attachments || []),
              admissionReceipt,
            ];
          }
          const finalEvent = {
            final: true,
            conversation,
            title: conversation.title,
            requestMessage: sanitizeMessageForTransmit(userMessage),
            responseMessage: responseMessageForTransmit,
            memoryWriterScheduled: req._viventiumMemoryWriterScheduled === true,
            ...(admissionReceipt
              ? { memoryReceipt: memoryReceiptFromAttachments([admissionReceipt]) }
              : {}),
            ...(transmittableDurableEffectReceipt
              ? {
                  durableEffectReceipt: {
                    effect_ref: transmittableDurableEffectReceipt.effect_ref,
                  },
                }
              : {}),
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
          if (req._viventiumNativeResponseCompleted === true) {
            const nativeFinished = await GenerationJobManager.finishNativeResponse(
              req._viventiumNativeResponseIdentity,
              finalEvent,
            );
            if (!nativeFinished) throw new Error('native_response_final_pending');
          } else {
            await GenerationJobManager.markMainResponseComplete(streamId, finalEvent);
            await GenerationJobManager.emitDone(streamId, finalEvent);
          }
          recordPassiveTextTurnBoundary(req, 'final_event_emitted');
          if (
            req.body?.voiceMode === true &&
            req.body?.viventiumCallSessionId &&
            claimedInteractionContext?.surface === 'voice' &&
            claimedInteractionContext?.logical_turn_id &&
            response?.messageId
          ) {
            await recordVoiceOrchestrationTraceBestEffort({
              ownerId: userId,
              callSessionId: req.body.viventiumCallSessionId,
              turnId: claimedInteractionContext.logical_turn_id,
              eventRef: response.messageId,
              stage: 'response.completed',
              facts: {
                streamRef: streamId,
                ...(viventiumVoiceTaskId ? { taskRef: viventiumVoiceTaskId } : {}),
                responseRef: response.messageId,
                effectCount: 1,
              },
            });
          }
          if (getTrustedDeliveryPolicy(req)?.commit_authority === 'server') {
            const acceptedDelivery = await GenerationJobManager.acknowledgeStreamDelivery(
              streamId,
              {
                state: 'committed',
                presentation_ref: response?.messageId,
              },
            );
            if (acceptedDelivery?.status === 'recorded') {
              const presentationCommittedAt =
                acceptedDelivery.acknowledgement?.presentation_committed_at;
              if (Number.isFinite(presentationCommittedAt)) {
                recordPassiveTextTurnBoundary(req, 'presentation_committed', {
                  nowMs: presentationCommittedAt,
                });
              }
              const projected = await commitAcceptedMainTurnAndScheduleCompaction({
                presentation: acceptedDelivery.presentation,
                req,
                client,
              });
              if (
                req._viventiumNativeResponseCompleted === true &&
                !isAcceptedMainProjectionComplete(projected)
              ) {
                throw new Error('native_response_presentation_pending');
              }
            } else if (req._viventiumNativeResponseCompleted === true) {
              throw new Error('native_response_presentation_pending');
            }
          }
          if (req._viventiumNativeResponseCompleted === true) {
            const replayStored =
              await require('~/server/services/viventium/nativeResponseService').markNativeResponseReplayStored(
                req._viventiumNativeResponseIdentity,
              );
            if (!replayStored) throw new Error('native_response_replay_pending');
          }
          await settleVoiceGenerationForRequest(req, { resultMessageId: response.messageId });
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
          await settleVoiceGenerationForRequest(req, {
            error: { code: 'generation_aborted', message: 'Request aborted' },
          });
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
        completeInteractiveMainAdmission();
        stopPartialCheckpointing();
        await settleVoiceGenerationForRequest(req, { error });
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
      completeInteractiveMainAdmission();
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
      await settleVoiceGenerationForRequest(req, { error: err });
      GenerationJobManager.completeJob(streamId, err.message);
      await maybeDecrement();
    });
  } catch (error) {
    completeInteractiveMainAdmission();
    await settleVoiceGenerationForRequest(req, { error });
    if (
      ['source_input_persistence_pending', 'source_input_capacity'].includes(error?.code) &&
      !res.headersSent
    ) {
      await maybeDecrement();
      return res
        .status(503)
        .json({ code: error.code, retryable: true, error: error.message, conversationId });
    }
    if (
      ['source_input_waiting', 'source_order_superseded'].includes(error?.code) &&
      getTrustedInteractionContext(req)?.ready_input_continuation &&
      !res.headersSent
    ) {
      await maybeDecrement();
      const pendingReceipt = { code: 'source_input_pending', pending: true, conversationId };
      await req._viventiumBeforeGenerationReceipt?.(pendingReceipt);
      return res.status(202).json(pendingReceipt);
    }
    if (error?.code === 'source_order_superseded') {
      await maybeDecrement();
      if (!res.headersSent) {
        res.status(202).json({
          code: 'source_order_superseded',
          superseded: true,
          conversationId,
        });
      }
      return;
    }
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
  const timingTurnId = String(
    req?.body?.responseMessageId || req?.body?.viventiumClientResponseMessageId || '',
  ).trim();
  if (timingTurnId) {
    try {
      initializeTextTurnTiming(req, {
        turnId: timingTurnId,
        mainAgentId:
          req?.body?.agent_id ||
          req?.body?.endpointOption?.agent_id ||
          req?.body?.endpointOption?.agent?.id,
        turnStartedAtMs: Date.now(),
      });
      recordPassiveTextTurnBoundary(req, 'controller_admission');
    } catch {
      // Passive timing must never change controller admission.
    }
  }
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
            ...(req?.body?.viventiumVoiceEffectAuthority
              ? { viventiumVoiceEffectAuthority: req.body.viventiumVoiceEffectAuthority }
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
      const finalResponse = normalizeAssistantResponseForTransmit(req, response);

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
        const assistantPersistence = await timedSaveMessage(
          req,
          persistedFinalResponse,
          { context: 'api/server/controllers/agents/request.js - response end' },
          'db_save_response',
        );
        if (assistantPersistence && !assistantPersistence.suppressed) {
          const memoryWriterAdmission = client.startDeferredMemoryWriter?.();
          if (memoryWriterAdmission) {
            finalResponse.memoryWriteStatus = 'pending';
          }
        }
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
        const acceptedDelivery = await GenerationJobManager.acknowledgeStreamDelivery(streamId, {
          state: 'committed',
          presentation_ref: response?.messageId,
        });
        if (acceptedDelivery?.status === 'recorded') {
          await commitAcceptedMainTurnAndScheduleCompaction({
            presentation: acceptedDelivery.presentation,
            req,
            client,
          });
        }
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
module.exports.captureAcceptedInteractionInput = captureAcceptedInteractionInput;
module.exports.retainAcceptedInteractionInput = retainAcceptedInteractionInput;
module.exports.__testables = {
  LegacyAgentController: _LegacyAgentController,
  extractTextFromContentParts,
  sanitizePersistedAssistantContent,
  sanitizePersistedAssistantText,
  normalizePersistedAssistantResponse,
  normalizeAssistantResponseForTransmit,
  normalizeDurableWorkReceiptResponse,
  persistAssistantSnapshot,
  timedSaveMessage,
  getExactDurableEffectReceipt,
  hasExactDurableEffectReceipt,
  isVoiceTaskOutputSuppressed: isVoiceTaskOutputSuppressedDurably,
  removeSuppressedAssistantMessage,
  normalizeQaRunReceipt,
  captureQaRunReceipt,
  attachQaRunReceipt,
  captureRequestInteractionContext,
  captureAcceptedInteractionInput,
  linkAcceptedInteractionSources,
  duplicateGenerationReceipt,
  resolveCanonicalConversationId,
  resolveRequestStreamId,
  resolveDeliveryDispositionRequirement,
};

/* === VIVENTIUM END === */
