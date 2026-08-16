'use strict';

const crypto = require('crypto');

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
const SOURCE_SEGMENT_MAX_BYTES = 32 * 1024;
const SOURCE_SEGMENTS_MAX_BYTES = 64 * 1024;
const SOURCE_SEGMENTS_MAX_COUNT = 32;
const SOURCE_FILES_MAX_PER_SEGMENT = 32;

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

function clipUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1])) low -= 1;
  return { text: value.slice(0, low), truncated: true };
}

function normalizeInteractionSourceFiles(candidates = []) {
  const result = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (result.length >= SOURCE_FILES_MAX_PER_SEGMENT) break;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const fileId = boundedIdentifier(candidate.file_id || candidate.temp_file_id, 256);
    if (!fileId || seen.has(fileId)) continue;
    seen.add(fileId);
    const mediaGroupIndex = Number(
      candidate.media_group_index ?? candidate.viventium_media_group_index,
    );
    result.push(
      Object.freeze({
        file_id: fileId,
        ...(boundedIdentifier(candidate.filename, 512)
          ? { filename: boundedIdentifier(candidate.filename, 512) }
          : {}),
        ...(boundedIdentifier(candidate.type, 160)
          ? { type: boundedIdentifier(candidate.type, 160) }
          : {}),
        ...(Number.isFinite(Number(candidate.bytes ?? candidate.size))
          ? { bytes: Math.max(0, Number(candidate.bytes ?? candidate.size)) }
          : {}),
        ...(Number.isInteger(mediaGroupIndex) && mediaGroupIndex >= 0
          ? { media_group_index: mediaGroupIndex }
          : {}),
      }),
    );
  }
  return Object.freeze(result);
}

function normalizeInteractionSourceSegments(candidates = [], priorOverflowCount = 0) {
  const result = [];
  const seen = new Set();
  let totalBytes = 0;
  let overflowCount = Math.max(0, Math.floor(Number(priorOverflowCount) || 0));
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const sourceEventId = boundedIdentifier(candidate?.source_event_id);
    const sourceIndex = Math.max(0, Math.floor(Number(candidate?.source_index) || 0));
    const identity = `${sourceEventId}\u0000${sourceIndex}`;
    const sourceFiles = normalizeInteractionSourceFiles(candidate?.source_files);
    if (!sourceEventId || seen.has(identity) || typeof candidate?.text !== 'string') {
      continue;
    }
    const clipped = clipUtf8(
      candidate.text,
      SOURCE_SEGMENT_MAX_BYTES,
    );
    if (!clipped.text.length && sourceFiles.length === 0) continue;
    const suppliedDigest = boundedIdentifier(candidate.original_sha256, 64).toLowerCase();
    const truncated = candidate.truncated === true || clipped.truncated;
    result.push(
      Object.freeze({
        ordinal: 0,
        source_event_id: sourceEventId,
        source_index: sourceIndex,
        text: clipped.text,
        ...(sourceFiles.length ? { source_files: sourceFiles } : {}),
        ...(truncated
          ? {
              truncated: true,
              original_sha256: /^[a-f0-9]{64}$/.test(suppliedDigest)
                ? suppliedDigest
                : crypto.createHash('sha256').update(candidate.text, 'utf8').digest('hex'),
            }
          : {}),
      }),
    );
    seen.add(identity);
    totalBytes += Buffer.byteLength(clipped.text, 'utf8');
    while (
      result.length > SOURCE_SEGMENTS_MAX_COUNT ||
      totalBytes > SOURCE_SEGMENTS_MAX_BYTES
    ) {
      const evicted = result.shift();
      if (!evicted) break;
      totalBytes -= Buffer.byteLength(evicted.text, 'utf8');
      overflowCount += 1;
    }
  }
  return Object.freeze({
    segments: Object.freeze(
      result.map((segment, ordinal) => Object.freeze({ ...segment, ordinal })),
    ),
    overflowCount,
  });
}

function normalizeInteractionContext(context = {}) {
  const logicalTurnId = boundedIdentifier(context.logical_turn_id);
  const normalizedSourceSegments = normalizeInteractionSourceSegments(
    context.source_segments,
    context.source_segments_overflow_count,
  );
  const sourceSegments = normalizedSourceSegments.segments;
  return Object.freeze({
    actor_kind: enumValue(context.actor_kind, ACTORS, 'external_user'),
    origin: enumValue(context.origin, ORIGINS, 'interactive'),
    surface: enumValue(context.surface, SURFACES, 'web'),
    conversation_id: boundedIdentifier(context.conversation_id),
    ...(logicalTurnId ? { logical_turn_id: logicalTurnId } : {}),
    revision: Math.max(1, Math.floor(Number(context.revision) || 1)),
    source_event_id: boundedIdentifier(context.source_event_id),
    ...(sourceSegments.length ? { source_segments: sourceSegments } : {}),
    ...(normalizedSourceSegments.overflowCount > 0
      ? { source_segments_overflow_count: normalizedSourceSegments.overflowCount }
      : {}),
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

/** Attach exact request text to trusted context before the logical-turn claim. */
function bindInteractionSourceSegments(req, text, sourceFiles = []) {
  const current = getTrustedInteractionContext(req);
  if (!current || current.logical_turn_id) return current;
  const values = Array.isArray(text)
    ? text
    : typeof text === 'string'
      ? [text]
      : Array.isArray(sourceFiles) && sourceFiles.length
        ? ['']
        : [];
  const incoming = values.map((value, sourceIndex) => ({
    source_event_id: current.source_event_id,
    source_index: sourceIndex,
    text: value,
    ...(sourceIndex === 0 && Array.isArray(sourceFiles) && sourceFiles.length
      ? { source_files: sourceFiles }
      : {}),
  }));
  const normalized = normalizeInteractionContext({
    ...current,
    source_segments: [...(current.source_segments || []), ...incoming],
  });
  trustedContexts.set(req, normalized);
  return normalized;
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
  const immutableKeys = [
    'actor_kind',
    'origin',
    'surface',
    'conversation_id',
    'source_event_id',
  ];
  if (immutableKeys.some((key) => current[key] !== claimed[key])) {
    return current;
  }
  const claimedSegments = Array.isArray(claimed.source_segments) ? claimed.source_segments : [];
  const preservesCurrentSegments = (current.source_segments || []).every((segment) =>
    claimedSegments.some(
      (candidate) =>
        candidate.source_event_id === segment.source_event_id &&
        candidate.source_index === segment.source_index &&
        candidate.text === segment.text &&
        candidate.truncated === segment.truncated &&
        candidate.original_sha256 === segment.original_sha256,
    ),
  );
  if (!preservesCurrentSegments) return current;
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
        interactionContext: {
          actor_kind: context.actor_kind,
          origin: context.origin,
          surface: context.surface,
          conversation_id: context.conversation_id,
          logical_turn_id: context.logical_turn_id,
          revision: context.revision,
          source_event_id: context.source_event_id,
        },
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
  bindInteractionSourceSegments,
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
  normalizeInteractionSourceSegments,
  normalizeAdapterCapabilities,
  normalizeDeliveryPolicy,
  setTrustedInteractionContext,
  shouldSkipAutomaticMemoryWriter,
  shouldSkipEmotionalReaction,
};
