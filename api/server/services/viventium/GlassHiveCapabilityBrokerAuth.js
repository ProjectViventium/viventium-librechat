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
const MAX_BROKER_TTL_SECONDS = 24 * 60 * 60;
const FALLBACK_REPLAY_CACHE = new Map();
const FALLBACK_RATE_LIMIT_CACHE = new Map();
const FALLBACK_REVOCATION_CACHE = new Map();
const FALLBACK_GRANT_RESOURCE_CACHE = new Map();
const DEFAULT_GRANT_RESOURCE_MAX_BYTES = 512 * 1024;
let BROKER_REVOCATION_CACHE;

function base64urlEncode(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64urlDecode(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function getBrokerSecret() {
  return String(process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET || '').trim();
}

/* === VIVENTIUM START ===
 * Feature: Tenant-bound and revocable GlassHive grants.
 * Purpose: Derive tenant scope from deployment-owned configuration, never from a worker request.
 */
function resolveBrokerTenantId() {
  return String(
    process.env.GLASSHIVE_ENTERPRISE_TENANT_ID ||
      process.env.VIVENTIUM_GLASSHIVE_TENANT_ID ||
      process.env.VIVENTIUM_TENANT_ID ||
      'local',
  ).trim();
}

function normalizeGrantId(value) {
  const grantId = String(value || '').trim();
  if (!grantId) {
    return '';
  }
  if (!/^ghcb_[A-Za-z0-9_-]{8,152}$/.test(grantId)) {
    throw new Error('Invalid GlassHive capability broker grant id');
  }
  return grantId;
}
/* === VIVENTIUM END === */

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
  return crypto
    .createHash('sha256')
    .update(stableJson(args || {}))
    .digest('base64url');
}

function valueHash(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('base64url');
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sanitizeAllowedServers(servers) {
  return Array.from(
    new Set((servers || []).map((server) => String(server || '').trim()).filter(Boolean)),
  ).sort();
}

function sanitizeAllowedHostTools(tools) {
  return Array.from(
    new Set((tools || []).map((tool) => String(tool || '').trim()).filter(Boolean)),
  ).sort();
}

function sanitizeHostToolResources(resources, allowedHostTools) {
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    return {};
  }
  const result = {};
  for (const toolName of allowedHostTools) {
    const value = resources[toolName];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    try {
      result[toolName] = JSON.parse(JSON.stringify(value));
    } catch {
      // Fail closed for a non-serializable resource descriptor.
    }
  }
  return result;
}

function grantResourceMaxBytes() {
  const configured = Number(
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_RESOURCE_MAX_BYTES ||
      DEFAULT_GRANT_RESOURCE_MAX_BYTES,
  );
  return Math.max(
    16 * 1024,
    Number.isFinite(configured) ? Math.floor(configured) : DEFAULT_GRANT_RESOURCE_MAX_BYTES,
  );
}

function grantResourceCacheKey(grantId) {
  return `glasshive-capability-broker:resources:${String(grantId || '').trim()}`;
}

function rememberGrantResourcesFallback(record, nowMs = Date.now()) {
  for (const [grantId, cached] of FALLBACK_GRANT_RESOURCE_CACHE.entries()) {
    if (!cached || Number(cached.expires_at_ms) <= nowMs) {
      FALLBACK_GRANT_RESOURCE_CACHE.delete(grantId);
    }
  }
  FALLBACK_GRANT_RESOURCE_CACHE.set(record.grant_id, record);
}

function resourceRecordForGrant({ grantId, resources, expiresAt, nowMs = Date.now() }) {
  const serialized = stableJson(resources);
  const sizeBytes = Buffer.byteLength(serialized, 'utf8');
  if (sizeBytes > grantResourceMaxBytes()) {
    throw new Error('GlassHive capability broker resource scope exceeds the configured limit');
  }
  return {
    grant_id: grantId,
    resource_ref: valueHash(resources),
    resources,
    size_bytes: sizeBytes,
    expires_at_ms: Math.max(nowMs + 60_000, Number(expiresAt) * 1000),
  };
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
  eagerServers = allowedServers,
  deferredServers = [],
  allowedHostTools = [],
  hostToolResources = {},
  requestContext = {},
  executionMode,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  renewableTtlSeconds = ttlSeconds,
  scopes = {},
  allowDynamicPolicyServers = false,
  grantId,
  nowMs = Date.now(),
  requireTurnScope = true,
} = {}) {
  const secret = getBrokerSecret();
  if (!secret) {
    throw new Error('GlassHive capability broker secret is not configured');
  }
  const userId = String(user?.id || user?._id || requestContext.user_id || '').trim();
  if (!userId) {
    throw new Error('GlassHive capability broker grant requires a user id');
  }
  /* === VIVENTIUM START ===
   * Security: Make mint-time authority match the production broker's verify-time boundary.
   * Purpose: Never create or persist a bearer grant that the only production consumer is
   * guaranteed to reject. Conversation grants stay bound to one exact message and
   * conversation/turn; direct and scheduled runtimes must explicitly opt into their separate
   * signed worker/run or schedule/run boundary.
   * === VIVENTIUM END === */
  const messageId = String(requestContext.message_id || requestContext.messageId || '').trim();
  const conversationId = String(
    requestContext.conversation_id || requestContext.conversationId || '',
  ).trim();
  const turnId = String(requestContext.turn_id || requestContext.turnId || '').trim();
  if (requireTurnScope && (!messageId || (!conversationId && !turnId))) {
    throw new Error('GlassHive capability broker grant is missing turn scope');
  }
  const iat = Math.floor(nowMs / 1000);
  const requestedTtl = Number(ttlSeconds);
  const exp =
    iat +
    Math.max(
      60,
      Math.min(
        Number.isFinite(requestedTtl) ? Math.floor(requestedTtl) : DEFAULT_TTL_SECONDS,
        MAX_BROKER_TTL_SECONDS,
      ),
    );
  const renewableUntil =
    iat +
    Math.max(
      Math.max(60, Number(ttlSeconds) || DEFAULT_TTL_SECONDS),
      Math.max(60, Number(renewableTtlSeconds) || Number(ttlSeconds) || DEFAULT_TTL_SECONDS),
    );
  /* === VIVENTIUM START ===
   * Feature: Deferred connected-account projection.
   * Purpose: Sign eager and on-demand server scopes separately so ordinary harness turns do not
   * initialize heavyweight connected-account MCPs merely because they are authorized.
   */
  const sanitizedAllowedServers = sanitizeAllowedServers(allowedServers);
  const allowedServerSet = new Set(sanitizedAllowedServers);
  const sanitizedEagerServers = sanitizeAllowedServers(eagerServers).filter((server) =>
    allowedServerSet.has(server),
  );
  const eagerServerSet = new Set(sanitizedEagerServers);
  const sanitizedDeferredServers = sanitizeAllowedServers(deferredServers).filter(
    (server) => allowedServerSet.has(server) && !eagerServerSet.has(server),
  );
  const normalizedHostTools = sanitizeAllowedHostTools(allowedHostTools);
  const normalizedHostResources = sanitizeHostToolResources(hostToolResources, normalizedHostTools);
  const resolvedGrantId =
    normalizeGrantId(grantId) || `ghcb_${crypto.randomBytes(16).toString('hex')}`;
  const resourceRecord =
    Object.keys(normalizedHostResources).length > 0
      ? resourceRecordForGrant({
          grantId: resolvedGrantId,
          resources: normalizedHostResources,
          expiresAt: exp,
          nowMs,
        })
      : null;
  const payload = {
    aud: BROKER_AUDIENCE,
    grant_id: resolvedGrantId,
    tenant_id: resolveBrokerTenantId(),
    user_id: userId,
    user_role: String(user?.role || requestContext.user_role || ''),
    conversation_id: conversationId,
    parent_message_id: String(
      requestContext.parent_message_id || requestContext.parentMessageId || '',
    ),
    message_id: messageId,
    turn_id: turnId,
    worker_id: String(requestContext.worker_id || requestContext.workerId || ''),
    run_id: String(requestContext.run_id || requestContext.runId || ''),
    schedule_id: String(requestContext.schedule_id || requestContext.scheduleId || ''),
    execution_mode: String(executionMode || requestContext.execution_mode || ''),
    allowed_servers: sanitizedAllowedServers,
    eager_servers: sanitizedEagerServers,
    deferred_servers: sanitizedDeferredServers,
    allowed_host_tools: normalizedHostTools,
    ...(resourceRecord ? { host_tool_resources_ref: resourceRecord.resource_ref } : {}),
    allow_dynamic_policy_servers: allowDynamicPolicyServers === true,
    scopes: normalizeBrokerScopes(scopes),
    iat,
    exp,
    ...(renewableUntil > exp ? { renewable_until: renewableUntil } : {}),
    nonce: crypto.randomBytes(16).toString('hex'),
    policy_version: 2,
  };
  /* === VIVENTIUM END === */
  payload.sig = signPayload(payload, secret);
  if (resourceRecord) {
    rememberGrantResourcesFallback(resourceRecord, nowMs);
  }
  return {
    token: base64urlEncode(JSON.stringify(payload)),
    payload: {
      ...payload,
      ...(resourceRecord ? { host_tool_resources: resourceRecord.resources } : {}),
    },
    resourceRecord,
  };
}

function verifyBrokerGrant(
  token,
  {
    nowMs = Date.now(),
    expectedUserId,
    expectedTenantId,
    allowRenewal = false,
    allowLegacyTenantless = false,
    requireTurnScope = false,
  } = {},
) {
  const secret = getBrokerSecret();
  if (!secret) {
    throw new Error('GlassHive capability broker secret is not configured');
  }
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(token));
  } catch (_error) {
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
  const policyVersion = Number(payload.policy_version || 1);
  if (policyVersion >= 2 && !String(payload.tenant_id || '').trim()) {
    throw new Error('GlassHive capability broker grant is missing tenant scope');
  }
  if (expectedTenantId) {
    const tenantId = String(payload.tenant_id || '').trim();
    if (!tenantId && !(allowLegacyTenantless && policyVersion < 2)) {
      throw new Error('GlassHive capability broker grant is missing tenant scope');
    }
    if (tenantId && String(expectedTenantId) !== tenantId) {
      throw new Error('GlassHive capability broker grant tenant mismatch');
    }
  }
  if (expectedUserId && String(expectedUserId) !== String(payload.user_id)) {
    throw new Error('GlassHive capability broker grant user mismatch');
  }
  const hasMessageScope = Boolean(String(payload.message_id || '').trim());
  const hasConversationScope = Boolean(String(payload.conversation_id || '').trim());
  const hasPrePersistenceTurnScope = Boolean(String(payload.turn_id || '').trim());
  if (
    requireTurnScope &&
    (!hasMessageScope || (!hasConversationScope && !hasPrePersistenceTurnScope))
  ) {
    throw new Error('GlassHive capability broker grant is missing turn scope');
  }
  const expired = !Number.isFinite(Number(payload.exp)) || Number(payload.exp) < nowSeconds;
  const renewableUntil = Number(payload.renewable_until || payload.exp);
  if (
    expired &&
    (!allowRenewal || !Number.isFinite(renewableUntil) || renewableUntil < nowSeconds)
  ) {
    throw new Error('GlassHive capability broker grant expired');
  }
  const verifiedAllowedServers = sanitizeAllowedServers(payload.allowed_servers);
  const verifiedAllowedServerSet = new Set(verifiedAllowedServers);
  const verifiedEagerServers = sanitizeAllowedServers(
    Array.isArray(payload.eager_servers) ? payload.eager_servers : payload.allowed_servers,
  ).filter((server) => verifiedAllowedServerSet.has(server));
  const verifiedEagerServerSet = new Set(verifiedEagerServers);
  const verifiedDeferredServers = sanitizeAllowedServers(payload.deferred_servers).filter(
    (server) => verifiedAllowedServerSet.has(server) && !verifiedEagerServerSet.has(server),
  );
  return {
    ...payload,
    allowed_servers: verifiedAllowedServers,
    /* === VIVENTIUM START: preserve backwards compatibility for grants minted before deferred
     * projection by treating their complete allowlist as eager. === */
    eager_servers: verifiedEagerServers,
    deferred_servers: verifiedDeferredServers,
    /* === VIVENTIUM END === */
    allowed_host_tools: sanitizeAllowedHostTools(payload.allowed_host_tools),
    scopes: normalizeBrokerScopes(payload.scopes),
    renewed: expired,
  };
}

async function persistBrokerGrantResources(mintedGrant) {
  const record = mintedGrant?.resourceRecord;
  if (!record) {
    return { persisted: false, reason: 'no_resources' };
  }
  rememberGrantResourcesFallback(record);
  const cache = await getRateLimitCache();
  if (!cache?.set) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('GlassHive capability broker resource cache is unavailable');
    }
    return { persisted: false, fallback: true };
  }
  await cache.set(
    grantResourceCacheKey(record.grant_id),
    JSON.stringify(record),
    Math.max(60_000, record.expires_at_ms - Date.now()),
  );
  return { persisted: true, sizeBytes: record.size_bytes };
}

async function hydrateBrokerGrantResources(grant, { nowMs = Date.now() } = {}) {
  const resourceRef = String(grant?.host_tool_resources_ref || '').trim();
  if (!resourceRef) {
    return { ...grant, host_tool_resources: {} };
  }
  const grantId = String(grant?.grant_id || '').trim();
  let record = FALLBACK_GRANT_RESOURCE_CACHE.get(grantId);
  if (!record) {
    const cache = await getRateLimitCache();
    const raw = cache?.get ? await cache.get(grantResourceCacheKey(grantId)) : null;
    if (raw) {
      try {
        record = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        record = null;
      }
    }
  }
  if (
    !record ||
    record.grant_id !== grantId ||
    Number(record.expires_at_ms) < nowMs ||
    valueHash(record.resources || {}) !== resourceRef
  ) {
    throw new Error('GlassHive capability broker resource scope is unavailable');
  }
  rememberGrantResourcesFallback(record, nowMs);
  return {
    ...grant,
    host_tool_resources: sanitizeHostToolResources(
      record.resources,
      sanitizeAllowedHostTools(grant.allowed_host_tools),
    ),
  };
}

async function getRevocationCache() {
  if (BROKER_REVOCATION_CACHE) {
    return BROKER_REVOCATION_CACHE;
  }
  try {
    BROKER_REVOCATION_CACHE = getLogStores(CacheKeys.FLOWS);
    return BROKER_REVOCATION_CACHE;
  } catch (error) {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Revocation cache unavailable', {
      message: error?.message,
    });
    return null;
  }
}

function revocationKey(grantId) {
  return `glasshive-capability-broker:revoked:${normalizeGrantId(grantId)}`;
}

function revocationTtlMs(grant, nowMs = Date.now()) {
  const expiryMs = Number(grant?.renewable_until || grant?.exp) * 1000;
  return Math.max(60_000, (Number.isFinite(expiryMs) ? expiryMs : nowMs) - nowMs);
}

function cleanupFallbackRevocations(nowMs) {
  for (const [key, entry] of FALLBACK_REVOCATION_CACHE.entries()) {
    if (!entry || Number(entry.expiresAt) <= nowMs) {
      FALLBACK_REVOCATION_CACHE.delete(key);
    }
  }
}

async function revokeBrokerGrant(grant, { nowMs = Date.now() } = {}) {
  const grantId = normalizeGrantId(grant?.grant_id);
  if (!grantId) {
    throw new Error('GlassHive capability broker revocation requires a grant id');
  }
  const key = revocationKey(grantId);
  const ttlMs = revocationTtlMs(grant, nowMs);
  const entry = JSON.stringify({ revokedAt: nowMs, expiresAt: nowMs + ttlMs });
  const cache = await getRevocationCache();
  if (cache?.set) {
    await cache.set(key, entry, ttlMs);
    return { revoked: true, grantId, shared: true };
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('GlassHive capability broker revocation cache is unavailable');
  }
  cleanupFallbackRevocations(nowMs);
  FALLBACK_REVOCATION_CACHE.set(key, { revokedAt: nowMs, expiresAt: nowMs + ttlMs });
  return { revoked: true, grantId, shared: false };
}

async function assertBrokerGrantActive(grant, { nowMs = Date.now() } = {}) {
  const grantId = normalizeGrantId(grant?.grant_id);
  if (!grantId) {
    throw new Error('GlassHive capability broker grant is missing grant id');
  }
  const key = revocationKey(grantId);
  const cache = await getRevocationCache();
  if (cache?.get && cache?.set) {
    if (await cache.get(key)) {
      throw new Error('GlassHive capability broker grant revoked');
    }
    return { active: true, grantId, shared: true };
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('GlassHive capability broker revocation cache is unavailable');
  }
  cleanupFallbackRevocations(nowMs);
  if (FALLBACK_REVOCATION_CACHE.has(key)) {
    throw new Error('GlassHive capability broker grant revoked');
  }
  return { active: true, grantId, shared: false };
}
/* === VIVENTIUM END === */

function grantReplayTtlMs(grant, nowMs = Date.now()) {
  const expMs = Number(grant?.exp) * 1000;
  return Math.max(60_000, (Number.isFinite(expMs) ? expMs : 0) - nowMs);
}

function brokerRateLimitWindowMs() {
  const configured = Number(
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_RATE_LIMIT_WINDOW_MS || 60_000,
  );
  return Math.max(1_000, Number.isFinite(configured) ? configured : 60_000);
}

function brokerRateLimitMaxRequests() {
  const configured = Number(
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_RATE_LIMIT_PER_WINDOW || 120,
  );
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
  const atomicStore = cache?.opts?.store;
  if (typeof atomicStore?.reserveWithinLimit === 'function') {
    const reservation = await atomicStore.reserveWithinLimit(
      `${cache.opts?.namespace || CacheKeys.FLOWS}:${key}`,
      limit,
      bucketExpiresAt,
    );
    if (!reservation.accepted) {
      return {
        accepted: false,
        rateLimited: true,
        retryAfterMs: Math.max(1_000, bucketExpiresAt - nowMs),
        shared: true,
      };
    }
    return {
      accepted: true,
      rateLimited: false,
      remaining: Math.max(0, limit - reservation.count),
      resetAtMs: bucketExpiresAt,
      shared: true,
    };
  }
  if (!allowInMemoryRateLimitCache()) {
    logger.warn(
      '[VIVENTIUM][glasshive-capability-broker] Blocking request because rate-limit cache is unavailable',
      {
        grantId,
      },
    );
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
  } catch (_error) {
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
    logger.warn(
      '[VIVENTIUM][glasshive-capability-broker] Blocking invocation because replay cache is unavailable',
      {
        grantId: cleanGrantId,
      },
    );
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
  hydrateBrokerGrantResources,
  rememberBrokerRequest,
  mintBrokerGrant,
  mintWriteConfirmation,
  persistBrokerGrantResources,
  verifyBrokerGrant,
  verifyWriteConfirmation,
  rememberInvocation,
  normalizeBrokerScopes,
  sanitizeAllowedServers,
  allowInMemoryReplayCache,
  assertBrokerGrantActive,
  revokeBrokerGrant,
  resolveBrokerTenantId,
};
