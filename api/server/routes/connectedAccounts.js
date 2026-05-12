const crypto = require('crypto');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const { logger } = require('@librechat/data-schemas');
const { EModelEndpoint } = require('librechat-data-provider');
const { getBasePath, isEnabled } = require('@librechat/api');
const { updateUserKey } = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();
const OAUTH_STATE_TTL_SECONDS = 30 * 60;
const TOKEN_EXPIRY_BUFFER_SECONDS = 60;
const OPENAI_LOCAL_CALLBACK_HOST = '127.0.0.1';
const OPENAI_LOCAL_CALLBACK_PORT = 1455;
const OPENAI_LOCAL_CALLBACK_PATH = '/auth/callback';
const OPENAI_LOCAL_REDIRECT_URI = `http://localhost:${OPENAI_LOCAL_CALLBACK_PORT}${OPENAI_LOCAL_CALLBACK_PATH}`;
const ANTHROPIC_MANUAL_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const ANTHROPIC_PENDING_STATE_TTL_MS = OAUTH_STATE_TTL_SECONDS * 1000;

const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OPENAI_SCOPES = 'openid profile email offline_access';
const ANTHROPIC_SCOPES = 'user:inference';

const OPENAI_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const ANTHROPIC_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const ANTHROPIC_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CONNECTED_ACCOUNT_FLOW_MODES = Object.freeze({
  popupCallback: 'popup_callback',
  manualCode: 'manual_code',
});
/* === VIVENTIUM START ===
 * Feature: Configurable connected-account OAuth browser return origin.
 * Purpose: Keep production public-origin behavior as the default while allowing local/off-network
 * operator QA to return OAuth completion pages to a localhost browser without mutating DOMAIN_SERVER.
 * === VIVENTIUM END === */
const CONNECTED_ACCOUNTS_RETURN_ORIGIN_ENV = 'VIVENTIUM_CONNECTED_ACCOUNTS_RETURN_ORIGIN';

let openAILocalCallbackServerPromise;
let openAILocalCallbackServerStatus;
const pendingAnthropicStates = new Map();

class OAuthFlowError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function isSupportedProvider(provider) {
  return provider === 'openai' || provider === 'anthropic';
}

function isConnectedAccountsEnabled() {
  return isEnabled(process.env.VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH);
}

function shouldForceOpenAIManualMode() {
  /* === VIVENTIUM START ===
   * Purpose: Backend unit tests run under NODE_ENV=CI on GitHub. CI is
   * non-interactive and must not start the localhost OAuth callback listener.
   * === VIVENTIUM END === */
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.NODE_ENV === 'CI' ||
    isEnabled(process.env.VIVENTIUM_OPENAI_LOCAL_CALLBACK_MANUAL_ONLY)
  );
}

function getProviderDisplayName(provider) {
  return provider === 'openai' ? 'OpenAI' : 'Anthropic';
}

function getProviderEndpoint(provider) {
  return provider === 'openai' ? EModelEndpoint.openAI : EModelEndpoint.anthropic;
}

function getJWTSecret() {
  return process.env.JWT_SECRET;
}

function getDefaultConnectedAccountsOrigin() {
  return (process.env.DOMAIN_SERVER || 'http://localhost:3080').replace(/\/+$/, '');
}

function getServerOrigin(req) {
  /* === VIVENTIUM START ===
   * Feature: Configurable connected-account OAuth browser return origin.
   * Purpose: Use an explicit browser return override only when configured; otherwise preserve
   * existing DOMAIN_SERVER/request-host behavior.
   * === VIVENTIUM END === */
  const configuredReturnOrigin = process.env[CONNECTED_ACCOUNTS_RETURN_ORIGIN_ENV];
  if (configuredReturnOrigin && configuredReturnOrigin.trim()) {
    return configuredReturnOrigin.trim().replace(/\/+$/, '');
  }
  if (process.env.DOMAIN_SERVER) {
    return process.env.DOMAIN_SERVER.replace(/\/+$/, '');
  }
  return `${req.protocol}://${req.get('host')}`;
}

function getOpenAICallbackRedirectUri() {
  return OPENAI_LOCAL_REDIRECT_URI;
}

function getAnthropicRedirectUri() {
  return process.env.VIVENTIUM_ANTHROPIC_OAUTH_REDIRECT_URI || ANTHROPIC_MANUAL_REDIRECT_URI;
}

function getOpenAIOAuthOriginator() {
  return process.env.VIVENTIUM_OPENAI_OAUTH_ORIGINATOR || 'pi';
}

function base64UrlEncode(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function createPKCE() {
  const verifier = base64UrlEncode(crypto.randomBytes(64));
  const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function createOAuthState({ provider, userId, codeVerifier, redirectUri, serverOrigin, secret }) {
  return jwt.sign(
    {
      provider,
      userId,
      codeVerifier,
      redirectUri,
      serverOrigin,
      nonce: crypto.randomUUID(),
    },
    secret,
    { expiresIn: OAUTH_STATE_TTL_SECONDS },
  );
}

function purgePendingAnthropicStates() {
  const now = Date.now();
  for (const [state, entry] of pendingAnthropicStates.entries()) {
    if (!entry || typeof entry.expiresAt !== 'number' || entry.expiresAt <= now) {
      pendingAnthropicStates.delete(state);
    }
  }
}

function setPendingAnthropicState({ state, userId, codeVerifier, redirectUri, serverOrigin }) {
  purgePendingAnthropicStates();
  pendingAnthropicStates.set(state, {
    provider: 'anthropic',
    userId,
    codeVerifier,
    redirectUri,
    serverOrigin,
    expiresAt: Date.now() + ANTHROPIC_PENDING_STATE_TTL_MS,
  });
}

function getPendingAnthropicState(state) {
  if (typeof state !== 'string' || state.length === 0) {
    return null;
  }
  purgePendingAnthropicStates();
  const entry = pendingAnthropicStates.get(state);
  return entry ?? null;
}

function deletePendingAnthropicState(state) {
  if (typeof state === 'string' && state.length > 0) {
    pendingAnthropicStates.delete(state);
  }
}

function parseJWTPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    return null;
  }

  const payload = parts[1]
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(parts[1].length / 4) * 4, '=');

  try {
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function extractOpenAIAccountId(accessToken) {
  const payload = parseJWTPayload(accessToken);
  const accountId = payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
}

function decodeOAuthState(token) {
  const decoded = jwt.decode(token);
  return decoded && typeof decoded === 'object' ? decoded : null;
}

function toAbsolutePath(serverOrigin, pathOrUrl) {
  if (!pathOrUrl) {
    return serverOrigin;
  }
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }
  const prefix = pathOrUrl.startsWith('/') ? '' : '/';
  return `${serverOrigin}${prefix}${pathOrUrl}`;
}

function normalizeAuthorizationCode(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\s+/g, '');
}

function normalizeOAuthState(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseAuthorizationInput(input) {
  const value = String(input ?? '').trim();
  if (!value) {
    return {};
  }

  try {
    const url = new URL(value);
    return {
      code: normalizeAuthorizationCode(url.searchParams.get('code') ?? undefined),
      state: normalizeOAuthState(url.searchParams.get('state') ?? undefined),
    };
  } catch {
    // Input may be code#state or raw query string.
  }

  if (value.includes('#')) {
    const [code, state] = value.split('#', 2);
    return {
      code: normalizeAuthorizationCode(code || undefined),
      state: normalizeOAuthState(state || undefined),
    };
  }

  if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    return {
      code: normalizeAuthorizationCode(params.get('code') ?? undefined),
      state: normalizeOAuthState(params.get('state') ?? undefined),
    };
  }

  return { code: normalizeAuthorizationCode(value) };
}

function getProviderCodeAndState(payload) {
  let code = normalizeAuthorizationCode(payload?.code);
  let state = normalizeOAuthState(payload?.state);

  if (typeof payload?.callbackInput === 'string') {
    const parsed = parseAuthorizationInput(payload.callbackInput);
    code = code ?? parsed.code;
    state = state ?? parsed.state;
  }

  return { code, state };
}

function getOpenAIAuthorizationUrl({ state, codeChallenge, redirectUri, originator }) {
  const url = new URL(OPENAI_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set(
    'client_id',
    process.env.VIVENTIUM_OPENAI_OAUTH_CLIENT_ID || OPENAI_CODEX_CLIENT_ID,
  );
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', OPENAI_SCOPES);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', originator);
  return url.toString();
}

function getAnthropicAuthorizationUrl({ state, codeChallenge, redirectUri }) {
  const url = new URL(ANTHROPIC_AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set(
    'client_id',
    process.env.VIVENTIUM_ANTHROPIC_OAUTH_CLIENT_ID || ANTHROPIC_CLIENT_ID,
  );
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', ANTHROPIC_SCOPES);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url.toString();
}

async function parseTokenResponse(response) {
  const bodyText = await response.text();
  let tokenData;

  try {
    tokenData = JSON.parse(bodyText);
  } catch {
    tokenData = null;
  }

  if (!response.ok) {
    throw new Error(
      `Token exchange failed with status ${response.status}: ${
        bodyText || JSON.stringify(tokenData ?? {})
      }`,
    );
  }

  if (!tokenData?.access_token || typeof tokenData.access_token !== 'string') {
    throw new Error('Token exchange response is missing access_token');
  }

  return tokenData;
}

async function exchangeOpenAICode({ code, codeVerifier, redirectUri }) {
  const tokenUrl = process.env.VIVENTIUM_OPENAI_OAUTH_TOKEN_URL || OPENAI_TOKEN_URL;
  const clientId = process.env.VIVENTIUM_OPENAI_OAUTH_CLIENT_ID || OPENAI_CODEX_CLIENT_ID;
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  });
  return parseTokenResponse(response);
}

async function exchangeAnthropicCode({ code, state, codeVerifier, redirectUri }) {
  const tokenUrl = process.env.VIVENTIUM_ANTHROPIC_OAUTH_TOKEN_URL || ANTHROPIC_TOKEN_URL;
  const clientId = process.env.VIVENTIUM_ANTHROPIC_OAUTH_CLIENT_ID || ANTHROPIC_CLIENT_ID;
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      state,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  return parseTokenResponse(response);
}

function getTokenExpiryDate(expiresIn) {
  const expiresInSeconds =
    typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
  return new Date(Date.now() + (expiresInSeconds - TOKEN_EXPIRY_BUFFER_SECONDS) * 1000);
}

function shouldPersistConnectedAccountWithoutExpiry(value) {
  return value?.oauthType === 'subscription';
}

function buildOpenAIUserValue(tokenData) {
  const accountId = extractOpenAIAccountId(tokenData.access_token);
  const headers = {
    'OpenAI-Beta': 'responses=experimental',
    originator: getOpenAIOAuthOriginator(),
  };

  if (accountId) {
    headers['chatgpt-account-id'] = accountId;
  }

  return {
    apiKey: tokenData.access_token,
    baseURL: process.env.VIVENTIUM_OPENAI_CODEX_BASE_URL || 'https://chatgpt.com/backend-api/codex',
    headers,
    accountId: accountId ?? undefined,
    oauthProvider: 'openai-codex',
    oauthType: 'subscription',
    oauthExpiresAt: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
    refreshToken: tokenData.refresh_token ?? undefined,
  };
}

function buildAnthropicUserValue(tokenData) {
  return {
    apiKey: tokenData.access_token,
    authToken: tokenData.access_token,
    oauthProvider: 'anthropic',
    oauthType: 'subscription',
    oauthExpiresAt: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
    refreshToken: tokenData.refresh_token ?? undefined,
  };
}

function successRedirect(provider, params = {}) {
  const basePath = getBasePath();
  const url = new URL(`${basePath}/oauth/success`, 'http://localhost');
  url.searchParams.set('serverName', getProviderDisplayName(provider));
  url.searchParams.set('provider', provider);

  Object.entries(params).forEach(([key, value]) => {
    if (value != null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  return `${basePath}/oauth/success?${url.searchParams.toString()}`;
}

function errorRedirect(errorCode, provider) {
  const basePath = getBasePath();
  const url = new URL(`${basePath}/oauth/error`, 'http://localhost');
  url.searchParams.set('error', errorCode);
  if (provider) {
    url.searchParams.set('provider', provider);
  }
  return `${basePath}/oauth/error?${url.searchParams.toString()}`;
}

function createOpenAICallbackUrl(provider, errorCode, state, params = {}) {
  const decoded = typeof state === 'string' ? decodeOAuthState(state) : null;
  const serverOrigin =
    typeof decoded?.serverOrigin === 'string'
      ? decoded.serverOrigin
      : getDefaultConnectedAccountsOrigin();
  const redirectPath =
    errorCode != null ? errorRedirect(errorCode, provider) : successRedirect(provider, params);
  return toAbsolutePath(serverOrigin, redirectPath);
}

async function completeConnectedAccount({ provider, code, state, secret, expectedUserId }) {
  if (!secret) {
    throw new OAuthFlowError(
      'callback_failed',
      'Missing JWT secret for OAuth state verification',
      500,
    );
  }

  if (typeof code !== 'string' || code.trim().length === 0) {
    throw new OAuthFlowError('missing_code', 'Missing authorization code');
  }

  if (typeof state !== 'string' || state.trim().length === 0) {
    throw new OAuthFlowError('missing_state', 'Missing OAuth state');
  }

  let decodedState = null;
  if (provider === 'anthropic') {
    decodedState = getPendingAnthropicState(state);
  }

  if (!decodedState) {
    try {
      decodedState = jwt.verify(state, secret);
    } catch (verifyError) {
      logger.error('[Connected Accounts] Invalid OAuth state', verifyError);
      throw new OAuthFlowError('invalid_state', 'Invalid OAuth state');
    }
  }

  if (
    decodedState?.provider !== provider ||
    typeof decodedState.userId !== 'string' ||
    typeof decodedState.codeVerifier !== 'string' ||
    typeof decodedState.redirectUri !== 'string' ||
    typeof decodedState.serverOrigin !== 'string'
  ) {
    throw new OAuthFlowError('invalid_state', 'Invalid OAuth state payload');
  }

  if (typeof expectedUserId === 'string' && decodedState.userId !== expectedUserId) {
    throw new OAuthFlowError('invalid_state', 'OAuth state does not match active user');
  }

  try {
    const tokenData =
      provider === 'openai'
        ? await exchangeOpenAICode({
            code,
            codeVerifier: decodedState.codeVerifier,
            redirectUri: decodedState.redirectUri,
          })
        : await exchangeAnthropicCode({
            code,
            state,
            codeVerifier: decodedState.codeVerifier,
            redirectUri: decodedState.redirectUri,
          });

    const endpoint = getProviderEndpoint(provider);
    const value =
      provider === 'openai' ? buildOpenAIUserValue(tokenData) : buildAnthropicUserValue(tokenData);

    await updateUserKey({
      userId: decodedState.userId,
      name: endpoint,
      value: JSON.stringify(value),
      expiresAt: shouldPersistConnectedAccountWithoutExpiry(value)
        ? null
        : getTokenExpiryDate(tokenData.expires_in),
    });

    if (provider === 'anthropic') {
      deletePendingAnthropicState(state);
    }

    return { decodedState, value };
  } catch (callbackError) {
    logger.error('[Connected Accounts] OAuth completion failed', callbackError);
    throw new OAuthFlowError('callback_failed', 'OAuth completion failed', 500);
  }
}

async function handleOpenAILocalCallback(req, res) {
  const requestUrl = new URL(req.url || '', OPENAI_LOCAL_REDIRECT_URI);
  if (requestUrl.pathname !== OPENAI_LOCAL_CALLBACK_PATH) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  const provider = 'openai';
  const code = requestUrl.searchParams.get('code');
  const state = requestUrl.searchParams.get('state');
  const oauthError = requestUrl.searchParams.get('error');

  if (oauthError) {
    res.statusCode = 302;
    res.setHeader('Location', createOpenAICallbackUrl(provider, oauthError, state));
    res.end();
    return;
  }

  try {
    const { value } = await completeConnectedAccount({
      provider,
      code,
      state,
      secret: getJWTSecret(),
    });

    const successLocation = createOpenAICallbackUrl(provider, null, state, {
      ...(value.accountId ? { accountId: value.accountId } : {}),
    });

    res.statusCode = 302;
    res.setHeader('Location', successLocation);
    res.end();
  } catch (error) {
    const errorCode = error instanceof OAuthFlowError ? error.code : 'callback_failed';
    const errorLocation = createOpenAICallbackUrl(provider, errorCode, state);
    res.statusCode = 302;
    res.setHeader('Location', errorLocation);
    res.end();
  }
}

async function ensureOpenAILocalCallbackServer() {
  if (shouldForceOpenAIManualMode()) {
    return {
      available: false,
      mode: CONNECTED_ACCOUNT_FLOW_MODES.manualCode,
      reason: 'manual_mode_enabled',
    };
  }

  if (openAILocalCallbackServerStatus != null) {
    return openAILocalCallbackServerStatus;
  }

  if (openAILocalCallbackServerPromise != null) {
    return openAILocalCallbackServerPromise;
  }

  openAILocalCallbackServerPromise = new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      void handleOpenAILocalCallback(req, res);
    });

    server.once('error', (error) => {
      logger.warn('[Connected Accounts] Failed to start OpenAI localhost callback server', {
        message: error instanceof Error ? error.message : String(error),
      });
      openAILocalCallbackServerStatus = {
        available: false,
        mode: CONNECTED_ACCOUNT_FLOW_MODES.manualCode,
        reason: 'callback_server_unavailable',
      };
      resolve(openAILocalCallbackServerStatus);
    });

    server.listen(OPENAI_LOCAL_CALLBACK_PORT, OPENAI_LOCAL_CALLBACK_HOST, () => {
      openAILocalCallbackServerStatus = {
        available: true,
        mode: CONNECTED_ACCOUNT_FLOW_MODES.popupCallback,
        reason: 'callback_server_ready',
      };
      resolve(openAILocalCallbackServerStatus);
    });
  }).finally(() => {
    openAILocalCallbackServerPromise = null;
  });

  return openAILocalCallbackServerPromise;
}

/* === VIVENTIUM START ===
 * Feature: Local Connected Accounts OAuth login flows (OpenClaw-aligned).
 * Purpose: For local/self-hosted deployments:
 * - OpenAI Codex uses 127.0.0.1:1455 callback with ChatGPT OAuth parameters.
 * - Anthropic uses browser sign-in + manual callback/code completion.
 * === VIVENTIUM END === */
router.get('/:provider/start', requireJwtAuth, async (req, res) => {
  const provider = req.params.provider;
  const secret = getJWTSecret();

  if (!isSupportedProvider(provider)) {
    return res.status(404).json({ error: 'Unsupported provider' });
  }

  if (!isConnectedAccountsEnabled()) {
    return res.status(404).json({ error: 'oauth_not_enabled' });
  }

  if (!secret) {
    logger.error('[Connected Accounts] Missing JWT_SECRET; cannot issue OAuth state token');
    return res.status(500).json({ error: 'oauth_unavailable' });
  }

  try {
    const { verifier, challenge } = createPKCE();
    const redirectUri =
      provider === 'openai' ? getOpenAICallbackRedirectUri() : getAnthropicRedirectUri();
    const serverOrigin = getServerOrigin(req);
    const state =
      provider === 'openai'
        ? createOAuthState({
            provider,
            userId: req.user.id,
            codeVerifier: verifier,
            redirectUri,
            serverOrigin,
            secret,
          })
        : verifier;

    if (provider === 'anthropic') {
      setPendingAnthropicState({
        state,
        userId: req.user.id,
        codeVerifier: verifier,
        redirectUri,
        serverOrigin,
      });
    }

    const flowMode =
      provider === 'openai'
        ? (await ensureOpenAILocalCallbackServer()).mode
        : CONNECTED_ACCOUNT_FLOW_MODES.manualCode;

    const authUrl =
      provider === 'openai'
        ? getOpenAIAuthorizationUrl({
            state,
            codeChallenge: challenge,
            redirectUri,
            originator: getOpenAIOAuthOriginator(),
          })
        : getAnthropicAuthorizationUrl({ state, codeChallenge: challenge, redirectUri });

    return res.status(200).json({
      authUrl,
      flowMode,
    });
  } catch (error) {
    logger.error('[Connected Accounts] Failed to initialize OAuth flow', error);
    return res.status(500).json({ error: 'oauth_start_failed' });
  }
});

router.post('/:provider/complete', requireJwtAuth, async (req, res) => {
  const provider = req.params.provider;

  if (!isSupportedProvider(provider)) {
    return res.status(404).json({ error: 'Unsupported provider' });
  }

  if (!isConnectedAccountsEnabled()) {
    return res.status(404).json({ error: 'oauth_not_enabled' });
  }

  try {
    const { code, state } = getProviderCodeAndState(req.body);
    const { value } = await completeConnectedAccount({
      provider,
      code,
      state,
      secret: getJWTSecret(),
      expectedUserId: req.user.id,
    });

    return res.status(200).json({
      success: true,
      provider,
      ...(provider === 'openai' && value.accountId ? { accountId: value.accountId } : {}),
    });
  } catch (error) {
    if (error instanceof OAuthFlowError) {
      return res.status(error.status).json({ error: error.code });
    }
    logger.error('[Connected Accounts] Manual OAuth completion failed', error);
    return res.status(500).json({ error: 'callback_failed' });
  }
});

router.get('/:provider/callback', async (req, res) => {
  const provider = req.params.provider;
  const secret = getJWTSecret();
  const { code, state, error } = req.query;

  if (!isSupportedProvider(provider)) {
    return res.redirect(errorRedirect('callback_failed', provider));
  }

  if (typeof error === 'string' && error.length > 0) {
    return res.redirect(errorRedirect(error, provider));
  }

  if (!isConnectedAccountsEnabled()) {
    return res.redirect(errorRedirect('oauth_not_enabled', provider));
  }

  if (!secret) {
    logger.error('[Connected Accounts] Missing JWT_SECRET during OAuth callback');
    return res.redirect(errorRedirect('callback_failed', provider));
  }

  try {
    const { value } = await completeConnectedAccount({
      provider,
      code,
      state,
      secret,
    });

    return res.redirect(
      successRedirect(provider, {
        ...(provider === 'openai' ? { accountId: value.accountId } : {}),
      }),
    );
  } catch (error) {
    const errorCode = error instanceof OAuthFlowError ? error.code : 'callback_failed';
    return res.redirect(errorRedirect(errorCode, provider));
  }
});

module.exports = router;
