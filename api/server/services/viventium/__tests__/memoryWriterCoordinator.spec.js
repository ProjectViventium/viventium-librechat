/* === VIVENTIUM START ===
 * Purpose: Regression coverage for per-user saved-memory writer serialization.
 * === VIVENTIUM END === */

const {
  enqueueUserMemoryWriter,
  bindActiveMemoryWriterTool,
  activeMemoryWriterTool,
  trackAdmittedMemoryWriter,
  startMemoryWriterRecovery,
  memoryWriterOwner,
  resetMemoryWriterCoordinatorForTests,
} = require('../memoryWriterCoordinator');

describe('memoryWriterCoordinator', () => {
  afterEach(() => {
    resetMemoryWriterCoordinatorForTests();
    jest.useRealTimers();
  });

  it('serializes writers for the same user across client instances', async () => {
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const events = [];

    const first = enqueueUserMemoryWriter({
      userId: 'user-1',
      run: async () => {
        events.push('first:start');
        await firstGate;
        events.push('first:end');
      },
    });
    const second = enqueueUserMemoryWriter({
      userId: 'user-1',
      run: async () => {
        events.push('second:start');
        events.push('second:end');
      },
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('preserves every queued turn so cross-conversation facts are not dropped', async () => {
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const runs = [];

    const first = enqueueUserMemoryWriter({
      userId: 'user-1',
      run: async () => {
        runs.push('first');
        await firstGate;
      },
    });
    const superseded = enqueueUserMemoryWriter({
      userId: 'user-1',
      run: async () => runs.push('superseded'),
    });
    const latest = enqueueUserMemoryWriter({
      userId: 'user-1',
      run: async () => runs.push('latest'),
    });

    releaseFirst();
    await Promise.all([first, superseded, latest]);

    expect(runs).toEqual(['first', 'superseded', 'latest']);
  });

  it('allows different users to run independently', async () => {
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const events = [];

    const first = enqueueUserMemoryWriter({
      userId: 'user-1',
      run: async () => {
        events.push('user-1:start');
        await firstGate;
      },
    });
    const second = enqueueUserMemoryWriter({
      userId: 'user-2',
      run: async () => events.push('user-2:start'),
    });

    await second;
    expect(events).toEqual(['user-1:start', 'user-2:start']);

    releaseFirst();
    await first;
  });

  it('heartbeats only live closures and sends only CAS-reclaimed pending work through recovery', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const row = { user: 'owner', messageId: 'answer', savedMemoryWrite: {
      owner: 'old-runtime', status: 'pending', heartbeatAt: new Date(0),
    } };
    const db = {
      refreshMemoryWrites: jest.fn().mockResolvedValue(0),
      ensureMemoryWriteIndex: jest.fn().mockResolvedValue('index'),
      listPendingMemoryWrites: jest.fn().mockResolvedValueOnce([row]).mockResolvedValue([]),
      reclaimPendingMemoryWrite: jest.fn().mockResolvedValue(true),
      recoverInterruptedMemoryWrites: jest.fn().mockResolvedValue(0),
    };
    const recoverPending = jest.fn(() => hold);
    startMemoryWriterRecovery({ db, logger: { warn: jest.fn() }, recoverPending });
    await new Promise(setImmediate);
    expect(recoverPending).toHaveBeenCalledWith(row, { userId: 'owner', messageId: 'answer', owner: memoryWriterOwner });
    expect(db.reclaimPendingMemoryWrite).toHaveBeenCalledWith(expect.objectContaining({
      previousOwner: 'old-runtime', heartbeatAt: row.savedMemoryWrite.heartbeatAt,
    }));
    expect(db.recoverInterruptedMemoryWrites).toHaveBeenCalledWith({ before: expect.any(Date), includePending: false });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(db.refreshMemoryWrites).toHaveBeenLastCalledWith(memoryWriterOwner, ['answer']);
    release();
    await new Promise(setImmediate);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(db.refreshMemoryWrites).toHaveBeenLastCalledWith(memoryWriterOwner, []);
    expect(db.ensureMemoryWriteIndex).toHaveBeenCalledTimes(1);
  });
});

// Native transport uses the existing active queue entry, never a separate callback registry.
describe('admitted native memory callback ownership', () => {
  afterEach(resetMemoryWriterCoordinatorForTests);
  it('binds only the active admitted identity and removes access on finish', async () => {
    const identity = { userId: 'owner', messageId: 'answer', conversationId: 'chat', owner: memoryWriterOwner };
    const binding = { identity, matchesIdentity: (other) => other === identity, accepts: () => true };
    expect(() => bindActiveMemoryWriterTool(binding)).toThrow('not_active');
    const untrack = trackAdmittedMemoryWriter(identity.messageId);
    await enqueueUserMemoryWriter({ userId: identity.userId, identity, run: async () => {
      const unregister = bindActiveMemoryWriterTool(binding);
      expect(activeMemoryWriterTool({ user_id: identity.userId })).toBe(binding);
      expect(activeMemoryWriterTool({ user_id: 'other' })).toBeNull();
      expect(() => bindActiveMemoryWriterTool(binding)).toThrow('not_active');
      unregister();
      expect(activeMemoryWriterTool({ user_id: identity.userId })).toBeNull();
    } });
    untrack();
    await new Promise(setImmediate);
    expect(() => bindActiveMemoryWriterTool(binding)).toThrow('not_active');
  });
  it('drops a running callback when its process-owned state disappears', async () => {
    const identity = { userId: 'owner', messageId: 'answer', conversationId: 'chat', owner: memoryWriterOwner };
    const untrack = trackAdmittedMemoryWriter(identity.messageId);
    await enqueueUserMemoryWriter({ userId: identity.userId, identity, run: async () => {
      const binding = { identity, matchesIdentity: (other) => other === identity, accepts: () => true };
      bindActiveMemoryWriterTool(binding);
      resetMemoryWriterCoordinatorForTests();
      expect(activeMemoryWriterTool({ user_id: identity.userId })).toBeNull();
    } });
    untrack();
  });
});
