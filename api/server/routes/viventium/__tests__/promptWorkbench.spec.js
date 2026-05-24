/* === VIVENTIUM START ===
 * Feature: Prompt Workbench local launcher route tests.
 * === VIVENTIUM END === */

const express = require('express');
const request = require('supertest');

const mockExecFile = jest.fn();
const mockIsEnabled = jest.fn();
const mockRequireJwtAuth = jest.fn();
const mockCheckAdmin = jest.fn();

jest.mock('child_process', () => ({
  execFile: (...args) => mockExecFile(...args),
}));

jest.mock('@librechat/api', () => ({
  isEnabled: (...args) => mockIsEnabled(...args),
}));

jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    },
  }),
  { virtual: true },
);

jest.mock('~/server/middleware', () => ({
  checkAdmin: (...args) => mockCheckAdmin(...args),
  requireJwtAuth: (...args) => mockRequireJwtAuth(...args),
}));

describe('/api/viventium/prompt-workbench', () => {
  beforeEach(() => {
    jest.resetModules();
    mockExecFile.mockReset();
    mockIsEnabled.mockReset();
    mockRequireJwtAuth.mockReset();
    mockCheckAdmin.mockReset();
    process.env.VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH = 'true';
    delete process.env.VIVENTIUM_PROMPT_WORKBENCH_LINK_DISABLED;

    mockIsEnabled.mockImplementation((value) => String(value).toLowerCase() === 'true');
    mockRequireJwtAuth.mockImplementation((req, _res, next) => {
      req.user = { id: 'user_1', role: 'ADMIN' };
      next();
    });
    mockCheckAdmin.mockImplementation((_req, _res, next) => next());
  });

  afterEach(() => {
    delete process.env.VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH;
    delete process.env.VIVENTIUM_PROMPT_WORKBENCH_LINK_DISABLED;
  });

  function createApp() {
    const router = require('../promptWorkbench');
    const app = express();
    app.use(express.json());
    app.use('/api/viventium/prompt-workbench', router);
    return app;
  }

  test('starts Prompt Workbench through the managed local CLI and returns its URL', async () => {
    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      callback(
        null,
        JSON.stringify({
          status: 'running',
          started: true,
          url: 'http://127.0.0.1:8781',
        }),
        '',
      );
    });

    const response = await request(createApp())
      .post('/api/viventium/prompt-workbench/start')
      .send({})
      .expect(200);

    expect(response.body).toEqual({
      status: 'running',
      started: true,
      url: 'http://127.0.0.1:8781',
    });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0][1]).toEqual(['prompt-workbench', 'start', '--json']);
  });

  test('reports status without starting Prompt Workbench', async () => {
    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, JSON.stringify({ status: 'stopped' }), '');
    });

    const response = await request(createApp())
      .get('/api/viventium/prompt-workbench/status')
      .expect(200);

    expect(response.body).toEqual({ status: 'stopped' });
    expect(mockExecFile.mock.calls[0][1]).toEqual(['prompt-workbench', 'status', '--json']);
  });

  test('stays unavailable when the local subscription/runtime surface is disabled', async () => {
    process.env.VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH = 'false';

    const response = await request(createApp())
      .post('/api/viventium/prompt-workbench/start')
      .send({})
      .expect(404);

    expect(response.body).toEqual({ error: 'prompt_workbench_not_enabled' });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  test('requires admin authorization after JWT authentication', async () => {
    mockCheckAdmin.mockImplementation((_req, res) => res.status(403).json({ message: 'Forbidden' }));

    const response = await request(createApp())
      .post('/api/viventium/prompt-workbench/start')
      .send({})
      .expect(403);

    expect(response.body).toEqual({ message: 'Forbidden' });
    expect(mockRequireJwtAuth).toHaveBeenCalledTimes(1);
    expect(mockCheckAdmin).toHaveBeenCalledTimes(1);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  test('honors the server-side workbench link kill switch', async () => {
    process.env.VIVENTIUM_PROMPT_WORKBENCH_LINK_DISABLED = 'true';

    const response = await request(createApp())
      .post('/api/viventium/prompt-workbench/start')
      .send({})
      .expect(404);

    expect(response.body).toEqual({ error: 'prompt_workbench_not_enabled' });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  test('returns a sanitized failure instead of leaking local command details', async () => {
    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      const error = new Error('Command failed');
      error.stderr = JSON.stringify({
        status: 'error',
        message: 'Failed under <private-app-state>',
      });
      callback(error, '', error.stderr);
    });

    const response = await request(createApp())
      .post('/api/viventium/prompt-workbench/start')
      .send({})
      .expect(500);

    expect(response.body).toEqual({
      error: 'prompt_workbench_unavailable',
      message: 'Prompt Workbench could not be opened from this local runtime.',
    });
  });
});
