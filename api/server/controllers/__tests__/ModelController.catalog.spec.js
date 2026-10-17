/* === VIVENTIUM START === Cached model catalog must retain declared runtime models. === */
const mockGetAppConfig = jest.fn();
jest.mock('~/server/services/Config/app', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));
const mockCache = { get: jest.fn(), set: jest.fn() };
jest.mock('~/cache', () => ({ getLogStores: () => mockCache }));
jest.mock('~/server/services/Config', () => ({
  loadDefaultModels: jest.fn(),
  loadConfigModels: jest.fn(),
}));
const { getModelsConfig, loadModels } = require('../ModelController');
const { isVoiceModelValid } = require('../../services/viventium/voiceLlmOverride');
const { isFallbackModelValid } = require('../../services/viventium/agentLlmFallback');
const req = {
  config: {
    endpoints: {
      agents: {
        allowedProviders: ['glasshive-harness'],
        providerCapabilities: {
          'glasshive-harness': {
            voice_pipeline_llm: true,
            automatic_fallback_target: true,
            models: [{ id: 'direct-xai:grok-4.7' }],
          },
        },
      },
    },
  },
};
test.each([getModelsConfig, loadModels])(
  'current declared models survive cached catalog admission (%#)',
  async (read) => {
    const cached = { 'glasshive-harness': ['codex-cli:gpt-6.1-sol'] };
    mockCache.get.mockResolvedValue(cached);
    const models = await read(req);
    expect(models['glasshive-harness']).toEqual(['codex-cli:gpt-6.1-sol', 'direct-xai:grok-4.7']);
    expect(cached['glasshive-harness']).toEqual(['codex-cli:gpt-6.1-sol']);
    expect(isVoiceModelValid('direct-xai:grok-4.7', 'glasshive-harness', req, models)).toBe(true);
    expect(isFallbackModelValid('direct-xai:grok-4.7', 'glasshive-harness', req, models)).toBe(
      true,
    );
    expect(isVoiceModelValid('direct-xai:invented', 'glasshive-harness', req, models)).toBe(false);
  },
);
/* === VIVENTIUM END === */

test('public models route resolves current config when config middleware was not used', async () => {
  mockCache.get.mockResolvedValue({ 'glasshive-harness': ['codex-cli:gpt-6.1-sol'] });
  mockGetAppConfig.mockResolvedValue(req.config);
  const models = await loadModels({ user: { role: 'USER' } });
  expect(models['glasshive-harness']).toContain('direct-xai:grok-4.7');
  expect(mockGetAppConfig).toHaveBeenCalledWith({ role: 'USER' });
});

/* === VIVENTIUM START === A cached menu must not make failed capability discovery permanent. === */
describe('cached native capability recovery', () => {
  const { loadConfigModels } = require('~/server/services/Config');
  beforeEach(() => {
    mockCache.get.mockResolvedValue({ native: ['configured-primary'] });
    mockGetAppConfig.mockResolvedValue(req.config);
    loadConfigModels.mockReset().mockResolvedValue({});
  });
  test.each([getModelsConfig, loadModels])(
    'cached reader still visits native discovery (%#)',
    async (read) => {
      const result = await read({
        user: { id: 'synthetic-owner', role: 'USER' },
        config: req.config,
      });
      expect(loadConfigModels).toHaveBeenCalledWith(
        expect.objectContaining({ user: expect.objectContaining({ id: 'synthetic-owner' }) }),
        { nativeDiscoveryOnly: true },
      );
      expect(result.native).toEqual(['configured-primary']);
      expect(mockCache.set).not.toHaveBeenCalled();
    },
  );
});
/* === VIVENTIUM END === */

/* === VIVENTIUM START === The ordinary owner path recovers after its first failed request. === */
test('failed discovery followed by cached menu recovery uses actual loader and authenticated fetch owner', async () => {
  const axios = require('axios');
  const { loadDefaultModels, loadConfigModels } = require('~/server/services/Config');
  const actualLoader = jest.requireActual('~/server/services/Config/loadConfigModels');
  const cacheValues = new Map();
  mockCache.get.mockImplementation(async (key) => cacheValues.get(key));
  mockCache.set.mockImplementation(async (key, value) => {
    cacheValues.set(key, value);
  });
  const config = {
    endpoints: {
      agents: { providerCapabilities: { native: { context_protocol: 'main_context_v1' } } },
      custom: [
        {
          name: 'native',
          baseURL: 'https://native-recovery.example/v1',
          apiKey: 'synthetic-key',
          models: { fetch: false, default: ['primary', { name: 'fallback' }] },
        },
      ],
    },
  };
  mockGetAppConfig.mockResolvedValue(config);
  loadDefaultModels.mockResolvedValue({});
  loadConfigModels.mockImplementation(actualLoader);
  const get = jest
    .spyOn(axios, 'get')
    .mockRejectedValueOnce(new Error('synthetic timeout'))
    .mockResolvedValueOnce({
      data: {
        data: [
          { id: 'primary', native_history_admission_v1: { replay_budget_floor_bytes: 250000 } },
          { id: 'fallback', native_history_admission_v1: { replay_budget_floor_bytes: 500000 } },
        ],
      },
    });
  try {
    const request = { user: { id: 'synthetic-owner', role: 'USER' }, config };
    const first = await loadModels(request);
    expect(first.native).toEqual(['primary', 'fallback']);
    expect(cacheValues.size).toBe(1);
    expect(get).toHaveBeenCalledTimes(1);
    const second = await getModelsConfig(request);
    expect(second.native).toEqual(first.native);
    expect(
      await require('@librechat/api').getNativeConversationReplayBudgetForRoutes(
        [
          { provider: 'native', model: 'primary' },
          { provider: 'native', model: 'fallback' },
        ],
        config.endpoints.custom,
      ),
    ).toBe(250000);
    await getModelsConfig(request);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenLastCalledWith(
      'https://native-recovery.example/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer synthetic-key' }),
      }),
    );
  } finally {
    get.mockRestore();
  }
});
/* === VIVENTIUM END === */
