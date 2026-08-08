/* === VIVENTIUM START ===
 * Feature: Direct GlassHive issuer assertion security regressions.
 */
const {
  DIRECT_ISSUER_AUDIENCE,
  signatureFor,
  verifyDirectIssuerAssertion,
} = require('../GlassHiveCapabilityDirectIssuerAuth');

function tokenFor(overrides = {}) {
  const claims = {
    aud: DIRECT_ISSUER_AUDIENCE,
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    worker_id: 'worker-a',
    run_id: 'run-a',
    execution_mode: 'docker',
    action: 'grant',
    binding_proof: 'operator_verified',
    iat: 1000,
    exp: 1060,
    nonce: '1234567890abcdef1234567890abcdef',
    ...overrides,
  };
  claims.sig = signatureFor(
    claims,
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_ISSUER_SECRET,
  );
  return Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
}

describe('GlassHive direct capability issuer auth', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      VIVENTIUM_GLASSHIVE_CAPABILITY_ISSUER_SECRET:
        'synthetic-direct-issuer-secret-with-at-least-32-bytes',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('accepts an exact tenant, user, worker, run, and action scope', () => {
    expect(
      verifyDirectIssuerAssertion(tokenFor(), {
        action: 'grant',
        expectedTenantId: 'tenant-a',
        nowMs: 1_020_000,
      }),
    ).toMatchObject({
      user_id: 'user-a',
      worker_id: 'worker-a',
      run_id: 'run-a',
    });
  });

  test('rejects cross-user tampering and wrong-tenant replay', () => {
    const token = tokenFor();
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    decoded.user_id = 'user-b';
    const tampered = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');

    expect(() =>
      verifyDirectIssuerAssertion(tampered, {
        action: 'grant',
        expectedTenantId: 'tenant-a',
        nowMs: 1_020_000,
      }),
    ).toThrow(/signature/);
    expect(() =>
      verifyDirectIssuerAssertion(token, {
        action: 'grant',
        expectedTenantId: 'tenant-b',
        nowMs: 1_020_000,
      }),
    ).toThrow(/scope/);
  });

  test('rejects expired assertions and action replay', () => {
    const token = tokenFor();
    expect(() =>
      verifyDirectIssuerAssertion(token, {
        action: 'grant',
        expectedTenantId: 'tenant-a',
        nowMs: 1_061_000,
      }),
    ).toThrow(/scope/);
    expect(() =>
      verifyDirectIssuerAssertion(token, {
        action: 'revoke',
        expectedTenantId: 'tenant-a',
        nowMs: 1_020_000,
      }),
    ).toThrow(/scope/);
  });
});
/* === VIVENTIUM END === */
