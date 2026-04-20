import { describe, expect, it } from '@jest/globals';
import { resolveAgentModelForProvider } from '../modelSelection';

describe('resolveAgentModelForProvider', () => {
  it('preserves an existing saved model when the provider did not change', () => {
    expect(
      resolveAgentModelForProvider({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        availableModels: ['claude-opus-4-1-20250805', 'claude-sonnet-4-6'],
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
