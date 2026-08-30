const crypto = require('crypto');

const authorizations = new Map();
const nonces = new Map();
const mockMintBrokerGrant = jest.fn();
const mockPersistBrokerGrantResources = jest.fn();
const mockGetUserById = jest.fn();
const mockGetAllServerConfigs = jest.fn();
const mockCollectServerProjection = jest.fn();
const mockShouldGrantContentReadScope = jest.fn();

function matches(record, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((branch) => matches(record, branch));
    return record?.[key] === value;
  });
}

const mockAuthorizationCollection = {
  createIndex: jest.fn().mockResolvedValue('ok'),
  indexes: jest.fn().mockResolvedValue([]),
  dropIndex: jest.fn().mockResolvedValue({ ok: 1 }),
  updateMany: jest.fn().mockResolvedValue({ acknowledged: true }),
  findOne: jest.fn(async (filter) =>
    Array.from(authorizations.values()).find((record) => matches(record, filter)),
  ),
  insertOne: jest.fn(async (record) => {
    if (authorizations.has(record._id)) {
      const error = new Error('duplicate');
      error.code = 11000;
      throw error;
    }
    authorizations.set(record._id, structuredClone(record));
    return { acknowledged: true };
  }),
  updateOne: jest.fn(async (filter, update) => {
    const record = Array.from(authorizations.values()).find((item) => matches(item, filter));
    if (!record) return { matchedCount: 0 };
    Object.assign(record, update.$set || {});
    if (update.$inc) {
      for (const [key, amount] of Object.entries(update.$inc)) {
        record[key] = Number(record[key] || 0) + Number(amount);
      }
    }
    return { matchedCount: 1 };
  }),
};

const mockNonceCollection = {
  createIndex: jest.fn().mockResolvedValue('ok'),
  insertOne: jest.fn(async (record) => {
    if (nonces.has(record._id)) {
      const error = new Error('duplicate');
      error.code = 11000;
      throw error;
    }
    nonces.set(record._id, structuredClone(record));
    return { acknowledged: true };
  }),
};

jest.mock('mongoose', () => ({
  connection: {
    collection: (name) => {
      if (name === 'viventium_glasshive_capability_authorizations') {
        return mockAuthorizationCollection;
      }
      if (name === 'viventium_glasshive_admission_nonces') {
        return mockNonceCollection;
      }
      throw new Error(`Unexpected collection ${name}`);
    },
  },
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('~/config', () => ({
  getMCPServersRegistry: () => ({
    getAllServerConfigs: (...args) => mockGetAllServerConfigs(...args),
  }),
}));

jest.mock('~/models', () => ({ getUserById: (...args) => mockGetUserById(...args) }));

jest.mock('../GlassHiveCapabilityBrokerAuth', () => ({
  mintBrokerGrant: (...args) => mockMintBrokerGrant(...args),
  persistBrokerGrantResources: (...args) => mockPersistBrokerGrantResources(...args),
}));

jest.mock('../GlassHiveCapabilityPolicyService', () => ({
  collectServerProjection: (...args) => mockCollectServerProjection(...args),
  isBrokerProjectionEnabled: () => true,
  shouldGrantContentReadScope: (...args) => mockShouldGrantContentReadScope(...args),
}));

const ORIGINAL_ENV = { ...process.env };

describe('GlassHiveCapabilityAuthorizationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authorizations.clear();
    nonces.clear();
    process.env.VIVENTIUM_GLASSHIVE_ADMISSION_SECRET = 'synthetic-admission-secret';
    process.env.VIVENTIUM_GLASSHIVE_AUTHORIZATION_HORIZON_SECONDS = '86400';
    delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_RESOURCE_MAX_BYTES;
    mockGetUserById.mockResolvedValue({ _id: 'owner-1', role: 'USER' });
    mockGetAllServerConfigs.mockResolvedValue({ connected: { source: 'config' } });
    mockCollectServerProjection.mockReturnValue({
      allowedEntries: [{ serverName: 'connected', policy: {} }],
      omissions: [],
    });
    mockShouldGrantContentReadScope.mockReturnValue(true);
    mockMintBrokerGrant.mockReturnValue({
      token: 'admission-minted-token',
      payload: {
        grant_id: 'grant-1',
        exp: 1_800_086_400,
        scopes: { content_read: true },
      },
    });
    mockPersistBrokerGrantResources.mockResolvedValue({ persisted: true });
    require('../GlassHiveCapabilityAuthorizationService').resetCapabilityAuthorizationIndexesForTests();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  async function prepare(nowMs = 1_800_000_000_000) {
    const { createCapabilityAuthorization } = require('../GlassHiveCapabilityAuthorizationService');
    return createCapabilityAuthorization({
      user: { id: 'owner-1', role: 'USER' },
      originRef: 'ghi_origin_0001',
      allowedServers: ['connected'],
      allowedHostTools: ['file_search'],
      hostToolResources: { file_search: { files: [{ file_id: 'file-1' }] } },
      contentReadScope: true,
      executionMode: 'host',
      requestContext: {
        conversation_id: 'conversation-1',
        message_id: 'message-1',
        parent_message_id: 'parent-1',
      },
      brokerUrl: 'http://127.0.0.1:3180/api/viventium/glasshive/capabilities/mcp',
      nowMs,
    });
  }

  test('persists scope and horizon without minting a bearer while work is queued', async () => {
    const authorization = await prepare();

    expect(authorization).toMatchObject({
      authorizationRef: expect.stringMatching(/^gha_/),
      ownerId: 'owner-1',
      originRef: 'ghi_origin_0001',
      allowedServers: ['connected'],
      allowedHostTools: ['file_search'],
      status: 'active',
      workRef: '',
    });
    expect(authorization.maxExpiresAt.toISOString()).toBe('2027-01-16T08:00:00.000Z');
    expect(mockMintBrokerGrant).not.toHaveBeenCalled();
  });

  test('prepares one provider-only scheduled authorization without minting or exposing a bearer', async () => {
    const {
      prepareScheduledProviderAuthorization,
    } = require('../GlassHiveCapabilityAuthorizationService');
    mockGetUserById.mockResolvedValueOnce({ _id: 'owner-0001', role: 'USER' });

    const prepared = await prepareScheduledProviderAuthorization({
      ownerId: 'owner-0001',
      originRef: 'scheduled_run_0001',
      workRef: 'scheduled_run_0001',
      workerId: 'worker_synthetic_0001',
      runId: 'glasshive_run_0001',
      containerGenerationId: 'a'.repeat(64),
      allowedServers: [],
      allowedHostTools: [],
      contentReadScope: false,
      executionMode: 'docker',
      requestContext: {
        message_id: 'scheduled_run_0001',
        turn_id: 'scheduled_run_0001',
      },
      brokerUrl: 'http://host.docker.internal:3180/api/viventium/glasshive/capabilities/mcp',
      nowMs: 1_800_000_000_000,
    });

    expect(mockGetUserById).toHaveBeenCalledWith(
      'owner-0001',
      '-password -__v -totpSecret -backupCodes',
    );
    expect(prepared).toEqual({
      status: 'prepared',
      ownerId: 'owner-0001',
      originRef: 'scheduled_run_0001',
      workRef: 'scheduled_run_0001',
      workerId: 'worker_synthetic_0001',
      runId: 'glasshive_run_0001',
      containerGenerationId: 'a'.repeat(64),
      authorizationRef: expect.stringMatching(/^gha_/),
      scopeFingerprint: expect.any(String),
      brokerUrl: 'http://host.docker.internal:3180/api/viventium/glasshive/capabilities/mcp',
      maxExpiresAt: '2027-01-16T08:00:00.000Z',
    });
    expect(prepared).not.toHaveProperty('grantToken');
    expect(prepared).not.toHaveProperty('grant');
    expect(authorizations.get(prepared.authorizationRef)).toMatchObject({
      ownerId: 'owner-0001',
      originRef: 'scheduled_run_0001',
      allowedServers: [],
      allowedHostTools: [],
      hostToolResources: {},
      contentReadScope: false,
      executionMode: 'docker',
      requestContext: {
        conversation_id: '',
        parent_message_id: '',
        message_id: 'scheduled_run_0001',
        turn_id: 'scheduled_run_0001',
      },
    });
    expect(mockMintBrokerGrant).not.toHaveBeenCalled();
    expect(mockPersistBrokerGrantResources).not.toHaveBeenCalled();
  });

  test('rejects any scheduled preparation that expands the provider-only scope', async () => {
    const {
      prepareScheduledProviderAuthorization,
    } = require('../GlassHiveCapabilityAuthorizationService');

    await expect(
      prepareScheduledProviderAuthorization({
        ownerId: 'owner-0001',
        originRef: 'scheduled_run_0001',
        workRef: 'scheduled_run_0001',
        workerId: 'worker_synthetic_0001',
        runId: 'glasshive_run_0001',
        containerGenerationId: 'a'.repeat(64),
        allowedServers: ['connected'],
        allowedHostTools: [],
        contentReadScope: false,
        executionMode: 'docker',
        requestContext: {
          message_id: 'scheduled_run_0001',
          turn_id: 'scheduled_run_0001',
        },
        brokerUrl: 'http://host.docker.internal:3180/api/viventium/glasshive/capabilities/mcp',
      }),
    ).rejects.toMatchObject({
      code: 'capability_scheduled_prepare_request_invalid',
      status: 400,
      needsInput: false,
    });
    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockMintBrokerGrant).not.toHaveBeenCalled();
  });

  test('migrates the legacy max-horizon TTL so explicit authenticated reauthorization remains possible', async () => {
    mockAuthorizationCollection.indexes.mockResolvedValueOnce([
      {
        name: 'viventium_gh_capability_authorization_expiry',
        key: { maxExpiresAt: 1 },
        expireAfterSeconds: 0,
      },
      { name: 'unrelated_index', key: { ownerId: 1 } },
    ]);

    await prepare();

    expect(mockAuthorizationCollection.dropIndex).toHaveBeenCalledWith(
      'viventium_gh_capability_authorization_expiry',
    );
    expect(mockAuthorizationCollection.updateMany).toHaveBeenCalledWith(
      { retentionExpiresAt: { $exists: false } },
      { $set: { retentionExpiresAt: expect.any(Date) } },
    );
    expect(mockAuthorizationCollection.createIndex).toHaveBeenCalledWith(
      { retentionExpiresAt: 1 },
      expect.objectContaining({ expireAfterSeconds: 0 }),
    );
  });

  test('stores only authorized host resources and rejects an oversized deferred scope', async () => {
    const { createCapabilityAuthorization } = require('../GlassHiveCapabilityAuthorizationService');
    const authorization = await createCapabilityAuthorization({
      user: { id: 'owner-1', role: 'USER' },
      originRef: 'ghi_origin_scope_1',
      allowedHostTools: ['file_search'],
      hostToolResources: {
        file_search: { files: [{ file_id: 'file-1' }] },
        ungranted_tool: { secret: 'must-not-persist' },
      },
      executionMode: 'host',
      requestContext: { conversation_id: 'conversation-1', message_id: 'message-1' },
      brokerUrl: 'http://127.0.0.1/broker',
      nowMs: 1_800_000_000_000,
    });
    expect(authorization.hostToolResources).toEqual({
      file_search: { files: [{ file_id: 'file-1' }] },
    });

    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_RESOURCE_MAX_BYTES = '16384';
    await expect(
      createCapabilityAuthorization({
        user: { id: 'owner-1', role: 'USER' },
        originRef: 'ghi_origin_scope_2',
        allowedHostTools: ['file_search'],
        hostToolResources: { file_search: { value: 'x'.repeat(20_000) } },
        executionMode: 'host',
        requestContext: { conversation_id: 'conversation-1', message_id: 'message-1' },
        brokerUrl: 'http://127.0.0.1/broker',
        nowMs: 1_800_000_000_000,
      }),
    ).rejects.toMatchObject({ code: 'capability_authorization_scope_too_large', status: 413 });
  });

  test('mints only at exact mission admission and binds the grant to worker and run', async () => {
    const { admitCapabilityAuthorization } = require('../GlassHiveCapabilityAuthorizationService');
    const authorization = await prepare();

    const result = await admitCapabilityAuthorization({
      authorizationRef: authorization.authorizationRef,
      originRef: 'ghi_origin_0001',
      workRef: 'work_00000001',
      workerId: 'worker_000001',
      runId: 'run_000000001',
      containerGenerationId: 'a'.repeat(64),
      nowMs: 1_800_000_010_000,
    });

    expect(result).toMatchObject({
      status: 'authorized',
      grantToken: 'admission-minted-token',
      workRef: 'work_00000001',
      workerId: 'worker_000001',
      runId: 'run_000000001',
      containerGenerationId: 'a'.repeat(64),
    });
    expect(mockMintBrokerGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedServers: ['connected'],
        allowedHostTools: ['file_search'],
        requestContext: expect.objectContaining({
          worker_id: 'worker_000001',
          run_id: 'run_000000001',
          container_generation_id: 'a'.repeat(64),
        }),
        ttlSeconds: 86_390,
      }),
    );
    expect(mockPersistBrokerGrantResources).toHaveBeenCalledTimes(1);
  });

  test('keeps one exact mission grant active past ten minutes and revokes it at terminal cleanup', async () => {
    const {
      admitCapabilityAuthorization,
      assertActiveCapabilityAuthorizationGrant,
      revokeCapabilityAuthorizationGrant,
    } = require('../GlassHiveCapabilityAuthorizationService');
    const authorization = await prepare();
    const containerGenerationId = 'a'.repeat(64);
    mockMintBrokerGrant.mockReturnValueOnce({
      token: 'long-mission-token',
      payload: {
        grant_id: 'grant-synthetic-long',
        exp: 1_800_086_400,
        scopes: { content_read: true },
      },
    });

    await admitCapabilityAuthorization({
      authorizationRef: authorization.authorizationRef,
      originRef: 'ghi_origin_0001',
      workRef: 'work_00000001',
      workerId: 'worker_000001',
      runId: 'run_000000001',
      containerGenerationId,
      nowMs: 1_800_000_010_000,
    });

    const now = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_611_000);
    const exactGrant = {
      authorization_ref: authorization.authorizationRef,
      grant_id: 'grant-synthetic-long',
      user_id: 'owner-1',
      worker_id: 'worker_000001',
      run_id: 'run_000000001',
      container_generation_id: containerGenerationId,
      exp: 1_800_086_400,
    };
    try {
      await expect(assertActiveCapabilityAuthorizationGrant(exactGrant)).resolves.toMatchObject({
        grantId: 'grant-synthetic-long',
        workerId: 'worker_000001',
        runId: 'run_000000001',
      });

      await revokeCapabilityAuthorizationGrant({
        authorizationRef: authorization.authorizationRef,
        originRef: 'ghi_origin_0001',
        workRef: 'work_00000001',
        workerId: 'worker_000001',
        runId: 'run_000000001',
        containerGenerationId,
        grantId: 'grant-synthetic-long',
      });
      await expect(assertActiveCapabilityAuthorizationGrant(exactGrant)).rejects.toMatchObject({
        code: 'capability_grant_inactive',
        status: 401,
      });
    } finally {
      now.mockRestore();
    }
  });

  test('fails closed when the authorization binding changes after grant minting', async () => {
    const { admitCapabilityAuthorization } = require('../GlassHiveCapabilityAuthorizationService');
    const authorization = await prepare();
    mockAuthorizationCollection.updateOne.mockResolvedValueOnce({ matchedCount: 0 });

    await expect(
      admitCapabilityAuthorization({
        authorizationRef: authorization.authorizationRef,
        originRef: 'ghi_origin_0001',
        workRef: 'work_00000001',
        workerId: 'worker_000001',
        runId: 'run_000000001',
        containerGenerationId: 'a'.repeat(64),
        nowMs: 1_800_000_010_000,
      }),
    ).rejects.toMatchObject({
      code: 'capability_authorization_binding_changed',
      status: 409,
      needsInput: false,
    });
    expect(mockPersistBrokerGrantResources).toHaveBeenCalledTimes(1);
  });

  test('invalidates an old container-generation grant and revokes only the exact current generation', async () => {
    const {
      admitCapabilityAuthorization,
      assertActiveCapabilityAuthorizationGrant,
      revokeCapabilityAuthorizationGrant,
    } = require('../GlassHiveCapabilityAuthorizationService');
    const authorization = await prepare();
    const generationA = 'a'.repeat(64);
    const generationB = generationA;
    mockMintBrokerGrant
      .mockReturnValueOnce({
        token: 'grant-token-a',
        payload: {
          grant_id: 'grant-synthetic-a',
          exp: 1_800_000_610,
          scopes: { content_read: true },
        },
      })
      .mockReturnValueOnce({
        token: 'grant-token-b',
        payload: {
          grant_id: 'grant-synthetic-b',
          exp: 1_800_000_620,
          scopes: { content_read: true },
        },
      });

    await admitCapabilityAuthorization({
      authorizationRef: authorization.authorizationRef,
      originRef: 'ghi_origin_0001',
      workRef: 'work_00000001',
      workerId: 'worker_000001',
      runId: 'run_000000001',
      containerGenerationId: generationA,
      nowMs: 1_800_000_010_000,
    });
    await admitCapabilityAuthorization({
      authorizationRef: authorization.authorizationRef,
      originRef: 'ghi_origin_0001',
      workRef: 'work_00000001',
      workerId: 'worker_000001',
      runId: 'run_000000001',
      containerGenerationId: generationB,
      nowMs: 1_800_000_020_000,
    });

    await expect(
      assertActiveCapabilityAuthorizationGrant({
        authorization_ref: authorization.authorizationRef,
        grant_id: 'grant-synthetic-a',
        worker_id: 'worker_000001',
        run_id: 'run_000000001',
        container_generation_id: generationA,
        exp: 1_800_000_610,
      }),
    ).rejects.toMatchObject({ code: 'capability_grant_inactive', status: 401 });
    await expect(
      assertActiveCapabilityAuthorizationGrant({
        authorization_ref: authorization.authorizationRef,
        grant_id: 'grant-synthetic-b',
        user_id: 'owner-1',
        worker_id: 'worker_000001',
        run_id: 'run_000000001',
        container_generation_id: generationB,
        exp: 1_800_000_620,
      }),
    ).resolves.toMatchObject({
      authorizationRef: authorization.authorizationRef,
      ownerId: 'owner-1',
      originRef: 'ghi_origin_0001',
      workRef: 'work_00000001',
      workerId: 'worker_000001',
      runId: 'run_000000001',
      grantId: 'grant-synthetic-b',
    });

    await revokeCapabilityAuthorizationGrant({
      authorizationRef: authorization.authorizationRef,
      originRef: 'ghi_origin_0001',
      workRef: 'work_00000001',
      workerId: 'worker_000001',
      runId: 'run_000000001',
      containerGenerationId: generationA,
      grantId: 'grant-synthetic-a',
    });
    await expect(
      assertActiveCapabilityAuthorizationGrant({
        authorization_ref: authorization.authorizationRef,
        grant_id: 'grant-synthetic-b',
        user_id: 'owner-1',
        worker_id: 'worker_000001',
        run_id: 'run_000000001',
        container_generation_id: generationB,
        exp: 1_800_000_620,
      }),
    ).resolves.toMatchObject({
      ownerId: 'owner-1',
      originRef: 'ghi_origin_0001',
      workRef: 'work_00000001',
      grantId: 'grant-synthetic-b',
    });

    await revokeCapabilityAuthorizationGrant({
      authorizationRef: authorization.authorizationRef,
      originRef: 'ghi_origin_0001',
      workRef: 'work_00000001',
      workerId: 'worker_000001',
      runId: 'run_000000001',
      containerGenerationId: generationB,
      grantId: 'grant-synthetic-b',
    });
    await expect(
      assertActiveCapabilityAuthorizationGrant({
        authorization_ref: authorization.authorizationRef,
        grant_id: 'grant-synthetic-b',
        worker_id: 'worker_000001',
        run_id: 'run_000000001',
        container_generation_id: generationB,
        exp: 1_800_000_620,
      }),
    ).rejects.toMatchObject({ code: 'capability_grant_inactive', status: 401 });
  });

  test('fails closed when policy narrows instead of silently minting a weaker grant', async () => {
    const { admitCapabilityAuthorization } = require('../GlassHiveCapabilityAuthorizationService');
    const authorization = await prepare();
    mockCollectServerProjection.mockReturnValue({ allowedEntries: [], omissions: [] });
    mockShouldGrantContentReadScope.mockReturnValue(false);

    await expect(
      admitCapabilityAuthorization({
        authorizationRef: authorization.authorizationRef,
        originRef: 'ghi_origin_0001',
        workRef: 'work_00000001',
        workerId: 'worker_000001',
        runId: 'run_000000001',
        containerGenerationId: 'a'.repeat(64),
        nowMs: 1_800_000_010_000,
      }),
    ).rejects.toMatchObject({ code: 'capability_policy_changed', needsInput: true });
    expect(mockMintBrokerGrant).not.toHaveBeenCalled();
  });

  test('requires explicit reauthorization after the 24-hour horizon', async () => {
    const {
      admitCapabilityAuthorization,
      reauthorizeCapabilityAuthorization,
    } = require('../GlassHiveCapabilityAuthorizationService');
    const authorization = await prepare();

    await expect(
      admitCapabilityAuthorization({
        authorizationRef: authorization.authorizationRef,
        originRef: 'ghi_origin_0001',
        workRef: 'work_00000001',
        workerId: 'worker_000001',
        runId: 'run_000000001',
        containerGenerationId: 'a'.repeat(64),
        nowMs: 1_800_086_341_000,
      }),
    ).rejects.toMatchObject({
      code: 'capability_authorization_horizon_expired',
      needsInput: true,
    });

    expect(authorizations.get(authorization.authorizationRef)).toMatchObject({
      workRef: 'work_00000001',
      workerId: 'worker_000001',
      currentRunId: 'run_000000001',
      lastNeedsInputCode: 'capability_authorization_horizon_expired',
    });

    const reauthorized = await reauthorizeCapabilityAuthorization({
      ownerId: 'owner-1',
      workRef: 'work_00000001',
      nowMs: 1_800_086_342_000,
    });
    expect(reauthorized).toMatchObject({
      status: 'reauthorized',
      workRef: 'work_00000001',
      scopeFingerprint: authorization.scopeFingerprint,
    });
    expect(reauthorized.maxExpiresAt).toBe('2027-01-17T07:59:02.000Z');
    expect(mockGetUserById).toHaveBeenCalledWith(
      'owner-1',
      '-password -__v -totpSecret -backupCodes',
    );

    await expect(
      admitCapabilityAuthorization({
        authorizationRef: authorization.authorizationRef,
        originRef: 'ghi_origin_0001',
        workRef: 'work_00000001',
        workerId: 'worker_000001',
        runId: 'run_000000002',
        containerGenerationId: 'b'.repeat(64),
        nowMs: 1_800_086_343_000,
      }),
    ).resolves.toMatchObject({ status: 'authorized', runId: 'run_000000002' });
  });

  test('reauthorization is owner/work scoped and cannot expand or bypass current policy', async () => {
    const {
      admitCapabilityAuthorization,
      reauthorizeCapabilityAuthorization,
    } = require('../GlassHiveCapabilityAuthorizationService');
    const authorization = await prepare();
    await expect(
      admitCapabilityAuthorization({
        authorizationRef: authorization.authorizationRef,
        originRef: 'ghi_origin_0001',
        workRef: 'work_00000001',
        workerId: 'worker_000001',
        runId: 'run_000000001',
        containerGenerationId: 'a'.repeat(64),
        nowMs: 1_800_086_341_000,
      }),
    ).rejects.toMatchObject({ code: 'capability_authorization_horizon_expired' });

    await expect(
      reauthorizeCapabilityAuthorization({
        ownerId: 'foreign-owner',
        workRef: 'work_00000001',
        nowMs: 1_800_086_342_000,
      }),
    ).rejects.toMatchObject({ code: 'capability_authorization_not_found', status: 404 });

    mockCollectServerProjection.mockReturnValue({ allowedEntries: [], omissions: [] });
    mockShouldGrantContentReadScope.mockReturnValue(false);
    await expect(
      reauthorizeCapabilityAuthorization({
        ownerId: 'owner-1',
        workRef: 'work_00000001',
        nowMs: 1_800_086_342_000,
      }),
    ).rejects.toMatchObject({ code: 'capability_policy_changed', needsInput: true });

    const stored = authorizations.get(authorization.authorizationRef);
    expect(stored.maxExpiresAt.toISOString()).toBe('2027-01-16T08:00:00.000Z');
    expect(stored.allowedServers).toEqual(['connected']);
    expect(stored.allowedHostTools).toEqual(['file_search']);
  });

  test('uses canonical cross-runtime admission signing and durably rejects nonce replay', async () => {
    const {
      createAdmissionSignature,
      verifyAndConsumeAdmission,
    } = require('../GlassHiveCapabilityAuthorizationService');
    const body = {
      authorizationRef: 'gha_authorization_1',
      originRef: 'ghi_origin_0001',
      runId: 'run_000000001',
      workRef: 'work_00000001',
      workerId: 'worker_000001',
    };
    const header = createAdmissionSignature({
      body,
      nowMs: 1_800_000_000_000,
      nonce: 'nonce-admission-0001',
    });
    const canonical =
      'v1\n1800000000\nnonce-admission-0001\n' +
      '{"authorizationRef":"gha_authorization_1","originRef":"ghi_origin_0001","runId":"run_000000001","workRef":"work_00000001","workerId":"worker_000001"}';
    const expected = crypto
      .createHmac('sha256', 'synthetic-admission-secret')
      .update(canonical)
      .digest('base64url');
    expect(header).toBe(`v1:1800000000:nonce-admission-0001:${expected}`);

    await expect(
      verifyAndConsumeAdmission({ body, header, nowMs: 1_800_000_000_000 }),
    ).resolves.toBeUndefined();
    await expect(
      verifyAndConsumeAdmission({ body, header, nowMs: 1_800_000_000_000 }),
    ).rejects.toMatchObject({ code: 'capability_admission_replayed', status: 409 });
  });
});
