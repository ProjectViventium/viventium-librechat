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
  if (agent.model_parameters && typeof agent.model_parameters === 'object') {
    agent.model_parameters.model = voiceLlmModel;
  }

  return agent;
}

module.exports = {
  isVoiceCallActive,
  isVoiceModelValid,
  resolveVoiceOverrideAssignment,
  applyVoiceModelOverride,
};
