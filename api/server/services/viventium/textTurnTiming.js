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
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TEXT_TURN_BOUNDARY_STAGES = new Set([
  'controller_admission',
  'concurrency_admitted',
  'client_initialization_start',
  'client_initialization_end',
  'main_pipeline_start',
  'main_pipeline_complete',
  'assistant_durable',
  'final_event_emitted',
  'presentation_committed',
]);

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
  try {
    logger.info(`${TEXT_TURN_TIMING_PREFIX} ${JSON.stringify(event)}`);
  } catch {
    // Passive timing must never change the request path.
  }
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
    observedBoundaryStages: new Set(),
    toolSequence: 0,
    openToolsByContextHash: new Map(),
    seenToolStartKeys: new Set(),
    nativeRequestAuthority: null,
  };
  req._viventiumTextTurnTiming = state;
  return state;
}

function normalizedRouteToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function countExactStringInText(text, expected) {
  if (typeof text !== 'string' || typeof expected !== 'string' || expected.length === 0) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  while (offset <= text.length - expected.length) {
    const found = text.indexOf(expected, offset);
    if (found < 0) break;
    count += 1;
    offset = found + expected.length;
  }
  return count;
}

function countExactStringInValue(value, expected, depth = 0) {
  if (depth > 32 || expected.length === 0) return 0;
  if (typeof value === 'string') return countExactStringInText(value, expected);
  if (Array.isArray(value)) {
    return value.reduce(
      (total, child) => total + countExactStringInValue(child, expected, depth + 1),
      0,
    );
  }
  if (value && typeof value === 'object') {
    return Object.values(value).reduce(
      (total, child) => total + countExactStringInValue(child, expected, depth + 1),
      0,
    );
  }
  return 0;
}

function requestDigest(request) {
  let serialized;
  try {
    serialized = typeof request === 'string' ? request : JSON.stringify(request);
  } catch {
    serialized = '[unserializable]';
  }
  return crypto
    .createHash('sha256')
    .update(serialized || '')
    .digest('hex');
}

function sha256Text(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest('hex');
}

function validGlassHiveAuthorityReceipt(receipt, instructionAuthority, expectedCapsuleCount) {
  if (!receipt || typeof receipt !== 'object' || !instructionAuthority) return false;
  const runtime = String(receipt.runtime || '').trim();
  const expectedPlacement = {
    'claude-code': 'append_system_prompt_file',
    'codex-cli': 'codex_developer_instructions',
  }[runtime];
  const authorityChars = Number(receipt.authority_chars);
  const feelingCapsuleCount = Number(receipt.feeling_capsule_count);
  return (
    receipt.protocol === 'glasshive.native_provider_authority_receipt.v1' &&
    receipt.materialized === true &&
    String(receipt.run_id || '').trim().length > 0 &&
    Boolean(expectedPlacement) &&
    String(receipt.placement || '') === expectedPlacement &&
    SHA256_PATTERN.test(String(receipt.authority_sha256 || '')) &&
    crypto.timingSafeEqual(
      Buffer.from(String(receipt.authority_sha256), 'hex'),
      Buffer.from(sha256Text(instructionAuthority), 'hex'),
    ) &&
    Number.isInteger(authorityChars) &&
    authorityChars === Array.from(instructionAuthority).length &&
    Number.isInteger(feelingCapsuleCount) &&
    feelingCapsuleCount === expectedCapsuleCount
  );
}

function logWinningNativeReceipt(state, attempt, nowMs, outputKind) {
  if (attempt.winningNativeReceiptLogged) return null;
  const winningReceipt = attempt.nativeReceipts
    .filter((receipt) => receipt.eligibleForMainReceipt === true && receipt.observedAtMs <= nowMs)
    .sort((left, right) => right.observedAtMs - left.observedAtMs)[0];
  if (!winningReceipt) return null;
  attempt.winningNativeReceiptLogged = true;
  return logTimingEvent({
    event: 'viventium_text_main_winning_native_provider_receipt',
    turnIdHash: state.turnIdHash,
    invocationId: attempt.invocationId,
    attemptIndex: attempt.attemptIndex,
    receiptRef: winningReceipt.receiptRef,
    provider: winningReceipt.provider,
    model: winningReceipt.model,
    status: winningReceipt.status,
    snapshotHash: winningReceipt.snapshotHash,
    nativeRequestSha256: winningReceipt.nativeRequestSha256,
    capsuleOccurrenceCount: winningReceipt.capsuleOccurrenceCount,
    mainInstructionOccurrenceCount: winningReceipt.mainInstructionOccurrenceCount,
    outputKind,
    observedAtMs: nowMs,
    fromTurnStartMs: timingDuration(state.turnStartedAtMs, nowMs),
    fromAttemptStartMs: timingDuration(attempt.startedAtMs, nowMs),
  });
}

function setTextMainNativeRequestAuthority(
  req,
  { instructions, provider, model, reasoningEffort } = {},
) {
  const state = req?._viventiumTextTurnTiming;
  const normalizedInstructions = String(instructions || '').trim();
  if (!state || !normalizedInstructions) return null;
  state.nativeRequestAuthority = {
    instructions: normalizedInstructions,
    provider: normalizedRouteToken(provider),
    model: normalizedRouteToken(model),
    reasoningEffort: normalizedRouteToken(reasoningEffort),
  };
  req._viventiumRecordNativeProviderRequestAccepted = (receipt) =>
    recordNativeProviderRequestAccepted(req, receipt);
  return {
    provider: state.nativeRequestAuthority.provider,
    model: state.nativeRequestAuthority.model,
    reasoningEffort: state.nativeRequestAuthority.reasoningEffort,
    instructionsSha256: crypto
      .createHash('sha256')
      .update(normalizedInstructions, 'utf8')
      .digest('hex'),
  };
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
  for (const prefix of [GraphNodeKeys.AGENT, GraphNodeKeys.TOOLS]) {
    if (node.startsWith(prefix)) {
      return node.slice(prefix.length);
    }
  }
  return '';
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
    nativeReceipts: [],
    winningNativeReceiptLogged: false,
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

function markTextTurnBoundary(req, stage, { nowMs = Date.now() } = {}) {
  const state = req?._viventiumTextTurnTiming;
  const normalizedStage = String(stage || '').trim();
  if (
    !state ||
    !TEXT_TURN_BOUNDARY_STAGES.has(normalizedStage) ||
    state.observedBoundaryStages.has(normalizedStage) ||
    !Number.isFinite(nowMs)
  ) {
    return null;
  }
  state.observedBoundaryStages.add(normalizedStage);
  return logTimingEvent({
    event: 'viventium_text_turn_boundary',
    turnIdHash: state.turnIdHash,
    stage: normalizedStage,
    observedAtMs: nowMs,
    fromTurnStartMs: timingDuration(state.turnStartedAtMs, nowMs),
  });
}

function recordNativeProviderRequestAccepted(
  req,
  {
    provider,
    model,
    status,
    request,
    instructionAuthority,
    nativeRequestSha256: suppliedNativeRequestSha256,
    authorityReceipt,
  } = {},
  { nowMs = Date.now() } = {},
) {
  const state = req?._viventiumTextTurnTiming;
  const authority = state?.nativeRequestAuthority;
  if (!state || !authority) return null;
  const activeAttempt = Array.from(state.activeAttemptByNode.values())
    .filter((attempt) => attempt?.startedAtMs <= nowMs)
    .sort((left, right) => right.startedAtMs - left.startedAtMs)[0];
  if (!activeAttempt) return null;

  const normalizedProvider = normalizedRouteToken(provider);
  const normalizedModel = normalizedRouteToken(model);
  const normalizedStatus = Number(status);
  const snapshot = req?._viventiumFeelingSnapshot;
  const snapshotHash = SHA256_PATTERN.test(String(snapshot?.snapshotHash || ''))
    ? String(snapshot.snapshotHash)
    : 'none';
  const capsule = snapshot?.enabled === true ? String(snapshot?.capsule || '').trim() : '';
  const normalizedInstructionAuthority = String(instructionAuthority || '').trim();
  const receiptValue = normalizedInstructionAuthority || request;
  const capsuleOccurrenceCount = capsule ? countExactStringInValue(receiptValue, capsule) : 0;
  const mainInstructionOccurrenceCount = countExactStringInValue(
    receiptValue,
    authority.instructions,
  );
  const expectedCapsuleCount = capsule ? 1 : 0;
  const authorityReceiptValid = authorityReceipt
    ? validGlassHiveAuthorityReceipt(
        authorityReceipt,
        normalizedInstructionAuthority,
        expectedCapsuleCount,
      )
    : true;
  const eligibleForMainReceipt =
    Number.isInteger(normalizedStatus) &&
    normalizedStatus >= 200 &&
    normalizedStatus < 300 &&
    authorityReceiptValid &&
    mainInstructionOccurrenceCount === 1 &&
    capsuleOccurrenceCount === expectedCapsuleCount;
  const nativeRequestSha256 = SHA256_PATTERN.test(String(suppliedNativeRequestSha256 || ''))
    ? String(suppliedNativeRequestSha256)
    : requestDigest(request);
  const receiptRef = `native_provider_receipt_sha256:${crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        turnIdHash: state.turnIdHash,
        invocationId: activeAttempt.invocationId,
        provider: normalizedProvider,
        model: normalizedModel,
        status: normalizedStatus,
        snapshotHash,
        nativeRequestSha256,
        observedAtMs: nowMs,
      }),
    )
    .digest('hex')}`;
  const receipt = {
    receiptRef,
    provider: normalizedProvider || 'unknown',
    model: normalizedModel || 'unknown',
    status: Number.isInteger(normalizedStatus) ? normalizedStatus : 0,
    snapshotHash,
    nativeRequestSha256,
    capsuleOccurrenceCount,
    mainInstructionOccurrenceCount,
    eligibleForMainReceipt,
    observedAtMs: nowMs,
  };
  activeAttempt.nativeReceipts.push(receipt);
  const acceptedEvent = logTimingEvent({
    event: 'viventium_text_main_native_provider_request_accepted',
    turnIdHash: state.turnIdHash,
    invocationId: activeAttempt.invocationId,
    attemptIndex: activeAttempt.attemptIndex,
    ...receipt,
    fromTurnStartMs: timingDuration(state.turnStartedAtMs, nowMs),
    fromAttemptStartMs: timingDuration(activeAttempt.startedAtMs, nowMs),
  });
  if (eligibleForMainReceipt && activeAttempt.outputKinds.size > 0) {
    const outputKind = activeAttempt.outputKinds.has('visible_text_delta')
      ? 'visible_text_delta'
      : Array.from(activeAttempt.outputKinds)[0];
    logWinningNativeReceipt(state, activeAttempt, nowMs, outputKind);
  }
  return acceptedEvent;
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

function findLatestMainAttempt(state, metadata) {
  const exact = findMainAttempt(state, metadata);
  if (exact) return exact;
  if (!isMainMetadata(state, metadata)) return null;
  return (
    Array.from(state.attemptsByInvocationHash.values()).sort(
      (left, right) => right.attemptIndex - left.attemptIndex,
    )[0] || null
  );
}

function boundedCount(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 10_000);
}

function markMainProviderAttemptEnd(
  req,
  metadata = {},
  { nowMs = Date.now(), toolCallCount = 0 } = {},
) {
  const state = req?._viventiumTextTurnTiming;
  if (!state || !Number.isFinite(nowMs)) return null;
  const attempt = findMainAttempt(state, metadata);
  if (!attempt || attempt.endedAtMs != null) return null;
  attempt.endedAtMs = nowMs;
  attempt.toolCallCount = boundedCount(toolCallCount);
  return logTimingEvent({
    event: 'viventium_text_main_provider_attempt_end',
    turnIdHash: state.turnIdHash,
    invocationId: attempt.invocationId,
    attemptIndex: attempt.attemptIndex,
    providerAttemptIdHash: attempt.providerAttemptIdHash,
    toolCallCount: attempt.toolCallCount,
    observedAtMs: nowMs,
    fromTurnStartMs: timingDuration(state.turnStartedAtMs, nowMs),
    fromAttemptStartMs: timingDuration(attempt.startedAtMs, nowMs),
  });
}

function toolContextHash(attempt, metadata) {
  return hashTimingId(JSON.stringify([attempt.invocationId, metadataInvocationHash(metadata)]));
}

function markMainToolStart(req, metadata = {}, { nowMs = Date.now(), toolInvocationId } = {}) {
  const state = req?._viventiumTextTurnTiming;
  if (!state || !Number.isFinite(nowMs)) return null;
  const attempt = findLatestMainAttempt(state, metadata);
  if (!attempt) return null;
  const contextHash = toolContextHash(attempt, metadata);
  const suppliedToolIdHash = hashTimingId(toolInvocationId);
  const suppliedKey = `${contextHash}:${suppliedToolIdHash}`;
  if (suppliedToolIdHash !== 'none' && state.seenToolStartKeys.has(suppliedKey)) {
    return null;
  }
  state.toolSequence += 1;
  const toolIndex = state.toolSequence;
  const toolInvocationIdHash = hashTimingId(
    JSON.stringify([
      state.turnIdHash,
      attempt.attemptIndex,
      contextHash,
      suppliedToolIdHash,
      toolIndex,
    ]),
  );
  const tool = {
    attempt,
    contextHash,
    suppliedToolIdHash,
    toolIndex,
    toolInvocationIdHash,
    startedAtMs: nowMs,
  };
  const openTools = state.openToolsByContextHash.get(contextHash) || [];
  openTools.push(tool);
  state.openToolsByContextHash.set(contextHash, openTools);
  if (suppliedToolIdHash !== 'none') {
    state.seenToolStartKeys.add(suppliedKey);
  }
  return logTimingEvent({
    event: 'viventium_text_main_tool_start',
    turnIdHash: state.turnIdHash,
    invocationId: attempt.invocationId,
    attemptIndex: attempt.attemptIndex,
    toolIndex,
    toolInvocationIdHash,
    observedAtMs: nowMs,
    fromTurnStartMs: timingDuration(state.turnStartedAtMs, nowMs),
    fromAttemptStartMs: timingDuration(attempt.startedAtMs, nowMs),
  });
}

function markMainToolEnd(req, metadata = {}, { nowMs = Date.now(), toolInvocationId } = {}) {
  const state = req?._viventiumTextTurnTiming;
  if (!state || !Number.isFinite(nowMs)) return null;
  const attempt = findLatestMainAttempt(state, metadata);
  if (!attempt) return null;
  let contextHash = toolContextHash(attempt, metadata);
  const suppliedToolIdHash = hashTimingId(toolInvocationId);
  let openTools = state.openToolsByContextHash.get(contextHash) || [];
  let toolIndex =
    suppliedToolIdHash === 'none'
      ? 0
      : openTools.findIndex((tool) => tool.suppliedToolIdHash === suppliedToolIdHash);
  let tool = toolIndex >= 0 ? openTools[toolIndex] : null;
  if (!tool) {
    const candidates = [];
    for (const [candidateContextHash, candidateTools] of state.openToolsByContextHash.entries()) {
      candidateTools.forEach((candidate, candidateIndex) => {
        if (
          candidate.attempt.invocationId === attempt.invocationId &&
          (suppliedToolIdHash === 'none' || candidate.suppliedToolIdHash === suppliedToolIdHash)
        ) {
          candidates.push({
            candidate,
            candidateContextHash,
            candidateIndex,
            candidateTools,
          });
        }
      });
    }
    if (candidates.length !== 1) return null;
    const selected = candidates[0];
    contextHash = selected.candidateContextHash;
    openTools = selected.candidateTools;
    toolIndex = selected.candidateIndex;
    tool = selected.candidate;
  }
  if (!tool) return null;
  openTools.splice(toolIndex, 1);
  if (openTools.length === 0) {
    state.openToolsByContextHash.delete(contextHash);
  }
  return logTimingEvent({
    event: 'viventium_text_main_tool_end',
    turnIdHash: state.turnIdHash,
    invocationId: tool.attempt.invocationId,
    attemptIndex: tool.attempt.attemptIndex,
    toolIndex: tool.toolIndex,
    toolInvocationIdHash: tool.toolInvocationIdHash,
    observedAtMs: nowMs,
    fromTurnStartMs: timingDuration(state.turnStartedAtMs, nowMs),
    fromAttemptStartMs: timingDuration(tool.attempt.startedAtMs, nowMs),
  });
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
  const outputEvent = logTimingEvent({
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
  logWinningNativeReceipt(state, attempt, nowMs, outputKind);
  return outputEvent;
}

module.exports = {
  TEXT_TURN_TIMING_PREFIX,
  hashTimingId,
  initializeTextTurnTiming,
  markTextTurnBoundary,
  markMainProviderAttemptEnd,
  markMainProviderAttemptStart,
  markMainProviderFirstOutput,
  markMainToolEnd,
  markMainToolStart,
  recordNativeProviderRequestAccepted,
  setTextMainNativeRequestAuthority,
  setTextMainRunContext,
};

/* === VIVENTIUM END === */
