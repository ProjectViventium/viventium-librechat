import { createCleanupLedgerAdapter } from '../cleanupLedgerAdapter';
import {
  createExactMeiliCleanupAdapter,
  meiliCleanupDocumentId,
} from '../exactMeiliCleanupAdapter';
import { ownerScopeSha256, targetSetSha256 } from '../personalAccountCleanup';

const OWNER = 'owner-cleanup-1';
const OPERATION = 'cleanup-operation-1';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const TARGET = {
  kind: 'message' as const,
  resourceId: 'message-cleanup-1',
  expectedRevision: 2,
  expectedUpdatedAt: '2026-08-25T15:00:00.000Z',
  stateSha256: HASH_A,
  preimageSha256: HASH_A,
  reviewBindingSha256: HASH_B,
  runNonceHash: `sha256:${HASH_B}`,
};

describe('cleanup ledger adapter', () => {
  test('accepts only the exact verified owner and backup binding', async () => {
    const model = {
      readCleanupOperation: jest.fn().mockResolvedValue({
        operationId: OPERATION,
        ownerId: OWNER,
        ownerScopeHash: ownerScopeSha256(OWNER),
        planSha256: HASH_A,
        backupReceiptSha256: HASH_B,
        reviewSetSha256: HASH_A,
        backupVerified: true,
        targets: [TARGET],
      }),
      appendCleanupReceipt: jest.fn(),
    };
    const adapter = createCleanupLedgerAdapter(model);

    await expect(
      adapter.assertBackupVerified({
        operationId: OPERATION,
        ownerId: OWNER,
        ownerScopeHash: ownerScopeSha256(OWNER),
        planSha256: HASH_A,
        backupReceiptSha256: HASH_B,
        reviewSetSha256: HASH_A,
        target: TARGET,
      }),
    ).resolves.toBeUndefined();
    await expect(
      adapter.assertBackupVerified({
        operationId: OPERATION,
        ownerId: OWNER,
        ownerScopeHash: ownerScopeSha256(OWNER),
        planSha256: HASH_A,
        backupReceiptSha256: 'c'.repeat(64),
        reviewSetSha256: HASH_A,
        target: TARGET,
      }),
    ).rejects.toThrow('cleanup_backup_binding_mismatch');
    await expect(
      adapter.assertBackupVerified({
        operationId: OPERATION,
        ownerId: OWNER,
        ownerScopeHash: ownerScopeSha256(OWNER),
        planSha256: HASH_A,
        backupReceiptSha256: HASH_B,
        reviewSetSha256: HASH_A,
        target: { ...TARGET, stateSha256: 'c'.repeat(64), preimageSha256: 'c'.repeat(64) },
      }),
    ).rejects.toThrow('cleanup_reviewed_target_binding_mismatch');
  });

  test('delegates append and owner-scoped reads without widening identity', async () => {
    const operation = { operationId: OPERATION, ownerId: OWNER };
    const model = {
      readCleanupOperation: jest.fn().mockResolvedValue(operation),
      appendCleanupReceipt: jest.fn().mockResolvedValue({ receiptSha256: HASH_A }),
    };
    const adapter = createCleanupLedgerAdapter(model);
    await expect(adapter.getOperationState(OWNER, OPERATION)).resolves.toBe(operation);
    await expect(
      adapter.appendReceipt({
        operationId: OPERATION,
        ownerScopeHash: ownerScopeSha256(OWNER),
        stage: 'search_reconciled',
        at: '2026-08-25T16:00:00.000Z',
        targetSetSha256: HASH_A,
        receiptSha256: HASH_B,
      }),
    ).resolves.toEqual({ receiptSha256: HASH_A });
  });
});

describe('exact Meili cleanup adapter', () => {
  const targets = [
    { kind: 'conversation' as const, resourceId: 'conversation-cleanup-1' },
    { kind: 'message' as const, resourceId: 'message-cleanup-1' },
  ];

  function notFound(): Error & { code: string } {
    return Object.assign(new Error('not found'), { code: 'document_not_found' });
  }

  test('uses the shipped stable document encoding', () => {
    expect(meiliCleanupDocumentId('a-1')).toBe('m_0061002d0031');
  });

  test('deletes only exact owner-matched ids, waits, and verifies absence', async () => {
    const documents = new Map([
      [
        'convos:m_0063006f006e0076006500720073006100740069006f006e002d0063006c00650061006e00750070002d0031',
        { user: OWNER },
      ],
      [
        'messages:m_006d006500730073006100670065002d0063006c00650061006e00750070002d0031',
        { user: OWNER },
      ],
    ]);
    const makeIndex = (name: string) => ({
      getDocument: jest.fn(async (id: string) => {
        const key = `${name}:${id}`;
        if (!documents.has(key)) throw notFound();
        return documents.get(key);
      }),
      deleteDocuments: jest.fn(async (ids: string[]) => {
        ids.forEach((id) => documents.delete(`${name}:${id}`));
        return { taskUid: name === 'convos' ? 11 : 12 };
      }),
      waitForTask: jest.fn(async () => ({ status: 'succeeded' })),
    });
    const indexes = { convos: makeIndex('convos'), messages: makeIndex('messages') };
    const adapter = createExactMeiliCleanupAdapter({ index: (name) => indexes[name] });

    const result = await adapter.reconcileExact({ ownerId: OWNER, targets });

    expect(result).toEqual({
      status: 'verified',
      targetCount: 2,
      receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(indexes.convos.deleteDocuments).toHaveBeenCalledWith([
      meiliCleanupDocumentId('conversation-cleanup-1'),
    ]);
    expect(indexes.messages.deleteDocuments).toHaveBeenCalledWith([
      meiliCleanupDocumentId('message-cleanup-1'),
    ]);
    await expect(adapter.verifyAbsent({ ownerId: OWNER, targets })).resolves.toEqual({
      verifiedCount: 2,
    });
  });

  test('fails before deletion when an exact id belongs to another owner', async () => {
    const index = {
      getDocument: jest.fn().mockResolvedValue({ user: 'different-owner' }),
      deleteDocuments: jest.fn(),
      waitForTask: jest.fn(),
    };
    const adapter = createExactMeiliCleanupAdapter({ index: () => index });

    await expect(adapter.reconcileExact({ ownerId: OWNER, targets: [targets[1]] })).rejects.toThrow(
      'cleanup_search_owner_mismatch',
    );
    expect(index.deleteDocuments).not.toHaveBeenCalled();
  });

  test('fails closed on a failed task or surviving document', async () => {
    const index = {
      getDocument: jest
        .fn()
        .mockResolvedValueOnce({ user: OWNER })
        .mockResolvedValueOnce({ user: OWNER })
        .mockResolvedValueOnce({ user: OWNER }),
      deleteDocuments: jest.fn().mockResolvedValue({ taskUid: 7 }),
      waitForTask: jest.fn().mockResolvedValue({ status: 'failed' }),
    };
    const adapter = createExactMeiliCleanupAdapter({ index: () => index });
    await expect(adapter.reconcileExact({ ownerId: OWNER, targets: [targets[1]] })).rejects.toThrow(
      'cleanup_search_task_failed',
    );

    index.waitForTask.mockResolvedValue({ status: 'succeeded' });
    await expect(adapter.reconcileExact({ ownerId: OWNER, targets: [targets[1]] })).rejects.toThrow(
      'cleanup_search_residue',
    );
  });

  test('rejects schedules and duplicate targets instead of widening scope', async () => {
    const adapter = createExactMeiliCleanupAdapter({ index: jest.fn() });
    await expect(
      adapter.reconcileExact({
        ownerId: OWNER,
        targets: [{ kind: 'schedule', resourceId: 'schedule-1' }],
      }),
    ).rejects.toThrow('cleanup_search_target_kind_invalid');
    await expect(
      adapter.reconcileExact({ ownerId: OWNER, targets: [targets[1], targets[1]] }),
    ).rejects.toThrow('cleanup_search_target_duplicate');
    expect(targetSetSha256(targets)).toMatch(/^[a-f0-9]{64}$/);
  });
});
