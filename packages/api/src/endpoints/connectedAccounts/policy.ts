/* === VIVENTIUM START ===
 * Feature: Per-user connected-account credential policy.
 * Purpose: Resolve an explicit personal-only opt-out without changing default platform fallback.
 * === VIVENTIUM END === */
import {
  ErrorTypes,
  connectedAccountCredentialPolicyKey,
  normalizeConnectedAccountCredentialPolicy,
} from 'librechat-data-provider';
import type {
  ConnectedAccountCredentialPolicy,
  ConnectedAccountProvider,
} from 'librechat-data-provider';
import type { EndpointDbMethods } from '~/types';

function isNoUserKeyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  try {
    const parsed = JSON.parse(error.message) as { type?: string };
    return parsed.type === ErrorTypes.NO_USER_KEY;
  } catch {
    return false;
  }
}

export async function resolveConnectedAccountCredentialPolicy({
  userId,
  provider,
  db,
}: {
  userId: string;
  provider: ConnectedAccountProvider;
  db: Pick<EndpointDbMethods, 'getUserKey'>;
}): Promise<ConnectedAccountCredentialPolicy> {
  try {
    const value = await db.getUserKey({
      userId,
      name: connectedAccountCredentialPolicyKey(provider),
    });
    return normalizeConnectedAccountCredentialPolicy(value);
  } catch (error) {
    if (isNoUserKeyError(error)) {
      return normalizeConnectedAccountCredentialPolicy(undefined);
    }
    throw error;
  }
}
