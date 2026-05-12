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
let mockConversationFindOneAndUpdate;
let mockMessageFindOne;
let mockMessageFind;
let mockMessageBulkWrite;
let mockMessageFindOneAndUpdate;
let mockLastParentMessageId = null;
let mockLastConversationId = null;
let mockLastAgentId = null;
let mockLastRequestText = null;
let mockAgentControllerCallCount = 0;
let mockAgentControllerResponseDelayMs = 0;
let mockAgentControllerGeneratedConversationId = null;
let mockClaimGlassHiveDeliveries;
let mockMarkGlassHiveDeliverySent;
let mockMarkGlassHiveDeliveryFailed;
let mockMarkGlassHiveDeliverySuppressed;
let mockObservedInfoLogs;
let mockConsoleLogSpy;

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn((...args) => {
      mockObservedInfoLogs.push(args.map(String).join(' '));
    }),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

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
      conversationId:
        req.body.conversationId === 'new' && mockAgentControllerGeneratedConversationId
          ? mockAgentControllerGeneratedConversationId
          : req.body.conversationId || 'new',
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
  materializeCallSessionConversationId: jest
    .fn()
    .mockImplementation((_callSessionId, conversationId) => Promise.resolve({ conversationId })),
  claimOrReplaceCallSessionConversationId: jest
    .fn()
    .mockImplementation((_callSessionId, conversationId) => Promise.resolve({ conversationId })),
  updateCallSessionConversationId: jest.fn().mockResolvedValue({}),
}));

jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
  getMessages: (...args) => mockGetMessages(...args),
  getConvo: (...args) => mockGetConvo(...args),
}));

jest.mock('~/db/models', () => ({
  Conversation: {
    findOneAndUpdate: (...args) => mockConversationFindOneAndUpdate(...args),
  },
  Message: {
    findOne: (...args) => mockMessageFindOne(...args),
    find: (...args) => mockMessageFind(...args),
    bulkWrite: (...args) => mockMessageBulkWrite(...args),
    findOneAndUpdate: (...args) => mockMessageFindOneAndUpdate(...args),
  },
  ViventiumVoiceIngressEvent: {
    create: (...args) => mockVoiceIngressCreate(...args),
    findOne: (...args) => mockVoiceIngressFindOne(...args),
    findOneAndUpdate: (...args) => mockVoiceIngressFindOneAndUpdate(...args),
  },
}));

jest.mock('~/server/services/viventium/VoiceCortexInsightsService', () => ({
  getCompletedCortexInsightsForMessage: jest.fn(),
}));

jest.mock('~/server/services/viventium/GlassHiveCallbackDeliveryService', () => ({
  claimPendingGlassHiveCallbackDeliveries: (...args) => mockClaimGlassHiveDeliveries(...args),
  markGlassHiveCallbackDeliverySent: (...args) => mockMarkGlassHiveDeliverySent(...args),
  markGlassHiveCallbackDeliveryFailed: (...args) => mockMarkGlassHiveDeliveryFailed(...args),
  markGlassHiveCallbackDeliverySuppressed: (...args) =>
    mockMarkGlassHiveDeliverySuppressed(...args),
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

function createMessageFindOneMock(result = null) {
  const chain = {
    sort: jest.fn(() => chain),
    select: jest.fn(() => chain),
    lean: jest.fn().mockResolvedValue(result),
  };
  const findOne = jest.fn(() => chain);
  findOne.chain = chain;
  return findOne;
}

function createMessageFindMock(result = []) {
  const chain = {
    sort: jest.fn(() => chain),
    select: jest.fn(() => chain),
    lean: jest.fn().mockResolvedValue(result),
  };
  const find = jest.fn(() => chain);
  find.chain = chain;
  return find;
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
    mockObservedInfoLogs = [];
    mockConsoleLogSpy = jest.spyOn(console, 'log').mockImplementation((...args) => {
      mockObservedInfoLogs.push(args.map(String).join(' '));
    });
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
    mockAgentControllerGeneratedConversationId = null;
    mockMessageFindOne = createMessageFindOneMock(null);
    mockMessageFind = createMessageFindMock([]);
    mockMessageBulkWrite = jest.fn().mockResolvedValue({ modifiedCount: 0 });
    mockMessageFindOneAndUpdate = jest.fn().mockResolvedValue({ _id: 'listen_only_msg_oid' });
    mockConversationFindOneAndUpdate = jest
      .fn()
      .mockResolvedValue({ conversationId: 'conv-voice-1' });
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
      listenOnlyModeEnabled: false,
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
    mockClaimGlassHiveDeliveries = jest.fn().mockResolvedValue([]);
    mockMarkGlassHiveDeliverySent = jest.fn().mockResolvedValue({ deliveryId: 'ghcd_voice' });
    mockMarkGlassHiveDeliveryFailed = jest.fn().mockResolvedValue({ deliveryId: 'ghcd_voice' });
    mockMarkGlassHiveDeliverySuppressed = jest.fn().mockResolvedValue({ deliveryId: 'ghcd_voice' });
  });

  afterEach(() => {
    mockConsoleLogSpy?.mockRestore();
    mockConsoleLogSpy = null;
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

  test('updates the call session when a stale concrete conversation resets to new', async () => {
    const {
      updateCallSessionConversationId,
    } = require('~/server/services/viventium/CallSessionService');
    mockAgentControllerGeneratedConversationId = 'conv-generated-voice';
    mockGetConvo = jest.fn().mockResolvedValue({
      conversationId: 'conv-google',
      endpoint: 'google',
      agent_id: 'google__gemini___Gemini',
    });
    mockAssertVoiceGatewayAuth = jest.fn().mockResolvedValue({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      agentId: 'xai__grok-4.3___Grok 4.3',
      conversationId: 'conv-google',
    });

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: { text: 'start the voice call in a usable conversation' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    await Promise.resolve();

    expect(res.statusCode).toBe(200);
    expect(mockLastConversationId).toBe('new');
    expect(updateCallSessionConversationId).toHaveBeenCalledWith(
      'call_session_1',
      'conv-generated-voice',
    );
  });

  test('reuses the generated conversation on the next voice turn after a stale reset', async () => {
    const {
      updateCallSessionConversationId,
    } = require('~/server/services/viventium/CallSessionService');
    let storedConversationId = 'conv-google';
    updateCallSessionConversationId.mockImplementation((_callSessionId, conversationId) => {
      storedConversationId = conversationId;
      return Promise.resolve({ conversationId });
    });
    mockAgentControllerGeneratedConversationId = 'conv-generated-voice';
    mockGetConvo = jest.fn().mockImplementation((_userId, conversationId) => {
      if (conversationId === 'conv-google') {
        return Promise.resolve({
          conversationId: 'conv-google',
          endpoint: 'google',
          agent_id: 'google__gemini___Gemini',
        });
      }
      if (conversationId === 'conv-generated-voice') {
        return Promise.resolve({
          conversationId: 'conv-generated-voice',
          endpoint: 'xai',
          agent_id: 'xai__grok-4.3___Grok 4.3',
        });
      }
      return Promise.resolve(null);
    });
    mockAssertVoiceGatewayAuth = jest.fn().mockImplementation(() =>
      Promise.resolve({
        callSessionId: 'call_session_1',
        userId: 'user_1',
        agentId: 'xai__grok-4.3___Grok 4.3',
        conversationId: storedConversationId,
      }),
    );

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);

    const firstReq = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: { text: 'first turn repairs the stale session pointer' },
    });
    const firstRes = createMockRes();
    await dispatch(app, firstReq, firstRes);
    await Promise.resolve();

    expect(firstRes.statusCode).toBe(200);
    expect(mockLastConversationId).toBe('new');
    expect(storedConversationId).toBe('conv-generated-voice');

    const secondReq = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: { text: 'second turn should continue the repaired conversation' },
    });
    const secondRes = createMockRes();
    await dispatch(app, secondReq, secondRes);

    expect(secondRes.statusCode).toBe(200);
    expect(mockLastConversationId).toBe('conv-generated-voice');
    expect(updateCallSessionConversationId).toHaveBeenCalledTimes(1);
  });

  test('reuses provider-backed voice conversations when the agent_id matches the call session', async () => {
    const {
      updateCallSessionConversationId,
    } = require('~/server/services/viventium/CallSessionService');
    mockGetConvo = jest.fn().mockResolvedValue({
      conversationId: 'conv-xai-voice',
      endpoint: 'xai',
      agent_id: 'xai__grok-4.3___Grok 4.3',
    });
    mockAssertVoiceGatewayAuth = jest.fn().mockResolvedValue({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      agentId: 'xai__grok-4.3___Grok 4.3',
      conversationId: 'conv-xai-voice',
    });

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: { text: 'continue the same provider-backed voice call' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockLastConversationId).toBe('conv-xai-voice');
    expect(mockLastParentMessageId).toBe('voice-assistant-leaf');
    expect(updateCallSessionConversationId).not.toHaveBeenCalled();
  });

  test('does not replace the call session on transient conversation lookup errors', async () => {
    const {
      updateCallSessionConversationId,
    } = require('~/server/services/viventium/CallSessionService');
    mockGetConvo = jest.fn().mockRejectedValue(new Error('temporary lookup failure'));
    mockAssertVoiceGatewayAuth = jest.fn().mockResolvedValue({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      agentId: 'xai__grok-4.3___Grok 4.3',
      conversationId: 'conv-xai-voice',
    });

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: { text: 'continue during a transient lookup failure' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockLastConversationId).toBe('conv-xai-voice');
    expect(updateCallSessionConversationId).not.toHaveBeenCalled();
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
    expect(
      [res1.body.coalesced, res2.body.coalesced, res3.body.coalesced].filter(Boolean),
    ).toHaveLength(2);
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
    const infoText = mockObservedInfoLogs.join('\n');
    expect(infoText).toContain(
      '[VIVENTIUM][voice/chat] user_turn_completed source=route callSessionId=call_session_1',
    );
    expect(infoText).toContain('agentId=agent_voice');
    expect(infoText).toContain('requestId=req-log-1');
  });

  test('Listen-Only mode saves ambient transcripts without starting an agent stream', async () => {
    const { initializeClient } = require('~/server/services/Endpoints/agents');
    const addTitle = require('~/server/services/Endpoints/agents/title');
    const {
      materializeCallSessionConversationId,
    } = require('~/server/services/viventium/CallSessionService');
    const {
      getCompletedCortexInsightsForMessage,
    } = require('~/server/services/viventium/VoiceCortexInsightsService');
    mockAssertVoiceGatewayAuth = jest.fn().mockResolvedValue({
      callSessionId: 'call_session_listen_only',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'new',
      listenOnlyModeEnabled: true,
    });
    mockGetConvo = jest.fn().mockResolvedValue(null);
    mockGetMessages = jest.fn().mockResolvedValue([]);
    let callSessionConversationMaterialized = false;
    materializeCallSessionConversationId.mockImplementationOnce(
      (_callSessionId, conversationId) =>
        new Promise((resolve) => {
          setTimeout(() => {
            callSessionConversationMaterialized = true;
            resolve({ conversationId });
          }, 10);
        }),
    );

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'req-listen-1',
      },
      body: { text: 'ambient room transcript only', speakerLabel: 'untrusted-freeform-label' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.listenOnly).toBe(true);
    expect(res.body.status).toBe('listen_only');
    expect(res.body.streamId).toBeUndefined();
    expect(mockAgentControllerCallCount).toBe(0);
    expect(initializeClient).not.toHaveBeenCalled();
    expect(addTitle).not.toHaveBeenCalled();
    expect(getCompletedCortexInsightsForMessage).not.toHaveBeenCalled();
    expect(mockClaimGlassHiveDeliveries).not.toHaveBeenCalled();
    expect(mockMessageFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'user_1' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          sender: 'Listen-Only',
          text: 'ambient room transcript only',
          _meiliIndex: false,
          isCreatedByUser: false,
          tokenCount: 0,
          metadata: expect.objectContaining({
            viventium: expect.objectContaining({
              type: 'listen_only_transcript',
              mode: 'listen_only',
              ambientKind: 'ambient_room_transcript',
              speakerLabel: 'room',
              requestId: 'req-listen-1',
            }),
          }),
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
    expect(mockMessageFindOne).toHaveBeenCalledTimes(1);
    expect(mockMessageFindOne.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        user: 'user_1',
        conversationId: res.body.conversationId,
      }),
    );
    expect(res.body.conversationId).not.toBe('new');
    expect(callSessionConversationMaterialized).toBe(true);
    expect(materializeCallSessionConversationId).toHaveBeenCalledWith(
      'call_session_listen_only',
      expect.any(String),
    );
    expect(mockConversationFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'user_1' }),
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          title: 'Listen-Only Session',
          agent_id: 'agent_voice',
        }),
        $addToSet: { messages: 'listen_only_msg_oid' },
      }),
      expect.objectContaining({ upsert: true }),
    );
  });

  test('Listen-Only mode claims a fresh conversation when the stored session id was rejected', async () => {
    const {
      claimOrReplaceCallSessionConversationId,
      materializeCallSessionConversationId,
    } = require('~/server/services/viventium/CallSessionService');
    mockAssertVoiceGatewayAuth = jest.fn().mockResolvedValue({
      callSessionId: 'call_session_listen_only',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'conv-google',
      listenOnlyModeEnabled: true,
    });
    mockGetConvo = jest.fn().mockResolvedValue({
      conversationId: 'conv-google',
      endpoint: 'google',
      agent_id: 'google__gemini___Gemini',
    });
    mockGetMessages = jest.fn().mockResolvedValue([]);

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'req-listen-stale-1',
      },
      body: { text: 'ambient transcript after stale session id' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.listenOnly).toBe(true);
    expect(res.body.conversationId).not.toBe('conv-google');
    expect(claimOrReplaceCallSessionConversationId).toHaveBeenCalledWith(
      'call_session_listen_only',
      expect.any(String),
      { expectedConversationId: 'conv-google' },
    );
    expect(materializeCallSessionConversationId).not.toHaveBeenCalled();
    expect(mockMessageFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'user_1' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          conversationId: res.body.conversationId,
          text: 'ambient transcript after stale session id',
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
    expect(mockAgentControllerCallCount).toBe(0);
  });

  test('Listen-Only mode fails closed when a fresh conversation cannot be claimed', async () => {
    const {
      materializeCallSessionConversationId,
    } = require('~/server/services/viventium/CallSessionService');
    materializeCallSessionConversationId.mockResolvedValueOnce(null);
    mockAssertVoiceGatewayAuth = jest.fn().mockResolvedValue({
      callSessionId: 'call_session_listen_only',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'new',
      listenOnlyModeEnabled: true,
    });
    mockGetConvo = jest.fn().mockResolvedValue(null);
    mockGetMessages = jest.fn().mockResolvedValue([]);

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'req-listen-unclaimed-1',
      },
      body: { text: 'ambient transcript without a live call session claim' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(
      expect.objectContaining({
        listenOnly: true,
        status: 'listen_only_error',
      }),
    );
    expect(mockMessageFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockConversationFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockAgentControllerCallCount).toBe(0);
  });

  test('Listen-Only mode coalesces rapid parentless transcript duplicates into one saved row', async () => {
    jest.useFakeTimers();
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_WINDOW_MS = '10';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_WAIT_MS = '200';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_POLL_MS = '5';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_RETURN_WINDOW_MS = '200';
    mockAssertVoiceGatewayAuth = jest.fn().mockResolvedValue({
      callSessionId: 'call_session_listen_only',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'new',
      listenOnlyModeEnabled: true,
    });

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const firstReq = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'req-listen-root-1',
      },
      body: { text: 'first listen only phrase' },
    });
    const secondReq = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'req-listen-root-2',
      },
      body: { text: 'duplicate listen only phrase' },
    });
    const firstRes = createMockRes();
    const secondRes = createMockRes();

    const firstPromise = dispatch(app, firstReq, firstRes);
    await advanceVoiceRouteTimers(2);
    const secondPromise = dispatch(app, secondReq, secondRes);
    await advanceVoiceRouteTimers(100);
    await Promise.all([firstPromise, secondPromise]);

    expect(mockAgentControllerCallCount).toBe(0);
    expect(mockMessageFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockMessageFindOneAndUpdate.mock.calls[0][1].$set.text).toBe(
      'first listen only phrase duplicate listen only phrase',
    );
    expect(secondRes.body).toMatchObject({
      status: 'listen_only',
      listenOnly: true,
      coalesced: true,
    });
  });

  test('Listen-Only mode saves a new transcript after the coalesce return window expires', async () => {
    jest.useFakeTimers();
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_WINDOW_MS = '0';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_WAIT_MS = '200';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_POLL_MS = '5';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_RETURN_WINDOW_MS = '100';
    mockAssertVoiceGatewayAuth = jest.fn().mockResolvedValue({
      callSessionId: 'call_session_listen_only',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'conv-listen-only-coalesce',
      listenOnlyModeEnabled: true,
    });

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const firstReq = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'req-listen-window-1',
      },
      body: { text: 'first saved listen only turn' },
    });
    const secondReq = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'req-listen-window-2',
      },
      body: { text: 'second saved listen only turn' },
    });
    const firstRes = createMockRes();
    const secondRes = createMockRes();

    const firstPromise = dispatch(app, firstReq, firstRes);
    await advanceVoiceRouteTimers(20);
    await firstPromise;
    await advanceVoiceRouteTimers(150);
    const secondPromise = dispatch(app, secondReq, secondRes);
    await advanceVoiceRouteTimers(250);
    await secondPromise;

    expect(mockMessageFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(mockMessageFindOneAndUpdate.mock.calls[0][1].$set.text).toBe(
      'first saved listen only turn',
    );
    expect(mockMessageFindOneAndUpdate.mock.calls[1][1].$set.text).toBe(
      'second saved listen only turn',
    );
    expect(secondRes.body.coalesced).toBeUndefined();
  });

  test('Listen-Only mode saves a new parentless transcript inside the return window when text differs', async () => {
    jest.useFakeTimers();
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_WINDOW_MS = '0';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_WAIT_MS = '200';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_POLL_MS = '5';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_RETURN_WINDOW_MS = '1000';
    mockAssertVoiceGatewayAuth = jest.fn().mockResolvedValue({
      callSessionId: 'call_session_listen_only',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'conv-listen-only-coalesce',
      listenOnlyModeEnabled: true,
    });

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const firstReq = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'req-listen-fast-new-1',
      },
      body: { text: 'first ambient turn' },
    });
    const secondReq = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'req-listen-fast-new-2',
      },
      body: { text: 'second ambient turn' },
    });
    const thirdReq = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'req-listen-fast-new-3',
      },
      body: { text: 'second ambient turn' },
    });
    const firstRes = createMockRes();
    const secondRes = createMockRes();
    const thirdRes = createMockRes();

    const firstPromise = dispatch(app, firstReq, firstRes);
    await advanceVoiceRouteTimers(20);
    await firstPromise;
    const secondPromise = dispatch(app, secondReq, secondRes);
    await advanceVoiceRouteTimers(250);
    await secondPromise;
    await Promise.resolve();
    const thirdPromise = dispatch(app, thirdReq, thirdRes);
    await advanceVoiceRouteTimers(250);
    await thirdPromise;

    expect(mockMessageFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(mockMessageFindOneAndUpdate.mock.calls[0][1].$set.text).toBe('first ambient turn');
    expect(mockMessageFindOneAndUpdate.mock.calls[1][1].$set.text).toBe('second ambient turn');
    expect(secondRes.body.coalesced).toBeUndefined();
    expect(thirdRes.body).toMatchObject({
      status: 'listen_only',
      listenOnly: true,
      coalesced: true,
    });
  });

  test('Listen-Only mode chains a new transcript under the latest Listen-Only row', async () => {
    mockAssertVoiceGatewayAuth = jest.fn().mockResolvedValue({
      callSessionId: 'call_session_listen_only',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'conv-voice-1',
      listenOnlyModeEnabled: true,
    });
    mockMessageFindOne = createMessageFindOneMock({
      messageId: 'listen-only-tail',
      createdAt: '2026-03-26T21:02:00.000Z',
      metadata: {
        viventium: {
          type: 'listen_only_transcript',
          mode: 'listen_only',
        },
      },
    });

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'req-listen-chain-1',
      },
      body: { text: 'ambient phrase after prior phrase' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.listenOnly).toBe(true);
    expect(res.body.parentMessageId).toBe('listen-only-tail');
    expect(mockMessageFindOne).toHaveBeenCalledWith({
      user: 'user_1',
      conversationId: 'conv-voice-1',
    });
    expect(mockMessageFindOne.chain.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(mockMessageFindOne.chain.select).toHaveBeenCalledWith({
      messageId: 1,
      parentMessageId: 1,
      metadata: 1,
      createdAt: 1,
      _id: 1,
    });
    expect(mockMessageFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'user_1' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          parentMessageId: 'listen-only-tail',
          text: 'ambient phrase after prior phrase',
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
    expect(mockAgentControllerCallCount).toBe(0);
  });

  test('Listen-Only mode repairs old root fanout when an existing conversation has only transcripts', async () => {
    const { Constants } = require('librechat-data-provider');
    mockAssertVoiceGatewayAuth = jest.fn().mockResolvedValue({
      callSessionId: 'call_session_listen_only',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'conv-listen-only-roots',
      listenOnlyModeEnabled: true,
    });
    mockGetMessages = jest.fn().mockResolvedValue([
      {
        messageId: 'listen-only-1',
        parentMessageId: Constants.NO_PARENT,
        createdAt: '2026-03-26T21:00:00.000Z',
        metadata: {
          viventium: {
            type: 'listen_only_transcript',
            mode: 'listen_only',
          },
        },
      },
      {
        messageId: 'listen-only-2',
        parentMessageId: null,
        createdAt: '2026-03-26T21:01:00.000Z',
        metadata: {
          viventium: {
            type: 'listen_only_transcript',
            mode: 'listen_only',
          },
        },
      },
      {
        messageId: 'listen-only-3',
        parentMessageId: null,
        createdAt: '2026-03-26T21:02:00.000Z',
        metadata: {
          viventium: {
            type: 'listen_only_transcript',
            mode: 'listen_only',
          },
        },
      },
    ]);
    mockMessageFindOne = createMessageFindOneMock({
      messageId: 'listen-only-3',
      createdAt: '2026-03-26T21:02:00.000Z',
      metadata: {
        viventium: {
          type: 'listen_only_transcript',
          mode: 'listen_only',
        },
      },
    });
    mockMessageFind = createMessageFindMock([
      {
        messageId: 'listen-only-1',
        parentMessageId: Constants.NO_PARENT,
        createdAt: '2026-03-26T21:00:00.000Z',
        metadata: {
          viventium: {
            type: 'listen_only_transcript',
            mode: 'listen_only',
          },
        },
      },
      {
        messageId: 'listen-only-2',
        parentMessageId: null,
        createdAt: '2026-03-26T21:01:00.000Z',
        metadata: {
          viventium: {
            type: 'listen_only_transcript',
            mode: 'listen_only',
          },
        },
      },
      {
        messageId: 'listen-only-3',
        parentMessageId: null,
        createdAt: '2026-03-26T21:02:00.000Z',
        metadata: {
          viventium: {
            type: 'listen_only_transcript',
            mode: 'listen_only',
          },
        },
      },
    ]);

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'req-listen-repair-1',
      },
      body: { text: 'ambient phrase after old branch fanout' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.listenOnly).toBe(true);
    expect(res.body.parentMessageId).toBe('listen-only-3');
    expect(mockMessageFind.chain.sort).toHaveBeenCalledWith({ createdAt: 1, _id: 1 });
    expect(mockMessageFind.chain.select).toHaveBeenCalledWith({
      messageId: 1,
      parentMessageId: 1,
      metadata: 1,
      createdAt: 1,
      _id: 1,
    });
    expect(mockMessageBulkWrite).toHaveBeenCalledWith(
      [
        {
          updateOne: {
            filter: {
              user: 'user_1',
              conversationId: 'conv-listen-only-roots',
              messageId: 'listen-only-2',
            },
            update: { $set: { parentMessageId: 'listen-only-1' } },
          },
        },
        {
          updateOne: {
            filter: {
              user: 'user_1',
              conversationId: 'conv-listen-only-roots',
              messageId: 'listen-only-3',
            },
            update: { $set: { parentMessageId: 'listen-only-2' } },
          },
        },
      ],
      { ordered: false },
    );
    expect(mockMessageFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'user_1' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          parentMessageId: 'listen-only-3',
          text: 'ambient phrase after old branch fanout',
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
  });

  test('Listen-Only mode repairs only the trailing transcript fanout in a mixed conversation', async () => {
    mockAssertVoiceGatewayAuth = jest.fn().mockResolvedValue({
      callSessionId: 'call_session_listen_only',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'conv-mixed-listen-only',
      listenOnlyModeEnabled: true,
    });
    mockGetMessages = jest.fn().mockResolvedValue([
      {
        messageId: 'user-1',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        createdAt: '2026-03-26T21:00:00.000Z',
      },
      {
        messageId: 'assistant-1',
        parentMessageId: 'user-1',
        createdAt: '2026-03-26T21:01:00.000Z',
      },
      {
        messageId: 'listen-only-1',
        parentMessageId: 'assistant-1',
        createdAt: '2026-03-26T21:02:00.000Z',
        metadata: {
          viventium: {
            type: 'listen_only_transcript',
            mode: 'listen_only',
          },
        },
      },
      {
        messageId: 'listen-only-2',
        parentMessageId: 'assistant-1',
        createdAt: '2026-03-26T21:03:00.000Z',
        metadata: {
          viventium: {
            type: 'listen_only_transcript',
            mode: 'listen_only',
          },
        },
      },
      {
        messageId: 'listen-only-3',
        parentMessageId: 'assistant-1',
        createdAt: '2026-03-26T21:04:00.000Z',
        metadata: {
          viventium: {
            type: 'listen_only_transcript',
            mode: 'listen_only',
          },
        },
      },
    ]);
    mockMessageFindOne = createMessageFindOneMock({
      messageId: 'listen-only-3',
      parentMessageId: 'assistant-1',
      createdAt: '2026-03-26T21:04:00.000Z',
      metadata: {
        viventium: {
          type: 'listen_only_transcript',
          mode: 'listen_only',
        },
      },
    });
    mockMessageFind = createMessageFindMock([
      {
        messageId: 'user-1',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        createdAt: '2026-03-26T21:00:00.000Z',
      },
      {
        messageId: 'assistant-1',
        parentMessageId: 'user-1',
        createdAt: '2026-03-26T21:01:00.000Z',
      },
      {
        messageId: 'listen-only-1',
        parentMessageId: 'assistant-1',
        createdAt: '2026-03-26T21:02:00.000Z',
        metadata: {
          viventium: {
            type: 'listen_only_transcript',
            mode: 'listen_only',
          },
        },
      },
      {
        messageId: 'listen-only-2',
        parentMessageId: 'assistant-1',
        createdAt: '2026-03-26T21:03:00.000Z',
        metadata: {
          viventium: {
            type: 'listen_only_transcript',
            mode: 'listen_only',
          },
        },
      },
      {
        messageId: 'listen-only-3',
        parentMessageId: 'assistant-1',
        createdAt: '2026-03-26T21:04:00.000Z',
        metadata: {
          viventium: {
            type: 'listen_only_transcript',
            mode: 'listen_only',
          },
        },
      },
    ]);

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'req-listen-repair-2',
      },
      body: { text: 'ambient phrase after mixed fanout' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.listenOnly).toBe(true);
    expect(res.body.parentMessageId).toBe('listen-only-3');
    expect(mockMessageBulkWrite).toHaveBeenCalledWith(
      [
        {
          updateOne: {
            filter: {
              user: 'user_1',
              conversationId: 'conv-mixed-listen-only',
              messageId: 'listen-only-2',
            },
            update: { $set: { parentMessageId: 'listen-only-1' } },
          },
        },
        {
          updateOne: {
            filter: {
              user: 'user_1',
              conversationId: 'conv-mixed-listen-only',
              messageId: 'listen-only-3',
            },
            update: { $set: { parentMessageId: 'listen-only-2' } },
          },
        },
      ],
      { ordered: false },
    );
    expect(mockMessageFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'user_1' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          parentMessageId: 'listen-only-3',
          text: 'ambient phrase after mixed fanout',
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
  });

  test('Listen-Only mode falls back to the live parent when the latest row is not Listen-Only', async () => {
    mockAssertVoiceGatewayAuth = jest.fn().mockResolvedValue({
      callSessionId: 'call_session_listen_only',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'conv-voice-1',
      listenOnlyModeEnabled: true,
    });
    mockMessageFindOne = createMessageFindOneMock({
      messageId: 'voice-assistant-leaf',
      createdAt: '2026-03-26T21:00:00.100Z',
      metadata: {},
    });

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'req-listen-chain-2',
      },
      body: { text: 'first ambient phrase after live voice' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.listenOnly).toBe(true);
    expect(res.body.parentMessageId).toBe('voice-assistant-leaf');
    expect(mockMessageFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'user_1' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          parentMessageId: 'voice-assistant-leaf',
          text: 'first ambient phrase after live voice',
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
    expect(mockAgentControllerCallCount).toBe(0);
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
    expect(res.body.latest.workerId).toBeUndefined();
    expect(res.body.latest.runId).toBeUndefined();
    expect(res.body.latest.callbackId).toBeUndefined();
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

  test('POST glasshive delivery claim is scoped to voice auth session', async () => {
    mockClaimGlassHiveDeliveries.mockResolvedValueOnce([
      {
        deliveryId: 'ghcd_voice',
        callbackId: 'cb_voice',
        text: 'Worker finished.',
        claimId: 'claim_voice',
      },
    ]);
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/glasshive/deliveries/claim',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: { callbackId: 'cb_voice' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.deliveries).toHaveLength(1);
    expect(mockClaimGlassHiveDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'voice',
        callbackId: 'cb_voice',
        userId: 'user_1',
        voiceCallSessionId: 'call_session_1',
      }),
    );
  });

  test('POST glasshive delivery status reports lost voice claim as conflict', async () => {
    mockMarkGlassHiveDeliverySent.mockResolvedValueOnce(null);
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/glasshive/deliveries/ghcd_voice/status',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: { claimId: 'claim-stale', status: 'sent' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('delivery_not_claimed');
  });
});
