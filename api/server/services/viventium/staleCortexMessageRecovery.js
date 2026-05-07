/* === VIVENTIUM START ===
 * Feature: Stale background cortex message recovery.
 *
 * Purpose:
 * - Phase B is intentionally asynchronous and process-local while it runs.
 * - If the API process restarts after activation rows are persisted but before Phase B finalizes,
 *   those rows can otherwise remain "activating"/"brewing" forever.
 * - On startup, repair old active cortex rows to terminal error state and clear unfinished so every
 *   surface has honest DB state instead of a permanent progress indicator.
 * === VIVENTIUM END === */

const { ContentTypes } = require('librechat-data-provider');
const { logger } = require('@librechat/data-schemas');
const { Message } = require('~/db/models');
const { getDeferredFallbackErrorText } = require('~/server/services/viventium/cortexFallbackText');
const { isRuntimeHoldTextPart } = require('~/server/services/viventium/runtimeHoldText');

const ACTIVE_CORTEX_STATUSES = new Set(['activating', 'brewing', 'processing', 'running']);
const CORTEX_TYPES = new Set([
  ContentTypes.CORTEX_ACTIVATION,
  ContentTypes.CORTEX_BREWING,
  ContentTypes.CORTEX_INSIGHT,
]);
const DEFAULT_CORTEX_EXECUTION_TIMEOUT_MS = 180_000;
const DEFAULT_STALE_RECOVERY_GRACE_MS = 60_000;

function parsePositiveInt(value) {
  const parsed = parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getConfiguredCortexExecutionTimeoutMs() {
  return parsePositiveInt(process.env.VIVENTIUM_CORTEX_EXECUTION_TIMEOUT_MS) ||
    DEFAULT_CORTEX_EXECUTION_TIMEOUT_MS;
}

function getStaleCortexRecoveryConfig() {
  const configuredTimeoutMs = parsePositiveInt(process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_MS);
  const cortexExecutionTimeoutMs = getConfiguredCortexExecutionTimeoutMs();
  const graceMs =
    parsePositiveInt(process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_GRACE_MS) ||
    DEFAULT_STALE_RECOVERY_GRACE_MS;
  const minimumTimeoutMs = cortexExecutionTimeoutMs + graceMs;
  const rawLimit = Number(process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_LIMIT);
  return {
    timeoutMs: Math.max(configuredTimeoutMs || 0, minimumTimeoutMs),
    limit: Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100,
    cortexExecutionTimeoutMs,
    graceMs,
  };
}

function isActiveCortexPart(part) {
  if (!part || typeof part !== 'object' || !CORTEX_TYPES.has(part.type)) {
    return false;
  }
  const status = String(part.status || '').trim().toLowerCase();
  if (status) {
    return ACTIVE_CORTEX_STATUSES.has(status);
  }
  return part.type !== ContentTypes.CORTEX_INSIGHT;
}

function shouldReplaceHoldText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.some((part) => isRuntimeHoldTextPart(part));
}

function recoverCortexContent(content, nowIso) {
  if (!Array.isArray(content)) {
    return { changed: false, content };
  }

  let changed = false;
  const recovered = content.map((part) => {
    if (!isActiveCortexPart(part)) {
      return part;
    }
    changed = true;
    return {
      ...part,
      status: 'error',
      error: part.error || 'Background processing did not finish before runtime recovery.',
      status_changed_at: nowIso,
      recovered_at: nowIso,
      recovery_reason: 'stale_cortex_startup_recovery',
    };
  });

  return { changed, content: recovered };
}

async function recoverStaleCortexMessages({ now = new Date() } = {}) {
  const { timeoutMs, limit, cortexExecutionTimeoutMs, graceMs } = getStaleCortexRecoveryConfig();
  const cutoff = new Date(now.getTime() - timeoutMs);
  const nowIso = now.toISOString();

  const messages = await Message.find({
    isCreatedByUser: false,
    createdAt: { $lt: cutoff },
    $or: [
      { unfinished: true },
      { 'content.type': { $in: Array.from(CORTEX_TYPES) } },
    ],
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  let repaired = 0;
  for (const message of messages) {
    const recovery = recoverCortexContent(message.content, nowIso);
    if (!recovery.changed && message.unfinished !== true) {
      continue;
    }

    const update = {
      unfinished: false,
      content: recovery.content,
    };
    const fallbackText = getDeferredFallbackErrorText({
      scheduleId: message?.metadata?.viventium?.scheduleId || '',
      recoveryReason: 'stale_cortex_startup_recovery',
    });
    if (fallbackText && shouldReplaceHoldText(message)) {
      update.text = fallbackText;
    }

    const result = await Message.updateOne(
      { _id: message._id, updatedAt: message.updatedAt },
      { $set: update },
    );
    if (result?.modifiedCount > 0) {
      repaired += 1;
    }
  }

  if (repaired > 0) {
    logger.warn(
      `[staleCortexMessageRecovery] Repaired ${repaired} stale background cortex message(s) ` +
        `older than ${timeoutMs}ms (execution_timeout_ms=${cortexExecutionTimeoutMs}, grace_ms=${graceMs})`,
    );
  } else {
    logger.info(
      `[staleCortexMessageRecovery] No stale background cortex messages found ` +
        `(timeout_ms=${timeoutMs}, execution_timeout_ms=${cortexExecutionTimeoutMs}, grace_ms=${graceMs})`,
    );
  }

  return { scanned: messages.length, repaired, timeoutMs, limit, cortexExecutionTimeoutMs, graceMs };
}

module.exports = {
  ACTIVE_CORTEX_STATUSES,
  getConfiguredCortexExecutionTimeoutMs,
  recoverCortexContent,
  recoverStaleCortexMessages,
  getStaleCortexRecoveryConfig,
  isActiveCortexPart,
};
