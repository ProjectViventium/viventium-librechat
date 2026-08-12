const { Constants } = require('librechat-data-provider');
const crypto = require('crypto');

jest.mock('../GlassHiveCapabilityBootstrapService', () => ({
  buildConversationProviderBootstrapBundle: jest.fn(),
}));
jest.mock('~/app/clients/tools/util/fileSearch', () => ({
  primeFiles: jest.fn(async ({ tool_resources }) => ({
    files: tool_resources?.file_search?.files || [],
    toolContext: '',
  })),
}));

const {
  buildConversationProviderBootstrapBundle,
} = require('../GlassHiveCapabilityBootstrapService');
const { primeFiles } = require('~/app/clients/tools/util/fileSearch');
const {
  applyHostEvidenceBoundaryInstructions,
  attachDeclaredConversationProviderCapabilityBundle,
  attachConversationProviderCapabilityBundle,
  installConversationProviderCapabilityRefresher,
  bindConversationProviderDeveloperInstructionTail,
  bindHarnessCancellation,
  buildHarnessAgentIdempotencyKeys,
  buildHarnessAttemptIdempotencyKey,
  buildHarnessIdempotencyKey,
  configuredBrokerHostTools,
  declaredMcpServerNames,
  resolveConversationProviderId,
  setConversationProviderCapability,
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

  test('gives a generic fallback attempt a distinct request identity in the same outer turn', () => {
    const req = { _viventiumHarnessExecutionEnabled: true };

    expect(buildHarnessAttemptIdempotencyKey(req, 'response-1')).toBe('main:response-1');
    req._viventiumFallbackLlmAttempt = true;
    expect(buildHarnessAttemptIdempotencyKey(req, 'response-1')).toBe('main-fallback:response-1');
  });

  test('gives each workspace-bound graph agent a stable distinct request identity', () => {
    const req = { _viventiumHarnessExecutionEnabled: true };
    const first = buildHarnessAgentIdempotencyKeys(req, 'response-1', {
      primaryAgentId: 'main-agent',
      agentIds: ['main-agent', 'reality-agent'],
    });
    const retry = buildHarnessAgentIdempotencyKeys(req, 'response-1', {
      primaryAgentId: 'main-agent',
      agentIds: ['main-agent', 'reality-agent'],
    });

    expect(first).toEqual({
      primaryKey: 'main:response-1',
      byAgentId: {
        'main-agent': 'main:response-1',
        'reality-agent': 'main:reality-agent:response-1',
      },
      allKeys: ['main:response-1', 'main:reality-agent:response-1'],
    });
    expect(retry).toEqual(first);
    expect(first.byAgentId['reality-agent']).not.toBe(first.byAgentId['main-agent']);
  });

  test('preserves completed-transfer receipt families across graph fallback models', () => {
    const req = { _viventiumHarnessExecutionEnabled: true };
    const primary = buildHarnessAgentIdempotencyKeys(req, 'response-1', {
      primaryAgentId: 'main-agent',
      agentIds: ['main-agent', 'reality-agent', 'red-agent'],
      preserveGraphTurnFamily: true,
    });

    req._viventiumFallbackLlmAttempt = true;
    const graphFallback = buildHarnessAgentIdempotencyKeys(req, 'response-1', {
      primaryAgentId: 'main-agent',
      agentIds: ['main-agent', 'reality-agent', 'red-agent'],
      preserveGraphTurnFamily: true,
    });

    expect(graphFallback).toEqual(primary);
    expect(graphFallback.byAgentId).toEqual({
      'main-agent': 'main:response-1',
      'reality-agent': 'main:reality-agent:response-1',
      'red-agent': 'main:red-agent:response-1',
    });
    expect(buildHarnessAttemptIdempotencyKey(req, 'response-1')).toBe('main-fallback:response-1');
  });

  test('scopes workspace handoffs even when the primary provider is not workspace-bound', () => {
    const req = { _viventiumHarnessExecutionEnabled: false };

    expect(
      buildHarnessAgentIdempotencyKeys(req, 'response-1', {
        primaryAgentId: 'direct-main',
        agentIds: ['reality-agent', 'research-agent'],
      }),
    ).toEqual({
      primaryKey: '',
      byAgentId: {
        'reality-agent': 'main:reality-agent:response-1',
        'research-agent': 'main:research-agent:response-1',
      },
      allKeys: ['main:reality-agent:response-1', 'main:research-agent:response-1'],
    });
  });

  test('keeps the declared custom endpoint after provider transport normalization', () => {
    expect(
      resolveConversationProviderId({
        endpoint: 'glasshive-harness',
        provider: 'openAI',
      }),
    ).toBe('glasshive-harness');
    expect(resolveConversationProviderId({ provider: 'anthropic' })).toBe('anthropic');
  });

  test('switches harness execution flags from structured provider capabilities', () => {
    const req = {
      config: {
        endpoints: {
          agents: {
            providerCapabilities: {
              'glasshive-harness': {
                activity_stream: true,
                workspace_binding: true,
                conversation_session: true,
              },
              anthropic: {
                activity_stream: false,
                workspace_binding: false,
                conversation_session: false,
              },
            },
          },
        },
      },
    };

    expect(setConversationProviderCapability(req, 'glasshive-harness')).toMatchObject({
      workspace_binding: true,
    });
    expect(req).toMatchObject({
      _viventiumHarnessActivityEnabled: true,
      _viventiumHarnessExecutionEnabled: true,
      viventiumTimeContextDelivery: 'per_turn_header',
    });

    expect(setConversationProviderCapability(req, 'anthropic')).toMatchObject({
      workspace_binding: false,
    });
    expect(req).toMatchObject({
      _viventiumHarnessActivityEnabled: false,
      _viventiumHarnessExecutionEnabled: false,
      viventiumTimeContextDelivery: 'developer',
    });
  });

  test('never re-enables or signs native capabilities for an unverified voice actor', async () => {
    const req = {
      body: {
        voiceMode: true,
        viventiumActorTrust: 'shared_mic_unverified',
        viventiumCanAuthorizeSideEffects: false,
      },
      config: {
        endpoints: {
          agents: {
            providerCapabilities: {
              'glasshive-harness': {
                activity_stream: true,
                workspace_binding: true,
                conversation_session: true,
              },
            },
          },
        },
      },
      _viventiumHarnessIdempotencyKey: 'synthetic-must-be-cleared',
    };
    const capability = setConversationProviderCapability(req, 'glasshive-harness');
    const targetAgent = {
      id: 'agent-synthetic',
      tools: [`send_email${Constants.mcp_delimiter}synthetic-connected-account`],
      model_parameters: { configuration: { defaultHeaders: {} } },
    };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: targetAgent,
        req,
        capability,
      }),
    ).resolves.toBe(false);

    expect(buildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
    expect(req).toMatchObject({
      _viventiumHarnessActivityEnabled: false,
      _viventiumHarnessExecutionEnabled: false,
    });
    expect(req._viventiumHarnessIdempotencyKey).toBeUndefined();
    expect(targetAgent.model_parameters.configuration.defaultHeaders).toEqual({});
  });

  test('derives delegated host-tool policy from structured broker capabilities only', () => {
    expect(
      configuredBrokerHostTools({
        first: {
          workspace_binding: true,
          host_tools_transport: 'broker_mcp',
          host_tools: ['file_search'],
        },
        disabled: {
          workspace_binding: false,
          host_tools_transport: 'broker_mcp',
          host_tools: ['untrusted_tool'],
        },
      }),
    ).toEqual(['file_search']);
  });

  test('delivers an intentional Stop to the exact authenticated main request', async () => {
    const abortController = new AbortController();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const req = {
      _viventiumHarnessExecutionEnabled: true,
      _viventiumHarnessIdempotencyKey: 'main:response-1',
      body: { responseMessageId: 'response-wrong' },
      user: { id: 'user-synthetic' },
    };

    expect(
      bindHarnessCancellation({
        req,
        signal: abortController.signal,
        endpointConfig: { baseURL: 'http://glasshive.local/v1/', apiKey: 'synthetic-key' },
        fetchImpl,
      }),
    ).toBe(true);

    abortController.abort('user_cancelled');
    await Promise.resolve();

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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('retries an unacknowledged Stop delivery and stops after the first acknowledgement', async () => {
    jest.useFakeTimers();
    try {
      const abortController = new AbortController();
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValueOnce({ ok: true, status: 200 });
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
        fetchImpl,
        onDeliveryError,
      });

      abortController.abort('user_cancelled');

      // Stop remains synchronous/nonblocking even while its delivery is awaiting acknowledgement.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await jest.runAllTimersAsync();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[1]).toEqual(fetchImpl.mock.calls[0]);
      expect(onDeliveryError).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('deduplicates participant keys and endpoint bindings before delivering Stop', async () => {
    const abortController = new AbortController();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const req = {
      _viventiumHarnessExecutionEnabled: true,
      _viventiumHarnessIdempotencyKeys: ['main:response-1', 'main:response-1'],
      body: {},
      user: { id: 'user-synthetic' },
    };
    const binding = {
      req,
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
      fetchImpl,
    };

    expect(bindHarnessCancellation(binding)).toBe(true);
    expect(bindHarnessCancellation(binding)).toBe(true);
    abortController.abort('user_cancelled');
    await Promise.resolve();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('targets the fallback attempt when Stop arrives before the fallback stream opens', async () => {
    const abortController = new AbortController();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const req = {
      _viventiumHarnessExecutionEnabled: true,
      _viventiumFallbackLlmAttempt: true,
      body: { responseMessageId: 'response-1' },
      user: { id: 'user-synthetic' },
    };

    bindHarnessCancellation({
      req,
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
      fetchImpl,
    });
    abortController.abort('user_cancelled');
    await Promise.resolve();

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://glasshive.local/v1/requests/by-idempotency/main-fallback%3Aresponse-1/cancel',
      expect.any(Object),
    );
  });

  test('an intentional Stop cancels every workspace-bound graph attempt', async () => {
    const abortController = new AbortController();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const req = {
      _viventiumHarnessExecutionEnabled: true,
      _viventiumHarnessIdempotencyKey: 'main:response-1',
      _viventiumHarnessIdempotencyKeys: new Set([
        'main:response-1',
        'main:reality-agent:response-1',
      ]),
      body: { responseMessageId: 'response-1' },
      user: { id: 'user-synthetic' },
    };

    bindHarnessCancellation({
      req,
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
      fetchImpl,
    });
    abortController.abort('user_cancelled');
    await Promise.resolve();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://glasshive.local/v1/requests/by-idempotency/main%3Aresponse-1/cancel',
      'http://glasshive.local/v1/requests/by-idempotency/main%3Areality-agent%3Aresponse-1/cancel',
    ]);
  });

  test('workspace handoff keys can bind cancellation without a workspace primary', async () => {
    const abortController = new AbortController();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const req = {
      _viventiumHarnessExecutionEnabled: false,
      _viventiumHarnessIdempotencyKeys: new Set(['main:reality-agent:response-1']),
      body: { responseMessageId: 'response-1' },
      user: { id: 'user-synthetic' },
    };

    expect(
      bindHarnessCancellation({
        req,
        signal: abortController.signal,
        endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
        fetchImpl,
      }),
    ).toBe(true);
    abortController.abort('user_cancelled');
    await Promise.resolve();

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://glasshive.local/v1/requests/by-idempotency/main%3Areality-agent%3Aresponse-1/cancel',
      expect.any(Object),
    );
  });

  test('only the active harness endpoint receives fallback cancellation', async () => {
    const abortController = new AbortController();
    const primaryFetch = jest.fn().mockResolvedValue({ ok: true });
    const fallbackFetch = jest.fn().mockResolvedValue({ ok: true });
    const req = {
      _viventiumHarnessExecutionEnabled: true,
      _viventiumFallbackLlmAttempt: true,
      _viventiumHarnessIdempotencyKey: 'main-fallback:response-1',
      body: { responseMessageId: 'response-1' },
      user: { id: 'user-synthetic' },
    };
    bindHarnessCancellation({
      req,
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://primary.local/v1', apiKey: 'primary-key' },
      fetchImpl: primaryFetch,
    });
    bindHarnessCancellation({
      req,
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://fallback.local/v1', apiKey: 'fallback-key' },
      fetchImpl: fallbackFetch,
    });

    abortController.abort('user_cancelled');
    await Promise.resolve();

    expect(primaryFetch).not.toHaveBeenCalled();
    expect(fallbackFetch).toHaveBeenCalledTimes(1);
  });

  test.each(['transport_disconnected', 'provider_response_deadline_exceeded', undefined])(
    'does not cancel the native run for a non-user abort reason: %s',
    async (abortReason) => {
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

      abortController.abort(abortReason);
      await Promise.resolve();

      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test('reports one bounded terminal error when Stop delivery is never acknowledged', async () => {
    jest.useFakeTimers();
    try {
      const abortController = new AbortController();
      const onDeliveryError = jest.fn();
      const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 503 });
      bindHarnessCancellation({
        req: {
          _viventiumHarnessExecutionEnabled: true,
          _viventiumHarnessIdempotencyKey: 'main:response-1',
          body: {},
          user: { id: 'user-synthetic' },
        },
        signal: abortController.signal,
        endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
        fetchImpl,
        onDeliveryError,
      });

      abortController.abort('user_cancelled');
      await jest.runAllTimersAsync();

      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(onDeliveryError).toHaveBeenCalledTimes(1);
      expect(onDeliveryError).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'HARNESS_CANCELLATION_DELIVERY_FAILED',
          attempts: 3,
          status: 503,
          message:
            'GlassHive cancellation was not acknowledged after 3 attempts (last outcome: HTTP 503)',
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test('does not retry a permanent Stop delivery rejection', async () => {
    jest.useFakeTimers();
    try {
      const abortController = new AbortController();
      const onDeliveryError = jest.fn();
      const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 401 });
      bindHarnessCancellation({
        req: {
          _viventiumHarnessExecutionEnabled: true,
          _viventiumHarnessIdempotencyKey: 'main:response-1',
          body: {},
          user: { id: 'user-synthetic' },
        },
        signal: abortController.signal,
        endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
        fetchImpl,
        onDeliveryError,
      });

      abortController.abort('user_cancelled');
      await jest.runAllTimersAsync();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(onDeliveryError).toHaveBeenCalledTimes(1);
      expect(onDeliveryError).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'HARNESS_CANCELLATION_DELIVERY_FAILED',
          attempts: 1,
          status: 401,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
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

  test('projects a resolved host tool even when the Agent declares no external MCP server', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      glasshive_capability_broker: { allowed_host_tools: ['file_search'] },
      conversation_provider_instructions:
        'Host-tool resources are service-backed. Call the authorized host tool first.',
    });
    const recallFile = {
      file_id: 'conversation_recall:all:user-synthetic',
      filename: 'conversation-recall-all.txt',
      context: 'conversation_recall',
      viventiumConversationRecallMode: 'source_only',
      viventiumConversationRecallAttachmentReason: 'stale_corpus',
    };
    const targetAgent = {
      id: 'agent-synthetic',
      toolRegistry: new Map([['file_search', { name: 'file_search' }]]),
      tool_resources: { file_search: { files: [recallFile] } },
      instructions: 'Existing authority.',
      model_parameters: { configuration: { defaultHeaders: {} } },
    };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: { id: 'agent-synthetic', tools: ['file_search'] },
        req: {
          user: { id: 'user-synthetic' },
          body: { conversationId: 'conversation-synthetic', messageId: 'message-synthetic' },
        },
        capability: {
          workspace_binding: true,
          host_tools_transport: 'broker_mcp',
          host_tools: ['file_search'],
        },
      }),
    ).resolves.toBe(true);

    expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledWith({
      user: { id: 'user-synthetic' },
      requestBody: { conversationId: 'conversation-synthetic', messageId: 'message-synthetic' },
      allowedServerNames: [],
      allowedHostTools: ['file_search'],
      hostToolResources: {
        file_search: {
          entity_id: 'agent-synthetic',
          files: [recallFile],
        },
      },
    });
    expect(targetAgent.instructions).toBe(
      'Existing authority.\n\nHost-tool resources are service-backed. Call the authorized host tool first.',
    );
  });

  test('publishes the filesystem-substitution policy when a configured host tool has no authorized resources', async () => {
    const targetAgent = {
      id: 'agent-synthetic',
      toolRegistry: new Map([['file_search', { name: 'file_search' }]]),
      tool_resources: { file_search: { files: [] } },
      instructions: 'Existing authority.',
      model_parameters: { configuration: { defaultHeaders: {} } },
    };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: { id: 'agent-synthetic', tools: ['file_search'] },
        req: {
          user: { id: 'user-synthetic' },
          body: { conversationId: 'conversation-synthetic', messageId: 'message-synthetic' },
        },
        capability: {
          workspace_binding: true,
          host_tools_transport: 'broker_mcp',
          host_tools: ['file_search'],
        },
      }),
    ).resolves.toBe(false);

    expect(buildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
    expect(targetAgent.instructions).toContain(
      'These configured host capabilities have no authorized resources for this turn: file_search.',
    );
    expect(targetAgent.instructions).toContain(
      'Do not emulate or replace an unavailable host capability by searching application state',
    );
    expect(targetAgent.model_parameters.configuration.defaultHeaders).toEqual({});
  });

  test('replaces a stale host-evidence policy block when runtime resource state changes', () => {
    const targetAgent = { instructions: 'Existing authority.' };

    applyHostEvidenceBoundaryInstructions(targetAgent, ['file_search']);
    expect(targetAgent.instructions).toContain('<viventium_host_evidence_boundary>');
    expect(targetAgent.instructions).toContain('file_search');

    applyHostEvidenceBoundaryInstructions(targetAgent, []);
    expect(targetAgent.instructions).toBe('Existing authority.');
  });

  test('keeps resource-less host tools authorized instead of classifying them as unavailable', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      glasshive_capability_broker: { allowed_host_tools: ['workspace_action'] },
    });
    const targetAgent = {
      id: 'agent-synthetic',
      toolRegistry: new Map([['workspace_action', { name: 'workspace_action' }]]),
      instructions: 'Existing authority.',
      model_parameters: { configuration: { defaultHeaders: {} } },
    };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: { id: 'agent-synthetic', tools: ['workspace_action'] },
        req: {
          user: { id: 'user-synthetic' },
          body: { conversationId: 'conversation-synthetic', messageId: 'message-synthetic' },
        },
        capability: {
          workspace_binding: true,
          host_tools_transport: 'broker_mcp',
          host_tools: ['workspace_action'],
        },
      }),
    ).resolves.toBe(true);

    expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedHostTools: ['workspace_action'],
        hostToolResources: {},
      }),
    );
    expect(targetAgent.instructions).not.toContain('no authorized resources');
  });

  test('projects ACL-primed agent knowledge-base file_ids instead of silently dropping them', async () => {
    const primedFile = { file_id: 'kb-file-1', filename: 'knowledge-base.txt' };
    primeFiles.mockResolvedValueOnce({ files: [primedFile], toolContext: '' });
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      glasshive_capability_broker: { allowed_host_tools: ['file_search'] },
    });
    const targetAgent = {
      id: 'agent-synthetic',
      toolRegistry: new Map([['file_search', { name: 'file_search' }]]),
      tool_resources: { file_search: { file_ids: ['kb-file-1'], files: [] } },
      model_parameters: { configuration: { defaultHeaders: {} } },
    };
    const req = {
      user: { id: 'user-synthetic', role: 'USER' },
      body: { conversationId: 'conversation-synthetic', messageId: 'message-synthetic' },
    };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: { id: 'agent-synthetic', tools: ['file_search'] },
        req,
        capability: {
          workspace_binding: true,
          host_tools_transport: 'broker_mcp',
          host_tools: ['file_search'],
        },
      }),
    ).resolves.toBe(true);

    expect(primeFiles).toHaveBeenCalledWith({
      tool_resources: targetAgent.tool_resources,
      req,
      agentId: 'agent-synthetic',
    });
    expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        hostToolResources: {
          file_search: { entity_id: 'agent-synthetic', files: [primedFile] },
        },
      }),
    );
  });

  test('degrades a failed host-resource prime to an explicit unavailable capability', async () => {
    primeFiles.mockRejectedValueOnce(new Error('synthetic resource failure'));
    const targetAgent = {
      id: 'agent-synthetic',
      toolRegistry: new Map([['file_search', { name: 'file_search' }]]),
      tool_resources: { file_search: { file_ids: ['kb-file-1'] } },
      model_parameters: { configuration: { defaultHeaders: {} } },
    };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: { id: 'agent-synthetic', tools: ['file_search'] },
        req: {
          user: { id: 'user-synthetic' },
          body: { conversationId: 'conversation-synthetic', messageId: 'message-synthetic' },
        },
        capability: {
          workspace_binding: true,
          host_tools_transport: 'broker_mcp',
          host_tools: ['file_search'],
        },
      }),
    ).resolves.toBe(false);
    expect(targetAgent.instructions).toContain('no authorized resources');
    expect(buildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
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

  test('binds the exact dynamic authority tail only to a GlassHive provider request', () => {
    const capsule = [
      '<viventium_feeling_state>',
      'Synthetic private causal state.',
      '</viventium_feeling_state>',
    ].join('\n');
    const targetAgent = {
      model_parameters: {
        configuration: {
          defaultHeaders: {
            'X-Existing': 'kept',
            'X-GlassHive-Agent-Id': 'agent-synthetic',
          },
        },
      },
    };

    expect(bindConversationProviderDeveloperInstructionTail({ targetAgent, tail: capsule })).toBe(
      true,
    );
    const headers = targetAgent.model_parameters.configuration.defaultHeaders;
    expect(headers['X-Existing']).toBe('kept');
    expect(
      Buffer.from(headers['X-GlassHive-Developer-Instruction-Tail-B64'], 'base64').toString('utf8'),
    ).toBe(capsule);

    expect(bindConversationProviderDeveloperInstructionTail({ targetAgent, tail: '' })).toBe(true);
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
      allowedHostTools: [],
      hostToolResources: {},
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

  test('regenerates the complete signed bundle and broker grant after 301 and 601 seconds', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-10T18:52:15.000Z'));
    try {
      buildConversationProviderBootstrapBundle.mockImplementation(async () => {
        const issuedAt = Math.floor(Date.now() / 1000);
        return {
          glasshive_capability_broker: {
            grant_token: `synthetic-grant-${issuedAt}`,
            grant: { iat: issuedAt, exp: issuedAt + 600 },
          },
          conversation_provider_instructions: 'Use the freshly authorized host capability.',
        };
      });
      const targetAgent = {
        id: 'agent-synthetic',
        toolRegistry: new Map([['file_search', { name: 'file_search' }]]),
        tool_resources: { file_search: { files: [{ file_id: 'synthetic-file' }] } },
        model_parameters: { configuration: { defaultHeaders: { 'X-Existing': 'kept' } } },
      };
      const args = {
        targetAgent,
        declaredAgent: { id: 'agent-synthetic', tools: ['file_search'] },
        req: {
          user: { id: 'user-synthetic' },
          body: { conversationId: 'conversation-synthetic', messageId: 'message-synthetic' },
        },
        capability: {
          workspace_binding: true,
          host_tools_transport: 'broker_mcp',
          host_tools: ['file_search'],
        },
      };

      await expect(attachConversationProviderCapabilityBundle(args)).resolves.toBe(true);
      expect(installConversationProviderCapabilityRefresher(args)).toBe(true);
      const descriptor = Object.getOwnPropertyDescriptor(
        targetAgent,
        'viventiumConversationProviderCapabilityRefresh',
      );
      expect(descriptor).toMatchObject({ enumerable: false, writable: false });
      const initialHeaders = { ...targetAgent.model_parameters.configuration.defaultHeaders };

      jest.setSystemTime(new Date('2026-08-10T18:57:16.000Z'));
      const after301 = await descriptor.value();
      jest.setSystemTime(new Date('2026-08-10T19:02:16.000Z'));
      const after601 = await descriptor.value();

      const decode = (headers) =>
        JSON.parse(Buffer.from(headers['X-GlassHive-Bootstrap-Bundle-B64'], 'base64').toString());
      const refreshedHeaders = [initialHeaders, after301.defaultHeaders, after601.defaultHeaders];
      for (const headers of refreshedHeaders) {
        const expectedSignature = crypto
          .createHmac('sha256', 'synthetic-bundle-secret')
          .update(
            `v1\n${headers['X-GlassHive-Bootstrap-Timestamp']}\n${headers['X-GlassHive-Bootstrap-Bundle-B64']}`,
          )
          .digest('hex');
        expect(headers['X-GlassHive-Bootstrap-Signature']).toBe(`sha256=${expectedSignature}`);
      }
      expect([
        initialHeaders['X-GlassHive-Bootstrap-Timestamp'],
        after301.defaultHeaders['X-GlassHive-Bootstrap-Timestamp'],
        after601.defaultHeaders['X-GlassHive-Bootstrap-Timestamp'],
      ]).toEqual(['1786387935', '1786388236', '1786388536']);
      expect([
        decode(initialHeaders).glasshive_capability_broker.grant_token,
        decode(after301.defaultHeaders).glasshive_capability_broker.grant_token,
        decode(after601.defaultHeaders).glasshive_capability_broker.grant_token,
      ]).toEqual([
        'synthetic-grant-1786387935',
        'synthetic-grant-1786388236',
        'synthetic-grant-1786388536',
      ]);
      expect(decode(after601.defaultHeaders).glasshive_capability_broker.grant.exp).toBe(
        1786389136,
      );
      expect(
        new Set(refreshedHeaders.map((headers) => headers['X-GlassHive-Bootstrap-Signature'])).size,
      ).toBe(3);
      expect(after601.defaultHeaders['X-Existing']).toBe('kept');
      expect(primeFiles).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(targetAgent)).not.toContain(
        'viventiumConversationProviderCapabilityRefresh',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test('refreshes a gateway first turn from the finalized run scope instead of the pre-persistence body', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      glasshive_capability_broker: { grant_token: 'synthetic-scoped-grant' },
      conversation_provider_instructions: 'Use the authorized host capability.',
    });
    const targetAgent = {
      model_parameters: { configuration: { defaultHeaders: {} } },
    };
    const prePersistenceBody = {
      conversationId: 'new',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
    };
    const finalizedRunBody = {
      conversationId: 'conversation-telegram-synthetic',
      messageId: 'assistant-message-telegram-synthetic',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      viventiumSurface: 'telegram',
    };
    const args = {
      targetAgent,
      declaredAgent: {
        tools: [`health_read${Constants.mcp_delimiter}synthetic-private-health`],
      },
      req: { user: { id: 'user-synthetic', role: 'ADMIN' }, body: prePersistenceBody },
      capability: { workspace_binding: true },
    };

    expect(installConversationProviderCapabilityRefresher(args)).toBe(true);
    await targetAgent.viventiumConversationProviderCapabilityRefresh(finalizedRunBody);

    expect(buildConversationProviderBootstrapBundle.mock.calls[0][0].requestBody).toEqual(
      finalizedRunBody,
    );
  });

  test('projects fallback MCP authority from the owning participant instead of the tool-less route', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      glasshive_capability_broker: { grant_token: 'synthetic-fallback-grant' },
      conversation_provider_instructions: 'Use the authorized participant capability.',
    });
    const targetAgent = {
      model_parameters: { configuration: { defaultHeaders: {} } },
    };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: { id: 'synthetic-fallback-route', tools: [] },
        capabilitySourceAgent: {
          id: 'synthetic-owning-participant',
          tools: [`health_read${Constants.mcp_delimiter}viventium-health`],
        },
        req: {
          user: { id: 'user-synthetic' },
          body: { conversationId: 'conversation-synthetic', messageId: 'message-synthetic' },
        },
        capability: { workspace_binding: true },
      }),
    ).resolves.toBe(true);

    expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledWith(
      expect.objectContaining({ allowedServerNames: ['viventium-health'] }),
    );
  });

  test('keeps one exact first-message scope across primary, fallback, and delayed re-entry bundles', async () => {
    const originalEnabled = process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED;
    const originalTtl = process.env.VIVENTIUM_GLASSHIVE_PROVIDER_BROKER_TTL_SECONDS;
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED = 'true';
    process.env.VIVENTIUM_GLASSHIVE_PROVIDER_BROKER_TTL_SECONDS = '600';
    jest.useFakeTimers().setSystemTime(new Date('2026-08-10T18:52:15.000Z'));
    try {
      const actualBootstrap = jest.requireActual('../GlassHiveCapabilityBootstrapService');
      const { verifyBrokerGrant } = jest.requireActual('../GlassHiveCapabilityBrokerAuth');
      buildConversationProviderBootstrapBundle.mockImplementation((args) =>
        actualBootstrap.buildConversationProviderBootstrapBundle(args),
      );
      const requestBody = {
        messageId: 'user-msg-foreground-1',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
      };
      const capability = {
        workspace_binding: true,
        host_tools_transport: 'broker_mcp',
        host_tools: ['synthetic_lookup'],
      };
      const buildArgs = (id) => {
        const targetAgent = {
          id,
          toolRegistry: new Map([['synthetic_lookup', { name: 'synthetic_lookup' }]]),
          model_parameters: { configuration: { defaultHeaders: {} } },
        };
        return {
          targetAgent,
          declaredAgent: { id, tools: ['synthetic_lookup'] },
          req: { user: { id: 'user-synthetic' }, body: requestBody },
          capability,
        };
      };
      const primaryArgs = buildArgs('agent-primary-synthetic');
      const fallbackArgs = buildArgs('agent-fallback-synthetic');

      await expect(attachConversationProviderCapabilityBundle(primaryArgs)).resolves.toBe(true);
      expect(installConversationProviderCapabilityRefresher(primaryArgs)).toBe(true);
      await expect(attachConversationProviderCapabilityBundle(fallbackArgs)).resolves.toBe(true);
      expect(installConversationProviderCapabilityRefresher(fallbackArgs)).toBe(true);

      const initialPrimary = {
        ...primaryArgs.targetAgent.model_parameters.configuration.defaultHeaders,
      };
      jest.setSystemTime(new Date('2026-08-10T18:57:16.000Z'));
      const fallbackAttempt =
        await fallbackArgs.targetAgent.viventiumConversationProviderCapabilityRefresh();
      jest.setSystemTime(new Date('2026-08-10T19:02:17.000Z'));
      const mainReentry =
        await primaryArgs.targetAgent.viventiumConversationProviderCapabilityRefresh();

      const refreshes = [
        { role: 'primary', headers: initialPrimary },
        { role: 'fallback', headers: fallbackAttempt.defaultHeaders },
        { role: 'reentry', headers: mainReentry.defaultHeaders },
      ];
      const grants = refreshes.map(({ role, headers }) => {
        const encodedBundle = headers['X-GlassHive-Bootstrap-Bundle-B64'];
        const issuedAt = Number(headers['X-GlassHive-Bootstrap-Timestamp']);
        const expectedSignature = crypto
          .createHmac('sha256', 'synthetic-bundle-secret')
          .update(`v1\n${issuedAt}\n${encodedBundle}`)
          .digest('hex');
        expect(headers['X-GlassHive-Bootstrap-Signature']).toBe(`sha256=${expectedSignature}`);
        const bundle = JSON.parse(Buffer.from(encodedBundle, 'base64').toString());
        const grant = verifyBrokerGrant(bundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN, {
          nowMs: issuedAt * 1000,
          expectedUserId: 'user-synthetic',
          requireTurnScope: true,
        });
        expect(grant).toMatchObject({
          conversation_id: '',
          parent_message_id: '',
          message_id: 'user-msg-foreground-1',
          turn_id: 'user-msg-foreground-1',
        });
        expect(grant.exp - grant.iat).toBe(600);
        return { role, issuedAt, grantId: grant.grant_id };
      });

      expect(grants.map(({ issuedAt }) => issuedAt)).toEqual([1786387935, 1786388236, 1786388537]);
      expect(new Set(grants.map(({ grantId }) => grantId)).size).toBe(3);
      expect(primeFiles).not.toHaveBeenCalled();
      expect(JSON.stringify(primaryArgs.targetAgent)).not.toContain(
        'viventiumConversationProviderCapabilityRefresh',
      );
      expect(JSON.stringify(fallbackArgs.targetAgent)).not.toContain(
        'viventiumConversationProviderCapabilityRefresh',
      );
    } finally {
      jest.useRealTimers();
      if (originalEnabled === undefined) {
        delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED;
      } else {
        process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED = originalEnabled;
      }
      if (originalTtl === undefined) {
        delete process.env.VIVENTIUM_GLASSHIVE_PROVIDER_BROKER_TTL_SECONDS;
      } else {
        process.env.VIVENTIUM_GLASSHIVE_PROVIDER_BROKER_TTL_SECONDS = originalTtl;
      }
    }
  });

  test('removes stale signed headers and replaces capability authority when refresh becomes unavailable', async () => {
    buildConversationProviderBootstrapBundle
      .mockResolvedValueOnce({
        glasshive_capability_broker: { grant_token: 'synthetic-initial-grant' },
        conversation_provider_instructions: 'Old authorized capability claim.',
      })
      .mockResolvedValueOnce({});
    const targetAgent = {
      model_parameters: { configuration: { defaultHeaders: { 'X-Existing': 'kept' } } },
    };
    const args = {
      targetAgent,
      declaredAgent: {
        tools: [`search${Constants.mcp_delimiter}synthetic-server`],
      },
      req: { user: { id: 'user-synthetic' }, body: {} },
      capability: { workspace_binding: true },
    };

    await expect(attachConversationProviderCapabilityBundle(args)).resolves.toBe(true);
    expect(installConversationProviderCapabilityRefresher(args)).toBe(true);
    const result = await targetAgent.viventiumConversationProviderCapabilityRefresh();

    expect(result).toMatchObject({
      attached: false,
      previousInstructionAppend: 'Old authorized capability claim.',
    });
    expect(result.instructionAppend).toContain('host capability broker is unavailable');
    expect(result.defaultHeaders).toEqual({ 'X-Existing': 'kept' });
    expect(result.defaultHeaders).not.toHaveProperty('X-GlassHive-Bootstrap-Bundle-B64');
    expect(result.defaultHeaders).not.toHaveProperty('X-GlassHive-Bootstrap-Timestamp');
    expect(result.defaultHeaders).not.toHaveProperty('X-GlassHive-Bootstrap-Signature');
  });

  test.each(['policy-null', 'declaration-empty'])(
    'clears prior capability authority when refresh has no projection: %s',
    async (mode) => {
      buildConversationProviderBootstrapBundle.mockResolvedValueOnce({
        glasshive_capability_broker: { grant_token: 'synthetic-initial-grant' },
        conversation_provider_instructions: 'Old authorized capability claim.',
      });
      if (mode === 'policy-null') {
        buildConversationProviderBootstrapBundle.mockResolvedValueOnce(null);
      }
      const declaredAgent = {
        tools: [`search${Constants.mcp_delimiter}synthetic-server`],
      };
      const targetAgent = {
        model_parameters: { configuration: { defaultHeaders: {} } },
      };
      const args = {
        targetAgent,
        declaredAgent,
        req: { user: { id: 'user-synthetic' }, body: {} },
        capability: { workspace_binding: true },
      };

      await expect(attachConversationProviderCapabilityBundle(args)).resolves.toBe(true);
      expect(installConversationProviderCapabilityRefresher(args)).toBe(true);
      if (mode === 'declaration-empty') {
        declaredAgent.tools = [];
      }
      const result = await targetAgent.viventiumConversationProviderCapabilityRefresh();

      expect(result).toMatchObject({
        attached: false,
        previousInstructionAppend: 'Old authorized capability claim.',
        instructionAppend: '',
        defaultHeaders: {},
      });
    },
  );

  test('keeps one Feeling tail and a signed capability bundle on a declared GlassHive fallback', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      glasshive_capability_broker: { allowed_servers: ['google-workspace'] },
      glasshive_capability_intent: { instruction: 'Use available capabilities as needed.' },
      codex_md: 'Synthetic Codex worker guidance.',
      claude_md: 'Synthetic Claude worker guidance.',
      agents_md: 'Synthetic shared worker guidance.',
    });
    const capsule = [
      '<viventium_feeling_state>',
      'Synthetic private causal state.',
      '</viventium_feeling_state>',
    ].join('\n');
    const targetAgent = {
      model_parameters: {
        configuration: {
          defaultHeaders: {
            'X-GlassHive-Agent-Id': 'agent-synthetic',
            'X-GlassHive-Developer-Instruction-Tail-B64': Buffer.from(capsule).toString('base64'),
          },
        },
      },
    };
    const declaredFallbackAgent = {
      endpoint: 'glasshive-harness',
      provider: 'openAI',
      tools: [`search${Constants.mcp_delimiter}google-workspace`],
    };
    const req = {
      _viventiumHarnessExecutionEnabled: true,
      _viventiumFallbackLlmAttempt: true,
      user: { id: 'user-synthetic' },
      body: { responseMessageId: 'response-1' },
      config: {
        endpoints: {
          agents: {
            providerCapabilities: {
              'glasshive-harness': { workspace_binding: true },
              openAI: { workspace_binding: false },
            },
          },
        },
      },
    };

    await expect(
      attachDeclaredConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: declaredFallbackAgent,
        req,
      }),
    ).resolves.toBe(true);

    const headers = targetAgent.model_parameters.configuration.defaultHeaders;
    expect(buildHarnessAttemptIdempotencyKey(req, 'response-1')).toBe('main-fallback:response-1');
    expect(
      Buffer.from(headers['X-GlassHive-Developer-Instruction-Tail-B64'], 'base64')
        .toString('utf8')
        .match(/<viventium_feeling_state>/g),
    ).toHaveLength(1);
    expect(
      JSON.parse(Buffer.from(headers['X-GlassHive-Bootstrap-Bundle-B64'], 'base64').toString()),
    ).toMatchObject({
      glasshive_capability_broker: { allowed_servers: ['google-workspace'] },
      glasshive_capability_intent: { instruction: 'Use available capabilities as needed.' },
      codex_md: 'Synthetic Codex worker guidance.',
      claude_md: 'Synthetic Claude worker guidance.',
      agents_md: 'Synthetic shared worker guidance.',
    });
    expect(headers['X-GlassHive-Bootstrap-Timestamp']).toMatch(/^\d+$/);
    expect(headers['X-GlassHive-Bootstrap-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  test('continues honestly instead of sending an unsigned capability bundle', async () => {
    delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
    buildConversationProviderBootstrapBundle.mockResolvedValue({ env: { SYNTHETIC: 'value' } });
    const targetAgent = { instructions: 'Base instructions.', model_parameters: {} };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: {
          tools: [`search${Constants.mcp_delimiter}synthetic-server`],
        },
        req: { user: { id: 'user-synthetic' }, body: {} },
        capability: { workspace_binding: true },
      }),
    ).resolves.toBe(false);

    expect(targetAgent.instructions).toContain('host capability broker is unavailable');
    expect(targetAgent.model_parameters).toEqual({});
  });

  test('continues honestly when declared capabilities cannot produce a broker bundle', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({});
    const targetAgent = { instructions: 'Base instructions.', model_parameters: {} };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: {
          tools: [`search${Constants.mcp_delimiter}synthetic-server`],
        },
        req: { user: { id: 'user-synthetic' }, body: {} },
        capability: { workspace_binding: true },
      }),
    ).resolves.toBe(false);

    expect(targetAgent.instructions).toContain('host capability broker is unavailable');
    expect(targetAgent.model_parameters).toEqual({});
  });

  test('continues honestly when capability bundle construction throws', async () => {
    buildConversationProviderBootstrapBundle.mockRejectedValueOnce(
      new Error('synthetic broker cache outage'),
    );
    const targetAgent = { instructions: 'Base instructions.', model_parameters: {} };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: {
          tools: [`search${Constants.mcp_delimiter}synthetic-server`],
        },
        req: { user: { id: 'user-synthetic' }, body: {} },
        capability: { workspace_binding: true },
      }),
    ).resolves.toBe(false);

    expect(targetAgent.instructions).toContain('host capability broker is unavailable');
    expect(targetAgent.instructions).not.toContain('synthetic broker cache outage');
    expect(targetAgent.model_parameters).toEqual({});
  });

  test('continues honestly when policy authorizes no capability projection', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue(null);
    const targetAgent = { model_parameters: { configuration: { defaultHeaders: {} } } };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: {
          tools: [`search${Constants.mcp_delimiter}non-projectable-server`],
        },
        req: { user: { id: 'user-synthetic' }, body: {} },
        capability: { workspace_binding: true },
      }),
    ).resolves.toBe(false);

    expect(targetAgent.model_parameters.configuration.defaultHeaders).toEqual({});
  });
});
