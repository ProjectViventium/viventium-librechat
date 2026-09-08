jest.mock('@librechat/api', () => ({
  isEnabled: jest.fn(() => true),
  sanitizeTitle: jest.fn((title) => title),
}));

jest.mock('@librechat/data-schemas', () => ({
  saveGeneratedConversationTitle: jest.fn(async (_model, _user, _conversationId, title) => title),
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

const mockSet = jest.fn();
const mockRecordVoiceOrchestrationTraceBestEffort = jest.fn();
const mockGetTrustedInteractionContext = jest.fn();

jest.mock('~/cache/getLogStores', () => jest.fn(() => ({ set: mockSet })));
jest.mock('~/db/models', () => ({ Conversation: {} }));
jest.mock('~/server/services/viventium/interactionContext', () => ({
  getTrustedInteractionContext: (...args) => mockGetTrustedInteractionContext(...args),
}));
jest.mock('~/server/services/viventium/VoiceOrchestrationTraceService', () => ({
  recordVoiceOrchestrationTraceBestEffort: (...args) =>
    mockRecordVoiceOrchestrationTraceBestEffort(...args),
}));

const addTitle = require('./title');
const getLogStores = require('~/cache/getLogStores');
const { saveGeneratedConversationTitle } = require('@librechat/data-schemas');
const { Conversation } = require('~/db/models');
const { isEnabled } = require('@librechat/api');

describe('agents addTitle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTrustedInteractionContext.mockReturnValue(null);
    mockRecordVoiceOrchestrationTraceBestEffort.mockResolvedValue({ sequence: 1 });
  });

  it.each([
    { gate: 'disabled globally', enabled: false, options: {}, body: {} },
    { gate: 'disabled on the client', enabled: true, options: { titleConvo: false }, body: {} },
    { gate: 'temporary conversation', enabled: true, options: {}, body: { isTemporary: true } },
  ])('does no title work for $gate', async ({ enabled, options, body }) => {
    isEnabled.mockReturnValueOnce(enabled);
    const titleConvo = jest.fn();
    await addTitle(
      { user: { id: 'owner' }, body },
      {
        text: 'Question',
        response: { conversationId: 'conversation' },
        client: { options, titleConvo },
      },
    );
    expect(titleConvo).not.toHaveBeenCalled();
    expect(saveGeneratedConversationTitle).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('does not cache a title when durable persistence fails', async () => {
    saveGeneratedConversationTitle.mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(
      addTitle(
        { user: { id: 'owner' }, body: {} },
        {
          text: 'Question',
          response: { conversationId: 'conversation' },
          client: { options: {}, titleConvo: jest.fn().mockResolvedValue('Generated title') },
        },
      ),
    ).rejects.toThrow('Database unavailable');
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('records a real generated title for the exact Voice turn without title text', async () => {
    const req = {
      user: { id: 'user-voice-1' },
      body: { voiceMode: true, viventiumCallSessionId: 'call-voice-1' },
    };
    mockGetTrustedInteractionContext.mockReturnValue({
      surface: 'voice',
      logical_turn_id: 'turn-voice-1',
    });
    const client = {
      titleConvo: jest.fn().mockResolvedValue('Private generated title'),
      options: {},
    };

    await addTitle(req, {
      text: 'private user title seed',
      response: { conversationId: 'convo-voice-1' },
      client,
    });

    expect(mockRecordVoiceOrchestrationTraceBestEffort).toHaveBeenCalledWith({
      ownerId: 'user-voice-1',
      callSessionId: 'call-voice-1',
      turnId: 'turn-voice-1',
      eventRef: 'convo-voice-1',
      stage: 'title_model.completed',
      facts: { effectCount: 1 },
    });
    expect(JSON.stringify(mockRecordVoiceOrchestrationTraceBestEffort.mock.calls)).not.toContain(
      'Private generated title',
    );
    expect(JSON.stringify(mockRecordVoiceOrchestrationTraceBestEffort.mock.calls)).not.toContain(
      'private user title seed',
    );
  });

  it('uses a fallback title when async title generation fails', async () => {
    const req = {
      user: { id: 'user-1' },
      body: {},
    };
    const client = {
      titleConvo: jest.fn().mockRejectedValue(new Error('Run not initialized')),
      options: {},
    };

    await addTitle(req, {
      text: 'check my ms365 inbox',
      response: { conversationId: 'convo-1' },
      client,
    });

    expect(getLogStores).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith('user-1-convo-1', 'check my ms365 inbox', 120000);
    expect(saveGeneratedConversationTitle).toHaveBeenCalledWith(
      Conversation,
      'user-1',
      'convo-1',
      'check my ms365 inbox',
    );
    expect(mockRecordVoiceOrchestrationTraceBestEffort).not.toHaveBeenCalled();
  });

  it('uses a fallback title when no title is returned', async () => {
    const req = {
      user: { id: 'user-2' },
      body: {},
    };
    const client = {
      titleConvo: jest.fn().mockResolvedValue(undefined),
      options: {},
    };

    await addTitle(req, {
      text: 'this is a deliberately long title seed that should truncate cleanly',
      response: { conversationId: 'convo-2' },
      client,
    });

    expect(mockSet).toHaveBeenCalledWith(
      'user-2-convo-2',
      'this is a deliberately long title see...',
      120000,
    );
    expect(saveGeneratedConversationTitle).toHaveBeenCalledWith(
      Conversation,
      'user-2',
      'convo-2',
      'this is a deliberately long title see...',
    );
    expect(mockRecordVoiceOrchestrationTraceBestEffort).not.toHaveBeenCalled();
  });
});
