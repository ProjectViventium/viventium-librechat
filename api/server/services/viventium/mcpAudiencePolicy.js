/* === VIVENTIUM START ===
 * Security: Shared request-audience policy for local MCP integrations.
 * Purpose: Enforce a server-declared audience consistently across definition discovery,
 * execution, and GlassHive capability projection without provider- or tool-name heuristics.
 * === VIVENTIUM END === */

const { Constants, SystemRoles } = require('librechat-data-provider');

function canUseViventiumMCPServer({ serverConfig, reqUser } = {}) {
  const audience = serverConfig?.viventiumAccess?.audience;
  if (audience == null || audience === 'authenticated') {
    return true;
  }
  if (audience === 'local_owner') {
    return reqUser?.role === SystemRoles.ADMIN;
  }
  return false;
}

function filterMCPToolsForAudience({ tools = [], configServers = {}, reqUser } = {}) {
  return tools.filter((tool) => {
    const value = String(tool || '');
    if (!value.includes(Constants.mcp_delimiter)) {
      return true;
    }
    const [, serverName] = value.split(Constants.mcp_delimiter);
    return canUseViventiumMCPServer({
      serverConfig: configServers?.[serverName],
      reqUser,
    });
  });
}

module.exports = {
  canUseViventiumMCPServer,
  filterMCPToolsForAudience,
};
