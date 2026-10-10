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
    req.user = { id: req.headers['x-test-user'] || 'owner-restricted' };
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
const {
  enforceRestrictedVoiceRequest,
  sanitizeAgentForRestrictedVoiceTurn,
} = require('../VoiceActorAuthorityService');
const {
  prepareRestrictedVoiceCancellation,
  bindHarnessCancellation,
} = require('../GlassHiveConversationProviderService');
const agentRoutes = require('~/server/routes/agents/index');

describe('restricted ordinary chat inference Stop', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agents', agentRoutes);
  beforeEach(async () => {
    await GenerationJobManager.destroy();
    jest.clearAllMocks();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await GenerationJobManager.destroy();
  });

  async function subject({ cleanupOnComplete = true, prepare = true } = {}) {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    GenerationJobManager.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete,
    });
    await GenerationJobManager.initialize();
    const job = await GenerationJobManager.createJob(
      'stream-restricted',
      'owner-restricted',
      'conversation-restricted',
      {
        interactionContext: {
          actor_kind: 'external_user',
          origin: 'interactive',
          surface: 'web',
          conversation_id: 'conversation-restricted',
          revision: 1,
          source_event_id: 'source-restricted',
        },
      },
    );
    const req = {
      user: { id: 'owner-restricted' },
      _resumableStreamId: 'stream-restricted',
      config: {
        endpoints: {
          agents: {
            providerCapabilities: {
              native: { conversation_session: true, workspace_binding: true },
              direct: { workspace_binding: false },
            },
          },
        },
      },
      body: {
        conversationId: 'conversation-restricted',
        voiceMode: true,
        viventiumActorTrust: 'unknown',
        viventiumCanAuthorizeSideEffects: false,
        responseMessageId: 'caller-forged-response',
        nativeCancellationAllowed: true,
      },
    };
    const endpointConfig = { baseURL: 'http://native.test/v1', apiKey: 'synthetic-native-key' };
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ state: 'cancelled', capacityReleased: true }),
    }));
    if (prepare)
      await prepareRestrictedVoiceCancellation({
        req,
        signal: job.abortController.signal,
        endpointConfig,
        providerId: 'native',
        activate: false,
      });
    // The actual initializeClient seam precedes onStart's server-owned response metadata.
    await GenerationJobManager.updateMetadata('stream-restricted', {
      responseMessageId: 'server-response',
      userMessage: {
        messageId: 'source-restricted',
        conversationId: 'conversation-restricted',
        text: 'A useful reply.',
      },
    });
    const bind = (selectedReq = req, signal = job.abortController.signal) =>
      bindHarnessCancellation({
        req: selectedReq,
        signal,
        endpointConfig: { baseURL: 'http://forged.test/v1', apiKey: 'forged' },
        fetchImpl,
      });
    return { store, job, req, endpointConfig, fetchImpl, bind };
  }

  test.each([false, true])(
    'ordinary owner abort cancels only its exact native inference (cleanup=%s)',
    async (cleanupOnComplete) => {
      const s = await subject({ cleanupOnComplete });
      expect(s.bind()).toBe(true);
      enforceRestrictedVoiceRequest(s.req);
      enforceRestrictedVoiceRequest(s.req);
      const sanitized = sanitizeAgentForRestrictedVoiceTurn({
        tools: ['forbidden'],
        agent_ids: ['forbidden'],
        background_cortices: ['forbidden'],
        model_parameters: {},
      });
      const result = await request(app)
        .post('/api/agents/chat/abort')
        .send({ streamId: 'stream-restricted' });
      await s.req._viventiumHarnessCancellationDeliveryPromise;
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(s.fetchImpl).toHaveBeenCalledTimes(1);
      expect(s.fetchImpl).toHaveBeenCalledWith(
        'http://native.test/v1/requests/by-idempotency/server-response/cancel',
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer synthetic-native-key',
            'X-Viventium-User-Id': 'owner-restricted',
          },
        }),
      );
      expect(s.req._viventiumHarnessExecutionEnabled).toBe(false);
      expect(s.req._viventiumHarnessIdempotencyKey).toBeUndefined();
      expect(s.req.viventiumVoiceWorkAuthority).toBeUndefined();
      expect(sanitized.tools).toEqual([]);
      expect(sanitized.agent_ids).toEqual([]);
      expect(sanitized.background_cortices).toEqual([]);
    },
  );

  test.each([
    'foreign owner',
    'forged call',
    'forged task',
    'wrong signal',
    'direct provider',
    'foreign conversation',
  ])('%s cannot prepare native inference cancellation', async (kind) => {
    const s = await subject({ prepare: false });
    if (kind === 'foreign owner') s.req.user.id = 'foreign-owner';
    if (kind === 'forged call') s.req.body.viventiumCallSessionId = 'forged-call';
    if (kind === 'forged task') s.req.body.viventiumVoiceTaskId = 'forged-task';
    if (kind === 'foreign conversation') s.req.body.conversationId = 'foreign-conversation';
    expect(
      await prepareRestrictedVoiceCancellation({
        req: s.req,
        signal:
          kind === 'wrong signal' ? new AbortController().signal : s.job.abortController.signal,
        endpointConfig: s.endpointConfig,
        providerId: kind === 'direct provider' ? 'direct' : 'native',
        activate: false,
      }),
    ).toBe(false);
    expect(s.bind()).toBe(false);
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });
  test.each(['explicit false', 'absent'])(
    'owned restricted chat with %s Voice mode keeps inference cancellation',
    async (mode) => {
      const s = await subject({ prepare: false });
      if (mode === 'explicit false') s.req.body.voiceMode = false;
      else delete s.req.body.voiceMode;
      expect(
        await prepareRestrictedVoiceCancellation({
          req: s.req,
          signal: s.job.abortController.signal,
          endpointConfig: s.endpointConfig,
          providerId: 'native',
          activate: false,
        }),
      ).toBe(true);
      expect(s.bind()).toBe(true);
      enforceRestrictedVoiceRequest(s.req);
      const result = await request(app)
        .post('/api/agents/chat/abort')
        .send({ streamId: 'stream-restricted' });
      expect(result.status).toBe(200);
      expect(s.fetchImpl).toHaveBeenCalledTimes(1);
      expect(s.req._viventiumHarnessExecutionEnabled).toBe(false);
    },
  );
  test('copied or inherited request and replacement signal cannot retain a native handle', async () => {
    const s = await subject();
    expect(s.bind()).toBe(true);
    expect(s.bind({ ...s.req })).toBe(false);
    expect(s.bind(Object.create(s.req))).toBe(false);
    expect(s.bind(s.req, new AbortController().signal)).toBe(false);
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });
  test('foreign owner HTTP abort cannot reach the native cancellation listener', async () => {
    const s = await subject();
    expect(s.bind()).toBe(true);
    const result = await request(app)
      .post('/api/agents/chat/abort')
      .set('x-test-user', 'foreign-owner')
      .send({ streamId: 'stream-restricted' });
    expect(result.status).toBe(404);
    expect(s.fetchImpl).not.toHaveBeenCalled();
    expect(s.job.abortController.signal.aborted).toBe(false);
  });
  test('ordinary abort waits for the exact native capacity acknowledgment before success', async () => {
    const s = await subject();
    expect(s.bind()).toBe(true);
    let release, started;
    const acknowledgment = new Promise((resolve) => {
      release = resolve;
    });
    const deliveryStarted = new Promise((resolve) => {
      started = resolve;
    });
    s.fetchImpl.mockImplementation(async () => {
      started();
      await acknowledgment;
      return { ok: true, json: async () => ({ state: 'cancelled', capacityReleased: true }) };
    });
    let returned = false;
    const stop = request(app)
      .post('/api/agents/chat/abort')
      .send({ streamId: 'stream-restricted' })
      .then((result) => {
        returned = true;
        return result;
      });
    await deliveryStarted;
    await new Promise(setImmediate);
    expect(returned).toBe(false);
    expect(await s.store.getJob('stream-restricted')).not.toBeNull();
    release();
    expect((await stop).status).toBe(200);
  });
  test.each([false, true])(
    'owner abort cannot retire a successor admitted during acknowledgment (cleanup=%s)',
    async (cleanupOnComplete) => {
      const s = await subject({ cleanupOnComplete });
      expect(s.bind()).toBe(true);
      let release, started;
      const acknowledgment = new Promise((resolve) => {
        release = resolve;
      });
      const deliveryStarted = new Promise((resolve) => {
        started = resolve;
      });
      s.fetchImpl.mockImplementation(async () => {
        started();
        await acknowledgment;
        return { ok: true, json: async () => ({ state: 'cancelled', capacityReleased: true }) };
      });
      const stop = request(app)
        .post('/api/agents/chat/abort')
        .send({ streamId: 'stream-restricted' })
        .then((result) => result);
      await deliveryStarted;
      const successor = await GenerationJobManager.createJob(
        'stream-restricted',
        'owner-restricted',
        'conversation-restricted',
      );
      await GenerationJobManager.updateMetadata('stream-restricted', {
        responseMessageId: 'successor-response',
      });
      GenerationJobManager.setContentParts('stream-restricted', [
        { type: 'text', text: 'Successor content.' },
      ]);
      const expected = await s.store.getJob('stream-restricted');
      const clear = jest.spyOn(s.store, 'clearContentState');
      const complete = jest.spyOn(s.store, 'completeLogicalTurn');
      const remove = jest.spyOn(s.store, 'deleteJob');
      release();
      const result = await stop;
      expect(result.status).toBe(202);
      expect(result.body).toMatchObject({ success: false, nativeResponse: 'unavailable' });
      expect(await s.store.getJob('stream-restricted')).toEqual(expected);
      expect((await s.store.getContentParts('stream-restricted')).content).toEqual([
        { type: 'text', text: 'Successor content.' },
      ]);
      expect(successor.abortController.signal.aborted).toBe(false);
      expect(clear).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(require('~/models').saveMessage).not.toHaveBeenCalled();
      expect(s.fetchImpl).toHaveBeenCalledTimes(1);
      expect(s.fetchImpl.mock.calls[0][0]).toBe(
        'http://native.test/v1/requests/by-idempotency/server-response/cancel',
      );
    },
  );
  test('unconfirmed native cancellation cannot return ordinary abort success', async () => {
    const s = await subject();
    expect(s.bind()).toBe(true);
    s.fetchImpl.mockResolvedValue({ ok: false, status: 403 });
    const result = await request(app)
      .post('/api/agents/chat/abort')
      .send({ streamId: 'stream-restricted' });
    expect(result.status).toBe(500);
    expect(result.body.success).not.toBe(true);
    expect((await s.store.getJob('stream-restricted')).status).toBe('running');
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
    s.fetchImpl.mockResolvedValue({
      ok: true,
      json: async () => ({ state: 'cancelled', capacityReleased: true }),
    });
    const retry = await request(app)
      .post('/api/agents/chat/abort')
      .send({ streamId: 'stream-restricted' });
    expect(retry.status).toBe(200);
    expect(retry.body.success).toBe(true);
    expect(s.fetchImpl).toHaveBeenCalledTimes(2);
    expect(await s.store.getJob('stream-restricted')).toBeNull();
  });
  test('selected configured fallback replaces only the sealed inference transport', async () => {
    const s = await subject();
    expect(s.bind()).toBe(true);
    await prepareRestrictedVoiceCancellation({
      req: s.req,
      signal: s.job.abortController.signal,
      endpointConfig: {
        baseURL: 'http://configured-fallback.test/v1',
        apiKey: 'synthetic-fallback-key',
      },
      providerId: 'native',
      fallback: true,
      activate: false,
    });
    s.req._viventiumFallbackLlmAttempt = true;
    enforceRestrictedVoiceRequest(s.req);
    expect(s.bind()).toBe(true);
    const result = await request(app)
      .post('/api/agents/chat/abort')
      .send({ streamId: 'stream-restricted' });
    expect(result.status).toBe(200);
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
    expect(s.fetchImpl).toHaveBeenCalledWith(
      'http://configured-fallback.test/v1/requests/by-idempotency/server-response/cancel',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer synthetic-fallback-key',
          'X-Viventium-User-Id': 'owner-restricted',
        },
      }),
    );
    expect(s.req._viventiumHarnessExecutionEnabled).toBe(false);
  });
  test('reused job identity cannot cancel an earlier sealed request', async () => {
    const s = await subject();
    expect(s.bind()).toBe(true);
    const current = await s.store.getJob('stream-restricted');
    await s.store.updateJob('stream-restricted', { createdAt: current.createdAt + 1 });
    s.job.abortController.abort('user_cancelled');
    await expect(
      s.job.abortController.signal._viventiumHarnessCancellationDelivery,
    ).rejects.toMatchObject({ code: 'HARNESS_CANCELLATION_DELIVERY_FAILED' });
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });
  test.each(['superseded', 'generation_completed', 'disconnect'])(
    '%s does not cancel native inference',
    async (reason) => {
      const s = await subject();
      expect(s.bind()).toBe(true);
      s.job.abortController.abort(reason);
      await new Promise(setImmediate);
      expect(s.fetchImpl).not.toHaveBeenCalled();
    },
  );
});
