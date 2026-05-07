/* === VIVENTIUM START ===
 * Feature: OpenAI connected-account OAuth refresh.
 * Purpose:
 * - Viventium can use an OpenAI/ChatGPT connected account as the model credential.
 * - Those access tokens expire even though the stored user key is intentionally kept
 *   as a non-expiring connected-account record.
 * - Refresh before endpoint initialization so UI/API/voice/Telegram all share the
 *   same durable credential behavior.
 * === VIVENTIUM END === */
import { logger } from '@librechat/data-schemas';
import { EModelEndpoint } from 'librechat-data-provider';
import type { EndpointDbMethods, UserKeyValues } from '~/types';

const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const OPENAI_OAUTH_REFRESH_BUFFER_MS = 5 * 60 * 1000;

const nonExpiringPersistenceCache = new Set<string>();

type OpenAISubscriptionUserValues = UserKeyValues & {
  oauthProvider: 'openai-codex';
  oauthType?: 'subscription';
};

type OAuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

function isOpenAISubscriptionUserValues(
  userValues: UserKeyValues | null | undefined,
): userValues is OpenAISubscriptionUserValues {
  return userValues?.oauthProvider === 'openai-codex';
}

function getTokenUrl(): string {
  return process.env.VIVENTIUM_OPENAI_OAUTH_TOKEN_URL || OPENAI_TOKEN_URL;
}

function getClientId(): string {
  return process.env.VIVENTIUM_OPENAI_OAUTH_CLIENT_ID || OPENAI_CODEX_CLIENT_ID;
}

function getOpenAIOAuthOriginator(): string {
  return process.env.VIVENTIUM_OPENAI_OAUTH_ORIGINATOR || 'pi';
}

function getOpenAICodexBaseURL(): string {
  return process.env.VIVENTIUM_OPENAI_CODEX_BASE_URL || OPENAI_CODEX_BASE_URL;
}

function parseJWTPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    return null;
  }

  const payload = parts[1]
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(parts[1].length / 4) * 4, '=');

  try {
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractOpenAIAccountId(accessToken: string): string | null {
  const payload = parseJWTPayload(accessToken);
  const auth = payload?.['https://api.openai.com/auth'];
  const accountId =
    auth && typeof auth === 'object'
      ? (auth as Record<string, unknown>).chatgpt_account_id
      : null;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
}

function shouldRefresh(userValues: OpenAISubscriptionUserValues): boolean {
  if (!userValues.apiKey) {
    return true;
  }

  if (typeof userValues.oauthExpiresAt !== 'number' || !Number.isFinite(userValues.oauthExpiresAt)) {
    return false;
  }

  return userValues.oauthExpiresAt <= Date.now() + OPENAI_OAUTH_REFRESH_BUFFER_MS;
}

function buildPersistenceCacheKey(userId: string, userValues: OpenAISubscriptionUserValues): string {
  const tokenSuffix = (userValues.apiKey || '').slice(-12) || 'no-token';
  return [
    userId,
    userValues.oauthProvider,
    userValues.oauthType ?? 'no-type',
    String(userValues.oauthExpiresAt ?? 'no-expiry'),
    tokenSuffix,
  ].join(':');
}

async function persistNonExpiringKey(
  userId: string,
  userValues: OpenAISubscriptionUserValues,
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
    name: EModelEndpoint.openAI,
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
    logger.warn('[OpenAI OAuth] Failed to parse refresh token response body', error);
    return {
      error: `unexpected_response_${response.status}`,
      error_description: bodyText.slice(0, 500),
    };
  }
}

async function refreshAccessToken(
  userId: string,
  userValues: OpenAISubscriptionUserValues,
  db: EndpointDbMethods,
): Promise<OpenAISubscriptionUserValues> {
  if (!userValues.refreshToken) {
    throw new Error(
      'OpenAI connected account needs reconnect in Settings > Account > Connected Accounts.',
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
    throw new Error(`OpenAI connected account refresh failed: ${details}`);
  }

  const accountId = extractOpenAIAccountId(tokenData.access_token);
  const headers: Record<string, string> = {
    ...(userValues.headers ?? {}),
    'OpenAI-Beta': 'responses=experimental',
    originator: getOpenAIOAuthOriginator(),
  };
  if (accountId) {
    headers['chatgpt-account-id'] = accountId;
  }

  const refreshedValues: OpenAISubscriptionUserValues = {
    ...userValues,
    apiKey: tokenData.access_token,
    baseURL: userValues.baseURL || getOpenAICodexBaseURL(),
    headers,
    accountId: accountId ?? userValues.accountId,
    oauthProvider: 'openai-codex',
    oauthType: 'subscription',
    oauthExpiresAt:
      Date.now() +
      (typeof tokenData.expires_in === 'number' && Number.isFinite(tokenData.expires_in)
        ? tokenData.expires_in
        : 3600) *
        1000,
    refreshToken: tokenData.refresh_token ?? userValues.refreshToken,
  };

  await persistNonExpiringKey(userId, refreshedValues, db);
  return refreshedValues;
}

export async function resolveOpenAISubscriptionUserValues(
  userId: string,
  userValues: UserKeyValues | null | undefined,
  db: EndpointDbMethods,
): Promise<UserKeyValues | null> {
  if (!isOpenAISubscriptionUserValues(userValues)) {
    return userValues ?? null;
  }

  if (shouldRefresh(userValues)) {
    try {
      return await refreshAccessToken(userId, userValues, db);
    } catch (error) {
      logger.warn('[OpenAI OAuth] Refresh failed for connected account', error);
      throw new Error(
        'OpenAI connected account needs reconnect in Settings > Account > Connected Accounts.',
      );
    }
  }

  await persistNonExpiringKey(userId, userValues, db);
  return userValues;
}
