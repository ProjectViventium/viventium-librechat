'use strict';

const {
  resolveAgentCapabilityProvider,
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
