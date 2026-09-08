/* === VIVENTIUM START ===
 * Feature: Stale background cortex message recovery.
 *
 * Purpose:
 * - Phase B is intentionally asynchronous and process-local while it runs.
 * - If the API process restarts after activation rows are persisted but before Phase B finalizes,
 *   those rows can otherwise remain "activating"/"brewing" forever.
 * - On startup, repair old active cortex rows to terminal error state and clear unfinished so every
 *   surface has honest DB state instead of a permanent progress indicator.
 * === VIVENTIUM END === */

const { ContentTypes } = require('librechat-data-provider');
const { GenerationJobManager } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const {
  Conversation,
  Message,
  ViventiumCortexInsightDelivery,
  ViventiumTelegramIngressEvent,
} = require('~/db/models');
const { getAppConfig } = require('~/server/services/Config');

const { getDeferredFallbackErrorText } = require('~/server/services/viventium/cortexFallbackText');
const { isRuntimeHoldTextPart } = require('~/server/services/viventium/runtimeHoldText');

const {
  buildCortexInsightDeliveryCandidates,
  cortexInsightDeliveryService,
  recordCompletedCortexInsightDeliveryBatch,
  requireExactCortexInsightDeliveryAcceptance,
  requireExactCortexInsightDeliverySettlement,
  normalizeCortexFeelingSnapshot,
} = require('~/server/services/viventium/CortexInsightDeliveryService');
const {
  replayCompletedCortexInsightOutbox,
} = require('~/server/services/viventium/CortexInsightOutboxService');
/* === VIVENTIUM START === EMO-UC-048 Web recovery fault binding. === */
const {
  consumeLocalQaCortexFault,
} = require('~/server/services/viventium/LocalQaCortexFaultService');
/* === VIVENTIUM END === */

const ACTIVE_CORTEX_STATUSES = new Set(['activating', 'brewing', 'processing', 'running']);
const CORTEX_TYPES = new Set([
  ContentTypes.CORTEX_ACTIVATION,
  ContentTypes.CORTEX_BREWING,
  ContentTypes.CORTEX_INSIGHT,
]);
const DEFAULT_STALE_RECOVERY_TIMEOUT_MS = 240_000;
const DEFAULT_STALE_RECOVERY_GRACE_MS = 60_000;
const DEFAULT_STALE_RECOVERY_INTERVAL_MS = 60_000;
const DEFAULT_PRESENTATION_RECEIPT_WAIT_MS = 5_000;
const DEFAULT_PRESENTATION_RECEIPT_POLL_MS = 100;
const DEFAULT_CORTEX_DELIVERY_MAX_ATTEMPTS = 3;
const RECOVERY_PRESENTATION_SURFACES = new Set(['web', 'telegram']);
const PROCESS_STARTED_AT_MS = Date.now();

function parsePositiveInt(value) {
  const parsed = parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getConfiguredCortexExecutionTimeoutMs() {
  return parsePositiveInt(process.env.VIVENTIUM_CORTEX_EXECUTION_TIMEOUT_MS) || 0;
}

function getStaleCortexRecoveryConfig() {
  const configuredTimeoutMs = parsePositiveInt(process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_MS);
  const cortexExecutionTimeoutMs = getConfiguredCortexExecutionTimeoutMs();
  const graceMs =
    parsePositiveInt(process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_GRACE_MS) ||
    DEFAULT_STALE_RECOVERY_GRACE_MS;
  const minimumTimeoutMs = cortexExecutionTimeoutMs
    ? cortexExecutionTimeoutMs + graceMs
    : DEFAULT_STALE_RECOVERY_TIMEOUT_MS;
  const rawLimit = Number(process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_LIMIT);
  return {
    timeoutMs: Math.max(configuredTimeoutMs || 0, minimumTimeoutMs),
    limit: Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100,
    cortexExecutionTimeoutMs,
    graceMs,
  };
}

function getStaleCortexRecoveryIntervalMs() {
  const parsed = parsePositiveInt(process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_INTERVAL_MS);
  return parsed || DEFAULT_STALE_RECOVERY_INTERVAL_MS;
}

function isActiveCortexPart(part) {
  if (!part || typeof part !== 'object' || !CORTEX_TYPES.has(part.type)) {
    return false;
  }
  const status = String(part.status || '')
    .trim()
    .toLowerCase();
  if (status) {
    return ACTIVE_CORTEX_STATUSES.has(status);
  }
  return part.type !== ContentTypes.CORTEX_INSIGHT;
}

function shouldReplaceHoldText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.some((part) => isRuntimeHoldTextPart(part));
}

function recoverCortexContent(content, nowIso) {
  if (!Array.isArray(content)) {
    return { changed: false, content };
  }

  let changed = false;
  const recovered = content.map((part) => {
    if (!isActiveCortexPart(part)) {
      return part;
    }
    changed = true;
    return {
      ...part,
      status: 'error',
      error: part.error || 'Background processing did not finish before runtime recovery.',
      status_changed_at: nowIso,
      recovered_at: nowIso,
      recovery_reason: 'stale_cortex_startup_recovery',
    };
  });

  return { changed, content: recovered };
}

/* === VIVENTIUM START ===
 * Feature: Recovered follow-up error-card cleanup.
 * Purpose: If Phase B already promoted useful visible text onto an empty primary answer, stale
 * provider error parts must be removed from that same message so the UI does not show both
 * recovery text and a fatal "Something went wrong" card.
 * === VIVENTIUM END === */
function stripErrorPartsFromRecoveredFollowUpContent(content) {
  if (!Array.isArray(content)) {
    return { changed: false, content, errorClasses: [] };
  }

  const errorClasses = [];
  const nextContent = [];
  let changed = false;
  for (const part of content) {
    if (part?.type === ContentTypes.ERROR) {
      changed = true;
      errorClasses.push(
        String(part.error_class || part.errorClass || part.code || 'completion_error'),
      );
      continue;
    }
    nextContent.push(part);
  }

  return { changed, content: nextContent, errorClasses };
}

/* === VIVENTIUM START ===
 * Feature: Deferred tool-cortex hold error cleanup.
 * Purpose: A deterministic runtime hold plus a later cortex follow-up is a successful async handoff,
 * not a failed provider response. If an older runtime persisted a generic completion error onto
 * that parent message, remove only that stale parent error after the follow-up exists.
 * === VIVENTIUM END === */
function stripDeferredHoldParentErrorParts(content) {
  if (!Array.isArray(content)) {
    return { changed: false, content, errorClasses: [] };
  }

  const hasRuntimeHold = content.some((part) => isRuntimeHoldTextPart(part));
  const hasCortexPart = content.some(
    (part) => part && typeof part === 'object' && CORTEX_TYPES.has(part.type),
  );
  if (!hasRuntimeHold || !hasCortexPart) {
    return { changed: false, content, errorClasses: [] };
  }

  let changed = false;
  const errorClasses = [];
  const nextContent = [];
  for (const part of content) {
    const errorClass = String(part?.error_class || part?.errorClass || part?.code || '').trim();
    const isStaleDeferredHoldError =
      part?.type === ContentTypes.ERROR &&
      (errorClass === 'completion_error' || errorClass === 'late_stream_termination');
    if (isStaleDeferredHoldError) {
      changed = true;
      errorClasses.push(errorClass);
      continue;
    }
    nextContent.push(part);
  }

  return { changed, content: nextContent, errorClasses };
}

async function recoverVisibleFollowUpErrorCards({ limit = 100 } = {}) {
  const messages = await Message.find({
    'nativeResponse.status': { $nin: ['pending', 'prepared'] },
    isCreatedByUser: false,
    text: { $type: 'string', $ne: '' },
    'metadata.viventium.type': 'cortex_followup',
    'metadata.viventium.promotedToEmptyParent': true,
    $or: [
      { 'content.type': ContentTypes.ERROR },
      { error: true, 'metadata.viventium.recoveredPrimaryErrorClasses.0': { $exists: true } },
    ],
  })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();

  let repaired = 0;
  for (const message of messages) {
    const cleanup = stripErrorPartsFromRecoveredFollowUpContent(message.content);
    const existingViventium = message?.metadata?.viventium || {};
    const existingClasses = Array.isArray(existingViventium.recoveredPrimaryErrorClasses)
      ? existingViventium.recoveredPrimaryErrorClasses
      : [];
    // Promotion may already have removed the error part while leaving its message flag behind.
    const hasRecoveredErrorFlag = message.error === true && existingClasses.length > 0;
    if (!cleanup.changed && !hasRecoveredErrorFlag) {
      continue;
    }

    const recoveredPrimaryErrorClasses = Array.from(
      new Set([...existingClasses, ...cleanup.errorClasses].filter(Boolean)),
    );

    const metadata = {
      ...(message.metadata || {}),
      viventium: {
        ...existingViventium,
        recoveredPrimaryErrorClasses,
      },
    };

    const result = await Message.updateOne(
      { _id: message._id, updatedAt: message.updatedAt },
      {
        $set: {
          content: cleanup.content,
          metadata,
          unfinished: false,
          error: false,
        },
      },
    );
    if (result?.modifiedCount > 0) {
      repaired += 1;
    }
  }

  if (repaired > 0) {
    logger.warn(
      `[staleCortexMessageRecovery] Removed stale visible error cards from ${repaired} recovered follow-up message(s)`,
    );
  }

  return { scanned: messages.length, repaired };
}

async function recoverDeferredHoldParentErrorCards({ limit = 100 } = {}) {
  const parents = await Message.find({
    'nativeResponse.status': { $nin: ['pending', 'prepared'] },
    isCreatedByUser: false,
    'content.viventium_runtime_hold': true,
    'content.type': ContentTypes.ERROR,
  })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();

  let repaired = 0;
  for (const parent of parents) {
    const cleanup = stripDeferredHoldParentErrorParts(parent.content);
    if (!cleanup.changed || !parent?.messageId) {
      continue;
    }

    const followUp = await Message.findOne(
      {
        isCreatedByUser: false,
        text: { $type: 'string', $ne: '' },
        error: { $ne: true },
        'metadata.viventium.type': 'cortex_followup',
        'metadata.viventium.parentMessageId': parent.messageId,
      },
      { _id: 1 },
    ).lean();
    if (!followUp) {
      continue;
    }

    const existingViventium = parent?.metadata?.viventium || {};
    const existingClasses = Array.isArray(existingViventium.recoveredDeferredHoldErrorClasses)
      ? existingViventium.recoveredDeferredHoldErrorClasses
      : [];
    const recoveredDeferredHoldErrorClasses = Array.from(
      new Set([...existingClasses, ...cleanup.errorClasses].filter(Boolean)),
    );
    const metadata = {
      ...(parent.metadata || {}),
      viventium: {
        ...existingViventium,
        recoveredDeferredHoldErrorClasses,
      },
    };

    const result = await Message.updateOne(
      { _id: parent._id, updatedAt: parent.updatedAt },
      {
        $set: {
          content: cleanup.content,
          metadata,
          unfinished: false,
          error: false,
        },
      },
    );
    if (result?.modifiedCount > 0) {
      repaired += 1;
    }
  }

  if (repaired > 0) {
    logger.warn(
      `[staleCortexMessageRecovery] Removed stale deferred-hold parent error cards from ${repaired} message(s)`,
    );
  }

  return { scanned: parents.length, repaired };
}

async function bindRecoveredCortexPresentationGeneration({
  ownerId,
  conversationId,
  message,
  revision,
  claimGeneration,
  claimToken,
  parentMessageId = '',
}) {
  const presentationGeneration = Number(claimGeneration);
  if (!Number.isSafeInteger(presentationGeneration) || presentationGeneration < 1) {
    const error = new Error('Cortex recovery claim generation is unavailable');
    error.code = 'cortex_recovery_claim_generation_unavailable';
    throw error;
  }
  const presentationClaimToken = String(claimToken || '').trim();
  if (!presentationClaimToken) {
    const error = new Error('Cortex recovery claim token is unavailable');
    error.code = 'cortex_recovery_claim_token_unavailable';
    throw error;
  }
  const currentGeneration = Number(message?.metadata?.viventium?.cortexPresentationGeneration);
  const currentClaimToken = String(
    message?.metadata?.viventium?.cortexPresentationClaimToken || '',
  ).trim();
  if (
    currentGeneration > presentationGeneration ||
    (currentGeneration === presentationGeneration &&
      currentClaimToken &&
      currentClaimToken !== presentationClaimToken)
  ) {
    const error = new Error('Cortex recovery presentation generation is stale');
    error.code = 'cortex_insight_delivery_settlement_conflict';
    throw error;
  }
  if (
    currentGeneration !== presentationGeneration ||
    currentClaimToken !== presentationClaimToken
  ) {
    const result = await Message.updateOne(
      {
        user: String(ownerId || '').trim(),
        conversationId: String(conversationId || '').trim(),
        messageId: message.messageId,
        isCreatedByUser: { $ne: true },
        'metadata.viventium.type': 'cortex_followup',
        'metadata.viventium.cortexPresentationParentMessageId': String(
          parentMessageId || '',
        ).trim(),
        $or: [
          { 'metadata.viventium.cortexPresentationGeneration': { $exists: false } },
          { 'metadata.viventium.cortexPresentationGeneration': { $lt: presentationGeneration } },
          {
            'metadata.viventium.cortexPresentationGeneration': presentationGeneration,
            'metadata.viventium.cortexPresentationClaimToken': { $in: ['', null] },
          },
        ],
      },
      {
        $set: {
          'metadata.viventium.messageRevision': revision,
          'metadata.viventium.cortexPresentationGeneration': presentationGeneration,
          'metadata.viventium.cortexPresentationClaimToken': presentationClaimToken,
          'metadata.viventium.cortexPresentationParentMessageId': String(
            parentMessageId || '',
          ).trim(),
        },
      },
    );
    const matchedCount = Number(result?.matchedCount ?? result?.n ?? 0);
    const modifiedCount = Number(result?.modifiedCount ?? result?.nModified ?? 0);
    if (result?.acknowledged === false || (matchedCount < 1 && modifiedCount < 1)) {
      const error = new Error('Cortex recovery presentation generation was not persisted');
      error.code = 'cortex_recovery_generation_persistence_unavailable';
      throw error;
    }
  }
  return {
    ...message,
    revision,
    metadata: {
      ...(message?.metadata || {}),
      viventium: {
        ...(message?.metadata?.viventium || {}),
        messageRevision: revision,
        cortexPresentationGeneration: presentationGeneration,
        cortexPresentationClaimToken: presentationClaimToken,
        cortexPresentationParentMessageId: String(parentMessageId || '').trim(),
      },
    },
  };
}

async function loadPersistedCortexFollowUp({
  ownerId,
  conversationId,
  parentMessageId,
  messageId,
}) {
  if (!ownerId || !conversationId || !parentMessageId || !messageId) return null;
  return Message.findOne({
    user: ownerId,
    conversationId,
    messageId,
    isCreatedByUser: { $ne: true },
    'metadata.viventium.type': 'cortex_followup',
    'metadata.viventium.cortexPresentationParentMessageId': parentMessageId,
  }).lean();
}

async function createRecoveredCortexFollowUp({
  ownerId,
  conversationId,
  parentMessageId,
  surface,
  insights,
  deliveryBatch,
  recoveryContext,
}) {
  const { getUserById } = require('~/models');
  const { getAgent } = require('~/models/Agent');
  const {
    createCortexFollowUpMessage,
  } = require('~/server/services/viventium/BackgroundCortexFollowUpService');
  const parent = await Message.findOne({
    user: ownerId,
    conversationId,
    messageId: parentMessageId,
    isCreatedByUser: { $ne: true },
  }).lean();
  const user = await getUserById(ownerId);
  let conversationAgentId = '';
  if (!String(parent?.agent_id || '').trim()) {
    const conversation = await Conversation.findOne({
      user: ownerId,
      conversationId,
      endpoint: 'agents',
    })
      .select('agent_id')
      .lean();
    conversationAgentId = String(conversation?.agent_id || '').trim();
  }
  const agentId = String(parent?.agent_id || conversationAgentId || '').trim();
  const agent = agentId ? await getAgent({ id: agentId, author: ownerId }) : null;
  if (!parent || !user || !agent) {
    const error = new Error('Cortex recovery author context is unavailable');
    error.code = 'cortex_recovery_author_unavailable';
    throw error;
  }
  // `getUserById` returns a lean Mongo record in production. Rebuild the authenticated request
  // shape and the live role-scoped endpoint capability map before Phase B resolves provider
  // headers. Without these fields, restart recovery sent an identity-free GlassHive request.
  const requestUser = {
    ...(typeof user.toObject === 'function' ? user.toObject() : user),
    id: String(user.id || user._id || ownerId).trim(),
  };
  const streamId = recoveryContext?.streamId || '';
  const req = {
    user: requestUser,
    body: {
      conversationId,
      parentMessageId,
      messageId: parentMessageId,
      viventiumSurface: surface,
      viventiumInputMode: 'text',
      viventiumStreamId: streamId,
      streamId,
      viventiumLogicalTurnRevision: recoveryContext?.messageRevision || 1,
    },
    headers: { 'x-viventium-surface': surface },
    config: await getAppConfig({ role: user.role }),
    _resumableStreamId: streamId,
    ...(recoveryContext?.feelingSnapshot
      ? { _viventiumFeelingSnapshot: recoveryContext.feelingSnapshot }
      : {}),
  };
  return createCortexFollowUpMessage({
    req,
    conversationId,
    parentMessageId,
    agent,
    insightsData: { insights, cortexCount: insights.length },
    recentResponse: String(parent?.text || ''),
    forceVisibleFollowUp: !String(parent?.text || '').trim(),
    claimedDeliveryBatch: deliveryBatch,
  });
}

async function presentRecoveredCortexSurface({
  surface,
  ownerId,
  message,
  parentMessageId,
  conversationId,
  recoveryContext,
  presentationFence,
  streamPresentationBinding,
  emitTelegramFollowUp = false,
  verifyPresentation,
  consumeFault = consumeLocalQaCortexFault,
  receiptWaitMs = DEFAULT_PRESENTATION_RECEIPT_WAIT_MS,
  receiptPollMs = DEFAULT_PRESENTATION_RECEIPT_POLL_MS,
}) {
  const revision = Math.max(1, Number(message?.revision || recoveryContext?.messageRevision) || 1);
  if (surface !== 'web' && surface !== 'telegram') {
    const error = new Error('Cortex surface delivery adapter is unavailable');
    error.code = 'cortex_surface_delivery_adapter_unavailable';
    throw error;
  }
  const presentationGeneration = Math.max(0, Number(recoveryContext?.claimGeneration) || 0);
  if (presentationGeneration < 1) {
    const error = new Error('Cortex presentation generation is unavailable');
    error.code = 'cortex_presentation_generation_unavailable';
    throw error;
  }
  if (
    String(presentationFence?.messageId || '').trim() !== String(message?.messageId || '').trim() ||
    String(presentationFence?.parentMessageId || '').trim() !==
      String(parentMessageId || '').trim() ||
    Number(presentationFence?.revision) !== revision ||
    Number(presentationFence?.generation) !== presentationGeneration ||
    !Array.isArray(presentationFence?.deliveryIds) ||
    presentationFence.deliveryIds.length === 0 ||
    !String(presentationFence?.claimToken || '').trim() ||
    !String(presentationFence?.presentationLeaseToken || '').trim()
  ) {
    const error = new Error('Cortex presentation fence is unavailable');
    error.code = 'cortex_insight_delivery_settlement_conflict';
    throw error;
  }
  const streamId = String(recoveryContext?.streamId || '').trim();
  const interactionContext = streamPresentationBinding?.interactionContext;
  const shouldEmitFollowUp = surface === 'web' || (surface === 'telegram' && emitTelegramFollowUp);
  let transportReceipt = null;
  if (shouldEmitFollowUp) {
    if (!streamId) {
      const error = new Error('Cortex presentation stream is unavailable');
      error.code =
        surface === 'web'
          ? 'cortex_web_presentation_stream_unavailable'
          : 'cortex_telegram_presentation_stream_unavailable';
      throw error;
    }
    if (
      surface === 'telegram' &&
      (!interactionContext?.logicalTurnId ||
        !Number.isSafeInteger(interactionContext?.revision) ||
        interactionContext.revision < 1)
    ) {
      const error = new Error('Cortex Telegram acknowledgement identity is unavailable');
      error.code = 'cortex_telegram_acknowledgement_identity_unavailable';
      throw error;
    }
    const verifyCurrentPresentation = async () => {
      if (typeof verifyPresentation !== 'function') {
        const error = new Error('Cortex presentation verifier is unavailable');
        error.code = 'cortex_insight_delivery_settlement_conflict';
        throw error;
      }
      const verifiedFence = await verifyPresentation();
      const expectedIds = [...presentationFence.deliveryIds].map(String).sort();
      const verifiedIds = Array.isArray(verifiedFence?.deliveryIds)
        ? [...verifiedFence.deliveryIds].map(String).sort()
        : [];
      const exactFence =
        verifiedIds.length === expectedIds.length &&
        verifiedIds.every((deliveryId, index) => deliveryId === expectedIds[index]) &&
        Number(verifiedFence?.generation) === presentationGeneration &&
        String(verifiedFence?.claimToken || '').trim() ===
          String(presentationFence.claimToken).trim() &&
        String(verifiedFence?.presentationLeaseToken || '').trim() ===
          String(presentationFence.presentationLeaseToken).trim() &&
        String(verifiedFence?.messageId || '').trim() === String(message.messageId || '').trim() &&
        String(verifiedFence?.parentMessageId || '').trim() ===
          String(parentMessageId || '').trim() &&
        Number(verifiedFence?.revision) === revision &&
        String(verifiedFence?.surface || '').trim() === surface;
      if (!exactFence) {
        const error = new Error('Cortex presentation fence changed before delivery');
        error.code = 'cortex_insight_delivery_settlement_conflict';
        throw error;
      }
      return verifiedFence;
    };
    const verifiedFence = await verifyCurrentPresentation();
    transportReceipt = await GenerationJobManager.emitCortexPresentation(
      streamId,
      {
        event: 'on_cortex_followup',
        data: {
          runId: parentMessageId,
          messageId: message.messageId,
          parentMessageId,
          conversationId,
          text: message.text,
          revision,
          presentationGeneration,
          presentationParentMessageId: parentMessageId,
          targetSurface: surface === 'telegram' ? 'telegram' : 'all',
          logicalTurnId: interactionContext?.logicalTurnId,
          logicalTurnRevision: interactionContext?.revision,
          cortexPresentation: {
            ownerId: verifiedFence.ownerId,
            messageId: verifiedFence.messageId,
            parentMessageId: verifiedFence.parentMessageId,
            revision: verifiedFence.revision,
            generation: verifiedFence.generation,
            deliveryIds: verifiedFence.deliveryIds,
            deliveryReceipts: verifiedFence.deliveryReceipts,
            claimToken: verifiedFence.claimToken,
            presentationLeaseToken: verifiedFence.presentationLeaseToken,
          },
        },
      },
      verifiedFence,
      {
        /* === VIVENTIUM START === EMO-UC-048 exact recovery scope binding. === */
        consumeCortexFault: (boundary) =>
          consumeFault({
            boundary,
            ownerId: String(ownerId || '').trim(),
            conversationId: String(conversationId || '').trim(),
            parentMessageId: String(parentMessageId || '').trim(),
          }),
        /* === VIVENTIUM END === */
        verifyPresentation: verifyCurrentPresentation,
      },
    );
    if (
      transportReceipt?.delivered !== true ||
      String(transportReceipt.streamId || '').trim() !== streamId ||
      transportReceipt.target !== 'subscriber_transport' ||
      !String(transportReceipt.presentationRef || '').trim() ||
      String(transportReceipt.claimToken || '').trim() !==
        String(verifiedFence.claimToken || '').trim() ||
      String(transportReceipt.presentationLeaseToken || '').trim() !==
        String(verifiedFence.presentationLeaseToken || '').trim()
    ) {
      const error = new Error('Cortex presentation transport receipt is unavailable');
      error.code =
        surface === 'web'
          ? 'cortex_web_presentation_receipt_unavailable'
          : 'cortex_telegram_presentation_emit_receipt_unavailable';
      throw error;
    }
  }
  if (surface === 'web') {
    return {
      surface: 'web',
      messageId: message.messageId,
      revision,
      presentationGeneration,
      presentationClaimToken: transportReceipt.claimToken,
      presentationLeaseToken: transportReceipt.presentationLeaseToken,
      presentationRef: transportReceipt.presentationRef,
    };
  }
  const deadline = Date.now() + Math.max(0, Number(receiptWaitMs) || 0);
  do {
    const receiptMessage = await Message.findOne({
      user: String(ownerId || '').trim(),
      messageId: message.messageId,
      isCreatedByUser: { $ne: true },
      'metadata.viventium.deliveryAcknowledgement.state': {
        $in: ['committed', 'committed_effect'],
      },
      'metadata.viventium.deliveryAcknowledgement.revision': revision,
      'metadata.viventium.deliveryAcknowledgement.cortex_presentation_generation':
        presentationGeneration,
      'metadata.viventium.deliveryAcknowledgement.cortex_presentation_claim_token':
        presentationFence.claimToken,
    }).lean();
    const acknowledgement = receiptMessage?.metadata?.viventium?.deliveryAcknowledgement;
    const presentationRefs = Array.from(
      new Set(
        [
          ...(Array.isArray(acknowledgement?.presentation_refs)
            ? acknowledgement.presentation_refs
            : []),
          acknowledgement?.presentation_ref,
        ]
          .map((value) => String(value || '').trim())
          .filter((value) => /^telegram:[^:]+:[^:]+$/.test(value)),
      ),
    ).sort();
    if (
      ['committed', 'committed_effect'].includes(acknowledgement?.state) &&
      Number(acknowledgement?.revision) === revision &&
      presentationGeneration > 0 &&
      Number(acknowledgement?.cortex_presentation_generation) === presentationGeneration &&
      String(acknowledgement?.cortex_presentation_claim_token || '').trim() ===
        String(presentationFence.claimToken || '').trim() &&
      presentationRefs.length > 0
    ) {
      return {
        surface: 'telegram',
        messageId: message.messageId,
        revision,
        presentationGeneration,
        presentationClaimToken: presentationFence.claimToken,
        presentationLeaseToken: presentationFence.presentationLeaseToken,
        presentationRef: presentationRefs.join('|'),
      };
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(1, Number(receiptPollMs) || DEFAULT_PRESENTATION_RECEIPT_POLL_MS),
      ),
    );
  } while (Date.now() <= deadline);

  const error = new Error('Cortex Telegram presentation receipt is unavailable');
  error.code = 'cortex_telegram_presentation_receipt_unavailable';
  throw error;
}

async function bindRecoveredCortexStreamPresentation({ recoveryContext, presentationFence }) {
  const streamId = String(recoveryContext?.streamId || '').trim();
  if (!streamId) {
    const error = new Error('Cortex recovery stream receipt identity is unavailable');
    error.code = 'cortex_recovery_stream_receipt_unavailable';
    throw error;
  }
  const binding = await GenerationJobManager.bindCortexPresentation(streamId, presentationFence);
  if (!binding) {
    const error = new Error('Cortex recovery stream receipt binding was rejected');
    error.code = 'cortex_recovery_stream_receipt_conflict';
    throw error;
  }
  const job = await GenerationJobManager.getJob(streamId);
  const interactionContext = job?.metadata?.interactionContext;
  if (
    presentationFence.surface === 'telegram' &&
    (interactionContext?.surface !== 'telegram' ||
      !String(interactionContext?.logical_turn_id || '').trim() ||
      !Number.isSafeInteger(interactionContext?.revision) ||
      interactionContext.revision < 1)
  ) {
    const error = new Error('Cortex recovery logical-turn binding is unavailable');
    error.code = 'cortex_recovery_logical_turn_binding_unavailable';
    throw error;
  }
  return {
    ...binding,
    ...(interactionContext
      ? {
          interactionContext: {
            logicalTurnId: String(interactionContext.logical_turn_id || '').trim(),
            revision: interactionContext.revision,
          },
        }
      : {}),
  };
}

async function replayCompletedCortexMessageFallbacks({
  MessageModel = Message,
  recordBatch = recordCompletedCortexInsightDeliveryBatch,
  deliveryService = cortexInsightDeliveryService,
  limit = 100,
} = {}) {
  if (MessageModel?.db && MessageModel.db.readyState !== 1) {
    return { scanned: 0, replayed: 0, pending: 0 };
  }
  const retryQuery = {
    $or: [
      {
        content: {
          $elemMatch: {
            type: ContentTypes.CORTEX_INSIGHT,
            cortex_delivery_acceptance: 'retryable',
          },
        },
      },
      { 'content.cortex_delivery_feeling_snapshot': { $exists: true } },
    ],
  };
  const pageSize = Math.max(1, Math.min(Number(limit) || 100, 500));
  const summary = { scanned: 0, replayed: 0, pending: 0 };
  let cursor = null;

  while (true) {
    const query = cursor
      ? {
          $and: [
            retryQuery,
            {
              $or: [
                { createdAt: { $gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, _id: { $gt: cursor._id } },
              ],
            },
          ],
        }
      : retryQuery;
    const messages = await MessageModel.find(query)
      .sort({ createdAt: 1, _id: 1 })
      .limit(pageSize)
      .lean();
    if (messages.length === 0) break;
    summary.scanned += messages.length;
    const lastMessage = messages[messages.length - 1];
    cursor = { createdAt: lastMessage.createdAt, _id: lastMessage._id };

    for (const message of messages) {
      const content = Array.isArray(message.content) ? message.content : [];
      const retryParts = content.filter(
        (part) =>
          part?.type === ContentTypes.CORTEX_INSIGHT &&
          part?.cortex_delivery_acceptance === 'retryable' &&
          typeof part?.insight === 'string' &&
          part.insight.trim(),
      );
      const hasLegacyFeelingSnapshot = content.some(
        (part) =>
          part &&
          typeof part === 'object' &&
          Object.prototype.hasOwnProperty.call(part, 'cortex_delivery_feeling_snapshot'),
      );

      try {
        if (retryParts.length === 0) {
          if (hasLegacyFeelingSnapshot) {
            await MessageModel.updateOne(
              { _id: message._id, user: message.user, messageId: message.messageId },
              { $unset: { 'content.$[legacy].cortex_delivery_feeling_snapshot': '' } },
              { arrayFilters: [{ 'legacy.cortex_delivery_feeling_snapshot': { $exists: true } }] },
            );
          }
          continue;
        }

        const surfaces = new Set(
          retryParts.map((part) => String(part.cortex_delivery_surface || '').trim()),
        );
        const streamIds = new Set(
          retryParts.map((part) => String(part.cortex_delivery_stream_id || '').trim()),
        );
        const revisions = new Set(
          retryParts.map((part) => Number(part.cortex_delivery_message_revision)),
        );
        const snapshots = retryParts.map((part) =>
          normalizeCortexFeelingSnapshot(part.cortex_delivery_feeling_snapshot ?? null),
        );
        const snapshotIdentities = new Set(
          snapshots.map((snapshot) => (snapshot ? JSON.stringify(snapshot) : '')),
        );
        if (
          surfaces.size !== 1 ||
          streamIds.size !== 1 ||
          revisions.size !== 1 ||
          snapshotIdentities.size !== 1
        ) {
          const error = new Error(
            'Canonical completed-insight siblings disagree on retry envelope',
          );
          error.code = 'cortex_insight_canonical_retry_envelope_conflict';
          throw error;
        }
        const [messageRevision] = revisions;
        if (!Number.isSafeInteger(messageRevision) || messageRevision < 1) {
          const error = new Error('Canonical completed-insight retry revision is invalid');
          error.code = 'cortex_insight_canonical_retry_revision_invalid';
          throw error;
        }
        const [surface] = surfaces;
        const [streamId] = streamIds;
        const feelingSnapshot = snapshots[0] || null;
        const batch = {
          ownerId: message.user,
          conversationId: message.conversationId,
          parentMessageId: message.messageId,
          surface,
          streamId,
          messageRevision,
          ...(feelingSnapshot ? { feelingSnapshot } : {}),
          insights: retryParts.map((part) => ({
            cortexId: part.cortex_id,
            cortexName: part.cortex_name,
            insight: part.insight,
            status: 'completed',
          })),
        };
        const expectedDeliveries = buildCortexInsightDeliveryCandidates(batch);
        const expectedHashes = expectedDeliveries.map((delivery) => delivery.graphResultHash);
        const storedHashes = retryParts.map((part) =>
          String(part.cortex_graph_result_hash || '').trim(),
        );
        if (
          expectedHashes.length !== storedHashes.length ||
          expectedHashes.some((hash, index) => hash !== storedHashes[index])
        ) {
          const error = new Error('Canonical completed-insight retry hash mismatch');
          error.code = 'cortex_insight_canonical_retry_hash_mismatch';
          throw error;
        }
        const receipt = await recordBatch(batch);
        requireExactCortexInsightDeliveryAcceptance(expectedDeliveries, receipt);
        const hasPersistenceReceipt = receipt.deliveries.every(
          (delivery) =>
            delivery.persistenceStatus === 'persisted' &&
            String(delivery.persistedMessageId || '').trim() === String(message.messageId) &&
            Number(delivery.messageRevision) === messageRevision,
        );
        if (!hasPersistenceReceipt) {
          const claimed = await deliveryService.claimPendingByParent({
            ownerId: message.user,
            parentMessageId: message.messageId,
            surface,
          });
          requireExactCortexInsightDeliveryAcceptance(expectedDeliveries, {
            deliveries: claimed.claimed,
          });
          const persisted = await deliveryService.markPersisted({
            ownerId: message.user,
            claims: claimed.claimed,
            persistedMessageId: message.messageId,
            messageRevision,
          });
          requireExactCortexInsightDeliverySettlement(claimed.claimed, persisted);
        }
        const update = {
          $set: { 'content.$[retry].cortex_delivery_acceptance': 'ledger' },
          ...(hasLegacyFeelingSnapshot
            ? { $unset: { 'content.$[legacy].cortex_delivery_feeling_snapshot': '' } }
            : {}),
        };
        const arrayFilters = [
          {
            'retry.type': ContentTypes.CORTEX_INSIGHT,
            'retry.cortex_delivery_acceptance': 'retryable',
            'retry.cortex_graph_result_hash': { $in: expectedHashes },
          },
          ...(hasLegacyFeelingSnapshot
            ? [{ 'legacy.cortex_delivery_feeling_snapshot': { $exists: true } }]
            : []),
        ];
        await MessageModel.updateOne(
          { _id: message._id, user: message.user, messageId: message.messageId },
          update,
          { arrayFilters },
        );
        summary.replayed += retryParts.length;
      } catch (error) {
        summary.pending += retryParts.length;
        logger.warn('[staleCortexMessageRecovery] Canonical insight retry remains pending', {
          code: String(error?.code || error?.name || 'canonical_retry_failed').slice(0, 120),
        });
      }
    }
    if (messages.length < pageSize) break;
  }
  return summary;
}

async function loadCortexRecoveryParentState({ ownerId, conversationId, parentMessageId }) {
  const query = Message.findOne({
    user: String(ownerId || '').trim(),
    conversationId: String(conversationId || '').trim(),
    messageId: String(parentMessageId || '').trim(),
    isCreatedByUser: { $ne: true },
  });
  const selected =
    typeof query?.select === 'function' ? query.select('messageId unfinished') : query;
  return typeof selected?.lean === 'function' ? selected.lean() : selected;
}

async function hasBoundDurableTelegramDispatchAuthority({
  ownerId,
  conversationId,
  parentMessageId,
  surface,
}) {
  if (String(surface || '').trim() !== 'telegram') return false;
  if (
    typeof ViventiumCortexInsightDelivery?.findOne !== 'function' ||
    typeof ViventiumTelegramIngressEvent?.findOne !== 'function'
  ) {
    return false;
  }
  const deliveryQuery = ViventiumCortexInsightDelivery.findOne({
    userId: String(ownerId || '').trim(),
    conversationId: String(conversationId || '').trim(),
    parentMessageId: String(parentMessageId || '').trim(),
    surface: 'telegram',
    persistenceStatus: 'persisted',
    requiredSurfaces: 'telegram',
    $and: [{ presentedSurfaces: 'web' }, { presentedSurfaces: { $ne: 'telegram' } }],
  });
  const selected =
    typeof deliveryQuery?.select === 'function' ? deliveryQuery.select('+streamId') : deliveryQuery;
  const delivery = typeof selected?.lean === 'function' ? await selected.lean() : await selected;
  const streamId = String(delivery?.streamId || '').trim();
  if (!streamId) return false;
  const ingressQuery = ViventiumTelegramIngressEvent.findOne({
    libreChatUserId: String(ownerId || '').trim(),
    conversationId: String(conversationId || '').trim(),
    streamId,
    authorityBoundAt: { $type: 'date' },
  });
  const ingressSelected =
    typeof ingressQuery?.select === 'function' ? ingressQuery.select('_id') : ingressQuery;
  const ingress =
    typeof ingressSelected?.lean === 'function'
      ? await ingressSelected.lean()
      : await ingressSelected;
  return Boolean(ingress?._id);
}

async function recoverPendingCortexInsightDeliveries({
  deliveryService = cortexInsightDeliveryService,
  createMessage = createRecoveredCortexFollowUp,
  loadMessage = loadPersistedCortexFollowUp,
  loadParentState = loadCortexRecoveryParentState,
  hasDurableTelegramDispatchAuthority = hasBoundDurableTelegramDispatchAuthority,
  bindMessageGeneration = bindRecoveredCortexPresentationGeneration,
  bindStreamPresentation = bindRecoveredCortexStreamPresentation,
  presentSurface = presentRecoveredCortexSurface,
  replayMessageFallbacks = replayCompletedCortexMessageFallbacks,
  replayOutbox = replayCompletedCortexInsightOutbox,
  limit = 100,
} = {}) {
  const summary = {
    scanned: 0,
    claimed: 0,
    persisted: 0,
    presented: 0,
    sent: 0,
    dropped: 0,
    pending: 0,
    failed: 0,
    outbox: { scanned: 0, replayed: 0, pending: 0 },
  };
  try {
    await replayMessageFallbacks({ limit });
  } catch (error) {
    summary.failed += 1;
    logger.warn('[staleCortexMessageRecovery] Canonical completed insight scan failed', {
      code: String(error?.code || error?.name || 'canonical_retry_scan_failed').slice(0, 120),
    });
  }
  try {
    summary.outbox = await replayOutbox({ limit });
  } catch (error) {
    summary.failed += 1;
    logger.warn('[staleCortexMessageRecovery] Completed insight outbox scan failed', {
      code: String(error?.code || error?.name || 'outbox_scan_failed').slice(0, 120),
    });
  }
  let parents;
  try {
    parents = await deliveryService.listRecoverableParents({ limit });
  } catch (error) {
    logger.warn('[staleCortexMessageRecovery] Cortex insight delivery scan failed', {
      code: String(error?.code || error?.name || 'delivery_scan_failed').slice(0, 120),
    });
    return { ...summary, failed: 1 };
  }
  summary.scanned = parents.length;
  const deferParentClaim = async (parent, reason) => {
    try {
      await deliveryService.deferRecoverableParent?.({
        ownerId: parent.ownerId,
        parentMessageId: parent.parentMessageId,
        surface: parent.surface,
        reason,
      });
    } catch (error) {
      logger.warn('[staleCortexMessageRecovery] Cortex parent retry deferral failed', {
        code: String(error?.code || error?.name || 'delivery_claim_deferral_failed').slice(0, 120),
      });
    }
  };
  for (const parent of parents) {
    let parentState;
    try {
      parentState = await loadParentState(parent);
    } catch (error) {
      summary.failed += 1;
      await deferParentClaim(parent, 'parent_state_unavailable');
      logger.warn('[staleCortexMessageRecovery] Cortex parent state check failed', {
        code: String(error?.code || error?.name || 'parent_state_unavailable').slice(0, 120),
      });
      continue;
    }
    if (!parentState) {
      summary.pending += 1;
      await deferParentClaim(parent, 'parent_state_unavailable');
      continue;
    }
    if (parentState?.unfinished === true) {
      summary.pending += 1;
      await deferParentClaim(parent, 'parent_generation_active');
      continue;
    }
    try {
      if (await hasDurableTelegramDispatchAuthority(parent)) {
        // The authenticated bot dispatcher now owns this exact Web-presented Telegram gap. The
        // general recovery worker must not race it, consume attempts, or create a duplicate send.
        summary.pending += 1;
        continue;
      }
    } catch (error) {
      summary.failed += 1;
      summary.pending += 1;
      logger.warn('[staleCortexMessageRecovery] Durable Telegram authority check failed closed', {
        code: String(error?.code || error?.name || 'telegram_dispatch_authority_unavailable').slice(
          0,
          120,
        ),
      });
      continue;
    }
    let batch;
    try {
      batch = await deliveryService.claimPendingByParent({
        ownerId: parent.ownerId,
        parentMessageId: parent.parentMessageId,
        surface: parent.surface,
      });
    } catch (error) {
      summary.failed += 1;
      await deferParentClaim(parent, 'recovery_claim_failed');
      logger.warn('[staleCortexMessageRecovery] Cortex parent claim failed', {
        code: String(error?.code || error?.name || 'delivery_claim_failed').slice(0, 120),
      });
      continue;
    }
    if (!batch.claimed.length) {
      await deferParentClaim(parent, 'recovery_claim_conflict');
      continue;
    }
    summary.claimed += batch.claimed.length;
    const claimGenerations = [
      ...new Set(batch.claimed.map((claim) => Number(claim.claimGeneration))),
    ];
    const claimGeneration = claimGenerations.length === 1 ? claimGenerations[0] : 0;
    const recoveryContext = {
      ...(batch.recoveryContext || {}),
      claimGeneration,
    };
    const requiredSurfaces = [
      ...new Set(batch.claimed.flatMap((row) => row.requiredSurfaces || [])),
    ];
    const unsupportedSurfaces = requiredSurfaces.filter(
      (surface) => !RECOVERY_PRESENTATION_SURFACES.has(surface),
    );
    if (requiredSurfaces.length === 0 || unsupportedSurfaces.length > 0) {
      try {
        const dropped = await deliveryService.markDropped({
          ownerId: parent.ownerId,
          claims: batch.claimed,
          dropReason: 'unsupported_surface',
        });
        summary.dropped += dropped.filter((row) => row.status === 'dropped').length;
      } catch (error) {
        summary.pending += batch.claimed.length;
        logger.warn('[staleCortexMessageRecovery] Unsupported Cortex surface drop failed', {
          code: String(error?.code || error?.name || 'unsupported_surface_drop_failed').slice(
            0,
            120,
          ),
        });
      }
      continue;
    }
    const persistedMessageIds = [
      ...new Set(batch.deliveries.map((row) => row.persistedMessageId).filter(Boolean)),
    ];
    let message = null;
    try {
      if (persistedMessageIds.length > 1) {
        const error = new Error('Cortex recovery persisted message identity is inconsistent');
        error.code = 'cortex_recovery_persisted_message_scope_mismatch';
        throw error;
      }
      if (persistedMessageIds.length === 1) {
        message = await loadMessage({
          ownerId: parent.ownerId,
          conversationId: parent.conversationId,
          parentMessageId: parent.parentMessageId,
          messageId: persistedMessageIds[0],
        });
        if (!message) {
          const error = new Error('Cortex recovery persisted message is outside the exact scope');
          error.code = 'cortex_recovery_persisted_message_scope_mismatch';
          throw error;
        }
      }
      if (persistedMessageIds.length === 0) {
        message = await createMessage({
          ...parent,
          insights: batch.insights,
          deliveryBatch: batch,
          recoveryContext,
        });
      }
      if (!message?.messageId) {
        const error = new Error('Cortex recovery did not persist a follow-up message');
        error.code = 'cortex_recovery_persistence_receipt_unavailable';
        throw error;
      }
      const revision = Math.max(
        1,
        Number(message.revision || message?.metadata?.viventium?.messageRevision) ||
          batch.recoveryContext?.messageRevision ||
          1,
      );
      message = await bindMessageGeneration({
        ownerId: parent.ownerId,
        conversationId: parent.conversationId,
        message,
        revision,
        claimGeneration,
        claimToken: batch.claimId || batch.claimed[0]?.claimToken,
        parentMessageId: parent.parentMessageId,
      });
      const persisted = await deliveryService.markPersisted({
        ownerId: parent.ownerId,
        claims: batch.claimed,
        persistedMessageId: message.messageId,
        messageRevision: revision,
      });
      requireExactCortexInsightDeliverySettlement(batch.claimed, persisted);
      summary.persisted += persisted.length;
      const alreadyPresented = new Set(
        requiredSurfaces.filter((surface) =>
          batch.claimed.every((row) => (row.presentedSurfaces || []).includes(surface)),
        ),
      );
      for (const surface of requiredSurfaces) {
        if (alreadyPresented.has(surface)) continue;
        let presentationFence = await deliveryService.fencePresentation({
          ownerId: parent.ownerId,
          claims: batch.claimed,
          surface,
          parentMessageId: parent.parentMessageId,
          persistedMessageId: message.messageId,
          messageRevision: revision,
        });
        requireExactCortexInsightDeliverySettlement(batch.claimed, presentationFence?.claims);
        if (Number(presentationFence?.generation) !== claimGeneration) {
          const error = new Error('Cortex presentation fence generation does not match claim');
          error.code = 'cortex_insight_delivery_settlement_conflict';
          throw error;
        }
        const streamPresentationBinding = await bindStreamPresentation({
          recoveryContext,
          presentationFence,
        });
        const receipt = await presentSurface({
          ...parent,
          surface,
          message: { ...message, revision },
          recoveryContext,
          presentationFence,
          streamPresentationBinding,
          emitTelegramFollowUp: surface === 'telegram' && !requiredSurfaces.includes('web'),
          verifyPresentation: async () => {
            presentationFence = await deliveryService.fencePresentation({
              ownerId: parent.ownerId,
              claims: presentationFence.claims,
              surface,
              parentMessageId: parent.parentMessageId,
              persistedMessageId: message.messageId,
              messageRevision: revision,
            });
            return presentationFence;
          },
        });
        if (!receipt) {
          const error = new Error('Cortex surface delivery adapter returned no receipt');
          error.code = 'cortex_surface_delivery_receipt_unavailable';
          throw error;
        }
        if (Number(receipt.presentationGeneration) !== claimGeneration) {
          const error = new Error('Cortex surface receipt generation does not match current claim');
          error.code = 'cortex_surface_delivery_generation_conflict';
          throw error;
        }
        if (
          String(receipt.presentationClaimToken || '').trim() !==
            String(presentationFence.claimToken || '').trim() ||
          String(receipt.presentationLeaseToken || '').trim() !==
            String(presentationFence.presentationLeaseToken || '').trim()
        ) {
          const error = new Error('Cortex surface receipt lease does not match current claim');
          error.code = 'cortex_surface_delivery_claim_conflict';
          throw error;
        }
        const settled = await deliveryService.markPresented({
          ownerId: parent.ownerId,
          claims: presentationFence.claims,
          surface,
          persistedMessageId: message.messageId,
          messageRevision: revision,
          presentationGeneration: claimGeneration,
          presentationClaimToken: receipt.presentationClaimToken,
          presentationLeaseToken: receipt.presentationLeaseToken,
          presentationRef: receipt.presentationRef,
        });
        requireExactCortexInsightDeliverySettlement(presentationFence.claims, settled);
        summary.presented += settled.length;
      }
      const finalized = await deliveryService.finalizePresented({
        ownerId: parent.ownerId,
        claims: batch.claimed,
      });
      requireExactCortexInsightDeliverySettlement(batch.claimed, finalized);
      summary.sent += finalized.filter((row) => row.status === 'sent').length;
    } catch (error) {
      const reason = message ? 'presentation_failed' : 'durable_surface_persistence_failed';
      try {
        const attemptsExhausted = batch.claimed.some(
          (claim) => Number(claim.attemptNumber) >= DEFAULT_CORTEX_DELIVERY_MAX_ATTEMPTS,
        );
        if (attemptsExhausted) {
          let dropped;
          try {
            dropped = await deliveryService.markDropped({
              ownerId: parent.ownerId,
              claims: batch.claimed,
              dropReason: 'delivery_attempts_exhausted',
            });
          } catch (_staleClaimError) {
            const terminalBatch = await deliveryService.claimPendingByParent({
              ownerId: parent.ownerId,
              parentMessageId: parent.parentMessageId,
              surface: parent.surface,
              terminalSettlement: true,
            });
            if (!terminalBatch.claimed.length) throw _staleClaimError;
            dropped = await deliveryService.markDropped({
              ownerId: parent.ownerId,
              claims: terminalBatch.claimed,
              dropReason: 'delivery_attempts_exhausted',
            });
          }
          summary.dropped += dropped.filter((row) => row.status === 'dropped').length;
        } else {
          await deliveryService.markFailed({
            ownerId: parent.ownerId,
            claims: batch.claimed,
            reason,
          });
          summary.pending += batch.claimed.length;
        }
      } catch (_settlementError) {
        // The creating path may already have settled the exact claim as pending or dropped.
        summary.pending += batch.claimed.length;
      }
      logger.warn('[staleCortexMessageRecovery] Cortex insight delivery attempt failed', {
        reason,
        code: String(error?.code || error?.name || 'delivery_recovery_failed').slice(0, 120),
      });
    }
  }
  return summary;
}

async function recoverStaleCortexMessages({
  now = new Date(),
  recoverInsightDeliveries = recoverPendingCortexInsightDeliveries,
} = {}) {
  /* === VIVENTIUM START === Same recovery pass; native GET never starts or repeats a turn. === */
  await require('./nativeResponseService').recoverNativeResponses();
  const { timeoutMs, limit, cortexExecutionTimeoutMs, graceMs } = getStaleCortexRecoveryConfig();
  // Never classify work created by this API process as restart-orphaned. The age threshold can
  // advance up to process start, but not beyond it; an explicitly configured execution deadline
  // remains owned by the executor itself.
  const cutoff = new Date(Math.min(now.getTime() - timeoutMs, PROCESS_STARTED_AT_MS));
  const nowIso = now.toISOString();

  const messages = await Message.find({
    'nativeResponse.status': { $nin: ['pending', 'prepared'] },
    isCreatedByUser: false,
    createdAt: { $lt: cutoff },
    $or: [{ unfinished: true }, { 'content.type': { $in: Array.from(CORTEX_TYPES) } }],
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  let repaired = 0;
  for (const message of messages) {
    const recovery = recoverCortexContent(message.content, nowIso);
    if (!recovery.changed && message.unfinished !== true) {
      continue;
    }

    const update = {
      unfinished: false,
      content: recovery.content,
    };
    const fallbackText = getDeferredFallbackErrorText({
      scheduleId: message?.metadata?.viventium?.scheduleId || '',
      recoveryReason: 'stale_cortex_startup_recovery',
    });
    if (fallbackText && shouldReplaceHoldText(message)) {
      update.text = fallbackText;
    }

    const result = await Message.updateOne(
      {
        _id: message._id,
        updatedAt: message.updatedAt,
        'nativeResponse.status': { $nin: ['pending', 'prepared'] },
      },
      { $set: update },
    );
    if (result?.modifiedCount > 0) {
      repaired += 1;
    }
  }

  if (repaired > 0) {
    logger.warn(
      `[staleCortexMessageRecovery] Repaired ${repaired} stale background cortex message(s) ` +
        `older than ${timeoutMs}ms (execution_timeout_ms=${cortexExecutionTimeoutMs}, grace_ms=${graceMs})`,
    );
  } else {
    logger.info(
      `[staleCortexMessageRecovery] No stale background cortex messages found ` +
        `(timeout_ms=${timeoutMs}, execution_timeout_ms=${cortexExecutionTimeoutMs}, grace_ms=${graceMs})`,
    );
  }

  const recoveredErrorCards = await recoverVisibleFollowUpErrorCards({ limit });
  const deferredHoldParentErrorCards = await recoverDeferredHoldParentErrorCards({ limit });
  const recoveredInsightDeliveries = await recoverInsightDeliveries({ limit });

  return {
    scanned: messages.length,
    repaired,
    recoveredErrorCards,
    deferredHoldParentErrorCards,
    recoveredInsightDeliveries,
    timeoutMs,
    limit,
    cortexExecutionTimeoutMs,
    graceMs,
  };
}

module.exports = {
  recoverPendingCortexInsightDeliveries,
  createRecoveredCortexFollowUp,
  replayCompletedCortexMessageFallbacks,
  presentRecoveredCortexSurface,
  bindRecoveredCortexStreamPresentation,
  ACTIVE_CORTEX_STATUSES,
  getConfiguredCortexExecutionTimeoutMs,
  getStaleCortexRecoveryIntervalMs,
  recoverCortexContent,
  recoverDeferredHoldParentErrorCards,
  recoverVisibleFollowUpErrorCards,
  recoverStaleCortexMessages,
  bindRecoveredCortexPresentationGeneration,
  getStaleCortexRecoveryConfig,
  isActiveCortexPart,
  stripDeferredHoldParentErrorParts,
  stripErrorPartsFromRecoveredFollowUpContent,
};
