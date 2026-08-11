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
const { ViventiumCallSession, ViventiumVoiceSpeakerSegment } = require('~/db/models');
const { getUserById, updateUserViventiumVoicePreferences } = require('~/models');
const { resolveVoiceOverrideAssignment } = require('./voiceLlmOverride');
const { rewriteAgentForRuntime } = require('../../../../scripts/viventium-agent-runtime-models');

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes
// Keep terminal call/speaker authority evidence through the maximum supported task-owner callback
// horizon. Durable memory finalization remains the authority after this recovery window expires.
const POST_CALL_MEMORY_EVIDENCE_TTL_MS = 35 * 24 * 60 * 60 * 1000;
const DEFAULT_LEASE_MS = 60 * 1000; // 60 seconds
const DEFAULT_DISPATCH_CLAIM_MS = 15 * 1000; // 15 seconds
const DEFAULT_VOICE_GATEWAY_AGENT_NAME = 'librechat-voice-gateway';
const BROWSER_LAUNCH_TTL_MS = 15 * 60 * 1000;
/* === VIVENTIUM START ===
 * Feature: Modern playground voice-route persistence
 * Purpose: Normalize provider/variant selections before storing them in the call session or user.
 * === VIVENTIUM END === */
const MAX_PROVIDER_LENGTH = 80;
const MAX_VARIANT_LENGTH = 160;
/* === VIVENTIUM START ===
 * Feature: VoiceCallStateV1 compatibility contract
 * Purpose: Own one canonical mode while preserving the historical boolean aliases during rollout.
 * === VIVENTIUM END === */
const CALL_MODES = new Set(['call', 'wing', 'listen_only']);
const CALL_STATUSES = new Set([
  'created',
  'connecting',
  'listening',
  'speaking',
  'working',
  'needs_input',
  'degraded',
  'failed',
  'ended',
]);
const CALL_FAILURE_CODES = new Set(['no_route', 'provider_failure', 'gateway_down']);

function publicCallFailure(failure) {
  if (!failure || !CALL_FAILURE_CODES.has(failure.code)) {
    return null;
  }
  const message = normalizeVoiceRouteText(failure.message, 300);
  return {
    code: failure.code,
    message: message || 'Voice calling is temporarily unavailable.',
    retryable: failure.retryable === true,
  };
}

function resolveCallMode({ mode, wingModeEnabled, shadowModeEnabled, listenOnlyModeEnabled } = {}) {
  if (CALL_MODES.has(mode)) {
    return mode;
  }
  if (listenOnlyModeEnabled === true) {
    return 'listen_only';
  }
  if (wingModeEnabled === true || shadowModeEnabled === true) {
    return 'wing';
  }
  return 'call';
}

function createRoomName(callSessionId) {
  // LiveKit room name practical max ~64; keep it short & deterministic.
  const short = String(callSessionId)
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 12);
  return `lc-${short || 'call'}`;
}

function getConfiguredGatewayAgentName() {
  return (
    normalizeVoiceRouteText(process.env.VIVENTIUM_VOICE_GATEWAY_AGENT_NAME, 160) ||
    DEFAULT_VOICE_GATEWAY_AGENT_NAME
  );
}

function createOwnerParticipantIdentity() {
  return `owner-${crypto.randomUUID()}`;
}

/* === VIVENTIUM START ===
 * Feature: browser-scoped call capability
 * Purpose: Mint high-entropy browser authority independently from the non-secret session ID.
 * Only its digest crosses the durable persistence boundary.
 * === VIVENTIUM END === */
function createBrowserCallCapability() {
  const capability = crypto.randomBytes(32).toString('base64url');
  return {
    capability,
    hash: crypto.createHash('sha256').update(capability).digest('hex'),
  };
}

function hashBrowserCallCapability(capability) {
  if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability)) {
    return null;
  }
  return crypto.createHash('sha256').update(capability).digest('hex');
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

  if (normalizeSavedProviderAlias(normalized.stt.provider, 'stt') === 'pywhispercpp') {
    normalized.stt.variant = normalizeLocalWhisperModel(normalized.stt.variant);
  }

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
  return process.arch === 'x64' ? 'small' : 'large-v3-turbo';
}

function normalizeLocalWhisperModel(model) {
  const value = normalizeVoiceRouteText(model, MAX_VARIANT_LENGTH);
  if (!value) {
    return getDefaultLocalWhisperModel();
  }
  return value;
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
        variant: normalizeLocalWhisperModel(
          process.env.VIVENTIUM_STT_MODEL ||
            process.env.LOCAL_WHISPER_MODEL_NAME ||
            getDefaultLocalWhisperModel(),
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
      variant: normalizeVoiceRouteText(
        process.env.VIVENTIUM_XAI_VOICE || 'Sal',
        MAX_VARIANT_LENGTH,
      ),
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
  const leaseExpiresAt = session.leaseExpiresAt
    ? new Date(session.leaseExpiresAt).getTime()
    : undefined;
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
  /* === VIVENTIUM START ===
   * Feature: Listen-Only Mode
   * Purpose: Make Listen-Only mutually exclusive with Wing Mode at the durable session boundary.
   * === VIVENTIUM END === */
  const normalizedListenOnlyModeEnabled = session.listenOnlyModeEnabled === true;
  const mode = resolveCallMode({
    mode: session.mode,
    wingModeEnabled: normalizedWingModeEnabled,
    listenOnlyModeEnabled: normalizedListenOnlyModeEnabled,
  });
  const updatedAt = session.updatedAt ? new Date(session.updatedAt).getTime() : createdAt;
  const speakerDetectedAt = session.speakerDetectedAt ? new Date(session.speakerDetectedAt) : null;
  const speakerAttributionState = ['single_speaker', 'shared_mic_unverified'].includes(
    session.speakerAttributionState,
  )
    ? session.speakerAttributionState
    : null;
  const speakerSessionRevision = Number.isFinite(Number(session.speakerSessionRevision))
    ? Number(session.speakerSessionRevision)
    : 0;
  const sharedTrackSids = Array.isArray(session.speakerSharedTrackSids)
    ? [
        ...new Set(
          session.speakerSharedTrackSids
            .slice(0, 64)
            .filter((value) => typeof value === 'string' && value.trim())
            .map((value) => value.trim().slice(0, 160)),
        ),
      ].sort()
    : null;
  const sharedParticipantIdentities = Array.isArray(session.speakerSharedParticipantIdentities)
    ? [
        ...new Set(
          session.speakerSharedParticipantIdentities
            .slice(0, 64)
            .filter((value) => typeof value === 'string' && value.trim())
            .map((value) => value.trim().slice(0, 160)),
        ),
      ].sort()
    : null;
  const callFailure = publicCallFailure(session.callFailure);
  return {
    version: 1,
    callSessionId: session.callSessionId,
    userId: session.userId,
    agentId: session.agentId,
    conversationId: session.conversationId,
    roomName: session.roomName,
    gatewayAgentName: session.gatewayAgentName || DEFAULT_VOICE_GATEWAY_AGENT_NAME,
    ownerParticipantIdentity: session.ownerParticipantIdentity || null,
    createdAtMs: createdAt,
    expiresAtMs: expiresAt,
    requestedVoiceRoute: normalizeVoiceRouteState(session.requestedVoiceRoute),
    speakerAttributionState,
    sharedTrackSids,
    sharedParticipantIdentities,
    speakerSessionRevision,
    speakerSessionState:
      speakerAttributionState && speakerDetectedAt && Number.isFinite(speakerDetectedAt.getTime())
        ? {
            version: 1,
            callSessionId: session.callSessionId,
            revision: speakerSessionRevision,
            attributionState: speakerAttributionState,
            detectedAt: speakerDetectedAt.toISOString(),
            ...(session.speakerSourceTrackSid
              ? { sourceTrackSid: String(session.speakerSourceTrackSid) }
              : {}),
            ...(session.speakerSourceParticipantIdentity
              ? {
                  sourceParticipantIdentity: String(session.speakerSourceParticipantIdentity),
                }
              : {}),
            ...(sharedTrackSids ? { sharedTrackSids } : {}),
            ...(sharedParticipantIdentities ? { sharedParticipantIdentities } : {}),
          }
        : null,
    mode,
    status: session.callStatus || 'created',
    ...(callFailure ? { error: callFailure } : {}),
    revision: Number.isFinite(Number(session.callModeRevision))
      ? Number(session.callModeRevision)
      : 0,
    updatedAt,
    wingModeEnabled: mode === 'wing',
    shadowModeEnabled: mode === 'wing',
    listenOnlyModeEnabled: mode === 'listen_only',
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
async function resolveCallSessionAssistantRoute(
  agentId,
  { capabilityRequiredProviders = [] } = {},
) {
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

  const runtimeAgent = rewriteAgentForRuntime(persistedAgent, {
    capabilityRequiredProviders,
  });
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
  const fallbackLlm = buildAssistantRouteAssignment(
    runtimeAgent?.fallback_llm_provider,
    runtimeAgent?.fallback_llm_model || runtimeAgent?.fallback_llm_model_parameters?.model,
  );
  const voiceFallbackLlm = buildAssistantRouteAssignment(
    runtimeAgent?.voice_fallback_llm_provider,
    runtimeAgent?.voice_fallback_llm_model ||
      runtimeAgent?.voice_fallback_llm_model_parameters?.model,
  );

  return {
    primary,
    voiceCallLlm,
    fallbackLlm: voiceFallbackLlm || fallbackLlm,
    voiceFallbackLlm,
    effective: voiceCallLlm || primary,
    inheritsPrimary: !voiceCallLlm,
  };
}

async function createCallSession({ userId, agentId, conversationId, ttlMs }) {
  if (!userId) {
    throw new Error('createCallSession requires userId');
  }
  if (!agentId) {
    throw new Error('createCallSession requires agentId');
  }

  const normalizedRequestedVoiceRoute = compactVoiceRouteState(await resolveUserVoiceRoute(userId));
  if (
    !normalizedRequestedVoiceRoute?.stt?.provider ||
    !normalizedRequestedVoiceRoute?.tts?.provider
  ) {
    const error = new Error('Voice calling requires configured STT and TTS providers.');
    error.code = 'no_route';
    error.status = 400;
    error.retryable = false;
    throw error;
  }

  const callSessionId = crypto.randomUUID();
  const createdAtMs = Date.now();
  const ttl = Number(ttlMs) || getCallSessionTtlMs();
  const expiresAtMs = createdAtMs + ttl;
  const roomName = createRoomName(callSessionId);
  const gatewayAgentName = getConfiguredGatewayAgentName();
  const ownerParticipantIdentity = createOwnerParticipantIdentity();
  const browserCapability = createBrowserCallCapability();
  /* === VIVENTIUM START ===
   * Feature: Modern playground voice-route persistence
   * Purpose: Seed new call sessions from the explicit request first, then fall back to saved defaults.
   * === VIVENTIUM END === */
  const session = {
    callSessionId,
    userId,
    agentId,
    // conversationId may be "new" initially; it will be updated after first agent run starts.
    conversationId: conversationId || 'new',
    roomName,
    gatewayAgentName,
    ownerParticipantIdentity,
    browserCapabilityHash: browserCapability.hash,
    browserCapabilityExpiresAt: new Date(expiresAtMs),
    browserCapabilityVersion: 1,
    browserCapabilityScope: 'call_browser_v1',
    createdAt: new Date(createdAtMs),
    expiresAt: new Date(expiresAtMs),
    wingModeEnabled: false,
    shadowModeEnabled: false,
    listenOnlyModeEnabled: false,
    mode: 'call',
    callStatus: 'created',
    requestedVoiceRoute: normalizedRequestedVoiceRoute,
  };

  const saved = await ViventiumCallSession.create(session);

  /* === VIVENTIUM START ===
   * Feature: Voice diagnostics privacy.
   * Purpose: Record lifecycle state without persisting user, agent, conversation, room, or session identifiers.
   * === VIVENTIUM END === */
  logger.debug?.('[VIVENTIUM][CallSession] created');

  return {
    ...normalizeSession(saved),
    // Ephemeral launch-only value. Never returned by normalizeSession/getCallSession.
    browserCapability: browserCapability.capability,
  };
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

/* === VIVENTIUM START ===
 * Feature: one-time Telegram call launch exchange
 * Purpose: A Telegram button carries only a single-use launch bearer. The browser receives its
 * renewable per-session capability only after a same-origin, server-authenticated atomic exchange.
 * Neither raw bearer is persisted or returned by ordinary session readers.
 * === VIVENTIUM END === */
async function createCallBrowserLaunch(callSessionId) {
  const normalizedCallSessionId = String(callSessionId || '');
  if (!normalizedCallSessionId) {
    const error = new Error('Call session is required');
    error.status = 400;
    throw error;
  }
  const launch = createBrowserCallCapability();
  const now = new Date();
  const launchExpiresAt = new Date(now.getTime() + BROWSER_LAUNCH_TTL_MS);
  const session = await ViventiumCallSession.findOneAndUpdate(
    {
      callSessionId: normalizedCallSessionId,
      callStatus: { $ne: 'ended' },
      expiresAt: { $gt: now },
    },
    {
      $set: {
        browserLaunchCapabilityHash: launch.hash,
        browserLaunchCapabilityExpiresAt: launchExpiresAt,
        browserLaunchCapabilityVersion: 1,
        browserLaunchCapabilityScope: 'call_browser_launch_v1',
        browserLaunchCapabilityUsedAt: null,
        browserLaunchIdempotencyHash: null,
      },
    },
    { new: true },
  ).lean();
  if (!session) {
    const error = new Error('Call session expired');
    error.status = 410;
    throw error;
  }
  return {
    capability: launch.capability,
    expiresAt: launchExpiresAt.toISOString(),
  };
}

function deriveBrowserCapabilityForLaunch({ callSessionId, launchHash, idempotencyHash }) {
  const secret = getRequiredEnvSecret();
  if (!secret) {
    const error = new Error('Call session secret is unavailable');
    error.status = 503;
    throw error;
  }
  return crypto
    .createHmac('sha256', secret)
    .update(`${callSessionId}\n${launchHash}\n${idempotencyHash}`)
    .digest('base64url');
}

async function exchangeCallBrowserLaunch(callSessionId, launchCapability, idempotencyCapability) {
  const normalizedCallSessionId = String(callSessionId || '');
  const incomingHash = hashBrowserCallCapability(launchCapability);
  const idempotencyHash = hashBrowserCallCapability(idempotencyCapability);
  if (!normalizedCallSessionId || !incomingHash || !idempotencyHash) {
    const error = new Error('Invalid call launch capability');
    error.status = 401;
    throw error;
  }
  const browserCapability = deriveBrowserCapabilityForLaunch({
    callSessionId: normalizedCallSessionId,
    launchHash: incomingHash,
    idempotencyHash,
  });
  const browserCapabilityHash = hashBrowserCallCapability(browserCapability);
  const now = new Date();
  let session = await ViventiumCallSession.findOneAndUpdate(
    {
      callSessionId: normalizedCallSessionId,
      callStatus: { $ne: 'ended' },
      expiresAt: { $gt: now },
      browserLaunchCapabilityHash: incomingHash,
      browserLaunchCapabilityExpiresAt: { $gt: now },
      browserLaunchCapabilityVersion: 1,
      browserLaunchCapabilityScope: 'call_browser_launch_v1',
      browserLaunchCapabilityUsedAt: null,
    },
    {
      $set: {
        browserLaunchCapabilityUsedAt: now,
        browserLaunchIdempotencyHash: idempotencyHash,
        browserCapabilityHash,
        browserCapabilityExpiresAt: new Date(now.getTime() + getCallSessionTtlMs()),
        browserCapabilityVersion: 1,
        browserCapabilityScope: 'call_browser_v1',
      },
    },
    { new: true },
  )
    .select(
      '+browserLaunchCapabilityHash +browserLaunchCapabilityExpiresAt +browserLaunchCapabilityVersion +browserLaunchCapabilityScope +browserLaunchCapabilityUsedAt +browserLaunchIdempotencyHash',
    )
    .lean();
  if (!session) {
    session = await ViventiumCallSession.findOne({
      callSessionId: normalizedCallSessionId,
      callStatus: { $ne: 'ended' },
      expiresAt: { $gt: now },
      browserLaunchCapabilityHash: incomingHash,
      browserLaunchCapabilityExpiresAt: { $gt: now },
      browserLaunchCapabilityVersion: 1,
      browserLaunchCapabilityScope: 'call_browser_launch_v1',
      browserLaunchCapabilityUsedAt: { $ne: null },
      browserLaunchIdempotencyHash: idempotencyHash,
      browserCapabilityHash,
      browserCapabilityExpiresAt: { $gt: now },
    })
      .select(
        '+browserLaunchCapabilityHash +browserLaunchCapabilityExpiresAt +browserLaunchCapabilityVersion +browserLaunchCapabilityScope +browserLaunchCapabilityUsedAt +browserLaunchIdempotencyHash',
      )
      .lean();
  }
  if (!session) {
    const error = new Error('Call launch capability expired or was already used');
    error.status = 410;
    throw error;
  }
  return {
    ...normalizeSession(session),
    browserCapability,
  };
}

async function syncCallSessionState({
  callSessionId,
  touch = true,
  nowMs,
  status,
  mode,
  wingModeEnabled,
  shadowModeEnabled,
  listenOnlyModeEnabled,
}) {
  if (!callSessionId) {
    throw new Error('syncCallSessionState requires callSessionId');
  }

  const now = Number.isFinite(Number(nowMs)) ? new Date(Number(nowMs)) : new Date();
  const set = {};
  if (touch !== false) {
    set.expiresAt = new Date(now.getTime() + getCallSessionTtlMs());
    set.browserCapabilityExpiresAt = set.expiresAt;
  }
  if (CALL_STATUSES.has(status)) {
    set.callStatus = status;
  }
  if (status === 'ended') {
    set.expiresAt = new Date(now.getTime() + POST_CALL_MEMORY_EVIDENCE_TTL_MS);
    set.browserCapabilityExpiresAt = now;
  }

  if (CALL_MODES.has(mode)) {
    set.mode = mode;
    set.wingModeEnabled = mode === 'wing';
    set.shadowModeEnabled = mode === 'wing';
    set.listenOnlyModeEnabled = mode === 'listen_only';
  }

  const normalizedWingMode =
    typeof wingModeEnabled === 'boolean'
      ? wingModeEnabled
      : typeof shadowModeEnabled === 'boolean'
        ? shadowModeEnabled
        : null;
  if (!CALL_MODES.has(mode) && typeof normalizedWingMode === 'boolean') {
    set.wingModeEnabled = normalizedWingMode;
    set.shadowModeEnabled = normalizedWingMode;
    set.mode = normalizedWingMode ? 'wing' : 'call';
    if (normalizedWingMode) {
      set.listenOnlyModeEnabled = false;
    }
  }

  if (!CALL_MODES.has(mode) && typeof listenOnlyModeEnabled === 'boolean') {
    set.listenOnlyModeEnabled = listenOnlyModeEnabled;
    set.mode = listenOnlyModeEnabled ? 'listen_only' : 'call';
    if (listenOnlyModeEnabled) {
      set.wingModeEnabled = false;
      set.shadowModeEnabled = false;
    }
  }

  const modeChanged =
    CALL_MODES.has(mode) ||
    typeof normalizedWingMode === 'boolean' ||
    typeof listenOnlyModeEnabled === 'boolean';
  const update = {
    $set: set,
    ...(modeChanged ? { $inc: { callModeRevision: 1 } } : {}),
  };
  const session = await ViventiumCallSession.findOneAndUpdate(
    {
      callSessionId: String(callSessionId),
      expiresAt: { $gt: now },
      callStatus: { $ne: 'ended' },
    },
    update,
    { new: true },
  ).lean();
  if (session) {
    if (status === 'ended' && session.expiresAt) {
      await ViventiumVoiceSpeakerSegment.updateMany(
        { callSessionId: String(callSessionId) },
        { $set: { expiresAt: new Date(session.expiresAt) } },
      );
    } else if (touch !== false && session.expiresAt) {
      const renewalThreshold = new Date(now.getTime() + Math.floor(getCallSessionTtlMs() / 2));
      await ViventiumVoiceSpeakerSegment.updateMany(
        {
          callSessionId: String(callSessionId),
          expiresAt: { $lt: renewalThreshold },
        },
        { $set: { expiresAt: new Date(session.expiresAt) } },
      );
    }
    return normalizeSession(session);
  }
  // `ended` is terminal. A delayed keepalive, mode switch, or status packet may observe the
  // terminal record but can never extend or reopen it.
  const terminal = await ViventiumCallSession.findOne({
    callSessionId: String(callSessionId),
    expiresAt: { $gt: now },
    callStatus: 'ended',
  }).lean();
  return normalizeSession(terminal);
}

/* === VIVENTIUM START ===
 * Feature: extended-call low-write heartbeat
 * Purpose: Renew a silent call and its speaker ledger only inside the final half of the TTL,
 * avoiding a database write on every gateway mode poll while keeping ended terminal.
 * === VIVENTIUM END === */
async function heartbeatCallSession({ callSessionId, currentSession, nowMs } = {}) {
  if (!callSessionId) {
    throw new Error('heartbeatCallSession requires callSessionId');
  }
  const now = Number.isFinite(Number(nowMs)) ? new Date(Number(nowMs)) : new Date();
  const ttlMs = getCallSessionTtlMs();
  let current = currentSession?.callSessionId === String(callSessionId) ? currentSession : null;
  if (!current) {
    const row = await ViventiumCallSession.findOne({
      callSessionId: String(callSessionId),
      expiresAt: { $gt: now },
    }).lean();
    current = normalizeSession(row);
  }
  if (!current || current.status === 'ended') {
    return current;
  }
  const expiresAtMs = Number(current.expiresAtMs) || 0;
  if (expiresAtMs <= now.getTime()) {
    return null;
  }
  const renewalThreshold = new Date(now.getTime() + Math.floor(ttlMs / 2));
  if (expiresAtMs >= renewalThreshold.getTime()) {
    return current;
  }
  const expiresAt = new Date(now.getTime() + ttlMs);
  const renewed = await ViventiumCallSession.findOneAndUpdate(
    {
      callSessionId: String(callSessionId),
      expiresAt: { $gt: now, $lt: renewalThreshold },
      callStatus: { $ne: 'ended' },
    },
    { $set: { expiresAt, browserCapabilityExpiresAt: expiresAt } },
    { new: true },
  ).lean();
  if (renewed) {
    await ViventiumVoiceSpeakerSegment.updateMany(
      {
        callSessionId: String(callSessionId),
        expiresAt: { $lt: renewalThreshold },
      },
      { $set: { expiresAt } },
    );
    return normalizeSession(renewed);
  }
  const latest = await ViventiumCallSession.findOne({
    callSessionId: String(callSessionId),
    expiresAt: { $gt: now },
  }).lean();
  return normalizeSession(latest);
}

async function getCallSessionVoiceSettings(
  callSessionId,
  { capabilityRequiredProviders = [] } = {},
) {
  const session = await getCallSession(callSessionId);
  if (!session) {
    return null;
  }

  const assistantRoute = await resolveCallSessionAssistantRoute(session.agentId, {
    capabilityRequiredProviders,
  });

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
  capabilityRequiredProviders = [],
}) {
  if (!callSessionId) {
    throw new Error('updateCallSessionVoiceSettings requires callSessionId');
  }

  const now = new Date();
  const set = {};
  if (touch !== false) {
    set.expiresAt = new Date(now.getTime() + getCallSessionTtlMs());
    set.browserCapabilityExpiresAt = set.expiresAt;
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
    savedVoiceRoute = normalizeVoiceRouteState(
      updatedUser?.viventiumVoicePreferences?.livekitPlayground,
    );
  }

  const assistantRoute = await resolveCallSessionAssistantRoute(normalizedSession.agentId, {
    capabilityRequiredProviders,
  });

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
  dispatchClaimId,
}) {
  if (!callSessionId) {
    throw new Error('claimVoiceSession requires callSessionId');
  }
  if (!jobId) {
    throw new Error('claimVoiceSession requires jobId');
  }
  if (!workerId) {
    throw new Error('claimVoiceSession requires workerId');
  }

  const now = new Date();
  const leaseMs = Number(leaseDurationMs) || getCallSessionLeaseMs();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  const normalizedDispatchClaimId = String(dispatchClaimId || '').trim();
  const filter = {
    callSessionId: String(callSessionId),
    expiresAt: { $gt: now },
    callStatus: { $ne: 'ended' },
    $or: [{ activeJobId: String(jobId) }, { activeJobId: null }, { leaseExpiresAt: { $lt: now } }],
  };
  if (normalizedDispatchClaimId) {
    filter.dispatchClaimId = normalizedDispatchClaimId;
  }
  const update = {
    $set: {
      activeJobId: String(jobId),
      activeWorkerId: String(workerId),
      leaseExpiresAt,
    },
  };
  if (normalizedDispatchClaimId) {
    update.$unset = { dispatchClaimId: '', dispatchClaimedAt: '' };
  }

  const session = await ViventiumCallSession.findOneAndUpdate(filter, update, {
    new: true,
  }).lean();

  return normalizeSession(session);
}

/* === VIVENTIUM START ===
 * Feature: Voice gateway failed-start lease release
 * Purpose: Let the exact worker that owns a pre-connect claim abandon it after owner timeout,
 * mismatch, or initialization failure. The compare-and-clear cannot release another worker and
 * never changes call status, conversation work, dispatch state, or task state.
 * === VIVENTIUM END === */
async function abandonVoiceSessionClaim({ callSessionId, jobId, workerId }) {
  if (!callSessionId || !jobId || !workerId) {
    return false;
  }
  const now = new Date();
  const released = await ViventiumCallSession.findOneAndUpdate(
    {
      callSessionId: String(callSessionId),
      expiresAt: { $gt: now },
      activeJobId: String(jobId),
      activeWorkerId: String(workerId),
    },
    {
      $set: {
        activeJobId: null,
        activeWorkerId: null,
        leaseExpiresAt: null,
      },
    },
    { new: false },
  ).lean();
  return Boolean(released);
}

/* === VIVENTIUM START ===
 * Feature: exact-owner voice provider failure reporting
 * Purpose: Convert provider/runtime construction failures into bounded call state without
 * persisting arbitrary SDK messages. Only the currently claimed job+worker may mutate it.
 * === VIVENTIUM END === */
async function reportVoiceSessionFailure({
  callSessionId,
  jobId,
  workerId,
  classification,
  modality,
  provider,
  phase,
  fatal = true,
}) {
  if (!callSessionId || !jobId || !workerId || !CALL_FAILURE_CODES.has(classification)) {
    return null;
  }
  const normalizedModality = ['stt', 'tts'].includes(modality) ? modality : null;
  const normalizedPhase = ['initialization', 'runtime'].includes(phase) ? phase : null;
  const messages = {
    no_route: 'The configured voice route is unavailable.',
    provider_failure:
      normalizedPhase === 'runtime'
        ? 'The voice provider stopped unexpectedly.'
        : 'The voice provider could not start.',
    gateway_down: 'The voice gateway is unavailable.',
  };
  const callFailure = {
    code: classification,
    message: messages[classification],
    retryable: classification !== 'no_route',
    modality: normalizedModality,
    provider: normalizeVoiceRouteText(provider, MAX_PROVIDER_LENGTH),
    phase: normalizedPhase,
    fatal: fatal === true,
    reportedAt: new Date(),
  };
  const session = await ViventiumCallSession.findOneAndUpdate(
    {
      callSessionId: String(callSessionId),
      expiresAt: { $gt: callFailure.reportedAt },
      callStatus: { $ne: 'ended' },
      activeJobId: String(jobId),
      activeWorkerId: String(workerId),
    },
    {
      $set: {
        callStatus: fatal === true ? 'failed' : 'degraded',
        callFailure,
      },
      $inc: { callModeRevision: 1 },
    },
    { new: true },
  ).lean();
  return normalizeSession(session);
}

/* === VIVENTIUM START ===
 * Feature: exact-owner provider recovery readiness
 * Purpose: A retryable provider failure remains visible across abandon/reclaim until the newly
 * claimed gateway has proved session/provider readiness. Generic state writes cannot clear it.
 * === VIVENTIUM END === */
async function markVoiceSessionReady({ callSessionId, jobId, workerId }) {
  if (!callSessionId || !jobId || !workerId) {
    return null;
  }
  const now = new Date();
  const session = await ViventiumCallSession.findOneAndUpdate(
    {
      callSessionId: String(callSessionId),
      expiresAt: { $gt: now },
      callStatus: { $ne: 'ended' },
      activeJobId: String(jobId),
      activeWorkerId: String(workerId),
    },
    {
      $set: { callStatus: 'listening' },
      $unset: { callFailure: 1 },
      $inc: { callModeRevision: 1 },
    },
    { new: true },
  ).lean();
  return normalizeSession(session);
}

async function updateCallSessionConversationId(callSessionId, conversationId) {
  /* === VIVENTIUM START ===
   * Feature: Voice diagnostics privacy.
   * Purpose: Trace state transitions without logging call-session or conversation identifiers.
   * === VIVENTIUM END === */
  logger.info('[VIVENTIUM][CallSession] conversation_update_attempted');

  if (!callSessionId || !conversationId || conversationId === 'new') {
    logger.info('[VIVENTIUM][CallSession] conversation_update_skipped');
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
    logger.info('[VIVENTIUM][CallSession] conversation_update_not_found');
    return null;
  }

  logger.info('[VIVENTIUM][CallSession] conversation_updated');
  return normalizeSession(session);
}

/* === VIVENTIUM START ===
 * Feature: Listen-Only Mode
 * Purpose: Atomically claim the concrete conversationId for a new call session so concurrent
 * listen-only transcript saves cannot split one listening session across multiple conversations.
 * === VIVENTIUM END === */
async function claimOrReplaceCallSessionConversationId(
  callSessionId,
  candidateConversationId,
  { expectedConversationId } = {},
) {
  if (!callSessionId || !candidateConversationId || candidateConversationId === 'new') {
    return null;
  }

  const now = new Date();
  const normalizedExpectedConversationId =
    typeof expectedConversationId === 'string' && expectedConversationId.trim()
      ? expectedConversationId.trim()
      : '';
  const conversationIdCondition =
    normalizedExpectedConversationId && normalizedExpectedConversationId !== 'new'
      ? { conversationId: normalizedExpectedConversationId }
      : {
          $or: [
            { conversationId: 'new' },
            { conversationId: '' },
            { conversationId: null },
            { conversationId: { $exists: false } },
          ],
        };

  const claim = await ViventiumCallSession.findOneAndUpdate(
    {
      callSessionId: String(callSessionId),
      expiresAt: { $gt: now },
      ...conversationIdCondition,
    },
    { $set: { conversationId: candidateConversationId } },
    { new: true },
  ).lean();

  if (claim) {
    return normalizeSession(claim);
  }

  const existing = await ViventiumCallSession.findOne({
    callSessionId: String(callSessionId),
    expiresAt: { $gt: now },
  }).lean();

  return normalizeSession(existing);
}

async function materializeCallSessionConversationId(callSessionId, candidateConversationId) {
  return claimOrReplaceCallSessionConversationId(callSessionId, candidateConversationId);
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

/* === VIVENTIUM START ===
 * Feature: browser-scoped call capability
 * Purpose: Require both the trusted BFF secret and the exact per-session browser capability on
 * browser-facing state/snapshot/control calls. Ended or expired capability is terminal (410).
 * === VIVENTIUM END === */
async function assertCallBrowserCapability(callSessionId, capability) {
  const incomingHash = hashBrowserCallCapability(capability);
  if (!callSessionId || !incomingHash) {
    const error = new Error('Invalid call browser capability');
    error.status = 401;
    throw error;
  }
  const now = new Date();
  const session = await ViventiumCallSession.findOne({
    callSessionId: String(callSessionId),
  })
    .select(
      '+browserCapabilityHash +browserCapabilityExpiresAt +browserCapabilityVersion +browserCapabilityScope',
    )
    .lean();
  if (
    !session ||
    session.callStatus === 'ended' ||
    !session.expiresAt ||
    new Date(session.expiresAt) <= now ||
    !session.browserCapabilityExpiresAt ||
    new Date(session.browserCapabilityExpiresAt) <= now ||
    session.browserCapabilityVersion !== 1 ||
    session.browserCapabilityScope !== 'call_browser_v1'
  ) {
    const error = new Error('Call browser capability expired');
    error.status = 410;
    throw error;
  }
  const expectedHash = String(session.browserCapabilityHash || '');
  if (
    expectedHash.length !== incomingHash.length ||
    !crypto.timingSafeEqual(Buffer.from(expectedHash), Buffer.from(incomingHash))
  ) {
    const error = new Error('Invalid call browser capability');
    error.status = 401;
    throw error;
  }
  return normalizeSession(session);
}

async function assertVoiceGatewayAuth(req, { nowMs } = {}) {
  const callSessionId =
    req.get('X-VIVENTIUM-CALL-SESSION') || req.get('x-viventium-call-session') || '';
  const secret = req.get('X-VIVENTIUM-CALL-SECRET') || req.get('x-viventium-call-secret') || '';
  const jobId = req.get('X-VIVENTIUM-JOB-ID') || req.get('x-viventium-job-id') || '';
  const workerId = req.get('X-VIVENTIUM-WORKER-ID') || req.get('x-viventium-worker-id') || '';

  const expected = getRequiredEnvSecret();
  if (!expected) {
    throw new Error('VIVENTIUM_CALL_SESSION_SECRET is not set');
  }
  if (!secret || secret !== expected) {
    const err = new Error('Unauthorized voice gateway');
    err.status = 401;
    throw err;
  }
  if (!jobId) {
    const err = new Error('Missing voice job id');
    err.status = 401;
    throw err;
  }
  if (!workerId) {
    const err = new Error('Missing voice worker id');
    err.status = 401;
    throw err;
  }

  /* === VIVENTIUM START ===
   * Feature: Voice hot-path auth compression.
   * Purpose: Combine the "session exists" check and worker lease claim into one atomic
   * DB query on the successful path. The previous flow performed getCallSession() and
   * then claimVoiceSession(), adding an avoidable round trip before stream readiness.
   * === VIVENTIUM END === */
  const now = Number.isFinite(Number(nowMs)) ? new Date(Number(nowMs)) : new Date();
  const leaseMs = getCallSessionLeaseMs();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const normalizedJobId = String(jobId);
  const normalizedWorkerId = String(workerId);
  const leaseRenewalThreshold = new Date(now.getTime() + Math.floor(leaseMs / 2));
  const existingOwner = await ViventiumCallSession.findOne({
    callSessionId: String(callSessionId),
    expiresAt: { $gt: now },
    callStatus: { $ne: 'ended' },
    activeJobId: normalizedJobId,
    activeWorkerId: normalizedWorkerId,
    leaseExpiresAt: { $gt: leaseRenewalThreshold },
  }).lean();
  if (existingOwner) {
    return normalizeSession(existingOwner);
  }
  const claimed = await ViventiumCallSession.findOneAndUpdate(
    {
      callSessionId: String(callSessionId),
      expiresAt: { $gt: now },
      callStatus: { $ne: 'ended' },
      $or: [
        {
          activeJobId: normalizedJobId,
          $or: [{ activeWorkerId: normalizedWorkerId }, { activeWorkerId: null }],
        },
        { activeJobId: null },
        { leaseExpiresAt: { $lt: now } },
      ],
    },
    {
      $set: {
        activeJobId: normalizedJobId,
        activeWorkerId: normalizedWorkerId,
        leaseExpiresAt,
      },
    },
    { new: true },
  ).lean();
  if (claimed) {
    return normalizeSession(claimed);
  }
  /* === VIVENTIUM END === */

  const session = await getCallSession(callSessionId);
  if (!session) {
    const err = new Error('Unknown or expired call session');
    err.status = 401;
    throw err;
  }
  if (session.status === 'ended') {
    const err = new Error('Call session has ended');
    err.status = 410;
    throw err;
  }
  const currentTimeMs = now.getTime();
  if (session.activeJobId && session.activeJobId !== jobId) {
    const leaseExpiresAtMs = session.leaseExpiresAtMs || 0;
    if (leaseExpiresAtMs > currentTimeMs) {
      const err = new Error('Another worker owns this session');
      err.status = 403;
      throw err;
    }
  }
  const err = new Error('Unable to claim voice session');
  err.status = 403;
  throw err;
}

async function claimDispatch({ callSessionId, roomName, agentName, reclaimConfirmed = false }) {
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
    callStatus: { $ne: 'ended' },
  }).lean();
  if (!session) {
    return { status: 'expired', session: null };
  }

  if (session.roomName && session.roomName !== roomName) {
    const err = new Error('Room name mismatch for call session');
    err.status = 409;
    throw err;
  }
  if (session.gatewayAgentName && session.gatewayAgentName !== agentName) {
    const err = new Error('Gateway agent name mismatch for call session');
    err.status = 409;
    throw err;
  }
  if (session.dispatchAgentName && session.dispatchAgentName !== agentName) {
    const err = new Error('Agent name mismatch for call session dispatch');
    err.status = 409;
    throw err;
  }
  if (session.dispatchConfirmedAt && reclaimConfirmed !== true) {
    return { status: 'already', session: normalizeSession(session) };
  }

  const hasHealthyActiveWorker =
    Boolean(session.activeJobId) &&
    session.leaseExpiresAt instanceof Date &&
    session.leaseExpiresAt.getTime() > now.getTime();
  if (session.dispatchConfirmedAt && reclaimConfirmed === true && hasHealthyActiveWorker) {
    return { status: 'already', session: normalizeSession(session) };
  }

  const claimId = crypto.randomUUID();
  const claimCutoff = new Date(now.getTime() - getDispatchClaimTtlMs());
  const dispatchConfirmationCondition =
    reclaimConfirmed === true
      ? { dispatchConfirmedAt: { $exists: true, $ne: null } }
      : { $or: [{ dispatchConfirmedAt: { $exists: false } }, { dispatchConfirmedAt: null }] };
  // Reclaims are guarded by dispatchConfirmedAt itself. The first winner unsets that field in the
  // same atomic update, so concurrent reclaims no longer match and report in_flight.
  const dispatchClaimAvailabilityCondition = {
    $or: [
      { dispatchClaimedAt: { $exists: false } },
      { dispatchClaimedAt: null },
      { dispatchClaimedAt: { $lt: claimCutoff } },
    ],
  };
  const activeWorkerAvailabilityCondition =
    reclaimConfirmed === true
      ? {
          $or: [
            { activeJobId: { $exists: false } },
            { activeJobId: null },
            { leaseExpiresAt: { $exists: false } },
            { leaseExpiresAt: null },
            { leaseExpiresAt: { $lt: now } },
          ],
        }
      : {};

  const claimed = await ViventiumCallSession.findOneAndUpdate(
    {
      callSessionId: String(callSessionId),
      expiresAt: { $gt: now },
      callStatus: { $ne: 'ended' },
      $and: [
        dispatchConfirmationCondition,
        dispatchClaimAvailabilityCondition,
        activeWorkerAvailabilityCondition,
      ],
    },
    {
      $set: {
        dispatchClaimId: claimId,
        dispatchAttemptId: claimId,
        dispatchClaimedAt: now,
        dispatchRoomName: roomName,
        dispatchAgentName: agentName,
      },
      $unset: {
        dispatchConfirmedAt: '',
        dispatchLastError: '',
        dispatchLastErrorAt: '',
      },
    },
    { new: true },
  ).lean();

  if (!claimed) {
    const current = await ViventiumCallSession.findOne({
      callSessionId: String(callSessionId),
      expiresAt: { $gt: now },
      callStatus: { $ne: 'ended' },
    }).lean();
    const currentHasHealthyActiveWorker =
      Boolean(current?.activeJobId) &&
      current?.leaseExpiresAt instanceof Date &&
      current.leaseExpiresAt.getTime() > now.getTime();
    if (
      reclaimConfirmed === true &&
      current?.dispatchConfirmedAt &&
      currentHasHealthyActiveWorker
    ) {
      return { status: 'already', session: normalizeSession(current) };
    }
    return { status: 'in_flight', session: normalizeSession(current || session) };
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

async function confirmDispatch({ callSessionId, claimId, success, error }) {
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
        $unset: { dispatchAttemptId: '' },
      }
    : {
        $set: {
          dispatchLastError: normalizeDispatchError(error) || 'dispatch failed',
          dispatchLastErrorAt: now,
        },
        $unset: { dispatchClaimId: '', dispatchAttemptId: '', dispatchClaimedAt: '' },
      };

  const session = await ViventiumCallSession.findOneAndUpdate(
    {
      callSessionId: String(callSessionId),
      dispatchAttemptId: String(claimId),
      expiresAt: { $gt: now },
      callStatus: { $ne: 'ended' },
    },
    update,
    { new: true },
  ).lean();

  return normalizeSession(session);
}

module.exports = {
  abandonVoiceSessionClaim,
  compactVoiceRouteState,
  createCallSession,
  createCallBrowserLaunch,
  exchangeCallBrowserLaunch,
  getCallSession,
  getCallSessionVoiceSettings,
  heartbeatCallSession,
  markVoiceSessionReady,
  reportVoiceSessionFailure,
  getUserSavedVoiceRoute,
  normalizeVoiceRouteState,
  resolveCallMode,
  resolveUserVoiceRoute,
  syncCallSessionState,
  updateCallSessionVoiceSettings,
  claimOrReplaceCallSessionConversationId,
  materializeCallSessionConversationId,
  updateCallSessionConversationId,
  claimVoiceSession,
  assertCallSessionSecret,
  assertCallBrowserCapability,
  assertVoiceGatewayAuth,
  claimDispatch,
  confirmDispatch,
};

/* === VIVENTIUM NOTE === */
