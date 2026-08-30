/* === VIVENTIUM START === Durable GlassHive terminal-result receiver CAS types. === VIVENTIUM END === */

export const GLASSHIVE_TERMINAL_CALLBACK_RESULT_STATES = [
  'completed',
  'failed',
  'cancelled',
] as const;

export const GLASSHIVE_TERMINAL_CALLBACK_CAS_STATUSES = [
  'accepted',
  'idempotent',
  'superseded',
  'conflict',
] as const;

export type GlassHiveTerminalCallbackResultState =
  (typeof GLASSHIVE_TERMINAL_CALLBACK_RESULT_STATES)[number];
export type GlassHiveTerminalCallbackCasStatus =
  (typeof GLASSHIVE_TERMINAL_CALLBACK_CAS_STATUSES)[number];

export interface IGlassHiveTerminalCallbackResult {
  _id: string;
  ownerId: string;
  originRef: string;
  workRef: string;
  workerId: string;
  runId: string;
  callbackId: string;
  attemptNumber: number;
  resultState: GlassHiveTerminalCallbackResultState;
  resultEndedAt: string;
  resultRevision: number;
  resultDigest: string;
  acceptedOperationId: string;
  acceptedOperationGeneration: number;
  effectLeaseId?: string;
  effectLeaseOperationId?: string;
  effectLeaseGeneration?: number;
  effectLeaseExpiresAt?: Date;
  acceptedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface GlassHiveTerminalCallbackResultIdentity {
  ownerId: string;
  originRef: string;
  workRef: string;
  workerId: string;
  runId: string;
  callbackId: string;
  attemptNumber: number;
  resultState: GlassHiveTerminalCallbackResultState;
  resultEndedAt: string;
  resultRevision: number;
  resultDigest: string;
}

export interface GlassHiveTerminalCallbackCasDecision {
  status: GlassHiveTerminalCallbackCasStatus;
  incoming: GlassHiveTerminalCallbackResultIdentity;
  current: GlassHiveTerminalCallbackResultIdentity;
  acceptedOperationId: string;
  acceptedOperationGeneration: number;
}

export interface GlassHiveTerminalCallbackEffectLease {
  resultKey: string;
  acceptedOperationId: string;
  acceptedOperationGeneration: number;
  leaseId: string;
  generation: number;
  resultRevision: number;
  callbackId: string;
  resultDigest: string;
}

export interface GlassHiveTerminalCallbackAcceptedOperationReference {
  resultKey: string;
  acceptedOperationId: string;
  resultRevision: number;
  callbackId: string;
  resultDigest: string;
  generation: number;
}

export type GlassHiveTerminalCallbackEffectLeaseDecision =
  | { status: 'acquired'; lease: GlassHiveTerminalCallbackEffectLease }
  | {
      status: 'busy' | 'superseded' | 'conflict';
      current: GlassHiveTerminalCallbackResultIdentity;
    };
