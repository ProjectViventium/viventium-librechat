import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from '~/models';
import { addCleanupVisibilityToAggregate } from './personalAccountCleanupTombstone';

const OWNER = 'owner-cleanup-1';
const OTHER_OWNER = 'owner-cleanup-2';
const TOMBSTONE = {
  contractVersion: 1,
  operationId: 'cleanup-operation-1',
  ownerScopeHash: `sha256:${'a'.repeat(64)}`,
  reviewBindingSha256: 'b'.repeat(64),
  preimageSha256: 'c'.repeat(64),
  runNonceHash: `sha256:${'d'.repeat(64)}`,
  tombstonedAt: new Date('2026-08-25T16:00:00.000Z'),
};

describe('personal-account cleanup tombstones', () => {
  let mongoServer: MongoMemoryServer;
  let Message: ReturnType<typeof createModels>['Message'];
  let Conversation: ReturnType<typeof createModels>['Conversation'];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    const models = createModels(mongoose);
    Message = models.Message;
    Conversation = models.Conversation;
    await Promise.all([Message.init(), Conversation.init()]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([Message.collection.deleteMany({}), Conversation.collection.deleteMany({})]);
  });

  test('ordinary message reads hide a retained sanitized tombstone', async () => {
    await Message.create({
      messageId: 'message-cleanup-1',
      conversationId: 'conversation-cleanup-1',
      user: OWNER,
      text: 'synthetic private fixture',
      isCreatedByUser: true,
    });
    await Message.findOneAndUpdate(
      { user: OWNER, messageId: 'message-cleanup-1', deletedAt: null },
      {
        $set: {
          text: '',
          content: [],
          files: [],
          attachments: [],
          metadata: { viventium: { cleanupTombstone: true, memoryEligible: false } },
          deletedAt: TOMBSTONE.tombstonedAt,
          cleanupTombstone: TOMBSTONE,
        },
        $inc: { __v: 1 },
      },
      { new: true },
    );

    expect(
      await Message.findOne({ user: OWNER, messageId: 'message-cleanup-1' }).lean(),
    ).toBeNull();
    expect(await Message.find({ user: OWNER }).lean()).toEqual([]);
    expect(await Message.countDocuments({ user: OWNER })).toBe(0);

    const retained = await Message.collection.findOne({
      user: OWNER,
      messageId: 'message-cleanup-1',
    });
    expect(retained).toEqual(
      expect.objectContaining({
        text: '',
        deletedAt: TOMBSTONE.tombstonedAt,
        cleanupTombstone: expect.objectContaining({ operationId: 'cleanup-operation-1' }),
      }),
    );
    expect(JSON.stringify(retained)).not.toContain('synthetic private fixture');
  });

  test('ordinary conversation reads hide only the exact owner tombstone', async () => {
    await Conversation.create([
      {
        conversationId: 'conversation-cleanup-1',
        user: OWNER,
        endpoint: 'agents',
        title: 'synthetic private fixture',
      },
      {
        conversationId: 'conversation-cleanup-2',
        user: OTHER_OWNER,
        endpoint: 'agents',
        title: 'genuine preserved fixture',
      },
    ]);
    await Conversation.findOneAndUpdate(
      { user: OWNER, conversationId: 'conversation-cleanup-1', deletedAt: null },
      {
        $set: {
          title: '',
          messages: [],
          files: [],
          tags: [],
          deletedAt: TOMBSTONE.tombstonedAt,
          cleanupTombstone: TOMBSTONE,
        },
        $inc: { __v: 1 },
      },
      { new: true },
    );

    expect(
      await Conversation.findOne({ user: OWNER, conversationId: 'conversation-cleanup-1' }).lean(),
    ).toBeNull();
    expect(
      await Conversation.findOne({
        user: OTHER_OWNER,
        conversationId: 'conversation-cleanup-2',
      }).lean(),
    ).toEqual(expect.objectContaining({ title: 'genuine preserved fixture' }));
  });

  test('internal revision checks can explicitly read a retained tombstone', async () => {
    await Message.create({
      messageId: 'message-cleanup-1',
      conversationId: 'conversation-cleanup-1',
      user: OWNER,
      text: '',
      isCreatedByUser: true,
      deletedAt: TOMBSTONE.tombstonedAt,
      cleanupTombstone: TOMBSTONE,
    });

    const retained = await Message.findOne({
      user: OWNER,
      messageId: 'message-cleanup-1',
      deletedAt: { $ne: null },
    }).lean();

    expect(retained).toEqual(
      expect.objectContaining({
        deletedAt: TOMBSTONE.tombstonedAt,
        cleanupTombstone: expect.objectContaining({ preimageSha256: 'c'.repeat(64) }),
      }),
    );
  });

  test('full product deletion removes retained tombstones for account erasure', async () => {
    await Message.create([
      {
        messageId: 'message-cleanup-1',
        conversationId: 'conversation-cleanup-1',
        user: OWNER,
        text: '',
        isCreatedByUser: false,
        deletedAt: TOMBSTONE.tombstonedAt,
        cleanupTombstone: TOMBSTONE,
      },
      {
        messageId: 'message-cleanup-2',
        conversationId: 'conversation-cleanup-2',
        user: OTHER_OWNER,
        text: 'preserved',
        isCreatedByUser: true,
      },
    ]);

    await Message.deleteMany({ user: OWNER });

    expect(await Message.collection.countDocuments({ user: OWNER })).toBe(0);
    expect(await Message.collection.countDocuments({ user: OTHER_OWNER })).toBe(1);
  });

  test('aggregate reads also hide tombstones unless an explicit deletedAt match is present', async () => {
    await Message.create([
      {
        messageId: 'message-cleanup-1',
        conversationId: 'conversation-cleanup-1',
        user: OWNER,
        text: '',
        isCreatedByUser: true,
        deletedAt: TOMBSTONE.tombstonedAt,
        cleanupTombstone: TOMBSTONE,
      },
      {
        messageId: 'message-cleanup-2',
        conversationId: 'conversation-cleanup-2',
        user: OWNER,
        text: 'genuine preserved fixture',
        isCreatedByUser: true,
      },
    ]);

    const active = await Message.aggregate([{ $match: { user: OWNER } }]);
    const retained = await Message.aggregate([
      { $match: { user: OWNER, deletedAt: { $ne: null } } },
    ]);

    expect(active.map((message) => message.messageId)).toEqual(['message-cleanup-2']);
    expect(retained.map((message) => message.messageId)).toEqual(['message-cleanup-1']);
  });

  test.each(['$search', '$searchMeta', '$vectorSearch', '$geoNear'])(
    'keeps mandatory first aggregate stage %s before cleanup visibility',
    (operator) => {
      const pipeline: Array<Record<string, unknown>> = [
        { [operator]: { index: 'fixture' } },
        { $project: { messageId: 1 } },
      ];

      addCleanupVisibilityToAggregate(pipeline);

      expect(pipeline[0]).toHaveProperty(operator);
      expect(pipeline[1]).toEqual({ $match: { deletedAt: null } });
    },
  );
});
