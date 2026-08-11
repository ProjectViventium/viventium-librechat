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
  validateAgentModel: jest.fn(async () => ({ isValid: true })),
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
  buildFallbackAgent: jest.fn(),
  inheritResolvedAgentGraph: jest.fn(),
  initializePrimaryAgentWithFallback: jest.fn(async ({ primaryAgent, initializePrimary }) => ({
    config: await initializePrimary(),
    effectiveAgent: primaryAgent,
    fallbackUsed: false,
  })),
  isFallbackModelValid: jest.fn(() => true),
  isSameAgentRoute: jest.fn(() => false),
  resolveFallbackCandidates: jest.fn(() => []),
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
  primeFiles: jest.fn(async () => ({ files: [], toolContext: '' })),
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
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = 'synthetic-bundle-secret';
    mockBuildConversationProviderBootstrapBundle.mockResolvedValue({
      glasshive_capability_broker: { allowed_servers: ['synthetic-connected-account'] },
    });
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
});
