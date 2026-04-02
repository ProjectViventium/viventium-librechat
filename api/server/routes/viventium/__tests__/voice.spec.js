/* === VIVENTIUM START ===
 * Feature: Voice ingress route tests (/api/viventium/voice)
 * Added: 2026-03-26
 * === VIVENTIUM END === */

const express = require('express');

let mockAssertVoiceGatewayAuth;
let mockGetUserById;
let mockGetMessages;
let mockGetConvo;
let lastParentMessageId = null;
let lastConversationId = null;
let lastAgentId = null;

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
  lastParentMessageId = req.body.parentMessageId;
  lastConversationId = req.body.conversationId;
  lastAgentId = req.body.agent_id;
  res.json({
    streamId: 'stream_voice_1',
    conversationId: req.body.conversationId || 'new',
  });
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

describe('/api/viventium/voice/chat', () => {
  beforeEach(() => {
    jest.resetModules();
    lastParentMessageId = null;
    lastConversationId = null;
    lastAgentId = null;
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
    expect(lastConversationId).toBe('conv-voice-1');
    expect(lastParentMessageId).toBe('voice-assistant-leaf');
    expect(lastAgentId).toBe('agent_voice');
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
    expect(lastConversationId).toBe('new');
    expect(lastParentMessageId).toBe(Constants.NO_PARENT);
  });
});
