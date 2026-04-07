/* === VIVENTIUM START ===
 * Tests: VectorDB upload sanitization
 *
 * Purpose:
 * - Ensure large embedding failure payloads are compacted before logging/propagation.
 * - Preserve duplicate-key signatures for upstream recovery logic.
 *
 * Added: 2026-02-19
 * === VIVENTIUM END === */

const mockAxiosPost = jest.fn();
const mockCreateReadStream = jest.fn(() => 'mock-stream');
const mockGenerateShortLivedToken = jest.fn(() => 'mock-token');
const mockLogAxiosError = jest.fn();
const mockGetUserKeyValues = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  createMethods: jest.fn(() => ({
    getUserKeyValues: (...args) => mockGetUserKeyValues(...args),
  })),
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('axios', () => ({
  post: (...args) => mockAxiosPost(...args),
  delete: jest.fn(),
}));

jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  return {
    ...actualFs,
    createReadStream: (...args) => mockCreateReadStream(...args),
  };
});

jest.mock('form-data', () =>
  jest.fn().mockImplementation(() => ({
    append: jest.fn(),
    getHeaders: jest.fn(() => ({})),
  })),
);

jest.mock('@librechat/api', () => ({
  logAxiosError: (...args) => mockLogAxiosError(...args),
  generateShortLivedToken: (...args) => mockGenerateShortLivedToken(...args),
}));

jest.mock('librechat-data-provider', () => ({
  ErrorTypes: {
    NO_USER_KEY: 'NO_USER_KEY',
    INVALID_USER_KEY: 'INVALID_USER_KEY',
  },
  EModelEndpoint: {
    openAI: 'openAI',
  },
  FileSources: {
    vectordb: 'vectordb',
  },
}));

describe('VectorDB uploadVectors', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.RAG_API_URL = 'https://rag.example.test';
    mockGetUserKeyValues.mockRejectedValue(
      new Error(
        JSON.stringify({
          type: 'NO_USER_KEY',
        }),
      ),
    );
  });

  test('compacts massive duplicate-key embedding failures while preserving recovery signal', async () => {
    const { uploadVectors } = require('../crud');
    const hugeVector = Array(4000).fill('0.001').join(',');

    mockAxiosPost.mockResolvedValue({
      status: 200,
      data: {
        status: false,
        known_type: true,
        message: `batch op errors occurred; E11000 duplicate key error collection: rag-db.rag-collection index: _id_ dup key: {'embedding': [${hugeVector}]}`,
      },
    });

    await expect(
      uploadVectors({
        req: { user: { id: 'user_1' } },
        file: {
          path: '/tmp/recall.txt',
          size: 1200,
          originalname: 'recall.txt',
          mimetype: 'text/plain',
        },
        file_id: 'conversation_recall:user_1:all',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('E11000 duplicate key'),
      response: {
        status: 200,
        data: expect.objectContaining({
          message: expect.stringContaining('[omitted]'),
        }),
      },
    });

    expect(mockLogAxiosError).toHaveBeenCalledTimes(1);
    const loggedError = mockLogAxiosError.mock.calls[0][0].error;
    expect(loggedError.message).toContain('E11000 duplicate key');
    expect(loggedError.message).toContain('[omitted]');
    expect(loggedError.message).not.toContain(hugeVector.slice(0, 120));
  });

  test('compacts oversized text payloads from embed failure details before logging', async () => {
    const { uploadVectors } = require('../crud');
    const massiveText = 'x'.repeat(8000);

    mockAxiosPost.mockRejectedValueOnce({
      message: `File embedding failed: {'writeErrors':[{'op':{'text':'${massiveText}'},'errmsg':'E11000 duplicate key'}]}`,
      response: {
        status: 200,
        data: {
          status: false,
          message: `File embedding failed: {'writeErrors':[{'op':{'text':'${massiveText}'},'errmsg':'E11000 duplicate key'}]}`,
        },
      },
    });

    await expect(
      uploadVectors({
        req: { user: { id: 'user_1' } },
        file: {
          path: '/tmp/recall.txt',
          size: 1200,
          originalname: 'recall.txt',
          mimetype: 'text/plain',
        },
        file_id: 'conversation_recall:user_1:all',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("text':'[omitted]'"),
      response: {
        status: 200,
        data: expect.objectContaining({
          message: expect.stringContaining("text':'[omitted]'"),
        }),
      },
    });

    expect(mockLogAxiosError).toHaveBeenCalledTimes(1);
    const loggedError = mockLogAxiosError.mock.calls[0][0].error;
    expect(loggedError.message).toContain("text':'[omitted]'");
    expect(loggedError.message).not.toContain(massiveText.slice(0, 400));
  });

  test('preserves the existing env-key embeddings path when no user-scoped OpenAI key exists', async () => {
    const { uploadVectors } = require('../crud');

    mockAxiosPost.mockResolvedValue({
      status: 200,
      data: {
        status: true,
        known_type: true,
      },
    });

    await uploadVectors({
      req: { user: { id: 'user_1' } },
      file: {
        path: '/tmp/recall.txt',
        size: 1200,
        originalname: 'recall.txt',
        mimetype: 'text/plain',
      },
      file_id: 'conversation_recall:user_1:all',
    });

    const requestConfig = mockAxiosPost.mock.calls[0][2];
    expect(requestConfig.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer mock-token',
      }),
    );
    expect(requestConfig.headers['X-Viventium-Embeddings-OpenAI-Api-Key']).toBeUndefined();
    expect(requestConfig.headers['X-Viventium-Embeddings-OpenAI-Base-Url']).toBeUndefined();
  });

  test('prefers user-scoped OpenAI embeddings auth and omits Codex reverse proxy URL', async () => {
    const { uploadVectors } = require('../crud');

    mockGetUserKeyValues.mockResolvedValue({
      apiKey: 'user-openai-token',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      oauthProvider: 'openai-codex',
      oauthType: 'subscription',
    });
    mockAxiosPost.mockResolvedValue({
      status: 200,
      data: {
        status: true,
        known_type: true,
      },
    });

    await uploadVectors({
      req: { user: { id: 'user_1' } },
      file: {
        path: '/tmp/recall.txt',
        size: 1200,
        originalname: 'recall.txt',
        mimetype: 'text/plain',
      },
      file_id: 'conversation_recall:user_1:all',
    });

    expect(mockGetUserKeyValues).toHaveBeenCalledWith({
      userId: 'user_1',
      name: 'openAI',
    });

    const requestConfig = mockAxiosPost.mock.calls[0][2];
    expect(requestConfig.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer mock-token',
        'X-Viventium-Embeddings-OpenAI-Api-Key': 'user-openai-token',
      }),
    );
    expect(requestConfig.headers['X-Viventium-Embeddings-OpenAI-Base-Url']).toBeUndefined();
  });

  test('passes through a non-Codex OpenAI base URL when the user key defines one', async () => {
    const { uploadVectors } = require('../crud');

    mockGetUserKeyValues.mockResolvedValue({
      apiKey: 'user-openai-token',
      baseURL: 'https://proxy.example.test/v1',
    });
    mockAxiosPost.mockResolvedValue({
      status: 200,
      data: {
        status: true,
        known_type: true,
      },
    });

    await uploadVectors({
      req: { user: { id: 'user_1' } },
      file: {
        path: '/tmp/recall.txt',
        size: 1200,
        originalname: 'recall.txt',
        mimetype: 'text/plain',
      },
      file_id: 'conversation_recall:user_1:all',
    });

    const requestConfig = mockAxiosPost.mock.calls[0][2];
    expect(requestConfig.headers).toEqual(
      expect.objectContaining({
        'X-Viventium-Embeddings-OpenAI-Api-Key': 'user-openai-token',
        'X-Viventium-Embeddings-OpenAI-Base-Url': 'https://proxy.example.test/v1',
      }),
    );
  });
});
