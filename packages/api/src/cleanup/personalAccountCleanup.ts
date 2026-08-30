import { createHash, timingSafeEqual } from 'crypto';
import type {
  CleanupJsonValue,
  CleanupMutationRequest,
  CleanupOperationBinding,
  CleanupOperationState,
  CleanupSourceState,
  CleanupTargetBinding,
  CleanupTargetKind,
  CleanupTargetRef,
  PersonalAccountCleanupDependencies,
} from './types';

const HASH = /^[a-f0-9]{64}$/;
const PREFIXED_HASH = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const STATE_HASH_PREFIX = 'viventium.cleanup.state.v1|';
const textEncoder = new TextEncoder();

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalize(value: CleanupJsonValue): CleanupJsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce<{ [key: string]: CleanupJsonValue }>((result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      }, {});
  }
  return value;
}

function canonicalJson(value: CleanupJsonValue): string {
  return JSON.stringify(canonicalize(value));
}

function encodeCleanupState(value: CleanupJsonValue): string {
  if (value == null) return 'n;';
  if (typeof value === 'boolean') return value ? 'b1;' : 'b0;';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'n;';
    if (Number.isSafeInteger(value)) return `i${Object.is(value, -0) ? 0 : value};`;
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeDoubleBE(value, 0);
    return `f${buffer.toString('hex')};`;
  }
  if (typeof value === 'string') {
    const bytes = textEncoder.encode(value);
    return `s${bytes.byteLength}:${Buffer.from(bytes).toString('hex')};`;
  }
  if (Array.isArray(value)) {
    return `a${value.length}[${value.map(encodeCleanupState).join('')}]`;
  }
  const keys = Object.keys(value).sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
  );
  return `o${keys.length}{${keys
    .map((key) => `${encodeCleanupState(key)}${encodeCleanupState(value[key])}`)
    .join('')}}`;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requireHash(value: string, label: string): void {
  if (!HASH.test(value)) {
    throw new Error(`${label}_invalid`);
  }
}

function requirePrefixedHash(value: string, label: string): void {
  if (!PREFIXED_HASH.test(value)) {
    throw new Error(`${label}_invalid`);
  }
}

function requireSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value) || ['all', '*', '.', '..'].includes(value)) {
    throw new Error(`${label}_invalid`);
  }
}

export function ownerScopeSha256(ownerId: string): string {
  requireSafeId(ownerId, 'cleanup_owner_id');
  return `sha256:${sha256(ownerId)}`;
}

export function nonceSha256(nonce: string): string {
  requireSafeId(nonce, 'cleanup_nonce');
  return `sha256:${sha256(nonce)}`;
}

export function cleanupTargetSha256(ownerId: string, target: CleanupTargetRef): string {
  requireSafeId(target.resourceId, 'cleanup_resource_id');
  return `sha256:${sha256(
    canonicalJson({ ownerId, kind: target.kind, resourceId: target.resourceId }),
  )}`;
}

export function cleanupStateSha256(state: CleanupSourceState): string {
  return sha256(
    STATE_HASH_PREFIX +
      encodeCleanupState({
        kind: state.kind,
        ownerId: state.ownerId,
        resourceId: state.resourceId,
        revision: state.revision,
        updatedAt: state.updatedAt,
        payload: state.payload,
      }),
  );
}

export function targetSetSha256(targets: CleanupTargetRef[]): string {
  const normalized = [...targets]
    .map((target) => ({ kind: target.kind, resourceId: target.resourceId }))
    .sort((left, right) => {
      const leftKey = `${left.kind}\0${left.resourceId}`;
      const rightKey = `${right.kind}\0${right.resourceId}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return sha256(canonicalJson(normalized));
}

function validateTarget(target: CleanupTargetBinding, expectedKind: CleanupTargetKind): void {
  if (target.kind !== expectedKind) {
    throw new Error('cleanup_target_kind_mismatch');
  }
  requireSafeId(target.resourceId, 'cleanup_resource_id');
  if (!Number.isSafeInteger(target.expectedRevision) || target.expectedRevision < 0) {
    throw new Error('cleanup_target_revision_invalid');
  }
  const parsedUpdatedAt = Date.parse(target.expectedUpdatedAt);
  if (
    !Number.isFinite(parsedUpdatedAt) ||
    new Date(parsedUpdatedAt).toISOString() !== target.expectedUpdatedAt
  ) {
    throw new Error('cleanup_target_updated_at_invalid');
  }
  requireHash(target.stateSha256, 'cleanup_state_sha256');
  requireHash(target.preimageSha256, 'cleanup_preimage_sha256');
  requireHash(target.reviewBindingSha256, 'cleanup_review_binding_sha256');
  requirePrefixedHash(target.runNonceHash, 'cleanup_run_nonce_hash');
  if (!safeEqual(target.stateSha256, target.preimageSha256)) {
    throw new Error('cleanup_preimage_state_mismatch');
  }
}

function operationBinding(request: CleanupMutationRequest): CleanupOperationBinding {
  requireSafeId(request.operationId, 'cleanup_operation_id');
  requireSafeId(request.ownerId, 'cleanup_owner_id');
  requireHash(request.planSha256, 'cleanup_plan_sha256');
  requireHash(request.backupReceiptSha256, 'cleanup_backup_receipt_sha256');
  requireHash(request.reviewSetSha256, 'cleanup_review_set_sha256');
  return {
    operationId: request.operationId,
    ownerId: request.ownerId,
    planSha256: request.planSha256,
    backupReceiptSha256: request.backupReceiptSha256,
    reviewSetSha256: request.reviewSetSha256,
    ownerScopeHash: ownerScopeSha256(request.ownerId),
    target: request.target,
  };
}

function assertRecordedTargetReceipts(
  state: CleanupOperationState,
  ownerId: string,
  targets: CleanupTargetBinding[],
): void {
  for (const target of targets) {
    const expectedHash = cleanupTargetSha256(ownerId, target);
    const matches = state.targetReceipts.filter(
      (receipt) =>
        receipt.targetKind === target.kind && safeEqual(receipt.targetHash, expectedHash),
    );
    if (matches.length !== 1 || matches[0].revision !== target.expectedRevision + 1) {
      throw new Error('cleanup_target_receipt_missing');
    }
  }
}

function assertCurrentState(
  current: CleanupSourceState,
  request: CleanupMutationRequest,
  expectedKind: 'message' | 'conversation' | 'memory',
): void {
  if (
    current.kind !== expectedKind ||
    current.ownerId !== request.ownerId ||
    current.resourceId !== request.target.resourceId
  ) {
    throw new Error('cleanup_target_not_found');
  }
  if (current.revision !== request.target.expectedRevision) {
    throw new Error('cleanup_target_revision_conflict');
  }
  const currentDigest = cleanupStateSha256(current);
  if (
    current.updatedAt !== request.target.expectedUpdatedAt ||
    !safeEqual(currentDigest, request.target.stateSha256)
  ) {
    throw new Error('cleanup_target_state_conflict');
  }
}

function assertOperationState(
  state: CleanupOperationState | null,
  ownerId: string,
  operationId: string,
  expectedTargetSetSha256: string,
): CleanupOperationState {
  if (
    !state ||
    state.operationId !== operationId ||
    state.ownerScopeHash !== ownerScopeSha256(ownerId)
  ) {
    throw new Error('cleanup_operation_not_found');
  }
  requireHash(expectedTargetSetSha256, 'cleanup_target_set_sha256');
  if (!safeEqual(state.targetSetSha256, expectedTargetSetSha256)) {
    throw new Error('cleanup_target_set_mismatch');
  }
  if (!state.backupVerified) {
    throw new Error('cleanup_backup_unverified');
  }
  if (!safeEqual(targetSetSha256(state.targets), state.targetSetSha256)) {
    throw new Error('cleanup_operation_target_set_corrupt');
  }
  return state;
}

export function createPersonalAccountCleanupService({
  repository,
  search,
  recall,
  schedules,
  memories,
  residue,
  now = () => new Date(),
}: PersonalAccountCleanupDependencies) {
  async function tombstoneMongoTarget(
    request: CleanupMutationRequest,
    kind: 'message' | 'conversation',
  ) {
    validateTarget(request.target, kind);
    const binding = operationBinding(request);
    await repository.assertBackupVerified(binding);
    const current = await repository.readActiveTarget(
      kind,
      request.ownerId,
      request.target.resourceId,
    );
    if (!current) {
      const tombstone = await repository.readMatchingTombstone(
        kind,
        request.ownerId,
        request.target.resourceId,
      );
      if (
        tombstone &&
        tombstone.operationId === request.operationId &&
        tombstone.reviewBindingSha256 === request.target.reviewBindingSha256 &&
        tombstone.preimageSha256 === request.target.preimageSha256
      ) {
        const targetHash = cleanupTargetSha256(request.ownerId, request.target);
        const receipt = await repository.appendReceipt({
          operationId: request.operationId,
          ownerScopeHash: binding.ownerScopeHash,
          stage: 'target_tombstoned',
          at: tombstone.tombstonedAt,
          targetKind: kind,
          targetHash,
          count: 1,
          revision: tombstone.revision,
        });
        return {
          status: 'already_tombstoned' as const,
          targetKind: kind,
          targetHash,
          revision: tombstone.revision,
          tombstonedAt: tombstone.tombstonedAt,
          receiptSha256: receipt.receiptSha256,
        };
      }
      throw new Error('cleanup_target_not_found');
    }
    assertCurrentState(current, request, kind);
    if (kind === 'conversation') {
      const activeChildren = await repository.countActiveConversationMessages(
        request.ownerId,
        request.target.resourceId,
      );
      if (activeChildren !== 0) {
        throw new Error('cleanup_conversation_active_children');
      }
    }
    const at = now().toISOString();
    const mutation = await repository.applyTombstone({
      source: current,
      operationId: request.operationId,
      ownerScopeHash: binding.ownerScopeHash,
      reviewBindingSha256: request.target.reviewBindingSha256,
      preimageSha256: request.target.preimageSha256,
      runNonceHash: request.target.runNonceHash,
      tombstonedAt: at,
    });
    if (!mutation.applied) {
      throw new Error('cleanup_target_cas_conflict');
    }
    const targetHash = cleanupTargetSha256(request.ownerId, request.target);
    const receipt = await repository.appendReceipt({
      operationId: request.operationId,
      ownerScopeHash: binding.ownerScopeHash,
      stage: 'target_tombstoned',
      at,
      targetKind: kind,
      targetHash,
      count: 1,
      revision: mutation.revision,
    });
    return {
      status: 'tombstoned' as const,
      targetKind: kind,
      targetHash,
      revision: mutation.revision,
      tombstonedAt: mutation.tombstonedAt,
      receiptSha256: receipt.receiptSha256,
    };
  }

  async function tombstoneSchedule(request: CleanupMutationRequest) {
    validateTarget(request.target, 'schedule');
    const binding = operationBinding(request);
    await repository.assertBackupVerified(binding);
    const at = now().toISOString();
    const result = await schedules.tombstoneExact({
      ...request,
      ownerScopeHash: binding.ownerScopeHash,
      tombstonedAt: at,
    });
    if (!result.applied) {
      throw new Error('cleanup_target_cas_conflict');
    }
    if (result.tombstonedAt !== at) {
      throw new Error('cleanup_schedule_receipt_mismatch');
    }
    const targetHash = cleanupTargetSha256(request.ownerId, request.target);
    const receipt = await repository.appendReceipt({
      operationId: request.operationId,
      ownerScopeHash: binding.ownerScopeHash,
      stage: 'target_tombstoned',
      at: result.tombstonedAt,
      targetKind: 'schedule',
      targetHash,
      receiptSha256: result.receiptSha256,
      count: 1,
      revision: result.revision,
    });
    return {
      status: 'tombstoned' as const,
      targetKind: 'schedule' as const,
      targetHash,
      revision: result.revision,
      tombstonedAt: result.tombstonedAt,
      receiptSha256: receipt.receiptSha256,
    };
  }

  async function tombstoneMemory(request: CleanupMutationRequest) {
    validateTarget(request.target, 'memory');
    const binding = operationBinding(request);
    await repository.assertBackupVerified(binding);
    const current = await memories.readActiveTarget(request.ownerId, request.target.resourceId);
    if (!current) {
      const tombstone = await memories.readRetainedTombstone(
        request.ownerId,
        request.target.resourceId,
      );
      const state = await repository.getOperationState(request.ownerId, request.operationId);
      if (!tombstone || !state || tombstone.revision !== request.target.expectedRevision + 1) {
        throw new Error('cleanup_target_not_found');
      }
      assertRecordedTargetReceipts(state, request.ownerId, [request.target]);
      const recorded = state.targetReceipts.find(
        (receipt) =>
          receipt.targetKind === 'memory' &&
          safeEqual(receipt.targetHash, cleanupTargetSha256(request.ownerId, request.target)),
      );
      if (!recorded || recorded.tombstonedAt !== tombstone.tombstonedAt) {
        throw new Error('cleanup_memory_tombstone_binding_mismatch');
      }
      const targetHash = cleanupTargetSha256(request.ownerId, request.target);
      const receipt = await repository.appendReceipt({
        operationId: request.operationId,
        ownerScopeHash: binding.ownerScopeHash,
        stage: 'target_tombstoned',
        at: tombstone.tombstonedAt,
        targetKind: 'memory',
        targetHash,
        count: 1,
        revision: tombstone.revision,
      });
      return {
        status: 'already_tombstoned' as const,
        targetKind: 'memory' as const,
        targetHash,
        revision: tombstone.revision,
        tombstonedAt: tombstone.tombstonedAt,
        receiptSha256: receipt.receiptSha256,
      };
    }
    assertCurrentState(current, request, 'memory');
    const at = now().toISOString();
    const mutation = await memories.applyTombstone({
      source: current,
      operationId: request.operationId,
      ownerScopeHash: binding.ownerScopeHash,
      reviewBindingSha256: request.target.reviewBindingSha256,
      preimageSha256: request.target.preimageSha256,
      runNonceHash: request.target.runNonceHash,
      tombstonedAt: at,
    });
    if (!mutation.applied) {
      throw new Error('cleanup_target_cas_conflict');
    }
    const targetHash = cleanupTargetSha256(request.ownerId, request.target);
    const receipt = await repository.appendReceipt({
      operationId: request.operationId,
      ownerScopeHash: binding.ownerScopeHash,
      stage: 'target_tombstoned',
      at,
      targetKind: 'memory',
      targetHash,
      count: 1,
      revision: mutation.revision,
    });
    return {
      status: 'tombstoned' as const,
      targetKind: 'memory' as const,
      targetHash,
      revision: mutation.revision,
      tombstonedAt: mutation.tombstonedAt,
      receiptSha256: receipt.receiptSha256,
    };
  }

  async function reconcileSearch(input: {
    operationId: string;
    ownerId: string;
    targetSetSha256: string;
  }) {
    const state = assertOperationState(
      await repository.getOperationState(input.ownerId, input.operationId),
      input.ownerId,
      input.operationId,
      input.targetSetSha256,
    );
    const retained = await repository.listOperationTombstones(input.ownerId, input.operationId);
    const searchTargets = state.targets.filter(
      (target) => target.kind === 'message' || target.kind === 'conversation',
    );
    const retainedSearchTargets = retained.filter(
      (target) => target.kind === 'message' || target.kind === 'conversation',
    );
    if (!safeEqual(targetSetSha256(retainedSearchTargets), targetSetSha256(searchTargets))) {
      throw new Error('cleanup_tombstone_set_incomplete');
    }
    assertRecordedTargetReceipts(state, input.ownerId, searchTargets);
    const result = await search.reconcileExact({ ownerId: input.ownerId, targets: searchTargets });
    if (result.status !== 'verified' || result.targetCount !== searchTargets.length) {
      throw new Error('cleanup_search_reconciliation_unverified');
    }
    const receipt = await repository.appendReceipt({
      operationId: input.operationId,
      ownerScopeHash: state.ownerScopeHash,
      stage: 'search_reconciled',
      at: now().toISOString(),
      targetSetSha256: state.targetSetSha256,
      receiptSha256: result.receiptSha256,
      count: result.targetCount,
    });
    return {
      status: 'verified' as const,
      targetCount: result.targetCount,
      receiptSha256: result.receiptSha256,
      durableReceiptSha256: receipt.receiptSha256,
    };
  }

  async function reconcileRecall(input: {
    operationId: string;
    ownerId: string;
    targetSetSha256: string;
  }) {
    const state = assertOperationState(
      await repository.getOperationState(input.ownerId, input.operationId),
      input.ownerId,
      input.operationId,
      input.targetSetSha256,
    );
    const retained = await repository.listOperationTombstones(input.ownerId, input.operationId);
    const recallTargets = state.targets.filter(
      (target) => target.kind === 'message' || target.kind === 'conversation',
    );
    const retainedRecallTargets = retained.filter(
      (target) => target.kind === 'message' || target.kind === 'conversation',
    );
    if (!safeEqual(targetSetSha256(retainedRecallTargets), targetSetSha256(recallTargets))) {
      throw new Error('cleanup_tombstone_set_incomplete');
    }
    assertRecordedTargetReceipts(state, input.ownerId, recallTargets);
    const result = await recall.rebuildOwnerRecall({
      ownerId: input.ownerId,
      operationId: input.operationId,
      targetSetSha256: state.targetSetSha256,
    });
    if (result.status !== 'verified') {
      throw new Error('cleanup_recall_reconciliation_unverified');
    }
    const receipt = await repository.appendReceipt({
      operationId: input.operationId,
      ownerScopeHash: state.ownerScopeHash,
      stage: 'recall_reconciled',
      at: now().toISOString(),
      targetSetSha256: state.targetSetSha256,
      receiptSha256: result.receiptSha256,
      count: recallTargets.length,
    });
    return {
      status: 'verified' as const,
      receiptSha256: result.receiptSha256,
      durableReceiptSha256: receipt.receiptSha256,
    };
  }

  async function runDelayedNonceSweep(input: {
    operationId: string;
    ownerId: string;
    runNonce: string;
    targetSetSha256: string;
  }) {
    const state = assertOperationState(
      await repository.getOperationState(input.ownerId, input.operationId),
      input.ownerId,
      input.operationId,
      input.targetSetSha256,
    );
    const nonceHash = nonceSha256(input.runNonce);
    if (!safeEqual(nonceHash, state.nonceHash)) {
      throw new Error('cleanup_sweep_nonce_mismatch');
    }
    if (!state.searchReconciled || !state.recallReconciled) {
      throw new Error('cleanup_sweep_prerequisite_missing');
    }
    assertRecordedTargetReceipts(state, input.ownerId, state.targets);
    if (!state.recallReceiptSha256 || !HASH.test(state.recallReceiptSha256)) {
      throw new Error('cleanup_sweep_recall_receipt_missing');
    }
    const notBefore = Date.parse(state.notBefore);
    if (!Number.isFinite(notBefore) || now().getTime() < notBefore) {
      throw new Error('cleanup_sweep_not_due');
    }
    const mongoTargets = state.targets.filter(
      (target) => target.kind === 'message' || target.kind === 'conversation',
    );
    const source = await repository.verifySourceTombstones({
      ownerId: input.ownerId,
      operationId: input.operationId,
      targets: mongoTargets,
      nonceHash,
    });
    if (source.verifiedCount !== mongoTargets.length) {
      throw new Error('cleanup_sweep_source_residue');
    }
    const searchTargets = state.targets.filter(
      (target) => target.kind === 'message' || target.kind === 'conversation',
    );
    const searchResult = await search.verifyAbsent({
      ownerId: input.ownerId,
      targets: searchTargets,
    });
    if (searchResult.verifiedCount !== searchTargets.length) {
      throw new Error('cleanup_sweep_search_residue');
    }
    const recallResult = await recall.verifyOperation({
      ownerId: input.ownerId,
      operationId: input.operationId,
      targetSetSha256: state.targetSetSha256,
      expectedReceiptSha256: state.recallReceiptSha256,
    });
    if (!recallResult.verified) {
      throw new Error('cleanup_sweep_recall_residue');
    }
    const scheduleTargets = state.targets.filter((target) => target.kind === 'schedule');
    const scheduleResult = await schedules.verifyOperation({
      ownerId: input.ownerId,
      operationId: input.operationId,
      targets: scheduleTargets,
      nonceHash,
    });
    if (scheduleResult.verifiedCount !== scheduleTargets.length) {
      throw new Error('cleanup_sweep_schedule_residue');
    }
    const memoryTargets = state.targets.filter((target) => target.kind === 'memory');
    const memoryResult = await memories.verifyOperation({
      ownerId: input.ownerId,
      operationId: input.operationId,
      targets: memoryTargets,
      nonceHash,
    });
    if (memoryResult.verifiedCount !== memoryTargets.length) {
      throw new Error('cleanup_sweep_memory_residue');
    }
    for (const tombstone of memoryResult.tombstones) {
      const target = memoryTargets.find(
        (candidate) => candidate.resourceId === tombstone.resourceId,
      );
      const receipt = target
        ? state.targetReceipts.find(
            (candidate) =>
              candidate.targetKind === 'memory' &&
              safeEqual(candidate.targetHash, cleanupTargetSha256(input.ownerId, target)),
          )
        : undefined;
      if (
        !target ||
        !receipt ||
        receipt.revision !== tombstone.revision ||
        receipt.tombstonedAt !== tombstone.tombstonedAt
      ) {
        throw new Error('cleanup_sweep_memory_binding_mismatch');
      }
    }
    const nonceResult = await residue.verifyNonceAbsent({
      ownerId: input.ownerId,
      runNonce: input.runNonce,
    });
    if (!nonceResult.verified || nonceResult.activeMessageCount !== 0) {
      throw new Error('cleanup_sweep_nonce_residue');
    }
    const receipt = await repository.appendReceipt({
      operationId: input.operationId,
      ownerScopeHash: state.ownerScopeHash,
      stage: 'delayed_nonce_sweep_verified',
      at: now().toISOString(),
      targetSetSha256: state.targetSetSha256,
      count: state.targets.length,
    });
    return {
      status: 'verified' as const,
      verifiedTargetCount: state.targets.length,
      receiptSha256: receipt.receiptSha256,
    };
  }

  return {
    tombstoneMessage: (request: CleanupMutationRequest) => tombstoneMongoTarget(request, 'message'),
    tombstoneConversation: (request: CleanupMutationRequest) =>
      tombstoneMongoTarget(request, 'conversation'),
    tombstoneSchedule,
    tombstoneMemory,
    reconcileSearch,
    reconcileRecall,
    runDelayedNonceSweep,
  };
}
