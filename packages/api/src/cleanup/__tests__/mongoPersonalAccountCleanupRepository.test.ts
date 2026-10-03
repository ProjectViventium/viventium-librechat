import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
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
  let mongoServer: MongoMemoryReplSet;
  let models: ReturnType<typeof createModels>;
  let methods: ReturnType<typeof createMethods>;
  let mutateMessageSources: jest.MockedFunction<
    Parameters<typeof createMongoPersonalAccountCleanupRepository>[0]['mutateMessageSources']
  >;
  let state: CleanupOperationState;
  let receipts: CleanupReceiptInput[];
  let ledger: CleanupLedgerAdapter;

  beforeAll(async () => {
    mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongoServer.getUri());
    mongoose.set('transactionAsyncLocalStorage', true);
    models = createModels(mongoose);
    methods = createMethods(mongoose);
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
    mutateMessageSources = jest.fn(async (_filter, mutate) => mutate());
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
      mutateMessageSources,
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
    expect(mutateMessageSources).toHaveBeenCalledWith(
      {
        user: OWNER,
        messageId: source!.resourceId,
        deletedAt: null,
        updatedAt: new Date(source!.updatedAt),
        $or: [{ __v: 0 }, { __v: { $exists: false } }],
      },
      expect.any(Function),
      'delete',
    );
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
      mutateMessageSources,
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

  test.each(['current', 'stale'] as const)(
    'native assistant cleanup keeps reviewed source CAS intact when %s',
    async (sourceState) => {
      await models.Message.create([
        {
          messageId: 'native-parent',
          conversationId: 'conversation-cleanup-1',
          user: OWNER,
          text: 'synthetic request',
          isCreatedByUser: true,
        },
        {
          messageId: 'native-answer',
          conversationId: 'conversation-cleanup-1',
          user: OWNER,
          parentMessageId: 'native-parent',
          text: 'synthetic answer',
          isCreatedByUser: false,
          unfinished: true,
        },
      ]);
      const transaction = <T>(operation: () => Promise<T>) =>
        mongoose.connection.transaction(operation);
      const identity = {
        userId: OWNER,
        conversationId: 'conversation-cleanup-1',
        responseMessageId: 'native-answer',
        streamId: 'cleanup-stream',
        jobCreatedAt: 1,
        logicalTurnId: 'cleanup-logical-turn',
        revision: 1,
        invocationId: 'cleanup-invocation',
        bodySha256: HASH_A,
        providerId: 'synthetic-provider',
        agentId: 'synthetic-agent',
        originSha256: HASH_B,
        source: await methods.captureNativeResponseSource(
          OWNER,
          'conversation-cleanup-1',
          'native-parent',
        ),
        admittedAt: Date.now(),
        recoverUntil: Date.now() + 86_400_000,
      };
      await methods.admitNativeResponse(identity, transaction);
      await models.Message.collection.updateOne(
        { user: OWNER, messageId: 'native-answer' },
        { $set: { updatedAt: new Date('2026-08-25T15:00:00.000Z') } },
      );
      const retire = jest.fn(async () => undefined);
      const revoke = jest.fn(async () => ({ status: 'revoked' as const }));
      mutateMessageSources.mockImplementation((filter, mutate, kind) =>
        methods.mutateNativeResponseSources(filter, mutate, revoke, transaction, retire, kind),
      );
      const repository = createMongoPersonalAccountCleanupRepository({
        Message: models.Message,
        Conversation: models.Conversation,
        ledger,
        mutateMessageSources,
      });
      const source = await repository.readActiveTarget('message', OWNER, 'native-answer');
      if (sourceState === 'stale') {
        await models.Message.updateOne(
          { user: OWNER, messageId: 'native-answer' },
          { $set: { text: 'newer genuine correction' } },
        );
      }
      const before = await models.Message.collection.findOne({
        user: OWNER,
        messageId: 'native-answer',
      });
      const result = await repository.applyTombstone({
        source: source!,
        operationId: OPERATION,
        ownerScopeHash: ownerScopeSha256(OWNER),
        reviewBindingSha256: HASH_A,
        preimageSha256: cleanupStateSha256(source!),
        runNonceHash: `sha256:${HASH_B}`,
        tombstonedAt: AT,
      });
      if (sourceState === 'current') {
        expect(result).toEqual({ applied: true, revision: 1, tombstonedAt: AT });
        expect(retire).toHaveBeenCalledWith(
          expect.objectContaining({ invocationId: 'cleanup-invocation' }),
        );
        expect(await repository.readActiveTarget('message', OWNER, 'native-answer')).toBeNull();
      } else {
        expect(result).toEqual({ applied: false, revision: 0, tombstonedAt: AT });
        expect(retire).not.toHaveBeenCalled();
        expect(revoke).not.toHaveBeenCalled();
        expect(
          await models.Message.collection.findOne({ user: OWNER, messageId: 'native-answer' }),
        ).toEqual(before);
      }
    },
  );

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
      mutateMessageSources,
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
    expect(mutateMessageSources).not.toHaveBeenCalled();
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
      mutateMessageSources,
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
      mutateMessageSources,
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
      mutateMessageSources,
    });

    await expect(repository.listOperationTombstones(OWNER, OPERATION)).resolves.toEqual([]);
  });
});
