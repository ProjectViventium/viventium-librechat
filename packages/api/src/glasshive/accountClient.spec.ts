import crypto from 'node:crypto';
import {
  buildTrustedActionIdempotencyKey,
  buildTrustedDelegationIdentity,
  createServiceAssertion,
  requestAccountApi,
  signTrustedDelegationIdentity,
} from './accountClient';

const originalEnv = { ...process.env };

describe('GlassHive account client', () => {
  beforeEach(() => {
    process.env.VIVENTIUM_GLASSHIVE_SERVICE_ASSERTION_SECRET = 'synthetic-service-secret';
    process.env.WPR_API_TOKEN = 'synthetic-api-token';
    process.env.GLASSHIVE_PROVIDER_BASE_URL = 'http://127.0.0.1:8766/v1';
    process.env.VIVENTIUM_TENANT_ID = 'local-public-test';
    delete process.env.VIVENTIUM_ACTIVE_WORK_ACTION_TIMEOUT_MS;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('creates the exact short-lived owner assertion contract', () => {
    const assertion = createServiceAssertion({
      ownerId: 'owner-1',
      nowMs: 1_800_000_000_000,
      nonce: 'nonce-0001',
    });
    const [encoded, signature] = assertion.split('.');
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));

    expect(signature).toBe(
      crypto.createHmac('sha256', 'synthetic-service-secret').update(encoded).digest('base64url'),
    );
    expect(payload).toEqual({
      v: 1,
      aud: 'glasshive-account-api',
      tenant_id: 'local-public-test',
      owner_id: 'owner-1',
      iat: 1_800_000_000,
      exp: 1_800_000_060,
      nonce: 'nonce-0001',
    });
  });

  it('calls only the configured origin with bounded owner-scoped authentication', async () => {
    const fetchImpl = jest.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ snapshot: 'fresh', work: [], overflowCount: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(
      requestAccountApi({
        ownerId: 'owner-1',
        path: '/v1/active-work?limit=50',
        fetchImpl,
      }),
    ).resolves.toEqual({ snapshot: 'fresh', work: [], overflowCount: 0 });

    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8766/v1/active-work?limit=50');
    expect(request?.headers).toMatchObject({ Authorization: 'Bearer synthetic-api-token' });
    expect(request?.redirect).toBe('error');
  });

  it('does not call fetch when a path attempts to escape the configured origin', async () => {
    const fetchImpl = jest.fn();

    await expect(
      requestAccountApi({
        ownerId: 'owner-1',
        path: '/v1///attacker.invalid/collect',
        fetchImpl,
      }),
    ).rejects.toThrow('glasshive_account_path_invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('gives accepted work actions enough time to settle without changing read deadlines', async () => {
    const timeoutSpy = jest
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => new AbortController().signal);
    const fetchImpl = jest.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ workRef: 'work-1', state: 'queued' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await requestAccountApi({
      ownerId: 'owner-1',
      path: '/v1/work/work-1/actions',
      method: 'POST',
      body: { action: 'steer' },
      fetchImpl,
    });
    expect(timeoutSpy).toHaveBeenLastCalledWith(15000);

    await requestAccountApi({ ownerId: 'owner-1', path: '/v1/work/work-1', fetchImpl });
    expect(timeoutSpy).toHaveBeenLastCalledWith(5000);

    process.env.VIVENTIUM_ACTIVE_WORK_ACTION_TIMEOUT_MS = '18000';
    await requestAccountApi({
      ownerId: 'owner-1',
      path: '/v1/work/work-1/actions',
      method: 'POST',
      body: { action: 'steer' },
      fetchImpl,
    });
    expect(timeoutSpy).toHaveBeenLastCalledWith(18000);

    timeoutSpy.mockRestore();
  });

  it('derives stable Core-owned delegation and action identities', () => {
    const delegation = buildTrustedDelegationIdentity({
      ownerId: 'owner-1',
      sourceEventId: 'event-1',
      objectiveOrdinal: 2,
      callIdentityDigest: 'a'.repeat(64),
      goal: 'Complete the synthetic task',
    });
    expect(delegation.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(delegation.goalDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      buildTrustedActionIdempotencyKey({
        ownerId: 'owner-1',
        workRef: 'work-1',
        action: 'cancel',
        operationId: 'operation-1',
      }),
    ).toMatch(/^[a-f0-9]{64}$/);

    expect(
      signTrustedDelegationIdentity(
        {
          version: 2,
          idempotency_key: delegation.idempotencyKey,
          goal_digest: delegation.goalDigest,
          launch_payload_digest: 'b'.repeat(64),
          call_identity_digest: 'a'.repeat(64),
          source_event_id: 'event-1',
          objective_ordinal: 2,
        },
        { ownerId: 'owner-1' },
      ),
    ).toMatch(/^[a-f0-9]{64}$/);
  });
  it('binds explicit owner input to the exact transmitted body including Unicode and numbers', async () => {
    const nativeInput = {
      version: 1 as const,
      requestId: 'input-1',
      requestFingerprint: 'b'.repeat(64),
      action: 'accept' as const,
      content: { text: 'Résumé', small: 1e-8, whole: 1, allowed: false },
    };
    const fetchImpl = jest.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('{}', { status: 202, headers: { 'Content-Type': 'application/json' } }),
    );
    await requestAccountApi({
      ownerId: 'owner-1',
      path: '/v1/work/work-1/actions',
      method: 'POST',
      ownerNativeInput: nativeInput,
      body: { action: 'resume', idempotencyKey: 'operation-1', nativeInput },
      fetchImpl,
    });
    const request = fetchImpl.mock.calls[0][1] as RequestInit;
    const assertion = (request.headers as Record<string, string>)['X-Viventium-Service-Assertion'];
    const claims = JSON.parse(Buffer.from(assertion.split('.')[0], 'base64url').toString());
    expect(claims.native_input_digest).toBe(
      crypto.createHash('sha256').update(String(request.body), 'utf8').digest('hex'),
    );
    expect(claims.owner_id).toBe('owner-1');
  });
});
