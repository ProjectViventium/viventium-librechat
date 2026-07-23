/* === VIVENTIUM START ===
 * Feature: Generic gateway route tests (/api/viventium/gateway)
 * Added: 2026-02-19
 * === VIVENTIUM END === */

const crypto = require('crypto');
const express = require('express');
const { Readable } = require('stream');
const { EventEmitter } = require('events');

let lastAgentId = null;
let lastStreamId = null;
let lastParentMessageId = null;
let lastSpec = null;
let lastGatewayImages = null;

let mockSubscribe;
let mockGetJob;
let mockGetResumeState;
let mockGetMessages;
let mockGetMessage;
let mockGetConvo;
let mockGetAgent;
let mockGatewayMappingFindOne;
let mockGatewayMappingUpdateOne;
let mockGatewayLinkTokenCreate;
let mockGatewayIngressCreate;
let mockGatewayIngressDeleteOne;
let mockGatewayIngressFindOne;
let mockGatewayIngressFindOneAndUpdate;
let mockGatewayIngressUpdateOne;
let mockTelegramLinkTokenFindOneAndUpdate;
let mockTelegramMappingFindOne;
let mockTelegramMappingUpdateOne;
let mockFileAccess;
let mockGetStrategyFunctions;
let mockLoadAuthValues;
let mockFilterFile;
let mockProcessAgentFileUpload;

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
  lastGatewayImages = req._gatewayImages || null;
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

jest.mock('~/server/services/Files/images', () => ({
  resizeImageBuffer: jest.fn(async (buffer) => ({
    buffer,
    bytes: buffer.length,
    width: 1,
    height: 1,
  })),
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

jest.mock('~/models/Agent', () => ({
  getAgent: (...args) => mockGetAgent(...args),
}));

jest.mock('@librechat/api', () => ({
  normalizeChannelEnvelope: (input) => ({
    externalUsername: '',
    externalThreadId: '',
    externalMessageId: '',
    externalUpdateId: '',
    inputMode: 'text',
    audioRequested: false,
    attachments: [],
    ...input,
  }),
  buildChannelAgentRequest: ({ envelope, resolved }) => ({
    text: envelope.text,
    endpoint: 'agents',
    endpointType: 'agents',
    conversationId: resolved.conversationId,
    parentMessageId: resolved.parentMessageId,
    agent_id: resolved.agentId,
    streamId: resolved.streamId,
    files: resolved.files || [],
    channel: envelope.channel,
    accountId: envelope.accountId,
    externalUserId: envelope.externalUserId,
    externalConversationId: envelope.externalConversationId,
    externalThreadId: envelope.externalThreadId,
    externalMessageId: envelope.externalMessageId,
    externalUpdateId: envelope.externalUpdateId,
    viventiumSurface: envelope.channel,
    viventiumInputMode: envelope.inputMode,
    ...(resolved.spec ? { spec: resolved.spec } : {}),
  }),
  GenerationJobManager: {
    getJob: (...args) => mockGetJob(...args),
    getResumeState: (...args) => mockGetResumeState(...args),
    subscribe: (...args) => mockSubscribe(...args),
  },
  isEnabled: () => false,
}));

jest.mock('~/db/models', () => ({
  User: {
    findOne: jest.fn(),
    countDocuments: jest.fn().mockResolvedValue(0),
  },
  GatewayUserMapping: {
    findOne: (...args) => mockGatewayMappingFindOne(...args),
    updateOne: (...args) => mockGatewayMappingUpdateOne(...args),
    findOneAndUpdate: jest.fn(),
  },
  GatewayLinkToken: {
    create: (...args) => mockGatewayLinkTokenCreate(...args),
    findOneAndUpdate: (...args) => mockTelegramLinkTokenFindOneAndUpdate(...args),
  },
  ViventiumGatewayIngressEvent: {
    create: (...args) => mockGatewayIngressCreate(...args),
    deleteOne: (...args) => mockGatewayIngressDeleteOne(...args),
    findOne: (...args) => mockGatewayIngressFindOne(...args),
    findOneAndUpdate: (...args) => mockGatewayIngressFindOneAndUpdate(...args),
    updateOne: (...args) => mockGatewayIngressUpdateOne(...args),
  },
  TelegramUserMapping: {
    findOne: (...args) => mockTelegramMappingFindOne(...args),
    updateOne: (...args) => mockTelegramMappingUpdateOne(...args),
    findOneAndUpdate: jest.fn(),
  },
  TelegramLinkToken: {
    create: jest.fn(),
    findOneAndUpdate: jest.fn(),
  },
}));

function createTestApp(router) {
  const app = express();
  app.use('/api/viventium/gateway', router);
  return app;
}

function createMockReq({ method = 'POST', url, headers = {}, body = {}, query = {} } = {}) {
  const normalized = {};
  Object.entries(headers).forEach(([key, value]) => {
    normalized[key.toLowerCase()] = value;
  });
  let path = url.split('?')[0];
  const basePrefix = '/api/viventium/gateway';
  if (path.startsWith(basePrefix)) {
    path = path.slice(basePrefix.length) || '/';
  }

  return {
    method,
    url,
    originalUrl: url,
    path,
    baseUrl: basePrefix,
    headers: normalized,
    body,
    query,
    protocol: 'http',
    get(name) {
      return normalized[name.toLowerCase()] || '';
    },
    on: jest.fn(),
  };
}

function createMockRes() {
  const emitter = new EventEmitter();
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
    once: emitter.once.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
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
    end: jest.fn(() => {
      res.writableEnded = true;
      if (res._resolve) {
        res._resolve();
      }
    }),
    send: jest.fn((payload) => {
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
    send: jest.fn((payload) => {
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

function signedGatewayHeaders({
  secret,
  method,
  path,
  body,
  timestamp = Math.floor(Date.now() / 1000).toString(),
  nonce = `nonce-${crypto.randomUUID()}`,
}) {
  const bodyHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(body && typeof body === 'object' ? body : {}))
    .digest('hex');
  const canonical = [timestamp, nonce, method.toUpperCase(), path, bodyHash].join('.');
  const signature = crypto.createHmac('sha256', secret).update(canonical).digest('hex');

  return {
    'x-viventium-gateway-secret': secret,
    'x-viventium-gateway-timestamp': timestamp,
    'x-viventium-gateway-nonce': nonce,
    'x-viventium-gateway-signature': signature,
  };
}

describe('/api/viventium/gateway', () => {
  beforeEach(() => {
    lastAgentId = null;
    lastStreamId = null;
    lastParentMessageId = null;
    lastSpec = null;
    lastGatewayImages = null;

    jest.resetModules();

    mockSubscribe = jest.fn();
    mockGetJob = jest.fn().mockResolvedValue({ status: 'running', metadata: { userId: 'user_1' } });
    mockGetResumeState = jest.fn().mockResolvedValue(null);
    mockGetMessages = jest.fn().mockResolvedValue([]);
    mockGetMessage = jest.fn().mockResolvedValue(null);
    mockGetConvo = jest.fn().mockResolvedValue(null);
    mockGetAgent = jest.fn().mockResolvedValue({ avatar: { filepath: '/images/viventium.png' } });

    mockGatewayMappingFindOne = jest.fn().mockReturnValue({
      lean: async () => ({ libreChatUserId: 'user_1' }),
    });
    mockGatewayMappingUpdateOne = jest.fn().mockResolvedValue({});
    mockGatewayLinkTokenCreate = jest.fn().mockResolvedValue({});
    mockGatewayIngressCreate = jest.fn().mockResolvedValue({ _id: 'ingress_1' });
    mockGatewayIngressDeleteOne = jest.fn().mockResolvedValue({});
    mockGatewayIngressFindOne = jest.fn().mockReturnValue({
      lean: async () => ({
        _id: 'ingress-existing',
        ownerToken: 'owner-existing',
        state: 'in_flight',
        leaseExpiresAt: new Date(Date.now() + 60_000),
        streamId: 'gateway-discord-existing',
        conversationId: 'conv-existing',
        libreChatUserId: 'user_1',
        bindingVersion: '',
      }),
    });
    mockGatewayIngressFindOneAndUpdate = jest.fn().mockResolvedValue({ _id: 'ingress-existing' });
    mockGatewayIngressUpdateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });

    mockTelegramLinkTokenFindOneAndUpdate = jest.fn().mockResolvedValue(null);
    mockTelegramMappingFindOne = jest
      .fn()
      .mockReturnValue({ lean: async () => ({ libreChatUserId: 'user_1' }) });
    mockTelegramMappingUpdateOne = jest.fn().mockResolvedValue({});

    mockFileAccess = jest.fn((_req, _res, next) => next());
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

    process.env.VIVENTIUM_GATEWAY_SECRET = 'gateway_secret';
    process.env.VIVENTIUM_GATEWAY_REQUIRE_SIGNATURE = 'true';
    process.env.DOMAIN_SERVER = 'http://example.com';
  });

  test('POST rejects missing secret/signature', async () => {
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const req = createMockReq({
      url: '/api/viventium/gateway/chat',
      body: { text: 'hi', conversationId: 'new' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(401);
  });

  test.each(['gateway_secrex', 'short'])(
    'POST rejects a correctly signed request with wrong shared secret %s',
    async (providedSecret) => {
      const gatewayRouter = require('../gateway');
      const app = createTestApp(gatewayRouter);
      const body = {
        text: 'hi',
        conversationId: 'new',
        channel: 'telegram',
        externalUserId: 'synthetic-user',
      };
      const req = createMockReq({
        url: '/api/viventium/gateway/chat',
        headers: signedGatewayHeaders({
          secret: providedSecret,
          method: 'POST',
          path: '/api/viventium/gateway/chat',
          body,
        }),
        body,
      });
      const res = createMockRes();

      await dispatch(app, req, res);
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized gateway request' });
    },
  );

  test('POST rejects invalid signature', async () => {
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const body = {
      text: 'hi',
      conversationId: 'new',
      channel: 'discord',
      externalUserId: 'user-1',
    };
    const headers = {
      ...signedGatewayHeaders({
        secret: 'gateway_secret',
        method: 'POST',
        path: '/api/viventium/gateway/chat',
        body,
      }),
      'x-viventium-gateway-signature': 'invalid',
    };
    const req = createMockReq({
      url: '/api/viventium/gateway/chat',
      headers,
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(401);
  });

  test('POST uses default agent when none supplied', async () => {
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const body = {
      text: 'hi',
      conversationId: 'new',
      channel: 'discord',
      accountId: 'acct-1',
      externalUserId: 'ext-1',
    };
    const headers = signedGatewayHeaders({
      secret: 'gateway_secret',
      method: 'POST',
      path: '/api/viventium/gateway/chat',
      body,
    });
    const req = createMockReq({
      url: '/api/viventium/gateway/chat',
      headers,
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.streamId).toBe('stream_1');
    expect(lastAgentId).toBe('agent_default');
    expect(typeof lastStreamId).toBe('string');
    expect(lastStreamId.startsWith('gateway-discord-')).toBe(true);
  });

  test('POST suppresses duplicate ingress replay with no-op response', async () => {
    const duplicateError = new Error('duplicate key');
    duplicateError.code = 11000;
    mockGatewayIngressCreate
      .mockResolvedValueOnce({ _id: 'ingress_1' })
      .mockRejectedValueOnce(duplicateError);

    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);

    const body = {
      text: 'hi',
      conversationId: 'new',
      channel: 'discord',
      accountId: 'acct-1',
      externalUserId: 'ext-1',
      externalChatId: 'chat-1',
      externalMessageId: '42',
      externalUpdateId: '99',
    };

    const firstHeaders = signedGatewayHeaders({
      secret: 'gateway_secret',
      method: 'POST',
      path: '/api/viventium/gateway/chat',
      body,
      nonce: 'nonce-first',
    });

    const firstReq = createMockReq({
      url: '/api/viventium/gateway/chat',
      headers: firstHeaders,
      body,
    });
    const firstRes = createMockRes();
    await dispatch(app, firstReq, firstRes);

    expect(firstRes.statusCode).toBe(200);
    expect(firstRes.body.streamId).toBe('stream_1');

    lastStreamId = null;

    const secondHeaders = signedGatewayHeaders({
      secret: 'gateway_secret',
      method: 'POST',
      path: '/api/viventium/gateway/chat',
      body,
      nonce: 'nonce-second',
    });

    const secondReq = createMockReq({
      url: '/api/viventium/gateway/chat',
      headers: secondHeaders,
      body,
    });
    const secondRes = createMockRes();
    await dispatch(app, secondReq, secondRes);

    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.body.duplicate).toBe(true);
    expect(secondRes.body.streamId).toBe('gateway-discord-existing');
    expect(secondRes.body.conversationId).toBe('conv-existing');
    expect(lastStreamId).toBeNull();
  });

  test('POST atomically reclaims a stale ingress whose assigned job disappeared', async () => {
    const duplicateError = Object.assign(new Error('duplicate key'), { code: 11000 });
    mockGatewayIngressCreate.mockRejectedValueOnce(duplicateError);
    mockGatewayIngressFindOne.mockReturnValueOnce({
      lean: async () => ({
        _id: 'ingress-stale',
        ownerToken: 'owner-stale',
        state: 'in_flight',
        leaseExpiresAt: new Date(0),
        streamId: 'gateway-discord-missing',
        conversationId: 'new',
        libreChatUserId: 'user_1',
        bindingVersion: '',
      }),
    });
    mockGetJob.mockResolvedValueOnce(null);
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const body = {
      text: 'retry after crash',
      conversationId: 'new',
      channel: 'discord',
      accountId: 'acct-1',
      externalUserId: 'ext-1',
      externalChatId: 'chat-1',
      externalMessageId: 'stale-1',
    };
    const req = createMockReq({
      url: '/api/viventium/gateway/chat',
      body,
      headers: signedGatewayHeaders({
        secret: 'gateway_secret',
        method: 'POST',
        path: '/api/viventium/gateway/chat',
        body,
      }),
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.duplicate).not.toBe(true);
    expect(lastStreamId).toMatch(/^gateway-discord-/);
    expect(mockGatewayIngressFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: expect.any(String), ownerToken: 'owner-stale' }),
      expect.any(Object),
      { new: true },
    );
  });

  test('POST reclaims a duplicate with an error job', async () => {
    const duplicateError = Object.assign(new Error('duplicate key'), { code: 11000 });
    mockGatewayIngressCreate.mockRejectedValueOnce(duplicateError);
    mockGetJob.mockResolvedValueOnce({ status: 'error', error: 'synthetic failure' });
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const body = {
      text: 'retry terminal failure',
      conversationId: 'new',
      channel: 'discord',
      externalUserId: 'ext-1',
      externalMessageId: 'terminal-error',
    };
    const req = createMockReq({
      url: '/api/viventium/gateway/chat',
      body,
      headers: signedGatewayHeaders({
        secret: 'gateway_secret',
        method: 'POST',
        path: '/api/viventium/gateway/chat',
        body,
      }),
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.body.duplicate).not.toBe(true);
    expect(lastStreamId).toMatch(/^gateway-discord-/);
    expect(mockGatewayIngressFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  test('POST preserves a completed empty job instead of repeating its Agent turn', async () => {
    const duplicateError = Object.assign(new Error('duplicate key'), { code: 11000 });
    mockGatewayIngressCreate.mockRejectedValueOnce(duplicateError);
    mockGetJob.mockResolvedValueOnce({ status: 'complete', finalEvent: { data: {} } });
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const body = {
      text: 'same completed event',
      conversationId: 'new',
      channel: 'discord',
      externalUserId: 'ext-1',
      externalMessageId: 'terminal-empty',
    };
    const req = createMockReq({
      url: '/api/viventium/gateway/chat',
      body,
      headers: signedGatewayHeaders({
        secret: 'gateway_secret',
        method: 'POST',
        path: '/api/viventium/gateway/chat',
        body,
      }),
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.body).toMatchObject({ duplicate: true, streamId: 'gateway-discord-existing' });
    expect(lastStreamId).toBeNull();
    expect(mockGatewayIngressFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('POST preserves a legacy terminal-empty reservation instead of repeating its Agent turn', async () => {
    const duplicateError = Object.assign(new Error('duplicate key'), { code: 11000 });
    mockGatewayIngressCreate.mockRejectedValueOnce(duplicateError);
    mockGatewayIngressFindOne.mockReturnValueOnce({
      lean: async () => ({
        _id: 'legacy-empty',
        ownerToken: 'owner-legacy',
        state: 'failed',
        failureCode: 'terminal_empty',
        leaseExpiresAt: new Date(0),
        streamId: 'gateway-discord-legacy-empty',
        conversationId: 'conv-empty',
        libreChatUserId: 'user_1',
        bindingVersion: '',
      }),
    });
    mockGetJob.mockResolvedValueOnce(null);
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const body = {
      text: 'same legacy event',
      conversationId: 'new',
      channel: 'discord',
      externalUserId: 'ext-1',
      externalMessageId: 'legacy-terminal-empty',
    };
    const req = createMockReq({
      url: '/api/viventium/gateway/chat',
      body,
      headers: signedGatewayHeaders({
        secret: 'gateway_secret',
        method: 'POST',
        path: '/api/viventium/gateway/chat',
        body,
      }),
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.body).toMatchObject({
      duplicate: true,
      streamId: 'gateway-discord-legacy-empty',
      conversationId: 'conv-empty',
    });
    expect(lastStreamId).toBeNull();
    expect(mockGatewayIngressFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('POST replays a completed reservation after job eviction without starting another Agent turn', async () => {
    const duplicateError = Object.assign(new Error('duplicate key'), { code: 11000 });
    mockGatewayIngressCreate.mockRejectedValueOnce(duplicateError);
    mockGatewayIngressFindOne.mockReturnValueOnce({
      lean: async () => ({
        _id: 'ingress-complete',
        ownerToken: 'owner-complete',
        state: 'completed',
        leaseExpiresAt: new Date(0),
        streamId: 'gateway-discord-complete',
        conversationId: 'conv-complete',
        finalText: 'persisted answer',
        libreChatUserId: 'user_1',
        bindingVersion: '',
      }),
    });
    mockGetJob.mockResolvedValueOnce(null);
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const body = {
      text: 'same event',
      conversationId: 'new',
      channel: 'discord',
      externalUserId: 'ext-1',
      externalMessageId: 'completed-1',
    };
    const req = createMockReq({
      url: '/api/viventium/gateway/chat',
      body,
      headers: signedGatewayHeaders({
        secret: 'gateway_secret',
        method: 'POST',
        path: '/api/viventium/gateway/chat',
        body,
      }),
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.body).toMatchObject({
      duplicate: true,
      streamId: 'gateway-discord-complete',
      conversationId: 'conv-complete',
    });
    expect(lastStreamId).toBeNull();
    expect(mockGatewayIngressFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('POST refuses a persisted completion after the external identity is re-paired', async () => {
    const duplicateError = Object.assign(new Error('duplicate key'), { code: 11000 });
    mockGatewayIngressCreate.mockRejectedValueOnce(duplicateError);
    mockGatewayIngressFindOne.mockReturnValueOnce({
      lean: async () => ({
        state: 'completed',
        leaseExpiresAt: new Date(0),
        streamId: 'stream-for-user-a',
        finalText: 'private answer for A',
        libreChatUserId: 'user_A',
        bindingVersion: 'binding-A',
      }),
    });
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const body = {
      text: 'same event',
      conversationId: 'new',
      channel: 'discord',
      externalUserId: 'ext-1',
      externalMessageId: 'repaired-1',
    };
    const req = createMockReq({
      url: '/api/viventium/gateway/chat',
      body,
      headers: signedGatewayHeaders({
        secret: 'gateway_secret',
        method: 'POST',
        path: '/api/viventium/gateway/chat',
        body,
      }),
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'channel_binding_changed' });
    expect(lastStreamId).toBeNull();
  });

  test('POST fails closed for a legacy duplicate that has no stored user binding', async () => {
    const duplicateError = Object.assign(new Error('duplicate key'), { code: 11000 });
    mockGatewayIngressCreate.mockRejectedValueOnce(duplicateError);
    mockGatewayIngressFindOne.mockReturnValueOnce({
      lean: async () => ({
        state: 'completed',
        streamId: 'legacy-stream',
        finalText: 'legacy private answer',
        leaseExpiresAt: new Date(0),
      }),
    });
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const body = {
      text: 'legacy retry',
      conversationId: 'new',
      channel: 'discord',
      externalUserId: 'ext-1',
      externalMessageId: 'legacy-ownerless-1',
    };
    const req = createMockReq({
      url: '/api/viventium/gateway/chat',
      body,
      headers: signedGatewayHeaders({
        secret: 'gateway_secret',
        method: 'POST',
        path: '/api/viventium/gateway/chat',
        body,
      }),
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'channel_binding_changed' });
    expect(lastStreamId).toBeNull();
  });

  test('POST does not start an Agent turn after losing stream-assignment ownership', async () => {
    mockGatewayIngressUpdateOne.mockResolvedValueOnce({ matchedCount: 0 });
    mockGatewayIngressFindOne.mockReturnValueOnce({
      lean: async () => ({
        streamId: 'winner-stream',
        conversationId: 'winner-conversation',
        libreChatUserId: 'user_1',
        bindingVersion: '',
      }),
    });
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const body = {
      text: 'ownership race',
      conversationId: 'new',
      channel: 'discord',
      externalUserId: 'ext-1',
      externalMessageId: 'ownership-1',
    };
    const req = createMockReq({
      url: '/api/viventium/gateway/chat',
      body,
      headers: signedGatewayHeaders({
        secret: 'gateway_secret',
        method: 'POST',
        path: '/api/viventium/gateway/chat',
        body,
      }),
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.body).toEqual({
      duplicate: true,
      streamId: 'winner-stream',
      conversationId: 'winner-conversation',
    });
    expect(lastStreamId).toBeNull();
  });

  test('POST refuses an assignment winner owned by a different channel binding', async () => {
    mockGatewayIngressUpdateOne.mockResolvedValueOnce({ matchedCount: 0 });
    mockGatewayIngressFindOne.mockReturnValueOnce({
      lean: async () => ({
        streamId: 'winner-for-a',
        conversationId: 'conversation-for-a',
        libreChatUserId: 'user_A',
        bindingVersion: 'binding-A',
      }),
    });
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const body = {
      text: 'ownership mismatch',
      conversationId: 'new',
      channel: 'discord',
      externalUserId: 'ext-1',
      externalMessageId: 'ownership-mismatch-1',
    };
    const req = createMockReq({
      url: '/api/viventium/gateway/chat',
      body,
      headers: signedGatewayHeaders({
        secret: 'gateway_secret',
        method: 'POST',
        path: '/api/viventium/gateway/chat',
        body,
      }),
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'channel_binding_changed' });
    expect(lastStreamId).toBeNull();
  });

  test('POST keeps a completion that wins between stale read and reclaim CAS', async () => {
    const duplicateError = Object.assign(new Error('duplicate key'), { code: 11000 });
    mockGatewayIngressCreate.mockRejectedValueOnce(duplicateError);
    mockGetJob.mockResolvedValueOnce(null);
    mockGatewayIngressFindOne
      .mockReturnValueOnce({
        lean: async () => ({
          ownerToken: 'same-owner',
          state: 'in_flight',
          leaseExpiresAt: new Date(0),
          streamId: 'old-stream',
          conversationId: 'old-conversation',
          libreChatUserId: 'user_1',
          bindingVersion: '',
        }),
      })
      .mockReturnValueOnce({
        lean: async () => ({
          ownerToken: 'same-owner',
          state: 'completed',
          streamId: 'old-stream',
          conversationId: 'completed-conversation',
          finalText: 'completed while reclaiming',
          libreChatUserId: 'user_1',
          bindingVersion: '',
        }),
      });
    mockGatewayIngressFindOneAndUpdate.mockResolvedValueOnce(null);
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const body = {
      text: 'race',
      conversationId: 'new',
      channel: 'discord',
      externalUserId: 'ext-1',
      externalMessageId: 'race-1',
    };
    const req = createMockReq({
      url: '/api/viventium/gateway/chat',
      body,
      headers: signedGatewayHeaders({
        secret: 'gateway_secret',
        method: 'POST',
        path: '/api/viventium/gateway/chat',
        body,
      }),
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.body).toMatchObject({ duplicate: true, conversationId: 'completed-conversation' });
    expect(lastStreamId).toBeNull();
  });

  test('POST new convo sets parentMessageId to NO_PARENT', async () => {
    const { Constants } = require('librechat-data-provider');
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const body = {
      text: 'hi',
      conversationId: 'new',
      channel: 'discord',
      externalUserId: 'ext-1',
    };
    const headers = signedGatewayHeaders({
      secret: 'gateway_secret',
      method: 'POST',
      path: '/api/viventium/gateway/chat',
      body,
    });
    const req = createMockReq({
      url: '/api/viventium/gateway/chat',
      headers,
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(200);
    expect(lastParentMessageId).toBe(Constants.NO_PARENT);
  });

  test('POST existing convo resolves parentMessageId from the latest leaf', async () => {
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    mockGetConvo.mockResolvedValueOnce({ conversationId: 'conv-1', endpoint: 'agents' });
    mockGetMessages.mockResolvedValueOnce([
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

    const body = {
      text: 'check outlook',
      conversationId: 'conv-1',
      channel: 'discord',
      externalUserId: 'ext-1',
    };
    const headers = signedGatewayHeaders({
      secret: 'gateway_secret',
      method: 'POST',
      path: '/api/viventium/gateway/chat',
      body,
    });
    const req = createMockReq({
      url: '/api/viventium/gateway/chat',
      headers,
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(lastParentMessageId).toBe('assistant-leaf');
  });

  test('POST fails closed when an attachment cannot be processed into raw provider upload or readable context', async () => {
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    mockProcessAgentFileUpload.mockRejectedValueOnce(
      new Error(
        `Unsupported message attachment type application/zip. This file can't be sent provider-natively or extracted as readable text on this surface.`,
      ),
    );
    const body = {
      text: 'review this',
      conversationId: 'new',
      channel: 'discord',
      accountId: 'acct-1',
      externalUserId: 'ext-1',
      attachments: [
        {
          filename: 'archive.zip',
          mime_type: 'application/zip',
          data: Buffer.from('zip-bytes').toString('base64'),
        },
      ],
    };
    const headers = signedGatewayHeaders({
      secret: 'gateway_secret',
      method: 'POST',
      path: '/api/viventium/gateway/chat',
      body,
    });
    const req = createMockReq({
      url: '/api/viventium/gateway/chat',
      headers,
      body,
    });
    const res = createMockRes();

    await expect(dispatch(app, req, res)).rejects.toThrow(
      /Gateway attachment upload failed for "archive\.zip"/,
    );
  });

  test('POST injects extracted document images from file uploads into the vision payload', async () => {
    const gatewayRouter = require('../gateway');
    const { resizeImageBuffer } = require('~/server/services/Files/images');
    const app = createTestApp(gatewayRouter);
    mockProcessAgentFileUpload.mockImplementationOnce(async ({ req, res, metadata }) => {
      res.status(200).json({
        message: 'Agent file uploaded and processed successfully',
        file_id: metadata.file_id,
        temp_file_id: metadata.temp_file_id,
        filename: req.file?.originalname ?? 'deck.pptx',
        filepath: '/uploads/mock/deck.pptx',
        type: req.file?.mimetype,
        source: 'text',
        viventiumExtractedImages: ['data:image/png;base64,cG5n'],
      });
    });
    const body = {
      text: 'review this deck',
      conversationId: 'new',
      channel: 'discord',
      accountId: 'acct-1',
      externalUserId: 'ext-1',
      attachments: [
        {
          filename: 'deck.pptx',
          mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          data: Buffer.from('pptx-bytes').toString('base64'),
        },
      ],
    };
    const headers = signedGatewayHeaders({
      secret: 'gateway_secret',
      method: 'POST',
      path: '/api/viventium/gateway/chat',
      body,
    });
    const req = createMockReq({
      url: '/api/viventium/gateway/chat',
      headers,
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(resizeImageBuffer).toHaveBeenCalledTimes(1);
    expect(resizeImageBuffer.mock.calls[0][1]).toEqual({ px: 768 });
    expect(lastGatewayImages).toEqual([
      {
        type: 'image_url',
        image_url: {
          url: 'data:image/png;base64,cG5n',
          detail: 'auto',
        },
      },
    ]);
  });

  test('POST new convo persists iconURL spec parity', async () => {
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const body = {
      text: 'hi',
      conversationId: 'new',
      channel: 'discord',
      externalUserId: 'ext-1',
    };
    const headers = signedGatewayHeaders({
      secret: 'gateway_secret',
      method: 'POST',
      path: '/api/viventium/gateway/chat',
      body,
    });
    const req = createMockReq({
      url: '/api/viventium/gateway/chat',
      headers,
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(200);
    expect(lastSpec).toBe('viventium');
  });

  test('POST returns link when external user is unlinked', async () => {
    mockGatewayMappingFindOne.mockReturnValue({
      lean: async () => null,
    });

    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const body = {
      text: 'hi',
      conversationId: 'new',
      channel: 'discord',
      externalUserId: 'ext-1',
    };
    const headers = signedGatewayHeaders({
      secret: 'gateway_secret',
      method: 'POST',
      path: '/api/viventium/gateway/chat',
      body,
    });
    const req = createMockReq({
      url: '/api/viventium/gateway/chat',
      headers,
      body,
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.linkRequired).toBe(true);
    expect(res.body.linkUrl).toContain('/api/viventium/gateway/link/');
  });

  test('GET stream emits attachment and done SSE events', async () => {
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);

    mockSubscribe.mockImplementation(async (_streamId, onChunk, onDone) => {
      onChunk({ event: 'attachment', data: { file_id: 'file-1', filename: 'artifact.png' } });
      onChunk({
        event: 'on_message_delta',
        data: { delta: { content: [{ type: 'text', text: 'hello' }] } },
      });
      onDone({ final: true, responseMessage: { messageId: 'msg-1', text: 'world' } });
      return { unsubscribe: jest.fn() };
    });

    const query = {
      channel: 'discord',
      accountId: 'acct-1',
      externalUserId: 'ext-1',
    };
    const headers = signedGatewayHeaders({
      secret: 'gateway_secret',
      method: 'GET',
      path: '/api/viventium/gateway/stream/stream_1',
      body: {},
    });

    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/gateway/stream/stream_1?channel=discord&accountId=acct-1&externalUserId=ext-1',
      headers,
      query,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    const writes = res.write.mock.calls.map((call) => String(call[0] || ''));
    expect(writes.some((line) => line.includes('event: attachment'))).toBe(true);
    expect(writes.some((line) => line.includes('event: message'))).toBe(true);
    expect(writes.some((line) => line.includes('event: done'))).toBe(true);
  });

  test('GET stream persists an error-free empty final as completed terminal state', async () => {
    mockSubscribe.mockImplementation(async (_streamId, _onChunk, onDone) => {
      onDone({
        final: true,
        responseMessage: { conversationId: 'conv-empty', files: [{ file_id: 'file-1' }] },
      });
      return { unsubscribe: jest.fn() };
    });
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const query = { channel: 'discord', accountId: 'acct-1', externalUserId: 'ext-1' };
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/gateway/stream/empty-stream?channel=discord&accountId=acct-1&externalUserId=ext-1',
      query,
      headers: signedGatewayHeaders({
        secret: 'gateway_secret',
        method: 'GET',
        path: '/api/viventium/gateway/stream/empty-stream',
        body: {},
      }),
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(mockGatewayIngressUpdateOne).toHaveBeenCalledWith(
      { streamId: 'empty-stream' },
      expect.objectContaining({
        $set: expect.objectContaining({ state: 'completed', finalText: '' }),
      }),
    );
    const writes = res.write.mock.calls.map((call) => String(call[0] || '')).join('');
    expect(writes).toContain('"type":"final"');
    expect(writes).toContain('event: done');
  });

  test('GET stream replays a persisted empty completion after job eviction', async () => {
    mockGetJob.mockResolvedValueOnce(null);
    mockGatewayIngressFindOne.mockReturnValueOnce({
      lean: async () => ({
        state: 'completed',
        finalText: '',
        responseConversationId: 'conv-empty',
        libreChatUserId: 'user_1',
        bindingVersion: '',
      }),
    });
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const query = { channel: 'discord', accountId: 'acct-1', externalUserId: 'ext-1' };
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/gateway/stream/empty-replay?channel=discord&accountId=acct-1&externalUserId=ext-1',
      query,
      headers: signedGatewayHeaders({
        secret: 'gateway_secret',
        method: 'GET',
        path: '/api/viventium/gateway/stream/empty-replay',
        body: {},
      }),
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    const writes = res.write.mock.calls.map((call) => String(call[0] || '')).join('');
    expect(writes).toContain('"type":"final"');
    expect(writes).toContain('event: done');
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  test('GET stream replays a legacy terminal-empty completion after job eviction', async () => {
    mockGetJob.mockResolvedValueOnce(null);
    mockGatewayIngressFindOne.mockReturnValueOnce({
      lean: async () => ({
        state: 'failed',
        failureCode: 'terminal_empty',
        finalText: null,
        responseConversationId: 'conv-empty',
        libreChatUserId: 'user_1',
        bindingVersion: '',
      }),
    });
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const query = { channel: 'discord', accountId: 'acct-1', externalUserId: 'ext-1' };
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/gateway/stream/legacy-empty?channel=discord&accountId=acct-1&externalUserId=ext-1',
      query,
      headers: signedGatewayHeaders({
        secret: 'gateway_secret',
        method: 'GET',
        path: '/api/viventium/gateway/stream/legacy-empty',
        body: {},
      }),
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    const writes = res.write.mock.calls.map((call) => String(call[0] || '')).join('');
    expect(writes).toContain('"type":"final"');
    expect(writes).toContain('event: done');
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  test('GET stream replays a persisted completion after the generation job is evicted', async () => {
    mockGetJob.mockResolvedValueOnce(null);
    mockGatewayIngressFindOne.mockReturnValueOnce({
      lean: async () => ({
        state: 'completed',
        finalText: 'persisted final answer',
        responseMessageId: 'msg-final',
        responseConversationId: 'conv-final',
        libreChatUserId: 'user_1',
        bindingVersion: '',
      }),
    });
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const query = { channel: 'discord', accountId: 'acct-1', externalUserId: 'ext-1' };
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/gateway/stream/completed-stream?channel=discord&accountId=acct-1&externalUserId=ext-1',
      query,
      headers: signedGatewayHeaders({
        secret: 'gateway_secret',
        method: 'GET',
        path: '/api/viventium/gateway/stream/completed-stream',
        body: {},
      }),
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    const writes = res.write.mock.calls.map((call) => String(call[0] || '')).join('');
    expect(writes).toContain('persisted final answer');
    expect(writes).toContain('event: done');
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  test('GET stream refuses a persisted completion without the current user binding', async () => {
    mockGetJob.mockResolvedValueOnce(null);
    mockGatewayIngressFindOne.mockReturnValueOnce({
      lean: async () => ({
        state: 'completed',
        finalText: 'legacy private answer',
        responseConversationId: 'conv-private',
      }),
    });
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const query = { channel: 'discord', accountId: 'acct-1', externalUserId: 'ext-1' };
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/gateway/stream/legacy-stream?channel=discord&accountId=acct-1&externalUserId=ext-1',
      query,
      headers: signedGatewayHeaders({
        secret: 'gateway_secret',
        method: 'GET',
        path: '/api/viventium/gateway/stream/legacy-stream',
        body: {},
      }),
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'channel_binding_changed' });
    expect(res.write).not.toHaveBeenCalled();
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  test('GET missing stream releases the durable reservation for the next retry', async () => {
    mockGetJob.mockResolvedValueOnce(null);
    mockGatewayIngressFindOne.mockReturnValueOnce({ lean: async () => null });
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const query = { channel: 'discord', accountId: 'acct-1', externalUserId: 'ext-1' };
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/gateway/stream/missing-stream?channel=discord&accountId=acct-1&externalUserId=ext-1',
      query,
      headers: signedGatewayHeaders({
        secret: 'gateway_secret',
        method: 'GET',
        path: '/api/viventium/gateway/stream/missing-stream',
        body: {},
      }),
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(404);
    expect(mockGatewayIngressUpdateOne).toHaveBeenCalledWith(
      { streamId: 'missing-stream' },
      expect.objectContaining({
        $set: expect.objectContaining({ state: 'failed', failureCode: 'job_missing' }),
      }),
    );
  });

  test('does not subscribe when the client closes during resume lookup', async () => {
    let releaseResumeLookup;
    let markResumeLookupStarted;
    const resumeLookupStarted = new Promise((resolve) => {
      markResumeLookupStarted = resolve;
    });
    mockGetResumeState = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseResumeLookup = resolve;
          markResumeLookupStarted();
        }),
    );
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const query = {
      resume: 'true',
      channel: 'discord',
      accountId: 'acct-1',
      externalUserId: 'ext-1',
    };
    const headers = signedGatewayHeaders({
      secret: 'gateway_secret',
      method: 'GET',
      path: '/api/viventium/gateway/stream/closed-during-resume',
      body: {},
    });
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/gateway/stream/closed-during-resume?resume=true&channel=discord&accountId=acct-1&externalUserId=ext-1',
      headers,
      query,
    });
    const res = createMockRes();

    const dispatched = dispatch(app, req, res);
    await resumeLookupStarted;
    res.emit('close');
    releaseResumeLookup({ runSteps: [], aggregatedContent: [] });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(res.write).not.toHaveBeenCalled();
    res._resolve();
    await dispatched;
  });

  test('does not write a subscription error after the client closes during readiness', async () => {
    let releaseSubscription;
    let markSubscriptionStarted;
    const subscriptionStarted = new Promise((resolve) => {
      markSubscriptionStarted = resolve;
    });
    mockSubscribe = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseSubscription = resolve;
          markSubscriptionStarted();
        }),
    );
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);
    const query = {
      channel: 'discord',
      accountId: 'acct-1',
      externalUserId: 'ext-1',
    };
    const headers = signedGatewayHeaders({
      secret: 'gateway_secret',
      method: 'GET',
      path: '/api/viventium/gateway/stream/closed-during-readiness',
      body: {},
    });
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/gateway/stream/closed-during-readiness?channel=discord&accountId=acct-1&externalUserId=ext-1',
      headers,
      query,
    });
    const res = createMockRes();

    const dispatched = dispatch(app, req, res);
    await subscriptionStarted;
    res.emit('close');
    releaseSubscription(null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.write).not.toHaveBeenCalled();
    res._resolve();
    await dispatched;
  });

  test('GET cortex returns follow-up via semantic parent metadata lookup', async () => {
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);

    mockGetMessage.mockResolvedValueOnce({
      messageId: 'msg-1',
      conversationId: 'conv-1',
      text: 'Canonical gateway response',
      content: [{ type: 'cortex_brewing', status: 'brewing' }],
    });
    mockGetMessages.mockResolvedValueOnce([{ messageId: 'follow-1', text: 'Follow-up text' }]);

    const query = {
      channel: 'discord',
      accountId: 'acct-1',
      externalUserId: 'ext-1',
      conversationId: 'conv-1',
    };
    const headers = signedGatewayHeaders({
      secret: 'gateway_secret',
      method: 'GET',
      path: '/api/viventium/gateway/cortex/msg-1',
      body: {},
    });

    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/gateway/cortex/msg-1?channel=discord&accountId=acct-1&externalUserId=ext-1&conversationId=conv-1',
      headers,
      query,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.messageId).toBe('msg-1');
    expect(res.body.followUp.text).toBe('Follow-up text');
    expect(res.body.canonicalText).toBe('Canonical gateway response');
    expect(mockGetMessages).toHaveBeenCalledWith({
      user: 'user_1',
      conversationId: 'conv-1',
      'metadata.viventium.parentMessageId': 'msg-1',
      'metadata.viventium.type': 'cortex_followup',
    });
  });

  test('GET files/download streams file bytes', async () => {
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);

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

    const headers = signedGatewayHeaders({
      secret: 'gateway_secret',
      method: 'GET',
      path: '/api/viventium/gateway/files/download/file-1',
      body: {},
    });

    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/gateway/files/download/file-1',
      headers,
      query: { channel: 'discord', accountId: 'acct-1', externalUserId: 'ext-1' },
    });
    const res = createMockStreamRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(200);
    expect(Buffer.concat(res.chunks).toString('utf-8')).toBe('file-bytes');
  });

  test('GET files/code/download streams execute-code bytes', async () => {
    const gatewayRouter = require('../gateway');
    const app = createTestApp(gatewayRouter);

    mockGetStrategyFunctions.mockReturnValueOnce({
      getDownloadStream: jest.fn().mockResolvedValue({
        headers: { 'content-type': 'text/plain' },
        data: Readable.from([Buffer.from('code-bytes')]),
      }),
    });

    const sessionId = 'a'.repeat(21);
    const fileId = 'b'.repeat(21);
    const headers = signedGatewayHeaders({
      secret: 'gateway_secret',
      method: 'GET',
      path: `/api/viventium/gateway/files/code/download/${sessionId}/${fileId}`,
      body: {},
    });

    const req = createMockReq({
      method: 'GET',
      url: `/api/viventium/gateway/files/code/download/${sessionId}/${fileId}`,
      headers,
      query: { channel: 'discord', accountId: 'acct-1', externalUserId: 'ext-1' },
    });
    const res = createMockStreamRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(200);
    expect(Buffer.concat(res.chunks).toString('utf-8')).toBe('code-bytes');
    expect(mockLoadAuthValues).toHaveBeenCalled();
  });
});
