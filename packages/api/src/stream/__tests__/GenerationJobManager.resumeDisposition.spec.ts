import { GenerationJobManagerClass } from '../GenerationJobManager';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { createContentAggregator, GraphEvents } from '@librechat/agents';
import { retainAggregatedDeliveryDisposition } from '../../channels/deliveryDisposition';
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

describe('in-memory mixed audio resume', () => {
  it.each([
    ['eligible', 'skip'],
    ['skip', 'eligible'],
  ] as const)('retains %s then %s before and after completion', async (first, second) => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });
    await manager.initialize();
    try {
      await manager.createJob('mixed-memory', 'synthetic-owner', 'synthetic-conversation');
      const native = createContentAggregator();
      native.aggregateContent({
        event: GraphEvents.ON_RUN_STEP,
        data: { id: 'main', index: 0, agentId: 'main', stepDetails: { type: 'message_creation' } },
      });
      manager.setContentParts('mixed-memory', native.contentParts);
      const decision = (audio: string) => ({
        version: 1,
        audio,
        required: true,
        valid: true,
        source: 'model',
      });
      for (const [index, audio] of [first, second].entries()) {
        const event = {
          event: GraphEvents.ON_MESSAGE_DELTA,
          data: {
            id: 'main',
            delta: {
              content: [{ type: 'text', text: index ? 'Result.' : 'Update. ' }],
              metadata: { viventium: { deliveryDisposition: decision(audio) } },
            },
          },
        };
        const before = native.contentParts.slice();
        native.aggregateContent(event);
        retainAggregatedDeliveryDisposition(native.contentParts, before, event);
      }
      const running = await manager.getResumeState('mixed-memory');
      expect(running?.aggregatedContent).toEqual([
        {
          type: 'text',
          agentId: 'main',
          text: 'Update. Result.',
          deliveryDispositionRanges: [
            { start: 0, end: 8, disposition: decision(first) },
            { start: 8, end: 15, disposition: decision(second) },
          ],
        },
      ]);
      expect(running).not.toHaveProperty('finalEvent');
      const final = {
        final: true,
        responseMessage: {
          content: native.contentParts,
          metadata: { viventium: { deliveryDisposition: decision(second) } },
        },
      };
      await store.updateJob('mixed-memory', {
        status: 'complete',
        finalEvent: JSON.stringify(final),
      });
      const completed = await manager.getResumeState('mixed-memory');
      expect(completed?.aggregatedContent).toEqual(running?.aggregatedContent);
      expect(completed?.finalEvent).toEqual(final);
    } finally {
      await manager.destroy();
    }
  });
});
