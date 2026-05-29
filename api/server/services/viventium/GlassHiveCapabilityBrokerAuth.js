/* === VIVENTIUM START ===
 * Feature: GlassHive capability broker grants
 * Purpose:
 * - Mint and verify short-lived grants for GlassHive workers calling the LibreChat-owned
 *   capability broker.
 * - Keep provider OAuth/API credentials inside LibreChat; workers receive only a scoped broker grant.
 * === VIVENTIUM END === */

const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const { getLogStores } = require('~/cache');

const BROKER_AUDIENCE = 'glasshive-capability-broker';
const WRITE_CONFIRMATION_AUDIENCE = 'glasshive-write-confirmation';
const DEFAULT_TTL_SECONDS = 10 * 60;
const FALLBACK_REPLAY_CACHE = new Map();
const FALLBACK_RATE_LIMIT_CACHE = new Map();

function base64urlEncode(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64urlDecode(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function getBrokerSecret() {
  return String(process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET || '').trim();
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function stablePayload(payload) {
  const copy = { ...payload };
  delete copy.sig;
  return stableJson(copy);
}

function signPayload(payload, secret = getBrokerSecret()) {
  return crypto.createHmac('sha256', secret).update(stablePayload(payload)).digest('base64url');
}

function argsHash(args = {}) {
  return crypto.createHash('sha256').update(stableJson(args || {})).digest('base64url');
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sanitizeAllowedServers(servers) {
  return Array.from(new Set((servers || []).map((server) => String(server || '').trim()).filter(Boolean))).sort();
}

function normalizeBrokerScopes(scopes = {}) {
  return {
    content_read:
      scopes.content_read === true ||
      scopes.contentRead === true ||
      scopes.connected_account_content_read === true ||
      scopes.connectedAccountContentRead === true,
  };
}

function mintBrokerGrant({
  user,
  allowedServers = [],
  requestContext = {},
  executionMode,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  renewableTtlSeconds = ttlSeconds,
  scopes = {},
  nowMs = Date.now(),
} = {}) {
  const secret = getBrokerSecret();
  if (!secret) {
    throw new Error('GlassHive capability broker secret is not configured');
  }
  const userId = String(user?.id || user?._id || requestContext.user_id || '').trim();
  if (!userId) {
    throw new Error('GlassHive capability broker grant requires a user id');
  }
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + Math.max(60, Number(ttlSeconds) || DEFAULT_TTL_SECONDS);
  const renewableUntil = iat + Math.max(
    Math.max(60, Number(ttlSeconds) || DEFAULT_TTL_SECONDS),
    Math.max(60, Number(renewableTtlSeconds) || Number(ttlSeconds) || DEFAULT_TTL_SECONDS),
  );
  const payload = {
    aud: BROKER_AUDIENCE,
    grant_id: `ghcb_${crypto.randomBytes(16).toString('hex')}`,
    user_id: userId,
    user_role: String(user?.role || requestContext.user_role || ''),
    conversation_id: String(requestContext.conversation_id || requestContext.conversationId || ''),
    parent_message_id: String(requestContext.parent_message_id || requestContext.parentMessageId || ''),
    message_id: String(requestContext.message_id || requestContext.messageId || ''),
    worker_id: String(requestContext.worker_id || requestContext.workerId || ''),
    run_id: String(requestContext.run_id || requestContext.runId || ''),
    execution_mode: String(executionMode || requestContext.execution_mode || ''),
    allowed_servers: sanitizeAllowedServers(allowedServers),
    allow_dynamic_policy_servers: true,
    scopes: normalizeBrokerScopes(scopes),
    iat,
    exp,
    renewable_until: renewableUntil,
    nonce: crypto.randomBytes(16).toString('hex'),
    policy_version: 1,
  };
  payload.sig = signPayload(payload, secret);
  return {
    token: base64urlEncode(JSON.stringify(payload)),
    payload,
  };
}

function verifyBrokerGrant(token, { nowMs = Date.now(), expectedUserId, allowRenewal = false } = {}) {
  const secret = getBrokerSecret();
  if (!secret) {
    throw new Error('GlassHive capability broker secret is not configured');
  }
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(token));
  } catch (error) {
    throw new Error('Invalid GlassHive capability broker grant');
  }
  const incoming = String(payload.sig || '');
  const expected = signPayload(payload, secret);
  if (!incoming || !timingSafeEqualString(incoming, expected)) {
    throw new Error('Invalid GlassHive capability broker grant signature');
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  if (payload.aud !== BROKER_AUDIENCE) {
    throw new Error('Invalid GlassHive capability broker grant audience');
  }
  if (!payload.user_id) {
    throw new Error('GlassHive capability broker grant is missing user scope');
  }
  if (expectedUserId && String(expectedUserId) !== String(payload.user_id)) {
    throw new Error('GlassHive capability broker grant user mismatch');
  }
  const expired = !Number.isFinite(Number(payload.exp)) || Number(payload.exp) < nowSeconds;
  const renewableUntil = Number(payload.renewable_until || payload.exp);
  if (expired && (!allowRenewal || !Number.isFinite(renewableUntil) || renewableUntil < nowSeconds)) {
    throw new Error('GlassHive capability broker grant expired');
  }
  return {
    ...payload,
    allowed_servers: sanitizeAllowedServers(payload.allowed_servers),
    scopes: normalizeBrokerScopes(payload.scopes),
    renewed: expired,
  };
}

function grantReplayTtlMs(grant, nowMs = Date.now()) {
  const expMs = Number(grant?.exp) * 1000;
  const renewableMs = Number(grant?.renewable_until || grant?.exp) * 1000;
  const until = Math.max(Number.isFinite(expMs) ? expMs : 0, Number.isFinite(renewableMs) ? renewableMs : 0);
  return Math.max(60_000, until - nowMs);
}

function brokerRateLimitWindowMs() {
  const configured = Number(process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_RATE_LIMIT_WINDOW_MS || 60_000);
  return Math.max(1_000, Number.isFinite(configured) ? configured : 60_000);
}

function brokerRateLimitMaxRequests() {
  const configured = Number(process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_RATE_LIMIT_PER_WINDOW || 120);
  if (!Number.isFinite(configured)) {
    return 120;
  }
  return Math.max(0, Math.floor(configured));
}

async function getRateLimitCache() {
  try {
    return getLogStores(CacheKeys.FLOWS);
  } catch (error) {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Rate-limit cache unavailable', {
      message: error?.message,
    });
    return null;
  }
}

function allowInMemoryRateLimitCache() {
  return process.env.NODE_ENV !== 'production';
}

function rememberBrokerRequestFallback({ key, limit, bucketExpiresAt, nowMs }) {
  for (const [cachedKey, entry] of FALLBACK_RATE_LIMIT_CACHE.entries()) {
    if (!entry || entry.expiresAt <= nowMs) {
      FALLBACK_RATE_LIMIT_CACHE.delete(cachedKey);
    }
  }
  const current = FALLBACK_RATE_LIMIT_CACHE.get(key) || { count: 0, expiresAt: bucketExpiresAt };
  if (current.count >= limit) {
    return {
      accepted: false,
      rateLimited: true,
      retryAfterMs: Math.max(1_000, current.expiresAt - nowMs),
    };
  }
  FALLBACK_RATE_LIMIT_CACHE.set(key, {
    count: current.count + 1,
    expiresAt: current.expiresAt,
  });
  return {
    accepted: true,
    rateLimited: false,
    remaining: Math.max(0, limit - current.count - 1),
    resetAtMs: current.expiresAt,
    shared: false,
  };
}

async function rememberBrokerRequest({ grant, nowMs = Date.now() } = {}) {
  const limit = brokerRateLimitMaxRequests();
  if (limit <= 0) {
    return { accepted: true, rateLimited: false, disabled: true };
  }
  const grantId = String(grant?.grant_id || '').trim();
  if (!grantId) {
    return { accepted: false, rateLimited: true, reason: 'missing_grant_id', retryAfterMs: 1_000 };
  }
  const windowMs = brokerRateLimitWindowMs();
  const bucket = Math.floor(nowMs / windowMs);
  const key = `glasshive-capability-broker:rate:${grantId}:${bucket}`;
  const bucketExpiresAt = (bucket + 1) * windowMs;
  const cache = await getRateLimitCache();
  if (cache?.get && cache?.set) {
    let current = { count: 0, expiresAt: bucketExpiresAt };
    const raw = await cache.get(key);
    if (raw) {
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        current = {
          count: Math.max(0, Number(parsed?.count) || 0),
          expiresAt: Math.max(bucketExpiresAt, Number(parsed?.expiresAt) || bucketExpiresAt),
        };
      } catch (error) {
        current = { count: 0, expiresAt: bucketExpiresAt };
      }
    }
    if (current.count >= limit) {
      return {
        accepted: false,
        rateLimited: true,
        retryAfterMs: Math.max(1_000, current.expiresAt - nowMs),
        shared: true,
      };
    }
    const next = {
      count: current.count + 1,
      expiresAt: current.expiresAt,
    };
    await cache.set(key, JSON.stringify(next), Math.max(1_000, next.expiresAt - nowMs));
    return {
      accepted: true,
      rateLimited: false,
      remaining: Math.max(0, limit - next.count),
      resetAtMs: next.expiresAt,
      shared: true,
    };
  }
  if (!allowInMemoryRateLimitCache()) {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Blocking request because rate-limit cache is unavailable', {
      grantId,
    });
    return {
      accepted: false,
      rateLimited: true,
      reason: 'rate_limit_cache_unavailable',
      retryAfterMs: 1_000,
    };
  }
  return rememberBrokerRequestFallback({
    key,
    limit,
    bucketExpiresAt,
    nowMs,
  });
}

function mintWriteConfirmation({
  grantId,
  serverName,
  toolName,
  invocationId,
  args = {},
  ttlSeconds = 5 * 60,
  nowMs = Date.now(),
} = {}) {
  const secret = getBrokerSecret();
  if (!secret) {
    throw new Error('GlassHive capability broker secret is not configured');
  }
  const cleanGrantId = String(grantId || '').trim();
  const cleanServerName = String(serverName || '').trim();
  const cleanToolName = String(toolName || '').trim();
  const cleanInvocationId = String(invocationId || '').trim();
  if (!cleanGrantId || !cleanServerName || !cleanToolName || !cleanInvocationId) {
    throw new Error('Write confirmation requires grant, server, tool, and invocation scopes');
  }
  const iat = Math.floor(nowMs / 1000);
  const payload = {
    aud: WRITE_CONFIRMATION_AUDIENCE,
    grant_id: cleanGrantId,
    server_name: cleanServerName,
    tool_name: cleanToolName,
    invocation_id: cleanInvocationId,
    args_hash: argsHash(args),
    iat,
    exp: iat + Math.max(60, Number(ttlSeconds) || 5 * 60),
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  payload.sig = signPayload(payload, secret);
  return {
    token: base64urlEncode(JSON.stringify(payload)),
    payload,
  };
}

function verifyWriteConfirmation(
  token,
  { grantId, serverName, toolName, invocationId, args = {}, nowMs = Date.now() } = {},
) {
  const secret = getBrokerSecret();
  if (!secret) {
    throw new Error('GlassHive capability broker secret is not configured');
  }
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(token));
  } catch (error) {
    throw new Error('Invalid GlassHive write confirmation');
  }
  const incoming = String(payload.sig || '');
  const expected = signPayload(payload, secret);
  if (!incoming || !timingSafeEqualString(incoming, expected)) {
    throw new Error('Invalid GlassHive write confirmation signature');
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  if (payload.aud !== WRITE_CONFIRMATION_AUDIENCE) {
    throw new Error('Invalid GlassHive write confirmation audience');
  }
  if (String(payload.grant_id || '') !== String(grantId || '')) {
    throw new Error('GlassHive write confirmation grant mismatch');
  }
  if (String(payload.server_name || '') !== String(serverName || '')) {
    throw new Error('GlassHive write confirmation server mismatch');
  }
  if (String(payload.tool_name || '') !== String(toolName || '')) {
    throw new Error('GlassHive write confirmation tool mismatch');
  }
  if (String(payload.invocation_id || '') !== String(invocationId || '')) {
    throw new Error('GlassHive write confirmation invocation mismatch');
  }
  if (String(payload.args_hash || '') !== argsHash(args)) {
    throw new Error('GlassHive write confirmation arguments mismatch');
  }
  if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) < nowSeconds) {
    throw new Error('GlassHive write confirmation expired');
  }
  return payload;
}

async function getReplayCache() {
  try {
    return getLogStores(CacheKeys.FLOWS);
  } catch (error) {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Replay cache unavailable', {
      message: error?.message,
    });
    return null;
  }
}

function allowInMemoryReplayCache() {
  if (process.env.NODE_ENV === 'production') {
    return false;
  }
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ALLOW_IN_MEMORY_REPLAY_CACHE || '')
      .trim()
      .toLowerCase(),
  );
}

async function rememberInvocation({ grantId, invocationId, ttlMs = 10 * 60 * 1000 } = {}) {
  const cleanGrantId = String(grantId || '').trim();
  const cleanInvocationId = String(invocationId || '').trim();
  if (!cleanGrantId || !cleanInvocationId) {
    return { accepted: true, replayChecked: false };
  }
  const key = `glasshive-capability-broker:invoke:${cleanGrantId}:${cleanInvocationId}`;
  const cache = await getReplayCache();
  if (cache?.get && cache?.set) {
    const existing = await cache.get(key);
    if (existing) {
      return { accepted: false, replayChecked: true };
    }
    await cache.set(key, '1', ttlMs);
    return { accepted: true, replayChecked: true };
  }
  if (!allowInMemoryReplayCache()) {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Blocking invocation because replay cache is unavailable', {
      grantId: cleanGrantId,
    });
    return { accepted: false, replayChecked: false, reason: 'replay_cache_unavailable' };
  }
  const now = Date.now();
  for (const [cachedKey, expiresAt] of FALLBACK_REPLAY_CACHE.entries()) {
    if (expiresAt <= now) {
      FALLBACK_REPLAY_CACHE.delete(cachedKey);
    }
  }
  if (FALLBACK_REPLAY_CACHE.has(key)) {
    return { accepted: false, replayChecked: true };
  }
  FALLBACK_REPLAY_CACHE.set(key, now + ttlMs);
  return { accepted: true, replayChecked: true };
}

module.exports = {
  BROKER_AUDIENCE,
  WRITE_CONFIRMATION_AUDIENCE,
  argsHash,
  grantReplayTtlMs,
  rememberBrokerRequest,
  mintBrokerGrant,
  mintWriteConfirmation,
  verifyBrokerGrant,
  verifyWriteConfirmation,
  rememberInvocation,
  normalizeBrokerScopes,
  sanitizeAllowedServers,
  allowInMemoryReplayCache,
};
