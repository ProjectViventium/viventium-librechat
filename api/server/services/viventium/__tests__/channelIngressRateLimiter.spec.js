/**
 * === VIVENTIUM START ===
 * Feature: Durable channel ingress quotas.
 * Purpose: Prove distinct paired/unpaired burst limits, one rejection notice, and window recovery.
 * === VIVENTIUM END ===
 */

const { ChannelIngressRateLimiter } = require('../channelIngressRateLimiter');

function createModel() {
  const records = new Map();
  const matches = (record, filter) => {
    if (!record || record.quotaKey !== filter.quotaKey) {
      return false;
    }
    if (filter.eventKeys?.$ne != null && record.eventKeys.includes(filter.eventKeys.$ne)) {
      return false;
    }
    if (filter.count?.$lt != null && !(record.count < filter.count.$lt)) {
      return false;
    }
    if (filter.count?.$eq != null && record.count !== filter.count.$eq) {
      return false;
    }
    if (
      Object.hasOwn(filter, 'rejectedDedupeKey') &&
      record.rejectedDedupeKey !== filter.rejectedDedupeKey
    ) {
      return false;
    }
    return true;
  };
  return {
    records,
    updateOne: async ({ quotaKey }, update) => {
      if (records.has(quotaKey)) {
        return { upsertedCount: 0 };
      }
      records.set(quotaKey, { ...update.$setOnInsert });
      return { upsertedCount: 1 };
    },
    findOneAndUpdate: async (filter, update) => {
      const record = records.get(filter.quotaKey);
      if (!matches(record, filter)) {
        return null;
      }
      for (const [field, amount] of Object.entries(update.$inc || {})) {
        record[field] += amount;
      }
      for (const [field, value] of Object.entries(update.$push || {})) {
        record[field].push(value);
      }
      Object.assign(record, update.$set || {});
      return { ...record, eventKeys: [...record.eventKeys] };
    },
    findOne: ({ quotaKey }) => ({
      lean: async () => {
        const record = records.get(quotaKey);
        return record ? { ...record, eventKeys: [...record.eventKeys] } : null;
      },
    }),
  };
}

const envelope = {
  channel: 'whatsapp',
  accountId: 'phone-1',
  externalUserId: 'synthetic-user',
};

describe('ChannelIngressRateLimiter', () => {
  it.each([
    ['unpaired', 2],
    ['paired', 4],
  ])('limits %s bursts and emits only one paid rejection notice', async (tier, limit) => {
    const limiter = new ChannelIngressRateLimiter({
      model: createModel(),
      resolveTier: async () => tier,
      limits: { paired: 4, unpaired: 2 },
      windowMs: 60_000,
      now: () => 1_000,
    });
    const results = [];
    for (let index = 0; index < limit + 3; index += 1) {
      results.push(await limiter.reserve(envelope, `event-${index}`));
    }
    expect(results.filter((result) => result.accepted)).toHaveLength(limit);
    expect(results.filter((result) => result.notify)).toHaveLength(1);
  });

  it('recovers automatically in the next fixed window', async () => {
    let timestamp = 1_000;
    const limiter = new ChannelIngressRateLimiter({
      model: createModel(),
      resolveTier: async () => 'unpaired',
      limits: { paired: 2, unpaired: 1 },
      windowMs: 10_000,
      now: () => timestamp,
    });
    await expect(limiter.reserve(envelope, 'event-1')).resolves.toMatchObject({ accepted: true });
    await expect(limiter.reserve(envelope, 'event-2')).resolves.toMatchObject({
      accepted: false,
      notify: true,
    });
    timestamp = 11_000;
    await expect(limiter.reserve(envelope, 'event-3')).resolves.toMatchObject({ accepted: true });
  });

  it('stops rotating unpaired identities at the account-wide cap', async () => {
    const limiter = new ChannelIngressRateLimiter({
      model: createModel(),
      resolveTier: async () => 'unpaired',
      limits: { paired: 10, unpaired: 10 },
      accountLimits: { paired: 10, unpaired: 2 },
      windowMs: 60_000,
      now: () => 1_000,
    });
    await expect(
      limiter.reserve({ ...envelope, externalUserId: 'rotating-1' }, 'event-1'),
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      limiter.reserve({ ...envelope, externalUserId: 'rotating-2' }, 'event-2'),
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      limiter.reserve({ ...envelope, externalUserId: 'rotating-3' }, 'event-3'),
    ).resolves.toMatchObject({ accepted: false, notify: true });
  });

  it('counts provider retries once and bounds receipts after the cap', async () => {
    const model = createModel();
    const limiter = new ChannelIngressRateLimiter({
      model,
      resolveTier: async () => 'unpaired',
      limits: { paired: 2, unpaired: 1 },
      accountLimits: { paired: 2, unpaired: 1 },
      windowMs: 60_000,
      now: () => 1_000,
    });
    await limiter.reserve(envelope, 'same-event');
    await limiter.reserve(envelope, 'same-event');
    await limiter.reserve(envelope, 'first-rejected');
    for (let index = 0; index < 100; index += 1) {
      await limiter.reserve({ ...envelope, externalUserId: `rotating-${index}` }, `flood-${index}`);
    }
    expect(model.records.size).toBe(2);
    expect(Math.max(...[...model.records.values()].map((record) => record.eventKeys.length))).toBe(
      2,
    );
  });

  it('atomically admits exactly the limit under a parallel unique flood', async () => {
    const model = createModel();
    const limit = 10;
    const limiter = new ChannelIngressRateLimiter({
      model,
      resolveTier: async () => 'unpaired',
      limits: { paired: limit, unpaired: limit },
      accountLimits: { paired: limit, unpaired: limit },
      windowMs: 60_000,
      now: () => 1_000,
    });

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, index) => limiter.reserve(envelope, `parallel-${index}`)),
    );

    expect(results.filter((result) => result.accepted)).toHaveLength(limit);
    expect(results.filter((result) => result.notify)).toHaveLength(1);
    expect(model.records.size).toBe(2);
    for (const record of model.records.values()) {
      expect(record.count).toBeLessThanOrEqual(limit + 1);
      expect(record.eventKeys).toHaveLength(record.count);
    }
  });

  it('rejects an exhausted identity before consuming capacity shared by other identities', async () => {
    const limiter = new ChannelIngressRateLimiter({
      model: createModel(),
      resolveTier: async () => 'unpaired',
      limits: { paired: 1, unpaired: 1 },
      accountLimits: { paired: 2, unpaired: 2 },
      windowMs: 60_000,
      now: () => 1_000,
    });

    await expect(limiter.reserve(envelope, 'identity-a-accepted')).resolves.toMatchObject({
      accepted: true,
    });
    await expect(limiter.reserve(envelope, 'identity-a-rejected')).resolves.toMatchObject({
      accepted: false,
      notify: true,
    });
    await expect(
      limiter.reserve({ ...envelope, externalUserId: 'synthetic-user-b' }, 'identity-b-accepted'),
    ).resolves.toMatchObject({ accepted: true });
  });

  it('preserves shared capacity during a parallel flood from one strict identity bucket', async () => {
    const limiter = new ChannelIngressRateLimiter({
      model: createModel(),
      resolveTier: async () => 'unpaired',
      limits: { paired: 5, unpaired: 5 },
      accountLimits: { paired: 6, unpaired: 6 },
      windowMs: 60_000,
      now: () => 1_000,
    });

    const flooded = await Promise.all(
      Array.from({ length: 100 }, (_, index) => limiter.reserve(envelope, `identity-a-${index}`)),
    );
    const otherIdentity = await limiter.reserve(
      { ...envelope, externalUserId: 'synthetic-user-b' },
      'identity-b-accepted',
    );

    expect(flooded.filter((result) => result.accepted)).toHaveLength(5);
    expect(flooded.filter((result) => result.notify)).toHaveLength(1);
    expect(otherIdentity).toMatchObject({ accepted: true });
  });
});
