/* === VIVENTIUM START ===
 * Feature: Voice Phase A async policy resolution.
 *
 * Purpose:
 * - Keep `client.js` orchestration readable by isolating env-driven policy decisions.
 * - Preserve functionality parity for tool-focused cortex hold behavior.
 *
 * Added: 2026-03-04
 * === VIVENTIUM END === */

const {
  collectConfiguredHoldScopeKeys,
  collectEffectiveDirectActionScopeKeys,
  isToolHoldCandidate,
} = require('~/server/services/viventium/brewingHold');

const asBool = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
};

const getBackgroundCortices = (agent) =>
  Array.isArray(agent?.background_cortices) ? agent.background_cortices : [];

const getConfiguredToolHoldScopeKeys = (agent) => {
  const backgroundCortices = getBackgroundCortices(agent);
  if (backgroundCortices.length === 0) {
    return [];
  }

  return collectConfiguredHoldScopeKeys(backgroundCortices);
};

const hasToolHoldCandidateConfigured = (agent) =>
  getBackgroundCortices(agent).some((cortex) => isToolHoldCandidate(cortex));

const shouldAllowAsyncWhenToolHoldConfigured = () =>
  asBool(process.env.VIVENTIUM_VOICE_PHASE_A_ASYNC_ALLOW_TOOL_HOLD);

const normalizeScopeKey = (scopeKey) => String(scopeKey || '').trim().toLowerCase();

const getUnownedToolHoldScopeKeys = (
  agent,
  { directActionSurfaces, agentTools, toolDefinitions } = {},
) => {
  const toolHoldScopeKeys = getConfiguredToolHoldScopeKeys(agent);
  if (toolHoldScopeKeys.length === 0) {
    return [];
  }

  const effectiveScopeKeys = new Set(
    collectEffectiveDirectActionScopeKeys({
      directActionSurfaces,
      agentTools,
      toolDefinitions,
    }).map(normalizeScopeKey),
  );

  return toolHoldScopeKeys.filter((scopeKey) => !effectiveScopeKeys.has(normalizeScopeKey(scopeKey)));
};

function resolveVoicePhaseAAsyncPolicy({
  voiceMode,
  agent,
  directActionSurfaces,
  agentTools,
  toolDefinitions,
}) {
  if (!voiceMode) {
    return {
      enabled: false,
      requested: false,
      forcedOff: false,
      reason: 'not_voice_mode',
      toolHoldScopeKeys: [],
      unownedToolHoldScopeKeys: [],
    };
  }

  const requested = asBool(process.env.VIVENTIUM_VOICE_BACKGROUND_AGENT_DETECTION_ASYNC);
  if (!requested) {
    return {
      enabled: false,
      requested: false,
      forcedOff: false,
      reason: 'async_not_requested',
      toolHoldScopeKeys: [],
      unownedToolHoldScopeKeys: [],
    };
  }

  const toolHoldScopeKeys = getConfiguredToolHoldScopeKeys(agent);
  if (toolHoldScopeKeys.length === 0) {
    return {
      enabled: true,
      requested: true,
      forcedOff: false,
      reason: 'enabled',
      toolHoldScopeKeys,
      unownedToolHoldScopeKeys: [],
    };
  }

  const unownedToolHoldScopeKeys = getUnownedToolHoldScopeKeys(agent, {
    directActionSurfaces,
    agentTools,
    toolDefinitions,
  });
  if (unownedToolHoldScopeKeys.length === 0) {
    return {
      enabled: true,
      requested: true,
      forcedOff: false,
      reason: 'direct_action_owned',
      toolHoldScopeKeys,
      unownedToolHoldScopeKeys,
    };
  }

  if (shouldAllowAsyncWhenToolHoldConfigured()) {
    return {
      enabled: true,
      requested: true,
      forcedOff: false,
      reason: 'tool_hold_override',
      toolHoldScopeKeys,
      unownedToolHoldScopeKeys,
    };
  }

  return {
    enabled: false,
    requested: true,
    forcedOff: true,
    reason: 'unowned_tool_hold_candidate_configured',
    toolHoldScopeKeys,
    unownedToolHoldScopeKeys,
  };
}

async function resolveVoicePhaseAAsyncPolicyWithHydratedTools({
  voiceMode,
  agent,
  directActionSurfaces,
  agentTools,
  toolDefinitions,
  hydrateAgentTools,
}) {
  const initialPolicy = resolveVoicePhaseAAsyncPolicy({
    voiceMode,
    agent,
    directActionSurfaces,
    agentTools,
    toolDefinitions,
  });

  if (
    !initialPolicy.forcedOff ||
    initialPolicy.reason !== 'unowned_tool_hold_candidate_configured' ||
    typeof hydrateAgentTools !== 'function'
  ) {
    return initialPolicy;
  }

  const hasRequestTools =
    (Array.isArray(agentTools) && agentTools.length > 0) ||
    (Array.isArray(toolDefinitions) && toolDefinitions.length > 0) ||
    (Array.isArray(agent?.tools) && agent.tools.length > 0);
  if (hasRequestTools) {
    return initialPolicy;
  }

  const hydratedAgent = await hydrateAgentTools(agent);
  if (!hydratedAgent || hydratedAgent === agent) {
    return initialPolicy;
  }

  const hydratedTools = Array.isArray(hydratedAgent.tools) ? hydratedAgent.tools : [];
  if (hydratedTools.length === 0) {
    return initialPolicy;
  }

  const hydratedPolicy = resolveVoicePhaseAAsyncPolicy({
    voiceMode,
    agent: hydratedAgent,
    directActionSurfaces,
    agentTools: hydratedTools,
    toolDefinitions,
  });

  return {
    ...hydratedPolicy,
    hydratedToolPolicy: true,
    initialReason: initialPolicy.reason,
    initialUnownedToolHoldScopeKeys: initialPolicy.unownedToolHoldScopeKeys,
  };
}

module.exports = {
  resolveVoicePhaseAAsyncPolicy,
  resolveVoicePhaseAAsyncPolicyWithHydratedTools,
  hasToolHoldCandidateConfigured,
  getConfiguredToolHoldScopeKeys,
  getUnownedToolHoldScopeKeys,
  shouldAllowAsyncWhenToolHoldConfigured,
};
