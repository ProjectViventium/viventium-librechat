const express = require('express');
const request = require('supertest');
const { createParallelWorkReleaseFixture } = require('../testFixtures/parallelWorkReleaseFixture');

const releaseFixture = createParallelWorkReleaseFixture('viventium-web-release-gate-');
const { openGate, releaseDir, releasePath, validGates, writeReleaseSnapshot } = releaseFixture;

const mockGetUserById = jest.fn();
const mockUpdatePreferences = jest.fn();
const mockGetActiveWorkPage = jest.fn();
const mockGetActiveWorkHistoryPage = jest.fn();
const mockGetActiveWorkInteractiveSnapshot = jest.fn();
const mockExecuteGlassHiveWorkAction = jest.fn();
const mockRefreshOrchestrationReadiness = jest.fn();

jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
  updateUserViventiumOrchestrationPreferences: (...args) => mockUpdatePreferences(...args),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: '507f191e810c19729de860ea' };
    next();
  },
}));

jest.mock('~/server/services/viventium/GlassHiveAccountService', () => ({
  getActiveWorkHistoryPage: (...args) => mockGetActiveWorkHistoryPage(...args),
  getActiveWorkPage: (...args) => mockGetActiveWorkPage(...args),
  getActiveWorkInteractiveSnapshot: (...args) => mockGetActiveWorkInteractiveSnapshot(...args),
}));

jest.mock('~/server/services/viventium/GlassHiveWorkActionService', () => ({
  executeGlassHiveWorkAction: (...args) => mockExecuteGlassHiveWorkAction(...args),
}));

jest.mock('~/server/services/viventium/GlassHiveOrchestrationReadinessService', () => ({
  observeOrchestrationOwner: jest.fn(() => ({
    available: process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE === 'true',
  })),
  orchestrationReadinessSnapshot: jest.fn(() => ({
    available: process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE === 'true',
  })),
  refreshOrchestrationReadiness: (...args) => mockRefreshOrchestrationReadiness(...args),
}));

describe('/api/viventium/orchestration', () => {
  const createApp = () => {
    const app = express();
    app.use(express.json());
    app.use('/api/viventium/orchestration', require('../orchestration'));
    return app;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE = 'true';
    process.env.VIVENTIUM_PARALLEL_WORK_RELEASE_GATE_FILE = releasePath;
    process.env.VIVENTIUM_RUNTIME_DIR = releaseDir;
    releaseFixture.reset();
    mockGetUserById.mockResolvedValue({
      personalization: { orchestration_mode: 'focused' },
    });
    mockUpdatePreferences.mockResolvedValue({
      personalization: { orchestration_mode: 'parallel' },
    });
    mockGetActiveWorkInteractiveSnapshot.mockResolvedValue({
      snapshot: 'fresh',
      work: [],
      overflowCount: 0,
    });
    mockGetActiveWorkPage.mockResolvedValue({
      snapshot: 'fresh',
      work: [{ workRef: 'work-51', state: 'running', actions: ['stop'] }],
      overflowCount: 0,
    });
    mockGetActiveWorkHistoryPage.mockResolvedValue({
      snapshot: 'fresh',
      work: [{ workRef: 'work-history', state: 'completed', actions: [] }],
      overflowCount: 0,
    });
    mockExecuteGlassHiveWorkAction.mockResolvedValue({
      workRef: 'work-1',
      state: 'stopping',
      actions: [],
    });
    mockRefreshOrchestrationReadiness.mockResolvedValue({ available: false });
  });

  afterAll(() => {
    releaseFixture.cleanup();
  });

  test('GET returns the authenticated account preference and never accepts a caller user id', async () => {
    const response = await request(createApp())
      .get('/api/viventium/orchestration?userId=foreign-user')
      .expect(200);

    expect(mockGetUserById).toHaveBeenCalledWith(
      '507f191e810c19729de860ea',
      'personalization.orchestration_mode personalization.parallel_work_known',
    );
    expect(response.body).toEqual({ available: true, mode: 'focused', hasKnownWork: false });
    expect(response.headers['cache-control']).toContain('no-store');
  });

  test('GET treats a legacy missing preference as focused', async () => {
    mockGetUserById.mockResolvedValueOnce({});

    const response = await request(createApp()).get('/api/viventium/orchestration').expect(200);

    expect(response.body).toEqual({ available: true, mode: 'focused', hasKnownWork: false });
  });

  test('GET applies the compiled agent default only when a legacy account has no override', async () => {
    process.env.VIVENTIUM_PARALLEL_WORK_DEFAULT_MODE = 'parallel';
    mockGetUserById.mockResolvedValueOnce({});

    const response = await request(createApp()).get('/api/viventium/orchestration').expect(200);

    expect(response.body).toEqual({ available: true, mode: 'parallel', hasKnownWork: false });
  });

  test('PATCH persists parallel mode only for the authenticated account', async () => {
    const response = await request(createApp())
      .patch('/api/viventium/orchestration')
      .send({ mode: 'parallel' })
      .expect(200);

    expect(mockUpdatePreferences).toHaveBeenCalledWith('507f191e810c19729de860ea', {
      mode: 'parallel',
    });
    expect(response.body).toEqual({ available: true, mode: 'parallel', hasKnownWork: false });
  });

  test('PATCH refreshes a stale unavailable snapshot once before rejecting parallel mode', async () => {
    process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE = 'false';
    mockRefreshOrchestrationReadiness.mockImplementationOnce(async () => {
      process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE = 'true';
      return { available: true };
    });

    const response = await request(createApp())
      .patch('/api/viventium/orchestration')
      .send({ mode: 'parallel' })
      .expect(200);

    expect(mockRefreshOrchestrationReadiness).toHaveBeenCalledWith({
      ownerId: '507f191e810c19729de860ea',
    });
    expect(mockUpdatePreferences).toHaveBeenCalledTimes(1);
    expect(response.body).toEqual({ available: true, mode: 'parallel', hasKnownWork: false });
  });

  test.each([[{ mode: 'automatic' }], [{ mode: 'parallel', userId: 'foreign-user' }], [{}]])(
    'PATCH rejects invalid or authority-bearing input %#',
    async (body) => {
      await request(createApp()).patch('/api/viventium/orchestration').send(body).expect(400);

      expect(mockUpdatePreferences).not.toHaveBeenCalled();
    },
  );

  test('returns not found when the authenticated account no longer exists', async () => {
    mockUpdatePreferences.mockResolvedValueOnce(null);

    const response = await request(createApp())
      .patch('/api/viventium/orchestration')
      .send({ mode: 'parallel' })
      .expect(404);

    expect(response.body).toEqual({
      error: { code: 'ACCOUNT_NOT_FOUND', message: 'Account not found.' },
    });
  });

  test('fails closed to focused and rejects enabling when Parallel work is unavailable', async () => {
    process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE = 'false';
    mockGetUserById.mockResolvedValueOnce({
      personalization: { orchestration_mode: 'parallel' },
    });

    const read = await request(createApp()).get('/api/viventium/orchestration').expect(200);
    expect(read.body).toEqual(
      expect.objectContaining({ available: false, mode: 'focused', hasKnownWork: false }),
    );
    expect(read.body.releaseGate).toBeUndefined();

    const write = await request(createApp())
      .patch('/api/viventium/orchestration')
      .send({ mode: 'parallel' })
      .expect(409);
    expect(write.body.error.code).toBe('PARALLEL_WORK_UNAVAILABLE');
    expect(mockUpdatePreferences).not.toHaveBeenCalled();
  });

  test('GET and PATCH allow explicit pre-gate local QA while release gates remain open', async () => {
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
    mockGetUserById.mockResolvedValue({
      personalization: { orchestration_mode: 'parallel' },
    });

    const read = await request(createApp()).get('/api/viventium/orchestration').expect(200);
    expect(read.body).toEqual(
      expect.objectContaining({
        available: true,
        mode: 'parallel',
        releaseGate: {
          label: 'PRE-GATE / NOT READY',
          blockers: expect.arrayContaining(['REL-UC-004']),
        },
      }),
    );

    const write = await request(createApp())
      .patch('/api/viventium/orchestration')
      .send({ mode: 'parallel' })
      .expect(200);
    expect(write.body).toEqual(
      expect.objectContaining({
        available: true,
        mode: 'parallel',
        releaseGate: {
          label: 'PRE-GATE / NOT READY',
          blockers: expect.arrayContaining(['REL-UC-004']),
        },
      }),
    );
    expect(mockUpdatePreferences).toHaveBeenCalledTimes(1);
  });

  test('GET work preserves stale/unavailable truth and scopes only to the authenticated owner', async () => {
    mockGetActiveWorkInteractiveSnapshot.mockResolvedValueOnce({
      snapshot: 'stale',
      work: [{ workRef: 'work-1', state: 'running', title: 'Research', actions: ['stop'] }],
      overflowCount: 2,
    });

    const response = await request(createApp())
      .get('/api/viventium/orchestration/work?ownerId=foreign')
      .expect(200);

    expect(mockGetActiveWorkInteractiveSnapshot).toHaveBeenCalledWith({
      ownerId: '507f191e810c19729de860ea',
    });
    expect(response.body).toMatchObject({ snapshot: 'stale', overflowCount: 2 });
  });

  test('GET work gives local clients a reachable local View and preserves public View remotely', async () => {
    process.env.GLASSHIVE_PROVIDER_BASE_URL = 'http://127.0.0.1:8766/v1';
    mockGetActiveWorkInteractiveSnapshot.mockResolvedValue({
      snapshot: 'fresh',
      work: [
        {
          workRef: 'work-view',
          state: 'completed',
          title: 'View result',
          viewRef: 'https://glasshive.example.test/w/ghr_safe_view_ref',
          actions: [],
        },
      ],
      overflowCount: 0,
    });

    const local = await request(createApp())
      .get('/api/viventium/orchestration/work')
      .set('Host', 'localhost:3080')
      .expect(200);
    const remote = await request(createApp())
      .get('/api/viventium/orchestration/work')
      .set('Host', 'app.example.test')
      .expect(200);

    expect(local.body.work[0].viewRef).toBe('http://127.0.0.1:8766/w/ghr_safe_view_ref');
    expect(remote.body.work[0].viewRef).toBe('https://glasshive.example.test/w/ghr_safe_view_ref');
  });

  test('GET work accepts only an opaque signed cursor and returns the requested next page', async () => {
    const response = await request(createApp())
      .get('/api/viventium/orchestration/work?cursor=signed.next-page&limit=25')
      .expect(200);

    expect(mockGetActiveWorkPage).toHaveBeenCalledWith({
      ownerId: '507f191e810c19729de860ea',
      cursor: 'signed.next-page',
      limit: 25,
    });
    expect(response.body.work).toEqual([expect.objectContaining({ workRef: 'work-51' })]);

    await request(createApp())
      .get('/api/viventium/orchestration/work?cursor=not%20safe')
      .expect(400);
  });

  test('GET History remains scoped to the authenticated owner', async () => {
    const response = await request(createApp())
      .get('/api/viventium/orchestration/work/history?cursor=signed.history-page&limit=25')
      .expect(200);

    expect(mockGetActiveWorkHistoryPage).toHaveBeenCalledWith({
      ownerId: '507f191e810c19729de860ea',
      cursor: 'signed.history-page',
      limit: 25,
    });
    expect(response.body.work).toEqual([
      expect.objectContaining({ workRef: 'work-history', actions: [] }),
    ]);
  });

  test('POST action derives the GlassHive idempotency key from authenticated identity', async () => {
    const response = await request(createApp())
      .post('/api/viventium/orchestration/work/work-1/actions')
      .send({
        action: 'stop',
        operationId: '018f47d3-8965-7f6a-a826-7c06afedc001',
      })
      .expect(202);

    expect(mockExecuteGlassHiveWorkAction).toHaveBeenCalledWith({
      ownerId: '507f191e810c19729de860ea',
      workRef: 'work-1',
      action: 'stop',
      operationId: '018f47d3-8965-7f6a-a826-7c06afedc001',
    });
    expect(response.body).toMatchObject({ workRef: 'work-1', state: 'stopping' });
  });

  test.each([
    ['foreign%2Fwork', { action: 'stop', operationId: '018f47d3-8965-7f6a-a826-7c06afedc001' }],
    ['work-1', { action: 'terminate', operationId: '018f47d3-8965-7f6a-a826-7c06afedc001' }],
    ['work-1', { action: 'message', instruction: '', operationId: 'not-a-uuid' }],
    ['work-1', { action: 'stop', idempotencyKey: 'caller-chosen' }],
  ])('POST action rejects unsafe work/action input %#', async (workRef, body) => {
    await request(createApp())
      .post(`/api/viventium/orchestration/work/${workRef}/actions`)
      .send(body)
      .expect(400);
    expect(mockExecuteGlassHiveWorkAction).not.toHaveBeenCalled();
  });
});
