/* === VIVENTIUM START ===
 * Feature: Typed personal-account cleanup runtime composition.
 * Purpose: Keep cleanup ownership, preflight, and durable registry composition in the package.
 * === VIVENTIUM END === */

import { join, resolve } from 'path';
import { createCleanupLedgerAdapter } from './cleanupLedgerAdapter';
import { createMongoMemoryCleanupAdapter } from './mongoMemoryCleanupAdapter';
import { createMongoPersonalAccountCleanupRepository } from './mongoPersonalAccountCleanupRepository';
import { createMongoSyntheticQaResidueAdapter } from './mongoSyntheticQaResidueAdapter';
import { createPersonalAccountCleanupService } from './personalAccountCleanup';
import { createPersonalAccountCleanupExecutor } from './personalAccountCleanupExecutor';
import { createScheduleCleanupProcessAdapter } from './scheduleCleanupProcessAdapter';

import type { RecallCleanupAdapter, ScheduleCleanupAdapter, SearchCleanupAdapter } from './types';
import type {
  CleanupRecoveryVerifier,
  ViventiumPersonalAccountCleanupReceiptModel,
} from './personalAccountCleanupReceiptModel';

type MessageModel = Parameters<typeof createMongoSyntheticQaResidueAdapter>[0];
type ConversationModel = Parameters<
  typeof createMongoPersonalAccountCleanupRepository
>[0]['Conversation'];
type MemoryModel = Parameters<typeof createMongoMemoryCleanupAdapter>[0];
type ReadyScheduleCleanupAdapter = ScheduleCleanupAdapter & { assertReady(): void };

export interface PersonalAccountCleanupRuntimeDependencies {
  Message: MessageModel;
  Conversation: ConversationModel;
  MemoryEntry: MemoryModel;
  receiptModel: ViventiumPersonalAccountCleanupReceiptModel;
  verifyRecoveryReceipt: CleanupRecoveryVerifier;
  search: SearchCleanupAdapter;
  searchHealth(): Promise<{ status?: string }>;
  recall: RecallCleanupAdapter;
  recallAvailable(): boolean;
  schedules: ReadyScheduleCleanupAdapter;
}

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
] as const;

export function personalAccountCleanupChildEnvironment(environment: NodeJS.ProcessEnv): {
  [key: string]: string;
} {
  return CHILD_ENV_ALLOWLIST.reduce<{ [key: string]: string }>((result, key) => {
    const value = environment[key];
    if (value) result[key] = value;
    return result;
  }, {});
}

export function createPersonalAccountCleanupScheduleAdapter({
  componentRoot,
  environment,
}: {
  componentRoot: string;
  environment: NodeJS.ProcessEnv;
}): ReadyScheduleCleanupAdapter {
  const moduleRoot = join(resolve(componentRoot), 'viventium', 'MCPs', 'scheduling-cortex');
  const configuredPython = String(environment.VIVENTIUM_SCHEDULING_CLEANUP_PYTHON || '').trim();
  return createScheduleCleanupProcessAdapter({
    pythonExecutable: configuredPython || join(moduleRoot, '.venv', 'bin', 'python'),
    bridgeModuleRoot: moduleRoot,
    environment: personalAccountCleanupChildEnvironment(environment),
  });
}

export function createPersonalAccountCleanupRuntime(
  dependencies: PersonalAccountCleanupRuntimeDependencies,
) {
  dependencies.receiptModel.configureCleanupRecoveryVerifier(dependencies.verifyRecoveryReceipt);
  const ledger = createCleanupLedgerAdapter(dependencies.receiptModel);
  const cleanup = createPersonalAccountCleanupService({
    repository: createMongoPersonalAccountCleanupRepository({
      Message: dependencies.Message,
      Conversation: dependencies.Conversation,
      ledger,
    }),
    search: dependencies.search,
    recall: dependencies.recall,
    schedules: dependencies.schedules,
    memories: createMongoMemoryCleanupAdapter(dependencies.MemoryEntry),
    residue: createMongoSyntheticQaResidueAdapter(dependencies.Message),
  });
  const registry = {
    registerVerifiedBackupOperation: (
      input: Parameters<
        ViventiumPersonalAccountCleanupReceiptModel['registerVerifiedBackupOperation']
      >[0],
    ) => dependencies.receiptModel.registerVerifiedBackupOperation(input),
    claimCleanupExecution: (
      input: Parameters<ViventiumPersonalAccountCleanupReceiptModel['claimCleanupExecution']>[0],
    ) => dependencies.receiptModel.claimCleanupExecution(input),
    completeCleanupExecution: (
      input: Parameters<ViventiumPersonalAccountCleanupReceiptModel['completeCleanupExecution']>[0],
    ) => dependencies.receiptModel.completeCleanupExecution(input),
    failCleanupExecution: (
      input: Parameters<ViventiumPersonalAccountCleanupReceiptModel['failCleanupExecution']>[0],
    ) => dependencies.receiptModel.failCleanupExecution(input),
    readCleanupOperation: (ownerId: string, operationId: string) =>
      dependencies.receiptModel.readCleanupOperation(ownerId, operationId),
  };
  return createPersonalAccountCleanupExecutor({
    cleanup,
    registry,
    async preflight() {
      dependencies.schedules.assertReady();
      if (!dependencies.recallAvailable()) {
        throw new Error('cleanup_recall_infrastructure_unavailable');
      }
      const health = await dependencies.searchHealth();
      if (health.status !== 'available') {
        throw new Error('cleanup_search_infrastructure_unavailable');
      }
    },
  });
}

/* === VIVENTIUM END === */
