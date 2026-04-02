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

  describe('getFormattedMemories', () => {
    it('should format memories in an LLM-parseable keyed block format', async () => {
      const userId = new mongoose.Types.ObjectId();

      await MemoryEntry.create([
        {
          userId,
          key: 'core',
          value: 'Hello \"world\"\\nLine two.',
          tokenCount: 123,
          updated_at: new Date('2026-02-07T10:00:00.000Z'),
        },
        {
          userId,
          key: 'moments',
          value: '- 2026-02-07 | note | \"Quoted\" | Context',
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
      expect(withKeys).toContain('Hello \"world\"');
      expect(withKeys).toContain('Line two.');
      expect(withKeys).toContain('\n\n---\n\n');
      expect(withKeys).not.toContain('[\"value\":');

      expect(withoutKeys).toContain('## core');
      expect(withoutKeys).toContain('Hello \"world\"');
      expect(withoutKeys).toContain('## moments');
      expect(withoutKeys).toContain('- 2026-02-07 | note | \"Quoted\" | Context');
      expect(withoutKeys).not.toContain('updated_at:');
    });
  });
});
