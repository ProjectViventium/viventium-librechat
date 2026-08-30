import { ErrorTypes } from 'librechat-data-provider';
import type { Agent, TModelsConfig } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import {
  activationConfigSchema,
  agentBaseSchema,
  applyAgentProviderCapabilityDefaults,
  cortexResultEvidencePolicySchema,
  validateAgentModel,
} from './validation';

describe('background cortex activation mode validation', () => {
  it.each(['always', 'disabled'] as const)(
    'accepts %s mode without classifier-only fields',
    (mode) => {
      expect(activationConfigSchema.parse({ enabled: true, mode })).toEqual({
        enabled: true,
        mode,
      });
    },
  );

  it('keeps absent mode backward-compatible with classified activation', () => {
    expect(() =>
      activationConfigSchema.parse({
        enabled: true,
        provider: 'openai',
        model: 'gpt-5.4',
        prompt: 'Classify this turn.',
        confidence_threshold: 0.7,
        cooldown_ms: 0,
        max_history: 5,
      }),
    ).not.toThrow();
  });

  it('rejects unknown modes and classified activation without classifier configuration', () => {
    expect(() => activationConfigSchema.parse({ enabled: true, mode: 'sometimes' })).toThrow();
    expect(() => activationConfigSchema.parse({ enabled: true, mode: 'classified' })).toThrow(
      'Classifier provider is required',
    );
  });
});

describe('background cortex result evidence validation', () => {
  it('accepts a typed non-empty source receipt requirement', () => {
    expect(
      cortexResultEvidencePolicySchema.parse({
        visible_insight_requires: [{ tool: 'file_search', receipt: 'non_empty_sources' }],
      }),
    ).toEqual({
      visible_insight_requires: [{ tool: 'file_search', receipt: 'non_empty_sources' }],
    });
  });

  it.each([
    {},
    { visible_insight_requires: [] },
    { visible_insight_requires: [{ tool: '', receipt: 'non_empty_sources' }] },
    { visible_insight_requires: [{ tool: 'file_search', receipt: 'caller_asserted' }] },
  ])('rejects an absent, empty, or self-asserted result evidence policy', (policy) => {
    expect(() => cortexResultEvidencePolicySchema.parse(policy)).toThrow();
  });
});

const providerRegistry = {
  'harness-provider': {
    main_chat: true,
    workspace_binding: true,
    reviewed_mcp_projection: 'deferred' as const,
    responses_api: false,
    serial_model_fallback: true,
    default_access: 'full' as const,
    allow_full_access: true,
    models: [
      {
        id: 'native:model-a',
        effortChoices: ['low', 'medium'],
        recommendedEffort: 'medium',
      },
      {
        id: 'native:model-b',
        effortChoices: ['high', 'max'],
        recommendedEffort: 'max',
      },
    ],
  },
};

describe('applyAgentProviderCapabilityDefaults', () => {
  it('applies registry-owned workspace and effort defaults', () => {
    expect(
      applyAgentProviderCapabilityDefaults(
        {
          provider: 'harness-provider',
          model: 'native:model-a',
          model_parameters: { useResponsesApi: true },
        },
        providerRegistry,
      ),
    ).toEqual({
      provider: 'harness-provider',
      model: 'native:model-a',
      model_parameters: { model: 'native:model-a', reasoning_effort: 'medium' },
      glasshive_options: { workspace: { mode: 'life' }, access: 'full' },
    });
  });

  it('fails loudly for unsupported exact models and efforts', () => {
    expect(() =>
      applyAgentProviderCapabilityDefaults(
        { provider: 'harness-provider', model: 'made-up' },
        providerRegistry,
      ),
    ).toThrow('Unsupported model');
    expect(() =>
      applyAgentProviderCapabilityDefaults(
        {
          provider: 'harness-provider',
          model: 'native:model-a',
          model_parameters: { reasoning_effort: 'ultra' },
        },
        providerRegistry,
      ),
    ).toThrow('Unsupported reasoning effort');
  });

  it('preserves provider options while a direct provider is selected', () => {
    const selection = {
      provider: 'openAI',
      model: 'gpt-direct',
      glasshive_options: {
        workspace: { mode: 'custom' as const, path: '/srv/life' },
        access: 'workspace' as const,
      },
    };

    expect(applyAgentProviderCapabilityDefaults(selection, providerRegistry)).toEqual(selection);
  });

  it('validates and preserves a provider-internal serial fallback', () => {
    const selection = {
      provider: 'harness-provider',
      model: 'native:model-a',
      glasshive_options: {
        workspace: { mode: 'life' as const },
        access: 'full' as const,
        fallback_model: 'native:model-b',
      },
    };

    expect(applyAgentProviderCapabilityDefaults(selection, providerRegistry)).toMatchObject({
      glasshive_options: {
        fallback_model: 'native:model-b',
        fallback_reasoning_effort: 'max',
      },
    });
    expect(() =>
      applyAgentProviderCapabilityDefaults(
        {
          ...selection,
          glasshive_options: { ...selection.glasshive_options, fallback_model: 'native:missing' },
        },
        providerRegistry,
      ),
    ).toThrow('Unsupported GlassHive fallback model');
  });

  it('preserves the provider-independent parallel-work declaration', () => {
    const selection = {
      provider: 'harness-provider',
      model: 'native:model-a',
      glasshive_options: {
        workspace: { mode: 'life' as const },
        access: 'full' as const,
        orchestration: {
          parallel_available: true,
          default_mode: 'focused' as const,
          worker_profile: 'codex-cli' as const,
          fallback_worker_profile: 'claude-code' as const,
        },
      },
    };

    expect(applyAgentProviderCapabilityDefaults(selection, providerRegistry)).toMatchObject({
      glasshive_options: { orchestration: selection.glasshive_options.orchestration },
    });
    expect(agentBaseSchema.parse(selection)).toMatchObject({
      glasshive_options: { orchestration: selection.glasshive_options.orchestration },
    });
  });

  it('uses a registry-owned safer workspace default and rejects disallowed full access', () => {
    const restrictedRegistry = {
      'harness-provider': {
        ...providerRegistry['harness-provider'],
        default_access: 'workspace' as const,
        allow_full_access: false,
      },
    };

    expect(
      applyAgentProviderCapabilityDefaults(
        { provider: 'harness-provider', model: 'native:model-a' },
        restrictedRegistry,
      ).glasshive_options,
    ).toEqual({ workspace: { mode: 'life' }, access: 'workspace' });
    expect(() =>
      applyAgentProviderCapabilityDefaults(
        {
          provider: 'harness-provider',
          model: 'native:model-a',
          glasshive_options: { workspace: { mode: 'life' }, access: 'full' },
        },
        restrictedRegistry,
      ),
    ).toThrow('does not permit full host access');
  });

  it('requires a custom workspace to be an absolute server-side path', () => {
    expect(() =>
      agentBaseSchema.parse({
        glasshive_options: {
          workspace: { mode: 'custom', path: 'relative/Life' },
          access: 'workspace',
        },
      }),
    ).toThrow('absolute server-side path');
    expect(() =>
      agentBaseSchema.parse({
        glasshive_options: {
          workspace: { mode: 'custom', path: '/srv/Viventium/Life' },
          access: 'workspace',
        },
      }),
    ).not.toThrow();
  });

  it('fails closed when a required provider capability is absent', () => {
    expect(() =>
      applyAgentProviderCapabilityDefaults(
        { provider: 'harness-provider', model: 'native:model-a' },
        {},
        ['harness-provider'],
      ),
    ).toThrow('Provider capability configuration is unavailable');
  });

  it('rejects excluded voice, fallback, and activation roles server-side', () => {
    const registry = {
      ...providerRegistry,
      'harness-provider': {
        ...providerRegistry['harness-provider'],
        voice_pipeline_llm: false,
        realtime_voice: false,
        automatic_fallback_target: false,
        activation_classifier: false,
      },
    };
    for (const candidate of [
      { voice_llm_provider: 'harness-provider' },
      { voice_fallback_llm_provider: 'harness-provider' },
      { fallback_llm_provider: 'harness-provider' },
      {
        background_cortices: [
          {
            activation: {
              provider: 'harness-provider',
              fallbacks: [],
            },
          },
        ],
      },
    ]) {
      expect(() =>
        applyAgentProviderCapabilityDefaults(
          {
            provider: 'harness-provider',
            model: 'native:model-a',
            ...candidate,
          },
          registry,
          ['harness-provider'],
        ),
      ).toThrow('does not support agent capability');
    }
  });

  it('accepts a harness as a cascaded Voice Call LLM and applies exact model defaults', () => {
    const result = applyAgentProviderCapabilityDefaults(
      {
        provider: 'openAI',
        model: 'gpt-direct',
        voice_llm_provider: 'harness-provider',
        voice_llm_model: 'native:model-a',
        voice_llm_model_parameters: { useResponsesApi: true },
      },
      {
        ...providerRegistry,
        'harness-provider': {
          ...providerRegistry['harness-provider'],
          voice_pipeline_llm: true,
          native_realtime_voice: false,
          realtime_voice: false,
        },
      },
      ['harness-provider'],
    );

    expect(result.voice_llm_model_parameters).toEqual({
      model: 'native:model-a',
      reasoning_effort: 'medium',
    });
    expect(result.glasshive_options).toEqual({
      workspace: { mode: 'life' },
      access: 'full',
    });
  });

  it('does not allow a voice-capable harness to become an automatic voice fallback target', () => {
    expect(() =>
      applyAgentProviderCapabilityDefaults(
        {
          provider: 'openAI',
          model: 'gpt-direct',
          voice_fallback_llm_provider: 'harness-provider',
          voice_fallback_llm_model: 'native:model-a',
        },
        {
          ...providerRegistry,
          'harness-provider': {
            ...providerRegistry['harness-provider'],
            voice_pipeline_llm: true,
            automatic_fallback_target: false,
          },
        },
        ['harness-provider'],
      ),
    ).toThrow('automatic_fallback_target');
  });

  it('rejects an unsupported exact harness model or voice effort', () => {
    const voiceRegistry = {
      ...providerRegistry,
      'harness-provider': {
        ...providerRegistry['harness-provider'],
        voice_pipeline_llm: true,
        realtime_voice: false,
      },
    };
    expect(() =>
      applyAgentProviderCapabilityDefaults(
        {
          provider: 'openAI',
          model: 'gpt-direct',
          voice_llm_provider: 'harness-provider',
          voice_llm_model: 'made-up',
        },
        voiceRegistry,
        ['harness-provider'],
      ),
    ).toThrow('Unsupported model');
    expect(() =>
      applyAgentProviderCapabilityDefaults(
        {
          provider: 'openAI',
          model: 'gpt-direct',
          voice_llm_provider: 'harness-provider',
          voice_llm_model: 'native:model-a',
          voice_llm_model_parameters: { reasoning_effort: 'ultra' },
        },
        voiceRegistry,
        ['harness-provider'],
      ),
    ).toThrow('Unsupported reasoning effort');
  });

  it('strips every Responses API-only parameter from harness model configuration', () => {
    const result = applyAgentProviderCapabilityDefaults(
      {
        provider: 'harness-provider',
        model: 'native:model-a',
        model_parameters: {
          useResponsesApi: true,
          reasoning: { effort: 'high' },
          reasoning_summary: 'auto',
          verbosity: 'high',
          web_search: true,
          reasoning_effort: 'low',
        },
      },
      providerRegistry,
      ['harness-provider'],
    );

    expect(result.model_parameters).toEqual({
      model: 'native:model-a',
      reasoning_effort: 'low',
    });
  });
});

describe('validateAgentModel', () => {
  it('matches custom provider model lists case-insensitively', async () => {
    const req = {} as Request;
    const res = {} as Response;
    const agent = {
      provider: 'xai',
      model: 'grok-4.20-non-reasoning',
    } as Agent;
    const modelsConfig = {
      xAI: ['grok-4.20-non-reasoning'],
    } as unknown as TModelsConfig;
    const logViolation = jest.fn(async () => undefined);

    await expect(
      validateAgentModel({
        req,
        res,
        agent,
        modelsConfig,
        logViolation,
      }),
    ).resolves.toEqual({ isValid: true });
    expect(logViolation).not.toHaveBeenCalled();
  });

  it('preserves endpoint-not-loaded errors when there is no normalized match', async () => {
    const req = {} as Request;
    const res = {} as Response;
    const agent = {
      provider: 'xai',
      model: 'grok-4.20-non-reasoning',
    } as Agent;
    const modelsConfig = {
      openai: ['gpt-4o'],
    } as unknown as TModelsConfig;
    const logViolation = jest.fn(async () => undefined);

    await expect(
      validateAgentModel({
        req,
        res,
        agent,
        modelsConfig,
        logViolation,
      }),
    ).resolves.toEqual({
      isValid: false,
      error: {
        message: `{ "type": "${ErrorTypes.ENDPOINT_MODELS_NOT_LOADED}", "info": "xai" }`,
      },
    });
  });
});
