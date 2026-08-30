import { lstatSync, readFileSync, realpathSync } from 'fs';
import { isAbsolute } from 'path';
import { createHash, createPublicKey, timingSafeEqual, verify } from 'crypto';
import type { KeyObject } from 'crypto';
import type {
  CleanupBackupAuthority,
  CleanupBackupAuthorityPayload,
  CleanupJsonValue,
  CleanupOperationRegistration,
  CleanupRecoveryReceipt,
  CleanupTargetBinding,
  VerifiedCleanupBackupAuthority,
} from './types';

const HASH = /^[a-f0-9]{64}$/;
const PREFIXED_HASH = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_BACKUP_ID = /^backup-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const PROOF = /^ed25519:([A-Za-z0-9_-]{86})$/;
const AUTHORITY_PURPOSE = 'reviewed_personal_account_synthetic_qa_cleanup';
const DEFAULT_MAXIMUM_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAXIMUM_CLOCK_SKEW_MS = 30_000;

function canonicalize(value: CleanupJsonValue): CleanupJsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce<{ [key: string]: CleanupJsonValue }>((result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      }, {});
  }
  return value;
}

function canonicalJson(value: CleanupJsonValue): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exact(left: string, right: string): boolean {
  const first = Buffer.from(String(left || ''), 'utf8');
  const second = Buffer.from(String(right || ''), 'utf8');
  return first.length === second.length && timingSafeEqual(first, second);
}

function requireSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(String(value || '')) || ['all', '*', '.', '..'].includes(value)) {
    throw new Error(`${label}_invalid`);
  }
}

function requireHash(value: string, label: string, prefixed = false): void {
  if (!(prefixed ? PREFIXED_HASH : HASH).test(String(value || ''))) {
    throw new Error(`${label}_invalid`);
  }
}

function parseCanonicalTime(value: string, label: string): number {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label}_invalid`);
  }
  return parsed;
}

function targetJson(target: CleanupTargetBinding): CleanupJsonValue {
  return {
    kind: target.kind,
    resourceId: target.resourceId,
    expectedRevision: target.expectedRevision,
    expectedUpdatedAt: target.expectedUpdatedAt,
    stateSha256: target.stateSha256,
    preimageSha256: target.preimageSha256,
    reviewBindingSha256: target.reviewBindingSha256,
    runNonceHash: target.runNonceHash,
  };
}

export function cleanupTargetBindingsSha256(targets: CleanupTargetBinding[]): string {
  const ordered = [...targets]
    .sort((left, right) => {
      const first = `${left.kind}\0${left.resourceId}`;
      const second = `${right.kind}\0${right.resourceId}`;
      if (first < second) return -1;
      if (first > second) return 1;
      return 0;
    })
    .map(targetJson);
  return sha256(canonicalJson(ordered));
}

function authorityPayloadJson(payload: CleanupBackupAuthorityPayload): CleanupJsonValue {
  return {
    contractVersion: payload.contractVersion,
    authorityId: payload.authorityId,
    purpose: payload.purpose,
    reviewedCleanupApproved: payload.reviewedCleanupApproved,
    ownerScopeHash: payload.ownerScopeHash,
    operationId: payload.operationId,
    planSha256: payload.planSha256,
    backupReceiptSha256: payload.backupReceiptSha256,
    reviewSetSha256: payload.reviewSetSha256,
    targetSetSha256: payload.targetSetSha256,
    targetBindingsSha256: payload.targetBindingsSha256,
    nonceHash: payload.nonceHash,
    backupId: payload.backupId,
    backupCreatedAt: payload.backupCreatedAt,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  };
}

export function serializePersonalAccountCleanupAuthorityPayload(
  payload: CleanupBackupAuthorityPayload,
): string {
  return canonicalJson(authorityPayloadJson(payload));
}

function validateAuthorityShape(value: CleanupBackupAuthority | undefined): CleanupBackupAuthority {
  if (!value || typeof value !== 'object') {
    throw new Error('cleanup_backup_authority_missing');
  }
  const expected = new Set([
    'contractVersion',
    'authorityId',
    'purpose',
    'reviewedCleanupApproved',
    'ownerScopeHash',
    'operationId',
    'planSha256',
    'backupReceiptSha256',
    'reviewSetSha256',
    'targetSetSha256',
    'targetBindingsSha256',
    'nonceHash',
    'backupId',
    'backupCreatedAt',
    'issuedAt',
    'expiresAt',
    'proof',
  ]);
  if (
    Object.keys(value).length !== expected.size ||
    Object.keys(value).some((key) => !expected.has(key))
  ) {
    throw new Error('cleanup_backup_authority_invalid');
  }
  if (
    value.contractVersion !== 1 ||
    value.purpose !== AUTHORITY_PURPOSE ||
    value.reviewedCleanupApproved !== true
  ) {
    throw new Error('cleanup_backup_authority_not_approved');
  }
  requireSafeId(value.authorityId, 'cleanup_backup_authority_id');
  requireSafeId(value.operationId, 'cleanup_backup_authority_operation');
  if (!SAFE_BACKUP_ID.test(value.backupId))
    throw new Error('cleanup_backup_authority_backup_id_invalid');
  for (const [label, digest] of [
    ['owner_scope', value.ownerScopeHash],
    ['nonce', value.nonceHash],
  ] as const) {
    requireHash(digest, `cleanup_backup_authority_${label}`, true);
  }
  for (const [label, digest] of [
    ['plan', value.planSha256],
    ['backup_receipt', value.backupReceiptSha256],
    ['review_set', value.reviewSetSha256],
    ['target_set', value.targetSetSha256],
    ['target_bindings', value.targetBindingsSha256],
  ] as const) {
    requireHash(digest, `cleanup_backup_authority_${label}`);
  }
  if (!PROOF.test(value.proof)) throw new Error('cleanup_backup_authority_forged');
  return value;
}

function assertRecoveryBinding(
  authority: CleanupBackupAuthority,
  receipt: CleanupRecoveryReceipt,
  registration: CleanupOperationRegistration,
): void {
  if (
    !exact(authority.ownerScopeHash, registration.ownerScopeHash) ||
    !exact(receipt.ownerScopeHash, registration.ownerScopeHash)
  ) {
    throw new Error('cleanup_backup_authority_owner_mismatch');
  }
  if (
    !exact(authority.operationId, registration.operationId) ||
    !exact(authority.planSha256, registration.planSha256) ||
    !exact(authority.reviewSetSha256, registration.reviewSetSha256) ||
    !exact(authority.targetSetSha256, registration.targetSetSha256) ||
    !exact(authority.nonceHash, registration.nonceHash)
  ) {
    throw new Error('cleanup_backup_authority_operation_mismatch');
  }
  if (!exact(authority.targetBindingsSha256, cleanupTargetBindingsSha256(registration.targets))) {
    throw new Error('cleanup_backup_authority_target_binding_mismatch');
  }
  if (
    !exact(authority.backupId, receipt.backupId) ||
    !exact(authority.backupCreatedAt, receipt.createdAt) ||
    !exact(authority.backupReceiptSha256, receipt.receiptSha256) ||
    !exact(authority.backupReceiptSha256, registration.backupReceiptSha256) ||
    !exact(receipt.reviewSetSha256, registration.reviewSetSha256)
  ) {
    throw new Error('cleanup_backup_authority_recovery_mismatch');
  }
}

export function createTrustedPrivateBackupAuthorityVerifier({
  publicKey,
  now = () => new Date(),
  maximumLifetimeMs = DEFAULT_MAXIMUM_LIFETIME_MS,
}: {
  publicKey: KeyObject;
  now?: () => Date;
  maximumLifetimeMs?: number;
}) {
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('cleanup_backup_authority_public_key_invalid');
  }
  if (!Number.isSafeInteger(maximumLifetimeMs) || maximumLifetimeMs < 60_000) {
    throw new Error('cleanup_backup_authority_lifetime_invalid');
  }

  return async ({
    backupAuthority,
    recoveryReceipt,
    registration,
  }: {
    backupAuthority: CleanupBackupAuthority | undefined;
    recoveryReceipt: CleanupRecoveryReceipt;
    registration: CleanupOperationRegistration;
  }): Promise<VerifiedCleanupBackupAuthority> => {
    const authority = validateAuthorityShape(backupAuthority);
    const issuedAt = parseCanonicalTime(authority.issuedAt, 'cleanup_backup_authority_issued_at');
    const expiresAt = parseCanonicalTime(
      authority.expiresAt,
      'cleanup_backup_authority_expires_at',
    );
    const backupCreatedAt = parseCanonicalTime(
      authority.backupCreatedAt,
      'cleanup_backup_authority_backup_created_at',
    );
    const current = now().getTime();
    if (
      issuedAt > current + MAXIMUM_CLOCK_SKEW_MS ||
      expiresAt <= current ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > maximumLifetimeMs ||
      backupCreatedAt > issuedAt
    ) {
      throw new Error('cleanup_backup_authority_stale');
    }
    assertRecoveryBinding(authority, recoveryReceipt, registration);
    const proof = PROOF.exec(authority.proof)?.[1];
    const payload = serializePersonalAccountCleanupAuthorityPayload(authority);
    if (
      !proof ||
      !verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(proof, 'base64url'))
    ) {
      throw new Error('cleanup_backup_authority_forged');
    }
    return {
      verified: true,
      authorityId: authority.authorityId,
      authoritySha256: sha256(canonicalJson({ payload, proof: authority.proof })),
      expiresAt: authority.expiresAt,
    };
  };
}

export function loadTrustedPrivateBackupAuthorityVerifier({
  publicKeyPath,
  now,
  maximumLifetimeMs,
}: {
  publicKeyPath: string;
  now?: () => Date;
  maximumLifetimeMs?: number;
}) {
  if (!isAbsolute(publicKeyPath)) {
    throw new Error('cleanup_backup_authority_public_key_path_invalid');
  }
  const metadata = lstatSync(publicKeyPath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 64 * 1024) {
    throw new Error('cleanup_backup_authority_public_key_file_invalid');
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error('cleanup_backup_authority_public_key_permissions_invalid');
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error('cleanup_backup_authority_public_key_owner_invalid');
  }
  const canonicalPath = realpathSync(publicKeyPath);
  if (canonicalPath !== publicKeyPath) {
    throw new Error('cleanup_backup_authority_public_key_path_invalid');
  }
  const pem = readFileSync(canonicalPath, 'utf8');
  if (/PRIVATE KEY/.test(pem)) {
    throw new Error('cleanup_backup_authority_private_key_exposed_to_runtime');
  }
  return createTrustedPrivateBackupAuthorityVerifier({
    publicKey: createPublicKey(pem),
    now,
    maximumLifetimeMs,
  });
}
