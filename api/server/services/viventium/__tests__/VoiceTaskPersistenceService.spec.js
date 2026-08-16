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
    await new Promise((resolve) => setImmediate(resolve));
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
