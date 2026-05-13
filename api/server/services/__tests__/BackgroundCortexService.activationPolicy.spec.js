const {
  buildActivationPolicySection,
  applyActivationJsonMode,
  ACTIVATION_SYSTEM_PROMPT,
  classifyActivationError,
  buildCortexCompletionPayload,
  hasVisibleCortexInsight,
  normalizeDirectActionSurfaceScopes,
  applyDirectActionOwnershipGate,
  normalizeAgentToolNames,
  resolveActivationPolicyMainAgent,
  summarizeActivationError,
  formatHistoryForActivation,
  getCortexAttemptGuardTimeoutMs,
  resolveBackgroundCortexFallbackAgent,
  buildActivationCooldownKey,
  buildActivationLlmConfig,
  buildActivationProviderAttempts,
  clearActivationProviderHealth,
  getActivationProviderSuppression,
  markActivationProviderUnhealthy,
  shouldAttemptSuppressedActivationProvider,
  shouldProbeSuppressedActivationAttempt,
  activationProviderAttemptsUnavailable,
  activationFailureVisibility,
  shouldSurfaceActivationProviderUnavailable,
  shouldSurfaceActivationTimeout,
  configuredCortexDisplayName,
} = require('../BackgroundCortexService');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

describe('BackgroundCortexService activation policy helpers', () => {
  afterEach(() => {
    clearActivationProviderHealth();
  });

  test('keeps activation classifier output strictly JSON-only', () => {
    expect(ACTIVATION_SYSTEM_PROMPT).toContain('Return only one valid JSON object');
    expect(ACTIVATION_SYSTEM_PROMPT).toContain('Do not include markdown');

    const llmConfig = applyActivationJsonMode({
      providerName: 'groq',
      llmConfig: { provider: 'openAI', modelKwargs: { top_p: 1 } },
    });

    expect(llmConfig.modelKwargs).toEqual({
      top_p: 1,
      response_format: { type: 'json_object' },
    });
  });

  test('does not force provider JSON mode onto OpenAI reasoning activation fallback', () => {
    const llmConfig = applyActivationJsonMode({
      providerName: 'openai',
      model: 'gpt-5.4',
      llmConfig: { provider: 'openAI', model: 'gpt-5.4' },
    });

    expect(llmConfig.modelKwargs).toBeUndefined();
  });

  test('keeps Groq as the primary activation classifier before fallbacks', () => {
    const attempts = buildActivationProviderAttempts({
      provider: 'groq',
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      fallbacks: [
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct' },
        { provider: 'xai', model: 'grok-4.20-non-reasoning' },
        { provider: 'openai', model: 'gpt-5.4' },
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
      ],
    });

    expect(attempts).toEqual([
      {
        provider: 'groq',
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        source: 'primary',
      },
      { provider: 'xai', model: 'grok-4.20-non-reasoning', source: 'fallback' },
      { provider: 'openai', model: 'gpt-5.4', source: 'fallback' },
      { provider: 'anthropic', model: 'claude-haiku-4-5', source: 'fallback' },
    ]);
  });

  test('renders configured direct-action surfaces only when exact tools are attached', () => {
    const config = {
      viventium: {
        background_cortices: {
          activation_policy: {
            enabled: true,
            prompt: 'The main agent owns direct execution through connected tools.',
            direct_action_mcp_servers: [
              {
                server: 'glasshive-workers-projects',
                scope_key: 'host_workers',
                owns: 'persistent workers and local computer actions',
                tool_names: ['worker_run_mcp_glasshive-workers-projects'],
              },
              {
                server: 'scheduling-cortex',
                owns: 'scheduled follow-ups',
                tool_names: ['schedule_create_mcp_scheduling-cortex'],
              },
            ],
          },
        },
      },
    };
    const mainAgent = {
      tools: ['worker_run_mcp_glasshive-workers-projects', 'web_search'],
    };

    const result = buildActivationPolicySection({ config, mainAgent });

    expect(result.section).toContain('## Global Activation Policy:');
    expect(result.section).toContain('glasshive-workers-projects');
    expect(result.section).toContain('scope_key: host_workers');
    expect(result.section).not.toContain('scheduling-cortex');
    expect(result.connectedSurfaces).toEqual([
      expect.objectContaining({
        server: 'glasshive-workers-projects',
        scopeKey: 'host_workers',
      }),
    ]);
  });

  test('normalizes direct-action surface scopes for hold decisions', () => {
    expect(
      normalizeDirectActionSurfaceScopes([
        { server: 'Google', scope_key: 'Productivity Google Workspace' },
        { server: 'duplicate', scopeKey: 'productivity_google_workspace' },
        'Productivity MS365',
        null,
      ]),
    ).toEqual([
      {
        server: 'Google',
        scopeKey: 'productivity_google_workspace',
        owns: '',
        sameScopeBackgroundAllowed: false,
      },
      { scopeKey: 'productivity_ms365' },
    ]);
  });

  test('renders same-scope supplemental background contract for matching direct surfaces', () => {
    const result = buildActivationPolicySection({
      config: {
        viventium: {
          background_cortices: {
            activation_policy: {
              enabled: true,
              prompt: 'Policy text.',
              direct_action_mcp_servers: [
                {
                  server: 'google-workspace',
                  scope_key: 'productivity_google_workspace',
                  same_scope_background_allowed: true,
                  tool_names: ['search_gmail_messages_mcp_google_workspace'],
                },
              ],
            },
          },
        },
      },
      mainAgent: { tools: ['search_gmail_messages_mcp_google_workspace'] },
    });

    expect(result.section).toContain('same_scope_background_allowed: true');
    expect(result.section).toContain(
      'not as a blocker for a background agent whose own configured activation scope exactly matches',
    );
    expect(result.connectedSurfaces[0]).toEqual(
      expect.objectContaining({
        scopeKey: 'productivity_google_workspace',
        sameScopeBackgroundAllowed: true,
      }),
    );
  });

  test('structurally suppresses same-scope background activation unless supplemental Phase B is allowed', () => {
    expect(
      applyDirectActionOwnershipGate({
        shouldActivate: true,
        confidence: 0.91,
        reason: 'classifier_match',
        agentId: 'agent_productivity',
        activationScope: 'productivity_google_workspace',
        directActionSurfaceScopes: [
          {
            server: 'google-workspace',
            scopeKey: 'productivity_google_workspace',
            sameScopeBackgroundAllowed: false,
          },
        ],
      }),
    ).toEqual(
      expect.objectContaining({
        shouldActivate: false,
        reason: 'direct_action_owned_by_main_agent',
        suppressedByDirectActionOwnership: true,
      }),
    );

    expect(
      applyDirectActionOwnershipGate({
        shouldActivate: true,
        confidence: 0.91,
        reason: 'classifier_match',
        agentId: 'agent_productivity',
        activationScope: 'productivity_google_workspace',
        directActionSurfaceScopes: [
          {
            server: 'google-workspace',
            scopeKey: 'productivity_google_workspace',
            sameScopeBackgroundAllowed: true,
          },
        ],
      }),
    ).toEqual(
      expect.objectContaining({
        shouldActivate: true,
        reason: 'classifier_match',
      }),
    );
  });

  test('does not infer direct-action surfaces from undeclared tool-name suffixes', () => {
    const config = {
      viventium: {
        background_cortices: {
          activation_policy: {
            enabled: true,
            prompt: 'Policy text.',
            direct_action_mcp_servers: [
              {
                server: 'future-mcp',
                owns: 'future direct action',
                tool_names: ['future_action'],
              },
            ],
          },
        },
      },
    };
    const mainAgent = {
      tools: ['worker_run_mcp_glasshive-workers-projects'],
    };

    const result = buildActivationPolicySection({ config, mainAgent });

    expect(result.section).toContain('Policy text.');
    expect(result.section).not.toContain('future-mcp');
    expect(result.connectedSurfaces).toEqual([]);
  });

  test('renders the generic stricter activation policy without agent-name overfitting', () => {
    const policyPrompt = [
      'The main agent owns the current turn. Background agents are optional reviewers, not controllers.',
      "When this policy and this background agent's own activation criteria disagree, prefer the stricter outcome: do not activate.",
      'unless this same background agent received verified evidence in its own allowed context this turn.',
    ].join('\n\n');
    const config = {
      viventium: {
        background_cortices: {
          activation_policy: {
            enabled: true,
            prompt: policyPrompt,
          },
        },
      },
    };

    const result = buildActivationPolicySection({ config, mainAgent: { tools: [] } });

    expect(result.section).toContain('Background agents are optional reviewers, not controllers.');
    expect(result.section).toContain('prefer the stricter outcome: do not activate.');
    expect(result.section).toContain('verified evidence in its own allowed context');
    expect(result.section).not.toMatch(/emotional|user-help|product-help/i);
  });

  test('source-of-truth activation policy stays generic and agent-name agnostic', () => {
    const sourcePath = path.resolve(
      __dirname,
      '../../../../viventium/source_of_truth/local.librechat.yaml',
    );
    const source = yaml.load(fs.readFileSync(sourcePath, 'utf8'));
    const prompt = source?.viventium?.background_cortices?.activation_policy?.prompt || '';

    expect(prompt).toContain('Background agents are optional reviewers, not controllers.');
    expect(prompt).toContain('connected direct-action surface');
    expect(prompt).toContain('same_scope_background_allowed=true');
    expect(prompt).toContain('supplemental Phase B evidence');
    expect(prompt).toContain(
      'Return should_activate=true only when the latest request contains a separate explicit question or decision',
    );
    expect(prompt).toContain('If uncertain, return should_activate=false.');
    expect(prompt).not.toMatch(
      /Emotional Resonance|Confirmation Bias|Red Team|Pattern Recognition|Strategic Planning|Viventium User Help|Deep Research|product-help|user-help/i,
    );
  });

  test('source-of-truth policy does not declare generic reasoning tools as direct-action blockers', () => {
    const sourcePath = path.resolve(
      __dirname,
      '../../../../viventium/source_of_truth/local.librechat.yaml',
    );
    const source = yaml.load(fs.readFileSync(sourcePath, 'utf8'));
    const directActionServers =
      source?.viventium?.background_cortices?.activation_policy?.direct_action_mcp_servers || [];
    const declaredTools = directActionServers.flatMap((server) => server.tool_names || []);

    expect(directActionServers.map((server) => server.server)).toEqual(
      expect.arrayContaining([
        'glasshive-workers-projects',
        'scheduling-cortex',
        'google-workspace',
        'ms365',
      ]),
    );
    expect(directActionServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          server: 'google-workspace',
          scope_key: 'productivity_google_workspace',
        }),
        expect.objectContaining({ server: 'ms365', scope_key: 'productivity_ms365' }),
      ]),
    );
    expect(directActionServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          server: 'google-workspace',
          same_scope_background_allowed: true,
        }),
        expect.objectContaining({ server: 'ms365', same_scope_background_allowed: true }),
      ]),
    );
    expect(declaredTools).not.toContain('web_search');
    expect(declaredTools).not.toContain('file_search');
    expect(declaredTools).not.toContain('sequential-thinking');
  });

  test('normalizes string and object tool declarations', () => {
    expect(
      normalizeAgentToolNames({
        tools: [
          'web_search',
          { name: 'worker_run_mcp_glasshive-workers-projects' },
          { id: 'schedule_create' },
        ],
      }),
    ).toEqual(['web_search', 'worker_run_mcp_glasshive-workers-projects', 'schedule_create']);
  });

  test('formats LangChain-style _getType messages for activation context', () => {
    expect(
      formatHistoryForActivation(
        [
          {
            _getType: () => 'human',
            content: 'Please let Red Team run visibly.',
          },
          {
            _getType: () => 'ai',
            content: 'Understood.',
          },
        ],
        5,
      ),
    ).toContain('[User] Please let Red Team run visibly.');
  });

  test('hydrates canonical server-side tools for activation policy when request agent is sparse', async () => {
    const requestAgent = {
      id: 'agent_main',
      provider: 'anthropic',
      tools: [],
      background_cortices: [{ agent_id: 'agent_google' }],
    };
    const canonicalAgent = {
      id: 'agent_main',
      tools: [
        'sys__server__sys_mcp_google_workspace',
        'search_gmail_messages_mcp_google_workspace',
        'get_events_mcp_google_workspace',
      ],
    };

    const hydrated = await resolveActivationPolicyMainAgent({
      req: { user: { id: 'user_1' } },
      mainAgent: requestAgent,
      timeoutMs: 50,
      loadAgentFn: jest.fn().mockResolvedValue(canonicalAgent),
    });

    expect(hydrated).toEqual(
      expect.objectContaining({
        id: 'agent_main',
        tools: canonicalAgent.tools,
      }),
    );
    expect(hydrated.background_cortices).toEqual(requestAgent.background_cortices);
  });

  test('suppresses empty and no-response cortex output', () => {
    expect(hasVisibleCortexInsight('')).toBe(false);
    expect(hasVisibleCortexInsight('   {NTA}   ')).toBe(false);
    expect(hasVisibleCortexInsight('Real insight with {NTA} mentioned in a sentence.')).toBe(true);
  });

  test('marks no-response cortex completion as terminal but silent', () => {
    expect(
      buildCortexCompletionPayload({
        agentId: 'agent_google',
        agentName: 'Google Workspace',
        insight: '{NTA}',
        activationScope: 'productivity_google_workspace',
        configuredTools: 12,
        completedToolCalls: 0,
        confidence: 0.91,
        reason: 'gmail_request',
        cortexDescription: 'Checks Google Workspace.',
      }),
    ).toEqual({
      cortex_id: 'agent_google',
      cortex_name: 'Google Workspace',
      status: 'complete',
      insight: '',
      silent: true,
      no_response: true,
      activation_scope: 'productivity_google_workspace',
      configured_tools: 12,
      completed_tool_calls: 0,
      confidence: 0.91,
      reason: 'gmail_request',
      cortex_description: 'Checks Google Workspace.',
    });
  });

  test('keeps visible cortex completion renderable', () => {
    expect(
      buildCortexCompletionPayload({
        agentId: 'agent_research',
        agentName: 'Deep Research',
        insight: 'Useful supporting evidence.',
      }),
    ).toEqual(
      expect.objectContaining({
        cortex_id: 'agent_research',
        status: 'complete',
        insight: 'Useful supporting evidence.',
        silent: false,
        no_response: false,
      }),
    );
  });

  test('keeps terminal error completion metadata renderable', () => {
    expect(
      buildCortexCompletionPayload({
        agentId: 'agent_google',
        agentName: 'Google Workspace',
        error: 'timeout',
        activationScope: 'productivity_google_workspace',
        configuredTools: 12,
        completedToolCalls: 3,
        confidence: 0.91,
        reason: 'gmail_request',
        cortexDescription: 'Checks Google Workspace.',
        directActionSurfaceScopes: [
          {
            server: 'google-workspace',
            scopeKey: 'productivity_google_workspace',
            owns: 'Google Workspace',
            sameScopeBackgroundAllowed: true,
          },
        ],
      }),
    ).toEqual({
      cortex_id: 'agent_google',
      cortex_name: 'Google Workspace',
      status: 'error',
      error: 'This background agent timed out before returning a result.',
      error_class: 'timeout',
      activation_scope: 'productivity_google_workspace',
      configured_tools: 12,
      completed_tool_calls: 3,
      confidence: 0.91,
      reason: 'gmail_request',
      cortex_description: 'Checks Google Workspace.',
      direct_action_surface_scopes: [
        {
          server: 'google-workspace',
          scopeKey: 'productivity_google_workspace',
          owns: 'Google Workspace',
          sameScopeBackgroundAllowed: true,
        },
      ],
    });
  });

  test('classifies activation provider errors for actionable diagnostics', () => {
    expect(classifyActivationError({ status: 403, message: 'Access denied' })).toBe(
      'provider_access_denied',
    );
    expect(classifyActivationError({ status: 429, message: 'rate limit' })).toBe(
      'provider_rate_limited',
    );
    expect(
      summarizeActivationError({
        response: { status: 403 },
        code: 'ERR_BAD_REQUEST',
        message: 'Access denied',
      }),
    ).toEqual(
      expect.objectContaining({
        status: 403,
        class: 'provider_access_denied',
      }),
    );
  });

  test('temporarily suppresses unhealthy activation providers without prompt heuristics', () => {
    expect(
      markActivationProviderUnhealthy({
        provider: 'groq',
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        errorSummary: {
          class: 'provider_access_denied',
          status: 403,
          code: 'ERR_BAD_REQUEST',
          message: 'Access denied',
        },
      }),
    ).toBe(true);

    expect(
      getActivationProviderSuppression({
        provider: 'Groq',
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      }),
    ).toEqual(
      expect.objectContaining({
        provider: 'groq',
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        error: expect.objectContaining({ class: 'provider_access_denied' }),
      }),
    );

    expect(
      markActivationProviderUnhealthy({
        provider: 'openai',
        model: 'gpt-5.4',
        errorSummary: { class: 'provider_error', message: 'generic bad response' },
      }),
    ).toBe(false);
  });

  test('scopes user-auth activation provider suppression to the affected user', () => {
    const privateEmail = ['user-one', 'example.com'].join('@');
    const errorSummary = {
      class: 'provider_access_denied',
      status: 403,
      code: 'ERR_BAD_REQUEST',
      message: `Access denied for account ${privateEmail}`,
    };

    expect(
      markActivationProviderUnhealthy({
        provider: 'openai',
        model: 'gpt-5.4',
        errorSummary,
        req: { user: { id: 'user-one' } },
      }),
    ).toBe(true);

    expect(
      getActivationProviderSuppression({
        provider: 'openai',
        model: 'gpt-5.4',
        req: { user: { id: 'user-one' } },
      }),
    ).toEqual(
      expect.objectContaining({
        scope: 'user:user-one',
        error: { class: 'provider_access_denied', status: 403, code: 'ERR_BAD_REQUEST' },
      }),
    );
    expect(
      getActivationProviderSuppression({
        provider: 'openai',
        model: 'gpt-5.4',
        req: { user: { id: 'user-two' } },
      }),
    ).toBeNull();
  });

  test('probes one stale auth-class activation suppression only when every attempt is suppressed', () => {
    const attempts = [
      { provider: 'groq', model: 'llama', source: 'primary' },
      { provider: 'openai', model: 'gpt-5.4', source: 'fallback' },
    ];

    expect(
      shouldProbeSuppressedActivationAttempt({
        attempts,
        allAttemptsSuppressed: true,
        probeAlreadyUsed: false,
        providerSuppression: {
          error: { class: 'provider_unauthorized' },
        },
      }),
    ).toBe(true);

    expect(
      shouldProbeSuppressedActivationAttempt({
        attempts,
        allAttemptsSuppressed: true,
        probeAlreadyUsed: true,
        providerSuppression: {
          error: { class: 'provider_unauthorized' },
        },
      }),
    ).toBe(false);

    expect(
      shouldProbeSuppressedActivationAttempt({
        attempts,
        allAttemptsSuppressed: false,
        probeAlreadyUsed: false,
        providerSuppression: {
          error: { class: 'provider_unauthorized' },
        },
      }),
    ).toBe(false);

    expect(
      shouldProbeSuppressedActivationAttempt({
        attempts,
        allAttemptsSuppressed: true,
        probeAlreadyUsed: false,
        providerSuppression: {
          error: { class: 'provider_rate_limited' },
        },
      }),
    ).toBe(false);

    expect(
      shouldProbeSuppressedActivationAttempt({
        attempts,
        allAttemptsSuppressed: true,
        probeAlreadyUsed: false,
        providerSuppression: {
          error: { class: 'provider_access_denied' },
        },
      }),
    ).toBe(false);
  });

  test('does not let health suppression skip the primary activation provider', () => {
    const providerSuppression = {
      error: { class: 'provider_network' },
      until: Date.now() + 60000,
    };

    expect(
      shouldAttemptSuppressedActivationProvider({
        attempt: { provider: 'groq', model: 'llama', source: 'primary' },
        providerSuppression,
      }),
    ).toBe(true);

    expect(
      shouldAttemptSuppressedActivationProvider({
        attempt: { provider: 'xai', model: 'grok', source: 'fallback' },
        providerSuppression,
      }),
    ).toBe(false);
  });

  test('surfaces configured terminal cards only from source-owned failure visibility policy', () => {
    const providerAttempts = [
      {
        provider: 'groq',
        model: 'llama',
        source: 'primary',
        status: 'error',
        error: { class: 'provider_access_denied', status: 403, code: 'ERR_BAD_REQUEST' },
      },
      {
        provider: 'openai',
        model: 'gpt-5.4',
        source: 'fallback',
        status: 'skipped_unhealthy',
        error: { class: 'provider_unauthorized', status: 401, code: null },
      },
    ];

    expect(activationProviderAttemptsUnavailable(providerAttempts)).toBe(true);
    expect(
      activationFailureVisibility({ activation: { activation_failure_visibility: 'visible' } }),
    ).toBe('visible');
    expect(
      activationFailureVisibility({
        activation: { activation_failure_visibility: 'anything_else' },
      }),
    ).toBe('silent');
    expect(
      shouldSurfaceActivationProviderUnavailable({
        activationResult: { providerAttempts },
        cortexConfig: { activation: { activation_failure_visibility: 'visible' } },
      }),
    ).toBe(true);
    expect(
      shouldSurfaceActivationProviderUnavailable({
        activationResult: { providerAttempts },
        cortexConfig: { activation: { activation_failure_visibility: 'silent' } },
      }),
    ).toBe(false);
    expect(
      shouldSurfaceActivationTimeout({
        activationResult: { reason: 'global_timeout' },
        cortexConfig: { activation: { activation_failure_visibility: 'visible' } },
      }),
    ).toBe(false);
    expect(configuredCortexDisplayName({ agent_id: 'agent_viventium_red_team_95aeb3' })).toBe(
      'Red Team',
    );
    expect(
      buildCortexCompletionPayload({
        agentId: 'agent_confirmation_bias',
        agentName: 'Confirmation Bias',
        error: 'activation_provider_unavailable',
        errorClass: 'activation_provider_unavailable',
        reason: 'activation_provider_unavailable',
      }),
    ).toEqual(
      expect.objectContaining({
        cortex_name: 'Confirmation Bias',
        status: 'error',
        error_class: 'activation_provider_unavailable',
        error:
          'This background agent could not start because every configured activation provider was unavailable.',
      }),
    );
  });

  test('cortex completion errors are public-safe before rendering', () => {
    const privateEmail = ['user-one', 'example.com'].join('@');
    const privatePath = '/' + ['Users', 'example', 'project'].join('/');
    const bearerSecret = ['Bearer', 'abcdefghijklmnopqrstuvwxyz'].join(' ');
    const payload = buildCortexCompletionPayload({
      agentId: 'agent_private',
      agentName: 'Private Agent',
      error: `Provider failed for ${privateEmail} at ${privatePath} with ${bearerSecret}`,
    });

    expect(payload).toEqual(
      expect.objectContaining({
        status: 'error',
        error_class: 'recoverable_provider_error',
        error: 'This background agent hit a recoverable provider issue before returning a result.',
      }),
    );
    expect(JSON.stringify(payload)).not.toContain(privatePath);
    expect(JSON.stringify(payload)).not.toContain(privateEmail);
    expect(JSON.stringify(payload)).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  test('expires unhealthy activation provider suppression after the configured ttl', () => {
    const previousTtl = process.env.VIVENTIUM_ACTIVATION_PROVIDER_HEALTH_TTL_MS;
    const nowSpy = jest.spyOn(Date, 'now');
    try {
      process.env.VIVENTIUM_ACTIVATION_PROVIDER_HEALTH_TTL_MS = '100';
      nowSpy.mockReturnValue(1000);

      expect(
        markActivationProviderUnhealthy({
          provider: 'groq',
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          errorSummary: {
            class: 'provider_access_denied',
            status: 403,
            code: 'ERR_BAD_REQUEST',
            message: 'Access denied',
          },
        }),
      ).toBe(true);

      expect(
        getActivationProviderSuppression({
          provider: 'groq',
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        }),
      ).toEqual(expect.objectContaining({ provider: 'groq' }));

      nowSpy.mockReturnValue(1101);
      expect(
        getActivationProviderSuppression({
          provider: 'groq',
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        }),
      ).toBeNull();
    } finally {
      nowSpy.mockRestore();
      if (previousTtl == null) {
        delete process.env.VIVENTIUM_ACTIVATION_PROVIDER_HEALTH_TTL_MS;
      } else {
        process.env.VIVENTIUM_ACTIVATION_PROVIDER_HEALTH_TTL_MS = previousTtl;
      }
    }
  });

  test('removes unsupported sampling controls from OpenAI reasoning activation fallback', async () => {
    const llmConfig = await buildActivationLlmConfig({
      providerName: 'openai',
      model: 'gpt-5.4',
      req: null,
    });

    expect(llmConfig.temperature).toBeUndefined();
    expect(llmConfig.modelKwargs).toBeUndefined();
  });

  test('adds a bounded guard grace around each Phase B cortex attempt', () => {
    const previous = process.env.VIVENTIUM_CORTEX_EXECUTION_GUARD_GRACE_MS;
    process.env.VIVENTIUM_CORTEX_EXECUTION_GUARD_GRACE_MS = '5000';
    expect(getCortexAttemptGuardTimeoutMs(1000)).toBe(6000);
    process.env.VIVENTIUM_CORTEX_EXECUTION_GUARD_GRACE_MS = '120000';
    expect(getCortexAttemptGuardTimeoutMs(1000)).toBe(61000);
    if (previous == null) {
      delete process.env.VIVENTIUM_CORTEX_EXECUTION_GUARD_GRACE_MS;
    } else {
      process.env.VIVENTIUM_CORTEX_EXECUTION_GUARD_GRACE_MS = previous;
    }
  });

  test('scopes activation cooldowns to the request identity when message metadata is available', () => {
    const baseReq = {
      user: { id: 'user_1' },
      body: {
        conversationId: 'new',
        messageId: 'message_calendar',
      },
    };

    expect(
      buildActivationCooldownKey({
        agentId: 'agent_productivity',
        req: baseReq,
        runId: 'run_1',
      }),
    ).toBe('agent_productivity:user_1:message_calendar');

    expect(
      buildActivationCooldownKey({
        agentId: 'agent_productivity',
        req: {
          ...baseReq,
          body: {
            conversationId: 'new',
            messageId: 'message_email',
          },
        },
        runId: 'run_2',
      }),
    ).toBe('agent_productivity:user_1:message_email');

    expect(
      buildActivationCooldownKey({
        agentId: 'agent_productivity',
        req: {
          user: { id: 'user_1' },
          body: {
            conversationId: 'conversation_1',
            messageId: 'message_1',
          },
        },
        runId: 'run_3',
      }),
    ).toBe('agent_productivity:user_1:conversation_1:message_1');

    expect(
      buildActivationCooldownKey({
        agentId: 'agent_productivity',
        req: {
          user: { id: 'user_1' },
          body: {
            conversationId: 'new',
          },
        },
        runId: 'run_4',
      }),
    ).toBe('agent_productivity:user_1:run_4');
  });

  test('builds validated OpenAI fallback agent for background cortex execution', async () => {
    const fallbackAgent = await resolveBackgroundCortexFallbackAgent({
      req: {
        config: {
          endpoints: {
            agents: {
              allowedProviders: ['anthropic', 'openAI'],
            },
          },
        },
      },
      modelsConfig: {
        openAI: ['gpt-5.4'],
      },
      cortexAgent: {
        id: 'agent_viventium_confirmation_bias_95aeb3',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        model_parameters: {
          model: 'claude-sonnet-4-5',
          thinking: false,
        },
        fallback_llm_provider: 'openAI',
        fallback_llm_model: 'gpt-5.4',
        fallback_llm_model_parameters: {
          model: 'gpt-5.4',
          reasoning_effort: 'high',
        },
      },
    });

    expect(fallbackAgent).toEqual(
      expect.objectContaining({
        provider: 'openAI',
        model: 'gpt-5.4',
        endpoint: undefined,
      }),
    );
    expect(fallbackAgent.model_parameters).toEqual({
      model: 'gpt-5.4',
      reasoning_effort: 'high',
    });
  });
});
