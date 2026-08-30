#!/usr/bin/env node
/* === VIVENTIUM START ===
 * Feature: Required orchestration persistence indexes.
 * Purpose: Create callback and completed-insight outbox indexes when Mongoose auto-indexing is
 * disabled. Startup fails closed if these durability indexes cannot be established.
 * === VIVENTIUM END === */

const { MongoClient } = require('mongodb');

const COLLECTION_INDEXES = Object.freeze({
  viventiumcortexinsightoutboxes: [
    [{ outboxKey: 1 }, { unique: true }],
    [{ userId: 1 }, {}],
    [{ conversationId: 1 }, {}],
    [{ parentMessageId: 1 }, {}],
    [{ cortexId: 1 }, {}],
    [{ insightHash: 1 }, {}],
    [{ surface: 1 }, {}],
    [{ retentionAlertAt: 1 }, {}],
    [
      { createdAt: 1, _id: 1 },
      { name: 'cortex_outbox_global_replay_created_at' },
    ],
    [
      { nextAttemptAt: 1, createdAt: 1, _id: 1 },
      { name: 'cortex_outbox_replay_due' },
    ],
    [{ userId: 1, parentMessageId: 1, createdAt: 1 }, {}],
  ],
  viventiumglasshivecallbackeffectoutboxes: [
    [{ outboxId: 1 }, { unique: true }],
    [{ destination: 1 }, {}],
    [{ ownerId: 1 }, {}],
    [{ occurrenceKey: 1 }, {}],
    [{ terminalCallbackResultKey: 1 }, {}],
    [{ status: 1 }, {}],
    [{ claimId: 1 }, {}],
    [{ claimExpiresAt: 1 }, {}],
    [{ dispatchPermitId: 1 }, {}],
    [{ dispatchPermitExpiresAt: 1 }, {}],
    [{ nextAttemptAt: 1 }, {}],
    [{ expiresAt: 1 }, { expireAfterSeconds: 0 }],
    [{ destination: 1, status: 1, nextAttemptAt: 1, createdAt: 1 }, {}],
  ],
});

function parseArgs(argv) {
  const options = { apply: false, json: false, mongoUri: process.env.MONGO_URI || '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--mongo-uri') options.mongoUri = argv[++index] || '';
    else throw new Error('orchestration_index_argument_invalid');
  }
  return options;
}

async function syncOrchestrationIndexes({ mongoUri, apply = false }) {
  if (!mongoUri) throw new Error('orchestration_index_mongo_uri_missing');
  if (!apply) throw new Error('orchestration_index_apply_required');
  const client = new MongoClient(mongoUri);
  await client.connect();
  try {
    const db = client.db();
    const result = {};
    for (const [collectionName, indexes] of Object.entries(COLLECTION_INDEXES)) {
      const collection = db.collection(collectionName);
      const names = [];
      for (const [keys, options] of indexes) {
        names.push(await collection.createIndex(keys, options));
      }
      result[collectionName] = names.length;
    }
    return result;
  } finally {
    await client.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  try {
    const collections = await syncOrchestrationIndexes(options);
    const result = { ok: true, collections };
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write('Orchestration indexes are ready.\n');
  } catch (error) {
    const result = {
      ok: false,
      code: String(error?.code || error?.name || 'orchestration_index_sync_failed').slice(0, 120),
    };
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { COLLECTION_INDEXES, parseArgs, syncOrchestrationIndexes };
