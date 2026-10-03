import {
  configureOrchestrationReadiness,
  observeOrchestrationOwner,
  orchestrationReadinessSnapshot,
  refreshOrchestrationReadiness,
  resetOrchestrationReadinessForTests,
  authoringOrchestrationReadiness,
  waitForOrchestrationReadiness,
} from './orchestrationReadiness';

const originalEnv = { ...process.env };
const ownerId = 'synthetic-owner';
const requestAccountApi = jest.fn();
const getAgent = jest.fn();
const checkPermission = jest.fn();
const logger = { warn: jest.fn(), info: jest.fn() };

function readyCapability() {
  return {
    policyVersion: 1,
    isolatedParallelReady: true,
    hostMissionsAllowed: false,
    hostMissionsActive: 0,
    storagePressure: {
      version: 1,
      status: 'healthy',
      usedPercent: 50,
      availableBytes: 10_000_000_000,
      thresholdPercent: 99,
    },
    promptLayers: {
      contractVersion: 1,
      producerScope: 'glasshive.worker_prompt_registry',
      unknownLayerNames: [],
    },
    workTraceContract: {
      contractVersion: 1,
      schemaDigest: 'sha256:ba9b15e022a451c62be0c0f30a02d6615bea83e868b2ffdd349beff75002e790',
      producerSourceIdentity: 'workers_projects_runtime.api:get_active_work',
      emittedKeySetDigest:
        'sha256:3a109b0f41a08755252a050e444dd6780e7bf95aec194ad95628e4e7a5c3a253',
    },
  };
}

function seed(status: string, reason = '', ageMs = 0) {
  resetOrchestrationReadinessForTests({
    ownerId,
    status,
    reason,
    checkedAtMs: Date.now() - ageMs,
  });
}

describe('per-turn owner readiness', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 100_000 });
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      VIVENTIUM_PARALLEL_WORK_AVAILABLE: 'true',
      VIVENTIUM_MAIN_AGENT_ID: 'synthetic-main',
      VIVENTIUM_PARALLEL_WORK_READINESS_MAX_AGE_MS: '2000',
    };
    delete process.env.VIVENTIUM_PARALLEL_WORK_EXECUTION_MODE;
    resetOrchestrationReadinessForTests();
    requestAccountApi.mockResolvedValue(readyCapability());
    getAgent.mockResolvedValue({
      id: 'synthetic-main',
      glasshive_options: { orchestration: { parallel_available: true } },
      tools: [
        'worker_delegate_once_mcp_glasshive-workers-projects',
        'active_work_list',
        'active_work_action',
      ],
    });
    checkPermission.mockResolvedValue(true);
    configureOrchestrationReadiness({
      logger,
      requestAccountApi,
      getAgent,
      checkPermission,
      findUser: async () => ({ _id: ownerId }),
      getSourceOrderCapabilities: () => ({ durability: 'durable', replica_safe: true }),
      promptLayerIntegritySnapshot: () => ({ contractVersion: 1, unknownLayerNames: [] }),
    });
  });

  afterEach(() => {
    resetOrchestrationReadinessForTests();
    jest.useRealTimers();
    process.env = { ...originalEnv };
  });

  test.each([
    ['unready', 'storage_pressure_critical'],
    ['unready', 'parallel_clean_room_proxy_unhealthy'],
    ['unavailable', 'readiness_unavailable'],
    ['capacity_limited', 'readiness_probe_capacity_limited'],
  ])('reuses fresh %s / %s without waiting or probing', async (status, reason) => {
    seed(status, reason);
    let settled = false;
    const pending = authoringOrchestrationReadiness({ ownerId, timeoutMs: 15_000 });
    void pending.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    await expect(pending).resolves.toMatchObject({ available: false, status, reason });
    expect(requestAccountApi).not.toHaveBeenCalled();
    expect(getAgent).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('reuses a fresh ready owner without a probe', async () => {
    seed('ready');
    await expect(authoringOrchestrationReadiness({ ownerId })).resolves.toMatchObject({
      available: true,
      status: 'ready',
    });
    expect(requestAccountApi).not.toHaveBeenCalled();
  });

  test.each(['unknown', 'stale-ready', 'stale-unready'])(
    'refreshes %s once so the first usable turn retains Parallel capabilities',
    async (state) => {
      if (state !== 'unknown') seed(state === 'stale-ready' ? 'ready' : 'unready', '', 2_001);
      await expect(authoringOrchestrationReadiness({ ownerId })).resolves.toMatchObject({
        available: true,
        status: 'ready',
      });
      expect(requestAccountApi).toHaveBeenCalledTimes(1);
      expect(requestAccountApi).toHaveBeenCalledWith({
        ownerId,
        path: '/v1/orchestration-capabilities',
        timeoutMs: 1000,
      });
      expect(checkPermission).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId }));
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  test.each(['critical', 'capability-timeout'])(
    'returns the first observed %s result instead of retrying it for fifteen seconds',
    async (failure) => {
      if (failure === 'critical') {
        requestAccountApi.mockResolvedValue({
          ...readyCapability(),
          isolatedParallelReady: false,
          isolatedParallelReason: 'storage_pressure_critical',
          storagePressure: {
            version: 1,
            status: 'critical',
            usedPercent: 99.2,
            availableBytes: 7_000_000_000,
            thresholdPercent: 99,
          },
        });
      } else {
        requestAccountApi.mockRejectedValue(
          Object.assign(new Error('private diagnostic'), {
            name: 'TimeoutError',
            code: 23,
          }),
        );
      }
      let settled = false;
      const pending = authoringOrchestrationReadiness({ ownerId, timeoutMs: 15_000 });
      void pending.then(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(0);

      expect(settled).toBe(true);
      await expect(pending).resolves.toMatchObject({
        available: false,
        status: failure === 'critical' ? 'unready' : 'unavailable',
        reason: failure === 'critical' ? 'storage_pressure_critical' : 'readiness_unavailable',
      });
      expect(requestAccountApi).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  test.each(['capability', 'agent-permission'])(
    'bounds cold readiness when the %s child does not settle',
    async (child) => {
      let release: (value: object | boolean) => void = () => undefined;
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      if (child === 'capability') requestAccountApi.mockReturnValue(blocked);
      else checkPermission.mockReturnValue(blocked);
      const pending = authoringOrchestrationReadiness({ ownerId, timeoutMs: 250 });
      await jest.advanceTimersByTimeAsync(250);

      await expect(pending).resolves.toMatchObject({ available: false, status: 'stale' });
      release(child === 'capability' ? readyCapability() : true);
      await jest.advanceTimersByTimeAsync(0);
      // A later watcher observation may recover, but cannot change the returned turn snapshot.
      await expect(pending).resolves.toMatchObject({ available: false, status: 'stale' });
      expect(orchestrationReadinessSnapshot({ ownerId }).available).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  test("does not borrow another owner's ready observation", async () => {
    seed('ready');
    checkPermission.mockResolvedValue(false);
    await expect(
      authoringOrchestrationReadiness({ ownerId: 'different-owner' }),
    ).resolves.toMatchObject({
      available: false,
      reason: 'main_agent_unavailable',
    });
    expect(requestAccountApi).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'different-owner' }),
    );
  });

  test('early observation overlaps preparation and retains cold first-use Parallel', async () => {
    requestAccountApi.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(readyCapability()), 1000);
        }),
    );
    expect(observeOrchestrationOwner(ownerId).available).toBe(false);
    await jest.advanceTimersByTimeAsync(950);

    const pending = authoringOrchestrationReadiness({ ownerId });
    await jest.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toMatchObject({ available: true, status: 'ready' });
    expect(requestAccountApi).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('cold over-budget authoring stays unavailable and the next turn uses recovery', async () => {
    requestAccountApi.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(readyCapability()), 1000);
        }),
    );
    const start = Date.now();
    const pending = authoringOrchestrationReadiness({ ownerId });
    await jest.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({ available: false, status: 'stale' });
    expect(Date.now() - start).toBe(100);

    await jest.advanceTimersByTimeAsync(900);
    await expect(pending).resolves.toMatchObject({ available: false, status: 'stale' });
    await expect(authoringOrchestrationReadiness({ ownerId })).resolves.toMatchObject({
      available: true,
      status: 'ready',
    });
    expect(requestAccountApi).toHaveBeenCalledTimes(1);
  });

  test('concurrent cold consumers join the same owned probe without duplicate requests', async () => {
    requestAccountApi.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(readyCapability()), 50);
        }),
    );
    const telegram = authoringOrchestrationReadiness({ ownerId, consumer: 'telegram' });
    const tools = authoringOrchestrationReadiness({ ownerId, consumer: 'tool_discovery' });
    await jest.advanceTimersByTimeAsync(50);
    await expect(Promise.all([telegram, tools])).resolves.toEqual([
      expect.objectContaining({ available: true }),
      expect.objectContaining({ available: true }),
    ]);
    expect(requestAccountApi).toHaveBeenCalledTimes(1);
    expect(checkPermission).toHaveBeenCalledTimes(1);
  });

  test('uses the existing configured Active Work cold budget', async () => {
    process.env.VIVENTIUM_ACTIVE_WORK_COLD_TIMEOUT_MS = '30';
    requestAccountApi.mockReturnValue(new Promise(() => undefined));
    const start = Date.now();
    const pending = authoringOrchestrationReadiness({ ownerId });
    await jest.advanceTimersByTimeAsync(30);
    await expect(pending).resolves.toMatchObject({ available: false });
    expect(Date.now() - start).toBe(30);
  });

  test('explicit warm-up retains its existing transient recovery wait', async () => {
    requestAccountApi
      .mockResolvedValueOnce({
        ...readyCapability(),
        isolatedParallelReady: false,
        isolatedParallelReason: 'parallel_clean_room_proxy_unhealthy',
      })
      .mockResolvedValueOnce(readyCapability());
    const pending = waitForOrchestrationReadiness({ ownerId, timeoutMs: 1000, pollIntervalMs: 50 });
    await jest.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toMatchObject({ available: true, status: 'ready' });
    expect(requestAccountApi).toHaveBeenCalledTimes(2);
  });

  test('retains typed numeric storage facts in fresh failure timing', async () => {
    requestAccountApi.mockResolvedValue({
      ...readyCapability(),
      storagePressure: {
        version: 1,
        status: 'critical',
        usedPercent: 99.2,
        availableBytes: 7_000_000_000,
        thresholdPercent: 99,
      },
    });
    await refreshOrchestrationReadiness({ ownerId });
    logger.info.mockClear();
    await authoringOrchestrationReadiness({ ownerId, sourceId: 'synthetic-source' });
    const record = JSON.parse(logger.info.mock.calls[0][0].split('] ').at(-1));
    expect(record).toMatchObject({
      stage: 'turn_readiness',
      probeCount: 0,
      storagePressure: {
        status: 'critical',
        usedPercent: 99.2,
        availableBytes: 7_000_000_000,
        thresholdPercent: 99,
      },
    });
    expect(record.ownerHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(record)).not.toContain('synthetic-source');
  });

  test('disabled and ownerless callers do no readiness work', async () => {
    await expect(authoringOrchestrationReadiness()).resolves.toMatchObject({
      status: 'owner_required',
    });
    process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE = 'false';
    await expect(authoringOrchestrationReadiness({ ownerId })).resolves.toMatchObject({
      status: 'disabled',
    });
    expect(requestAccountApi).not.toHaveBeenCalled();
    expect(getAgent).not.toHaveBeenCalled();
  });

  test('logs content-free wait and probe measurements as retained structured messages', async () => {
    requestAccountApi.mockRejectedValue(
      Object.assign(new Error('private diagnostic'), {
        name: 'TimeoutError',
        code: 23,
      }),
    );
    const pending = authoringOrchestrationReadiness({ ownerId, timeoutMs: 250 });
    await jest.advanceTimersByTimeAsync(250);
    await pending;
    const records = logger.info.mock.calls.map(([message]) =>
      JSON.parse(message.split('] ').at(-1)),
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'readiness_probe',
          status: 'unavailable',
          diagnosticCode: '23',
          errorClass: 'timeouterror',
        }),
        expect.objectContaining({
          stage: 'turn_readiness',
          status: 'unavailable',
          probeCount: 1,
          elapsedMs: expect.any(Number),
          timeoutMs: 250,
        }),
      ]),
    );
    const encoded = JSON.stringify(logger.info.mock.calls);
    expect(encoded).not.toContain(ownerId);
    expect(encoded).not.toContain('private diagnostic');
  });
});
