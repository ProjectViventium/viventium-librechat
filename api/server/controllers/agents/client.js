/* === VIVENTIUM START ===
 * File: api/server/controllers/agents/client.js
 *
 * Purpose:
 * - Track and preserve all Viventium modifications to this upstream LibreChat file in one place.
 *
 * Why a file-level wrapper:
 * - This file has extensive Viventium changes (background cortices, surface-aware prompting, voice/telegram
 *   behaviors, deep timing instrumentation, and no-response handling). Wrapping the whole file guarantees
 *   we never miss a change when manually porting to a newer upstream LibreChat version.
 *
 * Porting (manual onto new upstream):
 * - Re-apply this file as a patch against upstream (see docs/requirements_and_learnings/05_Open_Source_Modifications.md).
 * - Search inside this file for `VIVENTIUM NOTE` for section-level intent notes.
 *
 * Added: 2026-01-03
 * Updated: 2026-02-07
 */
	require('events').EventEmitter.defaultMaxListeners = 100;
	const { logger } = require('@librechat/data-schemas');
	const { HumanMessage } = require('@langchain/core/messages');
	const {
	  createRun,
	  recordCollectedUsage: recordCollectedUsageWithDeps,
	  sendEvent,
	  Tokenizer,
	  checkAccess,
	  logAxiosError,
	  sanitizeTitle,
	  resolveHeaders,
	  createSafeUser,
	  initializeAgent,
	  getBalanceConfig,
	  getProviderConfig,
	  memoryInstructions,
	  applyContextToAgent,
	  GenerationJobManager,
	  getTransactionsConfig,
	  createMemoryProcessor,
	  loadMemorySnapshot,
	  filterMalformedContentParts,
	} = require('@librechat/api');
const {
  Callback,
  Providers,
  TitleMethod,
  formatMessage,
  labelContentByAgent,
  formatAgentMessages,
  getTokenCountForMessage,
  createMetadataAggregator,
} = require('@librechat/agents');
const {
  Constants,
  Permissions,
  VisionModes,
  ContentTypes,
  EModelEndpoint,
  PermissionTypes,
  isAgentsEndpoint,
  isEphemeralAgentId,
  bedrockInputSchema,
  removeNullishValues,
} = require('librechat-data-provider');
const { spendTokens, spendStructuredTokens } = require('~/models/spendTokens');
const { getMultiplier, getCacheMultiplier } = require('~/models/tx');
const { encodeAndFormat } = require('~/server/services/Files/images/encode');
const { createContextHandlers } = require('~/app/clients/prompts');
const { getConvoFiles } = require('~/models/Conversation');
const BaseClient = require('~/app/clients/BaseClient');
const {
  isListenOnlyTranscriptMessage,
} = require('~/server/services/viventium/listenOnlyTranscript');
const { getRoleByName } = require('~/models/Role');
const { loadAgent } = require('~/models/Agent');
const { getMCPManager } = require('~/config');
const db = require('~/models');
const { updateBalance, bulkInsertTransactions } = require('~/models');

/* === VIVENTIUM NOTE ===
 * Feature: Background Cortices (Multi-Agent Brain Architecture)
 * Added: 2026-01-03
 */
const {
  detectActivations, // NEW: Phase A - Activation detection with timeout
  executeActivated, // NEW: Phase B - Execute activated cortices with merging
  formatInsightsForContext,
  sanitizeCortexDisplayName, // NEW: Sanitize display names to remove jargon
} = require('~/server/services/BackgroundCortexService');
const {
  persistCortexPartsToCanonicalMessage,
  finalizeCanonicalCortexMessage,
  createCortexFollowUpMessage,
} = require('~/server/services/viventium/BackgroundCortexFollowUpService');
const {
  createRuntimeHoldTextPart,
} = require('~/server/services/viventium/runtimeHoldText');
/* === VIVENTIUM NOTE ===
 * Feature: Background cortex follow-up grace window
 */
const { getCortexFollowupGraceMs } = require('~/server/services/viventium/cortexFollowupGrace');
/* === VIVENTIUM NOTE END === */
/* === VIVENTIUM NOTE ===
 * Feature: Tool Cortex Brewing Hold (deterministic "checking..." ack)
 */
const {
  shouldDeferMainResponse: shouldDeferToolCortexMainResponse,
  collectDirectActionScopeKeysFromCortices,
  pickHoldText: pickToolCortexHoldText,
  shouldForcePhaseBFollowUp,
} = require('~/server/services/viventium/brewingHold');
const {
  resolveVoicePhaseAAsyncPolicy,
} = require('~/server/services/viventium/voicePhaseAPolicy');
/* === VIVENTIUM NOTE END === */
const {
  getController: getResponseController,
  removeController: removeResponseController,
} = require('~/server/services/ResponseController');
/* === VIVENTIUM NOTE END === */

/* === VIVENTIUM NOTE ===
 * Feature: Strip internal content parts before agent formatting.
 * Purpose: Prevent provider errors from unsupported content part types (cortex, think, etc).
 */
const INTERNAL_CONTENT_TYPES = new Set([
  ContentTypes.CORTEX_ACTIVATION,
  ContentTypes.CORTEX_BREWING,
  ContentTypes.CORTEX_INSIGHT,
  ContentTypes.AGENT_UPDATE,
  ContentTypes.ERROR,
  ContentTypes.THINK,
]);

/* === VIVENTIUM NOTE ===
 * Feature: Normalize persisted text content blocks before provider formatting.
 *
 * Root Cause:
 * - Some stored messages contain `type: "text"` parts shaped like:
 *     { type: "text", text: { value: "..." } }
 *   (OpenAI Assistants-style content). Provider SDKs (e.g., Anthropic) expect `text` to be a string.
 *
 * Added: 2026-02-08
 */
const {
  normalizeTextContentParts,
  normalizeTextPartsInPayload,
  sanitizeProviderFormattedMessages,
} = require('~/server/services/viventium/normalizeTextContentParts');
const {
  shouldRetryWithFallback,
} = require('~/server/services/viventium/agentLlmFallback');
const {
  sanitizeAggregatedContentParts,
} = require('~/server/services/viventium/sanitizeAggregatedContentParts');
const {
  getAnthropicPayloadGuardConfig,
  isAnthropicProvider,
  compactAnthropicMessagesForSize,
  isAnthropicRequestTooLargeError,
} = require('~/server/services/viventium/anthropicPayloadGuard');
/* === VIVENTIUM NOTE ===
 * Feature: Conversation Recall prompt injection
 */
const {
  buildConversationRecallInstructions,
} = require('~/server/services/viventium/conversationRecallPrompt');
const {
  scheduleConversationRecallSync,
} = require('~/server/services/viventium/conversationRecallService');
const { resolveMemoryTokenLimit } = require('~/server/services/viventium/memoryTokenLimit');
/* === VIVENTIUM NOTE END === */
/* === VIVENTIUM NOTE END === */

const stripInternalContentParts = (payload) => {
  if (!Array.isArray(payload)) {
    return payload;
  }
  return payload.map((message) => {
    if (!message || !Array.isArray(message.content)) {
      return message;
    }
    const filtered = message.content.filter((part) => {
      /* === VIVENTIUM START ===
       * Feature: Drop null/undefined parts early to avoid formatter crashes.
       * === VIVENTIUM END === */
      if (part == null) {
        return false;
      }
      if (typeof part !== 'object') {
        return true;
      }
      const { type } = part;
      if (!type) {
        return true;
      }
      return !INTERNAL_CONTENT_TYPES.has(type);
    });
    if (filtered.length === message.content.length) {
      return message;
    }
    return { ...message, content: filtered.length ? filtered : '' };
  });
};
/* === VIVENTIUM NOTE END === */

/* === VIVENTIUM NOTE ===
 * Feature: Memory buffer sanitization for internal-control and no-response content.
 *
 * Purpose:
 * - Keep the memory agent focused on actual conversation content rather than scheduler/self-prompt text.
 * - Exclude assistant `think` blocks and `{NTA}`-only turns from the memory buffer.
 *
 * Added: 2026-03-09
 */
const MEMORY_CONTROL_TEXT_REGEX =
  /^(?:wake\.\s*check date,\s*time,\s*timezone|internal check:|self-reflection\.|review working\/context\/signals\/drafts\.)/i;

const getMemoryRoleLabel = (message) => {
  const messageType =
    (typeof message?._getType === 'function' && message._getType()) ||
    (typeof message?.getType === 'function' && message.getType()) ||
    message?.role ||
    '';

  switch (String(messageType).toLowerCase()) {
    case 'human':
    case 'user':
      return 'Human';
    case 'ai':
    case 'assistant':
      return 'AI';
    case 'system':
      return 'System';
    case 'tool':
      return 'Tool';
    default:
      return 'Message';
  }
};

const extractMemoryTextFromPart = (part) => {
  if (typeof part === 'string') {
    return part.trim();
  }
  if (!part || typeof part !== 'object') {
    return '';
  }
  if (part.type && INTERNAL_CONTENT_TYPES.has(part.type)) {
    return '';
  }
  if (typeof part.text === 'string') {
    return part.text.trim();
  }
  if (typeof part?.text?.value === 'string') {
    return part.text.value.trim();
  }
  if (typeof part.input_text === 'string') {
    return part.input_text.trim();
  }
  if (typeof part.content === 'string') {
    return part.content.trim();
  }
  return '';
};

const extractMemoryMessageText = (content) => {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => extractMemoryTextFromPart(part))
    .filter(Boolean)
    .join('\n')
    .trim();
};

const shouldSkipMemoryBufferText = (roleLabel, text) => {
  if (!text) {
    return true;
  }
  if (roleLabel === 'AI' && isNoResponseOnly(text)) {
    return true;
  }
  return MEMORY_CONTROL_TEXT_REGEX.test(text);
};

const buildMemoryBufferString = (messages) => {
  const lines = [];

  for (const message of messages) {
    const roleLabel = getMemoryRoleLabel(message);
    const extractedText = extractMemoryMessageText(message?.content);
    const text = (roleLabel === 'AI' ? stripTrailingNTA(extractedText) : extractedText).trim();

    if (shouldSkipMemoryBufferText(roleLabel, text)) {
      continue;
    }

    lines.push(`${roleLabel}: ${text}`);
  }

  return lines.join('\n');
};

/* === VIVENTIUM START ===
 * Feature: Bounded older-user-context memory digest.
 *
 * Purpose:
 * - Keep recent user corrections visible to the memory writer even when they fall just outside
 *   the main recent-message window.
 * - Stay generic and config-driven without branching on user-specific facts or prompt text.
 *
 * Added: 2026-04-09
 * === VIVENTIUM END === */
const trimMemoryContextSection = (text, charLimit) => {
  const normalized = (text || '').trim();
  if (!normalized) {
    return '';
  }
  if (!Number.isFinite(charLimit) || charLimit <= 0 || normalized.length <= charLimit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, charLimit - 3)).trimEnd()}...`;
};

const buildHistoricalUserContextBuffer = ({
  messages,
  windowStartIndex,
  scanLimit,
  userTurnLimit,
  charLimit,
  transformMessage,
}) => {
  if (
    !Array.isArray(messages) ||
    windowStartIndex <= 0 ||
    !Number.isFinite(scanLimit) ||
    scanLimit <= 0 ||
    !Number.isFinite(userTurnLimit) ||
    userTurnLimit <= 0 ||
    !Number.isFinite(charLimit) ||
    charLimit <= 0
  ) {
    return '';
  }

  const scanStartIndex = Math.max(0, windowStartIndex - scanLimit);
  const historyMessages = messages
    .slice(scanStartIndex, windowStartIndex)
    .filter((message) => getMemoryRoleLabel(message) === 'Human');

  if (historyMessages.length === 0) {
    return '';
  }

  const recentUserTurns = historyMessages
    .slice(-userTurnLimit)
    .map((message) => (typeof transformMessage === 'function' ? transformMessage(message) : message));

  return trimMemoryContextSection(buildMemoryBufferString(recentUserTurns), charLimit);
};
/* === VIVENTIUM NOTE END === */

/* === VIVENTIUM NOTE ===
 * Feature: Surface-aware prompt helpers (shared across agents + cortices)
 */
const {
  resolveViventiumSurface,
  buildVoiceModeInstructions,
  buildTelegramTextInstructions,
  buildPlaygroundTextInstructions,
  buildVoiceNoteInputInstructions,
  buildVoiceCallInputInstructions,
  buildWingModeInstructions,
  isWingModeEnabledForRequest,
  buildTimeContextInstructions,
} = require('~/server/services/viventium/surfacePrompts');
/* === VIVENTIUM NOTE END === */

/* === VIVENTIUM NOTE ===
 * Feature: No Response Tag ({NTA}) prompt injection (env-gated, config-driven).
 *
 * Purpose:
 * - Inject a single shared instruction block into ALL agent system prompts so models can output
 *   `{NTA}` when intentionally silent ("nothing to add") and downstream systems can suppress delivery.
 *
 * Added: 2026-02-07
 */
const { buildNoResponseInstructions } = require('~/server/services/viventium/noResponsePrompt');
const {
  isNoResponseOnly,
  stripTrailingNTA,
} = require('~/server/services/viventium/noResponseTag');
/* === VIVENTIUM NOTE END === */

/* === VIVENTIUM NOTE ===
 * Feature: Deep Telegram timing instrumentation (toggleable)
 */
const {
  isDeepTimingEnabled,
  startDeepTiming,
  logDeepTiming,
} = require('~/server/services/viventium/telegramTimingDeep');
/* === VIVENTIUM NOTE END === */

/* === VIVENTIUM NOTE ===
 * Feature: Voice invoke deep telemetry patch.
 * Purpose: Emit detailed invoke-stage timings from @librechat/agents Graph internals for voice requests.
 * Added: 2026-03-04
 */
const {
  applyVoiceInvokeTelemetryPatch,
} = require('~/server/services/viventium/voiceInvokeTelemetryPatch');
applyVoiceInvokeTelemetryPatch();
/* === VIVENTIUM NOTE END === */

/* === VIVENTIUM NOTE ===
 * Feature: Voice latency stage logging (request_id-correlated with voice gateway).
 */
const isVoiceLatencyEnabled = (req) => req?.viventiumVoiceLogLatency === true;

const getVoiceLatencyRequestId = (req) => {
  const requestId = req?.viventiumVoiceRequestId;
  if (typeof requestId === 'string' && requestId.length > 0) {
    return requestId;
  }
  return 'unknown';
};

const logVoiceLatencyStage = (req, stage, stageStartAt = null, details = '') => {
  if (!isVoiceLatencyEnabled(req)) {
    return;
  }

  const now = Date.now();
  const routeStartAt = typeof req?.viventiumVoiceStartAt === 'number'
    ? req.viventiumVoiceStartAt
    : now;
  const stageMs = typeof stageStartAt === 'number' ? now - stageStartAt : null;
  const requestId = getVoiceLatencyRequestId(req);
  const stagePart = stageMs == null ? '' : ` stage_ms=${stageMs}`;
  const detailPart = details ? ` ${details}` : '';
  logger.info(
    `[VoiceLatency][LC] stage=${stage} request_id=${requestId} total_ms=${now - routeStartAt}${stagePart}${detailPart}`,
  );
};

/* === VIVENTIUM START ===
 * Feature: Voice orchestration summary formatter (single compact log line/turn).
 * Purpose: Provide low-cost, high-signal breakdown from process_stream start to first key events.
 * Added: 2026-03-03
 */
const buildVoiceOrchestrationSummary = (req, processStreamStartedAt) => {
  const orchState = req?._viventiumVoiceOrchState;
  if (
    !orchState ||
    typeof orchState !== 'object' ||
    typeof orchState.firstTs !== 'object' ||
    typeof orchState.counts !== 'object'
  ) {
    return '';
  }

  const relMs = (key) => {
    const ts = orchState.firstTs?.[key];
    if (typeof ts !== 'number' || typeof processStreamStartedAt !== 'number') {
      return null;
    }
    const delta = ts - processStreamStartedAt;
    return delta >= 0 ? delta : null;
  };

  const firstProcessEvents = [
    relMs('chain_start'),
    relMs('prompt_start'),
    relMs('prompt_end'),
    relMs('chat_model_start'),
    relMs('llm_start'),
    relMs('llm_stream'),
    relMs('on_run_step'),
    relMs('chat_model_stream'),
    relMs('on_run_step_delta'),
    relMs('on_message_delta'),
    relMs('on_reasoning_delta'),
  ].filter((value) => Number.isFinite(value));
  const firstProcessEventMs = firstProcessEvents.length > 0 ? Math.min(...firstProcessEvents) : null;

  const countEntries = [
    ['chain_start', orchState.counts?.chain_start],
    ['chain_end', orchState.counts?.chain_end],
    ['prompt_start', orchState.counts?.prompt_start],
    ['prompt_end', orchState.counts?.prompt_end],
    ['chat_model_start', orchState.counts?.chat_model_start],
    ['llm_start', orchState.counts?.llm_start],
    ['llm_stream', orchState.counts?.llm_stream],
    ['run_step', orchState.counts?.on_run_step],
    ['run_step_delta', orchState.counts?.on_run_step_delta],
    ['run_step_completed', orchState.counts?.on_run_step_completed],
    ['chat_model_stream', orchState.counts?.chat_model_stream],
    ['message_delta', orchState.counts?.on_message_delta],
    ['reasoning_delta', orchState.counts?.on_reasoning_delta],
    ['model_end', orchState.counts?.chat_model_end],
  ]
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .map(([key, value]) => `${key}:${value}`)
    .join(',');

  const detailParts = [];
  if (firstProcessEventMs != null) {
    detailParts.push(`first_process_event_ms=${firstProcessEventMs}`);
  }
  const chainStartMs = relMs('chain_start');
  if (chainStartMs != null) {
    detailParts.push(`first_chain_start_ms=${chainStartMs}`);
  }
  const chainEndMs = relMs('chain_end');
  if (chainEndMs != null) {
    detailParts.push(`first_chain_end_ms=${chainEndMs}`);
  }
  const promptStartMs = relMs('prompt_start');
  if (promptStartMs != null) {
    detailParts.push(`first_prompt_start_ms=${promptStartMs}`);
  }
  const promptEndMs = relMs('prompt_end');
  if (promptEndMs != null) {
    detailParts.push(`first_prompt_end_ms=${promptEndMs}`);
  }
  if (promptStartMs != null && promptEndMs != null && promptEndMs >= promptStartMs) {
    detailParts.push(`prompt_block_ms=${promptEndMs - promptStartMs}`);
  }
  const chatModelStartMs = relMs('chat_model_start');
  if (chatModelStartMs != null) {
    detailParts.push(`first_chat_model_start_ms=${chatModelStartMs}`);
  }
  const llmStartMs = relMs('llm_start');
  if (llmStartMs != null) {
    detailParts.push(`first_llm_start_ms=${llmStartMs}`);
  }
  const llmStreamMs = relMs('llm_stream');
  if (llmStreamMs != null) {
    detailParts.push(`first_llm_stream_ms=${llmStreamMs}`);
  }
  if (llmStartMs != null && llmStreamMs != null && llmStreamMs >= llmStartMs) {
    detailParts.push(`llm_start_to_first_stream_ms=${llmStreamMs - llmStartMs}`);
  }
  const runStepMs = relMs('on_run_step');
  if (runStepMs != null) {
    detailParts.push(`first_run_step_ms=${runStepMs}`);
  }
  const streamMs = relMs('chat_model_stream');
  if (streamMs != null) {
    detailParts.push(`first_chat_model_stream_ms=${streamMs}`);
  }
  if (chatModelStartMs != null && streamMs != null && streamMs >= chatModelStartMs) {
    detailParts.push(`chat_model_start_to_stream_ms=${streamMs - chatModelStartMs}`);
  }
  const runStepDeltaMs = relMs('on_run_step_delta');
  if (runStepDeltaMs != null) {
    detailParts.push(`first_run_step_delta_ms=${runStepDeltaMs}`);
  }
  const messageDeltaMs = relMs('on_message_delta');
  if (messageDeltaMs != null) {
    detailParts.push(`first_message_delta_ms=${messageDeltaMs}`);
  }
  if (streamMs != null && messageDeltaMs != null && messageDeltaMs >= streamMs) {
    detailParts.push(`stream_to_message_delta_ms=${messageDeltaMs - streamMs}`);
  }
  const reasoningMs = relMs('on_reasoning_delta');
  if (reasoningMs != null) {
    detailParts.push(`first_reasoning_delta_ms=${reasoningMs}`);
  }
  const completedMs = relMs('on_run_step_completed');
  if (completedMs != null) {
    detailParts.push(`first_run_step_completed_ms=${completedMs}`);
  }
  const modelEndMs = relMs('chat_model_end');
  if (modelEndMs != null) {
    detailParts.push(`first_chat_model_end_ms=${modelEndMs}`);
  }
  if (countEntries) {
    detailParts.push(`counts=${countEntries}`);
  }

  return detailParts.join(' ');
};
/* === VIVENTIUM END === */
/* === VIVENTIUM NOTE END === */

/* === VIVENTIUM START ===
 * Feature: Voice request payload stats (telemetry-only).
 * Purpose: Quantify prompt/message size pressure per turn to explain model_start->first_stream latency.
 * Added: 2026-03-04
 */
const estimateVoiceMessageStats = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messageCount: 0, contentChars: 0, jsonChars: 0 };
  }

  let contentChars = 0;
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === 'string') {
      contentChars += content.length;
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') {
          continue;
        }
        if (typeof part.text === 'string') {
          contentChars += part.text.length;
        } else if (part.text && typeof part.text?.value === 'string') {
          contentChars += part.text.value.length;
        } else if (typeof part.reasoning_content === 'string') {
          contentChars += part.reasoning_content.length;
        } else if (typeof part.output_text === 'string') {
          contentChars += part.output_text.length;
        }
      }
    }
  }

  let jsonChars = 0;
  try {
    jsonChars = JSON.stringify(messages).length;
  } catch {
    jsonChars = 0;
  }

  return {
    messageCount: messages.length,
    contentChars,
    jsonChars,
  };
};
/* === VIVENTIUM END === */


/* === VIVENTIUM NOTE ===
 * Feature: Background Cortices - Helper Functions
 * Added: 2026-01-XX
 */

/**
 * Format brewing acknowledgment text for main agent awareness
 * @param {Array} activatedCortices - Array of { cortexName, confidence, reason }
 * @returns {string} Brewing acknowledgment text
 */
function formatBrewingAcknowledgment(activatedCortices) {
  if (!Array.isArray(activatedCortices) || activatedCortices.length === 0) {
    return '';
  }

  const cortexNames = activatedCortices
    .map((c) => c.cortexName || 'Background Agent')
    .slice(0, 6)
    .join(', ');

  const suffix = activatedCortices.length > 6 ? ` (+${activatedCortices.length - 6} more)` : '';

  return [
    '## Background Processing (Brewing)',
    `The following background agents have activated and are analyzing in parallel: ${cortexNames}${suffix}.`,
    'Use your own connected tools now for any part of the user request you can directly verify.',
    'Treat background agents as supplemental reviewers. Do not wait for their results while answering the user.',
    'For any part only a background agent can verify, acknowledge that part is still being checked and do not guess.',
    '',
  ].join('\n');
}

function formatActivationSummary(activatedCortices) {
  if (!Array.isArray(activatedCortices) || activatedCortices.length === 0) {
    return '';
  }

  const lines = activatedCortices
    .map((c) => {
      const name = c.cortexName || 'Background Agent';
      const desc = c.cortexDescription ? ` — ${c.cortexDescription}` : '';
      const scope = c.activationScope ? ` [scope: ${c.activationScope}]` : '';
      const directScopeKeys = Array.isArray(c.directActionSurfaceScopes)
        ? c.directActionSurfaceScopes
            .map((surface) => surface?.scopeKey || surface?.scope_key || '')
            .filter(Boolean)
        : [];
      const direct = directScopeKeys.length > 0
        ? ` [main-direct: ${directScopeKeys.join(', ')}]`
        : '';
      const reason = c.reason || 'activated';
      const confidence =
        typeof c.confidence === 'number' && c.confidence > 0
          ? ` (${Math.round(c.confidence * 100)}% confidence)`
          : '';

      return `- ${name}${scope}${direct}${desc}: ${reason}${confidence}`;
    })
    .join('\n');

  return [
    '## Activated Background Agents',
    lines,
    '',
    'A single follow-up response will be generated once ALL activated agents finish.',
  ].join('\n');
}

function extractTextFromContentParts(parts) {
  if (!Array.isArray(parts)) {
    return '';
  }

  const texts = parts
    .filter((part) => part && part.type === ContentTypes.TEXT)
    .map((part) => {
      if (typeof part.text === 'string') {
        return part.text;
      }
      const textPart = part[ContentTypes.TEXT];
      if (typeof textPart === 'string') {
        return textPart;
      }
      if (textPart && typeof textPart.value === 'string') {
        return textPart.value;
      }
      return '';
    })
    .filter((text) => text.length > 0);

  return texts.join('');
}

function parseIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') {
    return fallback;
  }
  const value = parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function getCortexDetectTimeoutMs(voiceMode) {
  const base = parseIntEnv('VIVENTIUM_CORTEX_DETECT_TIMEOUT_MS', 2000);
  if (!voiceMode) {
    return base;
  }
  /* === VIVENTIUM NOTE ===
   * Feature: Voice Phase A detection time budget override.
   * VIVENTIUM_VOICE_PHASE_A_AWAIT_MS takes priority over VIVENTIUM_VOICE_CORTEX_DETECT_TIMEOUT_MS
   * for voice call mode, allowing a tighter time budget for activation detection.
   * Default: inherits from VIVENTIUM_VOICE_CORTEX_DETECT_TIMEOUT_MS or base (2000ms).
   * Added: 2026-03-04
   */
  const phaseAAwait = parseIntEnv('VIVENTIUM_VOICE_PHASE_A_AWAIT_MS', -1);
  if (phaseAAwait >= 0) {
    return phaseAAwait;
  }
  /* === VIVENTIUM NOTE END === */
  return parseIntEnv('VIVENTIUM_VOICE_CORTEX_DETECT_TIMEOUT_MS', base);
}

const omitTitleOptions = new Set([
  'stream',
  'thinking',
  'streaming',
  'clientOptions',
  'thinkingConfig',
  'thinkingBudget',
  'includeThoughts',
  'maxOutputTokens',
  'additionalModelRequestFields',
]);

/* === VIVENTIUM NOTE ===
 * Background Cortices UX (Two-phase)
 *
 * By default, we do NOT delay the main response for background cortices.
 *
 * However, when a tool-focused cortex activates (ex: `online_tool_use`), we may return a
 * deterministic holding acknowledgement ("checking...") to prevent premature memory-based
 * answers while tools/MCPs are still brewing (v0_3 parity).
 *
 * Flow:
 * - Phase A (≤2s): activation detection for all configured background agents.
 *   The main agent receives a system-only awareness block (who activated + why).
 * - Phase B (async): activated background agents execute; UI receives real-time
 *   `on_cortex_update` status events (activating → brewing → complete).
 * - When ALL activated agents finish, we trigger exactly one same-turn follow-up
 *   using a NEW messageId/runId to avoid streaming collisions.
 */

/**
 * @param {ServerRequest} req
 * @param {Agent} agent
 * @param {string} endpoint
 */
const payloadParser = ({ req, agent, endpoint }) => {
  if (isAgentsEndpoint(endpoint)) {
    return { model: undefined };
  } else if (endpoint === EModelEndpoint.bedrock) {
    const parsedValues = bedrockInputSchema.parse(agent.model_parameters);
    if (parsedValues.thinking == null) {
      parsedValues.thinking = false;
    }
    return parsedValues;
  }
  return req.body.endpointOption.model_parameters;
};

function createTokenCounter(encoding) {
  return function (message) {
    const countTokens = (text) => Tokenizer.getTokenCount(text, encoding);
    return getTokenCountForMessage(message, countTokens);
  };
}

function logToolError(graph, error, toolId) {
  logAxiosError({
    error,
    message: `[api/server/controllers/agents/client.js #chatCompletion] Tool Error "${toolId}"`,
  });
}

/* === VIVENTIUM NOTE ===
 * Feature: Voice latency tool callback telemetry.
 * Purpose: Extract stable tool identifiers from callback args for per-tool timing logs.
 * Added: 2026-03-03
 */
function extractToolTelemetry(callbackArgs = []) {
  let name = '';
  let id = '';

  const inspectArg = (arg) => {
    if (!arg || typeof arg !== 'object') {
      return;
    }

    if (!name && typeof arg.name === 'string') {
      name = arg.name;
    }
    if (!id && typeof arg.id === 'string') {
      id = arg.id;
    }
    if (!id && typeof arg.tool_call_id === 'string') {
      id = arg.tool_call_id;
    }
    if (!name && arg.function && typeof arg.function.name === 'string') {
      name = arg.function.name;
    }
    if (!name && arg.serialized && typeof arg.serialized.name === 'string') {
      name = arg.serialized.name;
    }
    if (!name && arg.tool_call && typeof arg.tool_call.name === 'string') {
      name = arg.tool_call.name;
    }
    if (!id && arg.tool_call && typeof arg.tool_call.id === 'string') {
      id = arg.tool_call.id;
    }
    if (!name && arg.metadata && typeof arg.metadata.toolName === 'string') {
      name = arg.metadata.toolName;
    }
    if (!id && arg.metadata && typeof arg.metadata.toolId === 'string') {
      id = arg.metadata.toolId;
    }
  };

  for (const arg of callbackArgs) {
    inspectArg(arg);
  }

  return {
    name: name || 'unknown',
    id: id || 'unknown',
  };
}
/* === VIVENTIUM NOTE END === */

/** Regex pattern to match agent ID suffix (____N) */
const AGENT_SUFFIX_PATTERN = /____(\d+)$/;

/**
 * Finds the primary agent ID within a set of agent IDs.
 * Primary = no suffix (____N) or lowest suffix number.
 * @param {Set<string>} agentIds
 * @returns {string | null}
 */
function findPrimaryAgentId(agentIds) {
  let primaryAgentId = null;
  let lowestSuffixIndex = Infinity;

  for (const agentId of agentIds) {
    const suffixMatch = agentId.match(AGENT_SUFFIX_PATTERN);
    if (!suffixMatch) {
      return agentId;
    }
    const suffixIndex = parseInt(suffixMatch[1], 10);
    if (suffixIndex < lowestSuffixIndex) {
      lowestSuffixIndex = suffixIndex;
      primaryAgentId = agentId;
    }
  }

  return primaryAgentId;
}

/**
 * Creates a mapMethod for getMessagesForConversation that processes agent content.
 * - Strips agentId/groupId metadata from all content
 * - For parallel agents (addedConvo with groupId): filters each group to its primary agent
 * - For handoffs (agentId without groupId): keeps all content from all agents
 * - For multi-agent: applies agent labels to content
 *
 * The key distinction:
 * - Parallel execution (addedConvo): Parts have both agentId AND groupId
 * - Handoffs: Parts only have agentId, no groupId
 *
 * @param {Agent} primaryAgent - Primary agent configuration
 * @param {Map<string, Agent>} [agentConfigs] - Additional agent configurations
 * @returns {(message: TMessage) => TMessage} Map method for processing messages
 */
function createMultiAgentMapper(primaryAgent, agentConfigs) {
  const hasMultipleAgents = (primaryAgent.edges?.length ?? 0) > 0 || (agentConfigs?.size ?? 0) > 0;

  /** @type {Record<string, string> | null} */
  let agentNames = null;
  if (hasMultipleAgents) {
    agentNames = { [primaryAgent.id]: primaryAgent.name || 'Assistant' };
    if (agentConfigs) {
      for (const [agentId, agentConfig] of agentConfigs.entries()) {
        agentNames[agentId] = agentConfig.name || agentConfig.id;
      }
    }
  }

  return (message) => {
    if (message.isCreatedByUser || !Array.isArray(message.content)) {
      return message;
    }

    // Check for metadata
    const hasAgentMetadata = message.content.some((part) => part?.agentId || part?.groupId != null);
    if (!hasAgentMetadata) {
      return message;
    }

    try {
      // Build a map of groupId -> Set of agentIds, to find primary per group
      /** @type {Map<number, Set<string>>} */
      const groupAgentMap = new Map();

      for (const part of message.content) {
        const groupId = part?.groupId;
        const agentId = part?.agentId;
        if (groupId != null && agentId) {
          if (!groupAgentMap.has(groupId)) {
            groupAgentMap.set(groupId, new Set());
          }
          groupAgentMap.get(groupId).add(agentId);
        }
      }

      // For each group, find the primary agent
      /** @type {Map<number, string>} */
      const groupPrimaryMap = new Map();
      for (const [groupId, agentIds] of groupAgentMap) {
        const primary = findPrimaryAgentId(agentIds);
        if (primary) {
          groupPrimaryMap.set(groupId, primary);
        }
      }

      /** @type {Array<TMessageContentParts>} */
      const filteredContent = [];
      /** @type {Record<number, string>} */
      const agentIdMap = {};

      for (const part of message.content) {
        if (!part || typeof part !== 'object') {
          continue;
        }
        const agentId = part?.agentId;
        const groupId = part?.groupId;

        // Filtering logic:
        // - No groupId (handoffs): always include
        // - Has groupId (parallel): only include if it's the primary for that group
        const isParallelPart = groupId != null;
        const groupPrimary = isParallelPart ? groupPrimaryMap.get(groupId) : null;
        const shouldInclude = !isParallelPart || !agentId || agentId === groupPrimary;

        if (shouldInclude) {
          const newIndex = filteredContent.length;
          const { agentId: _a, groupId: _g, ...cleanPart } = part;
          filteredContent.push(cleanPart);
          if (agentId && hasMultipleAgents) {
            agentIdMap[newIndex] = agentId;
          }
        }
      }

      const finalContent =
        Object.keys(agentIdMap).length > 0 && agentNames
          ? labelContentByAgent(filteredContent, agentIdMap, agentNames)
          : filteredContent;

      return { ...message, content: finalContent };
    } catch (error) {
      logger.error('[AgentClient] Error processing multi-agent message:', error);
      return message;
    }
  };
}

/* === VIVENTIUM START ===
 * Feature: GlassHive MCP upload/context propagation
 * Purpose: Reuse the existing request body projection used by MCP headers so UI,
 * API, and voice agent runs pass the same attachments/tool resources to GlassHive.
 * Added: 2026-04-28
 * === VIVENTIUM END === */
function buildViventiumMcpRequestBody({
  messageId,
  conversationId,
  parentMessageId,
  req,
  attachments,
  toolResources,
}) {
  const files = Array.isArray(attachments)
    ? attachments.map((file) => {
        const metadata = file?.metadata?.fileIdentifier
          ? { fileIdentifier: file.metadata.fileIdentifier }
          : undefined;
        return {
          file_id: file?.file_id,
          temp_file_id: file?.temp_file_id,
          filename: file?.filename,
          filepath: file?.filepath,
          source: file?.source,
          context: file?.context,
          type: file?.type,
          bytes: file?.bytes,
          width: file?.width,
          height: file?.height,
          ...(metadata ? { metadata } : {}),
          ...(typeof file?.text === 'string' ? { text: file.text } : {}),
        };
      })
    : [];
  return {
    messageId,
    conversationId,
    parentMessageId,
    viventiumSurface: req?.body?.viventiumSurface,
    viventiumInputMode: req?.body?.viventiumInputMode,
    viventiumStreamId: req?.body?.streamId || req?._resumableStreamId,
    viventiumVoiceRequestId: req?.viventiumVoiceRequestId,
    viventiumVoiceCallSessionId: req?.viventiumCallSession?.callSessionId,
    viventiumTelegramChatId: req?.body?.telegramChatId,
    viventiumTelegramUserId: req?.body?.telegramUserId,
    viventiumTelegramMessageId: req?.body?.telegramMessageId,
    ...(files.length ? { files, attachments: files, file_ids: files.map((file) => file.file_id).filter(Boolean) } : {}),
    ...(toolResources ? { tool_resources: toolResources } : {}),
  };
}
/* === VIVENTIUM START ===
 * Feature: GlassHive MCP upload/context propagation
 * Added: 2026-04-28
 * === VIVENTIUM END === */

class AgentClient extends BaseClient {
  constructor(options = {}) {
    super(null, options);
    /** The current client class
     * @type {string} */
    this.clientName = EModelEndpoint.agents;

    /** @type {'discard' | 'summarize'} */
    this.contextStrategy = 'discard';

    /** @deprecated @type {true} - Is a Chat Completion Request */
    this.isChatCompletion = true;

    /** @type {AgentRun} */
    this.run;

    const {
      agentConfigs,
      contentParts,
      collectedUsage,
      artifactPromises,
      maxContextTokens,
      ...clientOptions
    } = options;

    this.agentConfigs = agentConfigs;
    this.maxContextTokens = maxContextTokens;
    /** @type {MessageContentComplex[]} */
    this.contentParts = contentParts;
    /** @type {Array<UsageMetadata>} */
    this.collectedUsage = collectedUsage;
    /** @type {ArtifactPromises} */
    this.artifactPromises = artifactPromises;
    /** @type {AgentClientOptions} */
    this.options = Object.assign({ endpoint: options.endpoint }, clientOptions);
    /** @type {string} */
    this.model = this.options.agent.model_parameters.model;
    /** The key for the usage object's input tokens
     * @type {string} */
    this.inputTokensKey = 'input_tokens';
    /** The key for the usage object's output tokens
     * @type {string} */
    this.outputTokensKey = 'output_tokens';
    /** @type {UsageMetadata} */
    this.usage;
    /** @type {Record<string, number>} */
    this.indexTokenCountMap = {};
    /** @type {(messages: BaseMessage[]) => Promise<void>} */
    this.processMemory;
  }

  /**
   * Returns the aggregated content parts for the current run.
   * @returns {MessageContentComplex[]} */
  getContentParts() {
    return this.contentParts;
  }

  setOptions(_options) {}

  /**
   * `AgentClient` is not opinionated about vision requests, so we don't do anything here
   * @param {MongoFile[]} attachments
   */
  checkVisionRequest() {}

  getSaveOptions() {
    // TODO:
    // would need to be override settings; otherwise, model needs to be undefined
    // model: this.override.model,
    // instructions: this.override.instructions,
    // additional_instructions: this.override.additional_instructions,
    let runOptions = {};
    try {
      runOptions = payloadParser(this.options);
    } catch (error) {
      logger.error(
        '[api/server/controllers/agents/client.js #getSaveOptions] Error parsing options',
        error,
      );
    }

    return removeNullishValues(
      Object.assign(
        {
          endpoint: this.options.endpoint,
          agent_id: this.options.agent.id,
          modelLabel: this.options.modelLabel,
          maxContextTokens: this.options.maxContextTokens,
          resendFiles: this.options.resendFiles,
          imageDetail: this.options.imageDetail,
          spec: this.options.spec,
          iconURL: this.options.iconURL,
        },
        // TODO: PARSE OPTIONS BY PROVIDER, MAY CONTAIN SENSITIVE DATA
        runOptions,
      ),
    );
  }

  /**
   * Returns build message options. For AgentClient, agent-specific instructions
   * are retrieved directly from agent objects in buildMessages, so this returns empty.
   * @returns {Object} Empty options object
   */
  getBuildMessagesOptions() {
    return {};
  }

  /**
   *
   * @param {TMessage} message
   * @param {Array<MongoFile>} attachments
   * @returns {Promise<Array<Partial<MongoFile>>>}
   */
  async addImageURLs(message, attachments) {
    const { files, image_urls } = await encodeAndFormat(
      this.options.req,
      attachments,
      {
        provider: this.options.agent.provider,
        endpoint: this.options.endpoint,
      },
      VisionModes.agents,
    );
    message.image_urls = image_urls.length ? image_urls : undefined;
    return files;
  }

  async buildMessages(messages, parentMessageId, _buildOptions, opts) {
    const req = this.options.req;
    const buildStart = startDeepTiming(req);
    if (isDeepTimingEnabled(req)) {
      logDeepTiming(req, 'build_messages_start', null, `count=${messages?.length ?? 0}`);
    }
    /** Always pass mapMethod; getMessagesForConversation applies it only to messages with addedConvo flag */
    const orderedMessages = this.constructor.getMessagesForConversation({
      messages,
      parentMessageId,
      summary: this.shouldSummarize,
      mapMethod: createMultiAgentMapper(this.options.agent, this.agentConfigs),
      mapCondition: (message) => message.addedConvo === true,
      skipCondition: isListenOnlyTranscriptMessage,
    });

    let payload;
    /** @type {number | undefined} */
    let promptTokens;

    /**
     * Extract base instructions for all agents (combines instructions + additional_instructions).
     * This must be done before applying context to preserve the original agent configuration.
     */
    const extractBaseInstructions = (agent) => {
      const baseInstructions = [agent.instructions ?? '', agent.additional_instructions ?? '']
        .filter(Boolean)
        .join('\n')
        .trim();
      agent.instructions = baseInstructions;
      /* === VIVENTIUM FIX ===
       * Clear additional_instructions after merging into instructions.
       * Without this, run.ts buildAgentContext appends additional_instructions a second time
       * (after Wing Mode / surface prompts), diluting voice behavior contracts like Wing Mode.
       */
      agent.additional_instructions = '';
      return agent;
    };

    /** Collect all agents for unified processing, extracting base instructions during collection */
    const allAgents = [
      { agent: extractBaseInstructions(this.options.agent), agentId: this.options.agent.id },
      ...(this.agentConfigs?.size > 0
        ? Array.from(this.agentConfigs.entries()).map(([agentId, agent]) => ({
            agent: extractBaseInstructions(agent),
            agentId,
          }))
        : []),
    ];

    if (this.options.attachments) {
      const attachmentsStart = startDeepTiming(req);
      const attachments = await this.options.attachments;
      const latestMessage = orderedMessages[orderedMessages.length - 1];

      if (this.message_file_map) {
        this.message_file_map[latestMessage.messageId] = attachments;
      } else {
        this.message_file_map = {
          [latestMessage.messageId]: attachments,
        };
      }

      await this.addFileContextToMessage(latestMessage, attachments);
      const files = await this.processAttachments(latestMessage, attachments);

      this.options.attachments = files;
      if (isDeepTimingEnabled(req)) {
        logDeepTiming(
          req,
          'build_messages_attachments',
          attachmentsStart,
          `files=${attachments?.length ?? 0}`,
        );
      }
    }

    /* === VIVENTIUM NOTE ===
     * Feature: Gateway image upload injection (Telegram + generic channel gateway).
     * Purpose: Allow gateway images to bypass MongoFile system and go directly to vision models.
     * Added: 2026-01-31 (Telegram), expanded 2026-02-19 (generic gateway)
     * === VIVENTIUM NOTE END === */
    const telegramImages = this.options.req?._telegramImages;
    const gatewayImages = this.options.req?._gatewayImages;
    const injectedImages = [
      ...(Array.isArray(telegramImages) ? telegramImages : []),
      ...(Array.isArray(gatewayImages) ? gatewayImages : []),
    ];
    if (injectedImages.length > 0) {
      const latestMessage = orderedMessages[orderedMessages.length - 1];
      if (latestMessage) {
        // Merge gateway images with any existing image_urls.
        latestMessage.image_urls = [
          ...(latestMessage.image_urls || []),
          ...injectedImages,
        ];
        logger.info(
          '[VIVENTIUM][AgentClient] Injected %d gateway image(s) into message',
          injectedImages.length,
        );
      }
    }
    /* === VIVENTIUM NOTE END === */

    /** Note: Bedrock uses legacy RAG API handling */
    if (this.message_file_map && !isAgentsEndpoint(this.options.endpoint)) {
      this.contextHandlers = createContextHandlers(
        this.options.req,
        orderedMessages[orderedMessages.length - 1].text,
      );
    }

    const formattedMessages = orderedMessages.map((message, i) => {
      const formattedMessage = formatMessage({
        message,
        userName: this.options?.name,
        assistantName: this.options?.modelLabel,
      });

      /** For non-latest messages, prepend file context directly to message content */
      if (message.fileContext && i !== orderedMessages.length - 1) {
        if (typeof formattedMessage.content === 'string') {
          formattedMessage.content = message.fileContext + '\n' + formattedMessage.content;
        } else {
          const textPart = formattedMessage.content.find(
            (part) => part && typeof part === 'object' && part.type === 'text',
          );
          textPart
            ? (textPart.text = message.fileContext + '\n' + textPart.text)
            : formattedMessage.content.unshift({ type: 'text', text: message.fileContext });
        }
      }

      const needsTokenCount =
        (this.contextStrategy && !orderedMessages[i].tokenCount) || message.fileContext;

      /* If tokens were never counted, or, is a Vision request and the message has files, count again */
      if (needsTokenCount || (this.isVisionModel && (message.image_urls || message.files))) {
        orderedMessages[i].tokenCount = this.getTokenCountForMessage(formattedMessage);
      }

      /* If message has files, calculate image token cost */
      if (this.message_file_map && this.message_file_map[message.messageId]) {
        const attachments = this.message_file_map[message.messageId];
        for (const file of attachments) {
          if (file.embedded) {
            this.contextHandlers?.processFile(file);
            continue;
          }
          if (file.metadata?.fileIdentifier) {
            continue;
          }
          // orderedMessages[i].tokenCount += this.calculateImageTokenCost({
          //   width: file.width,
          //   height: file.height,
          //   detail: this.options.imageDetail ?? ImageDetail.auto,
          // });
        }
      }

      return formattedMessage;
    });

    /**
     * Build shared run context - applies to ALL agents in the run.
     * This includes: file context (latest message), augmented prompt (RAG), memory context.
     */
    const sharedRunContextParts = [];

    /** File context from the latest message (attachments) */
    const latestMessage = orderedMessages[orderedMessages.length - 1];
    if (latestMessage?.fileContext) {
      sharedRunContextParts.push(latestMessage.fileContext);
    }

    /** Augmented prompt from RAG/context handlers */
    if (this.contextHandlers) {
      const contextStart = startDeepTiming(req);
      this.augmentedPrompt = await this.contextHandlers.createContext();
      if (this.augmentedPrompt) {
        sharedRunContextParts.push(this.augmentedPrompt);
      }
      if (isDeepTimingEnabled(req)) {
        logDeepTiming(req, 'build_messages_context', contextStart);
      }
    }

    const memoryRecallStart = startDeepTiming(req);
    const memoryResult = await (async () => {
      const memoryStart = startDeepTiming(req);
      try {
        const withoutKeys = await this.useMemory();
        if (isDeepTimingEnabled(req)) {
          logDeepTiming(req, 'build_messages_use_memory', memoryStart, `hasMemory=${!!withoutKeys}`);
        }
        return withoutKeys || null;
      } catch (error) {
        logger.error('[AgentClient] Failed to build memory context', error);
        if (isDeepTimingEnabled(req)) {
          logDeepTiming(req, 'build_messages_use_memory', memoryStart, 'error=true');
        }
        return null;
      }
    })();
    if (memoryResult) {
      const memoryContext = `${memoryInstructions}\n\n# Existing memory about the user:\n${memoryResult}`;
      sharedRunContextParts.push(memoryContext);
    }
    if (isDeepTimingEnabled(req)) {
      logDeepTiming(
        req,
        'build_messages_memory_context',
        memoryRecallStart,
        `hasMemory=${!!memoryResult}`,
      );
    }
    /* === VIVENTIUM NOTE END === */

    const sharedRunContext = sharedRunContextParts.join('\n\n');

    /* === VIVENTIUM NOTE ===
     * Feature: Conversation recall prompt injection (config-driven, scope-aware).
     *
     * Purpose:
     * - Let the model decide when to use conversation recall through `file_search`.
     * - Keep the recall-use rule in YAML/system prompt space instead of runtime prompt-text
     *   classifiers.
     */
    for (const { agent } of allAgents) {
      if (!agent || typeof agent !== 'object') {
        continue;
      }
      const recallInstructions = buildConversationRecallInstructions({
        req,
        agent,
        user: req.user,
      });
      if (!recallInstructions) {
        continue;
      }
      agent.instructions = [agent.instructions || '', recallInstructions]
        .filter((part) => typeof part === 'string' && part.trim().length > 0)
        .join('\n\n');
    }
    /* === VIVENTIUM NOTE END === */

    /** @type {Record<string, number> | undefined} */
    let tokenCountMap;

    if (this.contextStrategy) {
      const contextStrategyStart = startDeepTiming(req);
      ({ payload, promptTokens, tokenCountMap, messages } = await this.handleContextStrategy({
        orderedMessages,
        formattedMessages,
      }));
      if (isDeepTimingEnabled(req)) {
        logDeepTiming(req, 'build_messages_context_strategy', contextStrategyStart);
      }
    }

    for (let i = 0; i < messages.length; i++) {
      this.indexTokenCountMap[i] = messages[i].tokenCount;
    }

    const result = {
      tokenCountMap,
      prompt: payload,
      promptTokens,
      messages,
    };

    if (promptTokens >= 0 && typeof opts?.getReqData === 'function') {
      opts.getReqData({ promptTokens });
    }

    /**
     * Apply context to all agents.
     * Each agent gets: shared run context + their own base instructions + their own MCP instructions.
     *
     * NOTE: This intentionally mutates agent objects in place. The agentConfigs Map
     * holds references to config objects that will be passed to the graph runtime.
     */
    const applyStart = startDeepTiming(req);
    const ephemeralAgent = this.options.req?.body?.ephemeralAgent;
    const mcpManager = getMCPManager();
    await Promise.all(
      allAgents.map(({ agent, agentId }) =>
        applyContextToAgent({
          agent,
          agentId,
          logger,
          mcpManager,
          sharedRunContext,
          ephemeralAgent: agentId === this.options.agent.id ? ephemeralAgent : undefined,
        }),
      ),
    );
    if (isDeepTimingEnabled(req)) {
      logDeepTiming(req, 'build_messages_apply_context', applyStart, `agents=${allAgents.length}`);
    }

    if (isDeepTimingEnabled(req)) {
      logDeepTiming(
        req,
        'build_messages_done',
        buildStart,
        `promptTokens=${Number.isFinite(promptTokens) ? promptTokens : 'na'}`,
      );
    }
    return result;
  }

  /**
   * Creates a promise that resolves with the memory promise result or undefined after a timeout
   * @param {Promise<(TAttachment | null)[] | undefined>} memoryPromise - The memory promise to await
   * @param {number} timeoutMs - Timeout in milliseconds (default: 3000)
   * @returns {Promise<(TAttachment | null)[] | undefined>}
   */
  async awaitMemoryWithTimeout(memoryPromise, timeoutMs = 3000) {
    if (!memoryPromise) {
      return;
    }

    const req = this.options?.req;
    const waitStart = startDeepTiming(req);
    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Memory processing timeout')), timeoutMs),
      );

      const attachments = await Promise.race([memoryPromise, timeoutPromise]);
      if (isDeepTimingEnabled(req)) {
        logDeepTiming(req, 'memory_wait_done', waitStart, 'timeout=false');
      }
      return attachments;
    } catch (error) {
      if (error.message === 'Memory processing timeout') {
        logger.warn('[AgentClient] Memory processing timed out after 3 seconds');
        if (isDeepTimingEnabled(req)) {
          logDeepTiming(req, 'memory_wait_done', waitStart, 'timeout=true');
        }
      } else {
        logger.error('[AgentClient] Error processing memory:', error);
        if (isDeepTimingEnabled(req)) {
          logDeepTiming(req, 'memory_wait_done', waitStart, 'timeout=error');
        }
      }
      return;
    }
  }

  /**
   * @returns {Promise<string | undefined>}
   */
  async useMemory() {
    const user = this.options.req.user;
    if (user.personalization?.memories === false) {
      return;
    }
    const hasAccess = await checkAccess({
      user,
      permissionType: PermissionTypes.MEMORIES,
      permissions: [Permissions.USE],
      getRoleByName,
    });

    if (!hasAccess) {
      logger.debug(
        `[api/server/controllers/agents/client.js #useMemory] User ${user.id} does not have USE permission for memories`,
      );
      return;
    }
	    const appConfig = this.options.req.config;
	    const memoryConfig = appConfig.memory;
	    if (!memoryConfig || memoryConfig.disabled === true) {
	      return;
	    }

	    const userId = this.options.req.user.id + '';
	    const memoryMethods = {
	      setMemory: db.setMemory,
	      deleteMemory: db.deleteMemory,
	      getFormattedMemories: db.getFormattedMemories,
	      getAllUserMemories: db.getAllUserMemories,
	    };
	    const memoryPolicyConfig = {
	      validKeys: memoryConfig.validKeys,
	      tokenLimit: resolveMemoryTokenLimit(memoryConfig.tokenLimit),
	      keyLimits: memoryConfig.keyLimits,
	      maintenanceThresholdPercent: memoryConfig.maintenanceThresholdPercent,
	    };
	    let memorySnapshot;
	    try {
	      memorySnapshot = await loadMemorySnapshot({
	        userId,
	        memoryMethods,
	        config: memoryPolicyConfig,
	      });
	    } catch (error) {
	      logger.error(
	        '[api/server/controllers/agents/client.js #useMemory] Error loading stored memories',
	        error,
	      );
    }

    /** @type {Agent} */
    let prelimAgent;
    const allowedProviders = new Set(
      appConfig?.endpoints?.[EModelEndpoint.agents]?.allowedProviders,
    );
    try {
      if (memoryConfig.agent?.id != null && memoryConfig.agent.id !== this.options.agent.id) {
        prelimAgent = await loadAgent({
          req: this.options.req,
          agent_id: memoryConfig.agent.id,
          endpoint: EModelEndpoint.agents,
        });
      } else if (memoryConfig.agent?.id != null) {
        prelimAgent = this.options.agent;
      } else if (
        memoryConfig.agent?.id == null &&
        memoryConfig.agent?.model != null &&
        memoryConfig.agent?.provider != null
      ) {
        prelimAgent = { id: Constants.EPHEMERAL_AGENT_ID, ...memoryConfig.agent };
      }
    } catch (error) {
      logger.error(
        '[api/server/controllers/agents/client.js #useMemory] Error loading agent for memory',
        error,
      );
    }

    if (!prelimAgent) {
      return memorySnapshot?.withoutKeys;
    }

    let agent;
    try {
      agent = await initializeAgent(
        {
          req: this.options.req,
          res: this.options.res,
          agent: prelimAgent,
          allowedProviders,
          endpointOption: {
            endpoint: !isEphemeralAgentId(prelimAgent.id)
              ? EModelEndpoint.agents
              : memoryConfig.agent?.provider,
          },
        },
        {
          getConvoFiles,
          getFiles: db.getFiles,
          getUserKey: db.getUserKey,
          updateUserKey: db.updateUserKey,
          updateFilesUsage: db.updateFilesUsage,
          getUserKeyValues: db.getUserKeyValues,
          getToolFilesByIds: db.getToolFilesByIds,
          getCodeGeneratedFiles: db.getCodeGeneratedFiles,
          getLatestRecallEligibleMessageCreatedAt: db.getLatestRecallEligibleMessageCreatedAt,
        },
      );
    } catch (error) {
      logger.error(
        '[api/server/controllers/agents/client.js #useMemory] Error initializing memory writer',
        {
          error,
          provider: memoryConfig?.agent?.provider,
          model: memoryConfig?.agent?.model,
          errorMessage: error?.message,
          errorCode: error?.code,
          errorType: error?.type,
        },
      );
      return memorySnapshot?.withoutKeys;
    }

    if (!agent) {
      logger.warn(
        '[api/server/controllers/agents/client.js #useMemory] No agent found for memory',
        memoryConfig,
      );
      return memorySnapshot?.withoutKeys;
    }

    const llmConfig = Object.assign(
      {
        provider: agent.provider,
        model: agent.model,
      },
      agent.model_parameters,
    );

    /** @type {import('@librechat/api').MemoryConfig} */
    const config = {
      validKeys: memoryConfig.validKeys,
      instructions: agent.instructions,
      llmConfig,
      tokenLimit: resolveMemoryTokenLimit(memoryConfig.tokenLimit),
      /* === VIVENTIUM START ===
       * Feature: Memory per-key budgets and maintenance threshold
       * Added: 2026-03-09
       * === VIVENTIUM END === */
      keyLimits: memoryConfig.keyLimits,
      maintenanceThresholdPercent: memoryConfig.maintenanceThresholdPercent,
    };

    /* === VIVENTIUM NOTE ===
     * Feature: Time context injection for memory agent
     *
     * Purpose:
     * - Prevent future-dated / temporally inconsistent memory writes by ensuring the memory agent
     *   gets the same canonical "Current time: ..." context as the main agent.
     * - The memory agent prompt uses this to set `_updated`, `_confirmed`, and `_expires` markers.
     *
     * Added: 2026-02-07
     * === VIVENTIUM NOTE END === */
    const memoryTimeContextInstructions = buildTimeContextInstructions(this.options.req);
    if (memoryTimeContextInstructions) {
      config.instructions = [config.instructions || '', memoryTimeContextInstructions]
        .filter(Boolean)
        .join('\n\n');
    }

	    const messageId = this.responseMessageId + '';
	    const conversationId = this.conversationId + '';
	    const streamId = this.options.req?._resumableStreamId || null;
	    let withoutKeys;
	    let processMemory;
	    try {
	      [withoutKeys, processMemory] = await createMemoryProcessor({
	        userId,
	        config,
	        messageId,
	        streamId,
	        conversationId,
	        memoryMethods,
	        res: this.options.res,
	        user: createSafeUser(this.options.req.user),
	        snapshot: memorySnapshot,
	      });
	    } catch (error) {
	      logger.error(
	        '[api/server/controllers/agents/client.js #useMemory] Error creating memory processor',
	        error,
	      );
	      return memorySnapshot?.withoutKeys;
	    }

	    this.processMemory = processMemory;
	    return withoutKeys ?? memorySnapshot?.withoutKeys;
	  }

  /**
   * Filters out image URLs from message content
   * @param {BaseMessage} message - The message to filter
   * @returns {BaseMessage} - A new message with image URLs removed
   */
  filterImageUrls(message) {
    if (!message.content || typeof message.content === 'string') {
      return message;
    }

    if (Array.isArray(message.content)) {
      const filteredContent = message.content.filter((part) => {
        if (part == null) {
          return false;
        }
        if (typeof part === 'string') {
          return true;
        }
        if (typeof part !== 'object') {
          return false;
        }
        return part.type !== ContentTypes.IMAGE_URL;
      });

      if (
        filteredContent.length === 1 &&
        typeof filteredContent[0] === 'object' &&
        filteredContent[0]?.type === ContentTypes.TEXT
      ) {
        const MessageClass = message.constructor;
        return new MessageClass({
          content: filteredContent[0].text,
          additional_kwargs: message.additional_kwargs,
        });
      }

      const MessageClass = message.constructor;
      return new MessageClass({
        content: filteredContent,
        additional_kwargs: message.additional_kwargs,
      });
    }

    return message;
  }

  /**
   * @param {BaseMessage[]} messages
   * @returns {Promise<void | (TAttachment | null)[]>}
   */
  async runMemory(messages) {
    const req = this.options?.req;
    const memStart = startDeepTiming(req);
    if (isDeepTimingEnabled(req)) {
      logDeepTiming(req, 'memory_run_start', null, `count=${messages?.length ?? 0}`);
    }
    try {
      if (this.processMemory == null) {
        return;
      }
      const appConfig = this.options.req.config;
      const memoryConfig = appConfig.memory;
      const messageWindowSize = memoryConfig?.messageWindowSize ?? 5;
      const historyContextMessageScanLimit = memoryConfig?.historyContextMessageScanLimit ?? 40;
      const historyContextUserTurnLimit = memoryConfig?.historyContextUserTurnLimit ?? 4;
      const historyContextCharLimit = memoryConfig?.historyContextCharLimit ?? 1200;

      let messagesToProcess = [...messages];
      let windowStartIndex = 0;
      if (messages.length > messageWindowSize) {
        for (let i = messages.length - messageWindowSize; i >= 0; i--) {
          const potentialWindow = messages.slice(i, i + messageWindowSize);
          if (potentialWindow[0]?.role === 'user') {
            messagesToProcess = [...potentialWindow];
            windowStartIndex = i;
            break;
          }
        }

        if (messagesToProcess.length === messages.length) {
          windowStartIndex = Math.max(0, messages.length - messageWindowSize);
          messagesToProcess = [...messages.slice(-messageWindowSize)];
        }
      }

      const historicalUserContext = buildHistoricalUserContextBuffer({
        messages,
        windowStartIndex,
        scanLimit: historyContextMessageScanLimit,
        userTurnLimit: historyContextUserTurnLimit,
        charLimit: historyContextCharLimit,
        transformMessage: (message) => this.filterImageUrls(message),
      });
      const filteredMessages = messagesToProcess.map((msg) => this.filterImageUrls(msg));
      const bufferString = buildMemoryBufferString(filteredMessages);
      if (!bufferString) {
        if (isDeepTimingEnabled(req)) {
          logDeepTiming(req, 'memory_run_done', memStart, 'status=skipped sanitized_empty=true');
        }
        return;
      }
      const sections = [];
      if (historicalUserContext) {
        sections.push(`# Recent User Context Outside Current Chat Window:\n\n${historicalUserContext}`);
      }
      sections.push(`# Current Chat:\n\n${bufferString}`);
      const bufferMessage = new HumanMessage(sections.join('\n\n'));
      const result = await this.processMemory([bufferMessage]);
      if (isDeepTimingEnabled(req)) {
        logDeepTiming(req, 'memory_run_done', memStart, 'status=ok');
      }
      return result;
    } catch (error) {
      logger.error('Memory Agent failed to process memory', error);
      if (isDeepTimingEnabled(req)) {
        logDeepTiming(req, 'memory_run_done', memStart, 'status=error');
      }
    }
  }

  /** @type {sendCompletion} */
  async sendCompletion(payload, opts = {}) {
    await this.chatCompletion({
      payload,
      onProgress: opts.onProgress,
      userMCPAuthMap: opts.userMCPAuthMap,
      abortController: opts.abortController,
    });

    /* === VIVENTIUM START ===
     * Feature: Agent Fallback LLM
     * Purpose: If the primary provider fails before any assistant text is produced,
     * retry once with the user-configured fallback route.
     * Added: 2026-04-28
     */
    const fallbackAgent = this.options.agent?.viventiumFallbackLlm;
    if (fallbackAgent && shouldRetryWithFallback(this.contentParts)) {
      const primaryProvider = this.options.agent?.provider || this.options.agent?.endpoint || 'unknown';
      const primaryModel =
        this.options.agent?.model || this.options.agent?.model_parameters?.model || 'unknown';
      const fallbackProvider = fallbackAgent.provider || fallbackAgent.endpoint || 'unknown';
      const fallbackModel = fallbackAgent.model || fallbackAgent.model_parameters?.model || 'unknown';
      logger.warn(
        `[AgentClient] Primary model ${primaryProvider}/${primaryModel} failed before assistant text; retrying with fallback ${fallbackProvider}/${fallbackModel}`,
      );
      this.contentParts.length = 0;
      this.options.agent = fallbackAgent;
      this.options.attachments = fallbackAgent.attachments ?? this.options.attachments;
      this.options.resendFiles = fallbackAgent.resendFiles ?? this.options.resendFiles;
      this.options.maxContextTokens = fallbackAgent.maxContextTokens ?? this.options.maxContextTokens;
      this.model = fallbackModel;
      await this.chatCompletion({
        payload,
        onProgress: opts.onProgress,
        userMCPAuthMap: fallbackAgent.userMCPAuthMap ?? opts.userMCPAuthMap,
        abortController: opts.abortController,
      });
    }
    /* === VIVENTIUM END === */

    const completion = normalizeTextContentParts(filterMalformedContentParts(this.contentParts));
    return { completion };
  }

  /**
   * @param {Object} params
   * @param {string} [params.model]
   * @param {string} [params.context='message']
   * @param {AppConfig['balance']} [params.balance]
   * @param {AppConfig['transactions']} [params.transactions]
   * @param {UsageMetadata[]} [params.collectedUsage=this.collectedUsage]
   */
	  async recordCollectedUsage({
	    model,
	    balance,
	    transactions,
	    context = 'message',
	    collectedUsage = this.collectedUsage,
	  }) {
	    const result = await recordCollectedUsageWithDeps(
	      {
	        spendTokens,
	        spendStructuredTokens,
	        pricing: { getMultiplier, getCacheMultiplier },
	        bulkWriteOps: { insertMany: bulkInsertTransactions, updateBalance },
	      },
	      {
	        user: this.user ?? this.options.req.user?.id,
	        conversationId: this.conversationId,
	        collectedUsage,
	        model: model ?? this.model ?? this.options.agent.model_parameters.model,
	        context,
	        messageId: this.responseMessageId,
	        balance,
	        transactions,
	        endpointTokenConfig: this.options.endpointTokenConfig,
	      },
	    );

	    if (result) {
	      this.usage = result;
	    }
	  }

  /**
   * Get stream usage as returned by this client's API response.
   * @returns {UsageMetadata} The stream usage object.
   */
  getStreamUsage() {
    return this.usage;
  }

  /**
   * @param {TMessage} responseMessage
   * @returns {number}
   */
  getTokenCountForResponse({ content }) {
    return this.getTokenCountForMessage({
      role: 'assistant',
      content,
    });
  }

  /**
   * Calculates the correct token count for the current user message based on the token count map and API usage.
   * Edge case: If the calculation results in a negative value, it returns the original estimate.
   * If revisiting a conversation with a chat history entirely composed of token estimates,
   * the cumulative token count going forward should become more accurate as the conversation progresses.
   * @param {Object} params - The parameters for the calculation.
   * @param {Record<string, number>} params.tokenCountMap - A map of message IDs to their token counts.
   * @param {string} params.currentMessageId - The ID of the current message to calculate.
   * @param {OpenAIUsageMetadata} params.usage - The usage object returned by the API.
   * @returns {number} The correct token count for the current user message.
   */
  calculateCurrentTokenCount({ tokenCountMap, currentMessageId, usage }) {
    const originalEstimate = tokenCountMap[currentMessageId] || 0;

    if (!usage || typeof usage[this.inputTokensKey] !== 'number') {
      return originalEstimate;
    }

    tokenCountMap[currentMessageId] = 0;
    const totalTokensFromMap = Object.values(tokenCountMap).reduce((sum, count) => {
      const numCount = Number(count);
      return sum + (isNaN(numCount) ? 0 : numCount);
    }, 0);
    const totalInputTokens = usage[this.inputTokensKey] ?? 0;

    const currentMessageTokens = totalInputTokens - totalTokensFromMap;
    return currentMessageTokens > 0 ? currentMessageTokens : originalEstimate;
  }

  /**
   * @param {object} params
   * @param {string | ChatCompletionMessageParam[]} params.payload
   * @param {Record<string, Record<string, string>>} [params.userMCPAuthMap]
   * @param {AbortController} [params.abortController]
   */
  async chatCompletion({ payload, userMCPAuthMap, abortController = null }) {
    /** @type {Partial<GraphRunnableConfig>} */
    let config;
    /** @type {ReturnType<createRun>} */
    let run;
    /** @type {Promise<(TAttachment | null)[] | undefined>} */
    let memoryPromise;
    const req = this.options.req;
    const chatStart = startDeepTiming(req);
    const voiceLatencyEnabled = isVoiceLatencyEnabled(req);
    const voiceChatStartAt = Date.now();
    if (voiceLatencyEnabled) {
      const agentModel = this.options.agent?.model_parameters?.model || this.options.agent?.model || 'unknown';
      const agentProvider = this.options.agent?.provider || 'unknown';
      logVoiceLatencyStage(
        req,
        'chat_completion_start',
        voiceChatStartAt,
        `conversation_id=${this.conversationId || 'unknown'} provider=${agentProvider} model=${agentModel}`,
      );
    }
    if (isDeepTimingEnabled(req)) {
      logDeepTiming(
        req,
        'chat_completion_start',
        null,
        `model=${this.options.agent?.model_parameters?.model || this.options.agent?.model || 'na'}`,
      );
    }
    const appConfig = this.options.req.config;
    const balanceConfig = getBalanceConfig(appConfig);
    const transactionsConfig = getTransactionsConfig(appConfig);
    try {
      if (!abortController) {
        abortController = new AbortController();
      }

      /** @type {AppConfig['endpoints']['agents']} */
      const agentsEConfig = appConfig.endpoints?.[EModelEndpoint.agents];

      config = {
        runName: 'AgentRun',
        configurable: {
          thread_id: this.conversationId,
          last_agent_index: this.agentConfigs?.size ?? 0,
          user_id: this.user ?? this.options.req.user?.id,
          hide_sequential_outputs: this.options.agent.hide_sequential_outputs,
          requestBody: buildViventiumMcpRequestBody({
            messageId: this.responseMessageId,
            conversationId: this.conversationId,
            parentMessageId: this.parentMessageId,
            req,
            attachments: this.options.attachments,
            toolResources: this.options.agent?.tool_resources,
          }),
          user: createSafeUser(this.options.req.user),
        },
        recursionLimit: agentsEConfig?.recursionLimit ?? 25,
        signal: abortController.signal,
        streamMode: 'values',
        version: 'v2',
      };

      const toolSet = new Set((this.options.agent.tools ?? []).map((tool) => tool && tool.name));

      const voiceMode = this.options.req?.body?.voiceMode === true;
      const voiceProvider = this.options.req?.body?.voiceProvider;
      /* === VIVENTIUM NOTE === */
      const inputMode = (this.options.req?.body?.viventiumInputMode || '').toString().toLowerCase();
      const surface = resolveViventiumSurface(this.options.req);
      const isTelegramSurface = surface === 'telegram';
      const isPlaygroundSurface = surface === 'playground';
      /* === VIVENTIUM NOTE END === */

      // Handle Voice Gateway insight delivery requests.
      const viventiumInsightInstructions = this.options.req?.body?.viventiumInsightInstructions;
      if (viventiumInsightInstructions) {
        logger.info('[AgentClient] Voice Gateway insight delivery - injecting insight instructions');
        this.options.agent.instructions = [
          this.options.agent.instructions || '',
          viventiumInsightInstructions,
        ].filter(Boolean).join('\n\n');
      }

      // Voice-mode prompt injection (Cartesia-friendly tags)
      if (voiceMode) {
        const voiceInstructions = buildVoiceModeInstructions(voiceProvider);
        if (voiceInstructions) {
          this.options.agent.instructions = [
            this.options.agent.instructions || '',
            voiceInstructions,
          ].filter(Boolean).join('\n\n');
        }
      }
      /* === VIVENTIUM NOTE ===
       * Feature: Voice note transcription hints + Telegram text formatting.
       */
      if (inputMode === 'voice_note') {
        const voiceNoteInstructions = buildVoiceNoteInputInstructions();
        if (voiceNoteInstructions) {
          this.options.agent.instructions = [
            this.options.agent.instructions || '',
            voiceNoteInstructions,
          ].filter(Boolean).join('\n\n');
        }
      }
      if (inputMode === 'voice_call') {
        const voiceCallInstructions = buildVoiceCallInputInstructions();
        if (voiceCallInstructions) {
          this.options.agent.instructions = [
            this.options.agent.instructions || '',
            voiceCallInstructions,
          ].filter(Boolean).join('\n\n');
        }

        const wingModeInstructions = isWingModeEnabledForRequest(this.options.req, inputMode)
          ? buildWingModeInstructions()
          : '';
        if (wingModeInstructions) {
          this.options.agent.instructions = [
            this.options.agent.instructions || '',
            wingModeInstructions,
          ].filter(Boolean).join('\n\n');
        }
      }

      if (isTelegramSurface && !voiceMode) {
        const telegramInstructions = buildTelegramTextInstructions();
        if (telegramInstructions) {
          this.options.agent.instructions = [
            this.options.agent.instructions || '',
            telegramInstructions,
          ].filter(Boolean).join('\n\n');
        }
      }
      if (isPlaygroundSurface && !voiceMode) {
        const playgroundInstructions = buildPlaygroundTextInstructions();
        if (playgroundInstructions) {
          this.options.agent.instructions = [
            this.options.agent.instructions || '',
            playgroundInstructions,
          ].filter(Boolean).join('\n\n');
        }
      }

      /* === VIVENTIUM NOTE ===
       * Feature: Time context injection for scheduling awareness
       * Purpose: Provide LLM with user's current local time from client timestamp/timezone.
       * Added: 2026-01-31
       */
      const timeContextInstructions = buildTimeContextInstructions(this.options.req);
      if (timeContextInstructions) {
        this.options.agent.instructions = [
          this.options.agent.instructions || '',
          timeContextInstructions,
        ].filter(Boolean).join('\n\n');
      }
      /* === VIVENTIUM NOTE END === */

	      /* === VIVENTIUM NOTE ===
	       * Feature: Sanitize agent payload content parts before formatting.
	       */
	      const sanitizedPayload = normalizeTextPartsInPayload(stripInternalContentParts(payload));
	      const hardenedPayload = Array.isArray(sanitizedPayload)
	        ? sanitizedPayload.map((message) => {
	            if (!message || !Array.isArray(message.content)) {
	              return message;
	            }
	            const nextContent = filterMalformedContentParts(message.content);
	            return nextContent === message.content
	              ? message
	              : { ...message, content: nextContent };
	          })
	        : sanitizedPayload;
	      /* === VIVENTIUM NOTE END === */
	      const formatStart = startDeepTiming(req);
	      let { messages: initialMessages, indexTokenCountMap } = formatAgentMessages(
	        hardenedPayload,
	        this.indexTokenCountMap,
	        toolSet,
	      );
      const preSanitizeCount = initialMessages.length;
      initialMessages = sanitizeProviderFormattedMessages(this.options.agent?.provider, initialMessages);
      if (initialMessages.length !== preSanitizeCount) {
        logger.warn(
          `[AgentClient] Provider sanitizer adjusted formatted messages: provider=${
            this.options.agent?.provider || 'unknown'
          } ${preSanitizeCount} -> ${initialMessages.length}`,
        );
      }

      /* === VIVENTIUM START ===
       * Feature: Anthropic request-byte guard for oversized inline payloads.
       * Why: Token limits miss base64 document bytes, which can trigger Anthropic 413 request_too_large.
       * Behavior: Compact oldest document/tool/text payload segments before any run execution.
       * === VIVENTIUM END === */
      if (isAnthropicProvider(this.options.agent?.provider)) {
        const byteGuard = compactAnthropicMessagesForSize(initialMessages, {
          maxRequestBytes: getAnthropicPayloadGuardConfig().maxRequestBytes,
        });
        if (byteGuard.changed) {
          logger.warn(
            `[AgentClient] Anthropic preflight payload compaction applied bytes=${byteGuard.bytesBefore}->${byteGuard.bytesAfter} docParts=${byteGuard.docPartsCompacted} toolParts=${byteGuard.toolMessagesTruncated} textParts=${byteGuard.textPartsTruncated}`,
          );
        }
      }
      /* === VIVENTIUM END === */

      if (isDeepTimingEnabled(req)) {
        logDeepTiming(req, 'format_agent_messages', formatStart, `messages=${initialMessages.length}`);
      }
      if (voiceLatencyEnabled) {
        const stats = estimateVoiceMessageStats(initialMessages);
        const instructionChars = typeof this.options.agent?.instructions === 'string'
          ? this.options.agent.instructions.length
          : 0;
        const toolDefs = Array.isArray(this.options.agent?.tools) ? this.options.agent.tools.length : 0;
        logVoiceLatencyStage(
          req,
          'format_agent_messages_done',
          voiceChatStartAt,
          `messages=${stats.messageCount} content_chars=${stats.contentChars} json_chars=${stats.jsonChars} instruction_chars=${instructionChars} tool_defs=${toolDefs}`,
        );
      }
      // Voice Gateway may trigger synthetic follow-up requests (e.g., speakInsights)
      // that should NOT run background cortex activation/execution again.
      const suppressBackgroundCortices = this.options.req?.body?.suppressBackgroundCortices === true;
      const cortexDetectTimeoutMs = getCortexDetectTimeoutMs(voiceMode);
      const hasBackgroundCortices =
        cortexDetectTimeoutMs > 0 &&
        !suppressBackgroundCortices &&
        this.options.agent.background_cortices?.length > 0;
      if (voiceLatencyEnabled) {
        const cortexCount = Array.isArray(this.options.agent.background_cortices)
          ? this.options.agent.background_cortices.length
          : 0;
        const baseTimeoutEnv = (process.env.VIVENTIUM_CORTEX_DETECT_TIMEOUT_MS || '').trim() || 'default';
        const voiceTimeoutEnv = (process.env.VIVENTIUM_VOICE_CORTEX_DETECT_TIMEOUT_MS || '').trim() || 'inherit';
        logVoiceLatencyStage(
          req,
          'phase_a_config',
          null,
          `timeout_ms=${cortexDetectTimeoutMs} base_env=${baseTimeoutEnv} voice_env=${voiceTimeoutEnv} ` +
            `phase_a_await_env=${(process.env.VIVENTIUM_VOICE_PHASE_A_AWAIT_MS || '').trim() || 'inherit'} ` +
            `async_env=${(process.env.VIVENTIUM_VOICE_BACKGROUND_AGENT_DETECTION_ASYNC || '').trim() || 'false'} ` +
            `async_allow_tool_hold_env=${(process.env.VIVENTIUM_VOICE_PHASE_A_ASYNC_ALLOW_TOOL_HOLD || '').trim() || 'false'} ` +
            `has_background=${hasBackgroundCortices} suppress=${suppressBackgroundCortices} cortex_count=${cortexCount}`,
        );
      }
      const conversationId =
        this.options.req?.body?.conversationId || this.responseMessageId;
      let responseController = null;
      let turnUserInputTime = 0;  // used to suppress follow-up on user interruption
      // === VIVENTIUM NOTE ===
      // Feature: background follow-up grace window (seconds -> ms)
      const followupGraceMs = getCortexFollowupGraceMs();
      // === VIVENTIUM NOTE END ===

      let activatedCorticesList = [];
      let cortexExecutionPromise = null;
      const pendingCortexParts = [];
      this._phaseBPromise = null;
      // Cache tool-cortex hold decision so Phase B can be configured consistently.
      let toolCortexHoldWanted = false;
      const responseStream = this.options.res;
      const canonicalResponseMessageId = this.responseMessageId;
      const canonicalUserMessageId = this.parentMessageId;


      /* === VIVENTIUM NOTE ===
       * Feature: Background Cortices - Two-Phase Orchestration
       * Purpose: Phase A (detect) → Main Agent Aware → Phase B (execute) → Follow-up
       * Added: 2026-01-XX
       * Updated: 2026-01-XX - Two-phase flow matching viventium_v1 requirements
       *
       * ARCHITECTURE:
       * Phase A (time-limited): Activation detection → Inject awareness → Main agent responds
       * Phase B (async): Execute activated cortices → Merge insights → Same-turn follow-up
       */

      if (hasBackgroundCortices) {
        logger.info(
          `[AgentClient] Starting two-phase background cortex orchestration for ${this.options.agent.background_cortices.length} cortices`
        );

        // Get or create ResponseController
        responseController = getResponseController(conversationId);
        responseController.onUserInput();
        turnUserInputTime = responseController.lastUserInputTime;


        // Helper to emit SSE event
        const emitCortexEvent = async (cortexData, { waitForDelivery = false } = {}) => {
          const statusChangedAt = new Date().toISOString();
          cortexData = {
            ...cortexData,
            status_changed_at: cortexData?.status_changed_at || statusChangedAt,
          };
          // Sanitize cortex_name to remove internal jargon
          if (cortexData.cortex_name) {
            cortexData = {
              ...cortexData,
              cortex_name: sanitizeCortexDisplayName(cortexData.cortex_name),
            };
          }
          // Persist cortex parts onto the main message so they survive refresh/reload.
          // We upsert by cortex_id to keep a single row per cortex.
          const existingIdx = pendingCortexParts.findIndex((p) => p?.cortex_id === cortexData?.cortex_id);
          if (existingIdx >= 0) {
            pendingCortexParts[existingIdx] = cortexData;
          } else {
            pendingCortexParts.push(cortexData);
          }

          const streamId = req?._resumableStreamId;
          const stream = responseStream;
          const streamOpen = stream && !stream.writableEnded && !stream.destroyed;

            /* === VIVENTIUM NOTE ===
             * Feature: Background Cortices - ID synchronization (UI placeholder vs DB messageId)
             *
             * LibreChat streams the in-flight assistant message into a placeholder messageId:
             *   uiMessageId = `${userMessageId}_`
             * where `userMessageId === this.parentMessageId` for non-edited turns.
             *
             * We emit cortex SSE updates against `uiMessageId` so activation/status rows render
             * BEFORE any assistant text, and remain attached during streaming.
             *
             * The canonical DB messageId remains `this.responseMessageId`.
             */
            const uiMessageId =
              typeof canonicalUserMessageId === 'string' && canonicalUserMessageId.length > 0
                ? `${canonicalUserMessageId}_`
                : canonicalResponseMessageId;
            /* === VIVENTIUM NOTE END === */

            const eventPayload = {
              event: 'on_cortex_update',
              data: {
                runId: uiMessageId,
                canonicalMessageId: canonicalResponseMessageId,
                userMessageId: canonicalUserMessageId,
                ...cortexData,
              },
            };

          // Use GenerationJobManager for reliable event delivery (works even after stream closes)
          if (streamId) {
            const emitPromise = GenerationJobManager.emitChunk(streamId, eventPayload);
            if (waitForDelivery) {
              await emitPromise;
            } else {
              emitPromise.catch((err) => {
                logger.warn(
                  '[AgentClient] Failed to emit cortex SSE event:',
                  err?.message ?? String(err),
                );
              });
            }
            logger.info(
              `[AgentClient] Cortex event emitted via GenerationJobManager: status=${cortexData.status}, cortex=${cortexData.cortex_name}`,
            );
          } else if (streamOpen) {
            // Fallback to direct stream if no streamId
            try {
              sendEvent(stream, eventPayload);
              logger.info(
                `[AgentClient] Cortex event emitted via stream: status=${cortexData.status}, cortex=${cortexData.cortex_name}`,
              );
            } catch (err) {
              logger.warn(
                '[AgentClient] Failed to emit cortex SSE event:',
                err?.message ?? String(err),
              );
            }
          } else {
            logger.warn(
              `[AgentClient] Cannot emit cortex event - no streamId and stream closed: status=${cortexData.status}`,
            );
          }
        };

        /* === VIVENTIUM NOTE ===
         * Feature: Voice-only async Phase A detection.
         * When VIVENTIUM_VOICE_BACKGROUND_AGENT_DETECTION_ASYNC=true and in voice mode,
         * Phase A + Phase B run as a non-blocking background pipeline while the main model
         * invoke proceeds immediately. Default (false): Phase A blocks before model invoke.
         * Parity: When disabled or not in voice mode, behavior is identical to standard LibreChat.
         * Added: 2026-03-04
         */
        const voicePhaseAPolicy = resolveVoicePhaseAAsyncPolicy({
          voiceMode,
          agent: this.options.agent,
        });
        const voicePhaseAAsync = voicePhaseAPolicy.enabled;
        if (voicePhaseAPolicy.forcedOff) {
          logger.info(
            `[AgentClient] Phase A async requested but forced off: reason=${voicePhaseAPolicy.reason}`,
          );
          if (voiceLatencyEnabled) {
            logVoiceLatencyStage(
              req,
              'phase_a_async_forced_off',
              voiceChatStartAt,
              `reason=${voicePhaseAPolicy.reason}`,
            );
          }
        }

        if (voicePhaseAAsync) {
          // ASYNC VOICE MODE: run Phase A + Phase B in background and keep follow-up delivery
          // on the shared completion pipeline later in this method.
          if (voiceLatencyEnabled) {
            logVoiceLatencyStage(
              req,
              'phase_a_async_deferred',
              voiceChatStartAt,
              `timeout_ms=${cortexDetectTimeoutMs}`,
            );
          }
          logger.info(
            `[AgentClient] Phase A async mode: deferring detection (${cortexDetectTimeoutMs}ms budget) ` +
            `for ${this.options.agent.background_cortices.length} cortices`,
          );

          const asyncReq = req;
          const asyncRes = responseStream;
          const asyncAgent = this.options.agent;
          const asyncRunId = canonicalResponseMessageId;
          cortexExecutionPromise = (async () => {
            try {
              const asyncDetectStart = Date.now();
              const asyncDetectionResult = await detectActivations({
                req: asyncReq,
                mainAgent: asyncAgent,
                messages: initialMessages,
                runId: asyncRunId,
                timeBudgetMs: cortexDetectTimeoutMs,
              });

              activatedCorticesList = asyncDetectionResult.activatedCortices;
              const asyncDetectDuration = Date.now() - asyncDetectStart;

              if (voiceLatencyEnabled) {
                logVoiceLatencyStage(
                  req,
                  'phase_a_async_detect_done',
                  asyncDetectStart,
                  `activated=${activatedCorticesList.length} timed_out=${asyncDetectionResult.timedOut === true} detect_ms=${asyncDetectDuration}`,
                );
              }
              logger.info(
                `[AgentClient] Phase A async complete: ${activatedCorticesList.length} cortices activated ` +
                `(duration: ${asyncDetectDuration}ms, timedOut: ${asyncDetectionResult.timedOut})`,
              );

              // Emit activation cards (main response may already be in progress)
              for (const cortex of activatedCorticesList) {
                await emitCortexEvent({
                  type: ContentTypes.CORTEX_ACTIVATION,
                  cortex_id: cortex.agentId,
                  cortex_name: sanitizeCortexDisplayName(cortex.cortexName || cortex.agentId),
                  status: 'activating',
                  confidence: cortex.confidence,
                  reason: cortex.reason,
                  cortex_description: cortex.cortexDescription || '',
                  activation_scope: cortex.activationScope || null,
                  direct_action_surfaces: Array.isArray(cortex.directActionSurfaces)
                    ? cortex.directActionSurfaces
                    : [],
                  direct_action_surface_scopes: Array.isArray(cortex.directActionSurfaceScopes)
                    ? cortex.directActionSurfaceScopes
                    : [],
                }, { waitForDelivery: true });
              }

              // NOTE: In async mode, activation awareness is NOT injected into agent.instructions
              // because the main model invoke has already started or completed.

              if (activatedCorticesList.length === 0) {
                return null;
              }

              // Phase B: Execute activated cortices (non-blocking follow-up)
              logger.info(
                `[AgentClient] Phase B (async): Starting execution of ${activatedCorticesList.length} activated cortices`,
              );
              const directActionScopeKeys = collectDirectActionScopeKeysFromCortices(activatedCorticesList);
              toolCortexHoldWanted = shouldDeferToolCortexMainResponse({
                activatedCortices: activatedCorticesList,
                directActionScopeKeys,
              });
              logger.info(
                `[AgentClient] Tool cortex hold decision (async): hold=${toolCortexHoldWanted} ` +
                  `direct_action_scope_keys=${directActionScopeKeys.join(',') || 'none'}`,
              );
              let mergedInsightsData = null;

              const executionResult = await executeActivated({
                req: asyncReq,
                res: toolCortexHoldWanted ? null : asyncRes,
                mainAgent: asyncAgent,
                messages: initialMessages,
                runId: asyncRunId,
                activatedCortices: activatedCorticesList,
                onCortexBrewing: (cortexData) => {
                  void emitCortexEvent({ ...cortexData, type: ContentTypes.CORTEX_BREWING });
                },
                onCortexComplete: (cortexData) => {
                  void emitCortexEvent({ ...cortexData, type: ContentTypes.CORTEX_INSIGHT });
                },
                onAllComplete: (completeData) => {
                  mergedInsightsData = completeData;
                  logger.info(
                    `[AgentClient] Phase B (async) complete: ${completeData.cortexCount} insights merged`,
                  );
                },
              }).then(() => mergedInsightsData).catch((error) => {
                logger.error('[AgentClient] Phase B execution failed:', error);
                return null;
              });

              return executionResult;
            } catch (error) {
              logger.error('[AgentClient] Async Phase A/B pipeline failed:', error);
              return null;
            }
          })();
        }
        /* === VIVENTIUM NOTE END === */

        if (!voicePhaseAAsync) {
        // SYNC MODE (default, parity): Phase A blocks before model invoke
        // PHASE A: Detect activations (≤2s timeout)
        logger.info(`[AgentClient] Phase A: Detecting activations (${cortexDetectTimeoutMs}ms timeout)`);
        const detectionStartTime = Date.now();
        const voicePhaseAStartedAt = voiceLatencyEnabled ? Date.now() : 0;
        const detectStart = startDeepTiming(req);

        const detectionResult = await detectActivations({
          req: this.options.req,
          mainAgent: this.options.agent,
          messages: initialMessages,
          runId: this.responseMessageId,
          timeBudgetMs: cortexDetectTimeoutMs,
        });

        const detectionDuration = Date.now() - detectionStartTime;
        activatedCorticesList = detectionResult.activatedCortices;
        if (isDeepTimingEnabled(req)) {
          logDeepTiming(
            req,
            'cortex_detect',
            detectStart,
            `activated=${activatedCorticesList.length} timedOut=${detectionResult.timedOut}`,
          );
        }

        logger.info(
          `[AgentClient] Phase A complete: ${activatedCorticesList.length} cortices activated ` +
          `(duration: ${detectionDuration}ms, timedOut: ${detectionResult.timedOut})`
        );
        if (voiceLatencyEnabled) {
          logVoiceLatencyStage(
            req,
            'phase_a_detect_done',
            voicePhaseAStartedAt,
            `activated=${activatedCorticesList.length} timed_out=${detectionResult.timedOut === true}`,
          );
        }


        // Emit activation cards for activated cortices BEFORE the main agent responds.
        // (Avoid spamming non-activated cortices.)
        for (const cortex of activatedCorticesList) {
          await emitCortexEvent({
            type: ContentTypes.CORTEX_ACTIVATION,
            cortex_id: cortex.agentId,
            cortex_name: sanitizeCortexDisplayName(cortex.cortexName || cortex.agentId),
            status: 'activating',
            confidence: cortex.confidence,
            reason: cortex.reason,
            cortex_description: cortex.cortexDescription || '',
            activation_scope: cortex.activationScope || null,
            direct_action_surfaces: Array.isArray(cortex.directActionSurfaces)
              ? cortex.directActionSurfaces
              : [],
            direct_action_surface_scopes: Array.isArray(cortex.directActionSurfaceScopes)
              ? cortex.directActionSurfaceScopes
              : [],
          }, { waitForDelivery: true });
        }

        // Inject activation awareness into agent instructions (single source of truth)
        if (activatedCorticesList.length > 0) {
          const brewingText = formatBrewingAcknowledgment(activatedCorticesList);
          const activationSummary = formatActivationSummary(activatedCorticesList);
          const activationContext = brewingText + activationSummary;

          /* === VIVENTIUM FIX ===
           * Append to agent.instructions instead of creating system message in filteredPayload.
           * This prevents dual system message conflicts with Anthropic API.
           */
          this.options.agent.instructions = [
            this.options.agent.instructions || '',
            activationContext,
          ].filter(Boolean).join('\n\n');

          logger.info(`[AgentClient] Injected activation awareness into agent instructions (${activatedCorticesList.length} cortices)`);
        }

        // Note: formatAgentMessages call is redundant now that we inject into agent.instructions.
        // The initial payload formatting already happened above, so we keep initialMessages as-is.

        // PHASE B: Execute activated cortices (non-blocking, fire-and-forget)
        if (activatedCorticesList.length > 0) {
          logger.info(`[AgentClient] Phase B: Starting execution of ${activatedCorticesList.length} activated cortices (non-blocking)`);

          // Track merged insights for follow-up
          let mergedInsightsData = null;

          // If we're going to defer the main response (tool cortex brewing hold), do NOT pass the live
          // Express response object into background cortex execution. Tool/MCP transports can bind to
          // the response lifecycle and get aborted when the main response ends, leaving cortices stuck.
          const directActionScopeKeys = collectDirectActionScopeKeysFromCortices(activatedCorticesList);
          toolCortexHoldWanted = shouldDeferToolCortexMainResponse({
            activatedCortices: activatedCorticesList,
            directActionScopeKeys,
          });
          logger.info(
            `[AgentClient] Tool cortex hold decision: hold=${toolCortexHoldWanted} ` +
              `direct_action_scope_keys=${directActionScopeKeys.join(',') || 'none'}`,
          );

          cortexExecutionPromise = executeActivated({
            req: this.options.req,
            res: toolCortexHoldWanted ? null : this.options.res,
            mainAgent: this.options.agent,
            messages: initialMessages,
            runId: this.responseMessageId,
            activatedCortices: activatedCorticesList,

            onCortexBrewing: (cortexData) => {
              // Emit SSE for brewing status
              void emitCortexEvent({
                ...cortexData,
                type: ContentTypes.CORTEX_BREWING,
              });
            },

            onCortexComplete: (cortexData) => {
              // Emit SSE for individual completion (UI shows tool-call-like indicator)
              void emitCortexEvent({
                ...cortexData,
                type: ContentTypes.CORTEX_INSIGHT,
              });
            },

            onAllComplete: (completeData) => {
              // Store merged insights for follow-up
              mergedInsightsData = completeData;
              logger.info(
                `[AgentClient] Phase B complete: ${completeData.cortexCount} insights merged, ready for follow-up`
              );
            },
          }).then(() => {
            // Return mergedInsightsData (set by onAllComplete callback) instead of executeActivated return value
            return mergedInsightsData;
          }).catch((error) => {
            logger.error('[AgentClient] Phase B execution failed:', error);
            return null;
          });
        }
        } /* === VIVENTIUM NOTE: end sync Phase A/B path (if !voicePhaseAAsync) === */
      }
      /* === VIVENTIUM NOTE END === */
      if (voiceLatencyEnabled && !hasBackgroundCortices) {
        logVoiceLatencyStage(
          req,
          'phase_a_skipped',
          voiceChatStartAt,
          `timeout_ms=${cortexDetectTimeoutMs} enabled=false`,
        );
      }

      const mainAgentMessages = initialMessages;

      /**
       * @param {BaseMessage[]} messages
       */
      const runAgents = async (messages) => {
        const agents = [this.options.agent];
        // Include additional agents when:
        // - agentConfigs has agents (from addedConvo parallel execution or agent handoffs)
        // - Agents without incoming edges become start nodes and run in parallel automatically
        if (this.agentConfigs && this.agentConfigs.size > 0) {
          agents.push(...this.agentConfigs.values());
        }

        if (agents[0].recursion_limit && typeof agents[0].recursion_limit === 'number') {
          config.recursionLimit = agents[0].recursion_limit;
        }

        if (
          agentsEConfig?.maxRecursionLimit &&
          config.recursionLimit > agentsEConfig?.maxRecursionLimit
        ) {
          config.recursionLimit = agentsEConfig?.maxRecursionLimit;
        }

        /* === VIVENTIUM FIX ===
         * Feature: Wing Mode + voice surface prompt injection for ALL agents.
         *
         * Purpose:
         * - Ensure handoff/parallel agents receive the same Wing Mode and voice surface
         *   instructions as the primary agent, so a handoff during a voice call does not
         *   lose the Wing Mode or voice formatting contract.
         *
         * Why here (runAgents) instead of chatCompletion body:
         * - The primary agent already had these injected in chatCompletion (lines ~1911-1982).
         * - Handoff agents in agentConfigs only become visible here.
         * - We skip the primary agent (agents[0]) to avoid double-injection.
         */
        if (agents.length > 1) {
          const handoffAgents = agents.slice(1);
          for (const agent of handoffAgents) {
            if (!agent || typeof agent !== 'object') {
              continue;
            }
            if (voiceMode) {
              const voiceInstructions = buildVoiceModeInstructions(voiceProvider);
              if (voiceInstructions) {
                agent.instructions = [agent.instructions || '', voiceInstructions]
                  .filter(Boolean).join('\n\n');
              }
            }
            if (inputMode === 'voice_call') {
              const voiceCallInstructions = buildVoiceCallInputInstructions();
              if (voiceCallInstructions) {
                agent.instructions = [agent.instructions || '', voiceCallInstructions]
                  .filter(Boolean).join('\n\n');
              }
              const wingModeInstructions = isWingModeEnabledForRequest(this.options.req, inputMode)
                ? buildWingModeInstructions()
                : '';
              if (wingModeInstructions) {
                agent.instructions = [agent.instructions || '', wingModeInstructions]
                  .filter(Boolean).join('\n\n');
              }
            }
            if (inputMode === 'voice_note') {
              const voiceNoteInstructions = buildVoiceNoteInputInstructions();
              if (voiceNoteInstructions) {
                agent.instructions = [agent.instructions || '', voiceNoteInstructions]
                  .filter(Boolean).join('\n\n');
              }
            }
            if (isTelegramSurface && !voiceMode) {
              const telegramInstructions = buildTelegramTextInstructions();
              if (telegramInstructions) {
                agent.instructions = [agent.instructions || '', telegramInstructions]
                  .filter(Boolean).join('\n\n');
              }
            }
          }
        }
        /* === VIVENTIUM FIX END === */

        /* === VIVENTIUM NOTE ===
         * Feature: No Response Tag ({NTA}) prompt injection (env-gated, config-driven).
         *
         * Purpose:
         * - Ensure ALL agents involved in this Run (primary + any handoff/parallel agents) receive the same
         *   no-response instruction block from `librechat.yaml` when enabled.
         *
         * Notes:
         * - We inject at the LLM "source" (system prompt) so every endpoint/surface behaves consistently.
         */
        const noResponseInstructions = buildNoResponseInstructions(req);
        if (noResponseInstructions) {
          for (const agent of agents) {
            if (!agent || typeof agent !== 'object') {
              continue;
            }
            agent.instructions = [agent.instructions || '', noResponseInstructions]
              .filter((part) => typeof part === 'string' && part.trim().length > 0)
              .join('\n\n');
          }
        }
        /* === VIVENTIUM NOTE END === */

        // TODO: needs to be added as part of AgentContext initialization
        // const noSystemModelRegex = [/\b(o1-preview|o1-mini|amazon\.titan-text)\b/gi];
        // const noSystemMessages = noSystemModelRegex.some((regex) =>
        //   agent.model_parameters.model.match(regex),
        // );
        // if (noSystemMessages === true && systemContent?.length) {
        //   const latestMessageContent = _messages.pop().content;
        //   if (typeof latestMessageContent !== 'string') {
        //     latestMessageContent[0].text = [systemContent, latestMessageContent[0].text].join('\n');
        //     _messages.push(new HumanMessage({ content: latestMessageContent }));
        //   } else {
        //     const text = [systemContent, latestMessageContent].join('\n');
        //     _messages.push(new HumanMessage(text));
        //   }
        // }
        // let messages = _messages;
        // if (agent.useLegacyContent === true) {
        //   messages = formatContentStrings(messages);
        // }
        // if (
        //   agent.model_parameters?.clientOptions?.defaultHeaders?.['anthropic-beta']?.includes(
        //     'prompt-caching',
        //   )
        // ) {
        //   messages = addCacheControl(messages);
        // }

        memoryPromise = this.runMemory(messages);

        /* === VIVENTIUM NOTE ===
         * Feature: Background Cortices (Multi-Agent Brain Architecture)
         * Updated: 2026-01-03
         *
         * Cortex insight injection has been REMOVED from here.
         * With non-blocking execution, cortices run in parallel with the main agent.
         * Insights are:
         * 1. Streamed to UI via contentParts callbacks (real-time visibility)
         * 2. Queued for proactive delivery when user is idle (Phase 6)
         *
         * The main agent responds immediately without waiting for cortex insights.
         * This is intentional - cortex insights surface asynchronously.
         */
        /* === VIVENTIUM NOTE END === */

        const voiceCreateRunStart = voiceLatencyEnabled ? Date.now() : 0;
        const createRunStart = startDeepTiming(req);
        run = await createRun({
          agents,
          indexTokenCountMap,
          runId: this.responseMessageId,
          signal: abortController.signal,
          customHandlers: this.options.eventHandlers,
          requestBody: config.configurable.requestBody,
          user: createSafeUser(this.options.req?.user),
          tokenCounter: createTokenCounter(this.getEncoding()),
        });
        if (isDeepTimingEnabled(req)) {
          logDeepTiming(req, 'create_run', createRunStart, `agents=${agents.length}`);
        }
        if (voiceLatencyEnabled) {
          logVoiceLatencyStage(
            req,
            'create_run_done',
            voiceCreateRunStart,
            `agents=${agents.length}`,
          );
        }

        if (!run) {
          throw new Error('Failed to create run');
        }

        this.run = run;

        const streamId = this.options.req?._resumableStreamId;
        if (streamId && run.Graph) {
          GenerationJobManager.setGraph(streamId, run.Graph);
        }

        if (userMCPAuthMap != null) {
          config.configurable.userMCPAuthMap = userMCPAuthMap;
        }

        /** @deprecated Agent Chain */
        config.configurable.last_agent_id = agents[agents.length - 1].id;
        const voiceProcessStart = voiceLatencyEnabled ? Date.now() : 0;
        const processStart = startDeepTiming(req);
        if (isDeepTimingEnabled(req)) {
          logDeepTiming(req, 'process_stream_start', null, `agents=${agents.length}`);
        }
        if (voiceLatencyEnabled) {
          req._viventiumVoiceProcessStreamStartedAt = voiceProcessStart;
          logVoiceLatencyStage(
            req,
            'process_stream_start',
            voiceProcessStart,
            `agents=${agents.length}`,
          );
        }
        const voiceToolStartTimes = voiceLatencyEnabled ? new Map() : null;
        await run.processStream({ messages }, config, {
          callbacks: {
            [Callback.TOOL_START]: (_graph, ...callbackArgs) => {
              if (!voiceLatencyEnabled) {
                return;
              }
              const tool = extractToolTelemetry(callbackArgs);
              const startedAt = Date.now();
              if (voiceToolStartTimes && tool.id !== 'unknown') {
                voiceToolStartTimes.set(tool.id, startedAt);
              }
              logVoiceLatencyStage(
                req,
                'tool_start',
                voiceProcessStart,
                `tool_name=${tool.name} tool_id=${tool.id}`,
              );
            },
            [Callback.TOOL_END]: (_graph, ...callbackArgs) => {
              if (!voiceLatencyEnabled) {
                return;
              }
              const tool = extractToolTelemetry(callbackArgs);
              let toolStartAt = null;
              if (voiceToolStartTimes && tool.id !== 'unknown') {
                toolStartAt = voiceToolStartTimes.get(tool.id) ?? null;
                voiceToolStartTimes.delete(tool.id);
              }
              const detailParts = [`tool_name=${tool.name}`, `tool_id=${tool.id}`];
              if (toolStartAt != null) {
                detailParts.push(`tool_exec_ms=${Date.now() - toolStartAt}`);
              }
              logVoiceLatencyStage(
                req,
                'tool_end',
                toolStartAt ?? voiceProcessStart,
                detailParts.join(' '),
              );
            },
            [Callback.TOOL_ERROR]: (graph, error, toolId) => {
              if (voiceLatencyEnabled) {
                logVoiceLatencyStage(
                  req,
                  'tool_error',
                  voiceProcessStart,
                  `tool_id=${toolId || 'unknown'} reason=${error?.message || 'unknown'}`,
                );
              }
              logToolError(graph, error, toolId);
            },
          },
        });
        if (isDeepTimingEnabled(req)) {
          logDeepTiming(req, 'process_stream_done', processStart);
        }
        if (voiceLatencyEnabled) {
          logVoiceLatencyStage(
            req,
            'process_stream_done',
            voiceProcessStart,
            `agents=${agents.length}`,
          );
          const orchestrationSummary = buildVoiceOrchestrationSummary(req, voiceProcessStart);
          if (orchestrationSummary) {
            logger.info(
              `[VoiceLatency][LC][OrchSummary] request_id=${getVoiceLatencyRequestId(req)} ${orchestrationSummary}`,
            );
          }
        }

        config.signal = null;
      };

      /* === VIVENTIUM NOTE ===
       * Feature: Tool Cortex Brewing Hold (v0_3 parity)
       *
       * If a tool cortex (ex: online_tool_use) activates, we return a deterministic holding ack
       * instead of relying on the LLM to notice the brewing block and self-censor.
       *
       * Phase B still runs in the background and will deliver results via the follow-up pipeline.
       */
      const hideSequentialOutputs = config.configurable.hide_sequential_outputs;
      const shouldDeferMainResponse =
        cortexExecutionPromise != null &&
        toolCortexHoldWanted === true;
      if (shouldDeferMainResponse) {
        const holdText = pickToolCortexHoldText({
          responseMessageId: this.responseMessageId,
          agentInstructions: this.options.agent.instructions,
          scheduleId: this.options.req?.body?.scheduleId,
        });
        /* === VIVENTIUM START ===
         * Root-cause fix: persist hold text in canonical text-part shape.
         *
         * Why:
         * - Runtime hold responses were being added as `{ text: { value: ... } }` which
         *   is Assistants-style, not the canonical provider-agnostic text-part shape.
         * - Historical malformed text shapes increase strict-provider sanitation pressure
         *   in follow-up/background paths.
         *
         * Behavior:
         * - Persist hold text as plain string on both `text` and `ContentTypes.TEXT`.
         * === VIVENTIUM END === */
        this.contentParts.push(createRuntimeHoldTextPart(holdText));
        logger.info(
          `[AgentClient] Tool cortex brewing hold: deferred main response (activated=${activatedCorticesList.length})`,
        );
      } else {
        /* === VIVENTIUM START ===
         * Feature: Anthropic overflow recovery retry.
         * Why: Even after token checks, request byte overflow may still happen (413 request_too_large).
         * Behavior: On first Anthropic overflow, aggressively compact payload and retry once.
         * === VIVENTIUM END === */
        const runWithAnthropicRecovery = async () => {
          if (!isAnthropicProvider(this.options.agent?.provider)) {
            await runAgents(mainAgentMessages);
            return;
          }

          let recovered = false;
          while (true) {
            try {
              await runAgents(mainAgentMessages);
              return;
            } catch (error) {
              if (recovered || !isAnthropicRequestTooLargeError(error)) {
                throw error;
              }
              const guard = getAnthropicPayloadGuardConfig();
              const recovery = compactAnthropicMessagesForSize(mainAgentMessages, {
                aggressive: true,
                maxRequestBytes: Math.max(1, Math.floor(guard.maxRequestBytes * 0.82)),
              });
              if (!recovery.changed) {
                throw error;
              }
              logger.warn(
                `[AgentClient] Anthropic overflow recovery retry applied bytes=${recovery.bytesBefore}->${recovery.bytesAfter} docParts=${recovery.docPartsCompacted} toolParts=${recovery.toolMessagesTruncated} textParts=${recovery.textPartsTruncated}`,
              );
              recovered = true;
            }
          }
        };

        await runWithAnthropicRecovery();
        /* === VIVENTIUM END === */
        if (isDeepTimingEnabled(req)) {
          logDeepTiming(req, 'chat_completion_done', chatStart);
        }
      }
      /* === VIVENTIUM NOTE END === */
      if (voiceLatencyEnabled) {
        logVoiceLatencyStage(
          req,
          'chat_completion_done',
          voiceChatStartAt,
          `activated=${activatedCorticesList.length}`,
        );
      }
      sanitizeAggregatedContentParts(this.contentParts);
      /** @deprecated Agent Chain */
      if (hideSequentialOutputs) {
        this.contentParts = this.contentParts.filter((part, index) => {
          // Include parts that are either:
          // 1. At or after the finalContentStart index
          // 2. Of type tool_call
          // 3. Have tool_call_ids property
          return (
            index >= this.contentParts.length - 1 ||
            (part &&
              (part.type === ContentTypes.TOOL_CALL || part.tool_call_ids))
          );
        });
      }

      /* === VIVENTIUM NOTE ===
       * Feature: Background Cortices - Persist cortex parts
       * Purpose: Save activation/brewing/insight rows onto the main message (DB persistence)
       */
      if (pendingCortexParts.length > 0) {
        for (const part of pendingCortexParts) {
          this.contentParts.push(part);
        }
        logger.debug(`[AgentClient] Persisted ${pendingCortexParts.length} cortex content parts onto main message`);
      }
      /* === VIVENTIUM NOTE END === */

      /* === VIVENTIUM NOTE ===
       * Feature: Background Cortices - Background follow-up (non-blocking)
       *
       * IMPORTANT:
       * - Main agent response must NOT wait on Phase B.
       * - When Phase B finishes, we persist final cortex status rows onto the canonical assistant
       *   message (DB truth) and optionally create ONE follow-up assistant message.
       * - Follow-up is suppressed if user sends newer input before Phase B finishes.
       */
      if (cortexExecutionPromise) {
        const req = this.options.req;
        const conversationId = this.conversationId;
        const responseMessageId = this.responseMessageId;
        const agent = this.options.agent;
        const responseContentParts = this.contentParts;

        this._phaseBPromise = cortexExecutionPromise
          .then(async (mergedInsightsData) => {
            // Always persist final cortex parts so the UI can stop showing "Analyzing..." on refresh/poll.
            try {
              await persistCortexPartsToCanonicalMessage({
                req,
                responseMessageId,
                cortexParts: pendingCortexParts,
              });
            } catch (e) {
              logger.warn('[AgentClient] Failed to persist final cortex parts to DB:', e);
            }

            // Suppress follow-up if user sent a newer message before completion
            if (responseController && responseController.lastUserInputTime !== turnUserInputTime) {
              if (followupGraceMs <= 0) {
                logger.info('[AgentClient] Suppressing cortex follow-up: user sent newer input');
                return null;
              }
              const ageMs = Date.now() - turnUserInputTime;
              if (ageMs > followupGraceMs) {
                logger.info(
                  '[AgentClient] Suppressing cortex follow-up: user sent newer input (grace expired)',
                );
                return null;
              }
              logger.info(
                '[AgentClient] Allowing cortex follow-up within grace window (%sms)',
                followupGraceMs,
              );
            }

            // Create a single follow-up message if there is anything meaningful to surface
            const hasInsights =
              Array.isArray(mergedInsightsData?.insights) && mergedInsightsData.insights.length > 0;
            const hasMergedText =
              typeof mergedInsightsData?.mergedPrompt === 'string' &&
              mergedInsightsData.mergedPrompt.trim().length > 0;
            const hasErrors = mergedInsightsData?.hasErrors === true;
            // Only surface error-only follow-ups when the main response was intentionally deferred
            // (tool cortex brewing hold). Otherwise this feels like a random system notification.
            const allowErrorOnlyFollowUp = hasErrors && shouldDeferMainResponse === true;

            /* === VIVENTIUM NOTE ===
             * Feature: Safety net for deferred-response follow-up.
             *
             * Why: When shouldDeferMainResponse is true, the user sees a hold message ("Checking now.")
             * and waits for a follow-up. If Phase B crashes (mergedInsightsData === null from the
             * .catch handler) or produces zero insights/errors (toolless silent failure), the
             * suppression check below would return null — leaving the user hanging indefinitely.
             *
             * Fix: When the main response was deferred, always create a follow-up. If there's
             * genuinely nothing to surface, the follow-up creator generates a short user-safe
             * error line ("I couldn't finish that check just now.").
             */
            const phaseBCrashed = mergedInsightsData == null;
            const phaseBEmpty = !hasInsights && !hasMergedText && !hasErrors;
            if (shouldDeferMainResponse && (phaseBCrashed || phaseBEmpty)) {
              logger.warn(
                '[AgentClient] Phase B produced no usable output but main response was deferred; forcing error follow-up. crashed=%s empty=%s',
                phaseBCrashed,
                phaseBEmpty,
              );
              // Synthesize a minimal mergedInsightsData so createCortexFollowUpMessage
              // enters its error/fallback path.
              mergedInsightsData = {
                insights: [],
                mergedPrompt: '',
                cortexCount: activatedCorticesList?.length ?? 0,
                errors: [{ message: 'Background processing did not return results' }],
                hasErrors: true,
              };
            } else if (!hasInsights && !hasMergedText && !allowErrorOnlyFollowUp) {
              return null;
            }
            /* === VIVENTIUM NOTE END === */

            try {
              const recentResponse = extractTextFromContentParts(responseContentParts);
              /* === VIVENTIUM START ===
               * Feature: Scheduled/no-response Phase B follow-up forcing.
               *
               * Why:
               * - Scheduler-style prompts can intentionally make Phase A output exactly {NTA}
               *   while background agents finish.
               * - If Phase B later has substantive insights and synthesis still emits {NTA}, the
               *   no-response tag must not suppress the useful Phase B follow-up.
               *
               * Behavior:
               * - Phase B remains nonblocking and persists as a separate assistant follow-up.
               * - We never replace or overwrite Phase A here.
               * - This is structural: it keys off the no-response tag and Phase B output, not prompt
               *   text, schedule names, user identity, or agent names.
               * === VIVENTIUM END === */
              const forcePhaseBFollowUp = shouldForcePhaseBFollowUp({
                shouldDeferMainResponse,
                parentText: recentResponse,
                hasInsights,
                hasMergedText,
                allowErrorOnlyFollowUp,
              });
              /* VIVENTIUM DEBUG — Phase B recentResponse visibility */
              {
                const cpLen = responseContentParts?.length ?? 0;
                const textParts = (responseContentParts || []).filter((p) => p && p.type === ContentTypes.TEXT).length;
                const rrLen = recentResponse.length;
                if (process.env.VIVENTIUM_DEBUG_PHASE_B === 'true') {
                  const preview = recentResponse.slice(0, 200);
                  logger.info(
                    `[AgentClient] Phase B recentResponse extraction: contentParts.length=${cpLen}, textParts=${textParts}, recentResponse.length=${rrLen}, preview="${preview}"`,
                  );
                } else {
                  logger.info(
                    `[AgentClient] Phase B recentResponse extraction: contentParts.length=${cpLen}, textParts=${textParts}, recentResponse.length=${rrLen}`,
                  );
                }
              }
              /* VIVENTIUM DEBUG END */
              const followUpMessage = await createCortexFollowUpMessage({
                req,
                conversationId,
                parentMessageId: responseMessageId,
                agent,
                insightsData: mergedInsightsData,
                recentResponse,
                forceVisibleFollowUp: forcePhaseBFollowUp,
              });
              try {
                await finalizeCanonicalCortexMessage({
                  req,
                  messageId: responseMessageId,
                });
              } catch (finishErr) {
                logger.warn(
                  '[AgentClient] Failed to finalize canonical cortex parent message:',
                  finishErr?.message ?? String(finishErr),
                );
              }

              if (followUpMessage?.text) {
                logger.info(
                  '[AgentClient] Background cortex follow-up message saved: id=%s phase_b_new_message=%s',
                  followUpMessage.messageId,
                  followUpMessage.messageId !== responseMessageId,
                );
              } else {
                logger.warn(
                  '[AgentClient] Background cortex follow-up produced no persisted message (suppressed or empty)',
                );
              }

              /* === VIVENTIUM NOTE ===
               * Telegram must receive a single merged follow-up event after ALL cortices finish.
               */
              if (followUpMessage?.text && req?._resumableStreamId) {
                const emittedParentMessageId =
                  followUpMessage.messageId === responseMessageId
                    ? followUpMessage.parentMessageId
                    : responseMessageId;
                const followUpEvent = {
                  event: 'on_cortex_followup',
                  data: {
                    runId: responseMessageId,
                    messageId: followUpMessage.messageId,
                    parentMessageId: emittedParentMessageId,
                    conversationId,
                    text: followUpMessage.text,
                    cortexCount: mergedInsightsData?.cortexCount ?? undefined,
                  },
                };
                GenerationJobManager.emitChunk(req._resumableStreamId, followUpEvent).catch((err) => {
                  logger.warn(
                    '[AgentClient] Failed to emit cortex follow-up SSE event:',
                    err?.message ?? String(err),
                  );
                });
              }
              /* === VIVENTIUM NOTE END === */
            } catch (e) {
              logger.error('[AgentClient] Failed to create cortex follow-up message:', e);
            }

            return null;
          })
          .catch((err) => {
            logger.error('[AgentClient] Phase B background completion pipeline failed:', err);
          });
      }
      /* === VIVENTIUM NOTE END === */



    } catch (err) {
      logger.error(
        '[api/server/controllers/agents/client.js #sendCompletion] Operation aborted',
        err,
      );
      if (!abortController.signal.aborted) {
        logger.error(
          '[api/server/controllers/agents/client.js #sendCompletion] Unhandled error type',
          err,
        );
        this.contentParts.push({
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]: `An error occurred while processing the request${err?.message ? `: ${err.message}` : ''}`,
        });
      }
    } finally {
      try {
        const attachments = await this.awaitMemoryWithTimeout(memoryPromise);
        if (attachments && attachments.length > 0) {
          this.artifactPromises.push(...attachments);
        }

        await this.recordCollectedUsage({
          context: 'message',
          balance: balanceConfig,
          transactions: transactionsConfig,
        });
        if (isDeepTimingEnabled(req)) {
          logDeepTiming(req, 'chat_completion_finalize', chatStart);
        }
      } catch (err) {
        logger.error(
          '[api/server/controllers/agents/client.js #chatCompletion] Error in cleanup phase',
          err,
        );
      }
      try {
        scheduleConversationRecallSync({
          userId: req?.user?.id,
          conversationId: this.conversationId,
        });
      } catch (error) {
        logger.warn('[AgentClient] Failed to schedule conversation recall sync', error);
      }
      run = null;
      config = null;
      memoryPromise = null;
    }
  }

  /**
   *
   * @param {Object} params
   * @param {string} params.text
   * @param {string} params.conversationId
   */
  async titleConvo({ text, abortController }) {
    if (!this.run) {
      throw new Error('Run not initialized');
    }
	    const { handleLLMEnd, collected: collectedMetadata } = createMetadataAggregator();
	    const { req, agent } = this.options;

	    if (req?.body?.isTemporary) {
	      logger.debug(
	        `[api/server/controllers/agents/client.js #titleConvo] Skipping title generation for temporary conversation`,
	      );
	      return;
	    }

	    const appConfig = req.config;
	    let endpoint = agent.endpoint;

    /** @type {import('@librechat/agents').ClientOptions} */
    let clientOptions = {
      model: agent.model || agent.model_parameters.model,
    };

    let titleProviderConfig = getProviderConfig({ provider: endpoint, appConfig });

    /** @type {TEndpoint | undefined} */
    const endpointConfig =
      appConfig.endpoints?.all ??
      appConfig.endpoints?.[endpoint] ??
      titleProviderConfig.customEndpointConfig;
    if (!endpointConfig) {
      logger.debug(
        `[api/server/controllers/agents/client.js #titleConvo] No endpoint config for "${endpoint}"`,
      );
    }

    if (endpointConfig?.titleConvo === false) {
      logger.debug(
        `[api/server/controllers/agents/client.js #titleConvo] Title generation disabled for endpoint "${endpoint}"`,
      );
      return;
    }

    if (endpointConfig?.titleEndpoint && endpointConfig.titleEndpoint !== endpoint) {
      try {
        titleProviderConfig = getProviderConfig({
          provider: endpointConfig.titleEndpoint,
          appConfig,
        });
        endpoint = endpointConfig.titleEndpoint;
      } catch (error) {
        logger.warn(
          `[api/server/controllers/agents/client.js #titleConvo] Error getting title endpoint config for "${endpointConfig.titleEndpoint}", falling back to default`,
          error,
        );
        // Fall back to original provider config
        endpoint = agent.endpoint;
        titleProviderConfig = getProviderConfig({ provider: endpoint, appConfig });
      }
    }

    if (
      endpointConfig &&
      endpointConfig.titleModel &&
      endpointConfig.titleModel !== Constants.CURRENT_MODEL
    ) {
      clientOptions.model = endpointConfig.titleModel;
    }

    const options = await titleProviderConfig.getOptions({
      req,
      endpoint,
      model_parameters: clientOptions,
      db: {
        getUserKey: db.getUserKey,
        getUserKeyValues: db.getUserKeyValues,
        updateUserKey: db.updateUserKey,
      },
    });

    let provider = options.provider ?? titleProviderConfig.overrideProvider ?? agent.provider;
    if (
      endpoint === EModelEndpoint.azureOpenAI &&
      options.llmConfig?.azureOpenAIApiInstanceName == null
    ) {
      provider = Providers.OPENAI;
    } else if (
      endpoint === EModelEndpoint.azureOpenAI &&
      options.llmConfig?.azureOpenAIApiInstanceName != null &&
      provider !== Providers.AZURE
    ) {
      provider = Providers.AZURE;
    }

    /** @type {import('@librechat/agents').ClientOptions} */
    clientOptions = { ...options.llmConfig };
    if (options.configOptions) {
      clientOptions.configuration = options.configOptions;
    }

    if (clientOptions.maxTokens != null) {
      delete clientOptions.maxTokens;
    }
    if (clientOptions?.modelKwargs?.max_completion_tokens != null) {
      delete clientOptions.modelKwargs.max_completion_tokens;
    }
    if (clientOptions?.modelKwargs?.max_output_tokens != null) {
      delete clientOptions.modelKwargs.max_output_tokens;
    }

    clientOptions = Object.assign(
      Object.fromEntries(
        Object.entries(clientOptions).filter(([key]) => !omitTitleOptions.has(key)),
      ),
    );

    if (
      provider === Providers.GOOGLE &&
      (endpointConfig?.titleMethod === TitleMethod.FUNCTIONS ||
        endpointConfig?.titleMethod === TitleMethod.STRUCTURED)
    ) {
      clientOptions.json = true;
    }

    /** Resolve request-based headers for Custom Endpoints. Note: if this is added to
     *  non-custom endpoints, needs consideration of varying provider header configs.
     */
    if (clientOptions?.configuration?.defaultHeaders != null) {
      clientOptions.configuration.defaultHeaders = resolveHeaders({
        headers: clientOptions.configuration.defaultHeaders,
        user: createSafeUser(this.options.req?.user),
        body: {
          messageId: this.responseMessageId,
          conversationId: this.conversationId,
          parentMessageId: this.parentMessageId,
        },
      });
    }

    try {
      const titleResult = await this.run.generateTitle({
        provider,
        clientOptions,
        inputText: text,
        contentParts: this.contentParts,
        titleMethod: endpointConfig?.titleMethod,
        titlePrompt: endpointConfig?.titlePrompt,
        titlePromptTemplate: endpointConfig?.titlePromptTemplate,
        chainOptions: {
          signal: abortController.signal,
          callbacks: [
            {
              handleLLMEnd,
            },
          ],
          configurable: {
            thread_id: this.conversationId,
            user_id: this.user ?? this.options.req.user?.id,
          },
        },
      });

      const collectedUsage = collectedMetadata.map((item) => {
        let input_tokens, output_tokens;

        if (item.usage) {
          input_tokens =
            item.usage.prompt_tokens || item.usage.input_tokens || item.usage.inputTokens;
          output_tokens =
            item.usage.completion_tokens || item.usage.output_tokens || item.usage.outputTokens;
        } else if (item.tokenUsage) {
          input_tokens = item.tokenUsage.promptTokens;
          output_tokens = item.tokenUsage.completionTokens;
        }

        return {
          input_tokens: input_tokens,
          output_tokens: output_tokens,
        };
      });

      const balanceConfig = getBalanceConfig(appConfig);
      const transactionsConfig = getTransactionsConfig(appConfig);
	      await this.recordCollectedUsage({
	        collectedUsage,
	        context: 'title',
	        model: clientOptions.model,
	        balance: balanceConfig,
	        transactions: transactionsConfig,
	        messageId: this.responseMessageId,
	      }).catch((err) => {
	        logger.error(
	          '[api/server/controllers/agents/client.js #titleConvo] Error recording collected usage',
          err,
        );
      });

      return sanitizeTitle(titleResult.title);
    } catch (err) {
      logger.error('[api/server/controllers/agents/client.js #titleConvo] Error', err);
      return;
    }
  }

  /**
   * @param {object} params
   * @param {number} params.promptTokens
   * @param {number} params.completionTokens
   * @param {string} [params.model]
   * @param {OpenAIUsageMetadata} [params.usage]
   * @param {AppConfig['balance']} [params.balance]
   * @param {string} [params.context='message']
   * @returns {Promise<void>}
   */
  async recordTokenUsage({
    model,
    usage,
    balance,
    promptTokens,
    completionTokens,
    context = 'message',
  }) {
    try {
      await spendTokens(
        {
          model,
          context,
          balance,
          conversationId: this.conversationId,
          user: this.user ?? this.options.req.user?.id,
          endpointTokenConfig: this.options.endpointTokenConfig,
        },
        { promptTokens, completionTokens },
      );

      if (
        usage &&
        typeof usage === 'object' &&
        'reasoning_tokens' in usage &&
        typeof usage.reasoning_tokens === 'number'
      ) {
        await spendTokens(
          {
            model,
            balance,
            context: 'reasoning',
            conversationId: this.conversationId,
            user: this.user ?? this.options.req.user?.id,
            endpointTokenConfig: this.options.endpointTokenConfig,
          },
          { completionTokens: usage.reasoning_tokens },
        );
      }
    } catch (error) {
      logger.error(
        '[api/server/controllers/agents/client.js #recordTokenUsage] Error recording token usage',
        error,
      );
    }
  }

  getEncoding() {
    return 'o200k_base';
  }

  /**
   * Returns the token count of a given text. It also checks and resets the tokenizers if necessary.
   * @param {string} text - The text to get the token count for.
   * @returns {number} The token count of the given text.
   */
  getTokenCount(text) {
    const encoding = this.getEncoding();
    return Tokenizer.getTokenCount(text, encoding);
  }
}

module.exports = AgentClient;
module.exports.buildViventiumMcpRequestBody = buildViventiumMcpRequestBody;

/* === VIVENTIUM END === */
