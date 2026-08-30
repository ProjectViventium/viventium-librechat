const mockFindUser = jest.fn();
const mockRequestAccountApi = jest.fn();
const mockGetAgent = jest.fn();
const mockCheckPermission = jest.fn();
const mockPromptLayerIntegritySnapshot = jest.fn();
const mockGetSourceOrderCapabilities = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: (...args) => mockLoggerWarn(...args) },
}));

jest.mock('~/models', () => ({ findUser: (...args) => mockFindUser(...args) }));
jest.mock('~/models/Agent', () => ({ getAgent: (...args) => mockGetAgent(...args) }));
jest.mock('~/server/services/PermissionService', () => ({
  checkPermission: (...args) => mockCheckPermission(...args),
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  GenerationJobManager: {
    getSourceOrderCapabilities: (...args) => mockGetSourceOrderCapabilities(...args),
  },
}));
jest.mock('../GlassHiveAccountService', () => ({
  requestAccountApi: (...args) => mockRequestAccountApi(...args),
}));
jest.mock('../promptFrameTelemetry', () => ({
  promptLayerIntegritySnapshot: (...args) => mockPromptLayerIntegritySnapshot(...args),
}));

const {
  observeOrchestrationOwner,
  orchestrationDeploymentReadinessSnapshot,
  orchestrationReadinessSnapshot,
  refreshStartupOrchestrationReadiness,
  refreshOrchestrationReadiness,
  resetOrchestrationReadinessForTests,
  startOrchestrationReadinessWatcher,
  waitForOrchestrationReadiness,
} = require('../GlassHiveOrchestrationReadinessService');

const healthyStorage = Object.freeze({
  version: 1,
  status: 'healthy',
  usedPercent: 50,
  availableBytes: 10_000_000_000,
  thresholdPercent: 95,
});
const verifiedPromptLayers = Object.freeze({
  contractVersion: 1,
  producerScope: 'glasshive.worker_prompt_registry',
  unknownLayerNames: [],
});
const verifiedWorkTraceContract = Object.freeze({
  contractVersion: 1,
  schemaDigest: 'sha256:ba9b15e022a451c62be0c0f30a02d6615bea83e868b2ffdd349beff75002e790',
  producerSourceIdentity: 'workers_projects_runtime.api:get_active_work',
  emittedKeySetDigest: 'sha256:3a109b0f41a08755252a050e444dd6780e7bf95aec194ad95628e4e7a5c3a253',
});
const deploymentScope = Object.freeze({
  contractVersion: 1,
  scope: 'deployment',
  ownerCredentialRole: 'transport_auth',
});

function readyCapability(overrides = {}) {
  return {
    policyVersion: 1,
    isolatedParallelReady: true,
    hostMissionsAllowed: false,
    hostMissionsActive: 0,
    storagePressure: healthyStorage,
    promptLayers: verifiedPromptLayers,
    workTraceContract: verifiedWorkTraceContract,
    ...overrides,
  };
}

function deploymentReadyCapability(overrides = {}) {
  return readyCapability({ readinessScope: deploymentScope, ...overrides });
}

describe('GlassHiveOrchestrationReadinessService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      VIVENTIUM_PARALLEL_WORK_AVAILABLE: 'true',
      VIVENTIUM_MAIN_AGENT_ID: 'agent-main',
      VIVENTIUM_PARALLEL_WORK_READINESS_MAX_AGE_MS: '2000',
      VIVENTIUM_PARALLEL_WORK_READINESS_INTERVAL_MS: '1000',
      VIVENTIUM_PARALLEL_WORK_READINESS_MAX_IN_FLIGHT: '2',
      VIVENTIUM_PARALLEL_WORK_OWNER_IDLE_TTL_MS: '1500',
    };
    resetOrchestrationReadinessForTests();
    mockFindUser.mockResolvedValue({ _id: 'user-1' });
    mockCheckPermission.mockResolvedValue(true);
    mockPromptLayerIntegritySnapshot.mockReturnValue({
      contractVersion: 1,
      unknownLayerNames: [],
    });
    mockGetSourceOrderCapabilities.mockReturnValue({
      durability: 'durable',
      replica_safe: true,
    });
    mockGetAgent.mockResolvedValue({
      id: 'agent-main',
      glasshive_options: { orchestration: { parallel_available: true } },
      tools: [
        'worker_delegate_once_mcp_glasshive-workers-projects',
        'active_work_list',
        'active_work_action',
      ],
    });
    mockRequestAccountApi.mockResolvedValue(readyCapability());
  });

  test.each([
    {
      label: 'the configured Main agent is missing',
      agent: null,
      reason: 'main_agent_unavailable',
    },
    {
      label: 'the configured Main agent does not declare orchestration',
      agent: {
        id: 'agent-main',
        tools: [
          'worker_delegate_once_mcp_glasshive-workers-projects',
          'active_work_list',
          'active_work_action',
        ],
      },
      reason: 'main_agent_undeclared',
    },
    {
      label: 'the configured Main agent is missing a facade tool',
      agent: {
        id: 'agent-main',
        glasshive_options: { orchestration: { parallel_available: true } },
        tools: ['worker_delegate_once_mcp_glasshive-workers-projects', 'active_work_list'],
      },
      reason: 'main_agent_tools_missing',
    },
  ])('fails closed when $label', async ({ agent, reason }) => {
    mockGetAgent.mockResolvedValueOnce(agent);

    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(mockGetAgent).toHaveBeenCalledWith({ id: 'agent-main' });
    expect(orchestrationReadinessSnapshot({ ownerId: 'user-1' })).toMatchObject({
      requested: true,
      available: false,
      status: 'unready',
      reason,
    });
  });

  test('fails closed when source ordering is only process-local', async () => {
    mockGetSourceOrderCapabilities.mockReturnValueOnce({
      durability: 'process',
      replica_safe: false,
    });

    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(orchestrationReadinessSnapshot({ ownerId: 'user-1' })).toMatchObject({
      requested: true,
      available: false,
      status: 'unready',
      reason: 'source_order_not_durable',
      sourceOrder: {
        status: 'unavailable',
        durability: 'process',
        replicaSafe: false,
      },
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
    expect(orchestrationReadinessSnapshot({ ownerId: 'user-1' }).available).toBe(false);
    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(mockRequestAccountApi).toHaveBeenCalledWith({
      ownerId: 'user-1',
      path: '/v1/orchestration-capabilities',
      timeoutMs: 1000,
    });
    expect(orchestrationReadinessSnapshot({ ownerId: 'user-1' })).toMatchObject({
      requested: true,
      available: true,
      status: 'ready',
    });
  });

  test('fails readiness when typed prompt telemetry reports unknown layers', async () => {
    mockRequestAccountApi.mockResolvedValueOnce(
      readyCapability({
        promptLayers: {
          contractVersion: 1,
          producerScope: 'glasshive.worker_prompt_registry',
          unknownLayerNames: ['unexpected_layer'],
        },
      }),
    );

    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(orchestrationReadinessSnapshot({ ownerId: 'user-1' })).toMatchObject({
      available: false,
      status: 'unready',
      reason: 'prompt_layers_unknown',
      promptLayers: { status: 'unknown', unknownLayerCount: 1 },
    });
  });

  test.each([
    ['missing', undefined, 'work_trace_contract_missing'],
    [
      'wrong producer',
      { ...verifiedWorkTraceContract, producerSourceIdentity: 'unknown.producer' },
      'work_trace_contract_invalid',
    ],
    [
      'wrong schema digest',
      { ...verifiedWorkTraceContract, schemaDigest: `sha256:${'0'.repeat(64)}` },
      'work_trace_contract_invalid',
    ],
    [
      'wrong emitted key set',
      { ...verifiedWorkTraceContract, emittedKeySetDigest: `sha256:${'0'.repeat(64)}` },
      'work_trace_contract_invalid',
    ],
  ])('fails readiness when the work trace contract is %s', async (_label, contract, reason) => {
    mockRequestAccountApi.mockResolvedValueOnce(readyCapability({ workTraceContract: contract }));

    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(orchestrationReadinessSnapshot({ ownerId: 'user-1' })).toMatchObject({
      available: false,
      status: 'unready',
      reason,
      workTraceContract: { status: 'unknown', reason },
    });
  });

  test('fails readiness on an explicit prompt mismatch even when unknown names are empty', async () => {
    mockRequestAccountApi.mockResolvedValueOnce(
      readyCapability({
        promptLayers: {
          contractVersion: 1,
          producerScope: 'glasshive.worker_prompt_registry',
          status: 'mismatch',
          unknownLayerNames: [],
          reason: 'prompt_layer_hash_mismatch',
        },
      }),
    );

    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(orchestrationReadinessSnapshot({ ownerId: 'user-1' })).toMatchObject({
      available: false,
      status: 'unready',
      reason: 'prompt_layer_hash_mismatch',
      promptLayers: { status: 'mismatch', unknownLayerCount: 0 },
    });
  });

  test('allows typed storage warnings for measured operational preflight', async () => {
    mockRequestAccountApi.mockResolvedValueOnce(
      readyCapability({
        storagePressure: {
          ...healthyStorage,
          status: 'warning',
          usedPercent: 80,
        },
      }),
    );

    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(orchestrationReadinessSnapshot({ ownerId: 'user-1' })).toMatchObject({
      available: true,
      status: 'ready',
      storagePressure: { status: 'warning' },
    });
  });

  test('fails at measured storage pressure without exposing a path', async () => {
    mockRequestAccountApi.mockResolvedValueOnce(
      readyCapability({
        storagePressure: {
          version: 1,
          status: 'critical',
          usedPercent: 99.1,
          availableBytes: 912_680_550,
          thresholdPercent: 95,
          path: '/private/host/storage',
        },
      }),
    );

    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    const snapshot = orchestrationReadinessSnapshot({ ownerId: 'user-1' });
    expect(snapshot).toMatchObject({
      available: false,
      status: 'unready',
      reason: 'storage_pressure',
      storagePressure: {
        status: 'critical',
        usedPercent: 99.1,
        availableBytes: 912_680_550,
        thresholdPercent: 95,
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('/private/host/storage');
  });

  test('fails when typed storage explicitly reports critical pressure', async () => {
    mockRequestAccountApi.mockResolvedValueOnce(
      readyCapability({
        storagePressure: {
          ...healthyStorage,
          status: 'critical',
        },
      }),
    );

    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(orchestrationReadinessSnapshot({ ownerId: 'user-1' })).toMatchObject({
      available: false,
      status: 'unready',
      reason: 'storage_pressure',
      storagePressure: { status: 'critical' },
    });
  });

  test('fails closed when remote prompt-layer telemetry is omitted', async () => {
    mockRequestAccountApi.mockResolvedValueOnce(readyCapability({ promptLayers: undefined }));

    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(orchestrationReadinessSnapshot({ ownerId: 'user-1' })).toMatchObject({
      available: false,
      status: 'unready',
      reason: 'prompt_layer_capability_missing',
      promptLayers: { status: 'unknown', reason: 'prompt_layer_capability_missing' },
    });
  });

  test('fails closed on arbitrary unavailable remote prompt-layer telemetry', async () => {
    mockRequestAccountApi.mockResolvedValueOnce(
      readyCapability({
        promptLayers: {
          version: 1,
          available: false,
          reason: 'trusted_prompt_telemetry_unavailable',
        },
      }),
    );

    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(orchestrationReadinessSnapshot({ ownerId: 'user-1' })).toMatchObject({
      available: false,
      status: 'unready',
      reason: 'prompt_layer_capability_invalid',
      promptLayers: { status: 'unknown', reason: 'prompt_layer_capability_invalid' },
    });
  });

  test('fails closed when remote prompt telemetry lacks its typed producer scope', async () => {
    mockRequestAccountApi.mockResolvedValueOnce(
      readyCapability({
        promptLayers: { contractVersion: 1, unknownLayerNames: [] },
      }),
    );

    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(orchestrationReadinessSnapshot({ ownerId: 'user-1' })).toMatchObject({
      available: false,
      status: 'unready',
      reason: 'prompt_layer_capability_invalid',
    });
  });

  test('requires typed local and remote prompt-layer integrity', async () => {
    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(orchestrationReadinessSnapshot({ ownerId: 'user-1' })).toMatchObject({
      available: true,
      status: 'ready',
      storagePressure: { status: 'healthy' },
      promptLayers: { status: 'verified', unknownLayerCount: 0 },
    });
  });

  test('accepts the typed GlassHive storage state shape', async () => {
    mockRequestAccountApi.mockResolvedValueOnce(
      readyCapability({
        storagePressure: {
          version: 1,
          state: 'healthy',
          healthy: true,
          usedPercent: 50,
          availableBytes: 10_000_000_000,
          thresholdPercent: 95,
        },
      }),
    );

    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(orchestrationReadinessSnapshot({ ownerId: 'user-1' })).toMatchObject({
      available: true,
      status: 'ready',
      storagePressure: { status: 'healthy' },
    });
  });

  test.each([
    ['missing', undefined, 'storage_capability_missing'],
    ['invalid', { version: 1, usedPercent: -1 }, 'storage_capability_invalid'],
    [
      'an invalid typed status',
      { ...healthyStorage, status: 'unexpected' },
      'storage_capability_invalid',
    ],
    ['contradictory', { ...healthyStorage, healthy: false }, 'storage_capability_invalid'],
  ])('fails closed when typed storage telemetry is %s', async (_label, storagePressure, reason) => {
    mockRequestAccountApi.mockResolvedValueOnce(readyCapability({ storagePressure }));

    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(orchestrationReadinessSnapshot({ ownerId: 'user-1' })).toMatchObject({
      available: false,
      status: 'unready',
      reason,
      storagePressure: { status: 'unknown', reason },
    });
  });

  test.each([
    [
      'unknown',
      { contractVersion: 1, unknownLayerNames: ['unregistered_local_layer'] },
      'prompt_layers_unknown',
    ],
    ['invalid', { contractVersion: 2, unknownLayerNames: [] }, 'prompt_layer_capability_invalid'],
  ])('fails closed when local prompt-layer telemetry is %s', async (_label, local, reason) => {
    mockPromptLayerIntegritySnapshot.mockReturnValueOnce(local);

    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(orchestrationReadinessSnapshot({ ownerId: 'user-1' })).toMatchObject({
      available: false,
      status: 'unready',
      reason,
    });
  });

  test('requires an explicit owner for account snapshots, refreshes, observes, and waits', async () => {
    await expect(refreshOrchestrationReadiness()).resolves.toMatchObject({
      available: false,
      status: 'owner_required',
      reason: 'owner_required',
    });
    await expect(waitForOrchestrationReadiness()).resolves.toMatchObject({
      available: false,
      status: 'owner_required',
    });
    expect(observeOrchestrationOwner()).toMatchObject({
      available: false,
      status: 'owner_required',
    });
    expect(orchestrationReadinessSnapshot()).toMatchObject({
      available: false,
      status: 'owner_required',
    });
    expect(mockRequestAccountApi).not.toHaveBeenCalled();
  });

  test('uses the fresh local snapshot with no per-turn request and expires it fail-closed', async () => {
    await refreshOrchestrationReadiness({ ownerId: 'user-1' });
    mockRequestAccountApi.mockClear();

    expect(observeOrchestrationOwner('user-1').available).toBe(true);
    expect(observeOrchestrationOwner('user-1').available).toBe(true);
    expect(mockRequestAccountApi).not.toHaveBeenCalled();
    expect(
      orchestrationReadinessSnapshot({ ownerId: 'user-1', nowMs: Date.now() + 2_001 }),
    ).toMatchObject({
      available: false,
      status: 'stale',
    });
  });

  test('returns a fresh owner-scoped snapshot without adding a blocking per-turn probe', async () => {
    await refreshOrchestrationReadiness({ ownerId: 'user-1' });
    mockRequestAccountApi.mockClear();

    await expect(waitForOrchestrationReadiness({ ownerId: 'user-1' })).resolves.toMatchObject({
      available: true,
      status: 'ready',
    });
    expect(mockRequestAccountApi).not.toHaveBeenCalled();
  });

  test('does not share readiness or in-flight truth between owners', async () => {
    await refreshOrchestrationReadiness({ ownerId: 'user-1' });
    mockRequestAccountApi.mockResolvedValueOnce(
      readyCapability({
        isolatedParallelReady: false,
        isolatedParallelReason: 'parallel_clean_room_proxy_unhealthy',
      }),
    );
    await refreshOrchestrationReadiness({ ownerId: 'user-2' });

    expect(orchestrationReadinessSnapshot({ ownerId: 'user-1' })).toMatchObject({
      available: true,
      status: 'ready',
    });
    expect(orchestrationReadinessSnapshot({ ownerId: 'user-2' })).toMatchObject({
      available: false,
      status: 'unready',
      reason: 'parallel_clean_room_proxy_unhealthy',
    });
  });

  test('does not share concurrent in-flight probes between owners', async () => {
    const pending = new Map();
    mockRequestAccountApi.mockImplementation(
      ({ ownerId }) =>
        new Promise((resolve) => {
          pending.set(ownerId, resolve);
        }),
    );

    const ownerOne = refreshOrchestrationReadiness({ ownerId: 'user-1' });
    const ownerTwo = refreshOrchestrationReadiness({ ownerId: 'user-2' });
    await Promise.resolve();

    pending.get('user-2')(readyCapability({ isolatedParallelReady: false }));
    await expect(ownerTwo).resolves.toMatchObject({ available: false, status: 'unready' });
    expect(orchestrationReadinessSnapshot({ ownerId: 'user-1' })).toMatchObject({
      available: false,
      status: 'stale',
    });

    pending.get('user-1')(readyCapability());
    await expect(ownerOne).resolves.toMatchObject({ available: true, status: 'ready' });
    expect(mockRequestAccountApi).toHaveBeenCalledTimes(2);
  });

  test('fails closed without making a request when the global owner-probe cap is full', async () => {
    const pending = new Map();
    mockRequestAccountApi.mockImplementation(
      ({ ownerId }) =>
        new Promise((resolve) => {
          pending.set(ownerId, resolve);
        }),
    );

    const ownerOne = refreshOrchestrationReadiness({ ownerId: 'user-1' });
    const ownerTwo = refreshOrchestrationReadiness({ ownerId: 'user-2' });
    await Promise.resolve();
    await expect(refreshOrchestrationReadiness({ ownerId: 'user-3' })).resolves.toMatchObject({
      available: false,
      status: 'capacity_limited',
      reason: 'readiness_probe_capacity_limited',
    });

    expect(mockRequestAccountApi).toHaveBeenCalledTimes(2);
    expect(mockRequestAccountApi).not.toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'user-3' }),
    );
    expect(mockGetAgent).toHaveBeenCalledTimes(2);
    expect(orchestrationReadinessSnapshot({ ownerId: 'user-3' })).toMatchObject({
      available: false,
      status: 'capacity_limited',
      reason: 'readiness_probe_capacity_limited',
    });

    pending.get('user-1')(readyCapability());
    pending.get('user-2')(readyCapability());
    await Promise.all([ownerOne, ownerTwo]);
  });

  test('transitions unready to ready through the periodic watcher without blocking a turn', async () => {
    jest.useFakeTimers();
    try {
      mockRequestAccountApi
        .mockResolvedValueOnce(
          deploymentReadyCapability({
            isolatedParallelReady: false,
            isolatedParallelReason: 'parallel_clean_room_network_unconfigured',
            hostMissionsActive: 1,
          }),
        )
        .mockResolvedValueOnce(deploymentReadyCapability());

      expect(startOrchestrationReadinessWatcher()).toMatchObject({ started: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(orchestrationDeploymentReadinessSnapshot().available).toBe(false);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(orchestrationDeploymentReadinessSnapshot()).toMatchObject({
        available: true,
        status: 'ready',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test('retries startup owner discovery instead of remaining unknown forever', async () => {
    jest.useFakeTimers();
    try {
      mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: 'user-1' });
      mockRequestAccountApi.mockResolvedValueOnce(deploymentReadyCapability());

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
      expect(orchestrationDeploymentReadinessSnapshot()).toMatchObject({
        available: true,
        status: 'ready',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test('preserves a bounded isolation failure reason for diagnostics', async () => {
    mockRequestAccountApi.mockResolvedValueOnce(
      readyCapability({
        isolatedParallelReady: false,
        isolatedParallelReason: 'parallel_clean_room_network_unconfigured',
      }),
    );

    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(orchestrationReadinessSnapshot({ ownerId: 'user-1' })).toMatchObject({
      available: false,
      status: 'unready',
      reason: 'parallel_clean_room_network_unconfigured',
    });
  });

  test('renders a sanitized owner failure code once and logs a changed code again', async () => {
    mockRequestAccountApi.mockRejectedValue(
      Object.assign(new Error('synthetic private detail'), {
        code: 'synthetic_readiness_timeout',
      }),
    );

    await refreshOrchestrationReadiness({ ownerId: 'user-1' });
    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn.mock.calls[0][0]).toContain('code=synthetic_readiness_timeout');
    expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain('synthetic private detail');

    mockRequestAccountApi.mockRejectedValue(
      Object.assign(new Error('another private detail'), {
        code: 'synthetic_connection_refused',
      }),
    );
    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
    expect(mockLoggerWarn.mock.calls[1][0]).toContain('code=synthetic_connection_refused');
  });

  test('renders one deployment failure code until the diagnostic changes', async () => {
    mockFindUser.mockResolvedValue({ _id: 'startup-owner' });
    mockRequestAccountApi.mockRejectedValue(
      Object.assign(new Error('synthetic private detail'), {
        code: 'synthetic_deployment_timeout',
      }),
    );

    await refreshStartupOrchestrationReadiness();
    await refreshStartupOrchestrationReadiness();

    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn.mock.calls[0][0]).toContain('code=synthetic_deployment_timeout');
  });

  test('logs storage warning only on entry or re-entry to the warning state', async () => {
    const warning = readyCapability({
      storagePressure: { ...healthyStorage, status: 'warning', usedPercent: 92 },
    });
    mockRequestAccountApi
      .mockResolvedValueOnce(warning)
      .mockResolvedValueOnce(warning)
      .mockResolvedValueOnce(readyCapability())
      .mockResolvedValueOnce(warning);

    await refreshOrchestrationReadiness({ ownerId: 'user-1' });
    await refreshOrchestrationReadiness({ ownerId: 'user-1' });
    await refreshOrchestrationReadiness({ ownerId: 'user-1' });
    await refreshOrchestrationReadiness({ ownerId: 'user-1' });

    const warnings = mockLoggerWarn.mock.calls.filter(([message]) =>
      message.includes('Storage pressure warning'),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings.every(([message]) => message.includes('code=storage_pressure'))).toBe(true);
  });

  test('expires an inactive owner without letting watcher probes renew its age', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-28T14:00:00Z'));
    try {
      mockFindUser.mockResolvedValue({ _id: 'startup-owner' });
      await refreshOrchestrationReadiness({ ownerId: 'observed-owner' });
      mockRequestAccountApi.mockClear();

      expect(startOrchestrationReadinessWatcher()).toMatchObject({ started: true });
      await Promise.resolve();
      await Promise.resolve();
      mockRequestAccountApi.mockClear();

      await jest.advanceTimersByTimeAsync(1_000);
      expect(
        mockRequestAccountApi.mock.calls.filter(
          ([request]) => request.ownerId === 'observed-owner',
        ),
      ).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(1_000);
      expect(
        mockRequestAccountApi.mock.calls.filter(
          ([request]) => request.ownerId === 'observed-owner',
        ),
      ).toHaveLength(1);
      expect(orchestrationReadinessSnapshot({ ownerId: 'observed-owner' })).toMatchObject({
        available: false,
        status: 'stale',
      });

      observeOrchestrationOwner('observed-owner');
      await Promise.resolve();
      await Promise.resolve();
      expect(
        mockRequestAccountApi.mock.calls.filter(
          ([request]) => request.ownerId === 'observed-owner',
        ),
      ).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('waits through a transient startup failure and returns only exact ready truth', async () => {
    jest.useFakeTimers();
    try {
      mockRequestAccountApi
        .mockResolvedValueOnce(
          readyCapability({
            isolatedParallelReady: false,
            isolatedParallelReason: 'parallel_clean_room_proxy_unhealthy',
          }),
        )
        .mockResolvedValueOnce(readyCapability());

      const pending = waitForOrchestrationReadiness({
        ownerId: 'user-1',
        timeoutMs: 2_000,
        pollIntervalMs: 100,
      });
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toMatchObject({ available: true, status: 'ready' });
      expect(mockRequestAccountApi).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('startup readiness uses only the separately resolved startup owner', async () => {
    await refreshOrchestrationReadiness({ ownerId: 'observed-owner' });
    mockRequestAccountApi.mockClear();
    mockFindUser.mockResolvedValueOnce({ _id: 'startup-owner' });
    mockRequestAccountApi.mockResolvedValueOnce(deploymentReadyCapability());
    mockGetAgent.mockClear();

    await refreshStartupOrchestrationReadiness();

    expect(mockFindUser).toHaveBeenCalledWith({ role: 'ADMIN' }, '_id');
    expect(mockRequestAccountApi).toHaveBeenCalledWith({
      ownerId: 'startup-owner',
      path: '/v1/orchestration-capabilities',
      timeoutMs: 1000,
    });
    expect(mockGetAgent).not.toHaveBeenCalled();
    expect(orchestrationDeploymentReadinessSnapshot()).toMatchObject({
      available: true,
      status: 'ready',
    });
  });

  test('shares only the single startup-owner resolution across concurrent startup probes', async () => {
    let resolveOwner;
    mockFindUser.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOwner = resolve;
        }),
    );

    mockRequestAccountApi.mockResolvedValueOnce(deploymentReadyCapability());
    const first = refreshStartupOrchestrationReadiness();
    const second = refreshStartupOrchestrationReadiness();
    await Promise.resolve();
    expect(mockFindUser).toHaveBeenCalledTimes(1);

    resolveOwner({ _id: 'startup-owner' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ available: true, status: 'ready' }),
      expect.objectContaining({ available: true, status: 'ready' }),
    ]);
    expect(mockRequestAccountApi).toHaveBeenCalledTimes(1);
  });

  test('never copies owner A readiness into deployment or owner B readiness', async () => {
    mockGetAgent.mockResolvedValue({
      _id: 'main-resource',
      id: 'agent-main',
      author: 'owner-a',
      glasshive_options: { orchestration: { parallel_available: true } },
      tools: [
        'worker_delegate_once_mcp_glasshive-workers-projects',
        'active_work_list',
        'active_work_action',
      ],
    });
    mockCheckPermission.mockImplementation(async ({ userId }) => userId === 'owner-a');

    await refreshOrchestrationReadiness({ ownerId: 'owner-a' });
    await refreshOrchestrationReadiness({ ownerId: 'owner-b' });
    mockFindUser.mockResolvedValueOnce({ _id: 'owner-a' });
    mockRequestAccountApi.mockResolvedValueOnce(readyCapability());
    await refreshStartupOrchestrationReadiness();

    expect(orchestrationReadinessSnapshot({ ownerId: 'owner-a' })).toMatchObject({
      available: true,
      status: 'ready',
    });
    expect(orchestrationReadinessSnapshot({ ownerId: 'owner-b' })).toMatchObject({
      available: false,
      status: 'unready',
      reason: 'main_agent_unavailable',
    });
    expect(orchestrationDeploymentReadinessSnapshot()).toMatchObject({
      available: false,
      status: 'unready',
      reason: 'deployment_scope_unverified',
    });
  });

  test('uses ACL-visible Main configuration without requiring agent authorship', async () => {
    mockGetAgent.mockResolvedValueOnce({
      _id: 'main-resource',
      id: 'agent-main',
      author: 'different-owner',
      glasshive_options: { orchestration: { parallel_available: true } },
      tools: [
        'worker_delegate_once_mcp_glasshive-workers-projects',
        'active_work_list',
        'active_work_action',
      ],
    });
    mockCheckPermission.mockResolvedValueOnce(true);
    mockRequestAccountApi.mockResolvedValueOnce(
      readyCapability({
        storagePressure: { ...healthyStorage, status: 'warning', usedPercent: 92 },
      }),
    );

    await refreshOrchestrationReadiness({ ownerId: 'qa-owner' });

    expect(mockCheckPermission).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'qa-owner', resourceId: 'main-resource' }),
    );
    expect(orchestrationReadinessSnapshot({ ownerId: 'qa-owner' })).toMatchObject({
      available: true,
      status: 'ready',
      storagePressure: { status: 'warning' },
    });
  });

  test('deployment readiness uses typed deployment facts, not startup-owner Main readiness', async () => {
    mockFindUser.mockResolvedValueOnce({ _id: 'transport-owner' });
    mockRequestAccountApi.mockResolvedValueOnce(deploymentReadyCapability());
    mockGetAgent.mockClear();

    await refreshStartupOrchestrationReadiness();

    expect(mockRequestAccountApi).toHaveBeenCalledWith({
      ownerId: 'transport-owner',
      path: '/v1/orchestration-capabilities',
      timeoutMs: 1000,
    });
    expect(mockGetAgent).not.toHaveBeenCalled();
    expect(orchestrationDeploymentReadinessSnapshot()).toMatchObject({
      available: true,
      status: 'ready',
    });
  });
});
