import Redis from 'ioredis';
import { spawn } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'net';
import { once } from 'events';
import type { ChildProcess } from 'child_process';
import {
  NATIVE_PUBLICATION_LUA,
  NATIVE_REPLAY_PUBLISH_LUA,
} from '../implementations/nativeResponseLua';
import { RedisJobStore } from '../implementations/RedisJobStore';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { RedisEventTransport } from '../implementations/RedisEventTransport';
import { GenerationJobManagerClass } from '../GenerationJobManager';
import { nativeStoreContract, admitted } from './nativeResponse.helper';
import { nativeIdentityJobProofJson } from '../implementations/nativeResponse';

/** Runs only against a fresh owned Redis process, never an ambient server. */
describe('native publication on actual Redis Cluster slots', () => {
  let redis: Redis;
  let server: ChildProcess;
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'viventium-native-redis-test-'));
    let port = 0;
    for (let attempt = 0; attempt < 100 && !port; attempt++) {
      const candidate = 20000 + Math.floor(Math.random() * 20000);
      const probes = [createServer(), createServer()];
      try {
        await Promise.all(
          probes.map(
            (probe, index) =>
              new Promise<void>((resolve, reject) => {
                probe.once('error', reject);
                probe.listen(candidate + index * 10000, '127.0.0.1', resolve);
              }),
          ),
        );
        port = candidate;
      } catch {
        /* Try another pair without touching any foreign process. */
      }
      await Promise.all(
        probes.map((probe) => new Promise<void>((resolve) => probe.close(() => resolve()))),
      );
    }
    if (!port) {
      throw new Error('No private test port pair');
    }
    server = spawn(
      process.env.VIVENTIUM_TEST_REDIS_SERVER ?? 'redis-server',
      [
        '--bind',
        '127.0.0.1',
        '--port',
        String(port),
        '--cluster-enabled',
        'yes',
        '--cluster-config-file',
        join(directory, 'nodes.conf'),
        '--cluster-require-full-coverage',
        'no',
        '--save',
        '',
        '--appendonly',
        'no',
        '--dir',
        directory,
        '--logfile',
        join(directory, 'redis.log'),
      ],
      { stdio: 'ignore' },
    );
    redis = new Redis({
      host: '127.0.0.1',
      port,
      enableReadyCheck: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => 25,
    });
    redis.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      redis.once('connect', resolve);
      server.once('error', reject);
      server.once('exit', (code) => reject(new Error(`Owned Redis exited: ${code}`)));
    });
    if (!(await redis.info('server')).includes(`process_id:${server.pid}\r\n`)) {
      throw new Error('Owned Redis process identity not proven');
    }
    await redis.cluster('ADDSLOTS', ...Array.from({ length: 16384 }, (_, index) => index));
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        await redis.set('owned-test-ready', '1');
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    throw new Error('Owned Redis cluster did not become ready');
  }, 15_000);
  beforeEach(async () => {
    await redis.flushdb();
  });
  afterAll(async () => {
    redis?.disconnect();
    if (server?.pid && server.exitCode === null) {
      server.kill('SIGTERM');
      await once(server, 'exit');
    }
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  nativeStoreContract(() => new RedisJobStore(redis));

  test('reusing a Redis conversation stream preserves the new revision and its output', async () => {
    const store = new RedisJobStore(redis);
    const transport = new RedisEventTransport(redis, redis.duplicate(), {
      ownsSubscriber: true,
    });
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: transport,
      cleanupOnComplete: false,
    });
    await manager.initialize();
    const create = (source: string) => manager.createJob('conversation', 'owner', 'conversation', {
      interactionContext: {
        actor_kind: 'external_user', origin: 'interactive', surface: 'web',
        conversation_id: 'conversation', revision: 1, source_event_id: source,
      },
      adapterCapabilities: { segment_stability: 'immediate', supersede_scope: 'response_and_authoring' },
    });
    try {
      const old = await create('old-input');
      await manager.updateMetadata('conversation', {
        responseMessageId: 'old-answer', userMessage: { messageId: 'old-input', text: 'Earlier input.' },
      });
      const oldJob = await store.getJob('conversation');
      const current = await create('new-input');
      expect(current.supersededPresentations).toEqual([expect.objectContaining({
        responseMessageId: 'old-answer', userMessageId: 'old-input',
        interactionContext: expect.objectContaining({ revision: 1 }),
      })]);
      expect(old.abortController.signal.aborted).toBe(true);
      expect(current.abortController.signal.aborted).toBe(false);
      expect(await store.getJob('conversation')).toMatchObject({ status: 'running',
        interactionContext: expect.objectContaining({ revision: 2 }) });
      expect((await store.getJob('conversation'))!.createdAt).toBeGreaterThan(oldJob!.createdAt);
      let received!: () => void;
      const delivered = new Promise<void>(resolve => { received = resolve; });
      const onChunk = jest.fn(() => received());
      const onDone = jest.fn();
      await manager.subscribe('conversation', onChunk, onDone);
      const output = { event: 'on_message_delta', data: { text: 'The new answer.' } };
      await manager.emitChunk('conversation', output as never);
      await delivered;
      expect(onChunk).toHaveBeenCalledWith(output);
      expect(onDone).not.toHaveBeenCalled();
      expect(current.abortController.signal.aborted).toBe(false);
      expect((await store.getJob('conversation'))?.finalEvent).toBeUndefined();
    } finally {
      await manager.destroy();
    }
  });

  test('aged native handoff keeps its renewed expiry and ordinary final through cleanup', async () => {
    const store = new RedisJobStore(redis, { runningTtl: 60 });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 120_000);
    const { identity } = await admitted(store);
    clock.mockRestore();
    try {
      expect(await store.bindNativeResponse(identity)).toBe(true);
      expect(await store.revokeNativeResponse(identity)).toEqual({
        status: 'revoked',
      });
      expect(await store.settleNativeResponse(identity, 'unsupported')).toBe(true);
      const key = `stream:{${identity.streamId}}:job`;
      await redis.pexpire(key, 20_000);
      const expiry = Date.now() + (await redis.pttl(key));
      expect(await store.cleanup()).toBe(0);
      expect(await store.settleNativeResponse(identity, 'unsupported')).toBe(true);
      expect((await store.getJob(identity.streamId))?.createdAt).toBe(identity.jobCreatedAt);
      expect(Math.abs(Date.now() + (await redis.pttl(key)) - expiry)).toBeLessThan(100);
      await store.updateJob(identity.streamId, {
        status: 'complete',
        finalEvent: 'The accepted fallback answer.',
      });
      expect((await store.getJob(identity.streamId))?.finalEvent).toBe(
        'The accepted fallback answer.',
      );
      expect(await store.getNativeResponseCommit(identity)).toEqual({
        status: 'revoked',
      });
    } finally {
      clock.mockRestore();
      await store.destroy();
    }
  });

  test('cleanup removes expired handoff membership without extending its lifetime', async () => {
    const store = new RedisJobStore(redis);
    try {
      const { identity } = await admitted(store);
      await store.bindNativeResponse(identity);
      await store.revokeNativeResponse(identity);
      await store.settleNativeResponse(identity, 'unsupported');
      await redis.pexpire(`stream:{${identity.streamId}}:job`, 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await store.cleanup()).toBe(1);
      expect(await store.getJob(identity.streamId)).toBeNull();
      expect(await redis.sismember('stream:running', identity.streamId)).toBe(0);
      expect(await store.settleNativeResponse(identity, 'unsupported')).toBe(false);
      expect(await store.getNativeResponseCommit(identity)).toEqual({
        status: 'revoked',
      });
    } finally {
      await store.destroy();
    }
  });

  test.each(['none', 'replacement', 'renewed expiry'])(
    'unexpiring stale cleanup preserves concurrent change: %s',
    async (change) => {
      const store = new RedisJobStore(redis, { runningTtl: 60 });
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 120_000);
      const old = await store.createJob('legacy-unexpiring', 'owner', 'conversation');
      clock.mockRestore();
      try {
        const key = 'stream:{legacy-unexpiring}:job';
        await redis.persist(key);
        const deleteJob = store.deleteJob.bind(store);
        jest.spyOn(store, 'deleteJob').mockImplementation(async (...args) => {
          if (change === 'replacement') {
            await store.createJob(old.streamId, 'owner', 'conversation', {
              responseMessageId: 'new',
            });
          } else if (change === 'renewed expiry') {
            await redis.pexpire(key, 20_000);
          }
          return deleteJob(...args);
        });
        await store.cleanup();
        if (change === 'replacement') {
          expect(await store.getJob(old.streamId)).toMatchObject({
            responseMessageId: 'new',
            status: 'running',
          });
          expect(await redis.pttl(key)).toBeGreaterThan(0);
        } else if (change === 'renewed expiry') {
          expect((await store.getJob(old.streamId))?.createdAt).toBe(old.createdAt);
          expect(await redis.pttl(key)).toBeGreaterThan(0);
        } else {
          expect(await store.getJob(old.streamId)).toBeNull();
        }
      } finally {
        jest.restoreAllMocks();
        await store.destroy();
      }
    },
  );

  test.each(['abort', 'done'] as const)(
    'a replacement admitted while cancelled %s publication waits cannot receive the old terminal event',
    async (eventType) => {
      const store = new RedisJobStore(redis);
      const transport = new RedisEventTransport(redis, redis.duplicate(), {
        ownsSubscriber: true,
      });
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const execute = redis.eval.bind(redis);
      try {
        const { identity } = await admitted(store);
        await store.bindNativeResponse(identity);
        await store.cancelNativeResponse((await store.getJob(identity.streamId))!);
        const final = { final: true, responseMessage: { text: 'Stopped.' } };
        const finalEvent = JSON.stringify(final);
        await store.finishNativeResponse(identity, '', finalEvent, 'cancelled');
        const onDone = jest.fn();
        const onAbort = jest.fn();
        await transport.subscribe(identity.streamId, {
          onChunk: jest.fn(),
          onDone,
        }).ready;
        await transport.onAbort(identity.streamId, onAbort);
        jest.spyOn(redis, 'eval').mockImplementation((...args) => {
          if (args[0] === NATIVE_REPLAY_PUBLISH_LUA) {
            entered();
            return gate.then(() => execute(...args));
          }
          return execute(...args);
        });
        // Deliberately stale local proof: the Redis publish boundary must own the decision.
        const guard = {
          identity,
          cancelled: true,
          finalEvent,
          isCurrent: () => true,
        };
        const publishing =
          eventType === 'abort'
            ? transport.emitAbort(identity.streamId, 'user_cancelled', guard)
            : transport.emitDone(identity.streamId, final, guard);
        await started;
        await store.createJob(identity.streamId, 'owner', 'conversation', {
          responseMessageId: 'replacement',
        });
        release();
        expect(await publishing).toBe(false);
        expect(onDone).not.toHaveBeenCalled();
        expect(onAbort).not.toHaveBeenCalled();
        expect((await store.getJob(identity.streamId))?.status).toBe('running');
      } finally {
        release();
        jest.restoreAllMocks();
        await transport.destroy();
        await store.destroy();
      }
    },
  );

  test('cancelled ABORT and DONE deliver internal incarnation evidence without changing FINAL', async () => {
    const store = new RedisJobStore(redis);
    const transport = new RedisEventTransport(redis, redis.duplicate(), {
      ownsSubscriber: true,
    });
    try {
      const { identity } = await admitted(store);
      await store.bindNativeResponse(identity);
      await store.cancelNativeResponse((await store.getJob(identity.streamId))!);
      const final = { final: true, responseMessage: { text: 'Stopped.' } };
      const finalEvent = JSON.stringify(final);
      await store.finishNativeResponse(identity, '', finalEvent, 'cancelled');
      const guard = {
        identity,
        cancelled: true,
        finalEvent,
        isCurrent: () => true,
      };
      let done!: () => void;
      let aborted!: () => void;
      const doneReceived = new Promise<void>((resolve) => {
        done = resolve;
      });
      const abortReceived = new Promise<void>((resolve) => {
        aborted = resolve;
      });
      const onDone = jest.fn(() => done());
      const onAbort = jest.fn(() => aborted());
      await transport.subscribe(identity.streamId, {
        onChunk: jest.fn(),
        onDone,
      }).ready;
      await transport.onAbort(identity.streamId, onAbort);
      expect(
        await transport.emitAbort(identity.streamId, 'user_cancelled', {
          ...guard,
          finalEvent: undefined,
        }),
      ).toBe(false);
      expect(
        await transport.emitDone(identity.streamId, final, {
          ...guard,
          cancelled: false,
        }),
      ).toBe(false);
      expect(await transport.emitAbort(identity.streamId, 'user_cancelled', guard)).toBe(true);
      expect(await transport.emitDone(identity.streamId, final, guard)).toBe(true);
      await Promise.all([abortReceived, doneReceived]);
      expect(onAbort).toHaveBeenCalledWith('user_cancelled', nativeIdentityJobProofJson(identity));
      expect(onDone).toHaveBeenCalledWith(final, nativeIdentityJobProofJson(identity));
      expect((await store.getJob(identity.streamId))?.finalEvent).toBe(finalEvent);
    } finally {
      await transport.destroy();
      await store.destroy();
    }
  });

  test('an unretired exact FINAL replays once to a late Redis subscriber', async () => {
    const store = new RedisJobStore(redis);
    const transport = new RedisEventTransport(redis, redis.duplicate(), {
      ownsSubscriber: true,
    });
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: transport,
    });
    manager.initialize();
    try {
      const { identity } = await admitted(store);
      await manager.bindNativeResponse(identity);
      await manager.commitNativeResponse(identity, 'a'.repeat(64));
      const final = {
        final: true,
        responseMessage: { messageId: 'assistant', text: 'Saved answer' },
      };
      await store.finishNativeResponse(identity, 'a'.repeat(64), JSON.stringify(final));
      let received!: () => void;
      const delivered = new Promise<void>((resolve) => {
        received = resolve;
      });
      const onDone = jest.fn(() => received());
      await manager.subscribe(identity.streamId, jest.fn(), onDone);
      await delivered;
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(onDone).toHaveBeenCalledWith(final);
      let secondReceived!: () => void;
      const secondDelivered = new Promise<void>((resolve) => {
        secondReceived = resolve;
      });
      const secondOnDone = jest.fn(() => secondReceived());
      await manager.subscribe(identity.streamId, jest.fn(), secondOnDone);
      await secondDelivered;
      expect(secondOnDone).toHaveBeenCalledTimes(1);
      expect(secondOnDone).toHaveBeenCalledWith(final);
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      await manager.destroy();
    }
  });

  test.each(['recovery', 'late subscription'])(
    'assistant retirement wins after %s reads FINAL but before Redis publishes it',
    async (path) => {
      const store = new RedisJobStore(redis);
      const peer = new RedisJobStore(redis);
      const transport = new RedisEventTransport(redis, redis.duplicate(), {
        ownsSubscriber: true,
      });
      const manager = new GenerationJobManagerClass({
        jobStore: store,
        eventTransport: transport,
      });
      manager.initialize();
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const execute = redis.eval.bind(redis);
      const delivered = jest.fn();
      try {
        const { identity } = await admitted(store);
        await manager.bindNativeResponse(identity);
        await manager.commitNativeResponse(identity, 'a'.repeat(64));
        const final = {
          final: true,
          responseMessage: { messageId: 'assistant', text: 'Saved answer' },
        };
        await store.finishNativeResponse(identity, 'a'.repeat(64), JSON.stringify(final));
        jest.spyOn(redis, 'eval').mockImplementation((...args) => {
          if (args[0] === NATIVE_REPLAY_PUBLISH_LUA) {
            entered();
            return gate.then(() => execute(...args));
          }
          return execute(...args);
        });
        const recovering =
          path === 'late subscription'
            ? manager.subscribe(identity.streamId, jest.fn(), delivered)
            : manager.finishNativeResponse(identity, final as never);
        await started;
        await peer.deleteJob(identity.streamId, identity);
        release();
        const result = await recovering;
        if (path === 'recovery') expect(result).toBe(false);
        expect(delivered).not.toHaveBeenCalled();
        expect(await manager.getJob(identity.streamId)).toBeUndefined();
        expect(await store.getNativeResponseCommit(identity)).toMatchObject({
          status: 'committed',
        });
      } finally {
        release();
        jest.restoreAllMocks();
        await manager.destroy();
        await peer.destroy();
      }
    },
  );

  test('all publication keys share a real slot, and retain exact deadline after error/restart/cleanup', async () => {
    const first = new RedisJobStore(redis, { runningTtl: 1, completedTtl: 1 });
    const { identity } = await admitted(first);
    await first.bindNativeResponse(identity);
    const keys = (await redis.keys('stream:*')).filter((key) =>
      /stream:(native|logical|source-order):/.test(key),
    );
    expect(keys).toHaveLength(3);
    const slots = await Promise.all(keys.map((key) => redis.cluster('KEYSLOT', key)));
    expect(new Set(slots).size).toBe(1);
    await expect(
      redis.eval('return 1', 2, keys[0], `stream:{${identity.streamId}}:job`),
    ).rejects.toThrow('CROSSSLOT');
    const jobKey = `stream:{${identity.streamId}}:job`;
    const deadline = async () => Date.now() + (await redis.pttl(jobKey));
    const originalExpiry = await deadline();
    await first.updateJob(identity.streamId, {
      status: 'error',
      completedAt: Date.now(),
    });
    await first.destroy();
    const restarted = new RedisJobStore(redis, {
      runningTtl: 1,
      completedTtl: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 1050));
    await restarted.cleanup();
    expect((await restarted.getJob(identity.streamId))?.nativeResponse).toEqual(identity);
    expect(Math.abs((await deadline()) - originalExpiry)).toBeLessThan(30);
    expect(await restarted.commitNativeResponse(identity, 'a'.repeat(64))).toEqual({
      status: 'committed',
      candidateSha256: 'a'.repeat(64),
    });
    await restarted.destroy();
  });
  test.each(['Stop first', 'commit first'])('causal publication race: %s', async (order) => {
    const store = new RedisJobStore(redis);
    const { identity, job } = await admitted(store);
    await store.bindNativeResponse(identity);
    const peer = new RedisJobStore(redis);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const execute = redis.eval.bind(redis);
    let held = false;
    const intercepted = jest.spyOn(redis, 'eval').mockImplementation((...args) => {
      const mode = order === 'Stop first' ? 'commit' : 'cancel';
      if (!held && args[0] === NATIVE_PUBLICATION_LUA && args[5] === mode) {
        held = true;
        entered();
        return gate.then(() => execute(...args));
      }
      return execute(...args);
    });
    const pending =
      order === 'Stop first'
        ? peer.commitNativeResponse(identity, 'a'.repeat(64))
        : peer.cancelNativeResponse(job);
    await started;
    const winner =
      order === 'Stop first'
        ? await store.cancelNativeResponse(job)
        : await store.commitNativeResponse(identity, 'a'.repeat(64));
    release();
    expect(winner.status).toBe(order === 'Stop first' ? 'revoked' : 'committed');
    expect((await pending).status).toBe(winner.status);
    intercepted.mockRestore();
    await store.destroy();
    await peer.destroy();
  });

  test('expiry is terminal even if a host restores after authority keys expired', async () => {
    const store = new RedisJobStore(redis);
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    const keys = await redis.keys('stream:native:*');
    await redis.del(keys[0]);
    expect(await store.commitNativeResponse(identity, 'a'.repeat(64))).toEqual({
      status: 'unavailable',
    });
    // An existing job binding cannot reconstruct vanished publication authority.
    expect(await store.bindNativeResponse(identity)).toBe(false);
    await store.destroy();
  });
  test('replay settlement alone releases job TTL while retaining the publication receipt', async () => {
    const store = new RedisJobStore(redis, { completedTtl: 1 });
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    expect(await store.settleNativeResponse(identity)).toBe(false);
    await store.commitNativeResponse(identity, 'a'.repeat(64));
    await store.finishNativeResponse(identity, 'a'.repeat(64), 'saved');
    const key = `stream:{${identity.streamId}}:job`;
    expect(await redis.pttl(key)).toBeGreaterThan(80_000_000);
    expect(await store.settleNativeResponse(identity)).toBe(true);
    expect(await redis.pttl(key)).toBeLessThanOrEqual(1000);
    expect(await store.getNativeResponseCommit(identity)).toMatchObject({
      status: 'committed',
    });
    await store.destroy();
  });
  test('external delivery keeps settled FINAL until the exact adapter acknowledgement', async () => {
    const store = new RedisJobStore(redis, { completedTtl: 1 });
    const { identity, job } = await admitted(store);
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    await store.updateJob(identity.streamId, {
      deliveryPolicy: { commit_authority: 'external_adapter' },
      interactionContext: { ...job.interactionContext!, surface: 'telegram' },
    });
    await store.bindNativeResponse(identity);
    await store.commitNativeResponse(identity, 'a'.repeat(64));
    await store.finishNativeResponse(identity, 'a'.repeat(64), 'saved');
    await store.settleNativeResponse(identity);
    const key = `stream:{${identity.streamId}}:job`;
    expect(await redis.pttl(key)).toBeGreaterThan(80_000_000);
    await store.updateJob(identity.streamId, {
      status: 'complete',
      completedAt: Date.now(),
    });
    expect(await redis.pttl(key)).toBeGreaterThan(80_000_000);
    await store.deleteJob(identity.streamId);
    expect(await store.hasJob(identity.streamId)).toBe(true);
    const acknowledgement = {
      logical_turn_id: identity.logicalTurnId,
      revision: identity.revision,
      state: 'committed' as const,
      presentation_ref: 'telegram:synthetic:1',
    };
    expect(
      (
        await manager.acknowledgeDelivery(
          { ...acknowledgement, revision: identity.revision + 1 },
          'telegram',
        )
      ).status,
    ).not.toBe('recorded');
    expect((await manager.acknowledgeDelivery(acknowledgement, 'voice')).status).toBe('conflict');
    expect(await redis.pttl(key)).toBeGreaterThan(80_000_000);
    expect((await manager.acknowledgeDelivery(acknowledgement, 'telegram')).status).toBe(
      'recorded',
    );
    expect(await redis.pttl(key)).toBeLessThanOrEqual(1000);
    await store.deleteJob(identity.streamId);
    expect(await store.hasJob(identity.streamId)).toBe(false);
    await manager.destroy();
  });
});
