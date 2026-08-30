/* === VIVENTIUM START ===
 * Feature: Trusted GlassHive work-detail trace ingestion.
 * Purpose: Convert one authenticated, exact producer contract into immutable Core evidence.
 * === VIVENTIUM END === */

import { createHash } from 'crypto';
import {
  OrchestrationTraceConflictError,
  appendOrchestrationTraceEvent,
} from './orchestrationTraceLedger';

import type {
  OrchestrationTraceLedgerStore,
  TraceEventFactsInput,
  TraceStage,
} from './orchestrationTraceLedger';

export const GLASSHIVE_WORKER_PROMPT_PRODUCER_SCOPE = 'glasshive.worker_prompt_registry';
export const GLASSHIVE_WORK_TRACE_SCHEMA_DIGEST =
  'sha256:ba9b15e022a451c62be0c0f30a02d6615bea83e868b2ffdd349beff75002e790';
export const GLASSHIVE_WORK_TRACE_PRODUCER_SOURCE_IDENTITY =
  'workers_projects_runtime.api:get_active_work';
export const GLASSHIVE_WORK_TRACE_EMITTED_KEY_SET_DIGEST =
  'sha256:3a109b0f41a08755252a050e444dd6780e7bf95aec194ad95628e4e7a5c3a253';

interface TraceProjection {
  eventKey: string;
  stage: TraceStage;
  at: string;
  facts: TraceEventFactsInput;
}

export interface GlassHiveTraceIngestionResult {
  accepted: boolean;
  errors: ReadonlyArray<string>;
  eventCount: number;
}

export interface GlassHiveArtifactRef {
  artifactRef: string;
  fingerprint: string;
  kind: string;
  state: string;
  sizeBytes: number | null;
}

export interface GlassHiveArtifactRefs {
  available: boolean;
  refs: ReadonlyArray<Readonly<GlassHiveArtifactRef>>;
  overflowCount: 0;
}

export interface GlassHiveProducerFactFingerprints {
  producerLifecycleHash: string;
  producerAttemptHistoryHash: string;
  producerCapacityHistoryHash: string;
  producerCallbackHistoryHash: string;
  producerPromptHash: string;
  producerArtifactRefsHash: string;
}

const WORK_REF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,191}$/;
const RUN_REF = /^run_sha256:[a-f0-9]{64}$/;
const CALLBACK_REF = /^callback_sha256:[a-f0-9]{64}$/;
const ORIGIN_REF = /^origin_sha256:[a-f0-9]{64}$/;
const SOURCE_EVENT_REF = /^source_sha256:[a-f0-9]{64}$/;
const PROVIDER_ATTEMPT_REF = /^provider_attempt_sha256:[a-f0-9]{64}$/;
const RUNTIME_INVOCATION_REF = /^runtime_invocation_sha256:[a-f0-9]{64}$/;
const PROVIDER_AUTHORIZATION_PREFLIGHT_REF =
  /^provider_authorization_preflight_sha256:[a-f0-9]{64}$/;
const ARTIFACT_REF = /^artifact_sha256:([a-f0-9]{64})$/;
const FINGERPRINT = /^sha256:([a-f0-9]{64})$/;
const ATTEMPT_KEYS = [
  'attemptNumber',
  'state',
  'claimedAt',
  'admittedAt',
  'runtimeInvokedAt',
  'endedAt',
  'terminalReason',
  'providerHealthObservedLastFailedAt',
  'providerHealthObservedGeneration',
] as const;
export const GLASSHIVE_WORKER_PROMPT_LAYER_NAMES = Object.freeze([
  'agents_md',
  'claude_md',
  'codex_md',
  'developer_instructions',
  'glasshive_worker_project_contract',
  'harness_prompt',
  'mcp_server_instructions',
  'project_definition',
  'run_instruction',
  'system_instructions',
  'tool_schemas',
  'viventium_feeling_state',
] as const);
const ORIGIN_SURFACES = new Set([
  'web',
  'chat',
  'desktop',
  'telegram',
  'voice',
  'workbench',
  'scheduler',
]);
const ARTIFACT_KINDS = new Set([
  'artifact',
  'archive',
  'audio',
  'code',
  'document',
  'file',
  'html',
  'image',
  'json',
  'report',
  'text',
  'video',
  'webpage',
]);
const ARTIFACT_STATES = new Set(['available', 'completed', 'missing', 'ready', 'unavailable']);
const DETAIL_KEYS = new Set([
  'workRef',
  'title',
  'state',
  'statusSummary',
  'provider',
  'originSurface',
  'nativeTeam',
  'delivery',
  'createdAt',
  'updatedAt',
  'actions',
  'queue',
  'capacity',
  'route',
  'viewRef',
  'attention',
  'runRef',
  'executionMode',
  'resourceClass',
  'resourceReservation',
  'lifecycle',
  'traceability',
  'attemptHistory',
  'attemptHistoryOverflowCount',
  'capacityAttempts',
  'capacityAttemptOverflowCount',
  'callbackDeliveries',
  'callbackDeliveryOverflowCount',
  'artifactHistory',
  'artifactHistoryOverflowCount',
  'artifactRefs',
  'historyPage',
]);
const CONDITIONAL_DETAIL_KEYS = new Set(['capacity', 'route', 'attention']);
const REQUIRED_COMPLETED_DETAIL_KEYS = [...DETAIL_KEYS].filter(
  (key) => !CONDITIONAL_DETAIL_KEYS.has(key),
);
const CALLBACK_EVENTS = new Set([
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
const PRE_ATTEMPT_CALLBACK_EVENTS = new Set([
  'run.queued',
  'worker.message_queued',
  'run.queue_status',
  'run.waiting_on_capacity',
]);
const CALLBACK_STATUSES = new Set([
  'pending',
  'delivering',
  'superseded',
  'http_accepted',
  'accepted',
  'delivered',
  'dead_lettered',
]);
const CALLBACK_KEYS = [
  'callbackRef',
  'callbackRevision',
  'ledgerSequence',
  'previousEventSha256',
  'eventSha256',
  'attemptNumber',
  'event',
  'status',
  'attempts',
  'createdAt',
  'updatedAt',
  'acceptedAt',
  'payloadSha256',
  'resultRevision',
  'resultDigest',
  'deliveryGeneration',
  'authoritySha256',
] as const;
const CALLBACK_STATUS_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  pending: new Set(['pending', 'delivering', 'superseded', 'dead_lettered']),
  delivering: new Set([
    'delivering',
    'pending',
    'superseded',
    'http_accepted',
    'accepted',
    'delivered',
    'dead_lettered',
  ]),
  superseded: new Set<string>(),
  http_accepted: new Set<string>(),
  accepted: new Set<string>(),
  delivered: new Set<string>(),
  dead_lettered: new Set<string>(),
});
const ATTEMPT_STATES = new Set(['retry_queued', 'needs_input', 'completed', 'failed', 'cancelled']);
const TERMINAL_CALLBACK_EVENTS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  completed: new Set(['run.completed']),
  failed: new Set(['run.failed']),
  cancelled: new Set(['run.cancelled', 'run.interrupted']),
});

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown> | null | undefined,
  allowed: ReadonlyArray<string>,
): boolean {
  if (!value) return false;
  const expected = new Set(allowed);
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function iso(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
}

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function publicLabel(value: unknown, maximumLength: number): boolean {
  const hasOnlyPublicCharacters =
    typeof value === 'string' &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    });
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    hasOnlyPublicCharacters
  );
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

function producerFactHash(kind: string, value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(`${kind}\0${stableStringify(value)}`, 'utf8')
    .digest('hex')}`;
}

function producerFactFingerprints(
  detail: Record<string, unknown>,
  artifactRefs: Readonly<GlassHiveArtifactRefs>,
): GlassHiveProducerFactFingerprints {
  const traceability = detail.traceability as Record<string, unknown>;
  const traceContractVersion = traceability.contractVersion === 2 ? 2 : 1;
  const callbackLedger = detail.callbackDeliveries as Array<Record<string, unknown>>;
  const terminalEvents = TERMINAL_CALLBACK_EVENTS[String(detail.state || '')];
  const latestByCallback = new Map<string, Record<string, unknown>>();
  for (const entry of callbackLedger) {
    latestByCallback.set(String(entry.callbackRef || ''), entry);
  }
  const callbackAuthorities = [...latestByCallback.values()]
    .filter(
      (entry) =>
        terminalEvents?.has(String(entry.event || '')) &&
        ['delivering', 'http_accepted', 'accepted', 'delivered'].includes(
          String(entry.status || ''),
        ),
    )
    .map((entry) => ({
      callbackRef: entry.callbackRef,
      event: entry.event,
      attemptNumber: entry.attemptNumber,
      createdAt: entry.createdAt,
      payloadSha256: entry.payloadSha256,
      resultRevision: entry.resultRevision,
      resultDigest: entry.resultDigest,
    }));
  return {
    producerLifecycleHash: producerFactHash('glasshive.lifecycle.v1', detail.lifecycle),
    producerAttemptHistoryHash: producerFactHash(
      `glasshive.attempt_history.v${traceContractVersion}`,
      traceContractVersion === 2
        ? {
            entries: detail.attemptHistory,
            overflowCount: detail.attemptHistoryOverflowCount,
            runtimeInvocations: traceability.runtimeInvocations,
            providerAuthorizationPreflights: traceability.providerAuthorizationPreflights,
          }
        : {
            entries: detail.attemptHistory,
            overflowCount: detail.attemptHistoryOverflowCount,
            providerAttempts: traceability.providerAttempts,
          },
    ),
    producerCapacityHistoryHash: producerFactHash('glasshive.capacity_history.v1', {
      entries: detail.capacityAttempts,
      overflowCount: detail.capacityAttemptOverflowCount,
    }),
    producerCallbackHistoryHash: producerFactHash('glasshive.callback_history.v1', {
      authorities: callbackAuthorities,
    }),
    producerPromptHash: producerFactHash('glasshive.prompt_facts.v1', {
      origin: traceability.origin,
      promptLayers: traceability.promptLayers,
    }),
    producerArtifactRefsHash: producerFactHash('glasshive.artifact_refs.v1', {
      history: detail.artifactHistory,
      overflowCount: detail.artifactHistoryOverflowCount,
      latest: artifactRefs,
    }),
  };
}

function strictPrompt(value: unknown): boolean {
  const prompt = record(value);
  return Boolean(
    prompt &&
    exactKeys(prompt, ['contractVersion', 'producerScope', 'layerNames', 'unknownLayerNames']) &&
    prompt.contractVersion === 1 &&
    prompt.producerScope === GLASSHIVE_WORKER_PROMPT_PRODUCER_SCOPE &&
    Array.isArray(prompt.layerNames) &&
    prompt.layerNames.length === GLASSHIVE_WORKER_PROMPT_LAYER_NAMES.length &&
    prompt.layerNames.every((name, index) => name === GLASSHIVE_WORKER_PROMPT_LAYER_NAMES[index]) &&
    Array.isArray(prompt.unknownLayerNames) &&
    prompt.unknownLayerNames.length === 0,
  );
}

function strictOrigin(value: unknown): boolean {
  const origin = record(value);
  return Boolean(
    origin &&
    exactKeys(origin, ['originRef', 'sourceEventRef', 'sourceRevision', 'surface']) &&
    typeof origin.originRef === 'string' &&
    ORIGIN_REF.test(origin.originRef) &&
    (origin.sourceEventRef === null ||
      (typeof origin.sourceEventRef === 'string' &&
        SOURCE_EVENT_REF.test(origin.sourceEventRef))) &&
    count(origin.sourceRevision) != null &&
    Number(origin.sourceRevision) > 0 &&
    typeof origin.surface === 'string' &&
    ORIGIN_SURFACES.has(origin.surface),
  );
}

function strictTraceIntegrity(value: unknown): boolean {
  const integrity = record(value);
  return Boolean(
    integrity &&
    exactKeys(integrity, ['algorithm', 'eventCount', 'headSha256']) &&
    integrity.algorithm === 'sha256-chain-v1' &&
    count(integrity.eventCount) != null &&
    Number(integrity.eventCount) > 0 &&
    typeof integrity.headSha256 === 'string' &&
    FINGERPRINT.test(integrity.headSha256),
  );
}

function strictProviderAttempts(value: unknown, attemptHistory: ReadonlyArray<unknown>): boolean {
  if (!Array.isArray(value) || value.length > 16) return false;
  const expectedInvocations = new Map<number, string>();
  for (const item of attemptHistory) {
    const attempt = record(item);
    const attemptNumber = count(attempt?.attemptNumber);
    const runtimeInvokedAt = attempt?.runtimeInvokedAt == null ? '' : iso(attempt.runtimeInvokedAt);
    if (attemptNumber != null && attemptNumber > 0 && runtimeInvokedAt) {
      expectedInvocations.set(attemptNumber, runtimeInvokedAt);
    }
  }
  if (expectedInvocations.size === 0) return value.length === 0;
  if (value.length === 0) return false;
  if (expectedInvocations.size !== value.length) return false;
  let previousAttemptNumber = 0;
  for (const item of value) {
    const providerAttempt = record(item);
    if (
      !providerAttempt ||
      !exactKeys(providerAttempt, [
        'attemptNumber',
        'model',
        'profile',
        'providerAttemptRef',
        'runtime',
        'runtimeInvokedAt',
      ])
    ) {
      return false;
    }
    const attemptNumber = count(providerAttempt.attemptNumber);
    const runtimeInvokedAt = iso(providerAttempt.runtimeInvokedAt);
    if (
      attemptNumber == null ||
      attemptNumber <= previousAttemptNumber ||
      !publicLabel(providerAttempt.model, 200) ||
      !publicLabel(providerAttempt.profile, 100) ||
      !publicLabel(providerAttempt.runtime, 100) ||
      typeof providerAttempt.providerAttemptRef !== 'string' ||
      !PROVIDER_ATTEMPT_REF.test(providerAttempt.providerAttemptRef) ||
      !runtimeInvokedAt ||
      expectedInvocations.get(attemptNumber) !== runtimeInvokedAt
    ) {
      return false;
    }
    previousAttemptNumber = attemptNumber;
  }
  return true;
}

function strictRuntimeInvocations(
  value: unknown,
  attemptHistory: ReadonlyArray<unknown>,
): Map<number, string> | null {
  if (!Array.isArray(value) || value.length > 16) return null;
  const expectedInvocations = new Map<number, string>();
  for (const item of attemptHistory) {
    const attempt = record(item);
    const attemptNumber = count(attempt?.attemptNumber);
    const runtimeInvokedAt = attempt?.runtimeInvokedAt == null ? '' : iso(attempt.runtimeInvokedAt);
    if (attemptNumber != null && attemptNumber > 0 && runtimeInvokedAt) {
      expectedInvocations.set(attemptNumber, runtimeInvokedAt);
    }
  }
  if (expectedInvocations.size !== value.length) return null;
  let previousAttemptNumber = 0;
  for (const item of value) {
    const invocation = record(item);
    if (
      !invocation ||
      !exactKeys(invocation, [
        'attemptNumber',
        'model',
        'profile',
        'runtime',
        'runtimeInvocationRef',
        'runtimeInvokedAt',
      ])
    ) {
      return null;
    }
    const attemptNumber = count(invocation.attemptNumber);
    const runtimeInvokedAt = iso(invocation.runtimeInvokedAt);
    if (
      attemptNumber == null ||
      attemptNumber <= previousAttemptNumber ||
      !publicLabel(invocation.model, 200) ||
      !publicLabel(invocation.profile, 100) ||
      !publicLabel(invocation.runtime, 100) ||
      typeof invocation.runtimeInvocationRef !== 'string' ||
      !RUNTIME_INVOCATION_REF.test(invocation.runtimeInvocationRef) ||
      !runtimeInvokedAt ||
      expectedInvocations.get(attemptNumber) !== runtimeInvokedAt
    ) {
      return null;
    }
    previousAttemptNumber = attemptNumber;
  }
  return expectedInvocations;
}

function strictProviderAuthorizationPreflights(
  value: unknown,
  attemptHistory: ReadonlyArray<unknown>,
  runtimeInvocations: ReadonlyMap<number, string>,
): boolean {
  if (!Array.isArray(value) || value.length > 16) return false;
  const attempts = new Map<number, Record<string, unknown>>();
  for (const item of attemptHistory) {
    const attempt = record(item);
    const attemptNumber = count(attempt?.attemptNumber);
    if (attemptNumber != null && attemptNumber > 0 && attempt) attempts.set(attemptNumber, attempt);
  }
  const authorizedAttempts = new Set<number>();
  const seenPreflights = new Set<string>();
  let previousAttemptNumber = 0;
  let previousObservedAt = '';
  for (const item of value) {
    const preflight = record(item);
    if (
      !preflight ||
      !exactKeys(preflight, [
        'attemptNumber',
        'failureClass',
        'observedAt',
        'provider',
        'providerAuthorizationPreflightRef',
        'status',
      ])
    ) {
      return false;
    }
    const attemptNumber = count(preflight.attemptNumber);
    const attempt = attemptNumber == null ? null : attempts.get(attemptNumber);
    const observedAt = iso(preflight.observedAt);
    const claimedAt = iso(attempt?.claimedAt);
    const runtimeInvokedAt = attempt?.runtimeInvokedAt == null ? '' : iso(attempt.runtimeInvokedAt);
    const endedAt = attempt?.endedAt == null ? '' : iso(attempt.endedAt);
    const status = String(preflight.status || '');
    const failureClass = preflight.failureClass;
    const authorized = status === 'authorized';
    const provider = String(preflight.provider || '');
    const preflightKey = `${attemptNumber}:${provider}`;
    if (
      attemptNumber == null ||
      attemptNumber < previousAttemptNumber ||
      !attempt ||
      !observedAt ||
      (previousObservedAt && observedAt < previousObservedAt) ||
      !claimedAt ||
      observedAt < claimedAt ||
      (runtimeInvokedAt && observedAt > runtimeInvokedAt) ||
      (!runtimeInvokedAt && endedAt && observedAt > endedAt) ||
      !['authorized', 'needs_input', 'retryable_failure', 'rejected'].includes(status) ||
      !['openai', 'anthropic'].includes(provider) ||
      seenPreflights.has(preflightKey) ||
      typeof preflight.providerAuthorizationPreflightRef !== 'string' ||
      !PROVIDER_AUTHORIZATION_PREFLIGHT_REF.test(preflight.providerAuthorizationPreflightRef) ||
      (authorized
        ? failureClass !== null
        : typeof failureClass !== 'string' || !publicLabel(failureClass, 128))
    ) {
      return false;
    }
    seenPreflights.add(preflightKey);
    if (authorized) authorizedAttempts.add(attemptNumber);
    previousAttemptNumber = attemptNumber;
    previousObservedAt = observedAt;
  }
  return [...runtimeInvocations.keys()].every((attemptNumber) =>
    authorizedAttempts.has(attemptNumber),
  );
}

export function fingerprintGlassHiveRunRef(runRef: string): string {
  return `run_sha256:${createHash('sha256').update(runRef).digest('hex')}`;
}

export function projectGlassHiveArtifactRefs(
  value: unknown,
): Readonly<GlassHiveArtifactRefs> | null {
  const artifacts = record(value);
  if (
    !artifacts ||
    !exactKeys(artifacts, ['available', 'refs', 'overflowCount']) ||
    typeof artifacts.available !== 'boolean' ||
    artifacts.overflowCount !== 0 ||
    !Array.isArray(artifacts.refs) ||
    artifacts.refs.length > 100
  )
    return null;
  if (!artifacts.available && artifacts.refs.length > 0) return null;
  const valid = artifacts.refs.every((item) => {
    const artifact = record(item);
    if (
      !artifact ||
      !exactKeys(artifact, ['artifactRef', 'fingerprint', 'kind', 'state', 'sizeBytes'])
    ) {
      return false;
    }
    const artifactMatch =
      typeof artifact.artifactRef === 'string' ? ARTIFACT_REF.exec(artifact.artifactRef) : null;
    const fingerprintMatch =
      typeof artifact.fingerprint === 'string' ? FINGERPRINT.exec(artifact.fingerprint) : null;
    return Boolean(
      artifactMatch &&
      fingerprintMatch &&
      artifactMatch[1] === fingerprintMatch[1] &&
      typeof artifact.kind === 'string' &&
      ARTIFACT_KINDS.has(artifact.kind) &&
      typeof artifact.state === 'string' &&
      ARTIFACT_STATES.has(artifact.state) &&
      (artifact.sizeBytes == null || count(artifact.sizeBytes) != null),
    );
  });
  if (!valid) return null;
  return Object.freeze({
    available: artifacts.available,
    refs: Object.freeze(
      artifacts.refs.map((item) => {
        const artifact = item as Record<string, unknown>;
        return Object.freeze({
          artifactRef: String(artifact.artifactRef),
          fingerprint: String(artifact.fingerprint),
          kind: String(artifact.kind),
          state: String(artifact.state),
          sizeBytes: artifact.sizeBytes == null ? null : Number(artifact.sizeBytes),
        });
      }),
    ),
    overflowCount: 0 as const,
  });
}

function strictAttemptHistory(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return false;
  let previousAttemptNumber = 0;
  for (const item of value) {
    const attempt = record(item);
    if (!attempt || !exactKeys(attempt, ATTEMPT_KEYS)) {
      return false;
    }
    const attemptNumber = count(attempt.attemptNumber);
    const claimedAt = iso(attempt.claimedAt);
    const admittedAt = attempt.admittedAt == null ? '' : iso(attempt.admittedAt);
    const runtimeInvokedAt = attempt.runtimeInvokedAt == null ? '' : iso(attempt.runtimeInvokedAt);
    const endedAt = iso(attempt.endedAt);
    const providerFailedAt =
      attempt.providerHealthObservedLastFailedAt == null
        ? ''
        : iso(attempt.providerHealthObservedLastFailedAt);
    const providerGeneration =
      attempt.providerHealthObservedGeneration == null
        ? null
        : count(attempt.providerHealthObservedGeneration);
    const providerHealthValid =
      (attempt.providerHealthObservedLastFailedAt === null &&
        attempt.providerHealthObservedGeneration === null) ||
      (attempt.providerHealthObservedLastFailedAt === null && providerGeneration === 0) ||
      (Boolean(providerFailedAt) && providerGeneration != null && providerGeneration > 0);
    if (
      attemptNumber == null ||
      attemptNumber <= previousAttemptNumber ||
      typeof attempt.state !== 'string' ||
      !ATTEMPT_STATES.has(attempt.state) ||
      !claimedAt ||
      !endedAt ||
      endedAt < claimedAt ||
      (attempt.admittedAt != null && !admittedAt) ||
      (attempt.runtimeInvokedAt != null && !runtimeInvokedAt) ||
      (admittedAt && admittedAt < claimedAt) ||
      (runtimeInvokedAt && (!admittedAt || runtimeInvokedAt < admittedAt)) ||
      (runtimeInvokedAt && endedAt < runtimeInvokedAt) ||
      (admittedAt && endedAt < admittedAt) ||
      !providerHealthValid ||
      !(
        attempt.terminalReason == null ||
        (typeof attempt.terminalReason === 'string' &&
          attempt.terminalReason.length > 0 &&
          attempt.terminalReason.length <= 160)
      )
    ) {
      return false;
    }
    previousAttemptNumber = attemptNumber;
  }
  return true;
}

function strictCapacityHistory(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return false;
  let previousSequence = 0;
  let previousObservedAt = '';
  for (const item of value) {
    const attempt = record(item);
    if (
      !attempt ||
      !exactKeys(attempt, [
        'sequence',
        'class',
        'available',
        'required',
        'shortage',
        'reservation',
        'nextRetryAt',
        'observedAt',
      ])
    )
      return false;
    if (
      count(attempt.sequence) == null ||
      Number(attempt.sequence) <= previousSequence ||
      typeof attempt.class !== 'string' ||
      !attempt.class.trim() ||
      attempt.class.length > 160
    ) {
      return false;
    }
    for (const key of ['available', 'required', 'shortage', 'reservation']) {
      const vector = record(attempt[key]);
      if (
        !vector ||
        !exactKeys(vector, ['childProcesses', 'threads', 'memoryBytes', 'diskBytes'])
      ) {
        return false;
      }
      if (Object.values(vector).some((entry) => count(entry) == null)) return false;
    }
    const observedAt = iso(attempt.observedAt);
    if (
      !observedAt ||
      (previousObservedAt && observedAt < previousObservedAt) ||
      (attempt.nextRetryAt != null && !iso(attempt.nextRetryAt))
    ) {
      return false;
    }
    previousSequence = Number(attempt.sequence);
    previousObservedAt = observedAt;
  }
  return true;
}

function strictArtifactHistory(
  value: unknown,
  current: Readonly<GlassHiveArtifactRefs>,
  terminalAt: string,
): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return false;
  let previousObservedAt = '';
  let latest: Readonly<GlassHiveArtifactRefs> | null = null;
  for (const item of value) {
    const observation = record(item);
    if (!observation || !exactKeys(observation, ['artifactRefs', 'observedAt'])) return false;
    const observedAt = iso(observation.observedAt);
    latest = projectGlassHiveArtifactRefs(observation.artifactRefs);
    if (!latest || !observedAt || (previousObservedAt && observedAt < previousObservedAt)) {
      return false;
    }
    previousObservedAt = observedAt;
  }
  return previousObservedAt >= terminalAt && stableStringify(latest) === stableStringify(current);
}

function strictHistoryPage(detail: Record<string, unknown>): boolean {
  const page = record(detail.historyPage);
  const historyRows = [
    detail.attemptHistory,
    detail.capacityAttempts,
    detail.callbackDeliveries,
    detail.artifactHistory,
  ];
  const overflowCounts = [
    detail.attemptHistoryOverflowCount,
    detail.capacityAttemptOverflowCount,
    detail.callbackDeliveryOverflowCount,
    detail.artifactHistoryOverflowCount,
  ];
  const showing = historyRows.reduce<number>(
    (total, rows) => total + (Array.isArray(rows) ? rows.length : 0),
    0,
  );
  const overflow = overflowCounts.reduce<number>(
    (total, value) => total + (count(value) ?? 0),
    0,
  );
  const cursorValid = (value: unknown) =>
    value === null ||
    (typeof value === 'string' &&
      /^history_[0-9a-f]{64}_[0-9a-f]{1,8}_[0-9a-f]{64}_[0-9a-f]{1,8}(?:_[0-9a-f]{1,8}){4}$/.test(
        value,
      ));
  return Boolean(
    page &&
    exactKeys(page, ['cursor', 'nextCursor', 'limit', 'total', 'showing', 'overflowCount']) &&
    cursorValid(page.cursor) &&
    cursorValid(page.nextCursor) &&
    count(page.limit) != null &&
    Number(page.limit) >= 1 &&
    Number(page.limit) <= 50 &&
    page.showing === showing &&
    page.overflowCount === overflow &&
    page.total === showing + overflow,
  );
}

function contractEvents(input: {
  workRef: string;
  runRef: string;
  originRef?: string;
  detail: unknown;
}): {
  events: TraceProjection[];
  errors: string[];
} {
  const errors: string[] = [];
  const detail = record(input.detail);
  if (!detail || detail.workRef !== input.workRef || !WORK_REF.test(input.workRef)) {
    return { events: [], errors: ['work_identity_invalid'] };
  }
  if (
    Object.keys(detail).some((key) => !DETAIL_KEYS.has(key)) ||
    REQUIRED_COMPLETED_DETAIL_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(detail, key))
  ) {
    errors.push('detail_contract_invalid');
  }
  if (!strictHistoryPage(detail)) errors.push('history_page_invalid');
  const resourceReservation = record(detail.resourceReservation);
  if (
    !['standard', 'light'].includes(String(detail.resourceClass || '')) ||
    !resourceReservation ||
    !exactKeys(resourceReservation, ['memoryBytes']) ||
    count(resourceReservation.memoryBytes) == null ||
    Number(resourceReservation.memoryBytes) <= 0
  ) {
    errors.push('resource_contract_invalid');
  }
  if (
    !WORK_REF.test(input.runRef) ||
    typeof detail.runRef !== 'string' ||
    !RUN_REF.test(detail.runRef) ||
    detail.runRef !== fingerprintGlassHiveRunRef(input.runRef)
  ) {
    errors.push('run_identity_invalid');
  }
  const lifecycle = record(detail.lifecycle);
  const attemptNumber = lifecycle?.attemptNumber == null ? null : count(lifecycle.attemptNumber);
  const queuedAt = iso(lifecycle?.queuedAt);
  const claimedAt = iso(lifecycle?.claimedAt);
  const admittedAt = iso(lifecycle?.admittedAt);
  const runtimeInvokedAt = iso(lifecycle?.runtimeInvokedAt);
  const startedAt = iso(lifecycle?.startedAt);
  const endedAt = iso(lifecycle?.endedAt);
  const preRuntimeTerminal =
    attemptNumber === null &&
    ['failed', 'cancelled'].includes(String(detail.state || '')) &&
    lifecycle?.claimedAt === null &&
    lifecycle?.admittedAt === null &&
    lifecycle?.runtimeInvokedAt === null &&
    lifecycle?.startedAt === null;
  const attemptedLifecycleTimes = [
    queuedAt,
    claimedAt,
    admittedAt,
    runtimeInvokedAt,
    startedAt,
    endedAt,
  ];
  if (
    !lifecycle ||
    !exactKeys(lifecycle, [
      'attemptNumber',
      'queuedAt',
      'claimedAt',
      'admittedAt',
      'runtimeInvokedAt',
      'startedAt',
      'endedAt',
    ]) ||
    !queuedAt ||
    !endedAt ||
    endedAt < queuedAt ||
    (!preRuntimeTerminal &&
      (attemptNumber == null ||
        attemptedLifecycleTimes.some((value) => !value) ||
        attemptedLifecycleTimes.some(
          (value, index) => index > 0 && value < attemptedLifecycleTimes[index - 1],
        )))
  )
    errors.push('lifecycle_contract_invalid');

  if (!Array.isArray(detail.attemptHistory)) errors.push('attempt_history_missing');
  if (detail.attemptHistoryOverflowCount !== 0) errors.push('attempt_history_overflow');
  const attempts = Array.isArray(detail.attemptHistory) ? detail.attemptHistory : [];
  if (
    Array.isArray(detail.attemptHistory) &&
    (preRuntimeTerminal
      ? detail.attemptHistory.length !== 0
      : !strictAttemptHistory(detail.attemptHistory))
  ) {
    errors.push('attempt_history_invalid');
  }
  const terminalAttempt = attempts.find((item) => record(item)?.attemptNumber === attemptNumber);
  const attempt = record(terminalAttempt);
  const terminalState = typeof detail.state === 'string' ? detail.state : '';
  const terminalCallbackEvents = TERMINAL_CALLBACK_EVENTS[terminalState];
  if (
    !terminalCallbackEvents ||
    (preRuntimeTerminal
      ? attempts.length !== 0 || attempt != null
      : attempts.length === 0 ||
        attempts.length > 16 ||
        record(attempts[attempts.length - 1])?.attemptNumber !== attemptNumber ||
        !attempt ||
        !exactKeys(attempt, ATTEMPT_KEYS) ||
        attempt.state !== terminalState ||
        iso(attempt.claimedAt) !== claimedAt ||
        iso(attempt.admittedAt) !== admittedAt ||
        iso(attempt.runtimeInvokedAt) !== runtimeInvokedAt ||
        iso(attempt.endedAt) !== endedAt)
  )
    errors.push('attempt_identity_mismatch');

  if (!Array.isArray(detail.capacityAttempts)) errors.push('capacity_history_missing');
  if (detail.capacityAttemptOverflowCount !== 0) errors.push('capacity_history_overflow');
  if (Array.isArray(detail.capacityAttempts) && !strictCapacityHistory(detail.capacityAttempts)) {
    errors.push('capacity_history_invalid');
  }

  if (!Array.isArray(detail.callbackDeliveries)) errors.push('callback_history_missing');
  const callbackOverflowCount = count(detail.callbackDeliveryOverflowCount);
  if (callbackOverflowCount == null) errors.push('callback_history_overflow');
  const callbackRows = Array.isArray(detail.callbackDeliveries) ? detail.callbackDeliveries : [];
  let previousCallbackUpdatedAt = '';
  let previousCallbackEventSha256: string | null = null;
  const previousCallbackByRef = new Map<string, Record<string, unknown>>();
  const callbackRowsStructurallyValid =
    callbackRows.length > 0 &&
    callbackRows.length <= 16 &&
    callbackRows.every((item, index) => {
      const row = record(item);
      const createdAt = iso(row?.createdAt);
      const updatedAt = iso(row?.updatedAt);
      const acceptedAt = row?.acceptedAt == null ? '' : iso(row.acceptedAt);
      const deliveryAttempts = count(row?.attempts);
      const callbackAttemptNumber = row?.attemptNumber === null ? null : count(row?.attemptNumber);
      const callbackRevision = count(row?.callbackRevision);
      const ledgerSequence = count(row?.ledgerSequence);
      const resultRevision = count(row?.resultRevision);
      const deliveryGeneration = count(row?.deliveryGeneration);
      const callbackRef = typeof row?.callbackRef === 'string' ? row.callbackRef : '';
      const previousForCallback = previousCallbackByRef.get(callbackRef);
      const previousRevision = count(previousForCallback?.callbackRevision);
      const previousStatus = String(previousForCallback?.status || '');
      const callbackAttemptValid =
        (row?.attemptNumber === null &&
          (PRE_ATTEMPT_CALLBACK_EVENTS.has(String(row?.event)) ||
            (preRuntimeTerminal && terminalCallbackEvents?.has(String(row?.event))))) ||
        (callbackAttemptNumber != null && callbackAttemptNumber > 0);
      const linkedRevisionValid = previousForCallback
        ? callbackRevision === Number(previousRevision) + 1 &&
          row?.event === previousForCallback.event &&
          row?.attemptNumber === previousForCallback.attemptNumber &&
          row?.createdAt === previousForCallback.createdAt &&
          row?.payloadSha256 === previousForCallback.payloadSha256 &&
          row?.resultRevision === previousForCallback.resultRevision &&
          row?.resultDigest === previousForCallback.resultDigest &&
          Boolean(CALLBACK_STATUS_TRANSITIONS[previousStatus]?.has(String(row?.status)))
        : callbackRevision != null &&
          callbackRevision > 0 &&
          (callbackOverflowCount !== 0 || callbackRevision === 1);
      const supersededValid =
        row?.status !== 'superseded' ||
        (Boolean(terminalCallbackEvents?.has(String(row.event))) &&
          callbackAttemptNumber === attemptNumber &&
          row.acceptedAt === null &&
          createdAt > endedAt);
      const valid = Boolean(
        row &&
        exactKeys(row, CALLBACK_KEYS) &&
        CALLBACK_REF.test(callbackRef) &&
        callbackRevision != null &&
        callbackRevision > 0 &&
        ledgerSequence === Number(callbackOverflowCount || 0) + index + 1 &&
        (index === 0
          ? callbackOverflowCount === 0
            ? row.previousEventSha256 === null
            : typeof row.previousEventSha256 === 'string' &&
              FINGERPRINT.test(row.previousEventSha256)
          : row.previousEventSha256 === previousCallbackEventSha256) &&
        typeof row.eventSha256 === 'string' &&
        FINGERPRINT.test(row.eventSha256) &&
        typeof row.payloadSha256 === 'string' &&
        FINGERPRINT.test(row.payloadSha256) &&
        typeof row.authoritySha256 === 'string' &&
        FINGERPRINT.test(row.authoritySha256) &&
        resultRevision != null &&
        (row.resultDigest === null ||
          (typeof row.resultDigest === 'string' && FINGERPRINT.test(row.resultDigest))) &&
        deliveryGeneration != null &&
        linkedRevisionValid &&
        callbackAttemptValid &&
        typeof row.event === 'string' &&
        CALLBACK_EVENTS.has(row.event) &&
        typeof row.status === 'string' &&
        CALLBACK_STATUSES.has(row.status) &&
        supersededValid &&
        deliveryAttempts != null &&
        createdAt &&
        updatedAt &&
        updatedAt >= createdAt &&
        (!previousCallbackUpdatedAt || updatedAt >= previousCallbackUpdatedAt) &&
        (row.acceptedAt == null ||
          (acceptedAt && acceptedAt >= createdAt && acceptedAt <= updatedAt)) &&
        (!['http_accepted', 'accepted', 'delivered'].includes(String(row.status)) ||
          (acceptedAt && Number(deliveryAttempts) > 0)),
      );
      if (valid && row) {
        previousCallbackUpdatedAt = updatedAt;
        previousCallbackEventSha256 = String(row.eventSha256);
        previousCallbackByRef.set(callbackRef, row);
      }
      return valid;
    });
  const latestCallbackRows = [...previousCallbackByRef.values()];
  const terminalCallbacks = latestCallbackRows.filter(
    (row) =>
      Boolean(terminalCallbackEvents?.has(String(row?.event))) &&
      ['delivering', 'http_accepted', 'accepted', 'delivered'].includes(String(row.status)) &&
      row.attemptNumber === attemptNumber,
  );
  const currentTerminalCallback = terminalCallbacks.length === 1 ? terminalCallbacks[0] : null;
  const currentTerminalCallbackAt = iso(currentTerminalCallback?.createdAt);
  const supersededChronologyValid = callbackRows
    .map(record)
    .filter((row) => row?.status === 'superseded')
    .every((row) => {
      const supersededUpdatedAt = iso(row?.updatedAt);
      return Boolean(
        currentTerminalCallbackAt &&
        supersededUpdatedAt &&
        supersededUpdatedAt <= currentTerminalCallbackAt,
      );
    });
  const callbacksValid = callbackRowsStructurallyValid && supersededChronologyValid;
  if (Array.isArray(detail.callbackDeliveries) && !callbacksValid) {
    errors.push('callback_history_invalid');
  }
  const callback = callbacksValid ? currentTerminalCallback : null;
  const callbackAt = iso(callback?.createdAt);
  const deliveryAt = iso(callback?.acceptedAt);
  const callbackInFlight = callback?.status === 'delivering';
  if (
    !callback ||
    !callbackAt ||
    callbackAt <= endedAt ||
    (callbackInFlight ? callback?.acceptedAt != null : !deliveryAt || deliveryAt <= callbackAt)
  )
    errors.push('terminal_callback_invalid');

  const traceability = record(detail.traceability);
  const traceContractVersion = traceability?.contractVersion === 2 ? 2 : 1;
  const traceabilityContractValid =
    traceContractVersion === 2
      ? exactKeys(traceability, [
          'contractVersion',
          'origin',
          'promptLayers',
          'runtimeInvocations',
          'providerAuthorizationPreflights',
          'integrity',
        ])
      : exactKeys(traceability, ['origin', 'promptLayers', 'providerAttempts', 'integrity']);
  if (!traceability || !traceabilityContractValid) {
    errors.push('traceability_contract_invalid');
  }
  if (traceability && !strictOrigin(traceability.origin)) {
    errors.push('origin_contract_invalid');
  }
  const producerOrigin = record(traceability?.origin);
  if (
    input.originRef &&
    producerOrigin?.originRef !==
      `origin_sha256:${createHash('sha256').update(input.originRef).digest('hex')}`
  ) {
    errors.push('origin_identity_mismatch');
  }
  if (traceability && !strictPrompt(traceability.promptLayers)) {
    errors.push('prompt_producer_scope_invalid');
  }
  if (traceability && traceContractVersion === 2) {
    const runtimeInvocations = strictRuntimeInvocations(traceability.runtimeInvocations, attempts);
    if (!runtimeInvocations) {
      errors.push('runtime_invocations_invalid');
    } else if (
      !strictProviderAuthorizationPreflights(
        traceability.providerAuthorizationPreflights,
        attempts,
        runtimeInvocations,
      )
    ) {
      errors.push('provider_authorization_preflights_invalid');
    }
  } else if (traceability && !strictProviderAttempts(traceability.providerAttempts, attempts)) {
    errors.push('provider_attempts_invalid');
  }
  if (traceability && !strictTraceIntegrity(traceability.integrity)) {
    errors.push('trace_integrity_invalid');
  }
  const artifactRefs = projectGlassHiveArtifactRefs(detail.artifactRefs);
  if (!artifactRefs) errors.push('artifact_contract_invalid');
  if (!Array.isArray(detail.artifactHistory)) errors.push('artifact_history_missing');
  if (detail.artifactHistoryOverflowCount !== 0) errors.push('artifact_history_overflow');
  if (
    Array.isArray(detail.artifactHistory) &&
    artifactRefs &&
    !strictArtifactHistory(detail.artifactHistory, artifactRefs, endedAt)
  ) {
    errors.push('artifact_history_invalid');
  }
  if (
    errors.length > 0 ||
    (!preRuntimeTerminal && attemptNumber == null) ||
    !callback ||
    !artifactRefs
  ) {
    return { events: [], errors: [...new Set(errors)] };
  }

  const common = {
    workRef: input.workRef,
    runRef: input.runRef,
    ...(attemptNumber == null ? {} : { attemptNumber }),
    producerTraceContractVersion: traceContractVersion,
    ...producerFactFingerprints(detail, artifactRefs),
  };
  const detailEventPrefix = `glasshive.detail.v${traceContractVersion}`;
  const attemptKey = attemptNumber == null ? 'pre-runtime' : String(attemptNumber);
  const lifecycleEvents: TraceProjection[] = preRuntimeTerminal
    ? [
        {
          eventKey: `${detailEventPrefix}:work.queued:${input.runRef}:${attemptKey}`,
          stage: 'work.queued',
          at: queuedAt,
          facts: common,
        },
      ]
    : (
        [
          ['work.queued', queuedAt],
          ['work.claimed', claimedAt],
          ['work.admitted', admittedAt],
          ['runtime.invoked', runtimeInvokedAt],
          ['work.running', startedAt],
        ] as Array<[TraceStage, string]>
      ).map(([stage, at]) => ({
        eventKey: `${detailEventPrefix}:${stage}:${input.runRef}:${attemptKey}`,
        stage,
        at,
        facts: common,
      }));
  const events: TraceProjection[] = [
    {
      eventKey: `${detailEventPrefix}:prompt:${input.runRef}:${attemptKey}`,
      stage: 'prompt.layers.verified',
      at: queuedAt,
      facts: {
        ...common,
        promptLayerContractVersion: 1,
        promptProducerScope: GLASSHIVE_WORKER_PROMPT_PRODUCER_SCOPE,
        unknownPromptLayerCount: 0,
      },
    },
    ...lifecycleEvents,
    {
      eventKey: `${detailEventPrefix}:attempt-history:${input.runRef}:${attemptKey}`,
      stage: 'attempt.history.complete',
      at: endedAt,
      facts: common,
    },
    {
      eventKey: `${detailEventPrefix}:capacity-history:${input.runRef}:${attemptKey}`,
      stage: 'capacity.history.complete',
      at: endedAt,
      facts: common,
    },
    {
      eventKey: `${detailEventPrefix}:${terminalState}:${input.runRef}:${attemptKey}`,
      stage: `work.${terminalState}` as TraceStage,
      at: endedAt,
      facts: { ...common, state: terminalState, terminal: true },
    },
    {
      eventKey: `${detailEventPrefix}:callback-history:${input.runRef}:${attemptKey}`,
      stage: 'callback.history.complete',
      at: callbackAt,
      facts: {
        ...common,
        callbackRef: String(callback.callbackRef),
        callbackEvent: String(callback.event),
      },
    },
  ];
  return { events, errors: [] };
}

export function validateGlassHiveWorkDetailTrace(input: {
  workRef: string;
  runRef: string;
  detail: unknown;
}): ReadonlyArray<string> {
  return Object.freeze(contractEvents(input).errors);
}

export function projectGlassHiveProducerFactFingerprints(input: {
  workRef: string;
  runRef: string;
  detail: unknown;
}): Readonly<GlassHiveProducerFactFingerprints> | null {
  const projected = contractEvents(input);
  const facts = projected.events[0]?.facts;
  if (projected.errors.length > 0 || !facts) return null;
  const fingerprints: GlassHiveProducerFactFingerprints = {
    producerLifecycleHash: String(facts.producerLifecycleHash || ''),
    producerAttemptHistoryHash: String(facts.producerAttemptHistoryHash || ''),
    producerCapacityHistoryHash: String(facts.producerCapacityHistoryHash || ''),
    producerCallbackHistoryHash: String(facts.producerCallbackHistoryHash || ''),
    producerPromptHash: String(facts.producerPromptHash || ''),
    producerArtifactRefsHash: String(facts.producerArtifactRefsHash || ''),
  };
  return Object.freeze(fingerprints);
}

export async function ingestGlassHiveWorkDetailTrace(input: {
  store: OrchestrationTraceLedgerStore;
  ownerId: string;
  originRef: string;
  workRef: string;
  runRef: string;
  detail: unknown;
}): Promise<GlassHiveTraceIngestionResult> {
  const projected = contractEvents(input);
  if (projected.errors.length > 0) {
    return Object.freeze({
      accepted: false,
      errors: Object.freeze(projected.errors),
      eventCount: 0,
    });
  }
  try {
    for (const event of projected.events) {
      await appendOrchestrationTraceEvent({
        store: input.store,
        ownerId: input.ownerId,
        originRef: input.originRef,
        ...event,
      });
    }
  } catch (error) {
    if (error instanceof OrchestrationTraceConflictError) {
      return Object.freeze({
        accepted: false,
        errors: Object.freeze(['producer_facts_conflict']),
        eventCount: 0,
      });
    }
    throw error;
  }
  return Object.freeze({
    accepted: true,
    errors: Object.freeze([]),
    eventCount: projected.events.length,
  });
}
