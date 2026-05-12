/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Feature: LibreChat Voice Calls - Voice Gateway Endpoints
 *
 * Why:
 * - Voice Gateway worker must call LibreChat Agents pipeline WITHOUT possessing user JWTs.
 * - We authenticate via (callSessionId + shared secret), then impersonate the owning userId for:
 *   - conversation ownership checks
 *   - rate limiting / pending request checks
 *   - GenerationJobManager job ownership
 *
 * Endpoints:
 * - POST /api/viventium/voice/chat   -> starts a resumable Agents run; returns { streamId, conversationId }
 * - GET  /api/viventium/voice/stream/:streamId -> SSE subscription to GenerationJobManager stream
 *
 * Added: 2026-01-08
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

const crypto = require('crypto');
const express = require('express');
const { GenerationJobManager } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { SystemRoles } = require('librechat-data-provider');
const { Conversation, Message, ViventiumVoiceIngressEvent } = require('~/db/models');
const {
  configMiddleware,
  validateConvoAccess,
  buildEndpointOption,
} = require('~/server/middleware');
const { initializeClient } = require('~/server/services/Endpoints/agents');
const addTitle = require('~/server/services/Endpoints/agents/title');
const AgentController = require('~/server/controllers/agents/request');
const {
  assertCallSessionSecret,
  claimVoiceSession,
  assertVoiceGatewayAuth,
  claimOrReplaceCallSessionConversationId,
  materializeCallSessionConversationId,
  updateCallSessionConversationId,
} = require('~/server/services/viventium/CallSessionService');
const { getUserById } = require('~/models');
const {
  getCompletedCortexInsightsForMessage,
} = require('~/server/services/viventium/VoiceCortexInsightsService');
const {
  getGlassHiveCallbackStateForMessage,
} = require('~/server/services/viventium/GlassHiveCallbackMessageService');
const {
  claimPendingGlassHiveCallbackDeliveries,
  markGlassHiveCallbackDeliverySent,
  markGlassHiveCallbackDeliveryFailed,
  markGlassHiveCallbackDeliverySuppressed,
} = require('~/server/services/viventium/GlassHiveCallbackDeliveryService');
/* === VIVENTIUM NOTE ===
 * Feature: Sidebar parity for gateway-created conversations (title + icon).
 * Purpose: Match web UI behavior for new conversations created via voice gateway.
 * === VIVENTIUM NOTE === */
const {
  ensureGatewaySpec,
  normalizeGatewayParentMessageId,
} = require('~/server/services/viventium/gatewayConvoDefaults');
const {
  resolveReusableConversationState,
} = require('~/server/services/viventium/conversationThreading');
const {
  isListenOnlyTranscriptMessage,
} = require('~/server/services/viventium/listenOnlyTranscript');

function parseBoolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null) {
    return fallback;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseIntEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const VOICE_TURN_COALESCE_ENABLED = parseBoolEnv('VIVENTIUM_VOICE_TURN_COALESCE_ENABLED', true);
const VOICE_TURN_COALESCE_WINDOW_MS = Math.max(
  parseIntEnv('VIVENTIUM_VOICE_TURN_COALESCE_WINDOW_MS', 350),
  0,
);
const VOICE_TURN_COALESCE_WAIT_MS = Math.max(
  parseIntEnv('VIVENTIUM_VOICE_TURN_COALESCE_WAIT_MS', 4000),
  250,
);
const VOICE_TURN_COALESCE_POLL_MS = Math.max(
  parseIntEnv('VIVENTIUM_VOICE_TURN_COALESCE_POLL_MS', 50),
  10,
);
const VOICE_TURN_COALESCE_RETURN_WINDOW_MS = Math.max(
  parseIntEnv('VIVENTIUM_VOICE_TURN_COALESCE_RETURN_WINDOW_MS', 500),
  100,
);
const VOICE_TURN_COALESCE_TTL_S = Math.max(
  parseIntEnv('VIVENTIUM_VOICE_TURN_COALESCE_TTL_S', 30),
  10,
);

const isVoiceLatencyEnabled = (req) => req?.viventiumVoiceLogLatency === true;

const getVoiceLatencyRequestId = (req) => {
  const requestId = req?.viventiumVoiceRequestId;
  if (typeof requestId === 'string' && requestId.length > 0) {
    return requestId;
  }
  return 'unknown';
};

const logVoiceRouteStage = (req, stage, stageStartAt = null, details = '') => {
  if (!isVoiceLatencyEnabled(req)) {
    return;
  }
  const now = Date.now();
  const routeStartAt =
    typeof req?.viventiumVoiceStartAt === 'number' ? req.viventiumVoiceStartAt : now;
  const stageMs = typeof stageStartAt === 'number' ? now - stageStartAt : null;
  const stagePart = stageMs == null ? '' : ` stage_ms=${stageMs}`;
  const detailPart = details ? ` ${details}` : '';
  logger.info(
    `[VoiceLatency][LC][Route] stage=${stage} request_id=${getVoiceLatencyRequestId(req)} total_ms=${now - routeStartAt}${stagePart}${detailPart}`,
  );
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMongoDuplicateKeyError(error) {
  return Boolean(error) && Number(error.code) === 11000;
}

async function findVoiceIngressEvent(query) {
  const result = ViventiumVoiceIngressEvent.findOne(query);
  if (result && typeof result.lean === 'function') {
    return result.lean();
  }
  return result;
}

async function updateVoiceIngressEvent(query, update, options = {}) {
  const result = ViventiumVoiceIngressEvent.findOneAndUpdate(query, update, options);
  if (result && typeof result.lean === 'function') {
    return result.lean();
  }
  return result;
}

function normalizeVoiceTurnText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeVoiceTurnSegment(segment) {
  if (typeof segment === 'string') {
    return {
      text: normalizeVoiceTurnText(segment),
      receivedAtMs: 0,
    };
  }
  if (!segment || typeof segment !== 'object') {
    return {
      text: '',
      receivedAtMs: 0,
    };
  }
  const receivedAtMs = Number.isFinite(segment.receivedAtMs)
    ? Number(segment.receivedAtMs)
    : Number.isFinite(segment.receivedAt)
      ? Number(segment.receivedAt)
      : 0;
  return {
    text: normalizeVoiceTurnText(segment.text),
    receivedAtMs,
  };
}

function mergeVoiceTurnText(existing, incoming) {
  const current = normalizeVoiceTurnText(existing);
  const next = normalizeVoiceTurnText(incoming);
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  if (current === next) {
    return current;
  }
  return `${current} ${next}`.replace(/\s+/g, ' ').trim();
}

function combineVoiceTurnSegments(segments) {
  if (!Array.isArray(segments)) {
    return '';
  }
  const normalizedSegments = segments
    .map((segment, index) => ({
      ...normalizeVoiceTurnSegment(segment),
      originalIndex: index,
    }))
    .filter((segment) => segment.text);
  normalizedSegments.sort((left, right) => {
    if (left.receivedAtMs !== right.receivedAtMs) {
      return left.receivedAtMs - right.receivedAtMs;
    }
    return left.originalIndex - right.originalIndex;
  });
  return normalizedSegments.reduce(
    (combined, segment) => mergeVoiceTurnText(combined, segment.text),
    '',
  );
}

function voiceTurnTextAlreadyCaptured(capturedText, incomingText) {
  const captured = normalizeVoiceTurnText(capturedText);
  const incoming = normalizeVoiceTurnText(incomingText);
  return Boolean(captured && incoming && captured.includes(incoming));
}

function buildVoiceIngressKey({ callSessionId, conversationId, parentMessageId, mode }) {
  const normalizedMode = mode || 'normal';
  const normalizedParentMessageId =
    parentMessageId || (normalizedMode === 'listen_only' ? 'listen-only-root' : '');
  if (!callSessionId || !normalizedParentMessageId) {
    return '';
  }
  if (normalizedMode === 'listen_only') {
    return `${normalizedMode}:${callSessionId}:${normalizedParentMessageId}`;
  }
  if (!conversationId) {
    return '';
  }
  return `${normalizedMode}:${callSessionId}:${conversationId}:${normalizedParentMessageId}`;
}

function voiceIngressEventExpired(doc, nowMs = Date.now()) {
  const expiresAtMs = doc?.expiresAt ? new Date(doc.expiresAt).getTime() : 0;
  return Number.isFinite(expiresAtMs) && expiresAtMs > 0 && expiresAtMs <= nowMs;
}

async function coalesceVoiceTurn({
  callSessionId,
  userId,
  conversationId,
  parentMessageId,
  text,
  receivedAtMs,
  requestId,
  mode = 'normal',
}) {
  const normalizedText = normalizeVoiceTurnText(text);
  const dedupeKey = buildVoiceIngressKey({ callSessionId, conversationId, parentMessageId, mode });
  if (!VOICE_TURN_COALESCE_ENABLED || !normalizedText || !dedupeKey) {
    return {
      shouldLaunch: true,
      mergedText: normalizedText || text,
      dedupeKey: '',
    };
  }

  const normalizedReceivedAtMs = Number.isFinite(receivedAtMs) ? Number(receivedAtMs) : Date.now();
  const segment = {
    text: normalizedText,
    receivedAtMs: normalizedReceivedAtMs,
    requestId,
  };
  const expiresAt = new Date(Date.now() + VOICE_TURN_COALESCE_TTL_S * 1000);
  try {
    await ViventiumVoiceIngressEvent.create({
      dedupeKey,
      callSessionId,
      userId,
      conversationId,
      parentMessageId,
      requestId,
      status: 'buffering',
      segments: [segment],
      expiresAt,
    });

    if (VOICE_TURN_COALESCE_WINDOW_MS > 0) {
      await sleep(VOICE_TURN_COALESCE_WINDOW_MS);
    }
    const doc = await findVoiceIngressEvent({ dedupeKey });
    const mergedText =
      combineVoiceTurnSegments(doc?.segments || [normalizedText]) || normalizedText;
    return {
      shouldLaunch: true,
      mergedText,
      dedupeKey,
    };
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) {
      throw error;
    }
  }

  const bufferingDoc = await updateVoiceIngressEvent(
    { dedupeKey, status: 'buffering' },
    {
      $push: { segments: segment },
      $set: { expiresAt, requestId },
    },
    { new: true },
  );

  const deadline = Date.now() + VOICE_TURN_COALESCE_WAIT_MS;
  while (Date.now() < deadline) {
    const doc = await findVoiceIngressEvent({ dedupeKey });
    if (!doc) {
      break;
    }
    if (voiceIngressEventExpired(doc)) {
      break;
    }
    if (doc.streamId) {
      const launchedAtMs = doc.launchedAt ? new Date(doc.launchedAt).getTime() : 0;
      if (!launchedAtMs || Date.now() - launchedAtMs <= VOICE_TURN_COALESCE_RETURN_WINDOW_MS) {
        return {
          shouldLaunch: false,
          payload: {
            streamId: doc.streamId,
            conversationId: doc.conversationId || conversationId,
            status: 'started',
            coalesced: true,
          },
        };
      }
      break;
    }
    if (doc.status === 'listen_only') {
      const savedAtMs = doc.savedAt ? new Date(doc.savedAt).getTime() : 0;
      const savedText = combineVoiceTurnSegments(doc.segments || []);
      if (
        savedAtMs &&
        Date.now() - savedAtMs <= VOICE_TURN_COALESCE_RETURN_WINDOW_MS &&
        voiceTurnTextAlreadyCaptured(savedText, normalizedText)
      ) {
        return {
          shouldLaunch: false,
          payload: {
            status: 'listen_only',
            listenOnly: true,
            saved: doc.saved !== false,
            conversationId: doc.conversationId || conversationId,
            messageId: doc.messageId || null,
            coalesced: true,
          },
        };
      }
      const recycledDoc = await updateVoiceIngressEvent(
        { dedupeKey, status: 'listen_only' },
        {
          $set: {
            status: 'buffering',
            segments: [segment],
            requestId,
            conversationId,
            parentMessageId,
            saved: false,
            messageId: '',
            savedAt: null,
            expiresAt,
          },
        },
        { new: true },
      );
      if (recycledDoc?.status === 'buffering') {
        if (VOICE_TURN_COALESCE_WINDOW_MS > 0) {
          await sleep(VOICE_TURN_COALESCE_WINDOW_MS);
        }
        const latestDoc = await findVoiceIngressEvent({ dedupeKey });
        const mergedText =
          combineVoiceTurnSegments(latestDoc?.segments || [segment]) || normalizedText;
        return {
          shouldLaunch: true,
          mergedText,
          dedupeKey,
        };
      }
      break;
    }

    if (!bufferingDoc && doc.status !== 'buffering') {
      break;
    }
    await sleep(VOICE_TURN_COALESCE_POLL_MS);
  }

  return {
    shouldLaunch: true,
    mergedText: normalizedText,
    dedupeKey: '',
  };
}

/* === VIVENTIUM START ===
 * Feature: Listen-Only Mode
 * Purpose: Persist ambient call transcript records without entering the Agents controller,
 * background cortex, TTS, tools, or live memory writer path.
 * === VIVENTIUM END === */
function normalizeListenOnlySpeakerLabel(incoming) {
  const candidates = [incoming?.participantName, incoming?.participantIdentity, incoming?.trackSid];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().slice(0, 120);
    }
  }
  return 'room';
}

function isConcreteConversationId(conversationId) {
  return typeof conversationId === 'string' && conversationId.trim() && conversationId !== 'new';
}

async function repairTrailingListenOnlyFanout({ userId, conversationId }) {
  try {
    const messages = await Message.find({
      user: userId,
      conversationId,
    })
      .sort({ createdAt: 1, _id: 1 })
      .select({ messageId: 1, parentMessageId: 1, metadata: 1, createdAt: 1, _id: 1 })
      .lean();

    if (!Array.isArray(messages) || messages.length < 2) {
      return;
    }

    let lastNonListenOnlyIndex = -1;
    for (let index = 0; index < messages.length; index += 1) {
      if (!isListenOnlyTranscriptMessage(messages[index])) {
        lastNonListenOnlyIndex = index;
      }
    }

    const trailingTranscripts = messages.slice(lastNonListenOnlyIndex + 1);
    if (trailingTranscripts.length < 2) {
      return;
    }

    const ops = [];
    const anchorMessageId =
      lastNonListenOnlyIndex >= 0 ? messages[lastNonListenOnlyIndex]?.messageId : null;

    for (let index = 0; index < trailingTranscripts.length; index += 1) {
      const current = trailingTranscripts[index];
      const expectedParentMessageId =
        index === 0 ? anchorMessageId : trailingTranscripts[index - 1]?.messageId;

      if (!expectedParentMessageId || !current?.messageId) {
        continue;
      }
      if (current.parentMessageId === expectedParentMessageId) {
        continue;
      }
      ops.push({
        updateOne: {
          filter: { user: userId, conversationId, messageId: current.messageId },
          update: { $set: { parentMessageId: expectedParentMessageId } },
        },
      });
    }

    if (ops.length === 0) {
      return;
    }

    await Message.bulkWrite(ops, { ordered: false });
    logger.info(
      '[VIVENTIUM][voice/chat] Repaired trailing Listen-Only transcript fanout conversationId=%s rows=%d',
      conversationId,
      ops.length,
    );
  } catch (err) {
    logger.warn(
      '[VIVENTIUM][voice/chat] Failed to repair trailing Listen-Only transcript fanout conversationId=%s: %s',
      conversationId,
      err?.message || err,
    );
  }
}

async function resolveListenOnlyTranscriptParentMessageId({
  userId,
  conversationId,
  fallbackParentMessageId,
}) {
  if (!userId || !isConcreteConversationId(conversationId)) {
    return fallbackParentMessageId;
  }

  try {
    const latestMessage = await Message.findOne({ user: userId, conversationId })
      .sort({ createdAt: -1, _id: -1 })
      .select({ messageId: 1, parentMessageId: 1, metadata: 1, createdAt: 1, _id: 1 })
      .lean();

    if (isListenOnlyTranscriptMessage(latestMessage)) {
      const latestMessageId = latestMessage.messageId ?? latestMessage.id;
      if (typeof latestMessageId === 'string' && latestMessageId.length > 0) {
        if (
          latestMessage.parentMessageId == null ||
          latestMessage.parentMessageId === fallbackParentMessageId
        ) {
          await repairTrailingListenOnlyFanout({ userId, conversationId });
        }
        return latestMessageId;
      }
    }
  } catch (err) {
    logger.warn(
      '[VIVENTIUM][voice/chat] Failed to resolve Listen-Only transcript parent conversationId=%s: %s',
      conversationId,
      err?.message || err,
    );
  }

  return fallbackParentMessageId;
}

async function persistListenOnlyTranscript({
  req,
  session,
  text,
  conversationId,
  parentMessageId,
  incoming,
  sessionConversationRejected = false,
}) {
  const normalizedText = normalizeVoiceTurnText(text);
  if (!normalizedText) {
    return {
      saved: false,
      conversationId: isConcreteConversationId(conversationId)
        ? conversationId
        : session.conversationId,
      parentMessageId,
      messageId: null,
    };
  }

  const userId = req.user?.id;
  if (!userId) {
    const err = new Error('User not found for Listen-Only transcript persistence');
    err.status = 401;
    throw err;
  }

  const canFallBackToSessionConversation =
    !sessionConversationRejected && isConcreteConversationId(session?.conversationId);
  let resolvedConversationId = isConcreteConversationId(conversationId)
    ? conversationId
    : canFallBackToSessionConversation
      ? session?.conversationId
      : null;
  if (!isConcreteConversationId(resolvedConversationId)) {
    const candidateConversationId = crypto.randomUUID();
    const materializedSession = sessionConversationRejected
      ? await claimOrReplaceCallSessionConversationId(
          session?.callSessionId,
          candidateConversationId,
          {
            expectedConversationId: session?.conversationId,
          },
        )
      : await materializeCallSessionConversationId(session?.callSessionId, candidateConversationId);
    if (!isConcreteConversationId(materializedSession?.conversationId)) {
      const err = new Error(
        'Call session is no longer available for Listen-Only transcript persistence',
      );
      err.status = 409;
      throw err;
    }
    resolvedConversationId = materializedSession.conversationId;
  }
  const resolvedParentMessageId = await resolveListenOnlyTranscriptParentMessageId({
    userId,
    conversationId: resolvedConversationId,
    fallbackParentMessageId: parentMessageId,
  });
  const messageId = crypto.randomUUID();
  const now = new Date();
  const speakerLabel = normalizeListenOnlySpeakerLabel(incoming);
  const requestId =
    req.viventiumVoiceRequestId || req.get('X-VIVENTIUM-REQUEST-ID') || crypto.randomUUID();

  const message = await Message.findOneAndUpdate(
    { user: userId, messageId },
    {
      $set: {
        user: userId,
        messageId,
        conversationId: resolvedConversationId,
        parentMessageId: resolvedParentMessageId,
        endpoint: 'agents',
        sender: 'Listen-Only',
        text: normalizedText,
        _meiliIndex: false,
        isCreatedByUser: false,
        tokenCount: 0,
        unfinished: false,
        error: false,
        metadata: {
          viventium: {
            type: 'listen_only_transcript',
            source: 'voice_call',
            mode: 'listen_only',
            ambientKind: 'ambient_room_transcript',
            callSessionId: session?.callSessionId || null,
            speakerLabel,
            requestId,
          },
        },
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      upsert: true,
      new: true,
      timestamps: false,
      overwriteImmutable: true,
    },
  );

  await Conversation.findOneAndUpdate(
    { user: userId, conversationId: resolvedConversationId },
    {
      $setOnInsert: {
        user: userId,
        conversationId: resolvedConversationId,
        title: 'Listen-Only Session',
        endpoint: 'agents',
        agent_id: session?.agentId || null,
        createdAt: now,
      },
      $set: {
        updatedAt: now,
      },
      $addToSet: {
        messages: message._id,
      },
    },
    {
      upsert: true,
      new: true,
      timestamps: false,
      overwriteImmutable: true,
    },
  );

  return {
    saved: true,
    conversationId: resolvedConversationId,
    parentMessageId: resolvedParentMessageId,
    messageId,
    speakerLabel,
  };
}

async function handleListenOnlyVoiceTurn({ req, res, session }) {
  const coalescedTurn = await coalesceVoiceTurn({
    callSessionId: session?.callSessionId,
    userId: req.user?.id,
    conversationId: req.body?.conversationId || session?.conversationId,
    parentMessageId: req.body?.parentMessageId,
    text: req.body?.text,
    receivedAtMs: req.viventiumVoiceIngressReceivedAtMs,
    requestId:
      req.viventiumVoiceRequestId || req.get('X-VIVENTIUM-REQUEST-ID') || crypto.randomUUID(),
    mode: 'listen_only',
  });

  if (!coalescedTurn.shouldLaunch && coalescedTurn.payload) {
    logger.info(
      `[VIVENTIUM][voice/chat] Coalesced onto existing Listen-Only transcript parentMessageId=${req.body?.parentMessageId || 'none'} ` +
        `conversationId=${req.body?.conversationId || 'unknown'} status=${coalescedTurn.payload.status || 'unknown'}`,
    );
    return res.json(coalescedTurn.payload);
  }

  if (
    typeof coalescedTurn.mergedText === 'string' &&
    coalescedTurn.mergedText &&
    coalescedTurn.mergedText !== req.body?.text
  ) {
    logger.info(
      `[VIVENTIUM][voice/chat] Coalesced rapid same-parent Listen-Only turn text parentMessageId=${req.body?.parentMessageId || 'none'} ` +
        `chars=${req.body?.text?.length || 0}->${coalescedTurn.mergedText.length}`,
    );
    req.body.text = coalescedTurn.mergedText;
  }

  logger.info(
    `[VIVENTIUM][voice/chat] user_turn_completed source=listen_only callSessionId=${session?.callSessionId || 'unknown'} ` +
      `conversationId=${req.body?.conversationId || 'unknown'} parentMessageId=${req.body?.parentMessageId || 'none'} ` +
      `agentId=${session?.agentId || 'unknown'} requestId=${
        req.viventiumVoiceRequestId || req.get('X-VIVENTIUM-REQUEST-ID') || 'unknown'
      } coalesced=${Boolean(coalescedTurn.dedupeKey)} textChars=${req.body?.text?.length || 0}`,
  );

  let persisted;
  try {
    persisted = await persistListenOnlyTranscript({
      req,
      session,
      text: req.body?.text,
      conversationId: req.body?.conversationId,
      parentMessageId: req.body?.parentMessageId,
      incoming: req.body,
      sessionConversationRejected: req.viventiumVoiceConversationRejected === true,
    });
  } catch (err) {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    logger.warn(
      '[VIVENTIUM][voice/chat] Listen-Only transcript persistence failed: %s',
      err?.message || err,
    );
    return res.status(status).json({
      error: err?.message || 'Listen-Only transcript persistence failed',
      listenOnly: true,
      status: 'listen_only_error',
    });
  }

  if (coalescedTurn.dedupeKey) {
    updateVoiceIngressEvent(
      { dedupeKey: coalescedTurn.dedupeKey },
      {
        $set: {
          status: 'listen_only',
          saved: persisted.saved,
          messageId: persisted.messageId || '',
          conversationId: persisted.conversationId || req.body?.conversationId || '',
          savedAt: new Date(),
          expiresAt: new Date(Date.now() + VOICE_TURN_COALESCE_TTL_S * 1000),
        },
      },
      { new: true },
    ).catch((err) => {
      logger.warn('[VIVENTIUM][voice/chat] Failed to update Listen-Only coalesced record:', err);
    });
  }

  logger.info(
    `[VIVENTIUM][voice/chat] Listen-Only transcript persisted callSessionId=${session.callSessionId} ` +
      `conversationId=${persisted.conversationId || 'unknown'} messageId=${persisted.messageId || 'none'} ` +
      `saved=${persisted.saved === true} textChars=${req.body?.text?.length || 0}`,
  );

  return res.json({
    status: 'listen_only',
    listenOnly: true,
    saved: persisted.saved === true,
    conversationId: persisted.conversationId || req.body?.conversationId,
    parentMessageId: persisted.parentMessageId || req.body?.parentMessageId,
    messageId: persisted.messageId || null,
  });
}

/* === VIVENTIUM NOTE ===
 * Feature: Voice conversation continuity - parentMessageId tracking
 *
 * LibreChat uses a message tree model where each message has a parentMessageId.
 * The agent's buildMessages uses getMessagesForConversation which walks up from
 * parentMessageId to build the conversation chain.
 *
 * Without a proper parentMessageId, the agent only sees the current message,
 * breaking conversation continuity and cortex insight recall.
 * === VIVENTIUM NOTE === */
const router = express.Router();

// IMPORTANT:
// Do NOT run configMiddleware until after voiceAuth sets req.user/role.
// Memory + permissions are role-dependent via getAppConfig({ role }).

/* === VIVENTIUM NOTE ===
 * Feature: Voice worker lease claim
 *
 * Purpose:
 * - Ensure only one LiveKit worker owns a call session at a time.
 * - Prevent duplicate voice responses when dispatch races spawn multiple workers.
 * === VIVENTIUM NOTE === */
router.post('/claim', async (req, res) => {
  try {
    const callSessionId =
      req.get('X-VIVENTIUM-CALL-SESSION') || req.get('x-viventium-call-session') || '';
    const secret = req.get('X-VIVENTIUM-CALL-SECRET') || req.get('x-viventium-call-secret') || '';
    const jobId = req.get('X-VIVENTIUM-JOB-ID') || req.get('x-viventium-job-id') || '';
    const workerId = req.get('X-VIVENTIUM-WORKER-ID') || req.get('x-viventium-worker-id') || '';

    const session = await assertCallSessionSecret(callSessionId, secret);
    if (!jobId) {
      return res.status(400).json({ error: 'Missing voice job id' });
    }

    const claimed = await claimVoiceSession({
      callSessionId: session.callSessionId,
      jobId,
      workerId,
    });
    if (!claimed) {
      return res.status(409).json({ error: 'Voice session already claimed' });
    }

    return res.json({
      status: 'claimed',
      callSessionId: claimed.callSessionId,
      jobId: claimed.activeJobId,
      workerId: claimed.activeWorkerId,
      leaseExpiresAtMs: claimed.leaseExpiresAtMs,
    });
  } catch (err) {
    const status = err?.status || 401;
    logger.error('[VIVENTIUM][voice/claim] Auth failed:', err);
    return res.status(status).json({ error: err?.message || 'Unauthorized' });
  }
});

/**
 * Authenticate Voice Gateway, attach call session to req, and set req.user to the FULL user object.
 *
 * CRITICAL: We must load the full user document (like JWT auth does) to ensure:
 * - Memory system works (needs user.role for permission checks)
 * - Tool access works (needs user.role for MCP/file access)
 * - Config middleware works (needs user.role for user-specific config)
 * - All permission checks work (many check user.role)
 *
 * Without this, voice calls would behave like a neutered version of the agent.
 */
async function voiceAuth(req, res, next) {
  try {
    const session = await assertVoiceGatewayAuth(req);
    req.viventiumCallSession = session;

    // Load full user document (matches JWT auth behavior in jwtStrategy.js)
    const user = await getUserById(session.userId, '-password -__v -totpSecret -backupCodes');
    if (!user) {
      const err = new Error('User not found for call session');
      err.status = 401;
      throw err;
    }

    // Ensure user.id is a string (matches JWT strategy behavior)
    user.id = user._id.toString();

    // Ensure role is set (matches JWT strategy behavior)
    if (!user.role) {
      user.role = SystemRoles.USER;
    }

    req.user = user;
    next();
  } catch (err) {
    const status = err?.status || 401;
    logger.error('[VIVENTIUM][voiceAuth] Auth failed:', err);
    return res.status(status).json({ error: err?.message || 'Unauthorized' });
  }
}

/**
 * Start an Agents run using the call session's selected agent + conversation.
 * Voice Gateway supplies only `text`; we do not trust client-sent agentId/conversationId.
 *
 * Special modes:
 * - speakInsights: true - Voice Gateway is requesting the agent speak pending insights.
 *   In this mode, `systemPrompt` contains the formatted insight prompt (from v1-style formatting).
 *   The agent should respond naturally with the insight, not as a user question.
 */
router.post(
  '/chat',
  voiceAuth,
  configMiddleware,
  async (req, _res, next) => {
    req.viventiumVoiceIngressReceivedAtMs = Date.now();
    const session = req.viventiumCallSession;
    const incoming = req.body ?? {};
    const text = typeof incoming.text === 'string' ? incoming.text : '';
    const speakInsights = incoming.speakInsights === true;
    const systemPrompt = typeof incoming.systemPrompt === 'string' ? incoming.systemPrompt : '';
    /* === VIVENTIUM NOTE ===
     * Feature: Voice latency logging (request timing)
     */
    const logLatency = (process.env.VIVENTIUM_VOICE_LOG_LATENCY || '').trim() === '1';
    if (logLatency) {
      req.viventiumVoiceStartAt = Date.now();
      req.viventiumVoiceRequestId = req.get('X-VIVENTIUM-REQUEST-ID') || '';
      req.viventiumVoiceLogLatency = true;
      logVoiceRouteStage(
        req,
        'voice_chat_route_enter',
        req.viventiumVoiceStartAt,
        `agent_id=${session?.agentId || 'unknown'} convo_id=${session?.conversationId || 'new'}`,
      );
    }
    /* === VIVENTIUM NOTE === */

    /* === VIVENTIUM NOTE ===
     * Feature: Voice conversation continuity - parentMessageId tracking
     *
     * For existing conversations, fetch the latest message's ID to use as parentMessageId.
     * This ensures LibreChat's message tree model builds the full conversation chain,
     * enabling the agent to see previous messages and cortex insights.
     * === VIVENTIUM NOTE === */
    const requestedConversationId = session.conversationId || 'new';
    const parentLookupStartAt = Date.now();
    const conversationState = await resolveReusableConversationState({
      conversationId: requestedConversationId,
      userId: req.user?.id,
      surface: 'voice',
      agentId: session.agentId,
    });
    const conversationId = conversationState.conversationId;
    let parentMessageId = conversationState.parentMessageId;
    const conversationRejectedForVoice =
      isConcreteConversationId(requestedConversationId) &&
      conversationId === 'new' &&
      conversationState.reason !== 'new';
    req.viventiumVoiceConversationRejected = conversationRejectedForVoice;
    logVoiceRouteStage(
      req,
      'resolve_parent_message_done',
      parentLookupStartAt,
      `requested_conversation_id=${requestedConversationId} conversation_id=${conversationId} parent_message_id=${parentMessageId || 'none'} reason=${conversationState.reason}`,
    );
    if (requestedConversationId !== conversationId) {
      logger.info(
        '[VIVENTIUM][voice/chat] Conversation reset: requested=%s resolved=%s reason=%s',
        requestedConversationId,
        conversationId,
        conversationState.reason,
      );
    }
    logger.info(
      `[VIVENTIUM][voice/chat] Resolved parentMessageId=${parentMessageId} for conversationId=${conversationId}`,
    );

    /* === VIVENTIUM NOTE ===
     * Feature: Sidebar parity for gateway-created conversations (title + icon).
     * === VIVENTIUM NOTE === */
    parentMessageId = normalizeGatewayParentMessageId({ conversationId, parentMessageId });
    const resolvedSpec = ensureGatewaySpec({
      req,
      existingSpec: incoming?.spec,
      agentId: session.agentId,
    });

    // Normalize request body for Agents buildEndpointOption + controller.
    req.body = {
      ...incoming,
      text,
      endpoint: 'agents',
      endpointType: 'agents',
      conversationId,
      parentMessageId,
      agent_id: session.agentId,
    };
    logVoiceRouteStage(
      req,
      'voice_chat_body_normalized',
      null,
      `conversation_id=${conversationId} parent_message_id=${parentMessageId || 'none'} ` +
        `speak_insights=${speakInsights} text_chars=${text.length}`,
    );
    if (resolvedSpec) {
      req.body.spec = resolvedSpec;
    }

    logger.info(
      `[VIVENTIUM][voice/chat] Request: conversationId=${conversationId}, parentMessageId=${parentMessageId}, agentId=${session.agentId}`,
    );

    /* === VIVENTIUM START ===
     * Feature: Listen-Only Mode early exit
     * Purpose: This branch intentionally returns before validateConvoAccess/buildEndpointOption.
     * voiceAuth has already bound the request to the call-session user, and conversationId is
     * server-resolved from that session, so no browser-supplied conversation target is trusted.
     * === VIVENTIUM END === */
    if (session?.listenOnlyModeEnabled === true) {
      return handleListenOnlyVoiceTurn({ req, res: _res, session });
    }

    // If this is an insight delivery request, inject the insight prompt as instructions
    // so the agent speaks the insights naturally (like v1's _speak_proactively pattern)
    if (speakInsights && systemPrompt) {
      req.viventiumInsightPrompt = systemPrompt;
      logger.info('[VIVENTIUM][voice/chat] Insight delivery request received (speakInsights=true)');
    }

    next();
  },
  validateConvoAccess,
  buildEndpointOption,
  async (req, res, next) => {
    // If this call session began from a "new" conversation, capture the real conversationId
    // returned by ResumableAgentController and update the session store.
    const session = req.viventiumCallSession;

    const coalescedTurn = await coalesceVoiceTurn({
      callSessionId: session?.callSessionId,
      userId: req.user?.id,
      conversationId: req.body?.conversationId,
      parentMessageId: req.body?.parentMessageId,
      text: req.body?.text,
      receivedAtMs: req.viventiumVoiceIngressReceivedAtMs,
      requestId:
        req.viventiumVoiceRequestId || req.get('X-VIVENTIUM-REQUEST-ID') || crypto.randomUUID(),
      mode: 'normal',
    });

    if (!coalescedTurn.shouldLaunch && coalescedTurn.payload) {
      logger.info(
        `[VIVENTIUM][voice/chat] Coalesced onto existing stream parentMessageId=${req.body?.parentMessageId || 'none'} ` +
          `conversationId=${req.body?.conversationId || 'unknown'} streamId=${coalescedTurn.payload.streamId || 'unknown'}`,
      );
      return res.json(coalescedTurn.payload);
    }

    if (
      typeof coalescedTurn.mergedText === 'string' &&
      coalescedTurn.mergedText &&
      coalescedTurn.mergedText !== req.body?.text
    ) {
      logger.info(
        `[VIVENTIUM][voice/chat] Coalesced rapid same-parent turn text parentMessageId=${req.body?.parentMessageId || 'none'} ` +
          `chars=${req.body?.text?.length || 0}->${coalescedTurn.mergedText.length}`,
      );
      req.body.text = coalescedTurn.mergedText;
    }

    logger.info(
      `[VIVENTIUM][voice/chat] user_turn_completed source=route callSessionId=${session?.callSessionId || 'unknown'} ` +
        `conversationId=${req.body?.conversationId || 'unknown'} parentMessageId=${req.body?.parentMessageId || 'none'} ` +
        `agentId=${session?.agentId || 'unknown'} requestId=${
          req.viventiumVoiceRequestId || req.get('X-VIVENTIUM-REQUEST-ID') || 'unknown'
        } coalesced=${Boolean(coalescedTurn.dedupeKey)} textChars=${req.body?.text?.length || 0}`,
    );

    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      try {
        const convoId = payload?.conversationId;
        const shouldUpdateSessionConversationId =
          session &&
          (session.conversationId === 'new' || req.viventiumVoiceConversationRejected === true) &&
          typeof convoId === 'string' &&
          convoId.length > 0 &&
          convoId !== 'new';
        if (shouldUpdateSessionConversationId) {
          updateCallSessionConversationId(session.callSessionId, convoId).catch((err) => {
            logger.warn(
              '[VIVENTIUM][voice/chat] Failed to update call session conversationId:',
              err,
            );
          });
        }
        if (
          coalescedTurn.dedupeKey &&
          typeof payload?.streamId === 'string' &&
          payload.streamId.length > 0
        ) {
          updateVoiceIngressEvent(
            { dedupeKey: coalescedTurn.dedupeKey },
            {
              $set: {
                streamId: payload.streamId,
                status: 'launched',
                launchedAt: new Date(),
                conversationId: convoId || req.body?.conversationId || '',
                expiresAt: new Date(Date.now() + VOICE_TURN_COALESCE_TTL_S * 1000),
              },
            },
            { new: true },
          ).catch((err) => {
            logger.warn('[VIVENTIUM][voice/chat] Failed to update coalesced stream record:', err);
          });
        }
        if (req.viventiumVoiceLogLatency && typeof req.viventiumVoiceStartAt === 'number') {
          const elapsedMs = Date.now() - req.viventiumVoiceStartAt;
          const requestId = req.viventiumVoiceRequestId || 'unknown';
          const streamId = payload?.streamId || 'unknown';
          logger.info(
            `[VoiceLatency] voice_chat_ready_ms=${elapsedMs} request_id=${requestId} stream_id=${streamId}`,
          );
        }
      } catch (e) {
        // noop
      }
      return originalJson(payload);
    };

    // Handle insight delivery mode (speakInsights=true)
    // Inject the insight prompt into the request so the agent speaks it naturally
    // This mirrors v1's ResponseController._speak_proactively() pattern
    const insightPrompt = req.viventiumInsightPrompt;
    if (insightPrompt) {
      // For insight delivery, we use an empty user message and inject the insight as instructions
      // The agent will respond naturally to the insight prompt
      req.body.text = '';
      req.body.viventiumInsightInstructions = insightPrompt;
      // Prevent recursive cortex activation loops on this synthetic "insight delivery" request.
      req.body.suppressBackgroundCortices = true;
      logger.info(
        '[VIVENTIUM][voice/chat] Injected insight instructions (%d chars)',
        insightPrompt.length,
      );
    }

    return AgentController(req, res, next, initializeClient, addTitle);
  },
);

/**
 * SSE subscription endpoint for the voice gateway.
 * Mirrors `/api/agents/chat/stream/:streamId` but is authenticated via call session secret.
 */
router.get('/stream/:streamId', voiceAuth, async (req, res) => {
  const { streamId } = req.params;
  const isResume = req.query.resume === 'true';
  const userId = req.user?.id;

  const job = await GenerationJobManager.getJob(streamId);
  if (!job) {
    return res.status(404).json({
      error: 'Stream not found',
      message: 'The generation job does not exist or has expired.',
    });
  }

  if (job.metadata?.userId && job.metadata.userId !== userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  res.setHeader('Content-Encoding', 'identity');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  logger.debug?.(`[VIVENTIUM][VoiceStream] subscribed ${streamId}, resume=${isResume}`);

  if (isResume) {
    const resumeState = await GenerationJobManager.getResumeState(streamId);
    if (resumeState && !res.writableEnded) {
      res.write(`event: message\ndata: ${JSON.stringify({ sync: true, resumeState })}\n\n`);
      if (typeof res.flush === 'function') {
        res.flush();
      }
    }
  }

  const result = await GenerationJobManager.subscribe(
    streamId,
    (event) => {
      if (!res.writableEnded) {
        res.write(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
        if (typeof res.flush === 'function') {
          res.flush();
        }
      }
    },
    (event) => {
      if (!res.writableEnded) {
        res.write(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
        if (typeof res.flush === 'function') {
          res.flush();
        }
        res.end();
      }
    },
    (error) => {
      if (!res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ error })}\n\n`);
        if (typeof res.flush === 'function') {
          res.flush();
        }
        res.end();
      }
    },
  );

  if (!result) {
    return res.status(404).json({ error: 'Failed to subscribe to stream' });
  }

  req.on('close', () => {
    result.unsubscribe();
  });
});

/* === VIVENTIUM NOTE ===
 * Feature: Voice Gateway - retrieve completed cortex insights for a message
 *
 * Why:
 * - In LibreChat UI, background cortices surface asynchronously via DB persistence
 *   (cortex parts are written onto the canonical assistant message).
 * - In the LiveKit voice playground, we need a reliable way for the voice worker
 *   to fetch these background insights after the main response completes.
 *
 * Contract:
 * - GET /api/viventium/voice/cortex/:messageId
 *   -> { messageId, conversationId, insights: [{ cortex_id, cortex_name, insight }], followUp?: { messageId, text } }
 *
 * Notes:
 * - Authenticated via call session secret (voiceAuth), not user JWTs.
 * - Validates message belongs to the call session's conversationId.
 * === VIVENTIUM NOTE === */
router.get('/cortex/:messageId', voiceAuth, async (req, res) => {
  const session = req.viventiumCallSession;
  const userId = req.user?.id;
  const messageId = req.params?.messageId;

  if (
    !session ||
    typeof session.conversationId !== 'string' ||
    session.conversationId.length === 0
  ) {
    return res.status(400).json({ error: 'Missing call session conversationId' });
  }
  if (typeof userId !== 'string' || userId.length === 0) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (typeof messageId !== 'string' || messageId.length === 0) {
    return res.status(400).json({ error: 'messageId is required' });
  }

  try {
    const result = await getCompletedCortexInsightsForMessage({
      userId,
      messageId,
      conversationId: session.conversationId,
    });

    if (!result) {
      return res.status(404).json({ error: 'Message not found' });
    }

    return res.json({
      messageId: result.messageId,
      conversationId: result.conversationId,
      insights: result.insights,
      followUp: result.followUp ?? null,
    });
  } catch (err) {
    logger.error('[VIVENTIUM][voice/cortex] Failed to load cortex insights:', err);
    return res.status(500).json({ error: 'Failed to load cortex insights' });
  }
});

/* === VIVENTIUM START ===
 * Feature: Voice delivery for GlassHive worker completion
 * Purpose:
 * - Voice calls already poll persisted follow-ups after the main stream ends.
 * - GlassHive worker results are persisted as same-conversation callback messages,
 *   not cortex follow-ups, so voice needs a DB-backed lookup for that callback type.
 * === VIVENTIUM END === */
router.get('/glasshive/:messageId', voiceAuth, async (req, res) => {
  const session = req.viventiumCallSession;
  const userId = req.user?.id;
  const messageId = req.params?.messageId;

  if (
    !session ||
    typeof session.conversationId !== 'string' ||
    session.conversationId.length === 0
  ) {
    return res.status(400).json({ error: 'Missing call session conversationId' });
  }
  if (typeof userId !== 'string' || userId.length === 0) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (typeof messageId !== 'string' || messageId.length === 0) {
    return res.status(400).json({ error: 'messageId is required' });
  }

  try {
    const result = await getGlassHiveCallbackStateForMessage({
      userId,
      messageId,
      conversationId: session.conversationId,
    });

    return res.json(
      result ?? {
        messageId,
        conversationId: session.conversationId,
        latest: null,
        callbacks: [],
      },
    );
  } catch (err) {
    logger.error('[VIVENTIUM][voice/glasshive] Failed to load GlassHive callback:', err);
    return res.status(500).json({ error: 'Failed to load GlassHive callback' });
  }
});

/* === VIVENTIUM START ===
 * Feature: Voice claim/mark support for durable GlassHive callback delivery.
 * Purpose:
 * - Voice may still speak a worker completion while the call is live.
 * - The claim/mark ledger keeps voice aligned with Telegram duplicate suppression
 *   and leaves late-after-call callbacks observable instead of silently lost.
 * Added: 2026-05-06
 * === VIVENTIUM END === */
router.post('/glasshive/deliveries/claim', voiceAuth, async (req, res) => {
  try {
    const deliveries = await claimPendingGlassHiveCallbackDeliveries({
      surface: 'voice',
      limit: 1,
      leaseMs: req.body?.leaseMs,
      claimOwner:
        req.body?.dispatcherId || `voice-${req.viventiumCallSession?.callSessionId || 'gateway'}`,
      callbackId: req.body?.callbackId || '',
      userId: req.user?.id || '',
      voiceCallSessionId: req.viventiumCallSession?.callSessionId || '',
    });
    return res.json({ deliveries });
  } catch (err) {
    logger.error('[VIVENTIUM][voice/glasshive-delivery] Claim failed:', err);
    return res.status(500).json({ error: 'Failed to claim GlassHive delivery' });
  }
});

router.post('/glasshive/deliveries/:deliveryId/status', voiceAuth, async (req, res) => {
  const deliveryId = String(req.params?.deliveryId || '').trim();
  const claimId = String(req.body?.claimId || '').trim();
  const status = String(req.body?.status || '').trim();
  if (!deliveryId || !claimId) {
    return res.status(400).json({ error: 'deliveryId and claimId are required' });
  }
  try {
    let delivery = null;
    if (status === 'sent') {
      delivery = await markGlassHiveCallbackDeliverySent({
        deliveryId,
        claimId,
        userId: req.user?.id || '',
        voiceCallSessionId: req.viventiumCallSession?.callSessionId || '',
      });
    } else if (status === 'failed') {
      delivery = await markGlassHiveCallbackDeliveryFailed({
        deliveryId,
        claimId,
        error: req.body?.error || '',
        userId: req.user?.id || '',
        voiceCallSessionId: req.viventiumCallSession?.callSessionId || '',
      });
    } else if (status === 'suppressed') {
      delivery = await markGlassHiveCallbackDeliverySuppressed({
        deliveryId,
        claimId,
        reason: req.body?.reason || '',
        userId: req.user?.id || '',
        voiceCallSessionId: req.viventiumCallSession?.callSessionId || '',
      });
    } else {
      return res.status(400).json({ error: 'Unsupported delivery status' });
    }
    if (!delivery) {
      return res.status(409).json({ error: 'delivery_not_claimed' });
    }
    return res.json({ delivery });
  } catch (err) {
    logger.error('[VIVENTIUM][voice/glasshive-delivery] Status update failed:', err);
    return res.status(500).json({ error: 'Failed to update GlassHive delivery' });
  }
});

module.exports = router;

/* === VIVENTIUM NOTE === */
