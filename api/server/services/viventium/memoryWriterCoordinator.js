/* === VIVENTIUM START ===
 * Feature: Per-user saved-memory writer serialization.
 * Purpose: Detached writers are created by separate AgentClient instances. Keep at most one
 * writer active per user and preserve every queued turn so facts from one conversation are never
 * discarded by a later turn from another surface.
 * === VIVENTIUM END === */

const writersByUser = new Map();

function startEntry(userId, entry) {
  const state = writersByUser.get(userId);
  if (!state) {
    return;
  }

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

function enqueueUserMemoryWriter({ userId, run }) {
  if (userId == null || String(userId).trim() === '') {
    return Promise.resolve().then(run);
  }

  const queueKey = String(userId);
  return new Promise((resolve, reject) => {
    const entry = { run, resolve, reject };
    const state = writersByUser.get(queueKey);
    if (!state) {
      writersByUser.set(queueKey, { queue: [] });
      startEntry(queueKey, entry);
      return;
    }

    state.queue.push(entry);
  });
}

function resetMemoryWriterCoordinatorForTests() {
  writersByUser.clear();
}

module.exports = {
  enqueueUserMemoryWriter,
  resetMemoryWriterCoordinatorForTests,
};
