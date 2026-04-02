'use strict';

const { logger } = require('@librechat/data-schemas');
const { getConvo, getMessages } = require('~/models');

function toTimestampMs(value) {
  if (value == null) {
    return NaN;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN;
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
}

function getLatestMessageTimestampMs(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return NaN;
  }

  let latestMs = NaN;
  for (const message of messages) {
    const timestampMs = toTimestampMs(message?.createdAt);
    if (!Number.isFinite(timestampMs)) {
      continue;
    }
    if (!Number.isFinite(latestMs) || timestampMs > latestMs) {
      latestMs = timestampMs;
    }
  }

  return latestMs;
}

function resolveLatestLeafMessageId(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  const hasChildren = new Set();
  for (const message of messages) {
    const parentMessageId = message?.parentMessageId;
    if (typeof parentMessageId === 'string' && parentMessageId.length > 0) {
      hasChildren.add(parentMessageId);
    }
  }

  let latestLeaf = null;
  let latestLeafMs = NaN;
  for (const message of messages) {
    const messageId = message?.messageId ?? message?.id;
    if (typeof messageId !== 'string' || messageId.length === 0) {
      continue;
    }
    if (hasChildren.has(messageId)) {
      continue;
    }

    const createdAtMs = toTimestampMs(message?.createdAt);
    if (latestLeaf == null) {
      latestLeaf = message;
      latestLeafMs = createdAtMs;
      continue;
    }

    if (!Number.isFinite(latestLeafMs) && Number.isFinite(createdAtMs)) {
      latestLeaf = message;
      latestLeafMs = createdAtMs;
      continue;
    }

    if (Number.isFinite(createdAtMs) && createdAtMs >= latestLeafMs) {
      latestLeaf = message;
      latestLeafMs = createdAtMs;
    }
  }

  if (latestLeaf?.messageId) {
    return latestLeaf.messageId;
  }
  if (latestLeaf?.id) {
    return latestLeaf.id;
  }

  const fallback = messages[messages.length - 1];
  return fallback?.messageId ?? fallback?.id ?? null;
}

async function resolveReusableConversationState({
  conversationId,
  userId,
  surface = 'unknown',
  maxIdleMs = 0,
}) {
  if (!conversationId || conversationId === 'new') {
    return {
      conversationId: 'new',
      parentMessageId: null,
      messages: [],
      reason: 'new',
    };
  }

  let convo = null;
  try {
    convo = await getConvo(userId, conversationId);
  } catch (err) {
    logger.warn(
      '[VIVENTIUM][%s] Failed to validate conversationId=%s: %s',
      surface,
      conversationId,
      err?.message,
    );
    return {
      conversationId,
      parentMessageId: null,
      messages: [],
      reason: 'lookup_error',
    };
  }

  if (!convo) {
    logger.warn(
      '[VIVENTIUM][%s] Resetting missing conversationId=%s userId=%s',
      surface,
      conversationId,
      userId || '',
    );
    return {
      conversationId: 'new',
      parentMessageId: null,
      messages: [],
      reason: 'missing',
    };
  }

  if (convo.endpoint !== 'agents') {
    logger.warn(
      '[VIVENTIUM][%s] Resetting non-agent conversationId=%s endpoint=%s userId=%s',
      surface,
      conversationId,
      convo.endpoint || 'unknown',
      userId || '',
    );
    return {
      conversationId: 'new',
      parentMessageId: null,
      messages: [],
      reason: 'non_agent',
    };
  }

  let messages = [];
  try {
    messages = (await getMessages({ conversationId })) ?? [];
  } catch (err) {
    logger.warn(
      '[VIVENTIUM][%s] Failed to load messages for conversationId=%s: %s',
      surface,
      conversationId,
      err?.message,
    );
    return {
      conversationId,
      parentMessageId: null,
      messages: [],
      reason: 'message_lookup_error',
    };
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    logger.warn(
      '[VIVENTIUM][%s] Resetting empty conversationId=%s userId=%s',
      surface,
      conversationId,
      userId || '',
    );
    return {
      conversationId: 'new',
      parentMessageId: null,
      messages: [],
      reason: 'empty',
    };
  }

  if (maxIdleMs > 0) {
    const latestMessageMs = getLatestMessageTimestampMs(messages);
    if (Number.isFinite(latestMessageMs) && Date.now() - latestMessageMs > maxIdleMs) {
      logger.warn(
        '[VIVENTIUM][%s] Resetting stale conversationId=%s idle_ms=%d max_idle_ms=%d userId=%s',
        surface,
        conversationId,
        Date.now() - latestMessageMs,
        maxIdleMs,
        userId || '',
      );
      return {
        conversationId: 'new',
        parentMessageId: null,
        messages: [],
        reason: 'stale',
      };
    }
  }

  return {
    conversationId,
    parentMessageId: resolveLatestLeafMessageId(messages),
    messages,
    reason: 'existing',
  };
}

module.exports = {
  getLatestMessageTimestampMs,
  resolveLatestLeafMessageId,
  resolveReusableConversationState,
};
