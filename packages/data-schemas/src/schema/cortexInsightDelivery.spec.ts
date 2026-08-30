import mongoose from 'mongoose';
import { createViventiumCortexInsightDeliveryModel } from '~/models/cortexInsightDelivery';

const database = new mongoose.Mongoose();
const Delivery = createViventiumCortexInsightDeliveryModel(database);

const base = {
  deliveryKey: 'cortex_insight:synthetic',
  deliveryId: 'cidl_synthetic',
  userId: 'owner-synthetic-1',
  conversationId: 'conversation-synthetic-1',
  parentMessageId: 'parent-synthetic-1',
  cortexId: 'review',
  insight: 'A private completed synthetic insight.',
  insightHash: 'a'.repeat(64),
  graphResultHash: 'b'.repeat(64),
  surface: 'web',
};

describe('ViventiumCortexInsightDelivery model', () => {
  test('keeps private payloads excluded and terminal TTL limited to closed rows', () => {
    expect(Delivery.schema.path('insight').options.select).toBe(false);
    expect(Delivery.schema.path('feelingSnapshot').options.select).toBe(false);
    expect(Delivery.schema.path('events').options.select).toBe(false);
    expect(Delivery.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { expiresAt: 1 },
          expect.objectContaining({
            expireAfterSeconds: 0,
            partialFilterExpression: { status: { $in: ['sent', 'dropped'] } },
          }),
        ],
      ]),
    );
  });

  test('accepts pending delivery without expiry and preserves strict feeling receipts', async () => {
    const capsule = '  Synthetic exact capsule.\n';
    const document = new Delivery({
      ...base,
      feelingSnapshot: {
        available: true,
        enabled: true,
        agentScope: 'all_agents',
        version: 1,
        asOf: '2026-08-30T12:00:00.000Z',
        capsule,
        snapshotHash: 'c'.repeat(64),
        rangePromptOverrideCount: 0,
        activeRangePromptOverrideCount: 0,
        activeRangePromptOverrideChars: 0,
      },
    });

    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.status).toBe('pending');
    expect(document.expiresAt).toBeNull();
    expect(document.feelingSnapshot?.capsule).toBe(capsule);
  });

  test('rejects unproven sent or dropped terminal rows', async () => {
    await expect(
      new Delivery({
        ...base,
        status: 'sent',
        persistenceStatus: 'persisted',
        persistedMessageId: 'message-synthetic-1',
        persistedAt: new Date('2026-08-30T12:00:00.000Z'),
        requiredSurfaces: ['web'],
        sentAt: new Date('2026-08-30T12:00:01.000Z'),
        expiresAt: new Date('2026-09-30T12:00:01.000Z'),
      }).validate(),
    ).rejects.toThrow('presentationReceiptHashes');
    await expect(
      new Delivery({
        ...base,
        status: 'dropped',
        droppedAt: new Date('2026-08-30T12:00:00.000Z'),
        expiresAt: new Date('2026-09-30T12:00:00.000Z'),
      }).validate(),
    ).rejects.toThrow('dropReason');
  });
});
