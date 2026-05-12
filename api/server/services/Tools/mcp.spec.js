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
});
