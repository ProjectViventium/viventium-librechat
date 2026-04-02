const axios = require('axios');

jest.mock('axios');
jest.mock('@librechat/api', () => ({
  generateShortLivedToken: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('~/models', () => ({
  getFiles: jest.fn().mockResolvedValue([]),
}));

jest.mock('~/server/services/Files/permissions', () => ({
  filterFilesByAgentAccess: jest.fn((options) => Promise.resolve(options.files)),
}));

const { createFileSearchTool } = require('~/app/clients/tools/util/fileSearch');
const { generateShortLivedToken } = require('@librechat/api');
const { getFiles } = require('~/models');
const { primeFiles } = require('~/app/clients/tools/util/fileSearch');
const {
  FILE_SEARCH_NO_RETRIEVED_EVIDENCE,
} = require('~/app/clients/tools/util/modelFacingToolOutput');

describe('fileSearch.js - tuple return validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RAG_API_URL = 'http://localhost:8000';
    delete process.env.VIVENTIUM_FILE_SEARCH_QUERY_TIMEOUT_MS;
    delete process.env.VIVENTIUM_FILE_SEARCH_QUERY_TIMEOUT_MS_CONVERSATION_RECALL;
    delete process.env.VIVENTIUM_FILE_SEARCH_TOP_K;
    delete process.env.VIVENTIUM_FILE_SEARCH_TOP_K_CONVERSATION_RECALL;
    delete process.env.VIVENTIUM_FILE_SEARCH_MAX_RESULTS;
    delete process.env.VIVENTIUM_FILE_SEARCH_MAX_RESULTS_CONVERSATION_RECALL;
    delete process.env.VIVENTIUM_FILE_SEARCH_RESULT_MAX_CHARS;
    delete process.env.VIVENTIUM_FILE_SEARCH_RESULT_MAX_CHARS_CONVERSATION_RECALL;
    delete process.env.VIVENTIUM_FILE_SEARCH_OUTPUT_MAX_CHARS;
    delete process.env.VIVENTIUM_FILE_SEARCH_OUTPUT_MAX_CHARS_CONVERSATION_RECALL;
    delete process.env.VIVENTIUM_FILE_SEARCH_RECALL_INTENT_ONLY;
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
        files: [{ file_id: 'conversation_recall:user_1:all', filename: 'conversation-recall-all.txt' }],
      });

      await fileSearchTool.func({ query: 'remember my name' });

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:8000/query',
        expect.any(Object),
        expect.objectContaining({ timeout: 1234 }),
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
        files: [{ file_id: 'conversation_recall:user_1:all', filename: 'conversation-recall-all.txt' }],
      });

      await fileSearchTool.func({ query: 'remember my name' });

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:8000/query',
        expect.objectContaining({ k: 9 }),
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
                'Product planning details and milestones. '.repeat(12) + 'extra text to force truncation',
              metadata: { source: '/path/to/conversation-recall.txt', page: 2 },
            },
            0.2,
          ],
        ],
      });

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [{ file_id: 'conversation_recall:user_1:all', filename: 'conversation-recall-all.txt' }],
      });

      const [formattedString, artifact] = await fileSearchTool.func({ query: 'remember these notes' });

      expect(formattedString.length).toBeLessThanOrEqual(220);
      expect(formattedString).toContain('...');
      expect(artifact.file_search.sources.length).toBe(1);
      expect(artifact.file_search.sources[0].content.length).toBeLessThanOrEqual(60);
    });

    it('prefers conversation-recall files for recall-intent queries when recall-intent-only mode is enabled', async () => {
      process.env.VIVENTIUM_FILE_SEARCH_RECALL_INTENT_ONLY = 'true';
      generateShortLivedToken.mockReturnValue('mock-jwt-token');

      axios.post.mockResolvedValue({
        data: [
          [
            {
              page_content: '<turn role="user">My name is Avery.</turn>',
              metadata: { source: '/path/to/conversation-recall-all.txt', page: 1 },
            },
            0.2,
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

      await fileSearchTool.func({ query: 'do you remember my name?' });

      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:8000/query',
        expect.objectContaining({ file_id: 'conversation_recall:user_1:all' }),
        expect.any(Object),
      );
    });

    it('treats personal-fact prompts as recall intent and prefers recall files', async () => {
      process.env.VIVENTIUM_FILE_SEARCH_RECALL_INTENT_ONLY = 'true';
      generateShortLivedToken.mockReturnValue('mock-jwt-token');

      axios.post.mockResolvedValue({
        data: [
          [
            {
              page_content: '<turn role="user">My preferred name is Avery.</turn>',
              metadata: { source: '/path/to/conversation-recall-all.txt', page: 1 },
            },
            0.2,
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

      await fileSearchTool.func({ query: 'what is my legal name?' });

      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:8000/query',
        expect.objectContaining({ file_id: 'conversation_recall:user_1:all' }),
        expect.any(Object),
      );
    });

    it('falls back to non-recall files when recall-file query has no matches', async () => {
      process.env.VIVENTIUM_FILE_SEARCH_RECALL_INTENT_ONLY = 'true';
      generateShortLivedToken.mockReturnValue('mock-jwt-token');

      axios.post
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({
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
        query: 'remember what we said about deployment?',
      });

      expect(axios.post).toHaveBeenCalledTimes(2);
      expect(axios.post.mock.calls[0][1]).toMatchObject({ file_id: 'conversation_recall:user_1:all' });
      expect(axios.post.mock.calls[1][1]).toMatchObject({ file_id: 'manual-file-1' });
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
        files: [{ file_id: 'conversation_recall:user_1:all', filename: 'conversation-recall-all.txt' }],
      });

      const [, artifact] = await fileSearchTool.func({ query: 'do you remember my name?' });

      expect(artifact.file_search.sources[0].content).toContain('My name is Avery');
      expect(artifact.file_search.sources[0].relevance).toBeGreaterThan(
        artifact.file_search.sources[1].relevance,
      );
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
