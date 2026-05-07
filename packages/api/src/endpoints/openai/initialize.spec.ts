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
    updateUserKey: jest.fn(),
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
    global.fetch = jest.fn();
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
    jest.restoreAllMocks();
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

  it('should refresh an expired OpenAI subscription credential before use', async () => {
    const accessTokenPayload = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct_refreshed',
        },
      }),
    )
      .toString('base64url');
    const refreshedAccessToken = `header.${accessTokenPayload}.signature`;
    const mockFetch = jest.mocked(global.fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          access_token: refreshedAccessToken,
          refresh_token: 'refreshed-refresh-token',
          expires_in: 28800,
        }),
    } as Response);

    const params = createParams({
      dbOverrides: {
        getUserKeyValues: jest.fn().mockResolvedValue({
          apiKey: 'expired-openai-oauth-access-token',
          baseURL: 'https://chatgpt.com/backend-api/codex',
          headers: {
            'OpenAI-Beta': 'responses=experimental',
            originator: 'viventium',
            'chatgpt-account-id': 'acct_old',
          },
          refreshToken: 'refresh-token',
          oauthProvider: 'openai-codex',
          oauthType: 'subscription',
          oauthExpiresAt: Date.now() - 60 * 1000,
        }),
      },
    });

    await initializeOpenAI(params);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://auth.openai.com/oauth/token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
        body: expect.any(URLSearchParams),
      }),
    );
    expect((mockFetch.mock.calls[0]?.[1] as RequestInit | undefined)?.body?.toString()).toContain(
      'grant_type=refresh_token',
    );
    expect(mockGetOpenAIConfig).toHaveBeenCalledWith(
      refreshedAccessToken,
      expect.objectContaining({
        reverseProxyUrl: 'https://chatgpt.com/backend-api/codex',
        headers: expect.objectContaining({
          'OpenAI-Beta': 'responses=experimental',
          originator: 'pi',
          'chatgpt-account-id': 'acct_refreshed',
        }),
        modelOptions: expect.objectContaining({
          useResponsesApi: true,
        }),
      }),
      EModelEndpoint.openAI,
    );
    const updateUserKey = params.db.updateUserKey as jest.Mock;
    expect(updateUserKey).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-123',
        name: EModelEndpoint.openAI,
        expiresAt: null,
      }),
    );
    const persistedValue = JSON.parse(updateUserKey.mock.calls[0][0].value);
    expect(persistedValue).toMatchObject({
      apiKey: refreshedAccessToken,
      refreshToken: 'refreshed-refresh-token',
      oauthProvider: 'openai-codex',
      oauthType: 'subscription',
      accountId: 'acct_refreshed',
    });
    expect(persistedValue.oauthExpiresAt).toBeGreaterThan(Date.now());
  });

  it('should surface reconnect guidance when expired OpenAI subscription refresh fails', async () => {
    const mockFetch = jest.mocked(global.fetch);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () =>
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Refresh token not found or invalid',
        }),
    } as Response);

    const params = createParams({
      dbOverrides: {
        getUserKeyValues: jest.fn().mockResolvedValue({
          apiKey: 'expired-openai-oauth-access-token',
          refreshToken: 'broken-refresh-token',
          oauthProvider: 'openai-codex',
          oauthType: 'subscription',
          oauthExpiresAt: Date.now() - 60 * 1000,
        }),
      },
    });

    await expect(initializeOpenAI(params)).rejects.toThrow(
      'OpenAI connected account needs reconnect in Settings > Account > Connected Accounts.',
    );
    expect(mockGetOpenAIConfig).not.toHaveBeenCalled();
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

  it('should require a connected account when connected-account auth has no stored OpenAI credential', async () => {
    process.env.OPENAI_API_KEY = 'user_provided';
    process.env.VIVENTIUM_OPENAI_AUTH_MODE = 'connected_account';
    const params = createParams();

    await expect(initializeOpenAI(params)).rejects.toThrow();

    try {
      await initializeOpenAI(params);
    } catch (error) {
      const parsedError = JSON.parse((error as Error).message);
      expect(parsedError.type).toBe(ErrorTypes.CONNECTED_ACCOUNT_REQUIRED);
      expect(parsedError.info).toBe(EModelEndpoint.openAI);
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
