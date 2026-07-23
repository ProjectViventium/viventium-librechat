/**
 * === VIVENTIUM START ===
 * Feature: Connected Channels admin API.
 * Purpose: Lock admin authorization, stable envelopes, and secret-safe route behavior.
 * === VIVENTIUM END ===
 */

const express = require('express');
const request = require('supertest');

const mockRequireJwtAuth = jest.fn();
const mockCheckAdmin = jest.fn();

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (...args) => mockRequireJwtAuth(...args),
  checkAdmin: (...args) => mockCheckAdmin(...args),
}));

jest.mock(
  '@librechat/api',
  () => ({
    CHANNEL_IDS: ['telegram', 'slack', 'whatsapp'],
    SLACK_SOCKET_MODE_MANIFEST: { settings: { socket_mode_enabled: true } },
  }),
  { virtual: true },
);

jest.mock('~/server/services/viventium/channelAdminService', () => ({
  getChannelAdminService: () => {
    throw new Error('test must inject its service');
  },
  createChannelPairingCode: jest.fn(),
  ensureChannelSubsystemReady: jest.fn(async () => undefined),
}));

function createService() {
  return {
    list: jest.fn(async () => [
      { channel: 'telegram', state: 'connected', displayName: '@synthetic_bot' },
      { channel: 'slack', state: 'not_configured' },
      { channel: 'whatsapp', state: 'not_configured' },
    ]),
    connect: jest.fn(async (channel) => ({ channel, state: 'needs_vendor_step' })),
    test: jest.fn(async (channel) => ({
      ok: false,
      channel: { channel, state: 'needs_vendor_step' },
      message: 'The channel transport is not available in this runtime.',
    })),
    disconnect: jest.fn(async (channel) => ({ channel, state: 'disconnected' })),
    availability: jest.fn(async () => [
      { channel: 'telegram', available: true },
      { channel: 'slack', available: false },
      { channel: 'whatsapp', available: false },
    ]),
  };
}

function createApp(service, createPairingCode, readiness = async () => undefined) {
  const { createChannelsRouter } = require('../channels');
  const app = express();
  app.use(express.json());
  app.use(
    '/api/viventium/channels',
    createChannelsRouter({ service, createPairingCode, readiness }),
  );
  return app;
}

describe('/api/viventium/channels', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireJwtAuth.mockImplementation((req, _res, next) => {
      req.user = { id: 'admin-1', role: 'ADMIN' };
      next();
    });
    mockCheckAdmin.mockImplementation((_req, _res, next) => next());
  });

  it('lists stable, non-secret channel summaries for admins only', async () => {
    const service = createService();
    const response = await request(createApp(service)).get('/api/viventium/channels').expect(200);

    expect(response.body.channels).toHaveLength(3);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(mockRequireJwtAuth).toHaveBeenCalled();
    expect(mockCheckAdmin).toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toMatch(/token|secret/i);
  });

  it('never echoes connect secrets', async () => {
    const service = createService();
    const response = await request(createApp(service))
      .post('/api/viventium/channels/telegram/connect')
      .send({ botToken: 'synthetic-secret' })
      .expect(200);

    expect(service.connect).toHaveBeenCalledWith(
      'telegram',
      { botToken: 'synthetic-secret' },
      'admin-1',
    );
    expect(response.body).toEqual({
      channel: { channel: 'telegram', state: 'needs_vendor_step' },
    });
    expect(JSON.stringify(response.body)).not.toContain('synthetic-secret');
  });

  it('exposes test, disconnect, and the Socket Mode manifest through stable envelopes', async () => {
    const service = createService();
    const app = createApp(service);

    await request(app)
      .post('/api/viventium/channels/slack/test')
      .send({})
      .expect(200)
      .expect(({ body }) => expect(body.ok).toBe(false));
    await request(app)
      .post('/api/viventium/channels/slack/disconnect')
      .send({})
      .expect(200)
      .expect({ channel: { channel: 'slack', state: 'disconnected' } });
    await request(app)
      .get('/api/viventium/channels/slack/manifest')
      .expect(200)
      .expect({ manifest: { settings: { socket_mode_enabled: true } } });
  });

  it('rejects unsupported channel slugs before calling the service', async () => {
    const service = createService();
    await request(createApp(service))
      .post('/api/viventium/channels/discord/connect')
      .send({ botToken: 'synthetic' })
      .expect(404)
      .expect({ error: 'unsupported_channel' });
    expect(service.connect).not.toHaveBeenCalled();
  });

  it('does not execute handlers when admin authorization fails', async () => {
    const service = createService();
    mockCheckAdmin.mockImplementation((_req, res) =>
      res.status(403).json({ error: 'admin_required' }),
    );

    await request(createApp(service))
      .post('/api/viventium/channels/telegram/disconnect')
      .send({})
      .expect(403);
    expect(service.disconnect).not.toHaveBeenCalled();
  });

  it('creates a short-lived pairing code without exposing its hash or owner id', async () => {
    mockRequireJwtAuth.mockImplementation((req, _res, next) => {
      req.user = { id: 'user-b', role: 'USER' };
      next();
    });
    const service = createService();
    const createPairingCode = jest.fn(async () => ({
      code: 'ABCD-EFGH',
      expiresAt: new Date('2026-01-01T00:10:00Z'),
    }));
    await request(createApp(service, createPairingCode))
      .post('/api/viventium/channels/telegram/pairing-code')
      .send({})
      .expect(200)
      .expect({ pairingCode: 'ABCD-EFGH', expiresAt: '2026-01-01T00:10:00.000Z' });
    expect(createPairingCode).toHaveBeenCalledWith('telegram', 'user-b');
    expect(mockCheckAdmin).not.toHaveBeenCalled();
  });

  it('exposes only provider availability to authenticated non-admin users', async () => {
    mockRequireJwtAuth.mockImplementation((req, _res, next) => {
      req.user = { id: 'user-b', role: 'USER' };
      next();
    });
    await request(createApp(createService()))
      .get('/api/viventium/channels/availability')
      .expect(200)
      .expect(({ body }) => {
        expect(body.channels).toContainEqual({ channel: 'telegram', available: true });
        expect(JSON.stringify(body)).not.toMatch(/displayName|callback|issue|token|secret/i);
      });
    expect(mockCheckAdmin).not.toHaveBeenCalled();
  });

  it('ignores any requested target user and always binds a pairing code to the caller', async () => {
    mockRequireJwtAuth.mockImplementation((req, _res, next) => {
      req.user = { id: 'user-a', role: 'USER' };
      next();
    });
    const createPairingCode = jest.fn(async () => ({
      code: 'ABCD-EFGH',
      expiresAt: new Date('2026-01-01T00:10:00Z'),
    }));
    await request(createApp(createService(), createPairingCode))
      .post('/api/viventium/channels/telegram/pairing-code')
      .send({ userId: 'admin-1', targetUserId: 'admin-1' })
      .expect(200);
    expect(createPairingCode).toHaveBeenCalledWith('telegram', 'user-a');
  });

  it('fails closed without calling repositories or runtime when persistence indexes are unavailable', async () => {
    const service = createService();
    const createPairingCode = jest.fn();
    const readiness = jest.fn(async () => {
      throw new Error('index conflict');
    });
    const app = createApp(service, createPairingCode, readiness);

    await request(app).get('/api/viventium/channels').expect(503);
    await request(app)
      .post('/api/viventium/channels/telegram/connect')
      .send({ botToken: 'synthetic' })
      .expect(503);
    await request(app).post('/api/viventium/channels/telegram/pairing-code').send({}).expect(503);

    expect(service.list).not.toHaveBeenCalled();
    expect(service.connect).not.toHaveBeenCalled();
    expect(createPairingCode).not.toHaveBeenCalled();
  });
});
