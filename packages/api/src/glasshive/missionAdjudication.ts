/* === VIVENTIUM START ===
 * Feature: Main-authored GlassHive mission adjudication.
 * Purpose:
 * - Keep worker callbacks as neutral lifecycle/status events.
 * - Persist terminal worker evidence before acknowledgement.
 * - Offer committed terminal evidence immediately through the existing scoped lane and
 *   configured Main/Phase-B follow-up machinery. Semantic {NTA}/redundancy may stay silent, but a
 *   useful mission result is not discarded merely because presentation moved to a newer turn.
 * - Leave a restart-safe pending/failed ledger that can be reconciled without replaying prose.
 * === VIVENTIUM END === */

import * as crypto from 'crypto';
import { createNativeResponseFetch } from './nativeResponse';
import { nativeIdentityJson } from '../stream/implementations/nativeResponse';
import { deliverCortexBatchToRunningMain } from '../cortex/liveMainContext';
import type { MainContinuityFetch } from '../continuity/mainContinuity';
import type { NativeResponseIdentity } from '@librechat/data-schemas';
import { canonicalizeGlassHiveCallbackRef } from '../trace/orchestrationTraceHooks';
import {
  GLASSHIVE_NATIVE_MEDIA_MAX_BYTES,
  GLASSHIVE_NATIVE_MEDIA_MAX_IMAGES,
  normalizeGlassHiveNativeMedia,
  collectGlassHiveNativeMediaReferences,
} from './nativeMedia';
import type { GlassHiveNativeMedia, GlassHiveNativeMediaSelection } from './nativeMedia';
import { normalizeGlassHiveRunInput } from './missionInput';
import { projectCurrentNativeWorkInput } from './activeWorkContext';
import type { GlassHiveRunInput } from './missionInput';
import { evidenceId, legacyEvidenceId } from './missionEvidenceIdentity';
import { normalizeNativeCallbackOutputFiles } from './nativeOutputFiles';
import type { NativeCallbackOutputFiles, NativeOutputDeliveryAttachment, NativeFollowUpOutputFiles } from './nativeOutputFiles';
import { loadFeelingsReadContext } from '../feelings/service';
import { bindCurrentCallContext } from '../voice/callContext';

import type { TerminalCallbackTransactionOptions } from './terminalCallbackTransaction';
import type { Logger } from 'winston';
import type { ClientSession, Model } from 'mongoose';
import type { Document } from 'mongodb';
import type { IGlassHiveTerminalCallbackResult, ViventiumVoiceRouteState } from '@librechat/data-schemas';
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
  feelingsIsolated?: boolean;
  originRef?: string;
  ownerId?: string;
  conversationId?: string;
  anchorMessageId?: string;
  requestedParentMessageId?: string;
  workRef?: string;
  mainAgentId?: string;
  runId?: string;
  attemptId?: string;
  destinations?: readonly GlassHiveMissionDestination[];
  traceIdentity?: GlassHiveMissionTraceIdentity;
}

export interface GlassHiveMissionCallbackBody {
  callback_id?: string;
  origin_ref?: string;
  work_ref?: string;
  worker_id?: string;
  run_id?: string;
  attempt_id?: string;
  output_files?: unknown;
  event?: string;
  callback_ts?: string;
  callback_created_at?: string;
  work_state?: string;
  work_terminal?: boolean;
  native_media?: unknown;
  run_input?: unknown;
  full_message?: string;
  message?: string;
  failure_code?: string;
  failure_class?: string;
  failure_user_message?: string;
  pending_native_input?: unknown;
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
  feelingsIsolated?: boolean;
  _id: string;
  evidenceId: string;
  originRef: string;
  workRef: string;
  workerId: string;
  runId: string;
  attemptId?: string;
  event: string;
  workState: string;
  workTerminal: boolean;
  ownerId: string;
  conversationId: string;
  anchorMessageId: string;
  requestedParentMessageId?: string;
  mainAgentId: string;
  surface: string;
  destinations: GlassHiveMissionDestination[];
  evidence: string;
  nativeInputContext?: ReturnType<typeof projectCurrentNativeWorkInput>;
  nativeMedia?: GlassHiveNativeMedia;
  runInput?: GlassHiveRunInput;
  outputFiles?: NativeCallbackOutputFiles;
  state: string;
  attempts: number;
  callbackCreatedAt?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface GlassHiveMissionLimitInput {
  ownerId?: string;
  conversationId?: string;
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
  wakeGlassHiveMissionAdjudications: (input: GlassHiveMissionLimitInput) => void;
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
  linkedWebCommitted?: boolean;
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
  fenceGlassHiveCallbackRunState: (input: {
    binding: { ownerId: string; originRef: string; workRef: string };
    body: { event: string; worker_id: string; run_id: string };
    effectSession: ClientSession;
  }) => Promise<void>;
  getConvo: (
    ownerId: string,
    conversationId: string,
    lookupField: 'conversationId',
  ) => Promise<object | null>;
  getUserById: (ownerId: string, projection: string) => Promise<MissionUser | null>;
  getFeelingState: Parameters<typeof loadFeelingsReadContext>[0]['getFeelingState'];
  logFeelingsEvent: (
    logger: Pick<Logger, 'info' | 'warn'>,
    req: object,
    event: string,
    fields: object,
    level?: 'info' | 'warn',
  ) => void;
  saveConvo: (
    request: object,
    conversation: object,
    options: { context: string },
  ) => Promise<{ message?: string } | null>;
  getAgent: (input: { id: string }) => Promise<MissionAgent | null>;
  getAppConfig: (input: { role?: string }) => Promise<object>;
  prepareCortexFollowUpMessage: (input: object) => Promise<RuntimeRecord>;
  persistPreparedCortexFollowUpMessage: (
    input: object,
    prepared: RuntimeRecord,
  ) => Promise<MissionFollowUp>;
  prepareMissionOutputFiles?: (input: {
    req: RuntimeRecord;
    rows: RuntimeRecord[];
    message: RuntimeRecord;
    nativeOutputFiles?: NativeFollowUpOutputFiles;
    selectedNativeMedia?: GlassHiveNativeMediaSelection[];
    sourceMessageId?: string;
  }) => Promise<NativeOutputDeliveryAttachment[] | { attachments: NativeOutputDeliveryAttachment[];
    authorizePublication: (session: ClientSession) => Promise<void> }>;
  isGlassHiveWorkTerminalCallback: (body: GlassHiveMissionCallbackBody) => boolean;
  recordGlassHiveAdjudicationOutcome: (input: object) => Promise<object | null>;
  recordOrchestrationTraceDelivery: (input: object) => Promise<object | null>;
  getActiveCallSessionForConversation: (input: {
    userId: string;
    conversationId: string;
  }) => Promise<{
    callSessionId?: string;
    userId?: string;
    agentId?: string;
    mode?: string;
    requestedVoiceRoute?: ViventiumVoiceRouteState | null;
  } | null>;
  sanitizeGlassHiveCallbackText: (value: string | undefined, options: { maxLength: number; ownerResult?: boolean }) => string;
  deferGlassHiveTerminalCallbackAfterCommit: (operation: () => void) => boolean;
  runGlassHiveTerminalCallbackTransaction: <T>(
    operation: (session: ClientSession) => T | Promise<T>,
    options?: TerminalCallbackTransactionOptions,
  ) => Promise<T>;
  enqueueGlassHiveCallbackDelivery: (input: object) => Promise<CallbackDeliverySummary>;
  getTerminalCallbackResultModel: () => Model<IGlassHiveTerminalCallbackResult>;
}

/** Immutable signed native outbox clock, with microsecond precision retained. */
export function normalizeGlassHiveCallbackCreatedAt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(value);
  if (!parts) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== parts[1]) return null;
  return `${parts[1]}.${(parts[2] || '').padEnd(6, '0')}Z`;
}

export function shouldAdjudicateGlassHiveNeedsInput(body: GlassHiveMissionCallbackBody = {}): boolean {
  return body.event === 'run.needs_input' && body.work_terminal !== true &&
    body.work_state === 'needs_input';
}

export async function isGlassHiveCleanupSourceTombstoned({
  mongoose,
  ownerId,
  conversationId,
  anchorMessageId,
}: GlassHiveMissionBinding & { mongoose: MissionMongoose }): Promise<boolean> {
  const user = String(ownerId || '').trim();
  const origin = String(conversationId || '').trim();
  const anchor = String(anchorMessageId || '').trim();
  if (!user || !origin || !anchor) throw new Error('glasshive_cleanup_source_scope_invalid');
  const session = mongoose.transactionAsyncLocalStorage?.getStore()?.session;
  const filter = {
    user,
    conversationId: origin,
    deletedAt: { $type: 'date' },
    'cleanupTombstone.operationId': { $type: 'string', $ne: '' },
    'cleanupTombstone.tombstonedAt': { $type: 'date' },
  };
  const options = { projection: { _id: 1 }, ...(session ? { session } : {}) };
  const conversation = await mongoose.connection.collection('conversations').findOne(filter, options);
  if (conversation) return true;
  const message = await mongoose.connection.collection('messages').findOne(
    { ...filter, messageId: anchor }, options,
  );
  return Boolean(message);
}

export function createGlassHiveMissionAdjudicationService(
  dependencies: GlassHiveMissionAdjudicationDependencies,
): GlassHiveMissionAdjudicationService {
  const {
    mongoose,
    logger,
    buildVoiceWorkerCompletionPresentation,
    fenceGlassHiveTerminalCallbackAcceptedOperation,
    fenceGlassHiveCallbackRunState,
    getConvo,
    getUserById,
    getFeelingState,
    logFeelingsEvent,
    saveConvo,
    getAgent,
    getAppConfig,
    prepareCortexFollowUpMessage,
    persistPreparedCortexFollowUpMessage,
    prepareMissionOutputFiles,
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
const MAX_EVIDENCE_CHARS = 64_000;
const MAX_ADJUDICATION_ATTEMPTS = 10;
const LEGACY_DELIVERY_PARENT_REDRIVE_VERSION = 1;
const NO_PARENT_MESSAGE_ID = '00000000-0000-0000-0000-000000000000';
const conversationFlushes = new Map<string, Promise<RuntimeRecord>>();
const conversationReschedules = new Map<string, boolean>();
interface LaneNativeAuthor {
  messageId: string;
  scope: string;
  closed: boolean;
  final: boolean;
  signal?: AbortSignal | null;
  identity?: NativeResponseIdentity;
  streamId?: string;
  route?: { baseURL: string; headers: Record<string, string> };
  fetch?: MainContinuityFetch;
  current: () => Promise<boolean>;
  wrapFetch: (baseFetch: MainContinuityFetch, providerId: string) => MainContinuityFetch;
  finish: () => void;
}
const conversationAuthors = new Map<string, LaneNativeAuthor>();

function authorScope(row: RuntimeRecord): string {
  return JSON.stringify([
    row.ownerId,
    row.conversationId,
    row.mainAgentId,
    row.feelingsIsolated === true,
    row.surface,
  ]);
}

async function offerEvidenceToLaneAuthor(row: RuntimeRecord): Promise<void> {
  const author = conversationAuthors.get(authorScope(row));
  if (!author?.identity || !author.route || !author.fetch || !(await author.current())) return;
  const identity = author.identity;
  const route = author.route;
  const transport = author.fetch;
  const current = async () =>
    Boolean(
      author.identity &&
      nativeIdentityJson(author.identity) === nativeIdentityJson(identity) &&
      (await author.current()),
    );
  const insights = missionInsights([row]);
  const context = JSON.stringify({ accepted_work_evidence: insights });
  const sameInput = (value: { invocationId: string; deliveryId: string; textSha256: string }) => ({
    invocationId: value.invocationId,
    deliveryId: value.deliveryId,
    textSha256: value.textSha256,
  });
  await deliverCortexBatchToRunningMain(
    {
      ownerId: row.ownerId,
      conversationId: row.conversationId,
      parentMessageId: identity.responseMessageId,
      streamId: identity.streamId,
      insights,
      context,
    },
    {
      liveContextEnabled: true,
      readCurrentAuthor: async () =>
        (await current()) ? { ...identity, status: 'pending' } : null,
      getJob: async () => null,
      readAdmission: async () => null,
      isCurrentLogicalTurn: async () => false,
      observeSourceOrder: async () => ({
        stale: true,
        latest_source_sequence: 0,
        observed_at: Date.now(),
      }),
      resolveRoute: async () => route,
      isEligible: async () => authorScope(row) === author.scope && (await current()),
      prepareInput: async (_identity, input) =>
        runFencedMissionTransaction([row], async () => {
          const updated = await collection().updateOne(
            { _id: row._id, state: 'pending' },
            {
              $set: { currentAuthorInput: { ...sameInput(input), status: 'offered' } },
            },
          );
          return updated.matchedCount === 1;
        }),
      recordInputReceipt: async (_identity, receipt) =>
        runFencedMissionTransaction([row], async () => {
          const updated = await collection().updateOne(
            {
              _id: row._id,
              state: 'pending',
              'currentAuthorInput.invocationId': identity.invocationId,
              'currentAuthorInput.deliveryId': receipt.deliveryId,
              'currentAuthorInput.textSha256': receipt.textSha256,
            },
            {
              $set: {
                currentAuthorInput: {
                  ...sameInput({ ...receipt, invocationId: identity.invocationId }),
                  status: receipt.status,
                  ...(receipt.runId
                    ? {
                        runId: receipt.runId,
                        attemptId: receipt.attemptId,
                        messageId: receipt.messageId,
                      }
                    : {}),
                },
              },
            },
          );
          return updated.matchedCount === 1;
        }),
      fetch: transport,
    },
  );
}

function laneNativeAuthor(rows: RuntimeRecord[], context: RuntimeRecord): LaneNativeAuthor {
  const row = rows[rows.length - 1];
  const scope = authorScope(row);
  const groupId = adjudicationGroupId(rows);
  const hash = crypto.createHash('sha256').update(groupId).digest('hex');
  const messageId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const createdAt = Date.now();
  const author: LaneNativeAuthor = {
    messageId,
    scope,
    closed: false,
    final: false,
    current: async () => {
      if (
        author.closed ||
        author.final ||
        author.signal?.aborted ||
        conversationAuthors.get(scope) !== author
      )
        return false;
      try {
        const held = await runFencedMissionTransaction(rows, async () => {
          for (const claimed of rows) {
            const current = await collection().findOne({
              _id: claimed._id,
              state: 'processing',
              attempts: claimed.attempts,
              processingAt: claimed.processingAt,
            });
            if (!current) return false;
          }
          return true;
        });
        if (!held) return false;
      } catch {
        return false;
      }
      if (row.surface === 'voice') {
        const call = await getActiveCallSessionForConversation({
          userId: row.ownerId,
          conversationId: context.target.conversationId,
        });
        if (
          !call?.callSessionId ||
          call.callSessionId !== context.authorContext.req.body.viventiumCallSessionId
        )
          return false;
      }
      return !author.closed && !author.final && !author.signal?.aborted;
    },
    wrapFetch: (baseFetch, providerId) => {
      const bound = createNativeResponseFetch(
        baseFetch,
        async () => {
          if (!(await author.current())) throw new Error('mission_native_author_superseded');
          return {
            userId: row.ownerId,
            conversationId: context.target.conversationId,
            responseMessageId: messageId,
            streamId: author.streamId || '',
            jobCreatedAt: createdAt,
            logicalTurnId: groupId,
            revision: Math.max(1, Number(row.attempts) || 1),
            providerId,
            agentId: `${row.mainAgentId}:phase_b:followup`,
            source: {
              id: groupId,
              messageId: context.target.parentMessageId,
              digest: crypto
                .createHash('sha256')
                .update(
                  JSON.stringify(
                    rows.map((item) => [item._id, item.evidence, item.runId, item.traceIdentity]),
                  ),
                )
                .digest('hex'),
            },
          };
        },
        async (identity) => {
          if (!(await author.current())) throw new Error('mission_native_author_superseded');
          author.identity = identity;
          return true;
        },
        () => {},
      );
      return async (input, init) => {
        const url = new URL(
          typeof input === 'string' || input instanceof URL ? String(input) : input.url,
        );
        if (!url.pathname.endsWith('/chat/completions')) return baseFetch(input, init);
        const headers = new Headers(
          init?.headers || (input instanceof Request ? input.headers : undefined),
        );
        if (
          headers.get('X-Viventium-User-Id') !== row.ownerId ||
          headers.get('X-Viventium-Conversation-Id') !== context.target.conversationId ||
          headers.get('X-Viventium-Message-Id') !== messageId ||
          headers.get('X-GlassHive-Agent-Id') !== `${row.mainAgentId}:phase_b:followup`
        ) {
          throw new Error('mission_native_author_scope_mismatch');
        }
        const streamId = headers.get('X-Viventium-Stream-Id') || '';
        if (!streamId || headers.get('X-GlassHive-Idempotency-Key') !== streamId)
          throw new Error('mission_native_author_stream_mismatch');
        if (author.identity && author.identity.streamId !== streamId)
          throw new Error('mission_native_author_stream_changed');
        author.signal = init?.signal;
        const origin = new URL(url.href);
        origin.pathname = origin.pathname.slice(0, -'/chat/completions'.length);
        author.route = {
          baseURL: origin.href,
          headers: {
            Authorization: headers.get('Authorization') || '',
            'X-Viventium-User-Id': row.ownerId,
          },
        };
        author.fetch = baseFetch;
        // The actual stream header belongs to this dispatch, before an identity exists.
        author.streamId = streamId;
        return bound(input, init);
      };
    },
    finish: () => {
      author.final = true;
    },
  };
  return author;
}

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

function terminalEvidence(body: GlassHiveMissionCallbackBody = {}): string {
  if (shouldAdjudicateGlassHiveNeedsInput(body)) {
    return sanitizeGlassHiveCallbackText(
      body.failure_user_message || body.full_message || body.message,
      { maxLength: MAX_EVIDENCE_CHARS, ownerResult: true },
    );
  }
  const event = safeText(body.event, 64);
  if (!['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(event)) return '';
  if (!isGlassHiveWorkTerminalCallback(body)) return '';
  const full = sanitizeGlassHiveCallbackText(body.full_message, {
    maxLength: MAX_EVIDENCE_CHARS,
    ownerResult: true,
  });
  const preview = sanitizeGlassHiveCallbackText(body.message, {
    maxLength: MAX_EVIDENCE_CHARS,
    ownerResult: true,
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
  if (['run.cancelled', 'run.interrupted'].includes(event)) return `Mission ${event.slice(4)}.`;
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

async function latestAttentionEvidenceMatches(row: RuntimeRecord, session?: ClientSession): Promise<boolean> {
  const latest = await collection().findOne({ ownerId: row.ownerId, originRef: row.originRef,
    workRef: row.workRef, workerId: row.workerId, runId: row.runId,
    event: 'run.needs_input', workTerminal: false, workState: 'needs_input' },
  { ...(session ? { session } : {}), sort: row.callbackCreatedAt
      ? { callbackCreatedAt: -1, _id: -1 }
      : { callbackCreatedAt: -1, createdAt: -1, _id: -1 }, projection: { _id: 1 } });
  return safeText(latest?._id, 160) === safeText(row._id, 160);
}

async function fenceMissionReferences(
  rows: RuntimeRecord[], session: ClientSession, requireNewestAttention = true,
): Promise<void> {
  const references = new Map<string, PersistedTerminalCallbackReference>();
  for (const row of rows) {
    if (row.event === 'run.needs_input' && row.workTerminal !== true && row.workState === 'needs_input') {
      const current = await mongoose.connection.collection('viventium_external_work').findOne({
        _id: row.originRef, ownerId: row.ownerId, workRef: row.workRef,
        workerId: row.workerId, runId: row.runId, externalState: 'needs_input',
      }, { session, projection: { _id: 1 } });
      if (!current || (requireNewestAttention && !(await latestAttentionEvidenceMatches(row, session))))
        throw Object.assign(new Error('glasshive_mission_evidence_superseded'), {
        code: 'glasshive_mission_evidence_superseded',
      });
      await fenceGlassHiveCallbackRunState({
        binding: { ownerId: row.ownerId, originRef: row.originRef, workRef: row.workRef },
        body: { event: row.event, worker_id: row.workerId, run_id: row.runId },
        effectSession: session,
      });
    }
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
  options: TerminalCallbackTransactionOptions = {},
  requireNewestAttention = true,
): Promise<T> {
  const attention = rows.filter((row) => row.event === 'run.needs_input' &&
    row.workTerminal !== true && row.workState === 'needs_input');
  if (!attention.length && !rows.some((row) => persistedTerminalCallbackReference(row))) return operation();
  let result: T | undefined;
  await runGlassHiveTerminalCallbackTransaction(async (session: ClientSession) => {
    if (attention.length) await fenceMissionReferences(attention, session, requireNewestAttention);
    result = await operation();
    await fenceMissionReferences(rows, session, requireNewestAttention);
  }, options);
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
  const requestedParentMessageId = safeText(binding?.requestedParentMessageId, 160);
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
  const outputFiles = body.output_files == null ? undefined : normalizeNativeCallbackOutputFiles(
    body.output_files,
    {
      ownerId,
      originRef,
      workRef: safeText(binding?.workRef, 160),
      runId: safeText(binding?.runId, 160),
      attemptId: safeText(binding?.attemptId, 160),
      callbackId: callbackReference?.callbackId || '',
      resultRevision: callbackReference?.resultRevision || 0,
      resultDigest: callbackReference?.resultDigest || '',
    },
  );
  const nativeMedia = normalizeGlassHiveNativeMedia(body.native_media, safeText(body.run_id, 160));
  const runInput = normalizeGlassHiveRunInput(body.run_input, safeText(body.run_id, 160));
  const row: GlassHiveMissionEvidence = {
    _id: id,
    evidenceId: id,
    originRef,
    workRef: safeText(binding?.workRef || body.work_ref, 160),
    workerId: safeText(body.worker_id, 160),
    runId: safeText(body.run_id, 160),
    ...(safeText(binding?.attemptId, 160) ? { attemptId: safeText(binding?.attemptId, 160) } : {}),
    ...(outputFiles ? { attemptId: outputFiles.attempt_id, outputFiles } : {}),
    event: safeText(body.event, 64),
    workState: safeText(body.work_state, 32),
    workTerminal: body.work_terminal === true,
    ...(traceIdentity || {}),
    ...(shouldAdjudicateGlassHiveNeedsInput(body)
      ? { callbackRef: canonicalizeGlassHiveCallbackRef(String(body.callback_id || '')),
          ...(normalizeGlassHiveCallbackCreatedAt(body.callback_created_at)
            ? { callbackCreatedAt: normalizeGlassHiveCallbackCreatedAt(body.callback_created_at)! } : {}) }
      : {}),
    ownerId,
    conversationId,
    anchorMessageId,
    ...(requestedParentMessageId ? { requestedParentMessageId } : {}),
    mainAgentId: safeText(binding?.mainAgentId, 160),
    ...(binding?.feelingsIsolated === true ? { feelingsIsolated: true } : {}),
    surface: normalizedSurface(binding),
    destinations: safeDestinations(binding),
    evidence,
    ...(shouldAdjudicateGlassHiveNeedsInput(body) ? { nativeInputContext: projectCurrentNativeWorkInput({
      workRef: safeText(binding?.workRef || body.work_ref, 160), state: 'needs_input',
      pendingNativeInput: body.pending_native_input,
    }, 'fresh') } : {}),
    ...(nativeMedia ? { nativeMedia } : {}),
    ...(runInput ? { runInput } : {}),
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
  const persist = () => collection().updateOne(
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
  if (shouldAdjudicateGlassHiveNeedsInput(body)) {
    if (effectSession) {
      await fenceMissionReferences([row], effectSession, false);
      await persist();
    } else await runFencedMissionTransaction([row], persist, {}, false);
  } else await persist();
  return row;
}

function flushConversationAdjudication(
  owner: string,
  conversation: string,
  pinnedOnly: boolean,
): void {
  const key = JSON.stringify([owner, conversation]);
  if (conversationFlushes.has(key)) {
    // A pending full pass includes new rows; a ready wake cannot narrow that pass.
    conversationReschedules.set(key, (conversationReschedules.get(key) ?? true) && pinnedOnly);
    return;
  }
  const flush = Promise.resolve().then(() =>
    flushGlassHiveMissionAdjudications({ ownerId: owner, conversationId: conversation }, pinnedOnly),
  );
  conversationFlushes.set(key, flush);
  flush
    .catch((error: RuntimeError) => {
      logger.warn('[VIVENTIUM][glasshive-adjudication] Conversation flush failed', {
        code: safeText(error?.code || error?.name || 'flush_failed', 120),
      });
    })
    .finally(() => {
      if (conversationFlushes.get(key) !== flush) return;
      conversationFlushes.delete(key);
      const next = conversationReschedules.get(key);
      conversationReschedules.delete(key);
      if (next !== undefined) flushConversationAdjudication(owner, conversation, next);
    });
}

function scheduleConversationAdjudication(ownerId: unknown, conversationId: unknown): void {
  const owner = safeText(ownerId, 160);
  if (!owner) return;
  const conversation = safeText(conversationId, 160);
  flushConversationAdjudication(owner, conversation, false);
}

function wakeGlassHiveMissionAdjudications({ ownerId, conversationId }: GlassHiveMissionLimitInput): void {
  const owner = safeText(ownerId, 160);
  if (!owner) return;
  // Main readiness does not reopen an already pinned group's collection window.
  flushConversationAdjudication(owner, safeText(conversationId, 160), true);
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
    const schedule = () => {
      void offerEvidenceToLaneAuthor(row).catch(() => {
        logger.warn('[VIVENTIUM][glasshive-adjudication] Current author input unavailable');
      });
      scheduleConversationAdjudication(row.ownerId, row.conversationId);
    };
    if (!deferGlassHiveTerminalCallbackAfterCommit(schedule)) schedule();
  }
  return row;
}

function coalescingGroupKey(row: RuntimeRecord): string {
  return [
    row.ownerId,
    row.conversationId,
    row.mainAgentId,
    row.feelingsIsolated === true ? 'isolated' : 'ordinary',
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
  const mediaBudgets = new Map<string, { batch: number; images: number; bytes: number }>();
  for (const row of pending) {
    let key = safeText(row.adjudicationGroupId, 160);
    if (!key) {
      const scope = coalescingGroupKey(row);
      const budget = mediaBudgets.get(scope) || { batch: 0, images: 0, bytes: 0 };
      const media = normalizeGlassHiveNativeMedia(row.nativeMedia, safeText(row.runId, 160));
      const images = media?.observations.length || 0;
      const bytes = media?.observations.reduce((sum, item) => sum + item.bytes, 0) || 0;
      if (
        budget.images + images > GLASSHIVE_NATIVE_MEDIA_MAX_IMAGES ||
        budget.bytes + bytes > GLASSHIVE_NATIVE_MEDIA_MAX_BYTES
      ) {
        budget.batch += 1;
        budget.images = 0;
        budget.bytes = 0;
      }
      budget.images += images;
      budget.bytes += bytes;
      mediaBudgets.set(scope, budget);
      key = `new:${scope}:${budget.batch}`;
    }
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
    state: { $nin: ['superseded', 'silent'] },
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
      state: { $nin: ['superseded', 'silent', 'deadletter'] },
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
  const current = [];
  for (const row of pending) {
    if (row.event === 'run.needs_input' && row.workTerminal === false &&
        row.workState === 'needs_input' && !(await latestAttentionEvidenceMatches(row))) {
      await collection().updateOne({ _id: row._id, state: 'pending' }, { $set: {
        state: 'superseded', updatedAt: new Date(), errorCode: 'glasshive_mission_evidence_superseded',
      } });
      continue;
    }
    current.push(row);
  }
  const groups = await pinPendingAdjudicationGroups(current);
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

async function loadMainAuthorContext(
  first: RuntimeRecord,
  conversationId: string = safeText(first.conversationId, 160),
  feelingsIsolated: boolean = first.feelingsIsolated === true,
): Promise<RuntimeRecord> {
  const mainAgentId = safeText(first.mainAgentId || process.env.VIVENTIUM_MAIN_AGENT_ID, 160);
  const [user, agent, activeCall] = await Promise.all([
    getUserById(first.ownerId, '-password -__v -totpSecret -backupCodes'),
    mainAgentId ? getAgent({ id: mainAgentId }) : null,
    safeText(first.surface, 32) === 'voice'
      ? getActiveCallSessionForConversation({
          userId: safeText(first.ownerId, 160),
          conversationId: safeText(conversationId, 160),
        })
      : null,
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
  const req: RuntimeRecord = {
    user: requestUser,
    body: {
      viventiumSurface: first.surface,
      ...(activeCall?.callSessionId
        ? {
            voiceMode: true,
            viventiumInputMode: 'voice_call',
            viventiumCallSessionId: activeCall.callSessionId,
          }
        : {}),
    },
    ...(activeCall?.callSessionId
      ? { viventiumCallSession: {
            callSessionId: activeCall.callSessionId,
            ...(activeCall.userId ? { userId: activeCall.userId } : {}),
            ...(activeCall.agentId ? { agentId: activeCall.agentId } : {}),
            ...(activeCall.mode ? { mode: activeCall.mode } : {}),
            ...(activeCall.requestedVoiceRoute
              ? { requestedVoiceRoute: activeCall.requestedVoiceRoute } : {}),
          } }
      : {}),
    headers: { 'x-viventium-surface': first.surface },
    config: await getAppConfig({ role: user.role }),
  };
  // The authorized Call supplies selected capabilities, not proof of actual fallback playback.
  if (bindCurrentCallContext(req)) {
    const selectedProvider = safeText(activeCall?.requestedVoiceRoute?.tts?.provider, 160);
    if (selectedProvider) req.body.voiceProvider = selectedProvider;
  }
  const startedAt = Date.now();
  if (feelingsIsolated) {
    req._viventiumFeelingSnapshot = null;
    req._viventiumFeelingReadFailureClass = 'temporary_eval_isolation';
    logFeelingsEvent(logger, req, 'feelings.read.skip', {
      reason: 'temporary_eval_isolation', durationMs: Date.now() - startedAt,
    });
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const configured = Number(process.env.VIVENTIUM_FEELINGS_READ_TIMEOUT_MS || 4000);
      const timeoutMs = Number.isFinite(configured)
        ? Math.min(5000, Math.max(25, configured)) : 4000;
      // A callback is a new authored turn. Read the current owner version after any reaction.
      const snapshot = await Promise.race([
        loadFeelingsReadContext({ userId: requestUser.id, getFeelingState, bypassCache: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('feelings_read_timeout')), timeoutMs);
        }),
      ]);
      req._viventiumFeelingSnapshot = snapshot;
      req._viventiumFeelingReadFailureClass = '';
      logFeelingsEvent(logger, req, 'feelings.read.complete', {
        enabled: snapshot.enabled, scope: snapshot.agentScope, version: snapshot.version,
        snapshotHash: snapshot.snapshotHash, cacheHit: snapshot.cacheHit === true,
        rangePromptOverrideCount: snapshot.rangePromptOverrideCount,
        activeRangePromptOverrideCount: snapshot.activeRangePromptOverrideCount,
        activeRangePromptOverrideChars: snapshot.activeRangePromptOverrideChars,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const failureClass = error instanceof Error && error.message === 'feelings_read_timeout'
        ? 'state_read_timeout' : 'state_read_failed';
      req._viventiumFeelingSnapshot = null;
      req._viventiumFeelingReadFailureClass = failureClass;
      logFeelingsEvent(logger, req, 'feelings.read.failure', {
        errorClass: failureClass, durationMs: Date.now() - startedAt,
      }, 'warn');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return {
    user: requestUser,
    agent,
    req,
  };
}

async function resolveMissionContinuationTarget(rows: RuntimeRecord[]): Promise<RuntimeRecord> {
  const first = rows[rows.length - 1];
  const prior = first.priorScopedAdjudication || null;
  if (await isGlassHiveCleanupSourceTombstoned({
    mongoose,
    ownerId: first.ownerId,
    conversationId: first.conversationId,
    anchorMessageId: first.anchorMessageId,
  })) {
    throw Object.assign(new Error('mission_origin_cleanup_tombstoned'), {
      code: 'mission_origin_cleanup_tombstoned',
    });
  }
  const sourceMessageId = safeText(first.requestedParentMessageId, 160);
  const [originConversation, originMessages] = await Promise.all([
    getConvo(first.ownerId, first.conversationId, 'conversationId'),
    mongoose.connection.collection('messages').find({
      user: first.ownerId,
      conversationId: first.conversationId,
      messageId: { $in: [...new Set([first.anchorMessageId, sourceMessageId].filter(Boolean))] },
    }, { projection: { user: 1, conversationId: 1, messageId: 1, isCreatedByUser: 1,
      deletedAt: 1, cleanupTombstone: 1 } }).toArray(),
  ]);
  if (originConversation) {
    const anchorPresent = originMessages.some((message) => message.messageId === first.anchorMessageId);
    const source = originMessages.find((message) => message.messageId === sourceMessageId);
    const sourcePresent = source?.isCreatedByUser === true &&
      String(source.user || '') === String(first.ownerId) &&
      String(source.conversationId || '') === String(first.conversationId) &&
      !source.deletedAt && !source.cleanupTombstone?.tombstonedAt;
    if (!anchorPresent && source && (source.deletedAt || source.cleanupTombstone?.tombstonedAt)) {
      throw Object.assign(new Error('mission_origin_cleanup_tombstoned'), {
        code: 'mission_origin_cleanup_tombstoned',
      });
    }
    if (!anchorPresent && !sourcePresent) {
      throw Object.assign(new Error('mission_origin_source_unavailable'), {
        code: 'mission_origin_source_unavailable',
      });
    }
    // The removed anchor remains attribution/tombstone identity. Context walks from the durable
    // owned source so later corrections and Main replies remain visible to this same continuation.
    const logicalParentMessageId = anchorPresent ? first.anchorMessageId : sourceMessageId;
    const deliveryParentMessageId = await pinMissionDeliveryParent(
      rows,
      logicalParentMessageId,
      prior,
    );
    return {
      conversationId: first.conversationId,
      parentMessageId: logicalParentMessageId,
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

function missionInsights(rows: RuntimeRecord[]): RuntimeRecord[] {
  return rows.map((row) => ({
        cortexId: safeText(row.evidenceId || row._id, 256),
        cortexName: 'Mission evidence',
        insight: row.outputFiles || row.nativeInputContext ? `${JSON.stringify({
          ...(row.outputFiles ? { output_files: {
            ...row.outputFiles,
            count: row.outputFiles.files.length,
            rejected: row.outputFiles.rejected || [],
          } } : {}),
          ...(row.nativeInputContext ? { nativeInput: row.nativeInputContext } : {}),
        })}\n\n${row.evidence}` : row.evidence,
        ...(row.nativeMedia ? { nativeMedia: row.nativeMedia } : {}),
        ...(row.runInput ? { runInput: row.runInput } : {}),
        maxPromptChars: 12_000,
        authority: {
          kind: row.workTerminal === true ? 'durable_terminal_callback' : 'durable_work_callback',
          userSource: {
            messageId: safeText(row.requestedParentMessageId, 160) || null,
            conversationId: safeText(row.conversationId, 160),
          },
          runId: safeText(row.runId, 160),
          event: safeText(row.event, 64),
          workState: safeText(
            row.workState || (row.event === 'run.completed' ? 'completed' : 'failed'),
            32,
          ),
        },
      }));
}

function groupFollowUpInput(
  rows: RuntimeRecord[],
  { target, authorContext }: RuntimeRecord,
): RuntimeRecord {
  // Opportunistic groups retain their existing surface and accepted membership boundaries,
  // and anchor the combined continuation to the latest mission turn within that destination.
  const { req, agent } = authorContext;
  return {
    req,
    conversationId: target.conversationId,
    parentMessageId: target.parentMessageId,
    deliveryParentMessageId: target.deliveryParentMessageId,
    runId: adjudicationGroupId(rows),
    agent,
    insightsData: {
      insights: missionInsights(rows),
      errors: [],
      cortexCount: rows.length,
    },
    recentResponse: '',
    forceVisibleFollowUp: true,
    allowMovedOnUsefulFollowUp: true,
  };
}

async function prepareGroupSynthesis(
  rows: RuntimeRecord[],
  context: RuntimeRecord,
): Promise<RuntimeRecord> {
  const author = laneNativeAuthor(rows, context);
  conversationAuthors.set(author.scope, author);
  try {
    return await prepareCortexFollowUpMessage({ ...groupFollowUpInput(rows, context), nativeAuthor: author });
  } finally {
    author.closed = true;
    if (conversationAuthors.get(author.scope) === author) conversationAuthors.delete(author.scope);
  }
}

async function persistPreparedGroupSynthesis(
  rows: RuntimeRecord[],
  context: RuntimeRecord,
  prepared: RuntimeRecord,
): Promise<RuntimeRecord> {
  const followUp = await persistPreparedCortexFollowUpMessage(
    {
      ...groupFollowUpInput(rows, context),
      dependencies: {
        prepareAttachments: async (message: RuntimeRecord) => {
          if (!rows.some((row) => row.outputFiles) && !prepared.nativeOutputFiles &&
              !prepared.selectedNativeMedia?.length &&
              !collectGlassHiveNativeMediaReferences(String(message.text || '')).length) return [];
          if (!prepareMissionOutputFiles) throw new Error('native_output_file_storage_unavailable');
          return prepareMissionOutputFiles({
            req: context.authorContext.req, rows, message,
            selectedNativeMedia: prepared.selectedNativeMedia,
            ...(prepared.nativeOutputFiles ? {
              nativeOutputFiles: prepared.nativeOutputFiles,
              sourceMessageId: prepared.nativeSourceMessageId || context.target.parentMessageId,
            } : {}),
          });
        },
      },
    },
    { ...prepared, ...(rows.some((row) => row.outputFiles?.files?.length > 0) ? { attachmentsRequired: true } : {}) },
  );
  if (followUp?.messageId) {
    const session = mongoose.transactionAsyncLocalStorage?.getStore()?.session;
    const persisted = await mongoose.connection.collection('messages').findOne({
      user: safeText(rows[rows.length - 1].ownerId, 160),
      conversationId: safeText(context.target?.conversationId, 160),
      messageId: safeText(followUp.messageId, 160),
      isCreatedByUser: false,
    }, session ? { session } : undefined);
    if (!persisted || persisted.text !== followUp.text) {
      throw Object.assign(new Error('mission_authored_message_not_persisted'), {
        code: 'mission_authored_message_not_persisted',
      });
    }
  }
  return followUp;
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
  for (const row of rows) {
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
  }
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
  const representative = persistedRows[persistedRows.length - 1];
  const session = mongoose.transactionAsyncLocalStorage?.getStore()?.session;
  const persistedMessage = await mongoose.connection.collection('messages').findOne({
    user: safeText(representative.ownerId, 160),
    conversationId: safeText(
      representative.accountContinuationConversationId || representative.conversationId, 160,
    ),
    messageId,
    isCreatedByUser: false,
  }, session ? { session } : undefined);
  // An ID left by an aborted message transaction is not a committed authored result.
  if (persistedAuthoredAt == null || (!text && !persistedMessage?.attachments?.length)) {
    await Promise.all(rows.map((row) => collection().updateOne(
      { _id: row._id, state: 'processing', followUpMessageId: messageId },
      { $unset: { followUpMessageId: '', followUpText: '', authoredAt: '' } },
    )));
    for (const row of rows) {
      delete row.followUpMessageId;
      delete row.followUpText;
      delete row.authoredAt;
    }
    return null;
  }
  const authoredAt = new Date(persistedAuthoredAt);
  if (!persistedMessage || safeText(persistedMessage.text, MAX_EVIDENCE_CHARS) !== text) {
    throw Object.assign(new Error('mission_authored_message_unavailable'), {
      code: 'mission_authored_message_unavailable',
    });
  }

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
  return { ...persistedMessage, messageId, text };
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

async function markSettledCallbackStatusInternal(row: RuntimeRecord): Promise<void> {
  const reference = persistedTerminalCallbackReference(row);
  if (!reference || row.event !== 'run.completed' || row.workState !== 'completed') return;
  const session = mongoose.transactionAsyncLocalStorage?.getStore()?.session;
  await mongoose.connection.collection('messages').updateOne(
    {
      user: safeText(row.ownerId, 160),
      conversationId: safeText(row.conversationId, 160),
      isCreatedByUser: false,
      'metadata.viventium.type': 'glasshive_worker_callback',
      'metadata.viventium.originRef': safeText(row.originRef, 160),
      'metadata.viventium.runId': safeText(row.runId, 160),
      'metadata.viventium.callbackId': reference.callbackId,
      'metadata.viventium.status.kind': 'mission_status',
      'metadata.viventium.status.state': 'completed',
      'metadata.viventium.hasFullText': false,
    },
    { $set: { 'metadata.viventium.visibility': 'internal' } },
    session ? { session } : undefined,
  );
}

async function recordMainWebPresentationDelivery({
  row,
  followUp,
  linkedTextFallback = false,
}: RuntimeRecord): Promise<unknown> {
  if ((safeText(row?.surface, 32) !== 'web' && !linkedTextFallback) || !followUp?.messageId) return null;
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
  const destinations = Array.isArray(deliveryContext.destinations)
    ? deliveryContext.destinations
    : Array.isArray(row.destinations) ? row.destinations : [];
  const hasCommittedWebPresentation =
    safeText(row.webPresentationMessageId, 160) === safeText(followUp.messageId, 160) &&
    timestamp(row.webPresentedAt) != null;
  const summary = await enqueueGlassHiveCallbackDelivery({
    body: {
      callback_id: traceIdentity?.callbackRef || row.callbackRef || `main:${row.originRef}:${followUp.messageId}`,
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
      destinations: hasCommittedWebPresentation && !destinations.some(
        (destination: RuntimeRecord) => ['librechat', 'workbench'].includes(safeText(destination.surface, 32)),
      ) ? [...destinations, { surface: 'librechat' }] : destinations,
      ...(deliveryContext.workerCompletionBindings
        ? { workerCompletionBindings: deliveryContext.workerCompletionBindings } : {}),
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
  const durablyEnqueued = Number(summary?.configured) > 0 &&
    Number(summary?.enqueued) > 0 && Number(summary?.unresolved || 0) === 0;
  if (hasCommittedWebPresentation && (summary?.linkedWebCommitted === true || durablyEnqueued)) {
    await collection().updateOne(
      { _id: row._id, ownerId: row.ownerId, webPresentationMessageId: followUp.messageId },
      { $set: { webProjectionReconciledAt: new Date() } },
    );
  }
  return summary;
}

function voiceWorkerCompletionBinding(row: RuntimeRecord): RuntimeRecord {
  if (row.event === 'run.needs_input' && row.workTerminal === false && row.workState === 'needs_input') {
    return { kind: 'nonterminal_attention', originRef: row.originRef, workRef: row.workRef,
      workerId: row.workerId, runId: row.runId, callbackRef: row.callbackRef,
      event: 'run.needs_input', workTerminal: false, evidenceId: row.evidenceId };
  }
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
  const workerCompletionBindings = rows.every(
    (row: RuntimeRecord) =>
      (row.event === 'run.needs_input' && row.workTerminal === false && row.workState === 'needs_input') ||
      (persistedTerminalCallbackReference(row) && Number(exactTraceIdentity(row)?.attemptNumber) > 0),
  )
    ? rows.map(voiceWorkerCompletionBinding)
    : null;
  const destinations = Array.isArray(representative.destinations)
    ? representative.destinations
    : [];
  if (
    !destinations.some(
      (destination: RuntimeRecord) => safeText(destination?.surface, 32) === 'voice',
    )
  ) {
    return { destinations, workerCompletionBindings };
  }
  const activeCall = await getActiveCallSessionForConversation({
    userId: safeText(representative.ownerId, 160),
    conversationId: safeText(target?.conversationId || representative.conversationId, 160),
  });
  // No runtime attempt means there is no Worker speech-attempt authority to bind.
  // Preserve the authored group on the existing linked-text path instead of aborting all surfaces.
  if (
    !activeCall?.callSessionId ||
    !workerCompletionBindings
  ) {
    return {
      destinations: destinations.filter(
        (destination: RuntimeRecord) => safeText(destination?.surface, 32) !== 'voice',
      ),
      linkedTextFallback: true,
      workerCompletionBindings,
    };
  }
  const responseText = safeText(followUp?.text, MAX_EVIDENCE_CHARS);
  if (!responseText && followUp?.attachments?.length) return {
    destinations: destinations.filter((destination: RuntimeRecord) => destination.surface !== 'voice'),
    linkedTextFallback: true, workerCompletionBindings,
  };
  const workerCompletionPresentation = buildVoiceWorkerCompletionPresentation({
    ownerId: safeText(representative.ownerId, 160),
    conversationId: safeText(target?.conversationId || representative.conversationId, 160),
    callSessionId: safeText(activeCall.callSessionId, 160),
    responseMessageId: safeText(followUp?.messageId, 160),
    responseText,
    bindings: workerCompletionBindings,
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
    workerCompletionBindings,
  };
}

async function flushGlassHiveMissionAdjudications({
  ownerId,
  conversationId,
  limit = 50,
}: GlassHiveMissionLimitInput = {}, pinnedOnly = false): Promise<GlassHiveMissionFlushSummary> {
  const key = safeText(ownerId, 160);
  if (!key) return { claimed: 0, groups: 0, visible: 0, silent: 0, failed: 0 };
  const cursor = collection()
    .find({
      ownerId: key,
      state: 'pending',
      ...(pinnedOnly ? { adjudicationGroupId: { $type: 'string', $ne: '' } } : {}),
      ...(conversationId === undefined ? {} : {
        conversationId: safeText(conversationId, 160) || { $in: ['', null] },
      }),
    })
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
    let authoredCommitted = false;
    let target: RuntimeRecord | null = null;
    let authorContext: RuntimeRecord | null = null;
    let preparedFollowUp: RuntimeRecord | null = null;
    let stage = 'resolve_target';
    try {
      stage = 'preflight';
      await runFencedMissionTransaction(rows, async () => {
        followUp = await reconcilePersistedGroupFollowUp(rows);
        target = await resolveMissionContinuationTarget(rows);
      });
      authoredCommitted = Boolean((followUp as RuntimeRecord | null)?.messageId);
      if (!followUp) {
        stage = 'load_main_author';
        authorContext = await loadMainAuthorContext(
          rows[rows.length - 1],
          safeText((target as RuntimeRecord | null)?.conversationId, 160),
          rows.some((row) => row.feelingsIsolated === true),
        );
        stage = 'prepare_synthesis';
        preparedFollowUp = await prepareGroupSynthesis(rows, { target, authorContext });
        if (preparedFollowUp?.currentMainPending === true) {
          // An enqueue is not consumption. Release only this exact claim, preserving evidence,
          // group membership and delivery history until the existing Main replay event wakes it.
          await runFencedMissionTransaction(rows, async () => {
            for (const row of rows) await collection().updateOne(
              { _id: row._id, state: 'processing', attempts: row.attempts,
                processingAt: row.processingAt },
              { $set: { state: 'pending', updatedAt: new Date() },
                $unset: { processingAt: '' }, $inc: { attempts: -1 } },
            );
          });
          // A replay wake can precede release (including direct reconciliation flushes).
          // Recheck once after release and reuse the same lane only if Main is now ready.
          if (typeof preparedFollowUp.currentMainReadyAfterRelease === 'function') {
            try {
              if (await preparedFollowUp.currentMainReadyAfterRelease()) {
                wakeGlassHiveMissionAdjudications({
                  ownerId: rows[0].ownerId,
                  conversationId: (target as RuntimeRecord | null)?.conversationId,
                });
              }
            } catch {
              dependencies.logger?.warn?.('[MissionAdjudication] Main readiness remains pending');
            }
          }
          continue;
        }
        if (preparedFollowUp?.followUpDecisionRecord?.generationFailed === true) {
          throw Object.assign(new Error('mission_synthesis_generation_failed'), {
            code: 'mission_synthesis_generation_failed',
          });
        }
      }
      const authoredState = await runFencedMissionTransaction(rows, async () => {
        followUp = await reconcilePersistedGroupFollowUp(rows);
        target = await resolveMissionContinuationTarget(rows);
        if (!followUp) {
          if (!authorContext || !preparedFollowUp) {
            throw Object.assign(new Error('mission_prepared_follow_up_unavailable'), {
              code: 'mission_prepared_follow_up_unavailable',
            });
          }
          stage = 'persist_prepared_synthesis';
          followUp = await persistPreparedGroupSynthesis(
            rows,
            { target, authorContext },
            preparedFollowUp,
          );
          stage = 'persist_authored_follow_up';
          await persistAuthoredFollowUp(rows, followUp);
        }
        if (!followUp?.messageId) {
          const decision = preparedFollowUp?.followUpDecisionRecord;
          if (
            decision?.generationFailed === false &&
            decision?.forceVisibleFollowUp === false &&
            ((decision?.llmResult === 'nta' &&
              decision?.selectedStrategy === 'no_response_suppressed') ||
             (decision?.nativeSilentDecision === true &&
              decision?.llmResult === 'native_silent' &&
              decision?.selectedStrategy === 'native_silent_suppressed'))
          ) {
            // Preserve Main's explicit semantic decision through the same
            // accepted-result fence; absent or failed generation stays retryable.
            stage = 'settle_silent_callback_presentation';
            for (const row of rows) await markSettledCallbackStatusInternal(row);
            stage = 'finish_silent';
            await finishRows(rows, { state: 'silent' });
            return 'silent';
          }
          throw Object.assign(new Error('mission_terminal_presentation_missing'), {
            code: 'mission_terminal_presentation_missing',
          });
        }
        if (target.accountContinuation) {
          stage = 'load_main_author_for_account_continuation';
          authorContext ||= await loadMainAuthorContext(
            rows[rows.length - 1],
            safeText((target as RuntimeRecord | null)?.conversationId, 160),
            rows.some((row) => row.feelingsIsolated === true),
          );
          stage = 'persist_account_continuation';
          await ensureAccountContinuationConversation({ target, authorContext, followUp });
        }
        return 'authored';
      });
      if (authoredState === 'silent') {
        summary.silent += rows.length;
        continue;
      }
      // A receiver/configuration failure must not roll back the already authored answer.
      // Both phases retain the same accepted callback fence; delivery reuses the committed ID.
      authoredCommitted = true;
      const completedState = await runFencedMissionTransaction(rows, async () => {
        // Each native transaction attempt starts from the same committed row snapshot.
        // Presentation helpers mutate these copies; an aborted attempt cannot seed its replay.
        const deliveryRows = rows.map((row) => ({ ...row }));
        if (!followUp?.messageId) {
          throw Object.assign(new Error('mission_authored_message_unavailable'), {
            code: 'mission_authored_message_unavailable',
          });
        }
        stage = 'settle_callback_presentation';
        for (const row of deliveryRows) await markSettledCallbackStatusInternal(row);
        stage = 'resolve_surface_delivery';
        const deliveryContext = await mainFollowUpDeliveryContext({ rows: deliveryRows, followUp, target });
        stage = 'record_web_presentation';
        for (const row of deliveryRows) {
          await recordMainWebPresentationDelivery({
            row, followUp, linkedTextFallback: deliveryContext.linkedTextFallback === true,
          });
        }
        stage = 'enqueue_surface_delivery';
        await enqueueMainAuthoredFollowUpDelivery({
          row: deliveryRows[deliveryRows.length - 1],
          followUp,
          target,
          deliveryContext,
        });
        stage = 'finish';
        await finishRows(deliveryRows, {
          state: 'completed',
          followUpMessageId: safeText(followUp.messageId, 160),
        });
        return 'completed';
      }, { retry: 'native' });
      summary[completedState === 'completed' ? 'visible' : 'silent'] += rows.length;
    } catch (error) {
      const runtimeError = error as RuntimeError;
      if (runtimeError.code === 'mission_origin_cleanup_tombstoned') {
        await finishRows(rows, { state: 'silent', errorCode: runtimeError.code });
        summary.silent += rows.length;
        continue;
      }
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
      logger.warn(`[VIVENTIUM][glasshive-adjudication] Mission evidence retry failed ${JSON.stringify({ stage, code: errorCode })}`, {
        stage,
        code: errorCode,
      });
      const failedFollowUp = authoredCommitted ? followUp as RuntimeRecord | null : null;
      const exhausted = !failedFollowUp?.messageId &&
        rows.every((row) => Number(row.attempts || 0) >= MAX_ADJUDICATION_ATTEMPTS);
      let failedState = 'failed';
      if (exhausted) failedState = 'deadletter';
      else if (failedFollowUp?.messageId) failedState = 'delivery_pending';
      await finishRows(rows, {
        state: failedState,
        followUpMessageId: safeText(failedFollowUp?.messageId, 160),
        errorCode: exhausted ? 'mission_adjudication_retry_exhausted' : errorCode,
        preserveFollowUpMessageIds:
          runtimeError.code === 'mission_adjudication_group_follow_up_conflict' ||
          (!authoredCommitted && rows.some((row) => safeText(row.followUpMessageId, 160))),
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
      scheduleConversationAdjudication(row.ownerId, row.conversationId);
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
  // Repair only retained committed Web presentations; never regenerate their answer.
  const completedPresentations = await collection().find({
    state: 'completed',
    webPresentedAt: { $type: 'date' },
    webPresentationMessageId: { $type: 'string', $ne: '' },
    webProjectionReconciledAt: { $exists: false },
    $or: [{ webProjectionNextAttemptAt: null }, { webProjectionNextAttemptAt: { $lte: new Date() } }],
  }).sort({ webProjectionNextAttemptAt: 1, updatedAt: 1 }).limit(Math.max(1, Math.min(Number(limit) || 100, 500))).toArray();
  for (const row of completedPresentations) {
    // Advance the scan even when a legacy row has no usable presentation proof.
    await collection().updateOne(
      { _id: row._id, ownerId: row.ownerId, state: 'completed' },
      { $set: { webProjectionNextAttemptAt: new Date(Date.now() + 30_000) } },
    );
    try {
      await runFencedMissionTransaction([row], async () => {
        const followUp = await reconcilePersistedGroupFollowUp([row]);
        if (!followUp || followUp.messageId !== row.webPresentationMessageId) return;
        const target = {
          conversationId: row.accountContinuationConversationId || row.conversationId,
          parentMessageId: row.accountContinuationAnchorMessageId || row.anchorMessageId,
        };
        const deliveryContext = await mainFollowUpDeliveryContext({ rows: [row], followUp, target });
        await enqueueMainAuthoredFollowUpDelivery({ row, followUp, target, deliveryContext });
      });
    } catch (error) {
      logger.warn('[VIVENTIUM][glasshive-adjudication] Web delivery projection recovery deferred', {
        code: safeText((error as RuntimeError).code || 'web_delivery_projection_unavailable', 120),
      });
    }
  }
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
        // Retained authored deliveries use the same recovery owner and attempt history.
        // Preflight distinguishes a committed answer from a rolled-back pointer before delivery.
        { state: 'deadletter', followUpMessageId: { $type: 'string', $ne: '' },
          updatedAt: { $lte: new Date(Date.now() - 60_000) } },
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
    scheduleConversationAdjudication(ownerId, row.conversationId);
  }
  return { rows: rows.length, owners: owners.size };
}

function clearAdjudicationTimersForTests(): void {
  conversationFlushes.clear();
  conversationReschedules.clear();
  for (const author of conversationAuthors.values()) author.closed = true;
  conversationAuthors.clear();
}

return {
  wakeGlassHiveMissionAdjudications,
  clearAdjudicationTimersForTests,
  enqueueGlassHiveMissionAdjudication,
  flushGlassHiveMissionAdjudications,
  persistGlassHiveMissionEvidence,
  redriveLegacyDeletedOriginMissionAdjudications,
  reconcilePendingGlassHiveMissionAdjudications,
};
}
