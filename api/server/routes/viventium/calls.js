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
    console.error('[VIVENTIUM][calls] Dispatch auth failed:', err);
    res.status(status).json({ error: err?.message || 'Unauthorized' });
  }
}

router.post('/', requireJwtAuth, async (req, res) => {
  console.log('[VIVENTIUM][calls] POST /api/viventium/calls', {
    body: req.body,
    userId: req.user?.id,
  });

  try {
    const { conversationId, agentId, requestedVoiceRoute } = req.body ?? {};
    const userId = req.user?.id;

    if (!userId) {
      console.log('[VIVENTIUM][calls] Unauthorized - no userId');
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
          console.log('[VIVENTIUM][calls] Conversation not found', {
            normalizedConversationId,
            userId,
          });
          return res.status(404).json({ error: 'Conversation not found' });
        }
        if (typeof convo.agent_id === 'string' && convo.agent_id.length > 0) {
          console.log('[VIVENTIUM][calls] Using conversation agent_id', {
            requestedAgentId: effectiveAgentId,
            conversationAgentId: convo.agent_id,
          });
          effectiveAgentId = convo.agent_id;
        }
      } catch (e) {
        console.error('[VIVENTIUM][calls] Failed to load conversation for agent_id', e);
        return res.status(500).json({ error: 'Failed to load conversation' });
      }
    }
    console.log('[VIVENTIUM][calls] Selected agent for voice call', {
      effectiveAgentId,
      conversationId: normalizedConversationId,
    });

    if (typeof effectiveAgentId !== 'string' || effectiveAgentId.length === 0) {
      console.log('[VIVENTIUM][calls] Bad request - no agentId');
      return res.status(400).json({ error: 'agentId is required' });
    }

    const session = await createCallSession({
      userId,
      agentId: effectiveAgentId,
      conversationId: normalizedConversationId,
      requestedVoiceRoute,
    });

    console.log('[VIVENTIUM][calls] Session created:', session);

    const response = buildCallLaunchResponse(session, {
      preferPublicPlayground: shouldPreferPublicPlaygroundForRequest(req),
    });

    console.log('[VIVENTIUM][calls] Response:', response);
    res.json(response);
  } catch (e) {
    console.error('[VIVENTIUM][calls] error', e);
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
    console.error('[VIVENTIUM][calls] Call session voice-settings read failed:', err);
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
    console.error('[VIVENTIUM][calls] Call session voice-settings update failed:', err);
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
    console.error('[VIVENTIUM][calls] Dispatch claim failed:', err);
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
    console.error('[VIVENTIUM][calls] Dispatch confirm failed:', err);
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
    });
  } catch (err) {
    const status = err?.status || 500;
    console.error('[VIVENTIUM][calls] Call session state update failed:', err);
    return res.status(status).json({ error: err?.message || 'Call session state update failed' });
  }
});

module.exports = router;
