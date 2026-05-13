/* === VIVENTIUM START ===
 * Feature: Agent Fallback LLM
 * Purpose: Resolve, validate, and trigger a user-configured secondary model route
 * when the primary provider fails before producing assistant text.
 * Added: 2026-04-28
 * === VIVENTIUM END === */

const { ContentTypes } = require('librechat-data-provider');
const RUNTIME_HOLD_TEXT_FLAG = 'viventium_runtime_hold';
const NON_RETRYABLE_FALLBACK_ERROR_CLASSES = new Set([
  'no_live_tool_execution',
  'tool_failure',
  'mcp_failure',
  'mcp_tool_failure',
  'missing_tool_auth',
  'tool_auth_required',
]);

function normalizeProvider(provider) {
  const raw = String(provider || '').trim();
  if (!raw) {
    return '';
  }
  const lowered = raw.toLowerCase();
  if (lowered === 'openai') {
    return 'openAI';
  }
  if (lowered === 'x_ai') {
    return 'xai';
  }
  return raw;
}

function clonePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}

const DEFAULT_FALLBACK_FIELDS = Object.freeze({
  providerField: 'fallback_llm_provider',
  modelField: 'fallback_llm_model',
  parametersField: 'fallback_llm_model_parameters',
  source: 'agent',
});

const VOICE_FALLBACK_FIELDS = Object.freeze({
  providerField: 'voice_fallback_llm_provider',
  modelField: 'voice_fallback_llm_model',
  parametersField: 'voice_fallback_llm_model_parameters',
  source: 'voice',
});

function resolveFallbackAssignment(agent, fieldConfig = DEFAULT_FALLBACK_FIELDS) {
  if (!agent || typeof agent !== 'object') {
    return null;
  }

  const fields = { ...DEFAULT_FALLBACK_FIELDS, ...fieldConfig };
  const provider = normalizeProvider(agent[fields.providerField]);
  const explicitModel = String(agent[fields.modelField] || '').trim();
  const parameterModel = String(agent[fields.parametersField]?.model || '').trim();
  const model = explicitModel || parameterModel;

  if (!provider || !model) {
    return null;
  }

  return {
    provider,
    model,
    source: fields.source,
    parametersField: fields.parametersField,
  };
}

function resolveVoiceFallbackAssignment(agent) {
  return resolveFallbackAssignment(agent, VOICE_FALLBACK_FIELDS);
}

function resolveEffectiveFallbackAssignment(agent, { isVoiceCall = false } = {}) {
  if (isVoiceCall) {
    return resolveVoiceFallbackAssignment(agent) || resolveFallbackAssignment(agent);
  }
  return resolveFallbackAssignment(agent);
}

function resolveFallbackCandidates(agent, { isVoiceCall = false } = {}) {
  const general = resolveFallbackAssignment(agent);
  if (!isVoiceCall) {
    return general ? [general] : [];
  }

  const voice = resolveVoiceFallbackAssignment(agent);
  return [voice, general].filter(Boolean);
}

function isFallbackModelValid(fallbackModel, fallbackProvider, req, modelsConfig) {
  const model = String(fallbackModel || '').trim();
  const provider = normalizeProvider(fallbackProvider);
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

function resolveFallbackModelParameters(
  agent,
  fallbackModel,
  parametersField = DEFAULT_FALLBACK_FIELDS.parametersField,
) {
  const resolved = {
    ...clonePlainObject(agent?.model_parameters),
    ...clonePlainObject(agent?.[parametersField]),
  };

  const model = String(
    fallbackModel || agent?.fallback_llm_model || agent?.voice_fallback_llm_model || '',
  ).trim();
  if (model) {
    resolved.model = model;
  }

  return resolved;
}

function sanitizeFallbackModelParametersForProvider(parameters, provider) {
  const sanitized = clonePlainObject(parameters);
  const normalizedProvider = normalizeProvider(provider);

  if (normalizedProvider !== 'anthropic') {
    delete sanitized.thinking;
    delete sanitized.thinkingBudget;
  }
  if (normalizedProvider !== 'openAI') {
    delete sanitized.reasoning_effort;
  }

  return sanitized;
}

function buildFallbackAgent(agent, assignment) {
  if (!agent || !assignment) {
    return null;
  }

  const modelParameters = resolveFallbackModelParameters(
    agent,
    assignment.model,
    assignment.parametersField,
  );

  return {
    ...agent,
    provider: assignment.provider,
    model: assignment.model,
    endpoint: undefined,
    model_parameters: sanitizeFallbackModelParametersForProvider(
      modelParameters,
      assignment.provider,
    ),
  };
}

function getAgentModel(agent) {
  return String(agent?.model || agent?.model_parameters?.model || '').trim();
}

function isSameAgentRoute(agent, assignment) {
  if (!agent || !assignment) {
    return false;
  }
  return (
    normalizeProvider(agent.provider) === assignment.provider &&
    getAgentModel(agent) === assignment.model
  );
}

function contentPartText(part) {
  if (!part || typeof part !== 'object') {
    return '';
  }
  if (typeof part[ContentTypes.ERROR] === 'string') {
    return part[ContentTypes.ERROR];
  }
  if (typeof part.error === 'string') {
    return part.error;
  }
  if (typeof part.text === 'string') {
    return part.text;
  }
  return '';
}

function normalizeFallbackErrorClass(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function isNonRetryableFallbackErrorClass(value) {
  const normalized = normalizeFallbackErrorClass(value);
  return Boolean(normalized) && NON_RETRYABLE_FALLBACK_ERROR_CLASSES.has(normalized);
}

function isRecoverableFallbackErrorClass(value) {
  const normalized = normalizeFallbackErrorClass(value);
  return [
    'provider_rate_limited',
    'recoverable_provider_error',
    'provider_unauthorized',
    'provider_access_denied',
    'late_stream_termination',
  ].includes(normalized);
}

function contentPartErrorClass(part) {
  if (!part || typeof part !== 'object') {
    return '';
  }
  return part.errorClass || part.error_class || part.error_code || part.code || '';
}

function hasVisibleAssistantText(contentParts) {
  if (!Array.isArray(contentParts)) {
    return false;
  }
  return contentParts.some((part) => {
    if (typeof part === 'string') {
      return part.trim().length > 0;
    }
    if (!part || typeof part !== 'object') {
      return false;
    }
    if (part.type === ContentTypes.ERROR) {
      return false;
    }
    if (part[RUNTIME_HOLD_TEXT_FLAG] === true) {
      return false;
    }
    if (part.type === ContentTypes.TEXT && typeof part.text === 'string') {
      return part.text.trim().length > 0;
    }
    if (part.type === ContentTypes.TEXT && typeof part.text?.value === 'string') {
      return part.text.value.trim().length > 0;
    }
    return false;
  });
}

function isRecoverableProviderErrorText(text, { allowToolOrMcpText = false } = {}) {
  const lowered = String(text || '').toLowerCase();
  if (!lowered) {
    return false;
  }
  if (!allowToolOrMcpText && (lowered.includes('mcp') || lowered.includes('tool'))) {
    return false;
  }
  return (
    lowered.includes('rate_limit') ||
    lowered.includes('rate limit') ||
    lowered.includes('too many requests') ||
    lowered.includes('status=429') ||
    lowered.includes('status 429') ||
    lowered.includes('"status":429') ||
    lowered.includes(' 429 ') ||
    lowered.includes('authentication') ||
    lowered.includes('credential') ||
    lowered.includes('unauthorized') ||
    lowered.includes(' 401 ') ||
    lowered.includes(' 403 ') ||
    lowered.includes('overloaded') ||
    lowered.includes('temporarily unavailable') ||
    lowered.includes(' 503 ') ||
    lowered.includes(' 529 ')
  );
}

function extractFallbackErrorStatus(value) {
  const candidates = [value?.status, value?.statusCode, value?.errorStatus, value?.error_status];
  for (const candidate of candidates) {
    const status = Number(candidate);
    if (Number.isFinite(status) && status > 0) {
      return status;
    }
  }

  const text = String(value?.error || value?.message || value || '');
  const statusMatch =
    text.match(/^\s*(\d{3})\b/) ||
    text.match(/\bstatus(?: code)?[ =:]+(\d{3})\b/i) ||
    text.match(/"status"\s*:\s*(\d{3})/i);
  return statusMatch?.[1] ? Number(statusMatch[1]) : 0;
}

function extractFallbackErrorCode(value) {
  const candidates = [
    value?.code,
    value?.errorCode,
    value?.error_code,
    value?.lc_error_code,
    value?.error?.code,
    value?.error?.type,
  ];
  for (const candidate of candidates) {
    const code = String(candidate || '').trim();
    if (code) {
      return code.toUpperCase();
    }
  }

  const text = String(value?.error || value?.message || value || '');
  const codeMatch = text.match(/\b(MODEL_[A-Z_]+|E[A-Z_]+|authentication_error)\b/i);
  return codeMatch?.[1] ? codeMatch[1].toUpperCase() : '';
}

function isRecoverableFallbackStatus(status) {
  return status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
}

function shouldRetryWithFallback(contentParts) {
  if (
    !Array.isArray(contentParts) ||
    contentParts.length === 0 ||
    hasVisibleAssistantText(contentParts)
  ) {
    return false;
  }

  return contentParts.some((part) => {
    if (!part || typeof part !== 'object' || part.type !== ContentTypes.ERROR) {
      return false;
    }
    const errorClass = contentPartErrorClass(part);
    if (isNonRetryableFallbackErrorClass(errorClass)) {
      return false;
    }
    if (isRecoverableFallbackErrorClass(errorClass)) {
      return true;
    }
    return isRecoverableProviderErrorText(contentPartText(part));
  });
}

/* === VIVENTIUM START ===
 * Feature: Background Cortex LLM Fallback
 * Purpose: Background Phase B returns structured result objects instead of AgentClient
 * content parts, so timeout/abort provider failures need a separate retry predicate.
 * === VIVENTIUM END === */
function isAbortOrTimeoutErrorText(text) {
  const lowered = String(text || '').toLowerCase();
  if (!lowered) {
    return false;
  }
  return (
    lowered === 'timeout' ||
    lowered.includes('timeout') ||
    lowered.includes('timed out') ||
    lowered.includes('aborterror') ||
    lowered.includes('aborted') ||
    lowered.includes('request aborted') ||
    lowered.includes('operation was aborted')
  );
}

function shouldRetryBackgroundCortexWithFallback(result) {
  if (!result || typeof result !== 'object') {
    return false;
  }
  if (typeof result.insight === 'string' && result.insight.trim().length > 0) {
    return false;
  }

  const errorText = String(result.error || result.message || '').trim();
  if (
    isNonRetryableFallbackErrorClass(result.errorClass) ||
    isNonRetryableFallbackErrorClass(result.error_class) ||
    isNonRetryableFallbackErrorClass(result.errorCode) ||
    isNonRetryableFallbackErrorClass(result.error_code) ||
    normalizeFallbackErrorClass(errorText) === 'no_live_tool_execution'
  ) {
    return false;
  }

  const structuredClass =
    result.errorClass || result.error_class || result.errorCode || result.error_code || result.code;
  if (isRecoverableFallbackErrorClass(structuredClass)) {
    return true;
  }

  const structuredStatus = extractFallbackErrorStatus(result);
  if (isRecoverableFallbackStatus(structuredStatus)) {
    return true;
  }

  const structuredCode = extractFallbackErrorCode(result);
  if (structuredCode === 'MODEL_AUTHENTICATION' || structuredCode === 'MODEL_RATE_LIMIT') {
    return true;
  }

  if (!errorText) {
    return result.recoverableProviderError === true;
  }

  return (
    result.recoverableProviderError === true ||
    isAbortOrTimeoutErrorText(errorText) ||
    isRecoverableProviderErrorText(errorText, { allowToolOrMcpText: true })
  );
}
/* === VIVENTIUM END === */

module.exports = {
  normalizeProvider,
  resolveFallbackAssignment,
  resolveVoiceFallbackAssignment,
  resolveEffectiveFallbackAssignment,
  resolveFallbackCandidates,
  isFallbackModelValid,
  resolveFallbackModelParameters,
  sanitizeFallbackModelParametersForProvider,
  buildFallbackAgent,
  isSameAgentRoute,
  shouldRetryWithFallback,
  hasVisibleAssistantText,
  shouldRetryBackgroundCortexWithFallback,
  isAbortOrTimeoutErrorText,
  isRecoverableProviderErrorText,
  isNonRetryableFallbackErrorClass,
};
