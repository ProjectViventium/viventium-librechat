/* === VIVENTIUM START ===
 * Feature: Per-user connected-account credential policy.
 * Purpose: Share one provider-scoped policy contract between Account Settings and endpoint auth.
 * === VIVENTIUM END === */
export const connectedAccountCredentialPolicies = [
  'personal_preferred',
  'personal_required',
] as const;

export type ConnectedAccountCredentialPolicy = (typeof connectedAccountCredentialPolicies)[number];
export type ConnectedAccountProvider = 'openai' | 'anthropic';

export const DEFAULT_CONNECTED_ACCOUNT_CREDENTIAL_POLICY: ConnectedAccountCredentialPolicy =
  'personal_preferred';

export function connectedAccountCredentialPolicyKey(provider: ConnectedAccountProvider): string {
  return `viventium:connected-account-policy:${provider}`;
}

export function normalizeConnectedAccountCredentialPolicy(
  value: unknown,
): ConnectedAccountCredentialPolicy {
  if (value == null) {
    return DEFAULT_CONNECTED_ACCOUNT_CREDENTIAL_POLICY;
  }
  if (connectedAccountCredentialPolicies.includes(value as ConnectedAccountCredentialPolicy)) {
    return value as ConnectedAccountCredentialPolicy;
  }
  throw new Error('Invalid connected-account credential policy');
}
