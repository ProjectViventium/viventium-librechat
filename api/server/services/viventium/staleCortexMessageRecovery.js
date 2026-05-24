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
const DEFAULT_STALE_RECOVERY_INTERVAL_MS = 60_000;

function parsePositiveInt(value) {
  const parsed = parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getConfiguredCortexExecutionTimeoutMs() {
  return (
    parsePositiveInt(process.env.VIVENTIUM_CORTEX_EXECUTION_TIMEOUT_MS) ||
    DEFAULT_CORTEX_EXECUTION_TIMEOUT_MS
  );
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

function getStaleCortexRecoveryIntervalMs() {
  const parsed = parsePositiveInt(process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_INTERVAL_MS);
  return parsed || DEFAULT_STALE_RECOVERY_INTERVAL_MS;
}

function isActiveCortexPart(part) {
  if (!part || typeof part !== 'object' || !CORTEX_TYPES.has(part.type)) {
    return false;
  }
  const status = String(part.status || '')
    .trim()
    .toLowerCase();
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

/* === VIVENTIUM START ===
 * Feature: Recovered follow-up error-card cleanup.
 * Purpose: If Phase B already promoted useful visible text onto an empty primary answer, stale
 * provider error parts must be removed from that same message so the UI does not show both
 * recovery text and a fatal "Something went wrong" card.
 * === VIVENTIUM END === */
function stripErrorPartsFromRecoveredFollowUpContent(content) {
  if (!Array.isArray(content)) {
    return { changed: false, content, errorClasses: [] };
  }

  const errorClasses = [];
  const nextContent = [];
  let changed = false;
  for (const part of content) {
    if (part?.type === ContentTypes.ERROR) {
      changed = true;
      errorClasses.push(
        String(part.error_class || part.errorClass || part.code || 'completion_error'),
      );
      continue;
    }
    nextContent.push(part);
  }

  return { changed, content: nextContent, errorClasses };
}

/* === VIVENTIUM START ===
 * Feature: Deferred tool-cortex hold error cleanup.
 * Purpose: A deterministic runtime hold plus a later cortex follow-up is a successful async handoff,
 * not a failed provider response. If an older runtime persisted a generic completion error onto
 * that parent message, remove only that stale parent error after the follow-up exists.
 * === VIVENTIUM END === */
function stripDeferredHoldParentErrorParts(content) {
  if (!Array.isArray(content)) {
    return { changed: false, content, errorClasses: [] };
  }

  const hasRuntimeHold = content.some((part) => isRuntimeHoldTextPart(part));
  const hasCortexPart = content.some(
    (part) => part && typeof part === 'object' && CORTEX_TYPES.has(part.type),
  );
  if (!hasRuntimeHold || !hasCortexPart) {
    return { changed: false, content, errorClasses: [] };
  }

  let changed = false;
  const errorClasses = [];
  const nextContent = [];
  for (const part of content) {
    const errorClass = String(part?.error_class || part?.errorClass || part?.code || '').trim();
    const isStaleDeferredHoldError =
      part?.type === ContentTypes.ERROR &&
      (errorClass === 'completion_error' || errorClass === 'late_stream_termination');
    if (isStaleDeferredHoldError) {
      changed = true;
      errorClasses.push(errorClass);
      continue;
    }
    nextContent.push(part);
  }

  return { changed, content: nextContent, errorClasses };
}

async function recoverVisibleFollowUpErrorCards({ limit = 100 } = {}) {
  const messages = await Message.find({
    isCreatedByUser: false,
    text: { $type: 'string', $ne: '' },
    'metadata.viventium.type': 'cortex_followup',
    'metadata.viventium.promotedToEmptyParent': true,
    'content.type': ContentTypes.ERROR,
  })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();

  let repaired = 0;
  for (const message of messages) {
    const cleanup = stripErrorPartsFromRecoveredFollowUpContent(message.content);
    if (!cleanup.changed) {
      continue;
    }

    const existingViventium = message?.metadata?.viventium || {};
    const existingClasses = Array.isArray(existingViventium.recoveredPrimaryErrorClasses)
      ? existingViventium.recoveredPrimaryErrorClasses
      : [];
    const recoveredPrimaryErrorClasses = Array.from(
      new Set([...existingClasses, ...cleanup.errorClasses].filter(Boolean)),
    );

    const metadata = {
      ...(message.metadata || {}),
      viventium: {
        ...existingViventium,
        recoveredPrimaryErrorClasses,
      },
    };

    const result = await Message.updateOne(
      { _id: message._id, updatedAt: message.updatedAt },
      {
        $set: {
          content: cleanup.content,
          metadata,
          unfinished: false,
          error: false,
        },
      },
    );
    if (result?.modifiedCount > 0) {
      repaired += 1;
    }
  }

  if (repaired > 0) {
    logger.warn(
      `[staleCortexMessageRecovery] Removed stale visible error cards from ${repaired} recovered follow-up message(s)`,
    );
  }

  return { scanned: messages.length, repaired };
}

async function recoverDeferredHoldParentErrorCards({ limit = 100 } = {}) {
  const parents = await Message.find({
    isCreatedByUser: false,
    'content.viventium_runtime_hold': true,
    'content.type': ContentTypes.ERROR,
  })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();

  let repaired = 0;
  for (const parent of parents) {
    const cleanup = stripDeferredHoldParentErrorParts(parent.content);
    if (!cleanup.changed || !parent?.messageId) {
      continue;
    }

    const followUp = await Message.findOne(
      {
        isCreatedByUser: false,
        text: { $type: 'string', $ne: '' },
        error: { $ne: true },
        'metadata.viventium.type': 'cortex_followup',
        'metadata.viventium.parentMessageId': parent.messageId,
      },
      { _id: 1 },
    ).lean();
    if (!followUp) {
      continue;
    }

    const existingViventium = parent?.metadata?.viventium || {};
    const existingClasses = Array.isArray(existingViventium.recoveredDeferredHoldErrorClasses)
      ? existingViventium.recoveredDeferredHoldErrorClasses
      : [];
    const recoveredDeferredHoldErrorClasses = Array.from(
      new Set([...existingClasses, ...cleanup.errorClasses].filter(Boolean)),
    );
    const metadata = {
      ...(parent.metadata || {}),
      viventium: {
        ...existingViventium,
        recoveredDeferredHoldErrorClasses,
      },
    };

    const result = await Message.updateOne(
      { _id: parent._id, updatedAt: parent.updatedAt },
      {
        $set: {
          content: cleanup.content,
          metadata,
          unfinished: false,
          error: false,
        },
      },
    );
    if (result?.modifiedCount > 0) {
      repaired += 1;
    }
  }

  if (repaired > 0) {
    logger.warn(
      `[staleCortexMessageRecovery] Removed stale deferred-hold parent error cards from ${repaired} message(s)`,
    );
  }

  return { scanned: parents.length, repaired };
}

async function recoverStaleCortexMessages({ now = new Date() } = {}) {
  const { timeoutMs, limit, cortexExecutionTimeoutMs, graceMs } = getStaleCortexRecoveryConfig();
  const cutoff = new Date(now.getTime() - timeoutMs);
  const nowIso = now.toISOString();

  const messages = await Message.find({
    isCreatedByUser: false,
    createdAt: { $lt: cutoff },
    $or: [{ unfinished: true }, { 'content.type': { $in: Array.from(CORTEX_TYPES) } }],
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

  const recoveredErrorCards = await recoverVisibleFollowUpErrorCards({ limit });
  const deferredHoldParentErrorCards = await recoverDeferredHoldParentErrorCards({ limit });

  return {
    scanned: messages.length,
    repaired,
    recoveredErrorCards,
    deferredHoldParentErrorCards,
    timeoutMs,
    limit,
    cortexExecutionTimeoutMs,
    graceMs,
  };
}

module.exports = {
  ACTIVE_CORTEX_STATUSES,
  getConfiguredCortexExecutionTimeoutMs,
  getStaleCortexRecoveryIntervalMs,
  recoverCortexContent,
  recoverDeferredHoldParentErrorCards,
  recoverVisibleFollowUpErrorCards,
  recoverStaleCortexMessages,
  getStaleCortexRecoveryConfig,
  isActiveCortexPart,
  stripDeferredHoldParentErrorParts,
  stripErrorPartsFromRecoveredFollowUpContent,
};
