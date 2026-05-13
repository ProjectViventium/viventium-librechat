'use strict';

const DEFAULT_MODELS = {
  openAI: 'gpt-5.4',
  anthropic: 'claude-sonnet-4-5',
  xai: 'grok-4.20-non-reasoning',
  groq: 'meta-llama/llama-4-scout-17b-16e-instruct',
};

const APPROVED_MAIN_RUNTIME_FAMILIES = new Set([
  'anthropic::claude-opus-4-7',
  'openAI::gpt-5.4',
]);

const APPROVED_BACKGROUND_RUNTIME_FAMILIES = new Set([
  'anthropic::claude-sonnet-4-5',
  'anthropic::claude-opus-4-7',
  'openAI::gpt-5.4',
]);

const APPROVED_BACKGROUND_ACTIVATION_FAMILIES = new Set([
  'groq::meta-llama/llama-4-scout-17b-16e-instruct',
  'xai::grok-4.20-non-reasoning',
]);

/* === VIVENTIUM START ===
 * Keep shipped built-ins truthful to the selected local install surface.
 * The source bundle is intentionally richer than some install modes, so runtime normalization must
 * strip tools whose backing services were not enabled instead of persisting dead MCP/web/code tool
 * references into fresh-user built-ins.
 * === VIVENTIUM END === */
const TOOL_RUNTIME_GATES = Object.freeze([
  {
    envKey: 'START_GOOGLE_MCP',
    matches: (tool) =>
      tool === 'sys__server__sys_mcp_google_workspace' || tool.endsWith('_mcp_google_workspace'),
  },
  {
    envKey: 'START_MS365_MCP',
    matches: (tool) => tool === 'sys__server__sys_mcp_ms-365' || tool.endsWith('_mcp_ms-365'),
  },
  {
    envKey: 'START_GLASSHIVE',
    matches: (tool) =>
      tool === 'sys__server__sys_mcp_glasshive-workers-projects' ||
      tool.endsWith('_mcp_glasshive-workers-projects'),
  },
  {
    envKey: 'START_CODE_INTERPRETER',
    matches: (tool) => tool === 'execute_code',
  },
  {
    envKey: 'VIVENTIUM_WEB_SEARCH_ENABLED',
    matches: (tool) => tool === 'web_search',
  },
]);

/* === VIVENTIUM NOTE ===
 * Voice-fast defaults are a separate latency policy, not the built-in background-agent governance
 * baseline. Keeping OpenAI voice on a lighter realtime-friendly family must not be misread as a
 * license to drift text/background agents back to stale 4o-era execution models.
 * === VIVENTIUM NOTE === */
const DEFAULT_VOICE_MODELS = {
  openAI: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-5',
  xai: 'grok-4.20-non-reasoning',
};

const AGENT_RUNTIME_ENV_BY_ID = {
  agent_viventium_main_95aeb3: {
    providerEnv: 'VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER',
    modelEnv: 'VIVENTIUM_FC_CONSCIOUS_LLM_MODEL',
  },
  agent_viventium_background_analysis_95aeb3: {
    providerEnv: 'VIVENTIUM_CORTEX_BACKGROUND_ANALYSIS_LLM_PROVIDER',
    modelEnv: 'VIVENTIUM_CORTEX_BACKGROUND_ANALYSIS_LLM_MODEL',
  },
  agent_viventium_confirmation_bias_95aeb3: {
    providerEnv: 'VIVENTIUM_CORTEX_CONFIRMATION_BIAS_LLM_PROVIDER',
    modelEnv: 'VIVENTIUM_CORTEX_CONFIRMATION_BIAS_LLM_MODEL',
  },
  agent_viventium_red_team_95aeb3: {
    providerEnv: 'VIVENTIUM_CORTEX_RED_TEAM_LLM_PROVIDER',
    modelEnv: 'VIVENTIUM_CORTEX_RED_TEAM_LLM_MODEL',
  },
  agent_viventium_deep_research_95aeb3: {
    providerEnv: 'VIVENTIUM_CORTEX_DEEP_RESEARCH_LLM_PROVIDER',
    modelEnv: 'VIVENTIUM_CORTEX_DEEP_RESEARCH_LLM_MODEL',
  },
  agent_viventium_online_tool_use_95aeb3: {
    providerEnv: 'VIVENTIUM_CORTEX_PRODUCTIVITY_LLM_PROVIDER',
    modelEnv: 'VIVENTIUM_CORTEX_PRODUCTIVITY_LLM_MODEL',
  },
  agent_8Y1d7JNhpubtvzYz3hvEv: {
    providerEnv: 'VIVENTIUM_CORTEX_PRODUCTIVITY_LLM_PROVIDER',
    modelEnv: 'VIVENTIUM_CORTEX_PRODUCTIVITY_LLM_MODEL',
  },
  agent_viventium_parietal_cortex_95aeb3: {
    providerEnv: 'VIVENTIUM_CORTEX_PARIETAL_CORTEX_LLM_PROVIDER',
    modelEnv: 'VIVENTIUM_CORTEX_PARIETAL_CORTEX_LLM_MODEL',
  },
  agent_viventium_pattern_recognition_95aeb3: {
    providerEnv: 'VIVENTIUM_CORTEX_PATTERN_RECOGNITION_LLM_PROVIDER',
    modelEnv: 'VIVENTIUM_CORTEX_PATTERN_RECOGNITION_LLM_MODEL',
  },
  agent_viventium_emotional_resonance_95aeb3: {
    providerEnv: 'VIVENTIUM_CORTEX_EMOTIONAL_RESONANCE_LLM_PROVIDER',
    modelEnv: 'VIVENTIUM_CORTEX_EMOTIONAL_RESONANCE_LLM_MODEL',
  },
  agent_viventium_strategic_planning_95aeb3: {
    providerEnv: 'VIVENTIUM_CORTEX_STRATEGIC_PLANNING_LLM_PROVIDER',
    modelEnv: 'VIVENTIUM_CORTEX_STRATEGIC_PLANNING_LLM_MODEL',
  },
  agent_viventium_support_95aeb3: {
    providerEnv: 'VIVENTIUM_CORTEX_SUPPORT_LLM_PROVIDER',
    modelEnv: 'VIVENTIUM_CORTEX_SUPPORT_LLM_MODEL',
  },
};

const BUILT_IN_BACKGROUND_AGENT_IDS = Object.freeze(
  Object.keys(AGENT_RUNTIME_ENV_BY_ID).filter((agentId) => agentId !== 'agent_viventium_main_95aeb3'),
);

const CANONICAL_BUILT_IN_BACKGROUND_MODEL_PARAMETERS = Object.freeze({
  agent_viventium_confirmation_bias_95aeb3: Object.freeze({
    anthropic: Object.freeze({
      thinking: false,
    }),
  }),
  agent_viventium_red_team_95aeb3: Object.freeze({
    anthropic: Object.freeze({
      thinkingBudget: 4000,
    }),
  }),
  agent_viventium_deep_research_95aeb3: Object.freeze({
    openAI: Object.freeze({
      reasoning_effort: 'xhigh',
    }),
    anthropic: Object.freeze({
      thinkingBudget: 4000,
    }),
  }),
  agent_viventium_emotional_resonance_95aeb3: Object.freeze({
    anthropic: Object.freeze({
      thinking: false,
    }),
  }),
  agent_viventium_strategic_planning_95aeb3: Object.freeze({
    anthropic: Object.freeze({
      thinkingBudget: 2000,
    }),
  }),
});

const ACTIVATION_RUNTIME_ENV_BY_AGENT_ID = {
  agent_viventium_background_analysis_95aeb3: {
    providerEnv: 'VIVENTIUM_BACKGROUND_ACTIVATION_PROVIDER',
    modelEnv: 'VIVENTIUM_BACKGROUND_ACTIVATION_MODEL',
  },
  agent_viventium_confirmation_bias_95aeb3: {
    providerEnv: 'VIVENTIUM_CORTEX_CONFIRMATION_BIAS_ACTIVATION_LLM_PROVIDER',
    modelEnv: 'VIVENTIUM_CORTEX_CONFIRMATION_BIAS_ACTIVATION_LLM_MODEL',
  },
  agent_viventium_red_team_95aeb3: {
    providerEnv: 'VIVENTIUM_BACKGROUND_ACTIVATION_PROVIDER',
    modelEnv: 'VIVENTIUM_BACKGROUND_ACTIVATION_MODEL',
  },
  agent_viventium_deep_research_95aeb3: {
    providerEnv: 'VIVENTIUM_CORTEX_DEEP_RESEARCH_ACTIVATION_LLM_PROVIDER',
    modelEnv: 'VIVENTIUM_CORTEX_DEEP_RESEARCH_ACTIVATION_LLM_MODEL',
  },
  agent_viventium_online_tool_use_95aeb3: {
    providerEnv: 'OTUC_ACTIVATION_PROVIDER',
    modelEnv: 'OTUC_ACTIVATION_LLM',
  },
  agent_8Y1d7JNhpubtvzYz3hvEv: {
    providerEnv: 'OTUC_ACTIVATION_PROVIDER',
    modelEnv: 'OTUC_ACTIVATION_LLM',
  },
  agent_viventium_parietal_cortex_95aeb3: {
    providerEnv: 'VIVENTIUM_CORTEX_PARIETAL_CORTEX_ACTIVATION_LLM_PROVIDER',
    modelEnv: 'VIVENTIUM_CORTEX_PARIETAL_CORTEX_ACTIVATION_LLM_MODEL',
  },
  agent_viventium_pattern_recognition_95aeb3: {
    providerEnv: 'VIVENTIUM_BACKGROUND_ACTIVATION_PROVIDER',
    modelEnv: 'VIVENTIUM_BACKGROUND_ACTIVATION_MODEL',
  },
  agent_viventium_emotional_resonance_95aeb3: {
    providerEnv: 'VIVENTIUM_BACKGROUND_ACTIVATION_PROVIDER',
    modelEnv: 'VIVENTIUM_BACKGROUND_ACTIVATION_MODEL',
  },
  agent_viventium_strategic_planning_95aeb3: {
    providerEnv: 'VIVENTIUM_BACKGROUND_ACTIVATION_PROVIDER',
    modelEnv: 'VIVENTIUM_BACKGROUND_ACTIVATION_MODEL',
  },
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeProvider(provider) {
  const raw = String(provider || '').trim().toLowerCase();
  if (!raw) {
    return '';
  }
  if (raw === 'undefined' || raw === 'null') {
    return '';
  }
  if (raw === 'openai') {
    return 'openAI';
  }
  if (raw === 'azureopenai' || raw === 'azure_openai') {
    return 'azureOpenAI';
  }
  if (raw === 'x_ai') {
    return 'xai';
  }
  return raw;
}

function envFlagEnabled(name, { env = process.env } = {}) {
  const normalized = String(env[name] ?? '')
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function toolAvailableAtRuntime(tool, { env = process.env } = {}) {
  for (const gate of TOOL_RUNTIME_GATES) {
    if (!gate.matches(tool)) {
      continue;
    }
    return envFlagEnabled(gate.envKey, { env });
  }
  return true;
}

function pruneUnavailableTools(agent, { env = process.env } = {}) {
  if (!agent || !Array.isArray(agent.tools)) {
    return agent;
  }

  return {
    ...deepClone(agent),
    tools: agent.tools.filter((tool) => toolAvailableAtRuntime(tool, { env })),
  };
}

function readRuntimeAssignment({
  env = process.env,
  providerEnv,
  modelEnv,
  fallbackProvider,
  fallbackModel,
  approvedFamilies = null,
}) {
  const provider = normalizeProvider(env[providerEnv] || fallbackProvider);
  const model = String(env[modelEnv] || fallbackModel || DEFAULT_MODELS[provider] || '').trim();
  const fallback = {
    provider: normalizeProvider(fallbackProvider),
    model: String(
      fallbackModel ||
        DEFAULT_MODELS[normalizeProvider(fallbackProvider)] ||
        '',
    ).trim(),
  };

  const candidates = [
    { provider, model },
    fallback,
  ];

  for (const candidate of candidates) {
    if (!candidate.provider || !candidate.model) {
      continue;
    }
    if (
      approvedFamilies &&
      approvedFamilies.size > 0 &&
      !approvedFamilies.has(`${candidate.provider}::${candidate.model}`)
    ) {
      continue;
    }
    return candidate;
  }

  return null;
}

function readVoiceAssignment(
  {
    explicitProvider = '',
    explicitModel = '',
    mainProvider = '',
    mainModel = '',
  },
) {
  const provider = normalizeProvider(explicitProvider);
  const model = String(explicitModel || '').trim();

  if (!provider) {
    return null;
  }
  if (!model) {
    return null;
  }

  const normalizedMainProvider = normalizeProvider(mainProvider);
  const normalizedMainModel = String(mainModel || '').trim();
  if (provider === normalizedMainProvider && model === normalizedMainModel) {
    return null;
  }

  return { provider, model };
}

function canonicalBuiltInBackgroundModelParameters(agentId, provider) {
  const normalizedProvider = normalizeProvider(provider);
  if (!BUILT_IN_BACKGROUND_AGENT_IDS.includes(agentId)) {
    return null;
  }
  const byProvider = CANONICAL_BUILT_IN_BACKGROUND_MODEL_PARAMETERS[agentId] || {};
  const canonical = byProvider[normalizedProvider];
  return canonical ? deepClone(canonical) : {};
}

function rewriteAgentForRuntime(agent, { env = process.env } = {}) {
  if (!agent?.id) {
    return agent;
  }
  let rewritten = deepClone(agent);
  const envMap = AGENT_RUNTIME_ENV_BY_ID[rewritten.id];
  if (envMap) {
    const assignment = readRuntimeAssignment({
      env,
      ...envMap,
      fallbackProvider: rewritten.provider,
      fallbackModel: rewritten.model,
      approvedFamilies:
        rewritten.id === 'agent_viventium_main_95aeb3'
          ? APPROVED_MAIN_RUNTIME_FAMILIES
          : APPROVED_BACKGROUND_RUNTIME_FAMILIES,
    });
    if (assignment) {
      rewritten.provider = assignment.provider;
      rewritten.model = assignment.model;
      const canonicalBuiltInParameters = canonicalBuiltInBackgroundModelParameters(
        rewritten.id,
        assignment.provider,
      );
      if (canonicalBuiltInParameters !== null) {
        rewritten.model_parameters = {
          ...canonicalBuiltInParameters,
          model: assignment.model,
        };
      } else if (
        rewritten.model_parameters &&
        typeof rewritten.model_parameters === 'object' &&
        !Array.isArray(rewritten.model_parameters)
      ) {
        rewritten.model_parameters = {
          ...deepClone(rewritten.model_parameters),
          model: assignment.model,
        };
      }
    }
  }
  if (rewritten.id === 'agent_viventium_main_95aeb3') {
    const voiceAssignment = readVoiceAssignment({
      explicitProvider: rewritten.voice_llm_provider,
      explicitModel: rewritten.voice_llm_model,
      mainProvider: rewritten.provider,
      mainModel: rewritten.model,
    });
    if (voiceAssignment) {
      rewritten.voice_llm_provider = voiceAssignment.provider;
      rewritten.voice_llm_model = voiceAssignment.model;
    } else if (
      Object.prototype.hasOwnProperty.call(rewritten, 'voice_llm_provider') ||
      Object.prototype.hasOwnProperty.call(rewritten, 'voice_llm_model')
    ) {
      rewritten.voice_llm_provider = null;
      rewritten.voice_llm_model = null;
    }
    const voiceFallbackAssignment = readVoiceAssignment({
      explicitProvider: rewritten.voice_fallback_llm_provider,
      explicitModel: rewritten.voice_fallback_llm_model,
      mainProvider: voiceAssignment?.provider || rewritten.provider,
      mainModel: voiceAssignment?.model || rewritten.model,
    });
    if (voiceFallbackAssignment) {
      rewritten.voice_fallback_llm_provider = voiceFallbackAssignment.provider;
      rewritten.voice_fallback_llm_model = voiceFallbackAssignment.model;
    } else if (
      Object.prototype.hasOwnProperty.call(rewritten, 'voice_fallback_llm_provider') ||
      Object.prototype.hasOwnProperty.call(rewritten, 'voice_fallback_llm_model')
    ) {
      rewritten.voice_fallback_llm_provider = null;
      rewritten.voice_fallback_llm_model = null;
    }
  }
  rewritten = pruneUnavailableTools(rewritten, { env });
  return rewritten;
}

function rewriteBackgroundCortices(backgroundCortices, { env = process.env } = {}) {
  if (!Array.isArray(backgroundCortices)) {
    return backgroundCortices;
  }
  return backgroundCortices.map((cortex) => {
    if (!cortex || !cortex.agent_id || !cortex.activation) {
      return cortex;
    }
    const envMap = ACTIVATION_RUNTIME_ENV_BY_AGENT_ID[cortex.agent_id];
    if (!envMap) {
      return cortex;
    }
    const assignment = readRuntimeAssignment({
      env,
      ...envMap,
      fallbackProvider: cortex.activation.provider || 'groq',
      fallbackModel: cortex.activation.model || DEFAULT_MODELS.groq,
      approvedFamilies: APPROVED_BACKGROUND_ACTIVATION_FAMILIES,
    });
    if (!assignment) {
      return cortex;
    }
    return {
      ...deepClone(cortex),
      activation: {
        ...deepClone(cortex.activation),
        provider: assignment.provider,
        model: assignment.model,
      },
    };
  });
}

function resolveCanonicalRuntimeTools(agent, existingAgent = null, { env = process.env } = {}) {
  const sourceTools = Array.isArray(existingAgent?.tools)
    ? deepClone(existingAgent.tools)
    : Array.isArray(agent?.tools)
      ? deepClone(agent.tools)
      : null;

  if (sourceTools == null) {
    return null;
  }

  // Preserve the live tool array unless the current runtime cannot back a tool at all.
  return pruneUnavailableTools({ tools: sourceTools }, { env }).tools;
}

function buildCanonicalPersistedAgentFields(agent, existingAgent = null, { env = process.env } = {}) {
  if (!agent || typeof agent !== 'object') {
    return null;
  }

  const patch = {};
  const provider = normalizeProvider(agent.provider || existingAgent?.provider);
  const model = String(agent.model || agent.model_parameters?.model || existingAgent?.model || '').trim();

  if (provider) {
    patch.provider = provider;
  }
  if (model) {
    patch.model = model;
  }

  const existingModelParameters =
    existingAgent?.model_parameters &&
    typeof existingAgent.model_parameters === 'object' &&
    !Array.isArray(existingAgent.model_parameters)
      ? deepClone(existingAgent.model_parameters)
      : {};
  const incomingModelParameters =
    agent.model_parameters &&
    typeof agent.model_parameters === 'object' &&
    !Array.isArray(agent.model_parameters)
      ? deepClone(agent.model_parameters)
      : {};
  const canonicalBuiltInParameters = canonicalBuiltInBackgroundModelParameters(agent.id, provider);

  if (canonicalBuiltInParameters !== null) {
    patch.model_parameters = patch.model
      ? {
          ...canonicalBuiltInParameters,
          model: patch.model,
        }
      : canonicalBuiltInParameters;
  } else {
    const mergedModelParameters = {
      ...existingModelParameters,
      ...incomingModelParameters,
    };

    if (patch.model) {
      mergedModelParameters.model = patch.model;
    }

    if (Object.keys(mergedModelParameters).length > 0) {
      patch.model_parameters = mergedModelParameters;
    }
  }

  const canonicalTools = resolveCanonicalRuntimeTools(agent, existingAgent, { env });
  if (canonicalTools !== null) {
    patch.tools = canonicalTools;
  }

  if (Object.prototype.hasOwnProperty.call(agent, 'voice_llm_provider')) {
    patch.voice_llm_provider = agent.voice_llm_provider ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(agent, 'voice_llm_model')) {
    patch.voice_llm_model = agent.voice_llm_model ?? null;
  }

  const hasIncomingVoiceModelParameters = Object.prototype.hasOwnProperty.call(
    agent,
    'voice_llm_model_parameters',
  );
  const existingVoiceModelParameters =
    existingAgent?.voice_llm_model_parameters &&
    typeof existingAgent.voice_llm_model_parameters === 'object' &&
    !Array.isArray(existingAgent.voice_llm_model_parameters)
      ? deepClone(existingAgent.voice_llm_model_parameters)
      : {};
  const incomingVoiceModelParameters =
    hasIncomingVoiceModelParameters &&
    agent.voice_llm_model_parameters &&
    typeof agent.voice_llm_model_parameters === 'object' &&
    !Array.isArray(agent.voice_llm_model_parameters)
      ? deepClone(agent.voice_llm_model_parameters)
      : {};

  if (
    hasIncomingVoiceModelParameters ||
    Object.prototype.hasOwnProperty.call(agent, 'voice_llm_model')
  ) {
    const mergedVoiceModelParameters =
      patch.voice_llm_model === null
        ? {}
        : {
            ...existingVoiceModelParameters,
            ...incomingVoiceModelParameters,
            ...(patch.voice_llm_model ? { model: patch.voice_llm_model } : {}),
          };

    patch.voice_llm_model_parameters = mergedVoiceModelParameters;
  }

  if (Object.prototype.hasOwnProperty.call(agent, 'voice_fallback_llm_provider')) {
    patch.voice_fallback_llm_provider = agent.voice_fallback_llm_provider ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(agent, 'voice_fallback_llm_model')) {
    patch.voice_fallback_llm_model = agent.voice_fallback_llm_model ?? null;
  }

  const hasIncomingVoiceFallbackModelParameters = Object.prototype.hasOwnProperty.call(
    agent,
    'voice_fallback_llm_model_parameters',
  );
  const existingVoiceFallbackModelParameters =
    existingAgent?.voice_fallback_llm_model_parameters &&
    typeof existingAgent.voice_fallback_llm_model_parameters === 'object' &&
    !Array.isArray(existingAgent.voice_fallback_llm_model_parameters)
      ? deepClone(existingAgent.voice_fallback_llm_model_parameters)
      : {};
  const incomingVoiceFallbackModelParameters =
    hasIncomingVoiceFallbackModelParameters &&
    agent.voice_fallback_llm_model_parameters &&
    typeof agent.voice_fallback_llm_model_parameters === 'object' &&
    !Array.isArray(agent.voice_fallback_llm_model_parameters)
      ? deepClone(agent.voice_fallback_llm_model_parameters)
      : {};

  if (
    hasIncomingVoiceFallbackModelParameters ||
    Object.prototype.hasOwnProperty.call(agent, 'voice_fallback_llm_model')
  ) {
    const mergedVoiceFallbackModelParameters =
      patch.voice_fallback_llm_model === null
        ? {}
        : {
            ...existingVoiceFallbackModelParameters,
            ...incomingVoiceFallbackModelParameters,
            ...(patch.voice_fallback_llm_model ? { model: patch.voice_fallback_llm_model } : {}),
          };

    patch.voice_fallback_llm_model_parameters = mergedVoiceFallbackModelParameters;
  }

  if (Object.prototype.hasOwnProperty.call(agent, 'fallback_llm_provider')) {
    patch.fallback_llm_provider = agent.fallback_llm_provider ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(agent, 'fallback_llm_model')) {
    patch.fallback_llm_model = agent.fallback_llm_model ?? null;
  }

  const hasIncomingFallbackModelParameters = Object.prototype.hasOwnProperty.call(
    agent,
    'fallback_llm_model_parameters',
  );
  const existingFallbackModelParameters =
    existingAgent?.fallback_llm_model_parameters &&
    typeof existingAgent.fallback_llm_model_parameters === 'object' &&
    !Array.isArray(existingAgent.fallback_llm_model_parameters)
      ? deepClone(existingAgent.fallback_llm_model_parameters)
      : {};
  const incomingFallbackModelParameters =
    hasIncomingFallbackModelParameters &&
    agent.fallback_llm_model_parameters &&
    typeof agent.fallback_llm_model_parameters === 'object' &&
    !Array.isArray(agent.fallback_llm_model_parameters)
      ? deepClone(agent.fallback_llm_model_parameters)
      : {};

  if (
    hasIncomingFallbackModelParameters ||
    Object.prototype.hasOwnProperty.call(agent, 'fallback_llm_model')
  ) {
    const mergedFallbackModelParameters =
      patch.fallback_llm_model === null
        ? {}
        : {
            ...existingFallbackModelParameters,
            ...incomingFallbackModelParameters,
            ...(patch.fallback_llm_model ? { model: patch.fallback_llm_model } : {}),
          };

    patch.fallback_llm_model_parameters = mergedFallbackModelParameters;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function hasCanonicalPersistedAgentFieldDrift(existingAgent, patch) {
  if (!existingAgent || !patch || typeof patch !== 'object') {
    return false;
  }

  return Object.entries(patch).some(([key, value]) => {
    return JSON.stringify(existingAgent[key] ?? null) !== JSON.stringify(value ?? null);
  });
}

function normalizeBundleForRuntime(bundle, { env = process.env } = {}) {
  const normalized = deepClone(bundle);

  if (normalized.mainAgent) {
    normalized.mainAgent = rewriteAgentForRuntime(normalized.mainAgent, { env });
    normalized.mainAgent.background_cortices = rewriteBackgroundCortices(
      normalized.mainAgent.background_cortices,
      { env },
    );
  }

  if (Array.isArray(normalized.backgroundAgents)) {
    normalized.backgroundAgents = normalized.backgroundAgents.map((agent) =>
      rewriteAgentForRuntime(agent, { env }),
    );
  }

  return normalized;
}

module.exports = {
  DEFAULT_MODELS,
  DEFAULT_VOICE_MODELS,
  APPROVED_MAIN_RUNTIME_FAMILIES,
  APPROVED_BACKGROUND_RUNTIME_FAMILIES,
  APPROVED_BACKGROUND_ACTIVATION_FAMILIES,
  CANONICAL_BUILT_IN_BACKGROUND_MODEL_PARAMETERS,
  BUILT_IN_BACKGROUND_AGENT_IDS,
  AGENT_RUNTIME_ENV_BY_ID,
  ACTIVATION_RUNTIME_ENV_BY_AGENT_ID,
  normalizeProvider,
  envFlagEnabled,
  toolAvailableAtRuntime,
  pruneUnavailableTools,
  readRuntimeAssignment,
  readVoiceAssignment,
  rewriteAgentForRuntime,
  rewriteBackgroundCortices,
  buildCanonicalPersistedAgentFields,
  hasCanonicalPersistedAgentFieldDrift,
  normalizeBundleForRuntime,
};
