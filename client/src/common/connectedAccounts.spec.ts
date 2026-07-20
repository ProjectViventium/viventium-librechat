/**
 * === VIVENTIUM START ===
 * Feature: Easy Install connected-account handoff regression coverage.
 * Purpose: Keep account setup scoped to the explicit internal express-install route.
 * === VIVENTIUM END ===
 */

import {
  connectedAccountsSetupCleanUrl,
  isConnectedAccountsSetupDestination,
  shouldOpenConnectedAccountsSetup,
  shouldResumeConnectedAccountsSetup,
} from './connectedAccounts';

describe('shouldOpenConnectedAccountsSetup', () => {
  it('opens only for the explicit Easy Install account-setup handoff', () => {
    expect(shouldOpenConnectedAccountsSetup('express', '?setup=accounts')).toBe(true);
    expect(shouldOpenConnectedAccountsSetup('express', '?setup=other')).toBe(false);
    expect(shouldOpenConnectedAccountsSetup('custom', '?setup=accounts')).toBe(false);
    expect(shouldOpenConnectedAccountsSetup(undefined, '?setup=accounts')).toBe(false);
  });

  it('removes only the consumed setup intent without navigating away or dropping other URL state', () => {
    expect(
      connectedAccountsSetupCleanUrl({
        hash: '#focus',
        pathname: '/c/new',
        search: '?setup=accounts&source=installer',
      }),
    ).toBe('/c/new?source=installer#focus');
  });

  it('keeps Easy Install setup resumable across an authenticated-shell remount until dismissed', () => {
    expect(shouldResumeConnectedAccountsSetup('express', '?setup=accounts', false)).toBe(true);
    expect(shouldResumeConnectedAccountsSetup('express', '', true)).toBe(true);
    expect(shouldResumeConnectedAccountsSetup('express', '', false)).toBe(false);
    expect(shouldResumeConnectedAccountsSetup('custom', '?setup=accounts', true)).toBe(false);
  });

  it('recognizes only the internal new-chat Connected Accounts destination', () => {
    expect(isConnectedAccountsSetupDestination('/c/new?setup=accounts')).toBe(true);
    expect(isConnectedAccountsSetupDestination('/c/new?source=installer&setup=accounts')).toBe(true);
    expect(isConnectedAccountsSetupDestination('/c/other?setup=accounts')).toBe(false);
    expect(isConnectedAccountsSetupDestination('//example.invalid/c/new?setup=accounts')).toBe(false);
    expect(isConnectedAccountsSetupDestination(null)).toBe(false);
  });
});
