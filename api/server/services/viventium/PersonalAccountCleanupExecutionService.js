/* === VIVENTIUM START ===
 * Feature: Personal-account cleanup runtime adapter.
 * Purpose: Bind legacy server dependencies to the package-owned typed cleanup runtime.
 * === VIVENTIUM END === */

'use strict';

const path = require('path');
const { MeiliSearch } = require('meilisearch');
const {
  createExactMeiliCleanupAdapter,
  createPersonalAccountCleanupRuntime,
  createPersonalAccountCleanupScheduleAdapter,
  loadTrustedPrivateBackupAuthorityVerifier,
} = require('@librechat/api');
const {
  Conversation,
  MemoryEntry,
  Message,
  ViventiumPersonalAccountCleanupReceipt,
} = require('~/db/models');
const {
  reconcileConversationRecallForCleanup,
  verifyConversationRecallCleanupReceipt,
} = require('./conversationRecallService');

let runtime;

function buildRuntime() {
  const publicKeyPath = String(
    process.env.VIVENTIUM_PERSONAL_ACCOUNT_CLEANUP_AUTHORITY_PUBLIC_KEY_PATH || '',
  ).trim();
  if (!publicKeyPath) throw new Error('cleanup_backup_external_verifier_unavailable');
  if (!process.env.MEILI_HOST || !process.env.MEILI_MASTER_KEY) {
    throw new Error('cleanup_search_infrastructure_unavailable');
  }
  const searchClient = new MeiliSearch({
    host: process.env.MEILI_HOST,
    apiKey: process.env.MEILI_MASTER_KEY,
  });
  return createPersonalAccountCleanupRuntime({
    Message,
    Conversation,
    MemoryEntry,
    receiptModel: ViventiumPersonalAccountCleanupReceipt,
    verifyRecoveryReceipt: loadTrustedPrivateBackupAuthorityVerifier({ publicKeyPath }),
    search: createExactMeiliCleanupAdapter(searchClient),
    searchHealth: () => searchClient.health(),
    recall: {
      rebuildOwnerRecall: ({ ownerId: userId, ...binding }) =>
        reconcileConversationRecallForCleanup({ userId, ...binding }),
      verifyOperation: ({ ownerId: userId, ...binding }) =>
        verifyConversationRecallCleanupReceipt({ userId, ...binding }),
    },
    recallAvailable: () => Boolean(process.env.RAG_API_URL),
    schedules: createPersonalAccountCleanupScheduleAdapter({
      componentRoot: path.resolve(__dirname, '../../../../'),
      environment: process.env,
    }),
  });
}

function cleanupRuntime() {
  runtime ||= buildRuntime();
  return runtime;
}

module.exports = {
  executePersonalAccountCleanup: async (input) => cleanupRuntime().execute(input),
  verifyPersonalAccountCleanupSweep: async (input) => cleanupRuntime().verifyDelayedSweep(input),
};

/* === VIVENTIUM END === */
