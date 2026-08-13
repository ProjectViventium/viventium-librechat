'use strict';

/* === VIVENTIUM START ===
 * Feature: Versioned messaging delivery disposition.
 * Purpose: Validate and carry the model-owned audio decision without runtime intent inference.
 * === VIVENTIUM END === */
const { parseDeliveryControls } = require('./deliveryControls');
const {
  inspectProviderDeliveryDisposition,
  resolveEffectiveDeliveryDisposition,
  supportsMessagingDeliveryDisposition,
} = require('@librechat/api');

const CAPTURE_KEY = '_viventiumDeliveryDispositionCapture';
const isRecord = (value) => value != null && typeof value === 'object' && !Array.isArray(value);

function resetDeliveryDispositionCapture(req) {
  if (req && typeof req === 'object') delete req[CAPTURE_KEY];
}

function captureFinalModelDeliveryDisposition({ req, output, capabilityOwner }) {
  if (!req) return;
  if (Array.isArray(output?.tool_calls) && output.tool_calls.length > 0) return;
  const capability = req?.config?.endpoints?.agents?.providerCapabilities?.[capabilityOwner];
  if (req._viventiumTelegram !== true || req?.body?.telegramAudioRequested !== true) return;
  if (!supportsMessagingDeliveryDisposition(capability)) {
    if (req._viventiumDeliveryDispositionRequired === true) {
      req[CAPTURE_KEY] = { status: 'missing' };
    }
    return;
  }
  req._viventiumDeliveryDispositionRequired = true;
  req[CAPTURE_KEY] = inspectProviderDeliveryDisposition(output);
}

function getDeliveryDispositionCapture(req) {
  return req?.[CAPTURE_KEY]?.status ? req[CAPTURE_KEY] : { status: 'missing' };
}

function deliveryControlText(message) {
  if (typeof message?.text === 'string' && message.text) return message.text;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((part) => part?.type === 'text')
    .map((part) => {
      if (typeof part.text === 'string') return part.text;
      if (typeof part.text?.value === 'string') return part.text.value;
      if (typeof part.text?.text === 'string') return part.text.text;
      return '';
    })
    .join('');
}

function attachEffectiveDeliveryDisposition(req, message) {
  if (!isRecord(message) || message.isCreatedByUser === true) return message;
  const legacySkipVoice = parseDeliveryControls(deliveryControlText(message)).skipVoice;
  const disposition = resolveEffectiveDeliveryDisposition({
    audioEligible: req?._viventiumDeliveryDispositionRequired === true,
    legacySkipVoice,
    captured: getDeliveryDispositionCapture(req),
  });
  if (!disposition) return message;
  const metadata = isRecord(message.metadata) ? message.metadata : {};
  const viventium = isRecord(metadata.viventium) ? metadata.viventium : {};
  return {
    ...message,
    metadata: { ...metadata, viventium: { ...viventium, deliveryDisposition: disposition } },
  };
}

module.exports = {
  attachEffectiveDeliveryDisposition,
  captureFinalModelDeliveryDisposition,
  getDeliveryDispositionCapture,
  inspectProviderDeliveryDisposition,
  resetDeliveryDispositionCapture,
  resolveEffectiveDeliveryDisposition,
};
