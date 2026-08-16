/* === VIVENTIUM START ===
 * Feature: Trusted GlassHive account API and active-work snapshot client.
 * Purpose: Keep owner authority out of model/tool arguments and preserve stale/unavailable truth.
 * === VIVENTIUM END === */

const crypto = require('crypto');

const ASSERTION_AUDIENCE = 'glasshive-account-api';
const ASSERTION_TTL_SECONDS = 60;
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_CACHE_MS = 2000;
const DEFAULT_COLD_TIMEOUT_MS = 100;
const DEFAULT_INTERACTIVE_TIMEOUT_MS = 5000;
const ASSERTION_NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{7,191}$/;
const activeWorkCache = new Map();
const activeWorkRefreshes = new Map();
const activeWorkCacheVersions = new Map();
const activeWorkObservations = new Map();
let activeWorkCacheGeneration = 0;

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value || value.includes('${')) {
    throw new Error(`${name}_not_configured`);
  }
  return value;
}

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function configuredTenantId() {
  return String(process.env.VIVENTIUM_TENANT_ID || 'local').trim() || 'local';
}

/* === VIVENTIUM START ===
 * Feature: Core-authenticated delegation identity.
 * Purpose: A model-controlled MCP bundle must not be able to mint or choose durable mutation
 * identity merely by matching the public object shape.
 * === VIVENTIUM END === */
function signTrustedDelegationIdentity(identity = {}, { ownerId, tenantId } = {}) {
  const normalizedOwnerId = String(ownerId || '').trim();
  const normalizedTenantId = String(tenantId || configuredTenantId()).trim();
  if (!normalizedOwnerId || !normalizedTenantId) {
    throw new Error('trusted_delegation_identity_scope_invalid');
  }
  const canonical = JSON.stringify({
    identity: {
      call_identity_digest: String(identity.call_identity_digest || ''),
      goal_digest: String(identity.goal_digest || ''),
      idempotency_key: String(identity.idempotency_key || ''),
      launch_payload_digest: String(identity.launch_payload_digest || ''),
      objective_ordinal: Number(identity.objective_ordinal),
      source_event_id: String(identity.source_event_id || ''),
      version: Number(identity.version),
    },
    owner_id: normalizedOwnerId,
    tenant_id: normalizedTenantId,
  });
  return crypto
    .createHmac('sha256', requiredEnv('VIVENTIUM_GLASSHIVE_SERVICE_ASSERTION_SECRET'))
    .update(`viventium.delegation-identity.v2\0${canonical}`, 'utf8')
    .digest('hex');
}

function createServiceAssertion({ ownerId, nowMs = Date.now(), nonce = crypto.randomUUID() }) {
  const normalizedOwnerId = String(ownerId || '').trim();
  if (!normalizedOwnerId) {
    throw new Error('glasshive_owner_required');
  }
  const issuedAt = Math.floor(nowMs / 1000);
  const payload = {
    v: 1,
    aud: ASSERTION_AUDIENCE,
    tenant_id: configuredTenantId(),
    owner_id: normalizedOwnerId,
    iat: issuedAt,
    exp: issuedAt + ASSERTION_TTL_SECONDS,
    nonce: String(nonce || '').trim(),
  };
  if (!ASSERTION_NONCE_PATTERN.test(payload.nonce)) {
    throw new Error('glasshive_assertion_nonce_required');
  }
  // GlassHive verifies the exact canonical byte representation, not merely the
  // decoded claim values. Keep this ordering aligned with Python's
  // json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False).
  const canonicalPayload = Object.fromEntries(
    Object.entries(payload).sort(([left], [right]) => left.localeCompare(right)),
  );
  const encoded = Buffer.from(JSON.stringify(canonicalPayload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', requiredEnv('VIVENTIUM_GLASSHIVE_SERVICE_ASSERTION_SECRET'))
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

function configuredBaseUrl() {
  const configured = requiredEnv('GLASSHIVE_PROVIDER_BASE_URL');
  const parsed = new URL(configured);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('glasshive_account_base_url_invalid');
  }
  return parsed;
}

function accountUrl(path) {
  const base = configuredBaseUrl();
  const normalizedPath = String(path || '');
  if (!normalizedPath.startsWith('/v1/')) {
    throw new Error('glasshive_account_path_invalid');
  }
  return new URL(
    normalizedPath.slice(4),
    base.toString().endsWith('/') ? base : `${base}/`,
  ).toString();
}

async function requestAccountApi({
  ownerId,
  path,
  method = 'GET',
  body,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('glasshive_account_fetch_unavailable');
  }
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${requiredEnv('WPR_API_TOKEN')}`,
    'X-Viventium-Service-Assertion': createServiceAssertion({ ownerId }),
  };
  if (body != null) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetchImpl(accountUrl(path), {
    method,
    redirect: 'error',
    headers,
    ...(body != null ? { body: JSON.stringify(body) } : {}),
    ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? { signal: AbortSignal.timeout(timeoutMs) }
      : {}),
  });
  const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
  const contentLength = Number(response?.headers?.get?.('content-length'));
  if (
    !contentType.startsWith('application/json') ||
    (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES)
  ) {
    throw new Error('glasshive_account_response_invalid');
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('glasshive_account_response_oversized');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('glasshive_account_response_invalid');
  }
  if (!response.ok) {
    const structured = parsed?.detail || parsed?.error || parsed;
    const error = new Error(structured?.code || 'glasshive_account_rejected');
    error.status = Number(response.status) || 502;
    error.body = parsed;
    error.userMessage = structured?.message || '';
    throw error;
  }
  return parsed;
}

function buildTrustedDelegationIdentity({
  ownerId,
  sourceEventId,
  objectiveOrdinal,
  callIdentityDigest = '',
  goal,
}) {
  const normalizedOwner = String(ownerId || '').trim();
  const normalizedSourceEvent = String(sourceEventId || '').trim();
  const normalizedGoal = String(goal || '');
  const normalizedCallIdentityDigest = String(callIdentityDigest || '')
    .trim()
    .toLowerCase();
  const ordinal = Number(objectiveOrdinal);
  if (
    !normalizedOwner ||
    !normalizedSourceEvent ||
    !normalizedGoal.trim() ||
    !Number.isInteger(ordinal) ||
    ordinal < 0 ||
    (normalizedCallIdentityDigest && !/^[a-f0-9]{64}$/.test(normalizedCallIdentityDigest))
  ) {
    throw new Error('trusted_delegation_identity_invalid');
  }
  const tenantId = configuredTenantId();
  const goalDigest = crypto.createHash('sha256').update(normalizedGoal, 'utf8').digest('hex');
  // Provider call identity survives a reconstructed request and invocation reordering. The ordinal
  // remains useful presentation metadata but is only an idempotency fallback for legacy callers.
  const objectiveIdentity = normalizedCallIdentityDigest
    ? `call:${normalizedCallIdentityDigest}`
    : `ordinal:${ordinal}`;
  const idempotencyKey = crypto
    .createHash('sha256')
    .update(
      `${tenantId}\u0000${normalizedOwner}\u0000${normalizedSourceEvent}\u0000${objectiveIdentity}\u0000${goalDigest}`,
    )
    .digest('hex');
  return { idempotencyKey, goalDigest };
}

function buildTrustedActionIdempotencyKey({ ownerId, workRef, action, operationId }) {
  const tenantId = configuredTenantId();
  const values = [ownerId, workRef, action, operationId].map((value) => String(value || '').trim());
  if (values.some((value) => !value)) {
    throw new Error('trusted_action_identity_invalid');
  }
  return crypto
    .createHash('sha256')
    .update([tenantId, ...values].join('\u0000'))
    .digest('hex');
}

function normalizedSnapshot(value, snapshot = 'fresh') {
  if (!value || !Array.isArray(value.work)) {
    throw new Error('glasshive_active_work_invalid');
  }
  return {
    ...value,
    snapshot,
    overflowCount: Number.isInteger(value.overflowCount) ? value.overflowCount : 0,
  };
}

function ownerCacheKey(ownerId) {
  return `${configuredTenantId()}\u0000${String(ownerId || '').trim()}`;
}

function observationState(ownerKey) {
  let state = activeWorkObservations.get(ownerKey);
  if (!state) {
    state = {
      latestStarted: 0,
      latestResolved: 0,
      latestKnownWork: true,
      activeSequences: new Set(),
      group: 0,
      positiveGroups: new Set(),
    };
    activeWorkObservations.set(ownerKey, state);
  }
  return state;
}

function beginActiveWorkObservation(ownerKey) {
  const state = observationState(ownerKey);
  if (state.activeSequences.size === 0) state.group += 1;
  state.latestStarted += 1;
  state.activeSequences.add(state.latestStarted);
  return {
    ownerKey,
    state,
    sequence: state.latestStarted,
    group: state.group,
    generation: activeWorkCacheGeneration,
    cacheVersion: activeWorkCacheVersions.get(ownerKey) || 0,
  };
}

function finishActiveWorkObservation(observation) {
  if (!observation || activeWorkObservations.get(observation.ownerKey) !== observation.state)
    return;
  observation.state.activeSequences.delete(observation.sequence);
  if (observation.state.activeSequences.size === 0) {
    const minimumGroup = Math.max(0, observation.state.group - 1);
    for (const group of observation.state.positiveGroups) {
      if (group < minimumGroup) observation.state.positiveGroups.delete(group);
    }
  }
}

function activeWorkObservationIsCurrent(observation) {
  return Boolean(
    observation &&
    observation.generation === activeWorkCacheGeneration &&
    observation.cacheVersion === (activeWorkCacheVersions.get(observation.ownerKey) || 0) &&
    activeWorkObservations.get(observation.ownerKey) === observation.state &&
    observation.sequence === observation.state.latestStarted,
  );
}

function recordResolvedKnownWork(observation, knownWork) {
  if (!observation) return;
  if (knownWork === true) observation.state.positiveGroups.add(observation.group);
  if (observation.sequence < observation.state.latestResolved) return;
  observation.state.latestResolved = observation.sequence;
  observation.state.latestKnownWork = knownWork === true;
}

function activeWorkObservationMayPersist(observation, knownWork) {
  if (
    !observation ||
    observation.generation !== activeWorkCacheGeneration ||
    observation.cacheVersion !== (activeWorkCacheVersions.get(observation.ownerKey) || 0) ||
    activeWorkObservations.get(observation.ownerKey) !== observation.state ||
    observation.group !== observation.state.group
  ) {
    return false;
  }
  if (knownWork === true) return true;
  return (
    activeWorkObservationIsCurrent(observation) &&
    !observation.state.positiveGroups.has(observation.group)
  );
}

async function persistObservedKnownWork({
  ownerId,
  observation,
  knownWork,
  expectedKnownWorkEpoch,
  callerGuard,
}) {
  if (!callerGuard() || !activeWorkObservationMayPersist(observation, knownWork)) {
    return false;
  }
  const { clearUserParallelWorkKnownIfEpoch, markUserParallelWorkKnown } = require('~/models');
  if (knownWork) {
    const fenced = await markUserParallelWorkKnown(ownerId);
    if (!fenced) {
      const error = new Error('parallel_work_positive_fence_failed');
      error.code = 'parallel_work_positive_fence_failed';
      throw error;
    }
    return true;
  }
  return clearUserParallelWorkKnownIfEpoch(ownerId, expectedKnownWorkEpoch);
}

async function enrichSnapshot(
  ownerId,
  snapshot,
  {
    authoritativeFirstPage = false,
    observation,
    knownWorkEpoch = null,
    shouldPersistKnownWork = () => true,
  } = {},
) {
  const { enrichActiveWorkSnapshot } = require('./GlassHiveActiveWorkProjectionService');
  const enriched = await enrichActiveWorkSnapshot({
    ownerId,
    snapshot,
    ...(authoritativeFirstPage ? { includeCoreOnly: true } : {}),
  });
  if (enriched?.snapshot === 'fresh' && Array.isArray(enriched.work)) {
    let knownWork = enriched.work.length > 0 || Number(enriched.overflowCount) > 0;
    // Any page can prove work exists. Only an authoritative first page can prove the
    // opposite; an empty later page says nothing about items retained on page one.
    if (!knownWork && !authoritativeFirstPage) return enriched;
    // Cache invalidation is also the lifecycle generation boundary for this
    // preference side effect. A response from before a committed delegation must
    // not clear the focused-mode known-work hint after that delegation exists.
    if (knownWork) {
      recordResolvedKnownWork(observation, true);
      if (!shouldPersistKnownWork() || !activeWorkObservationMayPersist(observation, true)) {
        return enriched;
      }
    } else if (!shouldPersistKnownWork() || !activeWorkObservationMayPersist(observation, false)) {
      return enriched;
    }
    if (!knownWork) {
      // GlassHive can truthfully be empty during Core's dispatch-ready/unknown window.
      // Only the conjunction of an authoritative empty first page and no durable Core
      // relation is allowed to clear rollback visibility/control.
      const { hasKnownExternalWork } = require('./GlassHiveCallbackBindingService');
      knownWork = await hasKnownExternalWork({ ownerId });
      if (knownWork) recordResolvedKnownWork(observation, true);
      if (!shouldPersistKnownWork() || !activeWorkObservationMayPersist(observation, knownWork)) {
        return enriched;
      }
    }
    if (!knownWork) recordResolvedKnownWork(observation, false);
    await persistObservedKnownWork({
      ownerId,
      observation,
      knownWork,
      expectedKnownWorkEpoch: knownWorkEpoch,
      callerGuard: shouldPersistKnownWork,
    });
  }
  return enriched;
}

function boundedListLimit(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(parsed, 100)) : 50;
}

function normalizedCursor(value) {
  const cursor = String(value || '').trim();
  if (!cursor) return '';
  if (cursor.length > 2048 || !/^[A-Za-z0-9._~:@+-]+$/.test(cursor)) {
    throw new Error('glasshive_active_work_cursor_invalid');
  }
  return cursor;
}

async function getActiveWorkPage({
  ownerId,
  cursor = '',
  limit = 50,
  fetchImpl = globalThis.fetch,
  timeoutMs = positiveIntEnv(
    'VIVENTIUM_ACTIVE_WORK_INTERACTIVE_TIMEOUT_MS',
    DEFAULT_INTERACTIVE_TIMEOUT_MS,
  ),
  rosterObservation,
  shouldPersistKnownWork = () => true,
}) {
  const normalizedOwnerId = String(ownerId || '').trim();
  if (!normalizedOwnerId) throw new Error('glasshive_owner_required');
  const ownerKey = ownerCacheKey(normalizedOwnerId);
  const observation = rosterObservation || beginActiveWorkObservation(ownerKey);
  const callerGuard = shouldPersistKnownWork;
  const pageWriteIsCurrent = () => callerGuard();
  const pageCursor = normalizedCursor(cursor);
  let knownWorkEpoch = null;
  if (!pageCursor) {
    const { getUserParallelWorkKnownEpoch } = require('~/models');
    knownWorkEpoch = await getUserParallelWorkKnownEpoch(normalizedOwnerId);
    if (knownWorkEpoch == null) {
      throw new Error('parallel_work_owner_not_found');
    }
  }
  const query = new URLSearchParams({ limit: String(boundedListLimit(limit)) });
  if (pageCursor) query.set('cursor', pageCursor);
  try {
    const response = await requestAccountApi({
      ownerId: normalizedOwnerId,
      path: `/v1/active-work?${query.toString()}`,
      fetchImpl,
      timeoutMs,
    });
    return await enrichSnapshot(normalizedOwnerId, normalizedSnapshot(response), {
      authoritativeFirstPage: !pageCursor,
      observation,
      knownWorkEpoch,
      shouldPersistKnownWork: pageWriteIsCurrent,
    });
  } finally {
    finishActiveWorkObservation(observation);
  }
}

async function getActiveWorkSnapshot({
  ownerId,
  fetchImpl = globalThis.fetch,
  forceRefresh = false,
  timeoutMs = positiveIntEnv('VIVENTIUM_ACTIVE_WORK_COLD_TIMEOUT_MS', DEFAULT_COLD_TIMEOUT_MS),
}) {
  const normalizedOwnerId = String(ownerId || '').trim();
  if (!normalizedOwnerId) {
    throw new Error('glasshive_owner_required');
  }
  const key = ownerCacheKey(normalizedOwnerId);
  const now = Date.now();
  const cacheMs = positiveIntEnv('VIVENTIUM_ACTIVE_WORK_CACHE_MS', DEFAULT_CACHE_MS);
  const cached = activeWorkCache.get(key);
  if (!forceRefresh && cached && now - cached.fetchedAt <= cacheMs) {
    return { ...cached.value, snapshot: 'fresh' };
  }

  const refresh = () => {
    let ownerRefreshes = activeWorkRefreshes.get(key);
    if (!ownerRefreshes) {
      ownerRefreshes = new Map();
      activeWorkRefreshes.set(key, ownerRefreshes);
    }
    const deadlineKey = String(timeoutMs);
    const existing = ownerRefreshes.get(deadlineKey);
    if (existing) return existing;
    const generation = activeWorkCacheGeneration;
    const keyVersion = activeWorkCacheVersions.get(key) || 0;
    const observation = beginActiveWorkObservation(key);
    const pending = getActiveWorkPage({
      ownerId: normalizedOwnerId,
      fetchImpl,
      timeoutMs,
      rosterObservation: observation,
      shouldPersistKnownWork: () =>
        generation === activeWorkCacheGeneration &&
        keyVersion === (activeWorkCacheVersions.get(key) || 0),
    })
      .then((value) => {
        if (
          generation === activeWorkCacheGeneration &&
          keyVersion === (activeWorkCacheVersions.get(key) || 0) &&
          activeWorkObservationIsCurrent(observation)
        ) {
          activeWorkCache.set(key, { value, fetchedAt: Date.now() });
        }
        return value;
      })
      .finally(() => {
        if (ownerRefreshes.get(deadlineKey) === pending) {
          ownerRefreshes.delete(deadlineKey);
          if (ownerRefreshes.size === 0 && activeWorkRefreshes.get(key) === ownerRefreshes) {
            activeWorkRefreshes.delete(key);
          }
        }
      });
    ownerRefreshes.set(deadlineKey, pending);
    return pending;
  };

  // Stale-while-revalidate is the hot path: once Main has any truthful roster,
  // never add a network wait to a later turn merely because the two-second
  // freshness window elapsed. Preserve the stale marker until refresh succeeds.
  if (!forceRefresh && cached) {
    void refresh().catch(() => {});
    return { ...cached.value, snapshot: 'stale' };
  }
  try {
    return await refresh();
  } catch (_error) {
    if (cached) {
      return { ...cached.value, snapshot: 'stale' };
    }
    const unavailable = { snapshot: 'unavailable', work: null, overflowCount: null };
    // GlassHive unavailability must remain explicit, but it must not erase Core-owned
    // pre-dispatch attention after a cold restart. This local projection contains no
    // executable GlassHive state and exposes only the inert, owner-scoped Dismiss action.
    try {
      const { enrichActiveWorkSnapshot } = require('./GlassHiveActiveWorkProjectionService');
      return await enrichActiveWorkSnapshot({
        ownerId: normalizedOwnerId,
        snapshot: unavailable,
        includeCoreOnly: true,
      });
    } catch {
      return unavailable;
    }
  }
}

/**
 * User-triggered roster reads may wait longer than Main's strict turn-start
 * budget, while retaining the same stale/unavailable truth and shared cache.
 */
async function getActiveWorkInteractiveSnapshot(options) {
  return getActiveWorkSnapshot({
    ...options,
    // Interactive callers are explicit user refreshes. Waiting on the longer interactive
    // deadline must return the newly observed roster; the stale-while-revalidate shortcut is
    // reserved for Main's latency-sensitive turn-start reads.
    forceRefresh: true,
    timeoutMs: positiveIntEnv(
      'VIVENTIUM_ACTIVE_WORK_INTERACTIVE_TIMEOUT_MS',
      DEFAULT_INTERACTIVE_TIMEOUT_MS,
    ),
  });
}

/** Drop one owner's roster after a committed mutation without disturbing other accounts. */
function invalidateActiveWorkSnapshot({ ownerId }) {
  const normalizedOwnerId = String(ownerId || '').trim();
  if (!normalizedOwnerId) throw new Error('glasshive_owner_required');
  const key = ownerCacheKey(normalizedOwnerId);
  activeWorkCacheVersions.set(key, (activeWorkCacheVersions.get(key) || 0) + 1);
  const state = observationState(key);
  state.latestStarted += 1;
  state.group += 1;
  state.activeSequences.clear();
  state.positiveGroups.clear();
  activeWorkCache.delete(key);
  // A prior network request cannot be cancelled reliably. Removing its registry entry permits the
  // next read to start immediately; the per-key version above prevents the stale request winning.
  activeWorkRefreshes.delete(key);
}

function clearActiveWorkCacheForTests() {
  activeWorkCacheGeneration += 1;
  activeWorkCache.clear();
  activeWorkRefreshes.clear();
  activeWorkCacheVersions.clear();
  activeWorkObservations.clear();
}

module.exports = {
  buildTrustedActionIdempotencyKey,
  buildTrustedDelegationIdentity,
  clearActiveWorkCacheForTests,
  createServiceAssertion,
  getActiveWorkPage,
  getActiveWorkInteractiveSnapshot,
  getActiveWorkSnapshot,
  invalidateActiveWorkSnapshot,
  requestAccountApi,
  signTrustedDelegationIdentity,
};
