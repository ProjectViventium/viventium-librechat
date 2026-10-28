'use strict';

/* === VIVENTIUM START ===
 * Feature: Durable late Cortex delivery to Telegram.
 * Purpose: Let the authenticated Telegram bridge discover and send a persisted Cortex follow-up
 * after the per-turn listener closes, while reusing the existing Cortex and logical-turn fences.
 * === VIVENTIUM END === */

const {
  GenerationJobManager,
  normalizeChannelInputMode,
  exactCortexTelegramAuthority,
  cortexTelegramPresentationProof,
  exactCortexTelegramPresentation,
  retainedCortexTelegramAcknowledgement,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const {
  Message,
  ViventiumCortexInsightDelivery,
  ViventiumTelegramIngressEvent,
} = require('~/db/models');
const { resolveTelegramMapping } = require('~/server/services/TelegramLinkService');
const {
  cortexInsightDeliveryService,
} = require('~/server/services/viventium/CortexInsightDeliveryService');
const {
  bindRecoveredCortexPresentationGeneration,
} = require('~/server/services/viventium/staleCortexMessageRecovery');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const DEFAULT_LEASE_MS = 120_000;
const MAX_LEASE_MS = 10 * 60_000;

function normalizeText(value) {
  return String(value || '').trim();
}

function boundedLimit(value) {
  return Math.max(1, Math.min(Number(value) || DEFAULT_LIMIT, MAX_LIMIT));
}

function boundedLeaseMs(value) {
  return Math.max(10_000, Math.min(Number(value) || DEFAULT_LEASE_MS, MAX_LEASE_MS));
}

function privateLean(query) {
  const selected = query?.select
    ? query.select(
        '+streamId +claimToken +presentationLeaseToken +presentationLeaseOwnerId ' +
          '+presentationLeaseClaimToken +presentationLeaseGeneration +presentationLeaseExpiresAt',
      )
    : query;
  return selected?.lean ? selected.lean() : selected;
}

function dispatchConflict(message = 'Cortex Telegram dispatch claim does not match current work') {
  const error = new Error(message);
  error.code = 'cortex_telegram_dispatch_claim_conflict';
  return error;
}

function publicPresentation(fence) {
  return {
    ownerId: normalizeText(fence?.ownerId),
    messageId: normalizeText(fence?.messageId),
    parentMessageId: normalizeText(fence?.parentMessageId),
    revision: Number(fence?.revision),
    generation: Number(fence?.generation),
    deliveryIds: Array.isArray(fence?.deliveryIds) ? [...fence.deliveryIds] : [],
    deliveryReceipts: Array.isArray(fence?.deliveryReceipts)
      ? fence.deliveryReceipts.map((receipt) => ({
          deliveryId: normalizeText(receipt?.deliveryId),
          graphResultHash: normalizeText(receipt?.graphResultHash),
        }))
      : [],
    claimToken: normalizeText(fence?.claimToken),
    presentationLeaseToken: normalizeText(fence?.presentationLeaseToken),
    surface: 'telegram',
  };
}

function publicClaim({ ownerId, messageId, parentMessageId, revision, claims }) {
  const exactClaims = Array.isArray(claims) ? [...claims] : [];
  const deliveryReceipts = exactClaims
    .map((claim) => ({
      deliveryId: normalizeText(claim?.deliveryId),
      graphResultHash: normalizeText(claim?.graphResultHash).toLowerCase(),
    }))
    .sort((left, right) => left.deliveryId.localeCompare(right.deliveryId));
  const generations = new Set(exactClaims.map((claim) => Number(claim?.claimGeneration)));
  const claimTokens = new Set(exactClaims.map((claim) => normalizeText(claim?.claimToken)));
  if (
    exactClaims.length === 0 ||
    generations.size !== 1 ||
    claimTokens.size !== 1 ||
    claimTokens.has('') ||
    deliveryReceipts.some(
      (receipt) => !receipt.deliveryId || !/^[a-f0-9]{64}$/.test(receipt.graphResultHash),
    )
  ) {
    throw dispatchConflict();
  }
  return {
    ownerId: normalizeText(ownerId),
    messageId: normalizeText(messageId),
    parentMessageId: normalizeText(parentMessageId),
    revision: Number(revision),
    generation: [...generations][0],
    deliveryIds: deliveryReceipts.map((receipt) => receipt.deliveryId),
    deliveryReceipts,
    claimToken: [...claimTokens][0],
    surface: 'telegram',
  };
}

function validCandidate(row, allowPresented = false) {
  return (
    normalizeText(row?.deliveryId) &&
    normalizeText(row?.userId) &&
    normalizeText(row?.conversationId) &&
    normalizeText(row?.parentMessageId) &&
    normalizeText(row?.persistedMessageId) &&
    normalizeText(row?.streamId) &&
    row?.surface === 'telegram' &&
    row?.persistenceStatus === 'persisted' &&
    Array.isArray(row?.requiredSurfaces) &&
    row.requiredSurfaces.includes('telegram') &&
    row?.presentedSurfaces?.includes('web') &&
    (allowPresented || !row?.presentedSurfaces?.includes('telegram'))
  );
}

function exactTelegramAuthority(input, allowPresented = false) {
  return validCandidate(input.candidate, allowPresented) && exactCortexTelegramAuthority(input);
}

function createCortexTelegramDeliveryDispatchService({
  DeliveryModel = ViventiumCortexInsightDelivery,
  MessageModel = Message,
  IngressModel = ViventiumTelegramIngressEvent,
  resolveTelegramMapping: resolveMapping = resolveTelegramMapping,
  jobManager = GenerationJobManager,
  deliveryService = cortexInsightDeliveryService,
  bindMessageGeneration = bindRecoveredCortexPresentationGeneration,
  readRetainedMainFinalState = (scope) =>
    require('./nativeResponseService').readRetainedMainFinalState(scope),
} = {}) {
  async function candidateRows(limit) {
    const checkedAt = new Date();
    const query = DeliveryModel.find({
      surface: 'telegram',
      persistenceStatus: 'persisted',
      requiredSurfaces: 'telegram',
      $and: [
        { presentedSurfaces: 'web' },
        { presentedSurfaces: { $ne: 'telegram' } },
        {
          $or: [
            { status: 'pending' },
            {
              status: 'claimed',
              leaseExpiresAt: { $lte: checkedAt },
              presentationLeaseToken: { $in: ['', null] },
            },
          ],
        },
        { $or: [{ recoveryEligibleAt: null }, { recoveryEligibleAt: { $lte: checkedAt } }] },
      ],
    });
    const selected = query?.select ? query.select('+streamId') : query;
    const sorted = selected?.sort ? selected.sort({ createdAt: 1, deliveryId: 1 }) : selected;
    const limited = sorted?.limit ? sorted.limit(Math.max(limit * 4, limit)) : sorted;
    return (await (limited?.lean ? limited.lean() : limited)) || [];
  }

  async function loadAuthority(candidate) {
    const parentQuery = MessageModel.findOne({
      user: normalizeText(candidate.userId),
      conversationId: normalizeText(candidate.conversationId),
      messageId: normalizeText(candidate.parentMessageId),
      isCreatedByUser: { $ne: true },
    });
    const followupQuery = MessageModel.findOne({
      user: normalizeText(candidate.userId),
      conversationId: normalizeText(candidate.conversationId),
      messageId: normalizeText(candidate.persistedMessageId),
      parentMessageId: normalizeText(candidate.parentMessageId),
      isCreatedByUser: { $ne: true },
      'metadata.viventium.type': 'cortex_followup',
    });
    const ingressQuery = IngressModel.findOne({
      streamId: normalizeText(candidate.streamId),
      conversationId: normalizeText(candidate.conversationId),
      libreChatUserId: normalizeText(candidate.userId),
      authorityBoundAt: { $type: 'date' },
    });
    const [parent, followup, ingress, job] = await Promise.all([
      parentQuery?.lean ? parentQuery.lean() : parentQuery,
      followupQuery?.lean ? followupQuery.lean() : followupQuery,
      ingressQuery?.lean ? ingressQuery.lean() : ingressQuery,
      jobManager.getJob(normalizeText(candidate.streamId)),
    ]);
    const mapping = ingress?.telegramUserId
      ? await resolveMapping({ telegramUserId: normalizeText(ingress.telegramUserId) })
      : null;
    const scope = {
      userId: normalizeText(candidate.userId),
      streamId: normalizeText(candidate.streamId),
      conversationId: normalizeText(candidate.conversationId),
      responseMessageId: normalizeText(candidate.parentMessageId),
      surface: 'telegram',
      includeSettled: true,
    };
    const retainedState = !job ? await readRetainedMainFinalState(scope) : null;
    const retained = retainedState?.state === 'complete' ? retainedState.final : null;
    return { parent, followup, ingress, mapping, job, retained, retainedState };
  }

  async function settleSupersededCandidate(candidate, authority) {
    if (
      authority.retainedState?.state !== 'superseded' ||
      authority.job ||
      !exactTelegramAuthority({ candidate, ...authority, retained: authority.retainedState.parent })
    )
      return false;
    const batch = await deliveryService.claimPendingByParent({
      ownerId: normalizeText(candidate.userId),
      parentMessageId: normalizeText(candidate.parentMessageId),
      surface: 'telegram',
      leaseMs: DEFAULT_LEASE_MS,
    });
    if (!batch?.claimed?.length) return true;
    const current = await loadAuthority(candidate);
    if (
      current.job ||
      current.retainedState?.state !== 'superseded' ||
      !exactTelegramAuthority({ candidate, ...current, retained: current.retainedState.parent })
    ) {
      await deliveryService.markFailed({
        ownerId: normalizeText(candidate.userId),
        claims: batch.claimed,
        reason: 'presentation_failed',
      });
      return false;
    }
    await deliveryService.markDropped({
      ownerId: normalizeText(candidate.userId),
      claims: batch.claimed,
      dropReason: 'conversation_moved_on',
    });
    return true;
  }

  async function deferCandidate(candidate) {
    await DeliveryModel.updateMany(
      {
        userId: normalizeText(candidate.userId),
        parentMessageId: normalizeText(candidate.parentMessageId),
        surface: 'telegram',
        status: { $in: ['pending', 'claimed'] },
        presentationLeaseToken: { $in: ['', null] },
      },
      { $set: { recoveryEligibleAt: new Date(Date.now() + 30_000) } },
    );
  }

  async function recordPresentationProof(message, authority) {
    const previous = message?.metadata?.viventium?.cortexTelegramPresentation;
    const proof = cortexTelegramPresentationProof(message, authority);
    const result = await MessageModel.updateOne(
      {
        user: authority.ownerId,
        conversationId: message.conversationId,
        messageId: authority.messageId,
        parentMessageId: authority.parentMessageId,
        text: message.text,
        deletedAt: null,
        isCreatedByUser: false,
        unfinished: false,
        error: { $ne: true },
        'metadata.viventium.messageRevision': authority.revision,
        'metadata.viventium.cortexPresentationGeneration': authority.generation,
        'metadata.viventium.cortexPresentationClaimToken': authority.claimToken,
        ...(previous
          ? { 'metadata.viventium.cortexTelegramPresentation': previous }
          : {
              'metadata.viventium.cortexTelegramPresentation': { $exists: false },
            }),
      },
      { $set: { 'metadata.viventium.cortexTelegramPresentation': proof } },
    );
    if (Number(result?.matchedCount ?? result?.n ?? 0) !== 1) throw dispatchConflict();
    return proof;
  }

  async function claimCandidate(candidate, leaseMs) {
    let claimed = null;
    try {
      const authority = await loadAuthority(candidate);
      if (!exactTelegramAuthority({ candidate, ...authority })) {
        if (!(await settleSupersededCandidate(candidate, authority)))
          await deferCandidate(candidate);
        return null;
      }
      claimed = await deliveryService.claimPendingByParent({
        ownerId: normalizeText(candidate.userId),
        parentMessageId: normalizeText(candidate.parentMessageId),
        surface: 'telegram',
        leaseMs,
      });
      const claims = Array.isArray(claimed?.claimed) ? claimed.claimed : [];
      const persistedIds = new Set(claims.map((row) => normalizeText(row?.persistedMessageId)));
      const exactClaims =
        claims.length > 0 &&
        persistedIds.size === 1 &&
        persistedIds.has(normalizeText(candidate.persistedMessageId)) &&
        claims.every(
          (row) =>
            row?.persistenceStatus === 'persisted' &&
            row?.status === 'claimed' &&
            normalizeText(row?.claimToken) === normalizeText(claimed.claimId) &&
            Number(row?.claimGeneration) === Number(claimed?.recoveryContext?.claimGeneration) &&
            Array.isArray(row?.requiredSurfaces) &&
            row.requiredSurfaces.includes('telegram') &&
            row?.presentedSurfaces?.includes('web') &&
            !row?.presentedSurfaces?.includes('telegram'),
        );
      if (
        !exactClaims ||
        normalizeText(claimed?.recoveryContext?.streamId) !== normalizeText(candidate.streamId)
      ) {
        throw dispatchConflict();
      }

      const revision = Math.max(
        1,
        Number(
          authority.followup?.metadata?.viventium?.messageRevision ??
            candidate.presentationRevision ??
            candidate.messageRevision,
        ) || 1,
      );
      const message = await bindMessageGeneration({
        ownerId: normalizeText(candidate.userId),
        conversationId: normalizeText(candidate.conversationId),
        message: authority.followup,
        revision,
        claimGeneration: Number(claimed.recoveryContext.claimGeneration),
        claimToken: normalizeText(claimed.claimId),
        parentMessageId: normalizeText(candidate.parentMessageId),
      });
      const cortexClaim = publicClaim({
        ownerId: candidate.userId,
        messageId: candidate.persistedMessageId,
        parentMessageId: candidate.parentMessageId,
        revision,
        claims,
      });
      await recordPresentationProof(message, cortexClaim);
      const refreshed = await loadAuthority(candidate);
      if (!exactTelegramAuthority({ candidate, ...refreshed })) throw dispatchConflict();
      const parentContext = authority.parent.metadata.viventium.interactionContext;
      return {
        deliveryId: normalizeText(cortexClaim.deliveryIds[0] || candidate.deliveryId),
        streamId: normalizeText(candidate.streamId),
        ...(authority.ingress.inputMode != null
          ? { inputMode: normalizeChannelInputMode(authority.ingress.inputMode) }
          : {}),
        telegramChatId: normalizeText(authority.ingress.telegramChatId),
        telegramUserId: normalizeText(authority.ingress.telegramUserId),
        telegramMessageId: normalizeText(authority.ingress.telegramMessageId),
        telegramMessageThreadId: normalizeText(authority.ingress.telegramMessageThreadId),
        sourceSequence: Number(authority.ingress.sourceSequence),
        text: String(message?.text || authority.followup.text),
        ...(message?.metadata?.viventium?.telegramDeliveryControls
          ? { deliveryControls: message.metadata.viventium.telegramDeliveryControls }
          : authority.followup?.metadata?.viventium?.telegramDeliveryControls
            ? { deliveryControls: authority.followup.metadata.viventium.telegramDeliveryControls }
            : {}),
        logicalTurnId: normalizeText(parentContext.logical_turn_id),
        logicalTurnRevision: Number(parentContext.revision),
        cortexClaim,
      };
    } catch (error) {
      if (Array.isArray(claimed?.claimed) && claimed.claimed.length > 0) {
        try {
          await deliveryService.markFailed({
            ownerId: normalizeText(candidate.userId),
            claims: claimed.claimed,
            reason: 'presentation_failed',
          });
        } catch (_settlementError) {
          logger.warn('[VIVENTIUM][cortex-telegram-dispatch] Claim release failed closed');
        }
      }
      await deferCandidate(candidate).catch(() => undefined);
      logger.warn('[VIVENTIUM][cortex-telegram-dispatch] Candidate could not be authorized', {
        errorClass: normalizeText(error?.code || error?.name || 'dispatch_authorization_failed'),
      });
      return null;
    }
  }

  async function claimPending({ limit = DEFAULT_LIMIT, leaseMs = DEFAULT_LEASE_MS } = {}) {
    const pageLimit = boundedLimit(limit);
    await settleExpiredAuthorizations({ limit: Math.min(pageLimit * 4, 100) });
    const rows = await candidateRows(pageLimit);
    const seenParents = new Set();
    const deliveries = [];
    for (const candidate of rows) {
      if (deliveries.length >= pageLimit) break;
      const parentKey = `${normalizeText(candidate?.userId)}\u0000${normalizeText(
        candidate?.parentMessageId,
      )}`;
      if (!validCandidate(candidate) || seenParents.has(parentKey)) continue;
      seenParents.add(parentKey);
      const delivery = await claimCandidate(candidate, boundedLeaseMs(leaseMs));
      if (delivery) deliveries.push(delivery);
    }
    return deliveries;
  }

  function normalizedReceipts(cortexAuthority) {
    return (
      Array.isArray(cortexAuthority?.deliveryReceipts) ? cortexAuthority.deliveryReceipts : []
    )
      .map((receipt) => ({
        deliveryId: normalizeText(receipt?.deliveryId),
        graphResultHash: normalizeText(receipt?.graphResultHash).toLowerCase(),
      }))
      .sort((left, right) => left.deliveryId.localeCompare(right.deliveryId));
  }

  async function exactLiveClaims(
    cortexAuthority,
    { requirePresentationLease = false, allowExpiredLease = false, allowPresented = false } = {},
  ) {
    const deliveryIds = Array.from(
      new Set(
        (Array.isArray(cortexAuthority?.deliveryIds) ? cortexAuthority.deliveryIds : [])
          .map(normalizeText)
          .filter(Boolean),
      ),
    ).sort();
    const receipts = normalizedReceipts(cortexAuthority);
    const generation = Number(cortexAuthority?.generation);
    const revision = Number(cortexAuthority?.revision);
    const claimToken = normalizeText(cortexAuthority?.claimToken);
    const presentationLeaseToken = normalizeText(cortexAuthority?.presentationLeaseToken);
    const checkedAt = new Date();
    if (
      cortexAuthority?.surface !== 'telegram' ||
      deliveryIds.length === 0 ||
      receipts.length !== deliveryIds.length ||
      receipts.some(
        (receipt, index) =>
          receipt.deliveryId !== deliveryIds[index] ||
          !/^[a-f0-9]{64}$/.test(receipt.graphResultHash),
      ) ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !claimToken ||
      !normalizeText(cortexAuthority?.ownerId) ||
      !normalizeText(cortexAuthority?.parentMessageId) ||
      !normalizeText(cortexAuthority?.messageId) ||
      (requirePresentationLease && !presentationLeaseToken)
    ) {
      throw dispatchConflict();
    }
    const query = DeliveryModel.find({ deliveryId: { $in: deliveryIds } });
    const sorted = query?.sort ? query.sort({ deliveryId: 1 }) : query;
    const rows = (await privateLean(sorted)) || [];
    const ownerIds = new Set(rows.map((row) => normalizeText(row?.userId)));
    const parentIds = new Set(rows.map((row) => normalizeText(row?.parentMessageId)));
    const messageIds = new Set(rows.map((row) => normalizeText(row?.persistedMessageId)));
    const streamIds = new Set(rows.map((row) => normalizeText(row?.streamId)));
    const exact =
      rows.length === deliveryIds.length &&
      ownerIds.size === 1 &&
      ownerIds.has(normalizeText(cortexAuthority?.ownerId)) &&
      parentIds.size === 1 &&
      parentIds.has(normalizeText(cortexAuthority?.parentMessageId)) &&
      messageIds.size === 1 &&
      messageIds.has(normalizeText(cortexAuthority?.messageId)) &&
      streamIds.size === 1 &&
      !streamIds.has('') &&
      rows.every(
        (row, index) =>
          normalizeText(row?.deliveryId) === deliveryIds[index] &&
          normalizeText(row?.graphResultHash).toLowerCase() === receipts[index].graphResultHash &&
          row?.surface === 'telegram' &&
          (row?.status === 'claimed' || (allowPresented && row?.status === 'sent')) &&
          ((allowPresented && row?.status === 'sent') ||
            normalizeText(row?.claimToken) === claimToken) &&
          Number(row?.claimGeneration) === generation &&
          (allowExpiredLease ||
            (allowPresented && row?.status === 'sent') ||
            (row?.leaseExpiresAt instanceof Date &&
              row.leaseExpiresAt.getTime() > checkedAt.getTime())) &&
          Number(row?.presentationRevision ?? row?.messageRevision) === revision &&
          Number(row?.batchSize || 1) === rows.length &&
          row?.persistenceStatus === 'persisted' &&
          Array.isArray(row?.requiredSurfaces) &&
          row.requiredSurfaces.includes('telegram') &&
          row?.presentedSurfaces?.includes('web') &&
          (!presentationLeaseToken ||
            (allowPresented && row?.status === 'sent') ||
            (normalizeText(row?.presentationLeaseToken) === presentationLeaseToken &&
              normalizeText(row?.presentationLeaseOwnerId) === [...ownerIds][0] &&
              normalizeText(row?.presentationLeaseClaimToken) === claimToken &&
              Number(row?.presentationLeaseGeneration) === generation &&
              (allowExpiredLease ||
                (row?.presentationLeaseExpiresAt instanceof Date &&
                  row.presentationLeaseExpiresAt.getTime() > checkedAt.getTime())))) &&
          (allowPresented || !row?.presentedSurfaces?.includes('telegram')),
      );
    if (!exact) throw dispatchConflict();
    return {
      ownerId: [...ownerIds][0],
      streamId: [...streamIds][0],
      parentMessageId: [...parentIds][0],
      persistedMessageId: [...messageIds][0],
      revision,
      rows,
      claims: rows.map((row) => ({
        deliveryId: normalizeText(row.deliveryId),
        claimToken,
        claimGeneration: generation,
      })),
    };
  }

  async function authorizeClaim({ cortexClaim, leaseMs = DEFAULT_LEASE_MS } = {}) {
    const current = await exactLiveClaims(cortexClaim);
    const candidate = current.rows[0];
    const authority = await loadAuthority(candidate);
    if (
      !exactTelegramAuthority({ candidate, ...authority }) ||
      !exactCortexTelegramPresentation(authority.followup, cortexClaim)
    )
      throw dispatchConflict();
    const fence = await deliveryService.fencePresentation({
      ownerId: current.ownerId,
      claims: current.claims,
      surface: 'telegram',
      parentMessageId: current.parentMessageId,
      persistedMessageId: current.persistedMessageId,
      messageRevision: current.revision,
      leaseMs: boundedLeaseMs(leaseMs),
    });
    const presentation = publicPresentation(fence);
    await recordPresentationProof(authority.followup, presentation);
    if (authority.job) {
      const bound = await jobManager.bindCortexPresentation(current.streamId, presentation);
      if (!bound) throw dispatchConflict('Cortex Telegram stream presentation binding failed');
    }
    const refreshed = await loadAuthority(candidate);
    if (
      !exactTelegramAuthority({ candidate, ...refreshed }) ||
      !exactCortexTelegramPresentation(refreshed.followup, presentation, true)
    )
      throw dispatchConflict();
    return presentation;
  }

  async function acknowledgeRetained(acknowledgement, cortexPresentation) {
    if (
      acknowledgement.state !== 'committed' ||
      acknowledgement.effect_ref ||
      acknowledgement.source_kind === 'schedule_result'
    )
      return { status: 'not_found' };
    try {
      const current = await exactLiveClaims(cortexPresentation, {
        requirePresentationLease: true,
        allowPresented: true,
      });
      const candidate = current.rows[0];
      const authority = await loadAuthority(candidate);
      if (!validCandidate(candidate, true)) return { status: 'conflict' };
      return retainedCortexTelegramAcknowledgement({
        acknowledgement,
        presentation: cortexPresentation,
        authority: { candidate, ...authority },
        presented: current.rows.every((row) => row.presentedSurfaces?.includes('telegram')),
      });
    } catch (error) {
      if (error?.code === 'cortex_telegram_dispatch_claim_conflict') return { status: 'conflict' };
      throw error;
    }
  }

  async function failClaim({
    cortexClaim,
    cortexPresentation,
    reason = 'presentation_failed',
  } = {}) {
    if (reason !== 'presentation_failed') throw dispatchConflict();
    const current = await exactLiveClaims(cortexPresentation || cortexClaim);
    return deliveryService.markFailed({ ownerId: current.ownerId, claims: current.claims, reason });
  }

  async function suppressClaim({
    cortexClaim,
    cortexPresentation,
    dropReason = 'conversation_moved_on',
  } = {}) {
    if (dropReason !== 'conversation_moved_on') throw dispatchConflict();
    const current = await exactLiveClaims(cortexPresentation || cortexClaim);
    return deliveryService.markDropped({
      ownerId: current.ownerId,
      claims: current.claims,
      dropReason,
    });
  }

  async function markDeliveryUnknown({ cortexPresentation } = {}) {
    const current = await exactLiveClaims(cortexPresentation, {
      requirePresentationLease: true,
      allowExpiredLease: true,
    });
    return deliveryService.markDropped({
      ownerId: current.ownerId,
      claims: current.claims,
      dropReason: 'delivery_outcome_unknown',
      allowExpiredLease: true,
    });
  }

  async function settleExpiredAuthorizations({ limit = 100 } = {}) {
    const checkedAt = new Date();
    const query = DeliveryModel.find({
      surface: 'telegram',
      status: 'claimed',
      persistenceStatus: 'persisted',
      requiredSurfaces: 'telegram',
      leaseExpiresAt: { $lte: checkedAt },
      presentationLeaseToken: { $nin: ['', null] },
      $and: [{ presentedSurfaces: 'web' }, { presentedSurfaces: { $ne: 'telegram' } }],
    });
    const sorted = query?.sort ? query.sort({ createdAt: 1, deliveryId: 1 }) : query;
    const limited = sorted?.limit
      ? sorted.limit(Math.max(1, Math.min(Number(limit) || 100, 500)))
      : sorted;
    const rows = (await privateLean(limited)) || [];
    const groups = new Map();
    for (const row of rows) {
      const leaseExpiresAt = row?.leaseExpiresAt instanceof Date ? row.leaseExpiresAt : null;
      const token = normalizeText(row?.presentationLeaseToken);
      if (
        row?.status !== 'claimed' ||
        !leaseExpiresAt ||
        leaseExpiresAt.getTime() > checkedAt.getTime() ||
        !token ||
        !row?.presentedSurfaces?.includes('web') ||
        row?.presentedSurfaces?.includes('telegram')
      ) {
        continue;
      }
      const key = `${normalizeText(row?.userId)}\u0000${normalizeText(row?.parentMessageId)}`;
      const group = groups.get(key) || [];
      group.push(row);
      groups.set(key, group);
    }
    let quarantined = 0;
    for (const groupRows of groups.values()) {
      try {
        const expectedSize = Number(groupRows[0]?.batchSize || 1);
        const presentationTokens = new Set(
          groupRows.map((row) => normalizeText(row?.presentationLeaseToken)),
        );
        if (groupRows.length !== expectedSize || presentationTokens.size !== 1) continue;
        const claim = publicClaim({
          ownerId: groupRows[0]?.userId,
          messageId: groupRows[0]?.persistedMessageId,
          parentMessageId: groupRows[0]?.parentMessageId,
          revision: Number(groupRows[0]?.presentationRevision ?? groupRows[0]?.messageRevision),
          claims: groupRows,
        });
        await markDeliveryUnknown({
          cortexPresentation: {
            ...claim,
            presentationLeaseToken: [...presentationTokens][0],
          },
        });
        quarantined += groupRows.length;
      } catch (error) {
        logger.warn('[VIVENTIUM][cortex-telegram-dispatch] Expired transport claim stayed closed', {
          errorClass: normalizeText(
            error?.code || error?.name || 'unknown_transport_settlement_failed',
          ),
        });
      }
    }
    return quarantined;
  }

  return {
    claimPending,
    authorizeClaim,
    acknowledgeRetained,
    failClaim,
    suppressClaim,
    markDeliveryUnknown,
    settleExpiredAuthorizations,
  };
}

const defaultService = createCortexTelegramDeliveryDispatchService();

module.exports = {
  createCortexTelegramDeliveryDispatchService,
  claimPendingCortexTelegramDeliveries: defaultService.claimPending,
  authorizeCortexTelegramDeliveryClaim: defaultService.authorizeClaim,
  acknowledgeRetainedCortexTelegramDelivery: defaultService.acknowledgeRetained,
  failCortexTelegramDeliveryClaim: defaultService.failClaim,
  suppressCortexTelegramDeliveryClaim: defaultService.suppressClaim,
  markCortexTelegramDeliveryUnknown: defaultService.markDeliveryUnknown,
};
