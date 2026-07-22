/* === VIVENTIUM START ===
 * Feature: Scheduled-agent execution policy tests
 * === VIVENTIUM END === */

const {
  applyScheduledAgentOverride,
  normalizeScheduledAgentExecution,
} = require('../scheduledAgentOverride');

describe('scheduledAgentOverride', () => {
  test('leaves an ordinary non-scheduler request unchanged', () => {
    const agent = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      model_parameters: { model: 'claude-sonnet-4-5', temperature: 0.2 },
      fallback_llm_provider: 'openai',
      fallback_llm_model: 'gpt-5.6-sol',
    };
    const before = structuredClone(agent);

    const result = applyScheduledAgentOverride(agent, {});

    expect(result).toBe(agent);
    expect(agent).toEqual(before);
  });

  test('applies a validated per-run tuple without replacing unrelated agent parameters', () => {
    const execution = normalizeScheduledAgentExecution({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      reasoning_effort: 'xhigh',
    });
    const agent = {
      provider: 'openai',
      model: 'gpt-5.6-sol',
      model_parameters: { model: 'gpt-5.6-sol', reasoning_effort: 'medium', useResponsesApi: true },
    };

    applyScheduledAgentOverride(agent, { viventiumScheduledAgentExecution: execution });

    expect(agent.provider).toBe('openAI');
    expect(agent.model_parameters).toEqual({
      model: 'gpt-5.6-sol',
      reasoning_effort: 'xhigh',
      useResponsesApi: true,
    });
  });

  test('rejects a partial tuple', () => {
    expect(() =>
      normalizeScheduledAgentExecution({ provider: 'openai', model: 'gpt-5.6-sol' }),
    ).toThrow('requires provider, model, and reasoning_effort');
  });

  test('removes persisted fallback routes from an authenticated exact scheduled run', () => {
    const agent = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      model_parameters: { model: 'claude-sonnet-4-5' },
      fallback_llm_provider: 'anthropic',
      fallback_llm_model: 'claude-opus-4-1',
      fallback_llm_model_parameters: { model: 'claude-opus-4-1' },
      voice_fallback_llm_provider: 'anthropic',
      voice_fallback_llm_model: 'claude-sonnet-4-5',
      voice_fallback_llm_model_parameters: { model: 'claude-sonnet-4-5' },
    };

    applyScheduledAgentOverride(agent, {
      viventiumScheduledAgentExecution: {
        provider: 'openai',
        model: 'gpt-5.6-sol',
        reasoning_effort: 'xhigh',
      },
    });

    expect(agent).not.toHaveProperty('fallback_llm_provider');
    expect(agent).not.toHaveProperty('fallback_llm_model');
    expect(agent).not.toHaveProperty('fallback_llm_model_parameters');
    expect(agent).not.toHaveProperty('voice_fallback_llm_provider');
    expect(agent).not.toHaveProperty('voice_fallback_llm_model');
    expect(agent).not.toHaveProperty('voice_fallback_llm_model_parameters');
  });
});
