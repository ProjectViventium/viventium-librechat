/* === VIVENTIUM START === Durable VoiceTask/restart/cancellation regression tests. === VIVENTIUM END === */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mockNativeAccount = jest.fn();
const mockNativeWorkAction = jest.fn();
jest.mock('../GlassHiveAccountService', () => ({
  requestAccountApi: (...args) => mockNativeAccount(...args),
}));
jest.mock('../GlassHiveWorkActionService', () => ({
  executeGlassHiveWorkAction: (...args) => mockNativeWorkAction(...args),
}));
const service = require('../VoiceTaskService');

describe('VoiceTask durable replay and suppression', () => {
  let mongoServer;
  let ViventiumVoiceTask;
  let ViventiumVoiceTaskSuppression;
  let ViventiumCallSession;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    ({
      ViventiumVoiceTask,
      ViventiumVoiceTaskSuppression,
      ViventiumCallSession,
    } = require('~/db/models'));
    await ViventiumVoiceTask.init();
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
    await ViventiumCallSession.deleteMany({});
  });

  test('preserves continuing-work presentation through the durable suppression barrier and restart', async () => {
    const scope = { callSessionId: 'call-continued-work', userId: 'user-continued-work' };
    const task = service.createVoiceTask({
      ...scope,
      streamId: 'glasshive:run-continued-work',
      owner: { kind: 'glasshive_run', id: 'run-continued-work' },
    });
    await service.confirmVoiceTaskOwnerCancellation(
      task.taskId,
      'This earlier run stopped. The same work is still active.',
      { label: 'Work continues' },
    );
    await service.flushVoiceTaskPersistence();
    const expected = {
      taskId: task.taskId,
      state: 'cancelled_confirmed',
      label: 'Work continues',
      detail: 'This earlier run stopped. The same work is still active.',
      cancellable: false,
    };
    const livePage = await service.listDurableVoiceTaskSnapshots({
      ...scope,
      requireDurable: true,
    });
    expect(livePage.events).toEqual([expect.objectContaining(expected)]);
    service.resetVoiceTasksForTests();
    await ViventiumVoiceTask.deleteMany({ taskId: task.taskId });
    const page = await service.listDurableVoiceTaskSnapshots({ ...scope, requireDurable: true });
    expect(page.events).toEqual([expect.objectContaining(expected)]);
    await service.hydrateVoiceTaskByStreamId('glasshive:run-continued-work', scope);
    expect(service.snapshotEvent(task.taskId)).toMatchObject(expected);
    expect(service.isVoiceTaskSuppressed(task.taskId)).toBe(true);
  });

  function nativePermission() {
    return {
      version: 1,
      kind: 'permission',
      state: 'pending',
      mode: 'form',
      runtimeName: 'Native runtime',
      requestId: 'permission-1',
      requestFingerprint: 'a'.repeat(64),
      runId: 'run-native',
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      expiresAt: '2099-01-01T00:00:00Z',
      message: 'Permit this operation?',
      requestedSchema: {
        type: 'object',
        required: ['optionId'],
        properties: {
          optionId: {
            type: 'string',
            enum: ['allow_once', 'reject_once'],
            enumNames: ['Allow once', 'Reject once'],
          },
        },
      },
    };
  }

  async function prepareNativeInput(expiresAt) {
    const scope = { userId: 'native-owner', callSessionId: 'native-call' };
    const task = service.createVoiceTask({
      ...scope,
      streamId: 'glasshive:run-native',
      owner: { kind: 'glasshive_run', id: 'run-native' },
    });
    const pending = { ...nativePermission(), ...(expiresAt ? { expiresAt } : {}) };
    mockNativeAccount.mockResolvedValue({ workRef: 'work-native', pendingNativeInput: pending });
    await require('../GlassHiveVoiceTaskActionService').registerGlassHiveVoiceTaskActionCapabilities(
      {
        task,
        ownerId: scope.userId,
        workRef: 'work-native',
        body: { event: 'run.needs_input', run_id: 'run-native', pending_native_input: pending },
      },
    );
    await service.flushVoiceTaskPersistence();
    return {
      task,
      scope,
      pending,
      authority: {
        callSessionId: scope.callSessionId,
        binding: { callSessionId: scope.callSessionId, userId: scope.userId },
      },
    };
  }

  test('restored failed foreground attention hides Cancel until its exact native owner adapter is installed', async () => {
    const scope = { userId: 'attention-owner', callSessionId: 'attention-call' };
    const task = service.createVoiceTask({
      ...scope,
      streamId: 'attention-stream',
      owner: { kind: 'remote_generation', id: 'attention-stream' },
    });
    const cancel = jest.fn(async () => ({ accepted: false }));
    service.registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'remote_generation',
      cancel,
      cancelFailedProviderAttention: true,
    });
    service.failVoiceTask(task.taskId, { code: 'provider_progress_stalled' });
    expect(service.snapshotEvent(task.taskId).cancellable).toBe(true);
    await service.flushVoiceTaskPersistence();
    const row = await ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean();
    expect(JSON.stringify(row.payload)).not.toContain('cancelFailedProviderAttention');
    service.resetVoiceTasksForTests();
    await service.hydrateVoiceTask(task.taskId, scope);
    expect(service.snapshotEvent(task.taskId)).toMatchObject({
      state: 'failed',
      cancellable: false,
      retryable: false,
      error: { code: 'provider_progress_stalled' },
    });
    expect(await service.requestVoiceTaskOwnerCancellation(task.taskId, scope)).toMatchObject({
      alreadyInactive: true,
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  test.each(['cached', 'stored'])(
    'same-owner %s suppression hydration retains task creation and the pending cancellation operation',
    async (mode) => {
      const scope = { userId: 'stop-hydrate-owner', callSessionId: 'stop-hydrate-call' };
      const task = service.createVoiceTask({
        ...scope,
        streamId: 'stop-hydrate-stream',
        owner: { kind: 'remote_generation', id: 'stop-hydrate-stream' },
      });
      const createdAt = task.createdAt;
      let release;
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      const cancel = jest.fn(async () => {
        await blocked;
        return {
          accepted: Boolean(
            await service.confirmVoiceTaskOwnerCancellation(task.taskId, 'Exact owner stopped.'),
          ),
        };
      });
      service.registerVoiceTaskOwnerAdapter(task.taskId, { kind: 'remote_generation', cancel });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await service.requestVoiceTaskOwnerCancellation(task.taskId, scope);
      const before = service.snapshotEvent(task.taskId);
      if (mode === 'stored') {
        const row = await ViventiumVoiceTaskSuppression.findOne({ taskId: task.taskId }).lean();
        await service.clearVoiceTaskSuppression(task.taskId);
        await ViventiumVoiceTaskSuppression.create(row);
      }
      try {
        await service.hydrateVoiceTaskSuppression(task.taskId, scope);
        expect(service.getVoiceTask(task.taskId)).toMatchObject({ state: 'cancelling', createdAt });
        expect(service.snapshotEvent(task.taskId).sequence).toBe(before.sequence);
        expect(await service.requestVoiceTaskOwnerCancellation(task.taskId, scope)).toMatchObject({
          alreadyCancelling: true,
          ownerPending: true,
        });
        release();
        await service.flushVoiceTaskOwnerOperations();
        expect(service.getVoiceTask(task.taskId)).toMatchObject({
          state: 'cancelled_confirmed',
          createdAt,
        });
        expect(cancel).toHaveBeenCalledTimes(1);
        const row = await ViventiumVoiceTaskSuppression.findOne({ taskId: task.taskId }).lean();
        expect(row.state).toBe('cancelled_confirmed');
      } finally {
        release();
        await service.flushVoiceTaskOwnerOperations();
      }
    },
  );

  test('native question speech offer is durable once across concurrent claim, coalesced persistence and restart', async () => {
    const scope = { userId: 'offer-owner', callSessionId: 'offer-call' };
    const task = service.createVoiceTask({
      ...scope,
      streamId: 'offer-stream',
      owner: { kind: 'generation_job', id: 'offer-stream' },
    });
    service.registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'generation_job',
      provideInput: jest.fn(),
      isNativeInputCurrent: jest.fn(async () => true),
    });
    const request = {
      version: 1,
      kind: 'question',
      requestId: 'q-1',
      requestFingerprint: 'a'.repeat(64),
      runId: 'native-run',
      attemptId: 'attempt-1',
      expiresAt: '2099-01-01T00:00:00Z',
    };
    service.observeGenerationEvent(task.taskId, {
      event: 'needs_input',
      data: { prompt: 'Choose size', inputType: 'text', nativeInputRequest: request },
    });
    const input = {
      ...scope,
      streamId: 'offer-stream',
      prompt: 'Choose size',
      nativeInputRequest: request,
    };
    const outcomes = await Promise.all([
      service.claimVoiceNativeInputSpeechOffer(task.taskId, input),
      service.claimVoiceNativeInputSpeechOffer(task.taskId, input),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const offer = outcomes.find(Boolean);
    expect(offer.outcome).toBe('offered_unknown');
    service.observeGenerationEvent(task.taskId, {
      event: 'needs_input',
      data: {
        eventId: 'same-request-snapshot',
        prompt: 'Choose size',
        inputType: 'text',
        nativeInputRequest: request,
      },
    });
    await service.flushVoiceTaskPersistence();
    expect(
      (await ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean()).nativeInputSpeechOffer
        .requestKey,
    ).toBe(offer.requestKey);
    service.resetVoiceTasksForTests();
    await service.hydrateVoiceTask(task.taskId, scope);
    service.registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'generation_job',
      provideInput: jest.fn(),
      isNativeInputCurrent: jest.fn(async () => true),
    });
    expect(await service.claimVoiceNativeInputSpeechOffer(task.taskId, input)).toBeNull();
    const next = { ...request, requestId: 'q-2', requestFingerprint: 'b'.repeat(64) };
    service.registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'generation_job',
      provideInput: jest.fn(),
      isNativeInputCurrent: jest.fn(async () => true),
    });
    service.observeGenerationEvent(task.taskId, {
      event: 'needs_input',
      data: { prompt: 'Choose size', inputType: 'text', nativeInputRequest: next },
    });
    expect(
      await service.claimVoiceNativeInputSpeechOffer(task.taskId, {
        ...input,
        nativeInputRequest: request,
      }),
    ).toBeNull();
    expect(
      await service.claimVoiceNativeInputSpeechOffer(task.taskId, {
        ...input,
        userId: 'foreign',
        nativeInputRequest: next,
      }),
    ).toBeNull();
    expect(
      await service.claimVoiceNativeInputSpeechOffer(task.taskId, {
        ...input,
        nativeInputRequest: next,
      }),
    ).toBeTruthy();
  });

  test('a remotely answered native question retained in task state cannot acquire speech authority', async () => {
    const scope = { userId: 'offer-owner', callSessionId: 'offer-call' };
    const task = service.createVoiceTask({
      ...scope,
      streamId: 'offer-stream',
      owner: { kind: 'generation_job', id: 'offer-stream' },
    });
    const current = jest.fn(async () => false);
    service.registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'generation_job',
      provideInput: jest.fn(),
      isNativeInputCurrent: current,
    });
    const request = {
      version: 1,
      kind: 'question',
      requestId: 'q-answered',
      requestFingerprint: 'c'.repeat(64),
      runId: 'native-run',
      attemptId: 'attempt-1',
      expiresAt: '2099-01-01T00:00:00Z',
    };
    service.observeGenerationEvent(task.taskId, {
      event: 'needs_input',
      data: { prompt: 'Choose size', inputType: 'text', nativeInputRequest: request },
    });
    expect(
      await service.claimVoiceNativeInputSpeechOffer(task.taskId, {
        ...scope,
        streamId: 'offer-stream',
        prompt: 'Choose size',
        nativeInputRequest: request,
      }),
    ).toBeNull();
    expect(current).toHaveBeenCalledWith(request);
    expect(
      (await ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean()).nativeInputSpeechOffer
        .outcome,
    ).toBe('offered_unknown');
  });

  test('remote answer while durable speech CAS waits is rejected before the offer returns', async () => {
    const scope = { userId: 'offer-owner', callSessionId: 'offer-call' };
    const task = service.createVoiceTask({
      ...scope,
      streamId: 'offer-stream',
      owner: { kind: 'generation_job', id: 'offer-stream' },
    });
    let pending = true;
    service.registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'generation_job',
      provideInput: jest.fn(),
      isNativeInputCurrent: async () => pending,
    });
    const request = {
      version: 1,
      kind: 'question',
      requestId: 'q-raced',
      requestFingerprint: 'd'.repeat(64),
      runId: 'native-run',
      attemptId: 'attempt-1',
      expiresAt: '2099-01-01T00:00:00Z',
    };
    service.observeGenerationEvent(task.taskId, {
      event: 'needs_input',
      data: { prompt: 'Choose size', inputType: 'text', nativeInputRequest: request },
    });
    const actual = ViventiumVoiceTask.findOneAndUpdate.bind(ViventiumVoiceTask);
    const claim = jest
      .spyOn(ViventiumVoiceTask, 'findOneAndUpdate')
      .mockImplementation((...args) => {
        const query = actual(...args);
        const lean = query.lean.bind(query);
        query.lean = async () => {
          const row = await lean();
          pending = false;
          return row;
        };
        return query;
      });
    try {
      expect(
        await service.claimVoiceNativeInputSpeechOffer(task.taskId, {
          ...scope,
          streamId: 'offer-stream',
          prompt: 'Choose size',
          nativeInputRequest: request,
        }),
      ).toBeNull();
      expect(
        (await ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean()).nativeInputSpeechOffer
          .outcome,
      ).toBe('offered_unknown');
    } finally {
      claim.mockRestore();
    }
  });

  test('commits exact native retry identity before the effect and restores the same owner operation after restart', async () => {
    const { task, scope, authority } = await prepareNativeInput();
    let originalOperation;
    mockNativeWorkAction.mockImplementationOnce(async (input) => {
      originalOperation = input;
      const row = await ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean();
      expect(row.payload.inputOperation).toEqual({
        hash: require('crypto').createHash('sha256').update('allow_once').digest('hex'),
        operationId: input.operationId,
      });
      expect(row.payload.nativeMissionInputBinding).toMatchObject({
        taskId: task.taskId,
        workRef: 'work-native',
        requestFingerprint: 'a'.repeat(64),
        userId: scope.userId,
        callSessionId: scope.callSessionId,
      });
      expect(JSON.stringify(row.payload.inputOperation)).not.toContain('allow_once');
      return { status: 'pending', confirmationPending: true };
    });
    expect(
      await service.submitVoiceTaskInput(task.taskId, 'allow_once', {
        userId: scope.userId,
        voiceAuthorityContext: authority,
      }),
    ).toMatchObject({ ok: true, confirmationPending: true, task: { state: 'needs_input' } });
    await service.flushVoiceTaskPersistence();
    service.resetVoiceTasksForTests();
    mockNativeAccount.mockClear();
    expect(
      await service.hydrateVoiceTask(task.taskId, { ...scope, userId: 'foreign-owner' }),
    ).toBeNull();
    expect(mockNativeAccount).not.toHaveBeenCalled();
    await service.hydrateVoiceTask(task.taskId, scope);
    expect(mockNativeAccount).toHaveBeenCalledWith({
      ownerId: scope.userId,
      path: '/v1/work/work-native',
    });
    expect(
      await service.submitVoiceTaskInput(task.taskId, 'reject_once', {
        userId: scope.userId,
        voiceAuthorityContext: authority,
      }),
    ).toMatchObject({ ok: false, code: 'input_confirmation_pending' });
    mockNativeWorkAction.mockResolvedValueOnce({
      status: 'already_accepted',
      confirmationPending: false,
    });
    expect(
      await service.submitVoiceTaskInput(task.taskId, 'allow_once', {
        userId: scope.userId,
        voiceAuthorityContext: authority,
      }),
    ).toMatchObject({ ok: true, task: { state: 'running' } });
    expect(mockNativeWorkAction.mock.calls.at(-1)[0]).toEqual(originalOperation);
  });

  test('restart after expiry reconciles only the previously retained native operation when the live question has gone', async () => {
    const expiresAtMs = Date.now() + 10000;
    const { task, scope, authority, pending } = await prepareNativeInput(
      new Date(expiresAtMs).toISOString(),
    );
    mockNativeWorkAction.mockResolvedValueOnce({ status: 'pending', confirmationPending: true });
    expect(
      await service.submitVoiceTaskInput(task.taskId, 'allow_once', {
        userId: scope.userId,
        voiceAuthorityContext: authority,
      }),
    ).toMatchObject({ ok: true, confirmationPending: true, task: { state: 'needs_input' } });
    const submitted = mockNativeWorkAction.mock.calls.at(-1)[0];
    await service.flushVoiceTaskPersistence();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(expiresAtMs + 1);
    try {
      service.resetVoiceTasksForTests();
      mockNativeAccount.mockResolvedValue({ workRef: 'work-native', pendingNativeInput: null });
      await service.hydrateVoiceTask(task.taskId, scope);
      expect(
        await service.submitVoiceTaskInput(task.taskId, 'reject_once', {
          userId: scope.userId,
          voiceAuthorityContext: authority,
        }),
      ).toMatchObject({ ok: false, code: 'input_confirmation_pending' });
      mockNativeWorkAction.mockResolvedValueOnce({
        status: 'already_accepted',
        confirmationPending: false,
      });
      expect(
        await service.submitVoiceTaskInput(task.taskId, 'allow_once', {
          userId: scope.userId,
          voiceAuthorityContext: authority,
        }),
      ).toMatchObject({ ok: true, task: { state: 'running' } });
      expect(mockNativeWorkAction.mock.calls.at(-1)[0]).toEqual(submitted);
      expect(submitted.nativeInput.requestFingerprint).toBe(pending.requestFingerprint);
    } finally {
      clock.mockRestore();
    }
  });

  test('native durability failure stops the owner effect and the same operation can retry', async () => {
    const { task, scope, authority } = await prepareNativeInput();
    const bulkWrite = jest
      .spyOn(ViventiumVoiceTask, 'bulkWrite')
      .mockRejectedValue(new Error('synthetic storage outage'));
    mockNativeWorkAction.mockClear();
    expect(
      await service.submitVoiceTaskInput(task.taskId, 'allow_once', {
        userId: scope.userId,
        voiceAuthorityContext: authority,
      }),
    ).toMatchObject({ ok: false, code: 'owner_input_failed' });
    expect(mockNativeWorkAction).not.toHaveBeenCalled();
    bulkWrite.mockRestore();
    mockNativeWorkAction.mockResolvedValueOnce({ status: 'accepted', confirmationPending: false });
    expect(
      await service.submitVoiceTaskInput(task.taskId, 'allow_once', {
        userId: scope.userId,
        voiceAuthorityContext: authority,
      }),
    ).toMatchObject({ ok: true, task: { state: 'running' } });
  });

  test('persists the canonical ready binding without another generation event and hydrates it after restart', async () => {
    const scope = { callSessionId: 'call-ready-binding', userId: 'user-ready-binding' };
    const task = service.createVoiceTask({
      ...scope,
      conversationId: 'new',
      streamId: 'stream-ready-binding',
    });
    await service.flushVoiceTaskPersistence();
    service.bindVoiceTaskStream(task.taskId, 'stream-ready-binding', {
      ...scope,
      conversationId: 'conversation-ready-binding',
    });
    await service.flushVoiceTaskPersistence();
    expect(await ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean()).toMatchObject({
      payload: { conversationId: 'conversation-ready-binding', state: 'running', sequence: 3 },
    });
    service.resetVoiceTasksForTests();
    await service.hydrateVoiceTaskByStreamId('stream-ready-binding', scope);
    expect(service.getVoiceTaskByStreamId('stream-ready-binding')).toMatchObject({
      callSessionId: scope.callSessionId,
      conversationId: 'conversation-ready-binding',
      state: 'running',
    });
  });

  test.each(['generation_job', 'glasshive_run', 'glasshive_delivery'])(
    'hydrates saved %s ownership, events, sources, and result after an API restart',
    async (kind) => {
      const task = service.createVoiceTask({
        callSessionId: 'call-restart',
        userId: 'user-restart',
        conversationId: 'conversation-restart',
        streamId: 'stream-restart',
        owner: { kind, id: 'owner-restart' },
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
      expect(service.getVoiceTaskOwnerBinding(task.taskId)).toEqual({
        taskId: task.taskId,
        callSessionId: 'call-restart',
        userId: 'user-restart',
        conversationId: 'conversation-restart',
      });
      expect(service.getVoiceTaskTraceBinding(task.taskId)).toBeNull();
      expect(service.getVoiceTask(task.taskId)).not.toHaveProperty('userId');
    },
  );

  test('generation cleanup does not wait on a failed unrelated durable batch and the queued result recovers', async () => {
    const scope = {
      userId: 'user-generation',
      callSessionId: 'call-generation',
      streamId: 'stream-generation',
    };
    const task = service.createVoiceTask({
      ...scope,
      owner: { kind: 'generation_job', id: scope.streamId },
    });
    const unrelated = service.createVoiceTask({
      userId: 'other-user',
      callSessionId: 'other-call',
      streamId: 'other-stream',
    });
    await service.flushVoiceTaskPersistence();
    let storageAvailable = false;
    let failedWrite;
    const failureObserved = new Promise((resolve) => {
      failedWrite = resolve;
    });
    const realBulkWrite = ViventiumVoiceTask.bulkWrite.bind(ViventiumVoiceTask);
    const bulkWrite = jest.spyOn(ViventiumVoiceTask, 'bulkWrite').mockImplementation((...args) => {
      if (storageAvailable) return realBulkWrite(...args);
      failedWrite();
      return Promise.reject(
        Object.assign(new Error('synthetic durable write outage'), { code: 91 }),
      );
    });
    let settled;
    try {
      service.observeGenerationEvent(unrelated.taskId, {
        event: 'on_agent_update',
        data: { eventId: 'unrelated-progress', name: 'Working' },
      });
      await failureObserved;
      let generationFinalized = false;
      settled = service
        .settleVoiceTaskGeneration(task.taskId, scope, { resultMessageId: 'finished-answer' })
        .then(() => {
          generationFinalized = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(generationFinalized).toBe(true);
      expect(await ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean()).toMatchObject({
        payload: { state: 'running' },
      });
      storageAvailable = true;
      await service.flushVoiceTaskPersistence();
      await settled;
      expect(await ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean()).toMatchObject({
        payload: { state: 'completed', current: { resultMessageId: 'finished-answer' } },
      });
      expect(await ViventiumVoiceTask.findOne({ taskId: unrelated.taskId }).lean()).toMatchObject({
        payload: { state: 'running', current: { label: 'Working' } },
      });
      service.resetVoiceTasksForTests();
      await service.hydrateVoiceTask(task.taskId, scope);
      expect(service.snapshotEvent(task.taskId)).toMatchObject({
        state: 'completed',
        resultMessageId: 'finished-answer',
      });
    } finally {
      storageAvailable = true;
      await service.flushVoiceTaskPersistence();
      await settled;
      bulkWrite.mockRestore();
    }
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

  test.each([
    ['native_output_file_unavailable', 'native_output_file_unavailable'],
    ['private/path/arbitrary-failure', 'generation_failed'],
  ])(
    'retains a safe %s file-delivery warning through pending child links and restart',
    async (code, expectedCode) => {
      const scope = { callSessionId: 'call-delivery-restart', userId: 'user-restart' };
      const task = service.createVoiceTask({ ...scope, streamId: 'stream-delivery-restart' });
      service.markVoiceTaskAwaitingOwnerResult(task.taskId, 'phase_b:reply-delivery');
      service.completeVoiceTask(task.taskId, {
        resultMessageId: 'reply-delivery',
        deliveryError: { code, message: 'private content' },
      });
      await service.flushVoiceTaskPersistence();
      const pending = await ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean();
      expect(pending.payload.pendingCompletionDeliveryErrorCode).toBe(expectedCode);
      service.resetVoiceTasksForTests();
      await service.hydrateVoiceTask(task.taskId, scope);
      service.linkVoiceTaskOwnerChild(task.taskId, { continuationKey: 'phase_b:reply-delivery' });
      await service.flushVoiceTaskPersistence();
      service.resetVoiceTasksForTests();
      await service.hydrateVoiceTask(task.taskId, scope);
      expect(service.snapshotEvent(task.taskId)).toMatchObject({
        state: 'completed',
        resultMessageId: 'reply-delivery',
        retryable: false,
        error: { code: expectedCode },
      });
      expect(JSON.stringify(service.snapshotEvent(task.taskId))).not.toContain('private');
    },
  );

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

  test.each([true, false])(
    'canonical End with a blocked shared aggregate: already ended=%s',
    async (alreadyEnded) => {
      const scope = { callSessionId: 'call-terminal-replay', userId: '507f1f77bcf86cd799439011' };
      await ViventiumCallSession.create({
        ...scope,
        agentId: 'agent-terminal-replay',
        conversationId: 'conversation-terminal-replay',
        roomName: 'room-terminal-replay',
        callStatus: alreadyEnded ? 'ended' : 'listening',
        expiresAt: new Date(Date.now() + 60_000),
      });
      let releaseReplay;
      let observeAuthority;
      const blockedReplay = new Promise((resolve) => {
        releaseReplay = resolve;
      });
      const observedAuthority = new Promise((resolve) => {
        observeAuthority = resolve;
      });
      const realAggregate = ViventiumVoiceTask.aggregate.bind(ViventiumVoiceTask);
      const realExists = ViventiumCallSession.exists.bind(ViventiumCallSession);
      const aggregate = jest
        .spyOn(ViventiumVoiceTask, 'aggregate')
        .mockImplementationOnce((pipeline) => ({
          option: async (options) => {
            await blockedReplay;
            return realAggregate(pipeline).option(options);
          },
        }));
      const exists = jest.spyOn(ViventiumCallSession, 'exists').mockImplementation((filter) =>
        realExists(filter).then((row) => {
          observeAuthority(row);
          return row;
        }),
      );
      const onCallEnded = jest.fn();
      const onEvent = jest.fn();
      const tail = service.subscribeDurableVoiceTaskEventsForCall({
        ...scope,
        onEvent,
        onCallEnded,
      });
      try {
        const firstAuthority = await observedAuthority;
        if (alreadyEnded) {
          expect(firstAuthority).not.toBeNull();
          await new Promise((resolve) => setImmediate(resolve));
          expect(onCallEnded).toHaveBeenCalledTimes(1);
        } else {
          expect(firstAuthority).toBeNull();
          await ViventiumCallSession.updateOne(
            { callSessionId: scope.callSessionId },
            { $set: { callStatus: 'ended' } },
          );
          expect(tail.catchUp()).toBe(tail.ready);
          expect(onCallEnded).not.toHaveBeenCalled();
        }
        releaseReplay();
        await tail.ready;
        await tail.catchUp();
        expect(onCallEnded).toHaveBeenCalledTimes(1);
        expect(onEvent).not.toHaveBeenCalled();
      } finally {
        releaseReplay();
        await tail.ready;
        tail.stop();
        aggregate.mockRestore();
        exists.mockRestore();
      }
    },
  );

  test.each([
    ['active', 'listening', 'user-terminal-scope', false],
    ['failed', 'failed', 'user-terminal-scope', false],
    ['foreign owner', 'ended', 'foreign-terminal-owner', false],
    ['expired', 'ended', 'user-terminal-scope', true],
  ])(
    '%s canonical call does not revoke another live task tail',
    async (_name, callStatus, userId, expired) => {
      const scope = { callSessionId: 'call-terminal-scope', userId: 'user-terminal-scope' };
      await ViventiumCallSession.create({
        ...scope,
        userId,
        agentId: 'agent-terminal-scope',
        conversationId: 'conversation-terminal-scope',
        roomName: 'room-terminal-scope',
        callStatus,
        expiresAt: new Date(Date.now() + (expired ? -60_000 : 60_000)),
      });
      const onCallEnded = jest.fn();
      const tail = service.subscribeDurableVoiceTaskEventsForCall({
        ...scope,
        onEvent: jest.fn(),
        onCallEnded,
      });
      try {
        await tail.ready;
        await tail.catchUp();
        expect(onCallEnded).not.toHaveBeenCalled();
      } finally {
        tail.stop();
      }
    },
  );
});
