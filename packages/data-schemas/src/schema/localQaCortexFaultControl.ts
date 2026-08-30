/* === VIVENTIUM START ===
 * Feature: EMO-UC-048 durable local-QA fault controls.
 * Purpose: Persist bounded, redacted, append-audited, one-time fault capabilities.
 * === VIVENTIUM END === */

import { Schema } from 'mongoose';
import {
  CORTEX_LOCAL_QA_FAULT_STATES,
  CORTEX_LOCAL_QA_FAULT_BOUNDARIES,
  CORTEX_LOCAL_QA_FAULT_AUDIT_EVENTS,
} from '~/types/localQaCortexFaultControl';
import type {
  ILocalQaCortexFaultControl,
  ILocalQaCortexFaultIssuance,
  ILocalQaCortexFaultTerminalReceipt,
} from '~/types/localQaCortexFaultControl';

const HASH = /^sha256:[a-f0-9]{64}$/;
const CONTROL_ID = /^emo048_[A-Za-z0-9-]{16,80}$/;
const ALLOWED_SET_PATHS = new Set(['state', 'consumedAt', 'clearedAt']);
const SAVE_PROTECTED_PATHS = ['state', 'consumedAt', 'clearedAt', 'audit'];
const ISSUANCE_SAVE_PROTECTED_PATHS = ['authorityState', 'terminalAt'];
const ISSUANCE_TERMINAL_STATES = ['consumed', 'cleared', 'expired'] as const;
const EXACT_TRANSITION_FILTER_PATHS = new Set([
  'schemaVersion',
  'controlId',
  'capabilityKey',
  'caseTokenHash',
  'componentArtifactDigest',
  'boundary',
  'ownerScopeHash',
  'conversationScopeHash',
  'parentScopeHash',
  'syntheticScope',
  'state',
  'armedAt',
  'expiresAt',
  'purgeAt',
]);
const EXACT_ISSUANCE_TRANSITION_FILTER_PATHS = new Set(
  [...EXACT_TRANSITION_FILTER_PATHS].map((path) => (path === 'state' ? 'authorityState' : path)),
);

const auditSchema = new Schema(
  {
    sequence: { type: Number, required: true, min: 1, max: 3, validate: Number.isSafeInteger },
    event: { type: String, required: true, enum: CORTEX_LOCAL_QA_FAULT_AUDIT_EVENTS },
    at: { type: Date, required: true },
  },
  { _id: false, strict: 'throw' },
);

interface ControlTransitionUpdate {
  $set?: Record<string, unknown>;
  $push?: { audit?: { sequence?: unknown; event?: unknown; at?: unknown } };
}

interface ControlTransitionFilter {
  schemaVersion?: unknown;
  controlId?: unknown;
  capabilityKey?: unknown;
  caseTokenHash?: unknown;
  componentArtifactDigest?: unknown;
  boundary?: unknown;
  ownerScopeHash?: unknown;
  conversationScopeHash?: unknown;
  parentScopeHash?: unknown;
  syntheticScope?: unknown;
  state?: unknown;
  armedAt?: unknown;
  expiresAt?: { $eq?: unknown; $gt?: unknown; $lte?: unknown };
  purgeAt?: unknown;
}

interface ControlTransitionQuery {
  op?: string;
  getFilter?: () => object;
  getOptions?: () => { upsert?: boolean };
  getUpdate?: () => object;
}

interface IssuanceTransitionFilter extends Omit<ControlTransitionFilter, 'state'> {
  authorityState?: unknown;
}

function timestamp(value: unknown): number {
  return new Date(value instanceof Date || typeof value === 'string' ? value : '').getTime();
}

function rejectUnsafeControlSave(this: ILocalQaCortexFaultControl): void {
  if (!this.isNew) {
    if (SAVE_PROTECTED_PATHS.some((path) => this.isModified(path))) {
      throw new Error('local_qa_cortex_fault_control_update_rejected');
    }
    return;
  }

  const initialAudit = this.audit?.[0];
  if (
    this.state !== 'armed' ||
    this.consumedAt != null ||
    this.clearedAt != null ||
    this.audit?.length !== 1 ||
    initialAudit?.sequence !== 1 ||
    initialAudit?.event !== 'armed' ||
    timestamp(initialAudit?.at) !== timestamp(this.armedAt)
  ) {
    throw new Error('local_qa_cortex_fault_control_update_rejected');
  }
}

function rejectUnsafeIssuanceSave(this: ILocalQaCortexFaultIssuance): void {
  if (!this.isNew) {
    if (ISSUANCE_SAVE_PROTECTED_PATHS.some((path) => this.isModified(path))) {
      throw new Error('local_qa_cortex_fault_issuance_update_rejected');
    }
    return;
  }
  if (this.authorityState !== 'armed' || this.terminalAt != null) {
    throw new Error('local_qa_cortex_fault_issuance_update_rejected');
  }
}

function exactHash(value: unknown): boolean {
  return typeof value === 'string' && HASH.test(value);
}

function validTransitionFilter(
  filter: ControlTransitionFilter,
  targetState: unknown,
  transitionAt: number,
): boolean {
  const filterPaths = Object.keys(filter);
  const expiry = filter.expiresAt;
  if (
    filterPaths.length !== EXACT_TRANSITION_FILTER_PATHS.size ||
    !filterPaths.every((path) => EXACT_TRANSITION_FILTER_PATHS.has(path)) ||
    filter.schemaVersion !== 1 ||
    typeof filter.controlId !== 'string' ||
    !CONTROL_ID.test(filter.controlId) ||
    !exactHash(filter.capabilityKey) ||
    !exactHash(filter.caseTokenHash) ||
    !exactHash(filter.componentArtifactDigest) ||
    !CORTEX_LOCAL_QA_FAULT_BOUNDARIES.includes(
      filter.boundary as (typeof CORTEX_LOCAL_QA_FAULT_BOUNDARIES)[number],
    ) ||
    !exactHash(filter.ownerScopeHash) ||
    !exactHash(filter.conversationScopeHash) ||
    !exactHash(filter.parentScopeHash) ||
    filter.syntheticScope !== true ||
    filter.state !== 'armed' ||
    !Number.isFinite(timestamp(filter.armedAt)) ||
    !Number.isFinite(timestamp(filter.purgeAt)) ||
    !expiry ||
    typeof expiry !== 'object' ||
    Array.isArray(expiry) ||
    !Number.isFinite(timestamp(expiry.$eq))
  ) {
    return false;
  }
  const expiryPaths = Object.keys(expiry).sort().join(',');
  if (targetState === 'expired') {
    return expiryPaths === '$eq,$lte' && timestamp(expiry.$lte) === transitionAt;
  }
  return expiryPaths === '$eq,$gt' && timestamp(expiry.$gt) === transitionAt;
}

function rejectUnsafeControlUpdate(this: ControlTransitionQuery): void {
  if (this.op === 'updateMany' || this.getOptions?.().upsert === true) {
    throw new Error('local_qa_cortex_fault_control_update_rejected');
  }
  const update = (this.getUpdate?.() || {}) as ControlTransitionUpdate;
  const entries = Object.entries(update);
  const safe = entries.every(([operator, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const paths = Object.keys(value);
    if (operator === '$set') return paths.every((path) => ALLOWED_SET_PATHS.has(path));
    if (operator !== '$push' || paths.length !== 1 || paths[0] !== 'audit') return false;
    const audit = (value as { audit?: object }).audit;
    return Boolean(audit && typeof audit === 'object' && !Array.isArray(audit));
  });
  if (!safe || entries.length === 0) {
    throw new Error('local_qa_cortex_fault_control_update_rejected');
  }
  const set = update.$set || {};
  const audit = update.$push?.audit;
  const state = set.state;
  const exactSetPaths = Object.keys(set).sort().join(',');
  let requiredSetPaths = '';
  if (state === 'consumed') requiredSetPaths = 'consumedAt,state';
  else if (state === 'cleared') requiredSetPaths = 'clearedAt,state';
  else if (state === 'expired') requiredSetPaths = 'state';
  const transitionAt = timestamp(audit?.at);
  const stateAt = state === 'consumed' ? timestamp(set.consumedAt) : timestamp(set.clearedAt);
  const filter = (this.getFilter?.() || {}) as ControlTransitionFilter;
  if (
    !audit ||
    !requiredSetPaths ||
    exactSetPaths !== requiredSetPaths ||
    audit.sequence !== 2 ||
    audit.event !== state ||
    !Number.isFinite(transitionAt) ||
    (state !== 'expired' && stateAt !== transitionAt) ||
    !validTransitionFilter(filter, state, transitionAt)
  ) {
    throw new Error('local_qa_cortex_fault_control_update_rejected');
  }
}

function validIssuanceTransitionFilter(
  filter: IssuanceTransitionFilter,
  targetState: unknown,
  transitionAt: number,
): boolean {
  const filterPaths = Object.keys(filter);
  const expiry = filter.expiresAt;
  if (
    filterPaths.length !== EXACT_ISSUANCE_TRANSITION_FILTER_PATHS.size ||
    !filterPaths.every((path) => EXACT_ISSUANCE_TRANSITION_FILTER_PATHS.has(path)) ||
    filter.schemaVersion !== 1 ||
    typeof filter.controlId !== 'string' ||
    !CONTROL_ID.test(filter.controlId) ||
    !exactHash(filter.capabilityKey) ||
    !exactHash(filter.caseTokenHash) ||
    !exactHash(filter.componentArtifactDigest) ||
    !CORTEX_LOCAL_QA_FAULT_BOUNDARIES.includes(
      filter.boundary as (typeof CORTEX_LOCAL_QA_FAULT_BOUNDARIES)[number],
    ) ||
    !exactHash(filter.ownerScopeHash) ||
    !exactHash(filter.conversationScopeHash) ||
    !exactHash(filter.parentScopeHash) ||
    filter.syntheticScope !== true ||
    filter.authorityState !== 'armed' ||
    !Number.isFinite(timestamp(filter.armedAt)) ||
    !Number.isFinite(timestamp(filter.purgeAt)) ||
    !expiry ||
    typeof expiry !== 'object' ||
    Array.isArray(expiry) ||
    !Number.isFinite(timestamp(expiry.$eq))
  ) {
    return false;
  }
  const expiryPaths = Object.keys(expiry).sort().join(',');
  if (targetState === 'expired') {
    return expiryPaths === '$eq,$lte' && timestamp(expiry.$lte) === transitionAt;
  }
  return expiryPaths === '$eq,$gt' && timestamp(expiry.$gt) === transitionAt;
}

function rejectUnsafeIssuanceUpdate(this: ControlTransitionQuery): void {
  if (this.op === 'updateMany' || this.getOptions?.().upsert === true) {
    throw new Error('local_qa_cortex_fault_issuance_update_rejected');
  }
  const update = (this.getUpdate?.() || {}) as { $set?: Record<string, unknown> };
  if (
    Object.keys(update).length !== 1 ||
    !update.$set ||
    Object.keys(update.$set).sort().join(',') !== 'authorityState,terminalAt'
  ) {
    throw new Error('local_qa_cortex_fault_issuance_update_rejected');
  }
  const targetState = update.$set.authorityState;
  const transitionAt = timestamp(update.$set.terminalAt);
  if (
    !ISSUANCE_TERMINAL_STATES.includes(targetState as (typeof ISSUANCE_TERMINAL_STATES)[number]) ||
    !Number.isFinite(transitionAt) ||
    !validIssuanceTransitionFilter(
      (this.getFilter?.() || {}) as IssuanceTransitionFilter,
      targetState,
      transitionAt,
    )
  ) {
    throw new Error('local_qa_cortex_fault_issuance_update_rejected');
  }
}

const localQaCortexFaultControlSchema = new Schema<ILocalQaCortexFaultControl>(
  {
    schemaVersion: { type: Number, required: true, enum: [1], immutable: true },
    controlId: { type: String, required: true, match: CONTROL_ID, unique: true, immutable: true },
    capabilityKey: { type: String, required: true, match: HASH, immutable: true },
    caseTokenHash: { type: String, required: true, match: HASH, index: true, immutable: true },
    componentArtifactDigest: { type: String, required: true, match: HASH, immutable: true },
    boundary: {
      type: String,
      required: true,
      enum: CORTEX_LOCAL_QA_FAULT_BOUNDARIES,
      immutable: true,
    },
    ownerScopeHash: { type: String, required: true, match: HASH, immutable: true },
    conversationScopeHash: { type: String, required: true, match: HASH, immutable: true },
    parentScopeHash: { type: String, required: true, match: HASH, immutable: true },
    syntheticScope: {
      type: Boolean,
      required: true,
      immutable: true,
      validate: {
        validator: (value: boolean) => value === true,
        message: 'local_qa_cortex_fault_control_synthetic_scope_required',
      },
    },
    state: { type: String, required: true, enum: CORTEX_LOCAL_QA_FAULT_STATES, index: true },
    armedAt: { type: Date, required: true, immutable: true },
    expiresAt: { type: Date, required: true, index: true, immutable: true },
    purgeAt: { type: Date, required: true, immutable: true },
    consumedAt: { type: Date, default: null },
    clearedAt: { type: Date, default: null },
    audit: {
      type: [auditSchema],
      required: true,
      validate: {
        validator: (events: object[]) => events.length >= 1 && events.length <= 3,
        message: 'local_qa_cortex_fault_control_audit_bounded',
      },
    },
  },
  { strict: 'throw' },
);

const authorityFields = {
  schemaVersion: { type: Number, required: true, enum: [1], immutable: true },
  controlId: { type: String, required: true, match: CONTROL_ID, immutable: true },
  capabilityKey: { type: String, required: true, match: HASH, unique: true, immutable: true },
  caseTokenHash: { type: String, required: true, match: HASH, immutable: true },
  componentArtifactDigest: { type: String, required: true, match: HASH, immutable: true },
  boundary: {
    type: String,
    required: true,
    enum: CORTEX_LOCAL_QA_FAULT_BOUNDARIES,
    immutable: true,
  },
  ownerScopeHash: { type: String, required: true, match: HASH, immutable: true },
  conversationScopeHash: { type: String, required: true, match: HASH, immutable: true },
  parentScopeHash: { type: String, required: true, match: HASH, immutable: true },
  syntheticScope: {
    type: Boolean,
    required: true,
    immutable: true,
    validate: (value: boolean) => value === true,
  },
  armedAt: { type: Date, required: true, immutable: true },
  expiresAt: { type: Date, required: true, immutable: true },
  purgeAt: { type: Date, required: true, immutable: true },
} as const;

export const localQaCortexFaultIssuanceSchema = new Schema<ILocalQaCortexFaultIssuance>(
  {
    ...authorityFields,
    authorityState: {
      type: String,
      required: true,
      enum: CORTEX_LOCAL_QA_FAULT_STATES,
    },
    terminalAt: { type: Date, default: null },
  },
  {
    collection: 'local_qa_cortex_fault_issuances',
    strict: 'throw',
  },
);

export const localQaCortexFaultTerminalReceiptSchema =
  new Schema<ILocalQaCortexFaultTerminalReceipt>(
    {
      ...authorityFields,
      terminalState: {
        type: String,
        required: true,
        enum: ['consumed', 'cleared', 'expired'],
        immutable: true,
      },
      terminalAt: { type: Date, required: true, immutable: true },
    },
    {
      collection: 'local_qa_cortex_fault_terminal_receipts',
      strict: 'throw',
    },
  );

localQaCortexFaultIssuanceSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
localQaCortexFaultTerminalReceiptSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

localQaCortexFaultIssuanceSchema.pre('save', rejectUnsafeIssuanceSave);
localQaCortexFaultIssuanceSchema.pre('bulkWrite', function rejectIssuanceBulkWrite() {
  throw new Error('local_qa_cortex_fault_issuance_update_rejected');
});
for (const operation of ['findOneAndUpdate', 'updateOne', 'updateMany']) {
  localQaCortexFaultIssuanceSchema.pre(operation, rejectUnsafeIssuanceUpdate);
}
for (const operation of ['findOneAndReplace', 'replaceOne']) {
  localQaCortexFaultIssuanceSchema.pre(operation, function rejectIssuanceReplacement() {
    throw new Error('local_qa_cortex_fault_issuance_update_rejected');
  });
}
// Direct deletion of every authority collection by a database administrator is outside the
// application boundary. Normal application model paths cannot delete issuance authority.
for (const operation of ['deleteOne', 'deleteMany', 'findOneAndDelete']) {
  localQaCortexFaultIssuanceSchema.pre(operation, function rejectIssuanceDeletion() {
    throw new Error('local_qa_cortex_fault_issuance_delete_rejected');
  });
}

localQaCortexFaultControlSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
localQaCortexFaultControlSchema.index(
  {
    caseTokenHash: 1,
    componentArtifactDigest: 1,
    boundary: 1,
    ownerScopeHash: 1,
    conversationScopeHash: 1,
    parentScopeHash: 1,
  },
  { unique: true },
);
localQaCortexFaultControlSchema.pre('save', rejectUnsafeControlSave);
localQaCortexFaultControlSchema.pre('bulkWrite', function rejectBulkWrite() {
  throw new Error('local_qa_cortex_fault_control_update_rejected');
});
for (const operation of ['findOneAndUpdate', 'updateOne', 'updateMany']) {
  localQaCortexFaultControlSchema.pre(operation, rejectUnsafeControlUpdate);
}
for (const operation of ['findOneAndReplace', 'replaceOne']) {
  localQaCortexFaultControlSchema.pre(operation, function rejectReplacement() {
    throw new Error('local_qa_cortex_fault_control_update_rejected');
  });
}

export default localQaCortexFaultControlSchema;
