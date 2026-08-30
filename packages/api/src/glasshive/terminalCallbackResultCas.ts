/* === VIVENTIUM START ===
 * Feature: GlassHive terminal-result receiver CAS contract.
 * Purpose: Validate sender identity and return the exact monotonic receipt before route effects.
 * === VIVENTIUM END === */

import crypto from 'crypto';
import {
  acquireGlassHiveTerminalCallbackEffectLease as acquireEffectLease,
  compareAndSetGlassHiveTerminalCallbackResult,
  fenceGlassHiveTerminalCallbackAcceptedOperationTransaction as fenceAcceptedOperationTransaction,
  fenceGlassHiveTerminalCallbackEffectTransaction as fenceEffectTransaction,
  releaseGlassHiveTerminalCallbackEffectLease as releaseEffectLease,
  renewGlassHiveTerminalCallbackEffectLease as renewEffectLease,
} from '@librechat/data-schemas';
import type { Model } from 'mongoose';
import type { ClientSession } from 'mongoose';
import type {
  GlassHiveTerminalCallbackEffectLease,
  GlassHiveTerminalCallbackAcceptedOperationReference,
  GlassHiveTerminalCallbackResultIdentity,
  IGlassHiveTerminalCallbackResult,
  GlassHiveTerminalCallbackResultState,
} from '@librechat/data-schemas';

const TERMINAL_STATES = new Set<GlassHiveTerminalCallbackResultState>([
  'completed',
  'failed',
  'cancelled',
]);
const CALLBACK_ID = /^cb_terminal_[a-f0-9]{64}$/;
const RESULT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const TERMINAL_STATE_BY_EVENT = new Map<string, GlassHiveTerminalCallbackResultState>([
  ['run.completed', 'completed'],
  ['run.failed', 'failed'],
  ['run.cancelled', 'cancelled'],
  ['run.interrupted', 'cancelled'],
]);

export interface GlassHiveTerminalCallbackBody {
  callback_id?: string;
  origin_ref?: string;
  work_ref?: string;
  worker_id?: string;
  run_id?: string;
  event?: string;
  work_state?: string;
  work_terminal?: boolean;
  attempt_number?: number;
  result_state?: string;
  result_ended_at?: string;
  result_revision?: number;
  result_digest?: string;
}

export interface GlassHiveTerminalCallbackHeaders {
  callbackId?: string;
  resultRevision?: string;
  resultDigest?: string;
}

export interface GlassHiveTerminalCallbackTrustedScope {
  ownerId?: string;
  originRef?: string;
  workRef?: string;
}

export interface GlassHiveTerminalCallbackReceipt {
  callback_status: 'accepted' | 'idempotent' | 'superseded' | 'conflict';
  callback_id: string;
  run_id: string;
  result_revision: number;
  result_digest: string;
  current_callback_id: string;
  current_result_revision: number;
  current_result_digest: string;
}

export interface GlassHiveTerminalCallbackEffectScope {
  incoming: GlassHiveTerminalCallbackResultIdentity;
  acceptedOperationId: string;
}

export type GlassHiveTerminalCallbackGate =
  | { applies: false }
  | { applies: true; accepted: false; httpStatus: 400 | 425; error: string }
  | {
      applies: true;
      accepted: boolean;
      httpStatus: 200 | 409;
      receipt: GlassHiveTerminalCallbackReceipt;
      effectScope?: GlassHiveTerminalCallbackEffectScope;
    };

export type GlassHiveTerminalCallbackEffectGate =
  | { acquired: true; lease: GlassHiveTerminalCallbackEffectLease }
  | { acquired: false; httpStatus: 425; error: string }
  | {
      acquired: false;
      httpStatus: 409;
      receipt: GlassHiveTerminalCallbackReceipt;
    };

function normalized(value: string | undefined, maxLength: number): string {
  return String(value || '')
    .trim()
    .slice(0, maxLength);
}

function hasTerminalResultIdentity(body: GlassHiveTerminalCallbackBody): boolean {
  return (
    normalized(body.callback_id, 512).startsWith('cb_terminal_') ||
    body.result_revision != null ||
    body.result_digest != null ||
    body.result_state != null ||
    body.result_ended_at != null
  );
}

function terminalCallbackId({
  runId,
  resultState,
  resultEndedAt,
  attemptNumber,
  resultRevision,
  resultDigest,
}: {
  runId: string;
  resultState: GlassHiveTerminalCallbackResultState;
  resultEndedAt: string;
  attemptNumber: number;
  resultRevision: number;
  resultDigest: string;
}): string {
  const material = [
    runId,
    resultState,
    resultEndedAt,
    attemptNumber,
    resultRevision,
    resultDigest,
  ].join(':');
  return `cb_terminal_${crypto.createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

function invalidGate(): GlassHiveTerminalCallbackGate {
  return {
    applies: true,
    accepted: false,
    httpStatus: 400,
    error: 'invalid_terminal_result_identity',
  };
}

export async function receiveGlassHiveTerminalCallbackResult({
  ResultModel,
  body,
  headers,
  trustedScope,
}: {
  ResultModel: Model<IGlassHiveTerminalCallbackResult>;
  body: GlassHiveTerminalCallbackBody;
  headers: GlassHiveTerminalCallbackHeaders;
  trustedScope: GlassHiveTerminalCallbackTrustedScope;
}): Promise<GlassHiveTerminalCallbackGate> {
  if (!hasTerminalResultIdentity(body)) return { applies: false };

  const callbackId = normalized(body.callback_id, 512);
  const ownerId = normalized(trustedScope.ownerId, 512);
  const trustedOriginRef = normalized(trustedScope.originRef, 160);
  const trustedWorkRef = normalized(trustedScope.workRef, 160);
  const originRef = normalized(body.origin_ref, 160);
  const workRef = normalized(body.work_ref, 160);
  const workerId = normalized(body.worker_id, 160);
  const runId = normalized(body.run_id, 160);
  const event = normalized(body.event, 64);
  const workState = normalized(body.work_state, 32);
  const resultState = normalized(body.result_state, 32) as GlassHiveTerminalCallbackResultState;
  const resultEndedAt = normalized(body.result_ended_at, 128);
  const resultRevision = body.result_revision;
  const resultDigest = normalized(body.result_digest, 80);
  const attemptValue = body.attempt_number;
  const attemptNumber = attemptValue == null ? 0 : attemptValue;
  const exactCallbackId =
    TERMINAL_STATES.has(resultState) &&
    Number.isSafeInteger(attemptNumber) &&
    attemptNumber >= 0 &&
    Number.isSafeInteger(resultRevision) &&
    Number(resultRevision) > 0 &&
    RESULT_DIGEST.test(resultDigest)
      ? terminalCallbackId({
          runId,
          resultState,
          resultEndedAt,
          attemptNumber,
          resultRevision: Number(resultRevision),
          resultDigest,
        })
      : '';
  const valid = Boolean(
    ownerId &&
    trustedOriginRef &&
    trustedWorkRef &&
    originRef === trustedOriginRef &&
    workRef === trustedWorkRef &&
    workerId &&
    runId &&
    CALLBACK_ID.test(callbackId) &&
    callbackId === exactCallbackId &&
    TERMINAL_STATE_BY_EVENT.get(event) === resultState &&
    workState === resultState &&
    body.work_terminal === true &&
    resultEndedAt &&
    Number.isFinite(Date.parse(resultEndedAt)) &&
    normalized(headers.callbackId, 512) === callbackId &&
    normalized(headers.resultRevision, 32) === String(resultRevision) &&
    normalized(headers.resultDigest, 80) === resultDigest,
  );
  if (!valid || typeof resultRevision !== 'number') return invalidGate();

  const incoming: GlassHiveTerminalCallbackResultIdentity = {
    ownerId,
    originRef,
    workRef,
    workerId,
    runId,
    callbackId,
    attemptNumber,
    resultState,
    resultEndedAt,
    resultRevision,
    resultDigest,
  };
  let decision;
  try {
    decision = await compareAndSetGlassHiveTerminalCallbackResult({ ResultModel, incoming });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'glasshive_terminal_callback_effects_in_progress'
    ) {
      return {
        applies: true,
        accepted: false,
        httpStatus: 425,
        error: 'callback_result_effects_in_progress',
      };
    }
    throw error;
  }
  const receipt: GlassHiveTerminalCallbackReceipt = {
    callback_status: decision.status,
    callback_id: callbackId,
    run_id: runId,
    result_revision: resultRevision,
    result_digest: resultDigest,
    current_callback_id: decision.current.callbackId,
    current_result_revision: decision.current.resultRevision,
    current_result_digest: decision.current.resultDigest,
  };
  const accepted = decision.status === 'accepted' || decision.status === 'idempotent';
  return {
    applies: true,
    accepted,
    httpStatus: accepted ? 200 : 409,
    receipt,
    effectScope: accepted
      ? { incoming, acceptedOperationId: decision.acceptedOperationId }
      : undefined,
  };
}

function receiptForCurrent(
  incoming: GlassHiveTerminalCallbackResultIdentity,
  status: 'superseded' | 'conflict',
  current: GlassHiveTerminalCallbackResultIdentity,
): GlassHiveTerminalCallbackReceipt {
  return {
    callback_status: status,
    callback_id: incoming.callbackId,
    run_id: incoming.runId,
    result_revision: incoming.resultRevision,
    result_digest: incoming.resultDigest,
    current_callback_id: current.callbackId,
    current_result_revision: current.resultRevision,
    current_result_digest: current.resultDigest,
  };
}

export async function acquireGlassHiveTerminalCallbackResultEffectLease({
  ResultModel,
  effectScope,
}: {
  ResultModel: Model<IGlassHiveTerminalCallbackResult>;
  effectScope: GlassHiveTerminalCallbackEffectScope;
}): Promise<GlassHiveTerminalCallbackEffectGate> {
  const decision = await acquireEffectLease({
    ResultModel,
    incoming: effectScope.incoming,
    acceptedOperationId: effectScope.acceptedOperationId,
  });
  if (decision.status === 'acquired') return { acquired: true, lease: decision.lease };
  if (decision.status === 'busy') {
    return {
      acquired: false,
      httpStatus: 425,
      error: 'callback_result_effects_in_progress',
    };
  }
  return {
    acquired: false,
    httpStatus: 409,
    receipt: receiptForCurrent(effectScope.incoming, decision.status, decision.current),
  };
}

export async function renewGlassHiveTerminalCallbackResultEffectLease({
  ResultModel,
  lease,
}: {
  ResultModel: Model<IGlassHiveTerminalCallbackResult>;
  lease: GlassHiveTerminalCallbackEffectLease;
}): Promise<boolean> {
  return renewEffectLease({ ResultModel, lease });
}

export async function fenceGlassHiveTerminalCallbackResultEffectTransaction({
  ResultModel,
  lease,
  session,
}: {
  ResultModel: Model<IGlassHiveTerminalCallbackResult>;
  lease: GlassHiveTerminalCallbackEffectLease;
  session: ClientSession;
}): Promise<boolean> {
  return fenceEffectTransaction({ ResultModel, lease, session });
}

export async function fenceGlassHiveTerminalCallbackAcceptedOperation({
  ResultModel,
  reference,
  session,
}: {
  ResultModel: Model<IGlassHiveTerminalCallbackResult>;
  reference: GlassHiveTerminalCallbackAcceptedOperationReference;
  session: ClientSession;
}): Promise<boolean> {
  return fenceAcceptedOperationTransaction({ ResultModel, reference, session });
}

export async function releaseGlassHiveTerminalCallbackResultEffectLease({
  ResultModel,
  lease,
}: {
  ResultModel: Model<IGlassHiveTerminalCallbackResult>;
  lease: GlassHiveTerminalCallbackEffectLease;
}): Promise<boolean> {
  return releaseEffectLease({ ResultModel, lease });
}
