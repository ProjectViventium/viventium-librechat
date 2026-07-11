import { describe, expect, it } from '@jest/globals';
import {
  resolveAgentModelForProvider,
  shouldDefaultOpenAIGPT56AgentToResponses,
} from '../modelSelection';

describe('resolveAgentModelForProvider', () => {
  it('preserves an existing saved model when the provider did not change', () => {
    expect(
      resolveAgentModelForProvider({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        availableModels: ['claude-opus-4-1-20250805', 'claude-sonnet-4-5'],
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
