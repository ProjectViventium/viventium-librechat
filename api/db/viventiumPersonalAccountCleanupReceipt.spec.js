const crypto = require('crypto');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const createViventiumPersonalAccountCleanupReceipt = require('./viventiumPersonalAccountCleanupReceipt');

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      }, {});
  }
  return value;
};
const sha = (value) =>
  crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(canonicalize(value)))
    .digest('hex');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const OWNER_ID = 'owner-cleanup-1';
const OPERATION_ID = 'cleanup-operation-1';
const TARGETS = [
  { kind: 'message', resourceId: 'message-cleanup-1' },
  { kind: 'memory', resourceId: 'synthetic_memory' },
  { kind: 'schedule', resourceId: 'schedule-cleanup-1' },
].map((target, index) => ({
  ...target,
  expectedRevision: index,
  expectedUpdatedAt: `2026-08-25T15:00:0${index}.000Z`,
  stateSha256: HASH_A,
  preimageSha256: HASH_A,
  reviewBindingSha256: HASH_B,
  runNonceHash: `sha256:${HASH_B}`,
}));
const REVIEW_SET_SHA = sha(
  TARGETS.map((target) => ({
    kind: target.kind,
    resourceIdHash: `sha256:${sha(target.resourceId)}`,
    stateSha256: target.stateSha256,
    reviewBindingSha256: target.reviewBindingSha256,
  })).sort((left, right) => {
    const leftKey = `${left.kind}\u0000${left.resourceIdHash}`;
    const rightKey = `${right.kind}\u0000${right.resourceIdHash}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  }),
);
const RECOVERY_RECEIPT_BASE = {
  contractVersion: 1,
  backupId: 'backup-20260825T160000Z-0123456789ab',
  ownerScopeHash: `sha256:${sha(OWNER_ID)}`,
  reviewSetSha256: REVIEW_SET_SHA,
  manifestSha256: HASH_A,
  artifactSetSha256: HASH_B,
  restoreVerification: 'verified',
  status: 'verified',
  createdAt: '2026-08-25T16:00:00.000Z',
};
const RECOVERY_RECEIPT = {
  ...RECOVERY_RECEIPT_BASE,
  receiptSha256: sha(RECOVERY_RECEIPT_BASE),
};
const BACKUP_AUTHORITY = {
  contractVersion: 1,
  authorityId: 'cleanup-authority-1',
  purpose: 'reviewed_personal_account_synthetic_qa_cleanup',
  reviewedCleanupApproved: true,
  proof: 'ed25519:synthetic-fixture',
};
const targetReceiptHash = (target) =>
  `sha256:${sha({ ownerId: OWNER_ID, kind: target.kind, resourceId: target.resourceId })}`;
const TARGET_SET_SHA = sha(
  JSON.stringify(
    TARGETS.map(({ kind, resourceId }) => ({ kind, resourceId })).sort((left, right) => {
      const leftKey = `${left.kind}\u0000${left.resourceId}`;
      const rightKey = `${right.kind}\u0000${right.resourceId}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  ),
);

function registration(overrides = {}) {
  return {
    operationId: OPERATION_ID,
    ownerId: OWNER_ID,
    ownerScopeHash: `sha256:${sha(OWNER_ID)}`,
    planSha256: HASH_A,
    backupReceiptSha256: RECOVERY_RECEIPT.receiptSha256,
    reviewSetSha256: REVIEW_SET_SHA,
    recoveryReceipt: RECOVERY_RECEIPT,
    backupAuthority: BACKUP_AUTHORITY,
    nonceHash: `sha256:${HASH_B}`,
    targetSetSha256: TARGET_SET_SHA,
    notBefore: new Date('2026-08-25T16:15:00.000Z'),
    targets: TARGETS,
    at: new Date('2026-08-25T16:00:00.000Z'),
    ...overrides,
  };
}

async function appendTargetReceipt(Receipt, target, at = '2026-08-25T16:01:00.000Z') {
  return Receipt.appendCleanupReceipt({
    operationId: OPERATION_ID,
    ownerScopeHash: `sha256:${sha(OWNER_ID)}`,
    stage: 'target_tombstoned',
    at: new Date(at),
    targetKind: target.kind,
    targetHash: targetReceiptHash(target),
    revision: target.expectedRevision + 1,
    count: 1,
  });
}

describe('ViventiumPersonalAccountCleanupReceipt', () => {
  let mongoServer;
  let database;
  let Receipt;
  let verifyRecoveryReceipt;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    database = new mongoose.Mongoose();
    await database.connect(mongoServer.getUri());
    verifyRecoveryReceipt = jest.fn().mockResolvedValue({
      verified: true,
      authorityId: 'cleanup-authority-1',
      authoritySha256: HASH_A,
      expiresAt: '2026-08-25T17:00:00.000Z',
    });
    Receipt = createViventiumPersonalAccountCleanupReceipt(database, {
      verifyRecoveryReceipt,
    });
    await Receipt.syncIndexes();
  });

  afterAll(async () => {
    await database.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Receipt.collection.deleteMany({});
    verifyRecoveryReceipt.mockReset().mockResolvedValue({
      verified: true,
      authorityId: 'cleanup-authority-1',
      authoritySha256: HASH_A,
      expiresAt: '2026-08-25T17:00:00.000Z',
    });
  });

  test('registers one owner-bound backup and never stores content fields', async () => {
    const result = await Receipt.registerVerifiedBackupOperation(registration());

    expect(result).toEqual(
      expect.objectContaining({
        operationId: OPERATION_ID,
        ownerId: OWNER_ID,
        backupVerified: true,
        searchReconciled: false,
        recallReconciled: false,
        authorityId: 'cleanup-authority-1',
        executionStatus: 'ready',
      }),
    );
    const stored = await Receipt.collection.findOne({ operationId: OPERATION_ID });
    expect(verifyRecoveryReceipt).toHaveBeenCalledTimes(1);
    expect(stored.targets[0]).toEqual(
      expect.objectContaining({
        expectedRevision: expect.any(Number),
        expectedUpdatedAt: expect.any(Date),
        stateSha256: HASH_A,
        preimageSha256: HASH_A,
        reviewBindingSha256: HASH_B,
        runNonceHash: `sha256:${HASH_B}`,
      }),
    );
    expect(stored.events).toHaveLength(1);
    expect(stored.events[0]).toEqual(
      expect.objectContaining({
        sequence: 1,
        stage: 'backup_verified',
        previousEventHash: `sha256:${'0'.repeat(64)}`,
        eventHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }),
    );
    for (const field of ['text', 'title', 'prompt', 'content', 'preimage', 'email', 'path']) {
      expect(Receipt.schema.path(field)).toBeUndefined();
      expect(JSON.stringify(stored)).not.toContain(`"${field}"`);
    }
  });

  test('same registration is idempotent but conflicting binding fails closed', async () => {
    await Receipt.registerVerifiedBackupOperation(registration());
    await expect(Receipt.registerVerifiedBackupOperation(registration())).resolves.toEqual(
      expect.objectContaining({ operationId: OPERATION_ID, backupVerified: true }),
    );
    await expect(
      Receipt.registerVerifiedBackupOperation(registration({ planSha256: 'c'.repeat(64) })),
    ).rejects.toThrow('cleanup_operation_binding_conflict');
    expect(await Receipt.countDocuments({ operationId: OPERATION_ID })).toBe(1);
  });

  test('rejects a substituted target binding and an unverified recovery receipt', async () => {
    await expect(
      Receipt.registerVerifiedBackupOperation(
        registration({
          targets: TARGETS.map((target, index) =>
            index === 0 ? { ...target, stateSha256: HASH_B, preimageSha256: HASH_B } : target,
          ),
        }),
      ),
    ).rejects.toThrow('cleanup_review_set_mismatch');

    verifyRecoveryReceipt.mockResolvedValueOnce(false);
    await expect(Receipt.registerVerifiedBackupOperation(registration())).rejects.toThrow(
      'cleanup_backup_external_verification_rejected',
    );
    expect(await Receipt.countDocuments({ operationId: OPERATION_ID })).toBe(0);
  });

  test('cannot register when no trusted recovery verifier is wired', async () => {
    const isolated = new mongoose.Mongoose();
    await isolated.connect(mongoServer.getUri(), { dbName: 'cleanup-no-verifier' });
    const UnverifiedReceipt = createViventiumPersonalAccountCleanupReceipt(isolated);

    await expect(UnverifiedReceipt.registerVerifiedBackupOperation(registration())).rejects.toThrow(
      'cleanup_backup_external_verifier_unavailable',
    );
    expect(await UnverifiedReceipt.collection.countDocuments({})).toBe(0);
    await isolated.disconnect();
  });

  test('rejects missing authority even when a verifier is wired', async () => {
    await expect(
      Receipt.registerVerifiedBackupOperation(registration({ backupAuthority: undefined })),
    ).rejects.toThrow('cleanup_backup_authority_missing');
    expect(verifyRecoveryReceipt).not.toHaveBeenCalled();
  });

  test('claims once, records partial failure, recovers, and rejects completed replay', async () => {
    await Receipt.registerVerifiedBackupOperation(registration());
    const first = await Receipt.claimCleanupExecution({
      ownerId: OWNER_ID,
      operationId: OPERATION_ID,
      attemptId: 'cleanup-attempt-1',
      at: '2026-08-25T16:00:01.000Z',
      leaseMs: 30_000,
    });
    expect(first).toEqual(
      expect.objectContaining({ status: 'claimed', leaseToken: expect.any(String) }),
    );
    await expect(
      Receipt.claimCleanupExecution({
        ownerId: OWNER_ID,
        operationId: OPERATION_ID,
        attemptId: 'cleanup-attempt-concurrent',
        at: '2026-08-25T16:00:02.000Z',
        leaseMs: 30_000,
      }),
    ).rejects.toThrow('cleanup_execution_in_progress');

    await Receipt.failCleanupExecution({
      ownerId: OWNER_ID,
      operationId: OPERATION_ID,
      attemptId: 'cleanup-attempt-1',
      leaseToken: first.leaseToken,
      errorCode: 'cleanup_target_cas_conflict',
      at: '2026-08-25T16:00:03.000Z',
    });
    const recovered = await Receipt.claimCleanupExecution({
      ownerId: OWNER_ID,
      operationId: OPERATION_ID,
      attemptId: 'cleanup-attempt-2',
      at: '2026-08-25T16:00:04.000Z',
      leaseMs: 30_000,
    });
    expect(recovered.status).toBe('recovered');

    for (let index = 0; index < TARGETS.length; index += 1) {
      await appendTargetReceipt(Receipt, TARGETS[index], `2026-08-25T16:01:0${index}.000Z`);
    }
    await Receipt.appendCleanupReceipt({
      operationId: OPERATION_ID,
      ownerScopeHash: `sha256:${sha(OWNER_ID)}`,
      stage: 'search_reconciled',
      at: new Date('2026-08-25T16:02:00.000Z'),
      targetSetSha256: TARGET_SET_SHA,
      receiptSha256: HASH_A,
      count: 1,
    });
    await Receipt.appendCleanupReceipt({
      operationId: OPERATION_ID,
      ownerScopeHash: `sha256:${sha(OWNER_ID)}`,
      stage: 'recall_reconciled',
      at: new Date('2026-08-25T16:03:00.000Z'),
      targetSetSha256: TARGET_SET_SHA,
      receiptSha256: HASH_B,
      count: 1,
    });
    const completed = await Receipt.completeCleanupExecution({
      ownerId: OWNER_ID,
      operationId: OPERATION_ID,
      attemptId: 'cleanup-attempt-2',
      leaseToken: recovered.leaseToken,
      at: '2026-08-25T16:03:01.000Z',
    });
    expect(completed.executionStatus).toBe('completed');
    await expect(
      Receipt.claimCleanupExecution({
        ownerId: OWNER_ID,
        operationId: OPERATION_ID,
        attemptId: 'cleanup-attempt-3',
        at: '2026-08-25T16:03:02.000Z',
        leaseMs: 30_000,
      }),
    ).rejects.toThrow('cleanup_authorization_replayed');
  });

  test('rejects reconciliation or sweep evidence before its exact prerequisites', async () => {
    await Receipt.registerVerifiedBackupOperation(registration());
    const ownerScopeHash = `sha256:${sha(OWNER_ID)}`;

    await expect(
      Receipt.appendCleanupReceipt({
        operationId: OPERATION_ID,
        ownerScopeHash,
        stage: 'search_reconciled',
        at: new Date('2026-08-25T16:02:00.000Z'),
        targetSetSha256: TARGET_SET_SHA,
        receiptSha256: HASH_A,
        count: 1,
      }),
    ).rejects.toThrow('cleanup_reconciliation_prerequisite_missing');
    await expect(
      Receipt.appendCleanupReceipt({
        operationId: OPERATION_ID,
        ownerScopeHash,
        stage: 'delayed_nonce_sweep_verified',
        at: new Date('2026-08-25T16:16:00.000Z'),
        targetSetSha256: TARGET_SET_SHA,
        count: TARGETS.length,
      }),
    ).rejects.toThrow('cleanup_sweep_prerequisite_missing');
  });

  test('appends a monotonic hash chain and derives reconciliation state', async () => {
    await Receipt.registerVerifiedBackupOperation(registration());
    await Receipt.appendCleanupReceipt({
      operationId: OPERATION_ID,
      ownerScopeHash: `sha256:${sha(OWNER_ID)}`,
      stage: 'target_tombstoned',
      at: new Date('2026-08-25T16:01:00.000Z'),
      targetKind: 'message',
      targetHash: targetReceiptHash(TARGETS[0]),
      revision: TARGETS[0].expectedRevision + 1,
      count: 1,
    });
    await Receipt.appendCleanupReceipt({
      operationId: OPERATION_ID,
      ownerScopeHash: `sha256:${sha(OWNER_ID)}`,
      stage: 'target_tombstoned',
      at: new Date('2026-08-25T16:01:01.000Z'),
      targetKind: 'memory',
      targetHash: targetReceiptHash(TARGETS[1]),
      revision: TARGETS[1].expectedRevision + 1,
      count: 1,
    });
    await Receipt.appendCleanupReceipt({
      operationId: OPERATION_ID,
      ownerScopeHash: `sha256:${sha(OWNER_ID)}`,
      stage: 'target_tombstoned',
      at: new Date('2026-08-25T16:01:02.000Z'),
      targetKind: 'schedule',
      targetHash: targetReceiptHash(TARGETS[2]),
      revision: TARGETS[2].expectedRevision + 1,
      count: 1,
    });
    await Receipt.appendCleanupReceipt({
      operationId: OPERATION_ID,
      ownerScopeHash: `sha256:${sha(OWNER_ID)}`,
      stage: 'search_reconciled',
      at: new Date('2026-08-25T16:02:00.000Z'),
      targetSetSha256: TARGET_SET_SHA,
      receiptSha256: HASH_A,
      count: 1,
    });
    await Receipt.appendCleanupReceipt({
      operationId: OPERATION_ID,
      ownerScopeHash: `sha256:${sha(OWNER_ID)}`,
      stage: 'recall_reconciled',
      at: new Date('2026-08-25T16:03:00.000Z'),
      targetSetSha256: TARGET_SET_SHA,
      receiptSha256: HASH_B,
      count: 1,
    });

    const operation = await Receipt.readCleanupOperation(OWNER_ID, OPERATION_ID);
    expect(operation).toEqual(
      expect.objectContaining({
        backupVerified: true,
        searchReconciled: true,
        recallReconciled: true,
        searchReceiptSha256: HASH_A,
        recallReceiptSha256: HASH_B,
      }),
    );
    const stored = await Receipt.collection.findOne({ operationId: OPERATION_ID });
    expect(stored.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    for (let index = 1; index < stored.events.length; index += 1) {
      expect(stored.events[index].previousEventHash).toBe(stored.events[index - 1].eventHash);
    }
    expect(Receipt.verifyCleanupHashChain(stored)).toBe(true);
  });

  test('idempotent event key cannot be replayed with different facts', async () => {
    await Receipt.registerVerifiedBackupOperation(registration());
    await appendTargetReceipt(Receipt, TARGETS[0]);
    const event = {
      operationId: OPERATION_ID,
      ownerScopeHash: `sha256:${sha(OWNER_ID)}`,
      stage: 'search_reconciled',
      at: new Date('2026-08-25T16:02:00.000Z'),
      targetSetSha256: TARGET_SET_SHA,
      receiptSha256: HASH_A,
      count: 1,
    };
    const first = await Receipt.appendCleanupReceipt(event);
    const replay = await Receipt.appendCleanupReceipt({
      ...event,
      at: new Date('2026-08-25T16:03:00.000Z'),
    });
    expect(replay.receiptSha256).toBe(first.receiptSha256);
    await expect(Receipt.appendCleanupReceipt({ ...event, count: 2 })).rejects.toThrow(
      'cleanup_receipt_event_conflict',
    );
  });

  test('accepts a newer reconciliation receipt while preserving the hash chain', async () => {
    await Receipt.registerVerifiedBackupOperation(registration());
    await appendTargetReceipt(Receipt, TARGETS[0]);
    const base = {
      operationId: OPERATION_ID,
      ownerScopeHash: `sha256:${sha(OWNER_ID)}`,
      stage: 'search_reconciled',
      targetSetSha256: TARGET_SET_SHA,
      count: 1,
    };
    await Receipt.appendCleanupReceipt({
      ...base,
      at: new Date('2026-08-25T16:02:00.000Z'),
      receiptSha256: HASH_A,
    });
    await Receipt.appendCleanupReceipt({
      ...base,
      at: new Date('2026-08-25T16:04:00.000Z'),
      receiptSha256: HASH_B,
    });

    const operation = await Receipt.readCleanupOperation(OWNER_ID, OPERATION_ID);
    expect(operation.searchReceiptSha256).toBe(HASH_B);
    const stored = await Receipt.collection.findOne({ operationId: OPERATION_ID });
    expect(stored.events.filter((event) => event.stage === 'search_reconciled')).toHaveLength(2);
    expect(Receipt.verifyCleanupHashChain(stored)).toBe(true);
  });

  test('rejects receipts for an unregistered target, wrong revision, or target set', async () => {
    await Receipt.registerVerifiedBackupOperation(registration());
    const targetEvent = {
      operationId: OPERATION_ID,
      ownerScopeHash: `sha256:${sha(OWNER_ID)}`,
      stage: 'target_tombstoned',
      at: new Date('2026-08-25T16:01:00.000Z'),
      targetKind: 'message',
      targetHash: targetReceiptHash(TARGETS[0]),
      revision: TARGETS[0].expectedRevision + 1,
      count: 1,
    };
    await expect(
      Receipt.appendCleanupReceipt({ ...targetEvent, targetHash: `sha256:${HASH_A}` }),
    ).rejects.toThrow('cleanup_target_receipt_binding_mismatch');
    await expect(
      Receipt.appendCleanupReceipt({ ...targetEvent, revision: targetEvent.revision + 1 }),
    ).rejects.toThrow('cleanup_target_receipt_binding_mismatch');
    await expect(
      Receipt.appendCleanupReceipt({
        operationId: OPERATION_ID,
        ownerScopeHash: `sha256:${sha(OWNER_ID)}`,
        stage: 'recall_reconciled',
        at: new Date('2026-08-25T16:02:00.000Z'),
        targetSetSha256: HASH_A,
        receiptSha256: HASH_B,
        count: TARGETS.length,
      }),
    ).rejects.toThrow('cleanup_receipt_target_set_mismatch');
  });

  test('wrong owner scope, direct mutation, and deletion fail closed', async () => {
    await Receipt.registerVerifiedBackupOperation(registration());
    await expect(
      Receipt.appendCleanupReceipt({
        operationId: OPERATION_ID,
        ownerScopeHash: `sha256:${HASH_A}`,
        stage: 'search_reconciled',
        at: new Date('2026-08-25T16:02:00.000Z'),
        targetSetSha256: TARGET_SET_SHA,
        receiptSha256: HASH_A,
        count: 1,
      }),
    ).rejects.toThrow('cleanup_operation_not_found');
    await expect(
      Receipt.updateOne({ operationId: OPERATION_ID }, { $set: { planSha256: HASH_B } }),
    ).rejects.toThrow('cleanup_receipt_append_only');
    await expect(Receipt.deleteOne({ operationId: OPERATION_ID })).rejects.toThrow(
      'cleanup_receipt_append_only',
    );
  });

  test('independent tampering invalidates the stored hash chain', async () => {
    await Receipt.registerVerifiedBackupOperation(registration());
    await appendTargetReceipt(Receipt, TARGETS[0]);
    await Receipt.appendCleanupReceipt({
      operationId: OPERATION_ID,
      ownerScopeHash: `sha256:${sha(OWNER_ID)}`,
      stage: 'search_reconciled',
      at: new Date('2026-08-25T16:02:00.000Z'),
      targetSetSha256: TARGET_SET_SHA,
      receiptSha256: HASH_A,
      count: 1,
    });
    await Receipt.collection.updateOne(
      { operationId: OPERATION_ID, 'events.sequence': 2 },
      { $set: { 'events.$.count': 9 } },
    );
    const tampered = await Receipt.collection.findOne({ operationId: OPERATION_ID });

    expect(Receipt.verifyCleanupHashChain(tampered)).toBe(false);
    await expect(Receipt.readCleanupOperation(OWNER_ID, OPERATION_ID)).rejects.toThrow(
      'cleanup_receipt_hash_chain_invalid',
    );
  });
});
