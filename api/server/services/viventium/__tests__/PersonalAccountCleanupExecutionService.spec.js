const mockExecute = jest.fn();
const mockSweep = jest.fn();
const mockCreateExecutor = jest.fn();
const mockCreateCleanupService = jest.fn();
const mockCreateLedger = jest.fn();
const mockCreateRepository = jest.fn();
const mockCreateMemoryAdapter = jest.fn();
const mockCreateResidueAdapter = jest.fn();
const mockCreateSearchAdapter = jest.fn();
const mockCreateScheduleAdapter = jest.fn();
const mockLoadVerifier = jest.fn();
const mockHealth = jest.fn();

const mockModels = {
  Conversation: { modelName: 'Conversation' },
  MemoryEntry: { modelName: 'MemoryEntry' },
  Message: { modelName: 'Message' },
  ViventiumPersonalAccountCleanupReceipt: {
    modelName: 'CleanupReceipt',
    configureCleanupRecoveryVerifier: jest.fn(),
  },
};
const mockRecall = {
  reconcileConversationRecallForCleanup: jest.fn(),
  verifyConversationRecallCleanupReceipt: jest.fn(),
};
const mockSearchClient = { health: mockHealth };

jest.mock('meilisearch', () => ({
  MeiliSearch: jest.fn(() => mockSearchClient),
}));
jest.mock('@librechat/api', () => ({
  createCleanupLedgerAdapter: (...args) => mockCreateLedger(...args),
  createExactMeiliCleanupAdapter: (...args) => mockCreateSearchAdapter(...args),
  createMongoMemoryCleanupAdapter: (...args) => mockCreateMemoryAdapter(...args),
  createMongoPersonalAccountCleanupRepository: (...args) => mockCreateRepository(...args),
  createMongoSyntheticQaResidueAdapter: (...args) => mockCreateResidueAdapter(...args),
  createPersonalAccountCleanupExecutor: (...args) => mockCreateExecutor(...args),
  createPersonalAccountCleanupService: (...args) => mockCreateCleanupService(...args),
  createScheduleCleanupProcessAdapter: (...args) => mockCreateScheduleAdapter(...args),
  loadTrustedPrivateBackupAuthorityVerifier: (...args) => mockLoadVerifier(...args),
}));
jest.mock('~/db/models', () => mockModels);
jest.mock('~/server/services/viventium/conversationRecallService', () => mockRecall);

describe('PersonalAccountCleanupExecutionService', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.VIVENTIUM_PERSONAL_ACCOUNT_CLEANUP_AUTHORITY_PUBLIC_KEY_PATH =
      '/private-fixture/cleanup-authority.pub';
    process.env.MEILI_HOST = 'http://search.invalid';
    process.env.MEILI_MASTER_KEY = 'synthetic-search-key';
    process.env.RAG_API_URL = 'http://recall.invalid';
    mockCreateSearchAdapter.mockReturnValue({ name: 'search-adapter' });
    mockCreateScheduleAdapter.mockReturnValue({ name: 'schedule-adapter', assertReady: jest.fn() });
    mockCreateLedger.mockReturnValue({ name: 'ledger-adapter' });
    mockCreateRepository.mockReturnValue({ name: 'repository-adapter' });
    mockCreateMemoryAdapter.mockReturnValue({ name: 'memory-adapter' });
    mockCreateResidueAdapter.mockReturnValue({ name: 'residue-adapter' });
    mockCreateCleanupService.mockReturnValue({ name: 'cleanup-service' });
    mockLoadVerifier.mockReturnValue(jest.fn());
    mockCreateExecutor.mockReturnValue({
      execute: mockExecute,
      verifyDelayedSweep: mockSweep,
    });
  });

  afterEach(() => {
    delete process.env.VIVENTIUM_PERSONAL_ACCOUNT_CLEANUP_AUTHORITY_PUBLIC_KEY_PATH;
    delete process.env.MEILI_HOST;
    delete process.env.MEILI_MASTER_KEY;
    delete process.env.RAG_API_URL;
  });

  test('binds owner-scoped cleanup adapters once to the package-owned executor', async () => {
    const service = require('../PersonalAccountCleanupExecutionService');
    const input = { authenticatedOwnerId: 'owner-cleanup-1' };
    mockExecute.mockResolvedValue({ status: 'completed' });
    mockSweep.mockResolvedValue({ status: 'verified' });

    await expect(service.executePersonalAccountCleanup(input)).resolves.toEqual({
      status: 'completed',
    });
    await expect(service.verifyPersonalAccountCleanupSweep(input)).resolves.toEqual({
      status: 'verified',
    });

    expect(mockModels.ViventiumPersonalAccountCleanupReceipt.configureCleanupRecoveryVerifier)
      .toHaveBeenCalledWith(expect.any(Function));
    expect(mockCreateExecutor).toHaveBeenCalledTimes(1);
    expect(mockCreateExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanup: { name: 'cleanup-service' },
        registry: expect.objectContaining({
          claimCleanupExecution: expect.any(Function),
          completeCleanupExecution: expect.any(Function),
        }),
        preflight: expect.any(Function),
      }),
    );
    expect(mockCreateCleanupService).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: { name: 'repository-adapter' },
        search: { name: 'search-adapter' },
        schedules: expect.objectContaining({ name: 'schedule-adapter' }),
        memories: { name: 'memory-adapter' },
        residue: { name: 'residue-adapter' },
      }),
    );
    expect(mockExecute).toHaveBeenCalledWith(input);
    expect(mockSweep).toHaveBeenCalledWith(input);
  });

  test('fails closed before composition when verifier or search configuration is absent', async () => {
    delete process.env.VIVENTIUM_PERSONAL_ACCOUNT_CLEANUP_AUTHORITY_PUBLIC_KEY_PATH;
    const service = require('../PersonalAccountCleanupExecutionService');

    await expect(service.executePersonalAccountCleanup({})).rejects.toThrow(
      'cleanup_backup_external_verifier_unavailable',
    );
    expect(mockCreateExecutor).not.toHaveBeenCalled();
  });
});
