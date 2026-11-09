import { GenerationJobManagerClass } from '../GenerationJobManager';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';

test('reconnection, stale identity, Stop and teardown cannot invent a live local producer', async () => {
  const manager = new GenerationJobManagerClass();
  const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
  manager.configure({ jobStore: store, eventTransport: new InMemoryEventTransport() });
  await manager.initialize();
  try {
    const job = await manager.createJob('live-stream', 'synthetic-owner', 'synthetic-conversation');
    expect(manager.hasLocalGenerationProducer('live-stream', job.createdAt)).toBe(true);
    expect(manager.hasLocalGenerationProducer('live-stream', job.createdAt + 1)).toBe(false);
    const orphan = await store.createJob('orphan', 'synthetic-owner', 'synthetic-conversation');
    await manager.getJob('orphan');
    expect(manager.hasLocalGenerationProducer('orphan', orphan.createdAt)).toBe(false);
    job.abortController.abort('user_cancelled');
    expect(manager.hasLocalGenerationProducer('live-stream', job.createdAt)).toBe(false);
  } finally {
    await manager.destroy();
  }
  expect(manager.hasLocalGenerationProducer('live-stream', 0)).toBe(false);
});
