const { isConnectedAccountsCapabilityEnabled } = require('../connectedAccountsCapability');

describe('isConnectedAccountsCapabilityEnabled', () => {
  it('enables the browser setup surface through the secret-free Native capability flag', () => {
    expect(
      isConnectedAccountsCapabilityEnabled({
        VIVENTIUM_CONNECTED_ACCOUNTS_ENABLED: 'true',
      }),
    ).toBe(true);
  });

  it('preserves the existing source and Docker activation signals', () => {
    expect(
      isConnectedAccountsCapabilityEnabled({
        VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH: 'true',
      }),
    ).toBe(true);
    expect(isConnectedAccountsCapabilityEnabled({ OPENAI_API_KEY: 'user_provided' })).toBe(true);
    expect(isConnectedAccountsCapabilityEnabled({ ANTHROPIC_API_KEY: 'user_provided' })).toBe(true);
  });

  it('does not enable the surface from provider secrets or false capability values', () => {
    expect(
      isConnectedAccountsCapabilityEnabled({
        VIVENTIUM_CONNECTED_ACCOUNTS_ENABLED: 'false',
        VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH: 'true',
        ANTHROPIC_API_KEY: 'user_provided',
        OPENAI_API_KEY: 'synthetic-secret-value',
      }),
    ).toBe(false);
  });
});
