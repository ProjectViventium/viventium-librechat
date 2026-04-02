/* === VIVENTIUM START ===
 * Feature: Voice cortex insight lookup parity
 * Added: 2026-02-21
 * === VIVENTIUM END === */

let mockGetMessage;
let mockGetMessages;

jest.mock('~/models', () => ({
  getMessage: (...args) => mockGetMessage(...args),
  getMessages: (...args) => mockGetMessages(...args),
}));

describe('VoiceCortexInsightsService', () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetMessage = jest.fn();
    mockGetMessages = jest.fn();
  });

  test('fetches follow-up by metadata.viventium.parentMessageId', async () => {
    const {
      getCompletedCortexInsightsForMessage,
    } = require('../VoiceCortexInsightsService');

    mockGetMessage.mockResolvedValueOnce({
      messageId: 'msg-1',
      conversationId: 'conv-1',
      content: [],
    });
    mockGetMessages.mockResolvedValueOnce([
      { messageId: 'follow-1', text: '  Follow-up text  ' },
    ]);

    const result = await getCompletedCortexInsightsForMessage({
      userId: 'user-1',
      messageId: 'msg-1',
      conversationId: 'conv-1',
    });

    expect(result.followUp).toEqual({
      messageId: 'follow-1',
      text: 'Follow-up text',
    });
    expect(mockGetMessages).toHaveBeenCalledWith({
      user: 'user-1',
      conversationId: 'conv-1',
      'metadata.viventium.parentMessageId': 'msg-1',
      'metadata.viventium.type': 'cortex_followup',
    });
  });
});
