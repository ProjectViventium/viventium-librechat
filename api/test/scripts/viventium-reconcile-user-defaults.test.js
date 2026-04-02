jest.mock('../../../api/db/connect', () => ({
  connectDb: jest.fn(),
}));

jest.mock('../../../api/db/models', () => ({
  User: {
    updateMany: jest.fn(),
  },
}));

jest.mock('mongoose', () => ({
  connection: {
    readyState: 1,
  },
  disconnect: jest.fn(),
}));

const { connectDb } = require('../../../api/db/connect');
const { User } = require('../../../api/db/models');
const mongoose = require('mongoose');
const {
  envFlagEnabled,
  buildMissingConversationRecallUpdate,
  reconcileUserDefaults,
  closeDbConnection,
} = require('../../../scripts/viventium-reconcile-user-defaults');

describe('viventium-reconcile-user-defaults', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mongoose.connection.readyState = 1;
  });

  test('parses installer boolean env flags consistently', () => {
    expect(envFlagEnabled('VIVENTIUM_DEFAULT_CONVERSATION_RECALL', {
      env: { VIVENTIUM_DEFAULT_CONVERSATION_RECALL: 'true' },
    })).toBe(true);
    expect(envFlagEnabled('VIVENTIUM_DEFAULT_CONVERSATION_RECALL', {
      env: { VIVENTIUM_DEFAULT_CONVERSATION_RECALL: '0' },
    })).toBe(false);
  });

  test('builds a missing-only conversation recall reconciliation update', () => {
    const plan = buildMissingConversationRecallUpdate({
      env: { VIVENTIUM_DEFAULT_CONVERSATION_RECALL: 'true' },
    });

    expect(plan).toEqual({
      conversation_recall: true,
      filter: {
        $or: [
          { personalization: { $exists: false } },
          { 'personalization.conversation_recall': { $exists: false } },
        ],
      },
      update: {
        $set: {
          'personalization.conversation_recall': true,
        },
      },
    });
  });

  test('reconciles only fresh users missing the conversation recall preference', async () => {
    connectDb.mockResolvedValue(undefined);
    User.updateMany.mockResolvedValue({ matchedCount: 2, modifiedCount: 2 });

    await expect(
      reconcileUserDefaults({
        env: { VIVENTIUM_DEFAULT_CONVERSATION_RECALL: 'false' },
      }),
    ).resolves.toEqual({
      conversation_recall: false,
      matchedCount: 2,
      modifiedCount: 2,
    });

    expect(connectDb).toHaveBeenCalledTimes(1);
    expect(User.updateMany).toHaveBeenCalledWith(
      {
        $or: [
          { personalization: { $exists: false } },
          { 'personalization.conversation_recall': { $exists: false } },
        ],
      },
      {
        $set: {
          'personalization.conversation_recall': false,
        },
      },
    );
  });

  test('closes mongoose after a successful reconciliation run', async () => {
    await closeDbConnection();

    expect(mongoose.disconnect).toHaveBeenCalledTimes(1);
  });

  test('does not disconnect when mongoose is already closed', async () => {
    mongoose.connection.readyState = 0;

    await closeDbConnection();

    expect(mongoose.disconnect).not.toHaveBeenCalled();
  });
});
