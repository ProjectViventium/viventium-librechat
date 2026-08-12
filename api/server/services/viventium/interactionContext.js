'use strict';

/* === VIVENTIUM START ===
 * Feature: Trusted interaction provenance.
 * Purpose: Keep actor/origin/surface and supersession capabilities server-authored so request
 * payloads cannot opt into privileged scheduler or noninteractive behavior.
 * === VIVENTIUM END === */

const ACTORS = new Set(['external_user', 'system', 'worker']);
const ORIGINS = new Set(['interactive', 'scheduler', 'callback']);
const SURFACES = new Set(['web', 'telegram', 'voice', 'workbench']);
const SEGMENT_STABILITY = new Set(['immediate', 'provisional']);
const SUPERSEDE_SCOPES = new Set(['response_and_authoring', 'response_only']);
const COMMIT_AUTHORITIES = new Set(['server', 'external_adapter']);
const TRUSTED_SLOT = '_viventiumInteractionContext';
const trustedContexts = new WeakMap();
const trustedAdapterCapabilities = new WeakMap();
const trustedDeliveryPolicies = new WeakMap();
const { isNoResponseOnly } = require('./noResponseTag');

function boundedIdentifier(value, maxLength = 160) {
  return String(value || '')
    .trim()
    .slice(0, maxLength);
}

function enumValue(value, allowed, fallback) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function normalizeInteractionContext(context = {}) {
  const logicalTurnId = boundedIdentifier(context.logical_turn_id);
  return Object.freeze({
    actor_kind: enumValue(context.actor_kind, ACTORS, 'external_user'),
    origin: enumValue(context.origin, ORIGINS, 'interactive'),
    surface: enumValue(context.surface, SURFACES, 'web'),
    conversation_id: boundedIdentifier(context.conversation_id),
    ...(logicalTurnId ? { logical_turn_id: logicalTurnId } : {}),
    revision: Math.max(1, Math.floor(Number(context.revision) || 1)),
    source_event_id: boundedIdentifier(context.source_event_id),
  });
}

function normalizeAdapterCapabilities(capabilities = {}) {
  return Object.freeze({
    segment_stability: enumValue(capabilities.segment_stability, SEGMENT_STABILITY, 'immediate'),
    supersede_scope: enumValue(
      capabilities.supersede_scope,
      SUPERSEDE_SCOPES,
      'response_and_authoring',
    ),
  });
}

function normalizeDeliveryPolicy(policy = {}) {
  return Object.freeze({
    commit_authority: enumValue(policy.commit_authority, COMMIT_AUTHORITIES, 'server'),
  });
}

function createWebInteractionContext({ conversation_id, source_event_id } = {}) {
  return normalizeInteractionContext({
    actor_kind: 'external_user',
    origin: 'interactive',
    surface: 'web',
    conversation_id,
    source_event_id,
  });
}

function createTelegramInteractionContext({ conversation_id, source_event_id } = {}) {
  return normalizeInteractionContext({
    actor_kind: 'external_user',
    origin: 'interactive',
    surface: 'telegram',
    conversation_id,
    source_event_id,
  });
}

function createVoiceInteractionContext({ conversation_id, source_event_id } = {}) {
  return normalizeInteractionContext({
    actor_kind: 'external_user',
    origin: 'interactive',
    surface: 'voice',
    conversation_id,
    source_event_id,
  });
}

function createSchedulerInteractionContext({ conversation_id, source_event_id } = {}) {
  return normalizeInteractionContext({
    actor_kind: 'system',
    origin: 'scheduler',
    surface: 'workbench',
    conversation_id,
    source_event_id,
  });
}

function setTrustedInteractionContext(
  req,
  context,
  adapterCapabilities = context,
  deliveryPolicy = { commit_authority: 'server' },
) {
  if (!req || typeof req !== 'object') {
    return normalizeInteractionContext(context);
  }
  if (trustedContexts.has(req)) {
    return trustedContexts.get(req);
  }
  const normalized = normalizeInteractionContext(context);
  trustedContexts.set(req, normalized);
  trustedAdapterCapabilities.set(req, normalizeAdapterCapabilities(adapterCapabilities));
  trustedDeliveryPolicies.set(req, normalizeDeliveryPolicy(deliveryPolicy));
  Object.defineProperty(req, TRUSTED_SLOT, {
    configurable: false,
    enumerable: false,
    get: () => trustedContexts.get(req),
  });
  return normalized;
}

function getTrustedAdapterCapabilities(req) {
  return (req && trustedAdapterCapabilities.get(req)) || null;
}

function getTrustedDeliveryPolicy(req) {
  return (req && trustedDeliveryPolicies.get(req)) || null;
}

function getTrustedInteractionContext(req) {
  return (req && trustedContexts.get(req)) || null;
}

function bindCanonicalInteractionConversation(req, conversationId) {
  const current = getTrustedInteractionContext(req);
  const canonicalConversationId = boundedIdentifier(conversationId);
  if (
    !current ||
    !canonicalConversationId ||
    current.logical_turn_id ||
    current.conversation_id === canonicalConversationId
  ) {
    return current;
  }
  const normalized = normalizeInteractionContext({
    ...current,
    conversation_id: canonicalConversationId,
  });
  trustedContexts.set(req, normalized);
  return normalized;
}

function bindLogicalTurnContext(req, claimedContext) {
  const current = getTrustedInteractionContext(req);
  const claimed = normalizeInteractionContext(claimedContext);
  if (!current || !claimed.logical_turn_id) {
    return current;
  }
  const immutableKeys = ['actor_kind', 'origin', 'surface', 'conversation_id', 'source_event_id'];
  if (immutableKeys.some((key) => current[key] !== claimed[key])) {
    return current;
  }
  trustedContexts.set(req, claimed);
  return claimed;
}

function isInternalOrigin(req) {
  const context = getTrustedInteractionContext(req);
  return context?.actor_kind === 'system' && context?.origin === 'scheduler';
}

function shouldSkipAutomaticMemoryWriter(req) {
  return isInternalOrigin(req);
}

function shouldSkipEmotionalReaction(req) {
  return isInternalOrigin(req);
}

function interactionContextMetadata(req) {
  const context = getTrustedInteractionContext(req);
  if (!context) return null;
  return {
    actor_kind: context.actor_kind,
    origin: context.origin,
    surface: context.surface,
    conversation_id: context.conversation_id,
    ...(context.logical_turn_id ? { logical_turn_id: context.logical_turn_id } : {}),
    revision: context.revision,
    source_event_id: context.source_event_id,
  };
}

function attachLogicalTurnMetadata(payload, context) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !context?.logical_turn_id ||
    !Number.isSafeInteger(context.revision)
  ) {
    return payload;
  }
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  const viventium =
    metadata.viventium && typeof metadata.viventium === 'object' ? metadata.viventium : {};
  return {
    ...payload,
    logical_turn_id: context.logical_turn_id,
    revision: context.revision,
    metadata: {
      ...metadata,
      viventium: {
        ...viventium,
        interactionContext: context,
      },
    },
  };
}

function attachInteractionContextMetadata(req, message) {
  const interactionContext = interactionContextMetadata(req);
  if (!interactionContext || !message || typeof message !== 'object') {
    return message;
  }
  const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  const viventium =
    metadata.viventium && typeof metadata.viventium === 'object' ? metadata.viventium : {};
  const textParts = Array.isArray(message.content)
    ? message.content
        .filter((part) => part?.type === 'text')
        .map((part) => (typeof part.text === 'string' ? part.text : part.text?.value || ''))
        .join('')
    : '';
  const isSchedulerInternal =
    isInternalOrigin(req) &&
    (message.isCreatedByUser === true || isNoResponseOnly(message.text || textParts));
  return {
    ...message,
    metadata: {
      ...metadata,
      viventium: {
        ...viventium,
        ...(isInternalOrigin(req) ? { memoryEligible: false } : {}),
        ...(isSchedulerInternal ? { visibility: 'internal' } : {}),
        interactionContext,
        adapterCapabilities: getTrustedAdapterCapabilities(req),
        deliveryPolicy: getTrustedDeliveryPolicy(req),
      },
    },
  };
}

function isTrustedInternalMessage(message) {
  return message?.metadata?.viventium?.visibility === 'internal';
}

module.exports = {
  attachInteractionContextMetadata,
  attachLogicalTurnMetadata,
  bindCanonicalInteractionConversation,
  bindLogicalTurnContext,
  createSchedulerInteractionContext,
  createTelegramInteractionContext,
  createVoiceInteractionContext,
  createWebInteractionContext,
  getTrustedInteractionContext,
  getTrustedAdapterCapabilities,
  getTrustedDeliveryPolicy,
  interactionContextMetadata,
  isTrustedInternalMessage,
  isInternalOrigin,
  normalizeInteractionContext,
  normalizeAdapterCapabilities,
  normalizeDeliveryPolicy,
  setTrustedInteractionContext,
  shouldSkipAutomaticMemoryWriter,
  shouldSkipEmotionalReaction,
};
