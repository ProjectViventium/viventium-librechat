const axios = require('axios');

jest.mock('axios');
jest.mock('@librechat/api', () => ({
  generateShortLivedToken: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('~/models', () => ({
  getFiles: jest.fn().mockResolvedValue([]),
}));

const mockMessageFind = jest.fn();
const mockConversationFind = jest.fn();

jest.mock('~/db/models', () => ({
  Message: {
    find: (...args) => mockMessageFind(...args),
  },
  Conversation: {
    find: (...args) => mockConversationFind(...args),
  },
}));

jest.mock('~/server/services/viventium/conversationRecallService', () => ({
  getMessageText: jest.fn((message) => message?.text || ''),
  shouldSkipFromRecallCorpus: jest.fn(({ messageText, hasRecallDerivedChild = false, message }) => {
    const metadata = message?.metadata?.viventium;
    if (metadata?.type === 'listen_only_transcript' && metadata?.mode === 'listen_only') {
      return true;
    }
    const hasRecallAttachment =
      Array.isArray(message?.attachments) &&
      message.attachments.some(
        (attachment) =>
          attachment?.type === 'file_search' &&
          Array.isArray(attachment?.file_search?.sources) &&
          attachment.file_search.sources.some(
            (source) =>
              typeof source?.fileId === 'string' &&
              source.fileId.startsWith('conversation_recall:'),
          ),
      );
    return !messageText || hasRecallDerivedChild || hasRecallAttachment;
  }),
}));

jest.mock('~/server/services/Files/permissions', () => ({
  filterFilesByAgentAccess: jest.fn((options) => Promise.resolve(options.files)),
}));

const { createFileSearchTool } = require('~/app/clients/tools/util/fileSearch');
const { generateShortLivedToken } = require('@librechat/api');
const { getFiles } = require('~/models');
const { primeFiles } = require('~/app/clients/tools/util/fileSearch');
const {
  shouldSkipFromRecallCorpus,
} = require('~/server/services/viventium/conversationRecallService');
const {
  FILE_SEARCH_NO_RETRIEVED_EVIDENCE,
} = require('~/app/clients/tools/util/modelFacingToolOutput');

function queryResult(result) {
  return {
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result),
  };
}

describe('fileSearch.js - tuple return validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RAG_API_URL = 'http://localhost:8000';
    delete process.env.VIVENTIUM_FILE_SEARCH_QUERY_TIMEOUT_MS;
    delete process.env.VIVENTIUM_FILE_SEARCH_QUERY_TIMEOUT_MS_CONVERSATION_RECALL;
    delete process.env.VIVENTIUM_FILE_SEARCH_QUERY_TIMEOUT_MS_MEETING_TRANSCRIPT;
    delete process.env.VIVENTIUM_FILE_SEARCH_TOP_K;
    delete process.env.VIVENTIUM_FILE_SEARCH_TOP_K_CONVERSATION_RECALL;
    delete process.env.VIVENTIUM_FILE_SEARCH_TOP_K_MEETING_TRANSCRIPT;
    delete process.env.VIVENTIUM_FILE_SEARCH_TOP_K_MEETING_TRANSCRIPT_BATCH_MAX;
    delete process.env.VIVENTIUM_FILE_SEARCH_MAX_RESULTS;
    delete process.env.VIVENTIUM_FILE_SEARCH_MAX_RESULTS_CONVERSATION_RECALL;
    delete process.env.VIVENTIUM_FILE_SEARCH_MAX_RESULTS_MEETING_TRANSCRIPT;
    delete process.env.VIVENTIUM_FILE_SEARCH_RESULT_MAX_CHARS;
    delete process.env.VIVENTIUM_FILE_SEARCH_RESULT_MAX_CHARS_CONVERSATION_RECALL;
    delete process.env.VIVENTIUM_FILE_SEARCH_RESULT_MAX_CHARS_MEETING_TRANSCRIPT;
    delete process.env.VIVENTIUM_FILE_SEARCH_OUTPUT_MAX_CHARS;
    delete process.env.VIVENTIUM_FILE_SEARCH_OUTPUT_MAX_CHARS_CONVERSATION_RECALL;
    delete process.env.VIVENTIUM_FILE_SEARCH_OUTPUT_MAX_CHARS_MEETING_TRANSCRIPT;
    delete process.env.VIVENTIUM_FILE_SEARCH_LITERAL_FALLBACK_MAX_MATCHES;
    mockMessageFind.mockReturnValue(queryResult([]));
    mockConversationFind.mockReturnValue(queryResult([]));
    shouldSkipFromRecallCorpus.mockImplementation(
      ({ messageText, hasRecallDerivedChild = false, message }) => {
        const metadata = message?.metadata?.viventium;
        if (metadata?.type === 'listen_only_transcript' && metadata?.mode === 'listen_only') {
          return true;
        }
        const hasRecallAttachment =
          Array.isArray(message?.attachments) &&
          message.attachments.some(
            (attachment) =>
              attachment?.type === 'file_search' &&
              Array.isArray(attachment?.file_search?.sources) &&
              attachment.file_search.sources.some(
                (source) =>
                  typeof source?.fileId === 'string' &&
                  source.fileId.startsWith('conversation_recall:'),
              ),
          );
        return !messageText || hasRecallDerivedChild || hasRecallAttachment;
      },
    );
  });

  describe('error cases should return tuple with undefined as second value', () => {
    it('should return tuple when no files provided', async () => {
      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [],
      });

      const result = await fileSearchTool.func({ query: 'test query' });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('No files to search. Instruct the user to add files for the search.');
      expect(result[1]).toBeUndefined();
    });

    it('should return tuple when JWT token generation fails', async () => {
      generateShortLivedToken.mockReturnValue(null);

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [{ file_id: 'file-1', filename: 'test.pdf' }],
      });

      const result = await fileSearchTool.func({ query: 'test query' });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(FILE_SEARCH_NO_RETRIEVED_EVIDENCE);
      expect(result[1]).toBeUndefined();
    });

    it('should return tuple when no valid results found', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockRejectedValue(new Error('API Error'));

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [{ file_id: 'file-1', filename: 'test.pdf' }],
      });

      const result = await fileSearchTool.func({ query: 'test query' });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(FILE_SEARCH_NO_RETRIEVED_EVIDENCE);
      expect(result[1]).toBeUndefined();
    });
  });

  describe('success cases should return tuple with artifact object', () => {
    it('should return tuple with formatted results and sources artifact', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');

      const mockApiResponse = {
        data: [
          [
            {
              page_content: 'This is test content from the document',
              metadata: { source: '/path/to/test.pdf', page: 1 },
            },
            0.2,
          ],
          [
            {
              page_content: 'Additional relevant content',
              metadata: { source: '/path/to/test.pdf', page: 2 },
            },
            0.35,
          ],
        ],
      };

      axios.post.mockResolvedValue(mockApiResponse);

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [{ file_id: 'file-123', filename: 'test.pdf' }],
        entity_id: 'agent-456',
      });

      const result = await fileSearchTool.func({ query: 'test query' });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);

      const [formattedString, artifact] = result;

      expect(typeof formattedString).toBe('string');
      expect(formattedString).toContain('File: test.pdf');
      expect(formattedString).toContain('Relevance:');
      expect(formattedString).toContain('This is test content from the document');
      expect(formattedString).toContain('Additional relevant content');

      expect(artifact).toBeDefined();
      expect(artifact).toHaveProperty('file_search');
      expect(artifact.file_search).toHaveProperty('sources');
      expect(artifact.file_search).toHaveProperty('fileCitations', false);
      expect(Array.isArray(artifact.file_search.sources)).toBe(true);
      expect(artifact.file_search.sources.length).toBe(2);

      const source = artifact.file_search.sources[0];
      expect(source).toMatchObject({
        type: 'file',
        fileId: 'file-123',
        fileName: 'test.pdf',
        content: expect.any(String),
        relevance: expect.any(Number),
        pages: [1],
        pageRelevance: { 1: expect.any(Number) },
      });
    });

    it('should include file citations in description when enabled', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');

      const mockApiResponse = {
        data: [
          [
            {
              page_content: 'Content with citations',
              metadata: { source: '/path/to/doc.pdf', page: 3 },
            },
            0.15,
          ],
        ],
      };

      axios.post.mockResolvedValue(mockApiResponse);

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [{ file_id: 'file-789', filename: 'doc.pdf' }],
        fileCitations: true,
      });

      const result = await fileSearchTool.func({ query: 'test query' });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);

      const [formattedString, artifact] = result;

      expect(formattedString).toContain('Anchor:');
      expect(formattedString).toContain('\\ue202turn0file0');
      expect(artifact.file_search.fileCitations).toBe(true);
    });

    it('should handle multiple files correctly', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');

      const mockResponse1 = {
        data: [
          [
            {
              page_content: 'Content from file 1',
              metadata: { source: '/path/to/file1.pdf', page: 1 },
            },
            0.25,
          ],
        ],
      };

      const mockResponse2 = {
        data: [
          [
            {
              page_content: 'Content from file 2',
              metadata: { source: '/path/to/file2.pdf', page: 1 },
            },
            0.15,
          ],
        ],
      };

      axios.post.mockResolvedValueOnce(mockResponse1).mockResolvedValueOnce(mockResponse2);

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          { file_id: 'file-1', filename: 'file1.pdf' },
          { file_id: 'file-2', filename: 'file2.pdf' },
        ],
      });

      const result = await fileSearchTool.func({ query: 'test query' });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);

      const [formattedString, artifact] = result;

      expect(formattedString).toContain('file1.pdf');
      expect(formattedString).toContain('file2.pdf');
      expect(artifact.file_search.sources).toHaveLength(2);
      // Results are sorted by distance (ascending), so file-2 (0.15) comes before file-1 (0.25)
      expect(artifact.file_search.sources[0].fileId).toBe('file-2');
      expect(artifact.file_search.sources[1].fileId).toBe('file-1');
    });

    it('should preserve file mapping when one file query fails', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');

      axios.post
        .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }))
        .mockResolvedValueOnce({
          data: [
            [
              {
                page_content: 'Recovered content from file 2',
                metadata: { source: '/path/to/file2.pdf', page: 2 },
              },
              0.11,
            ],
          ],
        });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          { file_id: 'file-1', filename: 'file1.pdf' },
          { file_id: 'file-2', filename: 'file2.pdf' },
        ],
      });

      const result = await fileSearchTool.func({ query: 'test query' });
      const [, artifact] = result;

      expect(artifact.file_search.sources).toHaveLength(1);
      expect(artifact.file_search.sources[0].fileId).toBe('file-2');
      expect(artifact.file_search.sources[0].fileName).toBe('file2.pdf');
    });

    it('should set query timeout from environment', async () => {
      process.env.VIVENTIUM_FILE_SEARCH_QUERY_TIMEOUT_MS = '4321';
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({
        data: [
          [
            {
              page_content: 'Content from file 1',
              metadata: { source: '/path/to/file1.pdf', page: 1 },
            },
            0.1,
          ],
        ],
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [{ file_id: 'file-1', filename: 'file1.pdf' }],
      });

      await fileSearchTool.func({ query: 'test query' });

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:8000/query',
        expect.any(Object),
        expect.objectContaining({ timeout: 4321 }),
      );
    });

    it('should use conversation-recall timeout override for conversation recall files', async () => {
      process.env.VIVENTIUM_FILE_SEARCH_QUERY_TIMEOUT_MS = '4321';
      process.env.VIVENTIUM_FILE_SEARCH_QUERY_TIMEOUT_MS_CONVERSATION_RECALL = '1234';
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({
        data: [
          [
            {
              page_content: 'Recall content',
              metadata: { source: '/path/to/conversation-recall.txt', page: 1 },
            },
            0.1,
          ],
        ],
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          { file_id: 'conversation_recall:user_1:all', filename: 'conversation-recall-all.txt' },
        ],
      });

      await fileSearchTool.func({ query: 'remember my name' });

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:8000/query',
        expect.any(Object),
        expect.objectContaining({ timeout: 1234 }),
      );
    });

    it('uses meeting-transcript timeout override for meeting transcript files', async () => {
      process.env.VIVENTIUM_FILE_SEARCH_QUERY_TIMEOUT_MS = '4321';
      process.env.VIVENTIUM_FILE_SEARCH_QUERY_TIMEOUT_MS_MEETING_TRANSCRIPT = '30001';
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({
        data: [
          [
            {
              page_content: 'Meeting transcript content',
              metadata: { source: '/path/to/meeting-transcript.txt', page: 1 },
            },
            0.1,
          ],
        ],
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          {
            file_id: 'meeting_transcript:user_1:abc',
            filename: 'meeting-transcript-abc.txt',
          },
        ],
      });

      await fileSearchTool.func({ query: 'Project Lantern checklist' });

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:8000/query_multiple',
        expect.objectContaining({ file_ids: ['meeting_transcript:user_1:abc'] }),
        expect.objectContaining({ timeout: 30001 }),
      );
    });

    it('should use conversation-recall top-k override for conversation recall files', async () => {
      process.env.VIVENTIUM_FILE_SEARCH_TOP_K = '5';
      process.env.VIVENTIUM_FILE_SEARCH_TOP_K_CONVERSATION_RECALL = '9';
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({
        data: [
          [
            {
              page_content: 'Recall content',
              metadata: { source: '/path/to/conversation-recall.txt', page: 1 },
            },
            0.1,
          ],
        ],
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          { file_id: 'conversation_recall:user_1:all', filename: 'conversation-recall-all.txt' },
        ],
      });

      await fileSearchTool.func({ query: 'remember my name' });

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:8000/query',
        expect.objectContaining({ k: 9 }),
        expect.any(Object),
      );
    });

    it('uses meeting-transcript top-k override for meeting summary files', async () => {
      process.env.VIVENTIUM_FILE_SEARCH_TOP_K = '5';
      process.env.VIVENTIUM_FILE_SEARCH_TOP_K_MEETING_TRANSCRIPT = '11';
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({
        data: [
          [
            {
              page_content: 'Meeting summary content',
              metadata: { source: '/path/to/meeting-summary.txt', page: 1 },
            },
            0.1,
          ],
        ],
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [{ file_id: 'meeting_summary:user_1:abc', filename: 'meeting-summary-abc.txt' }],
      });

      await fileSearchTool.func({ query: 'Project Lantern checklist' });

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:8000/query_multiple',
        expect.objectContaining({ file_ids: ['meeting_summary:user_1:abc'], k: 11 }),
        expect.any(Object),
      );
    });

    it('scales meeting-transcript query_multiple k with file count under a hard cap', async () => {
      process.env.VIVENTIUM_FILE_SEARCH_TOP_K_MEETING_TRANSCRIPT = '4';
      process.env.VIVENTIUM_FILE_SEARCH_TOP_K_MEETING_TRANSCRIPT_BATCH_MAX = '10';
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({
        data: [
          [
            {
              page_content: 'Meeting summary content',
              metadata: {
                file_id: 'meeting_summary:user_1:one',
                source: '/path/to/meeting-summary-one.txt',
                page: 1,
              },
            },
            0.1,
          ],
        ],
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          { file_id: 'meeting_summary:user_1:one', filename: 'meeting-summary-one.txt' },
          { file_id: 'meeting_summary:user_1:two', filename: 'meeting-summary-two.txt' },
          { file_id: 'meeting_summary:user_1:three', filename: 'meeting-summary-three.txt' },
        ],
      });

      await fileSearchTool.func({ query: 'Project Lantern checklist' });

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:8000/query_multiple',
        expect.objectContaining({
          file_ids: [
            'meeting_summary:user_1:one',
            'meeting_summary:user_1:two',
            'meeting_summary:user_1:three',
          ],
          k: 10,
        }),
        expect.any(Object),
      );
    });

    it('adds meeting transcript provenance headers to model output and source artifacts', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({
        data: [
          [
            {
              page_content:
                '10:02 Sam: Project Lantern keeps the Tuesday launch checklist. 10:08 Lee: The older Monday plan is stale.',
              metadata: { source: '/path/to/meeting-summary.txt', page: 1 },
            },
            0.08,
          ],
        ],
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          {
            file_id: 'meeting_summary:user_1:abc',
            filename: 'meeting-transcript-summary-abc.txt',
            metadata: {
              meetingTranscriptArtifactId: 'meeting_transcript:abc',
              meetingTranscriptKind: 'summary',
              meetingTranscriptOriginalFilename: '2026-05-05-lantern.vtt',
              meetingTranscriptFileMtime: '2026-05-05T18:30:00.000Z',
              meetingTranscriptSourceStatus: 'new_or_changed',
              meetingTranscriptCalendarMatch: {
                title: 'Project Lantern review',
                start: '2026-05-05T18:00:00.000Z',
              },
            },
          },
        ],
      });

      const [formattedString, artifact] = await fileSearchTool.func({
        query: 'Project Lantern launch checklist',
      });

      expect(formattedString).toContain('File: meeting-transcript-summary-abc.txt');
      expect(formattedString).not.toContain('File: meeting-summary.txt');
      expect(formattedString).toContain('Transcript artifact ID: meeting_transcript:abc');
      expect(formattedString).toContain('Transcript artifact kind: summary');
      expect(formattedString).toContain('Original filename: 2026-05-05-lantern.vtt');
      expect(formattedString).toContain('File mtime: 2026-05-05T18:30:00.000Z');
      expect(formattedString).toContain('Source status: new_or_changed');
      expect(formattedString).toContain('"Project Lantern review"');
      expect(formattedString).toContain('10:02 Sam:');
      expect(artifact.file_search.sources[0].content).toContain(
        'Transcript artifact ID: meeting_transcript:abc',
      );
      expect(artifact.file_search.sources[0].content).toContain('10:08 Lee:');
      expect(artifact.file_search.sources[0].fileName).toBe('meeting-transcript-summary-abc.txt');
    });

    it('returns the source-backed meeting transcript inventory without relying on vector similarity', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({ data: [] });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          {
            file_id: 'meeting_inventory:user_1:sourcehash',
            filename: 'meeting-transcript-inventory-sourcehash.txt',
            metadata: {
              meetingTranscriptArtifactId: 'meeting_transcript_inventory:current',
              meetingTranscriptKind: 'inventory',
              meetingTranscriptDisplayTitle: 'Meeting transcript inventory',
              meetingTranscriptOneLineSummary: 'Current transcript list.',
              meetingTranscriptInventoryText: [
                'Meeting transcript inventory / table of contents.',
                'Current processed transcript summaries: 2',
                '1. Project Lantern review',
                '   Date/time: 2026-05-05T18:30:00.000Z',
                '   Participants: Sam, Lee',
                '   Context: Tuesday launch checklist and stale Monday plan.',
                '2. Partner discovery call',
                '   Participants: Avery, Morgan',
                '   Context: Use-case priorities for a second meeting.',
              ].join('\n'),
            },
          },
          {
            file_id: 'meeting_summary:user_1:abc',
            filename: 'meeting-transcript-summary-abc.txt',
            metadata: {
              meetingTranscriptArtifactId: 'meeting_transcript:abc',
              meetingTranscriptKind: 'summary',
            },
          },
        ],
      });

      const [formattedString, artifact] = await fileSearchTool.func({
        query: 'what recent transcripts do you see?',
      });

      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.post.mock.calls[0][0]).toBe('http://localhost:8000/query_multiple');
      expect(axios.post.mock.calls[0][1].file_ids).toEqual(['meeting_summary:user_1:abc']);
      expect(formattedString).toContain('Transcript artifact kind: inventory');
      expect(formattedString).toContain('Current processed transcript summaries: 2');
      expect(formattedString).toContain('Project Lantern review');
      expect(artifact.file_search.sources[0].fileId).toBe('meeting_inventory:user_1:sourcehash');
    });

    it('does not append source-only conversation recall rescue when transcript evidence is present', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({ data: [] });
      mockMessageFind.mockReturnValue(
        queryResult([
          {
            messageId: 'stale_prompt',
            conversationId: 'older-convo',
            createdAt: '2026-05-12T12:00:00.000Z',
            isCreatedByUser: true,
            text: 'What recent meeting transcript entries do you see?',
          },
        ]),
      );

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          {
            file_id: 'conversation_recall:user_1:all',
            filename: 'conversation-recall-all.txt',
            viventiumConversationRecallMode: 'source_only',
          },
          {
            file_id: 'meeting_inventory:user_1:sourcehash',
            filename: 'meeting-transcript-inventory-sourcehash.txt',
            metadata: {
              meetingTranscriptArtifactId: 'meeting_transcript_inventory:current',
              meetingTranscriptKind: 'inventory',
              meetingTranscriptInventoryText:
                'Meeting transcript inventory / table of contents.\n1. Helios launch review',
            },
          },
          {
            file_id: 'meeting_summary:user_1:helios',
            filename: 'meeting-transcript-summary-helios.txt',
            metadata: { meetingTranscriptKind: 'summary' },
          },
        ],
      });

      const [, artifact] = await fileSearchTool.func({
        query: 'what recent meeting transcript entries do you see?',
      });

      expect(mockMessageFind).not.toHaveBeenCalled();
      expect(artifact.file_search.sources.map((source) => source.fileId)).toEqual([
        'meeting_inventory:user_1:sourcehash',
      ]);
    });

    it('preserves the transcript inventory source when summary chunks would otherwise fill the cap', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      process.env.VIVENTIUM_FILE_SEARCH_MAX_RESULTS_MEETING_TRANSCRIPT = '2';
      axios.post.mockImplementation((_url, body) => {
        const fileIds = Array.isArray(body.file_ids) ? body.file_ids : [body.file_id];
        return Promise.resolve({
          data: fileIds.map((fileId) => [
            {
              page_content: `Summary content for ${fileId}`,
              metadata: { file_id: fileId, source: `/path/to/${fileId}.txt`, page: 1 },
            },
            fileId.endsWith(':one') ? 0.01 : fileId.endsWith(':two') ? 0.02 : 0.03,
          ]),
        });
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          {
            file_id: 'meeting_inventory:user_1:sourcehash',
            filename: 'meeting-transcript-inventory-sourcehash.txt',
            metadata: {
              meetingTranscriptArtifactId: 'meeting_transcript_inventory:current',
              meetingTranscriptKind: 'inventory',
              meetingTranscriptInventoryText:
                'Meeting transcript inventory / table of contents.\n1. Helios launch review\n2. Orion customer review',
            },
          },
          {
            file_id: 'meeting_summary:user_1:one',
            filename: 'meeting-transcript-summary-one.txt',
            metadata: { meetingTranscriptKind: 'summary' },
          },
          {
            file_id: 'meeting_summary:user_1:two',
            filename: 'meeting-transcript-summary-two.txt',
            metadata: { meetingTranscriptKind: 'summary' },
          },
          {
            file_id: 'meeting_summary:user_1:three',
            filename: 'meeting-transcript-summary-three.txt',
            metadata: { meetingTranscriptKind: 'summary' },
          },
        ],
      });

      const [formattedString, artifact] = await fileSearchTool.func({
        query: 'what recent transcripts do you see?',
      });

      expect(artifact.file_search.sources).toHaveLength(2);
      expect(artifact.file_search.sources[0].fileId).toBe('meeting_summary:user_1:one');
      expect(artifact.file_search.sources[1].fileId).toBe('meeting_inventory:user_1:sourcehash');
      expect(formattedString).toContain('Helios launch review');
      expect(formattedString).not.toContain('meeting_summary:user_1:two');
    });

    it('front-loads the transcript inventory so the output character budget cannot clip it off', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      process.env.VIVENTIUM_FILE_SEARCH_MAX_RESULTS_MEETING_TRANSCRIPT = '6';
      process.env.VIVENTIUM_FILE_SEARCH_OUTPUT_MAX_CHARS_MEETING_TRANSCRIPT = '4300';
      process.env.VIVENTIUM_FILE_SEARCH_RESULT_MAX_CHARS_MEETING_TRANSCRIPT = '1000';
      process.env.VIVENTIUM_FILE_SEARCH_RESULT_MAX_CHARS_MEETING_TRANSCRIPT_INVENTORY = '2500';

      axios.post.mockImplementation((_url, body) => {
        const fileIds = Array.isArray(body.file_ids) ? body.file_ids : [body.file_id];
        return Promise.resolve({
          data: fileIds.map((fileId, index) => [
            {
              page_content: `Detailed summary ${index + 1} for ${fileId}. ${'Summary detail. '.repeat(
                120,
              )}`,
              metadata: { file_id: fileId, source: `/path/to/${fileId}.txt`, page: 1 },
            },
            0.01 + index * 0.01,
          ]),
        });
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          {
            file_id: 'meeting_inventory:user_1:sourcehash',
            filename: 'meeting-transcript-inventory-sourcehash.txt',
            metadata: {
              meetingTranscriptArtifactId: 'meeting_transcript_inventory:current',
              meetingTranscriptKind: 'inventory',
              meetingTranscriptInventoryText:
                'Meeting transcript inventory / table of contents.\n1. Helios launch review\n2. Orion customer review\n' +
                'Inventory context. '.repeat(180),
            },
          },
          ...['one', 'two', 'three', 'four', 'five'].map((suffix) => ({
            file_id: `meeting_summary:user_1:${suffix}`,
            filename: `meeting-transcript-summary-${suffix}.txt`,
            metadata: {
              meetingTranscriptArtifactId: `meeting_transcript:${suffix}`,
              meetingTranscriptKind: 'summary',
            },
          })),
        ],
      });

      const [formattedString, artifact] = await fileSearchTool.func({
        query: 'list my recent conversations based on transcripts chronologically',
      });

      expect(artifact.file_search.sources[0].fileId).toBe('meeting_summary:user_1:one');
      expect(artifact.file_search.sources[1].fileId).toBe('meeting_inventory:user_1:sourcehash');
      expect(formattedString).toContain('Transcript artifact kind: inventory');
      expect(formattedString).toContain('Helios launch review');
      expect(formattedString).not.toContain('meeting_summary:user_1:three');
    });

    it('keeps focused transcript summary hits ahead of inventory on narrow questions', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({
        data: [
          [
            {
              page_content:
                '10:00 Sam said the Tuesday launch checklist is current and the Monday plan is stale.',
              metadata: { source: '/path/to/meeting-transcript-summary-abc.txt', page: 1 },
            },
            0.05,
          ],
        ],
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          {
            file_id: 'meeting_inventory:user_1:sourcehash',
            filename: 'meeting-transcript-inventory-sourcehash.txt',
            metadata: {
              meetingTranscriptArtifactId: 'meeting_transcript_inventory:current',
              meetingTranscriptKind: 'inventory',
              meetingTranscriptInventoryText:
                '1. Project Lantern review\n   Participants: Sam, Lee\n   Context: Launch checklist.',
            },
          },
          {
            file_id: 'meeting_summary:user_1:abc',
            filename: 'meeting-transcript-summary-abc.txt',
            metadata: {
              meetingTranscriptArtifactId: 'meeting_transcript:abc',
              meetingTranscriptKind: 'summary',
            },
          },
        ],
      });

      const [formattedString, artifact] = await fileSearchTool.func({
        query: 'what did Sam say about the Tuesday launch checklist?',
      });

      expect(formattedString.indexOf('meeting-transcript-summary-abc.txt')).toBeLessThan(
        formattedString.indexOf('meeting-transcript-inventory-sourcehash.txt'),
      );
      expect(artifact.file_search.sources[0].fileId).toBe('meeting_summary:user_1:abc');
      expect(artifact.file_search.sources[0].content).toContain('Sam said the Tuesday launch');
    });

    it('reranks current meeting transcript evidence above stale assistant recall disclaimers', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockImplementation((url, body) => {
        if (body.file_id === 'conversation_recall:user_1:all') {
          return Promise.resolve({
            data: [
              [
                {
                  page_content:
                    '<turn role="assistant">I do not have access to those meeting details yet.</turn>',
                  metadata: { source: '/path/to/conversation-recall-all.txt', page: 1 },
                },
                0.02,
              ],
            ],
          });
        }
        if (Array.isArray(body.file_ids) && body.file_ids.includes('meeting_summary:user_1:qa')) {
          return Promise.resolve({
            data: [
              [
                {
                  page_content:
                    '10:00 Speaker Alpha and the user discussed SF customer discovery, onboarding risk, and follow-up product notes.',
                  metadata: {
                    file_id: 'meeting_summary:user_1:qa',
                    source: '/path/to/meeting-transcript-summary-qa.txt',
                    page: 1,
                  },
                },
                0.3,
              ],
            ],
          });
        }
        return Promise.resolve({ data: [] });
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        activeMessageId: 'active_prompt',
        files: [
          {
            file_id: 'conversation_recall:user_1:all',
            filename: 'conversation-recall-all.txt',
          },
          {
            file_id: 'meeting_summary:user_1:qa',
            filename: 'meeting-transcript-summary-qa.txt',
            metadata: {
              meetingTranscriptArtifactId: 'meeting_transcript:qa',
              meetingTranscriptKind: 'summary',
              meetingTranscriptOriginalFilename: '2026-05-05-qa-meeting.vtt',
              meetingTranscriptFileMtime: '2026-05-05T19:30:00.000Z',
              meetingTranscriptSourceStatus: 'new_or_changed',
            },
          },
        ],
      });

      const [formattedString, artifact] = await fileSearchTool.func({
        query: 'what did Speaker Alpha and I discuss?',
      });

      expect(formattedString.indexOf('meeting-transcript-summary-qa.txt')).toBeLessThan(
        formattedString.indexOf('conversation-recall-all.txt'),
      );
      expect(artifact.file_search.sources[0].fileId).toBe('meeting_summary:user_1:qa');
      expect(artifact.file_search.sources[0].content).toContain(
        'Speaker Alpha and the user discussed SF customer discovery',
      );
    });

    it('front-loads transcript evidence ahead of matching conversation recall on transcript queries', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockImplementation((url, body) => {
        if (body.file_id === 'conversation_recall:user_1:all') {
          return Promise.resolve({
            data: [
              [
                {
                  page_content:
                    '<turn role="user">What recent meeting transcript entries do you see?</turn>',
                  metadata: { source: '/path/to/conversation-recall-all.txt', page: 1 },
                },
                0.02,
              ],
            ],
          });
        }
        if (Array.isArray(body.file_ids) && body.file_ids.includes('meeting_summary:user_1:qa')) {
          return Promise.resolve({
            data: [
              [
                {
                  page_content:
                    'Meeting summary: Helios launch review includes date, participants, context, and transcript caveats.',
                  metadata: {
                    file_id: 'meeting_summary:user_1:qa',
                    source: '/path/to/meeting-transcript-summary-qa.txt',
                    page: 1,
                  },
                },
                0.4,
              ],
            ],
          });
        }
        return Promise.resolve({ data: [] });
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          {
            file_id: 'conversation_recall:user_1:all',
            filename: 'conversation-recall-all.txt',
          },
          {
            file_id: 'meeting_inventory:user_1:sourcehash',
            filename: 'meeting-transcript-inventory-sourcehash.txt',
            metadata: {
              meetingTranscriptArtifactId: 'meeting_transcript_inventory:current',
              meetingTranscriptKind: 'inventory',
              meetingTranscriptInventoryText:
                'Meeting transcript inventory / table of contents.\n1. Helios launch review',
            },
          },
          {
            file_id: 'meeting_summary:user_1:qa',
            filename: 'meeting-transcript-summary-qa.txt',
            metadata: {
              meetingTranscriptArtifactId: 'meeting_transcript:qa',
              meetingTranscriptKind: 'summary',
            },
          },
        ],
      });

      const [, artifact] = await fileSearchTool.func({
        query: 'what recent meeting transcript entries do you see?',
      });

      expect(artifact.file_search.sources.map((source) => source.fileId).slice(0, 2)).toEqual([
        'meeting_summary:user_1:qa',
        'meeting_inventory:user_1:sourcehash',
      ]);
      expect(artifact.file_search.sources[2].fileId).toBe('conversation_recall:user_1:all');
    });

    it('uses per-source result budgets when meeting transcript and conversation recall both hit', async () => {
      process.env.VIVENTIUM_FILE_SEARCH_RESULT_MAX_CHARS_CONVERSATION_RECALL = '80';
      process.env.VIVENTIUM_FILE_SEARCH_RESULT_MAX_CHARS_MEETING_TRANSCRIPT = '1200';
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      const longTranscriptSummary =
        '10:00 Speaker Alpha described the customer-discovery context. ' +
        '10:05 Speaker Beta mapped onboarding risks. '.repeat(20) +
        '10:45 Speaker Alpha confirmed the follow-up product-note owner and timing.';

      axios.post.mockImplementation((url, body) => {
        if (body.file_id === 'conversation_recall:user_1:all') {
          return Promise.resolve({
            data: [
              [
                {
                  page_content:
                    '<turn role="assistant">I do not have access to those meeting details yet.</turn>',
                  metadata: { source: '/path/to/conversation-recall-all.txt', page: 1 },
                },
                0.02,
              ],
            ],
          });
        }
        return Promise.resolve({
          data: [
            [
              {
                page_content: longTranscriptSummary,
                metadata: { source: '/path/to/meeting-transcript-summary-budget.txt', page: 1 },
              },
              0.25,
            ],
          ],
        });
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          {
            file_id: 'conversation_recall:user_1:all',
            filename: 'conversation-recall-all.txt',
          },
          {
            file_id: 'meeting_summary:user_1:budget',
            filename: 'meeting-transcript-summary-budget.txt',
            metadata: {
              meetingTranscriptArtifactId: 'meeting_transcript:budget',
              meetingTranscriptKind: 'summary',
              meetingTranscriptOriginalFilename: '2026-05-05-budget.vtt',
              meetingTranscriptFileMtime: '2026-05-05T19:30:00.000Z',
              meetingTranscriptSourceStatus: 'new_or_changed',
            },
          },
        ],
      });

      const [, artifact] = await fileSearchTool.func({
        query: 'Speaker Alpha customer discovery onboarding risks follow-up product-note',
      });

      expect(artifact.file_search.sources[0].content).toContain(
        '10:45 Speaker Alpha confirmed the follow-up product-note owner and timing',
      );
    });

    it('keeps matching meeting transcript summaries when conversation recall also fills the cap', async () => {
      process.env.VIVENTIUM_FILE_SEARCH_MAX_RESULTS_CONVERSATION_RECALL = '3';
      process.env.VIVENTIUM_FILE_SEARCH_MAX_RESULTS_MEETING_TRANSCRIPT = '2';
      process.env.VIVENTIUM_FILE_SEARCH_MIN_RESULTS_MEETING_TRANSCRIPT_WHEN_MIXED = '1';
      generateShortLivedToken.mockReturnValue('mock-jwt-token');

      axios.post.mockImplementation((url, body) => {
        if (body.file_id === 'conversation_recall:user_1:all') {
          return Promise.resolve({
            data: [0, 1, 2].map((index) => [
              {
                page_content: `<turn role="user">Recall echo ${index} about Helios Orion Atlas</turn>`,
                metadata: { source: '/path/to/conversation-recall-all.txt', page: index + 1 },
              },
              0.01 + index * 0.01,
            ]),
          });
        }
        if (Array.isArray(body.file_ids) && body.file_ids.includes('meeting_summary:user_1:helios')) {
          return Promise.resolve({
            data: [
              [
                {
                  page_content:
                    'MTM marker: Helios launch review. Mira owns the risk register; Atlas migration language is meeting-scoped only.',
                  metadata: {
                    file_id: 'meeting_summary:user_1:helios',
                    source: '/path/to/meeting-transcript-summary-helios.txt',
                    page: 1,
                  },
                },
                0.75,
              ],
            ],
          });
        }
        return Promise.resolve({ data: [] });
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          { file_id: 'conversation_recall:user_1:all', filename: 'conversation-recall-all.txt' },
          {
            file_id: 'meeting_summary:user_1:helios',
            filename: 'meeting-transcript-summary-helios.txt',
            metadata: {
              meetingTranscriptArtifactId: 'meeting_transcript:helios',
              meetingTranscriptKind: 'summary',
            },
          },
        ],
      });

      const [, artifact] = await fileSearchTool.func({
        query: 'Helios Orion Atlas migration owner',
      });

      expect(artifact.file_search.sources).toHaveLength(3);
      expect(artifact.file_search.sources.some((source) => source.fileId === 'meeting_summary:user_1:helios')).toBe(
        true,
      );
      expect(
        artifact.file_search.sources.some((source) =>
          source.content.includes('Mira owns the risk register'),
        ),
      ).toBe(true);
    });

    it('reports meeting transcript misses as transcript misses, not conversation-history misses', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({ data: [] });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          {
            file_id: 'meeting_summary:user_1:abc',
            filename: 'meeting-transcript-summary-abc.txt',
          },
        ],
      });

      const [formattedString, artifact] = await fileSearchTool.func({
        query: 'missing transcript topic',
      });

      expect(formattedString).toBe(
        'No matching content found in meeting transcripts for this query.',
      );
      expect(artifact).toBeUndefined();
    });

    it('uses the widened bounded top-k for conversation recall by default', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({
        data: [
          [
            {
              page_content: '<turn role="user">Recall content</turn>',
              metadata: { source: '/path/to/conversation-recall.txt', page: 1 },
            },
            0.1,
          ],
        ],
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          { file_id: 'conversation_recall:user_1:all', filename: 'conversation-recall-all.txt' },
        ],
      });

      await fileSearchTool.func({ query: 'remember my QA synthetic recall marker' });

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:8000/query',
        expect.objectContaining({ k: 60 }),
        expect.any(Object),
      );
    });

    it('clips oversized conversation-recall output to stay within output budget', async () => {
      process.env.VIVENTIUM_FILE_SEARCH_MAX_RESULTS_CONVERSATION_RECALL = '10';
      process.env.VIVENTIUM_FILE_SEARCH_RESULT_MAX_CHARS_CONVERSATION_RECALL = '60';
      process.env.VIVENTIUM_FILE_SEARCH_OUTPUT_MAX_CHARS_CONVERSATION_RECALL = '220';
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({
        data: [
          [
            {
              page_content:
                'Project Atlas identity note. '.repeat(12) + 'extra text to force truncation',
              metadata: { source: '/path/to/conversation-recall.txt', page: 1 },
            },
            0.1,
          ],
          [
            {
              page_content:
                'Product planning details and milestones. '.repeat(12) +
                'extra text to force truncation',
              metadata: { source: '/path/to/conversation-recall.txt', page: 2 },
            },
            0.2,
          ],
        ],
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          { file_id: 'conversation_recall:user_1:all', filename: 'conversation-recall-all.txt' },
        ],
      });

      const [formattedString, artifact] = await fileSearchTool.func({
        query: 'remember these notes',
      });

      expect(formattedString.length).toBeLessThanOrEqual(220);
      expect(formattedString).toContain('...');
      expect(artifact.file_search.sources.length).toBe(1);
      expect(artifact.file_search.sources[0].content.length).toBeLessThanOrEqual(60);
    });

    it('queries all attached files without runtime recall-intent routing', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');

      axios.post.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({
        data: [
          [
            {
              page_content: 'Fallback content from regular file.',
              metadata: { source: '/path/to/manual-notes.txt', page: 1 },
            },
            0.1,
          ],
        ],
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          { file_id: 'conversation_recall:user_1:all', filename: 'conversation-recall-all.txt' },
          { file_id: 'manual-file-1', filename: 'manual-notes.txt' },
        ],
      });

      const [formattedString, artifact] = await fileSearchTool.func({
        query: 'deployment notes',
      });

      expect(axios.post).toHaveBeenCalledTimes(2);
      expect(axios.post.mock.calls.map(([, body]) => body.file_id)).toEqual(
        expect.arrayContaining(['conversation_recall:user_1:all', 'manual-file-1']),
      );
      expect(formattedString).toContain('manual-notes.txt');
      expect(artifact.file_search.sources[0].fileId).toBe('manual-file-1');
    });

    it('reranks identity snippets above disclaimer snippets for name recall queries', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({
        data: [
          [
            {
              page_content: '<turn role="assistant">I do not remember your name.</turn>',
              metadata: { source: '/path/to/conversation-recall-all.txt', page: 1 },
            },
            0.05,
          ],
          [
            {
              page_content: '<turn role="user">My name is Avery.</turn>',
              metadata: { source: '/path/to/conversation-recall-all.txt', page: 2 },
            },
            0.2,
          ],
        ],
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          { file_id: 'conversation_recall:user_1:all', filename: 'conversation-recall-all.txt' },
        ],
      });

      const [, artifact] = await fileSearchTool.func({ query: 'do you remember my name?' });

      expect(artifact.file_search.sources[0].content).toContain('My name is Avery');
      expect(artifact.file_search.sources[0].relevance).toBeGreaterThan(
        artifact.file_search.sources[1].relevance,
      );
    });

    it('does not skip recall files for short specific lookup queries when mixed files are attached', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockImplementation((url, body) => {
        if (body.file_id === 'conversation_recall:user_1:all') {
          return Promise.resolve({
            data: [
              [
                {
                  page_content: '<turn role="user">My name is Avery.</turn>',
                  metadata: { source: '/path/to/conversation-recall-all.txt', page: 1 },
                },
                0.1,
              ],
            ],
          });
        }

        if (body.file_id === 'manual-file-1') {
          return Promise.resolve({
            data: [
              [
                {
                  page_content: 'Quarterly revenue memo',
                  metadata: { source: '/path/to/manual.pdf', page: 1 },
                },
                0.2,
              ],
            ],
          });
        }

        return Promise.resolve({ data: [] });
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          { file_id: 'conversation_recall:user_1:all', filename: 'conversation-recall-all.txt' },
          { file_id: 'manual-file-1', filename: 'manual.pdf' },
        ],
      });

      const [, artifact] = await fileSearchTool.func({ query: "What's my name?" });

      expect(axios.post.mock.calls.map(([, body]) => body.file_id)).toContain(
        'conversation_recall:user_1:all',
      );
      expect(artifact.file_search.sources[0].content).toContain('My name is Avery');
    });

    it('uses source-backed rescue for source-only conversation recall attachments', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockImplementation((url, body) => {
        if (body.file_id === 'manual-file-1') {
          return Promise.resolve({ data: [] });
        }
        return Promise.resolve({ data: [] });
      });
      mockMessageFind.mockImplementation((filter) => {
        if (filter?.parentMessageId === 'source_user_turn') {
          return queryResult([]);
        }
        return queryResult([
          {
            messageId: 'source_user_turn',
            conversationId: 'source_convo',
            createdAt: '2026-04-09T18:12:00.000Z',
            isCreatedByUser: true,
            text: 'Project Atlas decision: ship the slimmer onboarding flow first.',
          },
        ]);
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        conversationId: 'current-convo',
        files: [
          {
            file_id: 'conversation_recall:user_1:all',
            filename: 'conversation-recall-all.txt',
            viventiumConversationRecallMode: 'source_only',
          },
          { file_id: 'manual-file-1', filename: 'manual.pdf' },
        ],
      });

      const [, artifact] = await fileSearchTool.func({ query: 'Project Atlas onboarding flow' });

      expect(axios.post.mock.calls.map(([, body]) => body.file_id)).toEqual(
        expect.arrayContaining(['manual-file-1']),
      );
      expect(axios.post.mock.calls.map(([, body]) => body.file_id)).not.toContain(
        'conversation_recall:user_1:all',
      );
      expect(artifact.file_search.sources[0].fileId).toBe('conversation_recall:user_1:all');
      expect(artifact.file_search.sources[0].content).toContain(
        'Project Atlas decision: ship the slimmer onboarding flow first.',
      );
    });

    it('does not rescue the active prompt echo as conversation recall evidence', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({ data: [] });
      const query = 'Project Atlas onboarding flow';
      mockMessageFind.mockImplementation((filter) => {
        if (filter?.parentMessageId) {
          return queryResult([]);
        }
        expect(filter).toMatchObject({ conversationId: { $ne: 'current-convo' } });
        return queryResult([
          {
            messageId: 'active_prompt',
            conversationId: 'current-convo',
            createdAt: new Date().toISOString(),
            isCreatedByUser: true,
            text: query,
          },
          {
            messageId: 'older_user_turn',
            conversationId: 'source_convo',
            createdAt: '2026-04-09T18:12:00.000Z',
            isCreatedByUser: true,
            text: 'Project Atlas decision: ship the slimmer onboarding flow first.',
          },
        ]);
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          {
            file_id: 'conversation_recall:user_1:all',
            filename: 'conversation-recall-all.txt',
            viventiumConversationRecallMode: 'source_only',
          },
        ],
      });

      const [, artifact] = await fileSearchTool.func(
        { query },
        undefined,
        { configurable: { thread_id: 'current-convo' } },
      );

      expect(artifact.file_search.sources[0].content).not.toContain(query);
      expect(artifact.file_search.sources[0].content).toContain(
        'Project Atlas decision: ship the slimmer onboarding flow first.',
      );
    });

    it('does not rescue a recent prompt echo when conversation metadata is unavailable', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({ data: [] });
      const activePrompt =
        'list my recent conversations based on transcripts chronologically and give me a 5 line summary based on the actual context.';
      mockMessageFind.mockImplementation((filter) => {
        if (filter?.parentMessageId) {
          return queryResult([]);
        }
        return queryResult([
          {
            messageId: 'active_prompt_without_runtime_metadata',
            conversationId: 'current-convo',
            createdAt: new Date().toISOString(),
            isCreatedByUser: true,
            text: activePrompt,
          },
          {
            messageId: 'older_user_turn',
            conversationId: 'source_convo',
            createdAt: '2026-04-09T18:12:00.000Z',
            isCreatedByUser: true,
            text: 'Transcript inventory entry: Project Atlas working session covered context and summary decisions.',
          },
        ]);
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          {
            file_id: 'conversation_recall:user_1:all',
            filename: 'conversation-recall-all.txt',
            viventiumConversationRecallMode: 'source_only',
          },
        ],
      });

      const [, artifact] = await fileSearchTool.func({
        query: 'recent transcript inventory chronology summary context',
      });

      expect(artifact.file_search.sources[0].content).not.toContain(activePrompt);
      expect(artifact.file_search.sources[0].content).toContain(
        'Transcript inventory entry: Project Atlas working session covered context and summary decisions.',
      );
    });

    it('source-only recall excludes Listen-Only ambient transcript rows', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      const sourceQuery = queryResult([
        {
          messageId: 'normal_user_turn',
          conversationId: 'source_convo',
          createdAt: '2026-04-09T18:12:00.000Z',
          isCreatedByUser: true,
          text: 'Project Atlas decision: the onboarding flow uses the onyx marker.',
          metadata: {},
        },
        {
          messageId: 'ambient_listen_only_turn',
          conversationId: 'source_convo',
          createdAt: '2026-04-09T18:13:00.000Z',
          isCreatedByUser: false,
          text: 'Listen-only ambient onyx marker that should not reach live recall.',
          metadata: {
            viventium: {
              type: 'listen_only_transcript',
              mode: 'listen_only',
            },
          },
        },
      ]);

      mockMessageFind.mockImplementation((filter) => {
        if (filter?.parentMessageId) {
          return queryResult([]);
        }
        expect(filter).toMatchObject({
          'metadata.viventium.type': { $ne: 'listen_only_transcript' },
          'metadata.viventium.mode': { $ne: 'listen_only' },
        });
        return sourceQuery;
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        conversationId: 'current-convo',
        files: [
          {
            file_id: 'conversation_recall:user_1:all',
            filename: 'conversation-recall-all.txt',
            viventiumConversationRecallMode: 'source_only',
          },
        ],
      });

      const [, artifact] = await fileSearchTool.func({ query: 'Project Atlas onyx marker' });

      expect(sourceQuery.select).toHaveBeenCalledWith(expect.stringContaining('metadata'));
      expect(artifact.file_search.sources[0].content).toContain(
        'Project Atlas decision: the onboarding flow uses the onyx marker.',
      );
      expect(artifact.file_search.sources.map((source) => source.content).join('\n')).not.toContain(
        'Listen-only ambient onyx marker',
      );
    });

    it('prioritizes structurally rescued source messages above noisy recall snippets', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({
        data: [
          [
            {
              page_content:
                '<turn role="user">Earlier today I told you a QA-only synthetic recall marker in another chat. What exact marker was it? If you can retrieve it, answer with only the exact marker.</turn>',
              metadata: { source: '/path/to/conversation-recall-all.txt', page: 1 },
            },
            0.05,
          ],
          [
            {
              page_content:
                '<turn role="user">QA-only synthetic recall marker for testing: VIV-RAG-QA-20260409-1626-ONYX-FJ42. This is not a personal preference or durable memory.</turn>',
              metadata: { source: '/path/to/conversation-recall-all.txt', page: 2 },
            },
            0.2,
          ],
        ],
      });
      mockMessageFind.mockImplementation((filter) => {
        if (filter?.parentMessageId === 'meta_user_turn') {
          return queryResult([
            {
              messageId: 'meta_assistant_turn',
              parentMessageId: 'meta_user_turn',
              isCreatedByUser: false,
              attachments: [
                {
                  type: 'file_search',
                  file_search: {
                    sources: [{ fileId: 'conversation_recall:user_1:all' }],
                  },
                },
              ],
            },
          ]);
        }
        return queryResult([
          {
            messageId: 'meta_user_turn',
            conversationId: 'meta_convo',
            createdAt: '2026-04-09T16:26:15.138Z',
            isCreatedByUser: true,
            text: 'Earlier today I told you a QA-only synthetic recall marker in another chat. What exact marker was it? If you can retrieve it, answer with only the exact marker.',
          },
          {
            messageId: 'source_user_turn',
            conversationId: 'source_convo',
            createdAt: '2026-04-09T16:25:23.880Z',
            isCreatedByUser: true,
            text: 'QA-only synthetic recall marker for testing: VIV-RAG-QA-20260409-1626-ONYX-FJ42. This is not a personal preference or durable memory.',
          },
        ]);
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          { file_id: 'conversation_recall:user_1:all', filename: 'conversation-recall-all.txt' },
        ],
      });

      const [, artifact] = await fileSearchTool.func({
        query:
          'Earlier today I told you a QA-only synthetic recall marker in another chat. What exact marker was it? If you can retrieve it, answer with only the exact marker.',
      });

      expect(artifact.file_search.sources[0].content).toContain(
        'VIV-RAG-QA-20260409-1626-ONYX-FJ42',
      );
      expect(artifact.file_search.sources[0].content).toContain('conversation="source_convo"');
      expect(artifact.file_search.sources[0].relevance).toBeGreaterThan(
        artifact.file_search.sources[1].relevance,
      );
    });

    it('rescues exact literal recall misses from source messages and excludes the active conversation', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({
        data: [
          [
            {
              page_content: '<turn role="user">Unrelated recall snippet</turn>',
              metadata: { source: '/path/to/conversation-recall-all.txt', page: 1 },
            },
            0.2,
          ],
        ],
      });

      mockMessageFind.mockImplementation((filter) => {
        if (filter?.parentMessageId) {
          return queryResult([]);
        }
        expect(filter).toMatchObject({
          user: 'user1',
          conversationId: { $ne: 'current_convo' },
        });
        return queryResult([
          {
            conversationId: 'prior_convo',
            createdAt: '2026-04-09T16:25:23.880Z',
            isCreatedByUser: true,
            text: 'QA-only synthetic recall marker for testing: VIV-RAG-QA-20260409-1626-ONYX-FJ42. This is not a personal preference or durable memory.',
          },
        ]);
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        conversationId: 'current_convo',
        files: [
          { file_id: 'conversation_recall:user_1:all', filename: 'conversation-recall-all.txt' },
        ],
      });

      const [, artifact] = await fileSearchTool.func({
        query: 'VIV-RAG-QA-20260409-1626-ONYX-FJ42',
      });

      expect(artifact.file_search.sources[0].content).toContain(
        'VIV-RAG-QA-20260409-1626-ONYX-FJ42',
      );
      expect(artifact.file_search.sources[0].content).toContain('conversation="prior_convo"');
      expect(artifact.file_search.sources[0].content).not.toContain('conversation="current_convo"');
    });

    it('rescues weak phrase-based recall hits from source messages when semantic ranking is too noisy', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({
        data: [
          [
            {
              page_content:
                '<turn role="assistant">Good morning! Here is a startup checklist and weather reminder.</turn>',
              metadata: { source: '/path/to/conversation-recall-all.txt', page: 1 },
            },
            0.1,
          ],
        ],
      });

      mockMessageFind.mockReturnValue(
        queryResult([
          {
            conversationId: 'prior_convo',
            createdAt: '2026-04-09T16:25:23.880Z',
            isCreatedByUser: true,
            text: 'QA-only synthetic recall marker for testing: VIV-RAG-QA-20260409-1626-ONYX-FJ42. This is not a personal preference or durable memory.',
          },
        ]),
      );

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        conversationId: 'current_convo',
        files: [
          { file_id: 'conversation_recall:user_1:all', filename: 'conversation-recall-all.txt' },
        ],
      });

      const [, artifact] = await fileSearchTool.func({
        query: 'what exact marker was it',
      });

      expect(artifact.file_search.sources[0].content).toContain(
        'VIV-RAG-QA-20260409-1626-ONYX-FJ42',
      );
      expect(artifact.file_search.sources[0].content).toContain('conversation="prior_convo"');
    });
  });
});

describe('fileSearch.js - primeFiles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deduplicates files merged from DB and resource payload by file_id', async () => {
    getFiles.mockResolvedValueOnce([{ file_id: 'file-1', filename: 'from-db.pdf' }]);

    const result = await primeFiles({
      tool_resources: {
        file_search: {
          file_ids: ['file-1'],
          files: [
            { file_id: 'file-1', filename: 'from-resource.pdf' },
            { file_id: 'file-2', filename: 'new-attachment.pdf' },
          ],
        },
      },
    });

    expect(result.files).toHaveLength(2);
    expect(result.files.map((file) => file.file_id)).toEqual(['file-1', 'file-2']);
    expect(result.toolContext).toContain('from-db.pdf');
    expect(result.toolContext).toContain('new-attachment.pdf (just attached by user)');
  });
});
