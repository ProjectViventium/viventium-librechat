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
 * - POST /api/viventium/voice/stream/:streamId/abort -> aborts a voice-owned generation stream
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
  abandonVoiceSessionClaim,
  assertCallSessionSecret,
  assertCallBrowserCapability,
  claimVoiceSession,
  heartbeatCallSession,
  markVoiceSessionReady,
  reportVoiceSessionFailure,
  assertVoiceGatewayAuth,
  claimOrReplaceCallSessionConversationId,
  materializeCallSessionConversationId,
  updateCallSessionConversationId,
} = require('~/server/services/viventium/CallSessionService');
const { getUserById, saveMessage } = require('~/models');
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
  attachLogicalTurnMetadata,
  createVoiceInteractionContext,
  getTrustedInteractionContext,
  setTrustedInteractionContext,
} = require('~/server/services/viventium/interactionContext');
const {
  isListenOnlyTranscriptMessage,
} = require('~/server/services/viventium/listenOnlyTranscript');
const {
  formatVoiceLatencyDurationFields,
  formatVoiceLatencyTiming,
  getVoiceLatencyTotalMs,
  markVoiceLatencyStart,
  voiceLatencyNow,
} = require('~/server/services/viventium/voiceLatencyTiming');
const {
  legacySpeakerLabel,
  listSpeakerSegments,
  normalizeSpeakerSegments,
  persistSpeakerSegments,
  persistSpeakerSessionState,
  projectSpeakerSegmentRevisionsToMessages,
  voiceTurnAuthority,
} = require('~/server/services/viventium/SpeakerSegmentService');
const {
  bindVoiceTaskStream,
  canConfirmVoiceTaskCancellation,
  completeVoiceTask,
  createVoiceTask,
  failVoiceTask,
  getVoiceTask,
  getVoiceTaskByStreamId,
  getVoiceTaskOwnerCapabilityInventory,
  hydrateVoiceTask,
  hydrateVoiceTaskByStreamId,
  hydrateVoiceTasksForCall,
  isVoiceTaskSuppressedDurably,
  listVoiceTasks,
  listDurableVoiceTaskSnapshots,
  observeGenerationEvent,
  requestVoiceTaskOwnerCancellation,
  retryVoiceTask,
  settleVoiceTaskCancellation,
  snapshotEvent,
  submitVoiceTaskInput,
  subscribeVoiceTask,
  subscribeVoiceTasksForCall,
  subscribeDurableVoiceTaskEventsForCall,
} = require('~/server/services/viventium/VoiceTaskService');
const {
  requireVoiceAgentAccess,
} = require('~/server/services/viventium/VoiceAgentAuthorizationService');

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
const VOICE_TURN_COALESCE_WINDOW_MS_CONFIGURED =
  process.env.VIVENTIUM_VOICE_TURN_COALESCE_WINDOW_MS != null;
const VOICE_TURN_COALESCE_WINDOW_MS = Math.max(
  parseIntEnv('VIVENTIUM_VOICE_TURN_COALESCE_WINDOW_MS', 0),
  0,
);
const VOICE_LIVE_TURN_COALESCE_WINDOW_MS = Math.max(
  parseIntEnv('VIVENTIUM_VOICE_LIVE_TURN_COALESCE_WINDOW_MS', VOICE_TURN_COALESCE_WINDOW_MS),
  0,
);
const ambientTranscriptTails = new Map();

async function acquireAmbientTranscriptLock(callSessionId) {
  const key = String(callSessionId || '');
  const previous = ambientTranscriptTails.get(key) || Promise.resolve();
  let releaseCurrent;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.then(() => current);
  ambientTranscriptTails.set(key, tail);
  await previous;
  return () => {
    releaseCurrent();
    if (ambientTranscriptTails.get(key) === tail) {
      ambientTranscriptTails.delete(key);
    }
  };
}
const VOICE_LISTEN_ONLY_TURN_COALESCE_WINDOW_MS = Math.max(
  parseIntEnv(
    'VIVENTIUM_VOICE_LISTEN_ONLY_TURN_COALESCE_WINDOW_MS',
    VOICE_TURN_COALESCE_WINDOW_MS_CONFIGURED ? VOICE_TURN_COALESCE_WINDOW_MS : 350,
  ),
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
const VOICE_TURN_CONTINUATION_WINDOW_MS = Math.max(
  parseIntEnv('VIVENTIUM_VOICE_TURN_CONTINUATION_WINDOW_MS', 4000),
  0,
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
  const timingPart = formatVoiceLatencyTiming(req, stageStartAt);
  const detailPart = details ? ` ${details}` : '';
  logger.info(
    `[VoiceLatency][LC][Route] stage=${stage} request_id=${getVoiceLatencyRequestId(req)} ${timingPart}${detailPart}`,
  );
};

function initializeVoiceChatLatency(req, _res, next) {
  const logLatency = parseBoolEnv('VIVENTIUM_VOICE_LOG_LATENCY', false);
  if (logLatency) {
    markVoiceLatencyStart(req, req.get('X-VIVENTIUM-REQUEST-ID') || '');
    logVoiceRouteStage(
      req,
      'gateway_dispatch_received',
      req.viventiumVoicePerfStartAt,
      'method=POST',
    );
    logVoiceRouteStage(req, 'voice_chat_route_enter', req.viventiumVoicePerfStartAt, 'method=POST');
  }
  next();
}

function timedConfigMiddleware(req, res, next) {
  const stageStartAt = voiceLatencyNow();
  configMiddleware(req, res, (err) => {
    logVoiceRouteStage(req, 'voice_config_done', stageStartAt, `status=${err ? 'error' : 'ok'}`);
    next(err);
  });
}

function timedValidateConvoAccess(req, res, next) {
  const stageStartAt = voiceLatencyNow();
  if (
    req?.viventiumCallSession &&
    req.viventiumVoiceConvoAccessVerified === true &&
    req.body?.conversationId === req.viventiumVoiceResolvedConversationId
  ) {
    logVoiceRouteStage(req, 'validate_convo_done', stageStartAt, 'status=skipped_verified_voice');
    next();
    return;
  }
  validateConvoAccess(req, res, (err) => {
    logVoiceRouteStage(req, 'validate_convo_done', stageStartAt, `status=${err ? 'error' : 'ok'}`);
    next(err);
  });
}

function timedBuildEndpointOption(req, res, next) {
  const stageStartAt = voiceLatencyNow();
  buildEndpointOption(req, res, (err) => {
    logVoiceRouteStage(
      req,
      'build_endpoint_option_done',
      stageStartAt,
      `status=${err ? 'error' : 'ok'}`,
    );
    next(err);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveVoiceTurnCoalesceWindowMs(mode = 'normal') {
  if (mode === 'listen_only') {
    return VOICE_LISTEN_ONLY_TURN_COALESCE_WINDOW_MS;
  }
  return VOICE_LIVE_TURN_COALESCE_WINDOW_MS;
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

function combineVoiceSpeakerSegments(segments) {
  if (!Array.isArray(segments)) {
    return [];
  }
  const candidates = [];
  segments.forEach((turnSegment, turnIndex) => {
    const receivedAtMs = Number(turnSegment?.receivedAtMs) || 0;
    const speakerSegments = Array.isArray(turnSegment?.speakerSegments)
      ? turnSegment.speakerSegments
      : turnSegment?.speakerSegment
        ? [turnSegment.speakerSegment]
        : [];
    speakerSegments.forEach((speakerSegment, speakerIndex) => {
      if (!speakerSegment?.segmentId) return;
      candidates.push({ speakerSegment, receivedAtMs, turnIndex, speakerIndex });
    });
  });
  candidates.sort(
    (left, right) =>
      left.receivedAtMs - right.receivedAtMs ||
      left.turnIndex - right.turnIndex ||
      Number(left.speakerSegment.sequence || 0) - Number(right.speakerSegment.sequence || 0) ||
      left.speakerIndex - right.speakerIndex,
  );
  const bestRevisionById = new Map();
  for (const candidate of candidates) {
    const existing = bestRevisionById.get(candidate.speakerSegment.segmentId);
    if (!existing || Number(candidate.speakerSegment.revision) > Number(existing.revision)) {
      bestRevisionById.set(candidate.speakerSegment.segmentId, candidate.speakerSegment);
    }
  }
  return [...bestRevisionById.values()].sort(
    (left, right) => Number(left.sequence || 0) - Number(right.sequence || 0),
  );
}

function voiceTurnTextAlreadyCaptured(capturedText, incomingText) {
  const captured = normalizeVoiceTurnText(capturedText);
  const incoming = normalizeVoiceTurnText(incomingText);
  return Boolean(captured && incoming && captured.includes(incoming));
}

function buildVoiceIngressKey({
  callSessionId,
  conversationId,
  parentMessageId,
  mode,
  speakerSegmentId,
}) {
  const normalizedMode = mode || 'normal';
  const normalizedSpeakerSegmentId = normalizeVoiceTurnText(speakerSegmentId).slice(0, 160);
  if (normalizedMode === 'listen_only') {
    return callSessionId ? `${normalizedMode}:${callSessionId}:listen-only-root` : '';
  }
  const normalizedParentMessageId =
    parentMessageId || (normalizedMode === 'listen_only' ? 'listen-only-root' : '');
  if (!callSessionId || !normalizedParentMessageId) {
    return '';
  }
  if (!conversationId) {
    return callSessionId && normalizedSpeakerSegmentId
      ? `${normalizedMode}:${callSessionId}:speaker-segment:${normalizedSpeakerSegmentId}`
      : '';
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
  speakerSegments = [],
}) {
  const normalizedText = normalizeVoiceTurnText(text);
  const speakerSegmentId = Array.isArray(speakerSegments) ? speakerSegments[0]?.segmentId : '';
  const dedupeKey = buildVoiceIngressKey({
    callSessionId,
    conversationId,
    parentMessageId,
    mode,
    speakerSegmentId,
  });
  const coalesceWindowMs = resolveVoiceTurnCoalesceWindowMs(mode);
  if (!VOICE_TURN_COALESCE_ENABLED || !normalizedText || !dedupeKey) {
    return {
      shouldLaunch: true,
      mergedText: normalizedText || text,
      mergedSpeakerSegments: Array.isArray(speakerSegments) ? speakerSegments : [],
      dedupeKey: '',
      coalesceWindowMs,
    };
  }

  const normalizedReceivedAtMs = Number.isFinite(receivedAtMs) ? Number(receivedAtMs) : Date.now();
  const segment = {
    text: normalizedText,
    receivedAtMs: normalizedReceivedAtMs,
    requestId,
    ...(Array.isArray(speakerSegments) && speakerSegments[0]
      ? { speakerSegment: speakerSegments[0] }
      : {}),
    speakerSegments: Array.isArray(speakerSegments) ? speakerSegments : [],
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

    if (coalesceWindowMs > 0) {
      await sleep(coalesceWindowMs);
    }
    const doc = await findVoiceIngressEvent({ dedupeKey });
    const mergedText =
      combineVoiceTurnSegments(doc?.segments || [normalizedText]) || normalizedText;
    const mergedSpeakerSegments = combineVoiceSpeakerSegments(doc?.segments || [segment]);
    return {
      shouldLaunch: true,
      mergedText,
      mergedSpeakerSegments,
      dedupeKey,
      coalesceWindowMs,
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
          coalesceWindowMs,
        };
      }
      break;
    }
    if (doc.status === 'listen_only') {
      const savedAtMs = doc.savedAt ? new Date(doc.savedAt).getTime() : 0;
      const savedText = combineVoiceTurnSegments(doc.segments || []);
      const messageId = typeof doc.messageId === 'string' ? doc.messageId.trim() : '';
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
          coalesceWindowMs,
        };
      }
      if (savedAtMs && messageId && Date.now() - savedAtMs <= VOICE_TURN_CONTINUATION_WINDOW_MS) {
        const continuationDoc = await updateVoiceIngressEvent(
          { dedupeKey, status: 'listen_only', messageId },
          {
            $push: { segments: segment },
            $set: {
              status: 'buffering',
              requestId,
              conversationId,
              parentMessageId,
              saved: false,
              savedAt: null,
              expiresAt,
            },
          },
          { new: true },
        );
        if (continuationDoc?.status === 'buffering') {
          if (coalesceWindowMs > 0) {
            await sleep(coalesceWindowMs);
          }
          const latestDoc = await findVoiceIngressEvent({ dedupeKey });
          const mergedText =
            combineVoiceTurnSegments(latestDoc?.segments || [segment]) || normalizedText;
          const mergedSpeakerSegments = combineVoiceSpeakerSegments(
            latestDoc?.segments || [segment],
          );
          return {
            shouldLaunch: true,
            mergedText,
            mergedSpeakerSegments,
            dedupeKey,
            continuationMessageId: messageId,
            coalesceWindowMs,
          };
        }
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
        if (coalesceWindowMs > 0) {
          await sleep(coalesceWindowMs);
        }
        const latestDoc = await findVoiceIngressEvent({ dedupeKey });
        const mergedText =
          combineVoiceTurnSegments(latestDoc?.segments || [segment]) || normalizedText;
        const mergedSpeakerSegments = combineVoiceSpeakerSegments(latestDoc?.segments || [segment]);
        return {
          shouldLaunch: true,
          mergedText,
          mergedSpeakerSegments,
          dedupeKey,
          coalesceWindowMs,
        };
      }
      break;
    }

    if (!bufferingDoc && doc.status !== 'buffering') {
      break;
    }
    await sleep(VOICE_TURN_COALESCE_POLL_MS);
  }

  const latestDoc = dedupeKey ? await findVoiceIngressEvent({ dedupeKey }) : null;
  return {
    shouldLaunch: true,
    mergedText: combineVoiceTurnSegments(latestDoc?.segments || [segment]) || normalizedText,
    mergedSpeakerSegments: combineVoiceSpeakerSegments(latestDoc?.segments || [segment]),
    dedupeKey: '',
    coalesceWindowMs,
  };
}

/* === VIVENTIUM START ===
 * Feature: Listen-Only Mode
 * Purpose: Persist ambient call transcript records without entering the Agents controller,
 * background cortex, TTS, tools, or live memory writer path.
 * === VIVENTIUM END === */
function normalizeListenOnlySpeakerLabel(incoming) {
  const normalizedSegments = Array.isArray(incoming?.speakerSegments)
    ? incoming.speakerSegments
    : [];
  if (normalizedSegments.length > 0) {
    return legacySpeakerLabel(normalizedSegments);
  }
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
  continuationMessageId = '',
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

  const now = new Date();
  const speakerLabel = normalizeListenOnlySpeakerLabel(incoming);
  const speakerSegments = Array.isArray(incoming?.speakerSegments) ? incoming.speakerSegments : [];
  const requestId =
    req.viventiumVoiceRequestId || req.get('X-VIVENTIUM-REQUEST-ID') || crypto.randomUUID();
  const normalizedContinuationMessageId =
    typeof continuationMessageId === 'string' ? continuationMessageId.trim() : '';
  if (normalizedContinuationMessageId) {
    const continuationFilter = {
      user: userId,
      messageId: normalizedContinuationMessageId,
      'metadata.viventium.type': 'listen_only_transcript',
    };
    if (session?.callSessionId) {
      continuationFilter['metadata.viventium.callSessionId'] = session.callSessionId;
    }
    const message = await Message.findOneAndUpdate(
      continuationFilter,
      {
        $set: {
          text: normalizedText,
          updatedAt: now,
          unfinished: false,
          error: false,
          'metadata.viventium.speakerLabel': speakerLabel,
          'metadata.viventium.speakerSegments': speakerSegments,
          'metadata.viventium.requestId': requestId,
        },
      },
      {
        new: true,
        timestamps: false,
      },
    );

    if (message) {
      const resolvedConversationId = isConcreteConversationId(message.conversationId)
        ? message.conversationId
        : isConcreteConversationId(conversationId)
          ? conversationId
          : session?.conversationId;
      if (isConcreteConversationId(resolvedConversationId)) {
        await Conversation.findOneAndUpdate(
          { user: userId, conversationId: resolvedConversationId },
          {
            $set: {
              updatedAt: now,
            },
            $addToSet: {
              messages: message._id,
            },
          },
          {
            upsert: false,
            new: true,
            timestamps: false,
          },
        );
      }
      return {
        saved: true,
        conversationId: resolvedConversationId,
        parentMessageId: message.parentMessageId || parentMessageId,
        messageId: normalizedContinuationMessageId,
        speakerLabel,
        continued: true,
      };
    }

    logger.warn(
      '[VIVENTIUM][voice/chat] Listen-Only continuation target was not found; saving a new transcript messageId=%s',
      normalizedContinuationMessageId,
    );
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
            speakerSegments,
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
    speakerSegments: req.body?.speakerSegments,
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
  if (Array.isArray(coalescedTurn.mergedSpeakerSegments)) {
    req.body.speakerSegments = coalescedTurn.mergedSpeakerSegments;
    req.body.speakerLabel = legacySpeakerLabel(coalescedTurn.mergedSpeakerSegments);
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
      continuationMessageId: coalescedTurn.continuationMessageId,
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
    try {
      await updateVoiceIngressEvent(
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
      );
    } catch (err) {
      logger.warn('[VIVENTIUM][voice/chat] Failed to update Listen-Only coalesced record:', err);
    }
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
const CLAIM_ABANDON_REASONS = new Set([
  'owner_timeout',
  'owner_mismatch',
  'gateway_initialization_failed',
]);

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
router.post('/claim/abandon', async (req, res) => {
  try {
    const callSessionId =
      req.get('X-VIVENTIUM-CALL-SESSION') || req.get('x-viventium-call-session') || '';
    const secret = req.get('X-VIVENTIUM-CALL-SECRET') || req.get('x-viventium-call-secret') || '';
    const jobId = req.get('X-VIVENTIUM-JOB-ID') || req.get('x-viventium-job-id') || '';
    const workerId = req.get('X-VIVENTIUM-WORKER-ID') || req.get('x-viventium-worker-id') || '';
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (
      !jobId ||
      !workerId ||
      jobId.length > 160 ||
      workerId.length > 160 ||
      !CLAIM_ABANDON_REASONS.has(reason)
    ) {
      return res.status(400).json({
        code: 'provider_failure',
        message: 'A valid job, worker, and abandon reason are required.',
        retryable: false,
      });
    }
    const session = await assertCallSessionSecret(callSessionId, secret);
    const released = await abandonVoiceSessionClaim({
      callSessionId: session.callSessionId,
      jobId,
      workerId,
    });
    logger.info('[VIVENTIUM][voice/claim] gateway_start_abandoned', {
      callSessionId: session.callSessionId,
      jobId,
      workerId,
      reason,
      released,
    });
    return res.json({ version: 1, released });
  } catch (err) {
    const status = err?.status || 401;
    return res.status(status).json({
      code: status === 401 ? 'auth_expired' : 'unknown',
      message: status === 401 ? 'The call session is unavailable.' : 'Unable to release the claim.',
      retryable: false,
    });
  }
});

router.post('/call-sessions/:callSessionId/failure', async (req, res) => {
  try {
    const headerSessionId =
      req.get('X-VIVENTIUM-CALL-SESSION') || req.get('x-viventium-call-session') || '';
    const secret = req.get('X-VIVENTIUM-CALL-SECRET') || req.get('x-viventium-call-secret') || '';
    const jobId = req.get('X-VIVENTIUM-JOB-ID') || req.get('x-viventium-job-id') || '';
    const workerId = req.get('X-VIVENTIUM-WORKER-ID') || req.get('x-viventium-worker-id') || '';
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const classification = typeof body.classification === 'string' ? body.classification : '';
    const modality = typeof body.modality === 'string' ? body.modality : '';
    const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
    const phase = typeof body.phase === 'string' ? body.phase : '';
    if (
      headerSessionId !== req.params.callSessionId ||
      Number(body.version) !== 1 ||
      !['no_route', 'provider_failure', 'gateway_down'].includes(classification) ||
      (modality && !['stt', 'tts'].includes(modality)) ||
      !['initialization', 'runtime'].includes(phase) ||
      typeof body.fatal !== 'boolean' ||
      !jobId ||
      !workerId ||
      jobId.length > 160 ||
      workerId.length > 160 ||
      provider.length > 80
    ) {
      return res.status(400).json({
        code: 'provider_failure',
        message: 'Invalid structured voice failure report.',
        retryable: false,
      });
    }
    const session = await assertCallSessionSecret(headerSessionId, secret);
    const updated = await reportVoiceSessionFailure({
      callSessionId: session.callSessionId,
      jobId,
      workerId,
      classification,
      modality,
      provider,
      phase,
      fatal: body.fatal,
    });
    if (!updated) {
      return res.status(409).json({
        code: 'auth_expired',
        message: 'The gateway no longer owns this call session.',
        retryable: false,
      });
    }
    return res.json({
      version: 1,
      callSessionId: updated.callSessionId,
      status: updated.status,
      error: updated.error,
    });
  } catch (err) {
    return res.status(err?.status || 401).json({
      code: 'auth_expired',
      message: 'The call session is unavailable.',
      retryable: false,
    });
  }
});

/* === VIVENTIUM START ===
 * Feature: exact-owner provider recovery readiness
 * Purpose: Clear a retryable startup/runtime failure only after the currently claimed gateway
 * proves provider and call-session readiness; browser state writes cannot acknowledge recovery.
 * === VIVENTIUM END === */
router.post('/call-sessions/:callSessionId/ready', async (req, res) => {
  try {
    const headerSessionId =
      req.get('X-VIVENTIUM-CALL-SESSION') || req.get('x-viventium-call-session') || '';
    const secret = req.get('X-VIVENTIUM-CALL-SECRET') || req.get('x-viventium-call-secret') || '';
    const jobId = req.get('X-VIVENTIUM-JOB-ID') || req.get('x-viventium-job-id') || '';
    const workerId = req.get('X-VIVENTIUM-WORKER-ID') || req.get('x-viventium-worker-id') || '';
    if (
      Number(req.body?.version) !== 1 ||
      headerSessionId !== req.params.callSessionId ||
      !jobId ||
      !workerId ||
      jobId.length > 160 ||
      workerId.length > 160
    ) {
      return res.status(400).json({
        code: 'provider_failure',
        message: 'A valid call session, job, and worker are required.',
        retryable: false,
      });
    }
    const session = await assertCallSessionSecret(headerSessionId, secret);
    const updated = await markVoiceSessionReady({
      callSessionId: session.callSessionId,
      jobId,
      workerId,
    });
    if (!updated) {
      return res.status(409).json({
        code: 'auth_expired',
        message: 'The gateway no longer owns this call session.',
        retryable: false,
      });
    }
    return res.json({
      version: 1,
      callSessionId: updated.callSessionId,
      mode: updated.mode || 'call',
      status: 'listening',
      revision: Number(updated.revision) || 0,
      updatedAt: new Date(Number(updated.updatedAt)).toISOString(),
    });
  } catch (error) {
    const status = error?.status || 401;
    return res.status(status).json({
      code: 'auth_expired',
      message: 'The call session expired or is unauthorized.',
      retryable: false,
    });
  }
});

router.post('/claim', async (req, res) => {
  try {
    const callSessionId =
      req.get('X-VIVENTIUM-CALL-SESSION') || req.get('x-viventium-call-session') || '';
    const secret = req.get('X-VIVENTIUM-CALL-SECRET') || req.get('x-viventium-call-secret') || '';
    const jobId = req.get('X-VIVENTIUM-JOB-ID') || req.get('x-viventium-job-id') || '';
    const workerId = req.get('X-VIVENTIUM-WORKER-ID') || req.get('x-viventium-worker-id') || '';

    const session = await assertCallSessionSecret(callSessionId, secret);
    if (session.status === 'ended') {
      return res.status(410).json({
        code: 'auth_expired',
        message: 'The call session has ended.',
        retryable: false,
      });
    }
    if (!jobId || !workerId || jobId.length > 160 || workerId.length > 160) {
      return res.status(400).json({
        code: 'provider_failure',
        message: 'A valid voice job and worker identity are required.',
        retryable: false,
      });
    }

    const claimed = await claimVoiceSession({
      callSessionId: session.callSessionId,
      jobId,
      workerId,
    });
    if (!claimed) {
      return res.status(409).json({
        code: 'auth_expired',
        message: 'The call session is unavailable or already claimed.',
        retryable: false,
      });
    }
    const claimMode = ['call', 'wing', 'listen_only'].includes(claimed.mode)
      ? claimed.mode
      : claimed.listenOnlyModeEnabled === true
        ? 'listen_only'
        : claimed.wingModeEnabled === true
          ? 'wing'
          : 'call';
    const claimStatus = [
      'created',
      'connecting',
      'listening',
      'speaking',
      'working',
      'needs_input',
      'degraded',
      'failed',
      'ended',
    ].includes(claimed.status)
      ? claimed.status
      : 'created';
    const claimUpdatedAt = new Date(Number(claimed.updatedAt)).toISOString();

    return res.json({
      status: 'claimed',
      callSessionId: claimed.callSessionId,
      roomName: claimed.roomName,
      gatewayAgentName: claimed.gatewayAgentName,
      ownerParticipantIdentity: claimed.ownerParticipantIdentity,
      requestedVoiceRoute: claimed.requestedVoiceRoute,
      speakerSessionState: claimed.speakerSessionState || null,
      jobId: claimed.activeJobId,
      workerId: claimed.activeWorkerId,
      leaseExpiresAtMs: claimed.leaseExpiresAtMs,
      callState: {
        version: 1,
        callSessionId: claimed.callSessionId,
        mode: claimMode,
        status: claimStatus,
        revision: Number.isFinite(Number(claimed.revision)) ? Number(claimed.revision) : 0,
        updatedAt: claimUpdatedAt,
        ...(claimed.error ? { error: claimed.error } : {}),
      },
    });
  } catch (err) {
    const status = err?.status || 401;
    logger.error('[VIVENTIUM][voice/claim] Auth failed', {
      code: status === 401 || status === 410 ? 'auth_expired' : 'unknown',
      status,
    });
    return res.status(status).json({
      code: status === 401 || status === 410 ? 'auth_expired' : 'unknown',
      message:
        status === 401 || status === 410
          ? 'The call session expired or is unauthorized.'
          : 'The call session is unavailable.',
      retryable: false,
    });
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
  const authStartAt = voiceLatencyNow();
  try {
    const sessionClaimStartAt = voiceLatencyNow();
    const session = await assertVoiceGatewayAuth(req);
    logVoiceRouteStage(
      req,
      'voice_auth_session_claim_done',
      sessionClaimStartAt,
      `agent_id=${session?.agentId || 'unknown'} convo_id=${session?.conversationId || 'new'}`,
    );
    req.viventiumCallSession = session;

    // Load full user document (matches JWT auth behavior in jwtStrategy.js)
    const userLookupStartAt = voiceLatencyNow();
    const user = await getUserById(session.userId, '-password -__v -totpSecret -backupCodes');
    logVoiceRouteStage(
      req,
      'voice_auth_user_done',
      userLookupStartAt,
      `status=${user ? 'ok' : 'missing'}`,
    );
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
    logVoiceRouteStage(
      req,
      'voice_auth_done',
      authStartAt,
      `agent_id=${session?.agentId || 'unknown'} convo_id=${session?.conversationId || 'new'} role=${user.role || 'unknown'}`,
    );
    next();
  } catch (err) {
    logVoiceRouteStage(
      req,
      'voice_auth_done',
      authStartAt,
      `status=error reason=${err?.status || 401}`,
    );
    const status = err?.status || 401;
    logger.error('[VIVENTIUM][voiceAuth] Auth failed:', err);
    return res.status(status).json({
      code: 'auth_expired',
      message: 'The call session expired or is unauthorized.',
      retryable: false,
    });
  }
}

/* === VIVENTIUM START ===
 * Feature: browser-BFF call capability auth
 * Purpose: The trusted UI server can restore captions and manage the current call's tasks without
 * receiving a gateway job lease. This middleware is intentionally attached only to the bounded
 * snapshot/control routes below; all ingress, event production, and speaker mutation keeps the
 * stricter voiceAuth worker-job requirement.
 * === VIVENTIUM END === */
async function voiceSessionCapabilityAuth(req, res, next) {
  try {
    const callSessionId = req.get('X-VIVENTIUM-CALL-SESSION') || '';
    const secret = req.get('X-VIVENTIUM-CALL-SECRET') || '';
    const browserCapability = req.get('X-VIVENTIUM-CALL-CAPABILITY') || '';
    if (!callSessionId) {
      const error = new Error('Missing call session capability');
      error.status = 401;
      throw error;
    }
    const session = await assertCallSessionSecret(callSessionId, secret);
    const browserSession = await assertCallBrowserCapability(callSessionId, browserCapability);
    if (!session || session.callSessionId !== callSessionId) {
      const error = new Error('Call session capability mismatch');
      error.status = 401;
      throw error;
    }
    if (browserSession.callSessionId !== session.callSessionId) {
      const error = new Error('Call browser capability mismatch');
      error.status = 401;
      throw error;
    }
    const user = await getUserById(session.userId, '-password -__v -totpSecret -backupCodes');
    if (!user) {
      const error = new Error('User not found for call session');
      error.status = 401;
      throw error;
    }
    user.id = user._id.toString();
    if (!user.role) {
      user.role = SystemRoles.USER;
    }
    req.viventiumCallSession = session;
    req.user = user;
    return next();
  } catch (error) {
    return res.status(error?.status || 401).json({
      code: 'auth_expired',
      message: 'The call session expired or is unauthorized.',
      retryable: false,
    });
  }
}

/* === VIVENTIUM START ===
 * Feature: gateway dynamic call-mode state
 * Purpose: Let the connected worker observe atomic Call/Wing/Listen-Only switches without
 * reconnecting or trusting browser-supplied mode flags.
 * === VIVENTIUM END === */
router.get('/call-sessions/:callSessionId/state', voiceAuth, async (req, res) => {
  const session = await heartbeatCallSession({
    callSessionId: req.viventiumCallSession?.callSessionId,
    currentSession: req.viventiumCallSession,
  });
  if (req.params.callSessionId !== session?.callSessionId) {
    return res.status(404).json({
      code: 'auth_expired',
      message: 'Call session not found.',
      retryable: false,
    });
  }
  return res.json({
    version: 1,
    callSessionId: session.callSessionId,
    mode:
      session.mode ||
      (session.listenOnlyModeEnabled === true
        ? 'listen_only'
        : session.wingModeEnabled === true
          ? 'wing'
          : 'call'),
    status: session.status || 'created',
    revision: Number(session.revision) || 0,
    updatedAt: new Date(Number(session.updatedAt) || Date.now()).toISOString(),
    ...(session.error ? { error: session.error } : {}),
  });
});

/* === VIVENTIUM START ===
 * Feature: Late SpeakerSegmentV1 revisions
 * Purpose: Let the authenticated gateway downgrade/revise an earlier segment immediately, even
 * when no later chat turn exists. Revisions are monotonic and remain scoped to the call session.
 * === VIVENTIUM END === */
router.post('/speaker-segments/revisions', voiceAuth, async (req, res) => {
  const session = req.viventiumCallSession;
  const revisions = normalizeSpeakerSegments(req.body?.speakerSegmentRevisions, {
    callSessionId: session?.callSessionId,
    ownerParticipantIdentity: session?.ownerParticipantIdentity,
    ownerTrackSid: req.body?.ownerTrackSid,
    speakerAttributionState: session?.speakerAttributionState,
  });
  if (revisions.length === 0) {
    return res
      .status(400)
      .json({ error: 'speakerSegmentRevisions must contain a valid V1 segment' });
  }
  const result = await persistSpeakerSegments({
    callSessionId: session.callSessionId,
    currentSegments: [],
    revisions,
    expiresAtMs: session.expiresAtMs,
    ownerParticipantIdentity: session?.ownerParticipantIdentity,
    ownerTrackSid: req.body?.ownerTrackSid,
    speakerAttributionState: session?.speakerAttributionState,
  });
  await projectSpeakerSegmentRevisionsToMessages({
    callSessionId: session.callSessionId,
    segments: result.effectiveSegments,
  });
  return res.json({ version: 1, accepted: result.accepted, ignored: result.ignored });
});

/* === VIVENTIUM START ===
 * Feature: SpeakerSessionStateV1 downgrade tombstone
 * Purpose: Persist the session-wide shared-microphone trust downgrade before paged segment
 * revisions, so memory and action authority fail closed after reordering or partial delivery.
 * === VIVENTIUM END === */
router.post('/speaker-session-state', voiceAuth, async (req, res) => {
  try {
    const result = await persistSpeakerSessionState({
      callSessionId: req.viventiumCallSession?.callSessionId,
      state: req.body,
    });
    return res.json({ version: 1, accepted: result.accepted, state: result.state });
  } catch (error) {
    if (Number(error?.status) === 400) {
      return res.status(400).json({
        code: 'provider_failure',
        message: error?.message || 'Invalid speaker session state.',
        retryable: false,
      });
    }
    logger.error('[VIVENTIUM][speaker-session-state] persistence failed', {
      callSessionId: req.viventiumCallSession?.callSessionId,
      error: error?.message || 'unknown',
    });
    return res.status(503).json({
      code: 'gateway_down',
      message: 'Speaker state persistence is temporarily unavailable.',
      retryable: true,
    });
  }
});

/* === VIVENTIUM START ===
 * Feature: SpeakerSegmentV1 reconnect snapshot
 * Purpose: Restore persisted call-scoped captions after refresh/reconnect without exposing audio
 * or another call session. The ledger is TTL-bounded and returns at most 512 latest segments.
 * === VIVENTIUM END === */
router.get('/speaker-segments', voiceSessionCapabilityAuth, async (req, res) => {
  const callSessionId = typeof req.query?.callSessionId === 'string' ? req.query.callSessionId : '';
  if (!callSessionId || callSessionId !== req.viventiumCallSession?.callSessionId) {
    return res.status(403).json({
      code: 'auth_expired',
      message: 'Call session not found.',
      retryable: false,
    });
  }
  const beforeSequence =
    req.query?.beforeSequence !== undefined &&
    Number.isFinite(Number(req.query.beforeSequence)) &&
    Number(req.query.beforeSequence) >= 0
      ? Math.floor(Number(req.query.beforeSequence))
      : undefined;
  const beforeSegmentId =
    typeof req.query?.beforeSegmentId === 'string' ? req.query.beforeSegmentId : undefined;
  const afterSequence =
    req.query?.afterSequence !== undefined &&
    Number.isFinite(Number(req.query.afterSequence)) &&
    Number(req.query.afterSequence) >= 0
      ? Math.floor(Number(req.query.afterSequence))
      : undefined;
  const afterSegmentId =
    typeof req.query?.afterSegmentId === 'string' ? req.query.afterSegmentId : undefined;
  if (
    (beforeSequence !== undefined || beforeSegmentId !== undefined) &&
    (afterSequence !== undefined || afterSegmentId !== undefined)
  ) {
    return res.status(400).json({
      code: 'unknown',
      message: 'Speaker history accepts one paging direction at a time.',
      retryable: false,
    });
  }
  const page = await listSpeakerSegments({
    callSessionId,
    limit: 512,
    beforeSequence,
    beforeSegmentId,
    afterSequence,
    afterSegmentId,
    page: true,
  });
  const normalizedPage = Array.isArray(page) ? { segments: page, hasMore: false } : page;
  return res.json({ version: 1, ...normalizedPage });
});

/* === VIVENTIUM START ===
 * Feature: authenticated ambient-participant transcript ingress
 * Purpose: Persist signed non-owner tracks as soft call evidence while structurally avoiding the
 * Agents controller and therefore TTS, tools, cortex, live memory, recall, and side effects.
 * === VIVENTIUM END === */
router.post('/ambient-transcript', voiceAuth, async (req, res) => {
  const session = req.viventiumCallSession;
  const incoming = req.body && typeof req.body === 'object' ? req.body : {};
  const authoritativeMode = ['call', 'wing', 'listen_only'].includes(session?.mode)
    ? session.mode
    : session?.listenOnlyModeEnabled === true
      ? 'listen_only'
      : session?.wingModeEnabled === true
        ? 'wing'
        : 'call';
  const isListenOnlyOwner = incoming.ingressKind === 'listen_only_owner';
  if (
    Number(incoming.version) !== 1 ||
    !['ambient_participant', 'listen_only_owner'].includes(incoming.ingressKind) ||
    incoming.callSessionId !== session?.callSessionId
  ) {
    return res.status(400).json({
      code: 'unknown',
      message: 'Invalid ambient participant transcript contract',
      retryable: false,
    });
  }
  if (isListenOnlyOwner && authoritativeMode !== 'listen_only') {
    return res.status(409).json({
      code: 'provider_failure',
      message: 'Owner Listen-Only ingress requires an active Listen-Only call session.',
      retryable: false,
    });
  }

  const segments = normalizeSpeakerSegments(incoming.segments, {
    callSessionId: session.callSessionId,
    ambientIngress: true,
    ...(isListenOnlyOwner ? { ownerParticipantIdentity: session?.ownerParticipantIdentity } : {}),
    speakerAttributionState: session?.speakerAttributionState,
  });
  if (segments.length === 0) {
    return res.status(400).json({
      code: 'unknown',
      message: 'segments must contain at least one valid SpeakerSegmentV1',
      retryable: false,
    });
  }
  const persistedSegments = await persistSpeakerSegments({
    callSessionId: session.callSessionId,
    currentSegments: segments,
    revisions: [],
    expiresAtMs: session.expiresAtMs,
    ambientIngress: true,
    ...(isListenOnlyOwner ? { ownerParticipantIdentity: session?.ownerParticipantIdentity } : {}),
    speakerAttributionState: session?.speakerAttributionState,
  });
  const effectiveSegments = Array.isArray(persistedSegments.effectiveSegments)
    ? persistedSegments.effectiveSegments
    : segments.filter((segment) =>
        [...(persistedSegments.accepted || []), ...(persistedSegments.ignored || [])].includes(
          segment.segmentId,
        ),
      );
  const releaseAmbientLock = await acquireAmbientTranscriptLock(session.callSessionId);
  try {
    const requestedConversationId = session.conversationId || 'new';
    const state = await resolveReusableConversationState({
      conversationId: requestedConversationId,
      userId: req.user?.id,
      surface: 'voice',
      agentId: session.agentId,
    });
    let conversationId = state.conversationId;
    if (!isConcreteConversationId(conversationId)) {
      const materialized = await materializeCallSessionConversationId(
        session.callSessionId,
        crypto.randomUUID(),
      );
      conversationId = materialized?.conversationId;
    }
    if (!isConcreteConversationId(conversationId)) {
      return res.status(409).json({
        code: 'auth_expired',
        message: 'The call session ended before its transcript could be saved.',
        retryable: false,
      });
    }

    const now = new Date();
    let parentMessageId = state.parentMessageId;
    const messageIds = [];
    for (const segment of effectiveSegments) {
      const messageId = `ambient-${crypto
        .createHash('sha256')
        .update(`${session.callSessionId}:${segment.segmentId}`)
        .digest('hex')
        .slice(0, 32)}`;
      const existingMessage = await Message.findOne({ user: req.user.id, messageId })
        .select({ _id: 1, messageId: 1, parentMessageId: 1 })
        .lean();
      const message = await Message.findOneAndUpdate(
        { user: req.user.id, messageId },
        {
          $set: {
            endpoint: 'agents',
            sender: segment.speaker.label || 'Participant',
            text: segment.text,
            _meiliIndex: false,
            memoryEligible: 'soft',
            isCreatedByUser: false,
            tokenCount: 0,
            unfinished: !segment.isFinal,
            error: false,
            metadata: {
              viventium: {
                type: isListenOnlyOwner ? 'listen_only_transcript' : 'voice_ambient_transcript',
                source: 'voice_call',
                mode: authoritativeMode,
                ingressKind: incoming.ingressKind,
                ambientKind: isListenOnlyOwner
                  ? 'listen_only_owner_track'
                  : 'authenticated_participant_track',
                callSessionId: session.callSessionId,
                turnId: segment.turnId,
                speakerLabel: segment.speaker.label || 'Unknown',
                speakerSegments: [segment],
                actorTrust: segment.speaker.actorTrust,
                memoryEligible: 'soft',
              },
            },
            updatedAt: now,
          },
          $setOnInsert: {
            user: req.user.id,
            messageId,
            conversationId,
            parentMessageId,
            createdAt: now,
          },
        },
        { upsert: true, new: true, timestamps: false, overwriteImmutable: true },
      );
      await Conversation.findOneAndUpdate(
        { user: req.user.id, conversationId },
        {
          $setOnInsert: {
            user: req.user.id,
            conversationId,
            title: 'Call Transcript',
            endpoint: 'agents',
            agent_id: session.agentId || null,
            createdAt: now,
          },
          $set: { updatedAt: now },
          $addToSet: { messages: message._id },
        },
        { upsert: true, new: true, timestamps: false, overwriteImmutable: true },
      );
      if (!existingMessage) {
        parentMessageId = messageId;
      }
      messageIds.push(messageId);
    }

    return res.json({
      version: 1,
      accepted: persistedSegments.accepted || [],
      rejected: persistedSegments.ignored || [],
      conversationId,
      messageIds,
    });
  } finally {
    releaseAmbientLock();
  }
});

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
  initializeVoiceChatLatency,
  voiceAuth,
  requireVoiceAgentAccess,
  timedConfigMiddleware,
  async (req, _res, next) => {
    req.viventiumVoiceIngressReceivedAtMs = Date.now();
    const session = req.viventiumCallSession;
    const incoming = req.body ?? {};
    const text = typeof incoming.text === 'string' ? incoming.text : '';
    const speakInsights = incoming.speakInsights === true;
    const systemPrompt = typeof incoming.systemPrompt === 'string' ? incoming.systemPrompt : '';
    /* === VIVENTIUM START ===
     * Feature: SpeakerSegmentV1 persistence and authority
     * Purpose: Store current segments and late revisions before any coalescing or agent execution.
     * === VIVENTIUM END === */
    const currentSegments = normalizeSpeakerSegments(incoming.speakerSegments, {
      callSessionId: session?.callSessionId,
      ownerParticipantIdentity: session?.ownerParticipantIdentity,
      ownerTrackSid: incoming.ownerTrackSid,
      speakerAttributionState: session?.speakerAttributionState,
    });
    const speakerSegmentRevisions = normalizeSpeakerSegments(incoming.speakerSegmentRevisions, {
      callSessionId: session?.callSessionId,
      ownerParticipantIdentity: session?.ownerParticipantIdentity,
      ownerTrackSid: incoming.ownerTrackSid,
      speakerAttributionState: session?.speakerAttributionState,
    });
    const speakerPersistence = await persistSpeakerSegments({
      callSessionId: session?.callSessionId,
      currentSegments,
      revisions: speakerSegmentRevisions,
      expiresAtMs: session?.expiresAtMs,
      ownerParticipantIdentity: session?.ownerParticipantIdentity,
      ownerTrackSid: incoming.ownerTrackSid,
      speakerAttributionState: session?.speakerAttributionState,
    });
    if (speakerSegmentRevisions.length > 0) {
      await projectSpeakerSegmentRevisionsToMessages({
        callSessionId: session?.callSessionId,
        segments: speakerPersistence.effectiveSegments,
      });
    }
    const authority = voiceTurnAuthority(currentSegments, {
      speakerAttributionState: session?.speakerAttributionState,
    });
    logVoiceRouteStage(
      req,
      'voice_chat_session_ready',
      null,
      `agent_id=${session?.agentId || 'unknown'} convo_id=${session?.conversationId || 'new'}`,
    );

    /* === VIVENTIUM NOTE ===
     * Feature: Voice conversation continuity - parentMessageId tracking
     *
     * For existing conversations, fetch the latest message's ID to use as parentMessageId.
     * This ensures LibreChat's message tree model builds the full conversation chain,
     * enabling the agent to see previous messages and cortex insights.
     * === VIVENTIUM NOTE === */
    const requestedConversationId = session.conversationId || 'new';
    const parentLookupStartAt = voiceLatencyNow();
    const conversationState = await resolveReusableConversationState({
      conversationId: requestedConversationId,
      userId: req.user?.id,
      surface: 'voice',
      agentId: session.agentId,
    });
    const conversationId = conversationState.conversationId;
    let parentMessageId = conversationState.parentMessageId;
    const sourceEventId =
      (typeof incoming.sourceEventId === 'string' && incoming.sourceEventId) ||
      (typeof incoming.source_event_id === 'string' && incoming.source_event_id) ||
      req.viventiumVoiceRequestId ||
      req.get('X-VIVENTIUM-REQUEST-ID') ||
      crypto.randomUUID();
    setTrustedInteractionContext(
      req,
      createVoiceInteractionContext({
        conversation_id: conversationId,
        source_event_id: sourceEventId,
      }),
      {
        segment_stability: 'provisional',
        supersede_scope: 'response_only',
      },
      { commit_authority: 'external_adapter' },
    );
    const ownershipVerifiedReasons = new Set(['existing', 'message_lookup_error']);
    req.viventiumVoiceResolvedConversationId = conversationId;
    req.viventiumVoiceConvoAccessVerified =
      isConcreteConversationId(conversationId) &&
      requestedConversationId === conversationId &&
      ownershipVerifiedReasons.has(conversationState.reason);
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
    const {
      interactionContext: _untrustedInteractionContext,
      interaction_context: _untrustedInteractionContextSnake,
      viventiumInteractionContext: _untrustedViventiumInteractionContext,
      adapterCapabilities: _untrustedAdapterCapabilities,
      adapter_capabilities: _untrustedAdapterCapabilitiesSnake,
      ...safeIncoming
    } = incoming;
    req.body = {
      ...safeIncoming,
      text,
      endpoint: 'agents',
      endpointType: 'agents',
      voiceMode: true,
      conversationId,
      parentMessageId,
      agent_id: session.agentId,
      speakerSegments: currentSegments,
      speakerLabel:
        currentSegments.length > 0 ? legacySpeakerLabel(currentSegments) : incoming.speakerLabel,
      viventiumDeferVoiceMemory: true,
      viventiumActorTrust: authority.actorTrust,
      viventiumCanAuthorizeSideEffects: authority.canAuthorizeSideEffects,
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
  timedValidateConvoAccess,
  timedBuildEndpointOption,
  async (req, res, next) => {
    // If this call session began from a "new" conversation, capture the real conversationId
    // returned by ResumableAgentController and update the session store.
    const session = req.viventiumCallSession;

    const coalesceStartAt = voiceLatencyNow();
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
      speakerSegments: req.body?.speakerSegments,
    });
    logVoiceRouteStage(
      req,
      'voice_coalesce_done',
      coalesceStartAt,
      `should_launch=${coalescedTurn.shouldLaunch === true} coalesced=${Boolean(coalescedTurn.dedupeKey)} ` +
        `merged_text=${Boolean(coalescedTurn.mergedText && coalescedTurn.mergedText !== req.body?.text)} ` +
        `coalesce_window_ms=${coalescedTurn.coalesceWindowMs ?? 'unknown'}`,
    );

    if (!coalescedTurn.shouldLaunch && coalescedTurn.payload) {
      logger.info(
        `[VIVENTIUM][voice/chat] Coalesced onto existing stream parentMessageId=${req.body?.parentMessageId || 'none'} ` +
          `conversationId=${req.body?.conversationId || 'unknown'} streamId=${coalescedTurn.payload.streamId || 'unknown'}`,
      );
      const existingTask = getVoiceTaskByStreamId(coalescedTurn.payload.streamId);
      const existingJob = await GenerationJobManager.getJob(coalescedTurn.payload.streamId);
      return res.json(
        attachLogicalTurnMetadata(
          {
            ...coalescedTurn.payload,
            ...(existingTask ? { taskId: existingTask.taskId } : {}),
          },
          existingJob?.metadata?.interactionContext,
        ),
      );
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
    if (Array.isArray(coalescedTurn.mergedSpeakerSegments)) {
      req.body.speakerSegments = coalescedTurn.mergedSpeakerSegments;
      req.body.speakerLabel = legacySpeakerLabel(coalescedTurn.mergedSpeakerSegments);
      const mergedAuthority = voiceTurnAuthority(coalescedTurn.mergedSpeakerSegments, {
        speakerAttributionState: session?.speakerAttributionState,
      });
      req.body.viventiumActorTrust = mergedAuthority.actorTrust;
      req.body.viventiumCanAuthorizeSideEffects = mergedAuthority.canAuthorizeSideEffects;
    }

    logger.info(
      `[VIVENTIUM][voice/chat] user_turn_completed source=route callSessionId=${session?.callSessionId || 'unknown'} ` +
        `conversationId=${req.body?.conversationId || 'unknown'} parentMessageId=${req.body?.parentMessageId || 'none'} ` +
        `agentId=${session?.agentId || 'unknown'} requestId=${
          req.viventiumVoiceRequestId || req.get('X-VIVENTIUM-REQUEST-ID') || 'unknown'
        } coalesced=${Boolean(coalescedTurn.dedupeKey)} textChars=${req.body?.text?.length || 0}`,
    );

    const streamId =
      typeof req.body?.streamId === 'string' && req.body.streamId.trim()
        ? req.body.streamId.trim()
        : '';
    const voiceTask = createVoiceTask({
      callSessionId: session?.callSessionId,
      userId: req.user?.id,
      conversationId: req.body?.conversationId,
      turnId: req.body?.speakerSegments?.[0]?.turnId || streamId,
      streamId,
      owner: { kind: 'generation_job', ...(streamId ? { id: streamId } : {}) },
    });
    req.body.viventiumVoiceTaskId = voiceTask.taskId;

    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      try {
        if (typeof payload?.streamId === 'string' && payload.streamId) {
          bindVoiceTaskStream(voiceTask.taskId, payload.streamId);
        }
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
        if (req.viventiumVoiceLogLatency) {
          const elapsedMs = getVoiceLatencyTotalMs(req);
          const requestId = req.viventiumVoiceRequestId || 'unknown';
          const streamId = payload?.streamId || 'unknown';
          const readyFields = formatVoiceLatencyDurationFields(
            'voice_chat_ready',
            elapsedMs == null ? 0 : elapsedMs,
          );
          logger.info(
            `[VoiceLatency] ${readyFields} request_id=${requestId} stream_id=${streamId}`,
          );
        }
      } catch (e) {
        // noop
      }
      return originalJson(
        attachLogicalTurnMetadata(
          { ...payload, taskId: voiceTask.taskId },
          getTrustedInteractionContext(req),
        ),
      );
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

    logVoiceRouteStage(
      req,
      'agent_controller_enter',
      null,
      `stream_id=${req.body?.streamId || 'pending'}`,
    );
    return AgentController(req, res, next, initializeClient, addTitle);
  },
);

/* === VIVENTIUM START ===
 * Feature: VoiceTaskEventV1 control plane
 * Purpose: Authenticated get/list/cancel/input/retry endpoints. Interruption remains a separate
 * stream operation; cancelling installs suppression before touching the owner job.
 * === VIVENTIUM END === */
function taskOwnedBySession(task, req) {
  return Boolean(
    task &&
    task.callSessionId === req.viventiumCallSession?.callSessionId &&
    (!task.userId || task.userId === req.user?.id),
  );
}

router.get('/tasks', voiceSessionCapabilityAuth, async (req, res) => {
  const requestedCallSessionId =
    typeof req.query?.callSessionId === 'string' ? req.query.callSessionId : '';
  if (
    requestedCallSessionId &&
    requestedCallSessionId !== req.viventiumCallSession?.callSessionId
  ) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const rawBeforeCreatedAt =
    typeof req.query?.beforeCreatedAt === 'string' ? req.query.beforeCreatedAt.trim() : '';
  const rawBeforeTaskId =
    typeof req.query?.beforeTaskId === 'string' ? req.query.beforeTaskId.trim() : '';
  if (Boolean(rawBeforeCreatedAt) !== Boolean(rawBeforeTaskId)) {
    return res.status(400).json({ error: 'A complete task paging cursor is required' });
  }
  let page;
  try {
    page = await listDurableVoiceTaskSnapshots({
      userId: req.user?.id,
      callSessionId: req.viventiumCallSession?.callSessionId,
      beforeCreatedAt: rawBeforeCreatedAt || undefined,
      beforeTaskId: rawBeforeTaskId || undefined,
      requireDurable: true,
    });
  } catch {
    return res.status(503).json({
      code: 'gateway_down',
      message: 'Task history is temporarily unavailable.',
      retryable: true,
    });
  }
  return res.json({
    version: 1,
    events: page.events,
    taskOwnerCapabilityInventory: getVoiceTaskOwnerCapabilityInventory({
      userId: req.user?.id,
      callSessionId: req.viventiumCallSession?.callSessionId,
    }),
    hasMore: page.hasMore,
    ...(page.nextBeforeCreatedAt
      ? {
          nextBeforeCreatedAt: page.nextBeforeCreatedAt,
          nextBeforeTaskId: page.nextBeforeTaskId,
        }
      : {}),
  });
});

router.get('/tasks/events', voiceAuth, async (req, res) => {
  const callSessionId = req.viventiumCallSession?.callSessionId;
  const requestedCallSessionId =
    typeof req.query?.callSessionId === 'string' ? req.query.callSessionId.trim() : '';
  if (!callSessionId || requestedCallSessionId !== callSessionId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  let closed = false;
  let replaying = true;
  let synchronized = false;
  let tailFailure = null;
  let heartbeat = null;
  let durableTail = null;
  const bufferedLiveEvents = [];
  const deliveredSequences = new Map();
  const sendEvent = (event) => {
    if (closed || !event || res.writableEnded) {
      return;
    }
    const priorSequence = deliveredSequences.get(event.taskId) ?? -1;
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= priorSequence) return;
    deliveredSequences.set(event.taskId, event.sequence);
    res.write(`event: voice_task_event\ndata: ${JSON.stringify({ voiceTaskEvent: event })}\n\n`);
    res.flush?.();
  };
  let unsubscribe = () => {};
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    unsubscribe();
    durableTail?.stop();
  };
  // Subscribe before durable replay so a live child task cannot fall into the gap between the
  // snapshot query and listener registration. Sequence checks make an interleaved older snapshot
  // harmless at the gateway/UI boundary.
  unsubscribe = subscribeVoiceTasksForCall(
    callSessionId,
    (event) => {
      if (replaying) bufferedLiveEvents.push(event);
      else sendEvent(event);
    },
    { replaySnapshots: false },
  );
  durableTail = subscribeDurableVoiceTaskEventsForCall({
    callSessionId,
    userId: req.user?.id,
    onEvent: (event) => {
      if (replaying) bufferedLiveEvents.push(event);
      else sendEvent(event);
    },
    onError: (error) => {
      tailFailure = error;
      if (synchronized && !closed) {
        cleanup();
        if (!res.writableEnded) res.end();
      }
    },
  });
  req.on('close', cleanup);
  let beforeCreatedAt;
  let beforeTaskId;
  const seenCursors = new Set();
  let firstPage;
  try {
    [firstPage] = await Promise.all([
      listDurableVoiceTaskSnapshots({
        userId: req.user?.id,
        callSessionId,
        requireDurable: true,
      }),
      durableTail.ready,
    ]);
  } catch {
    cleanup();
    return res.status(503).json({
      code: 'gateway_down',
      message: 'Task history is temporarily unavailable.',
      retryable: true,
    });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  let page = firstPage;
  while (!closed) {
    for (const event of page.events) {
      sendEvent(event);
      durableTail.seed(event);
    }
    if (!page.hasMore || !page.nextBeforeCreatedAt || !page.nextBeforeTaskId) break;
    const cursor = `${page.nextBeforeCreatedAt}\0${page.nextBeforeTaskId}`;
    if (seenCursors.has(cursor)) {
      closed = true;
      unsubscribe();
      durableTail.stop();
      res.end();
      return undefined;
    }
    seenCursors.add(cursor);
    beforeCreatedAt = page.nextBeforeCreatedAt;
    beforeTaskId = page.nextBeforeTaskId;
    try {
      page = await listDurableVoiceTaskSnapshots({
        userId: req.user?.id,
        callSessionId,
        beforeCreatedAt,
        beforeTaskId,
        requireDurable: true,
      });
    } catch {
      closed = true;
      unsubscribe();
      durableTail.stop();
      res.end();
      return undefined;
    }
  }
  try {
    await durableTail.catchUp();
    if (tailFailure) throw tailFailure;
  } catch {
    cleanup();
    if (!res.writableEnded) res.end();
    return undefined;
  }
  for (const event of bufferedLiveEvents) sendEvent(event);
  replaying = false;
  if (!closed && !res.writableEnded) {
    const synchronization = {
      version: 1,
      callSessionId,
      state: 'synchronized',
      emittedAt: new Date().toISOString(),
    };
    res.write(`event: voice_task_sync\ndata: ${JSON.stringify(synchronization)}\n\n`);
    res.flush?.();
    synchronized = true;
  }
  heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) {
      res.write(': heartbeat\n\n');
      res.flush?.();
    }
  }, 15_000);
  heartbeat.unref?.();
  return undefined;
});

router.get('/tasks/:taskId', voiceSessionCapabilityAuth, async (req, res) => {
  const task = await hydrateVoiceTask(req.params.taskId, {
    userId: req.user?.id,
    callSessionId: req.viventiumCallSession?.callSessionId,
  });
  if (!taskOwnedBySession(task, req)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  return res.json({ version: 1, event: snapshotEvent(task.taskId) });
});

router.post('/tasks/:taskId/cancel', voiceSessionCapabilityAuth, async (req, res) => {
  const task = await hydrateVoiceTask(req.params.taskId, {
    userId: req.user?.id,
    callSessionId: req.viventiumCallSession?.callSessionId,
  });
  if (!taskOwnedBySession(task, req)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  let cancellation;
  try {
    cancellation = await requestVoiceTaskOwnerCancellation(task.taskId, {
      userId: req.user?.id,
    });
  } catch (error) {
    const current = getVoiceTask(task.taskId);
    return res.status(error?.status || 503).json({
      version: 1,
      code: error?.code || 'gateway_down',
      message: 'Cancellation could not be made durable. Please retry.',
      retryable: true,
      ...(error?.event ? { event: error.event } : {}),
      ...(current ? { task: current } : {}),
    });
  }
  if (cancellation?.alreadyCompleted) {
    return res.status(409).json({
      version: 1,
      outcome: 'already_completed',
      task: cancellation.task,
      event: cancellation.event,
    });
  }
  if (cancellation?.alreadyCancelled) {
    return res.json({
      version: 1,
      outcome: cancellation.task?.state,
      task: cancellation.task,
      event: cancellation.event,
    });
  }
  if (cancellation?.alreadyInactive) {
    return res.status(409).json({
      version: 1,
      outcome: 'not_active',
      task: cancellation.task,
      event: cancellation.event,
    });
  }
  if (cancellation?.alreadyCancelling) {
    return res.json({
      version: 1,
      outcome: 'cancelling',
      task: cancellation.task,
      event: cancellation.event,
    });
  }

  if (!cancellation?.ownerSupported) {
    void (async () => {
      const job = task.streamId ? await GenerationJobManager.getJob(task.streamId) : null;
      const abortResult = job ? await GenerationJobManager.abortJob(task.streamId) : null;
      const event = await settleVoiceTaskCancellation(task.taskId, {
        confirmed: abortResult?.success === true && canConfirmVoiceTaskCancellation(task.taskId),
        detail:
          abortResult?.success === true && canConfirmVoiceTaskCancellation(task.taskId)
            ? 'The generation owner confirmed cancellation.'
            : abortResult?.success === true
              ? 'Local generation stopped, but remote owner cancellation could not be confirmed; late output remains suppressed.'
              : 'The owner could not confirm cancellation; late output remains suppressed.',
      });
      logger.info('[VIVENTIUM][VoiceTask] cancellation_settled', {
        taskId: task.taskId,
        callSessionId: task.callSessionId,
        state: event?.state || 'unknown',
      });
    })().catch(() => {
      void settleVoiceTaskCancellation(task.taskId, {
        confirmed: false,
        detail: 'The owner could not confirm cancellation; late output remains suppressed.',
      }).catch(() => undefined);
    });
  }
  logger.info('[VIVENTIUM][VoiceTask] cancellation_requested', {
    taskId: task.taskId,
    callSessionId: task.callSessionId,
    state: 'cancelling',
  });
  return res.json({
    version: 1,
    outcome: 'cancelling',
    operationId: cancellation.operationId,
    task: cancellation.task,
    event: cancellation.event,
  });
});

router.post('/tasks/:taskId/input', voiceSessionCapabilityAuth, async (req, res) => {
  const task = await hydrateVoiceTask(req.params.taskId, {
    userId: req.user?.id,
    callSessionId: req.viventiumCallSession?.callSessionId,
  });
  if (!taskOwnedBySession(task, req)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (typeof req.body?.input !== 'string' || !req.body.input.trim()) {
    return res.status(400).json({ error: 'input is required' });
  }
  const result = await submitVoiceTaskInput(task.taskId, req.body.input, {
    userId: req.user?.id,
  });
  if (!result.ok) {
    const status = result.code === 'owner_input_failed' ? 503 : 409;
    return res.status(status).json({
      version: 1,
      error: result.code,
      message: result.message,
      ...(result.event ? { event: result.event } : {}),
      ...(result.task ? { task: result.task } : {}),
    });
  }
  return res.json({
    version: 1,
    outcome: 'accepted',
    task: result.task,
    event: result.event,
  });
});

router.post('/tasks/:taskId/retry', voiceSessionCapabilityAuth, async (req, res) => {
  const task = await hydrateVoiceTask(req.params.taskId, {
    userId: req.user?.id,
    callSessionId: req.viventiumCallSession?.callSessionId,
  });
  if (!taskOwnedBySession(task, req)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const result = await retryVoiceTask(task.taskId, { userId: req.user?.id });
  if (!result.ok) {
    const status = result.code === 'owner_retry_failed' ? 503 : 409;
    return res.status(status).json({
      version: 1,
      error: result.code,
      message: result.message,
      ...(result.event ? { event: result.event } : {}),
      ...(result.task ? { task: result.task } : {}),
    });
  }
  return res.json({
    version: 1,
    outcome: 'accepted',
    task: result.task,
    previousTask: result.previousTask,
    previousEvent: result.previousEvent,
    event: result.event,
    events: result.events,
  });
});

/**
 * SSE subscription endpoint for the voice gateway.
 * Mirrors `/api/agents/chat/stream/:streamId` but is authenticated via call session secret.
 */
router.get('/stream/:streamId', voiceAuth, async (req, res) => {
  const { streamId } = req.params;
  const isResume = req.query.resume === 'true';
  const userId = req.user?.id;
  const callSessionId = req.viventiumCallSession?.callSessionId || 'unknown';
  const logLatency = parseBoolEnv('VIVENTIUM_VOICE_LOG_LATENCY', false);

  const job = await GenerationJobManager.getJob(streamId);
  if (!job) {
    logger.warn(
      `[VIVENTIUM][VoiceStream] stream_not_found streamId=${streamId} ` +
        `callSessionId=${callSessionId} resume=${isResume} userId=${userId || 'unknown'}`,
    );
    if (logLatency) {
      logger.info(
        `[VoiceLatency][LC][Stream] stage=stream_not_found stream_id=${streamId} ` +
          `call_session_id=${callSessionId} resume=${isResume}`,
      );
    }
    return res.status(404).json({
      error: 'Stream not found',
      message: 'The generation job does not exist or has expired.',
    });
  }

  if (!userId || job.metadata?.userId !== userId) {
    return res.status(404).json({
      error: 'Stream not found',
      message: 'The generation job does not exist or has expired.',
    });
  }
  if (
    job.metadata?.viventiumCallSessionId &&
    job.metadata.viventiumCallSessionId !== callSessionId
  ) {
    return res.status(404).json({
      error: 'Stream not found',
      message: 'The generation job does not exist or has expired.',
    });
  }

  // A process restart (or cancellation accepted by another API worker) leaves the in-memory
  // registry empty/stale. Reconcile the exact stream with the durable task and suppression ledgers
  // before replaying resume state or subscribing to any model output.
  let voiceTask;
  try {
    voiceTask = await hydrateVoiceTaskByStreamId(streamId, {
      callSessionId,
      userId,
      requireDurable: true,
    });
  } catch (error) {
    logger.error('[VIVENTIUM][VoiceStream] durable_task_reconcile_failed', {
      streamId,
      callSessionId,
      code: error?.code || 'gateway_down',
    });
    return res.status(503).json({
      code: 'gateway_down',
      message: 'Voice task recovery is temporarily unavailable.',
      retryable: true,
    });
  }
  if (!voiceTask) {
    return res.status(503).json({
      code: 'gateway_down',
      message: 'Voice task recovery is temporarily unavailable.',
      retryable: true,
    });
  }
  const suppressionScope = { callSessionId, userId, streamId };
  const outputIsSuppressed = () => isVoiceTaskSuppressedDurably(voiceTask.taskId, suppressionScope);
  const withStreamLogicalTurn = (event) =>
    attachLogicalTurnMetadata(event, job.metadata?.interactionContext);

  res.setHeader('Content-Encoding', 'identity');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const unsubscribeVoiceTask = voiceTask
    ? subscribeVoiceTask(voiceTask.taskId, (voiceTaskEvent) => {
        if (!res.writableEnded && voiceTaskEvent) {
          res.write(
            `event: voice_task_event\ndata: ${JSON.stringify(withStreamLogicalTurn({ voiceTaskEvent }))}\n\n`,
          );
          res.flush?.();
        }
      })
    : () => {};

  logger.debug?.(`[VIVENTIUM][VoiceStream] subscribed ${streamId}, resume=${isResume}`);
  if (logLatency) {
    logger.info(
      `[VoiceLatency][LC][Stream] stage=stream_subscribe_start stream_id=${streamId} ` +
        `call_session_id=${callSessionId} resume=${isResume}`,
    );
  }

  if (isResume) {
    const resumeState = await GenerationJobManager.getResumeState(streamId);
    if (resumeState && !res.writableEnded && !(await outputIsSuppressed())) {
      res.write(
        `event: message\ndata: ${JSON.stringify(withStreamLogicalTurn({ sync: true, resumeState }))}\n\n`,
      );
      if (typeof res.flush === 'function') {
        res.flush();
      }
    }
  }

  let outputTail = Promise.resolve();
  const enqueueOutput = (operation) => {
    outputTail = outputTail
      .catch(() => undefined)
      .then(operation)
      .catch((error) => {
        logger.error('[VIVENTIUM][VoiceStream] durable_output_guard_failed', {
          streamId,
          callSessionId,
          code: error?.code || 'unknown',
        });
        if (!res.writableEnded) res.end();
      });
  };

  const result = await GenerationJobManager.subscribe(
    streamId,
    (event) => {
      enqueueOutput(async () => {
        const suppressed = await outputIsSuppressed();
        if (!suppressed) {
          observeGenerationEvent(voiceTask.taskId, event);
        }
        if (!res.writableEnded && !suppressed) {
          res.write(`event: message\ndata: ${JSON.stringify(withStreamLogicalTurn(event))}\n\n`);
          if (typeof res.flush === 'function') {
            res.flush();
          }
        }
      });
    },
    (event) => {
      enqueueOutput(async () => {
        const suppressed = await outputIsSuppressed();
        if (voiceTask && !suppressed) {
          completeVoiceTask(voiceTask.taskId, {
            resultMessageId: event?.responseMessage?.messageId,
          });
        }
        if (!res.writableEnded) {
          if (!suppressed) {
            res.write(`event: message\ndata: ${JSON.stringify(withStreamLogicalTurn(event))}\n\n`);
          }
          if (typeof res.flush === 'function') {
            res.flush();
          }
          res.end();
        }
      });
    },
    (error) => {
      enqueueOutput(async () => {
        const suppressed = await outputIsSuppressed();
        if (voiceTask && !suppressed) {
          failVoiceTask(voiceTask.taskId, error);
        }
        if (!res.writableEnded) {
          if (!suppressed) {
            res.write(
              `event: error\ndata: ${JSON.stringify(withStreamLogicalTurn({ error }))}\n\n`,
            );
          }
          if (typeof res.flush === 'function') {
            res.flush();
          }
          res.end();
        }
      });
    },
  );

  if (!result) {
    logger.warn(
      `[VIVENTIUM][VoiceStream] subscribe_failed streamId=${streamId} ` +
        `callSessionId=${callSessionId} resume=${isResume}`,
    );
    if (logLatency) {
      logger.info(
        `[VoiceLatency][LC][Stream] stage=stream_subscribe_failed stream_id=${streamId} ` +
          `call_session_id=${callSessionId} resume=${isResume}`,
      );
    }
    if (!res.headersSent) {
      return res.status(404).json({ error: 'Failed to subscribe to stream' });
    }
    if (!res.writableEnded) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ error: 'Failed to subscribe to stream' })}\n\n`,
      );
      res.end();
    }
    return;
  }

  req.on('close', () => {
    result.unsubscribe();
    unsubscribeVoiceTask();
  });
});

/* === VIVENTIUM START ===
 * Feature: Voice interruption/cancellation separation
 * Purpose: Barge-in stops gateway TTS only. It must not abort the authoritative task; explicit
 * task cancellation uses /tasks/:taskId/cancel and installs the suppression barrier first.
 * === VIVENTIUM END === */
router.post('/stream/:streamId/abort', voiceAuth, async (req, res) => {
  const { streamId } = req.params;
  const userId = req.user?.id;
  const callSessionId = req.viventiumCallSession?.callSessionId || 'unknown';

  if (typeof streamId !== 'string' || streamId.length === 0) {
    return res.status(400).json({ error: 'streamId is required' });
  }

  const job = await GenerationJobManager.getJob(streamId);
  if (!job) {
    logger.warn(
      `[VIVENTIUM][VoiceStream] abort_stream_not_found streamId=${streamId} ` +
        `callSessionId=${callSessionId}`,
    );
    return res.status(404).json({ error: 'Stream not found', streamId });
  }

  if (!userId || job.metadata?.userId !== userId) {
    logger.warn(
      `[VIVENTIUM][VoiceStream] abort_unauthorized streamId=${streamId} ` +
        `callSessionId=${callSessionId}`,
    );
    return res.status(404).json({ error: 'Stream not found', streamId });
  }

  if (
    job.metadata?.viventiumCallSessionId &&
    job.metadata.viventiumCallSessionId !== callSessionId
  ) {
    logger.warn(
      `[VIVENTIUM][VoiceStream] abort_call_session_mismatch streamId=${streamId} ` +
        `callSessionId=${callSessionId}`,
    );
    return res.status(404).json({ error: 'Stream not found', streamId });
  }

  let task;
  try {
    task = await hydrateVoiceTaskByStreamId(streamId, {
      callSessionId,
      userId,
      requireDurable: true,
    });
  } catch (_error) {
    return res.status(503).json({
      code: 'gateway_down',
      message: 'Voice task recovery is temporarily unavailable.',
      retryable: true,
    });
  }
  if (!task) {
    return res.status(404).json({ error: 'Stream not found', streamId });
  }

  logger.info(
    `[VIVENTIUM][VoiceStream] interrupted_speech streamId=${streamId} ` +
      `callSessionId=${callSessionId}`,
  );
  return res.json({
    success: true,
    interrupted: streamId,
    ...(task ? { taskId: task.taskId } : {}),
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
      followUpDecision: result.followUpDecision ?? null,
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
