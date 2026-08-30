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
const mongoose = require('mongoose');
const { GenerationJobManager } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { SystemRoles } = require('librechat-data-provider');
const {
  configMiddleware,
  validateConvoAccess,
  buildEndpointOption,
} = require('~/server/middleware');
const { initializeClient } = require('~/server/services/Endpoints/agents');
const addTitle = require('~/server/services/Endpoints/agents/title');
const AgentController = require('~/server/controllers/agents/request');
const { getUserById, getConvo } = require('~/models');
const { Message, Conversation } = require('~/db/models');
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
const {
  normalizeScheduledAgentExecution,
} = require('~/server/services/viventium/scheduledAgentOverride');
const {
  createSchedulerInteractionContext,
  setTrustedInteractionContext,
} = require('~/server/services/viventium/interactionContext');
const {
  buildScheduledGlassHiveCapabilityBundle,
  revokeScheduledGlassHiveCapabilityGrant,
} = require('~/server/services/viventium/GlassHiveCapabilityBootstrapService');

const router = express.Router();
const SCHEDULER_SECRET_HEADER = 'x-viventium-scheduler-secret';
const SCHEDULER_DISPATCH_COLLECTION = 'viventium_scheduler_dispatch_intents';
const SCHEDULER_FALLBACK_TITLE_SOURCE = 'Scheduled Background Processing';

/* === VIVENTIUM START ===
 * Feature: Public-safe scheduler conversation titles.
 * Purpose: The model execution text contains a private scheduler envelope. Title generation must
 * receive the separately couriered task source, never that internal control prompt.
 * === VIVENTIUM END === */
function schedulerTitleSource(value) {
  const source = typeof value === 'string' ? value.trim() : '';
  return source ? source.slice(0, 2000) : SCHEDULER_FALLBACK_TITLE_SOURCE;
}

function addSchedulerTitle(req, args) {
  return addTitle(req, {
    ...args,
    text: req.viventiumSchedulerTitleSource || SCHEDULER_FALLBACK_TITLE_SOURCE,
  });
}

function normalizeSchedulerIdempotencyKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) {
    return '';
  }
  if (key.length > 512) {
    throw new Error('Scheduler idempotency key is too long');
  }
  return key;
}

function schedulerDispatchDocumentId(userId, idempotencyKey) {
  return crypto.createHash('sha256').update(`${userId}\0${idempotencyKey}`).digest('hex');
}

function schedulerDispatchCollection() {
  return mongoose.connection.collection(SCHEDULER_DISPATCH_COLLECTION);
}

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
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(schedulerSafeEvent(payload))}\n\n`);
  if (typeof res.flush === 'function') {
    res.flush();
  }
}

/* === VIVENTIUM START ===
 * Feature: Private scheduled-provider failure reporting.
 * Purpose: Preserve typed actionable failure truth without exposing upstream bodies or credentials.
 * === VIVENTIUM END === */
const SCHEDULER_PUBLIC_FAILURES = Object.freeze({
  provider_quota_exhausted: 'The selected model provider quota is exhausted.',
  provider_rate_limited: 'The model provider rate-limited this request.',
  provider_unauthorized: 'The model provider credentials were rejected.',
  provider_access_denied: 'The model provider denied access to this request.',
  provider_auth_missing: 'The configured model provider authentication is unavailable.',
  provider_response_failed: 'The model provider could not complete this request.',
  provider_response_deadline_exceeded: 'The model provider response exceeded its deadline.',
  provider_temporarily_unavailable: 'The model provider is temporarily unavailable.',
  completion_error: 'The scheduled model response could not be completed.',
});

const SCHEDULER_PRIVATE_EVENT_FIELDS = new Set([
  'access_token',
  'accesstoken',
  'api_key',
  'api-key',
  'apikey',
  'authorization',
  'bearer_token',
  'bearertoken',
  'client_secret',
  'clientsecret',
  'cookie',
  'credentials',
  'id_token',
  'idtoken',
  'password',
  'private_key',
  'privatekey',
  'proxy-authorization',
  'refresh_token',
  'refreshtoken',
  'secret',
  'session_token',
  'sessiontoken',
  'set-cookie',
  'token',
  'x-api-key',
  'x-auth-token',
]);

const SCHEDULER_FAILURE_EVENT_FIELDS = new Set([
  'error',
  'failure',
  'last_error',
  'lasterror',
  'provider_error',
  'provider_failure',
  'providererror',
  'providerfailure',
]);

function schedulerSafeFailure(error) {
  const details = error && typeof error === 'object' ? error : {};
  const declaredClass = [
    details.error_class,
    details.failure_class,
    details.code,
    details.cause?.errorClass,
  ].find((value) => typeof value === 'string' && Object.hasOwn(SCHEDULER_PUBLIC_FAILURES, value));
  const status = Number(details.status ?? details.statusCode);
  const statusClass =
    status === 401
      ? 'provider_unauthorized'
      : status === 403
        ? 'provider_access_denied'
        : status === 429
          ? 'provider_rate_limited'
          : '';
  const errorClass = declaredClass || statusClass || 'completion_error';
  return {
    error: SCHEDULER_PUBLIC_FAILURES[errorClass],
    error_class: errorClass,
  };
}

function schedulerSafeEvent(event) {
  if (Array.isArray(event)) {
    return event.map(schedulerSafeEvent);
  }
  if (!event || typeof event !== 'object') {
    return event;
  }

  const isPublicFailure =
    typeof event.error === 'string' &&
    Object.hasOwn(SCHEDULER_PUBLIC_FAILURES, event.error_class) &&
    event.error === SCHEDULER_PUBLIC_FAILURES[event.error_class];
  if (event.type === 'error' || isPublicFailure) {
    return {
      ...(event.type === 'error' ? { type: 'error' } : {}),
      ...schedulerSafeFailure(event),
      ...(typeof event.failure_retryable === 'boolean'
        ? { failure_retryable: event.failure_retryable }
        : {}),
      ...(Number.isInteger(event.failure_contract_version)
        ? { failure_contract_version: event.failure_contract_version }
        : {}),
    };
  }

  const safeEvent = {};
  for (const [field, value] of Object.entries(event)) {
    const normalizedField = field.toLowerCase();
    if (SCHEDULER_PRIVATE_EVENT_FIELDS.has(normalizedField)) {
      continue;
    }
    if (SCHEDULER_FAILURE_EVENT_FIELDS.has(normalizedField) && value) {
      safeEvent[field] = schedulerSafeFailure(
        typeof value === 'object' ? value : { ...event, error: value },
      );
      continue;
    }
    safeEvent[field] = schedulerSafeEvent(value);
  }
  return safeEvent;
}

function schedulerFinalFailure(event) {
  const errorPart = Array.isArray(event?.responseMessage?.content)
    ? event.responseMessage.content.find((part) => part?.type === 'error')
    : null;
  const error = extractFinalError(event) || String(errorPart?.error || '').trim();
  if (!error) {
    return null;
  }

  const publicFailure = schedulerSafeFailure({
    error_class:
      errorPart?.error_class || event?.error?.error_class || event?.error?.failure_class || '',
    status: event?.error?.status,
  });
  return {
    ...publicFailure,
    ...(typeof errorPart?.failure_retryable === 'boolean'
      ? { failure_retryable: errorPart.failure_retryable }
      : {}),
    ...(Number.isInteger(errorPart?.failure_contract_version)
      ? { failure_contract_version: errorPart.failure_contract_version }
      : {}),
  };
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
      throw createSchedulerAuthError('Unauthorized scheduler gateway', 401, 'secret_mismatch');
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

/* === VIVENTIUM START ===
 * Feature: Scheduling Cortex fire-time GlassHive capability authorization.
 * Purpose: Revalidate the current user policy/consent immediately before dispatch and revoke the
 * deterministic run grant on terminal callbacks. The scheduler never stores provider credentials.
 */
function scheduledCapabilityInput(req) {
  const body = req.body || {};
  let requiredServerNames = [];
  if (Array.isArray(body.requiredServerNames)) {
    requiredServerNames = body.requiredServerNames;
  } else if (Array.isArray(body.required_server_names)) {
    requiredServerNames = body.required_server_names;
  }
  const input = {
    user: req.user,
    scheduleId: body.scheduleId ?? body.schedule_id,
    scheduledRunId: body.scheduledRunId ?? body.scheduled_run_id,
    executionMode: body.executionMode ?? body.execution_mode,
    requiredServerNames,
  };
  const grantId = body.grantId ?? body.grant_id;
  const renewableUntil = body.renewableUntil ?? body.renewable_until;
  if (grantId != null) input.grantId = grantId;
  if (renewableUntil != null) input.renewableUntil = renewableUntil;
  return input;
}

function scheduledCapabilityError(res, error) {
  const status = Number(error?.status);
  const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  const reason = String(error?.code || 'scheduled_capability_failed').replace(
    /[^a-z0-9_.:-]/gi,
    '',
  );
  const serverNames = Array.isArray(error?.serverNames)
    ? error.serverNames
        .map((value) => String(value || '').trim())
        .filter((value) => /^[A-Za-z0-9_.:-]{1,120}$/.test(value))
        .sort()
    : [];
  logger.warn('[VIVENTIUM][scheduler] Scheduled GlassHive capability authorization failed', {
    reason,
    status: safeStatus,
    serverNames,
  });
  return res.status(safeStatus).json({
    error: 'Scheduled GlassHive capability authorization failed',
    reason,
    failure_class: reason,
    failure_retryable: safeStatus >= 500,
    action_required: reason === 'connected_account_action_required',
    server_names: serverNames,
  });
}

router.post('/glasshive-capabilities/grant', schedulerAuth, async (req, res) => {
  try {
    return res.json(await buildScheduledGlassHiveCapabilityBundle(scheduledCapabilityInput(req)));
  } catch (error) {
    return scheduledCapabilityError(res, error);
  }
});

router.post('/glasshive-capabilities/revoke', schedulerAuth, async (req, res) => {
  try {
    const input = scheduledCapabilityInput(req);
    delete input.requiredServerNames;
    const result = await revokeScheduledGlassHiveCapabilityGrant(input);
    return res.json({ revoked: result.revoked === true, grant_id: result.grantId });
  } catch (error) {
    return scheduledCapabilityError(res, error);
  }
});
/* === VIVENTIUM END === */

router.post(
  '/chat',
  schedulerAuth,
  configMiddleware,
  async (req, _res, next) => {
    const incoming = req.body ?? {};
    const sanitizedIncoming = { ...incoming };
    delete sanitizedIncoming.interactionContext;
    delete sanitizedIncoming.viventiumInteractionContext;
    delete sanitizedIncoming.titleText;
    req.viventiumSchedulerTitleSource = schedulerTitleSource(incoming.titleText);
    let scheduledAgentExecution;
    try {
      scheduledAgentExecution = normalizeScheduledAgentExecution(
        incoming.scheduledAgentExecution,
        req.config?.endpoints?.agents,
      );
    } catch (error) {
      return _res.status(400).json({
        error: error.message,
        reason: 'invalid_scheduled_agent_execution',
      });
    }
    if (scheduledAgentExecution) {
      req.viventiumScheduledAgentExecution = scheduledAgentExecution;
    }
    const text = typeof incoming.text === 'string' ? incoming.text : '';
    const requestedConversationId =
      typeof incoming.conversationId === 'string' ? incoming.conversationId : 'new';
    let requestedAgentId = '';
    if (typeof incoming.agentId === 'string') {
      requestedAgentId = incoming.agentId;
    } else if (typeof incoming.agent_id === 'string') {
      requestedAgentId = incoming.agent_id;
    }
    const scheduleId = typeof incoming.scheduleId === 'string' ? incoming.scheduleId : '';
    let idempotencyKey;
    try {
      idempotencyKey = normalizeSchedulerIdempotencyKey(incoming.idempotencyKey);
    } catch (error) {
      return _res.status(400).json({ error: error.message, reason: 'invalid_idempotency_key' });
    }
    const dispatchDocumentId = idempotencyKey
      ? schedulerDispatchDocumentId(req.user?.id, idempotencyKey)
      : '';
    const existingDispatch = dispatchDocumentId
      ? await schedulerDispatchCollection().findOne({ _id: dispatchDocumentId })
      : null;
    if (existingDispatch?.streamId) {
      const existingJob =
        existingDispatch.status === 'accepted'
          ? true
          : await GenerationJobManager.getJob(existingDispatch.streamId);
      if (existingJob) {
        if (existingDispatch.status !== 'accepted') {
          await schedulerDispatchCollection().updateOne(
            { _id: dispatchDocumentId },
            { $set: { status: 'accepted', updatedAt: new Date() } },
          );
        }
        return _res.status(200).json({
          streamId: existingDispatch.streamId,
          conversationId: existingDispatch.conversationId,
          idempotencyKey,
          duplicate: true,
        });
      }
    }
    const streamId =
      existingDispatch?.streamId ||
      (idempotencyKey
        ? `scheduler-${crypto.createHash('sha256').update(dispatchDocumentId).digest('hex').slice(0, 32)}`
        : `scheduler-${crypto.randomUUID()}`);
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
    if (dispatchDocumentId && !existingDispatch) {
      await schedulerDispatchCollection().updateOne(
        { _id: dispatchDocumentId },
        {
          $setOnInsert: {
            _id: dispatchDocumentId,
            userId: String(req.user?.id || ''),
            idempotencyKey,
            streamId,
            conversationId,
            status: 'reserved',
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );
      const reserved = await schedulerDispatchCollection().findOne({ _id: dispatchDocumentId });
      if (reserved?.streamId && reserved.streamId !== streamId) {
        return _res.status(200).json({
          streamId: reserved.streamId,
          conversationId: reserved.conversationId,
          idempotencyKey,
          duplicate: true,
        });
      }
    }
    if (dispatchDocumentId) {
      req.viventiumSchedulerDispatchDocumentId = dispatchDocumentId;
    }
    let parentMessageId = conversationState.parentMessageId;
    setTrustedInteractionContext(
      req,
      createSchedulerInteractionContext({
        conversation_id: conversationId,
        source_event_id: incoming.source_event_id || incoming.sourceEventId || streamId,
      }),
      {
        segment_stability: 'immediate',
        supersede_scope: 'response_only',
      },
      { commit_authority: 'server' },
    );

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
      ...sanitizedIncoming,
      text,
      endpoint: 'agents',
      endpointType: 'agents',
      conversationId,
      parentMessageId,
      agent_id: agentId,
      streamId,
      scheduleId,
      ...(scheduledAgentExecution
        ? {
            model: scheduledAgentExecution.model,
            reasoning_effort: scheduledAgentExecution.reasoning_effort,
          }
        : {}),
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
  },
  validateConvoAccess,
  buildEndpointOption,
  async (req, res, next) => {
    const result = await AgentController(req, res, next, initializeClient, addSchedulerTitle);
    if (req.viventiumSchedulerDispatchDocumentId) {
      await schedulerDispatchCollection().updateOne(
        { _id: req.viventiumSchedulerDispatchDocumentId },
        { $set: { status: 'accepted', updatedAt: new Date() } },
      );
    }
    return result;
  },
);

router.get('/dispatches/:idempotencyKey', schedulerAuth, async (req, res) => {
  const idempotencyKey = normalizeSchedulerIdempotencyKey(req.params.idempotencyKey);
  const documentId = schedulerDispatchDocumentId(req.user?.id, idempotencyKey);
  const dispatch = await schedulerDispatchCollection().findOne({ _id: documentId });
  if (!dispatch?.streamId) {
    return res.status(404).json({ error: 'Scheduler dispatch not found' });
  }
  const job = await GenerationJobManager.getJob(dispatch.streamId);
  return res.json({
    streamId: dispatch.streamId,
    conversationId: dispatch.conversationId,
    idempotencyKey,
    state: job ? 'accepted' : 'reserved',
  });
});

/* === VIVENTIUM START ===
 * Feature: Bounded scheduled-authoring cancellation.
 * Purpose: A scheduler stream timeout is an explicit cancellation of unfinished model authoring,
 * not an implicit cancellation of a durable tool or GlassHive effect. Keep scheduler credentials
 * scoped to scheduler-owned jobs and retract only the provisional assistant presentation.
 * === VIVENTIUM END === */
router.post('/stream/:streamId/cancel', schedulerAuth, async (req, res) => {
  const { streamId } = req.params;
  const userId = String(req.user?.id || '');
  const job = await GenerationJobManager.getJob(streamId);
  if (!job) {
    return res.status(404).json({ error: 'Scheduler stream not found' });
  }
  if (job.metadata?.userId && String(job.metadata.userId) !== userId) {
    return res.status(403).json({ error: 'Unauthorized scheduler stream' });
  }
  const context = job.metadata?.interactionContext;
  if (context?.actor_kind !== 'system' || context?.origin !== 'scheduler') {
    return res.status(409).json({
      error: 'Only scheduler-owned authoring can be cancelled here',
      reason: 'not_scheduler_authoring',
    });
  }
  if (job.status !== 'running') {
    return res.status(409).json({
      error: 'Scheduler authoring is already terminal',
      reason: 'not_running',
    });
  }

  const result = await GenerationJobManager.abortJob(streamId);
  if (!result?.success) {
    return res.status(409).json({ error: 'Scheduler authoring could not be cancelled' });
  }

  const responseMessageId = result.jobData?.responseMessageId;
  const conversationId = result.jobData?.conversationId;
  if (responseMessageId) {
    const removed = await Message.findOneAndDelete({
      user: userId,
      messageId: responseMessageId,
      isCreatedByUser: { $ne: true },
      unfinished: true,
      'metadata.viventium.interactionContext.actor_kind': 'system',
      'metadata.viventium.interactionContext.origin': 'scheduler',
    });
    if (removed?._id && conversationId) {
      await Conversation.collection.updateOne(
        { user: userId, conversationId },
        { $pull: { messages: removed._id }, $set: { isArchived: true } },
      );
    }
  }

  return res.json({ success: true, cancelled: streamId });
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
    logger.error(
      '[VIVENTIUM][scheduler/telegram] Failed to resolve mapping',
      schedulerSafeFailure(err),
    );
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

  /* === VIVENTIUM START ===
   * Purpose: Cancel a scheduler stream before any asynchronous lookup can
   * advance a disconnected client into subscription readiness.
   */
  const requestAbort = new AbortController();
  let result;
  const onRequestClose = () => {
    requestAbort.abort();
    if (lingerTimer) {
      clearTimeout(lingerTimer);
      lingerTimer = null;
    }
    result?.unsubscribe();
  };
  res.once('close', onRequestClose);

  const job = await GenerationJobManager.getJob(streamId);
  if (requestAbort.signal.aborted) {
    return;
  }
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
    if (requestAbort.signal.aborted) {
      return;
    }
    if (resumeState && !res.writableEnded) {
      writeSseEvent(res, 'message', { sync: true, resumeState });
    }
  }

  let readinessFailed = false;

  result = await GenerationJobManager.subscribe(
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
        writeSseEvent(res, 'error', schedulerSafeFailure(error));
        endStream();
      }
    },
    requestAbort.signal,
  ).catch((error) => {
    if (!requestAbort.signal.aborted) {
      readinessFailed = true;
      res.removeListener('close', onRequestClose);
      logger.error(
        `[VIVENTIUM][SchedulerStream] subscription readiness failed: ${streamId}`,
        error,
      );
      if (!res.writableEnded) {
        writeSseEvent(
          res,
          'error',
          schedulerSafeFailure({ code: 'provider_temporarily_unavailable' }),
        );
        endStream();
      }
    }
    return null;
  });

  if (!result) {
    res.removeListener('close', onRequestClose);
    if (requestAbort.signal.aborted || readinessFailed) {
      return;
    }
    if (!res.writableEnded) {
      writeSseEvent(
        res,
        'error',
        schedulerSafeFailure({ code: 'provider_temporarily_unavailable' }),
      );
      endStream();
    }
    return;
  }

  if (requestAbort.signal.aborted) {
    result.unsubscribe();
  }
  /* === VIVENTIUM END === */
});

router.get('/events/:streamId', schedulerAuth, async (req, res) => {
  const { streamId } = req.params;
  const userId = req.user?.id;
  const isResume = req.query.resume === 'true';

  /* === VIVENTIUM START ===
   * Purpose: Apply the same pre-lookup cancellation boundary to the structured
   * scheduler event stream.
   */
  const requestAbort = new AbortController();
  let result;
  const onRequestClose = () => {
    requestAbort.abort();
    result?.unsubscribe();
  };
  res.once('close', onRequestClose);

  const job = await GenerationJobManager.getJob(streamId);
  if (requestAbort.signal.aborted) {
    return;
  }
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
    if (requestAbort.signal.aborted) {
      return;
    }
    if (resumeState && !res.writableEnded) {
      writeSseEvent(res, 'message', { type: 'sync', resumeState });
    }
  }

  try {
    result = await GenerationJobManager.subscribe(
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

        const finalFailure = schedulerFinalFailure(event);
        if (finalFailure) {
          writeSseEvent(res, 'error', finalFailure);
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
          writeSseEvent(res, 'error', schedulerSafeFailure(error));
          res.end();
        }
      },
      requestAbort.signal,
    );
  } catch (error) {
    if (requestAbort.signal.aborted) {
      return;
    }
    res.removeListener('close', onRequestClose);
    logger.error(`[VIVENTIUM][SchedulerEvents] subscription readiness failed: ${streamId}`, error);
    if (!res.writableEnded) {
      writeSseEvent(
        res,
        'error',
        schedulerSafeFailure({ code: 'provider_temporarily_unavailable' }),
      );
      res.end();
    }
    return;
  }

  if (!result) {
    res.removeListener('close', onRequestClose);
    if (requestAbort.signal.aborted) {
      return;
    }
    if (!res.writableEnded) {
      writeSseEvent(
        res,
        'error',
        schedulerSafeFailure({ code: 'provider_temporarily_unavailable' }),
      );
      res.end();
    }
    return;
  }

  if (requestAbort.signal.aborted) {
    result.unsubscribe();
  }
  /* === VIVENTIUM END === */
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
    logger.error(
      '[VIVENTIUM][scheduler/cortex] Failed to load cortex data',
      schedulerSafeFailure(err),
    );
    return res.status(500).json({ error: 'Failed to load cortex data' });
  }
});

module.exports = router;

/* === VIVENTIUM NOTE === */
