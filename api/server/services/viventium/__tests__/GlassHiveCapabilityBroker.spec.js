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
const mockInspectStoredOAuthCredentialState = jest.fn();
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
  buildMcpOAuthRecovery: (server) => ({
    action: 'connect_mcp_account',
    surface: 'agent_builder',
    server,
    instructions:
      'Open Agent Builder, select the agent that owns this connected account, then in MCP Servers choose Connect beside the unavailable server.',
  }),
  inspectStoredOAuthCredentialState: (...args) => mockInspectStoredOAuthCredentialState(...args),
  reinitMCPServer: (...args) => mockReinitMCPServer(...args),
}));

describe('GlassHive capability broker', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLogStores.mockImplementation(() => {
      const store = new Map();
      return {
        get: jest.fn((key) => Promise.resolve(store.get(key))),
        set: jest.fn((key, value) => {
          store.set(key, value);
          return Promise.resolve();
        }),
      };
    });
    process.env = {
      ...originalEnv,
      VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET: 'test-broker-secret',
      VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED: 'true',
      VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_URL: 'http://broker.example/mcp',
      GLASSHIVE_ENTERPRISE_TENANT_ID: 'tenant-a',
      VIVENTIUM_GLASSHIVE_BROKER_DISCOVERY_RETRY_DELAY_MS: '0',
    };
    mockGetUserById.mockResolvedValue({ _id: 'user-1', id: 'user-1', role: 'USER' });
    mockInspectStoredOAuthCredentialState.mockResolvedValue({ status: 'credential_present' });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('reserves inference requests through the shared atomic counter', async () => {
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_RATE_LIMIT_PER_WINDOW = '2';
    let count = 0;
    const reserveWithinLimit = jest.fn(async (_key, limit) => {
      if (count >= limit) {
        return { accepted: false, count };
      }
      count += 1;
      return { accepted: true, count };
    });
    mockGetLogStores.mockImplementation(() => ({
      opts: { namespace: 'flows', store: { reserveWithinLimit } },
    }));
    const { rememberBrokerRequest } = require('../GlassHiveCapabilityBrokerAuth');
    const grant = { grant_id: 'ghcb_12345678' };

    const results = await Promise.all([
      rememberBrokerRequest({ grant, nowMs: 1_000 }),
      rememberBrokerRequest({ grant, nowMs: 1_000 }),
      rememberBrokerRequest({ grant, nowMs: 1_000 }),
    ]);

    expect(results.filter((result) => result.accepted)).toHaveLength(2);
    expect(results.filter((result) => result.rateLimited)).toHaveLength(1);
    expect(reserveWithinLimit).toHaveBeenCalledTimes(3);
    expect(mockGetLogStores.mock.results[0].value.get).toBeUndefined();
  });

  test('mints and verifies scoped grants and rejects tampering', () => {
    const { mintBrokerGrant, verifyBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { token, payload } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace', 'ms-365'],
      eagerServers: ['google_workspace'],
      deferredServers: ['ms-365'],
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
      executionMode: 'docker',
      nowMs: 1_000_000,
    });

    const verified = verifyBrokerGrant(token, { nowMs: 1_001_000, expectedUserId: 'user-1' });
    expect(verified.aud).toBe('glasshive-capability-broker');
    expect(verified.allowed_servers).toEqual(['google_workspace', 'ms-365']);
    expect(verified.eager_servers).toEqual(['google_workspace']);
    expect(verified.deferred_servers).toEqual(['ms-365']);
    expect(verified.grant_id).toBe(payload.grant_id);
    expect(verified.scopes.content_read).toBe(false);

    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    decoded.user_id = 'user-2';
    const tampered = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    expect(() => verifyBrokerGrant(tampered)).toThrow(/signature/);
  });

  test('binds new grants to tenant and schedule while accepting legacy direct grants', () => {
    const { mintBrokerGrant, verifyBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { token, payload } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['ms-365'],
      requestContext: {
        schedule_id: 'schedule-1',
        run_id: 'scheduled-run-1',
      },
      grantId: 'ghcb_scheduled_stable',
      nowMs: 1_000_000,
    });

    expect(payload.policy_version).toBe(2);
    expect(payload.tenant_id).toBe('tenant-a');
    expect(payload.schedule_id).toBe('schedule-1');
    expect(payload.grant_id).toBe('ghcb_scheduled_stable');
    expect(
      verifyBrokerGrant(token, {
        nowMs: 1_001_000,
        expectedTenantId: 'tenant-a',
        expectedUserId: 'user-1',
      }).run_id,
    ).toBe('scheduled-run-1');
    expect(() =>
      verifyBrokerGrant(token, { nowMs: 1_001_000, expectedTenantId: 'tenant-b' }),
    ).toThrow(/tenant mismatch/);

    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    delete decoded.tenant_id;
    delete decoded.schedule_id;
    decoded.policy_version = 1;
    const crypto = require('crypto');
    const stableJson = (value) => {
      if (Array.isArray(value)) {
        return `[${value.map((item) => stableJson(item)).join(',')}]`;
      }
      if (value && typeof value === 'object') {
        return `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
          .join(',')}}`;
      }
      return JSON.stringify(value);
    };
    delete decoded.sig;
    decoded.sig = crypto
      .createHmac('sha256', 'test-broker-secret')
      .update(stableJson(decoded))
      .digest('base64url');
    const legacy = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    expect(
      verifyBrokerGrant(legacy, {
        nowMs: 1_001_000,
        expectedTenantId: 'tenant-a',
        allowLegacyTenantless: true,
      }).policy_version,
    ).toBe(1);
  });

  test('revokes a grant idempotently and blocks it throughout its renewal window', async () => {
    const {
      assertBrokerGrantActive,
      mintBrokerGrant,
      revokeBrokerGrant,
      verifyBrokerGrant,
    } = require('../GlassHiveCapabilityBrokerAuth');
    const { token } = mintBrokerGrant({
      user: { id: 'user-1' },
      grantId: 'ghcb_revoke_me',
      ttlSeconds: 60,
      renewableTtlSeconds: 15 * 60,
      nowMs: 1_000_000,
    });
    const grant = verifyBrokerGrant(token, {
      nowMs: 1_061_000,
      allowRenewal: true,
      expectedTenantId: 'tenant-a',
    });

    await expect(assertBrokerGrantActive(grant, { nowMs: 1_061_000 })).resolves.toMatchObject({
      active: true,
    });
    await expect(revokeBrokerGrant(grant, { nowMs: 1_061_000 })).resolves.toMatchObject({
      revoked: true,
    });
    await expect(revokeBrokerGrant(grant, { nowMs: 1_062_000 })).resolves.toMatchObject({
      revoked: true,
    });
    await expect(assertBrokerGrantActive(grant, { nowMs: 1_063_000 })).rejects.toThrow(/revoked/);
  });

  test('mints an idempotent fire-time scheduled bundle from current user policy', async () => {
    const {
      buildScheduledGlassHiveCapabilityBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        'ms-365': {
          source: 'config',
          requiresOAuth: true,
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            hostAllowed: true,
            sandboxAllowed: true,
            defaultToolAccess: 'content_read',
            contentReadPolicy: 'require_broker_grant',
          },
        },
      }),
    });

    const input = {
      user: { id: 'user-1', role: 'USER' },
      scheduleId: 'schedule-1',
      scheduledRunId: 'scheduled-run-1',
      executionMode: 'host',
      requiredServerNames: ['ms-365'],
    };
    const first = await buildScheduledGlassHiveCapabilityBundle(input);
    const retry = await buildScheduledGlassHiveCapabilityBundle(input);

    expect(first.grantRef.grant_id).toBe(retry.grantRef.grant_id);
    expect(first.grantRef.grant_id).toMatch(/^ghcb_sched_/);
    expect(first.bootstrapBundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN).toEqual(expect.any(String));
    expect(first.bootstrapBundle.glasshive_capability_broker).toMatchObject({
      allowed_servers: ['ms-365'],
      grant_id: first.grantRef.grant_id,
    });
    expect(mockInspectStoredOAuthCredentialState).toHaveBeenCalledWith('user-1', 'ms-365');
  });

  test('scheduled fire-time grant fails closed when required OAuth consent is unavailable', async () => {
    const {
      buildScheduledGlassHiveCapabilityBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        'ms-365': {
          source: 'config',
          requiresOAuth: true,
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            hostAllowed: true,
            defaultToolAccess: 'content_read',
          },
        },
      }),
    });
    mockInspectStoredOAuthCredentialState.mockResolvedValue({ status: 'missing_auth' });

    await expect(
      buildScheduledGlassHiveCapabilityBundle({
        user: { id: 'user-1' },
        scheduleId: 'schedule-1',
        scheduledRunId: 'scheduled-run-1',
        executionMode: 'host',
        requiredServerNames: ['ms-365'],
      }),
    ).rejects.toMatchObject({
      code: 'connected_account_action_required',
      status: 409,
      serverNames: ['ms-365'],
    });
  });

  test('preserves legacy schedules without declared capabilities when the broker is disabled', async () => {
    const {
      buildScheduledGlassHiveCapabilityBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED = 'false';

    const result = await buildScheduledGlassHiveCapabilityBundle({
      user: { id: 'user-1' },
      scheduleId: 'legacy-schedule-1',
      scheduledRunId: 'sp_run_legacy',
      executionMode: 'host',
    });

    expect(result.grantRef).toBeNull();
    expect(result.capabilityStatus).toEqual({ status: 'degraded', reason: 'broker_disabled' });
    expect(result.bootstrapBundle.agents_md).toMatch(/broker is degraded/i);
  });

  test('binds content-read scope and bounded renewal to the signed broker grant', () => {
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

  test('projects declared Scheduling Cortex tools into a direct GlassHive provider bundle', async () => {
    const {
      buildConversationProviderBootstrapBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        'scheduling-cortex': {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            hostAllowed: true,
            sandboxAllowed: false,
            defaultToolAccess: 'none',
            contentReadPolicy: 'require_broker_grant',
            writePolicy: 'allow',
            toolPolicies: {
              schedule_list: { access: 'content_read' },
              schedule_create: { access: 'write' },
            },
          },
        },
        'future-reviewed': {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            hostAllowed: true,
            defaultToolAccess: 'content_read',
          },
        },
        'ms-365': {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            hostAllowed: true,
            defaultToolAccess: 'content_read',
            contentReadPolicy: 'require_broker_grant',
          },
        },
        google_workspace: {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            hostAllowed: true,
            defaultToolAccess: 'content_read',
            contentReadPolicy: 'require_broker_grant',
          },
        },
        unreviewed: { source: 'config' },
      }),
    });

    const result = await buildConversationProviderBootstrapBundle({
      user: { id: 'user-1', role: 'USER' },
      requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
      allowedServerNames: ['scheduling-cortex'],
      deferredServerNames: ['google_workspace', 'ms-365'],
      excludedServerNames: ['glasshive-workers-projects'],
    });

    expect(result.glasshive_capability_broker.allowed_servers).toEqual([
      'google_workspace',
      'ms-365',
      'scheduling-cortex',
    ]);
    expect(result.glasshive_capability_broker.eager_servers).toEqual(['scheduling-cortex']);
    expect(result.glasshive_capability_broker.deferred_servers).toEqual([
      'google_workspace',
      'ms-365',
    ]);
    expect(result.glasshive_capability_broker.scopes.content_read).toBe(true);
    expect(result.codex_config_append).toContain('glasshive-user-capabilities');
    expect(result.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN).toEqual(expect.any(String));
    const providerGrant = JSON.parse(
      Buffer.from(result.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN, 'base64url').toString('utf8'),
    );
    expect(providerGrant.allow_dynamic_policy_servers).toBe(false);
    expect(providerGrant.eager_servers).toEqual(['scheduling-cortex']);
    expect(providerGrant.deferred_servers).toEqual(['google_workspace', 'ms-365']);
    expect(result.glasshive_capability_broker.allowed_servers).not.toContain('future-reviewed');
  });

  test('keeps deferred MS365 dormant until an explicit describe or invoke', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    const policyConfig = {
      source: 'config',
      viventiumGlassHive: {
        version: 1,
        permitsAutonomousWorker: true,
        hostAllowed: true,
        defaultToolAccess: 'content_read',
        contentReadPolicy: 'require_broker_grant',
      },
    };
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue(policyConfig),
    });
    mockReinitMCPServer.mockImplementation(({ serverName }) =>
      Promise.resolve({
        success: true,
        oauthRequired: false,
        tools: [{ name: `${serverName}_search`, inputSchema: { type: 'object' } }],
      }),
    );
    const callTool = jest.fn().mockResolvedValue({ ok: true });
    mockGetMCPManager.mockReturnValue({ callTool });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['scheduling-cortex', 'ms-365'],
      eagerServers: ['scheduling-cortex'],
      deferredServers: ['ms-365'],
      allowDynamicPolicyServers: false,
      scopes: { content_read: true },
    }).payload;

    const listed = await handleToolCall({ grant, toolName: 'capabilities_list' });
    expect(listed.servers.map((server) => server.name)).toEqual(['scheduling-cortex']);
    expect(listed.deferredServers).toEqual(['ms-365']);
    expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);
    expect(mockReinitMCPServer).not.toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'ms-365' }),
    );

    mockReinitMCPServer.mockClear();
    const described = await handleToolCall({
      grant,
      toolName: 'capability_describe',
      args: { server: 'ms-365' },
    });
    expect(described.servers.map((server) => server.name)).toEqual(['ms-365']);
    expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);
    expect(mockReinitMCPServer).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'ms-365', forceNew: false }),
    );

    mockReinitMCPServer.mockClear();
    await expect(
      handleToolCall({
        grant,
        toolName: 'capability_invoke',
        args: { server: 'ms-365', tool: 'ms-365_search', arguments: { query: 'synthetic' } },
      }),
    ).resolves.toEqual({ ok: true });
    expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'ms-365', toolName: 'ms-365_search' }),
    );

    mockReinitMCPServer.mockClear();
    await expect(
      handleToolCall({
        grant,
        toolName: 'capability_describe',
        args: { server: 'not-signed' },
      }),
    ).resolves.toEqual(expect.objectContaining({ servers: [], deferredServers: ['ms-365'] }));
    expect(mockReinitMCPServer).not.toHaveBeenCalled();
  });

  test.each(['missing_auth', 'unreadable_credential'])(
    'returns %s without starting interactive OAuth or MCP discovery',
    async (credentialStatus) => {
      const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
      const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
      mockGetMCPServersRegistry.mockReturnValue({
        getServerConfig: jest.fn().mockResolvedValue({
          source: 'config',
          requiresOAuth: true,
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            hostAllowed: true,
            defaultToolAccess: 'content_read',
            contentReadPolicy: 'require_broker_grant',
          },
        }),
      });
      mockInspectStoredOAuthCredentialState.mockResolvedValue({ status: credentialStatus });
      const grant = mintBrokerGrant({
        user: { id: 'user-1', role: 'USER' },
        allowedServers: ['ms-365'],
        eagerServers: [],
        deferredServers: ['ms-365'],
        scopes: { content_read: true },
      }).payload;

      const described = await handleToolCall({
        grant,
        toolName: 'capability_describe',
        args: { server: 'ms-365' },
      });

      expect(described.omissions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reason: credentialStatus,
            recovery: expect.objectContaining({
              action: 'connect_mcp_account',
              surface: 'agent_builder',
              server: 'ms-365',
            }),
          }),
        ]),
      );
      expect(described.servers).toEqual([
        expect.objectContaining({
          name: 'ms-365',
          available: false,
          oauthRequired: true,
          credentialStatus,
          recovery: expect.objectContaining({
            action: 'connect_mcp_account',
            surface: 'agent_builder',
            server: 'ms-365',
          }),
        }),
      ]);
      expect(mockReinitMCPServer).not.toHaveBeenCalled();

      await expect(
        handleToolCall({
          grant,
          toolName: 'capability_describe',
          args: { server: 'ms-365', tool: 'list_mail' },
        }),
      ).resolves.toEqual({
        status: 'blocked',
        reason: credentialStatus,
        server: 'ms-365',
        tool: 'list_mail',
        oauthRequired: true,
        recovery: expect.objectContaining({
          action: 'connect_mcp_account',
          surface: 'agent_builder',
          server: 'ms-365',
        }),
      });

      await expect(
        handleToolCall({
          grant,
          toolName: 'capability_invoke',
          args: { server: 'ms-365', tool: 'list_mail', arguments: {} },
        }),
      ).resolves.toEqual({
        status: 'blocked',
        reason: credentialStatus,
        server: 'ms-365',
        tool: 'list_mail',
        oauthRequired: true,
        recovery: expect.objectContaining({
          action: 'connect_mcp_account',
          surface: 'agent_builder',
          server: 'ms-365',
        }),
      });
      expect(mockReinitMCPServer).not.toHaveBeenCalled();
    },
  );

  test('preserves reconnect_required when a readable credential is rejected during discovery', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue({
        source: 'config',
        requiresOAuth: true,
        viventiumGlassHive: {
          version: 1,
          permitsAutonomousWorker: true,
          hostAllowed: true,
          defaultToolAccess: 'content_read',
          contentReadPolicy: 'require_broker_grant',
        },
      }),
    });
    mockInspectStoredOAuthCredentialState.mockResolvedValue({ status: 'credential_present' });
    mockReinitMCPServer.mockResolvedValue({
      success: false,
      oauthRequired: true,
      tools: [],
      credentialState: { status: 'reconnect_required' },
      recovery: {
        action: 'connect_mcp_account',
        surface: 'agent_builder',
        server: 'ms-365',
        instructions:
          'Open Agent Builder, select the agent that owns this connected account, then in MCP Servers choose Connect beside the unavailable server.',
      },
    });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['ms-365'],
      eagerServers: [],
      deferredServers: ['ms-365'],
      scopes: { content_read: true },
    }).payload;

    await expect(
      handleToolCall({
        grant,
        toolName: 'capability_invoke',
        args: { server: 'ms-365', tool: 'list_mail', arguments: {} },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'blocked',
        reason: 'reconnect_required',
        recovery: expect.objectContaining({
          action: 'connect_mcp_account',
          surface: 'agent_builder',
        }),
      }),
    );
    expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);
  });

  test('continues normal MCP discovery when an OAuth credential is readable', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue({
        source: 'config',
        requiresOAuth: true,
        viventiumGlassHive: {
          version: 1,
          permitsAutonomousWorker: true,
          hostAllowed: true,
          defaultToolAccess: 'content_read',
          contentReadPolicy: 'require_broker_grant',
        },
      }),
    });
    mockInspectStoredOAuthCredentialState.mockResolvedValue({ status: 'credential_present' });
    mockReinitMCPServer.mockResolvedValue({
      success: true,
      oauthRequired: false,
      tools: [{ name: 'list_mail', inputSchema: { type: 'object' } }],
    });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['ms-365'],
      eagerServers: [],
      deferredServers: ['ms-365'],
      scopes: { content_read: true },
    }).payload;

    const described = await handleToolCall({
      grant,
      toolName: 'capability_describe',
      args: { server: 'ms-365' },
    });

    expect(described.servers).toEqual([
      expect.objectContaining({ name: 'ms-365', available: true, oauthRequired: false }),
    ]);
    expect(mockInspectStoredOAuthCredentialState).toHaveBeenCalledWith('user-1', 'ms-365');
    expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);
    expect(mockReinitMCPServer).toHaveBeenCalledWith(
      expect.objectContaining({ allowOAuthInitiation: false }),
    );
  });

  test('returns a typed degraded bundle when reviewed capability inventory is unavailable', async () => {
    const {
      buildConversationProviderBootstrapBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockRejectedValue(new Error('synthetic registry outage')),
    });

    const result = await buildConversationProviderBootstrapBundle({
      user: { id: 'user-1', role: 'USER' },
      requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
      deferredServerNames: ['ms-365'],
    });

    expect(result.glasshive_capability_status).toEqual({
      status: 'degraded',
      reason: 'registry_unavailable',
    });
    expect(result.agents_md).toContain('capability broker is degraded');
    expect(JSON.stringify(result)).not.toContain('synthetic registry outage');
  });

  test('preserves eager capabilities while exposing a typed handoff-resolution degradation', async () => {
    const {
      buildConversationProviderBootstrapBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        'scheduling-cortex': {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            hostAllowed: true,
            defaultToolAccess: 'content_read',
          },
        },
      }),
    });

    const result = await buildConversationProviderBootstrapBundle({
      user: { id: 'user-1', role: 'USER' },
      requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
      allowedServerNames: ['scheduling-cortex'],
      capabilityResolutionStatus: 'handoff_capability_resolution_unavailable',
    });

    expect(result.glasshive_capability_broker.eager_servers).toEqual(['scheduling-cortex']);
    expect(result.glasshive_capability_status).toEqual({
      status: 'degraded',
      reason: 'handoff_capability_resolution_unavailable',
    });
    expect(result.agents_md).toContain('capability broker is degraded');
  });

  test.each([
    [{ id: 'user-1', role: 'USER' }, false, 'broker_disabled'],
    [undefined, true, 'user_scope_unavailable'],
  ])(
    'returns typed degraded context for eager Agent tools when broker/user scope is unavailable',
    async (user, projectionEnabled, reason) => {
      const {
        buildConversationProviderBootstrapBundle,
      } = require('../GlassHiveCapabilityBootstrapService');
      const previous = process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED;
      process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED = projectionEnabled
        ? 'true'
        : 'false';
      try {
        const result = await buildConversationProviderBootstrapBundle({
          user,
          requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
          allowedServerNames: ['scheduling-cortex'],
        });
        expect(result.glasshive_capability_status).toEqual({ status: 'degraded', reason });
        expect(result.agents_md).toContain('capability broker is degraded');
      } finally {
        if (previous === undefined) {
          delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED;
        } else {
          process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED = previous;
        }
      }
    },
  );

  test('injects broker MCP config into GlassHive launch bootstrap without provider secrets', async () => {
    const {
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        'ms-365': {
          source: 'config',
          oauth: { client_secret: 'provider-secret' },
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
            defaultToolAccess: 'content_read',
            contentReadPolicy: 'require_broker_grant',
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
    expect(result.context).toContain('authorized by reviewed host policy');
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

  test('injects run memory and the pinned feeling capsule into every worker instruction bundle', async () => {
    const {
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        'ms-365': {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
            defaultToolAccess: 'content_read',
            contentReadPolicy: 'require_broker_grant',
          },
        },
      }),
    });
    const memory = '- Prefers concise summaries\n- Key people: Alex (ExampleCo), Sam (intro)';
    const feelings = [
      '<viventium_feeling_state>',
      'You, Viventium, are a being, and right now you are actually feeling this. Let it move naturally through how you think, speak, and act:',
      '- Energy: steady',
      '</viventium_feeling_state>',
    ].join('\n');

    const withMemory = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'workspace_launch',
      toolArguments: {
        description: 'Check inbox',
        success_criteria: 'x',
        execution_mode: 'docker',
      },
      config: {
        configurable: {
          user: { id: 'user-1', role: 'USER' },
          requestBody: {},
          glasshive_worker_memory: memory,
          glasshive_worker_feelings: feelings,
          glasshive_worker_feelings_scope: 'all_agents',
          glasshive_worker_feelings_range_prompt_override_count: 3,
          glasshive_worker_feelings_active_range_prompt_override_count: 1,
          glasshive_worker_feelings_active_range_prompt_override_chars: 44,
        },
      },
    });
    expect(withMemory.bootstrap_bundle_json.agents_md).toContain('saved memory');
    expect(withMemory.bootstrap_bundle_json.agents_md).toContain('Alex (ExampleCo)');
    expect(withMemory.bootstrap_bundle_json.claude_md).toContain('Sam (intro)');
    expect(withMemory.bootstrap_bundle_json.codex_md).toContain('Prefers concise summaries');
    expect(withMemory.bootstrap_bundle_json.agents_md).toContain('You, Viventium, are a being');
    expect(withMemory.bootstrap_bundle_json.claude_md).toContain('- Energy: steady');
    expect(withMemory.bootstrap_bundle_json.codex_md).toContain('</viventium_feeling_state>');
    for (const field of ['agents_md', 'claude_md', 'codex_md']) {
      expect(withMemory.bootstrap_bundle_json[field].trim().endsWith(feelings)).toBe(true);
      expect(withMemory.bootstrap_bundle_json[field].split(feelings)).toHaveLength(2);
    }
    const { logger } = require('@librechat/data-schemas');
    const placementLogs = logger.info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('feelings.inject.final_run'));
    expect(placementLogs).toHaveLength(3);
    expect(logger.info.mock.calls.map(([message]) => String(message)).join('\n')).toContain(
      '"scope":"all_agents"',
    );
    const placementEvidence = logger.info.mock.calls.map(([message]) => String(message)).join('\n');
    expect(placementEvidence).toContain('"rangePromptOverrideCount":3');
    expect(placementEvidence).toContain('"activeRangePromptOverrideCount":1');
    expect(placementEvidence).toContain('"activeRangePromptOverrideChars":44');

    const withoutMemory = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'workspace_launch',
      toolArguments: {
        description: 'Check inbox',
        success_criteria: 'x',
        execution_mode: 'docker',
      },
      config: { configurable: { user: { id: 'user-1', role: 'USER' }, requestBody: {} } },
    });
    expect(withoutMemory.bootstrap_bundle_json.agents_md || '').not.toContain('saved memory');
    expect(withoutMemory.bootstrap_bundle_json.agents_md || '').not.toContain(
      '<viventium_feeling_state>',
    );
  });

  test('forwards all-agent feelings even when the optional capability broker is disabled', async () => {
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED = 'false';
    const {
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
    const capsule = '<viventium_feeling_state>\nenergy: steady\n</viventium_feeling_state>';

    const result = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'worker_delegate_once',
      toolArguments: { instruction: 'Do the work.' },
      config: {
        configurable: {
          glasshive_worker_feelings: capsule,
          glasshive_worker_feelings_hash: 'snapshot-7',
          glasshive_worker_feelings_scope: 'all_agents',
        },
      },
    });

    expect(result.instruction).toBe('Do the work.');
    expect(result.bootstrap_bundle_json.agents_md).toContain(capsule);
    expect(result.bootstrap_bundle_json.claude_md).toContain(capsule);
    expect(result.bootstrap_bundle_json.codex_md).toContain(capsule);
    expect(result.bootstrap_bundle_json.agents_md.trim().endsWith(capsule)).toBe(true);
    expect(result.bootstrap_bundle_json.claude_md.trim().endsWith(capsule)).toBe(true);
    expect(result.bootstrap_bundle_json.codex_md.trim().endsWith(capsule)).toBe(true);
    expect(result.bootstrap_bundle_json.glasshive_capability_broker).toBeUndefined();
  });

  test('injects broker MCP config into GlassHive continue calls without replacing user instructions', async () => {
    const {
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        google_workspace: {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
            defaultToolAccess: 'content_read',
            contentReadPolicy: 'require_broker_grant',
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
    const {
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
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
            defaultToolAccess: 'content_read',
            contentReadPolicy: 'require_broker_grant',
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
            defaultToolAccess: 'content_read',
            contentReadPolicy: 'require_broker_grant',
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

  test('does not trust worker metadata to authorize content-read scope', () => {
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

  test('does not mint content-read scope from a host flag when reviewed policy lacks read access', async () => {
    const {
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
    const { logger } = require('@librechat/data-schemas');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        admin_tools: {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
            defaultToolAccess: 'none',
            contentReadPolicy: 'deny',
          },
        },
      }),
    });

    const result = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'workspace_launch',
      toolArguments: {
        description: 'Inspect connected account data',
        success_criteria: 'Use real evidence',
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

    expect(result.bootstrap_bundle_json.glasshive_capability_broker.allowed_servers).toEqual([
      'admin_tools',
    ]);
    expect(result.bootstrap_bundle_json.glasshive_capability_broker.scopes.content_read).toBe(
      false,
    );
    expect(result.context).toContain('Content-read broker scope for this run is not authorized');
    expect(logger.warn).toHaveBeenCalledWith(
      '[VIVENTIUM][glasshive-capability-broker] Host requested connected-account content scope but reviewed policy did not grant it',
      { allowedServers: ['admin_tools'] },
    );
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
    const {
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
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

  test('exposes broker idempotency for explicitly allowed scheduling writes', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
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
        hostAllowed: true,
        sandboxAllowed: false,
        defaultToolAccess: 'none',
        writePolicy: 'allow',
        toolPolicies: {
          schedule_create: { access: 'write' },
        },
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
          name: 'schedule_create',
          description: 'Create a scheduled task',
          inputSchema: {
            type: 'object',
            properties: { prompt: { type: 'string' } },
            required: ['prompt'],
            additionalProperties: false,
          },
        },
      ],
    });
    const callTool = jest.fn().mockResolvedValue({ success: true });
    mockGetMCPManager.mockReturnValue({ callTool });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['scheduling-cortex'],
    }).payload;

    const catalog = await buildCapabilityCatalog({ grant });
    const definition = toolDefinitionsForMcp(catalog).find(
      (tool) => tool.name === 'gh_scheduling_cortex__schedule_create',
    );
    expect(definition.inputSchema.properties.invocation_id).toEqual(
      expect.objectContaining({ type: 'string' }),
    );
    expect(definition.inputSchema.additionalProperties).toBe(false);

    await expect(
      handleToolCall({
        grant,
        toolName: definition.name,
        args: { prompt: 'Synthetic reminder', invocation_id: 'schedule-create-synthetic-1' },
      }),
    ).resolves.toEqual({ success: true });
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolArguments: { prompt: 'Synthetic reminder' } }),
    );
  });

  test('requires signed content-read grant scope and escalates destructive annotations to write policy', async () => {
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
          contentReadPolicy: 'require_broker_grant',
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
        reason: 'content_read_requires_broker_grant_scope',
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
        reason: 'content_read_requires_broker_grant_scope',
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
    expect(mockGetMCPManager().callTool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ timeout: 45000 }),
      }),
    );
    expect(mockGetMCPManager().callTool.mock.calls.at(-1)[0].options.signal).toBeUndefined();

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
          contentReadPolicy: 'require_broker_grant',
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

  test('reuses an active MCP connection and retries stale empty broker discovery once', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const {
      buildCapabilityCatalog,
      toolDefinitionsForMcp,
    } = require('../GlassHiveCapabilityBrokerService');
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
    expect(mockReinitMCPServer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        serverName: 'google_workspace',
        forceNew: false,
      }),
    );
    expect(mockReinitMCPServer).toHaveBeenNthCalledWith(
      2,
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

  /* === VIVENTIUM START ===
   * Feature: Direct user/worker/run-bound grants and redacted two-user readiness.
   */
  test('mints fresh direct grants bound to the verified user, worker, and run', async () => {
    const {
      buildDirectGlassHiveCapabilityBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        documents: {
          source: 'config',
          title: 'Documents',
          requiresOAuth: true,
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
            hostAllowed: true,
            defaultToolAccess: 'content_read',
          },
        },
      }),
    });

    const first = await buildDirectGlassHiveCapabilityBundle({
      user: { id: 'user-1', role: 'USER' },
      workerId: 'worker-a',
      runId: 'run-a',
      executionMode: 'docker',
    });
    const second = await buildDirectGlassHiveCapabilityBundle({
      user: { id: 'user-1', role: 'USER' },
      workerId: 'worker-a',
      runId: 'run-b',
      executionMode: 'docker',
    });
    const firstGrant = JSON.parse(
      Buffer.from(
        first.bootstrapBundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN,
        'base64url',
      ).toString('utf8'),
    );
    const secondGrant = JSON.parse(
      Buffer.from(
        second.bootstrapBundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN,
        'base64url',
      ).toString('utf8'),
    );

    expect(first.grantRef).toMatchObject({
      user_id: 'user-1',
      worker_id: 'worker-a',
      run_id: 'run-a',
    });
    expect(firstGrant.worker_id).toBe('worker-a');
    expect(firstGrant.run_id).toBe('run-a');
    expect(secondGrant.run_id).toBe('run-b');
    expect(firstGrant.grant_id).not.toBe(secondGrant.grant_id);
    expect(first.capabilityStatus.connections).toEqual([
      expect.objectContaining({
        connection_id: 'librechat:documents',
        status: 'ready',
      }),
    ]);
  });

  test('keeps two users isolated and returns redacted action-required readiness', async () => {
    const { directCapabilityReadiness } = require('../GlassHiveCapabilityBootstrapService');
    const getAllServerConfigs = jest.fn(async (userId) => ({
      [`documents-${userId}`]: {
        source: 'config',
        title: `Documents ${userId}`,
        requiresOAuth: true,
        viventiumGlassHive: {
          version: 1,
          permitsAutonomousWorker: true,
          sandboxAllowed: true,
          defaultToolAccess: 'content_read',
        },
      },
    }));
    mockGetMCPServersRegistry.mockReturnValue({ getAllServerConfigs });
    mockInspectStoredOAuthCredentialState.mockImplementation(async (userId, serverName) => ({
      status:
        userId === 'user-1' && serverName === 'documents-user-1'
          ? 'credential_present'
          : 'missing_auth',
    }));

    const userOne = await directCapabilityReadiness({
      user: { id: 'user-1' },
      executionMode: 'docker',
    });
    const userTwo = await directCapabilityReadiness({
      user: { id: 'user-2' },
      executionMode: 'docker',
    });

    expect(userOne.connections).toEqual([
      expect.objectContaining({ kind: 'documents-user-1', status: 'ready' }),
    ]);
    expect(userTwo.connections).toEqual([
      expect.objectContaining({ kind: 'documents-user-2', status: 'action_required' }),
    ]);
    expect(userTwo).not.toHaveProperty('token');
    expect(JSON.stringify(userTwo)).not.toMatch(/credential_present|missing_auth/);
  });
  /* === VIVENTIUM END === */
});
