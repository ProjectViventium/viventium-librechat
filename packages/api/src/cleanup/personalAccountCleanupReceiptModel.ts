/* === VIVENTIUM START ===
 * Feature: Owner-bound personal-account synthetic-QA cleanup receipt ledger.
 * Purpose: Own verification, append-only receipts, execution leases, and recovery in TypeScript.
 * === VIVENTIUM END === */

import crypto from 'crypto';
import { createViventiumPersonalAccountCleanupReceiptSchema } from '@librechat/data-schemas';
import type { Model, Types } from 'mongoose';
import type { Collection } from 'mongodb';
import type {
  IPersonalAccountCleanupEvent,
  IPersonalAccountCleanupTarget,
  IViventiumPersonalAccountCleanupReceipt,
} from '@librechat/data-schemas';
import type {
  CleanupBackupAuthority,
  CleanupExecutionClaim,
  CleanupOperationRegistration,
  CleanupOperationState,
  CleanupReceiptInput,
  CleanupRecoveryReceipt,
  CleanupTargetBinding,
  CleanupTargetKind,
  VerifiedCleanupBackupAuthority,
} from './types';

type UnknownRecord = Record<string, unknown>;
type NormalizedValue =
  null | boolean | number | string | NormalizedValue[] | { [key: string]: NormalizedValue };
type PersistedReceipt = IViventiumPersonalAccountCleanupReceipt & {
  _id: Types.ObjectId;
  __v?: number;
};
type CleanupRegistrationInput = CleanupOperationRegistration & {
  backupAuthority: CleanupBackupAuthority;
};
type CompatibleReceiptInput = Omit<CleanupReceiptInput, 'at' | 'stage'> & {
  at: string | Date;
  stage: string;
};
type BaseCleanupModel = Model<IViventiumPersonalAccountCleanupReceipt>;
type CleanupExecutionInput = {
  ownerId: string;
  operationId: string;
  attemptId: string;
  at: string | Date;
  leaseMs?: number;
};
type CleanupSettlementInput = CleanupExecutionInput & {
  leaseToken: string;
  errorCode?: string;
};
export type CleanupRecoveryVerifier = (input: {
  backupAuthority: CleanupBackupAuthority;
  recoveryReceipt: CleanupRecoveryReceipt;
  registration: CleanupOperationRegistration;
}) => Promise<VerifiedCleanupBackupAuthority | false | null | undefined>;

export type ViventiumPersonalAccountCleanupReceiptModel =
  Model<IViventiumPersonalAccountCleanupReceipt> & {
    verifyCleanupHashChain(document: PersistedReceipt): boolean;
    configureCleanupRecoveryVerifier(verifier: CleanupRecoveryVerifier): void;
    registerVerifiedBackupOperation(
      input: CleanupRegistrationInput,
    ): Promise<CleanupOperationState>;
    appendCleanupReceipt(input: CompatibleReceiptInput): Promise<{ receiptSha256: string }>;
    claimCleanupExecution(input: CleanupExecutionInput): Promise<CleanupExecutionClaim>;
    failCleanupExecution(input: CleanupSettlementInput): Promise<CleanupOperationState>;
    completeCleanupExecution(input: CleanupSettlementInput): Promise<CleanupOperationState>;
    readCleanupOperation(
      ownerId: string,
      operationId: string,
    ): Promise<CleanupOperationState | null>;
  };

const HASH = /^[a-f0-9]{64}$/;
const PREFIXED_HASH = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_BACKUP_ID = /^backup-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const SAFE_ERROR = /^cleanup_[a-z0-9_]{1,96}$/;
const ZERO_HASH = `sha256:${'0'.repeat(64)}`;
const MINIMUM_SWEEP_DELAY_MS = 15 * 60 * 1000;
const MINIMUM_EXECUTION_LEASE_MS = 1_000;
const MAXIMUM_EXECUTION_LEASE_MS = 5 * 60 * 1000;
const STAGES = [
  'backup_verified',
  'execution_claimed',
  'execution_partial',
  'execution_completed',
  'target_tombstoned',
  'search_reconciled',
  'recall_reconciled',
  'delayed_nonce_sweep_verified',
] as const;
const TARGET_KINDS: CleanupTargetKind[] = ['schedule', 'conversation', 'message', 'memory'];

type CleanupStage = (typeof STAGES)[number];
type CleanEvent = Omit<
  IPersonalAccountCleanupEvent,
  'sequence' | 'eventKeyHash' | 'contentHash' | 'previousEventHash' | 'eventHash'
>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalize(value: unknown): NormalizedValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (isRecord(value)) {
    return Object.keys(value)
      .sort()
      .reduce<{ [key: string]: NormalizedValue }>((result, key) => {
        if (value[key] !== undefined) result[key] = normalize(value[key]);
        return result;
      }, {});
  }
  return String(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function ownerScopeHash(ownerId: string): string {
  return `sha256:${crypto.createHash('sha256').update(ownerId, 'utf8').digest('hex')}`;
}

function compareLexically(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function targetHash(ownerId: string, target: Pick<CleanupTargetBinding, 'kind' | 'resourceId'>) {
  return `sha256:${hash({ ownerId, kind: target.kind, resourceId: target.resourceId })}`;
}

function targetSetHash(targets: Array<Pick<CleanupTargetBinding, 'kind' | 'resourceId'>>): string {
  return hash(
    [...targets]
      .map(({ kind, resourceId }) => ({ kind, resourceId }))
      .sort((left, right) => {
        const leftKey = `${left.kind}\0${left.resourceId}`;
        const rightKey = `${right.kind}\0${right.resourceId}`;
        return compareLexically(leftKey, rightKey);
      }),
  );
}

function equal(left: unknown, right: unknown): boolean {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return (
    leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function requireSafeId(value: unknown, label: string): string {
  const normalized = String(value || '');
  if (!SAFE_ID.test(normalized) || ['all', '*', '.', '..'].includes(normalized)) {
    throw new Error(`cleanup_${label}_invalid`);
  }
  return normalized;
}

function requireCanonicalTime(value: unknown, label: string): string {
  const normalized = value instanceof Date ? value.toISOString() : String(value || '');
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== normalized) {
    throw new Error(`cleanup_${label}_invalid`);
  }
  return normalized;
}

function reviewSetHash(targets: CleanupTargetBinding[]): string {
  return hash(
    targets
      .map((target) => ({
        kind: target.kind,
        resourceIdHash: `sha256:${crypto
          .createHash('sha256')
          .update(target.resourceId, 'utf8')
          .digest('hex')}`,
        stateSha256: target.stateSha256,
        reviewBindingSha256: target.reviewBindingSha256,
      }))
      .sort((left, right) => {
        const leftKey = `${left.kind}\0${left.resourceIdHash}`;
        const rightKey = `${right.kind}\0${right.resourceIdHash}`;
        return compareLexically(leftKey, rightKey);
      }),
  );
}

function validateRecoveryReceipt(
  input: CleanupRegistrationInput,
  registration: CleanupOperationRegistration,
): CleanupRecoveryReceipt {
  const receipt = input.recoveryReceipt;
  if (!isRecord(receipt)) throw new Error('cleanup_backup_receipt_invalid');
  const fields = [
    'contractVersion',
    'backupId',
    'ownerScopeHash',
    'reviewSetSha256',
    'manifestSha256',
    'artifactSetSha256',
    'restoreVerification',
    'status',
    'createdAt',
    'receiptSha256',
  ];
  if (
    Object.keys(receipt).some((field) => !fields.includes(field)) ||
    fields.some((field) => receipt[field] === undefined)
  ) {
    throw new Error('cleanup_backup_receipt_invalid');
  }
  if (
    receipt.contractVersion !== 1 ||
    !SAFE_BACKUP_ID.test(String(receipt.backupId || '')) ||
    receipt.restoreVerification !== 'verified' ||
    receipt.status !== 'verified'
  ) {
    throw new Error('cleanup_backup_receipt_unverified');
  }
  for (const field of ['manifestSha256', 'artifactSetSha256', 'receiptSha256'] as const) {
    if (!HASH.test(String(receipt[field] || ''))) {
      throw new Error(`cleanup_backup_${field}_invalid`);
    }
  }
  requireCanonicalTime(receipt.createdAt, 'backup_created_at');
  const unsigned = Object.fromEntries(
    Object.entries(receipt).filter(([field]) => field !== 'receiptSha256'),
  );
  if (
    !equal(receipt.ownerScopeHash, registration.ownerScopeHash) ||
    !equal(receipt.reviewSetSha256, registration.reviewSetSha256) ||
    !equal(receipt.receiptSha256, registration.backupReceiptSha256) ||
    !equal(receipt.receiptSha256, hash(unsigned))
  ) {
    throw new Error('cleanup_backup_receipt_binding_mismatch');
  }
  return {
    artifactSetSha256: receipt.artifactSetSha256,
    backupId: receipt.backupId,
    contractVersion: receipt.contractVersion,
    createdAt: receipt.createdAt,
    manifestSha256: receipt.manifestSha256,
    ownerScopeHash: receipt.ownerScopeHash,
    receiptSha256: receipt.receiptSha256,
    restoreVerification: receipt.restoreVerification,
    reviewSetSha256: receipt.reviewSetSha256,
    status: receipt.status,
  };
}

function validateRegistration(input: CleanupRegistrationInput): CleanupRecoveryReceipt {
  if (!input || !isRecord(input)) throw new Error('cleanup_registration_invalid');
  if (!input.backupAuthority || !isRecord(input.backupAuthority)) {
    throw new Error('cleanup_backup_authority_missing');
  }
  requireSafeId(input.operationId, 'operationId');
  requireSafeId(input.ownerId, 'ownerId');
  if (input.ownerScopeHash !== ownerScopeHash(input.ownerId)) {
    throw new Error('cleanup_owner_scope_mismatch');
  }
  for (const field of [
    'planSha256',
    'backupReceiptSha256',
    'reviewSetSha256',
    'targetSetSha256',
  ] as const) {
    if (!HASH.test(String(input[field] || ''))) throw new Error(`cleanup_${field}_invalid`);
  }
  if (!PREFIXED_HASH.test(String(input.nonceHash || ''))) {
    throw new Error('cleanup_nonce_hash_invalid');
  }
  if (
    !Array.isArray(input.targets) ||
    input.targets.length === 0 ||
    input.targets.length > 10_000
  ) {
    throw new Error('cleanup_targets_invalid');
  }
  const seen = new Set<string>();
  for (const target of input.targets) {
    if (!TARGET_KINDS.includes(target?.kind)) throw new Error('cleanup_target_invalid');
    requireSafeId(target.resourceId, 'target_resource_id');
    if (!Number.isSafeInteger(target.expectedRevision) || target.expectedRevision < 0) {
      throw new Error('cleanup_target_revision_invalid');
    }
    requireCanonicalTime(target.expectedUpdatedAt, 'target_updated_at');
    for (const field of ['stateSha256', 'preimageSha256', 'reviewBindingSha256'] as const) {
      if (!HASH.test(String(target[field] || ''))) {
        throw new Error(`cleanup_target_${field}_invalid`);
      }
    }
    if (
      !PREFIXED_HASH.test(String(target.runNonceHash || '')) ||
      !equal(target.runNonceHash, input.nonceHash)
    ) {
      throw new Error('cleanup_target_nonce_mismatch');
    }
    if (!equal(target.stateSha256, target.preimageSha256)) {
      throw new Error('cleanup_target_preimage_state_mismatch');
    }
    const key = `${target.kind}\0${target.resourceId}`;
    if (seen.has(key)) throw new Error('cleanup_target_duplicate');
    seen.add(key);
  }
  if (!equal(targetSetHash(input.targets), input.targetSetSha256)) {
    throw new Error('cleanup_target_set_mismatch');
  }
  if (!equal(reviewSetHash(input.targets), input.reviewSetSha256)) {
    throw new Error('cleanup_review_set_mismatch');
  }
  const notBefore = new Date(input.notBefore);
  const at = new Date(input.at);
  if (
    !Number.isFinite(notBefore.getTime()) ||
    !Number.isFinite(at.getTime()) ||
    notBefore.getTime() - at.getTime() < MINIMUM_SWEEP_DELAY_MS
  ) {
    throw new Error('cleanup_sweep_time_invalid');
  }
  return validateRecoveryReceipt(input, input);
}

function cleanEventInput(input: CompatibleReceiptInput): CleanEvent {
  if (!input || !isRecord(input)) throw new Error('cleanup_receipt_event_invalid');
  if (!SAFE_ID.test(String(input.operationId || '')))
    throw new Error('cleanup_operation_id_invalid');
  if (!PREFIXED_HASH.test(String(input.ownerScopeHash || ''))) {
    throw new Error('cleanup_owner_scope_hash_invalid');
  }
  if (!STAGES.includes(input.stage as CleanupStage) || input.stage === 'backup_verified') {
    throw new Error('cleanup_receipt_stage_invalid');
  }
  const at = new Date(input.at);
  if (!Number.isFinite(at.getTime())) throw new Error('cleanup_receipt_time_invalid');
  const event: CleanEvent = { stage: input.stage, at };
  if (input.targetKind !== undefined) {
    if (!TARGET_KINDS.includes(input.targetKind)) throw new Error('cleanup_target_kind_invalid');
    event.targetKind = input.targetKind;
  }
  if (input.targetHash !== undefined) {
    if (!PREFIXED_HASH.test(String(input.targetHash)))
      throw new Error('cleanup_targetHash_invalid');
    event.targetHash = input.targetHash;
  }
  for (const field of ['targetSetSha256', 'receiptSha256'] as const) {
    if (input[field] !== undefined) {
      if (!HASH.test(String(input[field]))) throw new Error(`cleanup_${field}_invalid`);
      event[field] = input[field];
    }
  }
  if (input.count !== undefined) {
    if (!Number.isSafeInteger(input.count) || input.count < 0 || input.count > 1_000_000) {
      throw new Error('cleanup_receipt_count_invalid');
    }
    event.count = input.count;
  }
  if (input.revision !== undefined) {
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
      throw new Error('cleanup_target_revision_invalid');
    }
    event.revision = input.revision;
  }
  if (
    input.stage === 'target_tombstoned' &&
    (!event.targetKind || !event.targetHash || event.revision === undefined || event.count !== 1)
  ) {
    throw new Error('cleanup_target_receipt_incomplete');
  }
  if (
    ['search_reconciled', 'recall_reconciled'].includes(input.stage) &&
    (!event.targetSetSha256 || !event.receiptSha256)
  ) {
    throw new Error('cleanup_reconciliation_receipt_incomplete');
  }
  if (input.stage === 'delayed_nonce_sweep_verified' && !event.targetSetSha256) {
    throw new Error('cleanup_sweep_receipt_incomplete');
  }
  return event;
}

function cleanExecutionEvent(
  input: { attemptId: string; at: string | Date; leaseUntil?: string; errorCode?: string },
  stage: 'execution_claimed' | 'execution_partial' | 'execution_completed',
): CleanEvent {
  const at = new Date(requireCanonicalTime(input.at, 'execution_at'));
  const attemptId = requireSafeId(input.attemptId, 'execution_attempt');
  const event: CleanEvent = {
    stage,
    at,
    attemptIdHash: `sha256:${crypto.createHash('sha256').update(attemptId, 'utf8').digest('hex')}`,
  };
  if (stage === 'execution_claimed') {
    event.leaseUntil = new Date(requireCanonicalTime(input.leaseUntil, 'execution_lease_until'));
    if (event.leaseUntil.getTime() <= at.getTime()) {
      throw new Error('cleanup_execution_lease_invalid');
    }
  }
  if (stage === 'execution_partial') {
    if (!SAFE_ERROR.test(String(input.errorCode || ''))) {
      throw new Error('cleanup_execution_error_code_invalid');
    }
    event.errorCode = input.errorCode;
  }
  return event;
}

function eventIdentity(event: CleanEvent | IPersonalAccountCleanupEvent) {
  return {
    stage: event.stage,
    attemptIdHash: event.attemptIdHash,
    targetKind: event.targetKind,
    targetHash: event.targetHash,
    targetSetSha256: event.targetSetSha256,
    ...(['search_reconciled', 'recall_reconciled'].includes(event.stage)
      ? { receiptSha256: event.receiptSha256 }
      : {}),
  };
}

function eventReplayIdentity(event: CleanEvent | IPersonalAccountCleanupEvent) {
  return {
    ...eventIdentity(event),
    receiptSha256: event.receiptSha256,
    count: event.count,
    revision: event.revision,
    leaseUntil: event.leaseUntil,
    errorCode: event.errorCode,
    ...(event.stage === 'target_tombstoned' ? { at: new Date(event.at).toISOString() } : {}),
  };
}

function buildEvent({
  operationId,
  ownerScopeHash: scope,
  sequence,
  previousEventHash,
  event,
}: {
  operationId: string;
  ownerScopeHash: string;
  sequence: number;
  previousEventHash: string;
  event: CleanEvent;
}): IPersonalAccountCleanupEvent {
  const eventKeyHash = `sha256:${hash(eventIdentity(event))}`;
  const contentHash = `sha256:${hash(event)}`;
  const eventHash = `sha256:${hash({
    operationId,
    ownerScopeHash: scope,
    sequence,
    previousEventHash,
    eventKeyHash,
    contentHash,
  })}`;
  return { sequence, ...event, eventKeyHash, contentHash, previousEventHash, eventHash };
}

function verifyHashChain(document: PersistedReceipt): boolean {
  if (!document || !Array.isArray(document.events) || document.events.length === 0) return false;
  let previous = ZERO_HASH;
  for (let index = 0; index < document.events.length; index += 1) {
    const storedValue = normalize(document.events[index]);
    if (!isRecord(storedValue)) return false;
    if (storedValue.sequence !== index + 1 || storedValue.previousEventHash !== previous)
      return false;
    const event: CleanEvent = {
      stage: String(storedValue.stage),
      at: new Date(String(storedValue.at)),
      ...(storedValue.targetKind
        ? { targetKind: storedValue.targetKind as CleanupTargetKind }
        : {}),
      ...(storedValue.targetHash ? { targetHash: String(storedValue.targetHash) } : {}),
      ...(storedValue.targetSetSha256
        ? { targetSetSha256: String(storedValue.targetSetSha256) }
        : {}),
      ...(storedValue.receiptSha256 ? { receiptSha256: String(storedValue.receiptSha256) } : {}),
      ...(storedValue.count !== undefined ? { count: Number(storedValue.count) } : {}),
      ...(storedValue.revision !== undefined ? { revision: Number(storedValue.revision) } : {}),
      ...(storedValue.attemptIdHash ? { attemptIdHash: String(storedValue.attemptIdHash) } : {}),
      ...(storedValue.leaseUntil ? { leaseUntil: new Date(String(storedValue.leaseUntil)) } : {}),
      ...(storedValue.errorCode ? { errorCode: String(storedValue.errorCode) } : {}),
    };
    const rebuilt = normalize(
      buildEvent({
        operationId: document.operationId,
        ownerScopeHash: document.ownerScopeHash,
        sequence: index + 1,
        previousEventHash: previous,
        event,
      }),
    );
    if (!isRecord(rebuilt)) return false;
    for (const field of ['eventKeyHash', 'contentHash', 'previousEventHash', 'eventHash']) {
      if (storedValue[field] !== rebuilt[field]) return false;
    }
    previous = String(storedValue.eventHash);
  }
  return true;
}

function operationBinding(document: PersistedReceipt) {
  return {
    operationId: document.operationId,
    ownerId: document.ownerId,
    ownerScopeHash: document.ownerScopeHash,
    planSha256: document.planSha256,
    backupReceiptSha256: document.backupReceiptSha256,
    reviewSetSha256: document.reviewSetSha256,
    nonceHash: document.nonceHash,
    targetSetSha256: document.targetSetSha256,
    notBefore: new Date(document.notBefore).toISOString(),
    targets: document.targets.map((target) => ({
      kind: target.kind,
      resourceId: target.resourceId,
      expectedRevision: Number(target.expectedRevision),
      expectedUpdatedAt: new Date(target.expectedUpdatedAt).toISOString(),
      stateSha256: target.stateSha256,
      preimageSha256: target.preimageSha256,
      reviewBindingSha256: target.reviewBindingSha256,
      runNonceHash: target.runNonceHash,
    })),
    authorityId: document.authorityId,
    authoritySha256: document.authoritySha256,
    authorityExpiresAt: new Date(document.authorityExpiresAt).toISOString(),
  };
}

function publicOperation(document: PersistedReceipt): CleanupOperationState & { ownerId: string } {
  const events = document.events || [];
  const latestExecution = [...events]
    .reverse()
    .find((event) =>
      ['execution_claimed', 'execution_partial', 'execution_completed'].includes(event.stage),
    );
  let executionStatus: CleanupOperationState['executionStatus'] = 'ready';
  if (latestExecution?.stage === 'execution_claimed') executionStatus = 'claimed';
  if (latestExecution?.stage === 'execution_partial') executionStatus = 'partial';
  if (latestExecution?.stage === 'execution_completed') executionStatus = 'completed';
  const latestReceipt = (stage: string) =>
    [...events].reverse().find((event) => event.stage === stage)?.receiptSha256;
  return {
    ...operationBinding(document),
    backupVerified: events.some((event) => event.stage === 'backup_verified'),
    searchReconciled: events.some((event) => event.stage === 'search_reconciled'),
    recallReconciled: events.some((event) => event.stage === 'recall_reconciled'),
    sweepVerified: events.some((event) => event.stage === 'delayed_nonce_sweep_verified'),
    searchReceiptSha256: latestReceipt('search_reconciled'),
    recallReceiptSha256: latestReceipt('recall_reconciled'),
    targetReceipts: events
      .filter((event) => event.stage === 'target_tombstoned')
      .map((event) => ({
        targetKind: event.targetKind as CleanupTargetKind,
        targetHash: String(event.targetHash),
        revision: Number(event.revision),
        tombstonedAt: new Date(event.at).toISOString(),
      })),
    executionStatus,
  };
}

function hasExactTargetReceipt(
  document: PersistedReceipt,
  target: IPersonalAccountCleanupTarget,
): boolean {
  const expectedTargetHash = targetHash(document.ownerId, target);
  return document.events.some(
    (event) =>
      event.stage === 'target_tombstoned' &&
      event.targetKind === target.kind &&
      equal(event.targetHash, expectedTargetHash) &&
      Number(event.revision) === Number(target.expectedRevision) + 1 &&
      Number(event.count) === 1,
  );
}

function assertEventPrerequisites(document: PersistedReceipt, event: CleanEvent): void {
  const previous = document.events[document.events.length - 1];
  if (previous && new Date(event.at).getTime() < new Date(previous.at).getTime()) {
    throw new Error('cleanup_receipt_time_regression');
  }
  if (['search_reconciled', 'recall_reconciled'].includes(event.stage)) {
    const derivedTargets = document.targets.filter(
      (target) => target.kind === 'message' || target.kind === 'conversation',
    );
    if (
      event.count !== derivedTargets.length ||
      !derivedTargets.every((target) => hasExactTargetReceipt(document, target))
    ) {
      throw new Error('cleanup_reconciliation_prerequisite_missing');
    }
  }
  if (event.stage === 'delayed_nonce_sweep_verified') {
    const due = new Date(document.notBefore).getTime();
    const at = new Date(event.at).getTime();
    const allTargetsRecorded = document.targets.every((target) =>
      hasExactTargetReceipt(document, target),
    );
    const searchRecorded = document.events.some((entry) => entry.stage === 'search_reconciled');
    const recallRecorded = document.events.some((entry) => entry.stage === 'recall_reconciled');
    if (
      at < due ||
      event.count !== document.targets.length ||
      !allTargetsRecorded ||
      !searchRecorded ||
      !recallRecorded
    ) {
      throw new Error('cleanup_sweep_prerequisite_missing');
    }
  }
}

function duplicateKeyError(error: unknown): boolean {
  return isRecord(error) && error.code === 11000;
}

function receiptCollection(model: BaseCleanupModel): Collection<PersistedReceipt> {
  return model.collection as unknown as Collection<PersistedReceipt>;
}

export function createViventiumPersonalAccountCleanupReceiptModel(
  mongoose: typeof import('mongoose'),
  options: { verifyRecoveryReceipt?: CleanupRecoveryVerifier } = {},
): ViventiumPersonalAccountCleanupReceiptModel {
  if (mongoose.models.ViventiumPersonalAccountCleanupReceipt) {
    return mongoose.models
      .ViventiumPersonalAccountCleanupReceipt as ViventiumPersonalAccountCleanupReceiptModel;
  }

  let verifyRecoveryReceipt = options.verifyRecoveryReceipt;
  const schema = createViventiumPersonalAccountCleanupReceiptSchema();
  const rejectDirectMutation = (next: (error?: Error) => void) => {
    next(new Error('cleanup_receipt_append_only'));
  };
  for (const operation of [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'findOneAndReplace',
    'replaceOne',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ] as const) {
    schema.pre(operation, rejectDirectMutation);
  }
  schema.pre('save', function rejectExistingSave(next) {
    if (!this.isNew) return rejectDirectMutation(next);
    return next();
  });

  schema.static('verifyCleanupHashChain', verifyHashChain);
  schema.static(
    'configureCleanupRecoveryVerifier',
    function configure(verifier: CleanupRecoveryVerifier) {
      if (typeof verifier !== 'function') {
        throw new Error('cleanup_backup_external_verifier_invalid');
      }
      if (verifyRecoveryReceipt && verifyRecoveryReceipt !== verifier) {
        throw new Error('cleanup_backup_external_verifier_already_configured');
      }
      verifyRecoveryReceipt = verifier;
    },
  );

  schema.static(
    'registerVerifiedBackupOperation',
    async function register(this: BaseCleanupModel, input: CleanupRegistrationInput) {
      const collection = receiptCollection(this);
      const recoveryReceipt = validateRegistration(input);
      if (typeof verifyRecoveryReceipt !== 'function') {
        throw new Error('cleanup_backup_external_verifier_unavailable');
      }
      const externallyVerified = await verifyRecoveryReceipt({
        backupAuthority: input.backupAuthority,
        recoveryReceipt,
        registration: {
          operationId: input.operationId,
          ownerId: input.ownerId,
          ownerScopeHash: input.ownerScopeHash,
          planSha256: input.planSha256,
          backupReceiptSha256: input.backupReceiptSha256,
          reviewSetSha256: input.reviewSetSha256,
          recoveryReceipt,
          nonceHash: input.nonceHash,
          targetSetSha256: input.targetSetSha256,
          notBefore: new Date(input.notBefore).toISOString(),
          at: new Date(input.at).toISOString(),
          targets: input.targets.map((target) => ({
            ...target,
            expectedUpdatedAt: new Date(target.expectedUpdatedAt).toISOString(),
          })),
        },
      });
      if (
        !externallyVerified ||
        externallyVerified.verified !== true ||
        !SAFE_ID.test(String(externallyVerified.authorityId || '')) ||
        !HASH.test(String(externallyVerified.authoritySha256 || ''))
      ) {
        throw new Error('cleanup_backup_external_verification_rejected');
      }
      const authorityExpiresAt = requireCanonicalTime(
        externallyVerified.expiresAt,
        'backup_authority_expires_at',
      );
      if (new Date(authorityExpiresAt).getTime() <= new Date(input.at).getTime()) {
        throw new Error('cleanup_backup_authority_stale');
      }
      const binding = {
        operationId: input.operationId,
        ownerId: input.ownerId,
        ownerScopeHash: input.ownerScopeHash,
        planSha256: input.planSha256,
        backupReceiptSha256: input.backupReceiptSha256,
        reviewSetSha256: input.reviewSetSha256,
        nonceHash: input.nonceHash,
        targetSetSha256: input.targetSetSha256,
        notBefore: new Date(input.notBefore),
        authorityId: externallyVerified.authorityId,
        authoritySha256: externallyVerified.authoritySha256,
        authorityExpiresAt: new Date(authorityExpiresAt),
        targets: input.targets.map((target) => ({
          kind: target.kind,
          resourceId: target.resourceId,
          expectedRevision: target.expectedRevision,
          expectedUpdatedAt: new Date(target.expectedUpdatedAt),
          stateSha256: target.stateSha256,
          preimageSha256: target.preimageSha256,
          reviewBindingSha256: target.reviewBindingSha256,
          runNonceHash: target.runNonceHash,
        })),
      };
      const existing = await collection.findOne({
        operationId: input.operationId,
      });
      if (existing) {
        if (
          !equal(
            hash(operationBinding(existing)),
            hash(operationBinding(binding as PersistedReceipt)),
          )
        ) {
          throw new Error('cleanup_operation_binding_conflict');
        }
        if (!verifyHashChain(existing)) throw new Error('cleanup_receipt_hash_chain_invalid');
        return publicOperation(existing);
      }
      const firstEvent = buildEvent({
        operationId: input.operationId,
        ownerScopeHash: input.ownerScopeHash,
        sequence: 1,
        previousEventHash: ZERO_HASH,
        event: {
          stage: 'backup_verified',
          at: new Date(input.at),
          targetSetSha256: input.targetSetSha256,
          receiptSha256: input.backupReceiptSha256,
          count: input.targets.length,
        },
      });
      try {
        const created = await this.create({
          contractVersion: 1,
          ...binding,
          events: [firstEvent],
          executionStatus: 'ready',
        });
        return publicOperation(created.toObject() as PersistedReceipt);
      } catch (error) {
        if (!duplicateKeyError(error)) throw error;
        const raced = await collection.findOne({
          operationId: input.operationId,
        });
        if (
          !raced ||
          !equal(hash(operationBinding(raced)), hash(operationBinding(binding as PersistedReceipt)))
        ) {
          throw new Error('cleanup_operation_binding_conflict');
        }
        if (!verifyHashChain(raced)) throw new Error('cleanup_receipt_hash_chain_invalid');
        return publicOperation(raced);
      }
    },
  );

  schema.static(
    'appendCleanupReceipt',
    async function append(this: BaseCleanupModel, input: CompatibleReceiptInput) {
      const collection = receiptCollection(this);
      const clean = cleanEventInput(input);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const current = await collection.findOne({
          operationId: input.operationId,
          ownerScopeHash: input.ownerScopeHash,
        });
        if (!current) throw new Error('cleanup_operation_not_found');
        if (!verifyHashChain(current)) throw new Error('cleanup_receipt_hash_chain_invalid');
        if (clean.stage === 'target_tombstoned') {
          const target = current.targets.find(
            (candidate) =>
              candidate.kind === clean.targetKind &&
              equal(targetHash(current.ownerId, candidate), clean.targetHash),
          );
          if (!target || clean.revision !== Number(target.expectedRevision) + 1) {
            throw new Error('cleanup_target_receipt_binding_mismatch');
          }
        } else if (
          clean.targetSetSha256 &&
          !equal(clean.targetSetSha256, current.targetSetSha256)
        ) {
          throw new Error('cleanup_receipt_target_set_mismatch');
        }
        const eventKeyHash = `sha256:${hash(eventIdentity(clean))}`;
        const existing = current.events.find((event) => event.eventKeyHash === eventKeyHash);
        if (existing) {
          if (!equal(hash(eventReplayIdentity(existing)), hash(eventReplayIdentity(clean)))) {
            throw new Error('cleanup_receipt_event_conflict');
          }
          return { receiptSha256: existing.eventHash.slice('sha256:'.length) };
        }
        assertEventPrerequisites(current, clean);
        const previous = current.events[current.events.length - 1];
        const event = buildEvent({
          operationId: current.operationId,
          ownerScopeHash: current.ownerScopeHash,
          sequence: current.events.length + 1,
          previousEventHash: previous.eventHash,
          event: clean,
        });
        const result = await collection.updateOne(
          { _id: current._id, __v: Number(current.__v || 0) },
          {
            $push: { events: event },
            $inc: { __v: 1 },
            $set: { updatedAt: new Date() },
          },
        );
        if (result.modifiedCount === 1) {
          return { receiptSha256: event.eventHash.slice('sha256:'.length) };
        }
      }
      throw new Error('cleanup_receipt_append_conflict');
    },
  );

  schema.static(
    'claimCleanupExecution',
    async function claim(this: BaseCleanupModel, input: CleanupExecutionInput) {
      const collection = receiptCollection(this);
      const ownerId = requireSafeId(input?.ownerId, 'execution_owner');
      const operationId = requireSafeId(input?.operationId, 'execution_operation');
      const attemptId = requireSafeId(input?.attemptId, 'execution_attempt');
      const atText = requireCanonicalTime(input?.at, 'execution_at');
      const at = new Date(atText);
      const leaseMs = input?.leaseMs ?? 60_000;
      if (
        !Number.isSafeInteger(leaseMs) ||
        leaseMs < MINIMUM_EXECUTION_LEASE_MS ||
        leaseMs > MAXIMUM_EXECUTION_LEASE_MS
      ) {
        throw new Error('cleanup_execution_lease_invalid');
      }
      const attemptIdHash = `sha256:${crypto
        .createHash('sha256')
        .update(attemptId, 'utf8')
        .digest('hex')}`;

      for (let retry = 0; retry < 8; retry += 1) {
        const current = await collection.findOne({
          ownerId,
          operationId,
        });
        if (!current) throw new Error('cleanup_operation_not_found');
        if (!verifyHashChain(current)) throw new Error('cleanup_receipt_hash_chain_invalid');
        const projected = publicOperation(current);
        if (current.executionStatus !== projected.executionStatus) {
          throw new Error('cleanup_execution_state_invalid');
        }
        if (projected.executionStatus === 'completed') {
          throw new Error('cleanup_authorization_replayed');
        }
        if (
          projected.executionStatus === 'claimed' &&
          new Date(current.executionLeaseUntil ?? 0).getTime() > at.getTime()
        ) {
          throw new Error('cleanup_execution_in_progress');
        }
        if (current.events.some((event) => equal(event.attemptIdHash, attemptIdHash))) {
          throw new Error('cleanup_execution_attempt_replayed');
        }
        const authorityExpiresAt = new Date(current.authorityExpiresAt).getTime();
        if (!Number.isFinite(authorityExpiresAt) || authorityExpiresAt <= at.getTime()) {
          throw new Error('cleanup_backup_authority_stale');
        }
        const leaseUntilMs = Math.min(at.getTime() + leaseMs, authorityExpiresAt);
        const leaseToken = crypto.randomBytes(32).toString('base64url');
        const leaseTokenHash = `sha256:${crypto
          .createHash('sha256')
          .update(leaseToken, 'utf8')
          .digest('hex')}`;
        const event = cleanExecutionEvent(
          { attemptId, at: atText, leaseUntil: new Date(leaseUntilMs).toISOString() },
          'execution_claimed',
        );
        assertEventPrerequisites(current, event);
        const previous = current.events[current.events.length - 1];
        const storedEvent = buildEvent({
          operationId,
          ownerScopeHash: current.ownerScopeHash,
          sequence: current.events.length + 1,
          previousEventHash: previous.eventHash,
          event,
        });
        const recovered =
          projected.executionStatus === 'partial' || projected.executionStatus === 'claimed';
        const result = await collection.updateOne(
          {
            _id: current._id,
            __v: Number(current.__v || 0),
            executionStatus: current.executionStatus,
          },
          {
            $push: { events: storedEvent },
            $inc: { __v: 1 },
            $set: {
              executionStatus: 'claimed',
              executionLeaseTokenHash: leaseTokenHash,
              executionLeaseUntil: new Date(leaseUntilMs),
              executionAttemptIdHash: attemptIdHash,
              updatedAt: at,
            },
          },
        );
        if (result.modifiedCount !== 1) continue;
        const stored = await collection.findOne({
          ownerId,
          operationId,
        });
        if (!stored || !verifyHashChain(stored)) {
          throw new Error('cleanup_receipt_hash_chain_invalid');
        }
        return {
          status: recovered ? 'recovered' : 'claimed',
          leaseToken,
          operation: publicOperation(stored),
        };
      }
      throw new Error('cleanup_execution_claim_conflict');
    },
  );

  async function settleExecution(
    model: BaseCleanupModel,
    input: CleanupSettlementInput,
    stage: 'execution_partial' | 'execution_completed',
  ): Promise<CleanupOperationState> {
    const collection = receiptCollection(model);
    const ownerId = requireSafeId(input?.ownerId, 'execution_owner');
    const operationId = requireSafeId(input?.operationId, 'execution_operation');
    const attemptId = requireSafeId(input?.attemptId, 'execution_attempt');
    const atText = requireCanonicalTime(input?.at, 'execution_at');
    const leaseToken = String(input?.leaseToken || '');
    if (!/^[A-Za-z0-9_-]{43}$/.test(leaseToken)) {
      throw new Error('cleanup_execution_lease_invalid');
    }
    const attemptIdHash = `sha256:${crypto
      .createHash('sha256')
      .update(attemptId, 'utf8')
      .digest('hex')}`;
    const leaseTokenHash = `sha256:${crypto
      .createHash('sha256')
      .update(leaseToken, 'utf8')
      .digest('hex')}`;

    for (let retry = 0; retry < 8; retry += 1) {
      const current = await collection.findOne({
        ownerId,
        operationId,
      });
      if (!current) throw new Error('cleanup_operation_not_found');
      if (!verifyHashChain(current)) throw new Error('cleanup_receipt_hash_chain_invalid');
      if (
        current.executionStatus !== 'claimed' ||
        !equal(current.executionAttemptIdHash, attemptIdHash) ||
        !equal(current.executionLeaseTokenHash, leaseTokenHash)
      ) {
        throw new Error('cleanup_execution_lease_lost');
      }
      if (stage === 'execution_completed') {
        const allTargetsRecorded = current.targets.every((target) =>
          hasExactTargetReceipt(current, target),
        );
        const searchRecorded = current.events.some((event) => event.stage === 'search_reconciled');
        const recallRecorded = current.events.some((event) => event.stage === 'recall_reconciled');
        if (!allTargetsRecorded || !searchRecorded || !recallRecorded) {
          throw new Error('cleanup_execution_prerequisite_missing');
        }
      }
      const event = cleanExecutionEvent(
        {
          attemptId,
          at: atText,
          ...(stage === 'execution_partial' ? { errorCode: input.errorCode } : {}),
        },
        stage,
      );
      assertEventPrerequisites(current, event);
      const previous = current.events[current.events.length - 1];
      const storedEvent = buildEvent({
        operationId,
        ownerScopeHash: current.ownerScopeHash,
        sequence: current.events.length + 1,
        previousEventHash: previous.eventHash,
        event,
      });
      const nextStatus = stage === 'execution_completed' ? 'completed' : 'partial';
      const result = await collection.updateOne(
        {
          _id: current._id,
          __v: Number(current.__v || 0),
          executionStatus: 'claimed',
          executionLeaseTokenHash: leaseTokenHash,
          executionAttemptIdHash: attemptIdHash,
        },
        {
          $push: { events: storedEvent },
          $inc: { __v: 1 },
          $set: { executionStatus: nextStatus, updatedAt: new Date(atText) },
          $unset: {
            executionLeaseTokenHash: '',
            executionLeaseUntil: '',
            executionAttemptIdHash: '',
          },
        },
      );
      if (result.modifiedCount !== 1) continue;
      const stored = await collection.findOne({
        ownerId,
        operationId,
      });
      if (!stored || !verifyHashChain(stored)) {
        throw new Error('cleanup_receipt_hash_chain_invalid');
      }
      return publicOperation(stored);
    }
    throw new Error('cleanup_execution_settle_conflict');
  }

  schema.static(
    'failCleanupExecution',
    async function fail(this: BaseCleanupModel, input: CleanupSettlementInput) {
      return settleExecution(this, input, 'execution_partial');
    },
  );
  schema.static(
    'completeCleanupExecution',
    async function complete(this: BaseCleanupModel, input: CleanupSettlementInput) {
      return settleExecution(this, input, 'execution_completed');
    },
  );
  schema.static(
    'readCleanupOperation',
    async function read(this: BaseCleanupModel, ownerId: string, operationId: string) {
      const document = await receiptCollection(this).findOne({
        ownerId,
        operationId,
      });
      if (!document) return null;
      if (!verifyHashChain(document)) throw new Error('cleanup_receipt_hash_chain_invalid');
      return publicOperation(document);
    },
  );

  return mongoose.model<IViventiumPersonalAccountCleanupReceipt>(
    'ViventiumPersonalAccountCleanupReceipt',
    schema,
  ) as ViventiumPersonalAccountCleanupReceiptModel;
}
