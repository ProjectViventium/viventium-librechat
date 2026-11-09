jest.mock('@librechat/api', () => ({ nativeCoordinatorResultEventId: jest.fn() }));
jest.mock('mongoose', () => ({ connection: { collection: jest.fn() } }));
jest.mock('~/db/models', () => ({}));
jest.mock('../CortexInsightDeliveryService', () => ({ cortexInsightDeliveryService: {} }));
jest.mock('../GlassHiveAccountService', () => ({ requestAccountApi: jest.fn() }));
jest.mock('../nativeCoordinatorPresentation', () => ({
  createNativeCoordinatorPresentationService: (dependencies) => dependencies,
  bindNativeResultAuthority: jest.fn(),
}));
const { requestAccountApi } = require('../GlassHiveAccountService');
const { readPublications } = require('../NativeCoordinatorPresentationService');
const binding = { ownerId: 'owner', nativeConversationId: 'native-chat' };

beforeEach(() => jest.clearAllMocks());

test('drains the existing owner-scoped metadata pages without clipping retained publications', async () => {
  requestAccountApi
    .mockResolvedValueOnce({
      conversation_id: 'native-chat',
      publications: [{ event_id: 'event-1' }],
      next_cursor: 'event-1',
    })
    .mockResolvedValueOnce({
      conversation_id: 'native-chat',
      publications: [{ event_id: 'event-2' }],
      next_cursor: null,
    });
  await expect(readPublications(binding)).resolves.toEqual([
    { event_id: 'event-1' },
    { event_id: 'event-2' },
  ]);
  expect(requestAccountApi.mock.calls).toEqual([
    [{ ownerId: 'owner', path: '/v1/coordinator/conversations/native-chat/publications' }],
    [
      {
        ownerId: 'owner',
        path: '/v1/coordinator/conversations/native-chat/publications?cursor=event-1',
      },
    ],
  ]);
});

test('rejects a repeated metadata cursor instead of losing ownership through a partial read', async () => {
  requestAccountApi.mockResolvedValue({
    conversation_id: 'native-chat',
    publications: [],
    next_cursor: 'same',
  });
  await expect(readPublications(binding)).rejects.toMatchObject({
    code: 'coordinator_publication_cursor_repeated',
  });
});

test.each([
  { conversation_id: 'foreign', publications: [], next_cursor: null },
  { conversation_id: 'native-chat', publications: null, next_cursor: null },
  { conversation_id: 'native-chat', publications: [], next_cursor: 7 },
])('rejects invalid metadata response identity and shape', async (page) => {
  requestAccountApi.mockResolvedValue(page);
  await expect(readPublications(binding)).rejects.toMatchObject({
    code: 'coordinator_publication_metadata_invalid',
  });
});
