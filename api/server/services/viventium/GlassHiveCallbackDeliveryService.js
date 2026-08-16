/* === VIVENTIUM START ===
 * Feature: Durable GlassHive callback surface delivery ledger.
 * Purpose:
 * - Keep GlassHive callback persistence separate from surface delivery.
 * - Let Telegram/voice workers claim, send, retry, and audit callbacks that arrive
 *   after the original request stream has ended.
 * Added: 2026-05-06
 * === VIVENTIUM END === */

const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { ViventiumGlassHiveCallbackDelivery } = require('~/db/models');
const {
  resolveTelegramMappingByUserId,
} = require('~/server/services/TelegramLinkService');

const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_RETRIES = 8;
const MAX_LAST_ERROR_LENGTH = 2000;

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

function deliveryKeyFor({ ownerId, originRef, surface, ...callbackIdentity }) {
  const stableId = stableDeliveryIdentity(callbackIdentity);
  // Callback ids are GlassHive-local, not globally unique authorization. Scope idempotency to the
  // trusted Core owner/origin so a colliding callback id can never reuse another account's row.
  return `${normalizeText(ownerId)}:${normalizeText(originRef)}:${normalizeText(surface)}:${stableId}`;
}

function legacyDeliveryKeyFor({ surface, ...callbackIdentity }) {
  return `${normalizeText(surface)}:${stableDeliveryIdentity(callbackIdentity)}`;
}

function retryDelayMs(retryCount) {
  const bounded = Math.min(Math.max(Number(retryCount) || 0, 0), 8);
  return Math.min(5 * 60 * 1000, 1000 * 2 ** bounded);
}

function toDispatchPayload(delivery) {
  if (!delivery) {
    return null;
  }
  return {
    deliveryId: delivery.deliveryId,
    callbackId: delivery.callbackId || null,
    callbackMessageId: delivery.callbackMessageId,
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
    voiceCallSessionId: delivery.voiceCallSessionId || '',
    voiceRequestId: delivery.voiceRequestId || '',
    status: delivery.status,
    retryCount: delivery.retryCount || 0,
    claimId: delivery.claimId || '',
  };
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
  ].includes(normalizeText(body.event));
}

async function recordSurfaceOutcomeBestEffort(originRef, state) {
  if (!originRef) return;
  try {
    const rows = await ViventiumGlassHiveCallbackDelivery.find(
      { originRef },
      { status: 1, _id: 0 },
    ).lean();
    const statuses = new Set((Array.isArray(rows) ? rows : []).map((row) => row?.status));
    const aggregateState = statuses.has('unresolved')
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
    const { recordGlassHiveSurfaceDeliveryOutcome } = require('./GlassHiveCallbackBindingService');
    await recordGlassHiveSurfaceDeliveryOutcome({ originRef, state: aggregateState });
  } catch (error) {
    logger.warn('[VIVENTIUM][glasshive-delivery] Core work projection update failed', {
      state,
      code: normalizeText(error?.code || error?.name || 'projection_failed').slice(0, 120),
    });
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

  const callbackId = normalizeText(body.callback_id);
  const callbackKey = normalizeText(message?.metadata?.viventium?.callbackKey);
  const originRef = normalizeText(deliveryContext?.originRef || body.origin_ref);
  const now = nowDate();
  const expiresAt = new Date(now.getTime() + DELIVERY_RETENTION_MS);
  const preview = normalizeText(text || message.text);
  // The callback route sanitizes/redacts `fullText` before enqueueing. Do not
  // fall back to raw callback payload text here, because that can contain local
  // paths or other machine-private details that should never enter the ledger.
  const completeText = normalizeText(fullText || preview);

  for (const destination of destinations) {
    const surface = normalizeText(destination.surface).toLowerCase();
    const resolved = isResolvedDestination(destination);
    const deliveryKey = deliveryKeyFor({
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
    // VIVENTIUM: An exact owner+origin match may reuse a row written before delivery keys became
    // account-scoped. The owner/origin predicates are essential: a bare legacy callback id is not
    // authorization and may collide across GlassHive tenants.
    const persistedIdentityFilter = {
      $or: [
        { deliveryKey },
        { deliveryKey: legacyDeliveryKey, userId, originRef },
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
            callbackKey,
            callbackMessageId,
            originRef,
            workRef: normalizeText(deliveryContext?.workRef || body.work_ref),
            userId,
            conversationId,
            requestedParentMessageId: normalizeText(deliveryContext?.requestedParentMessageId),
            anchorMessageId: normalizeText(deliveryContext?.anchorMessageId),
            surface,
            event,
            workerId: normalizeText(body.worker_id),
            runId: normalizeText(body.run_id),
            status: resolved ? (suppress ? 'suppressed' : 'pending') : 'unresolved',
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
          },
          $set: {
            text: preview,
            fullText: completeText && completeText !== preview ? completeText : '',
            expiresAt,
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
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
              telegramChatId: normalizeText(destination.telegramChatId),
              telegramUserId: normalizeText(destination.telegramUserId),
              telegramMessageId: normalizeText(destination.telegramMessageId),
              voiceCallSessionId: normalizeText(destination.voiceCallSessionId),
              voiceRequestId: normalizeText(destination.voiceRequestId),
              nextAttemptAt: suppress ? null : now,
              lastError: '',
              unresolvedReason: '',
              expiresAt,
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
    logger.warn(
      '[VIVENTIUM][glasshive-delivery] Terminal surface destination unresolved',
      {
        originRef,
        workRef: normalizeText(deliveryContext?.workRef || body.work_ref),
        event,
        configured: summary.configured,
        enqueued: summary.enqueued,
        unresolved: summary.unresolved,
      },
    );
    await recordSurfaceOutcomeBestEffort(originRef, 'unresolved');
  } else if (suppress && summary.enqueued > 0) {
    const originRef = normalizeText(deliveryContext?.originRef || body.origin_ref);
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

async function markGlassHiveCallbackDeliverySent({
  deliveryId,
  claimId,
  userId = '',
  voiceCallSessionId = '',
}) {
  const now = nowDate();
  const doc = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
    deliveryConstraintFilter({ deliveryId, claimId, userId, voiceCallSessionId }),
    {
      $set: {
        status: 'sent',
        sentAt: now,
        leaseExpiresAt: null,
        lastError: '',
      },
    },
    { new: true },
  ).lean();
  const payload = toDispatchPayload(doc);
  await recordSurfaceOutcomeBestEffort(payload?.originRef, 'sent');
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
        lastError: redactDeliveryError(reason).slice(0, MAX_LAST_ERROR_LENGTH),
      },
    },
    { new: true },
  ).lean();
  const payload = toDispatchPayload(doc);
  await recordSurfaceOutcomeBestEffort(payload?.originRef, 'suppressed');
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
  const doc = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
    { deliveryId: existing.deliveryId, claimId: existing.claimId, status: 'claimed' },
    {
      $set: {
        status: 'failed',
        failedAt: now,
        leaseExpiresAt: null,
        retryCount,
        nextAttemptAt: exhausted ? null : new Date(now.getTime() + retryDelayMs(retryCount)),
        lastError: redactDeliveryError(error || 'delivery failed').slice(0, MAX_LAST_ERROR_LENGTH),
      },
    },
    { new: true },
  ).lean();
  const payload = toDispatchPayload(doc);
  await recordSurfaceOutcomeBestEffort(payload?.originRef, 'failed');
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
  const repairedOrigins = new Set();
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
    if (originRef) repairedOrigins.add(originRef);
  }
  await Promise.all(
    [...repairedOrigins].map((originRef) => recordSurfaceOutcomeBestEffort(originRef, 'enqueued')),
  );
  return { scanned: Array.isArray(rows) ? rows.length : 0, repaired, pending };
}

async function deliveryBacklogSummary({ surface = '', olderThanMs = 5 * 60 * 1000 } = {}) {
  const now = nowDate();
  const threshold = new Date(now.getTime() - Math.max(0, Number(olderThanMs) || 0));
  const filter = {
    status: { $in: ['pending', 'claimed', 'failed'] },
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
  enqueueGlassHiveCallbackDelivery,
  claimPendingGlassHiveCallbackDeliveries,
  markGlassHiveCallbackDeliverySent,
  markGlassHiveCallbackDeliveryFailed,
  markGlassHiveCallbackDeliverySuppressed,
  reconcileUnresolvedGlassHiveCallbackDeliveries,
  deliveryBacklogSummary,
  toDispatchPayload,
  redactDeliveryError,
};
