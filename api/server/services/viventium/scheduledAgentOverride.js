/* === VIVENTIUM START ===
 * Feature: Scheduled-agent execution policy
 * Purpose: Apply an authenticated scheduler's per-run provider/model/effort tuple
 * without changing the conscious agent's normal interactive-chat configuration.
 * === VIVENTIUM END === */

const { normalizeProviderAlias } = require('librechat-data-provider');

const ALLOWED_REASONING_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
const FALLBACK_FIELDS = [
  'fallback_llm_provider',
  'fallback_llm_model',
  'fallback_llm_model_parameters',
  'voice_fallback_llm_provider',
  'voice_fallback_llm_model',
  'voice_fallback_llm_model_parameters',
];

function providerIdentity(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  return String(normalizeProviderAlias(raw) || raw)
    .trim()
    .toLowerCase();
}

function resolveProviderCapability(provider, agentsConfig) {
  const registry = agentsConfig?.providerCapabilities || {};
  const identity = providerIdentity(provider);
  const entry = Object.entries(registry).find(
    ([candidate]) => providerIdentity(candidate) === identity,
  );
  return entry?.[1] || null;
}

function requiresProviderCapability(provider, agentsConfig) {
  const identity = providerIdentity(provider);
  return (agentsConfig?.capabilityRequiredProviders || []).some(
    (candidate) => providerIdentity(candidate) === identity,
  );
}

function normalizeScheduledAgentExecution(value, agentsConfig = {}) {
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

  /* === VIVENTIUM START ===
   * Feature: Capability-owned scheduled execution.
   * Purpose: A universal AI endpoint selected for an automation must resolve to the exact
   * provider/model/effort declared by the compiled registry. Missing or incompatible capability
   * metadata fails visibly instead of drifting to another provider.
   * === VIVENTIUM END === */
  const capability = resolveProviderCapability(provider, agentsConfig);
  if (!capability && requiresProviderCapability(provider, agentsConfig)) {
    throw new Error(`Provider capability configuration is unavailable for "${provider}"`);
  }
  if (capability) {
    if (capability.main_chat !== true) {
      throw new Error(`Provider "${provider}" cannot execute a scheduled agent turn`);
    }
    const modelMetadata = (capability.models || []).find((item) => item?.id === model);
    if (!modelMetadata) {
      throw new Error(`Unsupported scheduled-agent model for ${provider}: ${model}`);
    }
    const effortChoices = Array.isArray(modelMetadata.effortChoices)
      ? modelMetadata.effortChoices.map((choice) =>
          String(choice || '')
            .trim()
            .toLowerCase(),
        )
      : [];
    if (!effortChoices.includes(reasoningEffort)) {
      throw new Error(
        `Unsupported scheduled-agent reasoning effort for ${model}: ${reasoningEffort}`,
      );
    }
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
