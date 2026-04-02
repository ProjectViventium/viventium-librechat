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

export async function resolveAnthropicSubscriptionUserValues(
  userId: string,
  userValues: UserKeyValues | null | undefined,
  db: EndpointDbMethods,
): Promise<UserKeyValues | null> {
  if (!isAnthropicSubscriptionUserValues(userValues)) {
    return userValues ?? null;
  }

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
