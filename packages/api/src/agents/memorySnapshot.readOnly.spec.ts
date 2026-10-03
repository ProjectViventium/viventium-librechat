/* === VIVENTIUM START === Read-only snapshots against the real saved-memory store and FIFO writers. === */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import { loadMemorySnapshot } from './memory';

describe('read-only memory snapshots with accepted FIFO writers', () => {
  let server: MongoMemoryServer;
  let methods: ReturnType<typeof createMethods>;
  const user = new mongoose.Types.ObjectId().toString();
  const config = { validKeys: ['working', 'context'] };
  const identity = (messageId: string) => ({ userId: user, messageId, owner: 'runtime' });
  const snapshot = (readOnly: boolean) =>
    loadMemorySnapshot({ userId: user, memoryMethods: methods, config, readOnly });
  const admit = async (messageId: string, admittedAt: Date) => {
    const floor = await snapshot(true);
    return methods.admitMemoryWrite({
      ...identity(messageId),
      conversationId: 'conversation',
      admittedAt,
      source: {
        digest: 'source-hash',
        configDigest: 'config-hash',
        messageIds: ['question'],
        input: 'frozen input',
        timeContext: 'time',
        memoryRevisionMap: floor.memoryRevisionMap,
        interactionContextJson: '{}',
      },
    });
  };

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    createModels(mongoose);
    await mongoose.models.MemoryEntry.init();
    methods = createMethods(mongoose);
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });
  beforeEach(async () => {
    await mongoose.models.Message.deleteMany({});
    await mongoose.models.MemoryEntry.deleteMany({});
    for (const messageId of ['answer-one', 'answer-two']) {
      await mongoose.models.Message.create({
        messageId,
        user,
        conversationId: 'conversation',
        isCreatedByUser: false,
      });
    }
  });

  it('lets a later writer accept an earlier accepted save that is due for maintenance', async () => {
    await methods.setMemory({ userId: user, key: 'working', value: 'Note.', expectedRevision: null });
    await methods.setMemory({
      userId: user,
      key: 'context',
      value: 'Active context.\n_expires: 2999-01-01',
      expectedRevision: null,
    });
    // Both answers are admitted before the earlier writer saves (the S0013 interleaving).
    expect(await admit('answer-one', new Date(Date.now() - 2000))).toBe(true);
    expect(await admit('answer-two', new Date(Date.now() - 1000))).toBe(true);

    expect(await methods.startMemoryWrite(identity('answer-one'))).toBe(true);
    const before = await snapshot(true);
    // The earlier writer's accepted save leaves a context whose expiry has already passed.
    const saved = await methods.setMemory({
      userId: user,
      key: 'context',
      value: 'Updated context.\n_expires: 2000-01-01',
      expectedRevision: before.memoryRevisionMap.context,
      writerEffect: { messageId: 'answer-one', owner: 'runtime', operationId: 'op-one' },
    });
    expect(saved.ok).toBe(true);
    expect(
      await methods.completeMemoryWrite({ ...identity('answer-one'), receipts: [] }),
    ).toBe(true);

    expect(await methods.startMemoryWrite(identity('answer-two'))).toBe(true);
    const current = await snapshot(true);
    expect(
      await methods.validateMemoryWriteSnapshot({
        ...identity('answer-two'),
        revisions: current.memoryRevisionMap,
        effects: current.memoryWriterEffectMap ?? {},
      }),
    ).toBe(true);
    // The read-only load left the earlier writer's save and its accepted-effect marker intact.
    const context = await mongoose.models.MemoryEntry.findOne({ key: 'context' }).lean();
    expect(context?.writerEffect).toMatchObject({ messageId: 'answer-one', operationId: 'op-one' });
    const rows = await mongoose.models.MemoryEntry.find({}).lean();
    expect(current.latestMutationAt).toBe(
      Math.max(...rows.map((row) => new Date(row.updated_at as Date).getTime())),
    );

    // The same store is genuinely due for maintenance: only a writing load rewrites it.
    await snapshot(false);
    const maintained = await mongoose.models.MemoryEntry.findOne({ key: 'context' }).lean();
    expect(Number(maintained?.__v)).toBeGreaterThan(Number(context?.__v));
    expect(maintained?.writerEffect).toBeUndefined();
  });
});
/* === VIVENTIUM END === */
