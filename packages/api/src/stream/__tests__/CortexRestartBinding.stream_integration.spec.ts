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

async function configuredManager() {
  const manager = new GenerationJobManagerClass({
    jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
    eventTransport: new InMemoryEventTransport(),
  });
  await manager.initialize();
  await manager.createJob('stream-restart', 'owner-a', 'conversation-a');
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
});
