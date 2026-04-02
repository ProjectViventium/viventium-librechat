/* === VIVENTIUM START ===
 * Feature: LibreChat Voice Calls - /api/viventium/calls tests
 * Added: 2026-01-08
 * === VIVENTIUM END === */

const express = require('express');
const request = require('supertest');

jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  }),
  { virtual: true },
);

jest.mock('~/models', () => ({
  getConvo: jest.fn(async () => null),
}));

jest.mock('~/server/services/viventium/CallSessionService', () => ({
  createCallSession: jest.fn(async ({ userId, agentId, conversationId }) => ({
    callSessionId: 'call_session_test',
    userId,
    agentId,
    conversationId,
    roomName: 'lc-calltest',
    requestedVoiceRoute: {
      stt: { provider: null, variant: null },
      tts: { provider: null, variant: null },
    },
  })),
  assertCallSessionSecret: jest.fn(async () => ({
    callSessionId: 'call_session_test',
    roomName: 'lc-calltest',
  })),
  getCallSessionVoiceSettings: jest.fn(async () => ({
    callSessionId: 'call_session_test',
    roomName: 'lc-calltest',
    expiresAtMs: 123,
    requestedVoiceRoute: {
      stt: { provider: 'openai', variant: 'gpt-4o-transcribe' },
      tts: { provider: 'cartesia', variant: 'sonic-2' },
    },
    savedVoiceRoute: {
      stt: { provider: 'openai', variant: 'gpt-4o-transcribe' },
      tts: { provider: 'openai', variant: 'gpt-4o-mini-tts' },
    },
  })),
  claimDispatch: jest.fn(async () => ({
    status: 'claimed',
    claimId: 'claim_1',
    session: { dispatchConfirmedAtMs: null },
  })),
  confirmDispatch: jest.fn(async () => ({
    callSessionId: 'call_session_test',
    dispatchConfirmedAtMs: 123,
  })),
  updateCallSessionVoiceSettings: jest.fn(async ({ requestedVoiceRoute }) => ({
    callSessionId: 'call_session_test',
    roomName: 'lc-calltest',
    expiresAtMs: 123,
    requestedVoiceRoute,
    savedVoiceRoute: requestedVoiceRoute,
  })),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'user_1' };
    next();
  },
}));

describe('/api/viventium/calls', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.VIVENTIUM_PLAYGROUND_URL = 'http://localhost:3000';
    process.env.VIVENTIUM_VOICE_GATEWAY_AGENT_NAME = 'librechat-voice-gateway';
  });

  test('POST creates a call session and returns a deep-link url', async () => {
    const callsRouter = require('../calls');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls')
      .send({ conversationId: 'new', agentId: 'agent_123' })
      .expect(200);

    expect(typeof res.body.callSessionId).toBe('string');
    expect(typeof res.body.roomName).toBe('string');
    expect(typeof res.body.playgroundUrl).toBe('string');

    const u = new URL(res.body.playgroundUrl);
    expect(u.searchParams.get('roomName')).toBe(res.body.roomName);
    expect(u.searchParams.get('callSessionId')).toBe(res.body.callSessionId);
    expect(u.searchParams.get('agentName')).toBe('librechat-voice-gateway');
    expect(u.searchParams.get('autoConnect')).toBe('1');
  });

  test('POST rejects missing agentId', async () => {
    const callsRouter = require('../calls');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app).post('/api/viventium/calls').send({}).expect(400);
    expect(res.body.error).toBeDefined();
  });

  test('POST dispatch/claim returns claimed status', async () => {
    const callsRouter = require('../calls');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls/call_session_test/dispatch/claim')
      .set('x-viventium-call-secret', 'secret')
      .send({ roomName: 'lc-calltest', agentName: 'librechat-voice-gateway' })
      .expect(200);

    expect(res.body.status).toBe('claimed');
    expect(res.body.claimId).toBe('claim_1');
  });

  test('POST dispatch/confirm returns confirmation', async () => {
    const callsRouter = require('../calls');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls/call_session_test/dispatch/confirm')
      .set('x-viventium-call-secret', 'secret')
      .send({ claimId: 'claim_1', status: 'created' })
      .expect(200);

    expect(res.body.status).toBe('confirmed');
    expect(res.body.dispatchConfirmedAtMs).toBe(123);
  });

  test('GET voice-settings returns both saved defaults and requested route', async () => {
    const callsRouter = require('../calls');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .get('/api/viventium/calls/call_session_test/voice-settings')
      .set('x-viventium-call-secret', 'secret')
      .expect(200);

    expect(res.body.requestedVoiceRoute).toEqual({
      stt: { provider: 'openai', variant: 'gpt-4o-transcribe' },
      tts: { provider: 'cartesia', variant: 'sonic-2' },
    });
    expect(res.body.savedVoiceRoute).toEqual({
      stt: { provider: 'openai', variant: 'gpt-4o-transcribe' },
      tts: { provider: 'openai', variant: 'gpt-4o-mini-tts' },
    });
  });

  test('POST voice-settings updates the requested route', async () => {
    const callsRouter = require('../calls');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls/call_session_test/voice-settings')
      .set('x-viventium-call-secret', 'secret')
      .send({
        requestedVoiceRoute: {
          stt: { provider: 'pywhispercpp', variant: 'tiny.en' },
          tts: { provider: 'elevenlabs', variant: 'voice_123' },
        },
      })
      .expect(200);

    expect(res.body.requestedVoiceRoute).toEqual({
      stt: { provider: 'pywhispercpp', variant: 'tiny.en' },
      tts: { provider: 'elevenlabs', variant: 'voice_123' },
    });
    expect(res.body.savedVoiceRoute).toEqual({
      stt: { provider: 'pywhispercpp', variant: 'tiny.en' },
      tts: { provider: 'elevenlabs', variant: 'voice_123' },
    });
  });
});
