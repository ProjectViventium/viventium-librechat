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
const FILE_LOG_MAX_PENDING_ENV = 'VIVENTIUM_PROMPT_FRAME_FILE_LOG_MAX_PENDING';

const DEFAULT_HASH_LENGTH = 16;
const DEFAULT_DEBUG_CHAR_LIMIT = 2000;
const MAX_DEBUG_CHAR_LIMIT = 250_000;
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
  global_no_response: 'global_no_response',
  no_response: 'global_no_response',
  no_response_instructions: 'global_no_response',
  memory: 'memory_context',
  memory_context: 'memory_context',
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
  web_text: 'surface_prompt',
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
  time_context: 'time_context',
  unknown: 'unknown',
});

const fileHashCache = new Map();
let pendingFileWrites = 0;

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

function buildPromptFrame({
  promptFamily,
  surface,
  provider,
  model,
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
    provider: normalizeString(provider, 'unknown'),
    model: normalizeString(model, 'unknown'),
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

function shouldWritePromptFrameFile() {
  if (process.env[FILE_LOG_ENV] !== '1') {
    return false;
  }
  if (process.env.CI === 'true' || process.env.NODE_ENV === 'production') {
    return false;
  }
  return true;
}

function maxPendingFileWrites() {
  const parsed = parseInt(String(process.env[FILE_LOG_MAX_PENDING_ENV] || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 256;
}

function writePromptFrameFile(frame) {
  if (!shouldWritePromptFrameFile() || !frame || typeof frame !== 'object') {
    return false;
  }
  if (pendingFileWrites >= maxPendingFileWrites()) {
    return false;
  }

  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(resolvePromptObservabilityDir(), 'frame-logs', day);
  const filePath = path.join(dir, `prompt-frames-${process.pid}.jsonl`);
  const line = `${JSON.stringify(frame)}\n`;
  pendingFileWrites += 1;
  fs.promises
    .mkdir(dir, { recursive: true, mode: 0o700 })
    .then(() => fs.promises.appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 }))
    .catch(() => undefined)
    .finally(() => {
      pendingFileWrites = Math.max(0, pendingFileWrites - 1);
    });
  return true;
}

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
    const log =
      targetLogger && typeof targetLogger.info === 'function'
        ? targetLogger.info.bind(targetLogger)
        : null;
    if (!log) {
      return wrote;
    }
    const publicLogFrame = { ...frame };
    delete publicLogFrame.debug_redacted_layers;
    log(`[PromptFrameTelemetry] ${JSON.stringify(publicLogFrame)}`);
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
  logPromptFrame,
  resolvePromptObservabilityDir,
  writePromptFrameFile,
};
