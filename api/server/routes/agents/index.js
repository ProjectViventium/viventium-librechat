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
/* === VIVENTIUM START === Linked-chat Stop shares the exact native Voice task owner. === */
const {
  requestVoiceTaskOwnerCancellationForJob,
} = require('~/server/services/viventium/VoiceTaskService');
/* === VIVENTIUM END === */
const openai = require('./openai');
const responses = require('./responses');
const { v1 } = require('./v1');
const chat = require('./chat');

const { LIMIT_MESSAGE_IP, LIMIT_MESSAGE_USER } = process.env ?? {};

const router = express.Router();

/* === VIVENTIUM START ===
 * Feature: Parallel Work owner isolation.
 * Purpose: Generation jobs are account-scoped authority. Missing legacy owner metadata is not a
 *          compatibility grant: every read/control boundary must prove the authenticated owner.
 */
const jobBelongsToUser = (job, userId) =>
  Boolean(userId && job?.metadata?.userId && job.metadata.userId === userId);
/* === VIVENTIUM END === */

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
  /* VIVENTIUM: exact persisted host final is independent of expired transport storage. */
  if (!job) {
    const terminal = await require('~/server/services/viventium/nativeResponseService')
      .readRetainedHostFinal({ userId: req.user.id, streamId, surface: 'web', includeSettled: true });
    if (requestAbort.signal.aborted) return;
    if (terminal) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      return res.end(`event: message\ndata: ${JSON.stringify(terminal.finalEvent)}\n\n`);
    }
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
    (error, errorClass) => {
      if (!res.writableEnded) {
        res.write(
          `event: error\ndata: ${JSON.stringify({ error, ...(errorClass ? { error_class: errorClass } : {}) })}\n\n`,
        );
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

  /* === VIVENTIUM START ===
   * Feature: Parallel Work owner isolation.
   * Purpose: Status is stream data and requires the same exact owner proof as subscription.
   */
  if (!jobBelongsToUser(job, req.user.id)) {
    return res.json({ active: false });
  }
  /* === VIVENTIUM END === */

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

  /* === VIVENTIUM START ===
   * Purpose: An exact Stop key must never roll over to a replacement or unrelated generation.
   * Conversation-only clients may resolve their own stream; only an unidentified new-chat Stop
   * may use the legacy newest-owned-job fallback.
   */
  const exactStreamId = streamId || abortKey?.split(':')[0];
  const targetConversationId = conversationId !== 'new' ? conversationId : null;
  let jobStreamId = exactStreamId || targetConversationId;
  let job = jobStreamId ? await GenerationJobManager.getJob(jobStreamId) : null;

  if (!job && !exactStreamId && targetConversationId && userId) {
    const activeConversationStreamId =
      await GenerationJobManager.getActiveStreamIdForConversation?.(userId, targetConversationId);
    if (activeConversationStreamId) {
      jobStreamId = activeConversationStreamId;
    }
    job = jobStreamId ? await GenerationJobManager.getJob(jobStreamId) : null;
  }

  if (!job && !exactStreamId && !targetConversationId && userId) {
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
  /* === VIVENTIUM END === */

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

    /* === VIVENTIUM START ===
     * Native Voice Stop must install the task suppression barrier and obtain the owner's fresh
     * capacity ACK. A raw stream abort bypasses that owner and can retire the job before delivery.
     */
    try {
      const cancellation = await requestVoiceTaskOwnerCancellationForJob(job, {
        streamId: jobStreamId,
        userId,
      });
      if (cancellation) {
        const outcome = cancellation.alreadyCompleted
          ? 'already_completed'
          : cancellation.alreadyInactive
            ? 'not_active'
            : cancellation.alreadyCancelled
              ? cancellation.task?.state
              : 'cancelling';
        return res
          .status(
            cancellation.alreadyCompleted || cancellation.alreadyInactive
              ? 409
              : cancellation.alreadyCancelled || cancellation.alreadyCancelling
                ? 200
                : 202,
          )
          .json({
            version: 1,
            outcome,
            operationId: cancellation.operationId,
            task: cancellation.task,
            event: cancellation.event,
          });
      }
    } catch (error) {
      return res.status(error?.status || 503).json({
        code: error?.code || 'gateway_down',
        message: 'Cancellation could not be confirmed. Please retry.',
        retryable: error?.status !== 404,
      });
    }
    /* === VIVENTIUM END === */
    logger.debug(`[AgentStream] Job found, aborting: ${jobStreamId}`);
    /* === VIVENTIUM START ===
     * Feature: Explicit harness cancellation reason.
     * Purpose: This authenticated Stop endpoint is user intent, unlike subscriber disconnects.
     * === VIVENTIUM END === */
    const abortResult = await GenerationJobManager.abortJob(jobStreamId, 'user_cancelled', userId);
    /* === VIVENTIUM START === A committed native answer cannot truthfully become cancelled. === */
    if (abortResult.nativeResponse) {
      return res.status(abortResult.nativeResponse === 'committed' ? 200 : 202).json({
        success: false,
        nativeResponse: abortResult.nativeResponse,
        ...(abortResult.finalEvent ? { finalEvent: abortResult.finalEvent } : {}),
      });
    }
    /* === VIVENTIUM END === */
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
      !abortResult.jobData?.nativeResponse &&
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
          operationKind: 'system',
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
