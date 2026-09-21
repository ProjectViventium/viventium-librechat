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
  fenceGlassHiveTerminalCallbackAcceptedOperation,
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
const DEFAULT_DISPATCH_PERMIT_MS = 60_000;
const MIN_DISPATCH_PERMIT_MS = 5_000;
const MAX_DISPATCH_PERMIT_MS = 5 * 60_000;
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

function nowDate() {
  return new Date();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function terminalCallbackReference(effectFence) {
  if (!effectFence) return null;
  const reference = {
    resultKey: normalizeText(effectFence.resultKey).slice(0, 80),
    acceptedOperationId: normalizeText(effectFence.acceptedOperationId).slice(0, 64),
    callbackId: normalizeText(effectFence.callbackId).slice(0, 80),
    resultDigest: normalizeText(effectFence.resultDigest).slice(0, 80),
    resultRevision: Number(effectFence.resultRevision),
    generation: Number(effectFence.acceptedOperationGeneration ?? effectFence.generation),
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

function persistedTerminalCallbackReference(row) {
  if (!normalizeText(row?.terminalCallbackResultKey)) return null;
  return terminalCallbackReference({
    resultKey: row.terminalCallbackResultKey,
    acceptedOperationId: row.terminalCallbackAcceptedOperationId,
    callbackId: row.terminalCallbackId,
    resultDigest: row.terminalCallbackResultDigest,
    resultRevision: row.terminalCallbackResultRevision,
    generation: row.terminalCallbackEffectGeneration,
  });
}

function plainWorkerCompletionPresentation(row) {
  const value = row?.workerCompletionPresentation;
  if (!value) return null;
  if (typeof value.toObject === 'function') {
    return value.toObject({ depopulate: true, versionKey: false });
  }
  return value;
}

function workerCompletionReference(binding) {
  return terminalCallbackReference({
    resultKey: binding?.resultKey,
    acceptedOperationId: binding?.acceptedOperationId,
    callbackId: binding?.terminalCallbackId,
    resultDigest: binding?.resultDigest,
    resultRevision: binding?.resultRevision,
    generation: binding?.effectGeneration,
  });
}

function workerCompletionLease(value) {
  const reference = terminalCallbackReference(value);
  const leaseId = normalizeText(value?.leaseId);
  const generation = Number(value?.generation);
  if (!/^[a-f0-9]{32}$/.test(leaseId) || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('voice_worker_completion_effect_lease_invalid');
  }
  return {
    ...reference,
    acceptedOperationGeneration: reference.generation,
    leaseId,
    generation,
  };
}

function workerCompletionEffectLeases(row) {
  const presentation = plainWorkerCompletionPresentation(row);
  if (!presentation) return null;
  const stored = Array.isArray(row?.workerCompletionEffectLeases)
    ? row.workerCompletionEffectLeases
    : [];
  if (stored.length !== presentation.bindings.length) return null;
  try {
    const leases = stored.map(workerCompletionLease);
    const byResultKey = new Map(leases.map((lease) => [lease.resultKey, lease]));
    if (byResultKey.size !== leases.length) return null;
    for (const binding of presentation.bindings) {
      const reference = workerCompletionReference(binding);
      const lease = byResultKey.get(reference.resultKey);
      if (
        !lease ||
        lease.acceptedOperationId !== reference.acceptedOperationId ||
        lease.acceptedOperationGeneration !== reference.generation ||
        lease.callbackId !== reference.callbackId ||
        lease.resultRevision !== reference.resultRevision ||
        lease.resultDigest !== reference.resultDigest
      ) {
        return null;
      }
    }
    return leases;
  } catch (_error) {
    return null;
  }
}

function representativeWorkerCompletionLease(row, leases) {
  const reference = persistedTerminalCallbackReference(row);
  if (!reference || !Array.isArray(leases)) return null;
  return (
    leases.find(
      (lease) =>
        lease.resultKey === reference.resultKey &&
        lease.acceptedOperationId === reference.acceptedOperationId &&
        lease.acceptedOperationGeneration === reference.generation &&
        lease.callbackId === reference.callbackId &&
        lease.resultRevision === reference.resultRevision &&
        lease.resultDigest === reference.resultDigest,
    ) || null
  );
}

async function queryLean(query, session = null) {
  const scoped = session && typeof query?.session === 'function' ? query.session(session) : query;
  return typeof scoped?.lean === 'function' ? scoped.lean() : scoped;
}

async function exactCanonicalWorkerCompletionPresentation(row, session = null) {
  const presentation = plainWorkerCompletionPresentation(row);
  if (!presentation || normalizeText(row?.surface) !== 'voice') return null;
  const response = await queryLean(
    Message.findOne({
      user: normalizeText(row?.userId),
      conversationId: normalizeText(row?.conversationId),
      messageId: normalizeText(presentation.responseMessageId),
      isCreatedByUser: { $ne: true },
    }),
    session,
  );
  const authority = {
    ownerId: normalizeText(row?.userId),
    conversationId: normalizeText(row?.conversationId),
    callSessionId: normalizeText(row?.voiceCallSessionId),
    responseMessageId: normalizeText(response?.messageId),
    responseText: normalizeText(response?.text),
  };
  if (
    normalizeText(row?.callbackMessageId) !== authority.responseMessageId ||
    normalizeText(row?.voiceRequestId) !== normalizeText(presentation.turnId) ||
    !verifyVoiceWorkerCompletionPresentation(presentation, authority)
  ) {
    return null;
  }
  return presentation;
}

async function workerCompletionLeasesAreCurrent(row, leases, now, session = null) {
  if (!Array.isArray(leases) || leases.length < 1) return false;
  for (const lease of leases) {
    const query = GlassHiveTerminalCallbackResult.exists({
      _id: lease.resultKey,
      acceptedOperationId: lease.acceptedOperationId,
      acceptedOperationGeneration: lease.acceptedOperationGeneration,
      callbackId: lease.callbackId,
      resultRevision: lease.resultRevision,
      resultDigest: lease.resultDigest,
      effectLeaseId: lease.leaseId,
      effectLeaseGeneration: lease.generation,
      effectLeaseExpiresAt: { $gt: now },
    });
    const current =
      session && typeof query?.session === 'function' ? await query.session(session) : await query;
    if (!current) return false;
  }
  return true;
}

function dispatchPermitDuration(value) {
  return Math.max(
    MIN_DISPATCH_PERMIT_MS,
    Math.min(Number(value) || DEFAULT_DISPATCH_PERMIT_MS, MAX_DISPATCH_PERMIT_MS),
  );
}

function dispatchPermitLease(row) {
  const reference = persistedTerminalCallbackReference(row);
  const leaseId = normalizeText(row?.dispatchPermitId);
  const generation = Number(row?.dispatchPermitGeneration);
  if (!reference || !/^[a-f0-9]{32}$/.test(leaseId) || !Number.isSafeInteger(generation)) {
    return null;
  }
  const lease = {
    resultKey: reference.resultKey,
    acceptedOperationId: reference.acceptedOperationId,
    acceptedOperationGeneration: reference.generation,
    leaseId,
    generation,
    resultRevision: reference.resultRevision,
    callbackId: reference.callbackId,
    resultDigest: reference.resultDigest,
  };
  if (plainWorkerCompletionPresentation(row)) {
    const aggregate = workerCompletionEffectLeases(row);
    const representative = representativeWorkerCompletionLease(row, aggregate);
    if (
      !representative ||
      representative.leaseId !== lease.leaseId ||
      representative.generation !== lease.generation
    ) {
      return null;
    }
  }
  return lease;
}

function toDispatchPermit(row) {
  const lease = dispatchPermitLease(row);
  const expiresAt = row?.dispatchPermitExpiresAt
    ? new Date(row.dispatchPermitExpiresAt).toISOString()
    : '';
  if (!lease || !expiresAt) return null;
  return {
    deliveryId: normalizeText(row.deliveryId),
    claimId: normalizeText(row.claimId),
    surface: normalizeText(row.surface),
    permitId: lease.leaseId,
    permitGeneration: lease.generation,
    expiresAt,
    resultRevision: lease.resultRevision,
    resultDigest: lease.resultDigest,
  };
}

function presentedDispatchPermitMatches(row, permit) {
  const current = toDispatchPermit(row);
  if (!current || !permit || typeof permit !== 'object' || Array.isArray(permit)) return false;
  return (
    normalizeText(permit.deliveryId) === current.deliveryId &&
    normalizeText(permit.claimId) === current.claimId &&
    normalizeText(permit.surface) === current.surface &&
    normalizeText(permit.permitId) === current.permitId &&
    Number(permit.permitGeneration) === current.permitGeneration &&
    Number(permit.resultRevision) === current.resultRevision &&
    normalizeText(permit.resultDigest) === current.resultDigest
  );
}

async function transactionallyFencePersistedDelivery(operation, candidate) {
  const candidateReference = persistedTerminalCallbackReference(candidate);
  if (!candidateReference) {
    return operation(null);
  }
  let result = null;
  await runGlassHiveTerminalCallbackTransaction(async (session) => {
    result = await operation(session);
    const reference = persistedTerminalCallbackReference(result) || candidateReference;
    const current = await fenceGlassHiveTerminalCallbackAcceptedOperation({
      ResultModel: GlassHiveTerminalCallbackResult,
      reference,
      session,
    });
    if (!current) {
      throw Object.assign(new Error('glasshive_callback_delivery_superseded'), {
        code: 'glasshive_callback_delivery_superseded',
        deliveryId: normalizeText(result?.deliveryId),
      });
    }
  });
  return result;
}

async function markSupersededDelivery(deliveryId) {
  if (!deliveryId) return;
  await ViventiumGlassHiveCallbackDelivery.updateOne(
    {
      deliveryId,
      status: { $in: ['pending', 'failed', 'claimed', 'unresolved'] },
    },
    {
      $set: {
        status: 'superseded',
        leaseExpiresAt: null,
        dispatchPermitId: '',
        dispatchPermitGeneration: 0,
        dispatchPermitExpiresAt: null,
        nextAttemptAt: null,
        lastError: 'terminal_callback_revision_superseded',
      },
    },
  );
}

async function recordFencedDeliveryTrace(row, status, at) {
  const payload = toDispatchPayload(row);
  try {
    await transactionallyFencePersistedDelivery(async () => {
      await recordTraceDelivery(payload, status, traceStatusAt(payload, status, at));
      return row;
    }, row);
    return payload;
  } catch (error) {
    if (error?.code !== 'glasshive_callback_delivery_superseded') throw error;
    await markSupersededDelivery(error.deliveryId || normalizeText(row?.deliveryId));
    return null;
  }
}

function normalizeTelegramMessageIds(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [values])
        .map((value) => normalizeText(value).slice(0, 256))
        .filter(Boolean),
    ),
  ).slice(0, 32);
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
  // Callback ids are GlassHive-local, not globally unique authorization. Scope idempotency to the
  // trusted Core owner/origin so a colliding callback id can never reuse another account's row.
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

function callbackRef(value) {
  const normalized = normalizeText(value);
  return normalized ? canonicalizeGlassHiveCallbackRef(normalized) : '';
}

function callbackTraceIdentity(body = {}, deliveryContext = {}) {
  const trusted = deliveryContext?.traceIdentity;
  const trustedCallbackRef = normalizeText(trusted?.callbackRef);
  const event = normalizeText(deliveryContext?.traceCallbackEvent || body.event).toLowerCase();
  const preRuntimeTerminal =
    trusted?.attemptNumber == null &&
    body.attempt_number == null &&
    ['run.failed', 'run.cancelled', 'run.interrupted'].includes(event);
  const trustedAttemptNumber = preRuntimeTerminal ? null : Number(trusted?.attemptNumber);
  if (
    !/^callback_sha256:[a-f0-9]{64}$/.test(trustedCallbackRef) ||
    (!preRuntimeTerminal &&
      (!Number.isSafeInteger(trustedAttemptNumber) || Number(trustedAttemptNumber) < 1))
  ) {
    return null;
  }
  const callbackId = normalizeText(body.callback_id);
  const attemptNumber = preRuntimeTerminal ? null : Number(body.attempt_number);
  if (
    !callbackId ||
    (!preRuntimeTerminal && (!Number.isSafeInteger(attemptNumber) || Number(attemptNumber) < 1))
  )
    return null;
  const canonicalRef = callbackRef(callbackId);
  if (trustedCallbackRef !== canonicalRef || trustedAttemptNumber !== attemptNumber) {
    return null;
  }
  return Object.freeze({ callbackRef: trustedCallbackRef, attemptNumber: trustedAttemptNumber });
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
    terminalCallbackResultKey: delivery.terminalCallbackResultKey || '',
    terminalCallbackAcceptedOperationId: delivery.terminalCallbackAcceptedOperationId || '',
    terminalCallbackId: delivery.terminalCallbackId || '',
    terminalCallbackResultDigest: delivery.terminalCallbackResultDigest || '',
    terminalCallbackResultRevision: Number(delivery.terminalCallbackResultRevision) || 0,
    terminalCallbackEffectGeneration: Number(delivery.terminalCallbackEffectGeneration) || 0,
    workerCompletionPresentation: delivery.workerCompletionPresentation || null,
  };
}

function workerCompletionRepresentativeMatches({
  presentation,
  body,
  deliveryContext,
  traceIdentity,
}) {
  if (!presentation || !traceIdentity) return false;
  return presentation.bindings.some(
    (binding) =>
      binding.originRef === normalizeText(deliveryContext?.originRef || body?.origin_ref) &&
      binding.workRef === normalizeText(deliveryContext?.workRef || body?.work_ref) &&
      binding.workerId === normalizeText(body?.worker_id) &&
      binding.runId === normalizeText(body?.run_id) &&
      binding.callbackRef === traceIdentity.callbackRef &&
      binding.attemptNumber === traceIdentity.attemptNumber,
  );
}

async function assertWorkerCompletionBindingsAccepted({ ownerId, presentation, session = null }) {
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
      session,
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
  const requested = deliveryContext?.workerCompletionPresentation;
  if (surface !== 'voice' || normalizeText(body?.event) !== 'main.followup') return null;
  if (!isResolvedDestination(destination)) return null;
  const authority = {
    ownerId: normalizeText(deliveryContext?.ownerId),
    conversationId: normalizeText(deliveryContext?.conversationId),
    callSessionId: normalizeText(destination?.voiceCallSessionId),
    responseMessageId: normalizeText(message?.messageId),
    responseText: normalizeText(text || message?.text),
  };
  if (
    !verifyVoiceWorkerCompletionPresentation(requested, authority) ||
    !workerCompletionRepresentativeMatches({
      presentation: requested,
      body,
      deliveryContext,
      traceIdentity,
    })
  ) {
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

async function recordWorkerCompletionResponseTrace({ delivery, presentation }) {
  if (!delivery?.deliveryId || !presentation) return;
  for (const binding of presentation.bindings) {
    await recordVoiceOrchestrationTrace({
      ownerId: normalizeText(delivery.userId),
      callSessionId: presentation.callSessionId,
      turnId: presentation.turnId,
      eventRef: `${presentation.presentationRef}:${binding.workRef}`,
      stage: 'response.completed',
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

function deliveryTerminalState(event) {
  const normalized = normalizeText(event).toLowerCase();
  if (normalized === 'run.completed') return 'completed';
  if (normalized === 'run.failed') return 'failed';
  if (['run.cancelled', 'run.interrupted'].includes(normalized)) return 'cancelled';
  return '';
}

async function acceptedTerminalCallbackReference({
  effectFence,
  body,
  deliveryContext,
  traceIdentity,
}) {
  if (effectFence) return terminalCallbackReference(effectFence);
  const terminalState = deliveryTerminalState(deliveryContext?.traceCallbackEvent);
  const ownerId = normalizeText(deliveryContext?.ownerId);
  const originRef = normalizeText(deliveryContext?.originRef);
  const workRef = normalizeText(deliveryContext?.workRef);
  const workerId = normalizeText(body?.worker_id);
  const runId = normalizeText(body?.run_id);
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
    acceptedOperationGeneration: result.acceptedOperationGeneration,
  });
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
      (!Number.isSafeInteger(payload.attemptNumber) || payload.attemptNumber < 1))
  ) {
    return null;
  }
  if (!terminalState) return null;
  return recordOrchestrationTraceDelivery({
    ownerId: normalizeText(payload.userId),
    originRef: normalizeText(payload.originRef),
    deliveryRef: normalizeText(payload.deliveryId),
    workRef: normalizeText(payload.workRef),
    runRef: normalizeText(payload.runId),
    callbackRef: normalizeText(payload.callbackId || payload.callbackMessageId),
    callbackEvent: normalizeText(payload.event),
    state: terminalState,
    terminal: Boolean(terminalState),
    surface: normalizeText(payload.surface),
    status,
    at,
    attemptNumber: payload.attemptNumber,
  });
}

function traceStatusAt(payload, status, fallback) {
  const fieldByStatus = {
    pending: 'createdAt',
    claimed: 'claimedAt',
    sent: 'sentAt',
    failed: 'failedAt',
    suppressed: 'suppressedAt',
    unresolved: 'createdAt',
    delivery_unknown: 'unknownAt',
  };
  const value = payload?.[fieldByStatus[status]];
  const parsed = value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

function traceEventForDestination({ body, deliveryContext, surface, traceIdentity }) {
  if (!traceIdentity) return '';
  const traceSurface = normalizeText(deliveryContext?.traceSurface).toLowerCase();
  if (traceSurface && traceSurface !== surface) return '';
  const event = normalizeText(deliveryContext?.traceCallbackEvent || body.event).toLowerCase();
  return deliveryTerminalState(event) ? event : '';
}

function externalDestinations(deliveryContext = {}) {
  return (Array.isArray(deliveryContext.destinations) ? deliveryContext.destinations : []).filter(
    (destination) =>
      ['telegram', 'voice'].includes(normalizeText(destination?.surface).toLowerCase()),
  );
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

async function recordSurfaceOutcomeBestEffort(originRef, state, candidate = null) {
  if (!originRef) return false;
  const projectionStartedAt = nowDate();
  try {
    await transactionallyFencePersistedDelivery(async (session) => {
      const rows = await ViventiumGlassHiveCallbackDelivery.find(
        { originRef },
        { status: 1, _id: 0 },
      ).lean();
      const statuses = new Set((Array.isArray(rows) ? rows : []).map((row) => row?.status));
      const aggregateState = statuses.has('delivery_unknown')
        ? 'unknown'
        : statuses.has('unresolved')
          ? 'unresolved'
          : statuses.has('failed')
            ? 'failed'
            : statuses.has('pending') || statuses.has('claimed')
              ? 'enqueued'
              : statuses.has('sent')
                ? 'sent'
                : statuses.has('suppressed')
                  ? 'suppressed'
                  : state;
      const {
        recordGlassHiveSurfaceDeliveryOutcome,
      } = require('./GlassHiveCallbackBindingService');
      await recordGlassHiveSurfaceDeliveryOutcome({
        originRef,
        state: aggregateState,
        ...(session ? { effectSession: session } : {}),
      });
      const projectionFilter = {
        originRef,
        $or: [
          { projectionPendingAt: { $lte: projectionStartedAt } },
          { projectionPendingAt: null, projectionAppliedAt: null },
        ],
      };
      const projectionUpdate = {
        $set: {
          projectionPendingAt: null,
          projectionAppliedAt: projectionStartedAt,
          projectionNextAttemptAt: null,
          projectionAttempts: 0,
          projectionErrorCode: '',
        },
      };
      if (session) {
        await ViventiumGlassHiveCallbackDelivery.updateMany(projectionFilter, projectionUpdate, {
          session,
        });
      } else {
        await ViventiumGlassHiveCallbackDelivery.updateMany(projectionFilter, projectionUpdate);
      }
      return candidate;
    }, candidate);
    return true;
  } catch (error) {
    if (error?.code === 'glasshive_callback_delivery_superseded') {
      await markSupersededDelivery(error.deliveryId || normalizeText(candidate?.deliveryId));
      return false;
    }
    await ViventiumGlassHiveCallbackDelivery.updateMany(
      { originRef },
      {
        $set: {
          projectionPendingAt: candidate?.projectionPendingAt || projectionStartedAt,
          projectionNextAttemptAt: new Date(projectionStartedAt.getTime() + PROJECTION_RETRY_MS),
          projectionErrorCode: normalizeText(
            error?.code || error?.name || 'projection_failed',
          ).slice(0, 120),
        },
        $inc: { projectionAttempts: 1 },
      },
    );
    logger.warn('[VIVENTIUM][glasshive-delivery] Core work projection update failed', {
      state,
      code: normalizeText(error?.code || error?.name || 'projection_failed').slice(0, 120),
    });
    return false;
  }
}

function isResolvedDestination(destination = {}) {
  if (destination.unresolvedReason) return false;
  const surface = normalizeText(destination.surface).toLowerCase();
  if (surface === 'telegram') {
    return Boolean(
      normalizeText(destination.telegramChatId) || normalizeText(destination.telegramUserId),
    );
  }
  return surface === 'voice' && Boolean(normalizeText(destination.voiceCallSessionId));
}

async function enqueueGlassHiveCallbackDelivery({
  body,
  message,
  text,
  fullText,
  deliveryContext,
  suppress = false,
  effectFence,
  effectSession,
}) {
  const destinations = externalDestinations(deliveryContext);
  const summary = {
    configured: destinations.length,
    enqueued: 0,
    unresolved: 0,
    deliveries: [],
  };
  // Successful terminal prose is authored only by Main after the 2s account coalescing window.
  // Do not race that synthesis with a direct worker callback delivery. Failure/input/stop statuses
  // remain immediate, neutral, and actionable.
  if (!message || destinations.length === 0) {
    return summary;
  }
  if (!shouldDispatchNeutralStatus(body)) {
    return { ...summary, deferredToMain: true };
  }
  const callbackMessageId = normalizeText(message.messageId);
  const userId = normalizeText(deliveryContext?.ownerId);
  const conversationId = normalizeText(deliveryContext?.conversationId);
  const event = normalizeText(body.event);
  if (!callbackMessageId || !userId || !conversationId || !event) {
    return summary;
  }

  const traceIdentity = callbackTraceIdentity(body, deliveryContext);
  const callbackId = traceIdentity?.callbackRef || callbackRef(body.callback_id);
  const callbackKey = normalizeText(message?.metadata?.viventium?.callbackKey);
  const originRef = normalizeText(deliveryContext?.originRef || body.origin_ref);
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
    const resolved = isResolvedDestination(destination);
    const traceEvent = traceEventForDestination({
      body,
      deliveryContext,
      surface,
      traceIdentity,
    });
    const workerCompletionPresentation = await exactWorkerCompletionPresentation({
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
    const legacyDeliveryKey = legacyDeliveryKeyFor({
      surface,
      callbackId,
      callbackKey,
      callbackMessageId,
      event,
    });
    // Older rows used owner-scoped or surface-only keys. Never match a legacy key without the
    // authenticated owner and compatible origin: callback ids may collide across tenants.
    const persistedIdentityFilter = {
      $or: [
        { deliveryKey },
        {
          deliveryKey: `${userId}:${originRef}:${legacyDeliveryKey}`,
          userId,
          originRef,
        },
        {
          deliveryKey: legacyDeliveryKey,
          userId,
          $or: [{ originRef: { $exists: false } }, { originRef: '' }, { originRef }],
        },
      ],
    };
    const deliveryId = deliveryIdFor(deliveryKey);
    try {
      let updated = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
        persistedIdentityFilter,
        {
          $setOnInsert: {
            deliveryKey,
            deliveryId,
            callbackId,
            traceIdentityVerified: Boolean(traceEvent),
            callbackKey,
            callbackMessageId,
            originRef,
            workRef: normalizeText(deliveryContext?.workRef || body.work_ref),
            userId,
            conversationId,
            requestedParentMessageId: normalizeText(deliveryContext?.requestedParentMessageId),
            anchorMessageId: normalizeText(deliveryContext?.anchorMessageId),
            surface,
            event: traceEvent || event,
            workerId: normalizeText(body.worker_id),
            runId: normalizeText(body.run_id),
            status: resolved ? (suppress ? 'suppressed' : 'pending') : 'unresolved',
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
            ...(callbackReference
              ? {
                  terminalCallbackResultKey: callbackReference.resultKey,
                  terminalCallbackAcceptedOperationId: callbackReference.acceptedOperationId,
                  terminalCallbackId: callbackReference.callbackId,
                  terminalCallbackResultDigest: callbackReference.resultDigest,
                  terminalCallbackResultRevision: callbackReference.resultRevision,
                  terminalCallbackEffectGeneration: callbackReference.generation,
                }
              : {}),
            ...(workerCompletionPresentation ? { workerCompletionPresentation } : {}),
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

      // A later replay can repair an unresolved target after the user links the account/session.
      // Transition only the unresolved row; never regress claimed/sent/suppressed delivery.
      if (resolved && updated?.status === 'unresolved') {
        const persistedDeliveryKey = normalizeText(updated.deliveryKey) || deliveryKey;
        updated = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
          { deliveryKey: persistedDeliveryKey, userId, originRef, status: 'unresolved' },
          {
            $set: {
              status: suppress ? 'suppressed' : 'pending',
              projectionPendingAt: now,
              projectionNextAttemptAt: now,
              telegramChatId: normalizeText(destination.telegramChatId),
              telegramUserId: normalizeText(destination.telegramUserId),
              telegramMessageId: normalizeText(destination.telegramMessageId),
              voiceCallSessionId: normalizeText(destination.voiceCallSessionId),
              voiceRequestId: normalizeText(destination.voiceRequestId),
              nextAttemptAt: suppress ? null : now,
              lastError: '',
              unresolvedReason: '',
              expiresAt,
              ...(workerCompletionPresentation ? { workerCompletionPresentation } : {}),
            },
          },
          { new: true },
        ).lean();
      }

      // A crash/replay across the semantic-silence upgrade may find the same deterministic row in
      // pending state. Settle only that unsent row; claimed/sent rows remain authoritative.
      if (suppress && resolved && updated?.status === 'pending') {
        const persistedDeliveryKey = normalizeText(updated.deliveryKey) || deliveryKey;
        updated = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
          { deliveryKey: persistedDeliveryKey, userId, originRef, status: 'pending' },
          {
            $set: {
              status: 'suppressed',
              projectionPendingAt: now,
              projectionNextAttemptAt: now,
              suppressedAt: now,
              nextAttemptAt: null,
              lastError: '',
              expiresAt,
            },
          },
          { new: true },
        ).lean();
      }

      if (updated?.status === 'unresolved') {
        summary.unresolved += 1;
      } else {
        summary.enqueued += 1;
      }
      summary.deliveries.push(updated);
      const tracePayload = toDispatchPayload(updated);
      const traceStatus = updated?.status || 'pending';
      await recordTraceDelivery(
        tracePayload,
        traceStatus,
        traceStatusAt(tracePayload, traceStatus, now),
      );
      await recordWorkerCompletionResponseTrace({
        delivery: updated,
        presentation: workerCompletionPresentation,
      });
      if (updated?.status !== 'unresolved') {
        logger.info(
          '[VIVENTIUM][glasshive-delivery] status=%s surface=%s delivery=%s event=%s',
          updated?.status || 'pending',
          surface,
          deliveryId,
          event,
        );
      }
    } catch (err) {
      logger.warn('[VIVENTIUM][glasshive-delivery] enqueue failed:', err);
      throw err;
    }
  }
  if (summary.unresolved > 0) {
    const originRef = normalizeText(deliveryContext?.originRef || body.origin_ref);
    logger.warn('[VIVENTIUM][glasshive-delivery] Terminal surface destination unresolved', {
      originRef,
      workRef: normalizeText(deliveryContext?.workRef || body.work_ref),
      event,
      configured: summary.configured,
      enqueued: summary.enqueued,
      unresolved: summary.unresolved,
    });
    await recordSurfaceOutcomeBestEffort(
      originRef,
      'unresolved',
      summary.deliveries.find((delivery) => delivery?.terminalCallbackResultKey) || null,
    );
  } else if (suppress && summary.enqueued > 0) {
    const originRef = normalizeText(deliveryContext?.originRef || body.origin_ref);
    await recordSurfaceOutcomeBestEffort(
      originRef,
      'suppressed',
      summary.deliveries.find((delivery) => delivery?.terminalCallbackResultKey) || null,
    );
  }
  return summary;
}

function claimFilter({
  surface,
  callbackId,
  userId,
  voiceCallSessionId,
  now,
  maxRetries,
  retryExpiredClaims,
}) {
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
      ...(retryExpiredClaims
        ? [
            {
              status: 'claimed',
              leaseExpiresAt: { $lte: now },
            },
          ]
        : []),
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
          lastError: 'telegram_delivery_status_unknown_after_claim_expiry',
        },
      },
    );
    const expiredTerminalClaims = await ViventiumGlassHiveCallbackDelivery.find({
      surface: normalizedSurface,
      status: 'claimed',
      leaseExpiresAt: { $lte: now },
      terminalCallbackResultKey: { $type: 'string', $ne: '' },
      ...(normalizedSurface === 'voice' ? { dispatchPermitId: { $type: 'string', $ne: '' } } : {}),
    })
      .sort({ createdAt: 1 })
      .limit(safeLimit)
      .lean();
    for (const expired of expiredTerminalClaims) {
      await markGlassHiveCallbackDeliveryUnknown({
        deliveryId: expired.deliveryId,
        claimId: expired.claimId,
        userId: expired.userId,
        voiceCallSessionId: expired.voiceCallSessionId,
        reason: 'telegram_delivery_status_unknown_after_claim_expiry',
      });
    }
  }

  for (let index = 0; index < safeLimit; index += 1) {
    const now = nowDate();
    const claimId = `claim_${crypto.randomUUID().replaceAll('-', '')}`;
    const pendingFilter = claimFilter({
      surface: normalizedSurface,
      callbackId: callbackRef(callbackId),
      userId: normalizeText(userId),
      voiceCallSessionId: normalizeText(voiceCallSessionId),
      now,
      maxRetries: Math.max(1, Number(maxRetries) || DEFAULT_MAX_RETRIES),
      retryExpiredClaims: normalizedSurface !== 'telegram',
    });
    const candidateQuery = ViventiumGlassHiveCallbackDelivery.findOne(pendingFilter);
    const candidate = candidateQuery?.lean ? await candidateQuery.lean() : await candidateQuery;
    let doc;
    try {
      doc = await transactionallyFencePersistedDelivery(
        () =>
          ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
            pendingFilter,
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
          ).lean(),
        candidate,
      );
    } catch (error) {
      if (error?.code !== 'glasshive_callback_delivery_superseded') throw error;
      await markSupersededDelivery(error.deliveryId);
      index -= 1;
      continue;
    }
    if (!doc) {
      break;
    }
    const payload = await recordFencedDeliveryTrace(doc, 'claimed', now);
    if (!payload) {
      index -= 1;
      continue;
    }
    claimed.push(payload);
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

async function acquireWorkerCompletionDispatch({ current, now, durationMs, session }) {
  const presentation = await exactCanonicalWorkerCompletionPresentation(current, session);
  if (!presentation) throw new Error('voice_worker_completion_presentation_superseded');
  await assertWorkerCompletionBindingsAccepted({
    ownerId: normalizeText(current.userId),
    presentation,
    session,
  });
  const leases = [];
  for (const binding of presentation.bindings) {
    const lease = await acquireGlassHiveTerminalCallbackAcceptedOperationEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      reference: workerCompletionReference(binding),
      now,
      leaseDurationMs: durationMs,
      session,
    });
    if (!lease) throw new Error('glasshive_callback_delivery_dispatch_fenced');
    leases.push(lease);
  }
  const representative = representativeWorkerCompletionLease(current, leases);
  if (!representative) throw new Error('voice_worker_completion_representative_mismatch');
  return { leases, representative };
}

async function authorizeWorkerCompletionDispatch({ constraint, initial, now, durationMs }) {
  const existingExpiresAt = initial.dispatchPermitExpiresAt
    ? new Date(initial.dispatchPermitExpiresAt)
    : null;
  if (existingExpiresAt && existingExpiresAt > now) {
    const leases = workerCompletionEffectLeases(initial);
    if (
      dispatchPermitLease(initial) &&
      (await exactCanonicalWorkerCompletionPresentation(initial)) &&
      (await workerCompletionLeasesAreCurrent(initial, leases, now))
    ) {
      return toDispatchPermit(initial);
    }
  }

  let authorized = null;
  await runGlassHiveTerminalCallbackTransaction(async (session) => {
    const current = await ViventiumGlassHiveCallbackDelivery.findOne(constraint)
      .session(session)
      .lean();
    if (!current) throw new Error('glasshive_callback_delivery_claim_missing');
    const { leases, representative } = await acquireWorkerCompletionDispatch({
      current,
      now,
      durationMs,
      session,
    });
    const expiresAt = new Date(now.getTime() + durationMs);
    const row = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
      {
        ...constraint,
        $or: [
          { dispatchPermitId: '' },
          { dispatchPermitId: { $exists: false } },
          { dispatchPermitExpiresAt: null },
          { dispatchPermitExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          dispatchPermitId: representative.leaseId,
          dispatchPermitGeneration: representative.generation,
          dispatchPermitExpiresAt: expiresAt,
          workerCompletionEffectLeases: leases,
        },
      },
      { new: true, session },
    ).lean();
    if (!row) throw new Error('glasshive_callback_delivery_dispatch_claim_changed');
    authorized = toDispatchPermit(row);
    if (!authorized) throw new Error('glasshive_callback_delivery_dispatch_fenced');
  });
  return authorized;
}

async function authorizeGlassHiveCallbackDeliveryDispatch({
  deliveryId,
  claimId,
  userId = '',
  voiceCallSessionId = '',
  leaseMs = DEFAULT_DISPATCH_PERMIT_MS,
}) {
  const now = nowDate();
  const durationMs = dispatchPermitDuration(leaseMs);
  const constraint = deliveryConstraintFilter({
    deliveryId,
    claimId,
    userId,
    voiceCallSessionId,
  });
  const initial = await ViventiumGlassHiveCallbackDelivery.findOne(constraint).lean();
  if (!initial) return null;
  if (plainWorkerCompletionPresentation(initial)) {
    try {
      return await authorizeWorkerCompletionDispatch({ constraint, initial, now, durationMs });
    } catch (error) {
      if (
        [
          'voice_worker_completion_presentation_superseded',
          'voice_worker_completion_binding_superseded',
          'voice_worker_completion_representative_mismatch',
        ].includes(error?.message)
      ) {
        await markSupersededDelivery(normalizeText(initial.deliveryId));
        return null;
      }
      if (
        [
          'glasshive_callback_delivery_claim_missing',
          'glasshive_callback_delivery_dispatch_fenced',
          'glasshive_callback_delivery_dispatch_claim_changed',
        ].includes(error?.message)
      ) {
        return null;
      }
      throw error;
    }
  }
  const existingExpiresAt = initial.dispatchPermitExpiresAt
    ? new Date(initial.dispatchPermitExpiresAt)
    : null;
  if (existingExpiresAt && existingExpiresAt > now) {
    const existingLease = dispatchPermitLease(initial);
    if (existingLease) {
      const current = await GlassHiveTerminalCallbackResult.exists({
        _id: existingLease.resultKey,
        acceptedOperationId: existingLease.acceptedOperationId,
        acceptedOperationGeneration: existingLease.acceptedOperationGeneration,
        callbackId: existingLease.callbackId,
        resultRevision: existingLease.resultRevision,
        resultDigest: existingLease.resultDigest,
        effectLeaseId: existingLease.leaseId,
        effectLeaseGeneration: existingLease.generation,
        effectLeaseExpiresAt: { $gt: now },
      });
      if (current) return toDispatchPermit(initial);
    }
  }

  const reference = persistedTerminalCallbackReference(initial);
  if (!reference) return null;
  let authorized = null;
  try {
    await runGlassHiveTerminalCallbackTransaction(async (session) => {
      const current = await ViventiumGlassHiveCallbackDelivery.findOne(constraint)
        .session(session)
        .lean();
      if (!current) throw new Error('glasshive_callback_delivery_claim_missing');
      const lease = await acquireGlassHiveTerminalCallbackAcceptedOperationEffectLease({
        ResultModel: GlassHiveTerminalCallbackResult,
        reference: persistedTerminalCallbackReference(current),
        now,
        leaseDurationMs: durationMs,
        session,
      });
      if (!lease) throw new Error('glasshive_callback_delivery_dispatch_fenced');
      const expiresAt = new Date(now.getTime() + durationMs);
      const row = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
        {
          ...constraint,
          $or: [
            { dispatchPermitId: '' },
            { dispatchPermitId: { $exists: false } },
            { dispatchPermitExpiresAt: null },
            { dispatchPermitExpiresAt: { $lte: now } },
          ],
        },
        {
          $set: {
            dispatchPermitId: lease.leaseId,
            dispatchPermitGeneration: lease.generation,
            dispatchPermitExpiresAt: expiresAt,
          },
        },
        { new: true, session },
      ).lean();
      if (!row) throw new Error('glasshive_callback_delivery_dispatch_claim_changed');
      authorized = toDispatchPermit(row);
    });
  } catch (error) {
    const replay = await ViventiumGlassHiveCallbackDelivery.findOne(constraint).lean();
    const replayExpiresAt = replay?.dispatchPermitExpiresAt
      ? new Date(replay.dispatchPermitExpiresAt)
      : null;
    if (replayExpiresAt && replayExpiresAt > now) {
      const permit = toDispatchPermit(replay);
      if (permit) return permit;
    }
    const stillCurrent = await GlassHiveTerminalCallbackResult.exists({
      _id: reference.resultKey,
      acceptedOperationId: reference.acceptedOperationId,
      acceptedOperationGeneration: reference.generation,
      callbackId: reference.callbackId,
      resultRevision: reference.resultRevision,
      resultDigest: reference.resultDigest,
    });
    if (!stillCurrent) {
      await markSupersededDelivery(normalizeText(initial.deliveryId));
      return null;
    }
    if (error?.message === 'glasshive_callback_delivery_dispatch_fenced') return null;
    throw error;
  }
  return authorized;
}

async function renewGlassHiveCallbackDeliveryDispatch({
  deliveryId,
  claimId,
  dispatchPermit,
  userId = '',
  voiceCallSessionId = '',
  leaseMs = DEFAULT_DISPATCH_PERMIT_MS,
}) {
  const now = nowDate();
  const durationMs = dispatchPermitDuration(leaseMs);
  const constraint = deliveryConstraintFilter({
    deliveryId,
    claimId,
    userId,
    voiceCallSessionId,
  });
  let renewedPermit = null;
  try {
    await runGlassHiveTerminalCallbackTransaction(async (session) => {
      const current = await ViventiumGlassHiveCallbackDelivery.findOne({
        ...constraint,
        dispatchPermitExpiresAt: { $gt: now },
      })
        .session(session)
        .lean();
      if (!current || !presentedDispatchPermitMatches(current, dispatchPermit)) {
        throw new Error('glasshive_callback_delivery_dispatch_permit_invalid');
      }
      const presentation = plainWorkerCompletionPresentation(current);
      const leases = presentation
        ? workerCompletionEffectLeases(current)
        : [dispatchPermitLease(current)];
      if (
        (presentation && !(await exactCanonicalWorkerCompletionPresentation(current, session))) ||
        !Array.isArray(leases) ||
        leases.some((lease) => !lease)
      ) {
        throw new Error('glasshive_callback_delivery_dispatch_fenced');
      }
      for (const lease of leases) {
        const renewed = await renewGlassHiveTerminalCallbackEffectLease({
          ResultModel: GlassHiveTerminalCallbackResult,
          lease,
          now,
          leaseDurationMs: durationMs,
          session,
        });
        if (!renewed) throw new Error('glasshive_callback_delivery_dispatch_fenced');
      }
      const expiresAt = new Date(now.getTime() + durationMs);
      const row = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
        {
          ...constraint,
          dispatchPermitId: current.dispatchPermitId,
          dispatchPermitGeneration: current.dispatchPermitGeneration,
          dispatchPermitExpiresAt: { $gt: now },
        },
        { $set: { dispatchPermitExpiresAt: expiresAt } },
        { new: true, session },
      ).lean();
      if (!row) throw new Error('glasshive_callback_delivery_dispatch_claim_changed');
      renewedPermit = toDispatchPermit(row);
    });
  } catch (error) {
    if (
      [
        'glasshive_callback_delivery_dispatch_permit_invalid',
        'glasshive_callback_delivery_dispatch_fenced',
      ].includes(error?.message)
    ) {
      return null;
    }
    throw error;
  }
  return renewedPermit;
}

async function releaseGlassHiveCallbackDeliveryDispatch({
  deliveryId,
  claimId,
  dispatchPermit,
  userId = '',
  voiceCallSessionId = '',
}) {
  const constraint = deliveryConstraintFilter({
    deliveryId,
    claimId,
    userId,
    voiceCallSessionId,
  });
  let released = false;
  await runGlassHiveTerminalCallbackTransaction(async (session) => {
    const current = await ViventiumGlassHiveCallbackDelivery.findOne(constraint)
      .session(session)
      .lean();
    if (!current || !presentedDispatchPermitMatches(current, dispatchPermit)) return;
    const presentation = plainWorkerCompletionPresentation(current);
    const leases = presentation
      ? workerCompletionEffectLeases(current)
      : [dispatchPermitLease(current)];
    if (!Array.isArray(leases) || leases.some((lease) => !lease)) {
      throw new Error('glasshive_callback_delivery_dispatch_fenced');
    }
    for (const lease of leases) {
      const leaseReleased = await releaseGlassHiveTerminalCallbackEffectLease({
        ResultModel: GlassHiveTerminalCallbackResult,
        lease,
        session,
      });
      if (!leaseReleased) throw new Error('glasshive_callback_delivery_dispatch_fenced');
    }
    released = true;
    const cleared = await ViventiumGlassHiveCallbackDelivery.updateOne(
      {
        ...constraint,
        dispatchPermitId: current.dispatchPermitId,
        dispatchPermitGeneration: current.dispatchPermitGeneration,
      },
      {
        $set: {
          dispatchPermitId: '',
          dispatchPermitGeneration: 0,
          dispatchPermitExpiresAt: null,
          workerCompletionEffectLeases: [],
        },
      },
      { session },
    );
    if (cleared.matchedCount !== 1) {
      throw new Error('glasshive_callback_delivery_dispatch_claim_changed');
    }
  });
  return released;
}

function workerCompletionTraceFacts(delivery, presentation, binding) {
  return {
    workRef: binding.workRef,
    runRef: binding.runId,
    callbackRef: binding.callbackRef,
    deliveryRef: normalizeText(delivery.deliveryId),
    attemptRef: `${binding.runId}:${binding.attemptNumber}`,
    responseRef: presentation.responseMessageId,
    presentationRef: presentation.presentationRef,
    surface: 'voice',
    effectCount: 1,
  };
}

async function recordWorkerCompletionStageTrace({ delivery, presentation, stage, at }) {
  for (const binding of presentation.bindings) {
    await recordVoiceOrchestrationTrace({
      ownerId: normalizeText(delivery.userId),
      callSessionId: presentation.callSessionId,
      turnId: presentation.turnId,
      eventRef: `${presentation.presentationRef}:${binding.workRef}:${stage}`,
      stage,
      at,
      facts: workerCompletionTraceFacts(delivery, presentation, binding),
    });
  }
}

async function completeGlassHiveWorkerCompletionPresentation({
  deliveryId,
  claimId,
  dispatchPermit,
  presentationRef,
  userId = '',
  voiceCallSessionId = '',
}) {
  const now = nowDate();
  const constraint = deliveryConstraintFilter({
    deliveryId,
    claimId,
    userId,
    voiceCallSessionId,
  });
  let completed = null;
  try {
    await runGlassHiveTerminalCallbackTransaction(async (session) => {
      const current = await ViventiumGlassHiveCallbackDelivery.findOne({
        ...constraint,
        dispatchPermitExpiresAt: { $gt: now },
        workerCompletionTtsCompletedAt: null,
        workerCompletionAudioCompletedAt: null,
      })
        .session(session)
        .lean();
      const presentation = await exactCanonicalWorkerCompletionPresentation(current, session);
      const leases = workerCompletionEffectLeases(current);
      if (
        !current ||
        !presentation ||
        normalizeText(presentationRef) !== normalizeText(presentation.presentationRef) ||
        !presentedDispatchPermitMatches(current, dispatchPermit) ||
        !Array.isArray(leases) ||
        !(await workerCompletionLeasesAreCurrent(current, leases, now, session))
      ) {
        throw new Error('voice_worker_completion_settlement_invalid');
      }
      for (const lease of leases) {
        const fenced = await fenceGlassHiveTerminalCallbackEffectTransaction({
          ResultModel: GlassHiveTerminalCallbackResult,
          lease,
          session,
          now,
        });
        if (!fenced) throw new Error('glasshive_callback_delivery_dispatch_fenced');
      }
      completed = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
        {
          ...constraint,
          dispatchPermitId: current.dispatchPermitId,
          dispatchPermitGeneration: current.dispatchPermitGeneration,
          dispatchPermitExpiresAt: { $gt: now },
          workerCompletionTtsCompletedAt: null,
          workerCompletionAudioCompletedAt: null,
        },
        {
          $set: {
            status: 'sent',
            sentAt: now,
            workerCompletionTtsCompletedAt: now,
            workerCompletionAudioCompletedAt: now,
            projectionPendingAt: now,
            projectionNextAttemptAt: now,
            leaseExpiresAt: null,
            lastError: '',
            dispatchPermitId: '',
            dispatchPermitGeneration: 0,
            dispatchPermitExpiresAt: null,
            workerCompletionEffectLeases: [],
          },
        },
        { new: true, session },
      ).lean();
      if (!completed) throw new Error('voice_worker_completion_settlement_replayed');
      await recordWorkerCompletionStageTrace({
        delivery: completed,
        presentation,
        stage: 'tts.completed',
        at: now,
      });
      await recordWorkerCompletionStageTrace({
        delivery: completed,
        presentation,
        stage: 'audio.completed',
        at: now,
      });
      await recordTraceDelivery(toDispatchPayload(completed), 'sent', now);
      for (const lease of leases) {
        const released = await releaseGlassHiveTerminalCallbackEffectLease({
          ResultModel: GlassHiveTerminalCallbackResult,
          lease,
          session,
        });
        if (!released) throw new Error('glasshive_callback_delivery_dispatch_fenced');
      }
    });
  } catch (error) {
    if (
      [
        'voice_worker_completion_settlement_invalid',
        'voice_worker_completion_settlement_replayed',
        'glasshive_callback_delivery_dispatch_fenced',
      ].includes(error?.message)
    ) {
      return null;
    }
    throw error;
  }
  const payload = toDispatchPayload(completed);
  await recordSurfaceOutcomeBestEffort(payload?.originRef, 'sent', completed);
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
  const now = nowDate();
  const normalizedMessageIds = normalizeTelegramMessageIds(telegramMessageIds);
  const currentQuery = ViventiumGlassHiveCallbackDelivery.findOne(
    deliveryConstraintFilter({ deliveryId, claimId, userId, voiceCallSessionId }),
  );
  const current = currentQuery?.lean ? await currentQuery.lean() : await currentQuery;
  if (plainWorkerCompletionPresentation(current)) return null;
  const terminalReference = persistedTerminalCallbackReference(current);
  if (terminalReference) {
    const lease = dispatchPermitLease(current);
    const permitExpiresAt = current?.dispatchPermitExpiresAt
      ? new Date(current.dispatchPermitExpiresAt)
      : null;
    if (
      !lease ||
      !permitExpiresAt ||
      permitExpiresAt <= now ||
      !presentedDispatchPermitMatches(current, dispatchPermit)
    ) {
      return null;
    }
    let permittedDoc = null;
    try {
      await runGlassHiveTerminalCallbackTransaction(async (session) => {
        permittedDoc = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
          {
            ...deliveryConstraintFilter({ deliveryId, claimId, userId, voiceCallSessionId }),
            dispatchPermitId: lease.leaseId,
            dispatchPermitGeneration: lease.generation,
            dispatchPermitExpiresAt: { $gt: now },
          },
          {
            $set: {
              status: 'sent',
              sentAt: now,
              projectionPendingAt: now,
              projectionNextAttemptAt: now,
              leaseExpiresAt: null,
              lastError: '',
              dispatchPermitId: '',
              dispatchPermitGeneration: 0,
              dispatchPermitExpiresAt: null,
              ...(normalizedMessageIds.length
                ? {
                    telegramSentMessageIds: normalizedMessageIds,
                    telegramMessageId: normalizedMessageIds[normalizedMessageIds.length - 1],
                    transportReceiptVersion: 1,
                  }
                : {}),
            },
          },
          { new: true, session },
        ).lean();
        if (!permittedDoc) throw new Error('glasshive_callback_delivery_dispatch_permit_invalid');
        const authorized = await fenceGlassHiveTerminalCallbackEffectTransaction({
          ResultModel: GlassHiveTerminalCallbackResult,
          lease,
          session,
          now,
        });
        if (!authorized) throw new Error('glasshive_callback_delivery_dispatch_fenced');
        await recordTraceDelivery(toDispatchPayload(permittedDoc), 'sent', now);
        const released = await releaseGlassHiveTerminalCallbackEffectLease({
          ResultModel: GlassHiveTerminalCallbackResult,
          lease,
          session,
        });
        if (!released) throw new Error('glasshive_callback_delivery_dispatch_fenced');
      });
    } catch (error) {
      if (
        [
          'glasshive_callback_delivery_dispatch_permit_invalid',
          'glasshive_callback_delivery_dispatch_fenced',
        ].includes(error?.message)
      ) {
        await markSupersededDelivery(normalizeText(deliveryId));
        return null;
      }
      throw error;
    }
    const payload = toDispatchPayload(permittedDoc);
    await recordSurfaceOutcomeBestEffort(payload?.originRef, 'sent', permittedDoc);
    logger.info(
      '[VIVENTIUM][glasshive-delivery] status=sent surface=%s delivery=%s event=%s retry=%s',
      payload.surface,
      payload.deliveryId,
      payload.event,
      payload.retryCount,
    );
    return payload;
  }
  let doc;
  try {
    doc = await transactionallyFencePersistedDelivery(
      () =>
        ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
          deliveryConstraintFilter({ deliveryId, claimId, userId, voiceCallSessionId }),
          {
            $set: {
              status: 'sent',
              sentAt: now,
              projectionPendingAt: now,
              projectionNextAttemptAt: now,
              leaseExpiresAt: null,
              lastError: '',
              ...(normalizedMessageIds.length
                ? {
                    telegramSentMessageIds: normalizedMessageIds,
                    telegramMessageId: normalizedMessageIds[normalizedMessageIds.length - 1],
                    transportReceiptVersion: 1,
                  }
                : {}),
            },
          },
          { new: true },
        ).lean(),
      current,
    );
  } catch (error) {
    if (error?.code !== 'glasshive_callback_delivery_superseded') throw error;
    await markSupersededDelivery(error.deliveryId || normalizeText(deliveryId));
    return null;
  }
  const payload = await recordFencedDeliveryTrace(doc, 'sent', now);
  if (!payload) return null;
  await recordSurfaceOutcomeBestEffort(payload?.originRef, 'sent', doc);
  if (payload) {
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

async function settleWorkerCompletionWithoutAudio({
  candidate,
  filter,
  dispatchPermit,
  status,
  outcome,
  updates,
  now,
}) {
  const permitExpiresAt = candidate?.dispatchPermitExpiresAt
    ? new Date(candidate.dispatchPermitExpiresAt)
    : null;
  const candidateLeases = workerCompletionEffectLeases(candidate);
  if (
    !plainWorkerCompletionPresentation(candidate) ||
    !dispatchPermit ||
    !permitExpiresAt ||
    permitExpiresAt <= now ||
    !presentedDispatchPermitMatches(candidate, dispatchPermit) ||
    !Array.isArray(candidateLeases)
  ) {
    return null;
  }
  let settled = null;
  try {
    await runGlassHiveTerminalCallbackTransaction(async (session) => {
      const current = await ViventiumGlassHiveCallbackDelivery.findOne({
        ...filter,
        dispatchPermitExpiresAt: { $gt: now },
      })
        .session(session)
        .lean();
      const leases = workerCompletionEffectLeases(current);
      if (
        !current ||
        !presentedDispatchPermitMatches(current, dispatchPermit) ||
        !Array.isArray(leases) ||
        !(await workerCompletionLeasesAreCurrent(current, leases, now, session))
      ) {
        throw new Error('glasshive_callback_delivery_dispatch_permit_invalid');
      }
      for (const lease of leases) {
        const fenced = await fenceGlassHiveTerminalCallbackEffectTransaction({
          ResultModel: GlassHiveTerminalCallbackResult,
          lease,
          session,
          now,
        });
        if (!fenced) throw new Error('glasshive_callback_delivery_dispatch_fenced');
      }
      settled = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
        {
          ...filter,
          dispatchPermitId: current.dispatchPermitId,
          dispatchPermitGeneration: current.dispatchPermitGeneration,
          dispatchPermitExpiresAt: { $gt: now },
        },
        {
          $set: {
            status,
            ...updates,
            projectionPendingAt: now,
            projectionNextAttemptAt: now,
            leaseExpiresAt: null,
            dispatchPermitId: '',
            dispatchPermitGeneration: 0,
            dispatchPermitExpiresAt: null,
            workerCompletionEffectLeases: [],
          },
        },
        { new: true, session },
      ).lean();
      if (!settled) throw new Error('glasshive_callback_delivery_dispatch_claim_changed');
      await recordTraceDelivery(toDispatchPayload(settled), status, now);
      for (const lease of leases) {
        const released = await releaseGlassHiveTerminalCallbackEffectLease({
          ResultModel: GlassHiveTerminalCallbackResult,
          lease,
          session,
        });
        if (!released) throw new Error('glasshive_callback_delivery_dispatch_fenced');
      }
    });
  } catch (error) {
    if (
      [
        'glasshive_callback_delivery_dispatch_permit_invalid',
        'glasshive_callback_delivery_dispatch_fenced',
        'glasshive_callback_delivery_dispatch_claim_changed',
      ].includes(error?.message)
    ) {
      return null;
    }
    throw error;
  }
  const payload = toDispatchPayload(settled);
  await recordSurfaceOutcomeBestEffort(payload?.originRef, outcome, settled);
  return payload;
}

async function markGlassHiveCallbackDeliveryUnknown({
  deliveryId,
  claimId,
  dispatchPermit = null,
  reason = 'telegram_delivery_status_unknown',
  userId = '',
  voiceCallSessionId = '',
}) {
  const now = nowDate();
  const filter = deliveryConstraintFilter({ deliveryId, claimId, userId, voiceCallSessionId });
  const candidateQuery = ViventiumGlassHiveCallbackDelivery.findOne(filter);
  const candidate = candidateQuery?.lean ? await candidateQuery.lean() : await candidateQuery;
  if (plainWorkerCompletionPresentation(candidate)) {
    return settleWorkerCompletionWithoutAudio({
      candidate,
      filter,
      dispatchPermit,
      status: 'delivery_unknown',
      outcome: 'unknown',
      updates: {
        unknownAt: now,
        nextAttemptAt: null,
        lastError: redactDeliveryError(reason).slice(0, MAX_LAST_ERROR_LENGTH),
      },
      now,
    });
  }
  const terminalReference = persistedTerminalCallbackReference(candidate);
  const activePermitExpiresAt = candidate?.dispatchPermitExpiresAt
    ? new Date(candidate.dispatchPermitExpiresAt)
    : null;
  if (
    terminalReference &&
    normalizeText(candidate?.dispatchPermitId) &&
    activePermitExpiresAt &&
    activePermitExpiresAt > now &&
    !dispatchPermit
  ) {
    return null;
  }
  if (terminalReference && dispatchPermit) {
    const lease = dispatchPermitLease(candidate);
    const permitExpiresAt = candidate?.dispatchPermitExpiresAt
      ? new Date(candidate.dispatchPermitExpiresAt)
      : null;
    if (
      !lease ||
      !permitExpiresAt ||
      permitExpiresAt <= now ||
      !presentedDispatchPermitMatches(candidate, dispatchPermit)
    ) {
      return null;
    }
    let permittedDoc = null;
    try {
      await runGlassHiveTerminalCallbackTransaction(async (session) => {
        permittedDoc = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
          {
            ...filter,
            dispatchPermitId: lease.leaseId,
            dispatchPermitGeneration: lease.generation,
            dispatchPermitExpiresAt: { $gt: now },
          },
          {
            $set: {
              status: 'delivery_unknown',
              unknownAt: now,
              projectionPendingAt: now,
              projectionNextAttemptAt: now,
              leaseExpiresAt: null,
              nextAttemptAt: null,
              lastError: redactDeliveryError(reason).slice(0, MAX_LAST_ERROR_LENGTH),
              dispatchPermitId: '',
              dispatchPermitGeneration: 0,
              dispatchPermitExpiresAt: null,
            },
          },
          { new: true, session },
        ).lean();
        if (!permittedDoc) throw new Error('glasshive_callback_delivery_dispatch_permit_invalid');
        const authorized = await fenceGlassHiveTerminalCallbackEffectTransaction({
          ResultModel: GlassHiveTerminalCallbackResult,
          lease,
          session,
          now,
        });
        if (!authorized) throw new Error('glasshive_callback_delivery_dispatch_fenced');
        await recordTraceDelivery(toDispatchPayload(permittedDoc), 'delivery_unknown', now);
        const released = await releaseGlassHiveTerminalCallbackEffectLease({
          ResultModel: GlassHiveTerminalCallbackResult,
          lease,
          session,
        });
        if (!released) throw new Error('glasshive_callback_delivery_dispatch_fenced');
      });
    } catch (error) {
      if (
        [
          'glasshive_callback_delivery_dispatch_permit_invalid',
          'glasshive_callback_delivery_dispatch_fenced',
        ].includes(error?.message)
      ) {
        await markSupersededDelivery(normalizeText(deliveryId));
        return null;
      }
      throw error;
    }
    const payload = toDispatchPayload(permittedDoc);
    await recordSurfaceOutcomeBestEffort(payload?.originRef, 'unknown', permittedDoc);
    return payload;
  }
  let doc;
  try {
    doc = await transactionallyFencePersistedDelivery(
      () =>
        ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
          filter,
          {
            $set: {
              status: 'delivery_unknown',
              unknownAt: now,
              projectionPendingAt: now,
              projectionNextAttemptAt: now,
              leaseExpiresAt: null,
              nextAttemptAt: null,
              lastError: redactDeliveryError(reason).slice(0, MAX_LAST_ERROR_LENGTH),
            },
          },
          { new: true },
        ).lean(),
      candidate,
    );
  } catch (error) {
    if (error?.code !== 'glasshive_callback_delivery_superseded') throw error;
    await markSupersededDelivery(error.deliveryId || normalizeText(deliveryId));
    return null;
  }
  const payload = await recordFencedDeliveryTrace(doc, 'delivery_unknown', now);
  if (!payload) return null;
  await recordSurfaceOutcomeBestEffort(payload?.originRef, 'unknown', doc);
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
  const filter = deliveryConstraintFilter({ deliveryId, claimId, userId, voiceCallSessionId });
  const candidateQuery = ViventiumGlassHiveCallbackDelivery.findOne(filter);
  const candidate = candidateQuery?.lean ? await candidateQuery.lean() : await candidateQuery;
  let doc;
  try {
    doc = await transactionallyFencePersistedDelivery(
      () =>
        ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
          filter,
          {
            $set: {
              status: 'suppressed',
              suppressedAt: now,
              projectionPendingAt: now,
              projectionNextAttemptAt: now,
              leaseExpiresAt: null,
              lastError: redactDeliveryError(reason).slice(0, MAX_LAST_ERROR_LENGTH),
            },
          },
          { new: true },
        ).lean(),
      candidate,
    );
  } catch (error) {
    if (error?.code !== 'glasshive_callback_delivery_superseded') throw error;
    await markSupersededDelivery(error.deliveryId || normalizeText(deliveryId));
    return null;
  }
  const payload = await recordFencedDeliveryTrace(doc, 'suppressed', now);
  if (!payload) return null;
  await recordSurfaceOutcomeBestEffort(payload?.originRef, 'suppressed', doc);
  if (payload) {
    logger.info(
      '[VIVENTIUM][glasshive-delivery] status=suppressed surface=%s delivery=%s event=%s retry=%s',
      payload.surface,
      payload.deliveryId,
      payload.event,
      payload.retryCount,
    );
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
  const retryCount = Math.max(0, Number(existing.retryCount) || 0) + 1;
  const exhausted = retryCount >= Math.max(1, Number(maxRetries) || DEFAULT_MAX_RETRIES);
  if (plainWorkerCompletionPresentation(existing) && workerCompletionEffectLeases(existing)) {
    return settleWorkerCompletionWithoutAudio({
      candidate: existing,
      filter: deliveryConstraintFilter({ deliveryId, claimId, userId, voiceCallSessionId }),
      dispatchPermit,
      status: 'failed',
      outcome: 'failed',
      updates: {
        failedAt: now,
        retryCount,
        nextAttemptAt: exhausted ? null : new Date(now.getTime() + retryDelayMs(retryCount)),
        lastError: redactDeliveryError(error || 'delivery failed').slice(0, MAX_LAST_ERROR_LENGTH),
      },
      now,
    });
  }
  let doc;
  try {
    doc = await transactionallyFencePersistedDelivery(
      () =>
        ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
          { deliveryId: existing.deliveryId, claimId: existing.claimId, status: 'claimed' },
          {
            $set: {
              status: 'failed',
              failedAt: now,
              projectionPendingAt: now,
              projectionNextAttemptAt: now,
              leaseExpiresAt: null,
              retryCount,
              nextAttemptAt: exhausted ? null : new Date(now.getTime() + retryDelayMs(retryCount)),
              lastError: redactDeliveryError(error || 'delivery failed').slice(
                0,
                MAX_LAST_ERROR_LENGTH,
              ),
            },
          },
          { new: true },
        ).lean(),
      existing,
    );
  } catch (caught) {
    if (caught?.code !== 'glasshive_callback_delivery_superseded') throw caught;
    await markSupersededDelivery(caught.deliveryId || normalizeText(deliveryId));
    return null;
  }
  const payload = await recordFencedDeliveryTrace(doc, 'failed', now);
  if (!payload) return null;
  await recordSurfaceOutcomeBestEffort(payload?.originRef, 'failed', doc);
  if (payload) {
    logger.info(
      '[VIVENTIUM][glasshive-delivery] status=failed surface=%s delivery=%s event=%s retry=%s exhausted=%s',
      payload.surface,
      payload.deliveryId,
      payload.event,
      payload.retryCount,
      exhausted,
    );
  }
  return payload;
}

/** Repair terminal Telegram deliveries that arrived before the account mapping existed. */
async function reconcileUnresolvedGlassHiveCallbackDeliveries({ userId = '', limit = 25 } = {}) {
  const normalizedUserId = normalizeText(userId);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
  const query = ViventiumGlassHiveCallbackDelivery.find({
    status: 'unresolved',
    surface: 'telegram',
    ...(normalizedUserId ? { userId: normalizedUserId } : {}),
  });
  const rows = await query.sort({ createdAt: 1 }).limit(safeLimit).lean();
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
    let updated;
    try {
      updated = await transactionallyFencePersistedDelivery(
        () =>
          ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
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
          ).lean(),
        row,
      );
    } catch (error) {
      if (error?.code !== 'glasshive_callback_delivery_superseded') throw error;
      await markSupersededDelivery(error.deliveryId || normalizeText(row.deliveryId));
      continue;
    }
    if (!updated) {
      pending += 1;
      continue;
    }
    repaired += 1;
    const originRef = normalizeText(updated.originRef || row.originRef);
    if (originRef) repairedOrigins.set(originRef, updated);
  }
  await Promise.all(
    [...repairedOrigins].map(([originRef, row]) =>
      recordSurfaceOutcomeBestEffort(originRef, 'enqueued', row),
    ),
  );
  return { scanned: Array.isArray(rows) ? rows.length : 0, repaired, pending };
}

/** Retry durable Core delivery projections after process loss or a transient Core/Mongo failure. */
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
    const accepted = await recordSurfaceOutcomeBestEffort(originRef, row.status, row);
    if (accepted) projected += 1;
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
  authorizeGlassHiveCallbackDeliveryDispatch,
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
  releaseGlassHiveCallbackDeliveryDispatch,
  renewGlassHiveCallbackDeliveryDispatch,
  toDispatchPayload,
  redactDeliveryError,
};
