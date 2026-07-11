#!/usr/bin/env node
/* === VIVENTIUM START ===
 * Feature: Saved-memory/key dedupe and unique-index migration
 *
 * Purpose:
 * - Repair duplicate saved-memory keys and duplicate provider credential keys before enforcing
 *   uniqueness.
 * - Default to dry-run, emit public-safe counts, and only create unique indexes after duplicates
 *   have been removed.
 *
 * Added: 2026-05-20
 * === VIVENTIUM END === */

const path = require('path');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });

const mongoose = require('mongoose');
const { createModels } = require('@librechat/data-schemas');

const MEMORY_COLLECTION = 'memoryentries';
const KEY_COLLECTION = 'keys';

function resolveDefaultMongoUri() {
  if (process.env.MONGO_URI) {
    return process.env.MONGO_URI;
  }
  const localPort = String(process.env.VIVENTIUM_LOCAL_MONGO_PORT || '').trim();
  const localDb = String(process.env.VIVENTIUM_LOCAL_MONGO_DB || '').trim();
  if (localPort && localDb) {
    return `mongodb://127.0.0.1:${localPort}/${localDb}`;
  }
  return '';
}

function parseArgs(argv) {
  const options = {
    apply: false,
    createIndexes: false,
    mongoUri: resolveDefaultMongoUri(),
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--dry-run') {
      options.apply = false;
    } else if (arg === '--create-indexes') {
      options.createIndexes = true;
    } else if (arg === '--mongo-uri') {
      options.mongoUri = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/viventium-memory-dedupe.js [--dry-run|--apply] [--create-indexes] [--mongo-uri <uri>] [--json]',
    '',
    'Default mode is --dry-run. --create-indexes requires --apply and no remaining duplicates.',
  ].join('\n');
}

function valueKey(doc, fields) {
  return fields.map((field) => String(doc?.[field] ?? '')).join('\u0000');
}

function rankDoc(doc) {
  const updatedAt = new Date(doc.updated_at || doc.updatedAt || doc.expiresAt || 0).getTime();
  const id = doc._id == null ? '' : String(doc._id);
  return {
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    id,
  };
}

function compareDocRank(a, b) {
  const aRank = rankDoc(a);
  const bRank = rankDoc(b);
  if (aRank.updatedAt !== bRank.updatedAt) {
    return bRank.updatedAt - aRank.updatedAt;
  }
  return bRank.id.localeCompare(aRank.id);
}

function buildDuplicateGroups(docs, fields) {
  const groups = new Map();
  for (const doc of docs) {
    const key = valueKey(doc, fields);
    if (key.includes('\u0000\u0000') || fields.some((field) => doc?.[field] == null)) {
      continue;
    }
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(doc);
  }
  return Array.from(groups.values())
    .filter((group) => group.length > 1)
    .map((group) => {
      const sorted = [...group].sort(compareDocRank);
      return {
        keepId: sorted[0]._id,
        removeIds: sorted.slice(1).map((doc) => doc._id),
        count: sorted.length,
      };
    });
}

async function loadPotentialDuplicates(collection, fields) {
  const groupId = Object.fromEntries(fields.map((field) => [field, `$${field}`]));
  const duplicateGroups = await collection
    .aggregate([
      { $group: { _id: groupId, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  const docs = [];
  for (const group of duplicateGroups) {
    const query = Object.fromEntries(fields.map((field) => [field, group._id[field]]));
    docs.push(...(await collection.find(query).toArray()));
  }
  return docs;
}

async function dedupeCollection({ collection, fields, apply }) {
  const docs = await loadPotentialDuplicates(collection, fields);
  const groups = buildDuplicateGroups(docs, fields);
  const removeIds = groups.flatMap((group) => group.removeIds).filter(Boolean);
  let deletedCount = 0;
  if (apply && removeIds.length > 0) {
    const result = await collection.deleteMany({ _id: { $in: removeIds } });
    deletedCount = result.deletedCount || 0;
  }
  return {
    duplicateGroups: groups.length,
    duplicateDocs: removeIds.length,
    deletedCount,
  };
}

async function assertNoDuplicates(collection, fields) {
  const docs = await loadPotentialDuplicates(collection, fields);
  const groups = buildDuplicateGroups(docs, fields);
  if (groups.length > 0) {
    throw new Error(`Cannot create unique index; ${groups.length} duplicate groups remain.`);
  }
}

async function createUniqueIndexes(db) {
  const memory = db.collection(MEMORY_COLLECTION);
  const keys = db.collection(KEY_COLLECTION);
  await assertNoDuplicates(memory, ['userId', 'key']);
  await assertNoDuplicates(keys, ['userId', 'name']);
  await memory.createIndex(
    { userId: 1, key: 1 },
    { unique: true, name: 'viventium_unique_memory_user_key' },
  );
  await keys.createIndex(
    { userId: 1, name: 1 },
    { unique: true, name: 'viventium_unique_provider_key_user_name' },
  );
}

async function run(options) {
  if (!options.mongoUri) {
    throw new Error('Missing Mongo URI. Pass --mongo-uri or set MONGO_URI.');
  }
  if (options.createIndexes && !options.apply) {
    throw new Error('--create-indexes requires --apply.');
  }

  // Do not let Mongoose race this explicit migration by creating the new
  // unique indexes before duplicate rows have been inspected.
  await mongoose.connect(options.mongoUri, { autoIndex: false });
  createModels(mongoose);
  const db = mongoose.connection.db;

  const memoryResult = await dedupeCollection({
    collection: db.collection(MEMORY_COLLECTION),
    fields: ['userId', 'key'],
    apply: options.apply,
  });
  const keyResult = await dedupeCollection({
    collection: db.collection(KEY_COLLECTION),
    fields: ['userId', 'name'],
    apply: options.apply,
  });

  let indexesCreated = false;
  if (options.apply && options.createIndexes) {
    await createUniqueIndexes(db);
    indexesCreated = true;
  }

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    memoryentries: memoryResult,
    keys: keyResult,
    indexesCreated,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  try {
    const summary = await run(options);
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(
        [
          `mode=${summary.mode}`,
          `memory_duplicate_groups=${summary.memoryentries.duplicateGroups}`,
          `memory_duplicate_docs=${summary.memoryentries.duplicateDocs}`,
          `memory_deleted=${summary.memoryentries.deletedCount}`,
          `key_duplicate_groups=${summary.keys.duplicateGroups}`,
          `key_duplicate_docs=${summary.keys.duplicateDocs}`,
          `key_deleted=${summary.keys.deletedCount}`,
          `indexes_created=${summary.indexesCreated}`,
        ].join(' '),
      );
    }
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = String(error?.message || error).replace(
      /mongodb(?:\+srv)?:\/\/[^\s]+/gi,
      '<mongo-uri>',
    );
    console.error(message);
    process.exit(1);
  });
}

module.exports = {
  buildDuplicateGroups,
  parseArgs,
  run,
};
