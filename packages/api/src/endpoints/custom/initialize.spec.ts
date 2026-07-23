import { getCustomEndpointConfig } from '~/app/config';
import { getOpenAIConfig } from '~/endpoints/openai/config';
import { initializeCustom } from './initialize';

jest.mock('~/app/config', () => ({
  getCustomEndpointConfig: jest.fn(),
}));

jest.mock('~/endpoints/openai/config', () => ({
  getOpenAIConfig: jest.fn((apiKey, options, endpoint) => ({
    llmConfig: { apiKey, ...options, endpoint },
  })),
}));

jest.mock('~/endpoints/models', () => ({
  fetchModels: jest.fn(),
}));

jest.mock('~/cache', () => ({
  standardCache: jest.fn(() => ({ get: jest.fn() })),
}));

const mockGetCustomEndpointConfig = getCustomEndpointConfig as jest.MockedFunction<
  typeof getCustomEndpointConfig
>;
const mockGetOpenAIConfig = getOpenAIConfig as jest.MockedFunction<typeof getOpenAIConfig>;

describe('initializeCustom user-scoped credentials', () => {
  const req = {
    body: {},
    user: { id: 'synthetic-user' },
    config: { endpoints: {} },
  } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCustomEndpointConfig.mockReturnValue({
      name: 'groq',
      apiKey: 'user_provided',
      baseURL: 'https://api.groq.example/v1',
      models: { fetch: false },
    } as never);
  });

  it('loads a saved user key even when the request has no legacy expiry marker', async () => {
    const getUserKeyValues = jest.fn().mockResolvedValue({
      apiKey: 'saved-synthetic-key',
      baseURL: null,
      headers: null,
    });

    const result = await initializeCustom({
      req,
      endpoint: 'groq',
      model_parameters: { model: 'synthetic-model' },
      db: { getUserKeyValues } as never,
    });

    expect(getUserKeyValues).toHaveBeenCalledWith({
      userId: 'synthetic-user',
      name: 'groq',
    });
    expect(mockGetOpenAIConfig).toHaveBeenCalledWith(
      'saved-synthetic-key',
      expect.objectContaining({ reverseProxyUrl: 'https://api.groq.example/v1' }),
      'groq',
    );
    expect(result).toBeDefined();
  });

  it('fails locally when a user-provided custom credential has not been saved', async () => {
    await expect(
      initializeCustom({
        req,
        endpoint: 'groq',
        model_parameters: { model: 'synthetic-model' },
        db: {
          getUserKeyValues: jest.fn().mockResolvedValue({
            apiKey: null,
            baseURL: null,
            headers: null,
          }),
        } as never,
      }),
    ).rejects.toThrow('no_user_key');

    expect(mockGetOpenAIConfig).not.toHaveBeenCalled();
  });
});
