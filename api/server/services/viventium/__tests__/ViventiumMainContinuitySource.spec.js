'use strict';

const mockMessageFind = jest.fn();
const mockConversationFind = jest.fn();
jest.mock('@librechat/api', () => ({
  createMainContinuityService: (dependencies) => dependencies,
}));
jest.mock('@librechat/data-schemas', () => ({ logger: { warn: jest.fn() } }));
jest.mock(
  '~/db/models',
  () => ({
    Message: { find: (...args) => mockMessageFind(...args) },
    Conversation: { find: (...args) => mockConversationFind(...args) },
    ViventiumMainContinuityState: {},
  }),
  { virtual: true },
);

const { loadPresentations } = require('../ViventiumMainContinuityService');

test('loads an owner-bound internal parent only as input to the canonical source validator', async () => {
  const parent = {
    user: 'owner',
    messageId: 'parent',
    conversationId: 'conversation',
    isCreatedByUser: true,
    metadata: { viventium: { visibility: 'internal' } },
  };
  const assistant = {
    user: 'owner',
    messageId: 'result',
    parentMessageId: 'parent',
    conversationId: 'conversation',
    isCreatedByUser: false,
  };
  const conversation = { user: 'owner', conversationId: 'conversation' };
  mockMessageFind.mockImplementation((filter) => ({
    lean: async () => {
      if (filter.user !== 'owner') return [];
      if (filter.isCreatedByUser === true) {
        return filter['metadata.viventium.visibility'] ? [] : [parent];
      }
      return [assistant];
    },
  }));
  mockConversationFind.mockReturnValue({ lean: async () => [conversation] });
  await expect(loadPresentations('owner', ['result'])).resolves.toEqual([
    { assistant, userMessage: parent, conversation },
  ]);
  expect(mockMessageFind).toHaveBeenNthCalledWith(2, {
    user: 'owner',
    messageId: { $in: ['parent'] },
    isCreatedByUser: true,
  });
});
