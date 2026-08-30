/* === VIVENTIUM START ===
 * Feature: Agent Fallback LLM
 * Purpose: Resolve, validate, and trigger a user-configured secondary model route
 * when the primary provider fails before producing assistant text.
 * Added: 2026-04-28
 * === VIVENTIUM END === */

const { ContentTypes } = require('librechat-data-provider');
const RUNTIME_HOLD_TEXT_FLAG = 'viventium_runtime_hold';
const NON_RETRYABLE_FALLBACK_ERROR_CLASSES = new Set([
  'bad_request',
  'content_policy',
  'content_policy_violation',
  'context_length_exceeded',
  'graph_invariant_failure',
  'invalid_request',
  'invalid_request_error',
  'invariant_failure',
  'no_live_tool_execution',
  'schema_validation_error',
  'tool_failure',
  'mcp_failure',
  'mcp_tool_failure',
  'missing_tool_auth',
  'tool_auth_required',
  'provider_response_deadline_exceeded',
]);
const RECOVERABLE_PROVIDER_CONNECTION_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
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

  /* === VIVENTIUM START ===
   * Feature: Server-side automatic-fallback capability enforcement.
   * Purpose: API/source-sync records cannot select a harness as a fallback target when the
   * provider registry excludes that role.
   * === VIVENTIUM END === */
  const agentsConfig = req?.config?.endpoints?.agents || {};
  const capability =
    agentsConfig.providerCapabilities?.[fallbackProvider] ||
    agentsConfig.providerCapabilities?.[provider];
  if (capability?.automatic_fallback_target === false) {
    return false;
  }
  if (
    !capability &&
    (agentsConfig.capabilityRequiredProviders || []).includes(String(fallbackProvider || ''))
  ) {
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

function sanitizeFallbackModelParametersForProvider(parameters, provider, capability = {}) {
  const sanitized = clonePlainObject(parameters);
  const normalizedProvider = normalizeProvider(provider);
  const targetModel = String(sanitized.model || '').trim();
  const targetModelCapability = Array.isArray(capability?.models)
    ? capability.models.find((model) => String(model?.id || '').trim() === targetModel)
    : null;
  const supportsDeclaredReasoningEffort =
    Array.isArray(targetModelCapability?.effortChoices) &&
    targetModelCapability.effortChoices.length > 0;

  if (normalizedProvider !== 'anthropic') {
    delete sanitized.thinking;
    delete sanitized.thinkingBudget;
  }
  if (!['openAI', 'xai'].includes(normalizedProvider) && !supportsDeclaredReasoningEffort) {
    delete sanitized.reasoning_effort;
  }
  /* === VIVENTIUM START ===
   * Feature: Cross-provider fallback parameter hygiene
   * Purpose: Responses API selection is OpenAI-only and must not leak from a GPT primary bag
   * into an Anthropic fallback request.
   * Updated: 2026-07-09
   * === VIVENTIUM END === */
  if (normalizedProvider !== 'openAI') {
    delete sanitized.useResponsesApi;
    delete sanitized.service_tier;
  }
  if (!['openAI', 'xai'].includes(normalizedProvider)) {
    delete sanitized.response_format;
  }

  return sanitized;
}

function buildFallbackAgent(agent, assignment, capability = {}) {
  if (!agent || !assignment) {
    return null;
  }

  const modelParameters = resolveFallbackModelParameters(
    agent,
    assignment.model,
    assignment.parametersField,
  );

  /* === VIVENTIUM START ===
   * Feature: Outer-fallback / provider-internal-fallback separation.
   * Purpose: The Agent Builder fallback reuses the primary Agent's workspace declaration, but it
   * must not inherit GlassHive's optional serial fallback target. Once Claude is the outer fallback
   * model, retaining `fallback_model: claude-code:opus` makes validation reject the route as a
   * same-model provider fallback before Claude can start.
   * Added: 2026-08-17
   * === VIVENTIUM END === */
  const glassHiveOptions = clonePlainObject(agent.glasshive_options);
  delete glassHiveOptions.fallback_model;
  delete glassHiveOptions.fallback_reasoning_effort;

  return {
    ...agent,
    provider: assignment.provider,
    model: assignment.model,
    endpoint: undefined,
    model_parameters: sanitizeFallbackModelParametersForProvider(
      modelParameters,
      assignment.provider,
      capability,
    ),
    ...(Object.keys(glassHiveOptions).length > 0
      ? { glasshive_options: glassHiveOptions }
      : { glasshive_options: undefined }),
  };
}

/* === VIVENTIUM START ===
 * Feature: Lazy fallback graph-topology reconciliation
 * Purpose: Lazy fallback initialization starts from the declared primary agent, before optional
 * handoff failures are known. Reuse the initialized primary's resolved edges so an unavailable
 * optional child cannot make the fallback graph fail compilation before reaching its provider.
 * === VIVENTIUM END === */
function inheritResolvedAgentGraph(fallbackConfig, primaryConfig) {
  if (!fallbackConfig || !primaryConfig) {
    return fallbackConfig;
  }
  fallbackConfig.edges = Array.isArray(primaryConfig.edges)
    ? [...primaryConfig.edges]
    : primaryConfig.edges;
  return fallbackConfig;
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
    'provider_quota_exhausted',
    'provider_quota_or_billing',
    'provider_response_failed',
    'provider_temporarily_unavailable',
    'provider_auth_missing',
    'recoverable_provider_error',
    'provider_unauthorized',
    'provider_access_denied',
    'provider_connected_account_reconnect_required',
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
    lowered.includes('rate-limited') ||
    lowered.includes('rate limited') ||
    lowered.includes('too many requests') ||
    /* === VIVENTIUM START ===
     * Feature: Provider quota/credit exhaustion recoverability.
     * Purpose: Exhausted provider credit is recoverable through the configured fallback route, the
     * same as a rate limit or outage. Keep the text path aligned with `provider_quota_exhausted`
     * so an unstructured prose failure still reaches the fallback.
     * Added: 2026-08-17
     * === VIVENTIUM END === */
    lowered.includes('insufficient_quota') ||
    lowered.includes('billing_hard_limit_reached') ||
    lowered.includes('exceeded your current quota') ||
    lowered.includes('check your plan and billing') ||
    lowered.includes('credit balance is too low') ||
    lowered.includes('insufficient credit') ||
    lowered.includes('out of credit') ||
    lowered.includes('status=429') ||
    lowered.includes('status 429') ||
    lowered.includes('"status":429') ||
    lowered.includes(' 429 ') ||
    lowered.includes('authentication') ||
    lowered.includes('credential') ||
    lowered.includes('unauthorized') ||
    lowered.includes('incorrect api key') ||
    /^\s*(401|403)\b/.test(lowered) ||
    lowered.includes(' 401 ') ||
    lowered.includes(' 403 ') ||
    lowered.includes('overloaded') ||
    lowered.includes('temporarily unavailable') ||
    lowered.includes('connection refused') ||
    lowered.includes('connection reset') ||
    lowered.includes('socket hang up') ||
    lowered.includes('fetch failed') ||
    lowered.includes('econnrefused') ||
    lowered.includes('econnreset') ||
    lowered.includes('etimedout') ||
    lowered.includes(' 503 ') ||
    lowered.includes(' 502 ') ||
    lowered.includes(' 504 ') ||
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

/* === VIVENTIUM START ===
 * Feature: Shared structured runtime-fallback recoverability gate.
 * Purpose: Graph-native fallback must follow the same provider-failure boundary as initialization:
 * retry auth, quota, rate-limit, outage, and transport failures; never mask cancellation, invalid
 * requests, policy/schema rejection, tool failure, or graph invariants. Structured metadata only.
 * Added: 2026-08-10
 */
function getStructuredFallbackErrorChain(error) {
  const chain = [];
  const queue = [error];
  const seen = new Set();
  while (queue.length > 0 && chain.length < 12) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) {
      continue;
    }
    seen.add(current);
    chain.push(current);
    for (const nested of [
      current.cause,
      current.error,
      current.response,
      current.response?.data,
      current.response?.data?.error,
    ]) {
      if (nested && typeof nested === 'object' && !seen.has(nested)) {
        queue.push(nested);
      }
    }
  }
  return chain;
}

function structuredFallbackErrorClasses(error) {
  return getStructuredFallbackErrorChain(error)
    .flatMap((item) => [
      item.errorClass,
      item.error_class,
      item.errorCode,
      item.error_code,
      item.code,
      item.lc_error_code,
      item.type,
    ])
    .map(normalizeFallbackErrorClass)
    .filter(Boolean);
}

/* === VIVENTIUM START ===
 * Feature: Opaque graph-participant provider failure provenance.
 * Purpose: A model adapter can lose status/code metadata while still throwing from the exact model
 * invocation boundary. Mark only that boundary as a recoverable provider response; structured
 * cancellation, policy, tool, schema, and HTTP dispositions remain authoritative.
 * Added: 2026-08-18
 */
function markOpaqueProviderAttemptFailure(error) {
  const chain = getStructuredFallbackErrorChain(error);
  if (chain.length === 0) {
    return error;
  }
  const hasStructuredDisposition =
    structuredFallbackErrorClasses(error).length > 0 ||
    chain.some(
      (item) =>
        item.name === 'AbortError' ||
        item.viventiumCompletionPhase ||
        item.viventiumConnectedAccountReconnectRequired === true ||
        item.viventiumRecoverableProviderError === true ||
        item.viventiumNonRetryableProviderError === true ||
        [item.status, item.statusCode, item.errorStatus, item.error_status].some((candidate) => {
          const status = Number(candidate);
          return Number.isFinite(status) && status > 0;
        }),
    );
  if (hasStructuredDisposition) {
    return error;
  }
  try {
    error.viventiumCompletionPhase = 'provider_response';
    return error;
  } catch {
    const marked = new Error('Model provider response failed');
    marked.viventiumCompletionPhase = 'provider_response';
    marked.cause = error;
    return marked;
  }
}
/* === VIVENTIUM END === */

function isRecoverableProviderFallbackError(error) {
  const chain = getStructuredFallbackErrorChain(error);
  if (chain.length === 0) {
    return false;
  }
  const structuredClasses = structuredFallbackErrorClasses(error);
  if (
    chain.some(
      (item) =>
        item.name === 'AbortError' ||
        item.code === 'ABORT_ERR' ||
        item.viventiumNonRetryableProviderError === true,
    ) ||
    structuredClasses.some(isNonRetryableFallbackErrorClass)
  ) {
    return false;
  }
  if (
    chain.some(
      (item) =>
        item.viventiumCompletionPhase === 'provider_response' ||
        item.viventiumConnectedAccountReconnectRequired === true ||
        item.viventiumRecoverableProviderError === true,
    ) ||
    structuredClasses.some(isRecoverableFallbackErrorClass)
  ) {
    return true;
  }
  for (const item of chain) {
    for (const candidate of [item.status, item.statusCode, item.errorStatus, item.error_status]) {
      const status = Number(candidate);
      if (Number.isFinite(status) && status > 0 && isRecoverableFallbackStatus(status)) {
        return true;
      }
    }
  }
  return structuredClasses.some((value) => {
    const code = value.toUpperCase();
    return (
      code === 'MODEL_AUTHENTICATION' ||
      code === 'MODEL_RATE_LIMIT' ||
      code === 'AUTHENTICATION_ERROR' ||
      RECOVERABLE_PROVIDER_CONNECTION_CODES.has(code)
    );
  });
}
/* === VIVENTIUM END === */

/* === VIVENTIUM START ===
 * Feature: Provider fallback during agent initialization
 * Purpose: Connected-account authentication can fail while the provider client is being built,
 * before AgentClient exists. Recognize only structured provider failures and invoke the same
 * configured fallback once; never hide tool/runtime invariants or user cancellation.
 * Added: 2026-07-13
 */
function isRecoverableProviderInitializationError(error) {
  return isRecoverableProviderFallbackError(error);
}

async function initializePrimaryAgentWithFallback({
  primaryAgent,
  fallbackAgent,
  fallbackAssignment,
  initializePrimary,
  initializeFallback,
  signal,
}) {
  try {
    return {
      config: await initializePrimary(),
      effectiveAgent: primaryAgent,
      fallbackUsed: false,
      primaryError: null,
    };
  } catch (primaryError) {
    const cancelled = signal?.aborted === true;
    const canFallback =
      !cancelled &&
      fallbackAgent != null &&
      fallbackAssignment != null &&
      typeof initializeFallback === 'function' &&
      isRecoverableProviderInitializationError(primaryError);
    if (!canFallback) {
      throw primaryError;
    }

    return {
      config: await initializeFallback(primaryError),
      effectiveAgent: fallbackAgent,
      fallbackUsed: true,
      primaryError,
    };
  }
}
/* === VIVENTIUM END === */

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
  inheritResolvedAgentGraph,
  isSameAgentRoute,
  shouldRetryWithFallback,
  hasVisibleAssistantText,
  shouldRetryBackgroundCortexWithFallback,
  isAbortOrTimeoutErrorText,
  isRecoverableProviderErrorText,
  isNonRetryableFallbackErrorClass,
  markOpaqueProviderAttemptFailure,
  isRecoverableProviderFallbackError,
  isRecoverableProviderInitializationError,
  initializePrimaryAgentWithFallback,
};
