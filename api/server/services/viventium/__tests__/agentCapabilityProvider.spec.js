'use strict';

const {
  resolveAgentCapabilityProvider,
  selectLibreChatAgentGraph,
} = require('~/server/services/viventium/agentCapabilityProvider');

describe('resolveAgentCapabilityProvider', () => {
  it('preserves a declared custom endpoint after transport adaptation', () => {
    expect(
      resolveAgentCapabilityProvider({
        endpoint: 'glasshive-harness',
        provider: 'openAI',
      }),
    ).toBe('glasshive-harness');
  });

  it('uses the provider for a direct route or pre-start fallback', () => {
    expect(resolveAgentCapabilityProvider({ provider: 'anthropic' })).toBe('anthropic');
  });

  it('fails closed to an empty identifier when no route is present', () => {
    expect(resolveAgentCapabilityProvider({})).toBe('');
  });
});

describe('selectLibreChatAgentGraph', () => {
  it('omits LibreChat handoff graph tools when the provider owns native tools', () => {
    const agentIds = ['handoff-agent'];
    const edges = [{ from: 'main', to: 'handoff-agent', edgeType: 'handoff' }];

    expect(
      selectLibreChatAgentGraph({
        agentIds,
        edges,
        capability: { native_tools: true },
      }),
    ).toEqual({ agentIds: [], edges: [] });
    expect(agentIds).toEqual(['handoff-agent']);
    expect(edges).toHaveLength(1);
  });

  it('preserves the normal graph for direct and non-native providers', () => {
    const agentIds = ['handoff-agent'];
    const edges = [{ from: 'main', to: 'handoff-agent', edgeType: 'handoff' }];

    expect(selectLibreChatAgentGraph({ agentIds, edges, capability: {} })).toEqual({
      agentIds,
      edges,
    });
  });
});
