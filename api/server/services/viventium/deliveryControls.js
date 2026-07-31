'use strict';

/* === VIVENTIUM START ===
 * Feature: Shared model-authored messaging delivery controls.
 * Purpose: Consume bounded structural controls without inferring user intent in runtime.
 * Added: 2026-07-22
 * === VIVENTIUM END === */

const DELIVERY_CONTROL_VERSION = '2026-07-22.1';
const SKIP_VOICE_TOKEN = '{SKIP_VOICE}';
const MESSAGE_BREAK_TOKEN = '{MSG_BREAK}';
const DEFAULT_MAX_MESSAGE_BREAKS = 2;
const CONTROL_LINE_RE = /^\s*\{\s*(SKIP_VOICE|MSG_BREAK)\s*\}\s*$/i;
const CONTROL_PREFIXES = [SKIP_VOICE_TOKEN, MESSAGE_BREAK_TOKEN];

function fenceMarker(line) {
  const match = String(line || '').match(/^\s*(```+|~~~+)/);
  return match ? match[1][0] : '';
}

function parseDeliveryControls(text, { maxMessageBreaks = DEFAULT_MAX_MESSAGE_BREAKS } = {}) {
  const value = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : '';
  const segments = [];
  let current = [];
  let fence = '';
  let skipVoice = false;
  let skipVoiceCount = 0;
  let messageBreakCount = 0;
  let mergedBreakCount = 0;
  const numericMax = Number(maxMessageBreaks);
  const safeMaxBreaks = Math.max(
    0,
    Number.isFinite(numericMax) ? Math.trunc(numericMax) : DEFAULT_MAX_MESSAGE_BREAKS,
  );

  for (const line of value.split('\n')) {
    const marker = fenceMarker(line);
    const protectedLine = Boolean(fence) || /^\s*>/.test(line);
    const control = protectedLine ? null : line.match(CONTROL_LINE_RE);

    if (control) {
      const name = control[1].toUpperCase();
      if (name === 'SKIP_VOICE') {
        skipVoice = true;
        skipVoiceCount += 1;
        continue;
      }

      const currentText = current.join('\n').trim();
      if (currentText && messageBreakCount < safeMaxBreaks) {
        segments.push(currentText);
        current = [];
        messageBreakCount += 1;
      } else {
        mergedBreakCount += 1;
        if (currentText) {
          current.push('');
        }
      }
      continue;
    }

    current.push(line);
    if (marker) {
      fence = fence === marker ? '' : fence || marker;
    }
  }

  const finalSegment = current.join('\n').trim();
  if (finalSegment) {
    segments.push(finalSegment);
  }

  return {
    contractVersion: DELIVERY_CONTROL_VERSION,
    cleanText: segments.join('\n\n'),
    segments,
    skipVoice,
    skipVoiceCount,
    messageBreakCount,
    mergedBreakCount,
  };
}

function stripIncompleteControlSuffix(text) {
  const value = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : '';
  const lines = value.split('\n');
  const candidate = String(lines.at(-1) || '').trim();
  if (!candidate || candidate.startsWith('>')) {
    return value;
  }

  let fence = '';
  for (const line of lines.slice(0, -1)) {
    const marker = fenceMarker(line);
    if (marker) {
      fence = fence === marker ? '' : fence || marker;
    }
  }
  if (fence) {
    return value;
  }

  const compact = candidate.replace(/\s+/g, '').toUpperCase();
  const incomplete = CONTROL_PREFIXES.some(
    (token) => compact.length >= 1 && compact.length < token.length && token.startsWith(compact),
  );
  return incomplete ? lines.slice(0, -1).join('\n').trimEnd() : value;
}

function stripDeliveryControlsForPreview(text) {
  return parseDeliveryControls(stripIncompleteControlSuffix(text)).cleanText;
}

module.exports = {
  DEFAULT_MAX_MESSAGE_BREAKS,
  DELIVERY_CONTROL_VERSION,
  MESSAGE_BREAK_TOKEN,
  SKIP_VOICE_TOKEN,
  parseDeliveryControls,
  stripDeliveryControlsForPreview,
  stripIncompleteControlSuffix,
};
/* === VIVENTIUM END === */
