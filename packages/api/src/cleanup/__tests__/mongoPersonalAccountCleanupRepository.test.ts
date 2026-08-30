import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from '@librechat/data-schemas';
import { cleanupStateSha256, ownerScopeSha256 } from '../personalAccountCleanup';
import { createMongoPersonalAccountCleanupRepository } from '../mongoPersonalAccountCleanupRepository';
import type { CleanupLedgerAdapter, CleanupOperationState, CleanupReceiptInput } from '../types';

const OWNER = 'owner-cleanup-1';
const OTHER_OWNER = 'owner-cleanup-2';
const OPERATION = 'cleanup-operation-1';
const AT = '2026-08-25T16:00:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('Mongo personal-account cleanup repository', () => {
  let mongoServer: MongoMemoryServer;
  let models: ReturnType<typeof createModels>;
  let state: CleanupOperationState;
  let receipts: CleanupReceiptInput[];
  let ledger: CleanupLedgerAdapter;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    models = createModels(mongoose);
    await Promise.all([models.Message.init(), models.Conversation.init()]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      models.Message.collection.deleteMany({}),
      models.Conversation.collection.deleteMany({}),
    ]);
    receipts = [];
    state = {
      operationId: OPERATION,
      ownerScopeHash: ownerScopeSha256(OWNER),
      planSha256: HASH_A,
      backupReceiptSha256: HASH_B,
      reviewSetSha256: HASH_A,
      nonceHash: `sha256:${HASH_B}`,
      targetSetSha256: HASH_A,
      notBefore: '2026-08-25T16:15:00.000Z',
      backupVerified: true,
      searchReconciled: false,
      recallReconciled: false,
      targets: [
        {
          kind: 'message',
          resourceId: 'message-cleanup-1',
          expectedRevision: 0,
          expectedUpdatedAt: '2026-08-25T15:00:00.000Z',
          stateSha256: HASH_A,
          preimageSha256: HASH_A,
          reviewBindingSha256: HASH_B,
          runNonceHash: `sha256:${HASH_B}`,
        },
        {
          kind: 'conversation',
          resourceId: 'conversation-cleanup-1',
          expectedRevision: 0,
          expectedUpdatedAt: '2026-08-25T15:00:00.000Z',
          stateSha256: HASH_A,
          preimageSha256: HASH_A,
          reviewBindingSha256: HASH_B,
          runNonceHash: `sha256:${HASH_B}`,
        },
      ],
      targetReceipts: [],
    };
    ledger = {
      assertBackupVerified: jest.fn().mockResolvedValue(undefined),
      appendReceipt: jest.fn(async (receipt) => {
        receipts.push(receipt);
        return { receiptSha256: HASH_A };
      }),
      getOperationState: jest.fn(async () => state),
    };
  });

  test('CAS tombstones one exact message, scrubs private fields, and preserves other owners', async () => {
    await models.Message.create([
      {
        messageId: 'message-cleanup-1',
        conversationId: 'conversation-cleanup-1',
        user: OWNER,
        text: 'synthetic private fixture',
        summary: 'private summary',
        content: [{ type: 'text', text: 'private structured content' }],
        attachments: [{ name: 'private.txt' }],
        sender: 'private synthetic sender',
        model: 'private synthetic model',
        endpoint: 'private synthetic endpoint',
        parentMessageId: 'private-parent-id',
        finish_reason: 'private synthetic finish',
        feedback: { rating: 'thumbsDown', text: 'private feedback' },
        thread_id: 'private-thread-id',
        iconURL: 'https://private.invalid/icon.png',
        metadata: { viventium: { qaRun: true, qaRunId: 'qa-nonce-1' } },
        isCreatedByUser: true,
      },
      {
        messageId: 'message-preserved-1',
        conversationId: 'conversation-preserved-1',
        user: OTHER_OWNER,
        text: 'genuine preserved fixture',
        isCreatedByUser: true,
      },
    ]);
    const repository = createMongoPersonalAccountCleanupRepository({
      Message: models.Message,
      Conversation: models.Conversation,
      ledger,
    });
    const source = await repository.readActiveTarget('message', OWNER, 'message-cleanup-1');
    expect(source).not.toBeNull();

    const result = await repository.applyTombstone({
      source: source!,
      operationId: OPERATION,
      ownerScopeHash: ownerScopeSha256(OWNER),
      reviewBindingSha256: HASH_A,
      preimageSha256: cleanupStateSha256(source!),
      runNonceHash: `sha256:${HASH_B}`,
      tombstonedAt: AT,
    });

    expect(result).toEqual({ applied: true, revision: 1, tombstonedAt: AT });
    expect(
      await models.Message.findOne({ user: OWNER, messageId: 'message-cleanup-1' }),
    ).toBeNull();
    const retained = await models.Message.collection.findOne({
      user: OWNER,
      messageId: 'message-cleanup-1',
    });
    expect(retained).toEqual(
      expect.objectContaining({
        text: '',
        summary: '',
        content: [],
        files: [],
        attachments: [],
        deletedAt: new Date(AT),
        cleanupTombstone: expect.objectContaining({
          operationId: OPERATION,
          ownerScopeHash: ownerScopeSha256(OWNER),
        }),
      }),
    );
    expect(JSON.stringify(retained)).not.toMatch(
      /synthetic private fixture|private summary|private structured content|private\.txt|qa-nonce-1|private synthetic sender|private synthetic model|private synthetic endpoint|private-parent-id|private synthetic finish|private feedback|private-thread-id|private\.invalid/,
    );
    expect(
      await models.Message.findOne({ user: OTHER_OWNER, messageId: 'message-preserved-1' }).lean(),
    ).toEqual(expect.objectContaining({ text: 'genuine preserved fixture' }));
  });

  test('a stale source cannot overwrite a newer message revision', async () => {
    await models.Message.create({
      messageId: 'message-cleanup-1',
      conversationId: 'conversation-cleanup-1',
      user: OWNER,
      text: 'reviewed fixture',
      isCreatedByUser: true,
    });
    const repository = createMongoPersonalAccountCleanupRepository({
      Message: models.Message,
      Conversation: models.Conversation,
      ledger,
    });
    const source = await repository.readActiveTarget('message', OWNER, 'message-cleanup-1');
    await models.Message.findOneAndUpdate(
      { user: OWNER, messageId: 'message-cleanup-1' },
      { $set: { text: 'newer genuine edit' }, $inc: { __v: 1 } },
    );

    await expect(
      repository.applyTombstone({
        source: source!,
        operationId: OPERATION,
        ownerScopeHash: ownerScopeSha256(OWNER),
        reviewBindingSha256: HASH_A,
        preimageSha256: cleanupStateSha256(source!),
        runNonceHash: `sha256:${HASH_B}`,
        tombstonedAt: AT,
      }),
    ).resolves.toEqual({ applied: false, revision: 1, tombstonedAt: AT });
    expect(
      await models.Message.findOne({ user: OWNER, messageId: 'message-cleanup-1' }).lean(),
    ).toEqual(expect.objectContaining({ text: 'newer genuine edit' }));
  });

  test('conversation tombstone scrubs private configuration only after children are gone', async () => {
    await models.Conversation.create({
      conversationId: 'conversation-cleanup-1',
      user: OWNER,
      endpoint: 'agents',
      title: 'synthetic private title',
      system: 'private system text',
      instructions: 'private instructions',
      examples: [{ input: 'private example' }],
      modelLabel: 'private model label',
      promptPrefix: 'private prompt prefix',
      greeting: 'private greeting',
      spec: 'private specification',
      stop: ['private stop'],
      tools: ['private tool'],
      tags: ['qa'],
      files: ['private-file-id'],
    });
    const repository = createMongoPersonalAccountCleanupRepository({
      Message: models.Message,
      Conversation: models.Conversation,
      ledger,
    });
    const source = await repository.readActiveTarget(
      'conversation',
      OWNER,
      'conversation-cleanup-1',
    );
    const result = await repository.applyTombstone({
      source: source!,
      operationId: OPERATION,
      ownerScopeHash: ownerScopeSha256(OWNER),
      reviewBindingSha256: HASH_A,
      preimageSha256: cleanupStateSha256(source!),
      runNonceHash: `sha256:${HASH_B}`,
      tombstonedAt: AT,
    });

    expect(result.applied).toBe(true);
    const retained = await models.Conversation.collection.findOne({
      user: OWNER,
      conversationId: 'conversation-cleanup-1',
    });
    expect(retained).toEqual(
      expect.objectContaining({
        title: '',
        messages: [],
        files: [],
        tags: [],
        deletedAt: new Date(AT),
      }),
    );
    expect(JSON.stringify(retained)).not.toMatch(
      /synthetic private title|private system text|private instructions|private-file-id|private example|private model label|private prompt prefix|private greeting|private specification|private stop|private tool/,
    );
  });

  test('finds only an exact retained tombstone and verifies exact source targets', async () => {
    await models.Message.create({
      messageId: 'message-cleanup-1',
      conversationId: 'conversation-cleanup-1',
      user: OWNER,
      text: '',
      isCreatedByUser: true,
      deletedAt: new Date(AT),
      cleanupTombstone: {
        contractVersion: 1,
        operationId: OPERATION,
        ownerScopeHash: ownerScopeSha256(OWNER),
        reviewBindingSha256: HASH_A,
        preimageSha256: HASH_B,
        runNonceHash: `sha256:${HASH_B}`,
        tombstonedAt: new Date(AT),
      },
    });
    const repository = createMongoPersonalAccountCleanupRepository({
      Message: models.Message,
      Conversation: models.Conversation,
      ledger,
    });

    await expect(
      repository.readMatchingTombstone('message', OWNER, 'message-cleanup-1'),
    ).resolves.toEqual(expect.objectContaining({ operationId: OPERATION, preimageSha256: HASH_B }));
    await expect(
      repository.verifySourceTombstones({
        ownerId: OWNER,
        operationId: OPERATION,
        targets: [{ kind: 'message', resourceId: 'message-cleanup-1' }],
        nonceHash: `sha256:${HASH_B}`,
      }),
    ).resolves.toEqual({ verifiedCount: 1 });
    await expect(
      repository.verifySourceTombstones({
        ownerId: OTHER_OWNER,
        operationId: OPERATION,
        targets: [{ kind: 'message', resourceId: 'message-cleanup-1' }],
        nonceHash: `sha256:${HASH_B}`,
      }),
    ).rejects.toThrow('cleanup_sweep_source_residue');
  });

  test('delegates backup and receipt state to the durable ledger without raw content', async () => {
    const repository = createMongoPersonalAccountCleanupRepository({
      Message: models.Message,
      Conversation: models.Conversation,
      ledger,
    });
    const binding = {
      operationId: OPERATION,
      ownerId: OWNER,
      ownerScopeHash: ownerScopeSha256(OWNER),
      planSha256: HASH_A,
      backupReceiptSha256: HASH_B,
      reviewSetSha256: HASH_A,
      target: state.targets[0],
    };

    await repository.assertBackupVerified(binding);
    await repository.appendReceipt({
      operationId: OPERATION,
      ownerScopeHash: ownerScopeSha256(OWNER),
      stage: 'search_reconciled',
      at: AT,
      receiptSha256: HASH_A,
      count: 1,
    });

    expect(ledger.assertBackupVerified).toHaveBeenCalledWith(binding);
    expect(receipts).toHaveLength(1);
    expect(JSON.stringify(receipts)).not.toMatch(/synthetic|private|genuine/);
  });

  test('does not reinterpret schedule or memory targets as Mongo conversations', async () => {
    state.targets = [
      { ...state.targets[0], kind: 'schedule', resourceId: 'schedule-cleanup-1' },
      { ...state.targets[1], kind: 'memory', resourceId: 'synthetic_memory' },
    ];
    const repository = createMongoPersonalAccountCleanupRepository({
      Message: models.Message,
      Conversation: models.Conversation,
      ledger,
    });

    await expect(repository.listOperationTombstones(OWNER, OPERATION)).resolves.toEqual([]);
  });
});
