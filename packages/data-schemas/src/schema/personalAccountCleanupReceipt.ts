/* === VIVENTIUM START ===
 * Feature: Owner-bound personal-account synthetic-QA cleanup receipt ledger.
 * Purpose: Own the strict content-free persistence shape in the typed schema package.
 * === VIVENTIUM END === */

import { Schema } from 'mongoose';
import type {
  IPersonalAccountCleanupEvent,
  IPersonalAccountCleanupTarget,
  IViventiumPersonalAccountCleanupReceipt,
} from '~/types/personalAccountCleanupReceipt';

const HASH = /^[a-f0-9]{64}$/;
const PREFIXED_HASH = /^sha256:[a-f0-9]{64}$/;
const SAFE_ERROR = /^cleanup_[a-z0-9_]{1,96}$/;
const STAGES = [
  'backup_verified',
  'execution_claimed',
  'execution_partial',
  'execution_completed',
  'target_tombstoned',
  'search_reconciled',
  'recall_reconciled',
  'delayed_nonce_sweep_verified',
];
const TARGET_KINDS = ['schedule', 'conversation', 'message', 'memory'];

export function createViventiumPersonalAccountCleanupReceiptSchema() {
  const targetSchema = new Schema<IPersonalAccountCleanupTarget>(
    {
      kind: { type: String, required: true, enum: TARGET_KINDS, immutable: true },
      resourceId: { type: String, required: true, minlength: 1, maxlength: 160, immutable: true },
      expectedRevision: { type: Number, required: true, min: 0, immutable: true },
      expectedUpdatedAt: { type: Date, required: true, immutable: true },
      stateSha256: { type: String, required: true, match: HASH, immutable: true },
      preimageSha256: { type: String, required: true, match: HASH, immutable: true },
      reviewBindingSha256: { type: String, required: true, match: HASH, immutable: true },
      runNonceHash: { type: String, required: true, match: PREFIXED_HASH, immutable: true },
    },
    { _id: false, strict: 'throw' },
  );
  const eventSchema = new Schema<IPersonalAccountCleanupEvent>(
    {
      sequence: { type: Number, required: true, min: 1, immutable: true },
      stage: { type: String, required: true, enum: STAGES, immutable: true },
      at: { type: Date, required: true, immutable: true },
      targetKind: { type: String, enum: TARGET_KINDS, default: undefined, immutable: true },
      targetHash: { type: String, match: PREFIXED_HASH, default: undefined, immutable: true },
      targetSetSha256: { type: String, match: HASH, default: undefined, immutable: true },
      receiptSha256: { type: String, match: HASH, default: undefined, immutable: true },
      count: { type: Number, min: 0, max: 1_000_000, default: undefined, immutable: true },
      revision: { type: Number, min: 1, default: undefined, immutable: true },
      attemptIdHash: { type: String, match: PREFIXED_HASH, default: undefined, immutable: true },
      leaseUntil: { type: Date, default: undefined, immutable: true },
      errorCode: { type: String, match: SAFE_ERROR, default: undefined, immutable: true },
      eventKeyHash: { type: String, required: true, match: PREFIXED_HASH, immutable: true },
      contentHash: { type: String, required: true, match: PREFIXED_HASH, immutable: true },
      previousEventHash: { type: String, required: true, match: PREFIXED_HASH, immutable: true },
      eventHash: { type: String, required: true, match: PREFIXED_HASH, immutable: true },
    },
    { _id: false, strict: 'throw' },
  );
  const schema = new Schema<IViventiumPersonalAccountCleanupReceipt>(
    {
      contractVersion: { type: Number, required: true, enum: [1], immutable: true },
      operationId: { type: String, required: true, unique: true, index: true, immutable: true },
      ownerId: { type: String, required: true, index: true, immutable: true },
      ownerScopeHash: { type: String, required: true, match: PREFIXED_HASH, immutable: true },
      planSha256: { type: String, required: true, match: HASH, immutable: true },
      backupReceiptSha256: { type: String, required: true, match: HASH, immutable: true },
      reviewSetSha256: { type: String, required: true, match: HASH, immutable: true },
      nonceHash: { type: String, required: true, match: PREFIXED_HASH, immutable: true },
      targetSetSha256: { type: String, required: true, match: HASH, immutable: true },
      notBefore: { type: Date, required: true, immutable: true },
      authorityId: { type: String, required: true, minlength: 1, maxlength: 160, immutable: true },
      authoritySha256: { type: String, required: true, match: HASH, immutable: true },
      authorityExpiresAt: { type: Date, required: true, immutable: true },
      targets: { type: [targetSchema], required: true, immutable: true },
      events: { type: [eventSchema], required: true, immutable: true },
      executionStatus: {
        type: String,
        enum: ['ready', 'claimed', 'partial', 'completed'],
        default: 'ready',
      },
      executionLeaseTokenHash: { type: String, match: PREFIXED_HASH, default: undefined },
      executionLeaseUntil: { type: Date, default: undefined },
      executionAttemptIdHash: { type: String, match: PREFIXED_HASH, default: undefined },
    },
    { timestamps: true, strict: 'throw' },
  );

  schema.index({ ownerId: 1, operationId: 1 }, { unique: true });
  schema.index({ ownerScopeHash: 1, targetSetSha256: 1 });
  return schema;
}
