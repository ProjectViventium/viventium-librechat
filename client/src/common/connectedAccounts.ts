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
