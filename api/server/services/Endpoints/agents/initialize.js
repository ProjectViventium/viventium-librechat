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
const { createContentAggregator } = require('@librechat/agents');
const {
  initializeAgent,
  validateAgentModel,
  createEdgeCollector,
  filterOrphanedEdges,
  GenerationJobManager,
  getCustomEndpointConfig,
  createSequentialChainEdges,
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
const db = require('~/models');
const { isDeepTimingEnabled } = require('~/server/services/viventium/telegramTimingDeep');
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
  isSameAgentRoute,
} = require('~/server/services/viventium/agentLlmFallback');
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
  if (typeof startedAt !== 'number') {
    return null;
  }
  const delta = Date.now() - startedAt;
  return delta >= 0 ? delta : null;
};

const logVoiceInitLatencyStage = (req, stage, stageStartAt = null, details = '') => {
  if (!isVoiceLatencyEnabled(req)) {
    return;
  }
  const now = Date.now();
  const routeStartAt = typeof req?.viventiumVoiceStartAt === 'number' ? req.viventiumVoiceStartAt : now;
  const requestId = getVoiceLatencyRequestId(req);
  const stageMs = calcVoiceStageMs(stageStartAt);
  const stagePart = stageMs == null ? '' : ` stage_ms=${stageMs}`;
  const detailPart = details ? ` ${details}` : '';
  logger.info(
    `[VoiceLatency][LC] stage=${stage} request_id=${requestId} total_ms=${now - routeStartAt}${stagePart}${detailPart}`,
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
  const initVoiceStartAt = voiceLatencyEnabled ? Date.now() : null;
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
  const wrapDb = (name, fn) => async (...args) => {
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
    rawAggregateContent(event);
    sanitizeAggregatedContentParts(contentParts);
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
  const voiceAgentAndModelsStart = voiceLatencyEnabled ? Date.now() : null;
  const [primaryAgent, modelsConfig] = await Promise.all([
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
  if (!primaryAgent) {
    throw new Error('Agent not found');
  }
  /* === VIVENTIUM NOTE END === */

  /* === VIVENTIUM START ===
   * Feature: Voice Chat LLM Override
   * Apply voice model swap BEFORE validateAgentModel so the voice model gets validated.
   * Added: 2026-02-24
   */
  applyVoiceModelOverride(primaryAgent, req, modelsConfig);
  /* === VIVENTIUM END === */

  const validateStart = nowIfDeep();
  const voiceValidatePrimaryStart = voiceLatencyEnabled ? Date.now() : null;
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
   * Feature: Agent Fallback LLM
   * Purpose: Prepare a validated secondary route before primary initialization mutates
   * provider options, then attach the initialized route for one-shot runtime retry.
   * Voice calls prefer the voice-specific fallback route and inherit the general fallback
   * when the voice fallback is unset.
   * Added: 2026-04-28
   */
  let fallbackAgent = null;
  const fallbackCandidates = resolveFallbackCandidates(primaryAgent, {
    isVoiceCall: isVoiceCallActive(req),
  });
  let fallbackAssignment = null;
  for (const candidate of fallbackCandidates) {
    if (isSameAgentRoute(primaryAgent, candidate)) {
      logger.warn(
        `[agentLlmFallback] Skipping ${candidate.source} fallback for agent ${primaryAgent.id} because it matches the effective primary route ${candidate.provider}/${candidate.model}`,
      );
      continue;
    }
    if (!isFallbackModelValid(candidate.model, candidate.provider, req, modelsConfig)) {
      logger.warn(
        `[agentLlmFallback] Invalid ${candidate.source} fallback model ${candidate.provider}/${candidate.model} for agent ${primaryAgent.id}; trying next fallback candidate`,
      );
      continue;
    }
    const candidateFallbackAgent = buildFallbackAgent(primaryAgent, candidate);
    const fallbackValidationResult = await validateAgentModel({
      req,
      res,
      modelsConfig,
      logViolation,
      agent: candidateFallbackAgent,
    });
    if (!fallbackValidationResult.isValid) {
      logger.warn(
        `[agentLlmFallback] ${candidate.source} fallback model ${candidate.provider}/${candidate.model} failed validation for agent ${primaryAgent.id}: ${fallbackValidationResult.error?.message || 'invalid'}; trying next fallback candidate`,
      );
      continue;
    }
    fallbackAgent = candidateFallbackAgent;
    fallbackAssignment = candidate;
    break;
  }
  /* === VIVENTIUM END === */

  const initPrimaryStart = nowIfDeep();
  const voiceInitPrimaryStart = voiceLatencyEnabled ? Date.now() : null;
  const primaryConfig = await initializeAgent(
    {
      req,
      res,
      loadTools,
      requestFiles,
      conversationId,
      parentMessageId,
      agent: primaryAgent,
      endpointOption,
      allowedProviders,
      isInitialAgent: true,
    },
    dbMethods,
  );
  const initializePrimaryMs = setVoiceStageMs('initialize_primary', voiceInitPrimaryStart);
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

  /* === VIVENTIUM START === Agent Fallback LLM initialization */
  if (fallbackAgent && fallbackAssignment) {
    try {
      const fallbackConfig = await initializeAgent(
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
      );
      primaryConfig.viventiumFallbackLlm = fallbackConfig;
      primaryConfig.viventiumFallbackLlmAssignment = {
        provider: fallbackAssignment.provider,
        model: fallbackAssignment.model,
      };
      logger.info(
        `[agentLlmFallback] Prepared fallback model for agent ${primaryConfig.id}: ${fallbackAssignment.provider}/${fallbackAssignment.model}`,
      );
    } catch (error) {
      logger.warn(
        `[agentLlmFallback] Failed to initialize fallback model ${fallbackAssignment.provider}/${fallbackAssignment.model} for agent ${primaryAgent.id}: ${error?.message || error}`,
      );
    }
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
    agent: primaryAgent,
    toolRegistry: primaryConfig.toolRegistry,
    userMCPAuthMap: primaryConfig.userMCPAuthMap,
    tool_resources: primaryConfig.tool_resources,
  });

  const agent_ids = primaryConfig.agent_ids;
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

  async function processAgent(agentId) {
    const getAgentStart = nowIfDeep();
    const agent = await getAgent({ id: agentId });
    logDeep('handoff_get_agent', getAgentStart, `agentId=${agentId}`);
    if (!agent) {
      logger.warn(
        `[processAgent] Handoff agent ${agentId} not found, skipping (orphaned reference)`,
      );
      skippedAgentIds.add(agentId);
      return null;
    }

    /* === VIVENTIUM START ===
     * Feature: Voice Chat LLM Override (handoff graph agents)
     * Purpose: Ensure every agent participating in a voice call uses its voice override.
     * Added: 2026-02-24
     */
    applyVoiceModelOverride(agent, req, modelsConfig);
    /* === VIVENTIUM END === */

    const validateStart = nowIfDeep();
    const voiceHandoffValidateStart = voiceLatencyEnabled ? Date.now() : null;
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

    const initStart = nowIfDeep();
    const voiceHandoffInitStart = voiceLatencyEnabled ? Date.now() : null;
    const config = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        requestFiles,
        conversationId,
        parentMessageId,
        endpointOption,
        allowedProviders,
      },
      dbMethods,
    );
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
    if (userMCPAuthMap != null) {
      Object.assign(userMCPAuthMap, config.userMCPAuthMap ?? {});
    } else {
      userMCPAuthMap = config.userMCPAuthMap;
    }

    /** Store handoff agent's tool context for ON_TOOL_EXECUTE callback */
    agentToolContexts.set(agentId, {
      agent,
      toolRegistry: config.toolRegistry,
      userMCPAuthMap: config.userMCPAuthMap,
      tool_resources: config.tool_resources,
    });

    agentConfigs.set(agentId, config);
    return agent;
  }

  const checkAgentInit = (agentId) => agentId === primaryConfig.id || agentConfigs.has(agentId);

  // Graph topology discovery for recursive agent handoffs (BFS)
  const { edgeMap, agentsToProcess, collectEdges } = createEdgeCollector(
    checkAgentInit,
    skippedAgentIds,
  );

  // Seed with primary agent's edges
  collectEdges(primaryConfig.edges);

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
  const voiceAddedConvoStart = voiceLatencyEnabled ? Date.now() : null;
  const { userMCPAuthMap: updatedMCPAuthMap } = await processAddedConvo({
    req,
    res,
    loadTools,
    logViolation,
    modelsConfig,
    requestFiles,
    agentConfigs,
    primaryAgent,
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

  const sender =
    primaryAgent.name ??
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
    logger.info(summaryParts.join(' '));
  }
  /* === VIVENTIUM END === */

  return { client, userMCPAuthMap };
};

module.exports = { initializeClient };
/* === VIVENTIUM END === */
