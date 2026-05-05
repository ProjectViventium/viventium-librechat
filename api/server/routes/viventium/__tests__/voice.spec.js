/* === VIVENTIUM START ===
 * Feature: Voice ingress route tests (/api/viventium/voice)
 * Added: 2026-03-26
 * === VIVENTIUM END === */

const express = require('express');

let mockAssertVoiceGatewayAuth;
let mockGetUserById;
let mockGetMessages;
let mockGetConvo;
let mockVoiceIngressCreate;
let mockVoiceIngressFindOne;
let mockVoiceIngressFindOneAndUpdate;
let mockLastParentMessageId = null;
let mockLastConversationId = null;
let mockLastAgentId = null;
let mockLastRequestText = null;
let mockAgentControllerCallCount = 0;
let mockAgentControllerResponseDelayMs = 0;

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

jest.mock('~/server/middleware', () => ({
  configMiddleware: (req, _res, next) => {
    req.config = {
      modelSpecs: {
        list: [
          {
            name: 'viventium',
            default: true,
            preset: { endpoint: 'agents' },
            iconURL: 'http://example.com/images/viventium.png',
          },
        ],
      },
    };
    next();
  },
  validateConvoAccess: (_req, _res, next) => next(),
  buildEndpointOption: (_req, _res, next) => next(),
}));

jest.mock('~/server/services/Endpoints/agents', () => ({
  initializeClient: jest.fn(),
}));

jest.mock('~/server/services/Endpoints/agents/title', () => jest.fn());

jest.mock('~/server/controllers/agents/request', () => (req, res) => {
  mockAgentControllerCallCount += 1;
  mockLastParentMessageId = req.body.parentMessageId;
  mockLastConversationId = req.body.conversationId;
  mockLastAgentId = req.body.agent_id;
  mockLastRequestText = req.body.text;
  const respond = () =>
    res.json({
      streamId: 'stream_voice_1',
      conversationId: req.body.conversationId || 'new',
    });
  if (mockAgentControllerResponseDelayMs > 0) {
    setTimeout(respond, mockAgentControllerResponseDelayMs);
    return;
  }
  respond();
});

jest.mock('~/server/services/viventium/CallSessionService', () => ({
  assertCallSessionSecret: jest.fn(),
  claimVoiceSession: jest.fn(),
  assertVoiceGatewayAuth: (...args) => mockAssertVoiceGatewayAuth(...args),
  updateCallSessionConversationId: jest.fn(),
}));

jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
  getMessages: (...args) => mockGetMessages(...args),
  getConvo: (...args) => mockGetConvo(...args),
}));

jest.mock('~/db/models', () => ({
  ViventiumVoiceIngressEvent: {
    create: (...args) => mockVoiceIngressCreate(...args),
    findOne: (...args) => mockVoiceIngressFindOne(...args),
    findOneAndUpdate: (...args) => mockVoiceIngressFindOneAndUpdate(...args),
  },
}));

jest.mock('~/server/services/viventium/VoiceCortexInsightsService', () => ({
  getCompletedCortexInsightsForMessage: jest.fn(),
}));

jest.mock('@librechat/api', () => ({
  GenerationJobManager: {
    getJob: jest.fn(),
    getResumeState: jest.fn(),
    subscribe: jest.fn(),
  },
}));

function createTestApp(router) {
  const app = express();
  app.use('/api/viventium/voice', router);
  return app;
}

function createMockReq({ method = 'POST', url, headers = {}, body = {}, query = {} } = {}) {
  const normalized = {};
  Object.entries(headers).forEach(([key, value]) => {
    normalized[key.toLowerCase()] = value;
  });
  let path = url.split('?')[0];
  const basePrefix = '/api/viventium/voice';
  if (path.startsWith(basePrefix)) {
    path = path.slice(basePrefix.length) || '/';
  }

  return {
    method,
    url,
    originalUrl: url,
    path,
    headers: normalized,
    body,
    query,
    get(name) {
      return normalized[name.toLowerCase()] || '';
    },
    on: jest.fn(),
  };
}

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    writableEnded: false,
    setHeader: jest.fn((name, value) => {
      res.headers[name] = value;
    }),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    flush: jest.fn(),
    status(code) {
      res.statusCode = code;
      return res;
    },
    json: jest.fn((payload) => {
      res.body = payload;
      res.writableEnded = true;
      if (res._resolve) {
        res._resolve();
      }
      return res;
    }),
    end: jest.fn(() => {
      res.writableEnded = true;
      if (res._resolve) {
        res._resolve();
      }
    }),
  };

  res._done = new Promise((resolve, reject) => {
    res._resolve = resolve;
    res._reject = reject;
  });

  return res;
}

function dispatch(app, req, res) {
  app.handle(req, res, (err) => {
    if (err && res._reject) {
      res._reject(err);
    } else if (!res.writableEnded && res._resolve) {
      res._resolve();
    }
  });
  return res._done;
}

async function advanceVoiceRouteTimers(ms) {
  if (typeof jest.advanceTimersByTimeAsync === 'function') {
    await jest.advanceTimersByTimeAsync(ms);
    return;
  }
  jest.advanceTimersByTime(ms);
  await Promise.resolve();
  await Promise.resolve();
}

describe('/api/viventium/voice/chat', () => {
  beforeEach(() => {
    jest.resetModules();
    const { logger } = require('@librechat/data-schemas');
    logger.debug.mockClear();
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    mockLastParentMessageId = null;
    mockLastConversationId = null;
    mockLastAgentId = null;
    mockLastRequestText = null;
    mockAgentControllerCallCount = 0;
    mockAgentControllerResponseDelayMs = 0;
    const voiceIngressStore = new Map();
    mockVoiceIngressCreate = jest.fn().mockImplementation(async (doc) => {
      if (voiceIngressStore.has(doc.dedupeKey)) {
        const err = new Error('duplicate');
        err.code = 11000;
        throw err;
      }
      const saved = { _id: `ingress_${voiceIngressStore.size + 1}`, ...doc };
      voiceIngressStore.set(doc.dedupeKey, saved);
      return saved;
    });
    mockVoiceIngressFindOne = jest.fn().mockImplementation((query) => ({
      lean: async () => voiceIngressStore.get(query.dedupeKey) || null,
    }));
    mockVoiceIngressFindOneAndUpdate = jest.fn().mockImplementation((query, update) => {
      const doc = voiceIngressStore.get(query.dedupeKey);
      if (!doc) {
        return { lean: async () => null };
      }
      if (query.status && doc.status !== query.status) {
        return { lean: async () => null };
      }
      if (update.$push?.segments) {
        doc.segments = [...(doc.segments || []), update.$push.segments];
      }
      if (update.$set) {
        Object.assign(doc, update.$set);
      }
      voiceIngressStore.set(query.dedupeKey, doc);
      return { lean: async () => doc };
    });
    mockAssertVoiceGatewayAuth = jest.fn().mockResolvedValue({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'conv-voice-1',
    });
    mockGetUserById = jest.fn().mockResolvedValue({ _id: 'user_1', role: 'USER' });
    mockGetConvo = jest.fn().mockResolvedValue({
      conversationId: 'conv-voice-1',
      endpoint: 'agents',
      agent_id: 'agent_voice',
    });
    mockGetMessages = jest.fn().mockResolvedValue([
      {
        messageId: 'voice-user-1',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        createdAt: '2026-03-26T21:00:00.220Z',
        isCreatedByUser: true,
      },
      {
        messageId: 'voice-assistant-leaf',
        parentMessageId: 'voice-user-1',
        createdAt: '2026-03-26T21:00:00.100Z',
        isCreatedByUser: false,
      },
    ]);
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.VIVENTIUM_VOICE_TURN_COALESCE_WINDOW_MS;
    delete process.env.VIVENTIUM_VOICE_TURN_COALESCE_WAIT_MS;
    delete process.env.VIVENTIUM_VOICE_TURN_COALESCE_POLL_MS;
    delete process.env.VIVENTIUM_VOICE_TURN_COALESCE_RETURN_WINDOW_MS;
  });

  test('reuses the latest assistant leaf as parentMessageId', async () => {
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: { text: 'check outlook' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockLastConversationId).toBe('conv-voice-1');
    expect(mockLastParentMessageId).toBe('voice-assistant-leaf');
    expect(mockLastAgentId).toBe('agent_voice');
  });

  test('resets invalid conversations to new and NO_PARENT', async () => {
    const { Constants } = require('librechat-data-provider');
    mockGetConvo = jest.fn().mockResolvedValue({
      conversationId: 'conv-google',
      endpoint: 'google',
      agent_id: '',
    });
    mockAssertVoiceGatewayAuth = jest.fn().mockResolvedValue({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'conv-google',
    });

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: { text: 'start fresh' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockLastConversationId).toBe('new');
    expect(mockLastParentMessageId).toBe(Constants.NO_PARENT);
  });

  test('coalesces rapid same-parent voice turns into one launched stream', async () => {
    jest.useFakeTimers();
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_WINDOW_MS = '10';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_WAIT_MS = '200';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_POLL_MS = '5';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_RETURN_WINDOW_MS = '200';
    mockAgentControllerResponseDelayMs = 20;

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);

    const firstReq = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'req-1',
      },
      body: { text: "i've also improved your voice capabilities a lot today" },
    });
    const secondReq = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'req-2',
      },
      body: { text: "everything is on the main branch so you're stable and reliable" },
    });
    const firstRes = createMockRes();
    const secondRes = createMockRes();

    const firstPromise = dispatch(app, firstReq, firstRes);
    await advanceVoiceRouteTimers(2);
    const secondPromise = dispatch(app, secondReq, secondRes);
    await advanceVoiceRouteTimers(100);
    await Promise.all([firstPromise, secondPromise]);

    expect(mockAgentControllerCallCount).toBe(1);
    expect(mockLastRequestText).toBe(
      "i've also improved your voice capabilities a lot today everything is on the main branch so you're stable and reliable",
    );
    expect(firstRes.body.streamId).toBe('stream_voice_1');
    expect(secondRes.body.streamId).toBe('stream_voice_1');
    expect([firstRes.body.coalesced, secondRes.body.coalesced].filter(Boolean)).toHaveLength(1);
  });

  test('coalesces three rapid same-parent voice turns in ingress order', async () => {
    jest.useFakeTimers();
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_WINDOW_MS = '10';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_WAIT_MS = '250';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_POLL_MS = '5';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_RETURN_WINDOW_MS = '250';
    mockAgentControllerResponseDelayMs = 25;

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);

    const makeReq = (requestId, text) =>
      createMockReq({
        url: '/api/viventium/voice/chat',
        headers: {
          'x-viventium-call-secret': 'secret',
          'x-viventium-request-id': requestId,
        },
        body: { text },
      });

    const req1 = makeReq('req-a', 'first clause from speech');
    const req2 = makeReq('req-b', 'second clause from speech');
    const req3 = makeReq('req-c', 'third clause from speech');
    const res1 = createMockRes();
    const res2 = createMockRes();
    const res3 = createMockRes();

    const p1 = dispatch(app, req1, res1);
    await advanceVoiceRouteTimers(2);
    const p2 = dispatch(app, req2, res2);
    await advanceVoiceRouteTimers(2);
    const p3 = dispatch(app, req3, res3);
    await advanceVoiceRouteTimers(120);
    await Promise.all([p1, p2, p3]);

    expect(mockAgentControllerCallCount).toBe(1);
    expect(mockLastRequestText).toBe(
      'first clause from speech second clause from speech third clause from speech',
    );
    expect(res1.body.streamId).toBe('stream_voice_1');
    expect(res2.body.streamId).toBe('stream_voice_1');
    expect(res3.body.streamId).toBe('stream_voice_1');
    expect([res1.body.coalesced, res2.body.coalesced, res3.body.coalesced].filter(Boolean)).toHaveLength(2);
  });

  test('logs committed voice turns with callSessionId and requestId', async () => {
    const { logger } = require('@librechat/data-schemas');
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'req-log-1',
      },
      body: { text: 'log this committed turn' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        '[VIVENTIUM][voice/chat] user_turn_completed source=route callSessionId=call_session_1',
      ),
    );
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('agentId=agent_voice'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('requestId=req-log-1'));
  });

  test('GET glasshive returns latest worker callback for voice speech polling', async () => {
    mockGetMessages = jest.fn().mockResolvedValue([
      {
        messageId: 'gh-callback-1',
        parentMessageId: 'assistant-msg-1',
        text: 'I finished checking the invoices.',
        createdAt: '2026-04-28T22:15:00.000Z',
        metadata: {
          viventium: {
            type: 'glasshive_worker_callback',
            anchorMessageId: 'assistant-msg-1',
            workerId: 'wrk-1',
            runId: 'run-1',
            event: 'run.completed',
          },
        },
      },
    ]);
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/glasshive/assistant-msg-1',
      headers: { 'x-viventium-call-secret': 'secret' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.latest.text).toBe('I finished checking the invoices.');
    expect(mockGetMessages).toHaveBeenCalledWith({
      user: 'user_1',
      conversationId: 'conv-voice-1',
      'metadata.viventium.type': 'glasshive_worker_callback',
    });
  });

  test('GET glasshive reads callback text from content parts when text is empty', async () => {
    mockGetMessages = jest.fn().mockResolvedValue([
      {
        messageId: 'gh-callback-content-only',
        parentMessageId: 'assistant-msg-1',
        text: '',
        content: [{ type: 'text', text: 'Worker result from content.' }],
        createdAt: '2026-04-28T22:16:00.000Z',
        metadata: {
          viventium: {
            type: 'glasshive_worker_callback',
            anchorMessageId: 'assistant-msg-1',
            workerId: 'wrk-1',
            runId: 'run-1',
            event: 'run.completed',
          },
        },
      },
    ]);
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/glasshive/assistant-msg-1',
      headers: { 'x-viventium-call-secret': 'secret' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.latest.text).toBe('Worker result from content.');
  });
});
