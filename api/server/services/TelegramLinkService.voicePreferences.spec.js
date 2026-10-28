/* VIVENTIUM START: implicit preference scope uses the actual chat and optional topic. */
const mockMappingUpdate = jest.fn();
jest.mock('@librechat/data-schemas', () => ({ logger: { warn: jest.fn() } }));
jest.mock('@librechat/api', () => ({ getSessionCookieName: jest.fn(), isEnabled: jest.fn() }));
jest.mock('~/db/models', () => ({
  TelegramLinkToken: {},
  TelegramUserMapping: { updateOne: (...args) => mockMappingUpdate(...args) },
}));
const { touchTelegramMapping } = require('./TelegramLinkService');

beforeEach(() => mockMappingUpdate.mockResolvedValue({ matchedCount: 1 }));

test.each([
  ['private, no topic', '123', undefined, true],
  ['private, null topic', '123', null, true],
  ['private, empty topic', '123', '', true],
  ['private, blank topic', '123', '  ', true],
  ['private, numeric zero topic', '123', 0, false],
  ['private, string zero topic', '123', '0', false],
  ['private, numeric topic', '123', 7, false],
  ['private, string topic', '123', '7', false],
  ['group, no topic', '-100123', undefined, false],
  ['group, string topic', '-100123', '7', false],
  ['legacy absent chat/topic', undefined, undefined, true],
  ['legacy absent chat, present topic', undefined, '7', false],
])(
  '%s only syncs private owner preferences when unscoped',
  async (_label, telegramChatId, telegramMessageThreadId, permits) => {
    await touchTelegramMapping({
      telegramUserId: '123',
      telegramChatId,
      telegramMessageThreadId,
      telegramUsername: 'synthetic-user',
      alwaysVoiceResponse: false,
      replyVoiceWithVoice: true,
      voiceResponsesEnabled: false,
    });
    const [filter, update] = mockMappingUpdate.mock.calls.at(-1);
    expect(filter).toEqual({ telegramUserId: '123' });
    expect(update.$set).toEqual(
      expect.objectContaining({ lastSeenAt: expect.any(Date), telegramUsername: 'synthetic-user' }),
    );
    if (permits) {
      expect(update.$set).toEqual(
        expect.objectContaining({
          alwaysVoiceResponse: false,
          replyVoiceWithVoice: true,
          voiceResponsesEnabled: false,
          voicePrefsUpdatedAt: expect.any(Date),
        }),
      );
      return;
    }
    for (const field of [
      'alwaysVoiceResponse',
      'replyVoiceWithVoice',
      'voiceResponsesEnabled',
      'voicePrefsUpdatedAt',
    ])
      expect(update.$set).not.toHaveProperty(field);
  },
);
/* VIVENTIUM END */
