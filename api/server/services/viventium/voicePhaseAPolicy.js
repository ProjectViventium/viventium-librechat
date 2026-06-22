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
  const raw = String(value || '')
    .trim()
    .toLowerCase();
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

const normalizeScopeKey = (scopeKey) =>
  String(scopeKey || '')
    .trim()
    .toLowerCase();

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

  return toolHoldScopeKeys.filter(
    (scopeKey) => !effectiveScopeKeys.has(normalizeScopeKey(scopeKey)),
  );
};

function resolveVoicePhaseAAsyncPolicy({
  voiceMode,
  agent,
  directActionSurfaces,
  agentTools,
  toolDefinitions,
}) {
  /* === VIVENTIUM START ===
   * Feature: text-chat speculative parallel Activation Detection (default off).
   * Toggle: VIVENTIUM_CORTEX_SPECULATIVE_PARALLEL_DETECT. When on, text chat reuses the SAME
   * non-blocking Phase A + Phase B + follow-up pipeline as voice — the main answer proceeds while
   * Activation Detection runs, and activated Background Cortices surface via the follow-up turn
   * instead of blocking the first answer. The same tool-hold fail-closed checks below still apply
   * (a tool-owning cortex forces the blocking path, preserving cortex tool-ownership), and the main
   * run is never discarded, so there is no speculative tool side-effect risk. When the flag is off,
   * text chat is byte-identical to before (returns not_voice_mode).
   * === VIVENTIUM END === */
  const textAsyncFlagRaw =
    process.env.VIVENTIUM_TEXT_BACKGROUND_AGENT_DETECTION_ASYNC ??
    process.env.VIVENTIUM_CORTEX_SPECULATIVE_PARALLEL_DETECT; // legacy alias (pre-2026-05-30)
  const textChatAsyncRequested =
    !voiceMode &&
    ['1', 'true', 'yes', 'on'].includes(
      String(textAsyncFlagRaw || '')
        .trim()
        .toLowerCase(),
    );
  if (!voiceMode && !textChatAsyncRequested) {
    return {
      enabled: false,
      requested: false,
      forcedOff: false,
      reason: 'not_voice_mode',
      toolHoldScopeKeys: [],
      unownedToolHoldScopeKeys: [],
    };
  }

  const requested = voiceMode
    ? asBool(process.env.VIVENTIUM_VOICE_BACKGROUND_AGENT_DETECTION_ASYNC)
    : textChatAsyncRequested;
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

function resolvePhaseANoticeToolHoldGuard({
  requestedPhaseANoticeMode,
  voiceMode,
  agent,
  directActionSurfaces,
  agentTools,
  toolDefinitions,
  asyncPolicy,
} = {}) {
  if (!voiceMode || requestedPhaseANoticeMode !== 'first_activation_continue') {
    return {
      guarded: false,
      reason: 'not_applicable',
      toolHoldScopeKeys: [],
      unownedToolHoldScopeKeys: [],
    };
  }

  const toolHoldScopeKeys = getConfiguredToolHoldScopeKeys(agent);
  const unownedToolHoldScopeKeys = getUnownedToolHoldScopeKeys(agent, {
    directActionSurfaces,
    agentTools,
    toolDefinitions,
  });

  if (asyncPolicy?.forcedOff === true || unownedToolHoldScopeKeys.length > 0) {
    return {
      guarded: true,
      reason: asyncPolicy?.reason || 'unowned_tool_hold_candidate_configured',
      toolHoldScopeKeys,
      unownedToolHoldScopeKeys,
    };
  }

  return {
    guarded: false,
    reason: toolHoldScopeKeys.length > 0 ? 'direct_action_owned' : 'no_tool_hold_candidate',
    toolHoldScopeKeys,
    unownedToolHoldScopeKeys,
  };
}

module.exports = {
  resolveVoicePhaseAAsyncPolicy,
  resolveVoicePhaseAAsyncPolicyWithHydratedTools,
  resolvePhaseANoticeToolHoldGuard,
  hasToolHoldCandidateConfigured,
  getConfiguredToolHoldScopeKeys,
  getUnownedToolHoldScopeKeys,
  shouldAllowAsyncWhenToolHoldConfigured,
};
