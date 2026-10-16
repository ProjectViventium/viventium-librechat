import axios from 'axios';
import { EModelEndpoint, defaultModels } from 'librechat-data-provider';
import {
  fetchModels,
  ensureNativeConversationModelCatalog,
  getNativeConversationReplayBudget,
  getNativeConversationReplayBudgetForRoutes,
  nativeConversationHistoryFits,
  nativeConversationContextBudget,
  nativeHistoryAttachmentContextBytes,
  splitAndTrim,
  getOpenAIModels,
  getGoogleModels,
  getBedrockModels,
  getAnthropicModels,
} from './models';

jest.mock('axios');

jest.mock('~/cache', () => ({
  standardCache: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue(true),
  })),
}));

jest.mock('~/utils', () => {
  const originalUtils = jest.requireActual('~/utils');
  return {
    ...originalUtils,
    processModelData: jest.fn((...args) => originalUtils.processModelData(...args)),
    logAxiosError: jest.fn(),
    resolveHeaders: jest.fn((options) => options?.headers || {}),
  };
});

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const { logAxiosError, resolveHeaders } = jest.requireMock('~/utils');

mockedAxios.get.mockResolvedValue({
  data: {
    data: [{ id: 'model-1' }, { id: 'model-2' }],
  },
});

describe('fetchModels', () => {
  it('fetches models successfully from the API', async () => {
    const models = await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
    });

    expect(models).toEqual(['model-1', 'model-2']);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('https://api.test.com/models'),
      expect.any(Object),
    );
  });

  it('adds the user ID to the models query when option and ID are passed', async () => {
    const models = await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com',
      userIdQuery: true,
      name: 'TestAPI',
    });

    expect(models).toEqual(['model-1', 'model-2']);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('https://api.test.com/models?user=user123'),
      expect.any(Object),
    );
  });

  it('should pass custom headers to the API request', async () => {
    const customHeaders = {
      'X-Custom-Header': 'custom-value',
      'X-API-Version': 'v2',
    };

    await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
      headers: customHeaders,
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('https://api.test.com/models'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Custom-Header': 'custom-value',
          'X-API-Version': 'v2',
          Authorization: 'Bearer testApiKey',
        }),
      }),
    );
  });

  it('should handle null headers gracefully', async () => {
    await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
      headers: null,
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('https://api.test.com/models'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer testApiKey',
        }),
      }),
    );
  });

  it('should handle undefined headers gracefully', async () => {
    await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
      headers: undefined,
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('https://api.test.com/models'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer testApiKey',
        }),
      }),
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });
});

describe('fetchModels with createTokenConfig true', () => {
  const data = {
    data: [
      {
        id: 'model-1',
        pricing: {
          prompt: '0.002',
          completion: '0.001',
        },
        context_length: 1024,
      },
      {
        id: 'model-2',
        pricing: {
          prompt: '0.003',
          completion: '0.0015',
        },
        context_length: 2048,
      },
    ],
  };

  beforeEach(() => {
    mockedAxios.get.mockResolvedValue({ data });
  });

  it('creates and stores token configuration if createTokenConfig is true', async () => {
    await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com',
      createTokenConfig: true,
    });

    const { processModelData } = jest.requireMock('~/utils');
    expect(processModelData).toHaveBeenCalled();
    expect(processModelData).toHaveBeenCalledWith(data);
  });
});

describe('getOpenAIModels', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    mockedAxios.get.mockRejectedValue(new Error('Network error'));
  });

  afterEach(() => {
    process.env = originalEnv;
    mockedAxios.get.mockReset();
  });

  it('returns default models when no environment configurations are provided (and fetch fails)', async () => {
    const models = await getOpenAIModels({ user: 'user456' });
    expect(models).toContain('gpt-4');
    // === VIVENTIUM START ===
    // Regression: GPT-5.6 must remain available when live model discovery is unavailable.
    expect(models).toEqual(
      expect.arrayContaining(['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']),
    );
    // === VIVENTIUM END ===
  });

  it('returns `AZURE_OPENAI_MODELS` with `azure` flag (and fetch fails)', async () => {
    process.env.AZURE_OPENAI_MODELS = 'azure-model,azure-model-2';
    const models = await getOpenAIModels({ azure: true });
    expect(models).toEqual(expect.arrayContaining(['azure-model', 'azure-model-2']));
  });

  it('returns `OPENAI_MODELS` with no flags (and fetch fails)', async () => {
    process.env.OPENAI_MODELS = 'openai-model,openai-model-2';
    const models = await getOpenAIModels({});
    expect(models).toEqual(expect.arrayContaining(['openai-model', 'openai-model-2']));
  });

  // === VIVENTIUM START ===
  // Regression: a configured user-provided key is not a ready credential for provider egress.
  it('returns defaults without provider egress when the OpenAI key is user-provided', async () => {
    process.env.OPENAI_API_KEY = 'user_provided';

    const models = await getOpenAIModels({ user: 'new-user' });

    expect(models).toContain('gpt-4');
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
  // === VIVENTIUM END ===

  it('utilizes proxy configuration when PROXY is set', async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [],
      },
    });
    process.env.PROXY = 'http://localhost:8888';
    process.env.OPENAI_API_KEY = 'mockedApiKey';
    await getOpenAIModels({ user: 'user456' });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        httpsAgent: expect.anything(),
      }),
    );
  });
});

describe('getOpenAIModels sorting behavior', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.OPENAI_API_KEY = 'mockedApiKey';
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          { id: 'gpt-3.5-turbo-instruct-0914' },
          { id: 'gpt-3.5-turbo-instruct' },
          { id: 'gpt-3.5-turbo' },
          { id: 'gpt-4-0314' },
          { id: 'gpt-4-turbo-preview' },
        ],
      },
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  it('ensures instruct models are listed last', async () => {
    const models = await getOpenAIModels({ user: 'user456' });

    expect(models[models.length - 1]).toMatch(/instruct/);

    const instructIndexes = models
      .map((model, index) => (model.includes('instruct') ? index : -1))
      .filter((index) => index !== -1);
    const nonInstructIndexes = models
      .map((model, index) => (!model.includes('instruct') ? index : -1))
      .filter((index) => index !== -1);

    expect(Math.max(...nonInstructIndexes)).toBeLessThan(Math.min(...instructIndexes));

    const expectedOrder = [
      'gpt-3.5-turbo',
      'gpt-4-0314',
      'gpt-4-turbo-preview',
      'gpt-3.5-turbo-instruct-0914',
      'gpt-3.5-turbo-instruct',
    ];
    expect(models).toEqual(expectedOrder);
  });
});

describe('fetchModels with Ollama specific logic', () => {
  const mockOllamaData = {
    data: {
      models: [{ name: 'Ollama-Base' }, { name: 'Ollama-Advanced' }],
    },
  };

  beforeEach(() => {
    mockedAxios.get.mockResolvedValue(mockOllamaData);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should fetch Ollama models when name starts with "ollama"', async () => {
    const models = await fetchModels({
      user: 'user789',
      apiKey: 'testApiKey',
      baseURL: 'https://api.ollama.test.com',
      name: 'OllamaAPI',
    });

    expect(models).toEqual(['Ollama-Base', 'Ollama-Advanced']);
    expect(mockedAxios.get).toHaveBeenCalledWith('https://api.ollama.test.com/api/tags', {
      headers: {},
      timeout: 5000,
    });
  });

  it('should pass headers and user object to Ollama fetchModels', async () => {
    const customHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer custom-token',
    };
    const userObject = {
      id: 'user789',
      email: 'test@example.com',
    };

    (resolveHeaders as jest.Mock).mockReturnValueOnce(customHeaders);

    const models = await fetchModels({
      user: 'user789',
      apiKey: 'testApiKey',
      baseURL: 'https://api.ollama.test.com',
      name: 'ollama',
      headers: customHeaders,
      userObject,
    });

    expect(models).toEqual(['Ollama-Base', 'Ollama-Advanced']);
    expect(resolveHeaders).toHaveBeenCalledWith({
      headers: customHeaders,
      user: userObject,
    });
    expect(mockedAxios.get).toHaveBeenCalledWith('https://api.ollama.test.com/api/tags', {
      headers: customHeaders,
      timeout: 5000,
    });
  });

  it('should handle errors gracefully when fetching Ollama models fails and fallback to OpenAI-compatible fetch', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('Ollama API error'));
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        data: [{ id: 'fallback-model-1' }, { id: 'fallback-model-2' }],
      },
    });

    const models = await fetchModels({
      user: 'user789',
      apiKey: 'testApiKey',
      baseURL: 'https://api.ollama.test.com',
      name: 'OllamaAPI',
    });

    expect(models).toEqual(['fallback-model-1', 'fallback-model-2']);
    expect(logAxiosError).toHaveBeenCalledWith({
      message:
        'Failed to fetch models from Ollama API. Attempting to fetch via OpenAI-compatible endpoint.',
      error: expect.any(Error),
    });
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it('should return an empty array if no baseURL is provided', async () => {
    const models = await fetchModels({
      user: 'user789',
      apiKey: 'testApiKey',
      name: 'OllamaAPI',
    });
    expect(models).toEqual([]);
  });

  it('should not fetch Ollama models if the name does not start with "ollama"', async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [{ id: 'model-1' }, { id: 'model-2' }],
      },
    });

    const models = await fetchModels({
      user: 'user789',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
    });

    expect(models).toEqual(['model-1', 'model-2']);
    expect(mockedAxios.get).toHaveBeenCalledWith('https://api.test.com/models', expect.any(Object));
  });
});

describe('fetchModels URL construction with trailing slashes', () => {
  beforeEach(() => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [{ id: 'model-1' }, { id: 'model-2' }],
      },
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should not create double slashes when baseURL has a trailing slash', async () => {
    await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com/v1/',
      name: 'TestAPI',
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.test.com/v1/models',
      expect.any(Object),
    );
  });

  it('should handle baseURL without trailing slash normally', async () => {
    await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com/v1',
      name: 'TestAPI',
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.test.com/v1/models',
      expect.any(Object),
    );
  });

  it('should handle baseURL with multiple trailing slashes', async () => {
    await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com/v1///',
      name: 'TestAPI',
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.test.com/v1/models',
      expect.any(Object),
    );
  });

  it('should correctly append query params after stripping trailing slashes', async () => {
    await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com/v1/',
      name: 'TestAPI',
      userIdQuery: true,
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.test.com/v1/models?user=user123',
      expect.any(Object),
    );
  });
});

describe('splitAndTrim', () => {
  it('should split a string by commas and trim each value', () => {
    const input = ' model1, model2 , model3,model4 ';
    const expected = ['model1', 'model2', 'model3', 'model4'];
    expect(splitAndTrim(input)).toEqual(expected);
  });

  it('should return an empty array for empty input', () => {
    expect(splitAndTrim('')).toEqual([]);
  });

  it('should return an empty array for null input', () => {
    expect(splitAndTrim(null)).toEqual([]);
  });

  it('should return an empty array for undefined input', () => {
    expect(splitAndTrim(undefined)).toEqual([]);
  });

  it('should filter out empty values after trimming', () => {
    const input = 'model1,,  ,model2,';
    const expected = ['model1', 'model2'];
    expect(splitAndTrim(input)).toEqual(expected);
  });
});

describe('getAnthropicModels', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  it('returns default models when ANTHROPIC_MODELS is not set', async () => {
    delete process.env.ANTHROPIC_MODELS;
    // === VIVENTIUM START ===
    // Feature: Test stability (ignore developer env)
    // Purpose: Ensure we don't hit the "fetch from API" path when an admin key is present in the
    // developer's environment (axios is mocked globally in this file).
    // Added: 2026-02-07
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_REVERSE_PROXY;
    // === VIVENTIUM END ===
    const models = await getAnthropicModels();
    expect(models).toEqual(defaultModels[EModelEndpoint.anthropic]);
  });

  it('returns models from ANTHROPIC_MODELS when set', async () => {
    process.env.ANTHROPIC_MODELS = 'claude-1, claude-2 ';
    const models = await getAnthropicModels();
    expect(models).toEqual(['claude-1', 'claude-2']);
  });

  it('should use Anthropic-specific headers when fetching models', async () => {
    delete process.env.ANTHROPIC_MODELS;
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

    mockedAxios.get.mockResolvedValue({
      data: {
        data: [{ id: 'claude-3' }, { id: 'claude-4' }],
      },
    });

    await fetchModels({
      user: 'user123',
      apiKey: 'test-anthropic-key',
      baseURL: 'https://api.anthropic.com/v1',
      name: EModelEndpoint.anthropic,
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {
          'x-api-key': 'test-anthropic-key',
          'anthropic-version': expect.any(String),
        },
      }),
    );
  });

  it('should pass custom headers for Anthropic endpoint', async () => {
    const customHeaders = {
      'X-Custom-Header': 'custom-value',
    };

    mockedAxios.get.mockResolvedValue({
      data: {
        data: [{ id: 'claude-3' }],
      },
    });

    await fetchModels({
      user: 'user123',
      apiKey: 'test-anthropic-key',
      baseURL: 'https://api.anthropic.com/v1',
      name: EModelEndpoint.anthropic,
      headers: customHeaders,
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {
          'x-api-key': 'test-anthropic-key',
          'anthropic-version': expect.any(String),
        },
      }),
    );
  });
});

describe('getGoogleModels', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns default models when GOOGLE_MODELS is not set', () => {
    delete process.env.GOOGLE_MODELS;
    const models = getGoogleModels();
    expect(models).toEqual(defaultModels[EModelEndpoint.google]);
  });

  it('returns models from GOOGLE_MODELS when set', () => {
    process.env.GOOGLE_MODELS = 'gemini-pro, bard ';
    const models = getGoogleModels();
    expect(models).toEqual(['gemini-pro', 'bard']);
  });
});

describe('getBedrockModels', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns default models when BEDROCK_AWS_MODELS is not set', () => {
    delete process.env.BEDROCK_AWS_MODELS;
    const models = getBedrockModels();
    expect(models).toEqual(defaultModels[EModelEndpoint.bedrock]);
  });

  it('returns models from BEDROCK_AWS_MODELS when set', () => {
    process.env.BEDROCK_AWS_MODELS = 'anthropic.claude-v2, ai21.j2-ultra ';
    const models = getBedrockModels();
    expect(models).toEqual(['anthropic.claude-v2', 'ai21.j2-ultra']);
  });
});


describe('cached native history admission floor', () => {
  const { standardCache } = jest.requireMock('~/cache');
  const cache = standardCache.mock.results[0].value;
  it('retains only valid native floors from the authenticated existing catalog fetch', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [
      { id: 'large', native_history_admission_v1: { replay_budget_floor_bytes: 196608 } },
      { id: 'small', native_history_admission_v1: { replay_budget_floor_bytes: 32768 } },
      { id: 'invalid', native_history_admission_v1: { replay_budget_floor_bytes: '900000' } },
    ] } });
    await fetchModels({ apiKey: 'synthetic', name: 'native', baseURL: 'https://native.example/v1' });
    const [key, value] = cache.set.mock.calls.at(-1);
    expect(key).toMatch(/^native-history-admission:[a-f0-9]{64}$/);
    expect(value).toEqual({ large: 196608, small: 32768 });
    expect(key).not.toContain('synthetic');
    cache.get.mockImplementation(async (requested: string) => requested === key ? value : undefined);
    mockedAxios.get.mockClear();
    expect(await getNativeConversationReplayBudgetForRoutes([
      { provider: 'native', model: 'large' }, { provider: 'native', model: 'small' },
    ], [{ name: 'native', baseURL: 'https://native.example/v1/' }])).toBe(32768);
    expect(await getNativeConversationReplayBudget('native', 'https://other.example/v1', 'large')).toBeNull();
    expect(await getNativeConversationReplayBudgetForRoutes([
      { provider: 'native', model: 'unknown' },
    ], [{ name: 'native', baseURL: 'https://native.example/v1' }])).toBeNull();
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
  it('uses the configured primary/fallback minimum without a second host clamp or network call', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [
      { id: 'codex-cli:gpt-6.1-sol', native_history_admission_v1: { replay_budget_floor_bytes: 237500 } },
      { id: 'claude-code:claude-opus-5-5', native_history_admission_v1: { replay_budget_floor_bytes: 500000 } },
      { id: 'operator-capped', native_history_admission_v1: { replay_budget_floor_bytes: 65536 } },
    ] } });
    await fetchModels({ apiKey: 'synthetic', name: 'native', baseURL: 'https://native.example/v1' });
    const [key, value] = cache.set.mock.calls.at(-1);
    cache.get.mockImplementation(async (requested: string) => requested === key ? value : undefined);
    mockedAxios.get.mockClear();
    const endpoints = [{ name: 'native', baseURL: 'https://native.example/v1' }];
    const routes = [{ provider: 'native', model: 'codex-cli:gpt-6.1-sol' },
      { provider: 'native', model: 'claude-code:claude-opus-5-5' }];
    expect(await getNativeConversationReplayBudgetForRoutes(routes, endpoints)).toBe(237500);
    expect(await getNativeConversationReplayBudgetForRoutes([
      ...routes, { provider: 'native', model: 'operator-capped' },
    ], endpoints)).toBe(65536);
    expect(await getNativeConversationReplayBudgetForRoutes([
      ...routes, { provider: 'native', model: 'unknown' },
    ], endpoints)).toBeNull();
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
  it('counts replay data while excluding separately configured native static instructions', () => {
    const visible = [{ role: 'user', content: 'Original words.'.repeat(5000) }];
    const messages = [{ role: 'system', content: 'Static native configuration.'.repeat(30000) }, ...visible];
    expect(nativeConversationHistoryFits(messages, 196608, 94000, 1000)).toBe(true);
    expect(nativeConversationHistoryFits(messages, 32768, 94000, 1000)).toBe(false);
    expect(nativeConversationHistoryFits([{ role: 'user', content: 'x'.repeat(253319) }], 196608, 0)).toBe(false);
    expect(nativeConversationHistoryFits([{ role: 'user', content: 'x'.repeat(173280) }], 196608, 94000)).toBe(false);
    expect(nativeConversationHistoryFits(messages, NaN, 0)).toBe(false);
    expect(nativeConversationHistoryFits(messages, 196608, -1)).toBe(false);
  });
});


test('native upload allowance counts metadata and duplicate paths without copying extracted document text', () => {
  const source = { file_id: '1'.repeat(36), filename: 'A long drawing.svg', type: 'image/svg+xml',
    source: 'local', bytes: 123, text: 'Private extracted body.'.repeat(10000) };
  const bytes = nativeHistoryAttachmentContextBytes([source]);
  expect(bytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify({ file_id: source.file_id,
    filename: source.filename, type: source.type, source: source.source, bytes: source.bytes })));
  expect(bytes).toBeLessThan(2000);
  expect(nativeHistoryAttachmentContextBytes([])).toBe(0);
});


test('native charged-field sizing leaves non-rendered original tool/display evidence unchanged', () => {
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'Original answer.' },
    { type: 'tool_call', tool_call: { id: 'call-1', args: { full: 'evidence'.repeat(100000) }, output: 'Whole result.' } }],
    tool_calls: [{ id: 'call-1', function: { name: 'tool', arguments: 'evidence'.repeat(100000) } }] }];
  const before = JSON.stringify(messages);
  expect(nativeConversationHistoryFits(messages, 32768, 1000)).toBe(true);
  expect(JSON.stringify(messages)).toBe(before);
});


test.each(['image_url', 'input_image', 'file', 'input_file'])(
  'native %s admission charges its rendered label, preserving the original media bytes', type => {
    const source = [{ role: 'user', content: [{ type, name: 'A \"quoted\" é label',
      image_url: { url: 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(300000)]).toString('base64') },
      file_data: 'b'.repeat(300000) }] }];
    const original = JSON.stringify(source);
    expect(nativeConversationHistoryFits(source, 196608, 131072)).toBe(true);
    expect(JSON.stringify(source)).toBe(original);
    source[0].content[0].name = 'z'.repeat(70000);
    expect(nativeConversationHistoryFits(source, 196608, 131072)).toBe(false);
  },
);

test.each([
  { type: 'image_url' }, { type: 'input_image', name: '', filename: 'Fallback name' },
  { type: 'file', name: 0, filename: 'Zero uses fallback' },
  { type: 'input_file', name: false, filename: 'False uses fallback' },
])('native media label fallback matches the native reader (%j)', part => {
  expect(nativeConversationHistoryFits([{ role: 'user', content: [part] }], 196608, 131072)).toBe(true);
});

test.each([7, true, {}, [], ['label']])('non-string native media label %j cannot claim a capacity proof', name => {
  expect(nativeConversationHistoryFits([{ role: 'user', content: [{ type: 'file', name }] }],
    196608, 131072)).toBe(false);
});


describe('native replay media admission retains existing media capacity guards', () => {
  const image = (bytes = 16) => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,' +
    Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(bytes - 8)]).toString('base64') } });
  const fits = (parts: unknown[]) => nativeConversationHistoryFits([{ role: 'user', content: parts }], 196608, 131072);
  test('two valid historical images fit, while25 retain foreground reconciliation', () => {
    expect(fits([image(), image()])).toBe(true);
    expect(fits(Array.from({ length: 25 }, () => image()))).toBe(false);
  });
  test('the existing per-image and total native media limits still bound a positive fit', () => {
    expect(fits([image(8 * 1024 * 1024)])).toBe(true);
    expect(fits([image(8 * 1024 * 1024 + 1)])).toBe(false);
    expect(fits(Array.from({ length: 4 }, () => image(8 * 1024 * 1024)))).toBe(true);
    expect(fits([...Array.from({ length: 4 }, () => image(8 * 1024 * 1024)), image()])).toBe(false);
  });
  test.each(['data:image/png;base64,broken', 'data:image/png;base64,YQ==',
    'data:image/unknown;base64,iVBORw0KGgo=', 'data:image/png,notbase64'])('invalid native inline media cannot claim fit (%s)', url => {
    expect(fits([{ type: 'image_url', image_url: { url } }])).toBe(false);
  });
  test('remote references and non-image file blocks retain native owner semantics', () => {
    expect(fits([{ type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } },
      { type: 'file', file_data: 'Original bytes unchanged.' }])).toBe(true);
  });
});

/* === VIVENTIUM START === One native aggregate owns history and dynamic context allocation. === */
describe('native context allocation from retained source cost', () => {
  const messages = [{ role: 'user', content: 'é🙂 retained source\n'.repeat(300) },
    { role: 'assistant', content: 'Quoted evidence must remain intact.' }];
  test('reserves exact UTF-8, JSON escaping, headings and attachment metadata before allocating context', () => {
    const source = JSON.stringify(messages);
    const budget = 196608;
    const expected = budget - Buffer.byteLength(source) - messages.length * 128 - 4096 - 15267;
    const remaining = nativeConversationContextBudget(messages, budget, 15267);
    expect(remaining).toBe(expected);
    expect(remaining).toBeGreaterThan(128 * 1024);
    expect(nativeConversationHistoryFits(messages, budget, expected, 15267)).toBe(true);
    expect(nativeConversationHistoryFits(messages, budget, expected + 1, 15267)).toBe(false);
    expect(JSON.stringify(messages)).toBe(source);
  });
  test('the native model floor carries a complete long-conversation capsule that the old clamp rejected', () => {
    // Synthetic byte sizes: protected memory + full recent turns + required context peers.
    const retained = [{ role: 'user', content: 'é🙂'.repeat(4000) }];
    const source = JSON.stringify(retained);
    const metadataBytes = 42158 - Buffer.byteLength(source) - retained.length * 128 - 4096;
    const completeContext = 'é🙂'.repeat(25000) + 'x'.repeat(5688);
    const contextBytes = Buffer.byteLength(completeContext);
    expect(contextBytes).toBe(155688);
    expect(nativeConversationContextBudget(retained, 196608, metadataBytes)).toBe(154450);
    expect(nativeConversationContextBudget(retained, 237500, metadataBytes)).toBe(195342);
    expect(nativeConversationHistoryFits(retained, 196608, contextBytes, metadataBytes)).toBe(false);
    expect(nativeConversationHistoryFits(retained, 237500, contextBytes, metadataBytes)).toBe(true);
    expect(nativeConversationHistoryFits(retained, 65536, contextBytes, metadataBytes)).toBe(false);
    expect(nativeConversationHistoryFits(retained, NaN, contextBytes, metadataBytes)).toBe(false);
    expect(JSON.stringify(retained)).toBe(source);
    expect(Buffer.byteLength(completeContext)).toBe(contextBytes);
  });
  test('unknown, invalid media and oversized source do not produce a positive allocation', () => {
    expect(nativeConversationContextBudget(messages, NaN)).toBeNull();
    expect(nativeConversationContextBudget(messages, 196608, -1)).toBeNull();
    expect(nativeConversationContextBudget([{ role: 'user', content: [{ type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' } }] }], 196608)).toBeNull();
    expect(nativeConversationContextBudget(messages, 1)).toBeLessThan(0);
    expect(nativeConversationHistoryFits(messages, 1, 0)).toBe(false);
  });
});
/* === VIVENTIUM END === */

/* === VIVENTIUM START === Failed native discovery cannot poison a cached menu. === */
describe('native catalog recovery', () => {
  const params = {
    name: 'native',
    baseURL: 'https://native.example/v1',
    apiKey: 'synthetic-key',
    user: 'synthetic-owner',
  };
  const catalogCache = jest.requireMock('~/cache').standardCache.mock.results[0].value;
  beforeEach(() => {
    catalogCache.get.mockReset().mockResolvedValue(undefined);
    catalogCache.set.mockReset().mockResolvedValue(true);
    mockedAxios.get.mockReset();
  });
  test('a timeout remains retryable, then a declared floor is reused without another request', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('synthetic timeout'));
    await ensureNativeConversationModelCatalog(params);
    expect(catalogCache.set).not.toHaveBeenCalled();
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        data: [
          { id: 'primary', native_history_admission_v1: { replay_budget_floor_bytes: 250000 } },
        ],
      },
    });
    await ensureNativeConversationModelCatalog(params);
    expect(catalogCache.set).toHaveBeenCalledWith(expect.any(String), { primary: 250000 });
    catalogCache.get.mockResolvedValue({ primary: 250000 });
    await ensureNativeConversationModelCatalog(params);
    expect(await getNativeConversationReplayBudget('native', params.baseURL, 'primary')).toBe(
      250000,
    );
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });
  test('a malformed successful response does not certify discovery', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { error: 'synthetic malformed response' } });
    await ensureNativeConversationModelCatalog(params);
    expect(catalogCache.set).not.toHaveBeenCalled();
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [] } });
    await ensureNativeConversationModelCatalog(params);
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    expect(catalogCache.set).toHaveBeenCalledWith(expect.any(String), {});
  });
  test('a successful catalog without a floor remains unknown and does not fetch forever', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'primary' }] } });
    await ensureNativeConversationModelCatalog(params);
    expect(catalogCache.set).toHaveBeenCalledWith(expect.any(String), {});
    catalogCache.get.mockResolvedValue({});
    await ensureNativeConversationModelCatalog(params);
    expect(await getNativeConversationReplayBudget('native', params.baseURL, 'primary')).toBeNull();
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });
  test('different authenticated requests do not share pending discovery', async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [] } });
    await Promise.all([
      ensureNativeConversationModelCatalog(params),
      ensureNativeConversationModelCatalog({ ...params, apiKey: 'other-synthetic-key' }),
    ]);
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });
  test('concurrent missing discovery shares one exact authenticated request and clears after failure', async () => {
    let release!: (value: { data: { data: Array<{ id: string }> } }) => void;
    mockedAxios.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = ensureNativeConversationModelCatalog(params);
    const second = ensureNativeConversationModelCatalog({ ...params });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    release({ data: { data: [] } });
    await Promise.all([first, second]);
    catalogCache.get.mockResolvedValue(undefined);
    mockedAxios.get.mockRejectedValueOnce(new Error('synthetic timeout'));
    await ensureNativeConversationModelCatalog(params);
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });
});
/* === VIVENTIUM END === */
