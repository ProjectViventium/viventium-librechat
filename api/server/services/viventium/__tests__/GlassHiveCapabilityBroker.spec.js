const mockGetMCPServersRegistry = jest.fn();
const mockGetMCPManager = jest.fn();
const mockGetFlowStateManager = jest.fn(() => ({}));
const mockGetLogStores = jest.fn(() => {
  const store = new Map();
  return {
    get: jest.fn((key) => Promise.resolve(store.get(key))),
    set: jest.fn((key, value) => {
      store.set(key, value);
      return Promise.resolve();
    }),
  };
});
const mockReinitMCPServer = jest.fn();
const mockGetUserById = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('librechat-data-provider', () => ({
  CacheKeys: { FLOWS: 'flows' },
}));

jest.mock('~/cache', () => ({
  getLogStores: (...args) => mockGetLogStores(...args),
}));

jest.mock('~/config', () => ({
  getMCPServersRegistry: (...args) => mockGetMCPServersRegistry(...args),
  getMCPManager: (...args) => mockGetMCPManager(...args),
  getFlowStateManager: (...args) => mockGetFlowStateManager(...args),
}));

jest.mock('~/models', () => ({
  findToken: jest.fn(),
  createToken: jest.fn(),
  updateToken: jest.fn(),
  deleteToken: jest.fn(),
  getUserById: (...args) => mockGetUserById(...args),
}));

jest.mock('~/server/services/GraphTokenService', () => ({
  getGraphApiToken: jest.fn(),
}));

jest.mock('~/server/services/Tools/mcp', () => ({
  reinitMCPServer: (...args) => mockReinitMCPServer(...args),
}));

describe('GlassHive capability broker', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET: 'test-broker-secret',
      VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED: 'true',
      VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_URL: 'http://broker.example/mcp',
      VIVENTIUM_GLASSHIVE_BROKER_DISCOVERY_RETRY_DELAY_MS: '0',
    };
    mockGetUserById.mockResolvedValue({ _id: 'user-1', id: 'user-1', role: 'USER' });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('mints and verifies scoped grants and rejects tampering', () => {
    const { mintBrokerGrant, verifyBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { token, payload } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace', 'ms-365'],
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
      executionMode: 'docker',
      nowMs: 1_000_000,
    });

    const verified = verifyBrokerGrant(token, { nowMs: 1_001_000, expectedUserId: 'user-1' });
    expect(verified.aud).toBe('glasshive-capability-broker');
    expect(verified.allowed_servers).toEqual(['google_workspace', 'ms-365']);
    expect(verified.grant_id).toBe(payload.grant_id);
    expect(verified.scopes.content_read).toBe(false);

    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    decoded.user_id = 'user-2';
    const tampered = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    expect(() => verifyBrokerGrant(tampered)).toThrow(/signature/);
  });

  test('binds content-read intent and bounded renewal to the signed broker grant', () => {
    const {
      grantReplayTtlMs,
      mintBrokerGrant,
      verifyBrokerGrant,
    } = require('../GlassHiveCapabilityBrokerAuth');
    const { token, payload } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['ms-365'],
      scopes: { content_read: true },
      ttlSeconds: 60,
      renewableTtlSeconds: 15 * 60,
      nowMs: 1_000_000,
    });

    expect(payload.scopes.content_read).toBe(true);
    expect(payload.renewable_until).toBe(payload.iat + 15 * 60);
    expect(() => verifyBrokerGrant(token, { nowMs: 1_061_000 })).toThrow(/expired/);

    const renewed = verifyBrokerGrant(token, { nowMs: 1_061_000, allowRenewal: true });
    expect(renewed.renewed).toBe(true);
    expect(renewed.scopes.content_read).toBe(true);
    expect(grantReplayTtlMs(renewed, 1_061_000)).toBeGreaterThan(60_000);

    expect(() => verifyBrokerGrant(token, { nowMs: 1_901_000, allowRenewal: true })).toThrow(
      /expired/,
    );
  });

  test('filters projection to reviewed source-of-truth MCP policy', () => {
    const { collectAllowedServers } = require('../GlassHiveCapabilityPolicyService');
    const allowed = collectAllowedServers({
      executionMode: 'docker',
      mcpConfig: {
        google_workspace: {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
          },
        },
        user_mcp: {
          source: 'user',
          dbId: 'db-1',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
          },
        },
        disabled: {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: false,
          },
        },
      },
    });

    expect(allowed).toEqual(['google_workspace']);
  });

  test('injects broker MCP config into GlassHive launch bootstrap without provider secrets', async () => {
    const { maybeInjectGlassHiveCapabilityBroker } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        'ms-365': {
          source: 'config',
          oauth: { client_secret: 'provider-secret' },
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
          },
        },
      }),
    });

    const result = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'workspace_launch',
      toolArguments: {
        description: 'Check my workspace',
        success_criteria: 'Use live connected evidence',
        context: 'Original context',
        connected_account_content_intent: true,
        execution_mode: 'docker',
      },
      config: {
        configurable: {
          user: { id: 'user-1', role: 'USER' },
          requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
        },
      },
    });

    expect(result.context).toContain('glasshive-user-capabilities');
    expect(result.context).toContain('Prefer MCP/tools');
    expect(result.context).toContain('non-broker host connector');
    expect(result.success_criteria).toBe('Use live connected evidence');
    expect(result.bootstrap_bundle_json.codex_md).toContain('glasshive-user-capabilities');
    expect(result.bootstrap_bundle_json.glasshive_capability_broker.allowed_servers).toEqual([
      'ms-365',
    ]);
    expect(result.bootstrap_bundle_json.glasshive_capability_broker.scopes.content_read).toBe(true);
    expect(result.bootstrap_bundle_json.glasshive_capability_intent.content_read).toBe(true);
    expect(
      result.bootstrap_bundle_json.claude_project_mcp['glasshive-user-capabilities'].headers
        .Authorization,
    ).toBe('Bearer ${GLASSHIVE_CAPABILITY_BROKER_TOKEN}');
    const serialized = JSON.stringify(result.bootstrap_bundle_json);
    expect(serialized).toContain('Bearer ');
    expect(serialized).not.toContain('provider-secret');
  });

  test('injects the run memory into the worker bundle when provided, and omits it when absent (Quality parity)', async () => {
    const { maybeInjectGlassHiveCapabilityBroker } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        'ms-365': {
          source: 'config',
          viventiumGlassHive: { version: 1, permitsAutonomousWorker: true, sandboxAllowed: true },
        },
      }),
    });
    const memory = '- Prefers concise summaries\n- Key people: Nilay (Bryter), Sumeet (intro)';

    const withMemory = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'workspace_launch',
      toolArguments: { description: 'Check inbox', success_criteria: 'x', execution_mode: 'docker' },
      config: {
        configurable: {
          user: { id: 'user-1', role: 'USER' },
          requestBody: {},
          glasshive_worker_memory: memory,
        },
      },
    });
    expect(withMemory.bootstrap_bundle_json.agents_md).toContain('saved memory');
    expect(withMemory.bootstrap_bundle_json.agents_md).toContain('Nilay (Bryter)');
    expect(withMemory.bootstrap_bundle_json.claude_md).toContain('Sumeet (intro)');
    expect(withMemory.bootstrap_bundle_json.codex_md).toContain('Prefers concise summaries');

    const withoutMemory = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'workspace_launch',
      toolArguments: { description: 'Check inbox', success_criteria: 'x', execution_mode: 'docker' },
      config: { configurable: { user: { id: 'user-1', role: 'USER' }, requestBody: {} } },
    });
    expect(withoutMemory.bootstrap_bundle_json.agents_md || '').not.toContain('saved memory');
  });

  test('injects broker MCP config into GlassHive continue calls without replacing user instructions', async () => {
    const { maybeInjectGlassHiveCapabilityBroker } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        google_workspace: {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
          },
        },
      }),
    });

    const result = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'workspace_continue',
      toolArguments: {
        run_id: 'run-1',
        additional_instructions: 'Continue the same public-safe connected-account check.',
        connected_account_content_intent: true,
        execution_mode: 'docker',
      },
      config: {
        configurable: {
          user: { id: 'user-1', role: 'USER' },
          requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
        },
      },
    });

    expect(result.additional_instructions).toContain(
      'Continue the same public-safe connected-account check.',
    );
    expect(result.additional_instructions).toContain('glasshive-user-capabilities');
    expect(result.bootstrap_bundle_json.glasshive_capability_broker.allowed_servers).toEqual([
      'google_workspace',
    ]);
    expect(result.bootstrap_bundle_json.glasshive_capability_broker.scopes.content_read).toBe(true);
  });

  test('skips bootstrap injection instead of breaking GlassHive launch when broker secret is missing', async () => {
    const { maybeInjectGlassHiveCapabilityBroker } = require('../GlassHiveCapabilityBootstrapService');
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = '';
    process.env.VIVENTIUM_GLASSHIVE_CALLBACK_SECRET = '';
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        google_workspace: {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
          },
        },
      }),
    });
    const toolArguments = {
      description: 'Check my workspace',
      success_criteria: 'Use live connected evidence',
      execution_mode: 'docker',
    };

    const result = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'workspace_launch',
      toolArguments,
      config: {
        configurable: {
          user: { id: 'user-1', role: 'USER' },
          requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
        },
      },
    });

    expect(result).toBe(toolArguments);
  });

  test('uses schedule-aware broker grant ttl for delayed worker runs', () => {
    const {
      grantRenewableTtlSecondsForTool,
      grantTtlSecondsForTool,
    } = require('../GlassHiveCapabilityBootstrapService');
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_TTL_SECONDS = '';
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SCHEDULE_TTL_SECONDS = '';
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_MAX_SCHEDULE_TTL_SECONDS = '';
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_RENEWABLE_TTL_SECONDS = '';

    expect(grantTtlSecondsForTool('workspace_launch', {})).toBe(600);
    expect(grantRenewableTtlSecondsForTool('workspace_launch', {})).toBe(3600);
    expect(grantTtlSecondsForTool('worker_schedule', { delay_seconds: 7200 })).toBe(7800);
    expect(grantRenewableTtlSecondsForTool('worker_schedule', { delay_seconds: 7200 })).toBe(7800);
  });

  test('resolves host broker URL from deterministic listener host', () => {
    const { resolveBrokerUrl } = require('../GlassHiveCapabilityBootstrapService');
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_URL = '';
    process.env.PORT = '3180';
    process.env.HOST = 'localhost';
    expect(resolveBrokerUrl('host')).toBe(
      'http://127.0.0.1:3180/api/viventium/glasshive/capabilities/mcp',
    );
    process.env.HOST = '0.0.0.0';
    expect(resolveBrokerUrl('host')).toBe(
      'http://127.0.0.1:3180/api/viventium/glasshive/capabilities/mcp',
    );
    expect(resolveBrokerUrl('docker')).toBe(
      'http://host.docker.internal:3180/api/viventium/glasshive/capabilities/mcp',
    );
  });

  test('uses GlassHive default execution mode when launch args omit execution_mode', async () => {
    const {
      executionModeForBroker,
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_URL = '';
    process.env.WPR_DEFAULT_EXECUTION_MODE = 'host';
    process.env.HOST = 'localhost';
    process.env.PORT = '3180';
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        'ms-365': {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
          },
        },
      }),
    });

    expect(executionModeForBroker({})).toBe('host');
    const result = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'workspace_launch',
      toolArguments: {
        description: 'Check connected inbox',
        success_criteria: 'Use broker tools',
        connected_account_content_intent: true,
      },
      config: {
        configurable: {
          user: { id: 'user-1', role: 'USER' },
          requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
        },
      },
    });

    expect(result.bootstrap_bundle_json.glasshive_capability_broker.url).toBe(
      'http://127.0.0.1:3180/api/viventium/glasshive/capabilities/mcp',
    );
    expect(result.bootstrap_bundle_json.glasshive_capability_broker.scopes.content_read).toBe(true);
    expect(result.bootstrap_bundle_json.codex_config_append).toContain('http://127.0.0.1:3180');
    expect(result.bootstrap_bundle_json.codex_config_append).toContain(
      'bearer_token_env_var = "GLASSHIVE_CAPABILITY_BROKER_TOKEN"',
    );
    expect(result.bootstrap_bundle_json.codex_config_append).not.toContain('Authorization');
    expect(result.bootstrap_bundle_json.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN).toEqual(
      expect.any(String),
    );
    expect(
      result.bootstrap_bundle_json.claude_project_mcp['glasshive-user-capabilities'].headers
        .Authorization,
    ).toBe('Bearer ${GLASSHIVE_CAPABILITY_BROKER_TOKEN}');
    expect(
      result.bootstrap_bundle_json.claude_project_mcp['glasshive-user-capabilities'].headers
        .Authorization,
    ).not.toContain(result.bootstrap_bundle_json.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN);
    expect(result.success_criteria).toBe('Use broker tools');
  });

  test('does not trust bootstrap bundle metadata to authorize content-read scope', () => {
    const { contentReadIntentForArgs } = require('../GlassHiveCapabilityBootstrapService');

    expect(
      contentReadIntentForArgs({
        bootstrap_bundle_json: {
          glasshive_capability_intent: { content_read: true },
        },
      }),
    ).toBe(false);
    expect(contentReadIntentForArgs({ connected_account_content_intent: true })).toBe(true);
    expect(contentReadIntentForArgs({ contentReadIntent: 'true' })).toBe(true);
  });

  test('fails closed when shared replay cache is unavailable unless local fallback is explicit', async () => {
    const { rememberInvocation } = require('../GlassHiveCapabilityBrokerAuth');
    mockGetLogStores.mockImplementationOnce(() => {
      throw new Error('shared cache unavailable');
    });

    await expect(
      rememberInvocation({ grantId: 'grant-cache-down', invocationId: 'invoke-1' }),
    ).resolves.toEqual(
      expect.objectContaining({
        accepted: false,
        replayChecked: false,
        reason: 'replay_cache_unavailable',
      }),
    );

    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ALLOW_IN_MEMORY_REPLAY_CACHE = '1';
    mockGetLogStores.mockImplementationOnce(() => {
      throw new Error('shared cache unavailable');
    });
    await expect(
      rememberInvocation({ grantId: 'grant-local-only', invocationId: 'invoke-1' }),
    ).resolves.toEqual(expect.objectContaining({ accepted: true, replayChecked: true }));

    mockGetLogStores.mockImplementationOnce(() => {
      throw new Error('shared cache unavailable');
    });
    await expect(
      rememberInvocation({ grantId: 'grant-local-only', invocationId: 'invoke-1' }),
    ).resolves.toEqual(expect.objectContaining({ accepted: false, replayChecked: true }));
  });

  test('does not append broker instructions to worker label fields', async () => {
    const { maybeInjectGlassHiveCapabilityBroker } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        'ms-365': {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
          },
        },
      }),
    });

    const result = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'worker_create',
      toolArguments: {
        project_id: 'project-1',
        name: 'QA worker',
        role: 'Spreadsheet analyst',
        execution_mode: 'docker',
      },
      config: {
        configurable: {
          user: { id: 'user-1', role: 'USER' },
          requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
        },
      },
    });

    expect(result.role).toBe('Spreadsheet analyst');
    expect(result.bootstrap_bundle_json.agents_md).toContain('glasshive-user-capabilities');
    expect(result.bootstrap_bundle_json.codex_md).toContain('glasshive-user-capabilities');
  });

  test('re-exports typed tools and blocks writes without confirmation', async () => {
    const { mintBrokerGrant, mintWriteConfirmation } = require('../GlassHiveCapabilityBrokerAuth');
    const {
      buildCapabilityCatalog,
      handleToolCall,
      toolDefinitionsForMcp,
    } = require('../GlassHiveCapabilityBrokerService');
    const policyConfig = {
      source: 'config',
      viventiumGlassHive: {
        version: 1,
        permitsAutonomousWorker: true,
        sandboxAllowed: true,
        defaultToolAccess: 'write',
        writePolicy: 'confirm',
      },
    };
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue(policyConfig),
    });
    mockReinitMCPServer.mockResolvedValue({
      success: true,
      oauthRequired: false,
      tools: [
        {
          name: 'calendar_create',
          description: 'Create a calendar event',
          inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
        },
      ],
    });
    const callTool = jest.fn().mockResolvedValue({ ok: true });
    mockGetMCPManager.mockReturnValue({ callTool });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace'],
    }).payload;

    const catalog = await buildCapabilityCatalog({ grant });
    const definitions = toolDefinitionsForMcp(catalog);
    expect(definitions.map((tool) => tool.name)).toContain('gh_google_workspace__calendar_create');

    const blocked = await handleToolCall({
      grant,
      toolName: 'gh_google_workspace__calendar_create',
      args: { title: 'Planning' },
    });
    expect(blocked).toEqual(
      expect.objectContaining({ status: 'blocked', reason: 'write_requires_invocation_id' }),
    );

    const selfConfirmed = await handleToolCall({
      grant,
      toolName: 'gh_google_workspace__calendar_create',
      args: {
        title: 'Planning',
        __viventiumCapabilityIntent: { confirmed: true, invocation_id: 'invoke-1' },
      },
    });
    expect(selfConfirmed).toEqual(
      expect.objectContaining({ status: 'blocked', reason: 'write_requires_host_confirmation' }),
    );

    const writeConfirmation = mintWriteConfirmation({
      grantId: grant.grant_id,
      serverName: 'google_workspace',
      toolName: 'calendar_create',
      invocationId: 'invoke-1',
      args: { title: 'Planning' },
    }).token;
    const allowed = await handleToolCall({
      grant,
      toolName: 'gh_google_workspace__calendar_create',
      args: {
        title: 'Planning',
        __viventiumCapabilityIntent: {
          confirmed: true,
          invocation_id: 'invoke-1',
          write_confirmation_token: writeConfirmation,
        },
      },
    });
    expect(allowed).toEqual({ ok: true });
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolArguments: { title: 'Planning' },
      }),
    );

    const missingInvocationId = await handleToolCall({
      grant,
      toolName: 'gh_google_workspace__calendar_create',
      args: {
        title: 'Planning',
        __viventiumCapabilityIntent: { confirmed: true },
      },
    });
    expect(missingInvocationId).toEqual(
      expect.objectContaining({ status: 'blocked', reason: 'write_requires_invocation_id' }),
    );
  });

  test('requires explicit content intent by default and escalates destructive annotations to write policy', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const {
      buildCapabilityCatalog,
      handleToolCall,
      toolDefinitionsForMcp,
    } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue({
        source: 'config',
        viventiumGlassHive: {
          version: 1,
          permitsAutonomousWorker: true,
          sandboxAllowed: true,
          defaultToolAccess: 'content_read',
          contentReadPolicy: 'require_explicit_intent',
          writePolicy: 'confirm',
        },
      }),
    });
    mockReinitMCPServer.mockResolvedValue({
      success: true,
      oauthRequired: false,
      tools: [
        {
          name: 'mail_search',
          description: 'Search mail',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'calendar_delete',
          description: 'Delete calendar event',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
          annotations: { destructiveHint: true, readOnlyHint: false },
        },
      ],
    });
    mockGetMCPManager.mockReturnValue({
      callTool: jest.fn().mockResolvedValue({ ok: true }),
    });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['ms-365'],
    }).payload;

    const catalog = await buildCapabilityCatalog({ grant });
    const definitions = toolDefinitionsForMcp(catalog);
    expect(
      definitions.find((tool) => tool.name === 'gh_ms_365__mail_search')?.annotations.access,
    ).toBe('content_read');
    expect(
      definitions.find((tool) => tool.name === 'gh_ms_365__calendar_delete')?.annotations.access,
    ).toBe('write');

    const readBlocked = await handleToolCall({
      grant,
      toolName: 'gh_ms_365__mail_search',
      args: { query: 'quarterly planning' },
    });
    expect(readBlocked).toEqual(
      expect.objectContaining({
        status: 'blocked',
        reason: 'content_read_requires_user_intent_scope',
      }),
    );

    const workerSelfAssertedRead = await handleToolCall({
      grant,
      toolName: 'gh_ms_365__mail_search',
      args: {
        query: 'quarterly planning',
        __glasshiveCapabilityIntent: { explicitContentIntent: true },
      },
    });
    expect(workerSelfAssertedRead).toEqual(
      expect.objectContaining({
        status: 'blocked',
        reason: 'content_read_requires_user_intent_scope',
      }),
    );

    const scopedGrant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['ms-365'],
      scopes: { content_read: true },
    }).payload;
    const readAllowed = await handleToolCall({
      grant: scopedGrant,
      toolName: 'gh_ms_365__mail_search',
      args: { query: 'quarterly planning' },
    });
    expect(readAllowed).toEqual({ ok: true });

    const writeBlocked = await handleToolCall({
      grant,
      toolName: 'gh_ms_365__calendar_delete',
      args: { id: 'evt-1', invocation_id: 'delete-1' },
    });
    expect(writeBlocked).toEqual(
      expect.objectContaining({ status: 'blocked', reason: 'write_requires_host_confirmation' }),
    );
  });

  test('surfaces a slow/erroring underlying provider as a structured blocker, not an opaque error', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue({
        source: 'config',
        viventiumGlassHive: {
          version: 1,
          permitsAutonomousWorker: true,
          sandboxAllowed: true,
          defaultToolAccess: 'content_read',
          contentReadPolicy: 'require_explicit_intent',
        },
      }),
    });
    mockReinitMCPServer.mockResolvedValue({
      success: true,
      oauthRequired: false,
      tools: [
        {
          name: 'mail_search',
          description: 'Search mail',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          annotations: { readOnlyHint: true },
        },
      ],
    });
    const scopedGrant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['ms-365'],
      scopes: { content_read: true },
    }).payload;

    // (1) underlying call rejects with a timeout-class error -> provider_degraded, retryable
    mockGetMCPManager.mockReturnValue({
      callTool: jest.fn().mockRejectedValue(new Error('socket hang up: ETIMEDOUT')),
    });
    const timedOutReject = await handleToolCall({
      grant: scopedGrant,
      toolName: 'gh_ms_365__mail_search',
      args: { query: 'today' },
    });
    expect(timedOutReject).toEqual(
      expect.objectContaining({
        status: 'blocked',
        reason: 'provider_degraded',
        server: 'ms-365',
        tool: 'mail_search',
        retryable: true,
      }),
    );

    // (2) underlying call hangs -> bounded broker timeout fires -> provider_degraded
    process.env.VIVENTIUM_GLASSHIVE_BROKER_PROVIDER_TIMEOUT_MS = '20';
    mockGetMCPManager.mockReturnValue({
      callTool: jest.fn().mockImplementation(() => new Promise(() => {})),
    });
    const hung = await handleToolCall({
      grant: scopedGrant,
      toolName: 'gh_ms_365__mail_search',
      args: { query: 'today' },
    });
    delete process.env.VIVENTIUM_GLASSHIVE_BROKER_PROVIDER_TIMEOUT_MS;
    expect(hung).toEqual(
      expect.objectContaining({ status: 'blocked', reason: 'provider_degraded', retryable: true }),
    );

    // (3) non-timeout error -> provider_error, not retryable
    mockGetMCPManager.mockReturnValue({
      callTool: jest.fn().mockRejectedValue(new Error('bad request: invalid argument')),
    });
    const genericErr = await handleToolCall({
      grant: scopedGrant,
      toolName: 'gh_ms_365__mail_search',
      args: { query: 'today' },
    });
    expect(genericErr).toEqual(
      expect.objectContaining({ status: 'blocked', reason: 'provider_error', retryable: false }),
    );
  });

  test('reports policy-approved servers with no usable tools as unavailable instead of silently healthy', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue({
        source: 'config',
        viventiumGlassHive: {
          version: 1,
          permitsAutonomousWorker: true,
          sandboxAllowed: true,
          defaultToolAccess: 'content_read',
        },
      }),
    });
    mockReinitMCPServer.mockResolvedValue({
      success: false,
      oauthRequired: false,
      message: 'Failed to reinitialize MCP server',
      tools: [],
    });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace'],
    }).payload;

    const catalog = await handleToolCall({
      grant,
      toolName: 'capabilities_list',
      args: {},
    });

    expect(catalog.servers).toEqual([
      expect.objectContaining({
        name: 'google_workspace',
        available: false,
        oauthRequired: false,
        toolCount: 0,
      }),
    ]);
    expect(catalog.omissions).toEqual([
      expect.objectContaining({ server: 'google_workspace', reason: 'server_unavailable' }),
    ]);
    expect(catalog.tools).toEqual([]);
  });

  test('uses a fresh MCP connection and retries stale empty broker discovery once', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { buildCapabilityCatalog, toolDefinitionsForMcp } = require('../GlassHiveCapabilityBrokerService');
    const policyConfig = {
      source: 'config',
      viventiumGlassHive: {
        version: 1,
        permitsAutonomousWorker: true,
        sandboxAllowed: true,
        defaultToolAccess: 'content_read',
      },
    };
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue(policyConfig),
    });
    mockReinitMCPServer
      .mockResolvedValueOnce({
        success: false,
        oauthRequired: false,
        message: 'Connection not established',
        tools: [],
      })
      .mockResolvedValueOnce({
        success: true,
        oauthRequired: false,
        tools: [{ name: 'search_gmail_messages', inputSchema: { type: 'object' } }],
      });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace'],
      scopes: { content_read: true },
    }).payload;

    const catalog = await buildCapabilityCatalog({ grant });
    const definitions = toolDefinitionsForMcp(catalog);

    expect(mockReinitMCPServer).toHaveBeenCalledTimes(2);
    expect(mockReinitMCPServer).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'google_workspace',
        forceNew: true,
      }),
    );
    expect(definitions.map((tool) => tool.name)).toContain(
      'gh_google_workspace__search_gmail_messages',
    );
    expect(catalog.omissions).toEqual([]);
  });

  test('refreshes allowed server list from current reviewed policy during the grant lifetime', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { buildCapabilityCatalog } = require('../GlassHiveCapabilityBrokerService');
    const policyConfig = {
      source: 'config',
      viventiumGlassHive: {
        version: 1,
        permitsAutonomousWorker: true,
        sandboxAllowed: true,
        defaultToolAccess: 'content_read',
      },
    };
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        google_workspace: policyConfig,
        'ms-365': policyConfig,
        user_mcp: {
          source: 'user',
          dbId: 'db-1',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
            defaultToolAccess: 'content_read',
          },
        },
      }),
      getServerConfig: jest.fn((_serverName) => Promise.resolve(policyConfig)),
    });
    mockReinitMCPServer.mockImplementation(({ serverName }) =>
      Promise.resolve({
        success: true,
        oauthRequired: false,
        tools: [{ name: `${serverName}_list`, inputSchema: { type: 'object' } }],
      }),
    );
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace'],
    }).payload;

    const catalog = await buildCapabilityCatalog({ grant });

    expect(catalog.servers.map((server) => server.name)).toEqual(['google_workspace', 'ms-365']);
  });
});
