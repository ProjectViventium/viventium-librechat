/* === VIVENTIUM START ===
 * Feature: Per-user saved-memory writer serialization.
 * Purpose: Detached writers are created by separate AgentClient instances. Keep at most one
 * writer active per user and preserve every queued turn so facts from one conversation are never
 * discarded by a later turn from another surface.
 * === VIVENTIUM END === */

const writersByUser = new Map();
const memoryWriterOwner = require('crypto').randomUUID();
const admittedMessages = new Set();
let recoveryTimer;

// This timer observes the existing queue. Only provably unstarted work may be recovered. Stop refreshing
// a row when its closure ends so a failed receipt write is reconciled even without process restart.
function startMemoryWriterRecovery({ db, logger, recoverPending }) {
  if (recoveryTimer) {
    return;
  }
  let running = false;
  let indexReady = false;
  const reconcile = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await db.refreshMemoryWrites(memoryWriterOwner, [...admittedMessages]);
      if (!indexReady) {
        await db.ensureMemoryWriteIndex();
        indexReady = true;
      }
      const before = new Date(Date.now() - 120_000);
      if (recoverPending) {
        for (const row of await db.listPendingMemoryWrites({ before })) {
          const identity = { userId: row.user, messageId: row.messageId, owner: memoryWriterOwner };
          if (
            !(await db.reclaimPendingMemoryWrite({
              ...identity,
              previousOwner: row.savedMemoryWrite.owner,
              heartbeatAt: row.savedMemoryWrite.heartbeatAt,
            }))
          ) {
            continue;
          }
          const untrack = trackAdmittedMemoryWriter(row.messageId);
          void enqueueUserMemoryWriter({
            userId: row.user,
            identity: { ...identity, conversationId: row.conversationId },
            run: () => recoverPending(row, identity),
          })
            .catch((error) =>
              logger.warn('[MemoryWriter] Pending save could not resume', { name: error?.name }),
            )
            .finally(untrack);
        }
      }
      await db.recoverInterruptedMemoryWrites({ before, includePending: !recoverPending });
    } catch (error) {
      logger.warn('[MemoryWriter] Durable save reconciliation unavailable', { name: error?.name });
    } finally {
      running = false;
    }
  };
  void reconcile();
  recoveryTimer = setInterval(reconcile, 30_000);
  recoveryTimer.unref?.();
}

function trackAdmittedMemoryWriter(messageId) {
  admittedMessages.add(messageId);
  return () => admittedMessages.delete(messageId);
}

function startEntry(userId, entry) {
  const state = writersByUser.get(userId);
  if (!state) {
    return;
  }

  state.active = entry;
  Promise.resolve()
    .then(entry.run)
    .then(entry.resolve, entry.reject)
    .finally(() => {
      const current = writersByUser.get(userId);
      if (current !== state) {
        return;
      }
      if (state.queue.length === 0) {
        writersByUser.delete(userId);
        return;
      }

      const pending = state.queue.shift();
      startEntry(userId, pending);
    });
}

function enqueueUserMemoryWriter({ userId, run, identity }) {
  if (userId == null || String(userId).trim() === '') {
    return Promise.resolve().then(run);
  }

  const queueKey = String(userId);
  return new Promise((resolve, reject) => {
    const entry = { run, resolve, reject, identity };
    const state = writersByUser.get(queueKey);
    if (!state) {
      writersByUser.set(queueKey, { queue: [] });
      startEntry(queueKey, entry);
      return;
    }

    state.queue.push(entry);
  });
}

// Broker calls resolve the same active writer closure. A process restart or queue advance
// removes the binding; existing interrupted-write reconciliation owns any uncertain mutation.
function bindActiveMemoryWriterTool(binding) {
  const entry = writersByUser.get(String(binding.identity.userId))?.active;
  if (
    !entry ||
    binding.identity.owner !== memoryWriterOwner ||
    !admittedMessages.has(binding.identity.messageId) ||
    !binding.matchesIdentity(entry.identity) ||
    entry.nativeTool
  ) {
    throw new Error('native_memory_writer_not_active');
  }
  entry.nativeTool = binding;
  return () => {
    if (entry.nativeTool === binding) delete entry.nativeTool;
  };
}

function activeMemoryWriterTool(grant) {
  const binding = writersByUser.get(String(grant?.user_id || ''))?.active?.nativeTool;
  return binding?.accepts(grant) ? binding : null;
}

function resetMemoryWriterCoordinatorForTests() {
  writersByUser.clear();
  admittedMessages.clear();
  clearInterval(recoveryTimer);
  recoveryTimer = undefined;
}

module.exports = {
  bindActiveMemoryWriterTool,
  activeMemoryWriterTool,
  memoryWriterOwner,
  startMemoryWriterRecovery,
  trackAdmittedMemoryWriter,
  enqueueUserMemoryWriter,
  resetMemoryWriterCoordinatorForTests,
};
