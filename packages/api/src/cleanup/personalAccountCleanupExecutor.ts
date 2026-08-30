import { timingSafeEqual } from 'crypto';
import { cleanupTargetSha256 } from './personalAccountCleanup';
import type {
  CleanupBackupAuthority,
  CleanupExecutionRegistry,
  CleanupMutationRequest,
  CleanupOperationRegistration,
  CleanupOperationState,
  CleanupTargetBinding,
  PersonalAccountCleanupService,
} from './types';

export const CLEANUP_EXECUTION_CONFIRMATION = 'EXECUTE_REVIEWED_SYNTHETIC_QA_CLEANUP';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_ERROR = /^cleanup_[a-z0-9_]{1,96}$/;
const TARGET_ORDER: Record<CleanupTargetBinding['kind'], number> = {
  message: 0,
  memory: 1,
  schedule: 2,
  conversation: 3,
};

function exact(left: string, right: string): boolean {
  const first = Buffer.from(String(left || ''), 'utf8');
  const second = Buffer.from(String(right || ''), 'utf8');
  return first.length === second.length && timingSafeEqual(first, second);
}

function requireSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(String(value || '')) || ['all', '*', '.', '..'].includes(value)) {
    throw new Error(`${label}_invalid`);
  }
}

function safeErrorCode(error: object): string {
  const message = 'message' in error ? String(error.message || '') : '';
  return SAFE_ERROR.test(message) ? message : 'cleanup_execution_failed';
}

function targetRecorded(
  state: CleanupOperationState,
  ownerId: string,
  target: CleanupTargetBinding,
): boolean {
  const targetHash = cleanupTargetSha256(ownerId, target);
  return state.targetReceipts.some(
    (receipt) =>
      receipt.targetKind === target.kind &&
      exact(receipt.targetHash, targetHash) &&
      receipt.revision === target.expectedRevision + 1,
  );
}

function mutationRequest(
  registration: CleanupOperationRegistration,
  target: CleanupTargetBinding,
): CleanupMutationRequest {
  return {
    operationId: registration.operationId,
    ownerId: registration.ownerId,
    planSha256: registration.planSha256,
    backupReceiptSha256: registration.backupReceiptSha256,
    reviewSetSha256: registration.reviewSetSha256,
    target,
  };
}

export class PersonalAccountCleanupPartialFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super('cleanup_execution_partial_failure');
    this.name = 'PersonalAccountCleanupPartialFailure';
    this.code = code;
  }
}

export interface PersonalAccountCleanupExecuteInput {
  authenticatedOwnerId: string;
  confirmation?: string;
  attemptId?: string;
  registration?: CleanupOperationRegistration;
  backupAuthority?: CleanupBackupAuthority;
}

export interface PersonalAccountCleanupSweepInput {
  authenticatedOwnerId: string;
  confirmation?: string;
  registration?: CleanupOperationRegistration;
  backupAuthority?: CleanupBackupAuthority;
  runNonce?: string;
}

export function createPersonalAccountCleanupExecutor({
  cleanup,
  registry,
  preflight = async () => undefined,
  now = () => new Date(),
}: {
  cleanup: PersonalAccountCleanupService;
  registry: CleanupExecutionRegistry;
  preflight?: (registration: CleanupOperationRegistration) => Promise<void>;
  now?: () => Date;
}) {
  async function executeTarget(
    registration: CleanupOperationRegistration,
    target: CleanupTargetBinding,
  ): Promise<void> {
    const request = mutationRequest(registration, target);
    if (target.kind === 'message') {
      await cleanup.tombstoneMessage(request);
      return;
    }
    if (target.kind === 'memory') {
      await cleanup.tombstoneMemory(request);
      return;
    }
    if (target.kind === 'schedule') {
      await cleanup.tombstoneSchedule(request);
      return;
    }
    await cleanup.tombstoneConversation(request);
  }

  async function execute(input: PersonalAccountCleanupExecuteInput) {
    if (input.confirmation !== CLEANUP_EXECUTION_CONFIRMATION) {
      throw new Error('cleanup_reviewed_authorization_required');
    }
    if (!input.registration) throw new Error('cleanup_registration_invalid');
    if (!input.backupAuthority) throw new Error('cleanup_backup_authority_missing');
    requireSafeId(input.authenticatedOwnerId, 'cleanup_authenticated_owner');
    requireSafeId(String(input.attemptId || ''), 'cleanup_execution_attempt');
    if (!exact(input.authenticatedOwnerId, input.registration.ownerId)) {
      throw new Error('cleanup_authenticated_owner_mismatch');
    }

    const registered = await registry.registerVerifiedBackupOperation({
      ...input.registration,
      backupAuthority: input.backupAuthority,
    });
    await preflight(input.registration);
    const claim = await registry.claimCleanupExecution({
      ownerId: input.authenticatedOwnerId,
      operationId: input.registration.operationId,
      attemptId: String(input.attemptId),
      at: now().toISOString(),
    });

    try {
      const targets = [...input.registration.targets].sort((left, right) => {
        const kindOrder = TARGET_ORDER[left.kind] - TARGET_ORDER[right.kind];
        if (kindOrder !== 0) return kindOrder;
        return left.resourceId < right.resourceId ? -1 : left.resourceId > right.resourceId ? 1 : 0;
      });
      for (const target of targets) {
        if (!targetRecorded(registered, input.authenticatedOwnerId, target)) {
          await executeTarget(input.registration, target);
        }
      }
      if (!registered.searchReconciled) {
        await cleanup.reconcileSearch({
          ownerId: input.authenticatedOwnerId,
          operationId: input.registration.operationId,
          targetSetSha256: input.registration.targetSetSha256,
        });
      }
      if (!registered.recallReconciled) {
        await cleanup.reconcileRecall({
          ownerId: input.authenticatedOwnerId,
          operationId: input.registration.operationId,
          targetSetSha256: input.registration.targetSetSha256,
        });
      }
      const completed = await registry.completeCleanupExecution({
        ownerId: input.authenticatedOwnerId,
        operationId: input.registration.operationId,
        attemptId: String(input.attemptId),
        leaseToken: claim.leaseToken,
        at: now().toISOString(),
      });
      return {
        status: 'completed' as const,
        operationId: completed.operationId,
        ownerScopeHash: completed.ownerScopeHash,
        targetSetSha256: completed.targetSetSha256,
        targetCount: completed.targets.length,
        resumed: claim.status === 'recovered',
      };
    } catch (error) {
      const code = safeErrorCode(error instanceof Error ? error : new Error(''));
      try {
        await registry.failCleanupExecution({
          ownerId: input.authenticatedOwnerId,
          operationId: input.registration.operationId,
          attemptId: String(input.attemptId),
          leaseToken: claim.leaseToken,
          errorCode: code,
          at: now().toISOString(),
        });
      } catch {
        throw new PersonalAccountCleanupPartialFailure('cleanup_execution_failure_not_recorded');
      }
      throw new PersonalAccountCleanupPartialFailure(code);
    }
  }

  async function verifyDelayedSweep(input: PersonalAccountCleanupSweepInput) {
    if (input.confirmation !== CLEANUP_EXECUTION_CONFIRMATION) {
      throw new Error('cleanup_reviewed_authorization_required');
    }
    if (!input.registration) throw new Error('cleanup_registration_invalid');
    if (!input.backupAuthority) throw new Error('cleanup_backup_authority_missing');
    requireSafeId(input.authenticatedOwnerId, 'cleanup_authenticated_owner');
    requireSafeId(String(input.runNonce || ''), 'cleanup_run_nonce');
    if (!exact(input.authenticatedOwnerId, input.registration.ownerId)) {
      throw new Error('cleanup_authenticated_owner_mismatch');
    }
    const operation = await registry.registerVerifiedBackupOperation({
      ...input.registration,
      backupAuthority: input.backupAuthority,
    });
    if (operation.executionStatus !== 'completed') {
      throw new Error('cleanup_execution_not_completed');
    }
    const result = await cleanup.runDelayedNonceSweep({
      ownerId: input.authenticatedOwnerId,
      operationId: input.registration.operationId,
      runNonce: String(input.runNonce),
      targetSetSha256: input.registration.targetSetSha256,
    });
    return {
      status: result.status,
      operationId: operation.operationId,
      ownerScopeHash: operation.ownerScopeHash,
      targetSetSha256: operation.targetSetSha256,
      verifiedTargetCount: result.verifiedTargetCount,
      receiptSha256: result.receiptSha256,
    };
  }

  return { execute, verifyDelayedSweep };
}
