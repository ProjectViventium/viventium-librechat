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

function deliveryKeyFor({ surface, callbackId, callbackKey, callbackMessageId, event }) {
  const stableId =
    normalizeText(callbackId) ||
    normalizeText(callbackKey) ||
    `${normalizeText(callbackMessageId)}:${normalizeText(event)}`;
  return `${normalizeText(surface)}:${stableId}`;
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

function surfaceFromBody(body = {}) {
  return normalizeText(body.surface).toLowerCase();
}

function shouldEnqueueSurface(body = {}) {
  const surface = surfaceFromBody(body);
  if (surface === 'telegram') {
    return Boolean(normalizeText(body.telegram_chat_id) || normalizeText(body.telegram_user_id));
  }
  if (surface === 'voice') {
    return Boolean(normalizeText(body.voice_call_session_id));
  }
  return false;
}

async function enqueueGlassHiveCallbackDelivery({ body, message, text, fullText }) {
  const surface = surfaceFromBody(body);
  if (!message || !shouldEnqueueSurface(body)) {
    return null;
  }
  const callbackMessageId = normalizeText(message.messageId);
  const userId = normalizeText(body.user_id);
  const conversationId = normalizeText(body.conversation_id);
  const event = normalizeText(body.event);
  if (!callbackMessageId || !userId || !conversationId || !event) {
    return null;
  }

  const callbackId = normalizeText(body.callback_id);
  const callbackKey = normalizeText(message?.metadata?.viventium?.callbackKey);
  const deliveryKey = deliveryKeyFor({
    surface,
    callbackId,
    callbackKey,
    callbackMessageId,
    event,
  });
  const deliveryId = deliveryIdFor(deliveryKey);
  const now = nowDate();
  const expiresAt = new Date(now.getTime() + DELIVERY_RETENTION_MS);
  const preview = normalizeText(text || message.text);
  // The callback route sanitizes/redacts `fullText` before enqueueing. Do not
  // fall back to raw callback payload text here, because that can contain local
  // paths or other machine-private details that should never enter the ledger.
  const completeText = normalizeText(fullText || preview);

  try {
    const updated = await ViventiumGlassHiveCallbackDelivery.findOneAndUpdate(
      { deliveryKey },
      {
        $setOnInsert: {
          deliveryKey,
          deliveryId,
          callbackId,
          callbackKey,
          callbackMessageId,
          userId,
          conversationId,
          requestedParentMessageId: normalizeText(body.parent_message_id),
          anchorMessageId: normalizeText(body.message_id),
          surface,
          event,
          workerId: normalizeText(body.worker_id),
          runId: normalizeText(body.run_id),
          status: 'pending',
          telegramChatId: normalizeText(body.telegram_chat_id),
          telegramUserId: normalizeText(body.telegram_user_id),
          telegramMessageId: normalizeText(body.telegram_message_id),
          voiceCallSessionId: normalizeText(body.voice_call_session_id),
          voiceRequestId: normalizeText(body.voice_request_id),
          retryCount: 0,
          nextAttemptAt: now,
        },
        $set: {
          text: preview,
          fullText: completeText && completeText !== preview ? completeText : '',
          expiresAt,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    logger.info(
      '[VIVENTIUM][glasshive-delivery] enqueued surface=%s delivery=%s event=%s',
      surface,
      deliveryId,
      event,
    );
    return updated;
  } catch (err) {
    logger.warn('[VIVENTIUM][glasshive-delivery] enqueue failed:', err);
    throw err;
  }
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
  deliveryBacklogSummary,
  toDispatchPayload,
  redactDeliveryError,
};
