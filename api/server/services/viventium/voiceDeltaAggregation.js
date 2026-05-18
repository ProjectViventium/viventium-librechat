'use strict';

const { ContentTypes } = require('librechat-data-provider');

/* === VIVENTIUM START ===
 * Feature: Voice streamed-delta persistence parity.
 *
 * Why:
 * - The upstream Agents content aggregator requires an ON_RUN_STEP record before it can attach
 *   ON_MESSAGE_DELTA text to `contentParts`.
 * - Voice calls can still stream audible/text deltas to LiveKit while that upstream aggregation
 *   path misses the delta, leaving Mongo with only later internal cortex parts.
 * - This helper repairs only that proven miss: if a voice message delta was emitted but the
 *   canonical content text did not advance, append the same text to the canonical text part.
 * === VIVENTIUM END === */

function collectTextParts(content) {
  const out = [];
  if (typeof content === 'string') {
    if (content) {
      out.push(content);
    }
    return out;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      out.push(...collectTextParts(item));
    }
    return out;
  }
  if (!content || typeof content !== 'object') {
    return out;
  }
  if (content.type && content.type !== ContentTypes.TEXT) {
    return out;
  }
  if (typeof content.text === 'string' && content.text) {
    out.push(content.text);
    return out;
  }
  if (content.text && typeof content.text === 'object') {
    if (typeof content.text.value === 'string' && content.text.value) {
      out.push(content.text.value);
      return out;
    }
    if (typeof content.text.text === 'string' && content.text.text) {
      out.push(content.text.text);
      return out;
    }
  }
  if (typeof content.value === 'string' && content.value) {
    out.push(content.value);
  }
  return out;
}

function extractVisibleTextFromContentParts(contentParts) {
  if (!Array.isArray(contentParts)) {
    return '';
  }
  return contentParts
    .filter((part) => part && part.type === ContentTypes.TEXT)
    .map((part) => {
      if (typeof part.text === 'string') {
        return part.text;
      }
      if (part.text && typeof part.text === 'object') {
        if (typeof part.text.value === 'string') {
          return part.text.value;
        }
        if (typeof part.text.text === 'string') {
          return part.text.text;
        }
      }
      if (typeof part[ContentTypes.TEXT] === 'string') {
        return part[ContentTypes.TEXT];
      }
      return '';
    })
    .join('');
}

function appendTextToContentParts(contentParts, text) {
  if (!Array.isArray(contentParts) || typeof text !== 'string' || !text) {
    return false;
  }
  for (let index = contentParts.length - 1; index >= 0; index -= 1) {
    const part = contentParts[index];
    if (!part || part.type !== ContentTypes.TEXT) {
      continue;
    }
    const current = typeof part.text === 'string' ? part.text : '';
    contentParts[index] = {
      ...part,
      text: `${current}${text}`,
    };
    return true;
  }
  contentParts.push({
    type: ContentTypes.TEXT,
    text,
  });
  return true;
}

function repairMissedVoiceMessageDelta({ contentParts, event, data, beforeText, afterText }) {
  if (event !== 'on_message_delta') {
    return false;
  }
  const deltaText = collectTextParts(data?.delta?.content).join('');
  if (!deltaText) {
    return false;
  }
  if (typeof beforeText === 'string' && typeof afterText === 'string' && afterText !== beforeText) {
    return false;
  }
  return appendTextToContentParts(contentParts, deltaText);
}

module.exports = {
  appendTextToContentParts,
  collectTextParts,
  extractVisibleTextFromContentParts,
  repairMissedVoiceMessageDelta,
};
