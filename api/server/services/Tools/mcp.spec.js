jest.mock('@librechat/data-schemas', () => ({
  decryptV2: jest.fn(),
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => ({
  MCPOAuthHandler: {
    initiateOAuthFlow: jest.fn(),
  },
}));

const mockRegistryInstance = {
  getServerConfig: jest.fn(),
};

jest.mock('~/config', () => ({
  getMCPManager: jest.fn(),
  getFlowStateManager: jest.fn(),
  getMCPServersRegistry: jest.fn(() => mockRegistryInstance),
}));

jest.mock('~/models', () => ({
  findToken: jest.fn(),
  createToken: jest.fn(),
  updateToken: jest.fn(),
  deleteToken: jest.fn(),
  deleteTokens: jest.fn(),
}));

jest.mock('~/server/services/Config', () => ({
  updateMCPServerTools: jest.fn(),
}));

jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => 'flows-store'),
}));

jest.mock('librechat-data-provider', () => ({
  CacheKeys: {
    FLOWS: 'flows',
  },
  Constants: {
    mcp_prefix: 'mcp_',
  },
}));

const { MCPOAuthHandler } = require('@librechat/api');
const { decryptV2 } = require('@librechat/data-schemas');
const { getMCPManager, getFlowStateManager } = require('~/config');
const { findToken } = require('~/models');
const { updateMCPServerTools } = require('~/server/services/Config');
const {
  buildMcpOAuthRecovery,
  inspectStoredOAuthCredentialState,
  reinitMCPServer,
  shouldUseCachedMcpTools,
} = require('./mcp');

describe('buildMcpOAuthRecovery', () => {
  it('returns a provider-independent Agent Builder recovery contract', () => {
    expect(buildMcpOAuthRecovery('synthetic-productivity')).toEqual({
      action: 'connect_mcp_account',
      surface: 'agent_builder',
      server: 'synthetic-productivity',
      instructions:
        'Open Agent Builder, select the agent that owns this connected account, then in MCP Servers choose Connect beside the unavailable server.',
    });
  });
});

describe('inspectStoredOAuthCredentialState', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts a readable live access token even when the refresh token is unreadable', async () => {
    findToken.mockImplementation(async ({ type }) => ({
      token: type === 'mcp_oauth' ? 'readable-access' : 'unreadable-refresh',
      expiresAt: new Date(Date.now() + 60_000),
    }));
    decryptV2.mockImplementation(async (token) => {
      if (token === 'unreadable-refresh') {
        throw new Error('different encryption key');
      }
      return 'decrypted-access';
    });

    await expect(inspectStoredOAuthCredentialState('user-synthetic', 'ms-365')).resolves.toEqual({
      status: 'credential_present',
    });
    expect(decryptV2).toHaveBeenCalledTimes(1);
    expect(decryptV2).toHaveBeenCalledWith('readable-access');
  });
});

describe('reinitMCPServer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    decryptV2.mockResolvedValue('synthetic-decrypted-token');
  });

  it.each([
    ['missing_auth', null],
    [
      'unreadable_credential',
      { token: 'synthetic-unreadable-token', expiresAt: new Date(Date.now() + 60_000) },
    ],
  ])(
    'does not initiate OAuth during non-interactive definition discovery: %s',
    async (expectedStatus, storedToken) => {
      const mcpManager = {
        getConnection: jest.fn(),
        discoverServerTools: jest.fn(),
      };
      getMCPManager.mockReturnValue(mcpManager);
      mockRegistryInstance.getServerConfig.mockResolvedValue({
        url: 'http://localhost:8112/mcp',
        requiresOAuth: true,
      });
      findToken.mockResolvedValue(storedToken);
      if (expectedStatus === 'unreadable_credential') {
        decryptV2.mockRejectedValue(new Error('different encryption key'));
      }

      const result = await reinitMCPServer({
        user: { id: 'user-synthetic' },
        serverName: 'ms-365',
        allowOAuthInitiation: false,
      });

      expect(result).toMatchObject({
        success: false,
        oauthRequired: true,
        oauthUrl: null,
        credentialState: { status: expectedStatus },
        recovery: {
          action: 'connect_mcp_account',
          surface: 'agent_builder',
          server: 'ms-365',
        },
      });
      expect(mcpManager.getConnection).not.toHaveBeenCalled();
      expect(MCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
    },
  );

  it('continues normal non-interactive discovery when a readable credential is present', async () => {
    const connection = {
      fetchTools: jest.fn().mockResolvedValue([{ name: 'list_mail', inputSchema: {} }]),
    };
    const mcpManager = {
      getConnection: jest.fn().mockResolvedValue(connection),
      discoverServerTools: jest.fn(),
    };
    getMCPManager.mockReturnValue(mcpManager);
    mockRegistryInstance.getServerConfig.mockResolvedValue({
      url: 'http://localhost:8112/mcp',
      requiresOAuth: true,
    });
    findToken.mockResolvedValue({
      token: 'synthetic-readable-token',
      expiresAt: new Date(Date.now() + 60_000),
    });
    updateMCPServerTools.mockResolvedValue({
      'list_mail_mcp_ms-365': {
        type: 'function',
        function: { name: 'list_mail_mcp_ms-365' },
      },
    });

    const result = await reinitMCPServer({
      user: { id: 'user-synthetic' },
      serverName: 'ms-365',
      allowOAuthInitiation: false,
    });

    expect(mcpManager.getConnection).toHaveBeenCalledTimes(1);
    expect(result.availableTools).toHaveProperty('list_mail_mcp_ms-365');
  });

  it('does not start OAuth when a readable credential is rejected during non-interactive discovery', async () => {
    const mcpManager = {
      getConnection: jest.fn().mockRejectedValue(new Error('401 authentication failed')),
      discoverServerTools: jest.fn(),
    };
    getMCPManager.mockReturnValue(mcpManager);
    mockRegistryInstance.getServerConfig.mockResolvedValue({
      url: 'http://localhost:8112/mcp',
      requiresOAuth: true,
    });
    findToken.mockResolvedValue({
      token: 'synthetic-readable-but-rejected-token',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await reinitMCPServer({
      user: { id: 'user-synthetic' },
      serverName: 'ms-365',
      allowOAuthInitiation: false,
    });

    expect(result).toMatchObject({
      success: false,
      oauthRequired: true,
      oauthUrl: null,
      credentialState: { status: 'reconnect_required' },
      recovery: {
        action: 'connect_mcp_account',
        surface: 'agent_builder',
        server: 'ms-365',
      },
    });
    expect(mcpManager.getConnection).toHaveBeenCalledTimes(1);
    expect(mcpManager.discoverServerTools).not.toHaveBeenCalled();
    expect(MCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
  });

  it('classifies an undecryptable stored OAuth grant and starts a clean reconnect', async () => {
    const flowManager = {
      deleteFlow: jest.fn().mockResolvedValue(),
      createFlow: jest.fn().mockResolvedValue(),
    };
    const mcpManager = {
      getConnection: jest.fn().mockRejectedValue(new Error('Connection timeout after 120000ms')),
      discoverServerTools: jest.fn().mockResolvedValue({ tools: null }),
    };
    getFlowStateManager.mockReturnValue(flowManager);
    getMCPManager.mockReturnValue(mcpManager);
    mockRegistryInstance.getServerConfig.mockResolvedValue({
      url: 'http://localhost:8112/mcp',
      requiresOAuth: true,
      oauth_headers: {},
      oauth: {},
    });
    findToken.mockImplementation(async ({ type }) => {
      if (type === 'mcp_oauth_refresh') {
        return {
          token: 'encrypted-under-a-different-key',
          expiresAt: new Date(Date.now() + 60_000),
        };
      }
      return null;
    });
    decryptV2.mockImplementation(async () => {
      throw new Error('The operation failed for an operation-specific reason');
    });
    MCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
      authorizationUrl: 'https://login.example.test/authorize',
      flowId: 'flow-unreadable',
      flowMetadata: { state: 'synthetic' },
    });

    const result = await reinitMCPServer({
      user: { id: 'user-synthetic' },
      serverName: 'ms-365',
    });

    expect(result.credentialState).toEqual({ status: 'unreadable_credential' });
    expect(result.oauthRequired).toBe(true);
    expect(result.oauthUrl).toBe('https://login.example.test/authorize');
  });

  it('initiates fallback OAuth when an OAuth server times out before surfacing auth', async () => {
    const flowManager = {
      deleteFlow: jest.fn().mockResolvedValue(),
      createFlow: jest.fn().mockResolvedValue(),
    };
    const mcpManager = {
      getConnection: jest.fn().mockRejectedValue(new Error('Connection timeout after 120000ms')),
      discoverServerTools: jest.fn().mockResolvedValue({ tools: null }),
    };

    getFlowStateManager.mockReturnValue(flowManager);
    getMCPManager.mockReturnValue(mcpManager);
    mockRegistryInstance.getServerConfig.mockResolvedValue({
      url: 'http://localhost:8111/mcp',
      requiresOAuth: true,
      oauth_headers: {},
      oauth: {},
    });
    findToken.mockResolvedValue(null);
    MCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
      flowId: 'flow-1',
      flowMetadata: { state: 'abc' },
    });

    const result = await reinitMCPServer({
      user: { id: 'user-123' },
      serverName: 'google_workspace',
    });

    expect(MCPOAuthHandler.initiateOAuthFlow).toHaveBeenCalledWith(
      'google_workspace',
      'http://localhost:8111/mcp',
      'user-123',
      {},
      {},
    );
    expect(flowManager.deleteFlow).toHaveBeenCalledWith('flow-1', 'mcp_oauth');
    expect(flowManager.createFlow).toHaveBeenCalledWith(
      'flow-1',
      'mcp_oauth',
      { state: 'abc' },
      undefined,
    );
    expect(mcpManager.discoverServerTools).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'google_workspace',
        user: { id: 'user-123' },
      }),
    );
    expect(result).toMatchObject({
      success: true,
      oauthRequired: true,
      oauthUrl: 'https://accounts.google.com/o/oauth2/auth',
      serverName: 'google_workspace',
    });
  });

  it('classifies a rejected readable grant as reconnect-required and emits a fresh auth URL', async () => {
    const flowManager = {
      deleteFlow: jest.fn().mockResolvedValue(),
      createFlow: jest.fn().mockResolvedValue(),
    };
    const mcpManager = {
      getConnection: jest.fn().mockRejectedValue(new Error('401 authentication failed')),
      discoverServerTools: jest.fn().mockResolvedValue({ tools: null }),
    };
    getFlowStateManager.mockReturnValue(flowManager);
    getMCPManager.mockReturnValue(mcpManager);
    mockRegistryInstance.getServerConfig.mockResolvedValue({
      url: 'http://localhost:8112/mcp',
      requiresOAuth: true,
      oauth_headers: {},
      oauth: {},
    });
    findToken.mockResolvedValue({
      token: 'synthetic-readable-token',
      expiresAt: new Date(Date.now() + 60_000),
    });
    MCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
      authorizationUrl: 'https://login.example.test/reauthorize',
      flowId: 'flow-reconnect',
      flowMetadata: { state: 'synthetic-reconnect' },
    });

    const result = await reinitMCPServer({
      user: { id: 'user-synthetic' },
      serverName: 'ms-365',
    });

    expect(result.credentialState).toEqual({ status: 'reconnect_required' });
    expect(result.oauthRequired).toBe(true);
    expect(result.oauthUrl).toBe('https://login.example.test/reauthorize');
  });

  it('uses a provided server config without refetching registry config during hot-path reinit', async () => {
    const serverConfig = {
      url: 'http://localhost:8112/mcp',
      requiresOAuth: false,
      source: 'config',
    };
    const connection = {
      fetchTools: jest.fn().mockResolvedValue([{ name: 'list_docs', inputSchema: {} }]),
    };
    const mcpManager = {
      getConnection: jest.fn().mockResolvedValue(connection),
      discoverServerTools: jest.fn(),
    };

    getMCPManager.mockReturnValue(mcpManager);
    updateMCPServerTools.mockResolvedValue({
      list_docs_mcp_google_workspace: {
        type: 'function',
        function: { name: 'list_docs_mcp_google_workspace' },
      },
    });

    const result = await reinitMCPServer({
      user: { id: 'user-123' },
      serverName: 'google_workspace',
      serverConfig,
    });

    expect(mockRegistryInstance.getServerConfig).not.toHaveBeenCalled();
    expect(mcpManager.getConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'google_workspace',
        serverConfig,
      }),
    );
    expect(updateMCPServerTools).toHaveBeenCalledWith({
      userId: 'user-123',
      serverName: 'google_workspace',
      tools: [{ name: 'list_docs', inputSchema: {} }],
    });
    expect(result.availableTools).toEqual({
      list_docs_mcp_google_workspace: {
        type: 'function',
        function: { name: 'list_docs_mcp_google_workspace' },
      },
    });
  });

  it('returns an explicit failure result when reinitialization throws before connecting', async () => {
    mockRegistryInstance.getServerConfig.mockRejectedValue(new Error('registry unavailable'));

    const result = await reinitMCPServer({
      user: { id: 'user-123' },
      serverName: 'glasshive-workers-projects',
    });

    expect(result).toEqual({
      availableTools: null,
      success: false,
      failureClass: 'reinitialization_error',
      message: "Failed to reinitialize MCP server 'glasshive-workers-projects'",
      oauthRequired: false,
      serverName: 'glasshive-workers-projects',
      oauthUrl: null,
      tools: null,
    });
  });

  it('preserves OAuth state when a later reinitialization step fails', async () => {
    const discoveredTools = [{ name: 'list_docs', inputSchema: {} }];
    const mcpManager = {
      getConnection: jest.fn().mockImplementation(async ({ oauthStart }) => {
        await oauthStart('https://accounts.example.com/oauth');
        throw new Error('OAuth flow initiated - return early');
      }),
      discoverServerTools: jest.fn().mockResolvedValue({ tools: discoveredTools }),
    };

    getMCPManager.mockReturnValue(mcpManager);
    mockRegistryInstance.getServerConfig.mockResolvedValue({
      url: 'http://localhost:8113/mcp',
      requiresOAuth: true,
    });
    findToken.mockResolvedValue(null);
    updateMCPServerTools.mockRejectedValue(new Error('tool cache unavailable'));

    const result = await reinitMCPServer({
      user: { id: 'user-123' },
      serverName: 'google_workspace',
    });

    expect(result).toMatchObject({
      success: false,
      failureClass: 'reinitialization_error',
      oauthRequired: true,
      oauthUrl: 'https://accounts.example.com/oauth',
      tools: discoveredTools,
    });
  });
});

describe('shouldUseCachedMcpTools', () => {
  it('does not treat cached schemas as ready when an OAuth credential is unusable', () => {
    const oauthServer = { requiresOAuth: true };
    expect(shouldUseCachedMcpTools(oauthServer, { status: 'unreadable_credential' })).toBe(false);
    expect(shouldUseCachedMcpTools(oauthServer, { status: 'missing_auth' })).toBe(false);
    expect(shouldUseCachedMcpTools(oauthServer, { status: 'credential_present' })).toBe(true);
    expect(shouldUseCachedMcpTools({ requiresOAuth: false }, null)).toBe(true);
  });
});
