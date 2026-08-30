/* === VIVENTIUM START === Owner-bound personal-account cleanup receipt types. === VIVENTIUM END === */

export type PersonalAccountCleanupTargetKind = 'schedule' | 'conversation' | 'message' | 'memory';

export interface IPersonalAccountCleanupTarget {
  kind: PersonalAccountCleanupTargetKind;
  resourceId: string;
  expectedRevision: number;
  expectedUpdatedAt: Date;
  stateSha256: string;
  preimageSha256: string;
  reviewBindingSha256: string;
  runNonceHash: string;
}

export interface IPersonalAccountCleanupEvent {
  sequence: number;
  stage: string;
  at: Date;
  targetKind?: PersonalAccountCleanupTargetKind;
  targetHash?: string;
  targetSetSha256?: string;
  receiptSha256?: string;
  count?: number;
  revision?: number;
  attemptIdHash?: string;
  leaseUntil?: Date;
  errorCode?: string;
  eventKeyHash: string;
  contentHash: string;
  previousEventHash: string;
  eventHash: string;
}

export type PersonalAccountCleanupExecutionStatus = 'ready' | 'claimed' | 'partial' | 'completed';

export interface IViventiumPersonalAccountCleanupReceipt {
  contractVersion: 1;
  operationId: string;
  ownerId: string;
  ownerScopeHash: string;
  planSha256: string;
  backupReceiptSha256: string;
  reviewSetSha256: string;
  nonceHash: string;
  targetSetSha256: string;
  notBefore: Date;
  authorityId: string;
  authoritySha256: string;
  authorityExpiresAt: Date;
  targets: IPersonalAccountCleanupTarget[];
  events: IPersonalAccountCleanupEvent[];
  executionStatus: PersonalAccountCleanupExecutionStatus;
  executionLeaseTokenHash?: string;
  executionLeaseUntil?: Date;
  executionAttemptIdHash?: string;
  createdAt: Date;
  updatedAt: Date;
}
