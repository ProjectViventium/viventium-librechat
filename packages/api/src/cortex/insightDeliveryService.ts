/* === VIVENTIUM START ===
 * Feature: Durable cortex insight delivery ledger.
 * Purpose: Give each completed insight one owner-scoped, idempotent terminal persistence outcome.
 * === VIVENTIUM END === */

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import type { ClientSession } from 'mongoose';
import {
  logger,
  CORTEX_INSIGHT_DROP_REASONS as DROP_REASONS,
  CORTEX_INSIGHT_FAILURE_REASONS as FAILURE_REASONS,
  CORTEX_INSIGHT_RECOVERY_DEFERRAL_REASONS as RECOVERY_DEFERRAL_REASONS,
} from '@librechat/data-schemas';
import type {
  CortexFeelingAgentScope,
  CortexInsightDeliveryEventTransition,
  ICortexInsightDeliveryEvent,
  IViventiumCortexFeelingSnapshot,
  IViventiumCortexInsightDelivery,
} from '@librechat/data-schemas';

type DataRecord = Record<string, unknown>;
type CodedError = Error & { code: string };
type DeliverySurface =
  | 'web'
  | 'telegram'
  | 'voice'
  | 'workbench'
  | 'scheduler'
  | 'playground'
  | 'wing'
  | 'gateway'
  | 'librechat'
  | 'unknown';

interface NormalizedCortexFeelingSnapshot extends Omit<IViventiumCortexFeelingSnapshot, 'asOf'> {
  asOf: string;
}

interface CortexInsightInput {
  insight?: unknown;
  status?: unknown;
  cortexId?: unknown;
  cortex_id?: unknown;
  agentId?: unknown;
  agent_id?: unknown;
  cortexName?: unknown;
  cortex_name?: unknown;
  feelingSnapshot?: unknown;
}

interface CortexDeliveryCandidate {
  deliveryKey: string;
  deliveryId: string;
  userId: string;
  conversationId: string;
  parentMessageId: string;
  cortexId: string;
  cortexName: string;
  insightHash: string;
  graphResultHash: string;
  surface: DeliverySurface;
  requiredSurfaces: DeliverySurface[];
  streamId: string;
  sourceRevision: number;
  presentationRevision: number;
  messageRevision: number;
  batchId?: string;
  batchSize?: number;
  batchMemberHashes?: string[];
  parentAdmissionKey?: string;
}

interface CortexDeliveryLike extends Partial<CortexDeliveryRow> {
  _id?: unknown;
  __v?: unknown;
  outboxKey?: string;
}

export interface BuildCortexInsightDeliveryCandidatesInput {
  ownerId: unknown;
  conversationId: unknown;
  parentMessageId: unknown;
  surface: unknown;
  streamId?: unknown;
  messageRevision?: unknown;
  insights?: CortexInsightInput[] | null;
}

interface CortexClaim {
  deliveryId: string;
  claimToken: string;
  claimGeneration: number;
}

interface PresentationFence {
  surface: string;
  parentMessageId?: string;
  persistedMessageId: string;
  messageRevision: number;
  presentationGeneration?: number;
  presentationClaimToken?: string;
  claimGeneration?: number;
  graphResultHash?: string;
  presentationLeaseToken?: string;
  presentationRef: string;
}

interface PresentationLeaseFence {
  surface?: unknown;
  parentMessageId?: unknown;
  persistedMessageId?: unknown;
  messageRevision?: unknown;
  ownerId?: unknown;
  token?: unknown;
  expiresAt?: Date | string;
}

interface BatchDescriptor extends DataRecord {
  type: 'claim' | 'settle' | 'present' | 'finalize' | 'renew';
  ownerId?: string;
  deliveryIds?: string[];
  claims?: CortexClaim[];
  surface?: string;
  leaseMs?: unknown;
  claimToken?: string;
  claimedAt?: Date | string;
  incrementAttempt?: boolean;
  runtimeSlot?: string;
  runtimeEpoch?: string;
  transition?: CortexInsightDeliveryEventTransition;
  projection?: DataRecord;
  reason?: string;
  receiptHash?: string;
  receipt?: PresentationFence;
  renewedAt?: Date | string;
  leaseExpiresAt?: Date | string;
  presentation?: PresentationLeaseFence | null;
}

interface BatchIntent {
  token: string;
  phase: 'prepared' | 'repairing' | 'committed';
  runtimeSlot: string;
  runtimeEpoch: string;
  operation: BatchDescriptor['type'];
  createdAt: Date;
  committedAt?: Date;
  repairRuntimeSlot?: string;
  repairRuntimeEpoch?: string;
  descriptor: BatchDescriptor;
}

interface CortexDeliveryRow extends Omit<
  IViventiumCortexInsightDelivery,
  'feelingSnapshot' | 'batchIntent'
> {
  feelingSnapshot: NormalizedCortexFeelingSnapshot | IViventiumCortexFeelingSnapshot | null;
  batchIntent: BatchIntent | null;
  toObject?: () => CortexDeliveryRow;
}

interface CortexQuery<T> extends PromiseLike<T> {
  select?(selection: string): CortexQuery<T>;
  lean?(): CortexQuery<T>;
  session?(session: ClientSession): CortexQuery<T>;
  sort?(sort: DataRecord): CortexQuery<T>;
  limit?(limit: number): CortexQuery<T>;
}

interface DriverFindOneAndUpdateResult {
  value: CortexDeliveryRow | null;
}

interface CortexDeliveryCollection {
  findOneAndUpdate?(
    filter: DataRecord,
    update: DataRecord,
    options: DataRecord,
  ): Promise<CortexDeliveryRow | DriverFindOneAndUpdateResult | null>;
  updateOne?(
    filter: DataRecord,
    update: DataRecord,
    options?: DataRecord,
  ): Promise<{ modifiedCount?: number; nModified?: number }>;
}

type TransactionMongoose = typeof mongoose & {
  transactionAsyncLocalStorage?: {
    getStore?: () => { session?: ClientSession } | undefined;
  };
};

interface CortexDeliveryDatabase {
  base?: TransactionMongoose;
  startSession?: () => Promise<ClientSession>;
}

interface CortexDeliveryModel {
  db?: CortexDeliveryDatabase;
  collection?: CortexDeliveryCollection;
  findOne(filter: DataRecord): CortexQuery<CortexDeliveryRow | null>;
  find(filter: DataRecord, projection?: DataRecord): CortexQuery<CortexDeliveryRow[]>;
  findOneAndUpdate(
    filter: DataRecord,
    update: DataRecord,
    options: DataRecord,
  ): CortexQuery<CortexDeliveryRow | null>;
  updateMany(
    filter: DataRecord,
    update: DataRecord,
    options?: DataRecord,
  ): CortexQuery<{ modifiedCount?: number; nModified?: number }>;
}

interface CortexNoClaimResult {
  claimId: string;
  deliveries: Array<CortexDeliveryLike | null>;
  claimed: CortexDeliveryLike[];
  insights: CortexInsightInput[];
  recoveryContext: DataRecord | null;
  noClaimReason: string;
}

interface DatabaseBatchLock {
  coordinatorId: string;
  lockToken: string;
}

interface AtomicBatchWorkContext {
  session: ClientSession | null;
  compensate: boolean;
}

interface RecordCortexInsightRowsInput extends BuildCortexInsightDeliveryCandidatesInput {
  feelingSnapshot?: unknown;
}

interface ExecuteBatchIntentOptions {
  allowExpiredLease?: boolean;
  releaseSameBootClaim?: boolean;
}

interface ClaimOneOptions {
  surface?: unknown;
  leaseMs?: unknown;
  batchClaimToken?: string;
  batchClaimedAt?: Date | null;
  incrementAttempt?: boolean;
  intentToken?: string;
  claimRuntimeSlot?: unknown;
  claimRuntimeEpoch?: unknown;
  session?: ClientSession | null;
}

interface ClaimRowsAtomicallyInput {
  ownerId: unknown;
  parentMessageId: unknown;
  rows: CortexDeliveryRow[];
  surface: unknown;
  leaseMs: unknown;
  terminalSettlement?: boolean;
}

interface ClaimCortexInsightBatchInput extends RecordCortexInsightRowsInput {
  leaseMs?: unknown;
}

interface ClaimPendingByParentInput {
  ownerId: unknown;
  parentMessageId: unknown;
  surface: unknown;
  leaseMs?: unknown;
  terminalSettlement?: boolean;
}

interface SettleOneInput {
  ownerId: unknown;
  claim: CortexClaimInput;
  transition: CortexInsightDeliveryEventTransition;
  projection: DataRecord;
  reason?: string;
  receiptHash?: string;
  intentToken?: string;
  allowExpiredLease?: boolean;
  session?: ClientSession | null;
}

interface AtomicClaimOperationContext {
  claims: CortexClaim[];
  beforeRows: CortexDeliveryRow[];
  changedIds: Set<string>;
  session: ClientSession | null;
}

interface RunAtomicClaimBatchInput {
  ownerId: unknown;
  claims: CortexClaimInput[] | null | undefined;
  descriptor: BatchDescriptor;
  operation: (context: AtomicClaimOperationContext) => Promise<CortexDeliveryLike[]>;
}

interface SettleClaimsInput {
  ownerId: unknown;
  claims: CortexClaimInput[] | null | undefined;
  transition: CortexInsightDeliveryEventTransition;
  projection: DataRecord;
  reason?: string;
  receiptHash?: string;
  allowExpiredLease?: boolean;
}

interface OwnerClaimsInput {
  ownerId: unknown;
  claims: CortexClaimInput[] | null | undefined;
}

interface MarkPersistedInput extends OwnerClaimsInput {
  persistedMessageId: unknown;
  messageRevision?: unknown;
}

interface PresentationReceiptInput {
  surface: unknown;
  persistedMessageId: unknown;
  messageRevision?: unknown;
  presentationRef: unknown;
  presentationClaimToken?: unknown;
  claimGeneration?: unknown;
  graphResultHash?: unknown;
  presentationLeaseToken?: unknown;
}

interface FinalizePresentedOneInput {
  ownerId: unknown;
  claim: CortexClaimInput;
  intentToken?: string;
  allowExpiredLease?: boolean;
  presentationClaimToken?: unknown;
  presentationLeaseToken?: unknown;
  session?: ClientSession | null;
}

interface MarkPresentedOneInput extends PresentationReceiptInput {
  ownerId: unknown;
  claim: CortexClaimInput;
  presentationGeneration?: unknown;
  intentToken?: string;
  allowExpiredLease?: boolean;
  session?: ClientSession | null;
}

interface MarkPresentedInput extends OwnerClaimsInput, PresentationReceiptInput {
  presentationGeneration?: unknown;
}

interface PresentationReceiptRequest {
  surface: unknown;
  presentationRef: unknown;
}

interface MarkSentInput extends MarkPersistedInput {
  presentationReceipts: PresentationReceiptRequest[] | null | undefined;
}

interface MarkFailedInput extends OwnerClaimsInput {
  reason: unknown;
}

interface MarkDroppedInput extends OwnerClaimsInput {
  dropReason: unknown;
  allowExpiredLease?: boolean;
}

interface RenewOneInput {
  ownerId: unknown;
  claim: CortexClaim;
  renewedAt: Date;
  leaseExpiresAt: Date;
  presentationLease?: PresentationLeaseFence | null;
  intentToken?: string;
  allowExpiredLease?: boolean;
  session?: ClientSession | null;
}

interface RenewClaimInput extends OwnerClaimsInput {
  leaseMs?: unknown;
  presentation?: PresentationLeaseFence | null;
}

interface FencePresentationInput extends OwnerClaimsInput {
  surface: unknown;
  parentMessageId?: unknown;
  persistedMessageId: unknown;
  messageRevision?: unknown;
  leaseMs?: unknown;
}

interface CortexPresentationClaim extends CortexClaim {
  graphResultHash: string;
  attemptNumber: number;
  presentationLeaseToken: string;
}

interface CortexDeliveryReceipt {
  deliveryId: string;
  graphResultHash: string;
}

interface FencePresentationResult {
  ownerId: string;
  claims: CortexPresentationClaim[];
  deliveryIds: string[];
  deliveryReceipts: CortexDeliveryReceipt[];
  generation: number;
  claimToken: string;
  presentationLeaseToken: string;
  messageId: string;
  parentMessageId: string;
  revision: number;
  surface: DeliverySurface;
}

interface FencePresentationByParentInput {
  ownerId: unknown;
  parentMessageId: unknown;
  surface: unknown;
  persistedMessageId: unknown;
  messageRevision?: unknown;
  expectedDeliveryIds?: unknown[] | null;
  expectedGeneration?: unknown;
  leaseMs?: unknown;
}

interface ListRecoverableParentsInput {
  limit?: number;
}

interface DeferRecoverableParentInput {
  ownerId: unknown;
  parentMessageId: unknown;
  surface: unknown;
  reason?: unknown;
}

interface OwnerParentInput {
  ownerId: unknown;
  parentMessageId: unknown;
}

interface ExpectedDeliveryReceiptInput {
  deliveryId?: unknown;
  graphResultHash?: unknown;
}

interface MarkPresentationByParentInput extends OwnerParentInput {
  surface: unknown;
  persistedMessageId?: unknown;
  messageRevision?: unknown;
  presentationGeneration?: unknown;
  presentationClaimToken?: unknown;
  presentationRef: unknown;
  expectedDeliveryIds?: unknown[] | null;
  expectedDeliveryReceipts?: ExpectedDeliveryReceiptInput[] | null;
  expectedPresentationLeaseToken?: unknown;
}

interface ListByParentInput extends OwnerParentInput {
  surface?: unknown;
}

function isTerminalStatus(status: unknown): boolean {
  return typeof status === 'string' && TERMINAL_STATUSES.has(status);
}

interface RepairIncompleteBatchesInput {
  ownerId?: unknown;
  parentMessageId?: unknown;
  limit?: number;
}

interface RepairIncompleteBatchesResult {
  scanned: number;
  repaired: number;
  deferred: number;
  failed: number;
}
type StandaloneMutationHook = (input: {
  operation: BatchDescriptor['type'];
  deliveryId: string;
  mutationIndex: number;
}) => unknown | Promise<unknown>;
type StandaloneRecordWriteHook = (input: DataRecord) => unknown | Promise<unknown>;

export interface CortexInsightDeliveryServiceOptions {
  DeliveryModel: CortexDeliveryModel;
  mongooseInstance?: typeof mongoose;
  now?: () => Date;
  randomUUID?: () => string;
  runtimeSlot?: unknown;
  runtimeEpoch?: unknown;
  afterStandaloneMutation?: StandaloneMutationHook | null;
  afterStandaloneRecordWrite?: StandaloneRecordWriteHook | null;
  consumeFault?: (input: DataRecord) => Promise<DataRecord | null>;
}

export const CORTEX_INSIGHT_DROP_REASONS = Object.freeze([...DROP_REASONS]);
export const CORTEX_INSIGHT_RETRYABLE_FAILURE_REASONS = Object.freeze([...FAILURE_REASONS]);
const COMPLETED_STATUSES = new Set(['complete', 'completed', 'done']);
const TERMINAL_STATUSES = new Set(['sent', 'dropped']);
const DELIVERY_SURFACES = new Set([
  'web',
  'telegram',
  'voice',
  'workbench',
  'scheduler',
  'playground',
  'wing',
  'gateway',
  'librechat',
]);
function isKnownDeliverySurface(value: string): value is Exclude<DeliverySurface, 'unknown'> {
  return DELIVERY_SURFACES.has(value);
}
const DEFAULT_LEASE_MS = 60 * 60 * 1000;
const DEFAULT_PRESENTATION_LEASE_MS = 30 * 1000;
const DEFAULT_BATCH_LOCK_MS = 30 * 1000;
const MIN_RECOVERY_BACKOFF_MS = 1_000;
const MAX_RECOVERY_BACKOFF_MS = 60_000;
const MAX_RECOVERY_ATTEMPT_NUMBER = 16;
const MAX_FEELING_CAPSULE_CHARS = 16_000;
const FEELING_SNAPSHOT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const FEELING_AGENT_SCOPES = new Set<CortexFeelingAgentScope>(['all_agents', 'conscious_agent']);
const RECOVERY_NO_CLAIM_REASONS = Object.freeze({
  CONFLICT: 'recovery_claim_conflict',
  INCOMPLETE_BATCH: 'recovery_parent_incomplete_batch',
  INCONSISTENT_ELIGIBILITY: 'recovery_parent_inconsistent_eligibility',
  MIXED_ENVELOPE: 'recovery_parent_mixed_envelope',
  NOT_CLAIMABLE: 'recovery_parent_not_claimable',
  NOT_YET_ELIGIBLE: 'recovery_not_yet_eligible',
  TERMINAL: 'recovery_parent_terminal',
});
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const LOCAL_BATCH_LOCKS = new WeakMap<CortexDeliveryModel, Map<string, Promise<void>>>();
const TRANSACTION_SUPPORT = new WeakMap<CortexDeliveryModel, boolean>();
const PROCESS_RUNTIME_EPOCH = `boot_${crypto.randomUUID()}`;

function normalizeText(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .trim();
}

function exactInsightText(value: unknown): string {
  const exact = value == null ? '' : String(value);
  return exact.trim() ? exact : '';
}

function stableHash(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex');
}

function codedError(message: string, code: string): CodedError {
  return Object.assign(new Error(message), { code });
}

function isDataRecord(value: unknown): value is DataRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): unknown {
  return isDataRecord(error) ? error.code : undefined;
}

function requiredDate(value: Date | string | undefined, field: string): Date {
  if (value instanceof Date || typeof value === 'string') return new Date(value);
  throw batchConflictError(`Cortex batch intent requires ${field}`);
}

function requiredPresentationFence(value: PresentationFence | null | undefined): PresentationFence {
  if (!value) throw batchConflictError('Cortex batch intent requires a presentation receipt');
  return value;
}

function unwrapCollectionResult(
  result: CortexDeliveryRow | DriverFindOneAndUpdateResult | null,
): CortexDeliveryRow | null {
  if (!result) return null;
  return 'value' in result ? result.value : result;
}

function onlySetValue<T>(values: Set<T>, errorMessage: string): T {
  const iterator = values.values().next();
  if (iterator.done) throw settlementConflictError(errorMessage);
  return iterator.value;
}

function isCortexFeelingAgentScope(value: unknown): value is CortexFeelingAgentScope {
  return typeof value === 'string' && FEELING_AGENT_SCOPES.has(value as CortexFeelingAgentScope);
}

function feelingSnapshotError(
  message = 'Cortex request-pinned Feelings receipt is invalid',
): CodedError {
  return codedError(message, 'cortex_feeling_snapshot_invalid');
}

function boundedFeelingCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw feelingSnapshotError();
  }
  return value;
}

export function normalizeCortexFeelingSnapshot(
  snapshot: unknown,
): NormalizedCortexFeelingSnapshot | null {
  if (snapshot == null) return null;
  if (!isDataRecord(snapshot)) {
    throw feelingSnapshotError();
  }
  const agentScope = snapshot.agentScope;
  const snapshotHash = snapshot.snapshotHash;
  const capsule = snapshot.capsule;
  const version = snapshot.version;
  const asOfInput = snapshot.asOf;
  const asOf =
    asOfInput instanceof Date || typeof asOfInput === 'string' ? new Date(asOfInput) : null;
  if (
    typeof snapshot.available !== 'boolean' ||
    typeof snapshot.enabled !== 'boolean' ||
    !isCortexFeelingAgentScope(agentScope) ||
    typeof snapshotHash !== 'string' ||
    !FEELING_SNAPSHOT_HASH_PATTERN.test(snapshotHash) ||
    typeof capsule !== 'string' ||
    capsule.length > MAX_FEELING_CAPSULE_CHARS ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 0 ||
    !asOf ||
    !Number.isFinite(asOf.getTime()) ||
    (typeof asOfInput === 'string' && asOf.toISOString() !== asOfInput)
  ) {
    throw feelingSnapshotError();
  }
  return {
    available: snapshot.available === true,
    enabled: snapshot.enabled === true,
    agentScope,
    version,
    asOf: asOf.toISOString(),
    capsule,
    snapshotHash,
    rangePromptOverrideCount: boundedFeelingCount(snapshot.rangePromptOverrideCount),
    activeRangePromptOverrideCount: boundedFeelingCount(snapshot.activeRangePromptOverrideCount),
    activeRangePromptOverrideChars: boundedFeelingCount(snapshot.activeRangePromptOverrideChars),
  };
}

function feelingSnapshotIdentity(snapshot: unknown): string {
  const normalized = normalizeCortexFeelingSnapshot(snapshot);
  return normalized ? JSON.stringify(normalized) : '';
}

function deliveryEnvelopeConflictError(): CodedError {
  return codedError(
    'Cortex insight delivery envelope conflicts with stored work',
    'cortex_insight_delivery_envelope_conflict',
  );
}

function strictEnvelopeText(
  value: unknown,
  { required = false }: { required?: boolean } = {},
): string {
  if (typeof value !== 'string' || (required && value.length === 0)) {
    throw deliveryEnvelopeConflictError();
  }
  return value;
}

function presentationRevisionOf(entry: CortexDeliveryLike | null | undefined): number {
  if (entry?.presentationRevision != null) {
    return Math.max(1, Number(entry.presentationRevision) || 1);
  }
  if (
    entry?.persistenceStatus === 'persisted' ||
    (typeof entry?.status === 'string' && TERMINAL_STATUSES.has(entry.status))
  ) {
    return Math.max(1, Number(entry?.messageRevision) || 1);
  }
  return 1;
}

function presentationRevisionFilter(revision: number): DataRecord {
  return {
    $or: [
      { presentationRevision: revision },
      { presentationRevision: { $exists: false }, messageRevision: revision },
    ],
  };
}

function presentationRevisionCasFilter(
  entry: CortexDeliveryLike | null | undefined,
  revision: number,
): DataRecord {
  if (entry?.presentationRevision != null) return { presentationRevision: revision };
  if (entry?.messageRevision != null) {
    return {
      presentationRevision: { $exists: false },
      messageRevision: Math.max(1, Number(entry.messageRevision) || 1),
    };
  }
  return {
    presentationRevision: { $exists: false },
    messageRevision: { $exists: false },
  };
}

export function cortexInsightPersistenceEnvelopeIdentity(entry: CortexDeliveryLike): string {
  const sourceRevision = Number(entry?.sourceRevision ?? entry?.messageRevision);
  const receiptHash = entry?.graphResultHash ?? entry?.insightHash;
  const surface = normalizeSurface(strictEnvelopeText(entry?.surface, { required: true }));
  if (
    !Number.isSafeInteger(sourceRevision) ||
    sourceRevision < 1 ||
    surface === 'unknown' ||
    typeof receiptHash !== 'string' ||
    !FEELING_SNAPSHOT_HASH_PATTERN.test(receiptHash)
  ) {
    throw deliveryEnvelopeConflictError();
  }
  return JSON.stringify({
    deliveryKey: strictEnvelopeText(entry?.deliveryKey ?? entry?.outboxKey, { required: true }),
    deliveryId: strictEnvelopeText(entry?.deliveryId ?? ''),
    userId: strictEnvelopeText(entry?.userId, { required: true }),
    conversationId: strictEnvelopeText(entry?.conversationId, { required: true }),
    parentMessageId: strictEnvelopeText(entry?.parentMessageId, { required: true }),
    cortexId: strictEnvelopeText(entry?.cortexId, { required: true }),
    cortexName: strictEnvelopeText(entry?.cortexName ?? ''),
    insightHash: strictEnvelopeText(entry?.insightHash, { required: true }),
    streamId: strictEnvelopeText(entry?.streamId ?? ''),
    sourceRevision,
    receiptHash,
    feelingSnapshot: normalizeCortexFeelingSnapshot(entry?.feelingSnapshot),
  });
}

function exactEnvelopeRequiredSurfaces(entry: CortexDeliveryLike): DeliverySurface[] {
  const surface = normalizeSurface(entry?.surface);
  const requiredSurfaces = Array.isArray(entry?.requiredSurfaces)
    ? entry.requiredSurfaces
    : requiredSurfacesFor(surface);
  const normalized = requiredSurfaces.map(normalizeSurface);
  const canonical = requiredSurfacesFor(surface);
  if (
    surface === 'unknown' ||
    normalized.some((value) => value === 'unknown') ||
    normalized.length !== new Set(normalized).size ||
    normalized.length !== canonical.length ||
    canonical.some((value) => !normalized.includes(value))
  ) {
    throw deliveryEnvelopeConflictError();
  }
  return normalized;
}

export function requireExactCortexInsightPersistenceEnvelope(
  expected: CortexDeliveryLike,
  persisted: CortexDeliveryLike,
): CortexDeliveryLike {
  let expectedIdentity;
  let persistedIdentity;
  try {
    expectedIdentity = cortexInsightPersistenceEnvelopeIdentity(expected);
    persistedIdentity = cortexInsightPersistenceEnvelopeIdentity(persisted);
  } catch (_error) {
    throw deliveryEnvelopeConflictError();
  }
  if (expectedIdentity !== persistedIdentity) {
    throw deliveryEnvelopeConflictError();
  }
  const expectedRevision = Number(expected?.messageRevision);
  const persistedRevision = Number(persisted?.messageRevision);
  const expectedBatchSize = Number(expected?.batchSize || 1);
  const persistedBatchSize = Number(persisted?.batchSize || 1);
  const expectedBatchId = normalizeText(expected?.batchId);
  const persistedBatchId = normalizeText(persisted?.batchId);
  const expectedMembers = Array.isArray(expected?.batchMemberHashes)
    ? [...expected.batchMemberHashes].map(normalizeText).sort()
    : [];
  const persistedMembers = Array.isArray(persisted?.batchMemberHashes)
    ? [...persisted.batchMemberHashes].map(normalizeText).sort()
    : [];
  const expectedIsOutbox = typeof expected?.outboxKey === 'string';
  const persistedIsOutbox = typeof persisted?.outboxKey === 'string';
  if (
    expectedIsOutbox !== persistedIsOutbox ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1 ||
    !Number.isSafeInteger(persistedRevision) ||
    persistedRevision < 1
  ) {
    throw deliveryEnvelopeConflictError();
  }
  const persistedIsLegacyBatch = !persistedBatchId && persistedMembers.length === 0;
  if (
    expectedBatchSize !== persistedBatchSize ||
    (expectedBatchSize > 1 && persistedIsLegacyBatch) ||
    (!persistedIsLegacyBatch &&
      (expectedBatchId !== persistedBatchId ||
        JSON.stringify(expectedMembers) !== JSON.stringify(persistedMembers)))
  ) {
    throw deliveryEnvelopeConflictError();
  }
  if (expectedIsOutbox) {
    if (
      normalizeSurface(expected?.surface) !== normalizeSurface(persisted?.surface) ||
      expectedRevision !== persistedRevision
    ) {
      throw deliveryEnvelopeConflictError();
    }
    return persisted;
  }
  const expectedRequiredSurfaces = exactEnvelopeRequiredSurfaces(expected);
  const persistedRequiredSurfaces = exactEnvelopeRequiredSurfaces(persisted);
  if (
    expectedRequiredSurfaces.some((surface) => !persistedRequiredSurfaces.includes(surface)) ||
    (persisted?.persistenceStatus !== 'persisted' && expectedRevision !== persistedRevision)
  ) {
    throw deliveryEnvelopeConflictError();
  }
  return persisted;
}

function recoveryFeelingSnapshot(
  rows: CortexDeliveryLike[] | null | undefined,
): NormalizedCortexFeelingSnapshot | null {
  const normalized = (Array.isArray(rows) ? rows : []).map((row) =>
    normalizeCortexFeelingSnapshot(row?.feelingSnapshot),
  );
  const identities = new Set(normalized.map((snapshot) => feelingSnapshotIdentity(snapshot)));
  if (identities.size > 1) {
    throw codedError(
      'Cortex recovery rows disagree on request-pinned Feelings state',
      'cortex_recovery_feeling_snapshot_conflict',
    );
  }
  return normalized[0] || null;
}

function terminalExpiry(terminalAt: Date): Date {
  return new Date(terminalAt.getTime() + TERMINAL_RETENTION_MS);
}

export function resolveCortexRuntimeSlotIdentity({
  configuredSlot = process.env.VIVENTIUM_RUNTIME_SLOT_ID,
  nodeAppInstance = process.env.NODE_APP_INSTANCE,
  nodeEnv = process.env.NODE_ENV,
  port = process.env.PORT || process.env.VIVENTIUM_LC_API_PORT,
  testWorkerId = process.env.JEST_WORKER_ID,
}: {
  configuredSlot?: unknown;
  nodeAppInstance?: unknown;
  nodeEnv?: unknown;
  port?: unknown;
  testWorkerId?: unknown;
} = {}): string {
  const configured = normalizeText(configuredSlot);
  const instance = normalizeText(nodeAppInstance);
  const environment = normalizeText(nodeEnv).toLowerCase();
  const listenPort = normalizeText(port);
  const worker = normalizeText(testWorkerId);
  let stableSlot = '';
  if (configured) stableSlot = `configured:${configured}`;
  else if (instance) stableSlot = `instance:${instance}`;
  else if (environment === 'development' && listenPort) {
    stableSlot = `development-port:${listenPort}`;
  } else if (environment === 'test' && worker) {
    stableSlot = `test-worker:${worker}`;
  }
  if (!stableSlot) {
    throw codedError(
      'Cortex delivery requires a stable unique runtime slot; set VIVENTIUM_RUNTIME_SLOT_ID or NODE_APP_INSTANCE',
      'cortex_runtime_slot_unconfigured',
    );
  }
  return `slot_${stableHash(stableSlot).slice(0, 24)}`;
}

function normalizeSurface(value: unknown): DeliverySurface {
  const surface = normalizeText(value).toLowerCase();
  return isKnownDeliverySurface(surface) ? surface : 'unknown';
}

export function requiredSurfacesFor(value: unknown): DeliverySurface[] {
  const surface = normalizeSurface(value);
  return surface === 'telegram' ? ['web', 'telegram'] : [surface];
}

function isCompletedInsight(insight: CortexInsightInput | null | undefined): boolean {
  const status = normalizeText(insight?.status).toLowerCase();
  return !status || COMPLETED_STATUSES.has(status);
}

function resolveCortexIdentity(insight: CortexInsightInput | null | undefined): string {
  return normalizeText(
    insight?.cortexId ||
      insight?.cortex_id ||
      insight?.agentId ||
      insight?.agent_id ||
      insight?.cortexName ||
      insight?.cortex_name ||
      'cortex',
  ).slice(0, 256);
}

export function buildCortexInsightDeliveryCandidates({
  ownerId,
  conversationId,
  parentMessageId,
  surface,
  streamId = '',
  messageRevision = 1,
  insights,
}: BuildCortexInsightDeliveryCandidatesInput): CortexDeliveryCandidate[] {
  const userId = normalizeText(ownerId);
  const normalizedConversationId = normalizeText(conversationId);
  const normalizedParentMessageId = normalizeText(parentMessageId);
  const normalizedSurface = normalizeSurface(surface);
  if (!userId || !normalizedConversationId || !normalizedParentMessageId) {
    throw new Error('Cortex insight delivery requires owner, conversation, parent, and surface');
  }

  const candidates: CortexDeliveryCandidate[] = [];
  const seen = new Set<string>();
  for (const insight of Array.isArray(insights) ? insights : []) {
    const exactInsight = exactInsightText(insight?.insight);
    if (!exactInsight || !isCompletedInsight(insight)) {
      continue;
    }
    const cortexId = resolveCortexIdentity(insight);
    const insightHash = stableHash(exactInsight);
    const identityHash = stableHash(
      [userId, normalizedParentMessageId, cortexId, insightHash].join('\u0000'),
    );
    if (seen.has(identityHash)) {
      continue;
    }
    seen.add(identityHash);
    candidates.push({
      deliveryKey: `cortex_insight:${identityHash}`,
      deliveryId: `cidl_${identityHash.slice(0, 24)}`,
      userId,
      conversationId: normalizedConversationId,
      parentMessageId: normalizedParentMessageId,
      cortexId,
      cortexName: normalizeText(insight?.cortexName || insight?.cortex_name).slice(0, 256),
      insightHash,
      graphResultHash: insightHash,
      surface: normalizedSurface,
      requiredSurfaces: requiredSurfacesFor(normalizedSurface),
      streamId: normalizeText(streamId).slice(0, 256),
      sourceRevision: Math.max(1, Number(messageRevision) || 1),
      presentationRevision: 1,
      messageRevision: Math.max(1, Number(messageRevision) || 1),
    });
  }
  const batchMemberHashes = candidates
    .map((candidate) => stableHash(`${candidate.deliveryId}\u0000${candidate.graphResultHash}`))
    .sort();
  const batchId = `cib_${stableHash(
    [
      userId,
      normalizedConversationId,
      normalizedParentMessageId,
      Math.max(1, Number(messageRevision) || 1),
      ...batchMemberHashes,
    ].join('\u0000'),
  )}`;
  const parentAdmissionKey = `cipa_${stableHash(
    [userId, normalizedParentMessageId].join('\u0000'),
  )}`;
  const coordinatorDeliveryKey = candidates.map((candidate) => candidate.deliveryKey).sort()[0];
  for (const candidate of candidates) {
    Object.assign(candidate, {
      batchId,
      batchSize: candidates.length,
      batchMemberHashes,
      ...(candidate.deliveryKey === coordinatorDeliveryKey ? { parentAdmissionKey } : {}),
    });
  }
  return candidates;
}

function findCandidateInsight(
  candidate: CortexDeliveryCandidate,
  insights: CortexInsightInput[] | null | undefined,
): string {
  for (const insight of Array.isArray(insights) ? insights : []) {
    const exactInsight = exactInsightText(insight?.insight);
    if (
      exactInsight &&
      isCompletedInsight(insight) &&
      resolveCortexIdentity(insight) === candidate.cortexId &&
      stableHash(exactInsight) === candidate.insightHash
    ) {
      return exactInsight;
    }
  }
  return '';
}

export function selectClaimedCortexInsights({
  insights,
  claimedDeliveries,
}: {
  insights: CortexInsightInput[] | null | undefined;
  claimedDeliveries: CortexDeliveryLike[] | null | undefined;
}): CortexInsightInput[] {
  const claimedIdentities = new Set(
    (Array.isArray(claimedDeliveries) ? claimedDeliveries : []).map(
      (delivery) =>
        `${normalizeText(delivery?.cortexId)}\u0000${normalizeText(delivery?.insightHash)}`,
    ),
  );
  return (Array.isArray(insights) ? insights : []).filter((insight) => {
    const exactInsight = exactInsightText(insight?.insight);
    if (!exactInsight || !isCompletedInsight(insight)) {
      return false;
    }
    return claimedIdentities.has(
      `${resolveCortexIdentity(insight)}\u0000${stableHash(exactInsight)}`,
    );
  });
}

function selectPrivate<T>(query: CortexQuery<T>): CortexQuery<T>;
function selectPrivate<T>(query: CortexQuery<T> | undefined): CortexQuery<T> | undefined {
  return query?.select
    ? query.select(
        '+insight +events +streamId +feelingSnapshot +acceptanceToken ' +
          '+presentationReceiptHashes +batchLockToken ' +
          '+parentAdmissionKey ' +
          '+batchLockRuntimeSlot +batchLockRuntimeEpoch +batchIntent +lastBatchIntentToken ' +
          '+claimRuntimeSlot +claimRuntimeEpoch +presentationLeaseToken ' +
          '+presentationLeaseOwnerId +presentationLeaseClaimToken +presentationLeaseGeneration ' +
          '+presentationLeaseExpiresAt',
      )
    : query;
}

function leanResult<T>(query: CortexQuery<T>): CortexQuery<T>;
function leanResult<T>(query: CortexQuery<T> | undefined): CortexQuery<T> | undefined {
  return query?.lean ? query.lean() : query;
}

function withSession<T>(query: CortexQuery<T>, session: ClientSession | null): CortexQuery<T>;
function withSession<T>(
  query: CortexQuery<T> | undefined,
  session: ClientSession | null,
): CortexQuery<T> | undefined {
  return session && query?.session ? query.session(session) : query;
}

function privateLeanResult<T>(
  query: CortexQuery<T>,
  session: ClientSession | null = null,
): CortexQuery<T> {
  return leanResult(withSession(selectPrivate(query), session));
}

function batchConflictError(
  message = 'Cortex insight delivery batch transition conflict',
): CodedError {
  return codedError(message, 'cortex_insight_delivery_batch_conflict');
}

function incompleteBatchError(): CodedError {
  return codedError(
    'Cortex insight delivery declared batch membership is incomplete',
    'cortex_insight_delivery_batch_incomplete',
  );
}

function mixedBatchEnvelopeError(): CodedError {
  return codedError(
    'Cortex insight delivery rows do not share one exact batch envelope',
    'cortex_insight_delivery_batch_mixed_envelope',
  );
}

function claimBatchEnvelopeIdentity(row: CortexDeliveryLike): string {
  const sourceRevision = Math.max(1, Number(row?.sourceRevision ?? row?.messageRevision) || 1);
  return JSON.stringify({
    userId: normalizeText(row?.userId),
    conversationId: normalizeText(row?.conversationId),
    parentMessageId: normalizeText(row?.parentMessageId),
    surface: normalizeSurface(row?.surface),
    requiredSurfaces: (Array.isArray(row?.requiredSurfaces) ? row.requiredSurfaces : [])
      .map(normalizeSurface)
      .sort(),
    streamId: normalizeText(row?.streamId),
    sourceRevision,
    batchId: normalizeText(row?.batchId),
    batchSize: Number(row?.batchSize) || 0,
    batchMemberHashes: (Array.isArray(row?.batchMemberHashes) ? row.batchMemberHashes : [])
      .map(normalizeText)
      .sort(),
  });
}

interface ClaimBatchInspection {
  exact: boolean;
  complete: boolean;
}

function inspectClaimBatch(rows: CortexDeliveryLike[] | null | undefined): ClaimBatchInspection {
  const values = (Array.isArray(rows) ? rows : []).filter(Boolean);
  if (values.length === 0) return { exact: true, complete: true };
  const envelopes = new Set(values.map(claimBatchEnvelopeIdentity));
  if (envelopes.size !== 1) return { exact: false, complete: false };
  const first = values[0];
  const batchId = normalizeText(first?.batchId);
  const batchSize = Number(first?.batchSize);
  const declaredMembers = (Array.isArray(first?.batchMemberHashes) ? first.batchMemberHashes : [])
    .map(normalizeText)
    .filter(Boolean)
    .sort();
  const declared = Boolean(batchId) || batchSize > 1 || declaredMembers.length > 0;
  if (!declared) return { exact: true, complete: true };
  const actualMembers = values
    .map((row) => {
      const deliveryId = normalizeText(row?.deliveryId);
      const graphResultHash = normalizeText(row?.graphResultHash);
      return deliveryId && /^[a-f0-9]{64}$/.test(graphResultHash)
        ? stableHash(`${deliveryId}\u0000${graphResultHash}`)
        : '';
    })
    .filter(Boolean)
    .sort();
  const complete =
    Boolean(batchId) &&
    Number.isSafeInteger(batchSize) &&
    batchSize >= 1 &&
    values.length === batchSize &&
    declaredMembers.length === batchSize &&
    new Set(declaredMembers).size === batchSize &&
    actualMembers.length === batchSize &&
    JSON.stringify(actualMembers) === JSON.stringify(declaredMembers);
  return { exact: true, complete };
}

function assertExactCompleteClaimBatch<T extends CortexDeliveryLike>(rows: T[]): T[] {
  const inspection = inspectClaimBatch(rows);
  if (!inspection.exact) throw mixedBatchEnvelopeError();
  if (!inspection.complete) throw incompleteBatchError();
  return rows;
}

function settlementConflictError(
  message = 'Cortex insight delivery transition conflict',
): CodedError {
  return codedError(message, 'cortex_insight_delivery_settlement_conflict');
}

function acceptanceConflictError(
  message = 'Cortex insight delivery acceptance was incomplete',
): CodedError {
  return codedError(message, 'cortex_insight_delivery_acceptance_conflict');
}

export function requireExactCortexInsightDeliverySettlement<
  TExpected extends CortexDeliveryLike,
  TSettled extends CortexDeliveryLike,
>(
  expectedRows: TExpected[] | null | undefined,
  settledRows: TSettled[] | null | undefined,
): TSettled[] {
  const expected = Array.isArray(expectedRows) ? expectedRows : [];
  const settled = Array.isArray(settledRows) ? settledRows : [];
  if (expected.length === 0 || settled.length !== expected.length) {
    throw settlementConflictError('Cortex insight delivery settlement was incomplete');
  }
  const expectedById = new Map<string, number>();
  for (const row of expected) {
    const deliveryId = normalizeText(row?.deliveryId);
    const claimGeneration = Number(row?.claimGeneration);
    if (
      !deliveryId ||
      !Number.isSafeInteger(claimGeneration) ||
      claimGeneration < 1 ||
      expectedById.has(deliveryId)
    ) {
      throw settlementConflictError('Cortex insight delivery settlement fence was invalid');
    }
    expectedById.set(deliveryId, claimGeneration);
  }
  const settledById = new Map<string, number>();
  for (const row of settled) {
    const deliveryId = normalizeText(row?.deliveryId);
    if (!deliveryId || settledById.has(deliveryId)) {
      throw settlementConflictError('Cortex insight delivery settlement was incomplete');
    }
    settledById.set(deliveryId, Number(row?.claimGeneration));
  }
  for (const [deliveryId, claimGeneration] of expectedById) {
    if (settledById.get(deliveryId) !== claimGeneration) {
      throw settlementConflictError('Cortex insight delivery settlement fence did not match');
    }
  }
  return settled;
}

interface CortexInsightDeliveryAcceptanceRow {
  deliveryId?: unknown;
  graphResultHash?: unknown;
}

interface CortexInsightDeliveryAcceptanceReceipt {
  deliveries?: CortexInsightDeliveryAcceptanceRow[] | null;
  batchId?: unknown;
  batchSize?: unknown;
  batchMemberHashes?: unknown[] | null;
}

export function requireExactCortexInsightDeliveryAcceptance<
  TReceipt extends CortexInsightDeliveryAcceptanceReceipt,
>(expectedRows: CortexDeliveryLike[] | null | undefined, receipt: TReceipt): TReceipt {
  const expected = Array.isArray(expectedRows) ? expectedRows : [];
  const accepted = Array.isArray(receipt?.deliveries) ? receipt.deliveries : [];
  if (expected.length === 0 || accepted.length !== expected.length) {
    throw acceptanceConflictError();
  }
  const acceptedById = new Map(
    accepted.map((row) => [normalizeText(row?.deliveryId), normalizeText(row?.graphResultHash)]),
  );
  if (acceptedById.size !== expected.length || acceptedById.has('')) {
    throw acceptanceConflictError();
  }
  for (const row of expected) {
    const deliveryId = normalizeText(row?.deliveryId);
    const graphResultHash = normalizeText(row?.graphResultHash);
    if (!deliveryId || !graphResultHash || acceptedById.get(deliveryId) !== graphResultHash) {
      throw acceptanceConflictError('Cortex insight delivery acceptance did not match');
    }
  }
  if (expected.length > 1) {
    const batchIds = new Set(expected.map((row) => normalizeText(row?.batchId)));
    const expectedMembers = [...new Set(expected.flatMap((row) => row?.batchMemberHashes || []))]
      .map(normalizeText)
      .sort();
    const acceptedMembers = Array.isArray(receipt?.batchMemberHashes)
      ? [...receipt.batchMemberHashes].map(normalizeText).sort()
      : [];
    if (
      batchIds.size !== 1 ||
      batchIds.has('') ||
      normalizeText(receipt?.batchId) !== [...batchIds][0] ||
      Number(receipt?.batchSize) !== expected.length ||
      JSON.stringify(acceptedMembers) !== JSON.stringify(expectedMembers)
    ) {
      throw acceptanceConflictError('Cortex insight delivery batch acceptance did not match');
    }
  }
  return receipt;
}

function isTransactionUnsupported(error: unknown): boolean {
  const code = Number(isDataRecord(error) ? error.code : undefined);
  const message = error instanceof Error ? error.message : '';
  return (
    [20, 263, 40573].includes(code) ||
    /transaction numbers are only allowed|transactions are not supported/i.test(message)
  );
}

async function acquireLocalBatchLock(
  DeliveryModel: CortexDeliveryModel,
  scopeKey: string,
): Promise<() => void> {
  let modelLocks = LOCAL_BATCH_LOCKS.get(DeliveryModel);
  if (!modelLocks) {
    modelLocks = new Map();
    LOCAL_BATCH_LOCKS.set(DeliveryModel, modelLocks);
  }
  const previous = modelLocks.get(scopeKey) || Promise.resolve();
  let releaseGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const queued = previous.then(() => gate);
  modelLocks.set(scopeKey, queued);
  await previous;
  const exactModelLocks = modelLocks;
  return () => {
    releaseGate();
    if (exactModelLocks.get(scopeKey) === queued) {
      exactModelLocks.delete(scopeKey);
    }
  };
}

interface RedactDeliveryOptions {
  includeClaim?: boolean;
  includePresentationLease?: boolean;
}

function redactDelivery(
  row: CortexDeliveryLike,
  options?: RedactDeliveryOptions,
): CortexDeliveryLike;
function redactDelivery(row: null | undefined, options?: RedactDeliveryOptions): null;
function redactDelivery(
  row: CortexDeliveryLike | null | undefined,
  { includeClaim = false, includePresentationLease = false }: RedactDeliveryOptions = {},
): CortexDeliveryLike | null {
  if (!row) {
    return null;
  }
  const source = typeof row.toObject === 'function' ? row.toObject() : row;
  const publicRow: CortexDeliveryLike = { ...source };
  const privateKeys: Array<keyof CortexDeliveryLike> = [
    '_id',
    '__v',
    'deliveryKey',
    'userId',
    'insight',
    'events',
    'expiresAt',
    'claimToken',
    'streamId',
    'feelingSnapshot',
    'acceptanceToken',
    'presentationReceiptHashes',
    'batchLockToken',
    'batchLockExpiresAt',
    'batchLockGeneration',
    'batchIntent',
    'batchLockRuntimeSlot',
    'batchLockRuntimeEpoch',
    'lastBatchIntentToken',
    'claimRuntimeSlot',
    'claimRuntimeEpoch',
    'presentationLeaseToken',
    'presentationLeaseOwnerId',
    'presentationLeaseClaimToken',
    'presentationLeaseGeneration',
    'presentationLeaseExpiresAt',
    'parentAdmissionKey',
  ];
  for (const privateKey of privateKeys) {
    delete publicRow[privateKey];
  }
  if (includeClaim && source.claimToken) {
    publicRow.claimToken = source.claimToken;
  }
  if (includePresentationLease && source.presentationLeaseToken) {
    publicRow.presentationLeaseToken = source.presentationLeaseToken;
    publicRow.presentationLeaseExpiresAt = source.presentationLeaseExpiresAt;
  }
  return publicRow;
}

interface CortexClaimInput {
  deliveryId?: unknown;
  claimToken?: unknown;
  claimGeneration?: unknown;
}

function normalizeClaim(claim: CortexClaimInput | null | undefined): CortexClaim {
  const deliveryId = normalizeText(claim?.deliveryId);
  const claimToken = normalizeText(claim?.claimToken);
  const claimGeneration = Number(claim?.claimGeneration);
  if (!deliveryId || !claimToken || !Number.isInteger(claimGeneration) || claimGeneration < 1) {
    throw new Error('Cortex insight delivery settlement requires an exact claim fence');
  }
  return { deliveryId, claimToken, claimGeneration };
}

function hasLivePresentationLease(
  row: CortexDeliveryLike | null | undefined,
  checkedAt: Date,
): boolean {
  const expiresAt = row?.presentationLeaseExpiresAt
    ? new Date(row.presentationLeaseExpiresAt)
    : null;
  return (
    normalizeText(row?.presentationLeaseToken) !== '' &&
    expiresAt instanceof Date &&
    Number.isFinite(expiresAt.getTime()) &&
    expiresAt.getTime() > checkedAt.getTime()
  );
}

interface CortexEventRecordInput {
  transition: CortexInsightDeliveryEventTransition;
  attemptNumber: number;
  claimToken?: string;
  claimGeneration: number;
  eventAt: Date;
  claimedAt?: Date | null;
  leaseExpiresAt?: Date | null;
  reason?: string;
  receiptHash?: string;
  surface?: string;
  runtimeSlot?: string;
  runtimeEpoch?: string;
  recoveryAttemptNumber?: number;
  retryEligibleAt?: Date | null;
}

function eventRecord({
  transition,
  attemptNumber,
  claimToken = '',
  claimGeneration,
  eventAt,
  claimedAt = null,
  leaseExpiresAt = null,
  reason = '',
  receiptHash = '',
  surface = '',
  runtimeSlot = '',
  runtimeEpoch = '',
  recoveryAttemptNumber = 0,
  retryEligibleAt = null,
}: CortexEventRecordInput): ICortexInsightDeliveryEvent {
  return {
    transition,
    attemptNumber,
    claimToken,
    claimGeneration,
    eventAt,
    claimedAt,
    leaseExpiresAt,
    reason,
    surface,
    receiptHash,
    runtimeSlot,
    runtimeEpoch,
    recoveryAttemptNumber,
    retryEligibleAt,
  };
}

export function createCortexInsightDeliveryService({
  DeliveryModel,
  mongooseInstance = mongoose,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  runtimeSlot = '',
  runtimeEpoch = PROCESS_RUNTIME_EPOCH,
  afterStandaloneMutation = null,
  afterStandaloneRecordWrite = null,
  consumeFault = async () => null,
}: CortexInsightDeliveryServiceOptions) {
  if (!DeliveryModel) throw new Error('cortex_insight_delivery_model_unavailable');
  const normalizedRuntimeSlot = normalizeText(runtimeSlot) || resolveCortexRuntimeSlotIdentity();
  const normalizedRuntimeEpoch = normalizeText(runtimeEpoch) || PROCESS_RUNTIME_EPOCH;

  function recoveryEligibilityFilter(checkedAt: Date): DataRecord {
    return {
      $or: [{ recoveryEligibleAt: null }, { recoveryEligibleAt: { $lte: checkedAt } }],
    };
  }

  function recoverableFilter(checkedAt: Date): DataRecord {
    return {
      $and: [
        {
          $or: [
            { status: 'pending' },
            { status: 'claimed', leaseExpiresAt: { $lte: checkedAt } },
            {
              status: 'claimed',
              claimRuntimeSlot: normalizedRuntimeSlot,
              claimRuntimeEpoch: { $ne: normalizedRuntimeEpoch },
            },
          ],
        },
        recoveryEligibilityFilter(checkedAt),
      ],
    };
  }

  function isRecoveryEligible(
    row: CortexDeliveryLike | null | undefined,
    checkedAt: Date,
  ): boolean {
    if (!row?.recoveryEligibleAt) return true;
    const retryEligibleAt = new Date(row.recoveryEligibleAt);
    return (
      Number.isFinite(retryEligibleAt.getTime()) && retryEligibleAt.getTime() <= checkedAt.getTime()
    );
  }

  function noClaimResult(
    parentRows: CortexDeliveryLike[],
    noClaimReason: string,
  ): CortexNoClaimResult {
    return {
      claimId: '',
      deliveries: parentRows.map((row) => redactDelivery(row)),
      claimed: [],
      insights: [],
      recoveryContext: null,
      noClaimReason,
    };
  }

  function hiddenNoClaimResult(noClaimReason: string): CortexNoClaimResult {
    return {
      claimId: '',
      deliveries: [],
      claimed: [],
      insights: [],
      recoveryContext: null,
      noClaimReason,
    };
  }

  async function readOwnedDelivery(
    userId: unknown,
    deliveryId: unknown,
    session: ClientSession | null = null,
  ): Promise<CortexDeliveryRow | null> {
    return privateLeanResult(DeliveryModel.findOne({ userId, deliveryId }), session);
  }

  async function requireExactParentBatch<T extends CortexDeliveryLike>(
    userId: unknown,
    parentMessageId: unknown,
    rows: T[],
    session: ClientSession | null = null,
  ): Promise<T[] | CortexDeliveryRow[]> {
    if (!DeliveryModel?.db) return rows;
    const query = selectPrivate(
      DeliveryModel.find({
        userId: normalizeText(userId),
        parentMessageId: normalizeText(parentMessageId),
      }),
    );
    const sorted = query?.sort ? query.sort({ createdAt: 1, deliveryId: 1 }) : query;
    const parentRows = (await leanResult(withSession(sorted, session))) || [];
    assertExactCompleteClaimBatch(parentRows);
    const expectedIds = (Array.isArray(rows) ? rows : [])
      .map((row) => normalizeText(row?.deliveryId))
      .sort();
    const parentIds = parentRows.map((row) => normalizeText(row?.deliveryId)).sort();
    if (
      expectedIds.length !== parentIds.length ||
      expectedIds.some((deliveryId, index) => deliveryId !== parentIds[index])
    ) {
      throw mixedBatchEnvelopeError();
    }
    return parentRows;
  }

  async function initializeLegacySourceRevision(
    row: CortexDeliveryRow | null,
    session: ClientSession | null = null,
  ): Promise<CortexDeliveryRow | null> {
    if (!row) return row;
    const existingSourceRevision = row.sourceRevision;
    if (Number.isSafeInteger(existingSourceRevision) && Number(existingSourceRevision) >= 1) {
      return row;
    }
    if (row?.messageRevision == null) return { ...row, sourceRevision: 1 };
    const sourceRevision = Math.max(1, Number(row?.messageRevision) || 1);
    if (typeof DeliveryModel?.collection?.findOneAndUpdate !== 'function') {
      return { ...row, sourceRevision };
    }
    const filter = {
      deliveryId: row.deliveryId,
      userId: row.userId,
      sourceRevision: { $exists: false },
      messageRevision: sourceRevision,
    };
    const initialized = await DeliveryModel.collection.findOneAndUpdate(
      filter,
      { $set: { sourceRevision } },
      { returnDocument: 'after', ...(session ? { session } : {}) },
    );
    return (
      unwrapCollectionResult(initialized) ||
      (await readOwnedDelivery(row.userId, row.deliveryId, session))
    );
  }

  async function updateRevisionProjection(
    filter: DataRecord,
    update: DataRecord,
    session: ClientSession | null = null,
  ): Promise<CortexDeliveryRow | null> {
    if (typeof DeliveryModel?.collection?.findOneAndUpdate === 'function') {
      const result = await DeliveryModel.collection.findOneAndUpdate(filter, update, {
        returnDocument: 'after',
        ...(session ? { session } : {}),
      });
      return unwrapCollectionResult(result);
    }
    return privateLeanResult(
      DeliveryModel.findOneAndUpdate(filter, update, { new: true, runValidators: true }),
      session,
    );
  }

  async function readClaimRows(
    userId: unknown,
    claims: CortexClaim[],
    session: ClientSession | null = null,
  ): Promise<CortexDeliveryRow[]> {
    const rows = await Promise.all(
      claims.map((claim) => readOwnedDelivery(userId, claim.deliveryId, session)),
    );
    if (rows.some((row) => !row)) {
      throw batchConflictError();
    }
    const exactRows = rows.filter((row): row is CortexDeliveryRow => row !== null);
    const parentIds = new Set(
      exactRows.map((row) =>
        normalizeText(row.parentMessageId || (!DeliveryModel?.db ? row.deliveryId : '')),
      ),
    );
    if (parentIds.size !== 1 || parentIds.has('')) {
      throw batchConflictError('Cortex insight delivery claims must share one parent batch');
    }
    assertExactCompleteClaimBatch(exactRows);
    await requireExactParentBatch(userId, [...parentIds][0], exactRows, session);
    return exactRows;
  }

  function assertExactClaimSettlement<T extends CortexDeliveryLike>(
    claims: CortexClaimInput[] | null | undefined,
    settled: T[],
  ): T[] {
    return requireExactCortexInsightDeliverySettlement(
      (Array.isArray(claims) ? claims : []).map(normalizeClaim),
      settled,
    );
  }

  async function runMongoTransaction<T>(
    work: (session: ClientSession) => Promise<T>,
  ): Promise<{ used: true; result: T } | { used: false; result: null }> {
    const transactionMongoose: TransactionMongoose = DeliveryModel?.db?.base || mongooseInstance;
    const inheritedSession =
      transactionMongoose.transactionAsyncLocalStorage?.getStore?.()?.session;
    if (inheritedSession?.inTransaction()) {
      return { used: true, result: await work(inheritedSession) };
    }
    const startSession = DeliveryModel?.db?.startSession;
    if (typeof startSession !== 'function' || TRANSACTION_SUPPORT.get(DeliveryModel) === false) {
      return { used: false, result: null };
    }
    const session = await startSession.call(DeliveryModel.db);
    if (!session || typeof session.withTransaction !== 'function') {
      await session?.endSession?.();
      TRANSACTION_SUPPORT.set(DeliveryModel, false);
      return { used: false, result: null };
    }
    try {
      const results: T[] = [];
      await session.withTransaction(async () => {
        results.push(await work(session));
      });
      TRANSACTION_SUPPORT.set(DeliveryModel, true);
      return { used: true, result: results[0] };
    } catch (error) {
      if (isTransactionUnsupported(error)) {
        TRANSACTION_SUPPORT.set(DeliveryModel, false);
        return { used: false, result: null };
      }
      throw error;
    } finally {
      await session.endSession?.();
    }
  }

  async function acquireDatabaseBatchLock({
    rows,
    ownerId,
    parentMessageId,
  }: {
    rows: CortexDeliveryLike[];
    ownerId: unknown;
    parentMessageId: unknown;
  }): Promise<DatabaseBatchLock> {
    const lockAt = now();
    const lockToken = `cidl_lock_${randomUUID()}`;
    const lockExpiresAt = new Date(lockAt.getTime() + DEFAULT_BATCH_LOCK_MS);
    const coordinator = [...rows].sort((left, right) =>
      String(left.deliveryId).localeCompare(String(right.deliveryId)),
    )[0];
    if (!coordinator) throw batchConflictError();
    const existingLockToken = normalizeText(coordinator.batchLockToken);
    const existingLockExpiry = coordinator.batchLockExpiresAt
      ? new Date(coordinator.batchLockExpiresAt)
      : null;
    const sameRuntimeSlot =
      normalizeText(coordinator.batchLockRuntimeSlot) === normalizedRuntimeSlot;
    const priorRuntimeEpoch =
      sameRuntimeSlot &&
      normalizeText(coordinator.batchLockRuntimeEpoch) &&
      normalizeText(coordinator.batchLockRuntimeEpoch) !== normalizedRuntimeEpoch;
    if (
      existingLockToken &&
      existingLockExpiry instanceof Date &&
      existingLockExpiry.getTime() > lockAt.getTime() &&
      !priorRuntimeEpoch
    ) {
      throw batchConflictError();
    }
    const filter: DataRecord = {
      deliveryId: coordinator.deliveryId,
      userId: normalizeText(ownerId),
      parentMessageId: normalizeText(parentMessageId),
      claimGeneration: Number(coordinator.claimGeneration) || 0,
      batchLockGeneration: Number(coordinator.batchLockGeneration) || 0,
    };
    if (existingLockToken) {
      filter.batchLockToken = existingLockToken;
      filter.batchLockExpiresAt = coordinator.batchLockExpiresAt;
    } else {
      filter.batchLockToken = { $in: ['', null] };
    }
    const locked = await privateLeanResult(
      DeliveryModel.findOneAndUpdate(
        filter,
        {
          $set: {
            batchLockToken: lockToken,
            batchLockRuntimeSlot: normalizedRuntimeSlot,
            batchLockRuntimeEpoch: normalizedRuntimeEpoch,
            batchLockExpiresAt: lockExpiresAt,
          },
          $inc: { batchLockGeneration: 1 },
        },
        { new: true, runValidators: true },
      ),
    );
    if (!locked) throw batchConflictError();
    const coordinatorId = normalizeText(coordinator.deliveryId);
    if (!coordinatorId) throw batchConflictError();
    return { coordinatorId, lockToken };
  }

  async function releaseDatabaseBatchLock({
    ownerId,
    lock,
  }: {
    ownerId: unknown;
    lock: DatabaseBatchLock;
  }): Promise<void> {
    const released = await privateLeanResult(
      DeliveryModel.findOneAndUpdate(
        {
          deliveryId: lock.coordinatorId,
          userId: normalizeText(ownerId),
          batchLockToken: lock.lockToken,
        },
        {
          $set: {
            batchLockToken: '',
            batchLockRuntimeSlot: '',
            batchLockRuntimeEpoch: '',
            batchLockExpiresAt: null,
          },
        },
        { new: true, runValidators: true },
      ),
    );
    if (!released) {
      throw batchConflictError('Cortex insight delivery batch lock release conflict');
    }
  }

  function coordinatorFor<T extends CortexDeliveryLike>(rows: T[]): T | undefined {
    return [...rows].sort((left, right) =>
      String(left.deliveryId).localeCompare(String(right.deliveryId)),
    )[0];
  }

  async function prepareBatchIntent({
    ownerId,
    parentMessageId,
    rows,
    lock,
    descriptor,
  }: {
    ownerId: unknown;
    parentMessageId: unknown;
    rows: CortexDeliveryLike[];
    lock: DatabaseBatchLock;
    descriptor: BatchDescriptor;
  }): Promise<BatchIntent> {
    const coordinator = coordinatorFor(rows);
    if (!coordinator || !descriptor?.type) throw batchConflictError();
    const intent: BatchIntent = {
      token: `cidl_intent_${randomUUID()}`,
      phase: 'prepared',
      runtimeSlot: normalizedRuntimeSlot,
      runtimeEpoch: normalizedRuntimeEpoch,
      operation: descriptor.type,
      createdAt: now(),
      descriptor,
    };
    const prepared = await privateLeanResult(
      DeliveryModel.findOneAndUpdate(
        {
          deliveryId: coordinator.deliveryId,
          userId: normalizeText(ownerId),
          parentMessageId: normalizeText(parentMessageId),
          batchLockToken: lock.lockToken,
          batchIntent: null,
        },
        { $set: { batchIntent: intent } },
        { new: true, runValidators: true },
      ),
    );
    if (!prepared) throw batchConflictError('Cortex insight delivery batch intent conflict');
    return intent;
  }

  async function markBatchIntentCommitted({
    ownerId,
    coordinatorId,
    intentToken,
    lockToken = '',
  }: {
    ownerId: unknown;
    coordinatorId: unknown;
    intentToken: unknown;
    lockToken?: unknown;
  }): Promise<void> {
    const filter: DataRecord = {
      deliveryId: coordinatorId,
      userId: normalizeText(ownerId),
      'batchIntent.token': intentToken,
      'batchIntent.phase': { $in: ['prepared', 'repairing'] },
    };
    if (normalizeText(lockToken)) filter.batchLockToken = normalizeText(lockToken);
    const committed = await privateLeanResult(
      DeliveryModel.findOneAndUpdate(
        filter,
        {
          $set: {
            'batchIntent.phase': 'committed',
            'batchIntent.committedAt': now(),
          },
        },
        { new: true, runValidators: true },
      ),
    );
    if (!committed) throw batchConflictError('Cortex insight delivery batch commit conflict');
  }

  async function clearBatchIntent({
    ownerId,
    coordinatorId,
    intentToken,
    clearLock = false,
    lockToken = '',
  }: {
    ownerId: unknown;
    coordinatorId: unknown;
    intentToken: unknown;
    clearLock?: boolean;
    lockToken?: unknown;
  }): Promise<void> {
    const projection: DataRecord = { batchIntent: null };
    if (clearLock) {
      Object.assign(projection, {
        batchLockToken: '',
        batchLockRuntimeSlot: '',
        batchLockRuntimeEpoch: '',
        batchLockExpiresAt: null,
      });
    }
    const filter: DataRecord = {
      deliveryId: coordinatorId,
      userId: normalizeText(ownerId),
      'batchIntent.token': intentToken,
    };
    if (normalizeText(lockToken)) filter.batchLockToken = normalizeText(lockToken);
    const cleared = await privateLeanResult(
      DeliveryModel.findOneAndUpdate(
        filter,
        { $set: projection },
        { new: true, runValidators: true },
      ),
    );
    if (!cleared) throw batchConflictError('Cortex insight delivery batch intent cleanup conflict');
  }

  async function runStandaloneMutationHook(
    intent: BatchIntent,
    row: CortexDeliveryLike,
    mutationIndex: number,
  ): Promise<void> {
    if (typeof afterStandaloneMutation !== 'function') return;
    const deliveryId = normalizeText(row.deliveryId);
    if (!deliveryId) throw batchConflictError('Cortex batch mutation lost its delivery identity');
    await afterStandaloneMutation({
      operation: intent.operation,
      deliveryId,
      mutationIndex,
    });
  }

  async function abandonSameBootClaimIntent({
    ownerId,
    row,
    descriptor,
    intentToken,
  }: {
    ownerId: unknown;
    row: CortexDeliveryRow;
    descriptor: BatchDescriptor;
    intentToken: string;
  }): Promise<CortexDeliveryRow> {
    if (
      normalizeText(row?.lastBatchIntentToken) === intentToken &&
      row?.status === 'pending' &&
      !normalizeText(row?.claimToken)
    ) {
      return row;
    }
    const claimToken = normalizeText(descriptor.claimToken);
    const exactIntentClaim =
      normalizeText(row?.lastBatchIntentToken) === intentToken &&
      row?.status === 'claimed' &&
      normalizeText(row?.claimToken) === claimToken &&
      normalizeText(row?.claimRuntimeSlot) === normalizeText(descriptor.runtimeSlot) &&
      normalizeText(row?.claimRuntimeEpoch) === normalizeText(descriptor.runtimeEpoch);
    if (!exactIntentClaim) throw batchConflictError();
    const releasedAt = now();
    const released = await privateLeanResult(
      DeliveryModel.findOneAndUpdate(
        {
          deliveryId: row.deliveryId,
          userId: normalizeText(ownerId),
          status: 'claimed',
          claimToken,
          claimGeneration: Number(row.claimGeneration) || 0,
          lastBatchIntentToken: intentToken,
        },
        {
          $set: {
            status: 'pending',
            claimToken: '',
            claimRuntimeSlot: '',
            claimRuntimeEpoch: '',
            claimedAt: null,
            leaseExpiresAt: null,
            expiresAt: null,
            presentationLeaseToken: '',
            presentationLeaseOwnerId: '',
            presentationLeaseClaimToken: '',
            presentationLeaseGeneration: 0,
            presentationLeaseExpiresAt: null,
          },
          $push: {
            events: eventRecord({
              transition: 'failure',
              attemptNumber: Number(row.attemptNumber) || 0,
              claimToken,
              claimGeneration: Number(row.claimGeneration) || 0,
              eventAt: releasedAt,
              claimedAt: row.claimedAt,
              leaseExpiresAt: row.leaseExpiresAt,
              reason: 'batch_transition_conflict',
              runtimeSlot: row.claimRuntimeSlot,
              runtimeEpoch: row.claimRuntimeEpoch,
            }),
          },
        },
        { new: true, runValidators: true },
      ),
    );
    if (!released) throw batchConflictError('Cortex same-boot claim release conflict');
    return released;
  }

  async function executeBatchIntent(
    intent: BatchIntent,
    { allowExpiredLease = false, releaseSameBootClaim = false }: ExecuteBatchIntentOptions = {},
  ): Promise<CortexDeliveryLike[]> {
    const descriptor = intent?.descriptor || {};
    const ownerId = normalizeText(descriptor.ownerId);
    const intentToken = normalizeText(intent?.token);
    const results: CortexDeliveryLike[] = [];
    let mutationIndex = 0;
    if (!ownerId || !intentToken) throw batchConflictError('Invalid cortex batch intent');

    if (descriptor.type === 'claim') {
      for (const deliveryId of descriptor.deliveryIds || []) {
        let current = await readOwnedDelivery(ownerId, deliveryId);
        if (!current) throw batchConflictError();
        if (normalizeText(current.lastBatchIntentToken) !== intentToken) {
          const claimed = await claimOne(current, {
            surface: descriptor.surface,
            leaseMs: descriptor.leaseMs,
            batchClaimToken: descriptor.claimToken,
            batchClaimedAt: requiredDate(descriptor.claimedAt, 'claimedAt'),
            incrementAttempt: descriptor.incrementAttempt !== false,
            intentToken,
            claimRuntimeSlot: descriptor.runtimeSlot,
            claimRuntimeEpoch: descriptor.runtimeEpoch,
          });
          if (!claimed) throw batchConflictError();
          current = claimed;
          mutationIndex += 1;
          await runStandaloneMutationHook(intent, claimed, mutationIndex);
        }
        if (!releaseSameBootClaim) {
          results.push(current);
          continue;
        }
        const released = await abandonSameBootClaimIntent({
          ownerId,
          row: current,
          descriptor,
          intentToken,
        });
        results.push(released);
        mutationIndex += 1;
        await runStandaloneMutationHook(intent, released, mutationIndex);
      }
      return results;
    }

    const claims = (descriptor.claims || []).map(normalizeClaim);
    if (descriptor.type === 'settle') {
      if (!descriptor.transition || !descriptor.projection) {
        throw batchConflictError('Cortex settle intent is incomplete');
      }
      for (const claim of claims) {
        const current = await readOwnedDelivery(ownerId, claim.deliveryId);
        if (current && normalizeText(current.lastBatchIntentToken) === intentToken) {
          results.push(redactDelivery(current));
          continue;
        }
        const settled = await settleOne({
          ownerId,
          claim,
          transition: descriptor.transition,
          projection: descriptor.projection,
          reason: descriptor.reason,
          receiptHash: descriptor.receiptHash,
          intentToken,
          allowExpiredLease,
        });
        if (!settled) throw batchConflictError();
        results.push(settled);
        mutationIndex += 1;
        await runStandaloneMutationHook(intent, settled, mutationIndex);
      }
      return results;
    }

    if (descriptor.type === 'present') {
      for (const claim of claims) {
        const current = await readOwnedDelivery(ownerId, claim.deliveryId);
        if (current && normalizeText(current.lastBatchIntentToken) === intentToken) {
          results.push(redactDelivery(current));
          continue;
        }
        const presented = await markPresentedOne({
          ownerId,
          claim,
          ...requiredPresentationFence(descriptor.receipt),
          intentToken,
          allowExpiredLease,
        });
        if (!presented) throw batchConflictError();
        results.push(presented);
        mutationIndex += 1;
        await runStandaloneMutationHook(intent, presented, mutationIndex);
      }
      return results;
    }

    if (descriptor.type === 'finalize') {
      for (const claim of claims) {
        const current = await readOwnedDelivery(ownerId, claim.deliveryId);
        if (current && normalizeText(current.lastBatchIntentToken) === intentToken) {
          results.push(redactDelivery(current));
          continue;
        }
        const finalized = await finalizePresentedOne({
          ownerId,
          claim,
          intentToken,
          allowExpiredLease,
        });
        if (!finalized) throw batchConflictError();
        results.push(finalized);
        mutationIndex += 1;
        await runStandaloneMutationHook(intent, finalized, mutationIndex);
      }
      return results;
    }

    if (descriptor.type === 'renew') {
      if (descriptor.presentation) {
        const currentRows = await readClaimRows(ownerId, claims);
        assertPresentationFenceRows(
          currentRows,
          claims,
          descriptor.presentation,
          requiredDate(descriptor.renewedAt, 'renewedAt'),
        );
      }
      for (const claim of claims) {
        const current = await readOwnedDelivery(ownerId, claim.deliveryId);
        if (current && normalizeText(current.lastBatchIntentToken) === intentToken) {
          results.push(
            redactDelivery(current, {
              includeClaim: true,
              includePresentationLease: Boolean(descriptor.presentation),
            }),
          );
          continue;
        }
        const renewed = await renewOne({
          ownerId,
          claim,
          renewedAt: requiredDate(descriptor.renewedAt, 'renewedAt'),
          leaseExpiresAt: requiredDate(descriptor.leaseExpiresAt, 'leaseExpiresAt'),
          presentationLease: descriptor.presentation || null,
          intentToken,
          allowExpiredLease,
        });
        if (!renewed) throw batchConflictError();
        results.push(renewed);
        mutationIndex += 1;
        await runStandaloneMutationHook(intent, renewed, mutationIndex);
      }
      return results;
    }

    throw batchConflictError('Unsupported cortex batch intent operation');
  }

  async function repairIncompleteBatches({
    ownerId = '',
    parentMessageId = '',
    limit = 100,
  }: RepairIncompleteBatchesInput = {}): Promise<RepairIncompleteBatchesResult> {
    if (!DeliveryModel?.db) return { scanned: 0, repaired: 0, deferred: 0, failed: 0 };
    const filter: DataRecord = { batchIntent: { $ne: null } };
    if (normalizeText(ownerId)) filter.userId = normalizeText(ownerId);
    if (normalizeText(parentMessageId)) filter.parentMessageId = normalizeText(parentMessageId);
    const query = selectPrivate(DeliveryModel.find(filter));
    const limited = query?.limit
      ? query.limit(Math.max(1, Math.min(Number(limit) || 100, 500)))
      : query;
    const coordinators = (await leanResult(limited)) || [];
    const summary = { scanned: coordinators.length, repaired: 0, deferred: 0, failed: 0 };
    for (const coordinator of coordinators) {
      const intent = coordinator.batchIntent;
      if (!intent?.token) continue;
      if (intent.phase === 'committed') {
        try {
          await clearBatchIntent({
            ownerId: coordinator.userId,
            coordinatorId: coordinator.deliveryId,
            intentToken: intent.token,
            clearLock: true,
          });
          summary.repaired += 1;
        } catch (_error) {
          summary.failed += 1;
        }
        continue;
      }
      const sameSlot = normalizeText(intent.runtimeSlot) === normalizedRuntimeSlot;
      const sameEpoch = normalizeText(intent.runtimeEpoch) === normalizedRuntimeEpoch;
      const lockExpiresAt = coordinator.batchLockExpiresAt
        ? new Date(coordinator.batchLockExpiresAt)
        : null;
      const lockIsLive = lockExpiresAt instanceof Date && lockExpiresAt.getTime() > now().getTime();
      const sameLiveRuntime = sameSlot && sameEpoch && lockIsLive;
      const otherLiveSlot = !sameSlot && lockIsLive;
      if (sameLiveRuntime || otherLiveSlot) {
        summary.deferred += 1;
        continue;
      }
      try {
        const repairLock = await acquireDatabaseBatchLock({
          rows: [coordinator],
          ownerId: coordinator.userId,
          parentMessageId: coordinator.parentMessageId,
        });
        const repairing = await privateLeanResult(
          DeliveryModel.findOneAndUpdate(
            {
              deliveryId: coordinator.deliveryId,
              userId: coordinator.userId,
              batchLockToken: repairLock.lockToken,
              'batchIntent.token': intent.token,
              'batchIntent.phase': { $in: ['prepared', 'repairing'] },
            },
            {
              $set: {
                'batchIntent.phase': 'repairing',
                'batchIntent.repairRuntimeSlot': normalizedRuntimeSlot,
                'batchIntent.repairRuntimeEpoch': normalizedRuntimeEpoch,
              },
            },
            { new: true, runValidators: true },
          ),
        );
        if (!repairing) throw batchConflictError();
        if (!repairing.batchIntent) throw batchConflictError();
        await executeBatchIntent(repairing.batchIntent, {
          allowExpiredLease: true,
          releaseSameBootClaim: sameSlot && sameEpoch && intent.operation === 'claim',
        });
        await markBatchIntentCommitted({
          ownerId: coordinator.userId,
          coordinatorId: coordinator.deliveryId,
          intentToken: intent.token,
          lockToken: repairLock.lockToken,
        });
        await clearBatchIntent({
          ownerId: coordinator.userId,
          coordinatorId: coordinator.deliveryId,
          intentToken: intent.token,
          clearLock: true,
          lockToken: repairLock.lockToken,
        });
        summary.repaired += 1;
      } catch (error) {
        if (errorCode(error) === 'cortex_insight_delivery_batch_conflict') {
          summary.deferred += 1;
        } else {
          summary.failed += 1;
        }
      }
    }
    return summary;
  }

  async function runAtomicParentBatch({
    ownerId,
    parentMessageId,
    rows,
    descriptor,
    work,
  }: {
    ownerId: unknown;
    parentMessageId: unknown;
    rows: CortexDeliveryLike[];
    descriptor: BatchDescriptor;
    work: (context: AtomicBatchWorkContext) => Promise<CortexDeliveryLike[]>;
  }): Promise<CortexDeliveryLike[]> {
    const transaction = await runMongoTransaction((session) =>
      work({ session, compensate: false }),
    );
    if (transaction.used) return transaction.result;

    const scopeKey = `${normalizeText(ownerId)}\u0000${normalizeText(parentMessageId)}`;
    if (!DeliveryModel?.db) {
      const release = await acquireLocalBatchLock(DeliveryModel, scopeKey);
      try {
        return await work({ session: null, compensate: true });
      } finally {
        release();
      }
    }

    await repairIncompleteBatches({ ownerId, parentMessageId, limit: 1 });
    const currentRows = await Promise.all(
      rows.map((row) => readOwnedDelivery(normalizeText(ownerId), row.deliveryId)),
    );
    const exactCurrentRows = currentRows.filter((row): row is CortexDeliveryRow => row !== null);
    if (exactCurrentRows.length !== rows.length) throw batchConflictError();
    const lock = await acquireDatabaseBatchLock({
      rows: exactCurrentRows,
      ownerId,
      parentMessageId,
    });
    if (
      descriptor?.type === 'claim' &&
      exactCurrentRows.some(
        (row) =>
          !isClaimable(row, requiredDate(descriptor.claimedAt, 'claimedAt'), {
            terminalSettlement: descriptor.incrementAttempt === false,
          }),
      )
    ) {
      await releaseDatabaseBatchLock({ ownerId, lock });
      throw batchConflictError();
    }
    const coordinator = coordinatorFor(exactCurrentRows);
    if (!coordinator) throw batchConflictError();
    const intent = await prepareBatchIntent({
      ownerId,
      parentMessageId,
      rows: exactCurrentRows,
      lock,
      descriptor,
    });
    try {
      const result = await executeBatchIntent(intent);
      await markBatchIntentCommitted({
        ownerId,
        coordinatorId: coordinator.deliveryId,
        intentToken: intent.token,
        lockToken: lock.lockToken,
      });
      await clearBatchIntent({
        ownerId,
        coordinatorId: coordinator.deliveryId,
        intentToken: intent.token,
        lockToken: lock.lockToken,
      });
      await releaseDatabaseBatchLock({ ownerId, lock });
      return result;
    } catch (error) {
      if (errorCode(error) === 'cortex_test_process_interrupted') throw error;
      try {
        const result = await executeBatchIntent(intent);
        await markBatchIntentCommitted({
          ownerId,
          coordinatorId: coordinator.deliveryId,
          intentToken: intent.token,
          lockToken: lock.lockToken,
        });
        await clearBatchIntent({
          ownerId,
          coordinatorId: coordinator.deliveryId,
          intentToken: intent.token,
          lockToken: lock.lockToken,
        });
        await releaseDatabaseBatchLock({ ownerId, lock });
        return result;
      } catch (_retryError) {
        throw error;
      }
    }
  }

  async function claimOne(
    inputRow: CortexDeliveryRow | null,
    {
      leaseMs = DEFAULT_LEASE_MS,
      batchClaimToken = '',
      batchClaimedAt = null,
      incrementAttempt = true,
      intentToken = '',
      claimRuntimeSlot = normalizedRuntimeSlot,
      claimRuntimeEpoch = normalizedRuntimeEpoch,
      session = null,
    }: ClaimOneOptions = {},
  ): Promise<CortexDeliveryRow | null> {
    let row = inputRow;
    if (!row || TERMINAL_STATUSES.has(row.status)) {
      return null;
    }
    row = await initializeLegacySourceRevision(row, session);
    if (!row || TERMINAL_STATUSES.has(row.status)) return null;
    const claimedAt = batchClaimedAt || now();
    if (!isRecoveryEligible(row, claimedAt)) {
      return null;
    }
    const priorLeaseExpiresAt = row.leaseExpiresAt ? new Date(row.leaseExpiresAt) : null;
    if (hasLivePresentationLease(row, claimedAt)) {
      return null;
    }
    const isExpiredClaim =
      row.status === 'claimed' &&
      priorLeaseExpiresAt instanceof Date &&
      priorLeaseExpiresAt.getTime() <= claimedAt.getTime();
    const isPriorRuntimeClaim =
      row.status === 'claimed' &&
      normalizeText(row.claimRuntimeSlot) === normalizedRuntimeSlot &&
      normalizeText(row.claimRuntimeEpoch) &&
      normalizeText(row.claimRuntimeEpoch) !== normalizedRuntimeEpoch;
    if (row.status !== 'pending' && !isExpiredClaim && !isPriorRuntimeClaim) {
      return null;
    }

    const priorAttemptNumber = Number(row.attemptNumber) || 0;
    const priorGeneration = Number(row.claimGeneration) || 0;
    const attemptNumber = priorAttemptNumber + (incrementAttempt ? 1 : 0);
    const claimGeneration = priorGeneration + 1;
    const claimToken = batchClaimToken || `cidl_${randomUUID()}`;
    const leaseExpiresAt = new Date(
      claimedAt.getTime() + Math.max(1000, Number(leaseMs) || DEFAULT_LEASE_MS),
    );
    const recoveryFilters: DataRecord[] = [recoveryEligibilityFilter(claimedAt)];
    const filter: DataRecord = {
      deliveryId: row.deliveryId,
      userId: row.userId,
      status: row.status,
      claimGeneration: priorGeneration,
      $and: recoveryFilters,
    };
    const events: ICortexInsightDeliveryEvent[] = [];
    if (isExpiredClaim || isPriorRuntimeClaim) {
      filter.claimToken = row.claimToken;
      filter.leaseExpiresAt = row.leaseExpiresAt;
      recoveryFilters.push({
        $or: [
          { presentationLeaseToken: { $in: ['', null] } },
          { presentationLeaseExpiresAt: null },
          { presentationLeaseExpiresAt: { $exists: false } },
          { presentationLeaseExpiresAt: { $lte: claimedAt } },
        ],
      });
      events.push(
        eventRecord({
          transition: 'failure',
          attemptNumber: priorAttemptNumber,
          claimToken: row.claimToken,
          claimGeneration: priorGeneration,
          eventAt: claimedAt,
          claimedAt: row.claimedAt,
          leaseExpiresAt: row.leaseExpiresAt,
          reason: isPriorRuntimeClaim ? 'delivery_runtime_restarted' : 'delivery_lease_expired',
          runtimeSlot: row.claimRuntimeSlot,
          runtimeEpoch: row.claimRuntimeEpoch,
        }),
      );
    }
    events.push(
      eventRecord({
        transition: 'claimed',
        attemptNumber,
        claimToken,
        claimGeneration,
        eventAt: claimedAt,
        claimedAt,
        leaseExpiresAt,
        runtimeSlot: normalizeText(claimRuntimeSlot),
        runtimeEpoch: normalizeText(claimRuntimeEpoch),
      }),
    );

    return privateLeanResult(
      DeliveryModel.findOneAndUpdate(
        filter,
        {
          $set: {
            status: 'claimed',
            attemptNumber,
            claimGeneration,
            claimToken,
            claimRuntimeSlot: normalizeText(claimRuntimeSlot),
            claimRuntimeEpoch: normalizeText(claimRuntimeEpoch),
            claimedAt,
            leaseExpiresAt,
            recoveryAttemptNumber: 0,
            recoveryEligibleAt: null,
            expiresAt: null,
            presentationLeaseToken: '',
            presentationLeaseOwnerId: '',
            presentationLeaseClaimToken: '',
            presentationLeaseGeneration: 0,
            presentationLeaseExpiresAt: null,
            dropReason: '',
            droppedAt: null,
            ...(intentToken ? { lastBatchIntentToken: intentToken } : {}),
          },
          $push: { events: { $each: events } },
        },
        { new: true, runValidators: true, ...(session ? { session } : {}) },
      ),
      session,
    );
  }

  function isClaimable(
    row: CortexDeliveryLike | null | undefined,
    claimedAt: Date,
    { terminalSettlement = false }: { terminalSettlement?: boolean } = {},
  ): boolean {
    if (!row || isTerminalStatus(row.status)) return false;
    if (!isRecoveryEligible(row, claimedAt)) return false;
    if (hasLivePresentationLease(row, claimedAt)) return false;
    if (row.status === 'pending') {
      return !terminalSettlement || Number(row.attemptNumber) > 0;
    }
    if (terminalSettlement) return false;
    const isPriorRuntimeClaim =
      row.status === 'claimed' &&
      normalizeText(row.claimRuntimeSlot) === normalizedRuntimeSlot &&
      normalizeText(row.claimRuntimeEpoch) &&
      normalizeText(row.claimRuntimeEpoch) !== normalizedRuntimeEpoch;
    if (isPriorRuntimeClaim) return true;
    const leaseExpiresAt = row.leaseExpiresAt ? new Date(row.leaseExpiresAt) : null;
    return (
      row.status === 'claimed' &&
      leaseExpiresAt instanceof Date &&
      leaseExpiresAt.getTime() <= claimedAt.getTime()
    );
  }

  async function releasePartialClaims({
    ownerId,
    claimedRows,
    releasedAt,
  }: {
    ownerId: unknown;
    claimedRows: CortexDeliveryRow[];
    releasedAt: Date;
  }): Promise<void> {
    for (const row of claimedRows) {
      const released = await privateLeanResult(
        DeliveryModel.findOneAndUpdate(
          {
            deliveryId: row.deliveryId,
            userId: normalizeText(ownerId),
            status: 'claimed',
            claimToken: row.claimToken,
            claimGeneration: row.claimGeneration,
          },
          {
            $set: {
              status: 'pending',
              claimToken: '',
              claimRuntimeSlot: '',
              claimRuntimeEpoch: '',
              claimedAt: null,
              leaseExpiresAt: null,
              expiresAt: null,
              presentationLeaseToken: '',
              presentationLeaseOwnerId: '',
              presentationLeaseClaimToken: '',
              presentationLeaseGeneration: 0,
              presentationLeaseExpiresAt: null,
            },
            $push: {
              events: eventRecord({
                transition: 'failure',
                attemptNumber: row.attemptNumber,
                claimToken: row.claimToken,
                claimGeneration: row.claimGeneration,
                eventAt: releasedAt,
                claimedAt: row.claimedAt,
                leaseExpiresAt: row.leaseExpiresAt,
                reason: 'batch_transition_conflict',
              }),
            },
          },
          { new: true, runValidators: true },
        ),
      );
      if (!released) {
        throw batchConflictError('Cortex insight delivery partial claim compensation failed');
      }
    }
  }

  async function claimRowsAtomically({
    ownerId,
    parentMessageId,
    rows,
    surface,
    leaseMs,
    terminalSettlement = false,
  }: ClaimRowsAtomicallyInput): Promise<CortexDeliveryLike[]> {
    if (rows.length === 0) return [];
    assertExactCompleteClaimBatch(rows);
    await requireExactParentBatch(ownerId, parentMessageId, rows);
    const claimedAt = now();
    const batchClaimToken = `cidl_${randomUUID()}`;
    return runAtomicParentBatch({
      ownerId,
      parentMessageId,
      rows,
      descriptor: {
        type: 'claim',
        ownerId: normalizeText(ownerId),
        deliveryIds: rows.map((row) => row.deliveryId),
        surface: normalizeSurface(surface),
        leaseMs,
        claimToken: batchClaimToken,
        claimedAt,
        incrementAttempt: !terminalSettlement,
        runtimeSlot: normalizedRuntimeSlot,
        runtimeEpoch: normalizedRuntimeEpoch,
      },
      work: async ({ session, compensate }) => {
        const currentRows = await Promise.all(
          rows.map(async (row) => {
            const current = await readOwnedDelivery(
              normalizeText(ownerId),
              row.deliveryId,
              session,
            );
            return current || (!DeliveryModel?.db ? row : null);
          }),
        );
        if (currentRows.some((row) => !isClaimable(row, claimedAt, { terminalSettlement }))) {
          throw batchConflictError();
        }
        const exactCurrentRows = currentRows.filter(
          (row): row is CortexDeliveryRow => row !== null,
        );
        assertExactCompleteClaimBatch(exactCurrentRows);
        await requireExactParentBatch(ownerId, parentMessageId, exactCurrentRows, session);
        const claimedRows: CortexDeliveryRow[] = [];
        try {
          for (const row of exactCurrentRows) {
            const claimed = await claimOne(row, {
              surface,
              leaseMs,
              batchClaimToken,
              batchClaimedAt: claimedAt,
              incrementAttempt: !terminalSettlement,
              session,
            });
            if (!claimed) throw batchConflictError();
            claimedRows.push(claimed);
          }
          return claimedRows;
        } catch (error) {
          if (compensate && claimedRows.length > 0) {
            await releasePartialClaims({ ownerId, claimedRows, releasedAt: now() });
          }
          throw error;
        }
      },
    });
  }

  async function recordRows({
    ownerId,
    conversationId,
    parentMessageId,
    surface,
    streamId = '',
    messageRevision = 1,
    feelingSnapshot = null,
    insights,
  }: RecordCortexInsightRowsInput): Promise<CortexDeliveryRow[]> {
    const pinnedFeelingSnapshot = normalizeCortexFeelingSnapshot(feelingSnapshot);
    const candidates = buildCortexInsightDeliveryCandidates({
      ownerId,
      conversationId,
      parentMessageId,
      surface,
      streamId,
      messageRevision,
      insights,
    });
    if (candidates.length > 0) {
      const fault = await consumeFault({
        boundary: 'cortex_ledger_first_write',
        ownerId,
        conversationId,
        parentMessageId,
      });
      if (fault?.triggered === true) {
        throw codedError(
          'Cortex insight delivery ledger write failed',
          'cortex_insight_delivery_ledger_write_failed',
        );
      }
    }
    const createdAt = now();
    const expectedRows = candidates.map((candidate) => ({
      ...candidate,
      feelingSnapshot: pinnedFeelingSnapshot,
    }));
    const expectedByKey = new Map(expectedRows.map((row) => [row.deliveryKey, row]));
    const admissionCoordinator = expectedRows.find((row) => row.parentAdmissionKey);

    async function readExistingRows(
      session: ClientSession | null = null,
    ): Promise<CortexDeliveryRow[]> {
      if (candidates.length === 0 || typeof DeliveryModel.find !== 'function') return [];
      const query = DeliveryModel.find({
        userId: normalizeText(ownerId),
        deliveryKey: { $in: candidates.map((candidate) => candidate.deliveryKey) },
      });
      const rows = await privateLeanResult(query, session);
      return Array.isArray(rows) ? rows : [];
    }

    async function readParentRows(
      session: ClientSession | null = null,
    ): Promise<CortexDeliveryRow[]> {
      if (candidates.length === 0 || typeof DeliveryModel.find !== 'function') return [];
      const query = DeliveryModel.find({
        userId: normalizeText(ownerId),
        parentMessageId: normalizeText(parentMessageId),
      });
      const rows = await privateLeanResult(query, session);
      return Array.isArray(rows) ? rows : [];
    }

    function validateExistingRows(existingRows: CortexDeliveryRow[]): void {
      for (const persisted of existingRows) {
        const expected = expectedByKey.get(persisted?.deliveryKey);
        if (!expected) continue;
        requireExactCortexInsightPersistenceEnvelope(expected, persisted);
      }
    }

    function validateParentAdmission(parentRows: CortexDeliveryRow[]): CortexDeliveryRow[] {
      for (const persisted of parentRows) {
        const expected = expectedByKey.get(persisted?.deliveryKey);
        if (!expected) throw mixedBatchEnvelopeError();
        try {
          requireExactCortexInsightPersistenceEnvelope(expected, persisted);
        } catch (_error) {
          throw mixedBatchEnvelopeError();
        }
        if (
          normalizeText(persisted?.parentAdmissionKey) &&
          normalizeText(persisted.parentAdmissionKey) !==
            normalizeText(admissionCoordinator?.parentAdmissionKey)
        ) {
          throw mixedBatchEnvelopeError();
        }
      }
      return parentRows;
    }

    async function ensureParentAdmission(session: ClientSession | null = null): Promise<void> {
      if (!admissionCoordinator || typeof DeliveryModel?.collection?.updateOne !== 'function') {
        return;
      }
      try {
        await DeliveryModel.collection.updateOne(
          {
            deliveryKey: admissionCoordinator.deliveryKey,
            userId: admissionCoordinator.userId,
            $or: [
              { parentAdmissionKey: { $exists: false } },
              { parentAdmissionKey: null },
              { parentAdmissionKey: '' },
            ],
          },
          { $set: { parentAdmissionKey: admissionCoordinator.parentAdmissionKey } },
          { ...(session ? { session } : {}) },
        );
      } catch (error) {
        if (Number(errorCode(error)) === 11000) throw mixedBatchEnvelopeError();
        throw error;
      }
    }

    async function persistRows(
      session: ClientSession | null = null,
      acceptanceToken = '',
    ): Promise<CortexDeliveryRow[]> {
      if (DeliveryModel?.db) {
        validateParentAdmission(await readParentRows(session));
      }
      validateExistingRows(await readExistingRows(session));
      const rows: CortexDeliveryRow[] = [];
      const orderedCandidates = [...candidates].sort(
        (left, right) =>
          Number(Boolean(right.parentAdmissionKey)) - Number(Boolean(left.parentAdmissionKey)),
      );
      for (const [mutationIndex, candidate] of orderedCandidates.entries()) {
        const exactInsight = findCandidateInsight(candidate, insights);
        const expected = expectedByKey.get(candidate.deliveryKey);
        let persisted: CortexDeliveryRow | null;
        try {
          persisted = await privateLeanResult(
            DeliveryModel.findOneAndUpdate(
              { deliveryKey: candidate.deliveryKey, userId: candidate.userId },
              {
                $setOnInsert: {
                  ...candidate,
                  ...(pinnedFeelingSnapshot ? { feelingSnapshot: pinnedFeelingSnapshot } : {}),
                  ...(acceptanceToken ? { acceptanceToken } : {}),
                  insight: exactInsight,
                  status: 'pending',
                  persistenceStatus: 'pending',
                  attemptNumber: 0,
                  claimGeneration: 0,
                  events: [
                    eventRecord({
                      transition: 'pending',
                      attemptNumber: 0,
                      claimGeneration: 0,
                      eventAt: createdAt,
                      receiptHash: candidate.graphResultHash,
                    }),
                  ],
                },
              },
              {
                new: true,
                upsert: true,
                setDefaultsOnInsert: true,
                runValidators: true,
                ...(session ? { session } : {}),
              },
            ),
            session,
          );
        } catch (error) {
          if (Number(errorCode(error)) !== 11000) throw error;
          persisted = await privateLeanResult(
            DeliveryModel.findOne({
              deliveryKey: candidate.deliveryKey,
              userId: candidate.userId,
            }),
            session,
          );
          if (!persisted) throw mixedBatchEnvelopeError();
        }
        if (persisted) {
          if (!expected) throw acceptanceConflictError();
          requireExactCortexInsightPersistenceEnvelope(expected, persisted);
          rows.push(persisted);
          if (acceptanceToken && typeof afterStandaloneRecordWrite === 'function') {
            try {
              await afterStandaloneRecordWrite({
                deliveryId: persisted.deliveryId,
                mutationIndex,
              });
            } catch (error) {
              if (isDataRecord(error)) error.cortexStandaloneInterruption = true;
              throw error;
            }
          }
        }
      }
      if (rows.length !== candidates.length) throw acceptanceConflictError();
      if (!DeliveryModel?.db) {
        const persistedByKey = new Map(rows.map((row) => [row.deliveryKey, row]));
        const ordered = candidates.map((candidate) => persistedByKey.get(candidate.deliveryKey));
        if (ordered.some((row) => !row)) throw acceptanceConflictError();
        return ordered.filter((row): row is CortexDeliveryRow => row !== undefined);
      }
      await ensureParentAdmission(session);
      const parentRows = validateParentAdmission(await readParentRows(session));
      assertExactCompleteClaimBatch(parentRows);
      if (parentRows.length !== candidates.length) throw mixedBatchEnvelopeError();
      const persistedByKey = new Map(parentRows.map((row) => [row.deliveryKey, row]));
      const ordered = candidates.map((candidate) => persistedByKey.get(candidate.deliveryKey));
      if (ordered.some((row) => !row)) throw acceptanceConflictError();
      return ordered.filter((row): row is CortexDeliveryRow => row !== undefined);
    }

    if (candidates.length > 1) {
      const transaction = await runMongoTransaction((session) => persistRows(session));
      if (transaction.used) return transaction.result;
      return persistRows(null, `cidla_${randomUUID()}`);
    }
    return persistRows();
  }

  async function recordBatch(params: RecordCortexInsightRowsInput) {
    const rows = await recordRows(params);
    const first = rows[0] || {};
    return {
      ...(rows.length > 1
        ? {
            batchId: first.batchId,
            batchSize: first.batchSize,
            batchMemberHashes: first.batchMemberHashes,
          }
        : {}),
      deliveries: rows.map((row) => redactDelivery(row)),
    };
  }

  async function claimBatch({
    ownerId,
    conversationId,
    parentMessageId,
    surface,
    streamId = '',
    messageRevision = 1,
    feelingSnapshot = null,
    insights,
    leaseMs = DEFAULT_LEASE_MS,
  }: ClaimCortexInsightBatchInput) {
    const rows = await recordRows({
      ownerId,
      conversationId,
      parentMessageId,
      surface,
      streamId,
      messageRevision,
      feelingSnapshot,
      insights,
    });
    const recoverableRows = rows.filter((row) => !TERMINAL_STATUSES.has(row.status));
    let claimedRows: CortexDeliveryLike[] = [];
    if (recoverableRows.length > 0) {
      try {
        claimedRows = await claimRowsAtomically({
          ownerId,
          parentMessageId,
          rows: recoverableRows,
          surface,
          leaseMs,
        });
      } catch (error) {
        if (errorCode(error) !== 'cortex_insight_delivery_batch_conflict') throw error;
      }
    }
    const claimedById = new Map(claimedRows.map((row) => [row.deliveryId, row]));
    const deliveries = rows.map((row) => redactDelivery(claimedById.get(row.deliveryId) || row));
    const claimed = claimedRows.map((row) => redactDelivery(row, { includeClaim: true }));

    if (claimed.length > 0) {
      logger.info('[VIVENTIUM][cortex-insight-delivery]', {
        status: 'claimed',
        surface: normalizeSurface(surface),
        count: claimed.length,
      });
    } else if (deliveries.some((delivery) => isTerminalStatus(delivery?.status))) {
      logger.info('[VIVENTIUM][cortex-insight-delivery]', {
        status: 'terminal_replay',
        surface: normalizeSurface(surface),
        count: deliveries.filter((delivery) => isTerminalStatus(delivery?.status)).length,
      });
    }
    return { claimId: claimed[0]?.claimToken || '', deliveries, claimed };
  }

  async function claimPendingByParent({
    ownerId,
    parentMessageId,
    surface,
    leaseMs = DEFAULT_LEASE_MS,
    terminalSettlement = false,
  }: ClaimPendingByParentInput) {
    const userId = normalizeText(ownerId);
    const normalizedParentMessageId = normalizeText(parentMessageId);
    if (!userId || !normalizedParentMessageId) {
      throw new Error('Cortex insight recovery requires owner and parent');
    }
    const checkedAt = now();
    const eligibleQuery = selectPrivate(
      DeliveryModel.find({
        userId,
        parentMessageId: normalizedParentMessageId,
        ...recoverableFilter(checkedAt),
      }),
    );
    const parentQuery = selectPrivate(
      DeliveryModel.find({ userId, parentMessageId: normalizedParentMessageId }),
    );
    const sortedEligible = eligibleQuery?.sort
      ? eligibleQuery.sort({ createdAt: 1, deliveryId: 1 })
      : eligibleQuery;
    const sortedParent = parentQuery?.sort
      ? parentQuery.sort({ createdAt: 1, deliveryId: 1 })
      : parentQuery;
    const [eligibleRows, parentRows] = await Promise.all([
      leanResult(sortedEligible),
      leanResult(sortedParent),
    ]).then((results) => results.map((rows) => rows || []));
    const nonterminalRows = parentRows.filter((row) => !TERMINAL_STATUSES.has(row.status));
    if (nonterminalRows.length === 0) {
      return noClaimResult(parentRows, RECOVERY_NO_CLAIM_REASONS.TERMINAL);
    }
    const batchInspection = inspectClaimBatch(nonterminalRows);
    if (!batchInspection.exact) {
      return hiddenNoClaimResult(RECOVERY_NO_CLAIM_REASONS.MIXED_ENVELOPE);
    }
    if (!batchInspection.complete) {
      return hiddenNoClaimResult(RECOVERY_NO_CLAIM_REASONS.INCOMPLETE_BATCH);
    }
    const pinnedFeelingSnapshot = recoveryFeelingSnapshot(parentRows);
    const eligibility = nonterminalRows.map((row) => isRecoveryEligible(row, checkedAt));
    if (eligibility.some(Boolean) && eligibility.some((eligible) => !eligible)) {
      return noClaimResult(parentRows, RECOVERY_NO_CLAIM_REASONS.INCONSISTENT_ELIGIBILITY);
    }
    if (eligibility.every((eligible) => !eligible)) {
      return noClaimResult(parentRows, RECOVERY_NO_CLAIM_REASONS.NOT_YET_ELIGIBLE);
    }
    const exactParentIds = nonterminalRows.map((row) => normalizeText(row.deliveryId)).sort();
    const eligibleIds = eligibleRows.map((row) => normalizeText(row.deliveryId)).sort();
    if (
      exactParentIds.length !== eligibleIds.length ||
      exactParentIds.some((deliveryId, index) => deliveryId !== eligibleIds[index]) ||
      eligibleRows.some((row) => !isClaimable(row, checkedAt, { terminalSettlement }))
    ) {
      return noClaimResult(parentRows, RECOVERY_NO_CLAIM_REASONS.NOT_CLAIMABLE);
    }
    let claimedRows: CortexDeliveryLike[];
    try {
      claimedRows = await claimRowsAtomically({
        ownerId: userId,
        parentMessageId: normalizedParentMessageId,
        rows: eligibleRows,
        surface,
        leaseMs,
        terminalSettlement,
      });
    } catch (error) {
      if (errorCode(error) === 'cortex_insight_delivery_batch_conflict') {
        return noClaimResult(parentRows, RECOVERY_NO_CLAIM_REASONS.CONFLICT);
      }
      throw error;
    }

    const claimed = claimedRows.map((row) => redactDelivery(row, { includeClaim: true }));
    return {
      claimId: claimed[0]?.claimToken || '',
      deliveries: parentRows.map((row) => {
        const claimedRow = claimedRows.find((item) => item.deliveryId === row.deliveryId);
        return redactDelivery(claimedRow || row);
      }),
      claimed,
      insights: claimedRows.map((row) => ({
        cortexId: row.cortexId,
        cortexName: row.cortexName,
        insight: row.insight,
        status: 'completed',
      })),
      recoveryContext: {
        streamId: claimedRows[0]?.streamId || '',
        messageRevision: presentationRevisionOf(claimedRows[0]),
        claimGeneration: Number(claimedRows[0]?.claimGeneration) || 0,
        ...(pinnedFeelingSnapshot ? { feelingSnapshot: pinnedFeelingSnapshot } : {}),
      },
    };
  }

  async function settleOne({
    ownerId,
    claim,
    transition,
    projection,
    reason = '',
    receiptHash = '',
    intentToken = '',
    allowExpiredLease = false,
    session = null,
  }: SettleOneInput): Promise<CortexDeliveryLike> {
    const userId = normalizeText(ownerId);
    const fence = normalizeClaim(claim);
    const eventAt = now();
    let existing = await readOwnedDelivery(userId, fence.deliveryId, session);
    let currentPresentationRevision = 0;
    if (transition === 'persisted') {
      existing = await initializeLegacySourceRevision(existing, session);
      currentPresentationRevision = presentationRevisionOf(existing);
      if (Number(projection.presentationRevision) < currentPresentationRevision) {
        throw settlementConflictError('Cortex insight presentation revision cannot decrease');
      }
      if (
        existing?.persistenceStatus === 'persisted' &&
        normalizeText(existing?.persistedMessageId) !== normalizeText(projection.persistedMessageId)
      ) {
        throw settlementConflictError();
      }
    }
    const liveLease = existing?.leaseExpiresAt ? new Date(existing.leaseExpiresAt) : null;
    const exactFence =
      existing?.status === 'claimed' &&
      normalizeText(existing.claimToken) === fence.claimToken &&
      Number(existing.claimGeneration) === fence.claimGeneration &&
      liveLease instanceof Date &&
      (allowExpiredLease || liveLease.getTime() > eventAt.getTime());
    const samePersistedReceipt =
      transition === 'persisted' &&
      existing?.persistenceStatus === 'persisted' &&
      normalizeText(existing?.persistedMessageId) ===
        normalizeText(projection.persistedMessageId) &&
      presentationRevisionOf(existing) === Number(projection.presentationRevision);
    const sameSentReceipt =
      transition === 'sent' &&
      existing?.status === 'sent' &&
      normalizeText(existing?.persistedMessageId) === normalizeText(projection.persistedMessageId);
    const sameDroppedReason =
      transition === 'dropped' &&
      existing?.status === 'dropped' &&
      normalizeText(existing?.dropReason) === normalizeText(projection.dropReason);
    if (existing && samePersistedReceipt) {
      if (!exactFence) throw settlementConflictError();
      return redactDelivery(existing);
    }
    if (existing && (sameSentReceipt || sameDroppedReason)) {
      return redactDelivery(existing);
    }
    if (!existing || !exactFence) {
      throw settlementConflictError();
    }

    const updateFilter: DataRecord = {
      deliveryId: fence.deliveryId,
      userId,
      status: 'claimed',
      claimToken: fence.claimToken,
      claimGeneration: fence.claimGeneration,
      leaseExpiresAt: allowExpiredLease
        ? { $eq: existing.leaseExpiresAt }
        : { $eq: existing.leaseExpiresAt, $gt: eventAt },
      ...(transition === 'persisted'
        ? {
            ...presentationRevisionCasFilter(existing, currentPresentationRevision),
            ...(existing?.persistenceStatus === 'persisted'
              ? {
                  persistenceStatus: 'persisted',
                  persistedMessageId: normalizeText(existing.persistedMessageId),
                }
              : {}),
          }
        : {}),
    };
    const update: DataRecord = {
      $set: {
        ...projection,
        ...(transition === 'persisted' &&
        Number(projection.presentationRevision) > currentPresentationRevision
          ? {
              presentedSurfaces: [],
              presentationReceiptHashes: [],
              presentationLeaseToken: '',
              presentationLeaseOwnerId: '',
              presentationLeaseClaimToken: '',
              presentationLeaseGeneration: 0,
              presentationLeaseExpiresAt: null,
            }
          : {}),
        ...(intentToken ? { lastBatchIntentToken: intentToken } : {}),
      },
      $push: {
        events: eventRecord({
          transition,
          attemptNumber: existing.attemptNumber,
          claimToken: fence.claimToken,
          claimGeneration: fence.claimGeneration,
          eventAt,
          claimedAt: existing.claimedAt,
          leaseExpiresAt: existing.leaseExpiresAt,
          reason,
          receiptHash,
          surface: normalizeText(projection.surface),
          runtimeSlot: existing.claimRuntimeSlot,
          runtimeEpoch: existing.claimRuntimeEpoch,
        }),
      },
    };
    const updated =
      transition === 'persisted'
        ? await updateRevisionProjection(updateFilter, update, session)
        : await privateLeanResult(
            DeliveryModel.findOneAndUpdate(updateFilter, update, {
              new: true,
              runValidators: true,
              ...(session ? { session } : {}),
            }),
            session,
          );
    if (!updated) {
      if (transition === 'persisted') {
        const current = await readOwnedDelivery(userId, fence.deliveryId, session);
        if (
          current?.persistenceStatus === 'persisted' &&
          normalizeText(current.persistedMessageId) ===
            normalizeText(projection.persistedMessageId) &&
          presentationRevisionOf(current) === Number(projection.presentationRevision) &&
          hasExactLiveClaimFence(current, fence, eventAt)
        ) {
          return redactDelivery(current);
        }
      }
      throw settlementConflictError();
    }
    return redactDelivery(updated);
  }

  function hasExactLiveClaimFence(
    existing: CortexDeliveryLike | null | undefined,
    claim: CortexClaimInput,
    checkedAt: Date = now(),
  ): boolean {
    const fence = normalizeClaim(claim);
    const liveLease = existing?.leaseExpiresAt ? new Date(existing.leaseExpiresAt) : null;
    return (
      existing?.status === 'claimed' &&
      normalizeText(existing.claimToken) === fence.claimToken &&
      Number(existing.claimGeneration) === fence.claimGeneration &&
      liveLease instanceof Date &&
      liveLease.getTime() > checkedAt.getTime()
    );
  }

  function settlementAlreadyApplied(
    existing: CortexDeliveryLike | null | undefined,
    transition: CortexInsightDeliveryEventTransition,
    projection: DataRecord,
    claim: CortexClaimInput,
  ): boolean {
    if (transition === 'persisted') {
      return (
        existing?.persistenceStatus === 'persisted' &&
        normalizeText(existing.persistedMessageId) ===
          normalizeText(projection.persistedMessageId) &&
        presentationRevisionOf(existing) === Number(projection.presentationRevision) &&
        hasExactLiveClaimFence(existing, claim)
      );
    }
    if (transition === 'sent') {
      return (
        existing?.status === 'sent' &&
        normalizeText(existing.persistedMessageId) === normalizeText(projection.persistedMessageId)
      );
    }
    return (
      transition === 'dropped' &&
      existing?.status === 'dropped' &&
      normalizeText(existing.dropReason) === normalizeText(projection.dropReason)
    );
  }

  function restorableProjection(row: CortexDeliveryLike): DataRecord {
    return {
      status: row.status,
      persistenceStatus: row.persistenceStatus || 'pending',
      persistedMessageId: row.persistedMessageId || '',
      persistedAt: row.persistedAt || null,
      presentationRevision: presentationRevisionOf(row),
      messageRevision: presentationRevisionOf(row),
      presentedSurfaces: Array.isArray(row.presentedSurfaces) ? row.presentedSurfaces : [],
      presentationReceiptHashes: Array.isArray(row.presentationReceiptHashes)
        ? row.presentationReceiptHashes
        : [],
      claimToken: row.claimToken || '',
      claimRuntimeSlot: row.claimRuntimeSlot || '',
      claimRuntimeEpoch: row.claimRuntimeEpoch || '',
      claimedAt: row.claimedAt || null,
      leaseExpiresAt: row.leaseExpiresAt || null,
      presentationLeaseToken: row.presentationLeaseToken || '',
      presentationLeaseOwnerId: row.presentationLeaseOwnerId || '',
      presentationLeaseClaimToken: row.presentationLeaseClaimToken || '',
      presentationLeaseGeneration: Number(row.presentationLeaseGeneration) || 0,
      presentationLeaseExpiresAt: row.presentationLeaseExpiresAt || null,
      sentAt: row.sentAt || null,
      dropReason: row.dropReason || '',
      droppedAt: row.droppedAt || null,
    };
  }

  async function compensateSettledRows({
    ownerId,
    beforeRows,
    changedIds,
  }: {
    ownerId: unknown;
    beforeRows: CortexDeliveryRow[];
    changedIds: Set<string>;
  }): Promise<void> {
    const compensatedAt = now();
    for (const before of beforeRows) {
      if (!changedIds.has(before.deliveryId)) continue;
      const restored = await updateRevisionProjection(
        {
          deliveryId: before.deliveryId,
          userId: normalizeText(ownerId),
          claimGeneration: Number(before.claimGeneration) || 0,
        },
        {
          $set: restorableProjection(before),
          $push: {
            events: eventRecord({
              transition: 'failure',
              attemptNumber: Number(before.attemptNumber) || 0,
              claimToken: before.claimToken || '',
              claimGeneration: Number(before.claimGeneration) || 0,
              eventAt: compensatedAt,
              claimedAt: before.claimedAt || null,
              leaseExpiresAt: before.leaseExpiresAt || null,
              reason: 'batch_transition_conflict',
            }),
          },
        },
      );
      if (!restored) {
        throw batchConflictError('Cortex insight delivery batch compensation failed');
      }
    }
  }

  async function runAtomicClaimBatch({
    ownerId,
    claims,
    descriptor,
    operation,
  }: RunAtomicClaimBatchInput): Promise<CortexDeliveryLike[]> {
    const userId = normalizeText(ownerId);
    const normalizedClaims = (Array.isArray(claims) ? claims : []).map(normalizeClaim);
    if (normalizedClaims.length === 0) return [];
    const initialRows = await readClaimRows(userId, normalizedClaims);
    const parentMessageId = normalizeText(
      initialRows[0].parentMessageId || (!DeliveryModel?.db ? initialRows[0].deliveryId : ''),
    );
    return runAtomicParentBatch({
      ownerId: userId,
      parentMessageId,
      rows: initialRows,
      descriptor: {
        ...descriptor,
        ownerId: userId,
        claims: normalizedClaims,
      },
      work: async ({ session, compensate }) => {
        const beforeRows = await readClaimRows(userId, normalizedClaims, session);
        const changedIds = new Set<string>();
        try {
          return await operation({
            claims: normalizedClaims,
            beforeRows,
            changedIds,
            session,
          });
        } catch (error) {
          if (compensate && changedIds.size > 0) {
            await compensateSettledRows({ ownerId: userId, beforeRows, changedIds });
          }
          throw error;
        }
      },
    });
  }

  async function settleClaims({
    ownerId,
    claims,
    transition,
    projection,
    reason,
    receiptHash,
    allowExpiredLease = false,
  }: SettleClaimsInput): Promise<CortexDeliveryLike[]> {
    const settled = await runAtomicClaimBatch({
      ownerId,
      claims,
      descriptor: {
        type: 'settle',
        transition,
        projection,
        reason,
        receiptHash,
        allowExpiredLease,
      },
      operation: async ({ claims: normalizedClaims, beforeRows, changedIds, session }) => {
        const settled: CortexDeliveryLike[] = [];
        const beforeById = new Map(beforeRows.map((row) => [row.deliveryId, row]));
        for (const claim of normalizedClaims) {
          const existing = beforeById.get(claim.deliveryId);
          if (existing && settlementAlreadyApplied(existing, transition, projection, claim)) {
            settled.push(redactDelivery(existing));
            continue;
          }
          const row = await settleOne({
            ownerId,
            claim,
            transition,
            projection,
            reason,
            receiptHash,
            allowExpiredLease,
            session,
          });
          changedIds.add(claim.deliveryId);
          settled.push(row);
        }
        return settled;
      },
    });
    return assertExactClaimSettlement(claims, settled);
  }

  async function markPersisted({
    ownerId,
    claims,
    persistedMessageId,
    messageRevision = 1,
  }: MarkPersistedInput): Promise<CortexDeliveryLike[]> {
    const normalizedMessageId = normalizeText(persistedMessageId);
    if (!normalizedMessageId) {
      throw new Error('Cortex insight persistence requires persistedMessageId');
    }
    const revision = Math.max(1, Number(messageRevision) || 1);
    const persistedAt = now();
    const settled = await settleClaims({
      ownerId,
      claims,
      transition: 'persisted',
      projection: {
        persistenceStatus: 'persisted',
        persistedMessageId: normalizedMessageId,
        persistedAt,
        presentationRevision: revision,
        messageRevision: revision,
      },
      receiptHash: stableHash(
        JSON.stringify({ messageId: normalizedMessageId, revision, stage: 'persistence' }),
      ),
    });
    if (settled.length > 0) {
      logger.info('[VIVENTIUM][cortex-insight-delivery]', {
        status: 'persisted',
        count: settled.length,
      });
    }
    return settled;
  }

  function presentationReceiptHash({
    surface,
    persistedMessageId,
    messageRevision,
    presentationRef,
    presentationClaimToken,
    claimGeneration,
    graphResultHash,
    presentationLeaseToken,
  }: PresentationReceiptInput): string {
    return stableHash(
      JSON.stringify({
        messageId: normalizeText(persistedMessageId),
        presentationRef: normalizeText(presentationRef),
        revision: Math.max(1, Number(messageRevision) || 1),
        surface: normalizeSurface(surface),
        claimToken: normalizeText(presentationClaimToken),
        claimGeneration: Number(claimGeneration),
        graphResultHash: normalizeText(graphResultHash),
        presentationLeaseToken: normalizeText(presentationLeaseToken),
      }),
    );
  }

  async function finalizePresentedOne({
    ownerId,
    claim,
    intentToken = '',
    allowExpiredLease = false,
    presentationClaimToken = '',
    presentationLeaseToken = '',
    session = null,
  }: FinalizePresentedOneInput): Promise<CortexDeliveryLike> {
    const userId = normalizeText(ownerId);
    const fence = normalizeClaim(claim);
    const sentAt = now();
    const existing = await readOwnedDelivery(userId, fence.deliveryId, session);
    if (existing?.status === 'sent') return redactDelivery(existing);
    const requiredSurfaces = Array.isArray(existing?.requiredSurfaces)
      ? existing.requiredSurfaces
      : [];
    const presentedSurfaces = Array.isArray(existing?.presentedSurfaces)
      ? existing.presentedSurfaces
      : [];
    const receiptHashes = Array.isArray(existing?.presentationReceiptHashes)
      ? existing.presentationReceiptHashes
      : [];
    const allPresented =
      requiredSurfaces.length > 0 &&
      requiredSurfaces.every((surface) => presentedSurfaces.includes(surface)) &&
      receiptHashes.length >= requiredSurfaces.length;
    const liveLease = existing?.leaseExpiresAt ? new Date(existing.leaseExpiresAt) : null;
    const exactFence =
      existing?.status === 'claimed' &&
      existing?.persistenceStatus === 'persisted' &&
      normalizeText(existing.claimToken) === fence.claimToken &&
      Number(existing.claimGeneration) === fence.claimGeneration &&
      liveLease instanceof Date &&
      (allowExpiredLease || liveLease.getTime() > sentAt.getTime());
    const exactPresentationLease =
      normalizeText(presentationClaimToken) === fence.claimToken &&
      normalizeText(presentationLeaseToken) !== '' &&
      normalizeText(existing?.presentationLeaseToken) === normalizeText(presentationLeaseToken) &&
      normalizeText(existing?.presentationLeaseOwnerId) === userId &&
      normalizeText(existing?.presentationLeaseClaimToken) === fence.claimToken &&
      Number(existing?.presentationLeaseGeneration) === fence.claimGeneration &&
      hasLivePresentationLease(existing, sentAt);
    const requiresPresentationLease =
      normalizeText(presentationClaimToken) !== '' || normalizeText(presentationLeaseToken) !== '';
    if (!allPresented || !exactFence || (requiresPresentationLease && !exactPresentationLease)) {
      throw settlementConflictError();
    }
    const sentReceiptHash = stableHash(
      JSON.stringify({
        messageId: normalizeText(existing.persistedMessageId),
        presentationReceiptHashes: [...receiptHashes].sort(),
        revision: presentationRevisionOf(existing),
      }),
    );
    const sent = await privateLeanResult(
      DeliveryModel.findOneAndUpdate(
        {
          deliveryId: fence.deliveryId,
          userId,
          status: 'claimed',
          persistenceStatus: 'persisted',
          claimToken: fence.claimToken,
          claimGeneration: fence.claimGeneration,
          leaseExpiresAt: allowExpiredLease ? { $eq: existing.leaseExpiresAt } : { $gt: sentAt },
          ...(requiresPresentationLease
            ? {
                presentationLeaseToken: normalizeText(presentationLeaseToken),
                presentationLeaseOwnerId: userId,
                presentationLeaseClaimToken: fence.claimToken,
                presentationLeaseGeneration: fence.claimGeneration,
                presentationLeaseExpiresAt: { $gt: sentAt },
              }
            : {}),
          presentedSurfaces: { $all: requiredSurfaces },
        },
        {
          $set: {
            status: 'sent',
            claimToken: '',
            claimRuntimeSlot: '',
            claimRuntimeEpoch: '',
            claimedAt: null,
            leaseExpiresAt: null,
            presentationLeaseToken: '',
            presentationLeaseOwnerId: '',
            presentationLeaseClaimToken: '',
            presentationLeaseGeneration: 0,
            presentationLeaseExpiresAt: null,
            sentAt,
            expiresAt: terminalExpiry(sentAt),
            dropReason: '',
            droppedAt: null,
            ...(intentToken ? { lastBatchIntentToken: intentToken } : {}),
          },
          $push: {
            events: eventRecord({
              transition: 'sent',
              attemptNumber: existing.attemptNumber,
              claimToken: fence.claimToken,
              claimGeneration: fence.claimGeneration,
              eventAt: sentAt,
              claimedAt: existing.claimedAt,
              leaseExpiresAt: existing.leaseExpiresAt,
              receiptHash: sentReceiptHash,
              runtimeSlot: existing.claimRuntimeSlot,
              runtimeEpoch: existing.claimRuntimeEpoch,
            }),
          },
        },
        { new: true, runValidators: true, ...(session ? { session } : {}) },
      ),
      session,
    );
    if (!sent) throw settlementConflictError();
    return redactDelivery(sent);
  }

  async function markPresentedOne({
    ownerId,
    claim,
    surface,
    persistedMessageId,
    messageRevision = 1,
    presentationGeneration = 0,
    presentationClaimToken = '',
    presentationLeaseToken = '',
    presentationRef,
    intentToken = '',
    allowExpiredLease = false,
    session = null,
  }: MarkPresentedOneInput): Promise<CortexDeliveryLike> {
    const userId = normalizeText(ownerId);
    const fence = normalizeClaim(claim);
    const normalizedSurface = normalizeSurface(surface);
    const normalizedMessageId = normalizeText(persistedMessageId);
    const normalizedPresentationRef = normalizeText(presentationRef);
    const revision = Math.max(1, Number(messageRevision) || 1);
    const normalizedPresentationGeneration = Number(presentationGeneration);
    const normalizedPresentationClaimToken = normalizeText(presentationClaimToken);
    const normalizedPresentationLeaseToken = normalizeText(presentationLeaseToken);
    if (!normalizedMessageId || !normalizedPresentationRef) {
      throw settlementConflictError(
        'Cortex insight presentation requires an exact surface receipt',
      );
    }
    if (
      !Number.isSafeInteger(normalizedPresentationGeneration) ||
      normalizedPresentationGeneration < 1 ||
      normalizedPresentationGeneration !== fence.claimGeneration
    ) {
      throw settlementConflictError('Cortex insight presentation generation conflict');
    }
    if (
      normalizedPresentationClaimToken !== fence.claimToken ||
      !normalizedPresentationLeaseToken
    ) {
      throw settlementConflictError('Cortex insight presentation lease receipt conflict');
    }
    const eventAt = now();
    const existing = await readOwnedDelivery(userId, fence.deliveryId, session);
    const graphResultHash = normalizeText(existing?.graphResultHash);
    if (!graphResultHash) {
      throw settlementConflictError('Cortex insight graph-result receipt identity is unavailable');
    }
    const receiptHash = presentationReceiptHash({
      surface: normalizedSurface,
      persistedMessageId: normalizedMessageId,
      messageRevision: revision,
      presentationRef: normalizedPresentationRef,
      presentationClaimToken: normalizedPresentationClaimToken,
      claimGeneration: fence.claimGeneration,
      graphResultHash,
      presentationLeaseToken: normalizedPresentationLeaseToken,
    });
    const requiredSurfaces = Array.isArray(existing?.requiredSurfaces)
      ? existing.requiredSurfaces
      : [];
    const presentedSurfaces = Array.isArray(existing?.presentedSurfaces)
      ? existing.presentedSurfaces
      : [];
    const receiptHashes = Array.isArray(existing?.presentationReceiptHashes)
      ? existing.presentationReceiptHashes
      : [];
    if (
      existing &&
      presentedSurfaces.includes(normalizedSurface) &&
      receiptHashes.includes(receiptHash) &&
      normalizeText(existing?.persistedMessageId) === normalizedMessageId &&
      presentationRevisionOf(existing) === revision
    ) {
      const allPresented = requiredSurfaces.every((item) => presentedSurfaces.includes(item));
      return allPresented
        ? finalizePresentedOne({
            ownerId,
            claim,
            intentToken,
            allowExpiredLease,
            presentationClaimToken: normalizedPresentationClaimToken,
            presentationLeaseToken: normalizedPresentationLeaseToken,
            session,
          })
        : redactDelivery(existing);
    }
    if (
      !requiredSurfaces.includes(normalizedSurface) ||
      presentedSurfaces.includes(normalizedSurface)
    ) {
      throw settlementConflictError('Cortex insight presentation receipt conflict');
    }
    const liveLease = existing?.leaseExpiresAt ? new Date(existing.leaseExpiresAt) : null;
    const exactFence =
      existing?.status === 'claimed' &&
      existing?.persistenceStatus === 'persisted' &&
      normalizeText(existing.persistedMessageId) === normalizedMessageId &&
      presentationRevisionOf(existing) === revision &&
      normalizeText(existing.claimToken) === fence.claimToken &&
      Number(existing.claimGeneration) === fence.claimGeneration &&
      liveLease instanceof Date &&
      (allowExpiredLease || liveLease.getTime() > eventAt.getTime());
    const exactPresentationLease =
      normalizeText(existing?.presentationLeaseToken) === normalizedPresentationLeaseToken &&
      normalizeText(existing?.presentationLeaseOwnerId) === userId &&
      normalizeText(existing?.presentationLeaseClaimToken) === fence.claimToken &&
      Number(existing?.presentationLeaseGeneration) === fence.claimGeneration &&
      hasLivePresentationLease(existing, eventAt);
    if (!exactFence || !exactPresentationLease) {
      throw settlementConflictError();
    }

    const presented = await privateLeanResult(
      DeliveryModel.findOneAndUpdate(
        {
          deliveryId: fence.deliveryId,
          userId,
          status: 'claimed',
          persistenceStatus: 'persisted',
          persistedMessageId: normalizedMessageId,
          ...presentationRevisionFilter(revision),
          claimToken: fence.claimToken,
          claimGeneration: fence.claimGeneration,
          leaseExpiresAt: allowExpiredLease
            ? { $eq: existing.leaseExpiresAt }
            : { $eq: existing.leaseExpiresAt, $gt: eventAt },
          presentationLeaseToken: normalizedPresentationLeaseToken,
          presentationLeaseOwnerId: userId,
          presentationLeaseClaimToken: fence.claimToken,
          presentationLeaseGeneration: fence.claimGeneration,
          presentationLeaseExpiresAt: { $gt: eventAt },
          presentedSurfaces: { $ne: normalizedSurface },
        },
        {
          $addToSet: {
            presentedSurfaces: normalizedSurface,
            presentationReceiptHashes: receiptHash,
          },
          ...(!requiredSurfaces.every(
            (item) => item === normalizedSurface || presentedSurfaces.includes(item),
          ) && intentToken
            ? { $set: { lastBatchIntentToken: intentToken } }
            : {}),
          $push: {
            events: eventRecord({
              transition: 'presented',
              attemptNumber: existing.attemptNumber,
              claimToken: fence.claimToken,
              claimGeneration: fence.claimGeneration,
              eventAt,
              claimedAt: existing.claimedAt,
              leaseExpiresAt: existing.leaseExpiresAt,
              surface: normalizedSurface,
              receiptHash,
              runtimeSlot: existing.claimRuntimeSlot,
              runtimeEpoch: existing.claimRuntimeEpoch,
            }),
          },
        },
        { new: true, runValidators: true, ...(session ? { session } : {}) },
      ),
      session,
    );
    if (!presented) {
      throw settlementConflictError();
    }
    const allPresented = requiredSurfaces.every((item) =>
      (presented.presentedSurfaces || []).includes(item),
    );
    if (!allPresented) return redactDelivery(presented);

    return finalizePresentedOne({
      ownerId,
      claim,
      intentToken,
      allowExpiredLease,
      presentationClaimToken: normalizedPresentationClaimToken,
      presentationLeaseToken: normalizedPresentationLeaseToken,
      session,
    });
  }

  async function markPresented({
    ownerId,
    claims,
    ...receipt
  }: MarkPresentedInput): Promise<CortexDeliveryLike[]> {
    const exactReceipt: PresentationFence = {
      surface: normalizeSurface(receipt.surface),
      persistedMessageId: normalizeText(receipt.persistedMessageId),
      messageRevision: Math.max(1, Number(receipt.messageRevision) || 1),
      presentationRef: normalizeText(receipt.presentationRef),
      presentationClaimToken: normalizeText(receipt.presentationClaimToken),
      claimGeneration: Number(receipt.claimGeneration) || undefined,
      graphResultHash: normalizeText(receipt.graphResultHash),
      presentationLeaseToken: normalizeText(receipt.presentationLeaseToken),
      presentationGeneration: Number(receipt.presentationGeneration) || undefined,
    };
    const settled = await runAtomicClaimBatch({
      ownerId,
      claims,
      descriptor: { type: 'present', receipt: exactReceipt },
      operation: async ({ claims: normalizedClaims, beforeRows, changedIds, session }) => {
        const settled: CortexDeliveryLike[] = [];
        const beforeById = new Map(beforeRows.map((row) => [row.deliveryId, row]));
        const normalizedSurface = normalizeSurface(exactReceipt.surface);
        for (const claim of normalizedClaims) {
          const existing = beforeById.get(claim.deliveryId);
          const wasPresented = (existing?.presentedSurfaces || []).includes(normalizedSurface);
          const wouldFinalize =
            existing?.status !== 'sent' &&
            (existing?.requiredSurfaces || []).every(
              (surface) =>
                surface === normalizedSurface ||
                (existing?.presentedSurfaces || []).includes(surface),
            );
          if (!wasPresented || wouldFinalize) {
            changedIds.add(claim.deliveryId);
          }
          const row = await markPresentedOne({ ownerId, claim, ...exactReceipt, session });
          settled.push(row);
        }
        return settled;
      },
    });
    return assertExactClaimSettlement(claims, settled);
  }

  async function finalizePresented({
    ownerId,
    claims,
  }: OwnerClaimsInput): Promise<CortexDeliveryLike[]> {
    const finalized = await runAtomicClaimBatch({
      ownerId,
      claims,
      descriptor: { type: 'finalize' },
      operation: async ({ claims: normalizedClaims, beforeRows, changedIds, session }) => {
        const finalized: CortexDeliveryLike[] = [];
        const beforeById = new Map(beforeRows.map((row) => [row.deliveryId, row]));
        for (const claim of normalizedClaims) {
          const existing = beforeById.get(claim.deliveryId);
          if (existing?.status !== 'sent') changedIds.add(claim.deliveryId);
          const row = await finalizePresentedOne({ ownerId, claim, session });
          finalized.push(row);
        }
        return finalized;
      },
    });
    return assertExactClaimSettlement(claims, finalized);
  }

  async function markSent({
    ownerId,
    claims,
    persistedMessageId,
    messageRevision = 1,
    presentationReceipts,
  }: MarkSentInput): Promise<CortexDeliveryLike[]> {
    if (!Array.isArray(presentationReceipts) || presentationReceipts.length === 0) {
      throw new Error('Cortex insight sent outcome requires actual presentation receipts');
    }
    await markPersisted({ ownerId, claims, persistedMessageId, messageRevision });
    let settled: CortexDeliveryLike[] = [];
    for (const receipt of presentationReceipts) {
      const presentationFence = await fencePresentation({
        ownerId,
        claims,
        surface: receipt.surface,
        persistedMessageId,
        messageRevision,
      });
      settled = await markPresented({
        ownerId,
        claims: presentationFence.claims,
        persistedMessageId,
        messageRevision,
        ...receipt,
        presentationGeneration: presentationFence.generation,
        presentationClaimToken: presentationFence.claimToken,
        presentationLeaseToken: presentationFence.presentationLeaseToken,
      });
    }
    return settled;
  }

  async function markFailed({
    ownerId,
    claims,
    reason,
  }: MarkFailedInput): Promise<CortexDeliveryLike[]> {
    const normalizedReason = normalizeText(reason);
    if (!CORTEX_INSIGHT_RETRYABLE_FAILURE_REASONS.some((value) => value === normalizedReason)) {
      throw new Error('Unsupported cortex insight retryable failure reason');
    }
    const settled = await settleClaims({
      ownerId,
      claims,
      transition: 'failure',
      reason: normalizedReason,
      projection: {
        status: 'pending',
        claimToken: '',
        claimRuntimeSlot: '',
        claimRuntimeEpoch: '',
        claimedAt: null,
        leaseExpiresAt: null,
        presentationLeaseToken: '',
        presentationLeaseOwnerId: '',
        presentationLeaseClaimToken: '',
        presentationLeaseGeneration: 0,
        presentationLeaseExpiresAt: null,
        expiresAt: null,
      },
    });
    if (settled.length > 0) {
      logger.warn('[VIVENTIUM][cortex-insight-delivery]', {
        status: 'pending_retry',
        reason: normalizedReason,
        count: settled.length,
      });
    }
    return settled;
  }

  async function markDropped({
    ownerId,
    claims,
    dropReason,
    allowExpiredLease = false,
  }: MarkDroppedInput): Promise<CortexDeliveryLike[]> {
    const normalizedReason = normalizeText(dropReason);
    if (!CORTEX_INSIGHT_DROP_REASONS.some((value) => value === normalizedReason)) {
      throw new Error('Cortex insight drop reason is not a terminal nonretryable reason');
    }
    if (allowExpiredLease && normalizedReason !== 'delivery_outcome_unknown') {
      throw new Error('Only an expired claim with an unknown transport outcome can be quarantined');
    }
    const droppedAt = now();
    const settled = await settleClaims({
      ownerId,
      claims,
      transition: 'dropped',
      reason: normalizedReason,
      allowExpiredLease,
      projection: {
        status: 'dropped',
        claimToken: '',
        claimRuntimeSlot: '',
        claimRuntimeEpoch: '',
        claimedAt: null,
        dropReason: normalizedReason,
        droppedAt,
        leaseExpiresAt: null,
        presentationLeaseToken: '',
        presentationLeaseOwnerId: '',
        presentationLeaseClaimToken: '',
        presentationLeaseGeneration: 0,
        presentationLeaseExpiresAt: null,
        expiresAt: terminalExpiry(droppedAt),
      },
    });
    if (settled.length > 0) {
      logger.info('[VIVENTIUM][cortex-insight-delivery]', {
        status: 'dropped',
        dropReason: normalizedReason,
        count: settled.length,
      });
    }
    return settled;
  }

  async function renewOne({
    ownerId,
    claim,
    renewedAt,
    leaseExpiresAt,
    presentationLease = null,
    intentToken = '',
    allowExpiredLease = false,
    session = null,
  }: RenewOneInput): Promise<CortexDeliveryLike> {
    const existing = await readOwnedDelivery(normalizeText(ownerId), claim.deliveryId, session);
    const filter: DataRecord = {
      deliveryId: claim.deliveryId,
      userId: normalizeText(ownerId),
      status: 'claimed',
      claimToken: claim.claimToken,
      claimGeneration: claim.claimGeneration,
      leaseExpiresAt: allowExpiredLease ? { $eq: existing?.leaseExpiresAt } : { $gt: renewedAt },
    };
    if (presentationLease) {
      filter.$or = [
        { presentationLeaseToken: { $in: ['', null] } },
        { presentationLeaseExpiresAt: null },
        { presentationLeaseExpiresAt: { $exists: false } },
        { presentationLeaseExpiresAt: { $lte: renewedAt } },
        {
          presentationLeaseToken: normalizeText(presentationLease.token),
          presentationLeaseOwnerId: normalizeText(ownerId),
          presentationLeaseClaimToken: claim.claimToken,
          presentationLeaseGeneration: claim.claimGeneration,
        },
      ];
    }
    const row = await privateLeanResult(
      DeliveryModel.findOneAndUpdate(
        filter,
        {
          $set: {
            leaseExpiresAt,
            ...(presentationLease
              ? {
                  presentationLeaseToken: normalizeText(presentationLease.token),
                  presentationLeaseOwnerId: normalizeText(ownerId),
                  presentationLeaseClaimToken: claim.claimToken,
                  presentationLeaseGeneration: claim.claimGeneration,
                  presentationLeaseExpiresAt: requiredDate(
                    presentationLease.expiresAt,
                    'presentation lease expiry',
                  ),
                }
              : {}),
            ...(intentToken ? { lastBatchIntentToken: intentToken } : {}),
          },
        },
        { new: true, runValidators: true, ...(session ? { session } : {}) },
      ),
      session,
    );
    if (!row) throw settlementConflictError();
    return redactDelivery(row, {
      includeClaim: true,
      includePresentationLease: Boolean(presentationLease),
    });
  }

  function assertPresentationFenceRows(
    rows: CortexDeliveryRow[],
    claims: CortexClaim[],
    presentation: PresentationLeaseFence,
    checkedAt: Date,
  ): void {
    const normalizedSurface = normalizeSurface(presentation?.surface);
    const persistedMessageId = normalizeText(presentation?.persistedMessageId);
    const messageRevision = Math.max(1, Number(presentation?.messageRevision) || 1);
    const parentMessageId = normalizeText(presentation?.parentMessageId);
    const presentationLeaseToken = normalizeText(presentation?.token);
    if (!persistedMessageId || normalizedSurface === 'unknown' || !presentationLeaseToken) {
      throw settlementConflictError('Cortex insight presentation fence identity is invalid');
    }
    const rowsById = new Map(rows.map((row) => [normalizeText(row?.deliveryId), row]));
    for (const claim of claims) {
      const row = rowsById.get(claim.deliveryId);
      if (!row) {
        throw settlementConflictError('Cortex insight presentation fence row is missing');
      }
      if (!hasExactLiveClaimFence(row, claim, checkedAt)) {
        throw settlementConflictError('Cortex insight presentation claim fence is stale');
      }
      if (row.persistenceStatus !== 'persisted') {
        throw settlementConflictError('Cortex insight presentation is not persisted');
      }
      if (normalizeText(row.persistedMessageId) !== persistedMessageId) {
        throw settlementConflictError('Cortex insight presentation message fence did not match');
      }
      if (presentationRevisionOf(row) !== messageRevision) {
        throw settlementConflictError('Cortex insight presentation revision fence did not match');
      }
      if (parentMessageId && normalizeText(row.parentMessageId) !== parentMessageId) {
        throw settlementConflictError('Cortex insight presentation parent fence did not match');
      }
      if (
        !Array.isArray(row.requiredSurfaces) ||
        !row.requiredSurfaces.includes(normalizedSurface)
      ) {
        throw settlementConflictError('Cortex insight presentation surface fence did not match');
      }
      const currentPresentationLeaseIsLive = hasLivePresentationLease(row, checkedAt);
      const currentPresentationLeaseMatches =
        normalizeText(row?.presentationLeaseToken) === presentationLeaseToken &&
        normalizeText(row?.presentationLeaseOwnerId) === normalizeText(presentation.ownerId) &&
        normalizeText(row?.presentationLeaseClaimToken) === claim.claimToken &&
        Number(row?.presentationLeaseGeneration) === claim.claimGeneration;
      if (currentPresentationLeaseIsLive && !currentPresentationLeaseMatches) {
        throw settlementConflictError('Cortex insight presentation lease fence did not match');
      }
    }
  }

  async function renewClaim({
    ownerId,
    claims,
    leaseMs = DEFAULT_LEASE_MS,
    presentation = null,
  }: RenewClaimInput): Promise<CortexDeliveryLike[]> {
    const renewedAt = now();
    const leaseExpiresAt = new Date(
      renewedAt.getTime() + Math.max(1000, Number(leaseMs) || DEFAULT_LEASE_MS),
    );
    let exactPresentation: PresentationLeaseFence | null = null;
    if (presentation) {
      const normalizedClaims = (Array.isArray(claims) ? claims : []).map(normalizeClaim);
      const currentRows = await readClaimRows(normalizeText(ownerId), normalizedClaims);
      const liveRows = currentRows.filter((row) => hasLivePresentationLease(row, renewedAt));
      const liveTokens = new Set(liveRows.map((row) => normalizeText(row.presentationLeaseToken)));
      const reusable =
        liveRows.length === currentRows.length &&
        liveTokens.size === 1 &&
        currentRows.every((row) => {
          const claim = normalizedClaims.find((item) => item.deliveryId === row.deliveryId);
          return (
            claim &&
            normalizeText(row.presentationLeaseOwnerId) === normalizeText(ownerId) &&
            normalizeText(row.presentationLeaseClaimToken) === claim.claimToken &&
            Number(row.presentationLeaseGeneration) === claim.claimGeneration
          );
        });
      if (liveRows.length > 0 && !reusable) {
        throw settlementConflictError('Cortex insight presentation lease is owned elsewhere');
      }
      exactPresentation = {
        ...presentation,
        ownerId: normalizeText(ownerId),
        token: reusable ? [...liveTokens][0] : `cipl_${randomUUID()}`,
        expiresAt: leaseExpiresAt,
      };
    }
    const renewed = await runAtomicClaimBatch({
      ownerId,
      claims,
      descriptor: { type: 'renew', renewedAt, leaseExpiresAt, presentation: exactPresentation },
      operation: async ({ claims: normalizedClaims, beforeRows, changedIds, session }) => {
        if (exactPresentation) {
          assertPresentationFenceRows(beforeRows, normalizedClaims, exactPresentation, renewedAt);
        }
        const renewed: CortexDeliveryLike[] = [];
        for (const claim of normalizedClaims) {
          const row = await renewOne({
            ownerId,
            claim,
            renewedAt,
            leaseExpiresAt,
            presentationLease: exactPresentation,
            session,
          });
          changedIds.add(claim.deliveryId);
          renewed.push(row);
        }
        return renewed;
      },
    });
    return assertExactClaimSettlement(claims, renewed);
  }

  async function fencePresentation({
    ownerId,
    claims,
    surface,
    parentMessageId = '',
    persistedMessageId,
    messageRevision = 1,
    leaseMs = DEFAULT_PRESENTATION_LEASE_MS,
  }: FencePresentationInput): Promise<FencePresentationResult> {
    const normalizedClaims = (Array.isArray(claims) ? claims : []).map(normalizeClaim);
    const normalizedSurface = normalizeSurface(surface);
    const normalizedMessageId = normalizeText(persistedMessageId);
    const revision = Math.max(1, Number(messageRevision) || 1);
    const renewed = await renewClaim({
      ownerId,
      claims: normalizedClaims,
      leaseMs,
      presentation: {
        surface: normalizedSurface,
        parentMessageId: normalizeText(parentMessageId),
        persistedMessageId: normalizedMessageId,
        messageRevision: revision,
      },
    });
    const generations = new Set(renewed.map((row) => Number(row?.claimGeneration)));
    const claimTokens = new Set(renewed.map((row) => normalizeText(row?.claimToken)));
    const presentationLeaseTokens = new Set(
      renewed.map((row) => normalizeText(row?.presentationLeaseToken)),
    );
    const deliveryReceipts = renewed
      .map((row) => ({
        deliveryId: normalizeText(row?.deliveryId),
        graphResultHash: normalizeText(row?.graphResultHash),
      }))
      .sort((left, right) => left.deliveryId.localeCompare(right.deliveryId));
    if (generations.size !== 1 || !Number.isSafeInteger([...generations][0])) {
      throw settlementConflictError('Cortex insight presentation fence generation is invalid');
    }
    if (
      claimTokens.size !== 1 ||
      claimTokens.has('') ||
      presentationLeaseTokens.size !== 1 ||
      presentationLeaseTokens.has('')
    ) {
      throw settlementConflictError('Cortex insight presentation lease identity is invalid');
    }
    if (
      deliveryReceipts.length !== renewed.length ||
      deliveryReceipts.some(
        (receipt) => !receipt.deliveryId || !/^[a-f0-9]{64}$/.test(receipt.graphResultHash),
      )
    ) {
      throw settlementConflictError('Cortex insight graph-result receipt identity is invalid');
    }
    const generation = onlySetValue(
      generations,
      'Cortex insight presentation fence generation is invalid',
    );
    const claimToken = onlySetValue(
      claimTokens,
      'Cortex insight presentation lease identity is invalid',
    );
    const presentationLeaseToken = onlySetValue(
      presentationLeaseTokens,
      'Cortex insight presentation lease identity is invalid',
    );
    return {
      ownerId: normalizeText(ownerId),
      claims: renewed.map((row) => ({
        deliveryId: normalizeText(row.deliveryId),
        claimToken: normalizeText(row.claimToken),
        claimGeneration: Number(row.claimGeneration),
        graphResultHash: normalizeText(row.graphResultHash),
        attemptNumber: Number(row.attemptNumber) || 0,
        presentationLeaseToken: normalizeText(row.presentationLeaseToken),
      })),
      deliveryIds: renewed.map((row) => normalizeText(row.deliveryId)).sort(),
      deliveryReceipts,
      generation,
      claimToken,
      presentationLeaseToken,
      messageId: normalizedMessageId,
      parentMessageId: normalizeText(renewed[0]?.parentMessageId || parentMessageId),
      revision,
      surface: normalizedSurface,
    };
  }

  async function fencePresentationByParent({
    ownerId,
    parentMessageId,
    surface,
    persistedMessageId,
    messageRevision = 1,
    expectedDeliveryIds = [],
    expectedGeneration = 0,
    leaseMs = DEFAULT_PRESENTATION_LEASE_MS,
  }: FencePresentationByParentInput): Promise<FencePresentationResult> {
    const liveClaims = await liveClaimsByParent({ ownerId, parentMessageId });
    const normalizedExpectedIds = [
      ...new Set(
        (Array.isArray(expectedDeliveryIds) ? expectedDeliveryIds : []).map(normalizeText),
      ),
    ]
      .filter(Boolean)
      .sort();
    const liveIds = liveClaims.map((row) => normalizeText(row.deliveryId)).sort();
    const expectedGenerationNumber = Number(expectedGeneration);
    const liveGenerations = new Set(liveClaims.map((row) => Number(row.claimGeneration)));
    if (
      liveClaims.length === 0 ||
      liveGenerations.size !== 1 ||
      (normalizedExpectedIds.length > 0 &&
        (normalizedExpectedIds.length !== liveIds.length ||
          normalizedExpectedIds.some((deliveryId, index) => deliveryId !== liveIds[index]))) ||
      (Number.isSafeInteger(expectedGenerationNumber) &&
        expectedGenerationNumber > 0 &&
        onlySetValue(liveGenerations, 'Cortex insight presentation fence is stale') !==
          expectedGenerationNumber)
    ) {
      throw settlementConflictError('Cortex insight presentation fence is stale');
    }
    const fenced = await fencePresentation({
      ownerId,
      claims: liveClaims,
      surface,
      parentMessageId,
      persistedMessageId,
      messageRevision,
      leaseMs,
    });
    return { ...fenced, parentMessageId: normalizeText(parentMessageId) };
  }

  async function listRecoverableParents({ limit = 100 }: ListRecoverableParentsInput = {}) {
    await repairIncompleteBatches({ limit });
    const checkedAt = now();
    const pageLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const query = DeliveryModel.find(recoverableFilter(checkedAt));
    const sorted = query?.sort ? query.sort({ createdAt: 1, deliveryId: 1 }) : query;
    const limited = sorted?.limit ? sorted.limit(pageLimit) : sorted;
    const rows = (await leanResult(limited)) || [];
    const seen = new Set<string>();
    return rows
      .filter((row) => {
        const key = JSON.stringify([normalizeText(row.userId), normalizeText(row.parentMessageId)]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((row) => ({
        ownerId: normalizeText(row.userId),
        conversationId: normalizeText(row.conversationId),
        parentMessageId: normalizeText(row.parentMessageId),
        surface: normalizeSurface(row.surface),
      }));
  }

  async function deferRecoverableParent({
    ownerId,
    parentMessageId,
    surface,
    reason = 'recovery_claim_failed',
  }: DeferRecoverableParentInput) {
    const userId = normalizeText(ownerId);
    const normalizedParentMessageId = normalizeText(parentMessageId);
    const normalizedReason = normalizeText(reason);
    if (!userId || !normalizedParentMessageId) {
      throw new Error('Cortex recovery deferral requires owner and parent');
    }
    if (!RECOVERY_DEFERRAL_REASONS.some((value) => value === normalizedReason)) {
      throw new Error('Unsupported cortex recovery deferral reason');
    }
    const deferredAt = now();
    const filter = {
      userId,
      parentMessageId: normalizedParentMessageId,
      ...recoverableFilter(deferredAt),
    };
    const candidateQuery = selectPrivate(DeliveryModel.findOne(filter));
    const sortedCandidate = candidateQuery?.sort
      ? candidateQuery.sort({ createdAt: 1, deliveryId: 1 })
      : candidateQuery;
    const candidate = await leanResult(sortedCandidate);
    if (!candidate) {
      return { deferred: 0, reason: normalizedReason, retryEligibleAt: null };
    }
    const recoveryAttemptNumber = Math.min(
      MAX_RECOVERY_ATTEMPT_NUMBER,
      Math.max(0, Number(candidate.recoveryAttemptNumber) || 0) + 1,
    );
    const backoffMs = Math.min(
      MAX_RECOVERY_BACKOFF_MS,
      MIN_RECOVERY_BACKOFF_MS * 2 ** Math.min(recoveryAttemptNumber - 1, 6),
    );
    const retryEligibleAt = new Date(deferredAt.getTime() + backoffMs);
    const result = await DeliveryModel.updateMany(
      filter,
      {
        $set: { recoveryAttemptNumber, recoveryEligibleAt: retryEligibleAt },
        $push: {
          events: eventRecord({
            transition: 'recovery_deferred',
            attemptNumber: Number(candidate.attemptNumber) || 0,
            claimToken: candidate.claimToken || '',
            claimGeneration: Number(candidate.claimGeneration) || 0,
            eventAt: deferredAt,
            reason: normalizedReason,
            surface: normalizeSurface(surface || candidate.surface),
            runtimeSlot: normalizedRuntimeSlot,
            runtimeEpoch: normalizedRuntimeEpoch,
            recoveryAttemptNumber,
            retryEligibleAt,
          }),
        },
      },
      { runValidators: true },
    );
    return {
      deferred: Number(result?.modifiedCount ?? result?.nModified ?? 0),
      reason: normalizedReason,
      recoveryAttemptNumber,
      retryEligibleAt,
    };
  }

  async function liveClaimsByParent({
    ownerId,
    parentMessageId,
  }: OwnerParentInput): Promise<CortexDeliveryLike[]> {
    const checkedAt = now();
    const query = selectPrivate(
      DeliveryModel.find({
        userId: normalizeText(ownerId),
        parentMessageId: normalizeText(parentMessageId),
        status: 'claimed',
        leaseExpiresAt: { $gt: checkedAt },
      }),
    );
    const rows = (await leanResult(query)) || [];
    assertExactCompleteClaimBatch(rows);
    return rows.map((row) => redactDelivery(row, { includeClaim: true }));
  }

  async function markPresentationByParent({
    ownerId,
    parentMessageId,
    surface,
    persistedMessageId = '',
    messageRevision = 1,
    presentationGeneration = 0,
    presentationClaimToken = '',
    presentationRef,
    expectedDeliveryIds = [],
    expectedDeliveryReceipts = [],
    expectedPresentationLeaseToken = '',
  }: MarkPresentationByParentInput): Promise<CortexDeliveryLike[]> {
    const normalizedSurface = normalizeSurface(surface);
    const normalizedGeneration = Math.max(0, Number(presentationGeneration) || 0);
    const normalizedClaimToken = normalizeText(presentationClaimToken);
    if (normalizedGeneration < 1 || !normalizedClaimToken) {
      throw settlementConflictError('Cortex insight presentation generation is unavailable');
    }
    const normalizedExpectedIds = [
      ...new Set(
        (Array.isArray(expectedDeliveryIds) ? expectedDeliveryIds : []).map(normalizeText),
      ),
    ]
      .filter(Boolean)
      .sort();
    const normalizedExpectedReceipts = (
      Array.isArray(expectedDeliveryReceipts) ? expectedDeliveryReceipts : []
    )
      .map((receipt) => ({
        deliveryId: normalizeText(receipt?.deliveryId),
        graphResultHash: normalizeText(receipt?.graphResultHash),
      }))
      .sort((left, right) => left.deliveryId.localeCompare(right.deliveryId));
    const normalizedExpectedLeaseToken = normalizeText(expectedPresentationLeaseToken);

    await claimPendingByParent({ ownerId, parentMessageId, surface: normalizedSurface });
    const claims = await liveClaimsByParent({ ownerId, parentMessageId });
    if (claims.length === 0) {
      if (
        normalizedExpectedIds.length === 0 ||
        normalizedExpectedReceipts.length !== normalizedExpectedIds.length ||
        !normalizedExpectedLeaseToken ||
        !normalizeText(persistedMessageId) ||
        !normalizeText(presentationRef)
      ) {
        throw settlementConflictError('Cortex insight presentation has no current live claims');
      }
      const query = selectPrivate(
        DeliveryModel.find({
          userId: normalizeText(ownerId),
          parentMessageId: normalizeText(parentMessageId),
          status: 'sent',
        }),
      );
      const terminalRows = ((await leanResult(query)) || []).sort((left, right) =>
        normalizeText(left.deliveryId).localeCompare(normalizeText(right.deliveryId)),
      );
      const receiptsById = new Map(
        normalizedExpectedReceipts.map((receipt) => [receipt.deliveryId, receipt]),
      );
      const exactReplay =
        terminalRows.length === normalizedExpectedIds.length &&
        terminalRows.every((row, index) => {
          const deliveryId = normalizeText(row.deliveryId);
          const expectedReceipt = receiptsById.get(deliveryId);
          const graphResultHash = normalizeText(row.graphResultHash);
          const receiptHash = presentationReceiptHash({
            surface: normalizedSurface,
            persistedMessageId,
            messageRevision,
            presentationRef,
            presentationClaimToken: normalizedClaimToken,
            claimGeneration: normalizedGeneration,
            graphResultHash,
            presentationLeaseToken: normalizedExpectedLeaseToken,
          });
          return (
            deliveryId === normalizedExpectedIds[index] &&
            expectedReceipt?.graphResultHash === graphResultHash &&
            /^[a-f0-9]{64}$/.test(graphResultHash) &&
            normalizeText(row.persistedMessageId) === normalizeText(persistedMessageId) &&
            presentationRevisionOf(row) === Math.max(1, Number(messageRevision) || 1) &&
            Number(row.claimGeneration) === normalizedGeneration &&
            Array.isArray(row.requiredSurfaces) &&
            row.requiredSurfaces.includes(normalizedSurface) &&
            Array.isArray(row.presentedSurfaces) &&
            row.presentedSurfaces.includes(normalizedSurface) &&
            Array.isArray(row.presentationReceiptHashes) &&
            row.presentationReceiptHashes.includes(receiptHash) &&
            Array.isArray(row.events) &&
            row.events.some(
              (event) =>
                event?.transition === 'presented' &&
                normalizeSurface(event?.surface) === normalizedSurface &&
                normalizeText(event?.claimToken) === normalizedClaimToken &&
                Number(event?.claimGeneration) === normalizedGeneration &&
                normalizeText(event?.receiptHash) === receiptHash,
            )
          );
        });
      if (!exactReplay) {
        throw settlementConflictError('Cortex insight terminal presentation replay did not match');
      }
      return terminalRows.map((row) => redactDelivery(row));
    }
    const claimIds = claims.map((claim) => normalizeText(claim.deliveryId)).sort();
    const claimReceipts = claims
      .map((claim) => ({
        deliveryId: normalizeText(claim.deliveryId),
        graphResultHash: normalizeText(claim.graphResultHash),
      }))
      .sort((left, right) => left.deliveryId.localeCompare(right.deliveryId));
    if (
      normalizedExpectedIds.length > 0 &&
      (normalizedExpectedIds.length !== claimIds.length ||
        normalizedExpectedIds.some((deliveryId, index) => deliveryId !== claimIds[index]))
    ) {
      throw settlementConflictError('Cortex insight presentation delivery batch did not match');
    }
    if (
      normalizedExpectedReceipts.length > 0 &&
      (normalizedExpectedReceipts.length !== claimReceipts.length ||
        normalizedExpectedReceipts.some(
          (receipt, index) =>
            receipt.deliveryId !== claimReceipts[index].deliveryId ||
            receipt.graphResultHash !== claimReceipts[index].graphResultHash ||
            !/^[a-f0-9]{64}$/.test(receipt.graphResultHash),
        ))
    ) {
      throw settlementConflictError('Cortex insight graph-result receipt did not match');
    }
    const eligible = claims.filter(
      (claim) =>
        claim.persistenceStatus === 'persisted' &&
        claim.claimGeneration === normalizedGeneration &&
        normalizeText(claim.claimToken) === normalizedClaimToken &&
        (!persistedMessageId || claim.persistedMessageId === normalizeText(persistedMessageId)) &&
        Array.isArray(claim.requiredSurfaces) &&
        claim.requiredSurfaces.includes(normalizedSurface),
    );
    if (eligible.length !== claims.length) {
      throw settlementConflictError('Cortex insight presentation does not match every live claim');
    }
    const firstEligible = eligible[0];
    if (!firstEligible) {
      throw settlementConflictError('Cortex insight presentation has no eligible claims');
    }
    const presentationFence = await fencePresentation({
      ownerId,
      claims: eligible,
      surface: normalizedSurface,
      parentMessageId,
      persistedMessageId: normalizeText(persistedMessageId) || firstEligible.persistedMessageId,
      messageRevision: Number(messageRevision) || presentationRevisionOf(firstEligible),
    });
    if (
      normalizedExpectedLeaseToken &&
      normalizeText(presentationFence.presentationLeaseToken) !== normalizedExpectedLeaseToken
    ) {
      throw settlementConflictError('Cortex insight presentation lease binding did not match');
    }
    const settled = await markPresented({
      ownerId,
      claims: presentationFence.claims,
      surface: normalizedSurface,
      persistedMessageId: normalizeText(persistedMessageId) || firstEligible.persistedMessageId,
      messageRevision: Number(messageRevision) || presentationRevisionOf(firstEligible),
      presentationGeneration: normalizedGeneration,
      presentationClaimToken: presentationFence.claimToken,
      presentationLeaseToken: presentationFence.presentationLeaseToken,
      presentationRef,
    });
    return assertExactClaimSettlement(presentationFence.claims, settled);
  }

  async function markPresentationFailedByParent({
    ownerId,
    parentMessageId,
  }: OwnerParentInput): Promise<CortexDeliveryLike[]> {
    const claims = await liveClaimsByParent({ ownerId, parentMessageId });
    if (claims.length === 0) return [];
    return markFailed({ ownerId, claims, reason: 'presentation_failed' });
  }

  async function listByParent({ ownerId, parentMessageId, surface = '' }: ListByParentInput) {
    const filter: DataRecord = {
      userId: normalizeText(ownerId),
      parentMessageId: normalizeText(parentMessageId),
    };
    const normalizedSurface = surface ? normalizeSurface(surface) : '';
    if (normalizedSurface) {
      filter.surface = normalizedSurface;
    }
    const query = DeliveryModel.find(filter, {
      _id: 0,
      deliveryId: 1,
      conversationId: 1,
      parentMessageId: 1,
      cortexId: 1,
      cortexName: 1,
      insightHash: 1,
      graphResultHash: 1,
      surface: 1,
      requiredSurfaces: 1,
      presentedSurfaces: 1,
      status: 1,
      persistenceStatus: 1,
      attemptNumber: 1,
      claimGeneration: 1,
      persistedMessageId: 1,
      persistedAt: 1,
      sourceRevision: 1,
      presentationRevision: 1,
      messageRevision: 1,
      batchId: 1,
      batchSize: 1,
      batchMemberHashes: 1,
      streamId: 1,
      dropReason: 1,
      claimedAt: 1,
      leaseExpiresAt: 1,
      sentAt: 1,
      droppedAt: 1,
    });
    const sorted = query?.sort ? query.sort({ createdAt: 1, deliveryId: 1 }) : query;
    const rows = (await leanResult(sorted)) || [];
    assertExactCompleteClaimBatch(rows);
    return rows.map((row) => {
      const publicRow: Partial<CortexDeliveryRow> = { ...row };
      delete publicRow.batchId;
      delete publicRow.batchSize;
      delete publicRow.batchMemberHashes;
      delete publicRow.streamId;
      delete publicRow.insightHash;
      delete publicRow.graphResultHash;
      return publicRow;
    });
  }

  async function listEvents({ ownerId, parentMessageId }: OwnerParentInput) {
    const query = selectPrivate(
      DeliveryModel.find({
        userId: normalizeText(ownerId),
        parentMessageId: normalizeText(parentMessageId),
      }),
    );
    const sorted = query?.sort ? query.sort({ createdAt: 1, deliveryId: 1 }) : query;
    const rows = (await leanResult(sorted)) || [];
    return rows.flatMap((row) =>
      (Array.isArray(row.events) ? row.events : []).map((event) => ({
        deliveryId: row.deliveryId,
        cortexId: row.cortexId,
        transition: event.transition,
        attemptNumber: event.attemptNumber,
        claimToken: event.claimToken,
        claimGeneration: event.claimGeneration,
        eventAt: event.eventAt,
        claimedAt: event.claimedAt,
        leaseExpiresAt: event.leaseExpiresAt,
        reason: event.reason,
        surface: event.surface,
        receiptHash: event.receiptHash,
        recoveryAttemptNumber: event.recoveryAttemptNumber,
        retryEligibleAt: event.retryEligibleAt,
      })),
    );
  }

  return {
    claimBatch,
    claimPendingByParent,
    deferRecoverableParent,
    fencePresentation,
    fencePresentationByParent,
    finalizePresented,
    listRecoverableParents,
    repairIncompleteBatches,
    listByParent,
    listEvents,
    markDropped,
    markFailed,
    markPersisted,
    markPresented,
    markPresentationByParent,
    markPresentationFailedByParent,
    markSent,
    recordBatch,
    renewClaim,
  };
}
