const {
  resolveLatestLeafMessageId,
  resolveReusableConversationState,
} = require('../conversationThreading');

let mockGetConvo;
let mockGetMessages;

jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  }),
  { virtual: true },
);

jest.mock('~/models', () => ({
  getConvo: (...args) => mockGetConvo(...args),
  getMessages: (...args) => mockGetMessages(...args),
}));

describe('conversationThreading', () => {
  beforeEach(() => {
    mockGetConvo = jest.fn().mockResolvedValue({
      conversationId: 'conv-1',
      endpoint: 'agents',
    });
    mockGetMessages = jest.fn().mockResolvedValue([]);
  });

  test('resolveLatestLeafMessageId prefers the newest leaf over the newest createdAt row', () => {
    const messages = [
      {
        messageId: 'root-user',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        createdAt: '2026-03-26T20:07:52.610Z',
      },
      {
        messageId: 'assistant-leaf',
        parentMessageId: 'root-user',
        createdAt: '2026-03-26T20:07:52.602Z',
      },
      {
        messageId: 'next-user',
        parentMessageId: 'root-user',
        createdAt: '2026-03-26T20:15:20.713Z',
      },
    ];

    expect(resolveLatestLeafMessageId(messages)).toBe('next-user');
  });

  test('resolveLatestLeafMessageId selects the assistant leaf when the latest user already has a child', () => {
    const messages = [
      {
        messageId: 'prior-user',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        createdAt: '2026-03-26T20:07:52.610Z',
      },
      {
        messageId: 'assistant-phase1',
        parentMessageId: 'prior-user',
        createdAt: '2026-03-26T20:07:52.602Z',
      },
      {
        messageId: 'new-user',
        parentMessageId: 'assistant-phase1',
        createdAt: '2026-03-26T20:15:20.713Z',
      },
      {
        messageId: 'assistant-phase2',
        parentMessageId: 'new-user',
        createdAt: '2026-03-26T20:15:20.339Z',
      },
    ];

    expect(resolveLatestLeafMessageId(messages)).toBe('assistant-phase2');
  });

  const activeReply = () => [
    {
      messageId: 'scheduled-input',
      parentMessageId: 'prior-answer',
      createdAt: '2026-03-26T20:00:00.000Z',
      isCreatedByUser: true,
      text: 'An immutable scheduled input',
    },
    {
      messageId: 'streaming-answer',
      parentMessageId: 'scheduled-input',
      createdAt: '2026-03-26T20:00:01.000Z',
      isCreatedByUser: false,
      unfinished: true,
      text: '',
    },
  ];

  const stableParent = async (messages) => {
    mockGetMessages.mockResolvedValueOnce(messages);
    const state = await resolveReusableConversationState({
      conversationId: 'conv-1',
      userId: 'user-1',
    });
    return state.parentMessageId;
  };

  test('stable parent selection does not capture an unfinished assistant that will change', async () => {
    const messages = activeReply();
    const before = JSON.stringify(messages);
    expect(await stableParent(messages)).toBe('scheduled-input');
    expect(JSON.stringify(messages)).toBe(before);
    messages[1].text = 'The final answer';
    messages[1].unfinished = false;
    expect(await stableParent(messages)).toBe('streaming-answer');
  });

  test('default leaf selection still exposes active Main to worker callback ownership', () => {
    expect(resolveLatestLeafMessageId(activeReply())).toBe('streaming-answer');
  });

  test('stable parent selection preserves an authored interrupted answer and its replay', async () => {
    const messages = activeReply();
    messages[1].text = 'The retained partial answer';
    messages[1].finish_reason = 'incomplete';
    expect(await stableParent(messages)).toBe('streaming-answer');
    expect(await stableParent(messages)).toBe('streaming-answer');
  });

  test.each([
    ['unconfirmed cancellation', { nativeResponse: { status: 'cancelled' } }],
    ['cancellation activity', { content: [{ type: 'harness_activity', status: 'cancelled' }] }],
    ['length finish', { finish_reason: 'length' }],
    ['ordinary finish', { finish_reason: 'stop' }],
  ])('stable parent selection still excludes active %s drafts', async (_label, patch) => {
    const messages = activeReply();
    Object.assign(messages[1], patch);
    expect(await stableParent(messages)).toBe('scheduled-input');
  });

  test.each([
    ['unfinished user', { isCreatedByUser: true, unfinished: true }],
    ['legacy role', { unfinished: true }],
    ['legacy completion state', { isCreatedByUser: false }],
  ])('stable parent selection preserves %s records', async (_label, fields) => {
    const messages = activeReply();
    messages[1] = {
      messageId: 'eligible-record',
      parentMessageId: 'scheduled-input',
      createdAt: '2026-03-26T20:00:02.000Z',
      ...fields,
    };
    expect(await stableParent(messages)).toBe('eligible-record');
  });

  test('stable parent fallback cannot return an unfinished assistant', async () => {
    const messages = activeReply();
    messages[0].parentMessageId = 'scheduled-input';
    expect(await stableParent(messages)).toBe('scheduled-input');
    expect(await stableParent([messages[1]])).toBeNull();
  });

  test.each(['telegram', 'voice', 'gateway', 'workbench'])(
    '%s automatic parent selection uses stable evidence without removing active work',
    async (surface) => {
      const messages = activeReply();
      mockGetMessages.mockResolvedValueOnce(messages);
      const state = await resolveReusableConversationState({
        conversationId: 'conv-1',
        userId: 'user-1',
        surface,
      });
      expect(state.parentMessageId).toBe('scheduled-input');
      expect(state.messages).toBe(messages);
      expect(state.messages).toContain(messages[1]);
      expect(mockGetMessages).toHaveBeenCalledTimes(1);
      expect(mockGetMessages).toHaveBeenCalledWith(
        { conversationId: 'conv-1' },
        expect.stringContaining('isCreatedByUser unfinished'),
      );
    },
  );

  test('resolveLatestLeafMessageId ignores every passive voice transcript for live replies', () => {
    const messages = [
      {
        messageId: 'user-1',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        createdAt: '2026-03-26T20:00:00.000Z',
      },
      {
        messageId: 'assistant-1',
        parentMessageId: 'user-1',
        createdAt: '2026-03-26T20:00:10.000Z',
      },
      {
        messageId: 'listen-only-1',
        parentMessageId: 'assistant-1',
        createdAt: '2026-03-26T20:05:00.000Z',
        metadata: {
          viventium: {
            type: 'listen_only_transcript',
            mode: 'listen_only',
          },
        },
      },
      {
        messageId: 'listen-only-2',
        parentMessageId: 'listen-only-1',
        createdAt: '2026-03-26T20:06:00.000Z',
        metadata: {
          viventium: {
            type: 'listen_only_transcript',
            mode: 'listen_only',
          },
        },
      },
      {
        messageId: 'guest-ambient-1',
        parentMessageId: 'listen-only-2',
        createdAt: '2026-03-26T20:07:00.000Z',
        isCreatedByUser: false,
        metadata: {
          viventium: {
            type: 'voice_ambient_transcript',
            mode: 'call',
            actorTrust: 'authenticated_participant',
          },
        },
      },
    ];

    expect(resolveLatestLeafMessageId(messages)).toBe('assistant-1');
  });

  test('resolveReusableConversationState resumes after the latest non-passive voice leaf', async () => {
    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'user-1',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        createdAt: '2026-03-26T20:00:00.000Z',
      },
      {
        messageId: 'assistant-1',
        parentMessageId: 'user-1',
        createdAt: '2026-03-26T20:00:10.000Z',
      },
      {
        messageId: 'listen-only-1',
        parentMessageId: 'assistant-1',
        createdAt: '2026-03-26T20:05:00.000Z',
        metadata: {
          viventium: {
            type: 'listen_only_transcript',
            mode: 'listen_only',
          },
        },
      },
      {
        messageId: 'listen-only-2',
        parentMessageId: 'listen-only-1',
        createdAt: '2026-03-26T20:06:00.000Z',
        metadata: {
          viventium: {
            type: 'listen_only_transcript',
            mode: 'listen_only',
          },
        },
      },
      {
        messageId: 'guest-ambient-1',
        parentMessageId: 'listen-only-2',
        createdAt: '2026-03-26T20:07:00.000Z',
        isCreatedByUser: false,
        metadata: {
          viventium: {
            type: 'voice_ambient_transcript',
            mode: 'call',
            actorTrust: 'authenticated_participant',
          },
        },
      },
    ]);

    const state = await resolveReusableConversationState({
      conversationId: 'conv-1',
      userId: 'user-1',
      surface: 'voice',
    });

    expect(state.conversationId).toBe('conv-1');
    expect(state.parentMessageId).toBe('assistant-1');
    expect(state.reason).toBe('existing');
    expect(mockGetMessages).toHaveBeenCalledWith(
      { conversationId: 'conv-1' },
      expect.stringContaining('metadata.viventium.actorTrust'),
    );
  });

  test('resolveReusableConversationState reuses provider-backed voice conversations for the same agent', async () => {
    mockGetConvo.mockResolvedValueOnce({
      conversationId: 'conv-xai-voice',
      endpoint: 'xai',
      agent_id: 'xai__grok-4.3___Grok 4.3',
    });
    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'voice-user-1',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        createdAt: '2026-05-06T21:59:00.000Z',
      },
      {
        messageId: 'voice-assistant-1',
        parentMessageId: 'voice-user-1',
        createdAt: '2026-05-06T21:59:10.000Z',
      },
    ]);

    const state = await resolveReusableConversationState({
      conversationId: 'conv-xai-voice',
      userId: 'user-1',
      surface: 'voice',
      agentId: 'xai__grok-4.3___Grok 4.3',
    });

    expect(state.conversationId).toBe('conv-xai-voice');
    expect(state.parentMessageId).toBe('voice-assistant-1');
    expect(state.reason).toBe('existing');
  });

  test('resolveReusableConversationState rejects provider-backed voice conversations for a different agent', async () => {
    mockGetConvo.mockResolvedValueOnce({
      conversationId: 'conv-xai-other',
      endpoint: 'xai',
      agent_id: 'xai__other-model___Other',
    });

    const state = await resolveReusableConversationState({
      conversationId: 'conv-xai-other',
      userId: 'user-1',
      surface: 'voice',
      agentId: 'xai__grok-4.3___Grok 4.3',
    });

    expect(state.conversationId).toBe('new');
    expect(state.parentMessageId).toBeNull();
    expect(state.reason).toBe('non_agent');
    expect(mockGetMessages).not.toHaveBeenCalled();
  });

  test('resolveLatestLeafMessageId falls back to latest createdAt when all messages have children', () => {
    const messages = [
      {
        messageId: 'a',
        parentMessageId: 'c',
        createdAt: '2026-03-26T20:00:00.000Z',
      },
      {
        messageId: 'b',
        parentMessageId: 'a',
        createdAt: '2026-03-26T20:01:00.000Z',
      },
      {
        messageId: 'c',
        parentMessageId: 'b',
        createdAt: '2026-03-26T20:02:00.000Z',
      },
    ];

    expect(resolveLatestLeafMessageId(messages)).toBe('c');
  });

  test('resolveReusableConversationState returns newest follow-up leaf when present', async () => {
    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'phase1',
        parentMessageId: 'user-1',
        createdAt: '2026-03-26T20:15:20.339Z',
      },
      {
        messageId: 'user-1',
        parentMessageId: 'assistant-0',
        createdAt: '2026-03-26T20:15:20.713Z',
      },
      {
        messageId: 'followup',
        parentMessageId: 'phase1',
        createdAt: '2026-03-26T20:16:50.680Z',
        metadata: { viventium: { type: 'cortex_followup' } },
      },
    ]);

    const state = await resolveReusableConversationState({
      conversationId: 'conv-1',
      userId: 'user-1',
      surface: 'telegram',
    });

    expect(state.conversationId).toBe('conv-1');
    expect(state.parentMessageId).toBe('followup');
    expect(state.reason).toBe('existing');
  });

  test('resolveReusableConversationState resets stale conversations when maxIdleMs is exceeded', async () => {
    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'msg-1',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        createdAt: '2026-03-24T20:00:00.000Z',
      },
    ]);

    const state = await resolveReusableConversationState({
      conversationId: 'conv-1',
      userId: 'user-1',
      surface: 'telegram',
      maxIdleMs: 60 * 60 * 1000,
    });

    expect(state.conversationId).toBe('new');
    expect(state.parentMessageId).toBeNull();
    expect(state.reason).toBe('stale');
  });
});
