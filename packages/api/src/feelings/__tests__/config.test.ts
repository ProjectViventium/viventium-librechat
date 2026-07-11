import { logger } from '@librechat/data-schemas';
import { resolveFeelingsRuntimeConfig } from '../config';

describe('Feelings runtime config', () => {
  it('defaults to all agents and the approved GPT-5.6 Fast reaction route', () => {
    const config = resolveFeelingsRuntimeConfig({});

    expect(config.available).toBe(true);
    expect(config.defaultEnabled).toBe(false);
    expect(config.agentScope).toBe('all_agents');
    expect(config.reaction).toMatchObject({
      activationMode: 'always',
      provider: 'openai',
      model: 'gpt-5.6-terra',
      useResponsesApi: true,
      reasoningEffort: 'none',
      serviceTier: 'priority',
      timeoutMs: 15000,
      fallbackProvider: 'anthropic',
      fallbackModel: 'claude-opus-4-8',
      activationModel: 'qwen/qwen3.6-27b',
    });
  });

  it('accepts explicit env overrides and rejects invalid values to defaults', () => {
    const config = resolveFeelingsRuntimeConfig({
      VIVENTIUM_FEELINGS_AVAILABLE: 'false',
      VIVENTIUM_FEELINGS_DEFAULT_ENABLED: 'true',
      VIVENTIUM_FEELINGS_AGENT_SCOPE: 'conscious_agent',
      VIVENTIUM_FEELINGS_REACTION_ACTIVATION_MODE: 'classified',
      VIVENTIUM_FEELINGS_REACTION_MODEL: 'gpt-5.6-sol',
      VIVENTIUM_FEELINGS_REACTION_REASONING_EFFORT: 'low',
      VIVENTIUM_FEELINGS_REACTION_SERVICE_TIER: 'default',
      VIVENTIUM_FEELINGS_REACTION_FALLBACK_PROVIDER: 'xai',
      VIVENTIUM_FEELINGS_REACTION_FALLBACK_MODEL: 'grok-4.20-non-reasoning',
    });

    expect(config.available).toBe(false);
    expect(config.defaultEnabled).toBe(true);
    expect(config.agentScope).toBe('conscious_agent');
    expect(config.reaction.activationMode).toBe('classified');
    expect(config.reaction.model).toBe('gpt-5.6-sol');
    expect(config.reaction.reasoningEffort).toBe('low');
    expect(config.reaction.serviceTier).toBe('default');
    expect(config.reaction.fallbackProvider).toBe('xai');
    expect(config.reaction.fallbackModel).toBe('grok-4.20-non-reasoning');
  });

  it('warns without raw config when malformed bands JSON falls back to defaults', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const config = resolveFeelingsRuntimeConfig({
      VIVENTIUM_FEELINGS_BANDS_JSON: '{not-json',
    });

    expect(config.bands.mood.baseline).toBe(58);
    expect(warn).toHaveBeenCalledWith('[VIVENTIUM][Feelings]', {
      event: 'feelings.config.invalid_bands_json',
      errorClass: 'invalid_json',
      fallback: 'defaults',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('{not-json');
    warn.mockRestore();
  });
});
