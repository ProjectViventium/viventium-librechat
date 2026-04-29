/* === VIVENTIUM START ===
 * Feature: GlassHive host-worker callbacks
 * Purpose:
 * - Receive signed GlassHive worker lifecycle callbacks.
 * - Persist completion, blocker, and status reports back into the originating conversation.
 *
 * Endpoint:
 * - POST /api/viventium/glasshive/callback
 *
 * Added: 2026-04-28
 * === VIVENTIUM END === */

const express = require('express');
const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { ContentTypes } = require('librechat-data-provider');
const db = require('~/models');
const {
  GLASSHIVE_CALLBACK_TYPE,
} = require('~/server/services/viventium/GlassHiveCallbackMessageService');

const router = express.Router();
const CALLBACK_SKEW_SEC = 5 * 60;
const CALLBACK_REPLAY_TTL_MS = 10 * 60 * 1000;
const MAX_CALLBACK_TEXT_LENGTH = 1200;
const MAX_CALLBACK_EVENTS = 20;
const seenCallbacks = new Map();

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function getCallbackSecret() {
  return process.env.VIVENTIUM_GLASSHIVE_CALLBACK_SECRET || '';
}

function deriveCallbackSecret(secret, body = {}) {
  const workerId = String(body.worker_id || '').trim();
  const runId = String(body.run_id || '').trim();
  const binding = `${workerId}:${runId}`;
  return crypto.createHmac('sha256', secret).update(binding).digest('hex');
}

function verifySignature(body, signatureHeader = '') {
  const secret = getCallbackSecret();
  if (!secret) {
    return false;
  }
  const incoming = String(signatureHeader || '')
    .replace(/^sha256=/, '')
    .trim();
  if (!/^[a-f0-9]{64}$/i.test(incoming)) {
    return false;
  }
  const encoded = Buffer.from(stableStringify(body), 'utf8');
  const perRunSecret = deriveCallbackSecret(secret, body);
  const expected = crypto.createHmac('sha256', perRunSecret).update(encoded).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(incoming, 'hex'), Buffer.from(expected, 'hex'));
}

function isFreshCallback(body = {}, nowMs = Date.now()) {
  const ts = Number(body.callback_ts);
  if (!Number.isFinite(ts)) {
    return false;
  }
  return Math.abs(nowMs / 1000 - ts) <= CALLBACK_SKEW_SEC;
}

function callbackReplayKey(body = {}) {
  const callbackId = String(body.callback_id || '').trim();
  if (callbackId) {
    return callbackId;
  }
  const stable = stableStringify({
    event: body.event,
    worker_id: body.worker_id,
    run_id: body.run_id,
    conversation_id: body.conversation_id,
    message: body.message,
  });
  return crypto.createHash('sha256').update(stable).digest('hex');
}

function hasSeenCallback(body = {}, nowMs = Date.now()) {
  const expiresBefore = nowMs;
  for (const [key, expiresAt] of seenCallbacks.entries()) {
    if (expiresAt <= expiresBefore) {
      seenCallbacks.delete(key);
    }
  }
  return seenCallbacks.has(callbackReplayKey(body));
}

function rememberCallback(body = {}, nowMs = Date.now()) {
  seenCallbacks.set(callbackReplayKey(body), nowMs + CALLBACK_REPLAY_TTL_MS);
}

function sanitizeCallbackMessage(value) {
  let text = String(value || '').trim();
  if (!text) {
    return '';
  }
  text = text
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/[^\s)]*/gi, '[local worker link]')
    .replace(/\/Users\/[^\s)]*/g, '[local path]')
    .replace(/~\/[^\s)]*/g, '[local path]')
    .replace(/\bwrk[_-][A-Za-z0-9_-]+\b/g, '[worker id]')
    .replace(/\brun[_-][A-Za-z0-9_-]+\b/g, '[run id]')
    .replace(/\bprj[_-][A-Za-z0-9_-]+\b/g, '[project id]')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > MAX_CALLBACK_TEXT_LENGTH) {
    return `${text.slice(0, MAX_CALLBACK_TEXT_LENGTH - 3).trim()}...`;
  }
  return text;
}

function callbackText(body = {}) {
  const event = String(body.event || '').trim();
  const message = sanitizeCallbackMessage(body.message);
  if (event === 'run.started') {
    return 'I’m working on it now.';
  }
  if (event === 'run.completed') {
    return message || 'Done.';
  }
  if (event === 'run.failed') {
    return message ? `I got stuck: ${message}` : 'I got stuck and need attention.';
  }
  if (event === 'checkpoint.ready') {
    return message
      ? `I need your approval to continue: ${message}`
      : 'I need your approval to continue.';
  }
  if (event === 'run.cancelled' || event === 'run.interrupted') {
    return message ? `I stopped: ${message}` : 'I stopped the task.';
  }
  if (event === 'takeover.requested') {
    return message ? `I need you to take over: ${message}` : 'I need you to take over.';
  }
  return '';
}

function callbackContent(text) {
  return [
    {
      type: ContentTypes.TEXT,
      text,
      [ContentTypes.TEXT]: text,
    },
  ];
}

function sameGlassHiveRun(message, body = {}) {
  const workerId = String(body.worker_id || '').trim();
  const runId = String(body.run_id || '').trim();
  const metadata = message?.metadata?.viventium;
  if (!metadata || metadata.type !== GLASSHIVE_CALLBACK_TYPE) {
    return false;
  }
  const metadataWorkerId = String(metadata.workerId || '').trim();
  const metadataRunId = String(metadata.runId || '').trim();
  return (!workerId || metadataWorkerId === workerId) && (!runId || metadataRunId === runId);
}

function resolveCallbackTreeParentMessageId({ requestedParentMessageId, anchorMessageId }) {
  return anchorMessageId || requestedParentMessageId;
}

function latestPriorGlassHiveStatusMessage(messages, body = {}) {
  const matches = (Array.isArray(messages) ? messages : [])
    .filter((message) => sameGlassHiveRun(message, body))
    .filter((message) => typeof message?.text === 'string' && message.text.trim())
    .sort((a, b) => {
      const aTime = Date.parse(String(a?.updatedAt || a?.createdAt || '')) || 0;
      const bTime = Date.parse(String(b?.updatedAt || b?.createdAt || '')) || 0;
      return aTime - bTime;
    });
  return matches.length ? matches[matches.length - 1] : null;
}

function blankAssistantAnchorMessage(messages, anchorMessageId) {
  const id = String(anchorMessageId || '').trim();
  if (!id) {
    return null;
  }
  return (
    (Array.isArray(messages) ? messages : []).find((message) => {
      if (String(message?.messageId || '') !== id) {
        return false;
      }
      if (message?.isCreatedByUser === true) {
        return false;
      }
      return typeof message?.text === 'string' && !message.text.trim();
    }) || null
  );
}

function hasPersistedCallback(messages, body = {}) {
  const replayKey = callbackReplayKey(body);
  const callbackId = String(body.callback_id || '').trim();
  return (Array.isArray(messages) ? messages : []).some((message) => {
    const metadata = message?.metadata?.viventium;
    if (!metadata || metadata.type !== GLASSHIVE_CALLBACK_TYPE) {
      return false;
    }
    if (callbackId && String(metadata.callbackId || '').trim() === callbackId) {
      return true;
    }
    if (replayKey && String(metadata.callbackKey || '').trim() === replayKey) {
      return true;
    }
    const events = Array.isArray(metadata.events) ? metadata.events : [];
    return events.some((event) => {
      if (callbackId && String(event?.callbackId || '').trim() === callbackId) {
        return true;
      }
      return replayKey && String(event?.callbackKey || '').trim() === replayKey;
    });
  });
}

function callbackEventEntry(body = {}) {
  return {
    callbackId: body.callback_id || null,
    callbackKey: callbackReplayKey(body),
    event: body.event || null,
    workerId: body.worker_id || null,
    runId: body.run_id || null,
    runState: body.run_state || null,
    callbackTs: body.callback_ts || null,
  };
}

function buildCallbackMetadata({
  body,
  parentMessageId,
  requestedParentMessageId,
  anchorMessageId,
  previousMetadata,
}) {
  const previousViventium =
    previousMetadata && typeof previousMetadata === 'object' && previousMetadata.viventium
      ? previousMetadata.viventium
      : {};
  const previousEvents = Array.isArray(previousViventium.events) ? previousViventium.events : [];
  const eventEntry = callbackEventEntry(body);
  return {
    ...(previousMetadata && typeof previousMetadata === 'object' ? previousMetadata : {}),
    viventium: {
      ...previousViventium,
      type: GLASSHIVE_CALLBACK_TYPE,
      parentMessageId,
      requestedParentMessageId,
      anchorMessageId,
      workerId: body?.worker_id,
      runId: body?.run_id,
      event: body?.event,
      surface: body?.surface,
      streamId: body?.stream_id,
      voiceCallSessionId: body?.voice_call_session_id,
      voiceRequestId: body?.voice_request_id,
      telegramChatId: body?.telegram_chat_id,
      telegramUserId: body?.telegram_user_id,
      callbackId: body?.callback_id || null,
      callbackKey: callbackReplayKey(body || {}),
      events: [...previousEvents, eventEntry].slice(-MAX_CALLBACK_EVENTS),
    },
  };
}

router.post('/callback', async (req, res) => {
  if (!verifySignature(req.body || {}, req.get('x-glasshive-signature'))) {
    return res.status(401).json({ error: 'invalid_signature' });
  }
  if (!isFreshCallback(req.body || {})) {
    return res.status(401).json({ error: 'stale_callback' });
  }

  const userId = String(req.body?.user_id || '').trim();
  const conversationId = String(req.body?.conversation_id || '').trim();
  const requestedParentMessageId = String(req.body?.parent_message_id || '').trim();
  const anchorMessageId = String(req.body?.message_id || '').trim();
  const text = callbackText(req.body);
  if (!text) {
    return res.status(202).json({ status: 'ignored', reason: 'missing_context_or_text' });
  }
  if (!userId || !conversationId || !requestedParentMessageId || !anchorMessageId) {
    return res.status(425).json({ error: 'missing_callback_anchor' });
  }
  if (typeof db.getConvo !== 'function') {
    logger.warn('[VIVENTIUM][glasshive] Callback receiver missing getConvo ownership check.');
    return res.status(500).json({ error: 'ownership_check_unavailable' });
  }
  const conversation = await db.getConvo(userId, conversationId);
  if (!conversation) {
    return res.status(403).json({ error: 'conversation_not_found' });
  }
  if (hasSeenCallback(req.body || {})) {
    return res.status(409).json({ error: 'duplicate_callback' });
  }

  let messages = [];
  try {
    if (typeof db.getMessages === 'function') {
      messages =
        (await db.getMessages(
          { user: userId, conversationId },
          'messageId parentMessageId text createdAt updatedAt metadata',
        )) ?? [];
    }
  } catch (err) {
    logger.warn('[VIVENTIUM][glasshive] Failed loading prior callback messages:', err?.message);
  }

  if (hasPersistedCallback(messages, req.body || {})) {
    rememberCallback(req.body || {});
    return res.status(409).json({ error: 'duplicate_callback' });
  }

  const priorStatusMessage =
    latestPriorGlassHiveStatusMessage(messages, req.body || {}) ||
    blankAssistantAnchorMessage(messages, anchorMessageId);
  const parentMessageId =
    priorStatusMessage?.parentMessageId ||
    (await resolveCallbackTreeParentMessageId({
      userId,
      conversationId,
      requestedParentMessageId,
      anchorMessageId,
      body: req.body || {},
    }));
  const messageId = priorStatusMessage?.messageId || crypto.randomUUID();
  const metadata = buildCallbackMetadata({
    body: req.body || {},
    parentMessageId,
    requestedParentMessageId,
    anchorMessageId,
    previousMetadata: priorStatusMessage?.metadata,
  });
  const followUpMessage = {
    messageId,
    conversationId,
    parentMessageId,
    sender: 'AI',
    endpoint: 'agents',
    model: String(req.body?.agent_id || ''),
    agent_id: String(req.body?.agent_id || ''),
    text,
    content: callbackContent(text),
    isCreatedByUser: false,
    metadata,
  };

  try {
    if (priorStatusMessage && typeof db.updateMessage === 'function') {
      await db.updateMessage({ user: { id: userId } }, followUpMessage, {
        context: 'viventium/routes/glasshive.callback.update',
      });
    } else {
      await db.saveMessage({ user: { id: userId } }, followUpMessage, {
        context: 'viventium/routes/glasshive.callback',
      });
    }
  } catch (err) {
    logger.warn('[VIVENTIUM][glasshive] Failed to persist callback message:', err);
    return res.status(500).json({ error: 'persist_failed' });
  }

  rememberCallback(req.body || {});
  return res.json({ status: 'ok', messageId, updated: Boolean(priorStatusMessage) });
});

module.exports = router;
