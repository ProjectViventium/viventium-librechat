'use strict';

/* === VIVENTIUM START ===
 * Feature: MainContextSnapshotV1.
 * Purpose: Admit one immutable, provider-neutral context manifest per logical turn and reuse its
 * digest across primary, fallback, retry, and Phase-B attempts.
 * === VIVENTIUM END === */

const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { promptFrameLoggingEnabled, logTurnContextRetention } = require('./promptFrameTelemetry');
const { buildActiveWorkCapsule } = require('./ViventiumDynamicTurnContext');
const { sanitizeVoiceAssistantMessageForPersistence } = require('./voiceArtifactText');
const { projectVisibleTextFromContentParts } = require('./ViventiumVisibleContentProjection');
const { Constants } = require('librechat-data-provider');
const {
  buildMainContinuityHeaders,
  encodeMainContextStateBlock,
  isContextOnlyMainHistory,
  normalizeMainContextStamp,
  ownedInteractionSources,
  prepareMainContinuityCarrier,
  NATIVE_MAIN_TURN_CONTEXT_MAX_BYTES,
  NATIVE_MAIN_TURN_CONTEXT_BODY_MAX_BYTES,
  MAIN_CONTINUITY_CONTEXT_BUDGET_HEADER,
  visibleMessageChain: buildMainContinuityMessageChain,
} = require('@librechat/api');
const {
  getTrustedAdapterCapabilities,
  getTrustedInteractionContext,
} = require('./interactionContext');
const {
  coerceTextToString,
  normalizeUserMessageContent,
  isRuntimeOnlyAssistantMessage,
  INTERNAL_CONTENT_TYPES,
} = require('./normalizeTextContentParts');

const SNAPSHOT_SLOT = '_viventiumMainContextSnapshotV1';
const LOCAL_ATTEMPT_STATE = Symbol('viventiumMainContextLocalAttemptStateV1');
const MAIN_ATTEMPT_FACTS_AUTHORITY = Symbol('viventiumMainAttemptFactsAuthorityV1');
const ROUTE_TOKEN_MAX_LENGTH = 80;
const ROUTE_LABEL_MAX_LENGTH = 80;
const ROUTE_PATH_MAX_LENGTH = 12;
// This is the public provider-protocol limit enforced by GlassHive. The chain is transport
// authority, so Core must admit it by encoded bytes rather than let a long conversation fail at
// the provider boundary.
const VISIBLE_MESSAGE_CHAIN_MAX_ENCODED_BYTES = 32 * 1024;
const TURN_CONTEXT_MAX_DECODED_BYTES = 16 * 1024;
const TURN_CONTEXT_MAX_ENCODED_BYTES = 32 * 1024;
const TURN_CONTEXT_SEPARATOR = '\n\n';
const TURN_CONTEXT_REQUIRED_SECTIONS = new Set([
  'feelings',
  'telegramReplyContext',
  'recurrenceState',
  // A reviewed conversation summary replaces carried source rows; it is never silently dropped.
  'conversationContinuity',
  'mainContinuity',
  'currentCall',
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined && typeof value[key] !== 'function')
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)), 'utf8')
    .digest('hex');
}

function freezeTree(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeTree(child);
  return Object.freeze(value);
}

function routeToken(value) {
  const token = String(value || '').trim();
  if (!token || token.length > ROUTE_TOKEN_MAX_LENGTH) return '';
  return /^[a-z0-9][a-z0-9._:-]*$/i.test(token) ? token : '';
}

function routePath(value) {
  if (!Array.isArray(value) || value.length > ROUTE_PATH_MAX_LENGTH) return [];
  const normalized = value.map(routeToken);
  return normalized.every(Boolean) ? normalized : [];
}

function routeLabel(value) {
  const label = String(value || '').trim();
  if (!label || label.length > ROUTE_LABEL_MAX_LENGTH) return '';
  return /^[\p{L}\p{N}][\p{L}\p{N} ._+:/()-]*$/u.test(label) ? label : '';
}

function routeTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const provider = routeToken(value.provider);
  const model = routeToken(value.model);
  const effort = routeToken(value.effort);
  const modelLabel = routeLabel(value.modelLabel);
  if (!provider && !model && !modelLabel && !effort) return null;
  return freezeTree({
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(modelLabel ? { modelLabel } : {}),
    ...(effort ? { effort } : {}),
  });
}

function snapshotFeelingsReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return freezeTree({ status: 'unavailable', reason: 'state_read_failed' });
  }
  if (value.status !== 'available') {
    const reason = routeToken(value.reason) || 'state_read_failed';
    return freezeTree({ status: 'unavailable', reason });
  }
  const snapshotSha256 = String(value.snapshotSha256 || '')
    .trim()
    .toLowerCase();
  const scope = ['all_agents', 'conscious_agent'].includes(value.scope) ? value.scope : 'unknown';
  const version = Number(value.version);
  if (!/^[a-f0-9]{64}$/.test(snapshotSha256) || !Number.isSafeInteger(version) || version < 0) {
    return freezeTree({ status: 'unavailable', reason: 'state_receipt_invalid' });
  }
  return freezeTree({
    status: 'available',
    enabled: value.enabled === true,
    scope,
    version,
    snapshotSha256,
  });
}

function mainRouteTargetForAgent(agent) {
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return null;
  return routeTarget({
    provider: agent.endpoint || agent.provider,
    model: agent.model || agent.model_parameters?.model,
    modelLabel: agent.modelLabel || agent.model_parameters?.modelLabel,
    effort:
      agent.effort ||
      agent.reasoning_effort ||
      agent.model_parameters?.reasoning_effort ||
      agent.model_parameters?.effort,
  });
}

function nativeHarnessRoute(model) {
  const normalizedModel = routeToken(model);
  const separator = normalizedModel.indexOf(':');
  if (separator <= 0 || separator >= normalizedModel.length - 1) return null;
  const provider = routeToken(normalizedModel.slice(0, separator));
  const nativeModel = routeToken(normalizedModel.slice(separator + 1));
  if (!provider || !nativeModel) return null;
  const hop = {
    'claude-code': 'claude',
    'codex-cli': 'codex',
    'openclaw-general': 'openclaw',
  }[provider];
  return { provider, model: nativeModel, hop: hop || provider };
}

function buildMainAttemptFactsForAgent({
  snapshot,
  agent,
  attemptNumber,
  isFallback = false,
  fallbackReason = '',
} = {}) {
  const configured = mainRouteTargetForAgent(agent) || {};
  const surface = routeToken(snapshot?.routeFacts?.surface) || 'web';
  const outerProvider = routeToken(configured.provider);
  const harnessRoute =
    outerProvider === 'glasshive-harness' ? nativeHarnessRoute(configured.model) : null;
  return createMainAttemptFacts({
    snapshot,
    attemptNumber: attemptNumber || (isFallback ? 2 : 1),
    executionPath: harnessRoute
      ? [surface, 'librechat', 'glasshive', harnessRoute.hop]
      : [surface, 'librechat', outerProvider].filter(Boolean),
    provider: harnessRoute?.provider || outerProvider,
    model: harnessRoute?.model || configured.model,
    modelLabel: configured.modelLabel,
    effort: configured.effort,
    isFallback,
    fallbackReason,
  });
}

function snapshotRouteFacts(interaction, value) {
  const surface = routeToken(interaction?.surface) || 'web';
  const configuredPath = routePath(value?.configuredPath);
  const primary = routeTarget(value?.primary);
  const fallback = routeTarget(value?.fallback);
  return freezeTree({
    surface,
    ...(configuredPath.length ? { configuredPath } : {}),
    ...(primary ? { primary } : {}),
    ...(fallback ? { fallback } : {}),
  });
}

function createMainAttemptFacts({
  snapshot,
  attemptNumber,
  executionPath,
  provider,
  model,
  modelLabel,
  effort,
  isFallback,
  fallbackReason,
} = {}) {
  if (!snapshot || !/^[a-f0-9]{64}$/.test(String(snapshot.snapshotSha256 || ''))) return null;
  const normalizedAttempt = Math.max(1, Math.floor(Number(attemptNumber) || 1));
  const normalizedPath = routePath(executionPath);
  const normalizedProvider = routeToken(provider);
  const normalizedModel = routeToken(model);
  const normalizedModelLabel = routeLabel(modelLabel);
  const normalizedEffort = routeToken(effort);
  const normalizedFallbackReason = routeToken(fallbackReason);
  const fallback = isFallback === true || Boolean(normalizedFallbackReason);
  const attemptedRoute = freezeTree({
    executionPath: normalizedPath,
    ...(normalizedProvider ? { provider: normalizedProvider } : {}),
    ...(normalizedModel ? { model: normalizedModel } : {}),
    ...(normalizedModelLabel ? { modelLabel: normalizedModelLabel } : {}),
    ...(normalizedEffort ? { effort: normalizedEffort } : {}),
  });
  const facts = {
    version: 1,
    snapshotSha256: snapshot.snapshotSha256,
    logicalTurnId: String(snapshot.logicalTurnId || ''),
    revision: Math.max(1, Math.floor(Number(snapshot.revision) || 1)),
    surface: routeToken(snapshot.routeFacts?.surface) || 'web',
    attemptNumber: normalizedAttempt,
    executionPath: normalizedPath,
    ...(normalizedProvider ? { provider: normalizedProvider } : {}),
    ...(normalizedModel ? { model: normalizedModel } : {}),
    ...(normalizedModelLabel ? { selectedModelLabel: normalizedModelLabel } : {}),
    ...(normalizedEffort ? { effort: normalizedEffort } : {}),
    ...(snapshot.routeFacts?.primary
      ? { configuredPrimary: freezeTree(canonical(snapshot.routeFacts.primary)) }
      : {}),
    ...(snapshot.routeFacts?.fallback
      ? { configuredFallback: freezeTree(canonical(snapshot.routeFacts.fallback)) }
      : {}),
    attemptedRoute,
    winningRoute: attemptedRoute,
    isFallback: fallback,
    ...(snapshot.feelingsReceipt ? { feelingsReceipt: snapshot.feelingsReceipt } : {}),
    ...(normalizedFallbackReason ? { fallbackReason: normalizedFallbackReason } : {}),
  };
  Object.defineProperty(facts, MAIN_ATTEMPT_FACTS_AUTHORITY, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return freezeTree(facts);
}

function renderMainAttemptFactsAuthorityBlock(facts) {
  if (
    !facts ||
    facts[MAIN_ATTEMPT_FACTS_AUTHORITY] !== true ||
    facts.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(facts.snapshotSha256)
  ) {
    return '';
  }
  return [
    '<viventium_main_attempt_facts_v1>',
    'Trusted current-attempt execution facts. Use them for channel, route, model, effort, fallback, and Feelings-state questions. If feelingsReceipt is unavailable, say the verified state is unavailable; do not invent one.',
    JSON.stringify(canonical(facts)),
    '</viventium_main_attempt_facts_v1>',
  ].join('\n');
}

/** Reserve the existing primary/fallback authority serializer before the final snapshot exists. */
function mainAttemptFactsAuthorityReserveBytes(req, agent) {
  const interaction = getTrustedInteractionContext(req) || {};
  const fallback = agent?.viventiumFallbackLlm || agent?.viventiumFallbackLlmAssignment;
  const snapshot = {
    snapshotSha256: '0'.repeat(64),
    logicalTurnId: String(interaction.logical_turn_id || ''),
    revision: Number(interaction.revision || 1),
    routeFacts: {
      surface: interaction.surface || 'web',
      primary: mainRouteTargetForAgent(agent),
      fallback: mainRouteTargetForAgent(fallback),
    },
  };
  const receipts = [
    {
      status: 'available',
      enabled: false,
      scope: 'conscious_agent',
      version: Number.MAX_SAFE_INTEGER,
      snapshotSha256: '0'.repeat(64),
    },
    { status: 'unavailable', reason: 'x'.repeat(ROUTE_TOKEN_MAX_LENGTH) },
  ];
  return Math.max(
    ...[agent, fallback || agent].flatMap((route) =>
      receipts.map((feelingsReceipt) =>
        Buffer.byteLength(
          renderMainAttemptFactsAuthorityBlock(
            buildMainAttemptFactsForAgent({
              snapshot: { ...snapshot, feelingsReceipt },
              agent: route,
              attemptNumber: Number.MAX_SAFE_INTEGER,
              isFallback: true,
              fallbackReason: 'x'.repeat(ROUTE_TOKEN_MAX_LENGTH),
            }),
          ),
          'utf8',
        ),
      ),
    ),
  );
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (['text', 'input_text', 'output_text'].includes(part.type)) {
        return coerceTextToString(part.text ?? part.input_text ?? part.output_text);
      }
      const text = coerceTextToString(part.text ?? part.input_text);
      if (text) return text;
      // Typed media payloads carry bytes, not authored prose. This text projection leaves those
      // payloads intact; an unknown content type still cannot silently disappear.
      if (
        [
          'image_url',
          'image',
          'input_image',
          'file',
          'input_file',
          'document',
          'media',
          'audio',
          'input_audio',
          'video',
        ].includes(part.type)
      )
        return '';
      return String(part.type || '');
    })
    .filter(Boolean)
    .join('\n');
}

function prependMainHistoryFileContext(content, fileContext) {
  if (typeof fileContext !== 'string' || !fileContext) return content;
  if (typeof content === 'string') return fileContext + '\n' + content;
  if (!Array.isArray(content)) return content;
  const next = content.slice();
  const index = next.findIndex((part) => part && typeof part === 'object' && part.type === 'text');
  if (index < 0) next.unshift({ type: 'text', text: fileContext });
  else
    next[index] = {
      ...next[index],
      text: fileContext + '\n' + coerceTextToString(next[index].text),
    };
  return next;
}

function messageContentText(message, includeFileContext = false) {
  const normalized = normalizeUserMessageContent(message);
  const content = normalized?.content ?? normalized?.text;
  // Match the provider formatter's existing exclusion of delivery/status parts.
  const visibleContent = Array.isArray(content)
    ? content.filter((part) => part != null && !INTERNAL_CONTENT_TYPES.has(part?.type))
    : content;
  return contentText(
    includeFileContext
      ? prependMainHistoryFileContext(visibleContent, message?.fileContext)
      : visibleContent,
  );
}

// Reuse the provider formatter for typed tool history. Its output keeps tool results and
// preserves undeclared calls as evidence text; literal content-type labels are not prose.
function formattedToolHistoryCarriers(messages, agent) {
  const sources = (messages || []).filter(
    (message) =>
      message?.isCreatedByUser === false &&
      Array.isArray(message.content) &&
      message.content.some((part) => part?.type === 'tool_call'),
  );
  if (!sources.length) return new Map();
  for (const source of sources) {
    for (const part of source.content) {
      if (part?.type === 'tool_call') {
        if (
          typeof part.tool_call?.id !== 'string' ||
          !part.tool_call.id.trim() ||
          typeof part.tool_call?.name !== 'string' ||
          !part.tool_call.name.trim()
        )
          throw unreconciledSourceError();
      } else if (
        part &&
        !INTERNAL_CONTENT_TYPES.has(part.type) &&
        !['text', 'input_text', 'output_text'].includes(part.type) &&
        contentText([part])
      ) {
        throw unreconciledSourceError();
      }
    }
  }
  const { formatAgentMessages } = require('@librechat/agents');
  const payload = sources.map((source) => {
    const normalized = normalizeUserMessageContent(source);
    const content = normalized?.content ?? normalized?.text;
    return {
      messageId: source.messageId,
      role: String(source.role || (source.isCreatedByUser === true ? 'user' : 'assistant')),
      content: canonical(
        Array.isArray(content)
          ? content.filter((part) => part != null && !INTERNAL_CONTENT_TYPES.has(part.type))
          : content,
      ),
    };
  });
  const formatted = formatAgentMessages(
    payload,
    undefined,
    new Set((agent?.tools || []).map((tool) => tool && tool.name)),
  ).messages;
  return new Map(
    sources.map((source) => {
      const carrier = formatted.filter((message) => message.id === source.messageId);
      const authored = carrier.filter(
        (message) => message.role === 'assistant' && messageContentText(message),
      );
      // The digest-only Native chain binds one complete authored message per source row.
      // A split authored answer must keep its existing fail-closed admission boundary.
      if (!carrier.length || authored.length > 1) throw unreconciledSourceError();
      return [
        source,
        { messages: carrier, text: authored.length ? messageContentText(authored[0]) : '' },
      ];
    }),
  );
}

function toolHistoryMessageDigest(message) {
  const role = String(message?.role || message?._getType?.() || '').toLowerCase();
  return digest({
    role: role === 'ai' ? 'assistant' : role === 'human' ? 'user' : role,
    text: messageContentText(message),
    toolCalls: message.tool_calls || [],
    toolCallId: message.tool_call_id || '',
    name: message.name || '',
  });
}

function isInterruptedMainCarrier(message) {
  const role = String(message?.role || (message?.isCreatedByUser === true ? 'user' : 'assistant'));
  return (
    role.toLowerCase() === 'assistant' &&
    message?.isCreatedByUser === false &&
    message?.unfinished === true
  );
}

function isContextOnlyMainCarrier(message) {
  return isContextOnlyMainHistory(message) || isInterruptedMainCarrier(message);
}

function isBlankContextOnlyMainCarrier(message, text) {
  return (
    message?.isCreatedByUser === false &&
    isContextOnlyMainCarrier(message) &&
    !text.trim() &&
    !message?.files?.length &&
    !message?.attachments?.length &&
    !message?.image_urls?.length &&
    (!Array.isArray(message?.content) ||
      message.content.every(
        (part) =>
          part == null ||
          INTERNAL_CONTENT_TYPES.has(part.type) ||
          ['text', 'input_text', 'output_text'].includes(part.type),
      ))
  );
}

function isAttachmentOnlyMainTextCarrier(message, text) {
  const references = [message?.files, message?.attachments];
  const attachments = references.flatMap((value) => (Array.isArray(value) ? value : []));
  return (
    message?.isCreatedByUser === true &&
    message?.error !== true &&
    message?.unfinished !== true &&
    text.length === 0 &&
    references.every((value) => value == null || Array.isArray(value)) &&
    attachments.length > 0 &&
    attachments.every((attachment) => {
      const type = String(attachment?.type || '').toLowerCase();
      return (
        attachment &&
        typeof attachment === 'object' &&
        typeof attachment.file_id === 'string' &&
        attachment.file_id.trim() &&
        !['image/', 'audio/', 'video/'].some((prefix) => type.startsWith(prefix))
      );
    }) &&
    [message.image_urls, message.documents, message.audios, message.videos].every(
      (value) => value == null || (Array.isArray(value) && value.length === 0),
    ) &&
    (!Array.isArray(message.content) ||
      message.content.every(
        (part) => part == null || ['text', 'input_text', 'output_text'].includes(part.type),
      ))
  );
}

function messageManifest(messages = []) {
  return (Array.isArray(messages) ? messages : []).map((message, index) => {
    const text = messageContentText(message);
    return Object.freeze({
      index,
      role: String(message?.role || 'unknown'),
      bytes: Buffer.byteLength(text, 'utf8'),
      sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    });
  });
}

function unreconciledSourceError() {
  const error = new Error('Prior accepted Main history cannot be carried intact.');
  Error.captureStackTrace?.(error, unreconciledSourceError);
  error.code = 'source_context_unavailable';
  error.status = 413;
  return error;
}

/* === VIVENTIUM START ===
 * Feature: Scheduling is Main later.
 * Purpose: Trusted scheduler control envelopes and hidden scheduler outputs are transport and
 * audit metadata, never user-visible source (CC-035), so a trusted scheduler wake does not replay
 * them. Every visible prior answer remains source under the protected-history guard: the wake
 * carries it faithfully or fails typed when it cannot be carried.
 * === VIVENTIUM END === */
function isTrustedSchedulerWake(req) {
  const context = getTrustedInteractionContext(req);
  return context?.actor_kind === 'system' && context?.origin === 'scheduler';
}

function isSchedulerTransportRow(message) {
  const viventium = message?.metadata?.viventium;
  if (viventium?.visibility !== 'internal') return false;
  if (message?.isCreatedByUser === true) {
    const context = viventium?.interactionContext;
    return context?.actor_kind === 'system' && context?.origin === 'scheduler';
  }
  return message?.isCreatedByUser === false;
}

function hasCoreMainContextStamp(message) {
  // The Message owner now stores the captured authored identity rather than a duplicate
  // snapshot. Reuse that owner's validator; older complete stamps retain the same identity.
  return normalizeMainContextStamp(message?.metadata?.viventium?.mainContext) !== undefined;
}

function recoverRetainedTelegramHistory(messages, ownerId, conversationId) {
  const rows = new Map(messages.map((message) => [String(message.messageId || ''), message]));
  return messages.map((message) => {
    const input = message?.metadata?.viventium?.telegramInput;
    const context = message?.metadata?.viventium?.interactionContext;
    if (
      message.isCreatedByUser !== true ||
      String(message.user || '') !== String(ownerId) ||
      message.conversationId !== conversationId ||
      message.deletedAt != null ||
      !['ready', 'admitted'].includes(input?.state) ||
      !/^[a-f0-9]{64}$/.test(String(input?.sourceEventId || '')) ||
      context?.source_event_id !== input.sourceEventId ||
      context?.surface !== 'telegram' ||
      context?.actor_kind !== 'external_user'
    )
      return message;
    const original = input.originalParentMessageId;
    const current = rows.get(message.parentMessageId);
    if (current && current.parentMessageId !== message.messageId) return message;
    if (message.parentMessageId === Constants.NO_PARENT) return message;
    const anchor = rows.get(original);
    if (
      original !== Constants.NO_PARENT &&
      (!anchor ||
        anchor.messageId === message.messageId ||
        String(anchor.user || '') !== String(ownerId) ||
        anchor.conversationId !== conversationId ||
        anchor.deletedAt != null ||
        anchor.parentMessageId === message.messageId)
    )
      return message;
    return { ...message, parentMessageId: original };
  });
}

function traceMainHistoryAncestry({
  messages,
  headId,
  ownerId = '',
  conversationId = '',
  isSkippable,
} = {}) {
  const rows = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const id = String(message?.messageId || '');
    if (!id) continue;
    if (rows.has(id)) rows.set(id, null);
    else rows.set(id, message);
  }
  const selected = [];
  const selectedRows = [];
  const skipped = [];
  const seen = new Set();
  const head = String(headId || '');
  let cursor = head;
  while (cursor && cursor !== Constants.NO_PARENT) {
    if (seen.has(cursor)) return Object.freeze({ complete: false, reason: 'cycle' });
    seen.add(cursor);
    const message = rows.get(cursor);
    if (!message) return Object.freeze({ complete: false, reason: 'missing_or_duplicate' });
    if (ownerId && String(message.user || '') !== String(ownerId))
      return Object.freeze({ complete: false, reason: 'foreign_owner' });
    if (conversationId && String(message.conversationId || '') !== String(conversationId))
      return Object.freeze({ complete: false, reason: 'foreign_conversation' });
    selected.push(cursor);
    selectedRows.push(message);
    if (isSkippable?.(message) || isRuntimeOnlyAssistantMessage(message)) skipped.push(cursor);
    cursor = String(message.parentMessageId || '');
  }
  return Object.freeze({
    complete: true,
    ownerId: String(ownerId || ''),
    conversationId: String(conversationId || ''),
    headId: head,
    messageIds: Object.freeze(selected.reverse()),
    parentLinks: Object.freeze(
      selectedRows.map((message) =>
        Object.freeze({
          id: String(message.messageId),
          parentId: String(message.parentMessageId || ''),
        }),
      ),
    ),
    skippedMessageIds: Object.freeze(skipped),
    hasUnreconciledSource:
      selectedRows.some(
        (message) =>
          message.isCreatedByUser === false &&
          !isContextOnlyMainHistory(message) &&
          !hasCoreMainContextStamp(message),
      ) ||
      (selectedRows.every((message) => message.isCreatedByUser !== false) &&
        selectedRows.some((message) => !isContextOnlyMainHistory(message))),
  });
}

function assertMainHistoryAncestry(ownerId, conversationId, visibleMessages, proof, protect) {
  if (proof?.complete === false) throw unreconciledSourceError();
  const visible = (Array.isArray(visibleMessages) ? visibleMessages : []).filter(
    (message) =>
      message?.messageId &&
      !['system', 'developer'].includes(String(message?.role || '').toLowerCase()),
  );
  if (!visible.length) {
    if (protect) throw unreconciledSourceError();
    return;
  }
  if (proof?.complete === true) {
    if (
      (proof.ownerId && proof.ownerId !== ownerId) ||
      (proof.conversationId && proof.conversationId !== conversationId)
    )
      throw unreconciledSourceError();
    if (protect) {
      if (
        !Array.isArray(proof.messageIds) ||
        !Array.isArray(proof.skippedMessageIds) ||
        !Array.isArray(proof.parentLinks)
      )
        throw unreconciledSourceError();
      const visibleById = new Map(visible.map((message) => [String(message.messageId), message]));
      const accounted = new Set([
        ...visibleById.keys(),
        ...proof.skippedMessageIds,
        // Rows replaced by an exact reviewed conversation summary are reconciled, not missing.
        ...(Array.isArray(proof.reconciledMessageIds) ? proof.reconciledMessageIds : []),
      ]);
      if (!proof.messageIds.every((id) => accounted.has(id))) throw unreconciledSourceError();
      const selectedIds = new Set(proof.messageIds);
      if (visible.slice(0, -1).some((message) => !selectedIds.has(String(message.messageId))))
        throw unreconciledSourceError();
      if (
        proof.parentLinks.some(
          ({ id, parentId }) =>
            visibleById.has(id) && String(visibleById.get(id).parentMessageId || '') !== parentId,
        )
      )
        throw unreconciledSourceError();
    }
    return;
  }
  // Without a raw-history proof, only history being carried as accepted Main context must be a
  // complete chain; an ordinary snapshot may hold just the current turn.
  if (!protect) return;
  const result = traceMainHistoryAncestry({
    messages: visible,
    headId: visible.at(-1).messageId,
  });
  if (!result.complete) throw unreconciledSourceError();
}

/* === VIVENTIUM START ===
 * Feature: Conversation legacy continuity in the ancestry proof.
 * Purpose: Rows covered by an exact reviewed conversation summary are accounted as reconciled
 * source; only the intact carried tail decides whether unreconciled answers remain.
 * === VIVENTIUM END === */
function withReconciledHistoryAncestry(proof, reconciledMessageIds, carriedMessages) {
  if (!proof || proof.complete !== true || !Array.isArray(reconciledMessageIds)) return proof;
  const carried = Array.isArray(carriedMessages) ? carriedMessages : [];
  return Object.freeze({
    ...proof,
    reconciledMessageIds: Object.freeze(reconciledMessageIds.map(String)),
    hasUnreconciledSource: carried.some(
      (message) =>
        message?.isCreatedByUser === false &&
        message?.metadata?.viventium?.visibility !== 'internal' &&
        !isContextOnlyMainHistory(message) &&
        !hasCoreMainContextStamp(message),
    ),
  });
}

function hasUnreconciledMainHistory(messages) {
  if (!Array.isArray(messages)) return false;
  const prior = messages.slice(0, -1).filter((message) => {
    const role = String(
      message?.role || (message?.isCreatedByUser === true ? 'user' : 'assistant'),
    ).toLowerCase();
    return (
      message?.messageId &&
      !['system', 'developer'].includes(role) &&
      !isContextOnlyMainHistory(message)
    );
  });
  const answers = prior.filter(
    (message) =>
      String(
        message?.role || (message?.isCreatedByUser === true ? 'user' : 'assistant'),
      ).toLowerCase() === 'assistant',
  );
  // Core stamps accepted answers, not the user rows that led to them.
  const candidates = answers.length ? answers : prior;
  return candidates.some((message) => !hasCoreMainContextStamp(message));
}

function boundVisibleMessageChain(chain, protectUnreconciledHistory, nativeBodyCarrier = false) {
  if (nativeBodyCarrier) return chain;
  while (
    chain.length > 1 &&
    Buffer.byteLength(Buffer.from(JSON.stringify(chain), 'utf8').toString('base64'), 'utf8') >
      VISIBLE_MESSAGE_CHAIN_MAX_ENCODED_BYTES
  ) {
    const oldest = chain[0];
    if (
      protectUnreconciledHistory ||
      oldest.accepted_source === true ||
      oldest.current_input === true ||
      oldest.delivery
    ) {
      throw unreconciledSourceError();
    }
    chain.shift();
  }
  if (
    Buffer.byteLength(Buffer.from(JSON.stringify(chain)).toString('base64')) >
    VISIBLE_MESSAGE_CHAIN_MAX_ENCODED_BYTES
  ) {
    throw unreconciledSourceError();
  }
  return chain;
}

function visibleMessageChain(
  messages = [],
  protectUnreconciledHistory = false,
  toolCarriers = new Map(),
  nativeBodyCarrier = false,
) {
  const source = (Array.isArray(messages) ? messages : [])
    .filter((message) => {
      const role = String(
        message?.role || (message?.isCreatedByUser === true ? 'user' : 'assistant'),
      ).toLowerCase();
      return message?.messageId && role !== 'system' && role !== 'developer';
    })
    .map((message, index, visible) => {
      const text =
        toolCarriers.get(message)?.text ?? messageContentText(message, index < visible.length - 1);
      return Object.freeze({
        id: String(message.messageId).slice(0, 160),
        parentId: String(message.parentMessageId || '').slice(0, 160),
        role: String(
          message.role || (message.isCreatedByUser === true ? 'user' : 'assistant'),
        ).slice(0, 24),
        bytes: Buffer.byteLength(text, 'utf8'),
        sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
        ...((protectUnreconciledHistory || isInterruptedMainCarrier(message)) &&
        index < visible.length - 1
          ? { accepted_source: !isContextOnlyMainCarrier(message) }
          : {}),
      });
    });
  const originalIds = (Array.isArray(messages) ? messages : [])
    .filter(
      (message) =>
        message?.messageId &&
        !['system', 'developer'].includes(String(message?.role || '').toLowerCase()),
    )
    .map((message) => String(message.messageId));
  if (
    protectUnreconciledHistory &&
    ((!nativeBodyCarrier && source.length > 128) ||
      (source.length > 1 && source.at(-1)?.role !== 'user') ||
      originalIds.some((id) => id.length > 160) ||
      (Array.isArray(messages) ? messages : []).some(
        (message) => String(message?.parentMessageId || '').length > 160,
      ) ||
      new Set(originalIds).size !== originalIds.length)
  ) {
    throw unreconciledSourceError();
  }
  return boundVisibleMessageChain(
    nativeBodyCarrier ? source : source.slice(-128),
    protectUnreconciledHistory,
    nativeBodyCarrier,
  );
}

function assertUnreconciledHistoryCarrier(
  ownerId,
  conversationId,
  visibleMessages,
  finalMessages,
  chain,
  toolCarriers,
  omittedContextIds,
  sourceIds,
) {
  if (chain.length < 2) return [];
  const originals = visibleMessages.filter(
    (message) =>
      message?.messageId &&
      !['system', 'developer'].includes(String(message.role || '').toLowerCase()),
  );
  const final = Array.isArray(finalMessages) ? finalMessages : [];
  const matchedCarriers = [];
  let position = 0;
  for (let index = 0; index < chain.length - 1; index += 1) {
    const source = originals[index];
    const expected = chain[index];
    if (sourceIds && !sourceIds.has(expected.id)) continue;
    const sourceText = toolCarriers.get(source)?.text ?? messageContentText(source, true);
    if (
      String(source?.user || '') !== ownerId ||
      String(source?.conversationId || '') !== conversationId ||
      source?.deletedAt != null ||
      (source?.error === true && !isContextOnlyMainHistory(source)) ||
      (source?.unfinished != null && typeof source.unfinished !== 'boolean') ||
      (source?.unfinished === true && !isInterruptedMainCarrier(source)) ||
      source?.metadata?.viventium?.visibility === 'internal' ||
      (typeof source?.text === 'string' &&
        source.text.trim() &&
        !sourceText.includes(source.text.trim()) &&
        !(
          source?.isCreatedByUser === false &&
          source.text === projectVisibleTextFromContentParts(source.content, { trim: true })
        ) &&
        !(
          source?.isCreatedByUser === false &&
          source?.metadata?.viventium?.interactionContext?.surface === 'voice' &&
          source?.metadata?.viventium?.inputMode === 'voice_call' &&
          typeof source?.metadata?.viventium?.callSessionId === 'string' &&
          source.metadata.viventium.callSessionId.trim() &&
          // Only reconcile a supplemental display mismatch; preserve the exact carrier.
          source.text ===
            sanitizeVoiceAssistantMessageForPersistence(
              { body: { voiceMode: true } },
              { ...source, text: '' },
            ).text
        )) ||
      (expected.role === 'user' && source?.isCreatedByUser !== true) ||
      (expected.role === 'assistant' && source?.isCreatedByUser !== false) ||
      !['user', 'assistant'].includes(expected.role)
    )
      throw unreconciledSourceError();
    const toolCarrier = toolCarriers.get(source);
    if (toolCarrier) {
      const signatures = toolCarrier.messages.map(toolHistoryMessageDigest);
      const callIds = new Set(
        toolCarrier.messages
          .flatMap((message) => [
            ...(message.tool_calls || []).map((call) => call.id),
            message.tool_call_id,
          ])
          .filter(Boolean),
      );
      const belongsToCarrier = (message) =>
        callIds.has(message.tool_call_id) ||
        (message.tool_calls || []).some((call) => callIds.has(call.id));
      if (
        digest(final.filter(belongsToCarrier).map(toolHistoryMessageDigest)) !==
        digest(toolCarrier.messages.filter(belongsToCarrier).map(toolHistoryMessageDigest))
      )
        throw unreconciledSourceError();
      const matched = final.findIndex(
        (_, candidate) =>
          candidate >= position &&
          signatures.every(
            (signature, offset) =>
              final[candidate + offset] &&
              toolHistoryMessageDigest(final[candidate + offset]) === signature,
          ),
      );
      if (matched < 0) throw unreconciledSourceError();
      matchedCarriers.push({
        sourceMessage: source,
        source: toolCarrier,
        messages: final.slice(matched, matched + signatures.length),
      });
      position = matched + signatures.length;
      continue;
    }
    // Blank answers and attachment-only user text remain in the owned ancestry. The existing
    // attachment lane carries the original file; media and authored words cannot disappear.
    if (
      isBlankContextOnlyMainCarrier(source, sourceText) ||
      isAttachmentOnlyMainTextCarrier(source, sourceText)
    ) {
      if (
        !final.some((message) => String(message?.messageId || message?.id || '') === expected.id)
      ) {
        omittedContextIds.add(expected.id);
      }
      continue;
    }
    const matched = final.findIndex((message, candidate) => {
      const role = String(message?.role || message?._getType?.() || '').toLowerCase();
      const normalizedRole = role === 'human' ? 'user' : role === 'ai' ? 'assistant' : role;
      const text = messageContentText(message);
      // Provider formatting removes Mongo message IDs. Match the complete ordered text and
      // role sequence here; the source rows themselves are checked against the owner and branch.
      return (
        candidate >= position &&
        normalizedRole === expected.role &&
        crypto.createHash('sha256').update(text, 'utf8').digest('hex') === expected.sha256
      );
    });
    if (matched < 0) throw unreconciledSourceError();
    matchedCarriers.push({ sourceMessage: source, messages: [final[matched]] });
    position = matched + 1;
  }
  const current = chain.at(-1);
  const currentIndex = final.findIndex((message, index) => {
    const role = String(message?.role || message?._getType?.() || '').toLowerCase();
    const text = messageContentText(message);
    return (
      index >= position &&
      (role === 'human' ? 'user' : role) === 'user' &&
      crypto.createHash('sha256').update(text, 'utf8').digest('hex') === current.sha256
    );
  });
  if (currentIndex < 0) throw unreconciledSourceError();
  matchedCarriers.push({ sourceMessage: originals.at(-1), messages: [final[currentIndex]] });
  return matchedCarriers;
}

function stableAuthorityDigest(agent) {
  const headers = agent?.model_parameters?.configuration?.defaultHeaders;
  const declared = String(headers?.['X-GlassHive-Stable-Authority-SHA256'] || '').trim();
  return /^[a-f0-9]{64}$/.test(declared)
    ? declared
    : digest({
        instructions: String(agent?.instructions || ''),
        tools: agent?.tools || [],
        mcp: agent?.mcp || [],
      });
}

/** Conservative positive-only shortcut; false is not a Native rejection or a whole-history size limit. */
function mainHistoryFitsNativeBody(
  messages,
  agent,
  reservedContextUtf8Bytes = 0,
  nativeReplayBudget = null,
  sourceMetadataBytes = 0,
  sizingReceipt = null,
) {
  if (
    !Array.isArray(messages) ||
    !Number.isFinite(reservedContextUtf8Bytes) ||
    reservedContextUtf8Bytes < 0
  )
    return false;
  try {
    const path = require('node:path');
    const { _convertMessagesToOpenAIParams } = require(
      path.join(path.dirname(require.resolve('@librechat/agents')), 'llm/openai/utils/index.cjs'),
    );
    if (typeof _convertMessagesToOpenAIParams !== 'function') return false;
    const selected = prepareMainContinuityCarrier(messages, agent?.useLegacyContent === true);
    const wire = _convertMessagesToOpenAIParams(selected, String(agent?.model || ''));
    if (nativeReplayBudget !== null) {
      const remaining = require('@librechat/api').nativeConversationContextBudget(
        wire,
        nativeReplayBudget,
        sourceMetadataBytes,
      );
      if (sizingReceipt && remaining !== null) sizingReceipt.contextBudgetBytes = remaining;
      return require('@librechat/api').nativeConversationHistoryFits(
        wire,
        nativeReplayBudget,
        reservedContextUtf8Bytes,
        sourceMetadataBytes,
      );
    }
    const instruction = {
      role: 'system',
      content: [agent?.instructions, agent?.additional_instructions]
        .filter(Boolean)
        .join('\n')
        .trim(),
    };
    return (
      Buffer.byteLength(JSON.stringify([instruction, ...wire]), 'utf8') +
        reservedContextUtf8Bytes <=
      NATIVE_MAIN_TURN_CONTEXT_MAX_BYTES
    );
  } catch {
    return false;
  }
}

function buildInheritedConversationContext({
  conversationId,
  messages = [],
  sections = {},
  messageChain = [],
  sourceSegments = [],
}) {
  const chain = new Map(messageChain.map((row) => [String(row.id), row]));
  const sourceFactsFor = (id) => {
    const ordinals = [];
    let receivedAt;
    let receiptConsistent = true;
    sourceSegments.forEach((source, index) => {
      if (String(source.source_message_id || '') !== id) return;
      ordinals.push(index + 1);
      const receipt = source.source_received_at;
      if (
        !Number.isSafeInteger(receipt) ||
        receipt <= 0 ||
        (receivedAt !== undefined && receivedAt !== receipt)
      ) {
        receiptConsistent = false;
      } else {
        receivedAt = receipt;
      }
    });
    return { ordinals, receivedAt: receiptConsistent ? receivedAt : undefined };
  };
  return {
    version: 1,
    conversation_id: conversationId,
    sources: [
      ...(Array.isArray(messages) ? messages : []).map((message, index) => {
        const id = String(message.id || message.messageId || index);
        const row = chain.get(id);
        const sourceFacts = sourceFactsFor(id);
        const sourceOrdinals = Array.isArray(row?.source_ordinals)
          ? row.source_ordinals
          : sourceFacts.ordinals;
        return {
          id: `message:${id}`,
          role: String(
            message.role ||
              message._getType?.() ||
              (message.isCreatedByUser === false ? 'assistant' : 'user'),
          ),
          text: messageContentText(message, true),
          current_input: row?.current_input === true || sourceOrdinals.length > 0,
          source_ordinals: sourceOrdinals,
          ...(sourceFacts.receivedAt !== undefined
            ? { source_received_at: sourceFacts.receivedAt }
            : {}),
          ...(message.tool_calls?.length ? { tool_calls: canonical(message.tool_calls) } : {}),
          ...(message.tool_call_id ? { tool_call_id: String(message.tool_call_id) } : {}),
        };
      }),
      ...Object.entries(sections).flatMap(([key, value]) =>
        typeof value === 'string' && value
          ? [
              {
                id: `context:${key}`,
                role: 'context',
                text: value,
                current_input: key === 'currentFollowUp',
                source_ordinals: key === 'currentFollowUp' ? [1] : [],
              },
            ]
          : [],
      ),
    ],
  };
}

// Main and worker consumers share this raw carrier; no model-authored summary is introduced.
function prependInheritedConversationPayload(payload, context) {
  if (!context || context.version !== 1 || !Array.isArray(context.sources)) return payload;
  const inherited = context.sources.map((source) => ({
    role: source.role === 'context' ? 'system' : source.role,
    content: source.text,
    messageId: `inherited:${context.conversation_id}:${source.id}`,
    ...(source.tool_calls?.length ? { tool_calls: source.tool_calls } : {}),
    ...(source.tool_call_id ? { tool_call_id: source.tool_call_id } : {}),
  }));
  return [...inherited, ...payload];
}

function assignInheritedConversationContext(context, sourceOrdinals = []) {
  if (!context || context.version !== 1 || !Array.isArray(context.sources)) return context;
  const selected = new Set(sourceOrdinals);
  return {
    ...context,
    assigned_source_ordinals: [...selected],
    sources: context.sources.map((source) => ({
      ...source,
      assigned_input:
        source.current_input === true &&
        Array.isArray(source.source_ordinals) &&
        source.source_ordinals.some((ordinal) => selected.has(ordinal)),
    })),
  };
}

function captureMainContextSnapshot(
  req,
  {
    agent,
    messages,
    visibleMessages,
    sections = {},
    attemptState = {},
    routeFacts = {},
    feelingsReceipt,
    protectUnreconciledHistory = false,
    nativeBodyCarrier = false,
    historyAncestry,
  } = {},
) {
  if (!req || typeof req !== 'object') return null;
  if (req[SNAPSHOT_SLOT]) return req[SNAPSHOT_SLOT];
  nativeBodyCarrier =
    nativeBodyCarrier === true &&
    Boolean(agent?.model_parameters?.configuration?.defaultHeaders?.['X-GlassHive-Agent-Id']);
  const interaction = getTrustedInteractionContext(req) || {};
  const ownerId = String(req.user?.id || '');
  const agentId = String(agent?.id || '');
  const stableAuthoritySha256 = stableAuthorityDigest(agent);
  assertMainHistoryAncestry(
    ownerId,
    String(interaction.conversation_id || req.body?.conversationId || ''),
    visibleMessages,
    historyAncestry,
    protectUnreconciledHistory,
  );
  const sectionManifest = Object.fromEntries(
    Object.entries(sections)
      .filter(([, value]) => typeof value === 'string' && value.length > 0)
      .map(([name, value]) => [
        name,
        Object.freeze({
          bytes: Buffer.byteLength(value, 'utf8'),
          sha256: crypto.createHash('sha256').update(value, 'utf8').digest('hex'),
        }),
      ]),
  );
  const toolCarriers = protectUnreconciledHistory
    ? formattedToolHistoryCarriers(visibleMessages || [], agent)
    : new Map();
  const conversationId = String(interaction.conversation_id || req.body?.conversationId || '');
  let chain = visibleMessageChain(
    visibleMessages,
    protectUnreconciledHistory,
    toolCarriers,
    nativeBodyCarrier,
  );
  const omittedBlankIds = new Set(
    (visibleMessages || [])
      .filter(
        (message) =>
          message?.messageId &&
          (isBlankContextOnlyMainCarrier(message, messageContentText(message)) ||
            isAttachmentOnlyMainTextCarrier(message, messageContentText(message))) &&
          !(messages || []).some(
            (formatted) =>
              String(formatted?.messageId || formatted?.id || '') === String(message.messageId),
          ),
      )
      .map((message) => String(message.messageId)),
  );
  const omittedContextIds = new Set();
  if (protectUnreconciledHistory || omittedBlankIds.size) {
    if (!protectUnreconciledHistory) {
      assertMainHistoryAncestry(ownerId, conversationId, visibleMessages, historyAncestry, true);
    }
    const matched = assertUnreconciledHistoryCarrier(
      ownerId,
      conversationId,
      visibleMessages,
      messages,
      chain,
      toolCarriers,
      omittedContextIds,
      protectUnreconciledHistory ? undefined : omittedBlankIds,
    );
    if (agent?.useLegacyContent === true && matched.length) {
      // Validate all source words, tool evidence and current input before applying Graph's
      // selected projection. Only the digest carrier changes; stored source rows stay intact.
      for (const carrier of matched) {
        const projected = prepareMainContinuityCarrier(carrier.messages, true);
        const text = carrier.source
          ? prepareMainContinuityCarrier(carrier.source.messages, true)
              .filter((message) => message.role === 'assistant')
              .map(messageContentText)
              .filter(Boolean)
              .join('\n')
          : messageContentText(projected[0]);
        toolCarriers.set(carrier.sourceMessage, { ...carrier.source, text });
      }
      chain = visibleMessageChain(visibleMessages, true, toolCarriers, nativeBodyCarrier);
    }
    // Omitted empty text retains its ancestry and attachment authority. The native digest
    // manifest contains only rows carried by the selected provider formatter.
    chain = chain.filter((row) => !omittedContextIds.has(row.id));
  }
  const selectedMessages = prepareMainContinuityCarrier(
    messages || [],
    agent?.useLegacyContent === true,
  );
  const sourceMessageIds = chain.filter((row) => row.accepted_source).map((row) => row.id);
  let owned = [];
  let carried;
  if (
    interaction.logical_turn_id &&
    interaction.source_segments?.length &&
    interaction.actor_kind === 'external_user' &&
    interaction.origin === 'interactive'
  ) {
    // Keep the full trusted source/file ledger intact. Only the digest projection omits the
    // exact empty-text rows already reconciled above; genuinely missing sources still fail.
    owned = ownedInteractionSources(interaction, getTrustedAdapterCapabilities(req)).filter(
      ({ segment }) => !omittedContextIds.has(String(segment.source_message_id || '')),
    );
    const headers = buildMainContinuityHeaders({
      context: { ownerId, agentId, stableAuthoritySha256 },
      messages: selectedMessages,
      sourceMessageIds,
      logicalTurnId: interaction.logical_turn_id,
      revision: interaction.revision,
      interactionContext: { ...interaction, source_segments: owned.map(({ segment }) => segment) },
    });
    carried = JSON.parse(
      Buffer.from(headers['X-Viventium-Visible-Message-Chain-B64'], 'base64').toString('utf8'),
    );
  } else {
    carried = buildMainContinuityMessageChain(selectedMessages, new Set(sourceMessageIds));
  }
  const carriedById = new Map(carried.map((row) => [row.id, row]));
  chain = chain.map((row) => {
    const input = carriedById.get(row.id);
    const complete =
      input?.role === row.role && input.content_sha256
        ? { ...row, content_sha256: input.content_sha256 }
        : row;
    return input?.current_input
      ? Object.freeze({
          ...complete,
          accepted_source: true,
          current_input: true,
          // Subset input keeps its original S-labels in the selection capsule. Native optional
          // ordinals require a complete contiguous ledger, so never renumber a subset here.
          ...(owned.length === interaction.source_segments.length
            ? { source_ordinals: Object.freeze([...input.source_ordinals]) }
            : {}),
        })
      : Object.freeze(complete);
  });
  // Current-input digests and flags are added after the first budget check. Bound that final
  // ordinary manifest again; the complete model payload and required source rows stay intact.
  chain = boundVisibleMessageChain(chain, protectUnreconciledHistory, nativeBodyCarrier);
  const body = {
    version: 1,
    ownerId,
    agentId,
    continuityDomainId: digest({ version: 1, ownerId, agentId }),
    conversationId,
    logicalTurnId: String(interaction.logical_turn_id || ''),
    revision: Number(interaction.revision || 1),
    actorKind: String(interaction.actor_kind || 'external_user'),
    origin: String(interaction.origin || 'interactive'),
    routeFacts: snapshotRouteFacts(interaction, routeFacts),
    ...(feelingsReceipt !== undefined
      ? { feelingsReceipt: snapshotFeelingsReceipt(feelingsReceipt) }
      : {}),
    memoryEligible: interaction.actor_kind !== 'system' && interaction.origin !== 'scheduler',
    contextEpoch: stableAuthoritySha256,
    stableAuthoritySha256,
    capabilityFingerprint: digest({ tools: agent?.tools || [], mcp: agent?.mcp || [] }),
    messages: Object.freeze(messageManifest(messages)),
    visibleMessageChain: Object.freeze(chain),
    sections: Object.freeze(sectionManifest),
  };
  const snapshot = {
    ...body,
    snapshotSha256: digest(body),
  };
  const configuredModel = req.config?.endpoints?.agents?.providerCapabilities?.[
    agent?.endpoint || agent?.provider
  ]?.models?.find((model) => model.id === (agent?.model || agent?.model_parameters?.model));
  const inheritConversation =
    agent?.glasshive_options?.orchestration?.tool_mode === 'coordination' &&
    ['direct-openai', 'direct-anthropic', 'direct-xai'].includes(configuredModel?.harnessProfile);
  /* === VIVENTIUM START ===
   * Feature: Exact local attempt replay.
   * Purpose: The public/provider contract carries only digests, while fallback and retry inside
   * this request reuse the exact admitted instructions and per-turn header value. Raw context is
   * never serialized into provider headers or an enumerable request field.
   * === VIVENTIUM END === */
  Object.defineProperty(snapshot, LOCAL_ATTEMPT_STATE, {
    value: Object.freeze(
      canonical({
        ...attemptState,
        ...(inheritConversation
          ? {
              inheritedConversation: buildInheritedConversationContext({
                conversationId,
                messages: selectedMessages,
                messageChain: chain,
                sourceSegments: interaction.source_segments || [],
                sections: {
                  mainContinuity: sections.mainContinuity,
                  conversationContinuity: sections.conversationContinuity,
                },
              }),
            }
          : {}),
      }),
    ),
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.freeze(snapshot);
  Object.defineProperty(req, SNAPSHOT_SLOT, {
    value: snapshot,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return snapshot;
}

function mainContextTurnContextError(code) {
  const messages = {
    main_context_turn_context_authority_too_large:
      'Trusted Main attempt authority exceeds the GlassHive turn-context byte limit.',
    main_context_turn_context_required_section_too_large:
      'A required request-pinned Main context section exceeds the remaining GlassHive byte budget.',
    main_context_turn_context_too_large:
      'The request-pinned Main context exceeds the GlassHive transport byte limit.',
  };
  const error = new Error(messages[code] || messages.main_context_turn_context_too_large);
  error.code = code;
  return error;
}

function clipTurnContextUtf8(value, maximumBytes) {
  if (maximumBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1])) low -= 1;
  return value.slice(0, low);
}

function turnContextComponents(value) {
  const components = [];
  const openEnvelopes = [];
  let current = '';
  let atomic = false;
  for (const segment of value.split(TURN_CONTEXT_SEPARATOR)) {
    current = current ? `${current}${TURN_CONTEXT_SEPARATOR}${segment}` : segment;
    const tags = segment.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9_.:-]*)(?:\s[^<>]*?)?(\/?)>/g);
    for (const tag of tags) {
      atomic = true;
      if (tag[1]) {
        if (openEnvelopes.at(-1) === tag[2]) openEnvelopes.pop();
        else if (openEnvelopes.includes(tag[2])) {
          openEnvelopes.splice(openEnvelopes.lastIndexOf(tag[2]));
        }
      } else if (!tag[3]) {
        openEnvelopes.push(tag[2]);
      }
    }
    if (openEnvelopes.length > 0) continue;
    components.push({ text: current, atomic });
    current = '';
    atomic = false;
  }
  if (current) components.push({ text: current, atomic: true });
  return components;
}

function describedTurnContextComponents(
  value,
  snapshot,
  requiredSections = TURN_CONTEXT_REQUIRED_SECTIONS,
) {
  const sections = Object.entries(snapshot?.sections || {});
  return turnContextComponents(value).map((component, index) => {
    const bytes = Buffer.byteLength(component.text, 'utf8');
    const candidates = sections.filter(([, manifest]) => manifest?.bytes === bytes);
    const componentDigest = candidates.length
      ? crypto.createHash('sha256').update(component.text, 'utf8').digest('hex')
      : '';
    const section = candidates.find(([, manifest]) => manifest.sha256 === componentDigest)?.[0];
    const required = requiredSections.has(section);
    let priority = 1;
    if (required) priority = 0;
    else if (component.atomic) priority = section === 'mainContinuity' ? 2 : 3;
    return { ...component, index, bytes, section, required, priority };
  });
}

function compactMainTurnContext(
  value,
  maximumBytes,
  snapshot,
  requiredSections = TURN_CONTEXT_REQUIRED_SECTIONS,
  retentionStage = 'encode',
) {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) {
    if (promptFrameLoggingEnabled()) {
      logTurnContextRetention(logger, {
        stage: retentionStage,
        budgetBytes: maximumBytes,
        outputText: value,
        snapshotSha256: snapshot?.snapshotSha256,
        components: describedTurnContextComponents(value, snapshot, requiredSections).map(
          (component) => ({
            kind: component.section,
            beforeText: component.text,
            afterText: component.text,
          }),
        ),
      });
    }
    return value;
  }
  const components = describedTurnContextComponents(value, snapshot, requiredSections);
  const selected = new Map();
  let usedBytes = 0;
  const ordered = [...components].sort(
    (left, right) =>
      Number(left.priority) - Number(right.priority) ||
      Number(left.bytes) - Number(right.bytes) ||
      Number(left.index) - Number(right.index),
  );

  for (const component of ordered) {
    const separatorBytes =
      selected.size > 0 ? Buffer.byteLength(TURN_CONTEXT_SEPARATOR, 'utf8') : 0;
    if (usedBytes + separatorBytes + component.bytes > maximumBytes) {
      if (component.required) {
        throw mainContextTurnContextError('main_context_turn_context_required_section_too_large');
      }
      continue;
    }
    selected.set(component.index, component.text);
    usedBytes += separatorBytes + component.bytes;
  }

  for (const component of ordered) {
    if (component.atomic || selected.has(component.index)) continue;
    const separatorBytes =
      selected.size > 0 ? Buffer.byteLength(TURN_CONTEXT_SEPARATOR, 'utf8') : 0;
    const clipped = clipTurnContextUtf8(component.text, maximumBytes - usedBytes - separatorBytes);
    if (!clipped) continue;
    selected.set(component.index, clipped);
    break;
  }

  const context = components
    .filter((component) => selected.has(component.index))
    .map((component) => selected.get(component.index))
    .join(TURN_CONTEXT_SEPARATOR);
  if (promptFrameLoggingEnabled()) {
    logTurnContextRetention(logger, {
      stage: retentionStage,
      budgetBytes: maximumBytes,
      outputText: context,
      snapshotSha256: snapshot?.snapshotSha256,
      components: components.map((component) => ({
        kind: component.section,
        beforeText: component.text,
        afterText: selected.get(component.index) || '',
      })),
    });
  }
  return context;
}

/* === VIVENTIUM START ===
 * Reuse the request-pinned roster projection after the exact Main authority budget is known.
 * === VIVENTIUM END === */
function projectMainActiveWorkTurnContext(turnContextText, maximumBytes, snapshot) {
  const local = snapshot?.[LOCAL_ATTEMPT_STATE];
  const projection = local?.activeWorkProjection;
  const components = local?.turnContextComponents;
  if (!projection || !Array.isArray(components)) return { text: turnContextText, rosterText: '' };
  const active = components.find((component) => component.kind === 'activeWork');
  if (typeof active?.text !== 'string' || !active.text.trim())
    return { text: turnContextText, rosterText: '' };
  const present = components.filter(
    (component) => typeof component.text === 'string' && component.text.trim(),
  );
  const full = present
    .map((component) => component.text)
    .join(TURN_CONTEXT_SEPARATOR)
    .trim();
  if (Buffer.byteLength(full, 'utf8') <= maximumBytes && turnContextText.includes(active.text))
    return { text: turnContextText, rosterText: projection.rosterText || '' };
  const fixed = present.filter((component) => component.kind !== 'activeWork');
  const fixedText = fixed.map((component) => component.text).join(TURN_CONTEXT_SEPARATOR);
  const minimumRoster = buildActiveWorkCapsule({ ...projection, maxBytes: 1024 });
  const rosterBytes = Buffer.byteLength(minimumRoster, 'utf8');
  if (rosterBytes > maximumBytes) {
    throw mainContextTurnContextError('main_context_turn_context_required_section_too_large');
  }
  const fixedBudget = Math.max(
    0,
    maximumBytes -
      rosterBytes -
      (fixed.length ? Buffer.byteLength(TURN_CONTEXT_SEPARATOR, 'utf8') : 0),
  );
  const fixedContext = compactMainTurnContext(
    fixedText,
    fixedBudget,
    snapshot,
    TURN_CONTEXT_REQUIRED_SECTIONS,
    'fixed_compact',
  );
  const availableBytes =
    maximumBytes -
    Buffer.byteLength(fixedContext, 'utf8') -
    (fixedContext ? Buffer.byteLength(TURN_CONTEXT_SEPARATOR, 'utf8') : 0);
  let rosterText = '';
  const projected = buildActiveWorkCapsule({
    ...projection,
    maxBytes: availableBytes,
    onRenderedRoster: (value) => {
      rosterText = value;
    },
  });
  const bounded = [fixedContext, projected].filter(Boolean).join(TURN_CONTEXT_SEPARATOR);
  if (Buffer.byteLength(bounded, 'utf8') > maximumBytes) {
    throw mainContextTurnContextError('main_context_turn_context_required_section_too_large');
  }
  if (promptFrameLoggingEnabled()) {
    logTurnContextRetention(logger, {
      stage: 'reproject',
      budgetBytes: maximumBytes,
      outputText: bounded,
      snapshotSha256: snapshot?.snapshotSha256,
      components: [
        { kind: 'fixedContext', beforeText: fixedText, afterText: fixedContext },
        { kind: 'activeWork', beforeText: active.text, afterText: projected },
      ],
    });
  }
  return { text: bounded, rosterText };
}

function encodeMainTurnContext({
  turnContextText,
  trustedAttemptAuthority,
  snapshot,
  maximumBytes = TURN_CONTEXT_MAX_DECODED_BYTES,
  onStateBlocks,
}) {
  const authorityBytes = Buffer.byteLength(trustedAttemptAuthority, 'utf8');
  if (authorityBytes > maximumBytes) {
    throw mainContextTurnContextError('main_context_turn_context_authority_too_large');
  }
  const separatorBytes =
    (turnContextText || snapshot?.[LOCAL_ATTEMPT_STATE]?.activeWorkProjection) &&
    trustedAttemptAuthority
      ? Buffer.byteLength(TURN_CONTEXT_SEPARATOR, 'utf8')
      : 0;
  const contextBudget = Math.max(0, maximumBytes - authorityBytes - separatorBytes);
  const projectedContext = projectMainActiveWorkTurnContext(
    turnContextText,
    contextBudget,
    snapshot,
  );
  const context = compactMainTurnContext(projectedContext.text, contextBudget, snapshot);
  const decoded = [context, trustedAttemptAuthority].filter(Boolean).join(TURN_CONTEXT_SEPARATOR);
  if (Buffer.byteLength(decoded, 'utf8') > maximumBytes) {
    throw mainContextTurnContextError('main_context_turn_context_too_large');
  }
  onStateBlocks?.(encodeMainContextStateBlock(decoded, projectedContext.rosterText));
  const encoded = Buffer.from(decoded, 'utf8').toString('base64');
  const maximumEncodedBytes =
    maximumBytes === TURN_CONTEXT_MAX_DECODED_BYTES
      ? TURN_CONTEXT_MAX_ENCODED_BYTES
      : Math.ceil(maximumBytes / 3) * 4;
  if (Buffer.byteLength(encoded, 'utf8') > maximumEncodedBytes) {
    throw mainContextTurnContextError('main_context_turn_context_too_large');
  }
  return encoded;
}

function applyMainContextAttempt({
  agents = [],
  requestBody,
  snapshot,
  turnContextDeliveryByAgentId = {},
  attemptAuthorityBlock = '',
} = {}) {
  const local = snapshot?.[LOCAL_ATTEMPT_STATE];
  if (!local || typeof local !== 'object') return false;
  const admittedAgents = (Array.isArray(agents) ? agents : []).filter(
    (agent) => agent && typeof agent === 'object',
  );
  if (admittedAgents.length === 0) return false;
  const instructionsByAgentId = local.instructionsByAgentId || {};
  const turnContextText = String(local.turnContextText || '').trim();
  const trustedAttemptAuthority = String(attemptAuthorityBlock || '').trim();
  const deliveries = new Map(
    admittedAgents.map((agent) => {
      const agentId = String(agent.id || '');
      return [
        agentId,
        String(
          turnContextDeliveryByAgentId[agentId] ||
            (local.turnContextHeaderPresent === true ? 'per_turn_header' : 'developer'),
        ),
      ];
    }),
  );
  const usesPerTurnHeader = Array.from(deliveries.values()).includes('per_turn_header');
  const primaryHeaders = admittedAgents[0]?.model_parameters?.configuration?.defaultHeaders;
  // This exact route has the existing final-dispatch body converter and source guard.
  const usesNativeBody = Boolean(
    primaryHeaders?.['X-GlassHive-Agent-Id'] &&
    primaryHeaders?.['X-Viventium-Visible-Message-Chain-B64'],
  );
  let stateBlocks = '';
  const encodedTurnContext = usesPerTurnHeader
    ? encodeMainTurnContext({
        turnContextText,
        trustedAttemptAuthority,
        snapshot,
        maximumBytes: usesNativeBody
          ? Math.min(
              NATIVE_MAIN_TURN_CONTEXT_BODY_MAX_BYTES,
              Number.isSafeInteger(local.turnContextMaximumBytes) &&
                local.turnContextMaximumBytes > 0
                ? local.turnContextMaximumBytes
                : NATIVE_MAIN_TURN_CONTEXT_MAX_BYTES,
            )
          : TURN_CONTEXT_MAX_DECODED_BYTES,
        onStateBlocks: (value) => {
          stateBlocks = value;
        },
      })
    : '';
  for (const [index, agent] of admittedAgents.entries()) {
    const agentId = String(agent.id || '');
    const exact =
      instructionsByAgentId[agentId] ??
      (index === 0 ? instructionsByAgentId[String(snapshot.agentId || '')] : undefined);
    if (index === 0 && typeof exact !== 'string') return false;
    const delivery = deliveries.get(agentId);
    if (typeof exact === 'string') {
      const directAdditions = [];
      if (delivery !== 'per_turn_header') {
        if (turnContextText && !exact.includes(turnContextText)) {
          directAdditions.push(turnContextText);
        }
        if (trustedAttemptAuthority && !exact.includes(trustedAttemptAuthority)) {
          directAdditions.push(trustedAttemptAuthority);
        }
      }
      agent.instructions = [exact, ...directAdditions].filter(Boolean).join('\n\n');
    }
    if (!bindMainContextSnapshot(agent, snapshot, stateBlocks)) return false;
  }
  if (requestBody && typeof requestBody === 'object') {
    if (usesPerTurnHeader) {
      requestBody.viventiumGlassHiveTurnContextB64 = encodedTurnContext;
    } else {
      delete requestBody.viventiumGlassHiveTurnContextB64;
    }
  }
  return true;
}

function bindMainContextCarrier(targetAgent, snapshot) {
  if (!snapshot || !targetAgent || typeof targetAgent !== 'object') return false;
  const modelParameters =
    targetAgent.model_parameters && typeof targetAgent.model_parameters === 'object'
      ? targetAgent.model_parameters
      : {};
  const configuration =
    modelParameters.configuration && typeof modelParameters.configuration === 'object'
      ? modelParameters.configuration
      : {};
  const headers =
    configuration.defaultHeaders && typeof configuration.defaultHeaders === 'object'
      ? configuration.defaultHeaders
      : {};
  /* === VIVENTIUM START === Current compiler descriptor replaces any case variant. === */
  const currentHeaders = Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) =>
        ![
          'x-viventium-main-context-state-blocks-b64',
          MAIN_CONTINUITY_CONTEXT_BUDGET_HEADER.toLowerCase(),
        ].includes(key.toLowerCase()),
    ),
  );
  /* === VIVENTIUM END === */
  targetAgent.model_parameters = {
    ...modelParameters,
    configuration: {
      ...configuration,
      defaultHeaders: {
        ...currentHeaders,
        ...(headers['X-GlassHive-Agent-Id']
          ? {
              [MAIN_CONTINUITY_CONTEXT_BUDGET_HEADER]: String(
                Math.min(
                  NATIVE_MAIN_TURN_CONTEXT_BODY_MAX_BYTES,
                  Number.isSafeInteger(snapshot[LOCAL_ATTEMPT_STATE]?.turnContextMaximumBytes) &&
                    snapshot[LOCAL_ATTEMPT_STATE].turnContextMaximumBytes > 0
                    ? snapshot[LOCAL_ATTEMPT_STATE].turnContextMaximumBytes
                    : NATIVE_MAIN_TURN_CONTEXT_MAX_BYTES,
                ),
              ),
            }
          : {}),
      },
    },
  };
  return true;
}

function bindMainContextSnapshot(targetAgent, snapshot, stateBlocks = '') {
  if (!bindMainContextCarrier(targetAgent, snapshot)) return false;
  const modelParameters = targetAgent.model_parameters;
  const configuration = modelParameters.configuration;
  targetAgent.model_parameters = {
    ...modelParameters,
    configuration: {
      ...configuration,
      defaultHeaders: {
        ...configuration.defaultHeaders,
        'X-Viventium-Main-Context-State-Blocks-B64': stateBlocks,
        'X-Viventium-Main-Context-Protocol': 'main_context_v1',
        'X-Viventium-Main-Context-Owner': 'core',
        'X-GlassHive-Stable-Authority-SHA256': snapshot.stableAuthoritySha256,
        'X-Viventium-Main-Context-Snapshot-SHA256': snapshot.snapshotSha256,
        'X-Viventium-Main-Context-Epoch': snapshot.contextEpoch,
        'X-Viventium-Continuity-Domain-Id': snapshot.continuityDomainId,
        'X-Viventium-Continuity-Agent-Id': snapshot.agentId,
        ...(snapshot.logicalTurnId
          ? {
              'X-Viventium-Logical-Turn-Id': snapshot.logicalTurnId,
              'X-Viventium-Logical-Turn-Revision': String(snapshot.revision),
            }
          : {}),
        'X-Viventium-Actor-Kind': snapshot.actorKind,
        'X-Viventium-Origin': snapshot.origin,
        'X-Viventium-Surface': snapshot.routeFacts?.surface || 'web',
        'X-Viventium-Memory-Eligible': snapshot.memoryEligible ? 'true' : 'false',
        ...(Array.isArray(snapshot.visibleMessageChain) && snapshot.visibleMessageChain.length > 0
          ? {
              'X-Viventium-Visible-Message-Chain-B64': Buffer.from(
                JSON.stringify(snapshot.visibleMessageChain),
                'utf8',
              ).toString('base64'),
            }
          : {}),
      },
    },
  };
  return true;
}

function attachMainContextSnapshotMetadata(req, message) {
  const snapshot = req?.[SNAPSHOT_SLOT];
  if (!snapshot || !message || typeof message !== 'object') return message;
  const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  const viventium =
    metadata.viventium && typeof metadata.viventium === 'object' ? metadata.viventium : {};
  return {
    ...message,
    metadata: {
      ...metadata,
      viventium: {
        ...viventium,
        mainContext: {
          version: 1,
          continuityDomainId: snapshot.continuityDomainId,
          agentId: snapshot.agentId,
          contextEpoch: snapshot.contextEpoch,
          stableAuthoritySha256: snapshot.stableAuthoritySha256,
          snapshotSha256: snapshot.snapshotSha256,
        },
      },
    },
  };
}

function getMainContextSnapshot(req) {
  return req?.[SNAPSHOT_SLOT] || null;
}

function getMainContextAttemptState(req) {
  return req?.[SNAPSHOT_SLOT]?.[LOCAL_ATTEMPT_STATE] || null;
}

module.exports = {
  applyMainContextAttempt,
  mainHistoryFitsNativeBody,
  attachMainContextSnapshotMetadata,
  bindMainContextSnapshot,
  bindMainContextCarrier,
  buildMainAttemptFactsForAgent,
  captureMainContextSnapshot,
  buildInheritedConversationContext,
  prependInheritedConversationPayload,
  assignInheritedConversationContext,
  createMainAttemptFacts,
  getMainContextAttemptState,
  getMainContextSnapshot,
  hasCoreMainContextStamp,
  hasUnreconciledMainHistory,
  isSchedulerTransportRow,
  isTrustedSchedulerWake,
  messageContentText,
  prependMainHistoryFileContext,
  withReconciledHistoryAncestry,
  traceMainHistoryAncestry,
  recoverRetainedTelegramHistory,
  renderMainAttemptFactsAuthorityBlock,
  mainAttemptFactsAuthorityReserveBytes,
  mainRouteTargetForAgent,
  stableAuthorityDigest,
};
