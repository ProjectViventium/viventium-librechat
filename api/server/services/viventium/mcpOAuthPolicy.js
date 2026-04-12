/* === VIVENTIUM START ===
 * Feature: MCP OAuth wait policy (surface + structural tool-surface awareness)
 *
 * Purpose:
 * - Keep non-tool turns fast by avoiding OAuth wait loops and removing OAuth-pending MCP tools
 *   from the current turn's toolset.
 * - Preserve wait behavior only when the loaded tool surface is structurally blocked on a pending
 *   OAuth-backed MCP server.
 *
 * Notes:
 * - Telegram/gateway surfaces never wait for OAuth in-turn (no interactive OAuth UX parity).
 * - Runtime wait policy must not guess user intent from message keywords or provider labels.
 * - Web/voice wait behavior is controlled by VIVENTIUM_MCP_OAUTH_WAIT_POLICY:
 *   - intent (default): wait only when one pending OAuth server owns the specialist tool surface
 *     and only generic built-ins remain otherwise
 *   - always: always wait on web/voice
 *   - never: never wait
 * === VIVENTIUM END === */

const { Constants } = require('librechat-data-provider');

const GENERIC_WAIT_SAFE_TOOL_NAMES = new Set(['file_search', 'web_search', 'execute_code']);

const normalizeWaitPolicy = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'always' || normalized === 'never' || normalized === 'intent') {
    return normalized;
  }
  return 'intent';
};

const getSurface = (req) => {
  if (req?._viventiumTelegram) {
    return 'telegram';
  }
  if (req?._viventiumGateway) {
    return 'gateway';
  }
  if (req?.viventiumCallSession) {
    return 'voice';
  }
  return 'web';
};

const collectLoadedToolNames = ({ toolDefinitions, toolRegistry } = {}) => {
  /** @type {Set<string>} */
  const names = new Set();

  if (Array.isArray(toolDefinitions)) {
    for (const definition of toolDefinitions) {
      if (typeof definition?.name === 'string' && definition.name) {
        names.add(definition.name);
      }
    }
  }

  if (toolRegistry instanceof Map) {
    for (const [name] of toolRegistry.entries()) {
      if (typeof name === 'string' && name) {
        names.add(name);
      }
    }
  }

  return Array.from(names);
};

const isOAuthPendingMcpTool = (toolName, serverNames) =>
  typeof toolName === 'string' &&
  serverNames.some((serverName) => toolName.endsWith(`${Constants.mcp_delimiter}${serverName}`));

const getRelevantPendingOAuthServers = ({ toolDefinitions, toolRegistry, pendingOAuthServers } = {}) => {
  const serverNames = Array.from(pendingOAuthServers ?? []).filter(Boolean);
  if (serverNames.length === 0) {
    return [];
  }

  const toolNames = collectLoadedToolNames({ toolDefinitions, toolRegistry });
  if (toolNames.length === 0) {
    return [];
  }

  return serverNames.filter((serverName) =>
    toolNames.some((toolName) => isOAuthPendingMcpTool(toolName, [serverName])),
  );
};

const hasNonPendingSpecializedTools = ({
  toolDefinitions,
  toolRegistry,
  pendingOAuthServers,
} = {}) => {
  const serverNames = Array.from(pendingOAuthServers ?? []).filter(Boolean);
  const toolNames = collectLoadedToolNames({ toolDefinitions, toolRegistry });

  return toolNames.some((toolName) => {
    if (isOAuthPendingMcpTool(toolName, serverNames)) {
      return false;
    }
    return !GENERIC_WAIT_SAFE_TOOL_NAMES.has(toolName);
  });
};

const getMcpOAuthWaitDecision = (req, pendingOAuthServers, { toolDefinitions, toolRegistry } = {}) => {
  const surface = getSurface(req);
  const mode = normalizeWaitPolicy(process.env.VIVENTIUM_MCP_OAUTH_WAIT_POLICY);
  const allPendingOAuthServers = Array.from(pendingOAuthServers ?? []).filter(Boolean);
  const hasSpecializedAlternatives = hasNonPendingSpecializedTools({
    toolDefinitions,
    toolRegistry,
    pendingOAuthServers: allPendingOAuthServers,
  });
  const relevantPendingOAuthServers =
    mode === 'always'
      ? allPendingOAuthServers
      : mode === 'never'
        ? []
        : getRelevantPendingOAuthServers({
            toolDefinitions,
            toolRegistry,
            pendingOAuthServers: allPendingOAuthServers,
          });

  let waitForOAuth = false;
  if (surface === 'telegram' || surface === 'gateway') {
    waitForOAuth = false;
  } else if (mode === 'always') {
    waitForOAuth = allPendingOAuthServers.length > 0;
  } else if (mode === 'never') {
    waitForOAuth = false;
  } else {
    waitForOAuth =
      relevantPendingOAuthServers.length === 1 && hasSpecializedAlternatives === false;
  }

  return {
    mode,
    surface,
    hasSpecializedAlternatives,
    relevantPendingOAuthServers,
    waitForOAuth,
  };
};

const stripOAuthPendingMcpTools = ({ toolDefinitions, toolRegistry, pendingOAuthServers }) => {
  const serverNames = Array.from(pendingOAuthServers ?? []).filter(Boolean);
  if (serverNames.length === 0) {
    return {
      toolDefinitions,
      toolRegistry,
      removedToolNames: [],
    };
  }

  /** @type {Set<string>} */
  const removed = new Set();

  let nextToolDefinitions = toolDefinitions;
  if (Array.isArray(toolDefinitions)) {
    nextToolDefinitions = toolDefinitions.filter((definition) => {
      const name = definition?.name;
      const shouldRemove = isOAuthPendingMcpTool(name, serverNames);
      if (shouldRemove && name) {
        removed.add(name);
      }
      return !shouldRemove;
    });
  }

  let nextToolRegistry = toolRegistry;
  if (toolRegistry instanceof Map) {
    nextToolRegistry = new Map();
    for (const [name, value] of toolRegistry.entries()) {
      if (isOAuthPendingMcpTool(name, serverNames)) {
        removed.add(name);
        continue;
      }
      nextToolRegistry.set(name, value);
    }
  }

  return {
    toolDefinitions: nextToolDefinitions,
    toolRegistry: nextToolRegistry,
    removedToolNames: Array.from(removed),
  };
};

module.exports = {
  hasNonPendingSpecializedTools,
  getRelevantPendingOAuthServers,
  getMcpOAuthWaitDecision,
  stripOAuthPendingMcpTools,
};
