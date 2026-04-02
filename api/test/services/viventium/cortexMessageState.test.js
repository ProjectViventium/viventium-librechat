let mockGetMessage;
let mockGetMessages;

jest.mock('~/models', () => ({
  getMessage: (...args) => mockGetMessage(...args),
  getMessages: (...args) => mockGetMessages(...args),
}));

describe('cortexMessageState', () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetMessage = jest.fn();
    mockGetMessages = jest.fn();
  });

  test('resolves deferred placeholder parent to the best completed insight when follow-up is absent', async () => {
    const { getCortexMessageState } = require('~/server/services/viventium/cortexMessageState');

    mockGetMessage.mockResolvedValueOnce({
      messageId: 'msg-1',
      conversationId: 'conv-1',
      text: 'Checking now.',
      unfinished: true,
      content: [
        {
          type: 'cortex_insight',
          status: 'complete',
          cortex_name: 'Google',
          insight:
            'I read the doc. Short version: the profile is more plausibly O-1A than O-1B if the achievements are framed around business impact and measurable recognition.',
        },
        {
          type: 'cortex_insight',
          status: 'complete',
          cortex_name: 'Deep Research',
          insight:
            'For a 2026 O-1 assessment, the decisive questions are sustained acclaim, judging/critical role evidence, and whether counsel overstated weak criteria.',
        },
      ],
    });
    mockGetMessages.mockResolvedValueOnce([]);

    const state = await getCortexMessageState({
      userId: 'user-1',
      messageId: 'msg-1',
      conversationId: 'conv-1',
    });

    expect(state.followUp).toBeNull();
    expect(state.canonicalText).toBe(
      'I read the doc. Short version: the profile is more plausibly O-1A than O-1B if the achievements are framed around business impact and measurable recognition.',
    );
  });

  test('does not override canonical text while cortex work is still active', async () => {
    const { getCortexMessageState } = require('~/server/services/viventium/cortexMessageState');

    mockGetMessage.mockResolvedValueOnce({
      messageId: 'msg-2',
      conversationId: 'conv-1',
      text: 'Checking now.',
      unfinished: true,
      content: [
        {
          type: 'cortex_brewing',
          status: 'brewing',
          cortex_name: 'Google',
        },
        {
          type: 'cortex_insight',
          status: 'complete',
          cortex_name: 'Google',
          insight: 'Partial result that should not leak early.',
        },
      ],
    });
    mockGetMessages.mockResolvedValueOnce([]);

    const state = await getCortexMessageState({
      userId: 'user-1',
      messageId: 'msg-2',
      conversationId: 'conv-1',
    });

    expect(state.canonicalText).toBe('Checking now.');
  });
});
