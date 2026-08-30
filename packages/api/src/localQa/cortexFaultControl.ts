/* === VIVENTIUM START ===
 * Feature: EMO-UC-048 deterministic local-QA fault controls.
 * Purpose: Validate, scope, expire, and atomically consume one-time fault capabilities.
 * === VIVENTIUM END === */

import { createHash } from 'crypto';
import { CORTEX_LOCAL_QA_FAULT_BOUNDARIES } from '@librechat/data-schemas';
import type {
  CortexLocalQaFaultState,
  CortexLocalQaFaultBoundary,
  CortexLocalQaFaultAuditEventName,
} from '@librechat/data-schemas';

export { CORTEX_LOCAL_QA_FAULT_BOUNDARIES };
export type {
  CortexLocalQaFaultState,
  CortexLocalQaFaultBoundary,
  CortexLocalQaFaultAuditEventName,
};

export interface CortexLocalQaFaultAuditEvent {
  sequence: number;
  event: CortexLocalQaFaultAuditEventName;
  at: string;
}

export interface CortexLocalQaFaultControlRow {
  schemaVersion: 1;
  controlId: string;
  capabilityKey: string;
  caseTokenHash: string;
  componentArtifactDigest: string;
  boundary: CortexLocalQaFaultBoundary;
  ownerScopeHash: string;
  conversationScopeHash: string;
  parentScopeHash: string;
  syntheticScope: true;
  state: CortexLocalQaFaultState | 'inconsistent';
  inconsistency?: 'control_projection_missing';
  armedAt: string;
  expiresAt: string;
  purgeAt: string;
  consumedAt?: string;
  clearedAt?: string;
  audit: CortexLocalQaFaultAuditEvent[];
}

interface FaultScopeHashes {
  ownerScopeHash: string;
  conversationScopeHash: string;
  parentScopeHash: string;
}

interface FaultStoreBindingQuery extends FaultScopeHashes {
  caseTokenHash: string;
  componentArtifactDigest: string;
}

interface CortexLocalQaFaultTransitionIdentity extends FaultStoreBindingQuery {
  schemaVersion: 1;
  controlId: string;
  capabilityKey: string;
  boundary: CortexLocalQaFaultBoundary;
  syntheticScope: true;
  state: 'armed';
  armedAt: string;
  expiresAt: string;
  purgeAt: string;
}

export interface CortexLocalQaFaultConsumeQuery extends CortexLocalQaFaultTransitionIdentity {
  at: string;
  auditEvent: CortexLocalQaFaultAuditEvent;
}

export interface CortexLocalQaFaultExpireQuery extends CortexLocalQaFaultTransitionIdentity {
  at: string;
  auditEvent: CortexLocalQaFaultAuditEvent;
}

export interface CortexLocalQaFaultScopeQuery extends FaultStoreBindingQuery {
  boundary?: CortexLocalQaFaultBoundary;
}

export interface CortexLocalQaFaultClearQuery extends CortexLocalQaFaultTransitionIdentity {
  at: string;
  auditEvent: CortexLocalQaFaultAuditEvent;
}

export interface CortexLocalQaFaultControlStore {
  insert(row: CortexLocalQaFaultControlRow): Promise<CortexLocalQaFaultControlRow>;
  consume(query: CortexLocalQaFaultConsumeQuery): Promise<CortexLocalQaFaultControlRow | null>;
  expire(query: CortexLocalQaFaultExpireQuery): Promise<number>;
  clear(query: CortexLocalQaFaultClearQuery): Promise<number>;
  list(query: CortexLocalQaFaultScopeQuery): Promise<CortexLocalQaFaultControlRow[]>;
}

export interface CortexLocalQaFaultScope {
  ownerId: string;
  conversationId: string;
  parentMessageId: string;
}

export interface ArmCortexLocalQaFaultInput extends CortexLocalQaFaultScope {
  boundary: CortexLocalQaFaultBoundary;
  expiresInMs?: number;
}

export interface QueryCortexLocalQaFaultInput extends CortexLocalQaFaultScope {
  boundary?: CortexLocalQaFaultBoundary;
}

export interface ConsumeCortexLocalQaFaultInput extends CortexLocalQaFaultScope {
  boundary: CortexLocalQaFaultBoundary;
}

export interface CortexLocalQaFaultControlView {
  controlId: string;
  boundary: CortexLocalQaFaultBoundary;
  ownerScopeHash: string;
  conversationScopeHash: string;
  parentScopeHash: string;
  syntheticScope: true;
  state: CortexLocalQaFaultState | 'inconsistent';
  inconsistency?: 'control_projection_missing';
  armedAt: string;
  expiresAt: string;
  purgeAt: string;
  consumedAt?: string;
  clearedAt?: string;
  audit: CortexLocalQaFaultAuditEvent[];
}

export type CortexLocalQaFaultConsumeResult =
  | { triggered: true; controlId: string; boundary: CortexLocalQaFaultBoundary }
  | { triggered: false; reason: 'disabled' | 'invalid_token' | 'invalid_scope' | 'not_armed' };

export interface CortexLocalQaFaultControlManager {
  arm(input: ArmCortexLocalQaFaultInput): Promise<CortexLocalQaFaultControlView>;
  query(input: QueryCortexLocalQaFaultInput): Promise<CortexLocalQaFaultControlView[]>;
  clear(input: QueryCortexLocalQaFaultInput): Promise<{ cleared: number }>;
  consume(input: ConsumeCortexLocalQaFaultInput): Promise<CortexLocalQaFaultConsumeResult>;
}

export interface CortexLocalQaSyntheticScopeVerification {
  scope: CortexLocalQaFaultScope;
  caseTokenHash: string;
  componentArtifactDigest: string;
  ownerScopeHash: string;
  conversationScopeHash: string;
  parentScopeHash: string;
  armedAt: string;
  expiresAt: string;
}

export type CortexLocalQaSyntheticScopeVerifier = (
  verification: CortexLocalQaSyntheticScopeVerification,
) => Promise<boolean>;

interface CortexLocalQaFaultManagerOptions {
  store: CortexLocalQaFaultControlStore;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  randomUUID?: () => string;
  verifySyntheticScope?: CortexLocalQaSyntheticScopeVerifier;
}

const MODE = 'emo_uc_048';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CONTROL_ID_PATTERN = /^emo048_[A-Za-z0-9-]{16,80}$/;
const ISO_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/;
const MIN_EXPIRY_MS = 1_000;
const DEFAULT_EXPIRY_MS = 15 * 60 * 1_000;
const MAX_EXPIRY_MS = 60 * 60 * 1_000;
const AUDIT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_SCOPE_LENGTH = 256;
const BOUNDARIES = new Set<CortexLocalQaFaultBoundary>(CORTEX_LOCAL_QA_FAULT_BOUNDARIES);

function faultControlError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function capabilityKey(
  row: FaultStoreBindingQuery & { boundary: CortexLocalQaFaultBoundary },
): string {
  return sha256(
    [
      'emo-uc-048-capability',
      row.caseTokenHash,
      row.componentArtifactDigest,
      row.boundary,
      row.ownerScopeHash,
      row.conversationScopeHash,
      row.parentScopeHash,
    ].join('\u0000'),
  );
}

function normalizeScopePart(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .trim();
}

function validScopePart(value: string): boolean {
  const normalized = normalizeScopePart(value);
  return normalized.length > 0 && normalized.length <= MAX_SCOPE_LENGTH;
}

function scopeHashes(scope: CortexLocalQaFaultScope): FaultScopeHashes | null {
  if (
    !validScopePart(scope.ownerId) ||
    !validScopePart(scope.conversationId) ||
    !validScopePart(scope.parentMessageId)
  ) {
    return null;
  }
  return {
    ownerScopeHash: sha256(`owner\u0000${normalizeScopePart(scope.ownerId)}`),
    conversationScopeHash: sha256(`conversation\u0000${normalizeScopePart(scope.conversationId)}`),
    parentScopeHash: sha256(`parent\u0000${normalizeScopePart(scope.parentMessageId)}`),
  };
}

function validCaseToken(token: string): boolean {
  if (!TOKEN_PATTERN.test(token)) return false;
  const decoded = Buffer.from(token, 'base64url');
  return decoded.byteLength >= 32 && decoded.toString('base64url') === token;
}

function isBoundary(value: string | undefined): value is CortexLocalQaFaultBoundary {
  return Boolean(value && BOUNDARIES.has(value as CortexLocalQaFaultBoundary));
}

function canonicalTimestamp(value: Date): string {
  return value.toISOString().replace(/Z$/, '+00:00');
}

function validDate(value: string | undefined): boolean {
  if (!value || !ISO_MILLIS_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && canonicalTimestamp(parsed) === value;
}

function validRow(row: CortexLocalQaFaultControlRow): boolean {
  const structural =
    row?.schemaVersion === 1 &&
    CONTROL_ID_PATTERN.test(row.controlId) &&
    HASH_PATTERN.test(row.capabilityKey) &&
    HASH_PATTERN.test(row.caseTokenHash) &&
    HASH_PATTERN.test(row.componentArtifactDigest) &&
    isBoundary(row.boundary) &&
    HASH_PATTERN.test(row.ownerScopeHash) &&
    HASH_PATTERN.test(row.conversationScopeHash) &&
    HASH_PATTERN.test(row.parentScopeHash) &&
    row.syntheticScope === true &&
    ['armed', 'consumed', 'cleared', 'expired', 'inconsistent'].includes(row.state) &&
    validDate(row.armedAt) &&
    validDate(row.expiresAt) &&
    validDate(row.purgeAt) &&
    Array.isArray(row.audit) &&
    row.audit.length >= 1 &&
    row.audit.length <= 3;
  if (!structural || row.capabilityKey !== capabilityKey(row)) return false;
  const armedAt = new Date(row.armedAt).getTime();
  const expiresAt = new Date(row.expiresAt).getTime();
  const purgeAt = new Date(row.purgeAt).getTime();
  if (
    expiresAt - armedAt < MIN_EXPIRY_MS ||
    expiresAt - armedAt > MAX_EXPIRY_MS ||
    purgeAt - expiresAt !== AUDIT_RETENTION_MS ||
    row.audit.some(
      (event, index) =>
        event.sequence !== index + 1 ||
        !['armed', 'consumed', 'cleared', 'expired'].includes(event.event) ||
        !validDate(event.at),
    ) ||
    row.audit[0].event !== 'armed' ||
    new Date(row.audit[0].at).getTime() !== armedAt
  ) {
    return false;
  }
  if (row.state === 'armed' || row.state === 'inconsistent') {
    return (
      row.audit.length === 1 &&
      !row.consumedAt &&
      !row.clearedAt &&
      (row.state === 'inconsistent'
        ? row.inconsistency === 'control_projection_missing'
        : row.inconsistency == null)
    );
  }
  if (row.inconsistency != null) return false;
  if (row.audit.length !== 2 || row.audit[1].event !== row.state) return false;
  const transitionAt = new Date(row.audit[1].at).getTime();
  if (transitionAt < armedAt) return false;
  if (row.state === 'consumed') {
    return (
      validDate(row.consumedAt) &&
      new Date(row.consumedAt as string).getTime() === transitionAt &&
      transitionAt < expiresAt &&
      !row.clearedAt
    );
  }
  if (row.state === 'cleared') {
    return (
      validDate(row.clearedAt) &&
      new Date(row.clearedAt as string).getTime() === transitionAt &&
      transitionAt < expiresAt &&
      !row.consumedAt
    );
  }
  return transitionAt >= expiresAt && !row.consumedAt && !row.clearedAt;
}

function redact(row: CortexLocalQaFaultControlRow): CortexLocalQaFaultControlView {
  return Object.freeze({
    controlId: row.controlId,
    boundary: row.boundary,
    ownerScopeHash: row.ownerScopeHash,
    conversationScopeHash: row.conversationScopeHash,
    parentScopeHash: row.parentScopeHash,
    syntheticScope: true,
    state: row.state,
    ...(row.inconsistency ? { inconsistency: row.inconsistency } : {}),
    armedAt: row.armedAt,
    expiresAt: row.expiresAt,
    purgeAt: row.purgeAt,
    ...(row.consumedAt ? { consumedAt: row.consumedAt } : {}),
    ...(row.clearedAt ? { clearedAt: row.clearedAt } : {}),
    audit: row.audit.map((event) => ({ ...event })),
  });
}

function configuredToken(env: NodeJS.ProcessEnv): string {
  return String(env.VIVENTIUM_LOCAL_QA_CASE_TOKEN || '').trim();
}

function assertControlAuthority(env: NodeJS.ProcessEnv): string {
  if (String(env.VIVENTIUM_LOCAL_QA_MODE || '').trim() !== MODE) {
    throw faultControlError(
      'cortex_local_qa_fault_controls_disabled',
      'EMO-UC-048 local-QA fault controls are disabled',
    );
  }
  const token = configuredToken(env);
  if (!validCaseToken(token)) {
    throw faultControlError(
      'cortex_local_qa_case_token_invalid',
      'EMO-UC-048 local-QA case token is invalid',
    );
  }
  return token;
}

function assertComponentArtifactDigest(env: NodeJS.ProcessEnv): string {
  const digest = String(env.VIVENTIUM_LOCAL_QA_COMPONENT_ARTIFACT_DIGEST || '').trim();
  if (!HASH_PATTERN.test(digest)) {
    throw faultControlError(
      'cortex_local_qa_component_artifact_invalid',
      'EMO-UC-048 local-QA component artifact identity is invalid',
    );
  }
  return digest;
}

function assertScope(scope: CortexLocalQaFaultScope): FaultScopeHashes {
  const hashes = scopeHashes(scope);
  if (!hashes) {
    throw faultControlError(
      'cortex_local_qa_scope_invalid',
      'EMO-UC-048 local-QA scope is invalid',
    );
  }
  return hashes;
}

function assertBoundary(boundary: string | undefined): CortexLocalQaFaultBoundary {
  if (!isBoundary(boundary)) {
    throw faultControlError(
      'cortex_local_qa_boundary_invalid',
      'EMO-UC-048 local-QA boundary is invalid',
    );
  }
  return boundary;
}

function expiryMs(value: number | undefined): number {
  const normalized = value ?? DEFAULT_EXPIRY_MS;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < MIN_EXPIRY_MS ||
    normalized > MAX_EXPIRY_MS
  ) {
    throw faultControlError(
      'cortex_local_qa_expiry_invalid',
      'EMO-UC-048 local-QA expiry is outside the allowed range',
    );
  }
  return normalized;
}

function duplicateControl(error: object): boolean {
  return Number((error as { code?: number }).code) === 11000;
}

export function createCortexLocalQaFaultControlManager({
  store,
  env = process.env,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  verifySyntheticScope = async () => false,
}: CortexLocalQaFaultManagerOptions): CortexLocalQaFaultControlManager {
  const authority = () => {
    const token = assertControlAuthority(env);
    return {
      caseTokenHash: sha256(`case-token\u0000${token}`),
      componentArtifactDigest: assertComponentArtifactDigest(env),
    };
  };

  const transitionIdentity = (
    row: CortexLocalQaFaultControlRow,
  ): CortexLocalQaFaultTransitionIdentity => ({
    schemaVersion: 1,
    controlId: row.controlId,
    capabilityKey: row.capabilityKey,
    caseTokenHash: row.caseTokenHash,
    componentArtifactDigest: row.componentArtifactDigest,
    boundary: row.boundary,
    ownerScopeHash: row.ownerScopeHash,
    conversationScopeHash: row.conversationScopeHash,
    parentScopeHash: row.parentScopeHash,
    syntheticScope: true,
    state: 'armed',
    armedAt: row.armedAt,
    expiresAt: row.expiresAt,
    purgeAt: row.purgeAt,
  });

  const currentBindingIsValid = async (
    scope: CortexLocalQaFaultScope,
    binding: FaultStoreBindingQuery,
    at: string,
  ): Promise<boolean> => {
    try {
      return (
        (await verifySyntheticScope({
          scope: {
            ownerId: normalizeScopePart(scope.ownerId),
            conversationId: normalizeScopePart(scope.conversationId),
            parentMessageId: normalizeScopePart(scope.parentMessageId),
          },
          ...binding,
          armedAt: at,
          expiresAt: at,
        })) === true
      );
    } catch {
      return false;
    }
  };

  const listAndExpire = async (
    query: CortexLocalQaFaultScopeQuery,
    at: string,
  ): Promise<CortexLocalQaFaultControlRow[]> => {
    const rows = (await store.list(query)).filter(validRow);
    let changed = false;
    for (const row of rows) {
      if (
        (row.state !== 'armed' && row.state !== 'inconsistent') ||
        new Date(row.expiresAt).getTime() > new Date(at).getTime()
      ) {
        continue;
      }
      const expired = await store.expire({
        ...transitionIdentity(row),
        at,
        auditEvent: { sequence: 2, event: 'expired', at },
      });
      changed = changed || expired === 1;
    }
    return changed ? (await store.list(query)).filter(validRow) : rows;
  };

  const query = async (
    input: QueryCortexLocalQaFaultInput,
  ): Promise<CortexLocalQaFaultControlView[]> => {
    const { caseTokenHash, componentArtifactDigest } = authority();
    const hashes = assertScope(input);
    const boundary = input.boundary ? assertBoundary(input.boundary) : undefined;
    const at = canonicalTimestamp(now());
    const binding = { caseTokenHash, componentArtifactDigest, ...hashes };
    if (!(await currentBindingIsValid(input, binding, at))) return [];
    const rows = await listAndExpire(
      {
        ...binding,
        ...(boundary ? { boundary } : {}),
      },
      at,
    );
    return rows.map(redact);
  };

  return Object.freeze({
    async arm(input: ArmCortexLocalQaFaultInput): Promise<CortexLocalQaFaultControlView> {
      const { caseTokenHash, componentArtifactDigest } = authority();
      const hashes = assertScope(input);
      const boundary = assertBoundary(input.boundary);
      const armedAt = now();
      const expiresAt = new Date(armedAt.getTime() + expiryMs(input.expiresInMs));
      let fixtureVerified = false;
      try {
        fixtureVerified =
          (await verifySyntheticScope({
            scope: {
              ownerId: normalizeScopePart(input.ownerId),
              conversationId: normalizeScopePart(input.conversationId),
              parentMessageId: normalizeScopePart(input.parentMessageId),
            },
            caseTokenHash,
            componentArtifactDigest,
            ...hashes,
            armedAt: canonicalTimestamp(armedAt),
            expiresAt: canonicalTimestamp(expiresAt),
          })) === true;
      } catch {
        fixtureVerified = false;
      }
      if (!fixtureVerified) {
        throw faultControlError(
          'cortex_local_qa_synthetic_fixture_unverified',
          'EMO-UC-048 local-QA durable synthetic fixture is not verified',
        );
      }
      const row: CortexLocalQaFaultControlRow = {
        schemaVersion: 1,
        controlId: `emo048_${randomUUID()}`,
        capabilityKey: capabilityKey({
          caseTokenHash,
          componentArtifactDigest,
          boundary,
          ...hashes,
        }),
        caseTokenHash,
        componentArtifactDigest,
        boundary,
        ...hashes,
        syntheticScope: true,
        state: 'armed',
        armedAt: canonicalTimestamp(armedAt),
        expiresAt: canonicalTimestamp(expiresAt),
        purgeAt: canonicalTimestamp(new Date(expiresAt.getTime() + AUDIT_RETENTION_MS)),
        audit: [{ sequence: 1, event: 'armed', at: canonicalTimestamp(armedAt) }],
      };
      try {
        const persisted = await store.insert(row);
        if (!validRow(persisted)) {
          throw faultControlError(
            'cortex_local_qa_fault_control_invalid',
            'EMO-UC-048 local-QA durable control is invalid',
          );
        }
        return redact(persisted);
      } catch (error) {
        if (!duplicateControl(error as object)) throw error;
        throw faultControlError(
          'cortex_local_qa_fault_already_exists',
          'This EMO-UC-048 boundary already has a control for the current case',
        );
      }
    },
    query,
    async clear(input: QueryCortexLocalQaFaultInput): Promise<{ cleared: number }> {
      const { caseTokenHash, componentArtifactDigest } = authority();
      const hashes = assertScope(input);
      const boundary = input.boundary ? assertBoundary(input.boundary) : undefined;
      const at = canonicalTimestamp(now());
      const binding = { caseTokenHash, componentArtifactDigest, ...hashes };
      if (!(await currentBindingIsValid(input, binding, at))) return { cleared: 0 };
      const rows = await listAndExpire(
        {
          ...binding,
          ...(boundary ? { boundary } : {}),
        },
        at,
      );
      let cleared = 0;
      for (const row of rows) {
        if (
          (row.state !== 'armed' && row.state !== 'inconsistent') ||
          new Date(row.expiresAt).getTime() <= new Date(at).getTime()
        ) {
          continue;
        }
        cleared += await store.clear({
          ...transitionIdentity(row),
          at,
          auditEvent: { sequence: 2, event: 'cleared', at },
        });
      }
      return { cleared };
    },
    async consume(input: ConsumeCortexLocalQaFaultInput): Promise<CortexLocalQaFaultConsumeResult> {
      if (String(env.VIVENTIUM_LOCAL_QA_MODE || '').trim() !== MODE) {
        return { triggered: false, reason: 'disabled' };
      }
      const token = configuredToken(env);
      if (!validCaseToken(token)) return { triggered: false, reason: 'invalid_token' };
      const componentArtifactDigest = String(
        env.VIVENTIUM_LOCAL_QA_COMPONENT_ARTIFACT_DIGEST || '',
      ).trim();
      if (!HASH_PATTERN.test(componentArtifactDigest)) {
        return { triggered: false, reason: 'not_armed' };
      }
      const hashes = scopeHashes(input);
      if (!hashes || !isBoundary(input.boundary)) {
        return { triggered: false, reason: 'invalid_scope' };
      }
      const caseTokenHash = sha256(`case-token\u0000${token}`);
      const at = canonicalTimestamp(now());
      let row: CortexLocalQaFaultControlRow | null;
      try {
        const binding = { caseTokenHash, componentArtifactDigest, ...hashes };
        if (!(await currentBindingIsValid(input, binding, at))) {
          return { triggered: false, reason: 'not_armed' };
        }
        const rows = await listAndExpire(
          {
            ...binding,
            boundary: input.boundary,
          },
          at,
        );
        const candidate = rows.find(
          (control) =>
            control.state === 'armed' &&
            control.boundary === input.boundary &&
            new Date(control.expiresAt).getTime() > new Date(at).getTime(),
        );
        if (!candidate) return { triggered: false, reason: 'not_armed' };
        row = await store.consume({
          ...transitionIdentity(candidate),
          at,
          auditEvent: { sequence: 2, event: 'consumed', at },
        });
      } catch {
        return { triggered: false, reason: 'not_armed' };
      }
      if (!row || !validRow(row)) return { triggered: false, reason: 'not_armed' };
      return { triggered: true, controlId: row.controlId, boundary: row.boundary };
    },
  });
}
