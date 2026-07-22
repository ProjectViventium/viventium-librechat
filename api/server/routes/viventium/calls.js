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
  assertCallSessionSecret,
  claimDispatch,
  confirmDispatch,
  getCallSessionVoiceSettings,
  syncCallSessionState,
  updateCallSessionVoiceSettings,
} = require('~/server/services/viventium/CallSessionService');
const {
  buildCallLaunchResponse,
  shouldPreferPublicPlaygroundForRequest,
  verifyPlaygroundReadiness,
} = require('~/server/services/viventium/callLaunch');
const { getConvo } = require('~/models');

const router = express.Router();

/* === VIVENTIUM NOTE ===
 * Feature: Dispatch guard auth (call-session secret)
 * Purpose: Allow server-to-server dispatch claims without user JWTs.
 * === VIVENTIUM NOTE === */
async function dispatchAuth(req, res, next) {
  try {
    const callSessionId = req.params.callSessionId || '';
    const secret = req.get('X-VIVENTIUM-CALL-SECRET') || req.get('x-viventium-call-secret') || '';
    const session = await assertCallSessionSecret(callSessionId, secret);
    req.viventiumCallSession = session;
    next();
  } catch (err) {
    const status = err?.status || 401;
    logger.warn('[VIVENTIUM][calls] dispatch_auth_failed', { status });
    res.status(status).json({ error: err?.message || 'Unauthorized' });
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

    const { conversationId, agentId, requestedVoiceRoute } = req.body ?? {};
    const userId = req.user?.id;

    if (!userId) {
      logger.warn('[VIVENTIUM][calls] call_rejected', { reason: 'unauthorized' });
      return res.status(401).json({ error: 'Unauthorized' });
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
        error: 'voice_agent_required',
        message: 'Choose an assistant before starting Voice.',
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

    const session = await createCallSession({
      userId,
      agentId: effectiveAgentId,
      conversationId: normalizedConversationId,
      requestedVoiceRoute,
    });

    const response = buildCallLaunchResponse(session, {
      preferPublicPlayground,
    });

    logger.info('[VIVENTIUM][calls] call_session_created');
    res.json(response);
  } catch {
    logger.error('[VIVENTIUM][calls] call_session_create_failed');
    res.status(500).json({ error: 'Failed to create call session' });
  }
});

/* === VIVENTIUM START ===
 * Feature: Modern playground voice-route persistence
 * Purpose: Let the playground read/write requested STT/TTS route state without exposing the shared secret to the browser.
 * === VIVENTIUM END === */
router.get('/:callSessionId/voice-settings', dispatchAuth, async (req, res) => {
  try {
    const session = req.viventiumCallSession;
    const settings = await getCallSessionVoiceSettings(session.callSessionId);

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
      persistToUserDefaults: body.persistToUserDefaults !== false,
      requestedVoiceRoute: body.requestedVoiceRoute,
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
    const { roomName, agentName, reclaimConfirmed } = req.body ?? {};

    const normalizedRoom = typeof roomName === 'string' ? roomName : session.roomName;
    const normalizedAgent = typeof agentName === 'string' ? agentName : '';

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

router.get('/:callSessionId/state', dispatchAuth, async (req, res) => {
  const session = req.viventiumCallSession;
  return res.json({
    callSessionId: session.callSessionId,
    roomName: session.roomName,
    expiresAtMs: session.expiresAtMs || null,
    wingModeEnabled: session.wingModeEnabled === true,
    shadowModeEnabled: session.shadowModeEnabled === true,
    listenOnlyModeEnabled: session.listenOnlyModeEnabled === true,
  });
});

router.post('/:callSessionId/state', dispatchAuth, async (req, res) => {
  try {
    const session = req.viventiumCallSession;
    const body = req.body ?? {};
    const updated = await syncCallSessionState({
      callSessionId: session.callSessionId,
      touch: body.touch !== false,
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
      callSessionId: updated.callSessionId,
      roomName: updated.roomName,
      expiresAtMs: updated.expiresAtMs || null,
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
