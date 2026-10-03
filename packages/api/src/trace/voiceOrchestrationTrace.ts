/* === VIVENTIUM START ===
 * Feature: MPV-054 production Voice trace producer.
 * Purpose: Append owner/call/turn/candidate-bound typed facts without persisting transcript text,
 * provider payloads, prompts, host paths, or raw errors.
 * === VIVENTIUM END === */

import crypto from 'node:crypto';
import { safeErrorCode } from '../logging/safeError';
import { getTrustedInteractionContext } from '../agents/interactionContext';
import { fingerprintTraceReference, redactOrchestrationTraceFacts } from './orchestrationTraceLedger';

type UnknownRecord = Record<string, unknown>;

interface LoggerAdapter {
  warn(message: string, fields: UnknownRecord): void;
}

export interface VoiceOrchestrationTraceDependencies {
  logger: LoggerAdapter;
  recordOrchestrationTraceEvent(input: UnknownRecord): Promise<unknown>;
  orchestrationRuntimeTraceBinding(): unknown;
  logLocalTrace?(event: UnknownRecord): void;
}

export function writeBoundedVoiceTraceLog(logger: LoggerAdapter, event: UnknownRecord) {
  const serialized = JSON.stringify(event);
  const id = crypto.randomBytes(4).toString('hex');
  const parts = Math.ceil(serialized.length / 32);
  for (let index = 0; index < parts; index++) {
    logger.warn(`[VIVENTIUM][voice-trace] ${JSON.stringify({
      i: id, p: index + 1, n: parts, s: serialized.slice(index * 32, (index + 1) * 32),
    })}`, {});
  }
}

const HASH = /^sha256:[a-f0-9]{64}$/;
export const VOICE_TRACE_STAGE_PLANES = Object.freeze({
  'action.accepted': 'control',
  'control.completed': 'control',
  'tool.completed': 'tool',
  'controller.completed': 'controller',
  'cortex.completed': 'cortex',
  'cortex.activation.completed': 'cortex',
  'live_memory.completed': 'liveMemory',
  'recall.completed': 'recall',
  'title_model.completed': 'titleModel',
  'response.completed': 'response',
  'tts.completed': 'tts',
  'audio.completed': 'audio',
  'audio.failed': 'audio',
  'audio.interrupted': 'audio',
  'audio.superseded': 'audio',
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
  let runtimeBindingWarningEmitted = false;
  function currentVoiceOrchestrationTraceBinding() {
    const runtimeBinding = deps.orchestrationRuntimeTraceBinding();
    if (!exactRuntimeBinding(runtimeBinding)) {
      throw Object.assign(new Error('voice_trace_runtime_binding_unavailable'), {
        code: 'voice_trace_runtime_binding_unavailable',
      });
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
            : stage === 'audio.failed' ? 'failed'
              : stage === 'audio.interrupted' || stage === 'audio.superseded' ? 'skipped'
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
      const code = safeErrorCode(error, 'trace_unavailable');
      const stage = String(input.stage || '').trim();
      // The ledger's identity gate still applies. Local diagnostics use its same positive
      // fact contract and domain hashes, but never claim a release-bound durable event.
      try {
        const owner = requiredTraceText(input.ownerId, 'voice_trace_owner_required');
        const call = requiredTraceText(input.callSessionId, 'voice_trace_call_session_required');
        const turn = requiredTraceText(input.turnId, 'voice_trace_turn_required');
        const event = requiredTraceText(input.eventRef, 'voice_trace_event_required');
        const effectPlane = VOICE_TRACE_STAGE_PLANES[stage as keyof typeof VOICE_TRACE_STAGE_PLANES];
        if (!effectPlane) throw new Error('voice_trace_stage_invalid');
        const facts = normalizedVoiceTraceFacts(stage, isRecord(input.facts) ? input.facts : {});
        if (Object.keys(facts).some((key) => RESERVED_FACTS.has(key))) {
          throw new Error('voice_trace_reserved_fact');
        }
        const redacted = redactOrchestrationTraceFacts({ ...facts, effectPlane,
          sourceEventRef: event, callSessionRef: call, logicalTurnRef: turn });
        deps.logLocalTrace?.({ stage, durableTrace: 'unavailable', code,
          ownerScopeHash: fingerprintTraceReference('owner', owner), ...redacted });
      } catch {
        // Invalid facts cannot enter either the durable store or the diagnostic log.
      }
      if (code !== 'voice_trace_runtime_binding_unavailable' || !runtimeBindingWarningEmitted) {
        deps.logger.warn(`[VIVENTIUM][voice-trace] unavailable ${JSON.stringify({
          stage: VOICE_TRACE_STAGE_PLANES[stage as keyof typeof VOICE_TRACE_STAGE_PLANES] ? stage : 'invalid',
          code,
        })}`, {});
        if (code === 'voice_trace_runtime_binding_unavailable') runtimeBindingWarningEmitted = true;
      }
      return null;
    }
  }

  async function recordVoiceRequestTrace(
    request: UnknownRecord,
    input: { eventRef: string; stage: string; facts?: UnknownRecord },
  ) {
    const interaction = getTrustedInteractionContext(request);
    const body = isRecord(request.body) ? request.body : {};
    const user = isRecord(request.user) ? request.user : {};
    if (interaction?.surface !== 'voice' || body.voiceMode !== true ||
        !interaction.logical_turn_id || !body.viventiumCallSessionId || !(user.id || user._id)) {
      return null;
    }
    return recordVoiceOrchestrationTraceBestEffort({
      ...input,
      ownerId: user.id || user._id,
      callSessionId: body.viventiumCallSessionId,
      turnId: interaction.logical_turn_id,
    });
  }

  return {
    VOICE_TRACE_STAGE_PLANES,
    currentVoiceOrchestrationTraceBinding,
    recordVoiceOrchestrationTrace,
    recordVoiceOrchestrationTraceBestEffort,
    recordVoiceRequestTrace,
  };
}
