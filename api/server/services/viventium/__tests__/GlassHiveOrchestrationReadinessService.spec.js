const mockFindUser = jest.fn();
const mockRequestAccountApi = jest.fn();

jest.mock('~/models', () => ({ findUser: (...args) => mockFindUser(...args) }));
jest.mock('../GlassHiveAccountService', () => ({
  requestAccountApi: (...args) => mockRequestAccountApi(...args),
}));

const {
  observeOrchestrationOwner,
  orchestrationReadinessSnapshot,
  refreshOrchestrationReadiness,
  resetOrchestrationReadinessForTests,
  startOrchestrationReadinessWatcher,
} = require('../GlassHiveOrchestrationReadinessService');

describe('GlassHiveOrchestrationReadinessService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      VIVENTIUM_PARALLEL_WORK_AVAILABLE: 'true',
      VIVENTIUM_PARALLEL_WORK_READINESS_MAX_AGE_MS: '2000',
      VIVENTIUM_PARALLEL_WORK_READINESS_INTERVAL_MS: '1000',
    };
    resetOrchestrationReadinessForTests();
    mockFindUser.mockResolvedValue({ _id: 'user-1' });
    mockRequestAccountApi.mockResolvedValue({
      policyVersion: 1,
      isolatedParallelReady: true,
      hostMissionsAllowed: false,
      hostMissionsActive: 0,
    });
  });

  afterEach(() => resetOrchestrationReadinessForTests());
  afterAll(() => {
    process.env = originalEnv;
  });

  test('does zero GlassHive work when the deployment request flag is off', async () => {
    process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE = 'false';

    expect(observeOrchestrationOwner('user-1')).toMatchObject({
      requested: false,
      available: false,
      status: 'disabled',
    });
    await refreshOrchestrationReadiness({ ownerId: 'user-1' });
    expect(startOrchestrationReadinessWatcher()).toMatchObject({
      started: false,
      reason: 'disabled',
    });
    expect(mockRequestAccountApi).not.toHaveBeenCalled();
  });

  test('publishes ready only after the exact isolated no-host invariant is observed', async () => {
    expect(orchestrationReadinessSnapshot().available).toBe(false);
    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(mockRequestAccountApi).toHaveBeenCalledWith({
      ownerId: 'user-1',
      path: '/v1/orchestration-capabilities',
      timeoutMs: 1000,
    });
    expect(orchestrationReadinessSnapshot()).toMatchObject({
      requested: true,
      available: true,
      status: 'ready',
    });
  });

  test('uses the fresh local snapshot with no per-turn request and expires it fail-closed', async () => {
    await refreshOrchestrationReadiness({ ownerId: 'user-1' });
    mockRequestAccountApi.mockClear();

    expect(observeOrchestrationOwner('user-1').available).toBe(true);
    expect(observeOrchestrationOwner('user-1').available).toBe(true);
    expect(mockRequestAccountApi).not.toHaveBeenCalled();
    expect(orchestrationReadinessSnapshot({ nowMs: Date.now() + 2_001 })).toMatchObject({
      available: false,
      status: 'stale',
    });
  });

  test('transitions unready to ready through the periodic watcher without blocking a turn', async () => {
    jest.useFakeTimers();
    try {
      mockRequestAccountApi
        .mockResolvedValueOnce({
          policyVersion: 1,
          isolatedParallelReady: false,
          isolatedParallelReason: 'parallel_clean_room_network_unconfigured',
          hostMissionsAllowed: false,
          hostMissionsActive: 1,
        })
        .mockResolvedValueOnce({
          policyVersion: 1,
          isolatedParallelReady: true,
          hostMissionsAllowed: false,
          hostMissionsActive: 0,
        });

      expect(startOrchestrationReadinessWatcher()).toMatchObject({ started: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(orchestrationReadinessSnapshot().available).toBe(false);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(orchestrationReadinessSnapshot()).toMatchObject({ available: true, status: 'ready' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('retries startup owner discovery instead of remaining unknown forever', async () => {
    jest.useFakeTimers();
    try {
      mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: 'user-1' });

      expect(startOrchestrationReadinessWatcher()).toMatchObject({ started: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(mockRequestAccountApi).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1_000);

      expect(mockFindUser).toHaveBeenCalledTimes(2);
      expect(mockRequestAccountApi).toHaveBeenCalledWith({
        ownerId: 'user-1',
        path: '/v1/orchestration-capabilities',
        timeoutMs: 1000,
      });
      expect(orchestrationReadinessSnapshot()).toMatchObject({
        available: true,
        status: 'ready',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test('preserves a bounded isolation failure reason for diagnostics', async () => {
    mockRequestAccountApi.mockResolvedValueOnce({
      policyVersion: 1,
      isolatedParallelReady: false,
      isolatedParallelReason: 'parallel_clean_room_network_unconfigured',
      hostMissionsAllowed: false,
      hostMissionsActive: 0,
    });

    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(orchestrationReadinessSnapshot()).toMatchObject({
      available: false,
      status: 'unready',
      reason: 'parallel_clean_room_network_unconfigured',
    });
  });
});
