const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');
/* === VIVENTIUM START ===
 * Feature: Deep Telegram timing instrumentation (toggleable)
 * Purpose: Trace Telegram request latency across agent initialization and handoff graph setup.
 *
 * Approach:
 * - Gate with isDeepTimingEnabled(req) and env VIVENTIUM_TELEGRAM_TIMING_DEEP.
 * - Use perf_hooks performance.now() and store a per-request base timestamp.
 * - Wrap key DB methods (getConvoFiles, getFiles, getUserKey, etc) to surface DB hotspots.
 * - Emit structured logs with traceId and step names so traces can be correlated across services.
 *
 * Added: 2026-02-07
 */
const { performance } = require('perf_hooks');
const {
  calcVoiceLatencyDurationMs,
  formatVoiceLatencyTiming,
  voiceLatencyNow,
} = require('~/server/services/viventium/voiceLatencyTiming');
const { createContentAggregator } = require('@librechat/agents');
const {
  initializeAgent,
  validateAgentModel,
  createEdgeCollector,
  filterOrphanedEdges,
  GenerationJobManager,
  getCustomEndpointConfig,
  createSequentialChainEdges,
  applyAgentProviderCapabilityDefaults,
} = require('@librechat/api');
const {
  EModelEndpoint,
  isAgentsEndpoint,
  getResponseSender,
  isEphemeralAgentId,
} = require('librechat-data-provider');
const {
  createToolEndCallback,
  getDefaultHandlers,
} = require('~/server/controllers/agents/callbacks');
const { loadAgentTools, loadToolsForExecution } = require('~/server/services/ToolService');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const AgentClient = require('~/server/controllers/agents/client');
const { getConvoFiles } = require('~/models/Conversation');
const { processAddedConvo } = require('./addedConvo');
const { getAgent } = require('~/models/Agent');
const { logViolation } = require('~/cache');
const {
  sanitizeAggregatedContentParts,
} = require('~/server/services/viventium/sanitizeAggregatedContentParts');
const {
  collapseRecoveredVisibleTextDuplicate,
  extractVisibleTextFromContentParts,
  repairMissedVisibleMessageDelta,
  repairMissedVoiceMessageDelta,
} = require('~/server/services/viventium/voiceDeltaAggregation');
const db = require('~/models');
const { isDeepTimingEnabled } = require('~/server/services/viventium/telegramTimingDeep');
const {
  createManageActiveTasksTool,
} = require('~/server/services/viventium/VoiceTaskManagementTool');
/* === VIVENTIUM START ===
 * Feature: Voice Chat LLM Override
 * Purpose: Reuse helper for primary + handoff agents before model validation.
 * Added: 2026-02-24
 */
const {
  applyVoiceModelOverride,
  isVoiceCallActive,
} = require('~/server/services/viventium/voiceLlmOverride');
const {
  resolveFallbackCandidates,
  isFallbackModelValid,
  buildFallbackAgent,
  inheritResolvedAgentGraph,
  isSameAgentRoute,
  initializePrimaryAgentWithFallback,
} = require('~/server/services/viventium/agentLlmFallback');
const {
  appendOmittedCapabilityReadiness,
  evaluateOptionalAgentCapabilityReadiness,
  markOptionalAgentInitializationFailed,
  synchronizeFallbackGraphResilience,
} = require('~/server/services/viventium/agentGraphResilience');
const {
  applyScheduledAgentOverride,
} = require('~/server/services/viventium/scheduledAgentOverride');
const {
  attachDeclaredConversationProviderCapabilityBundle,
  attachConversationProviderCapabilityBundle,
  bindHarnessCancellation,
  installConversationProviderCapabilityRefresher,
  resolveConversationProviderId,
  setConversationProviderCapability,
} = require('~/server/services/viventium/GlassHiveConversationProviderService');
const {
  resolveAgentCapabilityProvider,
  selectLibreChatAgentGraph,
} = require('~/server/services/viventium/agentCapabilityProvider');
const {
  emptyToolLoadResult,
  enforceRestrictedVoiceRequest,
  isVoiceActorSideEffectRestricted,
  sanitizeAgentForRestrictedVoiceTurn,
} = require('~/server/services/viventium/VoiceActorAuthorityService');
/* === VIVENTIUM END === */

/* === VIVENTIUM START ===
 * Feature: Voice init-layer latency instrumentation (compact summary).
 * Purpose: Attribute initializeClient overhead (MCP/tool/bootstrap path) per voice turn.
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

const calcVoiceStageMs = (startedAt) => {
  return calcVoiceLatencyDurationMs(startedAt);
};

const logVoiceInitLatencyStage = (req, stage, stageStartAt = null, details = '') => {
  if (!isVoiceLatencyEnabled(req)) {
    return;
  }
  const requestId = getVoiceLatencyRequestId(req);
  const timingPart = formatVoiceLatencyTiming(req, stageStartAt);
  const detailPart = details ? ` ${details}` : '';
  logger.info(
    `[VoiceLatency][LC] stage=${stage} request_id=${requestId} ${timingPart}${detailPart}`,
  );
};

const hashToolNames = (names) => {
  if (!Array.isArray(names) || names.length === 0) {
    return 'none';
  }
  return crypto.createHash('sha1').update(names.join('|')).digest('hex').slice(0, 12);
};

const collectToolNames = (value) => {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }
      if (typeof item.name === 'string') {
        return item.name;
      }
      if (item.function && typeof item.function?.name === 'string') {
        return item.function.name;
      }
      return '';
    })
    .filter((name) => name.length > 0);
};

const summarizeInitTools = (config) => {
  const toolDefinitions = Array.isArray(config?.toolDefinitions) ? config.toolDefinitions : [];
  const definitionNames = collectToolNames(toolDefinitions);
  const registrySize =
    config?.toolRegistry && typeof config.toolRegistry?.size === 'number'
      ? config.toolRegistry.size
      : 0;
  const mcpAuthServers =
    config?.userMCPAuthMap && typeof config.userMCPAuthMap === 'object'
      ? Object.keys(config.userMCPAuthMap).length
      : 0;

  return {
    toolDefinitionsCount: toolDefinitions.length,
    toolNamesHash: hashToolNames(definitionNames),
    toolNamesSample: definitionNames.slice(0, 10).join(',') || 'none',
    toolRegistrySize: registrySize,
    mcpAuthServers,
  };
};
/* === VIVENTIUM END === */

/**
 * Creates a tool loader function for the agent.
 * @param {AbortSignal} signal - The abort signal
 * @param {string | null} [streamId] - The stream ID for resumable mode
 * @param {boolean} [definitionsOnly=false] - When true, returns only serializable
 *   tool definitions without creating full tool instances (for event-driven mode)
 */
function createToolLoader(signal, streamId = null, definitionsOnly = false) {
  /**
   * @param {object} params
   * @param {ServerRequest} params.req
   * @param {ServerResponse} params.res
   * @param {string} params.agentId
   * @param {string[]} params.tools
   * @param {string} params.provider
   * @param {string} params.model
   * @param {AgentToolResources} params.tool_resources
   * @returns {Promise<{
   *   tools?: StructuredTool[],
   *   toolContextMap: Record<string, unknown>,
   *   toolDefinitions?: import('@librechat/agents').LCTool[],
   *   userMCPAuthMap?: Record<string, Record<string, string>>,
   *   toolRegistry?: import('@librechat/agents').LCToolRegistry
   * } | undefined>}
   */
  return async function loadTools({
    req,
    res,
    tools,
    model,
    agentId,
    provider,
    tool_options,
    tool_resources,
  }) {
    if (isVoiceActorSideEffectRestricted(req)) {
      return emptyToolLoadResult();
    }
    const agent = { id: agentId, tools, provider, model, tool_options };
    try {
      return await loadAgentTools({
        req,
        res,
        agent,
        signal,
        streamId,
        tool_resources,
        definitionsOnly,
      });
    } catch (error) {
      logger.error('Error loading tools for agent ' + agentId, error);
    }
  };
}

const initializeClient = async ({ req, res, signal, endpointOption }) => {
  if (!endpointOption) {
    throw new Error('Endpoint option not provided');
  }

  /* === VIVENTIUM START ===
   * Feature: Pre-initialization voice actor authority boundary
   * Purpose: Install the fail-closed request state before any tool, handoff, background, memory,
   * or native workspace capability can be initialized for an unverified speaker.
   * === VIVENTIUM END === */
  const sideEffectsRestricted = enforceRestrictedVoiceRequest(req);

  /* === VIVENTIUM START ===
   * Feature: Decouple persisted-agent tools from ephemeral UI toggles
   * Purpose:
   * - Keep Conversation Recall RAG and persisted agent tool configuration independent from
   *   transient chat UI toggles (`ephemeralAgent.file_search/web_search/execute_code`).
   * - Preserve MCP override behavior (`ephemeralAgent.mcp`) for persisted agents.
   *
   * Why here:
   * - This runs before agent loading/initialization, so downstream runtime/tool logic never sees
   *   tool-disable booleans for persisted agents.
   * Added: 2026-02-20
   * === VIVENTIUM END === */
  const requestAgentId = req?.body?.agent_id;
  const requestEphemeralAgent = req?.body?.ephemeralAgent;
  if (
    typeof requestAgentId === 'string' &&
    requestAgentId.length > 0 &&
    !isEphemeralAgentId(requestAgentId) &&
    requestEphemeralAgent &&
    typeof requestEphemeralAgent === 'object'
  ) {
    const nextEphemeralAgent = {};
    if (Array.isArray(requestEphemeralAgent.mcp)) {
      nextEphemeralAgent.mcp = requestEphemeralAgent.mcp;
    }
    if (requestEphemeralAgent.artifacts != null) {
      nextEphemeralAgent.artifacts = requestEphemeralAgent.artifacts;
    }
    req.body.ephemeralAgent = nextEphemeralAgent;
  }

  const appConfig = req.config;
  /* === VIVENTIUM START ===
   * Feature: Voice init-layer latency instrumentation (compact summary).
   */
  const voiceLatencyEnabled = isVoiceLatencyEnabled(req);
  const initVoiceStartAt = voiceLatencyEnabled ? voiceLatencyNow() : null;
  const voiceInitSummary = voiceLatencyEnabled
    ? {
        stageMs: Object.create(null),
        handoffCount: 0,
        handoffValidateMs: 0,
        handoffInitializeMs: 0,
        primaryToolDefinitions: 0,
        primaryToolRegistry: 0,
        primaryMcpAuthServers: 0,
        primaryToolHash: 'none',
        fallbackMode: 'none',
        fallbackProvider: 'none',
        fallbackModel: 'none',
        handoffToolDefinitions: 0,
        handoffToolRegistry: 0,
        handoffMcpAuthServers: 0,
      }
    : null;
  const setVoiceStageMs = (key, startedAt) => {
    if (!voiceLatencyEnabled || !voiceInitSummary || !key) {
      return null;
    }
    const duration = calcVoiceStageMs(startedAt);
    if (duration != null) {
      voiceInitSummary.stageMs[key] = duration;
    }
    return duration;
  };
  /* === VIVENTIUM END === */

  const deepTimingEnabled = isDeepTimingEnabled(req);
  const logDeep = (step, startTs, extra) => {
    if (!deepTimingEnabled) return;
    const traceId = typeof req?.body?.traceId === 'string' ? req.body.traceId : 'na';
    const now = performance.now();
    let base = req?._viventiumTimingBase;
    if (base == null) {
      base = now;
      req._viventiumTimingBase = base;
    }
    const t = now - base;
    const ms = Number.isFinite(startTs) ? now - startTs : t;
    const suffix = extra ? ` ${extra}` : '';
    logger.info(
      `[TG_TIMING][lc][deep] trace=${traceId} step=${step} ms=${ms.toFixed(1)} t=${t.toFixed(1)}${suffix}`,
    );
  };
  const nowIfDeep = () => (deepTimingEnabled ? performance.now() : null);
  const wrapDb =
    (name, fn) =>
    async (...args) => {
      const t = nowIfDeep();
      try {
        return await fn(...args);
      } finally {
        logDeep(`db_${name}`, t);
      }
    };
  const dbMethods = deepTimingEnabled
    ? {
        getConvoFiles: wrapDb('get_convo_files', getConvoFiles),
        getFiles: wrapDb('get_files', db.getFiles),
        getUserKey: wrapDb('get_user_key', db.getUserKey),
        getMessages: wrapDb('get_messages', db.getMessages),
        updateFilesUsage: wrapDb('update_files_usage', db.updateFilesUsage),
        getUserKeyValues: wrapDb('get_user_key_values', db.getUserKeyValues),
        getToolFilesByIds: wrapDb('get_tool_files_by_ids', db.getToolFilesByIds),
        getUserCodeFiles: wrapDb('get_user_code_files', db.getUserCodeFiles),
        getCodeGeneratedFiles: wrapDb('get_code_generated_files', db.getCodeGeneratedFiles),
        ...(db.getLatestRecallEligibleMessageCreatedAt
          ? {
              getLatestRecallEligibleMessageCreatedAt: wrapDb(
                'get_latest_recall_eligible_message_created_at',
                db.getLatestRecallEligibleMessageCreatedAt,
              ),
            }
          : {}),
        ...(db.updateUserKey ? { updateUserKey: wrapDb('update_user_key', db.updateUserKey) } : {}),
      }
    : {
        getConvoFiles,
        getFiles: db.getFiles,
        getUserKey: db.getUserKey,
        getMessages: db.getMessages,
        updateUserKey: db.updateUserKey,
        updateFilesUsage: db.updateFilesUsage,
        getUserKeyValues: db.getUserKeyValues,
        getToolFilesByIds: db.getToolFilesByIds,
        getUserCodeFiles: db.getUserCodeFiles,
        getCodeGeneratedFiles: db.getCodeGeneratedFiles,
        getLatestRecallEligibleMessageCreatedAt: db.getLatestRecallEligibleMessageCreatedAt,
      };

  /** @type {string | null} */
  const streamId = req._resumableStreamId || null;

  /** @type {Array<UsageMetadata>} */
  const collectedUsage = [];
  /** @type {ArtifactPromises} */
  const artifactPromises = [];
  const { contentParts, aggregateContent: rawAggregateContent } = createContentAggregator();
  const aggregateContent = (event) => {
    /* === VIVENTIUM START ===
     * Feature: Streamed-delta persistence parity.
     *
     * Purpose:
     * - Preserve the same assistant text the user surface saw in the canonical Mongo message.
     * - Repair only the upstream aggregation miss where a visible `on_message_delta` was emitted
     *   but `contentParts` text did not advance. Cumulative snapshot normalization happens
     *   earlier at the stream event boundary before emit/replay/persistence fan-out.
     * === VIVENTIUM END === */
    const shouldRepairVoiceDelta = req?.body?.voiceMode === true;
    const shouldRepairVisibleDelta = event?.visibleToUser === true;
    const beforeVoiceText = shouldRepairVoiceDelta
      ? extractVisibleTextFromContentParts(contentParts)
      : '';
    const beforeVisibleText =
      shouldRepairVisibleDelta && !shouldRepairVoiceDelta
        ? extractVisibleTextFromContentParts(contentParts)
        : '';
    rawAggregateContent(event);
    sanitizeAggregatedContentParts(contentParts);
    if (shouldRepairVoiceDelta) {
      const afterVoiceText = extractVisibleTextFromContentParts(contentParts);
      const repaired = repairMissedVoiceMessageDelta({
        contentParts,
        event: event?.event,
        data: event?.data,
        beforeText: beforeVoiceText,
        afterText: afterVoiceText,
      });
      if (repaired) {
        sanitizeAggregatedContentParts(contentParts);
        if (!req._viventiumVoiceDeltaAggregationRepairLogged) {
          req._viventiumVoiceDeltaAggregationRepairLogged = true;
          logger.warn(
            `[VIVENTIUM][VoiceDeltaAggregation] Repaired missed voice message delta streamId=${streamId || 'none'}`,
          );
        }
      }
    } else if (shouldRepairVisibleDelta) {
      const afterVisibleText = extractVisibleTextFromContentParts(contentParts);
      const repaired = repairMissedVisibleMessageDelta({
        contentParts,
        event: event?.event,
        data: event?.data,
        beforeText: beforeVisibleText,
        afterText: afterVisibleText,
      });
      if (repaired) {
        sanitizeAggregatedContentParts(contentParts);
        req._viventiumVisibleDeltaAggregationRepaired = true;
        req._viventiumVisibleDeltaAggregationRecoveredText =
          extractVisibleTextFromContentParts(contentParts);
        if (!req._viventiumVisibleDeltaAggregationRepairLogged) {
          req._viventiumVisibleDeltaAggregationRepairLogged = true;
          logger.warn(
            `[VIVENTIUM][VisibleDeltaAggregation] Repaired missed visible message delta streamId=${streamId || 'none'}`,
          );
        }
      }
    }
    if (
      collapseRecoveredVisibleTextDuplicate({
        contentParts,
        recoveredText: req?._viventiumVisibleDeltaAggregationRecoveredText,
      })
    ) {
      req._viventiumVisibleDeltaAggregationDuplicateCollapsed = true;
      if (!req._viventiumVisibleDeltaAggregationCollapseLogged) {
        req._viventiumVisibleDeltaAggregationCollapseLogged = true;
        logger.warn(
          `[VIVENTIUM][VisibleDeltaAggregation] Collapsed exact final replay of repaired text streamId=${streamId || 'none'}`,
        );
      }
    }
  };
  const toolEndCallback = createToolEndCallback({ req, res, artifactPromises, streamId });

  /**
   * Agent context store - populated after initialization, accessed by callback via closure.
   * Maps agentId -> { userMCPAuthMap, agent, tool_resources, toolRegistry, openAIApiKey }
   * @type {Map<string, {
   *   userMCPAuthMap?: Record<string, Record<string, string>>,
   *   agent?: object,
   *   tool_resources?: object,
   *   toolRegistry?: import('@librechat/agents').LCToolRegistry,
   *   openAIApiKey?: string
   * }>}
   */
  const agentToolContexts = new Map();

  const toolExecuteOptions = {
    loadTools: async (toolNames, agentId) => {
      if (isVoiceActorSideEffectRestricted(req)) {
        return { loadedTools: [] };
      }
      const ctx = agentToolContexts.get(agentId) ?? {};
      logger.debug(`[ON_TOOL_EXECUTE] ctx found: ${!!ctx.userMCPAuthMap}, agent: ${ctx.agent?.id}`);
      logger.debug(`[ON_TOOL_EXECUTE] toolRegistry size: ${ctx.toolRegistry?.size ?? 'undefined'}`);

      const result = await loadToolsForExecution({
        req,
        res,
        signal,
        streamId,
        toolNames,
        agent: ctx.agent,
        toolRegistry: ctx.toolRegistry,
        userMCPAuthMap: ctx.userMCPAuthMap,
        tool_resources: ctx.tool_resources,
      });

      logger.debug(`[ON_TOOL_EXECUTE] loaded ${result.loadedTools?.length ?? 0} tools`);
      return result;
    },
    toolEndCallback,
  };

  const eventHandlers = getDefaultHandlers({
    req,
    res,
    toolExecuteOptions,
    aggregateContent,
    toolEndCallback,
    collectedUsage,
    streamId,
  });

  if (!endpointOption.agent) {
    throw new Error('No agent promise provided');
  }

  /* === VIVENTIUM NOTE ===
   * Proposal F: agent promise and modelsConfig are independent — resolve in parallel.
   * validateAgentModel depends on both, so it runs after the parallel await.
   */
  const parallelInitStart = nowIfDeep();
  const voiceAgentAndModelsStart = voiceLatencyEnabled ? voiceLatencyNow() : null;
  const [loadedPrimaryAgent, modelsConfig] = await Promise.all([
    endpointOption.agent,
    getModelsConfig(req),
  ]);
  const agentAndModelsMs = setVoiceStageMs('agent_and_models', voiceAgentAndModelsStart);
  if (voiceLatencyEnabled) {
    logVoiceInitLatencyStage(
      req,
      'initialize_client_agent_and_models_done',
      voiceAgentAndModelsStart,
      `stage_key=agent_and_models${agentAndModelsMs != null ? ` stage_ms_cached=${agentAndModelsMs}` : ''}`,
    );
  }
  logDeep('agent_and_models_config_parallel', parallelInitStart);
  delete endpointOption.agent;
  if (!loadedPrimaryAgent) {
    throw new Error('Agent not found');
  }
  const primaryAgent = sideEffectsRestricted
    ? sanitizeAgentForRestrictedVoiceTurn(loadedPrimaryAgent)
    : loadedPrimaryAgent;
  /* === VIVENTIUM START ===
   * Feature: Runtime provider capability enforcement.
   * Purpose: Fail loudly for a stored provider/model/options tuple that no longer matches the
   * compiled capability registry; never coerce an unknown provider to OpenAI.
   */
  Object.assign(
    primaryAgent,
    applyAgentProviderCapabilityDefaults(
      primaryAgent,
      req.config?.endpoints?.agents?.providerCapabilities,
      req.config?.endpoints?.agents?.capabilityRequiredProviders,
    ),
  );
  /* === VIVENTIUM END === */
  /* === VIVENTIUM NOTE END === */

  /* === VIVENTIUM START ===
   * Feature: Scheduled-agent execution policy
   * Purpose: Authenticated scheduled runs use their compiled automation tuple while
   * ordinary conscious chat keeps its independent latency/effort setting.
   * === VIVENTIUM END === */
  applyScheduledAgentOverride(primaryAgent, req);
  if (req.viventiumScheduledAgentExecution) {
    const {
      provider,
      model,
      reasoning_effort: reasoningEffort,
    } = req.viventiumScheduledAgentExecution;
    logger.info(
      `[scheduledAgent] Applied authenticated execution tuple provider=${provider} model=${model} effort=${reasoningEffort}`,
    );
  }

  /* === VIVENTIUM START ===
   * Feature: Voice Chat LLM Override
   * Apply voice model swap BEFORE validateAgentModel so the voice model gets validated.
   * Added: 2026-02-24
   */
  applyVoiceModelOverride(primaryAgent, req, modelsConfig);
  Object.assign(
    primaryAgent,
    applyAgentProviderCapabilityDefaults(
      primaryAgent,
      req.config?.endpoints?.agents?.providerCapabilities,
      req.config?.endpoints?.agents?.capabilityRequiredProviders,
    ),
  );
  /* === VIVENTIUM END === */

  /* === VIVENTIUM START ===
   * Feature: Structured harness lifecycle.
   * Purpose: Voice overrides and provider capabilities, not labels, decide whether this request
   * owns workspace execution, activity rendering, duplicate prevention, and native cancellation.
   */
  const selectedPrimaryCapability =
    appConfig?.endpoints?.[EModelEndpoint.agents]?.providerCapabilities?.[primaryAgent.provider];
  req._viventiumHarnessActivityEnabled =
    !sideEffectsRestricted && selectedPrimaryCapability?.activity_stream === true;
  req._viventiumHarnessExecutionEnabled =
    !sideEffectsRestricted && selectedPrimaryCapability?.workspace_binding === true;
  req._viventiumHarnessInvocationStarted = false;
  /* === VIVENTIUM END === */

  const validateStart = nowIfDeep();
  const voiceValidatePrimaryStart = voiceLatencyEnabled ? voiceLatencyNow() : null;
  const validationResult = await validateAgentModel({
    req,
    res,
    modelsConfig,
    logViolation,
    agent: primaryAgent,
  });
  const validatePrimaryMs = setVoiceStageMs('validate_primary', voiceValidatePrimaryStart);
  if (voiceLatencyEnabled) {
    logVoiceInitLatencyStage(
      req,
      'initialize_client_validate_primary_done',
      voiceValidatePrimaryStart,
      `stage_key=validate_primary${validatePrimaryMs != null ? ` stage_ms_cached=${validatePrimaryMs}` : ''}`,
    );
  }
  logDeep('validate_agent_primary', validateStart);

  if (!validationResult.isValid) {
    throw new Error(validationResult.error?.message);
  }

  const agentConfigs = new Map();
  const allowedProviders = new Set(appConfig?.endpoints?.[EModelEndpoint.agents]?.allowedProviders);

  /** Event-driven mode: only load tool definitions, not full instances */
  const loadTools = createToolLoader(signal, streamId, true);
  /** @type {Array<MongoFile>} */
  const requestFiles = req.body.files ?? [];
  /** @type {string} */
  const conversationId = req.body.conversationId;
  /** @type {string | undefined} */
  const parentMessageId = req.body.parentMessageId;

  /* === VIVENTIUM START ===
   * Feature: Agent Fallback LLM validation parity
   * Purpose: Prepare a validated secondary route for every graph participant before
   * initialization mutates provider options. Main and handoff agents therefore share the same
   * catalog, capability, same-route, and model validation contract.
   * Voice calls prefer the voice-specific fallback route and inherit the general fallback
   * when the voice fallback is unset.
   * Added: 2026-04-28; expanded to graph participants 2026-08-10
   */
  const resolveValidatedFallbackRoute = async (agent) => {
    const candidates = resolveFallbackCandidates(agent, {
      isVoiceCall: isVoiceCallActive(req),
    });
    for (const candidate of candidates) {
      if (isSameAgentRoute(agent, candidate)) {
        logger.warn(
          `[agentLlmFallback] Skipping ${candidate.source} fallback for agent ${agent.id} because it matches the effective primary route ${candidate.provider}/${candidate.model}`,
        );
        continue;
      }
      if (!isFallbackModelValid(candidate.model, candidate.provider, req, modelsConfig)) {
        logger.warn(
          `[agentLlmFallback] Invalid ${candidate.source} fallback model ${candidate.provider}/${candidate.model} for agent ${agent.id}; trying next fallback candidate`,
        );
        continue;
      }
      const candidateCapability =
        req?.config?.endpoints?.agents?.providerCapabilities?.[candidate.provider];
      const candidateFallbackAgent = buildFallbackAgent(agent, candidate, candidateCapability);
      const fallbackValidationResult = await validateAgentModel({
        req,
        res,
        modelsConfig,
        logViolation,
        agent: candidateFallbackAgent,
      });
      if (!fallbackValidationResult.isValid) {
        logger.warn(
          `[agentLlmFallback] ${candidate.source} fallback model ${candidate.provider}/${candidate.model} failed validation for agent ${agent.id}: ${fallbackValidationResult.error?.message || 'invalid'}; trying next fallback candidate`,
        );
        continue;
      }
      return {
        fallbackAgent: candidateFallbackAgent,
        fallbackAssignment: candidate,
      };
    }
    return { fallbackAgent: null, fallbackAssignment: null };
  };

  const withPlatformFallbackAuth = async (callback) => {
    const previousOpenAIPlatformFallbackFlag =
      req.viventiumAllowOpenAIPlatformFallbackOnOAuthFailure;
    req.viventiumAllowOpenAIPlatformFallbackOnOAuthFailure = true;
    try {
      return await callback();
    } finally {
      if (previousOpenAIPlatformFallbackFlag === undefined) {
        delete req.viventiumAllowOpenAIPlatformFallbackOnOAuthFailure;
      } else {
        req.viventiumAllowOpenAIPlatformFallbackOnOAuthFailure = previousOpenAIPlatformFallbackFlag;
      }
    }
  };

  const attachHarnessCancellationConfig = (targetAgent, logContext) => {
    let cancellationEndpointConfig = appConfig.endpoints?.[targetAgent.endpoint];
    if (!isAgentsEndpoint(targetAgent.endpoint) && !cancellationEndpointConfig) {
      try {
        cancellationEndpointConfig = getCustomEndpointConfig({
          endpoint: targetAgent.endpoint,
          appConfig,
        });
      } catch (error) {
        logger.warn(
          `[${logContext}] Could not resolve cancellation endpoint for ${targetAgent.id}: ${error?.message || error}`,
        );
      }
    }
    Object.defineProperty(targetAgent, 'viventiumHarnessCancellationEndpointConfig', {
      value: cancellationEndpointConfig,
      configurable: true,
      enumerable: false,
      writable: false,
    });
  };

  const { fallbackAgent, fallbackAssignment } = await resolveValidatedFallbackRoute(primaryAgent);
  /* === VIVENTIUM END === */

  const initPrimaryStart = nowIfDeep();
  const voiceInitPrimaryStart = voiceLatencyEnabled ? voiceLatencyNow() : null;
  /* === VIVENTIUM START ===
   * Feature: Provider fallback during agent initialization
   * Purpose: Provider auth and workspace-harness readiness resolve before AgentClient exists.
   * Recover once through the validated, user-configured fallback before a harness process starts,
   * so web, Telegram, and voice share the same explicit fallback contract.
   * Added: 2026-07-13
   */
  const initializeConfiguredPrimary = (agent) =>
    initializeAgent(
      {
        req,
        res,
        loadTools,
        requestFiles,
        conversationId,
        parentMessageId,
        agent,
        endpointOption,
        allowedProviders,
        isInitialAgent: true,
      },
      dbMethods,
    );
  const initializeConfiguredFallback = () =>
    withPlatformFallbackAuth(() => initializeConfiguredPrimary(fallbackAgent));
  const primaryInitialization = await initializePrimaryAgentWithFallback({
    primaryAgent,
    fallbackAgent,
    fallbackAssignment,
    initializePrimary: () => initializeConfiguredPrimary(primaryAgent),
    initializeFallback: initializeConfiguredFallback,
    signal,
  });
  const primaryConfig = sideEffectsRestricted
    ? sanitizeAgentForRestrictedVoiceTurn(primaryInitialization.config)
    : primaryInitialization.config;
  const effectivePrimaryAgent = sideEffectsRestricted
    ? sanitizeAgentForRestrictedVoiceTurn(primaryInitialization.effectiveAgent)
    : primaryInitialization.effectiveAgent;
  const primaryInitializationFallbackUsed = primaryInitialization.fallbackUsed;
  /* === VIVENTIUM START ===
   * Feature: Preserve declared conversation-provider identity after transport normalization.
   * Purpose: Custom OpenAI-compatible providers keep their capability/cancellation contract on
   * `endpoint`; initialization may normalize only the internal `provider` transport to openAI.
   * === VIVENTIUM END === */
  const effectivePrimaryProvider = resolveConversationProviderId(effectivePrimaryAgent);
  const effectivePrimaryCapability = setConversationProviderCapability(
    req,
    effectivePrimaryProvider,
  );
  req._viventiumFallbackLlmAttempt = primaryInitializationFallbackUsed === true;
  if (primaryInitializationFallbackUsed === true) {
    req._viventiumFallbackRouteNotice = {
      model: fallbackAssignment.model,
    };
  } else {
    delete req._viventiumFallbackRouteNotice;
  }
  if (!sideEffectsRestricted) {
    await attachConversationProviderCapabilityBundle({
      targetAgent: primaryConfig,
      declaredAgent: effectivePrimaryAgent,
      req,
      capability: effectivePrimaryCapability,
    });
    installConversationProviderCapabilityRefresher({
      targetAgent: primaryConfig,
      declaredAgent: effectivePrimaryAgent,
      req,
      capability: effectivePrimaryCapability,
    });
  }
  if (primaryInitializationFallbackUsed) {
    logger.warn(
      `[agentLlmFallback] Primary provider initialization failed before AgentClient; recovered agent ${primaryConfig.id} with configured fallback ${fallbackAssignment.provider}/${fallbackAssignment.model}`,
    );
    if (voiceLatencyEnabled && voiceInitSummary) {
      voiceInitSummary.fallbackMode = 'initialization_recovery';
      voiceInitSummary.fallbackProvider = fallbackAssignment.provider;
      voiceInitSummary.fallbackModel = fallbackAssignment.model;
    }
  }
  /* === VIVENTIUM END === */
  const initializePrimaryMs = setVoiceStageMs('initialize_primary', voiceInitPrimaryStart);
  /* === VIVENTIUM START ===
   * Feature: owner-scoped manage_active_tasks tool
   * Purpose: Register through the normal structured-tool architecture only for an authenticated,
   * owner-attributed Call/Wing turn. The factory fails closed for every other ingress.
   * === VIVENTIUM END === */
  const manageActiveTasksTool = createManageActiveTasksTool(req);
  if (manageActiveTasksTool) {
    const toolDefinition = {
      name: manageActiveTasksTool.name,
      description: manageActiveTasksTool.description,
      schema: manageActiveTasksTool.schema,
    };
    primaryConfig.tools = [
      ...(Array.isArray(primaryConfig.tools) ? primaryConfig.tools : []),
      manageActiveTasksTool,
    ];
    primaryConfig.toolDefinitions = [
      ...(Array.isArray(primaryConfig.toolDefinitions) ? primaryConfig.toolDefinitions : []),
      toolDefinition,
    ];
    if (primaryConfig.toolRegistry instanceof Map) {
      primaryConfig.toolRegistry.set(manageActiveTasksTool.name, toolDefinition);
    }
  }
  const primaryToolSummary = summarizeInitTools(primaryConfig);
  if (voiceLatencyEnabled && voiceInitSummary) {
    voiceInitSummary.primaryToolDefinitions = primaryToolSummary.toolDefinitionsCount;
    voiceInitSummary.primaryToolRegistry = primaryToolSummary.toolRegistrySize;
    voiceInitSummary.primaryMcpAuthServers = primaryToolSummary.mcpAuthServers;
    voiceInitSummary.primaryToolHash = primaryToolSummary.toolNamesHash;
  }
  if (voiceLatencyEnabled) {
    logVoiceInitLatencyStage(
      req,
      'initialize_client_primary_agent_done',
      voiceInitPrimaryStart,
      `stage_key=initialize_primary${initializePrimaryMs != null ? ` stage_ms_cached=${initializePrimaryMs}` : ''} ` +
        `tool_defs=${primaryToolSummary.toolDefinitionsCount} tool_registry=${primaryToolSummary.toolRegistrySize} ` +
        `mcp_auth_servers=${primaryToolSummary.mcpAuthServers} tool_hash=${primaryToolSummary.toolNamesHash} ` +
        `tool_sample=${primaryToolSummary.toolNamesSample}`,
    );
  }
  logDeep('initialize_agent_primary', initPrimaryStart);

  /* === VIVENTIUM START ===
   * Feature: Agent Fallback LLM lazy initialization
   * Purpose: Validate fallback eligibility during agent setup, but avoid loading
   * fallback tools/MCP state on the healthy primary path. This preserves the
   * one-shot fallback behavior while removing fallback-only MCP init from voice
   * first-audio latency.
   * Updated: 2026-05-14
   */
  if (!primaryInitializationFallbackUsed && fallbackAgent && fallbackAssignment) {
    if (voiceLatencyEnabled && voiceInitSummary) {
      voiceInitSummary.fallbackMode = 'lazy';
      voiceInitSummary.fallbackProvider = fallbackAssignment.provider;
      voiceInitSummary.fallbackModel = fallbackAssignment.model;
    }
    primaryConfig.viventiumFallbackLlmAssignment = {
      provider: fallbackAssignment.provider,
      model: fallbackAssignment.model,
    };
    let fallbackConfigPromise = null;
    const materializeFallbackLlm = async () => {
      if (primaryConfig.viventiumFallbackLlm) {
        return primaryConfig.viventiumFallbackLlm;
      }
      if (fallbackConfigPromise) {
        return fallbackConfigPromise;
      }
      const voiceFallbackInitStart = voiceLatencyEnabled ? voiceLatencyNow() : null;
      const previousOpenAIPlatformFallbackFlag =
        req.viventiumAllowOpenAIPlatformFallbackOnOAuthFailure;
      req.viventiumAllowOpenAIPlatformFallbackOnOAuthFailure = true;
      fallbackConfigPromise = initializeAgent(
        {
          req,
          res,
          loadTools,
          requestFiles,
          conversationId,
          parentMessageId,
          agent: fallbackAgent,
          endpointOption,
          allowedProviders,
          isInitialAgent: false,
        },
        dbMethods,
      )
        .then(async (fallbackConfig) => {
          if (sideEffectsRestricted) {
            fallbackConfig = sanitizeAgentForRestrictedVoiceTurn(fallbackConfig);
          }
          inheritResolvedAgentGraph(fallbackConfig, primaryConfig);
          /* === VIVENTIUM START ===
           * Feature: Lazy fallback graph resilience parity.
           * Purpose: The fallback is the same logical agent. Preserve the request-resolved graph
           * and omitted-capability facts so fallback cannot resurrect a capability-empty handoff.
           * === VIVENTIUM END === */
          synchronizeFallbackGraphResilience(
            fallbackConfig,
            primaryConfig,
            omittedCapabilityReadiness,
          );
          if (!sideEffectsRestricted) {
            await attachDeclaredConversationProviderCapabilityBundle({
              targetAgent: fallbackConfig,
              declaredAgent: fallbackAgent,
              req,
            });
            installConversationProviderCapabilityRefresher({
              targetAgent: fallbackConfig,
              declaredAgent: fallbackAgent,
              req,
            });
            attachHarnessCancellationConfig(fallbackConfig, 'agentLlmFallback');
          }
          primaryConfig.viventiumFallbackLlm = fallbackConfig;
          primaryConfig.viventiumFallbackLlmInitializationError = null;
          if (voiceLatencyEnabled) {
            const fallbackToolSummary = summarizeInitTools(fallbackConfig);
            logVoiceInitLatencyStage(
              req,
              'initialize_client_fallback_agent_done',
              voiceFallbackInitStart,
              `stage_key=initialize_fallback tool_defs=${fallbackToolSummary.toolDefinitionsCount} ` +
                `tool_registry=${fallbackToolSummary.toolRegistrySize} ` +
                `mcp_auth_servers=${fallbackToolSummary.mcpAuthServers} ` +
                `tool_hash=${fallbackToolSummary.toolNamesHash}`,
            );
          }
          logger.info(
            `[agentLlmFallback] Prepared fallback model for agent ${primaryConfig.id}: ${fallbackAssignment.provider}/${fallbackAssignment.model}`,
          );
          return fallbackConfig;
        })
        .catch((error) => {
          fallbackConfigPromise = null;
          if (error && typeof error === 'object') {
            error.viventiumFallbackProvider = fallbackAssignment.provider;
            error.viventiumFallbackModel = fallbackAssignment.model;
          }
          primaryConfig.viventiumFallbackLlmInitializationError = error;
          logger.warn(
            `[agentLlmFallback] Failed to initialize fallback model ${fallbackAssignment.provider}/${fallbackAssignment.model} for agent ${primaryAgent.id}: ${error?.message || error}`,
          );
          return null;
        })
        .finally(() => {
          if (previousOpenAIPlatformFallbackFlag === undefined) {
            delete req.viventiumAllowOpenAIPlatformFallbackOnOAuthFailure;
          } else {
            req.viventiumAllowOpenAIPlatformFallbackOnOAuthFailure =
              previousOpenAIPlatformFallbackFlag;
          }
        });
      return fallbackConfigPromise;
    };
    Object.defineProperty(primaryConfig, 'viventiumFallbackLlmInitializer', {
      value: materializeFallbackLlm,
      configurable: true,
      enumerable: false,
      writable: false,
    });
    logger.info(
      `[agentLlmFallback] Validated lazy fallback model for agent ${primaryConfig.id}: ${fallbackAssignment.provider}/${fallbackAssignment.model}`,
    );
  }
  /* === VIVENTIUM END === */

  logger.debug(
    `[initializeClient] Tool definitions for primary agent: ${primaryConfig.toolDefinitions?.length ?? 0}`,
  );

  /** Store primary agent's tool context for ON_TOOL_EXECUTE callback */
  logger.debug(`[initializeClient] Storing tool context for agentId: ${primaryConfig.id}`);
  logger.debug(
    `[initializeClient] toolRegistry size: ${primaryConfig.toolRegistry?.size ?? 'undefined'}`,
  );
  agentToolContexts.set(primaryConfig.id, {
    agent: effectivePrimaryAgent,
    toolRegistry: primaryConfig.toolRegistry,
    userMCPAuthMap: primaryConfig.userMCPAuthMap,
    tool_resources: primaryConfig.tool_resources,
  });

  /* === VIVENTIUM START ===
   * Feature: Native provider tool ownership at the graph boundary.
   * Purpose: Handoff edges compile into model tool schemas. A native-tools endpoint receives
   * capabilities through its signed broker bundle and must never also receive LibreChat graph
   * tools; background cortices and Phase B are orchestrated independently of this graph.
   * === VIVENTIUM END === */
  const primaryGraph = selectLibreChatAgentGraph({
    agentIds: primaryConfig.agent_ids,
    edges: primaryConfig.edges,
    capability: effectivePrimaryCapability,
  });
  const agent_ids = primaryGraph.agentIds;
  let userMCPAuthMap = primaryConfig.userMCPAuthMap;
  if (primaryConfig.viventiumFallbackLlm?.userMCPAuthMap) {
    if (userMCPAuthMap != null) {
      Object.assign(userMCPAuthMap, primaryConfig.viventiumFallbackLlm.userMCPAuthMap);
    } else {
      userMCPAuthMap = primaryConfig.viventiumFallbackLlm.userMCPAuthMap;
    }
  }

  /** @type {Set<string>} Track agents that failed to load (orphaned references) */
  const skippedAgentIds = new Set();
  const omittedCapabilityReadiness = [];

  async function processAgent(agentId) {
    const getAgentStart = nowIfDeep();
    const loadedAgent = await getAgent({ id: agentId });
    logDeep('handoff_get_agent', getAgentStart, `agentId=${agentId}`);
    if (!loadedAgent) {
      logger.warn(
        `[processAgent] Handoff agent ${agentId} not found, skipping (orphaned reference)`,
      );
      skippedAgentIds.add(agentId);
      return null;
    }
    const agent = sideEffectsRestricted
      ? sanitizeAgentForRestrictedVoiceTurn(loadedAgent)
      : loadedAgent;

    /* === VIVENTIUM START ===
     * Feature: Voice Chat LLM Override (handoff graph agents)
     * Purpose: Ensure every agent participating in a voice call uses its voice override.
     * Added: 2026-02-24
     */
    applyVoiceModelOverride(agent, req, modelsConfig);
    /* === VIVENTIUM END === */

    const validateStart = nowIfDeep();
    const voiceHandoffValidateStart = voiceLatencyEnabled ? voiceLatencyNow() : null;
    const validationResult = await validateAgentModel({
      req,
      res,
      agent,
      modelsConfig,
      logViolation,
    });
    if (voiceLatencyEnabled && voiceInitSummary) {
      const handoffValidateMs = calcVoiceStageMs(voiceHandoffValidateStart);
      if (handoffValidateMs != null) {
        voiceInitSummary.handoffValidateMs += handoffValidateMs;
      }
    }
    logDeep('handoff_validate_agent', validateStart, `agentId=${agentId}`);

    if (!validationResult.isValid) {
      throw new Error(validationResult.error?.message);
    }

    const { fallbackAgent: handoffFallbackAgent, fallbackAssignment: handoffFallbackAssignment } =
      await resolveValidatedFallbackRoute(agent);
    const initStart = nowIfDeep();
    const voiceHandoffInitStart = voiceLatencyEnabled ? voiceLatencyNow() : null;
    const initializeHandoffAgent = (targetAgent, { includeTools = true } = {}) =>
      initializeAgent(
        {
          req,
          res,
          agent: targetAgent,
          loadTools: includeTools ? loadTools : undefined,
          requestFiles,
          conversationId,
          parentMessageId,
          endpointOption,
          allowedProviders,
        },
        dbMethods,
      );
    const handoffInitialization = await initializePrimaryAgentWithFallback({
      primaryAgent: agent,
      fallbackAgent: handoffFallbackAgent,
      fallbackAssignment: handoffFallbackAssignment,
      initializePrimary: () => initializeHandoffAgent(agent),
      initializeFallback: () =>
        withPlatformFallbackAuth(() => initializeHandoffAgent(handoffFallbackAgent)),
      signal,
    });
    const config = sideEffectsRestricted
      ? sanitizeAgentForRestrictedVoiceTurn(handoffInitialization.config)
      : handoffInitialization.config;
    const effectiveAgent = sideEffectsRestricted
      ? sanitizeAgentForRestrictedVoiceTurn(handoffInitialization.effectiveAgent)
      : handoffInitialization.effectiveAgent;
    const handoffInitializationFallbackUsed = handoffInitialization.fallbackUsed === true;
    /* === VIVENTIUM START ===
     * Feature: GlassHive handoff capability parity
     * Purpose: Attach the endpoint-declared signed workspace capability bundle before an Agent
     * Builder handoff enters the graph, matching primary/fallback/background provider behavior.
     * The shared helper keeps non-workspace providers unchanged and exposes bundle failures through
     * the existing capability-unavailable instruction instead of inventing handoff-specific policy.
     * === VIVENTIUM END === */
    if (!sideEffectsRestricted) {
      await attachDeclaredConversationProviderCapabilityBundle({
        targetAgent: config,
        declaredAgent: effectiveAgent,
        req,
      });
      installConversationProviderCapabilityRefresher({
        targetAgent: config,
        declaredAgent: effectiveAgent,
        req,
      });
    }
    /* === VIVENTIUM START ===
     * Feature: GlassHive handoff cancellation parity.
     * Purpose: Preserve the declared handoff endpoint configuration so a workspace-bound graph
     * participant can receive an intentional native Stop even when the primary agent is direct.
     * === VIVENTIUM END === */
    if (!sideEffectsRestricted) {
      attachHarnessCancellationConfig(config, 'processAgent');
    }

    /* === VIVENTIUM START ===
     * Feature: Per-participant Agent Builder fallback
     * Purpose: Graph-native fallback must belong to the participant that can fail, not Main. The
     * fallback model route is initialized with the same provider/auth/capability path but without
     * a second ToolService/MCP load; LangGraph reuses the target participant's authorized tools.
     * Runtime-only state stays out of persisted Agent documents and API serialization.
     * Added: 2026-08-10
     * === VIVENTIUM END === */
    if (!handoffInitializationFallbackUsed && handoffFallbackAgent && handoffFallbackAssignment) {
      const graphFallbackInitStart = performance.now();
      try {
        let graphFallbackConfig = await withPlatformFallbackAuth(() =>
          initializeHandoffAgent(handoffFallbackAgent, { includeTools: false }),
        );
        if (sideEffectsRestricted) {
          graphFallbackConfig = sanitizeAgentForRestrictedVoiceTurn(graphFallbackConfig);
        } else {
          await attachDeclaredConversationProviderCapabilityBundle({
            targetAgent: graphFallbackConfig,
            declaredAgent: handoffFallbackAgent,
            capabilitySourceAgent: config,
            req,
          });
          installConversationProviderCapabilityRefresher({
            targetAgent: graphFallbackConfig,
            declaredAgent: handoffFallbackAgent,
            capabilitySourceAgent: config,
            req,
          });
          attachHarnessCancellationConfig(graphFallbackConfig, 'processAgentFallback');
        }
        Object.defineProperty(config, 'viventiumGraphLlmFallbacks', {
          value: [graphFallbackConfig],
          configurable: true,
          enumerable: false,
          writable: false,
        });
        logger.info(
          `[agentLlmFallback] Prepared graph fallback for agent ${agentId}: ${handoffFallbackAssignment.provider}/${handoffFallbackAssignment.model} prep_ms=${Math.round(performance.now() - graphFallbackInitStart)}`,
        );
      } catch (error) {
        logger.warn(
          `[agentLlmFallback] Could not prepare graph fallback for agent ${agentId}; keeping healthy primary participant prep_ms=${Math.round(performance.now() - graphFallbackInitStart)}: ${error?.message || error}`,
        );
      }
    } else if (handoffInitializationFallbackUsed) {
      logger.warn(
        `[agentLlmFallback] Handoff provider initialization recovered through configured fallback for agent ${agentId}: ${handoffFallbackAssignment.provider}/${handoffFallbackAssignment.model}`,
      );
    }
    const handoffToolSummary = summarizeInitTools(config);
    if (voiceLatencyEnabled && voiceInitSummary) {
      const handoffInitializeMs = calcVoiceStageMs(voiceHandoffInitStart);
      if (handoffInitializeMs != null) {
        voiceInitSummary.handoffInitializeMs += handoffInitializeMs;
      }
      voiceInitSummary.handoffCount += 1;
      voiceInitSummary.handoffToolDefinitions += handoffToolSummary.toolDefinitionsCount;
      voiceInitSummary.handoffToolRegistry += handoffToolSummary.toolRegistrySize;
      voiceInitSummary.handoffMcpAuthServers += handoffToolSummary.mcpAuthServers;
      logVoiceInitLatencyStage(
        req,
        'initialize_client_handoff_agent_done',
        voiceHandoffInitStart,
        `agent_id=${agentId} tool_defs=${handoffToolSummary.toolDefinitionsCount} ` +
          `tool_registry=${handoffToolSummary.toolRegistrySize} ` +
          `mcp_auth_servers=${handoffToolSummary.mcpAuthServers} ` +
          `tool_hash=${handoffToolSummary.toolNamesHash} tool_sample=${handoffToolSummary.toolNamesSample}`,
      );
    }
    logDeep('handoff_initialize_agent', initStart, `agentId=${agentId}`);

    /* === VIVENTIUM START ===
     * Feature: Capability-ready optional handoffs.
     * Purpose: A successfully initialized model is still not a valid handoff target when every
     * MCP capability it declares was conclusively removed for missing/broken auth or service
     * readiness. Keep one-provider partial availability and unknown telemetry fail-open.
     */
    const capabilityReadiness = evaluateOptionalAgentCapabilityReadiness(agent, config);
    if (!capabilityReadiness.keep) {
      markOptionalAgentInitializationFailed(skippedAgentIds, agentId);
      omittedCapabilityReadiness.push(capabilityReadiness);
      logger.warn(
        '[initializeClient] Optional handoff omitted because all declared MCPs are unavailable',
        {
          agentId,
          readiness: capabilityReadiness.unavailableServers,
        },
      );
      return null;
    }
    /* === VIVENTIUM END === */

    if (userMCPAuthMap != null) {
      Object.assign(userMCPAuthMap, config.userMCPAuthMap ?? {});
    } else {
      userMCPAuthMap = config.userMCPAuthMap;
    }

    /** Store handoff agent's tool context for ON_TOOL_EXECUTE callback */
    agentToolContexts.set(agentId, {
      agent: effectiveAgent,
      toolRegistry: config.toolRegistry,
      userMCPAuthMap: config.userMCPAuthMap,
      tool_resources: config.tool_resources,
    });

    agentConfigs.set(agentId, config);
    return effectiveAgent;
  }

  const checkAgentInit = (agentId) => agentId === primaryConfig.id || agentConfigs.has(agentId);

  // Graph topology discovery for recursive agent handoffs (BFS)
  const { edgeMap, agentsToProcess, collectEdges } = createEdgeCollector(
    checkAgentInit,
    skippedAgentIds,
  );

  // Seed with primary agent's edges
  collectEdges(primaryGraph.edges);

  // BFS to load and merge all connected agents (enables transitive handoffs: A->B->C)
  while (agentsToProcess.size > 0) {
    const agentId = agentsToProcess.values().next().value;
    agentsToProcess.delete(agentId);
    try {
      const agent = await processAgent(agentId);
      if (agent?.edges?.length) {
        collectEdges(agent.edges);
      }
    } catch (err) {
      /* === VIVENTIUM START ===
       * Feature: Optional agent graph resilience
       * Purpose: A failed optional handoff must be marked before orphan filtering; otherwise its
       * edge survives and LangGraph aborts the whole web, Telegram, or voice turn at compile time.
       * Added: 2026-07-13
       * === VIVENTIUM END === */
      markOptionalAgentInitializationFailed(skippedAgentIds, agentId);
      logger.error(`[initializeClient] Error processing agent ${agentId}:`, err);
    }
  }

  /** @deprecated Agent Chain */
  if (agent_ids?.length) {
    for (const agentId of agent_ids) {
      if (checkAgentInit(agentId)) {
        continue;
      }
      await processAgent(agentId);
    }
    const chain = await createSequentialChainEdges([primaryConfig.id].concat(agent_ids), '{convo}');
    collectEdges(chain);
  }

  let edges = Array.from(edgeMap.values());

  /** Multi-Convo: Process addedConvo for parallel agent execution */
  const addedConvoStart = nowIfDeep();
  const voiceAddedConvoStart = voiceLatencyEnabled ? voiceLatencyNow() : null;
  const { userMCPAuthMap: updatedMCPAuthMap } = sideEffectsRestricted
    ? { userMCPAuthMap: {} }
    : await processAddedConvo({
        req,
        res,
        loadTools,
        logViolation,
        modelsConfig,
        requestFiles,
        agentConfigs,
        primaryAgent: effectivePrimaryAgent,
        endpointOption,
        userMCPAuthMap,
        conversationId,
        parentMessageId,
        allowedProviders,
        primaryAgentId: primaryConfig.id,
      });
  const addedConvoMs = setVoiceStageMs('process_added_convo', voiceAddedConvoStart);
  if (voiceLatencyEnabled) {
    logVoiceInitLatencyStage(
      req,
      'initialize_client_process_added_convo_done',
      voiceAddedConvoStart,
      `stage_key=process_added_convo${addedConvoMs != null ? ` stage_ms_cached=${addedConvoMs}` : ''} agents=${agentConfigs.size}`,
    );
  }
  logDeep('process_added_convo', addedConvoStart, `agents=${agentConfigs.size}`);

  if (updatedMCPAuthMap) {
    userMCPAuthMap = updatedMCPAuthMap;
  }

  // Ensure edges is an array when we have multiple agents (multi-agent mode)
  // MultiAgentGraph.categorizeEdges requires edges to be iterable
  if (agentConfigs.size > 0 && !edges) {
    edges = [];
  }

  // Filter out edges referencing non-existent agents (orphaned references)
  edges = filterOrphanedEdges(edges, skippedAgentIds);

  appendOmittedCapabilityReadiness(primaryConfig, omittedCapabilityReadiness);

  primaryConfig.edges = edges;

  let endpointConfig = appConfig.endpoints?.[primaryConfig.endpoint];
  if (!isAgentsEndpoint(primaryConfig.endpoint) && !endpointConfig) {
    try {
      endpointConfig = getCustomEndpointConfig({
        endpoint: primaryConfig.endpoint,
        appConfig,
      });
    } catch (err) {
      logger.error(
        '[api/server/controllers/agents/client.js #titleConvo] Error getting custom endpoint config',
        err,
      );
    }
  }

  /* === VIVENTIUM START ===
   * Feature: Explicit native harness cancellation.
   * Purpose: Only the intentional Stop reason cancels; a transport disconnect leaves the native
   * run available for resumable reattachment through its stable idempotency key.
   */
  if (!sideEffectsRestricted) {
    bindHarnessCancellation({
      req,
      signal,
      endpointConfig,
      onDeliveryError: (error) => {
        logger.warn('[GlassHiveProvider] Native cancellation delivery failed', {
          error: error?.message || 'provider_unreachable',
        });
      },
    });
  }
  /* === VIVENTIUM END === */

  const sender =
    effectivePrimaryAgent.name ??
    getResponseSender({
      ...endpointOption,
      model: endpointOption.model_parameters.model,
      modelDisplayLabel: endpointConfig?.modelDisplayLabel,
      modelLabel: endpointOption.model_parameters.modelLabel,
    });

  const client = new AgentClient({
    req,
    res,
    sender,
    contentParts,
    agentConfigs,
    eventHandlers,
    collectedUsage,
    aggregateContent,
    artifactPromises,
    agent: primaryConfig,
    spec: endpointOption.spec,
    iconURL: endpointOption.iconURL,
    attachments: primaryConfig.attachments,
    endpointType: endpointOption.endpointType,
    resendFiles: primaryConfig.resendFiles ?? true,
    maxContextTokens: primaryConfig.maxContextTokens,
    endpoint: isEphemeralAgentId(primaryConfig.id) ? primaryConfig.endpoint : EModelEndpoint.agents,
  });

  if (streamId) {
    GenerationJobManager.setCollectedUsage(streamId, collectedUsage);
  }

  /* === VIVENTIUM START ===
   * Feature: Voice init-layer latency instrumentation (compact summary).
   */
  if (voiceLatencyEnabled && voiceInitSummary) {
    const summaryParts = [
      '[VoiceLatency][LC][InitSummary]',
      `request_id=${getVoiceLatencyRequestId(req)}`,
    ];
    const totalMs = calcVoiceStageMs(initVoiceStartAt);
    if (totalMs != null) {
      summaryParts.push(`init_total_ms=${totalMs}`);
    }
    const orderedStageKeys = [
      'agent_and_models',
      'validate_primary',
      'initialize_primary',
      'process_added_convo',
    ];
    for (const key of orderedStageKeys) {
      const ms = voiceInitSummary.stageMs[key];
      if (Number.isFinite(ms)) {
        summaryParts.push(`${key}_ms=${ms}`);
      }
    }
    if (voiceInitSummary.handoffCount > 0) {
      summaryParts.push(`handoff_count=${voiceInitSummary.handoffCount}`);
      summaryParts.push(`handoff_validate_ms=${voiceInitSummary.handoffValidateMs}`);
      summaryParts.push(`handoff_initialize_ms=${voiceInitSummary.handoffInitializeMs}`);
      summaryParts.push(`handoff_tool_defs=${voiceInitSummary.handoffToolDefinitions}`);
      summaryParts.push(`handoff_tool_registry=${voiceInitSummary.handoffToolRegistry}`);
      summaryParts.push(`handoff_mcp_auth_servers=${voiceInitSummary.handoffMcpAuthServers}`);
    }
    summaryParts.push(`primary_tool_defs=${voiceInitSummary.primaryToolDefinitions}`);
    summaryParts.push(`primary_tool_registry=${voiceInitSummary.primaryToolRegistry}`);
    summaryParts.push(`primary_mcp_auth_servers=${voiceInitSummary.primaryMcpAuthServers}`);
    summaryParts.push(`primary_tool_hash=${voiceInitSummary.primaryToolHash}`);
    summaryParts.push(`fallback_mode=${voiceInitSummary.fallbackMode}`);
    if (voiceInitSummary.fallbackMode !== 'none') {
      summaryParts.push(`fallback_provider=${voiceInitSummary.fallbackProvider}`);
      summaryParts.push(`fallback_model=${voiceInitSummary.fallbackModel}`);
    }
    logger.info(summaryParts.join(' '));
  }
  /* === VIVENTIUM END === */

  return { client, userMCPAuthMap };
};

module.exports = { initializeClient };
/* === VIVENTIUM END === */
