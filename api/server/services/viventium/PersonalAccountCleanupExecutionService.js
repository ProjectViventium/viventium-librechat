/* === VIVENTIUM START ===
 * Feature: Explicitly authorized personal-account synthetic-QA cleanup execution.
 * Purpose: Compose the package-owned exact mutation/reconciliation contract without exposing
 * private backup material or allowing a caller to choose an owner, verifier, database, or tool.
 * === VIVENTIUM END === */

'use strict';

const path = require('path');
const { MeiliSearch } = require('meilisearch');
const {
  createCleanupLedgerAdapter,
  createExactMeiliCleanupAdapter,
  createMongoMemoryCleanupAdapter,
  createMongoPersonalAccountCleanupRepository,
  createMongoSyntheticQaResidueAdapter,
  createPersonalAccountCleanupExecutor,
  createPersonalAccountCleanupService,
  createScheduleCleanupProcessAdapter,
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

const CHILD_ENV_ALLOWLIST = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'SCHEDULING_DB_MIRROR_PATH',
  'SCHEDULING_DB_PATH',
  'TMPDIR',
  'VIVENTIUM_APP_SUPPORT_DIR',
  'VIVENTIUM_STATE_ROOT',
];

let executor;

function cleanupChildEnvironment() {
  return CHILD_ENV_ALLOWLIST.reduce((result, key) => {
    if (process.env[key]) result[key] = process.env[key];
    return result;
  }, {});
}

function cleanupAuthorityVerifier() {
  const publicKeyPath = String(
    process.env.VIVENTIUM_PERSONAL_ACCOUNT_CLEANUP_AUTHORITY_PUBLIC_KEY_PATH || '',
  ).trim();
  if (!publicKeyPath) throw new Error('cleanup_backup_external_verifier_unavailable');
  return loadTrustedPrivateBackupAuthorityVerifier({ publicKeyPath });
}

function scheduleAdapter() {
  const componentRoot = path.resolve(__dirname, '../../../../');
  const moduleRoot = path.join(componentRoot, 'viventium', 'MCPs', 'scheduling-cortex');
  const configuredPython = String(process.env.VIVENTIUM_SCHEDULING_CLEANUP_PYTHON || '').trim();
  return createScheduleCleanupProcessAdapter({
    pythonExecutable: configuredPython || path.join(moduleRoot, '.venv', 'bin', 'python'),
    bridgeModuleRoot: moduleRoot,
    environment: cleanupChildEnvironment(),
  });
}

function buildExecutor() {
  const verifier = cleanupAuthorityVerifier();
  ViventiumPersonalAccountCleanupReceipt.configureCleanupRecoveryVerifier(verifier);
  if (!process.env.MEILI_HOST || !process.env.MEILI_MASTER_KEY) {
    throw new Error('cleanup_search_infrastructure_unavailable');
  }
  const meili = new MeiliSearch({
    host: process.env.MEILI_HOST,
    apiKey: process.env.MEILI_MASTER_KEY,
  });
  const schedules = scheduleAdapter();
  const ledger = createCleanupLedgerAdapter(ViventiumPersonalAccountCleanupReceipt);
  const repository = createMongoPersonalAccountCleanupRepository({
    Message,
    Conversation,
    ledger,
  });
  const cleanup = createPersonalAccountCleanupService({
    repository,
    search: createExactMeiliCleanupAdapter(meili),
    recall: {
      rebuildOwnerRecall: ({ ownerId: userId, ...binding }) =>
        reconcileConversationRecallForCleanup({ userId, ...binding }),
      verifyOperation: ({ ownerId: userId, ...binding }) =>
        verifyConversationRecallCleanupReceipt({ userId, ...binding }),
    },
    schedules,
    memories: createMongoMemoryCleanupAdapter(MemoryEntry),
    residue: createMongoSyntheticQaResidueAdapter(Message),
  });
  const registry = {
    registerVerifiedBackupOperation: (input) =>
      ViventiumPersonalAccountCleanupReceipt.registerVerifiedBackupOperation(input),
    claimCleanupExecution: (input) =>
      ViventiumPersonalAccountCleanupReceipt.claimCleanupExecution(input),
    completeCleanupExecution: (input) =>
      ViventiumPersonalAccountCleanupReceipt.completeCleanupExecution(input),
    failCleanupExecution: (input) =>
      ViventiumPersonalAccountCleanupReceipt.failCleanupExecution(input),
    readCleanupOperation: (ownerId, operationId) =>
      ViventiumPersonalAccountCleanupReceipt.readCleanupOperation(ownerId, operationId),
  };
  return createPersonalAccountCleanupExecutor({
    cleanup,
    registry,
    async preflight() {
      schedules.assertReady();
      if (!process.env.RAG_API_URL) {
        throw new Error('cleanup_recall_infrastructure_unavailable');
      }
      const health = await meili.health();
      if (health?.status !== 'available') {
        throw new Error('cleanup_search_infrastructure_unavailable');
      }
    },
  });
}

function getExecutor() {
  executor ||= buildExecutor();
  return executor;
}

async function executePersonalAccountCleanup(input) {
  return getExecutor().execute(input);
}

async function verifyPersonalAccountCleanupSweep(input) {
  return getExecutor().verifyDelayedSweep(input);
}

module.exports = {
  executePersonalAccountCleanup,
  verifyPersonalAccountCleanupSweep,
};
