const crypto = require('node:crypto');
const { GraphNodeKeys } = require('@librechat/agents');
const { logger } = require('@librechat/data-schemas');

/* === VIVENTIUM START ===
 * Feature: Parallel text first-output timing.
 * Purpose: Correlate each conscious Main provider attempt to one public-safe turn hash and record
 * the first provider token/visible delta without logging user text, raw IDs, or provider payloads.
 * Graph re-entries and tool continuations remain distinct attempts; this is passive telemetry and
 * does not alter routing, prompts, deadlines, or output.
 * === */

const TEXT_TURN_TIMING_PREFIX = '[VIVENTIUM][TextTurnTiming]';

function hashTimingId(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return 'none';
  }
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function isVoiceInput(req) {
  if (req?.body?.voiceMode === true) {
    return true;
  }
  const inputMode = String(req?.body?.viventiumInputMode || '')
    .trim()
    .toLowerCase();
  return inputMode === 'voice_call' || inputMode === 'voice_note';
}

function timingDuration(startedAtMs, observedAtMs) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(observedAtMs)) {
    return null;
  }
  return Math.max(0, Math.round(observedAtMs - startedAtMs));
}

function logTimingEvent(event) {
  logger.info(`${TEXT_TURN_TIMING_PREFIX} ${JSON.stringify(event)}`);
  return event;
}

function initializeTextTurnTiming(req, { turnId, mainAgentId, turnStartedAtMs = Date.now() } = {}) {
  if (!req || isVoiceInput(req)) {
    return null;
  }
  const turnIdHash = hashTimingId(turnId);
  const existing = req._viventiumTextTurnTiming;
  if (existing?.turnIdHash === turnIdHash) {
    existing.mainAgentId = String(mainAgentId || existing.mainAgentId || '').trim();
    existing.turnStartedAtMs = Math.min(existing.turnStartedAtMs, turnStartedAtMs);
    return existing;
  }
  const state = {
    turnIdHash,
    mainAgentId: String(mainAgentId || '').trim(),
    turnStartedAtMs,
    agentCount: 0,
    attemptSequence: 0,
    attemptsByInvocationHash: new Map(),
    activeAttemptByNode: new Map(),
  };
  req._viventiumTextTurnTiming = state;
  return state;
}

function setTextMainRunContext(req, { agentCount } = {}) {
  const state = req?._viventiumTextTurnTiming;
  if (!state) {
    return null;
  }
  const parsedAgentCount = Number(agentCount);
  state.agentCount =
    Number.isInteger(parsedAgentCount) && parsedAgentCount > 0 ? parsedAgentCount : 0;
  return state;
}

function metadataAgentId(metadata) {
  for (const candidate of [metadata?.agent_id, metadata?.agentId]) {
    const normalized = String(candidate || '').trim();
    if (normalized) {
      return normalized;
    }
  }
  const node = String(metadata?.langgraph_node || '').trim();
  return node.startsWith(GraphNodeKeys.AGENT) ? node.slice(GraphNodeKeys.AGENT.length) : '';
}

function metadataNodeKey(metadata) {
  return String(metadata?.langgraph_node || '').trim() || 'single-agent';
}

function metadataInvocationHash(metadata) {
  const identity = [
    metadata?.run_id ?? metadata?.runId ?? '',
    metadata?.thread_id ?? metadata?.threadId ?? '',
    metadata?.langgraph_node ?? '',
    metadata?.langgraph_step ?? '',
    metadata?.checkpoint_ns ?? '',
    metadata?.__pregel_task_id ?? '',
  ].map((value) => String(value ?? '').trim());
  return hashTimingId(JSON.stringify(identity));
}

function isMainMetadata(state, metadata) {
  const agentId = metadataAgentId(metadata);
  if (agentId) {
    return agentId === state.mainAgentId;
  }
  return state.agentCount === 1;
}

function markMainProviderAttemptStart(req, metadata = {}, { nowMs = Date.now() } = {}) {
  const state = req?._viventiumTextTurnTiming;
  if (!state || !isMainMetadata(state, metadata)) {
    return null;
  }
  const providerAttemptIdHash = metadataInvocationHash(metadata);
  if (
    providerAttemptIdHash !== 'none' &&
    state.attemptsByInvocationHash.has(providerAttemptIdHash)
  ) {
    return null;
  }
  state.attemptSequence += 1;
  const attemptIndex = state.attemptSequence;
  const nodeKey = metadataNodeKey(metadata);
  const attempt = {
    attemptIndex,
    invocationId: `${state.turnIdHash}.${attemptIndex}`,
    providerAttemptIdHash,
    nodeKey,
    startedAtMs: nowMs,
    outputKinds: new Set(),
  };
  if (providerAttemptIdHash !== 'none') {
    state.attemptsByInvocationHash.set(providerAttemptIdHash, attempt);
  }
  state.activeAttemptByNode.set(nodeKey, attempt);
  return logTimingEvent({
    event: 'viventium_text_main_provider_attempt_start',
    turnIdHash: state.turnIdHash,
    invocationId: attempt.invocationId,
    attemptIndex,
    providerAttemptIdHash,
    observedAtMs: nowMs,
    fromTurnStartMs: timingDuration(state.turnStartedAtMs, nowMs),
  });
}

function findMainAttempt(state, metadata) {
  if (!isMainMetadata(state, metadata)) {
    return null;
  }
  const providerAttemptIdHash = metadataInvocationHash(metadata);
  if (
    providerAttemptIdHash !== 'none' &&
    state.attemptsByInvocationHash.has(providerAttemptIdHash)
  ) {
    return state.attemptsByInvocationHash.get(providerAttemptIdHash);
  }
  return state.activeAttemptByNode.get(metadataNodeKey(metadata)) || null;
}

function markMainProviderFirstOutput(
  req,
  metadata = {},
  { kind = 'provider_token', nowMs = Date.now() } = {},
) {
  const state = req?._viventiumTextTurnTiming;
  if (!state) {
    return null;
  }
  let attempt = findMainAttempt(state, metadata);
  if (!attempt) {
    const started = markMainProviderAttemptStart(req, metadata, { nowMs });
    if (!started) {
      return null;
    }
    attempt = findMainAttempt(state, metadata);
  }
  const outputKind = String(kind || 'provider_token').trim() || 'provider_token';
  if (attempt.outputKinds.has(outputKind)) {
    return null;
  }
  attempt.outputKinds.add(outputKind);
  return logTimingEvent({
    event: 'viventium_text_main_first_provider_output',
    turnIdHash: state.turnIdHash,
    invocationId: attempt.invocationId,
    attemptIndex: attempt.attemptIndex,
    providerAttemptIdHash: attempt.providerAttemptIdHash,
    outputKind,
    observedAtMs: nowMs,
    fromTurnStartMs: timingDuration(state.turnStartedAtMs, nowMs),
    fromAttemptStartMs: timingDuration(attempt.startedAtMs, nowMs),
  });
}

module.exports = {
  TEXT_TURN_TIMING_PREFIX,
  hashTimingId,
  initializeTextTurnTiming,
  markMainProviderAttemptStart,
  markMainProviderFirstOutput,
  setTextMainRunContext,
};

/* === VIVENTIUM END === */
