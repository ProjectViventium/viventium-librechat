/* === VIVENTIUM START ===
 * Feature: Voice latency timing helpers.
 * Purpose: Keep voice latency logs on a monotonic high-resolution clock while preserving
 * existing integer millisecond fields for grep/backward compatibility.
 * Added: 2026-05-19
 * === VIVENTIUM END === */

const { performance } = require('perf_hooks');
const crypto = require('crypto');

const WALL_CLOCK_THRESHOLD_MS = 1_000_000_000_000;

function voiceLatencyNow() {
  return performance.now();
}

function markVoiceLatencyStart(req, requestId = '') {
  if (!req || typeof req !== 'object') {
    return;
  }
  req.viventiumVoiceStartAt = Date.now();
  req.viventiumVoicePerfStartAt = voiceLatencyNow();
  req.viventiumVoiceRequestId = requestId;
  req.viventiumVoiceLogLatency = true;
}

function calcVoiceLatencyDurationMs(startedAt) {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
    return null;
  }
  const now = startedAt > WALL_CLOCK_THRESHOLD_MS ? Date.now() : voiceLatencyNow();
  const delta = now - startedAt;
  return delta >= 0 ? delta : 0;
}

function getVoiceLatencyTotalMs(req) {
  if (typeof req?.viventiumVoicePerfStartAt === 'number') {
    return calcVoiceLatencyDurationMs(req.viventiumVoicePerfStartAt);
  }
  if (typeof req?.viventiumVoiceStartAt === 'number') {
    return calcVoiceLatencyDurationMs(req.viventiumVoiceStartAt);
  }
  return null;
}

function formatVoiceMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value.toFixed(3);
}

function formatVoiceLatencyTiming(req, stageStartAt = null) {
  const totalMs = getVoiceLatencyTotalMs(req);
  const stageMs = calcVoiceLatencyDurationMs(stageStartAt);
  const parts = [];

  if (totalMs != null) {
    parts.push(`total_ms=${Math.round(totalMs)}`);
    parts.push(`total_ms_f=${formatVoiceMs(totalMs)}`);
  }

  if (stageMs != null) {
    parts.push(`stage_ms=${Math.round(stageMs)}`);
    parts.push(`stage_ms_f=${formatVoiceMs(stageMs)}`);
  }

  return parts.join(' ');
}

function formatVoiceLatencyDurationFields(prefix, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '';
  }
  return `${prefix}_ms=${Math.round(value)} ${prefix}_ms_f=${formatVoiceMs(value)}`;
}

/* === VIVENTIUM START ===
 * Feature: Content-free numeric Voice stage telemetry.
 * Purpose: Retain timing fields when the existing info message is truncated.
 */
function logVoiceLatencyNumericStage(
  logger,
  req,
  source,
  stage,
  stageStartAt = null,
  requestSha256 = null,
) {
  if (req?.viventiumVoiceLogLatency !== true) {
    return;
  }
  const totalMs = getVoiceLatencyTotalMs(req);
  const stageMs = calcVoiceLatencyDurationMs(stageStartAt);
  logger.debug('[VoiceLatency][LC][Timing]', {
    source,
    stage,
    ...(typeof requestSha256 === 'string'
      ? { request_sha256: requestSha256 }
      : {
          request_id:
            typeof req.viventiumVoiceRequestId === 'string'
              ? req.viventiumVoiceRequestId
              : 'unknown',
        }),
    ...(totalMs == null
      ? {}
      : {
          total_ms: Math.round(totalMs),
          total_ms_f: Number(totalMs.toFixed(3)),
        }),
    ...(stageMs == null
      ? {}
      : {
          stage_ms: Math.round(stageMs),
          stage_ms_f: Number(stageMs.toFixed(3)),
        }),
  });
}
/* === VIVENTIUM END === */

/* === VIVENTIUM START === Passive owner timing; no result or error content enters logs. === */
function observeVoiceLatencyOperation(logger, req, source, stage, operation) {
  if (req?.viventiumVoiceLogLatency !== true) return operation();
  const startedAt = voiceLatencyNow();
  const record = (outcome) => {
    try {
      const requestHash = crypto
        .createHash('sha256')
        .update(String(req.viventiumVoiceRequestId || 'unknown'))
        .digest('hex');
      logVoiceLatencyNumericStage(
        logger,
        req,
        source,
        `${stage}_${outcome}`,
        startedAt,
        requestHash,
      );
    } catch {
      // Passive measurements cannot change user data, authorization, or execution outcome.
    }
  };
  let result;
  try {
    result = operation();
  } catch (error) {
    record('failed');
    throw error;
  }
  if (!result || typeof result.then !== 'function') {
    record('completed');
    return result;
  }
  return Promise.resolve(result).then(
    (value) => {
      record('completed');
      return value;
    },
    (error) => {
      record('failed');
      throw error;
    },
  );
}
/* === VIVENTIUM END === */

module.exports = {
  observeVoiceLatencyOperation,
  calcVoiceLatencyDurationMs,
  formatVoiceLatencyDurationFields,
  formatVoiceLatencyTiming,
  logVoiceLatencyNumericStage,
  getVoiceLatencyTotalMs,
  markVoiceLatencyStart,
  voiceLatencyNow,
};
