const { Constants } = require('librechat-data-provider');
const crypto = require('crypto');

const mockEmitChunk = jest.fn();
jest.mock('@librechat/agents', () => ({
  GraphEvents: { ON_REASONING_DELTA: 'on_reasoning_delta' },
}));
jest.mock('@librechat/api', () => ({
  GenerationJobManager: { emitChunk: mockEmitChunk },
}));

jest.mock('../GlassHiveCapabilityBootstrapService', () => ({
  buildConversationProviderBootstrapBundle: jest.fn(),
}));

const {
  buildConversationProviderBootstrapBundle,
} = require('../GlassHiveCapabilityBootstrapService');
const {
  attachConversationProviderCapabilityBundle,
  bindConversationProviderDeveloperInstructionTail,
  bindHarnessCancellation,
  buildHarnessIdempotencyKey,
  declaredHandoffMcpServerNames,
  declaredMcpServerNames,
} = require('../GlassHiveConversationProviderService');

describe('GlassHiveConversationProviderService', () => {
  const originalBrokerSecret = process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = 'synthetic-bundle-secret';
  });

  afterAll(() => {
    if (originalBrokerSecret === undefined) {
      delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
    } else {
      process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = originalBrokerSecret;
    }
  });

  test('builds stable role-scoped keys for main, Phase B, and parallel cortices', () => {
    expect(buildHarnessIdempotencyKey('main', 'response-1')).toBe('main:response-1');
    expect(buildHarnessIdempotencyKey('phase_b', 'response-1', 'main-agent')).toBe(
      'phase_b:main-agent:response-1',
    );
    expect(buildHarnessIdempotencyKey('cortex', 'response-1', 'research')).toBe(
      'cortex:research:response-1',
    );
    expect(buildHarnessIdempotencyKey('cortex', 'response-1', 'red-team')).not.toBe(
      buildHarnessIdempotencyKey('cortex', 'response-1', 'research'),
    );
  });

  test('binds one exact provider-only developer tail without changing other providers', () => {
    const capsule = [
      '<viventium_feeling_state>',
      'Synthetic bright and playful private causal state.',
      '</viventium_feeling_state>',
    ].join('\n');
    const targetAgent = {
      model_parameters: {
        configuration: {
          defaultHeaders: {
            'X-GlassHive-Agent-Id': 'agent-synthetic',
            'X-Existing': 'kept',
          },
        },
      },
    };

    expect(
      bindConversationProviderDeveloperInstructionTail({ targetAgent, tail: capsule }),
    ).toBe(true);
    const headers = targetAgent.model_parameters.configuration.defaultHeaders;
    expect(headers['X-Existing']).toBe('kept');
    expect(
      Buffer.from(headers['X-GlassHive-Developer-Instruction-Tail-B64'], 'base64').toString(
        'utf8',
      ),
    ).toBe(capsule);

    expect(
      bindConversationProviderDeveloperInstructionTail({ targetAgent, tail: '' }),
    ).toBe(true);
    expect(
      targetAgent.model_parameters.configuration.defaultHeaders[
        'X-GlassHive-Developer-Instruction-Tail-B64'
      ],
    ).toBeUndefined();

    const ordinaryAgent = { model_parameters: { configuration: { defaultHeaders: {} } } };
    expect(
      bindConversationProviderDeveloperInstructionTail({
        targetAgent: ordinaryAgent,
        tail: capsule,
      }),
    ).toBe(false);
    expect(ordinaryAgent.model_parameters.configuration.defaultHeaders).toEqual({});
  });

  test('delivers an intentional Stop to the exact authenticated main request', async () => {
    const abortController = new AbortController();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const onDeliveryError = jest.fn();
    const req = {
      _viventiumHarnessExecutionEnabled: true,
      _viventiumHarnessActivityEnabled: true,
      _viventiumHarnessIdempotencyKey: 'main:response-1',
      _resumableStreamId: 'stream-synthetic',
      body: { responseMessageId: 'response-wrong' },
      user: { id: 'user-synthetic' },
    };

    expect(
      bindHarnessCancellation({
        req,
        signal: abortController.signal,
        endpointConfig: { baseURL: 'http://glasshive.local/v1/', apiKey: 'synthetic-key' },
        fetchImpl,
        onDeliveryError,
      }),
    ).toBe(true);

    abortController.abort('user_cancelled');
    await abortController.signal._viventiumHarnessCancellationDelivery;
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://glasshive.local/v1/requests/by-idempotency/main%3Aresponse-1/cancel',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer synthetic-key',
          'X-Viventium-User-Id': 'user-synthetic',
        },
      }),
    );
    expect(onDeliveryError).not.toHaveBeenCalled();
    expect(mockEmitChunk).toHaveBeenCalledWith(
      'stream-synthetic',
      expect.objectContaining({
        data: {
          id: 'stream-synthetic-harness-cancelled',
          delta: {
            content: [
              {
                type: 'harness_activity',
                harness_activity: {
                  event: 'cancelled',
                  summary: 'The harness turn was cancelled.\n',
                },
              },
            ],
          },
        },
      }),
    );
  });

  test('delivers an intentional Stop when the signal was already aborted before binding', async () => {
    const abortController = new AbortController();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    abortController.abort('user_cancelled');

    expect(
      bindHarnessCancellation({
        req: {
          _viventiumHarnessExecutionEnabled: true,
          _viventiumHarnessIdempotencyKey: 'main:response-pre-aborted',
          user: { id: 'user-synthetic' },
        },
        signal: abortController.signal,
        endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
        fetchImpl,
      }),
    ).toBe(true);

    await expect(abortController.signal._viventiumHarnessCancellationDelivery).resolves.toEqual({
      delivered: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('acknowledges native cancellation without waiting for activity delivery', async () => {
    const abortController = new AbortController();
    const onDeliveryError = jest.fn();
    mockEmitChunk.mockImplementationOnce(() => new Promise(() => {}));

    bindHarnessCancellation({
      req: {
        _viventiumHarnessExecutionEnabled: true,
        _viventiumHarnessActivityEnabled: true,
        _viventiumHarnessIdempotencyKey: 'main:response-stalled-activity',
        _resumableStreamId: 'stream-stalled-activity',
        user: { id: 'user-synthetic' },
      },
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
      fetchImpl: jest.fn().mockResolvedValue({ ok: true }),
      onDeliveryError,
      activityDeliveryTimeoutMs: 1,
    });

    abortController.abort('user_cancelled');

    await expect(abortController.signal._viventiumHarnessCancellationDelivery).resolves.toEqual({
      delivered: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(onDeliveryError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'GlassHive cancellation activity delivery timed out' }),
    );
  });

  test('does not cancel the native run for a transport disconnect', async () => {
    const abortController = new AbortController();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    bindHarnessCancellation({
      req: {
        _viventiumHarnessExecutionEnabled: true,
        body: { responseMessageId: 'response-1' },
        user: { id: 'user-synthetic' },
      },
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
      fetchImpl,
    });

    abortController.abort('transport_disconnected');
    await Promise.resolve();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('reports a non-success cancellation response instead of silently accepting it', async () => {
    const abortController = new AbortController();
    const onDeliveryError = jest.fn();
    bindHarnessCancellation({
      req: {
        _viventiumHarnessExecutionEnabled: true,
        _viventiumHarnessIdempotencyKey: 'main:response-1',
        body: {},
        user: { id: 'user-synthetic' },
      },
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
      fetchImpl: jest.fn().mockResolvedValue({ ok: false, status: 503 }),
      onDeliveryError,
    });

    abortController.abort('user_cancelled');
    await new Promise((resolve) => setImmediate(resolve));

    expect(onDeliveryError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'GlassHive cancellation returned HTTP 503' }),
    );
  });

  test('projects only declared non-GlassHive MCP servers', () => {
    const delimiter = Constants.mcp_delimiter;
    const names = declaredMcpServerNames(
      {
        tools: [
          `read_mail${delimiter}google-workspace`,
          `read_drive${delimiter}google-workspace`,
          `worker_run${delimiter}glasshive-workers-projects`,
          'file_search',
          { name: 'not-a-persisted-tool-id' },
        ],
      },
      ['glasshive-workers-projects'],
    );

    expect(names).toEqual(['google-workspace']);
  });

  test('does nothing when the selected provider has no workspace binding capability', async () => {
    const targetAgent = { model_parameters: {} };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        req: { user: { id: 'user-synthetic' }, body: {} },
        capability: { workspace_binding: false },
      }),
    ).resolves.toBe(false);

    expect(buildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
    expect(targetAgent).toEqual({ model_parameters: {} });
  });

  test('attaches one signed bundle while preserving existing provider headers', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      codex_config_append: '[mcp_servers.synthetic]',
    });
    const delimiter = Constants.mcp_delimiter;
    const requestBody = {
      conversationId: 'conversation-synthetic',
      messageId: 'message-synthetic',
    };
    const targetAgent = {
      model_parameters: {
        configuration: { defaultHeaders: { 'X-Existing': 'kept' } },
      },
    };
    const declaredAgent = {
      tools: [
        `search${delimiter}google-workspace`,
        `worker_run${delimiter}glasshive-workers-projects`,
      ],
    };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent,
        req: { user: { id: 'user-synthetic' }, body: { ignored: true } },
        requestBody,
        capability: {
          workspace_binding: true,
          excluded_mcp_servers: ['glasshive-workers-projects'],
        },
      }),
    ).resolves.toBe(true);

    expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledWith({
      user: { id: 'user-synthetic' },
      requestBody,
      allowedServerNames: ['google-workspace'],
      deferredServerNames: [],
      excludedServerNames: ['glasshive-workers-projects'],
    });
    const headers = targetAgent.model_parameters.configuration.defaultHeaders;
    expect(headers['X-Existing']).toBe('kept');
    expect(
      JSON.parse(Buffer.from(headers['X-GlassHive-Bootstrap-Bundle-B64'], 'base64').toString()),
    ).toEqual({ codex_config_append: '[mcp_servers.synthetic]' });
    const expected = crypto
      .createHmac('sha256', 'synthetic-bundle-secret')
      .update(
        `v1\n${headers['X-GlassHive-Bootstrap-Timestamp']}\n${headers['X-GlassHive-Bootstrap-Bundle-B64']}`,
      )
      .digest('hex');
    expect(headers['X-GlassHive-Bootstrap-Signature']).toBe(`sha256=${expected}`);
  });

  test('attaches only reviewed MCPs owned by a declared handoff as deferred capabilities', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      codex_config_append: '[mcp_servers.synthetic]',
    });
    const targetAgent = { model_parameters: {} };
    const declaredAgent = {
      id: 'main-agent',
      tools: [],
      edges: [
        {
          from: 'main-agent',
          to: 'connected-accounts',
          edgeType: 'handoff',
        },
      ],
    };
    const resolveAgentById = jest.fn().mockResolvedValue({
      id: 'connected-accounts',
      tools: [
        `search${Constants.mcp_delimiter}google_workspace`,
        `list${Constants.mcp_delimiter}ms-365`,
        `run${Constants.mcp_delimiter}glasshive-workers-projects`,
      ],
    });

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent,
        req: { user: { id: 'user-synthetic' }, body: {} },
        resolveAgentById,
        capability: {
          workspace_binding: true,
          reviewed_mcp_projection: 'deferred',
          excluded_mcp_servers: ['glasshive-workers-projects'],
        },
      }),
    ).resolves.toBe(true);

    expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledWith({
      user: { id: 'user-synthetic' },
      requestBody: {},
      allowedServerNames: [],
      deferredServerNames: ['google_workspace', 'ms-365'],
      excludedServerNames: ['glasshive-workers-projects'],
    });
    expect(resolveAgentById).toHaveBeenCalledWith('connected-accounts');
  });

  test('projects deferred MCPs through default handoff edges with array endpoints', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      codex_config_append: '[mcp_servers.synthetic]',
    });
    const targetAgent = { model_parameters: {} };
    const declaredAgent = {
      id: 'main-agent',
      tools: [],
      edges: [
        {
          from: ['other-agent', 'main-agent'],
          to: ['connected-accounts', 'connected-files'],
        },
        {
          from: 'main-agent',
          to: 'direct-target',
          edgeType: 'direct',
        },
      ],
    };
    const resolveAgentById = jest.fn(async (id) => {
      const agents = {
        'connected-accounts': {
          tools: [`search${Constants.mcp_delimiter}google_workspace`],
        },
        'connected-files': { tools: [`list${Constants.mcp_delimiter}ms-365`] },
        'direct-target': { tools: [`ignored${Constants.mcp_delimiter}unreviewed`] },
      };
      return agents[id];
    });

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent,
        req: { user: { id: 'user-synthetic' }, body: {} },
        resolveAgentById,
        capability: {
          workspace_binding: true,
          reviewed_mcp_projection: 'deferred',
        },
      }),
    ).resolves.toBe(true);

    expect(resolveAgentById.mock.calls.map(([id]) => id)).toEqual([
      'connected-accounts',
      'connected-files',
    ]);
    expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledWith({
      user: { id: 'user-synthetic' },
      requestBody: {},
      allowedServerNames: [],
      deferredServerNames: ['google_workspace', 'ms-365'],
      excludedServerNames: [],
    });
  });

  test('does not project unrelated reviewed MCPs when no declared handoff owns them', async () => {
    const resolver = jest.fn();

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent: { model_parameters: {} },
        declaredAgent: { id: 'standalone-agent', tools: [], edges: [] },
        req: { user: { id: 'user-synthetic' }, body: {} },
        resolveAgentById: resolver,
        capability: {
          workspace_binding: true,
          reviewed_mcp_projection: 'deferred',
        },
      }),
    ).resolves.toBe(false);

    expect(resolver).not.toHaveBeenCalled();
    expect(buildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
  });

  test('derives handoff MCP ownership from structured edges and excludes self-delegation', async () => {
    const resolveAgentById = jest.fn().mockResolvedValue({
      tools: [
        `read${Constants.mcp_delimiter}ms-365`,
        `run${Constants.mcp_delimiter}glasshive-workers-projects`,
      ],
    });

    await expect(
      declaredHandoffMcpServerNames(
        {
          id: 'main-agent',
          edges: [
            { from: 'main-agent', to: 'connected-accounts', edgeType: 'handoff' },
            { from: 'other-agent', to: 'unrelated', edgeType: 'handoff' },
          ],
        },
        ['glasshive-workers-projects'],
        resolveAgentById,
      ),
    ).resolves.toEqual(['ms-365']);
  });

  test('returns typed degraded capability context when a declared handoff cannot be resolved', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      glasshive_capability_status: {
        status: 'degraded',
        reason: 'handoff_capability_resolution_unavailable',
      },
    });

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent: { model_parameters: {} },
        declaredAgent: {
          id: 'main-agent',
          tools: [],
          edges: [{ from: 'main-agent', to: 'connected-accounts', edgeType: 'handoff' }],
        },
        req: { user: { id: 'user-synthetic' }, body: {} },
        resolveAgentById: jest.fn().mockRejectedValue(new Error('synthetic lookup outage')),
        capability: {
          workspace_binding: true,
          reviewed_mcp_projection: 'deferred',
        },
      }),
    ).resolves.toBe(true);

    expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledWith({
      user: { id: 'user-synthetic' },
      requestBody: {},
      allowedServerNames: [],
      deferredServerNames: [],
      excludedServerNames: [],
      capabilityResolutionStatus: 'handoff_capability_resolution_unavailable',
    });
  });

  test('fails closed instead of sending an unsigned capability bundle', async () => {
    delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
    buildConversationProviderBootstrapBundle.mockResolvedValue({ env: { SYNTHETIC: 'value' } });

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent: { model_parameters: {} },
        declaredAgent: { tools: [`search${Constants.mcp_delimiter}synthetic-server`] },
        req: { user: { id: 'user-synthetic' }, body: {} },
        capability: { workspace_binding: true },
      }),
    ).rejects.toThrow('bootstrap signature secret is not configured');
  });
});
