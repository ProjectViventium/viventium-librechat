/* === VIVENTIUM START ===
 * Feature: Admin-only WHOOP onboarding routes.
 * Purpose: Protect host-owner health state from ordinary LibreChat accounts.
 * === VIVENTIUM END === */

const express = require('express');
const request = require('supertest');

const mockGetWhoopStatus = jest.fn();
const mockConfigureWhoopClient = jest.fn();
const mockBeginWhoopAuthorization = jest.fn();
const mockCompleteWhoopOnboarding = jest.fn();
const mockImportWhoopExport = jest.fn();
const mockImportWhoopEvidence = jest.fn();
const mockDisconnectWhoop = jest.fn();
const mockIsEnabled = jest.fn();
const mockCheckAdmin = jest.fn();
class MockWhoopHealthError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

jest.mock('@librechat/api', () => ({
  WhoopHealthError: MockWhoopHealthError,
  getWhoopStatus: (...args) => mockGetWhoopStatus(...args),
  configureWhoopClient: (...args) => mockConfigureWhoopClient(...args),
  beginWhoopAuthorization: (...args) => mockBeginWhoopAuthorization(...args),
  completeWhoopOnboarding: (...args) => mockCompleteWhoopOnboarding(...args),
  importWhoopExport: (...args) => mockImportWhoopExport(...args),
  importWhoopEvidence: (...args) => mockImportWhoopEvidence(...args),
  disconnectWhoop: (...args) => mockDisconnectWhoop(...args),
  isEnabled: (...args) => mockIsEnabled(...args),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'owner', role: 'ADMIN' };
    next();
  },
  checkAdmin: (...args) => mockCheckAdmin(...args),
}));

describe('/api/viventium/health/whoop', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH = 'true';
    process.env.VIVENTIUM_HEALTH_ENABLED = 'true';
    mockIsEnabled.mockImplementation((value) => String(value).toLowerCase() === 'true');
    mockCheckAdmin.mockImplementation((_req, _res, next) => next());
    mockGetWhoopStatus.mockResolvedValue({ state: 'setup_required' });
  });

  afterEach(() => {
    delete process.env.VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH;
    delete process.env.VIVENTIUM_HEALTH_ENABLED;
  });

  function createApp() {
    const router = require('../healthWhoop');
    const app = express();
    app.use(express.json({ limit: '32kb' }));
    app.use('/api/viventium/health/whoop', router);
    return app;
  }

  test('reports status and requires both the local and health gates', async () => {
    await request(createApp()).get('/api/viventium/health/whoop/status').expect(200);
    expect(mockGetWhoopStatus).toHaveBeenCalledTimes(1);

    process.env.VIVENTIUM_HEALTH_ENABLED = 'false';
    const hidden = await request(createApp()).get('/api/viventium/health/whoop/status').expect(404);
    expect(hidden.body).toEqual({ error: 'whoop_not_enabled' });
  });

  test('is reachable through the product Viventium router', async () => {
    const unrelatedRoutes = [
      'calls',
      'voice',
      'telegram',
      'scheduler',
      'interactions',
      'gateway',
      'telegram_link',
      'registration',
      'credits',
      'auth',
      'skyvern',
      'glasshive',
      'glasshiveCapabilities',
      'glasshiveInference',
      'promptWorkbench',
      'feelings',
      'channels',
      'orchestration',
      'orchestrationTrace',
      'personalAccountCleanup',
    ];
    for (const route of unrelatedRoutes) {
      jest.doMock(`../${route}`, () => require('express').Router());
    }
    const app = express();
    app.use(express.json({ limit: '32kb' }));
    app.use('/api/viventium', require('../index'));

    await request(app).get('/api/viventium/health/whoop/status').expect(200);
    expect(mockGetWhoopStatus).toHaveBeenCalledTimes(1);
  });

  test('protects host-owner health state behind admin authorization', async () => {
    mockCheckAdmin.mockImplementation((_req, res) =>
      res.status(403).json({ message: 'Forbidden' }),
    );

    await request(createApp()).get('/api/viventium/health/whoop/status').expect(403);

    expect(mockGetWhoopStatus).not.toHaveBeenCalled();
  });

  test.each([
    ['configure', '/configure', { clientId: 'x' }, null],
    ['authorize', '/authorize', {}, null],
    ['complete', '/complete', { callbackUrl: 'viventium://oauth/whoop' }, null],
    ['import', '/import', Buffer.from('PK\u0003\u0004'), 'application/zip'],
    ['evidence', '/evidence', Buffer.from('\x89PNG\r\n\x1a\n'), 'image/png'],
    ['disconnect', '/disconnect', {}, null],
  ])('denies non-admin users before the %s mutation', async (_name, path, body, type) => {
    mockCheckAdmin.mockImplementation((_req, res) =>
      res.status(403).json({ message: 'Forbidden' }),
    );
    const operation = request(createApp()).post(`/api/viventium/health/whoop${path}`);
    if (type) {
      operation.set('Content-Type', type);
    }

    await operation.send(body).expect(403);
  });

  test('returns a bounded safe error for component failures', async () => {
    mockBeginWhoopAuthorization.mockRejectedValue(
      new MockWhoopHealthError(
        'health_runtime_unavailable',
        'private callback and path must not leak',
        503,
      ),
    );

    const response = await request(createApp())
      .post('/api/viventium/health/whoop/authorize')
      .expect(503);

    expect(response.body).toEqual({
      error: 'health_runtime_unavailable',
      message: 'The WHOOP operation could not be completed from this local runtime.',
    });
    expect(JSON.stringify(response.body)).not.toContain('private callback');
  });

  test('returns JSON rather than an HTML error when evidence exceeds the route limit', async () => {
    const response = await request(createApp())
      .post('/api/viventium/health/whoop/evidence')
      .set('Content-Type', 'image/png')
      .send(Buffer.alloc(10 * 1024 * 1024 + 1))
      .expect(413);

    expect(response.body).toEqual({
      error: 'whoop_upload_too_large',
      message: 'The WHOOP upload exceeded the local size limit.',
    });
    expect(mockImportWhoopEvidence).not.toHaveBeenCalled();
  });

  test('configures, authorizes, and submits callbacks through bounded service methods', async () => {
    mockConfigureWhoopClient.mockResolvedValue({ status: 'configured', requestedScopes: [] });
    mockBeginWhoopAuthorization.mockResolvedValue({
      status: 'authorization_pending',
      authorizationUrl: 'https://api.prod.whoop.com/oauth/oauth2/auth?state=12345678',
    });
    mockCompleteWhoopOnboarding.mockResolvedValue({ status: 'accepted' });

    await request(createApp())
      .post('/api/viventium/health/whoop/configure')
      .send({
        clientId: 'public-client',
        clientSecret: 'private-secret',
        redirectUri: 'viventium://oauth/whoop',
      })
      .expect(200);
    await request(createApp()).post('/api/viventium/health/whoop/authorize').expect(200);
    await request(createApp())
      .post('/api/viventium/health/whoop/complete')
      .send({ callbackUrl: 'viventium://oauth/whoop?code=private&state=12345678' })
      .expect(202);

    expect(mockConfigureWhoopClient).toHaveBeenCalledWith({
      clientId: 'public-client',
      clientSecret: 'private-secret',
      redirectUri: 'viventium://oauth/whoop',
    });
    expect(mockCompleteWhoopOnboarding).toHaveBeenCalledWith(
      'viventium://oauth/whoop?code=private&state=12345678',
    );
  });

  test('imports the exact official ZIP body and rejects non-ZIP content types', async () => {
    const body = Buffer.from('PK\u0003\u0004synthetic');
    mockImportWhoopExport.mockResolvedValue({
      status: 'complete',
      recordCount: 2,
      fileCount: 1,
      resourceFileCounts: { sleeps: 1 },
    });

    const imported = await request(createApp())
      .post('/api/viventium/health/whoop/import')
      .set('Content-Type', 'application/zip')
      .send(body)
      .expect(200);

    expect(imported.body.fileCount).toBe(1);
    expect(mockImportWhoopExport).toHaveBeenCalledWith(expect.any(Buffer));

    await request(createApp())
      .post('/api/viventium/health/whoop/import')
      .set('Content-Type', 'text/plain')
      .send('not a zip')
      .expect(415);
  });

  test('imports exact bounded PNG/JPEG evidence and rejects other media types', async () => {
    const body = Buffer.from('\x89PNG\r\n\x1a\nsynthetic');
    mockImportWhoopEvidence.mockResolvedValue({
      status: 'complete',
      recordCount: 1,
      itemCount: 1,
    });

    const imported = await request(createApp())
      .post('/api/viventium/health/whoop/evidence')
      .set('Content-Type', 'image/png')
      .send(body)
      .expect(200);

    expect(imported.body.itemCount).toBe(1);
    expect(mockImportWhoopEvidence).toHaveBeenCalledWith(expect.any(Buffer), 'image/png');

    await request(createApp())
      .post('/api/viventium/health/whoop/evidence')
      .set('Content-Type', 'image/svg+xml')
      .send('<svg/>')
      .expect(415);
  });

  test('disconnects live access while stating that historical evidence is retained', async () => {
    mockDisconnectWhoop.mockResolvedValue({ status: 'disconnected', historyRetained: true });

    const response = await request(createApp())
      .post('/api/viventium/health/whoop/disconnect')
      .expect(200);

    expect(response.body).toEqual({ status: 'disconnected', historyRetained: true });
  });
});
