let mockGetMessage;
let mockGetMessages;
let mockGetAgent;

jest.mock('~/models', () => ({
  getMessage: (...args) => mockGetMessage(...args),
  getMessages: (...args) => mockGetMessages(...args),
}));

jest.mock('~/models/Agent', () => ({
  getAgent: (...args) => mockGetAgent(...args),
}));

describe('cortexMessageState', () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetMessage = jest.fn();
    mockGetMessages = jest.fn();
    mockGetAgent = jest.fn().mockResolvedValue(null);
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

  test('resolves configured hold text to best completed insight when no follow-up exists', async () => {
    const { getCortexMessageState } = require('~/server/services/viventium/cortexMessageState');

    mockGetMessage.mockResolvedValueOnce({
      messageId: 'msg-3',
      conversationId: 'conv-1',
      model: 'agent_main',
      text: '',
      unfinished: false,
      content: [
        {
          type: 'text',
          text: "I'm here. Shoot.",
        },
        {
          type: 'cortex_insight',
          status: 'complete',
          cortex_name: 'Google',
          insight:
            'I read the attached file. Short version: the launch plan is split into three tracks with outreach, future-living recon, and GTM workstreams.',
        },
      ],
    });
    mockGetMessages.mockResolvedValueOnce([]);
    mockGetAgent.mockResolvedValueOnce({
      id: 'agent_main',
      instructions: `
Holding Examples
- "I'm here. Shoot."
- "Checking now."
`,
    });

    const state = await getCortexMessageState({
      userId: 'user-1',
      messageId: 'msg-3',
      conversationId: 'conv-1',
    });

    expect(state.followUp).toBeNull();
    expect(state.canonicalText).toBe(
      'I read the attached file. Short version: the launch plan is split into three tracks with outreach, future-living recon, and GTM workstreams.',
    );
  });

  test('resolves tagged runtime hold without relying on hold phrase matching', async () => {
    const { getCortexMessageState } = require('~/server/services/viventium/cortexMessageState');

    mockGetMessage.mockResolvedValueOnce({
      messageId: 'msg-4',
      conversationId: 'conv-1',
      text: '',
      unfinished: false,
      content: [
        {
          type: 'text',
          text: 'Different hold wording entirely.',
          viventium_runtime_hold: true,
        },
        {
          type: 'cortex_insight',
          status: 'complete',
          cortex_name: 'Deep Research',
          insight:
            'The attached brief says the main blocker is pricing clarity before the customer outreach starts next week.',
        },
      ],
    });
    mockGetMessages.mockResolvedValueOnce([]);

    const state = await getCortexMessageState({
      userId: 'user-1',
      messageId: 'msg-4',
      conversationId: 'conv-1',
    });

    expect(state.canonicalText).toBe(
      'The attached brief says the main blocker is pricing clarity before the customer outreach starts next week.',
    );
  });

  test('returns clear deferred error when only low-signal insight remains after a hold', async () => {
    const { getCortexMessageState } = require('~/server/services/viventium/cortexMessageState');

    mockGetMessage.mockResolvedValueOnce({
      messageId: 'msg-5',
      conversationId: 'conv-1',
      model: 'agent_main',
      text: '',
      unfinished: false,
      content: [
        {
          type: 'text',
          text: "I'm here. Shoot.",
        },
        {
          type: 'cortex_insight',
          status: 'complete',
          cortex_name: 'Pattern Recognition',
          insight: 'Go ahead.',
        },
      ],
    });
    mockGetMessages.mockResolvedValueOnce([]);
    mockGetAgent.mockResolvedValueOnce({
      id: 'agent_main',
      instructions: `
Holding Examples
- "I'm here. Shoot."
`,
    });

    const state = await getCortexMessageState({
      userId: 'user-1',
      messageId: 'msg-5',
      conversationId: 'conv-1',
    });

    expect(state.canonicalText).toBe("I couldn't finish that check just now.");
  });
});
