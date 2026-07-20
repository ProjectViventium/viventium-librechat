/* === VIVENTIUM START ===
 * Feature: Scheduled-agent execution policy
 * Purpose: Apply an authenticated scheduler's per-run provider/model/effort tuple
 * without changing the conscious agent's normal interactive-chat configuration.
 * === VIVENTIUM END === */

const { normalizeProviderAlias } = require('librechat-data-provider');

const ALLOWED_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const FALLBACK_FIELDS = [
  'fallback_llm_provider',
  'fallback_llm_model',
  'fallback_llm_model_parameters',
  'voice_fallback_llm_provider',
  'voice_fallback_llm_model',
  'voice_fallback_llm_model_parameters',
];

function normalizeScheduledAgentExecution(value) {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('scheduledAgentExecution must be an object');
  }

  const provider = typeof value.provider === 'string' ? value.provider.trim().toLowerCase() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  const reasoningEffort =
    typeof value.reasoning_effort === 'string' ? value.reasoning_effort.trim().toLowerCase() : '';
  if (!provider || !model || !reasoningEffort) {
    throw new Error('scheduledAgentExecution requires provider, model, and reasoning_effort');
  }
  if (!ALLOWED_REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error(`Unsupported scheduled-agent reasoning effort: ${reasoningEffort}`);
  }
  return { provider, model, reasoning_effort: reasoningEffort };
}

function applyScheduledAgentOverride(agent, req) {
  const execution = req?.viventiumScheduledAgentExecution;
  if (!agent || !execution) {
    return agent;
  }

  agent.provider = normalizeProviderAlias(execution.provider);
  agent.model = execution.model;
  agent.model_parameters = {
    ...(agent.model_parameters ?? {}),
    model: execution.model,
    reasoning_effort: execution.reasoning_effort,
  };
  // Authenticated scheduler tuples are exact execution policy: fail truthfully instead of drifting.
  for (const field of FALLBACK_FIELDS) {
    delete agent[field];
  }
  return agent;
}

module.exports = {
  applyScheduledAgentOverride,
  normalizeScheduledAgentExecution,
};
