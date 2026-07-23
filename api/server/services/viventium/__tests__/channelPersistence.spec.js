/**
 * === VIVENTIUM START ===
 * Feature: Connected Channels persistence readiness.
 * Purpose: Prove fresh-install index creation fails closed on pre-existing duplicate identities.
 * === VIVENTIUM END ===
 */

const {
  createChannelWorkerReconciler,
  createRetryableReadiness,
  ensureChannelPersistenceIndexes,
} = require('../channelPersistence');

function modelsWith(duplicateModel) {
  return Object.fromEntries(
    [
      'ChannelConnection',
      'ChannelThread',
      'ChannelPairingCode',
      'ChannelPairingAttempt',
      'GatewayUserMapping',
      'GatewayLinkToken',
      'ViventiumGatewayIngressEvent',
      'ChannelWorkerLease',
      'ChannelDelivery',
      'ChannelIngressQuota',
    ].map((name) => [
      name,
      {
        aggregate: jest.fn(async () => (name === duplicateModel ? [{ _id: {}, count: 2 }] : [])),
        createIndexes: jest.fn(async () => undefined),
      },
    ]),
  );
}

describe('ensureChannelPersistenceIndexes', () => {
  it('creates only the channel-owned model indexes on a clean database', async () => {
    const models = modelsWith();
    await ensureChannelPersistenceIndexes(models);
    expect(models.ChannelConnection.createIndexes).toHaveBeenCalledTimes(1);
    expect(models.ViventiumGatewayIngressEvent.createIndexes).toHaveBeenCalledTimes(1);
  });

  it('fails before index creation when a unique identity is already duplicated', async () => {
    const models = modelsWith('GatewayUserMapping');
    await expect(ensureChannelPersistenceIndexes(models)).rejects.toMatchObject({
      code: 'channel_index_conflict',
    });
    expect(models.ChannelConnection.createIndexes).not.toHaveBeenCalled();
  });
});

describe('createRetryableReadiness', () => {
  it('shares one in-flight attempt, retries a rejection, and caches the later success', async () => {
    let rejectFirst;
    const first = new Promise((_resolve, reject) => {
      rejectFirst = reject;
    });
    const initializer = jest.fn().mockReturnValueOnce(first).mockResolvedValueOnce(undefined);
    const ensureReady = createRetryableReadiness(initializer);

    const callerA = ensureReady();
    const callerB = ensureReady();
    expect(initializer).toHaveBeenCalledTimes(0);
    await Promise.resolve();
    expect(initializer).toHaveBeenCalledTimes(1);
    rejectFirst(new Error('synthetic index outage'));
    await expect(Promise.all([callerA, callerB])).rejects.toThrow('synthetic index outage');

    await expect(ensureReady()).resolves.toBeUndefined();
    await expect(ensureReady()).resolves.toBeUndefined();
    expect(initializer).toHaveBeenCalledTimes(2);
  });
});

describe('createChannelWorkerReconciler', () => {
  it('installs recovery before the first attempt and retries a startup readiness failure', async () => {
    const events = [];
    let periodicRetry;
    const timer = { unref: jest.fn() };
    const reconcile = jest
      .fn()
      .mockImplementationOnce(async () => {
        events.push('startup-failed');
        throw new Error('synthetic index outage');
      })
      .mockImplementationOnce(async () => {
        events.push('periodic-failed');
        throw new Error('synthetic restore outage');
      })
      .mockImplementationOnce(async () => {
        events.push('recovered');
      });
    const logger = { error: jest.fn(), warn: jest.fn() };
    const restore = createChannelWorkerReconciler({
      reconcile,
      logger,
      setIntervalImpl: (callback, intervalMs) => {
        events.push(`timer:${intervalMs}`);
        periodicRetry = callback;
        return timer;
      },
    });

    await expect(restore()).resolves.toBeUndefined();
    expect(events).toEqual(['timer:30000', 'startup-failed']);
    expect(timer.unref).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      '[VIVENTIUM][channels] Failed to restore channel workers after restart',
      { error: 'Error' },
    );

    periodicRetry();
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.warn).toHaveBeenCalledWith('[VIVENTIUM][channels] Worker reconciliation failed', {
      error: 'Error',
    });

    periodicRetry();
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(['timer:30000', 'startup-failed', 'periodic-failed', 'recovered']);
  });
});
