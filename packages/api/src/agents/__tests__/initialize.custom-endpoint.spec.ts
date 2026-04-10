import { Providers } from '@librechat/agents';
import { EModelEndpoint } from 'librechat-data-provider';
import type { Agent } from 'librechat-data-provider';
import type { InitializeResultBase, ServerRequest } from '~/types';
import type { InitializeAgentDbMethods } from '../initialize';

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

describe('initializeAgent custom endpoint initialization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExtractLibreChatParams.mockReturnValue({
      resendFiles: false,
      maxContextTokens: undefined,
      modelOptions: { model: 'mlx-community/gemma-4-26b-a4b-it-4bit' },
    });
    mockGetModelMaxTokens.mockReturnValue(128000);
    mockOptionalChainWithEmptyCheck.mockImplementation(
      (...values: (string | number | undefined)[]) => {
        for (const value of values) {
          if (value !== undefined && value !== null && value !== '') {
            return value;
          }
        }
        return values[values.length - 1];
      },
    );
    mockGetThreadData.mockReturnValue(undefined);
  });

  it('uses the canonical custom endpoint name for initialization while preserving the OpenAI provider runtime', async () => {
    const req = {
      user: { id: 'user-1' },
      config: {},
    } as unknown as ServerRequest;
    const res = {} as unknown as import('express').Response;
    const agent = {
      id: 'agent-mlx',
      model: 'mlx-community/gemma-4-26b-a4b-it-4bit',
      provider: 'mlx',
      tools: [],
      model_parameters: { model: 'mlx-community/gemma-4-26b-a4b-it-4bit' },
    } as unknown as Agent;

    const mockGetOptions = jest.fn().mockResolvedValue({
      llmConfig: {
        model: 'mlx-community/gemma-4-26b-a4b-it-4bit',
        maxTokens: 4096,
      },
      endpointTokenConfig: undefined,
    } satisfies InitializeResultBase);

    mockGetProviderConfig.mockReturnValue({
      getOptions: mockGetOptions,
      overrideProvider: Providers.OPENAI,
      initEndpoint: 'mlx',
    });

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

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: {
          endpoint: 'mlx' as EModelEndpoint,
          model_parameters: { model: 'mlx-community/gemma-4-26b-a4b-it-4bit' },
        },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(mockGetOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'mlx',
      }),
    );
    expect(agent.provider).toBe(Providers.OPENAI);
    expect(agent.endpoint).toBe('mlx');
  });
});
