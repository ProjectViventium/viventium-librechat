import crypto from 'node:crypto';
import { glassHiveAccountUrl } from './accountUrl';

/* === VIVENTIUM START ===
 * Feature: Trusted GlassHive account API client.
 * Purpose: Keep owner authority out of model/tool arguments and bind every authenticated request
 * to the configured provider origin.
 * === VIVENTIUM END === */

const ASSERTION_AUDIENCE = 'glasshive-account-api';
const ASSERTION_TTL_SECONDS = 60;
const MAX_RESPONSE_BYTES = 256 * 1024;
const ASSERTION_NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{7,191}$/;

type UnknownRecord = Record<string, unknown>;
export type AccountFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TrustedDelegationIdentityInput {
  call_identity_digest?: unknown;
  goal_digest?: unknown;
  idempotency_key?: unknown;
  launch_payload_digest?: unknown;
  objective_ordinal?: unknown;
  source_event_id?: unknown;
  version?: unknown;
}

export interface TrustedDelegationInput {
  ownerId?: unknown;
  sourceEventId?: unknown;
  objectiveOrdinal?: unknown;
  callIdentityDigest?: unknown;
  goal?: unknown;
}

export interface TrustedActionInput {
  ownerId?: unknown;
  workRef?: unknown;
  action?: unknown;
  operationId?: unknown;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordFrom(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function requiredEnv(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value || value.includes('${')) {
    throw new Error(`${name}_not_configured`);
  }
  return value;
}

function configuredTenantId(): string {
  return String(process.env.VIVENTIUM_TENANT_ID || 'local').trim() || 'local';
}

export function signTrustedDelegationIdentity(
  identity: TrustedDelegationIdentityInput = {},
  options: { ownerId?: unknown; tenantId?: unknown } = {},
): string {
  const normalizedOwnerId = String(options.ownerId || '').trim();
  const normalizedTenantId = String(options.tenantId || configuredTenantId()).trim();
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

export function createServiceAssertion({
  ownerId,
  nowMs = Date.now(),
  nonce = crypto.randomUUID(),
}: {
  ownerId?: unknown;
  nowMs?: number;
  nonce?: unknown;
}): string {
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

  // GlassHive verifies the exact canonical byte representation, not merely the decoded claims.
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

export async function requestAccountApi({
  ownerId,
  path,
  method = 'GET',
  body,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
}: {
  ownerId?: unknown;
  path: string;
  method?: string;
  body?: unknown;
  fetchImpl?: AccountFetch;
  timeoutMs?: number;
}): Promise<unknown> {
  if (typeof fetchImpl !== 'function') {
    throw new Error('glasshive_account_fetch_unavailable');
  }

  const url = glassHiveAccountUrl(requiredEnv('GLASSHIVE_PROVIDER_BASE_URL'), path);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${requiredEnv('WPR_API_TOKEN')}`,
    'X-Viventium-Service-Assertion': createServiceAssertion({ ownerId }),
  };
  if (body != null) {
    headers['Content-Type'] = 'application/json';
  }

  const abortSignalConstructor = AbortSignal as typeof AbortSignal & {
    timeout?: (milliseconds: number) => AbortSignal;
  };
  const response = await fetchImpl(url, {
    method,
    redirect: 'error',
    headers,
    ...(body != null ? { body: JSON.stringify(body) } : {}),
    ...(typeof abortSignalConstructor.timeout === 'function'
      ? { signal: abortSignalConstructor.timeout(timeoutMs) }
      : {}),
  });
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const contentLength = Number(response.headers.get('content-length'));
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('glasshive_account_response_invalid');
  }

  if (!response.ok) {
    const parsedRecord = recordFrom(parsed);
    const structured = parsedRecord.detail || parsedRecord.error || parsed;
    const structuredRecord = recordFrom(structured);
    const declaredCode = String(structuredRecord.code || '').trim();
    const code = /^[a-z0-9_.-]{1,120}$/.test(declaredCode)
      ? declaredCode
      : 'glasshive_account_rejected';
    throw Object.assign(new Error(code), {
      code,
      status: Number(response.status) || 502,
      body: parsed,
      userMessage: typeof structuredRecord.message === 'string' ? structuredRecord.message : '',
    });
  }

  return parsed;
}

export function buildTrustedDelegationIdentity({
  ownerId,
  sourceEventId,
  objectiveOrdinal,
  callIdentityDigest = '',
  goal,
}: TrustedDelegationInput): { idempotencyKey: string; goalDigest: string } {
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
  const objectiveIdentity = normalizedCallIdentityDigest
    ? `call:${normalizedCallIdentityDigest}`
    : `ordinal:${ordinal}`;
  const idempotencyKey = crypto
    .createHash('sha256')
    .update(
      `${tenantId}\0${normalizedOwner}\0${normalizedSourceEvent}\0${objectiveIdentity}\0${goalDigest}`,
    )
    .digest('hex');
  return { idempotencyKey, goalDigest };
}

export function buildTrustedActionIdempotencyKey({
  ownerId,
  workRef,
  action,
  operationId,
}: TrustedActionInput): string {
  const tenantId = configuredTenantId();
  const values = [ownerId, workRef, action, operationId].map((value) => String(value || '').trim());
  if (values.some((value) => !value)) {
    throw new Error('trusted_action_identity_invalid');
  }
  return crypto
    .createHash('sha256')
    .update([tenantId, ...values].join('\0'))
    .digest('hex');
}
