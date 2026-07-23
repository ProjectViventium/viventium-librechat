/**
 * === VIVENTIUM START ===
 * Feature: Connected channel health policy.
 * Purpose: Prove transient failures do not deactivate delivery and auth/scope failures require repair.
 * === VIVENTIUM END ===
 */

const { classifyChannelHealth, updateOwnedChannelHealth } = require('../channelProviderHealth');

describe('classifyChannelHealth', () => {
  it.each(['rate_limited', 'connection_unavailable', 'connection_timeout'])(
    '%s remains retryable',
    (issueCode) => {
      expect(classifyChannelHealth(issueCode)).toEqual({ keepConnected: true, issueCode });
    },
  );

  it.each(['invalid_credentials', 'missing_permission'])(
    '%s pauses delivery for repair',
    (issueCode) => {
      expect(classifyChannelHealth(issueCode)).toEqual({
        keepConnected: false,
        state: 'reauth_required',
        issueCode,
      });
    },
  );

  it('ignores stale-process health after another owner takes the lease', async () => {
    const stopStale = jest.fn(async () => undefined);
    const connectionModel = { updateOne: jest.fn(async () => ({ matchedCount: 1 })) };
    await expect(
      updateOwnedChannelHealth({
        channel: 'telegram',
        accountId: 'bot-1',
        issueCode: 'connection_conflict',
        ownerId: 'A',
        sourceGeneration: 'g1',
        leaseModel: { findOne: () => ({ lean: async () => null }) },
        connectionModel,
        stopStale,
      }),
    ).resolves.toBe(false);
    expect(connectionModel.updateOne).not.toHaveBeenCalled();
    expect(stopStale).toHaveBeenCalledWith('g1');
  });

  it('does not stop an unidentifiable worker when a malformed health event omits its generation', async () => {
    const stopStale = jest.fn(async () => undefined);
    const connectionModel = { updateOne: jest.fn() };
    await expect(
      updateOwnedChannelHealth({
        channel: 'telegram',
        accountId: 'bot-1',
        issueCode: 'connection_conflict',
        ownerId: 'A',
        leaseModel: { findOne: jest.fn() },
        connectionModel,
        stopStale,
      }),
    ).resolves.toBe(false);
    expect(connectionModel.updateOne).not.toHaveBeenCalled();
    expect(stopStale).not.toHaveBeenCalled();
  });

  it('ignores health from an owner whose lease has expired', async () => {
    const stopStale = jest.fn(async () => undefined);
    const connectionModel = { updateOne: jest.fn() };
    const findOne = jest.fn((filter) => ({
      lean: async () => (filter.expiresAt.$gt > new Date(0) ? null : { configGeneration: 'g1' }),
    }));
    await expect(
      updateOwnedChannelHealth({
        channel: 'telegram',
        accountId: 'bot-1',
        issueCode: 'connection_conflict',
        ownerId: 'A',
        sourceGeneration: 'g1',
        leaseModel: { findOne },
        connectionModel,
        stopStale,
      }),
    ).resolves.toBe(false);
    expect(findOne.mock.calls[0][0].expiresAt.$gt).toBeInstanceOf(Date);
    expect(connectionModel.updateOne).not.toHaveBeenCalled();
    expect(stopStale).toHaveBeenCalledWith('g1');
  });

  it('updates health only for the active owner and generation', async () => {
    const connectionModel = { updateOne: jest.fn(async () => ({ matchedCount: 1 })) };
    await expect(
      updateOwnedChannelHealth({
        channel: 'telegram',
        accountId: 'bot-1',
        issueCode: 'rate_limited',
        ownerId: 'B',
        sourceGeneration: 'g2',
        leaseModel: { findOne: () => ({ lean: async () => ({ configGeneration: 'g2' }) }) },
        connectionModel,
        stopStale: jest.fn(),
      }),
    ).resolves.toBe(true);
    expect(connectionModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ configGeneration: 'g2', activeGeneration: 'g2' }),
      { $set: { issueCode: 'rate_limited' } },
    );
  });

  it('ignores a late health event emitted by a replaced credential generation', async () => {
    const stopStale = jest.fn(async () => undefined);
    const connectionModel = { updateOne: jest.fn(async () => ({ matchedCount: 1 })) };
    await expect(
      updateOwnedChannelHealth({
        channel: 'telegram',
        accountId: 'bot-1',
        issueCode: 'invalid_credentials',
        ownerId: 'A',
        sourceGeneration: 'generation-old',
        leaseModel: {
          findOne: () => ({
            lean: async () => ({ configGeneration: 'generation-replacement' }),
          }),
        },
        connectionModel,
        stopStale,
      }),
    ).resolves.toBe(false);
    expect(connectionModel.updateOne).not.toHaveBeenCalled();
    expect(stopStale).toHaveBeenCalledWith('generation-old');
  });
});
