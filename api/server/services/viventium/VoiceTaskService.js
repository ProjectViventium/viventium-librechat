/* === VIVENTIUM START ===
 * Feature: VoiceTaskEventV1
 * Purpose: Keep one authoritative, privacy-safe task state machine for voice progress, reconnect,
 * interruption/cancellation separation, and post-cancel suppression. No transcript heuristics.
 * === VIVENTIUM END === */

const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { ViventiumVoiceTask, ViventiumVoiceTaskSuppression } = require('~/db/models');

const TERMINAL_STATES = new Set([
  'completed',
  'failed',
  'cancelled_confirmed',
  'cancelled_unenforceable',
]);
const tasks = new Map();
const taskIdByStreamId = new Map();
const subscribers = new Map();
const callSubscribers = new Map();
const durableCallTails = new Map();
// Owner operations are task-scoped capabilities, not claims inferred from task kind. A producer
// must install a real callback for this exact owner/task pair before input or retry is advertised.
const ownerAdapters = new Map();
const suppressionTombstones = new Map();
const pendingTaskPersistence = new Map();
let taskPersistenceDrain = null;
// A test reset represents process replacement: an abandoned writer may finish in Mongo, but it
// must never consume or clear the next process generation's in-memory persistence queue.
let taskPersistenceGeneration = 0;
let suppressionPersistenceTestAdapter = null;
const MAX_TASKS = 1000;
const ACTIVE_TASK_TTL_MS = 24 * 60 * 60 * 1000;
const TERMINAL_TASK_TTL_MS = ACTIVE_TASK_TTL_MS;
const CONFIRMED_SUPPRESSION_RETENTION_MS = 35 * 24 * 60 * 60 * 1000;
const UNCONFIRMED_OWNER_RESULT_EXPIRES_AT_MS = 8_640_000_000_000_000;
const MAX_EVENTS_PER_TASK = 100;
const CANCELLATION_COMMIT_TIMEOUT_MS = 240;
const DURABLE_TAIL_POLL_MS = 150;
const DURABLE_TAIL_OVERLAP_MS = 10_000;
const DURABLE_CHANGE_PAGE_SIZE = 512;
const TASK_PERSISTENCE_RETRY_MS = 150;

function withPersistenceDeadline(promise, timeoutMs = CANCELLATION_COMMIT_TIMEOUT_MS) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error('Durable voice cancellation storage timed out');
      error.code = 'cancel_barrier_timeout';
      reject(error);
    }, timeoutMs);
    timeout.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

function persistenceAvailable(model) {
  return model?.db?.readyState === 1;
}

function isTestRuntime() {
  return process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'CI';
}

function activeSuppressionClause(now = new Date()) {
  return {
    $and: [
      {
        $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }],
      },
    ],
  };
}

function suppressionTombstoneIsActive(tombstone, nowMs = Date.now()) {
  return Boolean(
    tombstone && (tombstone.expiresAtMs == null || Number(tombstone.expiresAtMs) > Number(nowMs)),
  );
}

function serializeTask(task) {
  return {
    version: 1,
    taskId: task.taskId,
    callSessionId: task.callSessionId,
    userId: task.userId,
    conversationId: task.conversationId,
    turnId: task.turnId,
    streamId: task.streamId,
    parentTaskId: task.parentTaskId,
    state: task.state,
    sequence: task.sequence,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    cancellable: task.cancellable,
    retryable: task.retryable,
    acceptsInput: false,
    cancellationConfirmable: false,
    suppressed: task.suppressed === true,
    awaitingOwnerResult: task.awaitingOwnerResult === true,
    ownerChildLinked: task.ownerChildLinked === true,
    completionPending: task.completionPending === true,
    pendingCompletionResultMessageId: safeText(task.pendingCompletionResultMessageId, 160),
    continuationOverflow: task.continuationOverflow === true,
    earlyOwnerLinkCredits: Math.min(64, Math.max(0, Number(task.earlyOwnerLinkCredits) || 0)),
    pendingOwnerResultKeys: [...(task.pendingOwnerResultKeys || [])].slice(-64),
    pendingOwnerResultDeadlines: [...(task.pendingOwnerResultDeadlines || new Map()).entries()]
      .slice(-64)
      .map(([key, deadlineAtMs]) => ({ key, deadlineAtMs })),
    ownerContinuationFailureCode: safeText(task.ownerContinuationFailureCode, 80),
    resolvedOwnerResultIds: [...(task.resolvedOwnerResultIds || [])].slice(-64),
    ownerDeliveryPending: task.ownerDeliveryPending === true,
    ownerCancellationAccepted: task.ownerCancellationAccepted === true,
    ownerOperationId: safeText(task.ownerOperationId, 160),
    owner: { ...task.owner },
    events: task.events.slice(-MAX_EVENTS_PER_TASK),
    observedEventKeys: [...task.observedEventKeys].slice(-MAX_EVENTS_PER_TASK),
    sources: (task.sources || []).slice(-32),
    current: { ...(task.current || {}) },
    lastEvent: task.lastEvent ? { ...task.lastEvent } : null,
    expiresAtMs: task.expiresAtMs,
  };
}

function restoreTask(payload) {
  if (
    !payload ||
    payload.version !== 1 ||
    !safeText(payload.taskId, 160) ||
    !safeText(payload.callSessionId, 160) ||
    !safeText(payload.userId, 160) ||
    !Number.isSafeInteger(payload.sequence) ||
    !Number.isFinite(Number(payload.expiresAtMs)) ||
    Number(payload.expiresAtMs) <= Date.now()
  ) {
    return null;
  }
  return {
    ...payload,
    taskId: safeText(payload.taskId, 160),
    callSessionId: safeText(payload.callSessionId, 160),
    userId: safeText(payload.userId, 160),
    conversationId: safeText(payload.conversationId, 160),
    turnId: safeText(payload.turnId, 160),
    streamId: safeText(payload.streamId, 160),
    parentTaskId: safeText(payload.parentTaskId, 160),
    events: Array.isArray(payload.events) ? payload.events.slice(-MAX_EVENTS_PER_TASK) : [],
    observedEventKeys: new Set(
      Array.isArray(payload.observedEventKeys)
        ? payload.observedEventKeys
            .map((value) => safeText(value, 500))
            .filter(Boolean)
            .slice(-MAX_EVENTS_PER_TASK)
        : [],
    ),
    pendingOwnerResultKeys: new Set(
      Array.isArray(payload.pendingOwnerResultKeys)
        ? payload.pendingOwnerResultKeys.map((value) => safeText(value, 200)).filter(Boolean)
        : [],
    ),
    pendingOwnerResultDeadlines: new Map(
      Array.isArray(payload.pendingOwnerResultDeadlines)
        ? payload.pendingOwnerResultDeadlines
            .map((entry) => {
              const key = safeText(entry?.key, 200);
              const deadlineAtMs = Number(entry?.deadlineAtMs);
              return key && Number.isSafeInteger(deadlineAtMs) && deadlineAtMs > 0
                ? [key, deadlineAtMs]
                : null;
            })
            .filter(Boolean)
            .slice(-64)
        : [],
    ),
    ownerContinuationFailureCode: safeText(payload.ownerContinuationFailureCode, 80),
    resolvedOwnerResultIds: new Set(
      Array.isArray(payload.resolvedOwnerResultIds)
        ? payload.resolvedOwnerResultIds.map((value) => safeText(value, 200)).filter(Boolean)
        : [],
    ),
    sources: Array.isArray(payload.sources) ? payload.sources.slice(-32) : [],
    current: payload.current && typeof payload.current === 'object' ? payload.current : {},
    owner:
      payload.owner && typeof payload.owner === 'object'
        ? {
            kind: safeText(payload.owner.kind, 80) || 'generation_job',
            ...(safeText(payload.owner.id, 160) ? { id: safeText(payload.owner.id, 160) } : {}),
          }
        : { kind: 'generation_job' },
    acceptsInput: false,
    retryable: false,
    cancellationConfirmable: false,
    ownerDeliveryPending: payload.ownerDeliveryPending === true,
    ownerCancellationAccepted: payload.ownerCancellationAccepted === true,
    ownerOperationId: safeText(payload.ownerOperationId, 160),
  };
}

/* === VIVENTIUM START ===
 * Feature: bounded durable task write coalescing
 * Purpose: A task may publish several events in one event-loop turn. Persist only its latest
 * authoritative sequence in one unordered Mongo batch instead of issuing an N+1 update chain.
 * The sequence predicate prevents a delayed writer in another API process from replacing newer
 * durable state. Duplicate-key errors are therefore expected only for a losing stale upsert.
 * === VIVENTIUM END === */
function taskPersistenceOperation(entry) {
  const now = new Date();
  return {
    updateOne: {
      filter: {
        taskId: entry.taskId,
        $or: [{ sequence: { $exists: false } }, { sequence: { $lte: entry.sequence } }],
      },
      update: {
        $set: {
          callSessionId: entry.callSessionId,
          userId: entry.userId,
          streamId: entry.streamId || null,
          sequence: entry.sequence,
          payload: entry.payload,
          expiresAt: entry.expiresAt,
          updatedAt: now,
        },
        $setOnInsert: { taskId: entry.taskId, createdAt: now },
      },
      upsert: true,
    },
  };
}

function isOnlyStaleTaskDuplicate(error) {
  const writeErrors = Array.isArray(error?.writeErrors) ? error.writeErrors : [];
  return (
    error?.code === 11000 ||
    (writeErrors.length > 0 && writeErrors.every((item) => item?.code === 11000))
  );
}

async function persistVoiceTaskBatch(entries) {
  if (!entries.length || !persistenceAvailable(ViventiumVoiceTask)) return;
  try {
    await ViventiumVoiceTask.bulkWrite(entries.map(taskPersistenceOperation), {
      ordered: false,
      timestamps: false,
    });
  } catch (error) {
    if (!isOnlyStaleTaskDuplicate(error)) throw error;
  }
}

async function drainTaskPersistence(generation) {
  while (
    generation === taskPersistenceGeneration &&
    pendingTaskPersistence.size > 0 &&
    persistenceAvailable(ViventiumVoiceTask)
  ) {
    const batch = [...pendingTaskPersistence.values()];
    pendingTaskPersistence.clear();
    try {
      await persistVoiceTaskBatch(batch);
    } catch (error) {
      if (generation === taskPersistenceGeneration) {
        for (const entry of batch) {
          const pending = pendingTaskPersistence.get(entry.taskId);
          if (!pending || Number(pending.sequence) < Number(entry.sequence)) {
            pendingTaskPersistence.set(entry.taskId, entry);
          }
        }
      }
      logger.error('[VIVENTIUM][VoiceTask] durable_task_batch_write_failed', {
        count: batch.length,
        code: error?.code || 'unknown',
      });
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, TASK_PERSISTENCE_RETRY_MS);
        timeout.unref?.();
      });
    }
  }
}

function scheduleTaskPersistenceDrain() {
  if (!taskPersistenceDrain) {
    const generation = taskPersistenceGeneration;
    const drain = Promise.resolve()
      .then(() => drainTaskPersistence(generation))
      .finally(() => {
        if (taskPersistenceDrain !== drain) return;
        taskPersistenceDrain = null;
        if (pendingTaskPersistence.size > 0 && persistenceAvailable(ViventiumVoiceTask)) {
          scheduleTaskPersistenceDrain();
        }
      });
    taskPersistenceDrain = drain;
  }
  return taskPersistenceDrain;
}

function queueTaskPersistence(task) {
  if (!task || !persistenceAvailable(ViventiumVoiceTask)) return Promise.resolve();
  const payload = serializeTask(task);
  pendingTaskPersistence.set(task.taskId, {
    taskId: task.taskId,
    callSessionId: task.callSessionId,
    userId: task.userId,
    streamId: task.streamId || null,
    sequence: task.sequence,
    payload,
    expiresAt: new Date(task.expiresAtMs),
  });
  return scheduleTaskPersistenceDrain();
}

async function flushVoiceTaskPersistence() {
  while (pendingTaskPersistence.size > 0 || taskPersistenceDrain) {
    await (taskPersistenceDrain || scheduleTaskPersistenceDrain());
  }
}

async function hydrateVoiceTasksForCall({ callSessionId, userId } = {}) {
  const normalizedCallSessionId = safeText(callSessionId, 160);
  const normalizedUserId = safeText(userId, 160);
  if (!normalizedCallSessionId || !persistenceAvailable(ViventiumVoiceTask)) return [];
  const query = {
    callSessionId: normalizedCallSessionId,
    expiresAt: { $gt: new Date() },
    ...(normalizedUserId ? { userId: normalizedUserId } : {}),
  };
  const rows = await ViventiumVoiceTask.find(query).sort({ createdAt: 1 }).limit(MAX_TASKS).lean();
  for (const row of rows) {
    const restored = restoreTask(row.payload);
    const current = restored ? tasks.get(restored.taskId) : null;
    if (!restored || (current && current.sequence >= restored.sequence)) continue;
    tasks.set(restored.taskId, restored);
    if (restored.streamId) taskIdByStreamId.set(restored.streamId, restored.taskId);
    if (restored.suppressed) {
      await hydrateVoiceTaskSuppression(restored.taskId, {
        callSessionId: restored.callSessionId,
        userId: restored.userId,
        streamId: restored.streamId,
      });
    }
  }
  return listVoiceTasks({ callSessionId: normalizedCallSessionId, userId: normalizedUserId });
}

async function hydrateVoiceTask(taskId, { callSessionId, userId } = {}) {
  const normalizedTaskId = safeText(taskId, 160);
  if (!normalizedTaskId) return null;
  if (!tasks.has(normalizedTaskId) && persistenceAvailable(ViventiumVoiceTask)) {
    const row = await ViventiumVoiceTask.findOne({
      taskId: normalizedTaskId,
      expiresAt: { $gt: new Date() },
      ...(safeText(callSessionId, 160) ? { callSessionId: safeText(callSessionId, 160) } : {}),
      ...(safeText(userId, 160) ? { userId: safeText(userId, 160) } : {}),
    }).lean();
    const restored = restoreTask(row?.payload);
    if (restored) {
      tasks.set(restored.taskId, restored);
      if (restored.streamId) taskIdByStreamId.set(restored.streamId, restored.taskId);
    }
  }
  await hydrateVoiceTaskSuppression(normalizedTaskId, { callSessionId, userId });
  return getVoiceTask(normalizedTaskId);
}

async function hydrateVoiceTaskByStreamId(
  streamId,
  { callSessionId, userId, requireDurable = false } = {},
) {
  const normalizedStreamId = safeText(streamId, 160);
  if (!normalizedStreamId) return null;
  const hasTestPersistenceAdapter = isTestRuntime() && suppressionPersistenceTestAdapter != null;
  if (
    requireDurable &&
    !hasTestPersistenceAdapter &&
    (!persistenceAvailable(ViventiumVoiceTask) ||
      !persistenceAvailable(ViventiumVoiceTaskSuppression))
  ) {
    const error = new Error('Durable voice task state is unavailable');
    error.status = 503;
    error.code = 'gateway_down';
    error.retryable = true;
    throw error;
  }
  const existingTaskId = taskIdByStreamId.get(normalizedStreamId);
  const existing = existingTaskId ? tasks.get(existingTaskId) || null : null;
  if (existing) {
    const normalizedCallSessionId = safeText(callSessionId, 160);
    const normalizedUserId = safeText(userId, 160);
    if (
      (normalizedCallSessionId && existing.callSessionId !== normalizedCallSessionId) ||
      (normalizedUserId && existing.userId !== normalizedUserId)
    ) {
      return null;
    }
    await hydrateVoiceTaskSuppression(existing.taskId, {
      callSessionId,
      userId,
      streamId: normalizedStreamId,
    });
    return getVoiceTask(existing.taskId);
  }
  const row = persistenceAvailable(ViventiumVoiceTask)
    ? await ViventiumVoiceTask.findOne({
        streamId: normalizedStreamId,
        expiresAt: { $gt: new Date() },
        ...(safeText(callSessionId, 160) ? { callSessionId: safeText(callSessionId, 160) } : {}),
        ...(safeText(userId, 160) ? { userId: safeText(userId, 160) } : {}),
      }).lean()
    : null;
  const restored = restoreTask(row?.payload);
  if (!restored) {
    if (!persistenceAvailable(ViventiumVoiceTaskSuppression)) return null;
    const suppression = await ViventiumVoiceTaskSuppression.findOne({
      streamId: normalizedStreamId,
      ...activeSuppressionClause(),
      ...(safeText(callSessionId, 160) ? { callSessionId: safeText(callSessionId, 160) } : {}),
      ...(safeText(userId, 160) ? { userId: safeText(userId, 160) } : {}),
    }).lean();
    if (!suppression?.taskId) return null;
    await hydrateVoiceTaskSuppression(suppression.taskId, {
      callSessionId,
      userId,
      streamId: normalizedStreamId,
    });
    return getVoiceTask(suppression.taskId);
  }
  tasks.set(restored.taskId, restored);
  taskIdByStreamId.set(restored.streamId, restored.taskId);
  await hydrateVoiceTaskSuppression(restored.taskId, {
    callSessionId: restored.callSessionId,
    userId: restored.userId,
    streamId: restored.streamId,
  });
  return getVoiceTask(restored.taskId);
}

function restoreTaskFromSuppression(tombstone) {
  const taskId = safeText(tombstone?.taskId, 160);
  const callSessionId = safeText(tombstone?.callSessionId, 160);
  const userId = safeText(tombstone?.userId, 160);
  if (!taskId || !callSessionId || !userId) return null;
  const state = new Set(['cancelling', 'cancelled_confirmed', 'cancelled_unenforceable']).has(
    tombstone.state,
  )
    ? tombstone.state
    : 'cancelling';
  const emittedAt = safeText(tombstone.emittedAt, 80) || new Date().toISOString();
  const sequence =
    Number.isSafeInteger(tombstone.sequence) && tombstone.sequence > 0
      ? tombstone.sequence
      : Number.MAX_SAFE_INTEGER - 1;
  const owner =
    tombstone.owner && typeof tombstone.owner === 'object'
      ? {
          kind: safeText(tombstone.owner.kind, 80) || 'generation_job',
          ...(safeText(tombstone.owner.id, 160) ? { id: safeText(tombstone.owner.id, 160) } : {}),
        }
      : { kind: 'generation_job' };
  const event = {
    version: 1,
    eventId: safeText(tombstone.eventId, 160) || crypto.randomUUID(),
    sequence,
    emittedAt,
    callSessionId,
    ...(safeText(tombstone.conversationId, 160)
      ? { conversationId: safeText(tombstone.conversationId, 160) }
      : {}),
    ...(safeText(tombstone.turnId, 160) ? { turnId: safeText(tombstone.turnId, 160) } : {}),
    ...(safeText(tombstone.streamId, 160) ? { streamId: safeText(tombstone.streamId, 160) } : {}),
    taskId,
    ...(safeText(tombstone.parentTaskId, 160)
      ? { parentTaskId: safeText(tombstone.parentTaskId, 160) }
      : {}),
    type: 'state',
    state,
    phase: state,
    label: state === 'cancelling' ? 'Cancelling' : state,
    cancellable: false,
    retryable: false,
    owner,
  };
  return {
    version: 1,
    taskId,
    callSessionId,
    userId,
    conversationId: safeText(tombstone.conversationId, 160),
    turnId: safeText(tombstone.turnId, 160),
    streamId: safeText(tombstone.streamId, 160),
    parentTaskId: safeText(tombstone.parentTaskId, 160),
    state,
    sequence,
    createdAt: emittedAt,
    updatedAt: emittedAt,
    cancellable: false,
    retryable: false,
    acceptsInput: false,
    cancellationConfirmable: false,
    suppressed: true,
    awaitingOwnerResult: false,
    ownerDeliveryPending: tombstone.ownerDeliveryPending === true,
    ownerCancellationAccepted: tombstone.ownerCancellationAccepted === true,
    ownerOperationId: safeText(tombstone.operationId, 160),
    owner,
    events: [event],
    observedEventKeys: new Set(),
    sources: [],
    current: { phase: state, label: event.label },
    lastEvent: event,
    expiresAtMs: Number(tombstone.expiresAtMs) || Date.now() + ACTIVE_TASK_TTL_MS,
    suppressionEvent: {
      eventId: event.eventId,
      sequence,
      emittedAt,
    },
  };
}

async function persistVoiceTaskSuppression(task) {
  if (!task) throw new Error('Task is required for cancellation suppression');
  // A cancellation without exact terminal owner proof must outlive any configured owner runtime,
  // including an unlimited GlassHive run. Only confirmed terminal proof starts a bounded audit
  // retention window; an unenforceable result remains suppressed indefinitely.
  const expiresAtMs =
    task.state === 'cancelled_confirmed' ? Date.now() + CONFIRMED_SUPPRESSION_RETENTION_MS : null;
  const candidateEvent = task.suppressionEvent || task.cancellationPreparedEvent;
  const candidateSequence = Number(candidateEvent?.sequence);
  const preparedEvent =
    safeText(candidateEvent?.eventId, 160) &&
    safeText(candidateEvent?.emittedAt, 80) &&
    Number.isSafeInteger(candidateSequence) &&
    (candidateSequence === task.sequence || candidateSequence === task.sequence + 1)
      ? candidateEvent
      : {
          eventId: crypto.randomUUID(),
          sequence: task.sequence + 1,
          emittedAt: new Date().toISOString(),
        };
  task.cancellationPreparedEvent = preparedEvent;
  task.suppressionEvent = preparedEvent;
  const tombstone = {
    taskId: task.taskId,
    streamId: task.streamId || '',
    callSessionId: task.callSessionId,
    userId: task.userId,
    operationId: safeText(task.ownerOperationId, 160),
    ownerDeliveryPending: task.ownerDeliveryPending === true,
    ownerCancellationAccepted: task.ownerCancellationAccepted === true,
    eventId: preparedEvent.eventId,
    sequence: preparedEvent.sequence,
    emittedAt: preparedEvent.emittedAt,
    state: new Set(['cancelling', 'cancelled_confirmed', 'cancelled_unenforceable']).has(task.state)
      ? task.state
      : 'cancelling',
    conversationId: task.conversationId || '',
    turnId: task.turnId || '',
    parentTaskId: task.parentTaskId || '',
    owner: { ...task.owner },
    acceptedAtMs: Date.now(),
    expiresAtMs,
  };
  if (suppressionPersistenceTestAdapter?.persist) {
    await withPersistenceDeadline(suppressionPersistenceTestAdapter.persist({ ...tombstone }));
  } else {
    if (!persistenceAvailable(ViventiumVoiceTaskSuppression)) {
      throw new Error('Durable voice task suppression storage is unavailable');
    }
    const write = ViventiumVoiceTaskSuppression.findOneAndUpdate(
      { taskId: task.taskId },
      {
        $set: {
          streamId: task.streamId || null,
          callSessionId: task.callSessionId,
          userId: task.userId,
          operationId: tombstone.operationId || null,
          ownerDeliveryPending: tombstone.ownerDeliveryPending,
          ownerCancellationAccepted: tombstone.ownerCancellationAccepted,
          eventId: tombstone.eventId,
          sequence: tombstone.sequence,
          emittedAt: new Date(tombstone.emittedAt),
          state: tombstone.state,
          conversationId: tombstone.conversationId || null,
          turnId: tombstone.turnId || null,
          parentTaskId: tombstone.parentTaskId || null,
          ownerKind: safeText(tombstone.owner?.kind, 80) || 'generation_job',
          ownerId: safeText(tombstone.owner?.id, 160) || null,
          acceptedAt: new Date(tombstone.acceptedAtMs),
          expiresAt: expiresAtMs == null ? null : new Date(expiresAtMs),
        },
        $setOnInsert: { taskId: task.taskId },
      },
      { upsert: true, new: true, maxTimeMS: CANCELLATION_COMMIT_TIMEOUT_MS },
    ).lean();
    await withPersistenceDeadline(write);
  }
  suppressionTombstones.set(task.taskId, tombstone);
  return tombstone;
}

async function hydrateVoiceTaskSuppression(taskId, { callSessionId, userId, streamId } = {}) {
  const normalizedTaskId = safeText(taskId, 160);
  const cached = suppressionTombstones.get(normalizedTaskId);
  if (suppressionTombstoneIsActive(cached)) {
    let task = tasks.get(normalizedTaskId);
    const cachedTask = restoreTaskFromSuppression(cached);
    if (!task || (cachedTask && cachedTask.sequence >= task.sequence)) {
      task = cachedTask;
      if (task) {
        tasks.set(task.taskId, task);
        if (task.streamId) taskIdByStreamId.set(task.streamId, task.taskId);
      }
    }
    if (task && !TERMINAL_STATES.has(task.state)) {
      task.suppressed = true;
      task.state = 'cancelling';
      task.cancellable = false;
      if (
        !getOwnerAdapter(task) &&
        (task.ownerDeliveryPending || task.ownerCancellationAccepted !== true)
      ) {
        task.ownerDeliveryPending = false;
        await settleVoiceTaskCancellation(task.taskId, {
          confirmed: false,
          detail:
            'Cancellation delivery could not resume after restart; late output remains suppressed.',
        });
      }
    }
    return true;
  }
  if (!normalizedTaskId || !persistenceAvailable(ViventiumVoiceTaskSuppression)) return false;
  const row = await ViventiumVoiceTaskSuppression.findOne({
    taskId: normalizedTaskId,
    ...activeSuppressionClause(),
    ...(safeText(callSessionId, 160) ? { callSessionId: safeText(callSessionId, 160) } : {}),
    ...(safeText(userId, 160) ? { userId: safeText(userId, 160) } : {}),
    ...(safeText(streamId, 160) ? { streamId: safeText(streamId, 160) } : {}),
  }).lean();
  if (!row) return false;
  const tombstone = {
    taskId: normalizedTaskId,
    streamId: row.streamId || '',
    callSessionId: row.callSessionId,
    userId: row.userId,
    operationId: row.operationId || '',
    ownerDeliveryPending: row.ownerDeliveryPending === true,
    ownerCancellationAccepted: row.ownerCancellationAccepted === true,
    eventId: row.eventId || '',
    sequence: Number.isSafeInteger(row.sequence) ? row.sequence : 0,
    emittedAt: row.emittedAt ? new Date(row.emittedAt).toISOString() : '',
    state: safeText(row.state, 80) || 'cancelling',
    conversationId: row.conversationId || '',
    turnId: row.turnId || '',
    parentTaskId: row.parentTaskId || '',
    owner: {
      kind: safeText(row.ownerKind, 80) || 'generation_job',
      ...(safeText(row.ownerId, 160) ? { id: safeText(row.ownerId, 160) } : {}),
    },
    acceptedAtMs: new Date(row.acceptedAt).getTime(),
    expiresAtMs: row.expiresAt ? new Date(row.expiresAt).getTime() : null,
  };
  suppressionTombstones.set(normalizedTaskId, tombstone);
  let task = tasks.get(normalizedTaskId);
  const suppressionTask = restoreTaskFromSuppression(tombstone);
  if (!task || (suppressionTask && suppressionTask.sequence >= task.sequence)) {
    task = suppressionTask;
    if (task) {
      tasks.set(task.taskId, task);
      if (task.streamId) taskIdByStreamId.set(task.streamId, task.taskId);
    }
  }
  if (task && !TERMINAL_STATES.has(task.state)) {
    task.suppressed = true;
    task.state = 'cancelling';
    task.cancellable = false;
    task.ownerOperationId = row.operationId || task.ownerOperationId || '';
    task.ownerDeliveryPending = row.ownerDeliveryPending === true;
    task.ownerCancellationAccepted = row.ownerCancellationAccepted === true;
    if (
      !getOwnerAdapter(task) &&
      (task.ownerDeliveryPending || task.ownerCancellationAccepted !== true)
    ) {
      task.ownerDeliveryPending = false;
      await settleVoiceTaskCancellation(task.taskId, {
        confirmed: false,
        detail:
          'Cancellation delivery could not resume after restart; late output remains suppressed.',
      });
    }
  }
  return true;
}

/**
 * Reconcile the process-local suppression guard with the durable ledger immediately before an
 * output boundary. A negative process-local lookup is never authoritative: another API process
 * may have accepted cancellation after this request/task was hydrated.
 *
 * This guard deliberately fails closed when the durable ledger cannot be consulted. The caller
 * is an output sink (SSE, assistant persistence, memory, or follow-up), so withholding a result is
 * safer than letting a cancelled task escape during a database outage.
 */
async function isVoiceTaskSuppressedDurably(taskId, { callSessionId, userId, streamId } = {}) {
  const normalizedTaskId = safeText(taskId, 160);
  if (!normalizedTaskId) return false;
  if (isVoiceTaskSuppressed(normalizedTaskId)) return true;

  try {
    if (suppressionPersistenceTestAdapter?.lookup) {
      const found = await suppressionPersistenceTestAdapter.lookup({
        taskId: normalizedTaskId,
        callSessionId: safeText(callSessionId, 160),
        userId: safeText(userId, 160),
        streamId: safeText(streamId, 160),
      });
      return found === true || found?.taskId === normalizedTaskId;
    }
    // Unit tests install a persistence adapter that intentionally has no backing read store.
    if (suppressionPersistenceTestAdapter) return false;
    if (!persistenceAvailable(ViventiumVoiceTaskSuppression)) {
      logger.error('[VIVENTIUM][VoiceTask] durable_suppression_read_unavailable', {
        taskId: normalizedTaskId,
      });
      return true;
    }
    await hydrateVoiceTaskSuppression(normalizedTaskId, {
      callSessionId,
      userId,
      streamId,
    });
    return isVoiceTaskSuppressed(normalizedTaskId);
  } catch (error) {
    logger.error('[VIVENTIUM][VoiceTask] durable_suppression_read_failed', {
      taskId: normalizedTaskId,
      code: error?.code || 'unknown',
    });
    return true;
  }
}

async function clearVoiceTaskSuppression(taskId) {
  const normalizedTaskId = safeText(taskId, 160);
  suppressionTombstones.delete(normalizedTaskId);
  if (normalizedTaskId && suppressionPersistenceTestAdapter?.clear) {
    await suppressionPersistenceTestAdapter.clear(normalizedTaskId);
  } else if (normalizedTaskId && persistenceAvailable(ViventiumVoiceTaskSuppression)) {
    await ViventiumVoiceTaskSuppression.deleteOne({ taskId: normalizedTaskId });
  }
}

function setVoiceTaskSuppressionPersistenceForTests(adapter) {
  suppressionPersistenceTestAdapter = adapter || null;
}

function safeText(value, maxLength = 240) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : '';
}

function ownerAdapterKey(kind, taskId) {
  const normalizedKind = safeText(kind, 80);
  const normalizedTaskId = safeText(taskId, 160);
  return normalizedKind && normalizedTaskId ? `${normalizedKind}:${normalizedTaskId}` : '';
}

function getOwnerAdapter(task) {
  const key = ownerAdapterKey(task?.owner?.kind, task?.taskId);
  const adapter = key ? ownerAdapters.get(key) || null : null;
  if (!adapter) {
    return null;
  }
  if (Number.isFinite(adapter.expiresAtMs) && adapter.expiresAtMs <= Date.now()) {
    ownerAdapters.delete(key);
    task.acceptsInput = false;
    task.retryable = false;
    task.cancellationConfirmable = false;
    return null;
  }
  return adapter;
}

function publicTask(task) {
  if (!task) {
    return null;
  }
  return {
    version: 1,
    taskId: task.taskId,
    callSessionId: task.callSessionId,
    ...(task.conversationId ? { conversationId: task.conversationId } : {}),
    ...(task.turnId ? { turnId: task.turnId } : {}),
    ...(task.streamId ? { streamId: task.streamId } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    state: task.state,
    sequence: task.sequence,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    cancellable: task.cancellable,
    retryable: task.retryable,
    owner: { ...task.owner },
  };
}

function cleanupVoiceTasks(now = Date.now()) {
  for (const [taskId, task] of tasks) {
    if (Number(task.expiresAtMs) > now) {
      continue;
    }
    tasks.delete(taskId);
    if (task.streamId) {
      taskIdByStreamId.delete(task.streamId);
    }
    subscribers.delete(taskId);
    ownerAdapters.delete(ownerAdapterKey(task.owner?.kind, task.taskId));
  }
  if (tasks.size <= MAX_TASKS) {
    return;
  }
  const oldest = [...tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const task of oldest.slice(0, tasks.size - MAX_TASKS)) {
    tasks.delete(task.taskId);
    if (task.streamId) {
      taskIdByStreamId.delete(task.streamId);
    }
    subscribers.delete(task.taskId);
    ownerAdapters.delete(ownerAdapterKey(task.owner?.kind, task.taskId));
  }
}

function safeUrl(value) {
  const text = safeText(value, 1000);
  if (!text) {
    return '';
  }
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function sanitizeSource(data) {
  const input = data?.source && typeof data.source === 'object' ? data.source : data;
  if (!input || typeof input !== 'object') {
    return null;
  }
  const source = {};
  const id = safeText(input.id || input.sourceId, 160);
  const title = safeText(input.title || input.name, 200);
  const provider = safeText(input.provider, 80);
  const url = safeUrl(input.url || input.uri || input.link);
  if (id) source.id = id;
  if (title) source.title = title;
  if (provider) source.provider = provider;
  if (url) source.url = url;
  return Object.keys(source).length > 0 ? source : null;
}

function sanitizeNeedsInput(data) {
  const prompt = safeText(data?.prompt || data?.message, 300);
  if (!prompt) {
    return null;
  }
  const requestedType = safeText(data?.inputType || data?.type, 40);
  const inputType = new Set(['text', 'choice', 'confirm']).has(requestedType)
    ? requestedType
    : 'text';
  return { prompt, inputType };
}

function sanitizeProgress(data) {
  const current = Number(data?.current);
  const total = Number(data?.total);
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(total) ||
    total <= 0 ||
    current < 0 ||
    current > total
  ) {
    return null;
  }
  const unit = safeText(data?.unit, 40);
  return { current, total, ...(unit ? { unit } : {}) };
}

function nextEvent(task, fields) {
  task.sequence += 1;
  task.updatedAt = safeText(fields.emittedAt, 80) || new Date().toISOString();
  const event = {
    version: 1,
    eventId: safeText(fields.eventId, 160) || crypto.randomUUID(),
    sequence: task.sequence,
    emittedAt: task.updatedAt,
    callSessionId: task.callSessionId,
    ...(task.conversationId ? { conversationId: task.conversationId } : {}),
    ...(task.turnId ? { turnId: task.turnId } : {}),
    ...(task.streamId ? { streamId: task.streamId } : {}),
    taskId: task.taskId,
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    type: fields.type,
    state: task.state,
    ...(fields.phase ? { phase: safeText(fields.phase, 80) } : {}),
    ...(fields.label ? { label: safeText(fields.label, 160) } : {}),
    ...(fields.detail ? { detail: safeText(fields.detail, 500) } : {}),
    ...(fields.progress && Number.isFinite(fields.progress.current)
      ? { progress: fields.progress }
      : {}),
    cancellable: task.cancellable,
    retryable: task.retryable,
    ...(fields.source ? { source: fields.source } : {}),
    ...(fields.needsInput ? { needsInput: fields.needsInput } : {}),
    ...(fields.resultMessageId ? { resultMessageId: fields.resultMessageId } : {}),
    owner: { ...task.owner },
    ...(fields.error ? { error: fields.error } : {}),
  };
  task.current = {
    ...(fields.phase
      ? { phase: event.phase }
      : task.current?.phase
        ? { phase: task.current.phase }
        : {}),
    ...(fields.label
      ? { label: event.label }
      : task.current?.label
        ? { label: task.current.label }
        : {}),
    ...(fields.detail
      ? { detail: event.detail }
      : task.current?.detail
        ? { detail: task.current.detail }
        : {}),
    ...(fields.progress ? { progress: event.progress } : {}),
    ...(fields.needsInput ? { needsInput: event.needsInput } : {}),
    ...(fields.resultMessageId ? { resultMessageId: event.resultMessageId } : {}),
    ...(fields.error ? { error: event.error } : {}),
  };
  if (fields.source) {
    const sourceKey = fields.source.url || fields.source.id || fields.source.title;
    task.sources = [
      ...(task.sources || []).filter(
        (source) => (source.url || source.id || source.title) !== sourceKey,
      ),
      fields.source,
    ].slice(-32);
  }
  task.lastEvent = event;
  task.events.push(event);
  if (task.events.length > MAX_EVENTS_PER_TASK) {
    task.events.shift();
  }
  if (fields.deferDelivery === true) {
    return event;
  }
  publishTaskEvent(task, event);
  return event;
}

function publishTaskEvent(task, event) {
  for (const listener of subscribers.get(task.taskId) || []) {
    listener(event);
  }
  for (const listener of callSubscribers.get(task.callSessionId) || []) {
    try {
      listener(event);
    } catch {
      logger.warn('[VIVENTIUM][VoiceTask] call_subscriber_delivery_failed', {
        callSessionId: task.callSessionId,
        taskId: task.taskId,
      });
    }
  }
  void queueTaskPersistence(task);
}

function createVoiceTask({
  callSessionId,
  userId,
  conversationId,
  turnId,
  streamId,
  parentTaskId,
  owner,
}) {
  const existingId = streamId ? taskIdByStreamId.get(String(streamId)) : null;
  if (existingId && tasks.has(existingId)) {
    return publicTask(tasks.get(existingId));
  }
  const now = new Date().toISOString();
  cleanupVoiceTasks();
  const task = {
    version: 1,
    taskId: crypto.randomUUID(),
    callSessionId: String(callSessionId || ''),
    userId: String(userId || ''),
    conversationId: safeText(conversationId, 160),
    turnId: safeText(turnId, 160),
    streamId: safeText(streamId, 160),
    parentTaskId: safeText(parentTaskId, 160),
    state: 'queued',
    sequence: 0,
    createdAt: now,
    updatedAt: now,
    cancellable: true,
    retryable: false,
    acceptsInput: false,
    cancellationConfirmable: true,
    suppressed: false,
    owner: {
      kind: safeText(owner?.kind, 80) || 'generation_job',
      ...(safeText(owner?.id, 160) ? { id: safeText(owner.id, 160) } : {}),
    },
    events: [],
    observedEventKeys: new Set(),
    sources: [],
    current: {},
    expiresAtMs: Date.now() + ACTIVE_TASK_TTL_MS,
  };
  tasks.set(task.taskId, task);
  if (task.streamId) {
    taskIdByStreamId.set(task.streamId, task.taskId);
  }
  nextEvent(task, { type: 'state', phase: 'queued', label: 'Queued' });
  task.state = 'running';
  nextEvent(task, { type: 'state', phase: 'starting', label: 'Starting' });
  logger.info('[VIVENTIUM][VoiceTask] task_started', {
    taskId: task.taskId,
    callSessionId: task.callSessionId,
    streamId: task.streamId,
  });
  return publicTask(task);
}

function getVoiceTask(taskId) {
  cleanupVoiceTasks();
  return publicTask(tasks.get(String(taskId || '')) || null);
}

function getVoiceTaskByStreamId(streamId) {
  const taskId = taskIdByStreamId.get(String(streamId || ''));
  return taskId ? getVoiceTask(taskId) : null;
}

function bindVoiceTaskStream(taskId, streamId) {
  const task = tasks.get(String(taskId || ''));
  const normalizedStreamId = safeText(streamId, 160);
  if (!task || !normalizedStreamId) {
    return null;
  }
  if (task.streamId && task.streamId !== normalizedStreamId) {
    taskIdByStreamId.delete(task.streamId);
  }
  task.streamId = normalizedStreamId;
  task.owner = { kind: 'generation_job', id: normalizedStreamId };
  taskIdByStreamId.set(normalizedStreamId, task.taskId);
  return publicTask(task);
}

function setVoiceTaskOwnerCapabilities(taskId, { kind, ownerId, cancellationConfirmable } = {}) {
  const task = tasks.get(String(taskId || ''));
  if (!task || TERMINAL_STATES.has(task.state)) {
    return null;
  }
  const normalizedKind = safeText(kind, 80);
  const normalizedOwnerId = safeText(ownerId, 160);
  if (normalizedKind) {
    const previousAdapterKey = ownerAdapterKey(task.owner?.kind, task.taskId);
    task.owner = {
      kind: normalizedKind,
      ...(normalizedOwnerId
        ? { id: normalizedOwnerId }
        : task.owner?.id
          ? { id: task.owner.id }
          : {}),
    };
    if (previousAdapterKey !== ownerAdapterKey(task.owner.kind, task.taskId)) {
      ownerAdapters.delete(previousAdapterKey);
      task.acceptsInput = false;
      task.retryable = false;
    }
  }
  if (typeof cancellationConfirmable === 'boolean') {
    task.cancellationConfirmable = cancellationConfirmable;
  }
  return publicTask(task);
}

/**
 * Install only operations the owning runtime can actually perform. The structured owner kind must
 * match the task so an adapter cannot silently gain authority over a different execution plane.
 */
function registerVoiceTaskOwnerAdapter(
  taskId,
  { kind, provideInput, retry, cancel, cancellationConfirmable, expiresAtMs } = {},
) {
  const task = tasks.get(String(taskId || ''));
  const normalizedKind = safeText(kind, 80);
  if (
    !task ||
    !normalizedKind ||
    normalizedKind !== task.owner?.kind ||
    (TERMINAL_STATES.has(task.state) && task.state !== 'failed')
  ) {
    return null;
  }
  const adapter = {
    kind: normalizedKind,
    ...(typeof provideInput === 'function' ? { provideInput } : {}),
    ...(typeof retry === 'function' ? { retry } : {}),
    ...(typeof cancel === 'function' ? { cancel } : {}),
    ...(Number.isFinite(Number(expiresAtMs)) ? { expiresAtMs: Number(expiresAtMs) } : {}),
  };
  const key = ownerAdapterKey(normalizedKind, task.taskId);
  if (!adapter.provideInput && !adapter.retry && !adapter.cancel) {
    ownerAdapters.delete(key);
  } else {
    ownerAdapters.set(key, adapter);
  }
  task.acceptsInput = typeof adapter.provideInput === 'function';
  task.retryable = task.state === 'failed' && typeof adapter.retry === 'function';
  if (typeof cancellationConfirmable === 'boolean') {
    task.cancellationConfirmable = cancellationConfirmable;
  }
  return publicTask(task);
}

function operationFailure(task, code, message, extra = {}) {
  return {
    ok: false,
    code,
    message,
    ...(task ? { task: publicTask(task) } : {}),
    ...extra,
  };
}

async function submitVoiceTaskInput(taskId, input, { userId } = {}) {
  const task = tasks.get(String(taskId || ''));
  if (!task || (userId && task.userId !== String(userId))) {
    return operationFailure(null, 'task_not_found', 'Task not found.');
  }
  const adapter = getOwnerAdapter(task);
  if (!adapter?.provideInput) {
    return operationFailure(task, 'input_unsupported', 'This task owner does not accept input.');
  }
  const normalizedInput = safeText(input, 1000);
  if (!normalizedInput) {
    return operationFailure(task, 'input_required', 'Input is required.');
  }
  const inputHash = crypto.createHash('sha256').update(normalizedInput).digest('hex');
  if (task.inputOperation?.hash === inputHash) {
    if (task.inputOperation.promise) {
      return task.inputOperation.promise;
    }
    if (task.inputOperation.result?.ok) {
      return task.inputOperation.result;
    }
  }
  if (task.inputOperation?.promise) {
    return operationFailure(task, 'input_in_progress', 'Another input is already being delivered.');
  }
  if (task.state !== 'needs_input') {
    return operationFailure(task, 'input_invalid_state', 'The task is not waiting for input.');
  }

  const operationId =
    task.inputOperation?.hash === inputHash ? task.inputOperation.operationId : crypto.randomUUID();
  const operation = {
    hash: inputHash,
    operationId,
    promise: null,
    result: null,
  };
  const delivery = (async () => {
    try {
      const ownerResult = await adapter.provideInput({
        taskId: task.taskId,
        owner: { ...task.owner },
        operationId,
        input: normalizedInput,
      });
      if (ownerResult?.accepted !== true) {
        throw new Error('owner_rejected_input');
      }
      if (task.state !== 'needs_input' || task.suppressed) {
        return operationFailure(
          task,
          'input_invalid_state',
          'The task is no longer waiting for input.',
        );
      }
      task.state = 'running';
      task.cancellable = true;
      task.retryable = false;
      task.current = {};
      task.expiresAtMs = Date.now() + ACTIVE_TASK_TTL_MS;
      const event = nextEvent(task, {
        type: 'state',
        phase: safeText(ownerResult?.phase, 80) || 'running',
        label: safeText(ownerResult?.label, 160) || 'Continuing',
        detail: safeText(ownerResult?.detail, 500),
      });
      return { ok: true, task: publicTask(task), event };
    } catch {
      const event = nextEvent(task, {
        type: 'error',
        phase: 'needs_input',
        label: 'Input delivery failed',
        error: {
          code: 'owner_input_failed',
          message: 'The task owner could not accept input.',
        },
      });
      return operationFailure(
        task,
        'owner_input_failed',
        'The task owner could not accept input.',
        { event },
      );
    }
  })();
  operation.promise = delivery;
  task.inputOperation = operation;
  const result = await delivery;
  operation.promise = null;
  operation.result = result;
  return result;
}

async function retryVoiceTask(taskId, { userId } = {}) {
  const task = tasks.get(String(taskId || ''));
  if (!task || (userId && task.userId !== String(userId))) {
    return operationFailure(null, 'task_not_found', 'Task not found.');
  }
  const adapter = getOwnerAdapter(task);
  if (!adapter?.retry) {
    return operationFailure(task, 'retry_unsupported', 'This task owner does not support retry.');
  }
  if (task.retryOperation?.promise) {
    return task.retryOperation.promise;
  }
  if (task.retryOperation?.result?.ok) {
    return task.retryOperation.result;
  }
  if (task.state !== 'failed') {
    return operationFailure(task, 'retry_invalid_state', 'Only a failed task can be retried.');
  }

  const operationId = task.retryOperation?.operationId || crypto.randomUUID();
  const operation = { operationId, promise: null, result: null };
  const delivery = (async () => {
    try {
      const ownerResult = await adapter.retry({
        taskId: task.taskId,
        owner: { ...task.owner },
        operationId,
      });
      if (ownerResult?.accepted !== true) {
        throw new Error('owner_rejected_retry');
      }
      if (task.state !== 'failed' || task.suppressed) {
        return operationFailure(task, 'retry_invalid_state', 'The task is no longer retryable.');
      }
      const nextStreamId = safeText(ownerResult?.streamId, 160);
      if (!nextStreamId || nextStreamId === task.streamId) {
        throw new Error('owner_retry_missing_new_stream');
      }
      const childOwnerId =
        safeText(ownerResult?.ownerId, 160) ||
        (task.owner.kind === 'generation_job'
          ? nextStreamId
          : task.owner.kind === 'glasshive_run' && nextStreamId.startsWith('glasshive:')
            ? nextStreamId.slice('glasshive:'.length)
            : task.owner.id);
      task.retryable = false;
      const previousEvent = nextEvent(task, {
        type: 'state',
        phase: 'retried',
        label: 'Retry started',
        detail: 'A new linked task is starting.',
        ...(task.current?.error ? { error: task.current.error } : {}),
      });
      const child = createVoiceTask({
        callSessionId: task.callSessionId,
        userId: task.userId,
        conversationId: task.conversationId,
        turnId: task.turnId,
        streamId: nextStreamId,
        parentTaskId: task.taskId,
        owner: { kind: task.owner.kind, id: childOwnerId },
      });
      const childTask = tasks.get(child.taskId);
      if (!childTask || child.taskId === task.taskId) {
        throw new Error('owner_retry_child_not_created');
      }
      if (childTask.owner.kind === 'glasshive_run') {
        childTask.cancellationConfirmable = false;
      }
      ownerAdapters.delete(ownerAdapterKey(task.owner?.kind, task.taskId));
      const [queuedEvent, runningEvent] = childTask.events.slice(-2);
      return {
        ok: true,
        task: publicTask(childTask),
        previousTask: publicTask(task),
        previousEvent,
        event: runningEvent,
        events: [queuedEvent, runningEvent],
      };
    } catch {
      const event = nextEvent(task, {
        type: 'error',
        phase: 'failed',
        label: 'Retry failed',
        error: {
          code: 'owner_retry_failed',
          message: 'The task owner could not restart the task.',
        },
      });
      return operationFailure(
        task,
        'owner_retry_failed',
        'The task owner could not restart the task.',
        { event },
      );
    }
  })();
  operation.promise = delivery;
  task.retryOperation = operation;
  const result = await delivery;
  operation.promise = null;
  operation.result = result;
  return result;
}

function canConfirmVoiceTaskCancellation(taskId) {
  const task = tasks.get(String(taskId || ''));
  if (!task) {
    return false;
  }
  getOwnerAdapter(task);
  return task.cancellationConfirmable !== false;
}

function listVoiceTasks({ userId, callSessionId } = {}) {
  cleanupVoiceTasks();
  return [...tasks.values()]
    .filter((task) => !userId || task.userId === String(userId))
    .filter((task) => !callSessionId || task.callSessionId === String(callSessionId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(publicTask);
}

/* === VIVENTIUM START ===
 * Feature: truthful voice-task owner capability inventory
 * Purpose: Acceptance and UI surfaces must not invent a needs-input path. Report only bounded,
 * content-free capabilities backed by a currently installed structured owner adapter in the exact
 * authenticated call scope. A restored task never advertises input because adapter functions and
 * opaque action capabilities are deliberately not persisted.
 * === VIVENTIUM END === */
function getVoiceTaskOwnerCapabilityInventory({ userId, callSessionId } = {}) {
  cleanupVoiceTasks();
  const normalizedUserId = safeText(userId, 160);
  const normalizedCallSessionId = safeText(callSessionId, 160);
  const capabilityByKind = new Map();
  for (const task of tasks.values()) {
    if (
      (normalizedUserId && task.userId !== normalizedUserId) ||
      (normalizedCallSessionId && task.callSessionId !== normalizedCallSessionId)
    ) {
      continue;
    }
    const kind = safeText(task.owner?.kind, 80) || 'generation_job';
    const acceptsInput = typeof getOwnerAdapter(task)?.provideInput === 'function';
    capabilityByKind.set(kind, capabilityByKind.get(kind) === true || acceptsInput);
  }
  return {
    authoritative: true,
    source: 'runtime_voice_task_owner_registry',
    owners: [...capabilityByKind.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, acceptsInput]) => ({ kind, acceptsInput })),
  };
}

function snapshotEventForTask(task) {
  if (!task) {
    return null;
  }
  return {
    version: 1,
    eventId: crypto.randomUUID(),
    sequence: task.sequence,
    emittedAt: new Date().toISOString(),
    callSessionId: task.callSessionId,
    ...(task.conversationId ? { conversationId: task.conversationId } : {}),
    ...(task.turnId ? { turnId: task.turnId } : {}),
    ...(task.streamId ? { streamId: task.streamId } : {}),
    taskId: task.taskId,
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    type: 'snapshot',
    state: task.state,
    phase: task.current?.phase || task.lastEvent?.phase || task.state,
    label: task.current?.label || task.lastEvent?.label || task.state,
    ...(task.current?.detail ? { detail: task.current.detail } : {}),
    ...(task.current?.progress ? { progress: task.current.progress } : {}),
    ...(task.current?.needsInput ? { needsInput: task.current.needsInput } : {}),
    ...(task.current?.resultMessageId ? { resultMessageId: task.current.resultMessageId } : {}),
    ...(task.current?.error ? { error: task.current.error } : {}),
    ...(task.sources?.length ? { sources: task.sources.map((source) => ({ ...source })) } : {}),
    cancellable: task.cancellable,
    retryable: task.retryable,
    owner: { ...task.owner },
  };
}

function snapshotEvent(taskId) {
  return snapshotEventForTask(tasks.get(String(taskId || '')));
}

function snapshotEventForSuppression(row) {
  const taskId = safeText(row?.taskId, 160);
  const callSessionId = safeText(row?.callSessionId, 160);
  const userId = safeText(row?.userId, 160);
  const acceptedAt = row?.acceptedAt ? new Date(row.acceptedAt) : null;
  const emittedAt = row?.emittedAt ? new Date(row.emittedAt) : acceptedAt;
  if (
    !taskId ||
    !callSessionId ||
    !userId ||
    !acceptedAt ||
    !Number.isFinite(acceptedAt.getTime()) ||
    !emittedAt ||
    !Number.isFinite(emittedAt.getTime())
  ) {
    return null;
  }
  const state = new Set(['cancelling', 'cancelled_confirmed', 'cancelled_unenforceable']).has(
    row.state,
  )
    ? row.state
    : 'cancelling';
  const sequence =
    Number.isSafeInteger(row.sequence) && row.sequence > 0
      ? row.sequence
      : Number.MAX_SAFE_INTEGER - 1;
  return {
    event: {
      version: 1,
      eventId:
        safeText(row.eventId, 160) ||
        `suppression-${crypto.createHash('sha256').update(`${taskId}\0${acceptedAt.toISOString()}`).digest('hex').slice(0, 32)}`,
      sequence,
      emittedAt: emittedAt.toISOString(),
      callSessionId,
      ...(safeText(row.conversationId, 160)
        ? { conversationId: safeText(row.conversationId, 160) }
        : {}),
      ...(safeText(row.turnId, 160) ? { turnId: safeText(row.turnId, 160) } : {}),
      ...(safeText(row.streamId, 160) ? { streamId: safeText(row.streamId, 160) } : {}),
      taskId,
      ...(safeText(row.parentTaskId, 160) ? { parentTaskId: safeText(row.parentTaskId, 160) } : {}),
      type: 'snapshot',
      state,
      phase: state,
      label:
        state === 'cancelled_confirmed'
          ? 'Cancelled'
          : state === 'cancelled_unenforceable'
            ? 'Cancellation could not be confirmed'
            : 'Cancelling',
      cancellable: false,
      retryable: false,
      owner: {
        kind: safeText(row.ownerKind, 80) || 'generation_job',
        ...(safeText(row.ownerId, 160) ? { id: safeText(row.ownerId, 160) } : {}),
      },
    },
    createdAt: acceptedAt,
    taskId,
  };
}

async function reconcileExpiredOwnerContinuations({ callSessionId, userId, nowMs } = {}) {
  const normalizedCallSessionId = safeText(callSessionId, 160);
  const normalizedUserId = safeText(userId, 160);
  const normalizedNowMs = Number(nowMs) || Date.now();
  if (!normalizedCallSessionId || !normalizedUserId || !persistenceAvailable(ViventiumVoiceTask)) {
    throw durableTailUnavailable(new Error('Durable owner continuation state is unavailable'));
  }
  let rows;
  try {
    rows = await ViventiumVoiceTask.find({
      callSessionId: normalizedCallSessionId,
      userId: normalizedUserId,
      expiresAt: { $gt: new Date(normalizedNowMs) },
      'payload.pendingOwnerResultDeadlines.deadlineAtMs': { $lte: normalizedNowMs },
      'payload.state': { $nin: [...TERMINAL_STATES] },
    })
      .sort({ createdAt: 1, taskId: 1 })
      .lean();
  } catch (cause) {
    throw durableTailUnavailable(cause);
  }

  for (const row of rows) {
    const task = restoreTask(row.payload);
    if (
      !task ||
      task.callSessionId !== normalizedCallSessionId ||
      task.userId !== normalizedUserId
    ) {
      continue;
    }
    task.pendingOwnerResultDeadlines ||= new Map();
    task.pendingOwnerResultKeys ||= new Set();
    const expiredKeys = [...task.pendingOwnerResultDeadlines.entries()]
      .filter(([, deadlineAtMs]) => Number(deadlineAtMs) <= normalizedNowMs)
      .map(([key]) => key);
    if (expiredKeys.length === 0) continue;
    for (const key of expiredKeys) {
      task.pendingOwnerResultDeadlines.delete(key);
      task.pendingOwnerResultKeys.delete(key);
    }
    task.ownerContinuationFailureCode = 'owner_callback_unavailable';
    const remainsActive =
      task.continuationOverflow === true || task.pendingOwnerResultKeys.size > 0;
    let event;
    if (remainsActive) {
      task.awaitingOwnerResult = true;
      task.ownerChildLinked = false;
      event = nextEvent(task, {
        type: 'progress',
        phase: 'delegated',
        label: 'Background work continuing',
        detail: 'One callback delivery failed; another linked owner remains active.',
        deferDelivery: true,
      });
    } else {
      task.state = 'failed';
      task.awaitingOwnerResult = false;
      task.ownerChildLinked = false;
      task.completionPending = false;
      task.pendingCompletionResultMessageId = '';
      task.cancellable = false;
      task.retryable = false;
      task.expiresAtMs = normalizedNowMs + TERMINAL_TASK_TTL_MS;
      event = nextEvent(task, {
        type: 'error',
        phase: 'failed',
        label: 'Background result unavailable',
        error: {
          code: 'owner_callback_unavailable',
          message: 'The linked worker could not deliver its final callback.',
          retryable: false,
        },
        deferDelivery: true,
      });
    }
    const payload = serializeTask(task);
    let updated;
    try {
      updated = await ViventiumVoiceTask.findOneAndUpdate(
        {
          taskId: task.taskId,
          callSessionId: normalizedCallSessionId,
          userId: normalizedUserId,
          sequence: row.sequence,
        },
        {
          $set: {
            sequence: task.sequence,
            payload,
            expiresAt: new Date(task.expiresAtMs),
          },
        },
        { new: true },
      ).lean();
    } catch (cause) {
      throw durableTailUnavailable(cause);
    }
    if (!updated) continue;
    const current = tasks.get(task.taskId);
    if (!current || current.sequence <= task.sequence) {
      tasks.set(task.taskId, task);
      if (task.streamId) taskIdByStreamId.set(task.streamId, task.taskId);
    }
    publishTaskEvent(task, event);
  }
  await flushVoiceTaskPersistence();
}

async function getDurableVoiceTaskContinuationState({
  callSessionId,
  userId,
  callEndedAtMs,
  nowMs = Date.now(),
} = {}) {
  const normalizedCallSessionId = safeText(callSessionId, 160);
  const normalizedUserId = safeText(userId, 160);
  if (
    !normalizedCallSessionId ||
    !normalizedUserId ||
    !persistenceAvailable(ViventiumVoiceTask) ||
    !persistenceAvailable(ViventiumVoiceTaskSuppression)
  ) {
    throw durableTailUnavailable(new Error('Durable continuation state is unavailable'));
  }
  await reconcileExpiredOwnerContinuations({
    callSessionId: normalizedCallSessionId,
    userId: normalizedUserId,
    nowMs,
  });
  const now = new Date(Number(nowMs) || Date.now());
  const taskScope = {
    callSessionId: normalizedCallSessionId,
    userId: normalizedUserId,
    expiresAt: { $gt: now },
  };
  const suppressionScope = {
    callSessionId: normalizedCallSessionId,
    userId: normalizedUserId,
    ...activeSuppressionClause(now),
  };
  let latestTask;
  let activeTask;
  let latestSuppression;
  let activeSuppression;
  try {
    [latestTask, activeTask, latestSuppression, activeSuppression] = await Promise.all([
      ViventiumVoiceTask.findOne(taskScope).sort({ updatedAt: -1, taskId: -1 }).lean(),
      ViventiumVoiceTask.findOne({
        ...taskScope,
        'payload.state': { $nin: [...TERMINAL_STATES] },
      }).lean(),
      ViventiumVoiceTaskSuppression.findOne(suppressionScope)
        .sort({ updatedAt: -1, taskId: -1 })
        .lean(),
      ViventiumVoiceTaskSuppression.findOne({ ...suppressionScope, state: 'cancelling' }).lean(),
    ]);
  } catch (cause) {
    throw durableTailUnavailable(cause);
  }
  const hasActive = Boolean(activeTask || activeSuppression);
  const activityTimes = [latestTask?.updatedAt, latestSuppression?.updatedAt, callEndedAtMs]
    .map((value) => new Date(value || 0).getTime())
    .filter(Number.isFinite);
  const lastActivityMs = activityTimes.length > 0 ? Math.max(...activityTimes) : now.getTime();
  // Every asynchronous producer must durably register an active parent before it can launch work,
  // and that parent remains active until its child/result is durably linked. Therefore closure is
  // based on authoritative owner/task state, never a wall-clock quiet-window inference.
  const quietUntilMs = Math.max(lastActivityMs, now.getTime());
  const status = hasActive ? 'active' : 'quiescent';
  return {
    version: 1,
    status,
    hasActive,
    observedAt: now.toISOString(),
    quietUntil: new Date(quietUntilMs).toISOString(),
    nextPollAfterMs: status === 'active' ? 1500 : null,
  };
}

async function listDurableVoiceTaskSnapshots({
  callSessionId,
  userId,
  beforeCreatedAt,
  beforeTaskId,
  limit = 512,
  requireDurable = false,
} = {}) {
  const normalizedCallSessionId = safeText(callSessionId, 160);
  const normalizedUserId = safeText(userId, 160);
  const normalizedBeforeTaskId = safeText(beforeTaskId, 160);
  const parsedBefore = beforeCreatedAt ? new Date(beforeCreatedAt) : null;
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 512, 512));
  if (!normalizedCallSessionId) {
    return { events: [], hasMore: false, nextBeforeCreatedAt: null, nextBeforeTaskId: null };
  }
  if (
    !persistenceAvailable(ViventiumVoiceTask) ||
    (requireDurable && !persistenceAvailable(ViventiumVoiceTaskSuppression))
  ) {
    if (requireDurable) {
      const error = new Error('Durable voice task history is unavailable');
      error.status = 503;
      error.code = 'gateway_down';
      error.retryable = true;
      throw error;
    }
    const current = listVoiceTasks({
      callSessionId: normalizedCallSessionId,
      userId: normalizedUserId,
    })
      .slice(0, boundedLimit)
      .map((task) => snapshotEvent(task.taskId));
    return { events: current, hasMore: false, nextBeforeCreatedAt: null, nextBeforeTaskId: null };
  }
  const query = {
    callSessionId: normalizedCallSessionId,
    expiresAt: { $gt: new Date() },
    ...(normalizedUserId ? { userId: normalizedUserId } : {}),
  };
  const suppressionQuery = {
    callSessionId: normalizedCallSessionId,
    ...activeSuppressionClause(),
    ...(normalizedUserId ? { userId: normalizedUserId } : {}),
  };
  if (parsedBefore && Number.isFinite(parsedBefore.getTime()) && normalizedBeforeTaskId) {
    query.$or = [
      { createdAt: { $lt: parsedBefore } },
      { createdAt: parsedBefore, taskId: { $lt: normalizedBeforeTaskId } },
    ];
    suppressionQuery.$or = [
      { acceptedAt: { $lt: parsedBefore } },
      { acceptedAt: parsedBefore, taskId: { $lt: normalizedBeforeTaskId } },
    ];
  }
  let rows;
  let suppressionRows = [];
  try {
    [rows, suppressionRows] = await Promise.all([
      ViventiumVoiceTask.find(query)
        .sort({ createdAt: -1, taskId: -1 })
        .limit(boundedLimit + 1)
        .lean(),
      persistenceAvailable(ViventiumVoiceTaskSuppression)
        ? ViventiumVoiceTaskSuppression.find(suppressionQuery)
            .sort({ acceptedAt: -1, taskId: -1 })
            .limit(boundedLimit + 1)
            .lean()
        : Promise.resolve([]),
    ]);
  } catch (cause) {
    if (!requireDurable) throw cause;
    const error = new Error('Durable voice task history is unavailable');
    error.status = 503;
    error.code = 'gateway_down';
    error.retryable = true;
    error.cause = cause;
    throw error;
  }
  const restoredTasks = rows.map((row) => restoreTask(row.payload));
  if (requireDurable && restoredTasks.some((task) => !task)) {
    const error = new Error('Durable voice task history contains an invalid record');
    error.status = 503;
    error.code = 'gateway_down';
    error.retryable = true;
    throw error;
  }
  const suppressionEntries = suppressionRows.map(snapshotEventForSuppression);
  if (requireDurable && suppressionEntries.some((entry) => !entry)) {
    const error = new Error('Durable voice task suppression history contains an invalid record');
    error.status = 503;
    error.code = 'gateway_down';
    error.retryable = true;
    throw error;
  }
  const entriesByTaskId = new Map();
  rows.forEach((row, index) => {
    const task = restoredTasks[index];
    if (!task) return;
    entriesByTaskId.set(task.taskId, {
      event: snapshotEventForTask(task),
      createdAt: new Date(row.createdAt),
      taskId: task.taskId,
    });
  });
  for (const entry of suppressionEntries.filter(Boolean)) {
    const current = entriesByTaskId.get(entry.taskId);
    if (!current || entry.event.sequence >= current.event.sequence) {
      entriesByTaskId.set(entry.taskId, entry);
    }
  }
  const combined = [...entriesByTaskId.values()].sort((left, right) => {
    const timeDelta = right.createdAt.getTime() - left.createdAt.getTime();
    return timeDelta || right.taskId.localeCompare(left.taskId);
  });
  const page = combined.slice(0, boundedLimit);
  const hasMore =
    combined.length > boundedLimit ||
    rows.length > boundedLimit ||
    suppressionRows.length > boundedLimit;
  const events = page.map((entry) => entry.event).reverse();
  const oldest = page.at(-1);
  return {
    events,
    hasMore,
    nextBeforeCreatedAt: hasMore && oldest?.createdAt ? oldest.createdAt.toISOString() : null,
    nextBeforeTaskId: hasMore && oldest?.taskId ? String(oldest.taskId) : null,
  };
}

function subscribeVoiceTask(taskId, listener) {
  const id = String(taskId || '');
  if (!tasks.has(id) || typeof listener !== 'function') {
    return () => {};
  }
  if (!subscribers.has(id)) {
    subscribers.set(id, new Set());
  }
  subscribers.get(id).add(listener);
  listener(snapshotEvent(id));
  return () => {
    subscribers.get(id)?.delete(listener);
  };
}

function subscribeVoiceTasksForCall(callSessionId, listener, { replaySnapshots = false } = {}) {
  const id = safeText(callSessionId, 160);
  if (!id || typeof listener !== 'function') {
    return () => {};
  }
  if (!callSubscribers.has(id)) {
    callSubscribers.set(id, new Set());
  }
  callSubscribers.get(id).add(listener);
  if (replaySnapshots) {
    const callTasks = [...tasks.values()]
      .filter((task) => task.callSessionId === id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const task of callTasks) {
      listener(snapshotEvent(task.taskId));
    }
  }
  return () => {
    const listeners = callSubscribers.get(id);
    listeners?.delete(listener);
    if (listeners?.size === 0) {
      callSubscribers.delete(id);
    }
  };
}

/* === VIVENTIUM START ===
 * Feature: Mongo-backed cross-process voice task tail
 * Purpose: Process-local listeners keep the zero-latency path, while one shared tail per active
 * call reconciles updates written by another API process. One indexed `$unionWith` query covers
 * task rows and cancellation tombstones; an overlap window plus monotonic sequence dedupe prevents
 * gaps without Redis or an unbounded event log. The tail exists only while an authenticated SSE
 * consumer is attached and never overlaps its own polls.
 * === VIVENTIUM END === */
function durableTailKey(callSessionId, userId) {
  return `${safeText(callSessionId, 160)}\0${safeText(userId, 160)}`;
}

function durableTailUnavailable(cause) {
  const error = new Error('Durable voice task tail is unavailable');
  error.status = 503;
  error.code = 'gateway_down';
  error.retryable = true;
  error.cause = cause;
  return error;
}

function estimateDurableVoiceTailReads(durationMs, pollIntervalMs = DURABLE_TAIL_POLL_MS) {
  const duration = Math.max(0, Number(durationMs) || 0);
  const interval = Math.max(25, Number(pollIntervalMs) || DURABLE_TAIL_POLL_MS);
  return Math.ceil(duration / interval);
}

async function readDurableVoiceTaskChanges({ callSessionId, userId, updatedSince }) {
  if (
    !persistenceAvailable(ViventiumVoiceTask) ||
    !persistenceAvailable(ViventiumVoiceTaskSuppression)
  ) {
    throw durableTailUnavailable();
  }
  const callId = safeText(callSessionId, 160);
  const ownerId = safeText(userId, 160);
  const since = updatedSince instanceof Date ? updatedSince : new Date(updatedSince);
  if (!callId || !ownerId || !Number.isFinite(since.getTime())) {
    throw durableTailUnavailable(new Error('Invalid durable tail scope'));
  }
  const commonMatch = {
    callSessionId: callId,
    userId: ownerId,
    updatedAt: { $gte: since },
  };
  const suppressionCollection = ViventiumVoiceTaskSuppression.collection.name;
  const events = [];
  let cursor = null;
  do {
    const pipeline = [
      { $match: { ...commonMatch, expiresAt: { $gt: new Date() } } },
      {
        $set: {
          _tailKind: { $literal: 'task' },
          _tailCursor: { $concat: ['0:', '$taskId'] },
        },
      },
      {
        $unionWith: {
          coll: suppressionCollection,
          pipeline: [
            { $match: { ...commonMatch, ...activeSuppressionClause() } },
            {
              $set: {
                _tailKind: { $literal: 'suppression' },
                _tailCursor: { $concat: ['1:', '$taskId'] },
              },
            },
          ],
        },
      },
      ...(cursor
        ? [
            {
              $match: {
                $or: [
                  { updatedAt: { $gt: cursor.updatedAt } },
                  { updatedAt: cursor.updatedAt, _tailCursor: { $gt: cursor.key } },
                ],
              },
            },
          ]
        : []),
      { $sort: { updatedAt: 1, _tailCursor: 1 } },
      { $limit: DURABLE_CHANGE_PAGE_SIZE },
    ];
    let rows;
    try {
      rows = await ViventiumVoiceTask.aggregate(pipeline).option({ maxTimeMS: 5_000 });
    } catch (cause) {
      throw durableTailUnavailable(cause);
    }
    for (const row of rows) {
      const event =
        row._tailKind === 'suppression'
          ? snapshotEventForSuppression(row)?.event
          : snapshotEventForTask(restoreTask(row.payload));
      if (!event) {
        throw durableTailUnavailable(new Error('Invalid durable task change record'));
      }
      events.push(event);
    }
    const last = rows.at(-1);
    cursor =
      rows.length === DURABLE_CHANGE_PAGE_SIZE && last?.updatedAt && last?._tailCursor
        ? { updatedAt: new Date(last.updatedAt), key: String(last._tailCursor) }
        : null;
  } while (cursor);
  return events;
}

function createDurableCallTail({ callSessionId, userId, pollIntervalMs }) {
  const key = durableTailKey(callSessionId, userId);
  const state = {
    key,
    callSessionId: safeText(callSessionId, 160),
    userId: safeText(userId, 160),
    pollIntervalMs: Math.max(25, Math.min(Number(pollIntervalMs) || DURABLE_TAIL_POLL_MS, 5_000)),
    listeners: new Set(),
    seenSequences: new Map(),
    lastScanAtMs: Date.now(),
    timer: null,
    inflight: null,
    stopped: false,
    failures: 0,
    scanCount: 0,
  };
  state.schedule = (delayMs = state.pollIntervalMs) => {
    if (state.stopped || state.timer || state.listeners.size === 0) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void state.scan().catch((error) => {
        for (const listener of state.listeners) listener.onError?.(error);
        state.failures += 1;
        state.schedule(Math.min(state.pollIntervalMs * 2 ** state.failures, 5_000));
      });
    }, delayMs);
    state.timer.unref?.();
  };
  state.scan = () => {
    if (state.stopped || state.listeners.size === 0) return Promise.resolve();
    if (state.inflight) return state.inflight;
    const scanStartedAtMs = Date.now();
    const updatedSince = new Date(Math.max(0, state.lastScanAtMs - DURABLE_TAIL_OVERLAP_MS));
    state.inflight = readDurableVoiceTaskChanges({
      callSessionId: state.callSessionId,
      userId: state.userId,
      updatedSince,
    })
      .then((events) => {
        if (state.stopped) return;
        state.scanCount += 1;
        state.failures = 0;
        state.lastScanAtMs = Math.max(state.lastScanAtMs, scanStartedAtMs);
        for (const event of events) {
          const previousSequence = state.seenSequences.get(event.taskId) ?? -1;
          if (event.sequence <= previousSequence) continue;
          state.seenSequences.set(event.taskId, event.sequence);
          for (const listener of state.listeners) listener.onEvent(event);
        }
      })
      .finally(() => {
        state.inflight = null;
        state.schedule();
      });
    return state.inflight;
  };
  durableCallTails.set(key, state);
  return state;
}

function subscribeDurableVoiceTaskEventsForCall({
  callSessionId,
  userId,
  onEvent,
  onError,
  pollIntervalMs = DURABLE_TAIL_POLL_MS,
} = {}) {
  const key = durableTailKey(callSessionId, userId);
  if (!safeText(callSessionId, 160) || !safeText(userId, 160) || typeof onEvent !== 'function') {
    const error = durableTailUnavailable(new Error('Invalid durable tail subscription'));
    return {
      ready: Promise.reject(error),
      catchUp: () => Promise.reject(error),
      seed: () => undefined,
      stop: () => undefined,
    };
  }
  const state =
    durableCallTails.get(key) || createDurableCallTail({ callSessionId, userId, pollIntervalMs });
  state.pollIntervalMs = Math.min(
    state.pollIntervalMs,
    Math.max(25, Number(pollIntervalMs) || DURABLE_TAIL_POLL_MS),
  );
  const listener = { onEvent, onError };
  state.listeners.add(listener);
  const ready = state.scan();
  let active = true;
  return {
    ready,
    catchUp: () => state.scan(),
    seed: (event) => {
      if (!event?.taskId || !Number.isSafeInteger(event.sequence)) return;
      state.seenSequences.set(
        event.taskId,
        Math.max(state.seenSequences.get(event.taskId) ?? -1, event.sequence),
      );
    },
    stop: () => {
      if (!active) return;
      active = false;
      state.listeners.delete(listener);
      if (state.listeners.size > 0) return;
      state.stopped = true;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      durableCallTails.delete(key);
    },
  };
}

function observeGenerationEvent(taskId, generationEvent) {
  const task = tasks.get(String(taskId || ''));
  const eventType = safeText(generationEvent?.event, 100);
  const isDelayedOwnerSource =
    task?.state === 'completed' &&
    task?.awaitingOwnerResult === true &&
    ['on_source', 'source', 'on_citation', 'citation'].includes(eventType);
  if (!task || task.suppressed || (TERMINAL_STATES.has(task.state) && !isDelayedOwnerSource)) {
    return null;
  }
  const data =
    generationEvent?.data && typeof generationEvent.data === 'object' ? generationEvent.data : {};
  const ownerEventId = safeText(data.id || data.runId || data.eventId, 160);
  const observedKey = ownerEventId
    ? [eventType, ownerEventId, safeText(data.status, 80)].join(':')
    : '';
  if (observedKey && task.observedEventKeys.has(observedKey)) {
    return null;
  }
  if (observedKey) {
    task.observedEventKeys.add(observedKey);
    while (task.observedEventKeys.size > MAX_EVENTS_PER_TASK) {
      task.observedEventKeys.delete(task.observedEventKeys.values().next().value);
    }
  }
  if (eventType === 'on_run_step' || eventType === 'on_run_step_completed') {
    const progress = sanitizeProgress(data);
    const toolCalls = Array.isArray(data?.stepDetails?.tool_calls)
      ? data.stepDetails.tool_calls
      : [];
    const toolName = toolCalls
      .map((call) => safeText(call?.function?.name || call?.name, 160))
      .find(Boolean);
    return nextEvent(task, {
      type: 'progress',
      phase: eventType === 'on_run_step_completed' ? 'tool_completed' : 'tool',
      label: toolName || safeText(data.name, 160) || safeText(data.type, 160) || 'Working',
      detail: eventType === 'on_run_step_completed' ? 'Step completed' : 'Step started',
      ...(progress ? { progress } : {}),
    });
  }
  if (eventType === 'attachment' && data?.type === 'web_search') {
    const webSearch = data.web_search && typeof data.web_search === 'object' ? data.web_search : {};
    const candidates = ['organic', 'news', 'images', 'videos']
      .flatMap((key) => (Array.isArray(webSearch[key]) ? webSearch[key] : []))
      .slice(0, 24);
    const seen = new Set();
    const emitted = [];
    for (const candidate of candidates) {
      const source = sanitizeSource({ ...candidate, provider: 'web_search' });
      const dedupeKey = source?.url || source?.id || source?.title;
      const observedSourceKey = dedupeKey ? `attachment-source:${dedupeKey}` : '';
      if (
        !source ||
        !source.url ||
        !dedupeKey ||
        seen.has(dedupeKey) ||
        task.observedEventKeys.has(observedSourceKey) ||
        emitted.length >= 12
      )
        continue;
      seen.add(dedupeKey);
      task.observedEventKeys.add(observedSourceKey);
      while (task.observedEventKeys.size > MAX_EVENTS_PER_TASK) {
        task.observedEventKeys.delete(task.observedEventKeys.values().next().value);
      }
      emitted.push(
        nextEvent(task, {
          type: 'source',
          phase: 'source',
          label: source.title || 'Source',
          source,
        }),
      );
    }
    return emitted[0] || null;
  }
  if (['on_source', 'source', 'on_citation', 'citation'].includes(eventType)) {
    const source = sanitizeSource(data);
    return source
      ? nextEvent(task, {
          type: 'source',
          phase: 'source',
          label: source.title || source.provider || 'Source',
          source,
        })
      : null;
  }
  if (eventType === 'on_cortex_update') {
    return nextEvent(task, {
      type: 'progress',
      phase: 'cortex',
      label: safeText(data.cortex_name, 160) || 'Background analysis',
      detail: safeText(data.status, 80),
    });
  }
  if (eventType === 'on_cortex_followup') {
    return nextEvent(task, {
      type: 'progress',
      phase: 'follow_up',
      label: 'Follow-up ready',
      detail: 'Background analysis completed',
    });
  }
  if (eventType === 'on_agent_update') {
    return nextEvent(task, {
      type: 'progress',
      phase: 'agent',
      label: safeText(data.name, 160) || 'Agent working',
      detail: safeText(data.message, 300),
    });
  }
  if (['needs_input', 'on_needs_input', 'input_required'].includes(eventType)) {
    const needsInput = sanitizeNeedsInput(data);
    if (!needsInput) {
      return null;
    }
    if (!getOwnerAdapter(task)?.provideInput) {
      task.state = 'failed';
      task.cancellable = false;
      task.retryable = Boolean(getOwnerAdapter(task)?.retry);
      task.expiresAtMs = Date.now() + TERMINAL_TASK_TTL_MS;
      return nextEvent(task, {
        type: 'error',
        phase: 'failed',
        label: 'Input could not be delivered',
        error: {
          code: 'task_input_unsupported',
          message: 'This task owner requested input but has no input adapter.',
        },
      });
    }
    task.inputOperation = null;
    task.state = 'needs_input';
    task.retryable = false;
    return nextEvent(task, {
      type: 'needs_input',
      phase: 'needs_input',
      label: 'Input needed',
      needsInput,
    });
  }
  return null;
}

function completeVoiceTask(taskId, { resultMessageId } = {}) {
  const task = tasks.get(String(taskId || ''));
  const attachingDelayedOwnerResult =
    task?.state === 'completed' && task?.awaitingOwnerResult === true;
  if (
    !task ||
    task.suppressed ||
    (TERMINAL_STATES.has(task.state) && !attachingDelayedOwnerResult)
  ) {
    return null;
  }
  if (task.state !== 'completed' && task.awaitingOwnerResult === true && !task.ownerChildLinked) {
    task.completionPending = true;
    task.pendingCompletionResultMessageId = safeText(resultMessageId, 160);
    task.cancellable = true;
    task.expiresAtMs = UNCONFIRMED_OWNER_RESULT_EXPIRES_AT_MS;
    return nextEvent(task, {
      type: 'progress',
      phase: 'delegated',
      label: 'Background work continuing',
      detail: 'The linked worker is still active.',
    });
  }
  task.state = 'completed';
  task.awaitingOwnerResult = false;
  task.ownerChildLinked = false;
  task.completionPending = false;
  task.pendingCompletionResultMessageId = '';
  task.cancellable = false;
  task.expiresAtMs = Date.now() + TERMINAL_TASK_TTL_MS;
  return nextEvent(task, {
    type: 'result',
    phase: 'completed',
    label: 'Completed',
    resultMessageId: safeText(resultMessageId, 160),
  });
}

function markVoiceTaskAwaitingOwnerResult(
  taskId,
  continuationKey = 'owner',
  { deadlineAtMs } = {},
) {
  const task = tasks.get(String(taskId || ''));
  if (!task || task.suppressed || TERMINAL_STATES.has(task.state)) return null;
  const key = safeText(continuationKey, 200) || 'owner';
  task.pendingOwnerResultKeys ||= new Set();
  task.pendingOwnerResultDeadlines ||= new Map();
  if (task.pendingOwnerResultKeys.has(key)) return task.lastEvent;
  if (Number(task.earlyOwnerLinkCredits) > 0) {
    task.earlyOwnerLinkCredits -= 1;
    task.ownerChildLinked = true;
    return nextEvent(task, {
      type: 'progress',
      phase: 'owner_linked',
      label: 'Background task linked',
      detail: 'The linked worker is tracked independently.',
    });
  }
  if (task.pendingOwnerResultKeys.size >= 64) {
    task.continuationOverflow = true;
    task.awaitingOwnerResult = true;
    task.ownerChildLinked = false;
    task.expiresAtMs = UNCONFIRMED_OWNER_RESULT_EXPIRES_AT_MS;
    return nextEvent(task, {
      type: 'progress',
      phase: 'delegated',
      label: 'Background work continuing',
      detail: 'Additional linked work remains active.',
    });
  }
  task.pendingOwnerResultKeys.add(key);
  const normalizedDeadlineAtMs = Number(deadlineAtMs);
  if (
    Number.isSafeInteger(normalizedDeadlineAtMs) &&
    normalizedDeadlineAtMs > Date.now() &&
    normalizedDeadlineAtMs <= Date.now() + 45 * 24 * 60 * 60 * 1000
  ) {
    task.pendingOwnerResultDeadlines.set(key, normalizedDeadlineAtMs);
  }
  task.awaitingOwnerResult = true;
  task.ownerChildLinked = false;
  task.expiresAtMs = UNCONFIRMED_OWNER_RESULT_EXPIRES_AT_MS;
  return nextEvent(task, {
    type: 'progress',
    phase: 'delegated',
    label: 'Background work dispatched',
    detail: 'Waiting for the linked worker to establish its durable task.',
  });
}

function linkVoiceTaskOwnerChild(
  taskId,
  { continuationKey = '', continuationPrefix = '', resolvedOwnerId = '' } = {},
) {
  const task = tasks.get(String(taskId || ''));
  if (!task || task.suppressed || TERMINAL_STATES.has(task.state)) return null;
  task.pendingOwnerResultKeys ||= new Set();
  task.pendingOwnerResultDeadlines ||= new Map();
  task.resolvedOwnerResultIds ||= new Set();
  const resolvedId = safeText(resolvedOwnerId, 200);
  if (resolvedId && task.resolvedOwnerResultIds.has(resolvedId)) return task.lastEvent;
  const key = safeText(continuationKey, 200);
  let removed = false;
  if (key) {
    removed = task.pendingOwnerResultKeys.delete(key);
    task.pendingOwnerResultDeadlines.delete(key);
  } else {
    const prefix = safeText(continuationPrefix, 120);
    const candidate = [...task.pendingOwnerResultKeys].find(
      (value) => !prefix || value.startsWith(prefix),
    );
    if (candidate) {
      removed = task.pendingOwnerResultKeys.delete(candidate);
      task.pendingOwnerResultDeadlines.delete(candidate);
    }
  }
  if (!removed && task.pendingOwnerResultKeys.size > 0) return task.lastEvent;
  if (resolvedId) {
    task.resolvedOwnerResultIds.add(resolvedId);
    while (task.resolvedOwnerResultIds.size > 64) {
      task.resolvedOwnerResultIds.delete(task.resolvedOwnerResultIds.values().next().value);
    }
  }
  if (!removed && task.pendingOwnerResultKeys.size === 0) {
    task.earlyOwnerLinkCredits = Math.min(64, (Number(task.earlyOwnerLinkCredits) || 0) + 1);
  }
  task.awaitingOwnerResult =
    task.continuationOverflow === true || task.pendingOwnerResultKeys.size > 0;
  task.ownerChildLinked = !task.awaitingOwnerResult;
  if (task.awaitingOwnerResult) {
    return nextEvent(task, {
      type: 'progress',
      phase: 'delegated',
      label: 'Background work continuing',
      detail: 'Another linked owner is still active.',
    });
  }
  if (task.completionPending) {
    return completeVoiceTask(task.taskId, {
      resultMessageId: task.pendingCompletionResultMessageId,
    });
  }
  return nextEvent(task, {
    type: 'progress',
    phase: 'owner_linked',
    label: 'Background task linked',
    detail: 'The linked worker is now tracked independently.',
  });
}

function failVoiceTask(taskId, error) {
  const task = tasks.get(String(taskId || ''));
  if (!task || task.suppressed || TERMINAL_STATES.has(task.state)) {
    return null;
  }
  task.state = 'failed';
  task.cancellable = false;
  task.retryOperation = null;
  task.retryable = Boolean(getOwnerAdapter(task)?.retry);
  task.expiresAtMs = Date.now() + TERMINAL_TASK_TTL_MS;
  return nextEvent(task, {
    type: 'error',
    phase: 'failed',
    label: 'Failed',
    error: {
      code: safeText(error?.code, 80) || 'generation_failed',
      message: safeText(error?.message || error, 300) || 'The task failed.',
    },
  });
}

function cancelVoiceTask(taskId, { userId, deferEvent = false } = {}) {
  const task = tasks.get(String(taskId || ''));
  if (!task || (userId && task.userId !== String(userId))) {
    return null;
  }
  if (task.state === 'cancelling') {
    return { task: publicTask(task), event: task.lastEvent, alreadyCancelling: true };
  }
  if (task.state === 'cancelled_confirmed' || task.state === 'cancelled_unenforceable') {
    return { task: publicTask(task), event: task.lastEvent, alreadyCancelled: true };
  }
  if (task.state === 'completed') {
    return { task: publicTask(task), event: task.lastEvent, alreadyCompleted: true };
  }
  if (task.state === 'failed') {
    return { task: publicTask(task), event: task.lastEvent, alreadyInactive: true };
  }
  task.suppressed = true;
  task.cancellable = false;
  if (deferEvent) {
    task.cancellationPrepared = true;
    return { task: publicTask(task), event: null, prepared: true };
  }
  task.state = 'cancelling';
  const event = nextEvent(task, {
    type: 'state',
    phase: 'cancelling',
    label: 'Cancelling',
  });
  return { task: publicTask(task), event };
}

async function requestVoiceTaskOwnerCancellation(taskId, { userId } = {}) {
  const task = tasks.get(String(taskId || ''));
  if (!task || (userId && task.userId !== String(userId))) {
    return null;
  }
  const cancellation = cancelVoiceTask(taskId, { userId, deferEvent: true });
  if (cancellation?.alreadyCompleted) {
    return { ...cancellation, ownerSupported: false, ownerAccepted: false };
  }
  if (cancellation?.alreadyCancelled) {
    return { ...cancellation, ownerSupported: false, ownerAccepted: false, ownerPending: false };
  }
  if (cancellation?.alreadyInactive) {
    return { ...cancellation, ownerSupported: false, ownerAccepted: false, ownerPending: false };
  }
  if (cancellation?.alreadyCancelling) {
    return {
      ...cancellation,
      operationId: task.ownerOperationId || null,
      ownerSupported: Boolean(getOwnerAdapter(task)),
      ownerAccepted: task.cancelOperation?.result?.ownerAccepted === true,
      ownerPending: task.ownerDeliveryPending === true,
    };
  }
  const adapter = getOwnerAdapter(task);
  task.ownerOperationId = task.ownerOperationId || crypto.randomUUID();
  task.ownerDeliveryPending = Boolean(adapter?.cancel);
  task.ownerCancellationAccepted = false;
  // The local barrier is authoritative only after the independent 24-hour durable tombstone is
  // written. Owner delivery happens later and never delays the browser acknowledgement.
  try {
    await persistVoiceTaskSuppression(task);
  } catch (error) {
    task.cancellationPrepared = false;
    task.cancellationPreparedEvent = null;
    task.suppressionEvent = null;
    task.state = 'recovering';
    task.cancellable = true;
    const event = nextEvent(task, {
      type: 'error',
      phase: 'cancel_barrier_recovering',
      label: 'Cancellation needs retry',
      error: {
        code: 'cancel_barrier_unavailable',
        message: 'Cancellation could not be made durable. Output remains locally suppressed.',
        retryable: true,
      },
    });
    const failure = new Error('Cancellation barrier persistence failed');
    failure.status = 503;
    failure.code = 'gateway_down';
    failure.event = event;
    throw failure;
  }
  task.cancellationPrepared = false;
  task.state = 'cancelling';
  const preparedCancellationEvent = task.cancellationPreparedEvent;
  const cancellingEvent = nextEvent(task, {
    type: 'state',
    phase: 'cancelling',
    label: 'Cancelling',
    eventId: preparedCancellationEvent?.eventId,
    emittedAt: preparedCancellationEvent?.emittedAt,
  });
  task.cancellationPreparedEvent = null;
  const committedCancellation = {
    ...cancellation,
    task: publicTask(task),
    event: cancellingEvent,
    operationId: task.ownerOperationId,
  };
  void queueTaskPersistence(task);
  if (!adapter?.cancel) {
    queueMicrotask(() => {
      void settleVoiceTaskCancellation(task.taskId, {
        confirmed: false,
        detail: 'This task owner cannot confirm cancellation; late output remains suppressed.',
      }).catch(() => undefined);
    });
    return {
      ...committedCancellation,
      ownerSupported: false,
      ownerAccepted: false,
      ownerPending: false,
    };
  }
  if (task.cancelOperation?.promise) {
    return {
      ...committedCancellation,
      ownerSupported: true,
      ownerAccepted: task.cancelOperation.result?.ownerAccepted === true,
      ownerPending: true,
    };
  }
  if (task.cancelOperation?.result?.ownerAccepted === true) {
    return { ...task.cancelOperation.result, ownerPending: false };
  }

  const operationId = task.ownerOperationId;
  const operation = { operationId, promise: null, result: null };
  const delivery = (async () => {
    try {
      const ownerResult = await adapter.cancel({
        taskId: task.taskId,
        owner: { ...task.owner },
        operationId,
      });
      if (ownerResult?.alreadyCompleted === true) {
        await clearVoiceTaskSuppression(task.taskId);
        task.suppressed = false;
        task.state = 'completed';
        task.awaitingOwnerResult = true;
        task.cancellable = false;
        task.retryable = false;
        task.ownerDeliveryPending = false;
        ownerAdapters.delete(ownerAdapterKey(task.owner?.kind, task.taskId));
        const event = nextEvent(task, {
          type: 'state',
          phase: 'already_completed',
          label: 'Already completed',
          detail: 'The owner completed before cancellation; the final result is arriving.',
        });
        const result = {
          ...committedCancellation,
          task: publicTask(task),
          event,
          alreadyCompleted: true,
          ownerSupported: true,
          ownerAccepted: false,
        };
        operation.result = result;
        return result;
      }
      const result = {
        ...committedCancellation,
        ownerSupported: true,
        ownerAccepted: ownerResult?.accepted === true,
      };
      operation.result = result;
      task.ownerDeliveryPending = false;
      task.ownerCancellationAccepted = ownerResult?.accepted === true;
      await persistVoiceTaskSuppression(task);
      void queueTaskPersistence(task);
      if (ownerResult?.accepted !== true) {
        await settleVoiceTaskCancellation(task.taskId, {
          confirmed: false,
          detail: 'The owner could not confirm cancellation; late output remains suppressed.',
        });
      }
      return result;
    } catch {
      const result = {
        ...committedCancellation,
        ownerSupported: true,
        ownerAccepted: false,
      };
      operation.result = result;
      task.ownerDeliveryPending = false;
      task.ownerCancellationAccepted = false;
      await persistVoiceTaskSuppression(task).catch(() => undefined);
      void queueTaskPersistence(task);
      await settleVoiceTaskCancellation(task.taskId, {
        confirmed: false,
        detail: 'The owner could not confirm cancellation; late output remains suppressed.',
      });
      return result;
    }
  })();
  operation.promise = delivery;
  task.cancelOperation = operation;
  void delivery.finally(() => {
    operation.promise = null;
  });
  return {
    ...committedCancellation,
    ownerSupported: true,
    ownerAccepted: false,
    ownerPending: true,
  };
}

async function flushVoiceTaskOwnerOperations() {
  await Promise.allSettled(
    [...tasks.values()].map((task) => task.cancelOperation?.promise).filter(Boolean),
  );
}

async function settleVoiceTaskCancellation(taskId, { confirmed, detail } = {}) {
  const task = tasks.get(String(taskId || ''));
  const correctingLateOwnerProof = task?.state === 'cancelled_unenforceable' && confirmed === true;
  if (!task || (task.state !== 'cancelling' && !correctingLateOwnerProof)) {
    return null;
  }
  // Build and persist the terminal tombstone off-map. Until that write succeeds, callers must
  // continue to observe the already-durable `cancelling` state rather than a crash-vulnerable
  // terminal state.
  const terminalTask = {
    ...task,
    current: { ...(task.current || {}) },
    events: [...task.events],
    ownerDeliveryPending: false,
    state: confirmed ? 'cancelled_confirmed' : 'cancelled_unenforceable',
    expiresAtMs: Date.now() + TERMINAL_TASK_TTL_MS,
  };
  const event = nextEvent(terminalTask, {
    type: 'state',
    phase: terminalTask.state,
    label: confirmed ? 'Cancelled' : 'Cancellation could not be confirmed',
    detail,
    deferDelivery: true,
  });
  terminalTask.suppressionEvent = {
    eventId: event.eventId,
    sequence: event.sequence,
    emittedAt: event.emittedAt,
  };
  await persistVoiceTaskSuppression(terminalTask);

  task.ownerDeliveryPending = terminalTask.ownerDeliveryPending;
  task.state = terminalTask.state;
  task.expiresAtMs = terminalTask.expiresAtMs;
  task.sequence = terminalTask.sequence;
  task.updatedAt = terminalTask.updatedAt;
  task.current = terminalTask.current;
  task.lastEvent = terminalTask.lastEvent;
  task.events = terminalTask.events;
  task.cancellationPreparedEvent = terminalTask.cancellationPreparedEvent;
  task.suppressionEvent = terminalTask.suppressionEvent;
  ownerAdapters.delete(ownerAdapterKey(task.owner?.kind, task.taskId));
  publishTaskEvent(task, event);
  return event;
}

async function confirmVoiceTaskOwnerCancellation(taskId, detail) {
  const task = tasks.get(String(taskId || ''));
  if (!task) {
    return null;
  }
  if (task.state === 'cancelled_confirmed') {
    return task.lastEvent;
  }
  if (task.state === 'cancelled_unenforceable') {
    return await settleVoiceTaskCancellation(taskId, {
      confirmed: true,
      detail: safeText(detail, 500) || 'The task owner later proved it stopped.',
    });
  }
  if (TERMINAL_STATES.has(task.state)) {
    return null;
  }
  if (task.state !== 'cancelling') {
    task.suppressed = true;
    task.state = 'cancelling';
    task.cancellable = false;
    nextEvent(task, { type: 'state', phase: 'cancelling', label: 'Cancelling' });
  }
  return await settleVoiceTaskCancellation(taskId, {
    confirmed: true,
    detail: safeText(detail, 500) || 'The task owner confirmed it stopped.',
  });
}

function isVoiceTaskSuppressed(taskId) {
  const id = String(taskId || '');
  const tombstone = suppressionTombstones.get(id);
  if (suppressionTombstoneIsActive(tombstone)) return true;
  if (tombstone) suppressionTombstones.delete(id);
  return tasks.get(id)?.suppressed === true;
}

function resetVoiceTasksForTests() {
  taskPersistenceGeneration += 1;
  tasks.clear();
  taskIdByStreamId.clear();
  subscribers.clear();
  callSubscribers.clear();
  for (const tail of durableCallTails.values()) {
    tail.stopped = true;
    if (tail.timer) clearTimeout(tail.timer);
  }
  durableCallTails.clear();
  ownerAdapters.clear();
  suppressionTombstones.clear();
  pendingTaskPersistence.clear();
  taskPersistenceDrain = null;
  suppressionPersistenceTestAdapter = isTestRuntime()
    ? { persist: async () => undefined, clear: async () => undefined }
    : null;
}

function getVoiceTaskRegistryStats() {
  cleanupVoiceTasks();
  let events = 0;
  let observedEventKeys = 0;
  for (const task of tasks.values()) {
    events += task.events.length;
    observedEventKeys += task.observedEventKeys.size;
  }
  return {
    tasks: tasks.size,
    streams: taskIdByStreamId.size,
    subscribers: [...subscribers.values()].reduce((sum, set) => sum + set.size, 0),
    callSubscribers: [...callSubscribers.values()].reduce((sum, set) => sum + set.size, 0),
    durableCallTails: durableCallTails.size,
    durableTailScans: [...durableCallTails.values()].reduce((sum, tail) => sum + tail.scanCount, 0),
    ownerAdapters: ownerAdapters.size,
    suppressionTombstones: suppressionTombstones.size,
    events,
    observedEventKeys,
  };
}

module.exports = {
  bindVoiceTaskStream,
  canConfirmVoiceTaskCancellation,
  cancelVoiceTask,
  completeVoiceTask,
  confirmVoiceTaskOwnerCancellation,
  createVoiceTask,
  failVoiceTask,
  getVoiceTask,
  getVoiceTaskByStreamId,
  getVoiceTaskOwnerCapabilityInventory,
  getDurableVoiceTaskContinuationState,
  getVoiceTaskRegistryStats,
  hydrateVoiceTask,
  hydrateVoiceTaskByStreamId,
  hydrateVoiceTasksForCall,
  hydrateVoiceTaskSuppression,
  flushVoiceTaskPersistence,
  flushVoiceTaskOwnerOperations,
  isVoiceTaskSuppressed,
  isVoiceTaskSuppressedDurably,
  clearVoiceTaskSuppression,
  listVoiceTasks,
  listDurableVoiceTaskSnapshots,
  linkVoiceTaskOwnerChild,
  markVoiceTaskAwaitingOwnerResult,
  observeGenerationEvent,
  registerVoiceTaskOwnerAdapter,
  requestVoiceTaskOwnerCancellation,
  resetVoiceTasksForTests,
  retryVoiceTask,
  setVoiceTaskOwnerCapabilities,
  submitVoiceTaskInput,
  settleVoiceTaskCancellation,
  setVoiceTaskSuppressionPersistenceForTests,
  snapshotEvent,
  subscribeVoiceTask,
  subscribeVoiceTasksForCall,
  subscribeDurableVoiceTaskEventsForCall,
  estimateDurableVoiceTailReads,
};
