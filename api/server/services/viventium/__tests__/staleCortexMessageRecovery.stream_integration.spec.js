const {
  GenerationJobManager,
  InMemoryEventTransport,
  InMemoryJobStore,
} = require('@librechat/api');

const mockMessageUpdateOne = jest.fn();

jest.mock('~/db/models', () => ({
  Message: {
    find: jest.fn(),
    findOne: jest.fn(),
    updateOne: (...args) => mockMessageUpdateOne(...args),
  },
}));

jest.mock('~/server/services/viventium/CortexInsightOutboxService', () => ({
  replayCompletedCortexInsightOutbox: jest.fn(async () => ({
    scanned: 0,
    replayed: 0,
    pending: 0,
  })),
}));

const { recoverPendingCortexInsightDeliveries } = require('../staleCortexMessageRecovery');

const graphResultHash = 'a'.repeat(64);

describe('stale Cortex Telegram restart integration', () => {
  beforeEach(async () => {
    await GenerationJobManager.destroy();
    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    await GenerationJobManager.initialize();
    await GenerationJobManager.createJob('stream-restart', 'owner-a', 'conversation-a', {
      interactionContext: {
        actor_kind: 'external_user',
        origin: 'interactive',
        surface: 'telegram',
        conversation_id: 'conversation-a',
        logical_turn_id: 'turn-restart',
        revision: 1,
        source_event_id: 'source-restart',
      },
      deliveryPolicy: { commit_authority: 'external_adapter' },
    });
    await GenerationJobManager.updateMetadata('stream-restart', {
      responseMessageId: 'parent-a',
    });
    mockMessageUpdateOne.mockReset().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  });

  afterEach(async () => {
    await GenerationJobManager.destroy();
  });

  test('binds the fresh Telegram-only recovery claim to the real stream and settles once', async () => {
    const parent = {
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
      surface: 'telegram',
    };
    const claimed = {
      deliveryId: 'cidl_pending',
      claimToken: 'cidl_claim_restart',
      claimGeneration: 2,
      graphResultHash,
      persistedMessageId: 'follow-up-a',
      requiredSurfaces: ['web', 'telegram'],
      presentedSurfaces: ['web'],
    };
    const presentationFence = {
      ownerId: 'owner-a',
      claims: [{ ...claimed, presentationLeaseToken: 'lease-restart' }],
      deliveryIds: ['cidl_pending'],
      deliveryReceipts: [{ deliveryId: 'cidl_pending', graphResultHash }],
      generation: 2,
      claimToken: 'cidl_claim_restart',
      presentationLeaseToken: 'lease-restart',
      messageId: 'follow-up-a',
      parentMessageId: 'parent-a',
      revision: 1,
      surface: 'telegram',
    };
    const deliveryService = {
      listRecoverableParents: jest.fn().mockResolvedValueOnce([parent]).mockResolvedValueOnce([]),
      claimPendingByParent: jest.fn().mockResolvedValue({
        claimId: claimed.claimToken,
        deliveries: [claimed],
        claimed: [claimed],
        insights: [{ cortexId: 'review', insight: 'Recovered insight.', status: 'completed' }],
        recoveryContext: { streamId: 'stream-restart', messageRevision: 1 },
      }),
      markPersisted: jest.fn().mockResolvedValue([claimed]),
      fencePresentation: jest.fn().mockResolvedValue(presentationFence),
      markPresented: jest
        .fn()
        .mockResolvedValue([{ ...claimed, presentedSurfaces: ['web', 'telegram'] }]),
      finalizePresented: jest.fn().mockResolvedValue([{ ...claimed, status: 'sent' }]),
      markFailed: jest.fn(),
    };
    let boundJob;
    let deliveryAcknowledgement;
    const presentSurface = jest.fn(
      async ({ presentationFence: currentFence, streamPresentationBinding }) => {
        boundJob = await GenerationJobManager.getJob('stream-restart');
        const interactionContext = boundJob?.metadata.interactionContext;
        deliveryAcknowledgement = await GenerationJobManager.acknowledgeDelivery(
          {
            logical_turn_id: interactionContext.logical_turn_id,
            revision: interactionContext.revision,
            state: 'committed',
            presentation_ref: 'telegram:chat-a:message-41',
          },
          'telegram',
          streamPresentationBinding,
        );
        return {
          surface: 'telegram',
          presentationGeneration: 2,
          presentationClaimToken: currentFence.claimToken,
          presentationLeaseToken: currentFence.presentationLeaseToken,
          presentationRef: 'telegram:chat-a:message-41',
        };
      },
    );

    const first = await recoverPendingCortexInsightDeliveries({
      deliveryService,
      replayOutbox: jest.fn(async () => ({ scanned: 0, replayed: 0, pending: 0 })),
      createMessage: jest.fn(),
      loadMessage: jest.fn().mockResolvedValue({
        messageId: 'follow-up-a',
        text: 'Recovered insight.',
        revision: 1,
      }),
      presentSurface,
    });
    const second = await recoverPendingCortexInsightDeliveries({
      deliveryService,
      replayOutbox: jest.fn(async () => ({ scanned: 0, replayed: 0, pending: 0 })),
      createMessage: jest.fn(),
      loadMessage: jest.fn(),
      presentSurface,
    });

    expect(first).toEqual(expect.objectContaining({ sent: 1, pending: 0 }));
    expect(second).toEqual(expect.objectContaining({ scanned: 0, sent: 0, pending: 0 }));
    expect(presentSurface).toHaveBeenCalledTimes(1);
    expect(deliveryService.markPresented).toHaveBeenCalledTimes(1);
    expect(deliveryService.finalizePresented).toHaveBeenCalledTimes(1);
    expect(boundJob?.metadata.cortexPresentation).toEqual(
      expect.objectContaining({
        generation: 2,
        claimToken: 'cidl_claim_restart',
        deliveryReceipts: [{ deliveryId: 'cidl_pending', graphResultHash }],
      }),
    );
    expect(deliveryAcknowledgement).toEqual(
      expect.objectContaining({
        status: 'recorded',
        presentation: expect.objectContaining({
          cortexPresentation: expect.objectContaining({
            generation: 2,
            deliveryReceipts: [{ deliveryId: 'cidl_pending', graphResultHash }],
          }),
        }),
      }),
    );
  });
});
