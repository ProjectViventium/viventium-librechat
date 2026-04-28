const mongoose = require('mongoose');
const crypto = require('node:crypto');
const { logger } = require('@librechat/data-schemas');
const { getCustomEndpointConfig } = require('@librechat/api');
const {
  Tools,
  SystemRoles,
  ResourceType,
  actionDelimiter,
  isAgentsEndpoint,
  isEphemeralAgentId,
  encodeEphemeralAgentId,
} = require('librechat-data-provider');
const { mcp_all, mcp_delimiter } = require('librechat-data-provider').Constants;
/* === VIVENTIUM START ===
 * Feature: Optional agent cache to reduce DB latency (toggleable)
 * Purpose: Use the config store as a short-lived cache for Agent lookups (notably for Telegram + agents UI).
 * Added: 2026-02-07
 */
const { CacheKeys } = require('librechat-data-provider');
const { getLogStores } = require('~/cache');
/* === VIVENTIUM END === */
const {
  removeAgentFromAllProjects,
  removeAgentIdsFromProject,
  addAgentIdsToProject,
} = require('./Project');
const { removeAllPermissions } = require('~/server/services/PermissionService');
const { getMCPServerTools } = require('~/server/services/Config');
const { Agent, AclEntry, User } = require('~/db/models');
const { getActions } = require('./Action');

function normalizeAgentModelFields(agentLike, options = {}) {
  if (!agentLike || typeof agentLike !== 'object') {
    return agentLike;
  }

  const normalized = { ...agentLike };
  const existingModelParameters =
    options.existingModelParameters && typeof options.existingModelParameters === 'object'
      ? { ...options.existingModelParameters }
      : undefined;

  let modelParameters =
    normalized.model_parameters && typeof normalized.model_parameters === 'object'
      ? { ...normalized.model_parameters }
      : existingModelParameters;

  const topLevelModel =
    typeof normalized.model === 'string' && normalized.model.trim().length > 0
      ? normalized.model.trim()
      : '';
  const parameterModel =
    typeof modelParameters?.model === 'string' && modelParameters.model.trim().length > 0
      ? modelParameters.model.trim()
      : '';

  if (topLevelModel && modelParameters) {
    modelParameters.model = topLevelModel;
  } else if (!topLevelModel && parameterModel) {
    normalized.model = parameterModel;
  }

  if (modelParameters) {
    normalized.model_parameters = modelParameters;
  }

  return normalized;
}

function normalizeVoiceAgentModelFields(agentLike, options = {}) {
  if (!agentLike || typeof agentLike !== 'object') {
    return agentLike;
  }

  const normalized = { ...agentLike };
  const existingVoiceModelParameters =
    options.existingVoiceModelParameters && typeof options.existingVoiceModelParameters === 'object'
      ? { ...options.existingVoiceModelParameters }
      : undefined;

  let voiceModelParameters =
    normalized.voice_llm_model_parameters &&
    typeof normalized.voice_llm_model_parameters === 'object' &&
    !Array.isArray(normalized.voice_llm_model_parameters)
      ? { ...normalized.voice_llm_model_parameters }
      : existingVoiceModelParameters;

  const topLevelVoiceModel =
    typeof normalized.voice_llm_model === 'string' && normalized.voice_llm_model.trim().length > 0
      ? normalized.voice_llm_model.trim()
      : '';
  const parameterVoiceModel =
    typeof voiceModelParameters?.model === 'string' && voiceModelParameters.model.trim().length > 0
      ? voiceModelParameters.model.trim()
      : '';

  if (topLevelVoiceModel && voiceModelParameters) {
    voiceModelParameters.model = topLevelVoiceModel;
  } else if (!topLevelVoiceModel && parameterVoiceModel) {
    normalized.voice_llm_model = parameterVoiceModel;
  }

  if (voiceModelParameters) {
    normalized.voice_llm_model_parameters = voiceModelParameters;
  }

  return normalized;
}

function normalizeFallbackAgentModelFields(agentLike, options = {}) {
  if (!agentLike || typeof agentLike !== 'object') {
    return agentLike;
  }

  const normalized = { ...agentLike };
  const existingFallbackModelParameters =
    options.existingFallbackModelParameters &&
    typeof options.existingFallbackModelParameters === 'object'
      ? { ...options.existingFallbackModelParameters }
      : undefined;

  let fallbackModelParameters =
    normalized.fallback_llm_model_parameters &&
    typeof normalized.fallback_llm_model_parameters === 'object' &&
    !Array.isArray(normalized.fallback_llm_model_parameters)
      ? { ...normalized.fallback_llm_model_parameters }
      : existingFallbackModelParameters;

  const topLevelFallbackModel =
    typeof normalized.fallback_llm_model === 'string' &&
    normalized.fallback_llm_model.trim().length > 0
      ? normalized.fallback_llm_model.trim()
      : '';
  const parameterFallbackModel =
    typeof fallbackModelParameters?.model === 'string' &&
    fallbackModelParameters.model.trim().length > 0
      ? fallbackModelParameters.model.trim()
      : '';

  if (topLevelFallbackModel && fallbackModelParameters) {
    fallbackModelParameters.model = topLevelFallbackModel;
  } else if (!topLevelFallbackModel && parameterFallbackModel) {
    normalized.fallback_llm_model = parameterFallbackModel;
  }

  if (fallbackModelParameters) {
    normalized.fallback_llm_model_parameters = fallbackModelParameters;
  }

  return normalized;
}

function normalizeVoiceFallbackAgentModelFields(agentLike, options = {}) {
  if (!agentLike || typeof agentLike !== 'object') {
    return agentLike;
  }

  const normalized = { ...agentLike };
  const existingVoiceFallbackModelParameters =
    options.existingVoiceFallbackModelParameters &&
    typeof options.existingVoiceFallbackModelParameters === 'object'
      ? { ...options.existingVoiceFallbackModelParameters }
      : undefined;

  let voiceFallbackModelParameters =
    normalized.voice_fallback_llm_model_parameters &&
    typeof normalized.voice_fallback_llm_model_parameters === 'object' &&
    !Array.isArray(normalized.voice_fallback_llm_model_parameters)
      ? { ...normalized.voice_fallback_llm_model_parameters }
      : existingVoiceFallbackModelParameters;

  const topLevelVoiceFallbackModel =
    typeof normalized.voice_fallback_llm_model === 'string' &&
    normalized.voice_fallback_llm_model.trim().length > 0
      ? normalized.voice_fallback_llm_model.trim()
      : '';
  const parameterVoiceFallbackModel =
    typeof voiceFallbackModelParameters?.model === 'string' &&
    voiceFallbackModelParameters.model.trim().length > 0
      ? voiceFallbackModelParameters.model.trim()
      : '';

  if (topLevelVoiceFallbackModel && voiceFallbackModelParameters) {
    voiceFallbackModelParameters.model = topLevelVoiceFallbackModel;
  } else if (!topLevelVoiceFallbackModel && parameterVoiceFallbackModel) {
    normalized.voice_fallback_llm_model = parameterVoiceFallbackModel;
  }

  if (voiceFallbackModelParameters) {
    normalized.voice_fallback_llm_model_parameters = voiceFallbackModelParameters;
  }

  return normalized;
}

function normalizeAllAgentModelFields(agentLike, options = {}) {
  return normalizeVoiceFallbackAgentModelFields(
    normalizeFallbackAgentModelFields(
      normalizeVoiceAgentModelFields(normalizeAgentModelFields(agentLike, options), options),
      options,
    ),
    options,
  );
}

/* === VIVENTIUM START ===
 * Feature: Persist versioned direct field updates via $set
 * Purpose: Keep the live agent document aligned with version history when updateAgent mixes
 * direct field updates with operators like $push.
 * Added: 2026-04-12
 */
function normalizeAtomicUpdateDocument(updateData) {
  if (!updateData || typeof updateData !== 'object' || Array.isArray(updateData)) {
    return updateData;
  }

  const directEntries = Object.entries(updateData).filter(([key]) => !key.startsWith('$'));
  if (directEntries.length === 0) {
    return updateData;
  }

  const operatorEntries = Object.entries(updateData).filter(([key]) => key.startsWith('$'));
  return {
    ...Object.fromEntries(operatorEntries),
    $set: {
      ...(updateData.$set && typeof updateData.$set === 'object' && !Array.isArray(updateData.$set)
        ? updateData.$set
        : {}),
      ...Object.fromEntries(directEntries),
    },
  };
}
/* === VIVENTIUM END === */
/* === VIVENTIUM START ===
 * Feature: Deep Telegram timing instrumentation (toggleable)
 * Purpose: Surface agent load latency (db/cache) in Telegram traces.
 * Added: 2026-02-07
 */
const { startDeepTiming, logDeepTiming } = require('~/server/services/viventium/telegramTimingDeep');
/* === VIVENTIUM END === */
/**
 * Extracts unique MCP server names from tools array
 * Tools format: "toolName_mcp_serverName" or "sys__server__sys_mcp_serverName"
 * @param {string[]} tools - Array of tool identifiers
 * @returns {string[]} Array of unique MCP server names
 */
const extractMCPServerNames = (tools) => {
  if (!tools || !Array.isArray(tools)) {
    return [];
  }
  const serverNames = new Set();
  for (const tool of tools) {
    if (!tool || !tool.includes(mcp_delimiter)) {
      continue;
    }
    const parts = tool.split(mcp_delimiter);
    if (parts.length >= 2) {
      serverNames.add(parts[parts.length - 1]);
    }
  }
  return Array.from(serverNames);
};

/* === VIVENTIUM START ===
 * Feature: Optional agent cache to reduce DB latency (toggleable)
 *
 * Purpose:
 * - Cache Agent reads (`Agent.findOne({ id })`) with a short TTL to reduce DB round-trips and latency.
 *
 * Added: 2026-02-07
 */
const AGENT_CACHE_PREFIX = 'agent:';

const _agentCacheEnabled = () => {
  const raw = process.env.VIVENTIUM_AGENT_CACHE_ENABLED;
  if (raw == null) return false;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return false;
};

const _agentCacheTtlMs = () => {
  const raw = process.env.VIVENTIUM_AGENT_CACHE_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
};

const _getAgentCacheStore = () => (_agentCacheEnabled() ? getLogStores(CacheKeys.CONFIG_STORE) : null);

const _agentCacheKey = (agentId) => `${AGENT_CACHE_PREFIX}${agentId}`;

const _isCacheableAgentSearch = (searchParameter) => {
  if (!searchParameter || typeof searchParameter !== 'object') {
    return false;
  }
  const keys = Object.keys(searchParameter);
  if (keys.length !== 1 || !searchParameter.id) {
    return false;
  }
  const agentId = searchParameter.id;
  if (typeof agentId !== 'string' || !agentId) {
    return false;
  }
  if (isEphemeralAgentId(agentId)) {
    return false;
  }
  return true;
};

const _cacheAgent = async (agent) => {
  if (!agent || !agent.id || isEphemeralAgentId(agent.id)) {
    return;
  }
  const cache = _getAgentCacheStore();
  if (!cache) {
    return;
  }
  try {
    await cache.set(_agentCacheKey(agent.id), agent, _agentCacheTtlMs());
  } catch (error) {
    logger.debug('[agent-cache] Failed to set cache', error);
  }
};

const _clearAgentCache = async (agentId) => {
  if (!agentId || isEphemeralAgentId(agentId)) {
    return;
  }
  const cache = _getAgentCacheStore();
  if (!cache) {
    return;
  }
  try {
    await cache.delete(_agentCacheKey(agentId));
  } catch (error) {
    logger.debug('[agent-cache] Failed to clear cache', error);
  }
};
/* === VIVENTIUM END === */
/**
 * Create an agent with the provided data.
 * @param {Object} agentData - The agent data to create.
 * @returns {Promise<Agent>} The created agent document as a plain object.
 * @throws {Error} If the agent creation fails.
 */
const createAgent = async (agentData) => {
  const normalizedAgentData = normalizeAllAgentModelFields(agentData);
  const { author: _author, ...versionData } = normalizedAgentData;
  const timestamp = new Date();
  const initialAgentData = {
    ...normalizedAgentData,
    versions: [
      {
        ...normalizeAllAgentModelFields(versionData),
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    category: normalizedAgentData.category || 'general',
    mcpServerNames: extractMCPServerNames(normalizedAgentData.tools),
  };

  /* === VIVENTIUM START ===
   * Feature: Warm agent cache after creation
   * Purpose: Immediately cache the created agent to avoid first-read latency (Telegram/UI).
   * Added: 2026-02-07
   */
  const created = normalizeAllAgentModelFields((await Agent.create(initialAgentData)).toObject());
  await _cacheAgent(created);
  return created;
  /* === VIVENTIUM END === */
};

/**
 * Get an agent document based on the provided ID.
 *
 * @param {Object} searchParameter - The search parameters to find the agent to update.
 * @param {string} searchParameter.id - The ID of the agent to update.
 * @param {string} searchParameter.author - The user ID of the agent's author.
 * @returns {Promise<Agent|null>} The agent document as a plain object, or null if not found.
 */
/* === VIVENTIUM START ===
 * Feature: Optional agent cache to reduce DB latency (toggleable)
 * Purpose: Cache `Agent.findOne({ id })` results in the config store with TTL to reduce DB round-trips.
 * Added: 2026-02-07
 */
const getAgent = async (searchParameter) => await _getAgentWithCache(searchParameter);

const _getAgentWithCache = async (searchParameter) => {
  if (!_isCacheableAgentSearch(searchParameter)) {
    return await Agent.findOne(searchParameter).lean();
  }
  const cache = _getAgentCacheStore();
  const cacheKey = _agentCacheKey(searchParameter.id);
  if (cache) {
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    } catch (error) {
      logger.debug('[agent-cache] Failed to read cache', error);
    }
  }
  const agent = await Agent.findOne(searchParameter).lean();
  if (agent) {
    const normalizedAgent = normalizeAllAgentModelFields(agent);
    await _cacheAgent(normalizedAgent);
    return normalizedAgent;
  }
  return agent;
};
/* === VIVENTIUM END === */

/**
 * Get multiple agent documents based on the provided search parameters.
 *
 * @param {Object} searchParameter - The search parameters to find agents.
 * @returns {Promise<Agent[]>} Array of agent documents as plain objects.
 */
const getAgents = async (searchParameter) =>
  (await Agent.find(searchParameter).lean()).map((agent) => normalizeAllAgentModelFields(agent));

/**
 * Load an agent based on the provided ID
 *
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {string} params.spec
 * @param {string} params.agent_id
 * @param {string} params.endpoint
 * @param {import('@librechat/agents').ClientOptions} [params.model_parameters]
 * @returns {Promise<Agent|null>} The agent document as a plain object, or null if not found.
 */
const loadEphemeralAgent = async ({ req, spec, endpoint, model_parameters: _m }) => {
  const { model, ...model_parameters } = _m;
  const modelSpecs = req.config?.modelSpecs?.list;
  /** @type {TModelSpec | null} */
  let modelSpec = null;
  if (spec != null && spec !== '') {
    modelSpec = modelSpecs?.find((s) => s.name === spec) || null;
  }
  /** @type {TEphemeralAgent | null} */
  const ephemeralAgent = req.body.ephemeralAgent;
  const mcpServers = new Set(ephemeralAgent?.mcp);
  const userId = req.user?.id; // note: userId cannot be undefined at runtime
  if (modelSpec?.mcpServers) {
    for (const mcpServer of modelSpec.mcpServers) {
      mcpServers.add(mcpServer);
    }
  }
  /** @type {string[]} */
  const tools = [];
  if (ephemeralAgent?.execute_code === true || modelSpec?.executeCode === true) {
    tools.push(Tools.execute_code);
  }
  if (ephemeralAgent?.file_search === true || modelSpec?.fileSearch === true) {
    tools.push(Tools.file_search);
  }
  if (ephemeralAgent?.web_search === true || modelSpec?.webSearch === true) {
    tools.push(Tools.web_search);
  }

  const addedServers = new Set();
  if (mcpServers.size > 0) {
    for (const mcpServer of mcpServers) {
      if (addedServers.has(mcpServer)) {
        continue;
      }
      const serverTools = await getMCPServerTools(userId, mcpServer);
      if (!serverTools) {
        tools.push(`${mcp_all}${mcp_delimiter}${mcpServer}`);
        addedServers.add(mcpServer);
        continue;
      }
      tools.push(...Object.keys(serverTools));
      addedServers.add(mcpServer);
    }
  }

  const instructions = req.body.promptPrefix;

  // Get endpoint config for modelDisplayLabel fallback
  const appConfig = req.config;
  let endpointConfig = appConfig?.endpoints?.[endpoint];
  if (!isAgentsEndpoint(endpoint) && !endpointConfig) {
    try {
      endpointConfig = getCustomEndpointConfig({ endpoint, appConfig });
    } catch (err) {
      logger.error('[loadEphemeralAgent] Error getting custom endpoint config', err);
    }
  }

  // For ephemeral agents, use modelLabel if provided, then model spec's label,
  // then modelDisplayLabel from endpoint config, otherwise empty string to show model name
  const sender =
    model_parameters?.modelLabel ?? modelSpec?.label ?? endpointConfig?.modelDisplayLabel ?? '';

  // Encode ephemeral agent ID with endpoint, model, and computed sender for display
  const ephemeralId = encodeEphemeralAgentId({ endpoint, model, sender });

  const result = {
    id: ephemeralId,
    instructions,
    provider: endpoint,
    model_parameters,
    model,
    tools,
  };

  if (ephemeralAgent?.artifacts != null && ephemeralAgent.artifacts) {
    result.artifacts = ephemeralAgent.artifacts;
  }
  return result;
};

/**
 * Load an agent based on the provided ID
 *
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {string} params.spec
 * @param {string} params.agent_id
 * @param {string} params.endpoint
 * @param {import('@librechat/agents').ClientOptions} [params.model_parameters]
 * @returns {Promise<Agent|null>} The agent document as a plain object, or null if not found.
 */
const loadAgent = async ({ req, spec, agent_id, endpoint, model_parameters }) => {
  if (!agent_id) {
    return null;
  }
  if (isEphemeralAgentId(agent_id)) {
    return await loadEphemeralAgent({ req, spec, endpoint, model_parameters });
  }
  /* === VIVENTIUM START ===
     * Feature: Deep Telegram timing instrumentation (toggleable)
     * Purpose: Measure db/cache time for agent load (Telegram traces).
     * Added: 2026-02-07
     */
  const agentLoadStart = startDeepTiming(req);
  const agent = await getAgent({
    id: agent_id,
  });
  logDeepTiming(req, 'db_get_agent', agentLoadStart, `agentId=${agent_id}`);
  /* === VIVENTIUM END === */

  if (!agent) {
    return null;
  }

  const normalizedAgent = normalizeAllAgentModelFields(agent);
  normalizedAgent.version = normalizedAgent.versions ? normalizedAgent.versions.length : 0;
  return normalizedAgent;
};

/**
 * Check if a version already exists in the versions array, excluding timestamp and author fields
 * @param {Object} updateData - The update data to compare
 * @param {Object} currentData - The current agent data
 * @param {Array} versions - The existing versions array
 * @param {string} [actionsHash] - Hash of current action metadata
 * @returns {Object|null} - The matching version if found, null otherwise
 */
const isDuplicateVersion = (updateData, currentData, versions, actionsHash = null) => {
  if (!versions || versions.length === 0) {
    return null;
  }

  const excludeFields = [
    '_id',
    'id',
    'createdAt',
    'updatedAt',
    'author',
    'updatedBy',
    'created_at',
    'updated_at',
    '__v',
    'versions',
    'actionsHash', // Exclude actionsHash from direct comparison
  ];

  const { $push: _$push, $pull: _$pull, $addToSet: _$addToSet, ...directUpdates } = updateData;

  if (Object.keys(directUpdates).length === 0 && !actionsHash) {
    return null;
  }

  const wouldBeVersion = { ...currentData, ...directUpdates };
  const lastVersion = versions[versions.length - 1];

  if (actionsHash && lastVersion.actionsHash !== actionsHash) {
    return null;
  }

  const allFields = new Set([...Object.keys(wouldBeVersion), ...Object.keys(lastVersion)]);

  const importantFields = Array.from(allFields).filter((field) => !excludeFields.includes(field));

  let isMatch = true;
  for (const field of importantFields) {
    const wouldBeValue = wouldBeVersion[field];
    const lastVersionValue = lastVersion[field];

    // Skip if both are undefined/null
    if (!wouldBeValue && !lastVersionValue) {
      continue;
    }

    // Handle arrays
    if (Array.isArray(wouldBeValue) || Array.isArray(lastVersionValue)) {
      // Normalize: treat undefined/null as empty array for comparison
      let wouldBeArr;
      if (Array.isArray(wouldBeValue)) {
        wouldBeArr = wouldBeValue;
      } else if (wouldBeValue == null) {
        wouldBeArr = [];
      } else {
        wouldBeArr = [wouldBeValue];
      }

      let lastVersionArr;
      if (Array.isArray(lastVersionValue)) {
        lastVersionArr = lastVersionValue;
      } else if (lastVersionValue == null) {
        lastVersionArr = [];
      } else {
        lastVersionArr = [lastVersionValue];
      }

      if (wouldBeArr.length !== lastVersionArr.length) {
        isMatch = false;
        break;
      }

      // Special handling for projectIds (MongoDB ObjectIds)
      if (field === 'projectIds') {
        const wouldBeIds = wouldBeArr.map((id) => id.toString()).sort();
        const versionIds = lastVersionArr.map((id) => id.toString()).sort();

        if (!wouldBeIds.every((id, i) => id === versionIds[i])) {
          isMatch = false;
          break;
        }
      }
      // Handle arrays of objects
      else if (
        wouldBeArr.length > 0 &&
        typeof wouldBeArr[0] === 'object' &&
        wouldBeArr[0] !== null
      ) {
        const sortedWouldBe = [...wouldBeArr].map((item) => JSON.stringify(item)).sort();
        const sortedVersion = [...lastVersionArr].map((item) => JSON.stringify(item)).sort();

        if (!sortedWouldBe.every((item, i) => item === sortedVersion[i])) {
          isMatch = false;
          break;
        }
      } else {
        const sortedWouldBe = [...wouldBeArr].sort();
        const sortedVersion = [...lastVersionArr].sort();

        if (!sortedWouldBe.every((item, i) => item === sortedVersion[i])) {
          isMatch = false;
          break;
        }
      }
    }
    // Handle objects
    else if (typeof wouldBeValue === 'object' && wouldBeValue !== null) {
      const lastVersionObj =
        typeof lastVersionValue === 'object' && lastVersionValue !== null ? lastVersionValue : {};

      // For empty objects, normalize the comparison
      const wouldBeKeys = Object.keys(wouldBeValue);
      const lastVersionKeys = Object.keys(lastVersionObj);

      // If both are empty objects, they're equal
      if (wouldBeKeys.length === 0 && lastVersionKeys.length === 0) {
        continue;
      }

      // Otherwise do a deep comparison
      if (JSON.stringify(wouldBeValue) !== JSON.stringify(lastVersionObj)) {
        isMatch = false;
        break;
      }
    }
    // Handle primitive values
    else {
      // For primitives, handle the case where one is undefined and the other is a default value
      if (wouldBeValue !== lastVersionValue) {
        // Special handling for boolean false vs undefined
        if (
          typeof wouldBeValue === 'boolean' &&
          wouldBeValue === false &&
          lastVersionValue === undefined
        ) {
          continue;
        }
        // Special handling for empty string vs undefined
        if (
          typeof wouldBeValue === 'string' &&
          wouldBeValue === '' &&
          lastVersionValue === undefined
        ) {
          continue;
        }
        isMatch = false;
        break;
      }
    }
  }

  return isMatch ? lastVersion : null;
};

/**
 * Update an agent with new data without overwriting existing
 *  properties, or create a new agent if it doesn't exist.
 * When an agent is updated, a copy of the current state will be saved to the versions array.
 *
 * @param {Object} searchParameter - The search parameters to find the agent to update.
 * @param {string} searchParameter.id - The ID of the agent to update.
 * @param {string} [searchParameter.author] - The user ID of the agent's author.
 * @param {Object} updateData - An object containing the properties to update.
 * @param {Object} [options] - Optional configuration object.
 * @param {string} [options.updatingUserId] - The ID of the user performing the update (used for tracking non-author updates).
 * @param {boolean} [options.forceVersion] - Force creation of a new version even if no fields changed.
 * @param {boolean} [options.skipVersioning] - Skip version creation entirely (useful for isolated operations like sharing).
 * @returns {Promise<Agent>} The updated or newly created agent document as a plain object.
 * @throws {Error} If the update would create a duplicate version
 */
const updateAgent = async (searchParameter, updateData, options = {}) => {
  const { updatingUserId = null, forceVersion = false, skipVersioning = false } = options;
  const mongoOptions = { new: true, upsert: false };

  const currentAgent = await Agent.findOne(searchParameter);
  if (currentAgent) {
    const {
      __v,
      _id,
      id: __id,
      versions,
      author: _author,
      ...versionData
    } = currentAgent.toObject();
    updateData = normalizeAllAgentModelFields(updateData, {
      existingModelParameters: versionData.model_parameters,
      existingVoiceModelParameters: versionData.voice_llm_model_parameters,
      existingFallbackModelParameters: versionData.fallback_llm_model_parameters,
      existingVoiceFallbackModelParameters: versionData.voice_fallback_llm_model_parameters,
    });
    const { $push, $pull, $addToSet, ...directUpdates } = updateData;

    // Sync mcpServerNames when tools are updated
    if (directUpdates.tools !== undefined) {
      const mcpServerNames = extractMCPServerNames(directUpdates.tools);
      directUpdates.mcpServerNames = mcpServerNames;
      updateData.mcpServerNames = mcpServerNames; // Also update the original updateData
    }

    let actionsHash = null;

    // Generate actions hash if agent has actions
    if (currentAgent.actions && currentAgent.actions.length > 0) {
      // Extract action IDs from the format "domain_action_id"
      const actionIds = currentAgent.actions
        .map((action) => {
          const parts = action.split(actionDelimiter);
          return parts[1]; // Get just the action ID part
        })
        .filter(Boolean);

      if (actionIds.length > 0) {
        try {
          const actions = await getActions(
            {
              action_id: { $in: actionIds },
            },
            true,
          ); // Include sensitive data for hash

          actionsHash = await generateActionMetadataHash(currentAgent.actions, actions);
        } catch (error) {
          logger.error('Error fetching actions for hash generation:', error);
        }
      }
    }

    const shouldCreateVersion =
      !skipVersioning &&
      (forceVersion || Object.keys(directUpdates).length > 0 || $push || $pull || $addToSet);

    const hasDirectUpdateDrift = Object.entries(directUpdates).some(([key, value]) => {
      const currentValue = versionData[key];
      return JSON.stringify(currentValue ?? null) !== JSON.stringify(value ?? null);
    });

    if (shouldCreateVersion) {
      const duplicateVersion = isDuplicateVersion(updateData, versionData, versions, actionsHash);
      if (duplicateVersion && !forceVersion) {
        if (hasDirectUpdateDrift && !$push && !$pull && !$addToSet) {
          const repaired = normalizeAllAgentModelFields(
            await Agent.findOneAndUpdate(searchParameter, directUpdates, mongoOptions).lean(),
          );
          await _cacheAgent(repaired);
          return repaired;
        }
        // No changes detected, return the current agent without creating a new version
        const agentObj = normalizeAllAgentModelFields(currentAgent.toObject());
        agentObj.version = versions.length;
        /* === VIVENTIUM START ===
         * Feature: Keep agent cache warm on no-op updates
         * Purpose: Ensure cached agent stays fresh even when updateAgent returns early.
         * Added: 2026-02-07
         */
        await _cacheAgent(agentObj);
        /* === VIVENTIUM END === */
        return agentObj;
      }
    }

    const versionEntry = {
      ...versionData,
      ...directUpdates,
      updatedAt: new Date(),
    };

    // Include actions hash in version if available
    if (actionsHash) {
      versionEntry.actionsHash = actionsHash;
    }

    // Always store updatedBy field to track who made the change
    if (updatingUserId) {
      versionEntry.updatedBy = new mongoose.Types.ObjectId(updatingUserId);
    }

    if (shouldCreateVersion) {
      updateData.$push = {
        ...($push || {}),
        versions: versionEntry,
      };
    }
  }

  /* === VIVENTIUM START ===
   * Feature: Refresh agent cache after updates
   * Purpose: Keep cached agent aligned with the latest DB version after writes.
   * Added: 2026-02-07
   */
  updateData = normalizeAtomicUpdateDocument(normalizeAllAgentModelFields(updateData));
  const updated = normalizeAllAgentModelFields(
    await Agent.findOneAndUpdate(searchParameter, updateData, mongoOptions).lean(),
  );
  await _cacheAgent(updated);
  return updated;
  /* === VIVENTIUM END === */
};

/**
 * Modifies an agent with the resource file id.
 * @param {object} params
 * @param {ServerRequest} params.req
 * @param {string} params.agent_id
 * @param {string} params.tool_resource
 * @param {string} params.file_id
 * @returns {Promise<Agent>} The updated agent.
 */
const addAgentResourceFile = async ({ req, agent_id, tool_resource, file_id }) => {
  const searchParameter = { id: agent_id };
  let agent = await getAgent(searchParameter);
  if (!agent) {
    throw new Error('Agent not found for adding resource file');
  }
  const fileIdsPath = `tool_resources.${tool_resource}.file_ids`;
  await Agent.updateOne(
    {
      id: agent_id,
      [`${fileIdsPath}`]: { $exists: false },
    },
    {
      $set: {
        [`${fileIdsPath}`]: [],
      },
    },
  );

  const updateData = {
    $addToSet: {
      tools: tool_resource,
      [fileIdsPath]: file_id,
    },
  };

  const updatedAgent = await updateAgent(searchParameter, updateData, {
    updatingUserId: req?.user?.id,
  });
  if (updatedAgent) {
    return updatedAgent;
  } else {
    throw new Error('Agent not found for adding resource file');
  }
};

/**
 * Removes multiple resource files from an agent using atomic operations.
 * @param {object} params
 * @param {string} params.agent_id
 * @param {Array<{tool_resource: string, file_id: string}>} params.files
 * @returns {Promise<Agent>} The updated agent.
 * @throws {Error} If the agent is not found or update fails.
 */
const removeAgentResourceFiles = async ({ agent_id, files }) => {
  const searchParameter = { id: agent_id };

  // Group files to remove by resource
  const filesByResource = files.reduce((acc, { tool_resource, file_id }) => {
    if (!acc[tool_resource]) {
      acc[tool_resource] = [];
    }
    acc[tool_resource].push(file_id);
    return acc;
  }, {});

  // Step 1: Atomically remove file IDs using $pull
  const pullOps = {};
  const resourcesToCheck = new Set();
  for (const [resource, fileIds] of Object.entries(filesByResource)) {
    const fileIdsPath = `tool_resources.${resource}.file_ids`;
    pullOps[fileIdsPath] = { $in: fileIds };
    resourcesToCheck.add(resource);
  }

  const updatePullData = { $pull: pullOps };
  const agentAfterPull = await Agent.findOneAndUpdate(searchParameter, updatePullData, {
    new: true,
  }).lean();

  if (!agentAfterPull) {
    // Agent might have been deleted concurrently, or never existed.
    // Check if it existed before trying to throw.
    const agentExists = await getAgent(searchParameter);
    if (!agentExists) {
      throw new Error('Agent not found for removing resource files');
    }
    // If it existed but findOneAndUpdate returned null, something else went wrong.
    throw new Error('Failed to update agent during file removal (pull step)');
  }

  // Return the agent state directly after the $pull operation.
  // Skipping the $unset step for now to simplify and test core $pull atomicity.
  // Empty arrays might remain, but the removal itself should be correct.
  return agentAfterPull;
};

/**
 * Deletes an agent based on the provided ID.
 *
 * @param {Object} searchParameter - The search parameters to find the agent to delete.
 * @param {string} searchParameter.id - The ID of the agent to delete.
 * @param {string} [searchParameter.author] - The user ID of the agent's author.
 * @returns {Promise<void>} Resolves when the agent has been successfully deleted.
 */
const deleteAgent = async (searchParameter) => {
  const agent = await Agent.findOneAndDelete(searchParameter);
  if (agent) {
    await removeAgentFromAllProjects(agent.id);
    await Promise.all([
      removeAllPermissions({
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
      }),
      removeAllPermissions({
        resourceType: ResourceType.REMOTE_AGENT,
        resourceId: agent._id,
      }),
    ]);
    try {
      await Agent.updateMany({ 'edges.to': agent.id }, { $pull: { edges: { to: agent.id } } });
    } catch (error) {
      logger.error('[deleteAgent] Error removing agent from handoff edges', error);
    }
    try {
      await User.updateMany(
        { 'favorites.agentId': agent.id },
        { $pull: { favorites: { agentId: agent.id } } },
      );
    } catch (error) {
      logger.error('[deleteAgent] Error removing agent from user favorites', error);
    }
    /* === VIVENTIUM START ===
     * Feature: Clear agent cache after deletion
     * Purpose: Prevent stale agent reads after deletion.
     * Added: 2026-02-07
     */
    await _clearAgentCache(agent.id);
    /* === VIVENTIUM END === */
  }
  return agent;
};

/**
 * Deletes all agents created by a specific user.
 * @param {string} userId - The ID of the user whose agents should be deleted.
 * @returns {Promise<void>} A promise that resolves when all user agents have been deleted.
 */
const deleteUserAgents = async (userId) => {
  try {
    const userAgents = await getAgents({ author: userId });

    if (userAgents.length === 0) {
      return;
    }

    const agentIds = userAgents.map((agent) => agent.id);
    const agentObjectIds = userAgents.map((agent) => agent._id);

    for (const agentId of agentIds) {
      await removeAgentFromAllProjects(agentId);
    }

    await AclEntry.deleteMany({
      resourceType: { $in: [ResourceType.AGENT, ResourceType.REMOTE_AGENT] },
      resourceId: { $in: agentObjectIds },
    });

    try {
      await User.updateMany(
        { 'favorites.agentId': { $in: agentIds } },
        { $pull: { favorites: { agentId: { $in: agentIds } } } },
      );
    } catch (error) {
      logger.error('[deleteUserAgents] Error removing agents from user favorites', error);
    }

    await Agent.deleteMany({ author: userId });
    /* === VIVENTIUM START ===
     * Feature: Clear cached agents after user delete
     * Purpose: Prevent stale reads for agents that were deleted in bulk.
     * Added: 2026-02-07
     */
    for (const agentId of agentIds) {
      await _clearAgentCache(agentId);
    }
    /* === VIVENTIUM END === */
  } catch (error) {
    logger.error('[deleteUserAgents] General error:', error);
  }
};

/**
 * Get agents by accessible IDs with optional cursor-based pagination.
 * @param {Object} params - The parameters for getting accessible agents.
 * @param {Array} [params.accessibleIds] - Array of agent ObjectIds the user has ACL access to.
 * @param {Object} [params.otherParams] - Additional query parameters (including author filter).
 * @param {number} [params.limit] - Number of agents to return (max 100). If not provided, returns all agents.
 * @param {string} [params.after] - Cursor for pagination - get agents after this cursor. // base64 encoded JSON string with updatedAt and _id.
 * @returns {Promise<Object>} A promise that resolves to an object containing the agents data and pagination info.
 */
const getListAgentsByAccess = async ({
  accessibleIds = [],
  otherParams = {},
  limit = null,
  after = null,
}) => {
  const isPaginated = limit !== null && limit !== undefined;
  const normalizedLimit = isPaginated ? Math.min(Math.max(1, parseInt(limit) || 20), 100) : null;

  // Build base query combining ACL accessible agents with other filters
  const baseQuery = { ...otherParams, _id: { $in: accessibleIds } };

  // Add cursor condition
  if (after) {
    try {
      const cursor = JSON.parse(Buffer.from(after, 'base64').toString('utf8'));
      const { updatedAt, _id } = cursor;

      const cursorCondition = {
        $or: [
          { updatedAt: { $lt: new Date(updatedAt) } },
          { updatedAt: new Date(updatedAt), _id: { $gt: new mongoose.Types.ObjectId(_id) } },
        ],
      };

      // Merge cursor condition with base query
      if (Object.keys(baseQuery).length > 0) {
        baseQuery.$and = [{ ...baseQuery }, cursorCondition];
        // Remove the original conditions from baseQuery to avoid duplication
        Object.keys(baseQuery).forEach((key) => {
          if (key !== '$and') delete baseQuery[key];
        });
      } else {
        Object.assign(baseQuery, cursorCondition);
      }
    } catch (error) {
      logger.warn('Invalid cursor:', error.message);
    }
  }

  let query = Agent.find(baseQuery, {
    id: 1,
    _id: 1,
    name: 1,
    avatar: 1,
    author: 1,
    projectIds: 1,
    description: 1,
    updatedAt: 1,
    category: 1,
    support_contact: 1,
    is_promoted: 1,
  }).sort({ updatedAt: -1, _id: 1 });

  // Only apply limit if pagination is requested
  if (isPaginated) {
    query = query.limit(normalizedLimit + 1);
  }

  const agents = await query.lean();

  const hasMore = isPaginated ? agents.length > normalizedLimit : false;
  const data = (isPaginated ? agents.slice(0, normalizedLimit) : agents).map((agent) => {
    if (agent.author) {
      agent.author = agent.author.toString();
    }
    return agent;
  });

  // Generate next cursor only if paginated
  let nextCursor = null;
  if (isPaginated && hasMore && data.length > 0) {
    const lastAgent = agents[normalizedLimit - 1];
    nextCursor = Buffer.from(
      JSON.stringify({
        updatedAt: lastAgent.updatedAt.toISOString(),
        _id: lastAgent._id.toString(),
      }),
    ).toString('base64');
  }

  return {
    object: 'list',
    data,
    first_id: data.length > 0 ? data[0].id : null,
    last_id: data.length > 0 ? data[data.length - 1].id : null,
    has_more: hasMore,
    after: nextCursor,
  };
};

/**
 * Updates the projects associated with an agent, adding and removing project IDs as specified.
 * This function also updates the corresponding projects to include or exclude the agent ID.
 *
 * @param {Object} params - Parameters for updating the agent's projects.
 * @param {IUser} params.user - Parameters for updating the agent's projects.
 * @param {string} params.agentId - The ID of the agent to update.
 * @param {string[]} [params.projectIds] - Array of project IDs to add to the agent.
 * @param {string[]} [params.removeProjectIds] - Array of project IDs to remove from the agent.
 * @returns {Promise<MongoAgent>} The updated agent document.
 * @throws {Error} If there's an error updating the agent or projects.
 */
const updateAgentProjects = async ({ user, agentId, projectIds, removeProjectIds }) => {
  const updateOps = {};

  if (removeProjectIds && removeProjectIds.length > 0) {
    for (const projectId of removeProjectIds) {
      await removeAgentIdsFromProject(projectId, [agentId]);
    }
    updateOps.$pull = { projectIds: { $in: removeProjectIds } };
  }

  if (projectIds && projectIds.length > 0) {
    for (const projectId of projectIds) {
      await addAgentIdsToProject(projectId, [agentId]);
    }
    updateOps.$addToSet = { projectIds: { $each: projectIds } };
  }

  if (Object.keys(updateOps).length === 0) {
    return await getAgent({ id: agentId });
  }

  const updateQuery = { id: agentId, author: user.id };
  if (user.role === SystemRoles.ADMIN) {
    delete updateQuery.author;
  }

  const updatedAgent = await updateAgent(updateQuery, updateOps, {
    updatingUserId: user.id,
    skipVersioning: true,
  });
  if (updatedAgent) {
    return updatedAgent;
  }
  if (updateOps.$addToSet) {
    for (const projectId of projectIds) {
      await removeAgentIdsFromProject(projectId, [agentId]);
    }
  } else if (updateOps.$pull) {
    for (const projectId of removeProjectIds) {
      await addAgentIdsToProject(projectId, [agentId]);
    }
  }

  return await getAgent({ id: agentId });
};

/**
 * Reverts an agent to a specific version in its version history.
 * @param {Object} searchParameter - The search parameters to find the agent to revert.
 * @param {string} searchParameter.id - The ID of the agent to revert.
 * @param {string} [searchParameter.author] - The user ID of the agent's author.
 * @param {number} versionIndex - The index of the version to revert to in the versions array.
 * @returns {Promise<MongoAgent>} The updated agent document after reverting.
 * @throws {Error} If the agent is not found or the specified version does not exist.
 */
const revertAgentVersion = async (searchParameter, versionIndex) => {
  const agent = await Agent.findOne(searchParameter);
  if (!agent) {
    throw new Error('Agent not found');
  }

  if (!agent.versions || !agent.versions[versionIndex]) {
    throw new Error(`Version ${versionIndex} not found`);
  }

  const revertToVersion = agent.versions[versionIndex];

  const updateData = {
    ...revertToVersion,
  };

  delete updateData._id;
  delete updateData.id;
  delete updateData.versions;
  delete updateData.author;
  delete updateData.updatedBy;

  return normalizeAllAgentModelFields(
    await Agent.findOneAndUpdate(searchParameter, updateData, { new: true }).lean(),
  );
};

/**
 * Generates a hash of action metadata for version comparison
 * @param {string[]} actionIds - Array of action IDs in format "domain_action_id"
 * @param {Action[]} actions - Array of action documents
 * @returns {Promise<string>} - SHA256 hash of the action metadata
 */
const generateActionMetadataHash = async (actionIds, actions) => {
  if (!actionIds || actionIds.length === 0) {
    return '';
  }

  // Create a map of action_id to metadata for quick lookup
  const actionMap = new Map();
  actions.forEach((action) => {
    actionMap.set(action.action_id, action.metadata);
  });

  // Sort action IDs for consistent hashing
  const sortedActionIds = [...actionIds].sort();

  // Build a deterministic string representation of all action metadata
  const metadataString = sortedActionIds
    .map((actionFullId) => {
      // Extract just the action_id part (after the delimiter)
      const parts = actionFullId.split(actionDelimiter);
      const actionId = parts[1];

      const metadata = actionMap.get(actionId);
      if (!metadata) {
        return `${actionId}:null`;
      }

      // Sort metadata keys for deterministic output
      const sortedKeys = Object.keys(metadata).sort();
      const metadataStr = sortedKeys
        .map((key) => `${key}:${JSON.stringify(metadata[key])}`)
        .join(',');
      return `${actionId}:{${metadataStr}}`;
    })
    .join(';');

  // Use Web Crypto API to generate hash
  const encoder = new TextEncoder();
  const data = encoder.encode(metadataString);
  const hashBuffer = await crypto.webcrypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  return hashHex;
};
/**
 * Counts the number of promoted agents.
 * @returns  {Promise<number>} - The count of promoted agents
 */
const countPromotedAgents = async () => {
  const count = await Agent.countDocuments({ is_promoted: true });
  return count;
};

/**
 * Load a default agent based on the endpoint
 * @param {string} endpoint
 * @returns {Agent | null}
 */

module.exports = {
  getAgent,
  getAgents,
  loadAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  deleteUserAgents,
  revertAgentVersion,
  updateAgentProjects,
  countPromotedAgents,
  addAgentResourceFile,
  getListAgentsByAccess,
  removeAgentResourceFiles,
  generateActionMetadataHash,
};
