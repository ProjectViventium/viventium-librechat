const crypto = require('crypto');

const mockEnrichActiveWorkSnapshot = jest.fn(async ({ snapshot }) => snapshot);
const mockUpdateUserViventiumOrchestrationPreferences = jest.fn(async () => ({}));
const mockGetUserParallelWorkKnownEpoch = jest.fn(async () => 0);
const mockMarkUserParallelWorkKnown = jest.fn(async (ownerId) => {
  await mockUpdateUserViventiumOrchestrationPreferences(ownerId, { knownWork: true });
  return true;
});
const mockClearUserParallelWorkKnownIfEpoch = jest.fn(async (ownerId) => {
  await mockUpdateUserViventiumOrchestrationPreferences(ownerId, { knownWork: false });
  return true;
});
const mockHasKnownExternalWork = jest.fn(async () => false);

jest.mock('~/models', () => ({
  clearUserParallelWorkKnownIfEpoch: (...args) => mockClearUserParallelWorkKnownIfEpoch(...args),
  getUserParallelWorkKnownEpoch: (...args) => mockGetUserParallelWorkKnownEpoch(...args),
  markUserParallelWorkKnown: (...args) => mockMarkUserParallelWorkKnown(...args),
  updateUserViventiumOrchestrationPreferences: (...args) =>
    mockUpdateUserViventiumOrchestrationPreferences(...args),
}));

jest.mock('../GlassHiveActiveWorkProjectionService', () => ({
  enrichActiveWorkSnapshot: (...args) => mockEnrichActiveWorkSnapshot(...args),
}));

jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  return {
    ...actual,
    connection: {
      ...actual.connection,
      collection: (name) => {
        if (name !== 'viventium_external_work') throw new Error(`Unexpected collection ${name}`);
        return {
          findOne: async (filter) =>
            (await mockHasKnownExternalWork({ ownerId: filter.ownerId }))
              ? { _id: 'known-work' }
              : null,
        };
      },
    },
  };
});

const ORIGINAL_ENV = { ...process.env };

describe('GlassHiveAccountService', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.VIVENTIUM_GLASSHIVE_SERVICE_ASSERTION_SECRET = 'synthetic-service-secret';
    process.env.WPR_API_TOKEN = 'synthetic-api-token';
    process.env.GLASSHIVE_PROVIDER_BASE_URL = 'http://127.0.0.1:8766/v1';
    process.env.VIVENTIUM_TENANT_ID = 'local-public-test';
    process.env.VIVENTIUM_ACTIVE_WORK_CACHE_MS = '2000';
    process.env.VIVENTIUM_ACTIVE_WORK_COLD_TIMEOUT_MS = '100';
    process.env.VIVENTIUM_ACTIVE_WORK_INTERACTIVE_TIMEOUT_MS = '4321';
    mockEnrichActiveWorkSnapshot.mockClear();
    mockUpdateUserViventiumOrchestrationPreferences.mockClear();
    mockGetUserParallelWorkKnownEpoch.mockReset().mockResolvedValue(0);
    mockMarkUserParallelWorkKnown.mockReset().mockImplementation(async (ownerId) => {
      await mockUpdateUserViventiumOrchestrationPreferences(ownerId, { knownWork: true });
      return true;
    });
    mockClearUserParallelWorkKnownIfEpoch.mockReset().mockImplementation(async (ownerId) => {
      await mockUpdateUserViventiumOrchestrationPreferences(ownerId, { knownWork: false });
      return true;
    });
    mockHasKnownExternalWork.mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('creates a short-lived signed assertion whose owner cannot be supplied as a raw header', () => {
    const { createServiceAssertion } = require('../GlassHiveAccountService');
    const assertion = createServiceAssertion({
      ownerId: 'owner-1',
      nowMs: 1_800_000_000_000,
      nonce: 'nonce-0001',
    });
    const [encoded, signature] = assertion.split('.');
    const payloadJson = Buffer.from(encoded, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson);
    const expected = crypto
      .createHmac('sha256', 'synthetic-service-secret')
      .update(encoded)
      .digest('base64url');

    expect(signature).toBe(expected);
    expect(payload).toEqual({
      v: 1,
      aud: 'glasshive-account-api',
      tenant_id: 'local-public-test',
      owner_id: 'owner-1',
      iat: 1_800_000_000,
      exp: 1_800_000_060,
      nonce: 'nonce-0001',
    });
    expect(payloadJson).toBe(
      '{"aud":"glasshive-account-api","exp":1800000060,"iat":1800000000,"nonce":"nonce-0001","owner_id":"owner-1","tenant_id":"local-public-test","v":1}',
    );
    expect(assertion).toBe(
      'eyJhdWQiOiJnbGFzc2hpdmUtYWNjb3VudC1hcGkiLCJleHAiOjE4MDAwMDAwNjAsImlhdCI6MTgwMDAwMDAwMCwibm9uY2UiOiJub25jZS0wMDAxIiwib3duZXJfaWQiOiJvd25lci0xIiwidGVuYW50X2lkIjoibG9jYWwtcHVibGljLXRlc3QiLCJ2IjoxfQ.jY72UV_cX75aRTHO2Xj1w-2d2FasiXKOa0v6ENhvtUY',
    );
  });

  test('signs the exact Core-owned delegation identity for MCP provenance verification', () => {
    const { signTrustedDelegationIdentity } = require('../GlassHiveAccountService');
    const identity = {
      version: 2,
      idempotency_key: 'a'.repeat(64),
      goal_digest: 'b'.repeat(64),
      launch_payload_digest: 'd'.repeat(64),
      call_identity_digest: 'c'.repeat(64),
      source_event_id: 'synthetic-source-event',
      objective_ordinal: 7,
    };
    const canonical = JSON.stringify({
      identity: {
        call_identity_digest: identity.call_identity_digest,
        goal_digest: identity.goal_digest,
        idempotency_key: identity.idempotency_key,
        launch_payload_digest: identity.launch_payload_digest,
        objective_ordinal: identity.objective_ordinal,
        source_event_id: identity.source_event_id,
        version: identity.version,
      },
      owner_id: 'owner-1',
      tenant_id: 'local-public-test',
    });
    const expected = crypto
      .createHmac('sha256', 'synthetic-service-secret')
      .update(`viventium.delegation-identity.v2\0${canonical}`, 'utf8')
      .digest('hex');

    expect(signTrustedDelegationIdentity(identity, { ownerId: 'owner-1' })).toBe(expected);
  });

  test('calls the owner-scoped API with service auth and bounded JSON handling', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: (name) => (name === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify({ snapshot: 'fresh', work: [], overflowCount: 0 }),
    });
    const { requestAccountApi } = require('../GlassHiveAccountService');

    const result = await requestAccountApi({
      ownerId: 'owner-1',
      path: '/v1/active-work?limit=50',
      fetchImpl,
    });

    expect(result).toEqual({ snapshot: 'fresh', work: [], overflowCount: 0 });
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8766/v1/active-work?limit=50');
    expect(request.headers.Authorization).toBe('Bearer synthetic-api-token');
    expect(request.headers['X-Viventium-Service-Assertion']).toMatch(/^[^.]+\.[^.]+$/);
    expect(request.headers).not.toHaveProperty('X-Viventium-Owner-Id');
    expect(request.redirect).toBe('error');
  });

  test('rejects an account path that could send owner authentication to another origin', async () => {
    const fetchImpl = jest.fn();
    const { requestAccountApi } = require('../GlassHiveAccountService');

    await expect(
      requestAccountApi({
        ownerId: 'owner-1',
        path: '/v1///attacker.invalid/collect',
        fetchImpl,
      }),
    ).rejects.toThrow('glasshive_account_path_invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('reads a later signed roster page and enriches it with Core delivery truth', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () =>
        JSON.stringify({
          snapshot: 'fresh',
          work: [{ workRef: 'work-51', state: 'completed' }],
          overflowCount: 3,
          cursor: 'signed.next-page',
        }),
    });
    const { getActiveWorkPage } = require('../GlassHiveAccountService');

    const page = await getActiveWorkPage({
      ownerId: 'owner-1',
      cursor: 'signed.current-page',
      limit: 25,
      fetchImpl,
    });

    expect(fetchImpl.mock.calls[0][0]).toBe(
      'http://127.0.0.1:8766/v1/active-work?limit=25&cursor=signed.current-page',
    );
    expect(mockEnrichActiveWorkSnapshot).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      snapshot: expect.objectContaining({ cursor: 'signed.next-page' }),
    });
    expect(page.cursor).toBe('signed.next-page');
    expect(mockUpdateUserViventiumOrchestrationPreferences).toHaveBeenCalledWith('owner-1', {
      knownWork: true,
    });
  });

  test('reads owner-scoped History without changing the active-work account hint', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () =>
        JSON.stringify({
          snapshot: 'fresh',
          work: [{ workRef: 'work-history', state: 'completed', actions: [] }],
          overflowCount: 0,
        }),
    });
    const { getActiveWorkHistoryPage } = require('../GlassHiveAccountService');

    const history = await getActiveWorkHistoryPage({
      ownerId: 'owner-1',
      cursor: 'signed.history-page',
      limit: 25,
      fetchImpl,
    });

    expect(fetchImpl.mock.calls[0][0]).toBe(
      'http://127.0.0.1:8766/v1/active-work/history?limit=25&cursor=signed.history-page',
    );
    expect(mockEnrichActiveWorkSnapshot).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      includeCoreOnlyHistory: true,
      snapshot: expect.objectContaining({
        work: [expect.objectContaining({ workRef: 'work-history', actions: [] })],
      }),
    });
    expect(history.work[0].workRef).toBe('work-history');
    expect(mockUpdateUserViventiumOrchestrationPreferences).not.toHaveBeenCalled();
  });

  test('keeps interactive roster paging separate from the Main cold-start budget', async () => {
    const timeoutSpy = jest
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => new AbortController().signal);
    const fetchImpl = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ snapshot: 'fresh', work: [], overflowCount: 0 }),
    });
    const {
      getActiveWorkInteractiveSnapshot,
      getActiveWorkPage,
      getActiveWorkSnapshot,
    } = require('../GlassHiveAccountService');

    await getActiveWorkPage({ ownerId: 'owner-interactive', fetchImpl });
    expect(timeoutSpy).toHaveBeenLastCalledWith(4321);

    await getActiveWorkSnapshot({ ownerId: 'owner-cold', fetchImpl });
    expect(timeoutSpy).toHaveBeenLastCalledWith(100);

    await getActiveWorkInteractiveSnapshot({ ownerId: 'owner-interactive-snapshot', fetchImpl });
    expect(timeoutSpy).toHaveBeenLastCalledWith(4321);
  });

  test('waits for a fresh roster on each user-triggered interactive refresh after cache expiry', async () => {
    process.env.VIVENTIUM_ACTIVE_WORK_CACHE_MS = '1';
    const response = (state, actions) => ({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () =>
        JSON.stringify({
          snapshot: 'fresh',
          work: [{ workRef: 'work-interactive-refresh', state, actions }],
          overflowCount: 0,
        }),
    });
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response('running', ['pause']))
      .mockResolvedValueOnce(response('paused', ['resume']));
    const { getActiveWorkInteractiveSnapshot } = require('../GlassHiveAccountService');

    await expect(
      getActiveWorkInteractiveSnapshot({ ownerId: 'owner-interactive-refresh', fetchImpl }),
    ).resolves.toMatchObject({
      snapshot: 'fresh',
      work: [{ state: 'running', actions: ['pause'] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(
      getActiveWorkInteractiveSnapshot({ ownerId: 'owner-interactive-refresh', fetchImpl }),
    ).resolves.toMatchObject({
      snapshot: 'fresh',
      work: [{ state: 'paused', actions: ['resume'] }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('does not let a concurrent Main cold deadline abort an interactive roster read', async () => {
    process.env.VIVENTIUM_ACTIVE_WORK_COLD_TIMEOUT_MS = '20';
    process.env.VIVENTIUM_ACTIVE_WORK_INTERACTIVE_TIMEOUT_MS = '1000';
    const pendingResponses = [];
    const response = {
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () =>
        JSON.stringify({
          snapshot: 'fresh',
          work: [{ workRef: 'work-concurrent', state: 'running', actions: ['stop'] }],
          overflowCount: 0,
        }),
    };
    const fetchImpl = jest.fn(
      (_url, request) =>
        new Promise((resolve, reject) => {
          const onAbort = () => reject(request.signal.reason || new Error('aborted'));
          request.signal.addEventListener('abort', onAbort, { once: true });
          pendingResponses.push(() => {
            request.signal.removeEventListener('abort', onAbort);
            resolve(response);
          });
        }),
    );
    const {
      getActiveWorkInteractiveSnapshot,
      getActiveWorkSnapshot,
    } = require('../GlassHiveAccountService');

    const mainRead = getActiveWorkSnapshot({ ownerId: 'owner-concurrent', fetchImpl });
    const interactiveRead = getActiveWorkInteractiveSnapshot({
      ownerId: 'owner-concurrent',
      fetchImpl,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    for (const release of pendingResponses) release();

    await expect(mainRead).resolves.toEqual({
      snapshot: 'unavailable',
      work: null,
      overflowCount: null,
    });
    await expect(interactiveRead).resolves.toMatchObject({
      snapshot: 'fresh',
      work: [{ workRef: 'work-concurrent' }],
    });
  });

  test('does not let an older cold response overwrite a newer interactive observation', async () => {
    const releases = [];
    const fetchImpl = jest.fn(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    const response = (work) => ({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ snapshot: 'fresh', work, overflowCount: 0 }),
    });
    const {
      getActiveWorkInteractiveSnapshot,
      getActiveWorkSnapshot,
    } = require('../GlassHiveAccountService');

    const olderCold = getActiveWorkSnapshot({ ownerId: 'owner-monotonic', fetchImpl });
    const newerInteractive = getActiveWorkInteractiveSnapshot({
      ownerId: 'owner-monotonic',
      fetchImpl,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    releases[1](response([{ workRef: 'newer-work', state: 'running', actions: ['stop'] }]));
    await expect(newerInteractive).resolves.toMatchObject({
      work: [{ workRef: 'newer-work' }],
    });
    releases[0](response([]));
    await olderCold;

    const cacheOnlyFetch = jest.fn().mockRejectedValue(new Error('cache should win'));
    await expect(
      getActiveWorkSnapshot({ ownerId: 'owner-monotonic', fetchImpl: cacheOnlyFetch }),
    ).resolves.toMatchObject({
      snapshot: 'fresh',
      work: [{ workRef: 'newer-work' }],
    });
    expect(cacheOnlyFetch).not.toHaveBeenCalled();
    expect(mockUpdateUserViventiumOrchestrationPreferences).not.toHaveBeenCalledWith(
      'owner-monotonic',
      { knownWork: false },
    );
  });

  test('lets an older-started positive dominate a concurrent newer empty durable hint', async () => {
    const releases = [];
    const fetchImpl = jest.fn(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    const response = (work) => ({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ snapshot: 'fresh', work, overflowCount: 0 }),
    });
    const {
      getActiveWorkInteractiveSnapshot,
      getActiveWorkSnapshot,
    } = require('../GlassHiveAccountService');

    const olderPositive = getActiveWorkInteractiveSnapshot({
      ownerId: 'owner-positive-dominates',
      fetchImpl,
    });
    const newerEmpty = getActiveWorkSnapshot({
      ownerId: 'owner-positive-dominates',
      fetchImpl,
    });
    await new Promise((resolve) => setImmediate(resolve));
    releases[1](response([]));
    await newerEmpty;
    releases[0](response([{ workRef: 'existing-work', state: 'running' }]));
    await olderPositive;

    expect(mockUpdateUserViventiumOrchestrationPreferences).toHaveBeenLastCalledWith(
      'owner-positive-dominates',
      { knownWork: true },
    );
    await expect(
      getActiveWorkSnapshot({
        ownerId: 'owner-positive-dominates',
        fetchImpl: jest.fn().mockRejectedValue(new Error('cache should win')),
      }),
    ).resolves.toMatchObject({ snapshot: 'fresh', work: [] });
  });

  test('clears the focused fast-path hint only from an authoritative fresh empty page', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ snapshot: 'fresh', work: [], overflowCount: 0 }),
    });
    const { getActiveWorkPage } = require('../GlassHiveAccountService');

    await getActiveWorkPage({ ownerId: 'owner-empty', fetchImpl });

    expect(mockUpdateUserViventiumOrchestrationPreferences).toHaveBeenCalledWith('owner-empty', {
      knownWork: false,
    });
    expect(mockHasKnownExternalWork).toHaveBeenCalledWith({ ownerId: 'owner-empty' });
  });

  test('captures the durable epoch before the authoritative GlassHive read and clears by CAS', async () => {
    const events = [];
    mockGetUserParallelWorkKnownEpoch.mockImplementationOnce(async () => {
      events.push('epoch');
      return 7;
    });
    const fetchImpl = jest.fn().mockImplementation(async () => {
      events.push('glasshive');
      return {
        status: 200,
        ok: true,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ snapshot: 'fresh', work: [], overflowCount: 0 }),
      };
    });
    const { getActiveWorkPage } = require('../GlassHiveAccountService');

    await getActiveWorkPage({ ownerId: 'owner-cas-empty', fetchImpl });

    expect(events).toEqual(['epoch', 'glasshive']);
    expect(mockClearUserParallelWorkKnownIfEpoch).toHaveBeenCalledWith('owner-cas-empty', 7);
  });

  test('does not overwrite a cross-instance positive fence with an older empty observation', async () => {
    let durableEpoch = 12;
    mockGetUserParallelWorkKnownEpoch.mockResolvedValueOnce(durableEpoch);
    mockClearUserParallelWorkKnownIfEpoch.mockImplementationOnce(
      async (_ownerId, expectedEpoch) => expectedEpoch === durableEpoch,
    );
    const fetchImpl = jest.fn().mockImplementation(async () => {
      // A separate process records positive work after this request captured epoch 12.
      durableEpoch += 1;
      return {
        status: 200,
        ok: true,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ snapshot: 'fresh', work: [], overflowCount: 0 }),
      };
    });
    const { getActiveWorkPage } = require('../GlassHiveAccountService');

    await getActiveWorkPage({ ownerId: 'owner-cross-instance-race', fetchImpl });

    expect(mockClearUserParallelWorkKnownIfEpoch).toHaveBeenCalledWith(
      'owner-cross-instance-race',
      12,
    );
    expect(mockUpdateUserViventiumOrchestrationPreferences).not.toHaveBeenCalledWith(
      'owner-cross-instance-race',
      { knownWork: false },
    );
  });

  test('keeps known-work true when Core owns a dispatch-ready relation absent from GlassHive', async () => {
    mockHasKnownExternalWork.mockResolvedValueOnce(true);
    const fetchImpl = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ snapshot: 'fresh', work: [], overflowCount: 0 }),
    });
    const { getActiveWorkPage } = require('../GlassHiveAccountService');

    await getActiveWorkPage({ ownerId: 'owner-dispatch-ready', fetchImpl });

    expect(mockUpdateUserViventiumOrchestrationPreferences).toHaveBeenCalledWith(
      'owner-dispatch-ready',
      { knownWork: true },
    );
    expect(mockUpdateUserViventiumOrchestrationPreferences).not.toHaveBeenCalledWith(
      'owner-dispatch-ready',
      { knownWork: false },
    );
  });

  test('rejects a deferred empty CAS after a dispatch-ready positive fence appears', async () => {
    let durableEpoch = 0;
    let releaseEmptyCas;
    mockGetUserParallelWorkKnownEpoch.mockResolvedValueOnce(durableEpoch);
    mockClearUserParallelWorkKnownIfEpoch.mockImplementationOnce(
      (_ownerId, expectedEpoch) =>
        new Promise((resolve) => {
          releaseEmptyCas = () => resolve(expectedEpoch === durableEpoch);
        }),
    );
    mockMarkUserParallelWorkKnown.mockImplementationOnce(async (ownerId) => {
      durableEpoch += 1;
      await mockUpdateUserViventiumOrchestrationPreferences(ownerId, { knownWork: true });
      return true;
    });
    const fetchImpl = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ snapshot: 'fresh', work: [], overflowCount: 0 }),
    });
    const { getActiveWorkPage } = require('../GlassHiveAccountService');

    const pendingEmpty = getActiveWorkPage({ ownerId: 'owner-late-false', fetchImpl });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockClearUserParallelWorkKnownIfEpoch).toHaveBeenCalledWith('owner-late-false', 0);

    // This models another API process publishing the lifecycle-positive fence.
    await mockMarkUserParallelWorkKnown('owner-late-false');
    releaseEmptyCas();
    await pendingEmpty;

    expect(mockUpdateUserViventiumOrchestrationPreferences).toHaveBeenLastCalledWith(
      'owner-late-false',
      { knownWork: true },
    );
    expect(mockHasKnownExternalWork).toHaveBeenCalledTimes(1);
  });

  test('propagates an unavailable Core relation read without attempting an empty CAS', async () => {
    mockHasKnownExternalWork.mockRejectedValueOnce(
      new Error('synthetic_relation_read_unavailable'),
    );
    const fetchImpl = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ snapshot: 'fresh', work: [], overflowCount: 0 }),
    });
    const { getActiveWorkPage } = require('../GlassHiveAccountService');

    await expect(
      getActiveWorkPage({ ownerId: 'owner-recheck-failure', fetchImpl }),
    ).rejects.toThrow('synthetic_relation_read_unavailable');

    expect(mockClearUserParallelWorkKnownIfEpoch).not.toHaveBeenCalled();
    expect(mockMarkUserParallelWorkKnown).not.toHaveBeenCalled();
  });

  test('lets a newer GlassHive-positive fence defeat an already-started empty CAS', async () => {
    const appliedKnownWork = [];
    let durableEpoch = 0;
    let releaseEmptyCas;
    mockGetUserParallelWorkKnownEpoch.mockResolvedValue(durableEpoch);
    mockClearUserParallelWorkKnownIfEpoch.mockImplementationOnce(
      (_ownerId, expectedEpoch) =>
        new Promise((resolve) => {
          releaseEmptyCas = () => resolve(expectedEpoch === durableEpoch);
        }),
    );
    mockMarkUserParallelWorkKnown.mockImplementationOnce(async () => {
      durableEpoch += 1;
      appliedKnownWork.push(true);
      return true;
    });
    const emptyFetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ snapshot: 'fresh', work: [], overflowCount: 0 }),
    });
    const positiveFetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () =>
        JSON.stringify({
          snapshot: 'fresh',
          work: [{ workRef: 'newer-positive', state: 'running' }],
          overflowCount: 0,
        }),
    });
    const { getActiveWorkPage } = require('../GlassHiveAccountService');

    const olderEmpty = getActiveWorkPage({
      ownerId: 'owner-deferred-false',
      fetchImpl: emptyFetch,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(releaseEmptyCas).toEqual(expect.any(Function));
    const newerPositive = getActiveWorkPage({
      ownerId: 'owner-deferred-false',
      fetchImpl: positiveFetch,
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseEmptyCas();
    await Promise.all([olderEmpty, newerPositive]);

    expect(appliedKnownWork).toEqual([true]);
    expect(mockHasKnownExternalWork).toHaveBeenCalledTimes(1);
  });

  test('never clears the focused fast-path hint from an empty later page', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ snapshot: 'fresh', work: [], overflowCount: 0 }),
    });
    const { getActiveWorkPage } = require('../GlassHiveAccountService');

    await getActiveWorkPage({
      ownerId: 'owner-with-first-page-work',
      cursor: 'signed.later-page',
      fetchImpl,
    });

    expect(mockUpdateUserViventiumOrchestrationPreferences).not.toHaveBeenCalled();
  });

  test('preserves FastAPI structured detail codes and user messages', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      status: 409,
      ok: false,
      headers: { get: (name) => (name === 'content-type' ? 'application/json' : null) },
      text: async () =>
        JSON.stringify({
          detail: {
            code: 'active_work_action_in_progress',
            message: 'The matching action is still in progress.',
          },
        }),
    });
    const { requestAccountApi } = require('../GlassHiveAccountService');

    await expect(
      requestAccountApi({ ownerId: 'owner-1', path: '/v1/work/work-1/actions', fetchImpl }),
    ).rejects.toMatchObject({
      message: 'active_work_action_in_progress',
      code: 'active_work_action_in_progress',
      status: 409,
      userMessage: 'The matching action is still in progress.',
    });
  });

  test('derives delegation identity from trusted origin, objective ordinal, and exact goal', () => {
    const { buildTrustedDelegationIdentity } = require('../GlassHiveAccountService');
    const first = buildTrustedDelegationIdentity({
      ownerId: 'owner-1',
      sourceEventId: 'telegram:update:1',
      objectiveOrdinal: 0,
      goal: 'Research A exactly',
    });
    const replay = buildTrustedDelegationIdentity({
      ownerId: 'owner-1',
      sourceEventId: 'telegram:update:1',
      objectiveOrdinal: 0,
      goal: 'Research A exactly',
    });
    const sibling = buildTrustedDelegationIdentity({
      ownerId: 'owner-1',
      sourceEventId: 'telegram:update:1',
      objectiveOrdinal: 1,
      goal: 'Research A exactly',
    });

    expect(first).toEqual(replay);
    expect(first.idempotencyKey).not.toBe(sibling.idempotencyKey);
    expect(first.goalDigest).toHaveLength(64);
    expect(first.idempotencyKey).not.toContain('Research A');
  });

  test('uses stable provider call identity across reconstructed request ordering', () => {
    const { buildTrustedDelegationIdentity } = require('../GlassHiveAccountService');
    const firstProcess = buildTrustedDelegationIdentity({
      ownerId: 'owner-1',
      sourceEventId: 'telegram:update:1',
      objectiveOrdinal: 0,
      callIdentityDigest: 'a'.repeat(64),
      goal: 'Research A exactly',
    });
    const reconstructedAfterReordering = buildTrustedDelegationIdentity({
      ownerId: 'owner-1',
      sourceEventId: 'telegram:update:1',
      objectiveOrdinal: 7,
      callIdentityDigest: 'a'.repeat(64),
      goal: 'Research A exactly',
    });
    const distinctIdenticalCall = buildTrustedDelegationIdentity({
      ownerId: 'owner-1',
      sourceEventId: 'telegram:update:1',
      objectiveOrdinal: 0,
      callIdentityDigest: 'b'.repeat(64),
      goal: 'Research A exactly',
    });

    expect(reconstructedAfterReordering).toEqual(firstProcess);
    expect(distinctIdenticalCall.idempotencyKey).not.toBe(firstProcess.idempotencyKey);
  });

  test('derives action idempotency from account, work, action, and client operation id', () => {
    const { buildTrustedActionIdempotencyKey } = require('../GlassHiveAccountService');
    const first = buildTrustedActionIdempotencyKey({
      ownerId: 'owner-1',
      workRef: 'work-1',
      action: 'stop',
      operationId: '018f47d3-8965-7f6a-a826-7c06afedc001',
    });
    const replay = buildTrustedActionIdempotencyKey({
      ownerId: 'owner-1',
      workRef: 'work-1',
      action: 'stop',
      operationId: '018f47d3-8965-7f6a-a826-7c06afedc001',
    });

    expect(first).toBe(replay);
    expect(first).toHaveLength(64);
  });

  test('returns stale cached work on outage and unavailable when no truthful snapshot exists', async () => {
    const successfulFetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () =>
        JSON.stringify({
          snapshot: 'fresh',
          work: [{ workRef: 'work-1', title: 'Mission', state: 'running', actions: ['stop'] }],
          overflowCount: 0,
        }),
    });
    const {
      clearActiveWorkCacheForTests,
      getActiveWorkSnapshot,
    } = require('../GlassHiveAccountService');

    const fresh = await getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl: successfulFetch });
    expect(fresh.snapshot).toBe('fresh');

    const failingFetch = jest.fn().mockRejectedValue(new Error('offline'));
    const stale = await getActiveWorkSnapshot({
      ownerId: 'owner-1',
      fetchImpl: failingFetch,
      forceRefresh: true,
    });
    expect(stale).toMatchObject({ snapshot: 'stale', work: [{ workRef: 'work-1' }] });
    expect(stale).not.toEqual(expect.objectContaining({ work: [] }));

    clearActiveWorkCacheForTests();
    const unavailable = await getActiveWorkSnapshot({
      ownerId: 'owner-2',
      fetchImpl: failingFetch,
    });
    expect(unavailable).toEqual({
      snapshot: 'unavailable',
      work: null,
      overflowCount: null,
    });
  });

  test('retains Core-owned pre-dispatch attention while GlassHive is unavailable', async () => {
    const retainedAttention = {
      workRef: 'origin-retained-attention',
      title: 'Mission could not start',
      state: 'failed',
      actions: ['dismiss'],
    };
    mockEnrichActiveWorkSnapshot.mockImplementationOnce(async ({ snapshot, includeCoreOnly }) => {
      expect(includeCoreOnly).toBe(true);
      expect(snapshot).toEqual({ snapshot: 'unavailable', work: null, overflowCount: null });
      return { ...snapshot, work: [retainedAttention] };
    });
    const { getActiveWorkSnapshot } = require('../GlassHiveAccountService');

    await expect(
      getActiveWorkSnapshot({
        ownerId: 'owner-retained-attention',
        fetchImpl: jest.fn().mockRejectedValue(new Error('offline')),
      }),
    ).resolves.toEqual({
      snapshot: 'unavailable',
      work: [retainedAttention],
      overflowCount: null,
    });
    expect(mockUpdateUserViventiumOrchestrationPreferences).not.toHaveBeenCalled();
  });

  test('returns an expired snapshot immediately while one shared refresh runs in background', async () => {
    let now = 10_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const response = (workRef) => ({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () =>
        JSON.stringify({
          snapshot: 'fresh',
          work: [{ workRef, title: workRef, state: 'running', actions: [] }],
          overflowCount: 0,
        }),
    });
    let releaseRefresh;
    const refreshResponse = new Promise((resolve) => {
      releaseRefresh = () => resolve(response('work-2'));
    });
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response('work-1'))
      .mockReturnValueOnce(refreshResponse);
    const { getActiveWorkSnapshot } = require('../GlassHiveAccountService');

    await expect(getActiveWorkSnapshot({ ownerId: 'owner-swr', fetchImpl })).resolves.toMatchObject(
      {
        snapshot: 'fresh',
        work: [{ workRef: 'work-1' }],
      },
    );
    now += 2_001;
    await expect(getActiveWorkSnapshot({ ownerId: 'owner-swr', fetchImpl })).resolves.toMatchObject(
      {
        snapshot: 'stale',
        work: [{ workRef: 'work-1' }],
      },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    releaseRefresh();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(getActiveWorkSnapshot({ ownerId: 'owner-swr', fetchImpl })).resolves.toMatchObject(
      {
        snapshot: 'fresh',
        work: [{ workRef: 'work-2' }],
      },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  test('never shares an active-work cache entry between tenant scopes with the same owner id', async () => {
    const firstTenant = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () =>
        JSON.stringify({
          snapshot: 'fresh',
          work: [{ workRef: 'tenant-a-work', title: 'A', state: 'running', actions: [] }],
          overflowCount: 0,
        }),
    });
    const {
      clearActiveWorkCacheForTests,
      getActiveWorkSnapshot,
    } = require('../GlassHiveAccountService');
    clearActiveWorkCacheForTests();
    process.env.VIVENTIUM_TENANT_ID = 'tenant-a';
    await getActiveWorkSnapshot({ ownerId: 'same-owner', fetchImpl: firstTenant });

    process.env.VIVENTIUM_TENANT_ID = 'tenant-b';
    const unavailable = await getActiveWorkSnapshot({
      ownerId: 'same-owner',
      fetchImpl: jest.fn().mockRejectedValue(new Error('offline')),
    });

    expect(unavailable).toEqual({ snapshot: 'unavailable', work: null, overflowCount: null });
  });

  test('invalidates one owner after a committed delegation and ignores its stale in-flight refresh', async () => {
    let releaseOldRefresh;
    const oldRefresh = new Promise((resolve) => {
      releaseOldRefresh = () =>
        resolve({
          status: 200,
          ok: true,
          headers: { get: () => 'application/json' },
          text: async () =>
            JSON.stringify({
              snapshot: 'fresh',
              work: [{ workRef: 'old-work', state: 'running', actions: [] }],
              overflowCount: 0,
            }),
        });
    });
    const fetchImpl = jest
      .fn()
      .mockReturnValueOnce(oldRefresh)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: { get: () => 'application/json' },
        text: async () =>
          JSON.stringify({
            snapshot: 'fresh',
            work: [{ workRef: 'new-work', state: 'queued', actions: ['stop'] }],
            overflowCount: 0,
          }),
      });
    const {
      getActiveWorkSnapshot,
      invalidateActiveWorkSnapshot,
    } = require('../GlassHiveAccountService');

    const pendingOld = getActiveWorkSnapshot({ ownerId: 'owner-invalidate', fetchImpl });
    invalidateActiveWorkSnapshot({ ownerId: 'owner-invalidate' });
    const newSnapshot = await getActiveWorkSnapshot({ ownerId: 'owner-invalidate', fetchImpl });
    expect(newSnapshot.work).toEqual([expect.objectContaining({ workRef: 'new-work' })]);

    releaseOldRefresh();
    await pendingOld;
    await expect(
      getActiveWorkSnapshot({ ownerId: 'owner-invalidate', fetchImpl }),
    ).resolves.toMatchObject({
      snapshot: 'fresh',
      work: [{ workRef: 'new-work' }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('does not let a stale empty refresh clear known work after delegation invalidation', async () => {
    let releaseOldRefresh;
    const oldRefresh = new Promise((resolve) => {
      releaseOldRefresh = () =>
        resolve({
          status: 200,
          ok: true,
          headers: { get: () => 'application/json' },
          text: async () =>
            JSON.stringify({
              snapshot: 'fresh',
              work: [],
              overflowCount: 0,
            }),
        });
    });
    const fetchImpl = jest
      .fn()
      .mockReturnValueOnce(oldRefresh)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: { get: () => 'application/json' },
        text: async () =>
          JSON.stringify({
            snapshot: 'fresh',
            work: [{ workRef: 'new-work', state: 'queued', actions: ['stop'] }],
            overflowCount: 0,
          }),
      });
    const {
      getActiveWorkSnapshot,
      invalidateActiveWorkSnapshot,
    } = require('../GlassHiveAccountService');

    const pendingOld = getActiveWorkSnapshot({ ownerId: 'owner-empty-race', fetchImpl });
    invalidateActiveWorkSnapshot({ ownerId: 'owner-empty-race' });
    await getActiveWorkSnapshot({ ownerId: 'owner-empty-race', fetchImpl });

    releaseOldRefresh();
    await pendingOld;

    expect(mockUpdateUserViventiumOrchestrationPreferences).toHaveBeenCalledWith(
      'owner-empty-race',
      { knownWork: true },
    );
    expect(mockUpdateUserViventiumOrchestrationPreferences).not.toHaveBeenCalledWith(
      'owner-empty-race',
      { knownWork: false },
    );
  });

  test('does not let a pre-invalidation positive suppress a new authoritative empty page', async () => {
    let releaseOldPositive;
    const oldPositive = new Promise((resolve) => {
      releaseOldPositive = () =>
        resolve({
          status: 200,
          ok: true,
          headers: { get: () => 'application/json' },
          text: async () =>
            JSON.stringify({
              snapshot: 'fresh',
              work: [{ workRef: 'dismissed-work', state: 'completed' }],
              overflowCount: 0,
            }),
        });
    });
    const fetchImpl = jest
      .fn()
      .mockReturnValueOnce(oldPositive)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ snapshot: 'fresh', work: [], overflowCount: 0 }),
      });
    const {
      getActiveWorkSnapshot,
      invalidateActiveWorkSnapshot,
    } = require('../GlassHiveAccountService');

    const stalePositive = getActiveWorkSnapshot({ ownerId: 'owner-dismissed', fetchImpl });
    invalidateActiveWorkSnapshot({ ownerId: 'owner-dismissed' });
    await getActiveWorkSnapshot({ ownerId: 'owner-dismissed', fetchImpl });
    releaseOldPositive();
    await stalePositive;

    expect(mockUpdateUserViventiumOrchestrationPreferences).toHaveBeenLastCalledWith(
      'owner-dismissed',
      { knownWork: false },
    );
  });

  test('guards direct first-page reads against stale empty known-work writes', async () => {
    let releaseOldPage;
    const fetchImpl = jest.fn().mockReturnValue(
      new Promise((resolve) => {
        releaseOldPage = () =>
          resolve({
            status: 200,
            ok: true,
            headers: { get: () => 'application/json' },
            text: async () => JSON.stringify({ snapshot: 'fresh', work: [], overflowCount: 0 }),
          });
      }),
    );
    const {
      getActiveWorkPage,
      invalidateActiveWorkSnapshot,
    } = require('../GlassHiveAccountService');

    const pendingOldPage = getActiveWorkPage({ ownerId: 'owner-direct-race', fetchImpl });
    invalidateActiveWorkSnapshot({ ownerId: 'owner-direct-race' });
    releaseOldPage();
    await pendingOldPage;

    expect(mockUpdateUserViventiumOrchestrationPreferences).not.toHaveBeenCalledWith(
      'owner-direct-race',
      { knownWork: false },
    );
  });
});
