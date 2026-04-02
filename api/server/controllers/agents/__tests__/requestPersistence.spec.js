const mockSaveMessage = jest.fn();
const mockGetResumeState = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('librechat-data-provider', () => ({
  Constants: {},
  ViolationTypes: {},
}));

jest.mock('@librechat/api', () => ({
  sendEvent: jest.fn(),
  getViolationInfo: jest.fn(),
  GenerationJobManager: {
    getResumeState: (...args) => mockGetResumeState(...args),
  },
  decrementPendingRequest: jest.fn(),
  sanitizeFileForTransmit: jest.fn((value) => value),
  sanitizeMessageForTransmit: jest.fn((value) => value),
  checkAndIncrementPendingRequest: jest.fn(),
}));

jest.mock('~/server/cleanup', () => ({
  disposeClient: jest.fn(),
  clientRegistry: new WeakMap(),
  requestDataMap: new WeakMap(),
}));

jest.mock('~/server/middleware', () => ({
  handleAbortError: jest.fn(),
}));

jest.mock('~/cache', () => ({
  logViolation: jest.fn(),
}));

jest.mock('~/models', () => ({
  saveMessage: (...args) => mockSaveMessage(...args),
}));

jest.mock('~/server/services/viventium/telegramTimingDeep', () => ({
  isDeepTimingEnabled: jest.fn(() => false),
  startDeepTiming: jest.fn(() => 0),
  logDeepTiming: jest.fn(),
}));

jest.mock('~/server/services/viventium/morningBriefingBootstrap', () => ({
  ensureMorningBriefing: jest.fn(),
}));

jest.mock('~/server/services/viventium/surfacePrompts', () => ({
  stripVoiceControlTagsForDisplay: jest.fn((text) => text.replace(/\[[^\]]+\]/g, '')),
}));

describe('request persistence helpers', () => {
  const { __testables } = require('../request');

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetResumeState.mockResolvedValue({
      userMessage: {
        messageId: 'user-msg-1',
        parentMessageId: 'parent-msg-0',
        conversationId: 'convo-1',
        text: 'hello',
      },
      responseMessageId: 'assistant-msg-1',
      conversationId: 'convo-1',
      sender: 'AI',
    });
    mockSaveMessage.mockResolvedValue({ ok: true });
  });

  it('persists partial assistant content with the resumable response message id', async () => {
    const req = {
      user: { id: 'user-1' },
      body: { agent_id: 'agent-123' },
    };

    const result = await __testables.persistAssistantSnapshot({
      req,
      streamId: 'stream-1',
      userId: 'user-1',
      client: { sender: 'AI', options: { endpoint: 'agents' }, model: 'test-model' },
      conversationId: 'convo-1',
      aggregatedContent: [{ type: 'text', text: 'Partial answer' }],
      unfinished: true,
      error: false,
      context: 'test-partial',
    });

    expect(result.persisted).toBe(true);
    expect(mockSaveMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        messageId: 'assistant-msg-1',
        parentMessageId: 'user-msg-1',
        conversationId: 'convo-1',
        text: 'Partial answer',
        unfinished: true,
        error: false,
        agent_id: 'agent-123',
      }),
      expect.objectContaining({ context: 'test-partial' }),
    );
  });

  it('persists a fallback error message when no content exists yet', async () => {
    const req = {
      user: { id: 'user-1' },
      body: { voiceMode: true },
    };

    const result = await __testables.persistAssistantSnapshot({
      req,
      streamId: 'stream-1',
      userId: 'user-1',
      client: { sender: 'AI', options: { endpoint: 'agents' }, model: 'test-model' },
      conversationId: 'convo-1',
      aggregatedContent: [],
      fallbackText: '[sad]Generation interrupted before completion.',
      unfinished: false,
      error: true,
      context: 'test-error',
    });

    expect(result.persisted).toBe(true);
    expect(mockSaveMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        messageId: 'assistant-msg-1',
        text: 'Generation interrupted before completion.',
        unfinished: false,
        error: true,
      }),
      expect.objectContaining({ context: 'test-error' }),
    );
  });

  it('persists an initial placeholder when generation starts before text arrives', async () => {
    const req = {
      user: { id: 'user-1' },
      body: {},
    };

    const result = await __testables.persistAssistantSnapshot({
      req,
      streamId: 'stream-1',
      userId: 'user-1',
      client: { sender: 'AI', options: { endpoint: 'agents' }, model: 'test-model' },
      conversationId: 'convo-1',
      aggregatedContent: [],
      fallbackText: 'Generation in progress.',
      unfinished: true,
      error: false,
      context: 'test-placeholder',
    });

    expect(result.persisted).toBe(true);
    expect(mockSaveMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        messageId: 'assistant-msg-1',
        text: 'Generation in progress.',
        unfinished: true,
        error: false,
      }),
      expect.objectContaining({ context: 'test-placeholder' }),
    );
  });

  it('uses explicit request metadata when resumable state is not available yet', async () => {
    mockGetResumeState.mockResolvedValue(null);

    const req = {
      user: { id: 'user-1' },
      body: {},
    };

    const result = await __testables.persistAssistantSnapshot({
      req,
      streamId: 'stream-1',
      userId: 'user-1',
      client: { sender: 'Assistant', options: { endpoint: 'agents' }, model: 'test-model' },
      conversationId: 'convo-1',
      userMessage: {
        messageId: 'user-msg-1',
        parentMessageId: 'parent-msg-0',
        conversationId: 'convo-1',
        text: 'hello',
      },
      responseMessageId: 'assistant-msg-1',
      sender: 'Assistant',
      aggregatedContent: [],
      fallbackText: 'Generation in progress.',
      unfinished: true,
      error: false,
      context: 'test-explicit-state',
    });

    expect(result.persisted).toBe(true);
    expect(mockSaveMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        messageId: 'assistant-msg-1',
        parentMessageId: 'user-msg-1',
        conversationId: 'convo-1',
        sender: 'Assistant',
        text: 'Generation in progress.',
        unfinished: true,
      }),
      expect.objectContaining({ context: 'test-explicit-state' }),
    );
  });
});
