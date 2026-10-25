import fs from 'fs';
import os from 'os';
import path from 'path';
import Redis from 'ioredis';
import type { Command } from 'ioredis';
import { spawn } from 'child_process';
import { createServer } from 'net';
import { once } from 'events';
import type { ChildProcess } from 'child_process';
import { RedisJobStore } from '../implementations/RedisJobStore';
import { rapidInputContract } from './rapidInput.helper';
import { generationSupersessionContract } from './generationSupersession.helper';

/** The Redis integration CI job provisions this binary; unit CI has no Redis prerequisite. */
describe('rapid input with owned Redis storage', () => {
  let server: ChildProcess;
  let redis: Redis;
  let scratch: string;
  beforeAll(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-rapid-input-'));
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    });
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    server = spawn(
      process.env.VIVENTIUM_TEST_REDIS_SERVER ?? 'redis-server',
      [
        '--bind',
        '127.0.0.1',
        '--port',
        String(port),
        '--save',
        '',
        '--appendonly',
        'no',
        '--dir',
        scratch,
      ],
      { stdio: 'ignore' },
    );
    redis = new Redis({
      host: '127.0.0.1',
      port,
      maxRetriesPerRequest: 0,
      retryStrategy: () => 25,
    });
    redis.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      redis.once('connect', resolve);
      server.once('error', reject);
      server.once('exit', (code) => reject(new Error(`Owned Redis exited: ${code}`)));
    });
    if (!(await redis.info('server')).includes(`process_id:${server.pid}\r\n`))
      throw new Error('Test Redis ownership not proven');
  });
  afterAll(async () => {
    redis?.disconnect();
    if (server?.pid && server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      await exited;
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await redis.flushdb();
  });
  test('source-order native deadline bounds a queued observation and a late older command cannot rewind its prefixed authority', async () => {
    const client = redis.duplicate({ lazyConnect: true, keyPrefix: 'deadline-fixture::' });
    client.on('error', () => {});
    await client.connect();
    const store = new RedisJobStore(client, { sourceOrderTimeoutMs: 25 });
    const scope = 'd'.repeat(64);
    const send = client.sendCommand.bind(client);
    const held: Command[] = [];
    const hold = jest.spyOn(client, 'sendCommand').mockImplementation((command) => {
      held.push(command);
      return command.promise;
    });
    let failure: Error | undefined;
    const pending = store
      .observeSourceOrder({ source_order_scope: scope, source_sequence: 1 })
      .catch((error: Error) => {
        failure = error;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rejectedBeforeRecovery = failure;
    hold.mockRestore();
    try {
      const newer = await store.observeSourceOrder({
        source_order_scope: scope,
        source_sequence: 2,
      });
      expect(newer.latest_source_sequence).toBe(2);
      // Redis may still execute the timed-out command. The exact monotonic operation cannot
      // rewind a newer authenticated source or perform job admission or external actions.
      await send(held[0]).catch(() => undefined);
      await client.ping();
      await pending;
      const after = await store.observeSourceOrder({
        source_order_scope: scope,
        source_sequence: 1,
      });
      expect(after).toMatchObject({ latest_source_sequence: 2, stale: true });
      expect(rejectedBeforeRecovery?.message).toBe('Command timed out');
      const keys = held[0].getKeys();
      expect(keys.every((key) => String(key).startsWith('deadline-fixture::'))).toBe(true);
      expect(await redis.exists(...keys.map(String))).toBe(1);
      expect(
        await redis.exists(...keys.map((key) => String(key).replace('deadline-fixture::', ''))),
      ).toBe(0);
    } finally {
      client.disconnect();
    }
  });
  rapidInputContract(() => new RedisJobStore(redis));
  generationSupersessionContract(() => new RedisJobStore(redis));
});
