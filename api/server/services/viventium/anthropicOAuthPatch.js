/* === VIVENTIUM START ===
 * Feature: Anthropic connected-account OAuth system prompt patch.
 * Purpose:
 * - Anthropic subscription bearer tokens require the Claude Code system prompt
 *   on `/v1/messages` requests.
 * - `@librechat/agents` currently builds valid auth headers for this flow but
 *   does not prepend that required system block.
 * - Patch the runtime `CustomAnthropic` class in a tracked repo file instead of
 *   relying on edited package output under node_modules.
 * Added: 2026-03-19
 * === VIVENTIUM END === */
const path = require('path');

const { logger } = require('@librechat/data-schemas');

const PATCH_FLAG = Symbol.for('viventium.anthropic.oauth.system.patch.v1');
const ANTHROPIC_OAUTH_SYSTEM_TEXT =
  "You are Claude Code, Anthropic's official CLI for Claude.";
const AGENTS_CJS_DIR = path.dirname(require.resolve('@librechat/agents'));

const requireAgentsCjsModule = (relativePath) =>
  require(path.join(AGENTS_CJS_DIR, relativePath));

function isAnthropicTextBlock(value) {
  return (
    value != null &&
    typeof value === 'object' &&
    value.type === 'text' &&
    typeof value.text === 'string'
  );
}

function prependAnthropicOAuthSystemBlock(blocks) {
  if (
    blocks.length > 0 &&
    isAnthropicTextBlock(blocks[0]) &&
    blocks[0].text === ANTHROPIC_OAUTH_SYSTEM_TEXT
  ) {
    return blocks;
  }

  return [{ type: 'text', text: ANTHROPIC_OAUTH_SYSTEM_TEXT }, ...blocks];
}

function ensureAnthropicOAuthSystemPrompt(request) {
  const system = request?.system;

  if (Array.isArray(system)) {
    return {
      ...request,
      system: prependAnthropicOAuthSystemBlock(
        system.filter((block) => block != null && typeof block === 'object'),
      ),
    };
  }

  if (typeof system === 'string') {
    return {
      ...request,
      system:
        system.trim().length > 0
          ? prependAnthropicOAuthSystemBlock([{ type: 'text', text: system }])
          : [{ type: 'text', text: ANTHROPIC_OAUTH_SYSTEM_TEXT }],
    };
  }

  if (system != null && typeof system === 'object') {
    const content = system.content;
    if (Array.isArray(content)) {
      return {
        ...request,
        system: prependAnthropicOAuthSystemBlock(
          content.filter((block) => block != null && typeof block === 'object'),
        ),
      };
    }

    if (typeof content === 'string' && content.trim().length > 0) {
      return {
        ...request,
        system: prependAnthropicOAuthSystemBlock([{ type: 'text', text: content }]),
      };
    }
  }

  return {
    ...request,
    system: [{ type: 'text', text: ANTHROPIC_OAUTH_SYSTEM_TEXT }],
  };
}

function shouldInjectAnthropicOAuthSystemPrompt(instance) {
  const clientOptions = instance?.clientOptions;
  if (typeof clientOptions?.authToken === 'string') {
    return true;
  }

  const anthropicBeta = clientOptions?.defaultHeaders?.['anthropic-beta'];
  return typeof anthropicBeta === 'string' && anthropicBeta.includes('oauth-2025-04-20');
}

function normalizeAnthropicOAuthRequest(instance, request) {
  if (!shouldInjectAnthropicOAuthSystemPrompt(instance)) {
    return request;
  }

  return ensureAnthropicOAuthSystemPrompt(request);
}

function applyAnthropicOAuthPatch() {
  const { CustomAnthropic } = requireAgentsCjsModule('llm/anthropic/index.cjs');
  if (!CustomAnthropic?.prototype) {
    logger.warn('[Anthropic OAuth Patch] CustomAnthropic prototype unavailable');
    return false;
  }

  if (CustomAnthropic.prototype[PATCH_FLAG]) {
    return true;
  }

  const originalCreateStreamWithRetry = CustomAnthropic.prototype.createStreamWithRetry;
  const originalCompletionWithRetry = CustomAnthropic.prototype.completionWithRetry;

  if (
    typeof originalCreateStreamWithRetry !== 'function' ||
    typeof originalCompletionWithRetry !== 'function'
  ) {
    logger.warn('[Anthropic OAuth Patch] Anthropic retry methods unavailable');
    return false;
  }

  Object.defineProperty(CustomAnthropic.prototype, PATCH_FLAG, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });

  CustomAnthropic.prototype.createStreamWithRetry = function createStreamWithRetryPatched(
    request,
    options,
  ) {
    return originalCreateStreamWithRetry.call(
      this,
      normalizeAnthropicOAuthRequest(this, request),
      options,
    );
  };

  CustomAnthropic.prototype.completionWithRetry = function completionWithRetryPatched(
    request,
    options,
  ) {
    return originalCompletionWithRetry.call(
      this,
      normalizeAnthropicOAuthRequest(this, request),
      options,
    );
  };

  logger.info('[Anthropic OAuth Patch] Installed CustomAnthropic request normalizer');
  return true;
}

try {
  applyAnthropicOAuthPatch();
} catch (error) {
  logger.error(
    `[Anthropic OAuth Patch] Failed to install: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

module.exports = {
  ANTHROPIC_OAUTH_SYSTEM_TEXT,
  applyAnthropicOAuthPatch,
  ensureAnthropicOAuthSystemPrompt,
};
