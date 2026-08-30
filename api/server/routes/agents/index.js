const express = require('express');
const { isEnabled, GenerationJobManager } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const {
  uaParser,
  checkBan,
  requireJwtAuth,
  messageIpLimiter,
  configMiddleware,
  messageUserLimiter,
} = require('~/server/middleware');
const { saveMessage } = require('~/models');
const openai = require('./openai');
const responses = require('./responses');
const { v1 } = require('./v1');
const chat = require('./chat');

const { LIMIT_MESSAGE_IP, LIMIT_MESSAGE_USER } = process.env ?? {};

const router = express.Router();

/**
 * Open Responses API routes (API key authentication handled in route file)
 * Mounted at /agents/v1/responses (full path: /api/agents/v1/responses)
 * NOTE: Must be mounted BEFORE /v1 to avoid being caught by the less specific route
 * @see https://openresponses.org/specification
 */
router.use('/v1/responses', responses);

/**
 * OpenAI-compatible API routes (API key authentication handled in route file)
 * Mounted at /agents/v1 (full path: /api/agents/v1/chat/completions)
 */
router.use('/v1', openai);

router.use(requireJwtAuth);
router.use(checkBan);
router.use(uaParser);

router.use('/', v1);

/**
 * Stream endpoints - mounted before chatRouter to bypass rate limiters
 * These are GET requests and don't need message body validation or rate limiting
 */

/**
 * @route GET /chat/stream/:streamId
 * @desc Subscribe to an ongoing generation job's SSE stream with replay support
 * @access Private
 * @description Sends sync event with resume state, replays missed chunks, then streams live
 * @query resume=true - Indicates this is a reconnection (sends sync event)
 */
router.get('/chat/stream/:streamId', async (req, res) => {
  const { streamId } = req.params;
  const isResume = req.query.resume === 'true';

  /* === VIVENTIUM START ===
   * Purpose: Arm disconnect cancellation before any asynchronous lookup so a
   * closed client can never advance into Redis subscription readiness.
   */
  const requestAbort = new AbortController();
  let result;
  const onRequestClose = () => {
    requestAbort.abort();
    result?.unsubscribe();
    logger.debug(`[AgentStream] Client disconnected from ${streamId}`);
  };
  res.once('close', onRequestClose);

  const job = await GenerationJobManager.getJob(streamId);
  if (requestAbort.signal.aborted) {
    return;
  }
  if (!job || !job.metadata?.userId || job.metadata.userId !== req.user.id) {
    return res.status(404).json({
      error: 'Stream not found',
      message: 'The generation job does not exist or has expired.',
    });
  }

  res.setHeader('Content-Encoding', 'identity');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  logger.debug(`[AgentStream] Client subscribed to ${streamId}, resume: ${isResume}`);

  // Send sync event with resume state for ALL reconnecting clients
  // This supports multi-tab scenarios where each tab needs run step data
  if (isResume) {
    const resumeState = await GenerationJobManager.getResumeState(streamId);
    if (requestAbort.signal.aborted) {
      return;
    }
    if (resumeState && !res.writableEnded) {
      // Send sync event with run steps AND aggregatedContent
      // Client will use aggregatedContent to initialize message state
      res.write(`event: message\ndata: ${JSON.stringify({ sync: true, resumeState })}\n\n`);
      if (typeof res.flush === 'function') {
        res.flush();
      }
      logger.debug(
        `[AgentStream] Sent sync event for ${streamId} with ${resumeState.runSteps.length} run steps`,
      );
    }
  }

  let readinessFailed = false;

  result = await GenerationJobManager.subscribe(
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
    requestAbort.signal,
  ).catch((error) => {
    if (!requestAbort.signal.aborted) {
      readinessFailed = true;
      res.removeListener('close', onRequestClose);
      logger.error(`[AgentStream] Failed to subscribe to ${streamId}:`, error);
      if (!res.writableEnded) {
        res.write(
          `event: error\ndata: ${JSON.stringify({ error: 'Stream connection unavailable' })}\n\n`,
        );
        if (typeof res.flush === 'function') {
          res.flush();
        }
        res.end();
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
      res.write(
        `event: error\ndata: ${JSON.stringify({ error: 'Failed to subscribe to stream' })}\n\n`,
      );
      if (typeof res.flush === 'function') {
        res.flush();
      }
      res.end();
    }
    return;
  }

  if (requestAbort.signal.aborted) {
    result.unsubscribe();
  }
  /* === VIVENTIUM END === */
});

/**
 * @route GET /chat/active
 * @desc Get all active generation job IDs for the current user
 * @access Private
 * @returns { activeJobIds: string[] }
 */
router.get('/chat/active', async (req, res) => {
  /* === VIVENTIUM START ===
   * Feature: Exact resumable-stream liveness.
   * Purpose: Preserve conversation IDs for existing navigation consumers and expose exact stream
   *          identities for terminal reconciliation when one conversation has overlapping runs.
   */
  if (GenerationJobManager.getActiveStreamsForUser) {
    const activeStreams = await GenerationJobManager.getActiveStreamsForUser(req.user.id);
    return res.json({
      activeJobIds: [...new Set(activeStreams.map(({ conversationId }) => conversationId))],
      activeStreams,
    });
  }

  const activeJobIds = GenerationJobManager.getActiveConversationIdsForUser
    ? await GenerationJobManager.getActiveConversationIdsForUser(req.user.id)
    : await GenerationJobManager.getActiveJobIdsForUser(req.user.id);
  return res.json({ activeJobIds });
  /* === VIVENTIUM END === */
});

/**
 * @route GET /chat/status/:conversationId
 * @desc Check if there's an active generation job for a conversation
 * @access Private
 * @returns { active, streamId, status, aggregatedContent, createdAt, resumeState }
 */
router.get('/chat/status/:conversationId', async (req, res) => {
  const { conversationId } = req.params;

  const activeStreamId = GenerationJobManager.getActiveStreamIdForConversation
    ? await GenerationJobManager.getActiveStreamIdForConversation(req.user.id, conversationId)
    : conversationId;
  const job = activeStreamId ? await GenerationJobManager.getJob(activeStreamId) : null;

  if (!job) {
    return res.json({ active: false });
  }

  if (job.metadata.userId !== req.user.id) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // Get resume state which contains aggregatedContent
  // Avoid calling both getStreamInfo and getResumeState (both fetch content)
  const resumeState = await GenerationJobManager.getResumeState(activeStreamId);
  const isActive = job.status === 'running';

  res.json({
    active: isActive,
    streamId: activeStreamId,
    status: job.status,
    aggregatedContent: resumeState?.aggregatedContent ?? [],
    createdAt: job.createdAt,
    resumeState,
  });
});

/**
 * @route POST /chat/abort
 * @desc Abort an ongoing generation job
 * @access Private
 * @description Mounted before chatRouter to bypass buildEndpointOption middleware
 */
router.post('/chat/abort', async (req, res) => {
  logger.debug(`[AgentStream] ========== ABORT ENDPOINT HIT ==========`);
  logger.debug(`[AgentStream] Method: ${req.method}, Path: ${req.path}`);
  logger.debug(`[AgentStream] Body:`, req.body);

  const { streamId, conversationId, abortKey } = req.body;
  const userId = req.user?.id;

  // streamId === conversationId, so try any of the provided IDs
  // Skip "new" as it's a placeholder for new conversations, not an actual ID
  let jobStreamId =
    streamId || (conversationId !== 'new' ? conversationId : null) || abortKey?.split(':')[0];
  let job = jobStreamId ? await GenerationJobManager.getJob(jobStreamId) : null;

  if (!job && conversationId && conversationId !== 'new' && userId) {
    const activeConversationStreamId =
      await GenerationJobManager.getActiveStreamIdForConversation?.(userId, conversationId);
    if (activeConversationStreamId) {
      jobStreamId = activeConversationStreamId;
    }
    job = jobStreamId ? await GenerationJobManager.getJob(jobStreamId) : null;
  }

  // Fallback: if job not found and we have a userId, look up active jobs for user
  // This handles the case where frontend sends "new" but job was created with a UUID
  if (!job && userId) {
    logger.debug(`[AgentStream] Job not found by ID, checking active jobs for user: ${userId}`);
    const activeJobIds = await GenerationJobManager.getActiveJobIdsForUser(userId);
    if (activeJobIds.length > 0) {
      const candidates = await Promise.all(
        activeJobIds.map(async (activeStreamId) => ({
          streamId: activeStreamId,
          job: await GenerationJobManager.getJob(activeStreamId),
        })),
      );
      const newest = candidates.reduce((selected, candidate) => {
        if (candidate.job?.status !== 'running' || candidate.job.metadata?.userId !== userId) {
          return selected;
        }
        const createdAt = new Date(candidate.job.createdAt).getTime();
        if (!Number.isFinite(createdAt) || (selected && createdAt <= selected.createdAt)) {
          return selected;
        }
        return { ...candidate, createdAt };
      }, null);
      if (newest) {
        jobStreamId = newest.streamId;
        job = newest.job;
        logger.debug(`[AgentStream] Found active job for user: ${jobStreamId}`);
      }
    }
  }

  logger.debug(`[AgentStream] Computed jobStreamId: ${jobStreamId}`);

  if (job && jobStreamId) {
    if (!userId || !job.metadata?.userId || job.metadata.userId !== userId) {
      logger.warn('[AgentStream] Abort target unavailable for authenticated owner');
      return res.status(404).json({ error: 'Job not found', streamId: jobStreamId });
    }

    /* === VIVENTIUM START ===
     * A completed Main response may retain a short-lived runtime solely for Phase B delivery.
     * It is not an active generation and must never be abortable, because an abort persists the
     * volatile stream buffer over the already-final assistant message.
     * === VIVENTIUM END === */
    if (job.status && job.status !== 'running') {
      return res.status(409).json({
        error: 'Generation is already complete',
        streamId: jobStreamId,
      });
    }

    logger.debug(`[AgentStream] Job found, aborting: ${jobStreamId}`);
    /* === VIVENTIUM START ===
     * Feature: Explicit harness cancellation reason.
     * Purpose: This authenticated Stop endpoint is user intent, unlike subscriber disconnects.
     * === VIVENTIUM END === */
    const abortResult = await GenerationJobManager.abortJob(jobStreamId, 'user_cancelled');
    logger.debug(`[AgentStream] Job aborted successfully: ${jobStreamId}`, {
      abortResultSuccess: abortResult.success,
      abortResultUserMessageId: abortResult.jobData?.userMessage?.messageId,
      abortResultResponseMessageId: abortResult.jobData?.responseMessageId,
    });

    // CRITICAL: Save partial response BEFORE returning to prevent race condition.
    // If user sends a follow-up immediately after abort, the parentMessageId must exist in DB.
    // Only save if we have a valid responseMessageId (skip early aborts before generation started)
    if (
      abortResult.success &&
      abortResult.jobData?.userMessage?.messageId &&
      abortResult.jobData?.responseMessageId
    ) {
      const { jobData, content, text } = abortResult;
      const responseMessage = {
        messageId: jobData.responseMessageId,
        parentMessageId: jobData.userMessage.messageId,
        conversationId: jobData.conversationId,
        content: content || [],
        text: text || '',
        sender: jobData.sender || 'AI',
        endpoint: jobData.endpoint,
        model: jobData.model,
        unfinished: true,
        error: false,
        isCreatedByUser: false,
        user: userId,
      };

      try {
        await saveMessage(req, responseMessage, {
          context: 'api/server/routes/agents/index.js - abort endpoint',
        });
        logger.debug(`[AgentStream] Saved partial response for: ${jobStreamId}`);
      } catch (saveError) {
        logger.error(`[AgentStream] Failed to save partial response: ${saveError.message}`);
      }
    }

    return res.json({ success: true, aborted: jobStreamId });
  }

  logger.warn(`[AgentStream] Job not found for streamId: ${jobStreamId}`);
  return res.status(404).json({ error: 'Job not found', streamId: jobStreamId });
});

const chatRouter = express.Router();
chatRouter.use(configMiddleware);

if (isEnabled(LIMIT_MESSAGE_IP)) {
  chatRouter.use(messageIpLimiter);
}

if (isEnabled(LIMIT_MESSAGE_USER)) {
  chatRouter.use(messageUserLimiter);
}

chatRouter.use('/', chat);
router.use('/chat', chatRouter);

module.exports = router;
