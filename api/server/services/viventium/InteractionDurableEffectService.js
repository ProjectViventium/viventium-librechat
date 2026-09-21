/* === VIVENTIUM START ===
 * Feature: Provider-neutral durable interaction-effect owner.
 * Purpose: Reserve each trusted tool-call mutation in Mongo before provider dispatch, retain the
 * legacy provider key, commit Mongo truth before Redis projection, and fail closed on stale Voice
 * proof.
 * === VIVENTIUM END === */

const crypto = require('crypto');

const SUPPORTED_ADAPTERS = new Set(['glasshive.work_action.v1', 'glasshive.worker_delegate.v1']);
const SUPPORTED_EFFECT_KINDS = new Set(['durable_work_accepted', 'durable_work_action_accepted']);
const SUPPORTED_SURFACES = new Set(['web', 'telegram', 'voice', 'workbench']);
const SENSITIVE_RESULT_KEY = /password|secret|token|authorization|cookie|credential/i;
const DEFAULT_CLAIM_DURATION_MS = 30_000;
const MAX_REPLAY_JSON_CHARS = 16_000;

function durableEffectError(code, status = 409, retryable = false) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function boundedText(value, maxLength) {
  const text = String(value || '').trim();
  return text && text.length <= maxLength ? text : '';
}

function canonicalJson(value) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(null);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function effectKeyFor(identity) {
  return `effect_${sha256(
    `viventium.interaction-durable-effect.v1\u0000${canonicalJson(identity)}`,
  ).slice('sha256:'.length)}`;
}

function safeReplayValue(value, depth = 0) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, 4_000);
  if (depth >= 5) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => safeReplayValue(item, depth + 1));
  }
  if (typeof value !== 'object') return null;
  const entries = Object.entries(value)
    .filter(([key]) => !SENSITIVE_RESULT_KEY.test(key))
    .slice(0, 80)
    .map(([key, item]) => [key.slice(0, 120), safeReplayValue(item, depth + 1)]);
  return Object.fromEntries(entries);
}

function boundedReplayResult(value) {
  const safe = safeReplayValue(value);
  const encoded = canonicalJson(safe);
  if (encoded.length <= MAX_REPLAY_JSON_CHARS) return safe;
  return { status: 'committed', resultTruncated: true, resultSha256: sha256(encoded) };
}

function voiceSegmentDigest(segments, voiceTurnId) {
  const rows = (Array.isArray(segments) ? segments : [])
    .filter((segment) => String(segment?.turnId || '') === voiceTurnId)
    .map((segment) => ({
      segmentId: boundedText(segment?.segmentId, 160),
      revision: Number(segment?.revision),
      turnId: boundedText(segment?.turnId, 160),
      isFinal: segment?.isFinal === true,
      overlap: segment?.overlap === true,
      uncertain: segment?.uncertain === true,
      participantDigest: sha256(boundedText(segment?.speaker?.participantIdentity, 160)),
      attribution: boundedText(segment?.speaker?.attribution, 40),
      actorTrust: boundedText(segment?.speaker?.actorTrust, 40),
    }))
    .filter(
      (segment) =>
        segment.segmentId && Number.isSafeInteger(segment.revision) && segment.revision >= 0,
    )
    .sort(
      (left, right) =>
        left.segmentId.localeCompare(right.segmentId) || left.revision - right.revision,
    );
  return rows.length ? sha256(canonicalJson(rows)) : '';
}

function createVoiceDurableEffectAuthorityBinding({ session, segments, engagement } = {}) {
  const callSessionId = boundedText(session?.callSessionId, 160);
  const userId = boundedText(session?.userId, 160);
  const mode = ['call', 'wing'].includes(session?.mode) ? session.mode : '';
  const voiceTurnId = boundedText(segments?.[0]?.turnId || engagement?.turnId, 160);
  const callModeRevision = Number.isFinite(Number(session?.revision))
    ? Number(session.revision)
    : 0;
  const speakerSessionRevision = Number.isFinite(Number(session?.speakerSessionRevision))
    ? Number(session.speakerSessionRevision)
    : 0;
  const ownerParticipant = boundedText(session?.ownerParticipantIdentity, 160);
  const segmentRevisionDigest = voiceSegmentDigest(segments, voiceTurnId);
  if (
    !callSessionId ||
    !userId ||
    !mode ||
    !voiceTurnId ||
    !ownerParticipant ||
    !segmentRevisionDigest ||
    !Number.isSafeInteger(callModeRevision) ||
    callModeRevision < 0 ||
    !Number.isSafeInteger(speakerSessionRevision) ||
    speakerSessionRevision < 0
  ) {
    return null;
  }
  const engagementExpiresAt = Number(engagement?.expiresAtMs);
  const engagementDigest =
    mode === 'wing'
      ? sha256(
          canonicalJson({
            turnId: boundedText(engagement?.turnId, 160),
            expiresAtMs: engagementExpiresAt,
            assertionDigest: sha256(
              boundedText(
                engagement?.assertion || engagement?.attestation || engagement?.signature,
                2_048,
              ),
            ),
          }),
        )
      : '';
  if (mode === 'wing' && (!engagementDigest || !Number.isFinite(engagementExpiresAt))) {
    return null;
  }
  const voice = {
    callSessionId,
    voiceTurnId,
    mode,
    callModeRevision,
    speakerSessionRevision,
    segmentRevisionDigest,
    ownerParticipantDigest: sha256(ownerParticipant),
    ...(engagementDigest
      ? { engagementDigest, engagementExpiresAt: new Date(engagementExpiresAt).toISOString() }
      : {}),
  };
  return {
    version: 1,
    userId,
    voiceAuthorityRef: `voice_authority_${sha256(canonicalJson(voice)).slice('sha256:'.length)}`,
    voice,
  };
}

function plainRow(row) {
  if (!row) return null;
  return typeof row.toObject === 'function' ? row.toObject() : row;
}

function deliveryAcknowledgementMatches(stored, expected) {
  return (
    stored?.state === expected.state &&
    stored?.effectRef === expected.effectRef &&
    stored?.logicalTurnId === expected.logicalTurnId &&
    Number(stored?.revision) === expected.revision &&
    stored?.surface === expected.surface &&
    String(stored?.presentationRef || '') === String(expected.presentationRef || '')
  );
}

function deliveryResultFromRow(row, acknowledgement, idempotent) {
  const recordedAt = new Date(row.deliveryAcknowledgement.recordedAt).getTime();
  return {
    status: 'recorded',
    acknowledgement: {
      logical_turn_id: acknowledgement.logicalTurnId,
      revision: acknowledgement.revision,
      state: 'committed_effect',
      effect_ref: acknowledgement.effectRef,
      ...(acknowledgement.presentationRef
        ? { presentation_ref: acknowledgement.presentationRef }
        : {}),
      ...(Number.isFinite(recordedAt) ? { presentation_committed_at: recordedAt } : {}),
    },
    idempotent,
    presentation: {
      userId: row.ownerId,
      conversationId: row.conversationId,
      responseMessageId: row.responseMessageId,
      interactionContext: {
        origin: 'interactive',
        surface: row.surface,
        conversation_id: row.conversationId,
        logical_turn_id: row.logicalTurnId,
        revision: row.logicalTurnRevision,
        source_event_id: row.sourceEventId,
      },
    },
  };
}

function rowMatchesIdentity(row, identity) {
  const sharedIdentityMatches =
    row?.ownerId === identity.ownerId &&
    row?.conversationId === identity.conversationId &&
    row?.logicalTurnId === identity.logicalTurnId &&
    Number(row?.logicalTurnRevision) === identity.logicalTurnRevision &&
    Number(row?.effectOrdinal) === identity.effectOrdinal &&
    row?.sourceEventId === identity.sourceEventId &&
    Number(row?.sourceRevision) === identity.sourceRevision &&
    row?.responseMessageId === identity.responseMessageId &&
    row?.surface === identity.surface &&
    row?.effectKind === identity.effectKind &&
    row?.adapterId === identity.adapterId &&
    row?.routeId === identity.routeId &&
    row?.operation === identity.operation &&
    row?.canonicalArgsSha256 === identity.canonicalArgsSha256 &&
    row?.providerIdempotencyKey === identity.providerIdempotencyKey &&
    row?.providerIdempotencyMode === identity.providerIdempotencyMode &&
    String(row?.voiceAuthorityRef || '') === String(identity.voiceAuthorityRef || '');
  if (!sharedIdentityMatches) return false;
  const storedOccurrenceRef = String(row?.effectOccurrenceRef || '');
  if (!storedOccurrenceRef) {
    // Rows created before occurrence-scoped identity had one ordinal-zero slot per turn. The
    // unchanged provider key and complete legacy identity are sufficient to replay that exact
    // pre-upgrade mutation; a sibling occurrence has a different provider key and stays fenced.
    return Number(row?.effectOrdinal) === 0;
  }
  return (
    row?.effectKey === identity.effectKey && storedOccurrenceRef === identity.effectOccurrenceRef
  );
}

function createInteractionDurableEffectService({
  EffectModel,
  generationJobManager,
  getCallSession,
  listSpeakerSegments,
  now = () => new Date(),
  createClaimToken = () => crypto.randomUUID(),
  claimDurationMs = DEFAULT_CLAIM_DURATION_MS,
} = {}) {
  if (!EffectModel || !generationJobManager || !getCallSession || !listSpeakerSegments) {
    throw durableEffectError('durable_effect_service_not_configured', 503, true);
  }

  async function assertFreshVoiceAuthority(binding, ownerId) {
    if (!binding || binding.version !== 1 || binding.userId !== ownerId || !binding.voice) {
      throw durableEffectError('durable_effect_voice_authority_missing', 403, false);
    }
    const currentSession = await getCallSession(binding.voice.callSessionId);
    if (!currentSession) {
      throw durableEffectError('durable_effect_voice_authority_stale', 409, false);
    }
    const currentSegments = await listSpeakerSegments({
      callSessionId: binding.voice.callSessionId,
      limit: 512,
    });
    const currentDigest = voiceSegmentDigest(currentSegments, binding.voice.voiceTurnId);
    const expiresAt = new Date(binding.voice.engagementExpiresAt || 0).getTime();
    const mismatched =
      currentSession.userId !== ownerId ||
      currentSession.mode !== binding.voice.mode ||
      Number(currentSession.revision) !== Number(binding.voice.callModeRevision) ||
      Number(currentSession.speakerSessionRevision) !==
        Number(binding.voice.speakerSessionRevision) ||
      sha256(boundedText(currentSession.ownerParticipantIdentity, 160)) !==
        binding.voice.ownerParticipantDigest ||
      currentDigest !== binding.voice.segmentRevisionDigest ||
      ['ended', 'failed'].includes(String(currentSession.status || '')) ||
      (binding.voice.mode === 'wing' &&
        (!binding.voice.engagementDigest ||
          !Number.isFinite(expiresAt) ||
          expiresAt <= now().getTime()));
    if (mismatched) {
      throw durableEffectError('durable_effect_voice_authority_stale', 409, false);
    }
  }

  async function authoritativeIdentity(input) {
    const streamId = boundedText(input?.streamId, 256);
    const ownerId = boundedText(input?.userId, 160);
    const adapterId = boundedText(input?.adapterId, 120);
    const routeId = boundedText(input?.routeId, 120);
    const operation = boundedText(input?.operation, 120);
    const providerIdempotencyKey = boundedText(input?.providerIdempotencyKey, 256);
    const effectOccurrenceRef = boundedText(input?.effectOccurrenceRef, 256);
    const effectOrdinal = Number(input?.effectOrdinal);
    if (
      !streamId ||
      !ownerId ||
      effectOrdinal !== 0 ||
      !SUPPORTED_EFFECT_KINDS.has(input?.effectKind) ||
      !SUPPORTED_ADAPTERS.has(adapterId) ||
      !routeId ||
      !operation ||
      !effectOccurrenceRef ||
      !providerIdempotencyKey ||
      !['native_key', 'deterministic_reconciliation'].includes(input?.providerIdempotencyMode) ||
      !input?.canonicalArgs ||
      typeof input.canonicalArgs !== 'object'
    ) {
      throw durableEffectError('durable_effect_invalid_input', 400, false);
    }
    const job = await generationJobManager.getJob(streamId);
    const metadata = job?.metadata || {};
    const interaction = metadata.interactionContext || {};
    const conversationId = boundedText(metadata.conversationId || interaction.conversation_id, 256);
    const responseMessageId = boundedText(metadata.responseMessageId, 256);
    const logicalTurnId = boundedText(interaction.logical_turn_id, 256);
    const sourceEventId = boundedText(interaction.source_event_id, 512);
    const revision = Number(interaction.revision);
    const surface = boundedText(interaction.surface, 32);
    if (!job) throw durableEffectError('durable_effect_job_missing', 409, true);
    if (metadata.userId !== ownerId) {
      throw durableEffectError('durable_effect_owner_mismatch', 403, false);
    }
    if (
      !conversationId ||
      !responseMessageId ||
      !logicalTurnId ||
      !sourceEventId ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !SUPPORTED_SURFACES.has(surface)
    ) {
      throw durableEffectError('durable_effect_job_binding_incomplete', 409, true);
    }
    const voiceAuthority = surface === 'voice' ? metadata.viventiumVoiceEffectAuthority : null;
    if (surface === 'voice') await assertFreshVoiceAuthority(voiceAuthority, ownerId);
    const canonicalArgsSha256 = sha256(canonicalJson(input.canonicalArgs));
    const effectIdentity = {
      ownerId,
      conversationId,
      logicalTurnId,
      logicalTurnRevision: revision,
      sourceEventId,
      sourceRevision: revision,
      responseMessageId,
      presentationRevision: revision,
      surface,
      effectOrdinal,
      effectOccurrenceRef,
      adapterId,
      routeId,
      operation,
      canonicalArgsSha256,
    };
    const effectKey = effectKeyFor(effectIdentity);
    return {
      ...effectIdentity,
      effectKey,
      effectKind: input.effectKind,
      providerIdempotencyKey,
      providerIdempotencyMode: input.providerIdempotencyMode,
      ...(voiceAuthority
        ? {
            voiceAuthorityRef: voiceAuthority.voiceAuthorityRef,
            voice: voiceAuthority.voice,
          }
        : {}),
      ...(input.runtimeBinding ? { runtimeBindingAtReserve: input.runtimeBinding } : {}),
    };
  }

  async function findConflict(identity) {
    return plainRow(
      await EffectModel.findOne({
        $or: [
          { effectKey: identity.effectKey },
          {
            ownerId: identity.ownerId,
            effectOccurrenceRef: identity.effectOccurrenceRef,
          },
          {
            adapterId: identity.adapterId,
            providerIdempotencyKey: identity.providerIdempotencyKey,
          },
        ],
      }).lean(),
    );
  }

  async function prepareDurableEffect(input) {
    const identity = await authoritativeIdentity(input);
    const claimToken = createClaimToken();
    const claimTokenHash = sha256(claimToken);
    const observedAt = now();
    const claimExpiresAt = new Date(observedAt.getTime() + claimDurationMs);
    try {
      await EffectModel.create({
        schemaVersion: 1,
        ...identity,
        status: 'reserved',
        claimRevision: 1,
        claimTokenHash,
        claimExpiresAt,
        attemptCount: 1,
        transitionRevision: 1,
        createdAt: observedAt,
        lastTransitionAt: observedAt,
      });
      return {
        decision: 'dispatch',
        effectKey: identity.effectKey,
        claimToken,
        providerIdempotencyKey: identity.providerIdempotencyKey,
      };
    } catch (error) {
      if (Number(error?.code) !== 11000) {
        throw durableEffectError('durable_effect_store_unavailable', 503, true);
      }
    }
    const existing = await findConflict(identity);
    if (!rowMatchesIdentity(existing, identity)) {
      throw durableEffectError('durable_effect_conflict', 409, false);
    }
    const persistedEffectKey = existing.effectKey;
    if (existing.status === 'committed') {
      return {
        decision: 'return_committed',
        effectKey: persistedEffectKey,
        providerIdempotencyKey: identity.providerIdempotencyKey,
        providerReceiptRef: existing.providerReceiptRef,
        replayResult: existing.replayResult,
      };
    }
    const expired = new Date(existing.claimExpiresAt || 0).getTime() <= observedAt.getTime();
    if (existing.status !== 'failed_without_effect' && !expired) {
      return {
        decision: 'in_progress',
        effectKey: persistedEffectKey,
        providerIdempotencyKey: identity.providerIdempotencyKey,
      };
    }
    const priorStatus = existing.status;
    const reclaimed = await EffectModel.findOneAndUpdate(
      {
        effectKey: persistedEffectKey,
        status: priorStatus,
        claimRevision: existing.claimRevision,
        ...(priorStatus === 'failed_without_effect'
          ? {}
          : { claimExpiresAt: { $lte: observedAt } }),
      },
      {
        $set: {
          status: 'reserved',
          claimTokenHash,
          claimExpiresAt,
          failureCode: null,
          failedAt: null,
          lastTransitionAt: observedAt,
        },
        $inc: { claimRevision: 1, attemptCount: 1, transitionRevision: 1 },
      },
      { new: true },
    ).lean();
    if (!reclaimed) {
      return {
        decision: 'in_progress',
        effectKey: persistedEffectKey,
        providerIdempotencyKey: identity.providerIdempotencyKey,
      };
    }
    return {
      decision: priorStatus === 'failed_without_effect' ? 'dispatch' : 'reconcile',
      effectKey: persistedEffectKey,
      claimToken,
      providerIdempotencyKey: identity.providerIdempotencyKey,
    };
  }

  async function commitDurableEffect({
    effectKey,
    claimToken,
    providerReceiptRef,
    replayResult,
    runtimeBinding,
  } = {}) {
    const normalizedEffectKey = boundedText(effectKey, 80);
    const normalizedReceiptRef = boundedText(providerReceiptRef, 256);
    if (!normalizedEffectKey || !claimToken || !normalizedReceiptRef) {
      throw durableEffectError('durable_effect_commit_invalid', 400, false);
    }
    const safeReplayResult = boundedReplayResult(replayResult);
    const providerResultSha256 = sha256(canonicalJson(safeReplayResult));
    const observedAt = now();
    const committed = await EffectModel.findOneAndUpdate(
      {
        effectKey: normalizedEffectKey,
        status: { $in: ['reserved', 'provider_outcome_unknown'] },
        claimTokenHash: sha256(claimToken),
      },
      {
        $set: {
          status: 'committed',
          providerReceiptRef: normalizedReceiptRef,
          providerResultSha256,
          replayResult: safeReplayResult,
          committedAt: observedAt,
          claimExpiresAt: null,
          lastTransitionAt: observedAt,
          ...(runtimeBinding ? { lastAttemptRuntimeBinding: runtimeBinding } : {}),
        },
        $unset: { failureCode: '', failedAt: '' },
        $inc: { transitionRevision: 1 },
      },
      { new: true },
    ).lean();
    if (committed) return plainRow(committed);
    const existing = plainRow(await EffectModel.findOne({ effectKey: normalizedEffectKey }).lean());
    if (
      existing?.status === 'committed' &&
      existing.providerReceiptRef === normalizedReceiptRef &&
      existing.providerResultSha256 === providerResultSha256
    ) {
      return existing;
    }
    throw durableEffectError('durable_effect_commit_unconfirmed', 503, true);
  }

  async function settleDurableEffectFailure({
    effectKey,
    claimToken,
    outcome,
    failureCode,
    runtimeBinding,
  } = {}) {
    if (!['failed_without_effect', 'provider_outcome_unknown'].includes(outcome)) {
      throw durableEffectError('durable_effect_failure_invalid', 400, false);
    }
    const observedAt = now();
    const settled = await EffectModel.findOneAndUpdate(
      {
        effectKey: boundedText(effectKey, 80),
        status: 'reserved',
        claimTokenHash: sha256(claimToken),
      },
      {
        $set: {
          status: outcome,
          failureCode: boundedText(failureCode, 120) || 'provider_failure',
          failedAt: observedAt,
          lastTransitionAt: observedAt,
          ...(outcome === 'failed_without_effect' ? { claimExpiresAt: observedAt } : {}),
          ...(runtimeBinding ? { lastAttemptRuntimeBinding: runtimeBinding } : {}),
        },
        $inc: { transitionRevision: 1 },
      },
      { new: true },
    ).lean();
    if (!settled) {
      throw durableEffectError('durable_effect_failure_unconfirmed', 503, true);
    }
    return plainRow(settled);
  }

  async function acknowledgeDurableEffectDelivery(acknowledgement, adapterSurface) {
    const effectRef = boundedText(acknowledgement?.effect_ref, 256);
    const logicalTurnId = boundedText(acknowledgement?.logical_turn_id, 256);
    const revision = Number(acknowledgement?.revision);
    const presentationRef = boundedText(acknowledgement?.presentation_ref, 256);
    if (
      acknowledgement?.state !== 'committed' ||
      !effectRef ||
      !logicalTurnId ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !['telegram', 'voice'].includes(adapterSurface)
    ) {
      return { status: 'conflict' };
    }
    const expected = {
      state: 'committed_effect',
      effectRef,
      logicalTurnId,
      revision,
      surface: adapterSurface,
      ...(presentationRef ? { presentationRef } : {}),
    };
    const exactIdentity = {
      status: 'committed',
      providerReceiptRef: effectRef,
      logicalTurnId,
      logicalTurnRevision: revision,
      sourceRevision: revision,
      presentationRevision: revision,
      surface: adapterSurface,
    };
    const observedAt = now();
    const recorded = plainRow(
      await EffectModel.findOneAndUpdate(
        { ...exactIdentity, deliveryAcknowledgement: { $exists: false } },
        {
          $set: {
            deliveryAcknowledgement: { ...expected, recordedAt: observedAt },
            lastTransitionAt: observedAt,
          },
          $inc: { transitionRevision: 1 },
        },
        { new: true },
      ).lean(),
    );
    if (recorded) {
      return deliveryResultFromRow(recorded, expected, false);
    }
    const existing = plainRow(await EffectModel.findOne(exactIdentity).lean());
    if (!existing) return { status: 'conflict' };
    if (!deliveryAcknowledgementMatches(existing.deliveryAcknowledgement, expected)) {
      return {
        status: existing.deliveryAcknowledgement ? 'conflict' : 'retryable_conflict',
      };
    }
    return deliveryResultFromRow(existing, expected, true);
  }

  return {
    acknowledgeDurableEffectDelivery,
    prepareDurableEffect,
    commitDurableEffect,
    settleDurableEffectFailure,
  };
}

let defaultService;

function getDefaultService() {
  if (defaultService) return defaultService;
  const { GenerationJobManager } = require('@librechat/api');
  const { InteractionDurableEffect } = require('~/db/models');
  const { getCallSession } = require('./CallSessionService');
  const { listSpeakerSegments } = require('./SpeakerSegmentService');
  defaultService = createInteractionDurableEffectService({
    EffectModel: InteractionDurableEffect,
    generationJobManager: GenerationJobManager,
    getCallSession,
    listSpeakerSegments,
  });
  return defaultService;
}

async function prepareDurableEffect(input) {
  return getDefaultService().prepareDurableEffect(input);
}

async function commitDurableEffect(input) {
  return getDefaultService().commitDurableEffect(input);
}

async function settleDurableEffectFailure(input) {
  return getDefaultService().settleDurableEffectFailure(input);
}

async function acknowledgeDurableEffectDelivery(acknowledgement, adapterSurface) {
  return getDefaultService().acknowledgeDurableEffectDelivery(acknowledgement, adapterSurface);
}

async function ensureInteractionDurableEffectIndexes() {
  const { InteractionDurableEffect } = require('~/db/models');
  await InteractionDurableEffect.syncIndexes();
}

module.exports = {
  acknowledgeDurableEffectDelivery,
  commitDurableEffect,
  createInteractionDurableEffectService,
  createVoiceDurableEffectAuthorityBinding,
  ensureInteractionDurableEffectIndexes,
  prepareDurableEffect,
  settleDurableEffectFailure,
};
