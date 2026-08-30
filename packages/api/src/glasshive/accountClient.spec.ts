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
});
