/* === VIVENTIUM START ===
 * Feature: Voice Chat LLM Override helper tests
 * Purpose: Verify activation gate, safe validation, and fallback behavior.
 * Added: 2026-02-24
 * === VIVENTIUM END === */

const {
  isVoiceCallActive,
  isVoiceModelValid,
  resolveVoiceOverrideAssignment,
  resolveVoiceModelParameters,
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
        model_parameters: { model: 'gpt-4o-mini', reasoning_effort: 'medium' },
        voice_llm_provider: 'xai',
        voice_llm_model: 'grok-4-1-fast',
        voice_llm_model_parameters: { temperature: 0.2, max_output_tokens: 144 },
      };

      const updated = applyVoiceModelOverride(agent, req, modelsConfig);
      expect(updated.provider).toBe('xai');
      expect(updated.model).toBe('grok-4-1-fast');
      expect(updated.model_parameters.model).toBe('grok-4-1-fast');
      expect(updated.model_parameters.reasoning_effort).toBe('medium');
      expect(updated.model_parameters.temperature).toBe(0.2);
      expect(updated.model_parameters.max_output_tokens).toBe(144);
    } finally {
      if (originalXaiKey === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = originalXaiKey;
      }
    }
  });

  test('resolveVoiceOverrideAssignment ignores legacy machine fast-voice env when the agent fields are unset', () => {
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

      expect(assignment).toBeNull();
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

  test('applyVoiceModelOverride keeps the explicit agent voice-call LLM when legacy env disagrees', () => {
    const originalXaiKey = process.env.XAI_API_KEY;
    const originalOpenAIKey = process.env.OPENAI_API_KEY;
    const originalVoiceProvider = process.env.VIVENTIUM_VOICE_FAST_LLM_PROVIDER;
    const originalVoiceModel = process.env.VIVENTIUM_VOICE_FAST_LLM_MODEL;
    process.env.XAI_API_KEY = 'test-xai-key';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.VIVENTIUM_VOICE_FAST_LLM_PROVIDER = 'xai';
    process.env.VIVENTIUM_VOICE_FAST_LLM_MODEL = 'grok-4-1-fast';

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
        openAI: ['gpt-4o-mini', 'gpt-5.4'],
      };
      const agent = {
        id: 'agent_explicit',
        provider: 'openAI',
        model: 'gpt-4o-mini',
        model_parameters: { model: 'gpt-4o-mini' },
        voice_llm_provider: 'openAI',
        voice_llm_model: 'gpt-5.4',
      };

      const updated = applyVoiceModelOverride(agent, req, modelsConfig);
      expect(updated.provider).toBe('openAI');
      expect(updated.model).toBe('gpt-5.4');
      expect(updated.model_parameters.model).toBe('gpt-5.4');
    } finally {
      if (originalXaiKey === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = originalXaiKey;
      }
      if (originalOpenAIKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAIKey;
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

  test('resolveVoiceModelParameters overlays the voice parameter bag without mutating the main one', () => {
    const mainParameters = { model: 'gpt-4o-mini', reasoning_effort: 'high' };
    const resolved = resolveVoiceModelParameters(
      {
        model_parameters: mainParameters,
        voice_llm_model: 'claude-haiku-4-5',
        voice_llm_model_parameters: { temperature: 0.1 },
      },
      'claude-haiku-4-5',
    );

    expect(resolved).toEqual({
      model: 'claude-haiku-4-5',
      reasoning_effort: 'high',
      temperature: 0.1,
    });
    expect(mainParameters).toEqual({ model: 'gpt-4o-mini', reasoning_effort: 'high' });
  });
});
