import IoRedis from 'ioredis';
import type { Redis, Cluster } from 'ioredis';
import type { RedisClientType, RedisClusterType } from '@redis/client';

/**
 * Integration tests for GenerationJobManager.
 *
 * Tests the job manager with both in-memory and Redis backends
 * to ensure consistent behavior across deployment modes.
 *
 * Run with: USE_REDIS=true npx jest GenerationJobManager.stream_integration
 */
describe('GenerationJobManager Integration Tests', () => {
  /* === VIVENTIUM START ===
   * Purpose: Modified Redis transport teardown sites await their asynchronous
   * acknowledgement boundary before disconnecting borrowed test clients.
   * === VIVENTIUM END === */
  let originalEnv: NodeJS.ProcessEnv;
  let ioredisClient: Redis | Cluster | null = null;
  const testPrefix = 'JobManager-Integration-Test';
  const cortexFence = ({
    ownerId = 'owner-a',
    messageId,
    parentMessageId,
    revision,
    generation,
    deliveryIds = ['cidl-stream-test'],
    claimToken = `claim-${generation}`,
    presentationLeaseToken = `presentation-lease-${generation}`,
    graphResultHash = 'a'.repeat(64),
  }: {
    ownerId?: string;
    messageId: string;
    parentMessageId: string;
    revision: number;
    generation: number;
    deliveryIds?: string[];
    claimToken?: string;
    presentationLeaseToken?: string;
    graphResultHash?: string;
  }) => ({
    verifyCortexPresentation: jest.fn().mockResolvedValue({
      ownerId,
      messageId,
      parentMessageId,
      revision,
      generation,
      deliveryIds,
      deliveryReceipts: deliveryIds.map((deliveryId) => ({ deliveryId, graphResultHash })),
      claimToken,
      presentationLeaseToken,
    }),
  });

  const closeRedisClient = async (
    client: Redis | Cluster | RedisClientType | RedisClusterType | null,
  ): Promise<void> => {
    if (!client) {
      return;
    }

    const status = 'status' in client ? String(client.status || '') : '';
    if (status && status !== 'ready') {
      if ('disconnect' in client) {
        client.disconnect();
      }
      return;
    }
    try {
      await client.quit();
    } catch {
      try {
        if ('disconnect' in client) {
          client.disconnect();
        }
      } catch {
        // Ignore cleanup errors from an already-closed test client.
      }
    }
  };

  const resetStreamModules = async (): Promise<void> => {
    const { GenerationJobManager } = await import('../GenerationJobManager');
    await GenerationJobManager.destroy();
    jest.resetModules();
  };

  beforeAll(async () => {
    originalEnv = { ...process.env };

    // Set up test environment
    process.env.USE_REDIS = 'false';
    process.env.REDIS_URI = process.env.REDIS_URI ?? 'redis://127.0.0.1:6379';
    process.env.REDIS_KEY_PREFIX = testPrefix;

    await resetStreamModules();
    const redisOptions = {
      keyPrefix: `${testPrefix}::`,
      lazyConnect: true,
      connectTimeout: 1000,
      enableOfflineQueue: true,
      maxRetriesPerRequest: 3,
    };
    const candidate = process.env.USE_REDIS_CLUSTER === 'true'
      ? new IoRedis.Cluster(
          process.env.REDIS_URI.split(',').map((entry) => {
            const url = new URL(entry);
            return { host: url.hostname, port: Number(url.port) || 6379 };
          }),
          { redisOptions, lazyConnect: true },
        )
      : new IoRedis(process.env.REDIS_URI, redisOptions);
    candidate.on('error', () => {});
    try {
      await candidate.connect();
      await candidate.ping();
      ioredisClient = candidate;
    } catch {
      candidate.disconnect();
      ioredisClient = null;
    }
  });

  afterEach(async () => {
    // Clean up module state
    await resetStreamModules();

    // Clean up Redis keys (delete individually for cluster compatibility)
    if (ioredisClient) {
      try {
        const keys = await ioredisClient.keys(`${testPrefix}*`);
        const streamKeys = await ioredisClient.keys(`stream:*`);
        const allKeys = [...keys, ...streamKeys];
        await Promise.all(allKeys.map((key) => ioredisClient!.del(key)));
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  afterAll(async () => {
    await closeRedisClient(ioredisClient);
    process.env = originalEnv;
  });

  describe('In-Memory Mode', () => {
    /* === VIVENTIUM START ===
     * Feature: Owner-safe stream identity.
     * Purpose: A caller-controlled key must never overwrite an existing generation job.
     * === VIVENTIUM END === */
    test('rejects a duplicate stream key without mutating the original owner job', async () => {
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });

      await store.createJob('shared-stream-key', 'owner-a', 'conversation-a');

      await expect(
        store.createJob('shared-stream-key', 'owner-b', 'conversation-b'),
      ).rejects.toMatchObject({ code: 'stream_id_conflict' });
      await expect(store.getJob('shared-stream-key')).resolves.toMatchObject({
        userId: 'owner-a',
        conversationId: 'conversation-a',
      });
    });

    test('serializes duplicate creation while an earlier create is queued', async () => {
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const store = new InMemoryJobStore({ ttlAfterComplete: 60000, maxJobs: 1 });
      let releaseQueue!: () => void;
      const queued = new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
      (store as unknown as { createJobTail: Promise<void> }).createJobTail = queued;

      const attemptsPromise = Promise.allSettled([
        store.createJob('shared-capacity-key', 'owner-a', 'conversation-a'),
        store.createJob('shared-capacity-key', 'owner-b', 'conversation-b'),
      ]);
      releaseQueue();
      const attempts = await attemptsPromise;

      expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      const rejected = attempts.find(({ status }) => status === 'rejected');
      expect(rejected).toMatchObject({
        status: 'rejected',
        reason: { code: 'stream_id_conflict' },
      });
      const created = attempts.find(({ status }) => status === 'fulfilled');
      expect(await store.getJob('shared-capacity-key')).toMatchObject(
        created?.status === 'fulfilled'
          ? {
              userId: created.value.userId,
              conversationId: created.value.conversationId,
            }
          : {},
      );
      await expect(store.getJobCount()).resolves.toBe(1);
    });

    test('does not resurrect a queued job when destroy wins', async () => {
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const store = new InMemoryJobStore({ ttlAfterComplete: 60000, maxJobs: 1 });
      let releaseQueue!: () => void;
      const queued = new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
      (store as unknown as { createJobTail: Promise<void> }).createJobTail = queued;

      const pendingCreate = store.createJob('must-not-resurrect', 'owner-a', 'conversation-a');
      await store.destroy();
      releaseQueue();

      await expect(pendingCreate).rejects.toMatchObject({ code: 'stream_store_unavailable' });
      await expect(store.getJob('must-not-resurrect')).resolves.toBeNull();
      await expect(store.getJobCount()).resolves.toBe(0);
    });

    test('does not let a pre-destroy create enter a reinitialized store', async () => {
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const store = new InMemoryJobStore({ ttlAfterComplete: 60000, maxJobs: 1 });
      let releaseQueue!: () => void;
      const queued = new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
      (store as unknown as { createJobTail: Promise<void> }).createJobTail = queued;

      const staleCreate = store.createJob('stale-before-reopen', 'old-owner', 'old-conversation');
      await store.destroy();
      await store.initialize();
      releaseQueue();

      await expect(staleCreate).rejects.toMatchObject({ code: 'stream_store_unavailable' });
      await expect(store.getJob('stale-before-reopen')).resolves.toBeNull();
      await store.createJob('fresh-after-reopen', 'new-owner', 'new-conversation');
      await expect(store.getJob('fresh-after-reopen')).resolves.toMatchObject({
        userId: 'new-owner',
        conversationId: 'new-conversation',
      });
    });

    test('reconfigure destroys only the captured old services after asynchronous store cleanup', async () => {
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');
      const oldStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const oldTransport = new InMemoryEventTransport();
      const newStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const newTransport = new InMemoryEventTransport();
      let releaseOldStore!: () => void;
      const oldStoreReleased = new Promise<void>((resolve) => {
        releaseOldStore = resolve;
      });
      let markOldDestroyStarted!: () => void;
      const oldDestroyStarted = new Promise<void>((resolve) => {
        markOldDestroyStarted = resolve;
      });
      jest.spyOn(oldStore, 'destroy').mockImplementation(async () => {
        markOldDestroyStarted();
        await oldStoreReleased;
      });
      const oldTransportDestroy = jest.spyOn(oldTransport, 'destroy');
      const newTransportDestroy = jest.spyOn(newTransport, 'destroy');
      const manager = new GenerationJobManagerClass({
        jobStore: oldStore,
        eventTransport: oldTransport,
      });
      await manager.initialize();

      manager.configure({ jobStore: newStore, eventTransport: newTransport });
      await oldDestroyStarted;
      releaseOldStore();
      await new Promise((resolve) => setImmediate(resolve));

      expect(manager.getJobStore()).toBe(newStore);
      expect(oldTransportDestroy).toHaveBeenCalledTimes(1);
      expect(newTransportDestroy).not.toHaveBeenCalled();
      await manager.destroy();
    });

    /* === VIVENTIUM START ===
     * Feature: Exact stream supersession.
     * Purpose: Never publish a runnable job before its cross-replica abort listener is ready.
     * === VIVENTIUM END === */
    test('waits for abort-listener readiness before admitting a generation job', async () => {
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');
      const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      let releaseAbortListener!: () => void;
      const abortListenerReady = new Promise<void>((resolve) => {
        releaseAbortListener = resolve;
      });
      const transport = Object.assign(new InMemoryEventTransport(), {
        onAbort: jest.fn(() => abortListenerReady),
      });
      const createJob = jest.spyOn(store, 'createJob');
      const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });

      const pending = manager.createJob('abort-ready-before-admission', 'owner-a');
      await Promise.resolve();
      await Promise.resolve();

      expect(createJob).not.toHaveBeenCalled();
      releaseAbortListener();
      await expect(pending).resolves.toMatchObject({
        streamId: 'abort-ready-before-admission',
        status: 'running',
      });
      expect(createJob).toHaveBeenCalledTimes(1);
      await manager.destroy();
    });

    test('fails reconfiguration closed while an admission owns the current lifecycle', async () => {
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');
      const oldStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const oldTransport = new InMemoryEventTransport();
      const newStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const newTransport = new InMemoryEventTransport();
      let releaseAdmission!: () => void;
      const admissionGate = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      let admissionStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        admissionStarted = resolve;
      });
      const createJob = oldStore.createJob.bind(oldStore);
      jest.spyOn(oldStore, 'createJob').mockImplementation(async (...args) => {
        admissionStarted();
        await admissionGate;
        return createJob(...args);
      });
      const oldTransportDestroy = jest.spyOn(oldTransport, 'destroy');
      const newTransportDestroy = jest.spyOn(newTransport, 'destroy');
      const manager = new GenerationJobManagerClass({
        jobStore: oldStore,
        eventTransport: oldTransport,
      });

      const pending = manager.createJob('owned-lifecycle-admission', 'owner-a');
      await started;

      expect(() => manager.configure({ jobStore: newStore, eventTransport: newTransport })).toThrow(
        expect.objectContaining({ code: 'stream_store_unavailable' }),
      );
      expect(manager.getJobStore()).toBe(oldStore);
      expect(oldTransportDestroy).not.toHaveBeenCalled();
      expect(newTransportDestroy).not.toHaveBeenCalled();

      releaseAdmission();
      await expect(pending).resolves.toMatchObject({ streamId: 'owned-lifecycle-admission' });
      await manager.destroy();
    });

    test('does not publish a pre-destroy admission into a reopened manager lifecycle', async () => {
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');
      const oldStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      let releaseAdmission!: () => void;
      const admissionGate = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      let admissionStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        admissionStarted = resolve;
      });
      const createJob = oldStore.createJob.bind(oldStore);
      jest.spyOn(oldStore, 'createJob').mockImplementation(async (...args) => {
        admissionStarted();
        await admissionGate;
        return createJob(...args);
      });
      const manager = new GenerationJobManagerClass({
        jobStore: oldStore,
        eventTransport: new InMemoryEventTransport(),
      });

      const staleAdmission = manager.createJob('pre-destroy-admission', 'old-owner');
      void staleAdmission.catch(() => {});
      await started;
      await manager.destroy();
      releaseAdmission();
      await expect(staleAdmission).rejects.toMatchObject({ code: 'stream_store_unavailable' });

      const newStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      manager.configure({
        jobStore: newStore,
        eventTransport: new InMemoryEventTransport(),
      });
      await expect(manager.createJob('fresh-after-reopen', 'new-owner')).resolves.toMatchObject({
        streamId: 'fresh-after-reopen',
        status: 'running',
      });
      await expect(oldStore.getJob('pre-destroy-admission')).resolves.toBeNull();
      await manager.destroy();
    });

    test('cancels a pending abort-listener handshake so destroy can reopen cleanly', async () => {
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');
      let releaseOldListener!: () => void;
      const oldListenerReady = new Promise<void>((resolve) => {
        releaseOldListener = resolve;
      });
      let markOldListenerStarted!: () => void;
      const oldListenerStarted = new Promise<void>((resolve) => {
        markOldListenerStarted = resolve;
      });
      const oldTransport = Object.assign(new InMemoryEventTransport(), {
        onAbort: jest.fn(() => {
          markOldListenerStarted();
          return oldListenerReady;
        }),
      });
      const manager = new GenerationJobManagerClass({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
        eventTransport: oldTransport,
      });

      const staleAdmission = manager.createJob('partitioned-subscribe', 'old-owner');
      void staleAdmission.catch(() => {});
      await oldListenerStarted;
      await manager.destroy();
      const settlement = await Promise.race([
        staleAdmission.then(
          () => 'fulfilled',
          (error: { code?: string }) => error.code ?? 'rejected',
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 50)),
      ]);
      expect(settlement).toBe('stream_store_unavailable');

      const freshStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      manager.configure({
        jobStore: freshStore,
        eventTransport: new InMemoryEventTransport(),
      });
      const fresh = await manager.createJob('fresh-after-listener-partition', 'new-owner');
      releaseOldListener();
      await new Promise((resolve) => setImmediate(resolve));

      expect(fresh.status).toBe('running');
      await expect(freshStore.getJob('fresh-after-listener-partition')).resolves.toMatchObject({
        userId: 'new-owner',
        status: 'running',
      });
      await expect(freshStore.getJob('partitioned-subscribe')).resolves.toBeNull();
      await manager.destroy();
    });

    /* === VIVENTIUM START ===
     * Feature: Stream-manager lifecycle fencing.
     * Purpose: A lazy cross-replica read must not survive shutdown or mutate a reopened lifecycle.
     */
    test('cancels lazy cross-replica hydration without resurrecting runtime state after reopen', async () => {
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');
      const streamId = 'lazy-hydration-across-lifecycle';
      const oldStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      await oldStore.createJob(streamId, 'old-owner');
      let releaseOldListener!: () => void;
      const oldListenerReady = new Promise<void>((resolve) => {
        releaseOldListener = resolve;
      });
      let markOldListenerStarted!: () => void;
      const oldListenerStarted = new Promise<void>((resolve) => {
        markOldListenerStarted = resolve;
      });
      let oldAbortCallback!: (reason?: string) => void;
      const oldTransport = Object.assign(new InMemoryEventTransport(), {
        onAbort: jest.fn((_streamId: string, callback: (reason?: string) => void) => {
          oldAbortCallback = callback;
          markOldListenerStarted();
          return oldListenerReady;
        }),
      });
      const manager = new GenerationJobManagerClass({
        jobStore: oldStore,
        eventTransport: oldTransport,
      });

      const staleRead = manager.getJob(streamId);
      void staleRead.catch(() => {});
      await oldListenerStarted;
      await manager.destroy();

      const staleSettlement = await Promise.race([
        staleRead.then(
          () => 'fulfilled',
          (error: { code?: string }) => error.code ?? 'rejected',
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 50)),
      ]);
      expect(staleSettlement).toBe('stream_store_unavailable');

      const freshStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const freshTransport = new InMemoryEventTransport();
      manager.configure({ jobStore: freshStore, eventTransport: freshTransport });
      manager.initialize();
      await freshStore.createJob(streamId, 'new-owner');

      const freshJob = await manager.getJob(streamId);
      expect(freshJob?.metadata.userId).toBe('new-owner');
      const freshSubscription = await manager.subscribe(streamId, () => {});
      expect(freshSubscription).not.toBeNull();

      releaseOldListener();
      await new Promise((resolve) => setImmediate(resolve));
      oldAbortCallback('stale-old-lifecycle-abort');
      await new Promise((resolve) => setImmediate(resolve));

      expect(freshJob?.abortController.signal.aborted).toBe(false);
      await expect(manager.getJob(streamId)).resolves.toMatchObject({
        metadata: { userId: 'new-owner' },
      });
      freshSubscription?.unsubscribe();
      await manager.destroy();
    });

    test('holds concurrent lazy reads and subscriptions until Redis acknowledges hydration', async () => {
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');
      const streamId = 'lazy-hydration-singleflight';
      const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      await store.createJob(streamId, 'owner-a');
      let releaseSubscription!: () => void;
      const subscriptionReady = new Promise<void>((resolve) => {
        releaseSubscription = resolve;
      });
      let markSubscriptionRequested!: () => void;
      const subscriptionRequested = new Promise<void>((resolve) => {
        markSubscriptionRequested = resolve;
      });
      const subscriber = {
        on: jest.fn(),
        subscribe: jest.fn(() => {
          markSubscriptionRequested();
          return subscriptionReady;
        }),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
      };
      const transport = new RedisEventTransport(
        { publish: jest.fn().mockResolvedValue(1) } as never,
        subscriber as never,
      );
      const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });

      const firstRead = manager.getJob(streamId);
      await subscriptionRequested;
      const secondRead = manager.getJob(streamId);
      const sseSubscription = manager.subscribe(streamId, () => {});
      const [secondReadBeforeAck, sseSubscriptionBeforeAck] = await Promise.all([
        Promise.race([
          secondRead.then(() => 'fulfilled'),
          new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 25)),
        ]),
        Promise.race([
          sseSubscription.then(() => 'fulfilled'),
          new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 25)),
        ]),
      ]);

      expect(secondReadBeforeAck).toBe('pending');
      expect(sseSubscriptionBeforeAck).toBe('pending');

      releaseSubscription();
      const [firstJob, secondJob, subscription] = await Promise.all([
        firstRead,
        secondRead,
        sseSubscription,
      ]);
      expect(firstJob?.streamId).toBe(streamId);
      expect(secondJob?.streamId).toBe(streamId);
      expect(subscription).not.toBeNull();
      expect(subscriber.subscribe).toHaveBeenCalledTimes(1);

      subscription?.unsubscribe();
      await manager.destroy();
    });

    test('does not let a stale abort mutate a fresh same-id job after reopen', async () => {
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');
      const streamId = 'abort-across-lifecycle';
      const oldStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      await oldStore.createJob(streamId, 'old-owner');
      const oldJob = await oldStore.getJob(streamId);
      let releaseOldRead!: () => void;
      const oldReadReleased = new Promise<void>((resolve) => {
        releaseOldRead = resolve;
      });
      let markOldReadStarted!: () => void;
      const oldReadStarted = new Promise<void>((resolve) => {
        markOldReadStarted = resolve;
      });
      jest.spyOn(oldStore, 'getJob').mockImplementation(async (requestedStreamId) => {
        if (requestedStreamId === streamId) {
          markOldReadStarted();
          await oldReadReleased;
          return oldJob;
        }
        return null;
      });
      const manager = new GenerationJobManagerClass({
        jobStore: oldStore,
        eventTransport: new InMemoryEventTransport(),
      });

      const staleAbort = manager.abortJob(streamId);
      void staleAbort.catch(() => {});
      await oldReadStarted;
      await manager.destroy();

      const freshStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      manager.configure({
        jobStore: freshStore,
        eventTransport: new InMemoryEventTransport(),
      });
      manager.initialize();
      const freshJob = await manager.createJob(streamId, 'new-owner');

      releaseOldRead();
      await expect(staleAbort).rejects.toMatchObject({ code: 'stream_store_unavailable' });
      expect(freshJob.abortController.signal.aborted).toBe(false);
      await expect(freshStore.getJob(streamId)).resolves.toMatchObject({
        userId: 'new-owner',
        status: 'running',
      });

      await manager.destroy();
    });
    /* === VIVENTIUM END === */

    test('should create and manage jobs', async () => {
      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

      // Configure with in-memory
      // cleanupOnComplete: false so we can verify completed status
      GenerationJobManager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: false,
      });

      await GenerationJobManager.initialize();

      const streamId = `inmem-job-${Date.now()}`;
      const userId = 'test-user-1';

      // Create job (async)
      const job = await GenerationJobManager.createJob(streamId, userId);
      expect(job.streamId).toBe(streamId);
      expect(job.status).toBe('running');

      // Check job exists
      const hasJob = await GenerationJobManager.hasJob(streamId);
      expect(hasJob).toBe(true);

      // Get job
      const retrieved = await GenerationJobManager.getJob(streamId);
      expect(retrieved?.streamId).toBe(streamId);

      // Update job
      await GenerationJobManager.updateMetadata(streamId, {
        sender: 'TestAgent',
        voiceCallSessionId: 'call-session-1',
      });
      const updated = await GenerationJobManager.getJob(streamId);
      expect(updated?.metadata?.sender).toBe('TestAgent');
      expect(updated?.metadata?.voiceCallSessionId).toBe('call-session-1');

      // Complete job
      await GenerationJobManager.completeJob(streamId);
      const completed = await GenerationJobManager.getJob(streamId);
      expect(completed?.status).toBe('complete');

      await GenerationJobManager.destroy();
    });

    /* === VIVENTIUM START ===
     * Feature: Exact optimistic-to-authoritative resume identity.
     * Purpose: A reconnecting web client needs the exact admitted presentation IDs to replace its
     *          optimistic turn without creating a second visible conversation branch.
     * === VIVENTIUM END === */
    test('returns the durable client presentation identity in resume state', async () => {
      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

      GenerationJobManager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
      });
      await GenerationJobManager.initialize();

      const streamId = `inmem-resume-source-${Date.now()}`;
      const createOptions = {
        interactionContext: {
          actor_kind: 'external_user',
          origin: 'interactive',
          surface: 'web',
          conversation_id: 'conversation-1',
          revision: 1,
          source_event_id: 'client-source-message',
        },
        clientPresentation: {
          mode: 'append' as const,
          userMessageId: 'client-presentation-user',
          responseMessageId: 'client-presentation-response',
          targetUserMessageId: 'client-presentation-user',
        },
      } as Parameters<typeof GenerationJobManager.createJob>[3] & {
        clientPresentation: {
          mode: 'append';
          userMessageId: string;
          responseMessageId: string;
          targetUserMessageId: string;
        };
      };
      await GenerationJobManager.createJob(streamId, 'test-user', 'conversation-1', createOptions);
      await GenerationJobManager.updateMetadata(streamId, {
        userMessage: {
          messageId: 'server-user-message',
          parentMessageId: 'root',
          conversationId: 'conversation-1',
          text: 'synthetic prompt',
        },
        responseMessageId: 'server-response-message',
      });

      await expect(GenerationJobManager.getResumeState(streamId)).resolves.toMatchObject({
        clientPresentation: {
          mode: 'append',
          userMessageId: 'client-presentation-user',
          responseMessageId: 'client-presentation-response',
          targetUserMessageId: 'client-presentation-user',
        },
        userMessage: { messageId: 'server-user-message' },
        responseMessageId: 'server-response-message',
      });

      await GenerationJobManager.destroy();
    });

    test('should handle event streaming', async () => {
      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

      GenerationJobManager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
      });

      await GenerationJobManager.initialize();

      const streamId = `inmem-events-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      const receivedChunks: unknown[] = [];

      // Subscribe to events (subscribe takes separate args, not an object)
      const subscription = await GenerationJobManager.subscribe(streamId, (event) =>
        receivedChunks.push(event),
      );
      const { unsubscribe } = subscription!;

      // Wait for first subscriber to be registered
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Emit chunks (emitChunk takes { event, data } format, now async for Redis ordering)
      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { type: 'text', text: 'Hello' },
      });
      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { type: 'text', text: ' world' },
      });

      // Give time for events to propagate
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify chunks were received
      expect(receivedChunks.length).toBeGreaterThan(0);

      // Complete the job (this cleans up resources)
      await GenerationJobManager.completeJob(streamId);

      unsubscribe();
      await GenerationJobManager.destroy();
    });

    test('returns a verified target receipt and reports an unavailable runtime without delivery', async () => {
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');
      const manager = new GenerationJobManagerClass({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
        eventTransport: new InMemoryEventTransport(),
      });
      await manager.initialize();

      await expect(
        manager.emitChunk('missing-runtime', {
          event: 'on_cortex_followup',
          data: { messageId: 'follow-up-missing', revision: 2 },
        }),
      ).resolves.toEqual({
        delivered: false,
        streamId: 'missing-runtime',
        reason: 'runtime_unavailable',
      });

      await manager.createJob('active-runtime', 'owner-a');
      await expect(
        manager.emitChunk(
          'active-runtime',
          {
            event: 'on_cortex_followup',
            data: {
              messageId: 'follow-up-a',
              parentMessageId: 'parent-a',
              revision: 2,
              presentationGeneration: 99,
            },
          },
          cortexFence({
            messageId: 'follow-up-a',
            parentMessageId: 'parent-a',
            revision: 2,
            generation: 7,
          }),
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          delivered: true,
          streamId: 'active-runtime',
          target: 'runtime_replay_buffer',
          presentationRef: 'sse:active-runtime:follow-up-a:2',
        }),
      );
      const boundJob = await manager.getJob('active-runtime');
      expect(boundJob?.metadata.cortexPresentation).toEqual(
        expect.objectContaining({
          messageId: 'follow-up-a',
          parentMessageId: 'parent-a',
          revision: 2,
          generation: 7,
        }),
      );

      await manager.destroy();
    });

    test('blocks an in-memory Cortex event before binding or publishing when its live claim fence is stale', async () => {
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');
      const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const transport = new InMemoryEventTransport();
      const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
      await manager.initialize();
      await manager.createJob('cortex-stale-memory', 'owner-a');
      const received: unknown[] = [];
      const subscription = await manager.subscribe('cortex-stale-memory', (event) =>
        received.push(event),
      );
      const emitTransport = jest.spyOn(transport, 'emitChunk');
      const staleFence = Object.assign(new Error('stale generation'), {
        code: 'cortex_insight_delivery_settlement_conflict',
      });
      const emitWithFence = manager.emitChunk as unknown as (
        streamId: string,
        event: unknown,
        options: unknown,
      ) => Promise<unknown>;

      await expect(
        emitWithFence.call(
          manager,
          'cortex-stale-memory',
          {
            event: 'on_cortex_followup',
            data: {
              messageId: 'follow-up-stale',
              parentMessageId: 'parent-a',
              revision: 2,
              presentationGeneration: 1,
            },
          },
          { verifyCortexPresentation: jest.fn().mockRejectedValue(staleFence) },
        ),
      ).rejects.toMatchObject({ code: 'cortex_insight_delivery_settlement_conflict' });

      expect(emitTransport).not.toHaveBeenCalled();
      expect(received).toEqual([]);
      expect(
        (await manager.getJob('cortex-stale-memory'))?.metadata.cortexPresentation,
      ).toBeUndefined();
      subscription?.unsubscribe();
      await manager.destroy();
    });

    test('rejects an older Cortex generation and claim token after a newer binding', async () => {
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');
      const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const transport = new InMemoryEventTransport();
      const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
      await manager.initialize();
      await manager.createJob('cortex-token-fence', 'owner-a');
      const received: unknown[] = [];
      const subscription = await manager.subscribe('cortex-token-fence', (event) =>
        received.push(event),
      );

      await expect(
        manager.emitChunk(
          'cortex-token-fence',
          {
            event: 'on_cortex_followup',
            data: { messageId: 'follow-up-a', parentMessageId: 'parent-a', revision: 2 },
          },
          cortexFence({
            messageId: 'follow-up-a',
            parentMessageId: 'parent-a',
            revision: 2,
            generation: 2,
            claimToken: 'claim-new',
          }),
        ),
      ).resolves.toEqual(expect.objectContaining({ delivered: true, claimToken: 'claim-new' }));

      await expect(
        manager.emitChunk(
          'cortex-token-fence',
          {
            event: 'on_cortex_followup',
            data: { messageId: 'follow-up-a', parentMessageId: 'parent-a', revision: 2 },
          },
          cortexFence({
            messageId: 'follow-up-a',
            parentMessageId: 'parent-a',
            revision: 2,
            generation: 1,
            claimToken: 'claim-old',
          }),
        ),
      ).resolves.toEqual({
        delivered: false,
        streamId: 'cortex-token-fence',
        reason: 'presentation_unconfirmed',
      });
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        data: { presentationGeneration: 2, presentationClaimToken: 'claim-new' },
      });
      subscription?.unsubscribe();
      await manager.destroy();
    });

    test('blocks a Redis Cortex event before durable append or publish when its live claim fence is stale', async () => {
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');
      const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const transport = new InMemoryEventTransport();
      const appendChunk = jest.spyOn(store, 'appendChunk');
      const emitTransport = jest.spyOn(transport, 'emitChunk');
      const manager = new GenerationJobManagerClass();
      manager.configure({ jobStore: store, eventTransport: transport, isRedis: true });
      manager.initialize();
      await manager.createJob('cortex-stale-redis', 'owner-a');
      appendChunk.mockClear();
      emitTransport.mockClear();
      const staleFence = Object.assign(new Error('stale generation'), {
        code: 'cortex_insight_delivery_settlement_conflict',
      });
      const emitWithFence = manager.emitChunk as unknown as (
        streamId: string,
        event: unknown,
        options: unknown,
      ) => Promise<unknown>;

      await expect(
        emitWithFence.call(
          manager,
          'cortex-stale-redis',
          {
            event: 'on_cortex_followup',
            data: {
              messageId: 'follow-up-stale',
              parentMessageId: 'parent-a',
              revision: 2,
              presentationGeneration: 1,
            },
          },
          { verifyCortexPresentation: jest.fn().mockRejectedValue(staleFence) },
        ),
      ).rejects.toMatchObject({ code: 'cortex_insight_delivery_settlement_conflict' });

      expect(appendChunk).not.toHaveBeenCalled();
      expect(emitTransport).not.toHaveBeenCalled();
      expect(
        (await manager.getJob('cortex-stale-redis'))?.metadata.cortexPresentation,
      ).toBeUndefined();
      await manager.destroy();
    });

    test('does not confirm Cortex Web presentation when Redis persistence and publish both fail', async () => {
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');
      const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      jest.spyOn(store, 'appendChunk').mockRejectedValue(new Error('Redis append failed'));
      const transport = new RedisEventTransport(
        { publish: jest.fn().mockRejectedValue(new Error('Redis publish failed')) } as never,
        {
          on: jest.fn(),
          subscribe: jest.fn().mockResolvedValue(undefined),
          unsubscribe: jest.fn().mockResolvedValue(undefined),
          disconnect: jest.fn(),
        } as never,
      );
      const manager = new GenerationJobManagerClass();
      manager.configure({ jobStore: store, eventTransport: transport, isRedis: true });
      manager.initialize();
      await manager.createJob('cortex-redis-no-receipt', 'owner-a');

      await expect(
        manager.emitChunk(
          'cortex-redis-no-receipt',
          {
            event: 'on_cortex_followup',
            data: {
              messageId: 'follow-up-a',
              parentMessageId: 'parent-a',
              revision: 2,
              presentationGeneration: 1,
            },
          },
          cortexFence({
            messageId: 'follow-up-a',
            parentMessageId: 'parent-a',
            revision: 2,
            generation: 1,
          }),
        ),
      ).resolves.toEqual({
        delivered: false,
        streamId: 'cortex-redis-no-receipt',
        reason: 'presentation_unconfirmed',
      });

      await manager.destroy();
    });

    test('does not replay a failed Cortex event to a subscriber that connects later', async () => {
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');
      const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      jest.spyOn(store, 'appendChunk').mockRejectedValue(new Error('Redis append failed'));
      const transport = new RedisEventTransport(
        { publish: jest.fn().mockResolvedValue(0) } as never,
        {
          on: jest.fn(),
          subscribe: jest.fn().mockResolvedValue(undefined),
          unsubscribe: jest.fn().mockResolvedValue(undefined),
          disconnect: jest.fn(),
        } as never,
      );
      const manager = new GenerationJobManagerClass();
      manager.configure({ jobStore: store, eventTransport: transport, isRedis: true });
      manager.initialize();
      await manager.createJob('cortex-redis-failed-before-subscriber', 'owner-a');

      await expect(
        manager.emitChunk(
          'cortex-redis-failed-before-subscriber',
          {
            event: 'on_cortex_followup',
            data: {
              messageId: 'follow-up-failed',
              parentMessageId: 'parent-a',
              revision: 2,
              presentationGeneration: 1,
            },
          },
          cortexFence({
            messageId: 'follow-up-failed',
            parentMessageId: 'parent-a',
            revision: 2,
            generation: 1,
          }),
        ),
      ).resolves.toEqual({
        delivered: false,
        streamId: 'cortex-redis-failed-before-subscriber',
        reason: 'presentation_unconfirmed',
      });

      const delayedEvents: unknown[] = [];
      const subscription = await manager.subscribe(
        'cortex-redis-failed-before-subscriber',
        (event) => delayedEvents.push(event),
      );
      await new Promise((resolve) => setImmediate(resolve));

      expect(delayedEvents).toEqual([]);
      subscription?.unsubscribe();
      await manager.destroy();
    });

    test('accepts durable Redis replay persistence when live publish fails', async () => {
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');
      const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const transport = new RedisEventTransport(
        { publish: jest.fn().mockRejectedValue(new Error('Redis publish failed')) } as never,
        {
          on: jest.fn(),
          subscribe: jest.fn().mockResolvedValue(undefined),
          unsubscribe: jest.fn().mockResolvedValue(undefined),
          disconnect: jest.fn(),
        } as never,
      );
      const manager = new GenerationJobManagerClass();
      manager.configure({ jobStore: store, eventTransport: transport, isRedis: true });
      manager.initialize();
      await manager.createJob('cortex-redis-durable-receipt', 'owner-a');

      await expect(
        manager.emitChunk(
          'cortex-redis-durable-receipt',
          {
            event: 'on_cortex_followup',
            data: {
              messageId: 'follow-up-a',
              parentMessageId: 'parent-a',
              revision: 2,
              presentationGeneration: 1,
            },
          },
          cortexFence({
            messageId: 'follow-up-a',
            parentMessageId: 'parent-a',
            revision: 2,
            generation: 1,
          }),
        ),
      ).resolves.toEqual({
        delivered: true,
        streamId: 'cortex-redis-durable-receipt',
        target: 'durable_replay_store',
        presentationRef: 'sse:cortex-redis-durable-receipt:follow-up-a:2',
        claimToken: 'claim-1',
        presentationLeaseToken: 'presentation-lease-1',
      });

      await manager.destroy();
    });

    test('fails one Web replay persistence attempt and accepts the exact retry once durable', async () => {
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');
      const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const appendChunk = jest.spyOn(store, 'appendChunk');
      const publisher = { publish: jest.fn().mockRejectedValue(new Error('Redis unavailable')) };
      const transport = new RedisEventTransport(
        publisher as never,
        {
          on: jest.fn(),
          subscribe: jest.fn().mockResolvedValue(undefined),
          unsubscribe: jest.fn().mockResolvedValue(undefined),
          disconnect: jest.fn(),
        } as never,
      );
      const manager = new GenerationJobManagerClass();
      manager.configure({ jobStore: store, eventTransport: transport, isRedis: true });
      manager.initialize();
      await manager.createJob('cortex-qa-replay-fault', 'synthetic-owner');
      let armed = true;
      const consumeCortexFault = jest.fn(async (boundary: string) => {
        if (boundary !== 'web_replay_persistence' || !armed) return { triggered: false };
        armed = false;
        return { triggered: true };
      });
      const event = {
        event: 'on_cortex_followup',
        data: {
          messageId: 'synthetic-follow-up',
          parentMessageId: 'synthetic-parent',
          revision: 2,
          presentationGeneration: 1,
        },
      };
      const options = {
        ...cortexFence({
          ownerId: 'synthetic-owner',
          messageId: 'synthetic-follow-up',
          parentMessageId: 'synthetic-parent',
          revision: 2,
          generation: 1,
        }),
        consumeCortexFault,
      };

      await expect(manager.emitChunk('cortex-qa-replay-fault', event, options)).resolves.toEqual({
        delivered: false,
        streamId: 'cortex-qa-replay-fault',
        reason: 'presentation_unconfirmed',
      });
      await expect(manager.emitChunk('cortex-qa-replay-fault', event, options)).resolves.toEqual({
        delivered: true,
        streamId: 'cortex-qa-replay-fault',
        target: 'durable_replay_store',
        presentationRef: 'sse:cortex-qa-replay-fault:synthetic-follow-up:2',
        claimToken: 'claim-1',
        presentationLeaseToken: 'presentation-lease-1',
      });
      expect(appendChunk).toHaveBeenCalledTimes(1);

      await manager.destroy();
    });

    test('fails Web Redis publish acknowledgement without overriding a durable replay receipt', async () => {
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');
      const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const publisher = { publish: jest.fn().mockResolvedValue(1) };
      const transport = new RedisEventTransport(
        publisher as never,
        {
          on: jest.fn(),
          subscribe: jest.fn().mockResolvedValue(undefined),
          unsubscribe: jest.fn().mockResolvedValue(undefined),
          disconnect: jest.fn(),
        } as never,
      );
      const manager = new GenerationJobManagerClass();
      manager.configure({ jobStore: store, eventTransport: transport, isRedis: true });
      manager.initialize();
      await manager.createJob('cortex-qa-publish-fault', 'synthetic-owner');
      const consumeCortexFault = jest.fn(async (boundary: string) => ({
        triggered: boundary === 'web_redis_publish_ack',
      }));

      await expect(
        manager.emitChunk(
          'cortex-qa-publish-fault',
          {
            event: 'on_cortex_followup',
            data: {
              messageId: 'synthetic-follow-up',
              parentMessageId: 'synthetic-parent',
              revision: 2,
              presentationGeneration: 1,
            },
          },
          {
            ...cortexFence({
              ownerId: 'synthetic-owner',
              messageId: 'synthetic-follow-up',
              parentMessageId: 'synthetic-parent',
              revision: 2,
              generation: 1,
            }),
            consumeCortexFault,
          },
        ),
      ).resolves.toMatchObject({
        delivered: true,
        target: 'durable_replay_store',
        claimToken: 'claim-1',
        presentationLeaseToken: 'presentation-lease-1',
      });
      expect(publisher.publish).not.toHaveBeenCalled();

      await manager.destroy();
    });

    test('does not treat a raw Redis subscriber count as a browser presentation receipt', async () => {
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');
      const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      jest.spyOn(store, 'appendChunk').mockRejectedValue(new Error('Redis append failed'));
      const transport = new RedisEventTransport(
        { publish: jest.fn().mockResolvedValue(1) } as never,
        {
          on: jest.fn(),
          subscribe: jest.fn().mockResolvedValue(undefined),
          unsubscribe: jest.fn().mockResolvedValue(undefined),
          disconnect: jest.fn(),
        } as never,
      );
      const manager = new GenerationJobManagerClass();
      manager.configure({ jobStore: store, eventTransport: transport, isRedis: true });
      manager.initialize();
      await manager.createJob('cortex-redis-live-receipt', 'owner-a');

      await expect(
        manager.emitChunk(
          'cortex-redis-live-receipt',
          {
            event: 'on_cortex_followup',
            data: {
              messageId: 'follow-up-a',
              parentMessageId: 'parent-a',
              revision: 2,
              presentationGeneration: 1,
            },
          },
          cortexFence({
            messageId: 'follow-up-a',
            parentMessageId: 'parent-a',
            revision: 2,
            generation: 1,
          }),
        ),
      ).resolves.toEqual({
        delivered: false,
        streamId: 'cortex-redis-live-receipt',
        reason: 'presentation_unconfirmed',
      });

      await manager.destroy();
    });

    test('requires an exact active SSE handler when Redis has only an internal abort subscription', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');
      const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      jest.spyOn(store, 'appendChunk').mockRejectedValue(new Error('Redis append failed'));
      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber, {
        closeSubscriberOnDestroy: true,
      });
      const manager = new GenerationJobManagerClass();
      manager.configure({ jobStore: store, eventTransport: transport, isRedis: true });
      manager.initialize();
      const streamId = `cortex-abort-only-${Date.now()}`;

      try {
        await manager.createJob(streamId, 'owner-a');
        const staleEvent = {
          event: 'on_cortex_followup',
          data: {
            messageId: 'follow-up-before-browser',
            parentMessageId: 'parent-a',
            revision: 1,
            presentationGeneration: 1,
          },
        } as never;

        await expect(
          manager.emitChunk(
            streamId,
            staleEvent,
            cortexFence({
              messageId: 'follow-up-before-browser',
              parentMessageId: 'parent-a',
              revision: 1,
              generation: 1,
            }),
          ),
        ).resolves.toEqual({
          delivered: false,
          streamId,
          reason: 'presentation_unconfirmed',
        });

        const received: unknown[] = [];
        const subscription = await manager.subscribe(streamId, (event) => received.push(event));
        await new Promise((resolve) => setImmediate(resolve));
        expect(received).toEqual([]);

        const liveEvent = {
          event: 'on_cortex_followup',
          data: {
            messageId: 'follow-up-with-browser',
            parentMessageId: 'parent-a',
            revision: 2,
            presentationGeneration: 1,
          },
        } as never;
        await expect(
          manager.emitChunk(
            streamId,
            liveEvent,
            cortexFence({
              messageId: 'follow-up-with-browser',
              parentMessageId: 'parent-a',
              revision: 2,
              generation: 1,
            }),
          ),
        ).resolves.toEqual({
          delivered: true,
          streamId,
          target: 'subscriber_transport',
          presentationRef: `sse:${streamId}:follow-up-with-browser:2`,
          claimToken: 'claim-1',
          presentationLeaseToken: 'presentation-lease-1',
        });
        expect(received).toEqual([
          {
            ...liveEvent,
            data: { ...liveEvent.data, presentationClaimToken: 'claim-1' },
          },
        ]);
        subscription?.unsubscribe();
      } finally {
        await manager.destroy();
      }
    });

    test('preserves best-effort semantics for ordinary stream writes when Redis is unavailable', async () => {
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');
      const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      jest.spyOn(store, 'appendChunk').mockRejectedValue(new Error('Redis append failed'));
      const transport = new RedisEventTransport(
        { publish: jest.fn().mockRejectedValue(new Error('Redis publish failed')) } as never,
        {
          on: jest.fn(),
          subscribe: jest.fn().mockResolvedValue(undefined),
          unsubscribe: jest.fn().mockResolvedValue(undefined),
          disconnect: jest.fn(),
        } as never,
      );
      const manager = new GenerationJobManagerClass();
      manager.configure({ jobStore: store, eventTransport: transport, isRedis: true });
      manager.initialize();
      await manager.createJob('ordinary-redis-best-effort', 'owner-a');

      await expect(
        manager.emitChunk('ordinary-redis-best-effort', {
          event: 'on_message_delta',
          data: { text: 'hello' },
        }),
      ).resolves.toEqual({
        delivered: true,
        streamId: 'ordinary-redis-best-effort',
        target: 'runtime_replay_buffer',
      });

      await manager.destroy();
    });

    test('marks Main complete for discovery while retaining the Phase B runtime', async () => {
      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

      GenerationJobManager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: true,
      });
      await GenerationJobManager.initialize();

      const streamId = `inmem-main-complete-${Date.now()}`;
      const userId = 'phase-b-user';
      await GenerationJobManager.createJob(streamId, userId);

      const finalEvent = {
        final: true,
        conversation: { conversationId: streamId },
      } as never;

      await expect(
        GenerationJobManager.markMainResponseComplete(streamId, finalEvent),
      ).resolves.toBe(true);
      await expect(GenerationJobManager.getActiveJobIdsForUser(userId)).resolves.toEqual([]);
      const completedMain = await GenerationJobManager.getJob(streamId);
      expect(completedMain?.status).toBe('complete');
      const storedFinalEvent =
        typeof completedMain?.finalEvent === 'string'
          ? JSON.parse(completedMain.finalEvent)
          : completedMain?.finalEvent;
      expect(storedFinalEvent).toEqual(finalEvent);
      expect(GenerationJobManager.getRuntimeStats().runtimeStateCount).toBe(1);

      await GenerationJobManager.completeJob(streamId);
      await expect(GenerationJobManager.getJob(streamId)).resolves.toBeUndefined();
      await GenerationJobManager.destroy();
    });
  });

  describe('Redis Mode', () => {
    test('atomically carries a Cortex presentation fence through adapter acknowledgement', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { createStreamServices } = await import('../createStreamServices');
      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });
      GenerationJobManager.configure(services);
      await GenerationJobManager.initialize();

      const streamId = `redis-cortex-ack-${Date.now()}`;
      const job = await GenerationJobManager.createJob(
        streamId,
        'redis-cortex-owner',
        'redis-cortex-conversation',
        {
          interactionContext: {
            actor_kind: 'external_user',
            origin: 'interactive',
            surface: 'telegram',
            conversation_id: 'redis-cortex-conversation',
            revision: 1,
            source_event_id: 'redis-cortex-source',
          },
          deliveryPolicy: { commit_authority: 'external_adapter' },
        },
      );
      await GenerationJobManager.updateMetadata(streamId, {
        responseMessageId: 'redis-cortex-parent',
      });
      const acknowledgement = {
        logical_turn_id: job.metadata.interactionContext!.logical_turn_id!,
        revision: 1,
        state: 'committed' as const,
        presentation_ref: 'telegram:synthetic-chat:synthetic-message',
      };
      const receipt = {
        ownerId: 'redis-cortex-owner',
        messageId: 'redis-cortex-follow-up',
        parentMessageId: 'redis-cortex-parent',
        revision: 1,
        generation: 2,
        deliveryIds: ['redis-cortex-delivery'],
        deliveryReceipts: [
          { deliveryId: 'redis-cortex-delivery', graphResultHash: 'a'.repeat(64) },
        ],
        claimToken: 'redis-cortex-claim',
        presentationLeaseToken: 'redis-cortex-lease',
      };
      const boundPresentation = await GenerationJobManager.bindCortexPresentation(
        streamId,
        receipt,
      );

      const first = await GenerationJobManager.acknowledgeDelivery(
        acknowledgement,
        'telegram',
        receipt,
      );
      const replay = await GenerationJobManager.acknowledgeDelivery(
        acknowledgement,
        'telegram',
        receipt,
      );

      expect(first).toMatchObject({
        status: 'recorded',
        idempotent: false,
        presentation: {
          userId: 'redis-cortex-owner',
          responseMessageId: 'redis-cortex-parent',
          cortexPresentation: {
            ownerId: 'redis-cortex-owner',
            messageId: 'redis-cortex-follow-up',
            parentMessageId: 'redis-cortex-parent',
            generation: 2,
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
      await expect(GenerationJobManager.getJob(streamId)).resolves.toMatchObject({
        metadata: {
          deliveryAcknowledgement: expect.objectContaining(acknowledgement),
          cortexPresentation: first.presentation!.cortexPresentation,
        },
      });
      await GenerationJobManager.destroy();
    });

    test('should create and manage jobs via Redis', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { createStreamServices } = await import('../createStreamServices');

      // Create Redis services
      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      expect(services.isRedis).toBe(true);

      GenerationJobManager.configure(services);
      await GenerationJobManager.initialize();

      const streamId = `redis-job-${Date.now()}`;
      const userId = 'test-user-redis';

      // Create job (async)
      const job = await GenerationJobManager.createJob(streamId, userId);
      expect(job.streamId).toBe(streamId);

      // Verify in Redis
      const hasJob = await GenerationJobManager.hasJob(streamId);
      expect(hasJob).toBe(true);

      // Update and verify
      await GenerationJobManager.updateMetadata(streamId, { sender: 'RedisAgent' });
      const updated = await GenerationJobManager.getJob(streamId);
      expect(updated?.metadata?.sender).toBe('RedisAgent');

      await GenerationJobManager.destroy();
    });

    test('should persist chunks for cross-instance resume', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { createStreamServices } = await import('../createStreamServices');

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      await GenerationJobManager.initialize();

      const streamId = `redis-chunks-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      // Emit chunks (these should be persisted to Redis)
      // emitChunk takes { event, data } format, now async for Redis ordering
      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_run_step',
        data: {
          id: 'step-1',
          runId: 'run-1',
          index: 0,
          stepDetails: { type: 'message_creation' },
        },
      });
      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: {
          id: 'step-1',
          delta: { content: { type: 'text', text: 'Persisted ' } },
        },
      });
      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: {
          id: 'step-1',
          delta: { content: { type: 'text', text: 'content' } },
        },
      });

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Simulate getting resume state (as if from different instance)
      const resumeState = await GenerationJobManager.getResumeState(streamId);

      expect(resumeState).not.toBeNull();
      expect(resumeState!.aggregatedContent?.length).toBeGreaterThan(0);

      await GenerationJobManager.destroy();
    });

    test('should handle abort and return content', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { createStreamServices } = await import('../createStreamServices');

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      await GenerationJobManager.initialize();

      const streamId = `redis-abort-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      // Emit some content (emitChunk takes { event, data } format, now async)
      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_run_step',
        data: {
          id: 'step-1',
          runId: 'run-1',
          index: 0,
          stepDetails: { type: 'message_creation' },
        },
      });
      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: {
          id: 'step-1',
          delta: { content: { type: 'text', text: 'Partial response...' } },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Abort the job
      const abortResult = await GenerationJobManager.abortJob(streamId);

      expect(abortResult.success).toBe(true);
      expect(abortResult.content.length).toBeGreaterThan(0);

      await GenerationJobManager.destroy();
    });
  });

  describe('Cross-Mode Consistency', () => {
    test('should have consistent API between in-memory and Redis modes', async () => {
      // This test verifies that the same operations work identically
      // regardless of backend mode

      const runTestWithMode = async (isRedis: boolean) => {
        await resetStreamModules();

        const { GenerationJobManager } = await import('../GenerationJobManager');

        if (isRedis && ioredisClient) {
          const { createStreamServices } = await import('../createStreamServices');
          GenerationJobManager.configure({
            ...createStreamServices({
              useRedis: true,
              redisClient: ioredisClient,
            }),
            cleanupOnComplete: false, // Keep job for verification
          });
        } else {
          const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
          const { InMemoryEventTransport } =
            await import('../implementations/InMemoryEventTransport');
          GenerationJobManager.configure({
            jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
            eventTransport: new InMemoryEventTransport(),
            isRedis: false,
            cleanupOnComplete: false,
          });
        }

        await GenerationJobManager.initialize();

        const streamId = `consistency-${isRedis ? 'redis' : 'inmem'}-${Date.now()}`;

        // Test sequence
        const job = await GenerationJobManager.createJob(streamId, 'user-1');
        expect(job.streamId).toBe(streamId);
        expect(job.status).toBe('running');

        const hasJob = await GenerationJobManager.hasJob(streamId);
        expect(hasJob).toBe(true);

        await GenerationJobManager.updateMetadata(streamId, {
          sender: 'ConsistencyAgent',
          responseMessageId: 'resp-123',
          voiceCallSessionId: 'call-session-consistency',
        });

        const updated = await GenerationJobManager.getJob(streamId);
        expect(updated?.metadata?.sender).toBe('ConsistencyAgent');
        expect(updated?.metadata?.responseMessageId).toBe('resp-123');
        expect(updated?.metadata?.voiceCallSessionId).toBe('call-session-consistency');

        await GenerationJobManager.completeJob(streamId);

        const completed = await GenerationJobManager.getJob(streamId);
        expect(completed?.status).toBe('complete');

        await GenerationJobManager.destroy();
      };

      // Test in-memory mode
      await runTestWithMode(false);

      // Test Redis mode if available
      if (ioredisClient) {
        await runTestWithMode(true);
      }
    });
  });

  describe('Cross-Replica Support (Redis)', () => {
    /**
     * Problem: In k8s with Redis and multiple replicas, when a user sends a message:
     * 1. POST /api/agents/chat hits Replica A, creates job
     * 2. GET /api/agents/chat/stream/:streamId hits Replica B
     * 3. Replica B calls getJob() which returned undefined because runtimeState
     *    was only in Replica A's memory
     * 4. Stream endpoint returns 404
     *
     * Fix: getJob() and subscribe() now lazily create runtime state from Redis
     * when the job exists in Redis but not in local memory.
     */
    test('should NOT return 404 when stream endpoint hits different replica than job creator', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');

      // === REPLICA A: Creates the job ===
      // Simulate Replica A creating the job directly in Redis
      // (In real scenario, this happens via GenerationJobManager.createJob on Replica A)
      const replicaAJobStore = new RedisJobStore(ioredisClient);
      await replicaAJobStore.initialize();

      const streamId = `cross-replica-404-test-${Date.now()}`;
      const userId = 'test-user';

      // Create job in Redis (simulates Replica A's createJob)
      await replicaAJobStore.createJob(streamId, userId);

      // === REPLICA B: Receives the stream request ===
      // Fresh GenerationJobManager that does NOT have this job in its local runtimeState
      await resetStreamModules();
      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { createStreamServices } = await import('../createStreamServices');

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      await GenerationJobManager.initialize();

      // This is what the stream endpoint does:
      // const job = await GenerationJobManager.getJob(streamId);
      // if (!job) return res.status(404).json({ error: 'Stream not found' });

      const job = await GenerationJobManager.getJob(streamId);

      // BEFORE FIX: job would be undefined → 404
      // AFTER FIX: job should exist via lazy runtime state creation
      expect(job).not.toBeNull();
      expect(job).toBeDefined();
      expect(job?.streamId).toBe(streamId);

      // The stream endpoint then calls subscribe:
      // const result = await GenerationJobManager.subscribe(streamId, onChunk, onDone, onError);
      // if (!result) return res.status(404).json({ error: 'Failed to subscribe' });

      const subscription = await GenerationJobManager.subscribe(
        streamId,
        () => {}, // onChunk
        () => {}, // onDone
        () => {}, // onError
      );

      // BEFORE FIX: subscription would be null → 404
      // AFTER FIX: subscription should succeed
      expect(subscription).not.toBeNull();
      expect(subscription).toBeDefined();
      expect(typeof subscription?.unsubscribe).toBe('function');

      // Cleanup
      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
      await replicaAJobStore.destroy();
    });

    test('should lazily create runtime state for jobs created on other replicas', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      // Simulate two instances - one creates job, other tries to get it
      const { createStreamServices } = await import('../createStreamServices');
      const { RedisJobStore } = await import('../implementations/RedisJobStore');

      // Instance 1: Create the job directly in Redis (simulating another replica)
      const jobStore = new RedisJobStore(ioredisClient);
      await jobStore.initialize();

      const streamId = `cross-replica-${Date.now()}`;
      const userId = 'test-user';

      // Create job data directly in jobStore (as if from another instance)
      await jobStore.createJob(streamId, userId);

      // Instance 2: Fresh GenerationJobManager that doesn't have this job in memory
      await resetStreamModules();
      const { GenerationJobManager } = await import('../GenerationJobManager');

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      await GenerationJobManager.initialize();

      // This should work even though the job was created by "another instance"
      // The manager should lazily create runtime state from Redis data
      const job = await GenerationJobManager.getJob(streamId);

      expect(job).not.toBeNull();
      expect(job?.streamId).toBe(streamId);
      expect(job?.status).toBe('running');

      // Should also be able to subscribe
      const chunks: unknown[] = [];
      const subscription = await GenerationJobManager.subscribe(streamId, (event) => {
        chunks.push(event);
      });

      expect(subscription).not.toBeNull();

      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
      await jobStore.destroy();
    });

    test('should persist syncSent to Redis for cross-replica consistency', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { createStreamServices } = await import('../createStreamServices');

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      await GenerationJobManager.initialize();

      const streamId = `sync-sent-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      // Initially syncSent should be false
      let wasSent = await GenerationJobManager.wasSyncSent(streamId);
      expect(wasSent).toBe(false);

      // Mark sync sent
      GenerationJobManager.markSyncSent(streamId);

      // Wait for async Redis update
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should now be true
      wasSent = await GenerationJobManager.wasSyncSent(streamId);
      expect(wasSent).toBe(true);

      // Verify it's actually in Redis by checking via jobStore
      const jobStore = services.jobStore;
      const jobData = await jobStore.getJob(streamId);
      expect(jobData?.syncSent).toBe(true);

      await GenerationJobManager.destroy();
    });

    test('should persist finalEvent to Redis for cross-replica access', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { createStreamServices } = await import('../createStreamServices');

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure({
        ...services,
        cleanupOnComplete: false, // Keep job for verification
      });
      await GenerationJobManager.initialize();

      const streamId = `final-event-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      // Emit done event with final data
      const finalEventData = {
        final: true,
        conversation: { conversationId: streamId },
        responseMessage: { text: 'Hello world' },
      };
      await GenerationJobManager.emitDone(streamId, finalEventData as never);

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify finalEvent is in Redis
      const jobStore = services.jobStore;
      const jobData = await jobStore.getJob(streamId);
      expect(jobData?.finalEvent).toBeDefined();

      const storedFinalEvent = JSON.parse(jobData!.finalEvent!);
      expect(storedFinalEvent.final).toBe(true);
      expect(storedFinalEvent.conversation.conversationId).toBe(streamId);

      await GenerationJobManager.destroy();
    });

    test('should emit cross-replica abort signal via Redis pub/sub', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { createStreamServices } = await import('../createStreamServices');

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      await GenerationJobManager.initialize();

      const streamId = `abort-signal-${Date.now()}`;
      const job = await GenerationJobManager.createJob(streamId, 'user-1');

      // Track if abort controller was signaled
      let abortSignaled = false;
      job.abortController.signal.addEventListener('abort', () => {
        abortSignaled = true;
      });

      // Wait for abort listener setup
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Abort the job - this should emit abort signal via Redis
      await GenerationJobManager.abortJob(streamId);

      // Wait for signal propagation
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The local abort controller should be signaled
      expect(abortSignaled).toBe(true);
      expect(job.abortController.signal.aborted).toBe(true);

      await GenerationJobManager.destroy();
    });

    test('should handle abort for lazily-initialized cross-replica jobs', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      // This test validates that jobs created on Replica A and lazily-initialized
      // on Replica B can still receive and handle abort signals.

      const { createStreamServices } = await import('../createStreamServices');
      const { RedisJobStore } = await import('../implementations/RedisJobStore');

      // === Replica A: Create job directly in Redis ===
      const replicaAJobStore = new RedisJobStore(ioredisClient);
      await replicaAJobStore.initialize();

      const streamId = `lazy-abort-${Date.now()}`;
      await replicaAJobStore.createJob(streamId, 'user-1');

      // === Replica B: Fresh manager that lazily initializes the job ===
      await resetStreamModules();
      const { GenerationJobManager } = await import('../GenerationJobManager');

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      await GenerationJobManager.initialize();

      // Get job triggers lazy initialization of runtime state
      const job = await GenerationJobManager.getJob(streamId);
      expect(job).not.toBeNull();

      // Track abort signal
      let abortSignaled = false;
      job!.abortController.signal.addEventListener('abort', () => {
        abortSignaled = true;
      });

      // Wait for abort listener to be set up via Redis subscription
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Abort the job - this should emit abort signal via Redis pub/sub
      // The lazily-initialized runtime should receive it
      await GenerationJobManager.abortJob(streamId);

      // Wait for signal propagation
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Verify the lazily-initialized job received the abort signal
      expect(abortSignaled).toBe(true);
      expect(job!.abortController.signal.aborted).toBe(true);

      await GenerationJobManager.destroy();
      await replicaAJobStore.destroy();
    });

    test('should abort generation when abort signal received from another replica', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      // This test simulates:
      // 1. Replica A creates a job and starts generation
      // 2. Replica B receives abort request and emits abort signal
      // 3. Replica A receives signal and aborts its AbortController

      const { createStreamServices } = await import('../createStreamServices');
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      // Create the job on "Replica A"
      const { GenerationJobManager } = await import('../GenerationJobManager');

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      await GenerationJobManager.initialize();

      const streamId = `cross-abort-${Date.now()}`;
      const job = await GenerationJobManager.createJob(streamId, 'user-1');

      let abortSignaled = false;
      job.abortController.signal.addEventListener('abort', () => {
        abortSignaled = true;
      });

      // Wait for abort listener to be set up via Redis subscription
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Simulate "Replica B" emitting abort signal directly via Redis
      // This is what would happen if abortJob was called on a different replica
      const subscriber2 = (ioredisClient as unknown as { duplicate: () => unknown }).duplicate();
      const replicaBTransport = new RedisEventTransport(
        ioredisClient as never,
        subscriber2 as never,
      );

      // Emit abort signal (as if from Replica B)
      replicaBTransport.emitAbort(streamId);

      // Wait for cross-replica signal propagation
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Replica A's abort controller should be signaled
      expect(abortSignaled).toBe(true);
      expect(job.abortController.signal.aborted).toBe(true);

      await replicaBTransport.destroy();
      (subscriber2 as { disconnect: () => void }).disconnect();
      await GenerationJobManager.destroy();
    });

    test('should handle wasSyncSent for cross-replica scenarios', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { createStreamServices } = await import('../createStreamServices');
      const { RedisJobStore } = await import('../implementations/RedisJobStore');

      // Create job directly in Redis with syncSent: true
      const jobStore = new RedisJobStore(ioredisClient);
      await jobStore.initialize();

      const streamId = `cross-sync-${Date.now()}`;
      await jobStore.createJob(streamId, 'user-1');
      await jobStore.updateJob(streamId, { syncSent: true });

      // Fresh manager that doesn't have this job locally
      await resetStreamModules();
      const { GenerationJobManager } = await import('../GenerationJobManager');

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      await GenerationJobManager.initialize();

      // wasSyncSent should check Redis even without local runtime
      const wasSent = await GenerationJobManager.wasSyncSent(streamId);
      expect(wasSent).toBe(true);

      await GenerationJobManager.destroy();
      await jobStore.destroy();
    });
  });

  describe('Sequential Event Ordering (Redis)', () => {
    /**
     * These tests verify that events are delivered in strict sequential order
     * when using Redis mode. This is critical because:
     * 1. LLM streaming tokens must arrive in order for coherent output
     * 2. Tool call argument deltas must be concatenated in order
     * 3. Run step events must precede their deltas
     *
     * The fix: emitChunk now awaits Redis publish to ensure ordered delivery.
     */
    test('should maintain strict order for rapid sequential emits', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      await resetStreamModules();
      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { createStreamServices } = await import('../createStreamServices');

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      await GenerationJobManager.initialize();

      const streamId = `order-rapid-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      const receivedIndices: number[] = [];

      const subscription = await GenerationJobManager.subscribe(streamId, (event) => {
        const data = event as { event: string; data: { index: number } };
        if (data.event === 'test') {
          receivedIndices.push(data.data.index);
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Emit 30 events rapidly - with await, they must arrive in order
      for (let i = 0; i < 30; i++) {
        await GenerationJobManager.emitChunk(streamId, {
          event: 'test',
          data: { index: i },
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify all events arrived in correct order
      expect(receivedIndices.length).toBe(30);
      for (let i = 0; i < 30; i++) {
        expect(receivedIndices[i]).toBe(i);
      }

      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
    });

    test('should maintain order for tool call argument deltas', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      await resetStreamModules();
      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { createStreamServices } = await import('../createStreamServices');

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      await GenerationJobManager.initialize();

      const streamId = `tool-args-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      const receivedArgs: string[] = [];

      const subscription = await GenerationJobManager.subscribe(streamId, (event) => {
        const data = event as {
          event: string;
          data: { delta: { tool_calls: { args: string }[] } };
        };
        if (data.event === 'on_run_step_delta') {
          receivedArgs.push(data.data.delta.tool_calls[0].args);
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Simulate streaming JSON args: {"code": "print('hello')"}
      const argChunks = ['{"', 'code', '": "', 'print', "('", 'hello', "')", '"}'];

      for (const chunk of argChunks) {
        await GenerationJobManager.emitChunk(streamId, {
          event: 'on_run_step_delta',
          data: {
            id: 'step-1',
            delta: {
              type: 'tool_calls',
              tool_calls: [{ index: 0, args: chunk }],
            },
          },
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 300));

      // This was the original bug - args would arrive scrambled without await
      expect(receivedArgs).toEqual(argChunks);
      expect(receivedArgs.join('')).toBe(`{"code": "print('hello')"}`);

      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
    });

    test('should maintain order: on_run_step before on_run_step_delta', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      await resetStreamModules();
      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { createStreamServices } = await import('../createStreamServices');

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      await GenerationJobManager.initialize();

      const streamId = `step-order-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      const receivedEvents: string[] = [];

      const subscription = await GenerationJobManager.subscribe(streamId, (event) => {
        const data = event as { event: string };
        receivedEvents.push(data.event);
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Emit in correct order: step first, then deltas
      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_run_step',
        data: { id: 'step-1', type: 'tool_calls', index: 0 },
      });

      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_run_step_delta',
        data: { id: 'step-1', delta: { type: 'tool_calls', tool_calls: [{ args: '{' }] } },
      });

      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_run_step_delta',
        data: { id: 'step-1', delta: { type: 'tool_calls', tool_calls: [{ args: '}' }] } },
      });

      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_run_step_completed',
        data: { id: 'step-1', result: { content: '{}' } },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify ordering: step -> deltas -> completed
      expect(receivedEvents).toEqual([
        'on_run_step',
        'on_run_step_delta',
        'on_run_step_delta',
        'on_run_step_completed',
      ]);

      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
    });

    test('should not block other streams when awaiting emitChunk', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      await resetStreamModules();
      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { createStreamServices } = await import('../createStreamServices');

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      await GenerationJobManager.initialize();

      const streamId1 = `concurrent-1-${Date.now()}`;
      const streamId2 = `concurrent-2-${Date.now()}`;

      await GenerationJobManager.createJob(streamId1, 'user-1');
      await GenerationJobManager.createJob(streamId2, 'user-2');

      const stream1Events: number[] = [];
      const stream2Events: number[] = [];

      const sub1 = await GenerationJobManager.subscribe(streamId1, (event) => {
        const data = event as { event: string; data: { index: number } };
        if (data.event === 'test') {
          stream1Events.push(data.data.index);
        }
      });

      const sub2 = await GenerationJobManager.subscribe(streamId2, (event) => {
        const data = event as { event: string; data: { index: number } };
        if (data.event === 'test') {
          stream2Events.push(data.data.index);
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Emit to both streams concurrently (simulating two LLM responses)
      const emitPromises: Array<ReturnType<typeof GenerationJobManager.emitChunk>> = [];
      for (let i = 0; i < 10; i++) {
        emitPromises.push(
          GenerationJobManager.emitChunk(streamId1, { event: 'test', data: { index: i } }),
        );
        emitPromises.push(
          GenerationJobManager.emitChunk(streamId2, { event: 'test', data: { index: i * 100 } }),
        );
      }
      await Promise.all(emitPromises);

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Each stream should have all events, in order within their stream
      expect(stream1Events.length).toBe(10);
      expect(stream2Events.length).toBe(10);

      // Verify each stream's internal order
      for (let i = 0; i < 10; i++) {
        expect(stream1Events[i]).toBe(i);
        expect(stream2Events[i]).toBe(i * 100);
      }

      sub1?.unsubscribe();
      sub2?.unsubscribe();
      await GenerationJobManager.destroy();
    });
  });

  describe('Error Preservation for Late Subscribers', () => {
    /**
     * These tests verify the fix for the race condition where errors
     * (like INPUT_LENGTH) occur before the SSE client connects.
     *
     * Problem: Error → emitError → completeJob → job deleted → client connects → 404
     * Fix: Store error, don't delete job immediately, send error to late subscriber
     */

    test('should store error in emitError for late-connecting subscribers', async () => {
      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

      GenerationJobManager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: false,
      });

      await GenerationJobManager.initialize();

      const streamId = `error-store-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      const errorMessage = '{ "type": "INPUT_LENGTH", "info": "234856 / 172627" }';

      // Emit error (no subscribers yet - simulates race condition)
      await GenerationJobManager.emitError(streamId, errorMessage);

      // Wait for async job store update
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify error is stored in job store
      const job = await GenerationJobManager.getJob(streamId);
      expect(job?.error).toBe(errorMessage);

      await GenerationJobManager.destroy();
    });

    test('should NOT delete job immediately when completeJob is called with error', async () => {
      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

      GenerationJobManager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: true, // Default behavior
      });

      await GenerationJobManager.initialize();

      const streamId = `error-no-delete-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      const errorMessage = 'Test error message';

      // Complete with error
      await GenerationJobManager.completeJob(streamId, errorMessage);

      // Job should still exist (not deleted)
      const hasJob = await GenerationJobManager.hasJob(streamId);
      expect(hasJob).toBe(true);

      // Job should have error status
      const job = await GenerationJobManager.getJob(streamId);
      expect(job?.status).toBe('error');
      expect(job?.error).toBe(errorMessage);

      await GenerationJobManager.destroy();
    });

    test('should send stored error to late-connecting subscriber', async () => {
      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

      GenerationJobManager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: true,
      });

      await GenerationJobManager.initialize();

      const streamId = `error-late-sub-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      const errorMessage = '{ "type": "INPUT_LENGTH", "info": "234856 / 172627" }';

      // Simulate race condition: error occurs before client connects
      await GenerationJobManager.emitError(streamId, errorMessage);
      await GenerationJobManager.completeJob(streamId, errorMessage);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Now client connects (late subscriber)
      let receivedError: string | undefined;
      const subscription = await GenerationJobManager.subscribe(
        streamId,
        () => {}, // onChunk
        () => {}, // onDone
        (error) => {
          receivedError = error;
        }, // onError
      );

      expect(subscription).not.toBeNull();

      // Wait for setImmediate in subscribe to fire
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Late subscriber should receive the stored error
      expect(receivedError).toBe(errorMessage);

      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
    });

    test('should prioritize error status over finalEvent in subscribe', async () => {
      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

      GenerationJobManager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: false,
      });

      await GenerationJobManager.initialize();

      const streamId = `error-priority-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      const errorMessage = 'Error should take priority';

      // Emit error and complete with error
      await GenerationJobManager.emitError(streamId, errorMessage);
      await GenerationJobManager.completeJob(streamId, errorMessage);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Subscribe and verify error is received (not a done event)
      let receivedError: string | undefined;
      let receivedDone = false;

      const subscription = await GenerationJobManager.subscribe(
        streamId,
        () => {},
        () => {
          receivedDone = true;
        },
        (error) => {
          receivedError = error;
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Error should be received, not done
      expect(receivedError).toBe(errorMessage);
      expect(receivedDone).toBe(false);

      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
    });

    test('should handle error preservation in Redis mode (cross-replica)', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { createStreamServices } = await import('../createStreamServices');
      const { RedisJobStore } = await import('../implementations/RedisJobStore');

      // === Replica A: Creates job and emits error ===
      const replicaAJobStore = new RedisJobStore(ioredisClient);
      await replicaAJobStore.initialize();

      const streamId = `redis-error-${Date.now()}`;
      const errorMessage = '{ "type": "INPUT_LENGTH", "info": "234856 / 172627" }';

      await replicaAJobStore.createJob(streamId, 'user-1');
      await replicaAJobStore.updateJob(streamId, {
        status: 'error',
        error: errorMessage,
        completedAt: Date.now(),
      });

      // === Replica B: Fresh manager receives client connection ===
      await resetStreamModules();
      const { GenerationJobManager } = await import('../GenerationJobManager');

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure({
        ...services,
        cleanupOnComplete: false,
      });
      await GenerationJobManager.initialize();

      // Client connects to Replica B (job created on Replica A)
      let receivedError: string | undefined;
      const subscription = await GenerationJobManager.subscribe(
        streamId,
        () => {},
        () => {},
        (error) => {
          receivedError = error;
        },
      );

      expect(subscription).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Error should be loaded from Redis and sent to subscriber
      expect(receivedError).toBe(errorMessage);

      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
      await replicaAJobStore.destroy();
    });

    test('error jobs should be cleaned up by periodic cleanup after TTL', async () => {
      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

      // Use a very short TTL for testing
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 100 });

      GenerationJobManager.configure({
        jobStore,
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: true,
      });

      await GenerationJobManager.initialize();

      const streamId = `error-cleanup-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      // Complete with error
      await GenerationJobManager.completeJob(streamId, 'Test error');

      // Job should exist immediately after error
      let hasJob = await GenerationJobManager.hasJob(streamId);
      expect(hasJob).toBe(true);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Trigger cleanup
      await jobStore.cleanup();

      // Job should be cleaned up after TTL
      hasJob = await GenerationJobManager.hasJob(streamId);
      expect(hasJob).toBe(false);

      await GenerationJobManager.destroy();
    });
  });

  describe('createStreamServices Auto-Detection', () => {
    test('should auto-detect Redis when USE_REDIS is true', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      // Force USE_REDIS to true
      process.env.USE_REDIS = 'true';
      await resetStreamModules();

      const { createStreamServices } = await import('../createStreamServices');
      const services = createStreamServices();

      // Should detect Redis
      expect(services.isRedis).toBe(true);
      services.eventTransport.destroy();

      const { ioredisClient: autoIoRedisClient, keyvRedisClient: autoKeyvRedisClient } =
        await import('../../cache/redisClients');
      await closeRedisClient(autoIoRedisClient);
      await closeRedisClient(autoKeyvRedisClient);
    });

    test('should fall back to in-memory when USE_REDIS is false', async () => {
      process.env.USE_REDIS = 'false';
      await resetStreamModules();

      const { createStreamServices } = await import('../createStreamServices');
      const services = createStreamServices();

      expect(services.isRedis).toBe(false);
    });

    test('should allow forcing in-memory via config override', async () => {
      const { createStreamServices } = await import('../createStreamServices');
      const services = createStreamServices({ useRedis: false });

      expect(services.isRedis).toBe(false);
    });

    test('should retain completed jobs for late resume by default', async () => {
      const { GenerationJobManager } = await import('../GenerationJobManager');
      const { createStreamServices } = await import('../createStreamServices');

      const services = createStreamServices({
        useRedis: false,
        inMemoryOptions: { ttlAfterComplete: 60000 },
      });

      expect(services.cleanupOnComplete).toBe(false);

      GenerationJobManager.configure(services);
      await GenerationJobManager.initialize();

      const streamId = `services-late-success-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      const finalEvent = {
        event: 'final',
        final: true,
        data: { text: 'done' },
      };

      await GenerationJobManager.emitDone(streamId, finalEvent as never);
      await GenerationJobManager.completeJob(streamId);

      const retainedJob = await GenerationJobManager.getJob(streamId);
      expect(retainedJob?.status).toBe('complete');

      let receivedDone: unknown;
      const subscription = await GenerationJobManager.subscribe(
        streamId,
        () => {},
        (event) => {
          receivedDone = event;
        },
      );

      expect(subscription).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(receivedDone).toEqual(finalEvent);

      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
    });
  });
});
