/* === VIVENTIUM START ===
 * Feature: Voice Chat LLM Override
 * Purpose: Swap agent model/provider to a faster voice-specific one when all
 *   three voice activation conditions are met AND the agent has voice fields set.
 * Why a separate file: Separation of concerns — keeps initialize.js and addedConvo.js
 *   clean, makes the override testable in isolation.
 * Added: 2026-02-24
 * === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const { resolveViventiumSurface } = require('./surfacePrompts');
const {
  readVoiceAssignment,
} = require('../../../../scripts/viventium-agent-runtime-models');

const PROVIDER_ENV_KEYS = Object.freeze({
  anthropic: ['ANTHROPIC_API_KEY'],
  groq: ['GROQ_API_KEY'],
  openAI: ['OPENAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  perplexity: ['PERPLEXITY_API_KEY'],
  xai: ['XAI_API_KEY'],
});

function normalizeProvider(provider) {
  const raw = String(provider || '').trim().toLowerCase();
  if (!raw) {
    return '';
  }
  if (raw === 'openai') {
    return 'openAI';
  }
  if (raw === 'x_ai') {
    return 'xai';
  }
  return raw;
}

function hasConfiguredServerCredential(provider) {
  const envKeys = PROVIDER_ENV_KEYS[provider];
  if (!Array.isArray(envKeys) || envKeys.length === 0) {
    return true;
  }
  return envKeys.some((envKey) => {
    const rawValue = String(process.env[envKey] || '').trim();
    return rawValue !== '' && rawValue.toLowerCase() !== 'user_provided';
  });
}

/* === VIVENTIUM START ===
 * Feature: Voice Call LLM ownership alignment.
 * Purpose: Only the explicit agent voice fields may select a dedicated call LLM. When those fields
 * are unset, live calls must inherit the agent primary model/provider.
 * Why here: Call-time override resolution is the product boundary that must stay aligned with the
 * Agent Builder UI instead of hidden machine-level config.
 * === VIVENTIUM END === */
function resolveVoiceOverrideAssignment(agent) {
  if (!agent || typeof agent !== 'object') {
    return null;
  }

  const explicitProvider = normalizeProvider(agent.voice_llm_provider);
  const explicitModel = String(agent.voice_llm_model || '').trim();
  const assignment = readVoiceAssignment(
    {
      explicitProvider,
      explicitModel,
      mainProvider: agent.provider,
      mainModel: agent.model || agent.model_parameters?.model || '',
    },
  );

  if (!assignment) {
    return null;
  }

  const source = 'agent';
  const mainProvider = normalizeProvider(agent.provider);
  if (assignment.provider !== mainProvider && !hasConfiguredServerCredential(assignment.provider)) {
    logger.warn(
      `[voiceLlmOverride] Skipping ${source}-configured voice override ${assignment.provider}/${assignment.model} for agent ${agent.id} because no server credential is configured for ${assignment.provider}; using main model`,
    );
    return null;
  }

  return { ...assignment, source };
}

/**
 * Checks all three voice activation conditions.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isVoiceCallActive(req) {
  const voiceMode = req?.body?.voiceMode === true;
  const inputMode = (req?.body?.viventiumInputMode || '').toString().toLowerCase();
  const surface = resolveViventiumSurface(req);
  return voiceMode && inputMode === 'voice_call' && surface === 'voice';
}

/**
 * Validates voice model/provider against modelsConfig.
 * @param {string} voiceLlmModel
 * @param {string} voiceProvider
 * @param {import('express').Request} req
 * @param {Object} [modelsConfig] - Optional modelsConfig from getModelsConfig()
 * @returns {boolean}
 */
function isVoiceModelValid(voiceLlmModel, voiceProvider, req, modelsConfig) {
  const model = typeof voiceLlmModel === 'string' ? voiceLlmModel.trim() : '';
  const provider = normalizeProvider(voiceProvider);
  if (!model || !provider) {
    return false;
  }

  const allowedProviders = req?.config?.endpoints?.agents?.allowedProviders;
  if (
    Array.isArray(allowedProviders) &&
    allowedProviders.length > 0 &&
    !allowedProviders.map(normalizeProvider).includes(provider)
  ) {
    return false;
  }

  const providerModels = modelsConfig?.[provider];
  if (!Array.isArray(providerModels) || providerModels.length === 0) {
    return false;
  }

  return providerModels.includes(model);
}

function cloneModelParameters(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}

/* === VIVENTIUM START ===
 * Feature: provider-aware voice parameter normalization.
 * Purpose: A voice model override may intentionally change providers. When it does, provider-
 * specific thinking fields from the main model must not leak into the voice call request. xAI
 * Grok 4.3 uses `reasoning_effort: "none"` for no-reasoning Chat Completions, not Anthropic
 * `thinking: false`.
 * === VIVENTIUM END === */
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function normalizeVoiceModelParametersForProvider(parameters, voiceParams, provider) {
  const resolved = cloneModelParameters(parameters);
  if (normalizeProvider(provider) !== 'xai') {
    return resolved;
  }

  const voiceThinkingDisabled = voiceParams?.thinking === false;
  const voiceReasoningEffortConfigured =
    hasOwn(voiceParams, 'reasoning_effort') && String(voiceParams.reasoning_effort || '').trim();

  delete resolved.thinking;
  delete resolved.thinkingBudget;
  delete resolved.thinkingLevel;
  delete resolved.effort;

  if (
    resolved.useResponsesApi !== true &&
    !resolved.reasoning_effort &&
    resolved.reasoning &&
    typeof resolved.reasoning === 'object' &&
    typeof resolved.reasoning.effort === 'string'
  ) {
    resolved.reasoning_effort = resolved.reasoning.effort;
  }
  if (resolved.useResponsesApi !== true) {
    delete resolved.reasoning;
  }

  if (voiceThinkingDisabled && !voiceReasoningEffortConfigured) {
    resolved.reasoning_effort = 'none';
  }

  return resolved;
}

function resolveVoiceModelParameters(agent, voiceLlmModel, voiceProvider) {
  const voiceParams = cloneModelParameters(agent?.voice_llm_model_parameters);
  const resolved = {
    ...cloneModelParameters(agent?.model_parameters),
    ...voiceParams,
  };

  const model = String(voiceLlmModel || agent?.voice_llm_model || '').trim();
  if (model) {
    resolved.model = model;
  }

  return normalizeVoiceModelParametersForProvider(resolved, voiceParams, voiceProvider);
}

/**
 * Apply voice model override to agent object (mutates in place).
 * Must be called BEFORE validateAgentModel() so the swapped model is validated.
 *
 * @param {Object} agent - The agent object from MongoDB
 * @param {import('express').Request} req
 * @param {Object} [modelsConfig] - Optional modelsConfig for validation
 * @returns {Object} The same agent object (for chaining)
 */
function applyVoiceModelOverride(agent, req, modelsConfig) {
  if (!agent || !isVoiceCallActive(req)) {
    return agent;
  }

  const assignment = resolveVoiceOverrideAssignment(agent);
  const voiceLlmModel = assignment?.model || '';
  const voiceProvider = assignment?.provider || '';

  if (!voiceLlmModel || !voiceProvider) {
    // No voice override configured — use main model
    return agent;
  }

  if (!isVoiceModelValid(voiceLlmModel, voiceProvider, req, modelsConfig)) {
    logger.warn(
      `[voiceLlmOverride] Invalid ${assignment?.source || 'configured'} voice model ${voiceProvider}/${voiceLlmModel} for agent ${agent.id} — falling back to main model`,
    );
    return agent;
  }

  logger.info(
    `[voiceLlmOverride] Swapping model for voice call: ${agent.provider}/${agent.model} -> ${voiceProvider}/${voiceLlmModel}`,
  );

  agent.model = voiceLlmModel;
  agent.provider = voiceProvider;
  agent.model_parameters = resolveVoiceModelParameters(agent, voiceLlmModel, voiceProvider);
  /* === VIVENTIUM START ===
   * Feature: Voice LLM no-reasoning diagnostics.
   * Purpose: Log only non-secret provider/model reasoning knobs so live voice QA can prove the
   * DB-level voice profile was applied before the provider request is built.
   * Added: 2026-05-14
   */
  logger.info(
    `[voiceLlmOverride] Voice model parameters normalized: provider=${voiceProvider} model=${voiceLlmModel} ` +
      `reasoning_effort=${agent.model_parameters?.reasoning_effort ?? 'unset'} ` +
      `reasoning.effort=${agent.model_parameters?.reasoning?.effort ?? 'unset'} ` +
      `include_reasoning=${agent.model_parameters?.include_reasoning ?? 'unset'} ` +
      `thinking=${agent.model_parameters?.thinking ?? 'unset'}`,
  );
  /* === VIVENTIUM END === */

  return agent;
}

module.exports = {
  isVoiceCallActive,
  isVoiceModelValid,
  resolveVoiceOverrideAssignment,
  resolveVoiceModelParameters,
  normalizeVoiceModelParametersForProvider,
  applyVoiceModelOverride,
};
