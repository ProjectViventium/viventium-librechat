import { GenerationJobManagerClass } from '../GenerationJobManager';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';

const receipt = () => ({
  ownerId: 'owner-a', messageId: 'followup-a', parentMessageId: 'parent-a',
  revision: 1, generation: 2, deliveryIds: ['delivery-a'],
  deliveryReceipts: [{ deliveryId: 'delivery-a', graphResultHash: 'a'.repeat(64) }],
  claimToken: 'claim-a', presentationLeaseToken: 'lease-a',
});
const event = () => ({ event: 'on_cortex_followup' as const, data: {
  messageId: 'followup-a', conversationId: 'conversation-a', text: 'An accepted result.',
} });

async function setup(redis = false) {
  const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
  const transport = new InMemoryEventTransport();
  const manager = new GenerationJobManagerClass();
  manager.configure({ jobStore: store, eventTransport: transport, isRedis: redis });
  await manager.initialize();
  await manager.createJob('stream-a', 'owner-a', 'conversation-a');
  await manager.updateMetadata('stream-a', { responseMessageId: 'parent-a' });
  return { manager, store, transport };
}

describe('completed Cortex bound emission', () => {
  test('requires actual subscriber acceptance; an empty transport is not a receipt', async () => {
    const { manager, transport } = await setup();
    const verifyPresentation = jest.fn(async () => receipt());
    try {
      await expect(manager.emitCortexPresentation('stream-a', event(), receipt(), {
        verifyPresentation,
      })).resolves.toMatchObject({ delivered: false });
      const onChunk = jest.fn();
      const subscription = transport.subscribe('stream-a', { onChunk });
      await expect(manager.emitCortexPresentation('stream-a', event(), receipt(), {
        verifyPresentation,
      })).resolves.toMatchObject({ delivered: true, target: 'subscriber_transport',
        claimToken: 'claim-a', presentationLeaseToken: 'lease-a' });
      expect(onChunk).toHaveBeenCalledTimes(1);
      expect(onChunk).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        cortexPresentation: receipt(), presentationGeneration: 2,
      }) }));
      subscription.unsubscribe();
    } finally { await manager.destroy(); }
  });

  test('publishes against retained ownership after foreground runtime cleanup', async () => {
    const { manager, store, transport } = await setup();
    const retained = await store.getJob('stream-a');
    await manager.destroy();
    const restartedStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    await restartedStore.createJob('stream-a', 'owner-a', 'conversation-a', { ...retained!, status: 'complete' });
    const restarted = new GenerationJobManagerClass({ jobStore: restartedStore, eventTransport: transport });
    await restarted.initialize();
    const onChunk = jest.fn();
    transport.subscribe('stream-a', { onChunk });
    try {
      await expect(restarted.emitCortexPresentation('stream-a', event(), receipt(), {
        verifyPresentation: async () => receipt(),
      })).resolves.toMatchObject({ delivered: true, target: 'subscriber_transport' });
      expect(onChunk).toHaveBeenCalledTimes(1);
    } finally { await restarted.destroy(); }
  });

  test.each(['owner', 'message', 'conversation', 'claim', 'stopped'])(
    'rejects mismatched %s before a subscriber sees text', async (mismatch) => {
      const { manager, store, transport } = await setup();
      const onChunk = jest.fn(); transport.subscribe('stream-a', { onChunk });
      const supplied = receipt(); const message = event();
      if (mismatch === 'owner') supplied.ownerId = 'other-owner';
      if (mismatch === 'message') message.data.messageId = 'other-message';
      if (mismatch === 'conversation') message.data.conversationId = 'other-conversation';
      if (mismatch === 'stopped') await store.updateJob('stream-a', { status: 'aborted' });
      try {
        await expect(manager.emitCortexPresentation('stream-a', message, supplied, {
          verifyPresentation: async () => ({ ...receipt(),
            ...(mismatch === 'claim' ? { claimToken: 'different-claim' } : {}) }),
        })).resolves.toMatchObject({ delivered: false });
        expect(onChunk).not.toHaveBeenCalled();
      } finally { await manager.destroy(); }
    },
  );

  test.each([true, false])('does not confuse stored Redis bytes with subscriber presentation (%s)', async (acknowledged) => {
    const { manager, store, transport } = await setup(true);
    const append = jest.spyOn(store, 'appendChunk');
    if (!acknowledged) append.mockRejectedValue(new Error('synthetic replay failure'));
    const emit = jest.spyOn(transport, 'emitChunk');
    try {
      const result = await manager.emitCortexPresentation('stream-a', event(), receipt(), {
        verifyPresentation: async () => receipt(),
      });
      expect(result.delivered).toBe(false);
      expect(append.mock.invocationCallOrder[0]).toBeLessThan(emit.mock.invocationCallOrder[0]);
    } finally { await manager.destroy(); }
  });

  test('rejects a claim changed while replay storage was pending before publishing', async () => {
    const { manager, store, transport } = await setup(true);
    let current = receipt();
    jest.spyOn(store, 'appendChunk').mockImplementation(async () => {
      current = { ...current, claimToken: 'new-claim' };
    });
    const emit = jest.spyOn(transport, 'emitChunk');
    try {
      await expect(manager.emitCortexPresentation('stream-a', event(), receipt(), {
        verifyPresentation: async () => current,
      })).resolves.toMatchObject({ delivered: false });
      expect(emit).not.toHaveBeenCalled();
    } finally { await manager.destroy(); }
  });
});
