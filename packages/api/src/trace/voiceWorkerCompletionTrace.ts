/* === VIVENTIUM START ===
 * Feature: Voice Worker-completion presentation contract.
 * Purpose: Bind one coalesced Main response to exact accepted Worker results without storing prompt
 * or transcript text in orchestration traces.
 * === VIVENTIUM END === */

import { createHash } from 'crypto';

const CALLBACK_REF = /^callback_sha256:[a-f0-9]{64}$/;
const RESULT_KEY = /^ghtr_[a-f0-9]{64}$/;
const OPERATION_ID = /^[a-f0-9]{32}$/;
const TERMINAL_CALLBACK_ID = /^cb_terminal_[a-f0-9]{64}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MAX_BINDINGS = 32;
const BINDING_KEYS = new Set([
  'originRef',
  'workRef',
  'workerId',
  'runId',
  'callbackRef',
  'attemptNumber',
  'resultKey',
  'acceptedOperationId',
  'terminalCallbackId',
  'resultDigest',
  'resultRevision',
  'effectGeneration',
]);
const PRESENTATION_KEYS = new Set([
  'version',
  'presentationRef',
  'callSessionId',
  'turnId',
  'revision',
  'responseMessageId',
  'responseDigest',
  'bindings',
]);

export interface VoiceWorkerCompletionBindingV1 {
  originRef: string;
  workRef: string;
  workerId: string;
  runId: string;
  callbackRef: string;
  attemptNumber: number;
  resultKey: string;
  acceptedOperationId: string;
  terminalCallbackId: string;
  resultDigest: string;
  resultRevision: number;
  effectGeneration: number;
}

export interface VoiceWorkerCompletionPresentationV1 {
  version: 1;
  presentationRef: string;
  callSessionId: string;
  turnId: string;
  revision: 1;
  responseMessageId: string;
  responseDigest: string;
  bindings: ReadonlyArray<Readonly<VoiceWorkerCompletionBindingV1>>;
}

export interface VoiceWorkerCompletionPresentationAuthority {
  ownerId: string;
  conversationId: string;
  callSessionId: string;
  responseMessageId: string;
  responseText: string;
}

export interface BuildVoiceWorkerCompletionPresentationInput extends VoiceWorkerCompletionPresentationAuthority {
  bindings: ReadonlyArray<VoiceWorkerCompletionBindingV1>;
}

function requiredText(value: string, code: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 4096 || normalized.includes('\0')) throw new Error(code);
  return normalized;
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function exactKeys(value: object, keys: Set<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function canonicalBinding(value: VoiceWorkerCompletionBindingV1): VoiceWorkerCompletionBindingV1 {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, BINDING_KEYS)
  ) {
    throw new Error('voice_worker_completion_binding_invalid');
  }
  const binding = {
    originRef: requiredText(value.originRef, 'voice_worker_completion_binding_invalid'),
    workRef: requiredText(value.workRef, 'voice_worker_completion_binding_invalid'),
    workerId: requiredText(value.workerId, 'voice_worker_completion_binding_invalid'),
    runId: requiredText(value.runId, 'voice_worker_completion_binding_invalid'),
    callbackRef: requiredText(value.callbackRef, 'voice_worker_completion_binding_invalid'),
    attemptNumber: positiveInteger(value.attemptNumber, 'voice_worker_completion_binding_invalid'),
    resultKey: requiredText(value.resultKey, 'voice_worker_completion_binding_invalid'),
    acceptedOperationId: requiredText(
      value.acceptedOperationId,
      'voice_worker_completion_binding_invalid',
    ),
    terminalCallbackId: requiredText(
      value.terminalCallbackId,
      'voice_worker_completion_binding_invalid',
    ),
    resultDigest: requiredText(value.resultDigest, 'voice_worker_completion_binding_invalid'),
    resultRevision: positiveInteger(
      value.resultRevision,
      'voice_worker_completion_binding_invalid',
    ),
    effectGeneration: positiveInteger(
      value.effectGeneration,
      'voice_worker_completion_binding_invalid',
    ),
  };
  if (
    !CALLBACK_REF.test(binding.callbackRef) ||
    !RESULT_KEY.test(binding.resultKey) ||
    !OPERATION_ID.test(binding.acceptedOperationId) ||
    !TERMINAL_CALLBACK_ID.test(binding.terminalCallbackId) ||
    !SHA256.test(binding.resultDigest)
  ) {
    throw new Error('voice_worker_completion_binding_invalid');
  }
  return binding;
}

function canonicalBindings(
  values: ReadonlyArray<VoiceWorkerCompletionBindingV1>,
): VoiceWorkerCompletionBindingV1[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_BINDINGS) {
    throw new Error('voice_worker_completion_bindings_invalid');
  }
  const bindings = values
    .map(canonicalBinding)
    .sort((left, right) =>
      [left.workRef, left.originRef, left.callbackRef]
        .join('\0')
        .localeCompare([right.workRef, right.originRef, right.callbackRef].join('\0')),
    );
  const identities = bindings.map((binding) => [
    binding.originRef,
    binding.workRef,
    binding.workerId,
    binding.runId,
    binding.callbackRef,
    binding.resultKey,
  ]);
  const unique = new Set(identities.map((identity) => JSON.stringify(identity)));
  const workRefs = new Set(bindings.map((binding) => binding.workRef));
  const resultKeys = new Set(bindings.map((binding) => binding.resultKey));
  if (
    unique.size !== bindings.length ||
    workRefs.size !== bindings.length ||
    resultKeys.size !== bindings.length
  ) {
    throw new Error('voice_worker_completion_binding_duplicate');
  }
  return bindings;
}

function presentationIdentity(
  authority: VoiceWorkerCompletionPresentationAuthority,
  responseDigest: string,
  bindings: ReadonlyArray<VoiceWorkerCompletionBindingV1>,
): string {
  return JSON.stringify({
    version: 1,
    ownerId: authority.ownerId,
    conversationId: authority.conversationId,
    callSessionId: authority.callSessionId,
    responseMessageId: authority.responseMessageId,
    responseDigest,
    bindings,
  });
}

export function buildVoiceWorkerCompletionPresentation(
  input: BuildVoiceWorkerCompletionPresentationInput,
): Readonly<VoiceWorkerCompletionPresentationV1> {
  const authority = {
    ownerId: requiredText(input.ownerId, 'voice_worker_completion_owner_required'),
    conversationId: requiredText(
      input.conversationId,
      'voice_worker_completion_conversation_required',
    ),
    callSessionId: requiredText(
      input.callSessionId,
      'voice_worker_completion_call_session_required',
    ),
    responseMessageId: requiredText(
      input.responseMessageId,
      'voice_worker_completion_response_required',
    ),
    responseText: requiredText(input.responseText, 'voice_worker_completion_response_required'),
  };
  const bindings = canonicalBindings(input.bindings);
  const responseDigest = sha256(authority.responseText);
  const identityHash = createHash('sha256')
    .update(presentationIdentity(authority, responseDigest, bindings), 'utf8')
    .digest('hex');
  return Object.freeze({
    version: 1,
    presentationRef: `voice_worker_completion_${identityHash}`,
    callSessionId: authority.callSessionId,
    turnId: `voice_worker_completion_turn_${identityHash}`,
    revision: 1,
    responseMessageId: authority.responseMessageId,
    responseDigest,
    bindings: Object.freeze(bindings.map((binding) => Object.freeze(binding))),
  });
}

export function verifyVoiceWorkerCompletionPresentation(
  value: VoiceWorkerCompletionPresentationV1 | null | undefined,
  authority: VoiceWorkerCompletionPresentationAuthority,
): boolean {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, PRESENTATION_KEYS)
  ) {
    return false;
  }
  try {
    const expected = buildVoiceWorkerCompletionPresentation({
      ...authority,
      bindings: [...value.bindings],
    });
    return JSON.stringify(value) === JSON.stringify(expected);
  } catch {
    return false;
  }
}
