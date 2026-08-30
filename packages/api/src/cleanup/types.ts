export type CleanupTargetKind = 'schedule' | 'conversation' | 'message' | 'memory';

export type CleanupJsonValue =
  null | boolean | number | string | CleanupJsonValue[] | { [key: string]: CleanupJsonValue };

export interface CleanupTargetRef {
  kind: CleanupTargetKind;
  resourceId: string;
}

export interface CleanupSourceState extends CleanupTargetRef {
  ownerId: string;
  revision: number;
  updatedAt: string;
  payload: CleanupJsonValue;
}

export interface CleanupTombstoneState extends CleanupTargetRef {
  ownerId: string;
  operationId: string;
  reviewBindingSha256: string;
  preimageSha256: string;
  revision: number;
  tombstonedAt: string;
}

export interface CleanupTargetBinding extends CleanupTargetRef {
  expectedRevision: number;
  expectedUpdatedAt: string;
  stateSha256: string;
  preimageSha256: string;
  reviewBindingSha256: string;
  runNonceHash: string;
}

export interface CleanupRecoveryReceipt {
  contractVersion: 1;
  backupId: string;
  ownerScopeHash: string;
  reviewSetSha256: string;
  manifestSha256: string;
  artifactSetSha256: string;
  restoreVerification: 'verified';
  status: 'verified';
  createdAt: string;
  receiptSha256: string;
}

export interface CleanupOperationRegistration {
  operationId: string;
  ownerId: string;
  ownerScopeHash: string;
  planSha256: string;
  backupReceiptSha256: string;
  reviewSetSha256: string;
  recoveryReceipt: CleanupRecoveryReceipt;
  nonceHash: string;
  targetSetSha256: string;
  notBefore: string;
  at: string;
  targets: CleanupTargetBinding[];
}

export interface CleanupBackupAuthorityPayload {
  contractVersion: 1;
  authorityId: string;
  purpose: 'reviewed_personal_account_synthetic_qa_cleanup';
  reviewedCleanupApproved: true;
  ownerScopeHash: string;
  operationId: string;
  planSha256: string;
  backupReceiptSha256: string;
  reviewSetSha256: string;
  targetSetSha256: string;
  targetBindingsSha256: string;
  nonceHash: string;
  backupId: string;
  backupCreatedAt: string;
  issuedAt: string;
  expiresAt: string;
}

export interface CleanupBackupAuthority extends CleanupBackupAuthorityPayload {
  proof: string;
}

export interface VerifiedCleanupBackupAuthority {
  verified: true;
  authorityId: string;
  authoritySha256: string;
  expiresAt: string;
}

export interface CleanupMutationRequest {
  operationId: string;
  ownerId: string;
  planSha256: string;
  backupReceiptSha256: string;
  reviewSetSha256: string;
  target: CleanupTargetBinding;
}

export interface CleanupOperationBinding {
  operationId: string;
  ownerId: string;
  planSha256: string;
  backupReceiptSha256: string;
  reviewSetSha256: string;
  ownerScopeHash: string;
  target: CleanupTargetBinding;
}

export interface CleanupTargetReceipt {
  targetKind: CleanupTargetKind;
  targetHash: string;
  revision: number;
  tombstonedAt: string;
}

export interface CleanupOperationState {
  operationId: string;
  ownerScopeHash: string;
  planSha256: string;
  backupReceiptSha256: string;
  reviewSetSha256: string;
  nonceHash: string;
  targetSetSha256: string;
  notBefore: string;
  backupVerified: boolean;
  searchReconciled: boolean;
  recallReconciled: boolean;
  sweepVerified?: boolean;
  searchReceiptSha256?: string;
  recallReceiptSha256?: string;
  targets: CleanupTargetBinding[];
  targetReceipts: CleanupTargetReceipt[];
  authorityId?: string;
  authoritySha256?: string;
  authorityExpiresAt?: string;
  executionStatus?: 'ready' | 'claimed' | 'partial' | 'completed';
}

export interface CleanupExecutionClaim {
  status: 'claimed' | 'recovered';
  leaseToken: string;
  operation: CleanupOperationState;
}

export interface CleanupExecutionRegistry {
  registerVerifiedBackupOperation(
    input: CleanupOperationRegistration & { backupAuthority: CleanupBackupAuthority },
  ): Promise<CleanupOperationState>;
  claimCleanupExecution(input: {
    ownerId: string;
    operationId: string;
    attemptId: string;
    at: string;
  }): Promise<CleanupExecutionClaim>;
  completeCleanupExecution(input: {
    ownerId: string;
    operationId: string;
    attemptId: string;
    leaseToken: string;
    at: string;
  }): Promise<CleanupOperationState>;
  failCleanupExecution(input: {
    ownerId: string;
    operationId: string;
    attemptId: string;
    leaseToken: string;
    errorCode: string;
    at: string;
  }): Promise<CleanupOperationState>;
  readCleanupOperation(ownerId: string, operationId: string): Promise<CleanupOperationState | null>;
}

export interface ApplyCleanupTombstoneInput {
  source: CleanupSourceState;
  operationId: string;
  ownerScopeHash: string;
  reviewBindingSha256: string;
  preimageSha256: string;
  runNonceHash: string;
  tombstonedAt: string;
}

export interface CleanupMutationResult {
  applied: boolean;
  revision: number;
  tombstonedAt: string;
}

export interface CleanupReceiptInput {
  operationId: string;
  ownerScopeHash: string;
  stage:
    | 'target_tombstoned'
    | 'search_reconciled'
    | 'recall_reconciled'
    | 'delayed_nonce_sweep_verified';
  at: string;
  targetKind?: CleanupTargetKind;
  targetHash?: string;
  targetSetSha256?: string;
  receiptSha256?: string;
  count?: number;
  revision?: number;
}

export interface CleanupRepository {
  assertBackupVerified(binding: CleanupOperationBinding): Promise<void>;
  readActiveTarget(
    kind: 'message' | 'conversation',
    ownerId: string,
    resourceId: string,
  ): Promise<CleanupSourceState | null>;
  readMatchingTombstone(
    kind: 'message' | 'conversation',
    ownerId: string,
    resourceId: string,
  ): Promise<CleanupTombstoneState | null>;
  countActiveConversationMessages(ownerId: string, conversationId: string): Promise<number>;
  applyTombstone(input: ApplyCleanupTombstoneInput): Promise<CleanupMutationResult>;
  listOperationTombstones(ownerId: string, operationId: string): Promise<CleanupTargetRef[]>;
  appendReceipt(input: CleanupReceiptInput): Promise<{ receiptSha256: string }>;
  getOperationState(ownerId: string, operationId: string): Promise<CleanupOperationState | null>;
  verifySourceTombstones(input: {
    ownerId: string;
    operationId: string;
    targets: CleanupTargetRef[];
    nonceHash: string;
  }): Promise<{ verifiedCount: number }>;
}

export interface CleanupLedgerAdapter {
  assertBackupVerified(binding: CleanupOperationBinding): Promise<void>;
  appendReceipt(input: CleanupReceiptInput): Promise<{ receiptSha256: string }>;
  getOperationState(ownerId: string, operationId: string): Promise<CleanupOperationState | null>;
}

export interface SearchCleanupAdapter {
  reconcileExact(input: {
    ownerId: string;
    targets: CleanupTargetRef[];
  }): Promise<{ status: 'verified' | 'failed'; targetCount: number; receiptSha256: string }>;
  verifyAbsent(input: {
    ownerId: string;
    targets: CleanupTargetRef[];
  }): Promise<{ verifiedCount: number }>;
}

export interface RecallCleanupAdapter {
  rebuildOwnerRecall(input: {
    ownerId: string;
    operationId: string;
    targetSetSha256: string;
  }): Promise<{ status: 'verified' | 'failed'; receiptSha256: string }>;
  verifyOperation(input: {
    ownerId: string;
    operationId: string;
    targetSetSha256: string;
    expectedReceiptSha256: string;
  }): Promise<{ verified: boolean }>;
}

export interface ScheduleCleanupAdapter {
  tombstoneExact(
    input: CleanupMutationRequest & { ownerScopeHash: string; tombstonedAt: string },
  ): Promise<{
    applied: boolean;
    revision: number;
    tombstonedAt: string;
    receiptSha256: string;
  }>;
  verifyOperation(input: {
    ownerId: string;
    operationId: string;
    targets: CleanupTargetRef[];
    nonceHash: string;
  }): Promise<{ verifiedCount: number }>;
}

export interface MemoryCleanupAdapter {
  readActiveTarget(ownerId: string, resourceId: string): Promise<CleanupSourceState | null>;
  readRetainedTombstone(
    ownerId: string,
    resourceId: string,
  ): Promise<{ revision: number; tombstonedAt: string } | null>;
  applyTombstone(input: ApplyCleanupTombstoneInput): Promise<CleanupMutationResult>;
  verifyOperation(input: {
    ownerId: string;
    operationId: string;
    targets: CleanupTargetRef[];
    nonceHash: string;
  }): Promise<{
    verifiedCount: number;
    tombstones: Array<{ resourceId: string; revision: number; tombstonedAt: string }>;
  }>;
}

export interface SyntheticQaResidueAdapter {
  verifyNonceAbsent(input: {
    ownerId: string;
    runNonce: string;
  }): Promise<{ verified: boolean; activeMessageCount: number }>;
}

export interface PersonalAccountCleanupDependencies {
  repository: CleanupRepository;
  search: SearchCleanupAdapter;
  recall: RecallCleanupAdapter;
  schedules: ScheduleCleanupAdapter;
  memories: MemoryCleanupAdapter;
  residue: SyntheticQaResidueAdapter;
  now?: () => Date;
}

export interface CleanupStageResult {
  status: 'tombstoned' | 'already_tombstoned' | 'verified';
  targetKind?: CleanupTargetKind;
  targetHash?: string;
  targetCount?: number;
  revision?: number;
  tombstonedAt?: string;
  receiptSha256?: string;
  verifiedTargetCount?: number;
}

export interface PersonalAccountCleanupService {
  tombstoneMessage(request: CleanupMutationRequest): Promise<CleanupStageResult>;
  tombstoneConversation(request: CleanupMutationRequest): Promise<CleanupStageResult>;
  tombstoneSchedule(request: CleanupMutationRequest): Promise<CleanupStageResult>;
  tombstoneMemory(request: CleanupMutationRequest): Promise<CleanupStageResult>;
  reconcileSearch(input: {
    operationId: string;
    ownerId: string;
    targetSetSha256: string;
  }): Promise<CleanupStageResult>;
  reconcileRecall(input: {
    operationId: string;
    ownerId: string;
    targetSetSha256: string;
  }): Promise<CleanupStageResult>;
  runDelayedNonceSweep(input: {
    operationId: string;
    ownerId: string;
    runNonce: string;
    targetSetSha256: string;
  }): Promise<CleanupStageResult>;
}
