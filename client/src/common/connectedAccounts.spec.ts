import { removeSetupParamFromUrl, shouldOpenConnectedAccountsSetup } from './connectedAccounts';

describe('shouldOpenConnectedAccountsSetup', () => {
  it('opens only for the explicit Express account-setup handoff', () => {
    expect(shouldOpenConnectedAccountsSetup('express', '?setup=accounts')).toBe(true);
    expect(shouldOpenConnectedAccountsSetup('express', '?setup=other')).toBe(false);
    expect(shouldOpenConnectedAccountsSetup('custom', '?setup=accounts')).toBe(false);
    expect(shouldOpenConnectedAccountsSetup(undefined, '?setup=accounts')).toBe(false);
  });

  it('removes only the consumed setup handoff without navigating the router', () => {
    expect(removeSetupParamFromUrl('/c/new', '?setup=whoop&theme=dark', '#health')).toBe(
      '/c/new?theme=dark#health',
    );
    expect(removeSetupParamFromUrl('/c/new', '?setup=accounts', '')).toBe('/c/new');
  });
});
