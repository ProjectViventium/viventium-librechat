/* === VIVENTIUM START ===
 * Feature: Durable cortex insight delivery ledger schema tests.
 * === VIVENTIUM END === */

const crypto = require('crypto');
const mongoose = require('mongoose');
const { MongoMemoryServer, MongoMemoryReplSet } = require('mongodb-memory-server');
const {
  GenerationJobManager,
  InMemoryEventTransport,
  InMemoryJobStore,
} = require('@librechat/api');
const { createModels } = require('@librechat/data-schemas');
const createViventiumCortexInsightDelivery = require('./viventiumCortexInsightDelivery');
const createViventiumCortexInsightOutbox = require('./viventiumCortexInsightOutbox');
const {
  createCortexInsightDeliveryService,
  requireExactCortexInsightDeliverySettlement,
} = require('../server/services/viventium/CortexInsightDeliveryService');
const {
  createLocalQaCortexFaultService,
} = require('../server/services/viventium/LocalQaCortexFaultService');
const {
  __testables: { persistCortexTelegramPresentationReceipt },
} = require('../server/routes/viventium/interactions');
const {
  createCortexInsightOutboxService,
} = require('../server/services/viventium/CortexInsightOutboxService');
const {
  recoverPendingCortexInsightDeliveries,
} = require('../server/services/viventium/staleCortexMessageRecovery');
const {
  extractCompletedCortexGraphInsight,
  persistCompletedCortexGraphInsight,
} = require('../server/services/BackgroundCortexService');

function recoverPending(options) {
  return recoverPendingCortexInsightDeliveries({
    replayMessageFallbacks: async () => ({ scanned: 0, replayed: 0, pending: 0 }),
    replayOutbox: async () => ({ scanned: 0, replayed: 0, pending: 0 }),
    loadParentState: async ({ parentMessageId }) => ({
      messageId: parentMessageId,
      unfinished: false,
    }),
    hasDurableTelegramDispatchAuthority: async () => false,
    bindMessageGeneration: async ({ message, revision, claimGeneration }) => ({
      ...message,
      revision,
      metadata: {
        ...(message.metadata || {}),
        viventium: {
          ...(message.metadata?.viventium || {}),
          messageRevision: revision,
          cortexPresentationGeneration: claimGeneration,
        },
      },
    }),
    ...options,
  });
}

async function restoreRecoveryStream({ streamId, ownerId, conversationId, parentMessageId }) {
  await GenerationJobManager.destroy();
  GenerationJobManager.configure({
    jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
    eventTransport: new InMemoryEventTransport(),
    cleanupOnComplete: false,
  });
  await GenerationJobManager.initialize();
  await GenerationJobManager.createJob(streamId, ownerId, conversationId);
  await GenerationJobManager.updateMetadata(streamId, { responseMessageId: parentMessageId });
  await GenerationJobManager.getJobStore().updateJob(streamId, {
    interactionContext: {
      surface: 'telegram',
      logical_turn_id: `logical-turn-${parentMessageId}`,
      revision: 1,
    },
  });
}

describe('ViventiumCortexInsightDelivery schema', () => {
  const isolatedMongoose = new mongoose.Mongoose();
  const Delivery = createViventiumCortexInsightDelivery(isolatedMongoose);
  const base = {
    deliveryKey: 'cortex_insight:synthetic',
    deliveryId: 'cidl_synthetic',
    userId: 'owner-1',
    conversationId: 'conversation-1',
    parentMessageId: 'parent-1',
    cortexId: 'review',
    insight: 'A private completed insight.',
    insightHash: 'a'.repeat(64),
    graphResultHash: 'a'.repeat(64),
    surface: 'web',
  };

  test('rejects sent rows without both persistence and required presentation receipts', async () => {
    const row = new Delivery({
      ...base,
      status: 'sent',
      persistenceStatus: 'persisted',
      persistedMessageId: 'follow-up-1',
      persistedAt: new Date('2026-08-22T11:59:00.000Z'),
      requiredSurfaces: ['web'],
      sentAt: new Date('2026-08-22T12:00:00.000Z'),
      expiresAt: new Date('2026-09-22T12:00:00.000Z'),
    });

    await expect(row.validate()).rejects.toThrow('presentationReceiptHashes');
  });

  test('rejects dropped rows without a closed drop reason', async () => {
    const row = new Delivery({
      ...base,
      status: 'dropped',
      droppedAt: new Date('2026-08-22T12:00:00.000Z'),
      expiresAt: new Date('2026-09-22T12:00:00.000Z'),
    });

    await expect(row.validate()).rejects.toThrow('dropReason');
  });

  test('keeps the durable insight private and the append-only event shape redacted', () => {
    expect(Delivery.schema.path('insight').options.select).toBe(false);
    expect(Delivery.schema.path('feelingSnapshot').options.select).toBe(false);
    expect(Delivery.schema.path('events')).toBeDefined();
    const eventSchema = Delivery.schema.path('events').schema;
    expect(eventSchema.path('transition')).toBeDefined();
    expect(eventSchema.path('attemptNumber')).toBeDefined();
    expect(eventSchema.path('claimToken')).toBeDefined();
    expect(eventSchema.path('claimGeneration')).toBeDefined();
    expect(eventSchema.path('leaseExpiresAt')).toBeDefined();
    expect(eventSchema.path('receiptHash')).toBeDefined();
    expect(eventSchema.path('surface')).toBeDefined();
    expect(eventSchema.path('recoveryAttemptNumber').options.max).toBe(16);
    expect(eventSchema.path('retryEligibleAt')).toBeDefined();
    expect(eventSchema.path('insight')).toBeUndefined();
    expect(eventSchema.path('persistedMessageId')).toBeUndefined();
  });

  test('uses one strict private Feelings receipt schema without changing capsule bytes', async () => {
    const feelingPath = Delivery.schema.path('feelingSnapshot');
    const capsule = '  Synthetic exact capsule.\n';
    const valid = new Delivery({
      ...base,
      feelingSnapshot: {
        available: true,
        enabled: true,
        agentScope: 'all_agents',
        version: 41,
        asOf: '2026-08-22T12:00:00.000Z',
        capsule,
        snapshotHash: 'a'.repeat(64),
        rangePromptOverrideCount: 3,
        activeRangePromptOverrideCount: 2,
        activeRangePromptOverrideChars: 120,
      },
    });

    await expect(valid.validate()).resolves.toBeUndefined();
    expect(feelingPath.options.select).toBe(false);
    expect(feelingPath.schema.options.strict).toBe('throw');
    expect(valid.feelingSnapshot.capsule).toBe(capsule);

    await expect(async () => {
      const invalid = new Delivery({
        ...base,
        feelingSnapshot: {
          available: 'true',
          enabled: true,
          agentScope: 'all_agents',
          version: 41,
          asOf: '2026-08-22T12:00:00.000Z',
          capsule: 'Synthetic capsule.',
          snapshotHash: 'a'.repeat(64),
          rangePromptOverrideCount: 3,
          activeRangePromptOverrideCount: 2,
          activeRangePromptOverrideChars: 120,
          unexpectedPrivateField: 'reject',
        },
      });
      await invalid.validate();
    }).rejects.toThrow();
  });

  test.each([
    ['disabled', { available: true, enabled: false }],
    ['unavailable', { available: false, enabled: false }],
  ])('accepts a strict %s Feelings receipt with an exact empty capsule', async (_name, state) => {
    const row = new Delivery({
      ...base,
      deliveryKey: `cortex_insight:${_name}-empty-capsule`,
      deliveryId: `cidl_${_name}-empty-capsule`,
      feelingSnapshot: {
        ...state,
        agentScope: 'all_agents',
        version: 41,
        asOf: '2026-08-22T12:00:00.000Z',
        capsule: '',
        snapshotHash: 'a'.repeat(64),
        rangePromptOverrideCount: 0,
        activeRangePromptOverrideCount: 0,
        activeRangePromptOverrideChars: 0,
      },
    });

    await expect(row.validate()).resolves.toBeUndefined();
    expect(row.feelingSnapshot.capsule).toBe('');
  });

  test('rejects a Feelings receipt that omits the capsule field', async () => {
    const row = new Delivery({
      ...base,
      deliveryKey: 'cortex_insight:missing-capsule',
      deliveryId: 'cidl_missing-capsule',
      feelingSnapshot: {
        available: false,
        enabled: false,
        agentScope: 'all_agents',
        version: 41,
        asOf: '2026-08-22T12:00:00.000Z',
        snapshotHash: 'a'.repeat(64),
        rangePromptOverrideCount: 0,
        activeRangePromptOverrideCount: 0,
        activeRangePromptOverrideChars: 0,
      },
    });

    await expect(row.validate()).rejects.toThrow('capsule');
  });

  test('keeps non-terminal work outside TTL and limits the TTL index to terminal rows', async () => {
    const expiresAt = Delivery.schema.path('expiresAt');
    const ttlIndex = Delivery.schema
      .indexes()
      .find(([keys, options]) => keys.expiresAt === 1 && options.expireAfterSeconds === 0);
    const pending = new Delivery({ ...base, requiredSurfaces: ['web'] });

    await expect(pending.validate()).resolves.toBeUndefined();
    expect(pending.status).toBe('pending');
    expect(pending.expiresAt).toBeNull();
    expect(expiresAt.options.required.call(pending)).toBe(false);
    expect(ttlIndex).toEqual([
      { expiresAt: 1 },
      expect.objectContaining({
        expireAfterSeconds: 0,
        partialFilterExpression: { status: { $in: ['sent', 'dropped'] } },
      }),
    ]);
  });

  test('models persistence and surface presentation as separate append-only transitions', () => {
    const transitions = Delivery.schema.path('events').schema.path('transition').options.enum;

    expect(transitions).toEqual(
      expect.arrayContaining(['pending', 'claimed', 'failure', 'persisted', 'presented', 'sent']),
    );
    expect(Delivery.schema.path('persistenceStatus')).toBeDefined();
    expect(Delivery.schema.path('requiredSurfaces')).toBeDefined();
    expect(Delivery.schema.path('presentedSurfaces')).toBeDefined();
    expect(Delivery.schema.path('presentationReceiptHashes').options.select).toBe(false);
    expect(Delivery.schema.path('batchLockToken').options.select).toBe(false);
    expect(Delivery.schema.path('batchIntent').options.select).toBe(false);
    expect(Delivery.schema.path('claimRuntimeEpoch').options.select).toBe(false);
    expect(Delivery.schema.path('claimRuntimeSlot').options.select).toBe(false);
    expect(Delivery.schema.path('presentationLeaseToken').options.select).toBe(false);
    expect(Delivery.schema.path('presentationLeaseClaimToken').options.select).toBe(false);
    expect(Delivery.schema.path('presentationLeaseGeneration').options.select).toBe(false);
    expect(Delivery.schema.path('presentationLeaseExpiresAt').options.select).toBe(false);
    expect(Delivery.schema.path('recoveryAttemptNumber').options.max).toBe(16);
    expect(Delivery.schema.path('recoveryEligibleAt')).toBeDefined();
    expect(
      Delivery.schema
        .indexes()
        .find(([, options]) => options?.name === 'cortex_delivery_recovery_eligibility')?.[0],
    ).toEqual({ status: 1, recoveryEligibleAt: 1, createdAt: 1, deliveryId: 1 });
    expect(Delivery.schema.path('dropReason').options.enum).toEqual(
      expect.arrayContaining([
        'unsupported_surface',
        'delivery_attempts_exhausted',
        'delivery_outcome_unknown',
      ]),
    );
  });
});

describe('ViventiumCortexInsightDelivery standalone batch lock', () => {
  let mongoServer;
  let database;
  let Delivery;
  let Outbox;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    database = new mongoose.Mongoose();
    await database.connect(mongoServer.getUri());
    Delivery = createViventiumCortexInsightDelivery(database);
    Outbox = createViventiumCortexInsightOutbox(database);
    await Promise.all([Delivery.syncIndexes(), Outbox.syncIndexes()]);
  });

  afterAll(async () => {
    await database?.disconnect();
    await mongoServer?.stop();
  });

  test('gives one standalone worker every sibling lease and one complete settlement', async () => {
    const services = ['standalone-a', 'standalone-b'].map((worker) =>
      createCortexInsightDeliveryService({
        DeliveryModel: Delivery,
        now: () => new Date('2026-08-22T11:00:00.000Z'),
        randomUUID: () => worker,
      }),
    );
    await services[0].recordBatch({
      ownerId: 'owner-standalone-race',
      conversationId: 'conversation-standalone-race',
      parentMessageId: 'parent-standalone-race',
      surface: 'web',
      insights: [
        { cortexName: 'Review A', insight: 'First standalone result.' },
        { cortexName: 'Review B', insight: 'Second standalone result.' },
      ],
    });

    const claims = await Promise.all(
      services.map((service) =>
        service.claimPendingByParent({
          ownerId: 'owner-standalone-race',
          parentMessageId: 'parent-standalone-race',
          surface: 'web',
        }),
      ),
    );
    const winningClaim = claims.find((batch) => batch.claimed.length === 2);
    const settlements = await Promise.allSettled(
      services.map((service, index) =>
        service.markPersisted({
          ownerId: 'owner-standalone-race',
          claims: winningClaim.claimed,
          persistedMessageId: `standalone-message-${index + 1}`,
        }),
      ),
    );
    const rows = await services[0].listByParent({
      ownerId: 'owner-standalone-race',
      parentMessageId: 'parent-standalone-race',
    });

    expect(claims.map((batch) => batch.claimed.length).sort()).toEqual([0, 2]);
    expect(new Set(winningClaim.claimed.map((row) => row.claimToken)).size).toBe(1);
    expect(settlements.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(new Set(rows.map((row) => row.persistedMessageId)).size).toBe(1);
  });

  test('fails closed on an interrupted declared batch until exact outbox replay completes membership', async () => {
    let currentTime = new Date();
    const ownerId = 'owner-standalone-partial-membership';
    const parentMessageId = 'parent-standalone-partial-membership';
    const input = {
      ownerId,
      conversationId: 'conversation-standalone-partial-membership',
      parentMessageId,
      surface: 'web',
      streamId: 'stream-standalone-partial-membership',
      messageRevision: 1,
      insights: [
        { cortexId: 'review-a', insight: 'Interrupted declared sibling A.' },
        { cortexId: 'review-b', insight: 'Interrupted declared sibling B.' },
      ],
    };
    const outbox = createCortexInsightOutboxService({
      OutboxModel: Outbox,
      now: () => currentTime,
    });
    await outbox.enqueueBatch(input);
    const interrupted = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => currentTime,
      runtimeSlot: 'partial-membership-slot',
      runtimeEpoch: 'partial-membership-boot-1',
      afterStandaloneRecordWrite: ({ mutationIndex }) => {
        if (mutationIndex !== 0) return;
        const error = new Error('synthetic standalone record interruption');
        error.code = 'cortex_test_process_interrupted';
        throw error;
      },
    });

    await expect(interrupted.recordBatch(input)).rejects.toMatchObject({
      code: 'cortex_test_process_interrupted',
    });
    const partialRows = await Delivery.find({ userId: ownerId, parentMessageId })
      .sort({ deliveryId: 1 })
      .lean();
    expect(partialRows).toHaveLength(1);
    expect(partialRows[0]).toEqual(
      expect.objectContaining({
        batchSize: 2,
        batchMemberHashes: expect.arrayContaining([
          expect.stringMatching(/^[a-f0-9]{64}$/),
          expect.stringMatching(/^[a-f0-9]{64}$/),
        ]),
      }),
    );

    const restarted = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => currentTime,
      runtimeSlot: 'partial-membership-slot',
      runtimeEpoch: 'partial-membership-boot-2',
    });
    const blockedClaim = await restarted.claimPendingByParent({
      ownerId,
      parentMessageId,
      surface: 'web',
    });
    expect(blockedClaim).toEqual(
      expect.objectContaining({
        noClaimReason: 'recovery_parent_incomplete_batch',
        deliveries: [],
        claimed: [],
        insights: [],
      }),
    );
    await expect(restarted.listByParent({ ownerId, parentMessageId })).rejects.toMatchObject({
      code: 'cortex_insight_delivery_batch_incomplete',
    });

    const createMessage = jest.fn();
    const presentSurface = jest.fn();
    await recoverPending({
      deliveryService: restarted,
      replayOutbox: async () => ({ scanned: 1, replayed: 0, pending: 1 }),
      createMessage,
      presentSurface,
    });
    expect(
      createMessage.mock.calls.filter(([call]) => call.parentMessageId === parentMessageId),
    ).toHaveLength(0);
    expect(
      presentSurface.mock.calls.filter(([call]) => call.parentMessageId === parentMessageId),
    ).toHaveLength(0);

    await expect(
      outbox.replayPending({ recordBatch: (batch) => restarted.recordBatch(batch) }),
    ).resolves.toEqual({ scanned: 1, replayed: 1, pending: 0 });
    currentTime = new Date(currentTime.getTime() + 2_000);
    const completeClaim = await restarted.claimPendingByParent({
      ownerId,
      parentMessageId,
      surface: 'web',
    });
    expect(completeClaim.claimed).toHaveLength(2);
    expect(completeClaim.claimed.map((row) => row.deliveryId)).toEqual(
      [...completeClaim.claimed.map((row) => row.deliveryId)].sort(),
    );
    expect(completeClaim.insights.map((row) => row.cortexId)).toEqual(
      completeClaim.claimed.map((row) => row.cortexId),
    );

    await restarted.markPersisted({
      ownerId,
      claims: completeClaim.claimed,
      persistedMessageId: 'message-standalone-partial-membership',
      messageRevision: 1,
    });
    const presentationFence = await restarted.fencePresentation({
      ownerId,
      claims: completeClaim.claimed,
      surface: 'web',
      persistedMessageId: 'message-standalone-partial-membership',
      messageRevision: 1,
    });
    await expect(
      restarted.markPresented({
        ownerId,
        claims: presentationFence.claims,
        surface: 'web',
        persistedMessageId: 'message-standalone-partial-membership',
        messageRevision: 1,
        presentationGeneration: presentationFence.generation,
        presentationClaimToken: presentationFence.claimToken,
        presentationLeaseToken: presentationFence.presentationLeaseToken,
        presentationRef: 'web:synthetic:partial-membership',
      }),
    ).resolves.toHaveLength(2);
  });

  test('repairs a twice-failed same-boot claim batch without exposing siblings to another worker', async () => {
    const ownerId = 'owner-standalone-same-boot-repair';
    const parentMessageId = 'parent-standalone-same-boot-repair';
    let clock = new Date('2026-08-22T11:05:00.000Z');
    let injectedFailures = 0;
    let uuidSequence = 0;
    const sameBoot = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => new Date(clock),
      randomUUID: () => `same-boot-${(uuidSequence += 1)}`,
      runtimeSlot: 'api-slot-same-boot',
      runtimeEpoch: 'boot-same',
      afterStandaloneMutation: () => {
        if (injectedFailures >= 2) return;
        injectedFailures += 1;
        const error = new Error('synthetic same-boot batch execution failure');
        error.code = 'cortex_test_same_boot_double_failure';
        throw error;
      },
    });
    const competingWorker = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => new Date(clock),
      randomUUID: () => 'same-boot-competing-worker',
      runtimeSlot: 'api-slot-competing',
      runtimeEpoch: 'boot-competing',
    });
    await sameBoot.recordBatch({
      ownerId,
      conversationId: 'conversation-standalone-same-boot-repair',
      parentMessageId,
      surface: 'web',
      insights: [
        { cortexName: 'Review A', insight: 'First same-boot repair result.' },
        { cortexName: 'Review B', insight: 'Second same-boot repair result.' },
      ],
    });

    await expect(
      sameBoot.claimPendingByParent({ ownerId, parentMessageId, surface: 'web' }),
    ).rejects.toMatchObject({ code: 'cortex_test_same_boot_double_failure' });
    expect(injectedFailures).toBe(2);

    const blockedBeforeRepair = await competingWorker.claimPendingByParent({
      ownerId,
      parentMessageId,
      surface: 'web',
    });
    expect(blockedBeforeRepair.claimed).toHaveLength(0);

    clock = new Date('2026-08-22T11:05:31.000Z');
    await expect(sameBoot.repairIncompleteBatches()).resolves.toEqual(
      expect.objectContaining({ repaired: 1, deferred: 0, failed: 0 }),
    );
    const repairedRows = await Delivery.find({ userId: ownerId, parentMessageId })
      .select('+batchIntent +batchLockToken')
      .sort({ deliveryId: 1 })
      .lean();
    expect(repairedRows.map((row) => row.status)).toEqual(['pending', 'pending']);
    expect(repairedRows.every((row) => row.batchIntent == null)).toBe(true);
    expect(repairedRows.every((row) => !row.batchLockToken)).toBe(true);

    const postRepairClaims = await Promise.all(
      [sameBoot, competingWorker].map((service) =>
        service.claimPendingByParent({ ownerId, parentMessageId, surface: 'web' }),
      ),
    );
    expect(postRepairClaims.map((batch) => batch.claimed.length).sort()).toEqual([0, 2]);
    const winningBatch = postRepairClaims.find((batch) => batch.claimed.length === 2);
    expect(new Set(winningBatch.claimed.map((row) => row.claimToken)).size).toBe(1);

    await sameBoot.markFailed({
      ownerId,
      claims: winningBatch.claimed,
      reason: 'presentation_failed',
    });
    const retryRows = await sameBoot.listByParent({ ownerId, parentMessageId });
    expect(retryRows.map((row) => row.status)).toEqual(['pending', 'pending']);
    expect(retryRows.every((row) => row.attemptNumber === 2)).toBe(true);
  });

  test('repairs a process interruption between standalone sibling lease writes on restart', async () => {
    const oldProcess = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => new Date('2026-08-22T11:10:00.000Z'),
      randomUUID: () => 'standalone-crash-claim',
      runtimeSlot: 'api-slot-a',
      runtimeEpoch: 'boot-old',
      afterStandaloneMutation: ({ mutationIndex }) => {
        if (mutationIndex !== 1) return;
        const error = new Error('synthetic process interruption');
        error.code = 'cortex_test_process_interrupted';
        throw error;
      },
    });
    await oldProcess.recordBatch({
      ownerId: 'owner-standalone-crash-claim',
      conversationId: 'conversation-standalone-crash-claim',
      parentMessageId: 'parent-standalone-crash-claim',
      surface: 'web',
      insights: [
        { cortexName: 'Review A', insight: 'First interrupted claim.' },
        { cortexName: 'Review B', insight: 'Second interrupted claim.' },
      ],
    });

    await expect(
      oldProcess.claimPendingByParent({
        ownerId: 'owner-standalone-crash-claim',
        parentMessageId: 'parent-standalone-crash-claim',
        surface: 'web',
      }),
    ).rejects.toMatchObject({ code: 'cortex_test_process_interrupted' });
    const interrupted = await Delivery.find({
      userId: 'owner-standalone-crash-claim',
      parentMessageId: 'parent-standalone-crash-claim',
    })
      .select('+batchIntent +claimRuntimeEpoch +claimRuntimeSlot')
      .sort({ deliveryId: 1 })
      .lean();
    expect(interrupted.map((row) => row.status)).toEqual(['claimed', 'pending']);
    expect(interrupted.find((row) => row.batchIntent)?.batchIntent?.phase).toBe('prepared');

    const restarted = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => new Date('2026-08-22T11:10:01.000Z'),
      randomUUID: () => 'standalone-restart-claim',
      runtimeSlot: 'api-slot-a',
      runtimeEpoch: 'boot-new',
    });
    await restarted.repairIncompleteBatches();
    const reclaimed = await restarted.claimPendingByParent({
      ownerId: 'owner-standalone-crash-claim',
      parentMessageId: 'parent-standalone-crash-claim',
      surface: 'web',
    });

    expect(reclaimed.claimed).toHaveLength(2);
    expect(new Set(reclaimed.claimed.map((row) => row.claimToken)).size).toBe(1);
    expect(reclaimed.claimed.every((row) => row.attemptNumber === 2)).toBe(true);
  });

  test('repairs a process interruption between standalone sibling terminal writes on restart', async () => {
    const ownerId = 'owner-standalone-crash-terminal';
    const parentMessageId = 'parent-standalone-crash-terminal';
    const claimingService = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => new Date('2026-08-22T11:20:00.000Z'),
      randomUUID: () => 'standalone-terminal-claim',
      runtimeSlot: 'api-slot-terminal',
      runtimeEpoch: 'boot-terminal-old',
    });
    await claimingService.recordBatch({
      ownerId,
      conversationId: 'conversation-standalone-crash-terminal',
      parentMessageId,
      surface: 'web',
      insights: [
        { cortexName: 'Review A', insight: 'First interrupted terminal row.' },
        { cortexName: 'Review B', insight: 'Second interrupted terminal row.' },
      ],
    });
    const claimed = await claimingService.claimPendingByParent({
      ownerId,
      parentMessageId,
      surface: 'web',
    });
    const crashingService = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => new Date('2026-08-22T11:20:01.000Z'),
      randomUUID: () => 'standalone-terminal-intent',
      runtimeSlot: 'api-slot-terminal',
      runtimeEpoch: 'boot-terminal-old',
      afterStandaloneMutation: ({ mutationIndex }) => {
        if (mutationIndex !== 1) return;
        const error = new Error('synthetic process interruption');
        error.code = 'cortex_test_process_interrupted';
        throw error;
      },
    });

    await expect(
      crashingService.markDropped({
        ownerId,
        claims: claimed.claimed,
        dropReason: 'semantic_suppression',
      }),
    ).rejects.toMatchObject({ code: 'cortex_test_process_interrupted' });
    const interrupted = await Delivery.find({ userId: ownerId, parentMessageId })
      .select('+batchIntent')
      .sort({ deliveryId: 1 })
      .lean();
    expect(interrupted.map((row) => row.status)).toEqual(['dropped', 'claimed']);
    expect(interrupted.find((row) => row.batchIntent)?.batchIntent?.phase).toBe('prepared');

    const restarted = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => new Date('2026-08-22T11:20:02.000Z'),
      randomUUID: () => 'standalone-terminal-restart',
      runtimeSlot: 'api-slot-terminal',
      runtimeEpoch: 'boot-terminal-new',
    });
    await restarted.repairIncompleteBatches();
    const rows = await restarted.listByParent({ ownerId, parentMessageId });

    expect(rows.map((row) => row.status)).toEqual(['dropped', 'dropped']);
    expect(rows.every((row) => row.dropReason === 'semantic_suppression')).toBe(true);
  });

  test('reclaims an unexpired prior boot claim immediately but not another live slot claim', async () => {
    const ownerId = 'owner-runtime-epoch';
    const parentMessageId = 'parent-runtime-epoch';
    const firstBoot = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => new Date('2026-08-22T11:30:00.000Z'),
      randomUUID: () => 'runtime-epoch-old',
      runtimeSlot: 'api-slot-restart',
      runtimeEpoch: 'boot-old',
    });
    await firstBoot.recordBatch({
      ownerId,
      conversationId: 'conversation-runtime-epoch',
      parentMessageId,
      surface: 'web',
      insights: [{ cortexName: 'Review', insight: 'Reclaim this without waiting one hour.' }],
    });
    const firstClaim = await firstBoot.claimPendingByParent({
      ownerId,
      parentMessageId,
      surface: 'web',
    });

    const otherLiveSlot = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => new Date('2026-08-22T11:30:01.000Z'),
      randomUUID: () => 'runtime-other-slot',
      runtimeSlot: 'api-slot-other',
      runtimeEpoch: 'boot-other',
    });
    const blocked = await otherLiveSlot.claimPendingByParent({
      ownerId,
      parentMessageId,
      surface: 'web',
    });

    const restartedSlot = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => new Date('2026-08-22T11:30:02.000Z'),
      randomUUID: () => 'runtime-epoch-new',
      runtimeSlot: 'api-slot-restart',
      runtimeEpoch: 'boot-new',
    });
    const reclaimed = await restartedSlot.claimPendingByParent({
      ownerId,
      parentMessageId,
      surface: 'web',
    });

    expect(firstClaim.claimed).toHaveLength(1);
    expect(blocked.claimed).toHaveLength(0);
    expect(reclaimed.claimed).toEqual([
      expect.objectContaining({ attemptNumber: 2, claimGeneration: 2 }),
    ]);
    expect(JSON.stringify(reclaimed)).not.toContain('api-slot-restart');
    expect(JSON.stringify(reclaimed)).not.toContain('boot-new');
    expect(JSON.stringify(reclaimed)).not.toContain('batchLockToken');
  });

  test('blocks every prior-boot reclaim while the exact presentation lease is live', async () => {
    let currentTime = new Date('2026-08-22T11:45:00.000Z');
    const ownerId = 'owner-presentation-lease';
    const parentMessageId = 'parent-presentation-lease';
    const firstBoot = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => currentTime,
      randomUUID: (() => {
        let sequence = 0;
        return () => `presentation-lease-first-${++sequence}`;
      })(),
      runtimeSlot: 'api-slot-presentation',
      runtimeEpoch: 'boot-first',
    });
    const batch = await firstBoot.claimBatch({
      ownerId,
      conversationId: 'conversation-presentation-lease',
      parentMessageId,
      surface: 'web',
      insights: [{ cortexName: 'Review', insight: 'Only one generation may become visible.' }],
    });
    await firstBoot.markPersisted({
      ownerId,
      claims: batch.claimed,
      persistedMessageId: 'message-presentation-lease',
      messageRevision: 2,
    });

    let fence;
    const stages = ['initial_fence', 'binding', 'append', 'publish', 'settle'];
    for (const [index, stage] of stages.entries()) {
      currentTime = new Date(`2026-08-22T11:45:0${index}.000Z`);
      fence = await firstBoot.fencePresentation({
        ownerId,
        claims: batch.claimed,
        surface: 'web',
        parentMessageId,
        persistedMessageId: 'message-presentation-lease',
        messageRevision: 2,
        leaseMs: 10_000,
      });
      expect(fence).toEqual(
        expect.objectContaining({
          claimToken: batch.claimed[0].claimToken,
          presentationLeaseToken: expect.any(String),
        }),
      );
      const restarted = createCortexInsightDeliveryService({
        DeliveryModel: Delivery,
        now: () => currentTime,
        randomUUID: () => `restart-${stage}`,
        runtimeSlot: 'api-slot-presentation',
        runtimeEpoch: `boot-restarted-${stage}`,
      });
      await expect(
        restarted.claimPendingByParent({ ownerId, parentMessageId, surface: 'web' }),
      ).resolves.toEqual(expect.objectContaining({ claimed: [] }));
    }

    await expect(
      firstBoot.markPresented({
        ownerId,
        claims: fence.claims,
        surface: 'web',
        persistedMessageId: 'message-presentation-lease',
        messageRevision: 2,
        presentationGeneration: fence.generation,
        presentationClaimToken: fence.claimToken,
        presentationLeaseToken: fence.presentationLeaseToken,
        presentationRef: 'sse:stream:message-presentation-lease:2',
      }),
    ).resolves.toEqual([expect.objectContaining({ status: 'sent' })]);
  });
});

describe('EMO-UC-048 Telegram promoted-parent retry integration', () => {
  let mongoServer;
  let database;
  let Delivery;
  let Control;
  let User;
  let Conversation;
  let Message;

  beforeAll(async () => {
    mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    database = new mongoose.Mongoose();
    await database.connect(mongoServer.getUri());
    const models = createModels(database);
    Delivery = createViventiumCortexInsightDelivery(database);
    Control = models.LocalQaCortexFaultControl;
    User = models.User;
    Conversation = models.Conversation;
    Message = models.Message;
    await Promise.all([Delivery.syncIndexes(), Control.syncIndexes()]);
  });

  afterAll(async () => {
    await GenerationJobManager.destroy();
    await database?.disconnect();
    await mongoServer?.stop();
  });

  test('reclaims generation 2 and settles only its current receipt after the one-shot fault', async () => {
    const caseToken = 'A'.repeat(43);
    const caseTokenHash = `sha256:${crypto
      .createHash('sha256')
      .update(`case-token\u0000${caseToken}`)
      .digest('hex')}`;
    const componentArtifactDigest = `sha256:${'a'.repeat(64)}`;
    const ownerId = '64b000000000000000000148';
    const conversationId = `emo_uc_048_conversation_${'d'.repeat(32)}`;
    const parentMessageId = `emo_uc_048_parent_${'e'.repeat(32)}`;
    const streamId = 'emo-uc-048-telegram-retry-stream';
    const scopeHash = (kind, value) =>
      `sha256:${crypto.createHash('sha256').update(`${kind}\u0000${value}`).digest('hex')}`;
    let uuid = 0;
    const deliveryService = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => new Date(),
      randomUUID: () => `emo048-integration-${(uuid += 1)}`,
      runtimeSlot: 'emo048-integration-slot',
      runtimeEpoch: 'emo048-integration-boot',
    });

    await GenerationJobManager.destroy();
    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    await GenerationJobManager.initialize();
    const job = await GenerationJobManager.createJob(streamId, ownerId, conversationId, {
      interactionContext: {
        actor_kind: 'external_user',
        origin: 'interactive',
        surface: 'telegram',
        conversation_id: conversationId,
        revision: 1,
        source_event_id: 'emo048-integration-source',
      },
      adapterCapabilities: {
        segment_stability: 'immediate',
        supersede_scope: 'response_and_authoring',
      },
      deliveryPolicy: { commit_authority: 'external_adapter' },
    });
    await GenerationJobManager.updateMetadata(streamId, { responseMessageId: parentMessageId });

    const firstClaim = await deliveryService.claimBatch({
      ownerId,
      conversationId,
      parentMessageId,
      streamId,
      surface: 'telegram',
      insights: [{ cortexName: 'Synthetic QA cortex', insight: 'Synthetic integration result.' }],
    });
    expect(firstClaim.claimed).toEqual([
      expect.objectContaining({ claimGeneration: 1, attemptNumber: 1 }),
    ]);
    await deliveryService.markPersisted({
      ownerId,
      claims: firstClaim.claimed,
      persistedMessageId: parentMessageId,
      messageRevision: 1,
    });
    const webFence = await deliveryService.fencePresentation({
      ownerId,
      claims: firstClaim.claimed,
      surface: 'web',
      parentMessageId,
      persistedMessageId: parentMessageId,
      messageRevision: 1,
    });
    await deliveryService.markPresented({
      ownerId,
      claims: webFence.claims,
      surface: 'web',
      persistedMessageId: parentMessageId,
      messageRevision: 1,
      presentationGeneration: webFence.generation,
      presentationClaimToken: webFence.claimToken,
      presentationLeaseToken: webFence.presentationLeaseToken,
      presentationRef: `sse:${streamId}:${parentMessageId}:1`,
    });
    const firstTelegramFence = await deliveryService.fencePresentation({
      ownerId,
      claims: firstClaim.claimed,
      surface: 'telegram',
      parentMessageId,
      persistedMessageId: parentMessageId,
      messageRevision: 1,
    });
    await expect(
      GenerationJobManager.bindCortexPresentation(streamId, firstTelegramFence),
    ).resolves.toMatchObject({ generation: 1 });

    const fixtureExpiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    await User.create({
      _id: ownerId,
      email: `emo-uc-048-${'f'.repeat(32)}@local-qa.invalid`,
      provider: 'viventium_local_qa_fixture',
      idOnTheSource: `viventium:local-qa:emo_uc_048:${caseTokenHash}`,
      expiresAt: fixtureExpiresAt,
    });
    await Conversation.create({
      user: ownerId,
      conversationId,
      endpoint: 'openAI',
      title: 'EMO-UC-048 integration fixture',
      tags: ['viventium:local-qa:emo_uc_048', caseTokenHash],
      expiredAt: fixtureExpiresAt,
    });
    await Message.create({
      user: ownerId,
      conversationId,
      messageId: parentMessageId,
      endpoint: 'openAI',
      isCreatedByUser: false,
      text: '',
      expiredAt: fixtureExpiresAt,
      metadata: {
        viventium: {
          messageRevision: 1,
          cortexPresentationGeneration: 1,
          cortexPresentationClaimToken: firstTelegramFence.claimToken,
          localQaFixture: {
            schemaVersion: 1,
            caseId: 'emo_uc_048',
            componentArtifactDigest,
            caseTokenHash,
            ownerScopeHash: scopeHash('owner', ownerId),
            conversationScopeHash: scopeHash('conversation', conversationId),
            parentScopeHash: scopeHash('parent', parentMessageId),
            expiresAt: fixtureExpiresAt,
          },
        },
      },
    });
    const faultService = createLocalQaCortexFaultService({
      ControlModel: Control,
      UserModel: User,
      ConversationModel: Conversation,
      MessageModel: Message,
      env: {
        NODE_ENV: 'production',
        VIVENTIUM_LOCAL_QA_MODE: 'emo_uc_048',
        VIVENTIUM_LOCAL_QA_CASE_TOKEN: caseToken,
        VIVENTIUM_LOCAL_QA_COMPONENT_ARTIFACT_DIGEST: componentArtifactDigest,
      },
    });
    await faultService.arm({
      boundary: 'telegram_promoted_parent_presentation',
      ownerId,
      conversationId,
      parentMessageId,
      expiresInMs: 60_000,
    });

    const acknowledgement = {
      logical_turn_id: job.metadata.interactionContext.logical_turn_id,
      revision: 1,
      state: 'committed',
      presentation_ref: 'telegram:synthetic-chat:synthetic-message',
    };
    const receiptServices = {
      MessageModel: Message,
      consumeFault: (input) => faultService.consume(input),
      markPresentationFailedByParent: (input) =>
        deliveryService.markPresentationFailedByParent(input),
      markPresentationByParent: (input) => deliveryService.markPresentationByParent(input),
      requireExactSettlement: requireExactCortexInsightDeliverySettlement,
    };
    const firstAcknowledgement = await GenerationJobManager.acknowledgeDelivery(
      acknowledgement,
      'telegram',
      firstTelegramFence,
    );
    expect(firstAcknowledgement).toMatchObject({
      status: 'recorded',
      idempotent: false,
      presentation: { cortexPresentation: { generation: 1 } },
    });
    await expect(
      persistCortexTelegramPresentationReceipt(firstAcknowledgement, 'telegram', receiptServices),
    ).rejects.toMatchObject({ code: 'cortex_telegram_presentation_receipt_unavailable' });
    await expect(deliveryService.listByParent({ ownerId, parentMessageId })).resolves.toEqual([
      expect.objectContaining({ status: 'pending', claimGeneration: 1 }),
    ]);

    const secondClaim = await deliveryService.claimPendingByParent({
      ownerId,
      parentMessageId,
      surface: 'telegram',
    });
    expect(secondClaim.claimed).toEqual([
      expect.objectContaining({ claimGeneration: 2, attemptNumber: 2 }),
    ]);
    const secondTelegramFence = await deliveryService.fencePresentation({
      ownerId,
      claims: secondClaim.claimed,
      surface: 'telegram',
      parentMessageId,
      persistedMessageId: parentMessageId,
      messageRevision: 1,
    });
    await Message.updateOne(
      { user: ownerId, conversationId, messageId: parentMessageId },
      {
        $set: {
          'metadata.viventium.cortexPresentationGeneration': 2,
          'metadata.viventium.cortexPresentationClaimToken': secondTelegramFence.claimToken,
        },
      },
    );
    await expect(
      GenerationJobManager.bindCortexPresentation(streamId, secondTelegramFence),
    ).resolves.toMatchObject({ generation: 2 });

    const secondAcknowledgement = await GenerationJobManager.acknowledgeDelivery(
      acknowledgement,
      'telegram',
      secondTelegramFence,
    );
    expect(secondAcknowledgement).toMatchObject({
      status: 'recorded',
      idempotent: true,
      presentation: {
        cortexPresentation: {
          generation: 2,
          claimToken: secondTelegramFence.claimToken,
          presentationLeaseToken: secondTelegramFence.presentationLeaseToken,
        },
      },
    });
    await expect(
      persistCortexTelegramPresentationReceipt(secondAcknowledgement, 'telegram', receiptServices),
    ).resolves.toBeUndefined();
    const replayAcknowledgement = await GenerationJobManager.acknowledgeDelivery(
      acknowledgement,
      'telegram',
      secondTelegramFence,
    );
    await expect(
      persistCortexTelegramPresentationReceipt(replayAcknowledgement, 'telegram', receiptServices),
    ).resolves.toBeUndefined();

    const [row] = await deliveryService.listByParent({ ownerId, parentMessageId });
    const events = await deliveryService.listEvents({ ownerId, parentMessageId });
    const [control] = await faultService.query({
      boundary: 'telegram_promoted_parent_presentation',
      ownerId,
      conversationId,
      parentMessageId,
    });
    expect(row).toMatchObject({
      status: 'sent',
      claimGeneration: 2,
      attemptNumber: 2,
      presentedSurfaces: ['web', 'telegram'],
    });
    expect(events.filter((event) => event.transition === 'failure')).toEqual([
      expect.objectContaining({ claimGeneration: 1, reason: 'presentation_failed' }),
    ]);
    expect(
      events.filter((event) => event.transition === 'presented' && event.surface === 'telegram'),
    ).toEqual([expect.objectContaining({ claimGeneration: 2 })]);
    expect(control).toMatchObject({
      state: 'consumed',
      audit: [{ event: 'armed' }, { event: 'consumed' }],
    });
  });
});

describe('ViventiumCortexInsightDelivery persistence', () => {
  let mongoServer;
  let database;
  let Delivery;
  let outboxService;

  beforeAll(async () => {
    mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    database = new mongoose.Mongoose();
    await database.connect(mongoServer.getUri());
    Delivery = createViventiumCortexInsightDelivery(database);
    const Outbox = createViventiumCortexInsightOutbox(database);
    outboxService = createCortexInsightOutboxService({ OutboxModel: Outbox });
    await Promise.all([Delivery.syncIndexes(), Outbox.syncIndexes()]);
  });

  afterAll(async () => {
    await GenerationJobManager.destroy();
    await database?.disconnect();
    await mongoServer?.stop();
  });

  async function persistAndPresent({
    service,
    ownerId,
    claims,
    messageId,
    surfaces,
    revision = 1,
  }) {
    await service.markPersisted({
      ownerId,
      claims,
      persistedMessageId: messageId,
      messageRevision: revision,
    });
    for (const surface of surfaces) {
      const presentationFence = await service.fencePresentation({
        ownerId,
        claims,
        surface,
        persistedMessageId: messageId,
        messageRevision: revision,
      });
      await service.markPresented({
        ownerId,
        claims: presentationFence.claims,
        surface,
        persistedMessageId: messageId,
        messageRevision: revision,
        presentationGeneration: presentationFence.generation,
        presentationClaimToken: presentationFence.claimToken,
        presentationLeaseToken: presentationFence.presentationLeaseToken,
        presentationRef: `${surface}:synthetic:${messageId}:${revision}`,
      });
    }
  }

  test('keeps source revision immutable while presentation revision advances, including legacy rows', async () => {
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      runtimeSlot: 'revision-slot',
      runtimeEpoch: 'revision-boot',
      randomUUID: () => 'revision-claim',
    });
    const input = {
      ownerId: 'owner-revision-separation',
      conversationId: 'conversation-revision-separation',
      parentMessageId: 'parent-revision-separation',
      surface: 'web',
      messageRevision: 7,
      insights: [{ cortexId: 'review', insight: 'Revision separation result.' }],
    };
    const batch = await service.claimBatch(input);
    await service.markPersisted({
      ownerId: input.ownerId,
      claims: batch.claimed,
      persistedMessageId: 'message-revision-separation',
      messageRevision: 3,
    });

    const persisted = await Delivery.findOne({ userId: input.ownerId }).lean();
    expect(persisted).toEqual(
      expect.objectContaining({
        sourceRevision: 7,
        presentationRevision: 3,
        messageRevision: 3,
      }),
    );
    const [expected] =
      require('../server/services/viventium/CortexInsightDeliveryService').buildCortexInsightDeliveryCandidates(
        input,
      );
    expect(() =>
      require('../server/services/viventium/CortexInsightDeliveryService').requireExactCortexInsightPersistenceEnvelope(
        expected,
        persisted,
      ),
    ).not.toThrow();

    const legacyExpected = { ...expected, messageRevision: 7 };
    const legacyPersisted = { ...expected, messageRevision: 7 };
    delete legacyExpected.sourceRevision;
    delete legacyExpected.presentationRevision;
    delete legacyPersisted.sourceRevision;
    delete legacyPersisted.presentationRevision;
    expect(() =>
      require('../server/services/viventium/CortexInsightDeliveryService').requireExactCortexInsightPersistenceEnvelope(
        legacyExpected,
        legacyPersisted,
      ),
    ).not.toThrow();

    const legacyInsight = 'Persisted legacy delivery result.';
    const legacyHash = crypto.createHash('sha256').update(legacyInsight).digest('hex');
    await Delivery.collection.insertOne({
      deliveryKey: 'cortex_insight:legacy-revision-row',
      deliveryId: 'cidl_legacy_revision_row',
      userId: 'owner-legacy-revision',
      conversationId: 'conversation-legacy-revision',
      parentMessageId: 'parent-legacy-revision',
      cortexId: 'review',
      cortexName: 'Review',
      insight: legacyInsight,
      insightHash: legacyHash,
      graphResultHash: legacyHash,
      surface: 'web',
      requiredSurfaces: ['web'],
      presentedSurfaces: [],
      messageRevision: 7,
      status: 'pending',
      persistenceStatus: 'pending',
      attemptNumber: 0,
      recoveryAttemptNumber: 0,
      claimGeneration: 0,
      events: [],
      createdAt: new Date('2026-08-22T12:00:00.000Z'),
      updatedAt: new Date('2026-08-22T12:00:00.000Z'),
    });
    const legacyBatch = await service.claimPendingByParent({
      ownerId: 'owner-legacy-revision',
      parentMessageId: 'parent-legacy-revision',
      surface: 'web',
    });
    await service.markPersisted({
      ownerId: 'owner-legacy-revision',
      claims: legacyBatch.claimed,
      persistedMessageId: 'message-legacy-revision',
      messageRevision: 4,
    });
    expect(await Delivery.findOne({ userId: 'owner-legacy-revision' }).lean()).toEqual(
      expect.objectContaining({
        sourceRevision: 7,
        presentationRevision: 4,
        messageRevision: 4,
      }),
    );

    await expect(
      service.markPersisted({
        ownerId: input.ownerId,
        claims: batch.claimed,
        persistedMessageId: 'message-revision-separation',
        messageRevision: 2,
      }),
    ).rejects.toThrow(/cannot decrease/i);

    const revisionRow = await Delivery.findOne({ userId: input.ownerId });
    const revisionAttacks = [
      () =>
        Delivery.updateOne(
          { _id: revisionRow._id },
          { $set: { presentationRevision: 2, messageRevision: 2 } },
        ),
      () =>
        Delivery.findOneAndUpdate({ _id: revisionRow._id }, { $set: { presentationRevision: 4 } }),
      () => Delivery.updateMany({ _id: revisionRow._id }, { $set: { messageRevision: 4 } }),
      () =>
        Delivery.updateOne({ _id: revisionRow._id }, [
          { $set: { presentationRevision: 4, messageRevision: 4 } },
        ]),
      () =>
        Delivery.updateOne(
          { _id: revisionRow._id },
          { $set: { presentationRevision: 9, messageRevision: 9 } },
          { viventiumPresentationRevision: true },
        ),
      () =>
        Delivery.bulkWrite([
          {
            updateOne: {
              filter: { _id: revisionRow._id },
              update: { $set: { presentationRevision: 4, messageRevision: 4 } },
            },
          },
        ]),
      async () => {
        revisionRow.presentationRevision = 4;
        revisionRow.messageRevision = 4;
        return revisionRow.save();
      },
    ];
    for (const attack of revisionAttacks) {
      let rejection;
      try {
        await attack();
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
    }
    expect(await Delivery.findOne({ userId: input.ownerId }).lean()).toEqual(
      expect.objectContaining({ presentationRevision: 3, messageRevision: 3 }),
    );
  });

  test('advances presentation revision monotonically without changing source revision', async () => {
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      runtimeSlot: 'revision-advance-slot',
      runtimeEpoch: 'revision-advance-boot',
      randomUUID: () => 'revision-advance-claim',
    });
    const input = {
      ownerId: 'owner-revision-advance',
      conversationId: 'conversation-revision-advance',
      parentMessageId: 'parent-revision-advance',
      surface: 'web',
      messageRevision: 7,
      insights: [{ cortexId: 'review', insight: 'Monotonic presentation revision result.' }],
    };
    const batch = await service.claimBatch(input);
    await service.markPersisted({
      ownerId: input.ownerId,
      claims: batch.claimed,
      persistedMessageId: 'message-revision-advance',
      messageRevision: 3,
    });

    await expect(
      service.markPersisted({
        ownerId: input.ownerId,
        claims: batch.claimed,
        persistedMessageId: 'message-revision-advance',
        messageRevision: 4,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ sourceRevision: 7, presentationRevision: 4, messageRevision: 4 }),
    ]);
    expect(await Delivery.findOne({ userId: input.ownerId }).lean()).toEqual(
      expect.objectContaining({
        sourceRevision: 7,
        presentationRevision: 4,
        messageRevision: 4,
      }),
    );

    await expect(
      service.markPersisted({
        ownerId: input.ownerId,
        claims: batch.claimed,
        persistedMessageId: 'message-revision-advance',
        messageRevision: 3,
      }),
    ).rejects.toThrow(/cannot decrease/i);
    await expect(
      service.markPersisted({
        ownerId: input.ownerId,
        claims: batch.claimed,
        persistedMessageId: 'different-message-revision-advance',
        messageRevision: 5,
      }),
    ).rejects.toThrow(/transition conflict/i);
    expect(await Delivery.findOne({ userId: input.ownerId }).lean()).toEqual(
      expect.objectContaining({
        sourceRevision: 7,
        persistedMessageId: 'message-revision-advance',
        presentationRevision: 4,
        messageRevision: 4,
      }),
    );
  });

  test('invalidates older surface receipts when presentation revision advances', async () => {
    let currentTime = new Date('2026-08-22T12:30:00.000Z');
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => currentTime,
      runtimeSlot: 'revision-receipt-slot',
      runtimeEpoch: 'revision-receipt-boot',
      randomUUID: (() => {
        let sequence = 0;
        return () => `revision-receipt-${++sequence}`;
      })(),
    });
    const ownerId = 'owner-revision-receipts';
    const persistedMessageId = 'message-revision-receipts';
    const batch = await service.claimBatch({
      ownerId,
      conversationId: 'conversation-revision-receipts',
      parentMessageId: 'parent-revision-receipts',
      surface: 'telegram',
      messageRevision: 7,
      insights: [{ cortexId: 'review', insight: 'Revision-scoped presentation receipts.' }],
    });
    await service.markPersisted({
      ownerId,
      claims: batch.claimed,
      persistedMessageId,
      messageRevision: 3,
    });
    const webRevisionThree = await service.fencePresentation({
      ownerId,
      claims: batch.claimed,
      surface: 'web',
      persistedMessageId,
      messageRevision: 3,
    });
    await service.markPresented({
      ownerId,
      claims: webRevisionThree.claims,
      surface: 'web',
      persistedMessageId,
      messageRevision: 3,
      presentationGeneration: webRevisionThree.generation,
      presentationClaimToken: webRevisionThree.claimToken,
      presentationLeaseToken: webRevisionThree.presentationLeaseToken,
      presentationRef: 'web:synthetic:revision-receipts:3',
    });

    await service.markPersisted({
      ownerId,
      claims: batch.claimed,
      persistedMessageId,
      messageRevision: 4,
    });
    expect(
      await Delivery.findOne({ userId: ownerId }).select('+presentationReceiptHashes').lean(),
    ).toEqual(
      expect.objectContaining({
        status: 'claimed',
        presentationRevision: 4,
        presentedSurfaces: [],
        presentationReceiptHashes: [],
      }),
    );

    currentTime = new Date('2026-08-22T12:30:01.000Z');
    const telegramRevisionFour = await service.fencePresentation({
      ownerId,
      claims: batch.claimed,
      surface: 'telegram',
      persistedMessageId,
      messageRevision: 4,
    });
    await service.markPresented({
      ownerId,
      claims: telegramRevisionFour.claims,
      surface: 'telegram',
      persistedMessageId,
      messageRevision: 4,
      presentationGeneration: telegramRevisionFour.generation,
      presentationClaimToken: telegramRevisionFour.claimToken,
      presentationLeaseToken: telegramRevisionFour.presentationLeaseToken,
      presentationRef: 'telegram:synthetic:revision-receipts:4',
    });
    await service.markPersisted({
      ownerId,
      claims: batch.claimed,
      persistedMessageId,
      messageRevision: 4,
    });
    expect(
      await Delivery.findOne({ userId: ownerId }).select('+presentationReceiptHashes').lean(),
    ).toEqual(
      expect.objectContaining({
        status: 'claimed',
        presentationRevision: 4,
        presentedSurfaces: ['telegram'],
        presentationReceiptHashes: [expect.stringMatching(/^[a-f0-9]{64}$/)],
      }),
    );

    currentTime = new Date('2026-08-22T12:30:02.000Z');
    const webRevisionFour = await service.fencePresentation({
      ownerId,
      claims: batch.claimed,
      surface: 'web',
      persistedMessageId,
      messageRevision: 4,
    });
    await expect(
      service.markPresented({
        ownerId,
        claims: webRevisionFour.claims,
        surface: 'web',
        persistedMessageId,
        messageRevision: 4,
        presentationGeneration: webRevisionFour.generation,
        presentationClaimToken: webRevisionFour.claimToken,
        presentationLeaseToken: webRevisionFour.presentationLeaseToken,
        presentationRef: 'web:synthetic:revision-receipts:4',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'sent',
        presentedSurfaces: ['telegram', 'web'],
        sourceRevision: 7,
        presentationRevision: 4,
      }),
    ]);
  });

  test('applies one physical CAS for concurrent identical presentation advances', async () => {
    const firstService = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      runtimeSlot: 'revision-cas-slot-a',
      runtimeEpoch: 'revision-cas-boot',
      randomUUID: () => 'revision-cas-claim',
    });
    const secondService = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      runtimeSlot: 'revision-cas-slot-b',
      runtimeEpoch: 'revision-cas-boot',
      randomUUID: () => 'revision-cas-second',
    });
    const input = {
      ownerId: 'owner-revision-cas',
      conversationId: 'conversation-revision-cas',
      parentMessageId: 'parent-revision-cas',
      surface: 'web',
      messageRevision: 7,
      insights: [{ cortexId: 'review', insight: 'Concurrent revision CAS result.' }],
    };
    const batch = await firstService.claimBatch(input);
    await firstService.markPersisted({
      ownerId: input.ownerId,
      claims: batch.claimed,
      persistedMessageId: 'message-revision-cas',
      messageRevision: 3,
    });

    const results = await Promise.allSettled(
      [firstService, secondService].map((service) =>
        service.markPersisted({
          ownerId: input.ownerId,
          claims: batch.claimed,
          persistedMessageId: 'message-revision-cas',
          messageRevision: 4,
        }),
      ),
    );
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    for (const result of results.filter((entry) => entry.status === 'rejected')) {
      expect(result.reason).toMatchObject({
        code: 'cortex_insight_delivery_settlement_conflict',
      });
    }
    const persisted = await Delivery.findOne({ userId: input.ownerId }).select('+events').lean();
    expect(persisted).toEqual(
      expect.objectContaining({
        sourceRevision: 7,
        presentationRevision: 4,
        messageRevision: 4,
      }),
    );
    expect(persisted.events.filter((event) => event.transition === 'persisted')).toHaveLength(2);
  });

  test('rejects stable identity mutation through every supported update form', async () => {
    expect(Delivery.schema.path('sourceRevision')).toBeDefined();
    const stableFields = [
      'deliveryKey',
      'deliveryId',
      'userId',
      'conversationId',
      'parentMessageId',
      'cortexId',
      'cortexName',
      'sourceRevision',
      'batchId',
      'batchSize',
      'batchMemberHashes',
    ];
    for (const field of stableFields) {
      expect(Delivery.schema.path(field)?.options?.immutable).toBe(true);
    }

    const makeRow = async (suffix) =>
      Delivery.create({
        deliveryKey: `cortex_insight:stable-${suffix}`,
        deliveryId: `cidl_stable_${suffix}`,
        userId: 'owner-stable-identity',
        conversationId: 'conversation-stable-identity',
        parentMessageId: `parent-stable-${suffix}`,
        cortexId: 'review',
        cortexName: 'Review',
        insight: `Stable identity insight ${suffix}.`,
        insightHash: crypto
          .createHash('sha256')
          .update(`Stable identity insight ${suffix}.`)
          .digest('hex'),
        graphResultHash: crypto
          .createHash('sha256')
          .update(`Stable identity insight ${suffix}.`)
          .digest('hex'),
        surface: 'web',
        requiredSurfaces: ['web'],
        sourceRevision: 5,
        presentationRevision: 1,
        messageRevision: 1,
        status: 'dropped',
        dropReason: 'semantic_suppression',
        droppedAt: new Date('2026-08-22T12:00:00.000Z'),
        expiresAt: new Date('2026-09-22T12:00:00.000Z'),
      });
    const replacementFor = (row) => {
      const replacement = row.toObject();
      delete replacement._id;
      delete replacement.__v;
      replacement.deliveryId = `${replacement.deliveryId}-changed`;
      return replacement;
    };
    const attacks = [
      [
        'updateOne',
        (row) => Delivery.updateOne({ _id: row._id }, { $set: { deliveryKey: 'changed' } }),
      ],
      ['updateMany', (row) => Delivery.updateMany({ _id: row._id }, { $unset: { userId: 1 } })],
      [
        'findOneAndUpdate',
        (row) =>
          Delivery.findOneAndUpdate({ _id: row._id }, { $set: { parentMessageId: 'changed' } }),
      ],
      [
        'findByIdAndUpdate',
        (row) => Delivery.findByIdAndUpdate(row._id, { $set: { cortexId: 'changed' } }),
      ],
      ['replaceOne', (row) => Delivery.replaceOne({ _id: row._id }, replacementFor(row))],
      ['document updateOne', (row) => row.updateOne({ $set: { cortexName: 'Changed' } })],
      [
        'pipeline update',
        (row) => Delivery.updateOne({ _id: row._id }, [{ $set: { sourceRevision: 6 } }]),
      ],
      [
        'bulk update',
        (row) =>
          Delivery.bulkWrite([
            {
              updateOne: { filter: { _id: row._id }, update: { $set: { deliveryId: 'changed' } } },
            },
          ]),
      ],
      [
        'document save',
        async (row) => {
          row.conversationId = 'changed';
          return row.save();
        },
      ],
    ];

    for (const [name, attack] of attacks) {
      const suffix = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      const row = await makeRow(suffix);
      let rejection;
      try {
        await attack(row);
      } catch (error) {
        rejection = error;
      }
      expect(rejection || `attack resolved: ${name}`).toBeInstanceOf(Error);
      const after = await Delivery.findById(row._id).lean();
      expect(after).toEqual(
        expect.objectContaining({
          deliveryKey: `cortex_insight:stable-${suffix}`,
          deliveryId: `cidl_stable_${suffix}`,
          userId: 'owner-stable-identity',
          conversationId: 'conversation-stable-identity',
          parentMessageId: `parent-stable-${suffix}`,
          cortexId: 'review',
          cortexName: 'Review',
          sourceRevision: 5,
        }),
      );
    }
  });

  test('restores the same private request-pinned Feelings receipt after service restart', async () => {
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
    const firstBoot = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      runtimeSlot: 'feelings-slot',
      runtimeEpoch: 'feelings-boot-1',
    });
    await firstBoot.recordBatch({
      ownerId: 'owner-feelings-restart',
      conversationId: 'conversation-feelings-restart',
      parentMessageId: 'parent-feelings-restart',
      surface: 'telegram',
      feelingSnapshot,
      insights: [{ cortexId: 'review', insight: 'Exact result with pinned state.' }],
    });

    const privateRow = await Delivery.findOne({
      userId: 'owner-feelings-restart',
      parentMessageId: 'parent-feelings-restart',
    })
      .select('+feelingSnapshot')
      .lean();
    expect(privateRow.feelingSnapshot).toEqual({
      ...feelingSnapshot,
      asOf: new Date(feelingSnapshot.asOf),
    });
    await expect(
      Delivery.updateOne(
        { _id: privateRow._id },
        { $set: { 'feelingSnapshot.snapshotHash': 'b'.repeat(64) } },
      ),
    ).rejects.toThrow(/immutable/i);

    const restarted = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      runtimeSlot: 'feelings-slot',
      runtimeEpoch: 'feelings-boot-2',
    });
    const claimed = await restarted.claimPendingByParent({
      ownerId: 'owner-feelings-restart',
      parentMessageId: 'parent-feelings-restart',
      surface: 'telegram',
    });
    expect(claimed.recoveryContext.feelingSnapshot).toEqual(feelingSnapshot);
    expect(JSON.stringify(claimed.deliveries)).not.toContain(feelingSnapshot.capsule);
  });

  test('durably defers recovery for typed parent-state gates', async () => {
    let currentTime = new Date('2026-08-22T08:00:00.000Z');
    let uuid = 0;
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => currentTime,
      randomUUID: () => `parent-state-deferral-${(uuid += 1)}`,
      runtimeSlot: 'parent-state-deferral-slot',
      runtimeEpoch: 'parent-state-deferral-boot',
    });

    for (const reason of ['parent_state_unavailable', 'parent_generation_active']) {
      const suffix = reason.replace(/_/g, '-');
      const ownerId = `owner-${suffix}`;
      const parentMessageId = `parent-${suffix}`;
      await service.recordBatch({
        ownerId,
        conversationId: `conversation-${suffix}`,
        parentMessageId,
        surface: 'web',
        insights: [{ cortexId: 'review', insight: `Exact ${reason} recovery result.` }],
      });
      const retryEligibleAt = new Date(currentTime.getTime() + 1_000);

      await expect(
        service.deferRecoverableParent({ ownerId, parentMessageId, surface: 'web', reason }),
      ).resolves.toEqual({
        deferred: 1,
        reason,
        recoveryAttemptNumber: 1,
        retryEligibleAt,
      });
      const row = await Delivery.findOne({ userId: ownerId, parentMessageId })
        .select('+events')
        .lean();
      expect(row).toEqual(
        expect.objectContaining({
          recoveryAttemptNumber: 1,
          recoveryEligibleAt: retryEligibleAt,
        }),
      );
      expect(row.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            transition: 'recovery_deferred',
            reason,
            recoveryAttemptNumber: 1,
            retryEligibleAt,
          }),
        ]),
      );

      currentTime = retryEligibleAt;
      const claimed = await service.claimPendingByParent({
        ownerId,
        parentMessageId,
        surface: 'web',
      });
      await service.markDropped({
        ownerId,
        claims: claimed.claimed,
        dropReason: 'semantic_suppression',
      });
    }
  });

  test('defers a failed oldest parent so bounded restart pages deliver later parents before retry', async () => {
    let currentTime = new Date('2026-08-22T09:00:00.000Z');
    let uuid = 0;
    const createService = (runtimeEpoch) =>
      createCortexInsightDeliveryService({
        DeliveryModel: Delivery,
        now: () => currentTime,
        randomUUID: () => `fair-recovery-${(uuid += 1)}`,
        runtimeSlot: 'fair-recovery-slot',
        runtimeEpoch,
      });
    const firstBoot = createService('fair-recovery-boot-1');

    await firstBoot.recordBatch({
      ownerId: 'owner-fair-recovery',
      conversationId: 'conversation-oldest',
      parentMessageId: 'parent-oldest-failure',
      surface: 'web',
      insights: [
        { cortexId: 'review-a', insight: 'Oldest exact result A.' },
        { cortexId: 'review-b', insight: 'Oldest exact result B.' },
      ],
    });
    currentTime = new Date(currentTime.getTime() + 100);
    await firstBoot.recordBatch({
      ownerId: 'owner-fair-recovery',
      conversationId: 'conversation-healthy',
      parentMessageId: 'parent-later-healthy',
      surface: 'web',
      insights: [{ cortexId: 'review', insight: 'Later exact healthy result.' }],
    });
    currentTime = new Date(currentTime.getTime() + 100);
    await firstBoot.recordBatch({
      ownerId: 'owner-other',
      conversationId: 'conversation-other',
      parentMessageId: 'parent-oldest-failure',
      surface: 'web',
      insights: [{ cortexId: 'review', insight: 'Other owner exact result.' }],
    });
    currentTime = new Date(currentTime.getTime() + 800);

    await expect(firstBoot.listRecoverableParents({ limit: 1 })).resolves.toEqual([
      expect.objectContaining({
        ownerId: 'owner-fair-recovery',
        parentMessageId: 'parent-oldest-failure',
      }),
    ]);

    const deliveredParents = [];
    const recoveryOptions = {
      limit: 1,
      createMessage: jest.fn(async ({ parentMessageId }) => {
        deliveredParents.push(parentMessageId);
        return { messageId: `follow-up-${parentMessageId}`, revision: 1 };
      }),
      bindStreamPresentation: async ({ presentationFence }) => presentationFence,
      presentSurface: jest.fn(async ({ presentationFence }) => ({
        surface: 'web',
        presentationGeneration: presentationFence.generation,
        presentationClaimToken: presentationFence.claimToken,
        presentationLeaseToken: presentationFence.presentationLeaseToken,
        presentationRef: `sse:fair-recovery:${presentationFence.messageId}:1`,
      })),
    };
    const firstScanService = {
      ...firstBoot,
      claimPendingByParent: jest.fn(async ({ parentMessageId, ...input }) => {
        if (parentMessageId === 'parent-oldest-failure') {
          throw Object.assign(new Error('synthetic oldest claim failure'), {
            code: 'synthetic_claim_failure',
          });
        }
        return firstBoot.claimPendingByParent({ parentMessageId, ...input });
      }),
    };

    await expect(
      recoverPending({ ...recoveryOptions, deliveryService: firstScanService }),
    ).resolves.toEqual(expect.objectContaining({ scanned: 1, claimed: 0, sent: 0, failed: 1 }));

    const deferredRows = await Delivery.find({
      userId: 'owner-fair-recovery',
      parentMessageId: 'parent-oldest-failure',
    })
      .select('+events')
      .sort({ deliveryId: 1 })
      .lean();
    expect(deferredRows).toHaveLength(2);
    expect(
      deferredRows.every(
        (row) =>
          row.recoveryAttemptNumber === 1 &&
          new Date(row.recoveryEligibleAt).getTime() - currentTime.getTime() === 1_000,
      ),
    ).toBe(true);
    expect(
      deferredRows.every((row) =>
        row.events.some(
          (event) =>
            event.transition === 'recovery_deferred' &&
            event.reason === 'recovery_claim_failed' &&
            event.recoveryAttemptNumber === 1,
        ),
      ),
    ).toBe(true);
    await expect(
      Delivery.findOne({ userId: 'owner-other', parentMessageId: 'parent-oldest-failure' }).lean(),
    ).resolves.toEqual(expect.objectContaining({ recoveryAttemptNumber: 0 }));

    const secondBoot = createService('fair-recovery-boot-2');
    await expect(
      recoverPending({ ...recoveryOptions, deliveryService: secondBoot }),
    ).resolves.toEqual(expect.objectContaining({ scanned: 1, claimed: 1, sent: 1, failed: 0 }));
    expect(deliveredParents).toEqual(['parent-later-healthy']);

    currentTime = new Date(currentTime.getTime() + 60_000);
    const thirdBoot = createService('fair-recovery-boot-3');
    await expect(
      recoverPending({ ...recoveryOptions, deliveryService: thirdBoot }),
    ).resolves.toEqual(expect.objectContaining({ scanned: 1, claimed: 2, sent: 2, failed: 0 }));
    expect(deliveredParents).toEqual(['parent-later-healthy', 'parent-oldest-failure']);

    const healthyEvents = await thirdBoot.listEvents({
      ownerId: 'owner-fair-recovery',
      parentMessageId: 'parent-later-healthy',
    });
    expect(healthyEvents.filter((event) => event.transition === 'claimed')).toHaveLength(1);
    expect(healthyEvents.filter((event) => event.transition === 'sent')).toHaveLength(1);

    const otherOwnerClaim = await thirdBoot.claimPendingByParent({
      ownerId: 'owner-other',
      parentMessageId: 'parent-oldest-failure',
      surface: 'web',
    });
    await thirdBoot.markDropped({
      ownerId: 'owner-other',
      claims: otherOwnerClaim.claimed,
      dropReason: 'semantic_suppression',
    });
  });

  test('rejects a stale-listed parent after another service durably defers its exact owner batch', async () => {
    let currentTime = new Date('2026-08-22T22:00:00.000Z');
    let uuid = 0;
    const createService = (runtimeEpoch) =>
      createCortexInsightDeliveryService({
        DeliveryModel: Delivery,
        now: () => currentTime,
        randomUUID: () => `eligibility-race-${(uuid += 1)}`,
        runtimeSlot: 'eligibility-race-slot',
        runtimeEpoch,
      });
    const staleScanner = createService('eligibility-race-scanner');
    const concurrentDeferrer = createService('eligibility-race-deferrer');
    const ownerId = 'owner-eligibility-race';
    const otherOwnerId = 'owner-eligibility-race-other';
    const parentMessageId = 'parent-eligibility-race';

    await staleScanner.recordBatch({
      ownerId,
      conversationId: 'conversation-eligibility-race',
      parentMessageId,
      surface: 'web',
      insights: [
        { cortexId: 'review-a', insight: 'Exact eligibility result A.' },
        { cortexId: 'review-b', insight: 'Exact eligibility result B.' },
      ],
    });
    await staleScanner.recordBatch({
      ownerId: otherOwnerId,
      conversationId: 'conversation-eligibility-race-other',
      parentMessageId,
      surface: 'web',
      insights: [{ cortexId: 'review', insight: 'Other owner exact eligibility result.' }],
    });

    await expect(staleScanner.listRecoverableParents({ limit: 10 })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerId, parentMessageId }),
        expect.objectContaining({ ownerId: otherOwnerId, parentMessageId }),
      ]),
    );
    await expect(
      concurrentDeferrer.deferRecoverableParent({
        ownerId,
        parentMessageId,
        surface: 'web',
        reason: 'recovery_claim_failed',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        deferred: 2,
        recoveryAttemptNumber: 1,
        retryEligibleAt: new Date('2026-08-22T22:00:01.000Z'),
      }),
    );
    const eventsAfterDeferral = await staleScanner.listEvents({ ownerId, parentMessageId });

    await expect(
      staleScanner.claimPendingByParent({ ownerId, parentMessageId, surface: 'web' }),
    ).resolves.toEqual(
      expect.objectContaining({
        claimed: [],
        noClaimReason: 'recovery_not_yet_eligible',
      }),
    );
    await expect(staleScanner.listEvents({ ownerId, parentMessageId })).resolves.toEqual(
      eventsAfterDeferral,
    );

    const otherOwnerClaim = await staleScanner.claimPendingByParent({
      ownerId: otherOwnerId,
      parentMessageId,
      surface: 'web',
    });
    expect(otherOwnerClaim.claimed).toHaveLength(1);
    await staleScanner.markDropped({
      ownerId: otherOwnerId,
      claims: otherOwnerClaim.claimed,
      dropReason: 'semantic_suppression',
    });

    currentTime = new Date('2026-08-22T22:00:01.000Z');
    const eligibleClaim = await staleScanner.claimPendingByParent({
      ownerId,
      parentMessageId,
      surface: 'web',
    });
    expect(eligibleClaim.claimed).toHaveLength(2);
    await expect(
      staleScanner.claimPendingByParent({ ownerId, parentMessageId, surface: 'web' }),
    ).resolves.toEqual(expect.objectContaining({ claimed: [] }));
    const finalEvents = await staleScanner.listEvents({ ownerId, parentMessageId });
    expect(finalEvents.filter((event) => event.transition === 'claimed')).toHaveLength(2);
    await staleScanner.markDropped({
      ownerId,
      claims: eligibleClaim.claimed,
      dropReason: 'semantic_suppression',
    });
  });

  test('returns a typed no-claim for one parent with mixed persisted recovery eligibility', async () => {
    let currentTime = new Date('2026-08-22T22:10:00.000Z');
    let uuid = 0;
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => currentTime,
      randomUUID: () => `mixed-eligibility-${(uuid += 1)}`,
      runtimeSlot: 'mixed-eligibility-slot',
      runtimeEpoch: 'mixed-eligibility-boot',
    });
    const ownerId = 'owner-mixed-eligibility';
    const parentMessageId = 'parent-mixed-eligibility';
    await service.recordBatch({
      ownerId,
      conversationId: 'conversation-mixed-eligibility',
      parentMessageId,
      surface: 'web',
      insights: [
        { cortexId: 'review-a', insight: 'Mixed eligibility exact result A.' },
        { cortexId: 'review-b', insight: 'Mixed eligibility exact result B.' },
      ],
    });
    const rows = await Delivery.find({ userId: ownerId, parentMessageId })
      .sort({ deliveryId: 1 })
      .lean();
    const retryEligibleAt = new Date('2026-08-22T22:10:01.000Z');
    await Delivery.updateOne(
      { userId: ownerId, deliveryId: rows[0].deliveryId },
      {
        $set: { recoveryAttemptNumber: 1, recoveryEligibleAt: retryEligibleAt },
        $push: {
          events: {
            transition: 'recovery_deferred',
            attemptNumber: 0,
            claimGeneration: 0,
            eventAt: currentTime,
            reason: 'recovery_claim_failed',
            surface: 'web',
            recoveryAttemptNumber: 1,
            retryEligibleAt,
          },
        },
      },
      { runValidators: true },
    );
    const eventsBeforeClaim = await service.listEvents({ ownerId, parentMessageId });

    await expect(
      service.claimPendingByParent({ ownerId, parentMessageId, surface: 'web' }),
    ).resolves.toEqual(
      expect.objectContaining({
        claimed: [],
        noClaimReason: 'recovery_parent_inconsistent_eligibility',
      }),
    );
    await expect(service.listEvents({ ownerId, parentMessageId })).resolves.toEqual(
      eventsBeforeClaim,
    );
    await expect(Delivery.find({ userId: ownerId, parentMessageId }).lean()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recoveryEligibleAt: retryEligibleAt }),
        expect.objectContaining({ recoveryEligibleAt: null }),
      ]),
    );

    currentTime = retryEligibleAt;
    const exactClaim = await service.claimPendingByParent({
      ownerId,
      parentMessageId,
      surface: 'web',
    });
    expect(exactClaim.claimed).toHaveLength(2);
    const finalEvents = await service.listEvents({ ownerId, parentMessageId });
    expect(finalEvents.filter((event) => event.transition === 'claimed')).toHaveLength(2);
    await service.markDropped({
      ownerId,
      claims: exactClaim.claimed,
      dropReason: 'semantic_suppression',
    });
  });

  test('rejects a sequential conflicting parent envelope before persisting it', async () => {
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      runtimeSlot: 'mixed-envelope-slot',
      runtimeEpoch: 'mixed-envelope-boot',
      randomUUID: (() => {
        let sequence = 0;
        return () => `mixed-envelope-${++sequence}`;
      })(),
    });
    const ownerId = 'owner-mixed-envelope';
    const parentMessageId = 'parent-mixed-envelope';
    await service.recordBatch({
      ownerId,
      conversationId: 'conversation-mixed-envelope-a',
      parentMessageId,
      surface: 'web',
      streamId: 'stream-mixed-envelope-a',
      messageRevision: 1,
      insights: [{ cortexId: 'review-a', insight: 'Mixed envelope result A.' }],
    });
    await expect(
      service.recordBatch({
        ownerId,
        conversationId: 'conversation-mixed-envelope-b',
        parentMessageId,
        surface: 'telegram',
        streamId: 'stream-mixed-envelope-b',
        messageRevision: 2,
        insights: [{ cortexId: 'review-b', insight: 'Mixed envelope result B.' }],
      }),
    ).rejects.toMatchObject({ code: 'cortex_insight_delivery_batch_mixed_envelope' });

    expect(
      await Delivery.find({ userId: ownerId, parentMessageId })
        .select('+streamId')
        .sort({ conversationId: 1 })
        .lean(),
    ).toEqual([
      expect.objectContaining({
        conversationId: 'conversation-mixed-envelope-a',
        status: 'pending',
        streamId: 'stream-mixed-envelope-a',
        sourceRevision: 1,
      }),
    ]);
    const exactClaim = await service.claimPendingByParent({
      ownerId,
      parentMessageId,
      surface: 'web',
    });
    expect(exactClaim).toEqual(expect.objectContaining({ claimed: [expect.any(Object)] }));
    await service.markDropped({
      ownerId,
      claims: exactClaim.claimed,
      dropReason: 'semantic_suppression',
    });
  });

  test('admits exactly one coherent parent envelope under concurrent conflicting writes', async () => {
    const services = ['a', 'b'].map((suffix) =>
      createCortexInsightDeliveryService({
        DeliveryModel: Delivery,
        runtimeSlot: `concurrent-admission-slot-${suffix}`,
        runtimeEpoch: `concurrent-admission-boot-${suffix}`,
      }),
    );
    const ownerId = 'owner-concurrent-parent-admission';
    const parentMessageId = 'parent-concurrent-parent-admission';
    const batches = [
      {
        ownerId,
        conversationId: 'conversation-concurrent-admission-a',
        parentMessageId,
        surface: 'web',
        streamId: 'stream-concurrent-admission-a',
        messageRevision: 1,
        insights: [
          { cortexId: 'review-a-1', insight: 'Concurrent envelope A first member.' },
          { cortexId: 'review-a-2', insight: 'Concurrent envelope A second member.' },
        ],
      },
      {
        ownerId,
        conversationId: 'conversation-concurrent-admission-b',
        parentMessageId,
        surface: 'telegram',
        streamId: 'stream-concurrent-admission-b',
        messageRevision: 2,
        insights: [
          { cortexId: 'review-b-1', insight: 'Concurrent envelope B first member.' },
          { cortexId: 'review-b-2', insight: 'Concurrent envelope B second member.' },
        ],
      },
    ];

    const results = await Promise.allSettled(
      batches.map((batch, index) => services[index].recordBatch(batch)),
    );
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          code: 'cortex_insight_delivery_batch_mixed_envelope',
        }),
      }),
    ]);

    const rows = await Delivery.find({ userId: ownerId, parentMessageId })
      .select('+streamId +batchMemberHashes')
      .lean();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.conversationId)).size).toBe(1);
    expect(new Set(rows.map((row) => row.surface)).size).toBe(1);
    expect(new Set(rows.map((row) => row.streamId)).size).toBe(1);
    expect(new Set(rows.map((row) => row.sourceRevision)).size).toBe(1);
    expect(new Set(rows.map((row) => row.batchId)).size).toBe(1);
    expect(rows.every((row) => row.batchSize === 2)).toBe(true);
    const exactClaim = await services[0].claimPendingByParent({
      ownerId,
      parentMessageId,
      surface: rows[0].surface,
    });
    await services[0].markDropped({
      ownerId,
      claims: exactClaim.claimed,
      dropReason: 'semantic_suppression',
    });
  });

  test('keeps an exact concurrent parent-envelope retry idempotent', async () => {
    const services = ['a', 'b'].map((suffix) =>
      createCortexInsightDeliveryService({
        DeliveryModel: Delivery,
        runtimeSlot: `idempotent-admission-slot-${suffix}`,
        runtimeEpoch: `idempotent-admission-boot-${suffix}`,
      }),
    );
    const input = {
      ownerId: 'owner-idempotent-parent-admission',
      conversationId: 'conversation-idempotent-parent-admission',
      parentMessageId: 'parent-idempotent-parent-admission',
      surface: 'web',
      streamId: 'stream-idempotent-parent-admission',
      messageRevision: 3,
      insights: [
        { cortexId: 'review-a', insight: 'Idempotent parent member A.' },
        { cortexId: 'review-b', insight: 'Idempotent parent member B.' },
      ],
    };

    await expect(
      Promise.all(services.map((service) => service.recordBatch(input))),
    ).resolves.toEqual([
      expect.objectContaining({ batchSize: 2 }),
      expect.objectContaining({ batchSize: 2 }),
    ]);
    const rows = await Delivery.find({
      userId: input.ownerId,
      parentMessageId: input.parentMessageId,
    }).lean();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.batchId)).size).toBe(1);
    const exactClaim = await services[0].claimPendingByParent({
      ownerId: input.ownerId,
      parentMessageId: input.parentMessageId,
      surface: input.surface,
    });
    await services[0].markDropped({
      ownerId: input.ownerId,
      claims: exactClaim.claimed,
      dropReason: 'semantic_suppression',
    });
  });

  test('rejects a direct conflicting admission without poisoning existing presentation', async () => {
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      runtimeSlot: 'direct-mixed-envelope-slot',
      runtimeEpoch: 'direct-mixed-envelope-boot',
      randomUUID: (() => {
        let sequence = 0;
        return () => `direct-mixed-envelope-${++sequence}`;
      })(),
    });
    const ownerId = 'owner-direct-mixed-envelope';
    const parentMessageId = 'parent-direct-mixed-envelope';
    const first = await service.claimBatch({
      ownerId,
      conversationId: 'conversation-direct-mixed-envelope-a',
      parentMessageId,
      surface: 'web',
      streamId: 'stream-direct-mixed-envelope-a',
      messageRevision: 1,
      insights: [{ cortexId: 'review-a', insight: 'Direct mixed envelope result A.' }],
    });
    await service.markPersisted({
      ownerId,
      claims: first.claimed,
      persistedMessageId: 'message-direct-mixed-envelope',
      messageRevision: 1,
    });

    await expect(
      service.claimBatch({
        ownerId,
        conversationId: 'conversation-direct-mixed-envelope-b',
        parentMessageId,
        surface: 'telegram',
        streamId: 'stream-direct-mixed-envelope-b',
        messageRevision: 2,
        insights: [{ cortexId: 'review-b', insight: 'Direct mixed envelope result B.' }],
      }),
    ).rejects.toMatchObject({ code: 'cortex_insight_delivery_batch_mixed_envelope' });
    const presentationFence = await service.fencePresentation({
      ownerId,
      claims: first.claimed,
      surface: 'web',
      persistedMessageId: 'message-direct-mixed-envelope',
      messageRevision: 1,
    });
    expect(presentationFence).toEqual(
      expect.objectContaining({
        claims: [expect.objectContaining({ deliveryId: first.claimed[0].deliveryId })],
        presentationLeaseToken: expect.any(String),
      }),
    );
    await expect(
      service.markPresented({
        ownerId,
        claims: presentationFence.claims,
        surface: 'web',
        persistedMessageId: 'message-direct-mixed-envelope',
        messageRevision: 1,
        presentationGeneration: presentationFence.generation,
        presentationClaimToken: presentationFence.claimToken,
        presentationLeaseToken: presentationFence.presentationLeaseToken,
        presentationRef: 'web:direct-mixed-envelope',
      }),
    ).resolves.toEqual([expect.objectContaining({ status: 'sent' })]);
    expect(
      await Delivery.find({ userId: ownerId, parentMessageId }).sort({ conversationId: 1 }).lean(),
    ).toEqual([
      expect.objectContaining({
        conversationId: 'conversation-direct-mixed-envelope-a',
        status: 'sent',
      }),
    ]);
  });

  test('carries the completed graph insight unchanged to one exact durable receipt', async () => {
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => new Date('2026-08-22T10:00:00.000Z'),
      randomUUID: () => 'completed-graph-claim',
    });
    const exactInsight = extractCompletedCortexGraphInsight({
      completedContent: [
        { type: 'tool_result', tool_use_id: 'synthetic-call', content: 'synthetic evidence' },
        { type: 'text', text: 'The exact completed graph insight.' },
      ],
      streamedContentParts: [{ type: 'text', text: 'Stale incremental text.' }],
    });
    const claimed = await service.claimBatch({
      ownerId: 'owner-completed-graph',
      conversationId: 'conversation-completed-graph',
      parentMessageId: 'parent-completed-graph',
      surface: 'web',
      insights: [{ cortexName: 'Emotional Resonance', insight: exactInsight }],
    });
    await persistAndPresent({
      service,
      ownerId: 'owner-completed-graph',
      claims: claimed.claimed,
      messageId: 'receipt-completed-graph',
      surfaces: ['web'],
    });

    const privateRow = await Delivery.findOne({
      userId: 'owner-completed-graph',
      parentMessageId: 'parent-completed-graph',
    })
      .select('+insight')
      .lean();
    const events = await service.listEvents({
      ownerId: 'owner-completed-graph',
      parentMessageId: 'parent-completed-graph',
    });

    expect(privateRow.insight).toBe('The exact completed graph insight.');
    expect(privateRow.graphResultHash).toBe(
      crypto.createHash('sha256').update('The exact completed graph insight.').digest('hex'),
    );
    expect(privateRow.persistedMessageId).toBe('receipt-completed-graph');
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        transition: 'sent',
        receiptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  test('persists one terminal owner-scoped row across replay without raw insight text', async () => {
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
      randomUUID: () => 'claim-1',
    });
    const input = {
      ownerId: 'owner-1',
      conversationId: 'conversation-1',
      parentMessageId: 'parent-1',
      surface: 'telegram',
      insights: [{ cortexName: 'Emotional Resonance', insight: 'A private completed insight.' }],
    };

    const first = await service.claimBatch(input);
    await persistAndPresent({
      service,
      ownerId: input.ownerId,
      claims: first.claimed,
      messageId: 'follow-up-1',
      surfaces: ['web', 'telegram'],
    });
    const replay = await service.claimBatch({ ...input, surface: 'web' });
    const rows = await service.listByParent({
      ownerId: input.ownerId,
      parentMessageId: input.parentMessageId,
    });
    const events = await service.listEvents({
      ownerId: input.ownerId,
      parentMessageId: input.parentMessageId,
    });

    expect(first.claimed).toHaveLength(1);
    expect(replay.claimed).toHaveLength(0);
    expect(rows).toEqual([
      expect.objectContaining({
        status: 'sent',
        persistedMessageId: 'follow-up-1',
        surface: 'telegram',
      }),
    ]);
    for (const privatePath of [
      'insightHash',
      'graphResultHash',
      'streamId',
      'batchId',
      'batchSize',
      'batchMemberHashes',
      'presentationReceiptHashes',
      'acceptanceToken',
      'deliveryKey',
      'events',
      'userId',
      'claimToken',
      'presentationLeaseToken',
    ]) {
      expect(rows[0]).not.toHaveProperty(privatePath);
    }
    expect(JSON.stringify(await Delivery.find({}).lean())).not.toContain(
      'A private completed insight.',
    );
    expect(events.map((event) => event.transition)).toEqual([
      'pending',
      'claimed',
      'persisted',
      'presented',
      'presented',
      'sent',
    ]);
    expect(events.at(-1).receiptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(events)).not.toContain('follow-up-1');
    expect(JSON.stringify(events)).not.toContain('A private completed insight.');
    expect(
      await service.listByParent({ ownerId: 'other-owner', parentMessageId: 'parent-1' }),
    ).toEqual([]);
    expect(
      await service.listEvents({ ownerId: 'other-owner', parentMessageId: 'parent-1' }),
    ).toEqual([]);
  });

  test('rejects direct rewrites or removals of immutable attempt history', async () => {
    const row = await Delivery.findOne({ userId: 'owner-1', parentMessageId: 'parent-1' }).lean();

    await expect(
      Delivery.updateOne(
        { deliveryId: row.deliveryId },
        { $set: { 'events.0.reason': 'semantic_suppression' } },
      ),
    ).rejects.toThrow('event history is append-only');
    await expect(
      Delivery.updateOne(
        { deliveryId: row.deliveryId },
        { $pull: { events: { transition: 'sent' } } },
      ),
    ).rejects.toThrow('event history is append-only');
    await expect(
      Delivery.updateOne({ deliveryId: row.deliveryId }, { $inc: { 'events.0.attemptNumber': 1 } }),
    ).rejects.toThrow('event history is append-only');
  });

  test('cannot truncate, replace, unset, pop, pull, or bulk-rewrite event count and hash history', async () => {
    const row = await Delivery.findOne({ userId: 'owner-1', parentMessageId: 'parent-1' })
      .select('+events')
      .lean();
    const originalHistory = row.events.map((event) => ({
      transition: event.transition,
      receiptHash: event.receiptHash,
    }));
    const filter = { deliveryId: row.deliveryId };

    const attacks = [
      () => Delivery.updateOne(filter, { $push: { events: { $each: [], $slice: -1 } } }),
      () => Delivery.updateOne(filter, { $set: { events: [] } }),
      () => Delivery.updateOne(filter, { $unset: { events: 1 } }),
      () => Delivery.updateOne(filter, { $pop: { events: -1 } }),
      () => Delivery.updateOne(filter, { $pull: { events: { receiptHash: { $ne: '' } } } }),
      () =>
        Delivery.bulkWrite([
          { updateOne: { filter, update: { $set: { 'events.0.receiptHash': 'b'.repeat(64) } } } },
        ]),
    ];

    for (const attack of attacks) {
      await expect(attack()).rejects.toThrow('event history is append-only');
    }

    const after = await Delivery.findOne(filter).select('+events').lean();
    expect(
      after.events.map((event) => ({
        transition: event.transition,
        receiptHash: event.receiptHash,
      })),
    ).toEqual(originalHistory);
  });

  test('rejects every model mutation path that can erase or rewrite event history or private insight payload', async () => {
    const makeRow = async (suffix) =>
      Delivery.create({
        deliveryKey: `cortex_insight:append-only-${suffix}`,
        deliveryId: `cidl_append_only_${suffix}`,
        userId: 'owner-append-only',
        conversationId: 'conversation-append-only',
        parentMessageId: `parent-append-only-${suffix}`,
        cortexId: 'review',
        insight: `Private insight ${suffix}.`,
        insightHash: crypto.createHash('sha256').update(`Private insight ${suffix}.`).digest('hex'),
        graphResultHash: crypto
          .createHash('sha256')
          .update(`Private insight ${suffix}.`)
          .digest('hex'),
        surface: 'web',
        requiredSurfaces: ['web'],
        status: 'dropped',
        dropReason: 'semantic_suppression',
        droppedAt: new Date('2026-08-22T12:00:00.000Z'),
        events: [
          {
            transition: 'dropped',
            attemptNumber: 0,
            claimGeneration: 0,
            eventAt: new Date('2026-08-22T12:00:00.000Z'),
            reason: 'semantic_suppression',
          },
        ],
        expiresAt: new Date('2026-09-22T12:00:00.000Z'),
      });
    const replacementFor = (row) => {
      const replacement = row.toObject();
      delete replacement._id;
      delete replacement.__v;
      delete replacement.createdAt;
      delete replacement.updatedAt;
      replacement.events = [];
      replacement.insight = 'Rewritten private insight.';
      return replacement;
    };
    const attacks = [
      [
        'updateOne $set events',
        (row) => Delivery.updateOne({ _id: row._id }, { $set: { events: [] } }),
      ],
      [
        'updateOne $unset insight',
        (row) => Delivery.updateOne({ _id: row._id }, { $unset: { insight: 1 } }),
      ],
      [
        'updateMany $pull events',
        (row) => Delivery.updateMany({ _id: row._id }, { $pull: { events: {} } }),
      ],
      [
        'findOneAndUpdate event element',
        (row) =>
          Delivery.findOneAndUpdate(
            { _id: row._id },
            { $set: { 'events.0.receiptHash': 'b'.repeat(64) } },
          ),
      ],
      [
        'findByIdAndUpdate insight',
        (row) => Delivery.findByIdAndUpdate(row._id, { $set: { insight: 'Changed.' } }),
      ],
      ['replaceOne', (row) => Delivery.replaceOne({ _id: row._id }, replacementFor(row))],
      [
        'findOneAndReplace',
        (row) => Delivery.findOneAndReplace({ _id: row._id }, replacementFor(row)),
      ],
      [
        'query replaceOne',
        (row) => Delivery.findOne({ _id: row._id }).replaceOne(replacementFor(row)),
      ],
      ['document updateOne', (row) => row.updateOne({ $set: { insightHash: 'c'.repeat(64) } })],
      ['document replaceOne', (row) => row.replaceOne(replacementFor(row))],
      [
        'pipeline updateOne',
        (row) => Delivery.updateOne({ _id: row._id }, [{ $set: { events: [] } }]),
      ],
      [
        'pipeline updateMany',
        (row) => Delivery.updateMany({ _id: row._id }, [{ $unset: 'insight' }]),
      ],
      [
        'pipeline findOneAndUpdate',
        (row) =>
          Delivery.findOneAndUpdate({ _id: row._id }, [
            { $set: { graphResultHash: 'd'.repeat(64) } },
          ]),
      ],
      [
        'rename events',
        (row) => Delivery.updateOne({ _id: row._id }, { $rename: { events: 'oldEvents' } }),
      ],
      [
        'push with slice',
        (row) =>
          Delivery.updateOne({ _id: row._id }, { $push: { events: { $each: [], $slice: -1 } } }),
      ],
      [
        'pullAll events',
        (row) => Delivery.updateOne({ _id: row._id }, { $pullAll: { events: [] } }),
      ],
      ['pop events', (row) => Delivery.updateOne({ _id: row._id }, { $pop: { events: -1 } })],
      [
        'setOnInsert without upsert',
        (row) => Delivery.updateOne({ _id: row._id }, { $setOnInsert: { insight: 'Changed.' } }),
      ],
      [
        'bulk updateOne',
        (row) =>
          Delivery.bulkWrite([
            { updateOne: { filter: { _id: row._id }, update: { $set: { events: [] } } } },
          ]),
      ],
      [
        'bulk updateMany',
        (row) =>
          Delivery.bulkWrite([
            { updateMany: { filter: { _id: row._id }, update: { $unset: { insight: 1 } } } },
          ]),
      ],
      [
        'bulk replaceOne',
        (row) =>
          Delivery.bulkWrite([
            { replaceOne: { filter: { _id: row._id }, replacement: replacementFor(row) } },
          ]),
      ],
      [
        'bulk deleteOne',
        (row) => Delivery.bulkWrite([{ deleteOne: { filter: { _id: row._id } } }]),
      ],
      [
        'bulk deleteMany',
        (row) => Delivery.bulkWrite([{ deleteMany: { filter: { _id: row._id } } }]),
      ],
      [
        'bulkSave event rewrite',
        async (row) => {
          row.events = [];
          return Delivery.bulkSave([row]);
        },
      ],
      ['model deleteOne', (row) => Delivery.deleteOne({ _id: row._id })],
      ['model deleteMany', (row) => Delivery.deleteMany({ _id: row._id })],
      ['findOneAndDelete', (row) => Delivery.findOneAndDelete({ _id: row._id })],
      ['findByIdAndDelete', (row) => Delivery.findByIdAndDelete(row._id)],
      ['document deleteOne', (row) => row.deleteOne()],
      [
        'document save event rewrite',
        async (row) => {
          row.events = [];
          return row.save();
        },
      ],
      [
        'document save private rewrite',
        async (row) => {
          row.insight = 'Changed.';
          return row.save();
        },
      ],
    ];

    expect(attacks.length).toBeGreaterThanOrEqual(21);
    for (const [name, attack] of attacks) {
      const row = await makeRow(name.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
      let rejection;
      try {
        await attack(row);
      } catch (error) {
        rejection = error;
      }
      const rejectionText = [
        rejection?.message,
        ...Object.values(rejection?.errors || {}).map((error) => error?.reason?.message),
      ]
        .filter(Boolean)
        .join(' ');
      expect(rejectionText || `attack resolved: ${name}`).toContain('append-only');
      const preserved = await Delivery.findById(row._id).select('+events +insight').lean();
      expect(preserved).not.toBeNull();
      expect(preserved.events).toHaveLength(1);
      expect(preserved.insight).toBe(
        `Private insight ${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.`,
      );
    }
  });

  test('keeps a one-time persistence failure pending across service restart and sends once', async () => {
    let currentTime = new Date('2026-08-22T14:00:00.000Z');
    const firstService = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => currentTime,
      randomUUID: () => 'claim-first',
    });
    const claimed = await firstService.claimBatch({
      ownerId: 'owner-lease',
      conversationId: 'conversation-lease',
      parentMessageId: 'parent-lease',
      surface: 'web',
      insights: [{ cortexName: 'Review', insight: 'The exact recovered insight.' }],
    });
    await firstService.markFailed({
      ownerId: 'owner-lease',
      claims: claimed.claimed,
      reason: 'durable_surface_persistence_failed',
    });

    currentTime = new Date('2026-08-22T14:01:00.000Z');
    const restartedService = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => currentTime,
      randomUUID: () => 'claim-restarted',
    });
    const retried = await restartedService.claimPendingByParent({
      ownerId: 'owner-lease',
      parentMessageId: 'parent-lease',
      surface: 'telegram',
    });
    expect(retried.insights).toEqual([
      expect.objectContaining({ insight: 'The exact recovered insight.' }),
    ]);
    await persistAndPresent({
      service: restartedService,
      ownerId: 'owner-lease',
      claims: retried.claimed,
      messageId: 'follow-up-recovered',
      surfaces: ['web'],
    });

    const replay = await restartedService.claimBatch({
      ownerId: 'owner-lease',
      conversationId: 'conversation-lease',
      parentMessageId: 'parent-lease',
      surface: 'web',
      insights: [{ cortexName: 'Review', insight: 'The exact recovered insight.' }],
    });
    const rows = await restartedService.listByParent({
      ownerId: 'owner-lease',
      parentMessageId: 'parent-lease',
    });
    const events = await restartedService.listEvents({
      ownerId: 'owner-lease',
      parentMessageId: 'parent-lease',
    });

    expect(rows).toEqual([
      expect.objectContaining({
        status: 'sent',
        persistedMessageId: 'follow-up-recovered',
      }),
    ]);
    expect(replay.claimed).toEqual([]);
    expect(events.map((event) => [event.transition, event.attemptNumber])).toEqual([
      ['pending', 0],
      ['claimed', 1],
      ['failure', 1],
      ['claimed', 2],
      ['persisted', 2],
      ['presented', 2],
      ['sent', 2],
    ]);
    expect(events.filter((event) => event.transition === 'sent')).toHaveLength(1);
  });

  test('fences an expired claimant from settling after a new generation wins', async () => {
    let currentTime = new Date('2026-08-22T16:00:00.000Z');
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => currentTime,
      randomUUID: jest.fn().mockReturnValueOnce('claim-old').mockReturnValueOnce('claim-new'),
    });
    const oldClaim = await service.claimBatch({
      ownerId: 'owner-race',
      conversationId: 'conversation-race',
      parentMessageId: 'parent-race',
      surface: 'web',
      leaseMs: 1000,
      insights: [{ cortexName: 'Review', insight: 'Only the live lease can settle this.' }],
    });
    currentTime = new Date('2026-08-22T16:00:02.000Z');
    const newClaim = await service.claimPendingByParent({
      ownerId: 'owner-race',
      parentMessageId: 'parent-race',
      surface: 'web',
    });

    await expect(
      service.markPersisted({
        ownerId: 'owner-race',
        claims: oldClaim.claimed,
        persistedMessageId: 'stale-receipt',
      }),
    ).rejects.toThrow('Cortex insight delivery transition conflict');
    await persistAndPresent({
      service,
      ownerId: 'owner-race',
      claims: newClaim.claimed,
      messageId: 'winning-receipt',
      surfaces: ['web'],
    });

    const rows = await service.listByParent({
      ownerId: 'owner-race',
      parentMessageId: 'parent-race',
    });
    expect(rows[0]).toEqual(
      expect.objectContaining({
        status: 'sent',
        persistedMessageId: 'winning-receipt',
        claimGeneration: 2,
      }),
    );
    const events = await service.listEvents({
      ownerId: 'owner-race',
      parentMessageId: 'parent-race',
    });
    expect(events.map((event) => event.transition)).toEqual([
      'pending',
      'claimed',
      'failure',
      'claimed',
      'persisted',
      'presented',
      'sent',
    ]);
    expect(events[2]).toEqual(
      expect.objectContaining({
        claimToken: oldClaim.claimed[0].claimToken,
        claimGeneration: 1,
        reason: 'delivery_lease_expired',
      }),
    );
    expect(events[3]).toEqual(
      expect.objectContaining({
        claimToken: newClaim.claimed[0].claimToken,
        claimGeneration: 2,
      }),
    );
  });

  test('blocks stale same-message replay before Web emit after a newer generation reclaims', async () => {
    let currentTime = new Date('2026-08-22T16:30:00.000Z');
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => currentTime,
      randomUUID: jest.fn().mockReturnValueOnce('claim-old').mockReturnValueOnce('claim-new'),
    });
    const oldBatch = await service.claimBatch({
      ownerId: 'owner-same-message-race',
      conversationId: 'conversation-same-message-race',
      parentMessageId: 'parent-same-message-race',
      surface: 'web',
      insights: [{ cortexName: 'Review', insight: 'The same durable result survives retry.' }],
    });
    await service.markPersisted({
      ownerId: 'owner-same-message-race',
      claims: oldBatch.claimed,
      persistedMessageId: 'same-message',
      messageRevision: 1,
    });
    await service.markFailed({
      ownerId: 'owner-same-message-race',
      claims: oldBatch.claimed,
      reason: 'presentation_failed',
    });
    currentTime = new Date('2026-08-22T16:30:01.000Z');
    const currentBatch = await service.claimPendingByParent({
      ownerId: 'owner-same-message-race',
      parentMessageId: 'parent-same-message-race',
      surface: 'web',
    });
    const emitWebPresentation = jest.fn();

    await expect(
      (async () => {
        await service.markPersisted({
          ownerId: 'owner-same-message-race',
          claims: oldBatch.claimed,
          persistedMessageId: 'same-message',
          messageRevision: 1,
        });
        await emitWebPresentation();
      })(),
    ).rejects.toMatchObject({ code: 'cortex_insight_delivery_settlement_conflict' });

    expect(currentBatch.claimed).toEqual([
      expect.objectContaining({ claimGeneration: 2, persistedMessageId: 'same-message' }),
    ]);
    expect(emitWebPresentation).not.toHaveBeenCalled();
    await service.markPersisted({
      ownerId: 'owner-same-message-race',
      claims: currentBatch.claimed,
      persistedMessageId: 'same-message',
      messageRevision: 1,
    });
    const presentationFence = await service.fencePresentation({
      ownerId: 'owner-same-message-race',
      claims: currentBatch.claimed,
      surface: 'web',
      persistedMessageId: 'same-message',
      messageRevision: 1,
    });
    await service.markPresented({
      ownerId: 'owner-same-message-race',
      claims: presentationFence.claims,
      surface: 'web',
      persistedMessageId: 'same-message',
      messageRevision: 1,
      presentationGeneration: presentationFence.generation,
      presentationClaimToken: presentationFence.claimToken,
      presentationLeaseToken: presentationFence.presentationLeaseToken,
      presentationRef: 'sse:stream-a:same-message:1',
    });
  });

  test('allows only a typed nonretryable terminal drop', async () => {
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => new Date('2026-08-22T18:00:00.000Z'),
      randomUUID: () => 'claim-drop',
    });
    const claimed = await service.claimBatch({
      ownerId: 'owner-drop',
      conversationId: 'conversation-drop',
      parentMessageId: 'parent-drop',
      surface: 'web',
      insights: [{ cortexName: 'Review', insight: 'A redundant insight.' }],
    });

    await expect(
      service.markDropped({
        ownerId: 'owner-drop',
        claims: claimed.claimed,
        dropReason: 'durable_surface_persistence_failed',
      }),
    ).rejects.toThrow('not a terminal nonretryable reason');
    await service.markDropped({
      ownerId: 'owner-drop',
      claims: claimed.claimed,
      dropReason: 'semantic_suppression',
    });

    const rows = await service.listByParent({
      ownerId: 'owner-drop',
      parentMessageId: 'parent-drop',
    });
    expect(rows[0]).toEqual(
      expect.objectContaining({ status: 'dropped', dropReason: 'semantic_suppression' }),
    );
  });

  test('terminally quarantines an expired transport-authorized claim without allowing broad expired drops', async () => {
    let currentTime = new Date('2026-08-22T18:30:00.000Z');
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => currentTime,
      randomUUID: jest
        .fn()
        .mockReturnValueOnce('unknown-claim')
        .mockReturnValueOnce('unknown-presentation'),
    });
    const claimed = await service.claimBatch({
      ownerId: 'owner-delivery-unknown',
      conversationId: 'conversation-delivery-unknown',
      parentMessageId: 'parent-delivery-unknown',
      surface: 'telegram',
      insights: [{ cortexName: 'Review', insight: 'One authorized Telegram result.' }],
      leaseMs: 10_000,
    });
    await service.markPersisted({
      ownerId: 'owner-delivery-unknown',
      claims: claimed.claimed,
      persistedMessageId: 'followup-delivery-unknown',
    });
    await service.fencePresentation({
      ownerId: 'owner-delivery-unknown',
      claims: claimed.claimed,
      surface: 'telegram',
      parentMessageId: 'parent-delivery-unknown',
      persistedMessageId: 'followup-delivery-unknown',
      leaseMs: 10_000,
    });
    currentTime = new Date('2026-08-22T18:31:00.000Z');

    await expect(
      service.markDropped({
        ownerId: 'owner-delivery-unknown',
        claims: claimed.claimed,
        dropReason: 'semantic_suppression',
        allowExpiredLease: true,
      }),
    ).rejects.toThrow('expired claim');
    await expect(
      service.markDropped({
        ownerId: 'owner-delivery-unknown',
        claims: claimed.claimed,
        dropReason: 'delivery_outcome_unknown',
        allowExpiredLease: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ status: 'dropped', dropReason: 'delivery_outcome_unknown' }),
    ]);
  });

  test('commits only one complete sibling batch under concurrent transaction conflict', async () => {
    const serviceA = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => new Date('2026-08-22T19:00:00.000Z'),
      randomUUID: () => 'transaction-a',
    });
    const serviceB = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => new Date('2026-08-22T19:00:00.000Z'),
      randomUUID: () => 'transaction-b',
    });
    const claimed = await serviceA.claimBatch({
      ownerId: 'owner-transaction-race',
      conversationId: 'conversation-transaction-race',
      parentMessageId: 'parent-transaction-race',
      surface: 'web',
      insights: [
        { cortexName: 'Review A', insight: 'First transaction result.' },
        { cortexName: 'Review B', insight: 'Second transaction result.' },
      ],
    });

    const results = await Promise.allSettled(
      [serviceA, serviceB].map((service, index) =>
        service.markPersisted({
          ownerId: 'owner-transaction-race',
          claims: claimed.claimed,
          persistedMessageId: `transaction-message-${index + 1}`,
        }),
      ),
    );
    const rows = await serviceA.listByParent({
      ownerId: 'owner-transaction-race',
      parentMessageId: 'parent-transaction-race',
    });

    expect(claimed.claimed).toHaveLength(2);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(new Set(rows.map((row) => row.persistedMessageId)).size).toBe(1);
    expect(rows.every((row) => row.persistenceStatus === 'persisted')).toBe(true);
  });

  test('drops an unsupported surface once and excludes it from restart replay', async () => {
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => new Date('2026-08-22T19:30:00.000Z'),
      randomUUID: () => 'unsupported-surface',
    });
    await service.recordBatch({
      ownerId: 'owner-unsupported-surface',
      conversationId: 'conversation-unsupported-surface',
      parentMessageId: 'parent-unsupported-surface',
      surface: 'voice',
      insights: [{ cortexName: 'Review', insight: 'This surface has no delivery adapter.' }],
    });
    const createMessage = jest.fn();

    const first = await recoverPending({
      deliveryService: service,
      createMessage,
    });
    const replay = await recoverPending({
      deliveryService: service,
      createMessage,
    });
    const rows = await service.listByParent({
      ownerId: 'owner-unsupported-surface',
      parentMessageId: 'parent-unsupported-surface',
    });

    expect(first).toEqual(expect.objectContaining({ dropped: 1, pending: 0 }));
    expect(replay).toEqual(expect.objectContaining({ scanned: 0, dropped: 0, pending: 0 }));
    expect(rows).toEqual([
      expect.objectContaining({ status: 'dropped', dropReason: 'unsupported_surface' }),
    ]);
    expect(createMessage).not.toHaveBeenCalled();
  });

  test('drops a repeatedly failing supported surface at the retry bound and never replays it', async () => {
    let currentTime = new Date('2026-08-22T19:40:00.000Z');
    const createService = (attempt) =>
      createCortexInsightDeliveryService({
        DeliveryModel: Delivery,
        now: () => currentTime,
        randomUUID: () => `exhausted-${attempt}`,
      });
    const initialService = createService(0);
    await initialService.recordBatch({
      ownerId: 'owner-exhausted-surface',
      conversationId: 'conversation-exhausted-surface',
      parentMessageId: 'parent-exhausted-surface',
      surface: 'web',
      insights: [{ cortexName: 'Review', insight: 'This delivery always fails.' }],
    });
    const createMessage = jest.fn().mockRejectedValue(new Error('persistence unavailable'));

    const attempts = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      currentTime = new Date(currentTime.getTime() + 60_000);
      attempts.push(
        await recoverPending({
          deliveryService: createService(attempt),
          createMessage,
        }),
      );
    }
    const replay = await recoverPending({
      deliveryService: createService(4),
      createMessage,
    });
    const rows = await initialService.listByParent({
      ownerId: 'owner-exhausted-surface',
      parentMessageId: 'parent-exhausted-surface',
    });

    expect(attempts.map((attempt) => [attempt.pending, attempt.dropped])).toEqual([
      [1, 0],
      [1, 0],
      [0, 1],
    ]);
    expect(replay).toEqual(expect.objectContaining({ scanned: 0, dropped: 0, pending: 0 }));
    expect(rows).toEqual([
      expect.objectContaining({
        status: 'dropped',
        attemptNumber: 3,
        dropReason: 'delivery_attempts_exhausted',
      }),
    ]);
    expect(createMessage).toHaveBeenCalledTimes(3);
  });

  test('reacquires the current attempt-three fence after the real creator already marks it pending', async () => {
    let currentTime = new Date('2026-08-22T19:50:00.000Z');
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => currentTime,
      randomUUID: jest
        .fn()
        .mockReturnValueOnce('creator-failure-1')
        .mockReturnValueOnce('creator-failure-2')
        .mockReturnValueOnce('creator-failure-3')
        .mockReturnValueOnce('creator-terminal-fence'),
    });
    await service.recordBatch({
      ownerId: 'owner-creator-failure',
      conversationId: 'conversation-creator-failure',
      parentMessageId: 'parent-creator-failure',
      surface: 'web',
      insights: [{ cortexName: 'Review', insight: 'Persistence fails at the real creator.' }],
    });
    const createMessage = jest.fn(async ({ deliveryBatch }) => {
      await service.markFailed({
        ownerId: 'owner-creator-failure',
        claims: deliveryBatch.claimed,
        reason: 'durable_surface_persistence_failed',
      });
      throw new Error('synthetic creator persistence failure');
    });

    const attempts = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      currentTime = new Date(currentTime.getTime() + 60_000);
      attempts.push(await recoverPending({ deliveryService: service, createMessage }));
    }
    const rows = await service.listByParent({
      ownerId: 'owner-creator-failure',
      parentMessageId: 'parent-creator-failure',
    });

    expect(attempts.map(({ pending, dropped }) => [pending, dropped])).toEqual([
      [1, 0],
      [1, 0],
      [0, 1],
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        status: 'dropped',
        attemptNumber: 3,
        claimGeneration: 4,
        dropReason: 'delivery_attempts_exhausted',
      }),
    ]);
  });

  test('production recovery survives process restart and presents one message exactly once per surface', async () => {
    let currentTime = new Date('2026-08-22T20:00:00.000Z');
    const firstProcessService = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => currentTime,
      randomUUID: () => 'restart-first-claim',
    });
    await persistCompletedCortexGraphInsight(
      {
        req: {
          user: { id: 'owner-process-restart' },
          body: { streamId: 'stream-process-restart', viventiumLogicalTurnRevision: 4 },
        },
        conversationId: 'conversation-process-restart',
        parentMessageId: 'parent-process-restart',
        agent: { id: 'emotional-resonance', name: 'Emotional Resonance' },
        surface: 'telegram',
        insight: 'The exact process-restart insight.',
      },
      {
        recordBatch: firstProcessService.recordBatch,
        enqueueOutbox: outboxService.enqueueBatch,
        settleOutbox: outboxService.settleBatch,
      },
    );

    const createMessage = jest
      .fn()
      .mockRejectedValueOnce(new Error('one-time persistence failure'))
      .mockResolvedValue({
        messageId: 'cortex-follow-up-stable',
        revision: 4,
        text: 'The exact process-restart insight.',
      });
    const presentSurface = jest.fn(
      async ({ surface, message, recoveryContext, presentationFence }) => ({
        surface,
        messageId: message.messageId,
        revision: message.revision,
        presentationGeneration: recoveryContext.claimGeneration,
        presentationClaimToken: presentationFence.claimToken,
        presentationLeaseToken: presentationFence.presentationLeaseToken,
        presentationRef:
          surface === 'web' ? 'sse:stream-process-restart:1' : 'telegram:synthetic-chat:501',
      }),
    );

    await recoverPending({
      deliveryService: firstProcessService,
      createMessage,
      presentSurface,
    });

    currentTime = new Date('2026-08-22T20:01:00.000Z');
    await restoreRecoveryStream({
      streamId: 'stream-process-restart',
      ownerId: 'owner-process-restart',
      conversationId: 'conversation-process-restart',
      parentMessageId: 'parent-process-restart',
    });
    const restartedProcessService = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => currentTime,
      randomUUID: () => 'restart-second-claim',
    });
    await recoverPending({
      deliveryService: restartedProcessService,
      createMessage,
      presentSurface,
    });
    await recoverPending({
      deliveryService: restartedProcessService,
      createMessage,
      presentSurface,
    });

    const rows = await restartedProcessService.listByParent({
      ownerId: 'owner-process-restart',
      parentMessageId: 'parent-process-restart',
    });
    const events = await restartedProcessService.listEvents({
      ownerId: 'owner-process-restart',
      parentMessageId: 'parent-process-restart',
    });

    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(createMessage.mock.calls[1][0].insights).toEqual([
      expect.objectContaining({ insight: 'The exact process-restart insight.' }),
    ]);
    expect(presentSurface.mock.calls.map(([call]) => call.surface)).toEqual(['web', 'telegram']);
    expect(presentSurface.mock.calls.map(([call]) => call.streamPresentationBinding)).toEqual([
      expect.objectContaining({
        ownerId: 'owner-process-restart',
        generation: 2,
        deliveryReceipts: [
          expect.objectContaining({ graphResultHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        ],
      }),
      expect.objectContaining({
        ownerId: 'owner-process-restart',
        generation: 2,
        deliveryReceipts: [
          expect.objectContaining({ graphResultHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        ],
      }),
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        status: 'sent',
        persistenceStatus: 'persisted',
        persistedMessageId: 'cortex-follow-up-stable',
        presentedSurfaces: ['web', 'telegram'],
      }),
    ]);
    expect(events.map((event) => event.transition)).toEqual([
      'pending',
      'claimed',
      'failure',
      'claimed',
      'persisted',
      'presented',
      'presented',
      'sent',
    ]);
    expect(events.filter((event) => event.transition === 'sent')).toHaveLength(1);
    expect(events.filter((event) => event.transition === 'presented')).toHaveLength(2);
    expect(
      events
        .filter((event) => event.receiptHash)
        .every((event) => /^[a-f0-9]{64}$/.test(event.receiptHash)),
    ).toBe(true);
  });

  test('retries one failed surface without duplicating the surface that already presented', async () => {
    let currentTime = new Date('2026-08-22T21:00:00.000Z');
    const firstService = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => currentTime,
      randomUUID: () => 'surface-first-claim',
    });
    await persistCompletedCortexGraphInsight(
      {
        req: {
          user: { id: 'owner-surface-retry' },
          body: { streamId: 'stream-surface-retry', viventiumLogicalTurnRevision: 6 },
        },
        conversationId: 'conversation-surface-retry',
        parentMessageId: 'parent-surface-retry',
        agent: { id: 'review', name: 'Review' },
        surface: 'telegram',
        insight: 'Present this once on each linked surface.',
      },
      {
        recordBatch: firstService.recordBatch,
        enqueueOutbox: outboxService.enqueueBatch,
        settleOutbox: outboxService.settleBatch,
      },
    );
    const stableMessage = {
      messageId: 'cortex-follow-up-surface-stable',
      revision: 6,
      text: 'Present this once on each linked surface.',
    };
    const createMessage = jest.fn().mockResolvedValue(stableMessage);
    const loadMessage = jest.fn().mockResolvedValue(stableMessage);
    const presentationCalls = [];
    let telegramFailed = false;
    const presentSurface = jest.fn(
      async ({ surface, message, recoveryContext, presentationFence }) => {
        presentationCalls.push(surface);
        if (surface === 'telegram' && !telegramFailed) {
          telegramFailed = true;
          throw new Error('one-time Telegram presentation failure');
        }
        return {
          surface,
          messageId: message.messageId,
          revision: message.revision,
          presentationGeneration: recoveryContext.claimGeneration,
          presentationClaimToken: presentationFence.claimToken,
          presentationLeaseToken: presentationFence.presentationLeaseToken,
          presentationRef:
            surface === 'web' ? 'sse:stream-surface-retry:1' : 'telegram:synthetic-chat:601',
        };
      },
    );

    await restoreRecoveryStream({
      streamId: 'stream-surface-retry',
      ownerId: 'owner-surface-retry',
      conversationId: 'conversation-surface-retry',
      parentMessageId: 'parent-surface-retry',
    });
    await recoverPending({
      deliveryService: firstService,
      createMessage,
      loadMessage,
      presentSurface,
    });

    currentTime = new Date('2026-08-22T21:01:00.000Z');
    await restoreRecoveryStream({
      streamId: 'stream-surface-retry',
      ownerId: 'owner-surface-retry',
      conversationId: 'conversation-surface-retry',
      parentMessageId: 'parent-surface-retry',
    });
    const restartedService = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      now: () => currentTime,
      randomUUID: () => 'surface-second-claim',
    });
    await recoverPending({
      deliveryService: restartedService,
      createMessage,
      loadMessage,
      presentSurface,
    });

    const rows = await restartedService.listByParent({
      ownerId: 'owner-surface-retry',
      parentMessageId: 'parent-surface-retry',
    });
    const events = await restartedService.listEvents({
      ownerId: 'owner-surface-retry',
      parentMessageId: 'parent-surface-retry',
    });

    expect(presentationCalls).toEqual(['web', 'telegram', 'telegram']);
    expect(
      presentSurface.mock.calls.map(([call]) => call.streamPresentationBinding.generation),
    ).toEqual([1, 1, 2]);
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(loadMessage).toHaveBeenCalledTimes(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        status: 'sent',
        presentedSurfaces: ['web', 'telegram'],
        persistedMessageId: stableMessage.messageId,
      }),
    );
    expect(events.map((event) => event.transition)).toEqual([
      'pending',
      'claimed',
      'persisted',
      'presented',
      'failure',
      'claimed',
      'presented',
      'sent',
    ]);
  });
});
