import {
  cleanupTargetSha256,
  cleanupStateSha256,
  createPersonalAccountCleanupService,
  nonceSha256,
  ownerScopeSha256,
  targetSetSha256,
} from '../personalAccountCleanup';
import type {
  CleanupOperationState,
  MemoryCleanupAdapter,
  CleanupRepository,
  CleanupSourceState,
  RecallCleanupAdapter,
  ScheduleCleanupAdapter,
  SearchCleanupAdapter,
  SyntheticQaResidueAdapter,
} from '../types';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);
const OWNER_ID = 'owner-1';
const OPERATION_ID = 'cleanup-operation-1';
const NOW = new Date('2026-08-25T16:00:00.000Z');
const NONCE_HASH = nonceSha256('qa-nonce-1');

function messageState(overrides: Partial<CleanupSourceState> = {}): CleanupSourceState {
  return {
    kind: 'message',
    ownerId: OWNER_ID,
    resourceId: 'message-1',
    revision: 4,
    updatedAt: '2026-08-25T15:00:00.000Z',
    payload: {
      conversationId: 'conversation-1',
      text: 'synthetic fixture content',
      metadata: { viventium: { qaRun: true, qaRunId: 'qa-nonce-1' } },
    },
    ...overrides,
  };
}

function requestFor(state: CleanupSourceState) {
  const stateSha256 = cleanupStateSha256(state);
  return {
    operationId: OPERATION_ID,
    ownerId: OWNER_ID,
    planSha256: HEX_A,
    backupReceiptSha256: HEX_B,
    reviewSetSha256: HEX_C,
    target: {
      kind: state.kind,
      resourceId: state.resourceId,
      expectedRevision: state.revision,
      expectedUpdatedAt: state.updatedAt,
      stateSha256,
      preimageSha256: stateSha256,
      reviewBindingSha256: HEX_A,
      runNonceHash: NONCE_HASH,
    },
  } as const;
}

function operationState(overrides: Partial<CleanupOperationState> = {}): CleanupOperationState {
  const targets = [
    requestFor(messageState()).target,
    requestFor(messageState({ kind: 'conversation', resourceId: 'conversation-1' })).target,
    requestFor(messageState({ kind: 'schedule', resourceId: 'schedule-1' })).target,
    requestFor(messageState({ kind: 'memory', resourceId: 'synthetic_memory' })).target,
  ];
  return {
    operationId: OPERATION_ID,
    ownerScopeHash: ownerScopeSha256(OWNER_ID),
    planSha256: HEX_A,
    backupReceiptSha256: HEX_B,
    reviewSetSha256: HEX_C,
    nonceHash: NONCE_HASH,
    targetSetSha256: targetSetSha256(targets),
    notBefore: '2026-08-25T16:15:00.000Z',
    backupVerified: true,
    searchReconciled: true,
    recallReconciled: true,
    searchReceiptSha256: HEX_A,
    recallReceiptSha256: HEX_B,
    targets,
    targetReceipts: targets.map((target) => ({
      targetKind: target.kind,
      targetHash: cleanupTargetSha256(OWNER_ID, target),
      revision: target.expectedRevision + 1,
      tombstonedAt: NOW.toISOString(),
    })),
    ...overrides,
  };
}

function dependencies() {
  const repository: jest.Mocked<CleanupRepository> = {
    assertBackupVerified: jest.fn().mockResolvedValue(undefined),
    readActiveTarget: jest.fn().mockResolvedValue(messageState()),
    readMatchingTombstone: jest.fn().mockResolvedValue(null),
    countActiveConversationMessages: jest.fn().mockResolvedValue(0),
    applyTombstone: jest.fn().mockResolvedValue({
      applied: true,
      revision: 5,
      tombstonedAt: NOW.toISOString(),
    }),
    listOperationTombstones: jest.fn().mockResolvedValue(operationState().targets),
    appendReceipt: jest.fn().mockResolvedValue({ receiptSha256: HEX_C }),
    getOperationState: jest.fn().mockResolvedValue(operationState()),
    verifySourceTombstones: jest.fn().mockResolvedValue({ verifiedCount: 2 }),
  };
  const search: jest.Mocked<SearchCleanupAdapter> = {
    reconcileExact: jest.fn().mockResolvedValue({
      status: 'verified',
      targetCount: 2,
      receiptSha256: HEX_A,
    }),
    verifyAbsent: jest.fn().mockResolvedValue({ verifiedCount: 2 }),
  };
  const recall: jest.Mocked<RecallCleanupAdapter> = {
    rebuildOwnerRecall: jest.fn().mockResolvedValue({
      status: 'verified',
      receiptSha256: HEX_B,
    }),
    verifyOperation: jest.fn().mockResolvedValue({ verified: true }),
  };
  const schedules: jest.Mocked<ScheduleCleanupAdapter> = {
    tombstoneExact: jest.fn().mockResolvedValue({
      applied: true,
      revision: 1,
      tombstonedAt: NOW.toISOString(),
      receiptSha256: HEX_A,
    }),
    verifyOperation: jest.fn().mockResolvedValue({ verifiedCount: 1 }),
  };
  const memories: jest.Mocked<MemoryCleanupAdapter> = {
    readActiveTarget: jest.fn().mockResolvedValue(
      messageState({
        kind: 'memory',
        resourceId: 'synthetic_memory',
        payload: { value: 'synthetic fixture', tokenCount: 2 },
      }),
    ),
    readRetainedTombstone: jest.fn().mockResolvedValue(null),
    applyTombstone: jest.fn().mockResolvedValue({
      applied: true,
      revision: 5,
      tombstonedAt: NOW.toISOString(),
    }),
    verifyOperation: jest.fn().mockResolvedValue({
      verifiedCount: 1,
      tombstones: [
        {
          resourceId: 'synthetic_memory',
          revision: 5,
          tombstonedAt: NOW.toISOString(),
        },
      ],
    }),
  };
  const residue: jest.Mocked<SyntheticQaResidueAdapter> = {
    verifyNonceAbsent: jest.fn().mockResolvedValue({ verified: true, activeMessageCount: 0 }),
  };
  return { repository, search, recall, schedules, memories, residue };
}

describe('personal account cleanup service', () => {
  test('state hash matches the shared Unicode and number contract', () => {
    expect(
      cleanupStateSha256({
        kind: 'message',
        ownerId: 'owner-1',
        resourceId: 'message-1',
        revision: 3,
        updatedAt: '2026-08-25T15:00:00.000Z',
        payload: {
          text: 'café 🐝',
          scores: [1, 1.5, 0.000001, 9007199254740992],
          ok: true,
          none: null,
        },
      }),
    ).toBe('3b4ca5e0525dc422efcedeabcca98b49fd1650fe47d57251bb5e360be490d63e');
  });

  test('target identity hashes only owner, kind, and resource id', () => {
    const base = cleanupTargetSha256(OWNER_ID, {
      kind: 'message',
      resourceId: 'message-1',
    });
    const targetWithChangedBinding = {
      ...requestFor(messageState()).target,
      stateSha256: HEX_B,
    };
    const bound = cleanupTargetSha256(OWNER_ID, targetWithChangedBinding);

    expect(bound).toBe(base);
  });

  test('requires a verified owner-bound backup before any tombstone', async () => {
    const deps = dependencies();
    deps.repository.assertBackupVerified.mockRejectedValue(new Error('cleanup_backup_unverified'));
    const service = createPersonalAccountCleanupService({ ...deps, now: () => NOW });

    await expect(service.tombstoneMessage(requestFor(messageState()))).rejects.toThrow(
      'cleanup_backup_unverified',
    );

    expect(deps.repository.readActiveTarget).not.toHaveBeenCalled();
    expect(deps.repository.applyTombstone).not.toHaveBeenCalled();
  });

  test('applies one exact owner and revision bound message tombstone', async () => {
    const deps = dependencies();
    const source = messageState();
    const request = requestFor(source);
    const service = createPersonalAccountCleanupService({ ...deps, now: () => NOW });

    const result = await service.tombstoneMessage(request);

    expect(result).toEqual({
      status: 'tombstoned',
      targetKind: 'message',
      targetHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      revision: 5,
      tombstonedAt: NOW.toISOString(),
      receiptSha256: HEX_C,
    });
    expect(deps.repository.readActiveTarget).toHaveBeenCalledWith('message', OWNER_ID, 'message-1');
    expect(deps.repository.assertBackupVerified).toHaveBeenCalledWith(
      expect.objectContaining({ target: request.target }),
    );
    expect(deps.repository.applyTombstone).toHaveBeenCalledWith(
      expect.objectContaining({
        source,
        operationId: OPERATION_ID,
        ownerScopeHash: ownerScopeSha256(OWNER_ID),
        reviewBindingSha256: HEX_A,
        runNonceHash: NONCE_HASH,
      }),
    );
  });

  test.each([
    ['revision', { revision: 5 }, 'cleanup_target_revision_conflict'],
    ['updated time', { updatedAt: '2026-08-25T15:01:00.000Z' }, 'cleanup_target_state_conflict'],
    [
      'content state',
      { payload: { conversationId: 'conversation-1', text: 'changed after review' } },
      'cleanup_target_state_conflict',
    ],
    ['owner', { ownerId: 'other-owner' }, 'cleanup_target_not_found'],
  ])('fails closed on stale or substituted %s', async (_label, override, error) => {
    const deps = dependencies();
    const reviewed = messageState();
    deps.repository.readActiveTarget.mockResolvedValue(messageState(override));
    const service = createPersonalAccountCleanupService({ ...deps, now: () => NOW });

    await expect(service.tombstoneMessage(requestFor(reviewed))).rejects.toThrow(error);
    expect(deps.repository.applyTombstone).not.toHaveBeenCalled();
  });

  test('never tombstones a conversation while any active child remains', async () => {
    const deps = dependencies();
    const source = messageState({
      kind: 'conversation',
      resourceId: 'conversation-1',
      payload: { title: 'synthetic fixture', messageCount: 1 },
    });
    deps.repository.readActiveTarget.mockResolvedValue(source);
    deps.repository.countActiveConversationMessages.mockResolvedValue(1);
    const service = createPersonalAccountCleanupService({ ...deps, now: () => NOW });

    await expect(service.tombstoneConversation(requestFor(source))).rejects.toThrow(
      'cleanup_conversation_active_children',
    );
    expect(deps.repository.applyTombstone).not.toHaveBeenCalled();
  });

  test('treats only the exact matching retained tombstone as idempotent', async () => {
    const deps = dependencies();
    const source = messageState();
    deps.repository.readActiveTarget.mockResolvedValue(null);
    deps.repository.readMatchingTombstone.mockResolvedValue({
      kind: 'message',
      ownerId: OWNER_ID,
      resourceId: 'message-1',
      operationId: OPERATION_ID,
      reviewBindingSha256: HEX_A,
      preimageSha256: cleanupStateSha256(source),
      revision: 5,
      tombstonedAt: NOW.toISOString(),
    });
    const service = createPersonalAccountCleanupService({ ...deps, now: () => NOW });

    await expect(service.tombstoneMessage(requestFor(source))).resolves.toEqual(
      expect.objectContaining({
        status: 'already_tombstoned',
        revision: 5,
        receiptSha256: HEX_C,
      }),
    );
    expect(deps.repository.applyTombstone).not.toHaveBeenCalled();
    expect(deps.repository.appendReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'target_tombstoned',
        targetKind: 'message',
        at: NOW.toISOString(),
      }),
    );
  });

  test('delegates a schedule only after the same backup and review checks', async () => {
    const deps = dependencies();
    const source = messageState({
      kind: 'schedule',
      resourceId: 'schedule-1',
      payload: { active: true },
    });
    deps.repository.readActiveTarget.mockResolvedValue(source);
    const service = createPersonalAccountCleanupService({ ...deps, now: () => NOW });

    const result = await service.tombstoneSchedule(requestFor(source));

    expect(deps.schedules.tombstoneExact).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: OWNER_ID,
        target: requestFor(source).target,
        ownerScopeHash: ownerScopeSha256(OWNER_ID),
        tombstonedAt: NOW.toISOString(),
      }),
    );
    expect(result.status).toBe('tombstoned');
  });

  test('rejects a schedule receipt whose tombstone time differs from the request', async () => {
    const deps = dependencies();
    const source = messageState({
      kind: 'schedule',
      resourceId: 'schedule-1',
      payload: { active: false },
    });
    deps.schedules.tombstoneExact.mockResolvedValue({
      applied: true,
      revision: 1,
      tombstonedAt: '2026-08-25T16:00:01.000Z',
      receiptSha256: HEX_A,
    });
    const service = createPersonalAccountCleanupService({ ...deps, now: () => NOW });

    await expect(service.tombstoneSchedule(requestFor(source))).rejects.toThrow(
      'cleanup_schedule_receipt_mismatch',
    );
    expect(deps.repository.appendReceipt).not.toHaveBeenCalled();
  });

  test('tombstones one exact reviewed memory and records the operation receipt', async () => {
    const deps = dependencies();
    const source = messageState({
      kind: 'memory',
      resourceId: 'synthetic_memory',
      payload: { value: 'synthetic fixture', tokenCount: 2 },
    });
    deps.memories.readActiveTarget.mockResolvedValue(source);
    const service = createPersonalAccountCleanupService({ ...deps, now: () => NOW });

    await expect(service.tombstoneMemory(requestFor(source))).resolves.toEqual(
      expect.objectContaining({ status: 'tombstoned', targetKind: 'memory', revision: 5 }),
    );
    expect(deps.memories.applyTombstone).toHaveBeenCalledWith(
      expect.objectContaining({
        source,
        operationId: OPERATION_ID,
        runNonceHash: NONCE_HASH,
      }),
    );
    expect(deps.repository.appendReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'target_tombstoned', targetKind: 'memory' }),
    );
  });

  test('does not adopt a retained memory tombstone without this operation receipt', async () => {
    const deps = dependencies();
    const source = messageState({
      kind: 'memory',
      resourceId: 'synthetic_memory',
      payload: { value: 'synthetic fixture', tokenCount: 2 },
    });
    deps.memories.readActiveTarget.mockResolvedValue(null);
    deps.memories.readRetainedTombstone.mockResolvedValue({
      revision: 5,
      tombstonedAt: NOW.toISOString(),
    });
    deps.repository.getOperationState.mockResolvedValue(operationState({ targetReceipts: [] }));
    const service = createPersonalAccountCleanupService({ ...deps, now: () => NOW });

    await expect(service.tombstoneMemory(requestFor(source))).rejects.toThrow(
      'cleanup_target_receipt_missing',
    );
    expect(deps.repository.appendReceipt).not.toHaveBeenCalled();
  });

  test('reconciles only the exact retained operation targets and records a durable receipt', async () => {
    const deps = dependencies();
    const service = createPersonalAccountCleanupService({ ...deps, now: () => NOW });

    const result = await service.reconcileSearch({
      operationId: OPERATION_ID,
      ownerId: OWNER_ID,
      targetSetSha256: operationState().targetSetSha256,
    });

    expect(deps.search.reconcileExact).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      targets: operationState().targets.filter(
        (target) => target.kind === 'message' || target.kind === 'conversation',
      ),
    });
    expect(deps.repository.appendReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'search_reconciled', receiptSha256: HEX_A }),
    );
    expect(result.status).toBe('verified');
  });

  test('records recall completion only after the owner rebuild reports verified', async () => {
    const deps = dependencies();
    const service = createPersonalAccountCleanupService({ ...deps, now: () => NOW });

    await expect(
      service.reconcileRecall({
        operationId: OPERATION_ID,
        ownerId: OWNER_ID,
        targetSetSha256: operationState().targetSetSha256,
      }),
    ).resolves.toEqual(expect.objectContaining({ status: 'verified' }));
    expect(deps.recall.rebuildOwnerRecall).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      operationId: OPERATION_ID,
      targetSetSha256: operationState().targetSetSha256,
    });

    deps.recall.rebuildOwnerRecall.mockResolvedValue({ status: 'failed', receiptSha256: HEX_B });
    await expect(
      service.reconcileRecall({
        operationId: OPERATION_ID,
        ownerId: OWNER_ID,
        targetSetSha256: operationState().targetSetSha256,
      }),
    ).rejects.toThrow('cleanup_recall_reconciliation_unverified');
  });

  test('does not rebuild recall before every reviewed message and conversation is tombstoned', async () => {
    const deps = dependencies();
    deps.repository.listOperationTombstones.mockResolvedValue([]);
    const service = createPersonalAccountCleanupService({ ...deps, now: () => NOW });

    await expect(
      service.reconcileRecall({
        operationId: OPERATION_ID,
        ownerId: OWNER_ID,
        targetSetSha256: operationState().targetSetSha256,
      }),
    ).rejects.toThrow('cleanup_tombstone_set_incomplete');
    expect(deps.recall.rebuildOwnerRecall).not.toHaveBeenCalled();
  });

  test('delayed nonce sweep fails early and then verifies every exact store', async () => {
    const deps = dependencies();
    const service = createPersonalAccountCleanupService({ ...deps, now: () => NOW });
    const request = {
      operationId: OPERATION_ID,
      ownerId: OWNER_ID,
      runNonce: 'qa-nonce-1',
      targetSetSha256: operationState().targetSetSha256,
    };

    await expect(service.runDelayedNonceSweep(request)).rejects.toThrow('cleanup_sweep_not_due');
    expect(deps.repository.verifySourceTombstones).not.toHaveBeenCalled();

    const dueState = operationState({ notBefore: '2026-08-25T15:59:59.000Z' });
    deps.repository.getOperationState.mockResolvedValue(dueState);
    await expect(service.runDelayedNonceSweep(request)).resolves.toEqual(
      expect.objectContaining({ status: 'verified', verifiedTargetCount: 4 }),
    );
    expect(deps.repository.verifySourceTombstones).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      operationId: OPERATION_ID,
      targets: dueState.targets.filter(
        (target) => target.kind === 'message' || target.kind === 'conversation',
      ),
      nonceHash: NONCE_HASH,
    });
    expect(deps.search.verifyAbsent).toHaveBeenCalled();
    expect(deps.recall.verifyOperation).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      operationId: OPERATION_ID,
      targetSetSha256: dueState.targetSetSha256,
      expectedReceiptSha256: HEX_B,
    });
    expect(deps.schedules.verifyOperation).toHaveBeenCalled();
    expect(deps.memories.verifyOperation).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      operationId: OPERATION_ID,
      targets: dueState.targets.filter((target) => target.kind === 'memory'),
      nonceHash: NONCE_HASH,
    });
    expect(deps.residue.verifyNonceAbsent).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      runNonce: 'qa-nonce-1',
    });
    expect(JSON.stringify(deps.repository.appendReceipt.mock.calls)).not.toContain('qa-nonce-1');
  });

  test('delayed sweep rejects wrong nonce, target set, or missing prior receipt', async () => {
    const deps = dependencies();
    deps.repository.getOperationState.mockResolvedValue(
      operationState({
        notBefore: '2026-08-25T15:59:59.000Z',
        searchReconciled: false,
      }),
    );
    const service = createPersonalAccountCleanupService({ ...deps, now: () => NOW });

    await expect(
      service.runDelayedNonceSweep({
        operationId: OPERATION_ID,
        ownerId: OWNER_ID,
        runNonce: 'wrong-nonce',
        targetSetSha256: operationState().targetSetSha256,
      }),
    ).rejects.toThrow('cleanup_sweep_nonce_mismatch');

    deps.repository.getOperationState.mockResolvedValue(
      operationState({ notBefore: '2026-08-25T15:59:59.000Z' }),
    );
    await expect(
      service.runDelayedNonceSweep({
        operationId: OPERATION_ID,
        ownerId: OWNER_ID,
        runNonce: 'qa-nonce-1',
        targetSetSha256: HEX_A,
      }),
    ).rejects.toThrow('cleanup_target_set_mismatch');
  });

  test('delayed sweep fails when the exact typed QA nonce still has an active message', async () => {
    const deps = dependencies();
    deps.repository.getOperationState.mockResolvedValue(
      operationState({ notBefore: '2026-08-25T15:59:59.000Z' }),
    );
    deps.residue.verifyNonceAbsent.mockResolvedValue({
      verified: false,
      activeMessageCount: 1,
    });
    const service = createPersonalAccountCleanupService({ ...deps, now: () => NOW });

    await expect(
      service.runDelayedNonceSweep({
        operationId: OPERATION_ID,
        ownerId: OWNER_ID,
        runNonce: 'qa-nonce-1',
        targetSetSha256: operationState().targetSetSha256,
      }),
    ).rejects.toThrow('cleanup_sweep_nonce_residue');
  });
});
