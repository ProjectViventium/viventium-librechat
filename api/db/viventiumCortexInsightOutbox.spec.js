/* === VIVENTIUM START ===
 * Feature: Durable completed-cortex outbox recovery tests.
 * === VIVENTIUM END === */

const mongoose = require('mongoose');
const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { MongoMemoryServer } = require('mongodb-memory-server');
const createViventiumCortexInsightDelivery = require('./viventiumCortexInsightDelivery');
const createViventiumCortexInsightOutbox = require('./viventiumCortexInsightOutbox');
const {
  buildCortexInsightDeliveryCandidates,
  createCortexInsightDeliveryService,
} = require('../server/services/viventium/CortexInsightDeliveryService');
const {
  createCortexInsightOutboxService,
} = require('../server/services/viventium/CortexInsightOutboxService');

describe('Viventium completed Cortex insight outbox', () => {
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

  afterEach(async () => {
    await Promise.all([Delivery.collection.deleteMany({}), Outbox.deleteMany({})]);
  });

  afterAll(async () => {
    await database?.disconnect();
    await mongoServer?.stop();
  });

  function exactLedgerAcceptance(batch) {
    const deliveries = buildCortexInsightDeliveryCandidates(batch);
    return {
      deliveries,
      batchId: deliveries[0]?.batchId,
      batchSize: deliveries.length,
      batchMemberHashes: deliveries[0]?.batchMemberHashes,
    };
  }

  test('does not attach a TTL index to pending completed-result outbox rows', () => {
    expect(Outbox.schema.path('expiresAt')).toBeUndefined();
    expect(Outbox.schema.path('retentionAlertAt')?.options?.index).toBe(true);
    expect(
      Outbox.schema.indexes().some(([, options]) => Number(options?.expireAfterSeconds) === 0),
    ).toBe(false);
  });

  test('defines an explicit recoverable quarantine state without a TTL', () => {
    expect(Outbox.schema.path('replayState')?.options).toEqual(
      expect.objectContaining({
        enum: ['pending', 'quarantined'],
        required: true,
        default: 'pending',
      }),
    );
    expect(Outbox.schema.path('lastFailureCode')?.options?.maxlength).toBe(120);
    expect(Outbox.schema.path('quarantinedAt')).toBeDefined();
  });

  test('uses the same strict private Feelings receipt schema as the delivery ledger', () => {
    const feelingPath = Outbox.schema.path('feelingSnapshot');

    expect(feelingPath.options.select).toBe(false);
    expect(feelingPath.schema.options.strict).toBe('throw');
    expect(feelingPath.schema.path('available').options.required).toBe(true);
    expect(feelingPath.schema.path('snapshotHash').options.match).toEqual(/^[a-f0-9]{64}$/);
    expect(feelingPath.schema.path('capsule').options.maxlength).toBe(16_000);
  });

  test.each([
    ['disabled', { available: true, enabled: false }],
    ['unavailable', { available: false, enabled: false }],
  ])('persists a strict %s Feelings receipt with an exact empty capsule', async (_name, state) => {
    const service = createCortexInsightOutboxService({ OutboxModel: Outbox });
    await service.enqueueBatch({
      ownerId: `owner-${_name}-empty-capsule`,
      conversationId: `conversation-${_name}-empty-capsule`,
      parentMessageId: `parent-${_name}-empty-capsule`,
      surface: 'web',
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
      insights: [{ cortexId: 'review', insight: 'Exact empty-capsule receipt.' }],
    });

    const row = await Outbox.findOne({ userId: `owner-${_name}-empty-capsule` })
      .select('+feelingSnapshot')
      .lean();
    expect(row.feelingSnapshot.capsule).toBe('');
  });

  test('uses the leading createdAt index for deterministic global replay ordering', async () => {
    const replayIndex = Outbox.schema
      .indexes()
      .find(([, options]) => options?.name === 'cortex_outbox_global_replay_created_at');
    expect(replayIndex?.[0]).toEqual({ createdAt: 1, _id: 1 });

    const plan = await Outbox.collection
      .find({})
      .sort({ createdAt: 1, _id: 1 })
      .hint('cortex_outbox_global_replay_created_at')
      .explain('queryPlanner');
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain(
      'cortex_outbox_global_replay_created_at',
    );

    const dueReplayIndex = Outbox.schema
      .indexes()
      .find(([, options]) => options?.name === 'cortex_outbox_replay_due');
    expect(dueReplayIndex?.[0]).toEqual({ nextAttemptAt: 1, createdAt: 1, _id: 1 });

    const duePlan = await Outbox.collection
      .find({ nextAttemptAt: { $lte: new Date('2099-01-01T00:00:00.000Z') } })
      .sort({ nextAttemptAt: 1, createdAt: 1, _id: 1 })
      .hint('cortex_outbox_replay_due')
      .explain('queryPlanner');
    expect(JSON.stringify(duePlan.queryPlanner.winningPlan)).toContain('cortex_outbox_replay_due');
  });

  test('persists the exact completed Unicode string and its original hash', async () => {
    const insight = '\u00a0{"summary":"Compatibility ① Å ﬁ.","facts":[1,2]}\u3000';
    const service = createCortexInsightOutboxService({ OutboxModel: Outbox });

    await service.enqueueBatch({
      ownerId: 'owner-unicode',
      conversationId: 'conversation-unicode',
      parentMessageId: 'parent-unicode',
      surface: 'web',
      insights: [{ cortexId: 'emotional-resonance', insight, status: 'completed' }],
    });

    const row = await Outbox.findOne({ userId: 'owner-unicode' }).select('+insight').lean();
    expect(row.insight).toBe(insight);
    expect(row.insightHash).toBe(crypto.createHash('sha256').update(insight).digest('hex'));
    expect(row.insightHash).not.toBe(
      crypto.createHash('sha256').update(insight.normalize('NFKC')).digest('hex'),
    );
  });

  test('keeps an overdue pending outbox row and emits the typed retention alert', async () => {
    const currentTime = new Date('2026-09-23T12:00:00.000Z');
    const service = createCortexInsightOutboxService({
      OutboxModel: Outbox,
      now: () => currentTime,
    });
    await Outbox.create({
      outboxKey: 'outbox-overdue',
      userId: 'owner-overdue',
      conversationId: 'conversation-overdue',
      parentMessageId: 'parent-overdue',
      cortexId: 'review',
      cortexName: 'Review',
      insight: 'This completed result must remain durable.',
      insightHash: crypto
        .createHash('sha256')
        .update('This completed result must remain durable.')
        .digest('hex'),
      surface: 'web',
      streamId: 'stream-overdue',
      messageRevision: 1,
      retentionAlertAt: new Date('2026-09-22T12:00:00.000Z'),
    });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      await expect(
        service.replayPending({
          recordBatch: jest.fn().mockRejectedValue(new Error('ledger unavailable')),
        }),
      ).resolves.toEqual({ scanned: 1, replayed: 0, pending: 1 });
      expect(warn).toHaveBeenCalledWith(
        '[VIVENTIUM][cortex-insight-outbox] Pending retention threshold reached',
        { code: 'cortex_insight_outbox_retention_alert' },
      );
      expect(await Outbox.countDocuments({ outboxKey: 'outbox-overdue' })).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  test('quarantines a malformed legacy Feelings parent without blocking a later valid parent', async () => {
    const replayClock = new Date('2026-08-23T11:00:00.000Z');
    const makeLegacyRow = ({ suffix, parentMessageId, insight, feelingSnapshot, createdAt }) => {
      const insightHash = crypto.createHash('sha256').update(insight).digest('hex');
      return {
        outboxKey: `cortex_insight:legacy-feelings-${suffix}`,
        userId: 'owner-legacy-feelings-isolation',
        conversationId: `conversation-legacy-feelings-${suffix}`,
        parentMessageId,
        cortexId: 'review',
        cortexName: 'Review',
        insight,
        insightHash,
        graphResultHash: insightHash,
        surface: 'web',
        streamId: `stream-legacy-feelings-${suffix}`,
        messageRevision: 1,
        feelingSnapshot,
        nextAttemptAt: createdAt,
        replayAttempts: 0,
        retentionAlertAt: new Date('2026-09-23T11:00:00.000Z'),
        createdAt,
        updatedAt: createdAt,
      };
    };
    await Outbox.collection.insertMany([
      makeLegacyRow({
        suffix: 'malformed',
        parentMessageId: 'parent-legacy-feelings-malformed',
        insight: 'Malformed Feelings row remains recoverable.',
        feelingSnapshot: { available: true, enabled: true },
        createdAt: new Date('2026-08-23T10:58:00.000Z'),
      }),
      makeLegacyRow({
        suffix: 'valid',
        parentMessageId: 'parent-legacy-feelings-valid',
        insight: 'Later valid row still replays.',
        feelingSnapshot: null,
        createdAt: new Date('2026-08-23T10:59:00.000Z'),
      }),
    ]);
    const recordBatch = jest.fn(async (batch) => {
      const deliveries =
        require('../server/services/viventium/CortexInsightDeliveryService').buildCortexInsightDeliveryCandidates(
          batch,
        );
      return { deliveries };
    });
    const service = createCortexInsightOutboxService({
      OutboxModel: Outbox,
      now: () => replayClock,
    });

    await expect(service.replayPending({ limit: 2, recordBatch })).resolves.toEqual({
      scanned: 2,
      replayed: 1,
      pending: 0,
      quarantined: 1,
    });
    expect(recordBatch).toHaveBeenCalledTimes(1);
    expect(recordBatch.mock.calls[0][0].parentMessageId).toBe('parent-legacy-feelings-valid');
    expect(await Outbox.countDocuments({ parentMessageId: 'parent-legacy-feelings-valid' })).toBe(
      0,
    );
    const malformed = await Outbox.findOne({
      parentMessageId: 'parent-legacy-feelings-malformed',
    }).lean();
    expect(malformed).toEqual(
      expect.objectContaining({
        replayState: 'quarantined',
        replayAttempts: 1,
        lastFailureCode: 'cortex_feeling_snapshot_invalid',
        quarantinedAt: replayClock,
      }),
    );
  });

  test('replays the exact completed result after the first ledger write fails and the service restarts', async () => {
    let replayClock = new Date('2026-08-23T12:00:00.000Z');
    const now = () => replayClock;
    const initialOutbox = createCortexInsightOutboxService({ OutboxModel: Outbox, now });
    const input = {
      ownerId: 'owner-outbox',
      conversationId: 'conversation-outbox',
      parentMessageId: 'parent-outbox',
      surface: 'telegram',
      streamId: 'stream-outbox',
      messageRevision: 3,
      insights: [
        {
          cortexId: 'emotional-resonance',
          cortexName: 'Emotional Resonance',
          insight: 'The exact completed result survives restart.',
          status: 'completed',
        },
      ],
    };
    await initialOutbox.enqueueBatch(input);

    const firstRecovery = await initialOutbox.replayPending({
      recordBatch: jest.fn().mockRejectedValue(new Error('first ledger write failed')),
    });
    expect(firstRecovery).toEqual({ scanned: 1, replayed: 0, pending: 1 });
    expect(await Outbox.countDocuments({})).toBe(1);
    replayClock = new Date(replayClock.getTime() + 1_000);

    const restartedDelivery = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      runtimeSlot: 'api-slot-a',
      runtimeEpoch: 'boot-restarted',
    });
    const restartedOutbox = createCortexInsightOutboxService({ OutboxModel: Outbox, now });
    const restartRecovery = await restartedOutbox.replayPending({
      recordBatch: (batch) => restartedDelivery.recordBatch(batch),
    });

    expect(restartRecovery).toEqual({ scanned: 1, replayed: 1, pending: 0 });
    expect(await Outbox.countDocuments({})).toBe(0);
    const rows = await restartedDelivery.listByParent({
      ownerId: 'owner-outbox',
      parentMessageId: 'parent-outbox',
    });
    expect(rows).toEqual([
      expect.objectContaining({
        status: 'pending',
        surface: 'telegram',
        messageRevision: 3,
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain('The exact completed result survives restart.');
  });

  test('replays one exact sibling batch after a standalone ledger process interruption', async () => {
    let replayClock = new Date('2026-08-23T13:00:00.000Z');
    const now = () => replayClock;
    const input = {
      ownerId: 'owner-atomic-replay',
      conversationId: 'conversation-atomic-replay',
      parentMessageId: 'parent-atomic-replay',
      surface: 'web',
      streamId: 'stream-atomic-replay',
      messageRevision: 7,
      insights: [
        { cortexId: 'review-a', insight: 'Exact atomic replay sibling A.' },
        { cortexId: 'review-b', insight: 'Exact atomic replay sibling B.' },
      ],
    };
    const outbox = createCortexInsightOutboxService({ OutboxModel: Outbox, now });
    const expected = await outbox.enqueueBatch(input);

    const durableRows = await Outbox.find({ userId: input.ownerId })
      .select('+batchEntries +batchMemberHashes')
      .lean();
    expect(durableRows).toHaveLength(1);
    expect(durableRows[0]).toEqual(
      expect.objectContaining({
        batchId: expect.stringMatching(/^cib_[a-f0-9]{64}$/),
        batchSize: 2,
        batchMemberHashes: expect.arrayContaining([
          expect.stringMatching(/^[a-f0-9]{64}$/),
          expect.stringMatching(/^[a-f0-9]{64}$/),
        ]),
        batchEntries: expect.any(Array),
      }),
    );
    expect(durableRows[0].batchEntries).toHaveLength(2);
    expect(expected.outboxKeys).toHaveLength(2);

    const interruptedDelivery = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      runtimeSlot: 'atomic-replay-slot',
      runtimeEpoch: 'atomic-replay-boot-1',
      afterStandaloneRecordWrite: async ({ mutationIndex }) => {
        if (mutationIndex === 0) {
          throw Object.assign(new Error('synthetic process interruption'), {
            code: 'synthetic_process_interruption',
          });
        }
      },
    });
    await expect(
      outbox.replayPending({ recordBatch: (batch) => interruptedDelivery.recordBatch(batch) }),
    ).resolves.toEqual({ scanned: 1, replayed: 0, pending: 1 });
    expect(await Outbox.countDocuments({ userId: input.ownerId })).toBe(1);
    expect(await Delivery.countDocuments({ userId: input.ownerId })).toBe(1);

    replayClock = new Date(replayClock.getTime() + 1_000);
    const restartedOutbox = createCortexInsightOutboxService({ OutboxModel: Outbox, now });
    const restartedDelivery = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      runtimeSlot: 'atomic-replay-slot',
      runtimeEpoch: 'atomic-replay-boot-2',
    });
    await expect(
      restartedOutbox.replayPending({
        recordBatch: (batch) => restartedDelivery.recordBatch(batch),
      }),
    ).resolves.toEqual({ scanned: 1, replayed: 1, pending: 0 });
    expect(await Outbox.countDocuments({ userId: input.ownerId })).toBe(0);
    expect(await Delivery.find({ userId: input.ownerId }).sort({ cortexId: 1 }).lean()).toEqual([
      expect.objectContaining({ cortexId: 'review-a', sourceRevision: 7 }),
      expect.objectContaining({ cortexId: 'review-b', sourceRevision: 7 }),
    ]);
  });

  test('quarantines a sibling batch whose persisted payload no longer matches its member hashes', async () => {
    const service = createCortexInsightOutboxService({ OutboxModel: Outbox });
    await service.enqueueBatch({
      ownerId: 'owner-batch-membership',
      conversationId: 'conversation-batch-membership',
      parentMessageId: 'parent-batch-membership',
      surface: 'web',
      insights: [
        { cortexId: 'review-a', insight: 'Persisted batch member A.' },
        { cortexId: 'review-b', insight: 'Persisted batch member B.' },
      ],
    });
    const row = await Outbox.findOne({ userId: 'owner-batch-membership' }).lean();
    await Outbox.collection.updateOne(
      { _id: row._id },
      { $set: { 'batchEntries.1.insight': 'Tampered persisted batch member.' } },
    );
    const recordBatch = jest.fn();

    await expect(service.replayPending({ recordBatch })).resolves.toEqual({
      scanned: 1,
      replayed: 0,
      pending: 0,
      quarantined: 1,
    });
    expect(recordBatch).not.toHaveBeenCalled();
    expect(await Outbox.countDocuments({ userId: 'owner-batch-membership' })).toBe(1);
    expect(await Outbox.findOne({ userId: 'owner-batch-membership' }).lean()).toEqual(
      expect.objectContaining({
        replayState: 'quarantined',
        lastFailureCode: 'cortex_insight_delivery_envelope_conflict',
      }),
    );
  });

  test('quarantines an embedded singleton when its parent already has a terminal sibling', async () => {
    const replayClock = new Date('2026-09-01T00:00:00.000Z');
    const ownerId = 'owner-terminal-parent-conflict';
    const parentMessageId = 'parent-terminal-parent-conflict';
    const delivery = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      runtimeSlot: 'terminal-parent-conflict-slot',
      runtimeEpoch: 'terminal-parent-conflict-boot',
    });
    const first = await delivery.claimBatch({
      ownerId,
      conversationId: 'conversation-terminal-parent-conflict',
      parentMessageId,
      surface: 'web',
      streamId: 'stream-terminal-parent-conflict',
      insights: [{ cortexId: 'review-a', insight: 'Accepted terminal sibling.' }],
    });
    await delivery.markDropped({
      ownerId,
      claims: first.claimed,
      dropReason: 'semantic_suppression',
    });
    const outbox = createCortexInsightOutboxService({
      OutboxModel: Outbox,
      now: () => replayClock,
    });
    await outbox.enqueueBatch({
      ownerId,
      conversationId: 'conversation-terminal-parent-conflict',
      parentMessageId,
      surface: 'web',
      streamId: 'stream-terminal-parent-conflict',
      insights: [{ cortexId: 'review-b', insight: 'Conflicting durable sibling.' }],
    });

    await expect(
      outbox.replayPending({ recordBatch: (batch) => delivery.recordBatch(batch) }),
    ).resolves.toEqual({
      scanned: 1,
      replayed: 0,
      pending: 0,
      quarantined: 1,
    });
    expect(await Outbox.countDocuments({ userId: ownerId })).toBe(1);
    expect(await Outbox.findOne({ userId: ownerId }).lean()).toEqual(
      expect.objectContaining({
        replayState: 'quarantined',
        lastFailureCode: 'cortex_insight_delivery_batch_mixed_envelope',
        quarantinedAt: replayClock,
      }),
    );
    expect(await Delivery.countDocuments({ userId: ownerId, parentMessageId })).toBe(1);
  });

  test('replays a persisted legacy singleton with no batch or source revision fields', async () => {
    const insight = 'Persisted legacy singleton result.';
    const insightHash = crypto.createHash('sha256').update(insight).digest('hex');
    await Outbox.collection.insertOne({
      outboxKey: 'cortex_insight:legacy-singleton',
      userId: 'owner-legacy-outbox',
      conversationId: 'conversation-legacy-outbox',
      parentMessageId: 'parent-legacy-outbox',
      cortexId: 'review',
      cortexName: 'Review',
      insight,
      insightHash,
      graphResultHash: insightHash,
      surface: 'web',
      streamId: 'stream-legacy-outbox',
      messageRevision: 6,
      nextAttemptAt: new Date('2026-08-22T12:00:00.000Z'),
      replayAttempts: 0,
      retentionAlertAt: new Date('2026-09-22T12:00:00.000Z'),
      createdAt: new Date('2026-08-22T12:00:00.000Z'),
      updatedAt: new Date('2026-08-22T12:00:00.000Z'),
    });
    const service = createCortexInsightOutboxService({ OutboxModel: Outbox });
    const recordBatch = jest.fn(async (batch) => {
      const deliveries =
        require('../server/services/viventium/CortexInsightDeliveryService').buildCortexInsightDeliveryCandidates(
          batch,
        );
      return {
        deliveries,
        batchId: deliveries[0].batchId,
        batchSize: deliveries.length,
        batchMemberHashes: deliveries[0].batchMemberHashes,
      };
    });

    await expect(service.replayPending({ recordBatch })).resolves.toEqual({
      scanned: 1,
      replayed: 1,
      pending: 0,
    });
    expect(recordBatch.mock.calls[0][0].messageRevision).toBe(6);
    expect(await Outbox.countDocuments({ userId: 'owner-legacy-outbox' })).toBe(0);
  });

  test('keeps an incomplete declared transition batch intact and retryable', async () => {
    const replayClock = new Date('2026-08-24T12:00:00.000Z');
    const ownerId = 'owner-partial-declared-transition';
    const service = createCortexInsightOutboxService({
      OutboxModel: Outbox,
      now: () => replayClock,
    });
    await service.enqueueBatch({
      ownerId,
      conversationId: 'conversation-partial-declared-transition',
      parentMessageId: 'parent-partial-declared-transition',
      surface: 'web',
      streamId: 'stream-partial-declared-transition',
      messageRevision: 4,
      insights: [
        { cortexId: 'review-a', insight: 'Declared transition member A.' },
        { cortexId: 'review-b', insight: 'Declared transition member B.' },
      ],
    });
    const coordinator = await Outbox.findOne({ userId: ownerId })
      .select('+batchEntries +batchMemberHashes +batchOutboxKeys')
      .lean();
    const declaredMembership = {
      batchId: coordinator.batchId,
      batchSize: coordinator.batchSize,
      batchMemberHashes: coordinator.batchMemberHashes,
      batchOutboxKeys: coordinator.batchOutboxKeys,
    };
    const partial = {
      ...coordinator.batchEntries[0],
      ...declaredMembership,
      nextAttemptAt: replayClock,
      replayAttempts: 0,
      retentionAlertAt: new Date('2026-09-24T12:00:00.000Z'),
      createdAt: replayClock,
      updatedAt: replayClock,
    };
    await Outbox.collection.deleteMany({ userId: ownerId });
    await Outbox.collection.insertOne(partial);
    const recordBatch = jest.fn(async (batch) => exactLedgerAcceptance(batch));

    await expect(service.replayPending({ limit: 1, recordBatch })).resolves.toEqual({
      scanned: 1,
      replayed: 0,
      pending: 1,
    });
    expect(recordBatch).not.toHaveBeenCalled();
    const preserved = await Outbox.findOne({ userId: ownerId })
      .select('+batchEntries +batchMemberHashes +batchOutboxKeys')
      .lean();
    expect(preserved).toEqual(
      expect.objectContaining({
        ...declaredMembership,
        replayAttempts: 1,
        nextAttemptAt: new Date(replayClock.getTime() + 1_000),
      }),
    );
    expect(preserved.batchEntries).toBeUndefined();
  });

  test('backs off every represented member of an incomplete declared batch together', async () => {
    const replayClock = new Date('2026-08-24T12:30:00.000Z');
    const ownerId = 'owner-incomplete-declared-backoff';
    const service = createCortexInsightOutboxService({
      OutboxModel: Outbox,
      now: () => replayClock,
    });
    await service.enqueueBatch({
      ownerId,
      conversationId: 'conversation-incomplete-declared-backoff',
      parentMessageId: 'parent-incomplete-declared-backoff',
      surface: 'web',
      streamId: 'stream-incomplete-declared-backoff',
      messageRevision: 6,
      insights: [
        { cortexId: 'review-a', insight: 'Incomplete backoff member A.' },
        { cortexId: 'review-b', insight: 'Incomplete backoff member B.' },
        { cortexId: 'review-c', insight: 'Incomplete backoff member C.' },
      ],
    });
    const durableCoordinator = await Outbox.findOne({ userId: ownerId })
      .select('+batchEntries +batchMemberHashes +batchOutboxKeys')
      .lean();
    const coordinatorEntry = durableCoordinator.batchEntries.find(
      (entry) => entry.outboxKey === durableCoordinator.outboxKey,
    );
    const siblingEntry = durableCoordinator.batchEntries.find(
      (entry) => entry.outboxKey !== durableCoordinator.outboxKey,
    );
    const declaredCoordinator = {
      ...coordinatorEntry,
      batchId: durableCoordinator.batchId,
      batchSize: durableCoordinator.batchSize,
      batchMemberHashes: durableCoordinator.batchMemberHashes,
      batchOutboxKeys: durableCoordinator.batchOutboxKeys,
      nextAttemptAt: replayClock,
      replayAttempts: 0,
      retentionAlertAt: new Date('2026-09-24T12:30:00.000Z'),
      createdAt: replayClock,
      updatedAt: replayClock,
    };
    const representedSibling = {
      ...siblingEntry,
      batchId: '',
      batchSize: 1,
      batchMemberHashes: [],
      batchOutboxKeys: undefined,
      nextAttemptAt: replayClock,
      replayAttempts: 0,
      retentionAlertAt: new Date('2026-09-24T12:30:00.000Z'),
      createdAt: new Date(replayClock.getTime() + 1),
      updatedAt: replayClock,
    };
    await Outbox.collection.deleteMany({ userId: ownerId });
    await Outbox.collection.insertMany([declaredCoordinator, representedSibling]);
    const recordBatch = jest.fn();

    await expect(service.replayPending({ limit: 1, recordBatch })).resolves.toEqual({
      scanned: 1,
      replayed: 0,
      pending: 1,
    });
    const afterFirstScan = await Outbox.find({ userId: ownerId })
      .select('+batchOutboxKeys')
      .sort({ createdAt: 1 })
      .lean();
    expect(afterFirstScan).toEqual([
      expect.objectContaining({
        replayAttempts: 1,
        nextAttemptAt: new Date(replayClock.getTime() + 1_000),
      }),
      expect.objectContaining({
        replayAttempts: 1,
        nextAttemptAt: new Date(replayClock.getTime() + 1_000),
      }),
    ]);

    await expect(service.replayPending({ limit: 1, recordBatch })).resolves.toEqual({
      scanned: 0,
      replayed: 0,
      pending: 0,
    });
    expect(recordBatch).not.toHaveBeenCalled();
    expect(
      await Outbox.findOne({ userId: ownerId, batchId: durableCoordinator.batchId }).lean(),
    ).toEqual(
      expect.objectContaining({
        replayAttempts: 1,
        nextAttemptAt: new Date(replayClock.getTime() + 1_000),
      }),
    );
  });

  test('migrates and replays a complete declared transition sibling set exactly once', async () => {
    const replayClock = new Date('2026-08-24T13:00:00.000Z');
    const ownerId = 'owner-complete-declared-transition';
    const service = createCortexInsightOutboxService({
      OutboxModel: Outbox,
      now: () => replayClock,
    });
    await service.enqueueBatch({
      ownerId,
      conversationId: 'conversation-complete-declared-transition',
      parentMessageId: 'parent-complete-declared-transition',
      surface: 'web',
      streamId: 'stream-complete-declared-transition',
      messageRevision: 5,
      insights: [
        { cortexId: 'review-a', insight: 'Complete declared transition member A.' },
        { cortexId: 'review-b', insight: 'Complete declared transition member B.' },
      ],
    });
    const coordinator = await Outbox.findOne({ userId: ownerId })
      .select('+batchEntries +batchMemberHashes +batchOutboxKeys')
      .lean();
    const declaredRows = coordinator.batchEntries.map((entry, index) => ({
      ...entry,
      ...(index === 0
        ? {
            batchId: coordinator.batchId,
            batchSize: coordinator.batchSize,
            batchMemberHashes: coordinator.batchMemberHashes,
            batchOutboxKeys: coordinator.batchOutboxKeys,
          }
        : {
            batchId: '',
            batchSize: 1,
            batchMemberHashes: [],
            batchOutboxKeys: undefined,
          }),
      nextAttemptAt: replayClock,
      replayAttempts: 0,
      retentionAlertAt: new Date('2026-09-24T13:00:00.000Z'),
      createdAt: replayClock,
      updatedAt: replayClock,
    }));
    await Outbox.collection.deleteMany({ userId: ownerId });
    await Outbox.collection.insertMany(declaredRows);
    const recordBatch = jest.fn(async (batch) => exactLedgerAcceptance(batch));

    await expect(service.replayPending({ limit: 1, recordBatch })).resolves.toEqual({
      scanned: 2,
      replayed: 1,
      pending: 0,
    });
    expect(recordBatch).toHaveBeenCalledTimes(1);
    expect(recordBatch.mock.calls[0][0].insights).toHaveLength(2);
    expect(await Outbox.countDocuments({ userId: ownerId })).toBe(0);
  });

  test('rejects non-exact settlement key sets without deleting a durable coordinator', async () => {
    const service = createCortexInsightOutboxService({ OutboxModel: Outbox });
    const cases = [
      { suffix: 'subset', keys: (keys) => [keys[0]] },
      { suffix: 'superset', keys: (keys) => [...keys, 'cortex_insight:unexpected-superset'] },
      { suffix: 'duplicate', keys: (keys) => [...keys, ` ${keys[0]} `] },
      { suffix: 'wrong', keys: (keys) => [keys[0], 'cortex_insight:wrong-member'] },
    ];
    const attempts = [];
    for (const entry of cases) {
      const accepted = await service.enqueueBatch({
        ownerId: `owner-settlement-${entry.suffix}`,
        conversationId: `conversation-settlement-${entry.suffix}`,
        parentMessageId: `parent-settlement-${entry.suffix}`,
        surface: 'web',
        insights: [
          { cortexId: 'review-a', insight: `Settlement ${entry.suffix} member A.` },
          { cortexId: 'review-b', insight: `Settlement ${entry.suffix} member B.` },
        ],
      });
      attempts.push(service.settleBatch({ outboxKeys: entry.keys(accepted.outboxKeys) }));
    }

    const results = await Promise.allSettled(attempts);
    expect(results).toEqual(
      cases.map(() =>
        expect.objectContaining({
          status: 'rejected',
          reason: expect.objectContaining({ code: 'cortex_insight_outbox_conflict' }),
        }),
      ),
    );
    expect(await Outbox.countDocuments({})).toBe(cases.length);
  });

  test('settles only an exact durable key set and keeps retries isolated', async () => {
    const service = createCortexInsightOutboxService({ OutboxModel: Outbox });
    const multi = await service.enqueueBatch({
      ownerId: 'owner-settlement-exact-multi',
      conversationId: 'conversation-settlement-exact-multi',
      parentMessageId: 'parent-settlement-exact-multi',
      surface: 'web',
      insights: [
        { cortexId: 'review-a', insight: 'Exact settlement multi A.' },
        { cortexId: 'review-b', insight: 'Exact settlement multi B.' },
      ],
    });
    const singleton = await service.enqueueBatch({
      ownerId: 'owner-settlement-exact-singleton',
      conversationId: 'conversation-settlement-exact-singleton',
      parentMessageId: 'parent-settlement-exact-singleton',
      surface: 'web',
      insights: [{ cortexId: 'review', insight: 'Exact settlement singleton.' }],
    });
    await service.enqueueBatch({
      ownerId: 'owner-settlement-unrelated',
      conversationId: 'conversation-settlement-unrelated',
      parentMessageId: 'parent-settlement-unrelated',
      surface: 'web',
      insights: [{ cortexId: 'review', insight: 'Unrelated settlement row.' }],
    });

    await expect(service.settleBatch({ outboxKeys: multi.outboxKeys })).resolves.toEqual({
      deleted: 1,
    });
    await expect(service.settleBatch({ outboxKeys: multi.outboxKeys })).resolves.toEqual({
      deleted: 0,
    });
    await expect(service.settleBatch({ outboxKeys: singleton.outboxKeys })).resolves.toEqual({
      deleted: 1,
    });
    expect(await Outbox.find({}).lean()).toEqual([
      expect.objectContaining({ userId: 'owner-settlement-unrelated' }),
    ]);
  });

  test('replays and deletes same-parent legacy siblings as one batch despite limit one', async () => {
    const createdAt = new Date('2026-08-22T12:00:00.000Z');
    const ownerId = 'owner-legacy-sibling-page';
    const insights = [
      { cortexId: 'review-a', insight: 'Persisted legacy sibling A.' },
      { cortexId: 'review-b', insight: 'Persisted legacy sibling B.' },
    ];
    await Outbox.collection.insertMany(
      insights.map((entry, index) => {
        const insightHash = crypto.createHash('sha256').update(entry.insight).digest('hex');
        return {
          outboxKey: `cortex_insight:legacy-sibling-page-${index}`,
          userId: ownerId,
          conversationId: 'conversation-legacy-sibling-page',
          parentMessageId: 'parent-legacy-sibling-page',
          cortexId: entry.cortexId,
          cortexName: `Review ${index + 1}`,
          insight: entry.insight,
          insightHash,
          graphResultHash: insightHash,
          surface: 'web',
          streamId: 'stream-legacy-sibling-page',
          messageRevision: 6,
          nextAttemptAt: createdAt,
          replayAttempts: 0,
          retentionAlertAt: new Date('2026-09-22T12:00:00.000Z'),
          createdAt,
          updatedAt: createdAt,
        };
      }),
    );
    const recordBatch = jest.fn(async (batch) => {
      const deliveries =
        require('../server/services/viventium/CortexInsightDeliveryService').buildCortexInsightDeliveryCandidates(
          batch,
        );
      return {
        deliveries,
        batchId: deliveries[0].batchId,
        batchSize: deliveries.length,
        batchMemberHashes: deliveries[0].batchMemberHashes,
      };
    });
    const service = createCortexInsightOutboxService({ OutboxModel: Outbox });

    await expect(service.replayPending({ limit: 1, recordBatch })).resolves.toEqual({
      scanned: 2,
      replayed: 1,
      pending: 0,
    });
    expect(recordBatch).toHaveBeenCalledTimes(1);
    expect(recordBatch.mock.calls[0][0].insights).toEqual(
      insights.map((insight) => expect.objectContaining(insight)),
    );
    expect(await Outbox.countDocuments({ userId: ownerId })).toBe(0);
  });

  test('keeps full legacy sibling membership durable across replay failure and restart', async () => {
    let replayClock = new Date('2026-08-22T12:00:00.000Z');
    const ownerId = 'owner-legacy-sibling-restart';
    const insights = [
      { cortexId: 'review-a', insight: 'Restarted legacy sibling A.' },
      { cortexId: 'review-b', insight: 'Restarted legacy sibling B.' },
    ];
    await Outbox.collection.insertMany(
      insights.map((entry, index) => {
        const insightHash = crypto.createHash('sha256').update(entry.insight).digest('hex');
        return {
          outboxKey: `cortex_insight:legacy-sibling-restart-${index}`,
          userId: ownerId,
          conversationId: 'conversation-legacy-sibling-restart',
          parentMessageId: 'parent-legacy-sibling-restart',
          cortexId: entry.cortexId,
          cortexName: `Review ${index + 1}`,
          insight: entry.insight,
          insightHash,
          graphResultHash: insightHash,
          surface: 'web',
          streamId: 'stream-legacy-sibling-restart',
          messageRevision: 6,
          nextAttemptAt: replayClock,
          replayAttempts: 0,
          retentionAlertAt: new Date('2026-09-22T12:00:00.000Z'),
          createdAt: replayClock,
          updatedAt: replayClock,
        };
      }),
    );
    const firstBoot = createCortexInsightOutboxService({
      OutboxModel: Outbox,
      now: () => replayClock,
    });
    await expect(
      firstBoot.replayPending({
        limit: 1,
        recordBatch: jest.fn().mockRejectedValue(new Error('synthetic ledger interruption')),
      }),
    ).resolves.toEqual({ scanned: 2, replayed: 0, pending: 1 });

    const durableCoordinator = await Outbox.findOne({ userId: ownerId })
      .select('+batchEntries +batchMemberHashes +batchOutboxKeys +legacyBatchMigrated')
      .lean();
    expect(await Outbox.countDocuments({ userId: ownerId })).toBe(1);
    expect(durableCoordinator).toEqual(
      expect.objectContaining({
        batchSize: 2,
        legacyBatchMigrated: true,
        batchEntries: expect.any(Array),
      }),
    );
    expect(durableCoordinator.batchEntries).toHaveLength(2);

    replayClock = new Date(replayClock.getTime() + 1_000);
    const recordBatch = jest.fn(async (batch) => {
      const deliveries =
        require('../server/services/viventium/CortexInsightDeliveryService').buildCortexInsightDeliveryCandidates(
          batch,
        );
      return {
        deliveries,
        batchId: deliveries[0].batchId,
        batchSize: deliveries.length,
        batchMemberHashes: deliveries[0].batchMemberHashes,
      };
    });
    const restarted = createCortexInsightOutboxService({
      OutboxModel: Outbox,
      now: () => replayClock,
    });
    await expect(restarted.replayPending({ limit: 1, recordBatch })).resolves.toEqual({
      scanned: 1,
      replayed: 1,
      pending: 0,
    });
    expect(recordBatch.mock.calls[0][0].insights).toEqual(
      insights.map((insight) => expect.objectContaining(insight)),
    );
    expect(await Outbox.countDocuments({ userId: ownerId })).toBe(0);
  });

  test('reports a migrated legacy batch as quarantined after an immutable ledger conflict', async () => {
    const replayClock = new Date('2026-08-22T12:00:00.000Z');
    const ownerId = 'owner-legacy-sibling-quarantine';
    const insights = [
      { cortexId: 'review-a', insight: 'Quarantined legacy sibling A.' },
      { cortexId: 'review-b', insight: 'Quarantined legacy sibling B.' },
    ];
    await Outbox.collection.insertMany(
      insights.map((entry, index) => {
        const insightHash = crypto.createHash('sha256').update(entry.insight).digest('hex');
        return {
          outboxKey: `cortex_insight:legacy-sibling-quarantine-${index}`,
          userId: ownerId,
          conversationId: 'conversation-legacy-sibling-quarantine',
          parentMessageId: 'parent-legacy-sibling-quarantine',
          cortexId: entry.cortexId,
          cortexName: `Review ${index + 1}`,
          insight: entry.insight,
          insightHash,
          graphResultHash: insightHash,
          surface: 'web',
          streamId: 'stream-legacy-sibling-quarantine',
          messageRevision: 6,
          nextAttemptAt: replayClock,
          replayAttempts: 0,
          retentionAlertAt: new Date('2026-09-22T12:00:00.000Z'),
          createdAt: replayClock,
          updatedAt: replayClock,
        };
      }),
    );
    const recordBatch = jest.fn().mockRejectedValue(
      Object.assign(new Error('synthetic immutable parent conflict'), {
        code: 'cortex_insight_delivery_batch_mixed_envelope',
      }),
    );
    const service = createCortexInsightOutboxService({
      OutboxModel: Outbox,
      now: () => replayClock,
    });

    await expect(service.replayPending({ limit: 1, recordBatch })).resolves.toEqual({
      scanned: 2,
      replayed: 0,
      pending: 0,
      quarantined: 1,
    });
    expect(recordBatch).toHaveBeenCalledTimes(1);
    expect(await Outbox.countDocuments({ userId: ownerId })).toBe(1);
    const coordinator = await Outbox.findOne({ userId: ownerId }).select('+batchEntries').lean();
    expect(coordinator).toEqual(
      expect.objectContaining({
        replayState: 'quarantined',
        replayAttempts: 1,
        lastFailureCode: 'cortex_insight_delivery_batch_mixed_envelope',
        quarantinedAt: replayClock,
      }),
    );
    expect(coordinator.batchEntries).toHaveLength(2);

    const restarted = createCortexInsightOutboxService({
      OutboxModel: Outbox,
      now: () => new Date('2026-08-23T12:00:00.000Z'),
    });
    await expect(restarted.replayPending({ recordBatch })).resolves.toEqual({
      scanned: 0,
      replayed: 0,
      pending: 0,
    });
    expect(recordBatch).toHaveBeenCalledTimes(1);
  });

  test('resolves an older due sibling through its migrated coordinator after a cleanup crash', async () => {
    const replayClock = new Date('2026-08-22T12:00:05.000Z');
    const ownerId = 'owner-legacy-cleanup-crash';
    const insights = [
      { cortexId: 'review-a', cortexName: 'Review 1', insight: 'Cleanup crash sibling A.' },
      { cortexId: 'review-b', cortexName: 'Review 2', insight: 'Cleanup crash sibling B.' },
    ];
    await Outbox.collection.insertMany(
      insights.map((entry, index) => {
        const insightHash = crypto.createHash('sha256').update(entry.insight).digest('hex');
        return {
          outboxKey: `cortex_insight:legacy-cleanup-crash-${index}`,
          userId: ownerId,
          conversationId: 'conversation-legacy-cleanup-crash',
          parentMessageId: 'parent-legacy-cleanup-crash',
          cortexId: entry.cortexId,
          cortexName: entry.cortexName,
          insight: entry.insight,
          insightHash,
          graphResultHash: insightHash,
          surface: 'web',
          streamId: 'stream-legacy-cleanup-crash',
          messageRevision: 6,
          nextAttemptAt: new Date(replayClock.getTime() - (index === 0 ? 1_000 : 2_000)),
          replayAttempts: index,
          retentionAlertAt: new Date('2026-09-22T12:00:00.000Z'),
          createdAt: new Date('2026-08-22T12:00:00.000Z'),
          updatedAt: new Date('2026-08-22T12:00:00.000Z'),
        };
      }),
    );
    const legacyRows = await Outbox.find({ userId: ownerId })
      .select('+insight +streamId +graphResultHash +batchEntries')
      .sort({ _id: 1 })
      .lean();
    const replayBatch = {
      ownerId,
      conversationId: 'conversation-legacy-cleanup-crash',
      parentMessageId: 'parent-legacy-cleanup-crash',
      surface: 'web',
      streamId: 'stream-legacy-cleanup-crash',
      messageRevision: 6,
      insights: insights.map((entry) => ({ ...entry, status: 'completed' })),
    };
    const expected =
      require('../server/services/viventium/CortexInsightDeliveryService').buildCortexInsightDeliveryCandidates(
        replayBatch,
      );
    const coordinator = legacyRows[0];
    const orphan = legacyRows[1];
    await Outbox.collection.updateOne(
      { _id: coordinator._id },
      {
        $set: {
          sourceRevision: 6,
          batchId: expected[0].batchId,
          batchSize: 2,
          batchMemberHashes: expected[0].batchMemberHashes,
          batchOutboxKeys: legacyRows.map((row) => row.outboxKey).sort(),
          batchEntries: legacyRows,
          legacyBatchMigrated: true,
          nextAttemptAt: new Date(replayClock.getTime() - 1_000),
        },
      },
    );
    await Outbox.collection.updateOne(
      { _id: orphan._id },
      { $set: { nextAttemptAt: new Date(replayClock.getTime() - 2_000) } },
    );
    const recordBatch = jest.fn(async (batch) => {
      const deliveries =
        require('../server/services/viventium/CortexInsightDeliveryService').buildCortexInsightDeliveryCandidates(
          batch,
        );
      return {
        deliveries,
        batchId: deliveries[0].batchId,
        batchSize: deliveries.length,
        batchMemberHashes: deliveries[0].batchMemberHashes,
      };
    });
    const restarted = createCortexInsightOutboxService({
      OutboxModel: Outbox,
      now: () => replayClock,
    });

    await expect(restarted.replayPending({ limit: 1, recordBatch })).resolves.toEqual({
      scanned: 2,
      replayed: 1,
      pending: 0,
    });
    expect(recordBatch.mock.calls[0][0].insights).toEqual(
      insights.map((insight) => expect.objectContaining(insight)),
    );
    expect(await Outbox.countDocuments({ userId: ownerId })).toBe(0);
  });

  test('allows only one concurrent worker to replay a same-parent legacy sibling batch', async () => {
    const createdAt = new Date('2026-08-22T12:00:00.000Z');
    const ownerId = 'owner-legacy-sibling-concurrent';
    const insights = [
      { cortexId: 'review-a', insight: 'Concurrent legacy sibling A.' },
      { cortexId: 'review-b', insight: 'Concurrent legacy sibling B.' },
    ];
    await Outbox.collection.insertMany(
      insights.map((entry, index) => {
        const insightHash = crypto.createHash('sha256').update(entry.insight).digest('hex');
        return {
          outboxKey: `cortex_insight:legacy-sibling-concurrent-${index}`,
          userId: ownerId,
          conversationId: 'conversation-legacy-sibling-concurrent',
          parentMessageId: 'parent-legacy-sibling-concurrent',
          cortexId: entry.cortexId,
          cortexName: `Review ${index + 1}`,
          insight: entry.insight,
          insightHash,
          graphResultHash: insightHash,
          surface: 'web',
          streamId: 'stream-legacy-sibling-concurrent',
          messageRevision: 6,
          nextAttemptAt: createdAt,
          replayAttempts: 0,
          retentionAlertAt: new Date('2026-09-22T12:00:00.000Z'),
          createdAt,
          updatedAt: createdAt,
        };
      }),
    );
    let releaseReplay;
    const replayStarted = new Promise((resolve) => {
      releaseReplay = resolve;
    });
    let firstCall = true;
    const recordBatch = jest.fn(async (batch) => {
      if (firstCall) {
        firstCall = false;
        releaseReplay();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const deliveries =
        require('../server/services/viventium/CortexInsightDeliveryService').buildCortexInsightDeliveryCandidates(
          batch,
        );
      return {
        deliveries,
        batchId: deliveries[0].batchId,
        batchSize: deliveries.length,
        batchMemberHashes: deliveries[0].batchMemberHashes,
      };
    });
    const firstWorker = createCortexInsightOutboxService({ OutboxModel: Outbox });
    const secondWorker = createCortexInsightOutboxService({ OutboxModel: Outbox });
    const firstReplay = firstWorker.replayPending({ limit: 1, recordBatch });
    await replayStarted;
    const secondReplay = secondWorker.replayPending({ limit: 1, recordBatch });
    const results = await Promise.all([firstReplay, secondReplay]);

    expect(results.reduce((count, result) => count + result.replayed, 0)).toBe(1);
    expect(recordBatch).toHaveBeenCalledTimes(1);
    expect(recordBatch.mock.calls[0][0].insights).toEqual(
      insights.map((insight) => expect.objectContaining(insight)),
    );
    expect(await Outbox.countDocuments({ userId: ownerId })).toBe(0);
  });

  test('rejects every model path that can rewrite a completed Cortex outbox payload', async () => {
    const makeRow = async (suffix) => {
      const insight = `Private completed insight ${suffix}.`;
      return Outbox.create({
        outboxKey: `outbox-immutable-${suffix}`,
        userId: 'owner-immutable',
        conversationId: 'conversation-immutable',
        parentMessageId: `parent-immutable-${suffix}`,
        cortexId: 'review',
        cortexName: 'Review',
        insight,
        insightHash: crypto.createHash('sha256').update(insight).digest('hex'),
        surface: 'web',
        streamId: 'stream-immutable',
        messageRevision: 2,
        retentionAlertAt: new Date('2026-09-22T12:00:00.000Z'),
      });
    };
    const replacementFor = (row) => {
      const replacement = row.toObject();
      delete replacement._id;
      delete replacement.__v;
      delete replacement.createdAt;
      delete replacement.updatedAt;
      replacement.insight = 'Rewritten private result.';
      return replacement;
    };
    const attacks = [
      [
        'updateOne $set insight',
        (row) => Outbox.updateOne({ _id: row._id }, { $set: { insight: 'Changed.' } }),
      ],
      [
        'updateOne $unset stream',
        (row) => Outbox.updateOne({ _id: row._id }, { $unset: { streamId: 1 } }),
      ],
      [
        'updateMany $set parent',
        (row) => Outbox.updateMany({ _id: row._id }, { $set: { parentMessageId: 'changed' } }),
      ],
      [
        'findOneAndUpdate hash',
        (row) =>
          Outbox.findOneAndUpdate({ _id: row._id }, { $set: { insightHash: 'b'.repeat(64) } }),
      ],
      [
        'findByIdAndUpdate surface',
        (row) => Outbox.findByIdAndUpdate(row._id, { $set: { surface: 'telegram' } }),
      ],
      ['replaceOne', (row) => Outbox.replaceOne({ _id: row._id }, replacementFor(row))],
      [
        'findOneAndReplace',
        (row) => Outbox.findOneAndReplace({ _id: row._id }, replacementFor(row)),
      ],
      [
        'query replaceOne',
        (row) => Outbox.findOne({ _id: row._id }).replaceOne(replacementFor(row)),
      ],
      ['document updateOne', (row) => row.updateOne({ $set: { cortexName: 'Changed' } })],
      ['document replaceOne', (row) => row.replaceOne(replacementFor(row))],
      [
        'pipeline updateOne',
        (row) => Outbox.updateOne({ _id: row._id }, [{ $set: { insight: 'Changed.' } }]),
      ],
      [
        'pipeline updateMany',
        (row) => Outbox.updateMany({ _id: row._id }, [{ $unset: 'streamId' }]),
      ],
      [
        'pipeline findOneAndUpdate',
        (row) =>
          Outbox.findOneAndUpdate({ _id: row._id }, [{ $set: { parentMessageId: 'changed' } }]),
      ],
      [
        'rename insight',
        (row) => Outbox.updateOne({ _id: row._id }, { $rename: { insight: 'oldInsight' } }),
      ],
      [
        'increment revision',
        (row) => Outbox.updateOne({ _id: row._id }, { $inc: { messageRevision: 1 } }),
      ],
      [
        'currentDate expiry',
        (row) => Outbox.updateOne({ _id: row._id }, { $currentDate: { retentionAlertAt: true } }),
      ],
      [
        'setOnInsert without upsert',
        (row) => Outbox.updateOne({ _id: row._id }, { $setOnInsert: { insight: 'Changed.' } }),
      ],
      [
        'minimum revision',
        (row) => Outbox.updateOne({ _id: row._id }, { $min: { messageRevision: 1 } }),
      ],
      [
        'maximum revision',
        (row) => Outbox.updateOne({ _id: row._id }, { $max: { messageRevision: 9 } }),
      ],
      [
        'multiply revision',
        (row) => Outbox.updateOne({ _id: row._id }, { $mul: { messageRevision: 2 } }),
      ],
      [
        'bulk updateOne',
        (row) =>
          Outbox.bulkWrite([
            { updateOne: { filter: { _id: row._id }, update: { $set: { insight: 'Changed.' } } } },
          ]),
      ],
      [
        'bulk updateMany',
        (row) =>
          Outbox.bulkWrite([
            { updateMany: { filter: { _id: row._id }, update: { $unset: { streamId: 1 } } } },
          ]),
      ],
      [
        'bulk replaceOne',
        (row) =>
          Outbox.bulkWrite([
            { replaceOne: { filter: { _id: row._id }, replacement: replacementFor(row) } },
          ]),
      ],
      [
        'bulkSave private rewrite',
        async (row) => {
          row.insight = 'Changed.';
          return Outbox.bulkSave([row]);
        },
      ],
      [
        'document save insight',
        async (row) => {
          row.insight = 'Changed.';
          return row.save();
        },
      ],
      [
        'document save stream',
        async (row) => {
          row.streamId = 'changed';
          return row.save();
        },
      ],
      [
        'document save parent',
        async (row) => {
          row.parentMessageId = 'changed';
          return row.save();
        },
      ],
    ];

    expect(attacks.length).toBeGreaterThanOrEqual(21);
    for (const [name, attack] of attacks) {
      const suffix = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      const row = await makeRow(suffix);
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
      expect(rejectionText || `attack resolved: ${name}`).toContain(
        'outbox payload is append-only',
      );
      const preserved = await Outbox.findById(row._id).select('+insight +streamId').lean();
      expect(preserved).toEqual(
        expect.objectContaining({
          insight: `Private completed insight ${suffix}.`,
          streamId: 'stream-immutable',
          parentMessageId: `parent-immutable-${suffix}`,
          messageRevision: 2,
        }),
      );
    }
  });

  test('keeps the immutable completed result retryable when the ledger returns no acceptance', async () => {
    const service = createCortexInsightOutboxService({ OutboxModel: Outbox });
    await service.enqueueBatch({
      ownerId: 'owner-replay-truth',
      conversationId: 'conversation-replay-truth',
      parentMessageId: 'parent-replay-truth',
      surface: 'web',
      streamId: 'stream-replay-truth',
      messageRevision: 5,
      insights: [
        {
          cortexId: 'review',
          cortexName: 'Review',
          insight: 'The immutable completed graph result.',
          status: 'completed',
        },
      ],
    });
    const row = await Outbox.findOne({ userId: 'owner-replay-truth' }).select('+insight').exec();
    await expect(
      Outbox.updateOne({ _id: row._id }, { $set: { insight: 'Forged replay result.' } }),
    ).rejects.toThrow('outbox payload is append-only');
    const recordBatch = jest.fn().mockResolvedValue({});

    await expect(service.replayPending({ recordBatch })).resolves.toEqual({
      scanned: 1,
      replayed: 0,
      pending: 1,
    });
    expect(await Outbox.countDocuments({})).toBe(1);
    expect(recordBatch).toHaveBeenCalledWith({
      ownerId: 'owner-replay-truth',
      conversationId: 'conversation-replay-truth',
      parentMessageId: 'parent-replay-truth',
      surface: 'web',
      streamId: 'stream-replay-truth',
      messageRevision: 5,
      insights: [
        {
          cortexId: 'review',
          cortexName: 'Review',
          insight: 'The immutable completed graph result.',
          status: 'completed',
        },
      ],
    });
  });

  test.each([
    ['partial', { deliveries: [{ deliveryId: 'wrong-delivery' }] }],
    ['malformed', { deliveries: 'not-an-array' }],
  ])('keeps an outbox row retryable after a %s ledger acceptance', async (_name, receipt) => {
    const service = createCortexInsightOutboxService({ OutboxModel: Outbox });
    await service.enqueueBatch({
      ownerId: `owner-${_name}`,
      conversationId: `conversation-${_name}`,
      parentMessageId: `parent-${_name}`,
      surface: 'web',
      streamId: `stream-${_name}`,
      messageRevision: 2,
      insights: [
        {
          cortexId: 'review',
          cortexName: 'Review',
          insight: `Completed result ${_name}.`,
          status: 'completed',
        },
      ],
    });

    await expect(
      service.replayPending({ recordBatch: jest.fn().mockResolvedValue(receipt) }),
    ).resolves.toEqual({ scanned: 1, replayed: 0, pending: 1 });
    expect(await Outbox.countDocuments({})).toBe(1);
  });
});
