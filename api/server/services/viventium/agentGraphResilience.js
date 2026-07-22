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

module.exports = { markOptionalAgentInitializationFailed };
