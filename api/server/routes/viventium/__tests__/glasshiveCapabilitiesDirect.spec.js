/* === VIVENTIUM START ===
 * Feature: Direct user-scoped GlassHive capability issuer route regressions.
 */
const express = require('express');
const request = require('supertest');

const RAW_PROVIDER_SECRET = 'synthetic-provider-secret-never-return';
const mockGetUserById = jest.fn();
const mockFindUser = jest.fn();
const mockRememberInvocation = jest.fn();
const mockVerifyAssertion = jest.fn();
const mockReadiness = jest.fn();
const mockBuildBundle = jest.fn();
const mockRevoke = jest.fn();

jest.mock('~/models', () => ({
  findUser: (...args) => mockFindUser(...args),
  getUserById: (...args) => mockGetUserById(...args),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('~/server/services/viventium/GlassHiveCapabilityBrokerAuth', () => ({
  assertBrokerGrantActive: jest.fn(),
  rememberBrokerRequest: jest.fn(),
  rememberInvocation: (...args) => mockRememberInvocation(...args),
  resolveBrokerTenantId: () => 'tenant-a',
  verifyBrokerGrant: jest.fn(),
}));

jest.mock('~/server/services/viventium/GlassHiveCapabilityBrokerService', () => ({
  buildCapabilityCatalog: jest.fn(),
  handleToolCall: jest.fn(),
  toolDefinitionsForMcp: jest.fn(),
}));

jest.mock('~/server/services/viventium/GlassHiveCapabilityBootstrapService', () => ({
  buildDirectGlassHiveCapabilityBundle: (...args) => mockBuildBundle(...args),
  directCapabilityReadiness: (...args) => mockReadiness(...args),
  revokeDirectGlassHiveCapabilityGrant: (...args) => mockRevoke(...args),
}));

jest.mock('~/server/services/viventium/GlassHiveCapabilityDirectIssuerAuth', () => ({
  verifyDirectIssuerAssertion: (...args) => mockVerifyAssertion(...args),
}));

function appWithRoute() {
  const app = express();
  app.use(express.json());
  app.use('/api/viventium/glasshive/capabilities', require('../glasshiveCapabilities'));
  return app;
}

describe('GlassHive direct capability issuer routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyAssertion.mockImplementation((_token, { action }) => ({
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      worker_id: action === 'status' ? '' : 'worker-a',
      run_id: action === 'status' ? '' : 'run-a',
      execution_mode: 'docker',
      action,
      binding_proof: 'operator_verified',
    }));
    mockRememberInvocation.mockResolvedValue({ accepted: true, replayChecked: true });
    mockGetUserById.mockResolvedValue({
      _id: 'user-a',
      role: 'USER',
      viventiumApprovalStatus: 'approved',
    });
    mockReadiness.mockResolvedValue({
      status: 'action_required',
      reason: 'connected_account_action_required',
      connections: [
        {
          connection_id: 'librechat:documents',
          label: 'Documents',
          kind: 'documents',
          adapter: 'librechat_capability_broker',
          status: 'action_required',
        },
      ],
    });
    mockBuildBundle.mockResolvedValue({
      bootstrapBundle: {
        env: { GLASSHIVE_CAPABILITY_BROKER_TOKEN: 'synthetic-run-bound-grant' },
      },
      grantRef: {
        grant_id: 'ghcb_direct_12345678',
        user_id: 'user-a',
        worker_id: 'worker-a',
        run_id: 'run-a',
      },
      capabilityStatus: { status: 'ready', connections: [] },
    });
    mockRevoke.mockResolvedValue({ revoked: true, grantId: 'ghcb_direct_12345678' });
  });

  test('returns only redacted readiness for the mapped user', async () => {
    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/direct/status')
      .set('Authorization', 'Bearer synthetic-s2s-assertion')
      .expect(200);

    expect(response.body).toEqual({
      status: 'action_required',
      reason: 'connected_account_action_required',
      connections: [
        {
          connection_id: 'librechat:documents',
          label: 'Documents',
          kind: 'documents',
          adapter: 'librechat_capability_broker',
          status: 'action_required',
        },
      ],
    });
    expect(mockReadiness).toHaveBeenCalledWith({
      user: expect.objectContaining({ id: 'user-a' }),
      executionMode: 'docker',
    });
    expect(JSON.stringify(response.body)).not.toContain(RAW_PROVIDER_SECRET);
  });

  test('issues only a short-lived worker/run bundle and never a provider credential', async () => {
    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/direct/grant')
      .set('Authorization', 'Bearer synthetic-s2s-assertion')
      .expect(200);

    expect(mockBuildBundle).toHaveBeenCalledWith({
      user: expect.objectContaining({ id: 'user-a' }),
      workerId: 'worker-a',
      runId: 'run-a',
      executionMode: 'docker',
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.grantRef).toMatchObject({
      user_id: 'user-a',
      worker_id: 'worker-a',
      run_id: 'run-a',
    });
    expect(JSON.stringify(response.body)).not.toContain(RAW_PROVIDER_SECRET);
  });

  test('revokes only the assertion-bound worker/run grant', async () => {
    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/direct/revoke')
      .set('Authorization', 'Bearer synthetic-s2s-assertion')
      .send({ grant_id: 'ghcb_direct_12345678', renewable_until: 12345 })
      .expect(200);

    expect(mockRevoke).toHaveBeenCalledWith({
      user: expect.objectContaining({ id: 'user-a' }),
      workerId: 'worker-a',
      runId: 'run-a',
      executionMode: 'docker',
      grantId: 'ghcb_direct_12345678',
      renewableUntil: 12345,
    });
    expect(response.body).toEqual({ revoked: true, grant_id: 'ghcb_direct_12345678' });
  });

  test('rejects unavailable mapped users before status or grant resolution', async () => {
    mockGetUserById.mockResolvedValue({
      _id: 'user-a',
      viventiumApprovalStatus: 'denied',
    });

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/direct/grant')
      .set('Authorization', 'Bearer synthetic-s2s-assertion')
      .expect(401);

    expect(response.body.error.code).toBe('user_unavailable');
    expect(mockBuildBundle).not.toHaveBeenCalled();
  });

  test('resolves a shared OIDC principal hash without a per-user static database id', async () => {
    mockVerifyAssertion.mockReturnValue({
      tenant_id: 'tenant-a',
      user_id: 'usr_0123456789abcdef0123456789abcdef',
      worker_id: '',
      run_id: '',
      execution_mode: 'docker',
      action: 'status',
      binding_proof: 'shared_oidc_subject',
      nonce: 'shared-oidc-nonce',
    });
    mockFindUser.mockResolvedValue({
      _id: 'user-a',
      role: 'USER',
      viventiumApprovalStatus: 'approved',
    });

    await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/direct/status')
      .set('Authorization', 'Bearer synthetic-s2s-assertion')
      .expect(200);

    expect(mockFindUser).toHaveBeenCalledWith(
      { viventiumGlassHivePrincipalId: 'usr_0123456789abcdef0123456789abcdef' },
      expect.any(String),
    );
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  test('returns a first-class unmapped state until shared-OIDC re-login backfills the link', async () => {
    mockVerifyAssertion.mockReturnValue({
      tenant_id: 'tenant-a',
      user_id: 'usr_0123456789abcdef0123456789abcdef',
      worker_id: '',
      run_id: '',
      execution_mode: 'docker',
      action: 'status',
      binding_proof: 'shared_oidc_subject',
      nonce: 'not-linked-nonce',
    });
    mockFindUser.mockResolvedValue(null);

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/direct/status')
      .set('Authorization', 'Bearer synthetic-s2s-assertion')
      .expect(409);

    expect(response.body.status).toBe('unmapped');
    expect(response.body.error.code).toBe('owner_binding_required');
    expect(mockReadiness).not.toHaveBeenCalled();
  });

  test('fails closed when the shared replay cache rejects an assertion nonce', async () => {
    mockRememberInvocation.mockResolvedValue({
      accepted: false,
      replayChecked: true,
      reason: 'issuer_assertion_replay',
    });

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/direct/grant')
      .set('Authorization', 'Bearer synthetic-s2s-assertion')
      .expect(409);

    expect(response.body.error.code).toBe('issuer_assertion_replay');
    expect(mockBuildBundle).not.toHaveBeenCalled();
  });
});
/* === VIVENTIUM END === */
