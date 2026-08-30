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
  inheritResolvedAgentGraph,
  isSameAgentRoute,
  shouldRetryWithFallback,
  hasVisibleAssistantText,
  shouldRetryBackgroundCortexWithFallback,
  isRecoverableProviderFallbackError,
  initializePrimaryAgentWithFallback,
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
      fallback_llm_model: 'claude-opus-5',
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
      model: 'claude-opus-5',
    });
    expect(
      resolveFallbackCandidates(agent, { isVoiceCall: true }).map((item) => item.source),
    ).toEqual(['voice', 'agent']);
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

  test('accepts a capability-declared conversation provider as a generic fallback target', () => {
    const req = {
      config: {
        endpoints: {
          agents: {
            allowedProviders: ['glasshive-harness'],
            capabilityRequiredProviders: ['glasshive-harness'],
            providerCapabilities: {
              'glasshive-harness': { automatic_fallback_target: true },
            },
          },
        },
      },
    };

    expect(
      isFallbackModelValid('claude-code:opus', 'glasshive-harness', req, {
        'glasshive-harness': ['codex-cli:gpt-5.6-sol', 'claude-code:opus'],
      }),
    ).toBe(true);
  });

  test('treats a structured missing provider login as recoverable by another configured route', () => {
    expect(
      shouldRetryWithFallback([
        {
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]: 'The configured provider authentication is unavailable.',
          error_class: 'provider_auth_missing',
        },
      ]),
    ).toBe(true);
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

  test('replaces stale fallback edges with the resolved primary graph', () => {
    const fallbackConfig = {
      id: 'main',
      edges: [
        { from: 'main', to: 'unavailable-connected-account-agent' },
        { from: 'unavailable-connected-account-agent', to: 'main' },
      ],
    };
    const primaryConfig = {
      id: 'main',
      edges: [{ from: 'main', to: 'available-agent' }],
    };

    expect(inheritResolvedAgentGraph(fallbackConfig, primaryConfig)).toBe(fallbackConfig);
    expect(fallbackConfig.edges).toEqual([{ from: 'main', to: 'available-agent' }]);
    expect(fallbackConfig.edges).not.toBe(primaryConfig.edges);
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
          useResponsesApi: true,
          service_tier: 'priority',
          response_format: { type: 'json_object' },
        },
        'anthropic',
      ),
    ).toEqual({
      model: 'claude-opus-4-7',
      thinkingBudget: 2000,
    });

    expect(
      sanitizeFallbackModelParametersForProvider(
        {
          model: 'grok-4.3',
          thinking: false,
          thinkingBudget: 2000,
          reasoning_effort: 'none',
        },
        'xai',
      ),
    ).toEqual({
      model: 'grok-4.3',
      reasoning_effort: 'none',
    });

    expect(
      sanitizeFallbackModelParametersForProvider(
        {
          model: 'claude-code:opus',
          reasoning_effort: 'high',
          useResponsesApi: true,
          service_tier: 'priority',
        },
        'glasshive-harness',
        {
          models: [
            {
              id: 'claude-code:opus',
              effortChoices: ['low', 'medium', 'high', 'xhigh', 'max'],
            },
          ],
          responses_api: false,
        },
      ),
    ).toEqual({
      model: 'claude-code:opus',
      reasoning_effort: 'high',
    });

    expect(
      sanitizeFallbackModelParametersForProvider(
        { model: 'native:effortless', reasoning_effort: 'max' },
        'harness-provider',
        {
          models: [
            { id: 'native:reasoning', effortChoices: ['low', 'high'] },
            { id: 'native:effortless' },
          ],
        },
      ),
    ).toEqual({ model: 'native:effortless' });
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

  test('recovers a structured primary initialization auth failure through the configured fallback', async () => {
    const primaryAgent = { id: 'main', provider: 'openAI', model: 'gpt-primary' };
    const fallbackAgent = { id: 'main', provider: 'xai', model: 'grok-fallback' };
    const primaryError = new Error('connected account unavailable');
    primaryError.code = 'MODEL_AUTHENTICATION';
    primaryError.viventiumConnectedAccountReconnectRequired = true;
    const initializePrimary = jest.fn(async () => {
      throw primaryError;
    });
    const initializeFallback = jest.fn(async () => ({
      id: 'main',
      provider: 'xai',
      model: 'grok-fallback',
    }));

    await expect(
      initializePrimaryAgentWithFallback({
        primaryAgent,
        fallbackAgent,
        fallbackAssignment: { provider: 'xai', model: 'grok-fallback' },
        initializePrimary,
        initializeFallback,
      }),
    ).resolves.toMatchObject({
      effectiveAgent: fallbackAgent,
      fallbackUsed: true,
      primaryError,
      config: { provider: 'xai', model: 'grok-fallback' },
    });
    expect(initializePrimary).toHaveBeenCalledTimes(1);
    expect(initializeFallback).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['connection refusal', { code: 'ECONNREFUSED' }],
    ['connection reset', { code: 'ECONNRESET' }],
    ['gateway failure', { status: 502 }],
    ['provider timeout', { code: 'ETIMEDOUT' }],
  ])(
    'recovers a primary initialization %s through the configured fallback',
    async (_label, shape) => {
      const primaryError = Object.assign(new Error('provider connection failed'), shape);
      const initializeFallback = jest.fn(async () => ({ provider: 'glasshive-harness' }));

      await expect(
        initializePrimaryAgentWithFallback({
          primaryAgent: { provider: 'openAI', model: 'gpt-5.6-sol' },
          fallbackAgent: { provider: 'glasshive-harness', model: 'claude-code:opus' },
          fallbackAssignment: {
            provider: 'glasshive-harness',
            model: 'claude-code:opus',
          },
          initializePrimary: async () => {
            throw primaryError;
          },
          initializeFallback,
        }),
      ).resolves.toMatchObject({
        fallbackUsed: true,
        primaryError,
      });
      expect(initializeFallback).toHaveBeenCalledTimes(1);
    },
  );

  test('does not hide a non-provider primary initialization failure behind model fallback', async () => {
    const primaryError = new Error('tool registry invariant failed');
    primaryError.code = 'TOOL_REGISTRY_FAILURE';
    const initializeFallback = jest.fn();

    await expect(
      initializePrimaryAgentWithFallback({
        primaryAgent: { id: 'main', provider: 'openAI', model: 'gpt-primary' },
        fallbackAgent: { id: 'main', provider: 'xai', model: 'grok-fallback' },
        fallbackAssignment: { provider: 'xai', model: 'grok-fallback' },
        initializePrimary: async () => {
          throw primaryError;
        },
        initializeFallback,
      }),
    ).rejects.toBe(primaryError);
    expect(initializeFallback).not.toHaveBeenCalled();
  });

  test('allows graph fallback only for structured recoverable provider failures', () => {
    expect(isRecoverableProviderFallbackError({ status: 429 })).toBe(true);
    expect(isRecoverableProviderFallbackError({ errorClass: 'provider_quota_exhausted' })).toBe(
      true,
    );
    expect(isRecoverableProviderFallbackError({ cause: { code: 'ECONNRESET' } })).toBe(true);

    expect(isRecoverableProviderFallbackError({ status: 400 })).toBe(false);
    expect(
      isRecoverableProviderFallbackError({ status: 403, code: 'content_policy_violation' }),
    ).toBe(false);
    expect(isRecoverableProviderFallbackError({ status: 500, errorClass: 'tool_failure' })).toBe(
      false,
    );
    expect(isRecoverableProviderFallbackError({ code: 'GRAPH_INVARIANT_FAILURE' })).toBe(false);
    expect(isRecoverableProviderFallbackError({ name: 'AbortError', code: 'ABORT_ERR' })).toBe(
      false,
    );
  });

  test('does not start initialization fallback after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const primaryError = new Error('connected account unavailable');
    primaryError.code = 'MODEL_AUTHENTICATION';
    const initializeFallback = jest.fn();

    await expect(
      initializePrimaryAgentWithFallback({
        primaryAgent: { id: 'main', provider: 'openAI', model: 'gpt-primary' },
        fallbackAgent: { id: 'main', provider: 'xai', model: 'grok-fallback' },
        fallbackAssignment: { provider: 'xai', model: 'grok-fallback' },
        initializePrimary: async () => {
          throw primaryError;
        },
        initializeFallback,
        signal: controller.signal,
      }),
    ).rejects.toBe(primaryError);
    expect(initializeFallback).not.toHaveBeenCalled();
  });

  test('retries provider rate-limit errors only when no assistant text was produced', () => {
    expect(
      shouldRetryWithFallback([
        {
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]:
            'An error occurred while processing the request: status 429 rate_limit_error',
        },
      ]),
    ).toBe(true);
    expect(
      shouldRetryWithFallback([
        {
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]:
            'The model provider rate-limited this request. Please try again shortly.',
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

  test('routes the Telegram rate-limit message to GlassHive Opus 5 at high effort', () => {
    const primaryAgent = {
      id: 'agent_viventium_main_95aeb3',
      provider: 'openAI',
      model: 'gpt-5.6-sol',
      fallback_llm_provider: 'glasshive-harness',
      fallback_llm_model: 'claude-code:opus',
      fallback_llm_model_parameters: {
        model: 'claude-code:opus',
        reasoning_effort: 'high',
      },
    };
    const assignment = resolveFallbackAssignment(primaryAgent);
    const capability = {
      models: [
        {
          id: 'claude-code:opus',
          effortChoices: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
      ],
      responses_api: false,
    };
    const fallbackAgent = buildFallbackAgent(primaryAgent, assignment, capability);

    expect(
      shouldRetryWithFallback([
        {
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]:
            'The model provider rate-limited this request. Please try again shortly.',
        },
      ]),
    ).toBe(true);
    expect(fallbackAgent).toMatchObject({
      provider: 'glasshive-harness',
      model: 'claude-code:opus',
      model_parameters: {
        model: 'claude-code:opus',
        reasoning_effort: 'high',
      },
    });
    expect(
      sanitizeFallbackModelParametersForProvider(
        fallbackAgent.model_parameters,
        fallbackAgent.provider,
        capability,
      ),
    ).toEqual({ model: 'claude-code:opus', reasoning_effort: 'high' });
  });

  test('removes provider-internal fallback fields from the outer GlassHive fallback route', () => {
    const primaryAgent = {
      id: 'main',
      provider: 'glasshive-harness',
      model: 'codex-cli:gpt-5.6-sol',
      model_parameters: { model: 'codex-cli:gpt-5.6-sol', reasoning_effort: 'xhigh' },
      glasshive_options: {
        workspace: { mode: 'life' },
        access: 'full',
        orchestration: { parallel_available: true, default_mode: 'focused' },
        fallback_model: 'claude-code:opus',
        fallback_reasoning_effort: 'high',
      },
      fallback_llm_provider: 'glasshive-harness',
      fallback_llm_model: 'claude-code:opus',
      fallback_llm_model_parameters: {
        model: 'claude-code:opus',
        reasoning_effort: 'high',
      },
    };

    const fallbackAgent = buildFallbackAgent(
      primaryAgent,
      resolveFallbackAssignment(primaryAgent),
      {
        models: [{ id: 'claude-code:opus', effortChoices: ['high'] }],
      },
    );

    expect(fallbackAgent.glasshive_options).toEqual({
      workspace: { mode: 'life' },
      access: 'full',
      orchestration: { parallel_available: true, default_mode: 'focused' },
    });
    expect(primaryAgent.glasshive_options.fallback_model).toBe('claude-code:opus');
  });

  test('retries provider overload errors only when no assistant text was produced', () => {
    expect(
      shouldRetryWithFallback([
        {
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]:
            'The model provider is temporarily overloaded. Please try again shortly.',
          error_class: 'provider_temporarily_unavailable',
        },
      ]),
    ).toBe(true);

    expect(
      shouldRetryWithFallback([
        { type: ContentTypes.TEXT, text: 'Partial answer' },
        {
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]:
            'The model provider is temporarily overloaded. Please try again shortly.',
          error_class: 'provider_temporarily_unavailable',
        },
      ]),
    ).toBe(false);
  });

  test('keeps a persisted provider response deadline nonretryable at the outer agent layer', () => {
    expect(
      shouldRetryWithFallback([
        {
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]:
            'The provider returned status 504 after its configured deadline; retry the turn.',
          error_class: 'provider_response_deadline_exceeded',
        },
      ]),
    ).toBe(false);
  });

  test('retries wrapped provider authentication errors that begin with an HTTP status', () => {
    expect(
      shouldRetryWithFallback([
        {
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]: '401 Incorrect API key provided.',
        },
      ]),
    ).toBe(true);
  });

  test('treats OpenAI-style text.value parts as visible assistant text', () => {
    const textValuePart = {
      type: ContentTypes.TEXT,
      text: { value: 'Visible fallback answer.' },
    };

    expect(hasVisibleAssistantText([textValuePart])).toBe(true);
    expect(
      shouldRetryWithFallback([
        textValuePart,
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
      shouldRetryBackgroundCortexWithFallback({
        error: 'AbortError: operation was aborted',
        insight: null,
      }),
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

  test.each([
    ['errorClass', { errorClass: 'provider_unauthorized', insight: null }],
    ['errorStatus', { errorStatus: 401, insight: null }],
    ['errorCode', { errorCode: 'MODEL_AUTHENTICATION', insight: null }],
    ['rate-limit code', { errorCode: 'MODEL_RATE_LIMIT', insight: null }],
    [
      'quota/billing class with provider rate-limit code',
      {
        errorClass: 'provider_quota_or_billing',
        errorCode: 'provider_rate_limited',
        insight: null,
      },
    ],
  ])('retries background cortex fallback for structured provider %s', (_label, result) => {
    expect(shouldRetryBackgroundCortexWithFallback(result)).toBe(true);
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
        errorStatus: 401,
      }),
    ).toBe(false);
  });
});
