/**
 * === VIVENTIUM START ===
 * Feature: Activation-route model catalog regression coverage.
 * Purpose: Prove persisted and discovered provider/model routes remain truthful in Agent Builder.
 * === VIVENTIUM END ===
 */

import {
  activationModelKey,
  buildActivationModelOptions,
  resolveDefaultActivationRoute,
} from './activationModelOptions';

describe('activation model options', () => {
  const models = {
    groq: ['qwen/qwen3.6-27b', 'qwen/qwen3-32b'],
    openAI: ['gpt-5.4'],
  };

  test('renders the live runtime model catalog instead of a hardcoded list', () => {
    expect(buildActivationModelOptions(models)).toEqual([
      { label: 'qwen/qwen3.6-27b (groq)', value: 'qwen/qwen3.6-27b|groq' },
      { label: 'qwen/qwen3-32b (groq)', value: 'qwen/qwen3-32b|groq' },
      { label: 'gpt-5.4 (openAI)', value: 'gpt-5.4|openAI' },
    ]);
  });

  test('keeps a persisted route visible even when model discovery is temporarily stale', () => {
    const current = { provider: 'xai', model: 'grok-configured-model' };
    const options = buildActivationModelOptions(models, current);

    expect(options[0]).toEqual({
      label: 'grok-configured-model (xai) — configured',
      value: 'grok-configured-model|xai',
    });
    expect(activationModelKey(current)).toBe('grok-configured-model|xai');
  });

  test('inherits the most common configured activation route for a newly attached cortex', () => {
    const cortices = [
      { activation: { provider: 'groq', model: 'qwen/qwen3.6-27b' } },
      { activation: { provider: 'xai', model: 'grok-configured-model' } },
      { activation: { provider: 'groq', model: 'qwen/qwen3.6-27b' } },
    ];

    expect(resolveDefaultActivationRoute(cortices, models)).toEqual({
      provider: 'groq',
      model: 'qwen/qwen3.6-27b',
    });
    expect(resolveDefaultActivationRoute([], models)).toEqual({
      provider: 'groq',
      model: 'qwen/qwen3.6-27b',
    });
  });
});
