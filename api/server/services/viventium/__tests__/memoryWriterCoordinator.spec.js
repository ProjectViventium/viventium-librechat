/* === VIVENTIUM START ===
 * Purpose: Regression coverage for per-user saved-memory writer serialization.
 * === VIVENTIUM END === */

const {
  enqueueUserMemoryWriter,
  resetMemoryWriterCoordinatorForTests,
} = require('../memoryWriterCoordinator');

describe('memoryWriterCoordinator', () => {
  afterEach(() => {
    resetMemoryWriterCoordinatorForTests();
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
});
