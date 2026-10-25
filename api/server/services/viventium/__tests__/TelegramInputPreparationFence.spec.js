/* === VIVENTIUM START === Mongo preparation fences preserve earlier recoverable source order. === */
const matches = require('sift').default;
const mockIngress = { exists: jest.fn() };
let mockRows = [];

jest.mock(
  '@librechat/api',
  () => ({
    createTelegramInputService: () => ({}),
    telegramIngressDedupeTtlSeconds: () => 86400,
    telegramTerminalPresentationScope: jest.fn(),
    GenerationJobManager: {},
  }),
  { virtual: true },
);
jest.mock('~/db/models', () => ({
  ViventiumTelegramIngressEvent: mockIngress,
  Message: {},
}));
jest.mock('~/models', () => ({ getFiles: jest.fn() }));
jest.mock('../../TelegramLinkService', () => ({ resolveTelegramMapping: jest.fn() }));
jest.mock('../GlassHiveTerminalCallbackTransaction', () => ({
  runGlassHiveTerminalCallbackTransaction: (operation) => operation(),
}));
jest.mock('../nativeResponseService', () => ({ mutateNativeResponseSources: jest.fn() }));
jest.mock('../telegramCommittedDelivery', () => ({ committedDeliveryFilter: jest.fn() }));
jest.mock('../TelegramIngressAuthorityService', () => ({
  readRetainedTelegramTerminal: jest.fn(),
  acknowledgeRetainedTelegramFailure: jest.fn(),
}));

const { hasEarlierPreparingInput, hasNewerUnresolvedInput } =
  jest.requireActual('../TelegramInputService');
const NOW = 2_000_000_000_000;
const current = Object.freeze({
  libreChatUserId: 'owner-a',
  telegramUserId: 'sender-a',
  telegramChatId: 'chat-a',
  telegramMessageThreadId: 'thread-a',
  sourceOrderScope: 'a'.repeat(64),
  conversationGeneration: 'b'.repeat(64),
  conversationId: 'conversation-a',
  sourceSequence: 20,
});

function earlier(overrides = {}) {
  return {
    ...current,
    sourceEventId: 'c'.repeat(64),
    sourceSequence: 19,
    inputState: 'preparing',
    inputLeaseUntil: NOW - 1,
    inputRetryAt: 0,
    inputAttempts: 0,
    inputPreparedDigest: '',
    streamId: '',
    ...overrides,
  };
}

function failed(overrides = {}) {
  return earlier({ inputState: 'failed', inputRetryAt: NOW + 60_000, ...overrides });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRows = [];
  mockIngress.exists.mockImplementation(async (filter) =>
    mockRows.some(matches(filter)) ? { _id: 'synthetic-match' } : null,
  );
});

test('the actual adapter queries exact stored scope and recoverable preparation states without a lease deadline', async () => {
  mockRows = [earlier({ inputLeaseUntil: 0 })];
  await expect(hasEarlierPreparingInput(current)).resolves.toBe(true);
  expect(mockIngress.exists).toHaveBeenCalledTimes(1);
  expect(mockIngress.exists).toHaveBeenCalledWith({
    libreChatUserId: current.libreChatUserId,
    telegramUserId: current.telegramUserId,
    telegramChatId: current.telegramChatId,
    telegramMessageThreadId: current.telegramMessageThreadId,
    sourceOrderScope: current.sourceOrderScope,
    conversationGeneration: current.conversationGeneration,
    conversationId: current.conversationId,
    sourceSequence: { $lt: current.sourceSequence },
    $or: [
      { inputState: 'preparing' },
      {
        inputState: 'failed',
        inputRetryAt: { $gt: 0 },
        inputAttempts: { $lt: 3 },
        streamId: { $in: ['', null] },
        inputPreparedDigest: { $in: ['', null] },
      },
    ],
  });
});

test.each([
  ['expired preparation', () => earlier({ inputLeaseUntil: NOW - 60_000 })],
  ['active preparation', () => earlier({ inputLeaseUntil: NOW + 60_000 })],
  [
    'preparation without a lease field',
    () => {
      const row = earlier();
      delete row.inputLeaseUntil;
      return row;
    },
  ],
  ['retryable failure already due', () => failed({ inputRetryAt: NOW - 1 })],
  ['retryable failure not yet due', () => failed({ inputRetryAt: NOW + 60_000, inputAttempts: 2 })],
  [
    'unprepared retry with null carriers',
    () => failed({ streamId: null, inputPreparedDigest: null }),
  ],
  [
    'unprepared retry with absent carriers',
    () => {
      const row = failed();
      delete row.streamId;
      delete row.inputPreparedDigest;
      return row;
    },
  ],
])('%s still blocks a later sibling', async (_name, fixture) => {
  mockRows = [fixture()];
  await expect(hasEarlierPreparingInput(current)).resolves.toBe(true);
});

test.each([
  ['ready input', { inputState: 'ready' }],
  ['admitted input', { inputState: 'admitted' }],
  ['completed input', { inputState: 'completed' }],
  ['cancelled input', { inputState: 'cancelled' }],
  ['terminal failure', { inputState: 'failed', inputRetryAt: 0 }],
  ['retry-exhausted failure', { inputState: 'failed', inputRetryAt: NOW + 1, inputAttempts: 3 }],
  ['over-limit legacy failure', { inputState: 'failed', inputRetryAt: NOW + 1, inputAttempts: 4 }],
  [
    'failed input already admitted to a stream',
    { inputState: 'failed', inputRetryAt: NOW + 1, streamId: 'stream-a' },
  ],
  [
    'failed input already prepared',
    { inputState: 'failed', inputRetryAt: NOW + 1, inputPreparedDigest: 'd'.repeat(64) },
  ],
])('%s does not hold the preparation fence', async (_name, overrides) => {
  mockRows = [earlier(overrides)];
  await expect(hasEarlierPreparingInput(current)).resolves.toBe(false);
});

test.each([
  ['owner', { libreChatUserId: 'owner-b' }],
  ['Telegram sender', { telegramUserId: 'sender-b' }],
  ['chat', { telegramChatId: 'chat-b' }],
  ['thread', { telegramMessageThreadId: 'thread-b' }],
  ['conversation', { conversationId: 'conversation-b' }],
  ['conversation generation', { conversationGeneration: 'e'.repeat(64) }],
  ['source-order scope', { sourceOrderScope: 'f'.repeat(64) }],
])('an earlier preparation from another %s cannot block this input', async (_name, overrides) => {
  mockRows = [earlier(overrides)];
  await expect(hasEarlierPreparingInput(current)).resolves.toBe(false);
});

test.each([20, 21])('source sequence %s is not an earlier preparation', async (sourceSequence) => {
  mockRows = [earlier({ sourceSequence })];
  await expect(hasEarlierPreparingInput(current)).resolves.toBe(false);
});

test('foreign and terminal rows do not hide one valid recoverable earlier sibling', async () => {
  mockRows = [
    earlier({ libreChatUserId: 'owner-b' }),
    earlier({ inputState: 'completed' }),
    failed({ inputRetryAt: NOW + 60_000, inputAttempts: 2 }),
  ];
  await expect(hasEarlierPreparingInput(current)).resolves.toBe(true);
});

test('an unavailable ingress query remains a failure instead of an empty result', async () => {
  const unavailable = new Error('synthetic ingress unavailable');
  mockIngress.exists.mockRejectedValueOnce(unavailable);
  await expect(hasEarlierPreparingInput(current)).rejects.toBe(unavailable);
});

test.each([
  ['expired preparation', { inputState: 'preparing', inputLeaseUntil: 0 }],
  ['ready prepared input', { inputState: 'ready', inputPreparedDigest: 'd'.repeat(64) }],
  ['admitted input', { inputState: 'admitted', streamId: 'stream-a' }],
  [
    'retryable unprepared failure already due',
    { inputState: 'failed', inputRetryAt: NOW - 1, inputAttempts: 2 },
  ],
  [
    'retryable unprepared failure not yet due',
    { inputState: 'failed', inputRetryAt: NOW + 60_000, inputAttempts: 2 },
  ],
])('a newer %s remains unresolved', async (_name, overrides) => {
  mockRows = [earlier({ sourceSequence: 21, ...overrides })];
  await expect(hasNewerUnresolvedInput(current)).resolves.toBe(true);
  expect(mockIngress.exists).toHaveBeenCalledWith(
    expect.objectContaining({
      ...current,
      sourceSequence: { $gt: current.sourceSequence },
    }),
  );
});

test.each([
  ['completed input', { inputState: 'completed' }],
  ['cancelled input', { inputState: 'cancelled' }],
  ['terminal failure', { inputState: 'failed', inputRetryAt: 0 }],
  ['retry-exhausted failure', { inputState: 'failed', inputRetryAt: NOW + 1, inputAttempts: 3 }],
  [
    'failed input already admitted',
    { inputState: 'failed', inputRetryAt: NOW + 1, streamId: 'stream-a' },
  ],
  [
    'failed input already prepared',
    { inputState: 'failed', inputRetryAt: NOW + 1, inputPreparedDigest: 'd'.repeat(64) },
  ],
])('a newer %s does not acquire the unresolved preparation fence', async (_name, overrides) => {
  mockRows = [earlier({ sourceSequence: 21, ...overrides })];
  await expect(hasNewerUnresolvedInput(current)).resolves.toBe(false);
});

test.each([
  ['owner', { libreChatUserId: 'owner-b' }],
  ['Telegram sender', { telegramUserId: 'sender-b' }],
  ['chat', { telegramChatId: 'chat-b' }],
  ['thread', { telegramMessageThreadId: 'thread-b' }],
  ['conversation', { conversationId: 'conversation-b' }],
  ['conversation generation', { conversationGeneration: 'e'.repeat(64) }],
  ['source-order scope', { sourceOrderScope: 'f'.repeat(64) }],
])(
  'a newer retryable preparation from another %s is outside this unresolved fence',
  async (_name, overrides) => {
    mockRows = [failed({ sourceSequence: 21, inputAttempts: 2, ...overrides })];
    await expect(hasNewerUnresolvedInput(current)).resolves.toBe(false);
  },
);
/* === VIVENTIUM END === */
