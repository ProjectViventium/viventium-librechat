/* === VIVENTIUM START ===
 * Feature: Phase B owner-batched Cortex insight delivery (real Mongo).
 * Purpose: Several cortices finishing one by one on the same answer reach one exact delivery batch,
 * across a live owner, an owner that released its work, and a restarted runtime slot.
 * === VIVENTIUM END === */

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const createViventiumCortexInsightDelivery = require('./viventiumCortexInsightDelivery');
const createViventiumCortexInsightOutbox = require('./viventiumCortexInsightOutbox');
const {
  buildCortexInsightDeliveryCandidates,
  createCortexInsightDeliveryService,
} = require('../server/services/viventium/CortexInsightDeliveryService');
const {
  createCortexInsightOutboxService,
} = require('../server/services/viventium/CortexInsightOutboxService');
const {
  recoverPendingCortexInsightDeliveries,
} = require('../server/services/viventium/staleCortexMessageRecovery');
const {
  persistCompletedCortexGraphInsight,
} = require('../server/services/BackgroundCortexService');

const CORTICES = [
  { agent: { id: 'deep-memory', name: 'Deep Memory Search' }, insight: 'First exact insight.' },
  { agent: { id: 'parietal', name: 'Parietal Cortex' }, insight: 'Second exact insight.' },
];

function turn(suffix) {
  return {
    req: {
      user: { id: `owner-${suffix}` },
      body: { streamId: `stream-${suffix}`, viventiumLogicalTurnRevision: 1 },
    },
    conversationId: `conversation-${suffix}`,
    parentMessageId: `answer-${suffix}`,
    surface: 'web',
  };
}

function claimInput(suffix, cortices = CORTICES) {
  return {
    ownerId: `owner-${suffix}`,
    conversationId: `conversation-${suffix}`,
    parentMessageId: `answer-${suffix}`,
    surface: 'web',
    streamId: `stream-${suffix}`,
    messageRevision: 1,
    insights: cortices.map(({ agent, insight }) => ({
      cortexId: agent.id,
      cortexName: agent.name,
      insight,
      status: 'completed',
    })),
  };
}

describe('Phase B owner-batched Cortex insight delivery', () => {
  let server;
  let database;
  let Delivery;
  let Outbox;

  beforeAll(async () => {
    server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    database = new mongoose.Mongoose();
    await database.connect(server.getUri());
    Delivery = createViventiumCortexInsightDelivery(database);
    Outbox = createViventiumCortexInsightOutbox(database);
    await Promise.all([Delivery.syncIndexes(), Outbox.syncIndexes()]);
  });

  afterAll(async () => {
    await database?.disconnect();
    await server?.stop();
  });

  // Recovery scans every recoverable parent, so each case starts from empty stores.
  beforeEach(async () => {
    await Promise.all([Delivery.collection.deleteMany({}), Outbox.collection.deleteMany({})]);
  });

  async function acceptEach(outbox, suffix, cortices = CORTICES) {
    const recordBatch = jest.fn();
    outbox.registerOwnedParent({ ownerId: `owner-${suffix}`, parentMessageId: `answer-${suffix}` });
    for (const { agent, insight } of cortices) {
      await expect(
        persistCompletedCortexGraphInsight(
          { ...turn(suffix), agent, insight, ownerBatch: true },
          { acceptOwned: outbox.acceptOwnedInsight, recordBatch },
        ),
      ).resolves.toMatchObject({ durableAcceptance: 'outbox', ownerBatch: true, deliveries: [] });
    }
    // Acceptance never writes a per-cortex ledger batch for an owned Phase B insight.
    expect(recordBatch).not.toHaveBeenCalled();
  }

  async function persistAndPresent(service, ownerId, claims, messageId) {
    await service.markPersisted({
      ownerId,
      claims,
      persistedMessageId: messageId,
      messageRevision: 1,
    });
    const fence = await service.fencePresentation({
      ownerId,
      claims,
      surface: 'web',
      persistedMessageId: messageId,
      messageRevision: 1,
    });
    await service.markPresented({
      ownerId,
      claims: fence.claims,
      surface: 'web',
      persistedMessageId: messageId,
      messageRevision: 1,
      presentationGeneration: fence.generation,
      presentationClaimToken: fence.claimToken,
      presentationLeaseToken: fence.presentationLeaseToken,
      presentationRef: `web:synthetic:${messageId}:1`,
    });
  }

  test('delivers two completed insights on one answer through the owner batch as sent', async () => {
    const outbox = createCortexInsightOutboxService({
      OutboxModel: Outbox,
      runtimeSlot: 'slot-live',
      runtimeEpoch: 'boot-live',
    });
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      runtimeSlot: 'slot-live',
      runtimeEpoch: 'boot-live',
    });
    await acceptEach(outbox, 'two');

    // While the owner is live, recovery neither replays nor claims its accepted insights.
    await expect(outbox.replayPending({ recordBatch: service.recordBatch })).resolves.toEqual({
      scanned: 0,
      replayed: 0,
      pending: 0,
    });
    expect(await Delivery.countDocuments({ parentMessageId: 'answer-two' })).toBe(0);

    const input = claimInput('two');
    const batch = await service.claimBatch(input);
    expect(batch.claimed).toHaveLength(2);
    await expect(
      outbox.settleOwnedInsights({
        ownerId: 'owner-two',
        parentMessageId: 'answer-two',
        outboxKeys: buildCortexInsightDeliveryCandidates(input).map((row) => row.deliveryKey),
      }),
    ).resolves.toEqual({ deleted: 2 });
    await persistAndPresent(service, 'owner-two', batch.claimed, 'follow-up-two');

    const rows = await Delivery.find({ parentMessageId: 'answer-two' }).lean();
    expect(rows.map((row) => [row.cortexId, row.status, row.batchSize]).sort()).toEqual([
      ['deep-memory', 'sent', 2],
      ['parietal', 'sent', 2],
    ]);
    expect(new Set(rows.map((row) => row.batchId)).size).toBe(1);
    expect(await Outbox.countDocuments({ userId: 'owner-two' })).toBe(0);
  });

  test('the per-cortex ledger batch this replaces refused the second insight', async () => {
    const service = createCortexInsightDeliveryService({ DeliveryModel: Delivery });
    const [first, second] = CORTICES;
    await service.recordBatch(claimInput('legacy', [first]));
    await expect(service.recordBatch(claimInput('legacy', [second]))).rejects.toMatchObject({
      code: 'cortex_insight_delivery_batch_mixed_envelope',
    });
    await expect(service.claimBatch(claimInput('legacy'))).rejects.toMatchObject({
      code: 'cortex_insight_delivery_batch_mixed_envelope',
    });
  });

  test('a restarted runtime slot replays both accepted insights as one batch and sends once', async () => {
    const firstBoot = createCortexInsightOutboxService({
      OutboxModel: Outbox,
      runtimeSlot: 'slot-restart',
      runtimeEpoch: 'boot-1',
    });
    await acceptEach(firstBoot, 'restart');

    const restarted = createCortexInsightOutboxService({
      OutboxModel: Outbox,
      runtimeSlot: 'slot-restart',
      runtimeEpoch: 'boot-2',
    });
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      runtimeSlot: 'slot-restart',
      runtimeEpoch: 'boot-2',
    });
    const createMessage = jest.fn(async ({ insights }) => ({
      messageId: 'recovered-follow-up',
      revision: 1,
      text: insights.map((insight) => insight.insight).join('\n'),
    }));
    const presentSurface = jest.fn(
      async ({ surface, message, recoveryContext, presentationFence }) => ({
        surface,
        messageId: message.messageId,
        revision: message.revision,
        presentationGeneration: recoveryContext.claimGeneration,
        presentationClaimToken: presentationFence.claimToken,
        presentationLeaseToken: presentationFence.presentationLeaseToken,
        presentationRef: 'sse:stream-restart:1',
      }),
    );
    const recover = () =>
      recoverPendingCortexInsightDeliveries({
        deliveryService: service,
        replayOutbox: (options) =>
          restarted.replayPending({ ...options, recordBatch: service.recordBatch }),
        replayMessageFallbacks: async () => ({ scanned: 0, replayed: 0, pending: 0 }),
        loadParentState: async ({ parentMessageId }) => ({
          messageId: parentMessageId,
          unfinished: false,
        }),
        hasDurableTelegramDispatchAuthority: async () => false,
        bindMessageGeneration: async ({ message, revision }) => ({ ...message, revision }),
        bindStreamPresentation: async () => null,
        createMessage,
        presentSurface,
      });

    const first = await recover();
    expect(first.outbox).toEqual({ scanned: 2, replayed: 1, pending: 0 });
    expect(first).toMatchObject({ claimed: 2, persisted: 2, sent: 2, failed: 0 });
    await expect(recover()).resolves.toMatchObject({ claimed: 0, sent: 0, failed: 0 });

    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(createMessage.mock.calls[0][0].insights.map((insight) => insight.insight)).toEqual([
      'First exact insight.',
      'Second exact insight.',
    ]);
    const rows = await Delivery.find({ parentMessageId: 'answer-restart' }).lean();
    expect(rows.map((row) => [row.cortexId, row.status, row.batchSize]).sort()).toEqual([
      ['deep-memory', 'sent', 2],
      ['parietal', 'sent', 2],
    ]);
    expect(await Outbox.countDocuments({ userId: 'owner-restart' })).toBe(0);
  });

  test('an owner release groups only its own answer; a live sibling owner stays untouched', async () => {
    const outbox = createCortexInsightOutboxService({
      OutboxModel: Outbox,
      runtimeSlot: 'slot-siblings',
      runtimeEpoch: 'boot-siblings',
    });
    const otherSlot = createCortexInsightOutboxService({
      OutboxModel: Outbox,
      runtimeSlot: 'slot-elsewhere',
      runtimeEpoch: 'boot-elsewhere',
    });
    const service = createCortexInsightDeliveryService({ DeliveryModel: Delivery });
    await acceptEach(outbox, 'released');
    await acceptEach(outbox, 'sibling', [CORTICES[0]]);

    // The released owner's follow-up failed before recording: its rows become one grouped batch.
    await expect(
      outbox.releaseOwnedInsights({
        ownerId: 'owner-released',
        parentMessageId: 'answer-released',
      }),
    ).resolves.toEqual({ released: 2 });
    await expect(otherSlot.replayPending({ recordBatch: service.recordBatch })).resolves.toEqual({
      scanned: 2,
      replayed: 1,
      pending: 0,
    });
    const released = await Delivery.find({ parentMessageId: 'answer-released' }).lean();
    expect(released.map((row) => [row.cortexId, row.status, row.batchSize]).sort()).toEqual([
      ['deep-memory', 'pending', 2],
      ['parietal', 'pending', 2],
    ]);

    // The sibling answer's live owner keeps its accepted insight out of every other path.
    expect(await Delivery.countDocuments({ parentMessageId: 'answer-sibling' })).toBe(0);
    expect(await Outbox.countDocuments({ userId: 'owner-sibling', replayState: 'pending' })).toBe(
      1,
    );
    await expect(
      outbox.settleOwnedInsights({
        ownerId: 'owner-released',
        parentMessageId: 'answer-sibling',
        outboxKeys: buildCortexInsightDeliveryCandidates(claimInput('sibling', [CORTICES[0]])).map(
          (row) => row.deliveryKey,
        ),
      }),
    ).resolves.toEqual({ deleted: 0 });
    expect(await Outbox.countDocuments({ userId: 'owner-sibling' })).toBe(1);
    expect(await Outbox.countDocuments({ replayState: 'quarantined' })).toBe(0);
  });

  function acceptOne(outbox, suffix, cortex) {
    return outbox.acceptOwnedInsight({
      ownerId: `owner-${suffix}`,
      conversationId: `conversation-${suffix}`,
      parentMessageId: `answer-${suffix}`,
      surface: 'web',
      streamId: `stream-${suffix}`,
      messageRevision: 1,
      insights: [
        {
          cortexId: cortex.agent.id,
          cortexName: cortex.agent.name,
          insight: cortex.insight,
          status: 'completed',
        },
      ],
    });
  }

  test('an acceptance still writing when the owner seals joins the owner batch', async () => {
    let releaseWrite;
    const gate = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    const slowModel = Object.create(Outbox);
    slowModel.updateOne = async (...args) => {
      await gate;
      return Outbox.updateOne(...args);
    };
    const outbox = createCortexInsightOutboxService({
      OutboxModel: slowModel,
      runtimeSlot: 'slot-held',
      runtimeEpoch: 'boot-held',
    });
    const service = createCortexInsightDeliveryService({ DeliveryModel: Delivery });
    outbox.registerOwnedParent({ ownerId: 'owner-held', parentMessageId: 'answer-held' });
    const held = acceptOne(outbox, 'held', CORTICES[1]);
    const sealing = outbox.sealOwnedInsights({
      ownerId: 'owner-held',
      parentMessageId: 'answer-held',
    });
    await expect(acceptOne(outbox, 'held', CORTICES[0])).rejects.toMatchObject({
      code: 'cortex_insight_owner_closed',
    });
    releaseWrite();
    await held;
    const accepted = await sealing;

    expect(accepted.map((item) => item.insight)).toEqual(['Second exact insight.']);
    const batch = await service.claimBatch({ ...claimInput('held', [CORTICES[1]]) });
    expect(batch.claimed).toHaveLength(1);
    expect(await Outbox.countDocuments({ replayState: 'quarantined' })).toBe(0);
  });

  test('a producer after the owner closed a recorded parent is refused and leaves no row', async () => {
    const outbox = createCortexInsightOutboxService({
      OutboxModel: Outbox,
      DeliveryModel: Delivery,
      runtimeSlot: 'slot-closed',
      runtimeEpoch: 'boot-closed',
    });
    const service = createCortexInsightDeliveryService({ DeliveryModel: Delivery });
    await acceptEach(outbox, 'closed', [CORTICES[0]]);
    const accepted = await outbox.sealOwnedInsights({
      ownerId: 'owner-closed',
      parentMessageId: 'answer-closed',
    });
    await service.claimBatch(claimInput('closed', [CORTICES[0]]));
    await outbox.settleOwnedInsights({
      ownerId: 'owner-closed',
      parentMessageId: 'answer-closed',
      outboxKeys: buildCortexInsightDeliveryCandidates(claimInput('closed', [CORTICES[0]])).map(
        (row) => row.deliveryKey,
      ),
    });
    await outbox.releaseOwnedInsights({
      ownerId: 'owner-closed',
      parentMessageId: 'answer-closed',
    });

    await expect(acceptOne(outbox, 'closed', CORTICES[1])).rejects.toMatchObject({
      code: 'cortex_insight_owner_closed',
    });
    expect(accepted).toHaveLength(1);
    expect(await Outbox.countDocuments({ userId: 'owner-closed' })).toBe(0);
    expect(await Delivery.countDocuments({ parentMessageId: 'answer-closed' })).toBe(1);
    expect(await Outbox.countDocuments({ replayState: 'quarantined' })).toBe(0);
  });

  test('a late insight whose owner closed without a batch becomes the parent batch and is sent', async () => {
    const outbox = createCortexInsightOutboxService({
      OutboxModel: Outbox,
      DeliveryModel: Delivery,
      runtimeSlot: 'slot-late',
      runtimeEpoch: 'boot-late',
    });
    const service = createCortexInsightDeliveryService({ DeliveryModel: Delivery });
    outbox.registerOwnedParent({ ownerId: 'owner-late', parentMessageId: 'answer-late' });
    await outbox.sealOwnedInsights({ ownerId: 'owner-late', parentMessageId: 'answer-late' });
    await outbox.releaseOwnedInsights({ ownerId: 'owner-late', parentMessageId: 'answer-late' });

    await acceptOne(outbox, 'late', CORTICES[0]);
    await expect(outbox.replayPending({ recordBatch: service.recordBatch })).resolves.toEqual({
      scanned: 1,
      replayed: 1,
      pending: 0,
    });
    const claimed = await service.claimPendingByParent({
      ownerId: 'owner-late',
      parentMessageId: 'answer-late',
      surface: 'web',
    });
    await persistAndPresent(service, 'owner-late', claimed.claimed, 'late-follow-up');
    const rows = await Delivery.find({ parentMessageId: 'answer-late' }).lean();
    expect(rows.map((row) => [row.cortexId, row.status])).toEqual([['deep-memory', 'sent']]);
    expect(await Outbox.countDocuments({ userId: 'owner-late' })).toBe(0);
  });
});
