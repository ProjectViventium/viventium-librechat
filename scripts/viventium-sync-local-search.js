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
    Message.countDocuments({ expiredAt: null }),
    Message.countDocuments({ expiredAt: null, _meiliIndex: true }),
    Conversation.countDocuments({ expiredAt: null }),
    Conversation.countDocuments({ expiredAt: null, _meiliIndex: true }),
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

  const messageNeedsSync =
    state.msgIndexed !== state.msgTotal || state.msgMeili !== state.msgTotal;
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
  const meiliCoverage =
    after.msgMeili >= after.msgTotal && after.convoMeili >= after.convoTotal;

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
