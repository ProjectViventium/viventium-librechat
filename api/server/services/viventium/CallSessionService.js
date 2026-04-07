/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

/* === VIVENTIUM NOTE ===
 * Feature: LibreChat Voice Calls - Call Session Service
 *
 * Purpose:
 * - Create short-lived call sessions that bind a LiveKit room to a LibreChat (userId, agentId, conversationId)
 * - Provide secure server-to-server auth for the Voice Gateway (no user JWT in the gateway)
 *
 * Design:
 * - Mongo-backed TTL storage to survive process restarts and multi-instance deployments.
 * - Same route contracts as the previous in-memory store.
 *
 * Added: 2026-01-08
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { ViventiumCallSession } = require('~/db/models');
const { getUserById, updateUserViventiumVoicePreferences } = require('~/models');
const { resolveVoiceOverrideAssignment } = require('./voiceLlmOverride');
const { rewriteAgentForRuntime } = require('../../../../scripts/viventium-agent-runtime-models');

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_LEASE_MS = 60 * 1000; // 60 seconds
const DEFAULT_DISPATCH_CLAIM_MS = 15 * 1000; // 15 seconds
/* === VIVENTIUM START ===
 * Feature: Modern playground voice-route persistence
 * Purpose: Normalize provider/variant selections before storing them in the call session or user.
 * === VIVENTIUM END === */
const MAX_PROVIDER_LENGTH = 80;
const MAX_VARIANT_LENGTH = 160;

function createRoomName(callSessionId) {
  // LiveKit room name practical max ~64; keep it short & deterministic.
  const short = String(callSessionId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  return `lc-${short || 'call'}`;
}

function createEmptyVoiceRouteSelection() {
  return {
    provider: null,
    variant: null,
  };
}

function normalizeVoiceRouteText(value, maxLength) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, maxLength);
}

function normalizeVoiceRouteSelection(selection) {
  if (!selection || typeof selection !== 'object') {
    return createEmptyVoiceRouteSelection();
  }

  return {
    provider: normalizeVoiceRouteText(selection.provider, MAX_PROVIDER_LENGTH),
    variant: normalizeVoiceRouteText(selection.variant, MAX_VARIANT_LENGTH),
  };
}

function hasVoiceRouteSelection(selection) {
  return Boolean(selection?.provider || selection?.variant);
}

function normalizeVoiceRouteState(route) {
  const normalized = {
    stt: normalizeVoiceRouteSelection(route?.stt),
    tts: normalizeVoiceRouteSelection(route?.tts),
  };

  return normalized;
}

function compactVoiceRouteState(route) {
  const normalized = normalizeVoiceRouteState(route);
  const normalizedStt = hasVoiceRouteSelection(normalized.stt) ? normalized.stt : null;
  const normalizedTts = hasVoiceRouteSelection(normalized.tts) ? normalized.tts : null;

  if (!normalizedStt && !normalizedTts) {
    return null;
  }

  return {
    stt: normalizedStt,
    tts: normalizedTts,
  };
}

async function getUserSavedVoiceRoute(userId) {
  if (!userId) {
    return normalizeVoiceRouteState(null);
  }

  const user = await getUserById(String(userId), 'viventiumVoicePreferences');
  return normalizeVoiceRouteState(user?.viventiumVoicePreferences?.livekitPlayground);
}

/* === VIVENTIUM START ===
 * Feature: Cross-surface user voice route resolution
 * Purpose: Let Telegram and other non-call surfaces reuse the same saved LiveKit
 * voice preference as their source of truth, with canonical env defaults only as fallback.
 * === VIVENTIUM END === */
function getDefaultLocalWhisperModel() {
  return process.arch === 'x64' ? 'tiny.en' : 'large-v3-turbo';
}

function normalizeSavedProviderAlias(provider, modality) {
  const value = normalizeVoiceRouteText(provider, MAX_PROVIDER_LENGTH);
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase();
  if (modality === 'stt') {
    if (normalized === 'whisper_local' || normalized === 'local') {
      return 'pywhispercpp';
    }
    return normalized;
  }

  if (normalized === 'grok' || normalized === 'xai_grok_voice' || normalized === 'x_ai') {
    return 'xai';
  }
  if (['browser', 'automatic', 'auto', 'local_automatic'].includes(normalized)) {
    return 'openai';
  }
  return normalized;
}

function getDefaultVoiceRouteSelection(modality) {
  if (modality === 'stt') {
    const provider = normalizeSavedProviderAlias(
      process.env.VIVENTIUM_STT_PROVIDER || process.env.STT_PROVIDER || '',
      'stt',
    );
    if (!provider) {
      return createEmptyVoiceRouteSelection();
    }
    if (provider === 'pywhispercpp') {
      return {
        provider,
        variant: normalizeVoiceRouteText(
          process.env.VIVENTIUM_STT_MODEL ||
            process.env.LOCAL_WHISPER_MODEL_NAME ||
            getDefaultLocalWhisperModel(),
          MAX_VARIANT_LENGTH,
        ),
      };
    }
    if (provider === 'assemblyai') {
      return {
        provider,
        variant: normalizeVoiceRouteText('universal-streaming', MAX_VARIANT_LENGTH),
      };
    }
    if (provider === 'openai') {
      return {
        provider,
        variant: normalizeVoiceRouteText(
          process.env.VIVENTIUM_OPENAI_STT_MODEL || 'gpt-4o-mini-transcribe',
          MAX_VARIANT_LENGTH,
        ),
      };
    }
    return {
      provider,
      variant: null,
    };
  }

  const provider = normalizeSavedProviderAlias(
    process.env.VIVENTIUM_TTS_PROVIDER ||
      process.env.TTS_PROVIDER_PRIMARY ||
      process.env.TTS_PROVIDER ||
      'openai',
    'tts',
  );
  if (!provider) {
    return createEmptyVoiceRouteSelection();
  }
  if (provider === 'cartesia') {
    return {
      provider,
      variant: normalizeVoiceRouteText(
        process.env.VIVENTIUM_CARTESIA_MODEL_ID || 'sonic-3',
        MAX_VARIANT_LENGTH,
      ),
    };
  }
  if (provider === 'elevenlabs') {
    return {
      provider,
      variant: normalizeVoiceRouteText(
        process.env.VIVENTIUM_FC_CONSCIOUS_VOICE_ID || 'CrmDm7REHG6iBx8uySLf',
        MAX_VARIANT_LENGTH,
      ),
    };
  }
  if (provider === 'local_chatterbox_turbo_mlx_8bit' || provider.includes('chatterbox')) {
    return {
      provider: 'local_chatterbox_turbo_mlx_8bit',
      variant: normalizeVoiceRouteText(
        process.env.VIVENTIUM_MLX_AUDIO_MODEL_ID || 'mlx-community/chatterbox-turbo-8bit',
        MAX_VARIANT_LENGTH,
      ),
    };
  }
  if (provider === 'xai') {
    return {
      provider,
      variant: normalizeVoiceRouteText(process.env.VIVENTIUM_XAI_VOICE || 'Sal', MAX_VARIANT_LENGTH),
    };
  }
  return {
    provider: 'openai',
    variant: normalizeVoiceRouteText(
      process.env.VIVENTIUM_OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
      MAX_VARIANT_LENGTH,
    ),
  };
}

function resolveVoiceRouteSelection(savedSelection, fallbackSelection, modality) {
  const normalizedSaved = normalizeVoiceRouteSelection(savedSelection);
  const normalizedFallback = normalizeVoiceRouteSelection(fallbackSelection);
  const provider = normalizeSavedProviderAlias(normalizedSaved.provider, modality);
  if (provider || normalizedSaved.variant) {
    return {
      provider,
      variant: normalizedSaved.variant,
    };
  }
  return {
    provider: normalizeSavedProviderAlias(normalizedFallback.provider, modality),
    variant: normalizedFallback.variant,
  };
}

async function resolveUserVoiceRoute(userId) {
  const savedVoiceRoute = await getUserSavedVoiceRoute(userId);
  return normalizeVoiceRouteState({
    stt: resolveVoiceRouteSelection(
      savedVoiceRoute?.stt,
      getDefaultVoiceRouteSelection('stt'),
      'stt',
    ),
    tts: resolveVoiceRouteSelection(
      savedVoiceRoute?.tts,
      getDefaultVoiceRouteSelection('tts'),
      'tts',
    ),
  });
}

function normalizeSession(session) {
  if (!session) {
    return null;
  }
  const createdAt = session.createdAt ? new Date(session.createdAt).getTime() : undefined;
  const expiresAt = session.expiresAt ? new Date(session.expiresAt).getTime() : undefined;
  const leaseExpiresAt = session.leaseExpiresAt ? new Date(session.leaseExpiresAt).getTime() : undefined;
  const dispatchClaimedAt = session.dispatchClaimedAt
    ? new Date(session.dispatchClaimedAt).getTime()
    : undefined;
  const dispatchConfirmedAt = session.dispatchConfirmedAt
    ? new Date(session.dispatchConfirmedAt).getTime()
    : undefined;
  const dispatchLastErrorAt = session.dispatchLastErrorAt
    ? new Date(session.dispatchLastErrorAt).getTime()
    : undefined;
  const normalizedWingModeEnabled =
    typeof session.wingModeEnabled === 'boolean'
      ? session.wingModeEnabled
      : typeof session.shadowModeEnabled === 'boolean'
        ? session.shadowModeEnabled
        : false;
  return {
    callSessionId: session.callSessionId,
    userId: session.userId,
    agentId: session.agentId,
    conversationId: session.conversationId,
    roomName: session.roomName,
    createdAtMs: createdAt,
    expiresAtMs: expiresAt,
    requestedVoiceRoute: normalizeVoiceRouteState(session.requestedVoiceRoute),
    wingModeEnabled: normalizedWingModeEnabled,
    shadowModeEnabled: normalizedWingModeEnabled,
    activeJobId: session.activeJobId || null,
    activeWorkerId: session.activeWorkerId || null,
    leaseExpiresAtMs: leaseExpiresAt,
    dispatchClaimId: session.dispatchClaimId || null,
    dispatchClaimedAtMs: dispatchClaimedAt,
    dispatchConfirmedAtMs: dispatchConfirmedAt,
    dispatchRoomName: session.dispatchRoomName || null,
    dispatchAgentName: session.dispatchAgentName || null,
    dispatchLastError: session.dispatchLastError || null,
    dispatchLastErrorAtMs: dispatchLastErrorAt,
  };
}

function getCallSessionTtlMs() {
  const raw = (process.env.VIVENTIUM_CALL_SESSION_TTL_MS || '').trim();
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_TTL_MS;
}

function getCallSessionLeaseMs() {
  const raw = (process.env.VIVENTIUM_CALL_SESSION_LEASE_MS || '').trim();
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_LEASE_MS;
}

function getDispatchClaimTtlMs() {
  const raw = (process.env.VIVENTIUM_CALL_SESSION_DISPATCH_CLAIM_MS || '').trim();
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_DISPATCH_CLAIM_MS;
}

function parseBooleanEnv(...values) {
  for (const value of values) {
    const normalized = String(value ?? '')
      .trim()
      .toLowerCase();
    if (!normalized) {
      continue;
    }
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return false;
}

function getDefaultWingModeEnabled() {
  return parseBooleanEnv(
    process.env.VIVENTIUM_WING_MODE_DEFAULT_ENABLED,
    process.env.VIVENTIUM_SHADOW_MODE_DEFAULT_ENABLED,
  );
}

function normalizeAssistantRouteText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function buildAssistantRouteAssignment(provider, model) {
  const normalizedProvider = normalizeAssistantRouteText(provider);
  const normalizedModel = normalizeAssistantRouteText(model);
  if (!normalizedProvider || !normalizedModel) {
    return null;
  }
  return {
    provider: normalizedProvider,
    model: normalizedModel,
  };
}

/* === VIVENTIUM START ===
 * Feature: Modern playground Assistant-route disclosure
 * Purpose: Resolve the effective call-session LLM from the actual owning agent so Wing Mode shows
 * the real agent primary route or explicit Voice Call LLM instead of a hidden machine default.
 * === VIVENTIUM END === */
async function resolveCallSessionAssistantRoute(agentId) {
  if (!agentId) {
    return null;
  }

  const Agent = mongoose.models.Agent;
  if (!Agent) {
    return null;
  }

  const persistedAgent = await Agent.findOne({ id: String(agentId) }).lean();
  if (!persistedAgent) {
    return null;
  }

  const runtimeAgent = rewriteAgentForRuntime(persistedAgent);
  const primary = buildAssistantRouteAssignment(
    runtimeAgent?.provider,
    runtimeAgent?.model || runtimeAgent?.model_parameters?.model,
  );
  if (!primary) {
    return null;
  }

  const voiceAssignment = resolveVoiceOverrideAssignment(runtimeAgent);
  const voiceCallLlm = buildAssistantRouteAssignment(
    voiceAssignment?.provider,
    voiceAssignment?.model,
  );

  return {
    primary,
    voiceCallLlm,
    effective: voiceCallLlm || primary,
    inheritsPrimary: !voiceCallLlm,
  };
}

async function createCallSession({
  userId,
  agentId,
  conversationId,
  ttlMs,
  requestedVoiceRoute,
}) {
  if (!userId) {
    throw new Error('createCallSession requires userId');
  }
  if (!agentId) {
    throw new Error('createCallSession requires agentId');
  }

  const callSessionId = crypto.randomUUID();
  const createdAtMs = Date.now();
  const ttl = Number(ttlMs) || getCallSessionTtlMs();
  const expiresAtMs = createdAtMs + ttl;
  const roomName = createRoomName(callSessionId);
  /* === VIVENTIUM START ===
   * Feature: Modern playground voice-route persistence
   * Purpose: Seed new call sessions from the explicit request first, then fall back to saved defaults.
   * === VIVENTIUM END === */
  const normalizedRequestedVoiceRoute =
    compactVoiceRouteState(requestedVoiceRoute) ||
    compactVoiceRouteState((await getUserSavedVoiceRoute(userId)) ?? null);

  const session = {
    callSessionId,
    userId,
    agentId,
    // conversationId may be "new" initially; it will be updated after first agent run starts.
    conversationId: conversationId || 'new',
    roomName,
    createdAt: new Date(createdAtMs),
    expiresAt: new Date(expiresAtMs),
    wingModeEnabled: getDefaultWingModeEnabled(),
    shadowModeEnabled: getDefaultWingModeEnabled(),
    requestedVoiceRoute: normalizedRequestedVoiceRoute,
  };

  const saved = await ViventiumCallSession.create(session);

  logger.debug?.('[VIVENTIUM][CallSession] created', {
    callSessionId,
    userId,
    agentId,
    conversationId: session.conversationId,
    roomName,
  });

  return normalizeSession(saved);
}

async function getCallSession(callSessionId) {
  if (!callSessionId) {
    return null;
  }
  const now = new Date();
  const session = await ViventiumCallSession.findOne({
    callSessionId: String(callSessionId),
    expiresAt: { $gt: now },
  }).lean();
  return normalizeSession(session);
}

async function syncCallSessionState({
  callSessionId,
  touch = true,
  wingModeEnabled,
  shadowModeEnabled,
}) {
  if (!callSessionId) {
    throw new Error('syncCallSessionState requires callSessionId');
  }

  const now = new Date();
  const set = {};
  if (touch !== false) {
    set.expiresAt = new Date(now.getTime() + getCallSessionTtlMs());
  }

  const normalizedWingMode =
    typeof wingModeEnabled === 'boolean'
      ? wingModeEnabled
      : typeof shadowModeEnabled === 'boolean'
        ? shadowModeEnabled
        : null;
  if (typeof normalizedWingMode === 'boolean') {
    set.wingModeEnabled = normalizedWingMode;
    set.shadowModeEnabled = normalizedWingMode;
  }

  const session = await ViventiumCallSession.findOneAndUpdate(
    {
      callSessionId: String(callSessionId),
      expiresAt: { $gt: now },
    },
    { $set: set },
    { new: true },
  ).lean();

  return normalizeSession(session);
}

async function getCallSessionVoiceSettings(callSessionId) {
  const session = await getCallSession(callSessionId);
  if (!session) {
    return null;
  }

  const assistantRoute = await resolveCallSessionAssistantRoute(session.agentId);

  return {
    callSessionId: session.callSessionId,
    roomName: session.roomName,
    expiresAtMs: session.expiresAtMs || null,
    requestedVoiceRoute: normalizeVoiceRouteState(session.requestedVoiceRoute),
    savedVoiceRoute: await getUserSavedVoiceRoute(session.userId),
    assistantRoute,
  };
}

/* === VIVENTIUM START ===
 * Feature: Modern playground voice-route persistence
 * Purpose:
 * - Persist the requested pre-call route into the call session.
 * - Optionally mirror the same route into per-user saved defaults for future calls.
 * === VIVENTIUM END === */
async function updateCallSessionVoiceSettings({
  callSessionId,
  requestedVoiceRoute,
  touch = true,
  persistToUserDefaults = true,
}) {
  if (!callSessionId) {
    throw new Error('updateCallSessionVoiceSettings requires callSessionId');
  }

  const now = new Date();
  const set = {};
  if (touch !== false) {
    set.expiresAt = new Date(now.getTime() + getCallSessionTtlMs());
  }
  if (Object.prototype.hasOwnProperty.call(arguments[0] ?? {}, 'requestedVoiceRoute')) {
    set.requestedVoiceRoute = compactVoiceRouteState(requestedVoiceRoute);
  }

  const session = await ViventiumCallSession.findOneAndUpdate(
    {
      callSessionId: String(callSessionId),
      expiresAt: { $gt: now },
    },
    { $set: set },
    { new: true },
  ).lean();

  const normalizedSession = normalizeSession(session);
  if (!normalizedSession) {
    return null;
  }

  let savedVoiceRoute = await getUserSavedVoiceRoute(normalizedSession.userId);
  if (
    persistToUserDefaults !== false &&
    normalizedSession.userId &&
    Object.prototype.hasOwnProperty.call(arguments[0] ?? {}, 'requestedVoiceRoute')
  ) {
    const updatedUser = await updateUserViventiumVoicePreferences(normalizedSession.userId, {
      livekitPlayground: compactVoiceRouteState(requestedVoiceRoute),
    });
    savedVoiceRoute = normalizeVoiceRouteState(updatedUser?.viventiumVoicePreferences?.livekitPlayground);
  }

  const assistantRoute = await resolveCallSessionAssistantRoute(normalizedSession.agentId);

  return {
    callSessionId: normalizedSession.callSessionId,
    roomName: normalizedSession.roomName,
    expiresAtMs: normalizedSession.expiresAtMs || null,
    requestedVoiceRoute: normalizeVoiceRouteState(normalizedSession.requestedVoiceRoute),
    savedVoiceRoute,
    assistantRoute,
  };
}

async function claimVoiceSession({
  callSessionId,
  jobId,
  workerId,
  leaseDurationMs,
}) {
  if (!callSessionId) {
    throw new Error('claimVoiceSession requires callSessionId');
  }
  if (!jobId) {
    throw new Error('claimVoiceSession requires jobId');
  }

  const now = new Date();
  const leaseMs = Number(leaseDurationMs) || getCallSessionLeaseMs();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  const session = await ViventiumCallSession.findOneAndUpdate(
    {
      callSessionId: String(callSessionId),
      expiresAt: { $gt: now },
      $or: [
        { activeJobId: String(jobId) },
        { activeJobId: null },
        { leaseExpiresAt: { $lt: now } },
      ],
    },
    {
      $set: {
        activeJobId: String(jobId),
        activeWorkerId: workerId ? String(workerId) : null,
        leaseExpiresAt,
      },
    },
    { new: true },
  ).lean();

  return normalizeSession(session);
}

async function updateCallSessionConversationId(callSessionId, conversationId) {
  /* VIVENTIUM NOTE
   * Purpose: Trace call-session conversationId updates for debugging.
   * Details: docs/requirements_and_learnings/05_Open_Source_Modifications.md#librechat-call-session-debug
   */
  logger.info(
    `[CallSessionService] DEBUG UPDATE: callSessionId=${callSessionId}, newConversationId=${conversationId}`,
  );
  /* VIVENTIUM NOTE */

  if (!callSessionId || !conversationId || conversationId === 'new') {
    logger.info('[CallSessionService] DEBUG UPDATE: Skipping update (invalid params)');
    return null;
  }

  const now = new Date();
  const session = await ViventiumCallSession.findOneAndUpdate(
    {
      callSessionId: String(callSessionId),
      expiresAt: { $gt: now },
    },
    { $set: { conversationId } },
    { new: true },
  ).lean();

  if (!session) {
    logger.info('[CallSessionService] DEBUG UPDATE: Session not found');
    return null;
  }

  logger.info(`[CallSessionService] DEBUG UPDATE: Updated session conversationId to ${conversationId}`);
  return normalizeSession(session);
}

function getRequiredEnvSecret() {
  return process.env.VIVENTIUM_CALL_SESSION_SECRET || '';
}

async function assertCallSessionSecret(callSessionId, secret) {
  const expected = getRequiredEnvSecret();
  if (!expected) {
    throw new Error('VIVENTIUM_CALL_SESSION_SECRET is not set');
  }
  if (!secret || secret !== expected) {
    const err = new Error('Unauthorized voice gateway');
    err.status = 401;
    throw err;
  }

  const session = await getCallSession(callSessionId);
  if (!session) {
    const err = new Error('Unknown or expired call session');
    err.status = 401;
    throw err;
  }

  return session;
}

async function assertVoiceGatewayAuth(req) {
  const callSessionId =
    req.get('X-VIVENTIUM-CALL-SESSION') || req.get('x-viventium-call-session') || '';
  const secret = req.get('X-VIVENTIUM-CALL-SECRET') || req.get('x-viventium-call-secret') || '';
  const jobId = req.get('X-VIVENTIUM-JOB-ID') || req.get('x-viventium-job-id') || '';
  const workerId = req.get('X-VIVENTIUM-WORKER-ID') || req.get('x-viventium-worker-id') || '';

  const session = await assertCallSessionSecret(callSessionId, secret);
  if (!jobId) {
    const err = new Error('Missing voice job id');
    err.status = 401;
    throw err;
  }

  const claimed = await claimVoiceSession({
    callSessionId: session.callSessionId,
    jobId,
    workerId,
  });

  if (!claimed) {
    const now = Date.now();
    if (session.activeJobId && session.activeJobId !== jobId) {
      const leaseExpiresAtMs = session.leaseExpiresAtMs || 0;
      if (leaseExpiresAtMs > now) {
        const err = new Error('Another worker owns this session');
        err.status = 403;
        throw err;
      }
    }
    const err = new Error('Unable to claim voice session');
    err.status = 403;
    throw err;
  }

  return claimed;
}

async function claimDispatch({ callSessionId, roomName, agentName }) {
  if (!callSessionId) {
    throw new Error('claimDispatch requires callSessionId');
  }
  if (!roomName) {
    throw new Error('claimDispatch requires roomName');
  }
  if (!agentName) {
    throw new Error('claimDispatch requires agentName');
  }

  const now = new Date();
  const session = await ViventiumCallSession.findOne({
    callSessionId: String(callSessionId),
    expiresAt: { $gt: now },
  }).lean();
  if (!session) {
    return { status: 'expired', session: null };
  }

  if (session.roomName && session.roomName !== roomName) {
    const err = new Error('Room name mismatch for call session');
    err.status = 409;
    throw err;
  }
  if (session.dispatchAgentName && session.dispatchAgentName !== agentName) {
    const err = new Error('Agent name mismatch for call session dispatch');
    err.status = 409;
    throw err;
  }
  if (session.dispatchConfirmedAt) {
    return { status: 'already', session: normalizeSession(session) };
  }

  const claimId = crypto.randomUUID();
  const claimCutoff = new Date(now.getTime() - getDispatchClaimTtlMs());

  const claimed = await ViventiumCallSession.findOneAndUpdate(
    {
      callSessionId: String(callSessionId),
      expiresAt: { $gt: now },
      $and: [
        { $or: [{ dispatchConfirmedAt: { $exists: false } }, { dispatchConfirmedAt: null }] },
        {
          $or: [
            { dispatchClaimedAt: { $exists: false } },
            { dispatchClaimedAt: null },
            { dispatchClaimedAt: { $lt: claimCutoff } },
          ],
        },
      ],
    },
    {
      $set: {
        dispatchClaimId: claimId,
        dispatchClaimedAt: now,
        dispatchRoomName: roomName,
        dispatchAgentName: agentName,
      },
      $unset: {
        dispatchLastError: '',
        dispatchLastErrorAt: '',
      },
    },
    { new: true },
  ).lean();

  if (!claimed) {
    return { status: 'in_flight', session: normalizeSession(session) };
  }

  return {
    status: 'claimed',
    claimId,
    session: normalizeSession(claimed),
  };
}

function normalizeDispatchError(error) {
  if (!error) {
    return null;
  }
  const text = String(error);
  if (text.length <= 300) {
    return text;
  }
  return `${text.slice(0, 300)}...`;
}

async function confirmDispatch({
  callSessionId,
  claimId,
  success,
  error,
}) {
  if (!callSessionId) {
    throw new Error('confirmDispatch requires callSessionId');
  }
  if (!claimId) {
    throw new Error('confirmDispatch requires claimId');
  }

  const now = new Date();
  const update = success
    ? {
      $set: { dispatchConfirmedAt: now },
      $unset: { dispatchClaimId: '', dispatchClaimedAt: '' },
    }
    : {
      $set: {
        dispatchLastError: normalizeDispatchError(error) || 'dispatch failed',
        dispatchLastErrorAt: now,
      },
      $unset: { dispatchClaimId: '', dispatchClaimedAt: '' },
    };

  const session = await ViventiumCallSession.findOneAndUpdate(
    {
      callSessionId: String(callSessionId),
      dispatchClaimId: String(claimId),
      expiresAt: { $gt: now },
    },
    update,
    { new: true },
  ).lean();

  return normalizeSession(session);
}

module.exports = {
  compactVoiceRouteState,
  createCallSession,
  getCallSession,
  getCallSessionVoiceSettings,
  getUserSavedVoiceRoute,
  normalizeVoiceRouteState,
  resolveUserVoiceRoute,
  syncCallSessionState,
  updateCallSessionVoiceSettings,
  updateCallSessionConversationId,
  claimVoiceSession,
  assertCallSessionSecret,
  assertVoiceGatewayAuth,
  claimDispatch,
  confirmDispatch,
};

/* === VIVENTIUM NOTE === */
