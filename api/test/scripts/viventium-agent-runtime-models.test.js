const {
  DEFAULT_MODELS,
  APPROVED_MAIN_RUNTIME_FAMILIES,
  APPROVED_BACKGROUND_RUNTIME_FAMILIES,
  CANONICAL_BUILT_IN_BACKGROUND_MODEL_PARAMETERS,
  normalizeProvider,
  normalizeBundleForRuntime,
  buildCanonicalPersistedAgentFields,
  hasCanonicalPersistedAgentFieldDrift,
} = require('../../../scripts/viventium-agent-runtime-models');

describe('viventium-agent-runtime-models', () => {
  test('keeps the GPT-5.6 workload profile and Responses parameters as runtime truth', () => {
    expect(DEFAULT_MODELS.openAI).toBe('gpt-5.6-sol');
    expect([...APPROVED_MAIN_RUNTIME_FAMILIES]).toEqual([
      'openAI::gpt-5.6-sol',
      'anthropic::claude-opus-4-8',
    ]);
    expect([...APPROVED_BACKGROUND_RUNTIME_FAMILIES]).toEqual([
      'openAI::gpt-5.6-sol',
      'openAI::gpt-5.6-terra',
      'anthropic::claude-opus-4-8',
    ]);

    const expectedEffortByAgent = {
      agent_viventium_background_analysis_95aeb3: 'medium',
      agent_viventium_confirmation_bias_95aeb3: 'medium',
      agent_viventium_red_team_95aeb3: 'xhigh',
      agent_viventium_deep_research_95aeb3: 'xhigh',
      agent_viventium_online_tool_use_95aeb3: 'low',
      agent_viventium_parietal_cortex_95aeb3: 'medium',
      agent_viventium_pattern_recognition_95aeb3: 'medium',
      agent_viventium_emotional_resonance_95aeb3: 'low',
      agent_viventium_strategic_planning_95aeb3: 'high',
      agent_viventium_support_95aeb3: 'low',
      agent_8Y1d7JNhpubtvzYz3hvEv: 'low',
    };
    for (const [agentId, reasoningEffort] of Object.entries(expectedEffortByAgent)) {
      expect(CANONICAL_BUILT_IN_BACKGROUND_MODEL_PARAMETERS[agentId].openAI).toEqual({
        reasoning_effort: reasoningEffort,
        useResponsesApi: true,
      });
    }
  });

  test('treats poisoned string provider values as missing', () => {
    expect(normalizeProvider('undefined')).toBe('');
    expect(normalizeProvider(' null ')).toBe('');
    expect(normalizeProvider('Anthropic')).toBe('anthropic');
  });

  test('normalizes built-in agent and activation models from approved runtime env families', () => {
    const bundle = {
      mainAgent: {
        id: 'agent_viventium_main_95aeb3',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        voice_llm_provider: 'openAI',
        voice_llm_model: 'gpt-5.6-sol',
        background_cortices: [
          {
            agent_id: 'agent_viventium_red_team_95aeb3',
            activation: {
              provider: 'groq',
              model: 'qwen/qwen3.6-27b',
            },
          },
          {
            agent_id: 'agent_viventium_online_tool_use_95aeb3',
            activation: {
              provider: 'groq',
              model: 'qwen/qwen3.6-27b',
            },
          },
        ],
      },
      backgroundAgents: [
        {
          id: 'agent_viventium_online_tool_use_95aeb3',
          provider: 'openAI',
          model: 'gpt-5.6-terra',
          model_parameters: {
            model: 'gpt-5.6-terra',
          },
        },
      ],
    };

    const normalized = normalizeBundleForRuntime(bundle, {
      env: {
        VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER: 'openai',
        VIVENTIUM_FC_CONSCIOUS_LLM_MODEL: 'gpt-5.6-sol',
        VIVENTIUM_CORTEX_PRODUCTIVITY_LLM_PROVIDER: 'anthropic',
        VIVENTIUM_CORTEX_PRODUCTIVITY_LLM_MODEL: 'claude-opus-4-8',
        VIVENTIUM_BACKGROUND_ACTIVATION_PROVIDER: 'groq',
        VIVENTIUM_BACKGROUND_ACTIVATION_MODEL: 'qwen/qwen3.6-27b',
        OTUC_ACTIVATION_PROVIDER: 'groq',
        OTUC_ACTIVATION_LLM: 'qwen/qwen3.6-27b',
      },
    });

    expect(normalized.mainAgent.provider).toBe('openAI');
    expect(normalized.mainAgent.model).toBe('gpt-5.6-sol');
    expect(normalized.mainAgent.voice_llm_provider).toBeNull();
    expect(normalized.mainAgent.voice_llm_model).toBeNull();
    expect(normalized.backgroundAgents[0].provider).toBe('anthropic');
    expect(normalized.backgroundAgents[0].model).toBe('claude-opus-4-8');
    expect(normalized.backgroundAgents[0].model_parameters.model).toBe('claude-opus-4-8');
    expect(normalized.mainAgent.background_cortices[0].activation.provider).toBe('groq');
    expect(normalized.mainAgent.background_cortices[0].activation.model).toBe('qwen/qwen3.6-27b');
    expect(normalized.mainAgent.background_cortices[1].activation.provider).toBe('groq');
    expect(normalized.mainAgent.background_cortices[1].activation.model).toBe('qwen/qwen3.6-27b');
  });

  test('rejects non-approved built-in runtime assignments and preserves shipped launch bundle families', () => {
    const bundle = {
      mainAgent: {
        id: 'agent_viventium_main_95aeb3',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        model_parameters: {
          model: 'claude-opus-4-8',
        },
        background_cortices: [
          {
            agent_id: 'agent_viventium_red_team_95aeb3',
            activation: {
              provider: 'groq',
              model: 'qwen/qwen3.6-27b',
            },
          },
        ],
      },
      backgroundAgents: [
        {
          id: 'agent_viventium_red_team_95aeb3',
          provider: 'openAI',
          model: 'gpt-5.6-sol',
          model_parameters: {
            model: 'gpt-5.6-sol',
          },
        },
      ],
    };

    const normalized = normalizeBundleForRuntime(bundle, {
      env: {
        VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER: 'x_ai',
        VIVENTIUM_FC_CONSCIOUS_LLM_MODEL: 'grok-4.3',
        VIVENTIUM_CORTEX_RED_TEAM_LLM_PROVIDER: 'x_ai',
        VIVENTIUM_CORTEX_RED_TEAM_LLM_MODEL: 'grok-4.3',
        VIVENTIUM_BACKGROUND_ACTIVATION_PROVIDER: 'openai',
        VIVENTIUM_BACKGROUND_ACTIVATION_MODEL: 'gpt-4o-mini',
      },
    });

    expect(normalized.mainAgent.provider).toBe('anthropic');
    expect(normalized.mainAgent.model).toBe('claude-opus-4-8');
    expect(normalized.backgroundAgents[0].provider).toBe('openAI');
    expect(normalized.backgroundAgents[0].model).toBe('gpt-5.6-sol');
    expect(normalized.backgroundAgents[0].model_parameters).toEqual({
      model: 'gpt-5.6-sol',
      reasoning_effort: 'xhigh',
      useResponsesApi: true,
    });
    expect(normalized.mainAgent.background_cortices[0].activation.provider).toBe('groq');
    expect(normalized.mainAgent.background_cortices[0].activation.model).toBe('qwen/qwen3.6-27b');
  });

  test('builds a canonical persisted patch that repairs half-updated built-in runtime records', () => {
    const existingAgent = {
      id: 'agent_viventium_red_team_95aeb3',
      provider: 'openAI',
      model: 'gpt-4o',
      model_parameters: {
        model: 'gpt-5.4',
        thinkingBudget: 4000,
      },
      voice_llm_provider: null,
      voice_llm_model: null,
      voice_llm_model_parameters: {
        model: 'gpt-4o-mini',
        temperature: 0.7,
      },
    };

    const runtimeAgent = {
      id: 'agent_viventium_red_team_95aeb3',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      model_parameters: {
        thinkingBudget: 4000,
        model: 'claude-opus-4-7',
      },
      voice_llm_provider: 'anthropic',
      voice_llm_model: 'claude-haiku-4-5',
      voice_llm_model_parameters: {
        temperature: 0.2,
        max_output_tokens: 220,
      },
    };

    const patch = buildCanonicalPersistedAgentFields(runtimeAgent, existingAgent);

    expect(patch).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      model_parameters: {
        thinkingBudget: 4000,
        model: 'claude-opus-4-7',
      },
      voice_llm_provider: 'anthropic',
      voice_llm_model: 'claude-haiku-4-5',
      voice_llm_model_parameters: {
        model: 'claude-haiku-4-5',
        temperature: 0.2,
        max_output_tokens: 220,
      },
    });
    expect(hasCanonicalPersistedAgentFieldDrift(existingAgent, patch)).toBe(true);
    expect(
      hasCanonicalPersistedAgentFieldDrift(
        {
          ...existingAgent,
          ...patch,
        },
        patch,
      ),
    ).toBe(false);
  });

  test('buildCanonicalPersistedAgentFields prunes runtime-disabled tools from preserved live tool arrays', () => {
    const existingAgent = {
      id: 'agent_viventium_main_95aeb3',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      tools: [
        'sys__server__sys_mcp_scheduling-cortex',
        'file_search',
        'web_search',
        'search_gmail_messages_mcp_google_workspace',
      ],
      model_parameters: {
        model: 'claude-opus-4-7',
      },
    };

    const runtimeAgent = {
      id: 'agent_viventium_main_95aeb3',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      tools: [
        'sys__server__sys_mcp_scheduling-cortex',
        'schedule_create_mcp_scheduling-cortex',
        'file_search',
        'web_search',
        'search_gmail_messages_mcp_google_workspace',
      ],
      model_parameters: {
        model: 'claude-opus-4-7',
      },
    };

    const patch = buildCanonicalPersistedAgentFields(runtimeAgent, existingAgent, {
      env: {
        START_GOOGLE_MCP: 'false',
        START_MS365_MCP: 'false',
        START_GLASSHIVE: 'false',
        START_CODE_INTERPRETER: 'false',
        VIVENTIUM_WEB_SEARCH_ENABLED: 'false',
      },
    });

    expect(patch).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      tools: ['sys__server__sys_mcp_scheduling-cortex', 'file_search'],
      model_parameters: {
        model: 'claude-opus-4-7',
      },
    });
  });

  test('clears stale voice parameter bags when the runtime bundle removes the voice override', () => {
    const existingAgent = {
      id: 'agent_viventium_main_95aeb3',
      voice_llm_provider: 'anthropic',
      voice_llm_model: 'claude-haiku-4-5',
      voice_llm_model_parameters: {
        model: 'claude-haiku-4-5',
        temperature: 0.2,
      },
    };

    const runtimeAgent = {
      id: 'agent_viventium_main_95aeb3',
      voice_llm_provider: null,
      voice_llm_model: null,
    };

    const patch = buildCanonicalPersistedAgentFields(runtimeAgent, existingAgent);

    expect(patch).toEqual({
      voice_llm_provider: null,
      voice_llm_model: null,
      voice_llm_model_parameters: {},
    });
  });

  test('leaves the main agent voice override unset when no explicit fast voice provider is configured', () => {
    const bundle = {
      mainAgent: {
        id: 'agent_viventium_main_95aeb3',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        voice_llm_provider: null,
        voice_llm_model: null,
      },
    };

    const normalized = normalizeBundleForRuntime(bundle, {
      env: {
        VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER: 'anthropic',
        VIVENTIUM_FC_CONSCIOUS_LLM_MODEL: 'claude-opus-4-7',
      },
    });

    expect(normalized.mainAgent.voice_llm_provider).toBeNull();
    expect(normalized.mainAgent.voice_llm_model).toBeNull();
  });

  test('does not synthesize a dedicated voice override from machine fast-voice env alone', () => {
    const bundle = {
      mainAgent: {
        id: 'agent_viventium_main_95aeb3',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        voice_llm_provider: null,
        voice_llm_model: null,
      },
    };

    const normalized = normalizeBundleForRuntime(bundle, {
      env: {
        VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER: 'anthropic',
        VIVENTIUM_FC_CONSCIOUS_LLM_MODEL: 'claude-opus-4-7',
        VIVENTIUM_VOICE_FAST_LLM_PROVIDER: 'groq',
      },
    });

    expect(normalized.mainAgent.voice_llm_provider).toBeNull();
    expect(normalized.mainAgent.voice_llm_model).toBeNull();
  });

  test('preserves an explicit voice override even when legacy machine fast-voice env disagrees', () => {
    const bundle = {
      mainAgent: {
        id: 'agent_viventium_main_95aeb3',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        voice_llm_provider: 'xai',
        voice_llm_model: 'grok-4.20-experimental-beta-0304-non-reasoning',
      },
    };

    const normalized = normalizeBundleForRuntime(bundle, {
      env: {
        VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER: 'anthropic',
        VIVENTIUM_FC_CONSCIOUS_LLM_MODEL: 'claude-opus-4-7',
        VIVENTIUM_VOICE_FAST_LLM_PROVIDER: 'groq',
      },
    });

    expect(normalized.mainAgent.voice_llm_provider).toBe('xai');
    expect(normalized.mainAgent.voice_llm_model).toBe(
      'grok-4.20-experimental-beta-0304-non-reasoning',
    );
  });

  test('strips install-disabled Google, MS365, web search, and code tools during runtime normalization', () => {
    const bundle = {
      mainAgent: {
        id: 'agent_viventium_main_95aeb3',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        tools: [
          'sys__server__sys_mcp_google_workspace',
          'search_gmail_messages_mcp_google_workspace',
          'sys__server__sys_mcp_ms-365',
          'list-mail-messages_mcp_ms-365',
          'sys__server__sys_mcp_glasshive-workers-projects',
          'projects_list_mcp_glasshive-workers-projects',
          'execute_code',
          'web_search',
          'sys__server__sys_mcp_scheduling-cortex',
        ],
      },
      backgroundAgents: [
        {
          id: 'agent_8Y1d7JNhpubtvzYz3hvEv',
          provider: 'openAI',
          model: 'gpt-5.4',
          tools: ['search_gmail_messages_mcp_google_workspace', 'web_search'],
        },
      ],
    };

    const normalized = normalizeBundleForRuntime(bundle, {
      env: {
        VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER: 'anthropic',
        VIVENTIUM_FC_CONSCIOUS_LLM_MODEL: 'claude-opus-4-7',
        START_GOOGLE_MCP: 'false',
        START_MS365_MCP: 'false',
        START_GLASSHIVE: 'false',
        START_CODE_INTERPRETER: 'false',
        VIVENTIUM_WEB_SEARCH_ENABLED: 'false',
      },
    });

    expect(normalized.mainAgent.tools).toEqual(['sys__server__sys_mcp_scheduling-cortex']);
    expect(normalized.backgroundAgents[0].tools).toEqual([]);
  });

  test('keeps Deep Research web_search and xhigh reasoning effort when runtime web search is enabled', () => {
    const bundle = {
      mainAgent: {
        id: 'agent_viventium_main_95aeb3',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
      },
      backgroundAgents: [
        {
          id: 'agent_viventium_deep_research_95aeb3',
          provider: 'openAI',
          model: 'gpt-5.6-sol',
          tools: ['sys__server__sys_mcp_sequential-thinking', 'web_search'],
          model_parameters: {
            model: 'gpt-5.6-sol',
            reasoning_effort: 'xhigh',
          },
        },
      ],
    };

    const normalized = normalizeBundleForRuntime(bundle, {
      env: {
        VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER: 'anthropic',
        VIVENTIUM_FC_CONSCIOUS_LLM_MODEL: 'claude-opus-4-7',
        VIVENTIUM_CORTEX_DEEP_RESEARCH_LLM_PROVIDER: 'openAI',
        VIVENTIUM_CORTEX_DEEP_RESEARCH_LLM_MODEL: 'gpt-5.6-sol',
        VIVENTIUM_WEB_SEARCH_ENABLED: 'true',
      },
    });

    expect(normalized.backgroundAgents[0].tools).toEqual([
      'sys__server__sys_mcp_sequential-thinking',
      'web_search',
    ]);
    expect(normalized.backgroundAgents[0].model_parameters).toEqual({
      model: 'gpt-5.6-sol',
      reasoning_effort: 'xhigh',
      useResponsesApi: true,
    });
  });

  test('keeps Red Team web_search and xhigh reasoning effort when runtime web search is enabled', () => {
    const bundle = {
      mainAgent: {
        id: 'agent_viventium_main_95aeb3',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
      },
      backgroundAgents: [
        {
          id: 'agent_viventium_red_team_95aeb3',
          provider: 'openAI',
          model: 'gpt-5.6-sol',
          tools: ['sys__server__sys_mcp_sequential-thinking', 'web_search'],
          model_parameters: {
            model: 'gpt-5.6-sol',
            thinkingBudget: 4000,
          },
        },
      ],
    };

    const normalized = normalizeBundleForRuntime(bundle, {
      env: {
        VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER: 'anthropic',
        VIVENTIUM_FC_CONSCIOUS_LLM_MODEL: 'claude-opus-4-7',
        VIVENTIUM_CORTEX_RED_TEAM_LLM_PROVIDER: 'openAI',
        VIVENTIUM_CORTEX_RED_TEAM_LLM_MODEL: 'gpt-5.6-sol',
        VIVENTIUM_WEB_SEARCH_ENABLED: 'true',
      },
    });

    expect(normalized.backgroundAgents[0].tools).toEqual([
      'sys__server__sys_mcp_sequential-thinking',
      'web_search',
    ]);
    expect(normalized.backgroundAgents[0].model_parameters).toEqual({
      model: 'gpt-5.6-sol',
      reasoning_effort: 'xhigh',
      useResponsesApi: true,
    });
  });

  test('rewrites Deep Research onto the canonical Anthropic Opus execution bag when OpenAI is unavailable', () => {
    const bundle = {
      mainAgent: {
        id: 'agent_viventium_main_95aeb3',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
      },
      backgroundAgents: [
        {
          id: 'agent_viventium_deep_research_95aeb3',
          provider: 'openAI',
          model: 'gpt-5.4',
          model_parameters: {
            model: 'gpt-5.4',
            reasoning_effort: 'xhigh',
          },
        },
      ],
    };

    const normalized = normalizeBundleForRuntime(bundle, {
      env: {
        VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER: 'anthropic',
        VIVENTIUM_FC_CONSCIOUS_LLM_MODEL: 'claude-opus-4-8',
        VIVENTIUM_CORTEX_DEEP_RESEARCH_LLM_PROVIDER: 'anthropic',
        VIVENTIUM_CORTEX_DEEP_RESEARCH_LLM_MODEL: 'claude-opus-4-8',
      },
    });

    expect(normalized.backgroundAgents[0].provider).toBe('anthropic');
    expect(normalized.backgroundAgents[0].model).toBe('claude-opus-4-8');
    expect(normalized.backgroundAgents[0].model_parameters).toEqual({
      model: 'claude-opus-4-8',
      thinkingBudget: 4000,
    });
  });

  test('buildCanonicalPersistedAgentFields drops stale Anthropic reasoning keys when Strategic Planning rewrites to OpenAI', () => {
    const existingAgent = {
      id: 'agent_viventium_strategic_planning_95aeb3',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      model_parameters: {
        model: 'claude-opus-4-7',
        thinkingBudget: 2000,
      },
    };

    const runtimeAgent = {
      id: 'agent_viventium_strategic_planning_95aeb3',
      provider: 'openAI',
      model: 'gpt-5.6-sol',
      model_parameters: {
        model: 'gpt-5.6-sol',
      },
    };

    const patch = buildCanonicalPersistedAgentFields(runtimeAgent, existingAgent);

    expect(patch).toEqual({
      provider: 'openAI',
      model: 'gpt-5.6-sol',
      model_parameters: {
        model: 'gpt-5.6-sol',
        reasoning_effort: 'high',
        useResponsesApi: true,
      },
    });
  });

  test('buildCanonicalPersistedAgentFields drops stale OpenAI reasoning keys when Main rewrites to Anthropic', () => {
    const existingAgent = {
      id: 'agent_viventium_main_95aeb3',
      provider: 'openAI',
      model: 'gpt-5.2-chat',
      model_parameters: {
        model: 'gpt-5.2-chat',
        reasoning_effort: 'high',
      },
    };

    const runtimeAgent = {
      id: 'agent_viventium_main_95aeb3',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      model_parameters: {
        model: 'claude-opus-4-7',
        thinking: true,
        effort: 'high',
      },
    };

    const patch = buildCanonicalPersistedAgentFields(runtimeAgent, existingAgent);

    expect(patch).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      model_parameters: {
        model: 'claude-opus-4-7',
        thinking: true,
        effort: 'high',
      },
    });
  });

  test('buildCanonicalPersistedAgentFields drops stale runtime keys when Main already has the target family', () => {
    const existingAgent = {
      id: 'agent_viventium_main_95aeb3',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      model_parameters: {
        model: 'claude-opus-4-7',
        reasoning_effort: 'high',
        thinking: true,
        effort: 'high',
      },
    };

    const runtimeAgent = {
      id: 'agent_viventium_main_95aeb3',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      model_parameters: {
        model: 'claude-opus-4-7',
        thinking: true,
        effort: 'high',
      },
    };

    const patch = buildCanonicalPersistedAgentFields(runtimeAgent, existingAgent);

    expect(patch.model_parameters).toEqual({
      model: 'claude-opus-4-7',
      thinking: true,
      effort: 'high',
    });
  });
});
