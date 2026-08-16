/* === VIVENTIUM START ===
 * Feature: Durable GlassHive mission capability authorization.
 * Purpose:
 * - Persist the exact connected-capability envelope selected by the authenticated Main turn.
 * - Mint the worker bearer only after GlassHive admits an exact mission run to execution.
 * - Revalidate the same scope on later runs without expanding it, for at most 24 hours.
 * === VIVENTIUM END === */

const crypto = require('crypto');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { getMCPServersRegistry } = require('~/config');
const { getUserById } = require('~/models');
const {
  mintBrokerGrant,
  persistBrokerGrantResources,
} = require('./GlassHiveCapabilityBrokerAuth');
const {
  collectServerProjection,
  isBrokerProjectionEnabled,
  shouldGrantContentReadScope,
} = require('./GlassHiveCapabilityPolicyService');

const AUTHORIZATION_COLLECTION = 'viventium_glasshive_capability_authorizations';
const NONCE_COLLECTION = 'viventium_glasshive_admission_nonces';
const ADMISSION_VERSION = 'v1';
const MAX_AUTHORIZATION_SECONDS = 24 * 60 * 60;
const MAX_MISSION_GRANT_SECONDS = 10 * 60;
const AUTHORIZATION_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const MAX_ADMISSION_SKEW_SECONDS = 60;
const DEFAULT_RESOURCE_MAX_BYTES = 512 * 1024;
const SIMPLE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{7,191}$/;
const CONTAINER_GENERATION_ID = /^[a-f0-9]{64}$/;
let indexesPromise;

class CapabilityAuthorizationError extends Error {
  constructor(code, message, { status = 409, needsInput = true } = {}) {
    super(message);
    this.name = 'CapabilityAuthorizationError';
    this.code = code;
    this.status = status;
    this.needsInput = needsInput;
  }
}

function authorizationCollection() {
  return mongoose.connection.collection(AUTHORIZATION_COLLECTION);
}

function nonceCollection() {
  return mongoose.connection.collection(NONCE_COLLECTION);
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

function scopeFingerprint(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('base64url');
}

function admissionSecret() {
  const value = String(process.env.VIVENTIUM_GLASSHIVE_ADMISSION_SECRET || '').trim();
  if (!value || value.includes('${')) {
    throw new CapabilityAuthorizationError(
      'capability_admission_unavailable',
      'GlassHive mission capability admission is not configured.',
      { status: 503, needsInput: false },
    );
  }
  return value;
}

function authorizationHorizonSeconds() {
  const configured = Number(process.env.VIVENTIUM_GLASSHIVE_AUTHORIZATION_HORIZON_SECONDS);
  if (!Number.isFinite(configured) || configured <= 0) return MAX_AUTHORIZATION_SECONDS;
  return Math.max(60, Math.min(Math.floor(configured), MAX_AUTHORIZATION_SECONDS));
}

async function ensureIndexes() {
  if (!indexesPromise) {
    indexesPromise = (async () => {
      const collection = authorizationCollection();
      /* === VIVENTIUM START ===
       * Feature: Explicit 24-hour same-scope mission reauthorization.
       * Purpose: Older installs used maxExpiresAt as a TTL and physically deleted the record at
       * the first horizon, making authenticated Resume impossible. Remove only that legacy TTL,
       * backfill a separate retention horizon, then create the durable indexes.
       * === VIVENTIUM END === */
      let indexes = [];
      try {
        indexes = await collection.indexes();
      } catch (error) {
        if (![26, 'NamespaceNotFound'].includes(error?.code) && error?.codeName !== 'NamespaceNotFound') {
          throw error;
        }
      }
      for (const index of indexes) {
        if (
          index?.key?.maxExpiresAt === 1 &&
          Number(index.expireAfterSeconds) === 0 &&
          index.name
        ) {
          try {
            await collection.dropIndex(index.name);
          } catch (error) {
            if (![27, 'IndexNotFound'].includes(error?.code) && error?.codeName !== 'IndexNotFound') {
              throw error;
            }
          }
        }
      }
      await collection.updateMany(
        { retentionExpiresAt: { $exists: false } },
        {
          $set: {
            retentionExpiresAt: new Date(Date.now() + AUTHORIZATION_RETENTION_SECONDS * 1000),
          },
        },
      );
      return Promise.all([
        collection.createIndex(
          { retentionExpiresAt: 1 },
          { expireAfterSeconds: 0, name: 'viventium_gh_capability_authorization_retention' },
        ),
        collection.createIndex(
          { ownerId: 1, originRef: 1 },
          { unique: true, name: 'viventium_gh_capability_authorization_owner_origin' },
        ),
        nonceCollection().createIndex(
          { expiresAt: 1 },
          { expireAfterSeconds: 0, name: 'viventium_gh_admission_nonce_expiry' },
        ),
      ]);
    })().catch((error) => {
      indexesPromise = undefined;
      throw error;
    });
  }
  return indexesPromise;
}

function normalizedStrings(values) {
  return Array.from(
    new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)),
  ).sort();
}

function copyJson(value, fallback = {}) {
  try {
    return JSON.parse(JSON.stringify(value ?? fallback));
  } catch {
    return fallback;
  }
}

function scopedHostToolResources(resources, allowedHostTools) {
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) return {};
  const result = {};
  for (const toolName of allowedHostTools) {
    const value = resources[toolName];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const copied = copyJson(value, null);
    if (copied) result[toolName] = copied;
  }
  const configured = Number(
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_RESOURCE_MAX_BYTES,
  );
  const maxBytes = Math.max(
    16 * 1024,
    Number.isFinite(configured) ? Math.floor(configured) : DEFAULT_RESOURCE_MAX_BYTES,
  );
  if (Buffer.byteLength(stableJson(result), 'utf8') > maxBytes) {
    throw new CapabilityAuthorizationError(
      'capability_authorization_scope_too_large',
      'The mission capability authorization scope is too large.',
      { status: 413, needsInput: false },
    );
  }
  return result;
}

async function createCapabilityAuthorization({
  user,
  originRef,
  allowedServers = [],
  allowedHostTools = [],
  hostToolResources = {},
  contentReadScope = false,
  executionMode,
  requestContext = {},
  brokerUrl,
  nowMs = Date.now(),
} = {}) {
  const ownerId = String(user?.id || user?._id || '').trim();
  const normalizedOriginRef = String(originRef || '').trim();
  if (!ownerId || !SIMPLE_REF.test(normalizedOriginRef)) {
    throw new CapabilityAuthorizationError(
      'capability_authorization_invalid',
      'The mission capability authorization identity is invalid.',
      { status: 400, needsInput: false },
    );
  }
  const servers = normalizedStrings(allowedServers);
  const hostTools = normalizedStrings(allowedHostTools);
  const resources = scopedHostToolResources(hostToolResources, hostTools);
  const safeContext = {
    conversation_id: String(requestContext.conversation_id || '').trim(),
    parent_message_id: String(requestContext.parent_message_id || '').trim(),
    message_id: String(requestContext.message_id || '').trim(),
    turn_id: String(requestContext.turn_id || '').trim(),
  };
  if (!safeContext.message_id || (!safeContext.conversation_id && !safeContext.turn_id)) {
    throw new CapabilityAuthorizationError(
      'capability_authorization_turn_scope_missing',
      'The mission capability authorization is missing its originating turn scope.',
      { status: 400, needsInput: false },
    );
  }
  const envelope = {
    ownerId,
    originRef: normalizedOriginRef,
    allowedServers: servers,
    allowedHostTools: hostTools,
    hostToolResources: resources,
    contentReadScope: contentReadScope === true,
    executionMode: String(executionMode || '').trim(),
    requestContext: safeContext,
    brokerUrl: String(brokerUrl || '').trim(),
  };
  const fingerprint = scopeFingerprint(envelope);
  const now = new Date(nowMs);
  const maxExpiresAt = new Date(nowMs + authorizationHorizonSeconds() * 1000);
  // Keep the exact reviewed envelope after its automatic authorization horizon so an explicit,
  // authenticated Resume can revalidate and continue it without silently expanding scope.
  const retentionExpiresAt = new Date(nowMs + AUTHORIZATION_RETENTION_SECONDS * 1000);
  await ensureIndexes();
  const existing = await authorizationCollection().findOne({ ownerId, originRef: normalizedOriginRef });
  if (existing) {
    if (existing.scopeFingerprint !== fingerprint) {
      throw new CapabilityAuthorizationError(
        'capability_authorization_conflict',
        'The mission origin already has a different capability authorization.',
        { status: 409, needsInput: false },
      );
    }
    return existing;
  }
  const record = {
    _id: `gha_${crypto.randomBytes(24).toString('hex')}`,
    authorizationRef: '',
    ...envelope,
    userRole: String(user?.role || 'USER'),
    scopeFingerprint: fingerprint,
    status: 'active',
    workRef: '',
    workerId: '',
    currentRunId: '',
    currentGrantId: '',
    currentContainerGenerationId: '',
    createdAt: now,
    updatedAt: now,
    maxExpiresAt,
    retentionExpiresAt,
  };
  record.authorizationRef = record._id;
  try {
    await authorizationCollection().insertOne(record);
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const raced = await authorizationCollection().findOne({
      ownerId,
      originRef: normalizedOriginRef,
    });
    if (!raced || raced.scopeFingerprint !== fingerprint) {
      throw new CapabilityAuthorizationError(
        'capability_authorization_conflict',
        'The mission origin already has a different capability authorization.',
        { status: 409, needsInput: false },
      );
    }
    return raced;
  }
  logger.info('[VIVENTIUM][glasshive-capability-authorization] Mission scope prepared', {
    authorizationRef: record.authorizationRef,
    originRef: record.originRef,
    serverCount: servers.length,
    hostToolCount: hostTools.length,
    maxExpiresAt: maxExpiresAt.toISOString(),
  });
  return record;
}

function admissionSigningInput({ timestamp, nonce, body }) {
  return `${ADMISSION_VERSION}\n${timestamp}\n${nonce}\n${stableJson(body)}`;
}

function createAdmissionSignature({ body, nowMs = Date.now(), nonce = crypto.randomUUID() } = {}) {
  const timestamp = Math.floor(nowMs / 1000);
  const normalizedNonce = String(nonce || '').trim();
  if (!SIMPLE_REF.test(normalizedNonce)) {
    throw new Error('capability_admission_nonce_invalid');
  }
  const signature = crypto
    .createHmac('sha256', admissionSecret())
    .update(admissionSigningInput({ timestamp, nonce: normalizedNonce, body }))
    .digest('base64url');
  return `${ADMISSION_VERSION}:${timestamp}:${normalizedNonce}:${signature}`;
}

async function verifyAndConsumeAdmission({ body, header, nowMs = Date.now() } = {}) {
  const parts = String(header || '').trim().split(':');
  if (parts.length !== 4 || parts[0] !== ADMISSION_VERSION) {
    throw new CapabilityAuthorizationError(
      'capability_admission_unauthorized',
      'The GlassHive capability admission request is unauthorized.',
      { status: 401, needsInput: false },
    );
  }
  const [, rawTimestamp, nonce, incoming] = parts;
  const timestamp = Number(rawTimestamp);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (
    !Number.isInteger(timestamp) ||
    Math.abs(nowSeconds - timestamp) > MAX_ADMISSION_SKEW_SECONDS ||
    !SIMPLE_REF.test(nonce)
  ) {
    throw new CapabilityAuthorizationError(
      'capability_admission_unauthorized',
      'The GlassHive capability admission request is unauthorized.',
      { status: 401, needsInput: false },
    );
  }
  const expected = crypto
    .createHmac('sha256', admissionSecret())
    .update(admissionSigningInput({ timestamp, nonce, body }))
    .digest('base64url');
  const left = Buffer.from(incoming || '', 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw new CapabilityAuthorizationError(
      'capability_admission_unauthorized',
      'The GlassHive capability admission request is unauthorized.',
      { status: 401, needsInput: false },
    );
  }
  await ensureIndexes();
  try {
    await nonceCollection().insertOne({
      _id: nonce,
      createdAt: new Date(nowMs),
      expiresAt: new Date(nowMs + MAX_ADMISSION_SKEW_SECONDS * 2 * 1000),
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new CapabilityAuthorizationError(
        'capability_admission_replayed',
        'The GlassHive capability admission request has already been used.',
        { status: 409, needsInput: false },
      );
    }
    throw error;
  }
}

async function revalidateAuthorization(record) {
  if (!isBrokerProjectionEnabled()) {
    throw new CapabilityAuthorizationError(
      'capability_policy_changed',
      'Connected capabilities are no longer available for this mission.',
    );
  }
  const user = await getUserById(
    record.ownerId,
    '-password -__v -totpSecret -backupCodes',
  ).catch(() => null);
  if (!user) {
    throw new CapabilityAuthorizationError(
      'capability_account_unavailable',
      'The connected account for this mission is no longer available.',
    );
  }
  const normalizedUser = {
    ...user,
    id: String(user?.id || user?._id || record.ownerId),
    _id: user?._id || record.ownerId,
    role: user?.role || record.userRole || 'USER',
  };
  const registry = getMCPServersRegistry();
  const config = await registry.getAllServerConfigs(normalizedUser.id).catch(() => null);
  if (!config && record.allowedServers.length > 0) {
    throw new CapabilityAuthorizationError(
      'capability_registry_unavailable',
      'Connected capability policy could not be revalidated for this mission.',
    );
  }
  const projection = collectServerProjection({
    mcpConfig: config || {},
    executionMode: record.executionMode,
    serverNames: record.allowedServers,
    reqUser: normalizedUser,
  });
  const currentServers = normalizedStrings(projection.allowedEntries.map(({ serverName }) => serverName));
  if (
    stableJson(currentServers) !== stableJson(record.allowedServers) ||
    shouldGrantContentReadScope(projection.allowedEntries) !== record.contentReadScope
  ) {
    throw new CapabilityAuthorizationError(
      'capability_policy_changed',
      'Connected capability authorization changed while this mission was waiting.',
    );
  }
  return normalizedUser;
}

async function admitCapabilityAuthorization({
  authorizationRef,
  originRef,
  workRef,
  workerId,
  runId,
  containerGenerationId,
  nowMs = Date.now(),
} = {}) {
  const identifiers = [authorizationRef, originRef, workRef, workerId, runId].map((value) =>
    String(value || '').trim(),
  );
  if (identifiers.some((value) => !SIMPLE_REF.test(value))) {
    throw new CapabilityAuthorizationError(
      'capability_authorization_not_found',
      'The mission capability authorization was not found.',
      { status: 404, needsInput: false },
    );
  }
  const [authRef, normalizedOrigin, normalizedWork, normalizedWorker, normalizedRun] = identifiers;
  const normalizedContainerGeneration = String(containerGenerationId || '').trim().toLowerCase();
  if (!CONTAINER_GENERATION_ID.test(normalizedContainerGeneration)) {
    throw new CapabilityAuthorizationError(
      'capability_admission_generation_invalid',
      'The mission container generation is invalid.',
      { status: 400, needsInput: false },
    );
  }
  const record = await authorizationCollection().findOne({
    _id: authRef,
    originRef: normalizedOrigin,
    status: 'active',
  });
  if (!record) {
    throw new CapabilityAuthorizationError(
      'capability_authorization_not_found',
      'The mission capability authorization was not found.',
      { status: 404, needsInput: false },
    );
  }
  if (record.workRef && (record.workRef !== normalizedWork || record.workerId !== normalizedWorker)) {
    throw new CapabilityAuthorizationError(
      'capability_authorization_not_found',
      'The mission capability authorization was not found.',
      { status: 404, needsInput: false },
    );
  }
  const remainingSeconds = Math.floor((new Date(record.maxExpiresAt).getTime() - nowMs) / 1000);
  if (remainingSeconds < 60) {
    // The signed admission is enough to bind the otherwise still-unauthorized queued mission.
    // Persist that association before returning needs-input so an authenticated Core action can
    // resolve the exact envelope by owner + authoritative workRef after a long queue wait.
    const now = new Date(nowMs);
    const bound = await authorizationCollection().updateOne(
      {
        _id: authRef,
        status: 'active',
        scopeFingerprint: record.scopeFingerprint,
        $or: [{ workRef: '' }, { workRef: normalizedWork, workerId: normalizedWorker }],
      },
      {
        $set: {
          workRef: normalizedWork,
          workerId: normalizedWorker,
          currentRunId: normalizedRun,
          lastNeedsInputCode: 'capability_authorization_horizon_expired',
          lastNeedsInputAt: now,
          updatedAt: now,
        },
      },
    );
    if (Number(bound?.matchedCount) !== 1) {
      throw new CapabilityAuthorizationError(
        'capability_authorization_not_found',
        'The mission capability authorization was not found.',
        { status: 404, needsInput: false },
      );
    }
    throw new CapabilityAuthorizationError(
      'capability_authorization_horizon_expired',
      'This mission needs explicit authorization to continue using connected capabilities.',
    );
  }
  const user = await revalidateAuthorization(record);
  const minted = mintBrokerGrant({
    user,
    allowedServers: record.allowedServers,
    allowedHostTools: record.allowedHostTools,
    hostToolResources: record.hostToolResources,
    allowDynamicPolicyServers: false,
    requestContext: {
      ...record.requestContext,
      worker_id: normalizedWorker,
      run_id: normalizedRun,
      authorization_ref: authRef,
      container_generation_id: normalizedContainerGeneration,
      execution_mode: record.executionMode,
    },
    executionMode: record.executionMode,
    ttlSeconds: Math.min(remainingSeconds, MAX_MISSION_GRANT_SECONDS),
    scopes: { content_read: record.contentReadScope },
  });
  await persistBrokerGrantResources(minted);
  const now = new Date(nowMs);
  const grantId = String(minted.payload.grant_id || '');
  const bound = await authorizationCollection().updateOne(
    {
      _id: authRef,
      originRef: normalizedOrigin,
      status: 'active',
      scopeFingerprint: record.scopeFingerprint,
      $or: [{ workRef: '' }, { workRef: normalizedWork, workerId: normalizedWorker }],
    },
    {
      $set: {
        workRef: normalizedWork,
        workerId: normalizedWorker,
        currentRunId: normalizedRun,
        currentGrantId: grantId,
        currentContainerGenerationId: normalizedContainerGeneration,
        lastAdmittedAt: now,
        updatedAt: now,
      },
      $inc: { admissionCount: 1 },
    },
  );
  if (Number(bound?.matchedCount) !== 1) {
    throw new CapabilityAuthorizationError(
      'capability_authorization_binding_changed',
      'The mission capability authorization changed during admission.',
      { status: 409, needsInput: false },
    );
  }
  const confirmed = await authorizationCollection().findOne({
    _id: authRef,
    originRef: normalizedOrigin,
    status: 'active',
    scopeFingerprint: record.scopeFingerprint,
    workRef: normalizedWork,
    workerId: normalizedWorker,
    currentRunId: normalizedRun,
    currentGrantId: grantId,
    currentContainerGenerationId: normalizedContainerGeneration,
  });
  if (!confirmed) {
    throw new CapabilityAuthorizationError(
      'capability_authorization_binding_changed',
      'The mission capability authorization changed during admission.',
      { status: 409, needsInput: false },
    );
  }
  return {
    status: 'authorized',
    authorizationRef: authRef,
    originRef: normalizedOrigin,
    workRef: normalizedWork,
    workerId: normalizedWorker,
    runId: normalizedRun,
    containerGenerationId: normalizedContainerGeneration,
    scopeFingerprint: record.scopeFingerprint,
    brokerUrl: record.brokerUrl,
    grantToken: minted.token,
    grant: {
      grantId,
      expiresAt: minted.payload.exp,
      allowedServers: record.allowedServers,
      allowedHostTools: record.allowedHostTools,
      scopes: minted.payload.scopes,
    },
    maxExpiresAt: new Date(record.maxExpiresAt).toISOString(),
  };
}

function inactiveGrantError() {
  return new CapabilityAuthorizationError(
    'capability_grant_inactive',
    'The mission capability grant is no longer active.',
    { status: 401, needsInput: false },
  );
}

async function assertActiveCapabilityAuthorizationGrant(grant = {}) {
  const authorizationRef = String(grant.authorization_ref || '').trim();
  const grantId = String(grant.grant_id || '').trim();
  const workerId = String(grant.worker_id || '').trim();
  const runId = String(grant.run_id || '').trim();
  const containerGenerationId = String(grant.container_generation_id || '')
    .trim()
    .toLowerCase();
  if (
    !SIMPLE_REF.test(authorizationRef) ||
    !SIMPLE_REF.test(grantId) ||
    !SIMPLE_REF.test(workerId) ||
    !SIMPLE_REF.test(runId) ||
    !CONTAINER_GENERATION_ID.test(containerGenerationId)
  ) {
    throw inactiveGrantError();
  }
  const record = await authorizationCollection().findOne({
    _id: authorizationRef,
    status: 'active',
    currentGrantId: grantId,
    workerId,
    currentRunId: runId,
    currentContainerGenerationId: containerGenerationId,
  });
  if (!record || new Date(record.maxExpiresAt).getTime() <= Date.now()) {
    throw inactiveGrantError();
  }
}

async function revokeCapabilityAuthorizationGrant({
  authorizationRef,
  originRef,
  workRef,
  workerId,
  runId,
  containerGenerationId,
  grantId,
} = {}) {
  const identifiers = [authorizationRef, originRef, workRef, workerId, runId, grantId].map(
    (value) => String(value || '').trim(),
  );
  const generation = String(containerGenerationId || '').trim().toLowerCase();
  if (identifiers.some((value) => !SIMPLE_REF.test(value)) || !CONTAINER_GENERATION_ID.test(generation)) {
    throw new CapabilityAuthorizationError(
      'capability_revocation_request_invalid',
      'The mission capability revocation request is invalid.',
      { status: 400, needsInput: false },
    );
  }
  const [
    authRef,
    normalizedOrigin,
    normalizedWork,
    normalizedWorker,
    normalizedRun,
    normalizedGrant,
  ] = identifiers;
  const now = new Date();
  await authorizationCollection().updateOne(
    {
      _id: authRef,
      originRef: normalizedOrigin,
      workRef: normalizedWork,
      workerId: normalizedWorker,
      currentRunId: normalizedRun,
      currentGrantId: normalizedGrant,
      currentContainerGenerationId: generation,
    },
    {
      $set: {
        currentGrantId: '',
        currentContainerGenerationId: '',
        lastGrantRevokedAt: now,
        updatedAt: now,
      },
    },
  );
}

/**
 * Reauthorize one previously horizon-expired mission after an authenticated owner action.
 * This never accepts a new scope: the persisted envelope is revalidated against current policy,
 * then only its time horizon is advanced. The action proxy carries the returned refresh metadata
 * to GlassHive over the owner-scoped service-asserted account API.
 */
async function reauthorizeCapabilityAuthorization({ ownerId, workRef, nowMs = Date.now() } = {}) {
  const normalizedOwner = String(ownerId || '').trim();
  const normalizedWork = String(workRef || '').trim();
  if (!normalizedOwner || normalizedOwner.length > 192 || !SIMPLE_REF.test(normalizedWork)) {
    throw new CapabilityAuthorizationError(
      'capability_authorization_not_found',
      'The mission capability authorization was not found.',
      { status: 404, needsInput: false },
    );
  }
  const record = await authorizationCollection().findOne({
    ownerId: normalizedOwner,
    workRef: normalizedWork,
    status: 'active',
  });
  if (
    !record ||
    record.lastNeedsInputCode !== 'capability_authorization_horizon_expired'
  ) {
    throw new CapabilityAuthorizationError(
      'capability_authorization_not_found',
      'The mission capability authorization was not found.',
      { status: 404, needsInput: false },
    );
  }

  await revalidateAuthorization(record);
  const now = new Date(nowMs);
  const maxExpiresAt = new Date(nowMs + authorizationHorizonSeconds() * 1000);
  const retentionExpiresAt = new Date(nowMs + AUTHORIZATION_RETENTION_SECONDS * 1000);
  const updated = await authorizationCollection().updateOne(
    {
      _id: record._id,
      ownerId: normalizedOwner,
      workRef: normalizedWork,
      status: 'active',
      scopeFingerprint: record.scopeFingerprint,
      lastNeedsInputCode: 'capability_authorization_horizon_expired',
    },
    {
      $set: {
        maxExpiresAt,
        retentionExpiresAt,
        lastNeedsInputCode: '',
        lastReauthorizedAt: now,
        updatedAt: now,
      },
      $inc: { reauthorizationCount: 1 },
    },
  );
  if (Number(updated?.matchedCount) !== 1) {
    throw new CapabilityAuthorizationError(
      'capability_authorization_not_found',
      'The mission capability authorization was not found.',
      { status: 404, needsInput: false },
    );
  }
  logger.info('[VIVENTIUM][glasshive-capability-authorization] Mission scope reauthorized', {
    authorizationRef: record.authorizationRef,
    workRef: normalizedWork,
    maxExpiresAt: maxExpiresAt.toISOString(),
  });
  return {
    status: 'reauthorized',
    authorizationRef: record.authorizationRef,
    workRef: normalizedWork,
    scopeFingerprint: record.scopeFingerprint,
    maxExpiresAt: maxExpiresAt.toISOString(),
  };
}

function resetCapabilityAuthorizationIndexesForTests() {
  indexesPromise = undefined;
}

module.exports = {
  assertActiveCapabilityAuthorizationGrant,
  CapabilityAuthorizationError,
  admitCapabilityAuthorization,
  createAdmissionSignature,
  createCapabilityAuthorization,
  reauthorizeCapabilityAuthorization,
  revokeCapabilityAuthorizationGrant,
  resetCapabilityAuthorizationIndexesForTests,
  stableJson,
  verifyAndConsumeAdmission,
};
