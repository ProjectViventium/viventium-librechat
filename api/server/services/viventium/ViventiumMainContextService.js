'use strict';

/* === VIVENTIUM START ===
 * Feature: MainContextSnapshotV1.
 * Purpose: Admit one immutable, provider-neutral context manifest per logical turn and reuse its
 * digest across primary, fallback, retry, and Phase-B attempts.
 * === VIVENTIUM END === */

const crypto = require('crypto');
const { Constants } = require('librechat-data-provider');
const { getTrustedInteractionContext } = require('./interactionContext');

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

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      return String(part.text || part.input_text || part.type || '');
    })
    .join('\n');
}

function messageManifest(messages = []) {
  return (Array.isArray(messages) ? messages : []).map((message, index) => {
    const text = contentText(message?.content ?? message?.text);
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
  error.code = 'source_context_unavailable';
  error.status = 413;
  return error;
}

function hasCoreMainContextStamp(message) {
  const stamp = message?.metadata?.viventium?.mainContext;
  return (
    stamp?.version === 1 &&
    ['continuityDomainId', 'contextEpoch', 'stableAuthoritySha256', 'snapshotSha256'].every((key) =>
      /^[a-f0-9]{64}$/.test(String(stamp?.[key] || '')),
    ) &&
    typeof stamp.agentId === 'string' &&
    Boolean(stamp.agentId)
  );
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
    if (isSkippable?.(message)) skipped.push(cursor);
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
        (message) => message.isCreatedByUser === false && !hasCoreMainContextStamp(message),
      ) ||
      (selectedRows.every((message) => message.isCreatedByUser !== false) &&
        selectedRows.length > 0),
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
      const accounted = new Set([...visibleById.keys(), ...proof.skippedMessageIds]);
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

function hasUnreconciledMainHistory(messages) {
  if (!Array.isArray(messages)) return false;
  const prior = messages.slice(0, -1).filter((message) => {
    const role = String(
      message?.role || (message?.isCreatedByUser === true ? 'user' : 'assistant'),
    ).toLowerCase();
    return message?.messageId && !['system', 'developer'].includes(role);
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

function visibleMessageChain(messages = [], protectUnreconciledHistory = false) {
  const source = (Array.isArray(messages) ? messages : [])
    .filter((message) => {
      const role = String(
        message?.role || (message?.isCreatedByUser === true ? 'user' : 'assistant'),
      ).toLowerCase();
      return message?.messageId && role !== 'system' && role !== 'developer';
    })
    .map((message, index, visible) => {
      const text = contentText(message?.content ?? message?.text);
      return Object.freeze({
        id: String(message.messageId).slice(0, 160),
        parentId: String(message.parentMessageId || '').slice(0, 160),
        role: String(
          message.role || (message.isCreatedByUser === true ? 'user' : 'assistant'),
        ).slice(0, 24),
        bytes: Buffer.byteLength(text, 'utf8'),
        sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
        ...(protectUnreconciledHistory && index < visible.length - 1
          ? { accepted_source: true }
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
    (source.length > 128 ||
      (source.length > 1 && source.at(-1)?.role !== 'user') ||
      originalIds.some((id) => id.length > 160) ||
      (Array.isArray(messages) ? messages : []).some(
        (message) => String(message?.parentMessageId || '').length > 160,
      ) ||
      new Set(originalIds).size !== originalIds.length)
  ) {
    throw unreconciledSourceError();
  }
  const chain = source.slice(-128);
  while (
    chain.length > 1 &&
    Buffer.byteLength(Buffer.from(JSON.stringify(chain), 'utf8').toString('base64'), 'utf8') >
      VISIBLE_MESSAGE_CHAIN_MAX_ENCODED_BYTES
  ) {
    if (protectUnreconciledHistory) throw unreconciledSourceError();
    chain.shift();
  }
  return chain;
}

function assertUnreconciledHistoryCarrier(
  ownerId,
  conversationId,
  visibleMessages,
  finalMessages,
  chain,
) {
  if (chain.length < 2) return;
  const originals = visibleMessages.filter(
    (message) =>
      message?.messageId &&
      !['system', 'developer'].includes(String(message.role || '').toLowerCase()),
  );
  const final = Array.isArray(finalMessages) ? finalMessages : [];
  let position = 0;
  for (let index = 0; index < chain.length - 1; index += 1) {
    const source = originals[index];
    const expected = chain[index];
    const sourceText = contentText(source?.content ?? source?.text);
    if (
      String(source?.user || '') !== ownerId ||
      String(source?.conversationId || '') !== conversationId ||
      source?.deletedAt != null ||
      source?.error === true ||
      source?.unfinished === true ||
      source?.metadata?.viventium?.visibility === 'internal' ||
      (typeof source?.text === 'string' &&
        source.text.trim() &&
        !sourceText.includes(source.text.trim())) ||
      (expected.role === 'user' && source?.isCreatedByUser !== true) ||
      (expected.role === 'assistant' && source?.isCreatedByUser !== false) ||
      !['user', 'assistant'].includes(expected.role)
    )
      throw unreconciledSourceError();
    const matched = final.findIndex((message, candidate) => {
      const role = String(message?.role || message?._getType?.() || '').toLowerCase();
      const normalizedRole = role === 'human' ? 'user' : role === 'ai' ? 'assistant' : role;
      const text = contentText(message?.content ?? message?.text);
      // Provider formatting removes Mongo message IDs. Match the complete ordered text and
      // role sequence here; the source rows themselves are checked against the owner and branch.
      return (
        candidate >= position &&
        normalizedRole === expected.role &&
        crypto.createHash('sha256').update(text, 'utf8').digest('hex') === expected.sha256
      );
    });
    if (matched < 0) throw unreconciledSourceError();
    position = matched + 1;
  }
  const current = chain.at(-1);
  if (
    !final.some((message, index) => {
      const role = String(message?.role || message?._getType?.() || '').toLowerCase();
      const text = contentText(message?.content ?? message?.text);
      return (
        index >= position &&
        (role === 'human' ? 'user' : role) === 'user' &&
        crypto.createHash('sha256').update(text, 'utf8').digest('hex') === current.sha256
      );
    })
  )
    throw unreconciledSourceError();
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
    historyAncestry,
  } = {},
) {
  if (!req || typeof req !== 'object') return null;
  if (req[SNAPSHOT_SLOT]) return req[SNAPSHOT_SLOT];
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
  const body = {
    version: 1,
    ownerId,
    agentId,
    continuityDomainId: digest({ version: 1, ownerId, agentId }),
    conversationId: String(interaction.conversation_id || req.body?.conversationId || ''),
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
    visibleMessageChain: Object.freeze(
      visibleMessageChain(visibleMessages, protectUnreconciledHistory),
    ),
    sections: Object.freeze(sectionManifest),
  };
  if (protectUnreconciledHistory) {
    assertUnreconciledHistoryCarrier(
      ownerId,
      body.conversationId,
      visibleMessages,
      messages,
      body.visibleMessageChain,
    );
  }
  const snapshot = {
    ...body,
    snapshotSha256: digest(body),
  };
  /* === VIVENTIUM START ===
   * Feature: Exact local attempt replay.
   * Purpose: The public/provider contract carries only digests, while fallback and retry inside
   * this request reuse the exact admitted instructions and per-turn header value. Raw context is
   * never serialized into provider headers or an enumerable request field.
   * === VIVENTIUM END === */
  Object.defineProperty(snapshot, LOCAL_ATTEMPT_STATE, {
    value: Object.freeze(canonical(attemptState)),
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

function describedTurnContextComponents(value, snapshot) {
  const sections = Object.entries(snapshot?.sections || {});
  return turnContextComponents(value).map((component, index) => {
    const bytes = Buffer.byteLength(component.text, 'utf8');
    const candidates = sections.filter(([, manifest]) => manifest?.bytes === bytes);
    const componentDigest = candidates.length
      ? crypto.createHash('sha256').update(component.text, 'utf8').digest('hex')
      : '';
    const section = candidates.find(([, manifest]) => manifest.sha256 === componentDigest)?.[0];
    const required = TURN_CONTEXT_REQUIRED_SECTIONS.has(section);
    let priority = 1;
    if (required) priority = 0;
    else if (component.atomic) priority = section === 'mainContinuity' ? 2 : 3;
    return { ...component, index, bytes, section, required, priority };
  });
}

function compactMainTurnContext(value, maximumBytes, snapshot) {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value;
  const components = describedTurnContextComponents(value, snapshot);
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

  return components
    .filter((component) => selected.has(component.index))
    .map((component) => selected.get(component.index))
    .join(TURN_CONTEXT_SEPARATOR);
}

function encodeMainTurnContext({ turnContextText, trustedAttemptAuthority, snapshot }) {
  const authorityBytes = Buffer.byteLength(trustedAttemptAuthority, 'utf8');
  if (authorityBytes > TURN_CONTEXT_MAX_DECODED_BYTES) {
    throw mainContextTurnContextError('main_context_turn_context_authority_too_large');
  }
  const separatorBytes =
    turnContextText && trustedAttemptAuthority
      ? Buffer.byteLength(TURN_CONTEXT_SEPARATOR, 'utf8')
      : 0;
  const contextBudget = Math.max(
    0,
    TURN_CONTEXT_MAX_DECODED_BYTES - authorityBytes - separatorBytes,
  );
  const context = compactMainTurnContext(turnContextText, contextBudget, snapshot);
  const decoded = [context, trustedAttemptAuthority].filter(Boolean).join(TURN_CONTEXT_SEPARATOR);
  if (Buffer.byteLength(decoded, 'utf8') > TURN_CONTEXT_MAX_DECODED_BYTES) {
    throw mainContextTurnContextError('main_context_turn_context_too_large');
  }
  const encoded = Buffer.from(decoded, 'utf8').toString('base64');
  if (Buffer.byteLength(encoded, 'utf8') > TURN_CONTEXT_MAX_ENCODED_BYTES) {
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
  const encodedTurnContext = usesPerTurnHeader
    ? encodeMainTurnContext({ turnContextText, trustedAttemptAuthority, snapshot })
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
    if (!bindMainContextSnapshot(agent, snapshot)) return false;
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

function bindMainContextSnapshot(targetAgent, snapshot) {
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
  targetAgent.model_parameters = {
    ...modelParameters,
    configuration: {
      ...configuration,
      defaultHeaders: {
        ...headers,
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
  attachMainContextSnapshotMetadata,
  bindMainContextSnapshot,
  buildMainAttemptFactsForAgent,
  captureMainContextSnapshot,
  createMainAttemptFacts,
  getMainContextAttemptState,
  getMainContextSnapshot,
  hasUnreconciledMainHistory,
  traceMainHistoryAncestry,
  renderMainAttemptFactsAuthorityBlock,
  mainRouteTargetForAgent,
  stableAuthorityDigest,
};
