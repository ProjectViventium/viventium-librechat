const mockExecute = jest.fn();
const mockSweep = jest.fn();
const mockCreateRuntime = jest.fn();
const mockCreateSearchAdapter = jest.fn();
const mockCreateScheduleAdapter = jest.fn();
const mockLoadVerifier = jest.fn();
const mockHealth = jest.fn();

const mockModels = {
  Conversation: { modelName: 'Conversation' },
  MemoryEntry: { modelName: 'MemoryEntry' },
  Message: { modelName: 'Message' },
  ViventiumPersonalAccountCleanupReceipt: { modelName: 'CleanupReceipt' },
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
  createExactMeiliCleanupAdapter: (...args) => mockCreateSearchAdapter(...args),
  createPersonalAccountCleanupRuntime: (...args) => mockCreateRuntime(...args),
  createPersonalAccountCleanupScheduleAdapter: (...args) => mockCreateScheduleAdapter(...args),
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
    mockCreateScheduleAdapter.mockReturnValue({ name: 'schedule-adapter' });
    mockLoadVerifier.mockReturnValue(jest.fn());
    mockCreateRuntime.mockReturnValue({
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

  test('binds legacy dependencies once to the package-owned typed runtime', async () => {
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

    expect(mockCreateRuntime).toHaveBeenCalledTimes(1);
    expect(mockCreateRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        Conversation: mockModels.Conversation,
        MemoryEntry: mockModels.MemoryEntry,
        Message: mockModels.Message,
        receiptModel: mockModels.ViventiumPersonalAccountCleanupReceipt,
        search: { name: 'search-adapter' },
        schedules: { name: 'schedule-adapter' },
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
    expect(mockCreateRuntime).not.toHaveBeenCalled();
  });
});
