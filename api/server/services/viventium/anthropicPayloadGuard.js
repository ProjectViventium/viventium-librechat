'use strict';

/* === VIVENTIUM START ===
 * File: api/server/services/viventium/anthropicPayloadGuard.js
 *
 * Purpose:
 * - Guard Anthropic runs against request-byte overflow (`413 request_too_large`) with
 *   byte-aware preflight compaction and deterministic size checks for inline PDF blocks.
 *
 * Why:
 * - Token-only context checks do not account for raw base64 document bytes.
 * - Anthropic can reject oversized requests even when token budget appears safe.
 * === VIVENTIUM END === */

const MB = 1024 * 1024;

const DEFAULT_MAX_REQUEST_BYTES = 26 * MB;
const DEFAULT_MAX_SINGLE_DOCUMENT_BYTES = 18 * MB;
const DEFAULT_MAX_TOTAL_DOCUMENT_BYTES = 22 * MB;
const DEFAULT_MAX_TOOL_MESSAGE_CHARS = 160_000;
const DEFAULT_MAX_TEXT_PART_CHARS = 200_000;
const TRUNCATION_SUFFIX = '\n\n[Truncated to fit Anthropic request size limits]';
const DOC_PLACEHOLDER =
  '[Attached document omitted from this turn because the Anthropic request exceeded size limits. Use file_search or ask for a focused excerpt.]';

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function getAnthropicPayloadGuardConfig() {
  return {
    maxRequestBytes: parsePositiveInt(
      process.env.VIVENTIUM_ANTHROPIC_MAX_REQUEST_BYTES,
      DEFAULT_MAX_REQUEST_BYTES,
    ),
    maxSingleDocumentBytes: parsePositiveInt(
      process.env.VIVENTIUM_ANTHROPIC_MAX_SINGLE_DOCUMENT_BYTES,
      DEFAULT_MAX_SINGLE_DOCUMENT_BYTES,
    ),
    maxTotalDocumentBytes: parsePositiveInt(
      process.env.VIVENTIUM_ANTHROPIC_MAX_TOTAL_DOCUMENT_BYTES,
      DEFAULT_MAX_TOTAL_DOCUMENT_BYTES,
    ),
    maxToolMessageChars: parsePositiveInt(
      process.env.VIVENTIUM_ANTHROPIC_MAX_TOOL_MESSAGE_CHARS,
      DEFAULT_MAX_TOOL_MESSAGE_CHARS,
    ),
    maxTextPartChars: parsePositiveInt(
      process.env.VIVENTIUM_ANTHROPIC_MAX_TEXT_PART_CHARS,
      DEFAULT_MAX_TEXT_PART_CHARS,
    ),
  };
}

function isAnthropicProvider(provider) {
  return typeof provider === 'string' && provider.trim().toLowerCase() === 'anthropic';
}

function estimateBase64DecodedBytes(base64Data) {
  if (typeof base64Data !== 'string' || base64Data.length === 0) {
    return 0;
  }
  const sanitized = base64Data.replace(/\s/g, '');
  if (sanitized.length === 0) {
    return 0;
  }
  const paddingMatch = sanitized.match(/=+$/);
  const paddingLength = paddingMatch ? paddingMatch[0].length : 0;
  return Math.max(0, Math.floor((sanitized.length * 3) / 4) - paddingLength);
}

function measureSerializedBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch (error) {
    return 0;
  }
}

function getMessageRole(message) {
  if (!message || typeof message !== 'object') {
    return '';
  }

  const rawRole =
    (typeof message.role === 'string' && message.role) ||
    (typeof message._getType === 'function' && message._getType()) ||
    (typeof message.getType === 'function' && message.getType()) ||
    '';

  const role = rawRole.toLowerCase();
  if (role === 'human' || role === 'user') {
    return 'user';
  }
  if (role === 'ai' || role === 'assistant') {
    return 'assistant';
  }
  if (role === 'tool') {
    return 'tool';
  }
  if (role === 'system') {
    return 'system';
  }
  return role;
}

function truncateText(text, maxChars) {
  if (typeof text !== 'string' || maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  const keepChars = Math.max(0, maxChars - TRUNCATION_SUFFIX.length);
  const slice = text.slice(0, keepChars);
  return `${slice}${TRUNCATION_SUFFIX}`;
}

function buildDocumentPlaceholder(part) {
  const context = typeof part?.context === 'string' ? part.context.trim() : '';
  if (!context) {
    return DOC_PLACEHOLDER;
  }
  return `${DOC_PLACEHOLDER} (${context})`;
}

function findLatestUserMessageIndex(messages) {
  let latestUserIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    if (getMessageRole(messages[i]) === 'user') {
      latestUserIndex = i;
    }
  }
  return latestUserIndex;
}

function collectDocumentPartRefs(messages, latestUserIndex) {
  /** @type {Array<{messageIndex: number; partIndex: number; latestUserMessage: boolean}>} */
  const refs = [];

  for (let i = 0; i < messages.length; i++) {
    const content = messages[i]?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (let j = 0; j < content.length; j++) {
      const part = content[j];
      if (
        part &&
        typeof part === 'object' &&
        part.type === 'document' &&
        typeof part?.source?.data === 'string' &&
        part.source.data.length > 0
      ) {
        refs.push({
          messageIndex: i,
          partIndex: j,
          latestUserMessage: i === latestUserIndex,
        });
      }
    }
  }

  refs.sort((a, b) => {
    const latestDelta = Number(a.latestUserMessage) - Number(b.latestUserMessage);
    if (latestDelta !== 0) {
      return latestDelta;
    }
    if (a.messageIndex !== b.messageIndex) {
      return a.messageIndex - b.messageIndex;
    }
    return a.partIndex - b.partIndex;
  });

  return refs;
}

function truncateToolMessages(messages, maxChars) {
  let changed = 0;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (getMessageRole(message) !== 'tool') {
      continue;
    }

    if (typeof message.content === 'string') {
      const truncated = truncateText(message.content, maxChars);
      if (truncated !== message.content) {
        message.content = truncated;
        changed++;
      }
      continue;
    }

    if (!Array.isArray(message.content)) {
      continue;
    }

    for (let j = 0; j < message.content.length; j++) {
      const part = message.content[j];
      if (!part || typeof part !== 'object') {
        continue;
      }
      const text = typeof part.text === 'string' ? part.text : null;
      if (!text) {
        continue;
      }
      const truncated = truncateText(text, maxChars);
      if (truncated === text) {
        continue;
      }
      message.content[j] = {
        ...part,
        type: 'text',
        text: truncated,
      };
      changed++;
    }
  }

  return changed;
}

function truncateOldTextMessages(messages, latestUserIndex, maxChars) {
  let changed = 0;

  for (let i = 0; i < messages.length; i++) {
    if (i === latestUserIndex) {
      continue;
    }

    const message = messages[i];
    if (!message || typeof message !== 'object') {
      continue;
    }

    if (typeof message.content === 'string') {
      const truncated = truncateText(message.content, maxChars);
      if (truncated !== message.content) {
        message.content = truncated;
        changed++;
      }
      continue;
    }

    if (!Array.isArray(message.content)) {
      continue;
    }

    for (let j = 0; j < message.content.length; j++) {
      const part = message.content[j];
      if (!part || typeof part !== 'object') {
        continue;
      }
      const text = typeof part.text === 'string' ? part.text : null;
      if (!text) {
        continue;
      }
      const truncated = truncateText(text, maxChars);
      if (truncated === text) {
        continue;
      }
      message.content[j] = {
        ...part,
        type: 'text',
        text: truncated,
      };
      changed++;
    }
  }

  return changed;
}

function compactAnthropicMessagesForSize(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      changed: false,
      bytesBefore: 0,
      bytesAfter: 0,
      docPartsCompacted: 0,
      toolMessagesTruncated: 0,
      textPartsTruncated: 0,
    };
  }

  const config = getAnthropicPayloadGuardConfig();
  const aggressive = options.aggressive === true;
  const maxRequestBytes = parsePositiveInt(options.maxRequestBytes, config.maxRequestBytes);
  const maxToolMessageChars = parsePositiveInt(
    options.maxToolMessageChars,
    aggressive ? Math.floor(config.maxToolMessageChars * 0.5) : config.maxToolMessageChars,
  );
  const maxTextPartChars = parsePositiveInt(
    options.maxTextPartChars,
    aggressive ? Math.floor(config.maxTextPartChars * 0.5) : config.maxTextPartChars,
  );

  const bytesBefore = measureSerializedBytes(messages);
  let bytesAfter = bytesBefore;
  let docPartsCompacted = 0;
  let toolMessagesTruncated = 0;
  let textPartsTruncated = 0;

  if (bytesAfter <= maxRequestBytes) {
    return {
      changed: false,
      bytesBefore,
      bytesAfter,
      docPartsCompacted,
      toolMessagesTruncated,
      textPartsTruncated,
    };
  }

  const latestUserIndex = findLatestUserMessageIndex(messages);
  const docRefs = collectDocumentPartRefs(messages, latestUserIndex);

  for (const ref of docRefs) {
    const content = messages[ref.messageIndex]?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    const part = content[ref.partIndex];
    if (!part || typeof part !== 'object') {
      continue;
    }
    content[ref.partIndex] = {
      type: 'text',
      text: buildDocumentPlaceholder(part),
    };
    docPartsCompacted++;
    bytesAfter = measureSerializedBytes(messages);
    if (bytesAfter <= maxRequestBytes) {
      break;
    }
  }

  if (bytesAfter > maxRequestBytes) {
    toolMessagesTruncated = truncateToolMessages(messages, maxToolMessageChars);
    if (toolMessagesTruncated > 0) {
      bytesAfter = measureSerializedBytes(messages);
    }
  }

  if (bytesAfter > maxRequestBytes) {
    textPartsTruncated = truncateOldTextMessages(messages, latestUserIndex, maxTextPartChars);
    if (textPartsTruncated > 0) {
      bytesAfter = measureSerializedBytes(messages);
    }
  }

  return {
    changed: docPartsCompacted > 0 || toolMessagesTruncated > 0 || textPartsTruncated > 0,
    bytesBefore,
    bytesAfter,
    docPartsCompacted,
    toolMessagesTruncated,
    textPartsTruncated,
  };
}

function enforceAnthropicInlineDocumentLimits(documents, options = {}) {
  if (!Array.isArray(documents) || documents.length === 0) {
    return { valid: true, totalDocumentBytes: 0, documentCount: 0 };
  }

  const config = getAnthropicPayloadGuardConfig();
  const maxSingleDocumentBytes = parsePositiveInt(
    options.maxSingleDocumentBytes,
    config.maxSingleDocumentBytes,
  );
  const maxTotalDocumentBytes = parsePositiveInt(
    options.maxTotalDocumentBytes,
    config.maxTotalDocumentBytes,
  );

  let totalDocumentBytes = 0;
  let documentCount = 0;

  for (const part of documents) {
    if (part?.type !== 'document') {
      continue;
    }
    const data = part?.source?.data;
    const decodedBytes = estimateBase64DecodedBytes(data);
    if (decodedBytes <= 0) {
      continue;
    }
    documentCount++;
    totalDocumentBytes += decodedBytes;
    if (decodedBytes > maxSingleDocumentBytes) {
      return {
        valid: false,
        reason: 'single_document_limit',
        message:
          `A PDF exceeds Anthropic inline size limits (${Math.round(decodedBytes / MB)}MB > ` +
          `${Math.round(maxSingleDocumentBytes / MB)}MB).`,
        totalDocumentBytes,
        documentCount,
        maxSingleDocumentBytes,
        maxTotalDocumentBytes,
      };
    }
    if (totalDocumentBytes > maxTotalDocumentBytes) {
      return {
        valid: false,
        reason: 'total_document_limit',
        message:
          `Combined PDF size exceeds Anthropic inline size limits (${Math.round(totalDocumentBytes / MB)}MB > ` +
          `${Math.round(maxTotalDocumentBytes / MB)}MB).`,
        totalDocumentBytes,
        documentCount,
        maxSingleDocumentBytes,
        maxTotalDocumentBytes,
      };
    }
  }

  return {
    valid: true,
    totalDocumentBytes,
    documentCount,
    maxSingleDocumentBytes,
    maxTotalDocumentBytes,
  };
}

function getErrorMessageText(error) {
  if (!error) {
    return '';
  }
  if (typeof error === 'string') {
    return error;
  }
  const parts = [
    error.message,
    error.error?.message,
    error.response?.data?.error?.message,
    error.response?.data?.message,
  ].filter((value) => typeof value === 'string' && value.length > 0);
  return parts.join(' | ');
}

function isAnthropicRequestTooLargeError(error) {
  const status = Number(error?.status ?? error?.response?.status);
  if (status === 413) {
    const message = getErrorMessageText(error).toLowerCase();
    if (message.includes('tpm') || message.includes('tokens per minute')) {
      return false;
    }
    return true;
  }

  const message = getErrorMessageText(error).toLowerCase();
  if (!message) {
    return false;
  }
  if (message.includes('tpm') || message.includes('tokens per minute')) {
    return false;
  }

  return (
    message.includes('request_too_large') ||
    message.includes('request exceeds the maximum size') ||
    message.includes('request size exceeds') ||
    message.includes('context overflow') ||
    (message.includes('413') && message.includes('too large'))
  );
}

module.exports = {
  getAnthropicPayloadGuardConfig,
  isAnthropicProvider,
  estimateBase64DecodedBytes,
  measureSerializedBytes,
  compactAnthropicMessagesForSize,
  enforceAnthropicInlineDocumentLimits,
  isAnthropicRequestTooLargeError,
};
