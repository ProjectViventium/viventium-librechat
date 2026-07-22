/* === VIVENTIUM START ===
 * Feature: Connected Accounts shared event/storage keys.
 * Purpose: Coordinate OAuth manual-code flows across model selector and account settings.
 * === VIVENTIUM END === */
export type ConnectedAccountProviderSlug = 'openai' | 'anthropic';

export type ConnectedAccountsManualFlowDetail = {
  provider: ConnectedAccountProviderSlug;
  state?: string;
};

export const CONNECTED_ACCOUNTS_OPEN_EVENT = 'viventium:open-connected-accounts';
export const CONNECTED_ACCOUNTS_MANUAL_FLOW_EVENT = 'viventium:connected-accounts-manual-flow';
export const CONNECTED_ACCOUNTS_MANUAL_FLOW_STORAGE_KEY =
  'viventium:connected-accounts:manual-flow';

export function shouldOpenConnectedAccountsSetup(
  installExperience: string | undefined,
  search: string,
): boolean {
  if (installExperience !== 'express') {
    return false;
  }
  return new URLSearchParams(search).get('setup') === 'accounts';
}

/* === VIVENTIUM START ===
 * Feature: Deterministic Easy Install account handoff.
 * Purpose: Consume only the internal setup intent without a router navigation that remounts and closes Settings.
 */
export function connectedAccountsSetupCleanUrl(location: {
  hash: string;
  pathname: string;
  search: string;
}): string {
  const nextSearch = new URLSearchParams(location.search);
  nextSearch.delete('setup');
  const search = nextSearch.toString();
  return `${location.pathname}${search ? `?${search}` : ''}${location.hash}`;
}
/* === VIVENTIUM END === */

/* === VIVENTIUM START ===
 * Feature: Remount-safe Easy Install account handoff.
 * Purpose: The authenticated shell can remount after login; preserve the setup intent until the user dismisses it.
 */
export const CONNECTED_ACCOUNTS_SETUP_PENDING_KEY = 'viventium:connected-accounts-setup-pending';

export function isConnectedAccountsSetupDestination(target: string | null): boolean {
  if (target == null || !target.startsWith('/') || target.startsWith('//')) {
    return false;
  }

  const destination = new URL(target, 'https://viventium.invalid');
  return destination.pathname === '/c/new' && destination.searchParams.get('setup') === 'accounts';
}

export function shouldResumeConnectedAccountsSetup(
  installExperience: string | null | undefined,
  search: string,
  pending: boolean,
): boolean {
  return (
    installExperience === 'express' &&
    (pending || shouldOpenConnectedAccountsSetup(installExperience, search))
  );
}
/* === VIVENTIUM END === */
