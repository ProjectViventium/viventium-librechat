/* === VIVENTIUM START ===
 * Tests: Conversation Recall indexing service
 *
 * Purpose:
 * - Validate global and agent-scoped corpus synchronization behavior.
 * - Verify stale resource cleanup paths.
 * - Verify infra-disabled short-circuit behavior.
 *
 * Added: 2026-02-19
 * === VIVENTIUM END === */

const mockUploadVectors = jest.fn();
const mockDeleteVectors = jest.fn();

const mockUserFindById = jest.fn();
const mockAgentFindOne = jest.fn();
const mockConversationFind = jest.fn();
const mockConversationFindOne = jest.fn();
const mockMessageFind = jest.fn();
const mockFileFind = jest.fn();
const mockFileFindOne = jest.fn();
const mockFileFindOneAndUpdate = jest.fn();
const mockFileDeleteOne = jest.fn();

const mockWriteFile = jest.fn();
const mockUnlink = jest.fn();
const mockDeferAfterCommit = jest.fn();

const mockActualDataSchemas = { ...jest.requireActual('@librechat/data-schemas') };
const mockActualDataProvider = { ...jest.requireActual('librechat-data-provider') };
const mockActualFs = { ...jest.requireActual('fs') };
const mockVisibleContentProjection = jest.requireActual('../ViventiumVisibleContentProjection');

jest.doMock(
  '@librechat/data-schemas',
  () => ({
    ...mockActualDataSchemas,
    logger: {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    },
  }),
  { virtual: true },
);

jest.doMock('fs', () => {
  return {
    ...mockActualFs,
    promises: {
      ...mockActualFs.promises,
      writeFile: (...args) => mockWriteFile(...args),
      unlink: (...args) => mockUnlink(...args),
    },
  };
});

jest.doMock('~/server/services/Files/VectorDB/crud', () => ({
  uploadVectors: (...args) => mockUploadVectors(...args),
  deleteVectors: (...args) => mockDeleteVectors(...args),
}));

jest.doMock('../GlassHiveTerminalCallbackTransaction', () => ({
  deferGlassHiveTerminalCallbackAfterCommit: (...args) => mockDeferAfterCommit(...args),
}));

jest.doMock('~/db/models', () => ({
  Agent: {
    findOne: (...args) => mockAgentFindOne(...args),
    find: jest.fn(),
  },
  Conversation: {
    find: (...args) => mockConversationFind(...args),
    findOne: (...args) => mockConversationFindOne(...args),
  },
  File: {
    find: (...args) => mockFileFind(...args),
    findOne: (...args) => mockFileFindOne(...args),
    findOneAndUpdate: (...args) => mockFileFindOneAndUpdate(...args),
    deleteOne: (...args) => mockFileDeleteOne(...args),
  },
  Message: {
    find: (...args) => mockMessageFind(...args),
  },
  User: {
    findById: (...args) => mockUserFindById(...args),
  },
}));

jest.doMock('librechat-data-provider', () => ({
  ...mockActualDataProvider,
  FileContext: {
    conversation_recall: 'conversation_recall',
  },
  FileSources: {
    vectordb: 'vectordb',
  },
  parseTextParts: jest.fn(() => ''),
  ConversationRecallScope: {
    all: 'all',
    agent: 'agent',
  },
  buildConversationRecallFileId: ({ userId, scope, agentId }) =>
    scope === 'all'
      ? `conversation_recall:${userId}:all`
      : `conversation_recall:${userId}:agent:${agentId}`,
  buildConversationRecallFilename: ({ scope, agentId }) =>
    scope === 'all' ? 'conversation-recall-all.txt' : `conversation-recall-agent-${agentId}.txt`,
  parseConversationRecallAgentIdFromFilename: (filename) => {
    const prefix = 'conversation-recall-agent-';
    if (
      typeof filename !== 'string' ||
      !filename.startsWith(prefix) ||
      !filename.endsWith('.txt')
    ) {
      return null;
    }
    return filename.slice(prefix.length, -'.txt'.length) || null;
  },
}));

jest.doMock('../ViventiumVisibleContentProjection', () => mockVisibleContentProjection);

afterAll(() => {
  jest.dontMock('@librechat/data-schemas');
  jest.dontMock('fs');
  jest.dontMock('~/server/services/Files/VectorDB/crud');
  jest.dontMock('../GlassHiveTerminalCallbackTransaction');
  jest.dontMock('~/db/models');
  jest.dontMock('librechat-data-provider');
  jest.dontMock('../ViventiumVisibleContentProjection');
  jest.resetModules();
});

function queryResult(result) {
  return {
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result),
  };
}

describe('conversationRecallService', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    process.env.RAG_API_URL = 'https://rag.example.test';
    process.env.VIVENTIUM_CONVERSATION_RECALL_ENABLED = 'true';
    process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_MESSAGES = '3000';
    process.env.VIVENTIUM_CONVERSATION_RECALL_FETCH_MULTIPLIER = '4';
    process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_SCAN_MESSAGES = '8000';
    process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_CHARS = '1200000';
    process.env.VIVENTIUM_CONVERSATION_RECALL_DEBOUNCE_MS = '1';
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_MAX_ATTEMPTS = '4';
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_RETRY_BASE_MS = '0';
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_TIMEOUT_MS = '5000';
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_TIMEOUT_PER_100K_CHARS_MS = '0';
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_TIMEOUT_MAX_MS = '5000';
    process.env.VIVENTIUM_CONVERSATION_RECALL_TEXT_ONLY = 'true';
    process.env.VIVENTIUM_CONVERSATION_RECALL_FAILURE_COOLDOWN_BASE_MS = '25';
    process.env.VIVENTIUM_CONVERSATION_RECALL_FAILURE_COOLDOWN_MAX_MS = '50';
    process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_TRANSIENT_FAILURES = '4';
    process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_PENDING_SYNCS = '8';
    process.env.VIVENTIUM_CONVERSATION_RECALL_MIN_SYNC_INTERVAL_MS = '0';
    delete process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_MESSAGE_TEXT_CHARS;
    delete process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_USER_MESSAGE_TEXT_CHARS;

    mockWriteFile.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
    mockUploadVectors.mockResolvedValue(undefined);
    mockDeleteVectors.mockResolvedValue(undefined);
    mockFileDeleteOne.mockResolvedValue({ deletedCount: 1 });
    mockFileFindOne.mockReturnValue(queryResult(null));
    mockDeferAfterCommit.mockReturnValue(false);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('getMessageText preserves boundaries between multiple visible assistant parts', () => {
    const service = require('../conversationRecallService');

    expect(
      service.getMessageText({
        text: 'Base answer.Added answer.',
        content: [
          { type: 'text', text: 'Base answer.', agentId: 'agent-main', groupId: 1 },
          { type: 'text', text: 'Added answer.', agentId: 'agent-main____1', groupId: 1 },
        ],
      }),
    ).toBe('Base answer. Added answer.');
  });

  test('getMessageText preserves an explicitly different sanitized assistant text', () => {
    const service = require('../conversationRecallService');

    expect(
      service.getMessageText({
        text: 'Sanitized visible answer.',
        content: [
          { type: 'text', text: '<voice>First raw part.</voice>' },
          { type: 'text', text: '<voice>Second raw part.</voice>' },
        ],
      }),
    ).toBe('Sanitized visible answer.');
  });

  test('refreshConversationRecallForUser upserts all-conversations corpus when global recall is enabled', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'user note',
        },
      ]),
    );

    mockConversationFind.mockImplementation((filter) => {
      // No enabled agent-only corpora in this test.
      if (filter?.agent_id?.$exists) {
        return queryResult([]);
      }
      return queryResult([]);
    });

    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    expect(mockMessageFind).toHaveBeenCalledWith(
      expect.objectContaining({
        $nor: [
          { 'metadata.viventium.recallEligible': false },
          {
            'metadata.viventium.memoryEligible': false,
            'metadata.viventium.recallEligible': { $ne: true },
          },
        ],
        'metadata.viventium.qaRun': { $ne: true },
        $or: [{ expiredAt: { $exists: false } }, { expiredAt: null }],
      }),
    );

    expect(mockUploadVectors).toHaveBeenCalledTimes(1);
    expect(mockUploadVectors.mock.calls[0][0].file_id).toBe('conversation_recall:user_1:all');
    expect(mockUploadVectors.mock.calls[0][0].file.originalname).toBe(
      'conversation-recall-all.txt',
    );
    expect(mockUploadVectors.mock.calls[0][0].timeoutMs).toBe(5000);

    expect(mockFileFindOneAndUpdate).toHaveBeenCalledWith(
      { user: 'user_1', file_id: 'conversation_recall:user_1:all' },
      expect.any(Object),
      { upsert: true, new: true },
    );
  });

  test('indexes a visible scheduled result while excluding its trusted internal envelope', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({ personalization: { conversation_recall: true } }),
    );
    mockMessageFind.mockReturnValue(
      queryResult([
        {
          messageId: 'scheduled-result',
          conversationId: 'scheduled-conversation',
          createdAt: '2026-08-21T10:01:00.000Z',
          isCreatedByUser: false,
          sender: 'assistant',
          text: 'Visible scheduled result evidence.',
          metadata: {
            viventium: {
              memoryEligible: false,
              recallEligible: true,
              interactionContext: { actor_kind: 'system', origin: 'scheduler' },
            },
          },
        },
        {
          messageId: 'scheduled-envelope',
          conversationId: 'scheduled-conversation',
          createdAt: '2026-08-21T10:00:00.000Z',
          isCreatedByUser: true,
          text: 'Private scheduler envelope evidence.',
          metadata: {
            viventium: {
              visibility: 'internal',
              memoryEligible: false,
              recallEligible: false,
              interactionContext: { actor_kind: 'system', origin: 'scheduler' },
            },
          },
        },
      ]),
    );
    mockConversationFind.mockReturnValue(queryResult([]));
    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    const corpus = String(mockWriteFile.mock.calls[0][1]);
    expect(corpus).toContain('Visible scheduled result evidence.');
    expect(corpus).not.toContain('Private scheduler envelope evidence.');
  });

  test('indexes the complete bounded user turn when assistant turns use a smaller clip limit', async () => {
    process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_MESSAGE_TEXT_CHARS = '200';
    delete process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_USER_MESSAGE_TEXT_CHARS;
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );
    const longUserTurn =
      'Synthetic first-person event. '.repeat(100) +
      'Critical user-authored tail evidence survives indexing.';
    const longAssistantTurn =
      'Synthetic assistant restatement. '.repeat(100) + 'Assistant tail should be clipped.';
    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-07-15T14:00:01.000Z',
          isCreatedByUser: false,
          text: longAssistantTurn,
        },
        {
          conversationId: 'conv_1',
          createdAt: '2026-07-15T14:00:00.000Z',
          isCreatedByUser: true,
          text: longUserTurn,
        },
      ]),
    );
    mockConversationFind.mockReturnValue(queryResult([]));
    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    const corpus = mockWriteFile.mock.calls[0][1];
    expect(corpus).toContain('Critical user-authored tail evidence survives indexing.');
    expect(corpus).not.toContain('Assistant tail should be clipped.');
  });

  test('orders each indexed reply after its parent when persistence timestamps are inverted', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    // Mongo returns newest-first. The parent user row was persisted milliseconds after its child.
    mockMessageFind.mockReturnValue(
      queryResult([
        {
          messageId: 'user_1',
          parentMessageId: '00000000-0000-0000-0000-000000000000',
          conversationId: 'conv_1',
          createdAt: '2026-07-14T12:00:00.030Z',
          isCreatedByUser: true,
          text: 'Synthetic parent request.',
        },
        {
          messageId: 'assistant_1',
          parentMessageId: 'user_1',
          conversationId: 'conv_1',
          createdAt: '2026-07-14T12:00:00.000Z',
          isCreatedByUser: false,
          sender: 'assistant',
          text: 'Synthetic child reply.',
        },
      ]),
    );

    mockConversationFind.mockReturnValue(queryResult([]));
    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    const writtenCorpus = String(mockWriteFile.mock.calls[0][1]);
    expect(writtenCorpus.indexOf('Synthetic parent request.')).toBeLessThan(
      writtenCorpus.indexOf('Synthetic child reply.'),
    );
    expect(writtenCorpus).toContain(
      '<latest_timestamp>2026-07-14T12:00:00.030Z</latest_timestamp>',
    );
  });

  test('scales upload timeout with larger recall corpora', async () => {
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_TIMEOUT_MS = '5000';
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_TIMEOUT_PER_100K_CHARS_MS = '2000';
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_TIMEOUT_MAX_MS = '12000';
    process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_MESSAGE_TEXT_CHARS = '400000';

    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'x'.repeat(250000),
        },
      ]),
    );

    mockConversationFind.mockImplementation((filter) => {
      if (filter?.agent_id?.$exists) {
        return queryResult([]);
      }
      return queryResult([]);
    });

    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    expect(mockUploadVectors).toHaveBeenCalledTimes(1);
    expect(mockUploadVectors.mock.calls[0][0].timeoutMs).toBe(11000);
  });

  test('supports user-only corpus mode when assistant inclusion is disabled', async () => {
    process.env.VIVENTIUM_CONVERSATION_RECALL_INCLUDE_ASSISTANT = 'false';

    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    const messageQuery = queryResult([
      {
        conversationId: 'conv_1',
        createdAt: '2026-02-19T00:00:00.000Z',
        isCreatedByUser: true,
        text: 'user note',
      },
    ]);
    mockMessageFind.mockReturnValue(messageQuery);

    mockConversationFind.mockImplementation((filter) => {
      if (filter?.agent_id?.$exists) {
        return queryResult([]);
      }
      return queryResult([]);
    });

    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    expect(mockMessageFind).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'user_1',
        isCreatedByUser: true,
      }),
    );
    expect(messageQuery.select).toHaveBeenCalledWith(
      'messageId parentMessageId conversationId createdAt sender isCreatedByUser text attachments metadata',
    );
  });

  test('excludes Listen-Only transcript rows at the corpus query boundary', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_real',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'Synthetic user message that should remain in recall.',
        },
      ]),
    );

    mockConversationFind.mockImplementation((filter) => {
      if (filter?.agent_id?.$exists) {
        return queryResult([]);
      }
      return queryResult([]);
    });

    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    expect(mockMessageFind).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'user_1',
        'metadata.viventium.type': {
          $nin: ['listen_only_transcript', 'voice_ambient_transcript'],
        },
        'metadata.viventium.mode': { $ne: 'listen_only' },
      }),
    );
  });

  test('filters internal control prompts and NTA placeholders from conversation recall corpus', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_internal',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: '<!--viv_internal:brew_begin--> ## Background Processing (Brewing) Wake. Check date, time, timezone.',
        },
        {
          conversationId: 'conv_internal',
          createdAt: '2026-02-19T00:01:00.000Z',
          isCreatedByUser: false,
          sender: 'assistant',
          text: '{NTA}',
        },
        {
          conversationId: 'conv_internal',
          createdAt: '2026-02-19T00:01:30.000Z',
          isCreatedByUser: false,
          sender: 'assistant',
          text: "I don't have any memory of prior conversations or your name right now.",
        },
        {
          conversationId: 'conv_internal',
          createdAt: '2026-02-19T00:01:40.000Z',
          isCreatedByUser: false,
          sender: 'assistant',
          text: "I don't think you've told me that yet.",
        },
        {
          conversationId: 'conv_real',
          createdAt: '2026-02-19T00:02:00.000Z',
          isCreatedByUser: true,
          text: 'Lab follow-up: ferritin was 32 and LDL was 165.',
        },
      ]),
    );

    mockConversationFind.mockImplementation((filter) => {
      if (filter?.agent_id?.$exists) {
        return queryResult([]);
      }
      return queryResult([]);
    });

    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    const writtenCorpus = mockWriteFile.mock.calls[0][1];
    expect(writtenCorpus).toContain('Lab follow-up: ferritin was 32 and LDL was 165.');
    expect(writtenCorpus).toContain('<semantic_context>');
    expect(writtenCorpus).toContain('<episodic_context>');
    expect(writtenCorpus).toContain('<turn timestamp=');
    expect(writtenCorpus).not.toContain('\n\n---\n\n');
    expect(writtenCorpus).not.toContain('viv_internal');
    expect(writtenCorpus).not.toContain('{NTA}');
    expect(writtenCorpus).not.toContain("don't have any memory of prior conversations");
    expect(writtenCorpus).not.toContain("don't think you've told me that yet");
  });

  test('shouldSkipFromRecallCorpus uses structural recall provenance instead of prompt phrases', () => {
    const service = require('../conversationRecallService');
    const assistantRecallTurn = {
      messageId: 'assistant_1',
      parentMessageId: 'user_meta',
      isCreatedByUser: false,
      attachments: [
        {
          type: 'file_search',
          file_search: {
            sources: [{ fileId: 'conversation_recall:user_1:all' }],
          },
        },
      ],
    };

    expect(
      service.shouldSkipFromRecallCorpus({
        message: { messageId: 'user_meta', isCreatedByUser: true },
        messageText: 'What exact marker was it?',
        isCreatedByUser: true,
        hasRecallDerivedChild: true,
      }),
    ).toBe(true);

    expect(
      service.shouldSkipFromRecallCorpus({
        message: assistantRecallTurn,
        messageText: 'Let me search for that.',
        isCreatedByUser: false,
      }),
    ).toBe(true);

    expect(
      service.shouldSkipFromRecallCorpus({
        message: { messageId: 'user_source', isCreatedByUser: true },
        messageText:
          'QA-only synthetic recall marker for testing: VIV-RAG-QA-20260409-1626-ONYX-FJ42. This is not a personal preference or durable memory. Reply only with the exact marker.',
        isCreatedByUser: true,
        hasRecallDerivedChild: false,
      }),
    ).toBe(false);
  });

  test('skips upload when corpus digest is unchanged between syncs', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'user note',
        },
      ]),
    );

    mockConversationFind.mockImplementation((filter) => {
      if (filter?.agent_id?.$exists) {
        return queryResult([]);
      }
      return queryResult([]);
    });

    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    const existingFile = {
      _id: 'existing_file',
      metadata: {},
    };
    mockFileFindOne.mockReturnValue(queryResult(existingFile));

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    expect(mockUploadVectors).toHaveBeenCalledTimes(1);
    expect(mockFileFindOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  test('does not skip refresh when prior upload digest differs from the current source digest', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'user note',
        },
      ]),
    );

    mockConversationFind.mockImplementation((filter) => {
      if (filter?.agent_id?.$exists) {
        return queryResult([]);
      }
      return queryResult([]);
    });

    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    const service = require('../conversationRecallService');
    mockFileFindOne.mockReturnValueOnce(queryResult(null));
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    const sourceDigest =
      mockFileFindOneAndUpdate.mock.calls[0][1].$set.metadata.conversationRecallSourceDigest;

    jest.resetModules();
    mockDeleteVectors.mockClear();
    mockUploadVectors.mockClear();
    mockFileFindOneAndUpdate.mockClear();
    mockFileFindOne.mockReturnValue(
      queryResult({
        _id: 'existing_file',
        file_id: 'conversation_recall:user_1:all',
        embedded: true,
        metadata: {
          conversationRecallSourceDigest: sourceDigest,
          conversationRecallUploadedDigest: 'reduced-window-digest',
          conversationRecallCharCount: 12345,
        },
      }),
    );

    const serviceAfterRestart = require('../conversationRecallService');
    await serviceAfterRestart.refreshConversationRecallForUser({ userId: 'user_1' });

    expect(mockDeleteVectors).toHaveBeenCalledTimes(1);
    expect(mockUploadVectors).toHaveBeenCalledTimes(1);
  });

  test('deletes prior vectors before uploading a changed recall corpus', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'user note updated',
        },
      ]),
    );

    mockConversationFind.mockImplementation((filter) => {
      if (filter?.agent_id?.$exists) {
        return queryResult([]);
      }
      return queryResult([]);
    });

    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));
    mockFileFindOne.mockReturnValue(
      queryResult({
        _id: 'existing_file',
        file_id: 'conversation_recall:user_1:all',
        embedded: true,
        metadata: {
          conversationRecallSourceDigest: 'old-digest',
        },
      }),
    );

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    expect(mockDeleteVectors).toHaveBeenCalledWith(
      { user: { id: 'user_1' } },
      {
        file_id: 'conversation_recall:user_1:all',
        embedded: true,
      },
    );
    expect(mockUploadVectors).toHaveBeenCalledTimes(1);
  });

  test('overfetches raw messages before filtering when building recall corpus', async () => {
    process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_MESSAGES = '10';
    process.env.VIVENTIUM_CONVERSATION_RECALL_FETCH_MULTIPLIER = '3';
    process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_SCAN_MESSAGES = '20';

    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    const messageQuery = queryResult([
      {
        conversationId: 'conv_real',
        createdAt: '2026-02-19T00:02:00.000Z',
        isCreatedByUser: true,
        text: 'Lab follow-up: ferritin was 32 and LDL was 165.',
      },
    ]);
    mockMessageFind.mockReturnValue(messageQuery);

    mockConversationFind.mockImplementation((filter) => {
      if (filter?.agent_id?.$exists) {
        return queryResult([]);
      }
      return queryResult([]);
    });

    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    expect(messageQuery.limit).toHaveBeenCalledWith(20);
  });

  test('refreshConversationRecallForUser upserts agent-scoped corpus when agent toggle is enabled', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: false },
      }),
    );

    mockAgentFindOne.mockReturnValue(
      queryResult({
        conversation_recall_agent_only: true,
      }),
    );

    mockConversationFind.mockImplementation((filter) => {
      if (filter?.agent_id === 'agent_1') {
        return queryResult([{ conversationId: 'conv_agent_1' }]);
      }
      return queryResult([]);
    });

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_agent_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'Agent-scoped lab follow-up: LDL 165, HDL 42, triglycerides 110.',
        },
      ]),
    );

    mockFileFindOne.mockReturnValue(queryResult(null));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_agent_1' }));

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1', agentId: 'agent_1' });

    expect(mockUploadVectors).toHaveBeenCalledTimes(1);
    expect(mockUploadVectors.mock.calls[0][0].file_id).toBe(
      'conversation_recall:user_1:agent:agent_1',
    );
    expect(mockUploadVectors.mock.calls[0][0].file.originalname).toBe(
      'conversation-recall-agent-agent_1.txt',
    );
    // Global corpus disabled branch attempts cleanup first.
    expect(mockFileFindOne).toHaveBeenCalledWith({
      user: 'user_1',
      file_id: 'conversation_recall:user_1:all',
    });
  });

  test('syncConversationRecallForConversation removes stale agent corpus when agent toggle is off', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockConversationFindOne.mockReturnValue(
      queryResult({
        agent_id: 'agent_1',
      }),
    );

    mockAgentFindOne.mockReturnValue(
      queryResult({
        conversation_recall_agent_only: false,
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'Global recall: ferritin 32 and glucose 91 from prior panel.',
        },
      ]),
    );

    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));
    mockFileFindOne.mockImplementation((filter) => {
      if (filter.file_id === 'conversation_recall:user_1:agent:agent_1') {
        return queryResult({ _id: 'stale_agent_file', file_id: filter.file_id });
      }
      return queryResult(null);
    });

    const service = require('../conversationRecallService');
    await service.syncConversationRecallForConversation({
      userId: 'user_1',
      conversationId: 'conv_1',
    });

    expect(mockUploadVectors).toHaveBeenCalledTimes(1);
    expect(mockUploadVectors.mock.calls[0][0].file_id).toBe('conversation_recall:user_1:all');
    expect(mockDeleteVectors).toHaveBeenCalledTimes(1);
    expect(mockFileDeleteOne).toHaveBeenCalledWith({ _id: 'stale_agent_file' });
  });

  test('short-circuits when RAG infrastructure is disabled', async () => {
    delete process.env.RAG_API_URL;

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });
    await service.syncConversationRecallForConversation({
      userId: 'user_1',
      conversationId: 'conv_1',
    });

    expect(mockUserFindById).not.toHaveBeenCalled();
    expect(mockUploadVectors).not.toHaveBeenCalled();
    expect(mockDeleteVectors).not.toHaveBeenCalled();
  });

  test('retries transient upload failures and succeeds when RAG API recovers', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'user note',
        },
      ]),
    );

    mockConversationFind.mockImplementation((filter) => {
      if (filter?.agent_id?.$exists) {
        return queryResult([]);
      }
      return queryResult([]);
    });

    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    mockUploadVectors
      .mockRejectedValueOnce({ response: { status: 503 }, message: 'temporary outage' })
      .mockResolvedValueOnce(undefined);

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    expect(mockUploadVectors).toHaveBeenCalledTimes(2);
    expect(mockFileFindOneAndUpdate).toHaveBeenCalledWith(
      { user: 'user_1', file_id: 'conversation_recall:user_1:all' },
      expect.any(Object),
      { upsert: true, new: true },
    );
  });

  test('does not retry non-transient upload failures', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'user note',
        },
      ]),
    );

    mockConversationFind.mockImplementation((filter) => {
      if (filter?.agent_id?.$exists) {
        return queryResult([]);
      }
      return queryResult([]);
    });

    mockFileFind.mockReturnValue(queryResult([]));
    mockUploadVectors.mockRejectedValue({
      response: { status: 400 },
      message: 'bad request',
    });

    const service = require('../conversationRecallService');

    await expect(
      service.refreshConversationRecallForUser({ userId: 'user_1' }),
    ).rejects.toMatchObject({ message: 'bad request' });
    expect(mockUploadVectors).toHaveBeenCalledTimes(1);
    expect(mockFileFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('marks replaced recall metadata unembedded before upload so failures cannot look current', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({ personalization: { conversation_recall: true } }),
    );
    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'changed clean corpus',
        },
      ]),
    );
    mockConversationFind.mockReturnValue(queryResult([]));
    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOne.mockReturnValue(
      queryResult({
        _id: 'existing_file',
        file_id: 'conversation_recall:user_1:all',
        embedded: true,
        metadata: {
          conversationRecallUploadedDigest: 'old-digest',
          conversationRecallSourceDigest: 'old-digest',
        },
      }),
    );
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'existing_file' }));
    mockUploadVectors.mockRejectedValue({ response: { status: 400 }, message: 'bad request' });

    const service = require('../conversationRecallService');
    await expect(
      service.refreshConversationRecallForUser({ userId: 'user_1' }),
    ).rejects.toMatchObject({ message: 'bad request' });

    expect(mockFileFindOneAndUpdate).toHaveBeenCalledWith(
      { user: 'user_1', file_id: 'conversation_recall:user_1:all' },
      expect.objectContaining({
        $set: { embedded: false },
        $unset: expect.objectContaining({
          'metadata.conversationRecallUploadedDigest': '',
        }),
      }),
      { new: true },
    );
  });

  test('same-process refresh rebuilds after a failed replacement instead of trusting cached digest', async () => {
    let messageText = 'corpus-a';
    mockUserFindById.mockReturnValue(
      queryResult({ personalization: { conversation_recall: true } }),
    );
    mockMessageFind.mockImplementation(() =>
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: messageText,
        },
      ]),
    );
    mockConversationFind.mockReturnValue(queryResult([]));
    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOne.mockReturnValue(
      queryResult({ _id: 'existing_file', embedded: true, metadata: {} }),
    );
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'existing_file' }));
    mockUploadVectors
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce({ response: { status: 400 }, message: 'bad request' })
      .mockResolvedValueOnce(undefined);

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });
    messageText = 'corpus-b';
    await expect(
      service.refreshConversationRecallForUser({ userId: 'user_1' }),
    ).rejects.toMatchObject({ message: 'bad request' });
    messageText = 'corpus-a';
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    expect(mockUploadVectors).toHaveBeenCalledTimes(3);
  });

  test('self-heals duplicate vector write errors by deleting stale vectors and retrying upload', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'Project Atlas planning notes',
        },
      ]),
    );

    mockConversationFind.mockImplementation((filter) => {
      if (filter?.agent_id?.$exists) {
        return queryResult([]);
      }
      return queryResult([]);
    });

    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));
    mockUploadVectors
      .mockRejectedValueOnce({
        response: {
          status: 200,
          data: {
            status: false,
            message:
              'batch op errors occurred, E11000 duplicate key error collection: rag-db.rag-collection',
          },
        },
        message: 'File embedding failed: E11000 duplicate key',
      })
      .mockResolvedValueOnce(undefined);

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    expect(mockUploadVectors).toHaveBeenCalledTimes(2);
    expect(mockDeleteVectors).toHaveBeenCalledWith(
      { user: { id: 'user_1' } },
      expect.objectContaining({
        file_id: 'conversation_recall:user_1:all',
        embedded: true,
      }),
    );
    expect(mockFileFindOneAndUpdate).toHaveBeenCalledWith(
      { user: 'user_1', file_id: 'conversation_recall:user_1:all' },
      expect.any(Object),
      { upsert: true, new: true },
    );
  });

  test('retries transient upload failures when status is only present in error message', async () => {
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_MAX_ATTEMPTS = '2';

    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'user note',
        },
      ]),
    );

    mockConversationFind.mockImplementation((filter) => {
      if (filter?.agent_id?.$exists) {
        return queryResult([]);
      }
      return queryResult([]);
    });

    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    mockUploadVectors
      .mockRejectedValueOnce(new Error('Request failed with status code 503'))
      .mockResolvedValueOnce(undefined);

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    expect(mockUploadVectors).toHaveBeenCalledTimes(2);
    expect(mockFileFindOneAndUpdate).toHaveBeenCalledWith(
      { user: 'user_1', file_id: 'conversation_recall:user_1:all' },
      expect.any(Object),
      { upsert: true, new: true },
    );
  });

  test('reduces corpus size and retries upload when large corpus keeps returning 503', async () => {
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_MAX_ATTEMPTS = '1';
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_MAX_CORPUS_REDUCTIONS = '2';
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_REDUCTION_FACTOR = '0.5';
    process.env.VIVENTIUM_CONVERSATION_RECALL_MIN_CHARS = '20000';
    process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_MESSAGE_TEXT_CHARS = '60000';

    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'x'.repeat(50000),
        },
      ]),
    );

    mockConversationFind.mockImplementation((filter) => {
      if (filter?.agent_id?.$exists) {
        return queryResult([]);
      }
      return queryResult([]);
    });

    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    mockUploadVectors
      .mockRejectedValueOnce({ response: { status: 503 }, message: 'temporary outage' })
      .mockResolvedValueOnce(undefined);

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    expect(mockUploadVectors).toHaveBeenCalledTimes(2);
    const firstSize = mockUploadVectors.mock.calls[0][0].file.size;
    const secondSize = mockUploadVectors.mock.calls[1][0].file.size;
    expect(secondSize).toBeLessThan(firstSize);
    expect(secondSize).toBeGreaterThanOrEqual(20000);
  });

  test('reduces corpus size and retries upload when upload times out', async () => {
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_MAX_ATTEMPTS = '1';
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_MAX_CORPUS_REDUCTIONS = '2';
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_REDUCTION_FACTOR = '0.5';
    process.env.VIVENTIUM_CONVERSATION_RECALL_MIN_CHARS = '20000';
    process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_MESSAGE_TEXT_CHARS = '60000';

    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'x'.repeat(50000),
        },
      ]),
    );

    mockConversationFind.mockImplementation((filter) => {
      if (filter?.agent_id?.$exists) {
        return queryResult([]);
      }
      return queryResult([]);
    });

    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    mockUploadVectors
      .mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 60000ms exceeded' })
      .mockResolvedValueOnce(undefined);

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    expect(mockUploadVectors).toHaveBeenCalledTimes(2);
    const firstSize = mockUploadVectors.mock.calls[0][0].file.size;
    const secondSize = mockUploadVectors.mock.calls[1][0].file.size;
    expect(secondSize).toBeLessThan(firstSize);
    expect(secondSize).toBeGreaterThanOrEqual(20000);
  });

  test('records reduced-upload metadata and keeps the source digest eligible for future rebuilds', async () => {
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_MAX_ATTEMPTS = '1';
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_MAX_CORPUS_REDUCTIONS = '2';
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_REDUCTION_FACTOR = '0.5';
    process.env.VIVENTIUM_CONVERSATION_RECALL_MIN_CHARS = '20000';
    process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_MESSAGE_TEXT_CHARS = '60000';

    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'x'.repeat(50000),
        },
      ]),
    );

    mockConversationFind.mockImplementation((filter) => {
      if (filter?.agent_id?.$exists) {
        return queryResult([]);
      }
      return queryResult([]);
    });

    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    mockUploadVectors
      .mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 60000ms exceeded' })
      .mockResolvedValueOnce(undefined);

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    const updateDoc = mockFileFindOneAndUpdate.mock.calls[0][1];
    expect(updateDoc.$set.metadata.conversationRecallUsedReducedUploadWindow).toBe(true);
    expect(updateDoc.$set.metadata.conversationRecallSourceCharCount).toBeGreaterThan(
      updateDoc.$set.metadata.conversationRecallCharCount,
    );
    expect(updateDoc.$set.metadata.conversationRecallSourceDigest).not.toBe(
      updateDoc.$set.metadata.conversationRecallUploadedDigest,
    );
  });

  test('falls back to emergency seed corpus when reductions cannot shrink enough', async () => {
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_MAX_ATTEMPTS = '1';
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_MAX_CORPUS_REDUCTIONS = '0';
    process.env.VIVENTIUM_CONVERSATION_RECALL_MIN_CHARS = '60000';
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_SEED_CHARS = '30000';
    process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_MESSAGE_TEXT_CHARS = '90000';

    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'x'.repeat(80000),
        },
      ]),
    );

    mockConversationFind.mockImplementation((filter) => {
      if (filter?.agent_id?.$exists) {
        return queryResult([]);
      }
      return queryResult([]);
    });

    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    mockUploadVectors
      .mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 60000ms exceeded' })
      .mockResolvedValueOnce(undefined);

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    expect(mockUploadVectors).toHaveBeenCalledTimes(2);
    const firstSize = mockUploadVectors.mock.calls[0][0].file.size;
    const secondSize = mockUploadVectors.mock.calls[1][0].file.size;
    expect(firstSize).toBeGreaterThan(30000);
    expect(secondSize).toBeLessThan(firstSize);
    expect(secondSize).toBeLessThanOrEqual(30000);
  });

  test('coalesces queued conversation syncs per user', async () => {
    jest.useFakeTimers();

    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );
    mockConversationFind.mockReturnValue(queryResult([]));
    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'user note',
        },
      ]),
    );
    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    const service = require('../conversationRecallService');
    service.scheduleConversationRecallSync({ userId: 'user_1', conversationId: 'conv_1' });
    service.scheduleConversationRecallSync({ userId: 'user_1', conversationId: 'conv_2' });
    service.scheduleConversationRecallSync({ userId: 'user_1', conversationId: 'conv_1' });

    await jest.runOnlyPendingTimersAsync();
    await Promise.resolve();

    expect(mockUploadVectors).toHaveBeenCalledTimes(1);
    expect(mockMessageFind).toHaveBeenCalledTimes(1);
  });

  test('defers proactive sync until callback commit and schedules nothing after abort', async () => {
    jest.useFakeTimers();
    const afterCommit = [];
    mockDeferAfterCommit.mockImplementation((operation) => {
      afterCommit.push(operation);
      return true;
    });
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );
    mockConversationFind.mockReturnValue(queryResult([]));
    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_committed',
          createdAt: '2026-08-28T03:39:30.000Z',
          isCreatedByUser: false,
          text: 'Committed callback follow-up.',
        },
      ]),
    );
    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    const service = require('../conversationRecallService');
    service.scheduleConversationRecallSync({
      userId: 'user_1',
      conversationId: 'conv_committed',
    });

    expect(afterCommit).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(mockMessageFind).not.toHaveBeenCalled();

    await afterCommit[0]();
    await jest.runOnlyPendingTimersAsync();
    await Promise.resolve();

    expect(mockMessageFind).toHaveBeenCalledTimes(1);

    service.scheduleConversationRecallSync({
      userId: 'user_1',
      conversationId: 'conv_aborted',
    });
    expect(afterCommit).toHaveLength(2);
    expect(jest.getTimerCount()).toBe(0);

    await jest.runOnlyPendingTimersAsync();
    expect(mockMessageFind).toHaveBeenCalledTimes(1);
  });

  test('applies cooldown after transient sync failure', async () => {
    jest.useFakeTimers();

    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_MAX_ATTEMPTS = '1';

    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );
    mockConversationFindOne.mockReturnValue(queryResult({ agent_id: null }));
    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'user note',
        },
      ]),
    );
    mockUploadVectors.mockRejectedValue({
      response: { status: 503 },
      message: 'temporary outage',
    });

    const service = require('../conversationRecallService');
    service.scheduleConversationRecallSync({ userId: 'user_1', conversationId: 'conv_1' });
    await jest.advanceTimersByTimeAsync(2);
    expect(mockUploadVectors).toHaveBeenCalledTimes(1);

    service.scheduleConversationRecallSync({ userId: 'user_1', conversationId: 'conv_2' });
    await jest.advanceTimersByTimeAsync(10);
    expect(mockUploadVectors).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(20);
    expect(mockUploadVectors).toHaveBeenCalledTimes(1);
  });

  test('treats ECONNABORTED upload failures as transient and retries', async () => {
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_MAX_ATTEMPTS = '2';

    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'user note',
        },
      ]),
    );

    mockConversationFind.mockImplementation((filter) => {
      if (filter?.agent_id?.$exists) {
        return queryResult([]);
      }
      return queryResult([]);
    });

    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));
    mockUploadVectors
      .mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 5000ms exceeded' })
      .mockResolvedValueOnce(undefined);

    const service = require('../conversationRecallService');
    await service.refreshConversationRecallForUser({ userId: 'user_1' });

    expect(mockUploadVectors).toHaveBeenCalledTimes(2);
  });

  test('stops automatic queued retries after reaching max transient sync failures', async () => {
    jest.useFakeTimers();
    process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_TRANSIENT_FAILURES = '1';
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_MAX_ATTEMPTS = '1';

    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );
    mockConversationFind.mockReturnValue(queryResult([]));
    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'user note',
        },
      ]),
    );
    mockUploadVectors.mockRejectedValue({
      response: { status: 503 },
      message: 'temporary outage',
    });

    const service = require('../conversationRecallService');
    service.scheduleConversationRecallSync({ userId: 'user_1', conversationId: 'conv_1' });

    await jest.advanceTimersByTimeAsync(5);
    expect(mockUploadVectors).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(300000);
    expect(mockUploadVectors).toHaveBeenCalledTimes(1);
  });

  test('throttles proactive sync retries by minimum sync interval', async () => {
    jest.useFakeTimers();
    process.env.VIVENTIUM_CONVERSATION_RECALL_MIN_SYNC_INTERVAL_MS = '100';

    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );
    mockConversationFind.mockReturnValue(queryResult([]));
    mockMessageFind.mockImplementation(() =>
      queryResult([
        {
          conversationId: 'conv_1',
          createdAt: '2026-02-19T00:00:00.000Z',
          isCreatedByUser: true,
          text: 'user note',
        },
      ]),
    );
    mockFileFind.mockReturnValue(queryResult([]));
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    const service = require('../conversationRecallService');
    service.scheduleConversationRecallSync({ userId: 'user_1', conversationId: 'conv_1' });
    await jest.advanceTimersByTimeAsync(5);
    expect(mockUploadVectors).toHaveBeenCalledTimes(1);

    service.scheduleConversationRecallSync({ userId: 'user_1', conversationId: 'conv_2' });
    await jest.advanceTimersByTimeAsync(50);
    expect(mockUploadVectors).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60);
    expect(mockUploadVectors).toHaveBeenCalledTimes(2);
  });

  test('cleanup rebuild returns a content-free receipt bound to current recall artifacts', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({ personalization: { conversation_recall: true } }),
    );
    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'conversation-cleanup-1',
          createdAt: '2026-08-25T16:00:00.000Z',
          isCreatedByUser: true,
          text: 'private source text must not enter the receipt',
        },
      ]),
    );
    mockConversationFind.mockReturnValue(queryResult([]));
    mockFileFind.mockReturnValueOnce(queryResult([])).mockReturnValueOnce(
      queryResult([
        {
          file_id: 'conversation_recall:user_1:all',
          embedded: true,
          metadata: {
            conversationRecallSourceDigest: 'a'.repeat(64),
            conversationRecallUploadedDigest: 'b'.repeat(64),
            conversationRecallUsedReducedUploadWindow: true,
          },
        },
      ]),
    );
    mockFileFindOneAndUpdate.mockReturnValue(queryResult({ _id: 'file_all' }));

    const service = require('../conversationRecallService');
    const receipt = await service.reconcileConversationRecallForCleanup({
      userId: 'user_1',
      operationId: 'cleanup-operation-1',
      targetSetSha256: 'c'.repeat(64),
    });

    expect(receipt).toEqual({
      status: 'verified',
      receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      artifactCount: 1,
    });
    expect(JSON.stringify(receipt)).not.toMatch(/user_1|conversation-cleanup|private source/);
  });

  test('cleanup delayed verification fails when current recall state differs from its receipt', async () => {
    const currentFile = (digest) =>
      queryResult([
        {
          file_id: 'conversation_recall:user_1:all',
          embedded: true,
          metadata: {
            conversationRecallSourceDigest: digest,
            conversationRecallUploadedDigest: digest,
            conversationRecallUsedReducedUploadWindow: false,
          },
        },
      ]);
    mockFileFind.mockReturnValueOnce(currentFile('a'.repeat(64)));
    const service = require('../conversationRecallService');
    const initial = await service.inspectConversationRecallCleanupReceipt({
      userId: 'user_1',
      operationId: 'cleanup-operation-1',
      targetSetSha256: 'c'.repeat(64),
    });
    mockFileFind.mockReturnValueOnce(currentFile('b'.repeat(64)));

    await expect(
      service.verifyConversationRecallCleanupReceipt({
        userId: 'user_1',
        operationId: 'cleanup-operation-1',
        targetSetSha256: 'c'.repeat(64),
        expectedReceiptSha256: initial.receiptSha256,
      }),
    ).resolves.toEqual({ verified: false });
  });

  test('cleanup recall reconciliation fails closed when vector infrastructure is unavailable', async () => {
    delete process.env.RAG_API_URL;
    const service = require('../conversationRecallService');

    await expect(
      service.reconcileConversationRecallForCleanup({
        userId: 'user_1',
        operationId: 'cleanup-operation-1',
        targetSetSha256: 'c'.repeat(64),
      }),
    ).rejects.toThrow('cleanup_recall_infrastructure_unavailable');
    expect(mockFileFind).not.toHaveBeenCalled();
  });
});
