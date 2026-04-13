import { logger } from '@librechat/data-schemas';
import { AnthropicClientOptions } from '@librechat/agents';
import {
  EModelEndpoint,
  AnthropicEffort,
  anthropicSettings,
  supportsContext1m,
  supportsAdaptiveThinking,
} from 'librechat-data-provider';
import { matchModelName } from '~/utils/tokens';

/**
 * @param {string} modelName
 * @returns {boolean}
 */
function checkPromptCacheSupport(modelName: string): boolean {
  const modelMatch = matchModelName(modelName, EModelEndpoint.anthropic) ?? '';
  if (
    modelMatch.includes('claude-3-5-sonnet-latest') ||
    modelMatch.includes('claude-3.5-sonnet-latest')
  ) {
    return false;
  }

  return (
    /claude-3[-.]7/.test(modelMatch) ||
    /claude-3[-.]5-(?:sonnet|haiku)/.test(modelMatch) ||
    /claude-3-(?:sonnet|haiku|opus)?/.test(modelMatch) ||
    /claude-(?:sonnet|opus|haiku)-[4-9]/.test(modelMatch) ||
    /claude-[4-9]-(?:sonnet|opus|haiku)?/.test(modelMatch) ||
    /claude-4(?:-(?:sonnet|opus|haiku))?/.test(modelMatch)
  );
}

/**
 * Gets the appropriate headers for Claude models with cache control
 * @param {string} model The model name
 * @param {boolean} supportsCacheControl Whether the model supports cache control
 * @returns {AnthropicClientOptions['extendedOptions']['defaultHeaders']|undefined} The headers object or undefined if not applicable
 */
function getClaudeHeaders(
  model: string,
  supportsCacheControl: boolean,
  isOAuthToken = false,
): Record<string, string> | undefined {
  if (!supportsCacheControl) {
    return undefined;
  }

  if (isOAuthToken) {
    /**
     * Anthropic OAuth/subscription tokens have stricter beta-header requirements.
     * We avoid injecting model-specific cache/context betas here and let the OAuth
     * path set only required OAuth-compatible betas.
     */
    return undefined;
  }

  if (/claude-3[-.]5-sonnet/.test(model)) {
    return {
      'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15',
    };
  } else if (/claude-3[-.]7/.test(model)) {
    return {
      'anthropic-beta': 'token-efficient-tools-2025-02-19,output-128k-2025-02-19',
    };
  } else if (supportsContext1m(model)) {
    return {
      'anthropic-beta': 'context-1m-2025-08-07',
    };
  }

  return undefined;
}

/* === VIVENTIUM START ===
 * Feature: Anthropic thinking/temperature compatibility guard.
 * Purpose: Anthropic rejects temperature whenever thinking is active, including adaptive thinking
 * that can be enabled later by runtime defaults.
 * === VIVENTIUM END === */
function hasActiveAnthropicThinking(thinking: unknown): boolean {
  if (thinking == null || thinking === false) {
    return false;
  }

  if (thinking === true) {
    return true;
  }

  if (typeof thinking !== 'object' || Array.isArray(thinking)) {
    return true;
  }

  const typedThinking = thinking as { type?: unknown; enabled?: unknown };
  const type =
    typeof typedThinking.type === 'string' ? typedThinking.type.trim().toLowerCase() : '';
  if (type === 'disabled' || typedThinking.enabled === false) {
    return false;
  }

  return true;
}

function sanitizeAnthropicTemperatureForThinking<
  T extends { thinking?: unknown; temperature?: number | null },
>(config: T): T {
  if (!hasActiveAnthropicThinking(config?.thinking) || config?.temperature == null) {
    return config;
  }

  const nextConfig = { ...config };
  delete nextConfig.temperature;
  return nextConfig;
}

/**
 * Configures reasoning-related options for Claude models.
 * Models supporting adaptive thinking (Opus 4.6+, Sonnet 5+) use effort control instead of manual budget_tokens.
 */
function configureReasoning(
  anthropicInput: AnthropicClientOptions & { max_tokens?: number },
  extendedOptions: {
    thinking?: boolean;
    thinkingBudget?: number | null;
    effort?: AnthropicEffort | string | null;
  } = {},
): AnthropicClientOptions & { max_tokens?: number } {
  const updatedOptions = { ...anthropicInput };
  const currentMaxTokens = updatedOptions.max_tokens ?? updatedOptions.maxTokens;
  const modelName = updatedOptions.model ?? '';

  if (extendedOptions.thinking && modelName && supportsAdaptiveThinking(modelName)) {
    updatedOptions.thinking = { type: 'adaptive' };

    const effort = extendedOptions.effort;
    if (effort && effort !== AnthropicEffort.unset) {
      updatedOptions.invocationKwargs = {
        ...updatedOptions.invocationKwargs,
        output_config: { effort },
      };
    }

    if (currentMaxTokens == null) {
      updatedOptions.max_tokens = anthropicSettings.maxOutputTokens.reset(modelName);
    }

    return sanitizeAnthropicTemperatureForThinking(updatedOptions);
  }

  if (
    extendedOptions.thinking &&
    modelName &&
    (/claude-3[-.]7/.test(modelName) || /claude-(?:sonnet|opus|haiku)-[4-9]/.test(modelName))
  ) {
    updatedOptions.thinking = {
      ...updatedOptions.thinking,
      type: 'enabled',
    } as { type: 'enabled'; budget_tokens: number };
  }

  if (
    updatedOptions.thinking != null &&
    extendedOptions.thinkingBudget != null &&
    updatedOptions.thinking.type === 'enabled'
  ) {
    updatedOptions.thinking = {
      ...updatedOptions.thinking,
      budget_tokens: extendedOptions.thinkingBudget,
    };
  }

  if (
    updatedOptions.thinking != null &&
    updatedOptions.thinking.type === 'enabled' &&
    (currentMaxTokens == null || updatedOptions.thinking.budget_tokens > currentMaxTokens)
  ) {
    const maxTokens = anthropicSettings.maxOutputTokens.reset(modelName);
    updatedOptions.max_tokens = currentMaxTokens ?? maxTokens;

    logger.warn(
      updatedOptions.max_tokens === maxTokens
        ? '[AnthropicClient] max_tokens is not defined while thinking is enabled. Setting max_tokens to model default.'
        : `[AnthropicClient] thinking budget_tokens (${updatedOptions.thinking.budget_tokens}) exceeds max_tokens (${updatedOptions.max_tokens}). Adjusting budget_tokens.`,
    );

    updatedOptions.thinking.budget_tokens = Math.min(
      updatedOptions.thinking.budget_tokens,
      Math.floor((updatedOptions.max_tokens ?? 0) * 0.9),
    );
  }

  return sanitizeAnthropicTemperatureForThinking(updatedOptions);
}

export {
  checkPromptCacheSupport,
  getClaudeHeaders,
  configureReasoning,
  hasActiveAnthropicThinking,
  sanitizeAnthropicTemperatureForThinking,
  supportsAdaptiveThinking,
};
