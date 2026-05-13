import { Providers } from '@librechat/agents';
import fs from 'fs';
import crypto from 'crypto';
import { EModelEndpoint, FileContext } from 'librechat-data-provider';
import os from 'os';
import path from 'path';
import type { Agent } from 'librechat-data-provider';
import type { ServerRequest, InitializeResultBase } from '~/types';
import type { InitializeAgentDbMethods } from '../initialize';

var mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: (...args: unknown[]) => mockLogger.debug(...args),
    info: (...args: unknown[]) => mockLogger.info(...args),
    warn: (...args: unknown[]) => mockLogger.warn(...args),
    error: (...args: unknown[]) => mockLogger.error(...args),
  },
}));

// Mock logger
jest.mock('winston', () => ({
  createLogger: jest.fn(() => mockLogger),
  format: {
    combine: jest.fn(),
    colorize: jest.fn(),
    simple: jest.fn(),
  },
  transports: {
    Console: jest.fn(),
  },
}));

const mockExtractLibreChatParams = jest.fn();
const mockGetModelMaxTokens = jest.fn();
const mockOptionalChainWithEmptyCheck = jest.fn();
const mockGetThreadData = jest.fn();

jest.mock('~/utils', () => ({
  extractLibreChatParams: (...args: unknown[]) => mockExtractLibreChatParams(...args),
  getModelMaxTokens: (...args: unknown[]) => mockGetModelMaxTokens(...args),
  optionalChainWithEmptyCheck: (...args: unknown[]) => mockOptionalChainWithEmptyCheck(...args),
  getThreadData: (...args: unknown[]) => mockGetThreadData(...args),
}));

const mockGetProviderConfig = jest.fn();
jest.mock('~/endpoints', () => ({
  getProviderConfig: (...args: unknown[]) => mockGetProviderConfig(...args),
}));

jest.mock('~/files', () => ({
  filterFilesByEndpointConfig: jest.fn(() => []),
}));

const mockRagFilesExist = jest.fn(async ({ fileIds }: { fileIds: string[] }) => new Set(fileIds));
jest.mock('~/files/rag', () => ({
  ragFilesExist: (...args: unknown[]) => mockRagFilesExist(...args),
}));

jest.mock('~/prompts', () => ({
  generateArtifactsPrompt: jest.fn(() => null),
}));

jest.mock('../resources', () => ({
  primeResources: jest.fn().mockResolvedValue({
    attachments: [],
    tool_resources: undefined,
  }),
}));

import { initializeAgent } from '../initialize';
import { __internal as recallAvailabilityInternal } from '../conversationRecallAvailability';

/**
 * Creates minimal mock objects for initializeAgent tests.
 */
function createMocks(overrides?: {
  maxContextTokens?: number;
  modelDefault?: number;
  maxOutputTokens?: number;
  provider?: string;
}) {
  const {
    maxContextTokens,
    modelDefault = 200000,
    maxOutputTokens = 4096,
    provider = Providers.OPENAI,
  } = overrides ?? {};

  const agent = {
    id: 'agent-1',
    model: 'test-model',
    provider,
    tools: [],
    model_parameters: { model: 'test-model' },
  } as unknown as Agent;

  const req = {
    user: { id: 'user-1' },
    config: {},
  } as unknown as ServerRequest;

  const res = {} as unknown as import('express').Response;

  const mockGetOptions = jest.fn().mockResolvedValue({
    llmConfig: {
      model: 'test-model',
      maxTokens: maxOutputTokens,
    },
    endpointTokenConfig: undefined,
  } satisfies InitializeResultBase);

  mockGetProviderConfig.mockReturnValue({
    getOptions: mockGetOptions,
    overrideProvider: Providers.OPENAI,
    initEndpoint: Providers.OPENAI,
  });

  // extractLibreChatParams returns maxContextTokens when provided in model_parameters
  mockExtractLibreChatParams.mockReturnValue({
    resendFiles: false,
    maxContextTokens,
    modelOptions: { model: 'test-model' },
  });

  // getModelMaxTokens returns the model's default context window
  mockGetModelMaxTokens.mockReturnValue(modelDefault);

  // Implement real optionalChainWithEmptyCheck behavior
  mockOptionalChainWithEmptyCheck.mockImplementation(
    (...values: (string | number | undefined)[]) => {
      for (const v of values) {
        if (v !== undefined && v !== null && v !== '') {
          return v;
        }
      }
      return values[values.length - 1];
    },
  );

  const loadTools = jest.fn().mockResolvedValue({
    tools: [],
    toolContextMap: {},
    userMCPAuthMap: undefined,
    toolRegistry: undefined,
    toolDefinitions: [],
    hasDeferredTools: false,
  });

  const db: InitializeAgentDbMethods = {
    getFiles: jest.fn().mockResolvedValue([]),
    getConvoFiles: jest.fn().mockResolvedValue([]),
    updateFilesUsage: jest.fn().mockResolvedValue([]),
    getUserKey: jest.fn().mockResolvedValue('user-1'),
    getUserKeyValues: jest.fn().mockResolvedValue([]),
    getToolFilesByIds: jest.fn().mockResolvedValue([]),
  };

  return { agent, req, res, loadTools, db };
}

describe('initializeAgent — maxContextTokens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses user-configured maxContextTokens when provided via model_parameters', async () => {
    const userValue = 50000;
    const { agent, req, res, loadTools, db } = createMocks({
      maxContextTokens: userValue,
      modelDefault: 200000,
      maxOutputTokens: 4096,
    });

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: {
          endpoint: EModelEndpoint.agents,
          model_parameters: { maxContextTokens: userValue },
        },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.maxContextTokens).toBe(userValue);
  });

  it('falls back to formula when maxContextTokens is NOT provided', async () => {
    const modelDefault = 200000;
    const maxOutputTokens = 4096;
    const { agent, req, res, loadTools, db } = createMocks({
      maxContextTokens: undefined,
      modelDefault,
      maxOutputTokens,
    });

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    const expected = Math.round((modelDefault - maxOutputTokens) * 0.9);
    expect(result.maxContextTokens).toBe(expected);
  });

  it('falls back to formula when maxContextTokens is 0', async () => {
    const maxOutputTokens = 4096;
    const { agent, req, res, loadTools, db } = createMocks({
      maxContextTokens: 0,
      modelDefault: 200000,
      maxOutputTokens,
    });

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: {
          endpoint: EModelEndpoint.agents,
          model_parameters: { maxContextTokens: 0 },
        },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    // 0 is not used as-is; the formula kicks in.
    // optionalChainWithEmptyCheck(0, 200000, 18000) returns 0 (not null/undefined),
    // then Number(0) || 18000 = 18000 (the fallback default).
    expect(result.maxContextTokens).not.toBe(0);
    const expected = Math.round((18000 - maxOutputTokens) * 0.9);
    expect(result.maxContextTokens).toBe(expected);
  });

  it('falls back to formula when maxContextTokens is negative', async () => {
    const maxOutputTokens = 4096;
    const { agent, req, res, loadTools, db } = createMocks({
      maxContextTokens: -1,
      modelDefault: 200000,
      maxOutputTokens,
    });

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: {
          endpoint: EModelEndpoint.agents,
          model_parameters: { maxContextTokens: -1 },
        },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    // -1 is not used as-is; the formula kicks in
    expect(result.maxContextTokens).not.toBe(-1);
  });

  it('preserves small user-configured value (e.g. 1000 from modelSpec)', async () => {
    const userValue = 1000;
    const { agent, req, res, loadTools, db } = createMocks({
      maxContextTokens: userValue,
      modelDefault: 128000,
      maxOutputTokens: 4096,
    });

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: {
          endpoint: EModelEndpoint.agents,
          model_parameters: { maxContextTokens: userValue },
        },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    // Should NOT be overridden to Math.round((128000 - 4096) * 0.9) = 111,514
    expect(result.maxContextTokens).toBe(userValue);
  });
});

describe('initializeAgent — custom endpoint init routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes the real custom endpoint name into initialization while preserving the mapped provider', async () => {
    const { agent, req, res, loadTools, db } = createMocks({
      provider: 'groq',
    });
    const mockGetOptions = jest.fn().mockResolvedValue({
      llmConfig: {
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        maxTokens: 4096,
      },
      endpointTokenConfig: undefined,
    } satisfies InitializeResultBase);

    mockGetProviderConfig.mockReturnValue({
      getOptions: mockGetOptions,
      overrideProvider: Providers.OPENAI,
      initEndpoint: 'groq',
    });

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI, 'groq']),
        isInitialAgent: true,
      },
      db,
    );

    expect(mockGetOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'groq',
      }),
    );
    expect(result.provider).toBe(Providers.OPENAI);
  });
});

describe('initializeAgent — conversation recall resources', () => {
  const originalRagApiUrl = process.env.RAG_API_URL;
  const originalAppSupportDir = process.env.VIVENTIUM_APP_SUPPORT_DIR;
  const originalFetch = global.fetch;
  let isolatedAppSupportDir: string | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRagFilesExist.mockImplementation(
      async ({ fileIds }: { fileIds: string[] }) => new Set(fileIds),
    );
    isolatedAppSupportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-app-support-test-'));
    process.env.VIVENTIUM_APP_SUPPORT_DIR = isolatedAppSupportDir;
    mockRagFilesExist.mockImplementation(
      async ({ fileIds }: { fileIds: string[] }) => new Set(fileIds),
    );
    recallAvailabilityInternal.resetConversationRecallVectorRuntimeStatusCache();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
  });

  afterEach(() => {
    recallAvailabilityInternal.resetConversationRecallVectorRuntimeStatusCache();
    global.fetch = originalFetch;
    if (originalRagApiUrl == null) {
      delete process.env.RAG_API_URL;
    } else {
      process.env.RAG_API_URL = originalRagApiUrl;
    }
    if (originalAppSupportDir == null) {
      delete process.env.VIVENTIUM_APP_SUPPORT_DIR;
    } else {
      process.env.VIVENTIUM_APP_SUPPORT_DIR = originalAppSupportDir;
    }
    if (isolatedAppSupportDir) {
      fs.rmSync(isolatedAppSupportDir, { recursive: true, force: true });
      isolatedAppSupportDir = null;
    }
  });

  it('attaches source-only conversation recall files when RAG is unavailable', async () => {
    delete process.env.RAG_API_URL;

    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = [];
    req.user.personalization = { conversation_recall: true };

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(db.getFiles).toHaveBeenCalledTimes(1);
    expect(result.tool_resources?.file_search?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file_id: 'conversation_recall:user-1:all',
          viventiumConversationRecallMode: 'source_only',
          viventiumConversationRecallAttachmentReason: 'missing_corpus',
        }),
      ]),
    );
  });

  it('attaches source-only conversation recall files when vector runtime health check fails', async () => {
    process.env.RAG_API_URL = 'http://rag.example.test';
    global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = [];
    req.user.personalization = { conversation_recall: true };

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(db.getFiles).toHaveBeenCalledTimes(1);
    expect(result.tool_resources?.file_search?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file_id: 'conversation_recall:user-1:all',
          viventiumConversationRecallMode: 'source_only',
          viventiumConversationRecallAttachmentReason: 'missing_corpus',
        }),
      ]),
    );
  });

  it('attaches source-only conversation recall files when the vector corpus is stale', async () => {
    process.env.RAG_API_URL = 'http://rag.example.test';

    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = [];
    req.user.personalization = { conversation_recall: true };
    db.getFiles = jest.fn().mockResolvedValue([
      {
        file_id: 'conversation_recall:user-1:all',
        filename: 'conversation-recall-all.txt',
        updatedAt: '2026-04-08T15:00:00.000Z',
      },
    ]);
    db.getLatestRecallEligibleMessageCreatedAt = jest
      .fn()
      .mockResolvedValue('2026-04-08T16:00:00.000Z');

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(db.getFiles).toHaveBeenCalledTimes(1);
    expect(db.getLatestRecallEligibleMessageCreatedAt).toHaveBeenCalledWith({ user: 'user-1' });
    expect(result.tool_resources?.file_search?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file_id: 'conversation_recall:user-1:all',
          viventiumConversationRecallMode: 'source_only',
          viventiumConversationRecallAttachmentReason: 'stale_corpus',
        }),
      ]),
    );
  });

  it('attaches fresh global conversation recall corpora when vector runtime is healthy', async () => {
    process.env.RAG_API_URL = 'http://rag.example.test';

    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = [];
    req.user.personalization = { conversation_recall: true };
    db.getFiles = jest.fn().mockResolvedValue([
      {
        file_id: 'conversation_recall:user-1:all',
        filename: 'conversation-recall-all.txt',
        updatedAt: '2026-04-08T16:00:00.000Z',
      },
    ]);
    db.getLatestRecallEligibleMessageCreatedAt = jest
      .fn()
      .mockResolvedValue('2026-04-08T16:00:00.000Z');

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.tool_resources?.file_search?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file_id: 'conversation_recall:user-1:all',
          viventiumConversationRecallMode: 'vector',
          viventiumConversationRecallAttachmentReason: 'vector_ready',
        }),
      ]),
    );
  });
});

describe('initializeAgent — meeting transcript resources', () => {
  const originalTranscriptDir = process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_DIR;
  const originalRagApiUrl = process.env.RAG_API_URL;
  const originalAppSupportDir = process.env.VIVENTIUM_APP_SUPPORT_DIR;
  const originalFetch = global.fetch;
  let isolatedAppSupportDir: string | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    isolatedAppSupportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-app-support-test-'));
    process.env.VIVENTIUM_APP_SUPPORT_DIR = isolatedAppSupportDir;
    recallAvailabilityInternal.resetConversationRecallVectorRuntimeStatusCache();
    process.env.RAG_API_URL = 'http://rag.example.test';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
  });

  afterEach(() => {
    recallAvailabilityInternal.resetConversationRecallVectorRuntimeStatusCache();
    global.fetch = originalFetch;
    if (originalTranscriptDir == null) {
      delete process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_DIR;
    } else {
      process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_DIR = originalTranscriptDir;
    }
    if (originalRagApiUrl == null) {
      delete process.env.RAG_API_URL;
    } else {
      process.env.RAG_API_URL = originalRagApiUrl;
    }
    if (originalAppSupportDir == null) {
      delete process.env.VIVENTIUM_APP_SUPPORT_DIR;
    } else {
      process.env.VIVENTIUM_APP_SUPPORT_DIR = originalAppSupportDir;
    }
    if (isolatedAppSupportDir) {
      fs.rmSync(isolatedAppSupportDir, { recursive: true, force: true });
      isolatedAppSupportDir = null;
    }
  });

  it('attaches user-scoped meeting transcript files only when the local folder exists', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-meeting-init-'));
    try {
      process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_DIR = tempDir;
      delete process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_RAG_MODE;
      const currentSourceHash = crypto
        .createHash('sha256')
        .update(path.resolve(tempDir))
        .digest('hex')
        .slice(0, 16);
      const { agent, req, res, loadTools, db } = createMocks();
      agent.tools = [];
      db.getFiles = jest.fn().mockImplementation((query) => {
        expect(query).toEqual(
          expect.objectContaining({
            user: 'user-1',
            context: FileContext.meeting_transcript,
            embedded: true,
            'metadata.meetingTranscriptSourcePathHash': currentSourceHash,
            'metadata.meetingTranscriptKind': { $in: ['summary', 'inventory'] },
          }),
        );
        if (query?.context === FileContext.meeting_transcript) {
          return Promise.resolve([
            {
              user: 'user-1',
              file_id: 'meeting_summary:user-1:abc',
              filename: 'meeting-transcript-summary-abc.txt',
              filepath: 'vectordb',
              object: 'file',
              type: 'text/plain',
              bytes: 123,
              embedded: true,
              usage: 0,
              context: FileContext.meeting_transcript,
              metadata: {
                meetingTranscriptKind: 'summary',
                meetingTranscriptSourcePathHash: currentSourceHash,
              },
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
        },
        db,
      );

      expect(loadTools).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: expect.arrayContaining(['file_search']),
        }),
      );
      expect(db.getFiles).toHaveBeenCalledWith(
        expect.objectContaining({
          'metadata.meetingTranscriptKind': { $in: ['summary', 'inventory'] },
        }),
        null,
        { text: 0 },
        expect.any(Object),
      );
      expect(result.tool_resources?.file_search?.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_id: 'meeting_summary:user-1:abc',
            context: FileContext.meeting_transcript,
            viventiumMeetingTranscriptRecall: true,
          }),
        ]),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('filters meeting transcript resources by current source folder hash and summary-only mode', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-meeting-init-filter-'));
    try {
      process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_DIR = tempDir;
      process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_RAG_MODE = 'detailed_summary_only';
      const currentSourceHash = crypto
        .createHash('sha256')
        .update(path.resolve(tempDir))
        .digest('hex')
        .slice(0, 16);
      const { agent, req, res, loadTools, db } = createMocks();
      db.getFiles = jest.fn().mockImplementation((query) => {
        const rows = [
          {
            user: 'user-1',
            file_id: 'meeting_summary:user-1:current',
            filename: 'meeting-transcript-summary-current.txt',
            embedded: true,
            context: FileContext.meeting_transcript,
            metadata: {
              meetingTranscriptKind: 'summary',
              meetingTranscriptSourcePathHash: currentSourceHash,
            },
          },
          {
            user: 'user-1',
            file_id: 'meeting_transcript:user-1:raw-current',
            filename: 'meeting-transcript-raw-current.txt',
            embedded: true,
            context: FileContext.meeting_transcript,
            metadata: {
              meetingTranscriptKind: 'raw',
              meetingTranscriptSourcePathHash: currentSourceHash,
            },
          },
          {
            user: 'user-1',
            file_id: 'meeting_summary:user-1:old',
            filename: 'meeting-transcript-summary-old.txt',
            embedded: true,
            context: FileContext.meeting_transcript,
            metadata: {
              meetingTranscriptKind: 'summary',
              meetingTranscriptSourcePathHash: 'oldsourcehash000',
            },
          },
        ];
        return Promise.resolve(
          rows.filter(
            (row) =>
              row.metadata.meetingTranscriptSourcePathHash ===
                query['metadata.meetingTranscriptSourcePathHash'] &&
              query['metadata.meetingTranscriptKind']?.$in?.includes(
                row.metadata.meetingTranscriptKind,
              ),
          ),
        );
      });

      const result = await initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
        },
        db,
      );

      expect(db.getFiles).toHaveBeenCalledWith(
        expect.objectContaining({
          'metadata.meetingTranscriptSourcePathHash': currentSourceHash,
          'metadata.meetingTranscriptKind': { $in: ['summary', 'inventory'] },
        }),
        null,
        { text: 0 },
        expect.any(Object),
      );
      expect(result.tool_resources?.file_search?.file_ids).toEqual([
        'meeting_summary:user-1:current',
      ]);
      expect(loadTools).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: expect.arrayContaining(['file_search']),
        }),
      );
    } finally {
      delete process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_RAG_MODE;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not attach old meeting transcript rows when the local folder is not configured', async () => {
    delete process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_DIR;
    const { agent, req, res, loadTools, db } = createMocks();
    db.getFiles = jest.fn().mockResolvedValue([
      {
        file_id: 'meeting_transcript:user-1:abc',
        context: FileContext.meeting_transcript,
        embedded: true,
      },
    ]);

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.tool_resources?.file_search?.files || []).toEqual([]);
  });

  it('does not attach meeting transcript vector resources when vector runtime is unavailable', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-meeting-init-rag-down-'));
    try {
      process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_DIR = tempDir;
      process.env.RAG_API_URL = 'http://rag.example.test';
      global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
      recallAvailabilityInternal.resetConversationRecallVectorRuntimeStatusCache();
      const { agent, req, res, loadTools, db } = createMocks();
      db.getFiles = jest.fn().mockResolvedValue([
        {
          user: 'user-1',
          file_id: 'meeting_summary:user-1:current',
          filename: 'meeting-transcript-summary-current.txt',
          embedded: true,
          context: FileContext.meeting_transcript,
          metadata: {
            meetingTranscriptKind: 'summary',
          },
        },
      ]);

      const result = await initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
        },
        db,
      );

      expect(db.getFiles).not.toHaveBeenCalledWith(
        expect.objectContaining({
          context: FileContext.meeting_transcript,
        }),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
      expect(result.tool_resources?.file_search?.files || []).toEqual([]);
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[initializeAgent] Meeting transcript recall configured but vector runtime unavailable',
        expect.objectContaining({
          reason: 'unreachable',
          sourceFolderHash: expect.stringMatching(/^[a-f0-9]{16}$/),
        }),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not attach meeting transcript rows that are missing from the vector store', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'viventium-meeting-init-missing-vector-'),
    );
    try {
      process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_DIR = tempDir;
      mockRagFilesExist.mockResolvedValue(new Set());
      const { agent, req, res, loadTools, db } = createMocks();
      db.getFiles = jest.fn().mockResolvedValue([
        {
          user: 'user-1',
          file_id: 'meeting_summary:user-1:missing',
          filename: 'meeting-transcript-summary-missing.txt',
          embedded: true,
          context: FileContext.meeting_transcript,
          metadata: {
            meetingTranscriptKind: 'summary',
            meetingTranscriptSourcePathHash: crypto
              .createHash('sha256')
              .update(path.resolve(tempDir))
              .digest('hex')
              .slice(0, 16),
          },
        },
      ]);

      const result = await initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
        },
        db,
      );

      expect(mockRagFilesExist).toHaveBeenCalledWith({
        userId: 'user-1',
        fileIds: ['meeting_summary:user-1:missing'],
      });
      expect(result.tool_resources?.file_search?.files || []).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[initializeAgent] Meeting transcript Mongo artifacts missing from vector store',
        expect.objectContaining({
          fileCount: 1,
          verifiedFileCount: 0,
        }),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('attaches transcript inventory from source metadata even when vector summaries are missing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-meeting-init-inventory-'));
    try {
      process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_DIR = tempDir;
      const currentSourceHash = crypto
        .createHash('sha256')
        .update(path.resolve(tempDir))
        .digest('hex')
        .slice(0, 16);
      mockRagFilesExist.mockResolvedValue(new Set());
      const { agent, req, res, loadTools, db } = createMocks();
      db.getFiles = jest.fn().mockResolvedValue([
        {
          user: 'user-1',
          file_id: 'meeting_inventory:user-1:current',
          filename: 'meeting-transcript-inventory-current.txt',
          embedded: true,
          context: FileContext.meeting_transcript,
          metadata: {
            meetingTranscriptKind: 'inventory',
            meetingTranscriptSourcePathHash: currentSourceHash,
            meetingTranscriptInventoryText: 'Meeting transcript inventory / table of contents.',
          },
        },
        {
          user: 'user-1',
          file_id: 'meeting_summary:user-1:missing',
          filename: 'meeting-transcript-summary-missing.txt',
          embedded: true,
          context: FileContext.meeting_transcript,
          metadata: {
            meetingTranscriptKind: 'summary',
            meetingTranscriptSourcePathHash: currentSourceHash,
          },
        },
      ]);

      const result = await initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
        },
        db,
      );

      expect(mockRagFilesExist).toHaveBeenCalledWith({
        userId: 'user-1',
        fileIds: ['meeting_summary:user-1:missing'],
      });
      expect(result.tool_resources?.file_search?.file_ids).toEqual([
        'meeting_inventory:user-1:current',
      ]);
      expect(result.tool_resources?.file_search?.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_id: 'meeting_inventory:user-1:current',
            context: FileContext.meeting_transcript,
            viventiumMeetingTranscriptRecall: true,
          }),
        ]),
      );
      expect(loadTools).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: expect.arrayContaining(['file_search']),
        }),
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[initializeAgent] Meeting transcript Mongo artifacts missing from vector store',
        expect.objectContaining({
          fileCount: 1,
          verifiedFileCount: 0,
          inventoryFileCount: 1,
        }),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('logs when transcript recall is configured but the active user has no artifacts', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-meeting-init-empty-'));
    try {
      process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_DIR = tempDir;
      const { agent, req, res, loadTools, db } = createMocks();
      agent.tools = [];
      db.getFiles = jest.fn().mockResolvedValue([]);

      const result = await initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
        },
        db,
      );

      expect(result.tool_resources?.file_search?.files || []).toEqual([]);
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[initializeAgent] Meeting transcript recall configured but no artifacts for active user',
        expect.objectContaining({
          userId: 'user-1',
          agentId: 'agent-1',
          mode: 'detailed_summary_only',
          sourceFolderHash: expect.stringMatching(/^[a-f0-9]{16}$/),
        }),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
