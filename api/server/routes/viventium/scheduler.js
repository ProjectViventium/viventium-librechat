/* === VIVENTIUM START ===
 * Feature: Scheduling Cortex - Scheduler Gateway Endpoint
 *
 * Purpose:
 * - Allow the Scheduling MCP server to trigger the Agents pipeline without user JWTs.
 * - Authenticate via shared secret and userId, then impersonate the user.
 *
 * Endpoint:
 * - POST /api/viventium/scheduler/chat -> starts Agents run; returns { streamId, conversationId }
 *
 * Added: 2026-01-16
 * === VIVENTIUM END === */

const express = require('express');
const crypto = require('crypto');
const { GenerationJobManager } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { SystemRoles } = require('librechat-data-provider');
const { configMiddleware, validateConvoAccess, buildEndpointOption } = require('~/server/middleware');
const { initializeClient } = require('~/server/services/Endpoints/agents');
const addTitle = require('~/server/services/Endpoints/agents/title');
const AgentController = require('~/server/controllers/agents/request');
const { getUserById, getMessages, getConvo } = require('~/models');
/* === VIVENTIUM NOTE ===
 * Feature: Scheduler <-> Telegram mapping helper import.
 * === VIVENTIUM NOTE === */
const { resolveTelegramMappingByUserId } = require('~/server/services/TelegramLinkService');
/* === VIVENTIUM NOTE ===
 * Feature: Sidebar parity for gateway-created conversations (title + icon).
 * Purpose: Match web UI behavior for new conversations created via scheduler gateway.
 * === VIVENTIUM NOTE === */
const {
  ensureGatewaySpec,
  normalizeGatewayParentMessageId,
} = require('~/server/services/viventium/gatewayConvoDefaults');
const {
  resolveReusableConversationState,
} = require('~/server/services/viventium/conversationThreading');
const {
  extractAttachments,
  extractFinalError,
  extractFinalResponseText,
  extractResponseMessageId,
  extractTextDeltas,
} = require('~/server/services/viventium/gateway/streamExtractors');
const { getCortexMessageState } = require('~/server/services/viventium/cortexMessageState');

const router = express.Router();
const SCHEDULER_SECRET_HEADER = 'x-viventium-scheduler-secret';

function getSchedulerSecret() {
  return process.env.VIVENTIUM_SCHEDULER_SECRET || '';
}

function fingerprintSecret(secret = '') {
  if (!secret) {
    return 'unset';
  }
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

function createSchedulerAuthError(message, status, reason) {
  const err = new Error(message);
  err.status = status;
  err.reason = reason;
  return err;
}

function writeSseEvent(res, eventName, payload) {
  if (res.writableEnded) {
    return;
  }
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
  if (typeof res.flush === 'function') {
    res.flush();
  }
}

function getSchedulerUserId(req = {}) {
  const body = req.body ?? {};
  const query = req.query ?? {};
  const params = req.params ?? {};
  const candidates = [
    body.userId,
    body.user_id,
    query.userId,
    query.user_id,
    params.userId,
    params.user_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
}

async function normalizeSchedulerConversationId({ conversationId, userId }) {
  if (!conversationId || conversationId === 'new') {
    return 'new';
  }

  try {
    const convo = await getConvo(userId, conversationId);
    if (!convo) {
      logger.warn(
        `[VIVENTIUM][scheduler] Resetting missing scheduled conversationId=${conversationId} userId=${userId}`,
      );
      return 'new';
    }
    if (convo.endpoint !== 'agents') {
      logger.warn(
        `[VIVENTIUM][scheduler] Resetting non-agent scheduled conversationId=${conversationId} endpoint=${convo.endpoint || 'unknown'} userId=${userId}`,
      );
      return 'new';
    }
    return conversationId;
  } catch (err) {
    logger.warn(
      `[VIVENTIUM][scheduler] Failed to validate conversationId=${conversationId}: ${err?.message}`,
    );
    return 'new';
  }
}

function resolveLingerMs(req) {
  const rawLingerMs =
    typeof req.query?.lingerMs === 'string' ? Number.parseInt(req.query.lingerMs, 10) : NaN;
  if (Number.isFinite(rawLingerMs) && rawLingerMs > 0) {
    return rawLingerMs;
  }
  return req.query?.linger === 'true' ? 8000 : 0;
}

async function resolveAgentId({ req, conversationId, requestedAgentId, userId }) {
  if (conversationId && conversationId !== 'new') {
    try {
      const convo = await getConvo(userId, conversationId);
      if (convo?.agent_id) {
        return convo.agent_id;
      }
    } catch (err) {
      logger.warn('[VIVENTIUM][scheduler] Failed to load conversation agent_id:', err?.message);
    }
  }

  if (typeof requestedAgentId === 'string' && requestedAgentId.length > 0) {
    return requestedAgentId;
  }

  const config = req.config || {};
  return (
    config.interface?.defaultAgent ||
    config.endpoints?.agents?.defaultId ||
    process.env.VIVENTIUM_MAIN_AGENT_ID ||
    ''
  );
}

async function schedulerAuth(req, res, next) {
  const secret = req.get(SCHEDULER_SECRET_HEADER) || req.get('X-VIVENTIUM-SCHEDULER-SECRET') || '';
  const expected = getSchedulerSecret();
  const userId = getSchedulerUserId(req);
  try {
    if (!expected) {
      throw createSchedulerAuthError(
        'VIVENTIUM_SCHEDULER_SECRET is not set',
        500,
        'missing_scheduler_secret',
      );
    }
    if (!secret || secret !== expected) {
      throw createSchedulerAuthError(
        'Unauthorized scheduler gateway',
        401,
        'secret_mismatch',
      );
    }

    if (!userId) {
      throw createSchedulerAuthError('Missing userId', 400, 'missing_user_id');
    }

    const user = await getUserById(userId);
    if (!user) {
      throw createSchedulerAuthError('User not found', 404, 'user_not_found');
    }

    user.id = user._id.toString();
    if (!user.role) {
      user.role = SystemRoles.USER;
    }

    req.user = user;
    req.viventiumSchedulerAuth = {
      reason: 'ok',
      userId,
      providedSecretFingerprint: fingerprintSecret(secret),
      expectedSecretFingerprint: fingerprintSecret(expected),
    };
    next();
  } catch (err) {
    const status = err?.status || 401;
    const reason = err?.reason || 'unauthorized';
    logger.error('[VIVENTIUM][schedulerAuth] Auth failed', {
      status,
      reason,
      userId,
      route: req.originalUrl || req.url || '',
      providedSecretFingerprint: fingerprintSecret(secret),
      expectedSecretFingerprint: fingerprintSecret(expected),
      error: err?.message || 'Unauthorized',
    });
    return res.status(status).json({ error: err?.message || 'Unauthorized', reason });
  }
}

router.post('/chat', schedulerAuth, configMiddleware, async (req, _res, next) => {
  const incoming = req.body ?? {};
  const text = typeof incoming.text === 'string' ? incoming.text : '';
  const requestedConversationId =
    typeof incoming.conversationId === 'string' ? incoming.conversationId : 'new';
  const requestedAgentId =
    typeof incoming.agentId === 'string'
      ? incoming.agentId
      : typeof incoming.agent_id === 'string'
        ? incoming.agent_id
        : '';
  const scheduleId = typeof incoming.scheduleId === 'string' ? incoming.scheduleId : '';
  const streamId = `scheduler-${crypto.randomUUID()}`;
  const validatedConversationId = await normalizeSchedulerConversationId({
    conversationId: requestedConversationId,
    userId: req.user?.id,
  });
  const conversationState = await resolveReusableConversationState({
    conversationId: validatedConversationId,
    userId: req.user?.id,
    surface: 'scheduler',
  });
  const conversationId = conversationState.conversationId;
  let parentMessageId = conversationState.parentMessageId;

  const agentId = await resolveAgentId({
    req,
    conversationId,
    requestedAgentId,
    userId: req.user?.id,
  });

  if (!agentId) {
    return _res.status(400).json({ error: 'agentId is required' });
  }

  /* === VIVENTIUM NOTE ===
   * Feature: Sidebar parity for gateway-created conversations (title + icon).
   * === VIVENTIUM NOTE === */
  parentMessageId = normalizeGatewayParentMessageId({ conversationId, parentMessageId });
  const resolvedSpec = ensureGatewaySpec({
    req,
    existingSpec: incoming?.spec,
    agentId,
  });

  req.body = {
    ...incoming,
    text,
    endpoint: 'agents',
    endpointType: 'agents',
    conversationId,
    parentMessageId,
    agent_id: agentId,
    streamId,
    scheduleId,
  };
  if (resolvedSpec) {
    req.body.spec = resolvedSpec;
  }
  /* === VIVENTIUM NOTE ===
   * Keep scheduled runs aligned with normal LibreChat prompts by avoiding a custom surface
   * unless the caller explicitly set one.
   * === VIVENTIUM NOTE === */
  if (typeof incoming.viventiumSurface === 'string' && incoming.viventiumSurface.trim()) {
    req.body.viventiumSurface = incoming.viventiumSurface;
  }

  logger.info(
    `[VIVENTIUM][scheduler/chat] Request: conversationId=${conversationId} requestedConversationId=${requestedConversationId} parentMessageId=${parentMessageId || ''} agentId=${agentId} streamId=${streamId} scheduleId=${scheduleId || ''} userId=${req.user?.id || ''}`,
  );

  next();
}, validateConvoAccess, buildEndpointOption, async (req, res, next) => {
  return AgentController(req, res, next, initializeClient, addTitle);
});

/* === VIVENTIUM NOTE ===
 * Feature: Scheduler -> Telegram mapping resolver
 *
 * Endpoint:
 * - POST /api/viventium/scheduler/telegram/resolve -> { telegram_user_id, telegram_chat_id }
 *
 * Notes:
 * - Authenticated with scheduler secret.
 * - Uses libreChat user id from schedulerAuth.
 * === VIVENTIUM NOTE === */
router.post('/telegram/resolve', schedulerAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }

    const mapping = await resolveTelegramMappingByUserId({ libreChatUserId: userId });
    const telegramUserId = mapping?.telegramUserId;
    if (!telegramUserId) {
      return res.status(404).json({ error: 'Telegram mapping not found' });
    }

    return res.json({
      telegram_user_id: telegramUserId,
      telegram_chat_id: telegramUserId,
      linked: true,
      voice_preferences: {
        always_voice_response: Boolean(mapping?.alwaysVoiceResponse ?? false),
        voice_responses_enabled: Boolean(mapping?.voiceResponsesEnabled ?? true),
      },
    });
  } catch (err) {
    logger.error('[VIVENTIUM][scheduler/telegram] Failed to resolve mapping:', err);
    return res.status(500).json({ error: 'Failed to resolve Telegram mapping' });
  }
});

/* === VIVENTIUM START ===
 * Feature: Scheduler stream + cortex inspection
 *
 * Purpose:
 * - Let the scheduling cortex observe the canonical scheduled agent run without starting a
 *   second Telegram agent execution.
 * - Preserve the same raw stream/cortex visibility patterns already used by the gateway and
 *   Telegram routes.
 *
 * Added: 2026-03-06
 * === VIVENTIUM END === */
router.get('/stream/:streamId', schedulerAuth, async (req, res) => {
  const { streamId } = req.params;
  const userId = req.user?.id;
  const isResume = req.query.resume === 'true';
  const lingerMs = resolveLingerMs(req);
  let lingerTimer = null;

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

  const endStream = () => {
    if (!res.writableEnded) {
      res.end();
    }
  };

  const scheduleEnd = () => {
    if (lingerMs <= 0) {
      endStream();
      return;
    }
    if (lingerTimer) {
      return;
    }
    lingerTimer = setTimeout(() => {
      lingerTimer = null;
      endStream();
    }, lingerMs);
  };

  if (isResume) {
    const resumeState = await GenerationJobManager.getResumeState(streamId);
    if (resumeState && !res.writableEnded) {
      writeSseEvent(res, 'message', { sync: true, resumeState });
    }
  }

  const result = await GenerationJobManager.subscribe(
    streamId,
    (event) => {
      if (!res.writableEnded) {
        writeSseEvent(res, 'message', event);
      }
    },
    (event) => {
      if (!res.writableEnded) {
        writeSseEvent(res, 'message', event);
        scheduleEnd();
      }
    },
    (error) => {
      if (!res.writableEnded) {
        writeSseEvent(res, 'error', { error: String(error || 'Stream error') });
        endStream();
      }
    },
  );

  if (!result) {
    return res.status(404).json({ error: 'Failed to subscribe to stream' });
  }

  req.on('close', () => {
    if (lingerTimer) {
      clearTimeout(lingerTimer);
      lingerTimer = null;
    }
    result.unsubscribe();
  });
});

router.get('/events/:streamId', schedulerAuth, async (req, res) => {
  const { streamId } = req.params;
  const userId = req.user?.id;
  const isResume = req.query.resume === 'true';

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

  const sentAttachmentKeys = new Set();
  const rememberAttachment = (attachment) => {
    const key = attachment?.file_id || attachment?.filepath || attachment?.filename || '';
    if (!key) {
      return false;
    }
    if (sentAttachmentKeys.has(key)) {
      return true;
    }
    sentAttachmentKeys.add(key);
    return false;
  };

  if (isResume) {
    const resumeState = await GenerationJobManager.getResumeState(streamId);
    if (resumeState && !res.writableEnded) {
      writeSseEvent(res, 'message', { type: 'sync', resumeState });
    }
  }

  const result = await GenerationJobManager.subscribe(
    streamId,
    (event) => {
      if (res.writableEnded) {
        return;
      }

      const attachments = extractAttachments(event);
      for (const attachment of attachments) {
        if (rememberAttachment(attachment)) {
          continue;
        }
        writeSseEvent(res, 'attachment', attachment);
      }

      const deltas = extractTextDeltas(event);
      for (const delta of deltas) {
        if (delta) {
          writeSseEvent(res, 'message', { type: 'delta', text: delta });
        }
      }

      if (event?.event === 'on_cortex_update' || event?.event === 'on_cortex_followup') {
        writeSseEvent(res, 'message', {
          type: 'status',
          event: event.event,
          data: event.data,
        });
      }
    },
    (event) => {
      if (res.writableEnded) {
        return;
      }

      const finalError = extractFinalError(event);
      if (finalError) {
        writeSseEvent(res, 'error', { error: finalError });
      }

      const finalText = extractFinalResponseText(event);
      const responseMessageId = extractResponseMessageId(event);

      const attachments = extractAttachments(event);
      for (const attachment of attachments) {
        if (rememberAttachment(attachment)) {
          continue;
        }
        writeSseEvent(res, 'attachment', attachment);
      }

      if (finalText) {
        writeSseEvent(res, 'message', {
          type: 'final',
          text: finalText,
          messageId: responseMessageId,
        });
      }

      writeSseEvent(res, 'done', {
        final: true,
        messageId: responseMessageId,
      });
      res.end();
    },
    (error) => {
      if (!res.writableEnded) {
        writeSseEvent(res, 'error', { error: String(error || 'Stream error') });
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

router.get('/cortex/:messageId', schedulerAuth, async (req, res) => {
  const userId = req.user?.id;
  const messageId = req.params?.messageId;
  const conversationId =
    typeof req.query?.conversationId === 'string' ? req.query.conversationId : '';
  const scheduleId = typeof req.query?.scheduleId === 'string' ? req.query.scheduleId : '';

  if (typeof userId !== 'string' || userId.length === 0) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (typeof messageId !== 'string' || messageId.length === 0) {
    return res.status(400).json({ error: 'messageId is required' });
  }

  try {
    const state = await getCortexMessageState({
      userId,
      messageId,
      conversationId,
      scheduleId,
    });
    if (!state) {
      return res.status(404).json({ error: 'Message not found' });
    }

    return res.json(state);
  } catch (err) {
    logger.error('[VIVENTIUM][scheduler/cortex] Failed to load cortex data:', err);
    return res.status(500).json({ error: 'Failed to load cortex data' });
  }
});

module.exports = router;

/* === VIVENTIUM NOTE === */
