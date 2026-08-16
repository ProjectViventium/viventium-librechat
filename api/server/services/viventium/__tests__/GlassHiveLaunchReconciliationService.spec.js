/* === VIVENTIUM START ===
 * Feature: Restart-safe GlassHive launch response reconciliation scheduling.
 * === VIVENTIUM END === */

const mockReconcileUnknownGlassHiveLaunches = jest.fn();
const mockReconcileKnownExternalWorkHints = jest.fn();
const mockReconcileUnresolvedDeliveries = jest.fn();
const mockEnsureExternalWorkIndexes = jest.fn();

jest.mock('../GlassHiveCallbackBindingService', () => ({
  reconcileKnownExternalWorkHints: (...args) => mockReconcileKnownExternalWorkHints(...args),
  reconcileUnknownGlassHiveLaunches: (...args) =>
    mockReconcileUnknownGlassHiveLaunches(...args),
}));

jest.mock('../GlassHiveCallbackDeliveryService', () => ({
  reconcileUnresolvedGlassHiveCallbackDeliveries: (...args) =>
    mockReconcileUnresolvedDeliveries(...args),
}));

jest.mock('../GlassHiveActiveWorkProjectionService', () => ({
  ensureGlassHiveExternalWorkIndexes: (...args) => mockEnsureExternalWorkIndexes(...args),
}));

const {
  launchReconciliationIntervalMs,
  runGlassHiveLaunchReconciliation,
  startGlassHiveLaunchReconciliation,
  stopGlassHiveLaunchReconciliationForTests,
} = require('../GlassHiveLaunchReconciliationService');

describe('GlassHiveLaunchReconciliationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    stopGlassHiveLaunchReconciliationForTests();
    delete process.env.VIVENTIUM_GLASSHIVE_LAUNCH_RECONCILIATION_INTERVAL_MS;
    mockReconcileUnknownGlassHiveLaunches.mockResolvedValue({ scanned: 0, repaired: 0, pending: 0 });
    mockReconcileKnownExternalWorkHints.mockResolvedValue({ scanned: 0, updatedOwners: 0 });
    mockReconcileUnresolvedDeliveries.mockResolvedValue({ scanned: 0, repaired: 0, pending: 0 });
    mockEnsureExternalWorkIndexes.mockResolvedValue(undefined);
  });

  afterEach(() => {
    stopGlassHiveLaunchReconciliationForTests();
    jest.useRealTimers();
  });

  test('runs a bounded all-owner repair at startup and periodically', async () => {
    const started = startGlassHiveLaunchReconciliation();
    expect(started).toEqual({ started: true, intervalMs: 30_000 });
    await Promise.resolve();
    expect(mockEnsureExternalWorkIndexes).toHaveBeenCalledTimes(1);
    expect(mockReconcileUnknownGlassHiveLaunches).toHaveBeenCalledWith({ limit: 25 });
    expect(mockReconcileKnownExternalWorkHints).toHaveBeenCalledWith({ limit: 100 });
    expect(mockReconcileUnresolvedDeliveries).toHaveBeenCalledWith({ limit: 25 });

    await jest.advanceTimersByTimeAsync(30_000);
    expect(mockReconcileUnknownGlassHiveLaunches).toHaveBeenCalledTimes(2);
    expect(mockReconcileKnownExternalWorkHints).toHaveBeenCalledTimes(2);
    expect(mockReconcileUnknownGlassHiveLaunches).toHaveBeenLastCalledWith({ limit: 25 });
  });

  test('bounds configuration and prevents overlapping scans', async () => {
    process.env.VIVENTIUM_GLASSHIVE_LAUNCH_RECONCILIATION_INTERVAL_MS = '1';
    expect(launchReconciliationIntervalMs()).toBe(1_000);
    process.env.VIVENTIUM_GLASSHIVE_LAUNCH_RECONCILIATION_INTERVAL_MS = '99999999';
    expect(launchReconciliationIntervalMs()).toBe(15 * 60_000);

    let release;
    mockReconcileUnknownGlassHiveLaunches.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const first = runGlassHiveLaunchReconciliation();
    await expect(runGlassHiveLaunchReconciliation()).resolves.toEqual({ skipped: 'in_flight' });
    expect(mockReconcileUnknownGlassHiveLaunches).toHaveBeenCalledTimes(1);
    release({ scanned: 1, repaired: 1, pending: 0 });
    await expect(first).resolves.toEqual({
      launches: { scanned: 1, repaired: 1, pending: 0 },
      hints: { scanned: 0, updatedOwners: 0 },
      deliveries: { scanned: 0, repaired: 0, pending: 0 },
    });
  });

  test('starts only one timer per process', () => {
    expect(startGlassHiveLaunchReconciliation().started).toBe(true);
    expect(startGlassHiveLaunchReconciliation()).toEqual({
      started: false,
      intervalMs: 30_000,
    });
  });
});
