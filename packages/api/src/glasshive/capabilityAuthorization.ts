/* === VIVENTIUM START ===
 * Feature: Durable GlassHive mission capability authorization.
 * Purpose:
 * - Persist the exact connected-capability envelope selected by the authenticated Main turn.
 * - Mint the worker bearer only after GlassHive admits an exact mission run to execution.
 * - Revalidate the same scope on later runs without expanding it, for at most 24 hours.
 * === VIVENTIUM END === */

import crypto from 'node:crypto';

type ValueRecord = { [key: string]: unknown };

interface AuthorizationRecord extends ValueRecord {
  _id: string;
  authorizationRef: string;
  ownerId: string;
  originRef: string;
  allowedServers: string[];
  allowedHostTools: string[];
  hostToolResources: ValueRecord;
  contentReadScope: boolean;
  executionMode: string;
  requestContext: ValueRecord;
  brokerUrl: string;
  userRole: string;
  scopeFingerprint: string;
  status: string;
  workRef: string;
  workerId: string;
  currentRunId: string;
  currentGrantId: string;
  currentContainerGenerationId: string;
  maxExpiresAt: Date | string;
  lastNeedsInputCode?: string;
}

interface IndexRecord {
  key?: ValueRecord;
  expireAfterSeconds?: number;
  name?: string;
}

interface CollectionPort {
  indexes(): Promise<IndexRecord[]>;
  dropIndex(name: string): Promise<unknown>;
  createIndex(keys: ValueRecord, options: ValueRecord): Promise<unknown>;
  updateMany(filter: ValueRecord, update: ValueRecord): Promise<unknown>;
  findOne(filter: ValueRecord): Promise<AuthorizationRecord | null>;
  insertOne(record: ValueRecord): Promise<unknown>;
  updateOne(filter: ValueRecord, update: ValueRecord): Promise<{ matchedCount?: number }>;
}

interface UserRecord extends ValueRecord {
  id?: string;
  _id?: unknown;
  role?: string;
}

interface ProjectionEntry extends ValueRecord {
  serverName: string;
}

interface ProjectionResult {
  allowedEntries: ProjectionEntry[];
  omissions?: unknown[];
}

interface MintedGrant {
  token: string;
  payload: {
    grant_id: string;
    exp: number;
    scopes: ValueRecord;
  };
}

export interface CapabilityAuthorizationDependencies {
  collection(name: string): CollectionPort;
  logger: {
    info(message: string, details?: ValueRecord): void;
  };
  getUserById(ownerId: string, projection: string): Promise<UserRecord | null>;
  getAllServerConfigs(ownerId: string): Promise<ValueRecord | null>;
  mintBrokerGrant(input: ValueRecord): MintedGrant;
  persistBrokerGrantResources(grant: MintedGrant): Promise<unknown>;
  collectServerProjection(input: ValueRecord): ProjectionResult;
  isBrokerProjectionEnabled(): boolean;
  shouldGrantContentReadScope(entries: ProjectionEntry[]): boolean;
}

interface CreateAuthorizationInput {
  user?: UserRecord;
  originRef?: unknown;
  allowedServers?: unknown;
  allowedHostTools?: unknown;
  hostToolResources?: unknown;
  contentReadScope?: boolean;
  executionMode?: unknown;
  requestContext?: ValueRecord;
  brokerUrl?: unknown;
  nowMs?: number;
}

interface ScheduledAuthorizationInput {
  ownerId?: unknown;
  originRef?: unknown;
  workRef?: unknown;
  workerId?: unknown;
  runId?: unknown;
  containerGenerationId?: unknown;
  allowedServers?: unknown;
  allowedHostTools?: unknown;
  contentReadScope?: boolean;
  executionMode?: unknown;
  requestContext?: ValueRecord;
  brokerUrl?: unknown;
  nowMs?: number;
}

interface AdmissionInput {
  body?: unknown;
  nowMs?: number;
  nonce?: unknown;
}

interface AdmissionSigningInput {
  timestamp: number;
  nonce: string;
  body: unknown;
}

interface VerifyAdmissionInput {
  body?: unknown;
  header?: unknown;
  nowMs?: number;
}

interface AdmitAuthorizationInput {
  authorizationRef?: unknown;
  originRef?: unknown;
  workRef?: unknown;
  workerId?: unknown;
  runId?: unknown;
  containerGenerationId?: unknown;
  nowMs?: number;
}

interface RevokeAuthorizationInput extends AdmitAuthorizationInput {
  grantId?: unknown;
}

interface ReauthorizeInput {
  ownerId?: unknown;
  workRef?: unknown;
  nowMs?: number;
}

let runtimeDependencies: CapabilityAuthorizationDependencies | null = null;

export function configureCapabilityAuthorizationService(
  dependencies: CapabilityAuthorizationDependencies,
): void {
  runtimeDependencies = dependencies;
}

function runtime(): CapabilityAuthorizationDependencies {
  if (!runtimeDependencies) {
    throw new Error('capability_authorization_dependencies_unavailable');
  }
  return runtimeDependencies;
}

function recordFrom(value: unknown): ValueRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ValueRecord)
    : {};
}

function errorCode(error: unknown): unknown {
  return recordFrom(error).code;
}

const logger = {
  info(message: string, details?: ValueRecord): void {
    runtime().logger.info(message, details);
  },
};

function getUserById(ownerId: string, projection: string): Promise<UserRecord | null> {
  return runtime().getUserById(ownerId, projection);
}

function getMCPServersRegistry() {
  return { getAllServerConfigs: runtime().getAllServerConfigs };
}

function mintBrokerGrant(input: ValueRecord): MintedGrant {
  return runtime().mintBrokerGrant(input);
}

function persistBrokerGrantResources(grant: MintedGrant): Promise<unknown> {
  return runtime().persistBrokerGrantResources(grant);
}

function collectServerProjection(input: ValueRecord): ProjectionResult {
  return runtime().collectServerProjection(input);
}

function isBrokerProjectionEnabled(): boolean {
  return runtime().isBrokerProjectionEnabled();
}

function shouldGrantContentReadScope(entries: ProjectionEntry[]): boolean {
  return runtime().shouldGrantContentReadScope(entries);
}

const AUTHORIZATION_COLLECTION = 'viventium_glasshive_capability_authorizations';
const NONCE_COLLECTION = 'viventium_glasshive_admission_nonces';
const ADMISSION_VERSION = 'v1';
const MAX_AUTHORIZATION_SECONDS = 24 * 60 * 60;
const AUTHORIZATION_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const MAX_ADMISSION_SKEW_SECONDS = 60;
const DEFAULT_RESOURCE_MAX_BYTES = 512 * 1024;
const SIMPLE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{7,191}$/;
const CONTAINER_GENERATION_ID = /^[a-f0-9]{64}$/;
let indexesPromise: Promise<unknown[]> | undefined;

export class CapabilityAuthorizationError extends Error {
  code: string;
  status: number;
  needsInput: boolean;

  constructor(
    code: string,
    message: string,
    { status = 409, needsInput = true }: { status?: number; needsInput?: boolean } = {},
  ) {
    super(message);
    this.name = 'CapabilityAuthorizationError';
    this.code = code;
    this.status = status;
    this.needsInput = needsInput;
  }
}

function authorizationCollection(): CollectionPort {
  return runtime().collection(AUTHORIZATION_COLLECTION);
}

function nonceCollection(): CollectionPort {
  return runtime().collection(NONCE_COLLECTION);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = recordFrom(value);
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function scopeFingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(stableJson(value)).digest('base64url');
}

function admissionSecret(): string {
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

function authorizationHorizonSeconds(): number {
  const configured = Number(process.env.VIVENTIUM_GLASSHIVE_AUTHORIZATION_HORIZON_SECONDS);
  if (!Number.isFinite(configured) || configured <= 0) return MAX_AUTHORIZATION_SECONDS;
  return Math.max(60, Math.min(Math.floor(configured), MAX_AUTHORIZATION_SECONDS));
}

async function ensureIndexes(): Promise<unknown[]> {
  if (!indexesPromise) {
    indexesPromise = (async () => {
      const collection = authorizationCollection();
      /* === VIVENTIUM START ===
       * Feature: Explicit 24-hour same-scope mission reauthorization.
       * Purpose: Older installs used maxExpiresAt as a TTL and physically deleted the record at
       * the first horizon, making authenticated Resume impossible. Remove only that legacy TTL,
       * backfill a separate retention horizon, then create the durable indexes.
       * === VIVENTIUM END === */
      let indexes: IndexRecord[] = [];
      try {
        indexes = await collection.indexes();
      } catch (error) {
        const details = recordFrom(error);
        if (
          ![26, 'NamespaceNotFound'].includes(details.code as number | string) &&
          details.codeName !== 'NamespaceNotFound'
        ) {
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
            const details = recordFrom(error);
            if (
              ![27, 'IndexNotFound'].includes(details.code as number | string) &&
              details.codeName !== 'IndexNotFound'
            ) {
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

function normalizedStrings(values: unknown): string[] {
  const items = Array.isArray(values) ? values : [];
  return Array.from(
    new Set(items.map((value: unknown) => String(value || '').trim()).filter(Boolean)),
  ).sort();
}

function copyJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(JSON.stringify(value ?? fallback)) as T;
  } catch {
    return fallback;
  }
}

function scopedHostToolResources(resources: unknown, allowedHostTools: string[]): ValueRecord {
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) return {};
  const source = resources as ValueRecord;
  const result: ValueRecord = {};
  for (const toolName of allowedHostTools) {
    const value = source[toolName];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const copied = copyJson<ValueRecord | null>(value, null);
    if (copied) result[toolName] = copied;
  }
  const configured = Number(process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_RESOURCE_MAX_BYTES);
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

export async function createCapabilityAuthorization({
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
}: CreateAuthorizationInput = {}) {
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
  const existing = await authorizationCollection().findOne({
    ownerId,
    originRef: normalizedOriginRef,
  });
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
  const record: AuthorizationRecord = {
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
    if (errorCode(error) !== 11000) throw error;
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

export async function prepareScheduledProviderAuthorization({
  ownerId,
  originRef,
  workRef,
  workerId,
  runId,
  containerGenerationId,
  allowedServers,
  allowedHostTools,
  contentReadScope,
  executionMode,
  requestContext,
  brokerUrl,
  nowMs = Date.now(),
}: ScheduledAuthorizationInput = {}) {
  const identity = [ownerId, originRef, workRef, workerId, runId].map((value) =>
    String(value || '').trim(),
  );
  const [owner, origin, work, worker, run] = identity;
  const generation = String(containerGenerationId || '').trim();
  const contextKeys =
    requestContext && typeof requestContext === 'object' && !Array.isArray(requestContext)
      ? Object.keys(requestContext)
      : [];
  const context = recordFrom(requestContext);
  const providerOnly =
    Array.isArray(allowedServers) &&
    allowedServers.length === 0 &&
    Array.isArray(allowedHostTools) &&
    allowedHostTools.length === 0 &&
    contentReadScope === false;
  const exactContext =
    contextKeys.length === 2 &&
    contextKeys.includes('message_id') &&
    contextKeys.includes('turn_id') &&
    String(context.message_id || '') === origin &&
    String(context.turn_id || '') === origin;
  if (
    identity.some((value) => !SIMPLE_REF.test(value)) ||
    work !== origin ||
    !CONTAINER_GENERATION_ID.test(generation) ||
    !providerOnly ||
    executionMode !== 'docker' ||
    !exactContext ||
    typeof brokerUrl !== 'string' ||
    !brokerUrl.trim() ||
    brokerUrl.length > 2048
  ) {
    throw new CapabilityAuthorizationError(
      'capability_scheduled_prepare_request_invalid',
      'The scheduled provider authorization request is invalid.',
      { status: 400, needsInput: false },
    );
  }
  const user = await getUserById(owner, '-password -__v -totpSecret -backupCodes').catch(
    () => null,
  );
  const loadedOwner = String(user?.id || user?._id || '').trim();
  if (!user || loadedOwner !== owner) {
    throw new CapabilityAuthorizationError(
      'capability_scheduled_prepare_owner_unavailable',
      'The scheduled provider authorization owner is unavailable.',
      { status: 404, needsInput: false },
    );
  }
  const authorization = await createCapabilityAuthorization({
    user: { ...user, id: owner },
    originRef: origin,
    allowedServers: [],
    allowedHostTools: [],
    hostToolResources: {},
    contentReadScope: false,
    executionMode: 'docker',
    requestContext: {
      message_id: origin,
      turn_id: origin,
    },
    brokerUrl: brokerUrl.trim(),
    nowMs,
  });
  return Object.freeze({
    status: 'prepared',
    ownerId: owner,
    originRef: origin,
    workRef: work,
    workerId: worker,
    runId: run,
    containerGenerationId: generation,
    authorizationRef: String(authorization.authorizationRef || ''),
    scopeFingerprint: String(authorization.scopeFingerprint || ''),
    brokerUrl: String(authorization.brokerUrl || ''),
    maxExpiresAt: new Date(authorization.maxExpiresAt).toISOString(),
  });
}

function admissionSigningInput({ timestamp, nonce, body }: AdmissionSigningInput): string {
  return `${ADMISSION_VERSION}\n${timestamp}\n${nonce}\n${stableJson(body)}`;
}

export function createAdmissionSignature({
  body,
  nowMs = Date.now(),
  nonce = crypto.randomUUID(),
}: AdmissionInput = {}): string {
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

export async function verifyAndConsumeAdmission({
  body,
  header,
  nowMs = Date.now(),
}: VerifyAdmissionInput = {}): Promise<void> {
  const parts = String(header || '')
    .trim()
    .split(':');
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
    if (errorCode(error) === 11000) {
      throw new CapabilityAuthorizationError(
        'capability_admission_replayed',
        'The GlassHive capability admission request has already been used.',
        { status: 409, needsInput: false },
      );
    }
    throw error;
  }
}

async function revalidateAuthorization(record: AuthorizationRecord): Promise<UserRecord> {
  if (!isBrokerProjectionEnabled()) {
    throw new CapabilityAuthorizationError(
      'capability_policy_changed',
      'Connected capabilities are no longer available for this mission.',
    );
  }
  const user = await getUserById(record.ownerId, '-password -__v -totpSecret -backupCodes').catch(
    () => null,
  );
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
  const currentServers = normalizedStrings(
    projection.allowedEntries.map(({ serverName }) => serverName),
  );
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

export async function admitCapabilityAuthorization({
  authorizationRef,
  originRef,
  workRef,
  workerId,
  runId,
  containerGenerationId,
  nowMs = Date.now(),
}: AdmitAuthorizationInput = {}) {
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
  const normalizedContainerGeneration = String(containerGenerationId || '')
    .trim()
    .toLowerCase();
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
  if (
    record.workRef &&
    (record.workRef !== normalizedWork || record.workerId !== normalizedWorker)
  ) {
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
    // This bearer is still exact-run, exact-worker, and exact-container scoped,
    // checked against the active authorization on every request, and revoked at
    // terminal cleanup. Keep it valid for the remaining reviewed horizon so a
    // legitimate long-running mission cannot lose authority halfway through.
    ttlSeconds: Math.min(remainingSeconds, MAX_AUTHORIZATION_SECONDS),
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

export async function assertActiveCapabilityAuthorizationGrant(grant: ValueRecord = {}) {
  const authorizationRef = String(grant.authorization_ref || '').trim();
  const grantId = String(grant.grant_id || '').trim();
  const ownerId = String(grant.user_id || '').trim();
  const workerId = String(grant.worker_id || '').trim();
  const runId = String(grant.run_id || '').trim();
  const containerGenerationId = String(grant.container_generation_id || '')
    .trim()
    .toLowerCase();
  if (
    !SIMPLE_REF.test(authorizationRef) ||
    !SIMPLE_REF.test(grantId) ||
    !ownerId ||
    ownerId.length > 192 ||
    !SIMPLE_REF.test(workerId) ||
    !SIMPLE_REF.test(runId) ||
    !CONTAINER_GENERATION_ID.test(containerGenerationId)
  ) {
    throw inactiveGrantError();
  }
  const record = await authorizationCollection().findOne({
    _id: authorizationRef,
    ownerId,
    status: 'active',
    currentGrantId: grantId,
    workerId,
    currentRunId: runId,
    currentContainerGenerationId: containerGenerationId,
  });
  if (!record || new Date(record.maxExpiresAt).getTime() <= Date.now()) {
    throw inactiveGrantError();
  }
  if (
    !SIMPLE_REF.test(String(record.originRef || '')) ||
    !SIMPLE_REF.test(String(record.workRef || ''))
  ) {
    throw inactiveGrantError();
  }
  return Object.freeze({
    authorizationRef,
    ownerId,
    originRef: String(record.originRef),
    workRef: String(record.workRef),
    workerId,
    runId,
    grantId,
  });
}

export async function revokeCapabilityAuthorizationGrant({
  authorizationRef,
  originRef,
  workRef,
  workerId,
  runId,
  containerGenerationId,
  grantId,
}: RevokeAuthorizationInput = {}) {
  const identifiers = [authorizationRef, originRef, workRef, workerId, runId, grantId].map(
    (value) => String(value || '').trim(),
  );
  const generation = String(containerGenerationId || '')
    .trim()
    .toLowerCase();
  if (
    identifiers.some((value) => !SIMPLE_REF.test(value)) ||
    !CONTAINER_GENERATION_ID.test(generation)
  ) {
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
export async function reauthorizeCapabilityAuthorization({
  ownerId,
  workRef,
  nowMs = Date.now(),
}: ReauthorizeInput = {}) {
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
  if (!record || record.lastNeedsInputCode !== 'capability_authorization_horizon_expired') {
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

export function resetCapabilityAuthorizationIndexesForTests(): void {
  indexesPromise = undefined;
}
