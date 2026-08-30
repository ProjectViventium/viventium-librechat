import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from '@librechat/data-schemas';
import { cleanupStateSha256, ownerScopeSha256 } from '../personalAccountCleanup';
import { createMongoMemoryCleanupAdapter } from '../mongoMemoryCleanupAdapter';

const OWNER = '64b000000000000000000001';
const OTHER_OWNER = '64b000000000000000000002';
const OPERATION = 'cleanup-operation-1';
const AT = '2026-08-25T16:00:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('Mongo retained memory cleanup adapter', () => {
  let mongoServer: MongoMemoryServer;
  let models: ReturnType<typeof createModels>;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    models = createModels(mongoose);
    await models.MemoryEntry.init();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await models.MemoryEntry.collection.deleteMany({});
  });

  test('CAS tombstones one exact reviewed memory and preserves every other owner', async () => {
    await models.MemoryEntry.create([
      {
        userId: OWNER,
        key: 'synthetic_memory',
        value: 'private synthetic fixture',
        tokenCount: 3,
        updated_at: new Date('2026-08-25T15:00:00.000Z'),
      },
      {
        userId: OTHER_OWNER,
        key: 'genuine_memory',
        value: 'genuine preserved fixture',
        tokenCount: 3,
        updated_at: new Date('2026-08-25T15:00:00.000Z'),
      },
    ]);
    const adapter = createMongoMemoryCleanupAdapter(models.MemoryEntry);
    const source = await adapter.readActiveTarget(OWNER, 'synthetic_memory');
    expect(source).not.toBeNull();

    await expect(
      adapter.applyTombstone({
        source: source!,
        operationId: OPERATION,
        ownerScopeHash: ownerScopeSha256(OWNER),
        reviewBindingSha256: HASH_A,
        preimageSha256: cleanupStateSha256(source!),
        runNonceHash: `sha256:${HASH_B}`,
        tombstonedAt: AT,
      }),
    ).resolves.toEqual({ applied: true, revision: 1, tombstonedAt: AT });

    const retained = await models.MemoryEntry.findOne({
      userId: OWNER,
      key: 'synthetic_memory',
    }).lean();
    expect(retained).toEqual(
      expect.objectContaining({ value: '', tokenCount: 0, deletedAt: new Date(AT), __v: 1 }),
    );
    expect(JSON.stringify(retained)).not.toContain('private synthetic fixture');
    expect(
      await models.MemoryEntry.findOne({ userId: OTHER_OWNER, key: 'genuine_memory' }).lean(),
    ).toEqual(expect.objectContaining({ value: 'genuine preserved fixture' }));
    await expect(adapter.readRetainedTombstone(OWNER, 'synthetic_memory')).resolves.toEqual({
      revision: 1,
      tombstonedAt: AT,
    });
  });

  test('a stale state cannot remove a newer genuine edit', async () => {
    await models.MemoryEntry.create({
      userId: OWNER,
      key: 'synthetic_memory',
      value: 'reviewed synthetic fixture',
      updated_at: new Date('2026-08-25T15:00:00.000Z'),
    });
    const adapter = createMongoMemoryCleanupAdapter(models.MemoryEntry);
    const source = await adapter.readActiveTarget(OWNER, 'synthetic_memory');
    await models.MemoryEntry.updateOne(
      { userId: OWNER, key: 'synthetic_memory' },
      {
        $set: { value: 'newer genuine edit', updated_at: new Date('2026-08-25T15:01:00.000Z') },
        $inc: { __v: 1 },
      },
    );

    await expect(
      adapter.applyTombstone({
        source: source!,
        operationId: OPERATION,
        ownerScopeHash: ownerScopeSha256(OWNER),
        reviewBindingSha256: HASH_A,
        preimageSha256: cleanupStateSha256(source!),
        runNonceHash: `sha256:${HASH_B}`,
        tombstonedAt: AT,
      }),
    ).resolves.toEqual({ applied: false, revision: 1, tombstonedAt: AT });
    const preserved = await models.MemoryEntry.findOne({
      userId: OWNER,
      key: 'synthetic_memory',
    }).lean();
    expect(preserved).toEqual(expect.objectContaining({ value: 'newer genuine edit' }));
    expect(preserved).not.toHaveProperty('deletedAt');
  });

  test('delayed verification is exact-owner and exact-target only', async () => {
    await models.MemoryEntry.collection.insertOne({
      userId: new mongoose.Types.ObjectId(OWNER),
      key: 'synthetic_memory',
      value: '',
      tokenCount: 0,
      updated_at: new Date(AT),
      deletedAt: new Date(AT),
      __v: 1,
    });
    const adapter = createMongoMemoryCleanupAdapter(models.MemoryEntry);
    const request = {
      ownerId: OWNER,
      operationId: OPERATION,
      targets: [{ kind: 'memory' as const, resourceId: 'synthetic_memory' }],
      nonceHash: `sha256:${HASH_B}`,
    };

    await expect(adapter.verifyOperation(request)).resolves.toEqual({
      verifiedCount: 1,
      tombstones: [{ resourceId: 'synthetic_memory', revision: 1, tombstonedAt: AT }],
    });
    await expect(adapter.verifyOperation({ ...request, ownerId: OTHER_OWNER })).rejects.toThrow(
      'cleanup_memory_residue',
    );
    await expect(
      adapter.verifyOperation({
        ...request,
        targets: [{ kind: 'message', resourceId: 'synthetic_memory' }],
      }),
    ).rejects.toThrow('cleanup_memory_target_kind_invalid');
  });
});
