/* === VIVENTIUM START ===
 * Feature: Durable GlassHive callback surface delivery ledger.
 * Purpose:
 * - Keep GlassHive callback persistence separate from surface delivery.
 * - Let Telegram/voice workers claim, send, retry, and audit callbacks that arrive
 *   after the original request stream has ended.
 * Added: 2026-05-06
 * === VIVENTIUM END === */

const crypto = require('crypto');
const isEqual = require('lodash/isEqual');
const {
  canonicalizeGlassHiveCallbackRef,
  fenceGlassHiveTerminalCallbackAcceptedOperation,
  verifyVoiceWorkerCompletionPresentation,
  nativeWorkInputBinding,
  nativeWorkInputPresentation,
  createNativeWorkInputPresentationService,
  notifyTelegramDeliveryReady,
  projectAudioDeliveryControls,
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
const { getCallSession } = require('./CallSessionService');
const { stripVoiceControlTagsForDisplay } = require('./surfacePrompts');
const {
  fenceGlassHiveCallbackRunState,
  isGlassHiveNonterminalAttentionCallback,
} = require('./GlassHiveCallbackBindingService');
const { recordOrchestrationTraceDelivery } = require('./OrchestrationTraceLedgerService');
const { recordVoiceOrchestrationTraceBestEffort } = require('./VoiceOrchestrationTraceService');
const { resolveTelegramMappingByUserId } = require('~/server/services/TelegramLinkService');
const {
  currentGlassHiveTerminalCallbackTransaction,
  deferGlassHiveTerminalCallbackAfterCommit,
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

const exactNativeInputPresentation = createNativeWorkInputPresentationService({
  requestWork: (ownerId, workRef) =>
    require('./GlassHiveAccountService').requestAccountApi({
      ownerId,
      path: `/v1/work/${encodeURIComponent(workRef)}`,
    }),
  readMessage: (filter, session) => queryLean(Message.findOne(filter), session),
  updateMessage: (filter, update, session) => Message.updateOne(filter, update, { session }),
  updateDelivery: (filter, update, session) =>
    ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(filter, update, {
      new: true,
      session,
    }).lean(),
  fence: (operation, row) => transactionallyFencePersistedDelivery(operation, row),
});

function isWorkerAttentionBinding(binding) {
  return binding?.kind === 'nonterminal_attention';
}

function workerBindingPresentation(row) {
  return (
    plainWorkerCompletionPresentation(row) ||
    (row?.workerCompletionBindings?.length
      ? {
          bindings: row.workerCompletionBindings,
          responseMessageId: row.callbackMessageId,
          responseDigest:
            'sha256:' + crypto.createHash('sha256').update(normalizeText(row.text)).digest('hex'),
          revision: 1,
        }
      : null)
  );
}
function hasWorkerAttention(row) {
  return workerBindingPresentation(row)?.bindings.some(isWorkerAttentionBinding) === true;
}
async function exactCanonicalWorkerAttentionDelivery(row, session = null, historical = false) {
  const presentation = workerBindingPresentation(row);
  if (!hasWorkerAttention(row) || row.event !== 'main.followup') return null;
  const message = await queryLean(
    Message.findOne({
      user: row.userId,
      conversationId: row.conversationId,
      messageId: row.callbackMessageId,
      isCreatedByUser: false,
    }),
    session,
  );
  if (
    !message ||
    normalizeText(message.text) !== normalizeText(row.text) ||
    !normalizeText(row.text)
  )
    return null;
  try {
    await assertWorkerCompletionBindingsAccepted({
      ownerId: row.userId,
      presentation,
      session,
      retainHistoricalSent: historical,
    });
  } catch {
    return null;
  }
  return presentation;
}
async function exactCanonicalWorkerDelivery(row, session = null) {
  return plainWorkerCompletionPresentation(row)
    ? exactCanonicalWorkerCompletionPresentation(row, session)
    : exactCanonicalWorkerAttentionDelivery(row, session);
}

async function assertWorkerAttentionBindingCurrent(
  ownerId,
  binding,
  session = null,
  historical = false,
  responseMessageId = '',
) {
  const mongoose = require('mongoose');
  const scope = {
    _id: binding.evidenceId,
    ownerId,
    originRef: binding.originRef,
    workRef: binding.workRef,
    workerId: binding.workerId,
    runId: binding.runId,
    callbackRef: binding.callbackRef,
    event: 'run.needs_input',
    workTerminal: false,
    workState: 'needs_input',
    ...(responseMessageId ? { followUpMessageId: responseMessageId } : {}),
  };
  const evidence = await mongoose.connection
    .collection('viventium_glasshive_mission_evidence')
    .findOne(scope, { session, projection: { _id: 1, callbackCreatedAt: 1 } });
  const current =
    historical ||
    (await mongoose.connection.collection('viventium_external_work').findOne(
      {
        _id: binding.originRef,
        ownerId,
        workRef: binding.workRef,
        workerId: binding.workerId,
        runId: binding.runId,
        externalState: 'needs_input',
      },
      { session, projection: { _id: 1 } },
    ));
  const newest = historical
    ? evidence
    : await mongoose.connection.collection('viventium_glasshive_mission_evidence').findOne(
        {
          ownerId,
          originRef: binding.originRef,
          workRef: binding.workRef,
          workerId: binding.workerId,
          runId: binding.runId,
          event: 'run.needs_input',
          workTerminal: false,
          workState: 'needs_input',
        },
        {
          session,
          sort: evidence?.callbackCreatedAt
            ? { callbackCreatedAt: -1, _id: -1 }
            : { callbackCreatedAt: -1, createdAt: -1, _id: -1 },
          projection: { _id: 1 },
        },
      );
  if (!evidence || !current || String(newest?._id) !== binding.evidenceId)
    throw Object.assign(new Error('voice_worker_completion_binding_superseded'), {
      code: 'glasshive_callback_effect_fenced',
    });
  if (session && !historical) {
    try {
      await fenceGlassHiveCallbackRunState({
        binding: { ownerId, originRef: binding.originRef, workRef: binding.workRef },
        body: { event: binding.event, worker_id: binding.workerId, run_id: binding.runId },
        effectSession: session,
      });
    } catch (error) {
      if (error?.code !== 'glasshive_callback_notice_superseded') throw error;
      throw Object.assign(new Error('voice_worker_completion_binding_superseded'), {
        code: 'glasshive_callback_effect_fenced',
      });
    }
  }
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
  const presentation = workerBindingPresentation(row);
  if (!presentation) return null;
  const stored = Array.isArray(row?.workerCompletionEffectLeases)
    ? row.workerCompletionEffectLeases
    : [];
  if (
    stored.length !==
    presentation.bindings.filter((binding) => !isWorkerAttentionBinding(binding)).length
  )
    return null;
  try {
    const leases = stored.map(workerCompletionLease);
    const byResultKey = new Map(leases.map((lease) => [lease.resultKey, lease]));
    if (byResultKey.size !== leases.length) return null;
    for (const binding of presentation.bindings.filter(
      (binding) => !isWorkerAttentionBinding(binding),
    )) {
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

async function canonicalPresentationTombstoned(row, session) {
  // Ordinary Message reads hide cleanup tombstones. Read only their exact identity, never text.
  return Boolean(
    await queryLean(
      Message.findOne(
        {
          user: normalizeText(row.userId),
          conversationId: normalizeText(row.conversationId),
          messageId: normalizeText(row.callbackMessageId),
          deletedAt: { $ne: null },
          'cleanupTombstone.contractVersion': 1,
        },
        { _id: 1 },
      ),
      session,
    ),
  );
}

async function exactCanonicalWorkerCompletionPresentation(
  row,
  session = null,
  historical = false,
  rejectCanonicalChange = false,
) {
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
  if (!response && rejectCanonicalChange && (await canonicalPresentationTombstoned(row, session))) {
    throw Object.assign(new Error('worker_completion_presentation_tombstoned'), {
      code: 'worker_completion_presentation_tombstoned',
      projectionSuperseded: true,
    });
  }
  const authority = {
    ownerId: normalizeText(row?.userId),
    conversationId: normalizeText(row?.conversationId),
    callSessionId: normalizeText(row?.voiceCallSessionId),
    responseMessageId: normalizeText(response?.messageId),
    responseText: normalizeText(response?.text),
  };
  if (
    rejectCanonicalChange &&
    response &&
    response.unfinished !== true &&
    authority.responseMessageId === normalizeText(row.callbackMessageId) &&
    authority.responseText !== normalizeText(row.text) &&
    verifyVoiceWorkerCompletionPresentation(presentation, {
      ...authority,
      responseText: normalizeText(row.text),
    })
  ) {
    throw Object.assign(new Error('voice_worker_completion_presentation_superseded'), {
      code: 'voice_worker_completion_presentation_superseded',
      projectionSuperseded: true,
    });
  }
  if (
    normalizeText(row?.callbackMessageId) !== authority.responseMessageId ||
    normalizeText(row?.voiceRequestId) !== normalizeText(presentation.turnId) ||
    !verifyVoiceWorkerCompletionPresentation(presentation, authority)
  ) {
    return null;
  }
  try {
    for (const binding of presentation.bindings.filter(isWorkerAttentionBinding))
      await assertWorkerAttentionBindingCurrent(
        authority.ownerId,
        binding,
        session,
        historical,
        presentation.responseMessageId,
      );
  } catch {
    return null;
  }
  return presentation;
}

async function workerCompletionLeasesAreCurrent(
  row,
  leases,
  now,
  session = null,
  historical = false,
) {
  if (!Array.isArray(leases)) return false;
  const attention =
    workerBindingPresentation(row)?.bindings?.filter(isWorkerAttentionBinding) || [];
  if (!leases.length && !attention.length) return false;
  try {
    for (const binding of attention)
      await assertWorkerAttentionBindingCurrent(
        row.userId,
        binding,
        session,
        historical,
        workerBindingPresentation(row).responseMessageId,
      );
  } catch {
    return false;
  }
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
  const presentation = workerBindingPresentation(row);
  if (hasWorkerAttention(row)) {
    const leaseId = normalizeText(row?.dispatchPermitId);
    const generation = Number(row?.dispatchPermitGeneration);
    return /^[a-f0-9]{32}$/.test(leaseId) && Number.isSafeInteger(generation) && generation > 0
      ? {
          leaseId,
          generation,
          resultRevision: presentation.revision,
          resultDigest: presentation.responseDigest,
        }
      : null;
  }
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
  const question = nativeWorkInputPresentation(row, { allowExpired: true });
  const lease =
    question &&
    /^[a-f0-9]{32}$/.test(normalizeText(row?.dispatchPermitId)) &&
    Number.isSafeInteger(row.dispatchPermitGeneration) &&
    row.dispatchPermitGeneration > 0
      ? {
          leaseId: row.dispatchPermitId,
          generation: row.dispatchPermitGeneration,
          resultRevision: 1,
          resultDigest: question.digest,
        }
      : dispatchPermitLease(row);
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

async function transactionallyFencePersistedDelivery(operation, candidate, transactionOptions) {
  const candidateReference = persistedTerminalCallbackReference(candidate);
  const missionAttention = hasWorkerAttention(candidate);
  const attention = isGlassHiveNonterminalAttentionCallback({ event: candidate?.event });
  if (!candidateReference && !attention && !missionAttention) {
    return operation(null);
  }
  const fenceMissionAttention = async (session) => {
    if (!missionAttention) return;
    try {
      await assertWorkerCompletionBindingsAccepted({
        ownerId: candidate.userId,
        presentation: workerBindingPresentation(candidate),
        session,
      });
    } catch (error) {
      if (error?.code !== 'glasshive_callback_effect_fenced') throw error;
      throw Object.assign(new Error('glasshive_callback_delivery_superseded'), {
        code: 'glasshive_callback_delivery_superseded',
        deliveryId: normalizeText(candidate.deliveryId),
      });
    }
  };
  let result = null;
  await runGlassHiveTerminalCallbackTransaction(async (session) => {
    await fenceMissionAttention(session);
    if (attention) {
      try {
        await fenceGlassHiveCallbackRunState({
          binding: {
            ownerId: candidate.userId,
            originRef: candidate.originRef,
            workRef: candidate.workRef,
          },
          body: { event: candidate.event, worker_id: candidate.workerId, run_id: candidate.runId },
          effectSession: session,
        });
      } catch (error) {
        if (error?.code !== 'glasshive_callback_notice_superseded') throw error;
        throw Object.assign(new Error('glasshive_callback_delivery_superseded'), {
          code: 'glasshive_callback_delivery_superseded',
          deliveryId: normalizeText(candidate.deliveryId),
        });
      }
    }
    result = await operation(session);
    await fenceMissionAttention(session);
    const reference = persistedTerminalCallbackReference(result) || candidateReference;
    if (!reference) return;
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
  }, transactionOptions);
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

async function recordFencedDeliveryTrace(row, status, at, transactionOptions) {
  const payload = toDispatchPayload(row);
  try {
    await transactionallyFencePersistedDelivery(
      async (session) => {
        if (status === 'claimed' && ['telegram', 'voice'].includes(row.surface)) {
          const message = await queryLean(
            Message.findOne({
              user: row.userId,
              conversationId: row.conversationId,
              messageId: row.callbackMessageId,
              isCreatedByUser: false,
              $or: [
                { 'content.deliveryDispositionRanges': { $exists: true } },
                { 'metadata.viventium.deliveryDisposition': { $exists: true } },
              ],
            }),
            session,
          );
          if (message) {
            const deliveredText = String(
              row.surface === 'voice' && row.workerCompletionPresentation
                ? row.text || ''
                : row.fullText || row.text || '',
            ).trim();
            const sourceText = String(message.text || '').trim();
            const content = (Array.isArray(message.content) ? message.content : []).filter(
              (part) => part?.type === 'text',
            );
            const ranged = content.some((part) =>
              Object.prototype.hasOwnProperty.call(part, 'deliveryDispositionRanges'),
            );
            const disposition = message.metadata?.viventium?.deliveryDisposition;
            if (row.surface === 'voice') {
              if (row.workerCompletionPresentation) payload.text = deliveredText;
              else payload.fullText = deliveredText;
              payload.deliveryControls = projectAudioDeliveryControls(
                message.metadata?.viventium?.deliveryControls,
                deliveredText,
                content,
                stripVoiceControlTagsForDisplay,
              );
            } else if (ranged || disposition)
              payload.deliveryControls = {
                ...(disposition ? { deliveryDisposition: disposition } : {}),
                ...(ranged || sourceText !== deliveredText
                  ? {
                      audioContent: sourceText === deliveredText ? content : [],
                      sourceTextSha256: crypto
                        .createHash('sha256')
                        .update(deliveredText)
                        .digest('hex'),
                    }
                  : {}),
              };
          }
        }
        await recordTraceDelivery(payload, status, traceStatusAt(payload, status, at));
        return row;
      },
      row,
      transactionOptions,
    );
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
  if (normalizeText(event) === 'main.followup') {
    return `main:${normalizeText(callbackMessageId)}`;
  }
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
    ...(normalizeText(delivery.anchorMessageId)
      ? { anchorMessageId: normalizeText(delivery.anchorMessageId) }
      : {}),
    event: delivery.event,
    workerId: delivery.workerId || null,
    runId: delivery.runId || null,
    surface: delivery.surface,
    text: delivery.text || '',
    fullText: delivery.fullText || '',
    attachments: delivery.attachments || [],
    telegramChatId: delivery.telegramChatId || '',
    telegramUserId: delivery.telegramUserId || '',
    telegramMessageId: delivery.telegramMessageId || '',
    telegramMessageThreadId: delivery.telegramMessageThreadId || '',
    nativeInputBinding: delivery.nativeInputBinding || null,
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
    ...(delivery.workerCompletionBindings?.length
      ? { workerCompletionBindings: delivery.workerCompletionBindings }
      : {}),
  };
}

function workerCompletionRepresentativeMatches({
  presentation,
  body,
  deliveryContext,
  traceIdentity,
}) {
  if (!presentation) return false;
  const attention = presentation.bindings.find(
    (binding) =>
      isWorkerAttentionBinding(binding) &&
      binding.originRef === normalizeText(deliveryContext?.originRef || body?.origin_ref) &&
      binding.workRef === normalizeText(deliveryContext?.workRef || body?.work_ref) &&
      binding.workerId === normalizeText(body?.worker_id) &&
      binding.runId === normalizeText(body?.run_id) &&
      binding.callbackRef === callbackRef(body?.callback_id),
  );
  if (attention) return true;
  if (!traceIdentity) return false;
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

async function assertWorkerCompletionBindingsAccepted({
  ownerId,
  presentation,
  session = null,
  retainHistoricalSent = false,
}) {
  const currentBindings = [];
  for (const binding of presentation.bindings) {
    if (isWorkerAttentionBinding(binding)) {
      await assertWorkerAttentionBindingCurrent(
        ownerId,
        binding,
        session,
        retainHistoricalSent,
        presentation.responseMessageId,
      );
      currentBindings.push(binding);
      continue;
    }
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
    if (!result && retainHistoricalSent) {
      const newer = await queryLean(
        GlassHiveTerminalCallbackResult.findOne({
          _id: binding.resultKey,
          ownerId,
          originRef: binding.originRef,
          workRef: binding.workRef,
          workerId: binding.workerId,
          runId: binding.runId,
          attemptNumber: binding.attemptNumber,
          $or: [
            { resultRevision: { $gt: binding.resultRevision } },
            { acceptedOperationGeneration: { $gt: binding.effectGeneration } },
          ],
        }),
        session,
      );
      if (newer) continue;
    }
    if (!result) {
      throw Object.assign(new Error('voice_worker_completion_binding_superseded'), {
        code: 'glasshive_callback_effect_fenced',
      });
    }
    currentBindings.push(binding);
  }
  return currentBindings;
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

// The ledger owns speech authority. Publish only its exact pending Main presentation through the
// existing durable task tail, after the terminal callback transaction commits.
async function publishPendingWorkerCompletionDelivery(delivery) {
  if (delivery?.surface === 'telegram' && delivery.status === 'pending') {
    const publish = () => notifyTelegramDeliveryReady();
    if (!deferGlassHiveTerminalCallbackAfterCommit(publish)) publish();
    return;
  }
  if (
    delivery?.surface !== 'voice' ||
    delivery.status !== 'pending' ||
    !(
      plainWorkerCompletionPresentation(delivery) ||
      nativeWorkInputPresentation(delivery, { allowExpired: true })
    )
  )
    return;
  const publish = async () => {
    try {
      const {
        hydrateVoiceTaskByStreamId,
        registerVoiceTaskDeliveryPresentation,
        flushVoiceTaskPersistence,
        getVoiceTaskByStreamId,
        getVoiceTaskTraceBinding,
        snapshotEvent,
      } = require('./VoiceTaskService');
      const streamId = `glasshive-delivery:${normalizeText(delivery.deliveryId)}`;
      const existing = getVoiceTaskByStreamId(streamId);
      const binding = getVoiceTaskTraceBinding(existing?.taskId);
      const snapshot = snapshotEvent(existing?.taskId);
      if (
        binding?.userId === delivery.userId &&
        binding?.callSessionId === delivery.voiceCallSessionId &&
        existing?.conversationId === delivery.conversationId &&
        existing.owner?.kind === 'glasshive_delivery' &&
        existing.owner.id === delivery.deliveryId &&
        snapshot?.resultMessageId === delivery.callbackMessageId &&
        snapshot.source?.id === delivery.callbackId
      )
        return;
      let current = await ViventiumGlassHiveCallbackDelivery.findOne({
        deliveryId: normalizeText(delivery.deliveryId),
        userId: normalizeText(delivery.userId),
        surface: 'voice',
        status: 'pending',
        voiceCallSessionId: normalizeText(delivery.voiceCallSessionId),
      }).lean();
      if (!current) return;
      const question = await exactNativeInputPresentation(current, null, true);
      if (!((await exactCanonicalWorkerCompletionPresentation(current)) || question)) {
        if (
          nativeWorkInputPresentation(current, { allowExpired: true }) ||
          plainWorkerCompletionPresentation(current)?.bindings.some(isWorkerAttentionBinding)
        )
          await markSupersededDelivery(current.deliveryId);
        return;
      }
      if (question) current = question.delivery;
      const scope = {
        userId: normalizeText(current.userId),
        callSessionId: normalizeText(current.voiceCallSessionId),
      };
      await hydrateVoiceTaskByStreamId(`glasshive-delivery:${normalizeText(current.deliveryId)}`, {
        ...scope,
        requireDurable: true,
      });
      registerVoiceTaskDeliveryPresentation(toDispatchPayload(current), scope);
      await flushVoiceTaskPersistence();
    } catch (error) {
      logger.warn('[VIVENTIUM][glasshive-delivery] Pending Voice discovery deferred', {
        deliveryId: normalizeText(delivery.deliveryId),
        code: error?.code || error?.name || 'publish_failed',
      });
    }
  };
  if (!deferGlassHiveTerminalCallbackAfterCommit(publish)) await publish();
}

async function recordWorkerCompletionResponseTrace({ delivery, presentation }) {
  if (!delivery?.deliveryId || !presentation) return;
  const inputs = presentation.bindings.map((binding) => ({
    ownerId: normalizeText(delivery.userId),
    callSessionId: presentation.callSessionId,
    turnId: presentation.turnId,
    eventRef: `${presentation.presentationRef}:${binding.workRef}`,
    stage: 'response.completed',
    facts: workerCompletionTraceFacts(delivery, presentation, binding),
  }));
  const record = async () => {
    for (const input of inputs) await recordVoiceOrchestrationTraceBestEffort(input);
  };
  if (!deferGlassHiveTerminalCallbackAfterCommit(record)) await record();
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
  // An accepted failure/Stop before execution has no runtime attempt to invent.
  const preRuntimeTerminal =
    attemptNumber === null && ['failed', 'cancelled'].includes(terminalState);
  if (
    !terminalState ||
    !ownerId ||
    !originRef ||
    !workRef ||
    !workerId ||
    !runId ||
    (!preRuntimeTerminal && (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1))
  ) {
    return null;
  }

  const result = await GlassHiveTerminalCallbackResult.findOne({
    ownerId,
    originRef,
    workRef,
    workerId,
    runId,
    // The accepted-result CAS uses zero for a pre-runtime terminal callback.
    attemptNumber: preRuntimeTerminal ? 0 : attemptNumber,
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
  return deliveryTerminalState(event) || isGlassHiveNonterminalAttentionCallback({ event })
    ? event
    : '';
}

function externalDestinations(deliveryContext = {}) {
  return (Array.isArray(deliveryContext.destinations) ? deliveryContext.destinations : []).filter(
    (destination) =>
      ['telegram', 'voice'].includes(normalizeText(destination?.surface).toLowerCase()),
  );
}

function shouldDispatchNeutralStatus(body = {}) {
  return (
    normalizeText(body.event) === 'main.followup' ||
    (normalizeText(body.event) !== 'run.needs_input' &&
      isGlassHiveNonterminalAttentionCallback(body))
  );
}

function presentationEligibilityFilter() {
  // Preserve pre-upgrade Main receipts; raw callback producers always stored a replay key.
  return {
    $or: [
      { presentationKind: 'main' },
      { event: { $in: ['run.blocked', 'checkpoint.ready', 'takeover.requested'] } },
      { callbackKey: '', presentationKind: { $in: ['', null] }, event: { $ne: 'run.needs_input' } },
    ],
  };
}

async function recordSurfaceOutcomeBestEffort(originRef, state, candidate = null) {
  if (!originRef) return false;
  const projectionStartedAt = nowDate();
  try {
    const project = async (session) => {
      let presentation = null;
      if (plainWorkerCompletionPresentation(candidate)) {
        presentation = await exactCanonicalWorkerCompletionPresentation(
          candidate,
          session,
          hasWorkerAttention(candidate) && ['sent', 'delivery_unknown'].includes(candidate.status),
          true,
        );
        if (!presentation)
          throw Object.assign(new Error('voice_worker_completion_presentation_superseded'), {
            code: 'voice_worker_completion_presentation_superseded',
          });
      } else if (candidate?.workerCompletionBindings?.length) {
        const stored = await queryLean(
          Message.findOne({
            user: candidate.userId,
            conversationId: candidate.conversationId,
            messageId: candidate.callbackMessageId,
            isCreatedByUser: { $ne: true },
          }),
          session,
        );
        presentation = {
          bindings: candidate.workerCompletionBindings,
          responseMessageId: candidate.callbackMessageId,
        };
        if (!stored && (await canonicalPresentationTombstoned(candidate, session))) {
          throw Object.assign(new Error('worker_completion_presentation_tombstoned'), {
            code: 'worker_completion_presentation_tombstoned',
            projectionSuperseded: true,
          });
        }
        if (
          !stored ||
          normalizeText(stored.text) !== normalizeText(candidate.text) ||
          !presentation.bindings.some(
            (binding) =>
              binding.originRef === originRef &&
              binding.workRef === candidate.workRef &&
              (isWorkerAttentionBinding(binding) ||
                (binding.resultKey === candidate.terminalCallbackResultKey &&
                  binding.acceptedOperationId === candidate.terminalCallbackAcceptedOperationId &&
                  binding.terminalCallbackId === candidate.terminalCallbackId &&
                  binding.resultDigest === candidate.terminalCallbackResultDigest &&
                  binding.resultRevision === candidate.terminalCallbackResultRevision &&
                  binding.effectGeneration === candidate.terminalCallbackEffectGeneration)),
          )
        ) {
          throw Object.assign(new Error('worker_completion_presentation_superseded'), {
            code: 'worker_completion_presentation_superseded',
            projectionSuperseded: Boolean(
              stored &&
              stored.unfinished !== true &&
              normalizeText(stored.text) !== normalizeText(candidate.text),
            ),
          });
        }
      }
      const currentBindings = presentation
        ? await assertWorkerCompletionBindingsAccepted({
            ownerId: normalizeText(candidate.userId),
            presentation,
            session,
            retainHistoricalSent:
              candidate.status === 'sent' ||
              (hasWorkerAttention(candidate) && candidate.status === 'delivery_unknown'),
          })
        : null;
      const {
        recordGlassHiveSurfaceDeliveryOutcome,
      } = require('./GlassHiveCallbackBindingService');
      const bindings = currentBindings || [null];
      for (const binding of bindings) {
        const memberOriginRef = binding?.originRef || originRef;
        const memberScope = binding
          ? {
              userId: candidate.userId,
              $or: [
                {
                  originRef: memberOriginRef,
                  workRef: binding.workRef,
                  runId: binding.runId,
                  ...(isWorkerAttentionBinding(binding)
                    ? {}
                    : terminalCallbackFields(workerCompletionReference(binding))),
                },
                { 'workerCompletionPresentation.bindings': { $elemMatch: binding } },
                { workerCompletionBindings: { $elemMatch: binding } },
              ],
            }
          : { originRef };
        const rows = await queryLean(
          ViventiumGlassHiveCallbackDelivery.find(
            binding
              ? { $and: [memberScope, presentationEligibilityFilter()] }
              : { ...memberScope, ...presentationEligibilityFilter() },
            { status: 1, _id: 0 },
          ),
          session,
        );
        const statuses = new Set((Array.isArray(rows) ? rows : []).map((row) => row?.status));
        const aggregateState = aggregateSurfaceState(statuses, state);
        await recordGlassHiveSurfaceDeliveryOutcome({
          originRef: memberOriginRef,
          state: aggregateState,
          ...(binding
            ? {
                workerCompletion: {
                  ownerId: candidate.userId,
                  responseMessageId: presentation.responseMessageId,
                  binding,
                },
              }
            : {}),
          ...(session ? { effectSession: session } : {}),
        });
        if (
          binding &&
          !isWorkerAttentionBinding(binding) &&
          !(await fenceGlassHiveTerminalCallbackAcceptedOperation({
            ResultModel: GlassHiveTerminalCallbackResult,
            reference: workerCompletionReference(binding),
            session,
          }))
        )
          throw Object.assign(new Error('glasshive_callback_delivery_superseded'), {
            code: 'glasshive_callback_delivery_superseded',
            deliveryId: candidate.deliveryId,
          });
      }
      if (presentation) {
        const applied = await ViventiumGlassHiveCallbackDelivery.updateOne(
          {
            deliveryId: candidate.deliveryId,
            userId: candidate.userId,
            status: candidate.status,
            callbackMessageId: candidate.callbackMessageId,
          },
          { $set: { workerCompletionProjectionAppliedAt: projectionStartedAt } },
          { session },
        );
        if (applied.matchedCount !== 1)
          throw new Error('worker_completion_projection_snapshot_changed');
      }
      const projectionFilter = {
        ...(presentation
          ? { deliveryId: candidate.deliveryId, userId: candidate.userId, status: candidate.status }
          : { originRef }),
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
    };
    if (
      plainWorkerCompletionPresentation(candidate) ||
      candidate?.workerCompletionBindings?.length
    ) {
      await runGlassHiveTerminalCallbackTransaction(project);
    } else {
      await transactionallyFencePersistedDelivery(project, candidate);
    }
    return true;
  } catch (error) {
    if (error?.code === 'glasshive_callback_delivery_superseded') {
      await markSupersededDelivery(error.deliveryId || normalizeText(candidate?.deliveryId));
      return false;
    }
    try {
      // A changed finished canonical answer cannot authorize this old presentation. Retain its
      // delivery truth and error; only a new existing delivery transition can re-arm projection.
      const superseded = error?.projectionSuperseded === true;
      await ViventiumGlassHiveCallbackDelivery.updateMany(
        plainWorkerCompletionPresentation(candidate) || candidate?.workerCompletionBindings?.length
          ? {
              deliveryId: candidate.deliveryId,
              userId: candidate.userId,
              ...(superseded
                ? {
                    status: candidate.status,
                    callbackMessageId: candidate.callbackMessageId,
                    projectionPendingAt: candidate.projectionPendingAt || null,
                  }
                : {}),
            }
          : { originRef },
        {
          $set: {
            projectionPendingAt: superseded
              ? null
              : candidate?.projectionPendingAt || projectionStartedAt,
            projectionNextAttemptAt: superseded
              ? null
              : new Date(projectionStartedAt.getTime() + PROJECTION_RETRY_MS),
            projectionErrorCode: normalizeText(
              error?.code || error?.name || 'projection_failed',
            ).slice(0, 120),
          },
          $inc: { projectionAttempts: 1 },
        },
      );
    } catch (retryError) {
      logger.warn('[VIVENTIUM][glasshive-delivery] Core projection retry persistence deferred', {
        code: normalizeText(
          retryError?.code || retryError?.name || 'projection_retry_failed',
        ).slice(0, 120),
      });
    }
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

function aggregateSurfaceState(statuses, fallback) {
  if (statuses.has('delivery_unknown')) return 'unknown';
  if (statuses.has('unresolved')) return 'unresolved';
  if (statuses.has('failed')) return 'failed';
  if (statuses.has('pending') || statuses.has('claimed')) return 'enqueued';
  if (statuses.has('sent')) return 'sent';
  if (statuses.has('suppressed')) return 'suppressed';
  return fallback;
}

async function recordGlassHiveLinkedWebDelivery({
  body = {},
  message,
  deliveryContext = {},
  effectFence,
  effectSession,
}) {
  if (
    !deliveryContext.destinations?.some((destination) =>
      ['librechat', 'workbench'].includes(normalizeText(destination?.surface).toLowerCase()),
    ) ||
    externalDestinations(deliveryContext).length > 0
  )
    return null;
  effectSession ||= currentGlassHiveTerminalCallbackTransaction()?.session || null;
  if (!effectSession) throw new Error('glasshive_linked_presentation_transaction_required');
  if (!effectFence) {
    const reference = await acceptedTerminalCallbackReference({
      body,
      deliveryContext,
      traceIdentity: callbackTraceIdentity(body, deliveryContext),
    });
    if (!reference) throw new Error('glasshive_linked_presentation_identity_invalid');
    const lease = await acquireGlassHiveTerminalCallbackAcceptedOperationEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      reference,
      session: effectSession,
    });
    if (!lease) throw new Error('glasshive_linked_presentation_authority_unavailable');
    try {
      await fenceGlassHiveTerminalCallbackEffectTransaction({
        ResultModel: GlassHiveTerminalCallbackResult,
        lease,
        session: effectSession,
      });
      return await recordGlassHiveLinkedWebDelivery({
        body,
        message,
        deliveryContext,
        effectFence: lease,
        effectSession,
      });
    } finally {
      await releaseGlassHiveTerminalCallbackEffectLease({
        ResultModel: GlassHiveTerminalCallbackResult,
        lease,
        session: effectSession,
      });
    }
  }
  const reference = terminalCallbackReference(effectFence);
  const ownerId = normalizeText(deliveryContext.ownerId);
  const conversationId = normalizeText(deliveryContext.conversationId);
  const originRef = normalizeText(deliveryContext.originRef);
  const workRef = normalizeText(deliveryContext.workRef);
  const callbackId = callbackRef(reference.callbackId);
  const traceIdentity = callbackTraceIdentity(body, deliveryContext);
  if (
    !ownerId ||
    !conversationId ||
    !originRef ||
    !workRef ||
    !traceIdentity ||
    traceIdentity.callbackRef !== callbackId
  ) {
    throw new Error('glasshive_linked_presentation_identity_invalid');
  }
  const accepted = await queryLean(
    GlassHiveTerminalCallbackResult.findOne({
      _id: reference.resultKey,
      ownerId,
      originRef,
      workRef,
      workerId: normalizeText(body.worker_id),
      runId: normalizeText(body.run_id),
      acceptedOperationId: reference.acceptedOperationId,
      acceptedOperationGeneration: reference.generation,
      callbackId: reference.callbackId,
      resultDigest: reference.resultDigest,
      resultRevision: reference.resultRevision,
      effectLeaseId: normalizeText(effectFence.leaseId),
      effectLeaseGeneration: Number(effectFence.generation),
      effectLeaseExpiresAt: { $gt: nowDate() },
    }),
    effectSession,
  );
  const stored = await queryLean(
    Message.findOne({
      user: ownerId,
      conversationId,
      messageId: normalizeText(message?.messageId),
      isCreatedByUser: false,
    }),
    effectSession,
  );
  const attachments = Array.isArray(stored?.attachments) ? stored.attachments : [];
  // Publication already verified these imports under the accepted callback fence. Only the exact
  // persisted owner/message attachment set can settle a presentation with no authored text.
  const hasOwnedFiles =
    attachments.length > 0 &&
    isEqual(attachments, message?.attachments) &&
    attachments.every(
      (attachment) =>
        normalizeText(attachment.user) === ownerId &&
        normalizeText(attachment.file_id) &&
        attachment.nativeOutputFile?.version === 1 &&
        attachment.nativeOutputFile.status === 'available' &&
        attachment.nativeOutputFile.messageId === stored.messageId,
    );
  if (
    !accepted ||
    !stored ||
    (!normalizeText(stored.text) && !hasOwnedFiles) ||
    stored.text !== message?.text
  ) {
    throw new Error('glasshive_linked_presentation_message_unavailable');
  }
  const event = normalizeText(body.event);
  const deliveryKey = deliveryKeyFor({
    ownerId,
    originRef,
    surface: 'librechat',
    callbackId,
    callbackMessageId: stored.messageId,
    event,
    attemptNumber: traceIdentity.attemptNumber,
  });
  const now = nowDate();
  const row = await queryLean(
    ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
      {
        deliveryKey,
        userId: ownerId,
        originRef,
        callbackMessageId: stored.messageId,
      },
      {
        $setOnInsert: {
          deliveryKey,
          deliveryId: deliveryIdFor(deliveryKey),
          callbackId,
          callbackMessageId: stored.messageId,
          userId: ownerId,
          conversationId,
          originRef,
          workRef,
          workerId: normalizeText(body.worker_id),
          runId: normalizeText(body.run_id),
          event,
          surface: 'librechat',
          status: 'sent',
          sentAt: now,
          text: stored.text,
          attachments,
          projectionPendingAt: now,
          projectionNextAttemptAt: now,
          expiresAt: new Date(now.getTime() + DELIVERY_RETENTION_MS),
          ...terminalCallbackFields(reference),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true, session: effectSession },
    ),
    effectSession,
  );
  const rows = await queryLean(
    ViventiumGlassHiveCallbackDelivery.find(
      {
        originRef,
        userId: ownerId,
        workRef,
        runId: normalizeText(body.run_id),
        ...terminalCallbackFields(reference),
      },
      { status: 1 },
    ),
    effectSession,
  );
  const { recordGlassHiveSurfaceDeliveryOutcome } = require('./GlassHiveCallbackBindingService');
  await recordGlassHiveSurfaceDeliveryOutcome({
    originRef,
    state: aggregateSurfaceState(new Set(rows.map((item) => item.status)), 'sent'),
    body: {
      ...body,
      callback_id: reference.callbackId,
      result_ended_at: accepted.resultEndedAt,
      result_digest: accepted.resultDigest,
      result_revision: accepted.resultRevision,
    },
    effectFence,
    effectSession,
  });
  return row;
}

function pendingNeutralVoiceDelivery(row) {
  return (
    row?.surface === 'voice' &&
    row.status === 'pending' &&
    ['run.failed', 'run.cancelled', 'run.interrupted'].includes(row.event) &&
    row.traceIdentityVerified === true &&
    !row.workerCompletionPresentation &&
    !row.claimId &&
    !row.claimedAt &&
    !row.dispatchPermitId &&
    !row.fullText
  );
}

async function settleEndedCallNeutralDelivery(row, { effectFence, effectSession } = {}) {
  if (!pendingNeutralVoiceDelivery(row)) return row;
  const call = await getCallSession(row.voiceCallSessionId);
  if (
    call?.status !== 'ended' ||
    call.userId !== row.userId ||
    call.conversationId !== row.conversationId
  )
    return row;
  const reference = terminalCallbackReference({
    resultKey: row.terminalCallbackResultKey,
    acceptedOperationId: row.terminalCallbackAcceptedOperationId,
    callbackId: row.terminalCallbackId,
    resultDigest: row.terminalCallbackResultDigest,
    resultRevision: row.terminalCallbackResultRevision,
    generation: row.terminalCallbackEffectGeneration,
  });
  const settle = async (session, fence) => {
    const message = await queryLean(
      Message.findOne({
        user: row.userId,
        conversationId: row.conversationId,
        messageId: row.callbackMessageId,
        isCreatedByUser: false,
      }),
      session,
    );
    const metadata = message?.metadata?.viventium;
    if (
      metadata?.type !== 'glasshive_worker_callback' ||
      metadata.status?.kind !== 'mission_status' ||
      metadata.status.state !== deliveryTerminalState(row.event) ||
      metadata.originRef !== row.originRef ||
      metadata.workRef !== row.workRef ||
      metadata.workerId !== row.workerId ||
      metadata.runId !== row.runId ||
      callbackRef(metadata.callbackId) !== row.callbackId ||
      metadata.voiceCallSessionId !== row.voiceCallSessionId ||
      !normalizeText(message.text)
    )
      return row;
    const destinations = (metadata.configuredDestinations || []).filter(
      (destination) => destination.surface !== 'voice',
    );
    if (
      !destinations.some((destination) => ['librechat', 'workbench'].includes(destination.surface))
    )
      return row;
    const now = nowDate();
    const updated = await queryLean(
      ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
        {
          deliveryId: row.deliveryId,
          userId: row.userId,
          conversationId: row.conversationId,
          status: 'pending',
          surface: 'voice',
          claimId: { $in: ['', null] },
          claimedAt: null,
          dispatchPermitId: { $in: ['', null] },
          ...terminalCallbackFields(reference),
        },
        {
          $set: {
            status: 'suppressed',
            suppressedAt: now,
            nextAttemptAt: null,
            lastError: 'call_ended_linked_text',
            projectionPendingAt: now,
            projectionNextAttemptAt: now,
          },
        },
        { new: true, session },
      ),
      session,
    );
    if (!updated) return row;
    await recordGlassHiveLinkedWebDelivery({
      body: {
        callback_id: reference.callbackId,
        event: row.event,
        attempt_number: deliveryAttemptNumber(row) ?? null,
        worker_id: row.workerId,
        run_id: row.runId,
      },
      message,
      deliveryContext: {
        ownerId: row.userId,
        conversationId: row.conversationId,
        originRef: row.originRef,
        workRef: row.workRef,
        destinations,
        traceIdentity: {
          callbackRef: row.callbackId,
          attemptNumber: deliveryAttemptNumber(row) ?? null,
        },
      },
      effectFence: fence,
      effectSession: session,
    });
    return updated;
  };
  if (effectSession && effectFence) return settle(effectSession, effectFence);
  return runGlassHiveTerminalCallbackTransaction(async (session) => {
    const lease = await acquireGlassHiveTerminalCallbackAcceptedOperationEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      reference,
      session,
    });
    if (!lease) return row;
    try {
      await fenceGlassHiveTerminalCallbackEffectTransaction({
        ResultModel: GlassHiveTerminalCallbackResult,
        lease,
        session,
      });
      return await settle(session, lease);
    } finally {
      await releaseGlassHiveTerminalCallbackEffectLease({
        ResultModel: GlassHiveTerminalCallbackResult,
        lease,
        session,
      });
    }
  });
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
  // Main authors needs-input speech; exact native controls remain in their existing owner/detail path.
  if (!message) return summary;
  if (!shouldDispatchNeutralStatus(body)) {
    return { ...summary, deferredToMain: true };
  }
  if (destinations.length === 0) {
    const linked = await recordGlassHiveLinkedWebDelivery({
      body,
      message,
      deliveryContext,
      effectFence,
      effectSession,
    });
    return linked ? { ...summary, linkedWebCommitted: true } : summary;
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
  const pendingInputBinding =
    event === 'run.needs_input' ||
    normalizeText(deliveryContext?.traceCallbackEvent) === 'run.needs_input'
      ? nativeWorkInputBinding(body.pending_native_input, normalizeText(body.run_id))
      : null;
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
    const suppressDestination =
      suppress ||
      (surface === 'voice' &&
        message.metadata?.viventium?.deliveryDisposition?.version === 1 &&
        message.metadata.viventium.deliveryDisposition.audio === 'skip');
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
    const persistedIdentityFilter =
      event === 'main.followup'
        ? { deliveryKey }
        : {
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
            presentationKind: event === 'main.followup' ? 'main' : 'native_input',
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
            status: resolved ? (suppressDestination ? 'suppressed' : 'pending') : 'unresolved',
            projectionPendingAt: now,
            projectionNextAttemptAt: now,
            ...(resolved && suppressDestination ? { suppressedAt: now } : {}),
            telegramChatId: normalizeText(destination.telegramChatId),
            telegramUserId: normalizeText(destination.telegramUserId),
            telegramMessageId: normalizeText(destination.telegramMessageId),
            telegramMessageThreadId: normalizeText(destination.telegramMessageThreadId),
            ...(pendingInputBinding ? { nativeInputBinding: pendingInputBinding } : {}),
            voiceCallSessionId: normalizeText(destination.voiceCallSessionId),
            voiceRequestId: normalizeText(destination.voiceRequestId),
            retryCount: 0,
            nextAttemptAt: resolved && !suppressDestination ? now : null,
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
            ...(deliveryContext.workerCompletionBindings
              ? { workerCompletionBindings: deliveryContext.workerCompletionBindings }
              : {}),
            text: preview,
            fullText: completeText && completeText !== preview ? completeText : '',
            attachments: Array.isArray(message.attachments) ? message.attachments : [],
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
              status: suppressDestination ? 'suppressed' : 'pending',
              projectionPendingAt: now,
              projectionNextAttemptAt: now,
              telegramChatId: normalizeText(destination.telegramChatId),
              telegramUserId: normalizeText(destination.telegramUserId),
              telegramMessageId: normalizeText(destination.telegramMessageId),
              voiceCallSessionId: normalizeText(destination.voiceCallSessionId),
              voiceRequestId: normalizeText(destination.voiceRequestId),
              nextAttemptAt: suppressDestination ? null : now,
              lastError: '',
              unresolvedReason: '',
              expiresAt,
              ...(workerCompletionPresentation ? { workerCompletionPresentation } : {}),
              ...(deliveryContext.workerCompletionBindings
                ? { workerCompletionBindings: deliveryContext.workerCompletionBindings }
                : {}),
            },
          },
          { new: true },
        ).lean();
      }

      // A crash/replay across the semantic-silence upgrade may find the same deterministic row in
      // pending state. Settle only that unsent row; claimed/sent rows remain authoritative.
      if (suppressDestination && resolved && updated?.status === 'pending') {
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

      updated = await settleEndedCallNeutralDelivery(updated, { effectFence, effectSession });
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
      await publishPendingWorkerCompletionDelivery(updated);
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
              ...(surface === 'voice'
                ? {
                    $or: [
                      { dispatchPermitId: { $exists: false } },
                      { dispatchPermitId: '' },
                      { dispatchPermitId: null },
                    ],
                    $and: [
                      {
                        $or: [
                          { 'nativeInputBinding.version': { $ne: 1 } },
                          { dispatchPermitGeneration: { $in: [0, null] } },
                        ],
                      },
                    ],
                  }
                : {}),
            },
          ]
        : []),
    ],
  };
  const filter = {
    surface,
    $and: [leaseExpired, retryable],
    ...presentationEligibilityFilter(),
  };
  if (callbackId) {
    filter.callbackId = callbackId;
    if (surface === 'voice') {
      filter.$and.push({
        $or: [
          { 'workerCompletionPresentation.version': 1 },
          { event: 'run.needs_input', 'nativeInputBinding.version': 1 },
        ],
      });
    }
  }
  if (userId) {
    filter.userId = userId;
  }
  if (voiceCallSessionId) {
    filter.voiceCallSessionId = voiceCallSessionId;
  }
  return filter;
}

/* === VIVENTIUM START === An issued Voice presentation with an unknown outcome cannot replay. === */
async function settleExpiredVoiceDispatch(candidate, now) {
  const permit = toDispatchPermit(candidate);
  const claimExpiry = candidate?.leaseExpiresAt ? new Date(candidate.leaseExpiresAt) : null;
  const permitExpiry = candidate?.dispatchPermitExpiresAt
    ? new Date(candidate.dispatchPermitExpiresAt)
    : null;
  if (
    candidate?.surface !== 'voice' ||
    candidate.status !== 'claimed' ||
    !candidate.userId ||
    !candidate.voiceCallSessionId ||
    !permit ||
    !claimExpiry ||
    claimExpiry > now ||
    !permitExpiry ||
    permitExpiry > now
  )
    return null;
  const filter = {
    ...deliveryConstraintFilter({
      deliveryId: candidate.deliveryId,
      claimId: candidate.claimId,
      userId: candidate.userId,
      voiceCallSessionId: candidate.voiceCallSessionId,
    }),
    surface: 'voice',
    leaseExpiresAt: candidate.leaseExpiresAt,
    dispatchPermitId: candidate.dispatchPermitId,
    dispatchPermitGeneration: candidate.dispatchPermitGeneration,
    dispatchPermitExpiresAt: candidate.dispatchPermitExpiresAt,
  };
  let settled = null;
  try {
    await runGlassHiveTerminalCallbackTransaction(async (session) => {
      const current = await ViventiumGlassHiveCallbackDelivery.findOne(filter)
        .session(session)
        .lean();
      if (!current || !presentedDispatchPermitMatches(current, permit)) return;
      const presentation = plainWorkerCompletionPresentation(current);
      const leases = presentation
        ? workerCompletionEffectLeases(current)
        : [dispatchPermitLease(current)];
      if (
        !Array.isArray(leases) ||
        (!leases.length && !presentation?.bindings.some(isWorkerAttentionBinding)) ||
        leases.some((lease) => !lease)
      )
        return;
      for (const lease of leases) {
        const currentResult = await fenceGlassHiveTerminalCallbackAcceptedOperation({
          ResultModel: GlassHiveTerminalCallbackResult,
          reference: {
            resultKey: lease.resultKey,
            acceptedOperationId: lease.acceptedOperationId,
            generation: lease.acceptedOperationGeneration,
            callbackId: lease.callbackId,
            resultRevision: lease.resultRevision,
            resultDigest: lease.resultDigest,
          },
          session,
        });
        if (!currentResult) throw new Error('glasshive_callback_delivery_dispatch_fenced');
      }
      settled = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
        filter,
        {
          $set: {
            status: 'delivery_unknown',
            unknownAt: now,
            nextAttemptAt: null,
            leaseExpiresAt: null,
            projectionPendingAt: now,
            projectionNextAttemptAt: now,
            dispatchPermitId: '',
            dispatchPermitGeneration: 0,
            dispatchPermitExpiresAt: null,
            workerCompletionEffectLeases: [],
            lastError: 'voice_delivery_status_unknown_after_dispatch_expiry',
          },
        },
        { new: true, session },
      ).lean();
      if (!settled) throw new Error('glasshive_callback_delivery_dispatch_claim_changed');
      for (const lease of leases) {
        // Release only the old exact lease. A newer effect lease is untouched.
        await releaseGlassHiveTerminalCallbackEffectLease({
          ResultModel: GlassHiveTerminalCallbackResult,
          lease,
          session,
        });
      }
      await recordTraceDelivery(toDispatchPayload(settled), 'delivery_unknown', now);
    });
  } catch (error) {
    if (
      [
        'glasshive_callback_delivery_dispatch_fenced',
        'glasshive_callback_delivery_dispatch_claim_changed',
      ].includes(error?.message)
    )
      return null;
    throw error;
  }
  const payload = toDispatchPayload(settled);
  if (payload) await recordSurfaceOutcomeBestEffort(payload.originRef, 'unknown', settled);
  return payload;
}
/* === VIVENTIUM END === */

/* === VIVENTIUM START === Resolve an exact completed observer without granting speech. === */
async function getSettledGlassHiveVoiceCallbackDelivery({
  callbackId = '',
  userId = '',
  voiceCallSessionId = '',
} = {}) {
  const callback = callbackRef(callbackId);
  const owner = normalizeText(userId);
  const call = normalizeText(voiceCallSessionId);
  if (!callback || !owner || !call) return null;
  const row = await ViventiumGlassHiveCallbackDelivery.findOne({
    surface: 'voice',
    callbackId: callback,
    userId: owner,
    voiceCallSessionId: call,
    status: { $in: ['sent', 'suppressed'] },
  })
    .sort({ terminalCallbackResultRevision: -1, updatedAt: -1 })
    .lean();
  if (
    !row ||
    row.surface !== 'voice' ||
    !['sent', 'suppressed'].includes(row.status) ||
    row.callbackId !== callback ||
    row.userId !== owner ||
    row.voiceCallSessionId !== call ||
    !normalizeText(row.deliveryId)
  )
    return null;
  try {
    const reference = persistedTerminalCallbackReference(row);
    if (
      !reference &&
      (nativeWorkInputPresentation(row, { allowExpired: true }) ||
        plainWorkerCompletionPresentation(row)?.bindings.some(isWorkerAttentionBinding))
    ) {
      return {
        deliveryId: row.deliveryId,
        callbackId: callback,
        userId: owner,
        voiceCallSessionId: call,
        status: row.status,
      };
    }
    if (!reference) return null;
    const accepted = await queryLean(
      GlassHiveTerminalCallbackResult.findOne({
        _id: reference.resultKey,
        ownerId: owner,
        originRef: row.originRef,
        workRef: row.workRef,
        workerId: row.workerId,
        runId: row.runId,
        attemptNumber: deliveryAttemptNumber(row),
        acceptedOperationId: reference.acceptedOperationId,
        acceptedOperationGeneration: reference.generation,
        callbackId: reference.callbackId,
        resultRevision: reference.resultRevision,
        resultDigest: reference.resultDigest,
      }),
    );
    if (!accepted) return null;
    const presentation = plainWorkerCompletionPresentation(row);
    if (presentation)
      await assertWorkerCompletionBindingsAccepted({ ownerId: owner, presentation });
    return {
      deliveryId: row.deliveryId,
      callbackId: callback,
      userId: owner,
      voiceCallSessionId: call,
      status: row.status,
    };
  } catch (error) {
    if (error?.code !== 'glasshive_callback_effect_fenced') throw error;
    return null;
  }
}
/* === VIVENTIUM END === */

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
        $nor: [
          {
            surface: 'voice',
            event: 'run.needs_input',
            'nativeInputBinding.version': 1,
            dispatchPermitId: { $in: ['', null] },
            dispatchPermitGeneration: { $in: [0, null] },
          },
        ],
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
          lastError: `${normalizedSurface}_delivery_status_unknown_after_claim_expiry`,
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
      if (normalizedSurface === 'voice') {
        await settleExpiredVoiceDispatch(expired, now);
        continue;
      }
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
    if (!candidate) break;
    let doc;
    try {
      doc = await transactionallyFencePersistedDelivery(
        (session) =>
          ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
            { ...pendingFilter, deliveryId: candidate.deliveryId },
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
            { sort: { createdAt: 1 }, new: true, session },
          ).lean(),
        candidate,
        { retry: 'native' },
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
    if (nativeWorkInputPresentation(doc, { allowExpired: true })) {
      const question = await exactNativeInputPresentation(doc, null, true);
      if (!question) {
        await markSupersededDelivery(doc.deliveryId);
        index -= 1;
        continue;
      }
      doc = question.delivery;
    }
    const payload = await recordFencedDeliveryTrace(doc, 'claimed', now, { retry: 'native' });
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

/** Resolve a speaking Worker result from its existing claim, canonical response and effect lease. */
async function resolveGlassHiveVoicePresentation({
  deliveryId,
  claimId,
  dispatchPermit,
  presentationRef,
  turnId,
  userId,
  voiceCallSessionId,
  conversationId,
}) {
  if (!userId || !voiceCallSessionId || !conversationId) return null;
  const now = nowDate();
  const current = await ViventiumGlassHiveCallbackDelivery.findOne({
    ...deliveryConstraintFilter({ deliveryId, claimId, userId, voiceCallSessionId }),
    surface: 'voice',
    conversationId,
    dispatchPermitExpiresAt: { $gt: now },
  }).lean();
  if (
    !current ||
    current.userId !== userId ||
    current.voiceCallSessionId !== voiceCallSessionId ||
    current.conversationId !== conversationId ||
    current.surface !== 'voice' ||
    current.status !== 'claimed' ||
    !current.dispatchPermitExpiresAt ||
    new Date(current.dispatchPermitExpiresAt) <= now ||
    !presentedDispatchPermitMatches(current, dispatchPermit)
  )
    return null;
  if (nativeWorkInputPresentation(current)) {
    const question = await exactNativeInputPresentation(current);
    if (
      !question ||
      current.deliveryId !== normalizeText(presentationRef) ||
      current.voiceRequestId !== normalizeText(turnId)
    )
      return null;
    return {
      ...toDispatchPayload(current),
      presentationRef: current.deliveryId,
      turnId: current.voiceRequestId,
    };
  }
  if (plainWorkerCompletionPresentation(current)) {
    const presentation = await exactCanonicalWorkerCompletionPresentation(current);
    const leases = workerCompletionEffectLeases(current);
    if (
      !presentation ||
      presentation.presentationRef !== normalizeText(presentationRef) ||
      presentation.turnId !== normalizeText(turnId) ||
      !(await workerCompletionLeasesAreCurrent(current, leases, now))
    )
      return null;
    return {
      ...toDispatchPayload(current),
      presentationRef: presentation.presentationRef,
      turnId: presentation.turnId,
    };
  }
  const lease = dispatchPermitLease(current);
  const response = await queryLean(
    Message.findOne({
      user: userId,
      conversationId,
      messageId: current.callbackMessageId,
      isCreatedByUser: false,
    }),
  );
  const metadata = response?.metadata?.viventium;
  if (
    !lease ||
    normalizeText(current.deliveryId) !== normalizeText(presentationRef) ||
    !normalizeText(current.voiceRequestId) ||
    normalizeText(current.voiceRequestId) !== normalizeText(turnId) ||
    metadata?.type !== 'glasshive_worker_callback' ||
    metadata.status?.kind !== 'mission_status' ||
    metadata.status.state !== deliveryTerminalState(current.event) ||
    metadata.originRef !== current.originRef ||
    metadata.workRef !== current.workRef ||
    metadata.workerId !== current.workerId ||
    metadata.runId !== current.runId ||
    callbackRef(metadata.callbackId) !== current.callbackId ||
    metadata.voiceCallSessionId !== voiceCallSessionId ||
    !normalizeText(response.text) ||
    normalizeText(response.text) !== normalizeText(current.text) ||
    !(await workerCompletionLeasesAreCurrent(current, [lease], now))
  )
    return null;
  return {
    ...toDispatchPayload(current),
    presentationRef: current.deliveryId,
    turnId: current.voiceRequestId,
  };
}

async function acquireWorkerCompletionDispatch({ current, now, durationMs, session }) {
  const presentation = await exactCanonicalWorkerDelivery(current, session);
  if (!presentation) throw new Error('voice_worker_completion_presentation_superseded');
  await assertWorkerCompletionBindingsAccepted({
    ownerId: normalizeText(current.userId),
    presentation,
    session,
  });
  const leases = [];
  for (const binding of presentation.bindings.filter(
    (binding) => !isWorkerAttentionBinding(binding),
  )) {
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
  const representative = presentation.bindings.some(isWorkerAttentionBinding)
    ? {
        leaseId: crypto.randomUUID().replaceAll('-', ''),
        generation: (current.dispatchPermitGeneration || 0) + 1,
      }
    : representativeWorkerCompletionLease(current, leases);
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
      (await exactCanonicalWorkerDelivery(initial)) &&
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
  if (plainWorkerCompletionPresentation(initial) || hasWorkerAttention(initial)) {
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
  if (nativeWorkInputPresentation(initial, { allowExpired: true })) {
    const permitted = await transactionallyFencePersistedDelivery(async (session) => {
      let current = await queryLean(
        ViventiumGlassHiveCallbackDelivery.findOne(constraint),
        session,
      );
      const question = current && (await exactNativeInputPresentation(current, session, true));
      if (!question) return null;
      current = question.delivery;
      if (new Date(current.dispatchPermitExpiresAt).getTime() > now.getTime())
        return toDispatchPermit(current);
      const row = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
        {
          ...constraint,
          dispatchPermitId: current.dispatchPermitId || '',
          dispatchPermitGeneration: current.dispatchPermitGeneration || 0,
        },
        {
          $set: {
            dispatchPermitId: crypto.randomUUID().replaceAll('-', ''),
            dispatchPermitGeneration: (current.dispatchPermitGeneration || 0) + 1,
            dispatchPermitExpiresAt: new Date(
              Math.min(
                now.getTime() + durationMs,
                Date.parse(current.nativeInputBinding.expiresAt),
              ),
            ),
          },
        },
        { new: true, session },
      ).lean();
      return toDispatchPermit(row);
    }, initial);
    if (!permitted) await markSupersededDelivery(initial.deliveryId);
    return permitted;
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
    await runGlassHiveTerminalCallbackTransaction(
      async (session) => {
        const current = await ViventiumGlassHiveCallbackDelivery.findOne({
          ...constraint,
          dispatchPermitExpiresAt: { $gt: now },
        })
          .session(session)
          .lean();
        if (!current || !presentedDispatchPermitMatches(current, dispatchPermit)) {
          throw new Error('glasshive_callback_delivery_dispatch_permit_invalid');
        }
        const question = nativeWorkInputPresentation(current);
        if (question) {
          if (!(await exactNativeInputPresentation(current, session)))
            throw new Error('glasshive_callback_delivery_dispatch_fenced');
          await fenceGlassHiveCallbackRunState({
            binding: {
              ownerId: current.userId,
              originRef: current.originRef,
              workRef: current.workRef,
            },
            body: { event: current.event, worker_id: current.workerId, run_id: current.runId },
            effectSession: session,
          });
        }
        const presentation =
          plainWorkerCompletionPresentation(current) ||
          (hasWorkerAttention(current) ? workerBindingPresentation(current) : null);
        const leases = question
          ? []
          : presentation
            ? workerCompletionEffectLeases(current)
            : [dispatchPermitLease(current)];
        if (
          (presentation &&
            (!(await exactCanonicalWorkerDelivery(current, session)) ||
              !(await workerCompletionLeasesAreCurrent(current, leases, now, session)))) ||
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
        const expiresAt = new Date(
          question
            ? Math.min(now.getTime() + durationMs, Date.parse(question.binding.expiresAt))
            : now.getTime() + durationMs,
        );
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
      },
      { retry: 'native' },
    );
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
    const presentation =
      plainWorkerCompletionPresentation(current) ||
      (hasWorkerAttention(current) ? workerBindingPresentation(current) : null);
    const leases = nativeWorkInputPresentation(current, { allowExpired: true })
      ? []
      : presentation
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
          dispatchPermitGeneration: nativeWorkInputPresentation(current, { allowExpired: true })
            ? current.dispatchPermitGeneration
            : 0,
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
    ...(isWorkerAttentionBinding(binding)
      ? {}
      : { attemptRef: `${binding.runId}:${binding.attemptNumber}` }),
    responseRef: presentation.responseMessageId,
    presentationRef: presentation.presentationRef,
    surface: 'voice',
    effectCount: 1,
  };
}

async function recordWorkerCompletionStageTrace({ delivery, presentation, stage, at }) {
  const inputs = presentation.bindings.map((binding) => ({
    ownerId: normalizeText(delivery.userId),
    callSessionId: presentation.callSessionId,
    turnId: presentation.turnId,
    eventRef: `${presentation.presentationRef}:${binding.workRef}:${stage}`,
    stage,
    at: new Date(at.getTime()),
    facts: workerCompletionTraceFacts(delivery, presentation, binding),
  }));
  const record = async () => {
    for (const input of inputs) await recordVoiceOrchestrationTraceBestEffort(input);
  };
  if (!deferGlassHiveTerminalCallbackAfterCommit(record)) await record();
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
      const presentation = await exactCanonicalWorkerCompletionPresentation(current, session, true);
      const leases = workerCompletionEffectLeases(current);
      if (
        !current ||
        !presentation ||
        normalizeText(presentationRef) !== normalizeText(presentation.presentationRef) ||
        !presentedDispatchPermitMatches(current, dispatchPermit) ||
        !Array.isArray(leases) ||
        !(await workerCompletionLeasesAreCurrent(current, leases, now, session, true))
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

async function settleWorkerAttentionDelivery(current, constraint, dispatchPermit, updates, now) {
  let settled = null;
  await runGlassHiveTerminalCallbackTransaction(async (session) => {
    const row = await queryLean(
      ViventiumGlassHiveCallbackDelivery.findOne({
        ...constraint,
        dispatchPermitExpiresAt: { $gt: now },
      }),
      session,
    );
    if (
      !row ||
      !presentedDispatchPermitMatches(row, dispatchPermit) ||
      !(await exactCanonicalWorkerAttentionDelivery(row, session, true))
    )
      return;
    const leases = workerCompletionEffectLeases(row);
    if (!(await workerCompletionLeasesAreCurrent(row, leases, now, session, true))) return;
    for (const lease of leases)
      if (
        !(await fenceGlassHiveTerminalCallbackEffectTransaction({
          ResultModel: GlassHiveTerminalCallbackResult,
          lease,
          session,
          now,
        }))
      )
        return;
    settled = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
      {
        ...constraint,
        dispatchPermitId: row.dispatchPermitId,
        dispatchPermitGeneration: row.dispatchPermitGeneration,
        dispatchPermitExpiresAt: { $gt: now },
      },
      {
        $set: {
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
    if (!settled) return;
    for (const lease of leases)
      if (
        !(await releaseGlassHiveTerminalCallbackEffectLease({
          ResultModel: GlassHiveTerminalCallbackResult,
          lease,
          session,
        }))
      )
        throw new Error('glasshive_callback_delivery_dispatch_fenced');
    await recordTraceDelivery(toDispatchPayload(settled), updates.status, now);
  });
  return settled;
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
  if (hasWorkerAttention(current)) {
    const filter = deliveryConstraintFilter({ deliveryId, claimId, userId, voiceCallSessionId });
    await recordObservedTelegramMessageIds(current, filter, dispatchPermit, normalizedMessageIds);
    const settled = await settleWorkerAttentionDelivery(
      current,
      filter,
      dispatchPermit,
      {
        status: 'sent',
        sentAt: now,
        lastError: '',
        ...(normalizedMessageIds.length
          ? {
              telegramSentMessageIds: normalizedMessageIds,
              telegramMessageId: normalizedMessageIds[normalizedMessageIds.length - 1],
              transportReceiptVersion: 1,
            }
          : {}),
      },
      now,
    );
    await recordSurfaceOutcomeBestEffort(settled?.originRef, 'sent', settled);
    return toDispatchPayload(settled);
  }
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
  if (
    nativeWorkInputPresentation(current, { allowExpired: true }) &&
    (!presentedDispatchPermitMatches(current, dispatchPermit) ||
      !(new Date(current.dispatchPermitExpiresAt).getTime() > now.getTime()) ||
      !(await exactNativeInputPresentation(current)))
  )
    return null;
  let doc;
  try {
    doc = await transactionallyFencePersistedDelivery(async (session) => {
      if (
        nativeWorkInputPresentation(current, { allowExpired: true }) &&
        !(await exactNativeInputPresentation(current, session))
      )
        return null;
      return ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
        {
          ...deliveryConstraintFilter({ deliveryId, claimId, userId, voiceCallSessionId }),
          ...(nativeWorkInputPresentation(current, { allowExpired: true })
            ? {
                dispatchPermitId: current.dispatchPermitId,
                dispatchPermitGeneration: current.dispatchPermitGeneration,
                dispatchPermitExpiresAt: { $gt: now },
              }
            : {}),
        },
        {
          $set: {
            status: 'sent',
            sentAt: now,
            dispatchPermitId: '',
            dispatchPermitGeneration: 0,
            dispatchPermitExpiresAt: null,
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
        { new: true, session },
      ).lean();
    }, current);
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
        !(await workerCompletionLeasesAreCurrent(current, leases, now, session, true))
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

async function recordObservedTelegramMessageIds(candidate, filter, dispatchPermit, messageIds) {
  if (
    !messageIds.length ||
    candidate?.surface !== 'telegram' ||
    !presentedDispatchPermitMatches(candidate, dispatchPermit)
  )
    return;
  const issuedIdentity = { ...filter, surface: 'telegram' };
  for (const field of [
    'userId',
    'telegramChatId',
    'telegramUserId',
    'telegramMessageThreadId',
    'callbackMessageId',
    'logicalMessageId',
    'dispatchPermitId',
    'dispatchPermitGeneration',
    'terminalCallbackResultKey',
    'terminalCallbackAcceptedOperationId',
    'terminalCallbackId',
    'terminalCallbackResultRevision',
    'terminalCallbackResultDigest',
  ]) {
    issuedIdentity[field] = candidate[field] === undefined ? { $exists: false } : candidate[field];
  }
  issuedIdentity.workerCompletionPresentation = candidate.workerCompletionPresentation ?? null;
  // An observed receipt is data about an issued transport attempt, not permission to send
  // or settle. Preserve it before an expired/fenced settlement clears its issued proof.
  await ViventiumGlassHiveCallbackDelivery.updateOne(issuedIdentity, {
    $addToSet: { telegramSentMessageIds: { $each: messageIds } },
    $set: {
      telegramMessageId: messageIds[messageIds.length - 1],
      transportReceiptVersion: 1,
    },
  });
}

async function markGlassHiveCallbackDeliveryUnknown({
  deliveryId,
  claimId,
  dispatchPermit = null,
  reason = 'telegram_delivery_status_unknown',
  userId = '',
  voiceCallSessionId = '',
  telegramMessageIds = [],
  requireIssuedPermit = false,
}) {
  const now = nowDate();
  const normalizedMessageIds = normalizeTelegramMessageIds(telegramMessageIds);
  const filter = deliveryConstraintFilter({ deliveryId, claimId, userId, voiceCallSessionId });
  const candidateQuery = ViventiumGlassHiveCallbackDelivery.findOne(filter);
  const candidate = candidateQuery?.lean ? await candidateQuery.lean() : await candidateQuery;
  if (
    requireIssuedPermit &&
    (!toDispatchPermit(candidate) ||
      !presentedDispatchPermitMatches(candidate, dispatchPermit) ||
      !(new Date(candidate?.dispatchPermitExpiresAt).getTime() > now.getTime()))
  ) {
    return null;
  }
  if (
    nativeWorkInputPresentation(candidate, { allowExpired: true }) &&
    candidate.dispatchPermitId &&
    !presentedDispatchPermitMatches(candidate, dispatchPermit)
  )
    return null;
  await recordObservedTelegramMessageIds(candidate, filter, dispatchPermit, normalizedMessageIds);
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
  if (hasWorkerAttention(candidate) && !plainWorkerCompletionPresentation(candidate)) {
    const settled = await settleWorkerAttentionDelivery(
      candidate,
      filter,
      dispatchPermit,
      {
        status: 'delivery_unknown',
        unknownAt: now,
        nextAttemptAt: null,
        lastError: redactDeliveryError(reason).slice(0, MAX_LAST_ERROR_LENGTH),
      },
      now,
    );
    await recordSurfaceOutcomeBestEffort(settled?.originRef, 'unknown', settled);
    return toDispatchPayload(settled);
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
      (session) =>
        ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
          filter,
          {
            $set: {
              status: 'delivery_unknown',
              unknownAt: now,
              dispatchPermitId: '',
              dispatchPermitGeneration: 0,
              dispatchPermitExpiresAt: null,
              projectionPendingAt: now,
              projectionNextAttemptAt: now,
              leaseExpiresAt: null,
              nextAttemptAt: null,
              lastError: redactDeliveryError(reason).slice(0, MAX_LAST_ERROR_LENGTH),
            },
          },
          { new: true, session },
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
    $nor: [
      {
        projectionPendingAt: null,
        projectionErrorCode: {
          $in: [
            'voice_worker_completion_presentation_superseded',
            'worker_completion_presentation_superseded',
            'worker_completion_presentation_tombstoned',
          ],
        },
      },
    ],
    $or: [
      {
        workerCompletionProjectionAppliedAt: null,
        status: { $in: ['sent', 'failed', 'suppressed', 'unresolved', 'delivery_unknown'] },
        $and: [
          {
            $or: [
              { workerCompletionPresentation: { $ne: null } },
              { 'workerCompletionBindings.0': { $exists: true } },
            ],
          },
          { $or: [{ projectionNextAttemptAt: null }, { projectionNextAttemptAt: { $lte: now } }] },
        ],
      },
      {
        surface: 'voice',
        status: 'pending',
        workerCompletionPresentation: { $ne: null },
        $or: [{ projectionNextAttemptAt: null }, { projectionNextAttemptAt: { $lte: now } }],
      },
      {
        surface: 'voice',
        status: 'pending',
        event: 'run.needs_input',
        'nativeInputBinding.version': 1,
        $or: [{ projectionNextAttemptAt: null }, { projectionNextAttemptAt: { $lte: now } }],
      },
      {
        projectionPendingAt: { $ne: null },
        $or: [{ projectionNextAttemptAt: null }, { projectionNextAttemptAt: { $lte: now } }],
      },
      { projectionPendingAt: null, projectionAppliedAt: null },
      {
        surface: 'voice',
        status: 'pending',
        event: { $in: ['run.failed', 'run.cancelled', 'run.interrupted'] },
        claimId: { $in: ['', null] },
        claimedAt: null,
        dispatchPermitId: { $in: ['', null] },
        $or: [{ projectionNextAttemptAt: null }, { projectionNextAttemptAt: { $lte: now } }],
      },
    ],
  })
    .sort({ projectionNextAttemptAt: 1, projectionPendingAt: 1, updatedAt: 1 })
    .limit(safeLimit)
    .lean();
  const origins = new Map();
  for (let row of Array.isArray(rows) ? rows : []) {
    row = await settleEndedCallNeutralDelivery(row);
    await publishPendingWorkerCompletionDelivery(row);
    const originRef = normalizeText(row?.originRef);
    if (
      originRef &&
      !origins.has(originRef) &&
      (row.projectionPendingAt ||
        !row.projectionAppliedAt ||
        ((plainWorkerCompletionPresentation(row) || row.workerCompletionBindings?.length) &&
          !row.workerCompletionProjectionAppliedAt &&
          !['pending', 'claimed'].includes(row.status)) ||
        pendingNeutralVoiceDelivery(row))
    ) {
      origins.set(originRef, row);
    }
  }
  let projected = 0;
  let pending = 0;
  for (const [originRef, row] of origins) {
    const accepted = await recordSurfaceOutcomeBestEffort(originRef, row.status, row);
    if (accepted) projected += 1;
    else pending += 1;
    if (pendingNeutralVoiceDelivery(row)) {
      await ViventiumGlassHiveCallbackDelivery.updateOne(
        { deliveryId: row.deliveryId, status: 'pending' },
        { $set: { projectionNextAttemptAt: new Date(now.getTime() + PROJECTION_RETRY_MS) } },
      );
    }
  }
  const discoveryIds = (Array.isArray(rows) ? rows : [])
    .filter(
      (row) =>
        row.surface === 'voice' &&
        row.status === 'pending' &&
        plainWorkerCompletionPresentation(row),
    )
    .map((row) => row.deliveryId);
  if (discoveryIds.length) {
    try {
      await ViventiumGlassHiveCallbackDelivery.updateMany(
        { deliveryId: { $in: discoveryIds }, surface: 'voice', status: 'pending' },
        { $set: { projectionNextAttemptAt: new Date(now.getTime() + PROJECTION_RETRY_MS) } },
      );
    } catch (error) {
      logger.warn('[VIVENTIUM][glasshive-delivery] Voice discovery recovery backoff deferred', {
        code: error?.code || error?.name || 'backoff_failed',
      });
    }
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
  resolveGlassHiveVoicePresentation,
  authorizeGlassHiveCallbackDeliveryDispatch,
  completeGlassHiveWorkerCompletionPresentation,
  enqueueGlassHiveCallbackDelivery,
  claimPendingGlassHiveCallbackDeliveries,
  getSettledGlassHiveVoiceCallbackDelivery,
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
