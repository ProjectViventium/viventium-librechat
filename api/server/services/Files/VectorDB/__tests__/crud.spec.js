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

jest.mock('@librechat/data-schemas', () => ({
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
  FileSources: {
    vectordb: 'vectordb',
  },
}));

describe('VectorDB uploadVectors', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.RAG_API_URL = 'https://rag.example.test';
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
});
