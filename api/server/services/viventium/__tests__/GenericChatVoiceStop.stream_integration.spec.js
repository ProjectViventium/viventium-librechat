jest.mock('~/server/services/Config/getEndpointsConfig', () => ({ getEndpointsConfig: jest.fn() }));
jest.mock('../GlassHiveCapabilityBootstrapService', () => ({
  buildConversationProviderBootstrapBundle: jest.fn(),
}));
jest.mock('~/app/clients/tools/util/fileSearch', () => ({ primeFiles: jest.fn() }));
jest.mock('~/models', () => ({
  getMessages: jest.fn(),
  getFiles: jest.fn(),
  saveMessage: jest.fn(),
}));
jest.mock('../CallSessionService', () => ({ getCallSession: jest.fn() }));
jest.mock('~/server/middleware', () => ({
  uaParser: (_req, _res, next) => next(),
  checkBan: (_req, _res, next) => next(),
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: req.headers['x-test-user'] || 'owner-readonly' };
    next();
  },
  messageIpLimiter: (_req, _res, next) => next(),
  configMiddleware: (_req, _res, next) => next(),
  messageUserLimiter: (_req, _res, next) => next(),
}));
jest.mock('~/server/routes/agents/chat', () => require('express').Router());
jest.mock('~/server/routes/agents/openai', () => require('express').Router());
jest.mock('~/server/routes/agents/responses', () => require('express').Router());
jest.mock('~/server/routes/agents/v1', () => ({ v1: require('express').Router() }));

const express = require('express');
const request = require('supertest');
const {
  GenerationJobManager,
  InMemoryJobStore,
  InMemoryEventTransport,
} = require('@librechat/api');
const tasks = require('../VoiceTaskService');
const { getCallSession } = require('../CallSessionService');
const {
  prepareRestrictedVoiceCancellation,
  bindHarnessCancellation,
} = require('../GlassHiveConversationProviderService');
const agentRoutes = require('~/server/routes/agents/index');
const { saveMessage } = require('~/models');

describe('linked-chat Stop of a native Voice generation', () => {
  const priorSecret = process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
  const app = express();
  app.use(express.json());
  app.use('/api/agents', agentRoutes);

  beforeEach(async () => {
    await GenerationJobManager.destroy();
    tasks.resetVoiceTasksForTests();
    getCallSession.mockReset().mockResolvedValue({
      callSessionId: 'call-readonly',
      userId: 'owner-readonly',
      callStatus: 'active',
    });
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = 'synthetic-stop-secret';
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await GenerationJobManager.destroy();
  });
  afterAll(() => {
    if (priorSecret === undefined) delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
    else process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = priorSecret;
  });

  async function subject({ bindAdapter = true } = {}) {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    GenerationJobManager.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    await GenerationJobManager.initialize();
    const task = tasks.createVoiceTask({
      userId: 'owner-readonly',
      callSessionId: 'call-readonly',
      conversationId: 'conversation-readonly',
      streamId: 'stream-readonly',
      owner: { kind: 'generation_job', id: 'stream-readonly' },
    });
    const job = await GenerationJobManager.createJob(
      'stream-readonly',
      'owner-readonly',
      'conversation-readonly',
      {
        interactionContext: {
          actor_kind: 'external_user',
          origin: 'interactive',
          surface: 'voice',
          conversation_id: 'conversation-readonly',
          revision: 1,
          source_event_id: 'source-readonly',
        },
      },
    );
    await GenerationJobManager.updateMetadata('stream-readonly', {
      responseMessageId: 'response-readonly',
      viventiumCallSessionId: 'call-readonly',
      viventiumVoiceTaskId: task.taskId,
      userMessage: {
        messageId: 'source-readonly',
        conversationId: 'conversation-readonly',
        text: 'Hello',
      },
    });
    const current = await store.getJob('stream-readonly');
    const admittedAt = Date.now();
    const identity = {
      userId: 'owner-readonly',
      conversationId: 'conversation-readonly',
      responseMessageId: 'response-readonly',
      streamId: 'stream-readonly',
      jobCreatedAt: current.createdAt,
      logicalTurnId: current.interactionContext.logical_turn_id,
      revision: current.interactionContext.revision,
      invocationId: 'invocation-readonly',
      bodySha256: 'a'.repeat(64),
      providerId: 'native',
      agentId: 'agent-readonly',
      originSha256: 'b'.repeat(64),
      source: { id: 'source-row', messageId: 'source-readonly', digest: 'c'.repeat(64) },
      admittedAt,
      recoverUntil: admittedAt + 86_400_000,
    };
    expect(await GenerationJobManager.bindNativeResponse(identity)).toBe(true);
    GenerationJobManager.setNativeResponseCancellation(async (_identity, snapshot) => ({
      messageId: 'response-readonly',
      text: snapshot.text,
      content: snapshot.content,
      unfinished: true,
      error: false,
    }));
    const req = {
      user: { id: 'owner-readonly' },
      _resumableStreamId: 'stream-readonly',
      viventiumCallSession: { callSessionId: 'call-readonly', userId: 'owner-readonly' },
      config: {
        endpoints: {
          agents: {
            providerCapabilities: {
              native: { conversation_session: true, workspace_binding: true },
            },
          },
        },
      },
      body: {
        voiceMode: true,
        viventiumVoiceTaskId: task.taskId,
        viventiumActorTrust: 'unknown',
        viventiumCanAuthorizeSideEffects: false,
      },
    };
    const endpointConfig = { baseURL: 'http://native.test/v1', apiKey: 'synthetic-native-key' };
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ state: 'cancelled', capacityReleased: true }),
    }));
    expect(
      await prepareRestrictedVoiceCancellation({
        req,
        signal: job.abortController.signal,
        endpointConfig,
        providerId: 'native',
        activate: false,
      }),
    ).toBe(true);
    if (bindAdapter) {
      expect(bindHarnessCancellation({ req, signal: job.abortController.signal, fetchImpl })).toBe(
        true,
      );
    } else {
      tasks.setVoiceTaskOwnerCapabilities(task.taskId, {
        kind: 'remote_generation',
        ownerId: 'stream-readonly',
        cancellationConfirmable: false,
      });
    }
    return { task, job, store, req, fetchImpl, identity };
  }

  const stop = () =>
    request(app)
      .post('/api/agents/chat/abort')
      .send({ streamId: 'stream-readonly', conversationId: 'conversation-readonly' });

  test.each(['active', 'ended'])(
    'owner chat Stop releases a %s call generation after real manager retirement',
    async (callStatus) => {
      const s = await subject();
      getCallSession.mockImplementation(async () => {
        if (s.job.abortController.signal.aborted)
          await new Promise((resolve) => setImmediate(resolve));
        return { callSessionId: 'call-readonly', userId: 'owner-readonly', callStatus };
      });
      const response = await stop();
      await tasks.flushVoiceTaskOwnerOperations();
      await s.req._viventiumHarnessCancellationDeliveryPromise;
      expect(s.fetchImpl).toHaveBeenCalledTimes(1);
      expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_confirmed');
      expect(await s.store.getJob('stream-readonly')).toBeNull();
      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ outcome: 'cancelling' });
      expect(saveMessage).not.toHaveBeenCalled();
      expect(s.req.viventiumVoiceWorkAuthority).toBeUndefined();
      expect(s.req._viventiumNativeVoiceInputPolling).toBeUndefined();
    },
  );

  test('no adapter Stop aborts the exact local generation after its durable barrier', async () => {
    const s = await subject({ bindAdapter: false });
    const tombstones = new Map();
    tasks.setVoiceTaskSuppressionPersistenceForTests({
      persist: async (row) => tombstones.set(row.taskId, { ...row }),
      lookup: async ({ taskId }) => tombstones.get(taskId) || null,
    });
    let barrierAtAbort;
    const abortJob = GenerationJobManager.abortJob.bind(GenerationJobManager);
    const abort = jest
      .spyOn(GenerationJobManager, 'abortJob')
      .mockImplementation(async (...args) => {
        barrierAtAbort = { ...tombstones.get(s.task.taskId) };
        return abortJob(...args);
      });
    const response = await stop();
    await tasks.flushVoiceTaskOwnerOperations();
    await new Promise(setImmediate);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ outcome: 'cancelling', task: { state: 'cancelling' } });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith('stream-readonly', 'user_cancelled', 'owner-readonly');
    expect(barrierAtAbort).toMatchObject({
      state: 'cancelling',
      taskId: s.task.taskId,
      userId: 'owner-readonly',
    });
    expect(s.job.abortController.signal.aborted).toBe(true);
    expect(await s.store.getJob('stream-readonly')).toBeNull();
    expect(s.fetchImpl).not.toHaveBeenCalled();
    expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_unenforceable');
    expect(tombstones.get(s.task.taskId)).toMatchObject({
      state: 'cancelled_unenforceable',
      owner: { kind: 'remote_generation' },
    });
    expect(await tasks.isVoiceTaskSuppressedDurably(s.task.taskId)).toBe(true);
    expect(
      tasks.observeGenerationEvent(s.task.taskId, {
        event: 'on_run_step',
        data: { text: 'Late answer' },
      }),
    ).toBeNull();
    expect(tasks.completeVoiceTask(s.task.taskId, { resultMessageId: 'late-result' })).toBeNull();
    expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_unenforceable');
  });

  test.each(['failed', 'throw'])(
    'no adapter %s Stop keeps late output suppressed',
    async (failure) => {
      const s = await subject({ bindAdapter: false });
      const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
        if (failure === 'throw') throw new Error('Synthetic no-adapter abort failure');
        return { success: false };
      });
      const response = await stop();
      await tasks.flushVoiceTaskOwnerOperations();
      await new Promise(setImmediate);
      expect(response.status).toBe(202);
      expect(abort).toHaveBeenCalledTimes(1);
      expect(s.fetchImpl).not.toHaveBeenCalled();
      expect(s.job.abortController.signal.aborted).toBe(false);
      expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_unenforceable');
      expect(tasks.isVoiceTaskSuppressed(s.task.taskId)).toBe(true);
      expect(
        tasks.observeGenerationEvent(s.task.taskId, {
          event: 'on_run_step',
          data: { text: 'Late answer' },
        }),
      ).toBeNull();
      expect(tasks.completeVoiceTask(s.task.taskId, { resultMessageId: 'late-result' })).toBeNull();
    },
  );

  test('no adapter Stop after hangup cannot confirm from a stale capability flag', async () => {
    const s = await subject({ bindAdapter: false });
    tasks.setVoiceTaskOwnerCapabilities(s.task.taskId, {
      kind: 'remote_generation',
      ownerId: 'stream-readonly',
      cancellationConfirmable: true,
    });
    getCallSession.mockResolvedValue({
      callSessionId: 'call-readonly',
      userId: 'owner-readonly',
      callStatus: 'ended',
    });
    const response = await stop();
    await tasks.flushVoiceTaskOwnerOperations();
    expect(response.status).toBe(202);
    expect(s.job.abortController.signal.aborted).toBe(true);
    expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_unenforceable');
    expect(tasks.isVoiceTaskSuppressed(s.task.taskId)).toBe(true);
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });

  test('no adapter cannot abort before the durable suppression write succeeds', async () => {
    const s = await subject({ bindAdapter: false });
    tasks.setVoiceTaskSuppressionPersistenceForTests({
      persist: async () => {
        throw new Error('Synthetic durable barrier failure');
      },
    });
    const abort = jest.spyOn(GenerationJobManager, 'abortJob');
    const response = await stop();
    expect(response.status).toBe(503);
    expect(abort).not.toHaveBeenCalled();
    expect(s.job.abortController.signal.aborted).toBe(false);
    expect(tasks.getVoiceTask(s.task.taskId).state).toBe('recovering');
    expect(tasks.isVoiceTaskSuppressed(s.task.taskId)).toBe(true);
  });

  test('no adapter fallback cannot abort a replacement admitted during the durable write', async () => {
    const s = await subject({ bindAdapter: false });
    let replaced = false;
    tasks.setVoiceTaskSuppressionPersistenceForTests({
      persist: async () => {
        if (replaced) return;
        replaced = true;
        s.job.abortController.abort('stream_reused');
        await GenerationJobManager.createJob(
          'stream-readonly',
          'owner-readonly',
          'conversation-readonly',
        );
        await GenerationJobManager.updateMetadata('stream-readonly', {
          responseMessageId: 'response-readonly',
          viventiumCallSessionId: 'call-readonly',
          viventiumVoiceTaskId: s.task.taskId,
        });
      },
    });
    const abort = jest.spyOn(GenerationJobManager, 'abortJob');
    const response = await stop();
    await tasks.flushVoiceTaskOwnerOperations();
    expect(response.status).toBe(202);
    expect(abort).not.toHaveBeenCalled();
    const current = await GenerationJobManager.getJob('stream-readonly');
    expect(current.abortController.signal).not.toBe(s.job.abortController.signal);
    expect(current.abortController.signal.aborted).toBe(false);
    expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_unenforceable');
    expect(tasks.isVoiceTaskSuppressed(s.task.taskId)).toBe(true);
  });

  test.each(['pending', 'committed'])(
    'a %s native answer also wins over no adapter Stop',
    async (nativeResponse) => {
      const s = await subject({ bindAdapter: false });
      const tombstones = new Map();
      tasks.setVoiceTaskSuppressionPersistenceForTests({
        persist: async (row) => tombstones.set(row.taskId, { ...row }),
        clear: async (taskId) => tombstones.delete(taskId),
        lookup: async ({ taskId }) => tombstones.get(taskId) || null,
      });
      expect(
        await GenerationJobManager.commitNativeResponse(s.identity, 'd'.repeat(64)),
      ).toMatchObject({ status: 'committed' });
      const final = {
        final: true,
        responseMessage: { messageId: 'response-readonly', text: 'Saved answer' },
      };
      GenerationJobManager.setNativeResponseRecovery(async (identity) =>
        nativeResponse === 'committed'
          ? GenerationJobManager.finishNativeResponse(identity, final)
          : false,
      );
      const response = await stop();
      await tasks.flushVoiceTaskOwnerOperations();
      expect(response.status).toBe(202);
      expect(tasks.getVoiceTask(s.task.taskId).state).toBe('completed');
      expect(await tasks.isVoiceTaskSuppressedDurably(s.task.taskId)).toBe(false);
      expect(tombstones.has(s.task.taskId)).toBe(false);
      expect(s.job.abortController.signal.aborted).toBe(false);
      expect(s.fetchImpl).not.toHaveBeenCalled();
    },
  );

  test('caller body cannot replace the server-derived task binding', async () => {
    const s = await subject();
    const response = await request(app).post('/api/agents/chat/abort').send({
      streamId: 'stream-readonly',
      conversationId: 'conversation-readonly',
      viventiumVoiceTaskId: 'foreign-task',
      viventiumCallSessionId: 'foreign-call',
    });
    await tasks.flushVoiceTaskOwnerOperations();
    expect(response.status).toBe(202);
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
    expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_confirmed');
  });

  test.each([
    'foreign authenticated owner',
    'foreign task owner',
    'foreign call',
    'foreign conversation',
    'foreign stream',
    'missing task',
  ])('%s cannot acquire native cancellation', async (change) => {
    const s = await subject();
    if (change === 'foreign task owner') {
      const foreign = tasks.createVoiceTask({
        userId: 'owner-foreign',
        callSessionId: 'call-readonly',
        conversationId: 'conversation-readonly',
        streamId: 'stream-foreign',
        owner: { kind: 'remote_generation', id: 'stream-readonly' },
      });
      await GenerationJobManager.updateMetadata('stream-readonly', {
        viventiumVoiceTaskId: foreign.taskId,
      });
    }
    if (change === 'foreign call')
      await GenerationJobManager.updateMetadata('stream-readonly', {
        viventiumCallSessionId: 'call-foreign',
      });
    if (change === 'foreign conversation') {
      const foreign = tasks.createVoiceTask({
        userId: 'owner-readonly',
        callSessionId: 'call-readonly',
        conversationId: 'conversation-foreign',
        streamId: 'stream-foreign',
        owner: { kind: 'remote_generation', id: 'stream-foreign' },
      });
      expect(foreign.taskId).not.toBe(s.task.taskId);
      tasks.bindVoiceTaskStream(foreign.taskId, 'stream-readonly');
      tasks.setVoiceTaskOwnerCapabilities(foreign.taskId, {
        kind: 'remote_generation',
        ownerId: 'stream-readonly',
        cancellationConfirmable: false,
      });
      await GenerationJobManager.updateMetadata('stream-readonly', {
        viventiumVoiceTaskId: foreign.taskId,
      });
    }
    if (change === 'foreign stream') tasks.bindVoiceTaskStream(s.task.taskId, 'stream-foreign');
    if (change === 'missing task')
      await GenerationJobManager.updateMetadata('stream-readonly', {
        viventiumVoiceTaskId: 'missing-task',
      });
    const response =
      change === 'foreign authenticated owner'
        ? await request(app)
            .post('/api/agents/chat/abort')
            .set('x-test-user', 'owner-foreign')
            .send({ streamId: 'stream-readonly' })
        : await stop();
    expect(response.status).toBe(404);
    expect(s.fetchImpl).not.toHaveBeenCalled();
    expect(s.job.abortController.signal.aborted).toBe(false);
    expect(tasks.getVoiceTask(s.task.taskId).state).toBe('running');
  });

  test('replacement job during task lookup cannot be stopped by the old server binding', async () => {
    const s = await subject();
    const readJob = GenerationJobManager.getJob.bind(GenerationJobManager);
    let reads = 0;
    jest.spyOn(GenerationJobManager, 'getJob').mockImplementation(async (streamId) => {
      if (++reads === 2) {
        s.job.abortController.abort('stream_reused');
        await GenerationJobManager.createJob(
          'stream-readonly',
          'owner-readonly',
          'conversation-readonly',
        );
        await GenerationJobManager.updateMetadata('stream-readonly', {
          responseMessageId: 'response-readonly',
          viventiumCallSessionId: 'call-readonly',
          viventiumVoiceTaskId: s.task.taskId,
        });
      }
      return readJob(streamId);
    });
    const response = await stop();
    expect(response.status).toBe(404);
    expect(s.fetchImpl).not.toHaveBeenCalled();
    const current = await readJob('stream-readonly');
    expect(current.abortController.signal).not.toBe(s.job.abortController.signal);
    expect(current.abortController.signal.aborted).toBe(false);
    expect(tasks.getVoiceTask(s.task.taskId).state).toBe('running');
  });

  test('changed generation owner during lookup rejects the stale native owner', async () => {
    const s = await subject();
    const readJob = GenerationJobManager.getJob.bind(GenerationJobManager);
    let reads = 0;
    jest.spyOn(GenerationJobManager, 'getJob').mockImplementation(async (streamId) => {
      if (++reads === 2)
        tasks.setVoiceTaskOwnerCapabilities(s.task.taskId, {
          kind: 'generation_job',
          ownerId: 'stream-readonly',
          cancellationConfirmable: true,
        });
      return readJob(streamId);
    });
    const response = await stop();
    expect(response.status).toBe(404);
    expect(s.fetchImpl).not.toHaveBeenCalled();
    expect(s.job.abortController.signal.aborted).toBe(false);
    expect(tasks.getVoiceTask(s.task.taskId).state).toBe('running');
  });

  test('hangup during capacity ACK still confirms the exact explicit owner Stop', async () => {
    const s = await subject();
    s.fetchImpl.mockImplementation(async () => {
      getCallSession.mockResolvedValue({
        callSessionId: 'call-readonly',
        userId: 'owner-readonly',
        callStatus: 'ended',
      });
      return { ok: true, json: async () => ({ state: 'cancelled', capacityReleased: true }) };
    });
    await stop();
    await tasks.flushVoiceTaskOwnerOperations();
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
    expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_confirmed');
  });

  test.each(['no capacity', 'rejected', 'throw'])(
    'fresh Native ACK %s does not confirm Stop',
    async (failure) => {
      const s = await subject();
      if (failure === 'no capacity')
        s.fetchImpl.mockResolvedValue({
          ok: true,
          json: async () => ({ capacityReleased: false }),
        });
      if (failure === 'rejected') s.fetchImpl.mockResolvedValue({ ok: false, status: 403 });
      if (failure === 'throw')
        s.fetchImpl.mockRejectedValue(new Error('Synthetic transport failure'));
      const response = await stop();
      await tasks.flushVoiceTaskOwnerOperations();
      expect(response.status).toBe(202);
      expect(s.fetchImpl).toHaveBeenCalled();
      expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_unenforceable');
      expect(tasks.isVoiceTaskSuppressed(s.task.taskId)).toBe(true);
    },
  );

  test.each(['failed', 'throw'])(
    '%s manager Stop settles without Native delivery',
    async (failure) => {
      const s = await subject();
      jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
        s.job.abortController.abort('user_cancelled');
        if (failure === 'throw') throw new Error('Synthetic abort failure');
        return { success: false };
      });
      const response = await stop();
      await tasks.flushVoiceTaskOwnerOperations();
      await s.req._viventiumHarnessCancellationDeliveryPromise;
      expect(response.status).toBe(202);
      expect(s.fetchImpl).not.toHaveBeenCalled();
      expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_unenforceable');
    },
  );

  test.each(['pending', 'committed'])(
    'a %s native answer wins over chat Stop after hangup',
    async (nativeResponse) => {
      const s = await subject();
      getCallSession.mockResolvedValue({
        callSessionId: 'call-readonly',
        userId: 'owner-readonly',
        callStatus: 'ended',
      });
      expect(
        await GenerationJobManager.commitNativeResponse(s.identity, 'd'.repeat(64)),
      ).toMatchObject({ status: 'committed' });
      const final = {
        final: true,
        responseMessage: { messageId: 'response-readonly', text: 'Saved answer' },
      };
      GenerationJobManager.setNativeResponseRecovery(async (identity) =>
        nativeResponse === 'committed'
          ? GenerationJobManager.finishNativeResponse(identity, final)
          : false,
      );
      const response = await stop();
      await tasks.flushVoiceTaskOwnerOperations();
      expect(response.status).toBe(202);
      expect(tasks.getVoiceTask(s.task.taskId).state).toBe('completed');
      expect(tasks.isVoiceTaskSuppressed(s.task.taskId)).toBe(false);
      expect(s.fetchImpl).not.toHaveBeenCalled();
      expect(s.job.abortController.signal.aborted).toBe(false);
      if (nativeResponse === 'committed')
        expect((await s.store.getJob('stream-readonly')).finalEvent).toBe(JSON.stringify(final));
    },
  );

  test('non-Voice abort retains its normal compiled-manager response and partial save', async () => {
    const store = new InMemoryJobStore();
    GenerationJobManager.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    await GenerationJobManager.initialize();
    await GenerationJobManager.createJob(
      'stream-readonly',
      'owner-readonly',
      'conversation-readonly',
    );
    await GenerationJobManager.updateMetadata('stream-readonly', {
      responseMessageId: 'response-readonly',
      userMessage: {
        messageId: 'source-readonly',
        conversationId: 'conversation-readonly',
        text: 'Hello',
      },
    });
    const response = await stop();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, aborted: 'stream-readonly' });
    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect((await store.getJob('stream-readonly')).status).toBe('aborted');
  });
});
