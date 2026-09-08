'use strict';

jest.mock(
  '@librechat/data-schemas',
  () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }),
  { virtual: true },
);

jest.mock('@librechat/api', () => ({ GenerationJobManager: {} }));
jest.mock('~/db/models', () => ({
  Message: {},
  ViventiumCortexInsightDelivery: {},
  ViventiumTelegramIngressEvent: {},
}));
jest.mock('~/server/services/TelegramLinkService', () => ({ resolveTelegramMapping: jest.fn() }));
jest.mock('~/server/services/viventium/CortexInsightDeliveryService', () => ({
  cortexInsightDeliveryService: {},
}));
jest.mock('~/server/services/viventium/staleCortexMessageRecovery', () => ({
  bindRecoveredCortexPresentationGeneration: jest.fn(),
}));

const {
  createCortexTelegramDeliveryDispatchService,
} = require('../CortexTelegramDeliveryDispatchService');

function query(result) {
  const chain = {
    select: jest.fn(() => chain),
    sort: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    lean: jest.fn(async () => result),
  };
  return chain;
}

function exactFixture() {
  const ownerId = 'owner-1';
  const conversationId = 'conversation-1';
  const parentMessageId = 'main-1';
  const persistedMessageId = 'followup-1';
  const streamId = 'telegram-stream-1';
  const sourceOrderScope = 'a'.repeat(64);
  const sourceEventId = 'b'.repeat(64);
  const logicalTurnId = 'logical-turn-1';
  const candidate = {
    deliveryId: 'cidl-1',
    userId: ownerId,
    conversationId,
    parentMessageId,
    persistedMessageId,
    persistenceStatus: 'persisted',
    presentationRevision: 2,
    messageRevision: 2,
    surface: 'telegram',
    streamId,
    requiredSurfaces: ['web', 'telegram'],
    presentedSurfaces: ['web'],
    status: 'pending',
    batchSize: 1,
  };
  const parent = {
    user: ownerId,
    conversationId,
    messageId: parentMessageId,
    unfinished: false,
    metadata: {
      viventium: {
        interactionContext: {
          surface: 'telegram',
          logical_turn_id: logicalTurnId,
          revision: 1,
          source_event_id: sourceEventId,
        },
      },
    },
  };
  const followup = {
    user: ownerId,
    conversationId,
    messageId: persistedMessageId,
    parentMessageId,
    text: 'A useful late result.',
    metadata: {
      viventium: {
        type: 'cortex_followup',
        messageRevision: 2,
        cortexPresentationParentMessageId: parentMessageId,
      },
    },
  };
  const ingress = {
    libreChatUserId: ownerId,
    telegramUserId: 'telegram-user-1',
    telegramChatId: '-100123',
    telegramMessageId: '81',
    telegramMessageThreadId: '9',
    sourceSequence: 81,
    sourceOrderScope,
    sourceEventId,
    streamId,
    conversationId,
    authorityBoundAt: new Date('2026-08-26T18:00:00.000Z'),
  };
  const job = {
    streamId,
    metadata: {
      userId: ownerId,
      conversationId,
      responseMessageId: parentMessageId,
      interactionContext: {
        surface: 'telegram',
        logical_turn_id: logicalTurnId,
        revision: 1,
        source_order_scope: sourceOrderScope,
        source_sequence: 81,
        source_event_id: sourceEventId,
      },
      deliveryPolicy: { commit_authority: 'external_adapter' },
    },
  };
  const claimed = {
    claimId: 'claim-2',
    claimed: [
      {
        ...candidate,
        status: 'claimed',
        claimToken: 'claim-2',
        claimGeneration: 2,
        attemptNumber: 2,
        graphResultHash: 'c'.repeat(64),
        leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    ],
    deliveries: [],
    recoveryContext: { streamId, messageRevision: 2, claimGeneration: 2 },
  };
  const fence = {
    ownerId,
    messageId: persistedMessageId,
    parentMessageId,
    revision: 2,
    generation: 2,
    deliveryIds: ['cidl-1'],
    deliveryReceipts: [{ deliveryId: 'cidl-1', graphResultHash: 'c'.repeat(64) }],
    claimToken: 'claim-2',
    presentationLeaseToken: 'presentation-lease-2',
    claims: claimed.claimed,
    surface: 'telegram',
  };
  return {
    ownerId,
    conversationId,
    parentMessageId,
    persistedMessageId,
    streamId,
    sourceOrderScope,
    sourceEventId,
    logicalTurnId,
    candidate,
    parent,
    followup,
    ingress,
    job,
    claimed,
    fence,
  };
}

function buildService(fixture = exactFixture()) {
  const DeliveryModel = {
    find: jest.fn(() => query([fixture.candidate])),
  };
  const MessageModel = {
    findOne: jest.fn((filter) =>
      query(filter.messageId === fixture.parentMessageId ? fixture.parent : fixture.followup),
    ),
  };
  const IngressModel = {
    findOne: jest.fn(() => query(fixture.ingress)),
  };
  const resolveTelegramMapping = jest.fn(async () => ({ libreChatUserId: fixture.ownerId }));
  const jobManager = {
    getJob: jest.fn(async () => fixture.job),
    bindCortexPresentation: jest.fn(async () => true),
  };
  const deliveryService = {
    claimPendingByParent: jest.fn(async () => fixture.claimed),
    fencePresentation: jest.fn(async () => fixture.fence),
    markFailed: jest.fn(async () => fixture.claimed.claimed),
    markDropped: jest.fn(async () => fixture.claimed.claimed),
  };
  const bindMessageGeneration = jest.fn(async (input) => ({ ...input.message, revision: 2 }));
  const service = createCortexTelegramDeliveryDispatchService({
    DeliveryModel,
    MessageModel,
    IngressModel,
    resolveTelegramMapping,
    jobManager,
    deliveryService,
    bindMessageGeneration,
  });
  return {
    service,
    DeliveryModel,
    MessageModel,
    IngressModel,
    resolveTelegramMapping,
    jobManager,
    deliveryService,
    bindMessageGeneration,
  };
}

describe('CortexTelegramDeliveryDispatchService', () => {
  test('claims one persisted Telegram-missing presentation with exact durable authority', async () => {
    const fixture = exactFixture();
    const dependencies = buildService(fixture);

    const deliveries = await dependencies.service.claimPending({ limit: 1, leaseMs: 120_000 });

    expect(deliveries).toEqual([
      {
        deliveryId: 'cidl-1',
        streamId: fixture.streamId,
        telegramChatId: '-100123',
        telegramUserId: 'telegram-user-1',
        telegramMessageId: '81',
        telegramMessageThreadId: '9',
        sourceSequence: 81,
        text: 'A useful late result.',
        logicalTurnId: fixture.logicalTurnId,
        logicalTurnRevision: 1,
        cortexClaim: expect.objectContaining({
          ownerId: fixture.ownerId,
          messageId: fixture.persistedMessageId,
          parentMessageId: fixture.parentMessageId,
          generation: 2,
          claimToken: 'claim-2',
          deliveryIds: ['cidl-1'],
          deliveryReceipts: [{ deliveryId: 'cidl-1', graphResultHash: 'c'.repeat(64) }],
          surface: 'telegram',
        }),
      },
    ]);
    expect(dependencies.deliveryService.claimPendingByParent).toHaveBeenCalledTimes(1);
    expect(dependencies.deliveryService.fencePresentation).not.toHaveBeenCalled();
    expect(dependencies.jobManager.bindCortexPresentation).not.toHaveBeenCalled();
  });

  test('authorizes the exact live claim before transport and binds its presentation fence', async () => {
    const fixture = exactFixture();
    const dependencies = buildService(fixture);
    dependencies.DeliveryModel.find.mockReturnValue(query(fixture.claimed.claimed));
    const cortexClaim = {
      ownerId: fixture.ownerId,
      messageId: fixture.persistedMessageId,
      parentMessageId: fixture.parentMessageId,
      revision: 2,
      generation: 2,
      deliveryIds: ['cidl-1'],
      deliveryReceipts: [{ deliveryId: 'cidl-1', graphResultHash: 'c'.repeat(64) }],
      claimToken: 'claim-2',
      surface: 'telegram',
    };

    await expect(
      dependencies.service.authorizeClaim({ cortexClaim, leaseMs: 120_000 }),
    ).resolves.toEqual(expect.objectContaining({ presentationLeaseToken: 'presentation-lease-2' }));
    expect(dependencies.deliveryService.fencePresentation).toHaveBeenCalledWith({
      ownerId: fixture.ownerId,
      claims: fixture.claimed.claimed.map((row) => ({
        deliveryId: row.deliveryId,
        claimToken: row.claimToken,
        claimGeneration: row.claimGeneration,
      })),
      surface: 'telegram',
      parentMessageId: fixture.parentMessageId,
      persistedMessageId: fixture.persistedMessageId,
      messageRevision: 2,
      leaseMs: 120_000,
    });
    expect(dependencies.jobManager.bindCortexPresentation).toHaveBeenCalledWith(
      fixture.streamId,
      expect.objectContaining({ presentationLeaseToken: 'presentation-lease-2' }),
    );
  });

  test('does not claim when exact durable Telegram ingress authority is unavailable', async () => {
    const dependencies = buildService();
    dependencies.IngressModel.findOne.mockReturnValue(query(null));

    await expect(dependencies.service.claimPending({ limit: 1 })).resolves.toEqual([]);
    expect(dependencies.deliveryService.claimPendingByParent).not.toHaveBeenCalled();
    expect(dependencies.jobManager.bindCortexPresentation).not.toHaveBeenCalled();
  });

  test.each([
    ['owner binding', { libreChatUserId: 'different-owner' }],
    ['authority marker', { authorityBoundAt: null }],
    ['source event', { sourceEventId: 'd'.repeat(64) }],
  ])('does not claim when the durable ingress %s differs', async (_label, override) => {
    const fixture = exactFixture();
    fixture.ingress = { ...fixture.ingress, ...override };
    const dependencies = buildService(fixture);

    await expect(dependencies.service.claimPending({ limit: 1 })).resolves.toEqual([]);
    expect(dependencies.deliveryService.claimPendingByParent).not.toHaveBeenCalled();
  });

  test('fails only the exact claimed batch and rejects a changed claim token', async () => {
    const fixture = exactFixture();
    const dependencies = buildService(fixture);
    dependencies.DeliveryModel.find.mockReturnValue(query(fixture.claimed.claimed));
    const cortexClaim = { ...fixture.fence };
    delete cortexClaim.presentationLeaseToken;

    await expect(
      dependencies.service.failClaim({
        cortexClaim,
        reason: 'presentation_failed',
      }),
    ).resolves.toEqual(fixture.claimed.claimed);
    expect(dependencies.deliveryService.markFailed).toHaveBeenCalledWith({
      ownerId: fixture.ownerId,
      claims: [{ deliveryId: 'cidl-1', claimToken: 'claim-2', claimGeneration: 2 }],
      reason: 'presentation_failed',
    });

    dependencies.deliveryService.markFailed.mockClear();
    await expect(
      dependencies.service.failClaim({
        cortexClaim: { ...cortexClaim, claimToken: 'changed-claim' },
        reason: 'presentation_failed',
      }),
    ).rejects.toMatchObject({ code: 'cortex_telegram_dispatch_claim_conflict' });
    expect(dependencies.deliveryService.markFailed).not.toHaveBeenCalled();
  });

  test('rejects a changed graph receipt and quarantines only an exact authorized unknown outcome', async () => {
    const fixture = exactFixture();
    const authorizedRows = fixture.claimed.claimed.map((row) => ({
      ...row,
      presentationLeaseToken: fixture.fence.presentationLeaseToken,
      presentationLeaseOwnerId: fixture.ownerId,
      presentationLeaseClaimToken: fixture.fence.claimToken,
      presentationLeaseGeneration: fixture.fence.generation,
      presentationLeaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    }));
    const dependencies = buildService(fixture);
    dependencies.DeliveryModel.find.mockReturnValue(query(authorizedRows));

    await expect(
      dependencies.service.markDeliveryUnknown({
        cortexPresentation: {
          ...fixture.fence,
          deliveryReceipts: [{ deliveryId: 'cidl-1', graphResultHash: 'd'.repeat(64) }],
        },
      }),
    ).rejects.toMatchObject({ code: 'cortex_telegram_dispatch_claim_conflict' });
    expect(dependencies.deliveryService.markDropped).not.toHaveBeenCalled();

    await expect(
      dependencies.service.markDeliveryUnknown({ cortexPresentation: fixture.fence }),
    ).resolves.toEqual(fixture.claimed.claimed);
    expect(dependencies.deliveryService.markDropped).toHaveBeenCalledWith({
      ownerId: fixture.ownerId,
      claims: [{ deliveryId: 'cidl-1', claimToken: 'claim-2', claimGeneration: 2 }],
      dropReason: 'delivery_outcome_unknown',
      allowExpiredLease: true,
    });
  });

  test('quarantines an expired transport-authorized claim before any candidate can be reclaimed', async () => {
    const fixture = exactFixture();
    const expiredRows = fixture.claimed.claimed.map((row) => ({
      ...row,
      leaseExpiresAt: new Date('2020-01-01T00:00:00.000Z'),
      presentationLeaseToken: fixture.fence.presentationLeaseToken,
      presentationLeaseOwnerId: fixture.ownerId,
      presentationLeaseClaimToken: fixture.fence.claimToken,
      presentationLeaseGeneration: fixture.fence.generation,
      presentationLeaseExpiresAt: new Date('2020-01-01T00:00:00.000Z'),
    }));
    const dependencies = buildService(fixture);
    dependencies.DeliveryModel.find.mockReturnValue(query(expiredRows));

    await expect(dependencies.service.settleExpiredAuthorizations({ limit: 10 })).resolves.toBe(1);
    expect(dependencies.deliveryService.markDropped).toHaveBeenCalledWith({
      ownerId: fixture.ownerId,
      claims: [{ deliveryId: 'cidl-1', claimToken: 'claim-2', claimGeneration: 2 }],
      dropReason: 'delivery_outcome_unknown',
      allowExpiredLease: true,
    });
  });
});
