const { Types } = require('mongoose');
const path = require('path');

const { buildDuplicateGroups, parseArgs } = require(
  path.join(__dirname, '../../../scripts/viventium-memory-dedupe.js'),
);

describe('viventium-memory-dedupe', () => {
  test('plans to keep the newest saved-memory document per user/key', () => {
    const userId = new Types.ObjectId();
    const oldId = new Types.ObjectId();
    const newId = new Types.ObjectId();
    const groups = buildDuplicateGroups(
      [
        {
          _id: oldId,
          userId,
          key: 'core',
          updated_at: new Date('2026-01-01T00:00:00Z'),
        },
        {
          _id: newId,
          userId,
          key: 'core',
          updated_at: new Date('2026-05-01T00:00:00Z'),
        },
        {
          _id: new Types.ObjectId(),
          userId,
          key: 'context',
          updated_at: new Date('2026-05-01T00:00:00Z'),
        },
      ],
      ['userId', 'key'],
    );

    expect(groups).toHaveLength(1);
    expect(String(groups[0].keepId)).toBe(String(newId));
    expect(groups[0].removeIds.map(String)).toEqual([String(oldId)]);
  });

  test('apply index creation is explicit and never implied by dry-run', () => {
    expect(parseArgs(['--dry-run', '--json'])).toEqual(
      expect.objectContaining({
        apply: false,
        createIndexes: false,
        json: true,
      }),
    );
    expect(parseArgs(['--apply', '--create-indexes'])).toEqual(
      expect.objectContaining({
        apply: true,
        createIndexes: true,
      }),
    );
  });

  test('derives local native Mongo URI from runtime env when MONGO_URI is empty', () => {
    const originalMongoUri = process.env.MONGO_URI;
    const originalPort = process.env.VIVENTIUM_LOCAL_MONGO_PORT;
    const originalDb = process.env.VIVENTIUM_LOCAL_MONGO_DB;
    try {
      delete process.env.MONGO_URI;
      process.env.VIVENTIUM_LOCAL_MONGO_PORT = '27117';
      process.env.VIVENTIUM_LOCAL_MONGO_DB = 'LibreChatViventium';

      expect(parseArgs([]).mongoUri).toBe('mongodb://127.0.0.1:27117/LibreChatViventium');
    } finally {
      if (originalMongoUri === undefined) {
        delete process.env.MONGO_URI;
      } else {
        process.env.MONGO_URI = originalMongoUri;
      }
      if (originalPort === undefined) {
        delete process.env.VIVENTIUM_LOCAL_MONGO_PORT;
      } else {
        process.env.VIVENTIUM_LOCAL_MONGO_PORT = originalPort;
      }
      if (originalDb === undefined) {
        delete process.env.VIVENTIUM_LOCAL_MONGO_DB;
      } else {
        process.env.VIVENTIUM_LOCAL_MONGO_DB = originalDb;
      }
    }
  });
});
