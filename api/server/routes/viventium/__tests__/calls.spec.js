/* === VIVENTIUM START ===
 * Feature: LibreChat Voice Calls - /api/viventium/calls tests
 * Added: 2026-01-08
 * === VIVENTIUM END === */

const express = require('express');
const request = require('supertest');
const mockAssertVoiceAgentAccess = jest.fn();

const mockGenerationJobManager = {
  getActiveJobIdsForUser: jest.fn(),
  getJob: jest.fn(),
  abortJob: jest.fn(),
};

jest.mock(
  '@librechat/api',
  () => ({
    isEnabled: (value) => ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase()),
    GenerationJobManager: mockGenerationJobManager,
  }),
  { virtual: true },
);

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

jest.mock('~/server/services/viventium/VoiceAgentAuthorizationService', () => ({
  assertVoiceAgentAccess: (...args) => mockAssertVoiceAgentAccess(...args),
}));

jest.mock('~/server/services/viventium/VoiceTaskService', () => {
  const tasks = new Map();
  const snapshot = (task) =>
    task
      ? {
          version: 1,
          eventId: `snapshot-${task.taskId}-${task.sequence}`,
          sequence: task.sequence,
          emittedAt: task.updatedAt,
          callSessionId: task.callSessionId,
          conversationId: task.conversationId,
          streamId: task.streamId,
          taskId: task.taskId,
          type: 'snapshot',
          state: task.state,
          ...(task.resultMessageId ? { resultMessageId: task.resultMessageId } : {}),
          cancellable: task.state === 'running',
          retryable: false,
          owner: { kind: 'generation_job' },
        }
      : null;
  return {
    resetVoiceTasksForTests: jest.fn(() => tasks.clear()),
    createVoiceTask: jest.fn((input) => {
      const task = {
        ...input,
        taskId: `task-${tasks.size + 1}`,
        state: 'running',
        sequence: 1,
        updatedAt: '2026-08-09T12:00:00.000Z',
      };
      tasks.set(task.taskId, task);
      return task;
    }),
    completeVoiceTask: jest.fn((taskId, { resultMessageId } = {}) => {
      const task = tasks.get(taskId);
      if (!task) return null;
      task.state = 'completed';
      task.sequence += 1;
      task.updatedAt = '2026-08-09T12:00:01.000Z';
      task.resultMessageId = resultMessageId;
      return snapshot(task);
    }),
    hydrateVoiceTasksForCall: jest.fn(async () => []),
    getDurableVoiceTaskContinuationState: jest.fn(async () => ({
      version: 1,
      status: 'monitoring',
      hasActive: false,
      observedAt: '2026-08-09T12:00:00.000Z',
      quietUntil: '2026-08-09T12:15:00.000Z',
      nextPollAfterMs: 5000,
    })),
    listDurableVoiceTaskSnapshots: jest.fn(async ({ userId, callSessionId }) => ({
      events: [...tasks.values()]
        .filter((task) => task.userId === userId && task.callSessionId === callSessionId)
        .map(snapshot),
      hasMore: false,
      nextBeforeCreatedAt: null,
      nextBeforeTaskId: null,
    })),
    listVoiceTasks: jest.fn(({ userId, callSessionId }) =>
      [...tasks.values()].filter(
        (task) => task.userId === userId && task.callSessionId === callSessionId,
      ),
    ),
    snapshotEvent: jest.fn((taskId) => snapshot(tasks.get(taskId))),
  };
});

jest.mock('~/server/services/viventium/CallSessionService', () => ({
  createCallSession: jest.fn(async ({ userId, agentId, conversationId }) => ({
    callSessionId: 'call_session_test',
    userId,
    agentId,
    conversationId,
    roomName: 'lc-calltest',
    gatewayAgentName: 'librechat-voice-gateway',
    ownerParticipantIdentity: 'owner-11111111-1111-4111-8111-111111111111',
    requestedVoiceRoute: {
      stt: { provider: null, variant: null },
      tts: { provider: null, variant: null },
    },
    browserCapability: 'A'.repeat(43),
  })),
  exchangeCallBrowserLaunch: jest.fn(
    async (callSessionId, launchCapability, idempotencyCapability) => {
      if (
        callSessionId !== 'call_session_test' ||
        launchCapability !== 'L'.repeat(43) ||
        idempotencyCapability !== 'I'.repeat(43)
      ) {
        const error = new Error('Expired launch');
        error.status = 410;
        throw error;
      }
      return {
        callSessionId,
        browserCapability: 'N'.repeat(43),
        expiresAtMs: Date.parse('2026-08-09T22:00:00.000Z'),
      };
    },
  ),
  assertCallBrowserCapability: jest.fn(async (callSessionId, capability) => {
    if (callSessionId !== 'call_session_test' || capability !== 'A'.repeat(43)) {
      const error = new Error('Invalid browser capability');
      error.status = capability ? 401 : 401;
      throw error;
    }
    return { callSessionId };
  }),
  assertCallSessionSecret: jest.fn(async () => ({
    callSessionId: 'call_session_test',
    userId: 'user_1',
    roomName: 'lc-calltest',
    gatewayAgentName: 'librechat-voice-gateway',
    ownerParticipantIdentity: 'owner-11111111-1111-4111-8111-111111111111',
    requestedVoiceRoute: {
      stt: { provider: 'assemblyai', variant: 'universal-streaming' },
      tts: { provider: 'openai', variant: 'gpt-4o-mini-tts' },
    },
    wingModeEnabled: false,
    shadowModeEnabled: false,
    listenOnlyModeEnabled: false,
    updatedAt: 123,
  })),
  getCallSession: jest.fn(async () => ({
    callSessionId: 'call_session_test',
    userId: 'user_1',
    conversationId: 'conversation_linked_1',
  })),
  heartbeatCallSession: jest.fn(async ({ currentSession }) => currentSession),
  syncCallSessionState: jest.fn(
    async ({ status, mode, wingModeEnabled, listenOnlyModeEnabled }) => {
      const listenOnly = mode === 'listen_only' || listenOnlyModeEnabled === true;
      const wing = !listenOnly && (mode === 'wing' || wingModeEnabled === true);
      return {
        version: 1,
        callSessionId: 'call_session_test',
        roomName: 'lc-calltest',
        expiresAtMs: 123,
        updatedAt: 123,
        mode: listenOnly ? 'listen_only' : wing ? 'wing' : 'call',
        status: status || 'created',
        wingModeEnabled: wing,
        shadowModeEnabled: wing,
        listenOnlyModeEnabled: listenOnly,
      };
    },
  ),
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
    require('~/server/services/viventium/CallSessionService').getCallSession.mockResolvedValue({
      callSessionId: 'call_session_test',
      userId: 'user_1',
      conversationId: 'conversation_linked_1',
    });
    process.env.VIVENTIUM_PLAYGROUND_URL = 'http://localhost:3000';
    process.env.PLAYGROUND_VARIANT = 'modern';
    process.env.VIVENTIUM_PLAYGROUND_SOURCE_REF = 'a'.repeat(40);
    process.env.VIVENTIUM_PUBLIC_CLIENT_URL = '';
    process.env.VIVENTIUM_PUBLIC_SERVER_URL = '';
    process.env.VIVENTIUM_PUBLIC_PLAYGROUND_URL = '';
    process.env.VIVENTIUM_VOICE_GATEWAY_AGENT_NAME = 'librechat-voice-gateway';
    global.fetch = jest.fn(async () => playgroundHealthResponse(modernIdentity()));
    mockGenerationJobManager.getActiveJobIdsForUser.mockResolvedValue([]);
    mockGenerationJobManager.getJob.mockResolvedValue(undefined);
    mockGenerationJobManager.abortJob.mockResolvedValue({ success: true });
    require('~/server/services/viventium/VoiceTaskService').resetVoiceTasksForTests();
    mockAssertVoiceAgentAccess.mockResolvedValue({ _id: 'agent-resource-1' });
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
      code: 'no_route',
      message: 'Voice is not configured for this assistant.',
      retryable: false,
    });
    expect(createCallSession).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('denies an unavailable agent before creating call authority', async () => {
    const error = new Error('Voice assistant is unavailable');
    error.status = 404;
    error.code = 'no_route';
    mockAssertVoiceAgentAccess.mockRejectedValueOnce(error);
    const callsRouter = require('../calls');
    const { createCallSession } = require('~/server/services/viventium/CallSessionService');
    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const response = await request(app)
      .post('/api/viventium/calls')
      .send({ conversationId: 'new', agentId: 'agent_foreign' })
      .expect(404);

    expect(response.body).toEqual({
      code: 'no_route',
      message: 'Voice assistant is unavailable.',
      retryable: false,
    });
    expect(mockAssertVoiceAgentAccess).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent_foreign' }),
    );
    expect(createCallSession).not.toHaveBeenCalled();
  });

  test('authorizes the persisted conversation agent instead of a client-supplied decoy', async () => {
    require('~/models').getConvo.mockResolvedValueOnce({ agent_id: 'agent_revoked' });
    const error = new Error('Voice assistant is unavailable');
    error.status = 404;
    error.code = 'no_route';
    mockAssertVoiceAgentAccess.mockRejectedValueOnce(error);
    const callsRouter = require('../calls');
    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    await request(app)
      .post('/api/viventium/calls')
      .send({ conversationId: 'conversation-existing', agentId: 'agent_accessible_decoy' })
      .expect(404);

    expect(mockAssertVoiceAgentAccess).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent_revoked' }),
    );
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
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
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
    expect(res.body.gatewayAgentName).toBe('librechat-voice-gateway');
    expect(res.body.ownerParticipantIdentity).toBe('owner-11111111-1111-4111-8111-111111111111');
    expect(typeof res.body.playgroundUrl).toBe('string');
    expect(res.headers['cache-control']).toBe('no-store, private');
    expect(res.headers.pragma).toBe('no-cache');

    const u = new URL(res.body.playgroundUrl);
    expect(u.pathname).toBe('/call-bootstrap');
    expect(u.searchParams.get('callSessionId')).toBe(res.body.callSessionId);
    expect(u.searchParams.has('roomName')).toBe(false);
    expect(u.searchParams.has('agentName')).toBe(false);
    expect(u.searchParams.has('ownerParticipantIdentity')).toBe(false);
    expect(u.searchParams.has('requestedVoiceRoute')).toBe(false);
    expect(u.searchParams.get('autoConnect')).toBe('1');
    expect(u.hash).toBe(`#viventiumCallCapability=${'A'.repeat(43)}`);
    expect(res.body).not.toHaveProperty('browserCapability');
    const logged = JSON.stringify(logSpy.mock.calls);
    expect(logged).not.toContain('playgroundUrl');
    expect(logged).not.toContain('autoConnect');
    expect(logged).not.toContain('X-VIVENTIUM-CALL-SECRET');
    logSpy.mockRestore();
  });

  test('state BFF auth rejects ID plus server secret without exact browser capability', async () => {
    const callsRouter = require('../calls');
    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    await request(app)
      .get('/api/viventium/calls/call_session_test/state')
      .set('X-VIVENTIUM-CALL-SECRET', 'server-secret')
      .expect(401);
    await request(app)
      .get('/api/viventium/calls/call_session_test/state')
      .set('X-VIVENTIUM-CALL-SECRET', 'server-secret')
      .set('X-VIVENTIUM-CALL-CAPABILITY', 'B'.repeat(43))
      .expect(401);
    await request(app)
      .get('/api/viventium/calls/call_session_test/state')
      .set('X-VIVENTIUM-CALL-SECRET', 'server-secret')
      .set('X-VIVENTIUM-CALL-CAPABILITY', 'A'.repeat(43))
      .expect(200);
  });

  test('POST ignores a browser-supplied voice route and identity selectors', async () => {
    const callsRouter = require('../calls');
    const { createCallSession } = require('~/server/services/viventium/CallSessionService');
    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    await request(app)
      .post('/api/viventium/calls')
      .send({
        conversationId: 'new',
        agentId: 'agent_123',
        roomName: 'browser-room',
        gatewayAgentName: 'browser-agent',
        ownerParticipantIdentity: 'browser-owner',
        requestedVoiceRoute: { stt: { provider: 'browser-provider' } },
      })
      .expect(200);

    expect(createCallSession).toHaveBeenCalledWith({
      userId: 'user_1',
      agentId: 'agent_123',
      conversationId: 'new',
    });
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
    expect(res.body).toEqual({
      code: 'no_route',
      message: 'Voice is not configured for this assistant.',
      retryable: false,
    });
  });

  test('POST returns classified no_route without a launch response when configured audio route is incomplete', async () => {
    const { createCallSession } = require('~/server/services/viventium/CallSessionService');
    createCallSession.mockRejectedValueOnce(
      Object.assign(new Error('Voice calling requires configured STT and TTS providers.'), {
        code: 'no_route',
        status: 400,
        retryable: false,
      }),
    );
    const callsRouter = require('../calls');
    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls')
      .send({ conversationId: 'new', agentId: 'agent_123' })
      .expect(400);

    expect(res.body).toEqual({
      code: 'no_route',
      message: 'Voice calling requires configured STT and TTS providers.',
      retryable: false,
    });
    expect(res.body).not.toHaveProperty('playgroundUrl');
    expect(res.body).not.toHaveProperty('callSessionId');
  });

  test('POST never logs secret-bearing launch failures', async () => {
    const secret = 'synthetic-call-secret-that-must-not-be-logged';
    const { createCallSession } = require('~/server/services/viventium/CallSessionService');
    const { logger } = require('@librechat/data-schemas');
    createCallSession.mockRejectedValueOnce(
      new Error(`provider rejected https://example.test/call?secret=${secret}`),
    );
    const callsRouter = require('../calls');
    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls')
      .send({ conversationId: 'new', agentId: 'agent_123' })
      .expect(503);

    expect(res.body).toEqual({
      code: 'gateway_down',
      message: 'Calling is temporarily unavailable.',
      retryable: true,
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret);
    expect(logger.error).toHaveBeenCalledWith('[VIVENTIUM][calls] create failed', {
      code: 'unknown',
      status: 500,
    });
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
      .set('x-viventium-call-capability', 'A'.repeat(43))
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
      .set('x-viventium-call-capability', 'A'.repeat(43))
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

  test('POST dispatch/claim rejects browser-selected room and gateway values', async () => {
    const callsRouter = require('../calls');
    const { claimDispatch } = require('~/server/services/viventium/CallSessionService');
    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    await request(app)
      .post('/api/viventium/calls/call_session_test/dispatch/claim')
      .set('x-viventium-call-secret', 'secret')
      .set('x-viventium-call-capability', 'A'.repeat(43))
      .send({ roomName: 'browser-room', agentName: 'browser-agent' })
      .expect(409);

    expect(claimDispatch).not.toHaveBeenCalled();
  });

  test('POST dispatch/confirm returns confirmation', async () => {
    const callsRouter = require('../calls');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls/call_session_test/dispatch/confirm')
      .set('x-viventium-call-secret', 'secret')
      .set('x-viventium-call-capability', 'A'.repeat(43))
      .send({ claimId: 'claim_1', status: 'created' })
      .expect(200);

    expect(res.body.status).toBe('confirmed');
    expect(res.body.dispatchConfirmedAtMs).toBe(123);
  });

  test('ended sessions cannot claim or confirm a new worker dispatch', async () => {
    const callsRouter = require('../calls');
    const {
      assertCallSessionSecret,
      claimDispatch,
      confirmDispatch,
    } = require('~/server/services/viventium/CallSessionService');
    const endedSession = {
      callSessionId: 'call_session_test',
      roomName: 'lc-calltest',
      gatewayAgentName: 'librechat-voice-gateway',
      status: 'ended',
    };
    assertCallSessionSecret.mockResolvedValueOnce(endedSession).mockResolvedValueOnce(endedSession);
    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const claim = await request(app)
      .post('/api/viventium/calls/call_session_test/dispatch/claim')
      .set('x-viventium-call-secret', 'secret')
      .set('x-viventium-call-capability', 'A'.repeat(43))
      .send({})
      .expect(410);
    const confirm = await request(app)
      .post('/api/viventium/calls/call_session_test/dispatch/confirm')
      .set('x-viventium-call-secret', 'secret')
      .set('x-viventium-call-capability', 'A'.repeat(43))
      .send({ claimId: 'claim_1', status: 'created' })
      .expect(410);

    expect(claim.body.code).toBe('auth_expired');
    expect(confirm.body.code).toBe('auth_expired');
    expect(claimDispatch).not.toHaveBeenCalled();
    expect(confirmDispatch).not.toHaveBeenCalled();
  });

  test('GET voice-settings returns both saved defaults and requested route', async () => {
    const callsRouter = require('../calls');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .get('/api/viventium/calls/call_session_test/voice-settings')
      .set('x-viventium-call-secret', 'secret')
      .set('x-viventium-call-capability', 'A'.repeat(43))
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
    const {
      updateCallSessionVoiceSettings,
    } = require('~/server/services/viventium/CallSessionService');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls/call_session_test/voice-settings')
      .set('x-viventium-call-secret', 'secret')
      .set('x-viventium-call-capability', 'A'.repeat(43))
      .send({
        persistToUserDefaults: true,
        requestedVoiceRoute: {
          stt: { provider: 'pywhispercpp', variant: 'tiny.en' },
          tts: { provider: 'elevenlabs', variant: 'voice_123' },
        },
      })
      .expect(200);

    expect(updateCallSessionVoiceSettings).toHaveBeenCalledWith(
      expect.objectContaining({ persistToUserDefaults: false }),
    );

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
      .set('x-viventium-call-capability', 'A'.repeat(43))
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

  test('GET state hydrates only canonical persisted launch and route values', async () => {
    const callsRouter = require('../calls');
    const { heartbeatCallSession } = require('~/server/services/viventium/CallSessionService');
    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .get('/api/viventium/calls/call_session_test/state')
      .set('x-viventium-call-secret', 'secret')
      .set('x-viventium-call-capability', 'A'.repeat(43))
      .query({ roomName: 'browser-room', agentName: 'browser-agent' })
      .expect(200);

    expect(res.body).toMatchObject({
      version: 1,
      callSessionId: 'call_session_test',
      roomName: 'lc-calltest',
      gatewayAgentName: 'librechat-voice-gateway',
      ownerParticipantIdentity: 'owner-11111111-1111-4111-8111-111111111111',
      requestedVoiceRoute: {
        stt: { provider: 'assemblyai', variant: 'universal-streaming' },
        tts: { provider: 'openai', variant: 'gpt-4o-mini-tts' },
      },
      updatedAt: '1970-01-01T00:00:00.123Z',
    });
    expect(heartbeatCallSession).toHaveBeenCalledWith({
      callSessionId: 'call_session_test',
      currentSession: expect.objectContaining({ callSessionId: 'call_session_test' }),
    });
  });

  test('GET state returns only the persisted structured call failure', async () => {
    const callsRouter = require('../calls');
    const { heartbeatCallSession } = require('~/server/services/viventium/CallSessionService');
    heartbeatCallSession.mockResolvedValueOnce({
      callSessionId: 'call_session_test',
      roomName: 'lc-calltest',
      gatewayAgentName: 'librechat-voice-gateway',
      ownerParticipantIdentity: 'owner-11111111-1111-4111-8111-111111111111',
      requestedVoiceRoute: {
        stt: { provider: 'assemblyai', variant: 'universal-streaming' },
        tts: { provider: 'openai', variant: 'gpt-4o-mini-tts' },
      },
      mode: 'call',
      status: 'failed',
      revision: 2,
      updatedAt: 123,
      error: {
        code: 'provider_failure',
        message: 'The voice provider could not start.',
        retryable: true,
      },
    });
    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .get('/api/viventium/calls/call_session_test/state')
      .set('x-viventium-call-secret', 'secret')
      .set('x-viventium-call-capability', 'A'.repeat(43))
      .expect(200);

    expect(res.body).toMatchObject({
      status: 'failed',
      error: {
        code: 'provider_failure',
        message: 'The voice provider could not start.',
        retryable: true,
      },
    });
  });

  test('POST state accepts canonical VoiceCallStateV1 mode and returns legacy aliases', async () => {
    const callsRouter = require('../calls');
    const { syncCallSessionState } = require('~/server/services/viventium/CallSessionService');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls/call_session_test/state')
      .set('x-viventium-call-secret', 'secret')
      .set('x-viventium-call-capability', 'A'.repeat(43))
      .send({ mode: 'wing' })
      .expect(200);

    expect(syncCallSessionState).toHaveBeenCalledWith(expect.objectContaining({ mode: 'wing' }));
    expect(res.body).toMatchObject({
      version: 1,
      mode: 'wing',
      status: 'created',
      updatedAt: '1970-01-01T00:00:00.123Z',
      wingModeEnabled: true,
      shadowModeEnabled: true,
      listenOnlyModeEnabled: false,
    });
  });

  test('POST state rejects an invalid canonical mode without changing legacy state', async () => {
    const callsRouter = require('../calls');
    const { syncCallSessionState } = require('~/server/services/viventium/CallSessionService');

    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app)
      .post('/api/viventium/calls/call_session_test/state')
      .set('x-viventium-call-secret', 'secret')
      .set('x-viventium-call-capability', 'A'.repeat(43))
      .send({ mode: 'record_everything' })
      .expect(400);

    expect(res.body.error).toBe('Invalid call mode');
    expect(syncCallSessionState).not.toHaveBeenCalled();
  });

  test('owner task continuation endpoint returns only sanitized reconnect snapshots', async () => {
    const callsRouter = require('../calls');
    const {
      createVoiceTask,
      completeVoiceTask,
    } = require('~/server/services/viventium/VoiceTaskService');
    const task = createVoiceTask({
      callSessionId: 'call_session_test',
      userId: 'user_1',
      conversationId: 'conversation_linked_1',
      streamId: 'stream-private-1',
    });
    completeVoiceTask(task.taskId, { resultMessageId: 'result-message-1' });
    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const res = await request(app).get('/api/viventium/calls/call_session_test/tasks').expect(200);

    expect(res.body).toMatchObject({
      version: 1,
      continuation: {
        version: 1,
        status: 'monitoring',
        nextPollAfterMs: 5000,
      },
      events: [
        {
          version: 1,
          type: 'snapshot',
          state: 'completed',
          conversationId: 'conversation_linked_1',
          resultMessageId: 'result-message-1',
        },
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain('userId');
    expect(JSON.stringify(res.body)).not.toContain('observedEventKeys');
    expect(JSON.stringify(res.body)).not.toContain('expiresAtMs');
  });

  test('owner task continuation exposes stable durable paging beyond the in-memory task limit', async () => {
    const taskService = require('~/server/services/viventium/VoiceTaskService');
    taskService.listDurableVoiceTaskSnapshots.mockResolvedValueOnce({
      events: [
        {
          version: 1,
          eventId: 'snapshot-latest',
          sequence: 7,
          emittedAt: '2026-08-09T12:00:00.000Z',
          callSessionId: 'call_session_test',
          taskId: 'task-latest',
          type: 'snapshot',
          state: 'completed',
          cancellable: false,
          retryable: false,
          owner: { kind: 'generation_job' },
        },
      ],
      hasMore: true,
      nextBeforeCreatedAt: '2026-08-09T11:59:00.000Z',
      nextBeforeTaskId: 'task-0490',
    });
    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', require('../calls'));

    const res = await request(app)
      .get('/api/viventium/calls/call_session_test/tasks')
      .query({
        beforeCreatedAt: '2026-08-09T12:01:00.000Z',
        beforeTaskId: 'task-0512',
      })
      .expect(200);

    expect(taskService.listDurableVoiceTaskSnapshots).toHaveBeenCalledWith({
      userId: 'user_1',
      callSessionId: 'call_session_test',
      beforeCreatedAt: '2026-08-09T12:01:00.000Z',
      beforeTaskId: 'task-0512',
      requireDurable: true,
    });
    expect(res.body).toMatchObject({
      version: 1,
      events: [{ taskId: 'task-latest', state: 'completed' }],
      hasMore: true,
      nextBeforeCreatedAt: '2026-08-09T11:59:00.000Z',
      nextBeforeTaskId: 'task-0490',
    });
  });

  test('task continuation and explicit end hide unowned call sessions', async () => {
    const callsRouter = require('../calls');
    const { getCallSession } = require('~/server/services/viventium/CallSessionService');
    getCallSession.mockResolvedValue({
      callSessionId: 'call_session_test',
      userId: 'different-user',
    });
    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    await request(app).get('/api/viventium/calls/call_session_test/tasks').expect(404);
    await request(app).post('/api/viventium/calls/call_session_test/end').expect(404);
  });

  test('explicit owner end is idempotent and marks the session terminal', async () => {
    const callsRouter = require('../calls');
    const { syncCallSessionState } = require('~/server/services/viventium/CallSessionService');
    const app = express();
    app.use(express.json());
    app.use('/api/viventium/calls', callsRouter);

    const first = await request(app).post('/api/viventium/calls/call_session_test/end').expect(200);
    const second = await request(app)
      .post('/api/viventium/calls/call_session_test/end')
      .expect(200);
    expect(first.body.status).toBe('ended');
    expect(second.body.status).toBe('ended');
    expect(first.body.updatedAt).toBe('1970-01-01T00:00:00.123Z');
    expect(second.body.updatedAt).toBe('1970-01-01T00:00:00.123Z');
    expect(syncCallSessionState).toHaveBeenCalledTimes(2);
    expect(syncCallSessionState).toHaveBeenLastCalledWith({
      callSessionId: 'call_session_test',
      touch: false,
      status: 'ended',
    });
  });
});
