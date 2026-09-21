import type { BaseInitializeParams } from '~/types';
import { initializeCustom } from './initialize';

const mockGetOpenAIConfig = jest.fn((_apiKey: string, options: Record<string, unknown>) => ({
  llmConfig: { ...(options.modelOptions as Record<string, unknown>) },
  configOptions: {},
}));
const mockGetCustomEndpointConfig = jest.fn((..._args: unknown[]): Record<string, unknown> => ({
  apiKey: 'synthetic-key',
  baseURL: 'http://127.0.0.1:8766/v1',
}));

jest.mock('~/endpoints/openai/config', () => ({
  getOpenAIConfig: (...args: unknown[]) => mockGetOpenAIConfig(...args),
}));

jest.mock('~/app/config', () => ({
  getCustomEndpointConfig: (...args: unknown[]) => mockGetCustomEndpointConfig(...args),
}));

jest.mock('~/cache', () => ({
  standardCache: jest.fn(() => ({ get: jest.fn() })),
}));

describe('initializeCustom', () => {
  const req = {
    body: {},
    user: { id: 'synthetic-user' },
    config: { endpoints: {} },
  } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCustomEndpointConfig.mockReturnValue({
      apiKey: 'synthetic-key',
      baseURL: 'http://127.0.0.1:8766/v1',
    });
  });

  it('loads a saved user key even when the request has no legacy expiry marker', async () => {
    mockGetCustomEndpointConfig.mockReturnValue({
      name: 'groq',
      apiKey: 'user_provided',
      baseURL: 'https://api.groq.example/v1',
      models: { fetch: false },
    });
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
    mockGetCustomEndpointConfig.mockReturnValue({
      name: 'groq',
      apiKey: 'user_provided',
      baseURL: 'https://api.groq.example/v1',
      models: { fetch: false },
    });

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

  it('keeps the native request receipt callback request-scoped until inference', async () => {
    const receiptSink = jest.fn();
    const params = {
      req: {
        config: {},
        body: {},
        user: { id: 'user-synthetic' },
        _viventiumRecordNativeProviderRequestAccepted: receiptSink,
      },
      endpoint: 'glasshive-harness',
      model_parameters: { model: 'synthetic-model' },
      db: {},
    } as unknown as BaseInitializeParams;

    await initializeCustom(params);
    const options = mockGetOpenAIConfig.mock.calls[0]?.[1] as {
      nativeProviderRequestAccepted?: (value: unknown) => void;
    };
    const receipt = {
      provider: 'glasshive',
      model: 'synthetic-model',
      status: 200,
      authorityReceipt: { protocol: 'glasshive.native_provider_authority_receipt.v1' },
    };
    options.nativeProviderRequestAccepted?.(receipt);

    expect(options.nativeProviderRequestAccepted).toEqual(expect.any(Function));
    expect(receiptSink).toHaveBeenCalledWith(receipt);
  });
});
