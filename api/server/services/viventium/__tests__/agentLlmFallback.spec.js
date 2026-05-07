/* === VIVENTIUM START ===
 * Feature: Agent Fallback LLM helper tests
 * Added: 2026-04-28
 * === VIVENTIUM END === */

const { ContentTypes } = require('librechat-data-provider');
const {
  resolveFallbackAssignment,
  resolveVoiceFallbackAssignment,
  resolveEffectiveFallbackAssignment,
  resolveFallbackCandidates,
  isFallbackModelValid,
  resolveFallbackModelParameters,
  sanitizeFallbackModelParametersForProvider,
  buildFallbackAgent,
  isSameAgentRoute,
  shouldRetryWithFallback,
  shouldRetryBackgroundCortexWithFallback,
} = require('../agentLlmFallback');

describe('agentLlmFallback', () => {
  test('resolves explicit fallback provider and model from agent fields', () => {
    expect(
      resolveFallbackAssignment({
        fallback_llm_provider: 'openai',
        fallback_llm_model: 'gpt-5.4',
      }),
    ).toMatchObject({
      provider: 'openAI',
      model: 'gpt-5.4',
      source: 'agent',
    });
  });

  test('resolves voice fallback separately and prefers it for voice calls', () => {
    const agent = {
      fallback_llm_provider: 'anthropic',
      fallback_llm_model: 'claude-sonnet-4-6',
      voice_fallback_llm_provider: 'openAI',
      voice_fallback_llm_model: 'gpt-5.4',
    };

    expect(resolveVoiceFallbackAssignment(agent)).toMatchObject({
      provider: 'openAI',
      model: 'gpt-5.4',
      source: 'voice',
      parametersField: 'voice_fallback_llm_model_parameters',
    });
    expect(resolveEffectiveFallbackAssignment(agent, { isVoiceCall: true })).toMatchObject({
      provider: 'openAI',
      model: 'gpt-5.4',
    });
    expect(resolveEffectiveFallbackAssignment(agent, { isVoiceCall: false })).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    expect(resolveFallbackCandidates(agent, { isVoiceCall: true }).map((item) => item.source)).toEqual([
      'voice',
      'agent',
    ]);
  });

  test('validates fallback model against allowed providers and model config', () => {
    const req = {
      config: { endpoints: { agents: { allowedProviders: ['openAI'] } } },
    };

    expect(
      isFallbackModelValid('gpt-5.4', 'openAI', req, {
        openAI: ['gpt-5.4'],
      }),
    ).toBe(true);
    expect(
      isFallbackModelValid('claude-haiku-4-5', 'anthropic', req, {
        anthropic: ['claude-haiku-4-5'],
      }),
    ).toBe(false);
  });

  test('builds fallback parameters without mutating primary parameters', () => {
    const primaryParameters = { model: 'claude-opus-4-7', temperature: 0.8 };
    const agent = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      model_parameters: primaryParameters,
      fallback_llm_provider: 'openAI',
      fallback_llm_model: 'gpt-5.4',
      fallback_llm_model_parameters: { temperature: 0.2, max_output_tokens: 800 },
    };
    const assignment = resolveFallbackAssignment(agent);
    const fallbackAgent = buildFallbackAgent(agent, assignment);

    expect(resolveFallbackModelParameters(agent, 'gpt-5.4')).toEqual({
      model: 'gpt-5.4',
      temperature: 0.2,
      max_output_tokens: 800,
    });
    expect(fallbackAgent.provider).toBe('openAI');
    expect(fallbackAgent.model).toBe('gpt-5.4');
    expect(primaryParameters).toEqual({ model: 'claude-opus-4-7', temperature: 0.8 });
  });

  test('strips provider-specific parameters from cross-provider fallback routes', () => {
    expect(
      sanitizeFallbackModelParametersForProvider(
        {
          model: 'gpt-5.4',
          thinking: false,
          thinkingBudget: 2000,
          reasoning_effort: 'high',
        },
        'openAI',
      ),
    ).toEqual({
      model: 'gpt-5.4',
      reasoning_effort: 'high',
    });

    expect(
      sanitizeFallbackModelParametersForProvider(
        {
          model: 'claude-opus-4-7',
          thinkingBudget: 2000,
          reasoning_effort: 'high',
        },
        'anthropic',
      ),
    ).toEqual({
      model: 'claude-opus-4-7',
      thinkingBudget: 2000,
    });
  });

  test('builds voice fallback parameters from the effective voice model parameters', () => {
    const agent = {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      model_parameters: { model: 'claude-haiku-4-5', temperature: 0.4 },
      voice_fallback_llm_provider: 'openAI',
      voice_fallback_llm_model: 'gpt-5.4',
      voice_fallback_llm_model_parameters: { temperature: 0.1, max_output_tokens: 320 },
    };
    const assignment = resolveVoiceFallbackAssignment(agent);
    const fallbackAgent = buildFallbackAgent(agent, assignment);

    expect(resolveFallbackModelParameters(agent, 'gpt-5.4', assignment.parametersField)).toEqual({
      model: 'gpt-5.4',
      temperature: 0.1,
      max_output_tokens: 320,
    });
    expect(fallbackAgent.provider).toBe('openAI');
    expect(fallbackAgent.model).toBe('gpt-5.4');
    expect(fallbackAgent.model_parameters).toMatchObject({
      model: 'gpt-5.4',
      temperature: 0.1,
      max_output_tokens: 320,
    });
  });

  test('detects same provider/model route to avoid fallback loops', () => {
    expect(
      isSameAgentRoute(
        { provider: 'openAI', model: 'gpt-5.4', model_parameters: { model: 'gpt-5.4' } },
        { provider: 'openAI', model: 'gpt-5.4' },
      ),
    ).toBe(true);
  });

  test('retries provider rate-limit errors only when no assistant text was produced', () => {
    expect(
      shouldRetryWithFallback([
        {
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]: 'An error occurred while processing the request: status 429 rate_limit_error',
        },
      ]),
    ).toBe(true);

    expect(
      shouldRetryWithFallback([
        { type: ContentTypes.TEXT, text: 'Partial answer' },
        {
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]: 'status 429 rate_limit_error',
        },
      ]),
    ).toBe(false);
  });

  test('does not retry main-agent fallback for unstructured tool or MCP failures', () => {
    expect(
      shouldRetryWithFallback([
        {
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]: 'MCP tool returned status 429 rate_limit_error',
        },
      ]),
    ).toBe(false);

    expect(
      shouldRetryWithFallback([
        {
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]: 'Tool call failed with status 529 overloaded',
        },
      ]),
    ).toBe(false);
  });

  test('retries background cortex fallback for abort and timeout result errors', () => {
    expect(shouldRetryBackgroundCortexWithFallback({ error: 'timeout', insight: null })).toBe(true);
    expect(
      shouldRetryBackgroundCortexWithFallback({ error: 'AbortError: operation was aborted', insight: null }),
    ).toBe(true);
    expect(
      shouldRetryBackgroundCortexWithFallback({
        error: 'status 529 overloaded',
        insight: null,
      }),
    ).toBe(true);
    expect(
      shouldRetryBackgroundCortexWithFallback({
        error: 'request timeout while invoking tool calling endpoint',
        insight: null,
      }),
    ).toBe(true);
    expect(
      shouldRetryBackgroundCortexWithFallback({
        error: 'status 529 overloaded while invoking tool calling endpoint',
        insight: null,
      }),
    ).toBe(true);
  });

  test('does not retry background cortex fallback for visible output or structured tool failures', () => {
    expect(
      shouldRetryBackgroundCortexWithFallback({
        insight: 'usable answer',
        error: 'timeout',
      }),
    ).toBe(false);
    expect(
      shouldRetryBackgroundCortexWithFallback({
        insight: null,
        error: 'no_live_tool_execution',
      }),
    ).toBe(false);
    expect(
      shouldRetryBackgroundCortexWithFallback({
        insight: null,
        error: 'MCP tool failed with status 503',
        errorClass: 'mcp_tool_failure',
      }),
    ).toBe(false);
  });
});
