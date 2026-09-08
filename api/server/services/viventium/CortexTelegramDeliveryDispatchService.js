'use strict';

/* === VIVENTIUM START ===
 * Feature: Durable late Cortex delivery to Telegram.
 * Purpose: Let the authenticated Telegram bridge discover and send a persisted Cortex follow-up
 * after the per-turn listener closes, while reusing the existing Cortex and logical-turn fences.
 * === VIVENTIUM END === */

const { GenerationJobManager } = require('@librechat/api');
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

function validCandidate(row) {
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
    !row?.presentedSurfaces?.includes('telegram')
  );
}

function exactTelegramAuthority({ candidate, parent, followup, ingress, mapping, job }) {
  const parentContext = parent?.metadata?.viventium?.interactionContext;
  const jobMetadata = job?.metadata;
  const jobContext = jobMetadata?.interactionContext;
  const sourceSequence = Number(ingress?.sourceSequence);
  const revision = Number(parentContext?.revision);
  return (
    validCandidate(candidate) &&
    parent?.unfinished !== true &&
    normalizeText(parent?.user) === normalizeText(candidate.userId) &&
    normalizeText(parent?.conversationId) === normalizeText(candidate.conversationId) &&
    normalizeText(parent?.messageId) === normalizeText(candidate.parentMessageId) &&
    parentContext?.surface === 'telegram' &&
    normalizeText(parentContext?.logical_turn_id) &&
    Number.isSafeInteger(revision) &&
    revision > 0 &&
    normalizeText(parentContext?.source_event_id) &&
    normalizeText(followup?.user) === normalizeText(candidate.userId) &&
    normalizeText(followup?.conversationId) === normalizeText(candidate.conversationId) &&
    normalizeText(followup?.messageId) === normalizeText(candidate.persistedMessageId) &&
    normalizeText(followup?.parentMessageId) === normalizeText(candidate.parentMessageId) &&
    followup?.metadata?.viventium?.type === 'cortex_followup' &&
    normalizeText(followup?.metadata?.viventium?.cortexPresentationParentMessageId) ===
      normalizeText(candidate.parentMessageId) &&
    normalizeText(followup?.text) &&
    normalizeText(ingress?.libreChatUserId) === normalizeText(candidate.userId) &&
    ingress?.authorityBoundAt instanceof Date &&
    Number.isFinite(ingress.authorityBoundAt.getTime()) &&
    normalizeText(ingress?.streamId) === normalizeText(candidate.streamId) &&
    normalizeText(ingress?.conversationId) === normalizeText(candidate.conversationId) &&
    normalizeText(ingress?.telegramUserId) &&
    normalizeText(ingress?.telegramChatId) &&
    normalizeText(ingress?.telegramMessageId) &&
    Number.isSafeInteger(sourceSequence) &&
    sourceSequence > 0 &&
    Number(ingress?.telegramMessageId) === sourceSequence &&
    /^[a-f0-9]{64}$/.test(normalizeText(ingress?.sourceOrderScope)) &&
    /^[a-f0-9]{64}$/.test(normalizeText(ingress?.sourceEventId)) &&
    normalizeText(mapping?.libreChatUserId) === normalizeText(candidate.userId) &&
    normalizeText(job?.streamId) === normalizeText(candidate.streamId) &&
    normalizeText(jobMetadata?.userId) === normalizeText(candidate.userId) &&
    normalizeText(jobMetadata?.conversationId) === normalizeText(candidate.conversationId) &&
    normalizeText(jobMetadata?.responseMessageId) === normalizeText(candidate.parentMessageId) &&
    jobMetadata?.deliveryPolicy?.commit_authority === 'external_adapter' &&
    jobContext?.surface === 'telegram' &&
    normalizeText(jobContext?.logical_turn_id) === normalizeText(parentContext.logical_turn_id) &&
    Number(jobContext?.revision) === revision &&
    normalizeText(jobContext?.source_order_scope) === normalizeText(ingress.sourceOrderScope) &&
    Number(jobContext?.source_sequence) === sourceSequence &&
    normalizeText(jobContext?.source_event_id) === normalizeText(ingress.sourceEventId) &&
    normalizeText(parentContext.source_event_id) === normalizeText(ingress.sourceEventId)
  );
}

function createCortexTelegramDeliveryDispatchService({
  DeliveryModel = ViventiumCortexInsightDelivery,
  MessageModel = Message,
  IngressModel = ViventiumTelegramIngressEvent,
  resolveTelegramMapping: resolveMapping = resolveTelegramMapping,
  jobManager = GenerationJobManager,
  deliveryService = cortexInsightDeliveryService,
  bindMessageGeneration = bindRecoveredCortexPresentationGeneration,
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
    return { parent, followup, ingress, mapping, job };
  }

  async function claimCandidate(candidate, leaseMs) {
    const authority = await loadAuthority(candidate);
    if (!exactTelegramAuthority({ candidate, ...authority })) return null;

    let claimed = null;
    try {
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
      const parentContext = authority.parent.metadata.viventium.interactionContext;
      return {
        deliveryId: normalizeText(cortexClaim.deliveryIds[0] || candidate.deliveryId),
        streamId: normalizeText(candidate.streamId),
        telegramChatId: normalizeText(authority.ingress.telegramChatId),
        telegramUserId: normalizeText(authority.ingress.telegramUserId),
        telegramMessageId: normalizeText(authority.ingress.telegramMessageId),
        telegramMessageThreadId: normalizeText(authority.ingress.telegramMessageThreadId),
        sourceSequence: Number(authority.ingress.sourceSequence),
        text: String(message?.text || authority.followup.text),
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
    { requirePresentationLease = false, allowExpiredLease = false } = {},
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
          row?.status === 'claimed' &&
          normalizeText(row?.claimToken) === claimToken &&
          Number(row?.claimGeneration) === generation &&
          (allowExpiredLease ||
            (row?.leaseExpiresAt instanceof Date &&
              row.leaseExpiresAt.getTime() > checkedAt.getTime())) &&
          Number(row?.presentationRevision ?? row?.messageRevision) === revision &&
          Number(row?.batchSize || 1) === rows.length &&
          row?.persistenceStatus === 'persisted' &&
          Array.isArray(row?.requiredSurfaces) &&
          row.requiredSurfaces.includes('telegram') &&
          row?.presentedSurfaces?.includes('web') &&
          (!presentationLeaseToken ||
            (normalizeText(row?.presentationLeaseToken) === presentationLeaseToken &&
              normalizeText(row?.presentationLeaseOwnerId) === [...ownerIds][0] &&
              normalizeText(row?.presentationLeaseClaimToken) === claimToken &&
              Number(row?.presentationLeaseGeneration) === generation &&
              (allowExpiredLease ||
                (row?.presentationLeaseExpiresAt instanceof Date &&
                  row.presentationLeaseExpiresAt.getTime() > checkedAt.getTime())))) &&
          !row?.presentedSurfaces?.includes('telegram'),
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
    const bound = await jobManager.bindCortexPresentation(current.streamId, presentation);
    if (!bound) throw dispatchConflict('Cortex Telegram stream presentation binding failed');
    return presentation;
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
  failCortexTelegramDeliveryClaim: defaultService.failClaim,
  suppressCortexTelegramDeliveryClaim: defaultService.suppressClaim,
  markCortexTelegramDeliveryUnknown: defaultService.markDeliveryUnknown,
};
