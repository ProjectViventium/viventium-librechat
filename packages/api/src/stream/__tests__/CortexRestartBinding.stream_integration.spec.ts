import { GenerationJobManagerClass } from '../GenerationJobManager';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';

const graphResultHash = 'a'.repeat(64);

function receipt({
  ownerId = 'owner-a',
  generation = 2,
  hash = graphResultHash,
}: {
  ownerId?: string;
  generation?: number;
  hash?: string;
} = {}) {
  return {
    ownerId,
    messageId: 'follow-up-a',
    parentMessageId: 'parent-a',
    revision: 1,
    generation,
    deliveryIds: ['cidl_pending'],
    deliveryReceipts: [{ deliveryId: 'cidl_pending', graphResultHash: hash }],
    claimToken: `claim-${generation}`,
    presentationLeaseToken: `lease-${generation}`,
  };
}

async function configuredManager(
  jobStore: InMemoryJobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
) {
  const manager = new GenerationJobManagerClass({
    jobStore,
    eventTransport: new InMemoryEventTransport(),
  });
  await manager.initialize();
  await manager.createJob('stream-restart', 'owner-a', 'conversation-a', {
    interactionContext: {
      actor_kind: 'external_user',
      origin: 'interactive',
      surface: 'telegram',
      conversation_id: 'conversation-a',
      revision: 1,
      source_event_id: 'source-restart',
    },
    deliveryPolicy: { commit_authority: 'external_adapter' },
  });
  await manager.updateMetadata('stream-restart', { responseMessageId: 'parent-a' });
  return manager;
}

describe('Cortex restart claim binding', () => {
  test('stores a fresh claim generation and graph-result receipt idempotently', async () => {
    const manager = await configuredManager();
    const first = await manager.bindCortexPresentation('stream-restart', receipt());
    const replay = await manager.bindCortexPresentation('stream-restart', receipt());

    expect(first).toEqual(
      expect.objectContaining({
        generation: 2,
        claimToken: 'claim-2',
        deliveryReceipts: [{ deliveryId: 'cidl_pending', graphResultHash }],
        boundAt: expect.any(Number),
      }),
    );
    expect(replay).toEqual(first);
    await expect(manager.getJob('stream-restart')).resolves.toMatchObject({
      metadata: { cortexPresentation: first },
    });
    await manager.destroy();
  });

  test('rejects a stale claim generation without changing the current binding', async () => {
    const manager = await configuredManager();
    const current = await manager.bindCortexPresentation('stream-restart', receipt());

    await expect(
      manager.bindCortexPresentation('stream-restart', receipt({ generation: 1 })),
    ).resolves.toBeNull();
    await expect(manager.getJob('stream-restart')).resolves.toMatchObject({
      metadata: { cortexPresentation: current },
    });
    await manager.destroy();
  });

  test('rejects a changed graph-result hash for the same claim generation', async () => {
    const manager = await configuredManager();
    const current = await manager.bindCortexPresentation('stream-restart', receipt());

    await expect(
      manager.bindCortexPresentation('stream-restart', receipt({ hash: 'b'.repeat(64) })),
    ).resolves.toBeNull();
    await expect(manager.getJob('stream-restart')).resolves.toMatchObject({
      metadata: { cortexPresentation: current },
    });
    await manager.destroy();
  });

  test('rejects a binding owned by another user', async () => {
    const manager = await configuredManager();

    await expect(
      manager.bindCortexPresentation('stream-restart', receipt({ ownerId: 'owner-b' })),
    ).resolves.toBeNull();
    await expect(manager.getJob('stream-restart')).resolves.toMatchObject({
      metadata: { cortexPresentation: undefined },
    });
    await manager.destroy();
  });

  test('atomically carries the server-bound presentation through adapter acknowledgement', async () => {
    const manager = await configuredManager();
    const job = await manager.getJob('stream-restart');
    const boundPresentation = await manager.bindCortexPresentation('stream-restart', receipt());
    const acknowledgement = {
      logical_turn_id: job!.metadata.interactionContext!.logical_turn_id!,
      revision: 1,
      state: 'committed' as const,
      presentation_ref: 'telegram:synthetic-chat:synthetic-message',
    };

    const first = await manager.acknowledgeDelivery(acknowledgement, 'telegram', receipt());
    const replay = await manager.acknowledgeDelivery(acknowledgement, 'telegram', receipt());

    expect(first).toMatchObject({
      status: 'recorded',
      idempotent: false,
      acknowledgement,
      presentation: {
        userId: 'owner-a',
        responseMessageId: 'parent-a',
        cortexPresentation: {
          ownerId: 'owner-a',
          messageId: 'follow-up-a',
          parentMessageId: 'parent-a',
          generation: 2,
          deliveryReceipts: [{ deliveryId: 'cidl_pending', graphResultHash }],
          boundAt: expect.any(Number),
        },
      },
    });
    expect(first.presentation!.cortexPresentation).toEqual(boundPresentation);
    expect(replay).toMatchObject({
      status: 'recorded',
      idempotent: true,
      presentation: { cortexPresentation: first.presentation!.cortexPresentation },
    });
    await expect(manager.getJob('stream-restart')).resolves.toMatchObject({
      metadata: {
        deliveryAcknowledgement: expect.objectContaining(acknowledgement),
        cortexPresentation: first.presentation!.cortexPresentation,
      },
    });
    await manager.destroy();
  });

  test('does not record the adapter acknowledgement when the Cortex owner fence is invalid', async () => {
    const manager = await configuredManager();
    const job = await manager.getJob('stream-restart');
    const boundPresentation = await manager.bindCortexPresentation('stream-restart', receipt());

    await expect(
      manager.acknowledgeDelivery(
        {
          logical_turn_id: job!.metadata.interactionContext!.logical_turn_id!,
          revision: 1,
          state: 'committed',
        },
        'telegram',
        receipt({ generation: 3, hash: 'b'.repeat(64) }),
      ),
    ).resolves.toEqual({ status: 'retryable_conflict' });
    await expect(manager.getJob('stream-restart')).resolves.toMatchObject({
      metadata: {
        deliveryAcknowledgement: undefined,
        cortexPresentation: boundPresentation,
      },
    });
    await manager.destroy();
  });

  test('does not poison the logical acknowledgement when the Cortex fence advances concurrently', async () => {
    class AdvancingFenceStore extends InMemoryJobStore {
      nextBinding: Parameters<InMemoryJobStore['bindCortexPresentation']>[1] | null = null;

      override async bindDeliveryAcknowledgement(
        ...args: Parameters<InMemoryJobStore['bindDeliveryAcknowledgement']>
      ) {
        if (this.nextBinding) {
          const nextBinding = this.nextBinding;
          this.nextBinding = null;
          await super.bindCortexPresentation(args[0], nextBinding);
        }
        return super.bindDeliveryAcknowledgement(...args);
      }
    }

    const store = new AdvancingFenceStore({ ttlAfterComplete: 60_000 });
    const manager = await configuredManager(store);
    const job = await manager.getJob('stream-restart');
    const firstBinding = await manager.bindCortexPresentation('stream-restart', receipt());
    store.nextBinding = {
      ...receipt({ generation: 3, hash: 'b'.repeat(64) }),
      boundAt: firstBinding!.boundAt + 1,
    };
    const firstAcknowledgement = {
      logical_turn_id: job!.metadata.interactionContext!.logical_turn_id!,
      revision: 1,
      state: 'committed' as const,
      presentation_ref: 'telegram:synthetic-chat:first-message',
    };

    await expect(
      manager.acknowledgeDelivery(firstAcknowledgement, 'telegram', receipt()),
    ).resolves.toEqual({ status: 'retryable_conflict' });

    const currentReceipt = receipt({ generation: 3, hash: 'b'.repeat(64) });
    const currentAcknowledgement = {
      ...firstAcknowledgement,
      presentation_ref: 'telegram:synthetic-chat:current-message',
    };
    await expect(
      manager.acknowledgeDelivery(currentAcknowledgement, 'telegram', currentReceipt),
    ).resolves.toMatchObject({
      status: 'recorded',
      idempotent: false,
      acknowledgement: expect.objectContaining(currentAcknowledgement),
      presentation: {
        cortexPresentation: expect.objectContaining({ generation: 3 }),
      },
    });
    await manager.destroy();
  });
});
