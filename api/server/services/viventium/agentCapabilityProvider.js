'use strict';

/* === VIVENTIUM START ===
 * Feature: Declared-provider capability ownership.
 * Purpose: Custom endpoint initialization may adapt `provider` to an internal transport while
 * preserving the user-selected provider on `endpoint`. Capability policy belongs to the declared
 * endpoint; direct providers fall back to their provider value.
 * === VIVENTIUM END === */

function resolveAgentCapabilityProvider(agent) {
  return String(agent?.endpoint || agent?.provider || '').trim();
}

function selectLibreChatAgentGraph({ agentIds, edges, capability } = {}) {
  if (capability?.worker_native_tools === true || capability?.native_tools === true) {
    return { agentIds: [], edges: [] };
  }
  return { agentIds, edges };
}

module.exports = { resolveAgentCapabilityProvider, selectLibreChatAgentGraph };
