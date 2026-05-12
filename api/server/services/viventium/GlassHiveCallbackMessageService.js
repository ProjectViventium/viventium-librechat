/* === VIVENTIUM START ===
 * Feature: GlassHive callback message lookup
 * Purpose:
 * - Let non-web surfaces poll the same persisted GlassHive callback messages
 *   that the web UI shows in the originating conversation.
 * - Keep callback fanout DB-backed instead of inventing surface-specific result paths.
 * Added: 2026-04-28
 * === VIVENTIUM END === */

const { getMessages } = require('~/models');

const GLASSHIVE_CALLBACK_TYPE = 'glasshive_worker_callback';

function messageTimeValue(message) {
  const raw = message?.updatedAt || message?.createdAt || '';
  const value = raw instanceof Date ? raw.getTime() : Date.parse(String(raw || ''));
  return Number.isFinite(value) ? value : 0;
}

function textOf(message) {
  const direct = typeof message?.text === 'string' ? message.text.trim() : '';
  if (direct) {
    return direct;
  }
  const content = message?.content;
  const parts = Array.isArray(content) ? content : content && typeof content === 'object' ? [content] : [];
  return parts
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (!part || typeof part !== 'object') {
        return '';
      }
      const value = part.text;
      if (typeof value === 'string') {
        return value;
      }
      if (value && typeof value === 'object' && typeof value.value === 'string') {
        return value.value;
      }
      return '';
    })
    .filter(Boolean)
    .join('')
    .trim();
}

function matchesAnchor(message, messageId) {
  const target = String(messageId || '').trim();
  if (!target) {
    return false;
  }
  const metadata = message?.metadata?.viventium || {};
  const candidates = [
    metadata.anchorMessageId,
    metadata.requestedParentMessageId,
    metadata.parentMessageId,
    message?.parentMessageId,
  ];
  return candidates.some((candidate) => String(candidate || '').trim() === target);
}

function toPublicCallback(message) {
  const metadata = message?.metadata?.viventium || {};
  return {
    messageId: message?.messageId,
    text: textOf(message),
    event: metadata.event || null,
    surface: metadata.surface || null,
    deliverable: metadata.deliverable || null,
    hasFullText: Boolean(metadata.hasFullText),
    createdAt: message?.createdAt || null,
    updatedAt: message?.updatedAt || null,
  };
}

async function getGlassHiveCallbackStateForMessage({ userId, conversationId, messageId }) {
  const normalizedUserId = String(userId || '').trim();
  const normalizedConversationId = String(conversationId || '').trim();
  const normalizedMessageId = String(messageId || '').trim();

  if (!normalizedUserId || !normalizedConversationId || !normalizedMessageId) {
    return null;
  }

  const messages = await getMessages({
    user: normalizedUserId,
    conversationId: normalizedConversationId,
    'metadata.viventium.type': GLASSHIVE_CALLBACK_TYPE,
  });

  const callbacks = (Array.isArray(messages) ? messages : [])
    .filter((message) => matchesAnchor(message, normalizedMessageId))
    .filter((message) => textOf(message))
    .sort((a, b) => messageTimeValue(a) - messageTimeValue(b))
    .map(toPublicCallback);

  return {
    messageId: normalizedMessageId,
    conversationId: normalizedConversationId,
    latest: callbacks.length ? callbacks[callbacks.length - 1] : null,
    callbacks,
  };
}

module.exports = {
  GLASSHIVE_CALLBACK_TYPE,
  getGlassHiveCallbackStateForMessage,
  matchesAnchor,
};
