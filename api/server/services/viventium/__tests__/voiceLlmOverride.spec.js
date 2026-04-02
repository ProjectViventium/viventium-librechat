/* === VIVENTIUM START ===
 * Feature: Voice Chat LLM Override helper tests
 * Purpose: Verify activation gate, safe validation, and fallback behavior.
 * Added: 2026-02-24
 * === VIVENTIUM END === */

const {
  isVoiceCallActive,
  isVoiceModelValid,
  resolveVoiceOverrideAssignment,
  applyVoiceModelOverride,
} = require('../voiceLlmOverride');

describe('voiceLlmOverride', () => {
  test('isVoiceCallActive requires all three voice signals', () => {
    expect(
      isVoiceCallActive({
        body: {
          voiceMode: true,
          viventiumInputMode: 'voice_call',
          viventiumSurface: 'voice',
        },
      }),
    ).toBe(true);

    expect(
      isVoiceCallActive({
        body: { voiceMode: true, viventiumInputMode: 'voice_call', viventiumSurface: 'telegram' },
      }),
    ).toBe(false);
  });

  test('isVoiceModelValid rejects provider not in allowedProviders', () => {
    const req = {
      config: { endpoints: { agents: { allowedProviders: ['openai'] } } },
    };
    const modelsConfig = {
      xai: ['grok-4-1-fast'],
      openai: ['gpt-4o-mini'],
    };

    expect(isVoiceModelValid('grok-4-1-fast', 'xai', req, modelsConfig)).toBe(false);
  });

  test('isVoiceModelValid rejects provider missing from modelsConfig', () => {
    const req = {};
    const modelsConfig = {
      openai: ['gpt-4o-mini'],
    };

    expect(isVoiceModelValid('grok-4-1-fast', 'xai', req, modelsConfig)).toBe(false);
  });

  test('applyVoiceModelOverride keeps main model when override invalid', () => {
    const req = {
      body: {
        voiceMode: true,
        viventiumInputMode: 'voice_call',
        viventiumSurface: 'voice',
      },
      config: { endpoints: { agents: { allowedProviders: ['openai'] } } },
    };
    const modelsConfig = {
      openai: ['gpt-4o-mini'],
    };
    const agent = {
      id: 'agent_1',
      provider: 'openai',
      model: 'gpt-4o-mini',
      model_parameters: { model: 'gpt-4o-mini' },
      voice_llm_provider: 'xai',
      voice_llm_model: 'grok-4-1-fast',
    };

    const updated = applyVoiceModelOverride(agent, req, modelsConfig);
    expect(updated.provider).toBe('openai');
    expect(updated.model).toBe('gpt-4o-mini');
    expect(updated.model_parameters.model).toBe('gpt-4o-mini');
  });

  test('applyVoiceModelOverride swaps model/provider when override valid', () => {
    const originalXaiKey = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = 'test-xai-key';

    try {
      const req = {
        body: {
          voiceMode: true,
          viventiumInputMode: 'voice_call',
          viventiumSurface: 'voice',
        },
        config: { endpoints: { agents: { allowedProviders: ['xai', 'openai'] } } },
      };
      const modelsConfig = {
        xai: ['grok-4-1-fast'],
        openai: ['gpt-4o-mini'],
      };
      const agent = {
        id: 'agent_2',
        provider: 'openai',
        model: 'gpt-4o-mini',
        model_parameters: { model: 'gpt-4o-mini' },
        voice_llm_provider: 'xai',
        voice_llm_model: 'grok-4-1-fast',
      };

      const updated = applyVoiceModelOverride(agent, req, modelsConfig);
      expect(updated.provider).toBe('xai');
      expect(updated.model).toBe('grok-4-1-fast');
      expect(updated.model_parameters.model).toBe('grok-4-1-fast');
    } finally {
      if (originalXaiKey === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = originalXaiKey;
      }
    }
  });

  test('resolveVoiceOverrideAssignment uses the machine fast-voice route when the agent fields are unset', () => {
    const originalXaiKey = process.env.XAI_API_KEY;
    const originalVoiceProvider = process.env.VIVENTIUM_VOICE_FAST_LLM_PROVIDER;
    const originalVoiceModel = process.env.VIVENTIUM_VOICE_FAST_LLM_MODEL;
    process.env.XAI_API_KEY = 'test-xai-key';
    process.env.VIVENTIUM_VOICE_FAST_LLM_PROVIDER = 'xai';
    delete process.env.VIVENTIUM_VOICE_FAST_LLM_MODEL;

    try {
      const assignment = resolveVoiceOverrideAssignment({
        id: 'agent_env',
        provider: 'openAI',
        model: 'gpt-4o-mini',
        model_parameters: { model: 'gpt-4o-mini' },
        voice_llm_provider: null,
        voice_llm_model: null,
      });

      expect(assignment).toEqual({
        provider: 'xai',
        model: 'grok-4-1-fast-non-reasoning',
        source: 'env',
      });
    } finally {
      if (originalXaiKey === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = originalXaiKey;
      }
      if (originalVoiceProvider === undefined) {
        delete process.env.VIVENTIUM_VOICE_FAST_LLM_PROVIDER;
      } else {
        process.env.VIVENTIUM_VOICE_FAST_LLM_PROVIDER = originalVoiceProvider;
      }
      if (originalVoiceModel === undefined) {
        delete process.env.VIVENTIUM_VOICE_FAST_LLM_MODEL;
      } else {
        process.env.VIVENTIUM_VOICE_FAST_LLM_MODEL = originalVoiceModel;
      }
    }
  });

  test('applyVoiceModelOverride keeps main model when alternate provider lacks a server credential', () => {
    const originalXaiKey = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;

    try {
      const req = {
        body: {
          voiceMode: true,
          viventiumInputMode: 'voice_call',
          viventiumSurface: 'voice',
        },
        config: { endpoints: { agents: { allowedProviders: ['xai', 'openai'] } } },
      };
      const modelsConfig = {
        xai: ['grok-4-1-fast'],
        openAI: ['gpt-4o-mini'],
      };
      const agent = {
        id: 'agent_3',
        provider: 'openAI',
        model: 'gpt-4o-mini',
        model_parameters: { model: 'gpt-4o-mini' },
        voice_llm_provider: 'xai',
        voice_llm_model: 'grok-4-1-fast',
      };

      const updated = applyVoiceModelOverride(agent, req, modelsConfig);
      expect(updated.provider).toBe('openAI');
      expect(updated.model).toBe('gpt-4o-mini');
      expect(updated.model_parameters.model).toBe('gpt-4o-mini');
    } finally {
      if (originalXaiKey === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = originalXaiKey;
      }
    }
  });
});
