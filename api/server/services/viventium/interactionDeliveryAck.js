'use strict';

const crypto = require('crypto');

const STATES = new Set(['committed', 'partial_removed', 'failed']);
const MAX_IDENTIFIER_LENGTH = 160;

function configuredAdapterSecrets() {
  return [
    ['telegram', process.env.VIVENTIUM_TELEGRAM_INTERACTION_ADAPTER_SECRET],
    ['voice', process.env.VIVENTIUM_VOICE_INTERACTION_ADAPTER_SECRET],
  ].filter(([, secret]) => typeof secret === 'string' && secret.length > 0);
}

function adapterSecretConfigured() {
  return configuredAdapterSecrets().length > 0;
}

function authenticateAdapterSecret(value) {
  if (typeof value !== 'string' || !value) {
    return null;
  }
  const presentedDigest = crypto.createHash('sha256').update(value).digest();
  const matches = configuredAdapterSecrets()
    .filter(([, expected]) => {
      const expectedDigest = crypto.createHash('sha256').update(expected).digest();
      return crypto.timingSafeEqual(expectedDigest, presentedDigest);
    })
    .map(([surface]) => surface);
  // Fail closed if operators accidentally configure the same credential for two adapters.
  return matches.length === 1 ? matches[0] : null;
}

function boundedString(value, required) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > MAX_IDENTIFIER_LENGTH) return null;
  return normalized;
}

function parseDeliveryAcknowledgement(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'body' };
  }
  const logicalTurnId = boundedString(body.logical_turn_id, true);
  if (!logicalTurnId) return { error: 'logical_turn_id' };
  if (!Number.isSafeInteger(body.revision) || body.revision < 1) {
    return { error: 'revision' };
  }
  if (typeof body.state !== 'string' || !STATES.has(body.state)) {
    return { error: 'state' };
  }
  let presentationRef;
  if (body.presentation_ref !== undefined) {
    presentationRef = boundedString(body.presentation_ref, false);
    if (presentationRef === null) return { error: 'presentation_ref' };
  }
  return {
    acknowledgement: {
      logical_turn_id: logicalTurnId,
      revision: body.revision,
      state: body.state,
      ...(presentationRef ? { presentation_ref: presentationRef } : {}),
    },
  };
}

module.exports = {
  MAX_IDENTIFIER_LENGTH,
  adapterSecretConfigured,
  authenticateAdapterSecret,
  parseDeliveryAcknowledgement,
};
