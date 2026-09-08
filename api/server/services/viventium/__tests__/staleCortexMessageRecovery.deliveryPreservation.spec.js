const fs = require('fs');
const path = require('path');

const mockEmitChunk = jest.fn();
const mockReplayOutbox = jest.fn(async () => ({ scanned: 0, replayed: 0, pending: 0 }));
const mockGetUserById = jest.fn();
const mockGetAgent = jest.fn();
const mockGetAppConfig = jest.fn();
const mockCreateCortexFollowUpMessage = jest.fn();

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  GenerationJobManager: {
    emitCortexPresentation: (...args) => mockEmitChunk(...args),
  },
}));

jest.mock('../nativeResponseService', () => ({ recoverNativeResponses: jest.fn(async () => ({})) }));

jest.mock('~/db/models', () => ({
  ViventiumCortexInsightDelivery: {},
  Conversation: {
    findOne: jest.fn(),
  },
  Message: {
    find: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
  },
}));

jest.mock('~/server/services/viventium/CortexInsightOutboxService', () => ({
  replayCompletedCortexInsightOutbox: (...args) => mockReplayOutbox(...args),
}));

jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
}));

jest.mock('~/models/Agent', () => ({
  getAgent: (...args) => mockGetAgent(...args),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

jest.mock('~/server/services/viventium/BackgroundCortexFollowUpService', () => ({
  createCortexFollowUpMessage: (...args) => mockCreateCortexFollowUpMessage(...args),
}));

const { ContentTypes } = require('librechat-data-provider');
const { Conversation, Message } = require('~/db/models');
const {
  recoverCortexContent,
  recoverDeferredHoldParentErrorCards,
  recoverVisibleFollowUpErrorCards,
  recoverStaleCortexMessages,
  recoverPendingCortexInsightDeliveries,
  createRecoveredCortexFollowUp,
  replayCompletedCortexMessageFallbacks,
  getStaleCortexRecoveryConfig,
  presentRecoveredCortexSurface,
  stripDeferredHoldParentErrorParts,
  stripErrorPartsFromRecoveredFollowUpContent,
} = require('../staleCortexMessageRecovery');

function mockFindLean(messages) {
  const lean = jest.fn().mockResolvedValue(messages);
  const limit = jest.fn(() => ({ lean }));
  const sort = jest.fn(() => ({ limit }));
  Message.find.mockReturnValue({ sort });
  return { sort, limit, lean };
}

function mockFindOneLean(message) {
  const lean = jest.fn().mockResolvedValue(message);
  Message.findOne.mockReturnValue({ lean });
  return { lean };
}

function mockConversationFindOneLean(conversation) {
  const lean = jest.fn().mockResolvedValue(conversation);
  const select = jest.fn(() => ({ lean }));
  Conversation.findOne.mockReturnValue({ select });
  return { select, lean };
}

function presentationFence({
  ownerId = 'owner-a',
  messageId = 'follow-up-a',
  parentMessageId = 'parent-a',
  revision = 2,
  generation = 1,
} = {}) {
  return {
    ownerId,
    claims: [
      {
        deliveryId: 'cidl-recovery-test',
        claimToken: 'claim-recovery-test',
        claimGeneration: generation,
        presentationLeaseToken: 'lease-recovery-test',
        graphResultHash: 'a'.repeat(64),
      },
    ],
    deliveryIds: ['cidl-recovery-test'],
    deliveryReceipts: [{ deliveryId: 'cidl-recovery-test', graphResultHash: 'a'.repeat(64) }],
    generation,
    claimToken: 'claim-recovery-test',
    presentationLeaseToken: 'lease-recovery-test',
    messageId,
    parentMessageId,
    revision,
    surface: 'web',
  };
}

function streamPresentationBinding(fence) {
  return {
    ...fence,
    boundAt: Date.now(),
    interactionContext: { logicalTurnId: 'turn-recovery-test', revision: 1 },
  };
}

function migrationPersistenceService(getDeliveries) {
  return {
    claimPendingByParent: jest.fn(async () => ({
      claimed: getDeliveries().map((delivery) => ({
        ...delivery,
        claimToken: 'claim-migration-test',
        claimGeneration: 1,
      })),
    })),
    markPersisted: jest.fn(async ({ claims, persistedMessageId, messageRevision }) =>
      claims.map((claim) => ({
        ...claim,
        persistenceStatus: 'persisted',
        persistedMessageId,
        messageRevision,
      })),
    ),
  };
}

function recoverPending(options) {
  const suppliedService = options?.deliveryService;
  const deliveryService = suppliedService
    ? {
        ...suppliedService,
        fencePresentation:
          suppliedService.fencePresentation ||
          jest.fn(
            async ({ claims, parentMessageId, persistedMessageId, messageRevision, surface }) => ({
              ownerId: 'owner-a',
              claims: claims.map((claim) => ({
                ...claim,
                graphResultHash: claim.graphResultHash || 'a'.repeat(64),
                presentationLeaseToken: 'lease-recovery-test',
              })),
              deliveryIds: claims.map((claim) => claim.deliveryId),
              deliveryReceipts: claims.map((claim) => ({
                deliveryId: claim.deliveryId,
                graphResultHash: claim.graphResultHash || 'a'.repeat(64),
              })),
              generation: Number(claims[0]?.claimGeneration) || 0,
              claimToken: claims[0]?.claimToken,
              presentationLeaseToken: 'lease-recovery-test',
              messageId: persistedMessageId,
              parentMessageId,
              revision: messageRevision,
              surface,
            }),
          ),
      }
    : suppliedService;
  return recoverPendingCortexInsightDeliveries({
    replayMessageFallbacks: async () => ({ scanned: 0, replayed: 0, pending: 0 }),
    replayOutbox: mockReplayOutbox,
    loadParentState: async (parent) => ({
      messageId: parent.parentMessageId,
      unfinished: false,
    }),
    bindStreamPresentation: async ({ presentationFence: fence }) => ({
      ...streamPresentationBinding(fence),
    }),
    ...options,
    ...(deliveryService ? { deliveryService } : {}),
  });
}

function recoverStale(options) {
  return recoverStaleCortexMessages({
    recoverInsightDeliveries: ({ limit }) => recoverPending({ limit }),
    ...options,
  });
}

describe('staleCortexMessageRecovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_MS;
    delete process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_GRACE_MS;
    delete process.env.VIVENTIUM_CORTEX_EXECUTION_TIMEOUT_MS;
    delete process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_LIMIT;
    Message.updateOne.mockResolvedValue({ modifiedCount: 1 });
    mockEmitChunk.mockImplementation(async (_streamId, _event, _receipt, options = {}) => {
      const verified = await options.verifyPresentation?.('publish');
      return {
        delivered: true,
        streamId: _streamId,
        target: 'subscriber_transport',
        presentationRef: `sse:${_streamId}:follow-up-a:2`,
        claimToken: verified?.claimToken,
        presentationLeaseToken: verified?.presentationLeaseToken,
      };
    });
    mockFindOneLean(null);
    mockConversationFindOneLean(null);
  });

  test('restores authenticated config and identity for recovered Phase-B synthesis', async () => {
    const appConfig = {
      endpoints: {
        agents: {
          providerCapabilities: {
            'glasshive-harness': { workspace_binding: true },
          },
        },
      },
    };
    mockFindOneLean({
      agent_id: 'agent-phase-b',
      text: 'Initial answer.',
    });
    mockGetUserById.mockResolvedValue({
      _id: 'owner-phase-b',
      role: 'USER',
    });
    mockGetAgent.mockResolvedValue({
      id: 'agent-phase-b',
      provider: 'glasshive-harness',
    });
    mockGetAppConfig.mockResolvedValue(appConfig);
    mockCreateCortexFollowUpMessage.mockResolvedValue({ messageId: 'follow-up-phase-b' });
    const feelingSnapshot = {
      available: true,
      enabled: true,
      agentScope: 'all_agents',
      version: 41,
      asOf: '2026-08-22T12:00:00.000Z',
      capsule: 'Synthetic request-pinned Feelings capsule.',
      snapshotHash: 'a'.repeat(64),
      rangePromptOverrideCount: 3,
      activeRangePromptOverrideCount: 2,
      activeRangePromptOverrideChars: 120,
    };

    await createRecoveredCortexFollowUp({
      ownerId: 'owner-phase-b',
      conversationId: 'conversation-phase-b',
      parentMessageId: 'parent-phase-b',
      surface: 'telegram',
      insights: [{ cortexId: 'review', insight: 'Recovered result.' }],
      deliveryBatch: { claimId: 'claim-phase-b', claimed: [] },
      recoveryContext: { streamId: 'stream-phase-b', messageRevision: 2, feelingSnapshot },
    });

    expect(mockGetAppConfig).toHaveBeenCalledWith({ role: 'USER' });
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        req: expect.objectContaining({
          user: expect.objectContaining({ id: 'owner-phase-b' }),
          config: appConfig,
          headers: { 'x-viventium-surface': 'telegram' },
          _viventiumFeelingSnapshot: feelingSnapshot,
        }),
      }),
    );
  });

  test('restores the exact conversation agent when the parent message omits agent_id', async () => {
    mockFindOneLean({ text: 'Initial answer.', endpoint: 'agents' });
    mockConversationFindOneLean({ agent_id: 'agent-recovered-from-conversation' });
    mockGetUserById.mockResolvedValue({ _id: 'owner-recovery-agent', role: 'USER' });
    const recoveredAgent = {
      id: 'agent-recovered-from-conversation',
      provider: 'glasshive-harness',
    };
    mockGetAgent.mockImplementation(async ({ id }) =>
      id === 'agent-recovered-from-conversation' ? recoveredAgent : null,
    );
    mockGetAppConfig.mockResolvedValue({ endpoints: { agents: {} } });
    mockCreateCortexFollowUpMessage.mockResolvedValue({ messageId: 'follow-up-recovery-agent' });

    await expect(
      createRecoveredCortexFollowUp({
        ownerId: 'owner-recovery-agent',
        conversationId: 'conversation-recovery-agent',
        parentMessageId: 'parent-recovery-agent',
        surface: 'web',
        insights: [{ cortexId: 'memory', insight: 'Recovered result.' }],
        deliveryBatch: { claimId: 'claim-recovery-agent', claimed: [] },
        recoveryContext: { streamId: 'stream-recovery-agent', messageRevision: 1 },
      }),
    ).resolves.toEqual({ messageId: 'follow-up-recovery-agent' });

    expect(Conversation.findOne).toHaveBeenCalledWith({
      user: 'owner-recovery-agent',
      conversationId: 'conversation-recovery-agent',
      endpoint: 'agents',
    });
    expect(mockGetAgent).toHaveBeenCalledWith({
      id: 'agent-recovered-from-conversation',
      author: 'owner-recovery-agent',
    });
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledWith(
      expect.objectContaining({ agent: recoveredAgent }),
    );
    expect(Message.findOne).toHaveBeenCalledWith({
      user: 'owner-recovery-agent',
      conversationId: 'conversation-recovery-agent',
      messageId: 'parent-recovery-agent',
      isCreatedByUser: { $ne: true },
    });
  });

  test('rejects a same-owner parent from another conversation', async () => {
    Message.findOne.mockImplementation((query) => ({
      lean: jest
        .fn()
        .mockResolvedValue(
          query.conversationId === 'conversation-exact'
            ? null
            : { agent_id: 'agent-wrong-conversation', text: 'Wrong conversation.' },
        ),
    }));
    mockConversationFindOneLean({ agent_id: 'agent-exact-conversation' });
    mockGetUserById.mockResolvedValue({ _id: 'owner-exact', role: 'USER' });
    mockGetAgent.mockResolvedValue({ id: 'agent-wrong-conversation' });

    await expect(
      createRecoveredCortexFollowUp({
        ownerId: 'owner-exact',
        conversationId: 'conversation-exact',
        parentMessageId: 'parent-reused-id',
        surface: 'web',
        insights: [{ cortexId: 'memory', insight: 'Recovered result.' }],
        deliveryBatch: { claimId: 'claim-exact', claimed: [] },
        recoveryContext: { streamId: 'stream-exact', messageRevision: 1 },
      }),
    ).rejects.toMatchObject({ code: 'cortex_recovery_author_unavailable' });
    expect(mockCreateCortexFollowUpMessage).not.toHaveBeenCalled();
  });

  test('rejects recovery when the exact conversation has no agent', async () => {
    mockFindOneLean({ text: 'Initial answer.', endpoint: 'agents' });
    mockConversationFindOneLean(null);
    mockGetUserById.mockResolvedValue({ _id: 'owner-no-agent', role: 'USER' });
    process.env.VIVENTIUM_MAIN_AGENT_ID = 'global-agent-must-not-authorize-recovery';

    await expect(
      createRecoveredCortexFollowUp({
        ownerId: 'owner-no-agent',
        conversationId: 'conversation-no-agent',
        parentMessageId: 'parent-no-agent',
        surface: 'web',
        insights: [{ cortexId: 'memory', insight: 'Recovered result.' }],
        deliveryBatch: { claimId: 'claim-no-agent', claimed: [] },
        recoveryContext: { streamId: 'stream-no-agent', messageRevision: 1 },
      }),
    ).rejects.toMatchObject({ code: 'cortex_recovery_author_unavailable' });
    expect(mockGetAgent).not.toHaveBeenCalled();
    expect(mockCreateCortexFollowUpMessage).not.toHaveBeenCalled();
    delete process.env.VIVENTIUM_MAIN_AGENT_ID;
  });

  test('rejects a conversation agent that is not owned by the recovery owner', async () => {
    mockFindOneLean({ text: 'Initial answer.', endpoint: 'agents' });
    mockConversationFindOneLean({ agent_id: 'foreign-agent' });
    mockGetUserById.mockResolvedValue({ _id: 'owner-local', role: 'USER' });
    mockGetAgent.mockResolvedValue(null);

    await expect(
      createRecoveredCortexFollowUp({
        ownerId: 'owner-local',
        conversationId: 'conversation-local',
        parentMessageId: 'parent-local',
        surface: 'telegram',
        insights: [{ cortexId: 'review', insight: 'Recovered result.' }],
        deliveryBatch: { claimId: 'claim-local', claimed: [] },
        recoveryContext: { streamId: 'stream-local', messageRevision: 1 },
      }),
    ).rejects.toMatchObject({ code: 'cortex_recovery_author_unavailable' });
    expect(mockGetAgent).toHaveBeenCalledWith({ id: 'foreign-agent', author: 'owner-local' });
    expect(mockCreateCortexFollowUpMessage).not.toHaveBeenCalled();
  });

  test('does not invent a background execution deadline when none is configured', () => {
    expect(getStaleCortexRecoveryConfig()).toEqual(
      expect.objectContaining({
        timeoutMs: 240000,
        cortexExecutionTimeoutMs: 0,
        graceMs: 60000,
      }),
    );
  });

  test('rebuilds the ledger from an exact canonical-message retry envelope', async () => {
    const insight = 'Exact compatibility result: ① Å ﬁ.';
    const graphResultHash = require('crypto').createHash('sha256').update(insight).digest('hex');
    mockFindLean([
      {
        _id: 'mongo-message-a',
        user: 'owner-a',
        conversationId: 'conversation-a',
        messageId: 'parent-a',
        content: [
          {
            type: ContentTypes.CORTEX_INSIGHT,
            cortex_id: 'emotional-resonance',
            cortex_name: 'Emotional Resonance',
            status: 'complete',
            insight,
            cortex_delivery_acceptance: 'retryable',
            cortex_delivery_surface: 'telegram',
            cortex_delivery_stream_id: 'stream-a',
            cortex_delivery_message_revision: 3,
            cortex_delivery_feeling_snapshot: {
              available: true,
              enabled: true,
              agentScope: 'all_agents',
              version: 41,
              asOf: '2026-08-22T12:00:00.000Z',
              capsule: 'Synthetic request-pinned Feelings capsule.',
              snapshotHash: 'a'.repeat(64),
              rangePromptOverrideCount: 3,
              activeRangePromptOverrideCount: 2,
              activeRangePromptOverrideChars: 120,
            },
            cortex_graph_result_hash: graphResultHash,
          },
        ],
      },
    ]);
    const { buildCortexInsightDeliveryCandidates } = require('../CortexInsightDeliveryService');
    let acceptedDeliveries = [];
    const recordBatch = jest.fn(async (batch) => {
      acceptedDeliveries = buildCortexInsightDeliveryCandidates(batch);
      return { deliveries: acceptedDeliveries };
    });
    const deliveryService = migrationPersistenceService(() => acceptedDeliveries);

    await expect(
      replayCompletedCortexMessageFallbacks({
        MessageModel: Message,
        recordBatch,
        deliveryService,
      }),
    ).resolves.toEqual({ scanned: 1, replayed: 1, pending: 0 });
    expect(recordBatch).toHaveBeenCalledWith({
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
      surface: 'telegram',
      streamId: 'stream-a',
      messageRevision: 3,
      feelingSnapshot: {
        available: true,
        enabled: true,
        agentScope: 'all_agents',
        version: 41,
        asOf: '2026-08-22T12:00:00.000Z',
        capsule: 'Synthetic request-pinned Feelings capsule.',
        snapshotHash: 'a'.repeat(64),
        rangePromptOverrideCount: 3,
        activeRangePromptOverrideCount: 2,
        activeRangePromptOverrideChars: 120,
      },
      insights: [
        {
          cortexId: 'emotional-resonance',
          cortexName: 'Emotional Resonance',
          insight,
          status: 'completed',
        },
      ],
    });
    expect(Message.updateOne).toHaveBeenCalledWith(
      { _id: 'mongo-message-a', user: 'owner-a', messageId: 'parent-a' },
      {
        $set: { 'content.$[retry].cortex_delivery_acceptance': 'ledger' },
        $unset: { 'content.$[legacy].cortex_delivery_feeling_snapshot': '' },
      },
      {
        arrayFilters: [
          {
            'retry.type': ContentTypes.CORTEX_INSIGHT,
            'retry.cortex_delivery_acceptance': 'retryable',
            'retry.cortex_graph_result_hash': { $in: [graphResultHash] },
          },
          { 'legacy.cortex_delivery_feeling_snapshot': { $exists: true } },
        ],
      },
    );
  });

  test('rejects contradictory canonical sibling receipts as one request envelope', async () => {
    const insights = ['First exact result.', 'Second exact result.'];
    const hashes = insights.map((insight) =>
      require('crypto').createHash('sha256').update(insight).digest('hex'),
    );
    const receipt = (capsule, hash) => ({
      available: true,
      enabled: true,
      agentScope: 'all_agents',
      version: 41,
      asOf: '2026-08-22T12:00:00.000Z',
      capsule,
      snapshotHash: hash.repeat(64),
      rangePromptOverrideCount: 3,
      activeRangePromptOverrideCount: 2,
      activeRangePromptOverrideChars: 120,
    });
    mockFindLean([
      {
        _id: 'mongo-conflicting-siblings',
        user: 'owner-conflicting-siblings',
        conversationId: 'conversation-conflicting-siblings',
        messageId: 'parent-conflicting-siblings',
        content: insights.map((insight, index) => ({
          type: ContentTypes.CORTEX_INSIGHT,
          cortex_id: `review-${index}`,
          cortex_name: `Review ${index}`,
          insight,
          cortex_delivery_acceptance: 'retryable',
          cortex_delivery_surface: 'telegram',
          cortex_delivery_stream_id: 'stream-conflicting-siblings',
          cortex_delivery_message_revision: 3,
          cortex_delivery_feeling_snapshot:
            index === 0 ? receipt('First state.', 'a') : receipt('Second state.', 'b'),
          cortex_graph_result_hash: hashes[index],
        })),
      },
    ]);
    const recordBatch = jest.fn();

    await expect(
      replayCompletedCortexMessageFallbacks({ MessageModel: Message, recordBatch }),
    ).resolves.toEqual({ scanned: 1, replayed: 0, pending: 2 });
    expect(recordBatch).not.toHaveBeenCalled();
    expect(Message.updateOne).not.toHaveBeenCalled();
  });

  test('does not let one malformed legacy row starve a later valid retry', async () => {
    const insight = 'Later valid exact result.';
    const graphResultHash = require('crypto').createHash('sha256').update(insight).digest('hex');
    const validSnapshot = {
      available: true,
      enabled: true,
      agentScope: 'all_agents',
      version: 41,
      asOf: '2026-08-22T12:00:00.000Z',
      capsule: 'Later valid state.',
      snapshotHash: 'a'.repeat(64),
      rangePromptOverrideCount: 3,
      activeRangePromptOverrideCount: 2,
      activeRangePromptOverrideChars: 120,
    };
    const retryPart = (snapshot, value, hash) => ({
      type: ContentTypes.CORTEX_INSIGHT,
      cortex_id: 'review',
      cortex_name: 'Review',
      insight: value,
      cortex_delivery_acceptance: 'retryable',
      cortex_delivery_surface: 'telegram',
      cortex_delivery_stream_id: 'stream-later-valid',
      cortex_delivery_message_revision: 3,
      cortex_delivery_feeling_snapshot: snapshot,
      cortex_graph_result_hash: hash,
    });
    mockFindLean([
      {
        _id: 'mongo-malformed-first',
        user: 'owner-malformed-first',
        conversationId: 'conversation-malformed-first',
        messageId: 'parent-malformed-first',
        content: [retryPart({ capsule: 'malformed' }, 'Malformed first.', 'f'.repeat(64))],
      },
      {
        _id: 'mongo-later-valid',
        user: 'owner-later-valid',
        conversationId: 'conversation-later-valid',
        messageId: 'parent-later-valid',
        content: [retryPart(validSnapshot, insight, graphResultHash)],
      },
    ]);
    const { buildCortexInsightDeliveryCandidates } = require('../CortexInsightDeliveryService');
    let acceptedDeliveries = [];
    const recordBatch = jest.fn(async (batch) => {
      acceptedDeliveries = buildCortexInsightDeliveryCandidates(batch);
      return { deliveries: acceptedDeliveries };
    });
    const deliveryService = migrationPersistenceService(() => acceptedDeliveries);

    await expect(
      replayCompletedCortexMessageFallbacks({
        MessageModel: Message,
        recordBatch,
        deliveryService,
      }),
    ).resolves.toEqual({ scanned: 2, replayed: 1, pending: 1 });
    expect(recordBatch).toHaveBeenCalledTimes(1);
    expect(recordBatch.mock.calls[0][0].parentMessageId).toBe('parent-later-valid');
    expect(Message.updateOne).toHaveBeenCalledTimes(1);
  });

  test('binds a migrated visible insight as the durable receipt before restart recovery', async () => {
    const insight = 'One legacy insight remains visible through restart.';
    const graphResultHash = require('crypto').createHash('sha256').update(insight).digest('hex');
    const legacyMessage = {
      _id: 'mongo-visible-legacy',
      user: 'owner-visible-legacy',
      conversationId: 'conversation-visible-legacy',
      messageId: 'message-visible-legacy',
      revision: 3,
      text: insight,
      content: [
        {
          type: ContentTypes.CORTEX_INSIGHT,
          cortex_id: 'review',
          cortex_name: 'Review',
          status: 'complete',
          insight,
          cortex_delivery_acceptance: 'retryable',
          cortex_delivery_surface: 'web',
          cortex_delivery_stream_id: 'stream-visible-legacy',
          cortex_delivery_message_revision: 3,
          cortex_delivery_feeling_snapshot: {
            available: true,
            enabled: true,
            agentScope: 'all_agents',
            version: 41,
            asOf: '2026-08-22T12:00:00.000Z',
            capsule: 'Synthetic migrated state.',
            snapshotHash: 'a'.repeat(64),
            rangePromptOverrideCount: 3,
            activeRangePromptOverrideCount: 2,
            activeRangePromptOverrideChars: 120,
          },
          cortex_graph_result_hash: graphResultHash,
        },
      ],
    };
    mockFindLean([legacyMessage]);
    const { buildCortexInsightDeliveryCandidates } = require('../CortexInsightDeliveryService');
    let ledgerRow = null;
    const visibleMessages = [legacyMessage];
    const createMessage = jest.fn(async () => {
      const duplicate = {
        messageId: 'message-duplicate',
        revision: 3,
        text: insight,
      };
      visibleMessages.push(duplicate);
      return duplicate;
    });
    const deliveryService = {
      recordBatch: jest.fn(async (batch) => {
        if (!ledgerRow) {
          ledgerRow = {
            ...buildCortexInsightDeliveryCandidates(batch)[0],
            status: 'pending',
            persistenceStatus: 'pending',
            persistedMessageId: '',
            claimGeneration: 0,
            requiredSurfaces: ['web'],
            presentedSurfaces: ['web'],
          };
        }
        return { deliveries: [{ ...ledgerRow }] };
      }),
      listRecoverableParents: jest.fn(async () => [
        {
          ownerId: 'owner-visible-legacy',
          conversationId: 'conversation-visible-legacy',
          parentMessageId: 'message-visible-legacy',
          surface: 'web',
        },
      ]),
      claimPendingByParent: jest.fn(async () => {
        ledgerRow = {
          ...ledgerRow,
          status: 'claimed',
          claimToken: 'claim-visible-legacy',
          claimGeneration: Number(ledgerRow.claimGeneration) + 1,
          attemptNumber: 1,
        };
        return {
          claimId: ledgerRow.claimToken,
          deliveries: [{ ...ledgerRow }],
          claimed: [{ ...ledgerRow }],
          insights: [{ cortexId: 'review', insight, status: 'completed' }],
          recoveryContext: { streamId: 'stream-visible-legacy', messageRevision: 3 },
        };
      }),
      markPersisted: jest.fn(async ({ claims, persistedMessageId, messageRevision }) => {
        ledgerRow = {
          ...ledgerRow,
          persistedMessageId,
          messageRevision,
          persistenceStatus: 'persisted',
        };
        return claims.map((claim) => ({ ...claim, ...ledgerRow }));
      }),
      finalizePresented: jest.fn(async ({ claims }) =>
        claims.map((claim) => ({ ...claim, status: 'sent' })),
      ),
      markFailed: jest.fn(),
    };

    await replayCompletedCortexMessageFallbacks({
      MessageModel: Message,
      recordBatch: deliveryService.recordBatch,
      deliveryService,
    });
    ledgerRow = { ...ledgerRow, status: 'pending' };
    await recoverPending({
      deliveryService,
      replayMessageFallbacks: async () => ({ scanned: 0, replayed: 0, pending: 0 }),
      createMessage,
      loadMessage: async ({ messageId }) =>
        visibleMessages.find((message) => message.messageId === messageId) || null,
      bindMessageGeneration: async ({ message }) => message,
      presentSurface: jest.fn(),
    });

    expect(ledgerRow.persistedMessageId).toBe('message-visible-legacy');
    expect(visibleMessages).toHaveLength(1);
    expect(createMessage).not.toHaveBeenCalled();
  });

  test('scans past scrub failures and multiple poisoned pages to migrate a later valid row', async () => {
    const validInsight = 'Valid insight after poisoned pages.';
    const validHash = require('crypto').createHash('sha256').update(validInsight).digest('hex');
    const retryPart = ({ insight, hash, snapshot }) => ({
      type: ContentTypes.CORTEX_INSIGHT,
      cortex_id: 'review',
      cortex_name: 'Review',
      status: 'complete',
      insight,
      cortex_delivery_acceptance: 'retryable',
      cortex_delivery_surface: 'web',
      cortex_delivery_stream_id: 'stream-poison-scan',
      cortex_delivery_message_revision: 2,
      cortex_delivery_feeling_snapshot: snapshot,
      cortex_graph_result_hash: hash,
    });
    const poisonedPart = (index) =>
      retryPart({
        insight: `Poisoned insight ${index}.`,
        hash: 'f'.repeat(64),
        snapshot: { capsule: `Malformed state ${index}.` },
      });
    const validSnapshot = {
      available: true,
      enabled: true,
      agentScope: 'all_agents',
      version: 41,
      asOf: '2026-08-22T12:00:00.000Z',
      capsule: 'Valid later state.',
      snapshotHash: 'b'.repeat(64),
      rangePromptOverrideCount: 3,
      activeRangePromptOverrideCount: 2,
      activeRangePromptOverrideChars: 120,
    };
    const page = (rows) => ({
      sort: jest.fn(() => ({
        limit: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(rows) })),
      })),
    });
    const MessageModel = {
      find: jest
        .fn()
        .mockReturnValueOnce(
          page([
            {
              _id: 'message-01',
              user: 'owner-01',
              messageId: 'parent-01',
              createdAt: new Date('2026-08-22T12:00:01.000Z'),
              content: [{ cortex_delivery_feeling_snapshot: { capsule: 'scrub-only' } }],
            },
            {
              _id: 'message-02',
              user: 'owner-02',
              messageId: 'parent-02',
              createdAt: new Date('2026-08-22T12:00:02.000Z'),
              content: [poisonedPart(2)],
            },
          ]),
        )
        .mockReturnValueOnce(
          page([
            {
              _id: 'message-03',
              user: 'owner-03',
              messageId: 'parent-03',
              createdAt: new Date('2026-08-22T12:00:03.000Z'),
              content: [poisonedPart(3)],
            },
            {
              _id: 'message-04',
              user: 'owner-04',
              messageId: 'parent-04',
              createdAt: new Date('2026-08-22T12:00:04.000Z'),
              content: [poisonedPart(4)],
            },
          ]),
        )
        .mockReturnValueOnce(
          page([
            {
              _id: 'message-05',
              user: 'owner-05',
              conversationId: 'conversation-05',
              messageId: 'parent-05',
              createdAt: new Date('2026-08-22T12:00:05.000Z'),
              content: [
                retryPart({ insight: validInsight, hash: validHash, snapshot: validSnapshot }),
              ],
            },
          ]),
        ),
      updateOne: jest
        .fn()
        .mockRejectedValueOnce(new Error('synthetic legacy scrub failure'))
        .mockResolvedValue({ modifiedCount: 1 }),
    };
    const { buildCortexInsightDeliveryCandidates } = require('../CortexInsightDeliveryService');
    const recordBatch = jest.fn(async (batch) => ({
      deliveries: buildCortexInsightDeliveryCandidates(batch),
    }));
    const deliveryService = {
      claimPendingByParent: jest.fn(async ({ ownerId, parentMessageId }) => ({
        claimed: [
          {
            ...buildCortexInsightDeliveryCandidates({
              ownerId,
              conversationId: 'conversation-05',
              parentMessageId,
              surface: 'web',
              streamId: 'stream-poison-scan',
              messageRevision: 2,
              insights: [{ cortexId: 'review', insight: validInsight, status: 'completed' }],
            })[0],
            claimToken: 'claim-later-valid',
            claimGeneration: 1,
          },
        ],
      })),
      markPersisted: jest.fn(async ({ claims }) => claims),
    };

    await expect(
      replayCompletedCortexMessageFallbacks({
        MessageModel,
        recordBatch,
        deliveryService,
        limit: 2,
      }),
    ).resolves.toEqual({ scanned: 5, replayed: 1, pending: 3 });
    expect(MessageModel.find).toHaveBeenCalledTimes(3);
    expect(recordBatch).toHaveBeenCalledTimes(1);
    expect(recordBatch.mock.calls[0][0].parentMessageId).toBe('parent-05');
  });

  test('marks active cortex parts as terminal errors', () => {
    const nowIso = '2026-05-06T12:00:00.000Z';
    const result = recoverCortexContent(
      [
        { type: ContentTypes.CORTEX_ACTIVATION, cortex_id: 'a', status: 'activating' },
        { type: ContentTypes.CORTEX_INSIGHT, cortex_id: 'b', status: 'complete', insight: 'done' },
      ],
      nowIso,
    );

    expect(result.changed).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        status: 'error',
        recovered_at: nowIso,
        recovery_reason: 'stale_cortex_startup_recovery',
      }),
    );
    expect(result.content[1].status).toBe('complete');
  });

  test('strips stale provider error cards from recovered visible follow-ups', () => {
    const result = stripErrorPartsFromRecoveredFollowUpContent([
      { type: ContentTypes.CORTEX_INSIGHT, cortex_id: 'a', status: 'complete' },
      {
        type: ContentTypes.ERROR,
        error: 'The model provider is temporarily overloaded. Please try again shortly.',
        error_class: 'provider_temporarily_unavailable',
      },
      { type: ContentTypes.TEXT, text: 'Recovered answer.' },
    ]);

    expect(result.changed).toBe(true);
    expect(result.errorClasses).toEqual(['provider_temporarily_unavailable']);
    expect(result.content).toEqual([
      expect.objectContaining({ type: ContentTypes.CORTEX_INSIGHT }),
      { type: ContentTypes.TEXT, text: 'Recovered answer.' },
    ]);
  });

  test('repairs persisted recovered follow-ups that still contain visible error cards', async () => {
    mockFindLean([
      {
        _id: 'mongo-id-recovered',
        messageId: 'msg-recovered',
        updatedAt: new Date('2026-05-21T06:44:46.000Z'),
        text: 'Recovered answer.',
        metadata: {
          viventium: {
            type: 'cortex_followup',
            promotedToEmptyParent: true,
          },
        },
        content: [
          { type: ContentTypes.CORTEX_INSIGHT, cortex_id: 'a', status: 'complete' },
          {
            type: ContentTypes.ERROR,
            error: 'The model provider is temporarily overloaded. Please try again shortly.',
            error_class: 'provider_temporarily_unavailable',
          },
          { type: ContentTypes.TEXT, text: 'Recovered answer.' },
        ],
      },
    ]);

    const result = await recoverVisibleFollowUpErrorCards({ limit: 10 });

    expect(result).toEqual({ scanned: 1, repaired: 1 });
    expect(Message.updateOne).toHaveBeenCalledWith(
      { _id: 'mongo-id-recovered', updatedAt: new Date('2026-05-21T06:44:46.000Z') },
      {
        $set: expect.objectContaining({
          error: false,
          unfinished: false,
          content: [
            expect.objectContaining({ type: ContentTypes.CORTEX_INSIGHT }),
            { type: ContentTypes.TEXT, text: 'Recovered answer.' },
          ],
          metadata: expect.objectContaining({
            viventium: expect.objectContaining({
              recoveredPrimaryErrorClasses: ['provider_temporarily_unavailable'],
            }),
          }),
        }),
      },
    );
  });

  test('strips stale completion errors from deferred hold parents only when structurally safe', () => {
    const holdPart = {
      type: ContentTypes.TEXT,
      text: 'Checking now.',
      viventium_runtime_hold: true,
    };
    const cortexPart = {
      type: ContentTypes.CORTEX_INSIGHT,
      cortex_id: 'agent-prod',
      status: 'complete',
    };

    const result = stripDeferredHoldParentErrorParts([
      cortexPart,
      holdPart,
      {
        type: ContentTypes.ERROR,
        error: 'The model provider could not complete this request.',
        error_class: 'completion_error',
      },
      {
        type: ContentTypes.ERROR,
        error: 'The model provider credentials were rejected.',
        error_class: 'provider_unauthorized',
      },
    ]);

    expect(result.changed).toBe(true);
    expect(result.errorClasses).toEqual(['completion_error']);
    expect(result.content).toEqual([
      cortexPart,
      holdPart,
      {
        type: ContentTypes.ERROR,
        error: 'The model provider credentials were rejected.',
        error_class: 'provider_unauthorized',
      },
    ]);
    expect(
      stripDeferredHoldParentErrorParts([
        holdPart,
        {
          type: ContentTypes.ERROR,
          error: 'The model provider could not complete this request.',
          error_class: 'completion_error',
        },
      ]).changed,
    ).toBe(false);
  });

  test('repairs deferred hold parent error cards after a successful cortex follow-up exists', async () => {
    const updatedAt = new Date('2026-05-21T16:27:58.000Z');
    mockFindLean([
      {
        _id: 'mongo-id-parent',
        messageId: 'msg-parent',
        updatedAt,
        content: [
          { type: ContentTypes.CORTEX_INSIGHT, cortex_id: 'agent-prod', status: 'complete' },
          {
            type: ContentTypes.TEXT,
            text: 'Checking now.',
            viventium_runtime_hold: true,
          },
          {
            type: ContentTypes.ERROR,
            error: 'The model provider could not complete this request.',
            error_class: 'completion_error',
          },
        ],
      },
    ]);
    mockFindOneLean({ _id: 'mongo-id-followup' });

    const result = await recoverDeferredHoldParentErrorCards({ limit: 10 });

    expect(result).toEqual({ scanned: 1, repaired: 1 });
    expect(Message.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        isCreatedByUser: false,
        text: { $type: 'string', $ne: '' },
        error: { $ne: true },
        'metadata.viventium.type': 'cortex_followup',
        'metadata.viventium.parentMessageId': 'msg-parent',
      }),
      { _id: 1 },
    );
    expect(Message.updateOne).toHaveBeenCalledWith(
      { _id: 'mongo-id-parent', updatedAt },
      {
        $set: expect.objectContaining({
          content: [
            { type: ContentTypes.CORTEX_INSIGHT, cortex_id: 'agent-prod', status: 'complete' },
            {
              type: ContentTypes.TEXT,
              text: 'Checking now.',
              viventium_runtime_hold: true,
            },
          ],
          error: false,
          unfinished: false,
          metadata: expect.objectContaining({
            viventium: expect.objectContaining({
              recoveredDeferredHoldErrorClasses: ['completion_error'],
            }),
          }),
        }),
      },
    );
  });

  test('does not repair deferred hold parent errors without a successful follow-up', async () => {
    mockFindLean([
      {
        _id: 'mongo-id-parent',
        messageId: 'msg-parent',
        updatedAt: new Date('2026-05-21T16:27:58.000Z'),
        content: [
          { type: ContentTypes.CORTEX_INSIGHT, cortex_id: 'agent-prod', status: 'complete' },
          {
            type: ContentTypes.TEXT,
            text: 'Checking now.',
            viventium_runtime_hold: true,
          },
          {
            type: ContentTypes.ERROR,
            error: 'The model provider could not complete this request.',
            error_class: 'completion_error',
          },
        ],
      },
    ]);
    mockFindOneLean(null);

    const result = await recoverDeferredHoldParentErrorCards({ limit: 10 });

    expect(result).toEqual({ scanned: 1, repaired: 0 });
    expect(Message.updateOne).not.toHaveBeenCalled();
  });

  test('repairs stale unfinished hold messages on startup', async () => {
    process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_MS = '1000';
    process.env.VIVENTIUM_CORTEX_EXECUTION_TIMEOUT_MS = '500';
    process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_GRACE_MS = '250';
    const now = new Date('2026-05-06T12:00:00.000Z');
    mockFindLean([
      {
        _id: 'mongo-id-1',
        messageId: 'msg-1',
        createdAt: new Date('2026-05-06T11:59:00.000Z'),
        updatedAt: new Date('2026-05-06T11:59:01.000Z'),
        unfinished: true,
        text: 'Checking now.',
        content: [
          {
            type: 'text',
            text: 'Checking now.',
            viventium_runtime_hold: true,
          },
          { type: ContentTypes.CORTEX_ACTIVATION, cortex_id: 'a', status: 'activating' },
        ],
      },
    ]);

    const result = await recoverStale({ now });

    expect(result).toEqual(expect.objectContaining({ scanned: 1, repaired: 1, timeoutMs: 1000 }));
    expect(Message.updateOne).toHaveBeenCalledWith(
      { _id: 'mongo-id-1', updatedAt: new Date('2026-05-06T11:59:01.000Z'),
        'nativeResponse.status': { $nin: ['pending', 'prepared'] } },
      {
        $set: expect.objectContaining({
          unfinished: false,
          text: 'That background check was interrupted by a runtime restart before it finished.',
          content: expect.arrayContaining([
            expect.objectContaining({ status: 'error', cortex_id: 'a' }),
          ]),
        }),
      },
    );
  });

  test('runs durable cortex insight delivery recovery from the production startup pass', async () => {
    mockFindLean([]);
    const recoverInsightDeliveries = jest.fn().mockResolvedValue({
      scanned: 2,
      claimed: 2,
      persisted: 2,
      presented: 2,
      sent: 2,
      pending: 0,
    });

    const result = await recoverStale({
      now: new Date('2026-05-06T12:00:00.000Z'),
      recoverInsightDeliveries,
    });

    expect(recoverInsightDeliveries).toHaveBeenCalledWith({ limit: 100 });
    expect(result.recoveredInsightDeliveries).toEqual(
      expect.objectContaining({ scanned: 2, sent: 2, pending: 0 }),
    );
  });

  test('uses the production stream manager for a Web recovery receipt', async () => {
    const verifyPresentation = jest.fn().mockResolvedValue(presentationFence({ generation: 2 }));
    const consumeFault = jest.fn().mockResolvedValue({ triggered: false, reason: 'not_found' });
    const receipt = await presentRecoveredCortexSurface({
      surface: 'web',
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
      message: { messageId: 'follow-up-a', text: 'Recovered insight.', revision: 2 },
      recoveryContext: { streamId: 'stream-a', messageRevision: 2, claimGeneration: 2 },
      presentationFence: presentationFence({ generation: 2 }),
      streamPresentationBinding: streamPresentationBinding(presentationFence({ generation: 2 })),
      verifyPresentation,
      consumeFault,
    });

    expect(mockEmitChunk).toHaveBeenCalledWith(
      'stream-a',
      expect.objectContaining({
        event: 'on_cortex_followup',
        data: expect.objectContaining({ messageId: 'follow-up-a', text: 'Recovered insight.' }),
      }),
      expect.objectContaining({ claimToken: expect.any(String) }),
      expect.objectContaining({
        verifyPresentation: expect.any(Function),
        consumeCortexFault: expect.any(Function),
      }),
    );
    const emitOptions = mockEmitChunk.mock.calls.at(-1)[3];
    await emitOptions.consumeCortexFault('web_redis_publish_ack');
    expect(consumeFault).toHaveBeenCalledWith({
      boundary: 'web_redis_publish_ack',
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
    });
    expect(receipt).toEqual(
      expect.objectContaining({
        surface: 'web',
        presentationRef: 'sse:stream-a:follow-up-a:2',
      }),
    );
    expect(verifyPresentation).toHaveBeenCalledTimes(2);
  });

  test('rejects a Web recovery when its last-moment claim token fence changed', async () => {
    const initialFence = presentationFence({ generation: 2 });
    const verifyPresentation = jest.fn().mockResolvedValue({
      ...initialFence,
      claimToken: 'claim-newer-restart',
      claims: initialFence.claims.map((claim) => ({
        ...claim,
        claimToken: 'claim-newer-restart',
      })),
    });

    await expect(
      presentRecoveredCortexSurface({
        surface: 'web',
        ownerId: 'owner-a',
        conversationId: 'conversation-a',
        parentMessageId: 'parent-a',
        message: { messageId: 'follow-up-a', text: 'Recovered insight.', revision: 2 },
        recoveryContext: { streamId: 'stream-a', messageRevision: 2, claimGeneration: 2 },
        presentationFence: initialFence,
        streamPresentationBinding: streamPresentationBinding(initialFence),
        verifyPresentation,
      }),
    ).rejects.toMatchObject({ code: 'cortex_insight_delivery_settlement_conflict' });
    expect(verifyPresentation).toHaveBeenCalledTimes(1);
  });

  test('default restart recovery rechecks the exact Web claim immediately before emit', async () => {
    const claim = {
      deliveryId: 'cidl-recovery-test',
      claimToken: 'claim-recovery-test',
      claimGeneration: 2,
      attemptNumber: 2,
      requiredSurfaces: ['web'],
      presentedSurfaces: [],
    };
    const exactFence = presentationFence({ generation: 2 });
    const deliveryService = {
      listRecoverableParents: jest.fn().mockResolvedValue([
        {
          ownerId: 'owner-a',
          conversationId: 'conversation-a',
          parentMessageId: 'parent-a',
          surface: 'web',
        },
      ]),
      claimPendingByParent: jest.fn().mockResolvedValue({
        claimId: claim.claimToken,
        deliveries: [claim],
        claimed: [claim],
        insights: [{ cortexId: 'review', insight: 'Recovered insight.', status: 'completed' }],
        recoveryContext: { streamId: 'stream-a', messageRevision: 2, claimGeneration: 2 },
      }),
      markPersisted: jest.fn().mockResolvedValue([claim]),
      fencePresentation: jest.fn().mockResolvedValue(exactFence),
      markPresented: jest.fn().mockResolvedValue([{ ...claim, presentedSurfaces: ['web'] }]),
      finalizePresented: jest.fn().mockResolvedValue([{ ...claim, status: 'sent' }]),
      markFailed: jest.fn(),
      markDropped: jest.fn(),
    };

    const result = await recoverPending({
      deliveryService,
      createMessage: jest.fn().mockResolvedValue({
        messageId: 'follow-up-a',
        text: 'Recovered insight.',
        revision: 2,
      }),
    });

    expect(result).toEqual(expect.objectContaining({ sent: 1, pending: 0, failed: 0 }));
    expect(deliveryService.fencePresentation).toHaveBeenCalledTimes(3);
    expect(deliveryService.markPresented).toHaveBeenCalledWith(
      expect.objectContaining({
        claims: exactFence.claims,
        presentationGeneration: 2,
        presentationClaimToken: 'claim-recovery-test',
        presentationLeaseToken: 'lease-recovery-test',
      }),
    );
  });

  test('does not mark Web presented when the stream manager has no runtime target', async () => {
    mockEmitChunk.mockResolvedValue({
      delivered: false,
      streamId: 'stream-a',
      reason: 'runtime_unavailable',
    });

    await expect(
      presentRecoveredCortexSurface({
        surface: 'web',
        ownerId: 'owner-a',
        conversationId: 'conversation-a',
        parentMessageId: 'parent-a',
        message: { messageId: 'follow-up-a', text: 'Recovered insight.', revision: 2 },
        recoveryContext: { streamId: 'stream-a', messageRevision: 2, claimGeneration: 2 },
        presentationFence: presentationFence({ generation: 2 }),
        streamPresentationBinding: streamPresentationBinding(presentationFence({ generation: 2 })),
        verifyPresentation: jest.fn().mockResolvedValue(presentationFence({ generation: 2 })),
      }),
    ).rejects.toMatchObject({ code: 'cortex_web_presentation_receipt_unavailable' });
  });

  test('returns only a real committed Telegram presentation receipt in production recovery', async () => {
    mockFindOneLean({
      metadata: {
        viventium: {
          deliveryAcknowledgement: {
            state: 'committed',
            revision: 2,
            cortex_presentation_generation: 3,
            cortex_presentation_claim_token: 'claim-recovery-test',
            presentation_refs: ['telegram:chat-a:message-41', 'telegram:chat-a:message-42'],
          },
        },
      },
    });

    const receipt = await presentRecoveredCortexSurface({
      surface: 'telegram',
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
      message: {
        messageId: 'follow-up-a',
        text: 'Recovered insight.',
        revision: 2,
        metadata: { viventium: { cortexPresentationGeneration: 3 } },
      },
      recoveryContext: { streamId: 'stream-a', messageRevision: 2, claimGeneration: 3 },
      presentationFence: presentationFence({ generation: 3 }),
      receiptWaitMs: 1,
      receiptPollMs: 1,
    });

    expect(Message.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'owner-a',
        messageId: 'follow-up-a',
        isCreatedByUser: { $ne: true },
      }),
    );
    expect(receipt).toEqual({
      surface: 'telegram',
      messageId: 'follow-up-a',
      revision: 2,
      presentationGeneration: 3,
      presentationClaimToken: 'claim-recovery-test',
      presentationLeaseToken: 'lease-recovery-test',
      presentationRef: 'telegram:chat-a:message-41|telegram:chat-a:message-42',
    });
  });

  test('settles an exact persisted Telegram Message acknowledgement after restart', async () => {
    mockFindOneLean({
      messageId: 'follow-up-restart',
      text: 'Recovered insight.',
      revision: 3,
      metadata: {
        viventium: {
          messageRevision: 3,
          cortexPresentationGeneration: 7,
          deliveryAcknowledgement: {
            state: 'committed',
            revision: 3,
            cortex_presentation_generation: 7,
            cortex_presentation_claim_token: 'claim-restart',
            presentation_refs: ['telegram:chat-a:message-77'],
          },
        },
      },
    });
    const claim = {
      deliveryId: 'cidl-restart',
      claimToken: 'claim-restart',
      claimGeneration: 7,
      attemptNumber: 2,
      persistedMessageId: 'follow-up-restart',
      requiredSurfaces: ['telegram'],
      presentedSurfaces: [],
    };
    const deliveryService = {
      listRecoverableParents: jest.fn().mockResolvedValue([
        {
          ownerId: 'owner-a',
          conversationId: 'conversation-a',
          parentMessageId: 'parent-a',
          surface: 'telegram',
        },
      ]),
      claimPendingByParent: jest.fn().mockResolvedValue({
        deliveries: [claim],
        claimed: [claim],
        insights: [{ cortexId: 'review', insight: 'Recovered insight.', status: 'completed' }],
        recoveryContext: { streamId: 'stream-restart', messageRevision: 3, claimGeneration: 7 },
      }),
      markPersisted: jest.fn().mockResolvedValue([claim]),
      markPresented: jest.fn().mockResolvedValue([{ ...claim, presentedSurfaces: ['telegram'] }]),
      finalizePresented: jest.fn().mockResolvedValue([{ ...claim, status: 'sent' }]),
      markFailed: jest.fn(),
    };

    const result = await recoverPending({ deliveryService });

    expect(result).toEqual(expect.objectContaining({ sent: 1, pending: 0 }));
    expect(deliveryService.markPresented).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-a',
        claims: [
          {
            ...claim,
            graphResultHash: 'a'.repeat(64),
            presentationLeaseToken: 'lease-recovery-test',
          },
        ],
        surface: 'telegram',
        persistedMessageId: 'follow-up-restart',
        messageRevision: 3,
        presentationGeneration: 7,
        presentationClaimToken: 'claim-restart',
        presentationLeaseToken: 'lease-recovery-test',
        presentationRef: 'telegram:chat-a:message-77',
      }),
    );
    expect(deliveryService.finalizePresented).toHaveBeenCalledWith({
      ownerId: 'owner-a',
      claims: [claim],
    });
  });

  test('stops recovery before presentation when persistence settles no current claim', async () => {
    const claim = {
      deliveryId: 'cidl-stale-persistence',
      claimToken: 'claim-current',
      claimGeneration: 2,
      attemptNumber: 2,
      requiredSurfaces: ['web'],
      presentedSurfaces: [],
    };
    const deliveryService = {
      listRecoverableParents: jest.fn().mockResolvedValue([
        {
          ownerId: 'owner-a',
          conversationId: 'conversation-a',
          parentMessageId: 'parent-a',
          surface: 'web',
        },
      ]),
      claimPendingByParent: jest.fn().mockResolvedValue({
        deliveries: [claim],
        claimed: [claim],
        insights: [{ cortexId: 'review', insight: 'Recovered insight.', status: 'completed' }],
        recoveryContext: { streamId: 'stream-a', messageRevision: 2, claimGeneration: 2 },
      }),
      markPersisted: jest.fn().mockResolvedValue([]),
      markPresented: jest.fn(),
      finalizePresented: jest.fn(),
      markFailed: jest.fn().mockResolvedValue([{ ...claim, status: 'pending' }]),
    };
    const presentSurface = jest.fn();

    const result = await recoverPending({
      deliveryService,
      createMessage: jest.fn().mockResolvedValue({
        messageId: 'follow-up-a',
        text: 'Recovered insight.',
        revision: 2,
      }),
      bindMessageGeneration: jest.fn(async ({ message }) => message),
      presentSurface,
    });

    expect(result).toEqual(expect.objectContaining({ persisted: 0, presented: 0, pending: 1 }));
    expect(presentSurface).not.toHaveBeenCalled();
    expect(deliveryService.markPresented).not.toHaveBeenCalled();
    expect(deliveryService.finalizePresented).not.toHaveBeenCalled();
  });

  test('does not present stale generation N after generation N+1 reclaims before emit', async () => {
    const claim = {
      deliveryId: 'cidl-stale-pre-emit',
      claimToken: 'claim-generation-n',
      claimGeneration: 2,
      attemptNumber: 2,
      requiredSurfaces: ['web'],
      presentedSurfaces: [],
    };
    const fenceError = new Error('Cortex insight presentation fence is stale');
    fenceError.code = 'cortex_insight_delivery_settlement_conflict';
    const deliveryService = {
      listRecoverableParents: jest.fn().mockResolvedValue([
        {
          ownerId: 'owner-a',
          conversationId: 'conversation-a',
          parentMessageId: 'parent-a',
          surface: 'web',
        },
      ]),
      claimPendingByParent: jest.fn().mockResolvedValue({
        deliveries: [claim],
        claimed: [claim],
        insights: [{ cortexId: 'review', insight: 'Recovered insight.', status: 'completed' }],
        recoveryContext: { streamId: 'stream-a', messageRevision: 2, claimGeneration: 2 },
      }),
      markPersisted: jest.fn().mockResolvedValue([claim]),
      fencePresentation: jest.fn().mockRejectedValue(fenceError),
      markPresented: jest.fn(),
      finalizePresented: jest.fn(),
      markFailed: jest.fn().mockRejectedValue(fenceError),
    };
    const presentSurface = jest.fn();

    const result = await recoverPending({
      deliveryService,
      createMessage: jest.fn().mockResolvedValue({
        messageId: 'follow-up-a',
        text: 'Recovered insight.',
        revision: 2,
      }),
      bindMessageGeneration: jest.fn(async ({ message }) => message),
      presentSurface,
    });

    expect(result).toEqual(expect.objectContaining({ presented: 0, sent: 0, pending: 1 }));
    expect(deliveryService.fencePresentation).toHaveBeenCalledTimes(1);
    expect(presentSurface).not.toHaveBeenCalled();
    expect(deliveryService.markPresented).not.toHaveBeenCalled();
  });

  test('rejects a Telegram acknowledgement for the same message and revision but another Cortex generation', async () => {
    mockFindOneLean({
      messageId: 'follow-up-a',
      metadata: {
        viventium: {
          messageRevision: 2,
          cortexPresentationGeneration: 4,
          deliveryAcknowledgement: {
            state: 'committed',
            revision: 2,
            cortex_presentation_generation: 3,
            presentation_ref: 'telegram:chat-a:message-41',
          },
        },
      },
    });

    await expect(
      presentRecoveredCortexSurface({
        surface: 'telegram',
        ownerId: 'owner-a',
        conversationId: 'conversation-a',
        parentMessageId: 'parent-a',
        message: {
          messageId: 'follow-up-a',
          text: 'Recovered insight.',
          revision: 2,
          metadata: { viventium: { cortexPresentationGeneration: 4 } },
        },
        recoveryContext: { streamId: 'stream-a', messageRevision: 2, claimGeneration: 4 },
        presentationFence: presentationFence({ generation: 4 }),
        receiptWaitMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'cortex_telegram_presentation_receipt_unavailable' });
    expect(Message.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'follow-up-a',
        'metadata.viventium.deliveryAcknowledgement.revision': 2,
        'metadata.viventium.deliveryAcknowledgement.cortex_presentation_generation': 4,
      }),
    );
  });

  test('rejects an attempt-N Telegram acknowledgement after restart reclaims generation N+1', async () => {
    mockFindOneLean({
      messageId: 'follow-up-reclaimed',
      metadata: {
        viventium: {
          messageRevision: 2,
          cortexPresentationGeneration: 3,
          deliveryAcknowledgement: {
            state: 'committed',
            revision: 2,
            cortex_presentation_generation: 3,
            presentation_ref: 'telegram:chat-a:message-41',
          },
        },
      },
    });

    await expect(
      presentRecoveredCortexSurface({
        surface: 'telegram',
        ownerId: 'owner-a',
        conversationId: 'conversation-a',
        parentMessageId: 'parent-a',
        message: {
          messageId: 'follow-up-reclaimed',
          text: 'Recovered insight.',
          revision: 2,
          metadata: { viventium: { cortexPresentationGeneration: 3 } },
        },
        recoveryContext: { streamId: 'stream-a', messageRevision: 2, claimGeneration: 4 },
        presentationFence: presentationFence({
          messageId: 'follow-up-reclaimed',
          generation: 4,
        }),
        receiptWaitMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'cortex_telegram_presentation_receipt_unavailable' });
    expect(Message.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'follow-up-reclaimed',
        'metadata.viventium.deliveryAcknowledgement.cortex_presentation_generation': 4,
      }),
    );
  });

  test('keeps restart generation N+1 pending when the persisted Message only acknowledges N', async () => {
    const staleMessage = {
      messageId: 'follow-up-reclaimed',
      text: 'Recovered insight.',
      revision: 2,
      metadata: {
        viventium: {
          messageRevision: 2,
          cortexPresentationGeneration: 3,
          deliveryAcknowledgement: {
            state: 'committed',
            revision: 2,
            cortex_presentation_generation: 3,
            presentation_ref: 'telegram:chat-a:message-41',
          },
        },
      },
    };
    mockFindOneLean(staleMessage);
    const currentClaim = {
      deliveryId: 'cidl-reclaimed',
      claimToken: 'claim-current',
      claimGeneration: 4,
      attemptNumber: 2,
      persistedMessageId: 'follow-up-reclaimed',
      requiredSurfaces: ['telegram'],
      presentedSurfaces: [],
    };
    const deliveryService = {
      listRecoverableParents: jest.fn().mockResolvedValue([
        {
          ownerId: 'owner-a',
          conversationId: 'conversation-a',
          parentMessageId: 'parent-a',
          surface: 'telegram',
        },
      ]),
      claimPendingByParent: jest.fn().mockResolvedValue({
        deliveries: [currentClaim],
        claimed: [currentClaim],
        insights: [{ cortexId: 'review', insight: 'Recovered insight.', status: 'completed' }],
        recoveryContext: { messageRevision: 2, claimGeneration: 4 },
      }),
      markPersisted: jest.fn().mockResolvedValue([currentClaim]),
      markPresented: jest.fn(),
      finalizePresented: jest.fn(),
      markFailed: jest.fn().mockResolvedValue([{ ...currentClaim, status: 'pending' }]),
    };

    const result = await recoverPending({
      deliveryService,
      presentSurface: (params) => presentRecoveredCortexSurface({ ...params, receiptWaitMs: 0 }),
    });

    expect(result).toEqual(expect.objectContaining({ sent: 0, pending: 1 }));
    expect(Message.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'follow-up-reclaimed' }),
      {
        $set: {
          'metadata.viventium.messageRevision': 2,
          'metadata.viventium.cortexPresentationGeneration': 4,
          'metadata.viventium.cortexPresentationClaimToken': 'claim-current',
          'metadata.viventium.cortexPresentationParentMessageId': 'parent-a',
        },
      },
    );
    expect(deliveryService.markPresented).not.toHaveBeenCalled();
    expect(deliveryService.markFailed).toHaveBeenCalledWith({
      ownerId: 'owner-a',
      claims: [currentClaim],
      reason: 'presentation_failed',
    });
  });

  test('does not invent a Telegram receipt when the adapter has not acknowledged presentation', async () => {
    await expect(
      presentRecoveredCortexSurface({
        surface: 'telegram',
        ownerId: 'owner-a',
        conversationId: 'conversation-a',
        parentMessageId: 'parent-a',
        message: { messageId: 'follow-up-a', text: 'Recovered insight.', revision: 2 },
        recoveryContext: { streamId: 'stream-a', messageRevision: 2, claimGeneration: 1 },
        presentationFence: presentationFence({ generation: 1 }),
        receiptWaitMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'cortex_telegram_presentation_receipt_unavailable' });
  });

  test('does not credit a committed parent Telegram receipt to the follow-up delivery', async () => {
    Message.findOne.mockImplementation((filter) => ({
      lean: jest.fn().mockResolvedValue(
        filter?.messageId?.$in
          ? {
              messageId: 'parent-a',
              metadata: {
                viventium: {
                  deliveryAcknowledgement: {
                    state: 'committed',
                    revision: 2,
                    presentation_ref: 'telegram:chat-a:message-40',
                  },
                },
              },
            }
          : null,
      ),
    }));

    await expect(
      presentRecoveredCortexSurface({
        surface: 'telegram',
        ownerId: 'owner-a',
        conversationId: 'conversation-a',
        parentMessageId: 'parent-a',
        message: { messageId: 'follow-up-a', text: 'Recovered insight.', revision: 2 },
        recoveryContext: { streamId: 'stream-a', messageRevision: 2, claimGeneration: 1 },
        presentationFence: presentationFence({ generation: 1 }),
        receiptWaitMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'cortex_telegram_presentation_receipt_unavailable' });
  });

  test('does not credit a stale acknowledgement preserved on a promoted parent revision', async () => {
    mockFindOneLean({
      messageId: 'parent-a',
      metadata: {
        viventium: {
          messageRevision: 5,
          cortexPresentationGeneration: 5,
          deliveryAcknowledgement: {
            state: 'committed',
            revision: 4,
            presentation_ref: 'telegram:chat-a:message-40',
          },
        },
      },
    });

    await expect(
      presentRecoveredCortexSurface({
        surface: 'telegram',
        ownerId: 'owner-a',
        conversationId: 'conversation-a',
        parentMessageId: 'parent-a',
        message: {
          messageId: 'parent-a',
          text: 'Recovered insight.',
          revision: 5,
          metadata: { viventium: { cortexPresentationGeneration: 5 } },
        },
        recoveryContext: { streamId: 'stream-a', messageRevision: 5, claimGeneration: 5 },
        presentationFence: presentationFence({
          messageId: 'parent-a',
          revision: 5,
          generation: 5,
        }),
        receiptWaitMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'cortex_telegram_presentation_receipt_unavailable' });
    expect(Message.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'parent-a',
        'metadata.viventium.deliveryAcknowledgement.revision': 5,
      }),
    );
  });

  test('rejects an unsupported recovery surface instead of returning no receipt', async () => {
    await expect(
      presentRecoveredCortexSurface({
        surface: 'voice',
        ownerId: 'owner-a',
        parentMessageId: 'parent-a',
        conversationId: 'conversation-a',
        message: { messageId: 'follow-up-a', text: 'Recovered insight.', revision: 1 },
        recoveryContext: { streamId: 'stream-a', messageRevision: 1 },
      }),
    ).rejects.toMatchObject({ code: 'cortex_surface_delivery_adapter_unavailable' });
  });

  test('defers recovery while the canonical Main parent is still unfinished', async () => {
    const parent = {
      ownerId: 'owner-active',
      conversationId: 'conversation-active',
      parentMessageId: 'parent-active',
      surface: 'telegram',
    };
    const loadParentState = jest.fn().mockResolvedValue({
      messageId: parent.parentMessageId,
      unfinished: true,
    });
    const deliveryService = {
      listRecoverableParents: jest.fn().mockResolvedValue([parent]),
      deferRecoverableParent: jest.fn().mockResolvedValue({
        deferred: 1,
        reason: 'parent_generation_active',
      }),
      claimPendingByParent: jest.fn().mockResolvedValue({
        deliveries: [],
        claimed: [],
        insights: [],
        recoveryContext: {},
      }),
    };
    const createMessage = jest.fn();
    const presentSurface = jest.fn();

    const result = await recoverPending({
      deliveryService,
      loadParentState,
      createMessage,
      presentSurface,
    });

    expect(result).toEqual(
      expect.objectContaining({
        scanned: 1,
        claimed: 0,
        persisted: 0,
        presented: 0,
        sent: 0,
        pending: 1,
        failed: 0,
      }),
    );
    expect(loadParentState).toHaveBeenCalledWith(parent);
    expect(deliveryService.deferRecoverableParent).toHaveBeenCalledWith({
      ownerId: parent.ownerId,
      parentMessageId: parent.parentMessageId,
      surface: parent.surface,
      reason: 'parent_generation_active',
    });
    expect(deliveryService.claimPendingByParent).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
    expect(presentSurface).not.toHaveBeenCalled();
  });

  test('defers recovery while the canonical Main parent is not yet available', async () => {
    const parent = {
      ownerId: 'owner-missing',
      conversationId: 'conversation-missing',
      parentMessageId: 'parent-missing',
      surface: 'telegram',
    };
    const loadParentState = jest.fn().mockResolvedValue(null);
    const deliveryService = {
      listRecoverableParents: jest.fn().mockResolvedValue([parent]),
      deferRecoverableParent: jest.fn().mockResolvedValue({
        deferred: 1,
        reason: 'parent_state_unavailable',
      }),
      claimPendingByParent: jest.fn().mockRejectedValue(new Error('must not claim')),
    };
    const createMessage = jest.fn();
    const presentSurface = jest.fn();

    const result = await recoverPending({
      deliveryService,
      loadParentState,
      createMessage,
      presentSurface,
    });

    expect(result).toEqual(
      expect.objectContaining({
        scanned: 1,
        claimed: 0,
        persisted: 0,
        presented: 0,
        sent: 0,
        pending: 1,
        failed: 0,
      }),
    );
    expect(loadParentState).toHaveBeenCalledWith(parent);
    expect(deliveryService.deferRecoverableParent).toHaveBeenCalledWith({
      ownerId: parent.ownerId,
      parentMessageId: parent.parentMessageId,
      surface: parent.surface,
      reason: 'parent_state_unavailable',
    });
    expect(deliveryService.claimPendingByParent).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
    expect(presentSurface).not.toHaveBeenCalled();
  });

  test('yields an authority-bound Web-presented Telegram row to the durable bot dispatcher', async () => {
    const parent = {
      ownerId: 'owner-bound-telegram',
      conversationId: 'conversation-bound-telegram',
      parentMessageId: 'parent-bound-telegram',
      surface: 'telegram',
    };
    const deliveryService = {
      listRecoverableParents: jest.fn().mockResolvedValue([parent]),
      claimPendingByParent: jest.fn().mockRejectedValue(new Error('must not claim')),
    };
    const hasDurableTelegramDispatchAuthority = jest.fn().mockResolvedValue(true);

    const result = await recoverPending({
      deliveryService,
      loadParentState: jest.fn().mockResolvedValue({
        messageId: parent.parentMessageId,
        unfinished: false,
      }),
      hasDurableTelegramDispatchAuthority,
    });

    expect(result).toEqual(
      expect.objectContaining({ scanned: 1, claimed: 0, pending: 1, failed: 0 }),
    );
    expect(hasDurableTelegramDispatchAuthority).toHaveBeenCalledWith(parent);
    expect(deliveryService.claimPendingByParent).not.toHaveBeenCalled();
  });

  test('drops an unsupported surface as a typed terminal batch without creating a message', async () => {
    const parent = {
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
      surface: 'voice',
    };
    const claimed = {
      deliveryId: 'cidl_voice',
      claimToken: 'cidl_claim',
      claimGeneration: 1,
      attemptNumber: 1,
      requiredSurfaces: ['voice'],
      presentedSurfaces: [],
    };
    const deliveryService = {
      listRecoverableParents: jest.fn().mockResolvedValue([parent]),
      claimPendingByParent: jest.fn().mockResolvedValue({
        claimId: 'cidl_claim',
        deliveries: [claimed],
        claimed: [claimed],
        insights: [{ cortexId: 'review', insight: 'Recovered insight.', status: 'completed' }],
        recoveryContext: { streamId: 'stream-a', messageRevision: 1 },
      }),
      markDropped: jest.fn().mockResolvedValue([{ ...claimed, status: 'dropped' }]),
      markFailed: jest.fn(),
    };
    const createMessage = jest.fn();
    const presentSurface = jest.fn();

    const result = await recoverPending({
      deliveryService,
      createMessage,
      presentSurface,
    });

    expect(result).toEqual(expect.objectContaining({ dropped: 1, pending: 0 }));
    expect(deliveryService.markDropped).toHaveBeenCalledWith({
      ownerId: 'owner-a',
      claims: [claimed],
      dropReason: 'unsupported_surface',
    });
    expect(createMessage).not.toHaveBeenCalled();
    expect(presentSurface).not.toHaveBeenCalled();
  });

  test('isolates one parent claim failure and continues recovery for later parents', async () => {
    const failedParent = {
      ownerId: 'owner-failed',
      conversationId: 'conversation-failed',
      parentMessageId: 'parent-failed',
      surface: 'web',
    };
    const healthyParent = {
      ownerId: 'owner-healthy',
      conversationId: 'conversation-healthy',
      parentMessageId: 'parent-healthy',
      surface: 'web',
    };
    const healthyClaim = {
      deliveryId: 'cidl-healthy',
      claimToken: 'claim-healthy',
      claimGeneration: 1,
      attemptNumber: 1,
      requiredSurfaces: ['web'],
      presentedSurfaces: [],
    };
    const deliveryService = {
      listRecoverableParents: jest.fn().mockResolvedValue([failedParent, healthyParent]),
      claimPendingByParent: jest.fn(async ({ parentMessageId }) => {
        if (parentMessageId === 'parent-failed') {
          throw Object.assign(new Error('claim store unavailable'), { code: 'claim_failed' });
        }
        return {
          claimId: 'claim-healthy',
          deliveries: [healthyClaim],
          claimed: [healthyClaim],
          insights: [{ cortexId: 'review', insight: 'Recovered insight.', status: 'completed' }],
          recoveryContext: { streamId: 'stream-healthy', messageRevision: 1, claimGeneration: 1 },
        };
      }),
      deferRecoverableParent: jest.fn().mockResolvedValue({
        deferred: 1,
        reason: 'recovery_claim_failed',
        recoveryAttemptNumber: 1,
      }),
      markPersisted: jest.fn().mockResolvedValue([healthyClaim]),
      markPresented: jest.fn().mockResolvedValue([healthyClaim]),
      finalizePresented: jest.fn().mockResolvedValue([{ ...healthyClaim, status: 'sent' }]),
      markFailed: jest.fn(),
      markDropped: jest.fn(),
    };

    const result = await recoverPending({
      deliveryService,
      createMessage: jest.fn().mockResolvedValue({
        messageId: 'follow-up-healthy',
        text: 'Recovered insight.',
        revision: 1,
      }),
      presentSurface: jest.fn(async ({ presentationFence: fence }) => ({
        surface: 'web',
        presentationGeneration: 1,
        presentationClaimToken: fence.claimToken,
        presentationLeaseToken: fence.presentationLeaseToken,
        presentationRef: 'sse:stream-healthy:follow-up-healthy:1',
      })),
    });

    expect(result).toEqual(expect.objectContaining({ scanned: 2, claimed: 1, sent: 1, failed: 1 }));
    expect(deliveryService.claimPendingByParent).toHaveBeenCalledTimes(2);
    expect(deliveryService.deferRecoverableParent).toHaveBeenCalledWith({
      ownerId: 'owner-failed',
      parentMessageId: 'parent-failed',
      surface: 'web',
      reason: 'recovery_claim_failed',
    });
  });

  test('drops a supported surface after the bounded recovery attempt fails', async () => {
    const parent = {
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
      surface: 'web',
    };
    const claimed = {
      deliveryId: 'cidl_web',
      claimToken: 'cidl_claim',
      claimGeneration: 3,
      attemptNumber: 3,
      requiredSurfaces: ['web'],
      presentedSurfaces: [],
    };
    const deliveryService = {
      listRecoverableParents: jest.fn().mockResolvedValue([parent]),
      claimPendingByParent: jest.fn().mockResolvedValue({
        claimId: 'cidl_claim',
        deliveries: [claimed],
        claimed: [claimed],
        insights: [{ cortexId: 'review', insight: 'Recovered insight.', status: 'completed' }],
        recoveryContext: { streamId: 'stream-a', messageRevision: 1, claimGeneration: 2 },
      }),
      markPersisted: jest.fn().mockResolvedValue([claimed]),
      markDropped: jest.fn().mockResolvedValue([{ ...claimed, status: 'dropped' }]),
      markFailed: jest.fn(),
    };

    const result = await recoverPending({
      deliveryService,
      createMessage: jest.fn().mockResolvedValue({
        messageId: 'follow-up-a',
        text: 'Recovered insight.',
        revision: 1,
      }),
      presentSurface: jest
        .fn()
        .mockRejectedValue(Object.assign(new Error('stream unavailable'), { code: 'no_stream' })),
    });

    expect(result).toEqual(expect.objectContaining({ dropped: 1, pending: 0 }));
    expect(deliveryService.markDropped).toHaveBeenCalledWith({
      ownerId: 'owner-a',
      claims: [claimed],
      dropReason: 'delivery_attempts_exhausted',
    });
    expect(deliveryService.markFailed).not.toHaveBeenCalled();
  });

  test('reacquires attempt three after the message creator returns the stale claim to pending', async () => {
    const parent = {
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
      surface: 'web',
    };
    const staleClaim = {
      deliveryId: 'cidl_web',
      claimToken: 'cidl_claim_stale',
      claimGeneration: 3,
      attemptNumber: 3,
      requiredSurfaces: ['web'],
      presentedSurfaces: [],
    };
    const terminalClaim = {
      ...staleClaim,
      claimToken: 'cidl_claim_terminal',
      claimGeneration: 4,
    };
    const deliveryService = {
      listRecoverableParents: jest.fn().mockResolvedValue([parent]),
      claimPendingByParent: jest
        .fn()
        .mockResolvedValueOnce({
          claimId: staleClaim.claimToken,
          deliveries: [staleClaim],
          claimed: [staleClaim],
          insights: [{ cortexId: 'review', insight: 'Recovered insight.', status: 'completed' }],
          recoveryContext: { streamId: 'stream-a', messageRevision: 1 },
        })
        .mockResolvedValueOnce({
          claimId: terminalClaim.claimToken,
          deliveries: [terminalClaim],
          claimed: [terminalClaim],
          insights: [{ cortexId: 'review', insight: 'Recovered insight.', status: 'completed' }],
          recoveryContext: { streamId: 'stream-a', messageRevision: 1 },
        }),
      markFailed: jest.fn().mockResolvedValue([{ ...staleClaim, status: 'pending' }]),
      markDropped: jest
        .fn()
        .mockRejectedValueOnce(new Error('Cortex insight delivery transition conflict'))
        .mockResolvedValueOnce([{ ...terminalClaim, status: 'dropped' }]),
    };
    const createMessage = jest.fn(async () => {
      await deliveryService.markFailed({
        ownerId: parent.ownerId,
        claims: [staleClaim],
        reason: 'durable_surface_persistence_failed',
      });
      throw new Error('synthetic persistence failure');
    });

    const result = await recoverPending({
      deliveryService,
      createMessage,
      presentSurface: jest.fn(),
    });

    expect(result).toEqual(expect.objectContaining({ dropped: 1, pending: 0 }));
    expect(deliveryService.claimPendingByParent).toHaveBeenLastCalledWith({
      ownerId: 'owner-a',
      parentMessageId: 'parent-a',
      surface: 'web',
      terminalSettlement: true,
    });
    expect(deliveryService.markDropped).toHaveBeenLastCalledWith({
      ownerId: 'owner-a',
      claims: [terminalClaim],
      dropReason: 'delivery_attempts_exhausted',
    });
  });

  test('returns a missing persistence receipt to the bounded retry ledger', async () => {
    const parent = {
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
      surface: 'web',
    };
    const claimed = {
      deliveryId: 'cidl_web',
      claimToken: 'cidl_claim',
      claimGeneration: 1,
      attemptNumber: 1,
      requiredSurfaces: ['web'],
      presentedSurfaces: [],
    };
    const deliveryService = {
      listRecoverableParents: jest.fn().mockResolvedValue([parent]),
      claimPendingByParent: jest.fn().mockResolvedValue({
        claimId: 'cidl_claim',
        deliveries: [claimed],
        claimed: [claimed],
        insights: [{ cortexId: 'review', insight: 'Recovered insight.', status: 'completed' }],
        recoveryContext: { streamId: 'stream-a', messageRevision: 1 },
      }),
      markFailed: jest.fn().mockResolvedValue([{ ...claimed, status: 'pending' }]),
      markDropped: jest.fn(),
    };

    const result = await recoverPending({
      deliveryService,
      createMessage: jest.fn().mockResolvedValue(null),
      presentSurface: jest.fn(),
    });

    expect(result).toEqual(expect.objectContaining({ pending: 1, dropped: 0 }));
    expect(deliveryService.markFailed).toHaveBeenCalledWith({
      ownerId: 'owner-a',
      claims: [claimed],
      reason: 'durable_surface_persistence_failed',
    });
  });

  test('admits traffic only through the awaited stream-readiness gate before Cortex recovery', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../index.js'), 'utf8');
    expect(source).toContain('await initializeStreamServicesBeforeTraffic({ admitTraffic })');
    expect(source).toContain('const admitTraffic = () => app.listen(...apiListenTarget.args, onServerListening)');
    const callbackAt = source.indexOf('const onServerListening = async (err) =>');
    const recoveryAt = source.indexOf('await recoverStaleCortexMessages();', callbackAt);
    const periodicAt = source.indexOf('getStaleCortexRecoveryIntervalMs()', recoveryAt);
    expect(callbackAt).toBeGreaterThan(-1);
    expect(recoveryAt).toBeGreaterThan(callbackAt);
    expect(periodicAt).toBeGreaterThan(recoveryAt);
  });

  test('reuses one persisted follow-up and its receipts across restart recovery', async () => {
    const parent = {
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
      surface: 'telegram',
    };
    const claimed = {
      deliveryId: 'cidl_pending',
      claimToken: 'cidl_claim',
      claimGeneration: 2,
      persistedMessageId: 'follow-up-a',
      requiredSurfaces: ['web', 'telegram'],
      presentedSurfaces: ['web', 'telegram'],
    };
    const deliveryService = {
      listRecoverableParents: jest.fn().mockResolvedValueOnce([parent]).mockResolvedValueOnce([]),
      claimPendingByParent: jest.fn().mockResolvedValue({
        claimId: 'cidl_claim',
        deliveries: [
          {
            deliveryId: 'cidl_sent',
            status: 'sent',
            persistedMessageId: 'follow-up-a',
          },
          claimed,
        ],
        claimed: [claimed],
        insights: [{ cortexId: 'review', insight: 'Recovered insight.', status: 'completed' }],
        recoveryContext: { streamId: 'stream-a', messageRevision: 1 },
      }),
      markPersisted: jest.fn().mockResolvedValue([claimed]),
      markPresented: jest.fn(),
      finalizePresented: jest.fn().mockResolvedValue([{ ...claimed, status: 'sent' }]),
      markFailed: jest.fn(),
    };
    const createMessage = jest.fn();
    const loadMessage = jest.fn().mockResolvedValue({
      messageId: 'follow-up-a',
      text: 'Recovered insight.',
      revision: 1,
    });
    const presentSurface = jest.fn();

    const first = await recoverPending({
      deliveryService,
      createMessage,
      loadMessage,
      presentSurface,
    });
    const second = await recoverPending({
      deliveryService,
      createMessage,
      loadMessage,
      presentSurface,
    });

    expect(first).toEqual(expect.objectContaining({ sent: 1, pending: 0 }));
    expect(second).toEqual(expect.objectContaining({ scanned: 0, sent: 0, pending: 0 }));
    expect(loadMessage).toHaveBeenCalledTimes(1);
    expect(createMessage).not.toHaveBeenCalled();
    expect(presentSurface).not.toHaveBeenCalled();
    expect(deliveryService.finalizePresented).toHaveBeenCalledTimes(1);
  });

  test('rejects a persisted follow-up outside the exact conversation and parent scope', async () => {
    const parent = {
      ownerId: 'owner-scope',
      conversationId: 'conversation-scope',
      parentMessageId: 'parent-scope',
      surface: 'web',
    };
    const claimed = {
      deliveryId: 'cidl-scope',
      claimToken: 'claim-scope',
      claimGeneration: 2,
      attemptNumber: 1,
      persistedMessageId: 'follow-up-reused-id',
      requiredSurfaces: ['web'],
      presentedSurfaces: ['web'],
    };
    const wrongConversationMessage = {
      messageId: 'follow-up-reused-id',
      conversationId: 'conversation-other',
      text: 'Wrong conversation result.',
      revision: 1,
      metadata: {
        viventium: {
          type: 'cortex_followup',
          parentMessageId: 'parent-other',
          cortexPresentationGeneration: 1,
        },
      },
    };
    Message.findOne.mockImplementation((query) => {
      const exactScope =
        query.user === parent.ownerId &&
        query.conversationId === parent.conversationId &&
        query.messageId === claimed.persistedMessageId &&
        query['metadata.viventium.type'] === 'cortex_followup' &&
        query['metadata.viventium.cortexPresentationParentMessageId'] === parent.parentMessageId;
      return { lean: jest.fn().mockResolvedValue(exactScope ? null : wrongConversationMessage) };
    });
    const deliveryService = {
      listRecoverableParents: jest.fn().mockResolvedValue([parent]),
      claimPendingByParent: jest.fn().mockResolvedValue({
        claimId: claimed.claimToken,
        deliveries: [claimed],
        claimed: [claimed],
        insights: [{ cortexId: 'review', insight: 'Exact result.', status: 'completed' }],
        recoveryContext: { streamId: 'stream-scope', messageRevision: 1 },
      }),
      markPersisted: jest.fn().mockResolvedValue([claimed]),
      markPresented: jest.fn(),
      finalizePresented: jest.fn().mockResolvedValue([{ ...claimed, status: 'sent' }]),
      markFailed: jest.fn().mockResolvedValue([{ ...claimed, status: 'pending' }]),
    };
    const createMessage = jest.fn();

    const result = await recoverPending({ deliveryService, createMessage });

    expect(result).toEqual(expect.objectContaining({ sent: 0, pending: 1 }));
    expect(Message.findOne).toHaveBeenCalledWith({
      user: parent.ownerId,
      conversationId: parent.conversationId,
      messageId: claimed.persistedMessageId,
      isCreatedByUser: { $ne: true },
      'metadata.viventium.type': 'cortex_followup',
      'metadata.viventium.cortexPresentationParentMessageId': parent.parentMessageId,
    });
    expect(createMessage).not.toHaveBeenCalled();
    expect(Message.updateOne).not.toHaveBeenCalled();
    expect(deliveryService.markPersisted).not.toHaveBeenCalled();
    expect(deliveryService.markFailed).toHaveBeenCalledWith({
      ownerId: parent.ownerId,
      claims: [claimed],
      reason: 'durable_surface_persistence_failed',
    });
  });

  test('reuses a promoted empty-parent follow-up through its exact presentation parent binding', async () => {
    const parent = {
      ownerId: 'owner-promoted',
      conversationId: 'conversation-promoted',
      parentMessageId: 'assistant-empty-parent',
      surface: 'web',
    };
    const claimed = {
      deliveryId: 'cidl-promoted',
      claimToken: 'claim-promoted-recovered',
      claimGeneration: 3,
      attemptNumber: 1,
      persistedMessageId: 'assistant-empty-parent',
      requiredSurfaces: ['web'],
      presentedSurfaces: ['web'],
    };
    const promotedMessage = {
      messageId: 'assistant-empty-parent',
      conversationId: parent.conversationId,
      parentMessageId: 'user-parent',
      text: 'Recovered promoted result.',
      revision: 2,
      metadata: {
        viventium: {
          type: 'cortex_followup',
          parentMessageId: 'user-parent',
          promotedToEmptyParent: true,
          cortexPresentationParentMessageId: parent.parentMessageId,
          cortexPresentationGeneration: 2,
          cortexPresentationClaimToken: 'claim-promoted-stored',
        },
      },
    };
    Message.findOne.mockImplementation((query) => ({
      lean: jest
        .fn()
        .mockResolvedValue(
          query.user === parent.ownerId &&
            query.conversationId === parent.conversationId &&
            query.messageId === claimed.persistedMessageId &&
            query['metadata.viventium.type'] === 'cortex_followup' &&
            query['metadata.viventium.cortexPresentationParentMessageId'] === parent.parentMessageId
            ? promotedMessage
            : null,
        ),
    }));
    const deliveryService = {
      listRecoverableParents: jest.fn().mockResolvedValue([parent]),
      claimPendingByParent: jest.fn().mockResolvedValue({
        claimId: claimed.claimToken,
        deliveries: [claimed],
        claimed: [claimed],
        insights: [{ cortexId: 'review', insight: 'Recovered result.', status: 'completed' }],
        recoveryContext: { streamId: 'stream-promoted', messageRevision: 2 },
      }),
      markPersisted: jest.fn().mockResolvedValue([claimed]),
      markPresented: jest.fn(),
      finalizePresented: jest.fn().mockResolvedValue([{ ...claimed, status: 'sent' }]),
      markFailed: jest.fn(),
    };
    const createMessage = jest.fn();

    await expect(recoverPending({ deliveryService, createMessage })).resolves.toEqual(
      expect.objectContaining({ sent: 1, pending: 0 }),
    );
    expect(createMessage).not.toHaveBeenCalled();
    expect(Message.updateOne).toHaveBeenCalledWith(
      {
        user: parent.ownerId,
        conversationId: parent.conversationId,
        messageId: promotedMessage.messageId,
        isCreatedByUser: { $ne: true },
        'metadata.viventium.type': 'cortex_followup',
        'metadata.viventium.cortexPresentationParentMessageId': parent.parentMessageId,
        $or: [
          { 'metadata.viventium.cortexPresentationGeneration': { $exists: false } },
          { 'metadata.viventium.cortexPresentationGeneration': { $lt: 3 } },
          {
            'metadata.viventium.cortexPresentationGeneration': 3,
            'metadata.viventium.cortexPresentationClaimToken': { $in: ['', null] },
          },
        ],
      },
      {
        $set: {
          'metadata.viventium.messageRevision': 2,
          'metadata.viventium.cortexPresentationGeneration': 3,
          'metadata.viventium.cortexPresentationClaimToken': claimed.claimToken,
          'metadata.viventium.cortexPresentationParentMessageId': parent.parentMessageId,
        },
      },
    );
    expect(deliveryService.markPersisted).toHaveBeenCalledWith({
      ownerId: parent.ownerId,
      claims: [claimed],
      persistedMessageId: promotedMessage.messageId,
      messageRevision: 2,
    });
  });

  test('rejects multiple distinct persisted follow-up IDs before lookup or mutation', async () => {
    const parent = {
      ownerId: 'owner-multiple',
      conversationId: 'conversation-multiple',
      parentMessageId: 'parent-multiple',
      surface: 'web',
    };
    const claimed = {
      deliveryId: 'cidl-multiple',
      claimToken: 'claim-multiple',
      claimGeneration: 2,
      attemptNumber: 1,
      persistedMessageId: 'follow-up-a',
      requiredSurfaces: ['web'],
      presentedSurfaces: [],
    };
    const deliveryService = {
      listRecoverableParents: jest.fn().mockResolvedValue([parent]),
      claimPendingByParent: jest.fn().mockResolvedValue({
        claimId: claimed.claimToken,
        deliveries: [
          claimed,
          { ...claimed, deliveryId: 'cidl-multiple-b', persistedMessageId: 'follow-up-b' },
        ],
        claimed: [claimed],
        insights: [{ cortexId: 'review', insight: 'Recovered result.', status: 'completed' }],
        recoveryContext: { streamId: 'stream-multiple', messageRevision: 1 },
      }),
      markPersisted: jest.fn(),
      markPresented: jest.fn(),
      finalizePresented: jest.fn(),
      markFailed: jest.fn().mockResolvedValue([{ ...claimed, status: 'pending' }]),
    };
    const loadMessage = jest.fn();
    const createMessage = jest.fn();
    const bindMessageGeneration = jest.fn();
    const presentSurface = jest.fn();

    await expect(
      recoverPending({
        deliveryService,
        loadMessage,
        createMessage,
        bindMessageGeneration,
        presentSurface,
      }),
    ).resolves.toEqual(expect.objectContaining({ sent: 0, pending: 1 }));
    expect(loadMessage).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
    expect(bindMessageGeneration).not.toHaveBeenCalled();
    expect(Message.updateOne).not.toHaveBeenCalled();
    expect(presentSurface).not.toHaveBeenCalled();
    expect(deliveryService.markPersisted).not.toHaveBeenCalled();
    expect(deliveryService.markFailed).toHaveBeenCalledWith({
      ownerId: parent.ownerId,
      claims: [claimed],
      reason: 'durable_surface_persistence_failed',
    });
    expect(deliveryService.markPresented).not.toHaveBeenCalled();
    expect(deliveryService.finalizePresented).not.toHaveBeenCalled();
  });

  test('repairs finished blank messages that still contain active cortex rows', async () => {
    process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_MS = '1000';
    process.env.VIVENTIUM_CORTEX_EXECUTION_TIMEOUT_MS = '500';
    process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_GRACE_MS = '250';
    const now = new Date('2026-05-06T12:00:00.000Z');
    mockFindLean([
      {
        _id: 'mongo-id-blank',
        messageId: 'msg-blank',
        createdAt: new Date('2026-05-06T11:59:00.000Z'),
        updatedAt: new Date('2026-05-06T11:59:01.000Z'),
        unfinished: false,
        error: false,
        text: '',
        content: [
          { type: ContentTypes.CORTEX_BREWING, cortex_id: 'a', status: 'brewing' },
          { type: ContentTypes.CORTEX_BREWING, cortex_id: 'b', status: 'brewing' },
        ],
      },
    ]);

    const result = await recoverStale({ now });

    expect(result).toEqual(expect.objectContaining({ scanned: 1, repaired: 1, timeoutMs: 1000 }));
    expect(Message.updateOne).toHaveBeenCalledWith(
      { _id: 'mongo-id-blank', updatedAt: new Date('2026-05-06T11:59:01.000Z'),
        'nativeResponse.status': { $nin: ['pending', 'prepared'] } },
      {
        $set: expect.objectContaining({
          unfinished: false,
          content: [
            expect.objectContaining({ status: 'error', cortex_id: 'a' }),
            expect.objectContaining({ status: 'error', cortex_id: 'b' }),
          ],
        }),
      },
    );
  });

  test('keeps stale cutoff beyond the configured cortex execution timeout', async () => {
    process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_MS = '1000';
    process.env.VIVENTIUM_CORTEX_EXECUTION_TIMEOUT_MS = '5000';
    process.env.VIVENTIUM_STALE_CORTEX_RECOVERY_GRACE_MS = '250';
    mockFindLean([]);

    const result = await recoverStale({
      now: new Date('2026-05-06T12:00:00.000Z'),
    });

    expect(result).toEqual(
      expect.objectContaining({
        timeoutMs: 5250,
        cortexExecutionTimeoutMs: 5000,
        graceMs: 250,
      }),
    );
  });

  test('keeps scheduled stale hold text suppressed', async () => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    mockFindLean([
      {
        _id: 'mongo-id-2',
        messageId: 'msg-2',
        updatedAt: new Date('2026-05-06T11:59:01.000Z'),
        unfinished: true,
        metadata: { viventium: { scheduleId: 'sched-1' } },
        content: [
          {
            type: 'text',
            text: 'Checking now.',
            viventium_runtime_hold: true,
          },
          { type: ContentTypes.CORTEX_BREWING, cortex_id: 'a', status: 'brewing' },
        ],
      },
    ]);

    await recoverStale({ now });

    expect(Message.updateOne).toHaveBeenCalledWith(expect.any(Object), {
      $set: expect.not.objectContaining({
        text: expect.any(String),
      }),
    });
  });
});
