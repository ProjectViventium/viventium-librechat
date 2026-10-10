import { GenerationJobManagerClass } from '../GenerationJobManager';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';

describe('owning Stop acknowledgment fences', () => {
  async function subject(cleanupOnComplete: boolean) {
    const manager = new GenerationJobManagerClass();
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const transport = new InMemoryEventTransport();
    manager.configure({ jobStore: store, eventTransport: transport, cleanupOnComplete });
    await manager.initialize();
    const job = await manager.createJob('stop-stream', 'stop-owner', 'stop-conversation', {
      interactionContext: {
        actor_kind: 'external_user',
        origin: 'interactive',
        surface: 'web',
        conversation_id: 'stop-conversation',
        revision: 1,
        source_event_id: 'stop-source',
      },
    });
    await manager.updateMetadata('stop-stream', { responseMessageId: 'old-response' });
    let release!: () => void;
    let started!: () => void;
    const acknowledgment = new Promise<{ delivered: boolean }>((resolve) => {
      release = () => resolve({ delivered: false });
    });
    const deliveryStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    job.abortController.signal.addEventListener(
      'abort',
      () => {
        Object.defineProperty(job.abortController.signal, '_viventiumHarnessCancellationDelivery', {
          value: acknowledgment,
        });
        started();
      },
      { once: true },
    );
    return { manager, store, transport, job, release, deliveryStarted };
  }

  it.each([false, true])(
    'preserves a successor admitted during acknowledgment (cleanup=%s)',
    async (cleanup) => {
      const s = await subject(cleanup);
      try {
        const stop = s.manager.abortJob('stop-stream', 'user_cancelled', 'stop-owner');
        await s.deliveryStarted;
        const successor = await s.manager.createJob(
          'stop-stream',
          'stop-owner',
          'stop-conversation',
        );
        await s.manager.updateMetadata('stop-stream', { responseMessageId: 'new-response' });
        s.manager.setContentParts('stop-stream', [{ type: 'text', text: 'Successor content.' }]);
        const expectedJob = await s.store.getJob('stop-stream');
        const done = jest.spyOn(s.transport, 'emitDone');
        const clear = jest.spyOn(s.store, 'clearContentState');
        const complete = jest.spyOn(s.store, 'completeLogicalTurn');
        const remove = jest.spyOn(s.store, 'deleteJob');
        s.release();
        await expect(stop).resolves.toMatchObject({
          success: false,
          nativeResponse: 'unavailable',
        });
        expect(await s.store.getJob('stop-stream')).toEqual(expectedJob);
        expect((await s.store.getContentParts('stop-stream'))?.content).toEqual([
          { type: 'text', text: 'Successor content.' },
        ]);
        expect(successor.abortController.signal.aborted).toBe(false);
        expect((await s.manager.getJob('stop-stream'))?.abortController).toBe(
          successor.abortController,
        );
        expect(done).not.toHaveBeenCalled();
        expect(clear).not.toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
      } finally {
        s.release();
        await s.manager.destroy();
      }
    },
  );

  it.each([false, true])(
    'still finishes the same owning request after acknowledgment (cleanup=%s)',
    async (cleanup) => {
      const s = await subject(cleanup);
      try {
        s.manager.setContentParts('stop-stream', [{ type: 'text', text: 'Owner content.' }]);
        const stop = s.manager.abortJob('stop-stream', 'user_cancelled', 'stop-owner');
        await s.deliveryStarted;
        s.release();
        await expect(stop).resolves.toMatchObject({ success: true, text: 'Owner content.' });
        if (cleanup) expect(await s.store.getJob('stop-stream')).toBeNull();
        else expect((await s.store.getJob('stop-stream'))?.status).toBe('aborted');
      } finally {
        s.release();
        await s.manager.destroy();
      }
    },
  );
});
