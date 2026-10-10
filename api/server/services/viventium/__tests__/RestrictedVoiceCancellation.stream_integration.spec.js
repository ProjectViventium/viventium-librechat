jest.mock('~/server/services/Config/getEndpointsConfig', () => ({ getEndpointsConfig: jest.fn() }));
jest.mock('../GlassHiveCapabilityBootstrapService', () => ({
  buildConversationProviderBootstrapBundle: jest.fn(),
}));
jest.mock('~/app/clients/tools/util/fileSearch', () => ({ primeFiles: jest.fn() }));
jest.mock('~/models', () => ({ getMessages: jest.fn(), getFiles: jest.fn() }));
jest.mock('../CallSessionService', () => ({ getCallSession: jest.fn() }));

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

describe('restricted owner Stop with the compiled stream manager', () => {
  const priorSecret = process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
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

  async function subject({
    cleanupOnComplete,
    nativePublished = false,
    fallback = false,
    alreadyAborted = false,
  }) {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    GenerationJobManager.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete,
    });
    await GenerationJobManager.initialize();
    const task = tasks.createVoiceTask({
      userId: 'owner-readonly',
      callSessionId: 'call-readonly',
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
    const req = {
      user: { id: 'owner-readonly' },
      _resumableStreamId: 'stream-readonly',
      viventiumCallSession: {
        callSessionId: 'call-readonly',
        userId: 'owner-readonly',
        callStatus: 'active',
      },
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
    if (nativePublished) {
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
    }
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
        fallback,
        activate: false,
      }),
    ).toBe(true);
    if (fallback) req._viventiumFallbackLlmAttempt = true;
    if (alreadyAborted) job.abortController.abort('user_cancelled');
    expect(bindHarnessCancellation({ req, signal: job.abortController.signal, fetchImpl })).toBe(
      true,
    );
    return { task, job, store, req, fetchImpl };
  }

  test.each([
    { cleanupOnComplete: true, nativePublished: false, fallback: false },
    { cleanupOnComplete: false, nativePublished: true, fallback: false },
    { cleanupOnComplete: false, nativePublished: true, fallback: true },
  ])('exact successful retirement confirms only after Native capacity ACK: %j', async (options) => {
    const s = await subject(options);
    const actualAbort = GenerationJobManager.abortJob.bind(GenerationJobManager);
    const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(actualAbort);
    await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, { userId: 'owner-readonly' });
    await tasks.flushVoiceTaskOwnerOperations();
    expect(await s.store.getJob('stream-readonly')).toBeNull();
    expect(await abort.mock.results[0].value).toMatchObject({
      success: true,
      jobData: {
        streamId: 'stream-readonly',
        userId: 'owner-readonly',
        responseMessageId: 'response-readonly',
      },
    });
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
    expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_confirmed');
    expect(s.req.viventiumVoiceWorkAuthority).toBeUndefined();
    expect(s.req._viventiumNativeVoiceInputPolling).toBeUndefined();
  });

  test('the listener remains scoped when the call read resumes after successful job deletion', async () => {
    const s = await subject({ cleanupOnComplete: true });
    getCallSession.mockImplementation(async () => {
      if (s.job.abortController.signal.aborted)
        await new Promise((resolve) => setImmediate(resolve));
      return { callSessionId: 'call-readonly', userId: 'owner-readonly', callStatus: 'active' };
    });
    await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, { userId: 'owner-readonly' });
    await tasks.flushVoiceTaskOwnerOperations();
    expect(await s.store.getJob('stream-readonly')).toBeNull();
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
    expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_confirmed');
  });

  test('actual lazy fallback selection retires the same job and releases only its selected endpoint', async () => {
    const s = await subject({ cleanupOnComplete: false, nativePublished: true });
    expect(
      await prepareRestrictedVoiceCancellation({
        req: s.req,
        signal: s.job.abortController.signal,
        endpointConfig: { baseURL: 'http://fallback.test/v1', apiKey: 'synthetic-fallback-key' },
        providerId: 'native',
        fallback: true,
        activate: false,
      }),
    ).toBe(true);
    s.req._viventiumFallbackLlmAttempt = true;
    expect(
      bindHarnessCancellation({
        req: s.req,
        signal: s.job.abortController.signal,
        fetchImpl: s.fetchImpl,
      }),
    ).toBe(true);
    await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, { userId: 'owner-readonly' });
    await tasks.flushVoiceTaskOwnerOperations();
    expect(await s.store.getJob('stream-readonly')).toBeNull();
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
    expect(s.fetchImpl.mock.calls[0][0]).toBe(
      'http://fallback.test/v1/requests/by-idempotency/response-readonly/cancel',
    );
    expect(s.fetchImpl.mock.calls[0][1].headers.Authorization).toBe(
      'Bearer synthetic-fallback-key',
    );
    expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_confirmed');
  });

  test('missing pre-abort job never acquires retirement permission', async () => {
    const s = await subject({ cleanupOnComplete: true });
    await s.store.deleteJob('stream-readonly');
    const abort = jest.spyOn(GenerationJobManager, 'abortJob');
    await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, { userId: 'owner-readonly' });
    await tasks.flushVoiceTaskOwnerOperations();
    expect(abort).not.toHaveBeenCalled();
    expect(s.fetchImpl).not.toHaveBeenCalled();
    expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_unenforceable');
  });

  test.each([
    'replacement',
    'wrong retirement generation',
    'wrong retirement response',
    'changed call owner',
  ])('%s cannot reuse a successful retirement receipt', async (change) => {
    const s = await subject({ cleanupOnComplete: true });
    const actualAbort = GenerationJobManager.abortJob.bind(GenerationJobManager);
    jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async (...args) => {
      const result = await actualAbort(...args);
      if (change === 'replacement') {
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
      if (change === 'wrong retirement generation') result.jobData.createdAt += 1;
      if (change === 'wrong retirement response')
        result.jobData.responseMessageId = 'response-foreign';
      if (change === 'changed call owner')
        getCallSession.mockResolvedValue({
          callSessionId: 'call-readonly',
          userId: 'owner-foreign',
          callStatus: 'active',
        });
      return result;
    });
    await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, { userId: 'owner-readonly' });
    await tasks.flushVoiceTaskOwnerOperations();
    expect(s.fetchImpl).not.toHaveBeenCalled();
    expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_unenforceable');
  });

  test.each(['failed', 'throw'])(
    '%s abort settles the listener without sending or confirming',
    async (failure) => {
      const s = await subject({ cleanupOnComplete: true });
      jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
        s.job.abortController.abort('user_cancelled');
        if (failure === 'throw') throw new Error('Synthetic abort failure');
        return { success: false };
      });
      await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, { userId: 'owner-readonly' });
      await tasks.flushVoiceTaskOwnerOperations();
      await s.req._viventiumHarnessCancellationDeliveryPromise;
      expect(s.fetchImpl).not.toHaveBeenCalled();
      expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_unenforceable');
    },
  );

  test('a retired job still requires a fresh Native capacity acknowledgement', async () => {
    const s = await subject({ cleanupOnComplete: true });
    s.fetchImpl.mockResolvedValue({
      ok: true,
      json: async () => ({ state: 'cancelled', capacityReleased: false }),
    });
    await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, { userId: 'owner-readonly' });
    await tasks.flushVoiceTaskOwnerOperations();
    expect(s.fetchImpl).toHaveBeenCalled();
    expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_unenforceable');
  });

  test('owner replacement after Native ACK cannot confirm an already retired job', async () => {
    const s = await subject({ cleanupOnComplete: true });
    s.fetchImpl.mockImplementation(async () => {
      getCallSession.mockResolvedValue({
        callSessionId: 'call-readonly',
        userId: 'owner-foreign',
        callStatus: 'active',
      });
      return { ok: true, json: async () => ({ state: 'cancelled', capacityReleased: true }) };
    });
    await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, { userId: 'owner-readonly' });
    await tasks.flushVoiceTaskOwnerOperations();
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
    expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_unenforceable');
  });

  test.each([false, true])(
    'direct signal abort (already aborted=%s) cannot confirm the owner task',
    async (alreadyAborted) => {
      const s = await subject({ cleanupOnComplete: false, alreadyAborted });
      if (!alreadyAborted) s.job.abortController.abort('user_cancelled');
      await s.req._viventiumHarnessCancellationDeliveryPromise;
      expect(s.fetchImpl).toHaveBeenCalledTimes(1);
      expect(tasks.getVoiceTask(s.task.taskId).state).not.toBe('cancelled_confirmed');
      expect(await s.store.getJob('stream-readonly')).not.toBeNull();
    },
  );
});
