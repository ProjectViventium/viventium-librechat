/* === VIVENTIUM START ===
 * Feature: Prompt-frame telemetry for prompt architecture QA.
 * Purpose:
 * - Emit metadata-only prompt-layer observability around real LLM call sites.
 * - Keep raw prompt text out of normal logs and public QA artifacts.
 * - Support local-only redacted prompt debugging when explicitly enabled.
 * Added: 2026-05-07
 * === VIVENTIUM END === */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_ENV = 'VIVENTIUM_PROMPT_FRAME_LOG';
const DEBUG_ENV = 'VIVENTIUM_PROMPT_FRAME_DEBUG';
const DEBUG_LOCAL_ENV = 'VIVENTIUM_PROMPT_FRAME_DEBUG_LOCAL';
const DEBUG_CHAR_LIMIT_ENV = 'VIVENTIUM_PROMPT_FRAME_DEBUG_CHAR_LIMIT';
const FILE_LOG_ENV = 'VIVENTIUM_PROMPT_FRAME_FILE_LOG';
const OBSERVABILITY_DIR_ENV = 'VIVENTIUM_PROMPT_OBSERVABILITY_DIR';

const DEFAULT_HASH_LENGTH = 16;
const DEFAULT_DEBUG_CHAR_LIMIT = 2000;
const MAX_DEBUG_CHAR_LIMIT = 250_000;
const MAX_TRACE_LOG_BYTES = 8192;
const PROMPT_FRAME_FALLBACK_REASONS = new Set([
  'none',
  'provider_access_denied',
  'provider_auth_missing',
  'provider_connected_account_reconnect_required',
  'provider_error',
  'provider_invalid_response',
  'provider_network',
  'provider_quota_exhausted',
  'provider_quota_or_billing',
  'provider_rate_limited',
  'provider_response_deadline_exceeded',
  'provider_response_failed',
  'provider_server_error',
  'provider_temporarily_unavailable',
  'provider_timeout',
  'provider_unauthorized',
]);
const NON_VOICE_BRACKET_MARKERS = new Set([
  'email',
  'local_path',
  'numeric_id',
  'object_id',
  'secret',
  'uuid',
  'nta',
]);
const PROMPT_FRAME_LAYERS = Object.freeze([
  'main_instructions',
  'global_no_response',
  'memory_context',
  'viventium_feeling_state',
  'conversation_recall',
  'surface_prompt',
  'mcp_server_instructions',
  'tool_schemas',
  'background_context',
  'cortex_activation',
  'cortex_execution',
  'followup',
  'time_context',
  'unknown',
]);
const PROMPT_FRAME_LAYER_ALIASES = Object.freeze({
  main_instructions: 'main_instructions',
  system: 'main_instructions',
  main: 'main_instructions',
  instructions: 'main_instructions',
  primary_base_instructions: 'main_instructions',
  primary_final_instructions: 'main_instructions',
  additional_agent_base_instructions: 'main_instructions',
  additional_agent_final_instructions: 'main_instructions',
  final_runtime_instructions: 'main_instructions',
  instructions_before_surface_injection: 'main_instructions',
  primary_run_instructions: 'main_instructions',
  additional_run_instructions: 'main_instructions',
  viventium_user_fact_guard: 'main_instructions',
  background_cortex_runtime_card_guard: 'main_instructions',
  global_no_response: 'global_no_response',
  no_response: 'global_no_response',
  no_response_instructions: 'global_no_response',
  memory: 'memory_context',
  memory_context: 'memory_context',
  feelings: 'viventium_feeling_state',
  feeling_state: 'viventium_feeling_state',
  viventium_feeling_state: 'viventium_feeling_state',
  conversation_recall: 'conversation_recall',
  recall_context: 'conversation_recall',
  surface: 'surface_prompt',
  surface_prompt: 'surface_prompt',
  surface_runtime_instructions: 'surface_prompt',
  voice_mode: 'surface_prompt',
  voice_note_input: 'surface_prompt',
  voice_call_input: 'surface_prompt',
  wing_mode: 'surface_prompt',
  telegram_text: 'surface_prompt',
  telegram_audio_output: 'surface_prompt',
  telegram_reply_context: 'surface_prompt',
  voice_gateway_insight_instructions: 'surface_prompt',
  web_text: 'surface_prompt',
  workbench_text: 'surface_prompt',
  scheduled_canonical_output: 'surface_prompt',
  playground_text: 'surface_prompt',
  mcp_server_instructions: 'mcp_server_instructions',
  tool_schemas: 'tool_schemas',
  tools: 'tool_schemas',
  shared_run_context: 'background_context',
  augmented_prompt: 'background_context',
  latest_file_context: 'background_context',
  file_context: 'background_context',
  formatted_input_messages: 'background_context',
  background_context: 'background_context',
  active_work_context: 'background_context',
  rapid_source_selection: 'background_context',
  main_continuity: 'background_context',
  main_context_snapshot: 'background_context',
  recurrence_state: 'background_context',
  activation_system: 'cortex_activation',
  activation_prompt: 'cortex_activation',
  activation_context: 'cortex_activation',
  execution_system: 'cortex_execution',
  execution_prompt: 'cortex_execution',
  cortex_instructions: 'cortex_execution',
  productivity_runtime_instructions: 'cortex_execution',
  cortex_output_rules: 'cortex_execution',
  cortex_execution: 'cortex_execution',
  followup: 'followup',
  followup_system: 'followup',
  followup_prompt: 'followup',
  phase_b_followup: 'followup',
  recent_response: 'followup',
  continuation_context: 'followup',
  user_request: 'followup',
  time_context: 'time_context',
  unknown: 'unknown',
});

const fileHashCache = new Map();
const observedUnknownPromptLayerNames = new Set();
const PROMPT_TRACE_FAMILIES = new Set([
  'main_assembly',
  'main_runtime',
  'main_run_create',
  'cortex_activation',
  'cortex_execution',
  'phase_b_followup',
]);
const PROMPT_TRACE_SURFACES = new Set([
  'web',
  'telegram',
  'voice',
  'workbench',
  'scheduler',
  'playground',
]);
const PROMPT_TRACE_AUTH_CLASSES = new Set(['user_runtime', 'connected_account_runtime']);
const PROMPT_TRACE_FLAG_BOOLEAN_KEYS = new Set([
  'voice_mode',
  'wing_mode',
  'listen_only',
  'primary_response_mode',
  'has_abort_signal',
  'productivity_context_isolated',
  'has_request_files',
  'no_response_injected',
  'use_voice_model',
  'ephemeral_agent',
  'telegram_surface',
  'playground_surface',
  'has_user_mcp_auth_map',
  'background_cortices_enabled',
  'tool_cortex_hold_wanted',
]);
const PROMPT_TRACE_FLAG_NUMBER_KEYS = new Set([
  'agent_count',
  'tool_count',
  'activated_cortex_count',
]);
const PROMPT_TRACE_FLAG_STRING_KEYS = new Set(['input_mode']);
const PROMPT_TRACE_DECISION_BOOLEAN_KEYS = new Set([
  'should_respond',
  'should_follow_up',
  'no_response',
  'tool_cortex_hold_wanted',
]);
const PROMPT_TRACE_DECISION_NUMBER_KEYS = new Set([
  'confidence',
  'activation_count',
  'activated_count',
  'visible_insight_count',
  'silent_count',
  'error_count',
  'raw_insight_count',
  'deduped_insight_count',
]);
const PROMPT_TRACE_DECISION_STRING_KEYS = new Set(['status', 'decision', 'reason_code']);
const PROMPT_TRACE_SOURCE_HASH_KEYS = new Set([
  'agent_source',
  'librechat_source',
  'compiled_runtime_config',
  'live_installed_runtime_config',
  'compiler_version',
]);

function promptLayerIntegritySnapshot() {
  return Object.freeze({
    contractVersion: 1,
    unknownLayerNames: Object.freeze([...observedUnknownPromptLayerNames].sort().slice(0, 128)),
  });
}

function resetPromptLayerIntegrityForTests() {
  observedUnknownPromptLayerNames.clear();
}

function resolveLibreChatRoot() {
  return path.resolve(__dirname, '..', '..', '..', '..');
}

function resolveDefaultPromptSourceFiles() {
  const libreChatRoot = resolveLibreChatRoot();
  const sourceOfTruthRoot = path.join(libreChatRoot, 'viventium', 'source_of_truth');
  const runtimeConfigPath =
    String(process.env.CONFIG_PATH || '').trim() || path.join(libreChatRoot, 'librechat.yaml');
  return {
    agent_source: path.join(sourceOfTruthRoot, 'local.viventium-agents.yaml'),
    librechat_source: path.join(sourceOfTruthRoot, 'local.librechat.yaml'),
    compiled_runtime_config: runtimeConfigPath,
    live_installed_runtime_config: runtimeConfigPath,
  };
}

function stableStringify(value) {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value, (_key, nestedValue) => {
      if (typeof nestedValue === 'bigint') {
        return nestedValue.toString();
      }
      if (typeof nestedValue === 'function') {
        return '[function]';
      }
      if (nestedValue instanceof Error) {
        return {
          name: nestedValue.name,
          message: nestedValue.message,
        };
      }
      return nestedValue;
    });
  } catch (_error) {
    return String(value);
  }
}

function estimatePromptTokens(value) {
  const text = stableStringify(value);
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

function hashString(value, length = DEFAULT_HASH_LENGTH) {
  const text = stableStringify(value);
  if (!text) {
    return 'none';
  }
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, length);
}

function hashFile(filePath, length = DEFAULT_HASH_LENGTH) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return null;
  }
  try {
    const stat = fs.statSync(filePath);
    const cacheKey = `${filePath}:${stat.mtimeMs}:${stat.size}:${length}`;
    const cached = fileHashCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const digest = crypto
      .createHash('sha256')
      .update(fs.readFileSync(filePath))
      .digest('hex')
      .slice(0, length);
    fileHashCache.set(cacheKey, digest);
    return digest;
  } catch (_error) {
    return null;
  }
}

function redactPromptDebugText(value) {
  let text = stableStringify(value);
  if (!text) {
    return '';
  }

  text = text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(
      /(?:file:\/\/)?(?:\/Users|\/home|\/tmp|\/var\/folders|\/private\/var\/folders|\/opt|\/etc)\/[^\r\n"'`<>]+/g,
      '[local_path]',
    )
    .replace(/~\/[^\r\n"'`<>]+/g, '[local_path]')
    .replace(/\b[A-Za-z]:\\[^\r\n"'`<>]+/g, '[local_path]')
    .replace(/\\\\[A-Za-z0-9_.-]+\\[^\r\n"'`<>]+/g, '[local_path]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, 'Bearer [secret]')
    .replace(/\b(?:sk|pk|rk|ghp|gho|github_pat|xox[baprs]?)-[A-Za-z0-9_-]{8,}\b/g, '[secret]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret)=([^&\s"'`<>]+)/gi,
      '$1=[secret]',
    )
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      '[uuid]',
    )
    .replace(/\b[0-9a-f]{24}\b/gi, '[object_id]')
    .replace(/\b\d{10,}\b/g, '[numeric_id]');

  return text;
}

function countMatches(text, regex) {
  const matches = String(text || '').match(regex);
  return matches ? matches.length : 0;
}

function countBracketVoiceMarkers(text) {
  const matches = String(text || '').match(/\[([a-z][a-z0-9_-]{1,32})\]/gi) || [];
  return matches.filter((marker) => {
    const normalized = marker.replace(/^\[|\]$/g, '').toLowerCase();
    return !NON_VOICE_BRACKET_MARKERS.has(normalized);
  }).length;
}

function countVoiceControlMarkers(value) {
  const text = stableStringify(value);
  if (!text) {
    return {
      break_tags: 0,
      prosody_tags: 0,
      say_as_tags: 0,
      emotion_tags: 0,
      total: 0,
    };
  }
  const counts = {
    break_tags: countMatches(text, /<break\b[^>]*>/gi),
    prosody_tags: countMatches(text, /<\/?prosody\b[^>]*>/gi),
    say_as_tags: countMatches(text, /<\/?say-as\b[^>]*>/gi),
    emotion_tags: countBracketVoiceMarkers(text),
  };
  counts.total = counts.break_tags + counts.prosody_tags + counts.say_as_tags + counts.emotion_tags;
  return counts;
}

function normalizeLayers(layers = {}) {
  if (Array.isArray(layers)) {
    return layers.reduce((acc, item, index) => {
      acc[`layer_${index}`] = item;
      return acc;
    }, {});
  }
  if (layers && typeof layers === 'object') {
    return layers;
  }
  return { prompt: layers };
}

function normalizeLayersToContract(layers = {}) {
  const normalized = normalizeLayers(layers);
  const contract = PROMPT_FRAME_LAYERS.reduce((acc, key) => {
    acc[key] = [];
    return acc;
  }, {});
  const unknownLayerNames = [];

  Object.entries(normalized).forEach(([name, value]) => {
    const safeName = String(name || 'layer').replace(/[^a-zA-Z0-9_:-]/g, '_');
    const target = PROMPT_FRAME_LAYER_ALIASES[safeName] || 'unknown';
    if (target === 'unknown') {
      unknownLayerNames.push(safeName);
      contract.unknown.push(`${safeName}:\n${stableStringify(value)}`);
      return;
    }
    contract[target].push(value);
  });

  const rendered = {};
  PROMPT_FRAME_LAYERS.forEach((key) => {
    rendered[key] = contract[key]
      .map((value) => stableStringify(value))
      .filter(Boolean)
      .join('\n\n');
  });
  return { layers: rendered, unknown_layer_names: unknownLayerNames };
}

function summarizeLayers(layers = {}) {
  const normalized = normalizeLayers(layers);
  const tokenEstimates = {};
  const charCounts = {};
  const hashes = {};

  Object.entries(normalized).forEach(([name, value]) => {
    const key = String(name || 'layer').replace(/[^a-zA-Z0-9_:-]/g, '_');
    const text = stableStringify(value);
    tokenEstimates[key] = estimatePromptTokens(text);
    charCounts[key] = text.length;
    hashes[key] = hashString(text);
  });

  return {
    token_estimates: tokenEstimates,
    char_counts: charCounts,
    hashes,
  };
}

function summarizePromptSourceFiles(promptSourceFiles = {}) {
  const sources =
    promptSourceFiles && typeof promptSourceFiles === 'object' ? { ...promptSourceFiles } : {};
  if (process.env.VIVENTIUM_PROMPT_BUNDLE_PATH) {
    sources.compiled_prompt_bundle = process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
  }
  return Object.entries(sources).reduce((acc, [name, filePath]) => {
    const digest = hashFile(filePath);
    if (digest) {
      acc[String(name || 'source').replace(/[^a-zA-Z0-9_:-]/g, '_')] = digest;
    }
    return acc;
  }, {});
}

function buildDefaultSourceHashes(sourceFileHashes = {}) {
  return Object.entries(resolveDefaultPromptSourceFiles()).reduce((acc, [name, filePath]) => {
    const hash = sourceFileHashes[name] || hashFile(filePath);
    if (hash) {
      acc[name] = hash;
    }
    return acc;
  }, {});
}

function normalizeString(value, fallback = 'unknown') {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

/* === VIVENTIUM START ===
 * Feature: Fail-closed prompt-frame execution lineage.
 * Purpose: Carry an exact requested/effective provider-model-effort triple and only a bounded,
 * typed fallback reason. Raw provider errors never enter prompt telemetry or public evidence.
 * === VIVENTIUM END === */
function normalizeRouteEffort(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._:-]{0,31}$/.test(normalized) ? normalized : 'missing';
}

function normalizeFallbackReason(value, fallbackUsed) {
  const normalized = String(value || '').trim().toLowerCase();
  if (fallbackUsed !== true) {
    return normalized && normalized !== 'none' ? 'missing' : 'none';
  }
  return normalized !== 'none' && PROMPT_FRAME_FALLBACK_REASONS.has(normalized)
    ? normalized
    : 'missing';
}

function normalizeFlags(flags = {}) {
  if (!flags || typeof flags !== 'object') {
    return {};
  }
  return Object.entries(flags).reduce((acc, [key, value]) => {
    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
      acc[String(key).replace(/[^a-zA-Z0-9_:-]/g, '_')] = value;
    }
    return acc;
  }, {});
}

function normalizeDecisionState(decisionState = {}) {
  if (!decisionState || typeof decisionState !== 'object') {
    return {};
  }
  return Object.entries(decisionState).reduce((acc, [key, value]) => {
    if (
      value == null ||
      typeof value === 'boolean' ||
      typeof value === 'number' ||
      typeof value === 'string'
    ) {
      acc[String(key).replace(/[^a-zA-Z0-9_:-]/g, '_')] = value;
    }
    return acc;
  }, {});
}

function normalizeMCPInstructionSources(mcpInstructionSources = {}) {
  if (!mcpInstructionSources || typeof mcpInstructionSources !== 'object') {
    return {};
  }
  const allowedSources = new Set(['server_fetched', 'config_inline', 'missing']);
  return Object.entries(mcpInstructionSources).reduce((acc, [serverName, source]) => {
    const key = String(serverName || '').replace(/[^a-zA-Z0-9_.:-]/g, '_');
    if (!key) {
      return acc;
    }
    const normalizedSource = String(source || '').trim();
    acc[key] = allowedSources.has(normalizedSource) ? normalizedSource : 'missing';
    return acc;
  }, {});
}

function shouldIncludeDebugLayers() {
  return process.env[DEBUG_ENV] === '1' && process.env[DEBUG_LOCAL_ENV] === '1';
}

function getDebugCharLimit() {
  const parsed = parseInt(String(process.env[DEBUG_CHAR_LIMIT_ENV] || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DEBUG_CHAR_LIMIT;
  }
  return Math.min(parsed, MAX_DEBUG_CHAR_LIMIT);
}

function buildDebugLayers(layers = {}) {
  const normalized = normalizeLayers(layers);
  const limit = getDebugCharLimit();
  return Object.entries(normalized).reduce((acc, [name, value]) => {
    const redacted = redactPromptDebugText(value);
    acc[String(name || 'layer').replace(/[^a-zA-Z0-9_:-]/g, '_')] =
      redacted.length > limit ? `${redacted.slice(0, limit)}...[truncated]` : redacted;
    return acc;
  }, {});
}

function resolvePromptFrameAgentHash(agentId, decisionState) {
  const actualAgentId = typeof agentId === 'string' ? agentId.trim() : '';
  const decisionHash =
    typeof decisionState?.agent_id_hash === 'string'
      ? decisionState.agent_id_hash.trim().toLowerCase()
      : '';
  const completeDecisionHash = /^[0-9a-f]{16}$/.test(decisionHash);

  if (!actualAgentId) {
    return completeDecisionHash ? decisionHash : 'missing';
  }

  const actualHash = hashString(actualAgentId);
  if (decisionHash && !actualHash.startsWith(decisionHash)) {
    return 'missing';
  }
  return actualHash;
}

function buildPromptFrameRequestIdentityHash({ ownerId, interactionContext } = {}) {
  const normalizedOwnerId = String(ownerId || '').trim();
  const surface = String(interactionContext?.surface || '')
    .trim()
    .toLowerCase();
  const sourceEventId = String(interactionContext?.source_event_id || '').trim();
  if (!normalizedOwnerId || !surface || !sourceEventId) {
    return 'missing';
  }
  return hashString(
    ['viventium.prompt-frame-request.v1', normalizedOwnerId, surface, sourceEventId].join('\0'),
  );
}

function buildPromptFrame({
  promptFamily,
  surface,
  requestedProvider,
  requestedModel,
  requestedEffort,
  provider,
  model,
  reasoningEffort,
  fallbackUsed = false,
  fallbackReason = '',
  agentId,
  requestIdentity,
  authClass = 'unknown',
  layers = {},
  sourceHashes = {},
  promptSourceFiles = {},
  flags = {},
  decisionState = {},
  mcpInstructionSources = {},
  voiceText = '',
} = {}) {
  const normalizedContract = normalizeLayersToContract(layers);
  for (const layerName of normalizedContract.unknown_layer_names) {
    observedUnknownPromptLayerNames.add(layerName);
  }
  const layerSummary = summarizeLayers(normalizedContract.layers);
  const sourceFileHashes = summarizePromptSourceFiles(promptSourceFiles);
  const normalizedSourceHashes =
    sourceHashes && typeof sourceHashes === 'object'
      ? Object.entries(sourceHashes).reduce((acc, [key, value]) => {
          if (typeof value === 'string' && value.trim()) {
            acc[String(key).replace(/[^a-zA-Z0-9_:-]/g, '_')] = value.trim();
          }
          return acc;
        }, {})
      : {};
  const defaultSourceHashes = buildDefaultSourceHashes(sourceFileHashes);
  for (const [key, value] of Object.entries(defaultSourceHashes)) {
    if (!normalizedSourceHashes[key]) {
      normalizedSourceHashes[key] = value;
    }
  }
  if (!normalizedSourceHashes.compiler_version && sourceFileHashes.compiled_prompt_bundle) {
    normalizedSourceHashes.compiler_version = hashString(
      `prompt_bundle:${sourceFileHashes.compiled_prompt_bundle}`,
    );
  }
  for (const requiredSourceHash of [
    'agent_source',
    'librechat_source',
    'compiled_runtime_config',
    'live_installed_runtime_config',
    'compiler_version',
  ]) {
    if (!normalizedSourceHashes[requiredSourceHash]) {
      normalizedSourceHashes[requiredSourceHash] = 'missing';
    }
  }
  const frame = {
    event: 'viventium.prompt_frame',
    version: 1,
    layer_contract_version: 1,
    prompt_family: normalizeString(promptFamily, 'unknown'),
    surface: normalizeString(surface, 'unknown'),
    requested_provider: normalizeString(requestedProvider ?? provider, 'missing'),
    requested_model: normalizeString(requestedModel ?? model, 'missing'),
    requested_effort: normalizeRouteEffort(requestedEffort ?? reasoningEffort),
    provider: normalizeString(provider, 'unknown'),
    model: normalizeString(model, 'unknown'),
    effective_provider: normalizeString(provider, 'missing'),
    effective_model: normalizeString(model, 'missing'),
    effective_effort: normalizeRouteEffort(reasoningEffort),
    fallback_used: fallbackUsed === true,
    fallback_reason: normalizeFallbackReason(fallbackReason, fallbackUsed === true),
    agent_id_hash: resolvePromptFrameAgentHash(agentId, decisionState),
    request_identity_hash: buildPromptFrameRequestIdentityHash(requestIdentity),
    auth_class: normalizeString(authClass, 'unknown'),
    layer_token_estimates: layerSummary.token_estimates,
    layer_char_counts: layerSummary.char_counts,
    layer_hashes: layerSummary.hashes,
    unknown_layer_names: normalizedContract.unknown_layer_names,
    source_hashes: normalizedSourceHashes,
    prompt_source_file_hashes: sourceFileHashes,
    flags: normalizeFlags(flags),
    decision_state: normalizeDecisionState(decisionState),
    mcp_instruction_sources: normalizeMCPInstructionSources(mcpInstructionSources),
    voice_provider_control_marker_counts: countVoiceControlMarkers(voiceText || layers),
  };

  if (shouldIncludeDebugLayers()) {
    frame.debug_redacted_layers = buildDebugLayers(normalizedContract.layers);
  }

  return frame;
}

function resolvePromptObservabilityDir() {
  const explicit = String(process.env[OBSERVABILITY_DIR_ENV] || '').trim();
  if (explicit) {
    return explicit;
  }
  const privateRoot =
    String(process.env.VIVENTIUM_PRIVATE_USER_DATA_DIR || '').trim() ||
    path.join(os.homedir(), 'Documents', 'Viventium', 'app', 'my-user-data');
  return path.join(privateRoot, 'prompt-observability');
}

function writePromptFrameFile() {
  return false;
}

async function flushPromptFrameFileWrites() {
  return true;
}

/* === VIVENTIUM START ===
 * Fix: Preserve completing provider/model identity when Winston truncates the full frame line.
 */
function compactRouteLabel(value, fallback) {
  return normalizeString(value, fallback)
    .replace(/[^a-zA-Z0-9_:-]/g, '_')
    .slice(0, 32);
}

function routeIdentityHash(value) {
  const normalized = normalizeString(value, 'missing');
  return ['missing', 'none', 'unknown'].includes(normalized.toLowerCase())
    ? 'missing'
    : hashString(normalized);
}

function buildPromptFrameRouteTelemetry(frame) {
  const observedAgentIdHash = String(frame?.agent_id_hash || '');
  const requestIdentityHash = String(frame?.request_identity_hash || '');
  return {
    v: 2,
    f: compactRouteLabel(frame?.prompt_family, 'unknown'),
    s: compactRouteLabel(frame?.surface, 'unknown'),
    rp: routeIdentityHash(frame?.requested_provider),
    rm: routeIdentityHash(frame?.requested_model),
    re: normalizeRouteEffort(frame?.requested_effort),
    ep: routeIdentityHash(frame?.effective_provider ?? frame?.provider),
    em: routeIdentityHash(frame?.effective_model ?? frame?.model),
    ee: normalizeRouteEffort(frame?.effective_effort),
    fu: frame?.fallback_used === true,
    fr: normalizeFallbackReason(frame?.fallback_reason, frame?.fallback_used === true),
    a: /^[0-9a-f]{16}$/.test(observedAgentIdHash) ? observedAgentIdHash : 'missing',
    q: /^[0-9a-f]{16}$/.test(requestIdentityHash) ? requestIdentityHash : 'missing',
  };
}

function serializePromptFrameRouteTelemetry(frame) {
  const route = buildPromptFrameRouteTelemetry(frame);
  return JSON.stringify([
    route.v,
    route.f,
    route.s,
    route.rp,
    route.rm,
    route.re,
    route.ep,
    route.em,
    route.ee,
    route.fu ? 1 : 0,
    route.fr,
    route.a,
    route.q,
  ]);
}

function traceCategory(value, allowedValues) {
  const normalized = String(value || '').trim();
  return allowedValues.has(normalized) ? normalized : 'unknown';
}

function traceIdentityHash(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return /^[0-9a-f]{16}$/.test(normalized) ? normalized : 'missing';
}

function traceSourceHash(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return /^(?:[0-9a-f]{8,64}|missing)$/.test(normalized) ? normalized : 'missing';
}

function boundedTraceNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(Math.round(value * 1_000_000) / 1_000_000, 1_000_000_000));
}

function traceScalarProjection(value, booleanKeys, numberKeys, stringKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const projection = {};
  for (const key of booleanKeys) {
    if (typeof value[key] === 'boolean') {
      projection[key] = value[key];
    }
  }
  for (const key of numberKeys) {
    const bounded = boundedTraceNumber(value[key]);
    if (bounded !== undefined) {
      projection[key] = bounded;
    }
  }
  for (const key of stringKeys) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      projection[`${key}_hash`] = hashString(value[key]);
    }
  }
  return projection;
}

function traceLayerNumbers(values) {
  const input = values && typeof values === 'object' ? values : {};
  return PROMPT_FRAME_LAYERS.reduce((projection, layerName) => {
    projection[layerName] = boundedTraceNumber(input[layerName]) ?? 0;
    return projection;
  }, {});
}

function traceLayerHashes(values) {
  const input = values && typeof values === 'object' ? values : {};
  return PROMPT_FRAME_LAYERS.reduce((projection, layerName) => {
    const normalized = String(input[layerName] || '')
      .trim()
      .toLowerCase();
    projection[layerName] = /^(?:[0-9a-f]{16}|none)$/.test(normalized) ? normalized : 'missing';
    return projection;
  }, {});
}

function traceSourceHashes(values) {
  const input = values && typeof values === 'object' ? values : {};
  const projection = {};
  for (const key of PROMPT_TRACE_SOURCE_HASH_KEYS) {
    projection[key] = traceSourceHash(input[key]);
  }
  return projection;
}

function traceMcpInstructionCounts(values) {
  const counts = { server_fetched: 0, config_inline: 0, missing: 0 };
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return counts;
  }
  for (const value of Object.values(values)) {
    const key = ['server_fetched', 'config_inline'].includes(value) ? value : 'missing';
    counts[key] += 1;
  }
  return counts;
}

function traceVoiceMarkerCounts(values) {
  const input = values && typeof values === 'object' ? values : {};
  return ['break_tags', 'prosody_tags', 'say_as_tags', 'emotion_tags', 'total'].reduce(
    (projection, key) => {
      projection[key] = boundedTraceNumber(input[key]) ?? 0;
      return projection;
    },
    {},
  );
}

function buildPromptFrameTraceTelemetry(frame, { now = () => new Date() } = {}) {
  const observedAt = now();
  const timestamp =
    observedAt instanceof Date ? observedAt.toISOString() : new Date(0).toISOString();
  const unknownLayers = Array.isArray(frame?.unknown_layer_names)
    ? frame.unknown_layer_names.filter((value) => typeof value === 'string').slice(0, 128)
    : [];
  return {
    version: 2,
    time: timestamp,
    family: traceCategory(frame?.prompt_family, PROMPT_TRACE_FAMILIES),
    surface: traceCategory(frame?.surface, PROMPT_TRACE_SURFACES),
    requested_provider: `h${routeIdentityHash(frame?.requested_provider)}`,
    requested_model: `h${routeIdentityHash(frame?.requested_model)}`,
    requested_effort: normalizeRouteEffort(frame?.requested_effort),
    provider: `h${routeIdentityHash(frame?.effective_provider ?? frame?.provider)}`,
    model: `h${routeIdentityHash(frame?.effective_model ?? frame?.model)}`,
    effective_effort: normalizeRouteEffort(frame?.effective_effort),
    fallback_used: frame?.fallback_used === true,
    fallback_reason: normalizeFallbackReason(frame?.fallback_reason, frame?.fallback_used === true),
    agent_id_hash: traceIdentityHash(frame?.agent_id_hash),
    request_identity_hash: traceIdentityHash(frame?.request_identity_hash),
    auth_class: traceCategory(frame?.auth_class, PROMPT_TRACE_AUTH_CLASSES),
    layer_tokens: traceLayerNumbers(frame?.layer_token_estimates),
    layer_hashes: traceLayerHashes(frame?.layer_hashes),
    source_hashes: traceSourceHashes(frame?.source_hashes),
    flags: traceScalarProjection(
      frame?.flags,
      PROMPT_TRACE_FLAG_BOOLEAN_KEYS,
      PROMPT_TRACE_FLAG_NUMBER_KEYS,
      PROMPT_TRACE_FLAG_STRING_KEYS,
    ),
    decision: traceScalarProjection(
      frame?.decision_state,
      PROMPT_TRACE_DECISION_BOOLEAN_KEYS,
      PROMPT_TRACE_DECISION_NUMBER_KEYS,
      PROMPT_TRACE_DECISION_STRING_KEYS,
    ),
    mcp_instruction_source_counts: traceMcpInstructionCounts(frame?.mcp_instruction_sources),
    voice_provider_control_marker_counts: traceVoiceMarkerCounts(
      frame?.voice_provider_control_marker_counts,
    ),
    unknown_layer_count: unknownLayers.length,
    unknown_layer_set_hash: unknownLayers.length
      ? hashString([...unknownLayers].sort().join('\0'))
      : 'none',
  };
}

function serializePromptFrameTraceTelemetry(frame) {
  const serialized = JSON.stringify(buildPromptFrameTraceTelemetry(frame));
  if (Buffer.byteLength(serialized) > MAX_TRACE_LOG_BYTES) {
    throw new Error('prompt_frame_trace_projection_overflow');
  }
  return serialized;
}
/* === VIVENTIUM END === */

function logPromptFrame(targetLogger, frame) {
  if (
    process.env[LOG_ENV] === '0' ||
    (process.env.NODE_ENV === 'test' && process.env[LOG_ENV] !== '1')
  ) {
    return writePromptFrameFile(frame);
  }
  if (!frame || typeof frame !== 'object') {
    return false;
  }
  let wrote = writePromptFrameFile(frame);
  try {
    const logRoute =
      targetLogger && typeof targetLogger.info === 'function'
        ? targetLogger.info.bind(targetLogger)
        : null;
    const logTrace =
      targetLogger && typeof targetLogger.debug === 'function'
        ? targetLogger.debug.bind(targetLogger)
        : null;
    if (!logRoute || !logTrace) {
      return wrote;
    }
    /* === VIVENTIUM START ===
     * The normal Winston info formatter truncates messages. Keep the compact route on info, then
     * pass the strict trace JSON as debug metadata; the existing debug formatter preserves that
     * second argument in the same rotated Core log without opening another production file sink.
     */
    const routeTelemetry = serializePromptFrameRouteTelemetry(frame);
    const traceTelemetry = serializePromptFrameTraceTelemetry(frame);
    logRoute(`[PromptFrameRouteTelemetry] ${routeTelemetry}`);
    logTrace('[PromptFrameTraceTelemetry]', traceTelemetry);
    /* === VIVENTIUM END === */
    wrote = true;
  } catch (_error) {
    return wrote;
  }
  return wrote;
}

module.exports = {
  LOG_ENV,
  DEBUG_ENV,
  DEBUG_LOCAL_ENV,
  FILE_LOG_ENV,
  OBSERVABILITY_DIR_ENV,
  estimatePromptTokens,
  hashString,
  hashFile,
  redactPromptDebugText,
  countVoiceControlMarkers,
  summarizeLayers,
  PROMPT_FRAME_LAYERS,
  normalizeLayersToContract,
  normalizeMCPInstructionSources,
  buildPromptFrame,
  buildPromptFrameRequestIdentityHash,
  normalizeFallbackReason,
  normalizeRouteEffort,
  promptLayerIntegritySnapshot,
  resetPromptLayerIntegrityForTests,
  /* === VIVENTIUM START: Export bounded route telemetry for regression tests. === */
  buildPromptFrameRouteTelemetry,
  buildPromptFrameTraceTelemetry,
  /* === VIVENTIUM END === */
  logPromptFrame,
  resolvePromptObservabilityDir,
  writePromptFrameFile,
  flushPromptFrameFileWrites,
};
