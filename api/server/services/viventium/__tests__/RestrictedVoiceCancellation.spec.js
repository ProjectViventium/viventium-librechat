jest.mock('~/server/services/Config/getEndpointsConfig', () => ({ getEndpointsConfig: jest.fn() }));
jest.mock('../GlassHiveCapabilityBootstrapService', () => ({
  buildConversationProviderBootstrapBundle: jest.fn(),
}));
jest.mock('~/app/clients/tools/util/fileSearch', () => ({ primeFiles: jest.fn() }));
jest.mock('~/models', () => ({ getMessages: jest.fn(), getFiles: jest.fn() }));
jest.mock('../CallSessionService', () => ({ getCallSession: jest.fn() }));

const { GenerationJobManager } = require('@librechat/api');
const tasks = require('../VoiceTaskService');
const { getCallSession } = require('../CallSessionService');
const {
  enforceRestrictedVoiceRequest,
  sanitizeAgentForRestrictedVoiceTurn,
} = require('../VoiceActorAuthorityService');
const {
  bindHarnessCancellation,
  prepareRestrictedVoiceCancellation,
} = require('../GlassHiveConversationProviderService');

describe('restricted Voice generation Stop', () => {
  const priorSecret = process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
  beforeEach(() => {
    tasks.resetVoiceTasksForTests();
    jest.clearAllMocks();
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = 'synthetic-stop-secret';
    getCallSession.mockResolvedValue({
      callSessionId: 'call-readonly',
      userId: 'owner-readonly',
      callStatus: 'active',
    });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => {
    if (priorSecret === undefined) delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
    else process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = priorSecret;
  });

  async function subject(provider = 'native-primary', prepare = true) {
    const task = tasks.createVoiceTask({
      userId: 'owner-readonly',
      callSessionId: 'call-readonly',
      streamId: 'stream-readonly',
      owner: { kind: 'generation_job', id: 'stream-readonly' },
    });
    const controller = new AbortController();
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
              'native-primary': { conversation_session: true, workspace_binding: true },
              'native-fallback': { conversation_session: true, workspace_binding: true },
              direct: { workspace_binding: false },
            },
          },
        },
      },
      body: {
        voiceMode: true,
        viventiumCallSessionId: 'call-readonly',
        viventiumVoiceTaskId: task.taskId,
        responseMessageId: 'response-readonly',
        viventiumActorTrust: 'unknown',
        viventiumCanAuthorizeSideEffects: false,
      },
    };
    const agent = {
      id: 'agent-readonly',
      endpoint: 'openAI',
      tools: ['forbidden-tool'],
      agent_ids: ['forbidden-agent'],
      model_parameters: {
        configuration: {
          defaultHeaders: {
            'X-GlassHive-Agent-Id': 'agent-readonly',
            'X-GlassHive-Access': 'full',
            'X-GlassHive-Idempotency-Key': 'forbidden-key',
          },
        },
      },
    };
    const endpointConfig = {
      baseURL: `http://${provider}.test/v1`,
      apiKey: 'synthetic-native-key',
    };
    const job = {
      createdAt: 10,
      abortController: controller,
      metadata: {
        userId: 'owner-readonly',
        viventiumCallSessionId: 'call-readonly',
        viventiumVoiceTaskId: task.taskId,
        responseMessageId: 'response-readonly',
      },
    };
    jest.spyOn(GenerationJobManager, 'getJob').mockResolvedValue(job);
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ state: 'cancelled', capacityReleased: true }),
    }));
    if (prepare)
      await prepareRestrictedVoiceCancellation({
        req,
        signal: controller.signal,
        endpointConfig,
        providerId: provider,
        activate: false,
      });
    const sanitized = sanitizeAgentForRestrictedVoiceTurn(agent);
    const bind = (selected = sanitized) =>
      bindHarnessCancellation({
        req,
        signal: controller.signal,
        endpointConfig: { baseURL: 'http://forged.test/v1', apiKey: 'forged' },
        fetchImpl,
      });
    return { task, controller, req, agent, sanitized, bind, fetchImpl, endpointConfig, job };
  }

  function cortexSubject(main, lifetime, fallback) {
    const req = Object.create(main.req);
    req.body = { ...main.req.body, messageId: 'cortex-run' };
    req._viventiumCortexToolEvidence = require('@librechat/api').createCortexToolEvidence();
    req._viventiumFallbackLlmAttempt = fallback;
    req._viventiumHarnessExecutionEnabled = true;
    req._viventiumHarnessIdempotencyKey = 'cortex-exact';
    req._viventiumHarnessIdempotencyKeys = new Set();
    req._viventiumHarnessCancellationBoundBaseURLs = new Set();
    req._viventiumHarnessCancellationActiveBaseURL = '';
    req._viventiumHarnessCancellationDeliveryPromise = null;
    const controller = new AbortController();
    const parentAbort = () => controller.abort(main.controller.signal.reason);
    if (lifetime === 'active')
      main.controller.signal.addEventListener('abort', parentAbort, { once: true });
    const symbols = Object.getOwnPropertySymbols(main.req);
    expect(symbols).toHaveLength(1);
    const routes = main.req[symbols[0]];
    expect(Object.prototype.hasOwnProperty.call(req, symbols[0])).toBe(false);
    expect(req[symbols[0]]).toBe(routes);
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ capacityReleased: true }),
    }));
    const bind = () =>
      bindHarnessCancellation({
        req,
        signal: controller.signal,
        endpointConfig: { baseURL: 'http://cortex-native.test/v1', apiKey: 'synthetic-cortex-key' },
        fetchImpl,
      });
    const close = () => main.controller.signal.removeEventListener('abort', parentAbort);
    return { req, controller, routes, fetchImpl, bind, close };
  }

  test.each(['active', 'completed'])(
    'restricted Main Stop survives a %s cortex with no selected fallback route',
    async (lifetime) => {
      const s = await subject();
      expect(s.bind()).toBe(true);
      const child = cortexSubject(s, lifetime, true);
      const active = child.routes.active;
      const owner = tasks.getVoiceTask(s.task.taskId).owner;
      const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
        s.controller.abort('user_cancelled');
        return { success: true };
      });
      try {
        expect(child.bind()).toBe(false);
        expect({
          routeCurrent: child.routes.active === active,
          owner: tasks.getVoiceTask(s.task.taskId).owner,
          locallyConfirmable: tasks.canConfirmVoiceTaskCancellation(s.task.taskId),
        }).toEqual({ routeCurrent: true, owner, locallyConfirmable: false });
        await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, { userId: 'owner-readonly' });
        await tasks.flushVoiceTaskOwnerOperations();
        expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_confirmed');
        expect(s.fetchImpl).toHaveBeenCalledTimes(1);
        expect(child.fetchImpl).not.toHaveBeenCalled();
        expect(child.controller.signal.aborted).toBe(lifetime === 'active');
      } finally {
        child.close();
        abort.mockRestore();
      }
    },
  );

  test.each(['active', 'completed'])(
    'restricted Main native Stop survives a %s cortex selecting its unused direct fallback',
    async (lifetime) => {
      const s = await subject();
      expect(s.bind()).toBe(true);
      await prepareRestrictedVoiceCancellation({
        req: s.req,
        signal: s.controller.signal,
        providerId: 'direct',
        fallback: true,
        activate: false,
      });
      const child = cortexSubject(s, lifetime, true);
      const active = child.routes.active;
      const owner = tasks.getVoiceTask(s.task.taskId).owner;
      const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
        s.controller.abort('user_cancelled');
        return { success: true };
      });
      try {
        expect(child.bind()).toBe(false);
        expect({
          routeCurrent: child.routes.active === active,
          owner: tasks.getVoiceTask(s.task.taskId).owner,
          locallyConfirmable: tasks.canConfirmVoiceTaskCancellation(s.task.taskId),
        }).toEqual({ routeCurrent: true, owner, locallyConfirmable: false });
        await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, { userId: 'owner-readonly' });
        await tasks.flushVoiceTaskOwnerOperations();
        expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_confirmed');
        expect(s.fetchImpl).toHaveBeenCalledTimes(1);
        expect(child.fetchImpl).not.toHaveBeenCalled();
        expect(child.controller.signal.aborted).toBe(lifetime === 'active');
      } finally {
        child.close();
        abort.mockRestore();
      }
    },
  );

  test.each(['active', 'completed'])(
    'restricted Main direct Stop capabilities survive a %s cortex selecting its native primary',
    async (lifetime) => {
      const s = await subject();
      expect(s.bind()).toBe(true);
      await prepareRestrictedVoiceCancellation({
        req: s.req,
        signal: s.controller.signal,
        providerId: 'direct',
        fallback: true,
        activate: false,
      });
      s.req._viventiumFallbackLlmAttempt = true;
      expect(s.bind()).toBe(false);
      const child = cortexSubject(s, lifetime, false);
      const active = child.routes.active;
      const owner = tasks.getVoiceTask(s.task.taskId).owner;
      try {
        expect(owner.kind).toBe('generation_job');
        expect(tasks.canConfirmVoiceTaskCancellation(s.task.taskId)).toBe(true);
        expect(child.bind()).toBe(true);
        expect({
          routeCurrent: child.routes.active === active,
          owner: tasks.getVoiceTask(s.task.taskId).owner,
          locallyConfirmable: tasks.canConfirmVoiceTaskCancellation(s.task.taskId),
        }).toEqual({ routeCurrent: true, owner, locallyConfirmable: true });
        s.controller.abort('user_cancelled');
        await new Promise(setImmediate);
        expect(s.fetchImpl).not.toHaveBeenCalled();
        expect(child.fetchImpl).not.toHaveBeenCalled();
        expect(child.controller.signal.aborted).toBe(lifetime === 'active');
      } finally {
        child.close();
      }
    },
  );

  test.each(['native-primary', 'native-fallback'])(
    'owner Stop releases exact tool-less %s family after repeated sanitation',
    async (provider) => {
      const s = await subject(provider);
      expect(s.bind()).toBe(true);
      enforceRestrictedVoiceRequest(s.req);
      enforceRestrictedVoiceRequest(s.req);
      const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
        s.controller.abort('user_cancelled');
        return { success: true };
      });
      try {
        expect(tasks.getVoiceTask(s.task.taskId).owner.kind).toBe('remote_generation');
        expect(tasks.canConfirmVoiceTaskCancellation(s.task.taskId)).toBe(false);
        expect(
          (
            await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, {
              userId: 'owner-readonly',
            })
          ).ownerSupported,
        ).toBe(true);
        await tasks.flushVoiceTaskOwnerOperations();
        expect(s.fetchImpl).toHaveBeenCalledWith(
          `${s.endpointConfig.baseURL}/requests/by-idempotency/response-readonly/cancel`,
          expect.objectContaining({
            headers: {
              Authorization: 'Bearer synthetic-native-key',
              'X-Viventium-User-Id': 'owner-readonly',
            },
          }),
        );
        expect(tasks.getVoiceTask(s.task.taskId).state).toBe('cancelled_confirmed');
        expect(s.req.viventiumVoiceWorkAuthority).toBeUndefined();
        expect(s.req._viventiumHarnessExecutionEnabled).toBe(false);
        expect(s.req._viventiumHarnessIdempotencyKey).toBeUndefined();
        expect(s.sanitized.tools).toEqual([]);
        expect(s.sanitized.agent_ids).toEqual([]);
        expect(s.req._viventiumNativeVoiceInputPolling).toBeUndefined();
      } finally {
        abort.mockRestore();
      }
    },
  );

  test('another request cannot inherit cancellation transport through object spread', async () => {
    const s = await subject();
    expect(s.bind()).toBe(true);
    const copy = { ...s.req };
    expect(Object.getOwnPropertySymbols(copy)).toEqual([]);
    expect(
      [...copy._viventiumHarnessCancellationBoundBaseURLs].every((key) => typeof key === 'symbol'),
    ).toBe(true);
    expect(
      bindHarnessCancellation({
        req: copy,
        signal: s.controller.signal,
        endpointConfig: s.endpointConfig,
      }),
    ).toBe(false);
  });

  test.each([
    'missing call',
    'wrong call owner',
    'wrong task call',
    'wrong stream',
    'direct provider',
    'forged body',
  ])('rejects %s without native or work authority', async (caseName) => {
    const s = await subject();
    if (caseName === 'missing call') delete s.req.viventiumCallSession;
    if (caseName === 'wrong call owner') s.req.viventiumCallSession.userId = 'foreign-owner';
    if (caseName === 'wrong task call') s.req.viventiumCallSession.callSessionId = 'foreign-call';
    if (caseName === 'wrong stream') s.req._resumableStreamId = 'foreign-stream';
    if (caseName === 'direct provider') {
      await prepareRestrictedVoiceCancellation({
        req: s.req,
        signal: s.controller.signal,
        providerId: 'direct',
        endpointConfig: s.endpointConfig,
        activate: false,
      });
    }
    if (caseName === 'forged body') {
      delete s.req.viventiumCallSession;
      s.req.body.nativeCancellationAllowed = true;
    }
    expect(s.bind()).toBe(false);
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });

  test('selected fallback replaces only native cancellation transport', async () => {
    const s = await subject();
    expect(s.bind()).toBe(true);
    await prepareRestrictedVoiceCancellation({
      req: s.req,
      signal: s.controller.signal,
      providerId: 'native-fallback',
      fallback: true,
      activate: false,
      endpointConfig: {
        baseURL: 'http://native-fallback.test/v1',
        apiKey: 'synthetic-fallback-key',
      },
    });
    s.req._viventiumFallbackLlmAttempt = true;
    enforceRestrictedVoiceRequest(s.req);
    expect(s.bind()).toBe(true);
    s.controller.abort('user_cancelled');
    await s.req._viventiumHarnessCancellationDeliveryPromise;
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
    expect(s.fetchImpl.mock.calls[0][0]).toBe(
      'http://native-fallback.test/v1/requests/by-idempotency/response-readonly/cancel',
    );
    expect(s.fetchImpl.mock.calls[0][1].headers.Authorization).toBe(
      'Bearer synthetic-fallback-key',
    );
  });

  test.each(['disconnect', 'attempt_release', 'speaker_stop'])(
    '%s does not cancel a restricted reply',
    async (reason) => {
      const s = await subject();
      expect(s.bind()).toBe(true);
      s.controller.abort(reason);
      expect(s.fetchImpl).not.toHaveBeenCalled();
    },
  );

  test.each(['pending', 'committed'])(
    'already %s native result remains accepted',
    async (nativeResponse) => {
      const s = await subject();
      expect(s.bind()).toBe(true);
      const abort = jest
        .spyOn(GenerationJobManager, 'abortJob')
        .mockResolvedValue({ success: false, nativeResponse });
      try {
        await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, { userId: 'owner-readonly' });
        await tasks.flushVoiceTaskOwnerOperations();
        expect(s.fetchImpl).not.toHaveBeenCalled();
        expect(tasks.getVoiceTask(s.task.taskId).state).not.toBe('cancelled_confirmed');
      } finally {
        abort.mockRestore();
      }
    },
  );

  test('changed stored call owner prevents delivery', async () => {
    const s = await subject();
    expect(s.bind()).toBe(true);
    getCallSession.mockResolvedValue({
      callSessionId: 'call-readonly',
      userId: 'foreign-owner',
      callStatus: 'active',
    });
    const abort = jest.spyOn(GenerationJobManager, 'abortJob');
    try {
      await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, { userId: 'owner-readonly' });
      await tasks.flushVoiceTaskOwnerOperations();
      expect(abort).not.toHaveBeenCalled();
      expect(s.fetchImpl).not.toHaveBeenCalled();
    } finally {
      abort.mockRestore();
    }
  });

  test('missing capacity acknowledgement never confirms a local abort', async () => {
    const s = await subject();
    s.fetchImpl.mockResolvedValue({
      ok: true,
      json: async () => ({ state: 'cancelled', capacityReleased: false }),
    });
    expect(s.bind()).toBe(true);
    const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
      s.controller.abort('user_cancelled');
      return { success: true };
    });
    try {
      await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, { userId: 'owner-readonly' });
      await tasks.flushVoiceTaskOwnerOperations();
      expect(tasks.getVoiceTask(s.task.taskId).state).not.toBe('cancelled_confirmed');
    } finally {
      abort.mockRestore();
    }
  });

  test.each([
    'missing job',
    'wrong job owner',
    'wrong job call',
    'wrong job task',
    'wrong signal',
    'missing endpoint',
  ])('%s leaves a declared native task unconfirmable', async (invalid) => {
    const s = await subject('native-primary', false);
    if (invalid === 'missing job') GenerationJobManager.getJob.mockResolvedValue(null);
    if (invalid === 'wrong job owner') s.job.metadata.userId = 'foreign-owner';
    if (invalid === 'wrong job call') s.job.metadata.viventiumCallSessionId = 'foreign-call';
    if (invalid === 'wrong job task') s.job.metadata.viventiumVoiceTaskId = 'foreign-task';
    if (invalid === 'wrong signal') s.job.abortController = new AbortController();
    expect(
      await prepareRestrictedVoiceCancellation({
        req: s.req,
        signal: s.controller.signal,
        endpointConfig: invalid === 'missing endpoint' ? {} : s.endpointConfig,
        providerId: 'native-primary',
      }),
    ).toBe(false);
    expect(tasks.getVoiceTask(s.task.taskId).owner.kind).toBe('remote_generation');
    expect(tasks.canConfirmVoiceTaskCancellation(s.task.taskId)).toBe(false);
    expect(
      (await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, { userId: 'owner-readonly' }))
        .ownerSupported,
    ).toBe(false);
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });

  test.each(['no authenticated owner', 'missing task'])(
    '%s cannot bind a cancellation grant',
    async (invalid) => {
      const s = await subject('native-primary', false);
      if (invalid === 'no authenticated owner') delete s.req.user;
      if (invalid === 'missing task') delete s.req.body.viventiumVoiceTaskId;
      expect(
        await prepareRestrictedVoiceCancellation({
          req: s.req,
          signal: s.controller.signal,
          endpointConfig: s.endpointConfig,
          providerId: 'native-primary',
        }),
      ).toBe(false);
      expect(s.bind()).toBe(false);
      expect(s.fetchImpl).not.toHaveBeenCalled();
    },
  );

  test('uses the server response identity generated after initialization, never a body key', async () => {
    const s = await subject('native-primary', false);
    delete s.job.metadata.responseMessageId;
    await prepareRestrictedVoiceCancellation({
      req: s.req,
      signal: s.controller.signal,
      endpointConfig: s.endpointConfig,
      providerId: 'native-primary',
      activate: false,
    });
    expect(s.bind()).toBe(true);
    s.req.body.responseMessageId = 'forged-response';
    s.job.metadata.responseMessageId = 'server-response';
    s.controller.abort('user_cancelled');
    await s.req._viventiumHarnessCancellationDeliveryPromise;
    expect(s.fetchImpl.mock.calls[0][0]).toBe(
      'http://native-primary.test/v1/requests/by-idempotency/server-response/cancel',
    );
  });

  test('an absent server response identity cannot confirm Stop', async () => {
    const s = await subject();
    delete s.job.metadata.responseMessageId;
    expect(s.bind()).toBe(true);
    const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
      s.controller.abort('user_cancelled');
      return { success: true };
    });
    await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, { userId: 'owner-readonly' });
    await tasks.flushVoiceTaskOwnerOperations();
    expect(s.fetchImpl).not.toHaveBeenCalled();
    expect(tasks.getVoiceTask(s.task.taskId).state).not.toBe('cancelled_confirmed');
    abort.mockRestore();
  });

  test.each(['createdAt', 'responseMessageId'])(
    'changed %s after local abort cannot cancel another native request',
    async (changed) => {
      const s = await subject();
      expect(s.bind()).toBe(true);
      const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
        if (changed === 'createdAt') s.job.createdAt += 1;
        else s.job.metadata.responseMessageId = 'replacement-response';
        s.controller.abort('user_cancelled');
        return { success: true };
      });
      await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, { userId: 'owner-readonly' });
      await tasks.flushVoiceTaskOwnerOperations();
      expect(s.fetchImpl).not.toHaveBeenCalled();
      expect(tasks.getVoiceTask(s.task.taskId).state).not.toBe('cancelled_confirmed');
      abort.mockRestore();
    },
  );

  test('a changed call owner after native acknowledgement cannot confirm Stop', async () => {
    const s = await subject();
    expect(s.bind()).toBe(true);
    s.fetchImpl.mockImplementation(async () => {
      getCallSession.mockResolvedValue({
        callSessionId: 'call-readonly',
        userId: 'foreign-owner',
        callStatus: 'active',
      });
      return { ok: true, json: async () => ({ capacityReleased: true }) };
    });
    const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
      s.controller.abort('user_cancelled');
      return { success: true };
    });
    await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, { userId: 'owner-readonly' });
    await tasks.flushVoiceTaskOwnerOperations();
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
    expect(tasks.getVoiceTask(s.task.taskId).state).not.toBe('cancelled_confirmed');
    abort.mockRestore();
  });

  test('a direct fallback retains only local Stop and removes the obsolete native adapter', async () => {
    const s = await subject();
    expect(s.bind()).toBe(true);
    await prepareRestrictedVoiceCancellation({
      req: s.req,
      signal: s.controller.signal,
      providerId: 'direct',
      fallback: true,
      activate: false,
    });
    s.req._viventiumFallbackLlmAttempt = true;
    expect(s.bind()).toBe(false);
    expect(tasks.getVoiceTask(s.task.taskId).owner.kind).toBe('generation_job');
    expect(tasks.canConfirmVoiceTaskCancellation(s.task.taskId)).toBe(true);
    expect(
      (await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, { userId: 'owner-readonly' }))
        .ownerSupported,
    ).toBe(false);
    s.controller.abort('user_cancelled');
    expect(s.fetchImpl).not.toHaveBeenCalled();
    expect(s.req._viventiumNativeVoiceInputPolling).toBeUndefined();
  });

  test('repeated binding delivers only one current native cancellation', async () => {
    const s = await subject();
    expect(s.bind()).toBe(true);
    expect(s.bind()).toBe(true);
    s.controller.abort('user_cancelled');
    await s.req._viventiumHarnessCancellationDeliveryPromise;
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('a native rejection cannot confirm Stop', async () => {
    const s = await subject();
    s.fetchImpl.mockResolvedValue({ ok: false, status: 403 });
    expect(s.bind()).toBe(true);
    const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
      s.controller.abort('user_cancelled');
      return { success: true };
    });
    await tasks.requestVoiceTaskOwnerCancellation(s.task.taskId, { userId: 'owner-readonly' });
    await tasks.flushVoiceTaskOwnerOperations();
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
    expect(tasks.getVoiceTask(s.task.taskId).state).not.toBe('cancelled_confirmed');
    abort.mockRestore();
  });
});
