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

function isNoResponseMarkerProgression(previous, incoming) {
  const marker = '{NTA}';
  return (
    typeof previous === 'string' &&
    typeof incoming === 'string' &&
    previous.length > 0 &&
    incoming.length > previous.length &&
    marker.startsWith(previous) &&
    marker.startsWith(incoming)
  );
}

function shouldTreatAsCumulativeSnapshot(previous, incoming) {
  if (
    typeof previous !== 'string' ||
    typeof incoming !== 'string' ||
    !previous ||
    !incoming ||
    incoming === previous ||
    !incoming.startsWith(previous)
  ) {
    return false;
  }

  if (isNoResponseMarkerProgression(previous, incoming)) {
    return true;
  }

  const suffix = incoming.slice(previous.length);
  if (/^[\s.,!?;:)"'\]}]/.test(suffix)) {
    return true;
  }

  // Mid-word cumulative snapshots look like `Hel` -> `Hello`. The one prefix-superset
  // shape we intentionally preserve as incremental is exact doubling, e.g. `ha` + `haha`.
  return suffix !== previous;
}

function cloneTextPartWithText(part, text) {
  return {
    ...part,
    text,
  };
}

function createMessageDeltaBoundaryNormalizer({ mode = 'incremental' } = {}) {
  const textByKey = new Map();
  const normalizedMode = ['auto', 'snapshot'].includes(mode) ? mode : 'incremental';

  const normalizeText = (key, text) => {
    if (normalizedMode === 'incremental' || typeof text !== 'string' || !text) {
      return text;
    }

    const previous = textByKey.get(key) || '';
    if (!previous) {
      textByKey.set(key, text);
      return text;
    }

    if (text === previous) {
      return '';
    }

    const isSnapshot =
      normalizedMode === 'snapshot'
        ? text.startsWith(previous)
        : shouldTreatAsCumulativeSnapshot(previous, text);

    if (isSnapshot) {
      textByKey.set(key, text);
      return text.slice(previous.length);
    }

    textByKey.set(key, `${previous}${text}`);
    return text;
  };

  return ({ event, data }) => {
    if (event !== 'on_message_delta' || !data?.delta?.content) {
      return { event, data, normalized: false };
    }

    const content = data.delta.content;
    const baseKey = data.id || data.runId || 'message';
    let normalized = false;

    const normalizePart = (part, index) => {
      if (!part || typeof part !== 'object' || typeof part.text !== 'string') {
        return part;
      }
      const key = `${baseKey}:${index}`;
      const nextText = normalizeText(key, part.text);
      if (nextText !== part.text) {
        normalized = true;
        return cloneTextPartWithText(part, nextText);
      }
      return part;
    };

    const nextContent = Array.isArray(content)
      ? content.map((part, index) => normalizePart(part, index))
      : normalizePart(content, 0);

    if (!normalized) {
      return { event, data, normalized: false };
    }

    return {
      event,
      data: {
        ...data,
        delta: {
          ...data.delta,
          content: nextContent,
        },
      },
      normalized: true,
    };
  };
}

function repairMissedVisibleMessageDelta({ contentParts, event, data, beforeText, afterText }) {
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

function repairMissedVoiceMessageDelta(params) {
  return repairMissedVisibleMessageDelta(params);
}

module.exports = {
  appendTextToContentParts,
  collectTextParts,
  createMessageDeltaBoundaryNormalizer,
  extractVisibleTextFromContentParts,
  repairMissedVisibleMessageDelta,
  repairMissedVoiceMessageDelta,
};
