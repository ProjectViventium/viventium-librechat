const { nanoid } = require('nanoid');
const { Constants } = require('@librechat/agents');
const { logger } = require('@librechat/data-schemas');
const {
  sendEvent,
  GenerationJobManager,
  writeAttachmentEvent,
  createToolExecuteHandler,
} = require('@librechat/api');
const { Tools, StepTypes, FileContext, ErrorTypes } = require('librechat-data-provider');
const {
  EnvVar,
  Providers,
  GraphEvents,
  getMessageId,
  ToolEndHandler,
  handleToolCalls,
} = require('@librechat/agents');
const { processFileCitations } = require('~/server/services/Files/Citations');
const { processCodeOutput } = require('~/server/services/Files/Code/process');
const { loadAuthValues } = require('~/server/services/Tools/credentials');
const { saveBase64Image } = require('~/server/services/Files/process');
/* === VIVENTIUM START ===
 * Feature: Deep Telegram timing instrumentation (toggleable)
 * Purpose: Add request-scoped timing logs for Telegram streams (cold starts, latency hotspots) without affecting other surfaces.
 * Added: 2026-02-07
 */
const {
  isDeepTimingEnabled,
  logDeepTiming,
} = require('~/server/services/viventium/telegramTimingDeep');
/* === VIVENTIUM END === */

/* === VIVENTIUM NOTE ===
 * Feature: Voice latency stage logging inside stream handlers.
 * Purpose: Mark first delta and tool-step milestones relative to process_stream_start.
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

const getVoiceProcessStreamStartAt = (req) =>
  typeof req?._viventiumVoiceProcessStreamStartedAt === 'number'
    ? req._viventiumVoiceProcessStreamStartedAt
    : null;

const logVoiceLatencyStage = (req, stage, stageStartAt = null, details = '') => {
  if (!isVoiceLatencyEnabled(req)) {
    return;
  }
  const now = Date.now();
  const routeStartAt = typeof req?.viventiumVoiceStartAt === 'number' ? req.viventiumVoiceStartAt : now;
  const stageMs = typeof stageStartAt === 'number' ? now - stageStartAt : null;
  const requestId = getVoiceLatencyRequestId(req);
  const stagePart = stageMs == null ? '' : ` stage_ms=${stageMs}`;
  const detailPart = details ? ` ${details}` : '';
  logger.info(
    `[VoiceLatency][LC] stage=${stage} request_id=${requestId} total_ms=${now - routeStartAt}${stagePart}${detailPart}`,
  );
};

/* === VIVENTIUM START ===
 * Feature: Voice orchestration event timeline (compact per-turn telemetry state).
 * Purpose: Capture first-occurrence timestamps and event counts with low log volume.
 * Added: 2026-03-03
 */
const getOrInitVoiceOrchState = (req) => {
  if (!req) {
    return null;
  }
  if (!req._viventiumVoiceOrchState || typeof req._viventiumVoiceOrchState !== 'object') {
    req._viventiumVoiceOrchState = {
      firstTs: Object.create(null),
      counts: Object.create(null),
    };
  }
  return req._viventiumVoiceOrchState;
};

const markVoiceOrchEvent = (req, eventKey) => {
  if (!isVoiceLatencyEnabled(req) || !eventKey) {
    return null;
  }
  const state = getOrInitVoiceOrchState(req);
  if (!state) {
    return null;
  }
  const now = Date.now();
  const prevCount = Number(state.counts[eventKey] || 0);
  state.counts[eventKey] = prevCount + 1;
  const firstSeen = state.firstTs[eventKey] == null;
  if (firstSeen) {
    state.firstTs[eventKey] = now;
  }
  return { firstSeen, now, count: state.counts[eventKey] };
};
/* === VIVENTIUM END === */
/* === VIVENTIUM NOTE END === */

class ModelEndHandler {
  /* === VIVENTIUM START ===
   * Feature: Deep Telegram timing instrumentation (toggleable)
   * Purpose: Thread `req` through ModelEndHandler so we can log model_end timing for Telegram streams.
   * Added: 2026-02-07
   */
  /**
   * @param {Array<UsageMetadata>} collectedUsage
   * @param {import('http').IncomingMessage | undefined} req
   */
  constructor(collectedUsage, req) {
    if (!Array.isArray(collectedUsage)) {
      throw new Error('collectedUsage must be an array');
    }
    this.collectedUsage = collectedUsage;
    this.req = req;
  }
  /* === VIVENTIUM END === */

  finalize(errorMessage) {
    if (!errorMessage) {
      return;
    }
    throw new Error(errorMessage);
  }

  /**
   * @param {string} event
   * @param {ModelEndData | undefined} data
   * @param {Record<string, unknown> | undefined} metadata
   * @param {StandardGraph} graph
   * @returns {Promise<void>}
   */
  async handle(event, data, metadata, graph) {
    if (!graph || !metadata) {
      console.warn(`Graph or metadata not found in ${event} event`);
      return;
    }

    /** @type {string | undefined} */
    let errorMessage;
    try {
      const agentContext = graph.getAgentContext(metadata);
      const isGoogle = agentContext.provider === Providers.GOOGLE;
      const streamingDisabled = !!agentContext.clientOptions?.disableStreaming;
      if (data?.output?.additional_kwargs?.stop_reason === 'refusal') {
        const info = { ...data.output.additional_kwargs };
        errorMessage = JSON.stringify({
          type: ErrorTypes.REFUSAL,
          info,
        });
        logger.debug(`[ModelEndHandler] Model refused to respond`, {
          ...info,
          userId: metadata.user_id,
          messageId: metadata.run_id,
          conversationId: metadata.thread_id,
        });
      }

      const toolCalls = data?.output?.tool_calls;
      let hasUnprocessedToolCalls = false;
      if (Array.isArray(toolCalls) && toolCalls.length > 0 && graph?.toolCallStepIds?.has) {
        try {
          hasUnprocessedToolCalls = toolCalls.some(
            (tc) => tc?.id && !graph.toolCallStepIds.has(tc.id),
          );
        } catch {
          hasUnprocessedToolCalls = false;
        }
      }
      if (isGoogle || streamingDisabled || hasUnprocessedToolCalls) {
        await handleToolCalls(toolCalls, metadata, graph);
      }

      const usage = data?.output?.usage_metadata;
      if (!usage) {
        return this.finalize(errorMessage);
      }
      const modelName = metadata?.ls_model_name || agentContext.clientOptions?.model;
      if (modelName) {
        usage.model = modelName;
      }

      this.collectedUsage.push(usage);
      /* === VIVENTIUM START ===
       * Feature: Deep Telegram timing instrumentation (toggleable)
       * Purpose: Log model_end timing for Telegram streams.
       * Added: 2026-02-07
       */
      if (isDeepTimingEnabled(this.req)) {
        logDeepTiming(this.req, 'model_end', null, `model=${usage.model || 'na'}`);
      }
      /* === VIVENTIUM END === */
      /* === VIVENTIUM START ===
       * Feature: Voice orchestration timeline marker for model end.
       * Added: 2026-03-03
       */
      const modelEndMetric = markVoiceOrchEvent(this.req, 'chat_model_end');
      if (modelEndMetric?.firstSeen) {
        logVoiceLatencyStage(
          this.req,
          'first_chat_model_end',
          getVoiceProcessStreamStartAt(this.req),
          `model=${usage.model || 'unknown'}`,
        );
      }
      /* === VIVENTIUM END === */
      if (!streamingDisabled) {
        return this.finalize(errorMessage);
      }
      if (!data.output.content) {
        return this.finalize(errorMessage);
      }
      const stepKey = graph.getStepKey(metadata);
      const message_id = getMessageId(stepKey, graph) ?? '';
      if (message_id) {
        await graph.dispatchRunStep(stepKey, {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: {
            message_id,
          },
        });
      }
      const stepId = graph.getStepIdByKey(stepKey);
      const content = data.output.content;
      if (typeof content === 'string') {
        await graph.dispatchMessageDelta(stepId, {
          content: [
            {
              type: 'text',
              text: content,
            },
          ],
        });
      } else if (content.every((c) => c.type?.startsWith('text'))) {
        await graph.dispatchMessageDelta(stepId, {
          content,
        });
      }
    } catch (error) {
      logger.error('Error handling model end event:', error);
      return this.finalize(errorMessage);
    }
  }
}

/**
 * @deprecated Agent Chain helper
 * @param {string | undefined} [last_agent_id]
 * @param {string | undefined} [langgraph_node]
 * @returns {boolean}
 */
function checkIfLastAgent(last_agent_id, langgraph_node) {
  if (!last_agent_id || !langgraph_node) {
    return false;
  }
  return langgraph_node?.endsWith(last_agent_id);
}

/**
 * Helper to emit events either to res (standard mode) or to job emitter (resumable mode).
 * In Redis mode, awaits the emit to guarantee event ordering (critical for streaming deltas).
 * @param {ServerResponse} res - The server response object
 * @param {string | null} streamId - The stream ID for resumable mode, or null for standard mode
 * @param {Object} eventData - The event data to send
 * @returns {Promise<void>}
 */
async function emitEvent(res, streamId, eventData) {
  if (streamId) {
    await GenerationJobManager.emitChunk(streamId, eventData);
  } else {
    sendEvent(res, eventData);
  }
}

/**
 * @typedef {Object} ToolExecuteOptions
 * @property {(toolNames: string[]) => Promise<{loadedTools: StructuredTool[]}>} loadTools - Function to load tools by name
 * @property {Object} configurable - Configurable context for tool invocation
 */

/**
 * Get default handlers for stream events.
 * @param {Object} options - The options object.
 * @param {ServerResponse} options.res - The server response object.
 * @param {ContentAggregator} options.aggregateContent - Content aggregator function.
 * @param {ToolEndCallback} options.toolEndCallback - Callback to use when tool ends.
 * @param {Array<UsageMetadata>} options.collectedUsage - The list of collected usage metadata.
 * @param {string | null} [options.streamId] - The stream ID for resumable mode, or null for standard mode.
 * @param {ToolExecuteOptions} [options.toolExecuteOptions] - Options for event-driven tool execution.
 * @returns {Record<string, t.EventHandler>} The default handlers.
 * @throws {Error} If the request is not found.
 */
function getDefaultHandlers({
  /* === VIVENTIUM START ===
   * Feature: Deep Telegram timing instrumentation (toggleable)
   * Purpose: Thread `req` into handler builder so we can log timing for Telegram streams.
   * Added: 2026-02-07
   */
  req,
  /* === VIVENTIUM END === */
  res,
  aggregateContent,
  toolEndCallback,
  collectedUsage,
  streamId = null,
  toolExecuteOptions = null,
}) {
  if (!res || !aggregateContent) {
    throw new Error(
      `[getDefaultHandlers] Missing required options: res: ${!res}, aggregateContent: ${!aggregateContent}`,
    );
  }
  /* === VIVENTIUM START ===
   * Feature: Deep Telegram timing instrumentation (toggleable)
   * Purpose: Track whether we've logged first model delta for this request (Telegram traces).
   * Added: 2026-02-07
   */
  const timingEnabled = isDeepTimingEnabled(req);
  if (timingEnabled && req && req._viventiumFirstDeltaLogged == null) {
    req._viventiumFirstDeltaLogged = false;
  }
  const voiceLatencyEnabled = isVoiceLatencyEnabled(req);
  if (voiceLatencyEnabled && req) {
    req._viventiumVoiceOrchState = {
      firstTs: Object.create(null),
      counts: Object.create(null),
    };
    if (req._viventiumVoiceFirstMessageDeltaLogged == null) {
      req._viventiumVoiceFirstMessageDeltaLogged = false;
    }
    if (req._viventiumVoiceFirstMessageDeltaEmittedLogged == null) {
      req._viventiumVoiceFirstMessageDeltaEmittedLogged = false;
    }
    if (req._viventiumVoiceFirstToolStepLogged == null) {
      req._viventiumVoiceFirstToolStepLogged = false;
    }
    if (req._viventiumVoiceFirstToolCompletedLogged == null) {
      req._viventiumVoiceFirstToolCompletedLogged = false;
    }
  }
  /* === VIVENTIUM END === */
  const handlers = {
    [GraphEvents.CHAT_MODEL_START]: {
      handle: async (_event, _data, metadata) => {
        const metric = markVoiceOrchEvent(req, 'chat_model_start');
        if (metric?.firstSeen) {
          const modelName =
            typeof metadata?.ls_model_name === 'string' && metadata.ls_model_name.length > 0
              ? metadata.ls_model_name
              : 'unknown';
          logVoiceLatencyStage(
            req,
            'first_chat_model_start',
            getVoiceProcessStreamStartAt(req),
            `model=${modelName}`,
          );
        }
      },
    },
    [GraphEvents.LLM_START]: {
      handle: async () => {
        const metric = markVoiceOrchEvent(req, 'llm_start');
        if (metric?.firstSeen) {
          logVoiceLatencyStage(req, 'first_llm_start', getVoiceProcessStreamStartAt(req), '');
        }
      },
    },
    [GraphEvents.LLM_STREAM]: {
      handle: async () => {
        const metric = markVoiceOrchEvent(req, 'llm_stream');
        if (metric?.firstSeen) {
          logVoiceLatencyStage(req, 'first_llm_stream', getVoiceProcessStreamStartAt(req), '');
        }
      },
    },
    [GraphEvents.PROMPT_START]: {
      handle: async (_event, _data, metadata) => {
        const metric = markVoiceOrchEvent(req, 'prompt_start');
        if (metric?.firstSeen) {
          const node =
            typeof metadata?.langgraph_node === 'string' && metadata.langgraph_node.length > 0
              ? metadata.langgraph_node
              : 'unknown';
          logVoiceLatencyStage(
            req,
            'first_prompt_start',
            getVoiceProcessStreamStartAt(req),
            `node=${node}`,
          );
        }
      },
    },
    [GraphEvents.PROMPT_END]: {
      handle: async (_event, _data, metadata) => {
        const metric = markVoiceOrchEvent(req, 'prompt_end');
        if (metric?.firstSeen) {
          const node =
            typeof metadata?.langgraph_node === 'string' && metadata.langgraph_node.length > 0
              ? metadata.langgraph_node
              : 'unknown';
          logVoiceLatencyStage(
            req,
            'first_prompt_end',
            getVoiceProcessStreamStartAt(req),
            `node=${node}`,
          );
        }
      },
    },
    [GraphEvents.CHAIN_START]: {
      handle: async (_event, _data, metadata) => {
        const metric = markVoiceOrchEvent(req, 'chain_start');
        if (metric?.firstSeen) {
          const node =
            typeof metadata?.langgraph_node === 'string' && metadata.langgraph_node.length > 0
              ? metadata.langgraph_node
              : 'unknown';
          logVoiceLatencyStage(
            req,
            'first_chain_start',
            getVoiceProcessStreamStartAt(req),
            `node=${node}`,
          );
        }
      },
    },
    [GraphEvents.CHAIN_END]: {
      handle: async (_event, _data, metadata) => {
        const metric = markVoiceOrchEvent(req, 'chain_end');
        if (metric?.firstSeen) {
          const node =
            typeof metadata?.langgraph_node === 'string' && metadata.langgraph_node.length > 0
              ? metadata.langgraph_node
              : 'unknown';
          logVoiceLatencyStage(
            req,
            'first_chain_end',
            getVoiceProcessStreamStartAt(req),
            `node=${node}`,
          );
        }
      },
    },
    /* === VIVENTIUM START ===
     * Feature: Deep Telegram timing instrumentation (toggleable)
     * Purpose: Provide req to ModelEndHandler so it can log model_end timing for Telegram streams.
     * Added: 2026-02-07
     */
    [GraphEvents.CHAT_MODEL_END]: new ModelEndHandler(collectedUsage, req),
    /* === VIVENTIUM END === */
    [GraphEvents.TOOL_END]: new ToolEndHandler(toolEndCallback, logger),
    [GraphEvents.ON_RUN_STEP]: {
      /**
       * Handle ON_RUN_STEP event.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: async (event, data, metadata) => {
        const runStepMetric = markVoiceOrchEvent(req, 'on_run_step');
        if (runStepMetric?.firstSeen) {
          logVoiceLatencyStage(
            req,
            'first_run_step',
            getVoiceProcessStreamStartAt(req),
            `step_type=${data?.stepDetails?.type || 'unknown'}`,
          );
        }
        if (voiceLatencyEnabled && data?.stepDetails?.type === StepTypes.TOOL_CALLS) {
          const toolCalls = Array.isArray(data?.stepDetails?.tool_calls)
            ? data.stepDetails.tool_calls
            : [];
          const toolNames = toolCalls
            .map((toolCall) => toolCall?.function?.name || toolCall?.name)
            .filter((name) => typeof name === 'string')
            .slice(0, 6)
            .join(',');
          const processStreamStartAt = getVoiceProcessStreamStartAt(req);
          logVoiceLatencyStage(
            req,
            'run_step_tool_calls',
            processStreamStartAt,
            `step_id=${data?.id || 'unknown'} calls=${toolCalls.length}${toolNames ? ` names=${toolNames}` : ''}`,
          );
          if (req && req._viventiumVoiceFirstToolStepLogged === false) {
            req._viventiumVoiceFirstToolStepLogged = true;
            logVoiceLatencyStage(
              req,
              'first_tool_call_step',
              processStreamStartAt,
              `step_id=${data?.id || 'unknown'} calls=${toolCalls.length}`,
            );
          }
        }
        if (data?.stepDetails.type === StepTypes.TOOL_CALLS) {
          await emitEvent(res, streamId, { event, data });
        } else if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          await emitEvent(res, streamId, { event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          await emitEvent(res, streamId, { event, data });
        } else {
          const agentName = metadata?.name ?? 'Agent';
          const isToolCall = data?.stepDetails.type === StepTypes.TOOL_CALLS;
          const action = isToolCall ? 'performing a task...' : 'thinking...';
          await emitEvent(res, streamId, {
            event: 'on_agent_update',
            data: {
              runId: metadata?.run_id,
              message: `${agentName} is ${action}`,
            },
          });
        }
        aggregateContent({ event, data });
      },
    },
    [GraphEvents.ON_RUN_STEP_DELTA]: {
      /**
       * Handle ON_RUN_STEP_DELTA event.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: async (event, data, metadata) => {
        const runStepDeltaMetric = markVoiceOrchEvent(req, 'on_run_step_delta');
        if (runStepDeltaMetric?.firstSeen) {
          logVoiceLatencyStage(
            req,
            'first_run_step_delta',
            getVoiceProcessStreamStartAt(req),
            `delta_type=${data?.delta?.type || 'unknown'}`,
          );
        }
        if (data?.delta.type === StepTypes.TOOL_CALLS) {
          await emitEvent(res, streamId, { event, data });
        } else if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          await emitEvent(res, streamId, { event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          await emitEvent(res, streamId, { event, data });
        }
        aggregateContent({ event, data });
      },
    },
    [GraphEvents.ON_RUN_STEP_COMPLETED]: {
      /**
       * Handle ON_RUN_STEP_COMPLETED event.
       * @param {string} event - The event name.
       * @param {StreamEventData & { result: ToolEndData }} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: async (event, data, metadata) => {
        const runStepCompletedMetric = markVoiceOrchEvent(req, 'on_run_step_completed');
        if (runStepCompletedMetric?.firstSeen) {
          logVoiceLatencyStage(
            req,
            'first_run_step_completed',
            getVoiceProcessStreamStartAt(req),
            `result_type=${data?.result?.type || 'unknown'}`,
          );
        }
        if (voiceLatencyEnabled && data?.result?.type === 'tool_call') {
          const toolCall = data?.result?.tool_call || {};
          const toolName = typeof toolCall?.name === 'string' ? toolCall.name : 'unknown';
          const toolId = typeof toolCall?.id === 'string' ? toolCall.id : 'unknown';
          const processStreamStartAt = getVoiceProcessStreamStartAt(req);
          logVoiceLatencyStage(
            req,
            'run_step_tool_call_completed',
            processStreamStartAt,
            `step_id=${data?.result?.id || 'unknown'} tool_name=${toolName} tool_id=${toolId}`,
          );
          if (req && req._viventiumVoiceFirstToolCompletedLogged === false) {
            req._viventiumVoiceFirstToolCompletedLogged = true;
            logVoiceLatencyStage(
              req,
              'first_tool_call_completed',
              processStreamStartAt,
              `tool_name=${toolName} tool_id=${toolId}`,
            );
          }
        }
        if (data?.result != null) {
          await emitEvent(res, streamId, { event, data });
        } else if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          await emitEvent(res, streamId, { event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          await emitEvent(res, streamId, { event, data });
        }
        aggregateContent({ event, data });
      },
    },
    [GraphEvents.ON_MESSAGE_DELTA]: {
      /**
       * Handle ON_MESSAGE_DELTA event.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: async (event, data, metadata) => {
        markVoiceOrchEvent(req, 'on_message_delta');
        /* === VIVENTIUM START ===
         * Feature: Deep Telegram timing instrumentation (toggleable)
         * Purpose: Log the first model delta for Telegram streams (helps pinpoint cold-start latency).
         * Added: 2026-02-07
         */
        if (
          timingEnabled &&
          req &&
          req._viventiumFirstDeltaLogged === false &&
          checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)
        ) {
          req._viventiumFirstDeltaLogged = true;
          logDeepTiming(req, 'model_first_delta');
        }
        /* === VIVENTIUM END === */
        if (
          voiceLatencyEnabled &&
          req &&
          req._viventiumVoiceFirstMessageDeltaLogged === false &&
          (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node) ||
            !metadata?.hide_sequential_outputs)
        ) {
          req._viventiumVoiceFirstMessageDeltaLogged = true;
          const processStreamStartAt = getVoiceProcessStreamStartAt(req);
          const deltaCount = Array.isArray(data?.delta?.content) ? data.delta.content.length : 0;
          logVoiceLatencyStage(
            req,
            'first_message_delta',
            processStreamStartAt,
            `delta_parts=${deltaCount}`,
          );
        }
        const shouldEmitLastAgent = checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node);
        const shouldEmit = shouldEmitLastAgent || !metadata?.hide_sequential_outputs;
        const emitStartedAt = shouldEmit ? Date.now() : null;

        if (shouldEmit) {
          await emitEvent(res, streamId, { event, data });
          if (
            voiceLatencyEnabled &&
            req &&
            req._viventiumVoiceFirstMessageDeltaEmittedLogged === false &&
            emitStartedAt != null
          ) {
            req._viventiumVoiceFirstMessageDeltaEmittedLogged = true;
            logVoiceLatencyStage(
              req,
              'first_message_delta_emit_done',
              emitStartedAt,
              `emit_target=${streamId ? 'generation_job' : 'http_sse'}`,
            );
          }
        }
        aggregateContent({ event, data });
      },
    },
    [GraphEvents.ON_REASONING_DELTA]: {
      /**
       * Handle ON_REASONING_DELTA event.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: async (event, data, metadata) => {
        const reasoningMetric = markVoiceOrchEvent(req, 'on_reasoning_delta');
        if (reasoningMetric?.firstSeen) {
          logVoiceLatencyStage(
            req,
            'first_reasoning_delta',
            getVoiceProcessStreamStartAt(req),
            '',
          );
        }
        if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          await emitEvent(res, streamId, { event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          await emitEvent(res, streamId, { event, data });
        }
        aggregateContent({ event, data });
      },
    },
  };

  if (toolExecuteOptions) {
    handlers[GraphEvents.ON_TOOL_EXECUTE] = createToolExecuteHandler(toolExecuteOptions);
  }

  return handlers;
}

/**
 * Helper to write attachment events either to res or to job emitter.
 * Note: Attachments are not order-sensitive like deltas, so fire-and-forget is acceptable.
 * @param {ServerResponse} res - The server response object
 * @param {string | null} streamId - The stream ID for resumable mode, or null for standard mode
 * @param {Object} attachment - The attachment data
 */
function writeAttachment(res, streamId, attachment) {
  if (streamId) {
    GenerationJobManager.emitChunk(streamId, { event: 'attachment', data: attachment });
  } else {
    res.write(`event: attachment\ndata: ${JSON.stringify(attachment)}\n\n`);
  }
}

/**
 *
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {ServerResponse} params.res
 * @param {Promise<MongoFile | { filename: string; filepath: string; expires: number;} | null>[]} params.artifactPromises
 * @param {string | null} [params.streamId] - The stream ID for resumable mode, or null for standard mode.
 * @returns {ToolEndCallback} The tool end callback.
 */
function createToolEndCallback({ req, res, artifactPromises, streamId = null }) {
  /**
   * @type {ToolEndCallback}
   */
  return async (data, metadata) => {
    const output = data?.output;
    if (!output) {
      return;
    }

    if (!output.artifact) {
      return;
    }

    if (output.artifact[Tools.file_search]) {
      artifactPromises.push(
        (async () => {
          const user = req.user;
          const attachment = await processFileCitations({
            user,
            metadata,
            appConfig: req.config,
            toolArtifact: output.artifact,
            toolCallId: output.tool_call_id,
          });
          if (!attachment) {
            return null;
          }
          if (!streamId && !res.headersSent) {
            return attachment;
          }
          writeAttachment(res, streamId, attachment);
          return attachment;
        })().catch((error) => {
          logger.error('Error processing file citations:', error);
          return null;
        }),
      );
    }

    if (output.artifact[Tools.ui_resources]) {
      artifactPromises.push(
        (async () => {
          const attachment = {
            type: Tools.ui_resources,
            messageId: metadata.run_id,
            toolCallId: output.tool_call_id,
            conversationId: metadata.thread_id,
            [Tools.ui_resources]: output.artifact[Tools.ui_resources].data,
          };
          if (!streamId && !res.headersSent) {
            return attachment;
          }
          writeAttachment(res, streamId, attachment);
          return attachment;
        })().catch((error) => {
          logger.error('Error processing artifact content:', error);
          return null;
        }),
      );
    }

    if (output.artifact[Tools.web_search]) {
      artifactPromises.push(
        (async () => {
          const attachment = {
            type: Tools.web_search,
            messageId: metadata.run_id,
            toolCallId: output.tool_call_id,
            conversationId: metadata.thread_id,
            [Tools.web_search]: { ...output.artifact[Tools.web_search] },
          };
          if (!streamId && !res.headersSent) {
            return attachment;
          }
          writeAttachment(res, streamId, attachment);
          return attachment;
        })().catch((error) => {
          logger.error('Error processing artifact content:', error);
          return null;
        }),
      );
    }

    if (output.artifact.content) {
      /** @type {FormattedContent[]} */
      const content = output.artifact.content;
      for (let i = 0; i < content.length; i++) {
        const part = content[i];
        if (!part) {
          continue;
        }
        if (part.type !== 'image_url') {
          continue;
        }
        const { url } = part.image_url;
        artifactPromises.push(
          (async () => {
            const filename = `${output.name}_img_${nanoid()}`;
            const file_id = output.artifact.file_ids?.[i];
            const file = await saveBase64Image(url, {
              req,
              file_id,
              filename,
              endpoint: metadata.provider,
              context: FileContext.image_generation,
            });
            const fileMetadata = Object.assign(file, {
              messageId: metadata.run_id,
              toolCallId: output.tool_call_id,
              conversationId: metadata.thread_id,
            });
            if (!streamId && !res.headersSent) {
              return fileMetadata;
            }

            if (!fileMetadata) {
              return null;
            }

            writeAttachment(res, streamId, fileMetadata);
            return fileMetadata;
          })().catch((error) => {
            logger.error('Error processing artifact content:', error);
            return null;
          }),
        );
      }
      return;
    }

    const isCodeTool =
      output.name === Tools.execute_code || output.name === Constants.PROGRAMMATIC_TOOL_CALLING;
    if (!isCodeTool) {
      return;
    }

    if (!output.artifact.files) {
      return;
    }

    for (const file of output.artifact.files) {
      const { id, name } = file;
      artifactPromises.push(
        (async () => {
          const result = await loadAuthValues({
            userId: req.user.id,
            authFields: [EnvVar.CODE_API_KEY],
          });
          const fileMetadata = await processCodeOutput({
            req,
            id,
            name,
            apiKey: result[EnvVar.CODE_API_KEY],
            messageId: metadata.run_id,
            toolCallId: output.tool_call_id,
            conversationId: metadata.thread_id,
            session_id: output.artifact.session_id,
          });
          if (!streamId && !res.headersSent) {
            return fileMetadata;
          }

          if (!fileMetadata) {
            return null;
          }

          writeAttachment(res, streamId, fileMetadata);
          return fileMetadata;
        })().catch((error) => {
          logger.error('Error processing code output:', error);
          return null;
        }),
      );
    }
  };
}

/**
 * Helper to write attachment events in Open Responses format (librechat:attachment)
 * @param {ServerResponse} res - The server response object
 * @param {Object} tracker - The response tracker with sequence number
 * @param {Object} attachment - The attachment data
 * @param {Object} metadata - Additional metadata (messageId, conversationId)
 */
function writeResponsesAttachment(res, tracker, attachment, metadata) {
  const sequenceNumber = tracker.nextSequence();
  writeAttachmentEvent(res, sequenceNumber, attachment, {
    messageId: metadata.run_id,
    conversationId: metadata.thread_id,
  });
}

/**
 * Creates a tool end callback specifically for the Responses API.
 * Emits attachments as `librechat:attachment` events per the Open Responses extension spec.
 *
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {ServerResponse} params.res
 * @param {Object} params.tracker - Response tracker with sequence number
 * @param {Promise<MongoFile | { filename: string; filepath: string; expires: number;} | null>[]} params.artifactPromises
 * @returns {ToolEndCallback} The tool end callback.
 */
function createResponsesToolEndCallback({ req, res, tracker, artifactPromises }) {
  /**
   * @type {ToolEndCallback}
   */
  return async (data, metadata) => {
    const output = data?.output;
    if (!output) {
      return;
    }

    if (!output.artifact) {
      return;
    }

    if (output.artifact[Tools.file_search]) {
      artifactPromises.push(
        (async () => {
          const user = req.user;
          const attachment = await processFileCitations({
            user,
            metadata,
            appConfig: req.config,
            toolArtifact: output.artifact,
            toolCallId: output.tool_call_id,
          });
          if (!attachment) {
            return null;
          }
          // For Responses API, emit attachment during streaming
          if (res.headersSent && !res.writableEnded) {
            writeResponsesAttachment(res, tracker, attachment, metadata);
          }
          return attachment;
        })().catch((error) => {
          logger.error('Error processing file citations:', error);
          return null;
        }),
      );
    }

    if (output.artifact[Tools.ui_resources]) {
      artifactPromises.push(
        (async () => {
          const attachment = {
            type: Tools.ui_resources,
            toolCallId: output.tool_call_id,
            [Tools.ui_resources]: output.artifact[Tools.ui_resources].data,
          };
          // For Responses API, always emit attachment during streaming
          if (res.headersSent && !res.writableEnded) {
            writeResponsesAttachment(res, tracker, attachment, metadata);
          }
          return attachment;
        })().catch((error) => {
          logger.error('Error processing artifact content:', error);
          return null;
        }),
      );
    }

    if (output.artifact[Tools.web_search]) {
      artifactPromises.push(
        (async () => {
          const attachment = {
            type: Tools.web_search,
            toolCallId: output.tool_call_id,
            [Tools.web_search]: { ...output.artifact[Tools.web_search] },
          };
          // For Responses API, always emit attachment during streaming
          if (res.headersSent && !res.writableEnded) {
            writeResponsesAttachment(res, tracker, attachment, metadata);
          }
          return attachment;
        })().catch((error) => {
          logger.error('Error processing artifact content:', error);
          return null;
        }),
      );
    }

    if (output.artifact.content) {
      /** @type {FormattedContent[]} */
      const content = output.artifact.content;
      for (let i = 0; i < content.length; i++) {
        const part = content[i];
        if (!part) {
          continue;
        }
        if (part.type !== 'image_url') {
          continue;
        }
        const { url } = part.image_url;
        artifactPromises.push(
          (async () => {
            const filename = `${output.name}_img_${nanoid()}`;
            const file_id = output.artifact.file_ids?.[i];
            const file = await saveBase64Image(url, {
              req,
              file_id,
              filename,
              endpoint: metadata.provider,
              context: FileContext.image_generation,
            });
            const fileMetadata = Object.assign(file, {
              toolCallId: output.tool_call_id,
            });

            if (!fileMetadata) {
              return null;
            }

            // For Responses API, emit attachment during streaming
            if (res.headersSent && !res.writableEnded) {
              const attachment = {
                file_id: fileMetadata.file_id,
                filename: fileMetadata.filename,
                type: fileMetadata.type,
                url: fileMetadata.filepath,
                width: fileMetadata.width,
                height: fileMetadata.height,
                tool_call_id: output.tool_call_id,
              };
              writeResponsesAttachment(res, tracker, attachment, metadata);
            }

            return fileMetadata;
          })().catch((error) => {
            logger.error('Error processing artifact content:', error);
            return null;
          }),
        );
      }
      return;
    }

    const isCodeTool =
      output.name === Tools.execute_code || output.name === Constants.PROGRAMMATIC_TOOL_CALLING;
    if (!isCodeTool) {
      return;
    }

    if (!output.artifact.files) {
      return;
    }

    for (const file of output.artifact.files) {
      const { id, name } = file;
      artifactPromises.push(
        (async () => {
          const result = await loadAuthValues({
            userId: req.user.id,
            authFields: [EnvVar.CODE_API_KEY],
          });
          const fileMetadata = await processCodeOutput({
            req,
            id,
            name,
            apiKey: result[EnvVar.CODE_API_KEY],
            messageId: metadata.run_id,
            toolCallId: output.tool_call_id,
            conversationId: metadata.thread_id,
            session_id: output.artifact.session_id,
          });

          if (!fileMetadata) {
            return null;
          }

          // For Responses API, emit attachment during streaming
          if (res.headersSent && !res.writableEnded) {
            const attachment = {
              file_id: fileMetadata.file_id,
              filename: fileMetadata.filename,
              type: fileMetadata.type,
              url: fileMetadata.filepath,
              width: fileMetadata.width,
              height: fileMetadata.height,
              tool_call_id: output.tool_call_id,
            };
            writeResponsesAttachment(res, tracker, attachment, metadata);
          }

          return fileMetadata;
        })().catch((error) => {
          logger.error('Error processing code output:', error);
          return null;
        }),
      );
    }
  };
}

module.exports = {
  getDefaultHandlers,
  createToolEndCallback,
  createResponsesToolEndCallback,
};
