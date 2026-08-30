const express = require('express');
const request = require('supertest');
const { readFileSync } = require('fs');

const mockExecute = jest.fn();
const mockSweep = jest.fn();
const mockRequireJwtAuth = jest.fn();
const mockCheckAdmin = jest.fn();

jest.mock('~/server/services/viventium/PersonalAccountCleanupExecutionService', () => ({
  executePersonalAccountCleanup: (...args) => mockExecute(...args),
  verifyPersonalAccountCleanupSweep: (...args) => mockSweep(...args),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (...args) => mockRequireJwtAuth(...args),
  checkAdmin: (...args) => mockCheckAdmin(...args),
}));

describe('/api/viventium/personal-account-cleanup', () => {
  beforeEach(() => {
    jest.resetModules();
    mockExecute.mockReset();
    mockSweep.mockReset();
    mockRequireJwtAuth.mockReset().mockImplementation((req, _res, next) => {
      req.user = { id: 'owner-cleanup-1', role: 'ADMIN' };
      next();
    });
    mockCheckAdmin.mockReset().mockImplementation((_req, _res, next) => next());
  });

  function app() {
    const router = require('../personalAccountCleanup');
    const server = express();
    server.use(express.json());
    server.use('/api/viventium/personal-account-cleanup', router);
    return server;
  }

  test('is mounted on the Viventium router at the public contract path', () => {
    const source = readFileSync(require.resolve('../index'), 'utf8');
    expect(source).toContain("require('./personalAccountCleanup')");
    expect(source).toContain("router.use('/personal-account-cleanup', personalAccountCleanup)");
  });

  test('executes only as the authenticated owner with explicit reviewed authorization', async () => {
    mockExecute.mockResolvedValue({
      status: 'completed',
      operationId: 'cleanup-operation-1',
      ownerScopeHash: `sha256:${'a'.repeat(64)}`,
      targetSetSha256: 'b'.repeat(64),
      targetCount: 2,
      resumed: false,
    });
    const response = await request(app())
      .post('/api/viventium/personal-account-cleanup/execute')
      .send({
        confirmation: 'EXECUTE_REVIEWED_SYNTHETIC_QA_CLEANUP',
        attemptId: 'cleanup-attempt-1',
        registration: { ownerId: 'owner-cleanup-1' },
        backupAuthority: { proof: 'ed25519:fixture' },
        authenticatedOwnerId: 'attacker-controlled',
      })
      .expect(200);

    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatedOwnerId: 'owner-cleanup-1',
        confirmation: 'EXECUTE_REVIEWED_SYNTHETIC_QA_CLEANUP',
      }),
    );
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.body).not.toHaveProperty('targets');
    expect(response.body).not.toHaveProperty('backupAuthority');
  });

  test('requires administrator review authority after owner authentication', async () => {
    mockCheckAdmin.mockImplementation((_req, res) => res.status(403).json({ error: 'forbidden' }));

    await request(app())
      .post('/api/viventium/personal-account-cleanup/execute')
      .send({ confirmation: 'EXECUTE_REVIEWED_SYNTHETIC_QA_CLEANUP' })
      .expect(403);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('returns a typed retryable partial result without private error details', async () => {
    const error = new Error('cleanup_execution_partial_failure');
    error.name = 'PersonalAccountCleanupPartialFailure';
    error.code = 'cleanup_target_cas_conflict';
    error.stack = 'private path and target content';
    mockExecute.mockRejectedValue(error);

    const response = await request(app())
      .post('/api/viventium/personal-account-cleanup/execute')
      .send({
        confirmation: 'EXECUTE_REVIEWED_SYNTHETIC_QA_CLEANUP',
        attemptId: 'cleanup-attempt-1',
        registration: { ownerId: 'owner-cleanup-1' },
        backupAuthority: { proof: 'ed25519:fixture' },
      })
      .expect(503);

    expect(response.body).toEqual({
      status: 'partial_retryable',
      error: 'cleanup_target_cas_conflict',
    });
    expect(JSON.stringify(response.body)).not.toContain('private path');
  });

  test('exposes delayed verification through the same owner and review boundary', async () => {
    mockSweep.mockResolvedValue({
      status: 'verified',
      operationId: 'cleanup-operation-1',
      ownerScopeHash: `sha256:${'a'.repeat(64)}`,
      targetSetSha256: 'b'.repeat(64),
      verifiedTargetCount: 2,
      receiptSha256: 'c'.repeat(64),
    });

    await request(app())
      .post('/api/viventium/personal-account-cleanup/sweep')
      .send({
        confirmation: 'EXECUTE_REVIEWED_SYNTHETIC_QA_CLEANUP',
        registration: { ownerId: 'owner-cleanup-1' },
        backupAuthority: { proof: 'ed25519:fixture' },
        runNonce: 'synthetic-run-1',
      })
      .expect(200);

    expect(mockSweep).toHaveBeenCalledWith(
      expect.objectContaining({ authenticatedOwnerId: 'owner-cleanup-1' }),
    );
  });
});
