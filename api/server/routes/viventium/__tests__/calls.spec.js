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
    wingModeEnabled: false,
    shadowModeEnabled: false,
    listenOnlyModeEnabled: false,
  })),
  syncCallSessionState: jest.fn(async ({ wingModeEnabled, listenOnlyModeEnabled }) => {
    const listenOnly = listenOnlyModeEnabled === true;
    const wing = listenOnly ? false : wingModeEnabled === true;
    return {
      callSessionId: 'call_session_test',
      roomName: 'lc-calltest',
      expiresAtMs: 123,
      wingModeEnabled: wing,
      shadowModeEnabled: wing,
      listenOnlyModeEnabled: listenOnly,
    };
  }),
  getCallSessionVoiceSettings: jest.fn(async () => ({
    callSessionId: 'call_session_test',
    roomName: 'lc-calltest',
    expiresAtMs: 123,
    requestedVoiceRoute: {
      stt: { provider: 'openai', variant: 'gpt-4o-transcribe' },
      tts: { provider: 'cartesia', variant: '6ccbfb76-1fc6-48f7-b71d-91ac6298247b' },
    },
    savedVoiceRoute: {
      stt: { provider: 'openai', variant: 'gpt-4o-transcribe' },
      tts: { provider: 'openai', variant: 'gpt-4o-mini-tts' },
    },
    assistantRoute: {
      primary: { provider: 'anthropic', model: 'claude-opus-4-7' },
      voiceCallLlm: null,
      fallbackLlm: null,
      voiceFallbackLlm: null,
      effective: { provider: 'anthropic', model: 'claude-opus-4-7' },
      inheritsPrimary: true,
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
    assistantRoute: {
      primary: { provider: 'anthropic', model: 'claude-opus-4-7' },
      voiceCallLlm: null,
      fallbackLlm: null,
      voiceFallbackLlm: null,
      effective: { provider: 'anthropic', model: 'claude-opus-4-7' },
      inheritsPrimary: true,
    },
  })),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'user_1' };
    next();
  },
}));

function playgroundHealthResponse(payload, { declaredLength, chunks } = {}) {
  const encoded = Buffer.from(JSON.stringify(payload));
  const responseChunks = chunks || [encoded];
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) =>
        String(name).toLowerCase() === 'content-length' && declaredLength != null
          ? String(declaredLength)
          : null,
    },
    body: {
      getReader: () => ({
        read: async () =>
          index < responseChunks.length
            ? { done: false, value: responseChunks[index++] }
            : { done: true },
        cancel: jest.fn(async () => {}),
        releaseLock: jest.fn(),
      }),
    },
  };
}

function modernIdentity(sourceRef = 'a'.repeat(40)) {
  return {
    schema_version: 1,
    product: 'viventium-playground',
    status: 'ok',
    surface: 'modern-playground',
    variant: 'modern',
    source_ref: sourceRef,
  };
}

describe('/api/viventium/calls', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.VIVENTIUM_VOICE_ENABLED = 'true';
    process.env.VIVENTIUM_PLAYGROUND_URL = 'http://localhost:3000';
    process.env.PLAYGROUND_VARIANT = 'modern';
    process.env.VIVENTIUM_PLAYGROUND_SOURCE_REF = 'a'.repeat(40);
    process.env.VIVENTIUM_PUBLIC_CLIENT_URL = '';
    process.env.VIVENTIUM_PUBLIC_SERVER_URL = '';
    process.env.VIVENTIUM_PUBLIC_PLAYGROUND_URL = '';
    process.env.VIVENTIUM_VOICE_GATEWAY_AGENT_NAME = 'librechat-voice-gateway';
    global.fetch = jest.fn(async () => playgroundHealthResponse(modernIdentity()));
  });

  test('POST fails closed before creating a session when Voice is disabled', async () => {
    process.env.VIVENTIUM_VOICE_ENABLED = 'false';
    const callsRouter = require('../calls');
    const { createCallSession } = require('~/server/services/viventium/CallSessionService');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls')
      .send({ conversationId: 'new', agentId: 'agent_123' })
      .expect(409);

    expect(res.body).toMatchObject({ error: 'voice_not_enabled' });
    expect(createCallSession).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('POST returns a stable structured error before readiness when no assistant is selected', async () => {
    const callsRouter = require('../calls');
    const { createCallSession } = require('~/server/services/viventium/CallSessionService');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls')
      .send({ conversationId: 'new' })
      .expect(400);

    expect(res.body).toMatchObject({
      error: 'voice_agent_required',
      message: 'Choose an assistant before starting Voice.',
    });
    expect(createCallSession).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('POST fails closed when the configured playground has no listener', async () => {
    global.fetch.mockRejectedValueOnce(new Error('connection refused'));
    const callsRouter = require('../calls');
    const { createCallSession } = require('~/server/services/viventium/CallSessionService');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls')
      .send({ conversationId: 'new', agentId: 'agent_123' })
      .expect(503);

    expect(res.body).toMatchObject({
      error: 'voice_runtime_not_ready',
      reason: 'playground_unreachable',
    });
    expect(createCallSession).not.toHaveBeenCalled();
  });

  test('POST fails closed when the playground URL is invalid', async () => {
    process.env.VIVENTIUM_PLAYGROUND_URL = 'not a URL';
    const callsRouter = require('../calls');
    const { createCallSession } = require('~/server/services/viventium/CallSessionService');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls')
      .send({ conversationId: 'new', agentId: 'agent_123' })
      .expect(503);

    expect(res.body).toMatchObject({
      error: 'voice_runtime_not_ready',
      reason: 'playground_configuration_invalid',
    });
    expect(createCallSession).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('POST rejects a stale classic playground when modern is configured', async () => {
    global.fetch.mockResolvedValueOnce(
      playgroundHealthResponse({
        schema_version: 1,
        product: 'viventium-playground',
        status: 'ok',
        surface: 'classic-playground',
        variant: 'classic',
        source_ref: 'b'.repeat(40),
      }),
    );
    const callsRouter = require('../calls');
    const { createCallSession } = require('~/server/services/viventium/CallSessionService');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls')
      .send({ conversationId: 'new', agentId: 'agent_123' })
      .expect(503);

    expect(res.body).toMatchObject({
      error: 'voice_runtime_not_ready',
      reason: 'playground_identity_mismatch',
    });
    expect(createCallSession).not.toHaveBeenCalled();
  });

  test('POST rejects a stale modern playground source ref', async () => {
    global.fetch.mockResolvedValueOnce(playgroundHealthResponse(modernIdentity('b'.repeat(40))));
    const callsRouter = require('../calls');
    const { createCallSession } = require('~/server/services/viventium/CallSessionService');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls')
      .send({ conversationId: 'new', agentId: 'agent_123' })
      .expect(503);

    expect(res.body).toMatchObject({
      error: 'voice_runtime_not_ready',
      reason: 'playground_identity_mismatch',
    });
    expect(createCallSession).not.toHaveBeenCalled();
  });

  test('POST rejects an oversized declared identity before reading its body', async () => {
    global.fetch.mockResolvedValueOnce(
      playgroundHealthResponse(modernIdentity(), { declaredLength: 65537 }),
    );
    const callsRouter = require('../calls');
    const { createCallSession } = require('~/server/services/viventium/CallSessionService');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls')
      .send({ conversationId: 'new', agentId: 'agent_123' })
      .expect(503);

    expect(res.body).toMatchObject({
      error: 'voice_runtime_not_ready',
      reason: 'playground_identity_mismatch',
    });
    expect(createCallSession).not.toHaveBeenCalled();
  });

  test('POST bounds a chunked identity response before creating durable call state', async () => {
    global.fetch.mockResolvedValueOnce(
      playgroundHealthResponse(modernIdentity(), {
        chunks: [Buffer.alloc(40000, 'a'), Buffer.alloc(30000, 'b')],
      }),
    );
    const callsRouter = require('../calls');
    const { createCallSession } = require('~/server/services/viventium/CallSessionService');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls')
      .send({ conversationId: 'new', agentId: 'agent_123' })
      .expect(503);

    expect(res.body).toMatchObject({
      error: 'voice_runtime_not_ready',
      reason: 'playground_identity_mismatch',
    });
    expect(createCallSession).not.toHaveBeenCalled();
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

  test('POST diagnostics do not log user, conversation, agent, session, room, or deep-link values', async () => {
    const callsRouter = require('../calls');
    const { logger } = require('@librechat/data-schemas');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls')
      .send({ conversationId: 'new', agentId: 'agent_private' })
      .expect(200);

    const diagnostics = JSON.stringify(
      Object.values(logger).flatMap((method) => method.mock.calls),
    );
    for (const privateValue of [
      'user_1',
      'agent_private',
      res.body.callSessionId,
      res.body.roomName,
      res.body.playgroundUrl,
    ]) {
      expect(diagnostics).not.toContain(privateValue);
    }
  });

  test('POST prefers the configured public playground for matching public browser origins', async () => {
    process.env.VIVENTIUM_PUBLIC_CLIENT_URL = 'https://voice-node.example.test';
    process.env.VIVENTIUM_PUBLIC_SERVER_URL = 'https://voice-node.example.test:8443';
    process.env.VIVENTIUM_PUBLIC_PLAYGROUND_URL = 'https://voice-node.example.test:3443';

    const callsRouter = require('../calls');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls')
      .set('origin', 'https://voice-node.example.test')
      .send({ conversationId: 'new', agentId: 'agent_123' })
      .expect(200);

    expect(new URL(res.body.playgroundUrl).origin).toBe('https://voice-node.example.test:3443');
  });

  test('POST keeps localhost playground links for localhost callers even when public origins exist', async () => {
    process.env.VIVENTIUM_PUBLIC_CLIENT_URL = 'https://voice-node.example.test';
    process.env.VIVENTIUM_PUBLIC_SERVER_URL = 'https://voice-node.example.test:8443';
    process.env.VIVENTIUM_PUBLIC_PLAYGROUND_URL = 'https://voice-node.example.test:3443';

    const callsRouter = require('../calls');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls')
      .set('origin', 'http://localhost:3190')
      .send({ conversationId: 'new', agentId: 'agent_123' })
      .expect(200);

    expect(new URL(res.body.playgroundUrl).origin).toBe('http://localhost:3000');
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
    const { claimDispatch } = require('~/server/services/viventium/CallSessionService');

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
    expect(claimDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        callSessionId: 'call_session_test',
        roomName: 'lc-calltest',
        agentName: 'librechat-voice-gateway',
        reclaimConfirmed: false,
      }),
    );
  });

  test('POST dispatch/claim can request confirmed-dispatch reclaim', async () => {
    const callsRouter = require('../calls');
    const { claimDispatch } = require('~/server/services/viventium/CallSessionService');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    await request(app)
      .post('/api/viventium/calls/call_session_test/dispatch/claim')
      .set('x-viventium-call-secret', 'secret')
      .send({
        roomName: 'lc-calltest',
        agentName: 'librechat-voice-gateway',
        reclaimConfirmed: true,
      })
      .expect(200);

    expect(claimDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        callSessionId: 'call_session_test',
        roomName: 'lc-calltest',
        agentName: 'librechat-voice-gateway',
        reclaimConfirmed: true,
      }),
    );
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
      tts: { provider: 'cartesia', variant: '6ccbfb76-1fc6-48f7-b71d-91ac6298247b' },
    });
    expect(res.body.savedVoiceRoute).toEqual({
      stt: { provider: 'openai', variant: 'gpt-4o-transcribe' },
      tts: { provider: 'openai', variant: 'gpt-4o-mini-tts' },
    });
    expect(res.body.assistantRoute).toEqual({
      primary: { provider: 'anthropic', model: 'claude-opus-4-7' },
      voiceCallLlm: null,
      fallbackLlm: null,
      voiceFallbackLlm: null,
      effective: { provider: 'anthropic', model: 'claude-opus-4-7' },
      inheritsPrimary: true,
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
    expect(res.body.assistantRoute).toEqual({
      primary: { provider: 'anthropic', model: 'claude-opus-4-7' },
      voiceCallLlm: null,
      fallbackLlm: null,
      voiceFallbackLlm: null,
      effective: { provider: 'anthropic', model: 'claude-opus-4-7' },
      inheritsPrimary: true,
    });
  });

  test('POST state can enable Listen-Only Mode and clears Wing Mode', async () => {
    const callsRouter = require('../calls');
    const { syncCallSessionState } = require('~/server/services/viventium/CallSessionService');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls/call_session_test/state')
      .set('x-viventium-call-secret', 'secret')
      .send({ wingModeEnabled: true, listenOnlyModeEnabled: true })
      .expect(200);

    expect(syncCallSessionState).toHaveBeenCalledWith(
      expect.objectContaining({
        callSessionId: 'call_session_test',
        wingModeEnabled: true,
        listenOnlyModeEnabled: true,
      }),
    );
    expect(res.body.listenOnlyModeEnabled).toBe(true);
    expect(res.body.wingModeEnabled).toBe(false);
    expect(res.body.shadowModeEnabled).toBe(false);
  });
});
