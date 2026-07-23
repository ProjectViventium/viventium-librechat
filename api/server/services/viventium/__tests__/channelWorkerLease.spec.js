/**
 * === VIVENTIUM START ===
 * Feature: Distributed channel worker ownership.
 * Purpose: Prove same-process repair and cross-process generation handoff activate new credentials exactly once.
 * === VIVENTIUM END ===
 */

const { createChannelWorkerLeaseTransport } = require('../channelWorkerLease');

function createSharedModels(connection) {
  let lease = null;
  const leaseModel = {
    findOneAndUpdate: jest.fn((filter, update) => ({
      lean: async () => {
        const now = filter.$or[1].expiresAt.$lte;
        if (lease && lease.ownerId !== filter.$or[0].ownerId && lease.expiresAt > now) {
          const error = new Error('duplicate lease');
          error.code = 11000;
          throw error;
        }
        lease = { channel: filter.channel, accountId: filter.accountId, ...update.$set };
        return { ...lease };
      },
    })),
    updateOne: jest.fn(async (filter, update) => {
      if (
        !lease ||
        lease.ownerId !== filter.ownerId ||
        lease.configGeneration !== filter.configGeneration
      ) {
        return { matchedCount: 0 };
      }
      lease = { ...lease, ...update.$set };
      return { matchedCount: 1 };
    }),
    deleteOne: jest.fn(async (filter) => {
      if (lease?.ownerId === filter.ownerId) {
        lease = null;
      }
    }),
  };
  const connectionModel = {
    findOne: jest.fn(() => ({
      select: () => ({ lean: async () => ({ ...connection }) }),
    })),
  };
  return { leaseModel, connectionModel };
}

function createTransport(events, name) {
  return {
    channel: 'telegram',
    test: async () => ({ ok: true }),
    send: async () => undefined,
    start: async (connection) => events.push(`${name}:start:${connection.credentials.botToken}`),
    stop: async () => events.push(`${name}:stop`),
  };
}

describe('createChannelWorkerLeaseTransport', () => {
  it('restarts an owned account for an explicit same-account credential repair', async () => {
    const connection = { state: 'connected', configGeneration: 'g1' };
    const models = createSharedModels(connection);
    const events = [];
    const timers = [];
    const leased = createChannelWorkerLeaseTransport({
      transport: createTransport(events, 'A'),
      ...models,
      ownerId: 'A',
      logger: { warn: jest.fn() },
      setIntervalImpl: (fn) => (timers.push(fn), { unref() {} }),
      clearIntervalImpl: jest.fn(),
    });
    await expect(
      leased.start({
        channel: 'telegram',
        accountId: 'bot-1',
        configGeneration: 'g1',
        credentials: { botToken: 'old' },
      }),
    ).resolves.toBe(true);
    connection.configGeneration = 'g2';
    await expect(
      leased.start(
        {
          channel: 'telegram',
          accountId: 'bot-1',
          configGeneration: 'g2',
          credentials: { botToken: 'new' },
        },
        { mode: 'replace' },
      ),
    ).resolves.toBe(true);
    expect(events).toEqual(['A:start:old', 'A:stop', 'A:start:new']);
  });

  it('restarts a same-generation worker when persisted health is degraded', async () => {
    const connection = { state: 'connected', configGeneration: 'g1' };
    const models = createSharedModels(connection);
    const events = [];
    const leased = createChannelWorkerLeaseTransport({
      transport: createTransport(events, 'A'),
      ...models,
      ownerId: 'A',
      logger: { warn: jest.fn() },
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: jest.fn(),
    });
    const runtimeConnection = {
      channel: 'telegram',
      accountId: 'bot-1',
      configGeneration: 'g1',
      credentials: { botToken: 'synthetic' },
    };

    await expect(leased.start(runtimeConnection)).resolves.toBe(true);
    connection.state = 'degraded';
    await expect(leased.start(runtimeConnection)).resolves.toBe(true);

    expect(events).toEqual(['A:start:synthetic', 'A:stop', 'A:start:synthetic']);
    expect(models.leaseModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(models.leaseModel.deleteOne).toHaveBeenCalledTimes(1);
  });

  it('hands a staged generation from process A to process B without false activation', async () => {
    const connection = { state: 'connected', configGeneration: 'g1' };
    const models = createSharedModels(connection);
    const events = [];
    const timersA = [];
    const leasedA = createChannelWorkerLeaseTransport({
      transport: createTransport(events, 'A'),
      ...models,
      ownerId: 'A',
      logger: { warn: jest.fn() },
      setIntervalImpl: (fn) => (timersA.push(fn), { unref() {} }),
      clearIntervalImpl: jest.fn(),
    });
    const leasedB = createChannelWorkerLeaseTransport({
      transport: createTransport(events, 'B'),
      ...models,
      ownerId: 'B',
      logger: { warn: jest.fn() },
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: jest.fn(),
    });
    await leasedA.start({
      channel: 'telegram',
      accountId: 'bot-1',
      configGeneration: 'g1',
      credentials: { botToken: 'old' },
    });
    connection.state = 'verifying';
    connection.configGeneration = 'g2';
    await expect(
      leasedB.start(
        {
          channel: 'telegram',
          accountId: 'bot-1',
          configGeneration: 'g2',
          credentials: { botToken: 'new' },
        },
        { mode: 'replace' },
      ),
    ).resolves.toBe(false);
    timersA[0]();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(
      leasedB.start({
        channel: 'telegram',
        accountId: 'bot-1',
        configGeneration: 'g2',
        credentials: { botToken: 'new' },
      }),
    ).resolves.toBe(true);
    await leasedB.start({
      channel: 'telegram',
      accountId: 'bot-1',
      configGeneration: 'g2',
      credentials: { botToken: 'new' },
    });
    expect(events).toEqual(['A:start:old', 'A:stop', 'B:start:new']);
  });

  it('fences a stale renew callback so it cannot stop a replacement generation', async () => {
    const connection = { state: 'connected', configGeneration: 'g1' };
    const models = createSharedModels(connection);
    let releaseRead;
    const delayedRead = new Promise((resolve) => {
      releaseRead = resolve;
    });
    models.connectionModel.findOne.mockImplementationOnce(() => ({
      select: () => ({ lean: () => delayedRead }),
    }));
    const events = [];
    const timers = [];
    const leased = createChannelWorkerLeaseTransport({
      transport: createTransport(events, 'A'),
      ...models,
      ownerId: 'A',
      logger: { warn: jest.fn() },
      setIntervalImpl: (fn) => (timers.push(fn), { unref() {} }),
      clearIntervalImpl: jest.fn(),
    });
    await leased.start({
      channel: 'telegram',
      accountId: 'bot-1',
      configGeneration: 'g1',
      credentials: { botToken: 'old' },
    });
    timers[0]();
    await new Promise((resolve) => setImmediate(resolve));
    connection.configGeneration = 'g2';
    await leased.start(
      {
        channel: 'telegram',
        accountId: 'bot-1',
        configGeneration: 'g2',
        credentials: { botToken: 'new' },
      },
      { mode: 'replace' },
    );
    releaseRead({ state: 'connected', configGeneration: 'g2' });
    await new Promise((resolve) => setImmediate(resolve));
    await leased.start({
      channel: 'telegram',
      accountId: 'bot-1',
      configGeneration: 'g2',
      credentials: { botToken: 'new' },
    });
    expect(events).toEqual(['A:start:old', 'A:stop', 'A:start:new']);
  });

  it('ignores generation-scoped cleanup from a stale lifecycle operation', async () => {
    const connection = { state: 'connected', configGeneration: 'g2' };
    const models = createSharedModels(connection);
    const events = [];
    const leased = createChannelWorkerLeaseTransport({
      transport: createTransport(events, 'A'),
      ...models,
      ownerId: 'A',
      logger: { warn: jest.fn() },
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: jest.fn(),
    });
    await leased.start({
      channel: 'telegram',
      accountId: 'bot-1',
      configGeneration: 'g2',
      credentials: { botToken: 'new' },
    });

    await leased.stop('bot-1', 'g1');
    await expect(
      leased.start({
        channel: 'telegram',
        accountId: 'bot-1',
        configGeneration: 'g2',
        credentials: { botToken: 'new' },
      }),
    ).resolves.toBe(true);
    await leased.stop('bot-1', 'g2');

    expect(events).toEqual(['A:start:new', 'A:stop']);
  });

  it('renews ownership while provider startup is still pending', async () => {
    const connection = { state: 'verifying', configGeneration: 'g1' };
    const models = createSharedModels(connection);
    let finishStart;
    const pendingStart = new Promise((resolve) => {
      finishStart = resolve;
    });
    const timers = [];
    const transport = createTransport([], 'A');
    transport.start = jest.fn(() => pendingStart);
    const leased = createChannelWorkerLeaseTransport({
      transport,
      ...models,
      ownerId: 'A',
      logger: { warn: jest.fn() },
      leaseMs: 10,
      setIntervalImpl: (fn) => (timers.push(fn), { unref() {} }),
      clearIntervalImpl: jest.fn(),
    });
    const starting = leased.start({
      channel: 'telegram',
      accountId: 'bot-1',
      configGeneration: 'g1',
      credentials: { botToken: 'slow' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(timers).toHaveLength(1);
    timers[0]();
    await new Promise((resolve) => setImmediate(resolve));
    expect(models.leaseModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'A', configGeneration: 'g1' }),
      expect.anything(),
    );
    finishStart();
    await expect(starting).resolves.toBe(true);
  });
});
