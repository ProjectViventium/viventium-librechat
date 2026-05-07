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

  test('resolveLatestLeafMessageId ignores Listen-Only transcript chains for live replies', () => {
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
    ];

    expect(resolveLatestLeafMessageId(messages)).toBe('assistant-1');
  });

  test('resolveReusableConversationState resumes after the latest non-Listen-Only leaf', async () => {
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
    ]);

    const state = await resolveReusableConversationState({
      conversationId: 'conv-1',
      userId: 'user-1',
      surface: 'voice',
    });

    expect(state.conversationId).toBe('conv-1');
    expect(state.parentMessageId).toBe('assistant-1');
    expect(state.reason).toBe('existing');
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
