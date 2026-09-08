'use strict';
const mockDependencies = {};
jest.mock('@librechat/api', () => ({
  createMainContinuityService: (dependencies) => {
    Object.assign(mockDependencies, dependencies);
    return {};
  },
}));
jest.mock('~/db/models', () => ({
  Message: { find: jest.fn(), findOne: jest.fn() },
  Conversation: { find: jest.fn(), findOne: jest.fn() },
  ViventiumMainContinuityState: { findOne: jest.fn(), create: jest.fn(), updateOne: jest.fn() },
}));
jest.mock('~/models', () => ({
  readAcceptedMainHistory: jest.fn(),
  readLegacyMainInput: jest.fn(),
  fenceAcceptedMainCompaction: jest.fn(),
  projectAcceptedMainPresentation: jest.fn(),
}));
jest.mock('../GlassHiveTerminalCallbackTransaction', () => ({
  runGlassHiveTerminalCallbackTransaction: jest.fn(),
}));
require('../ViventiumMainContinuityService');
const methods = require('~/models');
const { Message, Conversation } = require('~/db/models');
const {
  runGlassHiveTerminalCallbackTransaction,
} = require('../GlassHiveTerminalCallbackTransaction');

test('shares native accepted history across actual epochs without a timestamp-based history owner', async () => {
  const identity = {
    ownerId: 'owner',
    agentId: 'main',
    continuityDomainId: 'domain',
    contextEpoch: 'epoch',
  };
  const options = { after: 4, through: 9, limit: 3 };
  const cursor = { state: 'legacy-state', message: 'legacy-message' };
  methods.readAcceptedMainHistory.mockResolvedValue({ position: 9, turns: [] });
  methods.readLegacyMainInput.mockResolvedValue({ artifact: null, complete: true });
  expect(await mockDependencies.history.read(identity, options)).toEqual({
    position: 9,
    turns: [],
  });
  expect(methods.readAcceptedMainHistory).toHaveBeenCalledWith(identity, options);
  expect(await mockDependencies.history.legacy(identity, cursor)).toMatchObject({ complete: true });
  expect(methods.readLegacyMainInput).toHaveBeenCalledWith(identity, cursor);
  expect(mockDependencies.persistence.readLatestDomain).toBeUndefined();
});

test('acceptance and promotion use the same existing transaction owner', async () => {
  const identity = { ownerId: 'owner', agentId: 'main', continuityDomainId: 'domain' };
  const turns = [{ assistantMessageId: 'answer', userMessageId: 'request' }];
  const operation = async () => ({ status: 'committed' });
  await mockDependencies.history.fence(identity, turns, operation);
  expect(methods.fenceAcceptedMainCompaction).toHaveBeenCalledWith(
    identity,
    turns,
    operation,
    runGlassHiveTerminalCallbackTransaction,
  );
  await mockDependencies.commitPresentation(identity, turns[0], operation);
  expect(methods.projectAcceptedMainPresentation).toHaveBeenCalledWith(
    identity,
    turns[0],
    operation,
    runGlassHiveTerminalCallbackTransaction,
  );
});

test.each(['loadPresentation', 'loadPresentations'])(
  '%s does not run parallel hydration queries inside an inherited transaction',
  async (method) => {
    const assistant = { messageId: 'answer', parentMessageId: 'request', conversationId: 'chat' };
    const userMessage = { messageId: 'request' };
    const conversation = { conversationId: 'chat' };
    let active = false;
    const query = (value) => ({
      lean: async () => {
        if (active) throw new Error('parallel_query_in_transaction');
        active = true;
        await new Promise((resolve) => setImmediate(resolve));
        active = false;
        return value;
      },
    });
    Message.findOne.mockImplementation((filter) =>
      query(filter.messageId === 'answer' ? assistant : userMessage),
    );
    Conversation.findOne.mockImplementation(() => query(conversation));
    Message.find.mockImplementation((filter) =>
      query(filter.messageId.$in.includes('answer') ? [assistant] : [userMessage]),
    );
    Conversation.find.mockImplementation(() => query([conversation]));
    const expected = { assistant, userMessage, conversation };
    await expect(
      mockDependencies[method]('owner', method === 'loadPresentation' ? 'answer' : ['answer']),
    ).resolves.toEqual(method === 'loadPresentation' ? expected : [expected]);
  },
);
