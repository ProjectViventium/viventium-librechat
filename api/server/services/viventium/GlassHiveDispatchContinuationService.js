/* === VIVENTIUM START ===
 * Feature: durable voice continuation handoff
 * Purpose: Convert only a structured, callback-backed GlassHive dispatch acknowledgement into
 * an active VoiceTask continuation fence. Human-facing tool text is never parsed for authority.
 * === VIVENTIUM END === */

const MIN_CALLBACK_DEADLINE_SECONDS = 60;
const MAX_CALLBACK_DEADLINE_SECONDS = 45 * 24 * 60 * 60;

function findGlassHiveCallbackDispatch(result) {
  const pending = [result];
  const seen = new Set();
  while (pending.length > 0 && seen.size < 64) {
    const value = pending.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (
      !Array.isArray(value) &&
      (value.status === 'dispatched' || value.status === 'queued') &&
      value.callback_ready === true &&
      Number.isSafeInteger(value.callback_delivery_deadline_seconds) &&
      value.callback_delivery_deadline_seconds >= MIN_CALLBACK_DEADLINE_SECONDS &&
      value.callback_delivery_deadline_seconds <= MAX_CALLBACK_DEADLINE_SECONDS
    ) {
      return value;
    }
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    for (const key of ['structuredContent', 'structured_content', 'artifact', 'data', 'result']) {
      if (value[key] && typeof value[key] === 'object') pending.push(value[key]);
    }
  }
  return null;
}

function glassHiveCallbackDispatchAccepted(result) {
  return Boolean(findGlassHiveCallbackDispatch(result));
}

async function markCallbackBackedVoiceContinuation({ result, requestBody, continuationKey } = {}) {
  const taskId =
    typeof requestBody?.viventiumVoiceTaskId === 'string'
      ? requestBody.viventiumVoiceTaskId.trim()
      : '';
  const dispatch = findGlassHiveCallbackDispatch(result);
  if (requestBody?.voiceMode !== true || !taskId || !dispatch) {
    return null;
  }
  const {
    flushVoiceTaskPersistence,
    markVoiceTaskAwaitingOwnerResult,
  } = require('./VoiceTaskService');
  const event = markVoiceTaskAwaitingOwnerResult(
    taskId,
    `glasshive_dispatch:${String(continuationKey || 'launch')
      .trim()
      .slice(0, 160)}`,
    { deadlineAtMs: Date.now() + dispatch.callback_delivery_deadline_seconds * 1000 },
  );
  await flushVoiceTaskPersistence();
  return event;
}

module.exports = {
  glassHiveCallbackDispatchAccepted,
  markCallbackBackedVoiceContinuation,
};
