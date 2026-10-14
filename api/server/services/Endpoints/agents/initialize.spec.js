/* === VIVENTIUM START ===
 * Feature: GlassHive handoff capability parity
 * Purpose: Prove Agent Builder handoff agents receive the same endpoint-declared, signed
 * workspace capability bundle as primary/fallback/background agents while ordinary handoffs
 * remain unchanged.
 * === VIVENTIUM END === */

const { Constants } = require('librechat-data-provider');
const { Types } = require('mongoose');

const mockInitializeAgent = jest.fn();
const mockGetAgent = jest.fn();
const mockLoadAgent = jest.fn();
const mockBuildConversationProviderBootstrapBundle = jest.fn();
const mockCheckPermission = jest.fn();
const mockValidateAgentModel = jest.fn();
const mockResolveFallbackCandidates = jest.fn();
const mockIsFallbackModelValid = jest.fn();
const mockBuildFallbackAgent = jest.fn();
const mockIsSameAgentRoute = jest.fn();
const mockInitializePrimaryAgentWithFallback = jest.fn();
const mockPrimeFiles = jest.fn(async () => ({ files: [], toolContext: '' }));
const mockLoadAgentTools = jest.fn(async () => ({ toolDefinitions: [] }));
const mockStartParallelWorkTurnAuthority = jest.fn();
const mockApplyVoiceModelOverride = jest.fn();
const mockObserveOrchestrationOwner = jest.fn();
const mockEffectiveOrchestrationMode = jest.fn(() => 'parallel');

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  createContentAggregator: jest.fn(() => ({
    contentParts: [],
    aggregateContent: jest.fn(),
  })),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  configureOrchestrationMode: jest.fn(),
  projectTrustedNativeInteractionHeaders: jest.fn((_req, headers) => headers ?? {}),
  projectTrustedClientPresentation: jest.fn((body) => body ?? {}),
  trustedUploadedFilesFromRequestBody: jest.fn((body) => body?.files ?? []),
  transcriptionAttachmentReferences: jest.fn(() => []),
  resolveSelectedHistoryAttachments: jest.fn(async () => []),
  configuredBackgroundWorkerRoute: jest.fn(() => null),
  GenerationJobManager: { setCollectedUsage: jest.fn(), getJob: jest.fn(), abortJob: jest.fn() },
  retainAggregatedDeliveryDisposition: jest.fn(),
  observeOrchestrationOwner: (...args) => mockObserveOrchestrationOwner(...args),
  effectiveOrchestrationMode: (...args) => mockEffectiveOrchestrationMode(...args),
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
  isEnabled: jest.fn(() => false),
  isUserProvided: jest.fn(() => false),
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
    isUserProvided: jest.fn((value) => Boolean(value)),
  };
});

jest.mock('~/server/controllers/agents/callbacks', () => ({
  createToolEndCallback: jest.fn(() => jest.fn()),
  getDefaultHandlers: jest.fn(() => ({})),
}));
jest.mock('~/server/services/ToolService', () => ({
  loadAgentTools: (...args) => mockLoadAgentTools(...args),
  loadToolsForExecution: jest.fn(async () => ({ loadedTools: [] })),
  startParallelWorkTurnAuthority: (...args) => mockStartParallelWorkTurnAuthority(...args),
}));
jest.mock('~/server/controllers/ModelController', () => ({
  getModelsConfig: jest.fn(async () => ({})),
}));
jest.mock('~/server/controllers/agents/client', () =>
  jest.fn().mockImplementation((options) => ({ options })),
);
jest.mock('~/models/Conversation', () => ({ getConvoFiles: jest.fn(async () => []) }));
jest.mock('./addedConvo', () => ({
  processAddedConvo: jest.fn(async ({ userMCPAuthMap }) => ({ userMCPAuthMap })),
}));
jest.mock('~/models/Agent', () => ({
  loadAgent: (...args) => mockLoadAgent(...args),
  getAgent: async (...args) => {
    const agent = await mockGetAgent(...args);
    return agent ? { _id: agent._id ?? agent.id, ...agent } : agent;
  },
}));
jest.mock('~/server/services/PermissionService', () => ({
  checkPermission: (...args) => mockCheckPermission(...args),
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
  applyVoiceModelOverride: (...args) => mockApplyVoiceModelOverride(...args),
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
  markOptionalAgentInitializationFailed: jest.fn(),
}));
jest.mock('~/server/services/Config/getEndpointsConfig', () => ({
  getEndpointsConfig: jest.fn(async () => ({})),
}));

jest.mock('~/server/services/viventium/GlassHiveCapabilityBootstrapService', () => ({
  buildConversationProviderBootstrapBundle: (...args) =>
    mockBuildConversationProviderBootstrapBundle(...args),
}));
jest.mock('~/app/clients/tools/util/fileSearch', () => ({
  primeFiles: (...args) => mockPrimeFiles(...args),
}));
jest.mock('~/server/services/viventium/CallSessionService', () => ({
  getCallSession: jest.fn(),
}));
jest.mock('~/db/models', () => ({}));
jest.mock('~/server/services/viventium/VoiceOrchestrationTraceService', () => ({
  recordVoiceOrchestrationTraceBestEffort: jest.fn(),
}));
jest.mock('~/server/services/viventium/GlassHiveTerminalCallbackTransaction', () => ({
  currentGlassHiveTerminalCallbackTransaction: jest.fn(() => null),
  deferGlassHiveTerminalCallbackAfterAbort: jest.fn(() => false),
  deferGlassHiveTerminalCallbackAfterCommit: jest.fn(() => false),
}));

const { initializeClient } = require('./initialize');
const { buildOptions } = require('./build');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const {
  conversationProviderStableAuthorityDigest,
} = require('~/server/services/viventium/GlassHiveConversationProviderService');
const {
  mainRouteTargetForAgent,
} = require('~/server/services/viventium/ViventiumMainContextService');

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
    user: { id: 'user-synthetic', role: 'USER' },
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
  mockGetAgent.mockResolvedValue({ _id: handoffAgent.id, ...handoffAgent });
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
    mockLoadAgent.mockReset();
    getModelsConfig.mockReset().mockResolvedValue({});
    mockEffectiveOrchestrationMode.mockReturnValue('parallel');
    mockValidateAgentModel.mockResolvedValue({ isValid: true });
    mockCheckPermission.mockResolvedValue(true);
    mockResolveFallbackCandidates.mockReturnValue([]);
    mockIsFallbackModelValid.mockReturnValue(true);
    mockIsSameAgentRoute.mockReturnValue(false);
    mockBuildFallbackAgent.mockImplementation((agent, assignment) => ({
      ...agent,
      endpoint: undefined,
      provider: assignment.provider,
      model: assignment.model,
      model_parameters: {
        ...(agent[assignment.parametersField] || agent.model_parameters),
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
    mockLoadAgentTools.mockResolvedValue({ toolDefinitions: [] });
    mockStartParallelWorkTurnAuthority.mockResolvedValue(false);
    mockApplyVoiceModelOverride.mockReset();
  });

  afterAll(() => {
    if (originalBrokerSecret === undefined) {
      delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
    } else {
      process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = originalBrokerSecret;
    }
  });

  test.each([true, false])(
    'retains delivery choices after existing aggregation repair (voice=%s)',
    async (voice) => {
      const { createContentAggregator } = require('@librechat/agents');
      const { retainAggregatedDeliveryDisposition } = require('@librechat/api');
      const repairs = require('~/server/services/viventium/voiceDeltaAggregation');
      const contentParts = [{ type: 'text', text: 'Previous.' }];
      const original = contentParts.slice();
      createContentAggregator.mockReturnValueOnce({ contentParts, aggregateContent: jest.fn() });
      const repair = voice
        ? repairs.repairMissedVoiceMessageDelta
        : repairs.repairMissedVisibleMessageDelta;
      repair.mockImplementationOnce(() => {
        contentParts[0] = { type: 'text', text: 'Previous.Current.' };
        return true;
      });
      const { client } = await initializeWithHandoff({
        ...primaryAgent,
        id: 'synthetic-handoff',
        edges: [],
      });
      client.options.req.body.voiceMode = voice;
      const event = {
        event: 'on_message_delta',
        visibleToUser: true,
        data: {
          delta: {
            content: [{ type: 'text', text: 'Current.' }],
            metadata: {
              viventium: {
                deliveryDisposition: {
                  version: 1,
                  audio: 'skip',
                  source: 'model',
                  valid: true,
                  required: true,
                },
              },
            },
          },
        },
      };
      client.options.aggregateContent(event);
      expect(retainAggregatedDeliveryDisposition).toHaveBeenCalledWith(
        contentParts,
        original,
        event,
      );
      expect(retainAggregatedDeliveryDisposition.mock.calls[0][0][0].text).toBe(
        'Previous.Current.',
      );
      expect(repair).toHaveBeenCalled();
    },
  );

  test('observes authenticated Parallel readiness before primary initialization', async () => {
    await initializeWithHandoff({ ...primaryAgent, id: 'synthetic-handoff', edges: [] });
    expect(mockObserveOrchestrationOwner).toHaveBeenCalledWith('user-synthetic');
    expect(mockObserveOrchestrationOwner.mock.invocationCallOrder[0]).toBeLessThan(
      mockInitializeAgent.mock.invocationCallOrder[0],
    );
  });

  test.each(['focused', 'restricted-voice'])(
    'does not start a readiness probe for %s initialization',
    async (state) => {
      const req = makeRequest();
      if (state === 'focused') mockEffectiveOrchestrationMode.mockReturnValue('focused');
      else req.body.voiceMode = true;
      mockInitializeAgent.mockImplementation(async ({ agent }) => makeInitializedConfig(agent));
      await initializeClient({
        req,
        res: {},
        signal: null,
        endpointOption: {
          agent: Promise.resolve({ ...primaryAgent, edges: [] }),
          model_parameters: {},
        },
      });
      expect(mockObserveOrchestrationOwner).not.toHaveBeenCalled();
    },
  );

  test('passes the effective provider adapter delta contract to stream callbacks', async () => {
    const req = makeRequest();
    req.config.endpoints.agents.providerCapabilities.openAI.message_delta_mode = 'snapshot';
    const directPrimary = { ...primaryAgent, edges: [] };
    mockInitializeAgent.mockImplementation(async ({ agent }) => makeInitializedConfig(agent));

    await initializeClient({
      req,
      res: {},
      signal: null,
      endpointOption: {
        agent: Promise.resolve(directPrimary),
        model_parameters: { model: directPrimary.model },
      },
    });

    const { getDefaultHandlers } = require('~/server/controllers/agents/callbacks');
    expect(getDefaultHandlers).toHaveBeenCalledWith(
      expect.objectContaining({ messageDeltaMode: 'snapshot' }),
    );
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
    expect(mockBuildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
    await initializedHandoff.viventiumConnectedAgentInitializer();
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
        user: expect.objectContaining({ id: 'user-synthetic' }),
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
    await initializedHandoff.viventiumConnectedAgentInitializer();

    expect(initializedHandoff.model_parameters.configuration.defaultHeaders).toEqual({
      'X-Existing': 'kept',
    });
    expect(mockBuildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
    expect(initializedHandoff.viventiumConversationProviderCapabilityRefresh).toBeUndefined();
  });

  test('applies the authenticated scheduled execution tuple without carrying interactive fallback', async () => {
    const scheduledMain = {
      ...primaryAgent,
      provider: 'glasshive-harness',
      model: 'codex-cli:gpt-5.6-sol',
      fallback_llm_provider: 'glasshive-harness',
      fallback_llm_model: 'claude-code:opus',
      fallback_llm_model_parameters: { model: 'claude-code:opus' },
      edges: [],
    };
    const req = makeRequest();
    req.viventiumScheduledAgentExecution = {
      provider: 'openai',
      model: 'gpt-5.6-sol',
      reasoning_effort: 'xhigh',
    };
    mockInitializeAgent.mockImplementation(async ({ agent }) => makeInitializedConfig(agent));

    await initializeClient({
      req,
      res: {},
      signal: null,
      endpointOption: {
        agent: Promise.resolve(scheduledMain),
        model_parameters: { model: scheduledMain.model },
      },
    });

    expect(mockResolveFallbackCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openAI',
        model: 'gpt-5.6-sol',
        model_parameters: expect.objectContaining({
          model: 'gpt-5.6-sol',
          reasoning_effort: 'xhigh',
        }),
      }),
      { isVoiceCall: false },
    );
    const [executionAgent] = mockResolveFallbackCandidates.mock.calls[0];
    expect(executionAgent).not.toHaveProperty('fallback_llm_provider');
    expect(executionAgent).not.toHaveProperty('fallback_llm_model');
  });

  test('keeps the user-readable model label on the healthy Main lazy fallback assignment', async () => {
    const nativeMain = {
      ...primaryAgent,
      provider: 'glasshive-harness',
      model: 'codex-cli:gpt-5.6-sol',
      model_parameters: {
        model: 'codex-cli:gpt-5.6-sol',
        modelLabel: 'GPT-5.6 Sol',
        reasoning_effort: 'medium',
      },
      fallback_llm_provider: 'glasshive-harness',
      fallback_llm_model: 'claude-code:opus',
      fallback_llm_model_parameters: {
        model: 'claude-code:opus',
        modelLabel: 'Claude Opus 5',
        reasoning_effort: 'high',
      },
      edges: [],
    };
    mockResolveFallbackCandidates.mockReturnValue([
      {
        provider: 'glasshive-harness',
        model: 'claude-code:opus',
        source: 'agent',
        parametersField: 'fallback_llm_model_parameters',
      },
    ]);
    mockInitializeAgent.mockImplementation(async ({ agent }) => makeInitializedConfig(agent));

    const { client } = await initializeClient({
      req: makeRequest(),
      res: {},
      signal: null,
      endpointOption: {
        agent: Promise.resolve(nativeMain),
        model_parameters: { model: nativeMain.model },
      },
    });

    const assignment = client.options.agent.viventiumFallbackLlmAssignment;
    expect(assignment).toEqual({
      provider: 'glasshive-harness',
      model: 'claude-code:opus',
      modelLabel: 'Claude Opus 5',
      effort: 'high',
    });
    expect(mainRouteTargetForAgent(assignment)).toEqual({
      provider: 'glasshive-harness',
      model: 'claude-code:opus',
      modelLabel: 'Claude Opus 5',
      effort: 'high',
    });
  });

  test('marks restricted recovery only after server validation and prepares a signed terminal fallback', async () => {
    const {
      retainServerValidatedRestrictedVoiceFallback,
      sanitizeAgentForRestrictedVoiceTurn,
    } = require('~/server/services/viventium/VoiceActorAuthorityService');
    const req = makeRequest();
    req.body.voiceMode = true;
    req.body.viventiumActorTrust = 'unknown';
    req.body.viventiumCanAuthorizeSideEffects = false;
    const nativeMain = {
      ...primaryAgent,
      provider: 'glasshive-harness',
      model: 'grok-build:grok-4.7-build-fast',
      model_parameters: { model: 'grok-build:grok-4.7-build-fast', reasoning_effort: 'high' },
      fallback_llm_provider: 'glasshive-harness',
      fallback_llm_model: 'claude-code:claude-opus-5-5',
      fallback_llm_model_parameters: {
        model: 'claude-code:claude-opus-5-5',
        reasoning_effort: 'high',
      },
      tools: ['synthetic-write'],
      background_cortices: [{ agentId: 'synthetic-cortex' }],
      edges: [],
    };
    mockResolveFallbackCandidates.mockReturnValue([
      {
        provider: 'glasshive-harness',
        model: 'claude-code:claude-opus-5-5',
        parametersField: 'fallback_llm_model_parameters',
      },
    ]);
    mockInitializeAgent.mockImplementation(async ({ agent }) => ({
      ...makeInitializedConfig(agent),
      model_parameters: {
        ...agent.model_parameters,
        configuration: {
          defaultHeaders: {
            'X-GlassHive-Agent-Id': agent.id,
            'X-GlassHive-Access': 'full',
            'X-GlassHive-Fallback-Model': 'synthetic-nested-fallback',
            'X-GlassHive-Capability-Broker-Token': 'synthetic-old-grant',
          },
        },
      },
    }));
    const { client } = await initializeClient({
      req,
      res: {},
      signal: null,
      endpointOption: {
        agent: Promise.resolve(nativeMain),
        model_parameters: { model: nativeMain.model },
      },
    });
    const source = client.options.agent;
    const genericSanitized = sanitizeAgentForRestrictedVoiceTurn(source);
    expect(genericSanitized.viventiumFallbackLlmInitializer).toBeUndefined();
    expect(genericSanitized.viventiumFallbackLlmAssignment).toBeUndefined();
    const restricted = retainServerValidatedRestrictedVoiceFallback(genericSanitized, source, req);
    expect(restricted.viventiumFallbackLlmAssignment).toMatchObject({
      model: 'claude-code:claude-opus-5-5',
      effort: 'high',
    });
    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
    const fallback = await restricted.viventiumFallbackLlmInitializer();
    expect(await restricted.viventiumFallbackLlmInitializer()).toBe(fallback);
    expect(mockInitializeAgent).toHaveBeenCalledTimes(2);
    expect(fallback.tools).toEqual([]);
    expect(fallback.userMCPAuthMap).toEqual({});
    expect(fallback.background_cortices).toEqual([]);
    expect(fallback.edges).toEqual([]);
    expect(fallback.toolRegistry.size).toBe(0);
    expect(fallback.model_parameters.reasoning_effort).toBe('high');
    expect(fallback.viventiumFallbackLlmInitializer).toBeUndefined();
    expect(fallback.viventiumFallbackLlm).toBeUndefined();
    const headers = fallback.model_parameters.configuration.defaultHeaders;
    expect(headers['X-GlassHive-Agent-Id']).toBe(nativeMain.id);
    expect(headers['X-GlassHive-Bootstrap-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(JSON.parse(Buffer.from(headers['X-GlassHive-Bootstrap-Bundle-B64'], 'base64'))).toEqual({
      provider_capabilities: { native_tools: false },
    });
    expect(headers['X-GlassHive-Access']).toBeUndefined();
    expect(headers['X-GlassHive-Fallback-Model']).toBeUndefined();
    expect(headers['X-GlassHive-Capability-Broker-Token']).toBeUndefined();
    expect(mockBuildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    'normal restricted initialization binds only owner Stop, fallback selected=%s',
    async (useFallback) => {
      const { GenerationJobManager } = require('@librechat/api');
      const tasks = require('~/server/services/viventium/VoiceTaskService');
      const { getCallSession } = require('~/server/services/viventium/CallSessionService');
      const {
        bindHarnessCancellation,
      } = require('~/server/services/viventium/GlassHiveConversationProviderService');
      tasks.resetVoiceTasksForTests();
      const task = tasks.createVoiceTask({
        userId: 'user-synthetic',
        callSessionId: 'call-synthetic',
        streamId: 'stream-synthetic',
        owner: { kind: 'generation_job', id: 'stream-synthetic' },
      });
      const controller = new AbortController();
      const req = makeRequest();
      Object.assign(req.body, {
        voiceMode: true,
        viventiumActorTrust: 'unknown',
        viventiumCanAuthorizeSideEffects: false,
        viventiumVoiceTaskId: task.taskId,
      });
      req._resumableStreamId = 'stream-synthetic';
      req.viventiumCallSession = { userId: 'user-synthetic', callSessionId: 'call-synthetic' };
      req.config.endpoints.agents.providerCapabilities['glasshive-harness'].conversation_session =
        true;
      req.config.endpoints['glasshive-harness'] = {
        baseURL: 'http://native.test/v1',
        apiKey: 'synthetic-key',
      };
      GenerationJobManager.getJob.mockResolvedValue({
        createdAt: 42,
        abortController: controller,
        metadata: {
          userId: 'user-synthetic',
          viventiumCallSessionId: 'call-synthetic',
          viventiumVoiceTaskId: task.taskId,
          responseMessageId: 'server-response',
        },
      });
      GenerationJobManager.abortJob.mockImplementation(async () => {
        controller.abort('user_cancelled');
        return { success: true };
      });
      getCallSession.mockResolvedValue({ ...req.viventiumCallSession, callStatus: 'active' });
      const nativeMain = {
        ...primaryAgent,
        provider: 'glasshive-harness',
        model: 'synthetic-primary-model',
        model_parameters: { model: 'synthetic-primary-model' },
        fallback_llm_provider: 'glasshive-harness',
        fallback_llm_model: 'synthetic-fallback-model',
        fallback_llm_model_parameters: {
          model: 'synthetic-fallback-model',
          reasoning_effort: 'high',
        },
      };
      mockResolveFallbackCandidates.mockReturnValue([
        {
          provider: 'glasshive-harness',
          model: 'synthetic-fallback-model',
          parametersField: 'fallback_llm_model_parameters',
        },
      ]);
      mockInitializeAgent.mockImplementation(async ({ agent }) => makeInitializedConfig(agent));
      const fetch = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue({ ok: true, json: async () => ({ capacityReleased: true }) });
      try {
        const { client } = await initializeClient({
          req,
          res: {},
          signal: controller.signal,
          endpointOption: {
            agent: Promise.resolve(nativeMain),
            model_parameters: { model: nativeMain.model },
          },
        });
        if (useFallback) {
          const fallback = await client.options.agent.viventiumFallbackLlmInitializer();
          expect(fallback.tools).toEqual([]);
          expect(fallback.viventiumHarnessCancellationEndpointConfig).toBeUndefined();
          req._viventiumFallbackLlmAttempt = true;
          expect(bindHarnessCancellation({ req, signal: controller.signal })).toBe(true);
        }
        const stop = await tasks.requestVoiceTaskOwnerCancellation(task.taskId, {
          userId: 'user-synthetic',
        });
        expect(stop.ownerSupported).toBe(true);
        await tasks.flushVoiceTaskOwnerOperations();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0][0]).toBe(
          'http://native.test/v1/requests/by-idempotency/server-response/cancel',
        );
        expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelled_confirmed');
        expect(req._viventiumNativeVoiceInputPolling).toBeUndefined();
        expect(req.viventiumVoiceWorkAuthority).toBeUndefined();
        expect(client.options.agent.tools).toEqual([]);
      } finally {
        fetch.mockRestore();
        tasks.resetVoiceTasksForTests();
      }
    },
  );

  test('sets native per-turn context delivery before tool initialization builds durable authority', async () => {
    const nativeMain = {
      ...primaryAgent,
      endpoint: 'glasshive-harness',
      provider: 'openAI',
      model: 'codex-cli:gpt-5.6-sol',
      edges: [],
    };
    const req = makeRequest();
    req.config.endpoints.agents.providerCapabilities['glasshive-harness'].conversation_session =
      true;
    req.config.endpoints.agents.providerCapabilities['glasshive-harness'].time_context_delivery =
      'per_turn_header';
    mockInitializeAgent.mockImplementation(async ({ agent, req: initializationRequest }) => {
      expect(initializationRequest.viventiumTimeContextDelivery).toBe('per_turn_header');
      return makeInitializedConfig(agent);
    });

    await initializeClient({
      req,
      res: {},
      signal: null,
      endpointOption: {
        agent: Promise.resolve(nativeMain),
        model_parameters: { model: nativeMain.model },
      },
    });
  });

  test('starts Parallel turn authority before primary agent tool initialization', async () => {
    const order = [];
    const req = makeRequest();
    mockStartParallelWorkTurnAuthority.mockImplementation(() => {
      order.push('authority');
      return Promise.resolve(true);
    });
    mockInitializeAgent.mockImplementation(async ({ agent }) => {
      order.push('initialize');
      return makeInitializedConfig(agent);
    });

    await initializeClient({
      req,
      res: {},
      signal: null,
      endpointOption: {
        agent: Promise.resolve({ ...primaryAgent }),
        model_parameters: { model: primaryAgent.model },
      },
    });

    expect(order.slice(0, 2)).toEqual(['authority', 'initialize']);
    expect(mockStartParallelWorkTurnAuthority).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        id: primaryAgent.id,
      }),
    );
  });

  test('binds Main authority from the persisted declaration before runtime context mutates it', async () => {
    const nativeMain = {
      ...primaryAgent,
      provider: 'glasshive-harness',
      model: 'codex-cli:gpt-5.6-sol',
      instructions: 'Stable Main policy with {{current_datetime}}.',
      tools: ['file_search'],
      glasshive_options: { workspace: { mode: 'life' }, access: 'full' },
      edges: [],
    };
    const expectedDigest = conversationProviderStableAuthorityDigest(nativeMain);
    const req = makeRequest();
    Object.assign(req.config.endpoints.agents.providerCapabilities['glasshive-harness'], {
      conversation_session: true,
      native_session_authority: 'stable_authority_v1',
    });
    mockInitializeAgent.mockImplementation(async ({ agent }) => {
      agent.instructions = 'Runtime-rendered policy at a changing minute.';
      agent.tools = [{ name: 'request-resolved-file-search' }];
      const config = makeInitializedConfig(agent);
      config.model_parameters.configuration.defaultHeaders['X-GlassHive-Agent-Id'] = agent.id;
      config.toolDefinitions = [{ name: 'request-resolved-file-search' }];
      return config;
    });

    const { client } = await initializeClient({
      req,
      res: {},
      signal: null,
      endpointOption: {
        agent: Promise.resolve(nativeMain),
        model_parameters: { model: nativeMain.model },
      },
    });

    expect(
      client.options.agent.model_parameters.configuration.defaultHeaders[
        'X-GlassHive-Stable-Authority-SHA256'
      ],
    ).toBe(expectedDigest);
    expect(conversationProviderStableAuthorityDigest(client.options.agent)).not.toBe(
      expectedDigest,
    );
  });

  test('sets identical native context delivery before primary and fallback tool initialization', async () => {
    const nativeMain = {
      ...primaryAgent,
      endpoint: 'glasshive-harness',
      provider: 'openAI',
      model: 'codex-cli:gpt-5.6-sol',
      fallback_llm_provider: 'glasshive-harness',
      fallback_llm_model: 'claude-code:opus',
      fallback_llm_model_parameters: { model: 'claude-code:opus' },
      edges: [],
    };
    const req = makeRequest();
    req.config.endpoints.agents.providerCapabilities['glasshive-harness'].conversation_session =
      true;
    req.config.endpoints.agents.providerCapabilities['glasshive-harness'].time_context_delivery =
      'per_turn_header';
    mockResolveFallbackCandidates.mockReturnValue([
      {
        provider: 'glasshive-harness',
        model: 'claude-code:opus',
        source: 'agent',
        parametersField: 'fallback_llm_model_parameters',
      },
    ]);
    const contextDeliveryAtInitialization = [];
    mockInitializeAgent.mockImplementation(async ({ agent, req: initializationRequest }) => {
      contextDeliveryAtInitialization.push(initializationRequest.viventiumTimeContextDelivery);
      if (agent.model === nativeMain.model) {
        const error = new Error('synthetic primary unavailable');
        error.status = 503;
        throw error;
      }
      return makeInitializedConfig(agent);
    });

    await initializeClient({
      req,
      res: {},
      signal: null,
      endpointOption: {
        agent: Promise.resolve(nativeMain),
        model_parameters: { model: nativeMain.model },
      },
    });

    expect(contextDeliveryAtInitialization).toEqual(['per_turn_header', 'per_turn_header']);
  });

  test('uses the normal Agent Builder fallback when interactive Main initialization fails', async () => {
    const scheduledMain = {
      ...primaryAgent,
      provider: 'glasshive-harness',
      model: 'codex-cli:gpt-5.6-sol',
      model_parameters: { model: 'codex-cli:gpt-5.6-sol', reasoning_effort: 'medium' },
      fallback_llm_provider: 'glasshive-harness',
      fallback_llm_model: 'claude-code:opus',
      fallback_llm_model_parameters: {
        model: 'claude-code:opus',
        reasoning_effort: 'high',
      },
      edges: [],
    };
    const fallbackAssignment = {
      provider: 'glasshive-harness',
      model: 'claude-code:opus',
      source: 'agent',
      parametersField: 'fallback_llm_model_parameters',
    };
    const req = makeRequest();
    mockResolveFallbackCandidates.mockReturnValue([fallbackAssignment]);
    mockInitializeAgent.mockImplementation(async ({ agent }) => {
      if (agent.model === scheduledMain.model) {
        const error = new Error('synthetic provider rate limit');
        error.status = 429;
        throw error;
      }
      return makeInitializedConfig(agent);
    });

    const { client } = await initializeClient({
      req,
      res: {},
      signal: null,
      endpointOption: {
        agent: Promise.resolve(scheduledMain),
        model_parameters: { model: scheduledMain.model },
      },
    });

    expect(mockInitializeAgent.mock.calls.map(([options]) => options.agent.model)).toEqual([
      'codex-cli:gpt-5.6-sol',
      'claude-code:opus',
    ]);
    expect(client.options.agent).toMatchObject({
      provider: 'glasshive-harness',
      model: 'claude-code:opus',
    });
    expect(req._viventiumFallbackLlmAttempt).toBe(true);
    expect(req._viventiumFallbackRouteNotice).toEqual({ model: 'claude-code:opus' });
  });

  test('preserves only the Main orchestration declaration when a voice override loads tool definitions', async () => {
    const voiceMain = {
      ...primaryAgent,
      tools: ['active_work_list', 'active_work_action'],
      glasshive_options: {
        workspace: { mode: 'life' },
        access: 'full',
        fallback_model: 'must-not-cross-the-tool-boundary',
        orchestration: {
          parallel_available: true,
          default_mode: 'focused',
        },
      },
    };
    mockApplyVoiceModelOverride.mockImplementation((agent) => {
      agent.provider = 'xai';
      agent.model = 'synthetic-voice-model';
    });
    mockInitializeAgent.mockImplementation(async (params) => {
      if (typeof params.loadTools === 'function') {
        await params.loadTools({
          req: params.req,
          res: params.res,
          provider: params.agent.provider,
          agentId: params.agent.id,
          tools: params.agent.tools,
          model: params.agent.model,
          tool_options: params.agent.tool_options,
          tool_resources: params.agent.tool_resources,
          orchestration: params.agent.glasshive_options?.orchestration,
        });
      }
      return makeInitializedConfig(params.agent);
    });

    await initializeClient({
      req: makeRequest(),
      res: {},
      signal: null,
      endpointOption: {
        agent: Promise.resolve(voiceMain),
        model_parameters: { model: voiceMain.model },
      },
    });

    expect(mockLoadAgentTools).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: {
          id: voiceMain.id,
          tools: voiceMain.tools,
          provider: 'xai',
          model: 'synthetic-voice-model',
          tool_options: undefined,
          glasshive_options: {
            orchestration: voiceMain.glasshive_options.orchestration,
          },
        },
      }),
    );
  });

  test('does not project Main orchestration authority for a mission root without the declaration', async () => {
    const missionRoot = {
      ...primaryAgent,
      provider: 'glasshive-harness',
      tools: ['active_work_list', 'active_work_action'],
      glasshive_options: {
        workspace: { mode: 'life' },
        access: 'full',
      },
    };
    mockInitializeAgent.mockImplementation(async (params) => {
      if (typeof params.loadTools === 'function') {
        await params.loadTools({
          req: params.req,
          res: params.res,
          provider: params.agent.provider,
          agentId: params.agent.id,
          tools: params.agent.tools,
          model: params.agent.model,
          tool_options: params.agent.tool_options,
          tool_resources: params.agent.tool_resources,
          orchestration: params.agent.glasshive_options?.orchestration,
        });
      }
      return makeInitializedConfig(params.agent);
    });

    await initializeClient({
      req: makeRequest(),
      res: {},
      signal: null,
      endpointOption: {
        agent: Promise.resolve(missionRoot),
        model_parameters: { model: missionRoot.model },
      },
    });

    expect(mockLoadAgentTools).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.not.objectContaining({ glasshive_options: expect.anything() }),
      }),
    );
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
    expect(mockBuildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
    await initializedHandoff.viventiumConnectedAgentInitializer();
    const headers = initializedHandoff.model_parameters.configuration.defaultHeaders;

    expect(initializedHandoff.instructions).toContain('host capability broker is unavailable');
    expect(headers['X-GlassHive-Bootstrap-Bundle-B64']).toBeUndefined();
    expect(headers['X-GlassHive-Bootstrap-Signature']).toBeUndefined();
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
    await initializedHandoff.viventiumConnectedAgentInitializer();
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
      tools: ['file_search', `read_mail${Constants.mcp_delimiter}synthetic-connected-account`],
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
      async ({ allowedServerNames, allowedHostTools, hostToolResources }) => ({
        glasshive_capability_broker: {
          allowed_servers: allowedServerNames,
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
    await initializedHandoff.viventiumConnectedAgentInitializer();
    const [fallbackRoute] = initializedHandoff.viventiumGraphLlmFallbacks;
    const encodedBundle =
      fallbackRoute.model_parameters.configuration.defaultHeaders[
        'X-GlassHive-Bootstrap-Bundle-B64'
      ];
    const bundle = JSON.parse(Buffer.from(encodedBundle, 'base64').toString('utf8'));

    expect(bundle.glasshive_capability_broker.allowed_servers).toEqual([
      'synthetic-connected-account',
    ]);
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
    await initializedHandoff.viventiumConnectedAgentInitializer();

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
    const req = makeRequest();

    const { client } = await initializeClient({
      req,
      res: {},
      signal: null,
      endpointOption,
    });
    const initializedHandoff = client.options.agentConfigs.get(handoffAgent.id);
    await initializedHandoff.viventiumConnectedAgentInitializer();

    expect(initializedHandoff).toMatchObject({
      id: handoffAgent.id,
      provider: assignment.provider,
      model: assignment.model,
      initializedWithTargetTools: true,
    });
    expect(initializedHandoff.viventiumGraphLlmFallbacks).toBeUndefined();
    expect(mockInitializeAgent).toHaveBeenCalledTimes(3);
    expect(req._viventiumParticipantReconnectRecovery).toBeUndefined();
  });

  test('does not disclose completion when participant fallback only initializes', async () => {
    const handoffAgent = {
      id: 'handoff-agent',
      provider: 'anthropic',
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
    mockInitializeAgent.mockImplementation(async ({ agent }) => {
      if (agent.id === handoffAgent.id && agent.provider === handoffAgent.provider) {
        throw Object.assign(new Error('synthetic reconnect required'), {
          code: 'MODEL_AUTHENTICATION',
          viventiumConnectedAccountReconnectRequired: true,
          viventiumConnectedAccountProvider: 'Anthropic',
        });
      }
      return makeInitializedConfig(agent);
    });
    const req = makeRequest();

    const { client } = await initializeClient({
      req,
      res: {},
      signal: null,
      endpointOption: {
        agent: Promise.resolve({ ...primaryAgent }),
        model_parameters: { model: primaryAgent.model },
      },
    });
    expect(req._viventiumParticipantReconnectRecovery).toBeUndefined();
    const initializedHandoff = client.options.agentConfigs.get(handoffAgent.id);
    await initializedHandoff.viventiumConnectedAgentInitializer();

    expect(initializedHandoff).toMatchObject({
      provider: assignment.provider,
      model: assignment.model,
    });
    expect(req._viventiumParticipantReconnectRecovery).toBeUndefined();
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
    await initializedHandoff.viventiumConnectedAgentInitializer();

    expect(initializedHandoff.viventiumGraphLlmFallbacks).toBeUndefined();
    expect(mockBuildFallbackAgent).not.toHaveBeenCalled();
    expect(mockInitializeAgent).toHaveBeenCalledTimes(2);
  });

  test('discovers transitive graph topology without materializing unused participants', async () => {
    const rootAgent = {
      ...primaryAgent,
      edges: [{ from: primaryAgent.id, to: 'handoff-a', edgeType: 'handoff' }],
    };
    const handoffA = {
      id: 'handoff-a',
      provider: 'openAI',
      model: 'synthetic-a-model',
      edges: [{ from: 'handoff-a', to: 'handoff-b', edgeType: 'handoff' }],
    };
    const handoffB = {
      id: 'handoff-b',
      provider: 'openAI',
      model: 'synthetic-b-model',
      edges: [],
    };
    mockGetAgent.mockImplementation(async ({ id }) =>
      id === handoffA.id ? handoffA : id === handoffB.id ? handoffB : null,
    );
    mockInitializeAgent.mockImplementation(async ({ agent }) => makeInitializedConfig(agent));

    const { client } = await initializeClient({
      req: makeRequest(),
      res: {},
      signal: null,
      endpointOption: {
        agent: Promise.resolve(rootAgent),
        model_parameters: { model: rootAgent.model },
      },
    });

    expect([...client.options.agentConfigs.keys()]).toEqual(['handoff-a', 'handoff-b']);
    expect(client.options.agent.edges).toEqual([rootAgent.edges[0], handoffA.edges[0]]);
    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
    expect(
      mockInitializeAgent.mock.calls.some(
        ([params]) => params.agent?.id === handoffA.id || params.agent?.id === handoffB.id,
      ),
    ).toBe(false);
  });

  test('keeps fallback auth enabled until concurrent participant hydration completes', async () => {
    const rootAgent = {
      ...primaryAgent,
      edges: [
        { from: primaryAgent.id, to: 'handoff-a', edgeType: 'handoff' },
        { from: primaryAgent.id, to: 'handoff-b', edgeType: 'handoff' },
      ],
    };
    const handoffs = new Map(
      ['handoff-a', 'handoff-b'].map((id) => [
        id,
        {
          id,
          provider: 'openAI',
          model: `synthetic-${id}-model`,
          fallback_llm_provider: 'glasshive-harness',
          fallback_llm_model: `synthetic-${id}-fallback`,
          edges: [],
        },
      ]),
    );
    const fallbackReleases = new Map();
    const fallbackStarts = new Map();
    mockGetAgent.mockImplementation(async ({ id }) => handoffs.get(id));
    mockResolveFallbackCandidates.mockImplementation((agent) =>
      handoffs.has(agent.id)
        ? [
            {
              provider: 'glasshive-harness',
              model: `synthetic-${agent.id}-fallback`,
              source: 'agent',
              parametersField: 'fallback_llm_model_parameters',
            },
          ]
        : [],
    );
    mockInitializeAgent.mockImplementation(async ({ agent, req }) => {
      if (agent.provider === 'glasshive-harness') {
        expect(req.viventiumAllowOpenAIPlatformFallbackOnOAuthFailure).toBe(true);
        fallbackStarts.get(agent.id)?.();
        await new Promise((resolve) => fallbackReleases.set(agent.id, resolve));
      }
      return makeInitializedConfig(agent);
    });
    const req = makeRequest();

    const { client } = await initializeClient({
      req,
      res: {},
      signal: null,
      endpointOption: {
        agent: Promise.resolve(rootAgent),
        model_parameters: { model: rootAgent.model },
      },
    });
    const aStarted = new Promise((resolve) => fallbackStarts.set('handoff-a', resolve));
    const bStarted = new Promise((resolve) => fallbackStarts.set('handoff-b', resolve));
    const initializeA = client.options.agentConfigs
      .get('handoff-a')
      .viventiumConnectedAgentInitializer();
    const initializeB = client.options.agentConfigs
      .get('handoff-b')
      .viventiumConnectedAgentInitializer();
    await Promise.all([aStarted, bStarted]);

    fallbackReleases.get('handoff-a')();
    await new Promise((resolve) => setImmediate(resolve));
    expect(req.viventiumAllowOpenAIPlatformFallbackOnOAuthFailure).toBe(true);

    fallbackReleases.get('handoff-b')();
    await Promise.all([initializeA, initializeB]);
    expect(req.viventiumAllowOpenAIPlatformFallbackOnOAuthFailure).toBeUndefined();
  });

  test('retains BSON identity and detached authority while materializing a connected participant', async () => {
    const resourceId = new Types.ObjectId();
    const handoffAgent = {
      _id: resourceId,
      id: 'handoff-agent',
      provider: 'openAI',
      model: 'synthetic-connected-model',
      model_parameters: {
        model: 'synthetic-connected-model',
        configuration: { scope: 'captured' },
      },
      edges: [],
    };
    mockCheckPermission.mockImplementation(async ({ resourceId: requestedId }) => {
      if (!Types.ObjectId.isValid(requestedId)) {
        throw new Error('ACL resource ID lost its BSON type');
      }
      return String(requestedId) === String(resourceId);
    });
    const { client } = await initializeWithHandoff(handoffAgent);
    handoffAgent.model_parameters.configuration.scope = 'changed-after-capture';
    await client.options.agentConfigs.get(handoffAgent.id).viventiumConnectedAgentInitializer();

    expect(mockCheckPermission).toHaveBeenCalledTimes(2);
    for (const [permission] of mockCheckPermission.mock.calls) {
      expect(permission.resourceId).toBeInstanceOf(Types.ObjectId);
      expect(String(permission.resourceId)).toBe(String(resourceId));
    }
    const hydratedAgent = mockInitializeAgent.mock.calls.find(
      ([params]) => params.agent?.id === handoffAgent.id,
    )[0].agent;
    expect(hydratedAgent.model_parameters.configuration.scope).toBe('captured');
  });

  test('defers connected participant tools until first use and singleflights materialization', async () => {
    const handoffAgent = {
      id: 'handoff-agent',
      provider: 'openAI',
      model: 'synthetic-connected-model',
      instructions: 'Persisted {{current_datetime}} specialist instructions.',
      additional_instructions: 'Persisted artifact instructions.',
      tools: [`read_mail${Constants.mcp_delimiter}synthetic-connected-account`],
      edges: [],
    };
    let releaseToolInitialization;
    let toolInitializationGate = null;
    let holdToolInitialization = false;
    let connectedToolInitializationCount = 0;
    mockGetAgent.mockResolvedValue(handoffAgent);
    mockInitializeAgent.mockImplementation(async ({ agent, loadTools }) => {
      const config = makeInitializedConfig(agent);
      if (agent.id !== handoffAgent.id || typeof loadTools !== 'function') {
        return config;
      }
      config.instructions = 'Rendered specialist instructions.';
      config.additional_instructions = 'Rendered artifact instructions.';
      connectedToolInitializationCount += 1;
      if (holdToolInitialization) {
        await toolInitializationGate;
      }
      config.tools = [{ name: 'read_mail_mcp_synthetic-connected-account' }];
      config.toolDefinitions = [{ name: 'read_mail_mcp_synthetic-connected-account' }];
      config.toolRegistry = new Map([
        [
          'read_mail_mcp_synthetic-connected-account',
          { name: 'read_mail_mcp_synthetic-connected-account' },
        ],
      ]);
      return config;
    });

    const { client } = await initializeClient({
      req: makeRequest(),
      res: {},
      signal: null,
      endpointOption: {
        agent: Promise.resolve({ ...primaryAgent }),
        model_parameters: { model: primaryAgent.model },
      },
    });
    const lazyHandoff = client.options.agentConfigs.get(handoffAgent.id);
    lazyHandoff.instructions = [lazyHandoff.instructions, lazyHandoff.additional_instructions]
      .filter(Boolean)
      .join('\n');
    lazyHandoff.additional_instructions = '';
    lazyHandoff.instructions = [
      lazyHandoff.instructions,
      'Invocation-local surface and Feeling authority.',
    ].join('\n\n');
    const handoffCallsBeforeUse = mockInitializeAgent.mock.calls.filter(
      ([params]) => params.agent?.id === handoffAgent.id,
    );

    expect(handoffCallsBeforeUse).toHaveLength(0);
    expect(connectedToolInitializationCount).toBe(0);
    expect(
      mockResolveFallbackCandidates.mock.calls.some(([agent]) => agent?.id === handoffAgent.id),
    ).toBe(false);
    expect(mockBuildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
    expect(
      Object.getOwnPropertyDescriptor(lazyHandoff, 'viventiumConnectedAgentInitializer'),
    ).toMatchObject({ enumerable: false, writable: false, value: expect.any(Function) });
    expect(JSON.stringify(lazyHandoff)).not.toContain('viventiumConnectedAgentInitializer');

    holdToolInitialization = true;
    toolInitializationGate = new Promise((resolve) => {
      releaseToolInitialization = resolve;
    });
    const first = lazyHandoff.viventiumConnectedAgentInitializer();
    const second = lazyHandoff.viventiumConnectedAgentInitializer();
    await new Promise((resolve) => setImmediate(resolve));
    expect(connectedToolInitializationCount).toBe(1);
    expect(
      mockInitializeAgent.mock.calls.filter(([params]) => params.agent?.id === handoffAgent.id),
    ).toHaveLength(1);
    expect(
      mockResolveFallbackCandidates.mock.calls.some(([agent]) => agent?.id === handoffAgent.id),
    ).toBe(true);

    releaseToolInitialization();
    const [firstConfig, secondConfig] = await Promise.all([first, second]);
    expect(firstConfig).toBe(secondConfig);
    expect(firstConfig.toolDefinitions).toEqual([
      { name: 'read_mail_mcp_synthetic-connected-account' },
    ]);
    expect(lazyHandoff.toolDefinitions).toEqual(firstConfig.toolDefinitions);
    expect(lazyHandoff.instructions).toBe(
      [
        'Rendered specialist instructions.',
        'Rendered artifact instructions.',
        'Invocation-local surface and Feeling authority.',
      ].join('\n\n'),
    );
    expect(lazyHandoff.additional_instructions).toBe('');
  });

  describe('request-owned model catalog overlap', () => {
    function plainMain() {
      return { ...primaryAgent, edges: [] };
    }

    function prepareCatalogRequest(agent = plainMain()) {
      const req = makeRequest();
      mockLoadAgent.mockResolvedValue(agent);
      mockInitializeAgent.mockImplementation(async ({ agent: selected }) =>
        makeInitializedConfig(selected),
      );
      return req;
    }

    async function buildFor(req, agent = plainMain()) {
      return buildOptions(req, 'agents', { agent_id: agent.id, model: agent.model }, undefined);
    }

    test.each([
      ['cold catalog hidden behind existing request work', 35, 184, 185, 220],
      ['warm catalog', 35, 0, 0, 35],
      ['catalog remains the critical path', 35, 300, 185, 300],
    ])(
      'joins %s without adding a second catalog read',
      async (_label, agentMs, catalogMs, requestMs, expectedMs) => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        try {
          const req = prepareCatalogRequest();
          const catalog = { openAI: [primaryAgent.model], otherLegalEndpoint: ['other-model'] };
          mockLoadAgent.mockImplementation(
            () => new Promise((resolve) => setTimeout(() => resolve(plainMain()), agentMs)),
          );
          getModelsConfig.mockImplementation(() =>
            catalogMs === 0
              ? Promise.resolve(catalog)
              : new Promise((resolve) => setTimeout(() => resolve(catalog), catalogMs)),
          );
          let completedAt;
          const pipeline = (async () => {
            const endpointOption = await buildFor(req);
            if (requestMs) {
              await new Promise((resolve) => setTimeout(resolve, requestMs));
            }
            const result = await initializeClient({ req, res: {}, signal: null, endpointOption });
            completedAt = Date.now();
            return result;
          })();
          await jest.advanceTimersByTimeAsync(agentMs + catalogMs + requestMs + 100);
          await pipeline;
          expect(getModelsConfig).toHaveBeenCalledTimes(1);
          expect(getModelsConfig).toHaveBeenCalledWith(req);
          expect(mockValidateAgentModel.mock.calls[0][0].modelsConfig).toBe(catalog);
          expect(completedAt).toBe(expectedMs);
        } finally {
          jest.useRealTimers();
        }
      },
    );

    test('starts one complete catalog while the agent is pending and reuses it by identity', async () => {
      const req = prepareCatalogRequest();
      let releaseAgent;
      const agent = { ...plainMain(), avatar: { filepath: '/synthetic-avatar' } };
      mockLoadAgent.mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseAgent = resolve;
          }),
      );
      const catalog = {
        openAI: [agent.model],
        native: ['legal-native-model'],
        additional: ['legal-model'],
      };
      getModelsConfig.mockResolvedValue(catalog);
      req.body.addedConvo = { conversationId: 'additional-synthetic' };
      const pending = buildFor(req, agent);
      const callsWhileAgentPending = getModelsConfig.mock.calls.length;
      releaseAgent(agent);
      const endpointOption = await pending;
      const carriedPromise = endpointOption.modelsConfigPromise;
      const { client } = await initializeClient({ req, res: {}, signal: null, endpointOption });
      expect(callsWhileAgentPending).toBe(1);
      expect(carriedPromise).toBeDefined();
      expect(await carriedPromise).toBe(catalog);
      expect(mockValidateAgentModel.mock.calls[0][0].modelsConfig).toBe(catalog);
      expect(mockApplyVoiceModelOverride.mock.calls[0][2]).toBe(catalog);
      expect(getModelsConfig).toHaveBeenCalledTimes(1);
      expect(mockLoadAgent).toHaveBeenCalledTimes(1);
      expect(endpointOption).not.toHaveProperty('modelsConfigPromise');
      expect(endpointOption).not.toHaveProperty('agent');
      expect(endpointOption.iconURL).toBe('/synthetic-avatar');
      expect(endpointOption.addedConvo).toBe(req.body.addedConvo);
      expect(client.options).not.toHaveProperty('modelsConfigPromise');
    });

    test('legacy resolved-agent initialization loads exactly one catalog', async () => {
      const req = prepareCatalogRequest();
      const catalog = { openAI: [primaryAgent.model] };
      getModelsConfig.mockResolvedValue(catalog);
      const endpointOption = {
        agent: Promise.resolve(plainMain()),
        model_parameters: { model: primaryAgent.model },
      };
      await initializeClient({ req, res: {}, signal: null, endpointOption });
      expect(getModelsConfig).toHaveBeenCalledTimes(1);
      expect(mockLoadAgent).not.toHaveBeenCalled();
      expect(mockValidateAgentModel.mock.calls[0][0].modelsConfig).toBe(catalog);
    });

    test('keeps an early catalog rejection for the consumer without unhandled rejection', async () => {
      const req = prepareCatalogRequest();
      const catalogError = new Error('Synthetic catalog unavailable');
      let releaseAgent;
      mockLoadAgent.mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseAgent = resolve;
          }),
      );
      getModelsConfig.mockImplementation(() => Promise.reject(catalogError));
      const unhandled = [];
      const onUnhandled = (reason) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        const pending = buildFor(req);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        const callsWhileAgentPending = getModelsConfig.mock.calls.length;
        releaseAgent(plainMain());
        const endpointOption = await pending;
        await expect(initializeClient({ req, res: {}, signal: null, endpointOption })).rejects.toBe(
          catalogError,
        );
        expect(callsWhileAgentPending).toBe(1);
        expect(unhandled).toEqual([]);
        expect(getModelsConfig).toHaveBeenCalledTimes(1);
        expect(mockValidateAgentModel).not.toHaveBeenCalled();
        expect(mockInitializeAgent).not.toHaveBeenCalled();
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
      }
    });

    test('observes catalog rejection when an accepted build never reaches initialization', async () => {
      const req = prepareCatalogRequest();
      const catalogError = new Error('Synthetic interrupted catalog');
      getModelsConfig.mockImplementation(() => Promise.reject(catalogError));
      const unhandled = [];
      const onUnhandled = (reason) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        await buildFor(req);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        expect(getModelsConfig).toHaveBeenCalledTimes(1);
        expect(unhandled).toEqual([]);
        expect(mockInitializeAgent).not.toHaveBeenCalled();
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
      }
    });

    test.each([false, true])(
      'retains agent load error and catalog error precedence (catalog rejects=%s)',
      async (catalogRejects) => {
        const req = prepareCatalogRequest();
        const agentError = new Error('Synthetic agent unavailable');
        const catalogError = new Error('Synthetic catalog unavailable');
        mockLoadAgent.mockRejectedValue(agentError);
        getModelsConfig.mockImplementation(() =>
          catalogRejects ? Promise.reject(catalogError) : Promise.resolve({}),
        );
        const endpointOption = await buildFor(req);
        expect(await endpointOption.agent).toBeUndefined();
        if (catalogRejects) {
          await expect(
            initializeClient({ req, res: {}, signal: null, endpointOption }),
          ).rejects.toBe(catalogError);
        } else {
          await expect(
            initializeClient({ req, res: {}, signal: null, endpointOption }),
          ).rejects.toThrow('Agent not found');
        }
        const { logger } = require('@librechat/data-schemas');
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('Error retrieving agent during build options step'),
          agentError,
        );
        expect(getModelsConfig).toHaveBeenCalledTimes(1);
        expect(mockInitializeAgent).not.toHaveBeenCalled();
      },
    );

    test('still rejects an unsupported stored selection before native initialization', async () => {
      const req = prepareCatalogRequest();
      const validationError = { message: 'Synthetic selection rejected' };
      mockValidateAgentModel.mockResolvedValue({ isValid: false, error: validationError });
      const catalog = {
        openAI: ['different-legal-model'],
        anotherEndpoint: ['another-legal-model'],
      };
      getModelsConfig.mockResolvedValue(catalog);
      const endpointOption = await buildFor(req);
      await expect(
        initializeClient({ req, res: {}, signal: null, endpointOption }),
      ).rejects.toThrow(validationError.message);
      expect(mockValidateAgentModel.mock.calls[0][0].modelsConfig).toBe(catalog);
      expect(mockInitializeAgent).not.toHaveBeenCalled();
      expect(mockResolveFallbackCandidates).not.toHaveBeenCalled();
      expect(getModelsConfig).toHaveBeenCalledTimes(1);
    });

    test('retains High, tools, full workspace authority and the complete native catalog', async () => {
      const nativeMain = {
        ...plainMain(),
        provider: 'glasshive-harness',
        model: 'synthetic-native-model',
        instructions: 'Stable native policy.',
        tools: ['file_search', 'synthetic-connected-tool'],
        model_parameters: { reasoning_effort: 'high' },
        glasshive_options: { workspace: { mode: 'life' }, access: 'full' },
      };
      const expectedDigest = conversationProviderStableAuthorityDigest(nativeMain);
      const req = prepareCatalogRequest(nativeMain);
      const catalog = {
        'glasshive-harness': [nativeMain.model, 'other-legal-native-model'],
        openAI: ['other-legal-model'],
        additionalEndpoint: ['additional-legal-model'],
      };
      getModelsConfig.mockResolvedValue(catalog);
      Object.assign(req.config.endpoints.agents.providerCapabilities['glasshive-harness'], {
        conversation_session: true,
        native_session_authority: 'stable_authority_v1',
      });
      mockInitializeAgent.mockImplementation(async ({ agent }) => {
        expect(agent.model_parameters.reasoning_effort).toBe('high');
        expect(agent.tools).toEqual(nativeMain.tools);
        expect(agent.glasshive_options).toEqual(nativeMain.glasshive_options);
        const config = makeInitializedConfig(agent);
        config.model_parameters.configuration.defaultHeaders['X-GlassHive-Agent-Id'] = agent.id;
        return config;
      });
      const endpointOption = await buildFor(req, nativeMain);
      const { client } = await initializeClient({ req, res: {}, signal: null, endpointOption });
      expect(mockValidateAgentModel.mock.calls[0][0].modelsConfig).toBe(catalog);
      expect(
        client.options.agent.model_parameters.configuration.defaultHeaders[
          'X-GlassHive-Stable-Authority-SHA256'
        ],
      ).toBe(expectedDigest);
      expect(client.options.agent.model).toBe(nativeMain.model);
      expect(getModelsConfig).toHaveBeenCalledTimes(1);
      expect(mockStartParallelWorkTurnAuthority.mock.invocationCallOrder[0]).toBeLessThan(
        mockInitializeAgent.mock.invocationCallOrder[0],
      );
    });
  });
});
