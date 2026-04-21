/* === VIVENTIUM START ===
 * Feature: Anthropic thinking-block runtime patch.
 * Purpose:
 * - Anthropic tool-follow-up requests can fail when streamed reasoning leaves
 *   malformed `thinking` blocks in the in-memory LangChain messages.
 * - The `@librechat/agents` graph checks only for the presence of a thinking
 *   block type before deciding whether an assistant/tool chain is valid for a
 *   thinking-enabled Anthropic continuation.
 * - If the block is incomplete (`signature` without `thinking`, or vice versa),
 *   Anthropic rejects the follow-up request with:
 *     `messages.N.content.M.thinking.thinking: Field required`
 * - Patch the runtime `ensureThinkingBlockInMessages()` path from a tracked repo
 *   file instead of editing package output under node_modules.
 * Added: 2026-04-21
 * === VIVENTIUM END === */
'use strict';

const path = require('path');

const { logger } = require('@librechat/data-schemas');

const PATCH_FLAG = Symbol.for('viventium.anthropic.thinking.patch.v1');
const AGENTS_CJS_DIR = path.dirname(require.resolve('@librechat/agents'));

const requireAgentsCjsModule = (relativePath) =>
  require(path.join(AGENTS_CJS_DIR, relativePath));

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAssistantLikeMessage(message) {
  if (!message || typeof message !== 'object') {
    return false;
  }

  if (typeof message._getType === 'function') {
    return String(message._getType()).toLowerCase() === 'ai';
  }

  if (typeof message.getType === 'function') {
    return String(message.getType()).toLowerCase() === 'ai';
  }

  return String(message.role || '').toLowerCase() === 'assistant';
}

function sanitizeAnthropicThinkingBlocks(content) {
  if (!Array.isArray(content)) {
    return content;
  }

  let changed = false;
  const sanitized = [];

  for (const part of content) {
    if (!part || typeof part !== 'object') {
      sanitized.push(part);
      continue;
    }

    if (part.type === 'thinking') {
      const last = sanitized[sanitized.length - 1];
      const sameIndex =
        last &&
        typeof last === 'object' &&
        last.type === 'thinking' &&
        (last.index ?? null) === (part.index ?? null);

      if (sameIndex) {
        const merged = { ...last };
        if (isNonEmptyString(part.thinking)) {
          merged.thinking = isNonEmptyString(last.thinking)
            ? `${last.thinking}${part.thinking}`
            : part.thinking;
        }
        if (isNonEmptyString(part.signature)) {
          merged.signature = isNonEmptyString(last.signature)
            ? `${last.signature}${part.signature}`
            : part.signature;
        }
        sanitized[sanitized.length - 1] = merged;
        changed = true;
        continue;
      }

      sanitized.push({ ...part });
      continue;
    }

    if (part.type === 'redacted_thinking') {
      sanitized.push({ ...part });
      continue;
    }

    sanitized.push(part);
  }

  const validated = [];
  for (const part of sanitized) {
    if (!part || typeof part !== 'object') {
      validated.push(part);
      continue;
    }

    if (part.type === 'thinking') {
      if (!isNonEmptyString(part.thinking) || !isNonEmptyString(part.signature)) {
        changed = true;
        continue;
      }
      validated.push(part);
      continue;
    }

    if (part.type === 'redacted_thinking') {
      if (!isNonEmptyString(part.data)) {
        changed = true;
        continue;
      }
      validated.push(part);
      continue;
    }

    validated.push(part);
  }

  return changed ? validated : content;
}

function sanitizeMessagesForAnthropicThinking(messages) {
  if (!Array.isArray(messages)) {
    return messages;
  }

  for (const message of messages) {
    if (!isAssistantLikeMessage(message) || !Array.isArray(message.content)) {
      continue;
    }

    const sanitized = sanitizeAnthropicThinkingBlocks(message.content);
    if (sanitized === message.content) {
      continue;
    }

    message.content = sanitized;
    if (message.lc_kwargs && typeof message.lc_kwargs === 'object') {
      message.lc_kwargs.content = sanitized;
    }
    if (message.kwargs && typeof message.kwargs === 'object') {
      message.kwargs.content = sanitized;
    }
  }

  return messages;
}

function applyAnthropicThinkingPatch() {
  const formatModule = requireAgentsCjsModule('messages/format.cjs');
  if (!formatModule || typeof formatModule.ensureThinkingBlockInMessages !== 'function') {
    logger.warn('[Anthropic Thinking Patch] ensureThinkingBlockInMessages unavailable');
    return false;
  }

  if (formatModule[PATCH_FLAG]) {
    return true;
  }

  const originalEnsureThinkingBlockInMessages = formatModule.ensureThinkingBlockInMessages;

  Object.defineProperty(formatModule, PATCH_FLAG, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });

  formatModule.ensureThinkingBlockInMessages = function ensureThinkingBlockInMessagesPatched(
    messages,
    provider,
  ) {
    const normalizedProvider =
      typeof provider === 'string' ? provider.trim().toLowerCase() : '';
    if (normalizedProvider !== 'anthropic') {
      return originalEnsureThinkingBlockInMessages(messages, provider);
    }

    return originalEnsureThinkingBlockInMessages(
      sanitizeMessagesForAnthropicThinking(messages),
      provider,
    );
  };

  logger.info('[Anthropic Thinking Patch] Installed thinking-block sanitizer');
  return true;
}

try {
  applyAnthropicThinkingPatch();
} catch (error) {
  logger.error(
    `[Anthropic Thinking Patch] Failed to install: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

module.exports = {
  applyAnthropicThinkingPatch,
  isAssistantLikeMessage,
  sanitizeAnthropicThinkingBlocks,
  sanitizeMessagesForAnthropicThinking,
};
