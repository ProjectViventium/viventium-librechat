'use strict';

const crypto = require('crypto');

const STATES = new Set(['committed', 'partial_removed', 'failed']);
const SOURCE_KINDS = new Set(['assistant_message', 'schedule_result', 'callback']);
const MAX_IDENTIFIER_LENGTH = 160;
const MAX_PRESENTATION_REFS = 32;
const SHA256_HEX = /^[a-f0-9]{64}$/;

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

function parseCortexPresentation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ownerId = boundedString(value.ownerId, true);
  const messageId = boundedString(value.messageId, true);
  const parentMessageId = boundedString(value.parentMessageId, true);
  const claimToken = boundedString(value.claimToken, true);
  const presentationLeaseToken = boundedString(value.presentationLeaseToken, true);
  if (
    !ownerId ||
    !messageId ||
    !parentMessageId ||
    !claimToken ||
    !presentationLeaseToken ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !Array.isArray(value.deliveryIds) ||
    value.deliveryIds.length < 1 ||
    value.deliveryIds.length > MAX_PRESENTATION_REFS ||
    !Array.isArray(value.deliveryReceipts) ||
    value.deliveryReceipts.length !== value.deliveryIds.length
  ) {
    return null;
  }
  const deliveryIds = Array.from(
    new Set(value.deliveryIds.map((deliveryId) => boundedString(deliveryId, true))),
  ).sort();
  if (deliveryIds.length !== value.deliveryIds.length || deliveryIds.some((value) => !value)) {
    return null;
  }
  const deliveryReceipts = value.deliveryReceipts
    .map((receipt) => ({
      deliveryId: boundedString(receipt?.deliveryId, true),
      graphResultHash: String(receipt?.graphResultHash || '')
        .trim()
        .toLowerCase(),
    }))
    .sort((left, right) => String(left.deliveryId).localeCompare(String(right.deliveryId)));
  if (
    deliveryReceipts.some(
      (receipt, index) =>
        !receipt.deliveryId ||
        receipt.deliveryId !== deliveryIds[index] ||
        !SHA256_HEX.test(receipt.graphResultHash),
    )
  ) {
    return null;
  }
  return {
    ownerId,
    messageId,
    parentMessageId,
    revision: value.revision,
    generation: value.generation,
    deliveryIds,
    deliveryReceipts,
    claimToken,
    presentationLeaseToken,
  };
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
  let presentationRefs = [];
  if (body.presentation_refs !== undefined) {
    if (
      !Array.isArray(body.presentation_refs) ||
      body.presentation_refs.length > MAX_PRESENTATION_REFS
    ) {
      return { error: 'presentation_refs' };
    }
    presentationRefs = Array.from(
      new Set(body.presentation_refs.map((value) => boundedString(value, true))),
    );
    if (presentationRefs.some((value) => value === null)) {
      return { error: 'presentation_refs' };
    }
  }
  let sourceKind;
  if (body.source_kind !== undefined) {
    sourceKind = boundedString(body.source_kind, true);
    if (!sourceKind || !SOURCE_KINDS.has(sourceKind)) return { error: 'source_kind' };
  }
  let scheduleId;
  if (body.schedule_id !== undefined) {
    scheduleId = boundedString(body.schedule_id, true);
    if (!scheduleId) return { error: 'schedule_id' };
  }
  let scheduleRunId;
  if (body.schedule_run_id !== undefined) {
    scheduleRunId = boundedString(body.schedule_run_id, true);
    if (!scheduleRunId) return { error: 'schedule_run_id' };
  }
  if ((scheduleId || scheduleRunId) && sourceKind !== 'schedule_result') {
    return { error: 'source_kind' };
  }
  let cortexPresentation;
  if (body.cortex_presentation !== undefined) {
    cortexPresentation = parseCortexPresentation(body.cortex_presentation);
    if (!cortexPresentation) return { error: 'cortex_presentation' };
    if (body.state !== 'committed' || sourceKind === 'schedule_result') {
      return { error: 'cortex_presentation' };
    }
  }
  return {
    acknowledgement: {
      logical_turn_id: logicalTurnId,
      revision: body.revision,
      state: body.state,
      ...(presentationRef ? { presentation_ref: presentationRef } : {}),
      ...(presentationRefs.length ? { presentation_refs: presentationRefs } : {}),
      ...(sourceKind ? { source_kind: sourceKind } : {}),
      ...(scheduleId ? { schedule_id: scheduleId } : {}),
      ...(scheduleRunId ? { schedule_run_id: scheduleRunId } : {}),
    },
    ...(cortexPresentation ? { cortexPresentation } : {}),
  };
}

module.exports = {
  MAX_IDENTIFIER_LENGTH,
  MAX_PRESENTATION_REFS,
  adapterSecretConfigured,
  authenticateAdapterSecret,
  parseDeliveryAcknowledgement,
};
