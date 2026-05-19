#!/usr/bin/env node
/* === VIVENTIUM START ===
 * Feature: Deterministic local conversation-search backfill.
 * Purpose: Ensure existing Mongo history is fully indexed into the local
 * Meilisearch instance on startup, rather than relying only on the dev
 * server's one-shot background sync timing.
 * === VIVENTIUM END === */

require('dotenv').config();

const mongoose = require('mongoose');
const { MeiliSearch } = require('meilisearch');
const { createModels } = require('@librechat/data-schemas');
const { connectDb } = require('../api/db/connect');
const { batchResetMeiliFlags } = require('../api/db/utils');

const failedTaskLookback = process.env.VIVENTIUM_MEILI_FAILED_TASK_LOOKBACK
  ? parseInt(process.env.VIVENTIUM_MEILI_FAILED_TASK_LOOKBACK, 10)
  : 25;
const expectedMeiliPrimaryKey = '_meiliId';
const meiliEligibleQuery = {
  expiredAt: null,
  'metadata.viventium.type': { $ne: 'listen_only_transcript' },
  'metadata.viventium.mode': { $ne: 'listen_only' },
};

const isTruthy = (value) => {
  if (typeof value !== 'string') {
    return false;
  }

  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    default:
      return false;
  }
};

const isCatastrophicMeiliTaskError = (task) => {
  const error = task?.error || {};
  const message = String(error.message || '');
  return (
    (message.includes(' is in version ') && message.includes('Meilisearch is in version')) ||
    message.includes('incompatible with the current Meilisearch') ||
    message.includes('incompatible with your current engine version')
  );
};

const assertMeiliTaskHealth = async (client) => {
  const lookback =
    Number.isFinite(failedTaskLookback) && failedTaskLookback > 0 ? failedTaskLookback : 25;
  const tasks = await client.getTasks({ statuses: ['failed'], limit: lookback });
  const offenders = (tasks.results || []).filter(isCatastrophicMeiliTaskError);

  if (offenders.length === 0) {
    return;
  }

  const summary = offenders
    .slice(0, 3)
    .map((task) => `${task.uid}:${task.type}:${task.indexUid || 'global'}`)
    .join(', ');

  throw new Error(
    `Meilisearch recent task health found incompatible failed tasks (${summary}); refusing to enqueue more local search sync work`,
  );
};

const waitForMeiliTask = async (client, task) => {
  if (!task?.taskUid || typeof client.waitForTask !== 'function') {
    return;
  }
  const result = await client.waitForTask(task.taskUid, {
    timeOutMs: parseInt(process.env.MEILI_SYNC_TASK_TIMEOUT_MS || '30000', 10),
    intervalMs: parseInt(process.env.MEILI_SYNC_TASK_INTERVAL_MS || '50', 10),
  });
  if (result.status !== 'succeeded') {
    throw new Error(`Meilisearch task ${task.taskUid} failed while ensuring local search index`);
  }
};

const ensureIndexSchema = async (client, indexName) => {
  try {
    const info = await client.index(indexName).getRawInfo();
    if (info.primaryKey && info.primaryKey !== expectedMeiliPrimaryKey) {
      throw new Error(
        `Meilisearch index ${indexName} uses legacy primary key ${info.primaryKey}; archive/drop the derived index before rebuilding`,
      );
    }
  } catch (error) {
    if (error.code !== 'index_not_found') {
      throw error;
    }
    const task = await client.createIndex(indexName, { primaryKey: expectedMeiliPrimaryKey });
    await waitForMeiliTask(client, task);
  }
};

const ensureSearchIndexSchemas = async (client) => {
  await Promise.all([ensureIndexSchema(client, 'messages'), ensureIndexSchema(client, 'convos')]);
};

const getIndexCount = async (client, indexName) => {
  try {
    const stats = await client.index(indexName).getStats();
    return stats?.numberOfDocuments ?? 0;
  } catch (error) {
    if (error.code === 'index_not_found') {
      return 0;
    }
    throw error;
  }
};

const getState = async (Message, Conversation, client) => {
  const [msgTotal, msgIndexed, convoTotal, convoIndexed, msgMeili, convoMeili] = await Promise.all([
    Message.countDocuments(meiliEligibleQuery),
    Message.countDocuments({ ...meiliEligibleQuery, _meiliIndex: true }),
    Conversation.countDocuments(meiliEligibleQuery),
    Conversation.countDocuments({ ...meiliEligibleQuery, _meiliIndex: true }),
    getIndexCount(client, 'messages'),
    getIndexCount(client, 'convos'),
  ]);

  return {
    msgTotal,
    msgIndexed,
    convoTotal,
    convoIndexed,
    msgMeili,
    convoMeili,
  };
};

const logState = (label, state) => {
  console.log(
    `[local-search-sync] ${label}: messages ${state.msgIndexed}/${state.msgTotal} indexed, ` +
      `Meili ${state.msgMeili}; conversations ${state.convoIndexed}/${state.convoTotal} indexed, ` +
      `Meili ${state.convoMeili}`,
  );
};

const resetStaleFlagsForParity = async (state, Message, Conversation) => {
  let repaired = false;

  if (state.msgMeili < state.msgIndexed) {
    console.log(
      `[local-search-sync] Messages index is missing ${state.msgIndexed - state.msgMeili} documents despite Mongo sync flags. Resetting message sync flags...`,
    );
    await batchResetMeiliFlags(Message.collection);
    repaired = true;
  }

  if (state.convoMeili < state.convoIndexed) {
    console.log(
      `[local-search-sync] Conversations index is missing ${state.convoIndexed - state.convoMeili} documents despite Mongo sync flags. Resetting conversation sync flags...`,
    );
    await batchResetMeiliFlags(Conversation.collection);
    repaired = true;
  }

  return repaired;
};

async function main() {
  if (!isTruthy(process.env.SEARCH ?? '')) {
    console.log('[local-search-sync] SEARCH is disabled, skipping local backfill');
    return;
  }

  if (!process.env.MEILI_HOST || !process.env.MEILI_MASTER_KEY) {
    throw new Error('SEARCH=true but MEILI_HOST/MEILI_MASTER_KEY are not configured');
  }

  const client = new MeiliSearch({
    host: process.env.MEILI_HOST,
    apiKey: process.env.MEILI_MASTER_KEY,
  });

  const health = await client.health();
  if (health.status !== 'available') {
    throw new Error(`Meilisearch is not available at ${process.env.MEILI_HOST}`);
  }
  await assertMeiliTaskHealth(client);
  await ensureSearchIndexSchemas(client);

  await connectDb();
  createModels(mongoose);

  const Message = mongoose.models.Message;
  const Conversation = mongoose.models.Conversation;

  let state = await getState(Message, Conversation, client);
  logState('Before sync', state);

  const parityReset = await resetStaleFlagsForParity(state, Message, Conversation);
  if (parityReset) {
    state = await getState(Message, Conversation, client);
    logState('After parity reset', state);
  }

  const messageNeedsSync = state.msgIndexed !== state.msgTotal || state.msgMeili !== state.msgTotal;
  const convoNeedsSync =
    state.convoIndexed !== state.convoTotal || state.convoMeili !== state.convoTotal;

  if (!messageNeedsSync && !convoNeedsSync) {
    console.log('[local-search-sync] Local search index already current');
    return;
  }

  if (messageNeedsSync) {
    console.log('[local-search-sync] Syncing message history into Meilisearch...');
    await Message.syncWithMeili();
  }

  if (convoNeedsSync) {
    console.log('[local-search-sync] Syncing conversation history into Meilisearch...');
    await Conversation.syncWithMeili();
  }

  const after = await getState(Message, Conversation, client);
  logState('After sync', after);

  const mongoParity =
    after.msgIndexed === after.msgTotal && after.convoIndexed === after.convoTotal;
  const meiliCoverage = after.msgMeili >= after.msgTotal && after.convoMeili >= after.convoTotal;

  if (!mongoParity || !meiliCoverage) {
    throw new Error('Local search sync finished without reaching full parity');
  }

  if (after.msgMeili !== after.msgTotal || after.convoMeili !== after.convoTotal) {
    console.warn(
      '[local-search-sync] Meilisearch retained extra indexed documents after sync; continuing because full local coverage is present',
    );
  }

  console.log('[local-search-sync] Local conversation search is fully indexed');
}

main()
  .catch((error) => {
    console.error('[local-search-sync] Failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
