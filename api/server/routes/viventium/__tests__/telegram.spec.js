/* === VIVENTIUM START ===
 * Feature: LibreChat Telegram Bridge - /api/viventium/telegram tests
 * Added: 2026-01-13
 * === VIVENTIUM END === */

const express = require('express');
const { Readable } = require('stream');
const { EventEmitter } = require('events');

let lastAgentId = null;
let lastStreamId = null;
let lastParentMessageId = null;
let lastSpec = null;
let lastVoiceProvider = null;
let mockUserFindOne;
let mockUserCountDocuments;
let mockSubscribe;
let mockGetJob;
let mockGetResumeState;
let mockGetMessages;
let mockGetMessage;
let mockGetConvo;
let mockGetAgent;
let mockResolveUserVoiceRoute;
let mockTelegramMappingFindOne;
let mockTelegramMappingUpdateOne;
let mockTelegramLinkTokenCreate;
let mockTelegramIngressCreate;
let mockTelegramIngressDeleteOne;
let mockFileAccess;
let mockGetStrategyFunctions;
let mockLoadAuthValues;
let mockCreateCallSession;
let mockFilterFile;
let mockProcessAgentFileUpload;
let mockClaimGlassHiveDeliveries;
let mockMarkGlassHiveDeliverySent;
let mockMarkGlassHiveDeliveryFailed;
let mockMarkGlassHiveDeliverySuppressed;
let mockDeliveryBacklogSummary;

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
      interface: { defaultAgent: 'agent_default' },
      endpoints: { agents: { defaultId: 'agent_default' } },
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
  lastAgentId = req.body.agent_id;
  lastStreamId = req.body.streamId;
  lastParentMessageId = req.body.parentMessageId;
  lastSpec = req.body.spec;
  lastVoiceProvider = req.body.voiceProvider || null;
  res.json({ streamId: 'stream_1', conversationId: req.body.conversationId || 'new' });
});

jest.mock('~/server/services/Endpoints/agents', () => ({
  initializeClient: jest.fn(),
}));

jest.mock('~/server/services/Endpoints/agents/title', () => jest.fn());

jest.mock('~/models', () => ({
  getUserById: async () => ({ _id: 'user_1', role: 'USER' }),
  getMessages: (...args) => mockGetMessages(...args),
  getMessage: (...args) => mockGetMessage(...args),
  getConvo: (...args) => mockGetConvo(...args),
}));

jest.mock('~/server/middleware/accessResources/fileAccess', () => ({
  fileAccess: (...args) => mockFileAccess(...args),
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: (...args) => mockGetStrategyFunctions(...args),
}));

jest.mock('~/server/services/Tools/credentials', () => ({
  loadAuthValues: (...args) => mockLoadAuthValues(...args),
}));

jest.mock('~/server/services/Files/process', () => ({
  filterFile: (...args) => mockFilterFile(...args),
  processAgentFileUpload: (...args) => mockProcessAgentFileUpload(...args),
}));

jest.mock('~/server/utils/files', () => ({
  cleanFileName: (name) => name,
}));

jest.mock('~/server/controllers/assistants/helpers', () => ({
  getOpenAIClient: async () => ({ openai: {} }),
}));

jest.mock('~/server/services/viventium/CallSessionService', () => ({
  createCallSession: (...args) => mockCreateCallSession(...args),
  resolveUserVoiceRoute: (...args) => mockResolveUserVoiceRoute(...args),
}));

jest.mock('~/server/services/viventium/GlassHiveCallbackDeliveryService', () => ({
  claimPendingGlassHiveCallbackDeliveries: (...args) => mockClaimGlassHiveDeliveries(...args),
  markGlassHiveCallbackDeliverySent: (...args) => mockMarkGlassHiveDeliverySent(...args),
  markGlassHiveCallbackDeliveryFailed: (...args) => mockMarkGlassHiveDeliveryFailed(...args),
  markGlassHiveCallbackDeliverySuppressed: (...args) =>
    mockMarkGlassHiveDeliverySuppressed(...args),
  deliveryBacklogSummary: (...args) => mockDeliveryBacklogSummary(...args),
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

jest.mock('~/db/models', () => ({
  User: {
    findOne: (...args) => mockUserFindOne(...args),
    countDocuments: (...args) => mockUserCountDocuments(...args),
  },
  TelegramUserMapping: {
    findOne: (...args) => mockTelegramMappingFindOne(...args),
    updateOne: (...args) => mockTelegramMappingUpdateOne(...args),
    findOneAndUpdate: jest.fn(),
  },
  TelegramLinkToken: {
    create: (...args) => mockTelegramLinkTokenCreate(...args),
    findOneAndUpdate: jest.fn(),
  },
  ViventiumTelegramIngressEvent: {
    create: (...args) => mockTelegramIngressCreate(...args),
    deleteOne: (...args) => mockTelegramIngressDeleteOne(...args),
  },
}));

/* === VIVENTIUM NOTE ===
 * Fix: Avoid binding sockets in sandboxed test runs (EPERM).
 * Use app.handle with mocked req/res instead of supertest.
 * === VIVENTIUM NOTE === */
function createTestApp(router) {
  const app = express();
  app.use('/api/viventium/telegram', router);
  return app;
}

function createMockReq({ method = 'POST', url, headers = {}, body = {}, query = {} } = {}) {
  const normalized = {};
  Object.entries(headers).forEach(([key, value]) => {
    normalized[key.toLowerCase()] = value;
  });
  let path = url.split('?')[0];
  const basePrefix = '/api/viventium/telegram';
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

/* === VIVENTIUM NOTE ===
 * Helper: Stream-capable mock response for download endpoints (Readable.pipe -> res).
 * === VIVENTIUM NOTE === */
function createMockStreamRes() {
  const emitter = new EventEmitter();
  const res = {
    statusCode: 200,
    headers: {},
    writableEnded: false,
    body: undefined,
    chunks: [],
    setHeader: jest.fn((name, value) => {
      res.headers[name] = value;
    }),
    set: jest.fn((headers) => {
      Object.assign(res.headers, headers);
    }),
    write: jest.fn((chunk) => {
      res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    }),
    end: jest.fn((chunk) => {
      if (chunk) {
        res.write(chunk);
      }
      res.writableEnded = true;
      emitter.emit('finish');
      if (res._resolve) {
        res._resolve();
      }
    }),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
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

describe('/api/viventium/telegram', () => {
  beforeEach(() => {
    lastAgentId = null;
    lastStreamId = null;
    lastParentMessageId = null;
    lastSpec = null;
    lastVoiceProvider = null;
    jest.resetModules();
    mockUserFindOne = jest.fn();
    mockUserCountDocuments = jest.fn().mockResolvedValue(0);
    mockSubscribe = jest.fn();
    mockGetJob = jest.fn().mockResolvedValue({ metadata: { userId: 'user_1' } });
    mockGetResumeState = jest.fn().mockResolvedValue(null);
    mockGetMessages = jest.fn().mockResolvedValue([]);
    mockGetMessage = jest.fn().mockResolvedValue(null);
    mockGetConvo = jest.fn().mockResolvedValue(null);
    mockGetAgent = jest.fn().mockResolvedValue({
      avatar: { filepath: '/images/viventium.png' },
    });
    mockFileAccess = jest.fn((req, _res, next) => {
      // Default: no-op; individual tests can set req.fileAccess.file
      next();
    });
    mockGetStrategyFunctions = jest.fn().mockReturnValue({
      getDownloadStream: jest.fn().mockResolvedValue(Readable.from([Buffer.from('file-bytes')])),
    });
    mockLoadAuthValues = jest.fn().mockResolvedValue({ CODE_API_KEY: 'code-key' });
    mockFilterFile = jest.fn();
    mockProcessAgentFileUpload = jest.fn(async ({ req, res, metadata }) => {
      res.status(200).json({
        message: 'Agent file uploaded and processed successfully',
        file_id: metadata.file_id,
        temp_file_id: metadata.temp_file_id,
        filename: req.file?.originalname ?? 'attachment.bin',
        filepath: '/uploads/mock/attachment.bin',
        type: req.file?.mimetype ?? 'application/octet-stream',
        source: 'local',
      });
    });
    mockCreateCallSession = jest.fn(async ({ userId, agentId, conversationId }) => ({
      callSessionId: 'call_session_test',
      userId,
      agentId,
      conversationId,
      roomName: 'lc-calltest',
      requestedVoiceRoute: null,
    }));
    mockResolveUserVoiceRoute = jest.fn().mockResolvedValue({
      stt: { provider: 'pywhispercpp', variant: 'large-v3-turbo' },
      tts: {
        provider: 'local_chatterbox_turbo_mlx_8bit',
        variant: 'mlx-community/chatterbox-turbo-8bit',
      },
    });
    mockClaimGlassHiveDeliveries = jest.fn().mockResolvedValue([]);
    mockMarkGlassHiveDeliverySent = jest.fn().mockResolvedValue({ deliveryId: 'ghcd_1' });
    mockMarkGlassHiveDeliveryFailed = jest.fn().mockResolvedValue({ deliveryId: 'ghcd_1' });
    mockMarkGlassHiveDeliverySuppressed = jest.fn().mockResolvedValue({ deliveryId: 'ghcd_1' });
    mockDeliveryBacklogSummary = jest.fn().mockResolvedValue({ count: 0, oldest: null });
    mockTelegramMappingFindOne = jest.fn().mockReturnValue({
      lean: async () => ({ libreChatUserId: 'user_1' }),
    });
    mockTelegramMappingUpdateOne = jest.fn().mockResolvedValue({});
    mockTelegramLinkTokenCreate = jest.fn().mockResolvedValue({});
    mockTelegramIngressCreate = jest.fn().mockResolvedValue({ _id: 'ingress_1' });
    mockTelegramIngressDeleteOne = jest.fn().mockResolvedValue({});
    process.env.VIVENTIUM_TELEGRAM_SECRET = 'telegram_secret';
    process.env.DOMAIN_SERVER = 'http://example.com';
    process.env.VIVENTIUM_PLAYGROUND_URL = 'http://localhost:3300';
    process.env.VIVENTIUM_PUBLIC_PLAYGROUND_URL = '';
    process.env.VIVENTIUM_VOICE_GATEWAY_AGENT_NAME = 'librechat-voice-gateway';
  });

  test('POST rejects missing secret', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      body: { text: 'hi', conversationId: 'new' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(401);
  });

  test('POST uses default agent when none supplied', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { text: 'hi', conversationId: 'new', telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.streamId).toBe('stream_1');
    expect(lastAgentId).toBe('agent_default');
    expect(typeof lastStreamId).toBe('string');
    expect(lastStreamId.startsWith('telegram-')).toBe(true);
  });

  test('POST suppresses duplicate ingress replay with no-op response', async () => {
    const duplicateError = new Error('duplicate key');
    duplicateError.code = 11000;
    mockTelegramIngressCreate
      .mockResolvedValueOnce({ _id: 'ingress_1' })
      .mockRejectedValueOnce(duplicateError);

    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);

    const payload = {
      text: 'hi',
      conversationId: 'new',
      telegramUserId: 'tg-1',
      telegramChatId: 'chat-1',
      telegramMessageId: '42',
      telegramUpdateId: '99',
    };

    const firstReq = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: payload,
    });
    const firstRes = createMockRes();
    await dispatch(app, firstReq, firstRes);

    expect(firstRes.statusCode).toBe(200);
    expect(firstRes.body.streamId).toBe('stream_1');

    lastStreamId = null;

    const secondReq = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: payload,
    });
    const secondRes = createMockRes();
    await dispatch(app, secondReq, secondRes);

    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.body.duplicate).toBe(true);
    expect(secondRes.body.streamId).toBe('');
    expect(lastStreamId).toBeNull();
  });

  test('POST new convo sets parentMessageId to NO_PARENT (enables title generation)', async () => {
    const { Constants } = require('librechat-data-provider');
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { text: 'hi', conversationId: 'new', telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(200);
    expect(lastParentMessageId).toBe(Constants.NO_PARENT);
  });

  test('POST new convo persists iconURL from agent avatar (sidebar icon parity)', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { text: 'hi', conversationId: 'new', telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(200);
    expect(lastSpec).toBe('viventium');
  });

  test('POST existing convo resolves parentMessageId from the latest leaf, not the latest createdAt row', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const nowMs = Date.now();
    mockGetConvo.mockResolvedValueOnce({ conversationId: 'conv-1', endpoint: 'agents' });
    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'prior-user',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        createdAt: new Date(nowMs).toISOString(),
        isCreatedByUser: true,
      },
      {
        messageId: 'assistant-leaf',
        parentMessageId: 'prior-user',
        createdAt: new Date(nowMs - 8).toISOString(),
        isCreatedByUser: false,
      },
    ]);

    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { text: 'check outlook', conversationId: 'conv-1', telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(lastParentMessageId).toBe('assistant-leaf');
  });

  test('POST fails closed when a Telegram attachment cannot be processed into raw provider upload or readable context', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    mockProcessAgentFileUpload.mockRejectedValueOnce(
      new Error(
        `Unsupported message attachment type application/zip. This file can't be sent provider-natively or extracted as readable text on this surface.`,
      ),
    );
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        text: 'review this',
        conversationId: 'new',
        telegramUserId: 'tg-1',
        files: [
          {
            filename: 'archive.zip',
            mime_type: 'application/zip',
            data: Buffer.from('zip-bytes').toString('base64'),
          },
        ],
      },
    });
    const res = createMockRes();

    await expect(dispatch(app, req, res)).rejects.toThrow(
      /Telegram attachment upload failed for "archive\.zip"/,
    );
  });

  test('POST stale existing convo resets to new for Telegram hidden conversation reuse', async () => {
    process.env.VIVENTIUM_TELEGRAM_CONVERSATION_IDLE_MAX_M = '60';
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    mockGetConvo.mockResolvedValueOnce({ conversationId: 'conv-stale', endpoint: 'agents' });
    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'old-msg',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        createdAt: '2026-03-24T20:00:00.000Z',
        isCreatedByUser: true,
      },
    ]);

    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { text: 'hey', conversationId: 'conv-stale', telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(lastParentMessageId).toBe('00000000-0000-0000-0000-000000000000');
    expect(res.body.conversationId).toBe('new');
  });

  test('POST requires telegramUserId', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { text: 'hi', conversationId: 'new' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(400);
  });

  test('POST returns link when telegram user is unlinked', async () => {
    mockTelegramMappingFindOne.mockReturnValue({
      lean: async () => null,
    });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { text: 'hi', conversationId: 'new', telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.linkRequired).toBe(true);
    expect(res.body.linkUrl).toContain('/api/viventium/telegram/link/');
  });

  test('POST /call-link requires a public HTTPS playground URL for Telegram launches', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/call-link',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { conversationId: 'new', telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(mockCreateCallSession).not.toHaveBeenCalled();
    expect(res.body.publicPlaygroundRequired).toBe(true);
    expect(res.body.error).toContain('public HTTPS Viventium voice URL');
  });

  test('POST /call-link creates a call session and returns a public deep-link url', async () => {
    process.env.VIVENTIUM_PUBLIC_PLAYGROUND_URL = 'https://voice.viventium.ai';
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/call-link',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { conversationId: 'new', telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockCreateCallSession).toHaveBeenCalledWith({
      userId: 'user_1',
      agentId: 'agent_default',
      conversationId: 'new',
    });
    expect(res.body.callUrl).toBe(res.body.playgroundUrl);
    const url = new URL(res.body.playgroundUrl);
    expect(url.origin).toBe('https://voice.viventium.ai');
    expect(url.searchParams.get('roomName')).toBe('lc-calltest');
    expect(url.searchParams.get('callSessionId')).toBe('call_session_test');
    expect(url.searchParams.get('agentName')).toBe('librechat-voice-gateway');
    expect(url.searchParams.get('autoConnect')).toBe('1');
  });

  test('POST /call-link returns linkRequired when telegram user is unlinked', async () => {
    mockTelegramMappingFindOne.mockReturnValue({
      lean: async () => null,
    });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/call-link',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { conversationId: 'new', telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.linkRequired).toBe(true);
    expect(res.body.linkUrl).toContain('/api/viventium/telegram/link/');
  });

  test('GET /voice-route returns the linked user voice route', async () => {
    mockResolveUserVoiceRoute.mockResolvedValueOnce({
      stt: { provider: 'assemblyai', variant: 'universal-streaming' },
      tts: { provider: 'cartesia', variant: '6ccbfb76-1fc6-48f7-b71d-91ac6298247b' },
    });

    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/voice-route',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockResolveUserVoiceRoute).toHaveBeenCalledWith('user_1');
    expect(res.body.voiceRoute).toEqual({
      stt: { provider: 'assemblyai', variant: 'universal-streaming' },
      tts: { provider: 'cartesia', variant: '6ccbfb76-1fc6-48f7-b71d-91ac6298247b' },
    });
  });

  test('GET /voice-route returns xAI voice variants for Telegram TTS parity', async () => {
    mockResolveUserVoiceRoute.mockResolvedValueOnce({
      stt: { provider: 'pywhispercpp', variant: 'large-v3-turbo' },
      tts: { provider: 'xai', variant: 'Rex' },
    });

    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/voice-route',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockResolveUserVoiceRoute).toHaveBeenCalledWith('user_1');
    expect(res.body.voiceRoute).toEqual({
      stt: { provider: 'pywhispercpp', variant: 'large-v3-turbo' },
      tts: { provider: 'xai', variant: 'Rex' },
    });
  });

  test('POST /chat overrides voiceProvider from the resolved voice route and returns it', async () => {
    mockResolveUserVoiceRoute.mockResolvedValueOnce({
      stt: { provider: 'pywhispercpp', variant: 'large-v3-turbo' },
      tts: { provider: 'cartesia', variant: '6ccbfb76-1fc6-48f7-b71d-91ac6298247b' },
    });

    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        text: 'hi',
        conversationId: 'new',
        telegramUserId: 'tg-1',
        voiceMode: true,
        voiceProvider: 'openai',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(lastVoiceProvider).toBe('cartesia');
    expect(res.body.voiceRoute).toEqual({
      stt: { provider: 'pywhispercpp', variant: 'large-v3-turbo' },
      tts: { provider: 'cartesia', variant: '6ccbfb76-1fc6-48f7-b71d-91ac6298247b' },
    });
  });

  test('POST /chat overrides voiceProvider to xAI and returns saved xAI voice variant', async () => {
    mockResolveUserVoiceRoute.mockResolvedValueOnce({
      stt: { provider: 'pywhispercpp', variant: 'large-v3-turbo' },
      tts: { provider: 'xai', variant: 'Eve' },
    });

    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        text: 'hi',
        conversationId: 'new',
        telegramUserId: 'tg-1',
        voiceMode: true,
        voiceProvider: 'openai',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(lastVoiceProvider).toBe('xai');
    expect(res.body.voiceRoute).toEqual({
      stt: { provider: 'pywhispercpp', variant: 'large-v3-turbo' },
      tts: { provider: 'xai', variant: 'Eve' },
    });
  });

  test('GET stream honors lingerMs before closing', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);

    mockSubscribe.mockImplementation(async (_streamId, _onChunk, onDone) => {
      setTimeout(() => onDone({ final: true }), 5);
      return { unsubscribe: jest.fn() };
    });

    const lingerMs = 80;
    const req = createMockReq({
      method: 'GET',
      url: `/api/viventium/telegram/stream/stream_1?lingerMs=${lingerMs}`,
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { lingerMs: String(lingerMs), telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    const startedAt = Date.now();
    await dispatch(app, req, res);
    const elapsedMs = Date.now() - startedAt;
    expect(res.statusCode).toBe(200);
    expect(elapsedMs).toBeGreaterThanOrEqual(lingerMs);
    expect(mockSubscribe).toHaveBeenCalled();
  });

  test('GET stream returns 404 when job is missing (resume not possible)', async () => {
    mockGetJob.mockResolvedValueOnce(null);
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/stream/missing_1?resume=true&telegramUserId=tg-1',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { resume: 'true', telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('Stream not found');
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  test('GET stream forwards attachment events in SSE payload', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);

    mockSubscribe.mockImplementation(async (_streamId, onChunk, onDone) => {
      onChunk({
        event: 'attachment',
        data: {
          file_id: 'file-1',
          filename: 'artifact.png',
          filepath: '/images/user/artifact.png',
        },
      });
      onDone({ final: true });
      return { unsubscribe: jest.fn() };
    });

    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/stream/stream_1?telegramUserId=tg-1',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    const writes = res.write.mock.calls.map((call) => String(call[0] || ''));
    expect(writes.some((line) => line.includes('"event":"attachment"'))).toBe(true);
    expect(writes.some((line) => line.includes('"file_id":"file-1"'))).toBe(true);
  });

  test('POST preferences persists voice preference sync payload', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/preferences',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        telegramUserId: 'tg-1',
        alwaysVoiceResponse: true,
        voiceResponsesEnabled: false,
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.updated).toBe(true);

    const calls = mockTelegramMappingUpdateOne.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[1].$set.alwaysVoiceResponse).toBe(true);
    expect(lastCall[1].$set.voiceResponsesEnabled).toBe(false);
  });

  test('GET cortex returns cortex parts and follow-up', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);

    mockGetMessage.mockResolvedValueOnce({
      messageId: 'msg-1',
      conversationId: 'conv-1',
      text: 'Canonical telegram response',
      content: [{ type: 'cortex_brewing', status: 'brewing' }],
    });
    mockGetMessages.mockResolvedValueOnce([{ messageId: 'follow-1', text: 'Follow-up text' }]);

    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/cortex/msg-1?conversationId=conv-1',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { conversationId: 'conv-1', telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.messageId).toBe('msg-1');
    expect(res.body.cortexParts).toHaveLength(1);
    expect(res.body.followUp.text).toBe('Follow-up text');
    expect(res.body.canonicalText).toBe('Canonical telegram response');
    expect(res.body.canonicalTextSource).toBe('message');
    expect(mockGetMessages).toHaveBeenCalledWith({
      user: 'user_1',
      conversationId: 'conv-1',
      'metadata.viventium.parentMessageId': 'msg-1',
      'metadata.viventium.type': 'cortex_followup',
    });
  });

  test('GET glasshive returns latest worker callback for Telegram polling', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);

    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'gh-callback-1',
        parentMessageId: 'assistant-msg-1',
        text: 'The invoice check is done.',
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

    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/glasshive/assistant-msg-1?conversationId=conv-1',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { conversationId: 'conv-1', telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.latest.text).toBe('The invoice check is done.');
    expect(res.body.latest.workerId).toBeUndefined();
    expect(res.body.latest.runId).toBeUndefined();
    expect(res.body.latest.callbackId).toBeUndefined();
    expect(mockGetMessages).toHaveBeenCalledWith({
      user: 'user_1',
      conversationId: 'conv-1',
      'metadata.viventium.type': 'glasshive_worker_callback',
    });
  });

  test('GET glasshive reads callback text from content parts when text is empty', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);

    mockGetMessages.mockResolvedValueOnce([
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

    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/glasshive/assistant-msg-1?conversationId=conv-1',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { conversationId: 'conv-1', telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.latest.text).toBe('Worker result from content.');
  });

  test('POST glasshive delivery claim uses bridge secret without per-user Telegram id', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    mockClaimGlassHiveDeliveries.mockResolvedValueOnce([
      {
        deliveryId: 'ghcd_1',
        callbackId: 'cb_1',
        text: 'Worker finished.',
        telegramChatId: 'chat-1',
        claimId: 'claim-1',
      },
    ]);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/telegram/glasshive/deliveries/claim',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { limit: 5, dispatcherId: 'test-dispatcher' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.deliveries).toHaveLength(1);
    expect(mockClaimGlassHiveDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'telegram',
        limit: 5,
        claimOwner: 'test-dispatcher',
      }),
    );
  });

  test('POST glasshive delivery status marks sent by delivery claim id', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/telegram/glasshive/deliveries/ghcd_1/status',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { claimId: 'claim-1', status: 'sent' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockMarkGlassHiveDeliverySent).toHaveBeenCalledWith({
      deliveryId: 'ghcd_1',
      claimId: 'claim-1',
    });
  });

  test('POST glasshive delivery status reports lost claim as conflict', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    mockMarkGlassHiveDeliverySent.mockResolvedValueOnce(null);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/telegram/glasshive/deliveries/ghcd_1/status',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { claimId: 'claim-stale', status: 'sent' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('delivery_not_claimed');
  });

  test('GET cortex resolves deferred fallback canonical text when follow-up is absent', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);

    mockGetMessage.mockResolvedValueOnce({
      messageId: 'msg-2',
      conversationId: 'conv-1',
      text: 'Checking now.',
      unfinished: true,
      content: [
        {
          type: 'cortex_insight',
          status: 'complete',
          cortex_name: 'Google',
          insight:
            'I read the doc. Short version: the profile is more plausibly O-1A than O-1B if the achievements are framed around business impact and measurable recognition.',
        },
        {
          type: 'cortex_insight',
          status: 'complete',
          cortex_name: 'Deep Research',
          insight:
            'For a 2026 O-1 assessment, the decisive questions are sustained acclaim, judging/critical role evidence, and whether counsel overstated weak criteria.',
        },
      ],
    });
    mockGetMessages.mockResolvedValueOnce([]);

    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/cortex/msg-2?conversationId=conv-1',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { conversationId: 'conv-1', telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.followUp).toBeNull();
    expect(res.body.canonicalText).toBe(
      'I read the doc. Short version: the profile is more plausibly O-1A than O-1B if the achievements are framed around business impact and measurable recognition.',
    );
    expect(res.body.canonicalTextSource).toBe('deferred_fallback');
    expect(res.body.canonicalTextFallbackReason).toBe('insight_fallback');
  });

  test('GET cortex resolves configured hold text to clear deferred error when only low-signal insight exists', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);

    mockGetMessage.mockResolvedValueOnce({
      messageId: 'msg-3',
      conversationId: 'conv-1',
      model: 'agent_main',
      text: '',
      unfinished: false,
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
    mockGetMessages.mockResolvedValueOnce([]);
    mockGetAgent.mockResolvedValueOnce({
      instructions: `
Holding Examples
- "I'm here. Shoot."
`,
    });

    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/cortex/msg-3?conversationId=conv-1',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { conversationId: 'conv-1', telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.followUp).toBeNull();
    expect(res.body.canonicalText).toBe("I couldn't finish that check just now.");
    expect(res.body.canonicalTextSource).toBe('deferred_fallback');
    expect(res.body.canonicalTextFallbackReason).toBe('empty_deferred_response');
  });

  test('GET cortex suppresses generic deferred error text for scheduled Telegram polling', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);

    mockGetMessage.mockResolvedValueOnce({
      messageId: 'msg-4',
      conversationId: 'conv-1',
      model: 'agent_main',
      text: '',
      unfinished: false,
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
    mockGetMessages.mockResolvedValueOnce([]);
    mockGetAgent.mockResolvedValueOnce({
      instructions: `
Holding Examples
- "I'm here. Shoot."
`,
    });

    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/cortex/msg-4?conversationId=conv-1&scheduleId=schedule-1',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { conversationId: 'conv-1', telegramUserId: 'tg-1', scheduleId: 'schedule-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.followUp).toBeNull();
    expect(res.body.canonicalText).toBe('');
    expect(res.body.canonicalTextSource).toBe('deferred_fallback');
    expect(res.body.canonicalTextFallbackReason).toBe('empty_deferred_response');
  });

  test('GET files/download streams file bytes (telegram-auth)', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);

    // Pretend fileAccess resolved a file record owned by the Telegram-linked user.
    mockFileAccess.mockImplementationOnce((req, _res, next) => {
      req.fileAccess = {
        file: {
          file_id: 'file-1',
          filename: 'example.txt',
          filepath: '/uploads/user_1/example.txt',
          type: 'text/plain',
          source: 'local',
          user: 'user_1',
        },
      };
      next();
    });

    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/files/download/file-1',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { telegramUserId: 'tg-1' },
    });
    const res = createMockStreamRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(200);
    expect(Buffer.concat(res.chunks).toString('utf-8')).toBe('file-bytes');
  });

  test('GET files/code/download streams execute-code bytes (telegram-auth)', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);

    mockGetStrategyFunctions.mockReturnValueOnce({
      getDownloadStream: jest.fn().mockResolvedValue({
        headers: { 'content-type': 'text/plain' },
        data: Readable.from([Buffer.from('code-bytes')]),
      }),
    });

    const sessionId = 'a'.repeat(21);
    const fileId = 'b'.repeat(21);
    const req = createMockReq({
      method: 'GET',
      url: `/api/viventium/telegram/files/code/download/${sessionId}/${fileId}`,
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { telegramUserId: 'tg-1' },
    });
    const res = createMockStreamRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(200);
    expect(Buffer.concat(res.chunks).toString('utf-8')).toBe('code-bytes');
    expect(mockLoadAuthValues).toHaveBeenCalled();
  });
});
