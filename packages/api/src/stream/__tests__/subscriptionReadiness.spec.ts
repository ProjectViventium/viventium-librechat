import { GenerationJobManagerClass } from '../GenerationJobManager';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';

class DeferredReadyTransport extends InMemoryEventTransport {
  private acknowledge: (() => void) | undefined;
  private markSubscribed: (() => void) | undefined;
  private readonly readiness = new Promise<void>((resolve) => {
    this.acknowledge = resolve;
  });

  readonly subscribed = new Promise<void>((resolve) => {
    this.markSubscribed = resolve;
  });

  subscribe(...args: Parameters<InMemoryEventTransport['subscribe']>) {
    this.markSubscribed?.();
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

class DeferredUpdateJobStore extends InMemoryJobStore {
  private releaseUpdate: (() => void) | undefined;
  private markStarted: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  async updateJob(...args: Parameters<InMemoryJobStore['updateJob']>) {
    this.markStarted?.();
    await new Promise<void>((resolve) => {
      this.releaseUpdate = resolve;
    });
    return super.updateJob(...args);
  }

  release(): void {
    this.releaseUpdate?.();
  }
}

class DeferredCleanupJobStore extends InMemoryJobStore {
  private releaseCleanup: (() => void) | undefined;
  private markStarted: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  async cleanup(): Promise<number> {
    this.markStarted?.();
    await new Promise<void>((resolve) => {
      this.releaseCleanup = resolve;
    });
    return 0;
  }

  release(): void {
    this.releaseCleanup?.();
  }
}

class DeferredHasJobStore extends InMemoryJobStore {
  private hasDeferred = false;
  private releaseLookup: (() => void) | undefined;
  private markStarted: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  async hasJob(...args: Parameters<InMemoryJobStore['hasJob']>) {
    const result = await super.hasJob(...args);
    if (this.hasDeferred) {
      return result;
    }
    this.hasDeferred = true;
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

class FailedUpdateJobStore extends InMemoryJobStore {
  updateJob(): Promise<void> {
    return Promise.reject(new Error('synthetic terminal persistence failure'));
  }
}

class DeferredTerminalTransport extends InMemoryEventTransport {
  private releaseDone: (() => void) | undefined;
  private markStarted: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  async emitDone(): Promise<void> {
    this.markStarted?.();
    await new Promise<void>((resolve) => {
      this.releaseDone = resolve;
    });
  }

  release(): void {
    this.releaseDone?.();
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

  test('cancels pending subscription readiness when its request closes', async () => {
    const transport = new DeferredReadyTransport();
    const manager = new GenerationJobManagerClass({
      eventTransport: transport,
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      cleanupOnComplete: false,
    });
    const streamId = 'closed-request-readiness';
    await manager.createJob(streamId, 'synthetic-user');
    const request = new AbortController();

    const pendingSubscription = manager.subscribe(
      streamId,
      () => undefined,
      undefined,
      undefined,
      request.signal,
    );
    await transport.subscribed;
    expect(transport.getSubscriberCount(streamId)).toBe(1);

    request.abort();
    await expect(pendingSubscription).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport.getSubscriberCount(streamId)).toBe(0);

    transport.markReady();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport.getSubscriberCount(streamId)).toBe(0);
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

  test('rejects an old abort before it can affect a replacement same-stream job', async () => {
    const streamId = 'stale-abort';
    const oldStore = new DeferredGetJobStore({ ttlAfterComplete: 60_000 });
    await oldStore.createJob(streamId, 'old-synthetic-user');
    const manager = new GenerationJobManagerClass({
      eventTransport: new InMemoryEventTransport(),
      jobStore: oldStore,
      cleanupOnComplete: false,
    });
    const staleAbort = manager.abortJob(streamId);
    await oldStore.started;

    await manager.destroy();

    const replacementStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const replacementTransport = new InMemoryEventTransport();
    const emitDone = jest.spyOn(replacementTransport, 'emitDone');
    manager.configure({
      eventTransport: replacementTransport,
      jobStore: replacementStore,
      cleanupOnComplete: false,
    });
    const replacementJob = await manager.createJob(streamId, 'replacement-synthetic-user');

    oldStore.release();
    await expect(staleAbort).rejects.toThrow('service generation changed');
    expect(replacementJob.abortController.signal.aborted).toBe(false);
    expect(emitDone).not.toHaveBeenCalled();
    await expect(replacementStore.hasJob(streamId)).resolves.toBe(true);
    await manager.destroy();
  });

  test('rejects a stale completion after its service generation changes', async () => {
    const oldStore = new DeferredUpdateJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass({
      eventTransport: new InMemoryEventTransport(),
      jobStore: oldStore,
      cleanupOnComplete: false,
    });
    await manager.createJob('stale-completion', 'synthetic-user');
    const staleCompletion = manager.completeJob('stale-completion', 'synthetic failure');
    await oldStore.started;

    await manager.destroy();
    manager.configure({
      eventTransport: new InMemoryEventTransport(),
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      cleanupOnComplete: false,
    });

    oldStore.release();
    await expect(staleCompletion).rejects.toThrow('service generation changed');
    await manager.destroy();
  });

  test('rejects stale metadata persistence after its service generation changes', async () => {
    const oldStore = new DeferredUpdateJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass({
      eventTransport: new InMemoryEventTransport(),
      jobStore: oldStore,
    });
    const staleUpdate = manager.updateMetadata('stale-metadata', { sender: 'Synthetic' });
    await oldStore.started;

    await manager.destroy();
    manager.configure({
      eventTransport: new InMemoryEventTransport(),
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
    });

    oldStore.release();
    await expect(staleUpdate).rejects.toThrow('service generation changed');
    await manager.destroy();
  });

  test('rejects a stale terminal emit after its service generation changes', async () => {
    const oldTransport = new DeferredTerminalTransport();
    const manager = new GenerationJobManagerClass({
      eventTransport: oldTransport,
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
    });
    const staleEmit = manager.emitDone('stale-terminal', {
      event: 'done',
      data: { final: true },
    });
    await oldTransport.started;

    await manager.destroy();
    manager.configure({
      eventTransport: new InMemoryEventTransport(),
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
    });

    oldTransport.release();
    await expect(staleEmit).rejects.toThrow('service generation changed');
    await manager.destroy();
  });

  test('delivers terminal events when best-effort persistence fails', async () => {
    const transport = new InMemoryEventTransport();
    const emitDone = jest.spyOn(transport, 'emitDone');
    const emitError = jest.spyOn(transport, 'emitError');
    const onDone = jest.fn();
    const onError = jest.fn();
    const subscription = transport.subscribe('terminal-persistence-failure', {
      onChunk: () => undefined,
      onDone,
      onError,
    });
    await subscription.ready;
    const manager = new GenerationJobManagerClass({
      eventTransport: transport,
      jobStore: new FailedUpdateJobStore({ ttlAfterComplete: 60_000 }),
    });
    const doneEvent = { event: 'done', data: { final: true } };

    await expect(
      manager.emitDone('terminal-persistence-failure', doneEvent),
    ).resolves.toBeUndefined();
    await expect(
      manager.emitError('terminal-persistence-failure', 'synthetic stream failure'),
    ).resolves.toBeUndefined();

    expect(emitDone).toHaveBeenCalledWith('terminal-persistence-failure', doneEvent);
    expect(emitError).toHaveBeenCalledWith(
      'terminal-persistence-failure',
      'synthetic stream failure',
    );
    expect(onDone).toHaveBeenCalledWith(doneEvent);
    expect(onError).toHaveBeenCalledWith('synthetic stream failure');
    subscription.unsubscribe();
    await manager.destroy();
  });

  test('rejects a stale resume lookup before reading replacement content', async () => {
    const oldStore = new DeferredGetJobStore({ ttlAfterComplete: 60_000 });
    await oldStore.createJob('stale-resume', 'old-synthetic-user');
    const manager = new GenerationJobManagerClass({
      eventTransport: new InMemoryEventTransport(),
      jobStore: oldStore,
    });
    const staleResume = manager.getResumeState('stale-resume');
    await oldStore.started;

    await manager.destroy();
    const replacementStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    await replacementStore.createJob('stale-resume', 'replacement-synthetic-user');
    const getContentParts = jest.spyOn(replacementStore, 'getContentParts');
    manager.configure({
      eventTransport: new InMemoryEventTransport(),
      jobStore: replacementStore,
    });

    oldStore.release();
    await expect(staleResume).rejects.toThrow('service generation changed');
    expect(getContentParts).not.toHaveBeenCalled();
    await manager.destroy();
  });

  test('rejects stale cleanup before traversing replacement services', async () => {
    const oldStore = new DeferredCleanupJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass({
      eventTransport: new InMemoryEventTransport(),
      jobStore: oldStore,
    });
    const cleanup = Reflect.get(manager, 'cleanup') as () => Promise<void>;
    const staleCleanup = cleanup.call(manager);
    await oldStore.started;

    await manager.destroy();
    const replacementStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const replacementTransport = new InMemoryEventTransport();
    const hasJob = jest.spyOn(replacementStore, 'hasJob');
    const getTrackedStreamIds = jest.spyOn(replacementTransport, 'getTrackedStreamIds');
    manager.configure({
      eventTransport: replacementTransport,
      jobStore: replacementStore,
    });

    oldStore.release();
    await expect(staleCleanup).rejects.toThrow('service generation changed');
    expect(hasJob).not.toHaveBeenCalled();
    expect(getTrackedStreamIds).not.toHaveBeenCalled();
    await manager.destroy();
  });

  test('rejects cleanup when its per-job existence check resumes in a new generation', async () => {
    const oldStore = new DeferredHasJobStore({ ttlAfterComplete: 60_000 });
    const oldTransport = new InMemoryEventTransport();
    jest.spyOn(oldTransport, 'getTrackedStreamIds').mockReturnValue([]);
    const manager = new GenerationJobManagerClass({
      eventTransport: oldTransport,
      jobStore: oldStore,
    });
    await manager.createJob('stale-cleanup-existence', 'synthetic-user');

    const cleanup = Reflect.get(manager, 'cleanup') as () => Promise<void>;
    const staleCleanup = cleanup.call(manager);
    await oldStore.started;

    await manager.destroy();
    manager.configure({
      eventTransport: new InMemoryEventTransport(),
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
    });

    oldStore.release();
    await expect(staleCleanup).rejects.toThrow('service generation changed');
    await manager.destroy();
  });

  test('preserves a same-stream replacement runtime during an in-flight cleanup check', async () => {
    const jobStore = new DeferredHasJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass({
      eventTransport: new InMemoryEventTransport(),
      jobStore,
    });
    await manager.createJob('same-generation-cleanup', 'old-synthetic-user');
    await jobStore.deleteJob('same-generation-cleanup');

    const cleanup = Reflect.get(manager, 'cleanup') as () => Promise<void>;
    const pendingCleanup = cleanup.call(manager);
    await jobStore.started;

    const replacement = await manager.createJob(
      'same-generation-cleanup',
      'replacement-synthetic-user',
    );
    jobStore.release();
    await pendingCleanup;

    expect(replacement.abortController.signal.aborted).toBe(false);
    expect(manager.getRuntimeStats().runtimeStateCount).toBe(1);
    await expect(jobStore.hasJob('same-generation-cleanup')).resolves.toBe(true);
    await manager.destroy();
  });

  test('preserves a replacement run-step buffer during an in-flight cleanup check', async () => {
    const jobStore = new DeferredHasJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass({
      eventTransport: new InMemoryEventTransport(),
      jobStore,
    });
    const streamId = 'same-generation-buffer-cleanup';
    const oldBuffer = [{ id: 'old-buffer' }];
    const replacementBuffer = [{ id: 'replacement-buffer' }];
    const runStepBuffers = new Map([[streamId, oldBuffer]]);
    Reflect.set(manager, 'runStepBuffers', runStepBuffers);

    const cleanup = Reflect.get(manager, 'cleanup') as () => Promise<void>;
    const pendingCleanup = cleanup.call(manager);
    await jobStore.started;

    runStepBuffers.set(streamId, replacementBuffer);
    jobStore.release();
    await pendingCleanup;

    expect(runStepBuffers.get(streamId)).toBe(replacementBuffer);
    await manager.destroy();
  });

  /* === VIVENTIUM END === */
});
