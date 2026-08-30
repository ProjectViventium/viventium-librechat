import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from '@librechat/data-schemas';
import { createMongoSyntheticQaResidueAdapter } from '../mongoSyntheticQaResidueAdapter';

const OWNER = '64b000000000000000000001';
const OTHER_OWNER = '64b000000000000000000002';

describe('Mongo typed synthetic-QA residue adapter', () => {
  let mongoServer: MongoMemoryServer;
  let models: ReturnType<typeof createModels>;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    models = createModels(mongoose);
    await models.Message.init();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await models.Message.collection.deleteMany({});
  });

  test('finds only active exact-owner messages with the exact typed QA nonce', async () => {
    await models.Message.create([
      {
        messageId: 'message-residue-1',
        conversationId: 'conversation-1',
        user: OWNER,
        text: 'synthetic fixture',
        isCreatedByUser: true,
        metadata: { viventium: { qaRun: true, qaRunId: 'qa-run-1' } },
      },
      {
        messageId: 'message-other-owner-1',
        conversationId: 'conversation-2',
        user: OTHER_OWNER,
        text: 'must not affect owner result',
        isCreatedByUser: true,
        metadata: { viventium: { qaRun: true, qaRunId: 'qa-run-1' } },
      },
      {
        messageId: 'message-adjacent-1',
        conversationId: 'conversation-3',
        user: OWNER,
        text: 'must not match a substring',
        isCreatedByUser: true,
        metadata: { viventium: { qaRun: true, qaRunId: 'qa-run-10' } },
      },
    ]);
    const adapter = createMongoSyntheticQaResidueAdapter(models.Message);

    await expect(
      adapter.verifyNonceAbsent({ ownerId: OWNER, runNonce: 'qa-run-1' }),
    ).resolves.toEqual({ verified: false, activeMessageCount: 1 });
    await expect(
      adapter.verifyNonceAbsent({ ownerId: OWNER, runNonce: 'qa-run-missing' }),
    ).resolves.toEqual({ verified: true, activeMessageCount: 0 });
  });

  test('retained tombstones are absent while untyped matching text is ignored', async () => {
    await models.Message.create([
      {
        messageId: 'message-tombstone-1',
        conversationId: 'conversation-1',
        user: OWNER,
        text: '',
        isCreatedByUser: true,
        deletedAt: new Date('2026-08-25T16:00:00.000Z'),
        metadata: { viventium: { qaRun: true, qaRunId: 'qa-run-1' } },
      },
      {
        messageId: 'message-untyped-1',
        conversationId: 'conversation-2',
        user: OWNER,
        text: 'qa-run-1 appears in ordinary text',
        isCreatedByUser: true,
      },
    ]);
    const adapter = createMongoSyntheticQaResidueAdapter(models.Message);

    await expect(
      adapter.verifyNonceAbsent({ ownerId: OWNER, runNonce: 'qa-run-1' }),
    ).resolves.toEqual({ verified: true, activeMessageCount: 0 });
  });

  test('rejects wildcard-like owner or nonce input', async () => {
    const adapter = createMongoSyntheticQaResidueAdapter(models.Message);

    await expect(adapter.verifyNonceAbsent({ ownerId: OWNER, runNonce: '*' })).rejects.toThrow(
      'cleanup_residue_nonce_invalid',
    );
    await expect(
      adapter.verifyNonceAbsent({ ownerId: 'all', runNonce: 'qa-run-1' }),
    ).rejects.toThrow('cleanup_residue_owner_invalid');
  });
});
