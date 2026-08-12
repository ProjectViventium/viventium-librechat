/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Feature: LibreChat Voice Calls - Call Session API
 *
 * POST /api/viventium/calls
 * - Authenticated (user JWT/cookie)
 * - Creates a short-lived call session and returns a playground deep-link
 *
 * Added: 2026-01-08
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { isEnabled } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const {
  createCallSession,
  exchangeCallBrowserLaunch,
  assertCallBrowserCapability,
  assertCallSessionSecret,
  getCallSession,
  heartbeatCallSession,
  claimDispatch,
  confirmDispatch,
  getDispatchStatus,
  getCallSessionVoiceSettings,
  syncCallSessionState,
  updateCallSessionVoiceSettings,
} = require('~/server/services/viventium/CallSessionService');
const {
  getDurableVoiceTaskContinuationState,
  listDurableVoiceTaskSnapshots,
} = require('~/server/services/viventium/VoiceTaskService');
const {
  buildCallLaunchResponse,
  shouldPreferPublicPlaygroundForRequest,
  verifyPlaygroundReadiness,
} = require('~/server/services/viventium/callLaunch');
const { getConvo } = require('~/models');
const {
  assertVoiceAgentAccess,
} = require('~/server/services/viventium/VoiceAgentAuthorizationService');

const router = express.Router();

function setSensitiveCallResponseHeaders(res) {
  res.set('Cache-Control', 'no-store, private');
  res.set('Pragma', 'no-cache');
}

/* === VIVENTIUM START ===
 * Feature: VoiceCallStateV1 timestamp boundary
 * Purpose: The persistence service uses millisecond timestamps internally; every public call-state
 * response uses the versioned contract's ISO UTC string so browser and gateway consumers agree.
 * === VIVENTIUM END === */
function toVoiceCallStateTimestamp(value) {
  if (value == null || value === '') {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/* === VIVENTIUM START ===
 * Feature: Call-route log privacy
 * Purpose: Call failures can contain secret-bearing URLs or provider payloads. Emit only the
 * bounded public taxonomy and HTTP status, never raw request/session/launch/error objects.
 * === VIVENTIUM END === */
function logCallRouteError(event, error) {
  const publicCodes = new Set([
    'auth_expired',
    'mic_denied',
    'microphone_missing',
    'no_route',
    'gateway_down',
    'provider_failure',
    'unknown',
  ]);
  const code = publicCodes.has(error?.code) ? error.code : 'unknown';
  const status = Number.isInteger(error?.status) ? error.status : 500;
  logger.error(`[VIVENTIUM][calls] ${event}`, { code, status });
}

/* === VIVENTIUM NOTE ===
 * Feature: Dispatch guard auth (call-session secret)
 * Purpose: Allow server-to-server dispatch claims without user JWTs.
 * === VIVENTIUM NOTE === */
async function dispatchAuth(req, res, next) {
  try {
    const callSessionId = req.params.callSessionId || '';
    const secret = req.get('X-VIVENTIUM-CALL-SECRET') || req.get('x-viventium-call-secret') || '';
    const browserCapability =
      req.get('X-VIVENTIUM-CALL-CAPABILITY') || req.get('x-viventium-call-capability') || '';
    const session = await assertCallSessionSecret(callSessionId, secret);
    const browserSession = await assertCallBrowserCapability(callSessionId, browserCapability);
    if (browserSession.callSessionId !== session.callSessionId) {
      const error = new Error('Call browser capability mismatch');
      error.status = 401;
      throw error;
    }
    req.viventiumCallSession = session;
    next();
  } catch (err) {
    const status = err?.status || 401;
    logger.warn('[VIVENTIUM][calls] dispatch_auth_failed', { status });
    logCallRouteError('dispatch auth failed', err);
    res.status(status).json({
      code: 'auth_expired',
      message: 'The call session expired or is unauthorized.',
      retryable: false,
    });
  }
}

router.post('/', requireJwtAuth, async (req, res) => {
  try {
    /* === VIVENTIUM START ===
     * Feature: Voice readiness and privacy guard.
     * Purpose: A disabled install must fail closed before creating any durable call state.
     * === VIVENTIUM END === */
    if (!isEnabled(process.env.VIVENTIUM_VOICE_ENABLED)) {
      logger.info('[VIVENTIUM][calls] call_rejected', { reason: 'voice_not_enabled' });
      return res.status(409).json({
        error: 'voice_not_enabled',
        message: 'Voice is not enabled. Open Viventium setup to enable Voice.',
      });
    }

    const { conversationId, agentId } = req.body ?? {};
    const userId = req.user?.id;
    logger.info('[VIVENTIUM][calls] create requested', {
      hasConversationId: typeof conversationId === 'string' && conversationId !== 'new',
      hasAgentId: typeof agentId === 'string' && agentId.length > 0,
    });

    if (!userId) {
      logger.warn('[VIVENTIUM][calls] call_rejected', { reason: 'unauthorized' });
      return res.status(401).json({
        code: 'auth_expired',
        message: 'Your session expired.',
        retryable: false,
      });
    }
    const normalizedConversationId = typeof conversationId === 'string' ? conversationId : 'new';

    // Prefer the conversation's persisted agent_id when calling from an existing conversation.
    // This avoids frontend state mismatches and guarantees the "brain" matches what the user is viewing.
    let effectiveAgentId = typeof agentId === 'string' ? agentId : '';
    if (normalizedConversationId !== 'new') {
      try {
        const convo = await getConvo(userId, normalizedConversationId);
        if (!convo) {
          logger.info('[VIVENTIUM][calls] call_rejected', { reason: 'conversation_not_found' });
          return res.status(404).json({ error: 'Conversation not found' });
        }
        if (typeof convo.agent_id === 'string' && convo.agent_id.length > 0) {
          effectiveAgentId = convo.agent_id;
        }
      } catch {
        logger.error('[VIVENTIUM][calls] conversation_lookup_failed');
        return res.status(500).json({ error: 'Failed to load conversation' });
      }
    }

    if (typeof effectiveAgentId !== 'string' || effectiveAgentId.length === 0) {
      logger.info('[VIVENTIUM][calls] call_rejected', { reason: 'agent_required' });
      return res.status(400).json({
        code: 'no_route',
        message: 'Voice is not configured for this assistant.',
        retryable: false,
      });
    }

    const preferPublicPlayground = shouldPreferPublicPlaygroundForRequest(req);
    const readiness = await verifyPlaygroundReadiness({ preferPublicPlayground });
    if (!readiness.ready) {
      logger.warn('[VIVENTIUM][calls] call_rejected', {
        reason: readiness.reason,
      });
      return res.status(503).json({
        error: 'voice_runtime_not_ready',
        reason: readiness.reason,
        message: 'Voice is temporarily unavailable. Check Viventium status and try again.',
      });
    }
    /* === VIVENTIUM END === */

    await assertVoiceAgentAccess({ req, agentId: effectiveAgentId });

    const session = await createCallSession({
      userId,
      agentId: effectiveAgentId,
      conversationId: normalizedConversationId,
    });

    const response = buildCallLaunchResponse(session, {
      preferPublicPlayground,
    });

    logger.info('[VIVENTIUM][calls] call_session_created');
    setSensitiveCallResponseHeaders(res);
    res.json(response);
  } catch (e) {
    if (e?.code === 'no_route' && e?.status === 404) {
      logCallRouteError('agent authorization rejected', e);
      return res.status(404).json({
        code: 'no_route',
        message: 'Voice assistant is unavailable.',
        retryable: false,
      });
    }
    if (e?.code === 'no_route') {
      logCallRouteError('create rejected', e);
      return res.status(400).json({
        code: 'no_route',
        message: 'Voice calling requires configured STT and TTS providers.',
        retryable: false,
      });
    }
    logCallRouteError('create failed', e);
    res.status(503).json({
      code: 'gateway_down',
      message: 'Calling is temporarily unavailable.',
      retryable: true,
    });
  }
});

/* === VIVENTIUM START ===
 * Feature: one-time Telegram call launch exchange
 * Purpose: The framework-free playground bootstrap exchanges a single-use Telegram bearer for
 * renewable browser authority. The launch bearer is accepted only in a dedicated header and is
 * never logged, echoed, cached, or accepted in query/body fields.
 * === VIVENTIUM END === */
router.post('/:callSessionId/browser-capability/exchange', async (req, res) => {
  setSensitiveCallResponseHeaders(res);
  try {
    const callSessionId = req.params.callSessionId || '';
    const secret = req.get('X-VIVENTIUM-CALL-SECRET') || '';
    const launchCapability = req.get('X-VIVENTIUM-CALL-LAUNCH') || '';
    const idempotencyCapability = req.get('X-VIVENTIUM-CALL-LAUNCH-IDEMPOTENCY') || '';
    await assertCallSessionSecret(callSessionId, secret);
    const exchanged = await exchangeCallBrowserLaunch(
      callSessionId,
      launchCapability,
      idempotencyCapability,
    );
    return res.json({
      version: 1,
      callSessionId: exchanged.callSessionId,
      browserCapability: exchanged.browserCapability,
      expiresAt: toVoiceCallStateTimestamp(exchanged.expiresAtMs),
    });
  } catch (error) {
    const status = error?.status === 410 ? 410 : error?.status === 401 ? 401 : 503;
    logCallRouteError('browser launch exchange failed', error);
    return res.status(status).json({
      code: status === 503 ? 'gateway_down' : 'auth_expired',
      message:
        status === 503
          ? 'Calling is temporarily unavailable.'
          : 'This call link expired or was already used.',
      retryable: status === 503,
    });
  }
});

/* === VIVENTIUM START ===
 * Feature: work continuation after call-window hangup
 * Purpose: Let the authenticated owner discover only sanitized task snapshots after closing the
 * call surface, so completed work appears in the linked chat without keeping the window open.
 * === VIVENTIUM END === */
router.get('/:callSessionId/tasks', requireJwtAuth, async (req, res) => {
  const session = await getCallSession(req.params.callSessionId);
  if (!session || session.userId !== req.user?.id) {
    return res.status(404).json({
      code: 'auth_expired',
      message: 'Call session not found.',
      retryable: false,
    });
  }
  const beforeCreatedAt =
    typeof req.query?.beforeCreatedAt === 'string' ? req.query.beforeCreatedAt.trim() : '';
  const beforeTaskId =
    typeof req.query?.beforeTaskId === 'string' ? req.query.beforeTaskId.trim() : '';
  if (Boolean(beforeCreatedAt) !== Boolean(beforeTaskId)) {
    return res.status(400).json({
      code: 'unknown',
      message: 'A complete task paging cursor is required.',
      retryable: false,
    });
  }
  let page;
  let continuation;
  try {
    [page, continuation] = await Promise.all([
      listDurableVoiceTaskSnapshots({
        userId: req.user.id,
        callSessionId: session.callSessionId,
        ...(beforeCreatedAt ? { beforeCreatedAt, beforeTaskId } : {}),
        requireDurable: true,
      }),
      getDurableVoiceTaskContinuationState({
        userId: req.user.id,
        callSessionId: session.callSessionId,
        callEndedAtMs: session.status === 'ended' ? session.updatedAt : Date.now(),
      }),
    ]);
  } catch {
    return res.status(503).json({
      code: 'gateway_down',
      message: 'Task history is temporarily unavailable.',
      retryable: true,
    });
  }
  setSensitiveCallResponseHeaders(res);
  return res.json({
    version: 1,
    events: page.events,
    continuation,
    hasMore: page.hasMore,
    ...(page.nextBeforeCreatedAt
      ? {
          nextBeforeCreatedAt: page.nextBeforeCreatedAt,
          nextBeforeTaskId: page.nextBeforeTaskId,
        }
      : {}),
  });
});

router.post('/:callSessionId/end', requireJwtAuth, async (req, res) => {
  const session = await getCallSession(req.params.callSessionId);
  if (!session || session.userId !== req.user?.id) {
    return res.status(404).json({
      code: 'auth_expired',
      message: 'Call session not found.',
      retryable: false,
    });
  }
  const ended = await syncCallSessionState({
    callSessionId: session.callSessionId,
    touch: false,
    status: 'ended',
  });
  if (!ended) {
    return res.status(404).json({
      code: 'auth_expired',
      message: 'Call session not found.',
      retryable: false,
    });
  }
  return res.json({
    version: 1,
    callSessionId: ended.callSessionId,
    status: ended.status,
    updatedAt: toVoiceCallStateTimestamp(ended.updatedAt),
  });
});

/* === VIVENTIUM START ===
 * Feature: Modern playground voice-route persistence
 * Purpose: Let the playground read/write requested STT/TTS route state without exposing the shared secret to the browser.
 * === VIVENTIUM END === */
router.get('/:callSessionId/voice-settings', dispatchAuth, async (req, res) => {
  try {
    const session = req.viventiumCallSession;
    const settings = await getCallSessionVoiceSettings(session.callSessionId, {
      capabilityRequiredProviders: req.config?.endpoints?.agents?.capabilityRequiredProviders || [],
    });

    if (!settings) {
      return res.status(401).json({ error: 'Unknown or expired call session' });
    }

    return res.json(settings);
  } catch (err) {
    const status = err?.status || 500;
    logger.warn('[VIVENTIUM][calls] voice_settings_read_failed', { status });
    return res
      .status(status)
      .json({ error: err?.message || 'Call session voice-settings read failed' });
  }
});

router.post('/:callSessionId/voice-settings', dispatchAuth, async (req, res) => {
  try {
    const session = req.viventiumCallSession;
    const body = req.body ?? {};
    const updated = await updateCallSessionVoiceSettings({
      callSessionId: session.callSessionId,
      touch: body.touch !== false,
      // A per-call browser capability may change only this call. Durable account defaults remain
      // behind the authenticated LibreChat user-settings surface.
      persistToUserDefaults: false,
      requestedVoiceRoute: body.requestedVoiceRoute,
      capabilityRequiredProviders: req.config?.endpoints?.agents?.capabilityRequiredProviders || [],
    });

    if (!updated) {
      return res.status(401).json({ error: 'Unknown or expired call session' });
    }

    return res.json(updated);
  } catch (err) {
    const status = err?.status || 500;
    logger.warn('[VIVENTIUM][calls] voice_settings_update_failed', { status });
    return res
      .status(status)
      .json({ error: err?.message || 'Call session voice-settings update failed' });
  }
});

/* === VIVENTIUM NOTE ===
 * Feature: Dispatch claim/confirm endpoints for idempotent LiveKit dispatch
 * Purpose: Prevent duplicate workers by atomically coordinating dispatch creation.
 * === VIVENTIUM NOTE === */
router.post('/:callSessionId/dispatch/claim', dispatchAuth, async (req, res) => {
  try {
    const session = req.viventiumCallSession;
    if (session.status === 'ended') {
      return res.status(410).json({
        code: 'auth_expired',
        message: 'The call session has ended.',
        retryable: false,
      });
    }
    const { roomName, agentName, reclaimConfirmed } = req.body ?? {};
    if (typeof roomName === 'string' && roomName !== session.roomName) {
      return res.status(409).json({ error: 'Room name mismatch for call session' });
    }
    if (typeof agentName === 'string' && agentName !== session.gatewayAgentName) {
      return res.status(409).json({ error: 'Gateway agent name mismatch for call session' });
    }

    const normalizedRoom = session.roomName;
    const normalizedAgent = session.gatewayAgentName;

    if (!normalizedRoom || !normalizedAgent) {
      return res.status(400).json({ error: 'roomName and agentName are required' });
    }

    const result = await claimDispatch({
      callSessionId: session.callSessionId,
      roomName: normalizedRoom,
      agentName: normalizedAgent,
      reclaimConfirmed: reclaimConfirmed === true,
    });

    return res.json({
      status: result.status,
      callSessionId: session.callSessionId,
      claimId: result.claimId || null,
      dispatchConfirmedAtMs: result.session?.dispatchConfirmedAtMs || null,
    });
  } catch (err) {
    const status = err?.status || 500;
    logger.warn('[VIVENTIUM][calls] dispatch_claim_failed', { status });
    return res.status(status).json({ error: err?.message || 'Dispatch claim failed' });
  }
});

router.post('/:callSessionId/dispatch/confirm', dispatchAuth, async (req, res) => {
  try {
    const session = req.viventiumCallSession;
    if (session.status === 'ended') {
      return res.status(410).json({
        code: 'auth_expired',
        message: 'The call session has ended.',
        retryable: false,
      });
    }
    const { claimId, status, error } = req.body ?? {};

    if (typeof claimId !== 'string' || claimId.length === 0) {
      return res.status(400).json({ error: 'claimId is required' });
    }

    const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : '';
    const success = normalizedStatus === 'created' || normalizedStatus === 'success';

    const updated = await confirmDispatch({
      callSessionId: session.callSessionId,
      claimId,
      success,
      error,
    });

    if (!updated) {
      return res.status(409).json({ error: 'Dispatch claim not found or expired' });
    }

    return res.json({
      status: success ? 'confirmed' : 'released',
      callSessionId: updated.callSessionId,
      dispatchConfirmedAtMs: updated.dispatchConfirmedAtMs || null,
    });
  } catch (err) {
    const status = err?.status || 500;
    logger.warn('[VIVENTIUM][calls] dispatch_confirm_failed', { status });
    return res.status(status).json({ error: err?.message || 'Dispatch confirm failed' });
  }
});

router.get('/:callSessionId/dispatch/status', dispatchAuth, async (req, res) => {
  try {
    const claimId = typeof req.query?.claimId === 'string' ? req.query.claimId.trim() : '';
    if (!claimId || claimId.length > 160) {
      return res.status(400).json({ error: 'claimId is required' });
    }

    const status = await getDispatchStatus({
      callSessionId: req.viventiumCallSession.callSessionId,
      claimId,
    });
    return res.json(status);
  } catch (err) {
    const status = err?.status || 500;
    logger.warn('[VIVENTIUM][calls] dispatch_status_failed', { status });
    return res.status(status).json({ error: err?.message || 'Dispatch status failed' });
  }
});

router.get('/:callSessionId/state', dispatchAuth, async (req, res) => {
  const session = await heartbeatCallSession({
    callSessionId: req.viventiumCallSession.callSessionId,
    currentSession: req.viventiumCallSession,
  });
  if (!session) {
    return res.status(401).json({
      code: 'auth_expired',
      message: 'The call session expired.',
      retryable: false,
    });
  }
  return res.json({
    version: 1,
    callSessionId: session.callSessionId,
    roomName: session.roomName,
    gatewayAgentName: session.gatewayAgentName,
    ownerParticipantIdentity: session.ownerParticipantIdentity,
    requestedVoiceRoute: session.requestedVoiceRoute,
    expiresAtMs: session.expiresAtMs || null,
    mode:
      session.mode ||
      (session.listenOnlyModeEnabled ? 'listen_only' : session.wingModeEnabled ? 'wing' : 'call'),
    status: session.status || 'created',
    revision: Number(session.revision) || 0,
    updatedAt: toVoiceCallStateTimestamp(session.updatedAt),
    ...(session.error ? { error: session.error } : {}),
    wingModeEnabled: session.wingModeEnabled === true,
    shadowModeEnabled: session.shadowModeEnabled === true,
    listenOnlyModeEnabled: session.listenOnlyModeEnabled === true,
  });
});

router.post('/:callSessionId/state', dispatchAuth, async (req, res) => {
  try {
    const session = req.viventiumCallSession;
    const body = req.body ?? {};
    if (body.mode !== undefined && !['call', 'wing', 'listen_only'].includes(body.mode)) {
      return res.status(400).json({ error: 'Invalid call mode' });
    }
    if (
      body.status !== undefined &&
      ![
        'created',
        'connecting',
        'listening',
        'speaking',
        'working',
        'needs_input',
        'degraded',
        'failed',
        'ended',
      ].includes(body.status)
    ) {
      return res.status(400).json({ error: 'Invalid call status' });
    }
    const updated = await syncCallSessionState({
      callSessionId: session.callSessionId,
      touch: body.touch !== false,
      status: body.status,
      mode: body.mode,
      wingModeEnabled: typeof body.wingModeEnabled === 'boolean' ? body.wingModeEnabled : undefined,
      shadowModeEnabled:
        typeof body.shadowModeEnabled === 'boolean' ? body.shadowModeEnabled : undefined,
      listenOnlyModeEnabled:
        typeof body.listenOnlyModeEnabled === 'boolean' ? body.listenOnlyModeEnabled : undefined,
    });

    if (!updated) {
      return res.status(401).json({ error: 'Unknown or expired call session' });
    }

    return res.json({
      version: 1,
      callSessionId: updated.callSessionId,
      roomName: updated.roomName,
      gatewayAgentName: updated.gatewayAgentName,
      ownerParticipantIdentity: updated.ownerParticipantIdentity,
      requestedVoiceRoute: updated.requestedVoiceRoute,
      expiresAtMs: updated.expiresAtMs || null,
      mode: updated.mode,
      status: updated.status,
      revision: Number(updated.revision) || 0,
      updatedAt: toVoiceCallStateTimestamp(updated.updatedAt),
      ...(updated.error ? { error: updated.error } : {}),
      wingModeEnabled: updated.wingModeEnabled === true,
      shadowModeEnabled: updated.shadowModeEnabled === true,
      listenOnlyModeEnabled: updated.listenOnlyModeEnabled === true,
    });
  } catch (err) {
    const status = err?.status || 500;
    logger.warn('[VIVENTIUM][calls] call_session_state_update_failed', { status });
    return res.status(status).json({ error: err?.message || 'Call session state update failed' });
  }
});

module.exports = router;
