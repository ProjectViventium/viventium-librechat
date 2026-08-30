/* === VIVENTIUM START === Generation-fenced GlassHive callback effect outbox types. === VIVENTIUM END === */

export const GLASSHIVE_CALLBACK_EFFECT_OUTBOX_DESTINATIONS = ['scheduler'] as const;
export const GLASSHIVE_CALLBACK_EFFECT_OUTBOX_STATUSES = [
  'pending',
  'claimed',
  'sent',
  'failed',
  'superseded',
] as const;

export type GlassHiveCallbackEffectOutboxDestination =
  (typeof GLASSHIVE_CALLBACK_EFFECT_OUTBOX_DESTINATIONS)[number];
export type GlassHiveCallbackEffectOutboxStatus =
  (typeof GLASSHIVE_CALLBACK_EFFECT_OUTBOX_STATUSES)[number];

export interface IGlassHiveCallbackEffectSummary {
  requiredTotal: number;
  requiredTerminal: number;
  requiredFailed: number;
  allRequiredTerminal: boolean;
  state: string;
}

export interface IViventiumGlassHiveCallbackEffectOutbox {
  outboxId: string;
  destination: GlassHiveCallbackEffectOutboxDestination;
  ownerId: string;
  occurrenceKey: string;
  summary: IGlassHiveCallbackEffectSummary;
  terminalCallbackResultKey: string;
  terminalCallbackAcceptedOperationId: string;
  terminalCallbackId: string;
  terminalCallbackResultDigest: string;
  terminalCallbackResultRevision: number;
  terminalCallbackEffectGeneration: number;
  status: GlassHiveCallbackEffectOutboxStatus;
  claimId: string;
  claimExpiresAt: Date | null;
  dispatchPermitId: string;
  dispatchPermitGeneration: number;
  dispatchPermitExpiresAt: Date | null;
  attempts: number;
  nextAttemptAt: Date | null;
  sentAt: Date | null;
  lastError: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
