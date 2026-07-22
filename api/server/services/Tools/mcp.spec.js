jest.mock('@librechat/data-schemas', () => ({
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
const { getMCPManager, getFlowStateManager } = require('~/config');
const { findToken } = require('~/models');
const { updateMCPServerTools } = require('~/server/services/Config');
const { reinitMCPServer } = require('./mcp');

describe('reinitMCPServer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
