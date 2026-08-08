/* === VIVENTIUM START ===
 * Feature: Per-user connected-account credential policy regression tests.
 * === VIVENTIUM END === */
import {
  normalizeConnectedAccountCredentialPolicy,
  DEFAULT_CONNECTED_ACCOUNT_CREDENTIAL_POLICY,
} from './connectedAccounts';

describe('normalizeConnectedAccountCredentialPolicy', () => {
  it('defaults only when no saved value exists', () => {
    expect(normalizeConnectedAccountCredentialPolicy(undefined)).toBe(
      DEFAULT_CONNECTED_ACCOUNT_CREDENTIAL_POLICY,
    );
    expect(normalizeConnectedAccountCredentialPolicy(null)).toBe(
      DEFAULT_CONNECTED_ACCOUNT_CREDENTIAL_POLICY,
    );
  });

  it('preserves valid values and rejects corrupt stored policy state', () => {
    expect(normalizeConnectedAccountCredentialPolicy('personal_preferred')).toBe(
      'personal_preferred',
    );
    expect(normalizeConnectedAccountCredentialPolicy('personal_required')).toBe(
      'personal_required',
    );
    expect(() => normalizeConnectedAccountCredentialPolicy('')).toThrow(
      'Invalid connected-account credential policy',
    );
    expect(() => normalizeConnectedAccountCredentialPolicy('unexpected-policy')).toThrow(
      'Invalid connected-account credential policy',
    );
  });
});
