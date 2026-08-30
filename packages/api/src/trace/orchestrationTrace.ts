/* === VIVENTIUM START ===
 * Feature: Unified owner-scoped orchestration trace projection.
 * Purpose: Claims use immutable ledger evidence; mutable summaries are diagnostics only.
 * === VIVENTIUM END === */

import { createHash } from 'crypto';
import {
  fingerprintGlassHiveRunRef,
  GLASSHIVE_WORKER_PROMPT_LAYER_NAMES,
  GLASSHIVE_WORKER_PROMPT_PRODUCER_SCOPE,
  projectGlassHiveProducerFactFingerprints,
  projectGlassHiveArtifactRefs,
  validateGlassHiveWorkDetailTrace,
} from './glassHiveTraceContract';
import { fingerprintTraceReference } from './orchestrationTraceLedger';

import type {
  OrchestrationTraceLedgerPage,
  RedactedTraceEventFacts,
  TraceStage,
} from './orchestrationTraceLedger';

type TraceLedgerEvent = OrchestrationTraceLedgerPage['events'][number];

type TraceDate = Date | string | number | null;

interface LaunchBindingFact {
  ownerId: string;
  originRef: string;
  workRef?: string;
  sourceEventId?: string;
  logicalTurnId?: string;
  launchState?: string;
  createdAt?: TraceDate;
  updatedAt?: TraceDate;
}

interface ExternalWorkFact {
  ownerId: string;
  originRef: string;
  workRef?: string;
  runId?: string;
  launchState?: string;
  externalState?: string;
  deliveryState?: string;
  terminalAt?: TraceDate;
  adjudicatedAt?: TraceDate;
  deliveryUpdatedAt?: TraceDate;
}

interface CapacityVector {
  childProcesses?: number;
  diskBytes?: number;
  memoryBytes?: number;
  threads?: number;
}

interface CapacityFact {
  class?: string;
  available?: CapacityVector;
  required?: CapacityVector;
  shortage?: CapacityVector;
  reservation?: CapacityVector;
  nextRetryAt?: TraceDate;
}

interface LifecycleFact {
  attemptNumber?: number;
  queuedAt?: TraceDate;
  claimedAt?: TraceDate;
  admittedAt?: TraceDate;
  runtimeInvokedAt?: TraceDate;
  startedAt?: TraceDate;
  endedAt?: TraceDate;
}

interface PromptLayerFact {
  contractVersion?: number;
  producerScope?: string;
  layerNames?: string[];
  unknownLayerNames?: string[];
}

interface GlassHiveDetailFact {
  workRef?: string;
  runRef?: string;
  state?: string;
  lifecycle?: LifecycleFact;
  attemptHistory?: unknown;
  attemptHistoryOverflowCount?: number;
  capacityAttempts?: unknown;
  capacityAttemptOverflowCount?: number;
  callbackDeliveries?: unknown;
  callbackDeliveryOverflowCount?: number;
  capacity?: CapacityFact;
  traceability?: { contractVersion?: number; promptLayers?: PromptLayerFact };
  viewRef?: string;
  artifactRefs?: unknown;
  title?: string;
  provider?: string;
  executionMode?: string;
  pid?: number;
  argv?: string[];
  localPath?: string;
}

export interface UnifiedOrchestrationTraceInput {
  ownerId: string;
  originRef: string;
  binding: LaunchBindingFact | null;
  externalWork?: ExternalWorkFact | null;
  deliveries?: object[];
  promptLayers?: PromptLayerFact;
  glassHiveDetail?: GlassHiveDetailFact | null;
  glassHiveReadStatus?: string;
  ledgerPage?: OrchestrationTraceLedgerPage | null;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,191}$/;
const SAFE_LAYER_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/;
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const DIAGNOSTIC_STATES = new Set([
  'unknown',
  'preparing',
  'prepared',
  'not_dispatched',
  'dispatch_ready',
  'dispatch_unknown',
  'accepted',
  'callback_confirmed',
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
  'pending',
  'enqueued',
  'sent',
  'suppressed',
  'unresolved',
  'delivery_unknown',
  'not_applicable',
  'available',
  'unavailable',
  'missing',
]);
const CAPACITY_KEYS = ['childProcesses', 'threads', 'memoryBytes', 'diskBytes'] as const;
const LIFECYCLE_STAGES: TraceStage[] = [
  'work.queued',
  'work.claimed',
  'work.admitted',
  'runtime.invoked',
  'work.running',
  'work.completed',
];
const PRODUCER_FACT_KEYS = [
  'producerLifecycleHash',
  'producerAttemptHistoryHash',
  'producerCapacityHistoryHash',
  'producerCallbackHistoryHash',
  'producerPromptHash',
  'producerArtifactRefsHash',
] as const;

export class OrchestrationTraceAccessError extends Error {
  constructor() {
    super('orchestration_trace_not_found');
    this.name = 'OrchestrationTraceAccessError';
  }
}

function identifier(value: string | undefined): string {
  const normalized = String(value || '').trim();
  return IDENTIFIER.test(normalized) ? normalized : '';
}

function state(value: string | undefined): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return DIAGNOSTIC_STATES.has(normalized) ? normalized : 'unknown';
}

function timestamp(value: TraceDate | undefined): string {
  if (value == null) return '';
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
}

function safeReference(value: string | undefined): string {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048) return '';
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function capacityVector(value: CapacityVector | undefined): Readonly<CapacityVector> {
  const projected: CapacityVector = {};
  for (const key of CAPACITY_KEYS) {
    const numeric = Number(value?.[key]);
    if (Number.isSafeInteger(numeric) && numeric >= 0) projected[key] = numeric;
  }
  return Object.freeze(projected);
}

function capacity(value: CapacityFact | undefined) {
  const capacityClass = String(value?.class || '').trim();
  if (!value || !capacityClass || capacityClass.length > 256) return null;
  return Object.freeze({
    class: fingerprintTraceReference('capacity_class', capacityClass),
    available: capacityVector(value.available),
    required: capacityVector(value.required),
    shortage: capacityVector(value.shortage),
    reservation: capacityVector(value.reservation),
    nextRetryAt: timestamp(value.nextRetryAt) || null,
  });
}

function lifecycle(value: LifecycleFact | undefined) {
  const attemptNumber = Number(value?.attemptNumber);
  return Object.freeze({
    attemptNumber: Number.isSafeInteger(attemptNumber) && attemptNumber >= 0 ? attemptNumber : null,
    queuedAt: timestamp(value?.queuedAt) || null,
    claimedAt: timestamp(value?.claimedAt) || null,
    admittedAt: timestamp(value?.admittedAt) || null,
    runtimeInvokedAt: timestamp(value?.runtimeInvokedAt) || null,
    startedAt: timestamp(value?.startedAt) || null,
    endedAt: timestamp(value?.endedAt) || null,
  });
}

function promptLayerIntegrity(
  _core: PromptLayerFact | undefined,
  worker: PromptLayerFact | undefined,
) {
  if (!worker) {
    return Object.freeze({
      status: 'unknown',
      contractVersion: null,
      producerScope: null,
      unknownLayerCount: 0,
      invalidNameCount: 0,
      reason: 'remote_prompt_layer_capability_missing',
    });
  }
  const allowedKeys = ['contractVersion', 'producerScope', 'layerNames', 'unknownLayerNames'];
  const keys = Object.keys(worker);
  const exactContract =
    keys.length === allowedKeys.length && keys.every((key) => allowedKeys.includes(key));
  const layerNames = Array.isArray(worker.layerNames) ? worker.layerNames : null;
  const unknownNames = Array.isArray(worker.unknownLayerNames) ? worker.unknownLayerNames : null;
  const invalidNameCount = [...(layerNames || []), ...(unknownNames || [])].filter(
    (name) => typeof name !== 'string' || !SAFE_LAYER_NAME.test(name.trim()),
  ).length;
  const exactLayerRegistry = Boolean(
    layerNames &&
    layerNames.length === GLASSHIVE_WORKER_PROMPT_LAYER_NAMES.length &&
    layerNames.every((name, index) => name === GLASSHIVE_WORKER_PROMPT_LAYER_NAMES[index]),
  );
  const unknownLayerCount = unknownNames?.length || 0;
  const verified =
    exactContract &&
    worker.contractVersion === 1 &&
    worker.producerScope === GLASSHIVE_WORKER_PROMPT_PRODUCER_SCOPE &&
    exactLayerRegistry &&
    unknownNames != null &&
    unknownLayerCount === 0 &&
    invalidNameCount === 0;
  return Object.freeze({
    status: verified ? 'verified' : 'invalid',
    contractVersion: worker.contractVersion === 1 ? 1 : null,
    producerScope:
      worker.producerScope === GLASSHIVE_WORKER_PROMPT_PRODUCER_SCOPE ? worker.producerScope : null,
    unknownLayerCount,
    invalidNameCount,
    ...(verified ? {} : { reason: 'prompt_layer_contract_invalid' }),
  });
}

function producerRunIdentity(
  detailRunRef: string | undefined,
  externalRunRef: string,
  terminal: TraceLedgerEvent | null,
) {
  if (!externalRunRef || !detailRunRef) {
    return Object.freeze({ status: 'missing', reason: 'producer_run_identity_missing' });
  }
  const expectedProducerRef = fingerprintGlassHiveRunRef(externalRunRef);
  const expectedLedgerRef = fingerprintTraceReference('run', externalRunRef);
  if (
    detailRunRef !== expectedProducerRef ||
    !terminal ||
    terminal.facts.runRefHash !== expectedLedgerRef
  ) {
    return Object.freeze({ status: 'invalid', reason: 'producer_run_identity_mismatch' });
  }
  return Object.freeze({ status: 'verified' });
}

function eventByStage(page: OrchestrationTraceLedgerPage | null, stage: TraceStage) {
  return page?.events.find((event) => event.stage === stage) || null;
}

function terminalEvent(page: OrchestrationTraceLedgerPage | null) {
  const terminals = (page?.events || []).filter((event) =>
    ['work.completed', 'work.failed', 'work.cancelled'].includes(event.stage),
  );
  const producerBound = terminals.filter((event) =>
    PRODUCER_FACT_KEYS.every((key) => Boolean(event.facts[key])),
  );
  return producerBound[producerBound.length - 1] || terminals[terminals.length - 1] || null;
}

function producerFactsMatch(
  facts: Readonly<RedactedTraceEventFacts>,
  expected: ReturnType<typeof projectGlassHiveProducerFactFingerprints>,
): boolean {
  return Boolean(expected && PRODUCER_FACT_KEYS.every((key) => facts[key] === expected[key]));
}

function sameCallbackIdentity(
  left: Readonly<RedactedTraceEventFacts>,
  right: Readonly<RedactedTraceEventFacts>,
): boolean {
  return Boolean(
    sameWorkRunAttemptIdentity(left, right) &&
    left.callbackRefHash &&
    left.callbackRefHash === right.callbackRefHash,
  );
}

function sameWorkRunAttemptIdentity(
  left: Readonly<RedactedTraceEventFacts>,
  right: Readonly<RedactedTraceEventFacts>,
): boolean {
  return Boolean(
    sameWorkRunIdentity(left, right) &&
    ((left.attemptNumber == null && right.attemptNumber == null) ||
      (left.attemptNumber != null && left.attemptNumber === right.attemptNumber)),
  );
}

function terminalCallbackEvents(state: string): ReadonlySet<string> {
  if (state === 'completed') return new Set(['run.completed']);
  if (state === 'failed') return new Set(['run.failed']);
  if (state === 'cancelled') return new Set(['run.cancelled', 'run.interrupted']);
  return new Set();
}

function sameWorkRunIdentity(
  left: Readonly<RedactedTraceEventFacts>,
  right: Readonly<RedactedTraceEventFacts>,
): boolean {
  return Boolean(
    left.workRefHash &&
    left.runRefHash &&
    left.workRefHash === right.workRefHash &&
    left.runRefHash === right.runRefHash,
  );
}

function sameWorkIdentity(
  left: Readonly<RedactedTraceEventFacts>,
  right: Readonly<RedactedTraceEventFacts>,
): boolean {
  return Boolean(left.workRefHash && left.workRefHash === right.workRefHash);
}

function eventByStageForWork(
  page: OrchestrationTraceLedgerPage | null,
  stage: TraceStage,
  anchor: TraceLedgerEvent | null,
): TraceLedgerEvent | null {
  if (!anchor) return null;
  return (
    page?.events.find(
      (event) => event.stage === stage && sameWorkIdentity(anchor.facts, event.facts),
    ) || null
  );
}

function eventByStageForWorkRunAttempt(
  page: OrchestrationTraceLedgerPage | null,
  stage: TraceStage,
  terminal: TraceLedgerEvent | null,
): TraceLedgerEvent | null {
  if (!terminal) return null;
  return (
    page?.events.find(
      (event) => event.stage === stage && sameWorkRunAttemptIdentity(terminal.facts, event.facts),
    ) || null
  );
}

function lifecycleChronology(
  page: OrchestrationTraceLedgerPage | null,
  terminal: TraceLedgerEvent | null,
  terminalCallback: TraceLedgerEvent | null,
  terminalDelivery: TraceLedgerEvent | null,
) {
  const preRuntimeTerminal =
    terminal?.facts.attemptNumber == null &&
    ['work.failed', 'work.cancelled'].includes(String(terminal?.stage || ''));
  const lifecycleStages = preRuntimeTerminal
    ? (['work.queued', terminal?.stage] as TraceStage[])
    : ([...LIFECYCLE_STAGES.slice(0, -1), terminal?.stage] as TraceStage[]);
  const events = lifecycleStages.map(
    (stage) =>
      (stage === terminal?.stage
        ? terminal
        : page?.events.find(
            (event) =>
              event.stage === stage &&
              terminal &&
              sameWorkRunAttemptIdentity(terminal.facts, event.facts),
          )) || null,
  );
  if (events.some((item) => !item)) {
    return Object.freeze({ status: 'missing', reason: 'lifecycle_stage_missing' });
  }
  let previousAt = '';
  let previousSequence = 0;
  for (const item of events) {
    if (!item) continue;
    if (item.sequence <= previousSequence || (previousAt && item.at < previousAt)) {
      return Object.freeze({ status: 'invalid', reason: 'lifecycle_chronology_reversed' });
    }
    previousAt = item.at;
    previousSequence = item.sequence;
  }
  if (
    terminal &&
    terminalCallback &&
    terminalDelivery &&
    !(
      terminal.sequence < terminalCallback.sequence &&
      terminalCallback.sequence < terminalDelivery.sequence &&
      terminal.at < terminalCallback.at &&
      terminalCallback.at < terminalDelivery.at
    )
  ) {
    return Object.freeze({ status: 'invalid', reason: 'terminal_causal_order_invalid' });
  }
  return Object.freeze({ status: 'verified' });
}

export function buildUnifiedOrchestrationTrace(input: UnifiedOrchestrationTraceInput) {
  const requestedOwner = identifier(input.ownerId);
  const requestedOrigin = identifier(input.originRef);
  const bindingOwner = identifier(input.binding?.ownerId);
  const bindingOrigin = identifier(input.binding?.originRef);
  const expectedOwnerHash = requestedOwner
    ? fingerprintTraceReference('owner', requestedOwner)
    : '';
  const expectedOriginHash = requestedOrigin
    ? fingerprintTraceReference('origin', requestedOrigin)
    : '';
  const ledgerOwnerMatches = input.ledgerPage?.ownerScopeHash === expectedOwnerHash;
  const ledgerOriginMatches = input.ledgerPage?.originRefHash === expectedOriginHash;
  const bindingMatches =
    input.binding != null && bindingOwner === requestedOwner && bindingOrigin === requestedOrigin;
  if (
    !requestedOwner ||
    !requestedOrigin ||
    (input.binding && !bindingMatches) ||
    (input.ledgerPage && (!ledgerOwnerMatches || !ledgerOriginMatches)) ||
    (!bindingMatches && !input.ledgerPage)
  ) {
    throw new OrchestrationTraceAccessError();
  }

  const externalWork =
    input.externalWork?.ownerId === requestedOwner &&
    input.externalWork?.originRef === requestedOrigin
      ? input.externalWork
      : null;
  const externalRunRef = identifier(externalWork?.runId);
  const detail = input.glassHiveDetail || null;
  const invalidDetailWorkRef = detail != null && !identifier(detail.workRef);
  const rawWorkRefs = [input.binding?.workRef, externalWork?.workRef, detail?.workRef]
    .map(identifier)
    .filter(Boolean);
  const uniqueWorkRefs = [...new Set(rawWorkRefs)];
  let workRefStatus = 'conflict';
  if (invalidDetailWorkRef) workRefStatus = 'invalid';
  else if (uniqueWorkRefs.length === 0) workRefStatus = 'missing';
  else if (uniqueWorkRefs.length === 1) workRefStatus = 'verified';
  const workRefHash =
    uniqueWorkRefs.length === 1 ? fingerprintTraceReference('work', uniqueWorkRefs[0]) : null;
  const conflicts: string[] = [];
  if (workRefStatus === 'conflict') conflicts.push('work_ref_mismatch');
  if (workRefStatus === 'invalid') conflicts.push('work_ref_invalid');
  const ledgerPage = input.ledgerPage || null;
  const promptLayers = promptLayerIntegrity(input.promptLayers, detail?.traceability?.promptLayers);
  const producerTraceErrors =
    detail && uniqueWorkRefs.length === 1 && externalRunRef
      ? validateGlassHiveWorkDetailTrace({
          workRef: uniqueWorkRefs[0],
          runRef: externalRunRef,
          detail,
        })
      : Object.freeze(['producer_trace_contract_missing']);
  const producerTraceContract = Object.freeze({
    status: producerTraceErrors.length === 0 ? 'verified' : 'invalid',
    errors: producerTraceErrors,
  });
  const producerTraceContractVersion = detail?.traceability?.contractVersion === 2 ? 2 : 1;
  const producerFingerprints =
    detail && uniqueWorkRefs.length === 1 && externalRunRef
      ? projectGlassHiveProducerFactFingerprints({
          workRef: uniqueWorkRefs[0],
          runRef: externalRunRef,
          detail,
        })
      : null;
  const artifactRefs = projectGlassHiveArtifactRefs(detail?.artifactRefs);
  let artifactRefsStatus = 'missing';
  if (detail) artifactRefsStatus = 'invalid';
  if (artifactRefs) artifactRefsStatus = 'verified';
  const artifactRefsIntegrity = Object.freeze({
    status: artifactRefsStatus,
  });
  const invalidPromptLayerEvent = eventByStage(ledgerPage, 'prompt.layers.invalid');
  if (invalidPromptLayerEvent) conflicts.push('prompt_layer_contract_invalid');
  const terminal = terminalEvent(ledgerPage);
  const producerFactsBound = Boolean(
    terminal && producerFactsMatch(terminal.facts, producerFingerprints),
  );
  if (terminal && producerFingerprints && !producerFactsBound) {
    conflicts.push('producer_fact_fingerprint_mismatch');
  }
  const terminalState = terminal?.stage.slice(5) || 'unknown';
  const allowedTerminalCallbackEvents = terminalCallbackEvents(terminalState);
  const preRuntimeTerminal =
    terminal?.facts.attemptNumber == null && ['failed', 'cancelled'].includes(terminalState);
  const terminalFactsExact = Boolean(
    terminal && terminal.facts.terminal === true && terminal.facts.state === terminalState,
  );
  if (terminal && !terminalFactsExact) conflicts.push('terminal_work_fact_mismatch');
  const terminalTruth = Object.freeze({
    isTerminal: TERMINAL_STATES.has(terminalState),
    successful: terminalState === 'completed' && terminalFactsExact,
    state: terminalState,
    evidenceExact: terminalFactsExact,
  });
  const acceptedLaunch = eventByStageForWork(ledgerPage, 'launch.accepted', terminal);
  const verifiedPromptLayerEvent = terminal
    ? (ledgerPage?.events || []).find(
        (item) =>
          item.stage === 'prompt.layers.verified' &&
          item.facts.promptLayerContractVersion === 1 &&
          item.facts.promptProducerScope === GLASSHIVE_WORKER_PROMPT_PRODUCER_SCOPE &&
          item.facts.unknownPromptLayerCount === 0 &&
          producerFactsMatch(item.facts, producerFingerprints) &&
          sameWorkRunAttemptIdentity(terminal.facts, item.facts),
      ) || null
    : null;
  const producerCallbackHistoryEvent = terminal
    ? (ledgerPage?.events || []).find(
        (item) =>
          item.stage === 'callback.history.complete' &&
          allowedTerminalCallbackEvents.has(String(item.facts.callbackEvent || '')) &&
          Boolean(item.facts.callbackRefHash) &&
          producerFactsMatch(item.facts, producerFingerprints) &&
          sameWorkRunAttemptIdentity(terminal.facts, item.facts),
      ) || null
    : null;
  const acceptedTerminalCallbacks = (ledgerPage?.events || []).filter(
    (item) =>
      item.stage === 'callback.accepted' &&
      item.facts.terminal === true &&
      item.facts.state === terminalState &&
      allowedTerminalCallbackEvents.has(String(item.facts.callbackEvent || '')),
  );
  const terminalAttemptCallbacks = terminal
    ? acceptedTerminalCallbacks.filter((item) =>
        sameWorkRunAttemptIdentity(terminal.facts, item.facts),
      )
    : [];
  const matchingTerminalCallbacks = terminal
    ? terminalAttemptCallbacks.filter(
        (item) =>
          producerCallbackHistoryEvent &&
          sameCallbackIdentity(producerCallbackHistoryEvent.facts, item.facts),
      )
    : [];
  if (terminalAttemptCallbacks.length > 1) conflicts.push('duplicate_terminal_callbacks');
  const terminalCallback =
    terminal && terminalAttemptCallbacks.length === 1 && matchingTerminalCallbacks.length === 1
      ? matchingTerminalCallbacks.find(
          (item) => item.sequence > terminal.sequence && item.at > terminal.at,
        ) ||
        matchingTerminalCallbacks[0] ||
        null
      : null;
  const matchingTerminalDeliveries = terminalCallback
    ? (ledgerPage?.events || []).filter(
        (item) =>
          item.stage === 'callback.delivery.sent' &&
          item.facts.deliveryState === 'sent' &&
          Boolean(item.facts.deliveryRefHash) &&
          allowedTerminalCallbackEvents.has(String(item.facts.callbackEvent || '')) &&
          item.facts.state === terminalState &&
          item.facts.terminal === true &&
          sameCallbackIdentity(terminalCallback.facts, item.facts),
      )
    : [];
  if (matchingTerminalDeliveries.length > 1) conflicts.push('duplicate_terminal_deliveries');
  const terminalDelivery =
    terminalCallback && matchingTerminalDeliveries.length === 1
      ? matchingTerminalDeliveries.find(
          (item) => item.sequence > terminalCallback.sequence && item.at > terminalCallback.at,
        ) ||
        matchingTerminalDeliveries[0] ||
        null
      : null;
  const anyTerminalDelivery = (ledgerPage?.events || []).some(
    (item) => item.stage === 'callback.delivery.sent',
  );
  const chronology = lifecycleChronology(
    ledgerPage,
    terminal,
    terminalCallback || null,
    terminalDelivery || null,
  );
  if (terminalCallback && anyTerminalDelivery && !terminalDelivery) {
    conflicts.push('terminal_callback_delivery_mismatch');
  }
  if (acceptedTerminalCallbacks.length > 0 && !terminalCallback) {
    conflicts.push('terminal_callback_identity_mismatch');
  }
  if (terminal?.facts.workRefHash && workRefHash && terminal.facts.workRefHash !== workRefHash) {
    conflicts.push('terminal_work_ref_mismatch');
  }
  const runIdentity = producerRunIdentity(detail?.runRef, externalRunRef, terminal);
  if (runIdentity.status === 'invalid') conflicts.push('producer_run_identity_mismatch');
  if (
    externalRunRef &&
    terminal?.facts.runRefHash !== fingerprintTraceReference('run', externalRunRef)
  ) {
    conflicts.push('terminal_run_ref_mismatch');
  }
  const currentWorkState = state(detail?.state || externalWork?.externalState);
  if (
    terminalTruth.isTerminal &&
    currentWorkState !== 'unknown' &&
    currentWorkState !== terminalTruth.state
  ) {
    conflicts.push('current_work_state_mismatch');
  }

  const missingStages: string[] = [];
  const producerStage = (stage: TraceStage) => {
    const event = eventByStageForWorkRunAttempt(ledgerPage, stage, terminal);
    return event && producerFactsMatch(event.facts, producerFingerprints) ? event : null;
  };
  const runtimeInvocation = producerStage('runtime.invoked');
  const runtimeInvokedAt = runtimeInvocation ? new Date(runtimeInvocation.at).getTime() : NaN;
  const terminalAt = terminal ? new Date(terminal.at).getTime() : NaN;
  const providerForwarding =
    runtimeInvocation && terminal
      ? (ledgerPage?.events || []).find((event) => {
          const forwardedAt = new Date(event.at).getTime();
          return (
            event.stage === 'provider.request.forwarded' &&
            sameWorkRunIdentity(terminal.facts, event.facts) &&
            event.facts.providerStatus === 'completed' &&
            Boolean(event.facts.providerRequestRefHash) &&
            Number.isFinite(forwardedAt) &&
            forwardedAt >= runtimeInvokedAt &&
            forwardedAt <= terminalAt
          );
        }) || null
      : null;
  if (!ledgerPage || ledgerPage.events.length === 0) missingStages.push('immutable_trace_ledger');
  if (!ledgerPage?.chain.fullChainVerified) missingStages.push('trace_chain_verified');
  if (!eventByStage(ledgerPage, 'source.bound')) missingStages.push('source_bound');
  if (!acceptedLaunch) missingStages.push('launch_accepted');
  if (!producerStage('work.queued')) missingStages.push('work_queued');
  if (!preRuntimeTerminal) {
    if (!producerStage('work.claimed')) missingStages.push('work_claimed');
    if (!producerStage('work.admitted')) missingStages.push('work_admitted');
    if (!runtimeInvocation) missingStages.push('runtime_invocation');
    if (!producerStage('work.running')) missingStages.push('runtime_started');
    if (producerTraceContractVersion !== 2 || terminal?.facts.producerTraceContractVersion !== 2) {
      missingStages.push('producer_trace_v2');
    }
    if (!providerForwarding) missingStages.push('provider_request_forwarded');
  }
  if (!producerStage('attempt.history.complete')) {
    missingStages.push('attempt_history');
  }
  if (!producerStage('capacity.history.complete')) {
    missingStages.push('capacity_attempt_history');
  }
  if (!producerStage('callback.history.complete')) {
    missingStages.push('callback_history');
  }
  if (!terminalTruth.successful) missingStages.push('successful_terminal_work');
  if (!terminalCallback) missingStages.push('terminal_callback_acceptance');
  if (!terminalDelivery) missingStages.push('terminal_callback_delivery');
  if (promptLayers.status !== 'verified' || !verifiedPromptLayerEvent || invalidPromptLayerEvent) {
    missingStages.push('prompt_layers_verified');
  }
  if (chronology.status !== 'verified') missingStages.push('monotonic_lifecycle');
  if (workRefStatus !== 'verified') missingStages.push('authoritative_work_ref');
  if (runIdentity.status !== 'verified') missingStages.push('producer_run_identity');
  if (artifactRefsIntegrity.status !== 'verified') missingStages.push('artifact_refs_verified');
  if (producerTraceContract.status !== 'verified') missingStages.push('producer_trace_contract');
  if (!producerFactsBound) missingStages.push('producer_facts_bound');

  const completionClaimable =
    missingStages.length === 0 &&
    conflicts.length === 0 &&
    terminalTruth.successful &&
    Boolean(terminalCallback && terminalDelivery);
  const sourceEvent = eventByStage(ledgerPage, 'source.bound');
  const launchState = state(input.binding?.launchState || externalWork?.launchState);
  const deliveryState = state(externalWork?.deliveryState);

  return Object.freeze({
    version: 2,
    traceRef: expectedOriginHash,
    workRef: workRefHash,
    source: Object.freeze({
      sourceEventRef: sourceEvent?.facts.sourceEventRefHash || null,
      logicalTurnRef: sourceEvent?.facts.logicalTurnRefHash || null,
    }),
    current: Object.freeze({
      launchState,
      workState: currentWorkState,
      deliveryState,
      lifecycle: lifecycle(detail?.lifecycle),
      capacity: capacity(detail?.capacity),
      viewRef: safeReference(detail?.viewRef) || null,
      artifactRefs:
        artifactRefs ||
        Object.freeze({ available: false, refs: Object.freeze([]), overflowCount: 0 }),
      glassHiveReadStatus: state(input.glassHiveReadStatus || (detail ? 'available' : 'missing')),
    }),
    events: ledgerPage?.events || Object.freeze([]),
    ledger: ledgerPage,
    completionClaims: Object.freeze({ allowed: completionClaimable }),
    traceability: Object.freeze({
      promptLayers,
    }),
    integrity: Object.freeze({
      ownerScoped: true,
      persistence: Object.freeze({
        appendOnlyApi: true,
        databaseImmutable: false,
        hashChainVerified: Boolean(ledgerPage?.chain.fullChainVerified),
      }),
      workRefStatus,
      promptLayers,
      producerRunIdentity: runIdentity,
      producerTraceContract,
      producerFacts: Object.freeze({ status: producerFactsBound ? 'verified' : 'invalid' }),
      artifactRefs: artifactRefsIntegrity,
      terminalTruth,
      lifecycleChronology: chronology,
      completionClaimable,
      missingStages: Object.freeze([...new Set(missingStages)]),
      conflicts: Object.freeze([...new Set(conflicts)]),
    }),
  });
}
