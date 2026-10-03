/* === VIVENTIUM START ===
 * Feature: Cortex follow-up terminal outcome (real Mongo).
 * Purpose: A persisted follow-up's decision metadata reads `pending` until the ledger settles every
 * row that message presents, then records the ledger's exact terminal outcome on the follow-up and
 * its parent. A still-deliverable surface keeps it `pending`; other owners are never touched.
 * === VIVENTIUM END === */

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createModels } = require('@librechat/data-schemas');
const createViventiumCortexInsightDelivery = require('./viventiumCortexInsightDelivery');
const {
  createCortexInsightDeliveryService,
  reconcileFollowUpTerminalOutcomes,
  withFollowUpTerminalOutcome,
} = require('../server/services/viventium/CortexInsightDeliveryService');
const {
  recoverPendingCortexInsightDeliveries,
} = require('../server/services/viventium/staleCortexMessageRecovery');

const OTHER_OWNER = 'owner-other';

function claimInput(suffix, surface) {
  return {
    ownerId: `owner-${suffix}`,
    conversationId: `conversation-${suffix}`,
    parentMessageId: `answer-${suffix}`,
    surface,
    streamId: `stream-${suffix}`,
    messageRevision: 1,
    insights: [
      {
        cortexId: 'deep-memory',
        cortexName: 'Deep Memory Search',
        insight: 'Corrected exact total.',
        status: 'completed',
      },
    ],
  };
}

function decision(suffix, deliveryStatus = 'pending') {
  return {
    tag: 'CortexFollowupDecision',
    schemaVersion: 1,
    conversationId: `conversation-${suffix}`,
    parentMessageId: `answer-${suffix}`,
    result: 'persisted',
    deliveryStatus,
    dropReason: '',
    persistedMessageId: `follow-up-${suffix}`,
    terminalAt: '',
  };
}

describe('Cortex follow-up terminal outcome', () => {
  let server;
  let database;
  let Delivery;
  let Message;

  beforeAll(async () => {
    server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    database = new mongoose.Mongoose();
    await database.connect(server.getUri());
    Delivery = createViventiumCortexInsightDelivery(database);
    Message = createModels(database).Message;
    await Promise.all([Delivery.syncIndexes(), Message.syncIndexes()]);
  });

  afterAll(async () => {
    await database?.disconnect();
    await server?.stop();
  });

  beforeEach(async () => {
    await Promise.all([Delivery.collection.deleteMany({}), Message.collection.deleteMany({})]);
  });

  function services() {
    const base = createCortexInsightDeliveryService({
      DeliveryModel: Delivery,
      runtimeSlot: 'slot-live',
      runtimeEpoch: 'boot-live',
    });
    return { base, service: withFollowUpTerminalOutcome(base, { MessageModel: Message }) };
  }

  /** Seeds a parent answer and its follow-up; `ids` lets another owner reuse the same decision. */
  async function seedMessages(suffix, owner = `owner-${suffix}`, ids = suffix) {
    const shared = {
      conversationId: `conversation-${suffix}`,
      user: owner,
      isCreatedByUser: false,
    };
    await Message.create([
      {
        ...shared,
        messageId: `answer-${ids}`,
        parentMessageId: `prompt-${ids}`,
        text: 'Main answer.',
        metadata: { viventium: { cortexFollowUpDecision: decision(suffix) } },
      },
      {
        ...shared,
        messageId: `follow-up-${ids}`,
        parentMessageId: `answer-${ids}`,
        text: 'Corrected exact total.',
        metadata: {
          viventium: { type: 'cortex_followup', cortexFollowUpDecision: decision(suffix) },
        },
      },
    ]);
  }

  async function decisions(suffix, owner = `owner-${suffix}`) {
    const rows = await Message.find({ user: owner, conversationId: `conversation-${suffix}` })
      .sort({ messageId: 1 })
      .lean();
    return rows.map((row) => ({
      messageId: row.messageId,
      ...row.metadata.viventium.cortexFollowUpDecision,
    }));
  }

  async function persistAndPresentWeb(service, suffix, claims) {
    const ownerId = `owner-${suffix}`;
    const persistedMessageId = `follow-up-${suffix}`;
    await service.markPersisted({ ownerId, claims, persistedMessageId, messageRevision: 1 });
    const fence = await service.fencePresentation({
      ownerId,
      claims,
      surface: 'web',
      persistedMessageId,
      messageRevision: 1,
    });
    const presentation = {
      ownerId,
      claims: fence.claims,
      surface: 'web',
      persistedMessageId,
      messageRevision: 1,
      presentationGeneration: fence.generation,
      presentationClaimToken: fence.claimToken,
      presentationLeaseToken: fence.presentationLeaseToken,
      presentationRef: `web:synthetic:${persistedMessageId}:1`,
    };
    return { settled: await service.markPresented(presentation), presentation };
  }

  test('a delivered follow-up and its parent record the ledger sent outcome, once', async () => {
    const { service } = services();
    await seedMessages('web');
    // Another owner's rows carry the same decision identity under their own message ids.
    await seedMessages('web', OTHER_OWNER, 'web-other');
    const { claimed } = await service.claimBatch(claimInput('web', 'web'));

    const { settled, presentation } = await persistAndPresentWeb(service, 'web', claimed);

    expect(settled.map((row) => row.status)).toEqual(['sent']);
    const [sentRow] = await service.listByParent({
      ownerId: 'owner-web',
      parentMessageId: 'answer-web',
    });
    for (const record of await decisions('web')) {
      expect(record).toMatchObject({
        result: 'persisted',
        deliveryStatus: 'sent',
        dropReason: '',
        persistedMessageId: 'follow-up-web',
        terminalAt: new Date(sentRow.sentAt).toISOString(),
      });
    }
    // Another owner's messages are never touched, whatever their decision references.
    for (const record of await decisions('web', OTHER_OWNER)) {
      expect(record).toMatchObject({ deliveryStatus: 'pending', terminalAt: '' });
    }
    // Repeating the identical, already-applied settlement leaves the recorded outcome unchanged.
    const before = await decisions('web');
    await expect(service.markPresented(presentation)).resolves.toEqual(settled);
    expect(await decisions('web')).toEqual(before);
  });

  test('a Telegram-required follow-up stays pending until its drop is recorded with the reason', async () => {
    const { service } = services();
    await seedMessages('telegram');
    const { claimed } = await service.claimBatch(claimInput('telegram', 'telegram'));

    const { settled: presentedWeb } = await persistAndPresentWeb(service, 'telegram', claimed);

    expect(presentedWeb.map((row) => [row.status, row.presentedSurfaces])).toEqual([
      ['claimed', ['web']],
    ]);
    for (const record of await decisions('telegram')) {
      expect(record).toMatchObject({ deliveryStatus: 'pending', terminalAt: '' });
    }

    const [live] = await Delivery.find({ parentMessageId: 'answer-telegram' }).lean();
    await service.markDropped({
      ownerId: 'owner-telegram',
      claims: [
        {
          deliveryId: live.deliveryId,
          claimToken: live.claimToken,
          claimGeneration: live.claimGeneration,
        },
      ],
      dropReason: 'conversation_moved_on',
    });

    const [droppedRow] = await service.listByParent({
      ownerId: 'owner-telegram',
      parentMessageId: 'answer-telegram',
    });
    expect(droppedRow.status).toBe('dropped');
    for (const record of await decisions('telegram')) {
      expect(record).toMatchObject({
        result: 'persisted',
        deliveryStatus: 'dropped',
        dropReason: 'conversation_moved_on',
        terminalAt: new Date(droppedRow.droppedAt).toISOString(),
      });
    }
  });

  test('S0215 route: web presented, handed to the Telegram dispatcher, acknowledged, recorded sent', async () => {
    const { service } = services();
    await seedMessages('handover');
    const ownerId = 'owner-handover';
    const parentMessageId = 'answer-handover';
    const persistedMessageId = 'follow-up-handover';
    const { claimed } = await service.claimBatch(claimInput('handover', 'telegram'));
    await persistAndPresentWeb(service, 'handover', claimed);

    // No live subscriber held the presentation lease: the owner hands the rest to the dispatcher.
    const [held] = await Delivery.find({ parentMessageId }).lean();
    await service.markFailed({
      ownerId,
      claims: [
        {
          deliveryId: held.deliveryId,
          claimToken: held.claimToken,
          claimGeneration: held.claimGeneration,
        },
      ],
      reason: 'presentation_failed',
    });
    const [pending] = await service.listByParent({ ownerId, parentMessageId });
    expect([pending.status, pending.presentedSurfaces]).toEqual(['pending', ['web']]);

    // The durable dispatcher claims Telegram, fences it, and the bot's authorized ack settles it.
    const recovered = await service.claimPendingByParent({
      ownerId,
      parentMessageId,
      surface: 'telegram',
    });
    expect(recovered.claimed).toHaveLength(1);
    const fence = await service.fencePresentation({
      ownerId,
      claims: recovered.claimed,
      surface: 'telegram',
      persistedMessageId,
      messageRevision: 1,
    });
    const acknowledged = await service.markPresentationByParent({
      ownerId,
      parentMessageId,
      surface: 'telegram',
      persistedMessageId,
      messageRevision: 1,
      presentationGeneration: fence.generation,
      presentationClaimToken: fence.claimToken,
      presentationRef: 'telegram:chat-synthetic:message-synthetic',
      expectedDeliveryIds: [held.deliveryId],
      expectedPresentationLeaseToken: fence.presentationLeaseToken,
    });

    expect(acknowledged.map((row) => [row.status, [...row.presentedSurfaces].sort()])).toEqual([
      ['sent', ['telegram', 'web']],
    ]);
    const [sentRow] = await service.listByParent({ ownerId, parentMessageId });
    for (const record of await decisions('handover')) {
      expect(record).toMatchObject({
        deliveryStatus: 'sent',
        terminalAt: new Date(sentRow.sentAt).toISOString(),
      });
    }
  });

  test('an interrupted reflection converges from the settled ledger without presenting again', async () => {
    const { base } = services();
    await seedMessages('crash');
    await seedMessages('owed');
    // The settlement commits, then the process stops before its metadata reflection runs.
    const crashed = await base.claimBatch(claimInput('crash', 'web'));
    await persistAndPresentWeb(base, 'crash', crashed.claimed);
    // Telegram is still owed here, so this follow-up is not terminal and must stay pending.
    const owed = await base.claimBatch(claimInput('owed', 'telegram'));
    await persistAndPresentWeb(base, 'owed', owed.claimed);
    const ledgerBefore = await Delivery.find({}).sort({ deliveryId: 1 }).lean();

    const cursors = new Map();
    const reconcile = () =>
      reconcileFollowUpTerminalOutcomes({
        service: base,
        DeliveryModel: Delivery,
        MessageModel: Message,
        cursors,
      });
    const first = await reconcile();
    const second = await reconcile();

    const [sentRow] = await base.listByParent({
      ownerId: 'owner-crash',
      parentMessageId: 'answer-crash',
    });
    for (const record of await decisions('crash')) {
      expect(record).toMatchObject({
        deliveryStatus: 'sent',
        terminalAt: new Date(sentRow.sentAt).toISOString(),
      });
    }
    for (const record of await decisions('owed')) {
      expect(record).toMatchObject({ deliveryStatus: 'pending', terminalAt: '' });
    }
    expect(first).toEqual({ scanned: 1, reconciled: 2 });
    expect(second).toEqual({ scanned: 1, reconciled: 0 });
    // Reconciliation only reads the ledger: every delivery row is unchanged, nothing re-presented.
    expect(await Delivery.find({}).sort({ deliveryId: 1 }).lean()).toEqual(ledgerBefore);
  });

  test('an old unreflected batch is reached behind newer reflected ones, without raising the limit', async () => {
    const { base, service } = services();
    // The oldest ledger batch settles while its reflection is lost.
    await seedMessages('old');
    const old = await base.claimBatch(claimInput('old', 'web'));
    await persistAndPresentWeb(base, 'old', old.claimed);
    // Newer batches settle and reflect normally, filling any newest-first slice.
    for (const suffix of ['n1', 'n2', 'n3', 'n4', 'n5']) {
      await seedMessages(suffix);
      const batch = await service.claimBatch(claimInput(suffix, 'web'));
      await persistAndPresentWeb(service, suffix, batch.claimed);
    }
    const ledgerBefore = await Delivery.find({}).sort({ deliveryId: 1 }).lean();
    const cursors = new Map();
    const reconcile = () =>
      reconcileFollowUpTerminalOutcomes({
        service: base,
        DeliveryModel: Delivery,
        MessageModel: Message,
        limit: 2,
        cursors,
      });

    // Six terminal batches at two per tick: every batch is visited within three ticks.
    for (let tick = 0; tick < 3; tick += 1) await reconcile();

    for (const record of await decisions('old')) {
      expect(record).toMatchObject({ deliveryStatus: 'sent' });
    }
    expect(await Delivery.find({}).sort({ deliveryId: 1 }).lean()).toEqual(ledgerBefore);
  });

  test('a reflection interrupted after the follow-up write recovers the pending parent', async () => {
    const { base } = services();
    await seedMessages('partial');
    const batch = await base.claimBatch(claimInput('partial', 'web'));
    await persistAndPresentWeb(base, 'partial', batch.claimed);
    // Only the follow-up half of the two-document reflection landed.
    await Message.updateOne(
      { messageId: 'follow-up-partial' },
      {
        $set: {
          'metadata.viventium.cortexFollowUpDecision.deliveryStatus': 'sent',
          'metadata.viventium.cortexFollowUpDecision.terminalAt': '2026-09-29T00:00:00.000Z',
        },
      },
    );

    const result = await reconcileFollowUpTerminalOutcomes({
      service: base,
      DeliveryModel: Delivery,
      MessageModel: Message,
      cursors: new Map(),
    });

    const byId = Object.fromEntries(
      (await decisions('partial')).map((record) => [record.messageId, record]),
    );
    expect(byId['answer-partial']).toMatchObject({ deliveryStatus: 'sent' });
    // The already-recorded follow-up is left exactly as it was.
    expect(byId['follow-up-partial']).toMatchObject({
      deliveryStatus: 'sent',
      terminalAt: '2026-09-29T00:00:00.000Z',
    });
    expect(result).toEqual({ scanned: 1, reconciled: 1 });
  });

  test('the unreflected ledger leaves delivered follow-up metadata pending (S0215 shape)', async () => {
    const { base } = services();
    await seedMessages('legacy');
    const { claimed } = await base.claimBatch(claimInput('legacy', 'web'));

    const { settled } = await persistAndPresentWeb(base, 'legacy', claimed);

    expect(settled.map((row) => row.status)).toEqual(['sent']);
    for (const record of await decisions('legacy')) {
      expect(record).toMatchObject({ deliveryStatus: 'pending', terminalAt: '' });
    }
  });

  describe('a delivery whose parent answer no longer exists', () => {
    const ownerId = 'owner-orphan';
    const parentMessageId = 'answer-orphan';
    let currentTime;

    /** A persisted follow-up whose parent answer row is gone, claimed by a runtime that exited. */
    async function seedOrphan() {
      await seedMessages('orphan');
      await Message.deleteOne({ user: ownerId, messageId: parentMessageId });
      const exited = createCortexInsightDeliveryService({
        DeliveryModel: Delivery,
        runtimeSlot: 'slot-live',
        runtimeEpoch: 'boot-exited',
      });
      const { claimed } = await exited.claimBatch(claimInput('orphan', 'web'));
      await exited.markPersisted({
        ownerId,
        claims: claimed,
        persistedMessageId: 'follow-up-orphan',
        messageRevision: 1,
      });
      currentTime = new Date();
      const restarted = createCortexInsightDeliveryService({
        DeliveryModel: Delivery,
        now: () => currentTime,
        runtimeSlot: 'slot-live',
        runtimeEpoch: 'boot-restarted',
      });
      return withFollowUpTerminalOutcome(restarted, { MessageModel: Message });
    }

    /** One real recovery tick; the parent loader runs the production query on this database. */
    function tick(deliveryService, orphanedBefore) {
      currentTime = new Date(currentTime.getTime() + 61_000);
      return recoverPendingCortexInsightDeliveries({
        deliveryService,
        deliveryModel: Delivery,
        orphanedBefore,
        replayMessageFallbacks: async () => ({ scanned: 0, replayed: 0, pending: 0 }),
        replayOutbox: async () => ({ scanned: 0, replayed: 0, pending: 0 }),
        hasDurableTelegramDispatchAuthority: async () => false,
        loadParentState: ({ ownerId: user, conversationId, parentMessageId: messageId }) =>
          Message.findOne({ user, conversationId, messageId, isCreatedByUser: { $ne: true } })
            .select('messageId unfinished')
            .lean(),
      });
    }

    async function ledgerRow() {
      return Delivery.findOne({ userId: ownerId, parentMessageId }).select('+events').lean();
    }

    test('settles dropped once every recovery attempt is used, and stops growing its history', async () => {
      const deliveryService = await seedOrphan();
      const orphanedBefore = new Date(Date.now() + 60_000);

      // Every attempt the ledger allows is still a deferral: nothing is settled early.
      for (let attempt = 1; attempt <= 16; attempt += 1) {
        const summary = await tick(deliveryService, orphanedBefore);
        expect(summary).toMatchObject({ scanned: 1, pending: 1, dropped: 0 });
        const row = await ledgerRow();
        expect([row.status, row.recoveryAttemptNumber]).toEqual(['claimed', attempt]);
      }
      for (const record of await decisions('orphan')) {
        expect(record).toMatchObject({ deliveryStatus: 'pending', terminalAt: '' });
      }

      const settled = await tick(deliveryService, orphanedBefore);

      expect(settled).toMatchObject({ scanned: 1, pending: 0, dropped: 1, presented: 0 });
      const row = await ledgerRow();
      expect(row).toMatchObject({ status: 'dropped', dropReason: 'delivery_attempts_exhausted' });
      expect(row.presentedSurfaces).toEqual([]);
      // The surviving follow-up records the exact outcome; nothing was presented or resent.
      const [followUp] = await decisions('orphan');
      expect(followUp).toMatchObject({
        messageId: 'follow-up-orphan',
        deliveryStatus: 'dropped',
        dropReason: 'delivery_attempts_exhausted',
        terminalAt: new Date(row.droppedAt).toISOString(),
      });
      // A settled parent is no longer recoverable: later ticks append nothing.
      const events = row.events.length;
      await expect(tick(deliveryService, orphanedBefore)).resolves.toMatchObject({ scanned: 0 });
      expect((await ledgerRow()).events).toHaveLength(events);
    });

    test('work newer than the stale cutoff keeps deferring even with every attempt used', async () => {
      const deliveryService = await seedOrphan();
      await Delivery.updateMany({ userId: ownerId }, { $set: { recoveryAttemptNumber: 16 } });

      const summary = await tick(deliveryService, new Date(Date.now() - 3_660_000));

      expect(summary).toMatchObject({ scanned: 1, pending: 1, dropped: 0 });
      expect(await ledgerRow()).toMatchObject({ status: 'claimed', recoveryAttemptNumber: 16 });
      for (const record of await decisions('orphan')) {
        expect(record).toMatchObject({ deliveryStatus: 'pending' });
      }
    });
  });
});
