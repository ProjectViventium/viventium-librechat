/* === VIVENTIUM START ===
 * Feature: Connected Accounts fallback routing tests.
 * Purpose: Verify user-first/admin-fallback credential resolution for OpenAI initialization.
 * === VIVENTIUM END === */
import { ErrorTypes, EModelEndpoint } from 'librechat-data-provider';
import type { BaseInitializeParams } from '~/types';
import { initializeOpenAI } from './initialize';
import { checkUserKeyExpiry } from '~/utils';

const mockGetOpenAIConfig = jest.fn((apiKey: string, options: Record<string, unknown>) => ({
  llmConfig: { apiKey, ...(options.modelOptions as Record<string, unknown>) },
  configOptions: {},
}));

jest.mock('./config', () => ({
  getOpenAIConfig: (...args: unknown[]) => mockGetOpenAIConfig(...args),
}));

jest.mock('~/utils', () => ({
  getAzureCredentials: jest.fn(),
  resolveHeaders: jest.fn(({ headers }) => headers),
  isUserProvided: jest.fn((value?: string) => value === 'user_provided'),
  checkUserKeyExpiry: jest.fn(),
}));

const mockedCheckUserKeyExpiry = jest.mocked(checkUserKeyExpiry);

const createParams = (
  overrides: Partial<{
    body: Record<string, unknown>;
    dbOverrides: Partial<BaseInitializeParams['db']>;
  }> = {},
): BaseInitializeParams => {
  const db = {
    getUserKey: jest.fn(),
    getUserKeyValues: jest.fn().mockRejectedValue(
      new Error(
        JSON.stringify({
          type: ErrorTypes.NO_USER_KEY,
        }),
      ),
    ),
    ...overrides.dbOverrides,
  };

  return {
    req: {
      config: {},
      body: overrides.body ?? {},
      user: { id: 'user-123' },
    },
    endpoint: EModelEndpoint.openAI,
    model_parameters: { model: 'gpt-4o-mini' },
    db,
  } as unknown as BaseInitializeParams;
};

describe('initializeOpenAI', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      OPENAI_API_KEY: 'platform-openai-key',
      OPENAI_REVERSE_PROXY: '',
      PROXY: '',
      AZURE_API_KEY: '',
      AZURE_OPENAI_BASEURL: '',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should prioritize a connected user key over platform key', async () => {
    const params = createParams({
      dbOverrides: {
        getUserKeyValues: jest.fn().mockResolvedValue({
          apiKey: 'user-openai-key',
        }),
      },
    });

    await initializeOpenAI(params);

    expect(mockGetOpenAIConfig).toHaveBeenCalledWith(
      'user-openai-key',
      expect.objectContaining({
        modelOptions: expect.objectContaining({
          model: 'gpt-4o-mini',
          user: 'user-123',
        }),
      }),
      EModelEndpoint.openAI,
    );
  });

  it('should enable responses API and pass oauth headers for OpenAI subscription auth', async () => {
    const params = createParams({
      dbOverrides: {
        getUserKeyValues: jest.fn().mockResolvedValue({
          apiKey: 'openai-oauth-access-token',
          baseURL: 'https://chatgpt.com/backend-api/codex',
          headers: {
            'OpenAI-Beta': 'responses=experimental',
            originator: 'viventium',
            'chatgpt-account-id': 'acct_123',
          },
          oauthProvider: 'openai-codex',
        }),
      },
    });

    await initializeOpenAI(params);

    expect(mockGetOpenAIConfig).toHaveBeenCalledWith(
      'openai-oauth-access-token',
      expect.objectContaining({
        reverseProxyUrl: 'https://chatgpt.com/backend-api/codex',
        headers: expect.objectContaining({
          'OpenAI-Beta': 'responses=experimental',
          originator: 'viventium',
          'chatgpt-account-id': 'acct_123',
        }),
        modelOptions: expect.objectContaining({
          useResponsesApi: true,
        }),
      }),
      EModelEndpoint.openAI,
    );
  });

  it('should fallback to platform key when no connected user key exists', async () => {
    const params = createParams();

    await initializeOpenAI(params);

    expect(mockGetOpenAIConfig).toHaveBeenCalledWith(
      'platform-openai-key',
      expect.any(Object),
      EModelEndpoint.openAI,
    );
  });

  it('should surface reconnect guidance when connected-account auth cannot read the stored key', async () => {
    process.env.VIVENTIUM_OPENAI_AUTH_MODE = 'connected_account';
    const params = createParams({
      dbOverrides: {
        getUserKeyValues: jest
          .fn()
          .mockRejectedValue(new Error('The operation failed for an operation-specific reason')),
      },
    });

    await expect(initializeOpenAI(params)).rejects.toThrow(
      'OpenAI connected account needs reconnect in Settings > Account > Connected Accounts.',
    );
  });

  it('should fallback to platform key when a stale stored key is unreadable outside connected-account mode', async () => {
    delete process.env.VIVENTIUM_OPENAI_AUTH_MODE;
    const params = createParams({
      dbOverrides: {
        getUserKeyValues: jest
          .fn()
          .mockRejectedValue(new Error('The operation failed for an operation-specific reason')),
      },
    });

    await initializeOpenAI(params);

    expect(mockGetOpenAIConfig).toHaveBeenCalledWith(
      'platform-openai-key',
      expect.any(Object),
      EModelEndpoint.openAI,
    );
  });

  it('should throw NO_USER_KEY when endpoint is strictly user_provided and user key is missing', async () => {
    process.env.OPENAI_API_KEY = 'user_provided';
    const params = createParams();

    await expect(initializeOpenAI(params)).rejects.toThrow();

    try {
      await initializeOpenAI(params);
    } catch (error) {
      const parsedError = JSON.parse((error as Error).message);
      expect(parsedError.type).toBe(ErrorTypes.NO_USER_KEY);
    }
  });

  it('should validate user key expiry when a connected key is present and expiry is provided', async () => {
    const params = createParams({
      body: { key: '2099-12-31T23:59:59.000Z' },
      dbOverrides: {
        getUserKeyValues: jest.fn().mockResolvedValue({
          apiKey: 'user-openai-key',
        }),
      },
    });

    await initializeOpenAI(params);

    expect(mockedCheckUserKeyExpiry).toHaveBeenCalledWith(
      '2099-12-31T23:59:59.000Z',
      EModelEndpoint.openAI,
    );
  });
});
