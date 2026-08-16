/* === VIVENTIUM START ===
 * Feature: Core-owned GlassHive callback origin, destination, and scheduled-work binding.
 * Purpose:
 * - Persist the trusted request/schedule destination contract before a GlassHive launch.
 * - Resolve callbacks by owner + conversation + immutable assistant anchor instead of trusting
 *   callback-supplied Telegram/voice identifiers.
 * - Keep the small scheduled external-work projection needed to distinguish acknowledgement from
 *   objective completion. GlassHive remains the execution/state authority.
 * === VIVENTIUM END === */

const crypto = require('crypto');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { resolveTelegramMappingByUserId } = require('~/server/services/TelegramLinkService');
const { getMessageAncestorBranch, getMessages, markUserParallelWorkKnown } = require('~/models');
const {
  buildTrustedDelegationIdentity,
  requestAccountApi,
  signTrustedDelegationIdentity,
} = require('./GlassHiveAccountService');
const { normalizeInteractionSourceSegments } = require('./interactionContext');

const BINDING_COLLECTION = 'viventium_glasshive_callback_bindings';
const EXTERNAL_WORK_COLLECTION = 'viventium_external_work';
const DEFAULT_LAUNCH_PREPARATION_LEASE_MS = 2 * 60 * 1000;
const DEFAULT_LAUNCH_DISPATCH_AMBIGUITY_LEASE_MS = 2 * 60 * 1000;
const TERMINAL_STATES = Object.freeze(['completed', 'failed', 'cancelled']);
const SETTLED_DELIVERY_STATES = Object.freeze([
  'sent',
  'delivered',
  'acknowledged',
  'silent',
  'suppressed',
]);
const HOST_CAPACITY_CODES = new Set([
  'active_worker_conflict',
  'active_worker_limit',
  'host_worker_already_active',
  'host_capacity',
]);
const DESTINATION_SURFACES = new Set(['librechat', 'telegram', 'voice', 'workbench']);
const RECENT_CONTEXT_MAX_MESSAGES = 12;
const RECENT_CONTEXT_MAX_ANCESTORS = 32;
const RECENT_CONTEXT_MESSAGE_MAX_BYTES = 4 * 1024;
const RECENT_CONTEXT_TOTAL_MAX_BYTES = 12 * 1024;
const OBJECTIVE_IDENTITY_FIELDS = Object.freeze([
  'description',
  'success_criteria',
  'context',
  'title',
  'goal',
  'instruction',
  'additional_instructions',
  'uploaded_files',
  'files',
  'file_ids',
  'project_id',
  'worker_id',
  'workspace_alias',
  'reuse_existing_workspace',
  'run_at',
  'schedule_text',
  'delay_seconds',
]);

async function requireParallelWorkPositiveFence(ownerId) {
  if (await markUserParallelWorkKnown(ownerId)) return;
  const error = new Error('parallel_work_positive_fence_failed');
  error.code = 'parallel_work_positive_fence_failed';
  throw error;
}

const MISSION_ROUTING_IDENTITY_KEYS = new Set([
  'telegramchatid',
  'telegramuserid',
  'telegrammessageid',
  'voicecallsessionid',
  'voicerequestid',
  'callbackurl',
  'callbackhmac',
  'callbackhmacsecret',
  'viventiumdelegationassertion',
]);

function normalizeText(value, maxLength = 512) {
  return String(value || '')
    .trim()
    .slice(0, maxLength);
}

function truthyFlag(value) {
  if (value === true || value === 1) return true;
  return ['1', 'true', 'yes', 'on'].includes(normalizeText(value, 16).toLowerCase());
}

function launchPreparationLeaseMs() {
  const configured = Number(process.env.VIVENTIUM_GLASSHIVE_LAUNCH_PREPARATION_LEASE_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_LAUNCH_PREPARATION_LEASE_MS;
  }
  return Math.max(10_000, Math.min(Math.floor(configured), 10 * 60 * 1000));
}

function launchDispatchAmbiguityLeaseMs() {
  const configured = Number(process.env.VIVENTIUM_GLASSHIVE_LAUNCH_DISPATCH_LEASE_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_LAUNCH_DISPATCH_AMBIGUITY_LEASE_MS;
  }
  return Math.max(10_000, Math.min(Math.floor(configured), 10 * 60 * 1000));
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function opaqueRef(prefix, ...parts) {
  const digest = crypto
    .createHash('sha256')
    .update(parts.map((part) => normalizeText(part, 4096)).join('\0'))
    .digest('hex')
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function callbackBindingCollection() {
  return mongoose.connection.collection(BINDING_COLLECTION);
}

function externalWorkCollection() {
  return mongoose.connection.collection(EXTERNAL_WORK_COLLECTION);
}

function normalizedChannels(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const seen = new Set();
  const channels = [];
  for (const item of values) {
    const surface = normalizeText(item, 32).toLowerCase();
    if (!DESTINATION_SURFACES.has(surface) || seen.has(surface)) continue;
    seen.add(surface);
    channels.push(surface);
  }
  return channels;
}

function configuredDestinationsFromRequest(requestBody = {}) {
  const scheduledChannels = normalizedChannels(
    requestBody.viventiumSchedulerDeliveryChannels || requestBody.deliveryChannels,
  );
  if (scheduledChannels.length) {
    return scheduledChannels.map((surface) => ({ surface }));
  }

  const surface = normalizeText(requestBody.viventiumSurface, 32).toLowerCase();
  const destinations = [];
  if (surface === 'telegram') {
    destinations.push({
      surface: 'telegram',
      telegramChatId: normalizeText(requestBody.viventiumTelegramChatId),
      telegramUserId: normalizeText(requestBody.viventiumTelegramUserId),
      telegramMessageId: normalizeText(requestBody.viventiumTelegramMessageId),
    });
  } else if (surface === 'voice') {
    destinations.push({
      surface: 'voice',
      voiceCallSessionId: normalizeText(requestBody.viventiumVoiceCallSessionId),
      voiceRequestId: normalizeText(requestBody.viventiumVoiceRequestId),
    });
  }
  destinations.push({ surface: 'librechat' });
  return destinations;
}

function fingerprintObjectiveValue(value) {
  const canonical = stableStringify(value);
  const serialized = typeof canonical === 'string' ? canonical : String(canonical);
  return {
    bytes: Buffer.byteLength(serialized, 'utf8'),
    sha256: crypto.createHash('sha256').update(serialized, 'utf8').digest('hex'),
  };
}

function delegationLaunchPayloadDigest(args = {}) {
  const canonical = stableStringify({
    alias: normalizeText(args.alias),
    backend: normalizeText(args.backend),
    bootstrap_profile: normalizeText(args.bootstrap_profile || args.bootstrapProfile),
    connected_account_content_intent: truthyFlag(args.connected_account_content_intent),
    effort: normalizeText(args.effort),
    execution_mode: normalizeText(args.execution_mode || args.executionMode),
    expose_diagnostics: truthyFlag(args.expose_diagnostics),
    goal: normalizeText(args.goal, 100_000),
    instruction: normalizeText(args.instruction, 100_000),
    owner_id: normalizeText(args.owner_id, 160),
    profile: normalizeText(args.profile, 160),
    project_id: normalizeText(args.project_id, 160),
    require_callback: truthyFlag(args.require_callback),
    reuse_existing_workspace: truthyFlag(args.reuse_existing_workspace),
    title: normalizeText(args.title, 10_000),
    worker_name: normalizeText(args.worker_name || args.workerName, 10_000),
    worker_role: normalizeText(args.worker_role || args.workerRole, 10_000),
    workspace_root: normalizeText(args.workspace_root || args.workspaceRoot, 10_000),
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Bind all user-objective and file-reference fields while storing no raw objective text. */
function canonicalObjectiveIdentity(toolName, args = {}) {
  const fields = {};
  for (const key of OBJECTIVE_IDENTITY_FIELDS) {
    if (args[key] == null) continue;
    fields[key] = fingerprintObjectiveValue(args[key]);
  }
  return stableStringify({
    version: 1,
    tool_name: normalizeText(toolName, 80),
    fields,
  });
}

function trustedSourceEventId(requestBody = {}) {
  return normalizeText(
    requestBody.viventiumSourceEventId ||
      requestBody.viventiumLogicalTurnId ||
      requestBody.viventiumSchedulerOccurrenceKey ||
      requestBody.messageId ||
      requestBody.message_id,
    512,
  );
}

function trustedCallKey(toolCall = {}) {
  const id = normalizeText(
    toolCall.id || toolCall.tool_call_id || toolCall.toolCallId || toolCall.call_id,
    256,
  );
  const stepId = normalizeText(toolCall.stepId || toolCall.step_id, 256);
  if (!id && !stepId) return '';
  // The provider call id is the durable identity. A generated UI step is only a fallback for
  // harnesses that cannot expose one; invocation counters are presentation metadata, not identity.
  return stableStringify(id ? { id } : { step_id: stepId });
}

/**
 * Provider call identifiers are runtime-owned metadata, not model tool arguments. The digest is
 * stable across reconstructed requests; separate provider calls stay distinct even with identical
 * tool arguments. Ordinal is presentation metadata and never the durable idempotency anchor.
 */
function resolveTrustedGlassHiveCallIdentity({ requestBody, toolCall } = {}) {
  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
    throw new Error('glasshive_trusted_request_identity_missing');
  }
  const sourceEventId = trustedSourceEventId(requestBody);
  const callKey = trustedCallKey(toolCall);
  if (!sourceEventId || !callKey) {
    throw new Error('glasshive_trusted_call_identity_missing');
  }
  const callIdentityDigest = crypto.createHash('sha256').update(callKey, 'utf8').digest('hex');
  const providerTurn = Number(toolCall?.turn);
  const objectiveOrdinal =
    Number.isInteger(providerTurn) && providerTurn >= 0
      ? providerTurn
      : Number.parseInt(callIdentityDigest.slice(0, 8), 16);
  return {
    sourceEventId,
    objectiveOrdinal,
    callIdentityDigest,
  };
}

function trustedTriggeringSourceSegments(requestBody = {}) {
  const candidates = Array.isArray(requestBody.viventiumTriggeringSourceSegments)
    ? requestBody.viventiumTriggeringSourceSegments
    : [];
  const fallbackSourceEventId = trustedSourceEventId(requestBody);
  const normalized = normalizeInteractionSourceSegments(
    candidates.map((candidate, sourceIndex) => ({
      ...candidate,
      source_event_id: normalizeText(candidate?.source_event_id, 160) || fallbackSourceEventId,
      source_index: Number.isInteger(Number(candidate?.source_index))
        ? Number(candidate.source_index)
        : Number.isInteger(Number(candidate?.ordinal))
          ? Number(candidate.ordinal)
          : sourceIndex,
    })),
    requestBody.viventiumTriggeringSourceSegmentsOverflowCount,
  );
  return {
    segments: normalized.segments.map((segment) => ({
      // GlassHive treats this as a strict text-provenance contract. Attachment descriptors cross
      // the launch boundary separately through the trusted `uploaded_files` projection.
      ordinal: segment.ordinal,
      source_event_id: segment.source_event_id,
      source_index: segment.source_index,
      text: segment.text,
      ...(segment.truncated === true ? { truncated: true } : {}),
      ...(normalizeText(segment.original_sha256, 64)
        ? { original_sha256: normalizeText(segment.original_sha256, 64).toLowerCase() }
        : {}),
    })),
    overflowCount: normalized.overflowCount,
  };
}

function clipUtf8Text(value, maxBytes) {
  if (typeof value !== 'string' || maxBytes <= 0) return { text: '', truncated: false };
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

function visibleConversationMessageText(message = {}) {
  if (
    message.unfinished === true ||
    message.error === true ||
    message.metadata?.viventium?.internal === true ||
    message.metadata?.viventium?.interactionContext?.actor_kind === 'system' ||
    normalizeText(message.sender, 64).toLowerCase() === 'system'
  ) {
    return '';
  }
  if (typeof message.text === 'string' && message.text.trim()) return message.text;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function normalizeRecentConversationExcerpt(candidates = []) {
  const newestFirst = [];
  let remainingBytes = RECENT_CONTEXT_TOTAL_MAX_BYTES;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (newestFirst.length >= RECENT_CONTEXT_MAX_MESSAGES || remainingBytes <= 0) break;
    const role =
      candidate?.role === 'user' || candidate?.role === 'assistant' ? candidate.role : '';
    const messageId = normalizeText(candidate?.message_id, 160);
    if (!role || !messageId || typeof candidate?.text !== 'string' || !candidate.text.trim()) {
      continue;
    }
    const clipped = clipUtf8Text(
      candidate.text,
      Math.min(RECENT_CONTEXT_MESSAGE_MAX_BYTES, remainingBytes),
    );
    if (!clipped.text) continue;
    newestFirst.push({
      message_id: messageId,
      ...(normalizeText(candidate?.parent_message_id, 160)
        ? { parent_message_id: normalizeText(candidate.parent_message_id, 160) }
        : {}),
      role,
      text: clipped.text,
      ...(candidate?.truncated === true || clipped.truncated ? { truncated: true } : {}),
    });
    remainingBytes -= Buffer.byteLength(clipped.text, 'utf8');
  }
  return newestFirst.reverse().map((item, ordinal) => Object.freeze({ ordinal, ...item }));
}

async function loadTrustedRecentConversationExcerpt({
  ownerId,
  conversationId,
  requestedParentMessageId,
} = {}) {
  if (!ownerId || !conversationId || !requestedParentMessageId) return [];
  try {
    const branch = await getMessageAncestorBranch({
      user: ownerId,
      conversationId,
      messageId: requestedParentMessageId,
      maxAncestors: RECENT_CONTEXT_MAX_ANCESTORS,
    });
    const current = Array.isArray(branch) ? branch[0] : null;
    const candidates = current?.isCreatedByUser === true ? branch.slice(1) : branch;
    const newestFirst = [];
    for (const message of candidates) {
      const messageId = normalizeText(message?.messageId, 160);
      if (!messageId) continue;
      const role =
        message.isCreatedByUser === true
          ? 'user'
          : message.isCreatedByUser === false
            ? 'assistant'
            : '';
      const text = role ? visibleConversationMessageText(message) : '';
      if (text) {
        newestFirst.push({
          message_id: messageId,
          parent_message_id: normalizeText(message.parentMessageId, 160),
          role,
          text,
        });
      }
    }
    return normalizeRecentConversationExcerpt(newestFirst);
  } catch (error) {
    logger.warn('[VIVENTIUM][glasshive-binding] Recent conversation projection unavailable', {
      code: normalizeText(error?.code || error?.name || 'conversation_context_unavailable', 120),
    });
    return [];
  }
}

function exactMessageById(messages) {
  const byId = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const messageId = normalizeText(message?.messageId, 160);
    if (messageId) byId.set(messageId, message);
  }
  return byId.size === 1 ? Array.from(byId.values())[0] : null;
}

async function resolveTrustedLaunchAnchor({ ownerId, conversationId, requestBody, sourceEventId }) {
  const currentAnchorMessageId = normalizeText(
    requestBody.messageId || requestBody.message_id,
    160,
  );
  const currentParentMessageId = normalizeText(
    requestBody.parentMessageId || requestBody.parent_message_id,
    160,
  );
  const authoringSourceEventId = normalizeText(requestBody.viventiumAuthoringSourceEventId, 160);
  if (!authoringSourceEventId || authoringSourceEventId === sourceEventId) {
    return {
      anchorMessageId: currentAnchorMessageId,
      requestedParentMessageId: currentParentMessageId,
    };
  }

  const selectedUsers = await getMessages(
    {
      user: ownerId,
      conversationId,
      isCreatedByUser: true,
      'metadata.viventium.interactionContext.source_event_id': sourceEventId,
    },
    'messageId parentMessageId isCreatedByUser createdAt',
  );
  const selectedUser = exactMessageById(selectedUsers);
  const selectedUserMessageId = normalizeText(selectedUser?.messageId, 160);
  if (!selectedUserMessageId) {
    const error = new Error('glasshive_selected_source_anchor_unavailable');
    error.code = 'glasshive_selected_source_anchor_unavailable';
    throw error;
  }

  const selectedAssistants = await getMessages(
    {
      user: ownerId,
      conversationId,
      isCreatedByUser: false,
      parentMessageId: selectedUserMessageId,
    },
    'messageId parentMessageId isCreatedByUser createdAt',
  );
  const selectedAssistant = exactMessageById(selectedAssistants);
  const selectedAssistantMessageId = normalizeText(selectedAssistant?.messageId, 160);
  if (!selectedAssistantMessageId) {
    const error = new Error('glasshive_selected_source_anchor_unavailable');
    error.code = 'glasshive_selected_source_anchor_unavailable';
    throw error;
  }
  return {
    anchorMessageId: selectedAssistantMessageId,
    requestedParentMessageId: selectedUserMessageId,
  };
}

function buildTrustedDelegationContext(requestBody = {}, sourceEventId, recentConversation = []) {
  const logicalTurnId = normalizeText(requestBody.viventiumLogicalTurnId, 512);
  const surface = normalizeText(requestBody.viventiumSurface, 32).toLowerCase();
  const triggeringSources = trustedTriggeringSourceSegments(requestBody);
  return {
    version: 1,
    source_event_id: sourceEventId,
    ...(logicalTurnId ? { logical_turn_id: logicalTurnId } : {}),
    ...(DESTINATION_SURFACES.has(surface) ? { surface } : {}),
    triggering_source_segments: triggeringSources.segments,
    ...(triggeringSources.overflowCount > 0
      ? { source_segments_overflow_count: triggeringSources.overflowCount }
      : {}),
    ...(recentConversation.length ? { recent_conversation: recentConversation } : {}),
  };
}

async function registerGlassHiveLaunchContext({
  user,
  requestBody = {},
  toolName = '',
  toolArguments = {},
  toolCall = {},
} = {}) {
  const ownerId = normalizeText(user?.id || user?._id);
  const conversationId = normalizeText(requestBody.conversationId || requestBody.conversation_id);
  const currentAnchorMessageId = normalizeText(requestBody.messageId || requestBody.message_id);
  if (!ownerId || !conversationId || !currentAnchorMessageId) {
    return null;
  }

  const destinations = configuredDestinationsFromRequest(requestBody);
  const args =
    toolArguments && typeof toolArguments === 'object' && !Array.isArray(toolArguments)
      ? toolArguments
      : {};
  const trustedCallIdentity = resolveTrustedGlassHiveCallIdentity({ requestBody, toolCall });
  const { sourceEventId, objectiveOrdinal, callIdentityDigest } = trustedCallIdentity;
  const { anchorMessageId, requestedParentMessageId } = await resolveTrustedLaunchAnchor({
    ownerId,
    conversationId,
    requestBody,
    sourceEventId,
  });
  const canonicalObjective = canonicalObjectiveIdentity(toolName, args);
  const trustedDelegation = buildTrustedDelegationIdentity({
    ownerId,
    sourceEventId,
    objectiveOrdinal,
    callIdentityDigest,
    goal: canonicalObjective,
  });
  const objectiveDigest = trustedDelegation.goalDigest;
  const delegationIdentity = {
    version: 1,
    idempotency_key: trustedDelegation.idempotencyKey,
    goal_digest: objectiveDigest,
    source_event_id: sourceEventId,
    objective_ordinal: objectiveOrdinal,
    call_identity_digest: callIdentityDigest,
  };
  const recentConversation = await loadTrustedRecentConversationExcerpt({
    ownerId,
    conversationId,
    requestedParentMessageId,
  });
  const delegationContext = buildTrustedDelegationContext(
    requestBody,
    sourceEventId,
    recentConversation,
  );
  /* === VIVENTIUM START ===
   * Feature: Durable launch intent identity.
   * Purpose: This Core-owned ref identifies the dispatch intent and delivery contract only. It is
   * never presented as GlassHive work identity; the authoritative workRef is bound after dispatch
   * or repaired from a verified callback when the launch response was lost.
   * === VIVENTIUM END === */
  const originRef = opaqueRef('ghi', ownerId, sourceEventId, callIdentityDigest, objectiveDigest);
  const bindingId = originRef;
  const schedulerDispatchDocumentId = normalizeText(
    requestBody.viventiumSchedulerDispatchDocumentId,
  );
  const scheduleOccurrenceKey = normalizeText(requestBody.viventiumSchedulerOccurrenceKey);
  const scheduleId = normalizeText(requestBody.viventiumScheduleId || requestBody.scheduleId);
  const requiredExternalWork =
    Boolean(schedulerDispatchDocumentId || scheduleOccurrenceKey) &&
    requestBody.viventiumSchedulerExternalWorkRequired === true;
  const now = new Date();
  const preparationExpiresAt = new Date(now.getTime() + launchPreparationLeaseMs());
  await callbackBindingCollection().updateOne(
    { _id: bindingId },
    {
      $setOnInsert: {
        _id: bindingId,
        bindingId,
        ownerId,
        conversationId,
        anchorMessageId,
        requestedParentMessageId,
        configuredDestinations: destinations,
        schedulerDispatchDocumentId,
        scheduleOccurrenceKey,
        scheduleId,
        originRef,
        workRef: '',
        launchState: 'prepared',
        preparationExpiresAt,
        sourceEventId,
        objectiveOrdinal,
        objectiveDigest,
        callIdentityDigest,
        mainAgentId: normalizeText(
          requestBody.agent_id || requestBody.agentId || requestBody.endpointOption?.agent_id,
          160,
        ),
        createdAt: now,
      },
      $set: {
        updatedAt: now,
      },
    },
    { upsert: true },
  );

  await externalWorkCollection().updateOne(
    { _id: originRef },
    {
      $setOnInsert: {
        _id: originRef,
        originRef,
        workRef: '',
        ownerId,
        conversationId,
        anchorMessageId,
        requestedParentMessageId,
        deliveryBindingId: originRef,
        schedulerDispatchDocumentId,
        scheduleOccurrenceKey,
        scheduleId,
        sourceEventId,
        objectiveOrdinal,
        objectiveDigest,
        callIdentityDigest,
        required: requiredExternalWork,
        configuredDestinations: destinations.map(({ surface }) => surface),
        externalState: 'preparing',
        launchState: 'prepared',
        preparationExpiresAt,
        workerId: '',
        runId: '',
        createdAt: now,
      },
      $set: { updatedAt: now },
    },
    { upsert: true },
  );

  logger.info('[VIVENTIUM][glasshive-binding] launch bound', {
    bindingId,
    originRef,
    ownerId,
    sourceEventId,
    objectiveOrdinal,
    scheduled: Boolean(scheduleOccurrenceKey),
    required: requiredExternalWork,
    destinations: destinations.map(({ surface }) => surface),
  });
  return {
    bindingId,
    originRef,
    sourceEventId,
    objectiveOrdinal,
    objectiveDigest,
    callIdentityDigest,
    delegationIdentity,
    delegationContext,
    ownerId,
    schedulerDispatchDocumentId,
    scheduleOccurrenceKey,
    required: requiredExternalWork,
  };
}

async function resolveTelegramDestination(ownerId, destination = {}) {
  const boundChatId = normalizeText(destination.telegramChatId);
  const boundUserId = normalizeText(destination.telegramUserId);
  if (boundChatId || boundUserId) {
    return {
      surface: 'telegram',
      telegramChatId: boundChatId || boundUserId,
      telegramUserId: boundUserId || boundChatId,
      ...(destination.telegramMessageId
        ? { telegramMessageId: normalizeText(destination.telegramMessageId) }
        : {}),
    };
  }
  const mapping = await resolveTelegramMappingByUserId({ libreChatUserId: ownerId });
  const telegramUserId = normalizeText(mapping?.telegramUserId);
  const telegramChatId = normalizeText(mapping?.telegramChatId || telegramUserId);
  if (!telegramUserId || !telegramChatId) {
    return { surface: 'telegram', unresolvedReason: 'telegram_mapping_not_found' };
  }
  return { surface: 'telegram', telegramChatId, telegramUserId };
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 256 * 1024) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripMissionRoutingIdentity(value, depth = 0) {
  if (depth > 12 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripMissionRoutingIdentity(item, depth + 1));
  }
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    const canonicalKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (MISSION_ROUTING_IDENTITY_KEYS.has(canonicalKey)) continue;
    clean[key] = stripMissionRoutingIdentity(child, depth + 1);
  }
  return clean;
}

function glassHiveLaunchOriginFromArguments(toolArguments) {
  const args = parseJsonObject(toolArguments);
  if (!args) return '';
  const bundle = parseJsonObject(args.bootstrap_bundle_json);
  return normalizeText(bundle?.callbacks?.origin_ref, 160);
}

/** Attach the Core-owned launch intent after reading any model-provided bundle. */
function attachGlassHiveLaunchOrigin(toolArguments, originRef) {
  const args = parseJsonObject(toolArguments);
  const normalizedOriginRef = normalizeText(originRef, 160);
  if (!args || !normalizedOriginRef) return toolArguments;
  const bundle = parseJsonObject(args.bootstrap_bundle_json) || {};
  args.bootstrap_bundle_json = {
    ...stripMissionRoutingIdentity(bundle),
    // Callback URL, HMAC, surface identity, and anchors come only from trusted server config.
    // Never preserve model-supplied callback routing in a mission bootstrap.
    callbacks: { origin_ref: normalizedOriginRef },
  };
  return typeof toolArguments === 'string' ? JSON.stringify(args) : args;
}

/**
 * Overwrite every launch-security field after parsing the model's bundle. This is the sole helper
 * used by the MCP dispatch path; protected values always come from Core registration.
 */
function attachGlassHiveTrustedLaunchMetadata(toolArguments, launchContext = {}) {
  const originRef = normalizeText(launchContext.originRef, 160);
  const identity = launchContext.delegationIdentity;
  const context = launchContext.delegationContext;
  const ordinal = Number(identity?.objective_ordinal);
  const callIdentityDigest = normalizeText(identity?.call_identity_digest, 64).toLowerCase();
  if (
    !originRef ||
    identity?.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(normalizeText(identity.idempotency_key, 64).toLowerCase()) ||
    !/^[a-f0-9]{64}$/.test(normalizeText(identity.goal_digest, 64).toLowerCase()) ||
    !/^[a-f0-9]{64}$/.test(callIdentityDigest) ||
    !normalizeText(identity.source_event_id, 512) ||
    !Number.isInteger(ordinal) ||
    ordinal < 0 ||
    context?.version !== 1 ||
    normalizeText(context.source_event_id, 512) !== normalizeText(identity.source_event_id, 512) ||
    !Array.isArray(context.triggering_source_segments)
  ) {
    throw new Error('glasshive_trusted_launch_metadata_invalid');
  }
  const originBound = attachGlassHiveLaunchOrigin(toolArguments, originRef);
  const args = parseJsonObject(originBound);
  if (!args) throw new Error('glasshive_launch_arguments_invalid');
  const bundle = parseJsonObject(args.bootstrap_bundle_json) || {};
  const triggeringSources = trustedTriggeringSourceSegments({
    viventiumSourceEventId: context.source_event_id,
    viventiumTriggeringSourceSegments: context.triggering_source_segments,
    viventiumTriggeringSourceSegmentsOverflowCount: context.source_segments_overflow_count,
  });
  const trustedIdentity = {
    version: 2,
    idempotency_key: normalizeText(identity.idempotency_key, 64).toLowerCase(),
    goal_digest: normalizeText(identity.goal_digest, 64).toLowerCase(),
    launch_payload_digest: delegationLaunchPayloadDigest(args),
    source_event_id: normalizeText(identity.source_event_id, 512),
    objective_ordinal: ordinal,
    call_identity_digest: callIdentityDigest,
  };
  args.bootstrap_bundle_json = {
    ...stripMissionRoutingIdentity(bundle),
    callbacks: { origin_ref: originRef },
    viventium_delegation_identity: trustedIdentity,
    viventium_delegation_assertion: signTrustedDelegationIdentity(trustedIdentity, {
      ownerId: launchContext.ownerId,
    }),
    viventium_delegation_context: {
      version: 1,
      source_event_id: normalizeText(context.source_event_id, 512),
      ...(normalizeText(context.logical_turn_id, 512)
        ? { logical_turn_id: normalizeText(context.logical_turn_id, 512) }
        : {}),
      ...(DESTINATION_SURFACES.has(normalizeText(context.surface, 32).toLowerCase())
        ? { surface: normalizeText(context.surface, 32).toLowerCase() }
        : {}),
      triggering_source_segments: triggeringSources.segments,
      ...(triggeringSources.overflowCount > 0
        ? { source_segments_overflow_count: triggeringSources.overflowCount }
        : {}),
      ...(Array.isArray(context.recent_conversation)
        ? {
            recent_conversation: normalizeRecentConversationExcerpt(
              [...context.recent_conversation].reverse(),
            ),
          }
        : {}),
    },
  };
  return typeof toolArguments === 'string' ? JSON.stringify(args) : args;
}

function findAuthoritativeWorkRef(value, depth = 0, visited = new Set()) {
  if (depth > 8 || value == null) return '';
  if (typeof value === 'string') {
    const parsed = parseJsonObject(value);
    return parsed ? findAuthoritativeWorkRef(parsed, depth + 1, visited) : '';
  }
  if (typeof value !== 'object' || visited.has(value)) return '';
  visited.add(value);
  if (!Array.isArray(value)) {
    const direct = normalizeText(value.work_ref || value.workRef, 160);
    if (direct) return direct;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findAuthoritativeWorkRef(child, depth + 1, visited);
    if (found) return found;
  }
  return '';
}

async function reconcileGlassHiveLaunchResult({ toolArguments, result } = {}) {
  const originRef = glassHiveLaunchOriginFromArguments(toolArguments);
  const workRef = findAuthoritativeWorkRef(result);
  if (!originRef || !workRef) return null;
  const now = new Date();
  const filter = { _id: originRef, $or: [{ workRef: '' }, { workRef }] };
  await callbackBindingCollection().updateOne(filter, {
    $set: { workRef, launchState: 'accepted', updatedAt: now },
    $unset: { dispatchExpiresAt: 1 },
  });
  await externalWorkCollection().updateOne(filter, {
    $set: { workRef, launchState: 'accepted', updatedAt: now },
    $unset: { dispatchExpiresAt: 1 },
  });
  return { originRef, workRef };
}

/** Mark a fully prepared launch immediately before the MCP transport may observe it. */
async function markGlassHiveLaunchDispatchReady(launchContext = {}) {
  const originRef = normalizeText(launchContext.originRef, 160);
  const ownerId = normalizeText(launchContext.ownerId, 160);
  if (!originRef || !ownerId) return null;
  const now = new Date();
  const dispatchExpiresAt = new Date(now.getTime() + launchDispatchAmbiguityLeaseMs());
  const filter = {
    _id: originRef,
    workRef: '',
    launchState: { $in: ['prepared', 'not_dispatched'] },
  };
  const bindingUpdate = {
    $set: { launchState: 'dispatch_ready', dispatchExpiresAt, updatedAt: now },
    $unset: { preparationExpiresAt: 1, preDispatchFailureCode: 1, preDispatchFailedAt: 1 },
  };
  const workUpdate = {
    $set: {
      launchState: 'dispatch_ready',
      externalState: 'accepted',
      dispatchExpiresAt,
      updatedAt: now,
    },
    $unset: {
      preparationExpiresAt: 1,
      preDispatchFailureCode: 1,
      preDispatchFailedAt: 1,
      terminalAt: 1,
    },
  };
  await callbackBindingCollection().updateOne(filter, bindingUpdate);
  await externalWorkCollection().updateOne(filter, workUpdate);
  // This hint is set only after every Core-side prerequisite has succeeded. From here onward an
  // MCP transport error is ambiguous and the ordinary dispatch_unknown reconciler owns it.
  await requireParallelWorkPositiveFence(ownerId);
  return { originRef, launchState: 'dispatch_ready' };
}

/** Close a launch that provably failed before dispatch or was verified absent after its lease. */
async function markGlassHiveLaunchPreDispatchFailed(launchContext = {}, error) {
  const originRef = normalizeText(launchContext.originRef, 160);
  const ownerId = normalizeText(launchContext.ownerId, 160);
  if (!originRef || !ownerId) return null;
  const now = new Date();
  const failureCode = normalizeText(
    error?.code || error?.name || 'launch_pre_dispatch_failed',
    120,
  );
  const filter = {
    _id: originRef,
    workRef: '',
    launchState: { $in: ['prepared', 'dispatch_ready', 'dispatch_unknown'] },
  };
  const common = {
    launchState: 'not_dispatched',
    preDispatchFailureCode: failureCode,
    preDispatchFailedAt: now,
    updatedAt: now,
  };
  await callbackBindingCollection().updateOne(filter, {
    $set: common,
    $unset: { preparationExpiresAt: 1, dispatchExpiresAt: 1 },
  });
  await externalWorkCollection().updateOne(filter, {
    $set: {
      ...common,
      externalState: 'failed',
      terminalAt: now,
      attentionPending: true,
      deliveryState: 'failed',
    },
    $unset: { preparationExpiresAt: 1, dispatchExpiresAt: 1 },
  });

  // No GlassHive workRef exists, but the failed launch itself is durable account work that needs
  // acknowledgement. Publish the positive hint after its attention row commits; only a fresh
  // owner-scoped roster after dismissal may clear the account-global hint.
  await requireParallelWorkPositiveFence(ownerId);

  if (
    launchContext.required === true &&
    (launchContext.schedulerDispatchDocumentId || launchContext.scheduleOccurrenceKey)
  ) {
    try {
      const binding = {
        ownerId,
        schedulerDispatchDocumentId: normalizeText(launchContext.schedulerDispatchDocumentId, 160),
        scheduleOccurrenceKey: normalizeText(launchContext.scheduleOccurrenceKey, 160),
      };
      const summary = await getSchedulerExternalWorkSummary(binding);
      await notifySchedulerExternalWorkSummary({ binding, summary });
    } catch (schedulerError) {
      logger.warn('[VIVENTIUM][glasshive-binding] Pre-dispatch schedule reconciliation failed', {
        originRef,
        code: normalizeText(schedulerError?.code || schedulerError?.name, 120),
      });
    }
  }
  return { originRef, launchState: 'not_dispatched', externalState: 'failed' };
}

async function markGlassHiveLaunchDispatchUnknown(toolArguments) {
  const originRef = glassHiveLaunchOriginFromArguments(toolArguments);
  if (!originRef) return null;
  const now = new Date();
  const update = {
    $set: {
      launchState: 'dispatch_unknown',
      dispatchExpiresAt: new Date(now.getTime() + launchDispatchAmbiguityLeaseMs()),
      updatedAt: now,
    },
  };
  const filter = { _id: originRef, launchState: { $in: ['prepared', 'dispatch_ready'] } };
  await callbackBindingCollection().updateOne(filter, update);
  await externalWorkCollection().updateOne(filter, update);
  return { originRef, launchState: 'dispatch_unknown' };
}

/** Close an authoritative GlassHive blocked/rejected response that proves no mission was created. */
async function markGlassHiveLaunchDispatchRejected(toolArguments, error) {
  const originRef = glassHiveLaunchOriginFromArguments(toolArguments);
  if (!originRef) return null;
  const binding = await callbackBindingCollection().findOne({ _id: originRef });
  if (!binding?.ownerId || binding?.workRef) return null;
  return markGlassHiveLaunchPreDispatchFailed(binding, error);
}

async function resolveGlassHiveCallbackContext(body = {}) {
  const originRef = normalizeText(body.origin_ref, 160);
  const workRef = normalizeText(body.work_ref, 160);
  const workerId = normalizeText(body.worker_id, 160);
  const runId = normalizeText(body.run_id, 160);
  if (!originRef || !workRef || !workerId || !runId) {
    return null;
  }
  const binding = await callbackBindingCollection().findOne({ _id: originRef });
  if (!binding) {
    return null;
  }
  const ownerId = normalizeText(binding.ownerId);
  const conversationId = normalizeText(binding.conversationId);
  const anchorMessageId = normalizeText(binding.anchorMessageId);
  if (!ownerId || !conversationId || !anchorMessageId) return null;
  const boundWorkRef = normalizeText(binding.workRef, 160);
  if (boundWorkRef && boundWorkRef !== workRef) return null;

  let association;
  try {
    association = await requestAccountApi({
      ownerId,
      path: '/v1/callback-associations/verify',
      method: 'POST',
      body: { originRef, workRef, workerId, runId },
      timeoutMs: 3000,
    });
  } catch (error) {
    if (Number(error?.status) === 404) return null;
    throw error;
  }
  if (
    association?.valid !== true ||
    normalizeText(association?.originRef, 160) !== originRef ||
    normalizeText(association?.workRef, 160) !== workRef
  ) {
    return null;
  }

  /* A verified callback is also the durable repair path for "commit succeeded, response lost". */
  const now = new Date();
  const bindFilter = { _id: originRef, $or: [{ workRef: '' }, { workRef }] };
  await callbackBindingCollection().updateOne(bindFilter, {
    $set: { workRef, launchState: 'callback_confirmed', updatedAt: now },
    $unset: { dispatchExpiresAt: 1 },
  });
  await externalWorkCollection().updateOne(bindFilter, {
    $set: { workRef, workerId, runId, launchState: 'callback_confirmed', updatedAt: now },
    $unset: { dispatchExpiresAt: 1 },
  });

  const destinations = [];
  for (const destination of Array.isArray(binding.configuredDestinations)
    ? binding.configuredDestinations
    : []) {
    const surface = normalizeText(destination?.surface, 32).toLowerCase();
    if (surface === 'telegram') {
      destinations.push(await resolveTelegramDestination(ownerId, destination));
    } else if (surface === 'voice') {
      const voiceCallSessionId = normalizeText(destination.voiceCallSessionId);
      destinations.push(
        voiceCallSessionId
          ? {
              surface: 'voice',
              voiceCallSessionId,
              voiceRequestId: normalizeText(destination.voiceRequestId),
            }
          : { surface: 'voice', unresolvedReason: 'voice_session_not_bound' },
      );
    } else if (surface === 'librechat' || surface === 'workbench') {
      destinations.push({ surface });
    }
  }

  return {
    bindingId: normalizeText(binding.bindingId || binding._id),
    originRef,
    workRef,
    ownerId,
    conversationId,
    anchorMessageId,
    requestedParentMessageId: normalizeText(binding.requestedParentMessageId),
    schedulerDispatchDocumentId: normalizeText(binding.schedulerDispatchDocumentId),
    scheduleOccurrenceKey: normalizeText(binding.scheduleOccurrenceKey),
    scheduleId: normalizeText(binding.scheduleId),
    mainAgentId: normalizeText(binding.mainAgentId, 160),
    destinations,
  };
}

function callbackStateForEvent(body = {}) {
  const event = normalizeText(body.event, 64);
  const failureCode = normalizeText(
    body.failure_code || body.failure_class || body.error_code || body?.error?.code,
    80,
  ).toLowerCase();
  if (event === 'run.failed' && HOST_CAPACITY_CODES.has(failureCode)) {
    return 'queued';
  }
  switch (event) {
    case 'run.completed':
      return 'completed';
    case 'run.failed':
      return 'failed';
    case 'run.cancelled':
    case 'run.interrupted':
      return 'cancelled';
    case 'checkpoint.ready':
    case 'takeover.requested':
    case 'run.needs_input':
    case 'run.blocked':
      return 'needs_input';
    case 'run.paused':
    case 'worker.paused':
      return 'paused';
    case 'run.queued':
    case 'run.requeued':
    case 'run.capacity_waiting':
    case 'run.waiting_capacity':
    case 'run.waiting_on_capacity':
      return 'queued';
    case 'run.stopping':
      return 'stopping';
    case 'run.started':
    case 'run.resumed':
    case 'worker.resumed_by_alias':
      return 'running';
    default:
      return '';
  }
}

/* === VIVENTIUM START ===
 * Feature: Canonical WorkRef lifecycle callbacks.
 * Purpose: A run is only one execution inside a durable work root. Queue/Message can create a
 * sibling run, so a terminal run event must not complete the WorkRef unless GlassHive's verified
 * callback also asserts the canonical work is terminal. Legacy terminal callbacks fail
 * nonterminal; the authoritative account snapshot/reconciliation path can safely repair them.
 * === VIVENTIUM END === */
function canonicalGlassHiveWorkState(body = {}) {
  const state = normalizeText(body.work_state, 32).toLowerCase();
  return [
    'queued',
    'running',
    'paused',
    'needs_input',
    'stopping',
    'settling',
    'completed',
    'failed',
    'cancelled',
  ].includes(state)
    ? state
    : '';
}

function isGlassHiveWorkTerminalCallback(body = {}) {
  const state = canonicalGlassHiveWorkState(body);
  return body.work_terminal === true && TERMINAL_STATES.includes(state);
}

function callbackWorkState(body = {}) {
  const runState = callbackStateForEvent(body);
  const workState = canonicalGlassHiveWorkState(body);
  const hasWorkContract = typeof body.work_terminal === 'boolean' && Boolean(workState);
  if (hasWorkContract) {
    if (body.work_terminal === true) {
      return TERMINAL_STATES.includes(workState) ? workState : '';
    }
    return TERMINAL_STATES.includes(workState)
      ? ''
      : workState === 'settling'
        ? 'running'
        : workState;
  }
  // Nonterminal legacy events cannot prematurely finish the WorkRef and remain safe to project.
  return TERMINAL_STATES.includes(runState) ? '' : runState;
}

function externalWorkFilter({ ownerId, schedulerDispatchDocumentId, scheduleOccurrenceKey } = {}) {
  const filter = { ownerId: normalizeText(ownerId) };
  if (schedulerDispatchDocumentId) {
    filter.schedulerDispatchDocumentId = normalizeText(schedulerDispatchDocumentId);
  } else if (scheduleOccurrenceKey) {
    filter.scheduleOccurrenceKey = normalizeText(scheduleOccurrenceKey);
  }
  return filter;
}

async function getSchedulerExternalWorkSummary({
  ownerId,
  schedulerDispatchDocumentId = '',
  scheduleOccurrenceKey = '',
} = {}) {
  const filter = externalWorkFilter({
    ownerId,
    schedulerDispatchDocumentId,
    scheduleOccurrenceKey,
  });
  if (!filter.ownerId || (!filter.schedulerDispatchDocumentId && !filter.scheduleOccurrenceKey)) {
    return {
      requiredTotal: 0,
      requiredTerminal: 0,
      requiredFailed: 0,
      allRequiredTerminal: true,
      state: 'none',
      items: [],
    };
  }
  const rows = await externalWorkCollection().find(filter).toArray();
  const items = rows.map((row) => ({
    workRef: normalizeText(row.workRef || row._id),
    required: row.required === true,
    state: normalizeText(row.externalState, 32) || 'accepted',
  }));
  const required = items.filter((item) => item.required);
  const terminal = required.filter((item) => TERMINAL_STATES.includes(item.state));
  const requiredFailed = terminal.filter((item) => item.state !== 'completed').length;
  const allRequiredTerminal = required.length === 0 || terminal.length === required.length;
  return {
    requiredTotal: required.length,
    requiredTerminal: terminal.length,
    requiredFailed,
    allRequiredTerminal,
    state:
      required.length === 0
        ? 'none'
        : allRequiredTerminal
          ? requiredFailed
            ? 'failed'
            : 'completed'
          : 'waiting_external',
    items,
  };
}

/**
 * Cheap Core-local hint used to decide whether focused-mode turns need the authoritative
 * GlassHive roster. This is deliberately not a roster: GlassHive remains state authority.
 * Terminal work only keeps the hint alive while Core knows it still needs attention or delivery.
 */
async function hasKnownExternalWork({ ownerId } = {}) {
  const normalizedOwnerId = normalizeText(ownerId);
  if (!normalizedOwnerId) return false;
  const row = await externalWorkCollection().findOne(
    {
      ownerId: normalizedOwnerId,
      $or: [
        {
          launchState: 'not_dispatched',
          externalState: 'failed',
          attentionPending: { $ne: false },
        },
        {
          launchState: { $nin: ['prepared', 'not_dispatched'] },
          $or: [
            { externalState: { $nin: TERMINAL_STATES } },
            { attentionPending: true },
            { deliveryState: { $in: ['pending', 'failed', 'unresolved'] } },
          ],
        },
      ],
    },
    { projection: { _id: 1 } },
  );
  return Boolean(row);
}

/**
 * Re-seed the conservative per-account hint after a Core restart or schema migration. Never clear
 * here: only a fresh authoritative GlassHive empty roster may prove that an account has no work.
 */
async function reconcileKnownExternalWorkHints({ limit = 100 } = {}) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const rows = await externalWorkCollection()
    .find(
      {
        ownerId: { $nin: ['', null] },
        $or: [
          {
            launchState: 'not_dispatched',
            externalState: 'failed',
            attentionPending: { $ne: false },
          },
          {
            launchState: { $nin: ['prepared', 'not_dispatched'] },
            $or: [
              { externalState: { $nin: TERMINAL_STATES } },
              { attentionPending: true },
              { deliveryState: { $in: ['pending', 'failed', 'unresolved'] } },
            ],
          },
        ],
      },
      { projection: { ownerId: 1 } },
    )
    .sort({ updatedAt: -1 })
    .limit(boundedLimit * 10)
    .toArray();
  const ownerIds = Array.from(
    new Set(rows.map((row) => normalizeText(row?.ownerId, 160)).filter(Boolean)),
  ).slice(0, boundedLimit);
  const outcomes = await Promise.all(ownerIds.map((ownerId) => markUserParallelWorkKnown(ownerId)));
  return {
    scanned: rows.length,
    updatedOwners: outcomes.filter(Boolean).length,
    failedOwners: outcomes.filter((updated) => !updated).length,
  };
}

/** Reconcile launch intents whose MCP response was lost before Core learned the workRef. */
async function reconcileUnknownGlassHiveLaunches({ ownerId, limit = 25 } = {}) {
  const normalizedOwnerId = normalizeText(ownerId, 160);
  const now = new Date();
  const legacyPreparedBefore = new Date(now.getTime() - launchPreparationLeaseMs());
  const filter = {
    workRef: '',
    ...(normalizedOwnerId ? { ownerId: normalizedOwnerId } : {}),
    // A single persistently unavailable owner/row must not monopolize every bounded scan.
    $nor: [{ reconciliationNextAt: { $gt: now } }],
    $or: [
      { launchState: 'dispatch_unknown' },
      { launchState: 'dispatch_ready', dispatchExpiresAt: { $lte: now } },
      {
        launchState: 'dispatch_ready',
        dispatchExpiresAt: { $exists: false },
        updatedAt: { $lte: legacyPreparedBefore },
      },
      { launchState: 'prepared', preparationExpiresAt: { $lte: now } },
      {
        launchState: 'prepared',
        preparationExpiresAt: { $exists: false },
        updatedAt: { $lte: legacyPreparedBefore },
      },
    ],
  };
  const cursor = externalWorkCollection()
    .find(filter)
    .sort({ updatedAt: 1 })
    .limit(Math.max(1, Math.min(Number(limit) || 25, 100)));
  const rows = await cursor.toArray();
  let repaired = 0;
  let pending = 0;
  for (const row of rows) {
    if (row.launchState === 'prepared') {
      await markGlassHiveLaunchPreDispatchFailed(
        {
          originRef: normalizeText(row.originRef || row._id, 160),
          ownerId: normalizeText(row.ownerId, 160),
          required: row.required === true,
          schedulerDispatchDocumentId: normalizeText(row.schedulerDispatchDocumentId, 160),
          scheduleOccurrenceKey: normalizeText(row.scheduleOccurrenceKey, 160),
        },
        Object.assign(new Error('launch_preparation_lease_expired'), {
          code: 'launch_preparation_lease_expired',
        }),
      );
      repaired += 1;
      continue;
    }
    try {
      const snapshot = await requestAccountApi({
        ownerId: row.ownerId,
        path: `/v1/delegations/by-origin/${encodeURIComponent(row.originRef || row._id)}`,
        timeoutMs: 3000,
      });
      const workRef = normalizeText(snapshot?.workRef, 160);
      if (!workRef) {
        pending += 1;
        continue;
      }
      const now = new Date();
      const bindFilter = { _id: row._id, $or: [{ workRef: '' }, { workRef }] };
      const update = { $set: { workRef, launchState: 'accepted', updatedAt: now } };
      await callbackBindingCollection().updateOne(bindFilter, update);
      await externalWorkCollection().updateOne(bindFilter, update);
      repaired += 1;
    } catch (error) {
      if (Number(error?.status) === 404) {
        const expiresAt = row.dispatchExpiresAt
          ? new Date(row.dispatchExpiresAt)
          : new Date(new Date(row.updatedAt || 0).getTime() + launchDispatchAmbiguityLeaseMs());
        if (Number.isFinite(expiresAt.getTime()) && expiresAt <= now) {
          await markGlassHiveLaunchPreDispatchFailed(
            {
              originRef: normalizeText(row.originRef || row._id, 160),
              ownerId: normalizeText(row.ownerId, 160),
              required: row.required === true,
              schedulerDispatchDocumentId: normalizeText(row.schedulerDispatchDocumentId, 160),
              scheduleOccurrenceKey: normalizeText(row.scheduleOccurrenceKey, 160),
            },
            Object.assign(new Error('launch_dispatch_not_found'), {
              code: 'launch_dispatch_not_found',
            }),
          );
          repaired += 1;
        } else {
          pending += 1;
        }
        continue;
      }
      const attempts = Math.max(0, Number(row.reconciliationAttempts) || 0) + 1;
      const delayMs = Math.min(5 * 60 * 1000, 5_000 * 2 ** Math.min(attempts - 1, 6));
      const errorCode = normalizeText(error?.code || error?.name, 120) || 'reconciliation_failed';
      await externalWorkCollection().updateOne(
        {
          _id: row._id,
          workRef: '',
          launchState: row.launchState,
        },
        {
          $set: {
            reconciliationAttemptedAt: now,
            reconciliationNextAt: new Date(now.getTime() + delayMs),
            reconciliationErrorCode: errorCode,
          },
          $inc: { reconciliationAttempts: 1 },
        },
      );
      logger.warn('[VIVENTIUM][glasshive-binding] Launch reconciliation deferred', {
        errorCode,
        attempts,
      });
      pending += 1;
      continue;
    }
  }
  return { scanned: rows.length, repaired, pending };
}

async function recordGlassHiveCallbackExternalState({ binding, body = {} } = {}) {
  if (!binding?.ownerId) return null;
  const state = callbackWorkState(body);
  const workerId = normalizeText(body.worker_id);
  const runId = normalizeText(body.run_id);
  const originRef = normalizeText(binding.originRef || binding.bindingId, 160);
  const workRef = normalizeText(binding.workRef || body.work_ref, 160);
  const collection = externalWorkCollection();
  const work = originRef
    ? await collection.findOne({ _id: originRef, ownerId: binding.ownerId })
    : null;
  if (work && state) {
    const now = new Date();
    const update = {
      $set: {
        externalState: state,
        workerId,
        runId,
        workRef,
        launchState: 'callback_confirmed',
        updatedAt: now,
        ...(TERMINAL_STATES.includes(state) ? { terminalAt: now } : {}),
        ...(state
          ? {
              attentionPending: state === 'needs_input' || TERMINAL_STATES.includes(state),
              ...(TERMINAL_STATES.includes(state) ? { deliveryState: 'pending' } : {}),
            }
          : {}),
      },
    };
    const filter = { _id: work._id };
    if (!TERMINAL_STATES.includes(normalizeText(work.externalState, 32))) {
      filter.externalState = { $nin: TERMINAL_STATES };
    } else {
      delete update.$set.externalState;
      delete update.$set.terminalAt;
    }
    await collection.findOneAndUpdate(filter, update, { returnDocument: 'after' });
  }

  if (!binding.schedulerDispatchDocumentId && !binding.scheduleOccurrenceKey) {
    return null;
  }
  return getSchedulerExternalWorkSummary({
    ownerId: binding.ownerId,
    schedulerDispatchDocumentId: binding.schedulerDispatchDocumentId,
    scheduleOccurrenceKey: binding.scheduleOccurrenceKey,
  });
}

async function recordGlassHiveAdjudicationOutcome({
  originRef,
  state,
  followUpMessageId = '',
  errorCode = '',
} = {}) {
  const ref = normalizeText(originRef, 160);
  const normalizedState = normalizeText(state, 32);
  if (!ref || !['completed', 'silent', 'failed'].includes(normalizedState)) return null;
  const normalizedErrorCode = normalizeText(errorCode, 120);
  const unresolvedDelivery = normalizedErrorCode === 'mission_surface_delivery_unresolved';
  const now = new Date();
  const adjudicationFields = {
    adjudicationState: normalizedState,
    attentionPending: normalizedState === 'failed',
    followUpMessageId: normalizeText(followUpMessageId, 160),
    adjudicationErrorCode: normalizedErrorCode,
    adjudicatedAt: now,
    updatedAt: now,
  };
  const deliveryState =
    normalizedState === 'failed' ? (unresolvedDelivery ? 'unresolved' : 'failed') : 'enqueued';
  const collection = externalWorkCollection();
  const unsettledResult = await collection.findOneAndUpdate(
    { _id: ref, deliveryState: { $nin: SETTLED_DELIVERY_STATES } },
    {
      $set: {
        ...adjudicationFields,
        deliveryState,
      },
    },
    { returnDocument: 'after' },
  );
  const unsettledRow =
    unsettledResult && Object.prototype.hasOwnProperty.call(unsettledResult, 'value')
      ? unsettledResult.value
      : unsettledResult;
  if (unsettledRow) return unsettledRow;

  // Delivery is monotonic. A later adjudication pass may enrich mission metadata, but it must
  // never turn an already-sent/acknowledged/silent surface back into a pending delivery.
  const settledResult = await collection.findOneAndUpdate(
    { _id: ref },
    { $set: adjudicationFields },
    { returnDocument: 'after' },
  );
  return settledResult && Object.prototype.hasOwnProperty.call(settledResult, 'value')
    ? settledResult.value
    : settledResult || null;
}

async function recordGlassHiveSurfaceDeliveryOutcome({ originRef, state } = {}) {
  const ref = normalizeText(originRef, 160);
  const deliveryState = normalizeText(state, 32);
  if (!ref || !['enqueued', 'sent', 'failed', 'suppressed', 'unresolved'].includes(deliveryState)) {
    return null;
  }
  const result = await externalWorkCollection().findOneAndUpdate(
    { _id: ref },
    {
      $set: {
        deliveryState,
        attentionPending: ['failed', 'unresolved'].includes(deliveryState),
        deliveryUpdatedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
  return result?.value || result || null;
}

function schedulingExternalCallbackUrl() {
  const explicit = normalizeText(process.env.VIVENTIUM_SCHEDULING_EXTERNAL_WORK_CALLBACK_URL, 2048);
  if (explicit) return explicit;
  const base = normalizeText(process.env.SCHEDULING_MCP_URL, 2048);
  if (!base) return '';
  return `${base.replace(/\/mcp\/?$/, '').replace(/\/$/, '')}/internal/scheduled-prompts/external-work-callback`;
}

async function notifySchedulerExternalWorkSummary({ binding, summary } = {}) {
  if (!binding?.scheduleOccurrenceKey || !summary || summary.requiredTotal < 1) {
    return null;
  }
  const url = schedulingExternalCallbackUrl();
  const secret = normalizeText(
    process.env.VIVENTIUM_SCHEDULER_SECRET || process.env.SCHEDULER_LIBRECHAT_SECRET,
    4096,
  );
  if (!url || !secret) {
    throw new Error('scheduler_external_work_callback_unavailable');
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-VIVENTIUM-SCHEDULER-SECRET': secret,
    },
    body: JSON.stringify({
      occurrence_key: binding.scheduleOccurrenceKey,
      user_id: binding.ownerId,
      required_total: summary.requiredTotal,
      required_terminal: summary.requiredTerminal,
      required_failed: summary.requiredFailed,
      all_required_terminal: summary.allRequiredTerminal,
      state: summary.state,
    }),
  });
  if (!response.ok) {
    throw new Error(`scheduler_external_work_callback_http_${response.status}`);
  }
  return response.json().catch(() => ({}));
}

module.exports = {
  attachGlassHiveLaunchOrigin,
  attachGlassHiveTrustedLaunchMetadata,
  glassHiveLaunchOriginFromArguments,
  getSchedulerExternalWorkSummary,
  hasKnownExternalWork,
  launchDispatchAmbiguityLeaseMs,
  launchPreparationLeaseMs,
  markGlassHiveLaunchDispatchUnknown,
  markGlassHiveLaunchDispatchRejected,
  markGlassHiveLaunchDispatchReady,
  markGlassHiveLaunchPreDispatchFailed,
  notifySchedulerExternalWorkSummary,
  reconcileKnownExternalWorkHints,
  reconcileGlassHiveLaunchResult,
  reconcileUnknownGlassHiveLaunches,
  recordGlassHiveAdjudicationOutcome,
  recordGlassHiveSurfaceDeliveryOutcome,
  recordGlassHiveCallbackExternalState,
  isGlassHiveWorkTerminalCallback,
  registerGlassHiveLaunchContext,
  resolveTrustedGlassHiveCallIdentity,
  resolveGlassHiveCallbackContext,
};
