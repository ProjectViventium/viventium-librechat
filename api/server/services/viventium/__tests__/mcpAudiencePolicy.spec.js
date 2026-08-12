jest.mock('librechat-data-provider', () => ({
  Constants: { mcp_delimiter: '_mcp_' },
  SystemRoles: { ADMIN: 'ADMIN', USER: 'USER' },
}));

const { canUseViventiumMCPServer, filterMCPToolsForAudience } = require('../mcpAudiencePolicy');

describe('Viventium MCP request audiences', () => {
  const configs = {
    'private-source': { viventiumAccess: { audience: 'local_owner' } },
    'public-source': { viventiumAccess: { audience: 'authenticated' } },
  };

  test('filters any owner-only server structurally for an ordinary user', () => {
    expect(
      filterMCPToolsForAudience({
        tools: ['builtin_tool', 'read_mcp_private-source', 'list_mcp_public-source'],
        configServers: configs,
        reqUser: { role: 'USER' },
      }),
    ).toEqual(['builtin_tool', 'list_mcp_public-source']);
  });

  test('allows the same declared server for the local owner', () => {
    expect(
      filterMCPToolsForAudience({
        tools: ['read_mcp_private-source'],
        configServers: configs,
        reqUser: { role: 'ADMIN' },
      }),
    ).toEqual(['read_mcp_private-source']);
  });

  test('fails closed for unknown audiences', () => {
    expect(
      canUseViventiumMCPServer({
        serverConfig: { viventiumAccess: { audience: 'future-audience' } },
        reqUser: { role: 'ADMIN' },
      }),
    ).toBe(false);
  });
});
