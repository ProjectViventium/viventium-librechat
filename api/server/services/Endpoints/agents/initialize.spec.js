/* === VIVENTIUM START ===
 * Feature: GlassHive handoff capability parity
 * Purpose: Prove Agent Builder handoff agents receive the same endpoint-declared, signed
 * workspace capability bundle as primary/fallback/background agents while ordinary handoffs
 * remain unchanged.
 * === VIVENTIUM END === */

const { Constants } = require('librechat-data-provider');

const mockInitializeAgent = jest.fn();
const mockGetAgent = jest.fn();
const mockBuildConversationProviderBootstrapBundle = jest.fn();
const mockLoadAgentTools = jest.fn();
const mockLoadToolsForExecution = jest.fn();
const mockProcessAddedConvo = jest.fn();
const mockGetDefaultHandlers = jest.fn();
const mockValidateAgentModel = jest.fn();
const mockResolveFallbackCandidates = jest.fn();
const mockIsFallbackModelValid = jest.fn();
const mockBuildFallbackAgent = jest.fn();
const mockIsSameAgentRoute = jest.fn();
const mockInitializePrimaryAgentWithFallback = jest.fn();
const mockPrimeFiles = jest.fn(async () => ({ files: [], toolContext: '' }));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('@librechat/agents', () => ({
  createContentAggregator: jest.fn(() => ({
    contentParts: [],
    aggregateContent: jest.fn(),
  })),
}));

jest.mock('@librechat/api', () => ({
  GenerationJobManager: { setCollectedUsage: jest.fn() },
  applyAgentProviderCapabilityDefaults: jest.fn((agent) => ({ ...agent })),
  createEdgeCollector: jest.fn((checkAgentInit) => {
    const edgeMap = new Map();
    const agentsToProcess = new Set();
    return {
      edgeMap,
      agentsToProcess,
      collectEdges: (edges = []) => {
        for (const edge of edges || []) {
          edgeMap.set(`${edge.from}:${edge.to}`, edge);
          const targets = Array.isArray(edge.to) ? edge.to : [edge.to];
          for (const target of targets) {
            if (target && !checkAgentInit(target)) {
              agentsToProcess.add(target);
            }
          }
        }
      },
    };
  }),
  createSequentialChainEdges: jest.fn(async () => []),
  filterOrphanedEdges: jest.fn((edges) => edges),
  getCustomEndpointConfig: jest.fn(() => ({})),
  initializeAgent: (...args) => mockInitializeAgent(...args),
  validateAgentModel: (...args) => mockValidateAgentModel(...args),
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    EModelEndpoint: { agents: 'agents' },
    getResponseSender: jest.fn(() => 'Synthetic Agent'),
    isAgentsEndpoint: jest.fn((endpoint) => endpoint === 'agents'),
    isEphemeralAgentId: jest.fn(() => false),
  };
});

jest.mock('~/server/controllers/agents/callbacks', () => ({
  createToolEndCallback: jest.fn(() => jest.fn()),
  getDefaultHandlers: (...args) => mockGetDefaultHandlers(...args),
}));
jest.mock('~/server/services/ToolService', () => ({
  loadAgentTools: (...args) => mockLoadAgentTools(...args),
  loadToolsForExecution: (...args) => mockLoadToolsForExecution(...args),
}));
jest.mock('~/server/controllers/ModelController', () => ({
  getModelsConfig: jest.fn(async () => ({})),
}));
jest.mock('~/server/controllers/agents/client', () =>
  jest.fn().mockImplementation((options) => ({ options })),
);
jest.mock('~/models/Conversation', () => ({ getConvoFiles: jest.fn(async () => []) }));
jest.mock('./addedConvo', () => ({
  processAddedConvo: (...args) => mockProcessAddedConvo(...args),
}));
jest.mock('~/models/Agent', () => ({
  getAgent: (...args) => mockGetAgent(...args),
}));
jest.mock('~/cache', () => ({ logViolation: jest.fn() }));
jest.mock('~/server/services/viventium/sanitizeAggregatedContentParts', () => ({
  sanitizeAggregatedContentParts: jest.fn(),
}));
jest.mock('~/server/services/viventium/voiceDeltaAggregation', () => ({
  extractVisibleTextFromContentParts: jest.fn(() => ''),
  repairMissedVisibleMessageDelta: jest.fn(() => false),
  repairMissedVoiceMessageDelta: jest.fn(() => false),
}));
/* === VIVENTIUM START ===
 * Test isolation: avoid loading the unrelated voice task database while exercising handoff init.
 * === VIVENTIUM END === */
jest.mock('~/server/services/viventium/VoiceTaskManagementTool', () => ({
  createManageActiveTasksTool: jest.fn(),
}));
jest.mock('~/models', () => ({
  getCodeGeneratedFiles: jest.fn(),
  getFiles: jest.fn(),
  getLatestRecallEligibleMessageCreatedAt: jest.fn(),
  getMessages: jest.fn(),
  getToolFilesByIds: jest.fn(),
  getUserCodeFiles: jest.fn(),
  getUserKey: jest.fn(),
  getUserKeyValues: jest.fn(),
  updateFilesUsage: jest.fn(),
  updateUserKey: jest.fn(),
}));
jest.mock('~/server/services/viventium/telegramTimingDeep', () => ({
  isDeepTimingEnabled: jest.fn(() => false),
}));
jest.mock('~/server/services/viventium/voiceLatencyTiming', () => ({
  calcVoiceLatencyDurationMs: jest.fn(() => 0),
  formatVoiceLatencyTiming: jest.fn(() => 'elapsed_ms=0'),
  voiceLatencyNow: jest.fn(() => 0),
}));
jest.mock('~/server/services/viventium/voiceLlmOverride', () => ({
  applyVoiceModelOverride: jest.fn(),
  isVoiceCallActive: jest.fn(() => false),
}));
jest.mock('~/server/services/viventium/agentLlmFallback', () => ({
  buildFallbackAgent: (...args) => mockBuildFallbackAgent(...args),
  inheritResolvedAgentGraph: jest.fn(),
  initializePrimaryAgentWithFallback: (...args) => mockInitializePrimaryAgentWithFallback(...args),
  isFallbackModelValid: (...args) => mockIsFallbackModelValid(...args),
  isSameAgentRoute: (...args) => mockIsSameAgentRoute(...args),
  resolveFallbackCandidates: (...args) => mockResolveFallbackCandidates(...args),
}));
jest.mock('~/server/services/viventium/agentGraphResilience', () => ({
  appendOmittedCapabilityReadiness: jest.fn(),
  evaluateOptionalAgentCapabilityReadiness: jest.fn(() => ({
    keep: true,
    declaredServers: [],
    readyServers: [],
    unavailableServers: [],
    unknownServers: [],
  })),
  markOptionalAgentInitializationFailed: jest.fn(),
  synchronizeFallbackGraphResilience: jest.fn(),
}));
jest.mock('~/server/services/viventium/scheduledAgentOverride', () => ({
  applyScheduledAgentOverride: jest.fn(),
}));
jest.mock('~/server/services/viventium/GlassHiveCapabilityBootstrapService', () => ({
  buildConversationProviderBootstrapBundle: (...args) =>
    mockBuildConversationProviderBootstrapBundle(...args),
}));
jest.mock('~/app/clients/tools/util/fileSearch', () => ({
  primeFiles: (...args) => mockPrimeFiles(...args),
}));

const { initializeClient } = require('./initialize');

const primaryAgent = {
  id: 'main-agent',
  name: 'Main Agent',
  provider: 'openAI',
  model: 'synthetic-main-model',
  edges: [{ from: 'main-agent', to: 'handoff-agent', edgeType: 'handoff' }],
};

function makeRequest() {
  return {
    body: {
      agent_id: primaryAgent.id,
      conversationId: 'conversation-synthetic',
      parentMessageId: 'message-synthetic',
    },
    config: {
      endpoints: {
        agents: {
          allowedProviders: ['openAI', 'glasshive-harness'],
          providerCapabilities: {
            openAI: { workspace_binding: false },
            'glasshive-harness': {
              workspace_binding: true,
              excluded_mcp_servers: ['glasshive-workers-projects'],
              host_tools_transport: 'broker_mcp',
              host_tools: ['file_search'],
            },
          },
        },
      },
    },
    user: { id: 'user-synthetic' },
  };
}

function makeInitializedConfig(agent) {
  return {
    ...agent,
    endpoint: agent.endpoint || agent.provider,
    model_parameters: {
      configuration: { defaultHeaders: { 'X-Existing': 'kept' } },
    },
    toolRegistry: new Map(),
    userMCPAuthMap: {},
  };
}

async function initializeWithHandoff(handoffAgent) {
  mockGetAgent.mockResolvedValue(handoffAgent);
  mockInitializeAgent.mockImplementation(async ({ agent }) => makeInitializedConfig(agent));
  const endpointOption = {
    agent: Promise.resolve({ ...primaryAgent }),
    model_parameters: { model: primaryAgent.model },
  };
  return initializeClient({ req: makeRequest(), res: {}, signal: null, endpointOption });
}

describe('initializeClient handoff capability projection', () => {
  const originalBrokerSecret = process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadAgentTools.mockResolvedValue({
      tools: [],
      toolDefinitions: [],
      toolRegistry: new Map(),
      userMCPAuthMap: {},
    });
    mockLoadToolsForExecution.mockResolvedValue({ loadedTools: [] });
    mockProcessAddedConvo.mockImplementation(async ({ userMCPAuthMap }) => ({ userMCPAuthMap }));
    mockGetDefaultHandlers.mockImplementation(({ toolExecuteOptions }) => ({
      invokeSyntheticTool: (toolNames, agentId) => toolExecuteOptions.loadTools(toolNames, agentId),
    }));
    mockValidateAgentModel.mockResolvedValue({ isValid: true });
    mockResolveFallbackCandidates.mockReturnValue([]);
    mockIsFallbackModelValid.mockReturnValue(true);
    mockIsSameAgentRoute.mockReturnValue(false);
    mockBuildFallbackAgent.mockImplementation((agent, assignment) => ({
      ...agent,
      endpoint: undefined,
      provider: assignment.provider,
      model: assignment.model,
      model_parameters: {
        ...agent.model_parameters,
        model: assignment.model,
      },
    }));
    mockInitializePrimaryAgentWithFallback.mockImplementation(
      async ({
        primaryAgent,
        fallbackAgent,
        fallbackAssignment,
        initializePrimary,
        initializeFallback,
        signal,
      }) => {
        try {
          return {
            config: await initializePrimary(),
            effectiveAgent: primaryAgent,
            fallbackUsed: false,
          };
        } catch (error) {
          if (signal?.aborted || !fallbackAgent || !fallbackAssignment || !initializeFallback) {
            throw error;
          }
          return {
            config: await initializeFallback(error),
            effectiveAgent: fallbackAgent,
            fallbackUsed: true,
            primaryError: error,
          };
        }
      },
    );
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = 'synthetic-bundle-secret';
    mockBuildConversationProviderBootstrapBundle.mockResolvedValue({
      glasshive_capability_broker: { allowed_servers: ['synthetic-connected-account'] },
    });
    mockPrimeFiles.mockResolvedValue({ files: [], toolContext: '' });
  });

  afterAll(() => {
    if (originalBrokerSecret === undefined) {
      delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
    } else {
      process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = originalBrokerSecret;
    }
  });

  test('attaches a signed bundle to a workspace-bound Agent Builder handoff', async () => {
    const handoffAgent = {
      id: 'handoff-agent',
      endpoint: 'glasshive-harness',
      provider: 'openAI',
      model: 'synthetic-worker-model',
      tools: [
        `search${Constants.mcp_delimiter}synthetic-connected-account`,
        `worker_run${Constants.mcp_delimiter}glasshive-workers-projects`,
      ],
      edges: [],
    };

    const { client } = await initializeWithHandoff(handoffAgent);
    const initializedHandoff = client.options.agentConfigs.get(handoffAgent.id);
    const headers = initializedHandoff.model_parameters.configuration.defaultHeaders;

    expect(headers['X-Existing']).toBe('kept');
    expect(headers['X-GlassHive-Bootstrap-Bundle-B64']).toBeDefined();
    expect(headers['X-GlassHive-Bootstrap-Timestamp']).toMatch(/^\d+$/);
    expect(headers['X-GlassHive-Bootstrap-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(
      Object.getOwnPropertyDescriptor(
        initializedHandoff,
        'viventiumConversationProviderCapabilityRefresh',
      ),
    ).toMatchObject({ enumerable: false, writable: false, value: expect.any(Function) });
    expect(initializedHandoff.viventiumHarnessCancellationEndpointConfig).toEqual({});
    expect(mockBuildConversationProviderBootstrapBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        user: { id: 'user-synthetic' },
        allowedServerNames: ['synthetic-connected-account'],
      }),
    );
  });

  test('leaves an ordinary Agent Builder handoff unchanged', async () => {
    const handoffAgent = {
      id: 'handoff-agent',
      endpoint: 'openAI',
      provider: 'openAI',
      model: 'synthetic-direct-model',
      tools: [`search${Constants.mcp_delimiter}synthetic-connected-account`],
      edges: [],
    };

    const { client } = await initializeWithHandoff(handoffAgent);
    const initializedHandoff = client.options.agentConfigs.get(handoffAgent.id);

    expect(initializedHandoff.model_parameters.configuration.defaultHeaders).toEqual({
      'X-Existing': 'kept',
    });
    expect(mockBuildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
    expect(initializedHandoff.viventiumConversationProviderCapabilityRefresh).toBeUndefined();
  });

  test('marks unavailable workspace capabilities instead of attaching an empty handoff bundle', async () => {
    mockBuildConversationProviderBootstrapBundle.mockResolvedValue({});
    const handoffAgent = {
      id: 'handoff-agent',
      endpoint: 'glasshive-harness',
      provider: 'openAI',
      model: 'synthetic-worker-model',
      tools: [`search${Constants.mcp_delimiter}synthetic-connected-account`],
      instructions: 'Base specialist instructions.',
      edges: [],
    };

    const { client } = await initializeWithHandoff(handoffAgent);
    const initializedHandoff = client.options.agentConfigs.get(handoffAgent.id);
    const headers = initializedHandoff.model_parameters.configuration.defaultHeaders;

    expect(initializedHandoff.instructions).toContain('host capability broker is unavailable');
    expect(headers['X-GlassHive-Bootstrap-Bundle-B64']).toBeUndefined();
    expect(headers['X-GlassHive-Bootstrap-Signature']).toBeUndefined();
  });

  test('fails a shared-mic turn closed before tools, handoffs, native capabilities, or controller execution initialize', async () => {
    const req = makeRequest();
    req.body.voiceMode = true;
    req.body.viventiumActorTrust = 'shared_mic_unverified';
    req.body.viventiumCanAuthorizeSideEffects = false;
    const sourceAgent = {
      ...primaryAgent,
      provider: 'glasshive-harness',
      endpoint: 'glasshive-harness',
      tools: [`send_email${Constants.mcp_delimiter}synthetic-connected-account`],
      background_cortices: [{ agent_id: 'side-effect-cortex' }],
      agent_ids: ['legacy-action-agent'],
      glasshive_options: { workspace: { mode: 'life' }, access: 'full' },
    };
    const endpointOption = {
      agent: Promise.resolve(sourceAgent),
      addedConvo: { endpoint: 'agents', agent_id: 'parallel-action-agent' },
      model_parameters: { model: sourceAgent.model },
    };
    mockInitializeAgent.mockImplementation(async ({ agent, loadTools, req: initReq }) => {
      await loadTools({
        req: initReq,
        res: {},
        agentId: agent.id,
        tools: agent.tools,
        provider: agent.provider,
        model: agent.model,
      });
      return {
        ...makeInitializedConfig(agent),
        tools: [{ name: 'synthetic_side_effect', invoke: jest.fn() }],
        toolDefinitions: [{ name: 'synthetic_side_effect' }],
        toolRegistry: new Map([['synthetic_side_effect', { invoke: jest.fn() }]]),
        userMCPAuthMap: { synthetic: { token: 'synthetic-never-used' } },
        background_cortices: [{ agent_id: 'side-effect-cortex' }],
        agent_ids: ['legacy-action-agent'],
        edges: [{ from: agent.id, to: 'handoff-agent', edgeType: 'handoff' }],
        glasshive_options: { workspace: { mode: 'life' }, access: 'full' },
        model_parameters: {
          configuration: {
            defaultHeaders: {
              'X-Existing': 'kept',
              'X-GlassHive-Agent-Id': 'synthetic-action-agent',
              'X-GlassHive-Access': 'full',
              'X-GlassHive-Bootstrap-Bundle-B64': 'synthetic-capability',
              'X-GlassHive-Bootstrap-Signature': 'sha256=synthetic',
            },
          },
        },
      };
    });

    const { client, userMCPAuthMap } = await initializeClient({
      req,
      res: {},
      signal: null,
      endpointOption,
    });
    const initialized = client.options.agent;

    expect(mockLoadAgentTools).not.toHaveBeenCalled();
    expect(mockGetAgent).not.toHaveBeenCalled();
    expect(mockProcessAddedConvo).not.toHaveBeenCalled();
    expect(mockBuildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
    expect(initialized.tools).toEqual([]);
    expect(initialized.toolDefinitions).toEqual([]);
    expect(initialized.toolRegistry).toEqual(new Map());
    expect(initialized.background_cortices).toEqual([]);
    expect(initialized.agent_ids).toEqual([]);
    expect(initialized.edges).toEqual([]);
    expect(initialized.glasshive_options).toBeUndefined();
    expect(initialized.model_parameters.configuration.defaultHeaders).toEqual({
      'X-Existing': 'kept',
    });
    expect(client.options.agentConfigs).toEqual(new Map());
    expect(userMCPAuthMap).toEqual({});
    await expect(
      client.options.eventHandlers.invokeSyntheticTool(['synthetic_side_effect'], sourceAgent.id),
    ).resolves.toEqual({ loadedTools: [] });
    expect(mockLoadToolsForExecution).not.toHaveBeenCalled();
    expect(req.body.viventiumDeferVoiceMemory).toBe(true);
    expect(req.body.suppressBackgroundCortices).toBe(true);
    expect(req._viventiumHarnessExecutionEnabled).toBe(false);
    expect(req._viventiumHarnessActivityEnabled).toBe(false);
    expect(req._viventiumHarnessIdempotencyKey).toBeUndefined();
  });

  test('prepares the handoff own validated fallback as hidden graph runtime state without loading tools twice', async () => {
    const handoffAgent = {
      id: 'handoff-agent',
      endpoint: 'openAI',
      provider: 'openAI',
      model: 'synthetic-primary-model',
      tools: [`search${Constants.mcp_delimiter}synthetic-connected-account`],
      fallback_llm_provider: 'glasshive-harness',
      fallback_llm_model: 'synthetic-fallback-model',
      edges: [],
    };
    const assignment = {
      provider: 'glasshive-harness',
      model: 'synthetic-fallback-model',
      source: 'agent',
      parametersField: 'fallback_llm_model_parameters',
    };
    mockResolveFallbackCandidates.mockImplementation((agent) =>
      agent.id === handoffAgent.id ? [assignment] : [],
    );

    const { client } = await initializeWithHandoff(handoffAgent);
    const initializedHandoff = client.options.agentConfigs.get(handoffAgent.id);
    const fallbackRoutes = initializedHandoff.viventiumGraphLlmFallbacks;
    const fallbackInitCall = mockInitializeAgent.mock.calls.find(
      ([params]) => params.agent?.provider === assignment.provider,
    );

    expect(fallbackRoutes).toHaveLength(1);
    expect(fallbackRoutes[0]).toMatchObject({
      id: handoffAgent.id,
      endpoint: assignment.provider,
      provider: assignment.provider,
      model: assignment.model,
    });
    expect(fallbackRoutes[0].model_parameters.configuration.defaultHeaders).toEqual(
      expect.objectContaining({
        'X-GlassHive-Bootstrap-Bundle-B64': expect.any(String),
        'X-GlassHive-Bootstrap-Signature': expect.stringMatching(/^sha256=[a-f0-9]{64}$/),
      }),
    );
    expect(fallbackRoutes[0].viventiumHarnessCancellationEndpointConfig).toEqual({});
    expect(
      Object.getOwnPropertyDescriptor(
        fallbackRoutes[0],
        'viventiumConversationProviderCapabilityRefresh',
      ),
    ).toMatchObject({ enumerable: false, writable: false, value: expect.any(Function) });
    expect(
      Object.prototype.propertyIsEnumerable.call(initializedHandoff, 'viventiumGraphLlmFallbacks'),
    ).toBe(false);
    expect(JSON.stringify(initializedHandoff)).not.toContain('viventiumGraphLlmFallbacks');
    expect(fallbackInitCall?.[0].loadTools).toBeUndefined();
    expect(mockInitializeAgent).toHaveBeenCalledTimes(3);
    expect(mockResolveFallbackCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ id: handoffAgent.id }),
      { isVoiceCall: false },
    );
  });

  test('mints a tool-less fallback bundle from the initialized participant host authority', async () => {
    const recallFile = { file_id: 'synthetic-file', filename: 'synthetic-evidence.txt' };
    const handoffAgent = {
      id: 'handoff-agent',
      endpoint: 'openAI',
      provider: 'openAI',
      model: 'synthetic-primary-model',
      tools: ['file_search'],
      fallback_llm_provider: 'glasshive-harness',
      fallback_llm_model: 'synthetic-fallback-model',
      edges: [],
    };
    const assignment = {
      provider: 'glasshive-harness',
      model: 'synthetic-fallback-model',
      source: 'agent',
      parametersField: 'fallback_llm_model_parameters',
    };
    mockResolveFallbackCandidates.mockImplementation((agent) =>
      agent.id === handoffAgent.id ? [assignment] : [],
    );
    mockPrimeFiles.mockResolvedValue({ files: [recallFile], toolContext: '' });
    mockInitializeAgent.mockImplementation(async ({ agent, loadTools }) => {
      const config = makeInitializedConfig(agent);
      if (agent.id === handoffAgent.id && typeof loadTools === 'function') {
        config.tools = [{ name: 'file_search' }];
        config.toolDefinitions = [{ name: 'file_search' }];
        config.toolRegistry = new Map([['file_search', { name: 'file_search' }]]);
        config.tool_resources = { file_search: { file_ids: [recallFile.file_id] } };
      } else if (agent.provider === assignment.provider) {
        config.tools = [];
        config.toolDefinitions = [];
        config.toolRegistry = new Map();
        config.tool_resources = {};
      }
      return config;
    });
    mockGetAgent.mockResolvedValue(handoffAgent);
    mockBuildConversationProviderBootstrapBundle.mockImplementation(
      async ({ allowedHostTools, hostToolResources }) => ({
        glasshive_capability_broker: {
          allowed_host_tools: allowedHostTools,
          host_tool_resources: hostToolResources,
        },
      }),
    );

    const { client } = await initializeClient({
      req: makeRequest(),
      res: {},
      signal: null,
      endpointOption: {
        agent: Promise.resolve({ ...primaryAgent }),
        model_parameters: { model: primaryAgent.model },
      },
    });
    const initializedHandoff = client.options.agentConfigs.get(handoffAgent.id);
    const [fallbackRoute] = initializedHandoff.viventiumGraphLlmFallbacks;
    const encodedBundle =
      fallbackRoute.model_parameters.configuration.defaultHeaders[
        'X-GlassHive-Bootstrap-Bundle-B64'
      ];
    const bundle = JSON.parse(Buffer.from(encodedBundle, 'base64').toString('utf8'));

    expect(bundle.glasshive_capability_broker.allowed_host_tools).toEqual(['file_search']);
    expect(bundle.glasshive_capability_broker.host_tool_resources).toEqual({
      file_search: { entity_id: handoffAgent.id, files: [recallFile] },
    });
    expect(mockInitializeAgent).toHaveBeenCalledTimes(3);
    expect(
      mockInitializeAgent.mock.calls.find(
        ([params]) => params.agent?.provider === assignment.provider,
      )?.[0].loadTools,
    ).toBeUndefined();
  });

  test('keeps a healthy handoff and its edge when optional fallback preparation fails', async () => {
    const handoffAgent = {
      id: 'handoff-agent',
      provider: 'openAI',
      model: 'synthetic-primary-model',
      fallback_llm_provider: 'glasshive-harness',
      fallback_llm_model: 'synthetic-fallback-model',
      edges: [],
    };
    const assignment = {
      provider: 'glasshive-harness',
      model: 'synthetic-fallback-model',
      source: 'agent',
      parametersField: 'fallback_llm_model_parameters',
    };
    mockResolveFallbackCandidates.mockImplementation((agent) =>
      agent.id === handoffAgent.id ? [assignment] : [],
    );
    mockGetAgent.mockResolvedValue(handoffAgent);
    mockInitializeAgent.mockImplementation(async ({ agent }) => {
      if (agent.provider === assignment.provider) {
        throw Object.assign(new Error('synthetic fallback unavailable'), { status: 503 });
      }
      return makeInitializedConfig(agent);
    });
    const endpointOption = {
      agent: Promise.resolve({ ...primaryAgent }),
      model_parameters: { model: primaryAgent.model },
    };

    const { client } = await initializeClient({
      req: makeRequest(),
      res: {},
      signal: null,
      endpointOption,
    });
    const initializedHandoff = client.options.agentConfigs.get(handoffAgent.id);

    expect(initializedHandoff).toMatchObject({
      id: handoffAgent.id,
      provider: handoffAgent.provider,
      model: handoffAgent.model,
    });
    expect(initializedHandoff.viventiumGraphLlmFallbacks).toBeUndefined();
    expect(client.options.agent.edges).toEqual(primaryAgent.edges);
  });

  test('recovers a handoff initialization failure through that handoff configured fallback', async () => {
    const handoffAgent = {
      id: 'handoff-agent',
      provider: 'openAI',
      model: 'synthetic-primary-model',
      tools: ['synthetic-target-tool'],
      fallback_llm_provider: 'glasshive-harness',
      fallback_llm_model: 'synthetic-fallback-model',
      edges: [],
    };
    const assignment = {
      provider: 'glasshive-harness',
      model: 'synthetic-fallback-model',
      source: 'agent',
      parametersField: 'fallback_llm_model_parameters',
    };
    mockResolveFallbackCandidates.mockImplementation((agent) =>
      agent.id === handoffAgent.id ? [assignment] : [],
    );
    mockGetAgent.mockResolvedValue(handoffAgent);
    mockInitializeAgent.mockImplementation(async ({ agent, loadTools }) => {
      if (agent.id === handoffAgent.id && agent.provider === handoffAgent.provider) {
        throw Object.assign(new Error('synthetic primary rate limit'), { status: 429 });
      }
      return {
        ...makeInitializedConfig(agent),
        initializedWithTargetTools: typeof loadTools === 'function',
      };
    });
    const endpointOption = {
      agent: Promise.resolve({ ...primaryAgent }),
      model_parameters: { model: primaryAgent.model },
    };

    const { client } = await initializeClient({
      req: makeRequest(),
      res: {},
      signal: null,
      endpointOption,
    });
    const initializedHandoff = client.options.agentConfigs.get(handoffAgent.id);

    expect(initializedHandoff).toMatchObject({
      id: handoffAgent.id,
      provider: assignment.provider,
      model: assignment.model,
      initializedWithTargetTools: true,
    });
    expect(initializedHandoff.viventiumGraphLlmFallbacks).toBeUndefined();
    expect(mockInitializeAgent).toHaveBeenCalledTimes(3);
  });

  test('ignores same-route and invalid handoff fallback candidates without preparing either', async () => {
    const handoffAgent = {
      id: 'handoff-agent',
      provider: 'openAI',
      model: 'synthetic-primary-model',
      edges: [],
    };
    const sameRoute = {
      provider: 'openAI',
      model: 'synthetic-primary-model',
      source: 'agent',
      parametersField: 'fallback_llm_model_parameters',
    };
    const invalidRoute = {
      provider: 'glasshive-harness',
      model: 'not-in-catalog',
      source: 'agent',
      parametersField: 'fallback_llm_model_parameters',
    };
    mockResolveFallbackCandidates.mockImplementation((agent) =>
      agent.id === handoffAgent.id ? [sameRoute, invalidRoute] : [],
    );
    mockIsSameAgentRoute.mockImplementation((_agent, candidate) => candidate === sameRoute);
    mockIsFallbackModelValid.mockImplementation((model) => model !== invalidRoute.model);

    const { client } = await initializeWithHandoff(handoffAgent);
    const initializedHandoff = client.options.agentConfigs.get(handoffAgent.id);

    expect(initializedHandoff.viventiumGraphLlmFallbacks).toBeUndefined();
    expect(mockBuildFallbackAgent).not.toHaveBeenCalled();
    expect(mockInitializeAgent).toHaveBeenCalledTimes(2);
  });
});
