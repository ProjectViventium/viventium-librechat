import { cleanupTargetSha256, ownerScopeSha256, targetSetSha256 } from '../personalAccountCleanup';
import {
  CLEANUP_EXECUTION_CONFIRMATION,
  PersonalAccountCleanupPartialFailure,
  createPersonalAccountCleanupExecutor,
} from '../personalAccountCleanupExecutor';
import type {
  CleanupBackupAuthority,
  CleanupExecutionRegistry,
  CleanupOperationRegistration,
  CleanupOperationState,
  PersonalAccountCleanupService,
} from '../types';

const OWNER_ID = 'owner-cleanup-1';
const OPERATION_ID = 'cleanup-operation-1';
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const NOW = new Date('2026-08-25T16:00:00.000Z');

function registration(): CleanupOperationRegistration {
  const targets = [
    {
      kind: 'message' as const,
      resourceId: 'message-cleanup-1',
      expectedRevision: 4,
      expectedUpdatedAt: '2026-08-25T15:50:00.000Z',
      stateSha256: HEX_A,
      preimageSha256: HEX_A,
      reviewBindingSha256: HEX_B,
      runNonceHash: `sha256:${HEX_B}`,
    },
    {
      kind: 'conversation' as const,
      resourceId: 'conversation-cleanup-1',
      expectedRevision: 2,
      expectedUpdatedAt: '2026-08-25T15:49:00.000Z',
      stateSha256: HEX_A,
      preimageSha256: HEX_A,
      reviewBindingSha256: HEX_B,
      runNonceHash: `sha256:${HEX_B}`,
    },
  ];
  return {
    operationId: OPERATION_ID,
    ownerId: OWNER_ID,
    ownerScopeHash: ownerScopeSha256(OWNER_ID),
    planSha256: HEX_A,
    backupReceiptSha256: HEX_B,
    reviewSetSha256: HEX_A,
    recoveryReceipt: {
      contractVersion: 1,
      backupId: 'backup-20260825T155500Z-0123456789ab',
      ownerScopeHash: ownerScopeSha256(OWNER_ID),
      reviewSetSha256: HEX_A,
      manifestSha256: HEX_A,
      artifactSetSha256: HEX_B,
      restoreVerification: 'verified',
      status: 'verified',
      createdAt: '2026-08-25T15:55:00.000Z',
      receiptSha256: HEX_B,
    },
    nonceHash: `sha256:${HEX_B}`,
    targetSetSha256: targetSetSha256(targets),
    notBefore: '2026-08-25T16:15:00.000Z',
    at: NOW.toISOString(),
    targets,
  };
}

function state(overrides: Partial<CleanupOperationState> = {}): CleanupOperationState {
  const value = registration();
  return {
    operationId: value.operationId,
    ownerScopeHash: value.ownerScopeHash,
    planSha256: value.planSha256,
    backupReceiptSha256: value.backupReceiptSha256,
    reviewSetSha256: value.reviewSetSha256,
    nonceHash: value.nonceHash,
    targetSetSha256: value.targetSetSha256,
    notBefore: value.notBefore,
    backupVerified: true,
    searchReconciled: false,
    recallReconciled: false,
    targets: value.targets,
    targetReceipts: [],
    authorityId: 'cleanup-authority-1',
    authoritySha256: HEX_A,
    authorityExpiresAt: '2026-08-25T17:00:00.000Z',
    executionStatus: 'ready',
    ...overrides,
  };
}

function dependencies() {
  const cleanup: jest.Mocked<PersonalAccountCleanupService> = {
    tombstoneMessage: jest.fn().mockResolvedValue({ status: 'tombstoned' }),
    tombstoneConversation: jest.fn().mockResolvedValue({ status: 'tombstoned' }),
    tombstoneSchedule: jest.fn().mockResolvedValue({ status: 'tombstoned' }),
    tombstoneMemory: jest.fn().mockResolvedValue({ status: 'tombstoned' }),
    reconcileSearch: jest.fn().mockResolvedValue({ status: 'verified' }),
    reconcileRecall: jest.fn().mockResolvedValue({ status: 'verified' }),
    runDelayedNonceSweep: jest.fn().mockResolvedValue({ status: 'verified' }),
  };
  const registry: jest.Mocked<CleanupExecutionRegistry> = {
    registerVerifiedBackupOperation: jest.fn().mockResolvedValue(state()),
    claimCleanupExecution: jest.fn().mockResolvedValue({
      status: 'claimed',
      leaseToken: 'lease-token-1',
      operation: state({ executionStatus: 'claimed' }),
    }),
    completeCleanupExecution: jest
      .fn()
      .mockResolvedValue(
        state({ executionStatus: 'completed', searchReconciled: true, recallReconciled: true }),
      ),
    failCleanupExecution: jest.fn().mockResolvedValue(state({ executionStatus: 'partial' })),
    readCleanupOperation: jest.fn().mockResolvedValue(state()),
  };
  return { cleanup, registry, preflight: jest.fn().mockResolvedValue(undefined) };
}

function input() {
  const value = registration();
  const backupAuthority: CleanupBackupAuthority = {
    contractVersion: 1,
    authorityId: 'cleanup-authority-1',
    purpose: 'reviewed_personal_account_synthetic_qa_cleanup',
    reviewedCleanupApproved: true,
    ownerScopeHash: value.ownerScopeHash,
    operationId: value.operationId,
    planSha256: value.planSha256,
    backupReceiptSha256: value.backupReceiptSha256,
    reviewSetSha256: value.reviewSetSha256,
    targetSetSha256: value.targetSetSha256,
    targetBindingsSha256: HEX_A,
    nonceHash: value.nonceHash,
    backupId: value.recoveryReceipt.backupId,
    backupCreatedAt: value.recoveryReceipt.createdAt,
    issuedAt: '2026-08-25T15:59:00.000Z',
    expiresAt: '2026-08-25T17:00:00.000Z',
    proof: 'ed25519:fixture',
  };
  return {
    authenticatedOwnerId: OWNER_ID,
    confirmation: CLEANUP_EXECUTION_CONFIRMATION,
    attemptId: 'cleanup-attempt-1',
    registration: value,
    backupAuthority,
  };
}

describe('personal account cleanup executor', () => {
  test('requires the authenticated owner and explicit reviewed-cleanup confirmation', async () => {
    const deps = dependencies();
    const executor = createPersonalAccountCleanupExecutor({ ...deps, now: () => NOW });

    await expect(executor.execute({ ...input(), confirmation: 'yes' })).rejects.toThrow(
      'cleanup_reviewed_authorization_required',
    );
    await expect(
      executor.execute({ ...input(), authenticatedOwnerId: 'owner-cleanup-2' }),
    ).rejects.toThrow('cleanup_authenticated_owner_mismatch');
    expect(deps.registry.registerVerifiedBackupOperation).not.toHaveBeenCalled();
    expect(deps.cleanup.tombstoneMessage).not.toHaveBeenCalled();
  });

  test('rejects a completed authorization replay without calling a mutation', async () => {
    const deps = dependencies();
    deps.registry.claimCleanupExecution.mockRejectedValue(
      new Error('cleanup_authorization_replayed'),
    );
    const executor = createPersonalAccountCleanupExecutor({ ...deps, now: () => NOW });

    await expect(executor.execute(input())).rejects.toThrow('cleanup_authorization_replayed');
    expect(deps.cleanup.tombstoneMessage).not.toHaveBeenCalled();
    expect(deps.registry.failCleanupExecution).not.toHaveBeenCalled();
  });

  test('records a partial failure and resumes only unfinished exact targets', async () => {
    const deps = dependencies();
    deps.cleanup.tombstoneConversation.mockRejectedValueOnce(
      new Error('cleanup_target_cas_conflict'),
    );
    const executor = createPersonalAccountCleanupExecutor({ ...deps, now: () => NOW });

    await expect(executor.execute(input())).rejects.toBeInstanceOf(
      PersonalAccountCleanupPartialFailure,
    );
    expect(deps.cleanup.tombstoneMessage).toHaveBeenCalledTimes(1);
    expect(deps.registry.failCleanupExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: OWNER_ID,
        operationId: OPERATION_ID,
        leaseToken: 'lease-token-1',
        errorCode: 'cleanup_target_cas_conflict',
      }),
    );

    const messageTarget = registration().targets[0];
    deps.registry.registerVerifiedBackupOperation.mockResolvedValue(
      state({
        executionStatus: 'partial',
        targetReceipts: [
          {
            targetKind: 'message',
            targetHash: cleanupTargetSha256(OWNER_ID, messageTarget),
            revision: messageTarget.expectedRevision + 1,
            tombstonedAt: NOW.toISOString(),
          },
        ],
      }),
    );
    deps.registry.claimCleanupExecution.mockResolvedValue({
      status: 'recovered',
      leaseToken: 'lease-token-2',
      operation: state({ executionStatus: 'claimed' }),
    });

    await expect(executor.execute({ ...input(), attemptId: 'cleanup-attempt-2' })).resolves.toEqual(
      expect.objectContaining({ status: 'completed', resumed: true, targetCount: 2 }),
    );
    expect(deps.cleanup.tombstoneMessage).toHaveBeenCalledTimes(1);
    expect(deps.cleanup.tombstoneConversation).toHaveBeenCalledTimes(2);
    expect(deps.cleanup.reconcileSearch).toHaveBeenCalledTimes(1);
    expect(deps.cleanup.reconcileRecall).toHaveBeenCalledTimes(1);
    expect(deps.registry.completeCleanupExecution).toHaveBeenCalledWith(
      expect.objectContaining({ leaseToken: 'lease-token-2' }),
    );
  });
});
