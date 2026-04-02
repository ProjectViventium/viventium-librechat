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

function resolveVoicePhaseAAsyncPolicy({ voiceMode, agent }) {
  if (!voiceMode) {
    return {
      enabled: false,
      requested: false,
      forcedOff: false,
      reason: 'not_voice_mode',
      toolHoldScopeKeys: [],
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
    };
  }

  if (shouldAllowAsyncWhenToolHoldConfigured()) {
    return {
      enabled: true,
      requested: true,
      forcedOff: false,
      reason: 'tool_hold_override',
      toolHoldScopeKeys,
    };
  }

  return {
    enabled: false,
    requested: true,
    forcedOff: true,
    reason: 'tool_hold_candidate_configured',
    toolHoldScopeKeys,
  };
}

module.exports = {
  resolveVoicePhaseAAsyncPolicy,
  hasToolHoldCandidateConfigured,
  getConfiguredToolHoldScopeKeys,
  shouldAllowAsyncWhenToolHoldConfigured,
};
