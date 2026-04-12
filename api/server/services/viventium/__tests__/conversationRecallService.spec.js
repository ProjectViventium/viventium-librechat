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

jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    },
  }),
  { virtual: true },
);

jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  return {
    ...actualFs,
    promises: {
      ...actualFs.promises,
      writeFile: (...args) => mockWriteFile(...args),
      unlink: (...args) => mockUnlink(...args),
    },
  };
});

jest.mock('~/server/services/Files/VectorDB/crud', () => ({
  uploadVectors: (...args) => mockUploadVectors(...args),
  deleteVectors: (...args) => mockDeleteVectors(...args),
}));

jest.mock('~/db/models', () => ({
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

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
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

    mockWriteFile.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
    mockUploadVectors.mockResolvedValue(undefined);
    mockDeleteVectors.mockResolvedValue(undefined);
    mockFileDeleteOne.mockResolvedValue({ deletedCount: 1 });
    mockFileFindOne.mockReturnValue(queryResult(null));
  });

  afterEach(() => {
    jest.useRealTimers();
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
      'messageId parentMessageId conversationId createdAt sender isCreatedByUser text attachments',
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
    expect(mockFileFindOneAndUpdate).toHaveBeenCalledTimes(1);
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
});
