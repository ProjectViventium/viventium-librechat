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
