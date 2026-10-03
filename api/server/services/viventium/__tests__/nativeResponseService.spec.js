const mockCommitProjection = jest.fn();
const mockProjectionComplete = jest.fn();
const mockRecover = jest.fn();
const mockConfig = jest.fn();
const mockLoadAgent = jest.fn();
const mockPermission = jest.fn();
let mockTransactionDepth = 0;
const mockModels = {
  findUser: jest.fn(),
  getNativeResponse: jest.fn(),
  getMessages: jest.fn(),
  getMessage: jest.fn(),
  markNativeResponseReplayStored: jest.fn(),
  mutateAcceptedMainContinuitySources: jest.fn(),
  mutateNativeResponseSources: jest.fn(),
};
const mockJobs = {
  finishNativeResponse: jest.fn(),
  settleNativeResponse: jest.fn(),
  getJob: jest.fn(),
  getJobStore: jest.fn(),
  acknowledgeStreamDelivery: jest.fn(),
  renewNativeDispatchLease: jest.fn(async () => true),
};

jest.mock('@librechat/api', () => ({
  createNativeResponseRecoveryService: () => ({
    recover: mockRecover,
    projectForTransmit: async (_identity, message) => message,
  }),
  isAcceptedMainProjectionComplete: (...args) => mockProjectionComplete(...args),
  GenerationJobManager: mockJobs,
  sanitizeMessageForTransmit: (message) => message,
}));
jest.mock('~/models', () => mockModels);
jest.mock('~/server/services/Config', () => ({ getAppConfig: (...args) => mockConfig(...args) }));
jest.mock('~/models/Agent', () => ({ loadAgent: (...args) => mockLoadAgent(...args) }));
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
  resolveNativeResponseRoute,
  recoverSavedNativeResponse,
  recoverNativeResponse,
  markNativeResponseReplayStored,
  mutateNativeResponseSources,
} = require('../nativeResponseService');

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
