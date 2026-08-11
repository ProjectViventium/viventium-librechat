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
  ContentTypes: { THINK: 'think' },
  FileContext: { execute_code: 'execute_code' },
  FileSources: { local: 'local' },
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

jest.mock('~/db/models', () => ({
  Message: { findOneAndDelete: jest.fn() },
  Conversation: { updateOne: jest.fn() },
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
  stripVoiceControlTagsForDisplay: jest.fn((text) =>
    text
      .replace(/<emotion[^>]*\/>/g, '')
      .replace(/<emotion[^>]*>(.*?)<\/emotion>/g, '$1')
      .replace(/\[[^\]]+\]/g, ''),
  ),
}));

jest.mock('~/server/services/viventium/VoiceTaskService', () => ({
  isVoiceTaskSuppressedDurably: jest.fn(async () => false),
  setVoiceTaskOwnerCapabilities: jest.fn(),
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

  it('attaches post-call hardener metadata to a completed voice response', async () => {
    const req = {
      user: { id: 'user-1' },
      body: {
        agent_id: 'agent-123',
        viventiumSurface: 'voice',
        viventiumInputMode: 'voice_call',
        mode: 'call',
        speakerSegments: [{ version: 1, segmentId: 'seg-1' }],
        speakerLabel: 'Owner',
        viventiumActorTrust: 'owner_participant',
        viventiumDeferVoiceMemory: true,
      },
      viventiumCallSession: { callSessionId: 'call-session-1' },
      viventiumVoiceRequestId: 'voice-request-1',
    };

    const result = await __testables.persistAssistantSnapshot({
      req,
      streamId: 'stream-1',
      userId: 'user-1',
      client: { sender: 'AI', options: { endpoint: 'agents' }, model: 'test-model' },
      conversationId: 'convo-1',
      aggregatedContent: [{ type: 'text', text: 'Completed answer' }],
      unfinished: false,
      error: false,
      context: 'test-voice-metadata',
    });

    expect(result.persisted).toBe(true);
    expect(mockSaveMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        messageId: 'assistant-msg-1',
        metadata: {
          viventium: expect.objectContaining({
            callSessionId: 'call-session-1',
            voiceRequestId: 'voice-request-1',
            surface: 'voice',
            inputMode: 'voice_call',
            mode: 'call',
            speakerSegments: [{ version: 1, segmentId: 'seg-1' }],
            speakerLabel: 'Owner',
            actorTrust: 'owner_participant',
            memoryDeferredPostCall: true,
          }),
        },
      }),
      expect.objectContaining({ context: 'test-voice-metadata' }),
    );
  });

  it('sanitizes persisted voice-mode content parts as well as top-level text', async () => {
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
      aggregatedContent: [
        { type: 'text', text: '<emotion value="content"/>Yeah.' },
        { type: 'think', think: 'The user said: hello' },
        { type: 'tool_use', id: 'tool-1', name: 'x' },
      ],
      unfinished: true,
      error: false,
      context: 'test-voice-sanitized-content',
    });

    expect(result.persisted).toBe(true);
    expect(mockSaveMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        text: 'Yeah.',
        content: [
          { type: 'text', text: 'Yeah.' },
          { type: 'tool_use', id: 'tool-1', name: 'x' },
        ],
      }),
      expect.objectContaining({ context: 'test-voice-sanitized-content' }),
    );
  });

  it('normalizes final assistant text from visible content parts when text is empty', () => {
    const req = {
      body: { voiceMode: true },
    };

    const response = __testables.normalizePersistedAssistantResponse(req, {
      messageId: 'assistant-msg-1',
      text: '',
      content: [
        { type: 'think', think: 'The user said: hello' },
        { type: 'text', text: '<emotion value="warm"/>Alpha. Beta.' },
      ],
    });

    expect(response).toEqual(
      expect.objectContaining({
        text: 'Alpha. Beta.',
        content: [{ type: 'text', text: 'Alpha. Beta.' }],
      }),
    );
  });

  it('preserves non-voice content-to-text parity when final text is empty', () => {
    const req = {
      body: { voiceMode: false },
    };

    const response = __testables.normalizePersistedAssistantResponse(req, {
      messageId: 'assistant-msg-1',
      text: '',
      content: [
        { type: 'think', think: 'Internal reasoning should remain content-only.' },
        { type: 'text', text: 'Plain web answer.' },
      ],
    });

    expect(response).toEqual(
      expect.objectContaining({
        text: 'Plain web answer.',
        content: [
          { type: 'think', think: 'Internal reasoning should remain content-only.' },
          { type: 'text', text: 'Plain web answer.' },
        ],
      }),
    );
  });

  it('persists Telegram turns without delivery or provider controls', () => {
    const req = {
      _viventiumTelegram: true,
      body: {
        voiceMode: false,
        viventiumSurface: 'telegram',
        telegramAudioRequested: true,
      },
    };

    const response = __testables.normalizePersistedAssistantResponse(req, {
      messageId: 'assistant-msg-telegram',
      text: [
        '<whisper>Here is **the draft** for qa@example.com.</whisper>',
        '{MSG_BREAK}',
        'Keep https://example.com and `literal_code`.',
        '{SKIP_VOICE}',
      ].join('\n'),
      content: [
        {
          type: 'text',
          text: '<whisper>Here is **the draft** for qa@example.com.</whisper>\n{SKIP_VOICE}',
        },
        { type: 'think', think: 'Existing Telegram content semantics stay unchanged.' },
      ],
    });

    expect(response.text).toBe(
      'Here is **the draft** for qa@example.com.\n\nKeep https://example.com and `literal_code`.',
    );
    expect(response.content).toEqual([
      { type: 'text', text: 'Here is **the draft** for qa@example.com.' },
      { type: 'think', think: 'Existing Telegram content semantics stay unchanged.' },
    ]);
  });

  it('preserves Telegram delivery controls only in the authenticated final transport event', () => {
    const req = {
      _viventiumTelegram: true,
      body: {
        voiceMode: false,
        viventiumSurface: 'telegram',
        telegramAudioRequested: true,
      },
    };
    const raw = {
      messageId: 'assistant-msg-telegram',
      text: 'Copy-ready draft.\n{MSG_BREAK}\nOne afterthought.\n{SKIP_VOICE}',
      content: [
        {
          type: 'text',
          text: 'Copy-ready draft.\n{MSG_BREAK}\nOne afterthought.\n{SKIP_VOICE}',
        },
      ],
    };

    const transmitted = __testables.normalizeAssistantResponseForTransmit(req, raw);
    const persisted = __testables.normalizePersistedAssistantResponse(req, raw);

    expect(transmitted.text).toContain('{MSG_BREAK}');
    expect(transmitted.text).toContain('{SKIP_VOICE}');
    expect(transmitted.content[0].text).toContain('{SKIP_VOICE}');
    expect(persisted.text).toBe('Copy-ready draft.\n\nOne afterthought.');
    expect(persisted.content[0].text).toBe('Copy-ready draft.\n\nOne afterthought.');
  });

  it('does not trust a client-supplied Telegram surface without the route flag', () => {
    const response = __testables.normalizeAssistantResponseForTransmit(
      {
        body: {
          voiceMode: false,
          viventiumSurface: 'telegram',
          telegramAudioRequested: true,
        },
      },
      { text: 'Draft.\n{SKIP_VOICE}' },
    );

    expect(response.text).toBe('Draft.');
  });

  it('sanitizes Telegram delivery controls in interrupted snapshots', async () => {
    const req = {
      user: { id: 'user-1' },
      body: {
        voiceMode: false,
        viventiumSurface: 'telegram',
        telegramAudioRequested: true,
      },
    };

    await __testables.persistAssistantSnapshot({
      req,
      streamId: 'stream-telegram-error',
      userId: 'user-1',
      client: { sender: 'AI', options: { endpoint: 'agents' }, model: 'test-model' },
      conversationId: 'convo-1',
      userMessage: {
        messageId: 'user-msg',
        conversationId: 'convo-1',
      },
      responseMessageId: 'assistant-msg',
      aggregatedContent: [{ type: 'text', text: 'First.\n{MSG_BREAK}\nSecond.\n{SKIP_VOICE}' }],
      fallbackText: '',
      unfinished: true,
      error: true,
      context: 'test-telegram-error',
    });

    const saved = mockSaveMessage.mock.calls.at(-1)[1];
    expect(saved.text).toBe('First.\n\nSecond.');
    expect(saved.content[0].text).toBe('First.\n\nSecond.');
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
