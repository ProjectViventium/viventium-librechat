/* === VIVENTIUM START ===
 * Feature: Optional agent-graph resilience regression coverage.
 * Purpose: Prove failed optional agents are removed without corrupting healthy handoff edges.
 * === VIVENTIUM END === */

const { filterOrphanedEdges } = require('@librechat/api');
const { markOptionalAgentInitializationFailed } = require('../agentGraphResilience');

describe('optional agent graph resilience', () => {
  test('removes a handoff edge when its optional target fails initialization', () => {
    const failedAgentIds = new Set();
    const edges = [
      { from: 'main', to: 'connected-accounts' },
      { from: 'main', to: 'healthy-worker' },
    ];

    markOptionalAgentInitializationFailed(failedAgentIds, 'connected-accounts');

    expect(filterOrphanedEdges(edges, failedAgentIds)).toEqual([
      { from: 'main', to: 'healthy-worker' },
    ]);
  });

  test('rejects invalid failure bookkeeping instead of silently keeping a broken graph', () => {
    expect(() => markOptionalAgentInitializationFailed(null, 'connected-accounts')).toThrow(
      'skippedAgentIds must be a Set',
    );
    expect(() => markOptionalAgentInitializationFailed(new Set(), '')).toThrow(
      'agentId is required',
    );
  });
});
