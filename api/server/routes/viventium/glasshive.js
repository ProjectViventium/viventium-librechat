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
const {
  enqueueGlassHiveCallbackDelivery,
} = require('~/server/services/viventium/GlassHiveCallbackDeliveryService');
const {
  resolveLatestLeafMessageId,
} = require('~/server/services/viventium/conversationThreading');

const router = express.Router();
const CALLBACK_SKEW_SEC = 5 * 60;
const CALLBACK_REPLAY_TTL_MS = 10 * 60 * 1000;
const MAX_CALLBACK_TEXT_LENGTH = 2400;
const MAX_CALLBACK_FULL_TEXT_LENGTH = 64000;
const MAX_CALLBACK_EVENTS = 20;
const USER_VISIBLE_CALLBACK_EVENTS = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
  'checkpoint.ready',
  'artifact.created',
  'takeover.requested',
]);
const seenCallbacks = new Map();
const LOCAL_PATH_PATTERN =
  /(?:~\/|\/Users\/|\/home\/|\/private\/var\/|\/var\/folders\/|\/tmp\/|[A-Za-z]:\\Users\\)[^`'"<>\n\r]*?(?=$|[`'"<>\n\r]|[)\],.;:!?](?:\s|$)|\s+(?:and|or|from|at|with|then|while|because|but|plus|to|in|on)\b)/gi;
const ACTIVE_WORKER_FAILURE_CODES = new Set([
  'active_worker_conflict',
  'active_worker_limit',
  'host_worker_already_active',
]);

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

function sanitizeCallbackMessage(value, { maxLength = MAX_CALLBACK_TEXT_LENGTH } = {}) {
  let text = String(value || '').trim();
  if (!text) {
    return '';
  }
  text = text
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/[^\s)`'"<>]*/gi, '[local worker link]')
    .replace(LOCAL_PATH_PATTERN, '[local path]')
    .replace(/\]\(\[local path\](?!\))/g, ']([local path])')
    .replace(/\bwrk[_-][A-Za-z0-9_-]+\b/g, '[worker id]')
    .replace(/\brun[_-][A-Za-z0-9_-]+\b/g, '[run id]')
    .replace(/\bprj[_-][A-Za-z0-9_-]+\b/g, '[project id]');
  text = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => {
      const leadingWhitespace = line.match(/^[ \t]*/)?.[0] ?? '';
      const body = line.slice(leadingWhitespace.length).replace(/[ \t]+/g, ' ');
      return `${leadingWhitespace}${body}`.trimEnd();
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (maxLength && text.length > maxLength) {
    return `${text.slice(0, maxLength - 3).trim()}...`;
  }
  return text;
}

function sanitizeCallbackMetadataValue(value, { maxLength = 120 } = {}) {
  const text = sanitizeCallbackMessage(value, { maxLength });
  return text || null;
}

const ACTIVE_WORKER_FAILURE_TEXT_PATTERN =
  /\b(?:already\s+has\s+an\s+active\s+worker|one\s+active\s+host\s+worker|active\s+worker\s+conflict)\b/i;

function sanitizeCallbackErrorForLog(error) {
  const message = error?.message ? sanitizeCallbackMessage(error.message, { maxLength: 160 }) : '';
  return {
    name: error?.name || null,
    code: error?.code || null,
    status: Number.isFinite(error?.status) ? error.status : null,
    message: message || null,
  };
}

function isActiveWorkerFailure({ failureCode = '', message = '' } = {}) {
  return (
    ACTIVE_WORKER_FAILURE_CODES.has(String(failureCode || '').trim().toLowerCase()) ||
    ACTIVE_WORKER_FAILURE_TEXT_PATTERN.test(String(message || ''))
  );
}

function callbackText(body = {}) {
  const event = String(body.event || '').trim();
  const message = sanitizeCallbackMessage(body.message);
  if (event === 'run.completed') {
    return message || 'Done.';
  }
  if (event === 'run.failed') {
    const failureCode = String(
      body.failure_code || body.error_code || body?.error?.code || '',
    ).trim().toLowerCase();
    if (isActiveWorkerFailure({ failureCode, message })) {
      return 'I got stuck: another local worker is already running, so I could not start this one yet.';
    }
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
  if (event === 'artifact.created') {
    return message || 'I saved the artifact.';
  }
  return '';
}

function callbackFullText(body = {}, preview = '') {
  const full = sanitizeCallbackMessage(body.full_message || '', {
    maxLength: MAX_CALLBACK_FULL_TEXT_LENGTH,
  });
  if (!full || full === preview) {
    return '';
  }
  return full;
}

function callbackSurface(body = {}) {
  return String(body.surface || '')
    .trim()
    .toLowerCase();
}

function needsSurfaceDelivery(body = {}) {
  const surface = callbackSurface(body);
  if (surface === 'telegram') {
    return Boolean(
      String(body.telegram_chat_id || '').trim() || String(body.telegram_user_id || '').trim(),
    );
  }
  if (surface === 'voice') {
    return Boolean(String(body.voice_call_session_id || '').trim());
  }
  return false;
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
  if (!workerId) {
    return false;
  }
  const metadataWorkerId = String(metadata.workerId || '').trim();
  const metadataRunId = String(metadata.runId || '').trim();
  return metadataWorkerId === workerId && (!runId || metadataRunId === runId);
}

function latestLeafMessage(messages) {
  const leafId = resolveLatestLeafMessageId(messages);
  return {
    messageId: leafId,
    message: messageById(messages, leafId),
  };
}

function resolveCallbackTreeParentMessageId({
  messages,
  requestedParentMessageId,
  anchorMessageId,
  priorStatusMessage,
}) {
  const currentLeaf = latestLeafMessage(messages);
  const currentLeafId = currentLeaf.messageId;
  if (priorStatusMessage && String(priorStatusMessage.messageId || '') === currentLeafId) {
    return {
      parentMessageId: priorStatusMessage.parentMessageId || anchorMessageId || requestedParentMessageId,
      currentLeaf,
      updateMessage: priorStatusMessage,
    };
  }
  const blankAnchor = blankAssistantAnchorMessage(messages, anchorMessageId);
  if (blankAnchor && currentLeafId === anchorMessageId) {
    return {
      parentMessageId: requestedParentMessageId || blankAnchor.parentMessageId || '',
      currentLeaf,
      updateMessage: blankAnchor,
    };
  }
  return {
    parentMessageId: currentLeafId || anchorMessageId || requestedParentMessageId,
    currentLeaf,
    updateMessage: null,
  };
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

function messageById(messages, messageId) {
  const id = String(messageId || '').trim();
  if (!id) {
    return null;
  }
  return (
    (Array.isArray(messages) ? messages : []).find(
      (message) => String(message?.messageId || '') === id,
    ) || null
  );
}

function persistedCallbackMessage(messages, body = {}) {
  const replayKey = callbackReplayKey(body);
  const callbackId = String(body.callback_id || '').trim();
  return (
    (Array.isArray(messages) ? messages : []).find((message) => {
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
    }) || null
  );
}

function hasPersistedCallback(messages, body = {}) {
  return Boolean(persistedCallbackMessage(messages, body));
}

async function enqueueSurfaceDeliveryOrThrow({ body, message, text, fullText }) {
  if (!needsSurfaceDelivery(body)) {
    return null;
  }
  return enqueueGlassHiveCallbackDelivery({
    body,
    message,
    text,
    fullText,
  });
}

async function repairDuplicateSurfaceDelivery({ body, messages, text, fullText }) {
  if (!needsSurfaceDelivery(body)) {
    return null;
  }
  const persistedMessage = persistedCallbackMessage(messages, body);
  if (!persistedMessage) {
    return null;
  }
  return enqueueGlassHiveCallbackDelivery({
    body,
    message: persistedMessage,
    text: String(persistedMessage.text || text || '').trim(),
    fullText,
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

function callbackDeliverable(body = {}) {
  const deliverable = body?.deliverable;
  if (!deliverable || typeof deliverable !== 'object' || Array.isArray(deliverable)) {
    return null;
  }
  return {
    kind: sanitizeCallbackMetadataValue(deliverable.kind, { maxLength: 48 }),
    state: sanitizeCallbackMetadataValue(deliverable.state, { maxLength: 48 }),
    source: sanitizeCallbackMetadataValue(deliverable.source, { maxLength: 80 }),
    label: sanitizeCallbackMetadataValue(deliverable.label, { maxLength: 120 }),
    preferredSurface: sanitizeCallbackMetadataValue(
      deliverable.preferred_surface || deliverable.preferredSurface,
      { maxLength: 48 },
    ),
  };
}

function buildCallbackMetadata({
  body,
  parentMessageId,
  treeParentMessageId,
  requestedParentMessageId,
  anchorMessageId,
  previousMetadata,
  hasFullText,
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
      parentMessageId: requestedParentMessageId || parentMessageId,
      treeParentMessageId,
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
      deliverable: callbackDeliverable(body || {}),
      hasFullText: Boolean(hasFullText),
      events: [...previousEvents, eventEntry].slice(-MAX_CALLBACK_EVENTS),
    },
  };
}

function callbackMessageTimestamps({ messages, requestedParentMessageId, priorStatusMessage }) {
  const now = new Date();
  const requestedParent = messageById(messages, requestedParentMessageId);
  const requestedParentTime = Date.parse(String(requestedParent?.createdAt || ''));
  const priorTime = Date.parse(String(priorStatusMessage?.createdAt || ''));
  let createdAt = now;
  if (Number.isFinite(priorTime) && priorTime > 0) {
    createdAt = new Date(priorTime);
  }
  if (
    Number.isFinite(requestedParentTime) &&
    requestedParentTime > 0 &&
    createdAt.getTime() <= requestedParentTime
  ) {
    createdAt = now;
  }
  return {
    createdAt,
    updatedAt: now,
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
  const event = String(req.body?.event || '').trim();
  if (!USER_VISIBLE_CALLBACK_EVENTS.has(event)) {
    return res.status(202).json({ status: 'ignored', reason: 'non_user_visible_event' });
  }
  const text = callbackText(req.body);
  if (!text) {
    return res.status(202).json({ status: 'ignored', reason: 'missing_context_or_text' });
  }
  const fullText = callbackFullText(req.body || {}, text);
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
  const callbackWasRecentlySeen = hasSeenCallback(req.body || {});
  if (callbackWasRecentlySeen && !needsSurfaceDelivery(req.body || {})) {
    return res.status(409).json({ error: 'duplicate_callback' });
  }

  let messages = [];
  try {
    if (typeof db.getMessages === 'function') {
      messages =
        (await db.getMessages(
          { user: userId, conversationId },
          'messageId parentMessageId text isCreatedByUser createdAt updatedAt metadata',
        )) ?? [];
    }
  } catch (err) {
    logger.warn(
      '[VIVENTIUM][glasshive] Failed loading prior callback messages:',
      sanitizeCallbackErrorForLog(err),
    );
  }

  if (hasPersistedCallback(messages, req.body || {})) {
    try {
      await repairDuplicateSurfaceDelivery({
        body: req.body || {},
        messages,
        text,
        fullText,
      });
    } catch (err) {
      logger.warn(
        '[VIVENTIUM][glasshive] Failed to repair duplicate callback delivery:',
        sanitizeCallbackErrorForLog(err),
      );
      return res.status(500).json({ error: 'delivery_enqueue_failed' });
    }
    rememberCallback(req.body || {});
    return res.status(409).json({ error: 'duplicate_callback' });
  }
  if (callbackWasRecentlySeen) {
    return res.status(409).json({ error: 'duplicate_callback' });
  }
  if (!messageById(messages, anchorMessageId)) {
    return res.status(425).json({ error: 'callback_anchor_not_ready' });
  }

  const priorStatusCandidate = latestPriorGlassHiveStatusMessage(messages, req.body || {});
  const parentResolution = resolveCallbackTreeParentMessageId({
    messages,
    requestedParentMessageId,
    anchorMessageId,
    priorStatusMessage: priorStatusCandidate,
  });
  const currentLeafMessage = parentResolution.currentLeaf?.message;
  const currentLeafId = String(parentResolution.currentLeaf?.messageId || '');
  if (
    currentLeafMessage?.isCreatedByUser === true &&
    currentLeafId !== requestedParentMessageId &&
    currentLeafId !== anchorMessageId
  ) {
    return res.status(425).json({ error: 'callback_conversation_tip_not_ready' });
  }
  const priorStatusMessage = parentResolution.updateMessage;
  const parentMessageId = parentResolution.parentMessageId;
  const messageId = priorStatusMessage?.messageId || crypto.randomUUID();
  const metadata = buildCallbackMetadata({
    body: req.body || {},
    parentMessageId: requestedParentMessageId,
    treeParentMessageId: parentMessageId,
    requestedParentMessageId,
    anchorMessageId,
    previousMetadata: priorStatusMessage?.metadata,
    hasFullText: Boolean(fullText),
  });
  const timestamps = callbackMessageTimestamps({
    messages,
    requestedParentMessageId,
    priorStatusMessage,
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
    ...timestamps,
  };

  try {
    if (priorStatusMessage && typeof db.updateMessage === 'function') {
      await db.updateMessage({ user: { id: userId } }, followUpMessage, {
        context: 'viventium/routes/glasshive.callback.update',
        overrideTimestamp: true,
      });
    } else {
      await db.saveMessage({ user: { id: userId } }, followUpMessage, {
        context: 'viventium/routes/glasshive.callback',
      });
    }
  } catch (err) {
    logger.warn(
      '[VIVENTIUM][glasshive] Failed to persist callback message:',
      sanitizeCallbackErrorForLog(err),
    );
    return res.status(500).json({ error: 'persist_failed' });
  }

  try {
    await enqueueSurfaceDeliveryOrThrow({
      body: req.body || {},
      message: followUpMessage,
      text,
      fullText,
    });
  } catch (err) {
    logger.warn(
      '[VIVENTIUM][glasshive] Failed to enqueue callback delivery:',
      sanitizeCallbackErrorForLog(err),
    );
    if (needsSurfaceDelivery(req.body || {})) {
      return res.status(500).json({ error: 'delivery_enqueue_failed' });
    }
  }

  rememberCallback(req.body || {});
  return res.json({ status: 'ok', messageId, updated: Boolean(priorStatusMessage) });
});

module.exports = router;
