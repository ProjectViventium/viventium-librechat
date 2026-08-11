/* === VIVENTIUM START === Durable VoiceTask/restart/cancellation regression tests. === VIVENTIUM END === */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const service = require('../VoiceTaskService');

describe('VoiceTask durable replay and suppression', () => {
  let mongoServer;
  let ViventiumVoiceTask;
  let ViventiumVoiceTaskSuppression;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    ({ ViventiumVoiceTask, ViventiumVoiceTaskSuppression } = require('~/db/models'));
  });

  afterAll(async () => {
    await service.flushVoiceTaskPersistence();
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    service.resetVoiceTasksForTests();
    service.setVoiceTaskSuppressionPersistenceForTests(null);
    await ViventiumVoiceTask.deleteMany({});
    await ViventiumVoiceTaskSuppression.deleteMany({});
  });

  test('hydrates bounded task state, events, sources, and result after an API restart', async () => {
    const task = service.createVoiceTask({
      callSessionId: 'call-restart',
      userId: 'user-restart',
      conversationId: 'conversation-restart',
      streamId: 'stream-restart',
    });
    service.observeGenerationEvent(task.taskId, {
      event: 'on_source',
      data: { id: 'source-1', title: 'Source', url: 'https://example.test/source' },
    });
    service.completeVoiceTask(task.taskId, { resultMessageId: 'message-result' });
    await service.flushVoiceTaskPersistence();
    service.resetVoiceTasksForTests();

    await service.hydrateVoiceTasksForCall({
      callSessionId: 'call-restart',
      userId: 'user-restart',
    });

    expect(service.snapshotEvent(task.taskId)).toMatchObject({
      state: 'completed',
      resultMessageId: 'message-result',
      sources: [{ id: 'source-1', title: 'Source', url: 'https://example.test/source' }],
    });
  });

  test('requeues a failed durable batch and persists the latest sequence on retry', async () => {
    const originalBulkWrite = ViventiumVoiceTask.bulkWrite.bind(ViventiumVoiceTask);
    let attempts = 0;
    const bulkWrite = jest.spyOn(ViventiumVoiceTask, 'bulkWrite').mockImplementation((...args) => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(
          Object.assign(new Error('synthetic transient write failure'), {
            code: 91,
          }),
        );
      }
      return originalBulkWrite(...args);
    });
    try {
      const task = service.createVoiceTask({
        callSessionId: 'call-retry-batch',
        userId: 'user-retry-batch',
        streamId: 'stream-retry-batch',
      });
      service.observeGenerationEvent(task.taskId, {
        event: 'on_agent_update',
        data: { eventId: 'latest-before-retry', name: 'Latest durable progress' },
      });

      await service.flushVoiceTaskPersistence();

      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(await ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean()).toMatchObject({
        sequence: 3,
        payload: {
          sequence: 3,
          current: { phase: 'agent', label: 'Latest durable progress' },
        },
      });
    } finally {
      bulkWrite.mockRestore();
    }
  });

  test('commits the durable barrier before cancelling ACK and survives immediate restart', async () => {
    const task = service.createVoiceTask({
      callSessionId: 'call-cancel-restart',
      userId: 'user-restart',
      streamId: 'stream-cancel-restart',
    });
    await service.flushVoiceTaskPersistence();
    const result = await service.requestVoiceTaskOwnerCancellation(task.taskId, {
      userId: 'user-restart',
    });
    expect(result).toMatchObject({ task: { state: 'cancelling' } });

    service.resetVoiceTasksForTests();
    await service.hydrateVoiceTask(task.taskId, {
      callSessionId: 'call-cancel-restart',
      userId: 'user-restart',
    });
    expect(service.snapshotEvent(task.taskId)).toMatchObject({
      state: 'cancelled_unenforceable',
    });
    expect(service.isVoiceTaskSuppressed(task.taskId)).toBe(true);
    expect(service.completeVoiceTask(task.taskId, { resultMessageId: 'late' })).toBeNull();
  });

  test('replays and hydrates a suppression-only cancellation after the task write crash window', async () => {
    const task = service.createVoiceTask({
      callSessionId: 'call-suppression-only',
      userId: 'user-restart',
      conversationId: 'conversation-suppression-only',
      streamId: 'stream-suppression-only',
    });
    await service.flushVoiceTaskPersistence();
    const terminalEvent = new Promise((resolve) => {
      const unsubscribe = service.subscribeVoiceTask(task.taskId, (event) => {
        if (event?.state === 'cancelled_unenforceable') {
          unsubscribe();
          resolve(event);
        }
      });
    });
    const acknowledgement = await service.requestVoiceTaskOwnerCancellation(task.taskId, {
      userId: 'user-restart',
    });
    expect(acknowledgement).toMatchObject({
      event: {
        eventId: expect.any(String),
        sequence: expect.any(Number),
        state: 'cancelling',
      },
    });
    await terminalEvent;
    const terminalSnapshot = service.snapshotEvent(task.taskId);
    expect(terminalSnapshot).toMatchObject({ state: 'cancelled_unenforceable' });
    const terminalSuppression = await ViventiumVoiceTaskSuppression.findOne({
      taskId: task.taskId,
    }).lean();
    expect(terminalSuppression).toMatchObject({
      eventId: expect.any(String),
      sequence: terminalSnapshot.sequence,
      state: 'cancelled_unenforceable',
    });
    service.resetVoiceTasksForTests();
    await ViventiumVoiceTask.deleteMany({ taskId: task.taskId });

    const page = await service.listDurableVoiceTaskSnapshots({
      callSessionId: 'call-suppression-only',
      userId: 'user-restart',
      requireDurable: true,
    });
    expect(page.events).toEqual([
      expect.objectContaining({
        eventId: terminalSuppression.eventId,
        sequence: terminalSnapshot.sequence,
        taskId: task.taskId,
        state: 'cancelled_unenforceable',
      }),
    ]);

    await service.hydrateVoiceTaskByStreamId('stream-suppression-only', {
      callSessionId: 'call-suppression-only',
      userId: 'user-restart',
    });
    expect(service.getVoiceTask(task.taskId)).toMatchObject({
      state: 'cancelled_unenforceable',
    });
    expect(service.isVoiceTaskSuppressed(task.taskId)).toBe(true);
    expect(service.completeVoiceTask(task.taskId, { resultMessageId: 'late' })).toBeNull();
  });

  test('keeps an unconfirmed cancellation barrier durable without a wall-clock expiry', async () => {
    const task = service.createVoiceTask({
      callSessionId: 'call-unbounded-owner',
      userId: 'user-restart',
      conversationId: 'conversation-unbounded-owner',
      streamId: 'stream-unbounded-owner',
    });
    const terminalEvent = new Promise((resolve) => {
      const unsubscribe = service.subscribeVoiceTask(task.taskId, (event) => {
        if (event?.state === 'cancelled_unenforceable') {
          unsubscribe();
          resolve(event);
        }
      });
    });

    await service.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'user-restart' });
    await terminalEvent;
    await service.flushVoiceTaskPersistence();
    const suppression = await ViventiumVoiceTaskSuppression.findOne({ taskId: task.taskId }).lean();
    expect(suppression.state).toBe('cancelled_unenforceable');
    expect(suppression.expiresAt).toBeNull();
    await ViventiumVoiceTaskSuppression.updateOne(
      { taskId: task.taskId },
      { $set: { acceptedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) } },
    );

    service.resetVoiceTasksForTests();
    await ViventiumVoiceTask.deleteMany({ taskId: task.taskId });
    await service.hydrateVoiceTaskByStreamId('stream-unbounded-owner', {
      callSessionId: 'call-unbounded-owner',
      userId: 'user-restart',
      requireDurable: true,
    });

    expect(service.isVoiceTaskSuppressed(task.taskId)).toBe(true);
    expect(
      service.completeVoiceTask(task.taskId, { resultMessageId: 'late-after-45-days' }),
    ).toBeNull();
  });

  test('keeps post-hangup continuation server-authoritative beyond a short client quiet window', async () => {
    const task = service.createVoiceTask({
      callSessionId: 'call-continuation-truth',
      userId: 'user-restart',
      conversationId: 'conversation-continuation-truth',
      streamId: 'stream-continuation-truth',
    });
    service.completeVoiceTask(task.taskId, { resultMessageId: 'terminal-parent' });
    await service.flushVoiceTaskPersistence();
    const persisted = await ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean();
    const lastActivityMs = new Date(persisted.updatedAt).getTime();

    await expect(
      service.getDurableVoiceTaskContinuationState({
        callSessionId: 'call-continuation-truth',
        userId: 'user-restart',
        nowMs: lastActivityMs + 6_000,
      }),
    ).resolves.toMatchObject({ status: 'quiescent', hasActive: false });
    await expect(
      service.getDurableVoiceTaskContinuationState({
        callSessionId: 'call-continuation-truth',
        userId: 'user-restart',
        nowMs: lastActivityMs + 16 * 60 * 1000,
      }),
    ).resolves.toMatchObject({ status: 'quiescent', hasActive: false });
  });

  test('keeps a dispatched owner task active beyond fifteen minutes until its durable child links', async () => {
    const task = service.createVoiceTask({
      callSessionId: 'call-owner-link',
      userId: 'user-restart',
      conversationId: 'conversation-owner-link',
      streamId: 'stream-owner-link',
    });
    service.markVoiceTaskAwaitingOwnerResult(task.taskId, 'glasshive_dispatch:tool-1');
    service.markVoiceTaskAwaitingOwnerResult(task.taskId, 'phase_b:message-dispatch-ack');
    service.completeVoiceTask(task.taskId, { resultMessageId: 'message-dispatch-ack' });
    await service.flushVoiceTaskPersistence();
    const persisted = await ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean();
    const dispatchedAtMs = new Date(persisted.updatedAt).getTime();

    expect(service.snapshotEvent(task.taskId)).toMatchObject({
      state: 'running',
      phase: 'delegated',
    });
    await expect(
      service.getDurableVoiceTaskContinuationState({
        callSessionId: 'call-owner-link',
        userId: 'user-restart',
        nowMs: dispatchedAtMs + 16 * 60 * 1000,
      }),
    ).resolves.toMatchObject({ status: 'active', hasActive: true });

    service.linkVoiceTaskOwnerChild(task.taskId, {
      continuationKey: 'phase_b:message-dispatch-ack',
    });
    expect(service.snapshotEvent(task.taskId)).toMatchObject({ state: 'running' });
    service.linkVoiceTaskOwnerChild(task.taskId, {
      continuationPrefix: 'glasshive_dispatch:',
      resolvedOwnerId: 'glasshive_run:run-1',
    });
    service.linkVoiceTaskOwnerChild(task.taskId, {
      continuationPrefix: 'glasshive_dispatch:',
      resolvedOwnerId: 'glasshive_run:run-1',
    });
    await service.flushVoiceTaskPersistence();
    expect(service.snapshotEvent(task.taskId)).toMatchObject({
      state: 'completed',
      resultMessageId: 'message-dispatch-ack',
    });
  });

  test('fails a callback-backed owner task after its durable delivery deadline survives restart', async () => {
    const task = service.createVoiceTask({
      callSessionId: 'call-owner-dead-letter',
      userId: 'user-restart',
      conversationId: 'conversation-owner-dead-letter',
      streamId: 'stream-owner-dead-letter',
    });
    const deadlineAtMs = Date.now() + 1_000;
    service.markVoiceTaskAwaitingOwnerResult(task.taskId, 'glasshive_dispatch:tool-dead', {
      deadlineAtMs,
    });
    service.completeVoiceTask(task.taskId, { resultMessageId: 'dispatch-ack' });
    await service.flushVoiceTaskPersistence();
    service.resetVoiceTasksForTests();

    await expect(
      service.getDurableVoiceTaskContinuationState({
        callSessionId: 'call-owner-dead-letter',
        userId: 'user-restart',
        nowMs: deadlineAtMs + 1,
      }),
    ).resolves.toMatchObject({ status: 'quiescent', hasActive: false });

    const persisted = await ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean();
    expect(persisted.payload).toMatchObject({
      state: 'failed',
      awaitingOwnerResult: false,
      ownerContinuationFailureCode: 'owner_callback_unavailable',
    });
    expect(persisted.payload.pendingOwnerResultKeys).toEqual([]);
    expect(persisted.payload.pendingOwnerResultDeadlines).toEqual([]);
  });

  test('reconciles a child callback that races ahead of its dispatch acknowledgement', async () => {
    const task = service.createVoiceTask({
      callSessionId: 'call-early-child',
      userId: 'user-restart',
      conversationId: 'conversation-early-child',
      streamId: 'stream-early-child',
    });
    service.linkVoiceTaskOwnerChild(task.taskId, {
      continuationPrefix: 'glasshive_dispatch:',
      resolvedOwnerId: 'glasshive_run:run-early',
    });
    service.markVoiceTaskAwaitingOwnerResult(task.taskId, 'glasshive_dispatch:tool-late');
    service.completeVoiceTask(task.taskId, { resultMessageId: 'message-early-child' });
    await service.flushVoiceTaskPersistence();

    expect(service.snapshotEvent(task.taskId)).toMatchObject({
      state: 'completed',
      resultMessageId: 'message-early-child',
    });
    const persisted = await ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean();
    expect(persisted.payload.earlyOwnerLinkCredits).toBe(0);
    expect(persisted.payload.pendingOwnerResultKeys).toEqual([]);
  });

  test('bounds continuation identity state and fails active when producer registration overflows', async () => {
    const task = service.createVoiceTask({
      callSessionId: 'call-owner-overflow',
      userId: 'user-restart',
      conversationId: 'conversation-owner-overflow',
      streamId: 'stream-owner-overflow',
    });
    for (let index = 0; index < 65; index += 1) {
      service.markVoiceTaskAwaitingOwnerResult(task.taskId, `owner:${index}`);
    }
    service.completeVoiceTask(task.taskId, { resultMessageId: 'overflow-parent' });
    for (let index = 0; index < 64; index += 1) {
      service.linkVoiceTaskOwnerChild(task.taskId, {
        continuationKey: `owner:${index}`,
        resolvedOwnerId: `resolved:${index}`,
      });
    }
    await service.flushVoiceTaskPersistence();

    const persisted = await ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean();
    expect(persisted.payload.pendingOwnerResultKeys).toHaveLength(0);
    expect(persisted.payload.resolvedOwnerResultIds).toHaveLength(64);
    expect(persisted.payload.continuationOverflow).toBe(true);
    expect(service.snapshotEvent(task.taskId)).toMatchObject({ state: 'running' });

    service.resetVoiceTasksForTests();
    await service.hydrateVoiceTask(task.taskId, {
      callSessionId: 'call-owner-overflow',
      userId: 'user-restart',
    });
    expect(service.snapshotEvent(task.taskId)).toMatchObject({ state: 'running' });
  });

  test('reconciles a cancellation accepted by another API process before an output sink', async () => {
    const task = service.createVoiceTask({
      callSessionId: 'call-multi-process',
      userId: 'user-restart',
      streamId: 'stream-multi-process',
    });
    await service.flushVoiceTaskPersistence();
    service.resetVoiceTasksForTests();
    service.setVoiceTaskSuppressionPersistenceForTests(null);
    await service.hydrateVoiceTaskByStreamId('stream-multi-process', {
      callSessionId: 'call-multi-process',
      userId: 'user-restart',
      requireDurable: true,
    });
    expect(service.isVoiceTaskSuppressed(task.taskId)).toBe(false);

    await ViventiumVoiceTaskSuppression.create({
      taskId: task.taskId,
      streamId: 'stream-multi-process',
      callSessionId: 'call-multi-process',
      userId: 'user-restart',
      eventId: 'cancel-from-other-process',
      sequence: 3,
      emittedAt: new Date(),
      state: 'cancelling',
      acceptedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      service.isVoiceTaskSuppressedDurably(task.taskId, {
        callSessionId: 'call-multi-process',
        userId: 'user-restart',
        streamId: 'stream-multi-process',
      }),
    ).resolves.toBe(true);
    expect(service.completeVoiceTask(task.taskId, { resultMessageId: 'late' })).toBeNull();
  });

  test('fails authoritative durable replay closed on a corrupt task row', async () => {
    await ViventiumVoiceTask.create({
      taskId: 'task-corrupt',
      callSessionId: 'call-corrupt',
      userId: 'user-restart',
      streamId: 'stream-corrupt',
      payload: { version: 1, taskId: 'task-corrupt' },
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      service.listDurableVoiceTaskSnapshots({
        callSessionId: 'call-corrupt',
        userId: 'user-restart',
        requireDurable: true,
      }),
    ).rejects.toMatchObject({ status: 503, code: 'gateway_down', retryable: true });
  });

  test('does not publish cancelling when durable barrier persistence fails', async () => {
    const task = service.createVoiceTask({
      callSessionId: 'call-barrier-failure',
      userId: 'user-restart',
      streamId: 'stream-barrier-failure',
    });
    await service.flushVoiceTaskPersistence();
    const events = [];
    const unsubscribe = service.subscribeVoiceTask(task.taskId, (event) => events.push(event));
    const failure = jest
      .spyOn(ViventiumVoiceTaskSuppression, 'findOneAndUpdate')
      .mockReturnValueOnce({
        lean: () => Promise.reject(new Error('synthetic persistence outage')),
      });

    await expect(
      service.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'user-restart' }),
    ).rejects.toMatchObject({ status: 503, code: 'gateway_down' });
    unsubscribe();
    failure.mockRestore();

    expect(events.some((event) => event.state === 'cancelling')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      state: 'recovering',
      error: { code: 'cancel_barrier_unavailable', retryable: true },
    });
    expect(service.isVoiceTaskSuppressed(task.taskId)).toBe(true);
  });

  test('retries a failed barrier with a fresh monotonic event and replays that exact commit', async () => {
    const task = service.createVoiceTask({
      callSessionId: 'call-barrier-retry',
      userId: 'user-restart',
      streamId: 'glasshive:barrier-retry',
      owner: { kind: 'glasshive_run', id: 'barrier-retry' },
    });
    service.registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'glasshive_run',
      cancel: () => new Promise(() => {}),
      cancellationConfirmable: true,
    });
    await service.flushVoiceTaskPersistence();
    const firstWrite = jest
      .spyOn(ViventiumVoiceTaskSuppression, 'findOneAndUpdate')
      .mockReturnValueOnce({
        lean: () => Promise.reject(new Error('synthetic first-write failure')),
      });
    await expect(
      service.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'user-restart' }),
    ).rejects.toMatchObject({ status: 503 });
    firstWrite.mockRestore();
    const recovering = service.snapshotEvent(task.taskId);
    expect(recovering).toMatchObject({ state: 'recovering' });

    const acknowledgement = await service.requestVoiceTaskOwnerCancellation(task.taskId, {
      userId: 'user-restart',
    });
    expect(acknowledgement.event).toMatchObject({
      state: 'cancelling',
      sequence: recovering.sequence + 1,
      eventId: expect.any(String),
    });
    await service.flushVoiceTaskPersistence();
    service.resetVoiceTasksForTests();
    await ViventiumVoiceTask.deleteMany({ taskId: task.taskId });

    const page = await service.listDurableVoiceTaskSnapshots({
      callSessionId: 'call-barrier-retry',
      userId: 'user-restart',
      requireDurable: true,
    });
    expect(page.events).toEqual([
      expect.objectContaining({
        eventId: acknowledgement.event.eventId,
        sequence: acknowledgement.event.sequence,
        state: 'cancelling',
      }),
    ]);
  });

  test.each([
    ['cancelled_confirmed', true],
    ['cancelled_unenforceable', false],
  ])(
    'keeps the durable and in-memory barrier cancelling when %s settlement persistence fails',
    async (_terminalState, confirmed) => {
      const task = service.createVoiceTask({
        callSessionId: `call-terminal-write-${confirmed}`,
        userId: 'user-restart',
        streamId: `glasshive:terminal-write-${confirmed}`,
        owner: { kind: 'glasshive_run', id: `terminal-write-${confirmed}` },
      });
      service.registerVoiceTaskOwnerAdapter(task.taskId, {
        kind: 'glasshive_run',
        cancel: () => new Promise(() => {}),
        cancellationConfirmable: true,
      });
      const acknowledgement = await service.requestVoiceTaskOwnerCancellation(task.taskId, {
        userId: 'user-restart',
      });
      expect(acknowledgement.event).toMatchObject({ state: 'cancelling' });
      const before = service.snapshotEvent(task.taskId);
      const durableBefore = await ViventiumVoiceTaskSuppression.findOne({
        taskId: task.taskId,
      }).lean();
      const terminalWrite = jest
        .spyOn(ViventiumVoiceTaskSuppression, 'findOneAndUpdate')
        .mockReturnValueOnce({
          lean: () => Promise.reject(new Error('synthetic terminal-write failure')),
        });

      await expect(
        service.settleVoiceTaskCancellation(task.taskId, {
          confirmed,
          detail: 'Owner settlement',
        }),
      ).rejects.toThrow('synthetic terminal-write failure');
      terminalWrite.mockRestore();

      expect(service.snapshotEvent(task.taskId)).toMatchObject({
        sequence: before.sequence,
        state: 'cancelling',
      });
      expect(service.isVoiceTaskSuppressed(task.taskId)).toBe(true);
      const durableAfter = await ViventiumVoiceTaskSuppression.findOne({
        taskId: task.taskId,
      }).lean();
      expect(durableAfter).toMatchObject({
        eventId: durableBefore.eventId,
        sequence: durableBefore.sequence,
        state: 'cancelling',
      });
    },
  );

  test('fails closed when suppression storage is disconnected instead of accepting a local-only barrier', async () => {
    const task = service.createVoiceTask({
      callSessionId: 'call-disconnected-barrier',
      userId: 'user-restart',
      streamId: 'stream-disconnected-barrier',
    });
    await service.flushVoiceTaskPersistence();
    await mongoose.disconnect();
    try {
      await expect(
        service.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'user-restart' }),
      ).rejects.toMatchObject({ status: 503, code: 'gateway_down' });
      expect(service.snapshotEvent(task.taskId)).toMatchObject({ state: 'recovering' });
    } finally {
      await mongoose.connect(mongoServer.getUri());
    }
  });

  test('settles token-free pending owner delivery truthfully after an immediate restart', async () => {
    const task = service.createVoiceTask({
      callSessionId: 'call-owner-delivery-restart',
      userId: 'user-restart',
      streamId: 'glasshive:run-pending',
      owner: { kind: 'glasshive_run', id: 'run-pending' },
    });
    service.registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'glasshive_run',
      cancel: () => new Promise(() => {}),
      cancellationConfirmable: true,
    });
    await service.flushVoiceTaskPersistence();
    const acknowledgement = await service.requestVoiceTaskOwnerCancellation(task.taskId, {
      userId: 'user-restart',
    });
    expect(acknowledgement).toMatchObject({ ownerPending: true, operationId: expect.any(String) });

    service.resetVoiceTasksForTests();
    await service.hydrateVoiceTask(task.taskId, {
      callSessionId: 'call-owner-delivery-restart',
      userId: 'user-restart',
    });
    expect(service.snapshotEvent(task.taskId)).toMatchObject({
      state: 'cancelled_unenforceable',
    });
    expect(service.isVoiceTaskSuppressed(task.taskId)).toBe(true);
  });

  test('keeps a cancelled task barrier exact under more than MAX_TASKS pressure and restart', async () => {
    const cancelled = service.createVoiceTask({
      callSessionId: 'call-pressure',
      userId: 'user-pressure',
      streamId: 'stream-cancelled-oldest',
    });
    await service.requestVoiceTaskOwnerCancellation(cancelled.taskId, { userId: 'user-pressure' });
    for (let index = 0; index < 1_001; index += 1) {
      service.createVoiceTask({
        callSessionId: 'call-pressure',
        userId: 'user-pressure',
        streamId: `stream-pressure-${index}`,
      });
    }
    await service.flushVoiceTaskPersistence();

    expect(service.getVoiceTaskRegistryStats().tasks).toBe(1_000);
    expect(service.isVoiceTaskSuppressed(cancelled.taskId)).toBe(true);
    service.resetVoiceTasksForTests();
    const replayedIds = [];
    let cursor = {};
    let hasMore = true;
    while (hasMore) {
      const page = await service.listDurableVoiceTaskSnapshots({
        callSessionId: 'call-pressure',
        userId: 'user-pressure',
        ...cursor,
      });
      replayedIds.push(...page.events.map((event) => event.taskId));
      cursor = page.hasMore
        ? {
            beforeCreatedAt: page.nextBeforeCreatedAt,
            beforeTaskId: page.nextBeforeTaskId,
          }
        : {};
      hasMore = page.hasMore;
    }
    expect(new Set(replayedIds).size).toBe(1_002);
    expect(replayedIds).toContain(cancelled.taskId);
    await service.hydrateVoiceTaskByStreamId('stream-cancelled-oldest', {
      callSessionId: 'call-pressure',
      userId: 'user-pressure',
    });
    expect(service.getVoiceTask(cancelled.taskId)).toMatchObject({
      state: 'cancelled_unenforceable',
    });
    expect(service.isVoiceTaskSuppressed(cancelled.taskId)).toBe(true);
    expect(service.completeVoiceTask(cancelled.taskId, { resultMessageId: 'late' })).toBeNull();
  }, 60_000);

  test('coalesces high-volume latest-state persistence into bounded bulk writes', async () => {
    const bulkWrite = jest.spyOn(ViventiumVoiceTask, 'bulkWrite');
    for (let index = 0; index < 250; index += 1) {
      const task = service.createVoiceTask({
        callSessionId: 'call-batch-persistence',
        userId: 'user-batch-persistence',
        streamId: `stream-batch-persistence-${index}`,
      });
      service.observeGenerationEvent(task.taskId, {
        event: 'on_agent_update',
        data: { eventId: `phase-${index}`, name: 'Working' },
      });
    }

    await service.flushVoiceTaskPersistence();

    expect(bulkWrite).toHaveBeenCalled();
    expect(bulkWrite.mock.calls.length).toBeLessThanOrEqual(4);
    expect(
      await ViventiumVoiceTask.countDocuments({ callSessionId: 'call-batch-persistence' }),
    ).toBe(250);
    expect(
      await ViventiumVoiceTask.countDocuments({
        callSessionId: 'call-batch-persistence',
        'payload.sequence': 3,
      }),
    ).toBe(250);
    bulkWrite.mockRestore();
  });

  test('keeps a post-restart persistence drain observable after an abandoned writer settles', async () => {
    const deferred = () => {
      let resolve;
      const promise = new Promise((settle) => {
        resolve = settle;
      });
      return { promise, resolve };
    };
    const abandonedWrite = deferred();
    const currentWrite = deferred();
    const abandonedStarted = deferred();
    const abandonedSettled = deferred();
    const currentStarted = deferred();
    const realBulkWrite = ViventiumVoiceTask.bulkWrite.bind(ViventiumVoiceTask);
    const bulkWrite = jest
      .spyOn(ViventiumVoiceTask, 'bulkWrite')
      .mockImplementationOnce((...args) => {
        abandonedStarted.resolve();
        return abandonedWrite.promise
          .then(() => realBulkWrite(...args))
          .finally(abandonedSettled.resolve);
      })
      .mockImplementationOnce((...args) => {
        currentStarted.resolve();
        return currentWrite.promise.then(() => realBulkWrite(...args));
      });

    try {
      service.createVoiceTask({
        callSessionId: 'call-abandoned-drain',
        userId: 'user-abandoned-drain',
        streamId: 'stream-abandoned-drain',
      });
      await abandonedStarted.promise;

      service.resetVoiceTasksForTests();
      service.setVoiceTaskSuppressionPersistenceForTests(null);
      service.createVoiceTask({
        callSessionId: 'call-current-drain',
        userId: 'user-current-drain',
        streamId: 'stream-current-drain',
      });
      await currentStarted.promise;

      abandonedWrite.resolve();
      await abandonedSettled.promise;
      await new Promise((resolve) => setImmediate(resolve));

      let flushSettled = false;
      const flush = service.flushVoiceTaskPersistence().then(() => {
        flushSettled = true;
      });
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      expect(flushSettled).toBe(false);

      currentWrite.resolve();
      await flush;
      expect(await ViventiumVoiceTask.countDocuments({ callSessionId: 'call-current-drain' })).toBe(
        1,
      );
    } finally {
      abandonedWrite.resolve();
      currentWrite.resolve();
      await service.flushVoiceTaskPersistence();
      bulkWrite.mockRestore();
    }
  });

  test('does not let a delayed API writer replace a newer durable task sequence', async () => {
    const task = service.createVoiceTask({
      callSessionId: 'call-sequence-cas',
      userId: 'user-sequence-cas',
      streamId: 'stream-sequence-cas',
    });
    await service.flushVoiceTaskPersistence();
    const row = await ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean();
    row.payload.sequence = 5;
    row.payload.state = 'completed';
    await ViventiumVoiceTask.updateOne(
      { taskId: task.taskId },
      { $set: { sequence: 5, payload: row.payload } },
    );

    service.observeGenerationEvent(task.taskId, {
      event: 'on_agent_update',
      data: { eventId: 'stale-local-sequence', name: 'Stale local update' },
    });
    await service.flushVoiceTaskPersistence();

    expect(await ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean()).toMatchObject({
      sequence: 5,
      payload: { sequence: 5, state: 'completed' },
    });
  });

  test('tails a task written through an independent API database connection without reconnecting', async () => {
    const remoteConnection = await mongoose.createConnection(mongoServer.getUri()).asPromise();
    const RemoteVoiceTask = require('~/db/viventiumVoiceTask')(remoteConnection);
    const remoteTask = service.createVoiceTask({
      callSessionId: 'call-cross-process-tail',
      userId: 'user-cross-process-tail',
      streamId: 'stream-cross-process-tail',
    });
    await service.flushVoiceTaskPersistence();
    const received = [];
    const durableTail = service.subscribeDurableVoiceTaskEventsForCall({
      callSessionId: 'call-cross-process-tail',
      userId: 'user-cross-process-tail',
      pollIntervalMs: 10,
      onEvent: (event) => received.push(event),
    });
    await durableTail.ready;
    received.length = 0;
    const remoteRow = await RemoteVoiceTask.findOne({ taskId: remoteTask.taskId }).lean();
    remoteRow.payload.sequence = 3;
    remoteRow.payload.updatedAt = new Date().toISOString();
    remoteRow.payload.sources = [
      { id: 'remote-source', title: 'Remote source', url: 'https://example.test/remote-source' },
    ];
    await RemoteVoiceTask.updateOne(
      { taskId: remoteTask.taskId },
      {
        $set: { sequence: 3, payload: remoteRow.payload },
        $currentDate: { updatedAt: true },
      },
      { timestamps: false },
    );
    const remoteCommitAt = Date.now();

    const deadline = Date.now() + 2_000;
    while (
      !received.some(
        (event) =>
          event.taskId === remoteTask.taskId &&
          event.sources?.some((source) => source.url === 'https://example.test/remote-source'),
      ) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    durableTail.stop();
    await remoteConnection.close();

    expect(received).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callSessionId: 'call-cross-process-tail',
          taskId: remoteTask.taskId,
          type: 'snapshot',
          sources: [expect.objectContaining({ url: 'https://example.test/remote-source' })],
        }),
      ]),
    );
    expect(Date.now() - remoteCommitAt).toBeLessThan(250);
  });

  test('tails a remote suppression tombstone through the same stable call cursor', async () => {
    const remoteConnection = await mongoose.createConnection(mongoServer.getUri()).asPromise();
    const RemoteSuppression = require('~/db/viventiumVoiceTaskSuppression')(remoteConnection);
    const received = [];
    const durableTail = service.subscribeDurableVoiceTaskEventsForCall({
      callSessionId: 'call-cross-process-suppression',
      userId: 'user-cross-process-suppression',
      pollIntervalMs: 10,
      onEvent: (event) => received.push(event),
    });
    await durableTail.ready;
    await RemoteSuppression.create({
      taskId: 'task-remote-suppression',
      streamId: 'stream-remote-suppression',
      callSessionId: 'call-cross-process-suppression',
      userId: 'user-cross-process-suppression',
      eventId: 'event-remote-suppression',
      sequence: 7,
      emittedAt: new Date(),
      state: 'cancelled_confirmed',
      ownerKind: 'glasshive_run',
      ownerId: 'run-remote-suppression',
      acceptedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const remoteCommitAt = Date.now();

    const deadline = Date.now() + 2_000;
    while (
      !received.some(
        (event) =>
          event.taskId === 'task-remote-suppression' && event.state === 'cancelled_confirmed',
      ) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    durableTail.stop();
    await remoteConnection.close();

    expect(received).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: 'event-remote-suppression',
          taskId: 'task-remote-suppression',
          sequence: 7,
          state: 'cancelled_confirmed',
          type: 'snapshot',
        }),
      ]),
    );
    expect(Date.now() - remoteCommitAt).toBeLessThan(250);
  });

  test('shares one non-overlapping durable tail per call and bounds the 120-minute read model', async () => {
    const realAggregate = ViventiumVoiceTask.aggregate.bind(ViventiumVoiceTask);
    let activeReads = 0;
    let maxActiveReads = 0;
    const aggregate = jest.spyOn(ViventiumVoiceTask, 'aggregate').mockImplementation((pipeline) => {
      const operation = realAggregate(pipeline);
      return {
        option: async (options) => {
          activeReads += 1;
          maxActiveReads = Math.max(maxActiveReads, activeReads);
          await new Promise((resolve) => setTimeout(resolve, 30));
          try {
            return await operation.option(options);
          } finally {
            activeReads -= 1;
          }
        },
      };
    });
    const first = service.subscribeDurableVoiceTaskEventsForCall({
      callSessionId: 'call-shared-tail',
      userId: 'user-shared-tail',
      pollIntervalMs: 25,
      onEvent: jest.fn(),
    });
    const second = service.subscribeDurableVoiceTaskEventsForCall({
      callSessionId: 'call-shared-tail',
      userId: 'user-shared-tail',
      pollIntervalMs: 25,
      onEvent: jest.fn(),
    });
    await Promise.all([first.ready, second.ready]);
    await Promise.all([first.catchUp(), second.catchUp()]);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(service.getVoiceTaskRegistryStats().durableCallTails).toBe(1);
    expect(maxActiveReads).toBe(1);
    expect(service.estimateDurableVoiceTailReads(120 * 60 * 1_000, 150)).toBe(48_000);
    first.stop();
    expect(service.getVoiceTaskRegistryStats().durableCallTails).toBe(1);
    second.stop();
    expect(service.getVoiceTaskRegistryStats().durableCallTails).toBe(0);
    aggregate.mockRestore();
  });
});
