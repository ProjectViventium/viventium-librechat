/* === VIVENTIUM START ===
 * Feature: Background Cortices - Follow-up + Persistence Helpers
 * Purpose:
 * - Persist latest cortex status rows onto the canonical assistant message (DB truth)
 * - Create a single follow-up assistant message after all activated cortices complete
 *
 * NOTE:
 * LibreChat streams the in-flight assistant message under a placeholder id `${userMessageId}_`.
 * DB persistence uses the canonical assistant messageId (`responseMessageId`).
 * This service only deals with DB (canonical) state.
 * === VIVENTIUM END === */

const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { Run, Providers } = require('@librechat/agents');
const { initializeAnthropic, initializeOpenAI } = require('@librechat/api');
const { HumanMessage } = require('@langchain/core/messages');
const { ContentTypes, EModelEndpoint, supportsAdaptiveThinking } = require('librechat-data-provider');
const db = require('~/models');
const { getAgent } = require('~/models/Agent');
const { getCustomEndpointConfig, mapProvider } = require('~/server/services/BackgroundCortexService');
const {
  DEFAULT_MODELS,
  normalizeProvider: normalizeRuntimeProvider,
  rewriteAgentForRuntime,
} = require('../../../../scripts/viventium-agent-runtime-models');
/* === VIVENTIUM NOTE ===
 * Feature: Surface-aware follow-up prompts.
 */
const {
  resolveViventiumSurface,
  buildWebTextInstructions,
  buildTelegramTextInstructions,
  buildPlaygroundTextInstructions,
  stripVoiceControlTagsForDisplay,
} = require('~/server/services/viventium/surfacePrompts');
const {
  resolveVoiceOverrideAssignment,
  resolveVoiceModelParameters,
} = require('~/server/services/viventium/voiceLlmOverride');
/* === VIVENTIUM NOTE ===
 * Feature: No-response tag ({NTA}) normalization for passive/background follow-ups.
 */
const {
  isNoResponseOnly,
  normalizeNoResponseText,
  NO_RESPONSE_TAG,
} = require('~/server/services/viventium/noResponseTag');
const {
  sanitizeFollowUpDisplayText,
} = require('~/server/services/viventium/followUpTextSanitizer');
const {
  cleanFallbackInsightText,
  getDeferredFallbackErrorText,
  getPreferredFallbackInsightText,
  getVisibleFallbackInsightTexts,
  isOperationalFallbackParagraph,
  stripQuestionSentences,
} = require('~/server/services/viventium/cortexFallbackText');
/* === VIVENTIUM NOTE === */
/* === VIVENTIUM NOTE ===
 * Feature: No Response Tag ({NTA}) prompt injection (env-gated, config-driven).
 * Added: 2026-02-07
 */
const { buildNoResponseInstructions } = require('~/server/services/viventium/noResponsePrompt');
/* === VIVENTIUM NOTE === */
/* === VIVENTIUM NOTE === */

const CORTEX_TYPES = new Set([
  ContentTypes.CORTEX_ACTIVATION,
  ContentTypes.CORTEX_BREWING,
  ContentTypes.CORTEX_INSIGHT,
]);

function hasActiveAnthropicThinking(thinking) {
  if (thinking == null || thinking === false) {
    return false;
  }

  if (thinking === true) {
    return true;
  }

  if (typeof thinking !== 'object' || Array.isArray(thinking)) {
    return true;
  }

  const type = typeof thinking.type === 'string' ? thinking.type.trim().toLowerCase() : '';
  if (type === 'disabled' || thinking.enabled === false) {
    return false;
  }

  return true;
}

function normalizeFollowUpProvider(provider) {
  const normalized = normalizeRuntimeProvider(provider);
  if (normalized === 'undefined' || normalized === 'null') {
    return '';
  }
  return normalized;
}

function sanitizeAnthropicFollowUpLLMConfig(llmConfig = {}) {
  if (!llmConfig || typeof llmConfig !== 'object') {
    return llmConfig;
  }

  if (!Object.prototype.hasOwnProperty.call(llmConfig, 'temperature')) {
    return llmConfig;
  }

  const model = typeof llmConfig.model === 'string' ? llmConfig.model : '';
  const effectiveThinking = Object.prototype.hasOwnProperty.call(llmConfig, 'thinking')
    ? llmConfig.thinking
    : true;
  const thinkingIsActive = hasActiveAnthropicThinking(effectiveThinking);
  const adaptiveModel = model ? supportsAdaptiveThinking(model) : false;
  if (!thinkingIsActive && !adaptiveModel) {
    return llmConfig;
  }

  const nextConfig = { ...llmConfig };
  delete nextConfig.temperature;
  logger.info(
    `[BackgroundCortexFollowUpService] Removed Anthropic follow-up temperature because ${
      thinkingIsActive
        ? `thinking is active (${Object.prototype.hasOwnProperty.call(llmConfig, 'thinking') ? 'explicit' : 'default'})`
        : 'the model uses adaptive-thinking-era Anthropic temperature rules'
    }`,
  );
  return nextConfig;
}

function resolveFollowUpPersistenceText({
  generatedText = '',
  insightsData,
  replaceParentMessage = false,
  voiceMode = false,
  surface = '',
  scheduleId = '',
}) {
  const decision = {
    replaceParentMessage: replaceParentMessage === true,
    hasInsights: Array.isArray(insightsData?.insights) && insightsData.insights.length > 0,
    llmResult: 'empty',
    selectedStrategy: 'none',
    suppressionReason: '',
    finalLength: 0,
  };

  let text = String(generatedText || '').trim();
  if (isNoResponseOnly(text)) {
    decision.llmResult = 'nta';
    if (replaceParentMessage === true) {
      decision.selectedStrategy = 'replace_parent_forced_fallback';
    } else {
      decision.selectedStrategy = 'nta_fallback_candidate';
    }
    text = '';
  } else if (text) {
    decision.llmResult = 'generated';
    decision.selectedStrategy = 'llm_generated';
  }

  if (!text) {
    text = formatFollowUpText({
      ...(insightsData ?? {}),
      voiceMode,
      surface,
      scheduleId,
    });
    if (text) {
      decision.selectedStrategy = 'deterministic_fallback';
    }
  }

  if (!text && replaceParentMessage === true) {
    text = getPreferredFallbackInsightText({
      insights: Array.isArray(insightsData?.insights) ? insightsData.insights : [],
      scheduleId,
      allowMultiInsightBestEffort: true,
    });
    if (text) {
      decision.selectedStrategy = 'best_visible_insight';
    }
  }

  text = stripQuestionSentences(String(text || '').trim());
  text = sanitizeFollowUpDisplayText(text);
  text = normalizeNoResponseText(text).trim();

  if (!text || text.trim().length === 0) {
    if (replaceParentMessage !== true) {
      decision.suppressionReason = 'empty_after_fallback';
      return { text: '', decision };
    }

    text = formatFollowUpText({
      insights: [],
      mergedPrompt: '',
      hasErrors: true,
      scheduleId,
    });
    if (!text || text.trim().length === 0) {
      decision.suppressionReason = 'empty_after_error_fallback';
      return { text: '', decision };
    }
    decision.selectedStrategy = 'error_fallback';
  }

  if (isNoResponseOnly(text)) {
    decision.suppressionReason = 'no_response_tag';
    return { text: '', decision };
  }

  if (voiceMode && typeof text === 'string') {
    text = stripVoiceControlTagsForDisplay(text);
    if (!text || text.trim().length === 0) {
      decision.suppressionReason = 'empty_after_voice_tag_strip';
      return { text: '', decision };
    }
  }

  decision.finalLength = text.length;
  return { text, decision };
}

/* === VIVENTIUM NOTE ===
 * Feature: Launch-ready follow-up model fallback governance.
 *
 * Why:
 * - Background follow-up generation must not silently fall back to stale 4o-era models when
 *   agent metadata is partially missing.
 * - The approved launch baseline for built-in background execution is documented in
 *   docs/requirements_and_learnings/01_Key_Principles.md and
 *   docs/requirements_and_learnings/02_Background_Agents.md.
 */
function resolveGovernedFollowUpModel(agent, { useVoiceModel = false } = {}) {
  const rawProvider = String(
    useVoiceModel ? agent?.voice_llm_provider || agent?.provider : agent?.provider,
  )
    .trim()
    .toLowerCase();
  const provider = normalizeFollowUpProvider(rawProvider);
  const explicitModel = String(
    useVoiceModel
      ? agent?.voice_llm_model || ''
      : agent?.model || agent?.model_parameters?.model || '',
  ).trim();
  if (explicitModel) {
    return explicitModel;
  }
  const fallbackModel = DEFAULT_MODELS[provider];
  if (fallbackModel) {
    return fallbackModel;
  }
  logger.warn(
    `[BackgroundCortexFollowUpService] Unknown follow-up provider "${rawProvider}"; ` +
      `falling back to ${DEFAULT_MODELS.openAI}`,
  );
  return DEFAULT_MODELS.openAI;
}
/* === VIVENTIUM NOTE === */

function resolveFollowUpRuntimeAssignment(agent, { useVoiceModel = false } = {}) {
  const baseRuntimeAgent = rewriteAgentForRuntime(agent || {});
  /* === VIVENTIUM NOTE ===
   * Voice follow-ups should respect the same machine-level fast voice override contract as the
   * main voice turn, but only at runtime. Keep the canonical built-in bundle unset by default and
   * resolve any env-based fast route here instead of rehydrating a stale shipped override.
   * === VIVENTIUM NOTE === */
  const voiceAssignment = useVoiceModel ? resolveVoiceOverrideAssignment(baseRuntimeAgent) : null;
  const runtimeAgent = voiceAssignment
    ? {
        ...baseRuntimeAgent,
        voice_llm_provider: voiceAssignment.provider,
        voice_llm_model: voiceAssignment.model,
        model_parameters: resolveVoiceModelParameters(baseRuntimeAgent, voiceAssignment.model),
      }
    : baseRuntimeAgent;
  const effectiveModel = resolveGovernedFollowUpModel(runtimeAgent, { useVoiceModel });
  const rawProvider = String(
    useVoiceModel ? runtimeAgent?.voice_llm_provider || runtimeAgent?.provider : runtimeAgent?.provider,
  ).trim();
  const effectiveProvider = normalizeFollowUpProvider(rawProvider);

  return {
    runtimeAgent,
    effectiveModel,
    effectiveProvider,
  };
}

function mergeFollowUpAgentRuntimeState(runtimeAgent, persistedAgent) {
  const mergedModelParameters = {
    ...(persistedAgent?.model_parameters &&
    typeof persistedAgent.model_parameters === 'object' &&
    !Array.isArray(persistedAgent.model_parameters)
      ? persistedAgent.model_parameters
      : {}),
    ...(runtimeAgent?.model_parameters &&
    typeof runtimeAgent.model_parameters === 'object' &&
    !Array.isArray(runtimeAgent.model_parameters)
      ? runtimeAgent.model_parameters
      : {}),
  };
  const mergedVoiceModelParameters = {
    ...(persistedAgent?.voice_llm_model_parameters &&
    typeof persistedAgent.voice_llm_model_parameters === 'object' &&
    !Array.isArray(persistedAgent.voice_llm_model_parameters)
      ? persistedAgent.voice_llm_model_parameters
      : {}),
    ...(runtimeAgent?.voice_llm_model_parameters &&
    typeof runtimeAgent.voice_llm_model_parameters === 'object' &&
    !Array.isArray(runtimeAgent.voice_llm_model_parameters)
      ? runtimeAgent.voice_llm_model_parameters
      : {}),
  };

  const merged = {
    ...(persistedAgent || {}),
    ...(runtimeAgent || {}),
    provider:
      normalizeFollowUpProvider(runtimeAgent?.provider) ||
      normalizeFollowUpProvider(persistedAgent?.provider) ||
      '',
    model:
      String(
        runtimeAgent?.model ||
          runtimeAgent?.model_parameters?.model ||
          persistedAgent?.model ||
          persistedAgent?.model_parameters?.model ||
          '',
      ).trim(),
    voice_llm_provider:
      normalizeFollowUpProvider(runtimeAgent?.voice_llm_provider) ||
      normalizeFollowUpProvider(persistedAgent?.voice_llm_provider) ||
      null,
    voice_llm_model: String(
      runtimeAgent?.voice_llm_model || persistedAgent?.voice_llm_model || '',
    ).trim() || null,
    voice_llm_model_parameters: mergedVoiceModelParameters,
    model_parameters: mergedModelParameters,
  };

  if (!merged.model_parameters.model && merged.model) {
    merged.model_parameters.model = merged.model;
  }

  return merged;
}

async function resolveCanonicalFollowUpAgent(agent, { useVoiceModel = false } = {}) {
  let assignment = resolveFollowUpRuntimeAssignment(agent, { useVoiceModel });
  const normalizedAssignmentProvider = normalizeFollowUpProvider(assignment.effectiveProvider);
  if (normalizedAssignmentProvider || !agent?.id) {
    return {
      ...assignment,
      effectiveProvider: normalizedAssignmentProvider,
    };
  }

  logger.warn(
    `[BackgroundCortexFollowUpService] Follow-up runtime missing provider before canonical rehydrate: incoming_id=${agent?.id || 'unknown'} incoming_provider=${String(agent?.provider || '') || 'empty'} incoming_model=${String(agent?.model || agent?.model_parameters?.model || '') || 'empty'} runtime_provider=${String(assignment.runtimeAgent?.provider || '') || 'empty'} runtime_model=${String(assignment.runtimeAgent?.model || assignment.runtimeAgent?.model_parameters?.model || '') || 'empty'}`,
  );

  try {
    const persistedAgent = await getAgent({ id: agent.id });
    if (!persistedAgent) {
      logger.warn(
        `[BackgroundCortexFollowUpService] No canonical persisted agent found for follow-up rehydrate: id=${agent.id}`,
      );
      return assignment;
    }

    const canonicalSourceAgent = rewriteAgentForRuntime(
      mergeFollowUpAgentRuntimeState(assignment.runtimeAgent, persistedAgent),
    );
    const canonicalAssignment = resolveFollowUpRuntimeAssignment(canonicalSourceAgent, {
      useVoiceModel,
    });
    const canonicalRuntimeAgent = canonicalAssignment.runtimeAgent;
    const effectiveModel = canonicalAssignment.effectiveModel;
    const effectiveProvider = normalizeFollowUpProvider(canonicalAssignment.effectiveProvider);

    if (effectiveProvider) {
      logger.info(
        `[BackgroundCortexFollowUpService] Rehydrated follow-up agent runtime from canonical persisted agent: id=${agent.id} provider=${effectiveProvider} model=${effectiveModel}`,
      );
    } else {
      logger.warn(
        `[BackgroundCortexFollowUpService] Canonical persisted agent still could not resolve follow-up provider: id=${agent.id} persisted_provider=${String(persistedAgent?.provider || '') || 'empty'} persisted_model=${String(persistedAgent?.model || persistedAgent?.model_parameters?.model || '') || 'empty'}`,
      );
    }

    return {
      runtimeAgent: canonicalRuntimeAgent,
      effectiveModel,
      effectiveProvider,
    };
  } catch (err) {
    logger.warn(
      '[BackgroundCortexFollowUpService] Failed to rehydrate canonical agent for follow-up:',
      err?.message || err,
    );
    return assignment;
  }
}

function upsertCortexParts(existingContent, cortexParts) {
  const content = Array.isArray(existingContent) ? [...existingContent] : [];
  const parts = Array.isArray(cortexParts) ? cortexParts : [];
  for (const part of parts) {
    if (!part || !part.cortex_id) {
      continue;
    }
    const idx = content.findIndex((p) => p && p.cortex_id === part.cortex_id && CORTEX_TYPES.has(p.type));
    if (idx >= 0) {
      content[idx] = part;
    } else {
      content.push(part);
    }
  }
  return content;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* === VIVENTIUM NOTE ===
 * Feature: Voice follow-up prompt rules (speech-safe output).
 */
function buildVoiceFollowUpRules() {
  const override = (process.env.VIVENTIUM_VOICE_FOLLOWUP_RULES || '').trim();
  if (override) {
    return override;
  }
  return [
    'VOICE FOLLOW-UP RULES:',
    '- This is spoken audio. Use short sentences.',
    '- Do not output planning steps or numbered lists.',
    '- Do not include tool instructions or API field names.',
    '- Do not read URLs or email addresses aloud; say you can send the details.',
    '- Use natural language for dates/times (no raw timestamps).',
    '- Keep it to 1-3 sentences unless the user asked for more detail.',
  ].join('\n');
}
/* === VIVENTIUM NOTE === */

/* === VIVENTIUM NOTE ===
 * Feature: Voice mode detection for follow-up formatting.
 */
function isVoiceMode(req) {
  return req?.body?.voiceMode === true;
}

function mergeFollowUpTextIntoParentContent(existingContent, text) {
  const nextTextPart = {
    type: ContentTypes.TEXT,
    text,
  };
  const preservedParts = Array.isArray(existingContent)
    ? existingContent.filter((part) => part && part.type !== ContentTypes.TEXT)
    : [];
  return [nextTextPart, ...preservedParts];
}

function getMessageTimelineValue(message) {
  const value = message?.updatedAt || message?.createdAt || 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function resolveConversationLeafMessageId(messages, fallbackMessageId = null) {
  const candidates = Array.isArray(messages)
    ? messages.filter((message) => message && typeof message.messageId === 'string' && message.messageId)
    : [];

  if (candidates.length === 0) {
    return fallbackMessageId;
  }

  const parentIds = new Set(
    candidates
      .map((message) => message.parentMessageId)
      .filter((parentId) => typeof parentId === 'string' && parentId.length > 0),
  );

  const leaves = candidates.filter((message) => !parentIds.has(message.messageId));
  const ranked = leaves.length > 0 ? leaves : candidates;

  ranked.sort((left, right) => {
    const timelineDelta = getMessageTimelineValue(left) - getMessageTimelineValue(right);
    if (timelineDelta !== 0) {
      return timelineDelta;
    }
    return String(left.messageId).localeCompare(String(right.messageId));
  });

  return ranked[ranked.length - 1]?.messageId || fallbackMessageId;
}

async function resolveFollowUpLLMConfig({
  req,
  agent,
  providerName,
  effectiveModel,
  primaryResponseMode = false,
  useVoiceModel = false,
}) {
  let resolvedAgent = agent || {};
  let resolvedProviderName = normalizeFollowUpProvider(providerName).toLowerCase();
  let resolvedModel = String(effectiveModel || '').trim();

  if (!resolvedModel) {
    resolvedModel = resolveGovernedFollowUpModel(resolvedAgent, { useVoiceModel });
  }

  if (resolvedAgent?.id) {
    try {
      const persistedAgent = await getAgent({ id: resolvedAgent.id });
      if (persistedAgent) {
        const priorProviderName = resolvedProviderName;
        const priorModel = resolvedModel;
        const priorThinking = resolvedAgent?.model_parameters?.thinking;
        resolvedAgent = rewriteAgentForRuntime(
          mergeFollowUpAgentRuntimeState(resolvedAgent, persistedAgent),
        );
        const hydratedProviderName = normalizeFollowUpProvider(
          useVoiceModel
            ? resolvedAgent?.voice_llm_provider || resolvedAgent?.provider
            : resolvedAgent?.provider,
        ).toLowerCase();
        const hydratedModel = resolveGovernedFollowUpModel(resolvedAgent, { useVoiceModel });
        resolvedProviderName = hydratedProviderName || resolvedProviderName;
        resolvedModel = hydratedModel || resolvedModel;
        const nextThinking = resolvedAgent?.model_parameters?.thinking;

        if (
          priorProviderName !== resolvedProviderName ||
          priorModel !== resolvedModel ||
          priorThinking !== nextThinking
        ) {
          logger.info(
            `[BackgroundCortexFollowUpService] Hydrated follow-up runtime config from canonical agent at final resolution gate: id=${resolvedAgent.id} provider=${priorProviderName || 'missing'}->${resolvedProviderName || 'missing'} model=${priorModel || 'missing'}->${resolvedModel || 'missing'} thinking=${String(priorThinking)}->${String(nextThinking)}`,
          );
        }
      } else if (!resolvedProviderName) {
        logger.warn(
          `[BackgroundCortexFollowUpService] Final follow-up resolution could not find canonical persisted agent: id=${resolvedAgent.id}`,
        );
      }
    } catch (err) {
      logger.warn(
        '[BackgroundCortexFollowUpService] Final follow-up resolution failed to rehydrate canonical agent:',
        err?.message || err,
      );
    }
  }

  if (!resolvedProviderName) {
    throw new Error(
      `Unable to resolve follow-up LLM provider for agent "${resolvedAgent?.id || 'unknown'}"`,
    );
  }

  const configuredMaxTokens =
    resolvedAgent.model_parameters?.max_output_tokens ?? resolvedAgent.model_parameters?.max_tokens ?? 0;
  const deferredDefaultMaxTokens = Number.parseInt(
    process.env.VIVENTIUM_DEFERRED_FOLLOWUP_MAX_TOKENS || '',
    10,
  );
  const maxTokens = Math.max(
    configuredMaxTokens,
    primaryResponseMode
      ? Number.isFinite(deferredDefaultMaxTokens) && deferredDefaultMaxTokens > 0
        ? deferredDefaultMaxTokens
        : 2000
      : 400,
  );

  const baseModelParameters = {
    ...(resolvedAgent.model_parameters || {}),
    model: resolvedModel,
    max_output_tokens: maxTokens,
  };
  if (baseModelParameters.temperature == null) {
    delete baseModelParameters.temperature;
  }

  if (resolvedProviderName === 'openai') {
    const initialized = await initializeOpenAI({
      req,
      endpoint: EModelEndpoint.openAI,
      model_parameters: baseModelParameters,
      db,
    });

    return {
      ...initialized.llmConfig,
      provider: Providers.OPENAI,
      streaming: false,
      disableStreaming: true,
    };
  }

  if (resolvedProviderName === 'anthropic') {
    const anthropicModelParameters = sanitizeAnthropicFollowUpLLMConfig(baseModelParameters);
    const initialized = await initializeAnthropic({
      req,
      endpoint: EModelEndpoint.anthropic,
      model_parameters: anthropicModelParameters,
      db,
    });

    return {
      ...sanitizeAnthropicFollowUpLLMConfig(initialized.llmConfig),
      provider: Providers.ANTHROPIC,
      streaming: false,
      disableStreaming: true,
    };
  }

  const mappedProvider = mapProvider(resolvedProviderName);
  const llmConfig = {
    provider: mappedProvider,
    model: resolvedModel,
    maxTokens,
    streaming: false,
    disableStreaming: true,
  };

  if (baseModelParameters.temperature != null) {
    llmConfig.temperature = baseModelParameters.temperature;
  }

  if (req && resolvedProviderName) {
    const customConfig = await getCustomEndpointConfig(resolvedProviderName, req);
    if (customConfig?.apiKey && customConfig?.baseURL) {
      llmConfig.provider = Providers.OPENAI;
      llmConfig.configuration = {
        apiKey: customConfig.apiKey,
        baseURL: customConfig.baseURL,
      };
    }
  }

  return llmConfig;
}
/* === VIVENTIUM NOTE === */

async function persistCortexPartsToCanonicalMessage({
  req,
  responseMessageId,
  cortexParts,
  maxAttempts = 6,
}) {
  if (!req?.user?.id) {
    throw new Error('persistCortexPartsToCanonicalMessage requires authenticated req.user.id');
  }
  if (!responseMessageId) {
    throw new Error('persistCortexPartsToCanonicalMessage requires responseMessageId');
  }

  /* VIVENTIUM NOTE
   * Purpose: Trace cortex follow-up persistence flow for debugging.
   * Details: docs/requirements_and_learnings/05_Open_Source_Modifications.md#librechat-cortex-followup-persist
   */
  logger.info(`[BackgroundCortexFollowUpService] DEBUG PERSIST: Starting persistence for messageId=${responseMessageId}, cortexParts count=${cortexParts?.length || 0}`);
  if (cortexParts?.length > 0) {
    cortexParts.forEach((part, i) => {
      logger.info(`[BackgroundCortexFollowUpService] DEBUG PERSIST: Part ${i}: type=${part?.type}, cortex_id=${part?.cortex_id}, has_insight=${!!part?.insight}`);
    });
  }
  /* VIVENTIUM NOTE */

  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const existing = await db.getMessage({ user: req.user.id, messageId: responseMessageId });
      if (!existing) {
        // Message may not be saved yet (race vs main response save)
        throw new Error('message_not_found');
      }

      /* VIVENTIUM NOTE
       * Purpose: Log existing message state before merge.
       * Details: docs/requirements_and_learnings/05_Open_Source_Modifications.md#librechat-cortex-followup-persist
       */
      logger.info(`[BackgroundCortexFollowUpService] DEBUG PERSIST: Found existing message, existing.content type=${typeof existing.content}, isArray=${Array.isArray(existing.content)}, length=${existing.content?.length || 0}`);
      /* VIVENTIUM NOTE */

      const merged = upsertCortexParts(existing.content, cortexParts);

      /* VIVENTIUM NOTE
       * Purpose: Log merge results and insight counts.
       * Details: docs/requirements_and_learnings/05_Open_Source_Modifications.md#librechat-cortex-followup-persist
       */
      logger.info(`[BackgroundCortexFollowUpService] DEBUG PERSIST: After merge, content length=${merged?.length || 0}`);
      const cortexInsightCount = merged?.filter(p => p?.type === ContentTypes.CORTEX_INSIGHT).length || 0;
      logger.info(`[BackgroundCortexFollowUpService] DEBUG PERSIST: CORTEX_INSIGHT parts in merged content: ${cortexInsightCount}`);
      /* VIVENTIUM NOTE */

      await db.updateMessage(
        req,
        { messageId: responseMessageId, content: merged },
        {
          context:
            'viventium/services/BackgroundCortexFollowUpService.persistCortexPartsToCanonicalMessage',
        },
      );

      /* VIVENTIUM NOTE
       * Purpose: Confirm persisted content size after update.
       * Details: docs/requirements_and_learnings/05_Open_Source_Modifications.md#librechat-cortex-followup-persist
       */
      logger.info(`[BackgroundCortexFollowUpService] DEBUG PERSIST: Successfully persisted ${merged?.length || 0} content parts to messageId=${responseMessageId}`);
      /* VIVENTIUM NOTE */

      return merged;
    } catch (err) {
      const isNotFound = String(err?.message || '').includes('message_not_found');
      const backoffMs = Math.min(250 * Math.pow(2, attempt - 1), 3000);
      if (isNotFound && attempt < maxAttempts) {
        await sleep(backoffMs);
        continue;
      }
      // For other errors, do not keep retrying blindly
      logger.warn(
        `[BackgroundCortexFollowUpService] Failed to persist cortex parts (attempt ${attempt}/${maxAttempts})`,
        err,
      );
      throw err;
    }
  }
  return null;
}

async function finalizeCanonicalCortexMessage({ req, messageId }) {
  if (!req?.user?.id || !messageId) {
    return null;
  }

  const existing = await db.getMessage({ user: req.user.id, messageId });
  if (!existing) {
    return null;
  }

  if (existing.unfinished !== true) {
    return existing;
  }

  await db.updateMessage(
    req,
    { messageId, unfinished: false },
    {
      context:
        'viventium/services/BackgroundCortexFollowUpService.finalizeCanonicalCortexMessage',
    },
  );

  return {
    ...existing,
    unfinished: false,
  };
}

function formatFollowUpText({
  insights = [],
  mergedPrompt = '',
  hasErrors = false,
  voiceMode = false,
  surface = '',
  scheduleId = '',
}) {
  /* === VIVENTIUM NOTE ===
   * Feature: Human-like follow-up fallback formatting (no system-notification preambles).
   *
   * Why:
   * - When follow-up LLM generation fails, we still may want to surface the raw insight text.
   * - We must NOT emit strings like "Background insights finished/completed" or cortex labels, per
   *   docs/requirements_and_learnings/01_Key_Principles.md (runtime-generated UX) + background agents
   *   design philosophy (subconscious realizations surface naturally).
   *
   * Behavior:
   * - If we have insights: return ONLY the insight text(s), separated by paragraphs.
   * - If we only have errors: return a short, user-safe line (no internal identifiers).
   * - Never surface mergedPrompt directly (it contains internal headings meant for LLM context).
   */

  const visibleInsightText = getPreferredFallbackInsightText({
    insights,
    scheduleId,
  });

  if (visibleInsightText) {
    return visibleInsightText;
  }

  if (hasErrors) {
    return getDeferredFallbackErrorText({ scheduleId });
  }

  // No meaningful follow-up.
  return '';
}

/* === VIVENTIUM START ===
 * Feature: Deduplicate redundant cortex insights before follow-up generation.
 * Added: 2026-02-24
 *
 * Why: When multiple cortices (up to 6) activate, they independently notice the same
 * "open loop" (e.g. "pancakes status?") and each produce an insight about it. The
 * follow-up LLM then sees the same topic amplified N times and treats it as high-priority,
 * overriding anti-repetition instructions.
 *
 * Approach: Simple lexical overlap — if >50% of significant words in one insight already
 * appear in a kept insight, drop the shorter/later one. This is deliberately lightweight
 * (no embeddings, no LLM call) to avoid adding latency to the follow-up path.
 */
function deduplicateInsights(insights) {
  if (!Array.isArray(insights) || insights.length <= 1) {
    return insights;
  }

  const kept = [];
  for (const insight of insights) {
    const text = (typeof insight.insight === 'string' ? insight.insight : '').toLowerCase();
    const words = text.split(/\s+/).filter((w) => w.length > 3);
    if (words.length === 0) {
      kept.push(insight);
      continue;
    }

    const isDuplicate = kept.some((k) => {
      const kText = (typeof k.insight === 'string' ? k.insight : '').toLowerCase();
      const kWords = new Set(kText.split(/\s+/).filter((w) => w.length > 3));
      if (kWords.size === 0) {
        return false;
      }
      const overlap = words.filter((w) => kWords.has(w)).length;
      return overlap / words.length > 0.5;
    });

    if (!isDuplicate) {
      kept.push(insight);
    } else {
      logger.debug(
        `[BackgroundCortexFollowUpService] Deduplicated redundant insight from ${insight.cortexName || insight.cortex_name || 'unknown'}`,
      );
    }
  }
  return kept;
}
/* === VIVENTIUM END === */

function formatFollowUpPrompt({
  insights = [],
  recentResponse = '',
  voiceMode = false,
  surface = '',
  primaryResponseMode = false,
}) {
  if (!Array.isArray(insights) || insights.length === 0) {
    return '';
  }

  const summaryLines = insights
    .map((i) => {
      const name = i.cortexName || i.cortex_name || 'Background Agent';
      const text = typeof i.insight === 'string' ? i.insight.trim() : '';
      if (!text) {
        return null;
      }
      const clipped = text.length > 700 ? `${text.slice(0, 700)}...` : text;
      return `- ${name}: ${clipped}`;
    })
    .filter(Boolean)
    .join('\n');

  if (!summaryLines) {
    return '';
  }

  const cleanRecent = typeof recentResponse === 'string' ? recentResponse.trim() : '';

  /* === VIVENTIUM NOTE ===
   * Feature: Voice follow-up prompt rules (speech-safe output).
   */
  const voiceRules = voiceMode ? buildVoiceFollowUpRules() : '';
  const telegramRules = surface === 'telegram' && !voiceMode ? buildTelegramTextInstructions() : '';
  const webRules =
    !voiceMode && surface !== 'telegram' && surface !== 'playground'
      ? buildWebTextInstructions()
      : '';
  const playgroundRules =
    surface === 'playground' && !voiceMode ? buildPlaygroundTextInstructions() : '';
  /* === VIVENTIUM NOTE === */

  /* === VIVENTIUM START ===
   * Feature: Anti-repetition follow-up prompt (fixes cortex follow-up echo bug).
   * Updated: 2026-02-24
   *
   * Why: The previous prompt buried the "don't repeat" instruction after the insights,
   * causing the follow-up LLM to echo topics already covered in Phase A. Multi-cortex
   * amplification (e.g. 6 cortices all mentioning "pancakes") further overwhelmed
   * the weak instruction.
   *
   * Fix: (1) Anti-repetition rule at the TOP (primacy effect), (2) include full recent
   * response (cap raised to 2400), (3) make {NTA} the default behavior, (4) explicit
   * "DO NOT repeat" language.
   */
  const recentBlock = cleanRecent
    ? cleanRecent.slice(0, 2400)
    : '(short acknowledgment)';

  if (primaryResponseMode) {
    return [
      'You are generating the primary user-visible answer for this turn.',
      'The assistant previously sent only a brief holding acknowledgement while background research/tools ran.',
      voiceRules,
      telegramRules,
      webRules,
      playgroundRules,
      `Prior visible hold text for context only (do NOT repeat it):\n---\n${recentBlock}\n---`,
      'Use the background insights below as your grounding and answer the user directly.',
      'This is not an addendum. This is the main answer that should replace the brief hold.',
      'Be complete enough to satisfy the user request on this surface, while staying grounded in the provided insights.',
      'If the insights still leave uncertainty, say what is uncertain instead of inventing details.',
      'Do not mention internal systems, background processing, or that the answer came later.',
      'Do not output {NTA} if the insights contain any substantive user-visible information.',
      '',
      'Background insights:',
      summaryLines,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  return [
    'You are the main AI continuing the same conversation.',
    'This is NOT a new user message. Do NOT start a new turn.',
    voiceRules,
    telegramRules,
    webRules,
    playgroundRules,
    '## CRITICAL: Do Not Repeat',
    `Here is the response you JUST sent to the user:\n---\n${recentBlock}\n---`,
    'You MUST NOT repeat, rephrase, re-ask, or echo ANY part of the above. If the background insights below overlap with what you already said, respond with {NTA}.',
    'Only respond if the insights contain genuinely NEW information not covered above.',
    'If an insight contains new factual/contextual material followed by a question, keep the new material and drop the question.',
    'Use {NTA} only when there is truly no new user-visible content beyond a question or repetition.',
    '',
    'Background insights that surfaced after your response:',
    summaryLines,
    '',
    'Decision:',
    '- If these insights are redundant or already covered by your recent response -> {NTA}',
    '- If they add meaningful NEW information -> write a brief continuation that adds ONLY the new parts.',
    '- On web/telegram text surfaces, preserve helpful structure with short paragraphs and bullet lists instead of flattening everything into one dense paragraph.',
    '- On voice/playground surfaces, keep it in plain conversational sentences.',
    '- Never ask the user a new question in this follow-up.',
    '- If an insight includes a question, drop the question and keep any accompanying factual material.',
    '- Use {NTA} only when nothing new remains after dropping questions and repetition.',
    'Do not mention internal systems, background processing, or that insights "surfaced".',
  ]
    .filter(Boolean)
    .join('\n\n');
  /* === VIVENTIUM END === */
}

function extractTextFromMessageContent(content) {
  if (!Array.isArray(content)) {
    return '';
  }

  const texts = content
    .filter((part) => part && part.type === ContentTypes.TEXT)
    .map((part) => {
      if (typeof part.text === 'string') {
        return part.text;
      }
      if (part.text && typeof part.text.value === 'string') {
        return part.text.value;
      }
      return '';
    })
    .filter((text) => text.length > 0);

  return texts.join('');
}

/* === VIVENTIUM START ===
 * Feature: Recent-response continuity fallback for Phase B follow-up.
 * Added: 2026-02-27
 *
 * Why:
 * - Some saved assistant messages keep Phase A text in `content[type=text]` while top-level `text`
 *   can be empty.
 * - If in-memory extraction misses this, follow-up prompt loses Phase A grounding and behaves like
 *   a fresh turn.
 */
function extractRecentResponseTextFromMessage(message) {
  if (!message || typeof message !== 'object') {
    return '';
  }

  const directText = typeof message.text === 'string' ? message.text.trim() : '';
  if (directText) {
    return directText;
  }

  return extractTextFromMessageContent(message.content).trim();
}

async function resolveRecentResponseText({ req, parentMessageId, recentResponse = '' }) {
  const inMemoryText = typeof recentResponse === 'string' ? recentResponse.trim() : '';
  if (inMemoryText) {
    return { text: inMemoryText, source: 'in_memory_content_parts' };
  }

  if (!req?.user?.id || !parentMessageId) {
    return { text: '', source: 'empty' };
  }

  try {
    const parentMessage = await db.getMessage({ user: req.user.id, messageId: parentMessageId });
    const parentText = extractRecentResponseTextFromMessage(parentMessage);
    if (parentText) {
      return { text: parentText, source: 'db_parent_message' };
    }
  } catch (err) {
    logger.warn(
      '[BackgroundCortexFollowUpService] Failed to load parent message for recent-response fallback:',
      err?.message || err,
    );
  }

  return { text: '', source: 'empty' };
}

async function generateFollowUpText({
  req,
  agent,
  insightsData,
  recentResponse = '',
  runId = '',
  primaryResponseMode = false,
}) {
  if (!agent) {
    return '';
  }
  const rawInsights = Array.isArray(insightsData?.insights) ? insightsData.insights : [];
  if (rawInsights.length === 0) {
    return '';
  }
  const insights = deduplicateInsights(rawInsights);
  if (insights.length === 0) {
    return '';
  }

  const voiceMode = isVoiceMode(req);
  const surface = resolveViventiumSurface(req);
  const prompt = formatFollowUpPrompt({
    insights,
    recentResponse,
    voiceMode,
    surface,
    primaryResponseMode,
  });
  if (!prompt) {
    return '';
  }

  /* === VIVENTIUM START ===
   * Feature: Voice Chat LLM Override — use voice model for follow-up when in voice call
   * Added: 2026-02-24
   */
  const { isVoiceCallActive } = require('./voiceLlmOverride');
  const useVoiceModel =
    isVoiceCallActive(req) && agent.voice_llm_model && agent.voice_llm_provider;
  const { runtimeAgent, effectiveModel, effectiveProvider } = await resolveCanonicalFollowUpAgent(agent, {
    useVoiceModel,
  });
  /* === VIVENTIUM END === */

  const providerName = normalizeFollowUpProvider(effectiveProvider).toLowerCase();
  if (!providerName || providerName === 'undefined' || providerName === 'null') {
    logger.warn(
      `[BackgroundCortexFollowUpService] Final follow-up provider resolution failed: agent_id=${runtimeAgent?.id || agent?.id || 'unknown'} runtime_provider=${String(runtimeAgent?.provider || '') || 'empty'} effective_provider=${String(effectiveProvider || '') || 'empty'} effective_model=${String(effectiveModel || '') || 'empty'}`,
    );
  }
  if (!providerName) {
    throw new Error(
      `Unable to resolve follow-up LLM provider for agent "${runtimeAgent?.id || agent?.id || 'unknown'}"`,
    );
  }
  const llmConfig = await resolveFollowUpLLMConfig({
    req,
    agent: runtimeAgent,
    providerName,
    effectiveModel,
    primaryResponseMode,
    useVoiceModel,
  });
  if (!llmConfig?.provider) {
    throw new Error(
      `Follow-up llmConfig missing provider for agent "${runtimeAgent?.id || agent?.id || 'unknown'}"`,
    );
  }

  /* === VIVENTIUM START ===
   * Feature: Minimal follow-up system prompt (fixes cortex follow-up echo bug).
   * Updated: 2026-02-24
   *
   * Why: The full agent personality (engagement style, ask-questions pattern) was being
   * injected as the system prompt for the follow-up LLM. This caused the model to
   * "engage" by re-asking open-loop questions from the insights, overriding the
   * anti-repetition instruction in the user message. The follow-up LLM's sole job is
   * to surface new info or emit {NTA} — it does not need personality or conversation
   * style directives.
   */
  const systemPromptParts = primaryResponseMode
    ? [
        'You are a conversational AI assistant completing a deferred response after a short holding acknowledgement.',
        'Your sole job: turn the background insights into the primary answer the user should see for this turn.',
        'Use the insights as grounding, answer directly, and stay surface-appropriate.',
        'Do not output {NTA} if the insights contain substantive user-visible information.',
        'Do not re-ask questions, do not mention background processing, and do not introduce yourself.',
      ]
    : [
        'You are a conversational AI assistant continuing an ongoing conversation.',
        'Your sole job: if background insights contain genuinely new information that was NOT in your recent response, add it in 1-3 natural sentences. Otherwise respond with exactly {NTA}.',
        'Do not re-ask questions, do not repeat topics, do not introduce yourself.',
      ];
  const noResponseInstructions = buildNoResponseInstructions(req);
  if (noResponseInstructions) {
    systemPromptParts.push(noResponseInstructions);
  }
  const systemPrompt = systemPromptParts.join('\n\n');
  /* === VIVENTIUM END === */

  const run = await Run.create({
    runId: `${runId || 'followup'}-followup`,
    graphConfig: {
      type: 'standard',
      llmConfig,
      tools: [],
      instructions: systemPrompt,
    },
    returnContent: true,
  });

  const config = {
    runName: 'BackgroundFollowUp',
    configurable: {
      thread_id: runId || 'followup',
    },
    streamMode: 'values',
    recursionLimit: 3,
    version: 'v2',
  };

  const content = await run.processStream({ messages: [new HumanMessage(prompt)] }, config);

  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
  } else if (content?.text) {
    text = content.text;
  }

  const rawText = String(text || '').trim();
  if (rawText.length === 0) {
    return '';
  }
  const strippedText = stripQuestionSentences(rawText);
  const sanitizedText = sanitizeFollowUpDisplayText(strippedText);
  const normalizedText = normalizeNoResponseText(sanitizedText).trim();

  if (
    isNoResponseOnly(rawText) ||
    isNoResponseOnly(sanitizedText) ||
    isNoResponseOnly(normalizedText) ||
    normalizedText.length === 0
  ) {
    return NO_RESPONSE_TAG;
  }

  if (process.env.VIVENTIUM_DEBUG_PHASE_B === 'true') {
    const preview = (value) => String(value || '').slice(0, 220).replace(/\s+/g, ' ');
    logger.info(
      `[BackgroundCortexFollowUpService] Follow-up text stages: primary=${primaryResponseMode} raw_len=${rawText.length} stripped_len=${strippedText.length} sanitized_len=${sanitizedText.length} normalized_len=${normalizedText.length} raw="${preview(rawText)}" stripped="${preview(strippedText)}" sanitized="${preview(sanitizedText)}" normalized="${preview(normalizedText)}"`,
    );
  }

  return normalizedText;
}

async function createCortexFollowUpMessage({
  req,
  conversationId,
  parentMessageId,
  agent,
  insightsData,
  recentResponse,
  replaceParentMessage = false,
}) {
  let text = '';
  const hasInsights = Array.isArray(insightsData?.insights) && insightsData.insights.length > 0;
  const voiceMode = isVoiceMode(req);
  const surface = resolveViventiumSurface(req);
  const scheduleId = typeof req?.body?.scheduleId === 'string' ? req.body.scheduleId : '';
  const recentResponseResolution = await resolveRecentResponseText({
    req,
    parentMessageId,
    recentResponse,
  });
  if (process.env.VIVENTIUM_DEBUG_PHASE_B === 'true') {
    const recentPreview = recentResponseResolution.text.slice(0, 160).replace(/\s+/g, ' ');
    logger.info(
      `[BackgroundCortexFollowUpService] Follow-up context: parent=${parentMessageId || ''} recent_response_source=${recentResponseResolution.source} len=${recentResponseResolution.text.length} preview="${recentPreview}"`,
    );
  } else {
    logger.info(
      `[BackgroundCortexFollowUpService] Follow-up context: parent=${parentMessageId || ''} recent_response_source=${recentResponseResolution.source} len=${recentResponseResolution.text.length}`,
    );
  }

  if (hasInsights) {
    try {
      text = await generateFollowUpText({
        req,
        agent,
        insightsData,
        recentResponse: recentResponseResolution.text,
        runId: parentMessageId || conversationId || '',
        primaryResponseMode: replaceParentMessage === true,
      });
    } catch (err) {
      logger.warn('[BackgroundCortexFollowUpService] Failed to generate LLM follow-up text:', err);
    }
  }

  const { text: resolvedText, decision } = resolveFollowUpPersistenceText({
    generatedText: text,
    insightsData,
    replaceParentMessage,
    voiceMode,
    surface,
    scheduleId,
  });
  text = resolvedText;

  logger.info('[BackgroundCortexFollowUpService] Follow-up persistence decision', {
    conversationId,
    parentMessageId,
    replaceParentMessage: decision.replaceParentMessage,
    hasInsights: decision.hasInsights,
    llmResult: decision.llmResult,
    selectedStrategy: decision.selectedStrategy,
    suppressionReason: decision.suppressionReason || null,
    finalLength: decision.finalLength,
  });

  if (!text || text.trim().length === 0) {
    return null;
  }

  /* === VIVENTIUM START ===
   * Feature: Follow-up branch-safe parent resolution.
   * Added: 2026-02-21
   *
   * Why:
   * - If a user sends a new message before this async follow-up persists, attaching the follow-up
   *   to the original `parentMessageId` creates a sibling split.
   * - LibreChat defaults to newest sibling, which can strand the visible branch on a dead-end node.
   *
   * Approach:
   * - Keep semantic lineage in metadata (`metadata.viventium.parentMessageId`).
   * - Attach the follow-up node to the current conversation tip (`treeParentId`) to preserve one
   *   continuous visible branch in UI.
   */
  let treeParentId = parentMessageId;
  if (req?.user?.id && conversationId) {
    try {
      const messages = await db.getMessages(
        { user: req.user.id, conversationId },
        'messageId parentMessageId createdAt updatedAt',
      );
      const currentLeafMessageId = resolveConversationLeafMessageId(messages, parentMessageId);
      if (currentLeafMessageId) {
        treeParentId = currentLeafMessageId;
      }
    } catch (err) {
      logger.warn('[BackgroundCortexFollowUpService] Failed resolving conversation tip:', err?.message);
    }
  }
  /* === VIVENTIUM END === */

  const messageId = crypto.randomUUID();
  const sender = 'AI';

  const endpoint = EModelEndpoint.agents;
  const model = agent?.id ?? agent?.model ?? '';
  const metadata = {
    viventium: {
      type: 'cortex_followup',
      parentMessageId,
      cortexCount: insightsData?.cortexCount ?? undefined,
      replacedParentMessage: replaceParentMessage === true,
    },
  };

  if (replaceParentMessage === true && req?.user?.id && parentMessageId) {
    const parentMessage = await db.getMessage({ user: req.user.id, messageId: parentMessageId });
    if (parentMessage) {
      const parentTreeId =
        typeof parentMessage.parentMessageId === 'string' && parentMessage.parentMessageId.length > 0
          ? parentMessage.parentMessageId
          : parentMessageId;
      const mergedContent = mergeFollowUpTextIntoParentContent(parentMessage.content, text);

      await db.updateMessage(
        req,
        {
          messageId: parentMessageId,
          text,
          content: mergedContent,
          unfinished: false,
          metadata: {
            ...((parentMessage.metadata && typeof parentMessage.metadata === 'object')
              ? parentMessage.metadata
              : {}),
            ...metadata,
          },
        },
        {
          context:
            'viventium/services/BackgroundCortexFollowUpService.createCortexFollowUpMessage replaceParentMessage',
        },
      );

      return {
        messageId: parentMessageId,
        conversationId,
        parentMessageId: parentTreeId,
        sender: parentMessage.sender || sender,
        endpoint,
        model,
        agent_id: agent?.id,
        text,
        isCreatedByUser: false,
        unfinished: false,
        metadata,
        content: mergedContent,
      };
    }
  }

  const followUpMessage = {
    messageId,
    conversationId,
    parentMessageId: treeParentId,
    sender,
    endpoint,
    model,
    agent_id: agent?.id,
    text,
    isCreatedByUser: false,
    metadata,
  };

  await db.saveMessage(req, followUpMessage, {
    context: 'viventium/services/BackgroundCortexFollowUpService.createCortexFollowUpMessage',
  });

  return followUpMessage;
}

module.exports = {
  cleanFallbackInsightText,
  getVisibleFallbackInsightTexts,
  isOperationalFallbackParagraph,
  upsertCortexParts,
  persistCortexPartsToCanonicalMessage,
  finalizeCanonicalCortexMessage,
  createCortexFollowUpMessage,
  generateFollowUpText,
  formatFollowUpText,
  deduplicateInsights,
  formatFollowUpPrompt,
  extractRecentResponseTextFromMessage,
  getPreferredFallbackInsightText,
  resolveRecentResponseText,
  resolveFollowUpPersistenceText,
  resolveConversationLeafMessageId,
  sanitizeAnthropicFollowUpLLMConfig,
  stripQuestionSentences,
};
