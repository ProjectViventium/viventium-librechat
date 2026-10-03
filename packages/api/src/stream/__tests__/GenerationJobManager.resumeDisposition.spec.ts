import { GenerationJobManagerClass } from '../GenerationJobManager';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';

describe('resume terminal delivery authority', () => {
  it.each(['eligible', 'skip'])(
    'retains the exact %s decision beside the aggregate',
    async (audio) => {
      const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore: store,
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
      });
      await manager.initialize();
      try {
        await manager.createJob('resume-delivery', 'synthetic-owner', 'synthetic-conversation');
        const disposition = { version: 1, audio, required: true, valid: true, source: 'model' };
        const finalEvent = {
          final: true,
          responseMessage: {
            text: 'The report is ready.',
            metadata: { viventium: { deliveryDisposition: disposition } },
          },
        };
        await store.updateJob('resume-delivery', { finalEvent: JSON.stringify(finalEvent) });
        const resumed = await manager.getResumeState('resume-delivery');
        expect(resumed?.finalEvent).toEqual(finalEvent);
      } finally {
        await manager.destroy();
      }
    },
  );

  it('omits a missing or malformed terminal event during a running turn', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });
    await manager.initialize();
    try {
      await manager.createJob('resume-running', 'synthetic-owner', 'synthetic-conversation');
      expect(await manager.getResumeState('resume-running')).not.toHaveProperty('finalEvent');
      await store.updateJob('resume-running', { finalEvent: '{broken' });
      expect(await manager.getResumeState('resume-running')).not.toHaveProperty('finalEvent');
    } finally {
      await manager.destroy();
    }
  });
});
