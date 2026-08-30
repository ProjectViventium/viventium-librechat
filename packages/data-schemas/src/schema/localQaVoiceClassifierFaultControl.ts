/* === VIVENTIUM START ===
 * Feature: MPV-061 strict Voice classifier fallback control.
 * Purpose: Persist one exact synthetic PRE-GATE control with guarded state transitions and TTL.
 * === VIVENTIUM END === */

import { Schema } from 'mongoose';
import { VOICE_CLASSIFIER_FAULT_CONTROL_STATES } from '~/types/localQaVoiceClassifierFaultControl';
import type { ILocalQaVoiceClassifierFaultControl } from '~/types/localQaVoiceClassifierFaultControl';

const HASH = /^sha256:[a-f0-9]{64}$/;
const PROOF = /^[A-Za-z0-9_-]{43}$/;
const CONTROL_ID = /^mpv061_[A-Za-z0-9_-]{22,80}$/;
const CHALLENGE_ID = /^mpv061_ch_[A-Za-z0-9_-]{22,80}$/;

const hashField = { type: String, required: true, match: HASH, immutable: true } as const;
const optionalHashField = { type: String, default: null, match: HASH } as const;
const boundedText = {
  type: String,
  required: true,
  minlength: 1,
  maxlength: 256,
  immutable: true,
} as const;

function exactLiveExpiryWindow(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(',') === '$eq,$gt' &&
    record.$eq instanceof Date &&
    record.$gt instanceof Date &&
    record.$eq.getTime() > record.$gt.getTime()
  );
}

const localQaVoiceClassifierFaultControlSchema = new Schema<ILocalQaVoiceClassifierFaultControl>(
  {
    schemaVersion: { type: Number, required: true, enum: [1], immutable: true },
    controlId: { type: String, required: true, match: CONTROL_ID, unique: true, immutable: true },
    caseId: { type: String, required: true, enum: ['MPV-061'], immutable: true },
    sessionRefHash: hashField,
    sessionCandidateDigest: hashField,
    caseTokenHash: hashField,
    candidateDigest: hashField,
    componentArtifactDigest: hashField,
    installedArtifactDigest: hashField,
    runtimeOwnerBindingHash: hashField,
    ownerScopeHash: hashField,
    callScopeHash: hashField,
    utteranceHash: optionalHashField,
    primaryProvider: boundedText,
    primaryModel: boundedText,
    fallbackProvider: boundedText,
    fallbackModel: boundedText,
    armBindingHash: hashField,
    syntheticScope: {
      type: Boolean,
      required: true,
      immutable: true,
      validate: {
        validator: (value: boolean) => value === true,
        message: 'local_qa_voice_classifier_synthetic_scope_required',
      },
    },
    state: {
      type: String,
      required: true,
      enum: VOICE_CLASSIFIER_FAULT_CONTROL_STATES,
      index: true,
    },
    armedAt: { type: Date, required: true, immutable: true },
    expiresAt: { type: Date, required: true, immutable: true },
    purgeAt: { type: Date, required: true, immutable: true },
    challengeId: { type: String, default: null, match: CHALLENGE_ID },
    challengeIssuedAt: { type: Date, default: null },
    challengeExpiresAt: { type: Date, default: null },
    replayExpiresAt: { type: Date, default: null },
    turnId: { type: String, default: null, minlength: 1, maxlength: 256 },
    segments: {
      type: [
        new Schema(
          {
            segmentId: { type: String, required: true, minlength: 1, maxlength: 256 },
            revision: { type: Number, required: true, min: 1 },
          },
          { _id: false, strict: 'throw' },
        ),
      ],
      default: undefined,
    },
    turnScopeHash: optionalHashField,
    segmentSetHash: optionalHashField,
    turnBindingHash: optionalHashField,
    coreProof: { type: String, default: null, match: PROOF },
    approvedAt: { type: Date, default: null },
    approvalProof: { type: String, default: null, match: PROOF },
    consumedAt: { type: Date, default: null },
    receiptExpiresAt: { type: Date, default: null },
    receiptDigest: optionalHashField,
    clearedAt: { type: Date, default: null },
  },
  {
    collection: 'local_qa_voice_classifier_fault_controls',
    strict: 'throw',
  },
);

localQaVoiceClassifierFaultControlSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
localQaVoiceClassifierFaultControlSchema.index({ armBindingHash: 1 }, { unique: true });

localQaVoiceClassifierFaultControlSchema.pre('save', function rejectUnsafeSave() {
  if (
    !this.isNew ||
    this.state !== 'armed' ||
    this.challengeId != null ||
    this.approvalProof != null ||
    this.consumedAt != null ||
    this.clearedAt != null
  ) {
    throw new Error('local_qa_voice_classifier_fault_save_rejected');
  }
});

localQaVoiceClassifierFaultControlSchema.pre('updateMany', function rejectBulkTransition() {
  throw new Error('local_qa_voice_classifier_fault_bulk_update_rejected');
});
localQaVoiceClassifierFaultControlSchema.pre('bulkWrite', function rejectBulkWrite() {
  throw new Error('local_qa_voice_classifier_fault_bulk_update_rejected');
});

localQaVoiceClassifierFaultControlSchema.pre('updateOne', function rejectDirectUpdate() {
  throw new Error('local_qa_voice_classifier_fault_update_rejected');
});

localQaVoiceClassifierFaultControlSchema.pre('findOneAndUpdate', function verifyTransition() {
  const filter = this.getFilter() as Record<string, unknown>;
  const options = this.getOptions();
  const update = this.getUpdate() as { $set?: Record<string, unknown> };
  const values = update?.$set;
  if (options.upsert === true || Object.keys(update || {}).join(',') !== '$set' || !values) {
    throw new Error('local_qa_voice_classifier_fault_update_rejected');
  }
  const state = String(values.state || '');
  const updateKeys = Object.keys(values).sort().join(',');
  const filterKeys = Object.keys(filter).sort().join(',');
  const valid =
    (state === 'challenged' &&
      updateKeys ===
        'challengeExpiresAt,challengeId,challengeIssuedAt,coreProof,replayExpiresAt,segmentSetHash,segments,state,turnBindingHash,turnId,turnScopeHash,utteranceHash' &&
      filterKeys === 'armBindingHash,controlId,expiresAt,state' &&
      filter.state === 'armed' &&
      exactLiveExpiryWindow(filter.expiresAt)) ||
    (state === 'approved' &&
      updateKeys === 'approvalProof,approvedAt,state' &&
      filterKeys === 'challengeExpiresAt,challengeId,controlId,state' &&
      filter.state === 'challenged' &&
      exactLiveExpiryWindow(filter.challengeExpiresAt)) ||
    (state === 'consumed' &&
      updateKeys === 'consumedAt,receiptDigest,receiptExpiresAt,state' &&
      filterKeys === 'challengeExpiresAt,challengeId,controlId,state' &&
      filter.state === 'approved' &&
      exactLiveExpiryWindow(filter.challengeExpiresAt)) ||
    (state === 'cleared' &&
      updateKeys === 'clearedAt,state' &&
      filterKeys === 'armBindingHash,state' &&
      filter.state != null &&
      typeof filter.state === 'object' &&
      Array.isArray((filter.state as { $in?: unknown }).$in) &&
      JSON.stringify((filter.state as { $in: unknown[] }).$in) ===
        JSON.stringify(['armed', 'challenged', 'approved']));
  if (!valid) throw new Error('local_qa_voice_classifier_fault_update_rejected');
});
localQaVoiceClassifierFaultControlSchema.pre('replaceOne', function rejectReplace() {
  throw new Error('local_qa_voice_classifier_fault_replace_rejected');
});
localQaVoiceClassifierFaultControlSchema.pre('findOneAndReplace', function rejectFindReplace() {
  throw new Error('local_qa_voice_classifier_fault_replace_rejected');
});
localQaVoiceClassifierFaultControlSchema.pre('deleteMany', function rejectBulkDelete() {
  throw new Error('local_qa_voice_classifier_fault_bulk_delete_rejected');
});
localQaVoiceClassifierFaultControlSchema.pre('deleteOne', function verifyReceiptDelete() {
  const filter = this.getFilter() as Record<string, unknown>;
  if (
    Object.keys(filter).sort().join(',') !== 'controlId,receiptDigest,state' ||
    typeof filter.controlId !== 'string' ||
    filter.state !== 'consumed' ||
    typeof filter.receiptDigest !== 'string' ||
    !HASH.test(filter.receiptDigest)
  ) {
    throw new Error('local_qa_voice_classifier_fault_delete_rejected');
  }
});

export default localQaVoiceClassifierFaultControlSchema;
