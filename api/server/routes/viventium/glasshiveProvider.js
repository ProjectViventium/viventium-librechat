/* === VIVENTIUM START ===
 * Feature: Run-scoped GlassHive provider broker
 * Purpose:
 * - Keep connected OpenAI/Anthropic credentials inside Core.
 * - Accept only a signed, exact mission-run grant from the clean-room worker.
 * - Stream the reviewed provider APIs without logging prompt, response, grant, or provider token.
 * === VIVENTIUM END === */

const crypto = require('crypto');
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { EModelEndpoint, ErrorTypes } = require('librechat-data-provider');
const {
  resolveAnthropicSubscriptionUserValues,
  resolveOpenAISubscriptionUserValues,
} = require('@librechat/api');
const { getUserKeyValues, updateUserKey } = require('~/models');
const {
  assertBrokerGrantActive,
  BROKER_AUTHORITY_KINDS,
  resolveBrokerTenantId,
  verifyBrokerGrant,
} = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');
const {
  assertActiveCapabilityAuthorizationGrant,
} = require('~/server/services/viventium/GlassHiveCapabilityAuthorizationService');
const {
  recordOrchestrationTraceEvent,
} = require('~/server/services/viventium/OrchestrationTraceLedgerService');
const { requestLifetimeSignal } = require('./GlassHiveRequestLifetimeSignal');

const router = express.Router();
const OPENAI_RESPONSES_BASE_URL = 'https://api.openai.com/v1';
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const FORWARDED_RESPONSE_HEADERS = new Set([
  'content-type',
  'openai-processing-ms',
  'retry-after',
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  'x-request-id',
]);

function bearerToken(req) {
  return String(req.get('authorization') || '')
    .replace(/^Bearer\s+/i, '')
    .trim();
}

function providerError(res, status, code, message, needsInput = false) {
  res.set('Cache-Control', 'no-store, private');
  return res.status(status).json({ error: { code, message, needsInput } });
}

async function exactMissionGrant(req) {
  const grant = verifyBrokerGrant(bearerToken(req), {
    requireTurnScope: true,
    expectedTenantId: resolveBrokerTenantId(),
    allowLegacyTenantless: true,
  });
  if (
    grant.authority_kind !== BROKER_AUTHORITY_KINDS.MISSION_WORKER ||
    grant.execution_mode !== 'docker' ||
    !String(grant.worker_id || '').trim() ||
    !String(grant.run_id || '').trim()
  ) {
    throw new Error('Provider broker grant is not bound to one Docker mission run');
  }
  await assertBrokerGrantActive(grant);
  const authorization = await assertActiveCapabilityAuthorizationGrant(grant);
  return { grant, authorization };
}

function endpointDb() {
  return { getUserKeyValues, updateUserKey };
}

function isNoUserKeyError(error) {
  if (!(error instanceof Error)) return false;
  try {
    return JSON.parse(error.message)?.type === ErrorTypes.NO_USER_KEY;
  } catch {
    return false;
  }
}

function configuredPlatformValue(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && normalized !== 'user_provided' ? normalized : '';
}

function connectedAccountAuthMode() {
  return [process.env.VIVENTIUM_OPENAI_AUTH_MODE, process.env.VIVENTIUM_PRIMARY_AUTH_MODE].some(
    (value) =>
      String(value || '')
        .trim()
        .toLowerCase() === 'connected_account',
  );
}

function providerAuthProjectionUnavailableError() {
  const error = new Error('The model account authorization could not be read for this mission.');
  error.viventiumProviderAuthFailure = {
    code: 'provider_auth_projection_unavailable',
    status: 503,
    needsInput: false,
  };
  return error;
}

function providerReconnectRequiredError() {
  const error = new Error('Reconnect the connected model account, then resume this work.');
  error.viventiumProviderAuthFailure = {
    code: 'provider_connected_account_reconnect_required',
    status: 409,
    needsInput: true,
  };
  return error;
}

function providerUpstreamUnavailableError() {
  const error = new Error('The connected model provider is temporarily unavailable.');
  error.viventiumProviderAuthFailure = {
    code: 'provider_upstream_unavailable',
    status: 503,
    needsInput: false,
  };
  return error;
}

async function connectedAccountValues(userId, endpoint, resolver) {
  let stored;
  try {
    stored = await getUserKeyValues({ userId, name: endpoint });
  } catch (error) {
    if (isNoUserKeyError(error)) return null;
    throw providerAuthProjectionUnavailableError();
  }
  if (stored?.oauthReconnectRequired === true) {
    throw providerReconnectRequiredError();
  }
  try {
    return await resolver(userId, stored, endpointDb());
  } catch (_error) {
    let refreshed;
    try {
      refreshed = await getUserKeyValues({ userId, name: endpoint });
    } catch (_readError) {
      throw providerAuthProjectionUnavailableError();
    }
    if (refreshed?.oauthReconnectRequired === true) {
      throw providerReconnectRequiredError();
    }
    throw providerUpstreamUnavailableError();
  }
}

async function persistConnectedAccountReconnectRequired(userId, endpoint, values) {
  if (
    String(values?.oauthType || '').toLowerCase() !== 'subscription' ||
    !String(values?.oauthProvider || '').trim()
  ) {
    return;
  }
  try {
    await updateUserKey({
      userId,
      name: endpoint,
      value: JSON.stringify({ ...values, oauthReconnectRequired: true }),
      expiresAt: null,
    });
  } catch (_error) {
    throw providerAuthProjectionUnavailableError();
  }
}

function providerAuthFailure(error) {
  const failure = error?.viventiumProviderAuthFailure;
  return failure && typeof failure === 'object' ? failure : null;
}

async function openAICredentials(userId) {
  const values = await connectedAccountValues(
    userId,
    EModelEndpoint.openAI,
    resolveOpenAISubscriptionUserValues,
  );
  const apiKey = typeof values?.apiKey === 'string' ? values.apiKey.trim() : '';
  const baseURL = typeof values?.baseURL === 'string' ? values.baseURL.trim() : '';
  if (apiKey && baseURL) {
    const headers = values?.headers && typeof values.headers === 'object' ? values.headers : {};
    const subscription = String(values?.oauthType || '').toLowerCase() === 'subscription';
    return {
      apiKey,
      baseURL: baseURL.replace(/\/+$/, ''),
      headers,
      subscription,
      persistReconnectRequired: subscription
        ? () => persistConnectedAccountReconnectRequired(userId, EModelEndpoint.openAI, values)
        : null,
    };
  }
  if (connectedAccountAuthMode()) return null;
  const platformApiKey = configuredPlatformValue(process.env.OPENAI_API_KEY);
  const configuredBaseURL = configuredPlatformValue(process.env.OPENAI_REVERSE_PROXY);
  if (!platformApiKey) return null;
  return {
    apiKey: platformApiKey,
    baseURL: (configuredBaseURL || OPENAI_RESPONSES_BASE_URL).replace(/\/+$/, ''),
    headers: {},
    subscription: false,
    persistReconnectRequired: null,
  };
}

async function anthropicCredentials(userId) {
  const values = await connectedAccountValues(
    userId,
    EModelEndpoint.anthropic,
    resolveAnthropicSubscriptionUserValues,
  );
  const apiKey = String(values?.authToken || values?.apiKey || '').trim();
  if (!apiKey) return null;
  const subscription =
    String(values?.oauthProvider || '').toLowerCase() === 'anthropic' &&
    String(values?.oauthType || '').toLowerCase() === 'subscription';
  return {
    apiKey,
    subscription,
    persistReconnectRequired: subscription
      ? () => persistConnectedAccountReconnectRequired(userId, EModelEndpoint.anthropic, values)
      : null,
  };
}

async function providerCredentials(userId, provider) {
  return provider === 'openai' ? openAICredentials(userId) : anthropicCredentials(userId);
}

function missingProviderAuth(res) {
  return providerError(
    res,
    409,
    'provider_auth_missing',
    'Connect the configured model account, then resume this work.',
    true,
  );
}

function typedProviderAuthError(res, error) {
  const failure = providerAuthFailure(error);
  if (!failure) return null;
  return providerError(
    res,
    failure.status,
    failure.code,
    error.message,
    failure.needsInput === true,
  );
}

function safeOpenAIHeaders(credentials) {
  const allowed = new Set(['openai-beta', 'originator', 'chatgpt-account-id']);
  const projected = { 'Content-Type': 'application/json' };
  for (const [name, value] of Object.entries(credentials.headers || {})) {
    if (
      allowed.has(String(name).toLowerCase()) &&
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 2048 &&
      !/[\r\n]/.test(value)
    ) {
      projected[name] = value;
    }
  }
  projected.Authorization = `Bearer ${credentials.apiKey}`;
  return projected;
}

function safeAnthropicHeaders(req, credentials) {
  const version = String(req.get('anthropic-version') || '2023-06-01').trim();
  const beta = String(req.get('anthropic-beta') || '').trim();
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(version) ? version : '2023-06-01',
  };
  if (beta && beta.length <= 2048 && !/[\r\n]/.test(beta)) headers['anthropic-beta'] = beta;
  if (credentials.subscription) headers.authorization = `Bearer ${credentials.apiKey}`;
  else headers['x-api-key'] = credentials.apiKey;
  return headers;
}

async function pipeUpstream(upstream, res) {
  res.status(upstream.status);
  res.set('Cache-Control', 'no-store, private');
  for (const [name, value] of upstream.headers.entries()) {
    if (FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase())) res.set(name, value);
  }
  if (!upstream.body) return res.end();
  for await (const chunk of upstream.body) {
    if (res.writableEnded || res.destroyed) break;
    res.write(Buffer.from(chunk));
  }
  if (!res.writableEnded) res.end();
}

function providerForwardingStatus(status) {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 200 && status < 400) return 'completed';
  return 'failed';
}

async function recordProviderForwarding({ authorization, provider, providerRequestRef, status }) {
  await recordOrchestrationTraceEvent({
    ownerId: authorization.ownerId,
    originRef: authorization.originRef,
    eventKey: `glasshive.provider.request.v1:${providerRequestRef}`,
    stage: 'provider.request.forwarded',
    facts: {
      workRef: authorization.workRef,
      runRef: authorization.runId,
      providerRequestRef,
      provider,
      providerStatus: providerForwardingStatus(status),
    },
  });
}

async function forward(req, res, provider) {
  let grant;
  let authorization;
  try {
    ({ grant, authorization } = await exactMissionGrant(req));
  } catch {
    return providerError(
      res,
      401,
      'provider_broker_unauthorized',
      'Unauthorized mission provider request.',
    );
  }
  const signal = requestLifetimeSignal(req, res);
  try {
    let credentials;
    let url;
    let headers;
    if (provider === 'openai') {
      credentials = await providerCredentials(String(grant.user_id), provider);
      if (credentials) {
        url = `${credentials.baseURL}/responses`;
        headers = safeOpenAIHeaders(credentials);
      }
    } else {
      credentials = await providerCredentials(String(grant.user_id), provider);
      if (credentials) {
        url = process.env.VIVENTIUM_GLASSHIVE_ANTHROPIC_MESSAGES_URL || ANTHROPIC_MESSAGES_URL;
        headers = safeAnthropicHeaders(req, credentials);
      }
    }
    if (!credentials) {
      return missingProviderAuth(res);
    }
    const providerRequestRef = `ghpr_${crypto.randomBytes(24).toString('hex')}`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body || {}),
      signal,
    });
    try {
      await recordProviderForwarding({
        authorization,
        provider,
        providerRequestRef,
        status: upstream.status,
      });
    } catch {
      await upstream.body?.cancel?.();
      return providerError(
        res,
        503,
        'provider_trace_unavailable',
        'The provider request result could not be recorded safely.',
      );
    }
    if (upstream.status === 401 || upstream.status === 403) {
      await upstream.body?.cancel?.();
      if (
        credentials.subscription === true &&
        typeof credentials.persistReconnectRequired === 'function'
      ) {
        await credentials.persistReconnectRequired();
        return providerError(
          res,
          409,
          'provider_connected_account_reconnect_required',
          'Reconnect the connected model account, then resume this work.',
          true,
        );
      }
      return providerError(
        res,
        409,
        'provider_unauthorized',
        'The model provider rejected the configured credentials.',
        true,
      );
    }
    return await pipeUpstream(upstream, res);
  } catch (error) {
    if (signal.aborted || res.writableEnded) return undefined;
    const typed = typedProviderAuthError(res, error);
    if (typed) return typed;
    logger.warn('[VIVENTIUM][glasshive-provider-broker] Provider request failed', {
      provider,
      workerId: String(grant.worker_id || ''),
      runId: String(grant.run_id || ''),
      errorCode: 'provider_upstream_unavailable',
    });
    return providerError(
      res,
      502,
      'provider_upstream_unavailable',
      'The connected model provider is temporarily unavailable.',
    );
  }
}

async function preflight(req, res, provider) {
  let grant;
  try {
    ({ grant } = await exactMissionGrant(req));
  } catch {
    return providerError(
      res,
      401,
      'provider_broker_unauthorized',
      'Unauthorized mission provider request.',
    );
  }
  if (
    !req.body ||
    typeof req.body !== 'object' ||
    Array.isArray(req.body) ||
    Object.keys(req.body).length !== 1 ||
    req.body.version !== 1
  ) {
    return providerError(
      res,
      400,
      'provider_auth_preflight_invalid',
      'The provider authorization preflight request is invalid.',
    );
  }
  try {
    const credentials = await providerCredentials(String(grant.user_id), provider);
    if (!credentials) return missingProviderAuth(res);
    res.set('Cache-Control', 'no-store, private');
    return res.status(200).json({
      status: 'authorized',
      provider,
      workerId: String(grant.worker_id),
      runId: String(grant.run_id),
    });
  } catch (error) {
    const typed = typedProviderAuthError(res, error);
    if (typed) return typed;
    logger.warn('[VIVENTIUM][glasshive-provider-broker] Provider preflight failed', {
      provider,
      workerId: String(grant.worker_id || ''),
      runId: String(grant.run_id || ''),
      errorCode: 'provider_auth_projection_unavailable',
    });
    return providerError(
      res,
      503,
      'provider_auth_projection_unavailable',
      'The model account authorization could not be read for this mission.',
    );
  }
}

router.post('/openai/auth/preflight', (req, res) => preflight(req, res, 'openai'));
router.post('/anthropic/auth/preflight', (req, res) => preflight(req, res, 'anthropic'));
router.post('/openai/v1/responses', (req, res) => forward(req, res, 'openai'));
router.post('/anthropic/v1/messages', (req, res) => forward(req, res, 'anthropic'));

module.exports = router;
