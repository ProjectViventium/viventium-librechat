jest.mock('@librechat/agents', () => ({
  Run: {
    create: jest.fn(async () => ({
      processStream: jest.fn(async () => 'cortex-response'),
    })),
  },
  Providers: {
    OPENAI: 'openai',
    ANTHROPIC: 'anthropic',
    GOOGLE: 'google',
    AZURE_OPENAI: 'azure_openai',
    BEDROCK: 'bedrock',
  },
  createContentAggregator: jest.fn(() => ({
    contentParts: [],
    aggregateContent: jest.fn(),
  })),
  /* === VIVENTIUM START ===
   * Feature: Token count helpers for background cortex pruning tests.
   */
  getTokenCountForMessage: jest.fn(() => 1),
  /* === VIVENTIUM END === */
}));

jest.mock('@librechat/api', () => ({
  initializeAgent: jest.fn(),
  initializeAnthropic: jest.fn(async ({ model_parameters }) => ({
    llmConfig: {
      provider: 'anthropic',
      model: model_parameters?.model,
      temperature: model_parameters?.temperature,
      maxTokens: model_parameters?.maxOutputTokens,
    },
  })),
  createRun: jest.fn(),
  checkAccess: jest.fn(async () => true),
  memoryInstructions: 'The system automatically stores important user information.',
  extractFileContext: jest.fn(async ({ attachments }) => {
    const first = Array.isArray(attachments) ? attachments.find((f) => f && f.text) : null;
    if (!first) {
      return undefined;
    }
    return `Attached document(s):\n# \"${first.filename || 'file'}\"\n${first.text}`;
  }),
  countTokens: jest.fn(() => 1),
  /* === VIVENTIUM NOTE ===
   * Feature: Tokenizer mock for background cortex pruning tests.
   */
  Tokenizer: {
    getTokenCount: jest.fn(() => 1),
  },
  /* === VIVENTIUM NOTE === */
}));

jest.mock('~/server/services/Config/app', () => ({
  getAppConfig: jest.fn(async () => ({
    endpoints: {
      agents: {
        allowedProviders: ['openai', 'anthropic'],
      },
      custom: [
        {
          name: 'xai',
          apiKey: 'xai-test-key',
          baseURL: 'https://api.x.ai/v1',
        },
      ],
    },
  })),
}));

jest.mock('~/server/services/ToolService', () => ({
  loadAgentTools: jest.fn(async () => ({
    tools: [],
    toolContextMap: {},
    userMCPAuthMap: null,
  })),
}));

jest.mock('~/server/controllers/agents/callbacks', () => ({
  createToolEndCallback: jest.fn(() => jest.fn()),
  getDefaultHandlers: jest.fn(() => ({})),
}));

jest.mock('~/server/controllers/ModelController', () => ({
  getModelsConfig: jest.fn(async () => ({
    anthropic: ['claude-sonnet-4-6'],
    openAI: ['gpt-5.4'],
  })),
}));

jest.mock('~/config', () => ({
  getMCPManager: jest.fn(() => ({
    formatInstructionsForContext: jest.fn(async () => null),
  })),
}));

jest.mock('~/models', () => ({
  getFiles: jest.fn(),
  updateFilesUsage: jest.fn(),
  getUserKey: jest.fn(),
  getUserKeyValues: jest.fn(),
  getToolFilesByIds: jest.fn(),
  getFormattedMemories: jest.fn(async () => ({
    withKeys: '',
    withoutKeys: '',
    totalTokens: 0,
  })),
}));

jest.mock('~/models/Role', () => ({
  getRoleByName: jest.fn(async () => null),
}));

jest.mock('~/models/Agent', () => ({
  loadAgent: jest.fn(async ({ agent_id }) => ({
    id: agent_id,
    name: `Name:${agent_id}`,
    description: `Desc:${agent_id}`,
    provider: 'openai',
  })),
}));

const {
  detectActivations,
  checkCortexActivation,
  clearActivationCooldowns,
  executeCortex,
  executeActivated,
  formatHistoryForActivation,
  getCustomEndpointConfig,
  sanitizeCortexDisplayName,
} = require('~/server/services/BackgroundCortexService');
const { Run, createContentAggregator } = require('@librechat/agents');
const { initializeAgent, initializeAnthropic, createRun } = require('@librechat/api');
const { getAppConfig } = require('~/server/services/Config/app');
const { loadAgent } = require('~/models/Agent');

const PRODUCTIVITY_MS365_PROMPT = `You are a classifier. Decide whether to activate the MS365 (Microsoft) productivity tool agent.

SCOPE: This agent handles ONLY Microsoft 365 / Outlook / OneDrive. It does NOT handle Google Workspace, Gmail, Google Drive, Google Docs, Google Calendar, or any Google service.

MIXED-PROVIDER RULE:
- If the same user message asks for BOTH Microsoft and Google actions, you should STILL activate when there is a concrete Microsoft / Outlook / MS365 action in scope.
- Another cortex may activate in parallel for the Google portion of the same request.

RETURN "should_activate": false WHEN:
- The request is ONLY about Google / Gmail / Drive / Docs / Sheets / Calendar and contains no Microsoft / Outlook / MS365 action
- A shared link points only to a Google domain (docs.google.com, drive.google.com, etc.) and there is no Microsoft action request
- The user is only asking a capability question ("can you access my email?") rather than requesting an action`;

const PRODUCTIVITY_GOOGLE_PROMPT = `You are a classifier. Decide whether to activate the Google Workspace productivity tool agent.

SCOPE: This agent handles ONLY Google Workspace: Gmail, Google Drive, Google Docs, Google Sheets, Google Calendar, or any Google Workspace service.

MIXED-PROVIDER RULE:
- If the same user message asks for BOTH Google and Microsoft actions, you should STILL activate when there is a concrete Google Workspace action in scope.
- Another cortex may activate in parallel for the Microsoft portion of the same request.

RETURN "should_activate": false WHEN:
- The request is ONLY about Microsoft / Outlook / MS365 / Office 365 / OneDrive / Teams / Planner / OneNote and contains no Google Workspace action
- A shared link points only to a Microsoft domain (outlook.office.com, onedrive.live.com, sharepoint.com, etc.) and there is no Google action request
- The user is only asking a capability question ("can you access my email?") rather than requesting an action`;

describe('BackgroundCortexService.detectActivations', () => {
  test('enforces a hard global time budget (does not hang on slow activationRunner)', async () => {
    const start = Date.now();

    const res = await detectActivations({
      req: {},
      mainAgent: {
        provider: 'openai',
        background_cortices: [
          { agent_id: 'a1', activation: { enabled: true, intent_scope: 'productivity_google_workspace' } },
          { agent_id: 'a2', activation: { enabled: true } },
        ],
      },
      messages: [],
      runId: 'run-1',
      timeBudgetMs: 50,
      activationRunner: () => new Promise(() => {}),
    });

    const elapsed = Date.now() - start;

    // Full-suite worker contention can delay timer wakeups substantially; this check only
    // needs to prove we exit promptly instead of waiting on never-resolving activations.
    expect(elapsed).toBeLessThan(1000);
    expect(res.activatedCortices).toEqual([]);
    expect(res.timedOut).toBe(true);
  });

  test('returns activated cortices with best-effort name/description metadata', async () => {
    const activationRunner = async ({ cortexConfig }) => {
      if (cortexConfig.agent_id === 'a1') {
        return { shouldActivate: true, confidence: 0.9, reason: 'matched', agentId: 'a1' };
      }
      return { shouldActivate: false, confidence: 0.1, reason: 'nope', agentId: cortexConfig.agent_id };
    };

    const res = await detectActivations({
      req: {},
      mainAgent: {
        provider: 'openai',
        background_cortices: [
          { agent_id: 'a1', activation: { enabled: true, intent_scope: 'productivity_google_workspace' } },
          { agent_id: 'a2', activation: { enabled: true } },
        ],
      },
      messages: [],
      runId: 'run-2',
      timeBudgetMs: 200,
      activationRunner,
    });

    expect(res.timedOut).toBe(false);
    expect(res.activatedCortices).toHaveLength(1);
    expect(res.activatedCortices[0]).toEqual(
      expect.objectContaining({
        agentId: 'a1',
        activationScope: 'productivity_google_workspace',
        cortexName: 'Name:a1',
        cortexDescription: 'Desc:a1',
        reason: 'matched',
        confidence: 0.9,
      }),
    );
  });
});

describe('BackgroundCortexService config hygiene helpers', () => {
  const ORIGINAL_ENV = { ...process.env };
  const ORIGINAL_ENDPOINT_ENV = {
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GROQ_KEY: process.env.GROQ_KEY,
    GROQ_BASE_URL: process.env.GROQ_BASE_URL,
    GROQ_API_BASE_URL: process.env.GROQ_API_BASE_URL,
    SAMBANOVA_API_KEY: process.env.SAMBANOVA_API_KEY,
    SAMBANOVA_BASE_URL: process.env.SAMBANOVA_BASE_URL,
    SAMBANOVA_API_BASE_URL: process.env.SAMBANOVA_API_BASE_URL,
  };

  const restoreEndpointEnv = () => {
    for (const [key, value] of Object.entries(ORIGINAL_ENDPOINT_ENV)) {
      if (value == null) {
        delete process.env[key];
        continue;
      }
      process.env[key] = value;
    }
  };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    restoreEndpointEnv();
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    restoreEndpointEnv();
  });

  test('preserves configured cortex display names', () => {
    expect(sanitizeCortexDisplayName('Parietal Cortex')).toBe('Parietal Cortex');
    expect(sanitizeCortexDisplayName('Background Analysis')).toBe('Background Analysis');
    expect(sanitizeCortexDisplayName('')).toBe('Background Agent');
  });

  test('uses env-backed custom endpoint config without hardcoded Groq URL fallback', async () => {
    getAppConfig.mockRejectedValueOnce(new Error('config unavailable'));
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.GROQ_BASE_URL = 'https://groq.example.internal/openai/v1';

    await expect(getCustomEndpointConfig('groq', { user: { role: 'USER' } })).resolves.toEqual({
      apiKey: 'groq-test-key',
      baseURL: 'https://groq.example.internal/openai/v1',
    });
  });

  test('uses canonical Groq base URL when env fallback only has an API key', async () => {
    getAppConfig.mockRejectedValueOnce(new Error('config unavailable'));
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.GROQ_BASE_URL;
    delete process.env.GROQ_API_BASE_URL;

    await expect(getCustomEndpointConfig('groq', { user: { role: 'USER' } })).resolves.toEqual({
      apiKey: 'groq-test-key',
      baseURL: 'https://api.groq.com/openai/v1/',
    });
  });

  test('uses canonical Sambanova base URL when env fallback only has an API key', async () => {
    getAppConfig.mockRejectedValueOnce(new Error('config unavailable'));
    process.env.SAMBANOVA_API_KEY = 'sambanova-test-key';
    delete process.env.SAMBANOVA_BASE_URL;
    delete process.env.SAMBANOVA_API_BASE_URL;

    await expect(getCustomEndpointConfig('sambanova', { user: { role: 'USER' } })).resolves.toEqual({
      apiKey: 'sambanova-test-key',
      baseURL: 'https://api.sambanova.ai/v1/',
    });
  });

  test('uses env fallback when app config loads without a matching custom endpoint', async () => {
    getAppConfig.mockResolvedValueOnce({
      endpoints: {
        custom: [
          {
            name: 'xai',
            apiKey: 'xai-test-key',
            baseURL: 'https://api.x.ai/v1',
          },
        ],
      },
    });
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.GROQ_BASE_URL;
    delete process.env.GROQ_API_BASE_URL;

    await expect(getCustomEndpointConfig('groq', { user: { role: 'USER' } })).resolves.toEqual({
      apiKey: 'groq-test-key',
      baseURL: 'https://api.groq.com/openai/v1/',
    });
  });

  test('returns null when fallback key is missing entirely', async () => {
    getAppConfig.mockRejectedValueOnce(new Error('config unavailable'));
    delete process.env.GROQ_API_KEY;
    delete process.env.GROQ_KEY;
    delete process.env.GROQ_BASE_URL;
    delete process.env.GROQ_API_BASE_URL;

    await expect(getCustomEndpointConfig('groq', { user: { role: 'USER' } })).resolves.toBeNull();
  });
});

/* === VIVENTIUM NOTE ===
 * Tests: Activation history role labeling for LangChain messages.
 */
describe('BackgroundCortexService.formatHistoryForActivation', () => {
  test('labels human/ai messages and skips tool/system roles', () => {
    const messages = [
      { getType: () => 'system', content: 'System text' },
      { getType: () => 'human', content: 'User asks a question' },
      { getType: () => 'ai', content: [{ type: 'text', text: 'Assistant reply' }] },
      { getType: () => 'tool', content: 'Tool output' },
    ];

    const history = formatHistoryForActivation(messages, 5);

    expect(history).toContain('[User] User asks a question');
    expect(history).toContain('[Assistant] Assistant reply');
    expect(history).not.toContain('System text');
    expect(history).not.toContain('Tool output');
  });

  test('respects maxHistory on labeled lines', () => {
    const messages = [
      { getType: () => 'human', content: 'First' },
      { getType: () => 'ai', content: 'Second' },
      { getType: () => 'human', content: 'Third' },
    ];

    const history = formatHistoryForActivation(messages, 2);
    expect(history).not.toContain('First');
    expect(history).toContain('Second');
    expect(history).toContain('Third');
  });
});
/* === VIVENTIUM NOTE === */

/* === VIVENTIUM START ===
 * Regression: Mixed-provider inbox requests must not suppress both productivity cortices.
 */
describe('BackgroundCortexService.checkCortexActivation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearActivationCooldowns();
  });

  test('passes provider-clarification history to the activation classifier without deterministic preemption', async () => {
    const processStream = jest.fn(async ({ messages }) => {
      const prompt = messages[0]?.content || '';
      expect(prompt).toContain('[User] Check my inbox for replies from Joey.');
      expect(prompt).toContain('[Assistant] Gmail or Outlook?');
      expect(prompt).toContain('[User] Ms365');
      return JSON.stringify({ should_activate: true, confidence: 0.95, reason: 'matched clarification' });
    });

    Run.create.mockResolvedValueOnce({ processStream });

    const result = await checkCortexActivation({
      cortexConfig: {
        agent_id: 'agent_viventium_online_tool_use_95aeb3',
        activation: {
          enabled: true,
          provider: 'openai',
          model: 'gpt-5.4',
          intent_scope: 'productivity_ms365',
          prompt: PRODUCTIVITY_MS365_PROMPT,
        },
      },
      messages: [
        { role: 'user', content: 'Check my inbox for replies from Joey.' },
        { role: 'assistant', content: 'Gmail or Outlook?' },
        { role: 'user', content: 'Ms365' },
      ],
      runId: 'run-ms365-provider-only-prompt-context',
      req: { body: {}, user: {} },
    });

    expect(Run.create).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        shouldActivate: true,
        reason: 'matched clarification',
        agentId: 'agent_viventium_online_tool_use_95aeb3',
        providerUsed: 'openai',
      }),
    );
  });

  test('passes assistant live-email recap history to the activation classifier without semantic pruning', async () => {
    const processStream = jest.fn(async ({ messages }) => {
      const prompt = messages[0]?.content || '';
      expect(prompt).toContain('[User] Fair to say Contact A and Contact B ghosted?');
      expect(prompt).toContain(
        '[Assistant] Zero email activity in either direction for the last 30 days from or to either of them.',
      );
      expect(prompt).toContain('[User] Ms365');
      return JSON.stringify({ should_activate: true, confidence: 0.91, reason: 'matched recap' });
    });

    Run.create.mockResolvedValueOnce({ processStream });

    const result = await checkCortexActivation({
      cortexConfig: {
        agent_id: 'agent_viventium_online_tool_use_95aeb3',
        activation: {
          enabled: true,
          provider: 'openai',
          model: 'gpt-5.4',
          intent_scope: 'productivity_ms365',
          prompt: PRODUCTIVITY_MS365_PROMPT,
        },
      },
      messages: [
        { role: 'user', content: 'Fair to say Contact A and Contact B ghosted?' },
        {
          role: 'assistant',
          content:
            'Zero email activity in either direction for the last 30 days from or to either of them.',
        },
        { role: 'user', content: 'Ms365' },
      ],
      runId: 'run-ms365-provider-only-after-email-result',
      req: { body: {}, user: {} },
    });

    expect(Run.create).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        shouldActivate: true,
        reason: 'matched recap',
        agentId: 'agent_viventium_online_tool_use_95aeb3',
      }),
    );
  });

  test('falls back to later classifier providers on operational errors', async () => {
    const primaryProcessStream = jest.fn(async () => {
      const error = new Error('Groq billing restriction');
      error.response = { status: 402 };
      throw error;
    });
    const fallbackProcessStream = jest.fn(async () =>
      JSON.stringify({ should_activate: true, confidence: 0.93, reason: 'fallback matched' }),
    );

    Run.create
      .mockResolvedValueOnce({ processStream: primaryProcessStream })
      .mockResolvedValueOnce({ processStream: fallbackProcessStream });

    const result = await checkCortexActivation({
      cortexConfig: {
        agent_id: 'agent_viventium_online_tool_use_95aeb3',
        activation: {
          enabled: true,
          provider: 'groq',
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }],
          intent_scope: 'productivity_ms365',
          prompt: PRODUCTIVITY_MS365_PROMPT,
        },
      },
      messages: [{ role: 'user', content: 'Check my Outlook inbox and summarize anything urgent.' }],
      runId: 'run-ms365-fallback-chain',
      req: { body: {}, user: {} },
    });

    expect(Run.create).toHaveBeenCalledTimes(2);
    expect(result).toEqual(
      expect.objectContaining({
        shouldActivate: true,
        reason: 'fallback matched',
        providerUsed: 'openai',
      }),
    );
    expect(result.providerAttempts).toEqual([
      expect.objectContaining({
        provider: 'groq',
        status: 'error',
      }),
      expect.objectContaining({
        provider: 'openai',
        status: 'completed',
        shouldActivate: true,
      }),
    ]);
  });

  test('does not invoke fallback providers after a completed classifier decision', async () => {
    const processStream = jest.fn(async () =>
      JSON.stringify({ should_activate: false, confidence: 0.99, reason: 'chat_format' }),
    );

    Run.create.mockResolvedValueOnce({ processStream });

    const result = await checkCortexActivation({
      cortexConfig: {
        agent_id: 'agent_viventium_online_tool_use_95aeb3',
        activation: {
          enabled: true,
          provider: 'groq',
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          fallbacks: [
            { provider: 'openai', model: 'gpt-5.4' },
            { provider: 'anthropic', model: 'claude-haiku-4-5' },
          ],
          intent_scope: 'productivity_ms365',
          prompt: PRODUCTIVITY_MS365_PROMPT,
        },
      },
      messages: [{ role: 'user', content: 'Please reply with exactly DIRECT_OK and nothing else.' }],
      runId: 'run-ms365-no-fallback-after-decision',
      req: { body: {}, user: {} },
    });

    expect(Run.create).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        shouldActivate: false,
        reason: 'chat_format',
        providerUsed: 'groq',
      }),
    );
    expect(result.providerAttempts).toHaveLength(1);
  });

  test('uses Anthropic connected-account initialization with thinking disabled for activation checks', async () => {
    const processStream = jest.fn(async () =>
      JSON.stringify({ should_activate: true, confidence: 0.88, reason: 'anthropic matched' }),
    );

    Run.create.mockResolvedValueOnce({ processStream });

    const result = await checkCortexActivation({
      cortexConfig: {
        agent_id: 'agent_viventium_support_95aeb3',
        activation: {
          enabled: true,
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          prompt: 'Support activation prompt',
        },
      },
      messages: [{ role: 'user', content: 'How do I change my reminder schedule?' }],
      runId: 'run-anthropic-connected-account-activation',
      req: { body: {}, user: { id: 'user-123', role: 'USER' }, config: {} },
    });

    expect(initializeAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'anthropic',
        model_parameters: expect.objectContaining({
          model: 'claude-haiku-4-5',
          thinking: false,
          temperature: 0.1,
          maxOutputTokens: 100,
        }),
      }),
    );
    expect(Run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          llmConfig: expect.objectContaining({
            provider: 'anthropic',
            model: 'claude-haiku-4-5',
          }),
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        shouldActivate: true,
        providerUsed: 'anthropic',
      }),
    );
  });

  test('omits temperature for adaptive Anthropic activation checks on Sonnet 4.6', async () => {
    const processStream = jest.fn(async () =>
      JSON.stringify({ should_activate: true, confidence: 0.91, reason: 'adaptive anthropic matched' }),
    );

    Run.create.mockResolvedValueOnce({ processStream });

    await checkCortexActivation({
      cortexConfig: {
        agent_id: 'agent_pattern_recognition',
        activation: {
          enabled: true,
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          prompt: 'Pattern recognition activation prompt',
        },
      },
      messages: [{ role: 'user', content: 'Notice any patterns from my last few messages?' }],
      runId: 'run-anthropic-adaptive-activation',
      req: { body: {}, user: { id: 'user-123', role: 'USER' }, config: {} },
    });

    expect(initializeAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'anthropic',
        model_parameters: expect.objectContaining({
          model: 'claude-sonnet-4-6',
          thinking: false,
          maxOutputTokens: 100,
        }),
      }),
    );
    expect(initializeAnthropic.mock.calls.at(-1)[0].model_parameters).not.toHaveProperty('temperature');
    expect(Run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          llmConfig: expect.objectContaining({
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
          }),
        }),
      }),
    );
    expect(Run.create.mock.calls.at(-1)[0].graphConfig.llmConfig).not.toHaveProperty('temperature');
  });

  test('allows diagnostics to clear cooldown state between independent activation runs', async () => {
    const processStream = jest.fn(async () =>
      JSON.stringify({ should_activate: true, confidence: 0.97, reason: 'matched' }),
    );

    Run.create.mockResolvedValue({ processStream });

    const activationRequest = {
      cortexConfig: {
        agent_id: 'agent_viventium_support_95aeb3',
        activation: {
          enabled: true,
          provider: 'openai',
          model: 'gpt-5.4',
          cooldown_ms: 60_000,
          prompt: 'Support activation prompt',
        },
      },
      messages: [{ role: 'user', content: 'How do I create a recurring reminder?' }],
      runId: 'run-cooldown-reset',
      req: { body: { conversationId: 'c1' }, user: { id: 'user-123' } },
    };

    const first = await checkCortexActivation(activationRequest);
    const cooledDown = await checkCortexActivation(activationRequest);
    clearActivationCooldowns();
    const afterClear = await checkCortexActivation(activationRequest);

    expect(first).toEqual(expect.objectContaining({ shouldActivate: true }));
    expect(cooledDown).toEqual(
      expect.objectContaining({
        shouldActivate: false,
        reason: 'cooldown',
      }),
    );
    expect(afterClear).toEqual(expect.objectContaining({ shouldActivate: true }));
    expect(Run.create).toHaveBeenCalledTimes(2);
  });

  test('adds mixed-provider guidance for the MS365 productivity cortex', async () => {
    const processStream = jest.fn(async ({ messages }) => {
      const prompt = messages[0]?.content || '';
      expect(prompt).toContain('## Latest User Intent:');
      expect(prompt).toContain(
        'LatestUserMessage: check both outlook and gmail and summarize anything urgent',
      );
      expect(prompt).toContain('ActivationScopeKey: productivity_ms365');
      return JSON.stringify({ should_activate: true, confidence: 0.93, reason: 'matched' });
    });

    Run.create.mockResolvedValueOnce({ processStream });

    const result = await checkCortexActivation({
      cortexConfig: {
        agent_id: 'agent_viventium_online_tool_use_95aeb3',
        activation: {
          enabled: true,
          provider: 'openai',
          model: 'gpt-4o-mini',
          intent_scope: 'productivity_ms365',
          prompt: PRODUCTIVITY_MS365_PROMPT,
        },
      },
      messages: [
        { role: 'assistant', content: 'Which inboxes should I check?' },
        { role: 'user', content: 'check both outlook and gmail and summarize anything urgent' },
      ],
      runId: 'run-ms365-mixed',
      req: { body: {}, user: {} },
    });

    expect(result).toEqual(
      expect.objectContaining({
        shouldActivate: true,
        reason: 'matched',
        agentId: 'agent_viventium_online_tool_use_95aeb3',
      }),
    );
  });

  test('adds mixed-provider guidance for the Google productivity cortex', async () => {
    const processStream = jest.fn(async ({ messages }) => {
      const prompt = messages[0]?.content || '';
      expect(prompt).toContain('## Latest User Intent:');
      expect(prompt).toContain(
        'LatestUserMessage: check both outlook and gmail and summarize anything urgent',
      );
      expect(prompt).toContain('ActivationScopeKey: productivity_google_workspace');
      return JSON.stringify({ should_activate: true, confidence: 0.91, reason: 'matched' });
    });

    Run.create.mockResolvedValueOnce({ processStream });

    const result = await checkCortexActivation({
      cortexConfig: {
        agent_id: 'agent_8Y1d7JNhpubtvzYz3hvEv',
        activation: {
          enabled: true,
          provider: 'openai',
          model: 'gpt-4o-mini',
          intent_scope: 'productivity_google_workspace',
          prompt: PRODUCTIVITY_GOOGLE_PROMPT,
        },
      },
      messages: [
        { role: 'assistant', content: 'Which inboxes should I check?' },
        { role: 'user', content: 'check both outlook and gmail and summarize anything urgent' },
      ],
      runId: 'run-google-mixed',
      req: { body: {}, user: {} },
    });

    expect(result).toEqual(
      expect.objectContaining({
        shouldActivate: true,
        reason: 'matched',
        agentId: 'agent_8Y1d7JNhpubtvzYz3hvEv',
      }),
    );
  });

  test('uses the classifier path for Google live email status requests', async () => {
    const processStream = jest.fn(async () =>
      JSON.stringify({ should_activate: true, confidence: 0.94, reason: 'gmail inbox request' }),
    );

    Run.create.mockResolvedValueOnce({ processStream });

    const result = await checkCortexActivation({
      cortexConfig: {
        agent_id: 'agent_8Y1d7JNhpubtvzYz3hvEv',
        activation: {
          enabled: true,
          provider: 'openai',
          model: 'gpt-5.4',
          intent_scope: 'productivity_google_workspace',
          prompt: PRODUCTIVITY_GOOGLE_PROMPT,
        },
      },
      messages: [{ role: 'user', content: 'Check my Gmail inbox and summarize what happened in the past 10 days.' }],
      runId: 'run-google-live-email',
      req: { body: {}, user: {} },
    });

    expect(Run.create).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        shouldActivate: true,
        reason: 'gmail inbox request',
        agentId: 'agent_8Y1d7JNhpubtvzYz3hvEv',
      }),
    );
  });

  test('keeps structural conversation history for productivity activation prompts', async () => {
    const processStream = jest.fn(async ({ messages }) => {
      const prompt = messages[0]?.content || '';
      expect(prompt).toContain('LatestUserMessage: Please reply with exactly DIRECT_OK and nothing else.');
      expect(prompt).toContain('ActivationScopeKey: productivity_google_workspace');
      expect(prompt).toContain('now, check my gmail as well as my outlook');
      expect(prompt).toContain("I couldn't finish that check just now.");
      return JSON.stringify({ should_activate: false, confidence: 1, reason: 'simple reply' });
    });

    Run.create.mockResolvedValueOnce({ processStream });

    const result = await checkCortexActivation({
      cortexConfig: {
        agent_id: 'agent_8Y1d7JNhpubtvzYz3hvEv',
        activation: {
          enabled: true,
          provider: 'openai',
          model: 'gpt-4o-mini',
          intent_scope: 'productivity_google_workspace',
          prompt: PRODUCTIVITY_GOOGLE_PROMPT,
        },
      },
      messages: [
        {
          role: 'user',
          content:
            'now, check my gmail as well as my outlook to see whats been happenning in past 10 days and give me a full run down',
        },
        { role: 'assistant', content: "I couldn't finish that check just now." },
        { role: 'user', content: 'Please reply with exactly DIRECT_OK and nothing else.' },
      ],
      runId: 'run-google-direct-reply',
      req: { body: {}, user: {} },
    });

    expect(result).toEqual(
      expect.objectContaining({
        shouldActivate: false,
        reason: 'simple reply',
        agentId: 'agent_8Y1d7JNhpubtvzYz3hvEv',
      }),
    );
  });

  test('uses config-defined productivity scope instead of prompt-title or agent-name matching', async () => {
    const processStream = jest.fn(async ({ messages }) => {
      const prompt = messages[0]?.content || '';
      expect(prompt).toContain('ActivationScopeKey: productivity_google_workspace');
      return JSON.stringify({ should_activate: false, confidence: 1, reason: 'simple reply' });
    });

    Run.create.mockResolvedValueOnce({ processStream });

    const result = await checkCortexActivation({
      cortexConfig: {
        agent_id: 'custom_productivity_agent',
        activation: {
          enabled: true,
          provider: 'openai',
          model: 'gpt-4o-mini',
          intent_scope: 'productivity_google_workspace',
          prompt: 'You are a classifier. Decide whether to activate the productivity specialist.',
        },
      },
      messages: [{ role: 'user', content: 'Please reply with exactly DIRECT_OK and nothing else.' }],
      runId: 'run-google-config-scope',
      req: { body: {}, user: {} },
    });

    expect(result).toEqual(
      expect.objectContaining({
        shouldActivate: false,
        reason: 'simple reply',
        agentId: 'custom_productivity_agent',
      }),
    );
  });

  test('does not infer productivity scope from prompt-body exclusions when intent_scope is missing', async () => {
    const processStream = jest.fn(async () =>
      JSON.stringify({ should_activate: false, confidence: 0.2, reason: 'llm_scope_required' }),
    );

    Run.create.mockResolvedValueOnce({ processStream });

    const result = await checkCortexActivation({
      cortexConfig: {
        agent_id: 'agent_viventium_online_tool_use_95aeb3',
        activation: {
          enabled: true,
          provider: 'openai',
          model: 'gpt-4o-mini',
          prompt: PRODUCTIVITY_MS365_PROMPT,
        },
      },
      messages: [{ role: 'user', content: 'Check my Gmail inbox for the past 10 days.' }],
      runId: 'run-ms365-missing-scope',
      req: { body: {}, user: {} },
    });

    expect(Run.create).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        shouldActivate: false,
        reason: 'llm_scope_required',
        agentId: 'agent_viventium_online_tool_use_95aeb3',
      }),
    );
  });
});
/* === VIVENTIUM END === */

describe('BackgroundCortexService.executeCortex', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('runs via initializeAgent/createRun and returns aggregated insight', async () => {
    const processStream = jest.fn(async () => 'run-output');
    const initializedAgent = {
      id: 'agent_general',
      name: 'Background Analysis',
      tools: ['web_search'],
      userMCPAuthMap: null,
      recursion_limit: 11,
    };

    initializeAgent.mockResolvedValueOnce(initializedAgent);
    createRun.mockResolvedValueOnce({ processStream });

    createContentAggregator.mockReturnValueOnce({
      contentParts: [{ type: 'text', text: 'aggregated insight' }],
      aggregateContent: jest.fn(),
    });

    const messages = [
      { role: 'user', content: 'summarize the latest conversation' },
      { role: 'assistant', content: 'ok' },
    ];

    const res = await executeCortex({
      agent: {
        id: 'agent_general',
        name: 'Background Analysis',
        provider: 'anthropic',
        model: 'claude-opus-4-5',
        instructions: 'You are a cortex.',
      },
      messages,
      runId: 'run-tools',
      req: {
        user: { id: 'user-1', role: 'USER' },
        body: { conversationId: 'c1', parentMessageId: 'p1' },
      },
    });

    const initArgs = initializeAgent.mock.calls[0][0];
    expect(initArgs.allowedProviders.has('openai')).toBe(true);
    expect(initArgs.allowedProviders.has('anthropic')).toBe(true);

    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: [initializedAgent],
        requestBody: expect.objectContaining({ conversationId: 'c1', parentMessageId: 'p1' }),
        user: expect.objectContaining({ id: 'user-1' }),
        /* === VIVENTIUM NOTE ===
         * Ensure token counter/context map is provided for pruning.
         */
        tokenCounter: expect.any(Function),
        indexTokenCountMap: expect.any(Object),
        /* === VIVENTIUM NOTE === */
      }),
    );

    const callMessages = processStream.mock.calls[0][0].messages;
    expect(Array.isArray(callMessages)).toBe(true);
    expect(callMessages).toHaveLength(2);

    expect(processStream).toHaveBeenCalledWith(
      expect.objectContaining({ messages: expect.any(Array) }),
      expect.objectContaining({
        configurable: expect.objectContaining({
          requestBody: expect.objectContaining({
            conversationId: 'c1',
            parentMessageId: 'p1',
            messageId: 'run-tools',
          }),
          user: expect.objectContaining({ id: 'user-1' }),
        }),
      }),
    );

    expect(res).toEqual(
      expect.objectContaining({
        agentId: 'agent_general',
        agentName: 'Background Analysis',
        insight: 'aggregated insight',
      }),
    );
  });

  test('suppresses productivity insights when no live tool call completed', async () => {
    const processStream = jest.fn(async () => 'run-output');
    const initializedAgent = {
      id: 'agent_google',
      name: 'Google',
      tools: ['get_drive_file_content_mcp_google_workspace'],
      userMCPAuthMap: null,
      recursion_limit: 11,
      provider: 'openai',
    };

    initializeAgent.mockResolvedValueOnce(initializedAgent);
    createRun.mockResolvedValueOnce({ processStream });

    createContentAggregator.mockReturnValueOnce({
      contentParts: [{ type: 'text', text: 'I could not find any reply from Joey.' }],
      aggregateContent: jest.fn(),
    });

    const result = await executeCortex({
      agent: {
        id: 'agent_google',
        name: 'Google',
        provider: 'openai',
        model: 'gpt-5.4',
        activation: { intent_scope: 'productivity_google_workspace' },
        instructions:
          'Execute productivity tool operations. Do not reference memory systems or assumed prior context. Work only with what is provided.',
        tools: ['get_drive_file_content_mcp_google_workspace'],
      },
      messages: [{ role: 'user', content: 'Any replies from Joey yet?' }],
      runId: 'run-no-live-tool-execution',
      req: {
        user: { id: 'user-1', role: 'USER' },
        body: { conversationId: 'c1', parentMessageId: 'p1' },
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        agentId: 'agent_google',
        insight: null,
        error: 'no_live_tool_execution',
      }),
    );
  });

  test('executeActivated propagates config-defined activation scope into productivity execution guards', async () => {
    const processStream = jest.fn(async () => 'run-output');
    const onAllComplete = jest.fn();
    const initializedAgent = {
      id: 'agent_google',
      name: 'Google',
      tools: ['get_drive_file_content_mcp_google_workspace'],
      userMCPAuthMap: null,
      recursion_limit: 11,
      provider: 'openai',
    };

    initializeAgent.mockResolvedValueOnce(initializedAgent);
    createRun.mockResolvedValueOnce({ processStream });

    createContentAggregator.mockReturnValueOnce({
      contentParts: [{ type: 'text', text: "For a live update, I can't access Gmail directly." }],
      aggregateContent: jest.fn(),
    });

    await executeActivated({
      req: {
        user: { id: 'user-1', role: 'USER' },
        body: { conversationId: 'c1', parentMessageId: 'p1' },
      },
      res: null,
      mainAgent: { provider: 'openai' },
      messages: [{ role: 'user', content: 'Check my Gmail inbox for the past 10 days.' }],
      runId: 'run-activated-scope-pass-through',
      activatedCortices: [
        {
          agentId: 'agent_google',
          cortexName: 'Google',
          confidence: 1,
          reason: 'live_email_status_request:google_workspace',
          activationScope: 'productivity_google_workspace',
        },
      ],
      onAllComplete,
    });

    expect(onAllComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        insights: [],
        hasErrors: true,
        errors: [
          expect.objectContaining({
            cortexId: 'agent_google',
            error: 'no_live_tool_execution',
          }),
        ],
      }),
    );
  });

  test('executeActivated emits a silent terminal completion for no-response cortex output', async () => {
    const processStream = jest.fn(async () => '{NTA}');
    const onCortexComplete = jest.fn();
    const onAllComplete = jest.fn();
    const initializedAgent = {
      id: 'agent_plain',
      name: 'Plain Cortex',
      tools: [],
      userMCPAuthMap: null,
      recursion_limit: 11,
      provider: 'openai',
    };

    initializeAgent.mockResolvedValueOnce(initializedAgent);
    createRun.mockResolvedValueOnce({ processStream });

    createContentAggregator.mockReturnValueOnce({
      contentParts: [{ type: 'text', text: '{NTA}' }],
      aggregateContent: jest.fn(),
    });

    await executeActivated({
      req: {
        user: { id: 'user-1', role: 'USER' },
        body: { conversationId: 'c1', parentMessageId: 'p1' },
      },
      res: null,
      mainAgent: { provider: 'openai' },
      messages: [{ role: 'user', content: 'Check quietly.' }],
      runId: 'run-silent-cortex-completion',
      activatedCortices: [
        {
          agentId: 'agent_plain',
          cortexName: 'Plain Cortex',
          confidence: 1,
          reason: 'background_check',
        },
      ],
      onCortexComplete,
      onAllComplete,
    });

    expect(onCortexComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        cortex_id: 'agent_plain',
        cortex_name: 'Name:agent_plain',
        status: 'complete',
        insight: '',
        silent: true,
        no_response: true,
      }),
    );
    expect(onAllComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        insights: [],
        mergedPrompt: '',
        cortexCount: 0,
        hasErrors: false,
      }),
    );
  });

  test('executeActivated retries a configured fallback model after recoverable provider failure', async () => {
    const primaryProcessStream = jest.fn(async () => '');
    const fallbackProcessStream = jest.fn(async () => 'fallback-output');
    const onCortexComplete = jest.fn();
    const onAllComplete = jest.fn();

    loadAgent.mockResolvedValueOnce({
      id: 'agent_retry',
      name: 'Retry Cortex',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      model_parameters: {
        model: 'claude-sonnet-4-6',
        thinking: false,
      },
      fallback_llm_provider: 'openAI',
      fallback_llm_model: 'gpt-5.4',
      fallback_llm_model_parameters: {
        model: 'gpt-5.4',
        reasoning_effort: 'high',
      },
      tools: [],
    });
    initializeAgent
      .mockResolvedValueOnce({
        id: 'agent_retry',
        name: 'Retry Cortex',
        tools: [],
        userMCPAuthMap: null,
        recursion_limit: 11,
        provider: 'anthropic',
      })
      .mockResolvedValueOnce({
        id: 'agent_retry',
        name: 'Retry Cortex',
        tools: [],
        userMCPAuthMap: null,
        recursion_limit: 11,
        provider: 'openAI',
      });
    createRun
      .mockResolvedValueOnce({ processStream: primaryProcessStream })
      .mockResolvedValueOnce({ processStream: fallbackProcessStream });
    createContentAggregator
      .mockReturnValueOnce({
        contentParts: [{ type: 'error', error: 'Tool call failed with status 529 overloaded' }],
        aggregateContent: jest.fn(),
      })
      .mockReturnValueOnce({
        contentParts: [{ type: 'text', text: 'fallback-output' }],
        aggregateContent: jest.fn(),
      });

    await executeActivated({
      req: {
        user: { id: 'user-1', role: 'USER' },
        body: { conversationId: 'c1', parentMessageId: 'p1' },
      },
      res: null,
      mainAgent: { provider: 'anthropic' },
      messages: [{ role: 'user', content: 'Review this.' }],
      runId: 'run-fallback-retry',
      activatedCortices: [
        {
          agentId: 'agent_retry',
          cortexName: 'Retry Cortex',
          confidence: 1,
          reason: 'provider_recovery',
        },
      ],
      onCortexComplete,
      onAllComplete,
    });

    expect(createRun).toHaveBeenCalledTimes(2);
    expect(initializeAgent.mock.calls[1][0].agent).toEqual(
      expect.objectContaining({
        provider: 'openAI',
        model: 'gpt-5.4',
        model_parameters: {
          model: 'gpt-5.4',
          reasoning_effort: 'high',
        },
      }),
    );
    expect(onCortexComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        cortex_id: 'agent_retry',
        status: 'complete',
        insight: 'fallback-output',
      }),
    );
    expect(onAllComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        errors: undefined,
        insights: [
          expect.objectContaining({
            cortexName: 'Retry Cortex',
            insight: 'fallback-output',
          }),
        ],
      }),
    );
  });

  /* === VIVENTIUM NOTE ===
   * Ensure background cortices see the same "Existing memory about the user" context as the main agent.
   */
  test('injects existing user memory into cortex instructions when enabled', async () => {
    const processStream = jest.fn(async () => 'run-output');
    const initializedAgent = {
      id: 'agent_cortex',
      name: 'Background Analysis',
      tools: [],
      userMCPAuthMap: null,
      recursion_limit: 11,
    };

    const db = require('~/models');
    db.getFormattedMemories.mockResolvedValueOnce({
      withKeys: 'moments: ...',
      withoutKeys: '- moments: did x on 2026-02-07',
      totalTokens: 10,
    });

    initializeAgent.mockResolvedValueOnce(initializedAgent);
    createRun.mockResolvedValueOnce({ processStream });

    createContentAggregator.mockReturnValueOnce({
      contentParts: [{ type: 'text', text: 'aggregated insight' }],
      aggregateContent: jest.fn(),
    });

    await executeCortex({
      agent: {
        id: 'agent_cortex',
        name: 'Background Analysis',
        provider: 'openai',
        model: 'gpt-4o',
        instructions: 'You are a cortex.',
      },
      messages: [{ role: 'user', content: 'test' }],
      runId: 'run-cortex',
      req: {
        user: { id: 'user-1', role: 'USER' },
        config: {
          endpoints: { agents: { allowedProviders: ['openai'] } },
          memory: { disabled: false },
        },
        body: { conversationId: 'c1', parentMessageId: 'p1' },
      },
    });

    const initArgs = initializeAgent.mock.calls[0][0];
    expect(initArgs.agent.instructions).toContain('# Existing memory about the user:');
    expect(initArgs.agent.instructions).toContain('did x on 2026-02-07');
  });
  /* === VIVENTIUM NOTE === */

  /* === VIVENTIUM NOTE ===
   * Ensure background cortices see attached file context when available.
   */
  test('injects attached file context into cortex instructions when provided', async () => {
    const processStream = jest.fn(async () => 'run-output');
    const initializedAgent = {
      id: 'agent_cortex',
      name: 'Background Analysis',
      tools: [],
      userMCPAuthMap: null,
      recursion_limit: 11,
    };

    initializeAgent.mockResolvedValueOnce(initializedAgent);
    createRun.mockResolvedValueOnce({ processStream });

    createContentAggregator.mockReturnValueOnce({
      contentParts: [{ type: 'text', text: 'aggregated insight' }],
      aggregateContent: jest.fn(),
    });

    await executeCortex({
      agent: {
        id: 'agent_cortex',
        name: 'Background Analysis',
        provider: 'openai',
        model: 'gpt-4o',
        instructions: 'You are a cortex.',
      },
      messages: [{ role: 'user', content: 'summarize the attached doc' }],
      runId: 'run-cortex-files',
      req: {
        user: { id: 'user-1', role: 'USER' },
        config: {
          endpoints: { agents: { allowedProviders: ['openai'] } },
          memory: { disabled: false },
          fileConfig: { fileTokenLimit: 128 },
        },
        body: {
          conversationId: 'c1',
          parentMessageId: 'p1',
          fileTokenLimit: 128,
          files: [{ file_id: 'f1', filename: 'notes.md', source: 'text', text: 'hello world' }],
        },
      },
    });

    const initArgs = initializeAgent.mock.calls[0][0];
    expect(initArgs.agent.instructions).toContain('Attached document(s):');
    expect(initArgs.agent.instructions).toContain('notes.md');
    expect(initArgs.agent.instructions).toContain('hello world');
  });
  /* === VIVENTIUM NOTE === */

  /* === VIVENTIUM NOTE ===
   * Ensure tool call messages are preserved when content is empty.
   */
  test('preserves tool call sequences with empty assistant content', async () => {
    const { AIMessage, HumanMessage, ToolMessage } = require('@langchain/core/messages');
    const processStream = jest.fn(async () => 'run-output');
    const initializedAgent = {
      id: 'agent_tool',
      name: 'Online Tool Use',
      tools: ['sys__server__sys_mcp_ms-365'],
      userMCPAuthMap: { 'mcp:ms-365': { token: 'fake' } },
      recursion_limit: 11,
    };

    initializeAgent.mockResolvedValueOnce(initializedAgent);
    createRun.mockResolvedValueOnce({ processStream });

    createContentAggregator.mockReturnValueOnce({
      contentParts: [{ type: 'text', text: 'aggregated insight' }],
      aggregateContent: jest.fn(),
    });

    const toolCall = { id: 'call_1', name: 'web_search', args: { query: 'test' } };
    const aiWithTool = new AIMessage({ content: '', tool_calls: [toolCall] });
    const toolResult = new ToolMessage({
      content: 'tool output',
      tool_call_id: 'call_1',
      name: 'web_search',
    });

    const messages = [
      new HumanMessage({ content: 'check my inbox' }),
      aiWithTool,
      toolResult,
    ];

    await executeCortex({
      agent: {
        id: 'agent_tool',
        name: 'Online Tool Use',
        provider: 'openai',
        model: 'gpt-4o',
        instructions: 'You are a cortex.',
      },
      messages,
      runId: 'run-tools',
      req: {
        user: { id: 'user-1', role: 'USER' },
        body: { conversationId: 'c1', parentMessageId: 'p1' },
      },
    });

    const callMessages = processStream.mock.calls[0][0].messages;
    const toolIndex = callMessages.findIndex(
      (msg) => typeof msg.getType === 'function' && msg.getType() === 'tool',
    );
    expect(toolIndex).toBeGreaterThan(0);
    expect(callMessages[toolIndex - 1].tool_calls?.[0]?.id).toBe('call_1');
  });
  /* === VIVENTIUM NOTE === */

  /* === VIVENTIUM START ===
   * Root-cause regression: strict providers must not receive empty text blocks in Phase B.
   *
   * This validates the BackgroundCortexService execution path applies provider sanitization
   * before processStream for Anthropic.
   * === VIVENTIUM END === */
  test('sanitizes malformed empty text content for strict providers before processStream', async () => {
    const { HumanMessage } = require('@langchain/core/messages');
    const processStream = jest.fn(async () => 'run-output');
    const initializedAgent = {
      id: 'agent_tool',
      name: 'Online Tool Use',
      tools: [],
      userMCPAuthMap: null,
      recursion_limit: 11,
      provider: 'anthropic',
    };

    initializeAgent.mockResolvedValueOnce(initializedAgent);
    createRun.mockResolvedValueOnce({ processStream });

    createContentAggregator.mockReturnValueOnce({
      contentParts: [{ type: 'text', text: 'aggregated insight' }],
      aggregateContent: jest.fn(),
    });

    const messages = [
      new HumanMessage({
        content: [{ type: 'text', text: '   ' }],
      }),
    ];

    await executeCortex({
      agent: {
        id: 'agent_tool',
        name: 'Online Tool Use',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        instructions: 'You are a cortex.',
      },
      messages,
      runId: 'run-strict-sanitize',
      req: {
        user: { id: 'user-1', role: 'USER' },
        body: { conversationId: 'c1', parentMessageId: 'p1' },
      },
    });

    const callMessages = processStream.mock.calls[0][0].messages;
    expect(callMessages).toHaveLength(1);
    expect(callMessages[0].content).toBe('Context message.');
  });
  /* === VIVENTIUM NOTE === */

  test('removes Anthropic temperature when thinking is enabled before Phase B execution', async () => {
    const processStream = jest.fn(async () => 'run-output');
    const initializedAgent = {
      id: 'agent_confirmation',
      name: 'Confirmation Bias',
      tools: [],
      userMCPAuthMap: null,
      recursion_limit: 11,
      provider: 'anthropic',
    };

    initializeAgent.mockResolvedValueOnce(initializedAgent);
    createRun.mockResolvedValueOnce({ processStream });

    createContentAggregator.mockReturnValueOnce({
      contentParts: [{ type: 'text', text: 'aggregated insight' }],
      aggregateContent: jest.fn(),
    });

    await executeCortex({
      agent: {
        id: 'agent_confirmation',
        name: 'Confirmation Bias',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        instructions: 'You are a cortex.',
        model_parameters: {
          temperature: 0.3,
          thinking: { type: 'enabled', budget_tokens: 2048 },
        },
      },
      messages: [{ role: 'user', content: 'check my reasoning' }],
      runId: 'run-anthropic-thinking',
      req: {
        user: { id: 'user-1', role: 'USER' },
        body: { conversationId: 'c1', parentMessageId: 'p1', temperature: 0.3 },
      },
    });

    const initArgs = initializeAgent.mock.calls[0][0];
    expect(initArgs.agent.model_parameters.temperature).toBeUndefined();
    expect(initArgs.agent.model_parameters.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 2048,
    });
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.not.objectContaining({ temperature: expect.anything() }),
      }),
    );
  });
  /* === VIVENTIUM NOTE === */

  test('removes OpenAI reasoning sampling params before and after Phase B initialization', async () => {
    const processStream = jest.fn(async () => 'run-output');
    const initializedAgent = {
      id: 'agent_parietal',
      name: 'Parietal Cortex',
      tools: [],
      userMCPAuthMap: null,
      recursion_limit: 11,
      provider: 'openai',
      model_parameters: {
        model: 'gpt-5.4',
        temperature: 1,
        topP: 0.9,
        reasoning_effort: 'high',
      },
    };

    initializeAgent.mockResolvedValueOnce(initializedAgent);
    createRun.mockResolvedValueOnce({ processStream });

    createContentAggregator.mockReturnValueOnce({
      contentParts: [{ type: 'text', text: 'aggregated insight' }],
      aggregateContent: jest.fn(),
    });

    await executeCortex({
      agent: {
        id: 'agent_parietal',
        name: 'Parietal Cortex',
        provider: 'openAI',
        model: 'gpt-5.4',
        instructions: 'You are a cortex.',
        model_parameters: {
          model: 'gpt-5.4',
          temperature: 1,
          topP: 0.9,
          reasoning_effort: 'high',
        },
      },
      messages: [{ role: 'user', content: 'check the calculation' }],
      runId: 'run-openai-reasoning-sampling',
      req: {
        user: { id: 'user-1', role: 'USER' },
        body: {
          conversationId: 'c1',
          parentMessageId: 'p1',
          temperature: 1,
          top_p: 0.9,
        },
      },
    });

    const initArgs = initializeAgent.mock.calls[0][0];
    expect(initArgs.agent.model_parameters).toEqual({
      model: 'gpt-5.4',
      reasoning_effort: 'high',
    });

    const runArgs = createRun.mock.calls[0][0];
    expect(runArgs.agents[0].model_parameters).toEqual({
      model: 'gpt-5.4',
      reasoning_effort: 'high',
    });
    expect(runArgs.requestBody).toEqual(
      expect.not.objectContaining({
        temperature: expect.anything(),
        top_p: expect.anything(),
      }),
    );
  });
  /* === VIVENTIUM NOTE === */

  test('removes Anthropic temperature after initializeAgent hydrates default thinking for Phase B', async () => {
    const processStream = jest.fn(async () => 'run-output');
    const initializedAgent = {
      id: 'agent_emotional',
      name: 'Emotional Resonance',
      tools: [],
      userMCPAuthMap: null,
      recursion_limit: 11,
      provider: 'anthropic',
      model_parameters: {
        model: 'claude-opus-4-7',
        temperature: 0.4,
        thinking: { type: 'adaptive' },
      },
    };

    initializeAgent.mockResolvedValueOnce(initializedAgent);
    createRun.mockResolvedValueOnce({ processStream });

    createContentAggregator.mockReturnValueOnce({
      contentParts: [{ type: 'text', text: 'aggregated insight' }],
      aggregateContent: jest.fn(),
    });

    await executeCortex({
      agent: {
        id: 'agent_emotional',
        name: 'Emotional Resonance',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        instructions: 'You are a cortex.',
        model_parameters: {
          temperature: 0.4,
        },
      },
      messages: [{ role: 'user', content: 'how am I really feeling?' }],
      runId: 'run-anthropic-default-thinking',
      req: {
        user: { id: 'user-1', role: 'USER' },
        body: { conversationId: 'c1', parentMessageId: 'p1', temperature: 0.4 },
      },
    });

    const runArgs = createRun.mock.calls[0][0];
    expect(runArgs.agents[0].model_parameters.temperature).toBeUndefined();
    expect(runArgs.agents[0].model_parameters.thinking).toEqual({ type: 'adaptive' });
    expect(runArgs.requestBody).toEqual(
      expect.not.objectContaining({ temperature: expect.anything() }),
    );
  });
  /* === VIVENTIUM NOTE === */

  test('removes Anthropic temperature for a user-created cortex after initializeAgent hydrates default thinking', async () => {
    const processStream = jest.fn(async () => 'run-output');
    const initializedAgent = {
      id: 'agent_user_created',
      name: 'Custom Reviewer',
      tools: [],
      userMCPAuthMap: null,
      recursion_limit: 11,
      provider: 'anthropic',
      model_parameters: {
        model: 'claude-sonnet-4-6',
        temperature: 0.5,
        thinking: { type: 'enabled', budget_tokens: 2000 },
      },
    };

    initializeAgent.mockResolvedValueOnce(initializedAgent);
    createRun.mockResolvedValueOnce({ processStream });

    createContentAggregator.mockReturnValueOnce({
      contentParts: [{ type: 'text', text: 'aggregated insight' }],
      aggregateContent: jest.fn(),
    });

    await executeCortex({
      agent: {
        id: 'agent_user_created',
        name: 'Custom Reviewer',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        instructions: 'You are a custom cortex.',
        model_parameters: {
          temperature: 0.5,
        },
      },
      messages: [{ role: 'user', content: 'review my plan' }],
      runId: 'run-anthropic-user-agent-default-thinking',
      req: {
        user: { id: 'user-1', role: 'USER' },
        body: { conversationId: 'c1', parentMessageId: 'p1', temperature: 0.5 },
      },
    });

    const runArgs = createRun.mock.calls[0][0];
    expect(runArgs.agents[0].model_parameters.temperature).toBeUndefined();
    expect(runArgs.agents[0].model_parameters.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 2000,
    });
    expect(runArgs.requestBody).toEqual(
      expect.not.objectContaining({ temperature: expect.anything() }),
    );
  });
  /* === VIVENTIUM NOTE === */

  test('removes Anthropic temperature for adaptive-era Sonnet 4.6 even when thinking is explicitly disabled', async () => {
    const processStream = jest.fn(async () => 'run-output');
    const initializedAgent = {
      id: 'agent_user_disabled',
      name: 'Custom Reviewer',
      tools: [],
      userMCPAuthMap: null,
      recursion_limit: 11,
      provider: 'anthropic',
      model_parameters: {
        model: 'claude-sonnet-4-6',
        temperature: 0.5,
        thinking: false,
      },
    };

    initializeAgent.mockResolvedValueOnce(initializedAgent);
    createRun.mockResolvedValueOnce({ processStream });

    createContentAggregator.mockReturnValueOnce({
      contentParts: [{ type: 'text', text: 'aggregated insight' }],
      aggregateContent: jest.fn(),
    });

    await executeCortex({
      agent: {
        id: 'agent_user_disabled',
        name: 'Custom Reviewer',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        instructions: 'You are a custom cortex.',
        model_parameters: {
          temperature: 0.5,
          thinking: false,
        },
      },
      messages: [{ role: 'user', content: 'review my plan' }],
      runId: 'run-anthropic-user-agent-disabled-thinking',
      req: {
        user: { id: 'user-1', role: 'USER' },
        body: { conversationId: 'c1', parentMessageId: 'p1', temperature: 0.5 },
      },
    });

    const runArgs = createRun.mock.calls[0][0];
    expect(runArgs.agents[0].model_parameters.temperature).toBeUndefined();
    expect(runArgs.agents[0].model_parameters.thinking).toBe(false);
    expect(runArgs.requestBody).toEqual(
      expect.not.objectContaining({ temperature: expect.anything() }),
    );
  });
  /* === VIVENTIUM NOTE === */

  /* === VIVENTIUM NOTE ===
   * Productivity specialist cortices must ignore stale long-term context and prefer direct Google file IDs.
   */
  test('isolates productivity specialist cortices to the latest request and skips memory injection', async () => {
    const { HumanMessage, AIMessage } = require('@langchain/core/messages');
    const processStream = jest.fn(async () => 'run-output');
    const initializedAgent = {
      id: 'agent_google',
      name: 'Google',
      tools: ['get_drive_file_content_mcp_google_workspace'],
      userMCPAuthMap: null,
      recursion_limit: 11,
      provider: 'openai',
    };

    const db = require('~/models');
    db.getFormattedMemories.mockResolvedValueOnce({
      withKeys: 'world: old memory',
      withoutKeys: 'old memory that should not be injected',
      totalTokens: 12,
    });

    initializeAgent.mockResolvedValueOnce(initializedAgent);
    createRun.mockResolvedValueOnce({ processStream });

    createContentAggregator.mockReturnValueOnce({
      contentParts: [{ type: 'text', text: 'aggregated insight' }],
      aggregateContent: jest.fn(),
    });

    await executeCortex({
      agent: {
        id: 'agent_google',
        name: 'Google',
        provider: 'openai',
        model: 'gpt-5.4',
        activation: { intent_scope: 'productivity_google_workspace' },
        instructions:
          'Execute productivity tool operations. Do not reference memory systems or assumed prior context. Work only with what is provided.',
        tools: ['get_drive_file_content_mcp_google_workspace'],
      },
      messages: [
        new HumanMessage({ content: 'earlier request' }),
        new AIMessage({ content: 'I still cannot access the docs.' }),
        new HumanMessage({
          content:
            'Check https://docs.google.com/document/d/1Ki8pi6Yl9q0VZ_kv9CXTApe29Gx_ThAPYp9impNvG4c/edit and tell me what is in it.',
        }),
      ],
      runId: 'run-google-specialist',
      req: {
        user: { id: 'user-1', role: 'USER' },
        config: {
          endpoints: { agents: { allowedProviders: ['openai'] } },
          memory: { disabled: false },
        },
        body: { conversationId: 'c1', parentMessageId: 'p1' },
      },
    });

    const initArgs = initializeAgent.mock.calls[0][0];
    expect(initArgs.agent.instructions).toContain('# Productivity Specialist Runtime Context');
    expect(initArgs.agent.instructions).toContain(
      'Detected Google file IDs: 1Ki8pi6Yl9q0VZ_kv9CXTApe29Gx_ThAPYp9impNvG4c',
    );
    expect(initArgs.agent.instructions).not.toContain('# Existing memory about the user:');

    const callMessages = processStream.mock.calls[0][0].messages;
    expect(callMessages).toHaveLength(3);
    expect(callMessages[1].content).toContain('I still cannot access the docs.');
    expect(callMessages[2].content).toContain(
      'https://docs.google.com/document/d/1Ki8pi6Yl9q0VZ_kv9CXTApe29Gx_ThAPYp9impNvG4c/edit',
    );
  });
  /* === VIVENTIUM NOTE === */
});
