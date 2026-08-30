import { timingSafeEqual } from 'crypto';
import type {
  CleanupLedgerAdapter,
  CleanupOperationBinding,
  CleanupOperationState,
  CleanupReceiptInput,
} from './types';

interface CleanupReceiptModel {
  readCleanupOperation(
    ownerId: string,
    operationId: string,
  ): Promise<(CleanupOperationState & { ownerId?: string }) | null>;
  appendCleanupReceipt(input: CleanupReceiptInput): Promise<{ receiptSha256: string }>;
}

function exact(left: string, right: string): boolean {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function targetBindingMatches(
  expected: CleanupOperationBinding['target'],
  actual: CleanupOperationState['targets'][number],
): boolean {
  return (
    expected.kind === actual.kind &&
    exact(expected.resourceId, actual.resourceId) &&
    expected.expectedRevision === actual.expectedRevision &&
    exact(expected.expectedUpdatedAt, actual.expectedUpdatedAt) &&
    exact(expected.stateSha256, actual.stateSha256) &&
    exact(expected.preimageSha256, actual.preimageSha256) &&
    exact(expected.reviewBindingSha256, actual.reviewBindingSha256) &&
    exact(expected.runNonceHash, actual.runNonceHash)
  );
}

export function createCleanupLedgerAdapter(model: CleanupReceiptModel): CleanupLedgerAdapter {
  return {
    async assertBackupVerified(binding: CleanupOperationBinding): Promise<void> {
      const operation = await model.readCleanupOperation(binding.ownerId, binding.operationId);
      if (!operation || operation.backupVerified !== true) {
        throw new Error('cleanup_backup_unverified');
      }
      if (
        (operation.ownerId != null && !exact(operation.ownerId, binding.ownerId)) ||
        !exact(operation.ownerScopeHash, binding.ownerScopeHash) ||
        !exact(operation.planSha256, binding.planSha256) ||
        !exact(operation.backupReceiptSha256, binding.backupReceiptSha256) ||
        !exact(operation.reviewSetSha256, binding.reviewSetSha256)
      ) {
        throw new Error('cleanup_backup_binding_mismatch');
      }
      const registeredTarget = operation.targets.find(
        (target) =>
          target.kind === binding.target.kind &&
          exact(target.resourceId, binding.target.resourceId),
      );
      if (!registeredTarget || !targetBindingMatches(binding.target, registeredTarget)) {
        throw new Error('cleanup_reviewed_target_binding_mismatch');
      }
    },
    appendReceipt: (input: CleanupReceiptInput) => model.appendCleanupReceipt(input),
    getOperationState: (ownerId: string, operationId: string) =>
      model.readCleanupOperation(ownerId, operationId),
  };
}
