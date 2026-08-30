import { describe, expect, it } from '@jest/globals';
import {
  didAgentProviderChange,
  resolveCapabilityEffort,
  resolveAgentModelDisplayLabel,
  resolveAgentModelForProvider,
  shouldDefaultOpenAIGPT56AgentToResponses,
} from '../modelSelection';
import { filterExcludedModelParameters } from '../ModelParametersSection';

describe('filterExcludedModelParameters', () => {
  it('removes parameters owned by a dedicated control without changing the remaining order', () => {
    const parameters = [
      { key: 'temperature', component: 'slider', default: 1 },
      { key: 'reasoning_effort', component: 'select', default: 'medium' },
      { key: 'top_p', component: 'slider', default: 1 },
    ];

    expect(
      filterExcludedModelParameters(parameters, ['reasoning_effort']).map(({ key }) => key),
    ).toEqual(['temperature', 'top_p']);
  });
});

describe('resolveCapabilityEffort', () => {
  const modelCapability = {
    effortChoices: ['low', 'medium', 'high'],
    recommendedEffort: 'medium',
  };

  it('keeps a supported lighter voice effort', () => {
    expect(resolveCapabilityEffort('low', modelCapability)).toBe('low');
  });

  it('uses the provider recommendation for missing or stale effort', () => {
    expect(resolveCapabilityEffort(undefined, modelCapability)).toBe('medium');
    expect(resolveCapabilityEffort('ultra', modelCapability)).toBe('medium');
  });

  it('does not invent effort for a model without declared choices', () => {
    expect(resolveCapabilityEffort('low', undefined)).toBeUndefined();
  });
});

/* === VIVENTIUM START ===
 * Regression: friendly provider model labels must survive the collapsed Agent Builder view.
 * === VIVENTIUM END === */
describe('resolveAgentModelDisplayLabel', () => {
  it('renders the declared friendly model label while preserving the saved model id', () => {
    expect(
      resolveAgentModelDisplayLabel({
        provider: 'glasshive-harness',
        model: 'codex-cli:gpt-5.6-sol',
        providerCapabilities: {
          'glasshive-harness': {
            models: [{ id: 'codex-cli:gpt-5.6-sol', label: 'Codex / GPT-5.6 Sol' }],
          },
        },
      }),
    ).toBe('Codex / GPT-5.6 Sol');
  });

  it('falls back to the exact model id when no display label is declared', () => {
    expect(
      resolveAgentModelDisplayLabel({
        provider: 'openAI',
        model: 'gpt-5.6-sol',
        providerCapabilities: {},
      }),
    ).toBe('gpt-5.6-sol');
  });
});

describe('resolveAgentModelForProvider', () => {
  it('preserves an existing saved model when the provider did not change', () => {
    expect(
      resolveAgentModelForProvider({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        availableModels: ['claude-opus-4-1-20250805', 'claude-opus-5'],
        previousProvider: 'anthropic',
      }),
    ).toBe('claude-opus-4-7');
  });

  it('falls back to the first available model when the provider changes', () => {
    expect(
      resolveAgentModelForProvider({
        provider: 'openAI',
        model: 'claude-opus-4-7',
        availableModels: ['gpt-5.4', 'gpt-4.1'],
        previousProvider: 'anthropic',
      }),
    ).toBe('gpt-5.4');
  });

  it('selects the first available model when no model is set', () => {
    expect(
      resolveAgentModelForProvider({
        provider: 'anthropic',
        model: '',
        availableModels: ['claude-opus-4-7'],
        previousProvider: '',
      }),
    ).toBe('claude-opus-4-7');
  });
});

/* === VIVENTIUM START ===
 * Regression: optional-route provider changes must discard provider-specific parameters.
 * === VIVENTIUM END === */
describe('didAgentProviderChange', () => {
  it('ignores initial hydration and detects later provider changes', () => {
    expect(didAgentProviderChange({ provider: 'openAI', previousProvider: undefined })).toBe(false);
    expect(didAgentProviderChange({ provider: 'openAI', previousProvider: 'openAI' })).toBe(false);
    expect(didAgentProviderChange({ provider: 'xai', previousProvider: 'openAI' })).toBe(true);
  });

  it('preserves parameters during mounted empty-to-value hydration', () => {
    expect(didAgentProviderChange({ provider: 'xai', previousProvider: '' })).toBe(false);
  });

  it('treats clearing a hydrated provider as a change', () => {
    expect(didAgentProviderChange({ provider: '', previousProvider: 'xai' })).toBe(true);
  });
});

/* === VIVENTIUM START ===
 * Regression: GPT-5.6 Agent Builder Responses default.
 * === VIVENTIUM END === */
describe('shouldDefaultOpenAIGPT56AgentToResponses', () => {
  it.each(['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
    'defaults %s when no explicit choice exists',
    (model) => {
      expect(
        shouldDefaultOpenAIGPT56AgentToResponses({
          provider: 'openAI',
          model,
          useResponsesApi: undefined,
        }),
      ).toBe(true);
    },
  );

  it('preserves explicit choices and ignores unrelated model/provider pairs', () => {
    expect(
      shouldDefaultOpenAIGPT56AgentToResponses({
        provider: 'openAI',
        model: 'gpt-5.6',
        useResponsesApi: false,
      }),
    ).toBe(false);
    expect(
      shouldDefaultOpenAIGPT56AgentToResponses({
        provider: 'openAI',
        model: 'gpt-5.4',
        useResponsesApi: undefined,
      }),
    ).toBe(false);
    expect(
      shouldDefaultOpenAIGPT56AgentToResponses({
        provider: 'anthropic',
        model: 'gpt-5.6',
        useResponsesApi: undefined,
      }),
    ).toBe(false);
  });
});
