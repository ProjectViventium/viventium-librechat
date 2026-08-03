/* === VIVENTIUM START ===
 * Feature: Optional agent graph resilience
 * Purpose: Record handoff agents that could not initialize so the shared edge filter removes
 * their targets before LangGraph compiles the request graph.
 * Added: 2026-07-13
 * === VIVENTIUM END === */

function markOptionalAgentInitializationFailed(skippedAgentIds, agentId) {
  if (!(skippedAgentIds instanceof Set)) {
    throw new TypeError('skippedAgentIds must be a Set');
  }
  if (typeof agentId !== 'string' || agentId.trim().length === 0) {
    throw new TypeError('agentId is required');
  }
  skippedAgentIds.add(agentId);
}

const { Constants } = require('librechat-data-provider');

const CONCLUSIVE_MCP_UNAVAILABLE_STATUSES = new Set([
  'disabled',
  'missing_auth',
  'oauth_pending',
  'oauth_required',
  'reconnect_required',
  'unavailable',
  'unreadable_credential',
]);

function declaredMcpServerNames(agent = {}) {
  const delimiter = Constants.mcp_delimiter;
  const names = new Set();
  for (const tool of agent.tools || []) {
    if (typeof tool !== 'string') {
      continue;
    }
    const index = tool.lastIndexOf(delimiter);
    if (index >= 0) {
      const name = tool.slice(index + delimiter.length).trim();
      if (name) {
        names.add(name);
      }
    }
  }
  return Array.from(names).sort();
}

/**
 * A handoff that owns one or more MCP capabilities must not remain callable after every one of
 * those capabilities was conclusively removed from the current request. Unknown readiness fails
 * open so a telemetry gap never deletes a healthy graph edge.
 */
function evaluateOptionalAgentCapabilityReadiness(declaredAgent = {}, initializedAgent = {}) {
  const declaredServers = declaredMcpServerNames(declaredAgent);
  const readiness = initializedAgent.mcpCapabilityReadiness;
  if (declaredServers.length === 0 || !readiness || typeof readiness !== 'object') {
    return {
      keep: true,
      declaredServers,
      readyServers: [],
      unavailableServers: [],
      unknownServers: declaredServers,
    };
  }

  const readyServers = [];
  const unavailableServers = [];
  const unknownServers = [];
  for (const server of declaredServers) {
    const status = String(readiness[server]?.status || '').trim();
    if (!status) {
      unknownServers.push(server);
    } else if (status === 'ready') {
      readyServers.push(server);
    } else if (CONCLUSIVE_MCP_UNAVAILABLE_STATUSES.has(status)) {
      const recovery = readiness[server]?.recovery;
      unavailableServers.push({
        server,
        status,
        ...(recovery && typeof recovery === 'object' ? { recovery } : {}),
      });
    } else {
      unknownServers.push(server);
    }
  }
  return {
    keep: readyServers.length > 0 || unknownServers.length > 0,
    declaredServers,
    readyServers,
    unavailableServers,
    unknownServers,
  };
}

function appendOmittedCapabilityReadiness(primaryAgent, readinessRecords = []) {
  if (!primaryAgent || !Array.isArray(readinessRecords) || readinessRecords.length === 0) {
    return false;
  }
  const facts = readinessRecords
    .flatMap((record) => record?.unavailableServers || [])
    .map(({ server, status }) => `${server}=${status}`)
    .filter(Boolean);
  const recoveryInstructions = readinessRecords
    .flatMap((record) => record?.unavailableServers || [])
    .map((item) => String(item?.recovery?.instructions || '').trim())
    .filter(Boolean);
  if (facts.length === 0) {
    return false;
  }
  const block = [
    'OPTIONAL CAPABILITY READINESS:',
    `- Unavailable for this turn: ${Array.from(new Set(facts)).sort().join(', ')}.`,
    '- The corresponding optional handoff was omitted so you cannot transfer into a capability-empty agent.',
    '- Treat each independently satisfiable part of the request independently: one unavailable capability does not make another ready capability unavailable.',
    '- For each satisfiable part that depends on current external state, call an appropriate available tool in this turn before answering; do not tell the user to call a tool.',
    '- If no remaining capability can satisfy a part, explain the exact connection or reconnection requirement plainly.',
    ...(recoveryInstructions.length > 0
      ? [
          `- Supported recovery: ${Array.from(new Set(recoveryInstructions)).sort().join(' ')}`,
          '- Use that supported recovery exactly; do not invent or substitute another settings path.',
        ]
      : []),
    '- Do not expose raw tool or server identifiers unless the user explicitly asks for diagnostics; describe the human-facing action or connection instead.',
  ].join('\n');
  primaryAgent.instructions = [primaryAgent.instructions || '', block].filter(Boolean).join('\n\n');
  return true;
}

/**
 * A lazy model fallback is still the same logical agent and must inherit the request-resolved
 * graph. Reusing its pre-resolution edges can resurrect a handoff that was omitted because every
 * owned capability was unavailable, or point LangGraph at an agent config that was never added.
 */
function synchronizeFallbackGraphResilience(fallbackAgent, primaryAgent, readinessRecords = []) {
  if (!fallbackAgent || !primaryAgent) {
    return false;
  }
  if (Array.isArray(primaryAgent.edges)) {
    fallbackAgent.edges = primaryAgent.edges.map((edge) =>
      edge && typeof edge === 'object' ? { ...edge } : edge,
    );
  } else {
    fallbackAgent.edges = primaryAgent.edges;
  }
  appendOmittedCapabilityReadiness(fallbackAgent, readinessRecords);
  return true;
}

module.exports = {
  appendOmittedCapabilityReadiness,
  declaredMcpServerNames,
  evaluateOptionalAgentCapabilityReadiness,
  markOptionalAgentInitializationFailed,
  synchronizeFallbackGraphResilience,
};
