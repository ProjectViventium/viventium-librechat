/* === VIVENTIUM START ===
 * Feature: Run-scoped GlassHive provider broker
 * Purpose:
 * - Keep connected OpenAI/Anthropic credentials inside Core.
 * - Accept only a signed, exact mission-run grant from the clean-room worker.
 * - Stream the reviewed provider APIs without logging prompt, response, grant, or provider token.
 * === VIVENTIUM END === */

const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { EModelEndpoint, ErrorTypes } = require('librechat-data-provider');
const {
  resolveAnthropicSubscriptionUserValues,
  resolveOpenAISubscriptionUserValues,
} = require('@librechat/api');
const { getUserKeyValues, updateUserKey } = require('~/models');
const {
  BROKER_AUTHORITY_KINDS,
  verifyBrokerGrant,
} = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');
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

function exactMissionGrant(req) {
  const grant = verifyBrokerGrant(bearerToken(req), { requireTurnScope: true });
  if (
    grant.authority_kind !== BROKER_AUTHORITY_KINDS.MISSION_WORKER ||
    grant.execution_mode !== 'docker' ||
    !String(grant.worker_id || '').trim() ||
    !String(grant.run_id || '').trim()
  ) {
    throw new Error('Provider broker grant is not bound to one Docker mission run');
  }
  return grant;
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
  const error = new Error('Provider authentication projection is unavailable');
  error.viventiumProviderAuthProjectionUnavailable = true;
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
  try {
    return await resolver(userId, stored, endpointDb());
  } catch (error) {
    throw providerAuthProjectionUnavailableError();
  }
}

function isProviderAuthProjectionUnavailable(error) {
  return error?.viventiumProviderAuthProjectionUnavailable === true;
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
    return { apiKey, baseURL: baseURL.replace(/\/+$/, ''), headers };
  }
  if (connectedAccountAuthMode()) return null;
  const platformApiKey = configuredPlatformValue(process.env.OPENAI_API_KEY);
  const configuredBaseURL = configuredPlatformValue(process.env.OPENAI_REVERSE_PROXY);
  if (!platformApiKey) return null;
  return {
    apiKey: platformApiKey,
    baseURL: (configuredBaseURL || OPENAI_RESPONSES_BASE_URL).replace(/\/+$/, ''),
    headers: {},
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
  return {
    apiKey,
    subscription:
      String(values?.oauthProvider || '').toLowerCase() === 'anthropic' &&
      String(values?.oauthType || '').toLowerCase() === 'subscription',
  };
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

async function forward(req, res, provider) {
  let grant;
  try {
    grant = exactMissionGrant(req);
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
      credentials = await openAICredentials(String(grant.user_id));
      if (credentials) {
        url = `${credentials.baseURL}/responses`;
        headers = safeOpenAIHeaders(credentials);
      }
    } else {
      credentials = await anthropicCredentials(String(grant.user_id));
      if (credentials) {
        url = process.env.VIVENTIUM_GLASSHIVE_ANTHROPIC_MESSAGES_URL || ANTHROPIC_MESSAGES_URL;
        headers = safeAnthropicHeaders(req, credentials);
      }
    }
    if (!credentials) {
      return providerError(
        res,
        409,
        'provider_auth_projection_unavailable',
        'The connected model account is unavailable for this mission.',
        true,
      );
    }
    const upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body || {}),
      signal,
    });
    return await pipeUpstream(upstream, res);
  } catch (error) {
    if (signal.aborted || res.writableEnded) return undefined;
    if (isProviderAuthProjectionUnavailable(error)) {
      return providerError(
        res,
        409,
        'provider_auth_projection_unavailable',
        'The connected model account is unavailable for this mission.',
        true,
      );
    }
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

router.post('/openai/v1/responses', (req, res) => forward(req, res, 'openai'));
router.post('/anthropic/v1/messages', (req, res) => forward(req, res, 'anthropic'));

module.exports = router;
