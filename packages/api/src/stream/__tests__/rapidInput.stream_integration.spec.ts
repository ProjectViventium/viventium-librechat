import fs from 'fs';
import os from 'os';
import path from 'path';
import Redis from 'ioredis';
import { spawn } from 'child_process';
import { createServer } from 'net';
import { once } from 'events';
import type { ChildProcess } from 'child_process';
import { RedisJobStore } from '../implementations/RedisJobStore';
import { rapidInputContract } from './rapidInput.helper';

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
  rapidInputContract(() => new RedisJobStore(redis));
});
