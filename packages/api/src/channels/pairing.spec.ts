/**
 * === VIVENTIUM START ===
 * Feature: Local-friendly channel pairing.
 * Purpose: Prove pairing codes are hashed, expiring, one-use, rate-limited, and never reach the agent.
 * === VIVENTIUM END ===
 */

import { ChannelPairingService } from './index';
import type {
  ChannelPairingCodeRecord,
  ChannelPairingRepository,
  ChannelPairingScope,
} from './index';

class MemoryPairingRepository implements ChannelPairingRepository {
  records: ChannelPairingCodeRecord[] = [];
  attempts = new Map<string, number>();
  mappings: Array<{ scope: ChannelPairingScope; userId: string }> = [];

  async invalidate(
    channel: ChannelPairingCodeRecord['channel'],
    accountId: string,
    userId: string,
    now: Date,
  ) {
    for (const record of this.records) {
      if (
        record.channel === channel &&
        record.accountId === accountId &&
        record.libreChatUserId === userId &&
        !record.consumedAt
      ) {
        record.consumedAt = now;
      }
    }
  }

  async create(record: ChannelPairingCodeRecord): Promise<void> {
    this.records.push({ ...record });
  }

  async consumeAndBind(
    tokenHash: string,
    scope: ChannelPairingScope,
    now: Date,
  ): Promise<ChannelPairingCodeRecord | null> {
    const record = this.records.find(
      (candidate) =>
        candidate.tokenHash === tokenHash &&
        candidate.channel === scope.channel &&
        candidate.accountId === scope.accountId &&
        !candidate.consumedAt &&
        candidate.expiresAt.getTime() > now.getTime(),
    );
    if (!record) {
      return null;
    }
    record.consumedAt = now;
    this.mappings.push({ scope, userId: record.libreChatUserId });
    return { ...record };
  }

  async reserveAttempt(scopeKey: string, maximum: number): Promise<boolean> {
    const attempts = (this.attempts.get(scopeKey) ?? 0) + 1;
    this.attempts.set(scopeKey, attempts);
    return attempts <= maximum;
  }
}

describe('ChannelPairingService', () => {
  const scope: ChannelPairingScope = {
    channel: 'telegram',
    accountId: 'bot-1',
    externalUserId: 'user-1',
    externalUsername: 'synthetic_user',
  };

  it('creates only a hash at rest and consumes a code exactly once', async () => {
    const repository = new MemoryPairingRepository();
    const service = new ChannelPairingService({
      repository,
      randomCode: () => 'ABCD-EFGH',
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    const generated = await service.create('telegram', 'bot-1', 'admin-1');

    expect(generated.code).toBe('ABCD-EFGH');
    expect(repository.records[0].tokenHash).not.toContain('ABCD');
    await expect(service.consume(scope, 'ABCD-EFGH')).resolves.toEqual({ ok: true });
    await expect(service.consume(scope, 'ABCD-EFGH')).resolves.toEqual({
      ok: false,
      error: 'invalid_or_expired',
    });
    expect(repository.mappings).toEqual([{ scope, userId: 'admin-1' }]);
  });

  it('invalidates an earlier unconsumed code for the same admin connection', async () => {
    const repository = new MemoryPairingRepository();
    const codes = ['ABCD-EFGH', 'IJKL-MNOP'];
    const service = new ChannelPairingService({
      repository,
      randomCode: () => codes.shift() ?? 'QRST-UVWX',
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    await service.create('telegram', 'bot-1', 'admin-1');
    await service.create('telegram', 'bot-1', 'admin-1');

    await expect(service.consume(scope, 'ABCD-EFGH')).resolves.toEqual({
      ok: false,
      error: 'invalid_or_expired',
    });
    await expect(service.consume(scope, 'IJKL-MNOP')).resolves.toEqual({ ok: true });
  });

  it('fails expired codes and rate-limits repeated guesses by scoped external identity', async () => {
    const repository = new MemoryPairingRepository();
    const now = new Date('2026-01-01T00:00:00Z');
    const service = new ChannelPairingService({
      repository,
      randomCode: () => 'ABCD-EFGH',
      now: () => now,
      maximumAttempts: 2,
    });
    await service.create('telegram', 'bot-1', 'admin-1');
    now.setMinutes(now.getMinutes() + 11);

    expect(await service.consume(scope, 'ABCD-EFGH')).toEqual({
      ok: false,
      error: 'invalid_or_expired',
    });
    expect(await service.consume(scope, 'WRONG-CODE')).toEqual({
      ok: false,
      error: 'invalid_or_expired',
    });
    expect(await service.consume(scope, 'ANOTHER')).toEqual({
      ok: false,
      error: 'rate_limited',
    });
    expect(repository.mappings).toHaveLength(0);
  });
});
