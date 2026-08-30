/* === VIVENTIUM START ===
 * Feature: Append-only owner-scoped orchestration trace ledger.
 * Purpose: Persist only typed fingerprints in a deterministic sequence and verifiable hash chain.
 * === VIVENTIUM END === */

import { createHash } from 'crypto';

export type TraceStage =
  | 'source.bound'
  | 'prompt.layers.verified'
  | 'prompt.layers.invalid'
  | 'launch.prepared'
  | 'launch.accepted'
  | 'launch.failed'
  | 'work.queued'
  | 'work.claimed'
  | 'work.admitted'
  | 'runtime.invoked'
  | 'provider.request.forwarded'
  | 'work.running'
  | 'attempt.history.complete'
  | 'capacity.history.complete'
  | 'callback.history.complete'
  | 'work.completed'
  | 'work.failed'
  | 'work.cancelled'
  | 'callback.accepted'
  | 'callback.delivery.pending'
  | 'callback.delivery.claimed'
  | 'callback.delivery.sent'
  | 'callback.delivery.failed'
  | 'callback.delivery.suppressed'
  | 'callback.delivery.unresolved'
  | 'action.accepted'
  | 'control.completed'
  | 'tool.completed'
  | 'controller.completed'
  | 'cortex.completed'
  | 'live_memory.completed'
  | 'recall.completed'
  | 'title_model.completed'
  | 'response.completed'
  | 'tts.completed'
  | 'audio.completed'
  | 'provider.attempt.completed'
  | 'provider.fallback.completed';

export interface TraceEventFactsInput {
  sourceEventRef?: string;
  logicalTurnRef?: string;
  workRef?: string;
  runRef?: string;
  callbackRef?: string;
  deliveryRef?: string;
  callSessionRef?: string;
  taskRef?: string;
  streamRef?: string;
  actionRef?: string;
  receiptRef?: string;
  attemptRef?: string;
  providerRequestRef?: string;
  primaryAttemptRef?: string;
  fallbackAttemptRef?: string;
  responseRef?: string;
  presentationRef?: string;
  state?: string;
  surface?: string;
  callbackEvent?: string;
  deliveryState?: string;
  terminal?: boolean;
  attemptNumber?: number;
  promptLayerContractVersion?: number;
  producerTraceContractVersion?: number;
  promptProducerScope?: string;
  unknownPromptLayerCount?: number;
  producerLifecycleHash?: string;
  producerAttemptHistoryHash?: string;
  producerCapacityHistoryHash?: string;
  producerCallbackHistoryHash?: string;
  producerPromptHash?: string;
  producerArtifactRefsHash?: string;
  candidateDigest?: string;
  runtimeOwnerBindingHash?: string;
  installedArtifactDigest?: string;
  contextSnapshotHash?: string;
  capabilitySetHash?: string;
  effectPlane?: string;
  outcome?: string;
  action?: string;
  provider?: string;
  model?: string;
  providerStatus?: string;
  attemptRole?: string;
  primaryProvider?: string;
  primaryModel?: string;
  primaryProviderStatus?: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  fallbackProviderStatus?: string;
  configuredFallback?: boolean;
  requiredCapabilitiesPreserved?: boolean;
  effectCount?: number;
}

export interface RedactedTraceEventFacts {
  sourceEventRefHash?: string;
  logicalTurnRefHash?: string;
  workRefHash?: string;
  runRefHash?: string;
  callbackRefHash?: string;
  deliveryRefHash?: string;
  callSessionRefHash?: string;
  taskRefHash?: string;
  streamRefHash?: string;
  actionRefHash?: string;
  receiptRefHash?: string;
  attemptRefHash?: string;
  providerRequestRefHash?: string;
  primaryAttemptRefHash?: string;
  fallbackAttemptRefHash?: string;
  responseRefHash?: string;
  presentationRefHash?: string;
  state?: string;
  surface?: string;
  callbackEvent?: string;
  deliveryState?: string;
  terminal?: boolean;
  attemptNumber?: number;
  promptLayerContractVersion?: number;
  producerTraceContractVersion?: number;
  promptProducerScope?: string;
  unknownPromptLayerCount?: number;
  producerLifecycleHash?: string;
  producerAttemptHistoryHash?: string;
  producerCapacityHistoryHash?: string;
  producerCallbackHistoryHash?: string;
  producerPromptHash?: string;
  producerArtifactRefsHash?: string;
  candidateDigest?: string;
  runtimeOwnerBindingHash?: string;
  installedArtifactDigest?: string;
  contextSnapshotHash?: string;
  capabilitySetHash?: string;
  effectPlane?: string;
  outcome?: string;
  action?: string;
  provider?: string;
  model?: string;
  providerStatus?: string;
  attemptRole?: string;
  primaryProvider?: string;
  primaryModel?: string;
  primaryProviderStatus?: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  fallbackProviderStatus?: string;
  configuredFallback?: boolean;
  requiredCapabilitiesPreserved?: boolean;
  effectCount?: number;
}

export interface OrchestrationTraceEventRow {
  schemaVersion: 1;
  ownerScopeHash: string;
  originRefHash: string;
  sequence: number;
  stage: TraceStage;
  at: string;
  facts: RedactedTraceEventFacts;
  eventKeyHash: string;
  contentHash: string;
  previousEventHash: string;
  eventHash: string;
}

interface TraceScopeQuery {
  ownerScopeHash: string;
  originRefHash: string;
}

interface TraceEventKeyQuery extends TraceScopeQuery {
  eventKeyHash: string;
}

interface TraceSequenceQuery extends TraceScopeQuery {
  sequence: number;
}

interface TracePageQuery extends TraceScopeQuery {
  afterSequence: number;
  limit: number;
}

export interface OrchestrationTraceLedgerStore {
  findByEventKey(query: TraceEventKeyQuery): Promise<OrchestrationTraceEventRow | null>;
  findLatest(query: TraceScopeQuery): Promise<OrchestrationTraceEventRow | null>;
  findBySequence(query: TraceSequenceQuery): Promise<OrchestrationTraceEventRow | null>;
  insert(row: OrchestrationTraceEventRow): Promise<OrchestrationTraceEventRow>;
  listPage(query: TracePageQuery): Promise<OrchestrationTraceEventRow[]>;
}

export interface AppendOrchestrationTraceEventInput {
  store: OrchestrationTraceLedgerStore;
  ownerId: string;
  originRef: string;
  eventKey: string;
  stage: TraceStage;
  at?: string | Date;
  facts?: TraceEventFactsInput;
}

export interface OrchestrationTraceLedgerPage {
  version: 1;
  ownerScopeHash: string;
  originRefHash: string;
  events: ReadonlyArray<
    Readonly<{
      sequence: number;
      stage: TraceStage;
      at: string;
      facts: Readonly<RedactedTraceEventFacts>;
      previousEventHash: string;
      eventHash: string;
    }>
  >;
  chain: Readonly<{
    pageVerified: boolean;
    fullChainVerified: boolean;
    errors: ReadonlyArray<string>;
    previousEventHash: string;
    headEventHash: string | null;
  }>;
  pagination: Readonly<{
    afterSequence: number;
    limit: number;
    returned: number;
    remaining: number | null;
    hasMore: boolean;
    overflow: boolean;
    nextCursor: number | null;
  }>;
}

const HASH_PREFIX = 'sha256:';
const HASH = /^sha256:[a-f0-9]{64}$/;
const GENESIS_HASH = `${HASH_PREFIX}${'0'.repeat(64)}`;
const MAX_APPEND_RETRIES = 12;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const STATES = new Set([
  'unknown',
  'preparing',
  'accepted',
  'queued',
  'claimed',
  'admitted',
  'running',
  'paused',
  'needs_input',
  'blocked',
  'stopping',
  'settling',
  'completed',
  'failed',
  'cancelled',
]);
const SURFACES = new Set(['librechat', 'web', 'telegram', 'voice', 'workbench', 'scheduler']);
const CALLBACK_EVENTS = new Set([
  'main.followup',
  'run.queued',
  'run.requeued',
  'run.capacity_waiting',
  'run.waiting_capacity',
  'run.waiting_on_capacity',
  'run.queue_status',
  'run.claimed',
  'run.admitted',
  'runtime.invoked',
  'run.started',
  'run.resumed',
  'run.paused',
  'run.needs_input',
  'run.blocked',
  'run.stopping',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
  'run.authorization_resumed',
  'run.followup_queued',
  'run.orphaned',
  'checkpoint.ready',
  'takeover.requested',
  'worker.ready',
  'worker.paused',
  'worker.interrupted',
  'worker.terminated',
  'worker.resumed_by_alias',
  'worker.message_queued',
  'worker.message',
  'worker.resumed',
  'schedule.queued',
]);
const DELIVERY_STATES = new Set([
  'pending',
  'claimed',
  'sent',
  'failed',
  'suppressed',
  'unresolved',
  'delivery_unknown',
]);
const EFFECT_PLANES = new Set([
  'control',
  'tool',
  'controller',
  'cortex',
  'liveMemory',
  'recall',
  'titleModel',
  'response',
  'tts',
  'audio',
  'provider',
]);
const OUTCOMES = new Set(['accepted', 'completed', 'failed', 'skipped', 'empty']);
const VOICE_ACTIONS = new Set([
  'queue',
  'message',
  'steer',
  'pause',
  'resume',
  'stop',
  'retry',
  'dismiss',
]);
const PROVIDER_STATUSES = new Set([
  'completed',
  'failed',
  'timeout',
  'rate_limited',
  'unauthorized',
  'cancelled',
]);
const ATTEMPT_ROLES = new Set(['primary', 'fallback']);
const TRACE_STAGES = new Set<TraceStage>([
  'source.bound',
  'prompt.layers.verified',
  'prompt.layers.invalid',
  'launch.prepared',
  'launch.accepted',
  'launch.failed',
  'work.queued',
  'work.claimed',
  'work.admitted',
  'runtime.invoked',
  'provider.request.forwarded',
  'work.running',
  'attempt.history.complete',
  'capacity.history.complete',
  'callback.history.complete',
  'work.completed',
  'work.failed',
  'work.cancelled',
  'callback.accepted',
  'callback.delivery.pending',
  'callback.delivery.claimed',
  'callback.delivery.sent',
  'callback.delivery.failed',
  'callback.delivery.suppressed',
  'callback.delivery.unresolved',
  'action.accepted',
  'control.completed',
  'tool.completed',
  'controller.completed',
  'cortex.completed',
  'live_memory.completed',
  'recall.completed',
  'title_model.completed',
  'response.completed',
  'tts.completed',
  'audio.completed',
  'provider.attempt.completed',
  'provider.fallback.completed',
]);
const FIRST_OBSERVATION_REPLAY_STAGES = new Set<TraceStage>([
  'source.bound',
  'prompt.layers.verified',
  'prompt.layers.invalid',
  'launch.prepared',
  'launch.accepted',
  'callback.accepted',
]);
const FACT_KEYS = new Set<keyof TraceEventFactsInput>([
  'sourceEventRef',
  'logicalTurnRef',
  'workRef',
  'runRef',
  'callbackRef',
  'deliveryRef',
  'callSessionRef',
  'taskRef',
  'streamRef',
  'actionRef',
  'receiptRef',
  'attemptRef',
  'providerRequestRef',
  'primaryAttemptRef',
  'fallbackAttemptRef',
  'responseRef',
  'presentationRef',
  'state',
  'surface',
  'callbackEvent',
  'deliveryState',
  'terminal',
  'attemptNumber',
  'promptLayerContractVersion',
  'producerTraceContractVersion',
  'promptProducerScope',
  'unknownPromptLayerCount',
  'producerLifecycleHash',
  'producerAttemptHistoryHash',
  'producerCapacityHistoryHash',
  'producerCallbackHistoryHash',
  'producerPromptHash',
  'producerArtifactRefsHash',
  'candidateDigest',
  'runtimeOwnerBindingHash',
  'installedArtifactDigest',
  'contextSnapshotHash',
  'capabilitySetHash',
  'effectPlane',
  'outcome',
  'action',
  'provider',
  'model',
  'providerStatus',
  'attemptRole',
  'primaryProvider',
  'primaryModel',
  'primaryProviderStatus',
  'fallbackProvider',
  'fallbackModel',
  'fallbackProviderStatus',
  'configuredFallback',
  'requiredCapabilitiesPreserved',
  'effectCount',
]);
const REDACTED_FACT_KEYS = new Set<keyof RedactedTraceEventFacts>([
  'sourceEventRefHash',
  'logicalTurnRefHash',
  'workRefHash',
  'runRefHash',
  'callbackRefHash',
  'deliveryRefHash',
  'callSessionRefHash',
  'taskRefHash',
  'streamRefHash',
  'actionRefHash',
  'receiptRefHash',
  'attemptRefHash',
  'providerRequestRefHash',
  'primaryAttemptRefHash',
  'fallbackAttemptRefHash',
  'responseRefHash',
  'presentationRefHash',
  'state',
  'surface',
  'callbackEvent',
  'deliveryState',
  'terminal',
  'attemptNumber',
  'promptLayerContractVersion',
  'producerTraceContractVersion',
  'promptProducerScope',
  'unknownPromptLayerCount',
  'producerLifecycleHash',
  'producerAttemptHistoryHash',
  'producerCapacityHistoryHash',
  'producerCallbackHistoryHash',
  'producerPromptHash',
  'producerArtifactRefsHash',
  'candidateDigest',
  'runtimeOwnerBindingHash',
  'installedArtifactDigest',
  'contextSnapshotHash',
  'capabilitySetHash',
  'effectPlane',
  'outcome',
  'action',
  'provider',
  'model',
  'providerStatus',
  'attemptRole',
  'primaryProvider',
  'primaryModel',
  'primaryProviderStatus',
  'fallbackProvider',
  'fallbackModel',
  'fallbackProviderStatus',
  'configuredFallback',
  'requiredCapabilitiesPreserved',
  'effectCount',
]);
const REDACTED_REFERENCE_KEYS = [
  'sourceEventRefHash',
  'logicalTurnRefHash',
  'workRefHash',
  'runRefHash',
  'callbackRefHash',
  'deliveryRefHash',
  'callSessionRefHash',
  'taskRefHash',
  'streamRefHash',
  'actionRefHash',
  'receiptRefHash',
  'attemptRefHash',
  'providerRequestRefHash',
  'primaryAttemptRefHash',
  'fallbackAttemptRefHash',
  'responseRefHash',
  'presentationRefHash',
] as const;
const PRODUCER_HASH_KEYS = [
  'producerLifecycleHash',
  'producerAttemptHistoryHash',
  'producerCapacityHistoryHash',
  'producerCallbackHistoryHash',
  'producerPromptHash',
  'producerArtifactRefsHash',
  'candidateDigest',
  'runtimeOwnerBindingHash',
  'installedArtifactDigest',
  'contextSnapshotHash',
  'capabilitySetHash',
] as const;
const REFERENCE_FACTS = [
  ['sourceEventRef', 'source_event', 'sourceEventRefHash'],
  ['logicalTurnRef', 'logical_turn', 'logicalTurnRefHash'],
  ['workRef', 'work', 'workRefHash'],
  ['runRef', 'run', 'runRefHash'],
  ['callbackRef', 'callback', 'callbackRefHash'],
  ['deliveryRef', 'delivery', 'deliveryRefHash'],
  ['callSessionRef', 'call_session', 'callSessionRefHash'],
  ['taskRef', 'voice_task', 'taskRefHash'],
  ['streamRef', 'generation_stream', 'streamRefHash'],
  ['actionRef', 'work_action', 'actionRefHash'],
  ['receiptRef', 'effect_receipt', 'receiptRefHash'],
  ['attemptRef', 'provider_attempt', 'attemptRefHash'],
  ['providerRequestRef', 'provider_request', 'providerRequestRefHash'],
  ['primaryAttemptRef', 'provider_attempt', 'primaryAttemptRefHash'],
  ['fallbackAttemptRef', 'provider_attempt', 'fallbackAttemptRefHash'],
  ['responseRef', 'response', 'responseRefHash'],
  ['presentationRef', 'voice_presentation', 'presentationRefHash'],
] as const;

export class OrchestrationTraceValidationError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'OrchestrationTraceValidationError';
  }
}

export class OrchestrationTraceConflictError extends Error {
  constructor() {
    super('orchestration_trace_event_conflict');
    this.name = 'OrchestrationTraceConflictError';
  }
}

function sha256(value: string): string {
  return `${HASH_PREFIX}${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(source[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function requiredText(value: string, code: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 4096) {
    throw new OrchestrationTraceValidationError(code);
  }
  return normalized;
}

function eventTimestamp(value?: string | Date): string {
  let parsed = new Date();
  if (value instanceof Date) parsed = value;
  else if (value != null) parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new OrchestrationTraceValidationError('orchestration_trace_event_time_invalid');
  }
  return parsed.toISOString();
}

function safeEnum(
  value: string | undefined,
  allowed: ReadonlySet<string>,
  code: string,
): string | undefined {
  if (value == null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!allowed.has(normalized)) throw new OrchestrationTraceValidationError(code);
  return normalized;
}

function safeExactEnum(
  value: string | undefined,
  allowed: ReadonlySet<string>,
  code: string,
): string | undefined {
  if (value == null) return undefined;
  const normalized = String(value).trim();
  if (!allowed.has(normalized)) throw new OrchestrationTraceValidationError(code);
  return normalized;
}

function safeInteger(value: number | undefined, code: string): number | undefined {
  if (value == null) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OrchestrationTraceValidationError(code);
  }
  return value;
}

function safeToken(value: string | undefined, code: string): string | undefined {
  if (value == null) return undefined;
  const normalized = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,159}$/.test(normalized)) {
    throw new OrchestrationTraceValidationError(code);
  }
  return normalized;
}

export function fingerprintTraceReference(kind: string, value: string): string {
  return sha256(
    `${requiredText(kind, 'orchestration_trace_ref_kind_invalid')}\0${requiredText(
      value,
      'orchestration_trace_ref_invalid',
    )}`,
  );
}

function redactFacts(input: TraceEventFactsInput = {}): RedactedTraceEventFacts {
  const unknownKeys = Object.keys(input).filter(
    (key) => !FACT_KEYS.has(key as keyof TraceEventFactsInput),
  );
  if (unknownKeys.length > 0) {
    throw new OrchestrationTraceValidationError('orchestration_trace_fact_contract_invalid');
  }
  const facts: RedactedTraceEventFacts = {};
  for (const [inputKey, kind, outputKey] of REFERENCE_FACTS) {
    const value = input[inputKey];
    if (value != null && String(value).trim()) {
      facts[outputKey] = fingerprintTraceReference(kind, String(value));
    }
  }
  const state = safeEnum(input.state, STATES, 'orchestration_trace_state_invalid');
  const surface = safeEnum(input.surface, SURFACES, 'orchestration_trace_surface_invalid');
  const callbackEvent = safeEnum(
    input.callbackEvent,
    CALLBACK_EVENTS,
    'orchestration_trace_callback_event_invalid',
  );
  const deliveryState = safeEnum(
    input.deliveryState,
    DELIVERY_STATES,
    'orchestration_trace_delivery_state_invalid',
  );
  const attemptNumber = safeInteger(
    input.attemptNumber,
    'orchestration_trace_attempt_number_invalid',
  );
  const unknownPromptLayerCount = safeInteger(
    input.unknownPromptLayerCount,
    'orchestration_trace_prompt_layer_count_invalid',
  );
  const effectCount = safeInteger(input.effectCount, 'orchestration_trace_effect_count_invalid');
  const effectPlane = safeExactEnum(
    input.effectPlane,
    EFFECT_PLANES,
    'orchestration_trace_effect_plane_invalid',
  );
  const outcome = safeEnum(input.outcome, OUTCOMES, 'orchestration_trace_outcome_invalid');
  const action = safeEnum(input.action, VOICE_ACTIONS, 'orchestration_trace_action_invalid');
  const providerStatus = safeEnum(
    input.providerStatus,
    PROVIDER_STATUSES,
    'orchestration_trace_provider_status_invalid',
  );
  const primaryProviderStatus = safeEnum(
    input.primaryProviderStatus,
    PROVIDER_STATUSES,
    'orchestration_trace_primary_provider_status_invalid',
  );
  const fallbackProviderStatus = safeEnum(
    input.fallbackProviderStatus,
    PROVIDER_STATUSES,
    'orchestration_trace_fallback_provider_status_invalid',
  );
  const attemptRole = safeEnum(
    input.attemptRole,
    ATTEMPT_ROLES,
    'orchestration_trace_attempt_role_invalid',
  );
  const provider = safeToken(input.provider, 'orchestration_trace_provider_invalid');
  const model = safeToken(input.model, 'orchestration_trace_model_invalid');
  const primaryProvider = safeToken(
    input.primaryProvider,
    'orchestration_trace_primary_provider_invalid',
  );
  const primaryModel = safeToken(input.primaryModel, 'orchestration_trace_primary_model_invalid');
  const fallbackProvider = safeToken(
    input.fallbackProvider,
    'orchestration_trace_fallback_provider_invalid',
  );
  const fallbackModel = safeToken(
    input.fallbackModel,
    'orchestration_trace_fallback_model_invalid',
  );
  if (state) facts.state = state;
  if (surface) facts.surface = surface;
  if (callbackEvent) facts.callbackEvent = callbackEvent;
  if (deliveryState) facts.deliveryState = deliveryState;
  if (typeof input.terminal === 'boolean') facts.terminal = input.terminal;
  if (attemptNumber != null) facts.attemptNumber = attemptNumber;
  if (input.promptLayerContractVersion != null) {
    if (input.promptLayerContractVersion !== 1) {
      throw new OrchestrationTraceValidationError('orchestration_trace_prompt_contract_invalid');
    }
    facts.promptLayerContractVersion = 1;
  }
  if (input.producerTraceContractVersion != null) {
    if (![1, 2].includes(input.producerTraceContractVersion)) {
      throw new OrchestrationTraceValidationError('orchestration_trace_producer_contract_invalid');
    }
    facts.producerTraceContractVersion = input.producerTraceContractVersion;
  }
  if (input.promptProducerScope != null) {
    if (input.promptProducerScope !== 'glasshive.worker_prompt_registry') {
      throw new OrchestrationTraceValidationError('orchestration_trace_prompt_scope_invalid');
    }
    facts.promptProducerScope = input.promptProducerScope;
  }
  if (unknownPromptLayerCount != null) facts.unknownPromptLayerCount = unknownPromptLayerCount;
  if (effectCount != null) facts.effectCount = effectCount;
  if (effectPlane) facts.effectPlane = effectPlane;
  if (outcome) facts.outcome = outcome;
  if (action) facts.action = action;
  if (provider) facts.provider = provider;
  if (model) facts.model = model;
  if (providerStatus) facts.providerStatus = providerStatus;
  if (attemptRole) facts.attemptRole = attemptRole;
  if (primaryProvider) facts.primaryProvider = primaryProvider;
  if (primaryModel) facts.primaryModel = primaryModel;
  if (primaryProviderStatus) facts.primaryProviderStatus = primaryProviderStatus;
  if (fallbackProvider) facts.fallbackProvider = fallbackProvider;
  if (fallbackModel) facts.fallbackModel = fallbackModel;
  if (fallbackProviderStatus) facts.fallbackProviderStatus = fallbackProviderStatus;
  if (typeof input.configuredFallback === 'boolean') {
    facts.configuredFallback = input.configuredFallback;
  }
  if (typeof input.requiredCapabilitiesPreserved === 'boolean') {
    facts.requiredCapabilitiesPreserved = input.requiredCapabilitiesPreserved;
  }
  for (const key of PRODUCER_HASH_KEYS) {
    const value = input[key];
    if (value == null) continue;
    if (!HASH.test(value)) {
      throw new OrchestrationTraceValidationError('orchestration_trace_producer_hash_invalid');
    }
    facts[key] = value;
  }
  return facts;
}

function contentHash(stage: TraceStage, facts: RedactedTraceEventFacts): string {
  return sha256(stableStringify({ schemaVersion: 1, stage, facts }));
}

function eventHash(row: {
  ownerScopeHash: string;
  originRefHash: string;
  sequence: number;
  stage: TraceStage;
  at: string;
  facts: RedactedTraceEventFacts;
  eventKeyHash: string;
  contentHash: string;
  previousEventHash: string;
}): string {
  return sha256(stableStringify({ schemaVersion: 1, ...row }));
}

function duplicateKey(error: Error & { code?: number }): boolean {
  return error.code === 11000;
}

export async function appendOrchestrationTraceEvent(
  input: AppendOrchestrationTraceEventInput,
): Promise<OrchestrationTraceEventRow> {
  const ownerId = requiredText(input.ownerId, 'orchestration_trace_owner_invalid');
  const originRef = requiredText(input.originRef, 'orchestration_trace_origin_invalid');
  const eventKey = requiredText(input.eventKey, 'orchestration_trace_event_key_invalid');
  if (!TRACE_STAGES.has(input.stage)) {
    throw new OrchestrationTraceValidationError('orchestration_trace_stage_invalid');
  }
  const scope = {
    ownerScopeHash: fingerprintTraceReference('owner', ownerId),
    originRefHash: fingerprintTraceReference('origin', originRef),
  };
  const eventKeyHash = fingerprintTraceReference('event_key', eventKey);
  const facts = redactFacts(input.facts);
  const expectedContentHash = contentHash(input.stage, facts);
  const at = eventTimestamp(input.at);

  for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt += 1) {
    const existing = await input.store.findByEventKey({ ...scope, eventKeyHash });
    if (existing) {
      const exactFirstObservationReplay =
        FIRST_OBSERVATION_REPLAY_STAGES.has(input.stage) &&
        existing.stage === input.stage &&
        existing.contentHash === expectedContentHash;
      // An exact retry can replay immutable launch intent, and a callback confirmation can replay
      // launch/callback acceptance at a later receiver time. Keep the first observation when the
      // typed facts match; changed facts and runtime progress still fail closed below.
      if (
        exactFirstObservationReplay ||
        (existing.contentHash === expectedContentHash && existing.at === at)
      ) {
        return existing;
      }
      throw new OrchestrationTraceConflictError();
    }
    const latest = await input.store.findLatest(scope);
    const sequence = (latest?.sequence || 0) + 1;
    const previousEventHash = latest?.eventHash || GENESIS_HASH;
    const hash = eventHash({
      ...scope,
      sequence,
      stage: input.stage,
      at,
      facts,
      eventKeyHash,
      contentHash: expectedContentHash,
      previousEventHash,
    });
    const row: OrchestrationTraceEventRow = {
      schemaVersion: 1,
      ...scope,
      sequence,
      stage: input.stage,
      at,
      facts,
      eventKeyHash,
      contentHash: expectedContentHash,
      previousEventHash,
      eventHash: hash,
    };
    try {
      return await input.store.insert(row);
    } catch (error) {
      if (!duplicateKey(error as Error & { code?: number })) throw error;
    }
  }
  throw new OrchestrationTraceConflictError();
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new OrchestrationTraceValidationError('orchestration_trace_pagination_invalid');
  }
  return value;
}

function verifyRows(
  rows: OrchestrationTraceEventRow[],
  scope: TraceScopeQuery,
  expectedPreviousHash: string,
  expectedSequence: number,
): string[] {
  const errors: string[] = [];
  let previousHash = expectedPreviousHash;
  let sequence = expectedSequence;
  for (const row of rows) {
    if (row.sequence !== sequence) errors.push(`sequence_gap:${row.sequence}`);
    if (row.previousEventHash !== previousHash)
      errors.push(`previous_hash_mismatch:${row.sequence}`);
    const expectedContentHash = contentHash(row.stage, row.facts);
    if (row.contentHash !== expectedContentHash)
      errors.push(`content_hash_mismatch:${row.sequence}`);
    const expectedEventHash = eventHash({
      ...scope,
      sequence: row.sequence,
      stage: row.stage,
      at: row.at,
      facts: row.facts,
      eventKeyHash: row.eventKeyHash,
      contentHash: row.contentHash,
      previousEventHash: row.previousEventHash,
    });
    if (row.eventHash !== expectedEventHash) errors.push(`event_hash_mismatch:${row.sequence}`);
    previousHash = row.eventHash;
    sequence = row.sequence + 1;
  }
  return errors;
}

function persistedRowValid(row: OrchestrationTraceEventRow, scope: TraceScopeQuery): boolean {
  if (
    !row ||
    row.schemaVersion !== 1 ||
    row.ownerScopeHash !== scope.ownerScopeHash ||
    row.originRefHash !== scope.originRefHash ||
    !HASH.test(row.ownerScopeHash) ||
    !HASH.test(row.originRefHash) ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    !TRACE_STAGES.has(row.stage) ||
    !Number.isFinite(new Date(row.at).getTime()) ||
    !HASH.test(row.eventKeyHash) ||
    !HASH.test(row.contentHash) ||
    !HASH.test(row.previousEventHash) ||
    !HASH.test(row.eventHash) ||
    !row.facts ||
    typeof row.facts !== 'object' ||
    Array.isArray(row.facts)
  )
    return false;
  if (
    Object.keys(row.facts).some(
      (key) => !REDACTED_FACT_KEYS.has(key as keyof RedactedTraceEventFacts),
    )
  ) {
    return false;
  }
  if (
    REDACTED_REFERENCE_KEYS.some(
      (key) => row.facts[key] != null && !HASH.test(String(row.facts[key])),
    )
  ) {
    return false;
  }
  if (
    PRODUCER_HASH_KEYS.some((key) => row.facts[key] != null && !HASH.test(String(row.facts[key])))
  ) {
    return false;
  }
  if (row.facts.state != null && !STATES.has(row.facts.state)) return false;
  if (row.facts.surface != null && !SURFACES.has(row.facts.surface)) return false;
  if (row.facts.callbackEvent != null && !CALLBACK_EVENTS.has(row.facts.callbackEvent))
    return false;
  if (row.facts.deliveryState != null && !DELIVERY_STATES.has(row.facts.deliveryState))
    return false;
  if (row.facts.effectPlane != null && !EFFECT_PLANES.has(row.facts.effectPlane)) return false;
  if (row.facts.outcome != null && !OUTCOMES.has(row.facts.outcome)) return false;
  if (row.facts.action != null && !VOICE_ACTIONS.has(row.facts.action)) return false;
  if (row.facts.providerStatus != null && !PROVIDER_STATUSES.has(row.facts.providerStatus))
    return false;
  if (
    row.facts.primaryProviderStatus != null &&
    !PROVIDER_STATUSES.has(row.facts.primaryProviderStatus)
  )
    return false;
  if (
    row.facts.fallbackProviderStatus != null &&
    !PROVIDER_STATUSES.has(row.facts.fallbackProviderStatus)
  )
    return false;
  if (row.facts.attemptRole != null && !ATTEMPT_ROLES.has(row.facts.attemptRole)) return false;
  for (const key of [
    'provider',
    'model',
    'primaryProvider',
    'primaryModel',
    'fallbackProvider',
    'fallbackModel',
  ] as const) {
    if (
      row.facts[key] != null &&
      !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,159}$/.test(String(row.facts[key]))
    )
      return false;
  }
  if (row.facts.terminal != null && typeof row.facts.terminal !== 'boolean') return false;
  if (row.facts.configuredFallback != null && typeof row.facts.configuredFallback !== 'boolean')
    return false;
  if (
    row.facts.requiredCapabilitiesPreserved != null &&
    typeof row.facts.requiredCapabilitiesPreserved !== 'boolean'
  )
    return false;
  if (
    row.facts.attemptNumber != null &&
    (!Number.isSafeInteger(row.facts.attemptNumber) || row.facts.attemptNumber < 0)
  )
    return false;
  if (
    row.facts.effectCount != null &&
    (!Number.isSafeInteger(row.facts.effectCount) || row.facts.effectCount < 0)
  )
    return false;
  if (row.facts.promptLayerContractVersion != null && row.facts.promptLayerContractVersion !== 1)
    return false;
  if (
    row.facts.producerTraceContractVersion != null &&
    ![1, 2].includes(row.facts.producerTraceContractVersion)
  )
    return false;
  if (
    row.facts.promptProducerScope != null &&
    row.facts.promptProducerScope !== 'glasshive.worker_prompt_registry'
  )
    return false;
  return !(
    row.facts.unknownPromptLayerCount != null &&
    (!Number.isSafeInteger(row.facts.unknownPromptLayerCount) ||
      row.facts.unknownPromptLayerCount < 0)
  );
}

export async function readOrchestrationTraceLedger(input: {
  store: OrchestrationTraceLedgerStore;
  ownerId: string;
  originRef: string;
  afterSequence?: number;
  limit?: number;
}): Promise<OrchestrationTraceLedgerPage> {
  const ownerScopeHash = fingerprintTraceReference('owner', input.ownerId);
  const originRefHash = fingerprintTraceReference('origin', input.originRef);
  const afterSequence = boundedInteger(input.afterSequence, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(input.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE) || DEFAULT_PAGE_SIZE;
  const scope = { ownerScopeHash, originRefHash };
  const [rowsWithOverflow, previous] = await Promise.all([
    input.store.listPage({ ...scope, afterSequence, limit: limit + 1 }),
    afterSequence > 0
      ? input.store.findBySequence({ ...scope, sequence: afterSequence })
      : Promise.resolve(null),
  ]);
  const rawRows = rowsWithOverflow.slice(0, limit);
  const invalidRows = rawRows.filter((row) => !persistedRowValid(row, scope));
  const rows = rawRows.filter((row) => persistedRowValid(row, scope));
  const previousValid = previous ? persistedRowValid(previous, scope) : false;
  const previousEventHash = previousValid && previous ? previous.eventHash : GENESIS_HASH;
  const errors = invalidRows.map(
    (row) =>
      `row_contract_invalid:${Number.isSafeInteger(row?.sequence) ? row.sequence : 'unknown'}`,
  );
  errors.push(...verifyRows(rows, scope, previousEventHash, afterSequence + 1));
  if (afterSequence > 0 && !previousValid) errors.unshift('cursor_predecessor_missing');
  const hasMore = rowsWithOverflow.length > limit;
  const pageVerified = errors.length === 0;
  const fullChainVerified = afterSequence === 0 && !hasMore && pageVerified;
  const lastRawSequence = rawRows[rawRows.length - 1]?.sequence;
  const nextCursor = hasMore && Number.isSafeInteger(lastRawSequence) ? lastRawSequence : null;
  const events = Object.freeze(
    rows.map((row) =>
      Object.freeze({
        sequence: row.sequence,
        stage: row.stage,
        at: row.at,
        facts: Object.freeze({ ...row.facts }),
        previousEventHash: row.previousEventHash,
        eventHash: row.eventHash,
      }),
    ),
  );
  return Object.freeze({
    version: 1 as const,
    ownerScopeHash,
    originRefHash,
    events,
    chain: Object.freeze({
      pageVerified,
      fullChainVerified,
      errors: Object.freeze(errors),
      previousEventHash,
      headEventHash: rows.length > 0 ? rows[rows.length - 1].eventHash : null,
    }),
    pagination: Object.freeze({
      afterSequence,
      limit,
      returned: rows.length,
      remaining: hasMore ? null : 0,
      hasMore,
      overflow: hasMore,
      nextCursor,
    }),
  });
}
