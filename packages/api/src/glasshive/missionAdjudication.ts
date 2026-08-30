/* === VIVENTIUM START ===
 * Feature: Main-authored GlassHive mission adjudication.
 * Purpose:
 * - Keep worker callbacks as neutral lifecycle/status events.
 * - Persist terminal worker evidence before acknowledgement.
 * - Coalesce terminal evidence for two seconds per account, then feed it into the existing
 *   configured Main/Phase-B follow-up machinery. Semantic {NTA}/redundancy may stay silent, but a
 *   useful mission result is not discarded merely because presentation moved to a newer turn.
 * - Leave a restart-safe pending/failed ledger that can be reconciled without replaying prose.
 * === VIVENTIUM END === */

import * as crypto from 'crypto';

import type { Logger } from 'winston';
import type { ClientSession, Model } from 'mongoose';
import type { Document } from 'mongodb';
import type { IGlassHiveTerminalCallbackResult } from '@librechat/data-schemas';
import type {
  VoiceWorkerCompletionPresentationV1,
  BuildVoiceWorkerCompletionPresentationInput,
} from '../trace/voiceWorkerCompletionTrace';
import type { GlassHiveTerminalCallbackAcceptedOperationReference } from '@librechat/data-schemas';

/** Internal Mongo/API records are schema-validated at their owning ingress before this service. */
type RuntimeRecord = Document;
type RuntimeError = Error & { code?: string; name: string };
type RuntimeOperation<T> = () => T | Promise<T>;
type MissionMongoose = typeof import('mongoose') & {
  transactionAsyncLocalStorage?: {
    getStore: () => { session?: ClientSession } | undefined;
  };
};

interface PersistedTerminalCallbackReference
  extends GlassHiveTerminalCallbackAcceptedOperationReference {
  generation: number;
}

export interface GlassHiveMissionDestination {
  surface?: string;
  telegramChatId?: string;
  telegramUserId?: string;
  telegramMessageId?: string;
  voiceCallSessionId?: string;
  voiceRequestId?: string;
  unresolvedReason?: string;
}

export interface GlassHiveMissionTraceIdentity {
  callbackRef?: string;
  callbackEvent?: string;
  event?: string;
  workState?: string;
  state?: string;
  workTerminal?: boolean;
  attemptNumber?: number | null;
}

export interface GlassHiveMissionBinding {
  originRef?: string;
  ownerId?: string;
  conversationId?: string;
  anchorMessageId?: string;
  workRef?: string;
  mainAgentId?: string;
  destinations?: readonly GlassHiveMissionDestination[];
  traceIdentity?: GlassHiveMissionTraceIdentity;
}

export interface GlassHiveMissionCallbackBody {
  callback_id?: string;
  origin_ref?: string;
  work_ref?: string;
  worker_id?: string;
  run_id?: string;
  event?: string;
  callback_ts?: string;
  work_state?: string;
  work_terminal?: boolean;
  full_message?: string;
  message?: string;
  failure_code?: string;
  failure_class?: string;
  error_code?: string;
  error?: { code?: string };
}

export interface GlassHiveTerminalEffectFence {
  resultKey?: string;
  acceptedOperationId?: string;
  callbackId?: string;
  resultDigest?: string;
  resultRevision?: number;
  acceptedOperationGeneration?: number;
  generation?: number;
}

export interface GlassHiveMissionAdjudicationInput {
  binding?: GlassHiveMissionBinding;
  body?: GlassHiveMissionCallbackBody;
  effectFence?: GlassHiveTerminalEffectFence;
  effectSession?: ClientSession;
}

export interface GlassHiveMissionEvidence {
  _id: string;
  evidenceId: string;
  originRef: string;
  workRef: string;
  workerId: string;
  runId: string;
  event: string;
  workState: string;
  workTerminal: boolean;
  ownerId: string;
  conversationId: string;
  anchorMessageId: string;
  mainAgentId: string;
  surface: string;
  destinations: GlassHiveMissionDestination[];
  evidence: string;
  state: string;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface GlassHiveMissionLimitInput {
  ownerId?: string;
  limit?: number;
}

export interface GlassHiveMissionFlushSummary {
  claimed: number;
  groups: number;
  visible: number;
  silent: number;
  failed: number;
}

export interface GlassHiveMissionRedriveSummary {
  scanned: number;
  redriven: number;
  skipped: number;
  failed: number;
}

export interface GlassHiveMissionReconciliationSummary {
  rows: number;
  owners: number;
}

export interface GlassHiveMissionAdjudicationService {
  COALESCE_MS: number;
  clearAdjudicationTimersForTests: () => void;
  enqueueGlassHiveMissionAdjudication: (
    input?: GlassHiveMissionAdjudicationInput,
  ) => Promise<GlassHiveMissionEvidence | null>;
  flushGlassHiveMissionAdjudications: (
    input?: GlassHiveMissionLimitInput,
  ) => Promise<GlassHiveMissionFlushSummary>;
  persistGlassHiveMissionEvidence: (
    input?: GlassHiveMissionAdjudicationInput,
  ) => Promise<GlassHiveMissionEvidence | null>;
  redriveLegacyDeletedOriginMissionAdjudications: (
    input?: Pick<GlassHiveMissionLimitInput, 'limit'>,
  ) => Promise<GlassHiveMissionRedriveSummary>;
  reconcilePendingGlassHiveMissionAdjudications: (
    input?: Pick<GlassHiveMissionLimitInput, 'limit'>,
  ) => Promise<GlassHiveMissionReconciliationSummary>;
}

interface MissionUser {
  _id?: object | string;
  id?: string;
  role?: string;
  toObject?: () => object;
}

interface MissionAgent {
  id?: string;
  model?: string;
}

interface MissionFollowUp {
  messageId: string;
  text: string;
}

interface CallbackDeliverySummary {
  configured?: number;
  enqueued?: number;
  unresolved?: number;
  deferredToMain?: boolean;
}

export interface GlassHiveMissionAdjudicationDependencies {
  mongoose: MissionMongoose;
  logger: Pick<Logger, 'info' | 'warn'>;
  buildVoiceWorkerCompletionPresentation: (
    input: BuildVoiceWorkerCompletionPresentationInput,
  ) => VoiceWorkerCompletionPresentationV1;
  fenceGlassHiveTerminalCallbackAcceptedOperation: (input: {
    ResultModel: Model<IGlassHiveTerminalCallbackResult>;
    reference: GlassHiveTerminalCallbackAcceptedOperationReference;
    session: ClientSession;
  }) => Promise<boolean>;
  getConvo: (
    ownerId: string,
    conversationId: string,
    lookupField: 'conversationId',
  ) => Promise<object | null>;
  getUserById: (ownerId: string, projection: string) => Promise<MissionUser | null>;
  saveConvo: (
    request: object,
    conversation: object,
    options: { context: string },
  ) => Promise<{ message?: string } | null>;
  getAgent: (input: { id: string }) => Promise<MissionAgent | null>;
  getAppConfig: (input: { role?: string }) => Promise<object>;
  createCortexFollowUpMessage: (input: object) => Promise<MissionFollowUp>;
  isGlassHiveWorkTerminalCallback: (body: GlassHiveMissionCallbackBody) => boolean;
  recordGlassHiveAdjudicationOutcome: (input: object) => Promise<object | null>;
  recordOrchestrationTraceDelivery: (input: object) => Promise<object | null>;
  getActiveCallSessionForConversation: (input: {
    userId: string;
    conversationId: string;
  }) => Promise<{ callSessionId?: string } | null>;
  sanitizeGlassHiveCallbackText: (value: string | undefined, options: { maxLength: number }) => string;
  deferGlassHiveTerminalCallbackAfterCommit: (operation: () => void) => boolean;
  runGlassHiveTerminalCallbackTransaction: <T>(
    operation: (session: ClientSession) => T | Promise<T>,
  ) => Promise<T>;
  enqueueGlassHiveCallbackDelivery: (input: object) => Promise<CallbackDeliverySummary>;
  getTerminalCallbackResultModel: () => Model<IGlassHiveTerminalCallbackResult>;
}

export function createGlassHiveMissionAdjudicationService(
  dependencies: GlassHiveMissionAdjudicationDependencies,
): GlassHiveMissionAdjudicationService {
  const {
    mongoose,
    logger,
    buildVoiceWorkerCompletionPresentation,
    fenceGlassHiveTerminalCallbackAcceptedOperation,
    getConvo,
    getUserById,
    saveConvo,
    getAgent,
    getAppConfig,
    createCortexFollowUpMessage,
    isGlassHiveWorkTerminalCallback,
    recordGlassHiveAdjudicationOutcome,
    recordOrchestrationTraceDelivery,
    getActiveCallSessionForConversation,
    sanitizeGlassHiveCallbackText,
    deferGlassHiveTerminalCallbackAfterCommit,
    runGlassHiveTerminalCallbackTransaction,
    enqueueGlassHiveCallbackDelivery,
    getTerminalCallbackResultModel,
  } = dependencies;

const COLLECTION = 'viventium_glasshive_mission_evidence';
const COALESCE_MS = 2000;
const MAX_EVIDENCE_CHARS = 64_000;
const MAX_ADJUDICATION_ATTEMPTS = 10;
const LEGACY_DELIVERY_PARENT_REDRIVE_VERSION = 1;
const NO_PARENT_MESSAGE_ID = '00000000-0000-0000-0000-000000000000';
const ownerTimers = new Map<string, ReturnType<typeof setTimeout>>();
const ownerFlushes = new Map<string, Promise<RuntimeRecord>>();
const ownerReschedules = new Set<string>();

function terminalCallbackResultModel(): Model<IGlassHiveTerminalCallbackResult> {
  return getTerminalCallbackResultModel();
}

function collection(): RuntimeRecord {
  const target = mongoose.connection.collection(COLLECTION);
  const session = mongoose.transactionAsyncLocalStorage?.getStore()?.session;
  if (!session) return target;
  return {
    find: (filter: RuntimeRecord, options: RuntimeRecord = {}) =>
      target.find(filter, { ...options, session }),
    findOne: (filter: RuntimeRecord, options: RuntimeRecord = {}) =>
      target.findOne(filter, { ...options, session }),
    findOneAndUpdate: (
      filter: RuntimeRecord,
      update: RuntimeRecord,
      options: RuntimeRecord = {},
    ) =>
      target.findOneAndUpdate(filter, update, { ...options, session }),
    updateOne: (filter: RuntimeRecord, update: RuntimeRecord, options: RuntimeRecord = {}) =>
      target.updateOne(filter, update, { ...options, session }),
  };
}

function safeText(value: unknown, maxLength = 512): string {
  return String(value || '')
    .trim()
    .slice(0, maxLength);
}

function timestamp(value: unknown): number | null {
  if (value == null || value === '') return null;
  const result = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(result) ? result : null;
}

function legacyEvidenceId(body: GlassHiveMissionCallbackBody = {}): string {
  const callbackId = safeText(body.callback_id, 160);
  if (callbackId) return callbackId;
  return `ghe_${crypto
    .createHash('sha256')
    .update(
      [body.origin_ref, body.work_ref, body.worker_id, body.run_id, body.event, body.callback_ts]
        .map((value) => safeText(value, 4096))
        .join('\0'),
    )
    .digest('hex')
    .slice(0, 32)}`;
}

function evidenceId({
  ownerId,
  originRef,
  body = {},
}: {
  ownerId: string;
  originRef: string;
  body?: GlassHiveMissionCallbackBody;
}): string {
  // A GlassHive callback id is stable within its producer, but it is not a global tenant-scoped
  // identity. Hash it with the verified Core owner/origin so one tenant cannot suppress another
  // tenant's terminal evidence by reusing the same vendor callback id.
  return `ghe_${crypto
    .createHash('sha256')
    .update([safeText(ownerId, 160), safeText(originRef, 160), legacyEvidenceId(body)].join('\0'))
    .digest('hex')
    .slice(0, 32)}`;
}

function terminalEvidence(body: GlassHiveMissionCallbackBody = {}): string {
  const event = safeText(body.event, 64);
  if (!['run.completed', 'run.failed'].includes(event)) return '';
  if (!isGlassHiveWorkTerminalCallback(body)) return '';
  const full = sanitizeGlassHiveCallbackText(body.full_message, {
    maxLength: MAX_EVIDENCE_CHARS,
  });
  const preview = sanitizeGlassHiveCallbackText(body.message, {
    maxLength: MAX_EVIDENCE_CHARS,
  });
  const text = full || preview;
  if (text) return text;
  if (event === 'run.failed') {
    const code = safeText(
      body.failure_code || body.failure_class || body.error_code || body?.error?.code,
      120,
    );
    return code ? `Mission failed with structured code ${code}.` : 'Mission failed.';
  }
  return 'Mission completed without additional textual evidence.';
}

function normalizedSurface(binding: GlassHiveMissionBinding = {}): string {
  const surfaces = (Array.isArray(binding.destinations) ? binding.destinations : [])
    .map((destination) => safeText(destination?.surface, 32).toLowerCase())
    .filter(Boolean);
  return surfaces.includes('voice') ? 'voice' : surfaces.includes('telegram') ? 'telegram' : 'web';
}

function safeDestinations(binding: GlassHiveMissionBinding = {}): GlassHiveMissionDestination[] {
  return (Array.isArray(binding.destinations) ? binding.destinations : [])
    .filter((destination) => ['telegram', 'voice'].includes(safeText(destination?.surface, 32)))
    .map((destination) => ({
      surface: safeText(destination.surface, 32),
      telegramChatId: safeText(destination.telegramChatId, 160),
      telegramUserId: safeText(destination.telegramUserId, 160),
      telegramMessageId: safeText(destination.telegramMessageId, 160),
      voiceCallSessionId: safeText(destination.voiceCallSessionId, 160),
      voiceRequestId: safeText(destination.voiceRequestId, 160),
      unresolvedReason: safeText(destination.unresolvedReason, 120),
    }));
}

function exactTraceIdentity(value: RuntimeRecord = {}): RuntimeRecord | null {
  const callbackRef = safeText(value.callbackRef, 96);
  const event = safeText(value.event || value.callbackEvent, 64).toLowerCase();
  const workState = safeText(value.workState || value.state, 32).toLowerCase();
  const preRuntimeTerminal =
    value.attemptNumber == null &&
    value.workTerminal === true &&
    ['failed', 'cancelled'].includes(workState) &&
    ['run.failed', 'run.cancelled', 'run.interrupted'].includes(event);
  const attemptNumber = preRuntimeTerminal ? null : Number(value.attemptNumber);
  if (
    !/^callback_sha256:[a-f0-9]{64}$/.test(callbackRef) ||
    (!preRuntimeTerminal && (!Number.isSafeInteger(attemptNumber) || Number(attemptNumber) < 1))
  ) {
    return null;
  }
  return Object.freeze({ callbackRef, attemptNumber });
}

function terminalCallbackReference(
  effectFence?: GlassHiveTerminalEffectFence | null,
): PersistedTerminalCallbackReference | null {
  if (!effectFence) return null;
  const reference = {
    resultKey: safeText(effectFence.resultKey, 80),
    acceptedOperationId: safeText(effectFence.acceptedOperationId, 64),
    callbackId: safeText(effectFence.callbackId, 80),
    resultDigest: safeText(effectFence.resultDigest, 80),
    resultRevision: Number(effectFence.resultRevision),
    generation: Number(effectFence.acceptedOperationGeneration ?? effectFence.generation),
  };
  if (
    !/^ghtr_[a-f0-9]{64}$/.test(reference.resultKey) ||
    !/^[a-f0-9]{32}$/.test(reference.acceptedOperationId) ||
    !/^cb_terminal_[a-f0-9]{64}$/.test(reference.callbackId) ||
    !/^sha256:[a-f0-9]{64}$/.test(reference.resultDigest) ||
    !Number.isSafeInteger(reference.resultRevision) ||
    reference.resultRevision < 1 ||
    !Number.isSafeInteger(reference.generation) ||
    reference.generation < 1
  ) {
    throw Object.assign(new Error('glasshive_callback_effect_fence_invalid'), {
      code: 'glasshive_callback_effect_fenced',
    });
  }
  return reference;
}

function persistedTerminalCallbackReference(
  row: RuntimeRecord,
): PersistedTerminalCallbackReference | null {
  if (!safeText(row?.terminalCallbackResultKey, 80)) return null;
  return terminalCallbackReference({
    resultKey: row.terminalCallbackResultKey,
    acceptedOperationId: row.terminalCallbackAcceptedOperationId,
    callbackId: row.terminalCallbackId,
    resultDigest: row.terminalCallbackResultDigest,
    resultRevision: row.terminalCallbackResultRevision,
    generation: row.terminalCallbackEffectGeneration,
  });
}

async function fenceMissionReferences(rows: RuntimeRecord[], session: ClientSession): Promise<void> {
  const references = new Map<string, PersistedTerminalCallbackReference>();
  for (const row of rows) {
    const current = persistedTerminalCallbackReference(row);
    if (current) references.set(current.resultKey, current);
  }
  for (const current of references.values()) {
    const accepted = await fenceGlassHiveTerminalCallbackAcceptedOperation({
      ResultModel: terminalCallbackResultModel(),
      reference: current,
      session,
    });
    if (!accepted) {
      throw Object.assign(new Error('glasshive_mission_evidence_superseded'), {
        code: 'glasshive_mission_evidence_superseded',
      });
    }
  }
}

async function runFencedMissionTransaction<T>(
  rows: RuntimeRecord[],
  operation: RuntimeOperation<T>,
): Promise<T> {
  if (!rows.some((row) => persistedTerminalCallbackReference(row))) return operation();
  let result: T | undefined;
  await runGlassHiveTerminalCallbackTransaction(async (session: ClientSession) => {
    result = await operation();
    await fenceMissionReferences(rows, session);
  });
  return result as T;
}

async function persistGlassHiveMissionEvidence({
  binding,
  body = {},
  effectFence,
  effectSession,
}: GlassHiveMissionAdjudicationInput = {}): Promise<GlassHiveMissionEvidence | null> {
  const evidence = terminalEvidence(body);
  const originRef = safeText(binding?.originRef || body.origin_ref, 160);
  const ownerId = safeText(binding?.ownerId, 160);
  const conversationId = safeText(binding?.conversationId, 160);
  const anchorMessageId = safeText(binding?.anchorMessageId, 160);
  if (!evidence || !originRef || !ownerId || !conversationId || !anchorMessageId) return null;
  const now = new Date();
  const id = evidenceId({ ownerId, originRef, body });
  const legacyId = legacyEvidenceId(body);
  const traceIdentity = exactTraceIdentity({
    ...binding?.traceIdentity,
    event: body.event,
    workState: body.work_state,
    workTerminal: body.work_terminal === true,
  } as RuntimeRecord);
  const callbackReference = terminalCallbackReference(effectFence);
  const row: GlassHiveMissionEvidence = {
    _id: id,
    evidenceId: id,
    originRef,
    workRef: safeText(binding?.workRef || body.work_ref, 160),
    workerId: safeText(body.worker_id, 160),
    runId: safeText(body.run_id, 160),
    event: safeText(body.event, 64),
    workState: safeText(body.work_state, 32),
    workTerminal: body.work_terminal === true,
    ...(traceIdentity || {}),
    ownerId,
    conversationId,
    anchorMessageId,
    mainAgentId: safeText(binding?.mainAgentId, 160),
    surface: normalizedSurface(binding),
    destinations: safeDestinations(binding),
    evidence,
    state: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    ...(callbackReference
      ? {
          terminalCallbackResultKey: callbackReference.resultKey,
          terminalCallbackAcceptedOperationId: callbackReference.acceptedOperationId,
          terminalCallbackId: callbackReference.callbackId,
          terminalCallbackResultDigest: callbackReference.resultDigest,
          terminalCallbackResultRevision: callbackReference.resultRevision,
          terminalCallbackEffectGeneration: callbackReference.generation,
        }
      : {}),
  };
  await collection().updateOne(
    {
      $or: [
        { _id: id },
        // VIVENTIUM: Reuse a pre-upgrade unscoped row only for the exact verified owner+origin.
        // A bare legacy callback id is never sufficient association or authorization.
        { _id: legacyId, ownerId, originRef },
      ],
    },
    { $setOnInsert: row },
    { upsert: true, ...(effectSession ? { session: effectSession } : {}) },
  );
  return row;
}

function scheduleOwnerAdjudication(ownerId: unknown): void {
  const key = safeText(ownerId, 160);
  if (!key) return;
  if (ownerFlushes.has(key)) {
    ownerReschedules.add(key);
    return;
  }
  if (ownerTimers.has(key)) return;
  const timer = setTimeout(() => {
    ownerTimers.delete(key);
    const flush = Promise.resolve().then(() =>
      flushGlassHiveMissionAdjudications({ ownerId: key }),
    );
    ownerFlushes.set(key, flush);
    flush
      .catch((error: RuntimeError) => {
        logger.warn('[VIVENTIUM][glasshive-adjudication] Account flush failed', {
          code: safeText(error?.code || error?.name || 'flush_failed', 120),
        });
      })
      .finally(() => {
        if (ownerFlushes.get(key) !== flush) return;
        ownerFlushes.delete(key);
        if (ownerReschedules.delete(key)) scheduleOwnerAdjudication(key);
      });
  }, COALESCE_MS);
  timer.unref?.();
  ownerTimers.set(key, timer);
}

async function enqueueGlassHiveMissionAdjudication({
  binding,
  body = {},
  effectFence,
  effectSession,
}: GlassHiveMissionAdjudicationInput = {}): Promise<GlassHiveMissionEvidence | null> {
  const row = await persistGlassHiveMissionEvidence({
    binding,
    body,
    effectFence,
    effectSession,
  });
  if (row) {
    const schedule = () => scheduleOwnerAdjudication(row.ownerId);
    if (!deferGlassHiveTerminalCallbackAfterCommit(schedule)) schedule();
  }
  return row;
}

function coalescingGroupKey(row: RuntimeRecord): string {
  return [
    row.ownerId,
    row.conversationId,
    row.mainAgentId,
    row.surface,
    row.followUpMessageId || 'new',
  ].join('\0');
}

function adjudicationMembershipScopeKey(row: RuntimeRecord): string {
  return [row.ownerId, row.conversationId, row.anchorMessageId, row.surface].join('\0');
}

function groupKey(row: RuntimeRecord): string {
  return safeText(row.adjudicationGroupId, 160) || coalescingGroupKey(row);
}

function sortedGroupMemberIds(rows: RuntimeRecord[]): string[] {
  return rows
    .map((row) => safeText(row._id, 160))
    .filter(Boolean)
    .sort();
}

function exactGroupMembers(row: RuntimeRecord): string[] {
  const values = Array.isArray(row.adjudicationGroupMemberIds)
    ? row.adjudicationGroupMemberIds
        .map((value) => safeText(value, 160))
        .filter(Boolean)
        .sort()
    : [];
  return values.length > 0 && new Set(values).size === values.length ? values : [];
}

function adjudicationGroupId(rows: RuntimeRecord[]): string {
  const members = sortedGroupMemberIds(rows);
  return `ghag_${crypto
    .createHash('sha256')
    .update([coalescingGroupKey(rows[rows.length - 1]), ...members].join('\0'))
    .digest('hex')
    .slice(0, 32)}`;
}

function membershipConflict(): RuntimeError {
  return Object.assign(new Error('mission_adjudication_group_membership_conflict'), {
    code: 'mission_adjudication_group_membership_conflict',
  });
}

async function reconcilePartialGroupPins(pending: RuntimeRecord[]): Promise<void> {
  const declarations = new Map<string, RuntimeRecord>();
  const groupByMemberId = new Map<string, string>();

  for (const row of pending) {
    const id = safeText(row.adjudicationGroupId, 160);
    if (!id) continue;
    const rowId = safeText(row._id, 160);
    const memberIds = exactGroupMembers(row);
    const scope = adjudicationMembershipScopeKey(row);
    const pinnedAt = timestamp(row.adjudicationGroupPinnedAt);
    if (!rowId || !memberIds.includes(rowId)) throw membershipConflict();

    const existing = declarations.get(id);
    if (
      existing &&
      (existing.scope !== scope || JSON.stringify(existing.memberIds) !== JSON.stringify(memberIds))
    ) {
      throw membershipConflict();
    }
    if (!existing) {
      declarations.set(id, {
        id,
        memberIds,
        scope,
        pinnedAt: pinnedAt == null ? null : new Date(pinnedAt),
      });
    } else if (!existing.pinnedAt && pinnedAt != null) {
      existing.pinnedAt = new Date(pinnedAt);
    }
    for (const memberId of memberIds) {
      const claimedBy = groupByMemberId.get(memberId);
      if (claimedBy && claimedBy !== id) throw membershipConflict();
      groupByMemberId.set(memberId, id);
    }
  }

  for (const row of pending) {
    const rowId = safeText(row._id, 160);
    const declaredGroupId = groupByMemberId.get(rowId);
    if (!declaredGroupId) continue;
    const declaration = declarations.get(declaredGroupId);
    if (!declaration) throw membershipConflict();
    if (adjudicationMembershipScopeKey(row) !== declaration.scope) throw membershipConflict();

    const existingGroupId = safeText(row.adjudicationGroupId, 160);
    if (existingGroupId && existingGroupId !== declaredGroupId) throw membershipConflict();
    if (existingGroupId) continue;

    const now = new Date();
    declaration.pinnedAt ||= now;
    const result = await collection().updateOne(
      {
        _id: row._id,
        state: 'pending',
        $or: [{ adjudicationGroupId: { $exists: false } }, { adjudicationGroupId: '' }],
      },
      {
        $set: {
          adjudicationGroupId: declaration.id,
          adjudicationGroupMemberIds: declaration.memberIds,
          adjudicationGroupPinnedAt: declaration.pinnedAt,
          updatedAt: now,
        },
      },
    );
    if (Number.isInteger(result?.matchedCount) && result.matchedCount === 0) {
      const persisted = await collection().findOne(
        { _id: row._id },
        {
          projection: {
            adjudicationGroupId: 1,
            adjudicationGroupMemberIds: 1,
            adjudicationGroupPinnedAt: 1,
          },
        },
      );
      if (
        safeText(persisted?.adjudicationGroupId, 160) !== declaration.id ||
        JSON.stringify(exactGroupMembers(persisted)) !== JSON.stringify(declaration.memberIds)
      ) {
        throw membershipConflict();
      }
    }
    row.adjudicationGroupId = declaration.id;
    row.adjudicationGroupMemberIds = declaration.memberIds;
    row.adjudicationGroupPinnedAt = declaration.pinnedAt;
  }
}

async function pinPendingAdjudicationGroups(pending: RuntimeRecord[]): Promise<RuntimeRecord[]> {
  await reconcilePartialGroupPins(pending);
  const groups = new Map<string, RuntimeRecord[]>();
  for (const row of pending) {
    const key = safeText(row.adjudicationGroupId, 160) || `new:${coalescingGroupKey(row)}`;
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  const prepared: RuntimeRecord[] = [];
  for (const rows of groups.values()) {
    const existingIds = new Set(
      rows.map((row) => safeText(row.adjudicationGroupId, 160)).filter(Boolean),
    );
    if (existingIds.size > 1) throw membershipConflict();
    const existingId = [...existingIds][0] || '';
    const memberIds = sortedGroupMemberIds(rows);
    if (existingId) {
      const declared = rows.map(exactGroupMembers);
      const firstDeclared = declared[0];
      if (
        firstDeclared.length === 0 ||
        declared.some((members) => JSON.stringify(members) !== JSON.stringify(firstDeclared)) ||
        rows.some((row) => !firstDeclared.includes(safeText(row._id, 160)))
      ) {
        throw membershipConflict();
      }
      prepared.push({
        id: existingId,
        rows,
        memberIds: firstDeclared,
        complete: JSON.stringify(memberIds) === JSON.stringify(firstDeclared),
      });
      continue;
    }

    const id = adjudicationGroupId(rows);
    const pinnedAt = new Date();
    await Promise.all(
      rows.map(async (row) => {
        const result = await collection().updateOne(
          {
            _id: row._id,
            state: 'pending',
            $or: [{ adjudicationGroupId: { $exists: false } }, { adjudicationGroupId: '' }],
          },
          {
            $set: {
              adjudicationGroupId: id,
              adjudicationGroupMemberIds: memberIds,
              adjudicationGroupPinnedAt: pinnedAt,
              updatedAt: pinnedAt,
            },
          },
        );
        if (Number.isInteger(result?.matchedCount) && result.matchedCount === 0) {
          const persisted = await collection().findOne(
            { _id: row._id },
            {
              projection: {
                adjudicationGroupId: 1,
                adjudicationGroupMemberIds: 1,
                adjudicationGroupPinnedAt: 1,
              },
            },
          );
          if (
            safeText(persisted?.adjudicationGroupId, 160) !== id ||
            JSON.stringify(exactGroupMembers(persisted)) !== JSON.stringify(memberIds)
          ) {
            throw membershipConflict();
          }
        }
        row.adjudicationGroupId = id;
        row.adjudicationGroupMemberIds = memberIds;
        row.adjudicationGroupPinnedAt ||= pinnedAt;
      }),
    );
    prepared.push({ id, rows, memberIds, complete: true });
  }
  return prepared.sort((left, right) => {
    const leftRows = left.rows as RuntimeRecord[];
    const rightRows = right.rows as RuntimeRecord[];
    const leftAt = Math.min(...leftRows.map((row) => timestamp(row.createdAt) ?? 0));
    const rightAt = Math.min(...rightRows.map((row) => timestamp(row.createdAt) ?? 0));
    return leftAt - rightAt || left.id.localeCompare(right.id);
  });
}

function scopedPredecessorFilter(rows: RuntimeRecord[], groupId: string): RuntimeRecord {
  const first = rows[rows.length - 1];
  const created = rows
    .map((row) => timestamp(row.createdAt))
    .filter((value): value is number => value != null);
  return {
    ownerId: first.ownerId,
    conversationId: first.conversationId,
    anchorMessageId: first.anchorMessageId,
    adjudicationGroupId: { $ne: groupId },
    state: { $ne: 'superseded' },
    ...(created.length > 0 ? { createdAt: { $lt: new Date(Math.min(...created)) } } : {}),
  };
}

async function findPriorScopedAdjudication(
  rows: RuntimeRecord[],
  groupId: string,
): Promise<RuntimeRecord> {
  const filter = scopedPredecessorFilter(rows, groupId);
  const options = {
    projection: {
      adjudicationGroupId: 1,
      attempts: 1,
      state: 1,
      followUpMessageId: 1,
      accountContinuationConversationId: 1,
      accountContinuationAnchorMessageId: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    sort: { createdAt: -1, updatedAt: -1, _id: -1 },
  };
  const blocking = await collection().findOne(
    {
      ...filter,
      adjudicationGroupId: { $exists: true, $nin: ['', groupId] },
      $or: [
        { followUpMessageId: { $exists: false } },
        { followUpMessageId: '' },
        { followUpMessageId: null },
      ],
    },
    options,
  );
  if (blocking) return { blocking, prior: null };
  const prior = await collection().findOne(
    {
      ...filter,
      followUpMessageId: { $exists: true, $nin: ['', null] },
    },
    options,
  );
  return { blocking: null, prior };
}

async function eligibleAdjudicationGroups(pending: RuntimeRecord[]): Promise<RuntimeRecord[]> {
  const groups = await pinPendingAdjudicationGroups(pending);
  const eligible = [];
  for (const group of groups) {
    if (!group.complete) continue;
    const { blocking, prior } = await findPriorScopedAdjudication(group.rows, group.id);
    if (blocking) continue;
    for (const row of group.rows) row.priorScopedAdjudication = prior || null;
    eligible.push(group);
  }
  return eligible;
}

async function claimRows(rows: RuntimeRecord[]): Promise<RuntimeRecord[]> {
  const claimed: RuntimeRecord[] = [];
  for (const row of rows) {
    try {
      const value = (await runFencedMissionTransaction([row], async () => {
        const result = await collection().findOneAndUpdate(
          { _id: row._id, state: 'pending' },
          {
            $set: { state: 'processing', processingAt: new Date(), updatedAt: new Date() },
            $inc: { attempts: 1 },
          },
          { returnDocument: 'after' },
        );
        return result?.value || result;
      })) as RuntimeRecord | null;
      if (value?._id) {
        claimed.push({
          ...value,
          priorScopedAdjudication: row.priorScopedAdjudication || null,
        });
      }
    } catch (error) {
      if ((error as RuntimeError).code !== 'glasshive_mission_evidence_superseded') throw error;
      await collection().updateOne(
        { _id: row._id, state: 'pending' },
        {
          $set: {
            state: 'superseded',
            updatedAt: new Date(),
            errorCode: 'terminal_callback_revision_superseded',
          },
        },
      );
    }
  }
  return claimed;
}

async function loadMainAuthorContext(first: RuntimeRecord): Promise<RuntimeRecord> {
  const mainAgentId = safeText(first.mainAgentId || process.env.VIVENTIUM_MAIN_AGENT_ID, 160);
  const [user, agent] = await Promise.all([
    getUserById(first.ownerId, '-password -__v -totpSecret -backupCodes'),
    mainAgentId ? getAgent({ id: mainAgentId }) : null,
  ]);
  if (!user || !agent) {
    throw Object.assign(new Error('mission_main_author_unavailable'), {
      code: 'mission_main_author_unavailable',
    });
  }
  // `getUserById` returns a lean Mongo record in production, so it carries `_id` but not the
  // Express-auth `id` alias expected by saveMessage, callback delivery, and other request-scoped
  // services. Rebuild the ordinary authenticated request shape at this background boundary.
  const requestUser = {
    ...(typeof user.toObject === 'function' ? user.toObject() : user),
    id: safeText(user.id || user._id, 160),
  };
  return {
    user: requestUser,
    agent,
    req: {
      user: requestUser,
      body: { viventiumSurface: first.surface },
      headers: { 'x-viventium-surface': first.surface },
      config: await getAppConfig({ role: user.role }),
    },
  };
}

async function resolveMissionContinuationTarget(rows: RuntimeRecord[]): Promise<RuntimeRecord> {
  const first = rows[rows.length - 1];
  const prior = first.priorScopedAdjudication || null;
  const originConversation = await getConvo(first.ownerId, first.conversationId, 'conversationId');
  if (originConversation) {
    const deliveryParentMessageId = await pinMissionDeliveryParent(
      rows,
      first.anchorMessageId,
      prior,
    );
    return {
      conversationId: first.conversationId,
      parentMessageId: first.anchorMessageId,
      deliveryParentMessageId,
      accountContinuation: false,
    };
  }

  const persistedConversationIds = new Set(
    rows.map((row) => safeText(row.accountContinuationConversationId, 160)).filter(Boolean),
  );
  const persistedAnchors = new Set(
    rows.map((row) => safeText(row.accountContinuationAnchorMessageId, 160)).filter(Boolean),
  );
  if (persistedConversationIds.size > 1 || persistedAnchors.size > 1) {
    throw Object.assign(new Error('mission_account_continuation_conflict'), {
      code: 'mission_account_continuation_conflict',
    });
  }
  const persistedConversationId = [...persistedConversationIds][0] || '';
  const persistedAnchorMessageId = [...persistedAnchors][0] || '';
  const priorFollowUpMessageId = safeText(prior?.followUpMessageId, 160);
  const priorConversationId = safeText(prior?.accountContinuationConversationId, 160);
  const priorAnchorMessageId = safeText(prior?.accountContinuationAnchorMessageId, 160);
  if (
    (persistedConversationId &&
      priorConversationId &&
      persistedConversationId !== priorConversationId) ||
    (persistedAnchorMessageId &&
      priorAnchorMessageId &&
      persistedAnchorMessageId !== priorAnchorMessageId) ||
    ((priorConversationId || priorAnchorMessageId) &&
      !(priorConversationId && priorAnchorMessageId))
  ) {
    throw Object.assign(new Error('mission_account_continuation_conflict'), {
      code: 'mission_account_continuation_conflict',
    });
  }
  const conversationId = persistedConversationId || priorConversationId || crypto.randomUUID();
  const anchorMessageId = persistedAnchorMessageId || priorAnchorMessageId || NO_PARENT_MESSAGE_ID;
  const accountContinuationPrior =
    priorConversationId && priorAnchorMessageId ? prior : null;
  const initialDeliveryParentMessageId = `ghdp_${crypto
    .createHash('sha256')
    .update(
      [
        safeText(first.ownerId, 160),
        safeText(first.conversationId, 160),
        safeText(first.anchorMessageId, 160),
        safeText(first.surface, 32),
        safeText(first.adjudicationGroupId, 160),
        ...sortedGroupMemberIds(rows),
      ].join('\0'),
    )
    .digest('hex')}`;
  const now = new Date();
  await Promise.all(
    rows.map(async (row) => {
      row.accountContinuationConversationId = conversationId;
      row.accountContinuationAnchorMessageId = anchorMessageId;
      await collection().updateOne(
        { _id: row._id, state: 'processing' },
        {
          $set: {
            accountContinuationConversationId: conversationId,
            accountContinuationAnchorMessageId: anchorMessageId,
            originConversationDeletedAt: row.originConversationDeletedAt || now,
            updatedAt: now,
          },
        },
      );
    }),
  );
  return {
    conversationId,
    parentMessageId: anchorMessageId,
    deliveryParentMessageId: await pinMissionDeliveryParent(
      rows,
      accountContinuationPrior ? anchorMessageId : initialDeliveryParentMessageId,
      accountContinuationPrior,
      { replaceLegacyNoParent: true },
    ),
    accountContinuation: true,
  };
}

async function pinMissionDeliveryParent(
  rows: RuntimeRecord[],
  fallbackParentMessageId: unknown,
  prior: RuntimeRecord | null = null,
  { replaceLegacyNoParent = false }: { replaceLegacyNoParent?: boolean } = {},
): Promise<string> {
  const pinned = new Set(
    rows.map((row) => safeText(row.deliveryLedgerParentMessageId, 160)).filter(Boolean),
  );
  if (pinned.size > 1) {
    throw Object.assign(new Error('mission_delivery_parent_conflict'), {
      code: 'mission_delivery_parent_conflict',
    });
  }
  let deliveryParentMessageId = [...pinned][0] || '';
  if (replaceLegacyNoParent && deliveryParentMessageId === NO_PARENT_MESSAGE_ID) {
    deliveryParentMessageId = '';
  }
  if (!deliveryParentMessageId) {
    deliveryParentMessageId =
      safeText(prior?.followUpMessageId, 160) || safeText(fallbackParentMessageId, 160);
  }
  if (!deliveryParentMessageId) {
    throw Object.assign(new Error('mission_delivery_parent_unavailable'), {
      code: 'mission_delivery_parent_unavailable',
    });
  }
  const now = new Date();
  await Promise.all(
    rows.map(async (row) => {
      if (safeText(row.deliveryLedgerParentMessageId, 160) === deliveryParentMessageId) return;
      row.deliveryLedgerParentMessageId = deliveryParentMessageId;
      await collection().updateOne(
        { _id: row._id, state: 'processing' },
        {
          $set: {
            deliveryLedgerParentMessageId: deliveryParentMessageId,
            updatedAt: now,
          },
        },
      );
    }),
  );
  return deliveryParentMessageId;
}

async function synthesizeGroup(
  rows: RuntimeRecord[],
  { target, authorContext }: RuntimeRecord,
): Promise<RuntimeRecord> {
  // The owner-wide timer opens one coalescing window. Keep conversation/surface boundaries safe,
  // and anchor the combined continuation to the latest mission turn within that destination.
  const { req, agent } = authorContext;
  return createCortexFollowUpMessage({
    req,
    conversationId: target.conversationId,
    parentMessageId: target.parentMessageId,
    deliveryParentMessageId: target.deliveryParentMessageId,
    agent,
    insightsData: {
      insights: rows.map((row) => ({
        cortexName: 'Mission evidence',
        insight: row.evidence,
        maxPromptChars: 12_000,
        authority: {
          kind: 'durable_terminal_callback',
          event: safeText(row.event, 64),
          workState: safeText(
            row.workState || (row.event === 'run.completed' ? 'completed' : 'failed'),
            32,
          ),
        },
      })),
      errors: [],
      cortexCount: rows.length,
    },
    recentResponse: '',
    forceVisibleFollowUp: true,
    allowMovedOnUsefulFollowUp: true,
  });
}

async function ensureAccountContinuationConversation({
  target,
  authorContext,
  followUp,
}: RuntimeRecord): Promise<void> {
  if (!target.accountContinuation || !followUp?.messageId) return;
  const saved = await saveConvo(
    authorContext.req,
    {
      conversationId: target.conversationId,
      title: 'Background work',
      endpoint: 'agents',
      agent_id: authorContext.agent?.id,
      model: authorContext.agent?.id || authorContext.agent?.model || '',
    },
    {
      context: 'viventium/services/GlassHiveMissionAdjudicationService.accountContinuation',
    },
  );
  if (!saved || saved.message === 'Error saving conversation') {
    throw Object.assign(new Error('mission_account_continuation_persist_failed'), {
      code: 'mission_account_continuation_persist_failed',
    });
  }
}

async function finishRows(
  rows: RuntimeRecord[],
  {
    state,
    followUpMessageId = '',
    errorCode = '',
    preserveFollowUpMessageIds = false,
  }: RuntimeRecord,
): Promise<void> {
  const now = new Date();
  await Promise.all(
    rows.map(async (row) => {
      await collection().updateOne(
        { _id: row._id, state: 'processing' },
        {
          $set: {
            state,
            ...(preserveFollowUpMessageIds ? {} : { followUpMessageId }),
            errorCode,
            updatedAt: now,
            ...(['failed', 'delivery_pending'].includes(state)
              ? { nextAttemptAt: new Date(Date.now() + 30_000) }
              : {}),
          },
        },
      );
      await recordGlassHiveAdjudicationOutcome({
        originRef: row.originRef,
        state: ['delivery_pending', 'deadletter'].includes(state) ? 'failed' : state,
        followUpMessageId: preserveFollowUpMessageIds
          ? safeText(row.followUpMessageId, 160)
          : followUpMessageId,
        errorCode,
      });
    }),
  );
}

function groupFollowUpConflict(): RuntimeError {
  return Object.assign(new Error('mission_adjudication_group_follow_up_conflict'), {
    code: 'mission_adjudication_group_follow_up_conflict',
  });
}

async function reconcilePersistedGroupFollowUp(
  rows: RuntimeRecord[],
): Promise<RuntimeRecord | null> {
  const messageIds = new Set(
    rows.map((row) => safeText(row.followUpMessageId, 160)).filter(Boolean),
  );
  if (messageIds.size > 1) throw groupFollowUpConflict();
  const messageId = [...messageIds][0] || '';
  if (!messageId) return null;

  const persistedRows = rows.filter((row) => safeText(row.followUpMessageId, 160) === messageId);
  const text =
    persistedRows.map((row) => safeText(row.followUpText, MAX_EVIDENCE_CHARS)).find(Boolean) || '';
  const persistedAuthoredAt = persistedRows
    .map((row) => timestamp(row.authoredAt))
    .find((value) => value != null);
  const authoredAt = persistedAuthoredAt == null ? new Date() : new Date(persistedAuthoredAt);

  for (const row of rows) {
    if (safeText(row.followUpMessageId, 160) === messageId) continue;
    const result = await collection().updateOne(
      {
        _id: row._id,
        state: 'processing',
        $or: [
          { followUpMessageId: { $exists: false } },
          { followUpMessageId: '' },
          { followUpMessageId: null },
        ],
      },
      {
        $set: {
          followUpMessageId: messageId,
          followUpText: text,
          authoredAt,
          updatedAt: new Date(),
        },
      },
    );
    if (Number.isInteger(result?.matchedCount) && result.matchedCount === 0) {
      const persisted = await collection().findOne(
        { _id: row._id },
        { projection: { followUpMessageId: 1 } },
      );
      if (safeText(persisted?.followUpMessageId, 160) !== messageId) {
        throw groupFollowUpConflict();
      }
    }
    row.followUpMessageId = messageId;
    row.followUpText = text;
    row.authoredAt = authoredAt;
  }
  return { messageId, text };
}

async function persistAuthoredFollowUp(
  rows: RuntimeRecord[],
  followUp: RuntimeRecord,
): Promise<void> {
  const followUpMessageId = safeText(followUp?.messageId, 160);
  const followUpText = safeText(followUp?.text, MAX_EVIDENCE_CHARS);
  if (!followUpMessageId) return;
  await Promise.all(
    rows.map((row) =>
      collection().updateOne(
        { _id: row._id, state: 'processing' },
        {
          $set: {
            followUpMessageId,
            followUpText,
            authoredAt: new Date(),
            updatedAt: new Date(),
          },
        },
      ),
    ),
  );
}

async function recordMainWebPresentationDelivery({
  row,
  followUp,
}: RuntimeRecord): Promise<unknown> {
  if (safeText(row?.surface, 32) !== 'web' || !followUp?.messageId) return null;
  const traceIdentity = exactTraceIdentity(row);
  if (!traceIdentity || row.workTerminal !== true) return null;
  const messageId = safeText(followUp.messageId, 160);
  const existingMessageId = safeText(row.webPresentationMessageId, 160);
  if (existingMessageId && existingMessageId !== messageId) return null;

  let presentedAt = row.webPresentedAt ? new Date(row.webPresentedAt) : null;
  if (!presentedAt || !Number.isFinite(presentedAt.getTime())) {
    presentedAt = new Date();
    await collection().updateOne(
      {
        _id: row._id,
        ownerId: row.ownerId,
        state: 'processing',
        $or: [{ webPresentationMessageId: { $exists: false } }, { webPresentationMessageId: '' }],
      },
      {
        $set: {
          webPresentationMessageId: messageId,
          webPresentedAt: presentedAt,
          updatedAt: presentedAt,
        },
      },
    );
    row.webPresentationMessageId = messageId;
    row.webPresentedAt = presentedAt;
  }

  return recordOrchestrationTraceDelivery({
    ownerId: safeText(row.ownerId, 160),
    originRef: safeText(row.originRef, 160),
    deliveryRef: `main-web:${messageId}`,
    workRef: safeText(row.workRef, 160),
    runRef: safeText(row.runId, 160),
    callbackRef: traceIdentity.callbackRef,
    callbackEvent: safeText(row.event, 64),
    state: safeText(row.workState, 32),
    terminal: true,
    surface: 'web',
    status: 'sent',
    at: presentedAt,
    attemptNumber: traceIdentity.attemptNumber,
  });
}

async function enqueueMainAuthoredFollowUpDelivery({
  row,
  followUp,
  target,
  deliveryContext = {},
}: RuntimeRecord): Promise<RuntimeRecord | null> {
  if (!followUp?.messageId) return null;
  const traceIdentity = exactTraceIdentity(row);
  const summary = await enqueueGlassHiveCallbackDelivery({
    body: {
      callback_id: traceIdentity?.callbackRef || `main:${row.originRef}:${followUp.messageId}`,
      ...(traceIdentity ? { attempt_number: traceIdentity.attemptNumber } : {}),
      event: 'main.followup',
      origin_ref: row.originRef,
      work_ref: row.workRef,
      worker_id: row.workerId,
      run_id: row.runId,
    },
    message: followUp,
    text: safeText(followUp.text, MAX_EVIDENCE_CHARS),
    fullText: '',
    deliveryContext: {
      ownerId: row.ownerId,
      originRef: row.originRef,
      workRef: row.workRef,
      conversationId: target?.conversationId || row.conversationId,
      anchorMessageId: target?.parentMessageId || row.anchorMessageId,
      requestedParentMessageId: target?.parentMessageId || row.anchorMessageId,
      ...(traceIdentity
        ? {
            traceIdentity,
            traceCallbackEvent: safeText(row.event, 64),
            traceSurface: safeText(row.surface, 32),
          }
        : {}),
      destinations: Array.isArray(deliveryContext.destinations)
        ? deliveryContext.destinations
        : Array.isArray(row.destinations)
          ? row.destinations
          : [],
      ...(deliveryContext.workerCompletionPresentation
        ? { workerCompletionPresentation: deliveryContext.workerCompletionPresentation }
        : {}),
    },
  });
  if (
    Number(summary?.configured) > 0 &&
    (Number(summary?.enqueued) === 0 || Number(summary?.unresolved) > 0) &&
    summary?.deferredToMain !== true
  ) {
    throw Object.assign(new Error('mission_surface_delivery_unresolved'), {
      code: 'mission_surface_delivery_unresolved',
    });
  }
  return summary;
}

function voiceWorkerCompletionBinding(row: RuntimeRecord): RuntimeRecord {
  const traceIdentity = exactTraceIdentity(row);
  const reference = persistedTerminalCallbackReference(row);
  if (!traceIdentity || !reference) {
    throw Object.assign(new Error('voice_worker_completion_binding_unavailable'), {
      code: 'voice_worker_completion_binding_unavailable',
    });
  }
  return {
    originRef: safeText(row.originRef, 160),
    workRef: safeText(row.workRef, 160),
    workerId: safeText(row.workerId, 160),
    runId: safeText(row.runId, 160),
    callbackRef: traceIdentity.callbackRef,
    attemptNumber: traceIdentity.attemptNumber,
    resultKey: reference.resultKey,
    acceptedOperationId: reference.acceptedOperationId,
    terminalCallbackId: reference.callbackId,
    resultDigest: reference.resultDigest,
    resultRevision: reference.resultRevision,
    effectGeneration: reference.generation,
  };
}

async function mainFollowUpDeliveryContext({
  rows,
  followUp,
  target,
}: RuntimeRecord): Promise<RuntimeRecord> {
  const representative = rows[rows.length - 1];
  const destinations = Array.isArray(representative.destinations)
    ? representative.destinations
    : [];
  if (
    !destinations.some(
      (destination: RuntimeRecord) => safeText(destination?.surface, 32) === 'voice',
    )
  ) {
    return { destinations };
  }
  const activeCall = await getActiveCallSessionForConversation({
    userId: safeText(representative.ownerId, 160),
    conversationId: safeText(target?.conversationId || representative.conversationId, 160),
  });
  if (!activeCall?.callSessionId) {
    return {
      destinations: destinations.map((destination: RuntimeRecord) =>
        safeText(destination?.surface, 32) === 'voice'
          ? { surface: 'voice', unresolvedReason: 'voice_active_session_not_bound' }
          : destination,
      ),
    };
  }
  const responseText = safeText(followUp?.text, MAX_EVIDENCE_CHARS);
  const workerCompletionPresentation = buildVoiceWorkerCompletionPresentation({
    ownerId: safeText(representative.ownerId, 160),
    conversationId: safeText(target?.conversationId || representative.conversationId, 160),
    callSessionId: safeText(activeCall.callSessionId, 160),
    responseMessageId: safeText(followUp?.messageId, 160),
    responseText,
    bindings: rows.map(voiceWorkerCompletionBinding),
  });
  return {
    destinations: destinations.map((destination: RuntimeRecord) =>
      safeText(destination?.surface, 32) === 'voice'
        ? {
            surface: 'voice',
            voiceCallSessionId: workerCompletionPresentation.callSessionId,
            voiceRequestId: workerCompletionPresentation.turnId,
          }
        : destination,
    ),
    workerCompletionPresentation,
  };
}

async function flushGlassHiveMissionAdjudications({
  ownerId,
  limit = 50,
}: GlassHiveMissionLimitInput = {}): Promise<GlassHiveMissionFlushSummary> {
  const key = safeText(ownerId, 160);
  if (!key) return { claimed: 0, groups: 0, visible: 0, silent: 0, failed: 0 };
  const cursor = collection()
    .find({ ownerId: key, state: 'pending' })
    .sort({ createdAt: 1 })
    .limit(Math.max(1, Math.min(Number(limit) || 50, 100)));
  const pending = await cursor.toArray();
  const eligibleGroups = await eligibleAdjudicationGroups(pending);
  const claimed = await claimRows(eligibleGroups.flatMap((group) => group.rows));
  const groups = new Map<string, RuntimeRecord[]>();
  for (const row of claimed) {
    const group = groupKey(row);
    groups.set(group, [...(groups.get(group) || []), row]);
  }
  const summary = {
    claimed: claimed.length,
    groups: groups.size,
    visible: 0,
    silent: 0,
    failed: 0,
  };
  for (const rows of groups.values()) {
    let followUp: RuntimeRecord | null = null;
    let stage = 'resolve_target';
    try {
      const completedState = await runFencedMissionTransaction(rows, async () => {
        followUp = await reconcilePersistedGroupFollowUp(rows);
        const target = await resolveMissionContinuationTarget(rows);
        let authorContext = null;
        if (!followUp) {
          stage = 'load_main_author';
          authorContext = await loadMainAuthorContext(rows[rows.length - 1]);
          stage = 'synthesize';
          followUp = await synthesizeGroup(rows, { target, authorContext });
          stage = 'persist_authored_follow_up';
          await persistAuthoredFollowUp(rows, followUp);
        }
        if (!followUp?.messageId) {
          throw Object.assign(new Error('mission_terminal_presentation_missing'), {
            code: 'mission_terminal_presentation_missing',
          });
        }
        if (target.accountContinuation) {
          stage = 'load_main_author_for_account_continuation';
          authorContext ||= await loadMainAuthorContext(rows[rows.length - 1]);
          stage = 'persist_account_continuation';
          await ensureAccountContinuationConversation({ target, authorContext, followUp });
        }
        stage = 'record_web_presentation';
        await Promise.all(rows.map((row) => recordMainWebPresentationDelivery({ row, followUp })));
        stage = 'enqueue_surface_delivery';
        const deliveryContext = await mainFollowUpDeliveryContext({ rows, followUp, target });
        await enqueueMainAuthoredFollowUpDelivery({
          row: rows[rows.length - 1],
          followUp,
          target,
          deliveryContext,
        });
        stage = 'finish';
        await finishRows(rows, {
          state: 'completed',
          followUpMessageId: safeText(followUp.messageId, 160),
        });
        return 'completed';
      });
      summary[completedState === 'completed' ? 'visible' : 'silent'] += rows.length;
    } catch (error) {
      const runtimeError = error as RuntimeError;
      if (runtimeError.code === 'glasshive_mission_evidence_superseded') {
        await Promise.all(
          rows.map((row) =>
            collection().updateOne(
              { _id: row._id, state: 'processing' },
              {
                $set: {
                  state: 'superseded',
                  updatedAt: new Date(),
                  errorCode: 'terminal_callback_revision_superseded',
                },
              },
            ),
          ),
        );
        continue;
      }
      const rawErrorCode = safeText(runtimeError.code || runtimeError.name, 120);
      const errorCode =
        rawErrorCode && rawErrorCode !== 'Error'
          ? rawErrorCode
          : `mission_adjudication_${stage}_failed`;
      logger.warn('[VIVENTIUM][glasshive-adjudication] Mission evidence retry failed', {
        stage,
        code: errorCode,
      });
      const failedFollowUp = followUp as RuntimeRecord | null;
      const exhausted = rows.every((row) => Number(row.attempts || 0) >= MAX_ADJUDICATION_ATTEMPTS);
      let failedState = 'failed';
      if (exhausted) failedState = 'deadletter';
      else if (failedFollowUp?.messageId) failedState = 'delivery_pending';
      await finishRows(rows, {
        state: failedState,
        followUpMessageId: safeText(failedFollowUp?.messageId, 160),
        errorCode: exhausted ? 'mission_adjudication_retry_exhausted' : errorCode,
        preserveFollowUpMessageIds:
          runtimeError.code === 'mission_adjudication_group_follow_up_conflict',
      });
      summary.failed += rows.length;
    }
  }
  return summary;
}

function isLegacyDeletedOriginRedriveCandidate(row: RuntimeRecord): boolean {
  const evidenceId = safeText(row?._id, 160);
  const memberIds = exactGroupMembers(row);
  if (
    !/^ghe_[a-f0-9]{32}$/.test(evidenceId) ||
    !/^ghag_[a-f0-9]{32}$/.test(safeText(row?.adjudicationGroupId, 160)) ||
    memberIds.length !== 1 ||
    memberIds[0] !== evidenceId ||
    row?.state !== 'deadletter' ||
    Number(row?.attempts) < MAX_ADJUDICATION_ATTEMPTS ||
    safeText(row?.errorCode, 120) !== 'mission_adjudication_retry_exhausted' ||
    Number(row?.legacyDeliveryParentRedriveVersion) > 0 ||
    safeText(row?.followUpMessageId, 160) ||
    safeText(row?.authoredAt, 160) ||
    !['', NO_PARENT_MESSAGE_ID].includes(safeText(row?.deliveryLedgerParentMessageId, 160)) ||
    safeText(row?.accountContinuationConversationId, 160) ||
    !['', NO_PARENT_MESSAGE_ID].includes(
      safeText(row?.accountContinuationAnchorMessageId, 160),
    ) ||
    safeText(row?.event, 64) !== 'run.completed' ||
    safeText(row?.workState, 32) !== 'completed' ||
    row?.workTerminal !== true
  ) {
    return false;
  }
  try {
    return Boolean(persistedTerminalCallbackReference(row));
  } catch {
    return false;
  }
}

async function redriveLegacyDeletedOriginMissionAdjudications({
  limit = 25,
}: Pick<GlassHiveMissionLimitInput, 'limit'> = {}): Promise<GlassHiveMissionRedriveSummary> {
  const rows = await collection()
    .find({
      state: 'deadletter',
      errorCode: 'mission_adjudication_retry_exhausted',
      legacyDeliveryParentRedriveVersion: { $exists: false },
    })
    .sort({ updatedAt: 1, _id: 1 })
    .limit(Math.max(1, Math.min(Number(limit) || 25, 100)))
    .toArray();
  const summary = { scanned: rows.length, redriven: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    if (!isLegacyDeletedOriginRedriveCandidate(row)) {
      summary.skipped += 1;
      continue;
    }
    try {
      const originConversation = await getConvo(
        safeText(row.ownerId, 160),
        safeText(row.conversationId, 160),
        'conversationId',
      );
      if (originConversation) {
        summary.skipped += 1;
        continue;
      }
      const redrivenAt = new Date();
      const result = (await runFencedMissionTransaction([row], () =>
        collection().updateOne(
          {
            _id: row._id,
            ownerId: row.ownerId,
            state: 'deadletter',
            attempts: Number(row.attempts),
            errorCode: 'mission_adjudication_retry_exhausted',
            adjudicationGroupId: row.adjudicationGroupId,
            adjudicationGroupMemberIds: row.adjudicationGroupMemberIds,
            terminalCallbackResultKey: row.terminalCallbackResultKey,
            terminalCallbackAcceptedOperationId: row.terminalCallbackAcceptedOperationId,
            terminalCallbackId: row.terminalCallbackId,
            terminalCallbackResultDigest: row.terminalCallbackResultDigest,
            terminalCallbackResultRevision: row.terminalCallbackResultRevision,
            terminalCallbackEffectGeneration: row.terminalCallbackEffectGeneration,
            legacyDeliveryParentRedriveVersion: { $exists: false },
            followUpMessageId: { $in: [null, ''] },
            deliveryLedgerParentMessageId: { $in: [null, '', NO_PARENT_MESSAGE_ID] },
            accountContinuationConversationId: { $in: [null, ''] },
            accountContinuationAnchorMessageId: { $in: [null, '', NO_PARENT_MESSAGE_ID] },
          },
          {
            $set: {
              state: 'pending',
              attempts: 0,
              errorCode: '',
              legacyDeliveryParentRedriveVersion: LEGACY_DELIVERY_PARENT_REDRIVE_VERSION,
              legacyDeliveryParentPriorAttempts: Number(row.attempts),
              legacyDeliveryParentRedrivenAt: redrivenAt,
              updatedAt: redrivenAt,
            },
            $unset: { processingAt: '', nextAttemptAt: '' },
          },
        ),
      )) as RuntimeRecord;
      if (Number(result?.matchedCount) !== 1 || Number(result?.modifiedCount) !== 1) {
        summary.skipped += 1;
        continue;
      }
      scheduleOwnerAdjudication(row.ownerId);
      summary.redriven += 1;
    } catch (error) {
      const runtimeError = error as RuntimeError;
      if (runtimeError.code === 'glasshive_mission_evidence_superseded') {
        summary.skipped += 1;
        continue;
      }
      logger.warn('[VIVENTIUM][glasshive-adjudication] Legacy delivery-parent redrive failed', {
        code: safeText(runtimeError.code || runtimeError.name || 'legacy_redrive_failed', 120),
      });
      summary.failed += 1;
    }
  }
  return summary;
}

async function reconcilePendingGlassHiveMissionAdjudications({
  limit = 100,
}: Pick<GlassHiveMissionLimitInput, 'limit'> = {}): Promise<GlassHiveMissionReconciliationSummary> {
  const legacyRedrive = await redriveLegacyDeletedOriginMissionAdjudications({ limit });
  if (legacyRedrive.redriven > 0) {
    logger.info('[VIVENTIUM][glasshive-adjudication] Recovered legacy delivery-parent rows', {
      count: legacyRedrive.redriven,
    });
  }
  const rows = await collection()
    .find({
      $or: [
        { state: 'pending' },
        { state: 'failed', nextAttemptAt: { $lte: new Date() } },
        { state: 'delivery_pending', nextAttemptAt: { $lte: new Date() } },
        { state: 'processing', processingAt: { $lte: new Date(Date.now() - 5 * 60_000) } },
      ],
    })
    .sort({ updatedAt: 1 })
    .limit(Math.max(1, Math.min(Number(limit) || 100, 500)))
    .toArray();
  const owners = new Set();
  for (const row of rows) {
    const ownerId = safeText(row.ownerId, 160);
    if (!ownerId) continue;
    owners.add(ownerId);
    if (row.state !== 'pending') {
      await collection().updateOne(
        { _id: row._id, state: row.state },
        { $set: { state: 'pending', updatedAt: new Date() } },
      );
    }
    scheduleOwnerAdjudication(ownerId);
  }
  return { rows: rows.length, owners: owners.size };
}

function clearAdjudicationTimersForTests(): void {
  for (const timer of ownerTimers.values()) clearTimeout(timer);
  ownerTimers.clear();
  ownerFlushes.clear();
  ownerReschedules.clear();
}

return {
  COALESCE_MS,
  clearAdjudicationTimersForTests,
  enqueueGlassHiveMissionAdjudication,
  flushGlassHiveMissionAdjudications,
  persistGlassHiveMissionEvidence,
  redriveLegacyDeletedOriginMissionAdjudications,
  reconcilePendingGlassHiveMissionAdjudications,
};
}
