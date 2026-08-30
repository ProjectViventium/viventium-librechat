/* === VIVENTIUM START ===
 * Feature: Durable GlassHive callback surface delivery ledger.
 * Purpose:
 * - Keep GlassHive callback persistence separate from surface delivery.
 * - Let Telegram/voice workers claim, send, retry, and audit callbacks that arrive
 *   after the original request stream has ended.
 * Added: 2026-05-06
 * === VIVENTIUM END === */

const crypto = require('crypto');
const {
  canonicalizeGlassHiveCallbackRef,
  createGlassHiveCallbackDeliveryDispatchService,
  verifyVoiceWorkerCompletionPresentation,
} = require('@librechat/api');
const {
  acquireGlassHiveTerminalCallbackAcceptedOperationEffectLease,
  fenceGlassHiveTerminalCallbackEffectTransaction,
  logger,
  releaseGlassHiveTerminalCallbackEffectLease,
  renewGlassHiveTerminalCallbackEffectLease,
} = require('@librechat/data-schemas');
const {
  GlassHiveTerminalCallbackResult,
  Message,
  ViventiumGlassHiveCallbackDelivery,
} = require('~/db/models');
const { recordOrchestrationTraceDelivery } = require('./OrchestrationTraceLedgerService');
const { recordVoiceOrchestrationTrace } = require('./VoiceOrchestrationTraceService');
const { resolveTelegramMappingByUserId } = require('~/server/services/TelegramLinkService');
const {
  runGlassHiveTerminalCallbackTransaction,
} = require('./GlassHiveTerminalCallbackTransaction');

const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_RETRIES = 8;
const MAX_LAST_ERROR_LENGTH = 2000;
const PROJECTION_RETRY_MS = 30_000;
const PROJECTABLE_DELIVERY_STATES = [
  'pending',
  'claimed',
  'sent',
  'failed',
  'suppressed',
  'unresolved',
  'delivery_unknown',
];

const callbackDeliveryDispatch = createGlassHiveCallbackDeliveryDispatchService({
  DeliveryModel: ViventiumGlassHiveCallbackDelivery,
  resultExists: async (filter) => Boolean(await GlassHiveTerminalCallbackResult.exists(filter)),
  acquireEffectLease: ({ reference, now, leaseDurationMs, session }) =>
    acquireGlassHiveTerminalCallbackAcceptedOperationEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      reference,
      now,
      leaseDurationMs,
      session,
    }),
  renewEffectLease: ({ lease, now, leaseDurationMs, session }) =>
    renewGlassHiveTerminalCallbackEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      lease,
      now,
      leaseDurationMs,
      session,
    }),
  fenceEffectTransaction: ({ lease, now, session }) =>
    fenceGlassHiveTerminalCallbackEffectTransaction({
      ResultModel: GlassHiveTerminalCallbackResult,
      lease,
      now,
      session,
    }),
  releaseEffectLease: ({ lease, session }) =>
    releaseGlassHiveTerminalCallbackEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      lease,
      session,
    }),
  runTransaction: runGlassHiveTerminalCallbackTransaction,
});

function nowDate() {
  return new Date();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function redactDeliveryError(value) {
  return normalizeText(value)
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot<redacted>')
    .replace(/\bbot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>')
    .replace(/\b(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/\b((?:access_)?token|api[_-]?key|secret)=([^&\s]+)/gi, '$1=<redacted>');
}

function deliveryIdFor(deliveryKey) {
  const digest = crypto.createHash('sha256').update(deliveryKey).digest('hex').slice(0, 24);
  return `ghcd_${digest}`;
}

function stableDeliveryIdentity({ callbackId, callbackKey, callbackMessageId, event }) {
  return (
    normalizeText(callbackId) ||
    normalizeText(callbackKey) ||
    `${normalizeText(callbackMessageId)}:${normalizeText(event)}`
  );
}

function deliveryKeyFor({ ownerId, originRef, surface, attemptNumber, ...callbackIdentity }) {
  const stableId = stableDeliveryIdentity(callbackIdentity);
  const attempt =
    Number.isSafeInteger(attemptNumber) && attemptNumber > 0 ? `:attempt:${attemptNumber}` : '';
  return `${normalizeText(ownerId)}:${normalizeText(originRef)}:${normalizeText(surface)}:${stableId}${attempt}`;
}

function legacyDeliveryKeyFor({ surface, ...callbackIdentity }) {
  return `${normalizeText(surface)}:${stableDeliveryIdentity(callbackIdentity)}`;
}

function retryDelayMs(retryCount) {
  const bounded = Math.min(Math.max(Number(retryCount) || 0, 0), 8);
  return Math.min(5 * 60 * 1000, 1000 * 2 ** bounded);
}

function normalizeTelegramMessageIds(values) {
  return Array.isArray(values) ? values.map(normalizeText).filter(Boolean) : [];
}

function deliveryAttemptNumber(delivery) {
  const direct = Number(delivery?.attemptNumber);
  if (Number.isSafeInteger(direct) && direct > 0) return direct;
  const match = /:attempt:([1-9][0-9]*)$/.exec(normalizeText(delivery?.deliveryKey));
  const parsed = Number(match?.[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function toDispatchPayload(delivery) {
  if (!delivery) {
    return null;
  }
  return {
    deliveryId: delivery.deliveryId,
    callbackId: delivery.callbackId || null,
    traceIdentityVerified: delivery.traceIdentityVerified === true,
    attemptNumber: deliveryAttemptNumber(delivery),
    callbackMessageId: delivery.callbackMessageId,
    userId: delivery.userId || '',
    originRef: delivery.originRef || '',
    workRef: delivery.workRef || '',
    conversationId: delivery.conversationId,
    event: delivery.event,
    workerId: delivery.workerId || null,
    runId: delivery.runId || null,
    surface: delivery.surface,
    text: delivery.text || '',
    fullText: delivery.fullText || '',
    telegramChatId: delivery.telegramChatId || '',
    telegramUserId: delivery.telegramUserId || '',
    telegramMessageId: delivery.telegramMessageId || '',
    telegramSentMessageIds: normalizeTelegramMessageIds(delivery.telegramSentMessageIds),
    voiceCallSessionId: delivery.voiceCallSessionId || '',
    voiceRequestId: delivery.voiceRequestId || '',
    status: delivery.status,
    retryCount: delivery.retryCount || 0,
    claimId: delivery.claimId || '',
    createdAt: delivery.createdAt || null,
    claimedAt: delivery.claimedAt || null,
    sentAt: delivery.sentAt || null,
    failedAt: delivery.failedAt || null,
    suppressedAt: delivery.suppressedAt || null,
    unknownAt: delivery.unknownAt || null,
    workerCompletionPresentation: delivery.workerCompletionPresentation || null,
  };
}

function externalDestinations(deliveryContext = {}) {
  return (Array.isArray(deliveryContext.destinations) ? deliveryContext.destinations : []).filter(
    (destination) =>
      ['telegram', 'voice'].includes(normalizeText(destination?.surface).toLowerCase()),
  );
}

function destinationResolved(destination = {}) {
  const surface = normalizeText(destination.surface).toLowerCase();
  if (surface === 'telegram') {
    return Boolean(
      normalizeText(destination.telegramChatId) || normalizeText(destination.telegramUserId),
    );
  }
  return surface === 'voice' && Boolean(normalizeText(destination.voiceCallSessionId));
}

function shouldDispatchNeutralStatus(body = {}) {
  return [
    'main.followup',
    'run.failed',
    'run.cancelled',
    'run.interrupted',
    'checkpoint.ready',
    'takeover.requested',
    'run.needs_input',
    'run.blocked',
  ].includes(normalizeText(body.event));
}

function callbackRef(value) {
  const normalized = normalizeText(value);
  return normalized ? canonicalizeGlassHiveCallbackRef(normalized) : '';
}

function callbackTraceIdentity(body = {}, deliveryContext = {}) {
  const trusted = deliveryContext.traceIdentity;
  const trustedCallbackRef = normalizeText(trusted?.callbackRef);
  const event = normalizeText(deliveryContext.traceCallbackEvent || body.event).toLowerCase();
  const preRuntimeTerminal =
    trusted?.attemptNumber == null &&
    body.attempt_number == null &&
    ['run.failed', 'run.cancelled', 'run.interrupted'].includes(event);
  const trustedAttemptNumber = preRuntimeTerminal ? null : Number(trusted?.attemptNumber);
  if (
    !/^callback_sha256:[a-f0-9]{64}$/.test(trustedCallbackRef) ||
    (!preRuntimeTerminal &&
      (!Number.isSafeInteger(trustedAttemptNumber) || trustedAttemptNumber < 1))
  ) {
    return null;
  }
  const callbackId = normalizeText(body.callback_id);
  const attemptNumber = preRuntimeTerminal ? null : Number(body.attempt_number);
  if (
    !callbackId ||
    (!preRuntimeTerminal && (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1))
  ) {
    return null;
  }
  if (callbackRef(callbackId) !== trustedCallbackRef || trustedAttemptNumber !== attemptNumber) {
    return null;
  }
  return Object.freeze({ callbackRef: trustedCallbackRef, attemptNumber: trustedAttemptNumber });
}

function deliveryTerminalState(event) {
  const normalized = normalizeText(event).toLowerCase();
  if (normalized === 'run.completed') return 'completed';
  if (normalized === 'run.failed') return 'failed';
  if (['run.cancelled', 'run.interrupted'].includes(normalized)) return 'cancelled';
  return '';
}

function terminalCallbackReference(effectFence) {
  const reference = {
    resultKey: normalizeText(effectFence?.resultKey),
    acceptedOperationId: normalizeText(effectFence?.acceptedOperationId),
    callbackId: normalizeText(effectFence?.callbackId),
    resultDigest: normalizeText(effectFence?.resultDigest),
    resultRevision: Number(effectFence?.resultRevision),
    generation: Number(effectFence?.acceptedOperationGeneration ?? effectFence?.generation),
  };
  if (
    !/^ghtr_[a-f0-9]{64}$/.test(reference.resultKey) ||
    !/^[a-f0-9]{32}$/.test(reference.acceptedOperationId) ||
    !/^cb_terminal_[a-f0-9]{64}$/.test(reference.callbackId) ||
    !/^sha256:[a-f0-9]{64}$/.test(reference.resultDigest) ||
    !Number.isSafeInteger(reference.resultRevision) ||
    reference.resultRevision < 1 ||
    !Number.isSafeInteger(reference.generation) ||
    reference.generation < 1
  ) {
    throw Object.assign(new Error('glasshive_callback_effect_fence_invalid'), {
      code: 'glasshive_callback_effect_fenced',
    });
  }
  return reference;
}

function terminalCallbackFields(reference) {
  if (!reference) return {};
  return {
    terminalCallbackResultKey: reference.resultKey,
    terminalCallbackAcceptedOperationId: reference.acceptedOperationId,
    terminalCallbackId: reference.callbackId,
    terminalCallbackResultDigest: reference.resultDigest,
    terminalCallbackResultRevision: reference.resultRevision,
    terminalCallbackEffectGeneration: reference.generation,
  };
}

async function acceptedTerminalCallbackReference({
  effectFence,
  body,
  deliveryContext,
  traceIdentity,
}) {
  if (effectFence) return terminalCallbackReference(effectFence);
  const terminalState = deliveryTerminalState(deliveryContext.traceCallbackEvent);
  const ownerId = normalizeText(deliveryContext.ownerId);
  const originRef = normalizeText(deliveryContext.originRef);
  const workRef = normalizeText(deliveryContext.workRef);
  const workerId = normalizeText(body.worker_id);
  const runId = normalizeText(body.run_id);
  const attemptNumber = traceIdentity?.attemptNumber;
  if (
    !terminalState ||
    !ownerId ||
    !originRef ||
    !workRef ||
    !workerId ||
    !runId ||
    !Number.isSafeInteger(attemptNumber) ||
    attemptNumber < 1
  ) {
    return null;
  }
  const result = await GlassHiveTerminalCallbackResult.findOne({
    ownerId,
    originRef,
    workRef,
    workerId,
    runId,
    attemptNumber,
  }).lean();
  if (
    !result ||
    callbackRef(result.callbackId) !== traceIdentity.callbackRef ||
    normalizeText(result.resultState).toLowerCase() !== terminalState
  ) {
    throw Object.assign(new Error('glasshive_callback_terminal_result_mismatch'), {
      code: 'glasshive_callback_effect_fenced',
    });
  }
  return terminalCallbackReference({
    resultKey: result._id,
    acceptedOperationId: result.acceptedOperationId,
    callbackId: result.callbackId,
    resultDigest: result.resultDigest,
    resultRevision: result.resultRevision,
    generation: result.acceptedOperationGeneration,
  });
}

function traceEventForDestination({ body, deliveryContext, surface, traceIdentity }) {
  if (!traceIdentity) return '';
  const traceSurface = normalizeText(deliveryContext.traceSurface).toLowerCase();
  if (traceSurface && traceSurface !== surface) return '';
  const event = normalizeText(deliveryContext.traceCallbackEvent || body.event).toLowerCase();
  return deliveryTerminalState(event) ? event : '';
}

async function recordTraceDelivery(payload, status, at = new Date()) {
  const terminalState = deliveryTerminalState(payload?.event);
  const preRuntimeTerminal =
    payload?.attemptNumber == null &&
    payload?.traceIdentityVerified === true &&
    ['failed', 'cancelled'].includes(terminalState) &&
    ['run.failed', 'run.cancelled', 'run.interrupted'].includes(
      normalizeText(payload?.event).toLowerCase(),
    );
  if (
    !payload?.originRef ||
    !payload?.deliveryId ||
    !payload?.workRef ||
    !payload?.runId ||
    !/^callback_sha256:[a-f0-9]{64}$/.test(normalizeText(payload.callbackId)) ||
    (!preRuntimeTerminal &&
      (!Number.isSafeInteger(payload.attemptNumber) || payload.attemptNumber < 1)) ||
    !terminalState
  ) {
    return null;
  }
  return recordOrchestrationTraceDelivery({
    ownerId: normalizeText(payload.userId),
    originRef: normalizeText(payload.originRef),
    deliveryRef: normalizeText(payload.deliveryId),
    workRef: normalizeText(payload.workRef),
    runRef: normalizeText(payload.runId),
    callbackRef: normalizeText(payload.callbackId),
    callbackEvent: normalizeText(payload.event),
    state: terminalState,
    terminal: true,
    surface: normalizeText(payload.surface),
    status,
    at,
    attemptNumber: payload.attemptNumber,
  });
}

function traceStatusAt(payload, status, fallback) {
  const field = {
    pending: 'createdAt',
    claimed: 'claimedAt',
    sent: 'sentAt',
    failed: 'failedAt',
    suppressed: 'suppressedAt',
    unresolved: 'createdAt',
    delivery_unknown: 'unknownAt',
  }[status];
  const parsed = field && payload?.[field] ? new Date(payload[field]) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

async function queryLean(query, session = null) {
  const scoped = session && query?.session ? query.session(session) : query;
  return scoped?.lean ? scoped.lean() : scoped;
}

function workerCompletionPresentation(row) {
  const value = row?.workerCompletionPresentation;
  return value?.toObject ? value.toObject() : value || null;
}

function workerCompletionEffectLeases(row) {
  const presentation = workerCompletionPresentation(row);
  const values = Array.isArray(row?.workerCompletionEffectLeases)
    ? row.workerCompletionEffectLeases
    : [];
  if (!presentation || values.length !== presentation.bindings.length) return [];
  const leases = values.map((value) => (value?.toObject ? value.toObject() : value));
  const valid = presentation.bindings.every((binding, index) => {
    const lease = leases[index];
    return (
      lease?.resultKey === binding.resultKey &&
      lease?.acceptedOperationId === binding.acceptedOperationId &&
      Number(lease?.acceptedOperationGeneration) === Number(binding.effectGeneration) &&
      lease?.callbackId === binding.terminalCallbackId &&
      Number(lease?.resultRevision) === Number(binding.resultRevision) &&
      lease?.resultDigest === binding.resultDigest &&
      /^[a-f0-9]{32}$/.test(normalizeText(lease?.leaseId)) &&
      Number.isSafeInteger(Number(lease?.generation))
    );
  });
  return valid ? leases : [];
}

function workerCompletionPermitMatches(row, permit) {
  const leases = workerCompletionEffectLeases(row);
  const representative = leases[0];
  const expiresAt = row?.dispatchPermitExpiresAt ? new Date(row.dispatchPermitExpiresAt) : null;
  return Boolean(
    representative &&
    expiresAt &&
    expiresAt > nowDate() &&
    permit &&
    normalizeText(permit.deliveryId) === normalizeText(row.deliveryId) &&
    normalizeText(permit.claimId) === normalizeText(row.claimId) &&
    normalizeText(permit.surface) === normalizeText(row.surface) &&
    normalizeText(permit.permitId) === normalizeText(representative.leaseId) &&
    Number(permit.permitGeneration) === Number(representative.generation) &&
    Number(permit.resultRevision) === Number(representative.resultRevision) &&
    normalizeText(permit.resultDigest) === normalizeText(representative.resultDigest),
  );
}

async function assertWorkerCompletionBindingsAccepted({ ownerId, presentation }) {
  for (const binding of presentation.bindings) {
    const result = await queryLean(
      GlassHiveTerminalCallbackResult.findOne({
        _id: binding.resultKey,
        ownerId,
        originRef: binding.originRef,
        workRef: binding.workRef,
        workerId: binding.workerId,
        runId: binding.runId,
        attemptNumber: binding.attemptNumber,
        acceptedOperationId: binding.acceptedOperationId,
        acceptedOperationGeneration: binding.effectGeneration,
        callbackId: binding.terminalCallbackId,
        resultRevision: binding.resultRevision,
        resultDigest: binding.resultDigest,
      }),
    );
    if (!result) {
      throw Object.assign(new Error('voice_worker_completion_binding_superseded'), {
        code: 'glasshive_callback_effect_fenced',
      });
    }
  }
}

async function exactWorkerCompletionPresentation({
  body,
  deliveryContext,
  message,
  text,
  surface,
  destination,
  traceIdentity,
}) {
  const requested = deliveryContext.workerCompletionPresentation;
  if (surface !== 'voice' || normalizeText(body.event) !== 'main.followup' || !requested) {
    return null;
  }
  const authority = {
    ownerId: normalizeText(deliveryContext.ownerId),
    conversationId: normalizeText(deliveryContext.conversationId),
    callSessionId: normalizeText(destination.voiceCallSessionId),
    responseMessageId: normalizeText(message.messageId),
    responseText: normalizeText(text || message.text),
  };
  const representativeMatches = requested.bindings?.some(
    (binding) =>
      binding.originRef === normalizeText(deliveryContext.originRef || body.origin_ref) &&
      binding.workRef === normalizeText(deliveryContext.workRef || body.work_ref) &&
      binding.workerId === normalizeText(body.worker_id) &&
      binding.runId === normalizeText(body.run_id) &&
      binding.callbackRef === traceIdentity?.callbackRef &&
      binding.attemptNumber === traceIdentity?.attemptNumber,
  );
  if (!verifyVoiceWorkerCompletionPresentation(requested, authority) || !representativeMatches) {
    throw Object.assign(new Error('voice_worker_completion_presentation_invalid'), {
      code: 'voice_worker_completion_presentation_invalid',
    });
  }
  await assertWorkerCompletionBindingsAccepted({
    ownerId: authority.ownerId,
    presentation: requested,
  });
  return requested;
}

async function recordWorkerCompletionTrace({ delivery, presentation, stage }) {
  if (!delivery?.deliveryId || !presentation) return;
  for (const binding of presentation.bindings) {
    await recordVoiceOrchestrationTrace({
      ownerId: normalizeText(delivery.userId),
      callSessionId: presentation.callSessionId,
      turnId: presentation.turnId,
      eventRef: `${presentation.presentationRef}:${binding.workRef}:${stage}`,
      stage,
      facts: {
        workRef: binding.workRef,
        runRef: binding.runId,
        callbackRef: binding.callbackRef,
        deliveryRef: normalizeText(delivery.deliveryId),
        attemptRef: `${binding.runId}:${binding.attemptNumber}`,
        responseRef: presentation.responseMessageId,
        presentationRef: presentation.presentationRef,
        surface: 'voice',
        effectCount: 1,
      },
    });
  }
}

function aggregateSurfaceState(statuses, fallback) {
  if (statuses.has('delivery_unknown')) return 'unknown';
  if (statuses.has('unresolved')) return 'unresolved';
  if (statuses.has('failed')) return 'failed';
  if (statuses.has('pending') || statuses.has('claimed')) return 'enqueued';
  if (statuses.has('sent')) return 'sent';
  if (statuses.has('suppressed')) return 'suppressed';
  return fallback;
}

function initialDeliveryStatus({ resolved, suppress }) {
  if (!resolved) return 'unresolved';
  return suppress ? 'suppressed' : 'pending';
}

async function recordSurfaceOutcomeBestEffort(originRef, state) {
  if (!originRef) return false;
  const startedAt = nowDate();
  try {
    const rows = await ViventiumGlassHiveCallbackDelivery.find(
      { originRef },
      { status: 1, _id: 0 },
    ).lean();
    const statuses = new Set((Array.isArray(rows) ? rows : []).map((row) => row?.status));
    const aggregateState = aggregateSurfaceState(statuses, state);
    const { recordGlassHiveSurfaceDeliveryOutcome } = require('./GlassHiveCallbackBindingService');
    await recordGlassHiveSurfaceDeliveryOutcome({ originRef, state: aggregateState });
    await ViventiumGlassHiveCallbackDelivery.updateMany(
      {
        originRef,
        $or: [
          { projectionPendingAt: { $lte: startedAt } },
          { projectionPendingAt: null, projectionAppliedAt: null },
        ],
      },
      {
        $set: {
          projectionPendingAt: null,
          projectionAppliedAt: startedAt,
          projectionNextAttemptAt: null,
          projectionAttempts: 0,
          projectionErrorCode: '',
        },
      },
    );
    return true;
  } catch (error) {
    const code = normalizeText(error?.code || error?.name || 'projection_failed').slice(0, 120);
    await ViventiumGlassHiveCallbackDelivery.updateMany(
      { originRef },
      {
        $set: {
          projectionPendingAt: startedAt,
          projectionNextAttemptAt: new Date(startedAt.getTime() + PROJECTION_RETRY_MS),
          projectionErrorCode: code,
        },
        $inc: { projectionAttempts: 1 },
      },
    );
    logger.warn('[VIVENTIUM][glasshive-delivery] Core work projection update failed', {
      state,
      code,
    });
    return false;
  }
}

async function enqueueGlassHiveCallbackDelivery({
  body,
  message,
  text,
  fullText,
  deliveryContext = {},
  suppress = false,
  effectFence,
  effectSession,
}) {
  const destinations = externalDestinations(deliveryContext);
  const summary = { configured: destinations.length, enqueued: 0, unresolved: 0, deliveries: [] };
  if (!message || destinations.length === 0) return summary;
  if (!suppress && deliveryContext?.destinations && !shouldDispatchNeutralStatus(body)) {
    return { ...summary, deferredToMain: true };
  }
  const callbackMessageId = normalizeText(message.messageId);
  const userId = normalizeText(deliveryContext.ownerId || body.user_id);
  const conversationId = normalizeText(deliveryContext.conversationId || body.conversation_id);
  const event = normalizeText(body.event);
  if (!callbackMessageId || !userId || !conversationId || !event) return summary;

  const traceIdentity = callbackTraceIdentity(body, deliveryContext);
  const callbackId = traceIdentity?.callbackRef || callbackRef(body.callback_id);
  const callbackKey = normalizeText(message?.metadata?.viventium?.callbackKey);
  const originRef = normalizeText(deliveryContext.originRef || body.origin_ref);
  const now = nowDate();
  const expiresAt = new Date(now.getTime() + DELIVERY_RETENTION_MS);
  const preview = normalizeText(text || message.text);
  // The callback route sanitizes/redacts `fullText` before enqueueing. Do not
  // fall back to raw callback payload text here, because that can contain local
  // paths or other machine-private details that should never enter the ledger.
  const completeText = normalizeText(fullText || preview);
  const callbackReference = await acceptedTerminalCallbackReference({
    effectFence,
    body,
    deliveryContext,
    traceIdentity,
  });

  for (const destination of destinations) {
    const surface = normalizeText(destination.surface).toLowerCase();
    const resolved = destinationResolved(destination);
    const traceEvent = traceEventForDestination({
      body,
      deliveryContext,
      surface,
      traceIdentity,
    });
    const presentation = await exactWorkerCompletionPresentation({
      body,
      deliveryContext,
      message,
      text: preview,
      surface,
      destination,
      traceIdentity,
    });
    const deliveryKey = deliveryKeyFor({
      ownerId: userId,
      originRef,
      surface,
      callbackId,
      callbackKey,
      callbackMessageId,
      event,
      attemptNumber: traceIdentity?.attemptNumber,
    });
    const priorDeliveryKey = deliveryKeyFor({
      ownerId: userId,
      originRef,
      surface,
      callbackId,
      callbackKey,
      callbackMessageId,
      event,
    });
    const legacyDeliveryKey = legacyDeliveryKeyFor({
      surface,
      callbackId,
      callbackKey,
      callbackMessageId,
      event,
    });
    const ownerScopedDeliveryKeys = [...new Set([deliveryKey, priorDeliveryKey])];
    const legacyOriginScopes = [{ originRef: { $exists: false } }, { originRef: '' }];
    if (originRef) legacyOriginScopes.push({ originRef });
    const deliveryId = deliveryIdFor(deliveryKey);
    try {
      const updated = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
        {
          $or: [
            ...ownerScopedDeliveryKeys.map((ownerScopedDeliveryKey) => ({
              deliveryKey: ownerScopedDeliveryKey,
              userId,
              originRef,
            })),
            {
              deliveryKey: legacyDeliveryKey,
              userId,
              $or: legacyOriginScopes,
            },
          ],
        },
        {
          $setOnInsert: {
            deliveryKey,
            deliveryId,
            callbackId,
            traceIdentityVerified: Boolean(traceEvent),
            callbackKey,
            callbackMessageId,
            originRef,
            workRef: normalizeText(deliveryContext.workRef || body.work_ref),
            userId,
            conversationId,
            requestedParentMessageId: normalizeText(
              deliveryContext.requestedParentMessageId || body.parent_message_id,
            ),
            anchorMessageId: normalizeText(deliveryContext.anchorMessageId || body.message_id),
            surface,
            event: traceEvent || event,
            workerId: normalizeText(body.worker_id),
            runId: normalizeText(body.run_id),
            status: initialDeliveryStatus({ resolved, suppress }),
            projectionPendingAt: now,
            projectionNextAttemptAt: now,
            ...(resolved && suppress ? { suppressedAt: now } : {}),
            telegramChatId: normalizeText(destination.telegramChatId),
            telegramUserId: normalizeText(destination.telegramUserId),
            telegramMessageId: normalizeText(destination.telegramMessageId),
            voiceCallSessionId: normalizeText(destination.voiceCallSessionId),
            voiceRequestId: normalizeText(destination.voiceRequestId),
            retryCount: 0,
            nextAttemptAt: resolved && !suppress ? now : null,
            unresolvedReason: resolved
              ? ''
              : normalizeText(destination.unresolvedReason || `${surface}_target_unresolved`).slice(
                  0,
                  240,
                ),
            ...terminalCallbackFields(callbackReference),
            ...(presentation ? { workerCompletionPresentation: presentation } : {}),
          },
          $set: {
            text: preview,
            fullText: completeText && completeText !== preview ? completeText : '',
            expiresAt,
          },
        },
        {
          new: true,
          upsert: true,
          setDefaultsOnInsert: true,
          ...(effectSession ? { session: effectSession } : {}),
        },
      ).lean();
      if (updated?.status === 'unresolved') summary.unresolved += 1;
      else summary.enqueued += 1;
      summary.deliveries.push(updated);
      const tracePayload = toDispatchPayload(updated);
      const traceStatus = updated?.status || 'pending';
      await recordTraceDelivery(
        tracePayload,
        traceStatus,
        traceStatusAt(tracePayload, traceStatus, now),
      );
      await recordWorkerCompletionTrace({
        delivery: updated,
        presentation,
        stage: 'response.completed',
      });
      logger.info(
        '[VIVENTIUM][glasshive-delivery] status=%s surface=%s delivery=%s event=%s',
        traceStatus,
        surface,
        deliveryId,
        event,
      );
    } catch (err) {
      logger.warn('[VIVENTIUM][glasshive-delivery] enqueue failed', {
        code: normalizeText(err?.code || err?.name || 'enqueue_failed').slice(0, 120),
      });
      throw err;
    }
  }
  if (summary.unresolved > 0) {
    logger.warn('[VIVENTIUM][glasshive-delivery] Terminal surface destination unresolved', {
      originRef,
      workRef: normalizeText(deliveryContext.workRef || body.work_ref),
      event,
      configured: summary.configured,
      enqueued: summary.enqueued,
      unresolved: summary.unresolved,
    });
    await recordSurfaceOutcomeBestEffort(originRef, 'unresolved');
  } else if (suppress && summary.enqueued > 0) {
    await recordSurfaceOutcomeBestEffort(originRef, 'suppressed');
  }
  return summary;
}

function claimFilter({ surface, callbackId, userId, voiceCallSessionId, now, maxRetries }) {
  const leaseExpired = {
    $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }],
  };
  const retryable = {
    $or: [
      { status: 'pending' },
      {
        status: 'failed',
        retryCount: { $lt: maxRetries },
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      {
        status: 'claimed',
        leaseExpiresAt: { $lte: now },
      },
    ],
  };
  const filter = {
    surface,
    $and: [leaseExpired, retryable],
  };
  if (callbackId) {
    filter.callbackId = callbackId;
  }
  if (userId) {
    filter.userId = userId;
  }
  if (voiceCallSessionId) {
    filter.voiceCallSessionId = voiceCallSessionId;
  }
  return filter;
}

async function claimPendingGlassHiveCallbackDeliveries({
  surface,
  limit = DEFAULT_LIMIT,
  leaseMs = DEFAULT_LEASE_MS,
  claimOwner = 'surface-dispatcher',
  callbackId = '',
  userId = '',
  voiceCallSessionId = '',
  maxRetries = DEFAULT_MAX_RETRIES,
} = {}) {
  const normalizedSurface = normalizeText(surface).toLowerCase();
  if (!normalizedSurface) {
    return [];
  }
  const safeLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 25));
  const safeLeaseMs = Math.max(5000, Math.min(Number(leaseMs) || DEFAULT_LEASE_MS, 10 * 60 * 1000));
  const claimed = [];

  if (normalizedSurface === 'telegram' || normalizedSurface === 'voice') {
    const now = nowDate();
    await ViventiumGlassHiveCallbackDelivery.updateMany(
      {
        surface: normalizedSurface,
        status: 'claimed',
        leaseExpiresAt: { $lte: now },
        $or: [
          { terminalCallbackResultKey: { $exists: false } },
          { terminalCallbackResultKey: '' },
          { terminalCallbackResultKey: null },
        ],
      },
      {
        $set: {
          status: 'delivery_unknown',
          unknownAt: now,
          projectionPendingAt: now,
          projectionNextAttemptAt: now,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          lastError: 'delivery_status_unknown_after_claim_expiry',
        },
      },
    );
  }

  for (let index = 0; index < safeLimit; index += 1) {
    const now = nowDate();
    const claimId = `claim_${crypto.randomUUID().replaceAll('-', '')}`;
    const doc = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
      claimFilter({
        surface: normalizedSurface,
        callbackId: normalizeText(callbackId),
        userId: normalizeText(userId),
        voiceCallSessionId: normalizeText(voiceCallSessionId),
        now,
        maxRetries: Math.max(1, Number(maxRetries) || DEFAULT_MAX_RETRIES),
      }),
      {
        $set: {
          status: 'claimed',
          claimId,
          claimOwner: normalizeText(claimOwner),
          claimedAt: now,
          leaseExpiresAt: new Date(now.getTime() + safeLeaseMs),
          lastError: '',
        },
      },
      { sort: { createdAt: 1 }, new: true },
    ).lean();
    if (!doc) {
      break;
    }
    claimed.push(toDispatchPayload(doc));
    if (callbackId) {
      break;
    }
  }
  if (claimed.length) {
    logger.info(
      '[VIVENTIUM][glasshive-delivery] claimed surface=%s count=%s',
      normalizedSurface,
      claimed.length,
    );
  }
  return claimed;
}

function deliveryConstraintFilter({ deliveryId, claimId, userId = '', voiceCallSessionId = '' }) {
  const filter = {
    deliveryId: normalizeText(deliveryId),
    claimId: normalizeText(claimId),
    status: 'claimed',
  };
  if (userId) {
    filter.userId = normalizeText(userId);
  }
  if (voiceCallSessionId) {
    filter.voiceCallSessionId = normalizeText(voiceCallSessionId);
  }
  return filter;
}

async function settleWorkerCompletion({ current, filter, dispatchPermit, status, updates }) {
  const presentation = workerCompletionPresentation(current);
  if (!presentation) return { handled: false };
  const leases = workerCompletionEffectLeases(current);
  if (!workerCompletionPermitMatches(current, dispatchPermit) || leases.length === 0) {
    return { handled: true, row: null };
  }
  const now = nowDate();
  const row = await runGlassHiveTerminalCallbackTransaction(async (session) => {
    const updated = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
      {
        ...filter,
        dispatchPermitId: normalizeText(current.dispatchPermitId),
        dispatchPermitGeneration: Number(current.dispatchPermitGeneration),
        dispatchPermitExpiresAt: { $gt: now },
      },
      {
        $set: {
          status,
          projectionPendingAt: now,
          projectionNextAttemptAt: now,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          dispatchPermitId: '',
          dispatchPermitGeneration: 0,
          dispatchPermitExpiresAt: null,
          workerCompletionEffectLeases: [],
          ...updates,
        },
      },
      { new: true, session },
    ).lean();
    if (!updated) return null;
    for (const lease of leases) {
      if (
        !(await fenceGlassHiveTerminalCallbackEffectTransaction({
          ResultModel: GlassHiveTerminalCallbackResult,
          lease,
          now,
          session,
        })) ||
        !(await releaseGlassHiveTerminalCallbackEffectLease({
          ResultModel: GlassHiveTerminalCallbackResult,
          lease,
          session,
        }))
      ) {
        throw new Error('glasshive_callback_delivery_dispatch_fenced');
      }
    }
    return updated;
  });
  return { handled: true, row };
}

async function completeGlassHiveWorkerCompletionPresentation({
  deliveryId,
  claimId,
  dispatchPermit,
  presentationRef,
  userId = '',
  voiceCallSessionId = '',
}) {
  const filter = deliveryConstraintFilter({ deliveryId, claimId, userId, voiceCallSessionId });
  const current = await queryLean(ViventiumGlassHiveCallbackDelivery.findOne(filter));
  const presentation = workerCompletionPresentation(current);
  if (
    !presentation ||
    normalizeText(presentation.presentationRef) !== normalizeText(presentationRef) ||
    !workerCompletionPermitMatches(current, dispatchPermit)
  ) {
    return null;
  }
  const response = await queryLean(
    Message.findOne({
      user: normalizeText(current.userId),
      conversationId: normalizeText(current.conversationId),
      messageId: normalizeText(presentation.responseMessageId),
    }),
  );
  if (
    !response ||
    !verifyVoiceWorkerCompletionPresentation(presentation, {
      ownerId: normalizeText(current.userId),
      conversationId: normalizeText(current.conversationId),
      callSessionId: normalizeText(current.voiceCallSessionId),
      responseMessageId: normalizeText(response.messageId),
      responseText: normalizeText(response.text),
    })
  ) {
    return null;
  }
  const settled = await settleWorkerCompletion({
    current,
    filter,
    dispatchPermit,
    status: 'sent',
    updates: {
      sentAt: nowDate(),
      workerCompletionTtsCompletedAt: nowDate(),
      workerCompletionAudioCompletedAt: nowDate(),
      lastError: '',
    },
  });
  const payload = toDispatchPayload(settled.row);
  if (!payload) return null;
  await recordWorkerCompletionTrace({ delivery: payload, presentation, stage: 'tts.completed' });
  await recordWorkerCompletionTrace({ delivery: payload, presentation, stage: 'audio.completed' });
  await recordSurfaceOutcomeBestEffort(payload.originRef, 'sent');
  return payload;
}

async function markGlassHiveCallbackDeliverySent({
  deliveryId,
  claimId,
  dispatchPermit = null,
  userId = '',
  voiceCallSessionId = '',
  telegramMessageIds = [],
}) {
  const fenced = await callbackDeliveryDispatch.settleGlassHiveCallbackDeliverySent({
    deliveryId,
    claimId,
    dispatchPermit,
    userId,
    voiceCallSessionId,
    telegramMessageIds,
  });
  if (fenced.handled) {
    const payload = toDispatchPayload(fenced.row);
    if (payload) {
      await recordTraceDelivery(payload, 'sent', nowDate());
      await recordSurfaceOutcomeBestEffort(payload.originRef, 'sent');
    }
    return payload;
  }
  const now = nowDate();
  const messageIds = normalizeTelegramMessageIds(telegramMessageIds);
  const doc = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
    deliveryConstraintFilter({ deliveryId, claimId, userId, voiceCallSessionId }),
    {
      $set: {
        status: 'sent',
        sentAt: now,
        projectionPendingAt: now,
        projectionNextAttemptAt: now,
        leaseExpiresAt: null,
        lastError: '',
        ...(messageIds.length
          ? {
              telegramSentMessageIds: messageIds,
              telegramMessageId: messageIds[messageIds.length - 1],
              transportReceiptVersion: 1,
            }
          : {}),
      },
    },
    { new: true },
  ).lean();
  const payload = toDispatchPayload(doc);
  if (payload) {
    await recordTraceDelivery(payload, 'sent', now);
    await recordSurfaceOutcomeBestEffort(payload.originRef, 'sent');
    logger.info(
      '[VIVENTIUM][glasshive-delivery] status=sent surface=%s delivery=%s event=%s retry=%s',
      payload.surface,
      payload.deliveryId,
      payload.event,
      payload.retryCount,
    );
  }
  return payload;
}

async function markGlassHiveCallbackDeliveryUnknown({
  deliveryId,
  claimId,
  dispatchPermit = null,
  reason = 'delivery_status_unknown',
  userId = '',
  voiceCallSessionId = '',
}) {
  const lastError = redactDeliveryError(reason).slice(0, MAX_LAST_ERROR_LENGTH);
  const filter = deliveryConstraintFilter({ deliveryId, claimId, userId, voiceCallSessionId });
  const current = await queryLean(ViventiumGlassHiveCallbackDelivery.findOne(filter));
  const grouped = await settleWorkerCompletion({
    current,
    filter,
    dispatchPermit,
    status: 'delivery_unknown',
    updates: { unknownAt: nowDate(), lastError },
  });
  if (grouped.handled) {
    const payload = toDispatchPayload(grouped.row);
    if (payload) await recordSurfaceOutcomeBestEffort(payload.originRef, 'unknown');
    return payload;
  }
  const fenced = await callbackDeliveryDispatch.settleGlassHiveCallbackDeliveryUnknown({
    deliveryId,
    claimId,
    dispatchPermit,
    userId,
    voiceCallSessionId,
    lastError,
  });
  if (!fenced.handled) return null;
  const payload = toDispatchPayload(fenced.row);
  if (payload) {
    await recordTraceDelivery(payload, 'delivery_unknown', nowDate());
    await recordSurfaceOutcomeBestEffort(payload.originRef, 'unknown');
  }
  return payload;
}

async function markGlassHiveCallbackDeliverySuppressed({
  deliveryId,
  claimId,
  reason = '',
  userId = '',
  voiceCallSessionId = '',
}) {
  const now = nowDate();
  const doc = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
    deliveryConstraintFilter({ deliveryId, claimId, userId, voiceCallSessionId }),
    {
      $set: {
        status: 'suppressed',
        suppressedAt: now,
        leaseExpiresAt: null,
        projectionPendingAt: now,
        projectionNextAttemptAt: now,
        lastError: redactDeliveryError(reason).slice(0, MAX_LAST_ERROR_LENGTH),
      },
    },
    { new: true },
  ).lean();
  const payload = toDispatchPayload(doc);
  if (payload) {
    logger.info(
      '[VIVENTIUM][glasshive-delivery] status=suppressed surface=%s delivery=%s event=%s retry=%s',
      payload.surface,
      payload.deliveryId,
      payload.event,
      payload.retryCount,
    );
    await recordSurfaceOutcomeBestEffort(payload.originRef, 'suppressed');
  }
  return payload;
}

async function markGlassHiveCallbackDeliveryFailed({
  deliveryId,
  claimId,
  dispatchPermit = null,
  error = '',
  userId = '',
  voiceCallSessionId = '',
  maxRetries = DEFAULT_MAX_RETRIES,
}) {
  const existing = await ViventiumGlassHiveCallbackDelivery.findOne({
    ...deliveryConstraintFilter({ deliveryId, claimId, userId, voiceCallSessionId }),
  }).lean();
  if (!existing) {
    return null;
  }
  const now = nowDate();
  const grouped = await settleWorkerCompletion({
    current: existing,
    filter: deliveryConstraintFilter({ deliveryId, claimId, userId, voiceCallSessionId }),
    dispatchPermit,
    status: 'failed',
    updates: {
      failedAt: now,
      lastError: redactDeliveryError(error || 'delivery failed').slice(0, MAX_LAST_ERROR_LENGTH),
    },
  });
  if (grouped.handled) {
    const payload = toDispatchPayload(grouped.row);
    if (payload) await recordSurfaceOutcomeBestEffort(payload.originRef, 'failed');
    return payload;
  }
  const retryCount = Math.max(0, Number(existing.retryCount) || 0) + 1;
  const exhausted = retryCount >= Math.max(1, Number(maxRetries) || DEFAULT_MAX_RETRIES);
  const doc = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
    { deliveryId: existing.deliveryId, claimId: existing.claimId, status: 'claimed' },
    {
      $set: {
        status: 'failed',
        failedAt: now,
        leaseExpiresAt: null,
        projectionPendingAt: now,
        projectionNextAttemptAt: now,
        retryCount,
        nextAttemptAt: exhausted ? null : new Date(now.getTime() + retryDelayMs(retryCount)),
        lastError: redactDeliveryError(error || 'delivery failed').slice(0, MAX_LAST_ERROR_LENGTH),
      },
    },
    { new: true },
  ).lean();
  const payload = toDispatchPayload(doc);
  if (payload) {
    logger.info(
      '[VIVENTIUM][glasshive-delivery] status=failed surface=%s delivery=%s event=%s retry=%s exhausted=%s',
      payload.surface,
      payload.deliveryId,
      payload.event,
      payload.retryCount,
      exhausted,
    );
    await recordSurfaceOutcomeBestEffort(payload.originRef, 'failed');
  }
  return payload;
}

async function reconcileUnresolvedGlassHiveCallbackDeliveries({ userId = '', limit = 25 } = {}) {
  const normalizedUserId = normalizeText(userId);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
  const rows = await ViventiumGlassHiveCallbackDelivery.find({
    status: 'unresolved',
    surface: 'telegram',
    ...(normalizedUserId ? { userId: normalizedUserId } : {}),
  })
    .sort({ createdAt: 1 })
    .limit(safeLimit)
    .lean();
  const mappingByOwner = new Map();
  const repairedOrigins = new Map();
  let repaired = 0;
  let pending = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const ownerId = normalizeText(row?.userId);
    if (!ownerId) {
      pending += 1;
      continue;
    }
    if (!mappingByOwner.has(ownerId)) {
      mappingByOwner.set(
        ownerId,
        await resolveTelegramMappingByUserId({ libreChatUserId: ownerId }),
      );
    }
    const mapping = mappingByOwner.get(ownerId);
    const telegramUserId = normalizeText(mapping?.telegramUserId);
    const telegramChatId = normalizeText(mapping?.telegramChatId || telegramUserId);
    if (!telegramUserId || !telegramChatId) {
      pending += 1;
      continue;
    }
    const now = nowDate();
    const updated = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
      {
        deliveryId: normalizeText(row.deliveryId),
        userId: ownerId,
        surface: 'telegram',
        status: 'unresolved',
      },
      {
        $set: {
          status: 'pending',
          projectionPendingAt: now,
          projectionNextAttemptAt: now,
          telegramUserId,
          telegramChatId,
          nextAttemptAt: now,
          leaseExpiresAt: null,
          lastError: '',
          unresolvedReason: '',
        },
      },
      { new: true },
    ).lean();
    if (!updated) {
      pending += 1;
      continue;
    }
    repaired += 1;
    const originRef = normalizeText(updated.originRef || row.originRef);
    if (originRef) repairedOrigins.set(originRef, updated);
  }
  await Promise.all(
    [...repairedOrigins].map(([originRef]) =>
      recordSurfaceOutcomeBestEffort(originRef, 'enqueued'),
    ),
  );
  return { scanned: Array.isArray(rows) ? rows.length : 0, repaired, pending };
}

async function reconcileGlassHiveSurfaceDeliveryProjections({ limit = 25 } = {}) {
  const now = nowDate();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
  const rows = await ViventiumGlassHiveCallbackDelivery.find({
    originRef: { $type: 'string', $ne: '' },
    status: { $in: PROJECTABLE_DELIVERY_STATES },
    $or: [
      {
        projectionPendingAt: { $ne: null },
        $or: [{ projectionNextAttemptAt: null }, { projectionNextAttemptAt: { $lte: now } }],
      },
      { projectionPendingAt: null, projectionAppliedAt: null },
    ],
  })
    .sort({ projectionNextAttemptAt: 1, projectionPendingAt: 1, updatedAt: 1 })
    .limit(safeLimit)
    .lean();
  const origins = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const originRef = normalizeText(row?.originRef);
    if (originRef && !origins.has(originRef)) origins.set(originRef, row);
  }
  let projected = 0;
  let pending = 0;
  for (const [originRef, row] of origins) {
    if (await recordSurfaceOutcomeBestEffort(originRef, row.status)) projected += 1;
    else pending += 1;
  }
  return { scanned: Array.isArray(rows) ? rows.length : 0, projected, pending };
}

async function deliveryBacklogSummary({ surface = '', olderThanMs = 5 * 60 * 1000 } = {}) {
  const now = nowDate();
  const threshold = new Date(now.getTime() - Math.max(0, Number(olderThanMs) || 0));
  const filter = {
    status: { $in: ['pending', 'claimed', 'failed', 'delivery_unknown'] },
    createdAt: { $lte: threshold },
  };
  if (surface) {
    filter.surface = normalizeText(surface).toLowerCase();
  }
  const count = await ViventiumGlassHiveCallbackDelivery.countDocuments(filter);
  const oldest = await ViventiumGlassHiveCallbackDelivery.findOne(filter)
    .sort({ createdAt: 1 })
    .select('deliveryId surface status event createdAt retryCount lastError')
    .lean();
  return { count, oldest: oldest || null };
}

module.exports = {
  authorizeGlassHiveCallbackDeliveryDispatch:
    callbackDeliveryDispatch.authorizeGlassHiveCallbackDeliveryDispatch,
  completeGlassHiveWorkerCompletionPresentation,
  enqueueGlassHiveCallbackDelivery,
  claimPendingGlassHiveCallbackDeliveries,
  markGlassHiveCallbackDeliverySent,
  markGlassHiveCallbackDeliveryFailed,
  markGlassHiveCallbackDeliverySuppressed,
  markGlassHiveCallbackDeliveryUnknown,
  reconcileUnresolvedGlassHiveCallbackDeliveries,
  reconcileGlassHiveSurfaceDeliveryProjections,
  deliveryBacklogSummary,
  releaseGlassHiveCallbackDeliveryDispatch:
    callbackDeliveryDispatch.releaseGlassHiveCallbackDeliveryDispatch,
  renewGlassHiveCallbackDeliveryDispatch:
    callbackDeliveryDispatch.renewGlassHiveCallbackDeliveryDispatch,
  toDispatchPayload,
  redactDeliveryError,
};
