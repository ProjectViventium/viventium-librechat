/* === VIVENTIUM START === Durable Cortex insight delivery ledger types. === VIVENTIUM END === */

import type { IViventiumCortexFeelingSnapshot } from './cortexFeelingSnapshot';

export const CORTEX_INSIGHT_DROP_REASONS = [
  'semantic_suppression',
  'conversation_moved_on',
  'voice_task_suppressed',
  'unsupported_surface',
  'delivery_attempts_exhausted',
  'delivery_outcome_unknown',
] as const;

export const CORTEX_INSIGHT_FAILURE_REASONS = [
  'durable_surface_persistence_failed',
  'generation_failed_without_fallback',
  'presentation_failed',
  'delivery_lease_expired',
  'delivery_runtime_restarted',
  'batch_transition_conflict',
] as const;

export const CORTEX_INSIGHT_RECOVERY_DEFERRAL_REASONS = [
  'recovery_claim_failed',
  'recovery_claim_conflict',
  'parent_state_unavailable',
  'parent_generation_active',
] as const;

export type CortexInsightDeliveryStatus = 'pending' | 'claimed' | 'sent' | 'dropped';
export type CortexInsightPersistenceStatus = 'pending' | 'persisted';
export type CortexInsightDeliveryEventTransition =
  | 'pending'
  | 'claimed'
  | 'failure'
  | 'recovery_deferred'
  | 'persisted'
  | 'presented'
  | 'sent'
  | 'dropped';

export interface ICortexInsightDeliveryEvent {
  transition: CortexInsightDeliveryEventTransition;
  attemptNumber: number;
  claimToken: string;
  claimGeneration: number;
  eventAt: Date;
  claimedAt: Date | null;
  leaseExpiresAt: Date | null;
  reason: string;
  surface: string;
  receiptHash: string;
  runtimeSlot: string;
  runtimeEpoch: string;
  recoveryAttemptNumber: number;
  retryEligibleAt: Date | null;
}

export interface IViventiumCortexInsightDelivery {
  deliveryKey: string;
  deliveryId: string;
  userId: string;
  conversationId: string;
  parentMessageId: string;
  cortexId: string;
  cortexName: string;
  insight: string;
  insightHash: string;
  graphResultHash: string;
  surface: string;
  requiredSurfaces: string[];
  presentedSurfaces: string[];
  presentationReceiptHashes: string[];
  streamId: string;
  feelingSnapshot: IViventiumCortexFeelingSnapshot | null;
  acceptanceToken: string;
  sourceRevision?: number;
  presentationRevision: number;
  messageRevision: number;
  batchId: string;
  batchSize: number;
  batchMemberHashes: string[];
  parentAdmissionKey?: string;
  status: CortexInsightDeliveryStatus;
  attemptNumber: number;
  recoveryAttemptNumber: number;
  recoveryEligibleAt: Date | null;
  claimGeneration: number;
  claimToken: string;
  claimRuntimeSlot: string;
  claimRuntimeEpoch: string;
  claimedAt: Date | null;
  leaseExpiresAt: Date | null;
  presentationLeaseToken: string;
  presentationLeaseOwnerId: string;
  presentationLeaseClaimToken: string;
  presentationLeaseGeneration: number;
  presentationLeaseExpiresAt: Date | null;
  batchLockToken: string;
  batchLockRuntimeSlot: string;
  batchLockRuntimeEpoch: string;
  batchLockExpiresAt: Date | null;
  batchLockGeneration: number;
  batchIntent: unknown;
  lastBatchIntentToken: string;
  persistedMessageId: string;
  persistenceStatus: CortexInsightPersistenceStatus;
  persistedAt: Date | null;
  sentAt: Date | null;
  dropReason: string;
  droppedAt: Date | null;
  events: ICortexInsightDeliveryEvent[];
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
