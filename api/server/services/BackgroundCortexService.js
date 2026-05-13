/* === VIVENTIUM START ===
 * Feature: Background Cortices (Multi-Agent Brain Architecture)
 * Service: BackgroundCortexService
 * Purpose: Handle LLM-based activation detection and parallel execution of background cortices
 * Added: 2026-01-03
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
/* === VIVENTIUM NOTE ===
 * Feature: Enable token counting for background cortex context pruning.
 * === VIVENTIUM NOTE === */
const {
  Run,
  Providers,
  createContentAggregator,
  getTokenCountForMessage,
} = require('@librechat/agents');
const {
  initializeAgent,
  initializeAnthropic,
  initializeOpenAI,
  createRun,
  Tokenizer,
  memoryInstructions,
  extractFileContext,
  countTokens,
  checkAccess,
} = require('@librechat/api');
const { loadAgent } = require('~/models/Agent');
const { getAppConfig } = require('./Config/app');
const {
  Constants,
  EModelEndpoint,
  Tools,
  ContentTypes,
  PermissionTypes,
  Permissions,
  supportsAdaptiveThinking,
} = require('librechat-data-provider');
const { loadAgentTools, loadToolsForExecution } = require('~/server/services/ToolService');
const {
  createToolEndCallback,
  getDefaultHandlers,
} = require('~/server/controllers/agents/callbacks');
const { getConvoFiles } = require('~/models/Conversation');
const { getMCPManager } = require('~/config');
const db = require('~/models');
const { getRoleByName } = require('~/models/Role');
/* === VIVENTIUM NOTE ===
 * Feature: Surface-aware output rules for background cortices.
 */
const {
  buildCortexOutputInstructions,
  resolveViventiumSurface,
  buildTimeContextInstructions,
} = require('~/server/services/viventium/surfacePrompts');
/* === VIVENTIUM NOTE ===
 * Feature: Source-owned activation policy promptRefs.
 */
const { getPromptText } = require('~/server/services/viventium/promptRegistry');
/* === VIVENTIUM NOTE ===
 * Feature: Strict provider text-part sanitization for background cortex runs.
 */
const {
  sanitizeProviderFormattedMessages,
} = require('~/server/services/viventium/normalizeTextContentParts');
const {
  sanitizeAggregatedContentParts,
} = require('~/server/services/viventium/sanitizeAggregatedContentParts');
/* === VIVENTIUM NOTE === */
const {
  buildProductivitySpecialistRuntimeInstructions,
  getLatestUserText,
  resolveProductivitySpecialistScope,
  shouldIsolateProductivitySpecialistContext,
} = require('~/server/services/viventium/productivitySpecialistContext');
const {
  resolveFallbackAssignment,
  isFallbackModelValid,
  buildFallbackAgent,
  isSameAgentRoute,
  shouldRetryBackgroundCortexWithFallback,
  isNonRetryableFallbackErrorClass,
} = require('~/server/services/viventium/agentLlmFallback');
const {
  isOpenAIReasoningModelWithoutSampling,
  sanitizeOpenAIReasoningSamplingParams,
} = require('~/server/services/viventium/openAIReasoningParams');
/* === VIVENTIUM START ===
 * Feature: Prompt-frame telemetry (metadata-only prompt architecture observability).
 * === VIVENTIUM END === */
const {
  buildPromptFrame,
  hashString,
  logPromptFrame,
} = require('~/server/services/viventium/promptFrameTelemetry');

const NO_PARENT_MESSAGE_ID = '00000000-0000-0000-0000-000000000000';

/* === VIVENTIUM NOTE ===
 * Feature: No Response Tag ({NTA}) prompt injection + suppression for background cortices.
 *
 * Purpose:
 * - When enabled, allow cortices to intentionally return `{NTA}` when they have nothing meaningful to add.
 * - Treat `{NTA}` (and strict no-response-only variants) as "no insight" to avoid polluting merges/UI cards.
 *
 * Added: 2026-02-07
 */
const { buildNoResponseInstructions } = require('~/server/services/viventium/noResponsePrompt');
const { isNoResponseOnly } = require('~/server/services/viventium/noResponseTag');
/* === VIVENTIUM NOTE === */

// In-memory cooldown tracker to avoid rapid re-activation spam per user+agent.
const activationCooldowns = new Map();
const activationProviderHealth = new Map();
const DEFAULT_ACTIVATION_PROVIDER_HEALTH_TTL_MS = 60 * 1000;
const MAX_ACTIVATION_PROVIDER_HEALTH_TTL_MS = 5 * 60 * 1000;
const ACTIVATION_PROVIDER_USER_SCOPED_ERROR_CLASSES = new Set([
  'provider_unauthorized',
  'provider_access_denied',
  'provider_rate_limited',
  'provider_quota_or_billing',
]);
const ACTIVATION_SUPPRESSION_PROBEABLE_ERROR_CLASSES = new Set(['provider_unauthorized']);
const PUBLIC_CORTEX_ERROR_MESSAGES = {
  activation_provider_unavailable:
    'This background agent could not start because every configured activation provider was unavailable.',
  no_live_tool_execution: 'This background agent could not verify live tool evidence for this run.',
  timeout: 'This background agent timed out before returning a result.',
  cortex_agent_not_found: 'This background agent is not available in the current configuration.',
  provider_unauthorized:
    'This background agent could not use the configured provider because provider credentials were rejected.',
  provider_access_denied:
    'This background agent could not use the configured provider because access was denied.',
  provider_rate_limited:
    'This background agent could not use the configured provider because it was rate limited.',
  provider_quota_or_billing:
    'This background agent could not use the configured provider because of a quota or billing issue.',
  recoverable_provider_error:
    'This background agent hit a recoverable provider issue before returning a result.',
  background_agent_error:
    'This background agent hit a runtime issue before it could return a result.',
};

function clearActivationCooldowns() {
  activationCooldowns.clear();
}

function clearActivationProviderHealth() {
  activationProviderHealth.clear();
}

function getActivationProviderHealthTtlMs() {
  const raw = process.env.VIVENTIUM_ACTIVATION_PROVIDER_HEALTH_TTL_MS;
  if (raw == null || raw === '') {
    return DEFAULT_ACTIVATION_PROVIDER_HEALTH_TTL_MS;
  }
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_ACTIVATION_PROVIDER_HEALTH_TTL_MS;
  }
  return Math.min(value, MAX_ACTIVATION_PROVIDER_HEALTH_TTL_MS);
}

function normalizeActivationProviderHealthScope(value) {
  const scope = String(value || '').trim();
  return scope || 'global';
}

function buildActivationProviderHealthScope({ req, errorSummary } = {}) {
  const errorClass = String(errorSummary?.class || '');
  const userId = String(req?.user?.id || req?.user?._id || '').trim();
  if (userId && ACTIVATION_PROVIDER_USER_SCOPED_ERROR_CLASSES.has(errorClass)) {
    return `user:${userId}`;
  }
  return 'global';
}

function buildActivationProviderHealthKey({ provider, model, scope } = {}) {
  const normalizedProvider = String(provider || '')
    .trim()
    .toLowerCase();
  const normalizedModel = String(model || '').trim();
  const normalizedScope = normalizeActivationProviderHealthScope(scope);
  return `${normalizedScope}::${normalizedProvider}::${normalizedModel}`;
}

function shouldSuppressActivationProvider(errorSummary = {}) {
  return new Set([
    'provider_unauthorized',
    'provider_access_denied',
    'provider_rate_limited',
    'provider_quota_or_billing',
    'provider_network',
    'provider_server_error',
  ]).has(errorSummary.class);
}

function markActivationProviderUnhealthy({ provider, model, errorSummary, req, scope } = {}) {
  const ttlMs = getActivationProviderHealthTtlMs();
  if (ttlMs <= 0 || !shouldSuppressActivationProvider(errorSummary)) {
    return false;
  }

  const scopeKey = normalizeActivationProviderHealthScope(
    scope || buildActivationProviderHealthScope({ req, errorSummary }),
  );
  const key = buildActivationProviderHealthKey({ provider, model, scope: scopeKey });
  if (!key || key.endsWith('::::')) {
    return false;
  }

  activationProviderHealth.set(key, {
    until: Date.now() + ttlMs,
    scope: scopeKey,
    provider: String(provider || '')
      .trim()
      .toLowerCase(),
    model: String(model || '').trim(),
    error: sanitizeActivationErrorForLog(errorSummary),
  });
  return true;
}

function getActivationProviderSuppression({ provider, model, req } = {}) {
  const userId = String(req?.user?.id || req?.user?._id || '').trim();
  const scopes = userId ? [`user:${userId}`, 'global'] : ['global'];

  for (const scope of scopes) {
    const key = buildActivationProviderHealthKey({ provider, model, scope });
    const entry = activationProviderHealth.get(key);
    if (!entry) {
      continue;
    }

    if (!Number.isFinite(entry.until) || entry.until <= Date.now()) {
      activationProviderHealth.delete(key);
      continue;
    }

    return entry;
  }

  return null;
}

function shouldProbeSuppressedActivationAttempt({
  providerSuppression,
  attempts,
  allAttemptsSuppressed,
  probeAlreadyUsed,
} = {}) {
  if (
    probeAlreadyUsed ||
    !providerSuppression ||
    !Array.isArray(attempts) ||
    attempts.length === 0
  ) {
    return false;
  }
  if (allAttemptsSuppressed !== true) {
    return false;
  }

  const errorClass = String(providerSuppression?.error?.class || '');
  if (!ACTIVATION_SUPPRESSION_PROBEABLE_ERROR_CLASSES.has(errorClass)) {
    return false;
  }

  return true;
}

function shouldAttemptSuppressedActivationProvider({ attempt, providerSuppression } = {}) {
  if (!providerSuppression) {
    return true;
  }
  return (
    String(attempt?.source || '')
      .trim()
      .toLowerCase() === 'primary'
  );
}

function normalizeCooldownKeyPart(value) {
  const text = String(value || '').trim();
  if (!text || text === 'new' || text === NO_PARENT_MESSAGE_ID) {
    return '';
  }
  return text;
}

function buildActivationCooldownKey({ agentId, req, runId } = {}) {
  const userId = normalizeCooldownKeyPart(req?.user?.id || req?.user?._id);
  const conversationId = normalizeCooldownKeyPart(req?.body?.conversationId);
  const messageId = normalizeCooldownKeyPart(
    req?.body?.messageId ||
      req?.body?.viventiumUserMessageId ||
      req?.body?.userMessageId ||
      req?.body?.parentMessageId,
  );
  const runScope = normalizeCooldownKeyPart(runId);
  const requestScope = [userId || conversationId || runScope || 'global'];
  if (conversationId) {
    requestScope.push(conversationId);
  }
  if (messageId) {
    requestScope.push(messageId);
  }
  if (!conversationId && !messageId && runScope) {
    requestScope.push(runScope);
  }
  return `${String(agentId || 'unknown_agent')}:${requestScope.join(':')}`;
}

/* === VIVENTIUM NOTE ===
 * Feature: Deterministic timeouts for Phase B cortex execution.
 *
 * Why:
 * - A single hung cortex should never stall the "brewing" UI forever.
 * - Tool/MCP failures must resolve to completion/error states so follow-up logic can decide what to surface.
 */
function getCortexExecutionTimeoutMs() {
  const raw = String(process.env.VIVENTIUM_CORTEX_EXECUTION_TIMEOUT_MS || '').trim();
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180_000;
}

function getCortexExecutionGuardGraceMs() {
  const raw = String(process.env.VIVENTIUM_CORTEX_EXECUTION_GUARD_GRACE_MS || '').trim();
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 15_000;
  }
  return Math.min(parsed, 60_000);
}

function getCortexAttemptGuardTimeoutMs(executionTimeoutMs = getCortexExecutionTimeoutMs()) {
  if (!Number.isFinite(executionTimeoutMs) || executionTimeoutMs <= 0) {
    return 0;
  }
  return executionTimeoutMs + getCortexExecutionGuardGraceMs();
}

function loadModelsConfigForCortexFallback(req) {
  const { getModelsConfig } = require('~/server/controllers/ModelController');
  return getModelsConfig(req);
}

function extractAggregatedProviderErrorText(contentParts) {
  if (!Array.isArray(contentParts)) {
    return '';
  }
  for (const part of contentParts) {
    if (!part || typeof part !== 'object') {
      continue;
    }
    const text = part[ContentTypes.ERROR] || part.error || part.text || '';
    if (typeof text === 'string' && text.trim()) {
      return text.trim();
    }
  }
  return '';
}

function contentPartFallbackErrorClass(part) {
  if (!part || typeof part !== 'object') {
    return '';
  }
  return (
    part.errorClass || part.error_class || part.errorCode || part.error_code || part.code || ''
  );
}

function shouldRetryBackgroundCortexContentPartsWithFallback(contentParts) {
  if (!Array.isArray(contentParts) || contentParts.length === 0) {
    return false;
  }
  const hasNonRetryableErrorClass = contentParts.some((part) =>
    isNonRetryableFallbackErrorClass(contentPartFallbackErrorClass(part)),
  );
  if (hasNonRetryableErrorClass) {
    return false;
  }
  const providerErrorText = extractAggregatedProviderErrorText(contentParts);
  if (!providerErrorText) {
    return false;
  }
  return shouldRetryBackgroundCortexWithFallback({
    insight: null,
    error: providerErrorText,
  });
}

async function resolveBackgroundCortexFallbackAgent({ cortexAgent, req, modelsConfig }) {
  const fallbackAssignment = resolveFallbackAssignment(cortexAgent);
  if (!fallbackAssignment) {
    return null;
  }

  if (isSameAgentRoute(cortexAgent, fallbackAssignment)) {
    logger.warn(
      `[BackgroundCortexService] Skipping fallback for ${cortexAgent.id} because it matches primary route ` +
        `${fallbackAssignment.provider}/${fallbackAssignment.model}`,
    );
    return null;
  }

  let resolvedModelsConfig = modelsConfig || null;
  if (!resolvedModelsConfig && req) {
    try {
      resolvedModelsConfig = await loadModelsConfigForCortexFallback(req);
    } catch (error) {
      logger.warn(
        '[BackgroundCortexService] Failed to load models config for cortex fallback',
        sanitizeRuntimeErrorForLog(error),
      );
      resolvedModelsConfig = null;
    }
  }
  if (
    !isFallbackModelValid(
      fallbackAssignment.model,
      fallbackAssignment.provider,
      req,
      resolvedModelsConfig,
    )
  ) {
    logger.warn(
      `[BackgroundCortexService] Invalid fallback model for ${cortexAgent.id}: ` +
        `${fallbackAssignment.provider}/${fallbackAssignment.model}`,
    );
    return null;
  }

  return buildFallbackAgent(cortexAgent, fallbackAssignment);
}
/* === VIVENTIUM NOTE === */

/* === VIVENTIUM NOTE ===
 * Feature: Memory context parity for background cortices
 * Purpose: Ensure cortices see the same user memory context as the main agent,
 *          preventing "no memory carried over" disclaimers and enabling cross-thread continuity.
 * Added: 2026-02-07
 */
async function getUserMemoryContextBlock(req) {
  if (!req?.user?.id) {
    return '';
  }

  // Respect user-level personalization toggle when present.
  if (req.user?.personalization?.memories === false) {
    return '';
  }

  const appConfig = req?.config;
  const memoryConfig = appConfig?.memory;
  if (!memoryConfig || memoryConfig.disabled === true) {
    return '';
  }

  // Respect role/permission gates (same as main AgentClient.useMemory()).
  try {
    const hasAccess = await checkAccess({
      user: req.user,
      permissionType: PermissionTypes.MEMORIES,
      permissions: [Permissions.USE],
      getRoleByName,
    });
    if (!hasAccess) {
      return '';
    }
  } catch (error) {
    // Fail closed: if access check errors, do not include memory in cortex context.
    logger.warn(
      '[BackgroundCortexService] Memory access check failed; skipping memory context for cortex',
      sanitizeRuntimeErrorForLog(error),
    );
    return '';
  }

  try {
    const { withoutKeys } = await db.getFormattedMemories({ userId: String(req.user.id) });
    const memoryText = typeof withoutKeys === 'string' ? withoutKeys.trim() : '';
    if (!memoryText) {
      return '';
    }
    return `${memoryInstructions}\n\n# Existing memory about the user:\n${memoryText}`;
  } catch (error) {
    logger.warn(
      '[BackgroundCortexService] Failed to load formatted memories for cortex context',
      sanitizeRuntimeErrorForLog(error),
    );
    return '';
  }
}
/* === VIVENTIUM NOTE === */

/* === VIVENTIUM NOTE ===
 * Feature: File context parity for background cortices
 * Purpose: Ensure cortices receive the same attached-file text context as the main agent
 *          (when `extractFileContext` is enabled via `fileTokenLimit`).
 * Added: 2026-02-07
 */
async function getUserFileContextBlock(req) {
  const requestFiles = Array.isArray(req?.body?.files) ? req.body.files : [];
  if (requestFiles.length === 0) {
    return '';
  }

  // Best-effort: load full file docs from DB so `source=text` + `text` are available.
  let attachments = requestFiles.filter((f) => f && typeof f === 'object');
  const fileIds = attachments
    .map((file) => (typeof file.file_id === 'string' ? file.file_id : null))
    .filter(Boolean);

  if (fileIds.length > 0) {
    try {
      const dbFiles = (await db.getFiles({ file_id: { $in: fileIds } }, {}, {})) ?? [];
      const byId = new Map();

      for (const file of attachments) {
        if (file && typeof file.file_id === 'string') {
          byId.set(file.file_id, file);
        }
      }
      for (const file of dbFiles) {
        if (file && typeof file.file_id === 'string') {
          byId.set(file.file_id, file);
        }
      }

      // Preserve request-provided file objects that don't have a file_id (rare).
      const withoutId = attachments.filter((file) => !file?.file_id);
      attachments = [...byId.values(), ...withoutId];
    } catch (error) {
      logger.warn(
        '[BackgroundCortexService] Failed to load attached files for cortex context',
        sanitizeRuntimeErrorForLog(error),
      );
    }
  }

  try {
    const fileContext = await extractFileContext({
      attachments,
      req,
      tokenCountFn: (text) => countTokens(text),
    });
    const text = typeof fileContext === 'string' ? fileContext.trim() : '';
    return text || '';
  } catch (error) {
    logger.warn(
      '[BackgroundCortexService] Failed to extract file context for cortex',
      sanitizeRuntimeErrorForLog(error),
    );
    return '';
  }
}
/* === VIVENTIUM NOTE === */

/**
 * System prompt for activation detection LLM
 * Enforces fast, structured responses for classification tasks
 */
/**
 * Keep the configured display name intact.
 * The source-of-truth bundle already owns user-facing naming, so runtime
 * substring rewrites are illegal hardcoding and can silently rename valid
 * built-ins like "Parietal Cortex".
 * @param {string} cortexName - Configured cortex name
 * @returns {string} User-facing display name
 */
function sanitizeCortexDisplayName(cortexName) {
  const trimmed = String(cortexName || '').trim();
  return trimmed || 'Background Agent';
}

function titleCaseCortexName(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function deriveCortexDisplayNameFromAgentId(agentId) {
  const normalized = String(agentId || '')
    .trim()
    .replace(/^agent_/, '')
    .replace(/^viventium_/, '')
    .replace(/_[a-z0-9]{6,}$/i, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized || normalized === String(agentId || '').trim()) {
    return '';
  }

  return titleCaseCortexName(normalized);
}

function configuredCortexDisplayName(cortexConfig = {}) {
  const configured =
    cortexConfig.cortex_name ||
    cortexConfig.display_name ||
    cortexConfig.name ||
    cortexConfig.label ||
    '';
  const configuredName = sanitizeCortexDisplayName(configured);
  if (configuredName !== 'Background Agent') {
    return configuredName;
  }
  return deriveCortexDisplayNameFromAgentId(cortexConfig.agent_id);
}

function getEnvBackedEndpointConfig(endpointName) {
  const normalizedName = String(endpointName || '')
    .trim()
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

  if (!normalizedName) {
    return null;
  }

  const apiKey =
    process.env[`${normalizedName}_API_KEY`]?.trim() ||
    process.env[`${normalizedName}_KEY`]?.trim() ||
    '';
  const baseURL =
    process.env[`${normalizedName}_BASE_URL`]?.trim() ||
    process.env[`${normalizedName}_API_BASE_URL`]?.trim() ||
    '';

  const defaultBaseUrls = {
    GROQ: 'https://api.groq.com/openai/v1/',
    SAMBANOVA: 'https://api.sambanova.ai/v1/',
    XAI: 'https://api.x.ai/v1',
    PERPLEXITY: 'https://api.perplexity.ai',
    OPENROUTER: 'https://openrouter.ai/api/v1',
  };

  const resolvedBaseURL = baseURL || defaultBaseUrls[normalizedName] || '';

  if (!apiKey || !resolvedBaseURL) {
    return null;
  }

  return { apiKey, baseURL: resolvedBaseURL };
}

const ACTIVATION_SYSTEM_PROMPT = `You are an activation classifier for a multi-agent system.

Your task is to decide if a specialized background agent (cortex) should activate based on conversation context.
Apply the prompt's Activation Decision Subject rule exactly; the latest user/human message is the decision subject and earlier turns are context only.

Return only one valid JSON object. Do not include markdown, prose, headings, reasoning, comments, or activation tags outside the JSON object.`;

const DEFAULT_ACTIVATION_RESPONSE_FORMAT = `Respond with a JSON object:
{
  "should_activate": true,
  "confidence": 1.0,
  "reason": "2-4 explanatory words"
}`;

function shouldLogActivationPrompt() {
  return (process.env.VIVENTIUM_LOG_ACTIVATION_PROMPT || '').trim() === '1';
}

function promptDebugSummaryForLog(text) {
  const value = String(text || '');
  return {
    length: value.length,
    hash: hashString(value, 12),
  };
}

function promptDebugSummaryLabel(text) {
  const summary = promptDebugSummaryForLog(text);
  return `len=${summary.length} hash=${summary.hash}`;
}

const isVoiceLatencyEnabled = (req) => req?.viventiumVoiceLogLatency === true;

const getVoiceLatencyRequestId = (req) => {
  const requestId = req?.viventiumVoiceRequestId;
  if (typeof requestId === 'string' && requestId.length > 0) {
    return requestId;
  }
  return 'unknown';
};

const logVoicePhaseAStage = (req, stage, stageStartAt = null, details = '') => {
  if (!isVoiceLatencyEnabled(req)) {
    return;
  }
  const now = Date.now();
  const routeStartAt =
    typeof req?.viventiumVoiceStartAt === 'number' ? req.viventiumVoiceStartAt : now;
  const stageMs = typeof stageStartAt === 'number' ? now - stageStartAt : null;
  const stagePart = stageMs == null ? '' : ` stage_ms=${stageMs}`;
  const detailPart = details ? ` ${details}` : '';
  logger.info(
    `[VoiceLatency][LC][PhaseA] stage=${stage} request_id=${getVoiceLatencyRequestId(req)} total_ms=${now - routeStartAt}${stagePart}${detailPart}`,
  );
};

/* === VIVENTIUM NOTE ===
 * Feature: Extract user-facing summaries from structured cortex outputs.
 */
function extractUserFacingInsight(rawText) {
  if (typeof rawText !== 'string') {
    return '';
  }
  const original = rawText.trim();
  if (!original) {
    return '';
  }

  let text = original;
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenced && fenced[1]) {
    text = fenced[1].trim();
  }

  if (!(text.startsWith('{') && text.endsWith('}'))) {
    return original;
  }

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return original;
    }
    const candidates = ['user_summary', 'userSummary', 'summary', 'insight', 'response', 'output'];
    for (const key of candidates) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  } catch (err) {
    return original;
  }

  return original;
}
/* === VIVENTIUM NOTE === */

/* === VIVENTIUM NOTE ===
 * Feature: Background cortex context pruning via Run token counter.
 */
const DEFAULT_TOKEN_ENCODING = 'o200k_base';

function createTokenCounter(encoding = DEFAULT_TOKEN_ENCODING) {
  return function tokenCounter(message) {
    const countTokens = (text) => Tokenizer.getTokenCount(text, encoding);
    return getTokenCountForMessage(message, countTokens);
  };
}

function buildIndexTokenCountMap(messages, tokenCounter) {
  const indexTokenCountMap = {};
  if (!Array.isArray(messages)) {
    return indexTokenCountMap;
  }
  for (let i = 0; i < messages.length; i += 1) {
    try {
      indexTokenCountMap[i] = tokenCounter(messages[i]);
    } catch (error) {
      indexTokenCountMap[i] = 0;
    }
  }
  return indexTokenCountMap;
}
/* === VIVENTIUM NOTE === */

/**
 * Parse LLM activation response
 * @param {string} response - Raw LLM response
 * @returns {{ activate: boolean, confidence: number, reason: string }}
 */
function parseActivationResponse(response) {
  try {
    let cleaned = String(response || '').trim();
    if (cleaned) {
      cleaned = cleaned.replace(/<!--[^>]*-->/g, '').trim();
      const jsonStart = cleaned.indexOf('{');
      if (jsonStart > 0) {
        cleaned = cleaned.slice(jsonStart).trim();
      }
    }
    // Try direct JSON parse
    const data = JSON.parse(cleaned);
    return {
      activate: Boolean(data.activate ?? data.should_activate ?? data.shouldActivate),
      confidence: Number(data.confidence) || 0,
      reason: String(data.reason || ''),
    };
  } catch {
    // Try to extract JSON from response
    const jsonMatch = String(response || '').match(
      /\{[^{}]*("activate"|"should_activate"|"shouldActivate")[^{}]*\}/,
    );
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[0]);
        return {
          activate: Boolean(data.activate ?? data.should_activate ?? data.shouldActivate),
          confidence: Number(data.confidence) || 0,
          reason: String(data.reason || ''),
        };
      } catch {
        // Fall through
      }
    }

    logger.warn('[BackgroundCortexService] Failed to parse activation response', {
      response_hash: hashString(response, 12),
      response_length: typeof response === 'string' ? response.length : 0,
    });
    return { activate: false, confidence: 0, reason: 'parse-error' };
  }
}

/**
 * Filter cortex-related content types from LangChain messages.
 * This handles messages that are already LangChain objects (HumanMessage, AIMessage, etc.)
 * where the content may be an array containing cortex_insight/cortex_activation/cortex_brewing parts.
 *
 * @param {Array} messages - Array of LangChain message objects
 * @returns {Array} - Filtered messages with cortex content types removed
 */
/* === VIVENTIUM NOTE ===
 * Preserve LangChain message metadata/tool calls while filtering cortex content.
 */
function cloneLangChainMessageWithContent(msg, content) {
  if (!msg || typeof msg !== 'object') {
    return msg;
  }

  const fields = {
    content,
    name: msg.name,
    additional_kwargs: msg.additional_kwargs,
    response_metadata: msg.response_metadata,
    id: msg.id,
  };

  if (msg.tool_calls != null) {
    fields.tool_calls = msg.tool_calls;
  }
  if (msg.invalid_tool_calls != null) {
    fields.invalid_tool_calls = msg.invalid_tool_calls;
  }
  if (msg.usage_metadata != null) {
    fields.usage_metadata = msg.usage_metadata;
  }
  if (msg.role != null) {
    fields.role = msg.role;
  }
  if (msg.tool_call_id != null) {
    fields.tool_call_id = msg.tool_call_id;
  }
  if (msg.artifact != null) {
    fields.artifact = msg.artifact;
  }
  if (msg.status != null) {
    fields.status = msg.status;
  }
  if (msg.metadata != null) {
    fields.metadata = msg.metadata;
  }

  try {
    const MessageClass = msg.constructor;
    return new MessageClass(fields);
  } catch {
    return Object.assign(Object.create(Object.getPrototypeOf(msg)), msg, { content });
  }
}
/* === VIVENTIUM NOTE === */

function filterCortexContentFromLangChainMessages(messages) {
  if (!Array.isArray(messages)) {
    return messages;
  }

  const CORTEX_TYPES = new Set(['cortex_insight', 'cortex_activation', 'cortex_brewing']);
  /* === VIVENTIUM NOTE ===
   * Preserve tool call sequencing by keeping empty AI/tool messages with tool metadata.
   */
  const hasToolContext = (msg) => {
    if (!msg || typeof msg !== 'object') {
      return false;
    }
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const invalidToolCalls = Array.isArray(msg.invalid_tool_calls) ? msg.invalid_tool_calls : [];
    if (toolCalls.length > 0 || invalidToolCalls.length > 0) {
      return true;
    }
    if (msg.tool_call_id != null) {
      return true;
    }
    if (typeof msg.getType === 'function') {
      try {
        if (msg.getType() === 'tool') {
          return true;
        }
      } catch {
        // Ignore getType errors
      }
    }
    return msg.role === 'tool';
  };
  /* === VIVENTIUM NOTE === */

  return messages
    .map((msg) => {
      // Skip if no content or content is a plain string (no filtering needed)
      if (!msg || !msg.content || typeof msg.content === 'string') {
        return msg;
      }

      // If content is an array, filter out cortex content types
      if (Array.isArray(msg.content)) {
        const filteredContent = msg.content.filter((part) => {
          if (part && typeof part === 'object' && CORTEX_TYPES.has(part.type)) {
            return false; // Remove cortex content types
          }
          return true;
        });

        // If all content was filtered out, convert to empty string
        if (filteredContent.length === 0) {
          return cloneLangChainMessageWithContent(msg, '');
        }

        // If content changed, create new message with filtered content
        if (filteredContent.length !== msg.content.length) {
          return cloneLangChainMessageWithContent(msg, filteredContent);
        }
      }

      return msg;
    })
    .filter((msg) => {
      // Remove messages that became empty after filtering
      if (!msg) return false;
      const isEmptyString = typeof msg.content === 'string' && msg.content === '';
      const isEmptyArray = Array.isArray(msg.content) && msg.content.length === 0;
      if (isEmptyString || isEmptyArray) {
        return hasToolContext(msg);
      }
      return true;
    });
}

function getActivationFormat(config) {
  const activationFormat = config?.viventium?.background_cortices?.activation_format;
  const responseFormat = activationFormat?.response_format?.trim();
  const suffixParts = [];
  if (responseFormat) {
    suffixParts.push(responseFormat);
  }
  if (suffixParts.length > 0) {
    return suffixParts.join('\n\n');
  }
  return DEFAULT_ACTIVATION_RESPONSE_FORMAT;
}

function normalizeAgentToolNames(mainAgent) {
  const tools = Array.isArray(mainAgent?.tools) ? mainAgent.tools : [];
  return tools
    .map((tool) => {
      if (typeof tool === 'string') {
        return tool.trim();
      }
      if (tool && typeof tool === 'object') {
        return String(tool.name || tool.tool || tool.id || '').trim();
      }
      return '';
    })
    .filter(Boolean);
}

function normalizeDirectActionScopeKey(scopeKey) {
  const raw = String(scopeKey || '').trim();
  if (!raw) {
    return '';
  }
  return raw.replace(/\s+/g, '_').toLowerCase();
}

function applyActivationJsonMode({ providerName, model, llmConfig }) {
  if (!llmConfig || typeof llmConfig !== 'object') {
    return llmConfig;
  }
  const normalizedProvider = String(providerName || '')
    .trim()
    .toLowerCase();
  if (normalizedProvider === 'anthropic' || normalizedProvider === 'perplexity') {
    return llmConfig;
  }
  if (llmConfig.provider !== Providers.OPENAI) {
    return llmConfig;
  }
  if (
    normalizedProvider === 'openai' &&
    isOpenAIReasoningModelWithoutSampling(model || llmConfig.model)
  ) {
    return llmConfig;
  }

  return {
    ...llmConfig,
    modelKwargs: {
      ...(llmConfig.modelKwargs || {}),
      response_format: { type: 'json_object' },
    },
  };
}

function normalizeDirectActionSurfaceScopes(surfaces) {
  if (!Array.isArray(surfaces) || surfaces.length === 0) {
    return [];
  }

  const seen = new Set();
  const normalized = [];
  for (const surface of surfaces) {
    if (!surface) {
      continue;
    }

    if (typeof surface === 'string') {
      const scopeKey = normalizeDirectActionScopeKey(surface);
      if (!scopeKey || seen.has(scopeKey)) {
        continue;
      }
      seen.add(scopeKey);
      normalized.push({ scopeKey });
      continue;
    }

    if (typeof surface !== 'object') {
      continue;
    }

    const scopeKey = normalizeDirectActionScopeKey(
      surface.scopeKey || surface.scope_key || surface.intent_scope || surface.activation_scope,
    );
    if (!scopeKey || seen.has(scopeKey)) {
      continue;
    }
    seen.add(scopeKey);
    normalized.push({
      server: String(surface.server || surface.name || '').trim(),
      scopeKey,
      owns: String(surface.owns || surface.description || '').trim(),
      sameScopeBackgroundAllowed: surface.sameScopeBackgroundAllowed === true,
    });
  }

  return normalized;
}

function applyDirectActionOwnershipGate(result) {
  if (!result || result.shouldActivate !== true) {
    return result;
  }

  const activationScopeKey = normalizeDirectActionScopeKey(result.activationScope);
  if (!activationScopeKey) {
    return result;
  }

  const matchingSurface = normalizeDirectActionSurfaceScopes(result.directActionSurfaceScopes).find(
    (surface) => surface.scopeKey === activationScopeKey,
  );
  if (!matchingSurface || matchingSurface.sameScopeBackgroundAllowed === true) {
    return result;
  }

  return {
    ...result,
    shouldActivate: false,
    reason: 'direct_action_owned_by_main_agent',
    suppressedByDirectActionOwnership: true,
  };
}

function buildActivationPolicySection({ config, mainAgent }) {
  const policy = config?.viventium?.background_cortices?.activation_policy;
  if (!policy?.enabled) {
    return { section: '', connectedSurfaces: [] };
  }

  const prompt = String(policy.prompt || '').trim();
  const toolNames = normalizeAgentToolNames(mainAgent);
  const toolSet = new Set(toolNames);
  const declaredSurfaces = Array.isArray(policy.direct_action_mcp_servers)
    ? policy.direct_action_mcp_servers
    : [];
  const connectedSurfaces = [];

  for (const surface of declaredSurfaces) {
    if (!surface || typeof surface !== 'object') {
      continue;
    }
    const exactToolNames = Array.isArray(surface.tool_names)
      ? surface.tool_names.map((tool) => String(tool || '').trim()).filter(Boolean)
      : [];
    const connectedToolNames = exactToolNames.filter((tool) => toolSet.has(tool));
    if (exactToolNames.length > 0 && connectedToolNames.length === 0) {
      continue;
    }
    connectedSurfaces.push({
      server: String(surface.server || surface.name || '').trim(),
      owns: String(surface.owns || surface.description || '').trim(),
      scopeKey: normalizeDirectActionScopeKey(
        surface.scope_key || surface.scopeKey || surface.intent_scope || surface.activation_scope,
      ),
      sameScopeBackgroundAllowed:
        surface.same_scope_background_allowed === true ||
        surface.allow_same_scope_background === true ||
        surface.supplemental_background === true,
      connectedToolNames,
    });
  }

  const directActionRule = String(policy.direct_action_tool_rule || '').trim();
  const lines = ['## Global Activation Policy:'];
  if (prompt) {
    lines.push(prompt);
  }
  if (connectedSurfaces.length > 0) {
    lines.push('', 'Connected main-agent direct-action surfaces:');
    for (const surface of connectedSurfaces.slice(0, 8)) {
      const label = surface.server || 'declared direct-action surface';
      const owns = surface.owns ? ` — owns: ${surface.owns.slice(0, 180)}` : '';
      const scope = surface.scopeKey ? ` — scope_key: ${surface.scopeKey}` : '';
      const supplemental = surface.sameScopeBackgroundAllowed
        ? ' — same_scope_background_allowed: true'
        : '';
      lines.push(`- ${label}${scope}${supplemental}${owns}`);
    }
  }
  if (connectedSurfaces.some((surface) => surface.sameScopeBackgroundAllowed)) {
    lines.push(
      '',
      'When a connected direct-action surface is marked same_scope_background_allowed=true, treat it as main-agent ownership for Phase A, not as a blocker for a background agent whose own configured activation scope exactly matches that surface. Same-scope background agents may still activate when their own criteria are clearly met so Phase B can provide supplemental evidence.',
    );
  }
  if (directActionRule) {
    lines.push('', directActionRule);
  }
  if (lines.length === 1) {
    return { section: '', connectedSurfaces };
  }
  return {
    section: `${lines.join('\n')}\n\n`,
    connectedSurfaces,
  };
}

const DEFAULT_ACTIVATION_DECISION_SUBJECT_RULE = [
  'Judge activation only for the latest human/user message shown in "Latest User Intent".',
  'Use earlier "Recent Conversation" turns only to resolve references in that latest message.',
  'Never activate only because an older user request appears in history; that older request was already handled by its own turn.',
  "If the latest user message is a simple reply, acknowledgement, test instruction, correction, thanks, provider clarification, or output-only instruction that does not itself meet this cortex's activation criteria, return should_activate=false even when older history would have activated.",
].join(' ');

function resolvePromptRefText(value, fallback = DEFAULT_ACTIVATION_DECISION_SUBJECT_RULE) {
  if (!value || typeof value !== 'object') {
    return '';
  }
  const promptId = typeof value.promptRef === 'string' ? value.promptRef.trim() : '';
  if (!promptId) {
    return '';
  }
  const variables = value.promptVars && typeof value.promptVars === 'object' ? value.promptVars : {};
  return getPromptText(promptId, fallback, variables).trim();
}

function resolveActivationDecisionSubjectRule(config) {
  const backgroundCortices = config?.viventium?.background_cortices || {};
  const candidates = [
    backgroundCortices.activation_subject_rule,
    backgroundCortices.latest_user_message_rule,
    backgroundCortices.activation_policy?.latest_user_message_rule,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    if (candidate.enabled === false) {
      continue;
    }
    const rawPrompt = candidate.prompt || candidate.instructions || candidate.text;
    if (typeof rawPrompt === 'string' && rawPrompt.trim()) {
      return rawPrompt.trim();
    }
    const promptRefText =
      resolvePromptRefText(rawPrompt) ||
      resolvePromptRefText(candidate, DEFAULT_ACTIVATION_DECISION_SUBJECT_RULE);
    if (promptRefText) {
      return promptRefText;
    }
  }

  return DEFAULT_ACTIVATION_DECISION_SUBJECT_RULE;
}

function buildActivationDecisionSubjectSection({ config } = {}) {
  const rule = resolveActivationDecisionSubjectRule(config);
  if (!rule) {
    return '';
  }
  return `## Activation Decision Subject:\n${rule}\n\n`;
}

function getNormalizedAgentToolCount(agent) {
  return normalizeAgentToolNames(agent).length;
}

async function resolveActivationPolicyMainAgent({
  req,
  mainAgent,
  timeoutMs = 250,
  loadAgentFn = loadAgent,
} = {}) {
  if (!mainAgent || typeof mainAgent !== 'object') {
    return mainAgent;
  }

  const agentId = mainAgent.id || mainAgent.agent_id;
  const baseToolCount = getNormalizedAgentToolCount(mainAgent);
  if (!req || !agentId || typeof loadAgentFn !== 'function') {
    return mainAgent;
  }

  const deadlineMs = Number(timeoutMs);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    return mainAgent;
  }

  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve(null), deadlineMs);
  });

  try {
    const canonical = await Promise.race([
      loadAgentFn({
        req,
        agent_id: agentId,
        endpoint: mainAgent.provider || mainAgent.endpoint,
      }),
      timeout,
    ]);
    const canonicalToolCount = getNormalizedAgentToolCount(canonical);
    if (!canonical || canonicalToolCount <= baseToolCount) {
      return mainAgent;
    }

    logger.info(
      `[BackgroundCortexService] Activation policy hydrated main-agent tools: ` +
        `agent=${agentId} request_tools=${baseToolCount} canonical_tools=${canonicalToolCount}`,
    );
    return {
      ...mainAgent,
      tools: canonical.tools,
      tool_resources: mainAgent.tool_resources || canonical.tool_resources,
    };
  } catch (error) {
    logger.warn(
      `[BackgroundCortexService] Activation policy main-agent hydration failed for ${agentId}: ` +
        'using request-scoped agent tools',
      sanitizeRuntimeErrorForLog(error),
    );
    return mainAgent;
  }
}

/**
 * Extract text content from message content in a consistent way.
 * @param {string|object|Array} content
 * @returns {string}
 */
function extractTextFromContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text')
      .map((part) => part?.text || '')
      .join(' ')
      .trim();
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') {
      return content.text;
    }
    if (typeof content.content === 'string') {
      return content.content;
    }
  }
  return '';
}

/* === VIVENTIUM NOTE ===
 * Fix: Activation history must correctly label LangChain HumanMessage/AIMessage roles.
 */
function getActivationRole(msg) {
  if (!msg || typeof msg !== 'object') {
    return '';
  }

  const getType =
    typeof msg.getType === 'function'
      ? msg.getType.bind(msg)
      : typeof msg._getType === 'function'
        ? msg._getType.bind(msg)
        : null;
  if (getType) {
    try {
      const msgType = String(getType() || '').toLowerCase();
      if (msgType === 'human') {
        return 'user';
      }
      if (msgType === 'ai') {
        return 'assistant';
      }
      if (msgType === 'system' || msgType === 'tool') {
        return msgType;
      }
    } catch {
      // Fall back to role field.
    }
  }

  const role = String(msg.role || '').toLowerCase();
  if (role === 'user' || role === 'human') {
    return 'user';
  }
  if (role === 'assistant' || role === 'ai') {
    return 'assistant';
  }
  if (role === 'system' || role === 'tool') {
    return role;
  }

  return '';
}
/* === VIVENTIUM NOTE === */

/**
 * Format conversation history for activation prompt
 * @param {Array<{ role: string, content: string | object }>} messages - Conversation messages
 * @param {number} maxHistory - Maximum messages to include
 * @returns {string}
 */
function formatHistoryForActivation(messages, maxHistory = 5) {
  /* === VIVENTIUM NOTE ===
   * Only include user/assistant turns and label LangChain message roles correctly.
   */
  const lines = [];
  const safeMessages = Array.isArray(messages) ? messages : [];

  for (const msg of safeMessages) {
    const role = getActivationRole(msg);
    if (role !== 'user' && role !== 'assistant') {
      continue;
    }
    let content = extractTextFromContent(msg.content);
    if (!content && msg.content) {
      content = JSON.stringify(msg.content).slice(0, 500);
    }
    if (!content) {
      continue;
    }
    const label = role === 'user' ? 'User' : 'Assistant';
    lines.push(`[${label}] ${content.slice(0, 500)}`);
  }

  return lines.slice(-maxHistory).join('\n');
  /* === VIVENTIUM NOTE === */
}

/**
 * Get the most recent user message text for tool-oriented cortices.
 * @param {Array<{ role: string, content: string | object }>} messages
 * @returns {string}
 */
function getLastUserMessageText(messages) {
  /* === VIVENTIUM NOTE ===
   * Support LangChain HumanMessage/AIMessage objects for user text lookup.
   */
  const safeMessages = Array.isArray(messages) ? messages : [];
  for (let i = safeMessages.length - 1; i >= 0; i -= 1) {
    const msg = safeMessages[i];
    if (getActivationRole(msg) !== 'user') {
      continue;
    }
    const text = extractTextFromContent(msg.content);
    if (text) {
      return text;
    }
  }
  return '';
  /* === VIVENTIUM NOTE === */
}

function normalizeActivationText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasVisibleCortexInsight(insight) {
  if (typeof insight !== 'string') {
    return false;
  }
  const trimmed = insight.trim();
  return Boolean(trimmed) && !isNoResponseOnly(trimmed);
}

function buildCortexCompletionPayload(result) {
  if (!result) {
    return null;
  }

  const hasVisibleInsight = hasVisibleCortexInsight(result.insight);
  const basePayload = {
    cortex_id: result.agentId,
    cortex_name: sanitizeCortexDisplayName(result.agentName || result.agentId),
    activation_scope: result.activationScope || null,
    configured_tools: result.configuredTools || 0,
    completed_tool_calls: result.completedToolCalls || 0,
  };
  const confidence = Number(result.confidence);
  if (Number.isFinite(confidence)) {
    basePayload.confidence = confidence;
  }
  const reason = String(result.reason || '').trim();
  if (reason) {
    basePayload.reason = reason;
  }
  const cortexDescription = String(result.cortexDescription || result.cortex_description || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cortexDescription) {
    basePayload.cortex_description = cortexDescription.slice(0, 220);
  }
  if (Array.isArray(result.directActionSurfaces)) {
    basePayload.direct_action_surfaces = result.directActionSurfaces;
  }
  const directActionSurfaceScopes = normalizeDirectActionSurfaceScopes(
    result.directActionSurfaceScopes,
  );
  if (directActionSurfaceScopes.length > 0) {
    basePayload.direct_action_surface_scopes = directActionSurfaceScopes;
  }

  if (result.error) {
    const publicError = publicCortexError(result, result.errorClass || result.error_class);
    return {
      ...basePayload,
      status: 'error',
      error: publicError.message,
      error_class: publicError.errorClass,
    };
  }

  return {
    ...basePayload,
    status: 'complete',
    insight: hasVisibleInsight ? result.insight : '',
    silent: !hasVisibleInsight,
    no_response: !hasVisibleInsight,
  };
}

function buildCompletionInputFromActivation({
  activationResult,
  cortexAgent = null,
  result = null,
  error = null,
  errorClass = null,
}) {
  return {
    agentId: result?.agentId || activationResult.agentId,
    agentName:
      result?.agentName ||
      cortexAgent?.name ||
      activationResult.cortexName ||
      activationResult.agentId,
    insight: result?.insight ?? null,
    error: error || result?.error || null,
    errorClass: errorClass || result?.errorClass || result?.error_class || activationResult.errorClass || null,
    activationScope: result?.activationScope || activationResult.activationScope || null,
    configuredTools: result?.configuredTools || 0,
    completedToolCalls: result?.completedToolCalls || 0,
    confidence: activationResult.confidence,
    reason: activationResult.reason,
    cortexDescription: activationResult.cortexDescription,
    directActionSurfaces: Array.isArray(activationResult.directActionSurfaces)
      ? activationResult.directActionSurfaces
      : [],
    directActionSurfaceScopes: normalizeDirectActionSurfaceScopes(
      activationResult.directActionSurfaceScopes,
    ),
  };
}

const RETRYABLE_ACTIVATION_STATUS_CODES = new Set([401, 402, 403, 429, 500, 502, 503, 504]);
const RETRYABLE_ACTIVATION_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ETIMEDOUT',
]);

function resolveConfiguredProductivityActivationScopeKey(cortexConfig) {
  const scope = resolveProductivitySpecialistScope(cortexConfig, {
    scope:
      cortexConfig?.activation?.intent_scope ||
      cortexConfig?.intent_scope ||
      cortexConfig?.activationScope ||
      cortexConfig?.activation_scope ||
      null,
  });

  return scope ? `productivity_${scope}` : null;
}

function buildLatestUserIntentSection({ cortexConfig, messages }) {
  const latestUserMessage = normalizeActivationText(getLastUserMessageText(messages));
  if (!latestUserMessage) {
    return '';
  }

  const lines = [`LatestUserMessage: ${latestUserMessage}`];
  const scopeKey = resolveConfiguredProductivityActivationScopeKey(cortexConfig);
  if (scopeKey) {
    lines.push(`ActivationScopeKey: ${scopeKey}`);
  }

  return `## Latest User Intent:\n${lines.join('\n')}\n\n`;
}

function extractActivationErrorStatus(error) {
  const directStatus = Number(error?.response?.status || error?.status || 0);
  if (Number.isFinite(directStatus) && directStatus > 0) {
    return directStatus;
  }

  const message = typeof error?.message === 'string' ? error.message : '';
  const statusMatch = message.match(/\bstatus code (\d{3})\b/i);
  if (statusMatch?.[1]) {
    return Number(statusMatch[1]);
  }

  return 0;
}

function summarizeActivationError(error) {
  const status = extractActivationErrorStatus(error) || null;
  const code = String(error?.code || '').toUpperCase() || null;
  const message = String(error?.message || 'activation classifier error');
  return {
    status,
    code,
    message,
    class: classifyActivationError({ status, code, message }),
  };
}

function formatActivationErrorSummaryForLog(errorSummary = {}) {
  return (
    `class=${errorSummary.class || 'provider_error'} ` +
    `status=${errorSummary.status || 'none'} ` +
    `code=${errorSummary.code || 'none'}`
  );
}

function sanitizeActivationErrorForLog(errorSummary = {}) {
  return {
    class: errorSummary.class || 'provider_error',
    status: errorSummary.status || null,
    code: errorSummary.code || null,
  };
}

function safeStringifyForErrorSignal(value) {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function extractCortexErrorMessage(error) {
  if (typeof error === 'string') {
    return error;
  }
  if (!error || typeof error !== 'object') {
    return String(error || '');
  }
  return (
    error.message ||
    error.error ||
    error.errorMessage ||
    error.response?.data?.error?.message ||
    error.response?.data?.message ||
    error.cause?.message ||
    safeStringifyForErrorSignal(error.response?.data) ||
    safeStringifyForErrorSignal(error)
  );
}

function extractCortexErrorStatus(error, message = '') {
  const candidates = [
    error?.response?.status,
    error?.status,
    error?.statusCode,
    error?.errorStatus,
    error?.error_status,
    error?.error?.status,
    error?.error?.statusCode,
    error?.cause?.status,
    error?.cause?.statusCode,
  ];
  for (const candidate of candidates) {
    const status = Number(candidate);
    if (Number.isFinite(status) && status > 0) {
      return status;
    }
  }

  const text = String(message || '');
  const statusMatch =
    text.match(/^\s*(\d{3})\b/) ||
    text.match(/\bstatus(?: code)?[ =:]+(\d{3})\b/i) ||
    text.match(/"status"\s*:\s*(\d{3})/i);
  return statusMatch?.[1] ? Number(statusMatch[1]) : 0;
}

function extractCortexErrorCode(error, message = '') {
  const candidates = [
    error?.code,
    error?.lc_error_code,
    error?.errorCode,
    error?.error_code,
    error?.error?.code,
    error?.error?.type,
    error?.response?.data?.code,
    error?.response?.data?.type,
    error?.response?.data?.error?.code,
    error?.response?.data?.error?.type,
    error?.cause?.code,
  ];
  for (const candidate of candidates) {
    const code = String(candidate || '').trim();
    if (code) {
      return code;
    }
  }

  const text = String(message || '');
  const codeMatch = text.match(/\b(MODEL_[A-Z_]+|E[A-Z_]+|authentication_error)\b/i);
  return codeMatch?.[1] || '';
}

function classifyCortexPublicError(error, explicitClass = '') {
  const rawClass = String(explicitClass || '').trim();
  if (rawClass && !['background_agent_error', 'recoverable_provider_error'].includes(rawClass)) {
    return rawClass;
  }
  const rawMessage = extractCortexErrorMessage(error);
  const message = String(rawMessage || '')
    .trim()
    .toLowerCase();
  const status = extractCortexErrorStatus(error, rawMessage);
  const code = String(extractCortexErrorCode(error, rawMessage) || '').toUpperCase();

  if (
    status === 401 ||
    code === 'MODEL_AUTHENTICATION' ||
    message.includes('authentication_error') ||
    message.includes('invalid authentication') ||
    message.includes('invalid api key') ||
    message.includes('credential')
  ) {
    return 'provider_unauthorized';
  }
  if (
    status === 403 ||
    message.includes('forbidden') ||
    message.includes('access denied') ||
    message.includes('permission denied')
  ) {
    return 'provider_access_denied';
  }
  if (
    status === 429 ||
    message.includes('rate limit') ||
    message.includes('rate_limit') ||
    message.includes('too many requests')
  ) {
    return 'provider_rate_limited';
  }
  if (
    status === 402 ||
    message.includes('billing') ||
    message.includes('quota') ||
    message.includes('insufficient credits')
  ) {
    return 'provider_quota_or_billing';
  }
  if (message === 'timeout' || message.includes('timed out')) {
    return 'timeout';
  }
  if (message === 'activation_provider_unavailable') {
    return 'activation_provider_unavailable';
  }
  if (message === 'no_live_tool_execution') {
    return 'no_live_tool_execution';
  }
  if (message.includes('cortex agent not found') || message.includes('agent not found')) {
    return 'cortex_agent_not_found';
  }
  if (status >= 500 || status === 529 || message.includes('overloaded')) {
    return 'recoverable_provider_error';
  }
  if (message.includes('provider') || message.includes('unauthorized') || message.includes('forbidden')) {
    return 'recoverable_provider_error';
  }
  if (rawClass) {
    return rawClass;
  }
  return 'background_agent_error';
}

function publicCortexError(error, explicitClass = '') {
  const errorClass = classifyCortexPublicError(error, explicitClass);
  return {
    errorClass,
    message:
      PUBLIC_CORTEX_ERROR_MESSAGES[errorClass] ||
      PUBLIC_CORTEX_ERROR_MESSAGES.background_agent_error,
  };
}

function sanitizeRuntimeErrorForLog(error, explicitClass = '') {
  const publicError = publicCortexError(error, explicitClass);
  return {
    class: publicError.errorClass,
    name: error?.name || null,
    status: Number.isFinite(error?.status) ? error.status : null,
    code: error?.code || error?.lc_error_code || null,
  };
}

function classifyActivationError({ status, code, message }) {
  const normalizedMessage = String(message || '').toLowerCase();
  const normalizedCode = String(code || '').toUpperCase();

  if (status === 401 || normalizedMessage.includes('unauthorized')) {
    return 'provider_unauthorized';
  }
  if (
    status === 403 ||
    normalizedMessage.includes('forbidden') ||
    normalizedMessage.includes('access denied')
  ) {
    return 'provider_access_denied';
  }
  if (status === 429 || normalizedMessage.includes('rate limit')) {
    return 'provider_rate_limited';
  }
  if (
    status === 402 ||
    normalizedMessage.includes('billing') ||
    normalizedMessage.includes('quota')
  ) {
    return 'provider_quota_or_billing';
  }
  if (
    normalizedCode === 'ECONNABORTED' ||
    normalizedCode === 'ETIMEDOUT' ||
    normalizedMessage.includes('timeout')
  ) {
    return 'provider_timeout';
  }
  if (
    normalizedCode === 'ECONNREFUSED' ||
    normalizedCode === 'ECONNRESET' ||
    normalizedCode === 'EAI_AGAIN'
  ) {
    return 'provider_network';
  }
  if (status >= 500) {
    return 'provider_server_error';
  }

  return 'provider_error';
}

function isActivationFallbackCandidate(error) {
  const status = extractActivationErrorStatus(error);
  if (RETRYABLE_ACTIVATION_STATUS_CODES.has(status)) {
    return true;
  }

  const code = String(error?.code || '').toUpperCase();
  if (RETRYABLE_ACTIVATION_ERROR_CODES.has(code)) {
    return true;
  }

  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('billing') ||
    message.includes('quota') ||
    message.includes('rate limit') ||
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('permission') ||
    message.includes('timeout')
  );
}

function isUnavailableActivationAttempt(attempt = {}) {
  const status = String(attempt.status || '');
  const errorClass = String(attempt.error?.class || '');
  if (!['error', 'skipped_unhealthy'].includes(status)) {
    return false;
  }
  return shouldSuppressActivationProvider({ class: errorClass });
}

function activationProviderAttemptsUnavailable(providerAttempts) {
  return (
    Array.isArray(providerAttempts) &&
    providerAttempts.length > 0 &&
    providerAttempts.every(isUnavailableActivationAttempt)
  );
}

function activationFailureVisibility(cortexConfig = {}) {
  const raw = String(
    cortexConfig?.activation?.activation_failure_visibility ||
      cortexConfig?.activation?.failure_visibility ||
      '',
  )
    .trim()
    .toLowerCase();
  return raw === 'visible' ? 'visible' : 'silent';
}

function shouldSurfaceActivationProviderUnavailable({ activationResult, cortexConfig }) {
  if (!activationProviderAttemptsUnavailable(activationResult?.providerAttempts)) {
    return false;
  }
  return activationFailureVisibility(cortexConfig) === 'visible';
}

function shouldSurfaceActivationTimeout({ activationResult, cortexConfig }) {
  void activationResult;
  void cortexConfig;
  /*
   * Activation timeout means the classifier did not finish inside the Phase A budget.
   * It is not evidence that the background agent activated or executed, so surfacing it
   * as a user-facing cortex card creates noise such as "Confirmation Bias error" beside
   * valid completed cards. Keep this in logs/telemetry only. Execution-time cortex
   * failures still render as cards because those agents did activate.
   */
  return false;
}

function normalizeActivationFallbacks(activation = {}) {
  const primaryProvider = String(activation?.provider || '').trim();
  const primaryModel = String(activation?.model || '').trim();
  const fallbacks = Array.isArray(activation?.fallbacks) ? activation.fallbacks : [];
  const normalized = [];
  const seen = new Set();

  for (const entry of fallbacks) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const provider = String(entry.provider || '').trim();
    const model = String(entry.model || '').trim();
    if (!provider || !model) {
      continue;
    }

    const dedupeKey = `${provider.toLowerCase()}::${model}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    if (provider.toLowerCase() === primaryProvider.toLowerCase() && model === primaryModel) {
      continue;
    }

    normalized.push({ provider, model });
  }

  return normalized;
}

function buildActivationProviderAttempts(activation = {}) {
  return [
    {
      provider: String(activation?.provider || '').trim(),
      model: String(activation?.model || '').trim(),
      source: 'primary',
    },
    ...normalizeActivationFallbacks(activation).map((entry) => ({
      ...entry,
      source: 'fallback',
    })),
  ].filter((entry) => entry.provider && entry.model);
}

function boundedActivationTimeoutEnv(name, defaultValue, maxValue) {
  const parsed = Number.parseInt(String(process.env[name] || ''), 10);
  const fallback = Number.isFinite(Number(defaultValue)) ? Number(defaultValue) : 0;
  const ceiling =
    Number.isFinite(Number(maxValue)) && Number(maxValue) > 0
      ? Number(maxValue)
      : Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.min(fallback, ceiling);
  }
  return Math.min(parsed, ceiling);
}

function activationAttemptTimeoutMs({
  activationTimeoutMs,
  activationStartTime,
  attemptIndex,
  attemptsLength,
} = {}) {
  const globalBudget = Number.isFinite(Number(activationTimeoutMs))
    ? Math.max(0, Number(activationTimeoutMs))
    : 0;
  if (globalBudget <= 0) {
    return 0;
  }

  const elapsed = Date.now() - Number(activationStartTime || Date.now());
  const remaining = Math.max(0, globalBudget - elapsed);
  if (remaining <= 0) {
    return 0;
  }

  if (attemptsLength <= 1 || attemptIndex >= attemptsLength - 1) {
    return remaining;
  }

  const defaultAttemptBudget = Math.min(900, globalBudget);
  const envName =
    attemptIndex === 0
      ? 'VIVENTIUM_ACTIVATION_PRIMARY_ATTEMPT_TIMEOUT_MS'
      : 'VIVENTIUM_ACTIVATION_FALLBACK_ATTEMPT_TIMEOUT_MS';
  return Math.min(
    remaining,
    boundedActivationTimeoutEnv(envName, defaultAttemptBudget, globalBudget),
  );
}

function activationTimeoutErrorSummary() {
  return {
    status: null,
    code: 'ABORT_ERR',
    message: 'activation classifier attempt timeout',
    class: 'provider_timeout',
  };
}
/* === VIVENTIUM NOTE === */

/**
 * Creates a tool loader function for background cortex execution.
 * Mirrors LibreChat agent initialization to avoid custom tool wiring.
 * @param {AbortSignal} signal
 * @param {string | null} streamId
 */
function createToolLoader(signal, streamId = null) {
  return async function loadTools({ req, res, agentId, tools, provider, model, tool_resources }) {
    const agent = { id: agentId, tools, provider, model };
    try {
      return await loadAgentTools({
        req,
        res,
        agent,
        signal,
        tool_resources,
        streamId,
      });
    } catch (error) {
      logger.error(
        'Error loading tools for background cortex ' + agentId,
        sanitizeRuntimeErrorForLog(error),
      );
      return {};
    }
  };
}

/* === VIVENTIUM NOTE ===
 * Feature: Robust synthetic response for background cortex execution.
 *
 * Why:
 * - Phase B cortex execution receives `res: null` when the main response is a tool-cortex hold.
 * - MCP tool loading, event handlers, and SSE helpers may call `res.on()`, `res.once()`, or
 *   check `res.write()` return value for backpressure.  A bare object without EventEmitter
 *   methods causes `TypeError: res.on is not a function`, silently breaking tool loading via
 *   the `createToolLoader` catch block and leaving the cortex toolless.
 *
 * Fix:
 * - Extend EventEmitter so `res.on('close', ...)`, `res.once('drain', ...)` etc. are no-ops
 *   that do not throw.
 * - Return `true` from `write()` to signal "no backpressure" and prevent drain-wait hangs.
 */
const EventEmitter = require('events');

function createBackgroundRes() {
  const stub = new EventEmitter();
  stub.writableEnded = false;
  stub.destroyed = false;
  stub.headersSent = false;
  stub.statusCode = 200;
  stub.write = function () {
    return true;
  };
  stub.end = function () {};
  stub.setHeader = function () {};
  stub.getHeader = function () {
    return undefined;
  };
  stub.writeHead = function () {};
  stub.flushHeaders = function () {};
  return stub;
}
/* === VIVENTIUM NOTE === */

/**
 * Map provider string to @librechat/agents Providers enum or custom endpoint name
 * @param {string} provider - Provider string
 * @returns {string}
 */
function mapProvider(provider) {
  const providerMap = {
    openai: Providers.OPENAI,
    anthropic: Providers.ANTHROPIC,
    google: Providers.GOOGLE,
    azure: Providers.AZURE_OPENAI,
    bedrock: Providers.BEDROCK,
    // Groq uses OpenAI-compatible API, so use OPENAI provider with custom config
    groq: Providers.OPENAI,
    // xAI / Perplexity / other OpenAI-compatible providers are handled as custom endpoints
    // via getCustomEndpointConfig(...) and also use the OPENAI provider.
    xai: Providers.OPENAI,
    perplexity: Providers.OPENAI,
  };
  return providerMap[provider?.toLowerCase()] || Providers.OPENAI;
}

/**
 * Get custom endpoint configuration (e.g., Groq API key and baseURL)
 * @param {string} endpointName - Custom endpoint name (e.g., 'groq')
 * @param {object} req - Express request object
 * @returns {Promise<{apiKey: string, baseURL: string} | null>}
 */
async function getCustomEndpointConfig(endpointName, req) {
  try {
    const normalizedName = (endpointName || '').toLowerCase();
    if (!normalizedName) {
      return null;
    }

    // First try to get from custom endpoints config
    const appConfig = await getAppConfig({ role: req.user?.role });
    const customEndpoints = appConfig?.endpoints?.custom || [];
    const endpoint = customEndpoints.find((ep) => (ep.name || '').toLowerCase() === normalizedName);

    if (endpoint) {
      // Extract environment variables from config
      const { extractEnvVariable } = require('librechat-data-provider');
      const apiKey = extractEnvVariable(endpoint.apiKey || '');
      const baseURL = extractEnvVariable(endpoint.baseURL || '');

      if (apiKey && baseURL) {
        return { apiKey, baseURL };
      }
    }

    const envConfig = getEnvBackedEndpointConfig(normalizedName);
    if (envConfig) {
      logger.info(
        `[BackgroundCortexService] Using ${normalizedName} endpoint config from environment variables`,
      );
      return envConfig;
    }

    return null;
  } catch (error) {
    logger.warn(
      `[BackgroundCortexService] Failed to get custom endpoint config for ${endpointName}`,
      sanitizeRuntimeErrorForLog(error),
    );

    const envConfig = getEnvBackedEndpointConfig(endpointName);
    if (envConfig) {
      logger.info(
        `[BackgroundCortexService] Using ${String(endpointName || '').toLowerCase()} endpoint config from environment variables (fallback)`,
      );
      return envConfig;
    }

    return null;
  }
}

/**
 * Apply Anthropic reverse proxy config when running outside LibreChat initialization.
 * @param {object} llmConfig - LLM config object to mutate
 */
function applyAnthropicConfig(llmConfig) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const reverseProxyUrl = process.env.ANTHROPIC_REVERSE_PROXY;

  if (apiKey && apiKey !== 'user_provided') {
    llmConfig.apiKey = apiKey;
  }

  if (reverseProxyUrl) {
    llmConfig.anthropicApiUrl = reverseProxyUrl;
    llmConfig.clientOptions = {
      ...(llmConfig.clientOptions || {}),
      baseURL: reverseProxyUrl,
    };
  }
}

/* === VIVENTIUM START ===
 * Feature: Anthropic thinking/temperature compatibility guard.
 * Purpose: Anthropic rejects temperature whenever thinking is active, including adaptive/default
 * thinking that may be introduced after initial agent config hydration.
 * SYNC: Keep the active-thinking shape aligned with
 * `packages/api/src/endpoints/anthropic/helpers.ts::hasActiveAnthropicThinking`.
 * === VIVENTIUM END === */
function hasActiveAnthropicThinking(thinking) {
  if (thinking == null || thinking === false) {
    return false;
  }

  if (thinking === true) {
    return true;
  }

  if (typeof thinking !== 'object' || Array.isArray(thinking)) {
    logger.warn(
      '[BackgroundCortexService] Unexpected Anthropic thinking shape encountered; treating as active for safety',
      { thinking_type: Array.isArray(thinking) ? 'array' : typeof thinking },
    );
    return true;
  }

  const type = typeof thinking.type === 'string' ? thinking.type.trim().toLowerCase() : '';
  if (type === 'disabled' || thinking.enabled === false) {
    return false;
  }

  return true;
}

function sanitizeAnthropicThinkingTemperature(agentForRun, safeReq) {
  const model =
    typeof agentForRun?.model_parameters?.model === 'string'
      ? agentForRun.model_parameters.model
      : typeof agentForRun?.model === 'string'
        ? agentForRun.model
        : '';
  const adaptiveModel = model ? supportsAdaptiveThinking(model) : false;
  if (!hasActiveAnthropicThinking(agentForRun?.model_parameters?.thinking) && !adaptiveModel) {
    return;
  }

  let removed = false;
  if (
    agentForRun?.model_parameters &&
    Object.prototype.hasOwnProperty.call(agentForRun.model_parameters, 'temperature')
  ) {
    delete agentForRun.model_parameters.temperature;
    removed = true;
  }

  if (safeReq?.body && Object.prototype.hasOwnProperty.call(safeReq.body, 'temperature')) {
    delete safeReq.body.temperature;
    removed = true;
  }

  if (removed) {
    logger.info(
      `[BackgroundCortexService] Removed Anthropic cortex temperature because ${
        hasActiveAnthropicThinking(agentForRun?.model_parameters?.thinking)
          ? 'thinking is active'
          : 'the model uses adaptive-thinking-era Anthropic temperature rules'
      }`,
    );
  }
}

/* === VIVENTIUM START ===
 * Feature: OpenAI reasoning-model sampling compatibility guard.
 *
 * Why:
 * - Background cortex execution can bypass the normal endpoint-level OpenAI sanitization shape.
 * - Reasoning-style OpenAI runs such as gpt-5.* reject sampling controls like temperature.
 * - This must apply before and after initializeAgent because runtime hydration can materialize
 *   model_parameters after source-of-truth copying.
 * === VIVENTIUM END === */
function sanitizeOpenAIReasoningSampling(agentForRun, safeReq) {
  const model =
    typeof agentForRun?.model_parameters?.model === 'string'
      ? agentForRun.model_parameters.model
      : typeof agentForRun?.model === 'string'
        ? agentForRun.model
        : '';

  const removedFromAgent = sanitizeOpenAIReasoningSamplingParams(agentForRun?.model_parameters, {
    model,
  });
  const removedFromRequest = sanitizeOpenAIReasoningSamplingParams(safeReq?.body, { model });
  const removed = [...removedFromAgent, ...removedFromRequest];

  if (removed.length > 0) {
    logger.info(
      `[BackgroundCortexService] Removed OpenAI reasoning cortex sampling params for model=${model || 'unknown'} keys=${[...new Set(removed)].join(',')}`,
    );
  }
}

async function buildActivationLlmConfig({ providerName, model, req }) {
  const mappedProvider = mapProvider(providerName);
  const usesAdaptiveAnthropicTemperatureRules =
    providerName === 'anthropic' && supportsAdaptiveThinking(model);
  const llmConfig = {
    provider: mappedProvider,
    model,
    maxTokens: 100,
    streaming: false,
    disableStreaming: true,
  };

  if (!(providerName === 'perplexity' || usesAdaptiveAnthropicTemperatureRules)) {
    llmConfig.temperature = 0.1;
  }

  if (req && providerName) {
    const customConfig = await getCustomEndpointConfig(providerName, req);
    if (customConfig?.apiKey && customConfig?.baseURL) {
      llmConfig.provider = Providers.OPENAI;
      llmConfig.configuration = {
        apiKey: customConfig.apiKey,
        baseURL: customConfig.baseURL,
      };
    }
  }

  if (providerName === 'anthropic') {
    const anthropicReq = req
      ? {
          ...req,
          body: {
            ...(req.body || {}),
          },
        }
      : {
          body: {},
          user: {},
          config: null,
        };

    if (!anthropicReq.config) {
      anthropicReq.config = await getAppConfig({ role: anthropicReq.user?.role });
    }

    const anthropicInit = await initializeAnthropic({
      req: anthropicReq,
      endpoint: EModelEndpoint.anthropic,
      model_parameters: {
        model,
        maxOutputTokens: 100,
        thinking: false,
        ...(usesAdaptiveAnthropicTemperatureRules ? {} : { temperature: 0.1 }),
      },
      db: {
        getUserKey: db.getUserKey,
        getUserKeyValues: db.getUserKeyValues,
        updateUserKey: db.updateUserKey,
      },
    });

    const anthropicLlmConfig = {
      ...anthropicInit.llmConfig,
      provider: Providers.ANTHROPIC,
      model,
      streaming: false,
      disableStreaming: true,
    };

    if (usesAdaptiveAnthropicTemperatureRules) {
      delete anthropicLlmConfig.temperature;
    }

    return anthropicLlmConfig;
  }
  if (providerName === 'openai' && req) {
    const openAIReq = {
      ...req,
      body: {
        ...(req.body || {}),
      },
    };

    if (!openAIReq.config) {
      openAIReq.config = await getAppConfig({ role: openAIReq.user?.role });
    }

    const modelParameters = {
      model,
      max_output_tokens: 100,
      ...(isOpenAIReasoningModelWithoutSampling(model) ? {} : { temperature: 0.1 }),
    };
    const removedFromModelParameters = sanitizeOpenAIReasoningSamplingParams(modelParameters, {
      model,
    });
    if (removedFromModelParameters.length > 0) {
      logger.info(
        `[BackgroundCortexService] Removed OpenAI reasoning activation sampling params before initialization for model=${model || 'unknown'} keys=${[...new Set(removedFromModelParameters)].join(',')}`,
      );
    }

    const initialized = await initializeOpenAI({
      req: openAIReq,
      endpoint: EModelEndpoint.openAI,
      model_parameters: modelParameters,
      db,
    });

    const openAILlmConfig = {
      ...initialized.llmConfig,
      provider: Providers.OPENAI,
      model,
      streaming: false,
      disableStreaming: true,
    };

    const removedFromInitializedConfig = sanitizeOpenAIReasoningSamplingParams(openAILlmConfig, {
      model,
    });
    if (removedFromInitializedConfig.length > 0) {
      logger.info(
        `[BackgroundCortexService] Removed OpenAI reasoning activation sampling params for model=${model || 'unknown'} keys=${[...new Set(removedFromInitializedConfig)].join(',')}`,
      );
    }

    return applyActivationJsonMode({ providerName, model, llmConfig: openAILlmConfig });
  }
  if (providerName === 'perplexity') {
    delete llmConfig.temperature;
  }

  const removedSamplingParams = sanitizeOpenAIReasoningSamplingParams(llmConfig, { model });
  if (removedSamplingParams.length > 0) {
    logger.info(
      `[BackgroundCortexService] Removed OpenAI reasoning activation sampling params for model=${model || 'unknown'} keys=${[...new Set(removedSamplingParams)].join(',')}`,
    );
  }

  return applyActivationJsonMode({ providerName, model, llmConfig });
}

async function invokeActivationClassifierAttempt({
  agentId,
  providerName,
  model,
  fullPrompt,
  runId,
  req,
  abortController,
}) {
  const llmConfig = await buildActivationLlmConfig({ providerName, model, req });
  const runIdSuffix = `${providerName}-${model}`.replace(/[^a-z0-9_-]+/gi, '_');
  logPromptFrame(
    logger,
    buildPromptFrame({
      promptFamily: 'cortex_activation',
      surface: resolveViventiumSurface(req),
      provider: providerName,
      model,
      authClass: 'user_runtime',
      layers: {
        activation_system: ACTIVATION_SYSTEM_PROMPT,
        activation_prompt: fullPrompt,
      },
      promptSourceFiles: {
        background_cortex_service: __filename,
      },
      flags: {
        has_abort_signal: !!abortController?.signal,
      },
      decisionState: {
        agent_id_hash: hashString(agentId, 12),
      },
    }),
  );

  const run = await Run.create({
    runId: `${runId}-activation-${agentId}-${runIdSuffix}`,
    graphConfig: {
      type: 'standard',
      llmConfig,
      tools: [],
      instructions: ACTIVATION_SYSTEM_PROMPT,
    },
    returnContent: true,
  });

  const config = {
    runName: 'CortexActivation',
    configurable: {
      thread_id: runId,
    },
    streamMode: 'values',
    recursionLimit: 5,
    version: 'v2',
    signal: abortController?.signal,
  };

  const { HumanMessage } = require('@langchain/core/messages');
  const inputMessages = [new HumanMessage(fullPrompt)];
  const content = await run.processStream({ messages: inputMessages }, config);

  let responseText = '';
  if (typeof content === 'string') {
    responseText = content;
  } else if (Array.isArray(content)) {
    responseText = content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
  } else if (content?.text) {
    responseText = content.text;
  }

  return {
    responseText,
    parsed: parseActivationResponse(responseText),
  };
}

/**
 * Run activation detection for a single cortex using @librechat/agents Run
 * @param {object} params
 * @param {object} params.cortexConfig - Background cortex configuration { agent_id, activation }
 * @param {Array} params.messages - Current conversation messages
 * @param {string} params.runId - Unique run ID
 * @param {object} [params.req] - Express request object (required for custom endpoints)
 * @returns {Promise<{ shouldActivate: boolean, confidence: number, reason: string, agentId: string }>}
 */
async function checkCortexActivation({
  cortexConfig,
  messages,
  runId,
  req,
  mainAgent = null,
  timeoutMs = 0,
}) {
  const { agent_id, activation } = cortexConfig;

  if (!activation?.enabled) {
    return { shouldActivate: false, confidence: 0, reason: 'disabled', agentId: agent_id };
  }

  const {
    prompt: activationPrompt,
    model = 'meta-llama/llama-4-scout-17b-16e-instruct', // Default to Llama 4 Scout on Groq (750 tps, best speed/instruction-following)
    provider = 'groq', // Default to Groq for cost-effectiveness
    fallbacks = [],
    confidence_threshold = 0.7,
    max_history = 5,
    cooldown_ms = 0,
  } = activation;

  // Enforce per-user cooldown before spending an LLM call.
  const cooldownMs = Number(cooldown_ms) || 0;
  if (cooldownMs > 0) {
    const cooldownKey = buildActivationCooldownKey({ agentId: agent_id, req, runId });
    const lastActivatedAt = activationCooldowns.get(cooldownKey);
    if (typeof lastActivatedAt === 'number' && Date.now() - lastActivatedAt < cooldownMs) {
      return { shouldActivate: false, confidence: 0, reason: 'cooldown', agentId: agent_id };
    }
  }

  const appConfig = req?.config || (req ? await getAppConfig({ role: req.user?.role }) : null);
  if (req && appConfig) {
    req.config = appConfig;
  }

  /* === VIVENTIUM NOTE ===
   * Filter cortex content before activation prompts to avoid self-triggering noise.
   */
  const filteredHistoryMessages = Array.isArray(messages)
    ? filterCortexContentFromLangChainMessages(messages)
    : [];
  const activationHistoryMessages = filteredHistoryMessages;
  const history = formatHistoryForActivation(activationHistoryMessages, max_history);
  const latestUserIntentSection = buildLatestUserIntentSection({
    cortexConfig,
    messages: filteredHistoryMessages,
  });
  /* === VIVENTIUM NOTE === */

  /* === VIVENTIUM NOTE ===
   * Provide request metadata (surface/input mode) to activation prompts.
   */
  const requestMetaLines = [];
  const surface = req?.body?.viventiumSurface;
  const inputMode = req?.body?.viventiumInputMode;
  if (typeof surface === 'string' && surface.trim()) {
    requestMetaLines.push(`Surface: ${surface.trim()}`);
  }
  if (typeof inputMode === 'string' && inputMode.trim()) {
    requestMetaLines.push(`InputMode: ${inputMode.trim()}`);
  }
  const requestMetaSection = requestMetaLines.length
    ? `## Request Metadata:\n${requestMetaLines.join('\n')}\n\n`
    : '';
  /* === VIVENTIUM NOTE === */

  // Build the activation prompt
  const activationFormat = getActivationFormat(appConfig);
  const activationPolicy = buildActivationPolicySection({ config: appConfig, mainAgent });
  const activationDecisionSubject = buildActivationDecisionSubjectSection({ config: appConfig });
  const fullPrompt = `## Cortex Activation Criteria:
${activationPolicy.section}
${activationDecisionSubject}
${activationPrompt}

${requestMetaSection}${latestUserIntentSection}## Recent Conversation:
${history}

${activationFormat}`;

  if (shouldLogActivationPrompt()) {
    logger.info(
      `[BackgroundCortexService] Activation prompt summary for ${agent_id}: ${promptDebugSummaryLabel(fullPrompt)}`,
    );
    logger.info(
      `[BackgroundCortexService] Activation format for ${agent_id}: ` +
        `format_summary=${promptDebugSummaryLabel(JSON.stringify(activationFormat || {}))}, ` +
        `brew_begin_tag_hash=${hashString(
          appConfig?.viventium?.background_cortices?.activation_format?.brew_begin_tag || '',
          12,
        )}`,
    );
  }

  // === VIVENTIUM START ===
  // Feature: Voice-first activation timeout cancellation.
  // Purpose: Respect Phase A time budget without leaving runaway activation LLM calls in flight.
  const activationTimeoutMs = Number.isFinite(Number(timeoutMs))
    ? Math.max(0, Number(timeoutMs))
    : 0;
  // === VIVENTIUM END ===

  try {
    const startTime = Date.now();
    const attempts = buildActivationProviderAttempts({ provider, model, fallbacks });
    const providerAttempts = [];
    const suppressionsByAttempt = attempts.map((attempt) =>
      getActivationProviderSuppression({
        provider: String(attempt.provider || '')
          .trim()
          .toLowerCase(),
        model: attempt.model,
        req,
      }),
    );
    const allAttemptsSuppressed =
      attempts.length > 0 && suppressionsByAttempt.every((entry) => Boolean(entry));
    let suppressionProbeUsed = false;

    for (let i = 0; i < attempts.length; i += 1) {
      const attempt = attempts[i];
      const providerName = attempt.provider.toLowerCase();
      const providerSuppression = suppressionsByAttempt[i];

      if (providerSuppression) {
        if (shouldAttemptSuppressedActivationProvider({ attempt, providerSuppression })) {
          logger.warn(
            `[BackgroundCortexService] Activation classifier attempting primary provider despite health suppression for ${agent_id}: ` +
              `provider=${providerName}, model=${attempt.model}, source=${attempt.source}, ` +
              formatActivationErrorSummaryForLog(providerSuppression.error),
          );
        } else {
          const shouldProbeSuppression = shouldProbeSuppressedActivationAttempt({
            providerSuppression,
            attempts,
            allAttemptsSuppressed,
            probeAlreadyUsed: suppressionProbeUsed,
          });
          if (shouldProbeSuppression) {
            suppressionProbeUsed = true;
            logger.warn(
              `[BackgroundCortexService] Activation classifier probing suppressed provider for ${agent_id}: ` +
                `provider=${providerName}, model=${attempt.model}, source=${attempt.source}, ` +
                formatActivationErrorSummaryForLog(providerSuppression.error),
            );
          } else {
            const retryAfterMs = Math.max(0, providerSuppression.until - Date.now());
            providerAttempts.push({
              provider: providerName,
              model: attempt.model,
              source: attempt.source,
              status: 'skipped_unhealthy',
              error: providerSuppression.error,
              retryAfterMs,
            });
            logger.warn(
              `[BackgroundCortexService] Activation classifier skipped unhealthy provider for ${agent_id}: ` +
                `provider=${providerName}, model=${attempt.model}, source=${attempt.source}, ` +
                `retry_after_ms=${retryAfterMs}, ` +
                formatActivationErrorSummaryForLog(providerSuppression.error),
            );
            continue;
          }
        }
      }

      const attemptTimeoutMs = activationAttemptTimeoutMs({
        activationTimeoutMs,
        activationStartTime: startTime,
        attemptIndex: i,
        attemptsLength: attempts.length,
      });
      if (activationTimeoutMs > 0 && attemptTimeoutMs <= 0) {
        return {
          shouldActivate: false,
          confidence: 0,
          reason: 'global_timeout',
          agentId: agent_id,
          providerAttempts,
        };
      }

      let attemptAbortController = null;
      let attemptAbortTimer = null;
      try {
        if (attemptTimeoutMs > 0) {
          attemptAbortController = new AbortController();
          attemptAbortTimer = setTimeout(() => {
            try {
              attemptAbortController.abort();
            } catch (_) {
              // Ignore abort races; the attempt timeout already records the failure path.
            }
          }, attemptTimeoutMs);
        }
        const { responseText, parsed } = await invokeActivationClassifierAttempt({
          agentId: agent_id,
          providerName,
          model: attempt.model,
          fullPrompt,
          runId,
          req,
          abortController: attemptAbortController,
        });

        if (shouldLogActivationPrompt()) {
          logger.info(
            `[BackgroundCortexService] Activation raw response for ${agent_id} ` +
              `(${providerName}/${attempt.model}): ${promptDebugSummaryLabel(responseText)}`,
          );
        }

        const shouldActivate = parsed.activate && parsed.confidence >= confidence_threshold;
        const duration = Date.now() - startTime;
        providerAttempts.push({
          provider: providerName,
          model: attempt.model,
          source: attempt.source,
          status: 'completed',
          activate: parsed.activate,
          shouldActivate,
          confidence: parsed.confidence,
          reason: parsed.reason,
        });

        logger.info(
          `[BackgroundCortexService] Activation check for ${agent_id}: ` +
            `provider=${providerName}, model=${attempt.model}, source=${attempt.source}, ` +
            `activate=${parsed.activate}, confidence=${parsed.confidence.toFixed(2)}, ` +
            `threshold=${confidence_threshold}, duration=${duration}ms, reason="${parsed.reason}"`,
        );

        if (shouldActivate && cooldownMs > 0) {
          const cooldownKey = buildActivationCooldownKey({ agentId: agent_id, req, runId });
          activationCooldowns.set(cooldownKey, Date.now());
        }

        return {
          shouldActivate,
          confidence: parsed.confidence,
          reason: parsed.reason,
          agentId: agent_id,
          directActionSurfaces: activationPolicy.connectedSurfaces
            .map((surface) => surface.server)
            .filter(Boolean),
          directActionSurfaceScopes: activationPolicy.connectedSurfaces
            .filter((surface) => surface.scopeKey)
            .map((surface) => ({
              server: surface.server,
              scopeKey: surface.scopeKey,
              owns: surface.owns,
              sameScopeBackgroundAllowed: surface.sameScopeBackgroundAllowed === true,
            })),
          providerUsed: providerName,
          modelUsed: attempt.model,
          providerAttempts,
        };
      } catch (error) {
        const isAborted =
          attemptAbortController?.signal?.aborted === true || error?.name === 'AbortError';
        if (isAborted) {
          const errorSummary = activationTimeoutErrorSummary();
          providerAttempts.push({
            provider: providerName,
            model: attempt.model,
            source: attempt.source,
            status: 'error',
            error: sanitizeActivationErrorForLog(errorSummary),
            markedUnhealthy: false,
            timeoutMs: attemptTimeoutMs,
          });
          logger.info(
            `[BackgroundCortexService] Activation classifier attempt timed out for ${agent_id}: ` +
              `provider=${providerName}, model=${attempt.model}, source=${attempt.source}, ` +
              `attempt_timeout_ms=${attemptTimeoutMs}, global_timeout_ms=${activationTimeoutMs}`,
          );
          const canTryFallback =
            i < attempts.length - 1 &&
            (activationTimeoutMs <= 0 || Date.now() - startTime < activationTimeoutMs);
          if (canTryFallback) {
            logger.warn(
              `[BackgroundCortexService] Activation classifier timed out; trying fallback for ${agent_id}: ` +
                `provider=${providerName}, model=${attempt.model}, source=${attempt.source}, ` +
                `next_provider=${attempts[i + 1].provider}, next_model=${attempts[i + 1].model}`,
            );
            continue;
          }
          return {
            shouldActivate: false,
            confidence: 0,
            reason: 'global_timeout',
            agentId: agent_id,
            providerAttempts,
          };
        }

        const errorSummary = summarizeActivationError(error);
        const markedUnhealthy = markActivationProviderUnhealthy({
          provider: providerName,
          model: attempt.model,
          errorSummary,
          req,
        });
        providerAttempts.push({
          provider: providerName,
          model: attempt.model,
          source: attempt.source,
          status: 'error',
          error: sanitizeActivationErrorForLog(errorSummary),
          markedUnhealthy,
        });

        const shouldRetry = i < attempts.length - 1 && isActivationFallbackCandidate(error);
        if (shouldRetry) {
          logger.warn(
            `[BackgroundCortexService] Activation classifier failed for ${agent_id}; trying fallback: ` +
              `provider=${providerName}, model=${attempt.model}, source=${attempt.source}, ` +
              `${formatActivationErrorSummaryForLog(errorSummary)}, ` +
              `marked_unhealthy=${markedUnhealthy}, ` +
              `next_provider=${attempts[i + 1].provider}, next_model=${attempts[i + 1].model}`,
            {
              provider: providerName,
              model: attempt.model,
              error: sanitizeActivationErrorForLog(errorSummary),
              nextProvider: attempts[i + 1].provider,
              nextModel: attempts[i + 1].model,
            },
          );
          continue;
        }

        if (errorSummary.class === 'provider_access_denied') {
          logger.warn(
            `[BackgroundCortexService] Activation classifier access denied for ${agent_id}. ` +
              'Check provider account/network egress before retrying activation.',
            {
              provider: providerName,
              model: attempt.model,
              status: errorSummary.status,
              code: errorSummary.code,
            },
          );
        }

        if (activationProviderAttemptsUnavailable(providerAttempts)) {
          logger.error(
            `[BackgroundCortexService] Activation providers unavailable for ${agent_id}`,
            sanitizeActivationErrorForLog(errorSummary),
          );
          return {
            shouldActivate: false,
            confidence: 0,
            reason: 'provider_unavailable',
            agentId: agent_id,
            providerAttempts,
          };
        }

        logger.error(
          `[BackgroundCortexService] Activation check failed for ${agent_id}`,
          sanitizeActivationErrorForLog(errorSummary),
        );
        return {
          shouldActivate: false,
          confidence: 0,
          reason: errorSummary.class || 'provider_error',
          agentId: agent_id,
          providerAttempts,
        };
      } finally {
        if (attemptAbortTimer) {
          clearTimeout(attemptAbortTimer);
        }
      }
    }

    return {
      shouldActivate: false,
      confidence: 0,
      reason: providerAttempts.some((attempt) => attempt.status === 'skipped_unhealthy')
        ? 'provider_unavailable'
        : 'error',
      agentId: agent_id,
      providerAttempts,
    };
  } catch (error) {
    // === VIVENTIUM START ===
    // Feature: Normalize aborted activation checks to timeout reason for Phase A accounting.
    const isAborted = error?.name === 'AbortError';
    if (isAborted) {
      logger.info(
        `[BackgroundCortexService] Activation check timed out for ${agent_id} after ${activationTimeoutMs}ms`,
      );
      return { shouldActivate: false, confidence: 0, reason: 'global_timeout', agentId: agent_id };
    }
    // === VIVENTIUM END ===
    logger.error(
      `[BackgroundCortexService] Activation check failed for ${agent_id}`,
      sanitizeRuntimeErrorForLog(error),
    );
    return { shouldActivate: false, confidence: 0, reason: 'error', agentId: agent_id };
  }
}

/**
 * Execute a single cortex agent and collect its response
 * @param {object} params
 * @param {object} params.agent - Loaded cortex agent
 * @param {Array} params.messages - Conversation messages to provide context
 * @param {string} params.runId - Unique run ID
 * @param {object} [params.req] - Express request object (required for custom endpoints and tool loading)
 * @param {object} [params.res] - Express response object (for tool streaming if needed)
 * @returns {Promise<{ agentId: string, agentName: string, insight: string }>}
 */
async function executeCortex({ agent, messages, runId, req, res, activationScope = null }) {
  const startTime = Date.now();
  /** @type {AbortController | null} */
  let abortController = null;
  /** @type {NodeJS.Timeout | null} */
  let abortTimer = null;

  try {
    const safeReq = req || { body: {}, user: {} };
    safeReq.body = safeReq.body || {};
    safeReq.user = safeReq.user || {};
    safeReq.config = safeReq.config || (await getAppConfig({ role: safeReq.user?.role }));

    const providerName = (agent.provider || '').toLowerCase();
    const agentForRun = {
      ...agent,
      model_parameters: agent.model_parameters ? { ...agent.model_parameters } : undefined,
      tools: Array.isArray(agent.tools) ? [...agent.tools] : agent.tools,
    };
    if (activationScope) {
      agentForRun.activation = {
        ...(agentForRun.activation || {}),
        intent_scope: activationScope,
      };
    }
    const productivityScope = resolveProductivitySpecialistScope(agentForRun) || null;
    const isolateProductivityContext = shouldIsolateProductivitySpecialistContext(agentForRun, {
      scope: productivityScope,
    });
    const latestUserText = getLatestUserText(messages);

    /* === VIVENTIUM NOTE ===
     * Feature: Fresh-request execution envelope for productivity specialist cortices.
     *
     * Why:
     * - Google/MS365 tool specialists should act on the current request, not stale assistant claims.
     * - When the latest user turn already contains Google Docs/Drive links, surface extracted file IDs
     *   so the specialist prefers direct retrieval instead of brittle search-by-ID guesses.
     */
    const productivityRuntimeInstructions = buildProductivitySpecialistRuntimeInstructions({
      agent: agentForRun,
      latestUserText,
      scope: productivityScope,
    });
    if (productivityRuntimeInstructions) {
      agentForRun.instructions = [agentForRun.instructions || '', productivityRuntimeInstructions]
        .filter((part) => typeof part === 'string' && part.trim().length > 0)
        .join('\n\n');
    }
    /* === VIVENTIUM NOTE === */

    /* === VIVENTIUM NOTE ===
     * Feature: Time context parity for background cortices
     * Purpose: Provide the same canonical local time context to cortices as the main agent.
     */
    const timeContextInstructions = buildTimeContextInstructions(safeReq);
    if (timeContextInstructions) {
      agentForRun.instructions = [agentForRun.instructions || '', timeContextInstructions]
        .filter((part) => typeof part === 'string' && part.trim().length > 0)
        .join('\n\n');
    }
    /* === VIVENTIUM NOTE === */

    /* === VIVENTIUM NOTE ===
     * Feature: Attached file context parity for background cortices
     * Purpose: If the request contains extracted text attachments (FileSources.text),
     *          inject the same file context that the main agent receives via BaseClient.
     */
    const fileContextBlock = await getUserFileContextBlock(safeReq);
    if (fileContextBlock) {
      agentForRun.instructions = [agentForRun.instructions || '', fileContextBlock]
        .filter((part) => typeof part === 'string' && part.trim().length > 0)
        .join('\n\n');
    }
    /* === VIVENTIUM NOTE === */

    /* === VIVENTIUM NOTE ===
     * Memory context parity: inject existing user memory into cortex instructions.
     *
     * Note: This mirrors the main agent behavior (AgentClient.buildMessages → useMemory()) but
     * does NOT run memory updates for cortex outputs (only reads existing memory for context).
     */
    const memoryContextBlock = isolateProductivityContext
      ? ''
      : await getUserMemoryContextBlock(safeReq);
    if (memoryContextBlock) {
      agentForRun.instructions = [agentForRun.instructions || '', memoryContextBlock]
        .filter((part) => typeof part === 'string' && part.trim().length > 0)
        .join('\n\n');
    }
    /* === VIVENTIUM NOTE === */

    /* === VIVENTIUM NOTE ===
     * Feature: File search tool parity for background cortices
     * Purpose: If the user attached files, ensure cortices can call `file_search` just like the main agent.
     *
     * Note: This does not grant access to new files; it only enables the tool if the user already
     * attached/loaded files in the request context.
     */
    const hasRequestFiles = Array.isArray(safeReq.body?.files) && safeReq.body.files.length > 0;
    const autoFileSearchEnabled =
      (process.env.VIVENTIUM_CORTEX_AUTO_FILE_SEARCH || '1').trim() !== '0';
    if (autoFileSearchEnabled && hasRequestFiles && Array.isArray(agentForRun.tools)) {
      if (!agentForRun.tools.includes(Tools.file_search)) {
        agentForRun.tools.push(Tools.file_search);
      }
    }
    /* === VIVENTIUM NOTE === */

    /* === VIVENTIUM NOTE ===
     * Feature: Surface-aware output rules for cortex insights.
     */
    const surface = resolveViventiumSurface(safeReq);
    const inputMode = (safeReq.body?.viventiumInputMode || '').toString().toLowerCase();
    const voiceMode = safeReq.body?.voiceMode === true;
    const cortexOutputRules = buildCortexOutputInstructions({ voiceMode, surface, inputMode });
    if (cortexOutputRules) {
      agentForRun.instructions = [agentForRun.instructions || '', cortexOutputRules]
        .filter((part) => typeof part === 'string' && part.trim().length > 0)
        .join('\n\n');
    }
    /* === VIVENTIUM NOTE === */

    /* === VIVENTIUM NOTE ===
     * Feature: No Response Tag ({NTA}) prompt injection (env-gated, config-driven).
     *
     * Purpose:
     * - Give background cortices a consistent, global instruction block so they can respond with
     *   `{NTA}` when they intentionally have nothing to add.
     */
    const noResponseInstructions = buildNoResponseInstructions(safeReq);
    if (noResponseInstructions) {
      agentForRun.instructions = [agentForRun.instructions || '', noResponseInstructions]
        .filter((part) => typeof part === 'string' && part.trim().length > 0)
        .join('\n\n');
    }
    /* === VIVENTIUM NOTE === */

    if (providerName === 'anthropic') {
      sanitizeAnthropicThinkingTemperature(agentForRun, safeReq);
    }

    if (
      providerName === 'openai' ||
      providerName === 'open_ai' ||
      providerName === 'azure_openai'
    ) {
      sanitizeOpenAIReasoningSampling(agentForRun, safeReq);
    }

    if (providerName === 'perplexity') {
      if (agentForRun.model_parameters) {
        delete agentForRun.model_parameters.temperature;
      }
      if (Array.isArray(agentForRun.tools)) {
        agentForRun.tools = agentForRun.tools.filter((tool) => {
          const name = typeof tool === 'string' ? tool : tool?.name || tool?.type;
          return name !== Tools.web_search && name !== 'web_search';
        });
      }
      if (safeReq.body) {
        delete safeReq.body.temperature;
      }
      safeReq.body.web_search = false;
    }

    const safeRes = res || createBackgroundRes();
    const streamId = null;

    const collectedUsage = [];
    const artifactPromises = [];
    const { contentParts, aggregateContent: rawAggregateContent } = createContentAggregator();
    const aggregateContent = (event) => {
      rawAggregateContent(event);
      sanitizeAggregatedContentParts(contentParts);
    };
    const toolExecutionState = {
      completed: 0,
      names: new Set(),
    };
    const baseToolEndCallback = createToolEndCallback({
      req: safeReq,
      res: safeRes,
      artifactPromises,
      streamId,
    });
    const toolEndCallback = async (data, metadata) => {
      const output = data?.output;
      if (output?.tool_call_id || output?.name) {
        toolExecutionState.completed += 1;
        if (output?.name) {
          toolExecutionState.names.add(String(output.name));
        }
      }
      return baseToolEndCallback(data, metadata);
    };

    abortController = new AbortController();
    const executionTimeoutMs = getCortexExecutionTimeoutMs();
    if (executionTimeoutMs > 0) {
      abortTimer = setTimeout(() => {
        try {
          abortController?.abort();
        } catch (_e) {
          // Ignore abort errors; we just need the run to unwind.
        }
      }, executionTimeoutMs);
    }
    const loadTools = createToolLoader(abortController.signal, streamId);
    const allowedProviders = new Set(
      safeReq.config?.endpoints?.[EModelEndpoint.agents]?.allowedProviders,
    );

    const initializedAgent = await initializeAgent(
      {
        req: safeReq,
        res: safeRes,
        loadTools,
        signal: abortController.signal,
        streamId,
        requestFiles: safeReq.body.files ?? [],
        conversationId: safeReq.body.conversationId ?? null,
        agent: agentForRun,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders,
        isInitialAgent: true,
      },
      {
        getConvoFiles,
        getFiles: db.getFiles,
        getUserKey: db.getUserKey,
        updateUserKey: db.updateUserKey,
        updateFilesUsage: db.updateFilesUsage,
        getUserKeyValues: db.getUserKeyValues,
        getToolFilesByIds: db.getToolFilesByIds,
        getLatestRecallEligibleMessageCreatedAt: db.getLatestRecallEligibleMessageCreatedAt,
      },
    );

    /* === VIVENTIUM START ===
     * Feature: Post-hydration Anthropic temperature stripping for background cortices.
     * Purpose: initializeAgent can materialize provider defaults (including thinking) after the
     * raw source-of-truth agent was copied, so rerun the compatibility guard on the final config.
     * === VIVENTIUM END === */
    if ((initializedAgent.provider || agentForRun.provider || '').toLowerCase() === 'anthropic') {
      sanitizeAnthropicThinkingTemperature(initializedAgent, safeReq);
    }
    {
      const initializedProvider = (
        initializedAgent.provider ||
        agentForRun.provider ||
        ''
      ).toLowerCase();
      if (
        initializedProvider === 'openai' ||
        initializedProvider === 'open_ai' ||
        initializedProvider === 'azure_openai'
      ) {
        sanitizeOpenAIReasoningSampling(initializedAgent, safeReq);
      }
    }

    /* === VIVENTIUM NOTE ===
     * Feature: Event-driven tool execution for background cortices.
     *
     * Why:
     * - LibreChat agents use event-driven tool loading (definitionsOnly=true):
     *   initializeAgent loads only tool definitions during setup, then the LangGraph
     *   runtime fires ON_TOOL_EXECUTE when the LLM generates a tool call.
     * - The ON_TOOL_EXECUTE handler calls toolExecuteOptions.loadTools to create
     *   the actual tool instance (with MCP connection, OAuth, etc.) on demand.
     * - Without toolExecuteOptions, getDefaultHandlers never registers the
     *   ON_TOOL_EXECUTE handler, so tool calls silently drop into the void:
     *   the LLM asks to call a tool, nothing happens, 180s timeout fires.
     *
     * Fix:
     * - After initializeAgent returns the agent config (including toolRegistry,
     *   userMCPAuthMap), store these in a context map.
     * - Create toolExecuteOptions.loadTools that calls loadToolsForExecution
     *   with the stored context (mirrors initializeClient in initialize.js).
     * - Pass toolExecuteOptions to getDefaultHandlers so ON_TOOL_EXECUTE is
     *   registered and tools actually execute in background cortex mode.
     */
    const agentToolContexts = new Map();
    agentToolContexts.set(initializedAgent.id, {
      agent: agentForRun,
      toolRegistry: initializedAgent.toolRegistry,
      userMCPAuthMap: initializedAgent.userMCPAuthMap,
      tool_resources: initializedAgent.tool_resources,
    });

    const toolExecuteOptions = {
      loadTools: async (toolNames, agentId) => {
        const ctx = agentToolContexts.get(agentId) ?? {};
        logger.debug(
          `[BackgroundCortex][ON_TOOL_EXECUTE] agentId=${agentId} tools=${toolNames?.length} ctx=${!!ctx.userMCPAuthMap}`,
        );
        const result = await loadToolsForExecution({
          req: safeReq,
          res: safeRes,
          signal: abortController.signal,
          streamId,
          toolNames,
          agent: ctx.agent,
          toolRegistry: ctx.toolRegistry,
          userMCPAuthMap: ctx.userMCPAuthMap,
          tool_resources: ctx.tool_resources,
        });
        logger.debug(
          `[BackgroundCortex][ON_TOOL_EXECUTE] loaded ${result.loadedTools?.length ?? 0} tools`,
        );
        return result;
      },
      toolEndCallback,
    };
    /* === VIVENTIUM NOTE END === */

    const eventHandlers = getDefaultHandlers({
      req: safeReq,
      res: safeRes,
      aggregateContent,
      toolEndCallback,
      collectedUsage,
      streamId,
      toolExecuteOptions,
    });

    const lastUserMessage = getLastUserMessageText(messages);
    // Messages are already LangChain objects (from @librechat/agents formatAgentMessages).
    // Filter cortex content types directly from their content arrays.
    /* === VIVENTIUM NOTE ===
     * Ensure background agents keep full message metadata and never receive empty input.
     */
    const filteredMessages =
      Array.isArray(messages) && messages.length > 0
        ? filterCortexContentFromLangChainMessages(messages)
        : [];
    const scopedMessages = filteredMessages;
    const inputMessages =
      Array.isArray(scopedMessages) && scopedMessages.length > 0
        ? scopedMessages
        : [
            new (require('@langchain/core/messages').HumanMessage)(
              lastUserMessage || 'Analyze the latest conversation and respond.',
            ),
          ];

    /* === VIVENTIUM START ===
     * Root-cause fix: apply strict-provider sanitization on background inputs.
     *
     * Why:
     * - Background paths can inherit historical malformed/empty text blocks.
     * - Strict providers (Anthropic) reject these with:
     *   "messages: text content blocks must be non-empty".
     *
     * Behavior:
     * - Reuse the shared provider sanitizer policy before processStream.
     * - No-op for providers that do not require strict sanitization.
     * === VIVENTIUM END === */
    const providerSafeInputMessages = sanitizeProviderFormattedMessages(
      initializedAgent.provider || agent.provider,
      inputMessages,
    );
    /* === VIVENTIUM NOTE === */
    logPromptFrame(
      logger,
      buildPromptFrame({
        promptFamily: 'cortex_execution',
        surface,
        provider: initializedAgent.provider || agentForRun.provider,
        model:
          initializedAgent.model_parameters?.model ||
          initializedAgent.model ||
          agentForRun.model_parameters?.model ||
          agentForRun.model,
        authClass: initializedAgent.userMCPAuthMap ? 'connected_account_runtime' : 'user_runtime',
        layers: {
          cortex_instructions: initializedAgent.instructions || agentForRun.instructions || '',
          productivity_runtime_instructions: productivityRuntimeInstructions || '',
          time_context: timeContextInstructions || '',
          file_context: fileContextBlock || '',
          memory_context: memoryContextBlock || '',
          cortex_output_rules: cortexOutputRules || '',
          no_response_instructions: noResponseInstructions || '',
          formatted_input_messages: providerSafeInputMessages,
        },
        promptSourceFiles: {
          background_cortex_service: __filename,
        },
        flags: {
          voice_mode: voiceMode,
          input_mode: inputMode,
          productivity_context_isolated: isolateProductivityContext,
          has_request_files: hasRequestFiles,
          no_response_injected: !!noResponseInstructions,
          tool_count: Array.isArray(initializedAgent.tools) ? initializedAgent.tools.length : 0,
        },
        decisionState: {
          activation_scope_present: !!activationScope,
          productivity_scope_present: !!productivityScope,
          agent_id_hash: hashString(agent?.id, 12),
        },
        voiceText: initializedAgent.instructions || agentForRun.instructions || '',
      }),
    );

    /* === VIVENTIUM NOTE ===
     * Enable built-in Run pruning by providing tokenCounter/indexTokenCountMap.
     */
    const tokenCounter = createTokenCounter();
    const indexTokenCountMap = buildIndexTokenCountMap(providerSafeInputMessages, tokenCounter);
    /* === VIVENTIUM NOTE === */

    /* === VIVENTIUM NOTE ===
     * Feature: Disable streaming for Anthropic background cortices.
     * Reason: Anthropic SDK streaming can emit control characters that break JSON parsing in background runs.
     */
    const cortexProvider = (initializedAgent.provider || '').toLowerCase();
    const disableStreaming = cortexProvider === 'anthropic';
    const runOptions = {
      agents: [initializedAgent],
      runId: `${runId}-cortex-${agent.id}`,
      signal: abortController.signal,
      customHandlers: eventHandlers,
      requestBody: safeReq.body,
      user: safeReq.user,
      /* Provide token counter/context map for context window management. */
      tokenCounter,
      indexTokenCountMap,
    };
    if (disableStreaming) {
      runOptions.streaming = false;
      runOptions.streamUsage = false;
    }
    const run = await createRun(runOptions);
    /* === VIVENTIUM NOTE === */

    if (!run) {
      throw new Error('Failed to create cortex run');
    }

    const config = {
      runName: 'CortexExecution',
      configurable: {
        thread_id: runId,
        user_id: safeReq.user?.id,
        requestBody: {
          messageId: runId,
          conversationId: safeReq.body.conversationId,
          parentMessageId: safeReq.body.parentMessageId,
        },
        user: safeReq.user,
      },
      recursionLimit: initializedAgent.recursion_limit || 25,
      signal: abortController.signal,
      streamMode: 'values',
      version: 'v2',
    };

    if (initializedAgent.userMCPAuthMap != null) {
      config.configurable.userMCPAuthMap = initializedAgent.userMCPAuthMap;
    }

    const content = await run.processStream({ messages: providerSafeInputMessages }, config);
    const duration = Date.now() - startTime;

    const aggregatedText = contentParts
      .filter((part) => part?.type === 'text')
      .map((part) => part.text || '')
      .join('');

    let insight = aggregatedText.trim();
    if (!insight) {
      if (typeof content === 'string') {
        insight = content;
      } else if (Array.isArray(content)) {
        insight = content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('');
      } else if (content?.text) {
        insight = content.text;
      }
    }
    /* === VIVENTIUM NOTE ===
     * Feature: Prefer user-facing summaries when cortex outputs structured JSON.
     */
    const extractedInsight = extractUserFacingInsight(insight);
    if (extractedInsight) {
      insight = extractedInsight;
    }
    /* === VIVENTIUM NOTE === */

    /* === VIVENTIUM NOTE ===
     * Feature: No Response Tag ({NTA}) suppression for cortex insights.
     *
     * Purpose:
     * - If a cortex intentionally returns `{NTA}` (or strict no-response-only variants),
     *   treat it as "no insight" so it doesn't show up in UI cards or merged follow-ups.
     */
    if (isNoResponseOnly(insight)) {
      insight = '';
    }
    /* === VIVENTIUM NOTE === */

    if (isolateProductivityContext && insight.trim() && toolExecutionState.completed === 0) {
      logger.warn(
        `[BackgroundCortexService] Suppressing unverified productivity insight for ${agent.id}; ` +
          'no live tools completed in this run',
        {
          agentId: agent.id,
          latestUserTextHash: hashString(latestUserText, 12),
        },
      );
      return {
        agentId: agent.id,
        agentName: agent.name || agent.id,
        insight: null,
        error: 'no_live_tool_execution',
        errorClass: 'no_live_tool_execution',
      };
    }

    if (!insight.trim() && shouldRetryBackgroundCortexContentPartsWithFallback(contentParts)) {
      const providerErrorText =
        extractAggregatedProviderErrorText(contentParts) || 'recoverable_provider_error';
      const publicProviderError = publicCortexError(providerErrorText);
      logger.warn(
        `[BackgroundCortexService] Cortex ${agent.id} produced recoverable provider error before insight: ` +
          publicProviderError.errorClass,
      );
      return {
        agentId: agent.id,
        agentName: agent.name || agent.id,
        insight: null,
        error: publicProviderError.message,
        errorClass: publicProviderError.errorClass,
        recoverableProviderError: true,
        activationScope,
        configuredTools: initializedAgent.tools?.length || 0,
        completedToolCalls: toolExecutionState.completed || 0,
      };
    }

    logger.info(
      `[BackgroundCortexService] Cortex ${agent.name || agent.id} executed in ${duration}ms ` +
        `(configured_tools: ${initializedAgent.tools?.length || 0}, completed_tool_calls: ${toolExecutionState.completed})`,
    );

    return {
      agentId: agent.id,
      agentName: agent.name || agent.id,
      insight: insight.trim(),
      activationScope,
      configuredTools: initializedAgent.tools?.length || 0,
      completedToolCalls: toolExecutionState.completed || 0,
    };
  } catch (error) {
    const isAborted = abortController?.signal?.aborted === true || error?.name === 'AbortError';
    const publicError = publicCortexError(error, isAborted ? 'timeout' : '');
    // Log provider/model context for faster diagnosis (do NOT log api keys).
    logger.error(
      `[BackgroundCortexService] Cortex execution failed for ${agent.id} ` +
        `(provider=${agent.provider || 'unknown'}, model=${agent.model || agent.model_parameters?.model || 'unknown'}):`,
      sanitizeRuntimeErrorForLog(error, publicError.errorClass),
    );
    return {
      agentId: agent.id,
      agentName: agent.name || agent.id,
      insight: null,
      error: publicError.message,
      errorClass: publicError.errorClass,
      errorStatus: extractCortexErrorStatus(error, error?.message || ''),
      errorCode: extractCortexErrorCode(error, error?.message || ''),
    };
  } finally {
    if (abortTimer) {
      clearTimeout(abortTimer);
    }
  }
}

/**
 * Phase A: Detect which cortices should activate (with 2s total timeout)
 * @param {object} params
 * @param {object} params.req - Express request object
 * @param {object} params.mainAgent - The main agent
 * @param {Array} params.messages - Current conversation messages
 * @param {string} params.runId - Unique run ID
 * @param {Function} [params.onActivationStart] - Callback when activation check starts
 * @param {Function} [params.onCortexSkipped] - Callback when cortex skipped
 * @param {number} [params.timeBudgetMs=2000] - Total time budget in milliseconds
 * @returns {Promise<{ activatedCortices: Array, timedOut: boolean, duration: number }>}
 */
async function detectActivations({
  req,
  mainAgent,
  messages,
  runId,
  onActivationStart,
  onCortexSkipped,
  timeBudgetMs = 2000,
  activationRunner = checkCortexActivation,
}) {
  const backgroundCortices = mainAgent.background_cortices || [];

  if (!backgroundCortices.length) {
    logVoicePhaseAStage(req, 'activation_detect_skipped', null, 'reason=no_background_cortices');
    return { activatedCortices: [], timedOut: false, duration: 0 };
  }

  const startTime = Date.now();
  const deadline = startTime + timeBudgetMs;
  logVoicePhaseAStage(
    req,
    'activation_detect_start',
    startTime,
    `cortex_count=${backgroundCortices.length} budget_ms=${timeBudgetMs}`,
  );

  // Best-effort: start loading cortex agent metadata (name/description) without blocking Phase A.
  // We will only wait for metadata up to the remaining global budget.
  const metaLoadStartAt = Date.now();
  const metaById = new Map();
  const resolvedMetaById = new Map();
  const cortexConfigById = new Map();
  for (const cortexConfig of backgroundCortices) {
    const agentId = cortexConfig.agent_id;
    cortexConfigById.set(agentId, cortexConfig);
    metaById.set(
      agentId,
      loadAgent({ req, agent_id: agentId, endpoint: mainAgent.provider })
        .then((meta) => {
          if (meta) {
            resolvedMetaById.set(agentId, meta);
          }
          return meta;
        })
        .catch(() => null),
    );
  }
  logVoicePhaseAStage(
    req,
    'activation_meta_preload_started',
    metaLoadStartAt,
    `cortex_count=${metaById.size}`,
  );

  const timeLeftMs = () => Math.max(0, deadline - Date.now());
  const activationPolicyMainAgent = await resolveActivationPolicyMainAgent({
    req,
    mainAgent,
    timeoutMs: Math.min(250, timeLeftMs()),
  });

  const activationPromises = backgroundCortices.map(async (cortexConfig) => {
    const agentId = cortexConfig.agent_id;
    const activationScope = resolveConfiguredProductivityActivationScopeKey(cortexConfig);
    const cortexCheckStartAt = Date.now();

    // Emit activation check started (UI)
    if (onActivationStart) {
      try {
        onActivationStart({
          cortex_id: agentId,
          cortex_name: agentId, // will be improved later if metadata loads
          status: 'activating',
        });
      } catch (e) {
        logger.warn(
          '[BackgroundCortexService] onActivationStart callback failed',
          sanitizeRuntimeErrorForLog(e),
        );
      }
    }

    // Hard deadline wrapper: do not await past global budget.
    const timeoutMs = timeLeftMs();
    const timeoutResult = {
      shouldActivate: false,
      confidence: 0,
      reason: 'global_timeout',
      agentId,
      activationScope,
    };

    if (timeoutMs <= 0) {
      const doneAt = Date.now();
      logVoicePhaseAStage(
        req,
        'activation_check_done',
        cortexCheckStartAt,
        `agent_id=${agentId} activate=false reason=global_timeout confidence=0.00 timeout_budget_ms=0`,
      );
      return { ...timeoutResult, durationMs: doneAt - cortexCheckStartAt, timeoutBudgetMs: 0 };
    }

    try {
      logVoicePhaseAStage(
        req,
        'activation_check_start',
        cortexCheckStartAt,
        `agent_id=${agentId} timeout_budget_ms=${timeoutMs}`,
      );
      let timeoutId = null;
      const timeoutSentinel = Symbol(`activation_timeout_${agentId}`);
      const result = await Promise.race([
        Promise.resolve().then(() =>
          activationRunner({
            cortexConfig,
            messages,
            runId,
            req,
            mainAgent: activationPolicyMainAgent,
            timeoutMs,
          }),
        ),
        new Promise((resolve) => {
          timeoutId = setTimeout(() => resolve(timeoutSentinel), timeoutMs);
        }),
      ]);
      if (timeoutId != null) {
        clearTimeout(timeoutId);
      }

      if (result === timeoutSentinel) {
        const doneAt = Date.now();
        logVoicePhaseAStage(
          req,
          'activation_check_done',
          cortexCheckStartAt,
          `agent_id=${agentId} activate=false reason=global_timeout confidence=0.00 timeout_budget_ms=${timeoutMs}`,
        );
        return {
          ...timeoutResult,
          durationMs: doneAt - cortexCheckStartAt,
          timeoutBudgetMs: timeoutMs,
        };
      }

      if (!result || typeof result !== 'object') {
        const doneAt = Date.now();
        logVoicePhaseAStage(
          req,
          'activation_check_done',
          cortexCheckStartAt,
          `agent_id=${agentId} activate=false reason=invalid_result confidence=0.00 timeout_budget_ms=${timeoutMs}`,
        );
        return {
          ...timeoutResult,
          reason: 'invalid_result',
          durationMs: doneAt - cortexCheckStartAt,
          timeoutBudgetMs: timeoutMs,
        };
      }

      const durationMs = Date.now() - cortexCheckStartAt;
      const shouldActivate = Boolean(result.shouldActivate);
      const confidence = Number(result.confidence) || 0;
      const reason = String(result.reason || '');
      const directActionSurfaces = Array.isArray(result.directActionSurfaces)
        ? result.directActionSurfaces.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
      const directActionSurfaceScopes = normalizeDirectActionSurfaceScopes(
        result.directActionSurfaceScopes,
      );
      const directActionScopeKeys = directActionSurfaceScopes
        .map((surface) => surface.scopeKey)
        .filter(Boolean);
      logVoicePhaseAStage(
        req,
        'activation_check_done',
        cortexCheckStartAt,
        `agent_id=${agentId} activate=${shouldActivate} reason=${reason || 'none'} ` +
          `confidence=${confidence.toFixed(2)} timeout_budget_ms=${timeoutMs} ` +
          `direct_action_surfaces=${directActionSurfaces.join(',') || 'none'} ` +
          `direct_action_scope_keys=${directActionScopeKeys.join(',') || 'none'}`,
      );

      return {
        shouldActivate,
        confidence,
        reason,
        agentId,
        activationScope,
        directActionSurfaces,
        directActionSurfaceScopes,
        providerAttempts: Array.isArray(result.providerAttempts) ? result.providerAttempts : [],
        durationMs,
        timeoutBudgetMs: timeoutMs,
      };
    } catch (error) {
      const publicError = publicCortexError(error?.message || error);
      logger.error(
        `[BackgroundCortexService] Activation check failed for ${agentId}`,
        sanitizeRuntimeErrorForLog(error, publicError.errorClass),
      );
      logVoicePhaseAStage(
        req,
        'activation_check_error',
        cortexCheckStartAt,
        `agent_id=${agentId} reason=${publicError.errorClass}`,
      );
      return {
        shouldActivate: false,
        confidence: 0,
        reason: 'error',
        agentId,
        activationScope,
        durationMs: Date.now() - cortexCheckStartAt,
        timeoutBudgetMs: timeoutMs,
      };
    }
  });

  // Collect results (all wrappers resolve by deadline)
  const activationCollectStartAt = Date.now();
  const rawActivationResults = await Promise.all(activationPromises);
  const activationResults = rawActivationResults.map(applyDirectActionOwnershipGate);
  logVoicePhaseAStage(
    req,
    'activation_collect_done',
    activationCollectStartAt,
    `results=${activationResults.length} direct_action_suppressed=${
      activationResults.filter((r) => r?.suppressedByDirectActionOwnership === true).length
    }`,
  );

  // Attach best-effort metadata to every result. When all activation providers
  // are unavailable, this also lets us surface explicit, user-named configured
  // agents as terminal error cards instead of silently dropping visibility.
  const remainingForMetaMs = timeLeftMs();
  const metaAttachStartAt = Date.now();
  const activationResultsWithMeta = await Promise.all(
    activationResults.map(async (r) => {
      const cortexConfig = cortexConfigById.get(r.agentId);
      let cortexName = configuredCortexDisplayName(cortexConfig) || r.agentId;
      let cortexDescription = '';

      const resolvedMeta = resolvedMetaById.get(r.agentId);
      if (resolvedMeta) {
        cortexName = sanitizeCortexDisplayName(resolvedMeta.name || cortexName);
        cortexDescription = String(resolvedMeta.description || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 220);
      }
      const metaPromise = metaById.get(r.agentId);
      if (!resolvedMeta && metaPromise && remainingForMetaMs > 0) {
        try {
          const meta = await Promise.race([
            metaPromise,
            new Promise((resolve) => setTimeout(() => resolve(null), remainingForMetaMs)),
          ]);
          if (meta) {
            cortexName = sanitizeCortexDisplayName(meta.name || cortexName);
            cortexDescription = String(meta.description || '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 220);
          }
        } catch (e) {
          logger.debug(
            '[BackgroundCortexService] Failed to load cortex metadata',
            sanitizeRuntimeErrorForLog(e),
          );
        }
      }

      const shouldSurfaceUnavailable = shouldSurfaceActivationProviderUnavailable({
        activationResult: r,
        cortexConfig,
      });
      const shouldSurfaceTimeout = shouldSurfaceActivationTimeout({
        activationResult: r,
        cortexConfig,
      });
      const shouldSurfaceTerminal = shouldSurfaceUnavailable || shouldSurfaceTimeout;

      return {
        ...r,
        shouldActivate: shouldSurfaceTerminal ? true : r.shouldActivate,
        confidence: shouldSurfaceTerminal ? 0 : r.confidence,
        reason: shouldSurfaceUnavailable ? 'activation_provider_unavailable' : r.reason,
        activationProviderUnavailable: shouldSurfaceUnavailable === true,
        activationTimedOut: shouldSurfaceTimeout === true,
        errorClass: shouldSurfaceUnavailable
          ? 'activation_provider_unavailable'
          : shouldSurfaceTimeout
            ? 'timeout'
            : r.errorClass,
        cortexName,
        cortexDescription,
      };
    }),
  );
  logVoicePhaseAStage(
    req,
    'activation_meta_attach_done',
    metaAttachStartAt,
    `results=${activationResultsWithMeta.length} activated=${
      activationResultsWithMeta.filter((r) => r?.shouldActivate === true).length
    } unavailable_visible=${
      activationResultsWithMeta.filter((r) => r?.activationProviderUnavailable === true).length
    } remaining_budget_ms=${remainingForMetaMs}`,
  );
  const timedOut = activationResultsWithMeta.some((r) => r.reason === 'global_timeout');

  // Notify skipped ones (includes timeouts)
  if (onCortexSkipped) {
    for (const r of activationResultsWithMeta) {
      if (r.shouldActivate) {
        continue;
      }
      try {
        onCortexSkipped({
          cortex_id: r.agentId,
          cortex_name: r.cortexName || r.agentId,
          status: 'skipped',
          confidence: r.confidence,
          reason: r.reason,
        });
      } catch (e) {
        logger.warn(
          '[BackgroundCortexService] onCortexSkipped callback failed',
          sanitizeRuntimeErrorForLog(e),
        );
      }
    }
  }

  // Build activated list
  const activated = activationResultsWithMeta.filter((r) => r.shouldActivate);
  const withMeta = activated.map((r) => ({
    agentId: r.agentId,
    cortexName: r.cortexName || r.agentId,
    cortexDescription: r.cortexDescription || '',
    activationScope: r.activationScope || null,
    directActionSurfaces: Array.isArray(r.directActionSurfaces) ? r.directActionSurfaces : [],
    directActionSurfaceScopes: normalizeDirectActionSurfaceScopes(r.directActionSurfaceScopes),
    confidence: r.confidence,
    reason: r.reason,
    activationProviderUnavailable: r.activationProviderUnavailable === true,
    activationTimedOut: r.activationTimedOut === true,
    errorClass: r.errorClass || null,
    durationMs: Number.isFinite(r.durationMs) ? r.durationMs : null,
    timeoutBudgetMs: Number.isFinite(r.timeoutBudgetMs) ? r.timeoutBudgetMs : null,
  }));

  const duration = Date.now() - startTime;
  const sortedDurations = activationResultsWithMeta
    .map((r) => ({
      agentId: r.agentId,
      durationMs: Number.isFinite(r.durationMs) ? r.durationMs : null,
      reason: r.reason || 'none',
      shouldActivate: r.shouldActivate === true,
    }))
    .filter((item) => Number.isFinite(item.durationMs))
    .sort((a, b) => b.durationMs - a.durationMs);
  const topDurations = sortedDurations
    .slice(0, 5)
    .map(
      (item) =>
        `${item.agentId}:${item.durationMs}:${item.shouldActivate ? 'on' : 'off'}:${item.reason}`,
    )
    .join(',');
  const timeoutCount = activationResultsWithMeta.filter(
    (r) => r.reason === 'global_timeout',
  ).length;
  const activatedCount = activationResultsWithMeta.filter((r) => r.shouldActivate === true).length;
  const reasonCounts = activationResultsWithMeta.reduce((acc, r) => {
    const key = r.reason || 'none';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const reasonSummary = Object.entries(reasonCounts)
    .map(([reason, count]) => `${reason}:${count}`)
    .join(',');
  logVoicePhaseAStage(
    req,
    'activation_detect_done',
    startTime,
    `total=${activationResults.length} activated=${activatedCount} timed_out=${timeoutCount} ` +
      `reasons=${reasonSummary || 'none'} top_slowest=${topDurations || 'none'}`,
  );

  logger.info(
    `[BackgroundCortexService] Activation detection complete: ${withMeta.length}/${backgroundCortices.length} activated ` +
      `(duration: ${duration}ms, timedOut: ${timedOut})`,
  );

  return { activatedCortices: withMeta, timedOut, duration };
}

/**
 * Phase B: Execute activated cortices and collect insights (non-blocking)
 * @param {object} params
 * @param {object} params.req - Express request object
 * @param {object} params.res - Express response object (for tool streaming)
 * @param {object} params.mainAgent - The main agent
 * @param {Array} params.messages - Current conversation messages
 * @param {string} params.runId - Unique run ID
 * @param {Array} params.activatedCortices - Results from detectActivations()
 * @param {Function} [params.onCortexBrewing] - Callback when cortex starts executing
 * @param {Function} [params.onCortexComplete] - Callback when cortex completes
 * @param {Function} [params.onAllComplete] - Callback when ALL cortices complete with merged insights
 * @returns {Promise<{ insights: Array }>}
 */
async function executeActivated({
  req,
  res,
  mainAgent,
  messages,
  runId,
  activatedCortices,
  onCortexBrewing,
  onCortexComplete,
  onAllComplete,
}) {
  if (!activatedCortices.length) {
    return { insights: [] };
  }

  const executionTimeoutMs = getCortexExecutionTimeoutMs();
  let modelsConfigPromise = null;
  const getModelsConfigOnce = () => {
    if (!modelsConfigPromise) {
      modelsConfigPromise = loadModelsConfigForCortexFallback(req).catch((error) => {
        logger.warn(
          '[BackgroundCortexService] Failed to load models config for cortex fallback',
          sanitizeRuntimeErrorForLog(error),
        );
        return null;
      });
    }
    return modelsConfigPromise;
  };
  const runCortexWithGuard = async ({ agent, activationResult }) => {
    const cortexPromise = executeCortex({
      agent,
      messages,
      runId,
      req,
      res,
      activationScope: activationResult.activationScope || null,
    });
    const guardTimeoutMs = getCortexAttemptGuardTimeoutMs(executionTimeoutMs);
    if (!guardTimeoutMs) {
      return cortexPromise;
    }
    let timeoutId = null;
    const timeoutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        resolve({
          agentId: activationResult.agentId,
          agentName: agent.name || activationResult.agentId,
          insight: null,
          error: 'timeout',
        });
      }, guardTimeoutMs);
    });
    const result = await Promise.race([cortexPromise, timeoutPromise]);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    return result;
  };

  // Execute all activated cortices in parallel
  const executionPromises = activatedCortices.map(async (activationResult) => {
    try {
      // Load the cortex agent
      const cortexAgent = await loadAgent({
        req,
        agent_id: activationResult.agentId,
        endpoint: mainAgent.provider,
      });

      if (!cortexAgent) {
        logger.warn(
          `[BackgroundCortexService] Cortex agent not found: ${activationResult.agentId}`,
        );
        if (onCortexComplete) {
          try {
            onCortexComplete(
              buildCortexCompletionPayload(
                buildCompletionInputFromActivation({
                  activationResult,
                  error: 'Cortex agent not found',
                }),
              ),
            );
          } catch (e) {
            logger.warn(
              '[BackgroundCortexService] onCortexComplete missing-agent callback failed',
              sanitizeRuntimeErrorForLog(e),
            );
          }
        }
        return null;
      }

      // Notify UI that cortex is brewing
      if (onCortexBrewing) {
        try {
          onCortexBrewing({
            cortex_id: activationResult.agentId,
            cortex_name: sanitizeCortexDisplayName(cortexAgent.name || activationResult.agentId),
            status: 'brewing',
            confidence: activationResult.confidence,
            reason: activationResult.reason,
          });
        } catch (e) {
          logger.warn(
            '[BackgroundCortexService] onCortexBrewing callback failed',
            sanitizeRuntimeErrorForLog(e),
          );
        }
      }

      if (
        activationResult.activationProviderUnavailable === true ||
        activationResult.activationTimedOut === true
      ) {
        const terminalError =
          activationResult.activationProviderUnavailable === true
            ? 'activation_provider_unavailable'
            : 'timeout';
        const unavailableResult = {
          agentId: activationResult.agentId,
          agentName: cortexAgent.name || activationResult.cortexName || activationResult.agentId,
          insight: null,
          error: terminalError,
          errorClass: activationResult.errorClass || terminalError,
          activationScope: activationResult.activationScope || null,
          configuredTools: Array.isArray(cortexAgent.tools) ? cortexAgent.tools.length : 0,
          completedToolCalls: 0,
        };
        if (onCortexComplete) {
          try {
            onCortexComplete(
              buildCortexCompletionPayload(
                buildCompletionInputFromActivation({
                  activationResult,
                  cortexAgent,
                  result: unavailableResult,
                }),
              ),
            );
          } catch (e) {
            logger.warn(
              '[BackgroundCortexService] onCortexComplete provider-unavailable callback failed',
              sanitizeRuntimeErrorForLog(e),
            );
          }
        }
        return unavailableResult;
      }

      const fallbackAgent = resolveFallbackAssignment(cortexAgent)
        ? await resolveBackgroundCortexFallbackAgent({
            cortexAgent,
            req,
            modelsConfig: await getModelsConfigOnce(),
          })
        : null;

      /** @type {any} */
      let result;
      try {
        result = await runCortexWithGuard({ agent: cortexAgent, activationResult });
      } catch (error) {
        const publicError = publicCortexError(error);
        logger.error(
          `[BackgroundCortexService] Cortex execution failed for ${activationResult.agentId} ` +
            `before fallback: class=${publicError.errorClass}`,
        );
        logger.debug(
          '[BackgroundCortexService] Primary cortex execution failure detail',
          sanitizeRuntimeErrorForLog(error, publicError.errorClass),
        );
        result = {
          agentId: activationResult.agentId,
          agentName: cortexAgent.name || activationResult.cortexName || activationResult.agentId,
          insight: null,
          error: publicError.message,
          errorClass: publicError.errorClass,
          activationScope: activationResult.activationScope || null,
          configuredTools: Array.isArray(cortexAgent.tools) ? cortexAgent.tools.length : 0,
          completedToolCalls: 0,
        };
      }
      if (fallbackAgent && shouldRetryBackgroundCortexWithFallback(result)) {
        const primaryProvider = cortexAgent.provider || 'unknown';
        const primaryModel = cortexAgent.model || cortexAgent.model_parameters?.model || 'unknown';
        const fallbackProvider = fallbackAgent.provider || 'unknown';
        const fallbackModel =
          fallbackAgent.model || fallbackAgent.model_parameters?.model || 'unknown';
        const primaryError = result?.error || 'unknown';
        const publicPrimaryError = publicCortexError(
          primaryError,
          result?.errorClass || result?.error_class,
        );
        logger.warn(
          `[BackgroundCortexService] Cortex ${activationResult.agentId} primary ` +
            `${primaryProvider}/${primaryModel} failed before insight (${publicPrimaryError.errorClass}); ` +
            `retrying fallback ${fallbackProvider}/${fallbackModel}`,
        );
        const fallbackResult = await runCortexWithGuard({ agent: fallbackAgent, activationResult });
        result = {
          ...fallbackResult,
          fallbackUsed: true,
          fallbackProvider,
          fallbackModel,
          primaryProvider,
          primaryModel,
          primaryError: publicPrimaryError.message,
          primaryErrorClass: publicPrimaryError.errorClass,
        };
      }

      const completionPayload = buildCortexCompletionPayload(
        buildCompletionInputFromActivation({ activationResult, cortexAgent, result }),
      );
      if (completionPayload && onCortexComplete) {
        try {
          onCortexComplete(completionPayload);
        } catch (e) {
          logger.warn(
            '[BackgroundCortexService] onCortexComplete callback failed',
            sanitizeRuntimeErrorForLog(e),
          );
        }
      }

      return result;
    } catch (error) {
      const rawError = error?.message || 'Cortex execution failed';
      const publicError = publicCortexError(error || rawError);
      logger.error(
        `[BackgroundCortexService] Failed to execute cortex ${activationResult.agentId}: ` +
          `class=${publicError.errorClass}`,
      );
      logger.debug(
        '[BackgroundCortexService] Cortex execution failure detail',
        sanitizeRuntimeErrorForLog(error, publicError.errorClass),
      );

      // Notify UI of error so it doesn't stay stuck on "Analyzing..."
      if (onCortexComplete) {
        try {
          onCortexComplete(
            buildCortexCompletionPayload(
              buildCompletionInputFromActivation({
                activationResult,
                error: publicError.message,
                errorClass: publicError.errorClass,
              }),
            ),
          );
        } catch (e) {
          logger.warn(
            '[BackgroundCortexService] onCortexComplete error callback failed',
            sanitizeRuntimeErrorForLog(e),
          );
        }
      }

      return {
        agentId: activationResult.agentId,
        agentName: activationResult.cortexName || activationResult.agentId,
        insight: null,
        error: publicError.message,
        errorClass: publicError.errorClass,
      };
    }
  });

  /* === VIVENTIUM NOTE ===
   * Use Promise.allSettled to guarantee we collect ALL results even if an
   * individual cortex promise rejects unexpectedly (belt-and-suspenders safety
   * on top of the per-cortex try/catch).  Settled results are unwrapped so
   * downstream code stays unchanged.
   */
  const settledResults = await Promise.allSettled(executionPromises);
  const executionResults = settledResults.map((s) => {
    if (s.status === 'fulfilled') {
      return s.value;
    }
    // Should never happen (each promise has its own try/catch), but handle gracefully.
    logger.error(
      '[BackgroundCortexService] Unexpected cortex promise rejection',
      sanitizeRuntimeErrorForLog(s.reason),
    );
    const publicError = publicCortexError(s.reason || 'Unexpected rejection');
    return {
      agentId: 'unknown',
      agentName: 'unknown',
      insight: null,
      error: publicError.message,
      errorClass: publicError.errorClass,
    };
  });

  // Collect and merge insights
  const insights = executionResults
    .filter((r) => r && hasVisibleCortexInsight(r.insight))
    .map((r) => ({
      cortexId: r.agentId,
      cortexName: sanitizeCortexDisplayName(r.agentName),
      insight: r.insight,
      activationScope: r.activationScope || null,
      configured_tools: r.configuredTools || 0,
      completed_tool_calls: r.completedToolCalls || 0,
    }));

  // Collect errors for reporting
  const errors = executionResults
    .filter((r) => r && r.error)
    .map((r) => {
      const publicError = publicCortexError(r, r.errorClass || r.error_class);
      return {
        cortexId: r.agentId,
        cortexName: sanitizeCortexDisplayName(r.agentName),
        error: publicError.message,
        error_class: publicError.errorClass,
      };
    });
  const silentCompletions = executionResults.filter(
    (r) => r && !r.error && !hasVisibleCortexInsight(r.insight),
  ).length;

  logger.info(
    `[BackgroundCortexService] Execution complete: ${insights.length}/${activatedCortices.length} visible insights, ${silentCompletions} silent completions, ${errors.length} errors`,
  );

  // Notify when ALL complete - fire even if no insights (to trigger follow-up with error info)
  if (onAllComplete) {
    try {
      if (insights.length > 0) {
        // Normal case: insights available
        const mergedInsights = formatInsightsForContext(insights);
        onAllComplete({
          insights,
          mergedPrompt: mergedInsights,
          cortexCount: insights.length,
          errors: errors.length > 0 ? errors : undefined,
        });
      } else if (errors.length > 0) {
        // Error case: no insights but errors occurred.
        // Keep mergedPrompt empty to avoid storing/propagating user-visible system strings.
        onAllComplete({
          insights: [],
          mergedPrompt: '',
          cortexCount: 0,
          errors,
          hasErrors: true,
        });
      } else {
        // A cortex may intentionally complete with no user-visible output ({NTA}).
        logger.info(
          `[BackgroundCortexService] Background execution finished with no visible insights (${silentCompletions} silent completions)`,
        );
        onAllComplete({
          insights: [],
          mergedPrompt: '', // Empty but defined - follow-up check will handle this
          cortexCount: 0,
          hasErrors: false,
        });
      }
    } catch (e) {
      logger.warn(
        '[BackgroundCortexService] onAllComplete callback failed',
        sanitizeRuntimeErrorForLog(e),
      );
    }
  }

  return { insights };
}

/**
 * Main entry point: Process background cortices for an agent
 * @param {object} params
 * @param {object} params.req - Express request object
 * @param {object} params.mainAgent - The main/frontal agent
 * @param {Array} params.messages - Current conversation messages (formatted for LLM)
 * @param {string} params.runId - Unique run ID for this conversation turn
 * @param {Function} [params.onActivationStart] - Callback when activation check starts for a cortex
 * @param {Function} [params.onCortexBrewing] - Callback when cortex activation succeeds and execution begins
 * @param {Function} [params.onCortexComplete] - Callback when cortex execution completes with insight
 * @param {Function} [params.onCortexSkipped] - Callback when cortex activation fails threshold
 * @returns {Promise<{ activatedCortices: Array, insights: Array }>}
 */
async function processBackgroundCortices({
  req,
  mainAgent,
  messages,
  runId,
  onActivationStart,
  onCortexBrewing,
  onCortexComplete,
  onCortexSkipped,
}) {
  const backgroundCortices = mainAgent.background_cortices || [];

  if (!backgroundCortices.length) {
    return { activatedCortices: [], insights: [] };
  }

  logger.info(
    `[BackgroundCortexService] Processing ${backgroundCortices.length} background cortices for agent ${mainAgent.name || mainAgent.id}`,
  );

  // Phase 0: Pre-load cortex agent names for better UI display
  const cortexNameMap = new Map();
  await Promise.all(
    backgroundCortices.map(async (cortexConfig) => {
      try {
        const cortexAgent = await loadAgent({
          req,
          agent_id: cortexConfig.agent_id,
          endpoint: mainAgent.provider,
        });
        if (cortexAgent) {
          cortexNameMap.set(cortexConfig.agent_id, cortexAgent.name || cortexConfig.agent_id);
        }
      } catch (e) {
        logger.warn(
          `[BackgroundCortexService] Failed to pre-load cortex name for ${cortexConfig.agent_id}`,
        );
      }
    }),
  );

  // Phase 1: Run activation detection for all cortices in parallel
  const activationPromises = backgroundCortices.map(async (cortexConfig) => {
    // Get the pre-loaded name (or fall back to ID)
    const cortexName = cortexNameMap.get(cortexConfig.agent_id) || cortexConfig.agent_id;

    // Notify UI that activation check is starting
    if (onActivationStart) {
      try {
        onActivationStart({
          cortex_id: cortexConfig.agent_id,
          cortex_name: cortexName,
          status: 'activating',
        });
      } catch (e) {
        logger.warn(
          '[BackgroundCortexService] onActivationStart callback failed',
          sanitizeRuntimeErrorForLog(e),
        );
      }
    }

    try {
      const result = await checkCortexActivation({
        cortexConfig,
        messages,
        runId,
        req,
        mainAgent,
      });
      // Attach the name to the result for later use
      return { ...result, cortexName };
    } catch (error) {
      logger.error(
        `[BackgroundCortexService] Failed to check activation for ${cortexConfig.agent_id}`,
        sanitizeRuntimeErrorForLog(error),
      );
      return {
        shouldActivate: false,
        confidence: 0,
        reason: 'error',
        agentId: cortexConfig.agent_id,
        cortexName,
      };
    }
  });

  const activationResults = await Promise.all(activationPromises);

  // Filter to only activated cortices and notify UI about skipped ones
  const activatedCortices = [];
  for (const result of activationResults) {
    if (result.shouldActivate) {
      activatedCortices.push(result);
    } else if (onCortexSkipped) {
      try {
        onCortexSkipped({
          cortex_id: result.agentId,
          cortex_name: result.cortexName || result.agentId,
          status: 'skipped',
          confidence: result.confidence,
          reason: result.reason,
        });
      } catch (e) {
        logger.warn(
          '[BackgroundCortexService] onCortexSkipped callback failed',
          sanitizeRuntimeErrorForLog(e),
        );
      }
    }
  }

  logger.info(
    `[BackgroundCortexService] Activation results: ${activatedCortices.length}/${backgroundCortices.length} cortices activated`,
  );

  if (!activatedCortices.length) {
    return { activatedCortices: [], insights: [] };
  }

  // Phase 2: Load and execute activated cortices in parallel
  const executionPromises = activatedCortices.map(async (activationResult) => {
    try {
      // Load the cortex agent
      const cortexAgent = await loadAgent({
        req,
        agent_id: activationResult.agentId,
        endpoint: mainAgent.provider,
      });

      if (!cortexAgent) {
        logger.warn(
          `[BackgroundCortexService] Cortex agent not found: ${activationResult.agentId}`,
        );
        if (onCortexComplete) {
          try {
            onCortexComplete(
              buildCortexCompletionPayload(
                buildCompletionInputFromActivation({
                  activationResult,
                  error: 'Cortex agent not found',
                }),
              ),
            );
          } catch (e) {
            logger.warn(
              '[BackgroundCortexService] onCortexComplete missing-agent callback failed',
              sanitizeRuntimeErrorForLog(e),
            );
          }
        }
        return null;
      }

      // Notify UI that cortex is now brewing (activated and executing)
      if (onCortexBrewing) {
        try {
          onCortexBrewing({
            cortex_id: activationResult.agentId,
            cortex_name: sanitizeCortexDisplayName(cortexAgent.name || activationResult.agentId),
            status: 'brewing',
            confidence: activationResult.confidence,
            reason: activationResult.reason,
          });
        } catch (e) {
          logger.warn(
            '[BackgroundCortexService] onCortexBrewing callback failed',
            sanitizeRuntimeErrorForLog(e),
          );
        }
      }

      const result = await executeCortex({
        agent: cortexAgent,
        messages,
        runId,
        req,
        activationScope: activationResult.activationScope || null,
      });

      const completionPayload = buildCortexCompletionPayload(
        buildCompletionInputFromActivation({ activationResult, cortexAgent, result }),
      );
      if (completionPayload && onCortexComplete) {
        try {
          onCortexComplete(completionPayload);
        } catch (e) {
          logger.warn(
            '[BackgroundCortexService] onCortexComplete callback failed',
            sanitizeRuntimeErrorForLog(e),
          );
        }
      }

      return result;
    } catch (error) {
      const rawError = error?.message || 'Cortex execution failed';
      const publicError = publicCortexError(rawError);
      logger.error(
        `[BackgroundCortexService] Failed to execute cortex ${activationResult.agentId}: ` +
          `class=${publicError.errorClass}`,
      );
      logger.debug(
        '[BackgroundCortexService] Cortex execution failure detail',
        sanitizeRuntimeErrorForLog(error, publicError.errorClass),
      );

      // Notify UI of error so it doesn't stay stuck on "Analyzing..."
      if (onCortexComplete) {
        try {
          onCortexComplete(
            buildCortexCompletionPayload(
              buildCompletionInputFromActivation({
                activationResult,
                error: rawError,
              }),
            ),
          );
        } catch (e) {
          logger.warn(
            '[BackgroundCortexService] onCortexComplete error callback failed',
            sanitizeRuntimeErrorForLog(e),
          );
        }
      }

      return null;
    }
  });

  /* === VIVENTIUM NOTE === Promise.allSettled for defensive safety (mirrors executeActivated) */
  const settledResults = await Promise.allSettled(executionPromises);
  const executionResults = settledResults.map((s) => (s.status === 'fulfilled' ? s.value : null));

  // Filter out failed executions and null insights
  const insights = executionResults
    .filter((r) => r && hasVisibleCortexInsight(r.insight))
    .map((r) => ({
      cortexId: r.agentId,
      cortexName: sanitizeCortexDisplayName(r.agentName),
      insight: r.insight,
      activationScope: r.activationScope || null,
      configured_tools: r.configuredTools || 0,
      completed_tool_calls: r.completedToolCalls || 0,
    }));

  logger.info(
    `[BackgroundCortexService] Collected ${insights.length} insights from activated cortices`,
  );

  // Debug: Log actual insight content
  insights.forEach(({ cortexName, insight }) => {
    logger.debug(
      `[BackgroundCortexService] Insight summary from ${cortexName}: len=${String(insight || '').length} hash=${hashString(insight, 12)}`,
    );
  });

  return {
    activatedCortices: activatedCortices.map((a) => ({
      agentId: a.agentId,
      activationScope: a.activationScope || null,
      directActionSurfaces: Array.isArray(a.directActionSurfaces) ? a.directActionSurfaces : [],
      directActionSurfaceScopes: normalizeDirectActionSurfaceScopes(a.directActionSurfaceScopes),
      cortexName: a.cortexName,
      confidence: a.confidence,
      reason: a.reason,
    })),
    insights,
  };
}

/**
 * Format insights for injection into main agent context
 * @param {Array<{ cortexName: string, insight: string }>} insights
 * @returns {string}
 */
function formatInsightsForContext(insights) {
  if (!insights || !insights.length) {
    return '';
  }

  const formattedInsights = insights
    .map(({ cortexName, insight }) => `### ${cortexName}\n${insight}`)
    .join('\n\n');

  return `
## Background Agent Insights
The following insights were generated by background agents analyzing this conversation:

${formattedInsights}

---
Consider these insights in your response, but do not explicitly mention them unless directly relevant and new.
`;
}

module.exports = {
  sanitizeCortexDisplayName,
  mapProvider,
  getCustomEndpointConfig,
  clearActivationCooldowns,
  detectActivations, // NEW: Phase A - Activation detection with timeout
  executeActivated, // NEW: Phase B - Execute activated cortices with merging
  processBackgroundCortices, // Keep for backward compat (deprecated)
  formatInsightsForContext,
  checkCortexActivation,
  executeCortex,
  parseActivationResponse,
  formatHistoryForActivation,
  buildActivationPolicySection,
  buildActivationDecisionSubjectSection,
  applyActivationJsonMode,
  resolveActivationPolicyMainAgent,
  normalizeDirectActionScopeKey,
  normalizeDirectActionSurfaceScopes,
  applyDirectActionOwnershipGate,
  normalizeAgentToolNames,
  hasVisibleCortexInsight,
  buildCortexCompletionPayload,
  summarizeActivationError,
  classifyActivationError,
  buildActivationLlmConfig,
  buildActivationProviderAttempts,
  getCortexAttemptGuardTimeoutMs,
  resolveBackgroundCortexFallbackAgent,
  sanitizeOpenAIReasoningSampling,
  buildActivationCooldownKey,
  clearActivationProviderHealth,
  getActivationProviderSuppression,
  markActivationProviderUnhealthy,
  shouldAttemptSuppressedActivationProvider,
  shouldProbeSuppressedActivationAttempt,
  activationProviderAttemptsUnavailable,
  activationFailureVisibility,
  shouldSurfaceActivationProviderUnavailable,
  shouldSurfaceActivationTimeout,
  deriveCortexDisplayNameFromAgentId,
  configuredCortexDisplayName,
  ACTIVATION_SYSTEM_PROMPT,
  DEFAULT_ACTIVATION_DECISION_SUBJECT_RULE,
  // Exported for unit testing only
  createBackgroundRes,
};
