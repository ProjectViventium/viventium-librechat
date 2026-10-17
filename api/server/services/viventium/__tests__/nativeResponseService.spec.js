const mockWakeMission = jest.fn();
jest.mock('../GlassHiveMissionAdjudicationService', () => ({
  wakeGlassHiveMissionAdjudications: (...args) => mockWakeMission(...args),
}));
const mockCommitProjection = jest.fn();
const mockProjectionComplete = jest.fn();
const mockRecover = jest.fn();
const mockAdmit = jest.fn();
const mockRejectUnaccepted = jest.fn();
const mockConfig = jest.fn();
const mockLoadAgent = jest.fn();
const mockPermission = jest.fn();
const mockCreateNativeResponseFetch = jest.fn();
const mockDeliverCortexBatch = jest.fn();
const mockSourceSnapshot = jest.fn();
const mockGetCallSession = jest.fn();
let mockTransactionDepth = 0;
let mockNativeProjection;
const mockModels = {
  ensureNativeResponseIndexes: jest.fn(),
  findUser: jest.fn(),
  getNativeResponse: jest.fn(),
  readHostResponseFinal: jest.fn(),
  acknowledgeHostResponseFinal: jest.fn(),
  nativeResponseSourceMatches: jest.fn(),
  getMessages: jest.fn(),
  getMessage: jest.fn(),
  markNativeResponseReplayStored: jest.fn(),
  mutateAcceptedMainContinuitySources: jest.fn(),
  mutateNativeResponseSources: jest.fn(),
};
const mockJobs = {
  setNativeResponseRecovery: jest.fn(),
  setNativeResponseCancellation: jest.fn(),
  setNativeSourceRecovery: jest.fn(),
  finishNativeResponse: jest.fn(),
  settleNativeResponse: jest.fn(),
  getJob: jest.fn(),
  getJobStore: jest.fn(),
  observeSourceOrder: jest.fn(),
  acknowledgeStreamDelivery: jest.fn(),
  renewNativeDispatchLease: jest.fn(async () => true),
};

jest.mock('@librechat/api', () => ({
  deliverCortexBatchToRunningMain: (...args) => mockDeliverCortexBatch(...args),
  createNativeResponseFetch: (...args) => mockCreateNativeResponseFetch(...args),
  createNativeResponseRecoveryService: (options) => {
    mockNativeProjection = options.projectMessage;
    return {
      recover: mockRecover,
      admit: mockAdmit,
      rejectUnaccepted: mockRejectUnaccepted,
      projectForTransmit: async (_identity, message) => message,
    };
  },
  projectNativeToolEvidence: (_identity, _response, message) => message,
  collectGlassHiveNativeMediaReferences: (...args) =>
    jest.requireActual('@librechat/api').collectGlassHiveNativeMediaReferences(...args),
  renderGlassHiveNativeMediaAttachmentLinks: (...args) =>
    jest.requireActual('@librechat/api').renderGlassHiveNativeMediaAttachmentLinks(...args),
  inspectProviderDeliveryDisposition: (...args) =>
    jest.requireActual('@librechat/api').inspectProviderDeliveryDisposition(...args),
  inspectProviderDeliveryRanges: (...args) =>
    jest.requireActual('@librechat/api').inspectProviderDeliveryRanges(...args),
  resolveEffectiveDeliveryDisposition: (...args) =>
    jest.requireActual('@librechat/api').resolveEffectiveDeliveryDisposition(...args),
  isAcceptedMainProjectionComplete: (...args) => mockProjectionComplete(...args),
  prepareNativeSourceRecovery: (...args) =>
    jest.requireActual('@librechat/api').prepareNativeSourceRecovery(...args),
  GenerationJobManager: mockJobs,
  nativeIdentityJson: (...args) => jest.requireActual('@librechat/api').nativeIdentityJson(...args),
  nativeJobMatches: (...args) => jest.requireActual('@librechat/api').nativeJobMatches(...args),
  sanitizeMessageForTransmit: (message) => message,
  interactionPresentationSequence: (...args) =>
    jest.requireActual('@librechat/api').interactionPresentationSequence(...args),
  isAudioDeliveryRequested: (...args) =>
    jest.requireActual('@librechat/api').isAudioDeliveryRequested(...args),
  supportsMessagingDeliveryDisposition: (...args) =>
    jest.requireActual('@librechat/api').supportsMessagingDeliveryDisposition(...args),
}));
jest.mock('../interactionContext', () => {
  const { getTrustedInteractionContext, setTrustedInteractionContext } =
    jest.requireActual('@librechat/api');
  return { getTrustedInteractionContext, setTrustedInteractionContext };
});
jest.mock('../GlassHiveConversationProviderService', () => ({
  probeHarnessFamilyRelease: jest.fn(),
}));
jest.mock('../CallSessionService', () => ({
  getCallSession: (...args) => mockGetCallSession(...args),
}));
jest.mock('../InteractionDurableEffectService', () => ({
  getSourceRecoverySnapshot: (...args) => mockSourceSnapshot(...args),
}));
jest.mock('~/models', () => mockModels);
jest.mock('~/server/services/Config', () => ({ getAppConfig: (...args) => mockConfig(...args) }));
jest.mock('~/models/Agent', () => ({ loadAgent: (...args) => mockLoadAgent(...args) }));
// Exercise the actual request-time loader without database, cache, project, or action I/O.
jest.mock('~/cache', () => ({ getLogStores: jest.fn(() => null) }));
jest.mock('~/db/models', () => ({}));
jest.mock('~/models/Project', () => ({}));
jest.mock('~/models/Action', () => ({}));
jest.mock('~/server/services/PermissionService', () => ({
  checkPermission: (...args) => mockPermission(...args),
}));
jest.mock('../ViventiumMainContinuityService', () => ({
  commitAcceptedMainTurnFromPresentation: (...args) => mockCommitProjection(...args),
}));
jest.mock('../GlassHiveTerminalCallbackTransaction', () => ({
  runGlassHiveTerminalCallbackTransaction: async (operation) => {
    mockTransactionDepth++;
    try {
      return await operation();
    } finally {
      mockTransactionDepth--;
    }
  },
}));

const {
  getService,
  resolveNativeResponseRoute,
  recoverSavedNativeResponse,
  recoverNativeResponse,
  markNativeResponseReplayStored,
  mutateNativeResponseSources,
} = require('../nativeResponseService');

describe('native authenticated audio projection', () => {
  test.each(['voice', 'telegram'])(
    'retains raw %s public offsets only for authenticated transmit',
    (surface) => {
      getService();
      const text = '<whisper>Public 🟢.</whisper>';
      const part = {
        type: 'text',
        text,
        deliveryDispositionRanges: [{ start: 0, end: text.length }],
      };
      const message = { text, content: [part] };
      const identity = {
        deliveryContext: { surface, authenticated: true, audioRequested: true },
        deliveryDispositionRequired: true,
      };
      expect(mockNativeProjection(identity, {}, message, 'transmit').content[0]).toEqual(part);
      expect(mockNativeProjection(identity, {}, message, 'terminal').content[0]).toEqual({
        type: 'text',
        text: 'Public 🟢.',
      });
      expect(
        mockNativeProjection(
          { ...identity, deliveryContext: { ...identity.deliveryContext, authenticated: false } },
          {},
          message,
          'transmit',
        ).content[0],
      ).not.toHaveProperty('deliveryDispositionRanges');
      if (surface === 'voice') {
        const withPrivate = {
          ...message,
          content: [
            { type: 'think', think: 'Synthetic private block.' },
            part,
            { type: 'reasoning', text: 'Synthetic private block.' },
          ],
        };
        expect(mockNativeProjection(identity, {}, withPrivate, 'transmit').content).toEqual([part]);
      }
    },
  );
});

describe('native canonical per-part audio projection', () => {
  test.each(['voice', 'telegram'])(
    'retains model choices through %s terminal and transmit',
    (surface) => {
      getService();
      const text = 'Quiet 🟢.\n\nSpoken.';
      const boundary = 'Quiet 🟢.'.length;
      const decision = (audio) => ({
        version: 1,
        audio,
        required: true,
        valid: true,
        source: 'model',
      });
      const ranges = [
        { start: 0, end: boundary, disposition: decision('skip') },
        { start: boundary, end: text.length, disposition: decision('eligible') },
      ];
      const response = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: text,
              provider_specific_fields: {
                viventium: {
                  delivery_disposition: decision('skip'),
                  deliveryDispositionRanges: ranges,
                },
              },
            },
          },
        ],
      };
      const message = { text, content: [{ type: 'text', text }] };
      const identity = {
        deliveryContext: { surface, authenticated: true, audioRequested: true },
        deliveryDispositionRequired: true,
      };
      for (const purpose of ['terminal', 'transmit']) {
        const actual = mockNativeProjection(identity, response, message, purpose);
        expect(actual.text).toBe(text);
        expect(actual.content[0].deliveryDispositionRanges).toEqual(ranges);
      }
      const changed = { ...message, content: [{ type: 'text', text: 'Changed.' }] };
      expect(
        mockNativeProjection(identity, response, changed, 'transmit').content[0]
          .deliveryDispositionRanges,
      ).toEqual([]);
    },
  );
});

describe('existing native route authorization reuse', () => {
  const identity = { userId: 'owner', agentId: 'agent_synthetic', providerId: 'native-provider' };
  beforeEach(() => {
    jest.clearAllMocks();
    mockModels.findUser.mockResolvedValue({ _id: 'owner', role: 'USER' });
    mockLoadAgent.mockResolvedValue({ _id: 'agent-record' });
    mockPermission.mockResolvedValue(true);
    mockConfig.mockResolvedValue({
      endpoints: {
        agents: {
          providerCapabilities: {
            'native-provider': { conversation_session: true, workspace_binding: true },
          },
        },
        custom: [
          { name: 'native-provider', baseURL: 'http://127.0.0.1:8766/v1', apiKey: 'synthetic-key' },
        ],
      },
    });
  });
  test('reuses owner-scoped configured provider and existing agent VIEW permission', async () => {
    expect(await resolveNativeResponseRoute(identity)).toEqual({
      baseURL: 'http://127.0.0.1:8766/v1',
      headers: { Authorization: 'Bearer synthetic-key', 'X-Viventium-User-Id': 'owner' },
    });
    expect(mockModels.findUser).toHaveBeenCalledWith({ _id: 'owner' });
    expect(mockPermission).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner', resourceId: 'agent-record' }),
    );
  });
  test('actual ephemeral loader needs the original model parameters and request body', async () => {
    const { loadAgent } = jest.requireActual('~/models/Agent');
    const { encodeEphemeralAgentId, EModelEndpoint } = require('librechat-data-provider');
    const agent_id = encodeEphemeralAgentId({
      endpoint: 'native-provider',
      model: 'synthetic-model',
    });
    const req = { user: { id: 'owner' }, config: await mockConfig() };
    const requestFailure = await loadAgent({ req, agent_id, endpoint: EModelEndpoint.agents }).then(
      () => null,
      (error) => error,
    );
    expect(requestFailure).toBeInstanceOf(TypeError);
    const { OpenAI } = require('openai');
    const client = new OpenAI({
      apiKey: 'synthetic-key',
      baseURL: 'http://native.test/v1',
      maxRetries: 0,
      fetch: async () => {
        throw requestFailure;
      },
    });
    const wrapped = await client.chat.completions
      .create({
        model: 'synthetic-model',
        messages: [{ role: 'user', content: 'Synthetic request.' }],
      })
      .then(
        () => null,
        (error) => error,
      );
    expect(wrapped).toBeInstanceOf(OpenAI.APIConnectionError);
    expect(wrapped.message).toBe('Connection error.');
    expect(wrapped.cause).toBe(requestFailure);
    await expect(
      loadAgent({
        req,
        agent_id,
        endpoint: EModelEndpoint.agents,
        model_parameters: { model: 'synthetic-model' },
      }),
    ).rejects.toThrow('ephemeralAgent');
  });
  test('resolves an ephemeral result route without reconstructing the original agent', async () => {
    const { loadAgent } = jest.requireActual('~/models/Agent');
    const { encodeEphemeralAgentId } = require('librechat-data-provider');
    const agentId = encodeEphemeralAgentId({
      endpoint: 'native-provider',
      model: 'synthetic-model',
    });
    mockLoadAgent.mockImplementation(loadAgent);
    expect(await resolveNativeResponseRoute({ ...identity, agentId })).toEqual({
      baseURL: 'http://127.0.0.1:8766/v1',
      headers: {
        Authorization: 'Bearer synthetic-key',
        'X-Viventium-User-Id': 'owner',
      },
    });
    expect(mockLoadAgent).not.toHaveBeenCalled();
    expect(mockPermission).not.toHaveBeenCalled();
    expect(mockModels.findUser).toHaveBeenCalledWith({ _id: 'owner' });
    expect(mockConfig).toHaveBeenCalledWith({ role: 'USER' });
  });
  test('actual OpenAI fetch resolves ephemeral native transport before dispatch', async () => {
    const { loadAgent } = jest.requireActual('~/models/Agent');
    const { encodeEphemeralAgentId } = require('librechat-data-provider');
    const { OpenAI } = require('openai');
    const agentId = encodeEphemeralAgentId({
      endpoint: 'native-provider',
      model: 'synthetic-model',
    });
    mockLoadAgent.mockImplementation(loadAgent);
    const fetch = jest.fn(async (_url, init) => {
      await resolveNativeResponseRoute({ ...identity, agentId });
      expect(JSON.parse(init.body)).toMatchObject({
        model: 'synthetic-model',
        messages: [{ role: 'user', content: 'Synthetic request.' }],
      });
      return new Response(
        JSON.stringify({
          id: 'synthetic-response',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Synthetic result.' },
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });
    const client = new OpenAI({
      apiKey: 'synthetic-key',
      baseURL: 'http://native.test/v1',
      maxRetries: 0,
      fetch,
    });
    const response = await client.chat.completions.create({
      model: 'synthetic-model',
      messages: [{ role: 'user', content: 'Synthetic request.' }],
    });
    expect(response.choices[0].message.content).toBe('Synthetic result.');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mockLoadAgent).not.toHaveBeenCalled();
    expect(mockPermission).not.toHaveBeenCalled();
  });
  test.each([null, { id: 'agent_synthetic' }])(
    'saved agent missing record or ACL identity stays denied: %p',
    async (agent) => {
      mockLoadAgent.mockResolvedValue(agent);
      await expect(resolveNativeResponseRoute(identity)).rejects.toThrow(
        'native_response_agent_unavailable',
      );
      expect(mockPermission).not.toHaveBeenCalled();
    },
  );
  test.each([undefined, '', null])('missing agent identity stays denied: %p', async (agentId) => {
    mockLoadAgent.mockResolvedValue(null);
    await expect(resolveNativeResponseRoute({ ...identity, agentId })).rejects.toThrow(
      'native_response_agent_unavailable',
    );
    expect(mockPermission).not.toHaveBeenCalled();
  });
  test('administrator retains the existing saved-agent VIEW exemption', async () => {
    const { SystemRoles } = require('librechat-data-provider');
    mockModels.findUser.mockResolvedValue({
      _id: 'owner',
      role: SystemRoles.ADMIN,
    });
    await expect(resolveNativeResponseRoute(identity)).resolves.toMatchObject({
      baseURL: 'http://127.0.0.1:8766/v1',
    });
    expect(mockLoadAgent).toHaveBeenCalledTimes(1);
    expect(mockPermission).not.toHaveBeenCalled();
  });
  test.each(['conversation_session', 'workspace_binding'])(
    'ephemeral route still requires native capability %s',
    async (capability) => {
      const config = await mockConfig();
      config.endpoints.agents.providerCapabilities['native-provider'][capability] = false;
      await expect(
        resolveNativeResponseRoute({
          ...identity,
          agentId: 'ephemeral-synthetic',
        }),
      ).rejects.toThrow('native_response_provider_unavailable');
      expect(mockPermission).not.toHaveBeenCalled();
    },
  );
  test.each(['', '${MISSING_NATIVE_CREDENTIAL}'])(
    'ephemeral route missing or unresolved auth stays denied: %p',
    async (apiKey) => {
      const config = await mockConfig();
      config.endpoints.custom[0].apiKey = apiKey;
      await expect(
        resolveNativeResponseRoute({
          ...identity,
          agentId: 'ephemeral-synthetic',
        }),
      ).rejects.toThrow('native_response_auth_unavailable');
    },
  );
  test('ephemeral route missing owner stays denied before config or loader', async () => {
    mockModels.findUser.mockResolvedValue(null);
    await expect(
      resolveNativeResponseRoute({
        ...identity,
        agentId: 'ephemeral-synthetic',
      }),
    ).rejects.toThrow('native_response_owner_unavailable');
    expect(mockConfig).not.toHaveBeenCalled();
    expect(mockLoadAgent).not.toHaveBeenCalled();
  });
  test('ephemeral route cannot use an unconfigured provider', async () => {
    await expect(
      resolveNativeResponseRoute({
        ...identity,
        agentId: 'ephemeral-synthetic',
        providerId: 'foreign-provider',
      }),
    ).rejects.toThrow('native_response_provider_unavailable');
  });
  test('absent owner never resolves another user route', async () => {
    mockModels.findUser.mockResolvedValue(null);
    await expect(resolveNativeResponseRoute(identity)).rejects.toThrow(
      'native_response_owner_unavailable',
    );
    expect(mockLoadAgent).not.toHaveBeenCalled();
  });
  test('existing denied agent permission remains denied', async () => {
    mockPermission.mockResolvedValue(false);
    await expect(resolveNativeResponseRoute(identity)).rejects.toThrow(
      'native_response_agent_unavailable',
    );
  });
  test('nonconversation provider cannot become artifact transport', async () => {
    await expect(
      resolveNativeResponseRoute({ ...identity, providerId: 'foreign-provider' }),
    ).rejects.toThrow('native_response_provider_unavailable');
  });
  test('missing provider credential stays unavailable', async () => {
    const config = await mockConfig();
    config.endpoints.custom[0].apiKey = '';
    await expect(resolveNativeResponseRoute(identity)).rejects.toThrow(
      'native_response_auth_unavailable',
    );
  });
});

describe('native final presentation handoff', () => {
  const identity = {
    userId: 'owner',
    conversationId: 'conversation',
    responseMessageId: 'answer',
    streamId: 'stream',
    source: { messageId: 'question' },
  };
  const projected = { messageId: 'answer', text: 'Saved answer.', memoryWriteStatus: 'running' };

  beforeEach(() => {
    jest.resetAllMocks();
    mockCommitProjection.mockResolvedValue({ status: 'committed' });
    mockProjectionComplete.mockReturnValue(true);
    mockRecover.mockResolvedValue({ messageId: 'answer', text: 'Saved answer.' });
    mockModels.getMessages.mockResolvedValue([projected]);
    mockModels.getMessage.mockResolvedValue({ messageId: 'question', text: 'Question.' });
    mockModels.markNativeResponseReplayStored.mockResolvedValue(true);
    mockJobs.finishNativeResponse.mockResolvedValue(true);
    mockJobs.settleNativeResponse.mockResolvedValue(true);
    mockJobs.getJob.mockResolvedValue({
      metadata: { deliveryPolicy: { commit_authority: 'adapter' } },
    });
  });

  it('uses the ordinary public Message projection for live and recovered native answers', async () => {
    expect(await recoverSavedNativeResponse(identity)).toEqual(projected);
    expect(mockModels.getMessages).toHaveBeenCalledWith({
      user: 'owner',
      conversationId: 'conversation',
      messageId: 'answer',
    });
    expect(await recoverNativeResponse(identity)).toBe(true);
    expect(mockJobs.finishNativeResponse.mock.calls[0][1].responseMessage).toEqual(projected);
    expect(mockJobs.acknowledgeStreamDelivery).not.toHaveBeenCalled();
  });

  it('does not publish an absent or still-pending saved answer', async () => {
    mockRecover.mockResolvedValue(null);
    expect(await recoverNativeResponse(identity)).toBe(false);
    expect(mockModels.getMessages).not.toHaveBeenCalled();
    expect(mockJobs.finishNativeResponse).not.toHaveBeenCalled();
  });

  it('retains recovery until final replay and its Mongo mark both exist', async () => {
    mockJobs.finishNativeResponse.mockResolvedValue(false);
    expect(await recoverNativeResponse(identity)).toBe(false);
    expect(mockModels.markNativeResponseReplayStored).not.toHaveBeenCalled();
    expect(mockJobs.settleNativeResponse).not.toHaveBeenCalled();
    mockModels.markNativeResponseReplayStored.mockResolvedValue(false);
    expect(await markNativeResponseReplayStored(identity)).toBe(false);
    expect(mockJobs.settleNativeResponse).not.toHaveBeenCalled();
  });

  it('releases retention only after the exact Mongo replay mark succeeds', async () => {
    const order = [];
    mockModels.markNativeResponseReplayStored.mockImplementation(async () => {
      order.push('mongo');
      return true;
    });
    mockJobs.settleNativeResponse.mockImplementation(async () => {
      order.push('settle');
      return true;
    });
    expect(await markNativeResponseReplayStored(identity)).toBe(true);
    expect(order).toEqual(['mongo', 'settle']);
    expect(mockJobs.settleNativeResponse).toHaveBeenCalledWith(identity, undefined);
  });
  it.each(['unavailable', 'context_metadata_missing', 'not_accepted', 'agent_mismatch', 'invalid'])(
    'keeps recovery pending when Main projection returns %s',
    async (status) => {
      mockJobs.getJob.mockResolvedValue({
        metadata: { deliveryPolicy: { commit_authority: 'server' } },
      });
      mockJobs.acknowledgeStreamDelivery.mockResolvedValue({
        status: 'recorded',
        presentation: { responseMessageId: 'answer' },
      });
      mockCommitProjection.mockResolvedValue({ status });
      mockProjectionComplete.mockReturnValue(false);
      expect(await recoverNativeResponse(identity)).toBe(false);
      expect(mockModels.markNativeResponseReplayStored).not.toHaveBeenCalled();
      expect(mockJobs.settleNativeResponse).not.toHaveBeenCalled();
    },
  );

  it.each(['committed', 'already_committed', 'qa_excluded'])(
    'settles explicit projection success %s',
    async (status) => {
      mockJobs.getJob.mockResolvedValue({
        metadata: { deliveryPolicy: { commit_authority: 'server' } },
      });
      mockJobs.acknowledgeStreamDelivery.mockResolvedValue({
        status: 'recorded',
        idempotent: true,
        presentation: { responseMessageId: 'answer' },
      });
      mockCommitProjection.mockResolvedValue({ status });
      expect(await recoverNativeResponse(identity)).toBe(true);
      expect(mockProjectionComplete).toHaveBeenCalledWith({ status });
      expect(mockModels.markNativeResponseReplayStored).toHaveBeenCalledWith(identity);
    },
  );

  it('reports incomplete replay marking without settling or claiming recovery success', async () => {
    mockModels.markNativeResponseReplayStored.mockResolvedValue(false);
    expect(await recoverNativeResponse(identity)).toBe(false);
    expect(mockJobs.settleNativeResponse).not.toHaveBeenCalled();
  });
});

describe('shared source mutation boundary', () => {
  it.each(['edit', 'delete', 'system'])(
    'keeps A1 inside the transaction before B2 and preserves %s',
    async (kind) => {
      const order = [];
      const filter = { user: 'owner', messageId: 'source' };
      mockModels.mutateAcceptedMainContinuitySources.mockImplementation(
        async (scope, operation) => {
          expect(mockTransactionDepth).toBe(1);
          expect(scope).toBe(filter);
          order.push('continuity-before');
          const result = await operation();
          order.push('continuity-after');
          return result;
        },
      );
      mockModels.mutateNativeResponseSources.mockImplementation(
        async (scope, operation, _revoke, _transaction, _retire, selectedKind) => {
          expect(scope).toBe(filter);
          expect(selectedKind).toBe(kind);
          order.push('native');
          return operation();
        },
      );
      expect(
        await mutateNativeResponseSources(
          filter,
          async () => {
            order.push('write');
            return 'saved';
          },
          kind,
        ),
      ).toBe('saved');
      expect(order).toEqual(['continuity-before', 'native', 'write', 'continuity-after']);
    },
  );
  it('defaults unknown older callers to explicit edit authority', async () => {
    mockModels.mutateAcceptedMainContinuitySources.mockImplementation((_scope, operation) =>
      operation(),
    );
    mockModels.mutateNativeResponseSources.mockImplementation(
      (_scope, operation, _revoke, _transaction, _retire, kind) => {
        expect(kind).toBe('edit');
        return operation();
      },
    );
    expect(await mutateNativeResponseSources({ user: 'owner' }, async () => true)).toBe(true);
  });
});

describe('release-gated current revision', () => {
  const { createNativeResponseRelease } = require('../nativeResponseService');
  const context = { streamId: 'stream-c', jobCreatedAt: 3, userId: 'owner-1' };
  const req = {
    user: { id: 'owner-1' },
    config: {
      endpoints: {
        custom: [
          { name: 'glasshive', baseURL: 'http://glasshive.test/v1', apiKey: 'provider-key' },
        ],
      },
    },
  };
  const route = { endpoint: 'glasshive' };
  let job;
  let current;

  beforeEach(() => {
    job = {
      createdAt: 3,
      userId: 'owner-1',
      status: 'running',
      nativeReleaseTargets: ['response-a'],
    };
    current = true;
    mockJobs.renewNativeDispatchLease.mockReset().mockResolvedValue(true);
    mockJobs.getJobStore.mockReturnValue({
      getJob: jest.fn(async () => job),
      isCurrentLogicalTurn: jest.fn(async () => current),
    });
  });

  const pending = { released: false, reachable: true, responseTimeoutS: 660 };
  const releasedEvidence = { released: true, reachable: true, responseTimeoutS: 660 };

  it('waits for every carried predecessor family to release before dispatch', async () => {
    const probe = jest.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(releasedEvidence);
    const sleep = jest.fn(async () => undefined);
    const release = createNativeResponseRelease(req, route, { probe, sleep, now: () => 0 });

    await release.beforeDispatch(context);

    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledWith({
      baseURL: 'http://glasshive.test/v1',
      apiKey: 'provider-key',
      ownerId: 'owner-1',
      messageId: 'response-a',
    });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('dispatches at once when the revision replaced no native operation', async () => {
    job = { ...job, nativeReleaseTargets: undefined };
    const probe = jest.fn();
    const release = createNativeResponseRelease(req, route, {
      probe,
      sleep: jest.fn(),
      now: () => 0,
    });

    await release.beforeDispatch(context);

    expect(probe).not.toHaveBeenCalled();
  });

  it('never dispatches a revision replaced while it waited', async () => {
    const probe = jest.fn(async () => {
      job = { ...job, status: 'superseded' };
      return pending;
    });
    const release = createNativeResponseRelease(req, route, {
      probe,
      sleep: async () => undefined,
      now: () => 0,
    });

    await expect(release.beforeDispatch(context)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps a retained predecessor lease pending past any poll budget until the host deadline', async () => {
    let clock = context.jobCreatedAt;
    const probe = jest.fn(async () => pending);
    const release = createNativeResponseRelease(req, route, {
      probe,
      sleep: async () => {
        clock += 5000;
      },
      now: () => clock,
    });

    await expect(release.beforeDispatch(context)).rejects.toMatchObject({
      code: 'provider_response_deadline_exceeded',
    });
    expect(clock).toBeGreaterThanOrEqual(context.jobCreatedAt + 660_000);
    expect(clock - 5000).toBeLessThan(context.jobCreatedAt + 660_000);
    expect(probe.mock.calls.length).toBeGreaterThan(100);
  });

  it('refuses an unroutable release as the typed occupied condition without asking', async () => {
    const probe = jest.fn();
    const release = createNativeResponseRelease(
      { ...req, config: { endpoints: { custom: [] } } },
      route,
      { probe, sleep: jest.fn(), now: () => 0 },
    );

    await expect(release.beforeDispatch(context)).rejects.toMatchObject({
      code: 'conversation_session_authority_conflict',
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('keeps an unreachable host pending instead of granting dispatch', async () => {
    let probes = 0;
    const probe = jest.fn(async () => {
      probes += 1;
      if (probes === 4) job = { ...job, status: 'superseded' };
      if (probes === 2) throw new Error('synthetic probe failure');
      return { released: false, reachable: false, responseTimeoutS: null };
    });
    const release = createNativeResponseRelease(req, route, {
      probe,
      sleep: async () => undefined,
      // Past any former poll budget, but before a host-reported deadline.
      now: () => context.jobCreatedAt + 30_000,
    });

    await expect(release.beforeDispatch(context)).rejects.toMatchObject({
      name: 'AbortError',
      code: 'superseded',
    });
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it('never dispatches after another generator recovered the revision', async () => {
    const probe = jest.fn(async () => releasedEvidence);
    mockJobs.renewNativeDispatchLease.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const release = createNativeResponseRelease(req, route, {
      probe,
      sleep: async () => undefined,
      now: () => 0,
    });

    await expect(release.beforeDispatch(context)).rejects.toMatchObject({
      name: 'AbortError',
      code: 'superseded',
    });
    expect(mockJobs.renewNativeDispatchLease).toHaveBeenCalledWith('stream-c', 3);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('reports whether the revision still owns its running turn', async () => {
    const release = createNativeResponseRelease(req, route, {
      probe: jest.fn(),
      sleep: jest.fn(),
      now: () => 0,
    });

    await expect(release.isCurrent(context)).resolves.toBe(true);
    current = false;
    await expect(release.isCurrent(context)).resolves.toBe(false);
  });

  it('keeps typed occupancy pending only while the revision stays current', async () => {
    const probe = jest.fn(async () => releasedEvidence);
    const release = createNativeResponseRelease(req, route, {
      probe,
      sleep: async () => undefined,
      now: () => 0,
    });

    await expect(release.whileOccupied(context)).resolves.toBe(true);
    current = false;
    await expect(release.whileOccupied(context)).resolves.toBe(false);
  });
});

describe('native graph participant file identity', () => {
  const { wrapNativeResponseFetch } = require('../nativeResponseService');
  const { setTrustedInteractionContext } = require('../interactionContext');
  const { normalizeNativeOutputFiles } = jest.requireActual('@librechat/api');
  const route = { agentId: 'specialist', endpoint: 'native-provider' };
  const url = 'http://native.test/v1/chat/completions';
  let req;
  let job;
  let current;
  let baseFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      user: { id: 'owner' },
      _resumableStreamId: 'stream',
      _viventiumNativeResponseSource: {
        conversationId: 'conversation',
        responseMessageId: 'answer',
        proof: { messageId: 'question' },
      },
      config: {
        endpoints: {
          agents: {
            providerCapabilities: {
              'native-provider': { conversation_session: true, workspace_binding: true },
            },
          },
        },
      },
    };
    setTrustedInteractionContext(req, {
      actor_kind: 'external_user',
      origin: 'interactive',
      surface: 'voice',
      conversation_id: 'conversation',
      source_event_id: 'event',
      logical_turn_id: 'turn',
      revision: 2,
    });
    job = {
      userId: 'owner',
      streamId: 'stream',
      status: 'running',
      conversationId: 'conversation',
      responseMessageId: 'answer',
      userMessage: { messageId: 'question' },
      interactionContext: { logical_turn_id: 'turn', revision: 2 },
    };
    current = true;
    mockJobs.getJobStore.mockReturnValue({
      getJob: jest.fn(async () => job),
      isCurrentLogicalTurn: jest.fn(async () => current),
    });
    baseFetch = jest.fn(async () => new Response('{}'));
  });

  it.each(['native', 'unknown_route'])(
    'clears the previous refusal before each subsequent Main fetch: %s',
    async (mode) => {
      mockCreateNativeResponseFetch.mockReturnValueOnce(baseFetch);
      if (mode === 'unknown_route') req.config.endpoints.agents.providerCapabilities = {};
      mockJobs.getJob.mockResolvedValue({ createdAt: 1 });
      wrapNativeResponseFetch(req, 'specialist', baseFetch, route);
      const getContext = mockCreateNativeResponseFetch.mock.calls.at(-1)[1];
      for (const invocationId of ['first', 'second']) {
        req._viventiumNativeResponseUnaccepted = { invocationId, terminalErrorConfirmed: true };
        await getContext();
        expect(req._viventiumNativeResponseUnaccepted).toBeUndefined();
      }
      expect(baseFetch).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'marks only an exactly released unaccepted response: %s',
    async (released) => {
      mockRejectUnaccepted.mockReset();
      mockCreateNativeResponseFetch.mockReturnValueOnce(baseFetch);
      wrapNativeResponseFetch(req, 'specialist', baseFetch, route);
      const callback = mockCreateNativeResponseFetch.mock.calls.at(-1)[5];
      const identity = {
        streamId: 'stream',
        userId: 'owner',
        responseMessageId: 'answer',
        jobCreatedAt: 1,
      };
      expect(callback).toEqual(expect.any(Function));
      if (!released)
        mockRejectUnaccepted.mockRejectedValueOnce(
          new Error('native_response_handoff_unavailable'),
        );
      if (released) {
        await callback(identity);
        expect(req._viventiumNativeResponseUnaccepted).toBe(identity);
      } else {
        await expect(callback(identity)).rejects.toThrow('native_response_handoff_unavailable');
        expect(req._viventiumNativeResponseUnaccepted).toBeUndefined();
      }
      expect(mockRejectUnaccepted).toHaveBeenCalledWith(identity);
    },
  );

  function envelope(init) {
    const headers = new Headers(init.headers);
    return {
      version: 1,
      owner_id: 'owner',
      conversation_id: 'conversation',
      message_id: 'answer',
      stream_id: 'stream',
      agent_id: 'specialist',
      logical_turn_id: headers.get('X-Viventium-Logical-Turn-Id') || '',
      logical_turn_revision: Number(headers.get('X-Viventium-Logical-Turn-Revision') || 1),
      request_id: 'request',
      run_id: 'run',
      attempt_id: 'attempt',
      invocation_id: '',
      files: [
        {
          filename: 'result.txt',
          mime_type: 'text/plain',
          bytes: 5,
          sha256: 'a'.repeat(64),
          download_url: 'http://native.test/v1/link-refs/ghr_synthetic12345',
        },
      ],
    };
  }
  const identity = {
    userId: 'owner',
    conversationId: 'conversation',
    responseMessageId: 'answer',
    streamId: 'stream',
    agentId: 'specialist',
    logicalTurnId: 'turn',
    revision: 2,
    requestId: 'request',
    runId: 'run',
    attemptId: 'attempt',
  };

  it('carries the admitted turn to a specialist file without Main ownership wrappers', async () => {
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'Create a file.' }] });
    const init = {
      method: 'POST',
      body,
      headers: {
        Authorization: 'Bearer synthetic',
        'X-GlassHive-Agent-Id': 'specialist',
        'X-GlassHive-Bootstrap-Bundle': 'signed-specialist-capabilities',
        'X-Viventium-Logical-Turn-Id': 'untrusted-turn',
      },
    };
    await wrapNativeResponseFetch(req, 'main', baseFetch, route)(url, init);
    const sent = baseFetch.mock.calls[0][1];
    expect(normalizeNativeOutputFiles(envelope(sent), identity)?.files).toHaveLength(1);
    expect(sent.body).toBe(body);
    const headers = new Headers(sent.headers);
    expect(headers.get('Authorization')).toBe('Bearer synthetic');
    expect(headers.get('X-GlassHive-Agent-Id')).toBe('specialist');
    expect(headers.get('X-GlassHive-Bootstrap-Bundle')).toBe('signed-specialist-capabilities');
    for (const header of [
      'X-Viventium-Native-Invocation-Id',
      'X-Viventium-Native-Body-SHA256',
      'X-Viventium-Main-Context-Protocol',
      'X-Viventium-Visible-Message-Chain-B64',
    ]) {
      expect(headers.has(header)).toBe(false);
    }
    expect(mockCreateNativeResponseFetch).not.toHaveBeenCalled();
    expect(req._viventiumNativeResponseIdentity).toBeUndefined();
  });

  it.each(['web', 'voice', 'telegram'])(
    'carries a direct Main %s turn to a native specialist file',
    async (surface) => {
      delete req._viventiumNativeResponseSource;
      const { getTrustedInteractionContext } = require('../interactionContext');
      setTrustedInteractionContext(req, { ...getTrustedInteractionContext(req), surface });
      req.body = {
        conversationId: 'untrusted-conversation',
        responseMessageId: 'untrusted-answer',
        messageId: 'untrusted-question',
      };
      const body = JSON.stringify({ messages: [{ role: 'user', content: 'Create a file.' }] });
      const init = {
        method: 'POST',
        body,
        headers: {
          'X-GlassHive-Agent-Id': 'specialist',
          'X-GlassHive-Bootstrap-Bundle': 'signed-specialist-capabilities',
        },
      };
      await wrapNativeResponseFetch(req, 'direct-main', baseFetch, route)(url, init);
      const sent = baseFetch.mock.calls[0][1];
      expect(normalizeNativeOutputFiles(envelope(sent), identity)?.files).toHaveLength(1);
      expect(sent.body).toBe(body);
      const headers = new Headers(sent.headers);
      expect(headers.get('X-GlassHive-Agent-Id')).toBe('specialist');
      expect(headers.get('X-GlassHive-Bootstrap-Bundle')).toBe('signed-specialist-capabilities');
      expect(headers.has('X-Viventium-Main-Context-Protocol')).toBe(false);
      expect(headers.has('X-Viventium-Native-Invocation-Id')).toBe(false);
      expect(mockCreateNativeResponseFetch).not.toHaveBeenCalled();
      expect(req._viventiumNativeResponseIdentity).toBeUndefined();
    },
  );

  it.each([
    ['foreign owner', { userId: 'other' }],
    ['wrong turn', { interactionContext: { logical_turn_id: 'other', revision: 2 } }],
    ['stale revision', { interactionContext: { logical_turn_id: 'turn', revision: 1 } }],
    ['foreign conversation', { conversationId: 'other' }],
    ['missing conversation', { conversationId: undefined }],
    ['missing response', { responseMessageId: undefined }],
    ['missing source', { userMessage: undefined }],
    ['wrong stream', { streamId: 'other' }],
    ['missing identity', { interactionContext: undefined }],
    ['completed job', { status: 'completed' }],
  ])('does not dispatch a direct Main participant for %s', async (_name, change) => {
    delete req._viventiumNativeResponseSource;
    job = { ...job, ...change };
    await expect(
      wrapNativeResponseFetch(req, 'direct-main', baseFetch, route)(url, { body: '{}' }),
    ).rejects.toMatchObject({ name: 'AbortError', code: 'superseded' });
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it('rejects a superseded or missing direct Main job', async () => {
    delete req._viventiumNativeResponseSource;
    current = false;
    const wrapped = wrapNativeResponseFetch(req, 'direct-main', baseFetch, route);
    await expect(wrapped(url, { body: '{}' })).rejects.toMatchObject({ code: 'superseded' });
    job = null;
    await expect(wrapped(url, { body: '{}' })).rejects.toMatchObject({ code: 'superseded' });
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it('imports a direct Main participant file through the real generation job constructor', async () => {
    const {
      GenerationJobManager,
      createStreamServices,
      createWebInteractionContext,
      bindLogicalTurnContext,
      getTrustedInteractionContext,
    } = jest.requireActual('@librechat/api');
    GenerationJobManager.configure(createStreamServices({ useRedis: false }));
    await GenerationJobManager.initialize();
    try {
      delete req._viventiumNativeResponseSource;
      setTrustedInteractionContext(
        req,
        createWebInteractionContext({
          conversation_id: 'conversation',
          source_event_id: 'question',
        }),
      );
      const created = await GenerationJobManager.createJob('stream', 'owner', 'conversation', {
        interactionContext: getTrustedInteractionContext(req),
      });
      bindLogicalTurnContext(req, created.metadata.interactionContext);
      bindLogicalTurnContext(
        req,
        await GenerationJobManager.commitLogicalTurnAuthor('stream', 'owner'),
      );
      await GenerationJobManager.updateMetadata('stream', {
        responseMessageId: 'answer',
        userMessage: { messageId: 'question', conversationId: 'conversation' },
      });
      const store = GenerationJobManager.getJobStore();
      mockJobs.getJobStore.mockReturnValue(store);
      const currentContext = getTrustedInteractionContext(req);
      expect((await store.getJob('stream')).interactionContext).toEqual(currentContext);
      await wrapNativeResponseFetch(req, 'direct-main', baseFetch, route)(url, { body: '{}' });
      const carrier = envelope(baseFetch.mock.calls[0][1]);
      expect(
        normalizeNativeOutputFiles(carrier, {
          ...identity,
          logicalTurnId: currentContext.logical_turn_id,
          revision: currentContext.revision,
        })?.files,
      ).toHaveLength(1);
      expect(mockCreateNativeResponseFetch).not.toHaveBeenCalled();
    } finally {
      await GenerationJobManager.destroy();
    }
  });

  it('rejects malformed native Main source rather than replacing it with job identities', async () => {
    req._viventiumNativeResponseSource.proof = undefined;
    await expect(
      wrapNativeResponseFetch(req, 'main', baseFetch, route)(url, { body: '{}' }),
    ).rejects.toMatchObject({ code: 'superseded' });
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['foreign owner', { userId: 'other' }],
    ['wrong turn', { interactionContext: { logical_turn_id: 'other', revision: 2 } }],
    ['wrong revision', { interactionContext: { logical_turn_id: 'turn', revision: 1 } }],
    ['wrong conversation', { conversationId: 'other' }],
    ['wrong message', { responseMessageId: 'other' }],
    ['wrong source', { userMessage: { messageId: 'other' } }],
    ['wrong stream', { streamId: 'other' }],
    ['missing identity', { interactionContext: undefined }],
    ['finished job', { status: 'completed' }],
  ])('does not dispatch a participant for %s', async (_name, change) => {
    job = { ...job, ...change };
    await expect(
      wrapNativeResponseFetch(
        req,
        'main',
        baseFetch,
        route,
      )(url, {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toMatchObject({ name: 'AbortError', code: 'superseded' });
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it('does not dispatch a superseded or missing job', async () => {
    current = false;
    const wrapped = wrapNativeResponseFetch(req, 'main', baseFetch, route);
    await expect(wrapped(url, { body: '{}' })).rejects.toMatchObject({ code: 'superseded' });
    job = null;
    await expect(wrapped(url, { body: '{}' })).rejects.toMatchObject({ code: 'superseded' });
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it('keeps unbound, non-native and non-completion requests unchanged', async () => {
    const init = { headers: { 'X-Synthetic': 'unchanged' }, body: '{}' };
    await wrapNativeResponseFetch({}, 'main', baseFetch, route)(url, init);
    await wrapNativeResponseFetch(req, 'main', baseFetch, {
      ...route,
      endpoint: 'non-native',
    })(url, init);
    await wrapNativeResponseFetch(
      req,
      'main',
      baseFetch,
      route,
    )('http://native.test/v1/models', init);
    expect(baseFetch.mock.calls.map((call) => call[1])).toEqual([init, init, init]);
  });

  it.each(['web', 'voice', 'telegram'])(
    'retains the shared turn on the %s surface',
    async (surface) => {
      req = { ...req };
      setTrustedInteractionContext(req, {
        actor_kind: 'external_user',
        origin: 'interactive',
        surface,
        conversation_id: 'conversation',
        source_event_id: 'event',
        logical_turn_id: 'turn',
        revision: 2,
      });
      await wrapNativeResponseFetch(req, 'main', baseFetch, route)(url, { body: '{}' });
      expect(
        normalizeNativeOutputFiles(envelope(baseFetch.mock.calls[0][1]), identity)?.files,
      ).toHaveLength(1);
    },
  );

  it.each([
    ['worker', 'callback'],
    ['scheduler', 'scheduler'],
    ['system', 'internal'],
  ])('does not project an internal %s/%s turn', async (actor_kind, origin) => {
    req = { ...req };
    setTrustedInteractionContext(req, {
      actor_kind,
      origin,
      surface: 'workbench',
      conversation_id: 'conversation',
      source_event_id: 'event',
      logical_turn_id: 'turn',
      revision: 2,
    });
    const init = { body: '{}' };
    await wrapNativeResponseFetch(req, 'main', baseFetch, route)(url, init);
    expect(baseFetch.mock.calls[0][1]).toBe(init);
  });

  it('ignores a forged request context and retains strict artifact owner/turn rejection', async () => {
    const forged = {
      ...req,
      _viventiumInteractionContext: {
        logical_turn_id: 'turn',
        revision: 2,
        origin: 'interactive',
        actor_kind: 'external_user',
      },
    };
    const init = { body: '{}' };
    await wrapNativeResponseFetch(forged, 'main', baseFetch, route)(url, init);
    expect(baseFetch.mock.calls[0][1]).toBe(init);
    await wrapNativeResponseFetch(req, 'main', baseFetch, route)(url, init);
    const carrier = envelope(baseFetch.mock.calls[1][1]);
    for (const change of [
      { owner_id: 'other' },
      { logical_turn_id: 'other' },
      { logical_turn_id: '' },
      { agent_id: 'main' },
      { run_id: 'other' },
    ]) {
      expect(() => normalizeNativeOutputFiles({ ...carrier, ...change }, identity)).toThrow(
        'native_output_files_identity_invalid',
      );
    }
    expect(() => normalizeNativeOutputFiles(undefined, identity)).not.toThrow();
    expect(normalizeNativeOutputFiles(undefined, identity)).toBeUndefined();
  });

  it('preserves Request headers and the exact body while supplying only turn metadata', async () => {
    const request = new Request(url, {
      method: 'POST',
      body: '{}',
      headers: {
        Authorization: 'Bearer synthetic',
        'X-GlassHive-Agent-Id': 'specialist',
      },
    });
    await wrapNativeResponseFetch(
      req,
      'main',
      baseFetch,
      route,
    )(request, {
      headers: { 'X-Synthetic': 'extra' },
    });
    const [sentRequest, sent] = baseFetch.mock.calls[0];
    expect(sentRequest).toBe(request);
    expect(await sentRequest.clone().text()).toBe('{}');
    expect(new Headers(sent.headers).get('Authorization')).toBe('Bearer synthetic');
    expect(new Headers(sent.headers).get('X-Synthetic')).toBe('extra');
    expect(new Headers(sent.headers).get('X-Viventium-Logical-Turn-Id')).toBe('turn');
  });
});

/* === VIVENTIUM START === Production installation uses the existing exact release before facts. === */
describe('installed native source recovery', () => {
  test('authenticates the predecessor route and queries source outcomes after the real release gate', async () => {
    const now = Date.now();
    const previous = {
      streamId: 'prior-source',
      createdAt: now - 1,
      userId: 'owner',
      conversationId: 'chat',
      status: 'superseded',
      responseMessageId: 'prior-response',
      nativeResponseCancelled: true,
      adapterCapabilities: { supersede_scope: 'response_only' },
      interactionContext: { logical_turn_id: 'turn', revision: 1, source_event_id: 'S1' },
      nativeResponse: {
        userId: 'owner',
        agentId: 'agent_synthetic',
        providerId: 'native-provider',
        responseMessageId: 'prior-response',
        invocationId: 'prior-invocation',
        logicalTurnId: 'turn',
        revision: 1,
      },
      nativeAcceptedSources: {
        invocationId: 'prior-invocation',
        sources: [{ id: 'S1', sha256: 'a'.repeat(64) }],
      },
      deliveryAcknowledgement: { logical_turn_id: 'turn', revision: 1, state: 'partial_removed' },
    };
    const current = {
      streamId: 'current-source',
      createdAt: now,
      userId: 'owner',
      conversationId: 'chat',
      status: 'running',
      adapterCapabilities: { supersede_scope: 'response_only' },
      nativePredecessor: {
        streamId: previous.streamId,
        createdAt: previous.createdAt,
        responseMessageId: 'prior-response',
        invocationId: 'prior-invocation',
      },
      nativeReleaseTargets: ['prior-response'],
      interactionContext: {
        logical_turn_id: 'turn',
        revision: 2,
        source_event_id: 'S2',
        source_segments: [{ source_event_id: 'S1' }, { source_event_id: 'S2' }],
      },
    };
    const events = [];
    const { probeHarnessFamilyRelease } = require('../GlassHiveConversationProviderService');
    probeHarnessFamilyRelease.mockReset().mockImplementation(async () => {
      events.push('released');
      return { released: true, responseTimeoutS: 660 };
    });
    mockModels.findUser.mockResolvedValue({ _id: 'owner', role: 'USER' });
    mockLoadAgent.mockResolvedValue({ _id: 'agent-record' });
    mockPermission.mockResolvedValue(true);
    mockConfig.mockResolvedValue({
      endpoints: {
        agents: {
          providerCapabilities: {
            'native-provider': { conversation_session: true, workspace_binding: true },
          },
        },
        custom: [
          { name: 'native-provider', baseURL: 'http://native.test/v1', apiKey: 'synthetic-key' },
        ],
      },
    });
    mockJobs.renewNativeDispatchLease.mockResolvedValue(true);
    mockJobs.getJobStore.mockReturnValue({
      getJob: jest.fn(async (id) => (id === current.streamId ? current : previous)),
      isNativeResponseUnboundCancelled: jest.fn(async () => false),
      isCurrentLogicalTurn: jest.fn(async () => true),
    });
    const facts = { effects: [], work: [] };
    mockSourceSnapshot.mockReset().mockImplementation(async () => {
      events.push('facts');
      return { facts, pending: false };
    });
    await require('../nativeResponseService').installNativeResponseRecovery();
    const recovery = mockJobs.setNativeSourceRecovery.mock.calls.at(-1)[0];
    await expect(recovery(current, previous)).resolves.toEqual(facts);
    expect(events).toEqual(['released', 'facts']);
    expect(probeHarnessFamilyRelease).toHaveBeenCalledWith({
      baseURL: 'http://native.test/v1',
      apiKey: 'synthetic-key',
      ownerId: 'owner',
      messageId: 'prior-response',
    });
    expect(mockSourceSnapshot).toHaveBeenCalledWith({
      ownerId: 'owner',
      conversationId: 'chat',
      logicalTurnId: 'turn',
      sourceEventIds: ['S1', 'S2'],
    });
    probeHarnessFamilyRelease.mockClear();
    mockJobs.getJobStore.mockReturnValue({
      getJob: jest.fn(async (id) =>
        id === current.streamId ? { ...current, userId: 'other' } : previous,
      ),
      isCurrentLogicalTurn: jest.fn(async () => true),
    });
    await expect(recovery(current, previous)).rejects.toMatchObject({
      name: 'AbortError',
      code: 'superseded',
    });
    expect(probeHarnessFamilyRelease).not.toHaveBeenCalled();
    expect(mockSourceSnapshot).toHaveBeenCalledTimes(1);
    const voiceCurrent = {
      ...current,
      viventiumCallSessionId: 'owning-call',
      interactionContext: { ...current.interactionContext, surface: 'voice' },
    };
    mockJobs.getJobStore.mockReturnValue({
      getJob: jest.fn(async (id) => (id === current.streamId ? voiceCurrent : previous)),
      isNativeResponseUnboundCancelled: jest.fn(async () => false),
      isCurrentLogicalTurn: jest.fn(async () => true),
    });
    for (const status of ['ended', 'failed']) {
      mockGetCallSession.mockResolvedValue({
        callSessionId: 'owning-call',
        userId: 'owner',
        conversationId: 'chat',
        status,
      });
      await expect(recovery(voiceCurrent, previous)).rejects.toMatchObject({
        code: 'native_source_delivery_terminal',
      });
    }
    expect(probeHarnessFamilyRelease).not.toHaveBeenCalled();
    expect(mockSourceSnapshot).toHaveBeenCalledTimes(1);
  });
});
/* === VIVENTIUM END === */

describe('current Main immutable background source read for later graph dispatch', () => {
  const previousReviewedPin = process.env.WPR_GROK_REVIEWED_BINARY_SHA256;
  const { readCurrentMainBackgroundInputs } = require('../nativeResponseService');
  const { setTrustedInteractionContext } = require('../interactionContext');
  const crypto = require('crypto');
  const text = 'Completed exact synthetic cohort evidence.';
  const input = {
    version: 1,
    invocationId: 'invocation',
    deliveryId: 'd'.repeat(64),
    text,
    textSha256: crypto.createHash('sha256').update(text).digest('hex'),
    sources: [{ cortexId: 'cortex', insightSha256: 'e'.repeat(64) }],
  };
  let req, row, identity, job, current, store;
  beforeEach(() => {
    jest.clearAllMocks();
    current = true;
    process.env.WPR_GROK_REVIEWED_BINARY_SHA256 = 'a'.repeat(64);
    identity = {
      userId: 'owner',
      conversationId: 'conversation',
      responseMessageId: 'answer',
      streamId: 'stream',
      jobCreatedAt: 1,
      logicalTurnId: 'turn',
      revision: 2,
      sourceOrderScope: 'a'.repeat(64),
      sourceSequence: 4,
      invocationId: 'invocation',
      bodySha256: 'b'.repeat(64),
      originSha256: 'c'.repeat(64),
      providerId: 'native',
      agentId: 'main',
      admittedAt: 2,
      recoverUntil: 3,
      source: { id: 'source-row', messageId: 'question', digest: 'f'.repeat(64) },
    };
    req = {
      user: { id: 'owner' },
      _resumableStreamId: 'stream',
      _viventiumGraphHandoffStarted: true,
      _viventiumNativeResponseIdentity: identity,
      _viventiumNativeResponseSource: {
        conversationId: 'conversation',
        responseMessageId: 'answer',
        proof: identity.source,
      },
    };
    setTrustedInteractionContext(req, {
      actor_kind: 'external_user',
      origin: 'interactive',
      surface: 'voice',
      conversation_id: 'conversation',
      source_event_id: 'event',
      logical_turn_id: 'turn',
      revision: 2,
      source_order_scope: identity.sourceOrderScope,
      source_sequence: 4,
    });
    job = {
      userId: 'owner',
      streamId: 'stream',
      createdAt: 1,
      status: 'running',
      conversationId: 'conversation',
      responseMessageId: 'answer',
      userMessage: { messageId: 'question' },
      interactionContext: {
        logical_turn_id: 'turn',
        revision: 2,
        source_order_scope: identity.sourceOrderScope,
        source_sequence: 4,
      },
      nativeResponse: identity,
      nativeResponseSettled: true,
      nativeResponseCancelled: false,
    };
    row = {
      user: 'owner',
      conversationId: 'conversation',
      messageId: 'answer',
      parentMessageId: 'question',
      isCreatedByUser: false,
      unfinished: true,
      nativeResponse: { ...identity, status: 'unsupported' },
      metadata: {
        viventium: {
          backgroundInputs: [input],
          backgroundInputReceipts: [
            { status: 'unavailable', deliveryId: input.deliveryId, textSha256: input.textSha256 },
          ],
        },
      },
    };
    store = {
      getJob: jest.fn(async () => job),
      isCurrentLogicalTurn: jest.fn(async () => current),
    };
    mockJobs.getJobStore.mockReturnValue(store);
    mockJobs.observeSourceOrder.mockResolvedValue({ stale: false, latest_source_sequence: 4 });
    mockModels.getNativeResponse.mockImplementation(async () => row);
    mockModels.nativeResponseSourceMatches.mockResolvedValue(true);
  });
  afterEach(() => {
    if (previousReviewedPin === undefined) delete process.env.WPR_GROK_REVIEWED_BINARY_SHA256;
    else process.env.WPR_GROK_REVIEWED_BINARY_SHA256 = previousReviewedPin;
  });
  test.each([undefined, 'invalid'])(
    'retains accepted background facts without a host artifact pin: %s',
    async (pin) => {
      if (pin === undefined) delete process.env.WPR_GROK_REVIEWED_BINARY_SHA256;
      else process.env.WPR_GROK_REVIEWED_BINARY_SHA256 = pin;
      const preimage = JSON.stringify(row);
      expect(await readCurrentMainBackgroundInputs(req, 'main')).toEqual([input]);
      expect(mockModels.getNativeResponse).toHaveBeenCalledWith('owner', 'answer');
      expect(mockModels.nativeResponseSourceMatches).toHaveBeenCalledWith(identity);
      expect(store.isCurrentLogicalTurn).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(row)).toBe(preimage);
    },
  );
  test.each(['web', 'voice', 'telegram'])(
    'retains exact offered source after native handoff on %s',
    async (surface) => {
      setTrustedInteractionContext(req, {
        actor_kind: 'external_user',
        origin: 'interactive',
        surface,
        conversation_id: 'conversation',
        source_event_id: 'event',
        logical_turn_id: 'turn',
        revision: 2,
        source_order_scope: identity.sourceOrderScope,
        source_sequence: 4,
      });
      const preimage = JSON.stringify(row);
      expect(await readCurrentMainBackgroundInputs(req, 'main')).toEqual([input]);
      expect(mockModels.getNativeResponse).toHaveBeenCalledWith('owner', 'answer');
      expect(mockModels.nativeResponseSourceMatches).toHaveBeenCalledWith(identity);
      expect(JSON.stringify(row)).toBe(preimage);
    },
  );
  test.each(['pending', 'released'])(
    'matches the real host handoff ownership state: %s',
    async (mode) => {
      if (mode === 'pending') {
        row.nativeResponse.status = 'pending';
        job.nativeResponseSettled = false;
      } else {
        row.unfinished = false;
        row.error = true;
        delete job.nativeResponse;
        delete job.nativeResponseCancelled;
        job.nativeResponseSettled = false;
      }
      expect(await readCurrentMainBackgroundInputs(req, 'main')).toEqual([input]);
    },
  );
  test('reads exact released source for a current fallback without a graph handoff flag', async () => {
    req._viventiumGraphHandoffStarted = false;
    req._viventiumFallbackLlmAttempt = true;
    delete job.nativeResponse;
    delete job.nativeResponseCancelled;
    expect(await readCurrentMainBackgroundInputs(req, 'main')).toEqual([input]);
  });
  test('first unbound dispatch reads no background source', async () => {
    delete req._viventiumNativeResponseIdentity;
    expect(await readCurrentMainBackgroundInputs(req, 'main')).toEqual([]);
    expect(mockModels.getNativeResponse).not.toHaveBeenCalled();
  });
  test.each([
    'user',
    'conversation',
    'parent',
    'invocation',
    'cancelled',
    'pending_error',
    'invalid_hash',
    'foreign_input',
    'finished',
    'source_changed',
  ])('refuses another or invalid source: %s', async (mode) => {
    if (mode === 'user') row.user = 'other';
    if (mode === 'conversation') row.conversationId = 'other';
    if (mode === 'parent') row.parentMessageId = 'other';
    if (mode === 'invocation') row.nativeResponse.invocationId = 'other';
    if (mode === 'cancelled') row.nativeResponse.status = 'cancelled';
    if (mode === 'pending_error') {
      row.nativeResponse.status = 'pending';
      row.error = true;
    }
    if (mode === 'invalid_hash')
      row.metadata.viventium.backgroundInputs[0] = { ...input, textSha256: '0'.repeat(64) };
    if (mode === 'foreign_input')
      row.metadata.viventium.backgroundInputs[0] = { ...input, invocationId: 'other' };
    if (mode === 'finished') job.generationCompleted = true;
    if (mode === 'source_changed') mockModels.nativeResponseSourceMatches.mockResolvedValue(false);
    await expect(readCurrentMainBackgroundInputs(req, 'main')).rejects.toThrow();
  });
  test.each(['logical_owner', 'sequence', 'stop', 'incarnation', 'identity'])(
    'refuses ownership moving during canonical source read: %s',
    async (mode) => {
      mockModels.nativeResponseSourceMatches.mockImplementation(async () => {
        if (mode === 'logical_owner') current = false;
        if (mode === 'sequence')
          mockJobs.observeSourceOrder.mockResolvedValue({
            stale: false,
            latest_source_sequence: 5,
          });
        if (mode === 'stop') job.nativeResponseCancelled = true;
        if (mode === 'incarnation') job.createdAt = 9;
        if (mode === 'identity') job.nativeResponse = { ...identity, invocationId: 'other' };
        return true;
      });
      await expect(readCurrentMainBackgroundInputs(req, 'main')).rejects.toMatchObject({
        code: 'superseded',
      });
    },
  );
});

describe('terminal mission current Native Main courier', () => {
  const native = require('../nativeResponseService');
  let identity, row, job, store, offer;
  const insights = [
    {
      cortexName: 'Mission evidence',
      insight: 'The owner declined this inspection.',
      authority: { kind: 'durable_terminal_callback', runId: 'child-run' },
    },
  ];
  const input = {
    ownerId: 'owner',
    conversationId: 'conversation',
    mainAgentId: 'main',
    currentLeafMessageId: 'answer',
    messages: [
      { messageId: 'answer', parentMessageId: 'question', isCreatedByUser: false },
      { messageId: 'question', isCreatedByUser: true },
    ],
    insights,
  };
  beforeEach(() => {
    jest.clearAllMocks();
    identity = {
      userId: 'owner',
      conversationId: 'conversation',
      responseMessageId: 'answer',
      streamId: 'stream',
      jobCreatedAt: 1,
      logicalTurnId: 'turn',
      revision: 2,
      sourceOrderScope: 'a'.repeat(64),
      sourceSequence: 4,
      invocationId: 'invocation',
      bodySha256: 'b'.repeat(64),
      originSha256: 'c'.repeat(64),
      providerId: 'native',
      agentId: 'main',
      admittedAt: 2,
      recoverUntil: 3,
      source: { id: 'source-row', messageId: 'question', digest: 'f'.repeat(64) },
    };
    row = {
      user: 'owner',
      conversationId: 'conversation',
      messageId: 'answer',
      parentMessageId: 'question',
      isCreatedByUser: false,
      unfinished: true,
      nativeResponse: { ...identity, status: 'pending' },
    };
    job = {
      userId: 'owner',
      streamId: 'stream',
      createdAt: 1,
      status: 'running',
      conversationId: 'conversation',
      responseMessageId: 'answer',
      userMessage: { messageId: 'question' },
      interactionContext: {
        logical_turn_id: 'turn',
        revision: 2,
        source_order_scope: identity.sourceOrderScope,
        source_sequence: 4,
      },
      nativeResponse: identity,
    };
    store = { getJob: jest.fn(async () => job), isCurrentLogicalTurn: jest.fn(async () => true) };
    mockJobs.getJobStore.mockReturnValue(store);
    mockJobs.observeSourceOrder.mockResolvedValue({ stale: false, latest_source_sequence: 4 });
    mockModels.getNativeResponse.mockImplementation(async () => row);
    mockModels.nativeResponseSourceMatches.mockResolvedValue(true);
    offer = jest
      .spyOn(native, 'deliverCompletedCortexBatchToRunningMain')
      .mockResolvedValue({ status: 'queued', deliveryId: 'd'.repeat(64) });
  });
  afterEach(() => offer.mockRestore());
  test('offers exact evidence through Native and defers without claiming consumption', async () => {
    expect(await native.offerMissionEvidenceToCurrentMain(input)).toBe(true);
    expect(offer).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner',
        conversationId: 'conversation',
        parentMessageId: 'answer',
        streamId: 'stream',
        insights,
        context: JSON.stringify({ terminal_evidence: insights }),
      }),
      expect.any(Function),
    );
    expect(row.unfinished).toBe(true);
  });
  test.each([false, true])(
    'nonterminal and mixed evidence preserve honest accepted-work metadata (%s)',
    async (mixed) => {
      const attention = {
        cortexName: 'Accepted mission',
        insight: 'An authorization renewal is needed.',
        authority: {
          kind: 'durable_work_callback',
          runId: 'child-run',
          event: 'run.needs_input',
          workState: 'needs_input',
        },
      };
      const accepted = mixed ? [insights[0], attention] : [attention];
      expect(await native.offerMissionEvidenceToCurrentMain({ ...input, insights: accepted })).toBe(
        true,
      );
      expect(offer).toHaveBeenCalledWith(
        expect.objectContaining({
          insights: accepted,
          context: JSON.stringify({ accepted_work_evidence: accepted }),
        }),
        expect.any(Function),
      );
      expect(attention.authority).not.toHaveProperty('resultKey');
      expect(attention.authority.kind).toBe('durable_work_callback');
    },
  );
  test('provider terminal before committed Main reply still defers', async () => {
    row.nativeResponse.status = 'completed';
    expect(await native.offerMissionEvidenceToCurrentMain(input)).toBe(true);
    expect(offer).toHaveBeenCalledTimes(1);
  });
  test.each([
    'failed',
    'cancelled',
    'replayed',
    'no_job',
    'superseded',
    'generation_complete',
    'wrong_owner',
    'wrong_conversation',
    'wrong_invocation',
    'not_current',
    'stale_order',
    'user_leaf',
    'no_native_binding',
    'unsupported_admission',
  ])('does not hold or steer an ineligible Main: %s', async (mode) => {
    if (['failed', 'cancelled'].includes(mode)) row.nativeResponse.status = mode;
    if (mode === 'replayed') row.nativeResponse.finalReplayStoredAt = 10;
    if (mode === 'no_job') job = null;
    if (mode === 'no_native_binding') delete job.nativeResponse;
    if (mode === 'unsupported_admission') row.nativeResponse.status = 'unsupported';
    if (mode === 'superseded') job.status = 'superseded';
    if (mode === 'generation_complete') job.generationCompleted = true;
    if (mode === 'wrong_owner') row.nativeResponse.userId = 'foreign';
    if (mode === 'wrong_conversation') row.conversationId = 'foreign';
    if (mode === 'wrong_invocation') job.nativeResponse = { ...identity, invocationId: 'foreign' };
    if (mode === 'not_current') store.isCurrentLogicalTurn.mockResolvedValue(false);
    if (mode === 'stale_order') mockJobs.observeSourceOrder.mockResolvedValue({ stale: true });
    expect(
      await native.offerMissionEvidenceToCurrentMain(
        mode === 'user_leaf'
          ? {
              ...input,
              currentLeafMessageId: 'question',
            }
          : input,
      ),
    ).toBe(false);
    expect(offer).not.toHaveBeenCalled();
  });
  test('post-release readiness checks the exact author once without another native offer', async () => {
    let recheck;
    expect(
      await native.offerMissionEvidenceToCurrentMain({
        ...input,
        onPending: (check) => {
          recheck = check;
        },
      }),
    ).toBe(true);
    expect(await recheck()).toBe(false);
    row.nativeResponse.finalReplayStoredAt = 10;
    expect(await recheck()).toBe(true);
    expect(offer).toHaveBeenCalledTimes(1);
  });
  test('completion during Native offer releases to after-Main relevance', async () => {
    offer.mockImplementation(async () => {
      row.nativeResponse.finalReplayStoredAt = 10;
      return { status: 'queued' };
    });
    expect(await native.offerMissionEvidenceToCurrentMain(input)).toBe(false);
  });
  test('changed canonical source retains evidence through existing failure recovery', async () => {
    mockModels.nativeResponseSourceMatches.mockResolvedValue(false);
    await expect(native.offerMissionEvidenceToCurrentMain(input)).rejects.toThrow(
      'mission_current_main_source_unavailable',
    );
    expect(offer).not.toHaveBeenCalled();
  });
  test('canonical replay wakes only after exact Mongo commit and job settlement', async () => {
    const order = [];
    mockModels.markNativeResponseReplayStored.mockImplementation(async () => {
      order.push('mongo');
      return true;
    });
    mockJobs.settleNativeResponse.mockImplementation(async () => {
      order.push('settle');
      return true;
    });
    mockWakeMission.mockImplementation(() => order.push('wake'));
    expect(await native.markNativeResponseReplayStored(identity)).toBe(true);
    expect(order).toEqual(['mongo', 'settle', 'wake']);
    expect(mockWakeMission).toHaveBeenCalledWith({
      ownerId: 'owner',
      conversationId: 'conversation',
    });
    mockWakeMission.mockClear();
    mockJobs.settleNativeResponse.mockResolvedValue(false);
    expect(await native.markNativeResponseReplayStored(identity)).toBe(false);
    expect(mockWakeMission).not.toHaveBeenCalled();
  });
});

describe('native background courier capability ownership', () => {
  test.each([undefined, 'invalid'])(
    'forwards typed unsupported without a host artifact pin: %s',
    async (pin) => {
      const previousPin = process.env.WPR_GROK_REVIEWED_BINARY_SHA256;
      try {
        if (pin === undefined) delete process.env.WPR_GROK_REVIEWED_BINARY_SHA256;
        else process.env.WPR_GROK_REVIEWED_BINARY_SHA256 = pin;
        const input = {
          ownerId: 'owner',
          conversationId: 'conversation',
          mainAgentId: 'main',
          currentLeafMessageId: 'answer',
          insights: [],
        };
        const isEligible = jest.fn(async () => true);
        const unsupported = { status: 'unsupported', deliveryId: 'd'.repeat(64) };
        mockDeliverCortexBatch.mockReset().mockResolvedValue(unsupported);
        const result =
          await require('../nativeResponseService').deliverCompletedCortexBatchToRunningMain(
            input,
            isEligible,
          );
        expect(mockDeliverCortexBatch).toHaveBeenCalledWith(
          input,
          expect.objectContaining({
            liveContextEnabled: true,
            isEligible,
            getJob: expect.any(Function),
            readAdmission: expect.any(Function),
            resolveRoute: expect.any(Function),
            isCurrentLogicalTurn: expect.any(Function),
            observeSourceOrder: expect.any(Function),
            prepareInput: expect.any(Function),
            recordInputReceipt: expect.any(Function),
          }),
        );
        expect(result).toBe(unsupported);
        expect(result).not.toHaveProperty('consumed');
      } finally {
        if (previousPin === undefined) delete process.env.WPR_GROK_REVIEWED_BINARY_SHA256;
        else process.env.WPR_GROK_REVIEWED_BINARY_SHA256 = previousPin;
      }
    },
  );
});

describe('ordinary native Main selected File presentation', () => {
  const original = 'https://artifacts.example.test/v1/link-refs/ghr_original12345678';
  const download = 'https://artifacts.example.test/v1/link-refs/ghr_download12345678';
  const file = {
    user: 'owner',
    file_id: 'native_' + 'a'.repeat(64),
    filename: 'Capture.jpg',
    filepath: '/uploads/owner/capture.jpg',
    type: 'image/jpeg',
    bytes: 12,
    source: 'local',
    object: 'file',
    nativeOutputFile: {
      version: 1,
      status: 'available',
      messageId: 'answer',
      downloadUrl: download,
      selectedReferences: [original],
    },
  };
  test.each(['persist', 'transmit'])(
    'projects only exact imported aliases and hides Web controls at %s',
    (purpose) => {
      getService();
      const identity = {
        userId: 'owner',
        responseMessageId: 'answer',
        deliveryContext: { surface: 'web' },
      };
      const text = `![Capture](${original})\n[Source](https://docs.example.test)\n{SKIP_VOICE}`;
      const message = { text, content: [{ type: 'text', text }], attachments: [file] };
      const actual = mockNativeProjection(identity, {}, message, purpose);
      expect(actual.text).toBe(`![Capture](${download})\n[Source](https://docs.example.test)`);
      expect(actual.content[0].text).toBe(actual.text);
      expect(message.text).toBe(text);
      expect(file.nativeOutputFile.selectedReferences).toEqual([original]);
      const foreign = mockNativeProjection({ ...identity, userId: 'other' }, {}, message, purpose);
      expect(foreign.text).toContain(original);
    },
  );
  test('selected-alias projection preserves model-owned audio clause boundaries', () => {
    getService();
    const quiet = `![Capture](${original})`;
    const text = quiet + '\n\nSummary.';
    const choice = (audio) => ({ version: 1, audio, required: true, valid: true, source: 'model' });
    const response = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: text,
            provider_specific_fields: {
              viventium: {
                delivery_disposition: choice('eligible'),
                deliveryDispositionRanges: [
                  { start: 0, end: quiet.length, disposition: choice('skip') },
                  { start: quiet.length, end: text.length, disposition: choice('eligible') },
                ],
              },
            },
          },
        },
      ],
    };
    const actual = mockNativeProjection(
      {
        userId: 'owner',
        responseMessageId: 'answer',
        deliveryDispositionRequired: true,
        deliveryContext: { surface: 'telegram', authenticated: true },
      },
      response,
      { text, content: [{ type: 'text', text }], attachments: [file] },
      'transmit',
    );
    const mappedQuiet = `![Capture](${download})`;
    expect(actual.content[0].deliveryDispositionRanges).toEqual([
      { start: 0, end: mappedQuiet.length, disposition: choice('skip') },
      { start: mappedQuiet.length, end: actual.text.length, disposition: choice('eligible') },
    ]);
  });
});

describe('passive native response phase timing', () => {
  const { wrapNativeResponseFetch } = require('../nativeResponseService');
  const { logger } = require('@librechat/data-schemas');
  const route = { agentId: 'main', endpoint: 'native-provider' };
  const request = (enabled = true) => ({
    body: {},
    viventiumVoiceLogLatency: enabled,
    viventiumVoiceRequestId: 'SYNTHETIC_PRIVATE_REQUEST_ID',
    headers: { Authorization: 'SYNTHETIC_SECRET_MUST_NOT_BE_LOGGED' },
  });
  const phases = (req, baseFetch) => {
    wrapNativeResponseFetch(req, 'main', baseFetch, route);
    const args = mockCreateNativeResponseFetch.mock.calls.at(-1);
    return { send: args[0], admit: args[2] };
  };
  beforeEach(() => jest.clearAllMocks());

  test.each(['admit', 'send'])(
    '%s records only completion and numeric clocks after its real operation',
    async (phase) => {
      let release;
      const result = { exactResult: true };
      const pending = new Promise((resolve) => {
        release = () => resolve(result);
      });
      const operation = jest.fn(() => pending);
      mockAdmit.mockImplementation(operation);
      const controls = phases(request(), operation);
      const completion = controls[phase]('SYNTHETIC_PRIVATE_PAYLOAD');
      expect(logger.debug).not.toHaveBeenCalled();
      release();
      await expect(completion).resolves.toBe(result);
      expect(logger.debug).toHaveBeenCalledTimes(1);
      const [message, fields] = logger.debug.mock.calls[0];
      expect(message).toBe('[VoiceLatency][LC][Timing]');
      expect(fields.source).toBe('native_response');
      expect(fields.stage).toBe(
        phase === 'admit'
          ? 'host_native_admission_completed'
          : 'provider_response_headers_completed',
      );
      expect(fields.stage_ms_f).toBeGreaterThanOrEqual(0);
      expect(fields.request_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(logger.debug.mock.calls)).not.toMatch(
        /SYNTHETIC_PRIVATE|SYNTHETIC_SECRET/,
      );
    },
  );

  test.each(['admit', 'send'])(
    '%s preserves exact failure and logs failure separately',
    async (phase) => {
      const error = new Error('SYNTHETIC_PRIVATE_FAILURE');
      const operation = jest.fn(async () => {
        throw error;
      });
      mockAdmit.mockImplementation(operation);
      await expect(phases(request(), operation)[phase]('private')).rejects.toBe(error);
      expect(logger.debug.mock.calls[0][1].stage.endsWith('_failed')).toBe(true);
      expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(error.message);
    },
  );

  test.each(['admit', 'send'])(
    '%s does no logging or promise replacement when timing is off',
    async (phase) => {
      const result = Promise.resolve({ exactResult: true });
      const operation = jest.fn(() => result);
      mockAdmit.mockImplementation(operation);
      expect(phases(request(false), operation)[phase]('private')).toBe(result);
      expect(logger.debug).not.toHaveBeenCalled();
      await result;
    },
  );

  test.each([false, true])(
    'logger failure never changes transport success or failure (rejected=%s)',
    async (rejected) => {
      const error = new Error('SYNTHETIC_PRIVATE_FAILURE');
      const result = { exactResult: true };
      logger.debug.mockImplementationOnce(() => {
        throw new Error('diagnostic only');
      });
      const operation = jest.fn(async () => {
        if (rejected) throw error;
        return result;
      });
      const response = phases(request(), operation).send('private');
      if (rejected) await expect(response).rejects.toBe(error);
      else await expect(response).resolves.toBe(result);
    },
  );
});


describe('durable host final replay', () => {
  const { readRetainedHostFinal, acknowledgeRetainedHostFinal } = require('../nativeResponseService');
  const query = { userId: 'owner', streamId: 'stream', surface: 'telegram' };
  beforeEach(() => {
    mockJobs.getJobStore.mockReturnValue({ resolveDeliveryOwner: jest.fn().mockResolvedValue(null) });
  });
  test('uses public Message projection and exact final proof without provider or job replay', async () => {
    const identity = { userId: 'owner', conversationId: 'conversation', responseMessageId: 'answer', source: { messageId: 'question' } };
    const row = { messageId: 'answer', conversationId: 'conversation', hostFinal: identity,
      metadata: { viventium: { interactionContext: { logical_turn_id: 'turn', revision: 1 } } } };
    mockModels.readHostResponseFinal.mockResolvedValue(row);
    mockModels.getMessage.mockResolvedValue({ messageId: 'question' });
    mockModels.getMessages.mockResolvedValue([{ messageId: 'answer', text: 'Saved final.', attachments: [{ file_id: 'file' }] }]);
    const result = await readRetainedHostFinal(query);
    expect(result.finalEvent.responseMessage).toEqual({ messageId: 'answer', text: 'Saved final.', unfinished: false, attachments: [{ file_id: 'file' }] });
    expect(result.finalEvent.responseMessage).not.toHaveProperty('nativeResponse');
    expect(mockModels.readHostResponseFinal).toHaveBeenLastCalledWith(query);
  });
  test('rechecks the exact proof after public projection before replay', async () => {
    mockModels.readHostResponseFinal.mockReset().mockResolvedValueOnce({
      hostFinal: { userId: 'owner', conversationId: 'conversation', responseMessageId: 'answer', source: { messageId: 'question' } },
    }).mockResolvedValueOnce(null);
    mockModels.getMessage.mockResolvedValue({ messageId: 'question' });
    mockModels.getMessages.mockResolvedValue([{ messageId: 'answer' }]);
    expect(await readRetainedHostFinal(query)).toBeNull();
  });
  test('rejects a replacement admitted in the existing owner before its Message is saved', async () => {
    mockModels.readHostResponseFinal.mockResolvedValue({ hostFinal: { logicalTurnId: 'turn', revision: 1 } });
    mockJobs.getJobStore.mockReturnValue({ resolveDeliveryOwner: jest.fn().mockResolvedValue('replacement') });
    expect(await readRetainedHostFinal(query)).toBeNull();
  });
  test('rejects a newer source already observed by the existing source-order owner', async () => {
    mockModels.readHostResponseFinal.mockResolvedValue({ hostFinal: {
      logicalTurnId: 'turn', revision: 1, sourceOrderScope: 'a'.repeat(64), sourceSequence: 1,
    } });
    mockJobs.observeSourceOrder.mockResolvedValue({ stale: true });
    expect(await readRetainedHostFinal(query)).toBeNull();
  });
  test('rejects a replacement admitted while the public final is being read', async () => {
    mockModels.readHostResponseFinal.mockResolvedValue({ hostFinal: {
      userId: 'owner', conversationId: 'conversation', responseMessageId: 'answer',
      logicalTurnId: 'turn', revision: 1, source: { messageId: 'question' },
    } });
    mockModels.getMessage.mockResolvedValue({ messageId: 'question' });
    mockModels.getMessages.mockResolvedValue([{ messageId: 'answer' }]);
    mockJobs.getJobStore.mockReturnValue({ resolveDeliveryOwner: jest.fn()
      .mockResolvedValueOnce(null).mockResolvedValueOnce('new-author') });
    expect(await readRetainedHostFinal(query)).toBeNull();
  });
  test('settles through the existing canonical transaction' , async () => {
    const ack = { logical_turn_id: 'turn', revision: 1, state: 'committed' };
    mockModels.acknowledgeHostResponseFinal.mockImplementation(async (_ack, _surface, transaction) =>
      transaction(async () => { expect(mockTransactionDepth).toBe(1); return { status: 'recorded' }; }));
    expect(await acknowledgeRetainedHostFinal(ack, 'telegram')).toEqual({ status: 'recorded' });
  });
});
