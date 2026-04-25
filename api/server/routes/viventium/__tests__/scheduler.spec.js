/* === VIVENTIUM START ===
 * Feature: Scheduler gateway tests (Telegram mapping resolve)
 * Added: 2026-01-17
 * === VIVENTIUM END === */

const express = require('express');

let mockGetUserById;
let mockGetMessage;
let mockGetMessages;
let mockGetConvo;
let mockResolveTelegramMappingByUserId;
let mockGetAgent;
let mockGetJob;
let mockGetResumeState;
let mockSubscribe;
let lastParentMessageId = null;
let lastSpec = null;
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

jest.mock('~/server/controllers/agents/request', () => (req, res) => {
  lastParentMessageId = req.body.parentMessageId;
  lastSpec = req.body.spec;
  lastAgentId = req.body.agent_id;
  res.json({ streamId: 'stream_1', conversationId: req.body.conversationId || 'new' });
});

jest.mock('~/server/services/Endpoints/agents', () => ({
  initializeClient: jest.fn(),
}));

jest.mock('~/server/services/Endpoints/agents/title', () => jest.fn());

jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
  getMessage: (...args) => mockGetMessage(...args),
  getMessages: (...args) => mockGetMessages(...args),
  getConvo: (...args) => mockGetConvo(...args),
}));

jest.mock('~/models/Agent', () => ({
  getAgent: (...args) => mockGetAgent(...args),
}));

jest.mock('@librechat/api', () => ({
  GenerationJobManager: {
    getJob: (...args) => mockGetJob(...args),
    getResumeState: (...args) => mockGetResumeState(...args),
    subscribe: (...args) => mockSubscribe(...args),
  },
}));

jest.mock('~/server/services/TelegramLinkService', () => ({
  resolveTelegramMappingByUserId: (...args) => mockResolveTelegramMappingByUserId(...args),
}));

function createTestApp(router) {
  const app = express();
  app.use('/api/viventium/scheduler', router);
  return app;
}

function createMockReq({ method = 'POST', url, headers = {}, body = {}, query = {} } = {}) {
  const normalized = {};
  Object.entries(headers).forEach(([key, value]) => {
    normalized[key.toLowerCase()] = value;
  });
  let path = url.split('?')[0];
  const basePrefix = '/api/viventium/scheduler';
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

describe('/api/viventium/scheduler/telegram/resolve', () => {
  beforeEach(() => {
    jest.resetModules();
    lastParentMessageId = null;
    lastSpec = null;
    lastAgentId = null;
    mockGetUserById = jest.fn().mockResolvedValue({ _id: 'user_1', role: 'USER' });
    mockGetMessage = jest.fn().mockResolvedValue(null);
    mockGetMessages = jest.fn().mockResolvedValue([]);
    mockGetConvo = jest.fn().mockResolvedValue(null);
    mockResolveTelegramMappingByUserId = jest.fn().mockResolvedValue({ telegramUserId: 'tg-1' });
    mockGetAgent = jest.fn().mockResolvedValue({
      avatar: { filepath: '/images/viventium.png' },
    });
    mockGetJob = jest.fn().mockResolvedValue({
      metadata: { userId: 'user_1' },
    });
    mockGetResumeState = jest.fn().mockResolvedValue(null);
    mockSubscribe = jest.fn().mockResolvedValue({ unsubscribe: jest.fn() });
    process.env.VIVENTIUM_SCHEDULER_SECRET = 'scheduler_secret';
    process.env.DOMAIN_SERVER = 'http://example.com';
  });

  test('rejects missing secret', async () => {
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/telegram/resolve',
      body: { userId: 'user_1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.reason).toBe('secret_mismatch');
  });

  test('rejects missing userId', async () => {
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/telegram/resolve',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: {},
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.reason).toBe('missing_user_id');
  });

  test('rejects unknown user with explicit reason', async () => {
    mockGetUserById = jest.fn().mockResolvedValue(null);
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/telegram/resolve',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: { userId: 'user_1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.reason).toBe('user_not_found');
  });

  test('returns mapping when linked', async () => {
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/telegram/resolve',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: { userId: 'user_1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      telegram_user_id: 'tg-1',
      telegram_chat_id: 'tg-1',
      linked: true,
      voice_preferences: {
        always_voice_response: false,
        voice_responses_enabled: true,
      },
    });
  });

  test('returns 404 when mapping missing', async () => {
    mockResolveTelegramMappingByUserId = jest.fn().mockResolvedValue(null);
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/telegram/resolve',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: { userId: 'user_1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(404);
  });
});

describe('/api/viventium/scheduler/chat', () => {
  beforeEach(() => {
    jest.resetModules();
    lastParentMessageId = null;
    lastSpec = null;
    lastAgentId = null;
    mockGetUserById = jest.fn().mockResolvedValue({ _id: 'user_1', role: 'USER' });
    mockGetMessage = jest.fn().mockResolvedValue(null);
    mockGetMessages = jest.fn().mockResolvedValue([]);
    mockGetConvo = jest.fn().mockResolvedValue(null);
    mockResolveTelegramMappingByUserId = jest.fn().mockResolvedValue({ telegramUserId: 'tg-1' });
    mockGetAgent = jest.fn().mockResolvedValue({
      avatar: { filepath: '/images/viventium.png' },
    });
    mockGetJob = jest.fn().mockResolvedValue({
      metadata: { userId: 'user_1' },
    });
    mockGetResumeState = jest.fn().mockResolvedValue(null);
    mockSubscribe = jest.fn().mockResolvedValue({ unsubscribe: jest.fn() });
    process.env.VIVENTIUM_SCHEDULER_SECRET = 'scheduler_secret';
    process.env.DOMAIN_SERVER = 'http://example.com';
  });

  test('new convo sets parentMessageId to NO_PARENT and persists iconURL', async () => {
    const { Constants } = require('librechat-data-provider');
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/chat',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: {
        userId: 'user_1',
        text: 'hi',
        conversationId: 'new',
        agentId: 'agent_test',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(200);
    expect(lastParentMessageId).toBe(Constants.NO_PARENT);
    expect(lastSpec).toBe('viventium');
    expect(lastAgentId).toBe('agent_test');
  });

  test('existing convo resolves parentMessageId from the latest leaf', async () => {
    mockGetConvo = jest.fn().mockResolvedValue({
      conversationId: 'conv-1',
      endpoint: 'agents',
      agent_id: 'agent_test',
    });
    mockGetMessages = jest.fn().mockResolvedValue([
      {
        messageId: 'prior-user',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        createdAt: '2026-03-26T20:07:52.610Z',
        isCreatedByUser: true,
      },
      {
        messageId: 'assistant-leaf',
        parentMessageId: 'prior-user',
        createdAt: '2026-03-26T20:07:52.602Z',
        isCreatedByUser: false,
      },
    ]);
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/chat',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: {
        userId: 'user_1',
        text: 'check outlook',
        conversationId: 'conv-1',
        agentId: 'agent_test',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(lastParentMessageId).toBe('assistant-leaf');
  });

  test('invalid non-agent conversation is auto-reset to new', async () => {
    const { Constants } = require('librechat-data-provider');
    mockGetConvo = jest.fn().mockResolvedValue({
      conversationId: 'conv-google',
      endpoint: 'google',
      agent_id: '',
    });
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/chat',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: {
        userId: 'user_1',
        text: 'hi',
        conversationId: 'conv-google',
        agentId: 'agent_test',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.conversationId).toBe('new');
    expect(lastParentMessageId).toBe(Constants.NO_PARENT);
  });
});

describe('/api/viventium/scheduler/stream', () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetUserById = jest.fn().mockResolvedValue({ _id: 'user_1', role: 'USER' });
    mockGetMessage = jest.fn().mockResolvedValue(null);
    mockGetMessages = jest.fn().mockResolvedValue([]);
    mockGetConvo = jest.fn().mockResolvedValue(null);
    mockResolveTelegramMappingByUserId = jest.fn().mockResolvedValue({ telegramUserId: 'tg-1' });
    mockGetAgent = jest.fn().mockResolvedValue({ avatar: { filepath: '/images/viventium.png' } });
    mockGetJob = jest.fn().mockResolvedValue({ metadata: { userId: 'user_1' } });
    mockGetResumeState = jest.fn().mockResolvedValue(null);
    mockSubscribe = jest.fn().mockImplementation(async (_streamId, onChunk, onDone) => {
      onChunk({ event: 'on_message_delta', data: { delta: { content: [{ type: 'text', text: 'Hello ' }] } } });
      onDone({
        final: true,
        responseMessage: { text: 'Hello world', messageId: 'msg-1' },
        responseMessageId: 'msg-1',
      });
      return { unsubscribe: jest.fn() };
    });
    process.env.VIVENTIUM_SCHEDULER_SECRET = 'scheduler_secret';
  });

  test('streams raw scheduler events for canonical run capture', async () => {
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/scheduler/stream/scheduler-1',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      query: { userId: 'user_1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    const writes = res.write.mock.calls.map((call) => call[0]).join('\n');
    expect(res.statusCode).toBe(200);
    expect(writes).toContain('"event":"on_message_delta"');
    expect(writes).toContain('"final":true');
  });
});

describe('/api/viventium/scheduler/cortex', () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetUserById = jest.fn().mockResolvedValue({ _id: 'user_1', role: 'USER' });
    mockGetMessage = jest.fn().mockResolvedValue({
      messageId: 'msg-1',
      conversationId: 'conv-1',
      text: 'Canonical response',
      content: [{ type: 'cortex_insight', status: 'complete', insight: 'done' }],
    });
    mockGetMessages = jest.fn().mockResolvedValue([
      { messageId: 'fu-1', text: 'Follow-up text' },
    ]);
    mockGetConvo = jest.fn().mockResolvedValue(null);
    mockResolveTelegramMappingByUserId = jest.fn().mockResolvedValue({ telegramUserId: 'tg-1' });
    mockGetAgent = jest.fn().mockResolvedValue({ avatar: { filepath: '/images/viventium.png' } });
    mockGetJob = jest.fn().mockResolvedValue({ metadata: { userId: 'user_1' } });
    mockGetResumeState = jest.fn().mockResolvedValue(null);
    mockSubscribe = jest.fn().mockResolvedValue({ unsubscribe: jest.fn() });
    process.env.VIVENTIUM_SCHEDULER_SECRET = 'scheduler_secret';
  });

  test('returns follow-up and cortex parts for scheduler polling', async () => {
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/scheduler/cortex/msg-1',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      query: { userId: 'user_1', conversationId: 'conv-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.followUp).toEqual({ messageId: 'fu-1', text: 'Follow-up text' });
    expect(res.body.canonicalText).toBe('Canonical response');
    expect(res.body.canonicalTextSource).toBe('message');
    expect(res.body.cortexParts).toHaveLength(1);
  });

  test('returns sanitized canonical parent text when follow-up node is absent', async () => {
    mockGetMessage = jest.fn().mockResolvedValue({
      messageId: 'msg-2',
      conversationId: 'conv-1',
      text: '{NTA} Fresh inbox summary',
      content: [{ type: 'cortex_insight', status: 'complete', insight: 'done' }],
    });
    mockGetMessages = jest.fn().mockResolvedValue([]);

    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/scheduler/cortex/msg-2',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      query: { userId: 'user_1', conversationId: 'conv-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.followUp).toBeNull();
    expect(res.body.canonicalText).toBe('Fresh inbox summary');
    expect(res.body.canonicalTextSource).toBe('message');
  });

  test('suppresses generic deferred error text for scheduled polling when scheduleId is present', async () => {
    mockGetMessage = jest.fn().mockResolvedValue({
      messageId: 'msg-scheduled-empty',
      conversationId: 'conv-1',
      model: 'agent_main',
      text: '',
      content: [
        { type: 'text', text: "I'm here. Shoot." },
        {
          type: 'cortex_insight',
          status: 'complete',
          cortex_name: 'Pattern Recognition',
          insight: 'Go ahead.',
        },
      ],
    });
    mockGetMessages = jest.fn().mockResolvedValue([]);
    mockGetAgent = jest.fn().mockResolvedValue({
      instructions: `
Holding Examples
- "I'm here. Shoot."
`,
    });

    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/scheduler/cortex/msg-scheduled-empty',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      query: { userId: 'user_1', conversationId: 'conv-1', scheduleId: 'schedule-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.followUp).toBeNull();
    expect(res.body.canonicalText).toBe('');
    expect(res.body.canonicalTextSource).toBe('deferred_fallback');
    expect(res.body.canonicalTextFallbackReason).toBe('empty_deferred_response');
  });

  test('suppresses followUp when the replaced parent message matches the parent id', async () => {
    mockGetMessage = jest.fn().mockResolvedValue({
      messageId: 'msg-3',
      conversationId: 'conv-1',
      text: 'Canonical replacement text',
      content: [{ type: 'cortex_insight', status: 'complete', insight: 'done' }],
    });
    mockGetMessages = jest.fn().mockResolvedValue([
      { messageId: 'msg-3', text: 'Canonical replacement text' },
    ]);

    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/scheduler/cortex/msg-3',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      query: { userId: 'user_1', conversationId: 'conv-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.followUp).toBeNull();
    expect(res.body.canonicalText).toBe('Canonical replacement text');
  });
});
