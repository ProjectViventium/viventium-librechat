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

jest.mock('~/models/Agent', () => ({
  getAgent: (...args) => mockGetAgent(...args),
}));

jest.mock('@librechat/api', () => ({
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

    jest.resetModules();

    mockSubscribe = jest.fn();
    mockGetJob = jest.fn().mockResolvedValue({ metadata: { userId: 'user_1' } });
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

    mockTelegramLinkTokenFindOneAndUpdate = jest.fn().mockResolvedValue(null);
    mockTelegramMappingFindOne = jest.fn().mockReturnValue({ lean: async () => ({ libreChatUserId: 'user_1' }) });
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
    mockGatewayIngressCreate.mockResolvedValueOnce({ _id: 'ingress_1' }).mockRejectedValueOnce(duplicateError);

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
    expect(secondRes.body.streamId).toBe('');
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
      onChunk({ event: 'on_message_delta', data: { delta: { content: [{ type: 'text', text: 'hello' }] } } });
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
