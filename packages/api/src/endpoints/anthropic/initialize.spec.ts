/* === VIVENTIUM START ===
 * Feature: Connected Accounts fallback routing tests.
 * Purpose: Verify user-first/admin-fallback credential resolution for Anthropic initialization.
 * === VIVENTIUM END === */
import { AuthKeys, ErrorTypes, EModelEndpoint } from 'librechat-data-provider';
import type { BaseInitializeParams } from '~/types';
import { initializeAnthropic } from './initialize';
import { checkUserKeyExpiry } from '~/utils';

const mockGetLLMConfig = jest.fn(
  (credentials: Record<string, unknown>, options: Record<string, unknown>) => ({
    llmConfig: {
      credentials,
      ...(options.modelOptions as Record<string, unknown>),
    },
    configOptions: {},
  }),
);

jest.mock('./llm', () => ({
  getLLMConfig: (...args: unknown[]) => mockGetLLMConfig(...args),
}));

jest.mock('./vertex', () => ({
  loadAnthropicVertexCredentials: jest.fn(),
  getVertexCredentialOptions: jest.fn(),
}));

jest.mock('~/utils', () => ({
  checkUserKeyExpiry: jest.fn(),
  isEnabled: jest.fn(() => false),
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
      user: { id: 'anthropic-user' },
    },
    endpoint: EModelEndpoint.anthropic,
    model_parameters: { model: 'claude-sonnet-4-5' },
    db,
  } as unknown as BaseInitializeParams;
};

describe('initializeAnthropic', () => {
  const originalEnv = process.env;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = jest.fn();
    global.fetch = mockFetch as typeof fetch;
    process.env = {
      ...originalEnv,
      ANTHROPIC_API_KEY: 'platform-anthropic-key',
      ANTHROPIC_REVERSE_PROXY: '',
      PROXY: '',
      ANTHROPIC_USE_VERTEX: 'false',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should prioritize a connected user key over platform key', async () => {
    const params = createParams({
      dbOverrides: {
        getUserKeyValues: jest.fn().mockResolvedValue({
          apiKey: 'user-anthropic-key',
        }),
      },
    });

    await initializeAnthropic(params);

    expect(mockGetLLMConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        [AuthKeys.ANTHROPIC_API_KEY]: 'user-anthropic-key',
      }),
      expect.any(Object),
    );
  });

  it('should use authToken field for Anthropic OAuth credentials', async () => {
    process.env.ANTHROPIC_API_KEY = 'user_provided';
    const params = createParams({
      dbOverrides: {
        getUserKeyValues: jest.fn().mockResolvedValue({
          authToken: 'oauth-access-token',
          apiKey: 'oauth-access-token',
          oauthProvider: 'anthropic',
          oauthType: 'subscription',
          oauthExpiresAt: Date.now() + 60 * 60 * 1000,
        }),
      },
    });

    await initializeAnthropic(params);

    expect(mockGetLLMConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        [AuthKeys.ANTHROPIC_API_KEY]: 'oauth-access-token',
      }),
      expect.objectContaining({
        oauthProvider: 'anthropic',
        oauthType: 'subscription',
      }),
    );
    const updateUserKey = params.db.updateUserKey as jest.Mock;
    expect(updateUserKey).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'anthropic-user',
        name: EModelEndpoint.anthropic,
        expiresAt: null,
      }),
    );
    const persistedValue = JSON.parse(updateUserKey.mock.calls[0][0].value);
    expect(persistedValue).toMatchObject({
      authToken: 'oauth-access-token',
      apiKey: 'oauth-access-token',
      oauthProvider: 'anthropic',
      oauthType: 'subscription',
    });
    expect(typeof persistedValue.oauthExpiresAt).toBe('number');
  });

  it('should fallback to platform key when user key is missing', async () => {
    const params = createParams();

    await initializeAnthropic(params);

    expect(mockGetLLMConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        [AuthKeys.ANTHROPIC_API_KEY]: 'platform-anthropic-key',
      }),
      expect.any(Object),
    );
  });

  it('should throw NO_USER_KEY when endpoint is strictly user_provided and user key is missing', async () => {
    process.env.ANTHROPIC_API_KEY = 'user_provided';
    const params = createParams();

    await expect(initializeAnthropic(params)).rejects.toThrow();

    try {
      await initializeAnthropic(params);
    } catch (error) {
      const parsedError = JSON.parse((error as Error).message);
      expect(parsedError.type).toBe(ErrorTypes.NO_USER_KEY);
    }
  });

  it('should require a connected account when connected-account auth has no stored Anthropic credential', async () => {
    process.env.ANTHROPIC_API_KEY = 'user_provided';
    process.env.VIVENTIUM_ANTHROPIC_AUTH_MODE = 'connected_account';
    const params = createParams();

    await expect(initializeAnthropic(params)).rejects.toThrow(
      'Anthropic connected account needs reconnect in Settings > Account > Connected Accounts.',
    );
  });

  it('should surface reconnect guidance when connected-account auth cannot read the stored Anthropic key', async () => {
    process.env.VIVENTIUM_ANTHROPIC_AUTH_MODE = 'connected_account';
    const params = createParams({
      dbOverrides: {
        getUserKeyValues: jest
          .fn()
          .mockRejectedValue(new Error('The operation failed for an operation-specific reason')),
      },
    });

    await expect(initializeAnthropic(params)).rejects.toThrow(
      'Anthropic connected account needs reconnect in Settings > Account > Connected Accounts.',
    );
  });

  it('should fallback to platform key when an unreadable stored Anthropic key is encountered outside connected-account mode', async () => {
    delete process.env.VIVENTIUM_ANTHROPIC_AUTH_MODE;
    const params = createParams({
      dbOverrides: {
        getUserKeyValues: jest
          .fn()
          .mockRejectedValue(new Error('The operation failed for an operation-specific reason')),
      },
    });

    await initializeAnthropic(params);

    expect(mockGetLLMConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        [AuthKeys.ANTHROPIC_API_KEY]: 'platform-anthropic-key',
      }),
      expect.any(Object),
    );
  });

  it('should validate user key expiry when a connected key is present and expiry is provided', async () => {
    const params = createParams({
      body: { key: '2099-12-31T23:59:59.000Z' },
      dbOverrides: {
        getUserKeyValues: jest.fn().mockResolvedValue({
          apiKey: 'user-anthropic-key',
        }),
      },
    });

    await initializeAnthropic(params);

    expect(mockedCheckUserKeyExpiry).toHaveBeenCalledWith(
      '2099-12-31T23:59:59.000Z',
      EModelEndpoint.anthropic,
    );
  });

  it('should fallback to legacy plain-string key format when stored value is not JSON', async () => {
    const params = createParams({
      dbOverrides: {
        getUserKeyValues: jest.fn().mockRejectedValue(
          new Error(
            JSON.stringify({
              type: ErrorTypes.INVALID_USER_KEY,
            }),
          ),
        ),
        getUserKey: jest.fn().mockResolvedValue('legacy-anthropic-key'),
      },
    });

    await initializeAnthropic(params);

    expect(mockGetLLMConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        [AuthKeys.ANTHROPIC_API_KEY]: 'legacy-anthropic-key',
      }),
      expect.any(Object),
    );
  });

  it('should refresh an expired Anthropic subscription credential before use', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          access_token: 'refreshed-access-token',
          refresh_token: 'refreshed-refresh-token',
          expires_in: 28800,
        }),
    });

    const params = createParams({
      dbOverrides: {
        getUserKeyValues: jest.fn().mockResolvedValue({
          authToken: 'expired-access-token',
          apiKey: 'expired-access-token',
          refreshToken: 'refresh-token',
          oauthProvider: 'anthropic',
          oauthType: 'subscription',
          oauthExpiresAt: Date.now() - 60 * 1000,
        }),
      },
    });

    await initializeAnthropic(params);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://platform.claude.com/v1/oauth/token',
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
    expect(mockGetLLMConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        [AuthKeys.ANTHROPIC_API_KEY]: 'refreshed-access-token',
      }),
      expect.objectContaining({
        oauthProvider: 'anthropic',
        oauthType: 'subscription',
      }),
    );
    const updateUserKey = params.db.updateUserKey as jest.Mock;
    expect(updateUserKey).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'anthropic-user',
        name: EModelEndpoint.anthropic,
        expiresAt: null,
      }),
    );
    const persistedValue = JSON.parse(updateUserKey.mock.calls[0][0].value);
    expect(persistedValue).toMatchObject({
      authToken: 'refreshed-access-token',
      apiKey: 'refreshed-access-token',
      refreshToken: 'refreshed-refresh-token',
      oauthProvider: 'anthropic',
      oauthType: 'subscription',
    });
    expect(persistedValue.oauthExpiresAt).toBeGreaterThan(Date.now());
  });

  it('should preserve the current access token when Anthropic refresh fails', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () =>
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Refresh token not found or invalid',
        }),
    });

    const params = createParams({
      dbOverrides: {
        getUserKeyValues: jest.fn().mockResolvedValue({
          authToken: 'still-usable-access-token',
          apiKey: 'still-usable-access-token',
          refreshToken: 'broken-refresh-token',
          oauthProvider: 'anthropic',
          oauthType: 'subscription',
          oauthExpiresAt: Date.now() - 60 * 1000,
        }),
      },
    });

    await initializeAnthropic(params);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockGetLLMConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        [AuthKeys.ANTHROPIC_API_KEY]: 'still-usable-access-token',
      }),
      expect.objectContaining({
        oauthProvider: 'anthropic',
        oauthType: 'subscription',
      }),
    );
    const updateUserKey = params.db.updateUserKey as jest.Mock;
    expect(updateUserKey).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'anthropic-user',
        name: EModelEndpoint.anthropic,
        expiresAt: null,
      }),
    );
    const persistedValue = JSON.parse(updateUserKey.mock.calls[0][0].value);
    expect(persistedValue).toMatchObject({
      authToken: 'still-usable-access-token',
      apiKey: 'still-usable-access-token',
      refreshToken: 'broken-refresh-token',
      oauthProvider: 'anthropic',
      oauthType: 'subscription',
    });
  });
});
