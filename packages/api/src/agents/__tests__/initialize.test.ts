import { Providers } from '@librechat/agents';
import { EModelEndpoint } from 'librechat-data-provider';
import type { Agent } from 'librechat-data-provider';
import type { ServerRequest, InitializeResultBase } from '~/types';
import type { InitializeAgentDbMethods } from '../initialize';

// Mock logger
jest.mock('winston', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
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

describe('initializeAgent — conversation recall resources', () => {
  const originalRagApiUrl = process.env.RAG_API_URL;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
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
        }),
      ]),
    );
  });
});
