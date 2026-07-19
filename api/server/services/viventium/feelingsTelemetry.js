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
    req?._resumableStreamId ||
    'unknown'
  );
}

const MAX_SERIALIZED_EVENT_CHARS = 90;
/* This is deliberately a positive allowlist, not a blacklist. A new telemetry field must be
 * reviewed here before it can reach either the structured transport or the formatted log line. */
const SAFE_FEELINGS_TELEMETRY_FIELDS = new Set([
  'absoluteDeltaCounts',
  'activationMode',
  'agentIdHash',
  'attempt',
  'cacheHit',
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
  'primaryErrorClass',
  'provider',
  'reason',
  'reasoningEffort',
  'retrying',
  'route',
  'scope',
  'serviceTier',
  'shouldActivate',
  'skippedAgentCount',
  'snapshotHash',
  'stimulusKey',
  'strengthCounts',
  'usedModel',
  'usedProvider',
  'usedServiceTier',
  'version',
  'causes',
]);
let eventSequence = 0;

function requestHash(requestId) {
  return crypto
    .createHash('sha256')
    .update(String(requestId || 'unknown'))
    .digest('hex')
    .slice(0, 8);
}

function nextEventInstanceId() {
  eventSequence += 1;
  return eventSequence.toString(36);
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
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter(([key]) => SAFE_FEELINGS_TELEMETRY_FIELDS.has(key)),
  );
  const payload = { event, ...safeFields, requestId: feelingsRequestId(req) };
  /* The active Winston text formatter omits metadata-only arguments. Keep the same structured
   * object for transports that retain metadata, and serialize this public-safe envelope into the
   * message so local file logs preserve the complete event contract too. */
  for (const chunk of splitEventPayload(payload)) {
    method(`[VIVENTIUM][Feelings] ${JSON.stringify(chunk)}`, chunk);
  }
}

module.exports = { feelingsRequestId, logFeelingsEvent, splitEventPayload };
