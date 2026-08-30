/* === VIVENTIUM START ===
 * Feature: Core-owned GlassHive callback origin, destination, and scheduled-work binding.
 * Purpose:
 * - Persist the trusted request/schedule destination contract before a GlassHive launch.
 * - Resolve callbacks by owner + conversation + immutable assistant anchor instead of trusting
 *   callback-supplied Telegram/voice identifiers.
 * - Keep the small scheduled external-work projection needed to distinguish acknowledgement from
 *   objective completion. GlassHive remains the execution/state authority.
 * === VIVENTIUM END === */

import * as crypto from 'crypto';

import type { Logger } from 'winston';
import type { ClientSession } from 'mongoose';
import type { Document } from 'mongodb';
import type {
  TrustedDelegationIdentityInput,
  TrustedDelegationInput,
} from './accountClient';

/** Internal Mongo/API records are schema-validated at their owning ingress before this service. */
type RuntimeRecord = Document;
type RuntimeError = Error & { code?: string; name: string; status?: number };

interface CallbackBindingCursor {
  sort: (sort: RuntimeRecord) => CallbackBindingCursor;
  limit: (limit: number) => CallbackBindingCursor;
  toArray: () => Promise<RuntimeRecord[]>;
}

interface CallbackBindingCollection {
  find: (filter: RuntimeRecord, options?: RuntimeRecord) => CallbackBindingCursor;
  findOne: (filter: RuntimeRecord, options?: RuntimeRecord) => Promise<RuntimeRecord | null>;
  findOneAndUpdate: (
    filter: RuntimeRecord,
    update: RuntimeRecord,
    options?: RuntimeRecord,
  ) => Promise<RuntimeRecord | null>;
  updateOne: (
    filter: RuntimeRecord,
    update: RuntimeRecord,
    options?: RuntimeRecord,
  ) => Promise<RuntimeRecord>;
}

interface CallbackBindingMongoose {
  connection: {
    collection: (name: string) => CallbackBindingCollection;
  };
  transactionAsyncLocalStorage?: {
    getStore: () => { session?: ClientSession } | undefined;
  };
}

interface CallbackMessage {
  messageId?: string;
  parentMessageId?: string;
  sender?: string;
  isCreatedByUser?: boolean;
  vivantiumSourceEventId?: string;
  viventiumSourceEventId?: string;
}

interface TelegramDestinationMapping {
  telegramUserId?: string;
  telegramChatId?: string;
}

interface GlassHiveAccountApiInput {
  ownerId: string;
  path: string;
  method?: string;
  body?: object;
  timeoutMs?: number;
}

interface GlassHiveAccountApiResult {
  valid?: boolean;
  originRef?: string;
  workRef?: string;
  workerId?: string;
  runId?: string;
  state?: string;
}

interface PromptLayerIntegritySnapshot {
  contractVersion?: number;
  unknownLayerNames?: string[];
}

interface OrchestrationTraceWriteInput {
  ownerId: string;
  originRef: string;
  workRef?: string;
  runRef?: string;
  callbackRef?: string;
  event?: string;
  workState?: string;
  workTerminal?: boolean;
  sourceEventRef?: string;
  logicalTurnRef?: string;
  promptLayers?: PromptLayerIntegritySnapshot;
  detail?: GlassHiveAccountApiResult;
  at?: Date;
  callbackAt?: Date;
  callbackAcceptedAt?: Date;
  attemptNumber?: number | null;
}

interface OrchestrationTraceWriteResult {
  accepted?: boolean;
}

interface WorkStateReconciliationInput {
  ownerId: string;
  item?: GlassHiveAccountApiResult;
  row: RuntimeRecord;
  error?: unknown;
}

export interface GlassHiveDestination {
  surface: string;
  telegramChatId?: string;
  telegramUserId?: string;
  telegramMessageId?: string;
  voiceCallSessionId?: string;
  voiceRequestId?: string;
  unresolvedReason?: string;
}

export interface GlassHiveLaunchRequestBody {
  conversationId?: string;
  conversation_id?: string;
  messageId?: string;
  message_id?: string;
  parentMessageId?: string;
  parent_message_id?: string;
  agent_id?: string;
  agentId?: string;
  endpointOption?: { agent_id?: string };
  deliveryChannels?: string | string[];
  viventiumSchedulerDeliveryChannels?: string | string[];
  viventiumSurface?: string;
  viventiumTelegramChatId?: string;
  viventiumTelegramUserId?: string;
  viventiumTelegramMessageId?: string;
  viventiumVoiceCallSessionId?: string;
  viventiumVoiceRequestId?: string;
  viventiumSchedulerDispatchDocumentId?: string;
  viventiumSchedulerOccurrenceKey?: string;
  viventiumScheduleId?: string;
  scheduleId?: string;
  viventiumSchedulerExternalWorkRequired?: boolean;
  viventiumSourceEventId?: string;
  viventiumAuthoringSourceEventId?: string;
  viventiumLogicalTurnId?: string;
  viventiumTriggeringSourceSegments?: object[];
  viventiumTriggeringSourceSegmentsOverflowCount?: number;
  viventiumInteractionContext?: {
    source_event_id?: string;
    logical_turn_id?: string;
  };
}

export interface GlassHiveLaunchRegistrationInput {
  user?: { id?: string; _id?: object | string };
  requestBody?: GlassHiveLaunchRequestBody;
  toolName?: string;
  toolArguments?: object;
  toolCall?: { id?: string; call_id?: string; step_id?: string; turn?: number };
}

export interface GlassHiveLaunchContext {
  bindingId: string;
  originRef: string;
  sourceEventId: string;
  objectiveOrdinal: number;
  objectiveDigest: string;
  callIdentityDigest: string;
  delegationIdentity: object;
  delegationContext: object;
  delegationPacket: object;
  ownerId: string;
  schedulerDispatchDocumentId: string;
  scheduleOccurrenceKey: string;
  required: boolean;
}

export interface GlassHiveCallbackBody {
  callback_id?: string;
  callback_ts?: string | number;
  origin_ref?: string;
  work_ref?: string;
  worker_id?: string;
  run_id?: string;
  event?: string;
  work_state?: string;
  work_terminal?: boolean;
  attempt_number?: number;
  failure_code?: string;
  failure_class?: string;
  error_code?: string;
  error?: { code?: string };
  result_revision?: number;
  result_digest?: string;
  result_ended_at?: string;
}

export interface GlassHiveCallbackEffectFence {
  resultKey?: string;
  callbackId?: string;
  resultDigest?: string;
  acceptedOperationId?: string;
  leaseId?: string;
  resultRevision?: number;
  generation?: number;
  acceptedOperationGeneration?: number;
}

export interface GlassHiveCallbackContext {
  bindingId: string;
  originRef: string;
  workRef: string;
  ownerId: string;
  conversationId: string;
  anchorMessageId: string;
  requestedParentMessageId: string;
  schedulerDispatchDocumentId: string;
  scheduleOccurrenceKey: string;
  scheduleId: string;
  mainAgentId: string;
  traceIdentity?: { callbackRef: string; attemptNumber: number | null };
  destinations: GlassHiveDestination[];
}

export interface GlassHiveCallbackMutationInput {
  binding?: GlassHiveCallbackContext;
  body?: GlassHiveCallbackBody;
  effectFence?: GlassHiveCallbackEffectFence;
  effectSession?: ClientSession;
}

export interface GlassHiveSchedulerBinding {
  ownerId?: string;
  schedulerDispatchDocumentId?: string;
  scheduleOccurrenceKey?: string;
}

export interface GlassHiveSchedulerExternalWorkItem {
  workRef: string;
  required: boolean;
  state: string;
}

export interface GlassHiveSchedulerExternalWorkSummary {
  requiredTotal: number;
  requiredTerminal: number;
  requiredFailed: number;
  allRequiredTerminal: boolean;
  state: string;
  items: GlassHiveSchedulerExternalWorkItem[];
}

export interface GlassHiveReconciliationSummary {
  scanned: number;
  repaired?: number;
  pending?: number;
  updatedOwners?: number;
  failedOwners?: number;
}

export interface GlassHiveLaunchTransitionResult {
  originRef: string;
  workRef?: string;
  launchState?: string;
  externalState?: string;
}

export interface GlassHiveCallbackBindingService {
  attachGlassHiveLaunchOrigin: (toolArguments: unknown, originRef: unknown) => unknown;
  attachGlassHiveTrustedLaunchMetadata: (
    toolArguments: unknown,
    launchContext?: GlassHiveLaunchContext,
    trustedBootstrapBundle?: object,
  ) => unknown;
  confirmGlassHiveCallbackContext: (
    input?: GlassHiveCallbackMutationInput,
  ) => Promise<GlassHiveCallbackContext | null>;
  glassHiveLaunchOriginFromArguments: (toolArguments: unknown) => string;
  getSchedulerExternalWorkSummary: (
    input?: GlassHiveSchedulerBinding & { effectSession?: ClientSession },
  ) => Promise<GlassHiveSchedulerExternalWorkSummary>;
  hasAcceptedGlassHiveLaunchForPresentation: (input?: {
    ownerId?: string;
    conversationId?: string;
    responseMessageId?: string;
    sourceEventId?: string;
  }) => Promise<boolean>;
  launchDispatchAmbiguityLeaseMs: () => number;
  launchPreparationLeaseMs: () => number;
  markGlassHiveLaunchDispatchUnknown: (
    toolArguments: unknown,
  ) => Promise<GlassHiveLaunchTransitionResult | null>;
  markGlassHiveLaunchDispatchRejected: (
    toolArguments: unknown,
    error?: RuntimeError,
  ) => Promise<GlassHiveLaunchTransitionResult | null>;
  markGlassHiveLaunchDispatchReady: (
    launchContext?: GlassHiveLaunchContext,
  ) => Promise<GlassHiveLaunchTransitionResult | null>;
  markGlassHiveLaunchPreDispatchFailed: (
    launchContext?: GlassHiveLaunchContext,
    error?: RuntimeError,
  ) => Promise<GlassHiveLaunchTransitionResult | null>;
  notifySchedulerExternalWorkSummary: (input?: {
    binding?: GlassHiveSchedulerBinding;
    summary?: GlassHiveSchedulerExternalWorkSummary;
  }) => Promise<object | null>;
  reconcileKnownExternalWorkHints: (input?: {
    limit?: number;
  }) => Promise<GlassHiveReconciliationSummary>;
  reconcileGlassHiveLaunchResult: (input?: {
    toolArguments?: unknown;
    result?: unknown;
  }) => Promise<GlassHiveLaunchTransitionResult | null>;
  reconcileUnknownGlassHiveLaunches: (input?: {
    ownerId?: string;
    limit?: number;
  }) => Promise<GlassHiveReconciliationSummary>;
  recordGlassHiveAdjudicationOutcome: (input?: {
    originRef?: string;
    state?: 'completed' | 'silent' | 'failed';
    followUpMessageId?: string;
    errorCode?: string;
    effectSession?: ClientSession;
  }) => Promise<object | null>;
  recordGlassHiveSurfaceDeliveryOutcome: (input?: {
    originRef?: string;
    state?: 'enqueued' | 'sent' | 'failed' | 'suppressed' | 'unresolved' | 'unknown';
    body?: GlassHiveCallbackBody;
    effectFence?: GlassHiveCallbackEffectFence;
    effectSession?: ClientSession;
  }) => Promise<object | null>;
  recordGlassHiveCallbackExternalState: (
    input?: GlassHiveCallbackMutationInput,
  ) => Promise<GlassHiveSchedulerExternalWorkSummary | null>;
  isGlassHiveWorkTerminalCallback: (body?: GlassHiveCallbackBody) => boolean;
  registerGlassHiveLaunchContext: (
    input?: GlassHiveLaunchRegistrationInput,
  ) => Promise<GlassHiveLaunchContext | null>;
  resolveTrustedGlassHiveCallIdentity: (input?: {
    requestBody?: GlassHiveLaunchRequestBody;
    toolCall?: GlassHiveLaunchRegistrationInput['toolCall'];
  }) => { sourceEventId: string; objectiveOrdinal: number; callIdentityDigest: string };
  resolveGlassHiveCallbackContext: (
    body?: GlassHiveCallbackBody,
    options?: { deferConfirmation?: boolean },
  ) => Promise<GlassHiveCallbackContext | null>;
}

export interface GlassHiveCallbackBindingDependencies {
  mongoose: CallbackBindingMongoose;
  logger: Pick<Logger, 'info' | 'warn'>;
  canonicalizeGlassHiveCallbackRef: (value: string) => string;
  resolveTelegramMappingByUserId: (input: {
    libreChatUserId: string;
  }) => Promise<TelegramDestinationMapping | null>;
  getMessages: (filter: object, projection: string) => Promise<CallbackMessage[]>;
  markUserParallelWorkKnown: (ownerId: string) => Promise<boolean>;
  buildTrustedDelegationIdentity: (
    input: TrustedDelegationInput,
  ) => { idempotencyKey: string; goalDigest: string };
  requestAccountApi: (input: GlassHiveAccountApiInput) => Promise<GlassHiveAccountApiResult>;
  signTrustedDelegationIdentity: (
    identity: TrustedDelegationIdentityInput,
    options: { ownerId?: string; tenantId?: string },
  ) => string;
  normalizeInteractionSourceSegments: typeof import('./interactionSourceSegments').normalizeInteractionSourceSegments;
  promptLayerIntegritySnapshot: () => PromptLayerIntegritySnapshot;
  recordOrchestrationTraceAcceptedLaunch: (
    input: OrchestrationTraceWriteInput,
  ) => Promise<OrchestrationTraceWriteResult | null>;
  recordOrchestrationTraceCallback: (
    input: OrchestrationTraceWriteInput,
  ) => Promise<OrchestrationTraceWriteResult | null>;
  recordOrchestrationTraceFailedLaunch: (
    input: OrchestrationTraceWriteInput,
  ) => Promise<OrchestrationTraceWriteResult | null>;
  recordOrchestrationTraceLaunch: (
    input: OrchestrationTraceWriteInput,
  ) => Promise<OrchestrationTraceWriteResult | null>;
  recordGlassHiveWorkDetailTrace: (
    input: OrchestrationTraceWriteInput,
  ) => Promise<OrchestrationTraceWriteResult | null>;
  deferGlassHiveWorkStateReconciliation: (
    input: WorkStateReconciliationInput,
  ) => Promise<object | null>;
  reconcileAuthoritativeGlassHiveWorkState: (
    input: WorkStateReconciliationInput,
  ) => Promise<object | null>;
  fetchImpl?: typeof fetch;
}

export function createGlassHiveCallbackBindingService(
  dependencies: GlassHiveCallbackBindingDependencies,
): GlassHiveCallbackBindingService {
  const {
    mongoose,
    logger,
    canonicalizeGlassHiveCallbackRef,
    resolveTelegramMappingByUserId,
    getMessages,
    markUserParallelWorkKnown,
    buildTrustedDelegationIdentity,
    requestAccountApi,
    signTrustedDelegationIdentity,
    normalizeInteractionSourceSegments,
    promptLayerIntegritySnapshot,
    recordOrchestrationTraceAcceptedLaunch,
    recordOrchestrationTraceCallback,
    recordOrchestrationTraceFailedLaunch,
    recordOrchestrationTraceLaunch,
    recordGlassHiveWorkDetailTrace,
    deferGlassHiveWorkStateReconciliation,
    reconcileAuthoritativeGlassHiveWorkState,
    fetchImpl = (...args: Parameters<typeof fetch>) => fetch(...args),
  } = dependencies;

const BINDING_COLLECTION = 'viventium_glasshive_callback_bindings';
const EXTERNAL_WORK_COLLECTION = 'viventium_external_work';
const DEFAULT_LAUNCH_PREPARATION_LEASE_MS = 2 * 60 * 1000;
const DEFAULT_LAUNCH_DISPATCH_AMBIGUITY_LEASE_MS = 2 * 60 * 1000;
const TERMINAL_STATES = Object.freeze(['completed', 'failed', 'cancelled']);
const SETTLED_DELIVERY_STATES = Object.freeze([
  'sent',
  'delivered',
  'acknowledged',
  'silent',
  'suppressed',
]);
const PROTECTED_DELIVERY_STATES = Object.freeze([
  ...SETTLED_DELIVERY_STATES,
  'unknown',
  'unresolved',
  'failed',
]);
const STATE_RECONCILIATION_BATCH = 10;
const HOST_CAPACITY_CODES = new Set([
  'active_worker_conflict',
  'active_worker_limit',
  'host_worker_already_active',
  'host_capacity',
]);
const DESTINATION_SURFACES = new Set(['librechat', 'telegram', 'voice', 'workbench']);
const DELEGATION_CONSTRAINT_FIELDS = Object.freeze([
  'success_criteria',
  'additional_instructions',
  'context',
]);
const OBJECTIVE_IDENTITY_FIELDS = Object.freeze([
  'description',
  'success_criteria',
  'context',
  'title',
  'goal',
  'instruction',
  'additional_instructions',
  'uploaded_files',
  'files',
  'file_ids',
  'project_id',
  'worker_id',
  'workspace_alias',
  'reuse_existing_workspace',
  'run_at',
  'schedule_text',
  'delay_seconds',
]);

async function requireParallelWorkPositiveFence(ownerId: unknown) {
  if (await markUserParallelWorkKnown(normalizeText(ownerId, 160))) return;
  throw Object.assign(new Error('parallel_work_positive_fence_failed'), {
    code: 'parallel_work_positive_fence_failed',
  });
}

const MISSION_ROUTING_IDENTITY_KEYS = new Set([
  'telegramchatid',
  'telegramuserid',
  'telegrammessageid',
  'voicecallsessionid',
  'voicerequestid',
  'callbackurl',
  'callbackhmac',
  'callbackhmacsecret',
  'viventiumdelegationassertion',
]);

function normalizeText(value: unknown, maxLength = 512): string {
  return String(value || '')
    .trim()
    .slice(0, maxLength);
}

function callbackEffectFenceError(code = 'glasshive_callback_effect_fenced'): RuntimeError {
  return Object.assign(new Error(code), { code });
}

function terminalCallbackEffectFence(
  body: RuntimeRecord = {},
  effectFence?: RuntimeRecord | null,
): RuntimeRecord | null {
  const hasTerminalIdentity =
    normalizeText(body.callback_id, 512).startsWith('cb_terminal_') ||
    body.result_revision != null ||
    body.result_digest != null;
  if (!hasTerminalIdentity) return null;
  const callbackId = normalizeText(effectFence?.callbackId, 512);
  const resultKey = normalizeText(effectFence?.resultKey, 80);
  const resultDigest = normalizeText(effectFence?.resultDigest, 80);
  const runId = normalizeText(body.run_id, 160);
  const resultEndedAt = new Date(normalizeText(body.result_ended_at, 128));
  const acceptedOperationId = normalizeText(effectFence?.acceptedOperationId, 64);
  const leaseId = normalizeText(effectFence?.leaseId, 64);
  const resultRevision = Number(effectFence?.resultRevision);
  const generation = Number(effectFence?.generation);
  const acceptedOperationGeneration = Number(
    effectFence?.acceptedOperationGeneration ?? effectFence?.generation,
  );
  if (
    !/^ghtr_[a-f0-9]{64}$/.test(resultKey) ||
    !/^cb_terminal_[a-f0-9]{64}$/.test(callbackId) ||
    !/^sha256:[a-f0-9]{64}$/.test(resultDigest) ||
    !runId ||
    !Number.isFinite(resultEndedAt.getTime()) ||
    !/^[a-f0-9]{32}$/.test(acceptedOperationId) ||
    !/^[a-f0-9]{32}$/.test(leaseId) ||
    !Number.isSafeInteger(resultRevision) ||
    resultRevision < 1 ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !Number.isSafeInteger(acceptedOperationGeneration) ||
    acceptedOperationGeneration < 1 ||
    callbackId !== normalizeText(body.callback_id, 512) ||
    resultDigest !== normalizeText(body.result_digest, 80) ||
    resultRevision !== Number(body.result_revision)
  ) {
    throw callbackEffectFenceError('glasshive_callback_effect_fence_invalid');
  }
  return Object.freeze({
    resultKey,
    callbackId,
    resultDigest,
    runId,
    resultEndedAt,
    acceptedOperationId,
    leaseId,
    resultRevision,
    generation: acceptedOperationGeneration,
    leaseGeneration: generation,
  });
}

function terminalCallbackDestinationFilter(
  filter: RuntimeRecord,
  fence: RuntimeRecord | null,
): RuntimeRecord {
  if (!fence) return filter;
  return {
    $and: [
      filter,
      {
        $or: [
          { terminalCallbackResultRevision: { $exists: false } },
          {
            terminalCallbackResultRevision: fence.resultRevision,
            terminalCallbackId: fence.callbackId,
            terminalCallbackResultDigest: fence.resultDigest,
            terminalCallbackAcceptedOperationId: fence.acceptedOperationId,
            $or: [
              { terminalCallbackEffectLeaseGeneration: { $exists: false } },
              { terminalCallbackEffectLeaseGeneration: { $lte: fence.generation } },
            ],
          },
          { terminalCallbackResultEndedAt: { $lt: fence.resultEndedAt } },
          {
            terminalCallbackResultEndedAt: fence.resultEndedAt,
            terminalCallbackResultRevision: { $lt: fence.resultRevision },
          },
          {
            terminalCallbackResultEndedAt: { $exists: false },
            $or: [{ updatedAt: { $exists: false } }, { updatedAt: { $lt: fence.resultEndedAt } }],
          },
        ],
      },
    ],
  };
}

function terminalCallbackDestinationFields(fence: RuntimeRecord | null): RuntimeRecord {
  if (!fence) return {};
  return {
    terminalCallbackResultRevision: fence.resultRevision,
    terminalCallbackId: fence.callbackId,
    terminalCallbackResultDigest: fence.resultDigest,
    terminalCallbackRunId: fence.runId,
    terminalCallbackResultEndedAt: fence.resultEndedAt,
    terminalCallbackAcceptedOperationId: fence.acceptedOperationId,
    terminalCallbackEffectLeaseId: fence.leaseId,
    terminalCallbackEffectLeaseGeneration: fence.generation,
  };
}

function requireFencedDestinationWrite<T extends RuntimeRecord>(
  result: T,
  fence: RuntimeRecord | null,
): T {
  if (fence && Number(result?.matchedCount) === 0) {
    throw callbackEffectFenceError();
  }
  return result;
}

function requireFencedDestinationDocument(
  result: RuntimeRecord | null,
  fence: RuntimeRecord | null,
): RuntimeRecord | null {
  const document =
    result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
  if (fence && !document) throw callbackEffectFenceError();
  return document;
}

function truthyFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return ['1', 'true', 'yes', 'on'].includes(normalizeText(value, 16).toLowerCase());
}

function launchPreparationLeaseMs() {
  const configured = Number(process.env.VIVENTIUM_GLASSHIVE_LAUNCH_PREPARATION_LEASE_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_LAUNCH_PREPARATION_LEASE_MS;
  }
  return Math.max(10_000, Math.min(Math.floor(configured), 10 * 60 * 1000));
}

function launchDispatchAmbiguityLeaseMs() {
  const configured = Number(process.env.VIVENTIUM_GLASSHIVE_LAUNCH_DISPATCH_LEASE_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_LAUNCH_DISPATCH_AMBIGUITY_LEASE_MS;
  }
  return Math.max(10_000, Math.min(Math.floor(configured), 10 * 60 * 1000));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as RuntimeRecord;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function opaqueRef(prefix: string, ...parts: unknown[]): string {
  const digest = crypto
    .createHash('sha256')
    .update(parts.map((part) => normalizeText(part, 4096)).join('\0'))
    .digest('hex')
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function callbackBindingCollection() {
  return mongoose.connection.collection(BINDING_COLLECTION);
}

function externalWorkCollection() {
  return mongoose.connection.collection(EXTERNAL_WORK_COLLECTION);
}

function callbackTraceAt(body: RuntimeRecord = {}): Date | null {
  const value = body.callback_ts;
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const parsed = new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function callbackTraceIdentity(
  body: RuntimeRecord = {},
  trustedIdentity: RuntimeRecord | null = null,
): Readonly<RuntimeRecord> | null {
  const callbackId = normalizeText(body.callback_id, 512);
  const event = normalizeText(body.event, 64).toLowerCase();
  const workState = canonicalGlassHiveWorkState(body) || callbackWorkState(body);
  const preRuntimeTerminal =
    body.attempt_number == null &&
    isGlassHiveWorkTerminalCallback(body) &&
    ['failed', 'cancelled'].includes(workState) &&
    ['run.failed', 'run.cancelled', 'run.interrupted'].includes(event);
  const attemptNumber = preRuntimeTerminal ? null : Number(body.attempt_number);
  if (
    !callbackId ||
    (!preRuntimeTerminal && (!Number.isSafeInteger(attemptNumber) || Number(attemptNumber) < 1))
  )
    return null;
  const callbackRef = canonicalizeGlassHiveCallbackRef(callbackId);
  if (
    trustedIdentity &&
    (normalizeText(trustedIdentity.callbackRef, 96) !== callbackRef ||
      (trustedIdentity.attemptNumber == null
        ? attemptNumber !== null
        : Number(trustedIdentity.attemptNumber) !== attemptNumber))
  ) {
    return null;
  }
  return Object.freeze({
    callbackRef: trustedIdentity ? normalizeText(trustedIdentity.callbackRef, 96) : callbackRef,
    attemptNumber:
      trustedIdentity && trustedIdentity.attemptNumber != null
        ? Number(trustedIdentity.attemptNumber)
        : attemptNumber,
  });
}

function normalizedChannels(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const seen = new Set();
  const channels = [];
  for (const item of values) {
    const surface = normalizeText(item, 32).toLowerCase();
    if (!DESTINATION_SURFACES.has(surface) || seen.has(surface)) continue;
    seen.add(surface);
    channels.push(surface);
  }
  return channels;
}

function configuredDestinationsFromRequest(requestBody: RuntimeRecord = {}): RuntimeRecord[] {
  const scheduledChannels = normalizedChannels(
    requestBody.viventiumSchedulerDeliveryChannels || requestBody.deliveryChannels,
  );
  if (scheduledChannels.length) {
    return scheduledChannels.map((surface) => ({ surface }));
  }

  const surface = normalizeText(requestBody.viventiumSurface, 32).toLowerCase();
  const destinations = [];
  if (surface === 'telegram') {
    destinations.push({
      surface: 'telegram',
      telegramChatId: normalizeText(requestBody.viventiumTelegramChatId),
      telegramUserId: normalizeText(requestBody.viventiumTelegramUserId),
      telegramMessageId: normalizeText(requestBody.viventiumTelegramMessageId),
    });
  } else if (surface === 'voice') {
    destinations.push({
      surface: 'voice',
      voiceCallSessionId: normalizeText(requestBody.viventiumVoiceCallSessionId),
      voiceRequestId: normalizeText(requestBody.viventiumVoiceRequestId),
    });
  }
  destinations.push({ surface: 'librechat' });
  return destinations;
}

function fingerprintObjectiveValue(value: unknown): { bytes: number; sha256: string } {
  const canonical = stableStringify(value);
  const serialized = typeof canonical === 'string' ? canonical : String(canonical);
  return {
    bytes: Buffer.byteLength(serialized, 'utf8'),
    sha256: crypto.createHash('sha256').update(serialized, 'utf8').digest('hex'),
  };
}

function delegationLaunchPayloadDigest(args: RuntimeRecord = {}): string {
  const canonical = stableStringify({
    alias: normalizeText(args.alias),
    backend: normalizeText(args.backend),
    bootstrap_profile: normalizeText(args.bootstrap_profile || args.bootstrapProfile),
    connected_account_content_intent: truthyFlag(args.connected_account_content_intent),
    effort: normalizeText(args.effort),
    execution_mode: normalizeText(args.execution_mode || args.executionMode),
    expose_diagnostics: truthyFlag(args.expose_diagnostics),
    goal: normalizeText(args.goal, 100_000),
    instruction: normalizeText(args.instruction, 100_000),
    owner_id: normalizeText(args.owner_id, 160),
    profile: normalizeText(args.profile, 160),
    project_id: normalizeText(args.project_id, 160),
    require_callback: truthyFlag(args.require_callback),
    reuse_existing_workspace: truthyFlag(args.reuse_existing_workspace),
    title: normalizeText(args.title, 10_000),
    worker_name: normalizeText(args.worker_name || args.workerName, 10_000),
    worker_role: normalizeText(args.worker_role || args.workerRole, 10_000),
    workspace_root: normalizeText(args.workspace_root || args.workspaceRoot, 10_000),
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Bind all user-objective and file-reference fields while storing no raw objective text. */
function canonicalObjectiveIdentity(toolName: unknown, args: RuntimeRecord = {}): string {
  const fields: RuntimeRecord = {};
  for (const key of OBJECTIVE_IDENTITY_FIELDS) {
    if (args[key] == null) continue;
    fields[key] = fingerprintObjectiveValue(args[key]);
  }
  return stableStringify({
    version: 1,
    tool_name: normalizeText(toolName, 80),
    fields,
  });
}

function trustedSourceEventId(requestBody: RuntimeRecord = {}): string {
  return normalizeText(
    requestBody.viventiumSourceEventId ||
      requestBody.viventiumLogicalTurnId ||
      requestBody.viventiumSchedulerOccurrenceKey ||
      requestBody.messageId ||
      requestBody.message_id,
    512,
  );
}

function trustedCallKey(toolCall: RuntimeRecord = {}): string {
  const id = normalizeText(
    toolCall.id || toolCall.tool_call_id || toolCall.toolCallId || toolCall.call_id,
    256,
  );
  const stepId = normalizeText(toolCall.stepId || toolCall.step_id, 256);
  if (!id && !stepId) return '';
  // The provider call id is the durable identity. A generated UI step is only a fallback for
  // harnesses that cannot expose one; invocation counters are presentation metadata, not identity.
  return stableStringify(id ? { id } : { step_id: stepId });
}

/**
 * Provider call identifiers are runtime-owned metadata, not model tool arguments. The digest is
 * stable across reconstructed requests; separate provider calls stay distinct even with identical
 * tool arguments. Ordinal is presentation metadata and never the durable idempotency anchor.
 */
function resolveTrustedGlassHiveCallIdentity(
  { requestBody = {}, toolCall = {} }: RuntimeRecord = {},
): RuntimeRecord {
  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
    throw new Error('glasshive_trusted_request_identity_missing');
  }
  const sourceEventId = trustedSourceEventId(requestBody);
  const callKey = trustedCallKey(toolCall);
  if (!sourceEventId || !callKey) {
    throw new Error('glasshive_trusted_call_identity_missing');
  }
  const callIdentityDigest = crypto.createHash('sha256').update(callKey, 'utf8').digest('hex');
  const providerTurn = Number(toolCall?.turn);
  const objectiveOrdinal =
    Number.isInteger(providerTurn) && providerTurn >= 0
      ? providerTurn
      : Number.parseInt(callIdentityDigest.slice(0, 8), 16);
  return {
    sourceEventId,
    objectiveOrdinal,
    callIdentityDigest,
  };
}

function trustedTriggeringSourceSegments(requestBody: RuntimeRecord = {}): RuntimeRecord {
  const candidates = Array.isArray(requestBody.viventiumTriggeringSourceSegments)
    ? requestBody.viventiumTriggeringSourceSegments
    : [];
  const fallbackSourceEventId = trustedSourceEventId(requestBody);
  const normalized = normalizeInteractionSourceSegments(
    candidates.map((candidate: RuntimeRecord, sourceIndex: number) => ({
      ...candidate,
      source_event_id: normalizeText(candidate?.source_event_id, 160) || fallbackSourceEventId,
      source_index: Number.isInteger(Number(candidate?.source_index))
        ? Number(candidate.source_index)
        : Number.isInteger(Number(candidate?.ordinal))
          ? Number(candidate.ordinal)
          : sourceIndex,
    })),
    requestBody.viventiumTriggeringSourceSegmentsOverflowCount,
  );
  return {
    segments: normalized.segments.map((segment: RuntimeRecord) => ({
      // GlassHive treats this as a strict text-provenance contract. Attachment descriptors cross
      // the launch boundary separately through the trusted `uploaded_files` projection.
      ordinal: segment.ordinal,
      source_event_id: segment.source_event_id,
      source_index: segment.source_index,
      text: segment.text,
      ...(segment.truncated === true ? { truncated: true } : {}),
      ...(normalizeText(segment.original_sha256, 64)
        ? { original_sha256: normalizeText(segment.original_sha256, 64).toLowerCase() }
        : {}),
    })),
    overflowCount: normalized.overflowCount,
  };
}

function exactMessageById(messages: unknown): RuntimeRecord | null {
  const byId = new Map<string, RuntimeRecord>();
  for (const message of Array.isArray(messages) ? messages : []) {
    const messageId = normalizeText(message?.messageId, 160);
    if (messageId) byId.set(messageId, message);
  }
  return byId.size === 1 ? Array.from(byId.values())[0] : null;
}

function selectedSourceAnchorUnavailable(): RuntimeError {
  return Object.assign(new Error('glasshive_selected_source_anchor_unavailable'), {
    code: 'glasshive_selected_source_anchor_unavailable',
  });
}

async function resolveTrustedCurrentRevisionAnchor({
  ownerId,
  conversationId,
  requestBody,
  sourceEventId,
  authoringSourceEventId,
  currentAnchorMessageId,
  currentParentMessageId,
}: RuntimeRecord): Promise<RuntimeRecord> {
  const selectedSourceIsInCurrentRevision = trustedTriggeringSourceSegments(
    requestBody,
  ).segments.some((segment: RuntimeRecord) => segment.source_event_id === sourceEventId);
  if (
    !selectedSourceIsInCurrentRevision ||
    !authoringSourceEventId ||
    !currentAnchorMessageId ||
    !currentParentMessageId
  ) {
    throw selectedSourceAnchorUnavailable();
  }

  const currentUsers = await getMessages(
    {
      user: ownerId,
      conversationId,
      messageId: currentParentMessageId,
      isCreatedByUser: true,
      'metadata.viventium.interactionContext.source_event_id': authoringSourceEventId,
    },
    'messageId parentMessageId isCreatedByUser createdAt',
  );
  const currentUser = exactMessageById(currentUsers);
  if (normalizeText(currentUser?.messageId, 160) !== currentParentMessageId) {
    throw selectedSourceAnchorUnavailable();
  }

  const currentAssistants = await getMessages(
    {
      user: ownerId,
      conversationId,
      messageId: currentAnchorMessageId,
      parentMessageId: currentParentMessageId,
      isCreatedByUser: false,
    },
    'messageId parentMessageId isCreatedByUser createdAt',
  );
  const currentAssistant = exactMessageById(currentAssistants);
  if (normalizeText(currentAssistant?.messageId, 160) !== currentAnchorMessageId) {
    throw selectedSourceAnchorUnavailable();
  }
  return {
    anchorMessageId: currentAnchorMessageId,
    requestedParentMessageId: currentParentMessageId,
  };
}

async function resolveTrustedLaunchAnchor({
  ownerId,
  conversationId,
  requestBody,
  sourceEventId,
}: RuntimeRecord): Promise<RuntimeRecord> {
  const currentAnchorMessageId = normalizeText(
    requestBody.messageId || requestBody.message_id,
    160,
  );
  const currentParentMessageId = normalizeText(
    requestBody.parentMessageId || requestBody.parent_message_id,
    160,
  );
  const authoringSourceEventId = normalizeText(requestBody.viventiumAuthoringSourceEventId, 160);
  if (!authoringSourceEventId || authoringSourceEventId === sourceEventId) {
    return {
      anchorMessageId: currentAnchorMessageId,
      requestedParentMessageId: currentParentMessageId,
    };
  }

  const selectedUsers = await getMessages(
    {
      user: ownerId,
      conversationId,
      isCreatedByUser: true,
      'metadata.viventium.interactionContext.source_event_id': sourceEventId,
    },
    'messageId parentMessageId isCreatedByUser createdAt',
  );
  const selectedUser = exactMessageById(selectedUsers);
  const selectedUserMessageId = normalizeText(selectedUser?.messageId, 160);
  if (!selectedUserMessageId) {
    return resolveTrustedCurrentRevisionAnchor({
      ownerId,
      conversationId,
      requestBody,
      sourceEventId,
      authoringSourceEventId,
      currentAnchorMessageId,
      currentParentMessageId,
    });
  }

  const selectedAssistants = await getMessages(
    {
      user: ownerId,
      conversationId,
      isCreatedByUser: false,
      parentMessageId: selectedUserMessageId,
    },
    'messageId parentMessageId isCreatedByUser createdAt',
  );
  const selectedAssistant = exactMessageById(selectedAssistants);
  const selectedAssistantMessageId = normalizeText(selectedAssistant?.messageId, 160);
  if (!selectedAssistantMessageId) {
    return resolveTrustedCurrentRevisionAnchor({
      ownerId,
      conversationId,
      requestBody,
      sourceEventId,
      authoringSourceEventId,
      currentAnchorMessageId,
      currentParentMessageId,
    });
  }
  return {
    anchorMessageId: selectedAssistantMessageId,
    requestedParentMessageId: selectedUserMessageId,
  };
}

function buildTrustedDelegationContext(
  requestBody: RuntimeRecord = {},
  sourceEventId: unknown,
): RuntimeRecord {
  const logicalTurnId = normalizeText(requestBody.viventiumLogicalTurnId, 512);
  const surface = normalizeText(requestBody.viventiumSurface, 32).toLowerCase();
  const triggeringSources = trustedTriggeringSourceSegments(requestBody);
  return {
    version: 1,
    source_event_id: sourceEventId,
    ...(logicalTurnId ? { logical_turn_id: logicalTurnId } : {}),
    ...(DESTINATION_SURFACES.has(surface) ? { surface } : {}),
    triggering_source_segments: triggeringSources.segments,
    ...(triggeringSources.overflowCount > 0
      ? { source_segments_overflow_count: triggeringSources.overflowCount }
      : {}),
  };
}

function normalizedPacketText(value: unknown, maxLength = 100_000): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function packetSourceSegments(context: RuntimeRecord = {}): RuntimeRecord[] {
  return (
    Array.isArray(context.triggering_source_segments) ? context.triggering_source_segments : []
  ).map((segment: RuntimeRecord, ordinal: number) => ({
    ordinal,
    text: typeof segment?.text === 'string' ? segment.text : '',
    ...(segment?.truncated === true ? { truncated: true } : {}),
    ...(segment?.truncated === true && /^[a-f0-9]{64}$/.test(String(segment.original_sha256 || ''))
      ? { original_sha256: String(segment.original_sha256).toLowerCase() }
      : {}),
  }));
}

function selectedFileName(value: unknown): string {
  const record = value && typeof value === 'object' ? (value as RuntimeRecord) : {};
  const candidate =
    typeof value === 'string'
      ? value
      : record.filename || record.name || record.relative_path || record.path || '';
  return normalizedPacketText(candidate, 512).split(/[\\/]/).filter(Boolean).pop() || '';
}

function packetSelectedFiles(args: RuntimeRecord = {}): RuntimeRecord[] {
  const candidates = [
    ...(Array.isArray(args.uploaded_files) ? args.uploaded_files : []),
    ...(Array.isArray(args.files) ? args.files : []),
  ];
  return candidates.reduce<RuntimeRecord[]>((selected, candidate) => {
    const name = selectedFileName(candidate);
    const ref = normalizedPacketText(
      typeof candidate === 'object' && candidate
        ? candidate.file_id || candidate.fileId || candidate.id
        : '',
      512,
    );
    if (!name && !ref) return selected;
    selected.push({
      ordinal: selected.length,
      ...(name ? { name } : {}),
      ...(!name && ref ? { ref } : {}),
    });
    return selected;
  }, []);
}

function packetExplicitConstraints(args: RuntimeRecord = {}): RuntimeRecord[] {
  return DELEGATION_CONSTRAINT_FIELDS.reduce<RuntimeRecord[]>((constraints, kind) => {
    const text = normalizedPacketText(args[kind]);
    if (text) constraints.push({ kind, text });
    return constraints;
  }, []);
}

function buildTrustedDelegationPacket(
  args: RuntimeRecord = {},
  context: RuntimeRecord = {},
): RuntimeRecord {
  const instruction = normalizedPacketText(args.instruction || args.description);
  const task = {
    ...(normalizedPacketText(args.title, 10_000)
      ? { title: normalizedPacketText(args.title, 10_000) }
      : {}),
    ...(instruction ? { instruction } : {}),
    ...(normalizedPacketText(args.goal) ? { goal: normalizedPacketText(args.goal) } : {}),
    source_segments: packetSourceSegments(context),
  };
  return {
    version: 1,
    task,
    explicit_constraints: packetExplicitConstraints(args),
    selected_files: packetSelectedFiles(args),
  };
}

function authorizedToolContext(bundle: RuntimeRecord = {}): RuntimeRecord | null {
  const broker =
    bundle.glasshive_capability_broker &&
    typeof bundle.glasshive_capability_broker === 'object' &&
    !Array.isArray(bundle.glasshive_capability_broker)
      ? bundle.glasshive_capability_broker
      : null;
  if (!broker) return null;
  const uniqueTextList = (value: unknown): string[] =>
    Array.from(
      new Set(
        (Array.isArray(value) ? value : [])
          .map((item: unknown) => normalizedPacketText(item, 160))
          .filter(Boolean),
      ),
    ).sort();
  const status = normalizedPacketText(broker.status, 40).toLowerCase();
  return {
    broker: normalizedPacketText(broker.name, 160) || 'glasshive-user-capabilities',
    status: status || 'available',
    servers: uniqueTextList(broker.allowed_servers),
    host_tools: uniqueTextList(broker.allowed_host_tools),
    content_read: broker.scopes?.content_read === true || broker.scopes?.contentRead === true,
  };
}

function finalizeTrustedDelegationPacket(
  packet: RuntimeRecord = {},
  bundle: RuntimeRecord = {},
): RuntimeRecord {
  const toolContext = authorizedToolContext(bundle);
  return {
    version: 1,
    task: packet.task || {},
    explicit_constraints: Array.isArray(packet.explicit_constraints)
      ? packet.explicit_constraints
      : [],
    selected_files: Array.isArray(packet.selected_files) ? packet.selected_files : [],
    ...(toolContext ? { authorized_tool_context: toolContext } : {}),
  };
}

async function registerGlassHiveLaunchContext({
  user,
  requestBody = {},
  toolName = '',
  toolArguments = {},
  toolCall = {},
}: RuntimeRecord = {}): Promise<RuntimeRecord | null> {
  const ownerId = normalizeText(user?.id || user?._id);
  const conversationId = normalizeText(requestBody.conversationId || requestBody.conversation_id);
  const currentAnchorMessageId = normalizeText(requestBody.messageId || requestBody.message_id);
  if (!ownerId || !conversationId || !currentAnchorMessageId) {
    return null;
  }

  const destinations = configuredDestinationsFromRequest(requestBody);
  const args =
    toolArguments && typeof toolArguments === 'object' && !Array.isArray(toolArguments)
      ? toolArguments
      : {};
  const trustedCallIdentity = resolveTrustedGlassHiveCallIdentity({ requestBody, toolCall });
  const { sourceEventId, objectiveOrdinal, callIdentityDigest } = trustedCallIdentity;
  const { anchorMessageId, requestedParentMessageId } = await resolveTrustedLaunchAnchor({
    ownerId,
    conversationId,
    requestBody,
    sourceEventId,
  });
  const canonicalObjective = canonicalObjectiveIdentity(toolName, args);
  const trustedDelegation = buildTrustedDelegationIdentity({
    ownerId,
    sourceEventId,
    objectiveOrdinal,
    callIdentityDigest,
    goal: canonicalObjective,
  });
  const objectiveDigest = trustedDelegation.goalDigest;
  const delegationIdentity = {
    version: 1,
    idempotency_key: trustedDelegation.idempotencyKey,
    goal_digest: objectiveDigest,
    source_event_id: sourceEventId,
    objective_ordinal: objectiveOrdinal,
    call_identity_digest: callIdentityDigest,
  };
  const delegationContext = buildTrustedDelegationContext(requestBody, sourceEventId);
  const delegationPacket = buildTrustedDelegationPacket(args, delegationContext);
  /* === VIVENTIUM START ===
   * Feature: Durable launch intent identity.
   * Purpose: This Core-owned ref identifies the dispatch intent and delivery contract only. It is
   * never presented as GlassHive work identity; the authoritative workRef is bound after dispatch
   * or repaired from a verified callback when the launch response was lost.
   * === VIVENTIUM END === */
  const originRef = opaqueRef('ghi', ownerId, sourceEventId, callIdentityDigest, objectiveDigest);
  const bindingId = originRef;
  const schedulerDispatchDocumentId = normalizeText(
    requestBody.viventiumSchedulerDispatchDocumentId,
  );
  const scheduleOccurrenceKey = normalizeText(requestBody.viventiumSchedulerOccurrenceKey);
  const scheduleId = normalizeText(requestBody.viventiumScheduleId || requestBody.scheduleId);
  const requiredExternalWork =
    Boolean(schedulerDispatchDocumentId || scheduleOccurrenceKey) &&
    requestBody.viventiumSchedulerExternalWorkRequired === true;
  const now = new Date();
  const preparationExpiresAt = new Date(now.getTime() + launchPreparationLeaseMs());
  await callbackBindingCollection().updateOne(
    { _id: bindingId },
    {
      $setOnInsert: {
        _id: bindingId,
        bindingId,
        ownerId,
        conversationId,
        anchorMessageId,
        requestedParentMessageId,
        configuredDestinations: destinations,
        schedulerDispatchDocumentId,
        scheduleOccurrenceKey,
        scheduleId,
        originRef,
        workRef: '',
        launchState: 'prepared',
        preparationExpiresAt,
        sourceEventId,
        objectiveOrdinal,
        objectiveDigest,
        callIdentityDigest,
        mainAgentId: normalizeText(
          requestBody.agent_id || requestBody.agentId || requestBody.endpointOption?.agent_id,
          160,
        ),
        createdAt: now,
      },
      $set: {
        updatedAt: now,
      },
    },
    { upsert: true },
  );

  await externalWorkCollection().updateOne(
    { _id: originRef },
    {
      $setOnInsert: {
        _id: originRef,
        originRef,
        workRef: '',
        ownerId,
        conversationId,
        anchorMessageId,
        requestedParentMessageId,
        deliveryBindingId: originRef,
        schedulerDispatchDocumentId,
        scheduleOccurrenceKey,
        scheduleId,
        sourceEventId,
        objectiveOrdinal,
        objectiveDigest,
        callIdentityDigest,
        required: requiredExternalWork,
        configuredDestinations: destinations.map(({ surface }) => surface),
        externalState: 'preparing',
        launchState: 'prepared',
        preparationExpiresAt,
        workerId: '',
        runId: '',
        createdAt: now,
      },
      $set: { updatedAt: now },
    },
    { upsert: true },
  );

  await recordOrchestrationTraceLaunch({
    ownerId,
    originRef,
    sourceEventRef: sourceEventId,
    logicalTurnRef: normalizeText(
      requestBody.viventiumLogicalTurnId ||
        requestBody?.viventiumInteractionContext?.logical_turn_id,
      512,
    ),
    promptLayers: promptLayerIntegritySnapshot(),
    at: now,
  });

  logger.info('[VIVENTIUM][glasshive-binding] launch bound', {
    bindingId,
    originRef,
    ownerId,
    sourceEventId,
    objectiveOrdinal,
    scheduled: Boolean(scheduleOccurrenceKey),
    required: requiredExternalWork,
    destinations: destinations.map(({ surface }) => surface),
  });
  return {
    bindingId,
    originRef,
    sourceEventId,
    objectiveOrdinal,
    objectiveDigest,
    callIdentityDigest,
    delegationIdentity,
    delegationContext,
    delegationPacket,
    ownerId,
    schedulerDispatchDocumentId,
    scheduleOccurrenceKey,
    required: requiredExternalWork,
  };
}

async function resolveTelegramDestination(
  ownerId: unknown,
  destination: RuntimeRecord = {},
): Promise<RuntimeRecord> {
  const boundChatId = normalizeText(destination.telegramChatId);
  const boundUserId = normalizeText(destination.telegramUserId);
  if (boundChatId || boundUserId) {
    return {
      surface: 'telegram',
      telegramChatId: boundChatId || boundUserId,
      telegramUserId: boundUserId || boundChatId,
      ...(destination.telegramMessageId
        ? { telegramMessageId: normalizeText(destination.telegramMessageId) }
        : {}),
    };
  }
  const mapping = await resolveTelegramMappingByUserId({
    libreChatUserId: normalizeText(ownerId, 160),
  });
  const telegramUserId = normalizeText(mapping?.telegramUserId);
  const telegramChatId = normalizeText(mapping?.telegramChatId || telegramUserId);
  if (!telegramUserId || !telegramChatId) {
    return { surface: 'telegram', unresolvedReason: 'telegram_mapping_not_found' };
  }
  return { surface: 'telegram', telegramChatId, telegramUserId };
}

function parseJsonObject(value: unknown): RuntimeRecord | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 256 * 1024) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripMissionRoutingIdentity(value: unknown, depth = 0): unknown {
  if (depth > 12 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripMissionRoutingIdentity(item, depth + 1));
  }
  const clean: RuntimeRecord = {};
  for (const [key, child] of Object.entries(value)) {
    const canonicalKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (MISSION_ROUTING_IDENTITY_KEYS.has(canonicalKey)) continue;
    clean[key] = stripMissionRoutingIdentity(child, depth + 1);
  }
  return clean;
}

function glassHiveLaunchOriginFromArguments(toolArguments: unknown): string {
  const args = parseJsonObject(toolArguments);
  if (!args) return '';
  const bundle = parseJsonObject(args.bootstrap_bundle_json);
  return normalizeText(bundle?.callbacks?.origin_ref, 160);
}

/** Attach the Core-owned launch intent after reading any model-provided bundle. */
function attachGlassHiveLaunchOrigin(toolArguments: unknown, originRef: unknown): unknown {
  const args = parseJsonObject(toolArguments);
  const normalizedOriginRef = normalizeText(originRef, 160);
  if (!args || !normalizedOriginRef) return toolArguments;
  args.bootstrap_bundle_json = {
    // Callback URL, HMAC, surface identity, and anchors come only from trusted server config.
    // This lower-level boundary preserves no model-supplied bundle fields.
    callbacks: { origin_ref: normalizedOriginRef },
  };
  return typeof toolArguments === 'string' ? JSON.stringify(args) : args;
}

/**
 * Overwrite every launch-security field after parsing the model's bundle. This is the sole helper
 * used by the MCP dispatch path; protected values always come from Core registration.
 */
function attachGlassHiveTrustedLaunchMetadata(
  toolArguments: unknown,
  launchContext: RuntimeRecord = {},
  trustedBootstrapBundle: RuntimeRecord = {},
): unknown {
  const originRef = normalizeText(launchContext.originRef, 160);
  const identity = launchContext.delegationIdentity;
  const context = launchContext.delegationContext;
  const ordinal = Number(identity?.objective_ordinal);
  const callIdentityDigest = normalizeText(identity?.call_identity_digest, 64).toLowerCase();
  if (
    !originRef ||
    identity?.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(normalizeText(identity.idempotency_key, 64).toLowerCase()) ||
    !/^[a-f0-9]{64}$/.test(normalizeText(identity.goal_digest, 64).toLowerCase()) ||
    !/^[a-f0-9]{64}$/.test(callIdentityDigest) ||
    !normalizeText(identity.source_event_id, 512) ||
    !Number.isInteger(ordinal) ||
    ordinal < 0 ||
    context?.version !== 1 ||
    normalizeText(context.source_event_id, 512) !== normalizeText(identity.source_event_id, 512) ||
    !Array.isArray(context.triggering_source_segments)
  ) {
    throw new Error('glasshive_trusted_launch_metadata_invalid');
  }
  const args = parseJsonObject(toolArguments);
  if (!args) throw new Error('glasshive_launch_arguments_invalid');
  // The model-supplied bundle is never a prompt authority. The caller must pass the exact
  // server-built capability/Feelings bundle separately after trusted projection is complete.
  const bundle = parseJsonObject(trustedBootstrapBundle) || {};
  const triggeringSources = trustedTriggeringSourceSegments({
    viventiumSourceEventId: context.source_event_id,
    viventiumTriggeringSourceSegments: context.triggering_source_segments,
    viventiumTriggeringSourceSegmentsOverflowCount: context.source_segments_overflow_count,
  });
  const cleanBundle = stripMissionRoutingIdentity(bundle) as RuntimeRecord;
  const packetBase = launchContext.delegationPacket || buildTrustedDelegationPacket(args, context);
  const trustedIdentity = {
    version: 2,
    idempotency_key: normalizeText(identity.idempotency_key, 64).toLowerCase(),
    goal_digest: normalizeText(identity.goal_digest, 64).toLowerCase(),
    launch_payload_digest: delegationLaunchPayloadDigest(args),
    source_event_id: normalizeText(identity.source_event_id, 512),
    objective_ordinal: ordinal,
    call_identity_digest: callIdentityDigest,
  };
  args.bootstrap_bundle_json = {
    ...cleanBundle,
    callbacks: { origin_ref: originRef },
    viventium_delegation_identity: trustedIdentity,
    viventium_delegation_assertion: signTrustedDelegationIdentity(trustedIdentity, {
      ownerId: launchContext.ownerId,
    }),
    viventium_delegation_context: {
      version: 1,
      source_event_id: normalizeText(context.source_event_id, 512),
      ...(normalizeText(context.logical_turn_id, 512)
        ? { logical_turn_id: normalizeText(context.logical_turn_id, 512) }
        : {}),
      ...(DESTINATION_SURFACES.has(normalizeText(context.surface, 32).toLowerCase())
        ? { surface: normalizeText(context.surface, 32).toLowerCase() }
        : {}),
      triggering_source_segments: triggeringSources.segments,
      ...(triggeringSources.overflowCount > 0
        ? { source_segments_overflow_count: triggeringSources.overflowCount }
        : {}),
    },
    viventium_delegation_packet: finalizeTrustedDelegationPacket(
      packetBase as RuntimeRecord,
      cleanBundle,
    ),
  };
  return typeof toolArguments === 'string' ? JSON.stringify(args) : args;
}

function findAuthoritativeWorkRef(
  value: unknown,
  depth = 0,
  visited = new Set<object>(),
): string {
  if (depth > 8 || value == null) return '';
  if (typeof value === 'string') {
    const parsed = parseJsonObject(value);
    return parsed ? findAuthoritativeWorkRef(parsed, depth + 1, visited) : '';
  }
  if (typeof value !== 'object' || visited.has(value)) return '';
  visited.add(value);
  if (!Array.isArray(value)) {
    const record = value as RuntimeRecord;
    const direct = normalizeText(record.work_ref || record.workRef, 160);
    if (direct) return direct;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findAuthoritativeWorkRef(child, depth + 1, visited);
    if (found) return found;
  }
  return '';
}

async function reconcileGlassHiveLaunchResult(
  { toolArguments, result }: RuntimeRecord = {},
): Promise<RuntimeRecord | null> {
  const originRef = glassHiveLaunchOriginFromArguments(toolArguments);
  const workRef = findAuthoritativeWorkRef(result);
  if (!originRef || !workRef) return null;
  const now = new Date();
  const filter = { _id: originRef, $or: [{ workRef: '' }, { workRef }] };
  const binding = await callbackBindingCollection().findOne({ _id: originRef });
  await callbackBindingCollection().updateOne(filter, {
    $set: { workRef, launchState: 'accepted', updatedAt: now },
    $unset: { dispatchExpiresAt: 1 },
  });
  await externalWorkCollection().updateOne(filter, {
    $set: { workRef, launchState: 'accepted', updatedAt: now },
    $unset: { dispatchExpiresAt: 1 },
  });
  if (binding?.ownerId) {
    await recordOrchestrationTraceAcceptedLaunch({
      ownerId: normalizeText(binding.ownerId, 160),
      originRef,
      workRef,
      at: now,
    });
  }
  return { originRef, workRef };
}

/** Mark a fully prepared launch immediately before the MCP transport may observe it. */
async function markGlassHiveLaunchDispatchReady(
  launchContext: RuntimeRecord = {},
): Promise<RuntimeRecord | null> {
  const originRef = normalizeText(launchContext.originRef, 160);
  const ownerId = normalizeText(launchContext.ownerId, 160);
  if (!originRef || !ownerId) return null;
  const now = new Date();
  const dispatchExpiresAt = new Date(now.getTime() + launchDispatchAmbiguityLeaseMs());
  const filter = {
    _id: originRef,
    workRef: '',
    launchState: { $in: ['prepared', 'not_dispatched'] },
  };
  const bindingUpdate = {
    $set: { launchState: 'dispatch_ready', dispatchExpiresAt, updatedAt: now },
    $unset: { preparationExpiresAt: 1, preDispatchFailureCode: 1, preDispatchFailedAt: 1 },
  };
  const workUpdate = {
    $set: {
      launchState: 'dispatch_ready',
      externalState: 'accepted',
      dispatchExpiresAt,
      updatedAt: now,
    },
    $unset: {
      preparationExpiresAt: 1,
      preDispatchFailureCode: 1,
      preDispatchFailedAt: 1,
      terminalAt: 1,
    },
  };
  await callbackBindingCollection().updateOne(filter, bindingUpdate);
  await externalWorkCollection().updateOne(filter, workUpdate);
  // This hint is set only after every Core-side prerequisite has succeeded. From here onward an
  // MCP transport error is ambiguous and the ordinary dispatch_unknown reconciler owns it.
  await requireParallelWorkPositiveFence(ownerId);
  return { originRef, launchState: 'dispatch_ready' };
}

/** Close a launch that provably failed before dispatch or was verified absent after its lease. */
async function markGlassHiveLaunchPreDispatchFailed(
  launchContext: RuntimeRecord = {},
  error?: RuntimeError | RuntimeRecord,
): Promise<RuntimeRecord | null> {
  const originRef = normalizeText(launchContext.originRef, 160);
  const ownerId = normalizeText(launchContext.ownerId, 160);
  if (!originRef || !ownerId) return null;
  const now = new Date();
  const failureCode = normalizeText(
    error?.code || error?.name || 'launch_pre_dispatch_failed',
    120,
  );
  const filter = {
    _id: originRef,
    workRef: '',
    launchState: { $in: ['prepared', 'dispatch_ready', 'dispatch_unknown'] },
  };
  const common = {
    launchState: 'not_dispatched',
    preDispatchFailureCode: failureCode,
    preDispatchFailedAt: now,
    updatedAt: now,
  };
  await callbackBindingCollection().updateOne(filter, {
    $set: common,
    $unset: { preparationExpiresAt: 1, dispatchExpiresAt: 1 },
  });
  await externalWorkCollection().updateOne(filter, {
    $set: {
      ...common,
      externalState: 'failed',
      terminalAt: now,
      attentionPending: true,
      deliveryState: 'failed',
    },
    $unset: { preparationExpiresAt: 1, dispatchExpiresAt: 1 },
  });

  await recordOrchestrationTraceFailedLaunch({ ownerId, originRef, at: now });

  // No GlassHive workRef exists, but the failed launch itself is durable account work that needs
  // acknowledgement. Publish the positive hint after its attention row commits; only a fresh
  // owner-scoped roster after dismissal may clear the account-global hint.
  await requireParallelWorkPositiveFence(ownerId);

  if (
    launchContext.required === true &&
    (launchContext.schedulerDispatchDocumentId || launchContext.scheduleOccurrenceKey)
  ) {
    try {
      const binding = {
        ownerId,
        schedulerDispatchDocumentId: normalizeText(launchContext.schedulerDispatchDocumentId, 160),
        scheduleOccurrenceKey: normalizeText(launchContext.scheduleOccurrenceKey, 160),
      };
      const summary = await getSchedulerExternalWorkSummary(binding);
      await notifySchedulerExternalWorkSummary({ binding, summary });
    } catch (schedulerError) {
      const runtimeError = schedulerError as RuntimeError;
      logger.warn('[VIVENTIUM][glasshive-binding] Pre-dispatch schedule reconciliation failed', {
        originRef,
        code: normalizeText(runtimeError.code || runtimeError.name, 120),
      });
    }
  }
  return { originRef, launchState: 'not_dispatched', externalState: 'failed' };
}

async function markGlassHiveLaunchDispatchUnknown(
  toolArguments: unknown,
): Promise<RuntimeRecord | null> {
  const originRef = glassHiveLaunchOriginFromArguments(toolArguments);
  if (!originRef) return null;
  const now = new Date();
  const update = {
    $set: {
      launchState: 'dispatch_unknown',
      dispatchExpiresAt: new Date(now.getTime() + launchDispatchAmbiguityLeaseMs()),
      updatedAt: now,
    },
  };
  const filter = { _id: originRef, launchState: { $in: ['prepared', 'dispatch_ready'] } };
  await callbackBindingCollection().updateOne(filter, update);
  await externalWorkCollection().updateOne(filter, update);
  return { originRef, launchState: 'dispatch_unknown' };
}

/** Close an authoritative GlassHive blocked/rejected response that proves no mission was created. */
async function markGlassHiveLaunchDispatchRejected(
  toolArguments: unknown,
  error?: RuntimeError | RuntimeRecord,
): Promise<RuntimeRecord | null> {
  const originRef = glassHiveLaunchOriginFromArguments(toolArguments);
  if (!originRef) return null;
  const binding = await callbackBindingCollection().findOne({ _id: originRef });
  if (!binding?.ownerId || binding?.workRef) return null;
  return markGlassHiveLaunchPreDispatchFailed(binding, error);
}

async function confirmGlassHiveCallbackContext({
  binding,
  body = {},
  effectFence,
  effectSession,
}: RuntimeRecord = {}): Promise<RuntimeRecord | null> {
  const ownerId = normalizeText(binding?.ownerId);
  const originRef = normalizeText(binding?.originRef, 160);
  const workRef = normalizeText(binding?.workRef, 160);
  const workerId = normalizeText(body.worker_id, 160);
  const runId = normalizeText(body.run_id, 160);
  if (!ownerId || !originRef || !workRef || !workerId || !runId) return null;
  const fence = terminalCallbackEffectFence(body, effectFence);
  const now = new Date();
  const bindFilter = { _id: originRef, $or: [{ workRef: '' }, { workRef }] };
  const externalUpdate = effectSession
    ? externalWorkCollection().updateOne(
        terminalCallbackDestinationFilter(bindFilter, fence),
        {
          $set: {
            workRef,
            workerId,
            runId,
            launchState: 'callback_confirmed',
            updatedAt: now,
            ...terminalCallbackDestinationFields(fence),
          },
          $unset: { dispatchExpiresAt: 1 },
        },
        { session: effectSession },
      )
    : externalWorkCollection().updateOne(terminalCallbackDestinationFilter(bindFilter, fence), {
        $set: {
          workRef,
          workerId,
          runId,
          launchState: 'callback_confirmed',
          updatedAt: now,
          ...terminalCallbackDestinationFields(fence),
        },
        $unset: { dispatchExpiresAt: 1 },
      });
  requireFencedDestinationWrite(await externalUpdate, fence);
  const bindingUpdate = effectSession
    ? callbackBindingCollection().updateOne(
        terminalCallbackDestinationFilter(bindFilter, fence),
        {
          $set: {
            workRef,
            launchState: 'callback_confirmed',
            updatedAt: now,
            ...terminalCallbackDestinationFields(fence),
          },
          $unset: { dispatchExpiresAt: 1 },
        },
        { session: effectSession },
      )
    : callbackBindingCollection().updateOne(terminalCallbackDestinationFilter(bindFilter, fence), {
        $set: {
          workRef,
          launchState: 'callback_confirmed',
          updatedAt: now,
          ...terminalCallbackDestinationFields(fence),
        },
        $unset: { dispatchExpiresAt: 1 },
      });
  requireFencedDestinationWrite(await bindingUpdate, fence);
  await recordOrchestrationTraceAcceptedLaunch({
    ownerId,
    originRef,
    workRef,
    at: now,
    ...(effectSession ? { session: effectSession } : {}),
  });
  return binding;
}

async function resolveGlassHiveCallbackContext(
  body: RuntimeRecord = {},
  { deferConfirmation = false }: { deferConfirmation?: boolean } = {},
): Promise<RuntimeRecord | null> {
  const originRef = normalizeText(body.origin_ref, 160);
  const workRef = normalizeText(body.work_ref, 160);
  const workerId = normalizeText(body.worker_id, 160);
  const runId = normalizeText(body.run_id, 160);
  if (!originRef || !workRef || !workerId || !runId) {
    return null;
  }
  const binding = await callbackBindingCollection().findOne({ _id: originRef });
  if (!binding) {
    return null;
  }
  const ownerId = normalizeText(binding.ownerId);
  const conversationId = normalizeText(binding.conversationId);
  const anchorMessageId = normalizeText(binding.anchorMessageId);
  if (!ownerId || !conversationId || !anchorMessageId) return null;
  const boundWorkRef = normalizeText(binding.workRef, 160);
  if (boundWorkRef && boundWorkRef !== workRef) return null;

  let association;
  try {
    association = await requestAccountApi({
      ownerId,
      path: '/v1/callback-associations/verify',
      method: 'POST',
      body: { originRef, workRef, workerId, runId },
      timeoutMs: 3000,
    });
  } catch (error) {
    if (Number((error as RuntimeError).status) === 404) return null;
    throw error;
  }
  if (
    association?.valid !== true ||
    normalizeText(association?.originRef, 160) !== originRef ||
    normalizeText(association?.workRef, 160) !== workRef
  ) {
    return null;
  }

  const destinations = [];
  for (const destination of Array.isArray(binding.configuredDestinations)
    ? binding.configuredDestinations
    : []) {
    const surface = normalizeText(destination?.surface, 32).toLowerCase();
    if (surface === 'telegram') {
      destinations.push(await resolveTelegramDestination(ownerId, destination));
    } else if (surface === 'voice') {
      const voiceCallSessionId = normalizeText(destination.voiceCallSessionId);
      destinations.push(
        voiceCallSessionId
          ? {
              surface: 'voice',
              voiceCallSessionId,
              voiceRequestId: normalizeText(destination.voiceRequestId),
            }
          : { surface: 'voice', unresolvedReason: 'voice_session_not_bound' },
      );
    } else if (surface === 'librechat' || surface === 'workbench') {
      destinations.push({ surface });
    }
  }

  const traceIdentity = callbackTraceIdentity(body);
  const context = {
    bindingId: normalizeText(binding.bindingId || binding._id),
    originRef,
    workRef,
    ownerId,
    conversationId,
    anchorMessageId,
    requestedParentMessageId: normalizeText(binding.requestedParentMessageId),
    schedulerDispatchDocumentId: normalizeText(binding.schedulerDispatchDocumentId),
    scheduleOccurrenceKey: normalizeText(binding.scheduleOccurrenceKey),
    scheduleId: normalizeText(binding.scheduleId),
    mainAgentId: normalizeText(binding.mainAgentId, 160),
    ...(traceIdentity ? { traceIdentity } : {}),
    destinations,
  };
  if (!deferConfirmation) {
    await confirmGlassHiveCallbackContext({ binding: context, body });
  }
  return context;
}

function callbackStateForEvent(body: RuntimeRecord = {}): string {
  const event = normalizeText(body.event, 64);
  const failureCode = normalizeText(
    body.failure_code || body.failure_class || body.error_code || body?.error?.code,
    80,
  ).toLowerCase();
  if (event === 'run.failed' && HOST_CAPACITY_CODES.has(failureCode)) {
    return 'queued';
  }
  switch (event) {
    case 'run.completed':
      return 'completed';
    case 'run.failed':
      return 'failed';
    case 'run.cancelled':
    case 'run.interrupted':
      return 'cancelled';
    case 'checkpoint.ready':
    case 'takeover.requested':
    case 'run.needs_input':
    case 'run.blocked':
      return 'needs_input';
    case 'run.paused':
    case 'worker.paused':
      return 'paused';
    case 'run.queued':
    case 'run.requeued':
    case 'run.capacity_waiting':
    case 'run.waiting_capacity':
    case 'run.waiting_on_capacity':
      return 'queued';
    case 'run.stopping':
      return 'stopping';
    case 'run.started':
    case 'run.resumed':
    case 'worker.resumed_by_alias':
      return 'running';
    default:
      return '';
  }
}

/* === VIVENTIUM START ===
 * Feature: Canonical WorkRef lifecycle callbacks.
 * Purpose: A run is only one execution inside a durable work root. Queue/Message can create a
 * sibling run, so a terminal run event must not complete the WorkRef unless GlassHive's verified
 * callback also asserts the canonical work is terminal. Legacy terminal callbacks fail
 * nonterminal; the authoritative account snapshot/reconciliation path can safely repair them.
 * === VIVENTIUM END === */
function canonicalGlassHiveWorkState(body: RuntimeRecord = {}): string {
  const state = normalizeText(body.work_state, 32).toLowerCase();
  return [
    'queued',
    'running',
    'paused',
    'needs_input',
    'stopping',
    'settling',
    'completed',
    'failed',
    'cancelled',
  ].includes(state)
    ? state
    : '';
}

function isGlassHiveWorkTerminalCallback(body: RuntimeRecord = {}): boolean {
  const state = canonicalGlassHiveWorkState(body);
  return body.work_terminal === true && TERMINAL_STATES.includes(state);
}

function callbackWorkState(body: RuntimeRecord = {}): string {
  const runState = callbackStateForEvent(body);
  const workState = canonicalGlassHiveWorkState(body);
  const hasWorkContract = typeof body.work_terminal === 'boolean' && Boolean(workState);
  if (hasWorkContract) {
    if (body.work_terminal === true) {
      return TERMINAL_STATES.includes(workState) ? workState : '';
    }
    return TERMINAL_STATES.includes(workState)
      ? ''
      : workState === 'settling'
        ? 'running'
        : workState;
  }
  // Nonterminal legacy events cannot prematurely finish the WorkRef and remain safe to project.
  return TERMINAL_STATES.includes(runState) ? '' : runState;
}

function externalWorkFilter(
  { ownerId, schedulerDispatchDocumentId, scheduleOccurrenceKey }: RuntimeRecord = {},
): RuntimeRecord {
  const filter: RuntimeRecord = { ownerId: normalizeText(ownerId) };
  if (schedulerDispatchDocumentId) {
    filter.schedulerDispatchDocumentId = normalizeText(schedulerDispatchDocumentId);
  } else if (scheduleOccurrenceKey) {
    filter.scheduleOccurrenceKey = normalizeText(scheduleOccurrenceKey);
  }
  return filter;
}

async function getSchedulerExternalWorkSummary({
  ownerId,
  schedulerDispatchDocumentId = '',
  scheduleOccurrenceKey = '',
  effectSession,
}: RuntimeRecord = {}): Promise<RuntimeRecord> {
  const filter = externalWorkFilter({
    ownerId,
    schedulerDispatchDocumentId,
    scheduleOccurrenceKey,
  });
  if (!filter.ownerId || (!filter.schedulerDispatchDocumentId && !filter.scheduleOccurrenceKey)) {
    return {
      requiredTotal: 0,
      requiredTerminal: 0,
      requiredFailed: 0,
      allRequiredTerminal: true,
      state: 'none',
      items: [],
    };
  }
  const rows = await externalWorkCollection()
    .find(filter, effectSession ? { session: effectSession } : undefined)
    .toArray();
  const items = rows.map((row: RuntimeRecord) => ({
    workRef: normalizeText(row.workRef || row._id),
    required: row.required === true,
    state: normalizeText(row.externalState, 32) || 'accepted',
  }));
  const required = items.filter((item: RuntimeRecord) => item.required);
  const terminal = required.filter((item: RuntimeRecord) => TERMINAL_STATES.includes(item.state));
  const requiredFailed = terminal.filter((item: RuntimeRecord) => item.state !== 'completed').length;
  const allRequiredTerminal = required.length === 0 || terminal.length === required.length;
  return {
    requiredTotal: required.length,
    requiredTerminal: terminal.length,
    requiredFailed,
    allRequiredTerminal,
    state:
      required.length === 0
        ? 'none'
        : allRequiredTerminal
          ? requiredFailed
            ? 'failed'
            : 'completed'
          : 'waiting_external',
    items,
  };
}

/**
 * Prove that one exact assistant presentation corresponds to a Core-bound launch which already
 * returned an authoritative GlassHive work reference. This is intentionally server-held evidence:
 * presentation adapters cannot promote arbitrary stale prose into a committed mission receipt.
 */
async function hasAcceptedGlassHiveLaunchForPresentation({
  ownerId,
  conversationId,
  responseMessageId,
  sourceEventId,
}: RuntimeRecord = {}): Promise<boolean> {
  const identity = {
    ownerId: normalizeText(ownerId, 160),
    conversationId: normalizeText(conversationId, 160),
    anchorMessageId: normalizeText(responseMessageId, 160),
    sourceEventId: normalizeText(sourceEventId, 512),
  };
  if (Object.values(identity).some((value) => !value)) return false;
  const binding = await callbackBindingCollection().findOne(
    {
      ...identity,
      launchState: { $in: ['accepted', 'callback_confirmed'] },
      workRef: { $nin: ['', null] },
    },
    { projection: { _id: 1 } },
  );
  return Boolean(binding?._id);
}

/**
 * Re-seed the conservative per-account hint after a Core restart or schema migration. Never clear
 * here: only a fresh authoritative GlassHive empty roster may prove that an account has no work.
 */
async function reconcileKnownExternalWorkHints(
  { limit = 100 }: RuntimeRecord = {},
): Promise<RuntimeRecord> {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const rows = await externalWorkCollection()
    .find(
      {
        ownerId: { $nin: ['', null] },
        $or: [
          {
            launchState: 'not_dispatched',
            externalState: 'failed',
            attentionPending: { $ne: false },
          },
          {
            launchState: { $nin: ['prepared', 'not_dispatched'] },
            $or: [
              { externalState: { $nin: TERMINAL_STATES } },
              { attentionPending: true },
              {
                deliveryState: { $in: ['pending', 'enqueued', 'failed', 'unresolved', 'unknown'] },
              },
            ],
          },
        ],
      },
      {
        projection: {
          _id: 1,
          ownerId: 1,
          originRef: 1,
          workRef: 1,
          runId: 1,
          externalState: 1,
          launchState: 1,
          deliveryState: 1,
          attentionPending: 1,
          stateReconciliationPendingAt: 1,
          stateReconciliationNextAt: 1,
          stateReconciliationAttempts: 1,
        },
      },
    )
    .sort({ updatedAt: -1 })
    .limit(boundedLimit * 10)
    .toArray();
  const ownerIds = Array.from(
    new Set(rows.map((row: RuntimeRecord) => normalizeText(row?.ownerId, 160)).filter(Boolean)),
  ).slice(0, boundedLimit);
  const outcomes = await Promise.all(ownerIds.map((ownerId) => markUserParallelWorkKnown(ownerId)));
  const now = Date.now();
  const candidates = rows
    .filter((row: RuntimeRecord) => {
      const nextAttemptAt = row?.stateReconciliationNextAt
        ? new Date(row.stateReconciliationNextAt).getTime()
        : 0;
      return Boolean(
        normalizeText(row?.ownerId, 160) &&
        normalizeText(row?.workRef, 160) &&
        normalizeText(row?.runId, 160) &&
        ['accepted', 'callback_confirmed'].includes(normalizeText(row?.launchState, 32)) &&
        !TERMINAL_STATES.includes(normalizeText(row?.externalState, 32)) &&
        (!Number.isFinite(nextAttemptAt) || nextAttemptAt <= now),
      );
    })
    .slice(0, Math.min(boundedLimit, STATE_RECONCILIATION_BATCH));
  await Promise.all(
    candidates.map(async (row: RuntimeRecord) => {
      const ownerId = normalizeText(row.ownerId, 160);
      const workRef = normalizeText(row.workRef, 160);
      try {
        const detail = await requestAccountApi({
          ownerId,
          path: `/v1/work/${encodeURIComponent(workRef)}`,
          timeoutMs: 3000,
        });
        if (normalizeText(detail?.workRef, 160) !== workRef) {
          throw Object.assign(new Error('authoritative work identity did not match'), {
            code: 'work_state_reconciliation_identity_mismatch',
          });
        }
        if (!TERMINAL_STATES.includes(normalizeText(detail?.state, 32).toLowerCase())) {
          return;
        }
        const ingestion = await recordGlassHiveWorkDetailTrace({
          ownerId,
          originRef: normalizeText(row.originRef || row._id, 160),
          workRef,
          runRef: normalizeText(row.runId, 160),
          detail,
        });
        if (ingestion?.accepted !== true) {
          throw Object.assign(new Error('authoritative producer trace was rejected'), {
            code: 'glasshive_trace_producer_detail_rejected',
          });
        }
        await reconcileAuthoritativeGlassHiveWorkState({ ownerId, item: detail, row });
      } catch (error) {
        await deferGlassHiveWorkStateReconciliation({ ownerId, row, error });
      }
    }),
  );
  return {
    scanned: rows.length,
    updatedOwners: outcomes.filter(Boolean).length,
    failedOwners: outcomes.filter((updated) => !updated).length,
  };
}

/** Reconcile launch intents whose MCP response was lost before Core learned the workRef. */
async function reconcileUnknownGlassHiveLaunches(
  { ownerId, limit = 25 }: RuntimeRecord = {},
): Promise<RuntimeRecord> {
  const normalizedOwnerId = normalizeText(ownerId, 160);
  const now = new Date();
  const legacyPreparedBefore = new Date(now.getTime() - launchPreparationLeaseMs());
  const filter = {
    workRef: '',
    ...(normalizedOwnerId ? { ownerId: normalizedOwnerId } : {}),
    // A single persistently unavailable owner/row must not monopolize every bounded scan.
    $nor: [{ reconciliationNextAt: { $gt: now } }],
    $or: [
      { launchState: 'dispatch_unknown' },
      { launchState: 'dispatch_ready', dispatchExpiresAt: { $lte: now } },
      {
        launchState: 'dispatch_ready',
        dispatchExpiresAt: { $exists: false },
        updatedAt: { $lte: legacyPreparedBefore },
      },
      { launchState: 'prepared', preparationExpiresAt: { $lte: now } },
      {
        launchState: 'prepared',
        preparationExpiresAt: { $exists: false },
        updatedAt: { $lte: legacyPreparedBefore },
      },
    ],
  };
  const cursor = externalWorkCollection()
    .find(filter)
    .sort({ updatedAt: 1 })
    .limit(Math.max(1, Math.min(Number(limit) || 25, 100)));
  const rows = await cursor.toArray();
  let repaired = 0;
  let pending = 0;
  for (const row of rows) {
    if (row.launchState === 'prepared') {
      await markGlassHiveLaunchPreDispatchFailed(
        {
          originRef: normalizeText(row.originRef || row._id, 160),
          ownerId: normalizeText(row.ownerId, 160),
          required: row.required === true,
          schedulerDispatchDocumentId: normalizeText(row.schedulerDispatchDocumentId, 160),
          scheduleOccurrenceKey: normalizeText(row.scheduleOccurrenceKey, 160),
        },
        Object.assign(new Error('launch_preparation_lease_expired'), {
          code: 'launch_preparation_lease_expired',
        }),
      );
      repaired += 1;
      continue;
    }
    try {
      const snapshot = await requestAccountApi({
        ownerId: row.ownerId,
        path: `/v1/delegations/by-origin/${encodeURIComponent(row.originRef || row._id)}`,
        timeoutMs: 3000,
      });
      const workRef = normalizeText(snapshot?.workRef, 160);
      if (!workRef) {
        pending += 1;
        continue;
      }
      const now = new Date();
      const bindFilter = { _id: row._id, $or: [{ workRef: '' }, { workRef }] };
      const update = { $set: { workRef, launchState: 'accepted', updatedAt: now } };
      await callbackBindingCollection().updateOne(bindFilter, update);
      await externalWorkCollection().updateOne(bindFilter, update);
      repaired += 1;
    } catch (error) {
      const runtimeError = error as RuntimeError;
      if (Number(runtimeError.status) === 404) {
        const expiresAt = row.dispatchExpiresAt
          ? new Date(row.dispatchExpiresAt)
          : new Date(new Date(row.updatedAt || 0).getTime() + launchDispatchAmbiguityLeaseMs());
        if (Number.isFinite(expiresAt.getTime()) && expiresAt <= now) {
          await markGlassHiveLaunchPreDispatchFailed(
            {
              originRef: normalizeText(row.originRef || row._id, 160),
              ownerId: normalizeText(row.ownerId, 160),
              required: row.required === true,
              schedulerDispatchDocumentId: normalizeText(row.schedulerDispatchDocumentId, 160),
              scheduleOccurrenceKey: normalizeText(row.scheduleOccurrenceKey, 160),
            },
            Object.assign(new Error('launch_dispatch_not_found'), {
              code: 'launch_dispatch_not_found',
            }),
          );
          repaired += 1;
        } else {
          pending += 1;
        }
        continue;
      }
      const attempts = Math.max(0, Number(row.reconciliationAttempts) || 0) + 1;
      const delayMs = Math.min(5 * 60 * 1000, 5_000 * 2 ** Math.min(attempts - 1, 6));
      const errorCode = normalizeText(runtimeError.code || runtimeError.name, 120) || 'reconciliation_failed';
      await externalWorkCollection().updateOne(
        {
          _id: row._id,
          workRef: '',
          launchState: row.launchState,
        },
        {
          $set: {
            reconciliationAttemptedAt: now,
            reconciliationNextAt: new Date(now.getTime() + delayMs),
            reconciliationErrorCode: errorCode,
          },
          $inc: { reconciliationAttempts: 1 },
        },
      );
      logger.warn('[VIVENTIUM][glasshive-binding] Launch reconciliation deferred', {
        errorCode,
        attempts,
      });
      pending += 1;
      continue;
    }
  }
  return { scanned: rows.length, repaired, pending };
}

async function recordGlassHiveCallbackExternalState({
  binding,
  body = {},
  effectFence,
  effectSession,
}: RuntimeRecord = {}): Promise<RuntimeRecord | null> {
  if (!binding?.ownerId) return null;
  const fence = terminalCallbackEffectFence(body, effectFence);
  const callbackAcceptedAt = new Date();
  const state = callbackWorkState(body);
  const workerId = normalizeText(body.worker_id);
  const runId = normalizeText(body.run_id);
  const originRef = normalizeText(binding.originRef || binding.bindingId, 160);
  const workRef = normalizeText(binding.workRef || body.work_ref, 160);
  const callbackAt = callbackTraceAt(body);
  const traceIdentity = binding.traceIdentity
    ? callbackTraceIdentity(body, binding.traceIdentity)
    : null;
  if (traceIdentity && callbackAt && originRef && workRef && runId) {
    const workState = canonicalGlassHiveWorkState(body) || state;
    if (TERMINAL_STATES.includes(workState) && isGlassHiveWorkTerminalCallback(body)) {
      const detail = await requestAccountApi({
        ownerId: normalizeText(binding.ownerId, 160),
        path: `/v1/work/${encodeURIComponent(workRef)}`,
        timeoutMs: 3000,
      });
      const ingestion = await recordGlassHiveWorkDetailTrace({
        ownerId: normalizeText(binding.ownerId, 160),
        originRef,
        workRef,
        runRef: runId,
        detail,
      });
      if (ingestion?.accepted !== true) {
        throw Object.assign(new Error('glasshive_trace_producer_detail_rejected'), {
          code: 'glasshive_trace_producer_detail_rejected',
        });
      }
    }
    await recordOrchestrationTraceCallback({
      ownerId: normalizeText(binding.ownerId, 160),
      originRef,
      workRef,
      runRef: normalizeText(body.run_id, 160),
      callbackRef: traceIdentity.callbackRef,
      event: normalizeText(body.event, 64),
      workState,
      workTerminal: isGlassHiveWorkTerminalCallback(body),
      callbackAt,
      callbackAcceptedAt,
      attemptNumber: traceIdentity.attemptNumber,
    });
  }
  const collection = externalWorkCollection();
  const work = originRef
    ? await collection.findOne(
        { _id: originRef, ownerId: binding.ownerId },
        effectSession ? { session: effectSession } : undefined,
      )
    : null;
  if (work && state) {
    const now = new Date();
    const update: RuntimeRecord = {
      $set: {
        externalState: state,
        workerId,
        runId,
        workRef,
        launchState: 'callback_confirmed',
        updatedAt: now,
        ...terminalCallbackDestinationFields(fence),
        ...(TERMINAL_STATES.includes(state) ? { terminalAt: now } : {}),
        ...(state
          ? {
              attentionPending: state === 'needs_input' || TERMINAL_STATES.includes(state),
              ...(TERMINAL_STATES.includes(state) ? { deliveryState: 'pending' } : {}),
            }
          : {}),
      },
    };
    const filter: RuntimeRecord = { _id: work._id };
    if (!TERMINAL_STATES.includes(normalizeText(work.externalState, 32))) {
      filter.externalState = { $nin: TERMINAL_STATES };
      const previousDeliveryState = normalizeText(work.deliveryState, 32);
      if (
        TERMINAL_STATES.includes(state) &&
        PROTECTED_DELIVERY_STATES.includes(previousDeliveryState)
      ) {
        delete update.$set.deliveryState;
        update.$set.attentionPending = work.attentionPending === true;
      }
    } else {
      delete update.$set.externalState;
      delete update.$set.terminalAt;
      delete update.$set.deliveryState;
      delete update.$set.attentionPending;
    }
    requireFencedDestinationDocument(
      await collection.findOneAndUpdate(terminalCallbackDestinationFilter(filter, fence), update, {
        returnDocument: 'after',
        ...(effectSession ? { session: effectSession } : {}),
      }),
      fence,
    );
  } else if (fence) {
    throw callbackEffectFenceError();
  }

  if (!binding.schedulerDispatchDocumentId && !binding.scheduleOccurrenceKey) {
    return null;
  }
  return getSchedulerExternalWorkSummary({
    ownerId: binding.ownerId,
    schedulerDispatchDocumentId: binding.schedulerDispatchDocumentId,
    scheduleOccurrenceKey: binding.scheduleOccurrenceKey,
    effectSession,
  });
}

async function recordGlassHiveAdjudicationOutcome({
  originRef,
  state,
  followUpMessageId = '',
  errorCode = '',
  effectSession,
}: RuntimeRecord = {}): Promise<RuntimeRecord | null> {
  const ref = normalizeText(originRef, 160);
  const normalizedState = normalizeText(state, 32);
  if (!ref || !['completed', 'silent', 'failed'].includes(normalizedState)) return null;
  const normalizedErrorCode = normalizeText(errorCode, 120);
  const unresolvedDelivery = normalizedErrorCode === 'mission_surface_delivery_unresolved';
  const now = new Date();
  const adjudicationFields = {
    adjudicationState: normalizedState,
    attentionPending: normalizedState === 'failed',
    followUpMessageId: normalizeText(followUpMessageId, 160),
    adjudicationErrorCode: normalizedErrorCode,
    adjudicatedAt: now,
    updatedAt: now,
  };
  const deliveryState =
    normalizedState === 'failed' ? (unresolvedDelivery ? 'unresolved' : 'failed') : 'enqueued';
  effectSession ||= mongoose.transactionAsyncLocalStorage?.getStore()?.session || null;
  const collection = externalWorkCollection();
  const unsettledResult = await collection.findOneAndUpdate(
    { _id: ref, deliveryState: { $nin: PROTECTED_DELIVERY_STATES } },
    {
      $set: {
        ...adjudicationFields,
        deliveryState,
      },
    },
    { returnDocument: 'after', ...(effectSession ? { session: effectSession } : {}) },
  );
  const unsettledRow =
    unsettledResult && Object.prototype.hasOwnProperty.call(unsettledResult, 'value')
      ? unsettledResult.value
      : unsettledResult;
  if (unsettledRow) return unsettledRow;

  // Delivery is monotonic. A later adjudication pass may enrich mission metadata, but it must
  // never turn an already-sent/acknowledged/silent surface back into a pending delivery.
  const { attentionPending: _attentionPending, ...protectedAdjudicationFields } =
    adjudicationFields;
  const settledResult = await collection.findOneAndUpdate(
    { _id: ref },
    { $set: protectedAdjudicationFields },
    { returnDocument: 'after', ...(effectSession ? { session: effectSession } : {}) },
  );
  return settledResult && Object.prototype.hasOwnProperty.call(settledResult, 'value')
    ? settledResult.value
    : settledResult || null;
}

async function recordGlassHiveSurfaceDeliveryOutcome({
  originRef,
  state,
  body = {},
  effectFence,
  effectSession,
}: RuntimeRecord = {}): Promise<RuntimeRecord | null> {
  const ref = normalizeText(originRef, 160);
  const deliveryState = normalizeText(state, 32);
  if (
    !ref ||
    !['enqueued', 'sent', 'failed', 'suppressed', 'unresolved', 'unknown'].includes(deliveryState)
  ) {
    return null;
  }
  effectSession ||= mongoose.transactionAsyncLocalStorage?.getStore()?.session || null;
  const fence = terminalCallbackEffectFence(body, effectFence);
  const projectionFilter = {
    _id: ref,
    ...(deliveryState === 'enqueued' ? { deliveryState: { $nin: PROTECTED_DELIVERY_STATES } } : {}),
  };
  const result = requireFencedDestinationDocument(
    await externalWorkCollection().findOneAndUpdate(
      terminalCallbackDestinationFilter(projectionFilter, fence),
      {
        $set: {
          deliveryState,
          attentionPending: ['failed', 'unresolved', 'unknown'].includes(deliveryState),
          deliveryUpdatedAt: new Date(),
          updatedAt: new Date(),
          ...terminalCallbackDestinationFields(fence),
        },
      },
      {
        returnDocument: 'after',
        ...(effectSession ? { session: effectSession } : {}),
      },
    ),
    fence,
  );
  return result?.value || result || null;
}

function schedulingExternalCallbackUrl() {
  const explicit = normalizeText(process.env.VIVENTIUM_SCHEDULING_EXTERNAL_WORK_CALLBACK_URL, 2048);
  if (explicit) return explicit;
  const base = normalizeText(process.env.SCHEDULING_MCP_URL, 2048);
  if (!base) return '';
  return `${base.replace(/\/mcp\/?$/, '').replace(/\/$/, '')}/internal/scheduled-prompts/external-work-callback`;
}

async function notifySchedulerExternalWorkSummary(
  { binding, summary }: RuntimeRecord = {},
): Promise<unknown> {
  if (!binding?.scheduleOccurrenceKey || !summary || summary.requiredTotal < 1) {
    return null;
  }
  const url = schedulingExternalCallbackUrl();
  const secret = normalizeText(
    process.env.VIVENTIUM_SCHEDULER_SECRET || process.env.SCHEDULER_LIBRECHAT_SECRET,
    4096,
  );
  if (!url || !secret) {
    throw new Error('scheduler_external_work_callback_unavailable');
  }
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-VIVENTIUM-SCHEDULER-SECRET': secret,
    },
    body: JSON.stringify({
      occurrence_key: binding.scheduleOccurrenceKey,
      user_id: binding.ownerId,
      required_total: summary.requiredTotal,
      required_terminal: summary.requiredTerminal,
      required_failed: summary.requiredFailed,
      all_required_terminal: summary.allRequiredTerminal,
      state: summary.state,
    }),
  });
  if (!response.ok) {
    throw new Error(`scheduler_external_work_callback_http_${response.status}`);
  }
  return response.json().catch(() => ({}));
}

const service: GlassHiveCallbackBindingService = {
  attachGlassHiveLaunchOrigin,
  attachGlassHiveTrustedLaunchMetadata: (
    toolArguments,
    launchContext = {} as GlassHiveLaunchContext,
    trustedBootstrapBundle = {},
  ) =>
    attachGlassHiveTrustedLaunchMetadata(
      toolArguments,
      launchContext as RuntimeRecord,
      trustedBootstrapBundle as RuntimeRecord,
    ),
  confirmGlassHiveCallbackContext: async (input = {}) =>
    (await confirmGlassHiveCallbackContext(input as RuntimeRecord)) as GlassHiveCallbackContext | null,
  glassHiveLaunchOriginFromArguments,
  getSchedulerExternalWorkSummary: async (input = {}) =>
    (await getSchedulerExternalWorkSummary(
      input as RuntimeRecord,
    )) as GlassHiveSchedulerExternalWorkSummary,
  hasAcceptedGlassHiveLaunchForPresentation: async (input = {}) =>
    hasAcceptedGlassHiveLaunchForPresentation(input as RuntimeRecord),
  launchDispatchAmbiguityLeaseMs,
  launchPreparationLeaseMs,
  markGlassHiveLaunchDispatchUnknown: async (toolArguments) =>
    (await markGlassHiveLaunchDispatchUnknown(
      toolArguments,
    )) as GlassHiveLaunchTransitionResult | null,
  markGlassHiveLaunchDispatchRejected: async (toolArguments, error) =>
    (await markGlassHiveLaunchDispatchRejected(
      toolArguments,
      error,
    )) as GlassHiveLaunchTransitionResult | null,
  markGlassHiveLaunchDispatchReady: async (launchContext = {} as GlassHiveLaunchContext) =>
    (await markGlassHiveLaunchDispatchReady(
      launchContext as RuntimeRecord,
    )) as GlassHiveLaunchTransitionResult | null,
  markGlassHiveLaunchPreDispatchFailed: async (
    launchContext = {} as GlassHiveLaunchContext,
    error,
  ) =>
    (await markGlassHiveLaunchPreDispatchFailed(
      launchContext as RuntimeRecord,
      error,
    )) as GlassHiveLaunchTransitionResult | null,
  notifySchedulerExternalWorkSummary: async (input = {}) =>
    (await notifySchedulerExternalWorkSummary(input as RuntimeRecord)) as object | null,
  reconcileKnownExternalWorkHints: async (input = {}) =>
    (await reconcileKnownExternalWorkHints(input as RuntimeRecord)) as GlassHiveReconciliationSummary,
  reconcileGlassHiveLaunchResult: async (input = {}) =>
    (await reconcileGlassHiveLaunchResult(
      input as RuntimeRecord,
    )) as GlassHiveLaunchTransitionResult | null,
  reconcileUnknownGlassHiveLaunches: async (input = {}) =>
    (await reconcileUnknownGlassHiveLaunches(
      input as RuntimeRecord,
    )) as GlassHiveReconciliationSummary,
  recordGlassHiveAdjudicationOutcome: async (input = {}) =>
    recordGlassHiveAdjudicationOutcome(input as RuntimeRecord),
  recordGlassHiveSurfaceDeliveryOutcome: async (input = {}) =>
    recordGlassHiveSurfaceDeliveryOutcome(input as RuntimeRecord),
  recordGlassHiveCallbackExternalState: async (input = {}) =>
    (await recordGlassHiveCallbackExternalState(
      input as RuntimeRecord,
    )) as GlassHiveSchedulerExternalWorkSummary | null,
  isGlassHiveWorkTerminalCallback: (body = {}) =>
    isGlassHiveWorkTerminalCallback(body as RuntimeRecord),
  registerGlassHiveLaunchContext: async (input = {}) =>
    (await registerGlassHiveLaunchContext(input as RuntimeRecord)) as GlassHiveLaunchContext | null,
  resolveTrustedGlassHiveCallIdentity: (input = {}) =>
    resolveTrustedGlassHiveCallIdentity(input as RuntimeRecord) as {
      sourceEventId: string;
      objectiveOrdinal: number;
      callIdentityDigest: string;
    },
  resolveGlassHiveCallbackContext: async (body = {}, options = {}) =>
    (await resolveGlassHiveCallbackContext(
      body as RuntimeRecord,
      options,
    )) as GlassHiveCallbackContext | null,
};

return service;
}
