/* === VIVENTIUM START ===
 * File: api/server/services/viventium/normalizeTextContentParts.js
 *
 * Purpose:
 * - Normalize LibreChat message `content` parts so provider adapters always receive valid `text` strings.
 *
 * Root Cause (legacy cloud production bug):
 * - Some persisted messages store text parts as `{ type: "text", text: { value: "..." } }`
 *   (OpenAI Assistants-style content shape).
 * - Anthropic expects `content[].text` to be a string, so requests fail with:
 *     messages.N.content.M.text.text: Input should be a valid string
 *
 * Safety:
 * - Only rewrites `type: "text"` parts.
 * - Leaves non-text parts unchanged (tool_call, image_url, cortex parts, etc).
 * - Returns original references when no changes are required.
 *
 * Added: 2026-02-08
 * === VIVENTIUM END === */

'use strict';

const { ContentTypes } = require('librechat-data-provider');

/**
 * @param {unknown} text
 * @returns {string}
 */
function coerceTextToString(text) {
  if (typeof text === 'string') {
    return text;
  }
  if (text == null) {
    return '';
  }
  if (typeof text === 'number' || typeof text === 'boolean') {
    return String(text);
  }
  if (typeof text !== 'object') {
    return '';
  }

  // OpenAI Assistants message content: { text: { value: string, annotations?: [] } }
  if (typeof text.value === 'string') {
    return text.value;
  }

  // Some adapters nest text as { text: string } or { text: { value: string } }
  if (typeof text.text === 'string') {
    return text.text;
  }
  if (text.text && typeof text.text === 'object') {
    if (typeof text.text.value === 'string') {
      return text.text.value;
    }
    if (typeof text.text.text === 'string') {
      return text.text.text;
    }
  }

  return '';
}

/**
 * Normalize `type: "text"` blocks so `.text` is always a string.
 *
 * @template T
 * @param {T} contentParts
 * @returns {T}
 */
function normalizeTextContentParts(contentParts) {
  if (!Array.isArray(contentParts)) {
    return contentParts;
  }

  let changed = false;

  /** @type {any[]} */
  const normalized = [];
  for (const part of contentParts) {
    /* === VIVENTIUM START ===
     * Feature: Drop null/malformed blocks before provider formatting.
     * Root cause (legacy cloud 2026-02-19): Null entries in message.content caused
     * `Cannot read properties of null (reading 'type')` during formatting.
     * === VIVENTIUM END === */
    if (part == null) {
      changed = true;
      continue;
    }
    if (typeof part === 'string') {
      const text = part;
      changed = true;
      if (!text.trim()) {
        continue;
      }
      normalized.push({
        type: ContentTypes.TEXT,
        text,
        [ContentTypes.TEXT]: text,
      });
      continue;
    }
    if (typeof part !== 'object') {
      changed = true;
      continue;
    }
    if (part.type !== ContentTypes.TEXT) {
      normalized.push(part);
      continue;
    }

    const rawText = part.text ?? part[ContentTypes.TEXT];
    if (rawText == null || typeof rawText === 'string') {
      normalized.push(part);
      continue;
    }

    const coerced = coerceTextToString(rawText);
    changed = true;
    normalized.push({
      ...part,
      text: coerced,
      [ContentTypes.TEXT]: coerced,
    });
  }

  /* === VIVENTIUM START ===
   * Feature: Strip empty text content blocks that Anthropic rejects.
   * Root cause (legacy cloud 2026-02-18): Cortex filtering and message normalization
   * can leave { type: "text", text: "" } blocks in the content array.
   * Anthropic returns 400: "messages: text content blocks must be non-empty".
   * Google/Gemini tolerates these, so the error is provider-specific.
   * Fix: Remove text blocks where the coerced string is empty/whitespace-only.
   * === VIVENTIUM END === */
  const filtered = normalized.filter((part) => {
    if (!part || typeof part !== 'object' || part.type !== ContentTypes.TEXT) {
      return true;
    }
    const text = typeof part.text === 'string' ? part.text : '';
    return text.trim() !== '';
  });
  if (filtered.length !== normalized.length) {
    changed = true;
  }

  // Return original reference when no normalization was needed.
  return changed ? filtered : contentParts;
}

/**
 * Normalize persisted message payloads so `message.content[].text` is always a string.
 *
 * @template T
 * @param {T} payload
 * @returns {T}
 */
function normalizeTextPartsInPayload(payload) {
  if (!Array.isArray(payload)) {
    return payload;
  }

  let changed = false;

  /** @type {any[]} */
  const normalized = payload.map((message) => {
    if (!message || typeof message !== 'object') {
      return message;
    }
    if (!Array.isArray(message.content)) {
      return message;
    }

    const newContent = normalizeTextContentParts(message.content);
    if (newContent === message.content) {
      return message;
    }

    changed = true;
    return { ...message, content: newContent };
  });

  // Return original reference when no normalization was needed.
  return changed ? normalized : payload;
}

/* === VIVENTIUM START ===
 * Feature: Preserve LangChain message prototypes during Anthropic sanitization.
 *
 * Root Cause (legacy cloud 2026-02-19):
 * - `sanitizeAnthropicFormattedMessages()` rebuilt changed messages with object spread:
 *     { ...message, content: nextContent }
 * - For LangChain BaseMessage instances, spreading strips prototype methods (`_getType`, `getType`),
 *   producing plain objects that later fail in memory + run coercion paths.
 *
 * Fix:
 * - Clone changed messages while preserving their prototype and synchronized serialized kwargs.
 * === VIVENTIUM END === */
function cloneSanitizedMessage(message, content) {
  if (!message || typeof message !== 'object') {
    return message;
  }

  const proto = Object.getPrototypeOf(message);
  const hasLangChainMethods =
    typeof message._getType === 'function' || typeof message.getType === 'function';

  if (hasLangChainMethods && proto) {
    const clone = Object.assign(Object.create(proto), message, { content });
    if (clone.lc_kwargs && typeof clone.lc_kwargs === 'object') {
      clone.lc_kwargs = { ...clone.lc_kwargs, content };
    }
    if (clone.kwargs && typeof clone.kwargs === 'object') {
      clone.kwargs = { ...clone.kwargs, content };
    }
    return clone;
  }

  const plain = { ...message, content };
  if (plain.lc_kwargs && typeof plain.lc_kwargs === 'object') {
    plain.lc_kwargs = { ...plain.lc_kwargs, content };
  }
  if (plain.kwargs && typeof plain.kwargs === 'object') {
    plain.kwargs = { ...plain.kwargs, content };
  }
  return plain;
}

const STRICT_TEXT_SANITIZER_PROVIDERS_DEFAULT = new Set(['anthropic']);

/**
 * Normalize provider key for policy lookups.
 * @param {unknown} provider
 * @returns {string}
 */
function normalizeProviderKey(provider) {
  if (typeof provider !== 'string') {
    return '';
  }
  return provider.trim().toLowerCase();
}

/**
 * Return providers that need strict non-empty text sanitization.
 * Environment override:
 * - VIVENTIUM_STRICT_TEXT_SANITIZER_PROVIDERS=anthropic,custom_provider
 *
 * @returns {Set<string>}
 */
function getStrictTextSanitizerProviders() {
  const raw = process.env.VIVENTIUM_STRICT_TEXT_SANITIZER_PROVIDERS;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return STRICT_TEXT_SANITIZER_PROVIDERS_DEFAULT;
  }
  const values = raw
    .split(',')
    .map((value) => normalizeProviderKey(value))
    .filter(Boolean);
  if (values.length === 0) {
    return STRICT_TEXT_SANITIZER_PROVIDERS_DEFAULT;
  }
  return new Set(values);
}

/**
 * Provider policy gate for strict text sanitization.
 * @param {unknown} provider
 * @returns {boolean}
 */
function providerNeedsStrictTextSanitizer(provider) {
  const normalized = normalizeProviderKey(provider);
  if (!normalized) {
    return false;
  }
  return getStrictTextSanitizerProviders().has(normalized);
}

/* === VIVENTIUM START ===
 * Feature: Anthropic-safe formatted message sanitization
 *
 * Root Cause (legacy cloud 2026-02-19):
 * - Historical assistant turns can produce empty/invalid text blocks after formatting.
 * - Anthropic rejects these with:
 *     messages: text content blocks must be non-empty
 *
 * Scope:
 * - Applied after `formatAgentMessages`, right before run execution.
 * - Preserves ordering while removing malformed and empty text blocks.
 * - Guarantees no empty content for provider-bound messages.
 * === VIVENTIUM END === */
function sanitizeAnthropicFormattedMessages(messages) {
  if (!Array.isArray(messages)) {
    return messages;
  }

  let changed = false;
  const sanitized = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      changed = true;
      continue;
    }

    const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    const fallbackContent = hasToolCalls ? 'Tool call context.' : 'Context message.';
    let nextContent = message.content;

    if (Array.isArray(nextContent)) {
      const originalParts = nextContent;
      const filteredParts = [];
      for (const part of nextContent) {
        if (!part || typeof part !== 'object') {
          changed = true;
          continue;
        }

        const isTextLike =
          part.type === ContentTypes.TEXT ||
          part.text != null ||
          part[ContentTypes.TEXT] != null;

        if (!isTextLike) {
          filteredParts.push(part);
          continue;
        }

        const text = coerceTextToString(part.text ?? part[ContentTypes.TEXT]);
        if (!text.trim()) {
          changed = true;
          continue;
        }

        if (
          part.type === ContentTypes.TEXT &&
          part.text === text &&
          part[ContentTypes.TEXT] === text
        ) {
          filteredParts.push(part);
          continue;
        }

        changed = true;
        filteredParts.push({
          ...part,
          type: ContentTypes.TEXT,
          text,
          [ContentTypes.TEXT]: text,
        });
      }

      if (filteredParts.length === 0) {
        changed = true;
        nextContent = fallbackContent;
      } else {
        const unchanged =
          filteredParts.length === originalParts.length &&
          filteredParts.every((part, index) => part === originalParts[index]);
        if (unchanged) {
          nextContent = originalParts;
        } else {
          changed = true;
          nextContent = filteredParts;
        }
      }
    } else if (typeof nextContent === 'string') {
      if (!nextContent.trim()) {
        changed = true;
        nextContent = fallbackContent;
      }
    } else if (nextContent == null) {
      changed = true;
      nextContent = fallbackContent;
    } else {
      // Defensive fallback for unexpected content shapes.
      changed = true;
      nextContent = fallbackContent;
    }

    if (nextContent === message.content) {
      sanitized.push(message);
      continue;
    }

    changed = true;
    sanitized.push(cloneSanitizedMessage(message, nextContent));
  }

  return changed ? sanitized : messages;
}

/**
 * Apply provider-specific formatted-message sanitization policy.
 * @param {unknown} provider
 * @param {unknown[]} messages
 * @returns {unknown[]}
 */
function sanitizeProviderFormattedMessages(provider, messages) {
  if (!Array.isArray(messages)) {
    return messages;
  }
  if (!providerNeedsStrictTextSanitizer(provider)) {
    return messages;
  }
  return sanitizeAnthropicFormattedMessages(messages);
}

module.exports = {
  coerceTextToString,
  normalizeTextContentParts,
  normalizeTextPartsInPayload,
  normalizeProviderKey,
  providerNeedsStrictTextSanitizer,
  sanitizeAnthropicFormattedMessages,
  sanitizeProviderFormattedMessages,
};
