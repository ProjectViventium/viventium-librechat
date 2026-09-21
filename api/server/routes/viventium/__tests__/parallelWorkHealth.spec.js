const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { createParallelWorkReleaseFixture } = require('../testFixtures/parallelWorkReleaseFixture');

const releaseFixture = createParallelWorkReleaseFixture('viventium-health-release-gate-');
const { openGate, releaseDir, releasePath, validGates, writeReleaseSnapshot } = releaseFixture;
const localQaRequestPath = path.join(releaseDir, 'parallel-work-local-qa-request.json');
const mockRefreshOrchestrationReadiness = jest.fn();
const mockRefreshStartupOrchestrationReadiness = jest.fn();

jest.mock('~/server/services/viventium/GlassHiveOrchestrationReadinessService', () => ({
  refreshOrchestrationReadiness: (...args) => mockRefreshOrchestrationReadiness(...args),
  refreshStartupOrchestrationReadiness: (...args) =>
    mockRefreshStartupOrchestrationReadiness(...args),
}));

describe('/api/viventium/health/parallel-work', () => {
  const originalSecret = process.env.VIVENTIUM_TELEGRAM_SECRET;
  const createApp = () => {
    const app = express();
    app.use('/api/viventium/health/parallel-work', require('../parallelWorkHealth'));
    return app;
  };
  const signedOwnerHeaders = (ownerId) => ({
    'X-VIVENTIUM-OWNER-ID': ownerId,
    'X-VIVENTIUM-OWNER-SIGNATURE': crypto
      .createHmac('sha256', 'synthetic-health-secret')
      .update(`parallel-work-health:v1:${ownerId}`)
      .digest('hex'),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VIVENTIUM_TELEGRAM_SECRET = 'synthetic-health-secret';
    process.env.VIVENTIUM_PARALLEL_WORK_RELEASE_GATE_FILE = releasePath;
    process.env.VIVENTIUM_RUNTIME_DIR = releaseDir;
    fs.rmSync(localQaRequestPath, { force: true });
    releaseFixture.reset();
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.VIVENTIUM_TELEGRAM_SECRET;
    else process.env.VIVENTIUM_TELEGRAM_SECRET = originalSecret;
    releaseFixture.cleanup();
  });

  test('rejects anonymous probes without doing account or GlassHive work', async () => {
    const response = await request(createApp())
      .get('/api/viventium/health/parallel-work')
      .expect(401);

    expect(response.body).toEqual({ ready: false });
    expect(mockRefreshOrchestrationReadiness).not.toHaveBeenCalled();
    expect(mockRefreshStartupOrchestrationReadiness).not.toHaveBeenCalled();
  });

  test('returns deployment readiness without borrowing a last-observed account', async () => {
    mockRefreshStartupOrchestrationReadiness.mockResolvedValueOnce({
      requested: true,
      available: false,
      status: 'unready',
      reason: 'deployment_scope_unverified',
      storagePressure: {
        status: 'unknown',
        reason: 'storage_capability_missing',
      },
      promptLayers: {
        status: 'unknown',
        reason: 'prompt_layer_capability_missing',
      },
    });

    const response = await request(createApp())
      .get('/api/viventium/health/parallel-work')
      .set('X-VIVENTIUM-TELEGRAM-SECRET', 'synthetic-health-secret')
      .expect(503);

    expect(mockRefreshStartupOrchestrationReadiness).toHaveBeenCalledTimes(1);
    expect(mockRefreshOrchestrationReadiness).not.toHaveBeenCalled();
    expect(response.body).toEqual({
      ready: false,
      releaseReady: true,
      scope: 'deployment',
      requested: true,
      status: 'unready',
      reason: 'deployment_scope_unverified',
      label: 'NOT READY',
      blockers: ['deployment_scope_unverified'],
      storagePressure: {
        status: 'unknown',
        reason: 'storage_capability_missing',
      },
      promptLayers: {
        status: 'unknown',
        reason: 'prompt_layer_capability_missing',
      },
    });
    expect(response.headers['cache-control']).toContain('no-store');
  });

  test('uses an owner only when its identity has a valid structural signature', async () => {
    mockRefreshOrchestrationReadiness.mockResolvedValueOnce({
      requested: true,
      available: true,
      status: 'ready',
      reason: '',
      storagePressure: {
        status: 'healthy',
        usedPercent: 50,
        availableBytes: 1000,
        thresholdPercent: 95,
      },
      promptLayers: { status: 'verified', unknownLayerCount: 0 },
      sourceOrder: { status: 'verified', durability: 'durable', replicaSafe: true },
    });

    const response = await request(createApp())
      .get('/api/viventium/health/parallel-work')
      .set('X-VIVENTIUM-TELEGRAM-SECRET', 'synthetic-health-secret')
      .set(signedOwnerHeaders('owner-1'))
      .expect(200);

    expect(mockRefreshOrchestrationReadiness).toHaveBeenCalledWith({ ownerId: 'owner-1' });
    expect(mockRefreshStartupOrchestrationReadiness).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({
      ready: true,
      scope: 'owner',
      sourceOrder: { status: 'verified', durability: 'durable', replicaSafe: true },
    });
  });

  test('returns the typed fail-closed owner-probe capacity state', async () => {
    mockRefreshOrchestrationReadiness.mockResolvedValueOnce({
      requested: true,
      available: false,
      status: 'capacity_limited',
      reason: 'readiness_probe_capacity_limited',
      label: 'NOT READY',
      blockers: expect.arrayContaining(['readiness_probe_capacity_limited']),
      storagePressure: { status: 'unknown', reason: 'storage_capability_not_probed' },
      promptLayers: { status: 'unknown', reason: 'prompt_layer_capability_not_probed' },
    });

    const response = await request(createApp())
      .get('/api/viventium/health/parallel-work')
      .set('X-VIVENTIUM-TELEGRAM-SECRET', 'synthetic-health-secret')
      .set(signedOwnerHeaders('owner-1'))
      .expect(503);

    expect(response.body).toMatchObject({
      ready: false,
      scope: 'owner',
      status: 'capacity_limited',
      reason: 'readiness_probe_capacity_limited',
    });
    expect(mockRefreshStartupOrchestrationReadiness).not.toHaveBeenCalled();
  });

  test('rejects an owner header that is not bound to the authenticated probe', async () => {
    const response = await request(createApp())
      .get('/api/viventium/health/parallel-work')
      .set('X-VIVENTIUM-TELEGRAM-SECRET', 'synthetic-health-secret')
      .set('X-VIVENTIUM-OWNER-ID', 'owner-2')
      .set(signedOwnerHeaders('owner-1'))
      .set('X-VIVENTIUM-OWNER-ID', 'owner-2')
      .expect(401);

    expect(response.body).toEqual({ ready: false });
    expect(mockRefreshOrchestrationReadiness).not.toHaveBeenCalled();
    expect(mockRefreshStartupOrchestrationReadiness).not.toHaveBeenCalled();
  });

  test.each([
    [
      {
        requested: true,
        available: true,
        status: 'ready',
        reason: '',
        storagePressure: {
          status: 'healthy',
          usedPercent: 50,
          availableBytes: 1000,
          thresholdPercent: 95,
        },
        promptLayers: { status: 'verified', unknownLayerCount: 0 },
      },
      true,
    ],
    [
      {
        requested: false,
        available: false,
        status: 'disabled',
        reason: '',
        storagePressure: { status: 'unknown', reason: 'storage_capability_missing' },
        promptLayers: { status: 'unknown', reason: 'prompt_layer_capability_missing' },
      },
      false,
    ],
  ])('returns 200 when Telegram can safely accept work %#', async (snapshot, requested) => {
    mockRefreshStartupOrchestrationReadiness.mockResolvedValueOnce(snapshot);

    const response = await request(createApp())
      .get('/api/viventium/health/parallel-work')
      .set('X-VIVENTIUM-TELEGRAM-SECRET', 'synthetic-health-secret')
      .expect(200);

    expect(response.body).toEqual({
      ready: true,
      releaseReady: true,
      scope: 'deployment',
      requested,
      status: snapshot.status,
      reason: '',
      label: requested ? 'READY' : 'NOT READY',
      blockers: requested ? [] : ['disabled'],
      storagePressure: snapshot.storagePressure,
      promptLayers: snapshot.promptLayers,
    });
  });

  test('allows local QA exposure but keeps the compiled not-ready label and blockers', async () => {
    const gate = openGate('REL-UC-004');
    const gates = validGates().map((item) => (item.case_id === gate.case_id ? gate : item));
    writeReleaseSnapshot({
      mode: 'local-qa',
      label: 'PRE-GATE / NOT READY',
      release_ready: false,
      exposure_allowed: true,
      local_qa_override: true,
      gate_count: gates.length,
      open_gate_count: 1,
      gates,
      open_gates: [gate],
    });
    mockRefreshOrchestrationReadiness.mockResolvedValueOnce({
      requested: true,
      available: true,
      status: 'ready',
      reason: '',
      storagePressure: {
        status: 'healthy',
        usedPercent: 50,
        availableBytes: 1000,
        thresholdPercent: 95,
      },
      promptLayers: { status: 'verified', unknownLayerCount: 0 },
    });

    const response = await request(createApp())
      .get('/api/viventium/health/parallel-work')
      .set('X-VIVENTIUM-TELEGRAM-SECRET', 'synthetic-health-secret')
      .set(signedOwnerHeaders('owner-1'))
      .expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        ready: true,
        releaseReady: false,
        label: 'PRE-GATE / NOT READY',
        reason: 'local_qa_override',
        blockers: expect.arrayContaining(['REL-UC-004']),
      }),
    );
  });

  test.each([
    ['unready', 'readiness_probe_failed'],
    ['capacity_limited', 'readiness_probe_capacity_limited'],
    ['unknown', 'readiness_probe_unavailable'],
  ])('keeps PRE-GATE / NOT READY when local QA operational state is %s', async (status, reason) => {
    writeReleaseSnapshot({
      mode: 'local-qa',
      label: 'PRE-GATE / NOT READY',
      release_ready: false,
      exposure_allowed: true,
      local_qa_override: true,
    });
    mockRefreshOrchestrationReadiness.mockResolvedValueOnce({
      requested: true,
      available: false,
      status,
      reason,
      storagePressure: { status: 'unknown', reason: 'storage_capability_not_probed' },
      promptLayers: { status: 'unknown', reason: 'prompt_layer_capability_not_probed' },
    });

    const response = await request(createApp())
      .get('/api/viventium/health/parallel-work')
      .set('X-VIVENTIUM-TELEGRAM-SECRET', 'synthetic-health-secret')
      .set(signedOwnerHeaders('owner-1'))
      .expect(503);

    expect(response.body).toEqual(
      expect.objectContaining({
        ready: false,
        releaseReady: false,
        label: 'PRE-GATE / NOT READY',
        status,
        reason,
      }),
    );
  });

  test('uses PRE-GATE for a malformed snapshot while explicit local QA remains requested', async () => {
    fs.writeFileSync(
      localQaRequestPath,
      `${JSON.stringify({ contractVersion: 1, mode: 'local-qa', requested: true })}\n`,
    );
    fs.writeFileSync(releasePath, '{');
    mockRefreshOrchestrationReadiness.mockResolvedValueOnce({
      requested: true,
      available: false,
      status: 'unknown',
      reason: 'readiness_probe_unavailable',
      storagePressure: { status: 'unknown', reason: 'storage_capability_not_probed' },
      promptLayers: { status: 'unknown', reason: 'prompt_layer_capability_not_probed' },
    });

    const response = await request(createApp())
      .get('/api/viventium/health/parallel-work')
      .set('X-VIVENTIUM-TELEGRAM-SECRET', 'synthetic-health-secret')
      .set(signedOwnerHeaders('owner-1'))
      .expect(503);

    expect(response.body).toEqual(
      expect.objectContaining({
        ready: false,
        releaseReady: false,
        label: 'PRE-GATE / NOT READY',
        reason: 'readiness_probe_unavailable',
      }),
    );
  });
});
