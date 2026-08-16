const express = require('express');
const request = require('supertest');

const mockGetUserById = jest.fn();
const mockUpdatePreferences = jest.fn();
const mockGetActiveWorkPage = jest.fn();
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
    mockExecuteGlassHiveWorkAction.mockResolvedValue({
      workRef: 'work-1',
      state: 'stopping',
      actions: [],
    });
    mockRefreshOrchestrationReadiness.mockResolvedValue({ available: false });
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

  test.each([
    [{ mode: 'automatic' }],
    [{ mode: 'parallel', userId: 'foreign-user' }],
    [{}],
  ])('PATCH rejects invalid or authority-bearing input %#', async (body) => {
    await request(createApp()).patch('/api/viventium/orchestration').send(body).expect(400);

    expect(mockUpdatePreferences).not.toHaveBeenCalled();
  });

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
    expect(read.body).toEqual({ available: false, mode: 'focused', hasKnownWork: false });

    const write = await request(createApp())
      .patch('/api/viventium/orchestration')
      .send({ mode: 'parallel' })
      .expect(409);
    expect(write.body.error.code).toBe('PARALLEL_WORK_UNAVAILABLE');
    expect(mockUpdatePreferences).not.toHaveBeenCalled();
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
