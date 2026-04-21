/* === VIVENTIUM START ===
 * File: api/server/controllers/agents/request.js
 *
 * Purpose:
 * - Track and preserve all Viventium modifications to this upstream LibreChat file in one place.
 *
 * Why a file-level wrapper:
 * - This controller has multiple scattered changes for Viventium (voice concurrency bypass, Telegram streamId
 *   handling, and deep timing instrumentation). Wrapping the whole file prevents missing any change during
 *   manual porting to a newer upstream LibreChat version.
 *
 * Porting (manual onto new upstream):
 * - Re-apply this file as a patch against upstream (see docs/requirements_and_learnings/05_Open_Source_Modifications.md).
 * - Search inside this file for `VIVENTIUM NOTE` for section-level intent notes.
 *
 * Added: 2026-01-11
 * Updated: 2026-01-31, 2026-02-07
 */
const { logger } = require('@librechat/data-schemas');
const { Constants, ViolationTypes } = require('librechat-data-provider');
const {
  sendEvent,
  getViolationInfo,
  GenerationJobManager,
  decrementPendingRequest,
  sanitizeFileForTransmit,
  sanitizeMessageForTransmit,
  checkAndIncrementPendingRequest,
} = require('@librechat/api');
const { disposeClient, clientRegistry, requestDataMap } = require('~/server/cleanup');
const { handleAbortError } = require('~/server/middleware');
const { logViolation } = require('~/cache');
const { saveMessage } = require('~/models');
/* === VIVENTIUM NOTE ===
 * Feature: Deep Telegram timing instrumentation (toggleable)
 */
const {
  isDeepTimingEnabled,
  startDeepTiming,
  logDeepTiming,
} = require('~/server/services/viventium/telegramTimingDeep');
/* === VIVENTIUM NOTE END === */

/* === VIVENTIUM NOTE ===
 * Feature: Morning Briefing Bootstrap (Default Starter Schedule)
 * Purpose: Provision default morning briefing for new users on first interaction (fire-and-forget).
 * Added: 2026-02-15
 */
const { ensureMorningBriefing } = require('~/server/services/viventium/morningBriefingBootstrap');
/* === VIVENTIUM NOTE END === */

/* === VIVENTIUM NOTE ===
 * Feature: Strip voice control tags from persisted messages.
 * Purpose: When voiceMode is active, the LLM generates text with Cartesia SSML emotion tags
 * and bracket nonverbal markers. These are needed for TTS synthesis but should not appear
 * in the persisted message text (which is later displayed in the web UI, Telegram sync, etc.).
 * Added: 2026-02-22
 */
const { stripVoiceControlTagsForDisplay } = require('~/server/services/viventium/surfacePrompts');
/* === VIVENTIUM NOTE END === */

/* === VIVENTIUM NOTE ===
 * Feature: Timed message persistence for Telegram deep timing.
 */
const timedSaveMessage = async (req, message, options, step) => {
  if (!isDeepTimingEnabled(req)) {
    return saveMessage(req, message, options);
  }
  const t = startDeepTiming(req);
  const result = await saveMessage(req, message, options);
  logDeepTiming(req, step, t, `messageId=${message?.messageId || 'na'}`);
  return result;
};
/* === VIVENTIUM NOTE END === */

const PARTIAL_RESPONSE_CHECKPOINT_MS = 3000;
const PARTIAL_RESPONSE_PLACEHOLDER_DELAY_MS = 5000;

function extractTextFromContentParts(contentParts = []) {
  if (!Array.isArray(contentParts) || contentParts.length === 0) {
    return '';
  }

  return contentParts
    .filter((part) => part?.type === 'text')
    .map((part) => {
      if (typeof part?.text === 'string') {
        return part.text;
      }
      if (typeof part?.text?.value === 'string') {
        return part.text.value;
      }
      return '';
    })
    .join('')
    .trim();
}

function sanitizePersistedAssistantText(req, text) {
  if (typeof text !== 'string') {
    return '';
  }
  if (req.body?.voiceMode === true) {
    return stripVoiceControlTagsForDisplay(text);
  }
  return text;
}

function sanitizePersistedAssistantContent(req, content) {
  if (!Array.isArray(content) || req.body?.voiceMode !== true) {
    return content;
  }

  let changed = false;
  const sanitized = content.map((part) => {
    if (!part || typeof part !== 'object' || part.type !== 'text') {
      return part;
    }

    const rawText =
      typeof part.text === 'string'
        ? part.text
        : typeof part.text?.value === 'string'
          ? part.text.value
          : '';
    const cleanedText = stripVoiceControlTagsForDisplay(rawText);
    if (cleanedText === rawText) {
      return part;
    }

    changed = true;
    if (typeof part.text === 'string') {
      return {
        ...part,
        text: cleanedText,
      };
    }

    if (part.text && typeof part.text === 'object') {
      return {
        ...part,
        text: {
          ...part.text,
          value: cleanedText,
        },
      };
    }

    return {
      ...part,
      text: cleanedText,
    };
  });

  return changed ? sanitized : content;
}

async function persistAssistantSnapshot({
  req,
  streamId,
  userId,
  client,
  conversationId,
  aggregatedContent,
  userMessage,
  responseMessageId,
  sender,
  fallbackText = '',
  unfinished = true,
  error = false,
  context,
}) {
  let resolvedUserMessage =
    userMessage?.messageId != null
      ? {
          messageId: userMessage.messageId,
          parentMessageId: userMessage.parentMessageId,
          conversationId: userMessage.conversationId,
          text: userMessage.text,
        }
      : null;
  let resolvedResponseMessageId =
    typeof responseMessageId === 'string' && responseMessageId.trim().length > 0
      ? responseMessageId
      : null;
  let resolvedConversationId =
    conversationId || userMessage?.conversationId || client?.conversationId || null;
  let resolvedSender = client?.sender ?? sender ?? null;
  let resumeState = null;

  if (!resolvedUserMessage || !resolvedResponseMessageId || !resolvedConversationId || !resolvedSender) {
    resumeState = await GenerationJobManager.getResumeState(streamId);
    resolvedUserMessage =
      resolvedUserMessage ??
      (resumeState?.userMessage?.messageId
        ? {
            messageId: resumeState.userMessage.messageId,
            parentMessageId: resumeState.userMessage.parentMessageId,
            conversationId: resumeState.userMessage.conversationId,
            text: resumeState.userMessage.text,
          }
        : null);
    resolvedResponseMessageId = resolvedResponseMessageId ?? resumeState?.responseMessageId ?? null;
    resolvedConversationId =
      resolvedConversationId ??
      resumeState?.conversationId ??
      resolvedUserMessage?.conversationId ??
      null;
    resolvedSender = resolvedSender ?? resumeState?.sender ?? null;
  }

  if (!resolvedUserMessage?.messageId) {
    logger.debug(
      '[ResumableAgentController] No user message available for assistant snapshot save',
    );
    return { persisted: false, fingerprint: null };
  }

  const rawContent = Array.isArray(aggregatedContent)
    ? aggregatedContent.filter(Boolean)
    : (resumeState?.aggregatedContent ?? []);
  const effectiveContent = sanitizePersistedAssistantContent(req, rawContent);
  const extractedText = extractTextFromContentParts(effectiveContent);
  const text = sanitizePersistedAssistantText(req, extractedText || fallbackText || '');

  if (effectiveContent.length === 0 && text.length === 0) {
    return { persisted: false, fingerprint: null };
  }

  const messageId = resolvedResponseMessageId || `${resolvedUserMessage.messageId}_`;
  const responseConversationId = resolvedConversationId || conversationId;
  const resolvedSnapshotSender = resolvedSender || 'AI';
  const endpoint = client?.options?.endpoint;
  const model = client?.model;
  const fingerprint = JSON.stringify({
    messageId,
    text,
    contentLength: effectiveContent.length,
    unfinished,
    error,
  });

  await timedSaveMessage(
    req,
    {
      messageId,
      conversationId: responseConversationId,
      parentMessageId: resolvedUserMessage.messageId,
      sender: resolvedSnapshotSender,
      content: effectiveContent,
      text,
      unfinished,
      error,
      isCreatedByUser: false,
      endpoint,
      model,
      user: userId,
      ...(req.body?.agent_id ? { agent_id: req.body.agent_id } : {}),
    },
    { context },
    error ? 'db_save_error_response' : 'db_save_partial_response',
  );

  return { persisted: true, fingerprint };
}

/* === VIVENTIUM NOTE ===
 * Feature: Voice sessions bypass concurrent limiter (avoids voice stalls)
 * Purpose: When handling a LiveKit voice call session, skip the concurrent request limiter to prevent mid-call stalls.
 * Added: 2026-01-11
 */
function isVoiceConcurrencyBypassed(req) {
  if (!req?.viventiumCallSession) {
    return false;
  }
  const raw = (process.env.VIVENTIUM_VOICE_BYPASS_CONCURRENCY || 'true').toLowerCase();
  return !['false', '0', 'no', 'off'].includes(raw);
}
/* === VIVENTIUM NOTE END === */

/* === VIVENTIUM NOTE ===
 * Feature: Voice latency stage logging (request controller split).
 * Purpose: Split ready->chat_completion_start into initialize/ready-gate/sendMessage stages.
 * Added: 2026-03-03
 */
const isVoiceLatencyEnabled = (req) => req?.viventiumVoiceLogLatency === true;

const getVoiceLatencyRequestId = (req) => {
  const requestId = req?.viventiumVoiceRequestId;
  if (typeof requestId === 'string' && requestId.length > 0) {
    return requestId;
  }
  return 'unknown';
};

const logVoiceLatencyStage = (req, stage, stageStartAt = null, details = '') => {
  if (!isVoiceLatencyEnabled(req)) {
    return;
  }

  const now = Date.now();
  const routeStartAt =
    typeof req?.viventiumVoiceStartAt === 'number' ? req.viventiumVoiceStartAt : now;
  const stageMs = typeof stageStartAt === 'number' ? now - stageStartAt : null;
  const requestId = getVoiceLatencyRequestId(req);
  const stagePart = stageMs == null ? '' : ` stage_ms=${stageMs}`;
  const detailPart = details ? ` ${details}` : '';
  logger.info(
    `[VoiceLatency][LC] stage=${stage} request_id=${requestId} total_ms=${now - routeStartAt}${stagePart}${detailPart}`,
  );
};
/* === VIVENTIUM NOTE END === */

function createCloseHandler(abortController) {
  return function (manual) {
    if (!manual) {
      logger.debug('[AgentController] Request closed');
    }
    if (!abortController) {
      return;
    } else if (abortController.signal.aborted) {
      return;
    } else if (abortController.requestCompleted) {
      return;
    }

    abortController.abort();
    logger.debug('[AgentController] Request aborted on close');
  };
}

/**
 * Resumable Agent Controller - Generation runs independently of HTTP connection.
 * Returns streamId immediately, client subscribes separately via SSE.
 */
const ResumableAgentController = async (req, res, next, initializeClient, addTitle) => {
  const {
    text,
    isRegenerate,
    endpointOption,
    conversationId: reqConversationId,
    isContinued = false,
    editedContent = null,
    parentMessageId = null,
    overrideParentMessageId = null,
    responseMessageId: editedResponseMessageId = null,
  } = req.body;

  const userId = req.user.id;

  /* === VIVENTIUM NOTE ===
   * Feature: Voice concurrency bypass (default on)
   * Purpose: Allow voice sessions to bypass the concurrent request limiter to avoid voice stalls mid-call.
   * Added: 2026-01-11
   */
  const bypassConcurrency = isVoiceConcurrencyBypassed(req);
  let didIncrement = false;
  if (!bypassConcurrency) {
    const { allowed, pendingRequests, limit } = await checkAndIncrementPendingRequest(userId);
    if (!allowed) {
      const violationInfo = getViolationInfo(pendingRequests, limit);
      await logViolation(req, res, ViolationTypes.CONCURRENT, violationInfo, violationInfo.score);
      return res.status(429).json(violationInfo);
    }
    didIncrement = true;
  } else {
    logger.debug('[concurrency] Bypassing concurrent request limit for voice session');
  }
  /* === VIVENTIUM NOTE END === */

  const maybeDecrement = async () => {
    if (!didIncrement) {
      return;
    }
    await decrementPendingRequest(userId);
  };

  // Generate conversationId upfront if not provided.
  // Treat "new" as a placeholder that needs a real UUID (frontend may send "new" for new convos)
  const conversationId =
    !reqConversationId || reqConversationId === 'new' ? crypto.randomUUID() : reqConversationId;
  /* === VIVENTIUM NOTE ===
   * Feature: Allow caller-supplied streamId to avoid stream collisions (Telegram).
   * Purpose: Telegram bridge can pass a stable streamId so resumable jobs don't collide across surfaces.
   * Added: 2026-01-31
   */
  const reqStreamId = typeof req.body?.streamId === 'string' ? req.body.streamId.trim() : '';
  const streamId = reqStreamId && reqStreamId !== 'new' ? reqStreamId : conversationId;
  /* === VIVENTIUM NOTE END === */
  const voiceLatencyEnabled = isVoiceLatencyEnabled(req);

  let client = null;

  try {
    logger.debug(`[ResumableAgentController] Creating job`, {
      streamId,
      conversationId,
      reqConversationId,
      userId,
    });

    const job = await GenerationJobManager.createJob(streamId, userId, conversationId);
    const jobCreatedAt = job.createdAt; // Capture creation time to detect job replacement
    req._resumableStreamId = streamId;

    // Send JSON response IMMEDIATELY so client can connect to SSE stream
    // This is critical: tool loading (MCP OAuth) may emit events that the client needs to receive
    res.json({ streamId, conversationId, status: 'started' });
    if (voiceLatencyEnabled) {
      logVoiceLatencyStage(
        req,
        'resumable_ready_sent',
        null,
        `stream_id=${streamId} conversation_id=${conversationId}`,
      );
    }

    /* === VIVENTIUM NOTE ===
     * Feature: Morning Briefing Bootstrap (fire-and-forget).
     * Runs after res.json() so it never blocks the user's response.
     */
    let morningBriefingSurface = 'web';
    if (req._viventiumTelegram) {
      morningBriefingSurface = 'telegram';
    } else if (req.viventiumCallSession) {
      morningBriefingSurface = 'voice';
    }

    ensureMorningBriefing({
      userId,
      clientTimezone: req.body?.clientTimezone,
      surface: morningBriefingSurface,
    }).catch(() => {});
    /* === VIVENTIUM NOTE END === */

    // Note: We no longer use res.on('close') to abort since we send JSON immediately.
    // The response closes normally after res.json(), which is not an abort condition.
    // Abort handling is done through GenerationJobManager via the SSE stream connection.

    let lastAssistantSnapshotFingerprint = null;
    let partialCheckpointTimer = null;
    let generationStartedAt = null;
    let placeholderSnapshotSaved = false;
    const stopPartialCheckpointing = () => {
      if (partialCheckpointTimer) {
        clearInterval(partialCheckpointTimer);
        partialCheckpointTimer = null;
      }
    };

    /**
     * Listen for all subscribers leaving to save partial response.
     * This ensures the response is saved to DB even if all clients disconnect
     * while generation continues.
     *
     * Note: The messageId used here falls back to `${userMessage.messageId}_` if the
     * actual response messageId isn't available yet. The final response save will
     * overwrite this with the complete response using the same messageId pattern.
     */
    let sender = client?.sender;
    let userMessage;
    let responseMessageId = editedResponseMessageId;

    job.emitter.on('allSubscribersLeft', async (aggregatedContent) => {
      if (!aggregatedContent || aggregatedContent.length === 0) {
        return;
      }

      try {
        const snapshot = await persistAssistantSnapshot({
          req,
          streamId,
          userId,
          client,
          conversationId,
          aggregatedContent,
          userMessage,
          responseMessageId,
          sender,
          unfinished: true,
          error: false,
          context: 'api/server/controllers/agents/request.js - partial response on disconnect',
        });
        if (!snapshot.persisted) {
          return;
        }
        lastAssistantSnapshotFingerprint = snapshot.fingerprint;

        logger.debug(
          `[ResumableAgentController] Saved partial response for ${streamId}, content parts: ${aggregatedContent.length}`,
        );
      } catch (error) {
        logger.error('[ResumableAgentController] Error saving partial response:', error);
      }
    });

    /** @type {{ client: TAgentClient; userMCPAuthMap?: Record<string, Record<string, string>> }} */
    const initStart = startDeepTiming(req);
    const voiceInitStart = voiceLatencyEnabled ? Date.now() : 0;
    if (voiceLatencyEnabled) {
      logVoiceLatencyStage(req, 'initialize_client_start', null, `stream_id=${streamId}`);
    }
    const result = await initializeClient({
      req,
      res,
      endpointOption,
      // Use the job's abort controller signal - allows abort via GenerationJobManager.abortJob()
      signal: job.abortController.signal,
    });
    if (isDeepTimingEnabled(req)) {
      logDeepTiming(req, 'initialize_client', initStart);
    }
    if (voiceLatencyEnabled) {
      logVoiceLatencyStage(req, 'initialize_client_done', voiceInitStart, `stream_id=${streamId}`);
    }

    if (job.abortController.signal.aborted) {
      GenerationJobManager.completeJob(streamId, 'Request aborted during initialization');
      await maybeDecrement();
      return;
    }

    client = result.client;
    sender = client?.sender;

    if (client?.sender) {
      await GenerationJobManager.updateMetadata(streamId, { sender: client.sender });
    }

    // Store reference to client's contentParts - graph will be set when run is created
    if (client?.contentParts) {
      GenerationJobManager.setContentParts(streamId, client.contentParts);
    }

    const getReqData = (data = {}) => {
      if (data.userMessage) {
        userMessage = data.userMessage;
      }
      if (typeof data.responseMessageId === 'string' && data.responseMessageId.length > 0) {
        responseMessageId = data.responseMessageId;
      }
      if (typeof data.sender === 'string' && data.sender.length > 0) {
        sender = data.sender;
      }
      // conversationId is pre-generated, no need to update from callback
    };

    // Start background generation - readyPromise resolves immediately now
    // (sync mechanism handles late subscribers)
    const startGeneration = async () => {
      if (voiceLatencyEnabled) {
        logVoiceLatencyStage(req, 'start_generation_enter', null, `stream_id=${streamId}`);
      }
      let readyGateTimedOut = false;
      const voiceReadyGateStart = voiceLatencyEnabled ? Date.now() : 0;
      try {
        // Short timeout as safety net - promise should already be resolved
        await Promise.race([
          job.readyPromise,
          new Promise((resolve) =>
            setTimeout(() => {
              readyGateTimedOut = true;
              resolve();
            }, 100),
          ),
        ]);
      } catch (waitError) {
        logger.warn(
          `[ResumableAgentController] Error waiting for subscriber: ${waitError.message}`,
        );
        if (voiceLatencyEnabled) {
          logVoiceLatencyStage(
            req,
            'ready_promise_wait_error',
            voiceReadyGateStart,
            `stream_id=${streamId} reason=${waitError?.message || 'unknown'}`,
          );
        }
      }
      if (voiceLatencyEnabled) {
        logVoiceLatencyStage(
          req,
          'ready_promise_wait_done',
          voiceReadyGateStart,
          `stream_id=${streamId} timed_out=${readyGateTimedOut}`,
        );
      }

      try {
        const onStart = async (userMsg, respMsgId, _isNewConvo) => {
          userMessage = userMsg;
          responseMessageId = respMsgId;
          generationStartedAt = Date.now();

          try {
            const snapshot = await persistAssistantSnapshot({
              req,
              streamId,
              userId,
              client,
              conversationId,
              aggregatedContent: [],
              userMessage,
              responseMessageId,
              sender,
              fallbackText: 'Generation in progress.',
              unfinished: true,
              error: false,
              context: 'api/server/controllers/agents/request.js - initial assistant placeholder',
            });
            if (snapshot.persisted) {
              placeholderSnapshotSaved = true;
              lastAssistantSnapshotFingerprint = snapshot.fingerprint;
            }
          } catch (snapshotError) {
            logger.warn(
              `[ResumableAgentController] Failed initial assistant placeholder for ${streamId}: ${snapshotError?.message || 'unknown'}`,
            );
          }

          // Store userMessage and responseMessageId upfront for resume capability
          await GenerationJobManager.updateMetadata(streamId, {
            responseMessageId: respMsgId,
            userMessage: {
              messageId: userMsg.messageId,
              parentMessageId: userMsg.parentMessageId,
              conversationId: userMsg.conversationId,
              text: userMsg.text,
            },
          });

          await GenerationJobManager.emitChunk(streamId, {
            created: true,
            message: userMessage,
            streamId,
          });
        };

        const startPartialCheckpointing = () => {
          if (partialCheckpointTimer) {
            return;
          }

          partialCheckpointTimer = setInterval(async () => {
            if (job.abortController.signal.aborted) {
              return;
            }

            try {
              const contentParts = Array.isArray(client?.contentParts)
                ? client.contentParts.filter(Boolean)
                : [];
              const extractedText = extractTextFromContentParts(contentParts);
              const hasMeaningfulContent = contentParts.length > 0 || extractedText.length > 0;

              let fallbackText = '';
              if (
                !hasMeaningfulContent &&
                !placeholderSnapshotSaved &&
                generationStartedAt != null &&
                Date.now() - generationStartedAt >= PARTIAL_RESPONSE_PLACEHOLDER_DELAY_MS
              ) {
                fallbackText = 'Generation in progress.';
              }

              if (!hasMeaningfulContent && !fallbackText) {
                return;
              }

              const snapshot = await persistAssistantSnapshot({
                req,
                streamId,
                userId,
                client,
                conversationId,
                aggregatedContent: contentParts,
                userMessage,
                responseMessageId,
                sender,
                fallbackText,
                unfinished: true,
                error: false,
                context: 'api/server/controllers/agents/request.js - periodic assistant snapshot',
              });

              if (
                !snapshot.persisted ||
                snapshot.fingerprint === lastAssistantSnapshotFingerprint
              ) {
                return;
              }

              if (fallbackText) {
                placeholderSnapshotSaved = true;
              }
              lastAssistantSnapshotFingerprint = snapshot.fingerprint;
            } catch (snapshotError) {
              logger.warn(
                `[ResumableAgentController] Failed periodic assistant snapshot for ${streamId}: ${snapshotError?.message || 'unknown'}`,
              );
            }
          }, PARTIAL_RESPONSE_CHECKPOINT_MS);
        };

        const messageOptions = {
          user: userId,
          onStart,
          getReqData,
          isContinued,
          isRegenerate,
          editedContent,
          conversationId,
          parentMessageId,
          abortController: job.abortController,
          overrideParentMessageId,
          isEdited: !!editedContent,
          userMCPAuthMap: result.userMCPAuthMap,
          responseMessageId: editedResponseMessageId,
          progressOptions: {
            res: {
              write: () => true,
              end: () => {},
              headersSent: false,
              writableEnded: false,
            },
          },
        };

        const voiceSendMessageStart = voiceLatencyEnabled ? Date.now() : 0;
        if (voiceLatencyEnabled) {
          logVoiceLatencyStage(req, 'send_message_start', null, `stream_id=${streamId}`);
        }
        startPartialCheckpointing();
        const response = await client.sendMessage(text, messageOptions);
        stopPartialCheckpointing();
        if (voiceLatencyEnabled) {
          logVoiceLatencyStage(
            req,
            'send_message_done',
            voiceSendMessageStart,
            `stream_id=${streamId} message_id=${response?.messageId || 'unknown'}`,
          );
        }

        const messageId = response.messageId;
        const endpoint = endpointOption.endpoint;
        response.endpoint = endpoint;

        const databasePromise = response.databasePromise;
        delete response.databasePromise;

        const { conversation: convoData = {} } = await databasePromise;
        const conversation = { ...convoData };
        conversation.title =
          conversation && !conversation.title ? null : conversation?.title || 'New Chat';

        if (req.body.files && client.options?.attachments) {
          userMessage.files = [];
          const messageFiles = new Set(req.body.files.map((file) => file.file_id));
          for (const attachment of client.options.attachments) {
            if (messageFiles.has(attachment.file_id)) {
              userMessage.files.push(sanitizeFileForTransmit(attachment));
            }
          }
          delete userMessage.image_urls;
        }

        // Check abort state BEFORE calling completeJob (which triggers abort signal for cleanup)
        const wasAbortedBeforeComplete = job.abortController.signal.aborted;
        const isNewConvo = !reqConversationId || reqConversationId === 'new';
        const shouldGenerateTitle =
          addTitle &&
          parentMessageId === Constants.NO_PARENT &&
          isNewConvo &&
          !wasAbortedBeforeComplete;

        // Save user message BEFORE sending final event to avoid race condition
        // where client refetch happens before database is updated
        if (!client.skipSaveUserMessage && userMessage) {
          await timedSaveMessage(
            req,
            userMessage,
            { context: 'api/server/controllers/agents/request.js - resumable user message' },
            'db_save_user',
          );
        }

        // CRITICAL: Save response message BEFORE emitting final event.
        // This prevents race conditions where the client sends a follow-up message
        // before the response is saved to the database, causing orphaned parentMessageIds.
        if (client.savedMessageIds && !client.savedMessageIds.has(messageId)) {
          /* === VIVENTIUM NOTE ===
           * Feature: Strip voice control tags from persisted response text.
           * Purpose: Voice mode responses contain Cartesia SSML tags and bracket nonverbal markers
           * that TTS needs, but should not appear in the persisted message text.
           * The SSE stream (consumed by voice gateway for TTS) is unaffected.
           */
          const persistedResponse = {
            ...response,
            user: userId,
            unfinished: wasAbortedBeforeComplete,
          };
          if (Array.isArray(persistedResponse.content)) {
            persistedResponse.content = sanitizePersistedAssistantContent(
              req,
              persistedResponse.content,
            );
          }
          if (req.body?.voiceMode === true && typeof persistedResponse.text === 'string') {
            persistedResponse.text = stripVoiceControlTagsForDisplay(persistedResponse.text);
          }
          /* === VIVENTIUM NOTE END === */
          await timedSaveMessage(
            req,
            persistedResponse,
            { context: 'api/server/controllers/agents/request.js - resumable response end' },
            'db_save_response',
          );
        }

        // Check if our job was replaced by a new request before emitting
        // This prevents stale requests from emitting events to newer jobs
        const currentJob = await GenerationJobManager.getJob(streamId);
        const jobWasReplaced = !currentJob || currentJob.createdAt !== jobCreatedAt;

        if (jobWasReplaced) {
          stopPartialCheckpointing();
          logger.debug(`[ResumableAgentController] Skipping FINAL emit - job was replaced`, {
            streamId,
            originalCreatedAt: jobCreatedAt,
            currentCreatedAt: currentJob?.createdAt,
          });
          // Still decrement pending request since we incremented at start
          await decrementPendingRequest(userId);
          return;
        }

        if (!wasAbortedBeforeComplete) {
          /* === VIVENTIUM NOTE ===
           * Feature: Log empty responses for Telegram debugging.
           * Added: 2026-02-01
           */
          const hasResponseText = !!(
            response?.text ||
            (Array.isArray(response?.content) &&
              response.content.some((p) => p?.type === 'text' && (p?.text || p?.text?.value)))
          );
          if (!hasResponseText && req._viventiumTelegram) {
            logger.warn(
              `[ResumableAgentController] Empty response for Telegram: streamId=${streamId} ` +
                `contentLength=${response?.content?.length ?? 0} ` +
                `text=${!!response?.text} ` +
                `error=${!!response?.error}`,
            );
          }
          /* === VIVENTIUM NOTE END === */

          const finalEvent = {
            final: true,
            conversation,
            title: conversation.title,
            requestMessage: sanitizeMessageForTransmit(userMessage),
            responseMessage: { ...response },
          };

          logger.debug(`[ResumableAgentController] Emitting FINAL event`, {
            streamId,
            wasAbortedBeforeComplete,
            userMessageId: userMessage?.messageId,
            responseMessageId: response?.messageId,
            conversationId: conversation?.conversationId,
          });

          await GenerationJobManager.emitDone(streamId, finalEvent);
          await maybeDecrement();

          /* === VIVENTIUM START ===
           * Feature: Phase B follow-up SSE delivery window.
           *
           * Why:
           * - `completeJob()` aborts runtime + tears down stream state.
           * - Phase B follow-up emits after FINAL in an async promise chain.
           * - Completing immediately can drop `on_cortex_followup` chunks.
           *
           * Approach:
           * - FINAL is still emitted immediately (no user-visible latency regression).
           * - Keep stream runtime alive briefly for Phase B follow-up emission, bounded by timeout.
           */
          const phaseBPromise = client?._phaseBPromise;
          if (phaseBPromise && typeof phaseBPromise.then === 'function') {
            const rawTimeout = Number(process.env.VIVENTIUM_PHASE_B_STREAM_WAIT_MS);
            const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 180_000;
            try {
              await Promise.race([
                phaseBPromise,
                new Promise((resolve) => setTimeout(resolve, timeoutMs)),
              ]);
            } catch (phaseBError) {
              logger.warn(
                '[ResumableAgentController] Phase B wait failed before completeJob:',
                phaseBError?.message ?? String(phaseBError),
              );
            }
          }
          /* === VIVENTIUM END === */

          stopPartialCheckpointing();
          GenerationJobManager.completeJob(streamId);
        } else {
          const finalEvent = {
            final: true,
            conversation,
            title: conversation.title,
            requestMessage: sanitizeMessageForTransmit(userMessage),
            responseMessage: { ...response, unfinished: true },
          };

          logger.debug(`[ResumableAgentController] Emitting ABORTED FINAL event`, {
            streamId,
            wasAbortedBeforeComplete,
            userMessageId: userMessage?.messageId,
            responseMessageId: response?.messageId,
            conversationId: conversation?.conversationId,
          });

          await GenerationJobManager.emitDone(streamId, finalEvent);
          stopPartialCheckpointing();
          GenerationJobManager.completeJob(streamId, 'Request aborted');
          await maybeDecrement();
        }

        if (shouldGenerateTitle) {
          addTitle(req, {
            text,
            response: { ...response },
            client,
          })
            .catch((err) => {
              logger.error('[ResumableAgentController] Error in title generation', err);
            })
            .finally(() => {
              if (client) {
                disposeClient(client);
              }
            });
        } else {
          if (client) {
            disposeClient(client);
          }
        }
      } catch (error) {
        stopPartialCheckpointing();
        // Check if this was an abort (not a real error)
        const wasAborted = job.abortController.signal.aborted || error.message?.includes('abort');

        if (wasAborted) {
          logger.debug(`[ResumableAgentController] Generation aborted for ${streamId}`);
          // abortJob already handled emitDone and completeJob
        } else {
          if (voiceLatencyEnabled) {
            logVoiceLatencyStage(
              req,
              'send_message_error',
              null,
              `stream_id=${streamId} reason=${error?.message || 'unknown'}`,
            );
          }
          logger.error(`[ResumableAgentController] Generation error for ${streamId}:`, error);
          try {
            const contentParts = Array.isArray(client?.contentParts)
              ? client.contentParts.filter(Boolean)
              : [];
            const hasMeaningfulContent =
              contentParts.length > 0 || extractTextFromContentParts(contentParts).length > 0;
            const snapshot = await persistAssistantSnapshot({
              req,
              streamId,
              userId,
              client,
              conversationId,
              aggregatedContent: contentParts,
              userMessage,
              responseMessageId,
              sender,
              fallbackText: hasMeaningfulContent ? '' : 'Generation interrupted before completion.',
              unfinished: hasMeaningfulContent,
              error: !hasMeaningfulContent,
              context: 'api/server/controllers/agents/request.js - generation error snapshot',
            });
            if (snapshot.persisted) {
              lastAssistantSnapshotFingerprint = snapshot.fingerprint;
            }
          } catch (snapshotError) {
            logger.error(
              `[ResumableAgentController] Failed to persist generation error snapshot for ${streamId}:`,
              snapshotError,
            );
          }
          await GenerationJobManager.emitError(streamId, error.message || 'Generation failed');
          GenerationJobManager.completeJob(streamId, error.message);
        }

        await maybeDecrement();

        if (client) {
          disposeClient(client);
        }

        // Don't continue to title generation after error/abort
        return;
      }
    };

    // Start generation and handle any unhandled errors
    startGeneration().catch(async (err) => {
      stopPartialCheckpointing();
      logger.error(
        `[ResumableAgentController] Unhandled error in background generation: ${err.message}`,
      );
      try {
        const contentParts = Array.isArray(client?.contentParts)
          ? client.contentParts.filter(Boolean)
          : [];
        await persistAssistantSnapshot({
          req,
          streamId,
          userId,
          client,
          conversationId,
          aggregatedContent: contentParts,
          userMessage,
          responseMessageId,
          sender,
          fallbackText: contentParts.length > 0 ? '' : 'Generation interrupted before completion.',
          unfinished: contentParts.length > 0,
          error: contentParts.length === 0,
          context: 'api/server/controllers/agents/request.js - unhandled generation error snapshot',
        });
      } catch (snapshotError) {
        logger.error(
          `[ResumableAgentController] Failed to persist unhandled generation error snapshot for ${streamId}:`,
          snapshotError,
        );
      }
      GenerationJobManager.completeJob(streamId, err.message);
      await maybeDecrement();
    });
  } catch (error) {
    logger.error('[ResumableAgentController] Initialization error:', error);
    if (error?.stack) {
      logger.error('[ResumableAgentController] Initialization stack:', error.stack);
    }
    if (error?.cause) {
      logger.error('[ResumableAgentController] Initialization cause:', error.cause);
      if (error.cause?.stack) {
        logger.error('[ResumableAgentController] Initialization cause stack:', error.cause.stack);
      }
    }
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Failed to start generation' });
    } else {
      // JSON already sent, emit error to stream so client can receive it
      await GenerationJobManager.emitError(streamId, error.message || 'Failed to start generation');
    }
    GenerationJobManager.completeJob(streamId, error.message);
    await maybeDecrement();
    if (client) {
      disposeClient(client);
    }
  }
};

/**
 * Agent Controller - Routes to ResumableAgentController for all requests.
 * The legacy non-resumable path is kept below but no longer used by default.
 */
const AgentController = async (req, res, next, initializeClient, addTitle) => {
  return ResumableAgentController(req, res, next, initializeClient, addTitle);
};

/**
 * Legacy Non-resumable Agent Controller - Uses GenerationJobManager for abort handling.
 * Response is streamed directly to client via res, but abort state is managed centrally.
 * @deprecated Use ResumableAgentController instead
 */
const _LegacyAgentController = async (req, res, next, initializeClient, addTitle) => {
  const {
    text,
    isRegenerate,
    endpointOption,
    conversationId: reqConversationId,
    isContinued = false,
    editedContent = null,
    parentMessageId = null,
    overrideParentMessageId = null,
    responseMessageId: editedResponseMessageId = null,
  } = req.body;

  // Generate conversationId upfront if not provided.
  // Treat "new" as a placeholder that needs a real UUID (frontend may send "new" for new convos)
  const conversationId =
    !reqConversationId || reqConversationId === 'new' ? crypto.randomUUID() : reqConversationId;
  /* === VIVENTIUM NOTE ===
   * Feature: Allow caller-supplied streamId to avoid stream collisions (Telegram).
   * === VIVENTIUM NOTE END === */
  const reqStreamId = typeof req.body?.streamId === 'string' ? req.body.streamId.trim() : '';
  const streamId = reqStreamId && reqStreamId !== 'new' ? reqStreamId : conversationId;

  let userMessage;
  let userMessageId;
  let responseMessageId;
  let client = null;
  let cleanupHandlers = [];

  // Match the same logic used for conversationId generation above
  const isNewConvo = !reqConversationId || reqConversationId === 'new';
  const userId = req.user.id;

  // Create handler to avoid capturing the entire parent scope
  let getReqData = (data = {}) => {
    for (let key in data) {
      if (key === 'userMessage') {
        userMessage = data[key];
        userMessageId = data[key].messageId;
      } else if (key === 'responseMessageId') {
        responseMessageId = data[key];
      } else if (key === 'promptTokens') {
        // Update job metadata with prompt tokens for abort handling
        GenerationJobManager.updateMetadata(streamId, { promptTokens: data[key] });
      } else if (key === 'sender') {
        GenerationJobManager.updateMetadata(streamId, { sender: data[key] });
      }
      // conversationId is pre-generated, no need to update from callback
    }
  };

  // Create a function to handle final cleanup
  const performCleanup = async () => {
    logger.debug('[AgentController] Performing cleanup');
    if (Array.isArray(cleanupHandlers)) {
      for (const handler of cleanupHandlers) {
        try {
          if (typeof handler === 'function') {
            handler();
          }
        } catch (e) {
          logger.error('[AgentController] Error in cleanup handler', e);
        }
      }
    }

    // Complete the job in GenerationJobManager
    if (streamId) {
      logger.debug('[AgentController] Completing job in GenerationJobManager');
      await GenerationJobManager.completeJob(streamId);
    }

    // Dispose client properly
    if (client) {
      disposeClient(client);
    }

    // Clear all references
    client = null;
    getReqData = null;
    userMessage = null;
    cleanupHandlers = null;

    // Clear request data map
    if (requestDataMap.has(req)) {
      requestDataMap.delete(req);
    }
    logger.debug('[AgentController] Cleanup completed');
  };

  try {
    let prelimAbortController = new AbortController();
    const prelimCloseHandler = createCloseHandler(prelimAbortController);
    res.on('close', prelimCloseHandler);
    const removePrelimHandler = (manual) => {
      try {
        prelimCloseHandler(manual);
        res.removeListener('close', prelimCloseHandler);
      } catch (e) {
        logger.error('[AgentController] Error removing close listener', e);
      }
    };
    cleanupHandlers.push(removePrelimHandler);

    /** @type {{ client: TAgentClient; userMCPAuthMap?: Record<string, Record<string, string>> }} */
    const result = await initializeClient({
      req,
      res,
      endpointOption,
      signal: prelimAbortController.signal,
    });

    if (prelimAbortController.signal?.aborted) {
      prelimAbortController = null;
      throw new Error('Request was aborted before initialization could complete');
    } else {
      prelimAbortController = null;
      removePrelimHandler(true);
      cleanupHandlers.pop();
    }
    client = result.client;

    // Register client with finalization registry if available
    if (clientRegistry) {
      clientRegistry.register(client, { userId }, client);
    }

    // Store request data in WeakMap keyed by req object
    requestDataMap.set(req, { client });

    // Create job in GenerationJobManager for abort handling
    // streamId === conversationId (pre-generated above)
    const job = await GenerationJobManager.createJob(streamId, userId, conversationId);

    // Store endpoint metadata for abort handling
    GenerationJobManager.updateMetadata(streamId, {
      endpoint: endpointOption.endpoint,
      iconURL: endpointOption.iconURL,
      model: endpointOption.modelOptions?.model || endpointOption.model_parameters?.model,
      sender: client?.sender,
    });

    // Store content parts reference for abort
    if (client?.contentParts) {
      GenerationJobManager.setContentParts(streamId, client.contentParts);
    }

    const closeHandler = createCloseHandler(job.abortController);
    res.on('close', closeHandler);
    cleanupHandlers.push(() => {
      try {
        res.removeListener('close', closeHandler);
      } catch (e) {
        logger.error('[AgentController] Error removing close listener', e);
      }
    });

    /**
     * onStart callback - stores user message and response ID for abort handling
     */
    const onStart = (userMsg, respMsgId, _isNewConvo) => {
      sendEvent(res, { message: userMsg, created: true });
      userMessage = userMsg;
      userMessageId = userMsg.messageId;
      responseMessageId = respMsgId;

      // Store metadata for abort handling (conversationId is pre-generated)
      GenerationJobManager.updateMetadata(streamId, {
        responseMessageId: respMsgId,
        userMessage: {
          messageId: userMsg.messageId,
          parentMessageId: userMsg.parentMessageId,
          conversationId,
          text: userMsg.text,
        },
      });
    };

    const messageOptions = {
      user: userId,
      onStart,
      getReqData,
      isContinued,
      isRegenerate,
      editedContent,
      conversationId,
      parentMessageId,
      abortController: job.abortController,
      overrideParentMessageId,
      isEdited: !!editedContent,
      userMCPAuthMap: result.userMCPAuthMap,
      responseMessageId: editedResponseMessageId,
      progressOptions: {
        res,
      },
    };

    let response = await client.sendMessage(text, messageOptions);

    // Extract what we need and immediately break reference
    const messageId = response.messageId;
    const endpoint = endpointOption.endpoint;
    response.endpoint = endpoint;

    // Store database promise locally
    const databasePromise = response.databasePromise;
    delete response.databasePromise;

    // Resolve database-related data
    const { conversation: convoData = {} } = await databasePromise;
    const conversation = { ...convoData };
    conversation.title =
      conversation && !conversation.title ? null : conversation?.title || 'New Chat';

    // Process files if needed (sanitize to remove large text fields before transmission)
    if (req.body.files && client.options?.attachments) {
      userMessage.files = [];
      const messageFiles = new Set(req.body.files.map((file) => file.file_id));
      for (const attachment of client.options.attachments) {
        if (messageFiles.has(attachment.file_id)) {
          userMessage.files.push(sanitizeFileForTransmit(attachment));
        }
      }
      delete userMessage.image_urls;
    }

    // Only send if not aborted
    if (!job.abortController.signal.aborted) {
      // Create a new response object with minimal copies
      const finalResponse = { ...response };

      sendEvent(res, {
        final: true,
        conversation,
        title: conversation.title,
        requestMessage: sanitizeMessageForTransmit(userMessage),
        responseMessage: finalResponse,
      });
      res.end();

      // Save the message if needed
      if (client.savedMessageIds && !client.savedMessageIds.has(messageId)) {
        /* === VIVENTIUM NOTE ===
         * Feature: Strip voice control tags from persisted response text (non-resumable path).
         */
        const persistedFinalResponse = { ...finalResponse, user: userId };
        if (Array.isArray(persistedFinalResponse.content)) {
          persistedFinalResponse.content = sanitizePersistedAssistantContent(
            req,
            persistedFinalResponse.content,
          );
        }
        if (req.body?.voiceMode === true && typeof persistedFinalResponse.text === 'string') {
          persistedFinalResponse.text = stripVoiceControlTagsForDisplay(
            persistedFinalResponse.text,
          );
        }
        /* === VIVENTIUM NOTE END === */
        await timedSaveMessage(
          req,
          persistedFinalResponse,
          { context: 'api/server/controllers/agents/request.js - response end' },
          'db_save_response',
        );
      }
    }
    // Edge case: sendMessage completed but abort happened during sendCompletion
    // We need to ensure a final event is sent
    else if (!res.headersSent && !res.finished) {
      logger.debug(
        '[AgentController] Handling edge case: `sendMessage` completed but aborted during `sendCompletion`',
      );

      const finalResponse = { ...response };
      finalResponse.error = true;

      sendEvent(res, {
        final: true,
        conversation,
        title: conversation.title,
        requestMessage: sanitizeMessageForTransmit(userMessage),
        responseMessage: finalResponse,
        error: { message: 'Request was aborted during completion' },
      });
      res.end();
    }

    // Save user message if needed
    if (!client.skipSaveUserMessage) {
      await timedSaveMessage(
        req,
        userMessage,
        { context: "api/server/controllers/agents/request.js - don't skip saving user message" },
        'db_save_user',
      );
    }

    // Add title if needed - extract minimal data
    if (addTitle && parentMessageId === Constants.NO_PARENT && isNewConvo) {
      addTitle(req, {
        text,
        response: { ...response },
        client,
      })
        .then(() => {
          logger.debug('[AgentController] Title generation started');
        })
        .catch((err) => {
          logger.error('[AgentController] Error in title generation', err);
        })
        .finally(() => {
          logger.debug('[AgentController] Title generation completed');
          performCleanup();
        });
    } else {
      performCleanup();
    }
  } catch (error) {
    // Handle error without capturing much scope
    handleAbortError(res, req, error, {
      conversationId,
      sender: client?.sender,
      messageId: responseMessageId,
      parentMessageId: overrideParentMessageId ?? userMessageId ?? parentMessageId,
      userMessageId,
    })
      .catch((err) => {
        logger.error('[api/server/controllers/agents/request] Error in `handleAbortError`', err);
      })
      .finally(() => {
        performCleanup();
      });
  }
};

module.exports = AgentController;
module.exports.ResumableAgentController = ResumableAgentController;
module.exports.__testables = {
  extractTextFromContentParts,
  sanitizePersistedAssistantContent,
  sanitizePersistedAssistantText,
  persistAssistantSnapshot,
};

/* === VIVENTIUM END === */
