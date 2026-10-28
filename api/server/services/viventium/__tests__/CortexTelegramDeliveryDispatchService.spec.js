'use strict';

jest.mock(
  '@librechat/data-schemas',
  () => ({
    ...jest.requireActual('@librechat/data-schemas'),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }),
  { virtual: true },
);

jest.mock('@librechat/api', () => ({
  GenerationJobManager: {},
  normalizeChannelInputMode: (...args) =>
    jest.requireActual('@librechat/api').normalizeChannelInputMode(...args),
  retainedCortexTelegramAcknowledgement: (...args) =>
    jest.requireActual('@librechat/api').retainedCortexTelegramAcknowledgement(...args),
  exactCortexTelegramAuthority: (...args) =>
    jest.requireActual('@librechat/api').exactCortexTelegramAuthority(...args),
  cortexTelegramPresentationProof: (...args) =>
    jest.requireActual('@librechat/api').cortexTelegramPresentationProof(...args),
  exactCortexTelegramPresentation: (...args) =>
    jest.requireActual('@librechat/api').exactCortexTelegramPresentation(...args),
}));
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
    parentMessageId: 'source-1',
    isCreatedByUser: false,
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
    isCreatedByUser: false,
    unfinished: false,
    metadata: {
      viventium: {
        type: 'cortex_followup',
        messageRevision: 2,
        cortexPresentationGeneration: 2,
        cortexPresentationClaimToken: 'claim-2',
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
    sourceMessageId: 'source-1',
    responseBinding: { streamId, responseMessageId: parentMessageId, logicalTurnId, revision: 1 },
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
    updateMany: jest.fn(async () => ({ matchedCount: 1 })),
  };
  fixture.followup.metadata.viventium.cortexTelegramPresentation = jest
    .requireActual('@librechat/api')
    .cortexTelegramPresentationProof(fixture.followup, {
      ...fixture.fence,
      presentationLeaseToken: undefined,
    });
  const MessageModel = {
    updateOne: jest.fn(async (_filter, update) => {
      Object.assign(fixture.followup.metadata.viventium, {
        cortexTelegramPresentation: update.$set['metadata.viventium.cortexTelegramPresentation'],
      });
      return { matchedCount: 1 };
    }),
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
  const readRetainedMainFinal = jest.fn(async () => null);
  const readRetainedMainFinalState = jest.fn(async (scope) => {
    const final = await readRetainedMainFinal(scope);
    return final ? { state: 'complete', final } : { state: 'unavailable' };
  });
  const service = createCortexTelegramDeliveryDispatchService({
    DeliveryModel,
    MessageModel,
    IngressModel,
    resolveTelegramMapping,
    jobManager,
    deliveryService,
    bindMessageGeneration,
    readRetainedMainFinalState,
  });
  return {
    service,
    readRetainedMainFinal,
    readRetainedMainFinalState,
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
  test('retains source-bound native audio controls from the actual persisted presentation', async () => {
    const fixture = exactFixture();
    const controls = {
      skipVoice: false,
      sourceTextSha256: 'a'.repeat(64),
      audioContent: [{ type: 'text', text: fixture.followup.text, deliveryDispositionRanges: [] }],
    };
    fixture.followup.metadata.viventium.telegramDeliveryControls = controls;
    const dependencies = buildService(fixture);
    const deliveries = await dependencies.service.claimPending({ limit: 1, leaseMs: 120_000 });
    expect(deliveries[0].deliveryControls).toEqual(controls);
    expect(deliveries[0].text).toBe(fixture.followup.text);
    expect(deliveries[0].cortexClaim.messageId).toBe(fixture.persistedMessageId);
  });

  test.each(['voice_note', 'text', undefined])(
    'late dispatch retains ingress input mode %s after job loss',
    async (inputMode) => {
      const fixture = exactFixture();
      fixture.ingress.inputMode = inputMode;
      const dependencies = buildService(fixture);
      dependencies.jobManager.getJob.mockResolvedValue(null);
      dependencies.readRetainedMainFinal.mockResolvedValue({
        responseMessageId: fixture.parentMessageId,
        conversationId: fixture.conversationId,
        interactionContext: fixture.parent.metadata.viventium.interactionContext,
      });
      const deliveries = await dependencies.service.claimPending({ limit: 1, leaseMs: 120_000 });
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].inputMode).toBe(inputMode);
    },
  );

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

describe('durable Cortex delivery recovery', () => {
  test.each(['deletedAt', 'unfinished', 'error'])(
    'refuses canonical followup %s',
    async (field) => {
      const f = exactFixture();
      f.followup[field] = field === 'deletedAt' ? new Date() : true;
      const d = buildService(f);
      expect(await d.service.claimPending({ limit: 1 })).toEqual([]);
      expect(d.deliveryService.claimPendingByParent).not.toHaveBeenCalled();
    },
  );
  test('claims and authorizes a retained canonical result after the job cache disappears', async () => {
    const f = exactFixture();
    const d = buildService(f);
    d.jobManager.getJob.mockResolvedValue(null);
    d.readRetainedMainFinal.mockResolvedValue({
      responseMessageId: f.parentMessageId,
      conversationId: f.conversationId,
      interactionContext: f.parent.metadata.viventium.interactionContext,
    });
    const [delivery] = await d.service.claimPending({ limit: 1 });
    expect(delivery.text).toBe(f.followup.text);
    d.DeliveryModel.find.mockReturnValue(query(f.claimed.claimed));
    expect(await d.service.authorizeClaim({ cortexClaim: delivery.cortexClaim })).toMatchObject({
      presentationLeaseToken: f.fence.presentationLeaseToken,
    });
    expect(d.jobManager.bindCortexPresentation).not.toHaveBeenCalled();
  });
  test('cannot use a retained result to bypass a conflicting live job', async () => {
    const f = exactFixture();
    const d = buildService(f);
    d.jobManager.getJob.mockResolvedValue({ ...f.job, status: 'superseded' });
    d.readRetainedMainFinal.mockResolvedValue({
      responseMessageId: f.parentMessageId,
      conversationId: f.conversationId,
      interactionContext: f.parent.metadata.viventium.interactionContext,
    });
    expect(await d.service.claimPending({ limit: 1 })).toEqual([]);
    expect(d.readRetainedMainFinal).not.toHaveBeenCalled();
  });
  test.each(['sourceEventId', 'responseBinding'])(
    'refuses changed durable ingress %s',
    async (field) => {
      const f = exactFixture();
      const d = buildService(f);
      f.ingress[field] =
        field === 'sourceEventId' ? 'f'.repeat(64) : { ...f.ingress.responseBinding, revision: 9 };
      expect(await d.service.claimPending({ limit: 1 })).toEqual([]);
    },
  );
  test('a body edit between claim and authorize invalidates the saved presentation proof', async () => {
    const f = exactFixture();
    const d = buildService(f);
    const [delivery] = await d.service.claimPending({ limit: 1 });
    f.followup.text = 'Changed canonical text';
    d.DeliveryModel.find.mockReturnValue(query(f.claimed.claimed));
    await expect(
      d.service.authorizeClaim({ cortexClaim: delivery.cortexClaim }),
    ).rejects.toMatchObject({ code: 'cortex_telegram_dispatch_claim_conflict' });
    expect(d.deliveryService.fencePresentation).not.toHaveBeenCalled();
  });
  test('an invalid bounded prefix yields to a later valid candidate on the next tick', async () => {
    const f = exactFixture();
    const d = buildService(f);
    const deferred = new Set();
    const rows = Array.from({ length: 4 }, (_, i) => ({
      ...f.candidate,
      deliveryId: `old-${i}`,
      parentMessageId: `gone-${i}`,
    })).concat(f.candidate);
    d.DeliveryModel.updateMany.mockImplementation(async (filter) => {
      deferred.add(filter.parentMessageId);
      return { matchedCount: 1 };
    });
    d.DeliveryModel.find.mockImplementation((filter) => {
      if (filter.status === 'claimed') return query([]);
      let limit = Infinity;
      const q = query([]);
      q.limit.mockImplementation((n) => {
        limit = n;
        return q;
      });
      q.lean.mockImplementation(async () =>
        rows.filter((row) => !deferred.has(row.parentMessageId)).slice(0, limit),
      );
      return q;
    });
    expect(await d.service.claimPending({ limit: 1 })).toEqual([]);
    expect(await d.service.claimPending({ limit: 1 })).toHaveLength(1);
  });
  test('retained ACK validates durable lease, cohort and channel without a job', async () => {
    const f = exactFixture();
    const d = buildService(f);
    d.jobManager.getJob.mockResolvedValue(null);
    d.readRetainedMainFinal.mockResolvedValue({
      responseMessageId: f.parentMessageId,
      conversationId: f.conversationId,
      interactionContext: f.parent.metadata.viventium.interactionContext,
    });
    const authorizedRows = f.claimed.claimed.map((row) => ({
      ...row,
      presentationLeaseToken: f.fence.presentationLeaseToken,
      presentationLeaseOwnerId: f.ownerId,
      presentationLeaseClaimToken: f.fence.claimToken,
      presentationLeaseGeneration: f.fence.generation,
      presentationLeaseExpiresAt: new Date('2099-01-01'),
    }));
    d.DeliveryModel.find.mockReturnValue(query(authorizedRows));
    f.followup.metadata.viventium.cortexTelegramPresentation = jest
      .requireActual('@librechat/api')
      .cortexTelegramPresentationProof(f.followup, f.fence);
    const ack = {
      state: 'committed',
      logical_turn_id: f.logicalTurnId,
      revision: 1,
      presentation_ref: 'telegram:-100123:99',
      presentation_refs: ['telegram:-100123:99'],
    };
    expect(await d.service.acknowledgeRetained(ack, f.fence)).toMatchObject({
      status: 'recorded',
      presentation: { userId: f.ownerId },
    });
    expect(
      await d.service.acknowledgeRetained(
        { ...ack, presentation_ref: 'telegram:777:99', presentation_refs: ['telegram:777:99'] },
        f.fence,
      ),
    ).toEqual({ status: 'conflict' });
    expect(await d.service.acknowledgeRetained(ack, { ...f.fence, generation: 3 })).toEqual({
      status: 'conflict',
    });
    f.followup.metadata.viventium.deliveryAcknowledgement = {
      ...ack,
      revision: 2,
      logical_turn_revision: 1,
      cortex_presentation_generation: 2,
      cortex_presentation_claim_token: 'claim-2',
    };
    const settledRows = authorizedRows.map((row) => ({
      ...row,
      status: 'sent',
      claimToken: '',
      presentationLeaseToken: '',
      presentedSurfaces: ['web', 'telegram'],
    }));
    d.DeliveryModel.find.mockReturnValue(query(settledRows));
    expect(await d.service.acknowledgeRetained(ack, f.fence)).toMatchObject({
      status: 'recorded',
      idempotent: true,
    });
    expect(
      await d.service.acknowledgeRetained(
        {
          ...ack,
          presentation_ref: 'telegram:-100123:100',
          presentation_refs: ['telegram:-100123:100'],
        },
        f.fence,
      ),
    ).toEqual({ status: 'conflict' });
    const unknownRows = authorizedRows.map((row) => ({
      ...row,
      status: 'dropped',
      dropReason: 'delivery_outcome_unknown',
    }));
    d.DeliveryModel.find.mockReturnValue(query(unknownRows));
    expect(await d.service.acknowledgeRetained(ack, f.fence)).toEqual({ status: 'conflict' });
  });
});

describe('typed retained supersession settlement', () => {
  test.each(['superseded', 'unavailable'])(
    'retained %s settles only definite supersession',
    async (state) => {
      const f = exactFixture();
      const d = buildService(f);
      d.jobManager.getJob.mockResolvedValue(null);
      d.readRetainedMainFinalState.mockResolvedValue({
        state,
        parent: {
          responseMessageId: f.parentMessageId,
          conversationId: f.conversationId,
          interactionContext: f.parent.metadata.viventium.interactionContext,
        },
      });
      expect(await d.service.claimPending({ limit: 1 })).toEqual([]);
      expect(d.deliveryService.markDropped).toHaveBeenCalledTimes(state === 'superseded' ? 1 : 0);
      expect(d.DeliveryModel.updateMany).toHaveBeenCalledTimes(state === 'superseded' ? 0 : 1);
      if (state === 'superseded')
        expect(d.deliveryService.markDropped).toHaveBeenCalledWith({
          ownerId: f.ownerId,
          claims: f.claimed.claimed,
          dropReason: 'conversation_moved_on',
        });
    },
  );
  test('typed supersession cannot bypass foreign or replaced ingress', async () => {
    const f = exactFixture();
    const d = buildService(f);
    d.jobManager.getJob.mockResolvedValue(null);
    f.ingress.responseBinding.revision = 9;
    d.readRetainedMainFinalState.mockResolvedValue({
      state: 'superseded',
      parent: {
        responseMessageId: f.parentMessageId,
        conversationId: f.conversationId,
        interactionContext: f.parent.metadata.viventium.interactionContext,
      },
    });
    expect(await d.service.claimPending({ limit: 1 })).toEqual([]);
    expect(d.deliveryService.markDropped).not.toHaveBeenCalled();
  });
});
