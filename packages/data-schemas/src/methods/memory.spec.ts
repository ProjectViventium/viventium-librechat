/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMemoryMethods } from './memory';
import { createModels } from '~/models';

let MemoryEntry: mongoose.Model<unknown>;
let memoryMethods: ReturnType<typeof createMemoryMethods>;
let mongoServer: MongoMemoryServer;
let modelsToCleanup: string[] = [];

describe('Memory Methods', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);

    const models = createModels(mongoose);
    modelsToCleanup = Object.keys(models);
    Object.assign(mongoose.models, models);

    MemoryEntry = mongoose.models.MemoryEntry as mongoose.Model<unknown>;
    await MemoryEntry.init();
    memoryMethods = createMemoryMethods(mongoose);
  });

  afterAll(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }

    for (const modelName of modelsToCleanup) {
      if (mongoose.models[modelName]) {
        delete mongoose.models[modelName];
      }
    }

    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await MemoryEntry.deleteMany({});
  });

  describe('setMemory revision protection', () => {
    it('rejects a stale full-key overwrite and preserves the newer value', async () => {
      const userId = new mongoose.Types.ObjectId();
      const original = await MemoryEntry.create({
        userId,
        key: 'world',
        value: 'Original snapshot',
        tokenCount: 2,
        updated_at: new Date('2026-07-10T10:00:00.000Z'),
      });

      const newer = await memoryMethods.setMemory({
        userId,
        key: 'world',
        value: 'Newer saved fact',
        tokenCount: 3,
      });
      expect(newer.ok).toBe(true);

      const stale = await memoryMethods.setMemory({
        userId,
        key: 'world',
        value: 'Stale replacement',
        tokenCount: 3,
        expectedRevision: original.__v,
      });

      expect(stale).toEqual(expect.objectContaining({ ok: false, conflict: true }));
      const stored = await MemoryEntry.findOne({ userId, key: 'world' }).lean();
      expect(stored?.value).toBe('Newer saved fact');
    });

    it('atomically allows only one writer to create an absent key', async () => {
      const userId = new mongoose.Types.ObjectId();

      const results = await Promise.all([
        memoryMethods.setMemory({
          userId,
          key: 'context',
          value: 'Telegram fact',
          tokenCount: 2,
          expectedRevision: null,
        }),
        memoryMethods.setMemory({
          userId,
          key: 'context',
          value: 'Web fact',
          tokenCount: 2,
          expectedRevision: null,
        }),
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => result.conflict)).toHaveLength(1);
      expect(await MemoryEntry.countDocuments({ userId, key: 'context' })).toBe(1);
    });

    it('uses a monotonic revision even when writes share the same timestamp', async () => {
      const userId = new mongoose.Types.ObjectId();
      await MemoryEntry.create({
        userId,
        key: 'world',
        value: 'Original',
        tokenCount: 1,
        updated_at: new Date('2026-07-10T10:00:00.000Z'),
      });

      const first = await memoryMethods.setMemory({
        userId,
        key: 'world',
        value: 'First',
        tokenCount: 1,
        expectedRevision: 0,
      });
      const stale = await memoryMethods.setMemory({
        userId,
        key: 'world',
        value: 'Stale',
        tokenCount: 1,
        expectedRevision: 0,
      });

      expect(first).toEqual(expect.objectContaining({ ok: true, revision: 1 }));
      expect(stale).toEqual(expect.objectContaining({ ok: false, conflict: true }));
    });

    it('retains a tombstone so delete and recreate cannot reset the CAS revision', async () => {
      const userId = new mongoose.Types.ObjectId();
      const original = await MemoryEntry.create({
        userId,
        key: 'world',
        value: 'Original',
        tokenCount: 1,
        updated_at: new Date('2026-07-10T10:00:00.000Z'),
      });

      const deleted = await memoryMethods.deleteMemory({
        userId,
        key: 'world',
        expectedRevision: Number(original.__v ?? 0),
      });
      const recreated = await memoryMethods.createMemory({
        userId,
        key: 'world',
        value: 'Recreated safely',
        tokenCount: 2,
      });
      const staleSet = await memoryMethods.setMemory({
        userId,
        key: 'world',
        value: 'Stale overwrite',
        tokenCount: 2,
        expectedRevision: Number(original.__v ?? 0),
      });
      const staleDelete = await memoryMethods.deleteMemory({
        userId,
        key: 'world',
        expectedRevision: Number(original.__v ?? 0),
      });

      expect(deleted).toEqual(expect.objectContaining({ ok: true, revision: 1 }));
      expect(recreated).toEqual(expect.objectContaining({ ok: true, revision: 2 }));
      expect(staleSet).toEqual(expect.objectContaining({ ok: false, conflict: true }));
      expect(staleDelete).toEqual(expect.objectContaining({ ok: false, conflict: true }));
      const stored = await MemoryEntry.findOne({ userId, key: 'world' }).lean();
      expect(stored?.value).toBe('Recreated safely');
      expect(stored?.deletedAt).toBeUndefined();
    });

    it('rejects a stale absent-key create after a newer delete while hiding the tombstone', async () => {
      const userId = new mongoose.Types.ObjectId();
      const created = await memoryMethods.createMemory({
        userId,
        key: 'context',
        value: 'Newer fact',
        tokenCount: 2,
      });
      await memoryMethods.deleteMemory({
        userId,
        key: 'context',
        expectedRevision: created.revision,
      });

      const staleCreate = await memoryMethods.setMemory({
        userId,
        key: 'context',
        value: 'Stale resurrection',
        tokenCount: 2,
        expectedRevision: null,
      });

      expect(staleCreate).toEqual(expect.objectContaining({ ok: false, conflict: true }));
      expect(await memoryMethods.getAllUserMemories(userId)).toEqual([]);
      const states = await memoryMethods.getAllUserMemoryStates(userId);
      expect(states).toHaveLength(1);
      expect(states[0]).toEqual(expect.objectContaining({ key: 'context', __v: 1 }));
      expect(states[0].deletedAt).toBeInstanceOf(Date);
    });
  });

  describe('renameMemory revision protection', () => {
    it('renames and updates one row atomically', async () => {
      const userId = new mongoose.Types.ObjectId();
      const original = await MemoryEntry.create({
        userId,
        key: 'context',
        value: 'Original',
        tokenCount: 1,
      });

      const result = await memoryMethods.renameMemory({
        userId,
        key: 'context',
        newKey: 'context_archive',
        value: 'Archived',
        tokenCount: 2,
        expectedRevision: Number(original.__v ?? 0),
      });

      expect(result).toEqual(expect.objectContaining({ ok: true, revision: 1 }));
      expect(await MemoryEntry.countDocuments({ userId })).toBe(1);
      expect(await MemoryEntry.findOne({ userId }).lean()).toEqual(
        expect.objectContaining({ key: 'context_archive', value: 'Archived', __v: 1 }),
      );
    });

    it('rejects a stale rename without creating a second row', async () => {
      const userId = new mongoose.Types.ObjectId();
      await MemoryEntry.create({ userId, key: 'context', value: 'Newer', tokenCount: 1 });
      await MemoryEntry.updateOne({ userId, key: 'context' }, { $set: { __v: 2 } });

      const result = await memoryMethods.renameMemory({
        userId,
        key: 'context',
        newKey: 'context_archive',
        value: 'Stale',
        tokenCount: 1,
        expectedRevision: 1,
      });

      expect(result).toEqual(expect.objectContaining({ ok: false, conflict: true }));
      expect(await MemoryEntry.countDocuments({ userId })).toBe(1);
      expect(await MemoryEntry.findOne({ userId }).lean()).toEqual(
        expect.objectContaining({ key: 'context', value: 'Newer', __v: 2 }),
      );
    });

    it('preserves the source when the target key already exists', async () => {
      const userId = new mongoose.Types.ObjectId();
      await MemoryEntry.create([
        { userId, key: 'context', value: 'Source', tokenCount: 1 },
        { userId, key: 'context_archive', value: 'Target', tokenCount: 1 },
      ]);

      const result = await memoryMethods.renameMemory({
        userId,
        key: 'context',
        newKey: 'context_archive',
        value: 'Replacement',
        tokenCount: 1,
        expectedRevision: 0,
      });

      expect(result).toEqual(expect.objectContaining({ ok: false, conflict: true }));
      expect(await MemoryEntry.countDocuments({ userId })).toBe(2);
      expect(await MemoryEntry.findOne({ userId, key: 'context' }).lean()).toEqual(
        expect.objectContaining({ value: 'Source' }),
      );
    });

    it('identifies a hidden tombstone target without changing the source or tombstone', async () => {
      const userId = new mongoose.Types.ObjectId();
      const source = await MemoryEntry.create({
        userId,
        key: 'context',
        value: 'Source',
        tokenCount: 1,
      });
      const target = await MemoryEntry.create({
        userId,
        key: 'context_archive',
        value: 'Deleted target',
        tokenCount: 1,
      });
      const deletedAt = new Date('2026-07-19T12:00:00.000Z');
      await MemoryEntry.updateOne(
        { _id: target._id },
        { $set: { value: '', tokenCount: 0, deletedAt } },
      );

      const result = await memoryMethods.renameMemory({
        userId,
        key: 'context',
        newKey: 'context_archive',
        value: 'Replacement',
        tokenCount: 1,
        expectedRevision: Number(source.__v ?? 0),
      });

      expect(result).toEqual(
        expect.objectContaining({
          ok: false,
          conflict: true,
          conflictReason: 'target_key_reserved',
        }),
      );
      expect(await MemoryEntry.findOne({ userId, key: 'context' }).lean()).toEqual(
        expect.objectContaining({ value: 'Source', __v: 0 }),
      );
      expect(await MemoryEntry.findOne({ userId, key: 'context_archive' }).lean()).toEqual(
        expect.objectContaining({ deletedAt, __v: 0 }),
      );
    });
  });

  describe('getFormattedMemories', () => {
    it('should format memories in an LLM-parseable keyed block format', async () => {
      const userId = new mongoose.Types.ObjectId();

      await MemoryEntry.create([
        {
          userId,
          key: 'core',
          value: 'Hello "world"\\nLine two.',
          tokenCount: 123,
          updated_at: new Date('2026-02-07T10:00:00.000Z'),
        },
        {
          userId,
          key: 'moments',
          value: '- 2026-02-07 | note | "Quoted" | Context',
          tokenCount: 7,
          updated_at: new Date('2026-02-07T12:00:00.000Z'),
        },
      ]);

      const { withKeys, withoutKeys, totalTokens, memoryTokenMap } =
        await memoryMethods.getFormattedMemories({
          userId,
        });

      expect(totalTokens).toBe(130);
      /* === VIVENTIUM START ===
       * Fix: Ensure getFormattedMemories exposes per-key token counts for overwrite-aware limits.
       * Added: 2026-02-09
       * === VIVENTIUM END === */
      expect(memoryTokenMap).toEqual({ core: 123, moments: 7 });

      // Keyed format should be easy for LLMs to parse and should not wrap values in quotes.
      expect(withKeys).toContain('## core');
      expect(withKeys).toContain('(updated_at: 2026-02-07, tokens: 123)');
      expect(withKeys).toContain('Hello "world"');
      expect(withKeys).toContain('Line two.');
      expect(withKeys).toContain('\n\n---\n\n');
      expect(withKeys).not.toContain('["value":');

      expect(withoutKeys).toContain('## core');
      expect(withoutKeys).toContain('Hello "world"');
      expect(withoutKeys).toContain('## moments');
      expect(withoutKeys).toContain('- 2026-02-07 | note | "Quoted" | Context');
      expect(withoutKeys).not.toContain('updated_at:');
    });
  });
});
