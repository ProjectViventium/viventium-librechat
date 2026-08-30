/* === VIVENTIUM START ===
 * Feature: MPV-061 production Voice trace producer.
 * Purpose: Append owner/call/turn/candidate-bound typed facts without persisting transcript text,
 * provider payloads, prompts, host paths, or raw errors.
 * === VIVENTIUM END === */

import crypto from 'node:crypto';
import { safeErrorCode } from '../logging/safeError';

type UnknownRecord = Record<string, unknown>;

interface LoggerAdapter {
  warn(message: string, fields: UnknownRecord): void;
}

export interface VoiceOrchestrationTraceDependencies {
  logger: LoggerAdapter;
  recordOrchestrationTraceEvent(input: UnknownRecord): Promise<unknown>;
  orchestrationRuntimeTraceBinding(): unknown;
}

const HASH = /^sha256:[a-f0-9]{64}$/;
export const VOICE_TRACE_STAGE_PLANES = Object.freeze({
  'action.accepted': 'control',
  'control.completed': 'control',
  'tool.completed': 'tool',
  'controller.completed': 'controller',
  'cortex.completed': 'cortex',
  'live_memory.completed': 'liveMemory',
  'recall.completed': 'recall',
  'title_model.completed': 'titleModel',
  'response.completed': 'response',
  'tts.completed': 'tts',
  'audio.completed': 'audio',
  'provider.attempt.completed': 'provider',
  'provider.fallback.completed': 'provider',
  'provider.request.forwarded': 'provider',
  'attempt.history.complete': 'provider',
});
const RESERVED_FACTS = new Set([
  'sourceEventRef',
  'callSessionRef',
  'logicalTurnRef',
  'candidateDigest',
  'installedArtifactDigest',
  'runtimeOwnerBindingHash',
  'effectPlane',
  'outcome',
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredTraceText(value: unknown, code: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 4096 || normalized.includes('\0')) {
    throw new Error(code);
  }
  return normalized;
}

function exactRuntimeBinding(value: unknown): value is {
  contractVersion: 1;
  candidateDigest: string;
  installedArtifactDigest: string;
  runtimeOwnerBindingHash: string;
} {
  return Boolean(
    isRecord(value) &&
    value.contractVersion === 1 &&
    HASH.test(String(value.candidateDigest || '')) &&
    HASH.test(String(value.installedArtifactDigest || '')) &&
    HASH.test(String(value.runtimeOwnerBindingHash || '')),
  );
}

function canonicalJson(value: unknown): string | undefined {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizedVoiceTraceFacts(stage: string, input: UnknownRecord): UnknownRecord {
  const facts = { ...input };
  if (stage !== 'attempt.history.complete') return facts;
  if (
    facts.failure !== 'provider_temporarily_unavailable' ||
    facts.preModel !== true ||
    facts.state !== 'failed' ||
    facts.providerStatus !== 'failed' ||
    facts.attemptRole !== 'primary' ||
    facts.primaryStartedCount !== 0 ||
    facts.primaryCompletedCount !== 0 ||
    facts.providerHealthMutationCount !== 0 ||
    facts.providerHealthSuppressed !== false
  ) {
    throw new Error('voice_trace_pre_model_failure_invalid');
  }
  facts.producerAttemptHistoryHash = `sha256:${crypto
    .createHash('sha256')
    .update(
      canonicalJson({
        schemaVersion: 1,
        failure: facts.failure,
        preModel: facts.preModel,
        state: facts.state,
        providerStatus: facts.providerStatus,
        attemptRole: facts.attemptRole,
        provider: facts.provider,
        model: facts.model,
        primaryStartedCount: facts.primaryStartedCount,
        primaryCompletedCount: facts.primaryCompletedCount,
        providerHealthMutationCount: facts.providerHealthMutationCount,
        providerHealthSuppressed: facts.providerHealthSuppressed,
      }) ?? '',
      'utf8',
    )
    .digest('hex')}`;
  delete facts.failure;
  delete facts.preModel;
  delete facts.primaryStartedCount;
  delete facts.primaryCompletedCount;
  delete facts.providerHealthMutationCount;
  delete facts.providerHealthSuppressed;
  return facts;
}

export function createVoiceOrchestrationTraceService(deps: VoiceOrchestrationTraceDependencies) {
  function currentVoiceOrchestrationTraceBinding() {
    const runtimeBinding = deps.orchestrationRuntimeTraceBinding();
    if (!exactRuntimeBinding(runtimeBinding)) {
      throw new Error('voice_trace_runtime_binding_unavailable');
    }
    return Object.freeze({
      contractVersion: 1,
      candidateDigest: runtimeBinding.candidateDigest,
      installedArtifactDigest: runtimeBinding.installedArtifactDigest,
      runtimeOwnerBindingHash: runtimeBinding.runtimeOwnerBindingHash,
    });
  }

  async function recordVoiceOrchestrationTrace(input: UnknownRecord = {}): Promise<unknown> {
    const ownerId = requiredTraceText(input.ownerId, 'voice_trace_owner_required');
    const callSessionId = requiredTraceText(
      input.callSessionId,
      'voice_trace_call_session_required',
    );
    const turnId = requiredTraceText(input.turnId, 'voice_trace_turn_required');
    const eventRef = requiredTraceText(input.eventRef, 'voice_trace_event_required');
    const stage = String(input.stage || '').trim();
    const effectPlane = VOICE_TRACE_STAGE_PLANES[stage as keyof typeof VOICE_TRACE_STAGE_PLANES];
    if (!effectPlane) throw new Error('voice_trace_stage_invalid');
    const suppliedFacts = isRecord(input.facts) ? input.facts : {};
    const facts = normalizedVoiceTraceFacts(stage, suppliedFacts);
    if (Object.keys(facts).some((key) => RESERVED_FACTS.has(key))) {
      throw new Error('voice_trace_reserved_fact');
    }
    const runtimeBinding = currentVoiceOrchestrationTraceBinding();
    return deps.recordOrchestrationTraceEvent({
      ownerId,
      originRef: `voice:${callSessionId}`,
      eventKey: `voice:${stage}:${callSessionId}:${turnId}:${eventRef}`,
      stage,
      ...(input.at != null ? { at: input.at } : {}),
      facts: {
        ...facts,
        sourceEventRef: eventRef,
        callSessionRef: callSessionId,
        logicalTurnRef: turnId,
        candidateDigest: runtimeBinding.candidateDigest,
        installedArtifactDigest: runtimeBinding.installedArtifactDigest,
        runtimeOwnerBindingHash: runtimeBinding.runtimeOwnerBindingHash,
        effectPlane,
        outcome:
          stage === 'action.accepted' || stage === 'provider.request.forwarded'
            ? 'accepted'
            : 'completed',
      },
    });
  }

  async function recordVoiceOrchestrationTraceBestEffort(
    input: UnknownRecord = {},
  ): Promise<unknown | null> {
    try {
      return await recordVoiceOrchestrationTrace(input);
    } catch (error) {
      deps.logger.warn('[VIVENTIUM][voice-trace] production_trace_unavailable', {
        stage: String(input.stage || '').slice(0, 80),
        code: safeErrorCode(error, 'trace_unavailable'),
      });
      return null;
    }
  }

  return {
    VOICE_TRACE_STAGE_PLANES,
    currentVoiceOrchestrationTraceBinding,
    recordVoiceOrchestrationTrace,
    recordVoiceOrchestrationTraceBestEffort,
  };
}
