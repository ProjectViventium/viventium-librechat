jest.mock('~/db/connect');
jest.mock('~/models', () => ({
  updateMessage: jest.fn(),
  getMessages: jest.fn().mockResolvedValue([]),
  saveMessage: jest.fn(),
  saveConvo: jest.fn(),
  getConvo: jest.fn(),
  getFiles: jest.fn(),
}));
jest.mock('~/models/balanceMethods', () => ({
  checkBalance: jest.fn(),
}));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(),
}));

jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    ...actual,
    encodeAndFormatDocuments: jest.fn(),
  };
});

const { encodeAndFormatDocuments } = require('@librechat/api');
const { FakeClient } = require('./FakeClient');

describe('BaseClient.addDocuments Anthropic payload guard', () => {
  const originalMaxSingle = process.env.VIVENTIUM_ANTHROPIC_MAX_SINGLE_DOCUMENT_BYTES;
  const originalMaxTotal = process.env.VIVENTIUM_ANTHROPIC_MAX_TOTAL_DOCUMENT_BYTES;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VIVENTIUM_ANTHROPIC_MAX_SINGLE_DOCUMENT_BYTES = '1024';
    process.env.VIVENTIUM_ANTHROPIC_MAX_TOTAL_DOCUMENT_BYTES = '2048';
  });

  afterAll(() => {
    if (originalMaxSingle === undefined) {
      delete process.env.VIVENTIUM_ANTHROPIC_MAX_SINGLE_DOCUMENT_BYTES;
    } else {
      process.env.VIVENTIUM_ANTHROPIC_MAX_SINGLE_DOCUMENT_BYTES = originalMaxSingle;
    }

    if (originalMaxTotal === undefined) {
      delete process.env.VIVENTIUM_ANTHROPIC_MAX_TOTAL_DOCUMENT_BYTES;
    } else {
      process.env.VIVENTIUM_ANTHROPIC_MAX_TOTAL_DOCUMENT_BYTES = originalMaxTotal;
    }
  });

  test('skips oversized Anthropic inline document payloads and continues', async () => {
    encodeAndFormatDocuments.mockResolvedValue({
      files: [],
      documents: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            // ~1.5KB decoded payload (4 chars -> 3 bytes)
            data: 'A'.repeat(2048),
          },
        },
      ],
    });

    const client = new FakeClient('test', {
      endpoint: 'agents',
      req: {},
      agent: {
        provider: 'anthropic',
        endpoint: 'agents',
        model_parameters: {},
      },
    });

    const message = {};
    const files = await client.addDocuments(message, []);
    expect(files).toEqual([]);
    expect(message.documents).toBeUndefined();
  });

  test('allows Anthropic inline document payloads within configured limits', async () => {
    encodeAndFormatDocuments.mockResolvedValue({
      files: [{ file_id: 'ok-file' }],
      documents: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            // ~600B decoded payload
            data: 'A'.repeat(800),
          },
        },
      ],
    });

    const client = new FakeClient('test', {
      endpoint: 'agents',
      req: {},
      agent: {
        provider: 'anthropic',
        endpoint: 'agents',
        model_parameters: {},
      },
    });

    const message = {};
    const files = await client.addDocuments(message, []);
    expect(files).toEqual([{ file_id: 'ok-file' }]);
    expect(Array.isArray(message.documents)).toBe(true);
    expect(message.documents).toHaveLength(1);
  });

  test('does not apply Anthropic guard for non-Anthropic providers', async () => {
    encodeAndFormatDocuments.mockResolvedValue({
      files: [{ file_id: 'openai-file' }],
      documents: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            // This would exceed the Anthropic per-doc limit used above,
            // but should pass when provider is not Anthropic.
            data: 'A'.repeat(2048),
          },
        },
      ],
    });

    const client = new FakeClient('test', {
      endpoint: 'agents',
      req: {},
      agent: {
        provider: 'openAI',
        endpoint: 'agents',
        model_parameters: {},
      },
    });

    const message = {};
    const files = await client.addDocuments(message, []);
    expect(files).toEqual([{ file_id: 'openai-file' }]);
    expect(Array.isArray(message.documents)).toBe(true);
    expect(message.documents).toHaveLength(1);
  });
});
