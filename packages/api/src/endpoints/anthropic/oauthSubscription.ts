import { logger } from '@librechat/data-schemas';
import { EModelEndpoint } from 'librechat-data-provider';
import type { EndpointDbMethods, UserKeyValues } from '~/types';

const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-' + '88ed-5944d1962f5e';
const ANTHROPIC_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const ANTHROPIC_OAUTH_REFRESH_BUFFER_MS = 5 * 60 * 1000;

const nonExpiringPersistenceCache = new Set<string>();

type AnthropicSubscriptionUserValues = UserKeyValues & {
  oauthProvider: 'anthropic';
  oauthType: 'subscription';
};

type OAuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

function isAnthropicSubscriptionUserValues(
  userValues: UserKeyValues | null | undefined,
): userValues is AnthropicSubscriptionUserValues {
  return userValues?.oauthProvider === 'anthropic' && userValues?.oauthType === 'subscription';
}

function buildPersistenceCacheKey(userId: string, userValues: AnthropicSubscriptionUserValues): string {
  const tokenSuffix = (userValues.authToken || userValues.apiKey || '').slice(-12) || 'no-token';
  return [
    userId,
    userValues.oauthProvider,
    userValues.oauthType,
    String(userValues.oauthExpiresAt ?? 'no-expiry'),
    tokenSuffix,
  ].join(':');
}

function getTokenUrl(): string {
  return process.env.VIVENTIUM_ANTHROPIC_OAUTH_TOKEN_URL || ANTHROPIC_OAUTH_TOKEN_URL;
}

function getClientId(): string {
  return process.env.VIVENTIUM_ANTHROPIC_OAUTH_CLIENT_ID || ANTHROPIC_OAUTH_CLIENT_ID;
}

function shouldRefresh(userValues: AnthropicSubscriptionUserValues): boolean {
  if (!userValues.authToken && !userValues.apiKey) {
    return true;
  }

  if (typeof userValues.oauthExpiresAt !== 'number' || !Number.isFinite(userValues.oauthExpiresAt)) {
    return false;
  }

  return userValues.oauthExpiresAt <= Date.now() + ANTHROPIC_OAUTH_REFRESH_BUFFER_MS;
}

async function persistNonExpiringKey(
  userId: string,
  userValues: AnthropicSubscriptionUserValues,
  db: EndpointDbMethods,
): Promise<void> {
  if (!db.updateUserKey) {
    return;
  }

  const cacheKey = buildPersistenceCacheKey(userId, userValues);
  if (nonExpiringPersistenceCache.has(cacheKey)) {
    return;
  }

  await db.updateUserKey({
    userId,
    name: EModelEndpoint.anthropic,
    value: JSON.stringify(userValues),
    expiresAt: null,
  });
  nonExpiringPersistenceCache.add(cacheKey);
}

async function parseTokenResponse(response: Response): Promise<OAuthTokenResponse> {
  const bodyText = await response.text();
  if (!bodyText) {
    return {};
  }

  try {
    return JSON.parse(bodyText) as OAuthTokenResponse;
  } catch (error) {
    logger.warn('[Anthropic OAuth] Failed to parse refresh token response body', error);
    return {
      error: `unexpected_response_${response.status}`,
      error_description: bodyText.slice(0, 500),
    };
  }
}

async function refreshAccessToken(
  userId: string,
  userValues: AnthropicSubscriptionUserValues,
  db: EndpointDbMethods,
): Promise<AnthropicSubscriptionUserValues> {
  if (!userValues.refreshToken) {
    throw new Error(
      'Anthropic connected account refresh failed: stored subscription credential is missing a refresh token.',
    );
  }

  const response = await fetch(getTokenUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: getClientId(),
      refresh_token: userValues.refreshToken,
    }),
  });

  const tokenData = await parseTokenResponse(response);

  if (!response.ok || typeof tokenData.access_token !== 'string' || tokenData.access_token.length === 0) {
    const details =
      tokenData.error_description || tokenData.error || `HTTP ${response.status} ${response.statusText}`;
    throw new Error(`Anthropic connected account refresh failed: ${details}`);
  }

  const refreshedValues: AnthropicSubscriptionUserValues = {
    ...userValues,
    apiKey: tokenData.access_token,
    authToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token ?? userValues.refreshToken,
    oauthExpiresAt:
      Date.now() +
      (typeof tokenData.expires_in === 'number' && Number.isFinite(tokenData.expires_in)
        ? tokenData.expires_in
        : 3600) *
        1000,
  };

  await persistNonExpiringKey(userId, refreshedValues, db);
  return refreshedValues;
}

const VIV_FAILED_REFRESH_TTL_MS = 60 * 1000;
const vivRefreshFailureCache = new Map<string, number>();
const vivInFlightBackgroundRefresh = new Set<string>();

/* === VIVENTIUM START ===
 * Feature: Connected-account Anthropic OAuth fast path (non-blocking refresh + negative cache).
 * Purpose: Keep subscription-token refresh off the chat critical path. A still-valid (near-expiry)
 * token is used immediately while a background refresh updates it for the next turn; an expired or
 * missing token is refreshed at most once per failure TTL so a broken refresh_token cannot fan out
 * into multiple blocking failing fetches across main + cortex inits (the observed multi-second spike).
 * Revert to the original blocking behavior with VIVENTIUM_ANTHROPIC_OAUTH_FAST_PATH=0.
 * Added: 2026-05-29
 * === VIVENTIUM END === */
function isOAuthFastPathEnabled(): boolean {
  const raw = process.env.VIVENTIUM_ANTHROPIC_OAUTH_FAST_PATH;
  if (raw == null || raw === '') {
    return true;
  }
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

function isRefreshNegativeCached(cacheKey: string): boolean {
  const retryAfter = vivRefreshFailureCache.get(cacheKey);
  if (retryAfter == null) {
    return false;
  }
  if (retryAfter <= Date.now()) {
    vivRefreshFailureCache.delete(cacheKey);
    return false;
  }
  return true;
}

function scheduleBackgroundRefresh(
  cacheKey: string,
  userId: string,
  userValues: AnthropicSubscriptionUserValues,
  db: EndpointDbMethods,
): void {
  if (vivInFlightBackgroundRefresh.has(cacheKey) || isRefreshNegativeCached(cacheKey)) {
    return;
  }
  vivInFlightBackgroundRefresh.add(cacheKey);
  Promise.resolve()
    .then(() => refreshAccessToken(userId, userValues, db))
    .then(() => {
      vivRefreshFailureCache.delete(cacheKey);
    })
    .catch((error) => {
      vivRefreshFailureCache.set(cacheKey, Date.now() + VIV_FAILED_REFRESH_TTL_MS);
      logger.warn('[Anthropic OAuth] Background refresh failed; will retry after TTL', error);
    })
    .finally(() => {
      vivInFlightBackgroundRefresh.delete(cacheKey);
    });
}

export async function resolveAnthropicSubscriptionUserValues(
  userId: string,
  userValues: UserKeyValues | null | undefined,
  db: EndpointDbMethods,
): Promise<UserKeyValues | null> {
  if (!isAnthropicSubscriptionUserValues(userValues)) {
    return userValues ?? null;
  }

  if (isOAuthFastPathEnabled()) {
    const cacheKey = buildPersistenceCacheKey(userId, userValues);
    const hasToken = Boolean(userValues.authToken || userValues.apiKey);
    const expired =
      typeof userValues.oauthExpiresAt === 'number' &&
      Number.isFinite(userValues.oauthExpiresAt) &&
      userValues.oauthExpiresAt <= Date.now();

    if (!hasToken || expired) {
      // Cannot proceed on a missing/expired token; refresh synchronously, but at most once per
      // failure TTL so a broken refresh_token does not stall every agent init in the turn.
      if (isRefreshNegativeCached(cacheKey)) {
        // Preserve the current token (legacy contract); the persistence cache makes repeat
        // writes within the turn no-ops, so this does not reintroduce the fan-out cost.
        await persistNonExpiringKey(userId, userValues, db);
        return userValues;
      }
      try {
        const refreshed = await refreshAccessToken(userId, userValues, db);
        vivRefreshFailureCache.delete(cacheKey);
        return refreshed;
      } catch (error) {
        vivRefreshFailureCache.set(cacheKey, Date.now() + VIV_FAILED_REFRESH_TTL_MS);
        logger.warn(
          '[Anthropic OAuth] Refresh failed for connected account; preserving current access token',
          error,
        );
        await persistNonExpiringKey(userId, userValues, db);
        return userValues;
      }
    }

    if (shouldRefresh(userValues)) {
      // Near-expiry but valid: use the current token now, refresh for the next turn off-path.
      scheduleBackgroundRefresh(cacheKey, userId, userValues, db);
    }

    await persistNonExpiringKey(userId, userValues, db);
    return userValues;
  }

  // Legacy blocking behavior (VIVENTIUM_ANTHROPIC_OAUTH_FAST_PATH=0)
  if (shouldRefresh(userValues)) {
    try {
      return await refreshAccessToken(userId, userValues, db);
    } catch (error) {
      logger.warn(
        '[Anthropic OAuth] Refresh failed for connected account; preserving current access token',
        error,
      );
    }
  }

  await persistNonExpiringKey(userId, userValues, db);
  return userValues;
}
