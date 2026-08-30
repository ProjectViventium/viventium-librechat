/* === VIVENTIUM START ===
 * Feature: Feelings structured observability.
 * Purpose: One public-safe event contract across API, prompt injection, detached appraisal, and DB.
 * Raw prompts, user text, reaction output, and account identifiers are never logged here.
 * === VIVENTIUM END === */

const crypto = require('crypto');

function feelingsRequestId(req) {
  return (
    req?.id ||
    req?.body?.traceId ||
    req?.viventiumVoiceRequestId ||
    req?.body?.viventiumLogicalTurnId ||
    req?.body?.turnId ||
    req?.body?.messageId ||
    req?.body?.message_id ||
    req?.body?.viventiumSourceEventId ||
    req?._resumableStreamId ||
    'unknown'
  );
}

const MAX_SERIALIZED_EVENT_CHARS = 90;
const MAX_TELEMETRY_DROP_CODES = 24;
const SAFE_FEELINGS_EVENTS = new Set([
  'feelings.api.conflict',
  'feelings.api.delete',
  'feelings.api.failure',
  'feelings.api.read',
  'feelings.api.write',
  'feelings.inject.background',
  'feelings.inject.complete',
  'feelings.inject.final_run',
  'feelings.read.complete',
  'feelings.read.failure',
  'feelings.read.skip',
  'feelings.reaction.activation',
  'feelings.reaction.deduplicated',
  'feelings.reaction.detached_failure',
  'feelings.reaction.failure',
  'feelings.reaction.model',
  'feelings.reaction.parse',
  'feelings.reaction.schedule',
  'feelings.reaction.schedule_skip',
  'feelings.reaction.skip',
  'feelings.reaction.start',
  'feelings.reaction.write',
  'feelings.reaction.write_conflict',
  'feelings.telemetry.rejected',
  'feelings.worker.inject',
]);
const BOOLEAN_FIELDS = new Set([
  'cacheHit',
  'deleted',
  'enabled',
  'fallbackUsed',
  'fast',
  'hasInnerState',
  'injected',
  'innerStateUpdated',
  'ok',
  'presentInFinalRun',
  'rangePromptOverrideChanged',
  'rangePromptOverridePresent',
  'retrying',
  'shouldActivate',
]);
const NONNEGATIVE_NUMBER_FIELDS = new Set([
  'activeRangePromptOverrideChars',
  'activeRangePromptOverrideCount',
  'attempt',
  'cachedCapsuleLength',
  'capsuleLength',
  'capsuleOccurrenceCount',
  'changedBandCount',
  'commitAttempt',
  'confidence',
  'durationMs',
  'expectedVersion',
  'injectedAgentCount',
  'innerStateLength',
  'operationCount',
  'participatingAgentCount',
  'pinnedAgentCount',
  'rangePromptOverrideCount',
  'runInstructionCapsuleCount',
  'runInstructionLength',
  'skippedAgentCount',
  'trailingInstructionChars',
  'version',
]);
const ENUM_FIELDS = Object.freeze({
  scope: new Set(['all_agents', 'conscious_agent', 'unknown']),
  placement: new Set(['absent', 'final_instruction_layer', 'followed_by_runtime_contracts']),
  activationMode: new Set(['always', 'classified', 'disabled']),
  route: new Set([
    '/',
    '/bands/:bandId',
    '/profile',
    '/reset',
    'GET /',
    'PATCH /bands/:bandId',
    'PATCH /profile',
    'glasshive_worker_agents_md',
    'glasshive_worker_claude_md',
    'glasshive_worker_codex_md',
    'in_process_participant',
    'main_conscious_agent',
    'phase_b_followup',
    'unknown',
  ]),
  reason: new Set([
    'access_check_failed',
    'activation_disabled',
    'activated',
    'already_processed',
    'always',
    'capsule_not_applied',
    'capsule_unavailable',
    'conscious_synthesis',
    'disabled',
    'disabled_while_queued',
    'disabled_while_running',
    'empty_stimulus',
    'feelings_disabled',
    'injected',
    'internal_origin',
    'missing_user',
    'no_visible_reply',
    'not_activated',
    'operator_unavailable',
    'preserved_in_conversation_session',
    'read_failed',
    'snapshot_unavailable',
    'specialist_cortex_independent',
    'temporary_eval_isolation',
    'version_conflict',
    'writer_exception',
  ]),
});
const TOKEN_FIELDS = new Set([
  'agentIdHash',
  'bandId',
  'errorClass',
  'fallbackModel',
  'fallbackProvider',
  'innerStateSkipReason',
  'model',
  'primaryErrorClass',
  'provider',
  'rangeLevelId',
  'reasoningEffort',
  'serviceTier',
  'stimulusKey',
  'usedModel',
  'usedProvider',
  'usedServiceTier',
]);
const COUNT_MAP_FIELDS = new Set([
  'absoluteDeltaCounts',
  'causeCounts',
  'deltaMagnitudeCounts',
  'strengthCounts',
]);
/* This is deliberately a positive allowlist, not a blacklist. A new telemetry field must be
 * reviewed here before it can reach either the structured transport or the formatted log line. */
const SAFE_FEELINGS_TELEMETRY_FIELDS = new Set([
  'absoluteDeltaCounts',
  'activationMode',
  'activeRangePromptOverrideChars',
  'activeRangePromptOverrideCount',
  'agentIdHash',
  'attempt',
  'cacheHit',
  'capsuleOccurrenceCount',
  'cachedCapsuleLength',
  'capsuleLength',
  'causeCounts',
  'changedBandCount',
  'commitAttempt',
  'confidence',
  'deleted',
  'durationMs',
  'enabled',
  'errorClass',
  'expectedVersion',
  'fallbackModel',
  'fallbackProvider',
  'fallbackUsed',
  'fast',
  'bandId',
  'hasInnerState',
  'injected',
  'injectedAgentCount',
  'innerStateLength',
  'innerStateSkipReason',
  'innerStateUpdated',
  'issues',
  'model',
  'ok',
  'operationCount',
  'participatingAgentCount',
  'placement',
  'presentInFinalRun',
  'pinnedAgentCount',
  'primaryErrorClass',
  'provider',
  'reason',
  'reasoningEffort',
  'rangeLevelId',
  'rangePromptOverrideChanged',
  'rangePromptOverrideCount',
  'rangePromptOverridePresent',
  'retrying',
  'route',
  'runInstructionCapsuleCount',
  'runInstructionLength',
  'scope',
  'serviceTier',
  'shouldActivate',
  'skippedAgentCount',
  'snapshotHash',
  'strengthCounts',
  // Legacy input is still accepted by the public-safe logger, but runtime emitters use
  // `absoluteDeltaCounts` as the canonical field.
  'deltaMagnitudeCounts',
  'stimulusKey',
  'trailingInstructionChars',
  'telemetryFieldDropCodes',
  'usedModel',
  'usedProvider',
  'usedServiceTier',
  'version',
  'causes',
]);
const EVENT_INSTANCE_NONCE = crypto.randomBytes(4).toString('base64url');
let eventSequence = 0;

function safeToken(value, maxLength = 80) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[a-z0-9][a-z0-9._:/-]*$/.test(value)
  );
}

function safeCountMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 16) return null;
  if (
    !entries.every(
      ([key, count]) =>
        safeToken(String(key), 32) &&
        Number.isFinite(count) &&
        Number(count) >= 0 &&
        Number(count) <= 1_000_000,
    )
  ) {
    return null;
  }
  return Object.fromEntries(entries.map(([key, count]) => [key, Number(count)]));
}

function sanitizeTelemetryField(key, value) {
  if (value == null) return { omit: true };
  if (BOOLEAN_FIELDS.has(key)) {
    return typeof value === 'boolean' ? { value } : { invalid: true };
  }
  if (NONNEGATIVE_NUMBER_FIELDS.has(key)) {
    return Number.isFinite(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000
      ? { value: Number(value) }
      : { invalid: true };
  }
  if (ENUM_FIELDS[key]) {
    return typeof value === 'string' && ENUM_FIELDS[key].has(value) ? { value } : { invalid: true };
  }
  if (TOKEN_FIELDS.has(key)) {
    return safeToken(value) ? { value } : { invalid: true };
  }
  if (key === 'snapshotHash') {
    return typeof value === 'string' && /^(?:[a-f0-9]{64}|none)$/.test(value)
      ? { value }
      : { invalid: true };
  }
  if (COUNT_MAP_FIELDS.has(key)) {
    const safe = safeCountMap(value);
    return safe ? { value: safe } : { invalid: true };
  }
  if (key === 'issues' || key === 'causes') {
    return Array.isArray(value) && value.length <= 16 && value.every((item) => safeToken(item, 48))
      ? { value: [...value] }
      : { invalid: true };
  }
  return { invalid: true };
}

function sanitizeTelemetryFields(fields) {
  const safe = {};
  const dropCodes = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FEELINGS_TELEMETRY_FIELDS.has(key) || key === 'telemetryFieldDropCodes') continue;
    const result = sanitizeTelemetryField(key, value);
    if (result.omit) continue;
    if (result.invalid) {
      if (dropCodes.length < MAX_TELEMETRY_DROP_CODES) dropCodes.push(`${key}_invalid`);
      continue;
    }
    safe[key] = result.value;
  }
  if (dropCodes.length > 0) safe.telemetryFieldDropCodes = dropCodes;
  return safe;
}

function summarizeFeelingCapsulePlacement({ instructions, capsule }) {
  const finalInstructions = typeof instructions === 'string' ? instructions : '';
  const feelingCapsule = typeof capsule === 'string' ? capsule : '';
  const openingPrefix = '<viventium_feeling_state';
  const closingTag = '</viventium_feeling_state>';
  let structuralCapsuleCount = 0;
  let structuralSearchFrom = 0;
  let lastStructuralEnd = -1;
  while (structuralSearchFrom < finalInstructions.length) {
    const opening = finalInstructions.indexOf(openingPrefix, structuralSearchFrom);
    if (opening < 0) break;
    structuralCapsuleCount += 1;
    const closing = finalInstructions.indexOf(closingTag, opening + openingPrefix.length);
    if (closing >= 0) lastStructuralEnd = closing + closingTag.length;
    structuralSearchFrom = opening + openingPrefix.length;
  }

  let exactCapsuleCount = 0;
  let searchFrom = 0;
  let lastEnd = -1;
  while (feelingCapsule && searchFrom <= finalInstructions.length) {
    const index = finalInstructions.indexOf(feelingCapsule, searchFrom);
    if (index < 0) break;
    exactCapsuleCount += 1;
    lastEnd = index + feelingCapsule.length;
    searchFrom = lastEnd;
  }

  const capsuleOccurrenceCount = Math.max(structuralCapsuleCount, exactCapsuleCount);
  const presentInFinalRun = feelingCapsule ? exactCapsuleCount > 0 : structuralCapsuleCount > 0;
  const effectiveLastEnd = lastEnd >= 0 ? lastEnd : lastStructuralEnd;
  const trailingInstructionChars = presentInFinalRun
    ? finalInstructions.slice(effectiveLastEnd).trim().length
    : 0;
  return {
    presentInFinalRun,
    capsuleOccurrenceCount,
    placement: presentInFinalRun
      ? trailingInstructionChars > 0
        ? 'followed_by_runtime_contracts'
        : 'final_instruction_layer'
      : 'absent',
    trailingInstructionChars,
  };
}

function requestHash(requestId) {
  return crypto
    .createHash('sha256')
    .update(String(requestId || 'unknown'))
    .digest('hex')
    .slice(0, 8);
}

function nextEventInstanceId() {
  eventSequence += 1;
  return `${EVENT_INSTANCE_NONCE}.${eventSequence.toString(36)}`;
}

function splitEventPayload(payload, envelope = {}) {
  const instanceId = String(envelope.instanceId || nextEventInstanceId());
  const correlation = String(envelope.requestHash || requestHash(payload.requestId));
  const fields = Object.entries(payload).filter(([key]) => key !== 'requestId');
  const contentChunks = [];
  let current = {};
  for (const [key, value] of fields) {
    const candidate = { ...current, [key]: value };
    const estimatedEnvelope = { i: instanceId, r: correlation, p: 99, n: 99, ...candidate };
    if (
      Object.keys(current).length > 0 &&
      JSON.stringify(estimatedEnvelope).length > MAX_SERIALIZED_EVENT_CHARS
    ) {
      contentChunks.push(current);
      current = { [key]: value };
    } else {
      current = candidate;
    }
  }
  contentChunks.push(current);
  const partCount = contentChunks.length;
  return contentChunks.map((chunk, index) => ({
    i: instanceId,
    r: correlation,
    p: index + 1,
    n: partCount,
    ...chunk,
  }));
}

function logFeelingsEvent(logger, req, event, fields = {}, level = 'info') {
  const method = typeof logger?.[level] === 'function' ? logger[level].bind(logger) : logger?.info;
  if (typeof method !== 'function') return;
  const safeEvent = SAFE_FEELINGS_EVENTS.has(event) ? event : 'feelings.telemetry.rejected';
  const safeFields = sanitizeTelemetryFields(fields);
  if (safeEvent !== event) {
    safeFields.telemetryFieldDropCodes = [
      'event_invalid',
      ...(safeFields.telemetryFieldDropCodes || []),
    ].slice(0, MAX_TELEMETRY_DROP_CODES);
  }
  const payload = { event: safeEvent, ...safeFields, requestId: feelingsRequestId(req) };
  /* The active Winston text formatter omits metadata-only arguments. Keep the same structured
   * object for transports that retain metadata, and serialize this public-safe envelope into the
   * message so local file logs preserve the complete event contract too. */
  for (const chunk of splitEventPayload(payload)) {
    method(`[VIVENTIUM][Feelings] ${JSON.stringify(chunk)}`, chunk);
  }
}

module.exports = {
  feelingsRequestId,
  logFeelingsEvent,
  splitEventPayload,
  summarizeFeelingCapsulePlacement,
};
