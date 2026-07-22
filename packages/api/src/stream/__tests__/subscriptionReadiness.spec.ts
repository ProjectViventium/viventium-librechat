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

/* === VIVENTIUM START ===
 * Purpose: Model abort readiness, failure rollback, teardown ordering, and the
 * startup-only reconfiguration boundary without external Redis dependencies.
 */
class DeferredAbortTransport extends InMemoryEventTransport {
  private acknowledgeAbort: (() => void) | undefined;
  private readonly abortReadiness = new Promise<void>((resolve) => {
    this.acknowledgeAbort = resolve;
  });

  onAbort(): Promise<void> {
    return this.abortReadiness;
  }

  markAbortReady(): void {
    this.acknowledgeAbort?.();
  }
}

class FailedAbortTransport extends InMemoryEventTransport {
  onAbort(): Promise<void> {
    return Promise.reject(new Error('synthetic abort subscription failure'));
  }
}

class DeferredDestroyTransport extends InMemoryEventTransport {
  private finishDestroy: (() => void) | undefined;

  destroy(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.finishDestroy = () => {
        super.destroy();
        resolve();
      };
    });
  }

  markDestroyed(): void {
    this.finishDestroy?.();
  }
}

class FailedDestroyJobStore extends InMemoryJobStore {
  destroy(): Promise<void> {
    return Promise.reject(new Error('synthetic job-store teardown failure'));
  }
}

class TrackingDestroyTransport extends InMemoryEventTransport {
  destroyed = false;

  destroy(): void {
    this.destroyed = true;
    super.destroy();
  }
}

class DeferredCreateJobStore extends InMemoryJobStore {
  private releaseCreate: (() => void) | undefined;
  private markStarted: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  async createJob(...args: Parameters<InMemoryJobStore['createJob']>) {
    this.markStarted?.();
    await new Promise<void>((resolve) => {
      this.releaseCreate = resolve;
    });
    return super.createJob(...args);
  }

  release(): void {
    this.releaseCreate?.();
  }
}

class DeferredGetJobStore extends InMemoryJobStore {
  private releaseLookup: (() => void) | undefined;
  private markStarted: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  async getJob(...args: Parameters<InMemoryJobStore['getJob']>) {
    const result = await super.getJob(...args);
    this.markStarted?.();
    await new Promise<void>((resolve) => {
      this.releaseLookup = resolve;
    });
    return result;
  }

  release(): void {
    this.releaseLookup?.();
  }
}
/* === VIVENTIUM END === */

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

  /* === VIVENTIUM START ===
   * Purpose: Guard abort readiness, rollback, teardown, and reconfiguration
   * failure paths introduced by the Redis lifecycle boundary.
   */
  test('does not report a job as created until its abort listener is live', async () => {
    const transport = new DeferredAbortTransport();
    const manager = new GenerationJobManagerClass({
      eventTransport: transport,
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      cleanupOnComplete: false,
    });

    let created = false;
    const job = manager.createJob('abort-readiness', 'synthetic-user').then((value) => {
      created = true;
      return value;
    });

    await Promise.resolve();
    expect(created).toBe(false);

    transport.markAbortReady();
    await expect(job).resolves.toMatchObject({ streamId: 'abort-readiness' });
    expect(created).toBe(true);
    await manager.destroy();
  });

  test('rolls back job state when the abort listener cannot become live', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass({
      eventTransport: new FailedAbortTransport(),
      jobStore,
      cleanupOnComplete: false,
    });

    await expect(manager.createJob('abort-failure', 'synthetic-user')).rejects.toThrow(
      'synthetic abort subscription failure',
    );
    await expect(jobStore.hasJob('abort-failure')).resolves.toBe(false);
    await manager.destroy();
  });

  test('waits for event transport teardown before manager destruction completes', async () => {
    const transport = new DeferredDestroyTransport();
    const manager = new GenerationJobManagerClass({
      eventTransport: transport,
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      cleanupOnComplete: false,
    });

    let destroyed = false;
    const destruction = manager.destroy().then(() => {
      destroyed = true;
    });

    await Promise.resolve();
    expect(destroyed).toBe(false);

    transport.markDestroyed();
    await destruction;
    expect(destroyed).toBe(true);
  });

  test('still tears down the event transport when job-store teardown fails', async () => {
    const transport = new TrackingDestroyTransport();
    const manager = new GenerationJobManagerClass({
      eventTransport: transport,
      jobStore: new FailedDestroyJobStore({ ttlAfterComplete: 60_000 }),
      cleanupOnComplete: false,
    });

    await expect(manager.destroy()).rejects.toThrow('synthetic job-store teardown failure');
    expect(transport.destroyed).toBe(true);
  });

  test('fails closed when reconfiguration is attempted after initialization', async () => {
    const manager = new GenerationJobManagerClass();
    manager.initialize();

    expect(() =>
      manager.configure({
        eventTransport: new InMemoryEventTransport(),
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      }),
    ).toThrow('Destroy the active manager before reconfiguring services');

    await manager.destroy();
  });

  test('fails closed while uninitialized asynchronous work is active', async () => {
    const transport = new DeferredAbortTransport();
    const manager = new GenerationJobManagerClass({
      eventTransport: transport,
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      cleanupOnComplete: false,
    });
    const job = manager.createJob('active-before-initialize', 'synthetic-user');

    expect(() =>
      manager.configure({
        eventTransport: new InMemoryEventTransport(),
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      }),
    ).toThrow('Destroy the active manager before reconfiguring services');

    transport.markAbortReady();
    await job;
    await manager.destroy();
  });

  test('rejects reconfiguration during teardown and permits it after teardown settles', async () => {
    const transport = new DeferredDestroyTransport();
    const manager = new GenerationJobManagerClass({
      eventTransport: transport,
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      cleanupOnComplete: false,
    });
    const destruction = manager.destroy();

    expect(() =>
      manager.configure({
        eventTransport: new InMemoryEventTransport(),
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      }),
    ).toThrow('Destroy the active manager before reconfiguring services');

    transport.markDestroyed();
    await destruction;

    expect(() =>
      manager.configure({
        eventTransport: new InMemoryEventTransport(),
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      }),
    ).not.toThrow();
    await manager.destroy();
  });

  test('rejects an old deferred operation that resumes after teardown and reconfiguration', async () => {
    const oldStore = new DeferredCreateJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass({
      eventTransport: new InMemoryEventTransport(),
      jobStore: oldStore,
      cleanupOnComplete: false,
    });
    const oldOperation = manager.createJob('old-generation', 'synthetic-user');
    await oldStore.started;

    await manager.destroy();

    const replacementStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const replacementTransport = new InMemoryEventTransport();
    const onAllSubscribersLeft = jest.spyOn(replacementTransport, 'onAllSubscribersLeft');
    manager.configure({
      eventTransport: replacementTransport,
      jobStore: replacementStore,
      cleanupOnComplete: false,
    });

    oldStore.release();
    await expect(oldOperation).rejects.toThrow('service generation changed');
    expect(onAllSubscribersLeft).not.toHaveBeenCalled();
    await expect(replacementStore.hasJob('old-generation')).resolves.toBe(false);
    await manager.destroy();
  });

  test('rejects an old lazy lookup before it can attach to replacement services', async () => {
    const oldStore = new DeferredGetJobStore({ ttlAfterComplete: 60_000 });
    await oldStore.createJob('old-lookup', 'synthetic-user');
    const manager = new GenerationJobManagerClass({
      eventTransport: new InMemoryEventTransport(),
      jobStore: oldStore,
      cleanupOnComplete: false,
    });
    const oldLookup = manager.getJob('old-lookup');
    await oldStore.started;

    await manager.destroy();

    const replacementStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    await replacementStore.createJob('old-lookup', 'replacement-synthetic-user');
    const replacementTransport = new InMemoryEventTransport();
    const onAllSubscribersLeft = jest.spyOn(replacementTransport, 'onAllSubscribersLeft');
    manager.configure({
      eventTransport: replacementTransport,
      jobStore: replacementStore,
      cleanupOnComplete: false,
    });

    oldStore.release();
    await expect(oldLookup).rejects.toThrow('service generation changed');
    expect(onAllSubscribersLeft).not.toHaveBeenCalled();
    expect(manager.getRuntimeStats().runtimeStateCount).toBe(0);
    await manager.destroy();
  });

  /* === VIVENTIUM END === */
});
