import { GenerationJobManagerClass } from '../GenerationJobManager';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';

class DeferredReadyTransport extends InMemoryEventTransport {
  private acknowledge: (() => void) | undefined;
  private readonly readiness = new Promise<void>((resolve) => {
    this.acknowledge = resolve;
  });

  subscribe(...args: Parameters<InMemoryEventTransport['subscribe']>) {
    return {
      ...super.subscribe(...args),
      ready: this.readiness,
    };
  }

  markReady(): void {
    this.acknowledge?.();
  }
}

describe('GenerationJobManager subscription readiness', () => {
  test('does not expose a live subscription until the transport is ready', async () => {
    const transport = new DeferredReadyTransport();
    const manager = new GenerationJobManagerClass({
      eventTransport: transport,
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      cleanupOnComplete: false,
    });
    const streamId = 'subscription-readiness';
    await manager.createJob(streamId, 'synthetic-user');

    const received: unknown[] = [];
    let subscribed = false;
    const subscription = manager
      .subscribe(streamId, (event) => received.push(event))
      .then((value) => {
        subscribed = true;
        return value;
      });

    await Promise.resolve();
    expect(subscribed).toBe(false);

    await manager.emitChunk(streamId, { event: 'test', data: { index: 1 } });
    expect(received).toEqual([]);

    transport.markReady();
    const activeSubscription = await subscription;
    expect(subscribed).toBe(true);
    expect(received).toEqual([{ event: 'test', data: { index: 1 } }]);

    activeSubscription?.unsubscribe();
    await manager.destroy();
  });
});
