/* === VIVENTIUM START ===
 * Feature: Typed launch, callback, and delivery trace projections.
 * Purpose: Convert trusted runtime metadata into the ledger's closed redacted fact contract.
 * === VIVENTIUM END === */

import { createHash } from 'crypto';
import { OrchestrationTraceValidationError } from './orchestrationTraceLedger';

import type { TraceEventFactsInput, TraceStage } from './orchestrationTraceLedger';

export interface TraceEventProjection {
  eventKey: string;
  stage: TraceStage;
  at?: string | Date;
  facts: TraceEventFactsInput;
}

interface PromptLayersInput {
  contractVersion?: number;
  unknownLayerNames?: string[];
}

const SAFE_LAYER_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/;
const CALLBACK_REF = /^callback_sha256:[a-f0-9]{64}$/;
const CALLBACK_LIFECYCLE_STAGES = new Map<string, TraceStage>([
  ['run.queued', 'work.queued'],
  ['run.claimed', 'work.claimed'],
  ['run.admitted', 'work.admitted'],
  ['runtime.invoked', 'runtime.invoked'],
  ['run.started', 'work.running'],
]);
const DELIVERY_STAGES = new Map<string, TraceStage>([
  ['pending', 'callback.delivery.pending'],
  ['claimed', 'callback.delivery.claimed'],
  ['sent', 'callback.delivery.sent'],
  ['failed', 'callback.delivery.failed'],
  ['suppressed', 'callback.delivery.suppressed'],
  ['unresolved', 'callback.delivery.unresolved'],
  ['delivery_unknown', 'callback.delivery.unresolved'],
]);

function text(value: string | undefined): string {
  return String(value || '').trim();
}

export function canonicalizeGlassHiveCallbackRef(value: string): string {
  const normalized = text(value);
  if (!normalized) {
    throw new OrchestrationTraceValidationError('orchestration_trace_callback_ref_invalid');
  }
  if (CALLBACK_REF.test(normalized)) return normalized;
  return `callback_sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

function exactTraceIdentity(input: {
  workRef: string;
  runRef: string;
  callbackRef: string;
  attemptNumber?: number | null;
  allowPreRuntime?: boolean;
}) {
  const workRef = text(input.workRef);
  const runRef = text(input.runRef);
  const callbackRef = text(input.callbackRef);
  if (!workRef) throw new OrchestrationTraceValidationError('orchestration_trace_work_ref_invalid');
  if (!runRef) throw new OrchestrationTraceValidationError('orchestration_trace_run_ref_invalid');
  if (!CALLBACK_REF.test(callbackRef)) {
    throw new OrchestrationTraceValidationError('orchestration_trace_callback_ref_invalid');
  }
  const preRuntime = input.allowPreRuntime === true && input.attemptNumber == null;
  if (
    !preRuntime &&
    (!Number.isSafeInteger(input.attemptNumber) || Number(input.attemptNumber) < 1)
  ) {
    throw new OrchestrationTraceValidationError('orchestration_trace_attempt_number_invalid');
  }
  return {
    workRef,
    runRef,
    callbackRef,
    attemptNumber: preRuntime ? null : Number(input.attemptNumber),
  };
}

function promptProjection(value: PromptLayersInput | undefined): TraceEventProjection {
  const names = Array.isArray(value?.unknownLayerNames) ? value.unknownLayerNames : null;
  const invalidNameCount = names
    ? names.filter((name) => typeof name !== 'string' || !SAFE_LAYER_NAME.test(name.trim())).length
    : 1;
  const unknownPromptLayerCount = names?.length || invalidNameCount;
  const valid =
    value?.contractVersion === 1 && unknownPromptLayerCount === 0 && invalidNameCount === 0;
  return {
    eventKey: `prompt.layers:${valid ? 'verified' : 'invalid'}:${value?.contractVersion || 0}:${unknownPromptLayerCount}`,
    stage: valid ? 'prompt.layers.verified' : 'prompt.layers.invalid',
    facts: {
      ...(value?.contractVersion === 1 ? { promptLayerContractVersion: 1 } : {}),
      unknownPromptLayerCount,
    },
  };
}

export function buildLaunchTraceEvents(input: {
  originRef: string;
  sourceEventRef?: string;
  logicalTurnRef?: string;
  promptLayers?: PromptLayersInput;
  at?: string | Date;
}): TraceEventProjection[] {
  const sourceEventRef = text(input.sourceEventRef) || text(input.originRef);
  return [
    {
      eventKey: `source.bound:${sourceEventRef}`,
      stage: 'source.bound',
      at: input.at,
      facts: {
        sourceEventRef,
        ...(text(input.logicalTurnRef) ? { logicalTurnRef: text(input.logicalTurnRef) } : {}),
      },
    },
    { ...promptProjection(input.promptLayers), at: input.at },
    {
      eventKey: `launch.prepared:${text(input.originRef)}`,
      stage: 'launch.prepared',
      at: input.at,
      facts: {},
    },
  ];
}

export function buildAcceptedLaunchTraceEvent(input: {
  workRef: string;
  at?: string | Date;
}): TraceEventProjection {
  return {
    eventKey: `launch.accepted:${text(input.workRef)}`,
    stage: 'launch.accepted',
    at: input.at,
    facts: { workRef: text(input.workRef) },
  };
}

export function buildFailedLaunchTraceEvent(input: {
  originRef: string;
  at?: string | Date;
}): TraceEventProjection {
  return {
    eventKey: `launch.failed:${text(input.originRef)}`,
    stage: 'launch.failed',
    at: input.at,
    facts: { state: 'failed', terminal: true },
  };
}

export function buildCallbackTraceEvents(input: {
  workRef: string;
  runRef: string;
  callbackRef: string;
  event: string;
  workState?: string;
  workTerminal?: boolean;
  callbackAt?: string | Date;
  callbackAcceptedAt?: string | Date;
  attemptNumber?: number | null;
}): TraceEventProjection[] {
  const event = text(input.event).toLowerCase();
  const workState = text(input.workState).toLowerCase();
  const preRuntimeTerminal =
    input.workTerminal === true &&
    ['failed', 'cancelled'].includes(workState) &&
    ['run.failed', 'run.cancelled', 'run.interrupted'].includes(event) &&
    input.attemptNumber == null;
  const identity = exactTraceIdentity({ ...input, allowPreRuntime: preRuntimeTerminal });
  const attemptKey = identity.attemptNumber == null ? 'pre-runtime' : identity.attemptNumber;
  const commonFacts: TraceEventFactsInput = {
    workRef: identity.workRef,
    runRef: identity.runRef,
    ...(identity.attemptNumber == null ? {} : { attemptNumber: identity.attemptNumber }),
  };
  const events: TraceEventProjection[] = [];
  const lifecycleStage = CALLBACK_LIFECYCLE_STAGES.get(event);
  if (lifecycleStage) {
    events.push({
      eventKey: `${lifecycleStage}:${identity.runRef}:${attemptKey}`,
      stage: lifecycleStage,
      at: input.callbackAt,
      facts: commonFacts,
    });
  }
  if (input.workTerminal === true && ['completed', 'failed', 'cancelled'].includes(workState)) {
    events.push({
      eventKey: `work.${workState}:${identity.runRef}:${attemptKey}`,
      stage: `work.${workState}` as TraceStage,
      at: input.callbackAt,
      facts: { ...commonFacts, state: workState, terminal: true },
    });
  }
  events.push({
    eventKey: `callback.accepted:${identity.callbackRef}:${attemptKey}`,
    stage: 'callback.accepted',
    at: input.callbackAcceptedAt || input.callbackAt,
    facts: {
      ...commonFacts,
      callbackRef: identity.callbackRef,
      callbackEvent: event,
      ...(workState ? { state: workState } : {}),
      terminal: input.workTerminal === true,
    },
  });
  return events;
}

export function buildDeliveryTraceEvent(input: {
  deliveryRef: string;
  workRef: string;
  runRef: string;
  callbackRef: string;
  callbackEvent: string;
  state?: string;
  terminal?: boolean;
  surface: string;
  status: string;
  at?: string | Date;
  attemptNumber?: number | null;
}): TraceEventProjection {
  const status = text(input.status).toLowerCase();
  const stage = DELIVERY_STAGES.get(status);
  if (!stage) throw new Error('orchestration_trace_delivery_status_invalid');
  const state = text(input.state).toLowerCase();
  const callbackEvent = text(input.callbackEvent).toLowerCase();
  const preRuntimeTerminal =
    input.terminal === true &&
    ['failed', 'cancelled'].includes(state) &&
    ['run.failed', 'run.cancelled', 'run.interrupted'].includes(callbackEvent) &&
    input.attemptNumber == null;
  const identity = exactTraceIdentity({ ...input, allowPreRuntime: preRuntimeTerminal });
  const attemptKey = identity.attemptNumber == null ? 'pre-runtime' : identity.attemptNumber;
  const deliveryRef = text(input.deliveryRef);
  if (!deliveryRef) {
    throw new OrchestrationTraceValidationError('orchestration_trace_delivery_ref_invalid');
  }
  return {
    eventKey: `${stage}:${deliveryRef}:${attemptKey}`,
    stage,
    at: input.at,
    facts: {
      deliveryRef,
      workRef: identity.workRef,
      runRef: identity.runRef,
      callbackRef: identity.callbackRef,
      callbackEvent,
      ...(state ? { state } : {}),
      terminal: input.terminal === true,
      surface: text(input.surface).toLowerCase(),
      deliveryState: status,
      ...(identity.attemptNumber == null ? {} : { attemptNumber: identity.attemptNumber }),
    },
  };
}
